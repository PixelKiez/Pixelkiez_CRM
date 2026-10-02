/**
 * Versionierte SQLite-Migrationen (PXK-113).
 *
 * Ablauf eines Laufs:
 *   1. Dateien laden und statisch prüfen (Regeln 1–5)
 *   2. Datenbank einordnen: EMPTY / LEGACY_EXACT(Sx) / MIGRATED / UNKNOWN
 *   3. Ledger und Historie prüfen (Regeln 6–12)
 *   4. ausstehende Migrationen im Speicher probelaufen lassen
 *   5. vor dem ersten Schreibzugriff eine geprüfte Sicherung anlegen
 *   6. je Migration genau eine BEGIN-IMMEDIATE-Transaktion inkl. Ledger-Zeile;
 *      unter der Sperre wird erneut eingeordnet, jede Anweisung einzeln
 *      ausgeführt und danach geprüft, dass die Transaktion noch offen ist
 *
 * Alles schlägt geschlossen fehl: unbekannte Stände, veränderte Historie oder
 * eine Datenbank, die neuer ist als der Code, werden nie still repariert.
 */
import Database from 'better-sqlite3';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MigrationError } from './errors.mjs';
import { backupVerified } from './backup.mjs';
import { classifyEnvironment } from './environment.mjs';
import { dryRun, execStatements } from './execute.mjs';
import {
  LEDGER_TABLE,
  contentDigest,
  describeDifference,
  fingerprint,
  sameFingerprint,
  schemaObjects,
  sha256,
  stableStringify,
  tableColumns,
} from './fingerprint.mjs';
import { BASELINE_STATEMENT_SHA256, CURRENT_LEGACY_VARIANT, LEGACY_VARIANTS } from './legacy.mjs';
import { forbiddenReason, splitStatements } from './sql-split.mjs';

const FILE_PATTERN = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
const BASELINE_NAME = '0001_baseline';
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

/** Das Ledger gehört dem Runner und ist keine nummerierte Migration. */
export const LEDGER_DDL = "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, checksum TEXT NOT NULL, applied_at TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('applied','baselined')), legacy_variant TEXT)";

const collapse = (sql) => sql.replace(/\s+/g, ' ').trim();

export function defaultMigrationsDir(cwd = process.cwd()) {
  return join(cwd, 'db', 'migrations');
}

/** Ein BOM am Anfang entfernen, Zeilenenden vereinheitlichen — sonst nichts. */
export function normalizeMigrationText(raw) {
  return raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/**
 * @typedef {{ version: number, name: string, file: string, text: string, checksum: string, statements: import('./sql-split.mjs').SqlStatement[] }} Migration
 * @typedef {{ dir: string, migrations: Migration[] }} MigrationSet
 */

/**
 * Lädt und prüft die Migrationsdateien (Regeln 1–5).
 * @param {string} dir
 * @returns {MigrationSet}
 */
export function loadMigrations(dir = defaultMigrationsDir()) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (error) {
    throw new MigrationError('NO_MIGRATIONS', dir, `Migrationsordner nicht lesbar (${error.code ?? error.message})`);
  }
  /** @type {Migration[]} */
  const migrations = [];
  const seen = new Map();
  for (const entry of entries.sort()) {
    if (entry.startsWith('.') || entry === 'README.md') continue;
    const match = FILE_PATTERN.exec(entry);
    if (!match || !statSync(join(dir, entry)).isFile()) {
      throw new MigrationError('MALFORMED_FILENAME', entry, 'erwartet NNNN_name.sql (vier Ziffern, Kleinbuchstaben, Ziffern und _)');
    }
    const version = Number(match[1]);
    if (seen.has(version)) {
      throw new MigrationError('DUPLICATE_VERSION', entry, `Version ${match[1]} ist bereits durch ${seen.get(version)} belegt`);
    }
    seen.set(version, entry);
    const text = normalizeMigrationText(readFileSync(join(dir, entry), 'utf8'));
    migrations.push({ version, name: entry.slice(0, -4), file: entry, text, checksum: sha256(text), statements: splitStatements(text) });
  }
  migrations.sort((a, b) => a.version - b.version);
  if (!migrations.length) throw new MigrationError('NO_MIGRATIONS', dir, 'keine Migrationsdateien gefunden');

  const missing = [];
  for (let v = 1; v <= migrations[migrations.length - 1].version; v += 1) if (!seen.has(v)) missing.push(String(v).padStart(4, '0'));
  if (missing.length) {
    throw new MigrationError('VERSION_GAP', dir, `fehlende Versionen: ${missing.join(', ')} (Dateien müssen lückenlos ab 0001 nummeriert sein)`);
  }

  for (const migration of migrations) {
    migration.statements.forEach((statement, index) => {
      const reason = forbiddenReason(statement);
      if (reason) throw new MigrationError('FORBIDDEN_STATEMENT', migration.name, `Anweisung ${index + 1}: ${reason}`);
    });
  }

  const baseline = migrations[0];
  const hashes = baseline.statements.map(s => sha256(s.sql));
  if (baseline.name !== BASELINE_NAME || stableStringify(hashes) !== stableStringify(BASELINE_STATEMENT_SHA256)) {
    throw new MigrationError('LEGACY_DEFINITION_INVALID', baseline.name, 'Zerlegung von 0001_baseline.sql passt nicht zu lib/db/legacy.mjs (Baseline darf nie geändert werden)');
  }
  return { dir, migrations };
}

/**
 * Referenz-Fingerabdrücke, im Speicher mit demselben Treiber erzeugt.
 * @param {MigrationSet} set
 */
export function createReferences(set) {
  const variants = new Map();
  const replays = new Map();
  const baselineStatements = set.migrations[0].statements;
  return {
    /** Fingerabdruck eines Altstands (Teilmenge der Baseline-Anweisungen). */
    variant(name) {
      if (!variants.has(name)) {
        const mem = new Database(':memory:');
        try {
          for (const n of LEGACY_VARIANTS[name].statements) mem.exec(baselineStatements[n - 1].sql);
          variants.set(name, fingerprint(mem));
        } finally {
          mem.close();
        }
      }
      return variants.get(name);
    },
    /** Fingerabdruck nach den Dateien 1..head. */
    replay(head) {
      if (!replays.has(head)) {
        const mem = new Database(':memory:');
        try {
          for (const m of set.migrations.slice(0, head)) mem.exec(m.text);
          replays.set(head, fingerprint(mem));
        } finally {
          mem.close();
        }
      }
      return replays.get(head);
    },
  };
}

function hasLedger(db) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(LEDGER_TABLE));
}

/**
 * Ordnet die Datenbank ein.
 * @returns {{ kind: 'EMPTY' | 'MIGRATED' | 'LEGACY_EXACT' | 'UNKNOWN', variant?: string, reason?: string, nearest?: string, differences?: string[] }}
 */
export function classify(db, set, refs = createReferences(set)) {
  if (hasLedger(db)) return { kind: 'MIGRATED' };
  const userVersion = db.pragma('user_version', { simple: true });
  const objects = schemaObjects(db);
  if (!objects.length && userVersion === 0) return { kind: 'EMPTY' };
  if (userVersion !== 0) return { kind: 'UNKNOWN', reason: `user_version=${userVersion} ohne Ledger` };
  const actual = fingerprint(db);
  for (const name of Object.keys(LEGACY_VARIANTS).reverse()) {
    if (sameFingerprint(actual, refs.variant(name))) return { kind: 'LEGACY_EXACT', variant: name };
  }
  let nearest = null;
  for (const name of Object.keys(LEGACY_VARIANTS)) {
    const differences = describeDifference(actual, refs.variant(name));
    if (!nearest || differences.length < nearest.differences.length) nearest = { name, differences };
  }
  return {
    kind: 'UNKNOWN',
    reason: 'Schema entspricht keinem bekannten Stand',
    nearest: nearest?.name,
    differences: nearest?.differences ?? [],
  };
}

/**
 * Prüft Ledger und Historie (Regeln 6–11, mit `full` auch Regel 12).
 * @returns {{ head: number, rows: Array<{ version: number, name: string, checksum: string, kind: string, legacy_variant: string | null }> }}
 */
export function checkLedger(db, set, { full = false, refs } = {}) {
  const ledger = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(LEDGER_TABLE);
  if (!ledger) throw new MigrationError('DB_NOT_MIGRATED', LEDGER_TABLE, 'Datenbank ist nicht migrationsverwaltet (npm run db:migrate)');
  if (collapse(ledger.sql ?? '') !== collapse(LEDGER_DDL)) {
    throw new MigrationError('LEDGER_SCHEMA_INVALID', LEDGER_TABLE, 'Struktur des Ledgers wurde verändert');
  }
  // Ein Trigger am Ledger würde beim Eintragen der nächsten Migration feuern.
  const attached = db.prepare(
    "SELECT type, name FROM sqlite_master WHERE (tbl_name = @t OR name = @t) AND NOT (type = 'table' AND name = @t) AND substr(name, 1, 7) <> 'sqlite_' ORDER BY type, name",
  ).all({ t: LEDGER_TABLE });
  if (attached.length) {
    throw new MigrationError('LEDGER_SCHEMA_INVALID', LEDGER_TABLE, `fremde Objekte am Ledger: ${attached.map(o => `${o.type} ${o.name}`).join(', ')}`);
  }
  const rows = db.prepare(`SELECT version, name, checksum, applied_at, kind, legacy_variant FROM ${LEDGER_TABLE} ORDER BY version`).all();
  const userVersion = db.pragma('user_version', { simple: true });
  const head = rows.length ? rows[rows.length - 1].version : 0;
  if (!rows.length) throw new MigrationError('CORRUPT_LEDGER', LEDGER_TABLE, 'Ledger ist leer');
  if (userVersion !== head) {
    throw new MigrationError('CORRUPT_LEDGER', LEDGER_TABLE, `user_version=${userVersion}, aber Ledger-Stand ${head}`);
  }
  rows.forEach((row, index) => {
    if (row.version !== index + 1) {
      throw new MigrationError('LEDGER_GAP', LEDGER_TABLE, `Ledger-Versionen nicht lückenlos ab 1 (gefunden ${rows.map(r => r.version).join(', ')})`);
    }
    // 'baselined' nur für 0001 und mit bekanntem Altstand; 'applied' ohne Altstand.
    const kindValid = row.kind === 'baselined'
      ? row.version === 1 && Object.hasOwn(LEGACY_VARIANTS, String(row.legacy_variant))
      : row.kind === 'applied' && row.legacy_variant === null;
    const appliedAtValid = typeof row.applied_at === 'string' && ISO_UTC.test(row.applied_at) && !Number.isNaN(Date.parse(row.applied_at));
    if (!kindValid || !appliedAtValid) {
      throw new MigrationError('CORRUPT_LEDGER', LEDGER_TABLE, `Ledger-Zeile ${row.version} ist widersprüchlich (kind, legacy_variant oder applied_at)`);
    }
  });
  const files = set.migrations;
  if (head > files.length) {
    const unknown = rows.slice(files.length).map(r => r.name).join(', ');
    throw new MigrationError(
      'LEDGER_AHEAD_OF_FILES',
      LEDGER_TABLE,
      `Datenbank steht bei ${head} (${unknown}), der Code kennt nur ${files.length}: entweder wurden angewandte Migrationsdateien gelöscht, oder dieser Code ist älter als die Datenbank`,
    );
  }
  for (const row of rows) {
    const file = files[row.version - 1];
    if (row.name !== file.name) {
      throw new MigrationError('RENAMED_OR_REORDERED', row.name, `Ledger-Version ${row.version} heißt ${row.name}, die Datei heißt ${file.name}`);
    }
    if (row.checksum !== file.checksum) {
      throw new MigrationError('CHECKSUM_MISMATCH', row.name, `Datei wurde nach dem Anwenden verändert (Ledger ${row.checksum.slice(0, 12)}…, Datei ${file.checksum.slice(0, 12)}…)`);
    }
  }
  if (full) {
    const expected = (refs ?? createReferences(set)).replay(head);
    const actual = fingerprint(db);
    if (!sameFingerprint(actual, expected)) {
      const layer = actual.hashes.structural !== expected.hashes.structural ? 'Struktur' : 'SQL-Text';
      throw new MigrationError('SCHEMA_DRIFT', LEDGER_TABLE, `Schema weicht vom Stand nach Migration ${head} ab (${layer}): ${describeDifference(actual, expected).join('; ')}`);
    }
  }
  return { head, rows };
}

function digestEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function createLedger(db) {
  db.exec(LEDGER_DDL);
}

function insertLedgerRow(db, { version, name, checksum, appliedAt, kind, variant = null }) {
  db.prepare(`INSERT INTO ${LEDGER_TABLE} (version, name, checksum, applied_at, kind, legacy_variant) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(version, name, checksum, appliedAt, kind, variant);
  db.pragma(`user_version = ${Number(version)}`);
}

/**
 * Wendet alle ausstehenden Migrationen an.
 *
 * @param {import('better-sqlite3').Database} db per openDatabase(..., 'apply') geöffnet
 * @param {object} [options]
 * @param {string} [options.migrationsDir]
 * @param {string | null} [options.adoptLegacy] Altstand (S1–S4), dessen Übernahme ein Operator ausdrücklich freigibt
 * @param {boolean} [options.production] Produktionsregeln; ohne Angabe aus der Umgebung (lib/db/environment.mjs)
 * @param {boolean} [options.allowFresh] leere Datenbank in Produktion erlauben
 * @param {{ dir: string } | false} [options.backup] Sicherungsziel (weitere Felder gehen an backupVerified); false nur außerhalb der Produktion
 * @param {(line: string) => void} [options.log]
 * @param {() => string} [options.now]
 * @param {{ beforeLock?: (db: import('better-sqlite3').Database) => void, beforeExec?: (migration: Migration, db: import('better-sqlite3').Database) => void, beforeAdoptVerify?: (db: import('better-sqlite3').Database) => void }} [options.hooks]
 *   nur für Tests: simulieren parallele Schreiber und Fehler an Stellen, die sonst nicht erreichbar sind
 * @returns {Promise<{ actions: string[], head: number, backup: object | null, classification: object }>}
 */
export async function runMigrations(db, options = {}) {
  const {
    migrationsDir = defaultMigrationsDir(),
    adoptLegacy = null,
    production = classifyEnvironment(process.env).production,
    allowFresh = false,
    backup = undefined,
    log = () => {},
    now = () => new Date().toISOString(),
    hooks = {},
  } = options;

  if (db.inTransaction) throw new MigrationError('IN_TRANSACTION', db.name, 'Runner darf nicht in einer offenen Transaktion laufen');
  const set = loadMigrations(migrationsDir);
  const refs = createReferences(set);
  const files = set.migrations;

  // Einordnung ohne Sperre, um Flags, Probelauf und Sicherung zu entscheiden.
  // Unter der IMMEDIATE-Sperre wird jeder Schritt erneut eingeordnet.
  const pre = classify(db, set, refs);
  if (adoptLegacy && !(pre.kind === 'LEGACY_EXACT' && pre.variant === adoptLegacy)) {
    if (pre.kind === 'MIGRATED') {
      const { rows } = checkLedger(db, set);
      if (rows[0].kind === 'baselined' && rows[0].legacy_variant === adoptLegacy) {
        log(`PXK-DB Hinweis: PXK_DB_ADOPT_LEGACY=${adoptLegacy} wurde bereits verbraucht und kann entfernt werden`);
      } else {
        throw new MigrationError('ADOPT_FLAG_MISMATCH', String(adoptLegacy), 'Datenbank ist bereits migrationsverwaltet und wurde nicht aus diesem Stand übernommen');
      }
    } else {
      const found = pre.kind === 'LEGACY_EXACT' ? `Altstand ${pre.variant}` : pre.kind;
      throw new MigrationError('ADOPT_FLAG_MISMATCH', String(adoptLegacy), `Freigabe passt nicht zur Datenbank (gefunden: ${found})`);
    }
  }
  if (pre.kind === 'UNKNOWN') throw unknownSchema(pre);
  if (pre.kind === 'EMPTY' && production && !allowFresh) throw freshInProduction(db);
  if (pre.kind === 'LEGACY_EXACT' && pre.variant !== CURRENT_LEGACY_VARIANT && adoptLegacy !== pre.variant) {
    throw new MigrationError(
      'LEGACY_OUTDATED',
      pre.variant,
      `Altstand ${pre.variant} (zuletzt gestartet: ${LEGACY_VARIANTS[pre.variant].release}). Übernahme nur mit ausdrücklicher Freigabe: PXK_DB_ADOPT_LEGACY=${pre.variant} bzw. --adopt-legacy=${pre.variant}`,
    );
  }

  let appliedHead = 0;
  if (pre.kind === 'MIGRATED') appliedHead = checkLedger(db, set, { full: true, refs }).head;
  if (pre.kind === 'LEGACY_EXACT') appliedHead = 1;
  const pending = files.slice(appliedHead);
  const adoption = pre.kind === 'LEGACY_EXACT';
  if (!pending.length && !adoption) return { actions: [], head: appliedHead, backup: null, classification: pre };

  dryRun(set, appliedHead, pending);

  // Vor dem ersten Schreibzugriff: geprüfte Sicherung (nicht bei leerer Datenbank).
  let backupInfo = null;
  let digestAtBackup = null;
  if (pre.kind !== 'EMPTY') {
    if (production && !backup) {
      throw new MigrationError('BACKUP_DESTINATION_REQUIRED', db.name, 'in Produktion muss PXK_DB_BACKUP_DIR gesetzt sein');
    }
    if (backup) {
      digestAtBackup = contentDigest(db);
      const target = adoption ? BASELINE_NAME : pending[0].name;
      backupInfo = await backupVerified(db, { ...backup, label: target, digest: digestAtBackup });
      log(`PXK-DB Sicherung ${backupInfo.path} sha256=${backupInfo.sha256} bytes=${backupInfo.bytes}`);
    }
  }
  hooks.beforeLock?.(db);

  const actions = [];
  let first = true;
  const step = () => {
    // Unter der Sperre: Der Stand muss noch der geprüfte sein (beim ersten
    // Schritt die Voreinordnung, danach migrationsverwaltet). MIGRATED ist immer
    // zulässig — dann war ein anderer Runner schneller. Alles andere hat ein
    // fremder Schreiber verändert; Freigaben, Probelauf und Sicherung gelten
    // dafür nicht.
    const state = classify(db, set, refs);
    const expected = first ? pre : { kind: 'MIGRATED' };
    if (state.kind !== 'MIGRATED' && (state.kind !== expected.kind || state.variant !== expected.variant)) {
      const found = state.kind + (state.variant ? ` ${state.variant}` : '');
      throw new MigrationError('STATE_CHANGED', db.name, `Datenbank wurde seit der Prüfung verändert (erwartet ${expected.kind}, gefunden ${found}) — nichts geschrieben, Lauf wiederholen`);
    }
    if (first) {
      first = false;
      if (digestAtBackup && !digestEqual(contentDigest(db), digestAtBackup)) {
        throw new MigrationError('BACKUP_STALE', db.name, 'Daten haben sich seit der Sicherung geändert (paralleler Schreiber?) — nichts geschrieben');
      }
    }
    switch (state.kind) {
      case 'EMPTY':
        createLedger(db);
        return apply(files[0]);
      case 'LEGACY_EXACT':
        return adopt(state.variant);
      case 'MIGRATED': {
        const { head } = checkLedger(db, set);
        if (head === files.length) return 'noop';
        return apply(files[head]);
      }
      default:
        throw new MigrationError('UNKNOWN_SCHEMA', db.name, `unerwartete Einordnung ${state.kind}`);
    }
  };

  const apply = (migration) => {
    hooks.beforeExec?.(migration, db);
    try {
      execStatements(db, migration);
    } catch (error) {
      if (error.code === 'TX_CONTROL_IN_MIGRATION') {
        throw new MigrationError('PARTIAL_APPLY_RESTORE_REQUIRED', migration.name, `${error.detail} — Datenbank möglicherweise teilweise geändert, Sicherung zurückspielen`);
      }
      throw error;
    }
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length) {
      throw new MigrationError('FK_VIOLATION', migration.name, `${violations.length} Fremdschlüssel-Verletzungen`);
    }
    insertLedgerRow(db, { version: migration.version, name: migration.name, checksum: migration.checksum, appliedAt: now(), kind: 'applied' });
    return `applied ${migration.name}`;
  };

  // Freigabe für ältere Stände wurde bei der Voreinordnung geprüft; unter der
  // Sperre ist der Stand derselbe (siehe step).
  const adopt = (variant) => {
    const before = tableColumns(db);
    const digestBefore = contentDigest(db, before);
    const baseline = files[0];
    if (variant !== CURRENT_LEGACY_VARIANT) {
      const present = new Set(LEGACY_VARIANTS[variant].statements);
      baseline.statements.forEach((statement, index) => {
        if (!present.has(index + 1)) db.exec(statement.sql);
      });
    }
    hooks.beforeAdoptVerify?.(db);
    if (!sameFingerprint(fingerprint(db), refs.variant(CURRENT_LEGACY_VARIANT))) {
      throw new MigrationError('ADOPTION_VERIFY_FAILED', baseline.name, `Schema nach Übernahme von ${variant} entspricht nicht der Baseline`);
    }
    if (!digestEqual(contentDigest(db, before), digestBefore)) {
      throw new MigrationError('DATA_DIGEST_MISMATCH', baseline.name, 'Geschäftsdaten haben sich bei der Übernahme verändert — zurückgerollt');
    }
    createLedger(db);
    insertLedgerRow(db, { version: 1, name: baseline.name, checksum: baseline.checksum, appliedAt: now(), kind: 'baselined', variant });
    return `baselined ${baseline.name} (${variant})`;
  };

  for (;;) {
    const result = db.transaction(step).immediate();
    if (result === 'noop') break;
    actions.push(result);
    log(`PXK-DB ${result}`);
  }
  return { actions, head: files.length, backup: backupInfo, classification: pre };
}

function unknownSchema(state) {
  const near = state.nearest ? ` — nächster bekannter Stand ${state.nearest}: ${(state.differences ?? []).slice(0, 12).join('; ')}` : '';
  return new MigrationError('UNKNOWN_SCHEMA', 'database', `${state.reason ?? 'unbekanntes Schema'}${near}`);
}

function freshInProduction(db) {
  return new MigrationError(
    'FRESH_DB_IN_PRODUCTION',
    db.name,
    'leere Datenbank in Produktion — SQLITE_PATH/Volume prüfen; eine neue Produktionsdatenbank nur mit PXK_DB_ALLOW_FRESH=1',
  );
}

/**
 * Prüfung für den Request-Pfad: Ledger vollständig und auf dem Stand der Dateien.
 * Kein DDL, keine Seeds.
 */
export function verifyHead(db, { migrationsDir = defaultMigrationsDir() } = {}) {
  const set = loadMigrations(migrationsDir);
  const { head } = checkLedger(db, set);
  if (head < set.migrations.length) {
    throw new MigrationError('MIGRATIONS_PENDING', set.migrations[head].name, `Datenbank steht bei ${head}, Code erwartet ${set.migrations.length} (npm run db:migrate)`);
  }
  return { head };
}

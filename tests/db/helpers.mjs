/**
 * Hilfen für die Datenbank-Tests (node:test). Jede Prüfung arbeitet auf einer
 * eigenen Datei im Temp-Verzeichnis; es fließen keine echten Daten ein.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sameFingerprint, stableStringify } from '../../lib/db/fingerprint.mjs';
import { createReferences, loadMigrations } from '../../lib/db/migrate.mjs';
import { openDatabase } from '../../lib/db/open.mjs';
import { LEGACY_VARIANTS } from '../../lib/db/legacy.mjs';
import { splitStatements } from '../../lib/db/sql-split.mjs';

// Der Runner leitet Produktionsregeln aus der Umgebung ab. Tests setzen sie
// ausdrücklich (production: true bzw. env im Kindprozess), damit eine
// Entwickler- oder CI-Shell mit NODE_ENV/RAILWAY_* das Ergebnis nicht ändert.
for (const name of Object.keys(process.env)) {
  if (name === 'NODE_ENV' || name.startsWith('RAILWAY_')) delete process.env[name];
}

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const MIGRATIONS_DIR = join(ROOT, 'db', 'migrations');
export const GOLDEN = JSON.parse(readFileSync(join(ROOT, 'tests/db/fixtures/schema-cd2c098.json'), 'utf8'));

/**
 * Der echte Migrationssatz (db/migrations). Kopf, Ledger und erwartete Aktionen
 * leiten die Tests hieraus ab, statt 0001 fest zu kodieren. Synthetische
 * künftige Migrationen tragen die Nummern HEAD + 1, HEAD + 2 (future()) und
 * kollidieren so nie mit einer echten Migration.
 */
const REAL_SET = loadMigrations(MIGRATIONS_DIR);
export const REAL_MIGRATIONS = REAL_SET.migrations.map(({ version, name, file }) => ({ version, name, file }));
export const HEAD = REAL_MIGRATIONS[REAL_MIGRATIONS.length - 1].version;
/** Name einer synthetischen künftigen Migration: future(1, 'x') = '<HEAD + 1, vierstellig>_x'. */
export const future = (offset, slug) => `${String(HEAD + offset).padStart(4, '0')}_${slug}`;
/** Aktionen eines vollständigen Laufs über den echten Satz; `first` ersetzt die erste (z. B. eine Übernahme). */
export const realActions = (first = `applied ${REAL_MIGRATIONS[0].name}`) => [first, ...REAL_MIGRATIONS.slice(1).map(m => `applied ${m.name}`)];
/** Ledger (Form wie ledgerRows) nach einem Satz; mit `variant` wurde die Baseline aus diesem Altstand übernommen. */
export const ledgerFor = (migrations, variant = null) => migrations.map((m, i) => ({
  version: m.version, name: m.name, kind: i === 0 && variant ? 'baselined' : 'applied', legacy_variant: i === 0 ? variant : null,
}));
export const realLedger = (variant = null) => ledgerFor(REAL_MIGRATIONS, variant);
/** Ledger als 'version name kind'. */
export const realVersions = () => realLedger().map(r => `${r.version} ${r.name} ${r.kind}`);
/** Kanonischer Fingerabdruck nach allen echten Migrationen (wie die Drift-Prüfung des Runners). */
export const HEAD_FP = createReferences(REAL_SET).replay(HEAD);
/** Tabellen, die erst Migrationen nach der Baseline anlegen. */
export const POST_BASELINE_TABLES = Object.keys(HEAD_FP.structural.tables).filter(name => !GOLDEN.structural.tables[name]).sort();
/** Der cd2c098-Anteil eines Fingerabdrucks: genau die Objekte, die GOLDEN kennt. */
export function goldenPart(fp) {
  const pick = (all, keys) => Object.fromEntries(keys.map(k => [k, all[k] ?? null]));
  const goldenTriggers = new Set(GOLDEN.structural.triggers.map(t => t[0]));
  return {
    tables: pick(fp.structural.tables, Object.keys(GOLDEN.structural.tables)),
    triggers: fp.structural.triggers.filter(t => goldenTriggers.has(t[0])),
    views: fp.structural.views.filter(v => GOLDEN.structural.views.includes(v)),
    text: pick(fp.text, Object.keys(GOLDEN.text)),
  };
}
export const GOLDEN_PART = { tables: GOLDEN.structural.tables, triggers: GOLDEN.structural.triggers, views: GOLDEN.structural.views, text: GOLDEN.text };
/** Der cd2c098-Anteil ist exakt GOLDEN (Vergleich unabhängig von der Schlüsselreihenfolge). */
export const goldenPartExact = (fp) => stableStringify(goldenPart(fp)) === stableStringify(GOLDEN_PART);
/** Für Muster aus abgeleiteten Texten. */
export const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Zulässige Fehlercodes eines Verlierers paralleler Runner (D2.1 = A, G0). Ein
 * Verlierer endet nur dann nicht mit 0, wenn der Gewinner nach dem Stand, den
 * der Verlierer gelesen bzw. gesichert hat, weitere Migrationen festschreibt.
 * Dann scheitert er fail-closed — vor jedem eigenen Schreibzugriff; ein
 * erneuter Lauf ist ein No-op:
 * - BACKUP_STALE (15): runMigrations vergleicht unter der Sperre den
 *   Inhalts-Digest mit dem Stand der Sicherung; er ändert sich mit jeder neuen
 *   oder entfernten Tabelle bzw. Spalte (die echten Migrationen sind reines DDL,
 *   ownership.test.mjs);
 * - BACKUP_FAILED (15): backupVerified prüft die Kopie gegen den lebenden
 *   Fingerabdruck und gegen den vorab erfassten Digest — zwei Fenster
 *   (Digest → Kopie, Kopie → Prüfung), auch bei reinem Index/Trigger;
 * - CORRUPT_LEDGER bzw. SCHEMA_DRIFT (11): checkLedger liest Ledger, user_version
 *   und Schema ohne Lesetransaktion nacheinander — schon ein dazwischen
 *   festgeschriebener Ledger-Eintrag genügt für CORRUPT_LEDGER;
 * - UNKNOWN_SCHEMA (12): ebenso classify (Ledger-Abfrage, dann user_version),
 *   nur ohne Ledger (frische Datei, Altstand).
 * Ohne Migrationen nach diesem Stand (Baseline allein: die Übernahme schreibt
 * nur Ledger und user_version, die weder Digest noch Fingerabdruck enthalten)
 * gilt die PXK-113-Zusicherung „alle 0“. Rest-Fenster auch dann: zwischen der
 * Ledger-Abfrage und user_version in classify → UNKNOWN_SCHEMA; deterministisch
 * in guards.test.mjs, in Läufen bisher nie beobachtet.
 * `from`: Stand, den Verlierer frühestens lesen (frische Datei und Altstand: 1 —
 * eine leere Datei wird nie gesichert; migriert: dessen Kopf); `ledger`: die
 * Verlierer finden schon ein Ledger vor.
 * @returns {string[]} zulässige Fehlercodes eines Verlierers (leer = alle enden mit 0)
 */
export function loserFailureCodes(dir = MIGRATIONS_DIR, { from = 1, ledger = false } = {}) {
  const set = loadMigrations(dir);
  if (set.migrations.length === from) return [];
  const refs = createReferences(set);
  const base = refs.replay(from);
  const head = refs.replay(set.migrations.length);
  // Tabellen und sichtbare Spalten: genau das, worüber contentDigest geht.
  const shape = (fp) => stableStringify(Object.keys(fp.structural.tables).sort().map(name => [name, fp.structural.tables[name].columns.filter(c => c[6] === 0).map(c => c[1])]));
  const schema = !sameFingerprint(base, head);
  return [
    ...(shape(base) !== shape(head) ? ['BACKUP_STALE'] : []),
    ...(schema ? ['BACKUP_FAILED'] : []),
    'CORRUPT_LEDGER',
    ...(schema ? ['SCHEMA_DRIFT'] : []),
    ...(ledger ? [] : ['UNKNOWN_SCHEMA']),
  ];
}

/** Rechte einer Datei oder eines Ordners (Sicherungen wie Geheimnisse: Ordner 0700, Datei 0600, lib/db/backup.mjs). */
export function assertMode(path, expected, label = path) {
  assert.equal((statSync(path).mode & 0o777).toString(8), expected.toString(8), `${label}: Rechte`);
}

const created = [];
process.on('exit', () => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/** Eigenes Temp-Verzeichnis; wird am Ende des Testprozesses entfernt. */
export function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'pxk113-test-'));
  created.push(dir);
  return dir;
}

/** Kopie des Migrationsordners, optional mit zusätzlichen oder geänderten Dateien. */
export function migrationsCopy(extra = {}) {
  const dir = tempDir();
  for (const file of readdirSync(MIGRATIONS_DIR)) copyFileSync(join(MIGRATIONS_DIR, file), join(dir, file));
  for (const [name, text] of Object.entries(extra)) writeFileSync(join(dir, name), text);
  return dir;
}

/** Nur die Baseline (Stand 0001 = cd2c098) — für Prüfungen, die genau diesen Stand meinen. */
export function baselineOnlyDir() {
  const dir = tempDir();
  copyFileSync(join(MIGRATIONS_DIR, REAL_MIGRATIONS[0].file), join(dir, REAL_MIGRATIONS[0].file));
  return dir;
}

/** Anweisungen des Altstands, so wie der alte Code sie ausgeführt hat (IF NOT EXISTS). */
const legacyStatements = splitStatements(readFileSync(join(ROOT, 'tests/db/fixtures/legacy-cd2c098.sql'), 'utf8')).map(s => s.sql);

/** Baut einen Altstand S1–S5 aus der unabhängigen Fixture-SQL. */
export function buildLegacy(path, variant = 'S5') {
  const db = openDatabase(path, 'apply');
  for (const n of LEGACY_VARIANTS[variant].statements) db.exec(legacyStatements[n - 1]);
  return db;
}

/**
 * Gültige Belegung für Tabellen, deren CHECK-Regeln generische Werte ablehnen —
 * abgeglichen mit den eingefrorenen Bytes von 0002_command_pipeline (sha256
 * 8f74b282…); greift nur, wenn die Tabelle existiert. Jede Spalte muss genannt
 * sein: eine neue oder fehlende Spalte lässt den Test scheitern, statt still
 * NULL zu schreiben. Nie eine explizite id (Trigger *_no_explicit_id). Der
 * Status wechselt completed → pending → failed (ab drei Zeilen ist jede Spalte
 * irgendwo belegt), der Schlüssel zwischen kanonischer UUID (klein) und ULID
 * (groß); Zeitstempel sind 24-stellige ISO-Zeiten in UTC.
 */
const at = (i) => new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString();
const hex = (text, length = 64) => createHash('sha256').update(text).digest('hex').slice(0, length);
const uuid = (text) => {
  const h = hex(text, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ulid = (text) => {
  const bytes = createHash('sha256').update(text).digest();
  return CROCKFORD[bytes[0] & 7] + Array.from(bytes.subarray(1, 26), b => CROCKFORD[b & 31]).join('');
};
const VALID_ROWS = {
  idempotency_keys: (i) => {
    const status = ['failed', 'completed', 'pending'][i % 3];
    const pending = status === 'pending';
    return {
      principal: `principal-${i}`, key: i % 2 ? uuid(`key-${i}`) : ulid(`key-${i}`), command: 'synthetic.seed',
      request_hash: hex(`request-${i}`), status, attempt: i,
      response_status: pending ? null : status === 'completed' ? 200 + (i % 100) : 400 + (i % 200),
      response_content_type: pending ? null : status === 'completed' ? 'application/json' : 'application/problem+json',
      response: pending ? null : Buffer.from(`{"i":${i}}`), correlation_id: uuid(`correlation-${i}`), resume_ref: `r1_${hex(`resume-${i}`, 32)}`,
      entity_ref: pending ? null : `synthetic:seed-${i}`, lease_until: pending ? at(i + 120) : null,
      expires_at: at(i + 86400), created_at: at(i), updated_at: at(i),
    };
  },
  audit_events: (i) => ({
    created_at: at(i), actor_type: ['machine', 'user', 'system'][i % 3], actor_id: `actor-${i}`, action: `synthetic.action_${i}`,
    entity_type: ['lead', 'synthetic', 'call_attempt'][i % 3], entity_id: `id-${i}`, correlation_id: uuid(`correlation-${i}`), idempotency_key_id: i,
    diff: JSON.stringify({ fields: ['status'], i }),
  }),
};

/** Füllt jede vorhandene Tabelle mit synthetischen Zeilen (alle Spalten, eindeutige Werte). */
export function insertSyntheticRows(db, rowsPerTable = 3) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 7) <> 'sqlite_' AND name <> 'schema_migrations' ORDER BY name").all().map(r => r.name);
  for (const table of tables) {
    const columns = db.prepare('SELECT name, type, pk FROM pragma_table_info(?) ORDER BY cid').all(table)
      .filter(c => !(c.pk === 1 && c.type.toUpperCase() === 'INTEGER'));
    const insert = db.prepare(`INSERT INTO ${table} (${columns.map(c => c.name).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
    const valid = VALID_ROWS[table];
    for (let i = 1; i <= rowsPerTable; i += 1) {
      if (valid) {
        const row = valid(i);
        const unknown = Object.keys(row).filter(k => !columns.some(c => c.name === k));
        const missing = columns.filter(c => !(c.name in row)).map(c => c.name);
        if (unknown.length || missing.length) throw new Error(`insertSyntheticRows: Belegung für ${table} veraltet (fehlt: ${missing.join(', ') || '-'}; unbekannt: ${unknown.join(', ') || '-'})`);
        insert.run(...columns.map(c => row[c.name]));
        continue;
      }
      try {
        insert.run(...columns.map(c => (c.type.toUpperCase() === 'INTEGER' ? i * 7 : `${table}-${c.name}-${i}`)));
      } catch (error) {
        // Laut statt still ausgelassen: eine neue Tabelle mit Regeln braucht eine gültige Belegung in VALID_ROWS.
        throw new Error(`insertSyntheticRows: generische Zeile für ${table} abgelehnt (${error.code ?? error.message}) — gültige Belegung in VALID_ROWS ergänzen`, { cause: error });
      }
    }
  }
}

export function ledgerRows(db) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  return exists ? db.prepare('SELECT version, name, kind, legacy_variant FROM schema_migrations ORDER BY version').all() : null;
}

/** Fängt einen MigrationError und gibt seinen Code zurück (oder wirft weiter). */
export async function errorCode(fn) {
  try {
    await fn();
  } catch (error) {
    if (error?.code && error.name === 'MigrationError') return error;
    throw error;
  }
  return null;
}

/**
 * Formal gültige Datei (vollständiger Kopf, ganze Seite) — der Kopf verspricht
 * aber zwei Seiten: Die Vorprüfung vor dem Öffnen (lib/db/open.mjs) lässt sie
 * durch, SQLite meldet erst beim Lesen SQLITE_CORRUPT. Mit `wal` im WAL-Format
 * (Bytes 18/19 = 2): SQLite legt dann -wal/-shm an, bevor es scheitert.
 */
export function corruptButStructured({ wal = false } = {}) {
  const page = Buffer.alloc(4096);
  Buffer.from('SQLite format 3\0', 'latin1').copy(page);
  page.writeUInt16BE(4096, 16);
  page[18] = page[19] = wal ? 2 : 1;
  page[21] = 64; page[22] = 32; page[23] = 32;
  page.writeUInt32BE(1, 24); // Änderungszähler
  page.writeUInt32BE(2, 28); // Seitenzahl laut Kopf (die Datei hat eine)
  page.writeUInt32BE(1, 92); // Kopf gilt für Änderungszähler 1
  return page;
}

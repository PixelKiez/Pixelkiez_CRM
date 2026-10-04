#!/usr/bin/env node
/**
 * AC3-Prüfstand (PXK-113, D6/D8): migriert eine isolierte Kopie einer
 * CRM-Datenbank mit genau dem Startschritt dieses Kandidaten und weist nach,
 * dass sich dabei keine Geschäftsdaten ändern — ohne Inhalte auszugeben.
 *
 *   node scripts/db-verify-copy.mjs --source=/abs/quelle.db --workdir=/abs/neuer-ordner
 *
 * Ablauf
 *  1. Quelle nur lesend öffnen und per SQLite-Online-Backup nach
 *     <workdir>/copy.db kopieren (WAL-sicher, nie die Hauptdatei allein). Die
 *     Quelle bleibt unverändert: Hauptdatei und -wal (sha256 vorher/nachher, nur
 *     im Speicher). -shm ist der WAL-Index im gemeinsamen Speicher, keine Daten;
 *     jeder Leser darf ihn nach einem harten Abbruch neu aufbauen.
 *  2. Vorher messen: integrity_check, Einordnung, Schema-Fingerabdruck, je
 *     Tabelle Zeilenzahl und Inhalts-Prüfsumme.
 *  3. Lauf 1: `node scripts/db-migrate.mjs` (erster Teil von npm start) im
 *     Produktionsmodus, Sicherungsziel <workdir>/backups.
 *  4. Nachher messen; Lauf 2 muss ein No-op sein (keine Sicherung, Datei unverändert).
 *  5. Geschäftsdaten (Zeilen und Prüfsummen je Tabelle) müssen gleich sein; die
 *     Migrations-Metadaten (schema_migrations, user_version) werden getrennt
 *     ausgewiesen; das Schema muss dem kanonischen Schema nach allen Migrationen
 *     gleichen (D8); eine Sicherung aus Lauf 1 muss den Stand vorher enthalten.
 *
 * Datenschutz: Prüfsummen sind HMAC-SHA256 mit einem Schlüssel, der nur im
 * Speicher dieses Prozesses existiert, über eine verlustfreie, nach ihrem
 * eigenen Wert sortierte Zeilenkodierung (Speicherklasse + Hex der Rohbytes;
 * REAL per quote(), exakt) — unabhängig von der Rückgabereihenfolge von SELECT.
 * Ausgegeben werden nur Tabellennamen, Zeilenzahlen, MATCH/MISMATCH,
 * Einordnungen, Migrationsnamen, Fehlercodes und Exit-Codes — nie Werte,
 * Prüfsummen, Pfade oder die Ausgabe des Migrationsschritts.
 *
 * PASS verlangt außerdem: einen identifizierten, sauberen Kandidaten (eigenes
 * Repository mit ROOT als Wurzel, HEAD bekannt, keine Änderungen und keine
 * unversionierten Dateien) und einen Lauf 1, der tatsächlich etwas migriert —
 * eine schon migrierte Kopie ist kein AC3-Beleg.
 *
 * <workdir> enthält danach Klartext-Kopien (copy.db, backups/): nur in einem
 * isolierten Arbeitsbereich verwenden (Ordner 0700, Kopie 0600) und nach der
 * Auswertung löschen.
 *
 * Exit: 0 PASS · 1 FAIL · 2 Aufruf verweigert
 */
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyEnvironment } from '../lib/db/environment.mjs';
import { LEDGER_TABLE, fingerprint, sameFingerprint } from '../lib/db/fingerprint.mjs';
import { checkLedger, classify, createReferences, loadMigrations } from '../lib/db/migrate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'scripts', 'db-migrate.mjs');
/** Diese Dateien würde der Migrationsschritt im Produktionsmodus mitlesen. */
const ENV_FILES = ['.env', '.env.local', '.env.production', '.env.production.local'];

export class Refusal extends Error {}

export function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const match = /^--(source|workdir)=(.+)$/.exec(arg);
    if (!match) throw new Refusal(`unbekanntes Argument (erwartet --source=ABS --workdir=ABS)`);
    args[match[1]] = match[2];
  }
  for (const key of ['source', 'workdir']) {
    if (!args[key] || !isAbsolute(args[key])) throw new Refusal(`--${key} muss ein absoluter Pfad sein`);
  }
  return args;
}

/** Nur in einer isolierten, nicht produktiven Umgebung und mit leerem Arbeitsordner. */
export function checkIsolation({ source, workdir }, env = process.env) {
  if (classifyEnvironment(env).production) throw new Refusal('Produktions- oder Railway-Umgebung erkannt — nur isoliert und lokal ausführen');
  const present = ENV_FILES.filter(file => existsSync(join(ROOT, file)));
  if (present.length) throw new Refusal(`.env-Dateien im Projekt (${present.join(', ')}) würden den Migrationsschritt beeinflussen`);
  if (!existsSync(source) || !statSync(source).isFile()) throw new Refusal('Quelle fehlt oder ist keine Datei');
  // SQLite verwirft beim Öffnen einer leeren Datei (auch schreibgeschützt) ein daneben liegendes -wal.
  if (statSync(source).size === 0) throw new Refusal('Quelle ist leer — nie öffnen, ein -wal daneben ginge verloren');
  if (existsSync(workdir) && !statSync(workdir).isDirectory()) throw new Refusal('Arbeitsordner ist kein Ordner');
  // Leer heißt auch: die Quelle liegt nicht darin.
  if (existsSync(workdir) && readdirSync(workdir).length) throw new Refusal('Arbeitsordner existiert und ist nicht leer');
}

const quoteId = (name) => `"${name.replace(/"/g, '""')}"`;
/** Tabellennamen nur ausgeben, wenn sie harmlos sind — sonst ihre Nummer (keine eingeschleusten Zeilen). */
const shownName = (name, index) => (/^[A-Za-z0-9_]+$/.test(name) ? name : `#${index + 1}`);

/** Verlustfreie, sortierbare Kodierung einer Zeile (Speicherklasse + Rohbytes). */
export function rowExpression(columns) {
  if (!columns.length) return "''";
  return columns
    .map(c => `typeof(${quoteId(c)}) || ':' || CASE typeof(${quoteId(c)}) WHEN 'real' THEN quote(${quoteId(c)}) ELSE hex(${quoteId(c)}) END`)
    .join(' || char(31) || ');
}

/** Zeilenzahl und HMAC je Tabelle (auch sqlite_sequence), nur lesend. */
export function tableContent(db, key) {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND (substr(name, 1, 7) <> 'sqlite_' OR name = 'sqlite_sequence') ORDER BY name",
  ).all().map(r => r.name);
  const content = {};
  for (const table of tables) {
    const columns = db.prepare('SELECT name FROM pragma_table_xinfo(?) WHERE hidden = 0 ORDER BY cid').all(table).map(c => c.name);
    const mac = createHmac('sha256', key).update(`${table}\x1d${columns.join('\x1f')}\x1d`);
    let rows = 0;
    for (const [row] of db.prepare(`SELECT ${rowExpression(columns)} AS r FROM ${quoteId(table)} ORDER BY r`).raw().iterate()) {
      mac.update(row).update('\n');
      rows += 1;
    }
    content[table] = { rows, mac: mac.digest('hex') };
  }
  return content;
}

/** Misst eine Datenbankdatei schreibgeschützt. */
export function measure(path, key, set, refs) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check', { simple: true });
    const state = classify(db, set, refs);
    let ledgerCheck = 'absent';
    let ledger = [];
    if (state.kind === 'MIGRATED') {
      try {
        ledger = checkLedger(db, set, { full: true, refs }).rows.map(r => `${r.version}:${r.name}:${r.kind}:${r.legacy_variant ?? '-'}`);
        ledgerCheck = 'ok';
      } catch (error) {
        ledgerCheck = error?.code ?? 'ERROR';
      }
    }
    return {
      integrity: integrity === 'ok' ? 'ok' : 'FAILED',
      cls: state.kind + (state.variant ? ` ${state.variant}` : ''),
      kind: state.kind,
      variant: state.variant ?? null,
      userVersion: db.pragma('user_version', { simple: true }),
      ledgerCheck,
      ledger,
      fp: fingerprint(db),
      content: tableContent(db, key),
    };
  } finally {
    db.close();
  }
}

/** Tabellen mit abweichender Zeilenzahl oder Prüfsumme (ohne ausgenommene). */
export function compareContent(before, after, exclude = [LEDGER_TABLE]) {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(n => !exclude.includes(n)).sort();
  return names.map(name => ({
    name,
    rowsBefore: before[name]?.rows ?? null,
    rowsAfter: after[name]?.rows ?? null,
    match: Boolean(before[name] && after[name] && before[name].rows === after[name].rows && before[name].mac === after[name].mac),
  }));
}

const fileHash = (path) => (existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null);
const sidecars = ['-wal', '-shm'];
/** Dateien mit Datenbankinhalt (ohne den WAL-Index -shm). */
const contentFiles = (path) => Object.fromEntries(['', '-wal'].map(s => [s, fileHash(path + s)]));
const backupFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter(f => /^pre-.*\.db$/.test(f)).sort() : []);

/**
 * Kopie per Online-Backup in eine vorab exklusiv angelegte Datei (0600). Vom
 * Lesen angelegte, leere Nebendateien der Quelle werden wieder entfernt — auch
 * wenn die Kopie scheitert. `source` ist bereits der aufgelöste echte Pfad.
 */
async function copyOnline(source, target) {
  const existed = Object.fromEntries(sidecars.map(s => [s, existsSync(source + s)]));
  closeSync(openSync(target, 'wx', 0o600));
  let src;
  try {
    src = new Database(source, { readonly: true, fileMustExist: true });
    await src.backup(target);
  } finally {
    src?.close();
    if (!existed['-wal'] && existsSync(`${source}-wal`) && statSync(`${source}-wal`).size === 0) {
      for (const s of sidecars) if (!existed[s]) rmSync(source + s, { force: true });
    }
  }
}

/** Der Migrationsschritt des Kandidaten — seine Ausgabe wird nur ausgewertet, nie weitergegeben. */
function runCandidate(copy, backups) {
  const result = spawnSync(process.execPath, [CLI], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', SQLITE_PATH: copy, PXK_DB_BACKUP_DIR: backups, NODE_ENV: 'production' },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const ok = /^PXK-DB ok head=(\d+) (.+?)(?: seeds=(\d+)\/(\d+))?$/m.exec(result.stdout ?? '');
  return {
    status: result.status,
    error: result.status === 0 ? '-' : (/^PXK-DB \[([A-Z_]+)\]/m.exec(result.stderr ?? '')?.[1] ?? (result.signal ? `SIGNAL_${result.signal}` : 'INTERNAL')),
    head: ok ? Number(ok[1]) : null,
    actions: ok ? ok[2] : '-',
    seeds: ok && ok[3] !== undefined ? `${ok[3]}/${ok[4]}` : '-',
  };
}

/**
 * Welcher Stand läuft hier? Nur ein eigenes Repository zählt: ROOT muss dessen
 * Wurzel sein (sonst nennte git den Stand eines umgebenden Repositorys), und
 * GIT_*-Variablen der Umgebung werden ignoriert.
 */
function candidateIdentity() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const git = (...args) => spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', timeout: 15000, env });
  const unknown = { head: 'unknown', clean: 'unknown' };
  const top = git('rev-parse', '--show-toplevel');
  if (top.status !== 0) return unknown;
  try {
    if (realpathSync(top.stdout.trim()) !== realpathSync(ROOT)) return unknown;
  } catch {
    return unknown;
  }
  const head = git('rev-parse', 'HEAD');
  const status = git('status', '--porcelain', '--untracked-files=normal');
  return {
    head: head.status === 0 ? head.stdout.trim() : 'unknown',
    clean: status.status === 0 ? (status.stdout.trim() === '' ? 'yes' : 'NO') : 'unknown',
  };
}

/**
 * @param {{ source: string, workdir: string }} args
 * @returns {Promise<{ pass: boolean, lines: string[] }>}
 */
export async function verifyCopy({ source: given, workdir }) {
  const source = realpathSync(given);
  const lines = [];
  const out = (text) => lines.push(`PXK-AC3 ${text}`);
  const failures = [];
  const expect = (ok, what) => { if (!ok) failures.push(what); return ok ? 'MATCH' : 'MISMATCH'; };
  const finish = () => {
    out(`failures=${failures.length ? failures.join(',') : 'none'}`);
    out('workdir_plaintext=yes (copy.db, backups) — nach der Auswertung löschen');
    out(`verdict=${failures.length ? 'FAIL' : 'PASS'}`);
    return { pass: failures.length === 0, lines };
  };

  const id = candidateIdentity();
  const mem = new Database(':memory:');
  const sqlite = mem.prepare('SELECT sqlite_version() AS v').get().v;
  mem.close();
  out(`candidate=${id.head} clean=${id.clean} node=${process.version} sqlite=${sqlite}`);
  expect(id.head !== 'unknown' && id.clean === 'yes', 'candidate_unverified');
  const set = loadMigrations(join(ROOT, 'db', 'migrations'));
  const refs = createReferences(set);
  const last = set.migrations[set.migrations.length - 1];
  out(`migrations=${set.migrations.length} last=${last.name}`);

  const sourceBefore = contentFiles(source);
  const key = randomBytes(32);
  const copy = join(workdir, 'copy.db');
  const backups = join(workdir, 'backups');
  mkdirSync(workdir, { recursive: true, mode: 0o700 });
  chmodSync(workdir, 0o700);
  try {
    await copyOnline(source, copy);
  } catch (error) {
    out(`source readable=no error=${error?.code ?? 'ERROR'}`);
    failures.push('source_unreadable');
    return finish();
  }
  const before = measure(copy, key, set, refs);
  out(`source readable=yes copy=online-backup copy_integrity=${before.integrity}`);
  expect(before.integrity === 'ok', 'copy_integrity');
  out(`before class=${before.cls} user_version=${before.userVersion} ledger=${before.ledgerCheck} tables=${Object.keys(before.content).length}`);

  const run1 = runCandidate(copy, backups);
  const created1 = backupFiles(backups);
  out(`run1 exit=${run1.status} error=${run1.error} head=${run1.head ?? '-'} seeds=${run1.seeds} backups_created=${created1.length} actions=${run1.actions}`);
  expect(run1.status === 0, 'run1_exit');
  expect(!(run1.status === 0 && run1.actions === 'noop'), 'nothing_migrated');
  const after = measure(copy, key, set, refs);
  out(`after class=${after.cls} user_version=${after.userVersion} ledger_check=${after.ledgerCheck} integrity=${after.integrity}`);
  expect(after.integrity === 'ok', 'after_integrity');
  expect(after.kind === 'MIGRATED' && after.ledgerCheck === 'ok' && after.userVersion === set.migrations.length, 'after_ledger_state');

  // Erwartete Metadaten: Übernahme eines Altstands als baselined, alles Weitere applied.
  const expected = set.migrations.map((m, index) => {
    if (index === 0 && before.kind === 'LEGACY_EXACT') return `${m.version}:${m.name}:baselined:${before.variant}`;
    if (before.kind === 'MIGRATED' && index < before.ledger.length) return before.ledger[index];
    return `${m.version}:${m.name}:applied:-`;
  });
  out(`ledger rows=${after.ledger.length} ${after.ledger.join(' ') || '-'} expected=${expect(after.ledger.join(' ') === expected.join(' '), 'ledger_rows')}`);

  const canonical = refs.replay(set.migrations.length);
  out(`schema after_vs_canonical=${expect(sameFingerprint(after.fp, canonical), 'schema_canonical')} before_vs_after=${sameFingerprint(before.fp, after.fp) ? 'MATCH' : 'CHANGED'}`);

  const tables = compareContent(before.content, after.content);
  tables.forEach((t, i) => out(`table=${shownName(t.name, i)} rows_before=${t.rowsBefore ?? '-'} rows_after=${t.rowsAfter ?? '-'} content=${t.match ? 'MATCH' : 'MISMATCH'}`));
  const changed = tables.filter(t => !t.match).length;
  out(`changed_tables=${changed}`);
  expect(changed === 0, 'business_data');

  // Jede Sicherung aus Lauf 1 muss exakt den Stand vor dem Lauf enthalten.
  // Geschrieben hat nur ein erfolgreicher Lauf mit Aktion oder Seeds; Änderungen
  // eines gescheiterten Laufs zeigt der Inhaltsvergleich oben.
  const wrote = run1.status === 0 && (run1.actions !== 'noop' || (run1.seeds !== '-' && run1.seeds !== '0/0'));
  if (created1.length) {
    const diffs = created1.flatMap(file => compareContent(before.content, measure(join(backups, file), key, set, refs).content, []).filter(t => !t.match));
    out(`backup_vs_before=${expect(diffs.length === 0, 'backup_content')}`);
  } else {
    out(`backup_vs_before=${wrote && before.kind !== 'EMPTY' ? 'MISSING' : 'none-required'}`);
    expect(!(wrote && before.kind !== 'EMPTY'), 'backup_missing');
  }

  const fileBefore2 = fileHash(copy);
  const run2 = runCandidate(copy, backups);
  const created2 = backupFiles(backups).length - created1.length;
  const after2 = measure(copy, key, set, refs);
  const noop = run2.status === 0 && run2.actions === 'noop' && run2.seeds === '0/0' && created2 === 0;
  out(`run2 exit=${run2.status} error=${run2.error} actions=${run2.actions} seeds=${run2.seeds} backups_created=${created2} noop=${expect(noop, 'run2_noop')}`);
  out(`run2 file_unchanged=${expect(fileHash(copy) === fileBefore2, 'run2_file')} content=${expect(compareContent(after.content, after2.content, []).every(t => t.match), 'run2_content')}`);

  out(`source_unchanged=${expect(JSON.stringify(contentFiles(source)) === JSON.stringify(sourceBefore), 'source_changed')}`);
  return finish();
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    checkIsolation(args);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    console.error(`PXK-AC3 refused=${error.message}`);
    return 2;
  }
  const { pass, lines } = await verifyCopy(args);
  for (const line of lines) console.log(line);
  return pass ? 0 : 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    code => process.exit(code),
    error => {
      // Nur der Fehlertyp, keine Meldung: sie könnte Werte enthalten.
      console.error(`PXK-AC3 error=${error?.code ?? error?.name ?? 'ERROR'}`);
      console.error('PXK-AC3 verdict=FAIL');
      process.exit(1);
    },
  );
}


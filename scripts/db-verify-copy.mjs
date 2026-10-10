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
 *     <workdir>/ac3-XXXXXX/copy.db kopieren (WAL-sicher, nie die Hauptdatei allein). Die
 *     Quelle bleibt unverändert: Hauptdatei und -wal (sha256 vorher/nachher, nur
 *     im Speicher). -shm ist der WAL-Index im gemeinsamen Speicher, keine Daten;
 *     jeder Leser darf ihn nach einem harten Abbruch neu aufbauen.
 *  2. Vorher messen: integrity_check, Einordnung, Schema-Fingerabdruck, je
 *     Tabelle Zeilenzahl und Inhalts-Prüfsumme.
 *  3. Lauf 1: `node scripts/db-migrate.mjs` (erster Teil von npm start) im
 *     Produktionsmodus, Sicherungsziel <workdir>/ac3-XXXXXX/backups.
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
 * Klartext gehört dem Prüfstand (M-4): copy.db, backups/ (mit .partial-*),
 * -wal/-shm entstehen in <workdir>/ac3-XXXXXX (0700, Kopie 0600) und werden am Ende
 * JEDES Laufs gelöscht — bei PASS, FAIL, interner Ausnahme, SIGINT/SIGTERM/
 * SIGHUP; ein laufender Migrationsschritt wird vorher beendet. Ein vom
 * Prüfstand angelegtes <workdir> verschwindet mit, ein vorhandenes leeres
 * bleibt leer zurück; die Quelle wird nie gelöscht. Das Urteil fällt erst nach
 * nachgewiesenem Löschen (cleanup=verified): lstat meldet ENOENT, und Ordner und
 * Elternordner sind dieselben wie beim Anlegen (Gerät/Inode) — ein unerreichbarer
 * oder umbenannter Ordner zählt nie als gelöscht (Exit 3). Abgefangen werden SIGHUP, SIGINT,
 * SIGQUIT und SIGTERM; SIGKILL (und seltene Signale wie SIGUSR2) gegen den
 * Prüfstand hinterlassen ac3-XXXXXX — <workdir> daher nie in synchronisierten Ordnern.
 *
 * Exit: 0 PASS · 1 FAIL · 2 Aufruf verweigert · 3 Löschen nicht nachgewiesen
 * (Klartext kann übrig sein) · 129/130/131/143 abgebrochen durch SIGHUP/SIGINT/
 * SIGQUIT/SIGTERM (FAIL, gelöscht) · 17 Node-Laufzeit nicht unterstützt (lib/db/runtime.mjs)
 */
// Muss der erste Import bleiben: bricht auf nicht unterstützter Node-Laufzeit ab, bevor better-sqlite3 lädt.
import '../lib/db/runtime-gate.mjs';
import Database from 'better-sqlite3';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyEnvironment } from '../lib/db/environment.mjs';
import { LEDGER_TABLE, fingerprint, sameFingerprint } from '../lib/db/fingerprint.mjs';
import { checkLedger, classify, createReferences, loadMigrations } from '../lib/db/migrate.mjs';
import { assertOpenable, openProblem } from '../lib/db/open.mjs';
import { createScratch, removeScratch } from './db-verify-copy-scratch.mjs';

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
    // ohne ..-Abschnitte: Prüfung, Anlegen und Löschen meinen sonst verschiedene Ordner
    args[key] = resolve(args[key]);
  }
  return args;
}

/** Nur in einer isolierten, nicht produktiven Umgebung und mit leerem Arbeitsordner. */
export function checkIsolation({ source, workdir }, env = process.env) {
  if (classifyEnvironment(env).production) throw new Refusal('Produktions- oder Railway-Umgebung erkannt — nur isoliert und lokal ausführen');
  const present = ENV_FILES.filter(file => existsSync(join(ROOT, file)));
  if (present.length) throw new Refusal(`.env-Dateien im Projekt (${present.join(', ')}) würden den Migrationsschritt beeinflussen`);
  if (!existsSync(source) || !statSync(source).isFile()) throw new Refusal('Quelle fehlt oder ist keine Datei');
  // SQLite verwirft beim Öffnen einer leeren oder abgeschnittenen Datei ein daneben
  // liegendes -wal oder legt ein -shm an — solche Quellen werden nie geöffnet (lib/db/open.mjs).
  const file = openProblem(source);
  if (file.main.state === 'empty') throw new Refusal('Quelle ist leer — nie öffnen, ein -wal daneben ginge verloren');
  if (file.verdict) throw new Refusal(`Quelle ist keine gültige SQLite-Datei (${file.main.reason ?? file.detail ?? file.verdict}) — nicht geöffnet, -wal/-shm unberührt; vor jedem Blick mit SQLite alle drei Dateien kopieren`);
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
  assertOpenable(source);
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

/** Abbruch eines Laufs durch ein Signal; Aufräumen und Urteil übernimmt verifyCopy. */
class Interrupted extends Error {}

/** Exit-Code nach Abbruch (128 + Signalnummer). */
const SIGNAL_EXIT = { SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGTERM: 143 };
/** So lange darf der Migrationsschritt nach SIGTERM weiterlaufen, dann SIGKILL. */
const CHILD_GRACE_MS = 2000;
const MAX_OUTPUT = 64 * 1024 * 1024;

/** Zustand eines Laufs: Ausgabe, Fehlschläge, Quelle (aufgelöst), Arbeitsbereich, Kindprozess, Abbruchsignal. */
export function newRun() {
  return { lines: [], failures: [], source: null, scratch: null, child: null, interrupted: null };
}

/** Bricht ab, sobald ein Signal eingegangen ist — vor jedem weiteren Schritt. */
function checkInterrupted(run) {
  if (run.interrupted) throw new Interrupted(run.interrupted);
}

/** Der Migrationsschritt des Kandidaten (asynchron, damit ein Signal ihn vor dem Löschen beendet); Ausgabe nie weitergegeben. */
async function runCandidate(run, copy, backups) {
  checkInterrupted(run);
  const child = spawn(process.execPath, [CLI], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', SQLITE_PATH: copy, PXK_DB_BACKUP_DIR: backups, NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { stdout: [], stderr: [], bytes: 0 };
  for (const name of ['stdout', 'stderr']) {
    child[name].on('data', (chunk) => {
      output.bytes += chunk.length;
      // wie maxBuffer bei spawnSync: zu viel Ausgabe beendet den Schritt (SIGTERM, notfalls SIGKILL)
      if (output.bytes > MAX_OUTPUT) stopChild(run);
      else output[name].push(chunk);
    });
  }
  const done = new Promise((settle) => {
    child.once('error', () => settle({ status: null, signal: null }));
    child.once('close', (status, signal) => settle({ status, signal }));
  });
  run.child = { process: child, done, stopping: false };
  const { status, signal } = await done;
  run.child = null;
  checkInterrupted(run);
  const stdout = Buffer.concat(output.stdout).toString('utf8');
  const stderr = Buffer.concat(output.stderr).toString('utf8');
  const ok = /^PXK-DB ok head=(\d+) (.+?)(?: seeds=(\d+)\/(\d+))?$/m.exec(stdout);
  return {
    status,
    error: status === 0 ? '-' : (/^PXK-DB \[([A-Z_]+)\]/m.exec(stderr)?.[1] ?? (signal ? `SIGNAL_${signal}` : 'INTERNAL')),
    head: ok ? Number(ok[1]) : null,
    actions: ok ? ok[2] : '-',
    seeds: ok && ok[3] !== undefined ? `${ok[3]}/${ok[4]}` : '-',
  };
}

/** Beendet einen noch laufenden Migrationsschritt (SIGTERM, nach CHILD_GRACE_MS SIGKILL) und wartet auf sein Ende. */
function stopChild(run) {
  const current = run.child;
  if (!current) return Promise.resolve();
  if (!current.stopping) {
    current.stopping = true;
    current.process.kill('SIGTERM');
    const timer = setTimeout(() => current.process.kill('SIGKILL'), CHILD_GRACE_MS);
    current.done.then(() => clearTimeout(timer));
  }
  return current.done;
}

/**
 * Löscht den Arbeitsbereich, sobald kein Migrationsschritt mehr läuft, und weist
 * nach, dass nichts übrig ist (scripts/db-verify-copy-scratch.mjs).
 * @returns {Promise<boolean>} true = nachweislich nichts übrig
 */
async function cleanup(run) {
  await stopChild(run);
  return removeScratch(run.scratch, run.source);
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
 * Ein ganzer Lauf: messen und vergleichen (compare), dann in jedem Fall
 * aufräumen (cleanup) — erst danach fällt das Urteil.
 *
 * @param {{ source: string, workdir: string }} args
 * @param {ReturnType<typeof newRun>} [run] Zustand, den main für Signale teilt
 * @returns {Promise<{ pass: boolean, exitCode: number, lines: string[], errorLines: string[] }>}
 *   `errorLines` (nur bei interner Ausnahme) gehören wie bisher nach stderr
 */
export async function verifyCopy(args, run = newRun()) {
  let error = null;
  try {
    await compare(args, run);
  } catch (caught) {
    if (!(caught instanceof Interrupted)) error = caught;
  }
  const cleaned = await cleanup(run);
  const out = (text) => `PXK-AC3 ${text}`;
  const tail = [out(`cleanup=${cleaned ? 'verified' : 'FAILED'}`)];
  if (error && !run.interrupted) {
    // Nur der Fehlertyp, keine Meldung: sie könnte Werte enthalten.
    tail.push(out('verdict=FAIL'));
    return { pass: false, exitCode: cleaned ? 1 : 3, lines: [], errorLines: [out(`error=${error?.code ?? error?.name ?? 'ERROR'}`), ...tail] };
  }
  if (run.interrupted) run.failures.push('interrupted');
  if (!cleaned) run.failures.push('cleanup');
  const pass = run.failures.length === 0;
  const lines = [...run.lines];
  if (run.interrupted) lines.push(out(`interrupted=${run.interrupted}`));
  lines.push(out(`failures=${pass ? 'none' : run.failures.join(',')}`), ...tail, out(`verdict=${pass ? 'PASS' : 'FAIL'}`));
  const exitCode = !cleaned ? 3 : run.interrupted ? SIGNAL_EXIT[run.interrupted] : pass ? 0 : 1;
  return { pass, exitCode, lines, errorLines: [] };
}

/** Messen und vergleichen; schreibt in run.lines und run.failures. */
async function compare({ source: given, workdir }, run) {
  const source = realpathSync(given);
  run.source = source;
  const out = (text) => run.lines.push(`PXK-AC3 ${text}`);
  const failures = run.failures;
  const expect = (ok, what) => { if (!ok) failures.push(what); return ok ? 'MATCH' : 'MISMATCH'; };

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
  const root = createScratch(run, workdir);
  const copy = join(root, 'copy.db');
  const backups = join(root, 'backups');
  try {
    await copyOnline(source, copy);
  } catch (error) {
    out(`source readable=no error=${error?.code ?? 'ERROR'}`);
    failures.push('source_unreadable');
    return;
  }
  checkInterrupted(run);
  const before = measure(copy, key, set, refs);
  out(`source readable=yes copy=online-backup copy_integrity=${before.integrity}`);
  expect(before.integrity === 'ok', 'copy_integrity');
  out(`before class=${before.cls} user_version=${before.userVersion} ledger=${before.ledgerCheck} tables=${Object.keys(before.content).length}`);

  const run1 = await runCandidate(run, copy, backups);
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
  const run2 = await runCandidate(run, copy, backups);
  const created2 = backupFiles(backups).length - created1.length;
  const after2 = measure(copy, key, set, refs);
  const noop = run2.status === 0 && run2.actions === 'noop' && run2.seeds === '0/0' && created2 === 0;
  out(`run2 exit=${run2.status} error=${run2.error} actions=${run2.actions} seeds=${run2.seeds} backups_created=${created2} noop=${expect(noop, 'run2_noop')}`);
  out(`run2 file_unchanged=${expect(fileHash(copy) === fileBefore2, 'run2_file')} content=${expect(compareContent(after.content, after2.content, []).every(t => t.match), 'run2_content')}`);

  out(`source_unchanged=${expect(JSON.stringify(contentFiles(source)) === JSON.stringify(sourceBefore), 'source_changed')}`);
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
  // Ab hier gehört ein Signal dem Prüfstand: Migrationsschritt beenden, löschen, dann Urteil.
  const run = newRun();
  const onSignal = (signal) => {
    if (run.interrupted) return;
    run.interrupted = signal;
    stopChild(run);
  };
  for (const signal of Object.keys(SIGNAL_EXIT)) process.on(signal, onSignal);
  const { exitCode, lines, errorLines } = await verifyCopy(args, run);
  for (const line of lines) console.log(line);
  for (const line of errorLines) console.error(line);
  return exitCode;
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


/**
 * AC3-Prüfstand (scripts/db-verify-copy.mjs) — nur synthetisch geprobt. Die
 * echte AC3-Prüfung gegen eine isolierte Kopie der Produktionssicherung läuft
 * in einer eigenen, frischen Verifier-Sitzung (D3), nicht hier.
 *
 * Geprüft: PASS auf einer produktionsähnlichen Kopie (S5, Seeds vollständig,
 * Daten nur im WAL), Datenschutz der Ausgabe (nur erlaubte Zeilen, keine Werte,
 * keine Prüfsummen), Erkennung von Datenänderungen durch den Kandidatenlauf,
 * jede Fehlerprüfung des Prüfstands, verlustfreie und reihenfolgeunabhängige
 * Prüfsummen, Verweigerungen.
 *
 * Der Prüfstand läuft aus einer eigenen, sauberen Git-Kopie des Kandidaten
 * (scripts, lib, db; node_modules verlinkt): .env-Dateien des Entwicklers
 * beeinflussen ihn so nicht, und PASS verlangt einen identifizierten, sauberen
 * Stand — beides wie in der späteren Verifier-Sitzung.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { runMigrations } from '../../lib/db/migrate.mjs';
import { openDatabase } from '../../lib/db/open.mjs';
import { runSeeds } from '../../lib/db/seed.mjs';
import { compareContent, tableContent } from '../../scripts/db-verify-copy.mjs';
import { MIGRATIONS_DIR, ROOT, buildLegacy, insertSyntheticRows, tempDir } from './helpers.mjs';

const hasGit = spawnSync('git', ['--version']).status === 0;
const skip = !hasGit && 'git fehlt';
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

const SENTINELS = ['SENTINEL-NAME-4b1f', 'SENTINEL-TOKEN-91ac', 'SENTINEL-PHONE-0301234567', 'SENTINEL-NOTE-77de', 'sentinel@example.invalid', 'Grüße', 'ünïcödé'];

/** Produktionsähnliche Quelle: Altstand, Seeds vollständig, gemischte Speicherklassen, auf Wunsch Daten nur im WAL. */
function source({ variant = 'S5', missingTemplate = null, walRows = 0 } = {}) {
  const dir = tempDir();
  const path = join(dir, 'quelle.db');
  const db = buildLegacy(path, variant);
  runSeeds(db);
  insertSyntheticRows(db, 4);
  const now = '2026-10-04T00:00:00.000Z';
  db.exec(`INSERT INTO settings (key, value) VALUES
    ('blob', x'00ff10'), ('ungueltiges-utf8', CAST(x'ff00fe' AS TEXT)), ('real', 0.30000000000000004),
    ('gross', 9007199254740993), ('leer', NULL), ('text-1', '1'), ('int-1', 1), ('unicode', 'Grüße ünïcödé 🌍')`);
  db.prepare("UPDATE leads SET phone = 'SENTINEL-PHONE-0301234567', notes = 'SENTINEL-NOTE-77de' WHERE rowid IN (SELECT rowid FROM leads ORDER BY rowid LIMIT 5)").run();
  if (variant === 'S5') {
    db.prepare('INSERT INTO users (email, display_name, google_tokens, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('sentinel@example.invalid', 'SENTINEL-NAME-4b1f', '{"refresh_token":"SENTINEL-TOKEN-91ac"}', now, now);
  }
  if (missingTemplate) db.prepare('DELETE FROM email_templates WHERE slug = ?').run(missingTemplate);
  db.close();
  if (walRows) {
    // wie in Produktion: aktuelle Daten nur im -wal, die Hauptdatei allein ist veraltet
    const writer = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import Database from 'better-sqlite3';
      const db = new Database(${JSON.stringify(path)});
      db.pragma('wal_autocheckpoint = 0');
      db.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${walRows}) INSERT INTO leads (id, name, updated_at) SELECT 'WAL-' || i, 'nur im WAL ' || i, '${now}' FROM n");
      process.kill(process.pid, 'SIGKILL');
    `], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(writer.signal, 'SIGKILL', writer.stderr);
  }
  return { dir, path };
}

/** Saubere Git-Kopie des Kandidaten, aus der der Prüfstand läuft (mit `git: false` ohne Repository). */
function isolatedProject({ git: withGit = true } = {}) {
  const dir = tempDir();
  for (const part of ['scripts', 'lib', 'db']) cpSync(join(ROOT, part), join(dir, part), { recursive: true });
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
  writeFileSync(join(dir, '.gitignore'), '/node_modules\n');
  if (!withGit) return dir;
  gitIn(dir, 'init', '-q');
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'Kandidat');
  return dir;
}

/** git ohne GIT_*-Variablen der Umgebung (z. B. aus einem Hook) und ohne Nutzer-/Systemkonfiguration. */
function gitIn(dir, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const result = spawnSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    encoding: 'utf8',
    env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
}
let shared = null;
const project = () => (shared ??= isolatedProject());

function harness(args, env = {}, dir = project()) {
  const result = spawnSync(process.execPath, [join(dir, 'scripts', 'db-verify-copy.mjs'), ...args], {
    cwd: tempDir(),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    encoding: 'utf8',
  });
  const lines = result.stdout.split('\n').filter(Boolean);
  const value = (prefix) => lines.find(l => l.startsWith(`PXK-AC3 ${prefix}`));
  return { ...result, lines, value };
}
const verify = (path, dir) => harness([`--source=${path}`, `--workdir=${join(tempDir(), 'arbeit')}`], {}, dir);

const ALLOWED = [
  /^PXK-AC3 candidate=([0-9a-f]{40}|[0-9a-f]{64}|unknown) clean=(yes|NO|unknown) node=v\d+\.\d+\.\d+ sqlite=\d+\.\d+\.\d+$/,
  /^PXK-AC3 migrations=\d+ last=\d{4}_[a-z0-9_]+$/,
  /^PXK-AC3 source readable=(yes copy=online-backup copy_integrity=(ok|FAILED)|no error=[A-Z_]+)$/,
  /^PXK-AC3 before class=[A-Z_]+( S[1-5])? user_version=\d+ ledger=[A-Za-z_]+ tables=\d+$/,
  /^PXK-AC3 run1 exit=\d+ error=[-A-Z_0-9]+ head=[-\d]+ seeds=(-|\d+\/\d+) backups_created=\d+ actions=[a-z0-9_ ,()S-]+$/,
  /^PXK-AC3 after class=[A-Z_]+( S[1-5])? user_version=\d+ ledger_check=[A-Za-z_]+ integrity=(ok|FAILED)$/,
  /^PXK-AC3 ledger rows=\d+ (-|(\d+:\d{4}_[a-z0-9_]+:(applied|baselined):(S[1-5]|-) ?)+) ?expected=(MATCH|MISMATCH)$/,
  /^PXK-AC3 schema after_vs_canonical=(MATCH|MISMATCH) before_vs_after=(MATCH|CHANGED)$/,
  /^PXK-AC3 table=([A-Za-z0-9_]+|#\d+) rows_before=(-|\d+) rows_after=(-|\d+) content=(MATCH|MISMATCH)$/,
  /^PXK-AC3 changed_tables=\d+$/,
  /^PXK-AC3 backup_vs_before=(MATCH|MISMATCH|MISSING|none-required)$/,
  /^PXK-AC3 run2 exit=\d+ error=[-A-Z_0-9]+ actions=[a-z0-9_ ,()S-]+ seeds=(-|\d+\/\d+) backups_created=-?\d+ noop=(MATCH|MISMATCH)$/,
  /^PXK-AC3 run2 file_unchanged=(MATCH|MISMATCH) content=(MATCH|MISMATCH)$/,
  /^PXK-AC3 source_unchanged=(MATCH|MISMATCH)$/,
  /^PXK-AC3 failures=[a-z0-9_,]+$/,
  /^PXK-AC3 workdir_plaintext=yes \(copy\.db, backups\) — nach der Auswertung löschen$/,
  /^PXK-AC3 verdict=(PASS|FAIL)$/,
];

/** Nur erlaubte Zeilen; keine Werte, keine Prüfsummen (außer der Kandidaten-SHA). */
function assertPrivate(result, extraSentinels = []) {
  const all = `${result.stdout}${result.stderr}`;
  for (const line of result.lines) assert.ok(ALLOWED.some(re => re.test(line)), `nicht erlaubte Zeile: ${line}`);
  assert.equal(result.stderr, '', 'keine Ausgabe auf stderr');
  for (const sentinel of [...SENTINELS, ...extraSentinels]) assert.equal(all.includes(sentinel), false, `Wert in der Ausgabe: ${sentinel}`);
  const withoutCandidate = result.lines.filter(l => !l.startsWith('PXK-AC3 candidate=')).join('\n');
  assert.doesNotMatch(withoutCandidate, /[0-9a-fA-F]{16,}/, 'keine Prüfsummen oder Hex-Inhalte');
  assert.doesNotMatch(all, /\/(private|var|tmp|Users|home)\//, 'keine Pfade');
}

test('AC3-Probe (synthetisch): produktionsähnliche S5-Kopie mit Daten nur im WAL → PASS, Geschäftsdaten gleich, Metadaten getrennt, zweiter Lauf No-op, Quelle unverändert', { skip }, () => {
  const { dir, path } = source({ walRows: 120 });
  const live = new Database(path, { readonly: true });
  const leads = live.prepare('SELECT count(*) AS c FROM leads').get().c;
  live.close();
  assert.equal(leads, 952 + 4 + 120, 'Quelle enthält die WAL-Zeilen');
  assert.ok(readFileSync(`${path}-wal`).length > 0, 'Daten noch im -wal (kein Checkpoint durch Leser)');
  const sidecarsBefore = readdirSync(dir).sort();
  // Inhalt tragen Hauptdatei und -wal; -shm ist der WAL-Index, den jeder Leser neu aufbauen darf.
  const before = { main: sha(path), wal: sha(`${path}-wal`) };

  const result = verify(path);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.value('verdict='), 'PXK-AC3 verdict=PASS');
  assert.match(result.value('candidate='), /^PXK-AC3 candidate=([0-9a-f]{40}|[0-9a-f]{64}) clean=yes /);
  assert.equal(result.value('failures='), 'PXK-AC3 failures=none');
  assert.equal(result.value('before class='), 'PXK-AC3 before class=LEGACY_EXACT S5 user_version=0 ledger=absent tables=8');
  assert.match(result.value('run1 '), /^PXK-AC3 run1 exit=0 error=- head=1 seeds=0\/0 backups_created=1 actions=baselined 0001_baseline \(S5\)$/);
  assert.equal(result.value('ledger '), 'PXK-AC3 ledger rows=1 1:0001_baseline:baselined:S5 expected=MATCH');
  assert.equal(result.value('schema '), 'PXK-AC3 schema after_vs_canonical=MATCH before_vs_after=MATCH');
  assert.equal(result.value('table=leads '), `PXK-AC3 table=leads rows_before=${leads} rows_after=${leads} content=MATCH`);
  assert.equal(result.value('changed_tables='), 'PXK-AC3 changed_tables=0');
  assert.equal(result.value('backup_vs_before='), 'PXK-AC3 backup_vs_before=MATCH');
  assert.match(result.value('run2 exit'), /actions=noop seeds=0\/0 backups_created=0 noop=MATCH$/);
  assert.equal(result.value('run2 file'), 'PXK-AC3 run2 file_unchanged=MATCH content=MATCH');
  assert.equal(result.value('source_unchanged='), 'PXK-AC3 source_unchanged=MATCH');
  assertPrivate(result);
  // Quelle samt vorhandener WAL-Dateien bytegleich, keine neuen Nebendateien
  assert.deepEqual(readdirSync(dir).sort(), sidecarsBefore);
  assert.deepEqual({ main: sha(path), wal: sha(`${path}-wal`) }, before);
});

test('AC3-Probe erkennt eine Datenänderung durch den Kandidatenlauf (Seeds würden schreiben) → FAIL, nur Zähler in der Ausgabe', { skip }, () => {
  const { path } = source({ missingTemplate: 'angebot' });
  const result = verify(path);
  assert.equal(result.status, 1);
  assert.equal(result.value('verdict='), 'PXK-AC3 verdict=FAIL');
  assert.match(result.value('table=email_templates '), /^PXK-AC3 table=email_templates rows_before=(\d+) rows_after=(\d+) content=MISMATCH$/);
  const [, rowsBefore, rowsAfter] = /rows_before=(\d+) rows_after=(\d+)/.exec(result.value('table=email_templates '));
  assert.equal(Number(rowsAfter), Number(rowsBefore) + 1);
  // der neue Vorlagen-Eintrag erhöht auch den AUTOINCREMENT-Zähler — beides wird erkannt
  assert.match(result.value('table=sqlite_sequence '), /content=MISMATCH$/);
  assert.equal(result.value('changed_tables='), 'PXK-AC3 changed_tables=2');
  assert.equal(result.value('backup_vs_before='), 'PXK-AC3 backup_vs_before=MATCH', 'Sicherung lag vor dem Schreiben');
  assert.match(result.value('failures='), /business_data/);
  assertPrivate(result, ['Ihr Angebot', 'Angebot · Webauftritt']);
});

test('AC3-Probe: Kandidat verweigert (älterer Altstand S3 ohne Freigabe) → FAIL mit Fehlercode, Kopie bleibt Altstand, Quelle unverändert', { skip }, () => {
  const { path } = source({ variant: 'S3' });
  const hash = sha(path);
  const result = verify(path);
  assert.equal(result.status, 1);
  assert.match(result.value('run1 '), /^PXK-AC3 run1 exit=12 error=LEGACY_OUTDATED /);
  assert.match(result.value('after class='), /class=LEGACY_EXACT S3 /);
  // jede betroffene Prüfung schlägt an, nicht nur der Exit-Code
  assert.equal(result.value('failures='), 'PXK-AC3 failures=run1_exit,after_ledger_state,ledger_rows,schema_canonical,run2_noop');
  assert.match(result.value('schema '), /after_vs_canonical=MISMATCH/);
  assert.match(result.value('run2 exit'), /noop=MISMATCH$/);
  assert.equal(result.value('source_unchanged='), 'PXK-AC3 source_unchanged=MATCH');
  assert.equal(sha(path), hash);
  assertPrivate(result);
});

test('AC3-Probe: beschädigte Quelle → FAIL (source readable=no), nichts weiter ausgeführt', { skip }, () => {
  const path = join(tempDir(), 'kaputt.db');
  writeFileSync(path, Buffer.alloc(8192, 0x41));
  const result = verify(path);
  assert.equal(result.status, 1);
  assert.match(result.value('source readable='), /^PXK-AC3 source readable=no error=SQLITE_NOTADB$/);
  assert.equal(result.value('run1 '), undefined);
  assertPrivate(result);
});

test('AC3-Probe läuft im Produktionsmodus: leere, aber gültige SQLite-Quelle → FRESH_DB_IN_PRODUCTION, FAIL', { skip }, () => {
  const path = join(tempDir(), 'leer-aber-gueltig.db');
  const db = new Database(path);
  db.exec('CREATE TABLE weg (a); DROP TABLE weg;');
  db.close();
  const result = verify(path);
  assert.equal(result.status, 1);
  assert.match(result.value('before class='), /class=EMPTY /);
  assert.match(result.value('run1 '), /^PXK-AC3 run1 exit=12 error=FRESH_DB_IN_PRODUCTION /);
  assertPrivate(result);
});

test('AC3-Probe: schon migrierte Quelle ist kein AC3-Beleg → FAIL (nothing_migrated), obwohl alles gleich bleibt', { skip }, async () => {
  const { path } = source();
  const db = openDatabase(path, 'apply');
  await runMigrations(db, { migrationsDir: MIGRATIONS_DIR, production: false, backup: false });
  db.close();
  const result = verify(path);
  assert.equal(result.status, 1);
  assert.match(result.value('run1 '), /actions=noop$/);
  assert.equal(result.value('changed_tables='), 'PXK-AC3 changed_tables=0');
  assert.equal(result.value('failures='), 'PXK-AC3 failures=nothing_migrated');
  assertPrivate(result);
});

test('AC3-Probe ist an den Kandidaten gebunden: unversionierte Datei oder kein Git-Stand → FAIL (candidate_unverified)', { skip }, () => {
  const { path } = source();
  const dirty = isolatedProject();
  writeFileSync(join(dirty, 'notiz.txt'), 'nicht versioniert');
  const dirtyResult = verify(path, dirty);
  assert.equal(dirtyResult.status, 1);
  assert.match(dirtyResult.value('candidate='), / clean=NO /);
  assert.equal(dirtyResult.value('failures='), 'PXK-AC3 failures=candidate_unverified');
  const unknown = verify(path, isolatedProject({ git: false }));
  assert.equal(unknown.status, 1);
  assert.match(unknown.value('candidate='), /^PXK-AC3 candidate=unknown clean=unknown /);
  assert.equal(unknown.value('failures='), 'PXK-AC3 failures=candidate_unverified');
  // Kopie ohne eigenes Repository in einem ignorierten Ordner eines sauberen Repositorys: dessen HEAD zählt nicht.
  const parent = tempDir();
  writeFileSync(join(parent, '.gitignore'), '/kandidat/\n');
  gitIn(parent, 'init', '-q');
  gitIn(parent, 'add', '-A');
  gitIn(parent, 'commit', '-q', '-m', 'fremd');
  const nested = join(parent, 'kandidat');
  cpSync(isolatedProject({ git: false }), nested, { recursive: true, verbatimSymlinks: true });
  const borrowed = verify(path, nested);
  assert.equal(borrowed.status, 1);
  assert.match(borrowed.value('candidate='), /^PXK-AC3 candidate=unknown clean=unknown /);
  assert.equal(borrowed.value('failures='), 'PXK-AC3 failures=candidate_unverified');
});

test('AC3-Probe: scheitert die Kopie einer WAL-Quelle, werden die vom Lesen angelegten Nebendateien trotzdem entfernt', { skip }, () => {
  const dir = tempDir();
  const path = join(dir, 'kopf.db');
  // nur der 100-Byte-Kopf einer WAL-Datenbank (Bytes 18/19 = 2): SQLite legt -wal/-shm an und scheitert dann
  writeFileSync(path, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.from([0x10, 0x00, 0x02, 0x02]), Buffer.alloc(80)]));
  const result = verify(path);
  assert.equal(result.status, 1);
  assert.match(result.value('source readable='), /^PXK-AC3 source readable=no error=SQLITE_(NOTADB|CORRUPT)$/);
  assert.deepEqual(readdirSync(dir), ['kopf.db']);
  assertPrivate(result);
});

test('AC3-Probe: ein Tabellenname mit Zeilenumbruch kann keine Ergebniszeile einschleusen', { skip }, () => {
  const { path } = source();
  const db = new Database(path);
  db.exec('CREATE TABLE "x\nPXK-AC3 verdict=PASS" (a); INSERT INTO "x\nPXK-AC3 verdict=PASS" VALUES (1);');
  db.close();
  const result = verify(path);
  assert.equal(result.status, 1);
  assert.deepEqual(result.lines.filter(l => l.startsWith('PXK-AC3 verdict=')), ['PXK-AC3 verdict=FAIL']);
  assert.ok(result.lines.some(l => /^PXK-AC3 table=#\d+ /.test(l)), 'Name nur als Nummer');
  assertPrivate(result);
});

test('AC3-Probe schützt die Klartext-Kopie: vorhandener Arbeitsordner wird 0700, copy.db 0600', { skip }, () => {
  const { path } = source();
  const work = join(tempDir(), 'vorhanden');
  mkdirSync(work);
  chmodSync(work, 0o755);
  const result = harness([`--source=${path}`, `--workdir=${work}`]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(statSync(work).mode & 0o777, 0o700);
  assert.equal(statSync(join(work, 'copy.db')).mode & 0o777, 0o600);
});

test('AC3-Probe öffnet nie eine leere Quelle mit -wal daneben (Exit 2) — das -wal bleibt bytegleich', { skip }, () => {
  const dir = tempDir();
  const writer = new Database(join(dir, 'schreiber.db'));
  writer.pragma('journal_mode = WAL');
  writer.pragma('wal_autocheckpoint = 0');
  writer.exec("CREATE TABLE t (a); INSERT INTO t VALUES ('nur im WAL')");
  copyFileSync(join(dir, 'schreiber.db-wal'), join(dir, 'quelle.db-wal'));
  writer.close();
  writeFileSync(join(dir, 'quelle.db'), '');
  const wal = sha(join(dir, 'quelle.db-wal'));
  const result = harness([`--source=${join(dir, 'quelle.db')}`, `--workdir=${join(tempDir(), 'arbeit')}`]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Quelle ist leer/);
  assert.equal(sha(join(dir, 'quelle.db-wal')), wal);
});

test('AC3-Probe: Quelle als Symlink — Nebendateien neben der echten Datei werden aufgeräumt, die Quelle bleibt unverändert', { skip }, () => {
  const { dir, path } = source();
  assert.deepEqual(readdirSync(dir), ['quelle.db'], 'WAL-Modus, aber ohne Nebendateien');
  const link = join(tempDir(), 'verweis.db');
  symlinkSync(path, link);
  const hash = sha(path);
  const result = verify(link);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.value('source_unchanged='), 'PXK-AC3 source_unchanged=MATCH');
  assert.deepEqual(readdirSync(dir), ['quelle.db'], 'keine -wal/-shm neben der echten Datei');
  assert.equal(sha(path), hash);
});

test('AC3-Prüfstand verweigert (Exit 2), wenn .env-Dateien im Projekt den Migrationsschritt beeinflussen würden', { skip }, () => {
  const { path } = source();
  const dir = isolatedProject();
  writeFileSync(join(dir, '.env.local'), 'SQLITE_PATH=/anderswo/crm.db\n');
  const work = join(tempDir(), 'arbeit');
  const result = harness([`--source=${path}`, `--workdir=${work}`], {}, dir);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /\.env-Dateien im Projekt \(\.env\.local\)/);
  assert.equal(existsSync(work), false);
  rmSync(join(dir, '.env.local'));
});

test('Prüfsumme: verlustfrei und unabhängig von der Einfügereihenfolge — erkennt Wert, Speicherklasse, ungültiges UTF-8, TEXT↔BLOB, Blob-Byte, Zeile mehr/weniger', () => {
  const key = randomBytes(32);
  const ROWS = ["(1, 'eins')", "('1', x'00ff')", "(1.5, CAST(x'ff00fe' AS TEXT))", "(NULL, 'Grüße 🌍')", '(9007199254740993, 0.1)', "(1, 'eins')"];
  const digest = (rows) => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE t (a, b); INSERT INTO t VALUES ${rows.join(', ')};`);
      return tableContent(db, key).t;
    } finally {
      db.close();
    }
  };
  const base = digest(ROWS);
  assert.equal(base.rows, 6);
  assert.deepEqual(digest([...ROWS].reverse()), base, 'Reihenfolge egal');
  assert.deepEqual(digest([ROWS[3], ROWS[0], ROWS[4], ROWS[5], ROWS[2], ROWS[1]]), base);
  const replace = (index, row) => ROWS.map((r, i) => (i === index ? row : r));
  const mutations = {
    'Wert geändert': replace(0, "(1, 'Eins')"),
    'Speicherklasse INTEGER→TEXT': replace(0, "('1', 'eins')"),
    'Speicherklasse INTEGER→REAL': replace(0, "(1.0, 'eins')"),
    'Speicherklasse TEXT→INTEGER': replace(1, "(1, x'00ff')"),
    'ungültiges UTF-8, anderes Byte': replace(2, "(1.5, CAST(x'ff00fd' AS TEXT))"),
    'TEXT↔BLOB bei gleichen Bytes': replace(2, "(1.5, x'ff00fe')"),
    'Blob-Byte': replace(1, "('1', x'00fe')"),
    'NULL statt Wert': replace(3, "(NULL, NULL)"),
    'REAL letzte Stelle': replace(4, '(9007199254740993, 0.10000000000000002)'),
    'INTEGER jenseits 2^53': replace(4, '(9007199254740992, 0.1)'),
    'Zeile fehlt (Duplikat)': ROWS.slice(0, 5),
    'Zeile mehr (Duplikat)': [...ROWS, "(1, 'eins')"],
  };
  for (const [name, rows] of Object.entries(mutations)) assert.notEqual(digest(rows).mac, base.mac, name);
  // compareContent meldet genau die betroffene Tabelle
  const other = { t: digest(mutations['Wert geändert']), u: base };
  assert.deepEqual(compareContent({ t: base, u: base }, other).map(t => [t.name, t.match]), [['t', false], ['u', true]]);
});

test('Prüfsummen hängen am Schlüssel dieses Prozesses: anderer Schlüssel → andere Werte, gleicher → gleiche', () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE t (a); INSERT INTO t VALUES ('kurz')");
  const a = randomBytes(32);
  assert.equal(tableContent(db, a).t.mac, tableContent(db, a).t.mac);
  assert.notEqual(tableContent(db, a).t.mac, tableContent(db, randomBytes(32)).t.mac);
  db.close();
});

test('AC3-Prüfstand verweigert (Exit 2): relative Pfade, fehlende Quelle, Arbeitsordner nicht leer oder keine Ordner, Produktions-/Railway-Umgebung', { skip }, () => {
  const { path } = source();
  const work = join(tempDir(), 'arbeit');
  const cases = [
    [['--source=quelle.db', `--workdir=${work}`], {}, /--source muss ein absoluter Pfad sein/],
    [[`--source=${path}`, '--workdir=arbeit'], {}, /--workdir muss ein absoluter Pfad sein/],
    [[`--source=${join(tempDir(), 'fehlt.db')}`, `--workdir=${work}`], {}, /Quelle fehlt/],
    [[`--source=${path}`, `--workdir=${path}`], {}, /kein Ordner/],
    [[`--source=${path}`, `--workdir=${join(path, '..')}`], {}, /nicht leer/],
    [[`--source=${path}`, `--workdir=${work}`], { RAILWAY_ENVIRONMENT_NAME: 'production' }, /Railway-Umgebung/],
    [[`--source=${path}`, `--workdir=${work}`], { RAILWAY_PROJECT_ID: 'x' }, /Railway-Umgebung/],
    [[`--source=${path}`, `--workdir=${work}`], { NODE_ENV: 'production' }, /Produktions/],
    [['--irgendwas'], {}, /unbekanntes Argument/],
  ];
  for (const [args, env, reason] of cases) {
    const result = harness(args, env);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
    assert.match(result.stderr, reason);
    assert.equal(result.stdout, '');
  }
  assert.equal(existsSync(work), false, 'nichts angelegt');
  mkdirSync(work);
  writeFileSync(join(work, 'notiz.txt'), 'bleibt');
  assert.equal(harness([`--source=${path}`, `--workdir=${work}`]).status, 2);
  assert.equal(readFileSync(join(work, 'notiz.txt'), 'utf8'), 'bleibt');
});

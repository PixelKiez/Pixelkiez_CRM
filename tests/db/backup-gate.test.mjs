/**
 * Release B (PXK-113, D4/D5): Kein Schreibzugriff auf eine Produktionsdatenbank
 * ohne geprüfte Sicherung desselben Laufs — für Migrationen und für Seeds.
 *
 * - Seeds prüfen vorab nur lesend; ohne Schreibbedarf schreibt der Lauf nichts.
 * - Sicherungsziel in Produktion: fehlt, leer oder relativ → verweigert, sobald
 *   geschrieben werden müsste; ohne Schreibbedarf startet die App mit Hinweis.
 * - Sicherungen entstehen in .partial-*, nur geprüfte liegen direkt im Ziel;
 *   eine abgebrochene Kopie wird nie für eine geprüfte gehalten.
 * - WAL: gesichert wird über die SQLite-Backup-API, nie die Hauptdatei allein.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { contentDigest } from '../../lib/db/fingerprint.mjs';
import { openDatabase } from '../../lib/db/open.mjs';
import { runSeeds, seedWriteGate } from '../../lib/db/seed.mjs';
import { MIGRATIONS_DIR, ROOT, buildLegacy, errorCode, insertSyntheticRows, ledgerRows, tempDir } from './helpers.mjs';

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Eigenes Projekt (in Produktion zählt nur db/migrations unter dem Arbeitsverzeichnis). */
function project() {
  const dir = tempDir();
  symlinkSync(join(ROOT, 'scripts'), join(dir, 'scripts'));
  mkdirSync(join(dir, 'db', 'migrations'), { recursive: true });
  copyFileSync(join(MIGRATIONS_DIR, '0001_baseline.sql'), join(dir, 'db', 'migrations', '0001_baseline.sql'));
  return dir;
}
const cli = (dir, env, args = []) => spawnSync(process.execPath, ['scripts/db-migrate.mjs', ...args], {
  cwd: dir,
  env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  encoding: 'utf8',
});

/** Migriert und befüllt wie npm start (Entwicklung), dann mit synthetischen Zeilen ergänzt. */
function seededDb(dir) {
  const path = join(dir, 'crm.db');
  const first = cli(dir, { SQLITE_PATH: path });
  assert.equal(first.status, 0, first.stderr);
  const db = openDatabase(path, 'apply');
  insertSyntheticRows(db);
  db.close();
  return path;
}

function state(path) {
  const db = openDatabase(path, 'inspect');
  try {
    return { ledger: ledgerRows(db), digest: contentDigest(db) };
  } finally {
    db.close();
  }
}
const deleteTemplate = (path, slug) => {
  const db = openDatabase(path, 'apply');
  db.prepare('DELETE FROM email_templates WHERE slug = ?').run(slug);
  db.close();
};
const backupFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter(f => /^pre-.*\.db$/.test(f)) : []);
const stagingDirs = (dir) => (existsSync(dir) ? readdirSync(dir).filter(f => f.startsWith('.partial-')) : []);

/** Zeichnet auf, was runSeeds an der Verbindung tut. */
function recording(db) {
  const calls = { transactions: 0, pragmas: [], statements: [] };
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'transaction') return (fn) => { calls.transactions += 1; return target.transaction(fn); };
      if (prop === 'pragma') return (...args) => { calls.pragmas.push(args[0]); return target.pragma(...args); };
      if (prop === 'prepare') return (sql) => { calls.statements.push(sql); return target.prepare(sql); };
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { proxy, calls };
}

test('Seeds ohne Schreibbedarf: keine Transaktion, kein PRAGMA, nur SELECT — und beforeWrite wird nicht aufgerufen', () => {
  const path = seededDb(project());
  const db = openDatabase(path, 'apply');
  const changes = db.prepare('SELECT total_changes() AS n').get().n;
  const { proxy, calls } = recording(db);
  let gate = 0;
  assert.deepEqual(runSeeds(proxy, { beforeWrite: () => { gate += 1; } }), { templatesInserted: 0, leadsInserted: 0 });
  assert.equal(calls.transactions, 0);
  assert.deepEqual(calls.pragmas, []);
  assert.ok(calls.statements.every(sql => /^\s*SELECT\b/i.test(sql)), calls.statements.join(' | '));
  assert.equal(gate, 0);
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes);
  db.close();
});

test('Seeds: beforeWrite läuft genau einmal vor dem ersten INSERT; wirft es, bleibt alles unberührt', () => {
  const path = join(project(), 'crm.db');
  const fresh = cli(join(path, '..'), { SQLITE_PATH: path }, ['--no-seed']);
  assert.equal(fresh.status, 0, fresh.stderr);
  const db = openDatabase(path, 'apply');
  const before = contentDigest(db);
  const refused = new Error('kein Schreiben erlaubt');
  assert.throws(() => runSeeds(db, { beforeWrite: () => { throw refused; } }), error => error === refused || error?.detail?.includes('kein Schreiben erlaubt'));
  assert.deepEqual(contentDigest(db), before, 'weder Vorlagen noch Leads geschrieben');
  let gate = 0;
  assert.deepEqual(runSeeds(db, { beforeWrite: () => { gate += 1; } }), { templatesInserted: 8, leadsInserted: 952 });
  assert.equal(gate, 1, 'einmal für den ganzen Lauf');
  db.close();
});

test('D5: Produktion, Seeds müssten schreiben, Sicherungsziel fehlt/leer/relativ → BACKUP_DESTINATION_REQUIRED (Exit 15), nichts geschrieben, nichts angelegt', () => {
  const dir = project();
  const path = seededDb(dir);
  deleteTemplate(path, 'angebot');
  const before = state(path);
  const cases = [
    [undefined, /PXK_DB_BACKUP_DIR fehlt/],
    ['', /PXK_DB_BACKUP_DIR ist leer/],
    ['   ', /PXK_DB_BACKUP_DIR ist leer/],
    ['relativ/backups', /PXK_DB_BACKUP_DIR ist kein absoluter Pfad/],
    ['./backups', /PXK_DB_BACKUP_DIR ist kein absoluter Pfad/],
  ];
  for (const [value, reason] of cases) {
    const env = { SQLITE_PATH: path, RAILWAY_ENVIRONMENT_NAME: 'production', ...(value === undefined ? {} : { PXK_DB_BACKUP_DIR: value }) };
    const result = cli(dir, env);
    const label = JSON.stringify(value);
    assert.equal(result.status, 15, `${label}: ${result.stderr}`);
    assert.match(result.stderr, /PXK-DB \[BACKUP_DESTINATION_REQUIRED\] PXK_DB_BACKUP_DIR: /, label);
    assert.match(result.stderr, reason, label);
    assert.match(result.stderr, /Seeds würde in Produktion schreiben/, label);
    assert.deepEqual(state(path), before, `${label}: nichts geschrieben`);
  }
  assert.equal(existsSync(join(dir, 'relativ')), false, 'relativer Pfad wurde nicht angelegt');
  assert.equal(existsSync(join(dir, 'backups')), false);
});

test('D5: Produktion, Migration nötig (Altstand-Übernahme), Sicherungsziel leer oder relativ → Exit 15, kein Ledger', () => {
  const dir = project();
  const path = join(dir, 'crm.db');
  const legacy = buildLegacy(path, 'S5');
  insertSyntheticRows(legacy);
  legacy.close();
  const before = state(path);
  for (const [value, reason] of [['', /ist leer/], ['backups', /kein absoluter Pfad/]]) {
    const result = cli(dir, { SQLITE_PATH: path, NODE_ENV: 'production', PXK_DB_BACKUP_DIR: value });
    assert.equal(result.status, 15, result.stderr);
    assert.match(result.stderr, reason);
    assert.match(result.stderr, /Migration würde in Produktion schreiben/);
    assert.deepEqual(state(path), before);
  }
  assert.equal(existsSync(join(dir, 'backups')), false);
});

test('D4: Produktion, nur Seeds schreiben → erst geprüfte, abgelegte Sicherung, dann Seeds; die Sicherung zeigt den Stand davor', () => {
  const dir = project();
  const path = seededDb(dir);
  deleteTemplate(path, 'nachfassen');
  const before = state(path);
  const backups = join(tempDir(), 'sicherungen');
  const result = cli(dir, { SQLITE_PATH: path, RAILWAY_ENVIRONMENT_NAME: 'production', PXK_DB_BACKUP_DIR: backups });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /PXK-DB Sicherung (\S+)\/pre-seeds-\S+\.db sha256=[0-9a-f]{64} bytes=\d+\nPXK-DB seeds templates=1 leads=0\nPXK-DB ok head=1 noop seeds=1\/0\n/,
  );
  const files = backupFiles(backups);
  assert.equal(files.length, 1, files.join(', '));
  assert.ok(result.stdout.includes(`PXK-DB Sicherung ${join(backups, files[0])} sha256=`), 'geloggt wird der abgelegte Pfad');
  assert.deepEqual(stagingDirs(backups), [], 'kein Arbeitsordner bleibt zurück');
  const copy = new Database(join(backups, files[0]), { readonly: true, fileMustExist: true });
  assert.deepEqual(contentDigest(copy), before.digest, 'Sicherung = Stand vor den Seeds');
  copy.close();
  assert.equal(state(path).digest.email_templates.rows, before.digest.email_templates.rows + 1, 'genau die gelöschte Vorlage kehrt zurück');
});

test('D4: Produktion, Sicherung scheitert → BACKUP_FAILED (Exit 15), kein Seed geschrieben', () => {
  const dir = project();
  const path = seededDb(dir);
  deleteTemplate(path, 'erstkontakt');
  const before = state(path);
  const blocker = join(tempDir(), 'datei-statt-ordner');
  writeFileSync(blocker, 'kein Ordner');
  const result = cli(dir, { SQLITE_PATH: path, NODE_ENV: 'production', PXK_DB_BACKUP_DIR: blocker });
  assert.equal(result.status, 15, result.stderr);
  assert.match(result.stderr, /PXK-DB \[BACKUP_FAILED\]/);
  assert.deepEqual(state(path), before);
});

test('AC2 in Produktion: zweiter Lauf ohne Schreibbedarf legt keine Sicherung an und schreibt nichts — auch ohne Sicherungsziel (nur Hinweis)', () => {
  const dir = project();
  const path = seededDb(dir);
  const backups = join(tempDir(), 'sicherungen');
  const env = { SQLITE_PATH: path, RAILWAY_ENVIRONMENT_NAME: 'production' };
  const fileBefore = sha(path);
  const withTarget = cli(dir, { ...env, PXK_DB_BACKUP_DIR: backups });
  assert.equal(withTarget.status, 0, withTarget.stderr);
  assert.match(withTarget.stdout, /PXK-DB ok head=1 noop seeds=0\/0/);
  assert.doesNotMatch(withTarget.stdout, /Sicherung/);
  assert.equal(existsSync(backups), false, 'kein Sicherungsordner ohne Schreibbedarf');
  const withoutTarget = cli(dir, env);
  assert.equal(withoutTarget.status, 0, withoutTarget.stderr);
  assert.match(withoutTarget.stderr, /PXK-DB Hinweis: PXK_DB_BACKUP_DIR fehlt/);
  assert.equal(sha(path), fileBefore, 'Datei unverändert');
});

test('Sicherung aus einem früheren, abgebrochenen Lauf im Ziel zählt nie: jeder schreibende Lauf sichert selbst und geprüft', () => {
  const dir = project();
  const path = join(dir, 'crm.db');
  const legacy = buildLegacy(path, 'S5');
  insertSyntheticRows(legacy);
  legacy.close();
  const backups = join(tempDir(), 'sicherungen');
  mkdirSync(backups);
  const stale = 'pre-0001_baseline-20261001T000000Z-1-abcdef.db';
  writeFileSync(join(backups, stale), Buffer.from('SQLite format 3\0abgebrochen'));
  const result = cli(dir, { SQLITE_PATH: path, NODE_ENV: 'production', PXK_DB_BACKUP_DIR: backups }, ['--no-seed']);
  assert.equal(result.status, 0, result.stderr);
  const files = backupFiles(backups);
  assert.equal(files.length, 2, files.join(', '));
  const own = files.find(f => f !== stale);
  assert.match(result.stdout, new RegExp(`PXK-DB Sicherung \\S+/${own.replace(/\./g, '\\.')} sha256=[0-9a-f]{64}`));
  assert.equal(readFileSync(join(backups, stale), 'utf8'), 'SQLite format 3\0abgebrochen', 'fremde Datei unberührt');
});

test('abgebrochene Sicherung (Prozess beendet) bleibt in .partial-* und nie neben geprüften Sicherungen; Datenbank unberührt', async () => {
  const dir = project();
  const path = join(dir, 'crm.db');
  const legacy = buildLegacy(path, 'S5');
  // groß genug, dass Sicherung und Prüfung deutlich länger dauern als das Abbrechen
  legacy.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 600) INSERT INTO settings (key, value) SELECT 'k' || i, hex(randomblob(131072)) FROM n");
  legacy.close();
  const before = state(path);
  const backups = join(tempDir(), 'sicherungen');
  const child = spawn(process.execPath, ['scripts/db-migrate.mjs', '--no-seed'], {
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, SQLITE_PATH: path, NODE_ENV: 'production', PXK_DB_BACKUP_DIR: backups },
    stdio: 'ignore',
  });
  const exited = new Promise(resolvePromise => child.on('exit', (code, signal) => resolvePromise({ code, signal })));
  // Erst wenn die Kopie wirklich läuft (schon über 1 MiB geschrieben), hart beenden.
  const deadline = Date.now() + 20000;
  let partial = null;
  while (!partial && Date.now() < deadline) {
    const staging = stagingDirs(backups)[0];
    const files = staging ? readdirSync(join(backups, staging)).filter(f => f.endsWith('.db')) : [];
    const candidate = files.length ? join(backups, staging, files[0]) : null;
    if (candidate && existsSync(candidate) && statSync(candidate).size > 1024 * 1024) partial = candidate;
    else await new Promise(r => setTimeout(r, 1));
  }
  assert.ok(partial, 'Sicherung wurde begonnen');
  child.kill('SIGKILL');
  assert.equal((await exited).signal, 'SIGKILL');
  assert.deepEqual(backupFiles(backups), [], 'keine Datei pre-*.db direkt im Ziel');
  assert.ok(existsSync(partial), 'die abgebrochene Kopie liegt im Arbeitsordner');
  assert.ok(statSync(partial).size > 1024 * 1024, 'wirklich mitten in der Kopie abgebrochen');
  assert.deepEqual(state(path), before, 'kein Ledger, keine Datenänderung');

  // Der nächste Lauf sichert neu und legt nur seine geprüfte Kopie ab.
  const next = cli(dir, { SQLITE_PATH: path, NODE_ENV: 'production', PXK_DB_BACKUP_DIR: backups }, ['--no-seed']);
  assert.equal(next.status, 0, next.stderr);
  assert.equal(backupFiles(backups).length, 1);
  assert.equal(stagingDirs(backups).length, 1, 'nur der Arbeitsordner des abgebrochenen Laufs bleibt');
});

test('WAL-abhängige Datenbank (Hauptdatei allein veraltet): die Sicherung über die Backup-API enthält alle Zeilen', () => {
  const dir = project();
  const path = join(dir, 'crm.db');
  const legacy = buildLegacy(path, 'S5');
  legacy.close();
  // Ein Schreiber ohne Checkpoint wird hart beendet: die Daten stehen nur im -wal.
  const writer = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import Database from 'better-sqlite3';
    const db = new Database(${JSON.stringify(path)});
    db.pragma('wal_autocheckpoint = 0');
    db.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300) INSERT INTO leads (id, name, updated_at) SELECT 'WAL-' || i, 'nur im WAL ' || i, '2026-10-04T00:00:00.000Z' FROM n");
    process.kill(process.pid, 'SIGKILL');
  `], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(writer.signal, 'SIGKILL', writer.stderr);
  assert.ok(statSync(`${path}-wal`).size > 0, 'Daten liegen im -wal');
  const mainOnly = join(tempDir(), 'nur-hauptdatei.db');
  copyFileSync(path, mainOnly);
  const raw = new Database(mainOnly, { readonly: true });
  assert.equal(raw.prepare('SELECT count(*) AS c FROM leads').get().c, 0, 'Hauptdatei allein enthält die Zeilen nicht');
  raw.close();
  const before = state(path);
  assert.equal(before.digest.leads.rows, 300);

  const backups = join(tempDir(), 'sicherungen');
  const result = cli(dir, { SQLITE_PATH: path, NODE_ENV: 'production', PXK_DB_BACKUP_DIR: backups }, ['--no-seed']);
  assert.equal(result.status, 0, result.stderr);
  const [file] = backupFiles(backups);
  const copy = new Database(join(backups, file), { readonly: true, fileMustExist: true });
  assert.deepEqual(contentDigest(copy), before.digest, 'Sicherung enthält auch die Zeilen aus dem WAL');
  assert.equal(copy.pragma('journal_mode', { simple: true }), 'delete', 'Sicherung ist eine eigenständige Datei');
  copy.close();
  assert.equal(existsSync(join(backups, `${file}-wal`)), false);
  assert.deepEqual(state(path).digest, before.digest);
});

test('runSeeds: fehlende Quelle → SEED_SOURCE_MISSING (Exit 16), bevor beforeWrite oder ein Schreibzugriff erreicht wird', async () => {
  const path = join(project(), 'crm.db');
  assert.equal(cli(join(path, '..'), { SQLITE_PATH: path }, ['--no-seed']).status, 0);
  const db = openDatabase(path, 'apply');
  const before = contentDigest(db);
  const error = await errorCode(() => runSeeds(db, { leadsJson: join(tempDir(), 'fehlt.json'), beforeWrite: () => assert.fail('darf nicht erreicht werden') }));
  assert.equal(error?.code, 'SEED_SOURCE_MISSING');
  assert.equal(error.exitCode, 16);
  assert.deepEqual(contentDigest(db), before);
  db.close();
});

test('CLI: fehlende Seed-Quelle in Produktion → SEED_SOURCE_MISSING (Exit 16) vor jeder Sicherung — mit und ohne Sicherungsziel', () => {
  // Projekt mit eigener Kopie von lib/ und scripts/, aber ohne db/seeds (wie ein Image, dem die Startdaten fehlen)
  const dir = tempDir();
  for (const part of ['lib', 'scripts']) cpSync(join(ROOT, part), join(dir, part), { recursive: true });
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
  mkdirSync(join(dir, 'db', 'migrations'), { recursive: true });
  copyFileSync(join(MIGRATIONS_DIR, '0001_baseline.sql'), join(dir, 'db', 'migrations', '0001_baseline.sql'));
  const path = join(dir, 'crm.db');
  assert.equal(cli(dir, { SQLITE_PATH: path }, ['--no-seed']).status, 0);
  const before = state(path);
  const backups = join(tempDir(), 'sicherungen');
  for (const env of [{}, { PXK_DB_BACKUP_DIR: backups }]) {
    const result = cli(dir, { SQLITE_PATH: path, NODE_ENV: 'production', ...env });
    assert.equal(result.status, 16, result.stderr);
    assert.match(result.stderr, /PXK-DB \[SEED_SOURCE_MISSING\] db\/seeds\/leads\.json/);
    assert.doesNotMatch(result.stderr, /BACKUP_DESTINATION_REQUIRED/);
    assert.deepEqual(state(path), before, 'nichts geschrieben');
  }
  assert.equal(existsSync(backups), false, 'keine Sicherung für einen Lauf, der nicht schreiben kann');
});

test('seedWriteGate: in Produktion ohne Sicherung → STATE_CHANGED; Daten seit der Sicherung geändert → BACKUP_STALE; jeweils nichts geschrieben', () => {
  const path = seededDb(project());
  deleteTemplate(path, 'angebot');
  const db = openDatabase(path, 'apply');
  const before = contentDigest(db);
  // Prüfung vorab ergab "nichts zu tun", unter der Sperre fehlt doch eine Vorlage (paralleler Schreiber)
  const raced = assert.throws(() => runSeeds(db, { beforeWrite: seedWriteGate(db, { required: true, backup: null }) }), error => error.code === 'STATE_CHANGED' && error.exitCode === 12);
  assert.equal(raced, undefined);
  assert.deepEqual(contentDigest(db), before);
  // Sicherung liegt vor, aber seitdem hat jemand geschrieben
  const digestAtBackup = contentDigest(db);
  db.prepare("INSERT INTO settings (key, value) VALUES ('nach-der-sicherung', '1')").run();
  const changed = contentDigest(db);
  assert.throws(() => runSeeds(db, { beforeWrite: seedWriteGate(db, { required: true, backup: { path: 'x' }, digestAtBackup }) }), error => error.code === 'BACKUP_STALE' && error.exitCode === 15);
  assert.deepEqual(contentDigest(db), changed);
  // Sicherung aktuell → die Vorlage kehrt zurück
  assert.deepEqual(runSeeds(db, { beforeWrite: seedWriteGate(db, { required: true, backup: { path: 'x' }, digestAtBackup: changed }) }), { templatesInserted: 1, leadsInserted: 0 });
  db.close();
});

test('Sicherungsziel mit Zeilenumbruch im Pfad: die geprüfte Sicherung wird trotzdem vor dem Schreiben abgelegt, genau eine Logzeile', () => {
  const dir = project();
  const path = join(dir, 'crm.db');
  const legacy = buildLegacy(path, 'S5');
  insertSyntheticRows(legacy);
  legacy.close();
  const backups = join(tempDir(), 'mit\numbruch');
  const result = cli(dir, { SQLITE_PATH: path, NODE_ENV: 'production', PXK_DB_BACKUP_DIR: backups }, ['--no-seed']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.split('PXK-DB Sicherung ').length - 1, 1, result.stdout);
  assert.equal(backupFiles(backups).length, 1);
  assert.deepEqual(stagingDirs(backups), []);
});

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../../lib/db/open.mjs';
import { ROOT, buildLegacy, insertSyntheticRows, ledgerRows, migrationsCopy, tempDir } from './helpers.mjs';

const CLI = join(ROOT, 'scripts/db-migrate.mjs');
const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
const run = (args, env, cwd = ROOT) => spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...baseEnv, ...env }, encoding: 'utf8' });
const spawnRun = (args, env) => new Promise(resolvePromise => {
  const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env: { ...baseEnv, ...env } });
  let out = '';
  let err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  child.on('close', status => resolvePromise({ status, out, err }));
});
const fileSha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

test('CLI: frische Datenbank, dann No-op', () => {
  const path = join(tempDir(), 'crm.db');
  const first = run([], { SQLITE_PATH: path });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /applied 0001_baseline/);
  assert.match(first.stdout, /seeds=8\/952/);
  const second = run([], { SQLITE_PATH: path });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /PXK-DB ok head=1 noop seeds=0\/0/);
});

test('AC4: gescheiterte Migration → Exit 13, Meldung nennt die Migration, Ledger unverändert', () => {
  const dir = tempDir();
  const path = join(dir, 'crm.db');
  assert.equal(run([], { SQLITE_PATH: path }).status, 0);
  const migrations = migrationsCopy({ '0002_break.sql': 'CREATE TABLE thing (x);\nINSERT INTO leads (id) VALUES (NULL);\n' });
  const result = run([], { SQLITE_PATH: path, PXK_MIGRATIONS_DIR: migrations });
  assert.equal(result.status, 13);
  assert.match(result.stderr, /PXK-DB \[MIGRATION_FAILED\] 0002_break/);
  const db = openDatabase(path, 'app');
  assert.equal(ledgerRows(db).length, 1);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'thing'").get(), undefined);
  db.close();
});

test('Produktion: fehlende Datei wird nicht angelegt (FRESH_DB_IN_PRODUCTION, Exit 12)', () => {
  const path = join(tempDir(), 'crm.db');
  const result = run([], { SQLITE_PATH: path, NODE_ENV: 'production' });
  assert.equal(result.status, 12);
  assert.match(result.stderr, /FRESH_DB_IN_PRODUCTION/);
  assert.equal(existsSync(path), false);
  const allowed = run([], { SQLITE_PATH: path, NODE_ENV: 'production', PXK_DB_ALLOW_FRESH: '1' });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.doesNotMatch(allowed.stderr, /PXK_DB_ALLOW_FRESH/);
  // stehengebliebene Freigabe wird beim nächsten Lauf angemahnt
  const again = run([], { SQLITE_PATH: path, NODE_ENV: 'production', PXK_DB_ALLOW_FRESH: '1', PXK_DB_BACKUP_DIR: join(dirname(path), 'b') });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stderr, /PXK_DB_ALLOW_FRESH=1 ist gesetzt, die Datenbank war aber nicht leer/);
});

test('Produktion: leere 0-Byte-Datei wird nicht beschrieben (Exit 12, bleibt 0 Byte, kein -wal/-shm)', () => {
  const path = join(tempDir(), 'crm.db');
  writeFileSync(path, '');
  const result = run([], { SQLITE_PATH: path, NODE_ENV: 'production' });
  assert.equal(result.status, 12);
  assert.match(result.stderr, /FRESH_DB_IN_PRODUCTION/);
  assert.equal(statSync(path).size, 0);
  assert.equal(existsSync(`${path}-wal`), false);
  assert.equal(existsSync(`${path}-shm`), false);
});

test('CLI liest SQLITE_PATH wie Next.js aus .env.local; echte Umgebung hat Vorrang', () => {
  const cwd = tempDir();
  const fromFile = join(cwd, 'aus-env-datei.db');
  writeFileSync(join(cwd, '.env.local'), `# lokal\nSQLITE_PATH=${fromFile}\nAUTH_SECRET=wird-nicht-gelesen\n`);
  const env = { PXK_MIGRATIONS_DIR: join(ROOT, 'db/migrations') };
  const result = run(['--no-seed'], env, cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /sqlite_path=SQLITE_PATH .*aus-env-datei\.db/);
  assert.ok(existsSync(fromFile));
  const explicit = join(cwd, 'explizit.db');
  assert.equal(run(['--no-seed'], { ...env, SQLITE_PATH: explicit }, cwd).status, 0);
  assert.ok(existsSync(explicit));
});

test('Produktion: Altstand-Übernahme braucht ein Sicherungsziel und sichert geprüft', () => {
  const dir = tempDir();
  const path = join(dir, 'crm.db');
  const db = buildLegacy(path, 'S5');
  insertSyntheticRows(db);
  db.close();
  const refused = run([], { SQLITE_PATH: path, NODE_ENV: 'production' });
  assert.equal(refused.status, 15);
  assert.match(refused.stderr, /BACKUP_DESTINATION_REQUIRED/);
  const backups = join(dir, 'backups');
  const ok = run([], { SQLITE_PATH: path, NODE_ENV: 'production', PXK_DB_BACKUP_DIR: backups });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /PXK-DB mode=production sqlite_path=SQLITE_PATH /);
  assert.match(ok.stdout, /PXK-DB Sicherung .*pre-0001_baseline-\d{8}T\d{6}Z-\d+-[0-9a-f]{6}\.db sha256=[0-9a-f]{64}/);
  assert.match(ok.stdout, /baselined 0001_baseline \(S5\)/);
});

test('Produktion: abweichender Migrationsordner wird ignoriert', () => {
  const path = join(tempDir(), 'crm.db');
  const migrations = migrationsCopy({ '0002_extra.sql': 'CREATE TABLE extra2 (x);\n' });
  const result = run([], { SQLITE_PATH: path, NODE_ENV: 'production', PXK_DB_ALLOW_FRESH: '1', PXK_MIGRATIONS_DIR: migrations });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /ignoriert/);
  assert.doesNotMatch(result.stdout, /0002_extra/);
});

test('älterer Altstand: ohne Freigabe Exit 12, mit Freigabe übernommen', () => {
  const path = join(tempDir(), 'crm.db');
  buildLegacy(path, 'S3').close();
  const refused = run([], { SQLITE_PATH: path });
  assert.equal(refused.status, 12);
  assert.match(refused.stderr, /LEGACY_OUTDATED.*PXK_DB_ADOPT_LEGACY=S3/);
  const ok = run(['--adopt-legacy=S3'], { SQLITE_PATH: path });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /baselined 0001_baseline \(S3\)/);
});

test('--report schreibt nichts, gibt keine Inhalte aus und endet immer mit 0', () => {
  const dir = tempDir();
  const path = join(dir, 'crm.db');
  const db = buildLegacy(path, 'S5');
  insertSyntheticRows(db);
  db.prepare("UPDATE users SET google_tokens = '{\"refresh_token\":\"geheim-123\"}'").run();
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  const before = fileSha(path);
  const result = run(['--report'], { SQLITE_PATH: path });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /PXK-DB report mode=development\n/);
  assert.match(result.stdout, /PXK-DB report sqlite_path=SQLITE_PATH .*crm\.db\n/);
  assert.match(result.stdout, /class=LEGACY_EXACT S5/);
  assert.match(result.stdout, /verdict=legacy-current-adoptable/);
  assert.match(result.stdout, /table\.leads=rows=3 digest=[0-9a-f]{16}/);
  assert.doesNotMatch(result.stdout, /geheim-123|leads-name-1|users-email/);
  assert.equal(fileSha(path), before);
  const check = openDatabase(path, 'inspect');
  assert.equal(check.pragma('user_version', { simple: true }), 0);
  assert.equal(ledgerRows(check), null);
  check.close();

  const absent = run(['--report'], { SQLITE_PATH: join(dir, 'fehlt.db'), NODE_ENV: 'production' });
  assert.equal(absent.status, 0);
  assert.match(absent.stdout, /PXK-DB report mode=production\n/);
  assert.match(absent.stdout, /verdict=absent/);
  assert.equal(existsSync(join(dir, 'fehlt.db')), false);
});

test('--check: Exit ≠ 0 bei unbekanntem Schema', () => {
  const path = join(tempDir(), 'crm.db');
  const db = buildLegacy(path, 'S5');
  db.exec('CREATE TABLE fremd (x)');
  db.close();
  const report = run(['--report'], { SQLITE_PATH: path });
  assert.equal(report.status, 0);
  assert.match(report.stdout, /verdict=unknown-schema/);
  assert.match(report.stdout, /difference=zusätzliche Tabelle: fremd/);
  const check = run(['--check'], { SQLITE_PATH: path });
  assert.equal(check.status, 12);
});

test('drei gleichzeitige Läufe auf derselben frischen Datei: genau einer migriert', async () => {
  const path = join(tempDir(), 'crm.db');
  const results = await Promise.all([1, 2, 3].map(() => spawnRun(['--no-seed'], { SQLITE_PATH: path })));
  for (const r of results) assert.equal(r.status, 0, r.err);
  assert.equal(results.filter(r => r.out.includes('applied 0001_baseline')).length, 1);
  const db = openDatabase(path, 'app');
  assert.equal(ledgerRows(db).length, 1);
  db.close();
});

test('drei gleichzeitige Läufe auf einem Altstand: genau eine Übernahme, jede Sicherung eigen und geprüft', async () => {
  const dir = tempDir();
  const path = join(dir, 'crm.db');
  const db = buildLegacy(path, 'S5');
  insertSyntheticRows(db, 50);
  db.close();
  const backups = join(dir, 'backups');
  const results = await Promise.all([1, 2, 3].map(() => spawnRun(['--no-seed'], { SQLITE_PATH: path, NODE_ENV: 'production', PXK_DB_BACKUP_DIR: backups })));
  for (const r of results) assert.equal(r.status, 0, r.err);
  assert.equal(results.filter(r => r.out.includes('baselined 0001_baseline (S5)')).length, 1);
  // Wer vor der Übernahme eingeordnet hat, sichert vorher — jede Sicherung in eine eigene Datei.
  const files = readdirSync(backups);
  const announced = results.filter(r => /PXK-DB Sicherung /.test(r.out)).length;
  assert.ok(announced >= 1);
  assert.equal(files.filter(f => /^pre-0001_baseline-.*\.db$/.test(f)).length, announced, files.join(', '));
  assert.deepEqual(files.filter(f => !f.endsWith('.db')), [], 'keine ungeprüften oder WAL-Reste');
  const check = openDatabase(path, 'inspect');
  assert.equal(ledgerRows(check).length, 1);
  check.close();
});

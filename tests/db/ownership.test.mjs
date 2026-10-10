/**
 * D9 (PXK-113): Schema-Hoheit und Rückweg.
 *
 * - Schema-Hoheit: Schema entsteht nur aus db/migrations; im Quelltext steht
 *   außer dem Ledger des Runners kein DDL; Drizzle ist vollständig entfernt (D1);
 *   die Baseline ist bytegleich zu Release A.
 * - Rückweg ohne Wiederherstellung: Der Start des Vorgänger-Codes (cd2c098 bzw.
 *   Release A: CREATE … IF NOT EXISTS, migrateColumns) ändert eine von B2
 *   übernommene Datenbank nicht; B2 startet danach wieder als No-op.
 * - Rückweg mit Wiederherstellung: Die geprüfte Sicherung von B2 ist exakt der
 *   Altstand davor und wird nach dem Zurückspielen erneut übernommen.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { contentDigest, fingerprint, sameFingerprint, tableColumns } from '../../lib/db/fingerprint.mjs';
import { LEDGER_DDL, classify, loadMigrations } from '../../lib/db/migrate.mjs';
import { openDatabase } from '../../lib/db/open.mjs';
import { splitStatements } from '../../lib/db/sql-split.mjs';
import { DDL_PATTERN, runAppScript, stringLiterals } from './app-modules.mjs';
import { MIGRATIONS_DIR, ROOT, buildLegacy, insertSyntheticRows, ledgerRows, tempDir } from './helpers.mjs';

/** sha256 von db/migrations/0001_baseline.sql auf Release A (main@480e09a1). */
const BASELINE_FILE_SHA256 = '4aa740df3d436180cf32d97aecce6c2abebad46c38023010e2dd7a92746c0bd3';
const SOURCE_ROOTS = ['app', 'lib', 'scripts', 'preview', 'middleware.ts', 'next.config.ts', 'vite.config.ts'];

function sourceFiles() {
  const files = [];
  const walk = (path) => {
    if (statSync(path).isDirectory()) for (const entry of readdirSync(path)) walk(join(path, entry));
    else if (/\.(ts|tsx|mjs|js)$/.test(path)) files.push(relative(ROOT, path));
  };
  for (const root of SOURCE_ROOTS) if (existsSync(join(ROOT, root))) walk(join(ROOT, root));
  return files.sort();
}

test('Schema-Hoheit: außer dem Ledger des Runners steht in App, lib, scripts und preview kein DDL', () => {
  const files = sourceFiles();
  assert.ok(files.length > 50, `zu wenige Dateien gefunden (${files.length})`);
  const hits = files.flatMap(file => stringLiterals(file).filter(text => DDL_PATTERN.test(text)).map(text => `${file}: ${text}`));
  assert.deepEqual(hits, [`lib/db/migrate.mjs: ${LEDGER_DDL}`]);
});

test('Schema-Hoheit: db/migrations ist die einzige Schemaquelle; 0001_baseline.sql ist bytegleich zu Release A', () => {
  const baseline = readFileSync(join(MIGRATIONS_DIR, '0001_baseline.sql'));
  assert.equal(createHash('sha256').update(baseline).digest('hex'), BASELINE_FILE_SHA256);
  assert.deepEqual(loadMigrations(MIGRATIONS_DIR).migrations.map(m => m.name), ['0001_baseline'], 'Release B bringt keine neue Migration');
  // Jede Schemaanweisung der Migrationen ist DDL — nichts anderes erzeugt Tabellen.
  for (const statement of splitStatements(baseline.toString('utf8'))) assert.match(statement.sql, DDL_PATTERN);
});

test('D1: Drizzle vollständig entfernt — keine Dateien, Abhängigkeiten, Skripte, Lock-Einträge oder Importe', () => {
  for (const path of ['db/schema.ts', 'drizzle.config.ts', 'drizzle']) assert.equal(existsSync(join(ROOT, path)), false, path);
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  for (const section of ['dependencies', 'devDependencies', 'scripts']) {
    const hits = Object.entries(pkg[section] ?? {}).filter(([name, value]) => /drizzle/i.test(name) || /drizzle/i.test(String(value)));
    assert.deepEqual(hits, [], section);
  }
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
  assert.deepEqual(Object.keys(lock.packages).filter(name => /drizzle/i.test(name)), []);
  const imports = sourceFiles().filter(file => /from\s+['"]drizzle|require\(\s*['"]drizzle/.test(readFileSync(join(ROOT, file), 'utf8')));
  assert.deepEqual(imports, []);
});

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
function snapshot(path) {
  const db = openDatabase(path, 'inspect');
  try {
    return { schema: fingerprint(db).hashes, objects: db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all(), ledger: ledgerRows(db), userVersion: db.pragma('user_version', { simple: true }), digest: contentDigest(db) };
  } finally {
    db.close();
  }
}

/** Der Start des Vorgänger-Codes (cd2c098, auch Release A): Boot-DDL wie damals, Spalten nur wenn sie fehlen. */
function previousReleaseBoot(path) {
  const statements = splitStatements(readFileSync(join(ROOT, 'tests/db/fixtures/legacy-cd2c098.sql'), 'utf8')).map(s => s.sql);
  const db = openDatabase(path, 'apply');
  try {
    for (const sql of statements) {
      const column = /^ALTER TABLE (\w+) ADD COLUMN (\w+)/i.exec(sql);
      if (column && tableColumns(db)[column[1]]?.includes(column[2])) continue;
      db.exec(sql);
    }
  } finally {
    db.close();
  }
}

/** Produktionsähnlicher Altstand S5 mit Daten, von B2 in Produktion übernommen. */
function adoptedByB2() {
  const dir = project();
  const path = join(dir, 'crm.db');
  const legacy = buildLegacy(path, 'S5');
  insertSyntheticRows(legacy, 6);
  legacy.close();
  const before = snapshot(path);
  const backups = join(tempDir(), 'sicherungen');
  const env = { SQLITE_PATH: path, RAILWAY_ENVIRONMENT_NAME: 'production', PXK_DB_BACKUP_DIR: backups };
  const result = cli(dir, env, ['--no-seed']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /baselined 0001_baseline \(S5\)/);
  return { dir, path, env, before, backups };
}

test('Rückweg ohne Wiederherstellung: Vorgänger-Start auf einer von B2 übernommenen Datenbank ändert nichts; B2 startet danach als No-op', () => {
  const { dir, path, env, before } = adoptedByB2();
  const adopted = snapshot(path);
  assert.deepEqual(adopted.digest, before.digest, 'Übernahme: Geschäftsdaten unverändert (contentDigest ohne Ledger)');
  assert.deepEqual(adopted.ledger, [{ version: 1, name: '0001_baseline', kind: 'baselined', legacy_variant: 'S5' }], 'nur Metadaten');
  previousReleaseBoot(path);
  assert.deepEqual(snapshot(path), adopted, 'Boot-DDL des Vorgängers ist auf dem übernommenen Schema ein No-op');
  const again = cli(dir, env, ['--no-seed']);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /PXK-DB ok head=1 noop/);
  assert.deepEqual(snapshot(path), adopted);
  assert.equal(runAppScript({ cwd: dir, env: { SQLITE_PATH: path }, body: 'await app.ensureDatabase(); return true;' }).value, true);
  // Auch der Release-A-Bericht (dessen start-Präfix) liest die übernommene Datenbank als aktuell.
  const report = cli(dir, { SQLITE_PATH: path }, ['--report']);
  assert.equal(report.status, 0);
  assert.match(report.stdout, /PXK-DB report verdict=migrated-current/);
});

test('Rückweg mit Wiederherstellung: die geprüfte Sicherung ist exakt der Altstand davor (S5) und wird nach dem Zurückspielen erneut übernommen', async () => {
  const { dir, path, before, backups } = adoptedByB2();
  const [file] = readdirSync(backups).filter(f => /^pre-0001_baseline-.*\.db$/.test(f));
  assert.ok(file, readdirSync(backups).join(', '));
  // Zurückspielen über die SQLite-Backup-API in eine neue Datei (nie neben alte -wal/-shm legen).
  const restoredPath = join(tempDir(), 'zurueck.db');
  const backup = new Database(join(backups, file), { readonly: true, fileMustExist: true });
  await backup.backup(restoredPath);
  backup.close();
  const restored = snapshot(restoredPath);
  assert.equal(restored.ledger, null, 'kein Ledger: Stand vor B2');
  assert.equal(restored.userVersion, 0);
  assert.deepEqual(restored.digest, before.digest);
  assert.deepEqual(restored.objects, before.objects);
  const check = openDatabase(restoredPath, 'inspect');
  const set = loadMigrations(MIGRATIONS_DIR);
  assert.deepEqual(classify(check, set), { kind: 'LEGACY_EXACT', variant: 'S5' });
  check.close();
  // Der Vorgänger-Code startet darauf unverändert, B2 übernimmt erneut nur per Metadaten.
  previousReleaseBoot(restoredPath);
  assert.deepEqual(snapshot(restoredPath).digest, before.digest);
  const readopt = cli(dir, { SQLITE_PATH: restoredPath, NODE_ENV: 'production', PXK_DB_BACKUP_DIR: join(tempDir(), 'b2') }, ['--no-seed']);
  assert.equal(readopt.status, 0, readopt.stderr);
  assert.match(readopt.stdout, /baselined 0001_baseline \(S5\)/);
  const after = snapshot(restoredPath);
  assert.ok(sameFingerprint({ hashes: after.schema }, { hashes: snapshot(path).schema }), 'gleiches Schema wie die erste Übernahme');
  assert.deepEqual(after.digest, before.digest, 'Geschäftsdaten unverändert (contentDigest ohne Ledger)');
  assert.deepEqual(after.ledger, [{ version: 1, name: '0001_baseline', kind: 'baselined', legacy_variant: 'S5' }]);
});

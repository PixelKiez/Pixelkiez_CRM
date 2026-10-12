import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { classifyEnvironment } from '../../lib/db/environment.mjs';
import { runMigrations } from '../../lib/db/migrate.mjs';
import { MIGRATIONS_DIR, ROOT, buildLegacy, errorCode, future, insertSyntheticRows, ledgerRows, migrationsCopy, tempDir } from './helpers.mjs';

const CLI = join(ROOT, 'scripts/db-migrate.mjs');
const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
const run = (args, env, cwd = ROOT) => spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...baseEnv, ...env }, encoding: 'utf8' });
const RAILWAY_ONLY = { RAILWAY_ENVIRONMENT_NAME: 'production' };

test('Einordnung: jedes Produktionssignal genügt', () => {
  assert.deepEqual(classifyEnvironment({ NODE_ENV: 'production' }), { production: true, mode: 'production', reasons: ['NODE_ENV=production'] });
  assert.deepEqual(classifyEnvironment({ RAILWAY_ENVIRONMENT_NAME: 'production' }), { production: true, mode: 'production', reasons: ['RAILWAY_ENVIRONMENT_NAME=production'] });
  assert.deepEqual(classifyEnvironment({ NODE_ENV: 'production', RAILWAY_ENVIRONMENT_NAME: 'production' }).reasons, ['NODE_ENV=production', 'RAILWAY_ENVIRONMENT_NAME=production']);
  assert.equal(classifyEnvironment({ RAILWAY_ENVIRONMENT: 'production' }).production, true, 'älterer Variablenname');
});

test('Einordnung: gewöhnliche Entwicklung (auch mit Railway-CLI-Zugangstoken in der Shell)', () => {
  for (const env of [{}, { NODE_ENV: '' }, { NODE_ENV: 'development' }, { NODE_ENV: 'test' }, { NODE_ENV: ' Development ' },
    { RAILWAY_TOKEN: 't' }, { RAILWAY_API_TOKEN: 't', NODE_ENV: 'development' }, { RAILWAY_PROJECT_ID: '  ', RAILWAY_ENVIRONMENT_NAME: '' }]) {
    assert.deepEqual(classifyEnvironment(env), { production: false, mode: 'development', reasons: ['kein-Produktionssignal'] }, JSON.stringify(env));
  }
});

test('Einordnung: Widersprüche und verdächtige Railway-Kontexte enden bei Produktion', () => {
  const cases = [
    [{ NODE_ENV: 'development', RAILWAY_ENVIRONMENT_NAME: 'production' }, ['RAILWAY_ENVIRONMENT_NAME=production', 'NODE_ENV=development(überstimmt)']],
    [{ RAILWAY_ENVIRONMENT_NAME: ' Production ' }, ['RAILWAY_ENVIRONMENT_NAME=production']],
    [{ NODE_ENV: 'PRODUCTION' }, ['NODE_ENV=production']],
    [{ NODE_ENV: 'prod' }, ['NODE_ENV=prod(unbekannt)']],
    [{ RAILWAY_ENVIRONMENT_NAME: 'pr-12' }, ['RAILWAY_ENVIRONMENT_NAME=pr-12(Railway)']],
    [{ RAILWAY_ENVIRONMENT_NAME: '', RAILWAY_PROJECT_ID: 'p-1' }, ['RAILWAY_PROJECT_ID(Railway-ohne-Umgebungsnamen)']],
    [{ NODE_ENV: 'test', RAILWAY_SERVICE_ID: 's-1' }, ['RAILWAY_SERVICE_ID(Railway-ohne-Umgebungsnamen)', 'NODE_ENV=test(überstimmt)']],
    // ein leerer neuer Name verdeckt das ältere RAILWAY_ENVIRONMENT nicht
    [{ RAILWAY_ENVIRONMENT_NAME: '', RAILWAY_ENVIRONMENT: 'production' }, ['RAILWAY_ENVIRONMENT=production']],
    [{ RAILWAY_ENVIRONMENT_NAME: ' ', RAILWAY_ENVIRONMENT: 'Production', NODE_ENV: 'development' }, ['RAILWAY_ENVIRONMENT=production', 'NODE_ENV=development(überstimmt)']],
    // jede andere nicht leere RAILWAY_*-Variable ist Railway-Kontext; ausgegeben wird nur der Name
    [{ RAILWAY_REPLICA_ID: 'r-geheim' }, ['RAILWAY_REPLICA_ID(Railway-ohne-Umgebungsnamen)']],
    [{ RAILWAY_VOLUME_MOUNT_PATH: '/app/data' }, ['RAILWAY_VOLUME_MOUNT_PATH(Railway-ohne-Umgebungsnamen)']],
    [{ RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app', RAILWAY_TOKEN: 't' }, ['RAILWAY_PUBLIC_DOMAIN(Railway-ohne-Umgebungsnamen)']],
  ];
  for (const [env, reasons] of cases) {
    assert.deepEqual(classifyEnvironment(env), { production: true, mode: 'production', reasons }, JSON.stringify(env));
  }
});

test('Einordnung: ausgegebene Werte sind gekürzt und ohne Sonderzeichen', () => {
  const { reasons } = classifyEnvironment({ NODE_ENV: 'x y;$(id)'.repeat(10) });
  assert.match(reasons[0], /^NODE_ENV=[A-Za-z0-9_.?-]{1,32}\(unbekannt\)$/);
});

test('Runner ohne ausdrückliche Angabe übernimmt die Einordnung der Umgebung (nur Railway-Signal)', async () => {
  const dir = tempDir();
  const db = buildLegacy(join(dir, 'crm.db'), 'S5');
  insertSyntheticRows(db);
  process.env.RAILWAY_ENVIRONMENT_NAME = 'production';
  try {
    const error = await errorCode(() => runMigrations(db, { migrationsDir: MIGRATIONS_DIR, backup: false }));
    assert.equal(error?.code, 'BACKUP_DESTINATION_REQUIRED');
    assert.equal(ledgerRows(db), null);
  } finally {
    delete process.env.RAILWAY_ENVIRONMENT_NAME;
  }
  db.close();
});

test('CLI nur mit RAILWAY_ENVIRONMENT_NAME=production: fehlende Datei → Exit 12, nichts angelegt', () => {
  const path = join(tempDir(), 'crm.db');
  const result = run([], { ...RAILWAY_ONLY, SQLITE_PATH: path });
  assert.equal(result.status, 12, result.stderr);
  assert.match(result.stdout, /PXK-DB mode=production sqlite_path=SQLITE_PATH .* mode_reason=RAILWAY_ENVIRONMENT_NAME=production\n/);
  assert.match(result.stderr, /FRESH_DB_IN_PRODUCTION/);
  assert.equal(existsSync(path), false);
});

test('CLI nur mit RAILWAY_ENVIRONMENT_NAME=production: Übernahme ohne Sicherungsziel → Exit 15, Migrationsordner fest', () => {
  const dir = tempDir();
  const path = join(dir, 'crm.db');
  const db = buildLegacy(path, 'S5');
  insertSyntheticRows(db);
  db.close();
  const extra = migrationsCopy({ [`${future(1, 'extra')}.sql`]: 'CREATE TABLE extra2 (x);\n' });
  const refused = run([], { ...RAILWAY_ONLY, SQLITE_PATH: path, PXK_MIGRATIONS_DIR: extra });
  assert.equal(refused.status, 15, refused.stderr);
  assert.match(refused.stderr, /abweichender Migrationsordner wird in Produktion ignoriert/);
  assert.match(refused.stderr, /BACKUP_DESTINATION_REQUIRED/);
  assert.equal(existsSync(join(dir, 'backups')), false, 'kein stiller Standard-Sicherungsordner');
});

test('NODE_ENV=development überstimmt das Railway-Signal nicht', () => {
  const path = join(tempDir(), 'crm.db');
  const result = run([], { NODE_ENV: 'development', ...RAILWAY_ONLY, SQLITE_PATH: path });
  assert.equal(result.status, 12, result.stderr);
  assert.match(result.stdout, /mode_reason=RAILWAY_ENVIRONMENT_NAME=production,NODE_ENV=development\(überstimmt\)/);
  assert.equal(existsSync(path), false);
});

test('Bericht zeigt die Einordnung ohne Werte anderer Variablen', () => {
  const result = run(['--report'], { ...RAILWAY_ONLY, SQLITE_PATH: join(tempDir(), 'fehlt.db'), AUTH_SECRET: 'geheim-xyz' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /PXK-DB report mode=production\nPXK-DB report mode_reason=RAILWAY_ENVIRONMENT_NAME=production\n/);
  assert.doesNotMatch(result.stdout + result.stderr, /geheim-xyz/);
  const dev = run(['--report'], { SQLITE_PATH: join(tempDir(), 'fehlt.db') });
  assert.match(dev.stdout, /PXK-DB report mode=development\nPXK-DB report mode_reason=kein-Produktionssignal\n/);
});

test('.env-Auswahl folgt derselben Einordnung (Railway-Signal → .env.production)', () => {
  const cwd = tempDir();
  writeFileSync(join(cwd, '.env.production'), `SQLITE_PATH=${join(cwd, 'aus-production.db')}\n`);
  writeFileSync(join(cwd, '.env.development'), `SQLITE_PATH=${join(cwd, 'aus-development.db')}\n`);
  const result = run(['--report'], { ...RAILWAY_ONLY, PXK_MIGRATIONS_DIR: MIGRATIONS_DIR }, cwd);
  assert.match(result.stdout, /sqlite_path=SQLITE_PATH .*aus-production\.db/);
  const dev = run(['--report'], { PXK_MIGRATIONS_DIR: MIGRATIONS_DIR }, cwd);
  assert.match(dev.stdout, /sqlite_path=SQLITE_PATH .*aus-development\.db/, 'ohne Produktionssignal .env.development');
});

test('Produktion: auch ein leerer abweichender Migrationsordner wird ignoriert', () => {
  const path = join(tempDir(), 'crm.db');
  buildLegacy(path, 'S5').close();
  const result = run(['--report'], { ...RAILWAY_ONLY, PXK_MIGRATIONS_DIR: '', SQLITE_PATH: path });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /abweichender Migrationsordner wird in Produktion ignoriert/);
  assert.match(result.stdout, /migration_files=\d+ \(letzte \d{4}_/, 'Standardordner geladen');
  assert.match(result.stdout, /verdict=legacy-current-adoptable/);
});

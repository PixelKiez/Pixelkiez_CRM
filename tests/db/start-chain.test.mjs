/**
 * Release B (PXK-113, D11): `npm start` ist `node scripts/db-migrate.mjs && next start`.
 *
 * Ausgeführt wird der echte Befehl aus package.json mit sh, im eigenen
 * Projektordner (db/migrations als Kopie, scripts/ als Symlink — in Produktion
 * zählt nur db/migrations unter dem Arbeitsverzeichnis). `next` ist ein Stub,
 * der nur einen Marker schreibt: So ist sichtbar, ob die App gestartet wäre.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { contentDigest, tableColumns } from '../../lib/db/fingerprint.mjs';
import { openDatabase } from '../../lib/db/open.mjs';
import { runAppScript } from './app-modules.mjs';
import { MIGRATIONS_DIR, ROOT, buildLegacy, insertSyntheticRows, ledgerRows, tempDir } from './helpers.mjs';

const START = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts.start;
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function project(migrations = {}) {
  const dir = tempDir();
  symlinkSync(join(ROOT, 'scripts'), join(dir, 'scripts'));
  mkdirSync(join(dir, 'db', 'migrations'), { recursive: true });
  copyFileSync(join(MIGRATIONS_DIR, '0001_baseline.sql'), join(dir, 'db', 'migrations', '0001_baseline.sql'));
  for (const [file, text] of Object.entries(migrations)) writeFileSync(join(dir, 'db', 'migrations', file), text);
  const bin = join(dir, '.bin');
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, 'node'));
  writeFileSync(join(bin, 'next'), '#!/bin/sh\necho "APP-START $*" >> "$PXK_TEST_MARKER"\n');
  chmodSync(join(bin, 'next'), 0o755);
  return dir;
}

/** `npm start` wie in Railway, nur ohne npm: derselbe Befehl, dieselbe Shell-Verknüpfung. */
function npmStart(dir, env) {
  const marker = join(dir, 'app-started');
  rmSync(marker, { force: true });
  const result = spawnSync('sh', ['-c', START], {
    cwd: dir,
    env: { PATH: `${join(dir, '.bin')}:/usr/bin:/bin`, HOME: process.env.HOME, PXK_TEST_MARKER: marker, ...env },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, started: existsSync(marker) };
}

const versions = (path) => {
  const db = openDatabase(path, 'inspect');
  try {
    return ledgerRows(db)?.map(r => `${r.version} ${r.name} ${r.kind}${r.legacy_variant ? ` ${r.legacy_variant}` : ''}`) ?? null;
  } finally {
    db.close();
  }
};
const business = (path) => {
  const db = openDatabase(path, 'inspect');
  try {
    return { digest: contentDigest(db), columns: tableColumns(db) };
  } finally {
    db.close();
  }
};

test('D11: npm start ist Migration && next start — ohne --report-Präfix und ohne ;', () => {
  assert.equal(START, 'node scripts/db-migrate.mjs && next start');
});

test('npm start: frische Datenbank → Migration und Seeds, dann App; zweiter Start ist ein No-op ohne Schreibzugriff', () => {
  const dir = project();
  const path = join(dir, 'data', 'crm.db');
  const first = npmStart(dir, { SQLITE_PATH: path });
  assert.equal(first.status, 0, first.stderr);
  assert.ok(first.started, 'App startet nach erfolgreicher Migration');
  assert.match(first.stdout, /PXK-DB applied 0001_baseline/);
  assert.match(first.stdout, /PXK-DB ok head=1 applied 0001_baseline seeds=8\/952/);
  assert.equal(runAppScript({ cwd: dir, env: { SQLITE_PATH: path }, body: 'await app.ensureDatabase(); return true;' }).value, true);

  const before = sha(path);
  const second = npmStart(dir, { SQLITE_PATH: path });
  assert.equal(second.status, 0, second.stderr);
  assert.ok(second.started);
  assert.match(second.stdout, /PXK-DB ok head=1 noop seeds=0\/0/);
  assert.equal(sha(path), before, 'zweiter Start schreibt nichts');
});

test('AC4 Ende-zu-Ende in Produktion: defekte Migration → Rollback, Exit 13, App startet nicht — auch nicht beim Neustart; die App selbst verweigert', () => {
  // Scheitert erst auf echten Daten (doppelter Name), nach einer ersten Anweisung — der Probelauf auf leerem Schema besteht.
  const dir = project({ '0002_unique_name.sql': 'ALTER TABLE leads ADD COLUMN district TEXT;\nCREATE UNIQUE INDEX idx_leads_name_unique ON leads(name);\n' });
  const path = join(tempDir(), 'crm.db');
  const legacy = buildLegacy(path, 'S5');
  insertSyntheticRows(legacy);
  legacy.prepare("INSERT INTO leads (id, name, updated_at) VALUES ('PK-D1', 'Doppelt', '2026-10-04T00:00:00.000Z'), ('PK-D2', 'Doppelt', '2026-10-04T00:00:00.000Z')").run();
  legacy.close();
  const before = business(path);
  const backups = join(tempDir(), 'backups');
  const env = { SQLITE_PATH: path, RAILWAY_ENVIRONMENT_NAME: 'production', PXK_DB_BACKUP_DIR: backups };

  for (const [index, attempt] of ['Start', 'Neustart'].entries()) {
    const result = npmStart(dir, env);
    assert.equal(result.status, 13, `${attempt}: ${result.stderr}`);
    assert.match(result.stderr, /PXK-DB \[MIGRATION_FAILED\] 0002_unique_name: Anweisung 2: UNIQUE constraint failed/, attempt);
    assert.equal(result.started, false, `${attempt}: App darf nicht starten`);
    // Je Migration eine Transaktion: die Übernahme der Baseline bleibt, 0002 ist vollständig zurückgerollt.
    assert.deepEqual(versions(path), ['1 0001_baseline baselined S5'], attempt);
    assert.deepEqual(business(path), before, `${attempt}: keine Spalte district, Geschäftsdaten unverändert`);
    // Die geprüfte Sicherung jedes Versuchs liegt abgelegt im Ziel — obwohl die Migration danach scheiterte.
    const published = readdirSync(backups).filter(f => /^pre-.*\.db$/.test(f)).sort();
    assert.equal(published.length, index + 1, `${attempt}: ${published.join(', ')}`);
    assert.deepEqual(readdirSync(backups).filter(f => f.startsWith('.partial-')), [], `${attempt}: kein Arbeitsordner bleibt`);
    const newest = published.find(f => f.startsWith(index === 0 ? 'pre-0001_baseline-' : 'pre-0002_unique_name-'));
    assert.ok(newest, `${attempt}: ${published.join(', ')}`);
    assert.deepEqual(business(join(backups, newest)), before, `${attempt}: Sicherung = Stand davor`);
  }
  const bypass = runAppScript({ cwd: dir, env: { SQLITE_PATH: path }, body: 'await app.ensureDatabase(); return true;' });
  assert.equal(bypass.error?.code, 'MIGRATIONS_PENDING', 'auch next start ohne Migrationsschritt bedient keine Anfrage');
});

test('fehlende Migrationsdatei → Start verweigert (neueste: Exit 11, mittlere: Exit 10), App startet nicht', () => {
  const dir = project({ '0002_alpha.sql': 'CREATE TABLE alpha (x TEXT);\n', '0003_beta.sql': 'CREATE TABLE beta (x TEXT);\n' });
  const path = join(dir, 'data', 'crm.db');
  assert.equal(npmStart(dir, { SQLITE_PATH: path }).status, 0);
  const migrations = join(dir, 'db', 'migrations');

  renameSync(join(migrations, '0003_beta.sql'), join(dir, '0003_beta.sql.weg'));
  const newest = npmStart(dir, { SQLITE_PATH: path });
  assert.equal(newest.status, 11, newest.stderr);
  assert.match(newest.stderr, /\[LEDGER_AHEAD_OF_FILES\]/);
  assert.equal(newest.started, false);
  renameSync(join(dir, '0003_beta.sql.weg'), join(migrations, '0003_beta.sql'));

  renameSync(join(migrations, '0002_alpha.sql'), join(dir, '0002_alpha.sql.weg'));
  const middle = npmStart(dir, { SQLITE_PATH: path });
  assert.equal(middle.status, 10, middle.stderr);
  assert.match(middle.stderr, /\[VERSION_GAP\]/);
  assert.equal(middle.started, false);
  assert.deepEqual(versions(path), ['1 0001_baseline applied', '2 0002_alpha applied', '3 0003_beta applied']);
});

test('umsortierte Migrationen → Start verweigert (RENAMED_OR_REORDERED, Exit 11), App startet nicht', () => {
  const dir = project({ '0002_alpha.sql': 'CREATE TABLE alpha (x TEXT);\n', '0003_beta.sql': 'CREATE TABLE beta (x TEXT);\n' });
  const path = join(dir, 'data', 'crm.db');
  assert.equal(npmStart(dir, { SQLITE_PATH: path }).status, 0);
  const migrations = join(dir, 'db', 'migrations');
  renameSync(join(migrations, '0002_alpha.sql'), join(migrations, '0003_alpha.sql.tmp'));
  renameSync(join(migrations, '0003_beta.sql'), join(migrations, '0002_beta.sql'));
  renameSync(join(migrations, '0003_alpha.sql.tmp'), join(migrations, '0003_alpha.sql'));
  const result = npmStart(dir, { SQLITE_PATH: path });
  assert.equal(result.status, 11, result.stderr);
  assert.match(result.stderr, /\[RENAMED_OR_REORDERED\] 0002_alpha/);
  assert.equal(result.started, false);
});

test('beschädigte oder fremde Datei → UNKNOWN_SCHEMA (Exit 12) mit klarem Grund statt internem Fehler; Datei unverändert, App startet nicht', () => {
  const files = {
    fremd: Buffer.alloc(4096, 0x5a),
    'nur-kopf': Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.from([0x10, 0x00, 0x02, 0x02]), Buffer.alloc(80)]),
  };
  for (const [name, bytes] of Object.entries(files)) {
    for (const production of [false, true]) {
      const dir = project();
      const path = join(dir, `${name}.db`);
      writeFileSync(path, bytes);
      const env = { SQLITE_PATH: path, ...(production ? { NODE_ENV: 'production', PXK_DB_BACKUP_DIR: join(dir, 'backups') } : {}) };
      const result = npmStart(dir, env);
      const label = `${name} ${production ? 'Produktion' : 'Entwicklung'}`;
      assert.equal(result.status, 12, `${label}: ${result.stderr}`);
      assert.match(result.stderr, /^PXK-DB \[UNKNOWN_SCHEMA\] .*: keine lesbare SQLite-Datenbank \(SQLITE_(NOTADB|CORRUPT)/m, label);
      assert.doesNotMatch(result.stderr, /INTERNAL|\n\s+at /, `${label}: kein Stacktrace`);
      assert.equal(result.started, false, label);
      assert.equal(sha(path), createHash('sha256').update(bytes).digest('hex'), `${label}: Datei unverändert`);
      assert.equal(existsSync(join(dir, 'backups')), false, `${label}: keine Sicherung angelegt`);
    }
  }
});

test('D7: Node-Version als erste Zeile des Starts, keine Werte aus der Umgebung', () => {
  const dir = project();
  const path = join(dir, 'data', 'crm.db');
  const secrets = { AUTH_SECRET: 'geheim-auth-7f3a', AUTH_USERS: 'chef@example.invalid:geheim-pass-91c2', PXK_AGENT_TOKEN: 'geheim-token-55d0' };
  const result = npmStart(dir, { SQLITE_PATH: path, ...secrets });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.split('\n')[0], `PXK-DB runtime node=${process.version}`);
  for (const value of Object.values(secrets)) {
    assert.equal(`${result.stdout}${result.stderr}`.includes(value), false, 'kein Geheimnis in der Ausgabe');
  }
});

test('leere Hauptdatei mit nicht leerem -wal (unvollständige Kopie) → UNKNOWN_SCHEMA (Exit 12) ohne Öffnen; das -wal bleibt, App startet nicht', () => {
  for (const env of [{}, { NODE_ENV: 'production', PXK_DB_ALLOW_FRESH: '1', PXK_DB_BACKUP_DIR: join(tempDir(), 'b') }]) {
    const dir = project();
    const path = join(dir, 'crm.db');
    const writer = new Database(join(dir, 'schreiber.db'));
    writer.pragma('journal_mode = WAL');
    writer.pragma('wal_autocheckpoint = 0');
    writer.exec("CREATE TABLE t (a); INSERT INTO t VALUES ('nur im WAL')");
    copyFileSync(join(dir, 'schreiber.db-wal'), `${path}-wal`);
    writer.close();
    writeFileSync(path, '');
    const wal = sha(`${path}-wal`);
    const result = npmStart(dir, { SQLITE_PATH: path, ...env });
    const label = env.NODE_ENV ?? 'development';
    assert.equal(result.status, 12, `${label}: ${result.stderr}`);
    assert.match(result.stderr, /\[UNKNOWN_SCHEMA\] .*Hauptdatei ist leer, daneben liegt ein nicht leeres -wal/, label);
    assert.equal(result.started, false, label);
    assert.equal(sha(`${path}-wal`), wal, `${label}: -wal unverändert`);
    assert.equal(readFileSync(path).length, 0, `${label}: Hauptdatei unverändert`);
  }
});

/** Nicht leeres -wal neben fehlender oder leerer Hauptdatei (unvollständige Kopie oder Wiederherstellung). */
function orphanedWal(dir, path, { mainFile }) {
  const writer = new Database(join(dir, 'schreiber.db'));
  writer.pragma('journal_mode = WAL');
  writer.pragma('wal_autocheckpoint = 0');
  writer.exec("CREATE TABLE t (a); INSERT INTO t VALUES ('nur im WAL')");
  copyFileSync(join(dir, 'schreiber.db-wal'), `${path}-wal`);
  writer.close();
  if (mainFile) writeFileSync(path, '');
  return sha(`${path}-wal`);
}

test('fehlende Hauptdatei mit nicht leerem -wal → UNKNOWN_SCHEMA (Exit 12) ohne Anlegen; das -wal bleibt — auch mit PXK_DB_ALLOW_FRESH=1', () => {
  for (const env of [{}, { NODE_ENV: 'production', PXK_DB_ALLOW_FRESH: '1', PXK_DB_BACKUP_DIR: join(tempDir(), 'b') }]) {
    const dir = project();
    const path = join(dir, 'crm.db');
    const wal = orphanedWal(dir, path, { mainFile: false });
    const result = npmStart(dir, { SQLITE_PATH: path, ...env });
    const label = env.NODE_ENV ?? 'development';
    assert.equal(result.status, 12, `${label}: ${result.stderr}`);
    assert.match(result.stderr, /\[UNKNOWN_SCHEMA\] .*Hauptdatei fehlt, daneben liegt ein nicht leeres -wal/, label);
    assert.equal(result.started, false, label);
    assert.equal(existsSync(path), false, `${label}: keine Hauptdatei angelegt`);
    assert.equal(sha(`${path}-wal`), wal, `${label}: -wal unverändert`);
  }
});

test('--report und --check öffnen eine verwaiste -wal-Lage nie: Bericht ohne Öffnen, --check mit Exit 12, das -wal bleibt', () => {
  for (const mainFile of [true, false]) {
    const dir = project();
    const path = join(dir, 'crm.db');
    const wal = orphanedWal(dir, path, { mainFile });
    for (const [flag, status] of [['--report', 0], ['--check', 12]]) {
      const result = spawnSync(process.execPath, ['scripts/db-migrate.mjs', flag], {
        cwd: dir,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, SQLITE_PATH: path },
        encoding: 'utf8',
      });
      const label = `${flag} ${mainFile ? 'leer' : 'fehlt'}`;
      assert.equal(result.status, status, `${label}: ${result.stderr}`);
      assert.match(result.stdout, /PXK-DB report verdict=orphaned-wal/, label);
      assert.equal(sha(`${path}-wal`), wal, `${label}: -wal unverändert`);
      assert.equal(existsSync(path), mainFile, `${label}: Hauptdatei weder angelegt noch entfernt`);
    }
  }
});

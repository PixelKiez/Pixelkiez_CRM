/**
 * Migrationen nach der Baseline (0002 ff.) auf einer bereits
 * migrationsverwalteten Datenbank — der Normalfall nach Release B.
 *
 * Vertrag, den diese Tests festhalten:
 * - Vor dem ersten Schreibzugriff eines Laufs steht in Produktion eine
 *   geprüfte Sicherung; ohne Sicherungsziel oder bei gescheiterter Prüfung
 *   wird keine Migration ausgeführt.
 * - Eine Migration = eine Transaktion. Ein Lauf mit mehreren ausstehenden
 *   Migrationen ist als Ganzes NICHT atomar: Migrationen vor der scheiternden
 *   bleiben festgeschrieben, die scheiternde wird vollständig zurückgerollt
 *   (Schema, Daten und Ledger-Zeile gemeinsam), der Lauf endet mit Exit 13.
 *   Ab Release B startet die App dann nicht (&& in package.json, und der
 *   Request-Pfad meldet MIGRATIONS_PENDING); Release A startet weiterhin.
 *   Ein erneuter Lauf scheitert an derselben Stelle, bis die Datei korrigiert
 *   ist. Zurück auf den Stand vor dem Lauf geht es nur über die Sicherung,
 *   die vor der ersten Migration des Laufs angelegt wurde.
 * - Statisch erkennbare Fehler fängt der Probelauf über ALLE ausstehenden
 *   Migrationen ab, bevor irgendetwas festgeschrieben wird.
 *
 * „0002“/„0003“ in den Testnamen meinen die nächste bzw. übernächste Migration:
 * Die synthetischen Dateien tragen HEAD + 1 und HEAD + 2 des echten Satzes
 * (helpers.mjs future()), damit sie nie mit einer echten Migration kollidieren.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, copyFileSync, mkdirSync, openSync, readdirSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { contentDigest, fingerprint, sameFingerprint, tableColumns } from '../../lib/db/fingerprint.mjs';
import { runMigrations, verifyHead } from '../../lib/db/migrate.mjs';
import { openDatabase } from '../../lib/db/open.mjs';
import {
  HEAD, MIGRATIONS_DIR, REAL_MIGRATIONS, ROOT, errorCode, escapeRegExp, future, insertSyntheticRows, ledgerRows, migrationsCopy, realVersions, tempDir,
} from './helpers.mjs';

const DISTRICT = future(1, 'district');
const MIGRATION_0002 = [
  'ALTER TABLE leads ADD COLUMN district TEXT;',
  "UPDATE leads SET district = 'Reinickendorf';",
  'CREATE INDEX idx_leads_district ON leads(district);',
  '',
].join('\n');

/** Migrationsverwaltete Datenbank auf dem Kopf des echten Satzes mit synthetischen Geschäftsdaten. */
async function migratedAtHead() {
  const dir = tempDir();
  const db = openDatabase(join(dir, 'crm.db'), 'apply');
  await runMigrations(db, { migrationsDir: MIGRATIONS_DIR, production: false });
  insertSyntheticRows(db);
  return { dir, db };
}

const state = (db) => ({ ledger: ledgerRows(db), userVersion: db.pragma('user_version', { simple: true }), digest: contentDigest(db), fp: fingerprint(db) });
const versions = (db) => ledgerRows(db).map(r => `${r.version} ${r.name} ${r.kind}`);
const hasColumn = (db, table, column) => tableColumns(db)[table]?.includes(column) ?? false;

test('Produktion, 0002 ausstehend, kein Sicherungsziel → BACKUP_DESTINATION_REQUIRED, 0002 nicht ausgeführt', async () => {
  const { db } = await migratedAtHead();
  const before = state(db);
  const dir = migrationsCopy({ [`${DISTRICT}.sql`]: MIGRATION_0002 });
  for (const options of [{ production: true, backup: false }, { production: true }]) {
    const error = await errorCode(() => runMigrations(db, { migrationsDir: dir, ...options }));
    assert.equal(error?.code, 'BACKUP_DESTINATION_REQUIRED', JSON.stringify(options));
    assert.equal(error.exitCode, 15);
    assert.equal(hasColumn(db, 'leads', 'district'), false, '0002 nicht ausgeführt');
    assert.deepEqual(state(db).ledger, before.ledger, 'Ledger unverändert');
    assert.equal(state(db).userVersion, HEAD);
    assert.deepEqual(state(db).digest, before.digest, 'Geschäftsdaten unverändert');
    assert.ok(sameFingerprint(state(db).fp, before.fp), 'Schema unverändert');
  }
  assert.equal((await errorCode(() => verifyHead(db, { migrationsDir: dir })))?.code, 'MIGRATIONS_PENDING', 'App startet nicht auf halbem Stand');
  db.close();
});

test('Produktion, 0002 ausstehend, Sicherung scheitert an der Prüfung → BACKUP_FAILED, 0002 nicht ausgeführt', async () => {
  const { dir: home, db } = await migratedAtHead();
  const before = state(db);
  const dir = migrationsCopy({ [`${DISTRICT}.sql`]: MIGRATION_0002 });
  const corrupt = (path) => {
    const fd = openSync(path, 'r+');
    const count = Buffer.alloc(4);
    count.writeUInt32BE(5);
    writeSync(fd, count, 0, 4, 36);
    closeSync(fd);
  };
  const error = await errorCode(() => runMigrations(db, { migrationsDir: dir, production: true, backup: { dir: join(home, 'backups'), afterCopy: corrupt } }));
  assert.equal(error?.code, 'BACKUP_FAILED');
  assert.equal(hasColumn(db, 'leads', 'district'), false);
  assert.deepEqual(state(db).ledger, before.ledger);
  assert.deepEqual(state(db).digest, before.digest);
  assert.deepEqual(readdirSync(join(home, 'backups')).filter(n => n.endsWith('.db')), [], 'keine ungeprüfte Datei unter pre-*.db');
  db.close();
});

test('Produktion, 0002 ausstehend, gültiges Sicherungsziel → erst geprüfte Sicherung, dann 0002 mit Ledger-Eintrag', async () => {
  const { dir: home, db } = await migratedAtHead();
  const before = state(db);
  const dir = migrationsCopy({ [`${DISTRICT}.sql`]: MIGRATION_0002 });
  const log = [];
  const result = await runMigrations(db, { migrationsDir: dir, production: true, backup: { dir: join(home, 'backups') }, log: line => log.push(line) });

  // Reihenfolge: Sicherung vor der Migration, und die Sicherung zeigt den Stand davor
  assert.deepEqual(result.actions, [`applied ${DISTRICT}`]);
  const backupLine = log.findIndex(l => l.startsWith('PXK-DB Sicherung'));
  const appliedLine = log.findIndex(l => l === `PXK-DB applied ${DISTRICT}`);
  assert.ok(backupLine >= 0 && appliedLine > backupLine, log.join('\n'));
  assert.match(result.backup.path, new RegExp(`pre-${DISTRICT}-\\d{8}T\\d{6}Z-\\d+-[0-9a-f]{6}\\.db$`));
  const copy = new Database(result.backup.path, { readonly: true });
  assert.equal(copy.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(versions(copy), realVersions(), 'Sicherung auf dem Stand davor');
  assert.equal(hasColumn(copy, 'leads', 'district'), false);
  assert.deepEqual(contentDigest(copy), before.digest, 'Sicherung = Daten vor 0002');
  copy.close();

  // Ergebnis: 0002 im Ledger, erwartetes Schema, Daten wie von 0002 vorgesehen
  assert.deepEqual(versions(db), [...realVersions(), `${HEAD + 1} ${DISTRICT} applied`]);
  assert.equal(db.pragma('user_version', { simple: true }), HEAD + 1);
  assert.ok(hasColumn(db, 'leads', 'district'));
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_leads_district'").get());
  assert.deepEqual(db.prepare('SELECT DISTINCT district AS d FROM leads').all(), [{ d: 'Reinickendorf' }]);
  assert.deepEqual(verifyHead(db, { migrationsDir: dir }), { head: HEAD + 1 });
  assert.deepEqual((await runMigrations(db, { migrationsDir: dir, production: true, backup: { dir: join(home, 'backups') } })).actions, [], 'zweiter Lauf: No-op, inkl. Schema-Drift-Prüfung gegen alle Dateien');
  db.close();
});

/**
 * 0002 gelingt; 0003 schreibt erst Schema und Daten und scheitert dann an
 * echten Daten (UNIQUE über doppelte Werte) — der Probelauf auf leeren
 * Tabellen besteht.
 */
const SUCCESS = future(1, 'success');
const FAILURE = future(2, 'failure');
const PENDING = {
  [`${SUCCESS}.sql`]: 'CREATE TABLE notes2 (id INTEGER PRIMARY KEY, body TEXT);\nINSERT INTO notes2 (body) SELECT name FROM leads;\n',
  [`${FAILURE}.sql`]: [
    'CREATE TABLE half3 (x TEXT);',
    "INSERT INTO half3 VALUES ('y');",
    "UPDATE leads SET notes = 'VON-0003';",
    'ALTER TABLE leads ADD COLUMN flag3 TEXT;',
    'CREATE UNIQUE INDEX idx_status3 ON leads(status);',
    '',
  ].join('\n'),
};
const FIXED_0003 = "CREATE TABLE half3 (x TEXT);\nINSERT INTO half3 VALUES ('y');\nALTER TABLE leads ADD COLUMN flag3 TEXT;\nCREATE INDEX idx_status3 ON leads(status);\n";
const backupsWith = (dir, prefix) => readdirSync(dir).filter(n => n.endsWith('.db') && n.startsWith(prefix));

test('mehrere ausstehende Migrationen, spätere scheitert: 0002 festgeschrieben, 0003 vollständig zurückgerollt, Lauf scheitert', async () => {
  const { dir: home, db } = await migratedAtHead();
  db.prepare("UPDATE leads SET status = 'Neu'").run();
  const leads = db.prepare('SELECT count(*) AS c FROM leads').get().c;
  const businessBefore = contentDigest(db);
  const dir = migrationsCopy(PENDING);

  const error = await errorCode(() => runMigrations(db, { migrationsDir: dir, production: true, backup: { dir: join(home, 'backups') } }));
  assert.equal(error?.code, 'MIGRATION_FAILED');
  assert.equal(error.exitCode, 13);
  assert.match(error.message, new RegExp(`\\[MIGRATION_FAILED\\] ${FAILURE}: Anweisung 5: UNIQUE constraint failed`));

  const afterFirst = { ledger: versions(db), notes: db.prepare('SELECT count(*) AS c FROM notes2').get().c };
  assert.deepEqual(afterFirst.ledger, [...realVersions(), `${HEAD + 1} ${SUCCESS} applied`], '0002 hat seinen Eintrag, 0003 keinen');
  assert.equal(db.pragma('user_version', { simple: true }), HEAD + 1);
  assert.equal(afterFirst.notes, leads, '0002 vollständig');
  assert.equal(db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE name IN ('half3', 'idx_status3')").get().c, 0, 'nichts von 0003');
  assert.equal(hasColumn(db, 'leads', 'flag3'), false);
  const { notes2, ...business } = contentDigest(db);
  assert.ok(notes2);
  assert.deepEqual(business, businessBefore, 'bestehende Geschäftsdaten unverändert (auch das UPDATE aus 0003 ist zurückgerollt)');
  assert.equal((await errorCode(() => verifyHead(db, { migrationsDir: dir })))?.code, 'MIGRATIONS_PENDING', 'App startet nicht');
  const backups = join(home, 'backups');
  assert.deepEqual(readdirSync(backups).filter(n => n.endsWith('.db')).map(n => n.slice(0, `pre-${SUCCESS}-`.length)), [`pre-${SUCCESS}-`], 'eine Sicherung vor der ersten Migration des Laufs');

  // Auf dem neuen Stand (Kopf + 1) gilt die Sicherungsschranke genauso
  const noTarget = await errorCode(() => runMigrations(db, { migrationsDir: dir, production: true }));
  assert.equal(noTarget?.code, 'BACKUP_DESTINATION_REQUIRED');
  assert.deepEqual(versions(db), afterFirst.ledger);

  // Wiederholung: deterministisch dieselbe Stelle, 0002 läuft nicht erneut, neue Sicherung vor 0003
  const again = await errorCode(() => runMigrations(db, { migrationsDir: dir, production: true, backup: { dir: backups } }));
  assert.equal(again?.message, error.message);
  assert.deepEqual(versions(db), afterFirst.ledger);
  assert.equal(db.prepare('SELECT count(*) AS c FROM notes2').get().c, afterFirst.notes);
  assert.equal(backupsWith(backups, `pre-${FAILURE}-`).length, 1);

  // Korrigierte (noch nicht angewandte) 0003 läuft danach durch, 0002 bleibt unberührt
  writeFileSync(join(dir, `${FAILURE}.sql`), FIXED_0003);
  const fixed = await runMigrations(db, { migrationsDir: dir, production: true, backup: { dir: backups } });
  assert.deepEqual(fixed.actions, [`applied ${FAILURE}`]);
  assert.deepEqual(versions(db), [...realVersions(), `${HEAD + 1} ${SUCCESS} applied`, `${HEAD + 2} ${FAILURE} applied`]);
  assert.equal(db.prepare('SELECT count(*) AS c FROM notes2').get().c, afterFirst.notes);
  assert.deepEqual(db.prepare('SELECT x FROM half3').all(), [{ x: 'y' }]);
  assert.equal(backupsWith(backups, `pre-${FAILURE}-`).length, 2);
  assert.deepEqual(verifyHead(db, { migrationsDir: dir }), { head: HEAD + 2 });
  db.close();
});

test('mehrere ausstehende Migrationen, spätere statisch fehlerhaft: Probelauf verhindert auch 0002', async () => {
  const { db } = await migratedAtHead();
  const before = state(db);
  const dir = migrationsCopy({ [`${SUCCESS}.sql`]: PENDING[`${SUCCESS}.sql`], [`${FAILURE}.sql`]: 'CREATE TABLE half3 (x);\nINSERT INTO gibt_es_nicht VALUES (1);\n' });
  const error = await errorCode(() => runMigrations(db, { migrationsDir: dir, production: false }));
  assert.equal(error?.code, 'MIGRATION_FAILED');
  assert.match(error.message, new RegExp(`${FAILURE}: Probelauf: Anweisung 2`));
  assert.deepEqual(state(db).ledger, before.ledger, 'nichts festgeschrieben');
  assert.equal(db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE name IN ('notes2', 'half3')").get().c, 0);
  db.close();
});

test('CLI: spätere Migration scheitert → Exit 13 und der verknüpfte App-Start unterbleibt', () => {
  const dir = tempDir();
  const path = join(dir, 'crm.db');
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, SQLITE_PATH: path };
  const cli = `"${process.execPath}" "${join(ROOT, 'scripts/db-migrate.mjs')}"`;
  assert.equal(spawnSync('sh', ['-c', `${cli} --no-seed`], { cwd: ROOT, env, encoding: 'utf8' }).status, 0);
  const db = openDatabase(path, 'apply');
  insertSyntheticRows(db);
  db.prepare("UPDATE leads SET status = 'Neu'").run();
  db.close();
  const migrations = migrationsCopy(PENDING);
  // wie package.json ab Release B: "node scripts/db-migrate.mjs && next start"
  const result = spawnSync('sh', ['-c', `${cli} --no-seed && echo APP-START`], { cwd: ROOT, env: { ...env, PXK_MIGRATIONS_DIR: migrations }, encoding: 'utf8' });
  assert.equal(result.status, 13, result.stderr);
  assert.match(result.stdout, new RegExp(`PXK-DB applied ${SUCCESS}`));
  assert.match(result.stderr, new RegExp(`PXK-DB \\[MIGRATION_FAILED\\] ${FAILURE}: Anweisung 5`));
  assert.doesNotMatch(result.stdout, /APP-START/);
  const check = openDatabase(path, 'inspect');
  assert.deepEqual(versions(check), [...realVersions(), `${HEAD + 1} ${SUCCESS} applied`]);
  check.close();
});

test('Migration und Ledger-Zeile sind eine Transaktion: scheitert der Ledger-Eintrag, ist auch 0002 zurückgerollt', async () => {
  const { db } = await migratedAtHead();
  const before = state(db);
  const dir = migrationsCopy({ [`${DISTRICT}.sql`]: MIGRATION_0002 });
  // applied_at ist NOT NULL: der Ledger-Eintrag scheitert nach dem Migrationskörper
  await assert.rejects(runMigrations(db, { migrationsDir: dir, production: false, now: () => null }), /NOT NULL constraint failed: schema_migrations\.applied_at/);
  assert.equal(db.inTransaction, false);
  assert.equal(hasColumn(db, 'leads', 'district'), false, 'Körper von 0002 zurückgerollt');
  assert.deepEqual(state(db).ledger, before.ledger);
  assert.equal(state(db).userVersion, HEAD);
  assert.deepEqual(state(db).digest, before.digest);
  db.close();
});

test('CLI in Produktion (nur RAILWAY_ENVIRONMENT_NAME) mit echter 0002 im Projektordner: ohne Sicherungsziel nichts, mit Ziel erst Sicherung, dann 0002', () => {
  // In Produktion zählt nur db/migrations unter dem Arbeitsverzeichnis — also ein eigenes Projekt mit dem echten Satz und der nächsten Migration.
  const project = tempDir();
  mkdirSync(join(project, 'db', 'migrations'), { recursive: true });
  for (const { file } of REAL_MIGRATIONS) copyFileSync(join(MIGRATIONS_DIR, file), join(project, 'db', 'migrations', file));
  writeFileSync(join(project, 'db', 'migrations', `${DISTRICT}.sql`), MIGRATION_0002);
  const path = join(project, 'crm.db');
  const base = { PATH: process.env.PATH, HOME: process.env.HOME, SQLITE_PATH: path };
  const cli = (args, env) => spawnSync(process.execPath, [join(ROOT, 'scripts/db-migrate.mjs'), ...args], { cwd: project, env: { ...base, ...env }, encoding: 'utf8' });
  assert.equal(cli(['--no-seed'], { PXK_MIGRATIONS_DIR: MIGRATIONS_DIR }).status, 0, 'Entwicklung: Stand des echten Satzes anlegen');
  const db = openDatabase(path, 'apply');
  insertSyntheticRows(db);
  const before = contentDigest(db);
  db.close();

  const refused = cli(['--no-seed'], { RAILWAY_ENVIRONMENT_NAME: 'production' });
  assert.equal(refused.status, 15, refused.stderr);
  assert.match(refused.stderr, /BACKUP_DESTINATION_REQUIRED/);
  let check = openDatabase(path, 'inspect');
  assert.equal(hasColumn(check, 'leads', 'district'), false);
  assert.deepEqual(versions(check), realVersions());
  assert.deepEqual(contentDigest(check), before);
  check.close();

  const ok = cli(['--no-seed'], { RAILWAY_ENVIRONMENT_NAME: 'production', PXK_DB_BACKUP_DIR: join(project, 'backups') });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, new RegExp(`mode=production .*mode_reason=RAILWAY_ENVIRONMENT_NAME=production\\nPXK-DB Sicherung .*pre-${escapeRegExp(DISTRICT)}-.*\\nPXK-DB applied ${escapeRegExp(DISTRICT)}\\n`));
  check = openDatabase(path, 'inspect');
  assert.deepEqual(versions(check), [...realVersions(), `${HEAD + 1} ${DISTRICT} applied`]);
  assert.ok(hasColumn(check, 'leads', 'district'));
  check.close();
});

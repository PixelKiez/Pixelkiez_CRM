import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { contentDigest, fingerprint, sameFingerprint } from '../../lib/db/fingerprint.mjs';
import { dryRun } from '../../lib/db/execute.mjs';
import { LEDGER_DDL, checkLedger, classify, loadMigrations, runMigrations, verifyHead } from '../../lib/db/migrate.mjs';
import { openDatabase } from '../../lib/db/open.mjs';
import { buildReport } from '../../lib/db/report.mjs';
import { splitStatements } from '../../lib/db/sql-split.mjs';
import { MIGRATIONS_DIR, buildLegacy, errorCode, insertSyntheticRows, ledgerRows, migrationsCopy, tempDir } from './helpers.mjs';

const fresh = () => openDatabase(join(tempDir(), 'crm.db'), 'apply');
const migratedWithRows = async () => {
  const db = fresh();
  await runMigrations(db, { migrationsDir: MIGRATIONS_DIR });
  insertSyntheticRows(db);
  return db;
};

test('NEG: Trigger oder Index am Ledger → LEDGER_SCHEMA_INVALID, nächste Migration läuft nicht, Daten bleiben', async () => {
  for (const [label, ddl] of Object.entries({
    Trigger: 'CREATE TRIGGER trg_ledger AFTER INSERT ON schema_migrations BEGIN DELETE FROM leads; END',
    Index: 'CREATE INDEX idx_ledger_x ON schema_migrations(applied_at)',
  })) {
    const db = await migratedWithRows();
    db.exec(ddl);
    const digest = contentDigest(db);
    const next = migrationsCopy({ '0002_a.sql': 'CREATE TABLE a2 (x);\n' });
    const error = await errorCode(() => runMigrations(db, { migrationsDir: next }));
    assert.equal(error?.code, 'LEDGER_SCHEMA_INVALID', label);
    assert.match(error.message, /trg_ledger|idx_ledger_x/);
    assert.equal((await errorCode(() => verifyHead(db, { migrationsDir: MIGRATIONS_DIR })))?.code, 'LEDGER_SCHEMA_INVALID', `${label}: Request-Pfad`);
    assert.equal(ledgerRows(db).length, 1);
    assert.deepEqual(contentDigest(db), digest, label);
    assert.equal(buildReport({ dbPath: db.name, migrationsDir: MIGRATIONS_DIR }).verdict, 'ledger-invalid', `${label}: Bericht`);
    db.close();
  }
});

test('NEG: Objekt namens schema_migrations in einem Altstand → UNKNOWN_SCHEMA, keine Übernahme', async () => {
  for (const [label, ddl] of Object.entries({
    Trigger: 'CREATE TRIGGER schema_migrations AFTER INSERT ON leads BEGIN SELECT 1; END',
    View: 'CREATE VIEW schema_migrations AS SELECT 1 AS version',
  })) {
    const db = buildLegacy(join(tempDir(), 'crm.db'), 'S5');
    insertSyntheticRows(db, 1);
    db.exec(ddl);
    assert.equal(classify(db, loadMigrations(MIGRATIONS_DIR)).kind, 'UNKNOWN', label);
    const error = await errorCode(() => runMigrations(db, { migrationsDir: MIGRATIONS_DIR }));
    assert.equal(error?.code, 'UNKNOWN_SCHEMA', label);
    assert.equal(buildReport({ dbPath: db.name, migrationsDir: MIGRATIONS_DIR }).verdict, 'unknown-schema', label);
    db.close();
  }
});

test('NEG: widersprüchliche Ledger-Zeilen → CORRUPT_LEDGER', async () => {
  const cases = {
    'baselined bei Version 2': "UPDATE schema_migrations SET kind = 'baselined', legacy_variant = 'S5' WHERE version = 2",
    'unbekannter Altstand': "UPDATE schema_migrations SET kind = 'baselined', legacy_variant = 'S9' WHERE version = 1",
    'applied mit Altstand': "UPDATE schema_migrations SET legacy_variant = 'S3' WHERE version = 1",
    'applied_at kein Zeitstempel': "UPDATE schema_migrations SET applied_at = 'gestern' WHERE version = 2",
  };
  const set = loadMigrations(migrationsCopy({ '0002_a.sql': 'CREATE TABLE a2 (x);\n' }));
  for (const [label, sql] of Object.entries(cases)) {
    const db = fresh();
    await runMigrations(db, { migrationsDir: set.dir });
    assert.equal(checkLedger(db, set).head, 2);
    db.exec(sql);
    assert.equal((await errorCode(() => checkLedger(db, set)))?.code, 'CORRUPT_LEDGER', label);
    db.close();
  }
});

test('NEG-08b: Transaktionssteuerung an der statischen Prüfung vorbei → im Probelauf TX_CONTROL_IN_MIGRATION', async () => {
  const set = loadMigrations(MIGRATIONS_DIR);
  for (const sql of ['CREATE TABLE a (x); COMMIT; BEGIN; CREATE TABLE b (x);', 'CREATE TABLE a (x); END;', 'ROLLBACK; CREATE TABLE b (x);']) {
    const pending = [{ name: '0002_tx', statements: splitStatements(sql) }];
    const error = await errorCode(() => dryRun(set, 1, pending));
    assert.equal(error?.code, 'TX_CONTROL_IN_MIGRATION', sql);
    assert.equal(error.exitCode, 13);
  }
});

test('RAISE(ROLLBACK) erst auf echten Daten → MIGRATION_FAILED (Exit 13, voll zurückgerollt), nicht Exit 14', async () => {
  const db = await migratedWithRows();
  const digest = contentDigest(db);
  const dir = migrationsCopy({
    '0002_guard.sql': [
      'CREATE TABLE rb_probe (x);',
      "CREATE TRIGGER rb_guard BEFORE UPDATE ON leads BEGIN SELECT RAISE(ROLLBACK, 'nein'); END;",
      'UPDATE leads SET status = status;',
      '',
    ].join('\n'),
  });
  const error = await errorCode(() => runMigrations(db, { migrationsDir: dir }));
  assert.equal(error?.code, 'MIGRATION_FAILED');
  assert.equal(error.exitCode, 13);
  assert.match(error.message, /0002_guard: Anweisung 3: nein — Transaktion von SQLite vollständig zurückgerollt/);
  assert.equal(db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE name IN ('rb_probe', 'rb_guard')").get().c, 0);
  assert.equal(ledgerRows(db).length, 1);
  assert.deepEqual(contentDigest(db), digest);
  db.close();
});

test('Fremdschlüssel: Probelauf prüft mit foreign_keys=ON; aufgeschobene Verletzung auf echten Daten → FK_VIOLATION', async () => {
  const immediate = migrationsCopy({
    '0002_fk.sql': 'CREATE TABLE parent2 (id INTEGER PRIMARY KEY);\nCREATE TABLE child2 (pid INTEGER REFERENCES parent2(id));\nINSERT INTO child2 (pid) VALUES (99);\n',
  });
  const db = await migratedWithRows();
  const first = await errorCode(() => runMigrations(db, { migrationsDir: immediate }));
  assert.equal(first?.code, 'MIGRATION_FAILED');
  assert.match(first.message, /Probelauf: .*FOREIGN KEY/);

  const deferred = migrationsCopy({
    '0002_fk.sql': [
      'PRAGMA defer_foreign_keys = ON;',
      'CREATE TABLE parent2 (id INTEGER PRIMARY KEY);',
      'CREATE TABLE child2 (pid INTEGER REFERENCES parent2(id));',
      'INSERT INTO child2 (pid) SELECT 99 FROM settings LIMIT 1;',
      '',
    ].join('\n'),
  });
  const second = await errorCode(() => runMigrations(db, { migrationsDir: deferred }));
  assert.equal(second?.code, 'FK_VIOLATION');
  assert.equal(db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE name IN ('parent2', 'child2')").get().c, 0);
  assert.equal(ledgerRows(db).length, 1);
  db.close();
});

test('unter der Sperre neu eingeordnet: fremder Schreiber → STATE_CHANGED, nichts geschrieben', async () => {
  const db = fresh();
  const error = await errorCode(() => runMigrations(db, {
    migrationsDir: MIGRATIONS_DIR,
    // altes Release startet parallel und legt sein Schema an
    hooks: { beforeLock: conn => conn.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)') },
  }));
  assert.equal(error?.code, 'STATE_CHANGED');
  assert.equal(error.exitCode, 12);
  assert.equal(ledgerRows(db), null);
  db.close();
});

test('unter der Sperre: anderer Runner war schneller → No-op', async () => {
  const dir = tempDir();
  const db = buildLegacy(join(dir, 'crm.db'), 'S5');
  insertSyntheticRows(db);
  const set = loadMigrations(MIGRATIONS_DIR);
  const result = await runMigrations(db, {
    migrationsDir: MIGRATIONS_DIR,
    backup: { dir: join(dir, 'backups') },
    hooks: {
      beforeLock: (conn) => {
        conn.exec(LEDGER_DDL);
        conn.prepare("INSERT INTO schema_migrations VALUES (1, '0001_baseline', ?, '2026-10-02T00:00:00.000Z', 'baselined', 'S5')").run(set.migrations[0].checksum);
        conn.pragma('user_version = 1');
      },
    },
  });
  assert.deepEqual(result.actions, []);
  assert.equal(ledgerRows(db).length, 1);
  db.close();
});

test('Übernahme: Schema oder Daten weichen vor dem Eintrag ab → ADOPTION_VERIFY_FAILED / DATA_DIGEST_MISMATCH, alles zurückgerollt', async () => {
  const cases = {
    ADOPTION_VERIFY_FAILED: conn => conn.exec('CREATE TABLE eingeschmuggelt (x)'),
    DATA_DIGEST_MISMATCH: conn => conn.exec("UPDATE leads SET name = 'verändert'"),
  };
  for (const [code, mutate] of Object.entries(cases)) {
    const dir = tempDir();
    const db = buildLegacy(join(dir, 'crm.db'), 'S3');
    insertSyntheticRows(db);
    const digest = contentDigest(db);
    const fp = fingerprint(db);
    const error = await errorCode(() => runMigrations(db, {
      migrationsDir: MIGRATIONS_DIR,
      adoptLegacy: 'S3',
      backup: { dir: join(dir, 'backups') },
      hooks: { beforeAdoptVerify: mutate },
    }));
    assert.equal(error?.code, code);
    assert.equal(ledgerRows(db), null, code);
    assert.ok(sameFingerprint(fingerprint(db), fp), `${code}: Nachzieh-Anweisungen zurückgerollt`);
    assert.deepEqual(contentDigest(db), digest, code);
    db.close();
  }
});

test('Bericht prüft eine migrierte Datenbank vollständig: Drift → ledger-invalid (SCHEMA_DRIFT)', async () => {
  const db = await migratedWithRows();
  db.exec('CREATE INDEX idx_oob ON leads(city)');
  const report = buildReport({ dbPath: db.name, migrationsDir: MIGRATIONS_DIR });
  assert.equal(report.verdict, 'ledger-invalid');
  assert.ok(report.lines.some(l => /ledger_error=SCHEMA_DRIFT .*idx_oob/.test(l)), report.lines.join('\n'));
  assert.equal(report.ok, false);
  db.close();
});

import assert from 'node:assert/strict';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { contentDigest, fingerprint, sameFingerprint, schemaObjects, tableColumns } from '../../lib/db/fingerprint.mjs';
import { classify, createReferences, loadMigrations, runMigrations, verifyHead } from '../../lib/db/migrate.mjs';
import { openDatabase } from '../../lib/db/open.mjs';
import {
  GOLDEN, GOLDEN_PART, HEAD, HEAD_FP, MIGRATIONS_DIR, POST_BASELINE_TABLES, baselineOnlyDir, buildLegacy, errorCode, future, goldenPart, goldenPartExact,
  insertSyntheticRows, ledgerRows, migrationsCopy, realActions, realLedger, tempDir,
} from './helpers.mjs';

const fresh = (dir = tempDir()) => openDatabase(join(dir, 'crm.db'), 'apply');
const matchesGolden = (db) => {
  const fp = fingerprint(db);
  return fp.hashes.structural === GOLDEN.hashes.structural && fp.hashes.text === GOLDEN.hashes.text;
};
/** Kopf des echten Satzes: kanonisches Schema, und der cd2c098-Anteil ist exakt GOLDEN. */
const matchesHead = (db) => {
  const fp = fingerprint(db);
  return sameFingerprint(fp, HEAD_FP) && goldenPartExact(fp);
};
const NEXT = String(HEAD + 1).padStart(4, '0');

// PXK-113 AC1 dynamisch gelesen (D12.1 = A): Der Titel unten gilt wörtlich nur für den Baseline-Satz.
test('AC1: leere Datenbank → alle Migrationen → Schema gleich dem echten cd2c098-Schema', async () => {
  // Baseline allein: exakt das cd2c098-Schema.
  const db = fresh();
  const result = await runMigrations(db, { migrationsDir: baselineOnlyDir() });
  assert.deepEqual(result.actions, ['applied 0001_baseline']);
  const fp = fingerprint(db);
  assert.deepEqual(fp.structural, GOLDEN.structural, 'Tabellen, Spalten/Reihenfolge, Defaults, Indizes, Constraints');
  assert.deepEqual(fp.text, GOLDEN.text, 'sqlite_master.sql (normalisiert)');
  assert.deepEqual(ledgerRows(db), [{ version: 1, name: '0001_baseline', kind: 'applied', legacy_variant: null }]);
  assert.equal(db.pragma('user_version', { simple: true }), 1);
  db.close();
  // Alle echten Migrationen: der cd2c098-Anteil bleibt exakt (spätere Migrationen rein additiv), dazu der kanonische Kopf.
  const head = fresh();
  assert.deepEqual((await runMigrations(head, { migrationsDir: MIGRATIONS_DIR })).actions, realActions());
  const headFp = fingerprint(head);
  assert.deepEqual(goldenPart(headFp), GOLDEN_PART, 'cd2c098-Objekte unverändert');
  assert.ok(sameFingerprint(headFp, HEAD_FP), 'Schema = kanonischer Kopf aus db/migrations');
  assert.deepEqual(ledgerRows(head), realLedger());
  assert.equal(head.pragma('user_version', { simple: true }), HEAD);
  head.close();
});

test('AC1: die unabhängige Altstand-Fixture entspricht dem echten cd2c098-Schema', () => {
  const db = buildLegacy(join(tempDir(), 'legacy.db'), 'S5');
  assert.ok(matchesGolden(db));
  db.close();
});

test('AC2: zweiter Lauf ändert nichts (gleiche und neue Verbindung)', async () => {
  const dir = tempDir();
  const db = fresh(dir);
  await runMigrations(db, { migrationsDir: MIGRATIONS_DIR });
  insertSyntheticRows(db);
  const schemaVersion = db.pragma('schema_version', { simple: true });
  const digest = contentDigest(db);
  const again = await runMigrations(db, { migrationsDir: MIGRATIONS_DIR });
  assert.deepEqual(again.actions, []);
  db.close();
  const reopened = fresh(dir);
  const third = await runMigrations(reopened, { migrationsDir: MIGRATIONS_DIR });
  assert.deepEqual(third.actions, []);
  assert.equal(reopened.pragma('schema_version', { simple: true }), schemaVersion);
  assert.deepEqual(contentDigest(reopened), digest);
  assert.equal(ledgerRows(reopened).length, HEAD);
  reopened.close();
});

test('AC3: exakter cd2c098-Altstand mit Daten wird nur per Metadaten übernommen', async () => {
  const dir = tempDir();
  const db = buildLegacy(join(dir, 'crm.db'), 'S5');
  insertSyntheticRows(db);
  const digestBefore = contentDigest(db);
  const fpBefore = fingerprint(db);
  const objectsBefore = schemaObjects(db).map(o => `${o.type}:${o.name}`);
  // genau die Übernahme (Satz = Baseline): nur Metadaten
  const result = await runMigrations(db, { migrationsDir: baselineOnlyDir(), backup: { dir: join(dir, 'backups') } });
  assert.deepEqual(result.actions, ['baselined 0001_baseline (S5)']);
  assert.ok(result.backup?.sha256, 'geprüfte Sicherung angelegt');
  // VERBOTENE Geschäftsdatenänderung: keine
  assert.deepEqual(contentDigest(db), digestBefore);
  // ERWARTETE Metadatenänderung: nur Ledger und user_version
  assert.ok(sameFingerprint(fingerprint(db), fpBefore));
  assert.deepEqual(schemaObjects(db).map(o => `${o.type}:${o.name}`), objectsBefore);
  assert.deepEqual(ledgerRows(db), [{ version: 1, name: '0001_baseline', kind: 'baselined', legacy_variant: 'S5' }]);
  assert.equal(db.pragma('user_version', { simple: true }), 1);
  db.close();

  // Echter Satz in EINEM Lauf (so trifft das Release den Altstand): Übernahme, dann die späteren Migrationen.
  // Bestehende Daten und Objekte bleiben exakt, neue Tabellen sind leer.
  const dir2 = tempDir();
  const db2 = buildLegacy(join(dir2, 'crm.db'), 'S5');
  insertSyntheticRows(db2);
  const columns2 = tableColumns(db2);
  const digest2 = contentDigest(db2);
  const objects2 = schemaObjects(db2).map(o => `${o.type}:${o.name}:${o.sql}`);
  const full = await runMigrations(db2, { migrationsDir: MIGRATIONS_DIR, backup: { dir: join(dir2, 'backups') } });
  assert.deepEqual(full.actions, realActions('baselined 0001_baseline (S5)'));
  assert.ok(full.backup?.sha256, 'geprüfte Sicherung angelegt');
  assert.deepEqual(contentDigest(db2, columns2), digest2, 'keine Geschäftsdatenänderung');
  const after2 = contentDigest(db2);
  assert.deepEqual(Object.keys(after2).filter(t => !digest2[t]).sort(), POST_BASELINE_TABLES, 'genau die Tabellen späterer Migrationen sind neu');
  for (const table of POST_BASELINE_TABLES) assert.equal(after2[table]?.rows, 0, `${table}: neu und leer`);
  const objectsAfter2 = new Set(schemaObjects(db2).map(o => `${o.type}:${o.name}:${o.sql}`));
  assert.deepEqual(objects2.filter(o => !objectsAfter2.has(o)), [], 'jedes bestehende Objekt unverändert');
  assert.ok(matchesHead(db2));
  assert.deepEqual(ledgerRows(db2), realLedger('S5'));
  assert.equal(db2.pragma('user_version', { simple: true }), HEAD);
  db2.close();
});

test('AC3b: älterer Altstand nur mit Freigabe; Daten bleiben, neue Spalten mit Defaults', async () => {
  const dir = tempDir();
  const db = buildLegacy(join(dir, 'crm.db'), 'S2');
  insertSyntheticRows(db);
  const columnsBefore = tableColumns(db);
  const digestBefore = contentDigest(db);

  const refused = await errorCode(() => runMigrations(db, { migrationsDir: MIGRATIONS_DIR }));
  assert.equal(refused?.code, 'LEGACY_OUTDATED');
  const wrongFlag = await errorCode(() => runMigrations(db, { migrationsDir: MIGRATIONS_DIR, adoptLegacy: 'S3' }));
  assert.equal(wrongFlag?.code, 'ADOPT_FLAG_MISMATCH');
  assert.equal(ledgerRows(db), null, 'Verweigerung schreibt nichts');
  assert.deepEqual(contentDigest(db), digestBefore);

  const result = await runMigrations(db, { migrationsDir: MIGRATIONS_DIR, adoptLegacy: 'S2', backup: { dir: join(dir, 'backups') } });
  assert.deepEqual(result.actions, realActions('baselined 0001_baseline (S2)'));
  assert.ok(matchesHead(db));
  assert.deepEqual(contentDigest(db, columnsBefore), digestBefore, 'bestehende Spalten unverändert');
  assert.deepEqual(db.prepare('SELECT DISTINCT contact_attempts AS a, owner_email AS o FROM leads').all(), [{ a: 0, o: null }]);

  // Flag nach erfolgter Übernahme: Hinweis statt Fehler
  const lines = [];
  const after = await runMigrations(db, { migrationsDir: MIGRATIONS_DIR, adoptLegacy: 'S2', log: l => lines.push(l) });
  assert.deepEqual(after.actions, []);
  assert.ok(lines.some(l => l.includes('bereits verbraucht')));
  db.close();
});

test('AC4: Migration scheitert nach Zwischenschritt → Rollback, Ledger unverändert, Fehler nennt die Migration', async () => {
  const dir = migrationsCopy({
    // Probelauf auf leerer Kopie gelingt; auf echten Daten scheitert der UNIQUE-Index.
    [`${future(1, 'break')}.sql`]: 'CREATE TABLE thing (x TEXT);\nALTER TABLE leads ADD COLUMN thing_id TEXT;\nCREATE UNIQUE INDEX idx_break ON leads(status);\n',
  });
  const db = fresh();
  await runMigrations(db, { migrationsDir: MIGRATIONS_DIR });
  insertSyntheticRows(db);
  db.prepare("UPDATE leads SET status = 'Neu'").run();
  const digest = contentDigest(db);
  const error = await errorCode(() => runMigrations(db, { migrationsDir: dir }));
  assert.equal(error?.code, 'MIGRATION_FAILED');
  assert.match(error.message, new RegExp(future(1, 'break')));
  assert.equal(db.inTransaction, false);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'thing'").get(), undefined, 'Tabelle aus der gescheiterten Migration fehlt');
  assert.ok(!tableColumns(db).leads.includes('thing_id'), 'Spalte aus der gescheiterten Migration fehlt');
  assert.equal(ledgerRows(db).length, HEAD);
  assert.equal(db.pragma('user_version', { simple: true }), HEAD);
  assert.deepEqual(contentDigest(db), digest);
  assert.ok(matchesHead(db));
  db.close();
});

test('AC4: Syntaxfehler fällt schon im Probelauf auf, echte Datenbank unberührt', async () => {
  const dir = migrationsCopy({ [`${future(1, 'bad')}.sql`]: 'CREATE TABLE ok_part (x);\nINSERT INTO does_not_exist VALUES (1);\n' });
  const db = fresh();
  await runMigrations(db, { migrationsDir: MIGRATIONS_DIR });
  const error = await errorCode(() => runMigrations(db, { migrationsDir: dir }));
  assert.equal(error?.code, 'MIGRATION_FAILED');
  assert.match(error.message, new RegExp(`${future(1, 'bad')}.*Probelauf`));
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'ok_part'").get(), undefined);
  assert.equal(ledgerRows(db).length, HEAD);
  db.close();
});

test('weitere Migration wird angewandt, Trigger mit BEGIN…END ist erlaubt und atomar', async () => {
  const dir = migrationsCopy({
    [`${future(1, 'trigger')}.sql`]: [
      'CREATE TABLE audit_probe (id INTEGER PRIMARY KEY, note TEXT);',
      "CREATE TRIGGER trg_probe AFTER INSERT ON audit_probe BEGIN UPDATE audit_probe SET note = CASE WHEN NEW.note IS NULL THEN 'leer' ELSE NEW.note END WHERE id = NEW.id; END;",
      '',
    ].join('\n'),
  });
  const db = fresh();
  const result = await runMigrations(db, { migrationsDir: dir });
  assert.deepEqual(result.actions, [...realActions(), `applied ${future(1, 'trigger')}`]);
  assert.equal(db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type = 'trigger'").get().c, HEAD_FP.structural.triggers.length + 1);
  assert.equal(db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_probe'").get().c, 1);
  assert.deepEqual(verifyHead(db, { migrationsDir: dir }), { head: HEAD + 1 });
  db.close();
});

test('NEG: Prüfsumme einer angewandten Migration geändert → CHECKSUM_MISMATCH; nur CRLF/BOM → kein Fehler', async () => {
  const file = `${future(1, 'x')}.sql`;
  const dir = migrationsCopy({ [file]: 'CREATE TABLE x2 (a TEXT);\n' });
  const db = fresh();
  await runMigrations(db, { migrationsDir: dir });
  writeFileSync(join(dir, file), '﻿CREATE TABLE x2 (a TEXT);\r\n');
  assert.deepEqual((await runMigrations(db, { migrationsDir: dir })).actions, []);
  writeFileSync(join(dir, file), 'CREATE TABLE x2 (a TEXT); -- nachträglich geändert\n');
  assert.equal((await errorCode(() => runMigrations(db, { migrationsDir: dir })))?.code, 'CHECKSUM_MISMATCH');
  db.close();
});

test('NEG: angewandte Datei fehlt — mittlere → VERSION_GAP, neueste → LEDGER_AHEAD_OF_FILES (DB neuer als Code)', async () => {
  const [a, b] = [`${future(1, 'a')}.sql`, `${future(2, 'b')}.sql`];
  const dir = migrationsCopy({ [a]: 'CREATE TABLE a2 (x);\n', [b]: 'CREATE TABLE b3 (x);\n' });
  const db = fresh();
  await runMigrations(db, { migrationsDir: dir });
  const middle = migrationsCopy({ [b]: 'CREATE TABLE b3 (x);\n' });
  const gap = await errorCode(() => runMigrations(db, { migrationsDir: middle }));
  assert.equal(gap?.code, 'VERSION_GAP');
  const newest = migrationsCopy({ [a]: 'CREATE TABLE a2 (x);\n' });
  const ahead = await errorCode(() => runMigrations(db, { migrationsDir: newest }));
  assert.equal(ahead?.code, 'LEDGER_AHEAD_OF_FILES');
  assert.match(ahead.message, new RegExp(future(2, 'b')));
  const verify = await errorCode(() => verifyHead(db, { migrationsDir: MIGRATIONS_DIR }));
  assert.equal(verify?.code, 'LEDGER_AHEAD_OF_FILES', 'auch der Request-Pfad startet nicht gegen eine neuere Datenbank');
  db.close();
});

test('NEG: doppelte Version, Lücke, ungültiger Dateiname; .DS_Store und README.md werden ignoriert', async () => {
  const db = fresh();
  const duplicate = migrationsCopy({ [`${future(1, 'a')}.sql`]: 'SELECT 1;\n', [`${future(1, 'b')}.sql`]: 'SELECT 1;\n' });
  assert.equal((await errorCode(() => runMigrations(db, { migrationsDir: duplicate })))?.code, 'DUPLICATE_VERSION');
  const gap = migrationsCopy({ [`${future(2, 'c')}.sql`]: 'SELECT 1;\n' });
  assert.equal((await errorCode(() => runMigrations(db, { migrationsDir: gap })))?.code, 'VERSION_GAP');
  for (const bad of [`${NEXT}-x.sql`, 'two.sql', `${NEXT}_X.sql`, '02_x.sql']) {
    const dir = migrationsCopy({ [bad]: 'SELECT 1;\n' });
    assert.equal((await errorCode(() => runMigrations(db, { migrationsDir: dir })))?.code, 'MALFORMED_FILENAME', bad);
  }
  const ignored = migrationsCopy({ '.DS_Store': 'x', 'README.md': '# Hinweis\n' });
  assert.deepEqual((await runMigrations(db, { migrationsDir: ignored })).actions, realActions());
  db.close();
});

test('NEG: niedrigere Nummer nach späteren Migrationen eingefügt → RENAMED_OR_REORDERED', async () => {
  const dir = migrationsCopy({ [`${future(1, 'a')}.sql`]: 'CREATE TABLE a2 (x);\n' });
  const db = fresh();
  await runMigrations(db, { migrationsDir: dir });
  renameSync(join(dir, `${future(1, 'a')}.sql`), join(dir, `${future(2, 'a')}.sql`));
  writeFileSync(join(dir, `${future(1, 'neu')}.sql`), 'CREATE TABLE neu2 (x);\n');
  assert.equal((await errorCode(() => runMigrations(db, { migrationsDir: dir })))?.code, 'RENAMED_OR_REORDERED');
  db.close();
});

test('NEG: Transaktionssteuerung in Migrationen wird verweigert', async () => {
  const db = fresh();
  for (const sql of ['COMMIT;', 'BEGIN;', 'END;', 'ROLLBACK;', 'SAVEPOINT s;', 'PRAGMA journal_mode = DELETE;', 'PRAGMA main.journal_mode = DELETE;', 'PRAGMA foreign_keys = OFF;', 'PRAGMA user_version = 9;', "ATTACH 'x.db' AS x;", 'VACUUM;']) {
    const dir = migrationsCopy({ [`${future(1, 'tx')}.sql`]: `CREATE TABLE t2 (x);\n${sql}\nCREATE TABLE t3 (x);\n` });
    const error = await errorCode(() => runMigrations(db, { migrationsDir: dir }));
    assert.equal(error?.code, 'FORBIDDEN_STATEMENT', sql);
    assert.match(error.message, new RegExp(future(1, 'tx')));
  }
  assert.equal(ledgerRows(db), null, 'nichts geschrieben');
  db.close();
});

test('NEG: Transaktion trotz Prüfung verlassen → PARTIAL_APPLY_RESTORE_REQUIRED', async () => {
  const dir = migrationsCopy({ [`${future(1, 'x')}.sql`]: 'CREATE TABLE x2 (a TEXT);\n' });
  const db = fresh();
  await runMigrations(db, { migrationsDir: MIGRATIONS_DIR });
  const error = await errorCode(() => runMigrations(db, {
    migrationsDir: dir,
    hooks: { beforeExec: (migration, conn) => { if (migration.version === HEAD + 1) conn.exec('COMMIT'); } },
  }));
  assert.equal(error?.code, 'PARTIAL_APPLY_RESTORE_REQUIRED');
  assert.equal(error.exitCode, 14);
  db.close();
});

test('NEG: Baseline-Datei verändert → LEGACY_DEFINITION_INVALID', async () => {
  const dir = migrationsCopy();
  const path = join(dir, '0001_baseline.sql');
  writeFileSync(path, readFileSync(path, 'utf8').replace('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)', 'CREATE TABLE settings (key TEXT PRIMARY KEY,  value TEXT)'));
  assert.equal((await errorCode(() => loadMigrations(dir)))?.code, 'LEGACY_DEFINITION_INVALID');
});

test('NEG: kaputtes Ledger', async () => {
  const setup = async () => {
    const dir = migrationsCopy({ [`${future(1, 'a')}.sql`]: 'CREATE TABLE a2 (x);\n' });
    const db = fresh();
    await runMigrations(db, { migrationsDir: dir });
    return { db, dir };
  };
  {
    const { db, dir } = await setup();
    db.pragma('user_version = 7');
    assert.equal((await errorCode(() => runMigrations(db, { migrationsDir: dir })))?.code, 'CORRUPT_LEDGER');
  }
  {
    const { db, dir } = await setup();
    db.prepare('DELETE FROM schema_migrations WHERE version = 1').run();
    assert.equal((await errorCode(() => runMigrations(db, { migrationsDir: dir })))?.code, 'LEDGER_GAP');
  }
  {
    const { db, dir } = await setup();
    db.exec('ALTER TABLE schema_migrations ADD COLUMN extra TEXT');
    assert.equal((await errorCode(() => runMigrations(db, { migrationsDir: dir })))?.code, 'LEDGER_SCHEMA_INVALID');
  }
  {
    const { db, dir } = await setup();
    db.prepare('DELETE FROM schema_migrations').run();
    db.pragma('user_version = 0');
    assert.equal((await errorCode(() => runMigrations(db, { migrationsDir: dir })))?.code, 'CORRUPT_LEDGER');
  }
  {
    const db = buildLegacy(join(tempDir(), 'x.db'), 'S5');
    db.pragma('user_version = 3');
    assert.equal((await errorCode(() => runMigrations(db, { migrationsDir: MIGRATIONS_DIR })))?.code, 'UNKNOWN_SCHEMA');
  }
});

test('NEG: unbekanntes und teilweise passendes Schema → UNKNOWN_SCHEMA, Datenbank unberührt', async () => {
  const cases = {
    'zusätzliche Tabelle': db => db.exec('CREATE TABLE custom_notes (x TEXT)'),
    'zusätzliche Spalte': db => db.exec('ALTER TABLE users ADD COLUMN nickname TEXT'),
    'fehlender Index': db => db.exec('DROP INDEX idx_leads_follow_up'),
    'Index mit anderem Text': db => db.exec('DROP INDEX idx_leads_follow_up; create index idx_leads_follow_up on leads ( follow_up )'),
    Trigger: db => db.exec('CREATE TRIGGER trg_x AFTER INSERT ON settings BEGIN SELECT 1; END'),
  };
  for (const [label, mutate] of Object.entries(cases)) {
    const db = buildLegacy(join(tempDir(), 'x.db'), 'S5');
    insertSyntheticRows(db, 1);
    mutate(db);
    const digest = contentDigest(db);
    const error = await errorCode(() => runMigrations(db, { migrationsDir: MIGRATIONS_DIR }));
    assert.equal(error?.code, 'UNKNOWN_SCHEMA', label);
    assert.match(error.message, /S5/, `${label}: nächster bekannter Stand genannt`);
    assert.equal(ledgerRows(db), null, label);
    assert.deepEqual(contentDigest(db), digest, label);
    db.close();
  }
  // halber Start eines alten Releases: S4 + users + owner_email, ohne actor_email
  const partial = buildLegacy(join(tempDir(), 'p.db'), 'S4');
  partial.exec("CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, display_name TEXT NOT NULL, signature TEXT, phone TEXT, google_tokens TEXT, google_email TEXT, google_calendar_id TEXT NOT NULL DEFAULT 'primary', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  partial.exec('ALTER TABLE leads ADD COLUMN owner_email TEXT');
  assert.equal(classify(partial, loadMigrations(MIGRATIONS_DIR)).kind, 'UNKNOWN');
  partial.close();
});

test('alle Altstände S1–S5 werden exakt erkannt und unterschieden', () => {
  const set = loadMigrations(MIGRATIONS_DIR);
  const refs = createReferences(set);
  for (const variant of ['S1', 'S2', 'S3', 'S4', 'S5']) {
    const db = buildLegacy(join(tempDir(), `${variant}.db`), variant);
    assert.deepEqual(classify(db, set, refs), { kind: 'LEGACY_EXACT', variant });
    db.close();
  }
});

test('NEG: Schemaänderung an einer migrierten Datenbank → SCHEMA_DRIFT', async () => {
  const db = fresh();
  await runMigrations(db, { migrationsDir: MIGRATIONS_DIR });
  db.exec('CREATE INDEX idx_oob ON leads(city)');
  const error = await errorCode(() => runMigrations(db, { migrationsDir: MIGRATIONS_DIR }));
  assert.equal(error?.code, 'SCHEMA_DRIFT');
  assert.match(error.message, /idx_oob/);
  db.close();
});

test('NEG: Runner in offener Transaktion → IN_TRANSACTION', async () => {
  const db = fresh();
  db.exec('BEGIN');
  assert.equal((await errorCode(() => runMigrations(db, { migrationsDir: MIGRATIONS_DIR })))?.code, 'IN_TRANSACTION');
  db.exec('ROLLBACK');
  db.close();
});

test('NEG: leere Datenbank in Produktion → FRESH_DB_IN_PRODUCTION, nichts angelegt; mit Freigabe erlaubt', async () => {
  const db = fresh();
  const error = await errorCode(() => runMigrations(db, { migrationsDir: MIGRATIONS_DIR, production: true }));
  assert.equal(error?.code, 'FRESH_DB_IN_PRODUCTION');
  assert.equal(schemaObjects(db).length, 0);
  assert.equal(ledgerRows(db), null);
  const ok = await runMigrations(db, { migrationsDir: MIGRATIONS_DIR, production: true, allowFresh: true });
  assert.deepEqual(ok.actions, realActions());
  db.close();
});

test('NEG: Produktion ohne Sicherungsziel → BACKUP_DESTINATION_REQUIRED, nichts geschrieben', async () => {
  const db = buildLegacy(join(tempDir(), 'crm.db'), 'S5');
  const error = await errorCode(() => runMigrations(db, { migrationsDir: MIGRATIONS_DIR, production: true, backup: false }));
  assert.equal(error?.code, 'BACKUP_DESTINATION_REQUIRED');
  assert.equal(ledgerRows(db), null);
  db.close();
});

test('Request-Pfad: verifyHead', async () => {
  const db = fresh();
  assert.equal((await errorCode(() => verifyHead(db, { migrationsDir: MIGRATIONS_DIR })))?.code, 'DB_NOT_MIGRATED');
  await runMigrations(db, { migrationsDir: MIGRATIONS_DIR });
  assert.deepEqual(verifyHead(db, { migrationsDir: MIGRATIONS_DIR }), { head: HEAD });
  const pending = migrationsCopy({ [`${future(1, 'a')}.sql`]: 'CREATE TABLE a2 (x);\n' });
  assert.equal((await errorCode(() => verifyHead(db, { migrationsDir: pending })))?.code, 'MIGRATIONS_PENDING');
  rmSync(pending, { recursive: true, force: true });
  db.close();
});

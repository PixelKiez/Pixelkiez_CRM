import assert from 'node:assert/strict';
import { chmodSync, readdirSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { contentDigest, fingerprint, sameFingerprint, tableColumns } from '../../lib/db/fingerprint.mjs';
import { dryRun } from '../../lib/db/execute.mjs';
import { LEDGER_DDL, checkLedger, classify, loadMigrations, runMigrations, verifyHead } from '../../lib/db/migrate.mjs';
import { openDatabase } from '../../lib/db/open.mjs';
import { buildReport } from '../../lib/db/report.mjs';
import { splitStatements } from '../../lib/db/sql-split.mjs';
import {
  GOLDEN, HEAD, MIGRATIONS_DIR, POST_BASELINE_TABLES, assertMode, baselineOnlyDir, buildLegacy, errorCode, future, insertSyntheticRows, ledgerFor,
  ledgerRows, loserFailureCodes, migrationsCopy, tempDir,
} from './helpers.mjs';

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
    const next = migrationsCopy({ [`${future(1, 'a')}.sql`]: 'CREATE TABLE a2 (x);\n' });
    const error = await errorCode(() => runMigrations(db, { migrationsDir: next }));
    assert.equal(error?.code, 'LEDGER_SCHEMA_INVALID', label);
    assert.match(error.message, /trg_ledger|idx_ledger_x/);
    assert.equal((await errorCode(() => verifyHead(db, { migrationsDir: MIGRATIONS_DIR })))?.code, 'LEDGER_SCHEMA_INVALID', `${label}: Request-Pfad`);
    assert.equal(ledgerRows(db).length, HEAD);
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
    'baselined bei Version 2': `UPDATE schema_migrations SET kind = 'baselined', legacy_variant = 'S5' WHERE version = ${HEAD + 1}`,
    'unbekannter Altstand': "UPDATE schema_migrations SET kind = 'baselined', legacy_variant = 'S9' WHERE version = 1",
    'applied mit Altstand': "UPDATE schema_migrations SET legacy_variant = 'S3' WHERE version = 1",
    'applied_at kein Zeitstempel': `UPDATE schema_migrations SET applied_at = 'gestern' WHERE version = ${HEAD + 1}`,
  };
  const set = loadMigrations(migrationsCopy({ [`${future(1, 'a')}.sql`]: 'CREATE TABLE a2 (x);\n' }));
  for (const [label, sql] of Object.entries(cases)) {
    const db = fresh();
    await runMigrations(db, { migrationsDir: set.dir });
    assert.equal(checkLedger(db, set).head, HEAD + 1);
    db.exec(sql);
    assert.equal((await errorCode(() => checkLedger(db, set)))?.code, 'CORRUPT_LEDGER', label);
    db.close();
  }
});

test('NEG-08b: Transaktionssteuerung an der statischen Prüfung vorbei → im Probelauf TX_CONTROL_IN_MIGRATION', async () => {
  const set = loadMigrations(MIGRATIONS_DIR);
  for (const sql of ['CREATE TABLE a (x); COMMIT; BEGIN; CREATE TABLE b (x);', 'CREATE TABLE a (x); END;', 'ROLLBACK; CREATE TABLE b (x);']) {
    const pending = [{ name: future(1, 'tx'), statements: splitStatements(sql) }];
    const error = await errorCode(() => dryRun(set, HEAD, pending));
    assert.equal(error?.code, 'TX_CONTROL_IN_MIGRATION', sql);
    assert.equal(error.exitCode, 13);
  }
});

test('RAISE(ROLLBACK) erst auf echten Daten → MIGRATION_FAILED (Exit 13, voll zurückgerollt), nicht Exit 14', async () => {
  const db = await migratedWithRows();
  const digest = contentDigest(db);
  const dir = migrationsCopy({
    [`${future(1, 'guard')}.sql`]: [
      'CREATE TABLE rb_probe (x);',
      "CREATE TRIGGER rb_guard BEFORE UPDATE ON leads BEGIN SELECT RAISE(ROLLBACK, 'nein'); END;",
      'UPDATE leads SET status = status;',
      '',
    ].join('\n'),
  });
  const error = await errorCode(() => runMigrations(db, { migrationsDir: dir }));
  assert.equal(error?.code, 'MIGRATION_FAILED');
  assert.equal(error.exitCode, 13);
  assert.match(error.message, new RegExp(`${future(1, 'guard')}: Anweisung 3: nein — Transaktion von SQLite vollständig zurückgerollt`));
  assert.equal(db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE name IN ('rb_probe', 'rb_guard')").get().c, 0);
  assert.equal(ledgerRows(db).length, HEAD);
  assert.deepEqual(contentDigest(db), digest);
  db.close();
});

test('Fremdschlüssel: Probelauf prüft mit foreign_keys=ON; aufgeschobene Verletzung auf echten Daten → FK_VIOLATION', async () => {
  const immediate = migrationsCopy({
    [`${future(1, 'fk')}.sql`]: 'CREATE TABLE parent2 (id INTEGER PRIMARY KEY);\nCREATE TABLE child2 (pid INTEGER REFERENCES parent2(id));\nINSERT INTO child2 (pid) VALUES (99);\n',
  });
  const db = await migratedWithRows();
  const first = await errorCode(() => runMigrations(db, { migrationsDir: immediate }));
  assert.equal(first?.code, 'MIGRATION_FAILED');
  assert.match(first.message, /Probelauf: .*FOREIGN KEY/);

  const deferred = migrationsCopy({
    [`${future(1, 'fk')}.sql`]: [
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
  assert.equal(ledgerRows(db).length, HEAD);
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
  // Satz = Baseline (E4 unter D2.1): der schnellere Runner hat genau die Übernahme geschrieben, also den Kopf.
  const dir = tempDir();
  const db = buildLegacy(join(dir, 'crm.db'), 'S5');
  insertSyntheticRows(db);
  const migrationsDir = baselineOnlyDir();
  const set = loadMigrations(migrationsDir);
  const result = await runMigrations(db, {
    migrationsDir,
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

/**
 * Derselbe Wettlauf, wenn nach dem gesicherten Stand noch Migrationen folgen
 * (D2.1 = A; Erwartung je Satz: helpers.mjs loserFailureCodes). Der schnellere
 * Runner schreibt die restlichen Migrationen des Satzes samt Ledger; der
 * langsamere hat seine Sicherung schon gezogen bzw. liest gerade. Fail-closed in
 * jedem Fall: Er schreibt nichts, der Stand des schnelleren bleibt exakt, ein
 * erneuter Lauf ist ein No-op ohne weitere Sicherung.
 */
const winnerWrites = (conn, set, from) => {
  if (from === 0) {
    conn.exec(LEDGER_DDL);
    conn.prepare("INSERT INTO schema_migrations VALUES (1, '0001_baseline', ?, '2026-10-02T00:00:00.000Z', 'baselined', 'S5')").run(set.migrations[0].checksum);
  }
  for (const m of set.migrations.slice(Math.max(from, 1))) {
    conn.exec(m.text);
    conn.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?, '2026-10-02T00:00:01.000Z', 'applied', NULL)").run(m.version, m.name, m.checksum);
  }
  conn.pragma(`user_version = ${set.migrations.length}`);
  return { ledger: ledgerRows(conn), digest: contentDigest(conn), fp: fingerprint(conn) };
};
const assertWinnerKept = (db, winner, business, columns) => {
  assert.deepEqual(ledgerRows(db), winner.ledger, 'Ledger des schnelleren Runners unverändert');
  assert.deepEqual(contentDigest(db), winner.digest, 'nichts geschrieben');
  assert.ok(sameFingerprint(fingerprint(db), winner.fp));
  assert.deepEqual(contentDigest(db, columns), business, 'Geschäftsdaten unverändert');
};
/** Migrationsverwaltete Datenbank auf dem echten Kopf mit Daten, dazu ein Satz mit einer Folgemigration (Kopf + 1). */
const migratedWithNext = async (slug, sql) => {
  const dir = tempDir();
  const db = openDatabase(join(dir, 'crm.db'), 'apply');
  await runMigrations(db, { migrationsDir: MIGRATIONS_DIR });
  insertSyntheticRows(db);
  const migrationsDir = migrationsCopy({ [`${future(1, slug)}.sql`]: sql });
  return { dir, db, migrationsDir, set: loadMigrations(migrationsDir) };
};
const RACE_TABLE = 'CREATE TABLE race_neu (id INTEGER PRIMARY KEY, x TEXT);\n';
const RACE_INDEX = 'CREATE INDEX idx_race_leads_notes ON leads(notes);\n';

test('unter der Sperre: anderer Runner war mit einer tabellenanlegenden Folgemigration schneller → BACKUP_STALE (Exit 15), nichts geschrieben, Wiederholung No-op', async () => {
  // Altstand S5: so trifft das Release mit der ersten tabellenanlegenden Migration auf Produktion.
  const dir = tempDir();
  const db = buildLegacy(join(dir, 'crm.db'), 'S5');
  insertSyntheticRows(db);
  const columns = tableColumns(db);
  const business = contentDigest(db);
  const migrationsDir = migrationsCopy({ [`${future(1, 'race_table')}.sql`]: RACE_TABLE });
  const set = loadMigrations(migrationsDir);
  assert.ok(loserFailureCodes(migrationsDir).includes('BACKUP_STALE'));
  let winner = null;
  const backups = join(dir, 'backups');
  const error = await errorCode(() => runMigrations(db, {
    migrationsDir,
    backup: { dir: backups },
    hooks: { beforeLock: (conn) => { winner = winnerWrites(conn, set, 0); } },
  }));
  assert.equal(error?.code, 'BACKUP_STALE');
  assert.equal(error.exitCode, 15);
  assertWinnerKept(db, winner, business, columns);
  assert.deepEqual(ledgerRows(db), ledgerFor(set.migrations, 'S5'));
  const created = Object.keys(fingerprint(db).structural.tables).filter(name => !GOLDEN.structural.tables[name]);
  assert.deepEqual(created.sort(), [...POST_BASELINE_TABLES, 'race_neu'].sort());
  for (const table of created) assert.equal(contentDigest(db)[table]?.rows, 0, table);
  const verified = readdirSync(backups).filter(f => /^pre-0001_baseline-.*\.db$/.test(f));
  assert.equal(verified.length, 1, 'die Sicherung des langsameren Runners ist geprüft und zeigt den Stand davor');
  const again = await runMigrations(db, { migrationsDir, backup: { dir: backups } });
  assert.deepEqual(again.actions, [], 'Wiederholung: No-op');
  assert.equal(readdirSync(backups).filter(f => f.endsWith('.db')).length, 1, 'keine weitere Sicherung');
  db.close();
});

test('unter der Sperre: anderer Runner war mit einer Folgemigration ohne neue Tabelle/Spalte (nur Index) schneller → kein BACKUP_STALE, No-op', async () => {
  const { dir, db, migrationsDir, set } = await migratedWithNext('race_index', RACE_INDEX);
  assert.deepEqual(loserFailureCodes(migrationsDir, { from: HEAD, ledger: true }), ['BACKUP_FAILED', 'CORRUPT_LEDGER', 'SCHEMA_DRIFT']);
  const columns = tableColumns(db);
  const business = contentDigest(db);
  let winner = null;
  const backups = join(dir, 'backups');
  const result = await runMigrations(db, {
    migrationsDir,
    backup: { dir: backups },
    hooks: { beforeLock: (conn) => { winner = winnerWrites(conn, set, HEAD); } },
  });
  assert.deepEqual(result.actions, [], 'No-op');
  assertWinnerKept(db, winner, business, columns);
  assert.deepEqual(ledgerRows(db), ledgerFor(set.migrations));
  assert.equal(readdirSync(backups).filter(f => new RegExp(`^pre-${future(1, 'race_index')}-.*\\.db$`).test(f)).length, 1, 'geprüfte Sicherung des Stands davor');
  db.close();
});

test('Sicherung: anderer Runner schreibt eine reine Schemaänderung (Index) zwischen Kopie und Prüfung → BACKUP_FAILED (Exit 15), Kopie .unverified, nichts geschrieben, Wiederholung No-op', async () => {
  const { dir, db, migrationsDir, set } = await migratedWithNext('race_index', RACE_INDEX);
  const columns = tableColumns(db);
  const business = contentDigest(db);
  let winner = null;
  const backups = join(dir, 'backups');
  const error = await errorCode(() => runMigrations(db, {
    migrationsDir,
    backup: { dir: backups, afterCopy: () => { winner = winnerWrites(db, set, HEAD); } },
  }));
  assert.equal(error?.code, 'BACKUP_FAILED');
  assert.equal(error.exitCode, 15);
  assert.match(error.message, /Schema der Kopie weicht ab/);
  assertWinnerKept(db, winner, business, columns);
  const files = readdirSync(backups, { recursive: true });
  assert.equal(files.filter(f => f.endsWith('.db')).length, 0, 'keine geprüfte Sicherung');
  assert.equal(files.filter(f => f.endsWith('.db.unverified')).length, 1, 'die Kopie bleibt als .unverified gekennzeichnet');
  const again = await runMigrations(db, { migrationsDir, backup: { dir: backups } });
  assert.deepEqual(again.actions, [], 'Wiederholung: No-op');
  db.close();
});

test('D2.2 (T-D2-1): BACKUP_FAILED in beiden Fenstern (Digest → Kopie, Kopie → Prüfung) → Exit 15, nichts geschrieben; Rest nur als .unverified (0600) in Ordnern 0700 im übergebenen Sicherungsziel, Wiederholung No-op', async () => {
  // Negativkontrolle: die Rechteprüfung schlägt bei einer künstlich auf 0644 gesetzten Kopie an.
  const control = join(tempDir(), 'kontrolle.db.unverified');
  writeFileSync(control, 'x', { mode: 0o600 });
  assertMode(control, 0o600);
  chmodSync(control, 0o644);
  assert.throws(() => assertMode(control, 0o600), assert.AssertionError);
  const windows = {
    'Digest → Kopie': [/Inhalt der Kopie weicht ab/, (write) => ({ statfs: (path) => { write(); return statfsSync(path); } })],
    'Kopie → Prüfung': [/Schema der Kopie weicht ab/, (write) => ({ afterCopy: write })],
  };
  for (const [window, [reason, hook]] of Object.entries(windows)) {
    const { dir, db, migrationsDir, set } = await migratedWithNext('race_table', RACE_TABLE);
    const columns = tableColumns(db);
    const business = contentDigest(db);
    const backups = join(dir, 'backups');
    // wie der CLI-Runner: Kopien entstehen in <Sicherungsziel>/.partial-<token>
    const staging = join(backups, '.partial-t-d2-1');
    let winner = null;
    const error = await errorCode(() => runMigrations(db, { migrationsDir, backup: { dir: staging, ...hook(() => { winner = winnerWrites(db, set, HEAD); }) } }));
    assert.equal(error?.code, 'BACKUP_FAILED', window);
    assert.equal(error.exitCode, 15);
    assert.match(error.message, reason, window);
    assert.match(error.message, /Kopie als \.unverified abgelegt/, window);
    assertWinnerKept(db, winner, business, columns);
    const rest = readdirSync(staging);
    assert.equal(rest.length, 1, `${window}: ${rest.join(', ')}`);
    assert.match(rest[0], /^pre-.*\.db\.unverified$/, window);
    assert.deepEqual(readdirSync(backups), ['.partial-t-d2-1'], `${window}: keine geprüfte Sicherung, nichts sonst im Ziel`);
    assert.deepEqual(readdirSync(dir).filter(f => f !== 'backups' && !/^crm\.db(-wal|-shm)?$/.test(f)), [], `${window}: keine Kopie außerhalb des Sicherungsziels`);
    assertMode(backups, 0o700, `${window}: Sicherungsziel`);
    assertMode(staging, 0o700, `${window}: Arbeitsordner`);
    assertMode(join(staging, rest[0]), 0o600, `${window}: .unverified`);
    const again = await runMigrations(db, { migrationsDir, backup: { dir: staging } });
    assert.deepEqual(again.actions, [], `${window}: Wiederholung No-op`);
    assert.deepEqual(readdirSync(staging), rest, `${window}: keine weitere Kopie`);
    db.close();
  }
});

/**
 * Die Voreinordnung liest ohne Lesetransaktion (Autocommit, Anweisung für
 * Anweisung). `interleaved` lässt den schnelleren Runner genau nach dem ersten
 * passenden Lesezugriff festschreiben — so wie ein anderer Prozess es zwischen
 * zwei Anweisungen kann. Fail-closed: der langsamere schreibt nichts.
 */
function interleaved(db, { prepare = () => false, pragma = () => false }, winner) {
  let fired = false;
  const fire = (target) => {
    if (fired) return;
    fired = true;
    winner(target);
  };
  return new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') {
        return (sql) => {
          const statement = target.prepare(sql);
          if (fired || !prepare(sql)) return statement;
          return new Proxy(statement, {
            get(stmt, name) {
              const value = Reflect.get(stmt, name);
              if (typeof value !== 'function') return value;
              return (...args) => {
                const result = value.apply(stmt, args);
                if (name === 'get' || name === 'all') fire(target);
                return result;
              };
            },
          });
        };
      }
      if (key === 'pragma') {
        return (source, options) => {
          const result = target.pragma(source, options);
          if (pragma(source)) fire(target);
          return result;
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const LEDGER_ROWS = sql => sql.startsWith('SELECT version, name, checksum, applied_at, kind, legacy_variant FROM schema_migrations');
for (const [code, window, hook, pattern] of [
  ['CORRUPT_LEDGER', 'Ledger-Zeilen und user_version', { prepare: LEDGER_ROWS }, new RegExp(`user_version=${HEAD + 1}, aber Ledger-Stand ${HEAD}`)],
  ['SCHEMA_DRIFT', 'user_version und Schemaabgleich', { pragma: source => source === 'user_version' }, /idx_race_leads_notes/],
]) {
  test(`Voreinordnung: anderer Runner schreibt eine Folgemigration zwischen ${window} → ${code} (Exit 11), nichts geschrieben, Wiederholung No-op`, async () => {
    const { dir, db, migrationsDir, set } = await migratedWithNext('race_index', RACE_INDEX);
    assert.ok(loserFailureCodes(migrationsDir, { from: HEAD, ledger: true }).includes(code));
    const columns = tableColumns(db);
    const business = contentDigest(db);
    let winner = null;
    const backups = join(dir, 'backups');
    const loser = interleaved(db, hook, (conn) => { winner = winnerWrites(conn, set, HEAD); });
    const error = await errorCode(() => runMigrations(loser, { migrationsDir, backup: { dir: backups } }));
    assert.equal(error?.code, code);
    assert.equal(error.exitCode, 11);
    assert.match(error.message, pattern);
    assertWinnerKept(db, winner, business, columns);
    assert.deepEqual(readdirSync(dir).filter(f => f === 'backups'), [], 'vor jeder Sicherung abgebrochen');
    const again = await runMigrations(db, { migrationsDir, backup: { dir: backups } });
    assert.deepEqual(again.actions, [], 'Wiederholung: No-op');
    db.close();
  });
}

test('Voreinordnung: anderer Runner übernimmt zwischen Ledger-Prüfung und user_version → UNKNOWN_SCHEMA (Exit 12), nichts geschrieben, Wiederholung No-op — auch nur mit der Baseline', async () => {
  // Rest-Fenster der PXK-113-Zusicherung „alle 0“: zwei aufeinanderfolgende Anweisungen in classify.
  const dir = tempDir();
  const db = buildLegacy(join(dir, 'crm.db'), 'S5');
  insertSyntheticRows(db);
  const columns = tableColumns(db);
  const business = contentDigest(db);
  const migrationsDir = baselineOnlyDir();
  const set = loadMigrations(migrationsDir);
  let winner = null;
  const backups = join(dir, 'backups');
  const loser = interleaved(db, { prepare: sql => sql === "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?" }, (conn) => { winner = winnerWrites(conn, set, 0); });
  const error = await errorCode(() => runMigrations(loser, { migrationsDir, backup: { dir: backups } }));
  assert.equal(error?.code, 'UNKNOWN_SCHEMA');
  assert.equal(error.exitCode, 12);
  assert.match(error.message, /user_version=1 ohne Ledger/);
  assertWinnerKept(db, winner, business, columns);
  assert.deepEqual(ledgerRows(db), ledgerFor(set.migrations, 'S5'));
  const again = await runMigrations(db, { migrationsDir, backup: { dir: backups } });
  assert.deepEqual(again.actions, [], 'Wiederholung: No-op');
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

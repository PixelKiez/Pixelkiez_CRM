import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forbiddenReason, splitStatements } from '../../lib/db/sql-split.mjs';

const verdicts = (sql) => splitStatements(sql).map(s => (forbiddenReason(s) ? 'verboten' : 'ok'));

test('Semikolons in Zeichenketten, Bezeichnern und Kommentaren trennen nicht', () => {
  const statements = splitStatements("INSERT INTO t VALUES ('a;b', \"c;d\"); -- e;\n/* f; */ SELECT [g;h]");
  assert.equal(statements.length, 2);
  assert.equal(statements[0].sql, "INSERT INTO t VALUES ('a;b', \"c;d\")");
  assert.equal(statements[1].sql, 'SELECT [g;h]');
});

test('Trigger endet erst an END; — auch mit CASE … END im Körper', () => {
  const statements = splitStatements('CREATE TEMP TRIGGER tr AFTER UPDATE ON x BEGIN UPDATE x SET a = CASE WHEN 1 THEN 2 END; SELECT 1; END; CREATE TABLE y (a);');
  assert.equal(statements.length, 2);
  assert.match(statements[0].sql, /END$/);
  assert.deepEqual(verdicts('CREATE TRIGGER tr AFTER INSERT ON x BEGIN SELECT 1; END;'), ['ok']);
});

test('Transaktionssteuerung und gesperrte PRAGMAs werden erkannt', () => {
  for (const sql of ['BEGIN', 'BEGIN IMMEDIATE', 'COMMIT', 'END', 'end transaction', 'ROLLBACK', 'SAVEPOINT s', 'RELEASE s', 'VACUUM', "ATTACH 'x' AS y", 'DETACH y',
    'PRAGMA journal_mode = WAL', 'PRAGMA main.journal_mode = WAL', 'PRAGMA foreign_keys = OFF', 'PRAGMA user_version = 1.5', 'PRAGMA writable_schema = 1', 'PRAGMA locking_mode = EXCLUSIVE']) {
    assert.deepEqual(verdicts(`${sql};`), ['verboten'], sql);
  }
  for (const sql of ['PRAGMA optimize', 'CREATE TABLE begin_log (x)', "INSERT INTO t VALUES ('COMMIT')", 'SELECT 1']) {
    assert.deepEqual(verdicts(`${sql};`), ['ok'], sql);
  }
});

test('PRAGMAs: nur prüfende und defer_foreign_keys; Namen auch in Anführungszeichen erkannt', () => {
  for (const sql of ['PRAGMA [user_version] = 42', "PRAGMA 'locking_mode' = EXCLUSIVE", 'PRAGMA `foreign_keys` = OFF', 'PRAGMA main."journal_mode" = DELETE',
    'PRAGMA ignore_check_constraints = 1', 'PRAGMA query_only = 1', 'PRAGMA recursive_triggers = 1', 'PRAGMA', 'PRAGMA legacy_alter_table = ON']) {
    assert.deepEqual(verdicts(`${sql};`), ['verboten'], sql);
  }
  for (const sql of ['PRAGMA defer_foreign_keys = ON', 'PRAGMA foreign_key_check', 'PRAGMA main.integrity_check', "PRAGMA table_info('leads')", 'PRAGMA "optimize"']) {
    assert.deepEqual(verdicts(`${sql};`), ['ok'], sql);
  }
});

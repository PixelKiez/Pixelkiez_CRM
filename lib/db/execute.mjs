/**
 * Ausführung einer Migration: Anweisung für Anweisung in der offenen
 * Transaktion des Runners, und der Probelauf auf einer Kopie im Speicher.
 */
import Database from 'better-sqlite3';
import { MigrationError } from './errors.mjs';

/**
 * Führt eine Migration Anweisung für Anweisung in der offenen Transaktion aus.
 * Nach jeder Anweisung muss die Transaktion noch offen sein — das fängt auch
 * Transaktionssteuerung, die an der statischen Prüfung vorbeikäme
 * (z. B. `COMMIT; BEGIN;`), genau an der Stelle ab, an der sie wirkt.
 *
 * - MIGRATION_FAILED: eine Anweisung scheiterte; die Transaktion ist noch offen
 *   oder wurde von SQLite vollständig zurückgerollt (z. B. RAISE(ROLLBACK)).
 * - TX_CONTROL_IN_MIGRATION: eine Anweisung hat die Transaktion beendet; was
 *   davor lag, ist womöglich bereits festgeschrieben.
 */
export function execStatements(conn, migration) {
  migration.statements.forEach((statement, index) => {
    try {
      conn.exec(statement.sql);
    } catch (error) {
      const scope = conn.inTransaction ? '' : ' — Transaktion von SQLite vollständig zurückgerollt';
      throw new MigrationError('MIGRATION_FAILED', migration.name, `Anweisung ${index + 1}: ${error.message}${scope}`);
    }
    if (!conn.inTransaction) {
      throw new MigrationError('TX_CONTROL_IN_MIGRATION', migration.name, `Anweisung ${index + 1} beendet die Transaktion des Runners`);
    }
  });
}

/** Probelauf ausstehender Migrationen auf einer Kopie im Speicher. */
export function dryRun(set, appliedHead, pending) {
  const mem = new Database(':memory:');
  try {
    mem.pragma('foreign_keys = ON');
    for (const m of set.migrations.slice(0, appliedHead)) mem.exec(m.text);
    for (const m of pending) {
      try {
        mem.transaction(() => execStatements(mem, m)).immediate();
      } catch (error) {
        if (error instanceof MigrationError && error.code === 'MIGRATION_FAILED') {
          throw new MigrationError('MIGRATION_FAILED', m.name, `Probelauf: ${error.detail}`);
        }
        if (error instanceof MigrationError) throw error;
        // z. B. aufgeschobene Fremdschlüssel, die erst beim COMMIT scheitern
        throw new MigrationError('MIGRATION_FAILED', m.name, `Probelauf: ${error.message}`);
      }
    }
  } finally {
    mem.close();
  }
}

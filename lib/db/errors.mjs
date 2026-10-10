/**
 * Stabile Fehlercodes des Migrationssystems und ihre Exit-Codes.
 * Ausgabeformat: `PXK-DB [CODE] <Migration oder Objekt>: <Detail>` —
 * nur Codes, Namen, Zahlen und Prüfsummen, nie Zeileninhalte.
 */

export const EXIT_CODES = {
  USAGE: 2,
  // statische Prüfung der Migrationsdateien
  NO_MIGRATIONS: 10,
  MALFORMED_FILENAME: 10,
  DUPLICATE_VERSION: 10,
  VERSION_GAP: 10,
  FORBIDDEN_STATEMENT: 10,
  LEGACY_DEFINITION_INVALID: 10,
  // Ledger und Historie
  LEDGER_SCHEMA_INVALID: 11,
  CORRUPT_LEDGER: 11,
  LEDGER_GAP: 11,
  LEDGER_AHEAD_OF_FILES: 11,
  RENAMED_OR_REORDERED: 11,
  CHECKSUM_MISMATCH: 11,
  SCHEMA_DRIFT: 11,
  DB_NOT_MIGRATED: 11,
  MIGRATIONS_PENDING: 11,
  // Einordnung verweigert
  UNKNOWN_SCHEMA: 12,
  LEGACY_OUTDATED: 12,
  ADOPT_FLAG_MISMATCH: 12,
  FRESH_DB_IN_PRODUCTION: 12,
  STATE_CHANGED: 12,
  // Migration zurückgerollt
  IN_TRANSACTION: 13,
  MIGRATION_FAILED: 13,
  TX_CONTROL_IN_MIGRATION: 13,
  FK_VIOLATION: 13,
  ADOPTION_VERIFY_FAILED: 13,
  DATA_DIGEST_MISMATCH: 13,
  // Transaktion verlassen — Wiederherstellung nötig
  PARTIAL_APPLY_RESTORE_REQUIRED: 14,
  // Sicherung
  BACKUP_DESTINATION_REQUIRED: 15,
  BACKUP_FAILED: 15,
  BACKUP_STALE: 15,
  // Seeds
  SEED_SOURCE_MISSING: 16,
  SEED_FAILED: 16,
  // Laufzeit — geprüft, bevor better-sqlite3 geladen wird
  UNSUPPORTED_RUNTIME: 17,
};

export class MigrationError extends Error {
  /**
   * @param {keyof typeof EXIT_CODES} code
   * @param {string} subject Migration oder Objekt, auf das sich der Fehler bezieht
   * @param {string} detail
   */
  constructor(code, subject, detail) {
    super(`PXK-DB [${code}] ${subject}: ${detail}`);
    this.name = 'MigrationError';
    this.code = code;
    this.subject = subject;
    this.detail = detail;
    this.exitCode = EXIT_CODES[code] ?? 1;
  }
}

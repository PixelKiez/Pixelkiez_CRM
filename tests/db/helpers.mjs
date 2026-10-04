/**
 * Hilfen für die Datenbank-Tests (node:test). Jede Prüfung arbeitet auf einer
 * eigenen Datei im Temp-Verzeichnis; es fließen keine echten Daten ein.
 */
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../../lib/db/open.mjs';
import { LEGACY_VARIANTS } from '../../lib/db/legacy.mjs';
import { splitStatements } from '../../lib/db/sql-split.mjs';

// Der Runner leitet Produktionsregeln aus der Umgebung ab. Tests setzen sie
// ausdrücklich (production: true bzw. env im Kindprozess), damit eine
// Entwickler- oder CI-Shell mit NODE_ENV/RAILWAY_* das Ergebnis nicht ändert.
for (const name of Object.keys(process.env)) {
  if (name === 'NODE_ENV' || name.startsWith('RAILWAY_')) delete process.env[name];
}

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const MIGRATIONS_DIR = join(ROOT, 'db', 'migrations');
export const GOLDEN = JSON.parse(readFileSync(join(ROOT, 'tests/db/fixtures/schema-cd2c098.json'), 'utf8'));

const created = [];
process.on('exit', () => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/** Eigenes Temp-Verzeichnis; wird am Ende des Testprozesses entfernt. */
export function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'pxk113-test-'));
  created.push(dir);
  return dir;
}

/** Kopie des Migrationsordners, optional mit zusätzlichen oder geänderten Dateien. */
export function migrationsCopy(extra = {}) {
  const dir = tempDir();
  for (const file of readdirSync(MIGRATIONS_DIR)) copyFileSync(join(MIGRATIONS_DIR, file), join(dir, file));
  for (const [name, text] of Object.entries(extra)) writeFileSync(join(dir, name), text);
  return dir;
}

/** Anweisungen des Altstands, so wie der alte Code sie ausgeführt hat (IF NOT EXISTS). */
const legacyStatements = splitStatements(readFileSync(join(ROOT, 'tests/db/fixtures/legacy-cd2c098.sql'), 'utf8')).map(s => s.sql);

/** Baut einen Altstand S1–S5 aus der unabhängigen Fixture-SQL. */
export function buildLegacy(path, variant = 'S5') {
  const db = openDatabase(path, 'apply');
  for (const n of LEGACY_VARIANTS[variant].statements) db.exec(legacyStatements[n - 1]);
  return db;
}

/** Füllt jede vorhandene Tabelle mit synthetischen Zeilen (alle Spalten, eindeutige Werte). */
export function insertSyntheticRows(db, rowsPerTable = 3) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 7) <> 'sqlite_' AND name <> 'schema_migrations' ORDER BY name").all().map(r => r.name);
  for (const table of tables) {
    const columns = db.prepare('SELECT name, type, pk FROM pragma_table_info(?) ORDER BY cid').all(table)
      .filter(c => !(c.pk === 1 && c.type.toUpperCase() === 'INTEGER'));
    const insert = db.prepare(`INSERT INTO ${table} (${columns.map(c => c.name).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
    for (let i = 1; i <= rowsPerTable; i += 1) {
      insert.run(...columns.map(c => (c.type.toUpperCase() === 'INTEGER' ? i * 7 : `${table}-${c.name}-${i}`)));
    }
  }
}

export function ledgerRows(db) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  return exists ? db.prepare('SELECT version, name, kind, legacy_variant FROM schema_migrations ORDER BY version').all() : null;
}

/** Fängt einen MigrationError und gibt seinen Code zurück (oder wirft weiter). */
export async function errorCode(fn) {
  try {
    await fn();
  } catch (error) {
    if (error?.code && error.name === 'MigrationError') return error;
    throw error;
  }
  return null;
}

/**
 * Formal gültige Datei (vollständiger Kopf, ganze Seite) — der Kopf verspricht
 * aber zwei Seiten: Die Vorprüfung vor dem Öffnen (lib/db/open.mjs) lässt sie
 * durch, SQLite meldet erst beim Lesen SQLITE_CORRUPT. Mit `wal` im WAL-Format
 * (Bytes 18/19 = 2): SQLite legt dann -wal/-shm an, bevor es scheitert.
 */
export function corruptButStructured({ wal = false } = {}) {
  const page = Buffer.alloc(4096);
  Buffer.from('SQLite format 3\0', 'latin1').copy(page);
  page.writeUInt16BE(4096, 16);
  page[18] = page[19] = wal ? 2 : 1;
  page[21] = 64; page[22] = 32; page[23] = 32;
  page.writeUInt32BE(1, 24); // Änderungszähler
  page.writeUInt32BE(2, 28); // Seitenzahl laut Kopf (die Datei hat eine)
  page.writeUInt32BE(1, 92); // Kopf gilt für Änderungszähler 1
  return page;
}

/**
 * D1-kompatibler Datenbank-Adapter für Node.js (Railway) über better-sqlite3.
 * Stellt dieselbe Schnittstelle bereit wie Cloudflare D1:
 *   prepare(sql)                -> { run(), all<T>(), first<T>(), bind(...args) }
 *   prepare(sql).bind(...args)  -> { run(), all<T>(), first<T>() }
 *   batch(statements)
 */
import type Database from 'better-sqlite3';
import { existsSync, statSync } from 'node:fs';
import { MigrationError } from '@/lib/db/errors.mjs';
import { checkLedger, defaultMigrationsDir, loadMigrations, verifyHead } from '@/lib/db/migrate.mjs';
import { openDatabase, resolveDbPath } from '@/lib/db/open.mjs';

let connection: Database.Database | null = null;

/**
 * Nur lesend: Die Datenbank ist migrationsverwaltet, keine Migration steht aus,
 * und ihr Schema gleicht exakt dem Stand nach allen Dateien in db/migrations.
 * Repariert nichts — Schema, Ledger und Startdaten legt ausschließlich der
 * Pre-Start-Schritt `node scripts/db-migrate.mjs` an (npm start, PXK-113).
 */
export function verifyMigrated(db: Database.Database) {
  verifyHead(db);
  checkLedger(db, loadMigrations(defaultMigrationsDir()), { full: true });
}

/**
 * Öffnet die Datenbank beim ersten Zugriff, nicht beim Import.
 *
 * `next build` importiert jede Route in parallelen Workern, um deren Exporte
 * einzulesen. Wurde die Verbindung auf Modulebene aufgebaut, schrieben alle
 * Worker gleichzeitig `PRAGMA journal_mode = WAL` und der Build brach mit
 * "database is locked" ab.
 *
 * Erst wird schreibgeschützt geprüft, dann für Requests geöffnet: Eine fehlende,
 * leere oder nicht migrierte Datei wird so nie angelegt oder beschrieben — auch
 * nicht durch den Header, den das Umschalten auf WAL in eine leere Datei schreibt.
 * Eine leere Datei wird gar nicht erst geöffnet: SQLite verwirft beim Öffnen
 * (auch schreibgeschützt) ein daneben liegendes -wal. Scheitert die Prüfung,
 * bleibt keine Verbindung zurück; der nächste Zugriff prüft erneut.
 */
export function getSqlite(): Database.Database {
  if (connection) return connection;
  const path = resolveDbPath();
  if (!existsSync(path)) {
    throw new MigrationError('DB_NOT_MIGRATED', path, 'Datenbankdatei fehlt — vor dem Start npm run db:migrate ausführen');
  }
  if (statSync(path).size === 0) {
    throw new MigrationError('DB_NOT_MIGRATED', path, 'Datenbankdatei ist leer — vor dem Start npm run db:migrate ausführen');
  }
  const probe = openDatabase(path, 'inspect');
  try {
    verifyMigrated(probe);
  } finally {
    probe.close();
  }
  connection = openDatabase(path, 'app');
  return connection;
}

type Row = Record<string, unknown>;
type RunResult = { success: boolean };
type AllResult<T> = { results: T[] };

function executors(stmt: Database.Statement) {
  return {
    run: (): RunResult => {
      stmt.run();
      return { success: true };
    },
    all: async <T = Row>(): Promise<AllResult<T>> => ({ results: stmt.all() as T[] }),
    first: async <T = Row>(): Promise<T | null> => (stmt.get() as T | undefined) ?? null,
  };
}

type BoundStatement = ReturnType<typeof executors>;

class PreparedStmt implements BoundStatement {
  private bound: BoundStatement;
  readonly run: BoundStatement['run'];
  readonly all: BoundStatement['all'];
  readonly first: BoundStatement['first'];

  constructor(private stmt: Database.Statement, args?: unknown[]) {
    this.bound = args ? this.makeBound(args) : executors(this.stmt);
    this.run = this.bound.run;
    this.all = this.bound.all;
    this.first = this.bound.first;
  }

  private makeBound(args: unknown[]): BoundStatement {
    return {
      run: () => {
        this.stmt.run(...(args as never[]));
        return { success: true };
      },
      all: async <T = Row>(): Promise<AllResult<T>> => ({ results: this.stmt.all(...(args as never[])) as T[] }),
      first: async <T = Row>(): Promise<T | null> => (this.stmt.get(...(args as never[])) as T | undefined) ?? null,
    };
  }

  bind(...args: unknown[]): BoundStatement {
    return this.makeBound(args);
  }
}

export function prepare(sql: string): PreparedStmt {
  return new PreparedStmt(getSqlite().prepare(sql));
}

/** Führt mehrere gebundene Statements in einer Transaktion aus (wie D1 batch). */
export async function batch(statements: Array<{ run: () => unknown }>): Promise<void> {
  getSqlite().transaction(() => {
    for (const statement of statements) statement.run();
  })();
}

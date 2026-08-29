/**
 * D1-kompatibler Datenbank-Adapter für Node.js (Railway) über better-sqlite3.
 * Stellt dieselbe Schnittstelle bereit wie Cloudflare D1:
 *   prepare(sql)                -> { run(), all<T>(), first<T>(), bind(...args) }
 *   prepare(sql).bind(...args)  -> { run(), all<T>(), first<T>() }
 *   batch(statements)
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const dbPath = process.env.SQLITE_PATH || resolve(process.cwd(), 'data', 'crm.db');

let connection: Database.Database | null = null;

/**
 * Öffnet die Datenbank beim ersten Zugriff, nicht beim Import.
 *
 * `next build` importiert jede Route in parallelen Workern, um deren Exporte
 * einzulesen. Wurde die Verbindung auf Modulebene aufgebaut, schrieben alle
 * Worker gleichzeitig `PRAGMA journal_mode = WAL` und der Build brach mit
 * "database is locked" ab.
 */
export function getSqlite(): Database.Database {
  if (connection) return connection;
  mkdirSync(dirname(dbPath), { recursive: true });
  connection = new Database(dbPath);
  connection.pragma('journal_mode = WAL');
  // Statt sofort zu scheitern, kurz auf einen belegten Schreib-Lock warten.
  connection.pragma('busy_timeout = 8000');
  connection.pragma('foreign_keys = ON');
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

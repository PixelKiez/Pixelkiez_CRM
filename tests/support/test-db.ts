/**
 * Wegwerf-Datenbank je Test (PXK-114).
 *
 * Jede Fixture ist eine eigene Datei in einem eigenen mkdtemp-Ordner unter
 * os.tmpdir(), aufgebaut über den echten Migrationsweg (openDatabase 'apply' +
 * runMigrations, alle Dateien in db/migrations). Danach zeigt SQLITE_PATH auf
 * die Fixture, und vi.resetModules() sorgt dafür, dass der nächste Import von
 * lib/d1-node eine neue Modulinstanz ohne gecachte Verbindung liefert.
 *
 * Route-Handler deshalb immer NACH createTestDb() dynamisch importieren:
 *   const db = await createTestDb({ agentKey: 'k' });
 *   const r = await loadAgentRoutes();
 *
 * Regeln: nie crm.db, -wal oder -shm per fs lesen/kopieren, solange eine
 * Verbindung offen ist (PXK-113 D1) — Zustand nur per SQL zurücklesen.
 * Fehlerinjektion (Trigger) erst nach db.app(), sonst SCHEMA_DRIFT.
 */
import type Database from 'better-sqlite3';
import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { vi } from 'vitest';
import { classifyEnvironment } from '@/lib/db/environment.mjs';
import { defaultMigrationsDir, runMigrations } from '@/lib/db/migrate.mjs';
import { openDatabase, resolveDbPath, sqlitePath } from '@/lib/db/open.mjs';

export const ROOT = resolve(import.meta.dirname, '..', '..');
export const MIGRATIONS_DIR = defaultMigrationsDir(ROOT);
/** Pfad, auf den SQLITE_PATH ohne Fixture zeigt (vitest.config.mts); existiert nie. */
export const NO_FIXTURE_SQLITE_PATH = process.env.PXK114_NO_FIXTURE_SQLITE_PATH ?? '';

type Cell = string | number | null | undefined;
export type SeedLead = { id: string; name: string } & Record<string, Cell>;
export type SeedActivity = { lead_id: string; type: string; created_at: string } & Record<string, Cell>;

export type TestDbOptions = {
  /** settings.agent_api_key; ohne Angabe bleibt die Agent-API deaktiviert (503, sofern AGENT_API_KEY fehlt). */
  agentKey?: string;
  /** weitere/abweichende settings-Zeilen, z. B. { agent_api_key: null } */
  settings?: Record<string, string | null>;
  leads?: SeedLead[];
  activities?: SeedActivity[];
  /** läuft nach Migration und Seeds auf der Setup-Verbindung, bevor die App die Datei je sieht (z. B. Schema-Drift erzeugen) */
  beforeApp?: (db: Database.Database) => void;
};

type D1Module = typeof import('@/lib/d1-node');

export type TestDb = {
  dir: string;
  path: string;
  /** dieselbe lib/d1-node-Instanz wie die danach importierten Handler */
  d1: D1Module;
  /** Verbindung der App; öffnet (und prüft) sie beim ersten Aufruf. */
  app: () => Database.Database;
  all: <T = Record<string, unknown>>(sql: string, ...params: unknown[]) => T[];
  get: <T = Record<string, unknown>>(sql: string, ...params: unknown[]) => T | undefined;
  /** Schreibt über die App-Verbindung, z. B. einen Trigger zur Fehlerinjektion (nach dem ersten Zugriff: sonst SCHEMA_DRIFT). */
  exec: (sql: string) => void;
  run: (sql: string, ...params: unknown[]) => void;
  count: (table: 'leads' | 'activities' | 'settings' | 'email_templates') => number;
  /** leads + activities + settings, für „nichts geschrieben“-Vergleiche */
  snapshot: () => { leads: unknown[]; activities: unknown[]; settings: unknown[] };
  dispose: () => void;
  [Symbol.dispose]: () => void;
};

type Disposable = { dispose: () => void };
const live = new Set<Disposable>();

function isInside(child: string, parent: string) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}

/** realpath des nächsten existierenden Vorfahren + Rest (Symlinks wie /var → /private/var aufgelöst). */
export function physical(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = resolve(absolute, '..');
    return parent === absolute ? absolute : join(physical(parent), basename(absolute));
  }
}

/**
 * Wirft, wenn diese Umgebung nach Produktion aussieht oder der Pfad nicht unter os.tmpdir(), im Repo oder auf ./data/crm.db liegt.
 * Geprüft wird die Datei, die SQLite tatsächlich öffnete (sqlitePath: Symlinks vor „..“, auch Verweise ins Leere).
 */
export function assertSafeFixturePath(path: string) {
  const env = classifyEnvironment(process.env);
  if (env.production) throw new Error(`PXK-114 Testfixture verweigert: Produktionssignal (${env.reasons.join(', ')})`);
  if (!path || !isAbsolute(path)) throw new Error(`PXK-114 Testfixture verweigert: Pfad ${JSON.stringify(path)} ist leer oder relativ`);
  const target = sqlitePath(path);
  if (target === null) throw new Error(`PXK-114 Testfixture verweigert: ${path} enthält einen Verweis, den SQLite anders liest als Node`);
  const real = physical(target);
  const repo = physical(ROOT);
  if (real === physical(resolveDbPath({} as NodeJS.ProcessEnv, ROOT))) throw new Error(`PXK-114 Testfixture verweigert: ${path} ist die Standard-Datenbank`);
  if (isInside(real, repo)) throw new Error(`PXK-114 Testfixture verweigert: ${path} liegt im Repository`);
  if (!isInside(real, physical(tmpdir()))) throw new Error(`PXK-114 Testfixture verweigert: ${path} liegt nicht unter os.tmpdir()`);
  // Nur stat (nie öffnen): ein harter Link teilt die Datei, gleich unter welchem Pfad.
  const existing = statSync(real, { throwIfNoEntry: false });
  const standard = statSync(resolveDbPath({} as NodeJS.ProcessEnv, ROOT), { throwIfNoEntry: false });
  if (existing && standard && existing.dev === standard.dev && existing.ino === standard.ino) {
    throw new Error(`PXK-114 Testfixture verweigert: ${path} ist die Standard-Datenbank (harter Link)`);
  }
  if (existing?.isFile() && existing.nlink > 1) throw new Error(`PXK-114 Testfixture verweigert: ${path} hat weitere harte Links`);
}

/** Leerer Ordner unter os.tmpdir(), den disposeAll() wieder entfernt. */
export function createScratchDir(prefix = 'pxk114-scratch-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  live.add({ dispose: () => rmSync(dir, { recursive: true, force: true }) });
  return dir;
}

/** Migriert (und befüllt) eine Datenbank an `path` über den echten Migrationsweg; die Setup-Verbindung ist danach zu. */
export async function migrateFixture(path: string, options: TestDbOptions = {}) {
  assertSafeFixturePath(path);
  const setup = openDatabase(path, 'apply');
  try {
    await runMigrations(setup, { migrationsDir: MIGRATIONS_DIR, production: false, backup: false });
    seed(setup, options);
    options.beforeApp?.(setup);
  } finally {
    setup.close();
  }
}

/**
 * Lenkt die App auf `path` (muss unter os.tmpdir() liegen) und liefert eine frische lib/d1-node-Instanz.
 * Für Guard-Tests mit fehlender, leerer oder kaputter Datei; danach importierte Handler sehen denselben Pfad.
 */
export async function pointAppAt(path: string): Promise<D1Module> {
  assertSafeFixturePath(path);
  process.env.SQLITE_PATH = path;
  vi.resetModules();
  live.add({
    dispose: () => {
      if (process.env.SQLITE_PATH === path) process.env.SQLITE_PATH = NO_FIXTURE_SQLITE_PATH;
    },
  });
  return import('@/lib/d1-node');
}

export async function createTestDb(options: TestDbOptions = {}): Promise<TestDb> {
  const dir = mkdtempSync(join(tmpdir(), 'pxk114-fixture-'));
  const path = join(dir, 'crm.db');
  try {
    await migrateFixture(path, options);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }

  process.env.SQLITE_PATH = path;
  vi.resetModules();
  const d1: D1Module = await import('@/lib/d1-node');
  /**
   * getSqlite() liest SQLITE_PATH erst beim ersten Öffnen. Damit diese Fixture nie eine fremde Datei öffnet (auch nicht,
   * wenn inzwischen eine andere Fixture SQLITE_PATH umgelenkt hat), zeigt SQLITE_PATH dabei kurz auf die eigene Datei.
   */
  const onOwnPath = <T>(open: () => T): T => {
    const previous = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = path;
    try {
      return open();
    } finally {
      process.env.SQLITE_PATH = previous ?? NO_FIXTURE_SQLITE_PATH;
    }
  };
  const app = () => {
    const connection = onOwnPath(() => d1.getSqlite());
    // Hat ein Handler die Verbindung zuerst geöffnet, während SQLITE_PATH woanders hinzeigte, lieber laut scheitern als die falsche Datei lesen.
    if (physical(connection.name) !== physical(path)) throw new Error(`PXK-114 Fixture-Verbindung zeigt auf fremde Datei ${connection.name}`);
    return connection;
  };

  let disposed = false;
  const db: TestDb = {
    dir,
    path,
    d1,
    app,
    all: (sql, ...params) => app().prepare(sql).all(...params) as never,
    get: (sql, ...params) => app().prepare(sql).get(...params) as never,
    exec: sql => {
      app().exec(sql);
    },
    run: (sql, ...params) => {
      app().prepare(sql).run(...params);
    },
    count: table => (app().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
    snapshot: () => ({
      leads: app().prepare('SELECT * FROM leads ORDER BY id').all(),
      activities: app().prepare('SELECT * FROM activities ORDER BY id').all(),
      settings: app().prepare('SELECT * FROM settings ORDER BY key').all(),
    }),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      live.delete(db);
      // Handler können die Verbindung geöffnet haben, ohne dass db.app() lief: getSqlite() liefert dann die
      // gecachte. Hat nie jemand geöffnet, öffnet app() hier die eigene Datei (Prüfung + App-Verbindung) und wir schließen sie gleich.
      try {
        app().close();
      } catch {
        /* keine gültige Verbindung (z. B. Fixture absichtlich kaputt): nichts offen */
      }
      if (process.env.SQLITE_PATH === path) process.env.SQLITE_PATH = NO_FIXTURE_SQLITE_PATH;
      vi.resetModules();
      rmSync(dir, { recursive: true, force: true });
    },
    [Symbol.dispose]: () => db.dispose(),
  };
  live.add(db);
  return db;
}

/** Für afterEach: räumt jede noch offene Fixture, jeden Scratch-Ordner und jede Umlenkung weg (neueste zuerst). */
export function disposeAll() {
  for (const item of [...live].reverse()) {
    live.delete(item);
    item.dispose();
  }
  process.env.SQLITE_PATH = NO_FIXTURE_SQLITE_PATH;
}

function insertRow(db: Database.Database, table: string, row: Record<string, unknown>) {
  const columns = Object.keys(row).filter(key => row[key] !== undefined);
  db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...columns.map(key => row[key]));
}

function seed(db: Database.Database, { agentKey, settings = {}, leads = [], activities = [] }: TestDbOptions) {
  const rows: Record<string, string | null> = { ...(agentKey !== undefined ? { agent_api_key: agentKey } : {}), ...settings };
  for (const [key, value] of Object.entries(rows)) insertRow(db, 'settings', { key, value });
  for (const lead of leads) insertRow(db, 'leads', { updated_at: '2026-01-01T00:00:00.000Z', ...lead });
  for (const activity of activities) insertRow(db, 'activities', activity);
}

// Nur über vitest.config.mts laden: ohne Sentinel stünde SQLITE_PATH nach dispose() auf '' (= ./data/crm.db).
assertSafeFixturePath(NO_FIXTURE_SQLITE_PATH);

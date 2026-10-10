/**
 * PXK-114: Schutz des Test-Harness selbst, das Verhalten der App gegenüber fehlender/kaputter Datenbank und die
 * Ratchet der geerbten ESLint-Baseline (eslint-suppressions.json).
 * MigrationError wird über name + code geprüft, nie per instanceof (vi.resetModules bricht Klassenidentität).
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { bearer, callRoute, loadAgentRoutes, probeAll } from '../support/route';
import {
  MIGRATIONS_DIR, NO_FIXTURE_SQLITE_PATH, ROOT, assertSafeFixturePath, createScratchDir, createTestDb, disposeAll, migrateFixture, physical, pointAppAt,
} from '../support/test-db';

const KEY = 'test-agent-key-0123456789';
const AUTH = bearer(KEY);
const REAL_DB = join(ROOT, 'data', 'crm.db');
const MIGRATION_FILES = readdirSync(MIGRATIONS_DIR).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
const HEAD = MIGRATION_FILES.length;
const NEXT = String(HEAD + 1).padStart(4, '0');
/** Existenz, Art, Größe, Inode und mtime von ./data, ./data/crm.db und seinen Nebendateien (nie geöffnet, nur stat). */
function realDbStamp() {
  const out: Record<string, string> = {};
  for (const path of [dirname(REAL_DB), REAL_DB, `${REAL_DB}-wal`, `${REAL_DB}-shm`, `${REAL_DB}-journal`]) {
    const s = statSync(path, { throwIfNoEntry: false });
    out[relative(ROOT, path)] = s ? `${s.isDirectory() ? 'dir' : 'file'} size=${s.isDirectory() ? '-' : s.size} ino=${s.ino} mtime=${s.mtimeMs}` : 'absent';
  }
  return out;
}
let realDbBefore: Record<string, string>;

beforeAll(() => {
  realDbBefore = realDbStamp();
});
afterEach(() => {
  disposeAll();
});
afterAll(() => {
  expect(realDbStamp()).toEqual(realDbBefore);
});

/** Alle sechs Handler mit und ohne AUTH gegen die aktuelle SQLITE_PATH-Lenkung; erwartet überall dieselbe Ablehnung. */
async function expectAllReject(code: string) {
  const r = await loadAgentRoutes();
  for (const headers of [AUTH, {}]) {
    const probe = await probeAll(r, headers);
    expect(Object.values(probe).map(p => p.status)).toEqual(Array(6).fill(`threw:${code}`));
  }
  return r;
}
const sideFiles = (path: string) => ['-wal', '-shm', '-journal'].filter(suffix => existsSync(path + suffix));

describe('Umgebung und Pfade', () => {
  it('H-01 SQLITE_PATH während einer Fixture: absolut, unter os.tmpdir(), nicht ./data', async () => {
    const db = await createTestDb();
    const path = process.env.SQLITE_PATH ?? '';
    expect(path).toBe(db.path);
    expect(isAbsolute(path)).toBe(true);
    expect(physical(path).startsWith(physical(tmpdir()) + '/')).toBe(true);
    expect(physical(path)).not.toBe(physical(REAL_DB));
    expect(physical(path).startsWith(physical(join(ROOT, 'data')) + '/')).toBe(false);
  });
  it("H-02 resolveDbPath({SQLITE_PATH:''}) fällt still auf ./data/crm.db zurück → der Guard verweigert ''", async () => {
    const { resolveDbPath } = await import('@/lib/db/open.mjs');
    expect(resolveDbPath({ SQLITE_PATH: '' } as unknown as NodeJS.ProcessEnv, ROOT)).toBe(REAL_DB);
    expect(() => assertSafeFixturePath('')).toThrow(/leer oder relativ/);
    expect(process.env.SQLITE_PATH).toBeTruthy();
  });
  it('H-03 ./data und ./data/crm.db(-wal/-shm/-journal) werden nie angelegt oder berührt (Existenz, Größe, Inode, mtime; siehe afterAll)', async () => {
    const db = await createTestDb({ agentKey: KEY });
    const r = await loadAgentRoutes();
    expect((await callRoute(r.ping.GET, { headers: AUTH })).status).toBe(200);
    expect((await callRoute(r.leads.POST, { method: 'POST', headers: AUTH, body: { name: 'A' } })).status).toBe(201);
    db.dispose();
    expect(realDbStamp()).toEqual(realDbBefore);
    if (realDbBefore.data === 'absent') expect(existsSync(dirname(REAL_DB))).toBe(false);
  });
  it('H-04 Arbeitsverzeichnis ist die Projektwurzel (defaultMigrationsDir hängt daran)', () => {
    expect(process.cwd()).toBe(ROOT);
  });
  it('H-05 unterstützte Laufzeit (runtimeProblem() === null)', async () => {
    const { runtimeProblem } = await import('@/lib/db/runtime.mjs');
    expect(runtimeProblem()).toBeNull();
  });
  it('H-06 TZ=UTC, Offset 0', () => {
    expect(process.env.TZ).toBe('UTC');
    expect(new Date('2026-07-01T00:00:00Z').getTimezoneOffset()).toBe(0);
    expect(new Date('2026-01-01T00:00:00Z').getTimezoneOffset()).toBe(0);
  });
  it('H-07 keine Schlüssel/Produktionssignale aus der Shell', async () => {
    expect(process.env.AGENT_API_KEY).toBeUndefined();
    expect(process.env.NODE_ENV).toBe('test');
    expect(process.env.DOTENV_SENTINEL).toBeUndefined();
    const leaked = Object.keys(process.env).filter(name => /^(RAILWAY_|SMTP_|GOOGLE_|PXK_DB_)/.test(name) || ['AGENT_API_KEY', 'AUTH_SECRET'].includes(name));
    expect(leaked).toEqual([]);
    const { classifyEnvironment } = await import('@/lib/db/environment.mjs');
    expect(classifyEnvironment(process.env).production).toBe(false);
  });
});

describe('Fixture-Fabrik', () => {
  it('H-08 F0: Ledger = alle Migrationsdateien (applied), user_version = Kopf, keine Daten', async () => {
    const db = await createTestDb();
    expect(db.all('SELECT version, name, kind, legacy_variant FROM schema_migrations ORDER BY version')).toEqual(
      MIGRATION_FILES.map((file, i) => ({ version: i + 1, name: file.slice(0, -4), kind: 'applied', legacy_variant: null })),
    );
    expect(db.app().pragma('user_version', { simple: true })).toBe(HEAD);
    expect([db.count('leads'), db.count('activities'), db.count('email_templates')]).toEqual([0, 0, 0]);
  });
  it('H-09 zwei Fixtures gleichzeitig: getrennte Ordner, Schreiben in A unsichtbar in B, beide beginnen bei PK-0001', async () => {
    const a = await createTestDb({ agentKey: KEY });
    const ra = await loadAgentRoutes();
    const created = await callRoute(ra.leads.POST, { method: 'POST', headers: AUTH, body: { name: 'A' } });
    expect((created.json as { created: Array<{ id: string }> }).created[0].id).toBe('PK-0001');
    const b = await createTestDb({ agentKey: KEY });
    const rb = await loadAgentRoutes();
    expect(b.dir).not.toBe(a.dir);
    expect(b.count('leads')).toBe(0);
    const createdB = await callRoute(rb.leads.POST, { method: 'POST', headers: AUTH, body: { name: 'B' } });
    expect((createdB.json as { created: Array<{ id: string }> }).created[0].id).toBe('PK-0001');
    expect(a.all('SELECT name FROM leads')).toEqual([{ name: 'A' }]);
    expect(b.all('SELECT name FROM leads')).toEqual([{ name: 'B' }]);
  });
  it('H-10 nach Erfolg: SQLITE_PATH ändern ohne Modul-Reset → weiter die alte DB (Verbindung gecacht)', async () => {
    const db = await createTestDb({ agentKey: KEY });
    const r = await loadAgentRoutes();
    expect((await callRoute(r.ping.GET, { headers: AUTH })).status).toBe(200);
    process.env.SQLITE_PATH = NO_FIXTURE_SQLITE_PATH;
    expect((await callRoute(r.ping.GET, { headers: AUTH })).status).toBe(200);
    await callRoute(r.leads.POST, { method: 'POST', headers: AUTH, body: { name: 'noch alte DB' } });
    expect(db.count('leads')).toBe(1);
  });
  it('H-22 Teardown: Verbindung zu, Ordner (db, -wal, -shm) weg, SQLITE_PATH wieder Sentinel', async () => {
    const db = await createTestDb({ agentKey: KEY });
    db.app();
    expect(sideFiles(db.path)).toEqual(['-wal', '-shm']);
    const connection = db.app();
    db.dispose();
    expect(connection.open).toBe(false);
    expect(existsSync(db.dir)).toBe(false);
    expect(process.env.SQLITE_PATH).toBe(NO_FIXTURE_SQLITE_PATH);
  });
});

describe('App gegenüber fehlender/kaputter Datenbank', () => {
  it('H-11 fehlende Datei: alle 6 Handler mit/ohne AUTH → DB_NOT_MIGRATED, nichts angelegt', async () => {
    const path = join(createScratchDir(), 'crm.db');
    await pointAppAt(path);
    const r = await expectAllReject('DB_NOT_MIGRATED');
    const res = await callRoute(r.ping.GET, { headers: AUTH });
    expect(res.thrown?.message).toBe(`PXK-DB [DB_NOT_MIGRATED] ${path}: Datenbankdatei fehlt — vor dem Start npm run db:migrate ausführen`);
    expect(existsSync(path)).toBe(false);
    expect(sideFiles(path)).toEqual([]);
  });
  it('H-12 0-Byte-Datei → DB_NOT_MIGRATED (leer), bleibt 0 Byte, keine Nebendateien', async () => {
    const path = join(createScratchDir(), 'crm.db');
    writeFileSync(path, '');
    await pointAppAt(path);
    const r = await expectAllReject('DB_NOT_MIGRATED');
    expect((await callRoute(r.ping.GET, { headers: AUTH })).thrown?.message).toBe(
      `PXK-DB [DB_NOT_MIGRATED] ${path}: Datenbankdatei ist leer — vor dem Start npm run db:migrate ausführen`,
    );
    expect(statSync(path).size).toBe(0);
    expect(sideFiles(path)).toEqual([]);
  });
  it('H-13 gültige SQLite-Datei ohne Ledger → DB_NOT_MIGRATED schema_migrations', async () => {
    const path = join(createScratchDir(), 'crm.db');
    const { openDatabase } = await import('@/lib/db/open.mjs');
    const raw = openDatabase(path, 'apply');
    raw.exec('CREATE TABLE leads (id TEXT PRIMARY KEY)');
    raw.close();
    await pointAppAt(path);
    const r = await expectAllReject('DB_NOT_MIGRATED');
    expect((await callRoute(r.ping.GET, { headers: AUTH })).thrown?.message).toBe(
      'PXK-DB [DB_NOT_MIGRATED] schema_migrations: Datenbank ist nicht migrationsverwaltet (npm run db:migrate)',
    );
  });
  it('H-14 zusätzliche Tabelle → SCHEMA_DRIFT (Struktur)', async () => {
    await createTestDb({ agentKey: KEY, beforeApp: setup => setup.exec('CREATE TABLE pxk114_extra (id INTEGER PRIMARY KEY)') });
    const r = await expectAllReject('SCHEMA_DRIFT');
    expect((await callRoute(r.ping.GET, { headers: AUTH })).thrown?.message).toBe(
      `PXK-DB [SCHEMA_DRIFT] schema_migrations: Schema weicht vom Stand nach Migration ${HEAD} ab (Struktur): zusätzliche Tabelle: pxk114_extra`,
    );
  });
  it('H-15 Trigger vor dem ersten Öffnen → SCHEMA_DRIFT zusätzlicher Trigger', async () => {
    await createTestDb({
      agentKey: KEY,
      beforeApp: setup => setup.exec("CREATE TRIGGER pxk114_fail_activity BEFORE INSERT ON activities BEGIN SELECT RAISE(ABORT, 'x'); END"),
    });
    const r = await expectAllReject('SCHEMA_DRIFT');
    expect((await callRoute(r.ping.GET, { headers: AUTH })).thrown?.message).toMatch(/^PXK-DB \[SCHEMA_DRIFT\] schema_migrations: .*zusätzlicher Trigger: pxk114_fail_activity$/);
  });
  it('H-16 Trigger nach dem Aufwärmen → kein Fehler, Trigger feuert (Technik aus 2h)', async () => {
    const db = await createTestDb({ agentKey: KEY, leads: [{ id: 'PK-0001', name: 'x' }] });
    const r = await loadAgentRoutes();
    db.app();
    db.exec("CREATE TRIGGER pxk114_fail_activity BEFORE INSERT ON activities BEGIN SELECT RAISE(ABORT, 'PXK114_INJECTED_ACTIVITY_FAILURE'); END");
    expect((await callRoute(r.ping.GET, { headers: AUTH })).status).toBe(200);
    const res = await callRoute(r.activities.POST, { method: 'POST', headers: AUTH, body: { detail: 'x' }, params: { id: 'PK-0001' } });
    expect(res.thrown).toMatchObject({ code: 'SQLITE_CONSTRAINT_TRIGGER', message: 'PXK114_INJECTED_ACTIVITY_FAILURE' });
  });
  it('H-17 Ledger eine Version vor den Dateien → LEDGER_AHEAD_OF_FILES', async () => {
    await createTestDb({
      agentKey: KEY,
      beforeApp: setup => {
        setup.prepare("INSERT INTO schema_migrations (version, name, checksum, applied_at, kind, legacy_variant) VALUES (?, ?, 'x', '2026-01-01T00:00:00.000Z', 'applied', NULL)")
          .run(HEAD + 1, `${NEXT}_future`);
        setup.pragma(`user_version = ${HEAD + 1}`);
      },
    });
    const r = await expectAllReject('LEDGER_AHEAD_OF_FILES');
    expect((await callRoute(r.ping.GET, { headers: AUTH })).thrown?.message).toMatch(/^PXK-DB \[LEDGER_AHEAD_OF_FILES\] schema_migrations: Datenbank steht bei /);
  });
  it('H-18 PRAGMA user_version=0 → CORRUPT_LEDGER', async () => {
    await createTestDb({ agentKey: KEY, beforeApp: setup => setup.pragma('user_version = 0') });
    const r = await expectAllReject('CORRUPT_LEDGER');
    expect((await callRoute(r.ping.GET, { headers: AUTH })).thrown?.message).toBe(`PXK-DB [CORRUPT_LEDGER] schema_migrations: user_version=0, aber Ledger-Stand ${HEAD}`);
  });
  it('H-19 Code kennt eine Migration mehr (cwd-Spy auf Kopie + Probe-Datei) → MIGRATIONS_PENDING', async () => {
    await createTestDb({ agentKey: KEY });
    const fakeRoot = createScratchDir('pxk114-fakeroot-');
    mkdirSync(join(fakeRoot, 'db', 'migrations'), { recursive: true });
    for (const file of MIGRATION_FILES) copyFileSync(join(MIGRATIONS_DIR, file), join(fakeRoot, 'db', 'migrations', file));
    writeFileSync(join(fakeRoot, 'db', 'migrations', `${NEXT}_pxk114_probe.sql`), 'CREATE TABLE pxk114_probe (id INTEGER PRIMARY KEY);\n');
    const r = await loadAgentRoutes();
    const spy = vi.spyOn(process, 'cwd').mockReturnValue(fakeRoot);
    try {
      const res = await callRoute(r.ping.GET, { headers: AUTH });
      expect(res.thrown).toEqual({
        name: 'MigrationError',
        code: 'MIGRATIONS_PENDING',
        message: `PXK-DB [MIGRATIONS_PENDING] ${NEXT}_pxk114_probe: Datenbank steht bei ${HEAD}, Code erwartet ${HEAD + 1} (npm run db:migrate)`,
      });
    } finally {
      spy.mockRestore();
    }
    expect(process.cwd()).toBe(ROOT);
    expect((await callRoute(r.ping.GET, { headers: AUTH })).status).toBe(200);
  });
  it("H-20 Datei mit Inhalt 'not a db' → UNKNOWN_SCHEMA (kürzer als der Dateikopf)", async () => {
    const path = join(createScratchDir(), 'crm.db');
    writeFileSync(path, 'not a db');
    await pointAppAt(path);
    const r = await loadAgentRoutes();
    const res = await callRoute(r.ping.GET, { headers: AUTH });
    expect(res.thrown).toMatchObject({ name: 'MigrationError', code: 'UNKNOWN_SCHEMA', message: expect.stringMatching(/kürzer als der 100-Byte-Dateikopf/) });
    expect(sideFiles(path)).toEqual([]);
  });
  it('H-21 fehlende Datei, danach F0 am selben Pfad → nächster Aufruf gelingt (Fehler wird nicht gecacht)', async () => {
    const path = join(createScratchDir(), 'crm.db');
    await pointAppAt(path);
    const r = await loadAgentRoutes();
    expect((await callRoute(r.ping.GET, { headers: AUTH })).thrown?.code).toBe('DB_NOT_MIGRATED');
    await migrateFixture(path, { agentKey: KEY });
    expect((await callRoute(r.ping.GET, { headers: AUTH })).status).toBe(200);
    const d1 = await import('@/lib/d1-node');
    d1.getSqlite().close();
  });
});

describe('Zusätzliche Harness-Guards (nicht in der Matrix)', () => {
  it('H-X1 ohne Fixture scheitert jeder Handler mit DB_NOT_MIGRATED am Sentinel, nie an ./data/crm.db', async () => {
    expect(process.env.SQLITE_PATH).toBe(NO_FIXTURE_SQLITE_PATH);
    expect(NO_FIXTURE_SQLITE_PATH).toMatch(/pxk114-no-fixture-/);
    vi.resetModules();
    const r = await expectAllReject('DB_NOT_MIGRATED');
    const res = await callRoute(r.ping.GET, { headers: bearer('egal') });
    expect(res.thrown?.message).toBe(`PXK-DB [DB_NOT_MIGRATED] ${NO_FIXTURE_SQLITE_PATH}: Datenbankdatei fehlt — vor dem Start npm run db:migrate ausführen`);
    expect(res.thrown?.message).not.toContain(REAL_DB);
    expect(existsSync(NO_FIXTURE_SQLITE_PATH)).toBe(false);
  });
  it('H-X2 verweigert Fixture-Pfade im Repository, die Standard-Datenbank und Pfade außerhalb von os.tmpdir()', () => {
    expect(() => assertSafeFixturePath(join(ROOT, 'tests', 'x.db'))).toThrow(/liegt im Repository/);
    expect(() => assertSafeFixturePath(REAL_DB)).toThrow(/Standard-Datenbank/);
    expect(() => assertSafeFixturePath(join(ROOT, 'data', '..', 'data', 'crm.db'))).toThrow(/Standard-Datenbank/);
    expect(() => assertSafeFixturePath('/var/empty/pxk114/crm.db')).toThrow(/nicht unter os.tmpdir/);
    expect(() => assertSafeFixturePath('data/crm.db')).toThrow(/leer oder relativ/);
  });
  it('H-X2b prüft die Datei, die SQLite öffnete: Ordner-Symlink mit „..“, Verweise ins Leere (./data/crm.db, außerhalb) und harte Links werden verweigert', () => {
    const dir = createScratchDir();
    // Nur Verweise im Scratch-Ordner; im Repository wird nichts angelegt.
    symlinkSync(join(ROOT, 'data', 'pxk114-sub'), join(dir, 'link'));
    symlinkSync(REAL_DB, join(dir, 'dangling.db'));
    symlinkSync('/var/empty/pxk114-nowhere/crm.db', join(dir, 'outside.db'));
    // Ohne path.join: das kürzte „link/..“ textuell weg, SQLite geht erst durch den Verweis.
    expect(() => assertSafeFixturePath(`${dir}/link/../crm.db`)).toThrow(/Standard-Datenbank/);
    expect(() => assertSafeFixturePath(join(dir, 'dangling.db'))).toThrow(/Standard-Datenbank/);
    expect(() => assertSafeFixturePath(join(dir, 'outside.db'))).toThrow(/nicht unter os.tmpdir/);
    expect(() => assertSafeFixturePath(join(dir, 'plain', 'crm.db'))).not.toThrow();
    expect(existsSync(join(ROOT, 'data', 'pxk114-sub'))).toBe(false);
    writeFileSync(join(dir, 'a.db'), '');
    linkSync(join(dir, 'a.db'), join(dir, 'hard.db'));
    expect(() => assertSafeFixturePath(join(dir, 'hard.db'))).toThrow(/weitere harte Links/);
    expect(statSync(join(dir, 'a.db')).size).toBe(0);
  });
  it('H-X3 verweigert bei Produktionssignal (vi.stubEnv, danach automatisch zurück)', async () => {
    vi.stubEnv('RAILWAY_ENVIRONMENT_NAME', 'production');
    await expect(createTestDb()).rejects.toThrow(/Produktionssignal/);
  });
  it('H-X5 Vitest selbst bricht bei Produktionssignalen aus der Shell ab, statt sie still zu entfernen', () => {
    const vitest = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
    const signals: Array<Record<string, string>> = [{ RAILWAY_ENVIRONMENT_NAME: 'production' }, { NODE_ENV: 'production' }, { RAILWAY_SERVICE_ID: 'pxk114' }];
    for (const signal of signals) {
      const run = spawnSync(process.execPath, [vitest, 'run', '--config', 'vitest.config.mts', 'tests/characterization/lead-sync.test.ts'], {
        cwd: ROOT, encoding: 'utf8', timeout: 120_000, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...signal } as unknown as NodeJS.ProcessEnv,
      });
      expect(run.status, JSON.stringify(signal)).not.toBe(0);
      expect(`${run.stdout}${run.stderr}`).toContain('PXK-114: Tests verweigert, Produktionssignal');
    }
  });
  it('H-X4 Fehler mitten im Fixture-Aufbau (beforeApp wirft) → Ordner entfernt, SQLITE_PATH bleibt Sentinel', async () => {
    let seenDir = '';
    await expect(
      createTestDb({
        beforeApp: setup => {
          seenDir = join(setup.name, '..');
          throw new Error('pxk114 absichtlich');
        },
      }),
    ).rejects.toThrow('pxk114 absichtlich');
    expect(seenDir).toMatch(/pxk114-fixture-/);
    expect(existsSync(seenDir)).toBe(false);
    expect(process.env.SQLITE_PATH).toBe(NO_FIXTURE_SQLITE_PATH);
  });
});

/**
 * Geerbte ESLint-Baseline (PXK-114 A1, main@4b484c19, ESLint 9.39.4): 12 Dateien, 15 Datei+Regel-Einträge, 18 Fehler.
 * Die Datei darf nur schrumpfen (geerbter Fehler behoben + --prune-suppressions), nie wachsen.
 */
const LINT_BASELINE: Record<string, Record<string, number>> = {
  'app/api/email/send/route.ts': { 'prefer-const': 1 }, 'app/components/appointments.tsx': { 'react-hooks/purity': 1 },
  'app/components/insights.tsx': { 'react-hooks/set-state-in-effect': 1, 'react/no-unescaped-entities': 1 },
  'app/components/lead-drawer.tsx': { 'react/no-unescaped-entities': 2 },
  'app/components/leads.tsx': { 'react-hooks/set-state-in-effect': 1 }, 'app/components/profile.tsx': { 'react/no-unescaped-entities': 1 },
  'app/components/settings.tsx': { 'react/no-unescaped-entities': 1 }, 'app/components/templates.tsx': { 'react-hooks/set-state-in-effect': 1 },
  'app/crm-app.tsx': { 'react-hooks/set-state-in-effect': 1, 'react/no-unescaped-entities': 1 },
  'app/dokument/[leadId]/[kind]/page.tsx': { '@next/next/no-html-link-for-pages': 2, 'react/no-unescaped-entities': 2 },
  'app/dokument/[leadId]/[kind]/slides.tsx': { '@next/next/no-html-link-for-pages': 1 }, 'lib/settings.ts': { '@typescript-eslint/no-require-imports': 1 },
};
/** Die drei geerbten Warnungen; --max-warnings=3 in CI lässt keine vierte zu. */
const INHERITED_WARNINGS = ['app/components/settings.tsx react-hooks/exhaustive-deps', 'app/components/templates.tsx react-hooks/exhaustive-deps', 'preview/mock-api.ts @typescript-eslint/no-unused-vars'];
const SUPPRESSION_FLAGS = /--(suppress-all|suppress-rule|prune-suppressions|pass-on-unpruned-suppressions|suppressions-location)\b/;
const ESLINT_BIN = join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');
const LINT_ARGS = ['.', '--ignore-pattern', 'dist', '--ignore-pattern', '.next', '--max-warnings=3'];

/** Ratchet: liefert jeden Verstoß gegen LINT_BASELINE (neue Datei, neue Regel, höhere Anzahl, kaputter Eintrag). */
function ratchetViolations(suppressions: unknown): string[] {
  if (!suppressions || typeof suppressions !== 'object' || Array.isArray(suppressions)) return ['keine JSON-Objekt-Wurzel'];
  const out: string[] = [];
  for (const [file, rules] of Object.entries(suppressions as Record<string, unknown>)) {
    if (!LINT_BASELINE[file]) out.push(`neue Datei: ${file}`);
    for (const [rule, entry] of Object.entries((rules ?? {}) as Record<string, { count?: unknown }>)) {
      const count = entry?.count;
      const allowed = LINT_BASELINE[file]?.[rule];
      if (!Number.isInteger(count) || (count as number) < 1) out.push(`ungültiger Eintrag: ${file} ${rule}`);
      else if (allowed === undefined) out.push(`neue Regel: ${file} ${rule}`);
      else if ((count as number) > allowed) out.push(`gewachsen: ${file} ${rule} ${count} > ${allowed}`);
    }
  }
  return out;
}

const mirrors: string[] = [];
/** Kopie des Arbeitsbaums (getrackt + nicht ignoriert) unter os.tmpdir(), node_modules verlinkt; nie im Repo gelintet. */
function lintMirror() {
  const dir = createScratchDir('pxk114-lint-');
  mirrors.push(dir);
  const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
  expect(listed.status, listed.stderr).toBe(0);
  const files = [...new Set(listed.stdout.split('\0').filter(Boolean))].filter(file => existsSync(join(ROOT, file)));
  expect(files).toContain('eslint-suppressions.json');
  // Eine zusätzliche (vorrangige) ESLint-Konfiguration würde die geschützte eslint.config.mjs still ersetzen.
  expect(files.filter(file => /(^|\/)(eslint\.config\.[cm]?[jt]s|\.eslintrc(\.\w+)?)$/.test(file))).toEqual(['eslint.config.mjs']);
  for (const file of files) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    copyFileSync(join(ROOT, file), join(dir, file));
  }
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}
/** Die echte ESLint-CLI (wie npm run lint) im Spiegel; liefert Exitcode, JSON-Ergebnis und stderr. */
function eslint(cwd: string, args: string[]) {
  const run = spawnSync(process.execPath, [ESLINT_BIN, ...args, '--format', 'json'], { cwd, encoding: 'utf8', timeout: 240_000, maxBuffer: 64 * 1024 * 1024 });
  expect(run.error).toBeUndefined();
  const results = JSON.parse(run.stdout || '[]') as Array<{
    filePath: string; errorCount: number; warningCount: number; messages: Array<{ ruleId: string; severity: number }>;
    suppressedMessages?: Array<{ suppressions?: Array<{ kind: string }> }>;
  }>;
  const sum = (pick: (r: (typeof results)[number]) => number) => results.reduce((n, r) => n + pick(r), 0);
  const list = (severity: number) =>
    results.flatMap(r => r.messages.filter(m => m.severity === severity).map(m => `${relative(physical(cwd), physical(r.filePath))} ${m.ruleId}`)).sort();
  return {
    status: run.status, stderr: run.stderr, errors: list(2), warnings: list(1),
    errorCount: sum(r => r.errorCount), warningCount: sum(r => r.warningCount), suppressed: sum(r => r.suppressedMessages?.length ?? 0),
    /** per Kommentar (eslint-disable…) statt über eslint-suppressions.json unterdrückt */
    directive: sum(r => (r.suppressedMessages ?? []).filter(m => m.suppressions?.some(x => x.kind !== 'file')).length),
  };
}
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, { count: number }>>;
const PREFER_CONST_PROBE = '\nexport function pxk114RatchetProbe() {\n  let probe = 1;\n  return probe;\n}\n';

describe('Lint-Ratchet der geerbten ESLint-Baseline', { timeout: 300_000 }, () => {
  // Läuft vor dem afterEach der Datei (Hooks als Stapel): erst die node_modules-Verknüpfung lösen, dann räumt disposeAll() den Spiegel.
  afterEach(() => {
    for (const dir of mirrors.splice(0)) {
      const link = join(dir, 'node_modules');
      if (lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(link);
    }
  });
  afterAll(() => expect(existsSync(ESLINT_BIN)).toBe(true));
  it('R-01 eslint-suppressions.json liegt innerhalb der Baseline (12 Dateien, 15 Einträge, 18 Fehler; nur Schrumpfen erlaubt)', () => {
    const current = readJson(join(ROOT, 'eslint-suppressions.json'));
    expect(ratchetViolations(current)).toEqual([]);
    const entries = Object.values(current).flatMap(rules => Object.values(rules));
    expect(Object.keys(current).length).toBeLessThanOrEqual(12);
    expect(entries.length).toBeLessThanOrEqual(15);
    expect(entries.reduce((n, e) => n + e.count, 0)).toBeLessThanOrEqual(18);
    const baselineEntries = Object.values(LINT_BASELINE).flatMap(rules => Object.values(rules));
    expect([Object.keys(LINT_BASELINE).length, baselineEntries.length, baselineEntries.reduce((n, c) => n + c, 0)]).toEqual([12, 15, 18]);
  });
  it('R-02 die Ratchet-Prüfung selbst erkennt jedes Wachstum und lässt Schrumpfen zu', () => {
    const base = () => JSON.parse(JSON.stringify(Object.fromEntries(
      Object.entries(LINT_BASELINE).map(([file, rules]) => [file, Object.fromEntries(Object.entries(rules).map(([rule, count]) => [rule, { count }]))]),
    ))) as Record<string, Record<string, { count: number }>>;
    expect(ratchetViolations(base())).toEqual([]);
    const grownCount = base(); grownCount['lib/settings.ts']['@typescript-eslint/no-require-imports'].count = 2;
    const newRule = base(); newRule['lib/settings.ts']['prefer-const'] = { count: 1 };
    const newFile = base(); newFile['tests/characterization/x.test.ts'] = { 'prefer-const': { count: 1 } };
    const broken = base(); broken['app/crm-app.tsx']['react/no-unescaped-entities'] = { count: 0 };
    expect(ratchetViolations(grownCount)).toEqual(['gewachsen: lib/settings.ts @typescript-eslint/no-require-imports 2 > 1']);
    expect(ratchetViolations(newRule)).toEqual(['neue Regel: lib/settings.ts prefer-const']);
    expect(ratchetViolations(newFile)).toEqual(['neue Datei: tests/characterization/x.test.ts', 'neue Regel: tests/characterization/x.test.ts prefer-const']);
    expect(ratchetViolations(broken)).toEqual(['ungültiger Eintrag: app/crm-app.tsx react/no-unescaped-entities']);
    const shrunk = base(); delete shrunk['lib/settings.ts']; shrunk['app/components/lead-drawer.tsx']['react/no-unescaped-entities'].count = 1;
    expect(ratchetViolations(shrunk)).toEqual([]);
  });
  it('R-03 echte CLI wie in CI (npm run lint -- --max-warnings=3): Exit 0, 0 Fehler, nur Baseline-Unterdrückungen, genau die 3 geerbten Warnungen — auch ohne Inline-Konfiguration', () => {
    const dir = lintMirror();
    const baselined = Object.values(readJson(join(ROOT, 'eslint-suppressions.json'))).flatMap(rules => Object.values(rules)).reduce((n, e) => n + e.count, 0);
    const expected = { status: 0, errorCount: 0, suppressed: baselined, directive: 0, warnings: INHERITED_WARNINGS };
    const pick = (res: ReturnType<typeof eslint>) => ({ status: res.status, errorCount: res.errorCount, suppressed: res.suppressed, directive: res.directive, warnings: res.warnings });
    expect(pick(eslint(dir, LINT_ARGS))).toEqual(expected);
    // Ein Kommentar wie /* eslint prefer-const: "off" */ oder eslint-disable erzeugt keine Unterdrückung im Zähler: ohne Inline-Konfiguration fiele er auf.
    expect(pick(eslint(dir, [...LINT_ARGS, '--no-inline-config']))).toEqual(expected);
  });
  it('R-04 neuer Fehler in einer neuen Datei schlägt fehl, auch für Regeln, die anderswo unterdrückt sind', () => {
    const dir = lintMirror();
    writeFileSync(join(dir, 'tests/characterization/zz-ratchet-probe.ts'), "const fs = require('node:fs');\nlet probe = 1;\nexport const value = [probe, fs];\n");
    const res = eslint(dir, ['tests/characterization/zz-ratchet-probe.ts']);
    expect(res.status).toBe(1);
    expect(res.errors).toEqual([
      'tests/characterization/zz-ratchet-probe.ts @typescript-eslint/no-require-imports',
      'tests/characterization/zz-ratchet-probe.ts prefer-const',
    ]);
  });
  it('R-05 höhere Anzahl eines geerbten Fehlers (prefer-const 1 → 2) schlägt fehl und meldet alle Vorkommen', () => {
    const dir = lintMirror();
    const target = 'app/api/email/send/route.ts';
    const control = eslint(dir, [target]);
    expect({ status: control.status, errors: control.errors, suppressed: control.suppressed }).toEqual({ status: 0, errors: [], suppressed: 1 });
    appendFileSync(join(dir, target), PREFER_CONST_PROBE);
    const res = eslint(dir, [target]);
    expect({ status: res.status, errors: res.errors, suppressed: res.suppressed }).toEqual({
      status: 1, errors: [`${target} prefer-const`, `${target} prefer-const`], suppressed: 0,
    });
  });
  it('R-06 eine vierte Warnung schlägt mit --max-warnings=3 fehl (0 Fehler, 4 Warnungen)', () => {
    const dir = lintMirror();
    writeFileSync(join(dir, 'tests/characterization/zz-warning-probe.ts'), 'export const used = 1;\nconst unused = 2;\n');
    const res = eslint(dir, LINT_ARGS);
    expect({ status: res.status, errorCount: res.errorCount, warningCount: res.warningCount }).toEqual({ status: 1, errorCount: 0, warningCount: 4 });
    expect(res.warnings).toContain('tests/characterization/zz-warning-probe.ts @typescript-eslint/no-unused-vars');
    expect(res.stderr).toContain('ESLint found too many warnings (maximum: 3).');
  });
  it('R-07 ein erneutes --suppress-all schluckt einen neuen Fehler still (ESLint Exit 0) — die Ratchet erkennt das gewachsene File', () => {
    const dir = lintMirror();
    const target = 'app/api/email/send/route.ts';
    appendFileSync(join(dir, target), PREFER_CONST_PROBE);
    const rebaseline = eslint(dir, [target, '--suppress-all']);
    expect(rebaseline.status).toBe(0);
    const grown = readJson(join(dir, 'eslint-suppressions.json'));
    expect(grown[target]['prefer-const'].count).toBe(2);
    expect(ratchetViolations(grown)).toEqual([`gewachsen: ${target} prefer-const 2 > 1`]);
    expect(readJson(join(ROOT, 'eslint-suppressions.json'))[target]['prefer-const'].count).toBe(1);
  });
  it('R-08 CI erzeugt die Baseline nie neu: genau ein Lint-Schritt mit --max-warnings=3, kein Suppress-Flag, Datei danach unverändert', () => {
    const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts as Record<string, string>;
    expect(scripts.lint).toBe('eslint . --ignore-pattern dist --ignore-pattern .next');
    expect(Object.entries(scripts).filter(([, command]) => SUPPRESSION_FLAGS.test(command))).toEqual([]);
    expect(workflow).not.toMatch(SUPPRESSION_FLAGS);
    expect(workflow).not.toMatch(/continue-on-error/);
    expect(workflow.match(/^\s*run: npm run lint -- --max-warnings=3\s*$/gm)).toHaveLength(1);
    expect(workflow.match(/npm run lint/g)).toHaveLength(1);
    expect(workflow).toMatch(/^\s*git diff --exit-code -- eslint-suppressions\.json\s*$/m);
  });
});

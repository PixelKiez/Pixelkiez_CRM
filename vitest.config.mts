/**
 * Vitest nur für die Charakterisierungstests der Agent-API (PXK-114).
 *
 * Bewusst eigenständig: vite.config.ts (vinext, @cloudflare/vite-plugin,
 * @openai/sites-vite-plugin) wird weder geladen noch gemergt. tests/db bleibt
 * bei node:test (npm run test:db).
 */
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';
import { classifyEnvironment } from './lib/db/environment.mjs';

const root = import.meta.dirname;

// lib/db/migrate.mjs (defaultMigrationsDir) und lib/d1-node.ts lesen db/migrations relativ zu process.cwd().
// Die Worker (pool: 'forks') erben das Arbeitsverzeichnis dieses Prozesses; H-04 prüft es zusätzlich.
if (process.cwd() !== root) process.chdir(root);

// Fail-closed: ein Produktionssignal aus der Shell (z. B. `railway run npm test`) bricht ab, statt still entfernt zu werden.
const shell = classifyEnvironment(process.env);
if (shell.production) throw new Error(`PXK-114: Tests verweigert, Produktionssignal (${shell.reasons.join(', ')})`);

// Nichts aus der Shell darf in die Tests durchschlagen: Produktionssignale,
// Schlüssel, Zugangsdaten, Sicherungsziel, Datenbankpfad. Gelöscht wird im
// Hauptprozess, bevor Vitest die Worker startet (die erben process.env).
const SCRUBBED = [
  /^NODE_ENV$/, /^RAILWAY_/, /^AGENT_API_KEY$/, /^AUTH_SECRET$/, /^AUTH_USERS$/, /^APP_BASE_URL$/, /^SMTP_/, /^GOOGLE_/, /^PXK_DB_/, /^SQLITE_PATH$/,
];
for (const name of Object.keys(process.env)) {
  if (SCRUBBED.some(pattern => pattern.test(name))) delete process.env[name];
}

// Ohne Fixture zeigt SQLITE_PATH auf eine Datei, die es nicht gibt (und nie
// gibt): ein Handler ohne Fixture scheitert mit DB_NOT_MIGRATED an diesem Pfad,
// nie an ./data/crm.db.
const NO_FIXTURE_SQLITE_PATH = join(tmpdir(), `pxk114-no-fixture-${process.pid}-${randomBytes(6).toString('hex')}`, 'crm.db');

const env = { NODE_ENV: 'test' as const, TZ: 'UTC', SQLITE_PATH: NO_FIXTURE_SQLITE_PATH, PXK114_NO_FIXTURE_SQLITE_PATH: NO_FIXTURE_SQLITE_PATH };
Object.assign(process.env, env);

// Nur CI: zusätzlicher JSON-Bericht (außerhalb des Repos), aus dem die Pipeline Anzahl und Ergebnis jedes Tests prüft.
const jsonReport = process.env.PXK114_VITEST_JSON_REPORT;

export default defineConfig({
  root,
  envDir: false,
  resolve: {
    alias: [{ find: /^@\//, replacement: `${root}/` }],
  },
  test: {
    include: ['tests/characterization/**/*.test.ts'],
    exclude: ['tests/db/**', '**/node_modules/**'],
    environment: 'node',
    pool: 'forks',
    isolate: true,
    env,
    cache: false,
    watch: false,
    passWithNoTests: false,
    allowOnly: false,
    restoreMocks: true,
    unstubEnvs: true,
    // Reserve für langsame CI-Runner (2 vCPU); die Lint-Ratchet setzt eigene, längere Grenzen.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: jsonReport ? ['default', ['json', { outputFile: jsonReport }]] : ['default'],
  },
});

#!/usr/bin/env node
/**
 * Datenbank-Migrationen anwenden, prüfen oder nur lesend berichten (PXK-113).
 *
 *   node scripts/db-migrate.mjs              Migrationen anwenden, dann Seeds
 *   node scripts/db-migrate.mjs --no-seed    nur Migrationen
 *   node scripts/db-migrate.mjs --report     nur lesen, Bericht; Exit immer 0
 *   node scripts/db-migrate.mjs --check      wie --report, Exit ≠ 0 bei Problemen
 *   node scripts/db-migrate.mjs --adopt-legacy=S2
 *                                            älteren Altstand S1–S4 ausdrücklich übernehmen
 *
 * Umgebung: SQLITE_PATH (wie die App), PXK_DB_BACKUP_DIR (Sicherungsziel; in
 * Produktion Pflicht, sobald migriert wird), PXK_DB_ADOPT_LEGACY=Sx,
 * PXK_DB_ALLOW_FRESH=1 (neue leere Datenbank in Produktion zulassen; nach dem
 * ersten Lauf wieder entfernen), PXK_MIGRATIONS_DIR (nur Tests; in Produktion
 * ignoriert). Diese Variablen werden wie bei Next.js auch aus .env-Dateien
 * gelesen; echte Umgebungsvariablen haben Vorrang.
 * Produktion: siehe lib/db/environment.mjs (NODE_ENV oder
 * RAILWAY_ENVIRONMENT_NAME = production; im Zweifel Produktion).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';
import { EXIT_CODES, MigrationError } from '../lib/db/errors.mjs';
import { defaultMigrationsDir, runMigrations } from '../lib/db/migrate.mjs';
import { classifyEnvironment } from '../lib/db/environment.mjs';
import { openDatabase, resolveDbPath } from '../lib/db/open.mjs';
import { buildReport } from '../lib/db/report.mjs';
import { runSeeds } from '../lib/db/seed.mjs';

const USAGE = 'Aufruf: node scripts/db-migrate.mjs [--report | --check] [--no-seed] [--adopt-legacy=S1..S5] [--migrations-dir=PFAD]';

function parseArgs(argv) {
  const args = { report: false, check: false, seed: true, adoptLegacy: null, migrationsDir: null };
  for (const arg of argv) {
    if (arg === '--report') args.report = true;
    else if (arg === '--check') args.check = true;
    else if (arg === '--no-seed') args.seed = false;
    else if (arg.startsWith('--adopt-legacy=')) args.adoptLegacy = arg.slice('--adopt-legacy='.length);
    else if (arg.startsWith('--migrations-dir=')) args.migrationsDir = arg.slice('--migrations-dir='.length);
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new MigrationError('USAGE', arg, `unbekanntes Argument. ${USAGE}`);
  }
  if (args.report && args.check) throw new MigrationError('USAGE', '--report/--check', 'nur eines von beiden');
  return args;
}

const ENV_KEYS = ['SQLITE_PATH', 'PXK_DB_BACKUP_DIR', 'PXK_DB_ADOPT_LEGACY', 'PXK_DB_ALLOW_FRESH', 'PXK_MIGRATIONS_DIR'];

/**
 * Liest dieselben .env-Dateien in derselben Rangfolge wie Next.js, damit der
 * Pre-Start-Schritt dieselbe Datenbank meint wie die App (z. B. SQLITE_PATH
 * nur in .env.local). Nur die eigenen Variablen; vorhandene bleiben.
 */
function loadEnvFiles(env, cwd) {
  const { mode } = classifyEnvironment(env);
  for (const file of [`.env.${mode}.local`, '.env.local', `.env.${mode}`, '.env']) {
    const path = join(cwd, file);
    if (!existsSync(path)) continue;
    const values = parseEnv(readFileSync(path, 'utf8'));
    for (const key of ENV_KEYS) if (env[key] === undefined && values[key] !== undefined) env[key] = values[key];
  }
}

async function main() {
  const env = process.env;
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  loadEnvFiles(env, process.cwd());
  const { production, mode, reasons } = classifyEnvironment(env);
  const modeReason = reasons.join(',');
  const pathSource = env.SQLITE_PATH ? 'SQLITE_PATH' : 'default';
  const dbPath = resolveDbPath(env);
  // Jede Angabe zählt als Abweichung — auch eine leere, die sonst still durchrutschen würde.
  const migrationsOverride = args.migrationsDir ?? env.PXK_MIGRATIONS_DIR ?? null;
  let migrationsDir = migrationsOverride || defaultMigrationsDir();
  if (production && migrationsOverride !== null) {
    console.warn('PXK-DB Hinweis: abweichender Migrationsordner wird in Produktion ignoriert');
    migrationsDir = defaultMigrationsDir();
  }

  if (args.report || args.check) {
    const report = buildReport({ dbPath, migrationsDir, mode, modeReason, pathSource });
    for (const line of report.lines) console.log(line);
    if (args.report) return 0;
    return report.ok ? 0 : EXIT_CODES.UNKNOWN_SCHEMA;
  }

  const adoptLegacy = args.adoptLegacy ?? env.PXK_DB_ADOPT_LEGACY ?? null;
  if (adoptLegacy !== null && !/^S[1-5]$/.test(adoptLegacy)) {
    throw new MigrationError('USAGE', String(adoptLegacy), 'Altstand muss S1 bis S5 sein');
  }
  console.log(`PXK-DB mode=${mode} sqlite_path=${pathSource} ${dbPath} mode_reason=${modeReason}`);
  const allowFresh = env.PXK_DB_ALLOW_FRESH === '1';
  // Fehlt die Datei in Produktion, wird sie gar nicht erst angelegt.
  if (production && !allowFresh && (!existsSync(dbPath) || statSync(dbPath).size === 0)) {
    throw new MigrationError(
      'FRESH_DB_IN_PRODUCTION',
      dbPath,
      'Datenbankdatei fehlt oder ist leer — SQLITE_PATH/Volume prüfen; eine neue Produktionsdatenbank nur mit PXK_DB_ALLOW_FRESH=1',
    );
  }
  const backupDir = env.PXK_DB_BACKUP_DIR || (production ? null : join(dirname(dbPath), 'backups'));

  const db = openDatabase(dbPath, 'apply');
  try {
    const result = await runMigrations(db, {
      migrationsDir,
      adoptLegacy,
      production,
      allowFresh,
      backup: backupDir ? { dir: backupDir } : false,
      log: line => console.log(line),
    });
    if (allowFresh && result.classification.kind !== 'EMPTY') {
      console.warn('PXK-DB Hinweis: PXK_DB_ALLOW_FRESH=1 ist gesetzt, die Datenbank war aber nicht leer — Variable entfernen, sonst schützt nichts vor einer versehentlich neuen Produktionsdatenbank');
    }
    const seeds = args.seed ? runSeeds(db, { log: line => console.log(line) }) : null;
    console.log(
      `PXK-DB ok head=${result.head} ${result.actions.length ? result.actions.join(', ') : 'noop'}${seeds ? ` seeds=${seeds.templatesInserted}/${seeds.leadsInserted}` : ''}`,
    );
  } finally {
    db.close();
  }
  return 0;
}

main().then(
  code => process.exit(code),
  error => {
    if (error instanceof MigrationError) {
      console.error(error.message);
      process.exit(error.exitCode);
    }
    console.error(`PXK-DB [INTERNAL] ${error?.stack ?? error}`);
    process.exit(1);
  },
);

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
 * `npm start` ist `node scripts/db-migrate.mjs && next start`: Scheitert
 * dieser Schritt (Exit ≠ 0), startet die App nicht. Sie selbst legt kein
 * Schema an und schreibt keine Seeds (lib/database.ts, lib/d1-node.ts).
 *
 * Umgebung: SQLITE_PATH (wie die App), PXK_DB_BACKUP_DIR (Sicherungsziel; in
 * Produktion Pflicht und ein absoluter Pfad, sobald migriert wird oder Seeds
 * schreiben würden), PXK_DB_ADOPT_LEGACY=Sx,
 * PXK_DB_ALLOW_FRESH=1 (neue leere Datenbank in Produktion zulassen; nach dem
 * ersten Lauf wieder entfernen), PXK_MIGRATIONS_DIR (nur Tests; in Produktion
 * ignoriert). Diese Variablen werden wie bei Next.js auch aus .env-Dateien
 * gelesen; echte Umgebungsvariablen haben Vorrang.
 * Produktion: siehe lib/db/environment.mjs (NODE_ENV oder
 * RAILWAY_ENVIRONMENT_NAME = production; im Zweifel Produktion).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { parseEnv } from 'node:util';
import { backupVerified } from '../lib/db/backup.mjs';
import { EXIT_CODES, MigrationError } from '../lib/db/errors.mjs';
import { contentDigest } from '../lib/db/fingerprint.mjs';
import { defaultMigrationsDir, runMigrations } from '../lib/db/migrate.mjs';
import { classifyEnvironment } from '../lib/db/environment.mjs';
import { openDatabase, resolveDbPath } from '../lib/db/open.mjs';
import { buildReport } from '../lib/db/report.mjs';
import { planSeeds, readSeedLeads, runSeeds, seedWriteGate } from '../lib/db/seed.mjs';

/** So meldet runMigrations seine geprüfte Sicherung — direkt nach backupVerified, vor der ersten Transaktion. */
const RUNNER_BACKUP = /^PXK-DB Sicherung (.+) sha256=([0-9a-f]{64}) bytes=(\d+)$/s;

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
    // Auch der lesende Bericht öffnet eine verwaiste -wal-Lage nie (SQLite verwürfe das -wal).
    if (orphanedWal(dbPath)) {
      console.log(`PXK-DB report mode=${mode}`);
      console.log(`PXK-DB report sqlite_path=${pathSource} ${dbPath}`);
      console.log(`PXK-DB report file=${orphanedWal.describe(dbPath)} — nicht geöffnet`);
      console.log('PXK-DB report verdict=orphaned-wal');
      return args.report ? 0 : EXIT_CODES.UNKNOWN_SCHEMA;
    }
    const report = buildReport({ dbPath, migrationsDir, mode, modeReason, pathSource });
    for (const line of report.lines) console.log(line);
    if (args.report) return 0;
    return report.ok ? 0 : EXIT_CODES.UNKNOWN_SCHEMA;
  }

  const adoptLegacy = args.adoptLegacy ?? env.PXK_DB_ADOPT_LEGACY ?? null;
  if (adoptLegacy !== null && !/^S[1-5]$/.test(adoptLegacy)) {
    throw new MigrationError('USAGE', String(adoptLegacy), 'Altstand muss S1 bis S5 sein');
  }
  // Nur die Laufzeitversion als Diagnose — keine Umgebungswerte.
  console.log(`PXK-DB runtime node=${process.version}`);
  console.log(`PXK-DB mode=${mode} sqlite_path=${pathSource} ${dbPath} mode_reason=${modeReason}`);
  const allowFresh = env.PXK_DB_ALLOW_FRESH === '1';
  // Leere Hauptdatei, aber Daten im -wal: eine unvollständige Kopie oder
  // Wiederherstellung. SQLite verwirft dieses -wal schon beim Öffnen — also nie öffnen.
  if (orphanedWal(dbPath)) {
    throw new MigrationError('UNKNOWN_SCHEMA', dbPath, `${orphanedWal.describe(dbPath)} (unvollständige Kopie oder Wiederherstellung?) — nichts geöffnet, nichts geschrieben`);
  }
  // Fehlt die Datei in Produktion, wird sie gar nicht erst angelegt.
  if (production && !allowFresh && (!existsSync(dbPath) || statSync(dbPath).size === 0)) {
    throw new MigrationError(
      'FRESH_DB_IN_PRODUCTION',
      dbPath,
      'Datenbankdatei fehlt oder ist leer — SQLITE_PATH/Volume prüfen; eine neue Produktionsdatenbank nur mit PXK_DB_ALLOW_FRESH=1',
    );
  }
  const destination = backupDestination(env, production, dbPath);
  if (destination.problem) {
    console.warn(`PXK-DB Hinweis: ${destination.problem} — ein Lauf, der migrieren oder Seeds schreiben müsste, wird verweigert`);
  }
  const token = `${process.pid}-${randomBytes(3).toString('hex')}`;
  const staging = destination.dir ? join(destination.dir, `.partial-${token}`) : null;
  const log = line => console.log(line);
  // Die geprüfte Sicherung des Runners wird abgelegt, sobald er sie meldet — also
  // vor dem ersten Schreibzugriff. Scheitert danach eine Migration, liegt sie
  // trotzdem geprüft im Ziel.
  let backup = null;
  const runnerLog = (line) => {
    const match = staging && !backup ? RUNNER_BACKUP.exec(line) : null;
    if (match && dirname(match[1]) === staging) {
      backup = publish({ path: match[1], sha256: match[2], bytes: Number(match[3]) }, destination.dir);
      return log(backupLine(backup));
    }
    return log(line);
  };

  let db;
  try {
    db = openDatabase(dbPath, 'apply');
  } catch (error) {
    throw unreadable(error, dbPath);
  }
  try {
    const result = await runMigrations(db, {
      migrationsDir,
      adoptLegacy,
      production,
      allowFresh,
      backup: staging ? { dir: staging, token } : false,
      log: runnerLog,
    }).catch(error => {
      throw error?.code === 'BACKUP_DESTINATION_REQUIRED' && destination.problem ? destinationMissing(destination, 'Migration') : error;
    });
    // Sicherung dieses Laufs (nur geprüft vorhanden): deckt Migration und Seeds.
    if (result.backup && !backup) {
      backup = publish(result.backup, destination.dir);
      log(backupLine(backup));
    }
    if (allowFresh && result.classification.kind !== 'EMPTY') {
      console.warn('PXK-DB Hinweis: PXK_DB_ALLOW_FRESH=1 ist gesetzt, die Datenbank war aber nicht leer — Variable entfernen, sonst schützt nichts vor einer versehentlich neuen Produktionsdatenbank');
    }

    let seeds = null;
    if (args.seed) {
      // D4: Seeds schreiben in Produktion nur mit geprüfter Sicherung dieses Laufs —
      // außer in eine Datenbank, die dieser Lauf selbst leer vorgefunden hat.
      const guarded = production && result.classification.kind !== 'EMPTY';
      const plan = planSeeds(db);
      // Fehlt die Quelle der Startdaten, scheitert der Lauf hier — vor jeder Sicherung.
      if (plan.leads) readSeedLeads();
      let digestAtBackup = null;
      if (guarded && !backup && plan.writes) {
        if (!staging) throw destinationMissing(destination, 'Seeds');
        digestAtBackup = contentDigest(db);
        backup = publish(await backupVerified(db, { dir: staging, label: 'seeds', digest: digestAtBackup, token }), destination.dir);
        log(backupLine(backup));
      }
      seeds = runSeeds(db, { log, beforeWrite: seedWriteGate(db, { required: guarded, backup, digestAtBackup }) });
    }
    console.log(
      `PXK-DB ok head=${result.head} ${result.actions.length ? result.actions.join(', ') : 'noop'}${seeds ? ` seeds=${seeds.templatesInserted}/${seeds.leadsInserted}` : ''}`,
    );
  } catch (error) {
    throw unreadable(error, dbPath);
  } finally {
    db.close();
  }
  return 0;
}

/**
 * Sicherungsziel (D5). In Produktion zählt nur ein absoluter Pfad in
 * PXK_DB_BACKUP_DIR; fehlt er, ist er leer oder relativ, gibt es kein Ziel, und
 * ein Lauf, der schreiben müsste, wird verweigert. Ein Lauf ohne Schreibbedarf
 * startet trotzdem (mit Hinweis). Außerhalb der Produktion wie bisher: ohne
 * Angabe <Datenbankordner>/backups. Ausgegeben werden nur Variablennamen.
 *
 * @returns {{ dir: string, problem?: undefined } | { dir?: undefined, problem: string }}
 */
function backupDestination(env, production, dbPath) {
  const value = env.PXK_DB_BACKUP_DIR;
  if (!production) return { dir: value || join(dirname(dbPath), 'backups') };
  if (value === undefined) return { problem: 'PXK_DB_BACKUP_DIR fehlt' };
  if (value.trim() === '') return { problem: 'PXK_DB_BACKUP_DIR ist leer' };
  if (!isAbsolute(value)) return { problem: 'PXK_DB_BACKUP_DIR ist kein absoluter Pfad' };
  return { dir: value };
}

function destinationMissing(destination, what) {
  return new MigrationError('BACKUP_DESTINATION_REQUIRED', 'PXK_DB_BACKUP_DIR', `${destination.problem} — ${what} würde in Produktion schreiben; ohne geprüfte Sicherung wird nichts geschrieben`);
}

/**
 * Sicherungen entstehen in <Ziel>/.partial-<pid>-<zufall>/ und werden nach
 * bestandener Prüfung (backupVerified), noch vor dem ersten Schreibzugriff, per
 * rename — im selben Dateisystem atomar — ins Ziel gelegt; der leere
 * Arbeitsordner verschwindet danach. Jede Datei pre-*.db direkt in
 * PXK_DB_BACKUP_DIR ist also geprüft, auch wenn die Migration danach scheitert.
 * Eine abgebrochene Kopie (Prozess beendet, Platte voll) bleibt in .partial-*
 * und kann nie für eine geprüfte gehalten werden. Gelingt nur das Ablegen nicht,
 * bleibt die Sicherung geprüft im Arbeitsordner (Hinweis mit Pfad und sha256) —
 * die Datei wird nie überschrieben. Geloggt wird wie in Release A eine Zeile
 * `PXK-DB Sicherung <Pfad> sha256=… bytes=…`, mit dem Pfad, an dem sie liegt.
 */
function publish(info, dir) {
  const target = join(dir, basename(info.path));
  try {
    if (existsSync(target)) throw new Error('Zieldatei existiert bereits');
    renameSync(info.path, target);
  } catch (error) {
    console.warn(`PXK-DB Hinweis: geprüfte Sicherung ${info.path} sha256=${info.sha256} nicht abgelegt (${error.code ?? error.message}) — sie bleibt im Arbeitsordner`);
    return info;
  }
  try {
    rmdirSync(dirname(info.path));
  } catch { /* nicht leer: dort liegt etwas, das ein Mensch ansehen soll */ }
  return { ...info, path: target };
}

const backupLine = (info) => `PXK-DB Sicherung ${info.path} sha256=${info.sha256} bytes=${info.bytes}`;

/**
 * Hauptdatei fehlt oder ist leer, daneben liegt ein nicht leeres -wal: SQLite
 * würde dieses -wal beim Öffnen (auch schreibgeschützt) verwerfen. Gilt für
 * Migration und Bericht gleichermaßen — eine solche Lage wird nie geöffnet.
 */
function orphanedWal(path) {
  const size = (p) => (existsSync(p) ? statSync(p).size : -1);
  return size(path) <= 0 && size(`${path}-wal`) > 0;
}
orphanedWal.describe = (path) => `Hauptdatei ${existsSync(path) ? 'ist leer' : 'fehlt'}, daneben liegt ein nicht leeres -wal`;

/**
 * Eine beschädigte oder fremde Datei meldet SQLite erst beim ersten Zugriff.
 * Das ist ein klarer Grund, den Start zu verweigern — kein interner Fehler.
 */
function unreadable(error, dbPath) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code !== 'SQLITE_NOTADB' && !code.startsWith('SQLITE_CORRUPT')) return error;
  return new MigrationError('UNKNOWN_SCHEMA', dbPath, `keine lesbare SQLite-Datenbank (${code}: ${error.message}) — Datei bzw. Volume prüfen`);
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

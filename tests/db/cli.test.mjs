import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { EXIT_CODES } from '../../lib/db/errors.mjs';
import { loadMigrations, runMigrations } from '../../lib/db/migrate.mjs';
import { openDatabase } from '../../lib/db/open.mjs';
import {
  HEAD, MIGRATIONS_DIR, POST_BASELINE_TABLES, ROOT, assertMode, baselineOnlyDir, buildLegacy, escapeRegExp, future, insertSyntheticRows, ledgerFor,
  ledgerRows, loserFailureCodes, migrationsCopy, tempDir,
} from './helpers.mjs';

const CLI = join(ROOT, 'scripts/db-migrate.mjs');
const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
const run = (args, env, cwd = ROOT) => spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...baseEnv, ...env }, encoding: 'utf8' });
const spawnRun = (args, env, cwd = ROOT) => new Promise(resolvePromise => {
  const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...baseEnv, ...env } });
  let out = '';
  let err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  child.on('close', status => resolvePromise({ status, out, err }));
});
const fileSha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

test('CLI: frische Datenbank, dann No-op', () => {
  const path = join(tempDir(), 'crm.db');
  const first = run([], { SQLITE_PATH: path });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /applied 0001_baseline/);
  assert.match(first.stdout, /seeds=8\/952/);
  const second = run([], { SQLITE_PATH: path });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, new RegExp(`PXK-DB ok head=${HEAD} noop seeds=0/0`));
});

test('AC4: gescheiterte Migration → Exit 13, Meldung nennt die Migration, Ledger unverändert', () => {
  const dir = tempDir();
  const path = join(dir, 'crm.db');
  assert.equal(run([], { SQLITE_PATH: path }).status, 0);
  const migrations = migrationsCopy({ [`${future(1, 'break')}.sql`]: 'CREATE TABLE thing (x);\nINSERT INTO leads (id) VALUES (NULL);\n' });
  const result = run([], { SQLITE_PATH: path, PXK_MIGRATIONS_DIR: migrations });
  assert.equal(result.status, 13);
  assert.match(result.stderr, new RegExp(`PXK-DB \\[MIGRATION_FAILED\\] ${future(1, 'break')}`));
  const db = openDatabase(path, 'app');
  assert.equal(ledgerRows(db).length, HEAD);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'thing'").get(), undefined);
  db.close();
});

test('Produktion: fehlende Datei wird nicht angelegt (FRESH_DB_IN_PRODUCTION, Exit 12)', () => {
  const path = join(tempDir(), 'crm.db');
  const result = run([], { SQLITE_PATH: path, NODE_ENV: 'production' });
  assert.equal(result.status, 12);
  assert.match(result.stderr, /FRESH_DB_IN_PRODUCTION/);
  assert.equal(existsSync(path), false);
  const allowed = run([], { SQLITE_PATH: path, NODE_ENV: 'production', PXK_DB_ALLOW_FRESH: '1' });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.doesNotMatch(allowed.stderr, /PXK_DB_ALLOW_FRESH/);
  // stehengebliebene Freigabe wird beim nächsten Lauf angemahnt
  const again = run([], { SQLITE_PATH: path, NODE_ENV: 'production', PXK_DB_ALLOW_FRESH: '1', PXK_DB_BACKUP_DIR: join(dirname(path), 'b') });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stderr, /PXK_DB_ALLOW_FRESH=1 ist gesetzt, die Datenbank war aber nicht leer/);
});

test('Produktion: leere 0-Byte-Datei wird nicht beschrieben (Exit 12, bleibt 0 Byte, kein -wal/-shm)', () => {
  const path = join(tempDir(), 'crm.db');
  writeFileSync(path, '');
  const result = run([], { SQLITE_PATH: path, NODE_ENV: 'production' });
  assert.equal(result.status, 12);
  assert.match(result.stderr, /FRESH_DB_IN_PRODUCTION/);
  assert.equal(statSync(path).size, 0);
  assert.equal(existsSync(`${path}-wal`), false);
  assert.equal(existsSync(`${path}-shm`), false);
});

test('CLI liest SQLITE_PATH wie Next.js aus .env.local; echte Umgebung hat Vorrang', () => {
  const cwd = tempDir();
  const fromFile = join(cwd, 'aus-env-datei.db');
  writeFileSync(join(cwd, '.env.local'), `# lokal\nSQLITE_PATH=${fromFile}\nAUTH_SECRET=wird-nicht-gelesen\n`);
  const env = { PXK_MIGRATIONS_DIR: join(ROOT, 'db/migrations') };
  const result = run(['--no-seed'], env, cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /sqlite_path=SQLITE_PATH .*aus-env-datei\.db/);
  assert.ok(existsSync(fromFile));
  const explicit = join(cwd, 'explizit.db');
  assert.equal(run(['--no-seed'], { ...env, SQLITE_PATH: explicit }, cwd).status, 0);
  assert.ok(existsSync(explicit));
});

test('Produktion: Altstand-Übernahme braucht ein Sicherungsziel und sichert geprüft', () => {
  const dir = tempDir();
  const path = join(dir, 'crm.db');
  const db = buildLegacy(path, 'S5');
  insertSyntheticRows(db);
  db.close();
  const refused = run([], { SQLITE_PATH: path, NODE_ENV: 'production' });
  assert.equal(refused.status, 15);
  assert.match(refused.stderr, /BACKUP_DESTINATION_REQUIRED/);
  const backups = join(dir, 'backups');
  const ok = run([], { SQLITE_PATH: path, NODE_ENV: 'production', PXK_DB_BACKUP_DIR: backups });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /PXK-DB mode=production sqlite_path=SQLITE_PATH /);
  assert.match(ok.stdout, /PXK-DB Sicherung .*pre-0001_baseline-\d{8}T\d{6}Z-\d+-[0-9a-f]{6}\.db sha256=[0-9a-f]{64}/);
  assert.match(ok.stdout, /baselined 0001_baseline \(S5\)/);
});

test('Produktion: abweichender Migrationsordner wird ignoriert', () => {
  const path = join(tempDir(), 'crm.db');
  const migrations = migrationsCopy({ [`${future(1, 'extra')}.sql`]: 'CREATE TABLE extra2 (x);\n' });
  const result = run([], { SQLITE_PATH: path, NODE_ENV: 'production', PXK_DB_ALLOW_FRESH: '1', PXK_MIGRATIONS_DIR: migrations });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /ignoriert/);
  assert.doesNotMatch(result.stdout, new RegExp(future(1, 'extra')));
});

test('älterer Altstand: ohne Freigabe Exit 12, mit Freigabe übernommen', () => {
  const path = join(tempDir(), 'crm.db');
  buildLegacy(path, 'S3').close();
  const refused = run([], { SQLITE_PATH: path });
  assert.equal(refused.status, 12);
  assert.match(refused.stderr, /LEGACY_OUTDATED.*PXK_DB_ADOPT_LEGACY=S3/);
  const ok = run(['--adopt-legacy=S3'], { SQLITE_PATH: path });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /baselined 0001_baseline \(S3\)/);
});

test('--report schreibt nichts, gibt keine Inhalte aus und endet immer mit 0', () => {
  const dir = tempDir();
  const path = join(dir, 'crm.db');
  const db = buildLegacy(path, 'S5');
  insertSyntheticRows(db);
  db.prepare("UPDATE users SET google_tokens = '{\"refresh_token\":\"geheim-123\"}'").run();
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  const before = fileSha(path);
  const result = run(['--report'], { SQLITE_PATH: path });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /PXK-DB report mode=development\n/);
  assert.match(result.stdout, /PXK-DB report sqlite_path=SQLITE_PATH .*crm\.db\n/);
  assert.match(result.stdout, /class=LEGACY_EXACT S5/);
  assert.match(result.stdout, /verdict=legacy-current-adoptable/);
  assert.match(result.stdout, /table\.leads=rows=3 digest=[0-9a-f]{16}/);
  assert.doesNotMatch(result.stdout, /geheim-123|leads-name-1|users-email/);
  assert.equal(fileSha(path), before);
  const check = openDatabase(path, 'inspect');
  assert.equal(check.pragma('user_version', { simple: true }), 0);
  assert.equal(ledgerRows(check), null);
  check.close();

  const absent = run(['--report'], { SQLITE_PATH: join(dir, 'fehlt.db'), NODE_ENV: 'production' });
  assert.equal(absent.status, 0);
  assert.match(absent.stdout, /PXK-DB report mode=production\n/);
  assert.match(absent.stdout, /verdict=absent/);
  assert.equal(existsSync(join(dir, 'fehlt.db')), false);
});

test('--check: Exit ≠ 0 bei unbekanntem Schema', () => {
  const path = join(tempDir(), 'crm.db');
  const db = buildLegacy(path, 'S5');
  db.exec('CREATE TABLE fremd (x)');
  db.close();
  const report = run(['--report'], { SQLITE_PATH: path });
  assert.equal(report.status, 0);
  assert.match(report.stdout, /verdict=unknown-schema/);
  assert.match(report.stdout, /difference=zusätzliche Tabelle: fremd/);
  const check = run(['--check'], { SQLITE_PATH: path });
  assert.equal(check.status, 12);
});

/**
 * Wettlauf paralleler Runner (D2.1 = A, G0). PXK-113 sicherte zu: jeder der
 * gleichzeitigen Läufe endet mit 0. Das gilt, solange der Gewinner nach dem
 * Stand, den ein Verlierer gelesen bzw. gesichert hat, keine weitere Migration
 * festschreibt (helpers.mjs loserFailureCodes) — dann prüft die ursprüngliche
 * Zeile unten unverändert (bei Kopf 1 der echte Satz, ab Kopf 2 der
 * Baseline-Satz, T-D2-3). Andernfalls darf ein Verlierer nur fail-closed
 * scheitern: mit einem zulässigen Code und dessen Exit (BACKUP_STALE und
 * BACKUP_FAILED 15, CORRUPT_LEDGER und SCHEMA_DRIFT 11, UNKNOWN_SCHEMA 12), ohne
 * eine einzige applied/baselined-Zeile; mindestens der Gewinner endet mit 0, jede
 * Migration läuft genau einmal, ein erneuter Lauf ist ein No-op. Jeden Code
 * deterministisch: guards.test.mjs.
 */
function assertConcurrentRuns(results, migrationsDir, exposure) {
  const allowed = loserFailureCodes(migrationsDir, exposure);
  if (!allowed.length) {
    for (const r of results) assert.equal(r.status, 0, r.err);
    return [];
  }
  const failed = [];
  for (const r of results) {
    if (r.status === 0) continue;
    const code = /PXK-DB \[([A-Z_]+)\]/.exec(r.err)?.[1];
    assert.ok(allowed.includes(code), `${code} ist hier nicht zulässig (${allowed.join(', ')}): ${r.err}`);
    assert.equal(r.status, EXIT_CODES[code], r.err);
    assert.doesNotMatch(r.out, /PXK-DB (applied|baselined) /, 'gescheiterter Runner hat nichts geschrieben');
    failed.push({ ...r, code });
  }
  assert.ok(results.some(r => r.status === 0), 'mindestens der Gewinner endet mit 0');
  return failed;
}

/**
 * Arbeitsverzeichnis, dessen db/migrations genau den Satz `migrationsDir` enthält:
 * Der Runner liest dort (defaultMigrationsDir) — auch in Produktion, wo
 * PXK_MIGRATIONS_DIR ignoriert wird.
 */
function projectWith(migrationsDir) {
  if (migrationsDir === MIGRATIONS_DIR) return ROOT;
  const project = tempDir();
  mkdirSync(join(project, 'db', 'migrations'), { recursive: true });
  for (const { file } of loadMigrations(migrationsDir).migrations) copyFileSync(join(migrationsDir, file), join(project, 'db', 'migrations', file));
  return project;
}

/**
 * Drei gleichzeitige CLI-Läufe. `start`: 'fresh' (neue Datei), 'legacy' (S5 mit
 * Daten) oder 'migrated' (echter Kopf mit Daten). Ohne `migrationsDir` der
 * echte Satz; `env` z. B. NODE_ENV=production. Rückgabe: Ergebnisse, die
 * zulässigen Verlierer-Codes und die fail-closed gescheiterten Verlierer.
 */
async function race({ start, migrationsDir = MIGRATIONS_DIR, env = {} }) {
  const dir = tempDir();
  const path = join(dir, 'crm.db');
  const backups = join(dir, 'backups');
  const cwd = projectWith(migrationsDir);
  const migrations = loadMigrations(migrationsDir).migrations;
  const runEnv = { SQLITE_PATH: path, ...(start === 'fresh' ? {} : { PXK_DB_BACKUP_DIR: backups }), ...env };
  let from = 1;
  if (start !== 'fresh') {
    const db = buildLegacy(path, 'S5');
    if (start === 'migrated') from = (await runMigrations(db, { migrationsDir: MIGRATIONS_DIR, production: false, backup: false })).head;
    insertSyntheticRows(db, 50);
    db.close();
  }
  const exposure = { from, ledger: start === 'migrated' };
  const results = await Promise.all([1, 2, 3].map(() => spawnRun(['--no-seed'], runEnv, cwd)));
  const failed = assertConcurrentRuns(results, migrationsDir, exposure);
  if (start === 'fresh') assert.equal(results.filter(r => r.out.includes('applied 0001_baseline')).length, 1);
  if (start === 'legacy') {
    const adopters = results.filter(r => r.out.includes('baselined 0001_baseline (S5)'));
    assert.equal(adopters.length, 1);
    assert.equal(adopters[0].status, 0, adopters[0].err);
  }
  for (const { name } of migrations.slice(start === 'fresh' ? 0 : from)) assert.equal(results.filter(r => r.out.includes(`applied ${name}`)).length, 1, `${name} genau einmal`);
  // Wer vor einem Schreibschritt eingeordnet hat, sichert vorher — jede Sicherung in eine eigene, geprüfte Datei.
  const files = existsSync(backups) ? readdirSync(backups) : [];
  const announced = results.filter(r => /PXK-DB Sicherung /.test(r.out)).length;
  if (start !== 'fresh') assert.ok(announced >= 1);
  const labels = migrations.slice(from - 1).map(m => escapeRegExp(m.name)).join('|');
  assert.equal(files.filter(f => new RegExp(`^pre-(${labels})-.*\\.db$`).test(f)).length, announced, files.join(', '));
  assert.equal(files.filter(f => f.endsWith('.db')).length, announced, files.join(', '));
  // Keine ungeprüften oder WAL-Reste — außer je fail-closed gescheiterter Prüfung (BACKUP_FAILED) ihr .partial-Ordner mit der als .unverified gekennzeichneten Kopie (D2.2).
  const leftovers = files.filter(f => !f.endsWith('.db'));
  if (!failed.some(r => r.code === 'BACKUP_FAILED')) assert.deepEqual(leftovers, [], 'keine ungeprüften oder WAL-Reste');
  assert.equal(leftovers.length, failed.filter(r => r.code === 'BACKUP_FAILED').length, files.join(', '));
  for (const name of leftovers) {
    assert.match(name, /^\.partial-/);
    const rest = readdirSync(join(backups, name));
    assert.deepEqual(rest.filter(f => !f.endsWith('.db.unverified')), [], name);
    assertMode(join(backups, name), 0o700);
    for (const f of rest) assertMode(join(backups, name, f), 0o600);
  }
  // Sicherungen wie Geheimnisse (lib/db/backup.mjs): Ziel 0700, jede Datei 0600.
  if (files.length) assertMode(backups, 0o700);
  for (const f of files.filter(f => f.endsWith('.db'))) assertMode(join(backups, f), 0o600);
  const check = openDatabase(path, start === 'fresh' ? 'app' : 'inspect');
  assert.equal(ledgerRows(check).length, migrations.length);
  assert.deepEqual(ledgerRows(check), ledgerFor(migrations, start === 'fresh' ? null : 'S5'));
  check.close();
  const again = run(['--no-seed'], runEnv, cwd);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, new RegExp(`PXK-DB ok head=${migrations.length} noop`), 'Wiederholung: No-op');
  assert.equal((existsSync(backups) ? readdirSync(backups) : []).filter(f => f.endsWith('.db')).length, announced, 'keine neue Sicherung');
  return { results, failed, allowed: loserFailureCodes(migrationsDir, exposure) };
}

test('drei gleichzeitige Läufe auf derselben frischen Datei: genau einer migriert', async () => {
  await race({ start: 'fresh' });
});

test('drei gleichzeitige Läufe auf einem Altstand: genau eine Übernahme, jede Sicherung eigen und geprüft', async () => {
  await race({ start: 'legacy', env: { NODE_ENV: 'production' } });
});

test('D2.1 (T-D2-3): drei gleichzeitige Läufe nur mit der Baseline (frisch, Altstand, Altstand in Produktion) → jeder Lauf endet mit 0; die Zweigwahl ist selbst geprüft', async () => {
  // Baseline-Satz: Zweig „alle 0“ — dort läuft die ursprüngliche PXK-113-Zeile auch ab Kopf 2 wirklich.
  assert.deepEqual(loserFailureCodes(baselineOnlyDir()), []);
  // Echter Satz: fail-closed-Zweig genau ab Kopf 2.
  assert.equal(loserFailureCodes().length > 0, HEAD > 1, `Kopf ${HEAD}: ${loserFailureCodes().join(', ') || 'alle 0'}`);
  const loser = [{ status: 0, out: 'PXK-DB ok', err: '' }, { status: EXIT_CODES.CORRUPT_LEDGER, out: '', err: 'PXK-DB [CORRUPT_LEDGER] schema_migrations: synthetisch' }];
  assert.throws(() => assertConcurrentRuns(loser, baselineOnlyDir(), {}), assert.AssertionError, 'Baseline-Satz: ein Exit ≠ 0 scheitert an der ursprünglichen Zeile');
  if (HEAD > 1) assert.deepEqual(assertConcurrentRuns(loser, MIGRATIONS_DIR, {}).map(r => r.code), ['CORRUPT_LEDGER'], 'echter Satz: fail-closed-Zweig');
  else assert.throws(() => assertConcurrentRuns(loser, MIGRATIONS_DIR, {}), assert.AssertionError, 'Kopf 1: echter Satz = Baseline-Satz');
  for (const variant of [{ start: 'fresh' }, { start: 'legacy' }, { start: 'legacy', env: { NODE_ENV: 'production' } }]) {
    const { allowed, failed } = await race({ ...variant, migrationsDir: baselineOnlyDir() });
    assert.deepEqual(allowed, [], JSON.stringify(variant));
    assert.deepEqual(failed, [], JSON.stringify(variant));
  }
});

test('D2.1: drei gleichzeitige Läufe, Folgemigration (Kopf + 1) legt eine Tabelle an → Verlierer 0 oder fail-closed (BACKUP_STALE/BACKUP_FAILED 15, CORRUPT_LEDGER/SCHEMA_DRIFT 11, UNKNOWN_SCHEMA 12), alles genau einmal, Wiederholung No-op', async () => {
  const migrationsDir = migrationsCopy({ [`${future(1, 'race_table')}.sql`]: 'CREATE TABLE race_neu (id INTEGER PRIMARY KEY, x TEXT);\n' });
  assert.deepEqual(loserFailureCodes(migrationsDir), ['BACKUP_STALE', 'BACKUP_FAILED', 'CORRUPT_LEDGER', 'SCHEMA_DRIFT', 'UNKNOWN_SCHEMA'], 'Zweig „fail-closed zulässig“');
  for (const start of ['fresh', 'legacy']) await race({ start, migrationsDir });
});

test('D2.1: drei gleichzeitige Läufe, Folgemigration (Kopf + 1) nur mit Index → nie BACKUP_STALE (nur BACKUP_FAILED/CORRUPT_LEDGER/SCHEMA_DRIFT zulässig); alles genau einmal, Wiederholung No-op', async () => {
  const migrationsDir = migrationsCopy({ [`${future(1, 'race_index')}.sql`]: 'CREATE INDEX idx_race_leads_notes ON leads(notes);\n' });
  assert.deepEqual(loserFailureCodes(migrationsDir, { from: HEAD, ledger: true }), ['BACKUP_FAILED', 'CORRUPT_LEDGER', 'SCHEMA_DRIFT'], 'Inhalt unverändert: kein BACKUP_STALE');
  await race({ start: 'migrated', migrationsDir });
});

test('D2.1: Wettlauf-Erwartung des echten Satzes ist aus db/migrations abgeleitet', () => {
  // Bis einschließlich der Baseline gilt die ursprüngliche Zusicherung „alle 0“ ohne Ausnahme.
  assert.deepEqual(loserFailureCodes(baselineOnlyDir()), []);
  if (HEAD === 1) assert.deepEqual(loserFailureCodes(), [], 'nur Baseline: alle Läufe enden mit 0');
  // Legt der echte Satz nach der Baseline Tabellen an, gilt für die beiden Wettläufe auf dem echten Satz der fail-closed-Zweig.
  else if (POST_BASELINE_TABLES.length) assert.deepEqual(loserFailureCodes(), ['BACKUP_STALE', 'BACKUP_FAILED', 'CORRUPT_LEDGER', 'SCHEMA_DRIFT', 'UNKNOWN_SCHEMA']);
  else assert.ok(loserFailureCodes().includes('CORRUPT_LEDGER') && !loserFailureCodes().includes('BACKUP_STALE'), loserFailureCodes().join(', '));
});

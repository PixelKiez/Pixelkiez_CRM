/**
 * Gemeinsame Hilfen für die Tests des AC3-Prüfstands (scripts/db-verify-copy.mjs):
 * produktionsähnliche synthetische Quellen, saubere Git-Kopien des Kandidaten
 * (auf Wunsch mit einem Ersatz-Migrationsschritt), Aufruf des Prüfstands und
 * die Datenschutz-Prüfung seiner Ausgabe. Es fließen keine echten Daten ein.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildLegacy, insertSyntheticRows, ROOT, tempDir } from './helpers.mjs';
import { runSeeds } from '../../lib/db/seed.mjs';

export const hasGit = spawnSync('git', ['--version']).status === 0;
export const skip = !hasGit && 'git fehlt';
export const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

export const SENTINELS = ['SENTINEL-NAME-4b1f', 'SENTINEL-TOKEN-91ac', 'SENTINEL-PHONE-0301234567', 'SENTINEL-NOTE-77de', 'sentinel@example.invalid', 'Grüße', 'ünïcödé'];

/** Produktionsähnliche Quelle: Altstand, Seeds vollständig, gemischte Speicherklassen, auf Wunsch Daten nur im WAL. */
export function source({ variant = 'S5', missingTemplate = null, walRows = 0 } = {}) {
  const dir = tempDir();
  const path = join(dir, 'quelle.db');
  const db = buildLegacy(path, variant);
  runSeeds(db);
  insertSyntheticRows(db, 4);
  const now = '2026-10-04T00:00:00.000Z';
  db.exec(`INSERT INTO settings (key, value) VALUES
    ('blob', x'00ff10'), ('ungueltiges-utf8', CAST(x'ff00fe' AS TEXT)), ('real', 0.30000000000000004),
    ('gross', 9007199254740993), ('leer', NULL), ('text-1', '1'), ('int-1', 1), ('unicode', 'Grüße ünïcödé 🌍')`);
  db.prepare("UPDATE leads SET phone = 'SENTINEL-PHONE-0301234567', notes = 'SENTINEL-NOTE-77de' WHERE rowid IN (SELECT rowid FROM leads ORDER BY rowid LIMIT 5)").run();
  if (variant === 'S5') {
    db.prepare('INSERT INTO users (email, display_name, google_tokens, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('sentinel@example.invalid', 'SENTINEL-NAME-4b1f', '{"refresh_token":"SENTINEL-TOKEN-91ac"}', now, now);
  }
  if (missingTemplate) db.prepare('DELETE FROM email_templates WHERE slug = ?').run(missingTemplate);
  db.close();
  if (walRows) {
    // wie in Produktion: aktuelle Daten nur im -wal, die Hauptdatei allein ist veraltet
    const writer = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import Database from 'better-sqlite3';
      const db = new Database(${JSON.stringify(path)});
      db.pragma('wal_autocheckpoint = 0');
      db.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${walRows}) INSERT INTO leads (id, name, updated_at) SELECT 'WAL-' || i, 'nur im WAL ' || i, '${now}' FROM n");
      process.kill(process.pid, 'SIGKILL');
    `], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(writer.signal, 'SIGKILL', writer.stderr);
  }
  return { dir, path };
}

/**
 * Saubere Git-Kopie des Kandidaten, aus der der Prüfstand läuft (mit `git: false`
 * ohne Repository). `stub` ersetzt scripts/db-migrate.mjs durch ein eigenes
 * Skript; der echte Schritt liegt dann als scripts/db-migrate-echt.mjs daneben.
 */
export function isolatedProject({ git: withGit = true, stub = null } = {}) {
  const dir = tempDir();
  for (const part of ['scripts', 'lib', 'db']) cpSync(join(ROOT, part), join(dir, part), { recursive: true });
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
  writeFileSync(join(dir, '.gitignore'), '/node_modules\n');
  if (stub) {
    renameSync(join(dir, 'scripts', 'db-migrate.mjs'), join(dir, 'scripts', 'db-migrate-echt.mjs'));
    writeFileSync(join(dir, 'scripts', 'db-migrate.mjs'), stub);
  }
  if (!withGit) return dir;
  gitIn(dir, 'init', '-q');
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'Kandidat');
  return dir;
}

/** git ohne GIT_*-Variablen der Umgebung (z. B. aus einem Hook) und ohne Nutzer-/Systemkonfiguration. */
export function gitIn(dir, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const result = spawnSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    encoding: 'utf8',
    env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
}
let shared = null;
export const project = () => (shared ??= isolatedProject());

const parsed = (result) => {
  const lines = result.stdout.split('\n').filter(Boolean);
  return { ...result, lines, value: (prefix) => lines.find(l => l.startsWith(`PXK-AC3 ${prefix}`)) };
};

export function harness(args, env = {}, dir = project()) {
  const result = spawnSync(process.execPath, [join(dir, 'scripts', 'db-verify-copy.mjs'), ...args], {
    cwd: tempDir(),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    encoding: 'utf8',
  });
  return parsed(result);
}

/**
 * Ein Lauf mit vom Prüfstand angelegtem Arbeitsordner. Prüft danach immer, dass
 * der Prüfstand seinen Klartext selbst gelöscht hat (M-4): Ordner weg.
 */
export function verify(path, dir) {
  const work = join(tempDir(), 'arbeit');
  const result = harness([`--source=${path}`, `--workdir=${work}`], {}, dir);
  assert.equal(existsSync(work), false, `Arbeitsordner nach dem Lauf entfernt (Exit ${result.status})`);
  return result;
}

/** Startet den Prüfstand asynchron (für Signale während des Laufs). */
export function startHarness(args, env = {}, dir = project()) {
  const child = spawn(process.execPath, [join(dir, 'scripts', 'db-verify-copy.mjs'), ...args], {
    cwd: tempDir(),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8').on('data', (text) => { out.stdout += text; });
  child.stderr.setEncoding('utf8').on('data', (text) => { out.stderr += text; });
  const done = new Promise((resolve) => child.once('close', (status, signal) => resolve(parsed({ status, signal, ...out }))));
  return { child, done };
}

/** Wartet, bis `check()` einen Wert liefert (höchstens `timeoutMs`). */
export async function waitFor(check, what, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    assert.ok(Date.now() < deadline, `Zeitüberschreitung: ${what}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

export const ALLOWED = [
  /^PXK-AC3 candidate=([0-9a-f]{40}|[0-9a-f]{64}|unknown) clean=(yes|NO|unknown) node=v\d+\.\d+\.\d+ sqlite=\d+\.\d+\.\d+$/,
  /^PXK-AC3 migrations=\d+ last=\d{4}_[a-z0-9_]+$/,
  /^PXK-AC3 source readable=(yes copy=online-backup copy_integrity=(ok|FAILED)|no error=[A-Z_]+)$/,
  /^PXK-AC3 before class=[A-Z_]+( S[1-5])? user_version=\d+ ledger=[A-Za-z_]+ tables=\d+$/,
  /^PXK-AC3 run1 exit=\d+ error=[-A-Z_0-9]+ head=[-\d]+ seeds=(-|\d+\/\d+) backups_created=\d+ actions=[a-z0-9_ ,()S-]+$/,
  /^PXK-AC3 after class=[A-Z_]+( S[1-5])? user_version=\d+ ledger_check=[A-Za-z_]+ integrity=(ok|FAILED)$/,
  /^PXK-AC3 ledger rows=\d+ (-|(\d+:\d{4}_[a-z0-9_]+:(applied|baselined):(S[1-5]|-) ?)+) ?expected=(MATCH|MISMATCH)$/,
  /^PXK-AC3 schema after_vs_canonical=(MATCH|MISMATCH) before_vs_after=(MATCH|CHANGED)$/,
  /^PXK-AC3 table=([A-Za-z0-9_]+|#\d+) rows_before=(-|\d+) rows_after=(-|\d+) content=(MATCH|MISMATCH)$/,
  /^PXK-AC3 changed_tables=\d+$/,
  /^PXK-AC3 backup_vs_before=(MATCH|MISMATCH|MISSING|none-required)$/,
  /^PXK-AC3 run2 exit=\d+ error=[-A-Z_0-9]+ actions=[a-z0-9_ ,()S-]+ seeds=(-|\d+\/\d+) backups_created=-?\d+ noop=(MATCH|MISMATCH)$/,
  /^PXK-AC3 run2 file_unchanged=(MATCH|MISMATCH) content=(MATCH|MISMATCH)$/,
  /^PXK-AC3 source_unchanged=(MATCH|MISMATCH)$/,
  /^PXK-AC3 interrupted=SIG(INT|TERM|HUP|QUIT)$/,
  /^PXK-AC3 failures=[a-z0-9_,]+$/,
  /^PXK-AC3 cleanup=(verified|FAILED)$/,
  /^PXK-AC3 verdict=(PASS|FAIL)$/,
];

/** Nur erlaubte Zeilen; keine Werte, keine Prüfsummen (außer der Kandidaten-SHA), keine Pfade. */
export function assertPrivate(result, extraSentinels = [], { stderr = '' } = {}) {
  const all = `${result.stdout}${result.stderr}`;
  for (const line of result.lines) assert.ok(ALLOWED.some(re => re.test(line)), `nicht erlaubte Zeile: ${line}`);
  assert.equal(result.stderr, stderr, 'keine (weitere) Ausgabe auf stderr');
  for (const sentinel of [...SENTINELS, ...extraSentinels]) assert.equal(all.includes(sentinel), false, `Wert in der Ausgabe: ${sentinel}`);
  const withoutCandidate = result.lines.filter(l => !l.startsWith('PXK-AC3 candidate=')).join('\n');
  assert.doesNotMatch(withoutCandidate, /[0-9a-fA-F]{16,}/, 'keine Prüfsummen oder Hex-Inhalte');
  assert.doesNotMatch(all, /\/(private|var|tmp|Users|home)\//, 'keine Pfade');
}

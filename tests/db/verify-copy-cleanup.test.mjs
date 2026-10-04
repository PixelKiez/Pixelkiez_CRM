/**
 * M-4: Der AC3-Prüfstand löscht jeden aus der Quelle abgeleiteten Klartext
 * selbst (copy.db, backups/, -wal/-shm, .partial-*, Arbeitsordner) — bei PASS,
 * Geschäftsdaten-FAIL, Schema-FAIL, interner Ausnahme, SIGINT/SIGTERM/SIGHUP
 * und auch, wenn der Migrationsschritt SIGTERM ignoriert. Gelöscht wird erst
 * nach dem Ende des Migrationsschritts; die Quelle des Aufrufers bleibt. Lässt
 * sich das Löschen nicht nachweisen, endet der Lauf mit FAIL (Exit 3).
 *
 * Signale und Fehler entstehen über einen Ersatz-Migrationsschritt in einer
 * eigenen, sauberen Git-Kopie des Kandidaten (isolatedProject({ stub })): Er
 * meldet seine PID und die Rechte des Klartexts in $HOME und schreibt
 * fortlaufend, ob die Kopie noch existiert.
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertPrivate, harness, isolatedProject, sha, skip, source, startHarness, waitFor } from './ac3-helpers.mjs';
import { tempDir } from './helpers.mjs';

/**
 * Dateien im Ordner der Quelle: Inhalt (Hauptdatei, -wal) bytegleich, keine Datei entsteht oder verschwindet.
 * -shm ist der WAL-Index, den jeder Leser neu aufbauen darf — nur sein Vorhandensein zählt.
 */
const snapshot = (dir) => Object.fromEntries(readdirSync(dir).sort().map(name => [name, name.endsWith('-shm') ? 'vorhanden' : sha(join(dir, name))]));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};
const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
};

/** Meldet PID und Rechte (copy.db, ac3-Ordner, Arbeitsordner), dann alle 20 ms, ob die Kopie noch existiert. */
const REPORTER = `
import { appendFileSync, existsSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const copy = process.env.SQLITE_PATH;
const home = process.env.HOME;
const mode = (p) => (statSync(p).mode & 0o777).toString(8);
writeFileSync(join(home, 'kind.tmp'), JSON.stringify({ pid: process.pid, copy: mode(copy), root: mode(dirname(copy)), workdir: mode(dirname(dirname(copy))) }));
renameSync(join(home, 'kind.tmp'), join(home, 'kind.json'));
const beat = (text) => appendFileSync(join(home, 'puls.log'), text + ' copy=' + existsSync(copy) + '\\n');
beat('start');
setInterval(() => beat('puls'), 20);
`;
const HANG = REPORTER;
const IGNORES_SIGTERM = `${REPORTER}process.on('SIGTERM', () => beat('SIGTERM'));\n`;
/** Ordner im Arbeitsbereich, den der Prüfstand nicht löschen kann (0500 mit Inhalt). */
const LOCK = "const locked = join(dirname(process.env.SQLITE_PATH), 'gesperrt'); if (!existsSync(locked)) { mkdirSync(locked); writeFileSync(join(locked, 'rest'), 'x'); chmodSync(locked, 0o500); }";
const HANG_LOCKED = `${REPORTER.replace('import { appendFileSync, existsSync,', 'import { appendFileSync, chmodSync, existsSync, mkdirSync,')}${LOCK}\n`;
/** Nach einem absichtlich gesperrten Lauf: Rechte zurück, dann entfernen. */
function unlock(work) {
  for (const entry of existsSync(work) ? readdirSync(work, { recursive: true }) : []) {
    try { chmodSync(join(work, entry), 0o700); } catch { /* bereits entfernt */ }
  }
  rmSync(work, { recursive: true, force: true });
}
/** Lässt keinen Prüfstand oder Migrationsschritt zurück, wenn ein Test vorzeitig scheitert. */
function reap(child, home) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  const kind = readJson(join(home, 'kind.json'));
  if (kind && alive(kind.pid)) process.kill(kind.pid, 'SIGKILL');
}
/**
 * Hängt ein Lauf, beendet diese Frist Prüfstand und Migrationsschritt nach 60 s: Der Test
 * scheitert dann an seinen Prüfungen, statt die Suite anzuhalten (node:test bricht hängende
 * Tests ab, ohne ihr finally auszuführen). Rückgabe: Frist aufheben und aufräumen.
 */
function deadline(child, home) {
  const timer = setTimeout(() => reap(child, home), 60000);
  return () => {
    clearTimeout(timer);
    reap(child, home);
  };
}

/** Echter Migrationsschritt, danach `extra` (nur wenn er gelang). */
const AFTER_REAL = (extra) => `
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
const real = spawnSync(process.execPath, [fileURLToPath(new URL('./db-migrate-echt.mjs', import.meta.url))], { stdio: 'inherit' });
if (real.status === 0) {
${extra}
}
process.exit(real.status ?? 1);
`;

const projects = new Map();
const stubProject = (stub) => {
  if (!projects.has(stub)) projects.set(stub, isolatedProject({ stub }));
  return projects.get(stub);
};

/** Nach dem Lauf: Klartext weg, Quelle samt Nebendateien unverändert. */
function assertCleaned(result, work, dir, before) {
  assert.equal(existsSync(work), false, 'Arbeitsordner samt Klartext entfernt');
  assert.deepEqual(snapshot(dir), before, 'Quelle des Aufrufers unverändert, keine Nebendateien');
  assert.match(`${result.stdout}${result.stderr}`, /^PXK-AC3 cleanup=verified$/m);
}

test('M-4 PASS: Arbeitsordner (samt neu angelegter Elternordner) entfernt, Quelle bleibt', { skip }, () => {
  const { dir, path } = source({ walRows: 20 });
  const before = snapshot(dir);
  const top = join(tempDir(), 'neu');
  const work = join(top, 'tiefer', 'arbeit');
  const result = harness([`--source=${path}`, `--workdir=${work}`]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.value('verdict='), 'PXK-AC3 verdict=PASS');
  assertCleaned(result, top, dir, before);
  assertPrivate(result);
});

test('M-4 Geschäftsdaten-FAIL: Klartext entfernt', { skip }, () => {
  const { dir, path } = source({ missingTemplate: 'angebot' });
  const before = snapshot(dir);
  const work = join(tempDir(), 'arbeit');
  const result = harness([`--source=${path}`, `--workdir=${work}`]);
  assert.equal(result.status, 1);
  assert.match(result.value('failures='), /business_data/);
  assertCleaned(result, work, dir, before);
  assertPrivate(result, ['Ihr Angebot', 'Angebot · Webauftritt']);
});

test('M-4 Schema-FAIL (Kandidat legt einen fremden Index an): Klartext entfernt', { skip }, () => {
  const { dir, path } = source();
  const before = snapshot(dir);
  const project = stubProject(AFTER_REAL("  const db = new Database(process.env.SQLITE_PATH); db.exec('CREATE INDEX fremd_idx ON leads (name)'); db.close();"));
  const work = join(tempDir(), 'arbeit');
  const result = harness([`--source=${path}`, `--workdir=${work}`], {}, project);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.value('failures='), 'PXK-AC3 failures=after_ledger_state,ledger_rows,schema_canonical,run2_noop');
  assert.equal(result.value('changed_tables='), 'PXK-AC3 changed_tables=0');
  assertCleaned(result, work, dir, before);
  assertPrivate(result);
});

test('M-4 interne Ausnahme (unlesbare Sicherung im Sicherungsziel): Klartext entfernt, nur Fehlertyp auf stderr', { skip }, () => {
  const { dir, path } = source();
  const before = snapshot(dir);
  const project = stubProject(AFTER_REAL("  mkdirSync(process.env.PXK_DB_BACKUP_DIR, { recursive: true }); writeFileSync(join(process.env.PXK_DB_BACKUP_DIR, 'pre-zz-kaputt.db'), Buffer.alloc(4096, 0x5a));"));
  const work = join(tempDir(), 'arbeit');
  const result = harness([`--source=${path}`, `--workdir=${work}`], {}, project);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'PXK-AC3 error=SQLITE_NOTADB\nPXK-AC3 cleanup=verified\nPXK-AC3 verdict=FAIL\n');
  assertCleaned(result, work, dir, before);
});

for (const [signal, exit] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129], ['SIGQUIT', 131]]) {
  test(`M-4 ${signal} während des Migrationsschritts: Schritt beendet, dann Klartext entfernt (Exit ${exit}); Klartext war 0600/0700`, { skip, timeout: 90000 }, async () => {
    const { dir, path } = source();
    const before = snapshot(dir);
    const home = tempDir();
    const work = join(tempDir(), 'arbeit');
    const { child, done } = startHarness([`--source=${path}`, `--workdir=${work}`], { HOME: home }, stubProject(HANG));
    const stop = deadline(child, home);
    try {
      const kind = await waitFor(() => readJson(join(home, 'kind.json')), 'Migrationsschritt läuft');
      assert.deepEqual({ copy: kind.copy, root: kind.root, workdir: kind.workdir }, { copy: '600', root: '700', workdir: '700' });
      assert.ok(existsSync(work), 'Klartext existiert während des Laufs');
      child.kill(signal);
      const result = await done;
      assert.equal(result.status, exit, result.stdout + result.stderr);
      assert.equal(result.value('interrupted='), `PXK-AC3 interrupted=${signal}`);
      assert.equal(result.value('failures='), 'PXK-AC3 failures=interrupted');
      assert.equal(result.value('verdict='), 'PXK-AC3 verdict=FAIL');
      assert.equal(alive(kind.pid), false, 'Migrationsschritt beendet');
      assertCleaned(result, work, dir, before);
      assertPrivate(result);
      const beats = readFileSync(join(home, 'puls.log'), 'utf8').trim().split('\n');
      assert.ok(beats[0] === 'start copy=true' && beats.every(line => line.endsWith(' copy=true')), `solange der Schritt lief, war die Kopie da: ${beats.join(' | ')}`);
    } finally {
      stop();
    }
  });
}

test('M-4 Migrationsschritt ignoriert SIGTERM: SIGKILL nach Wartezeit, gelöscht erst nach seinem Ende', { skip, timeout: 90000 }, async () => {
  const { dir, path } = source();
  const before = snapshot(dir);
  const home = tempDir();
  const work = join(tempDir(), 'arbeit');
  const { child, done } = startHarness([`--source=${path}`, `--workdir=${work}`], { HOME: home }, stubProject(IGNORES_SIGTERM));
  const stop = deadline(child, home);
  try {
    const kind = await waitFor(() => readJson(join(home, 'kind.json')), 'Migrationsschritt läuft');
    const started = Date.now();
    child.kill('SIGTERM');
    const result = await done;
    assert.ok(Date.now() - started >= 1500, 'Wartezeit vor SIGKILL eingehalten');
    assert.equal(result.status, 143, result.stdout + result.stderr);
    assert.equal(alive(kind.pid), false, 'Migrationsschritt per SIGKILL beendet');
    assertCleaned(result, work, dir, before);
    const beats = readFileSync(join(home, 'puls.log'), 'utf8').trim().split('\n');
    assert.ok(beats.some(line => line === 'SIGTERM copy=true'), 'SIGTERM erreichte den Schritt, die Kopie war da');
    assert.ok(beats.every(line => line.endsWith(' copy=true')), `nie gelöscht, solange der Schritt lebte: ${beats.join(' | ')}`);
  } finally {
    stop();
  }
});

test('M-4 Löschen nicht nachweisbar (gesperrter Ordner im Arbeitsbereich) → FAIL, Exit 3, cleanup=FAILED — auch nach Ausnahme und Signal', { skip, timeout: 90000 }, async () => {
  const { path } = source();
  const work = () => join(tempDir(), 'arbeit');
  // gewöhnlicher Lauf
  const plain = work();
  const result = harness([`--source=${path}`, `--workdir=${plain}`], {}, stubProject(AFTER_REAL(`  ${LOCK}`)));
  try {
    assert.equal(result.status, 3, result.stdout + result.stderr);
    assert.equal(result.value('cleanup='), 'PXK-AC3 cleanup=FAILED');
    assert.match(result.value('failures='), /^PXK-AC3 failures=(.+,)?cleanup$/);
    assert.equal(result.value('verdict='), 'PXK-AC3 verdict=FAIL');
    assertPrivate(result);
  } finally {
    unlock(plain);
  }
  // interne Ausnahme
  const thrown = work();
  const junk = "mkdirSync(process.env.PXK_DB_BACKUP_DIR, { recursive: true }); writeFileSync(join(process.env.PXK_DB_BACKUP_DIR, 'pre-zz-kaputt.db'), Buffer.alloc(4096, 0x5a));";
  const exception = harness([`--source=${path}`, `--workdir=${thrown}`], {}, stubProject(AFTER_REAL(`  ${LOCK} ${junk}`)));
  try {
    assert.equal(exception.status, 3, exception.stdout + exception.stderr);
    assert.equal(exception.stderr, 'PXK-AC3 error=SQLITE_NOTADB\nPXK-AC3 cleanup=FAILED\nPXK-AC3 verdict=FAIL\n');
  } finally {
    unlock(thrown);
  }
  // Signal während des Migrationsschritts
  const signalled = work();
  const home = tempDir();
  const { child, done } = startHarness([`--source=${path}`, `--workdir=${signalled}`], { HOME: home }, stubProject(HANG_LOCKED));
  const stop = deadline(child, home);
  try {
    await waitFor(() => readJson(join(home, 'kind.json')) && existsSync(join(home, 'puls.log')), 'Migrationsschritt läuft');
    child.kill('SIGINT');
    const interrupted = await done;
    assert.equal(interrupted.status, 3, interrupted.stdout + interrupted.stderr);
    assert.equal(interrupted.value('failures='), 'PXK-AC3 failures=interrupted,cleanup');
    assert.equal(interrupted.value('cleanup='), 'PXK-AC3 cleanup=FAILED');
  } finally {
    stop();
    unlock(signalled);
  }
});

test('M-4 Arbeitsordner mit ..-Abschnitten: geprüft, angelegt und gelöscht wird derselbe Ordner', { skip }, () => {
  const { dir, path } = source();
  const before = snapshot(dir);
  const top = tempDir();
  const result = harness([`--source=${path}`, `--workdir=${join(top, 'a')}/../b`]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.value('cleanup='), 'PXK-AC3 cleanup=verified');
  assert.deepEqual(readdirSync(top), [], 'weder a noch b bleiben zurück');
  // ein ..-Pfad, der auf den Ordner der Quelle zeigt, ist nicht leer → verweigert, nichts angelegt
  const refused = harness([`--source=${path}`, `--workdir=${join(dir, 'x')}/..`]);
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /nicht leer/);
  assert.deepEqual(snapshot(dir), before);
});

test('M-4 Arbeitsordner nicht anlegbar (EACCES): FAIL mit Exit 1 — kein falscher Alarm „nicht gelöscht"', { skip }, () => {
  const { path } = source();
  const parent = join(tempDir(), 'nur-lesen');
  mkdirSync(parent);
  chmodSync(parent, 0o500);
  try {
    const result = harness([`--source=${path}`, `--workdir=${join(parent, 'arbeit')}`]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.stderr, 'PXK-AC3 error=EACCES\nPXK-AC3 cleanup=verified\nPXK-AC3 verdict=FAIL\n');
  } finally {
    chmodSync(parent, 0o700);
  }
});

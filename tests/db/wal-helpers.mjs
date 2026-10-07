/**
 * Hilfen für die -wal-Tests (H-2): echte Schreiber, die per SIGKILL enden,
 * Prüfsummen nach https://sqlite.org/fileformat2.html#walformat (unabhängig
 * von lib/db/open.mjs nachgerechnet), Lagen auf Platte und die Prüfung, dass
 * eine Lage an allen Grenzen abgewiesen bzw. offen ist.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { endianness } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase, openProblem } from '../../lib/db/open.mjs';
import { ROOT, tempDir } from './helpers.mjs';

export const PAGE = 4096;
export const FRAME = 24 + PAGE;
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
export const snapshot = (dir) => Object.fromEntries(readdirSync(dir).sort().map(name => [name, sha(join(dir, name))]));
export const rows = (n, tag) => `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${n}) INSERT INTO t SELECT '${tag}' || printf('%0200d', i) FROM n`;

/** Schreiber in eigenem Prozess, per SIGKILL beendet: kein Checkpoint beim Schließen; -wal und -shm bleiben. */
export function killedWriter(path, script, { wal = true } = {}) {
  const writer = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import Database from 'better-sqlite3';
    import { openDatabase, openProblem } from ${JSON.stringify(join(ROOT, 'lib', 'db', 'open.mjs'))};
    const db = ${wal ? `new Database(${JSON.stringify(path)})` : 'null'};
    if (db) { db.pragma('journal_mode = WAL'); db.pragma('wal_autocheckpoint = 0'); }
    ${script}
    process.kill(process.pid, 'SIGKILL');
  `], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(writer.signal, 'SIGKILL', writer.stderr);
}

/** -wal-Prüfsumme: Paare von 32-Bit-Wörtern, Byte-Reihenfolge nach Bit 0 der Kennung. */
export function walSum(data, [a, b], be) {
  for (let i = 0; i < data.length; i += 8) {
    a = (a + (be ? data.readUInt32BE(i) : data.readUInt32LE(i)) + b) >>> 0;
    b = (b + (be ? data.readUInt32BE(i + 4) : data.readUInt32LE(i + 4)) + a) >>> 0;
  }
  return [a, b];
}
const bigEndian = (wal) => (wal.readUInt32BE(0) & 1) === 1;
export const frameAt = (index, pageSize = PAGE) => 32 + index * (24 + pageSize);
export const frameCount = (wal, pageSize = PAGE) => Math.floor((wal.length - 32) / (24 + pageSize));
/** Kopf-Prüfsumme neu (nach einer Änderung an Bytes 0–23). */
export function reseal(wal) {
  const sum = walSum(wal.subarray(0, 24), [0, 0], bigEndian(wal));
  wal.writeUInt32BE(sum[0], 24);
  wal.writeUInt32BE(sum[1], 28);
}
/** Frame-Kette ab dem Kopf neu: jeder Frame wieder gültig fortgesetzt. */
export function rechain(wal, pageSize = PAGE) {
  let sum = [wal.readUInt32BE(24), wal.readUInt32BE(28)];
  for (let i = 0; i < frameCount(wal, pageSize); i += 1) {
    const at = frameAt(i, pageSize);
    sum = walSum(wal.subarray(at + 24, at + 24 + pageSize), walSum(wal.subarray(at, at + 8), sum, bigEndian(wal)), bigEndian(wal));
    wal.writeUInt32BE(sum[0], at + 16);
    wal.writeUInt32BE(sum[1], at + 20);
  }
}
/** Salz im Kopf und in jedem Frame ersetzen, dann Kopf und Kette neu: dasselbe -wal mit anderem Salz. */
export function resalt(wal, salt) {
  salt.copy(wal, 16);
  for (let i = 0; i < frameCount(wal); i += 1) salt.copy(wal, frameAt(i) + 8);
  reseal(wal);
  rechain(wal);
}
/** Kopf wie bei einem Neustart (walRestartHdr): Prüfpunkt + 1, Salz-1 + 1, neues Salz-2. */
export function restart(wal) {
  wal.writeUInt32BE(wal.readUInt32BE(12) + 1, 12);
  wal.writeUInt32BE((wal.readUInt32BE(16) + 1) >>> 0, 16);
  wal.writeUInt32BE(0x5eed5eed, 20);
  reseal(wal);
}
/**
 * WAL-Index (-shm), 32 KiB, wie ihn walIndexWriteHdr schreibt: zwei gleiche Kopien des
 * 48-Byte-Kopfs, Prüfsumme über Bytes 0–39 in der Bytereihenfolge dieser Maschine.
 */
export function walIndex({ mxFrame, salt, nPage = 1, version = 3007000, isInit = 1, iChange = 1 }) {
  const le = endianness() === 'LE';
  const head = Buffer.alloc(48);
  const put = (value, at) => (le ? head.writeUInt32LE(value, at) : head.writeUInt32BE(value, at));
  put(version, 0);
  put(iChange, 8);
  head[12] = isInit;
  (le ? head.writeUInt16LE : head.writeUInt16BE).call(head, PAGE, 14);
  put(mxFrame, 16);
  put(nPage, 20);
  salt.copy(head, 32);
  const sum = walSum(head.subarray(0, 40), [0, 0], !le);
  put(sum[0], 40);
  put(sum[1], 44);
  const shm = Buffer.alloc(32768);
  head.copy(shm, 0);
  head.copy(shm, 48);
  return shm;
}
export const commitsOf = (wal) => Array.from({ length: frameCount(wal) }, (_, i) => i).filter(i => wal.readUInt32BE(frameAt(i) + 4) > 0);

/** Wie in Produktion: Hauptdatei eine Seite, alle Daten im -wal, mehrere abgeschlossene Transaktionen (240 Zeilen). */
export function prodPair() {
  const path = join(tempDir(), 'p.db');
  killedWriter(path, `db.exec("CREATE TABLE t (a)"); ${['a', 'b', 'c', 'd'].map(tag => `db.exec(${JSON.stringify(rows(60, tag))});`).join(' ')}`);
  const pair = { main: readFileSync(path), wal: readFileSync(`${path}-wal`), shm: readFileSync(`${path}-shm`) };
  assert.equal(pair.main.length, PAGE);
  assert.ok(commitsOf(pair.wal).length >= 5, 'mehrere Commits im -wal');
  return pair;
}

/** Das -shm, das SQLite selbst beim lesenden Öffnen neu aufbaut (walIndexRecover) und liegen lässt. */
export function rebuiltIndex(main, wal) {
  const path = join(tempDir(), 'gelesen.db');
  writeFileSync(path, main);
  writeFileSync(`${path}-wal`, wal);
  const db = new Database(path, { readonly: true });
  try { db.prepare('SELECT count(*) FROM sqlite_master').get(); } finally { db.close(); }
  assert.ok(existsSync(`${path}-shm`), 'SQLite ließ ein -shm liegen');
  return readFileSync(`${path}-shm`);
}

/** Was SQLite aus Hauptdatei + -wal liest (auf einer Kopie): Ergebnis von `sql` oder der Fehlercode. */
export function sqliteValue(main, wal, sql = 'SELECT count(*) FROM t') {
  const path = join(tempDir(), 'kopie.db');
  writeFileSync(path, main);
  writeFileSync(`${path}-wal`, wal);
  try {
    const db = new Database(path, { readonly: true });
    try { return db.prepare(sql).pluck().get(); } finally { db.close(); }
  } catch (error) {
    return error.code ?? 'Fehler';
  }
}

/** Eigener Ordner mit crm.db, -wal und (wenn angegeben) -shm. */
export function lage(main, wal, shm = null) {
  const dir = tempDir();
  const path = join(dir, 'crm.db');
  writeFileSync(path, main);
  writeFileSync(`${path}-wal`, wal);
  if (shm) writeFileSync(`${path}-shm`, shm);
  return { dir, path, before: snapshot(dir) };
}

const CLI = join(ROOT, 'scripts', 'db-migrate.mjs');
export const cli = (args, env) => spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, encoding: 'utf8' });

/** Abgewiesen an allen Grenzen, bevor SQLite öffnet: Dateien bytegleich, kein (neues) -shm, keine Sicherung. */
export function assertRefused(name, main, wal, { verdict = 'damaged-wal', shm = null } = {}) {
  const { dir, path, before } = lage(main, wal, shm);
  assert.equal(openProblem(path).verdict, verdict, name);
  // bei einem beschädigten -wal: erst alle drei Dateien kopieren; nach Stromausfall der Weg über eine Kopie
  const message = verdict === 'damaged-wal' ? /alle drei kopieren[\s\S]*lesend und schreibend öffnen, eine Abfrage ausführen/ : /./;
  for (const mode of ['apply', 'app', 'inspect']) assert.throws(() => openDatabase(path, mode), { code: 'UNKNOWN_SCHEMA', message }, `${name} ${mode}`);
  const backups = join(tempDir(), 'sicherungen');
  const migrate = cli([], { SQLITE_PATH: path, RAILWAY_ENVIRONMENT_NAME: 'production', PXK_DB_BACKUP_DIR: backups });
  assert.equal(migrate.status, 12, `${name}: ${migrate.stderr}`);
  assert.doesNotMatch(migrate.stderr, /INTERNAL|\n\s+at /, `${name}: kein Stacktrace`);
  const check = cli(['--check'], { SQLITE_PATH: path });
  assert.equal(check.status, 12, `${name} --check: ${check.stdout}`);
  assert.match(check.stdout, new RegExp(`^PXK-DB report verdict=${verdict}$`, 'm'), name);
  assert.deepEqual(snapshot(dir), before, `${name}: Hauptdatei, -wal (und -shm) bytegleich`);
  assert.equal(existsSync(backups), false, `${name}: keine Sicherung`);
}

/** Offen: Prüfung ohne Befund, SQLite öffnet und liest genau das, was es auch ohne Prüfung läse. */
export function assertAccepted(name, main, wal, { shm = null, sql = 'SELECT count(*) FROM t' } = {}) {
  const { path } = lage(main, wal, shm);
  const seen = sqliteValue(main, wal, sql);
  assert.equal(openProblem(path).verdict, null, `${name}: ${openProblem(path).detail}`);
  const db = openDatabase(path, 'apply');
  try {
    assert.equal(db.prepare(sql).pluck().get(), seen, name);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok', name);
  } finally {
    db.close();
  }
  return seen;
}

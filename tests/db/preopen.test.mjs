/**
 * M-1: Keine DB-Grenze öffnet eine Hauptdatei, bei der SQLite ein daneben
 * liegendes, nicht leeres -wal verändern würde — App (ensureDatabase),
 * Migration (Entwicklung und Produktion), Bericht (--report/--check) und
 * AC3-Prüfstand. Ungültig ist jede Hauptdatei ohne vollständigen, plausiblen
 * Kopf oder mit angebrochener Seite (lib/db/open.mjs), nicht nur 0 oder 1 Byte.
 *
 * Für jede ungültige Lage gilt: verweigert, Hauptdatei, -wal und -shm
 * bytegleich bzw. weiter fehlend, keine neue Datenbank, keine Sicherung.
 * Eine gültige Hauptdatei mit -wal wird dagegen normal geöffnet und verliert nichts.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { assertOpenable, inspectMainFile, openDatabase, openProblem } from '../../lib/db/open.mjs';
import { runAppScript } from './app-modules.mjs';
import { project, skip, source } from './ac3-helpers.mjs';
import { ROOT, tempDir } from './helpers.mjs';

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
/** Alle Dateien eines Ordners mit Prüfsumme: zeigt jede neue, fehlende oder veränderte Datei (auch -shm). */
const snapshot = (dir) => Object.fromEntries(readdirSync(dir).sort().map(name => [name, sha(join(dir, name))]));

/** Schreiber in eigenem Prozess, per SIGKILL beendet: kein Checkpoint, die Änderungen liegen nur im -wal. */
function killedWriter(path, sql) {
  const writer = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import Database from 'better-sqlite3';
    const db = new Database(${JSON.stringify(path)});
    db.pragma('journal_mode = WAL');
    db.pragma('wal_autocheckpoint = 0');
    db.exec(${JSON.stringify(sql)});
    process.kill(process.pid, 'SIGKILL');
  `], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(writer.signal, 'SIGKILL', writer.stderr);
}
const rowsSql = (n) => `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${n}) INSERT INTO t SELECT printf('%0200d', i) FROM n`;

/** Wie in Produktion: Hauptdatei 4096 Byte (WAL-Format), alle Daten im -wal. */
function walPair() {
  const path = join(tempDir(), 'schreiber.db');
  killedWriter(path, `CREATE TABLE t (a); ${rowsSql(200)}`);
  const pair = { main: readFileSync(path), wal: readFileSync(`${path}-wal`) };
  assert.equal(pair.main.length, 4096);
  assert.ok(pair.wal.length > 4096, 'Daten liegen im -wal');
  return pair;
}
const PAIR = walPair();

/** Hauptdatei mit allen Seiten (Checkpoint), danach ein kleines -wal mit wenigen geänderten Seiten. */
function checkpointedPair() {
  const path = join(tempDir(), 'ck.db');
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE t (a); ${rowsSql(2000)}`);
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  killedWriter(path, "UPDATE t SET a = 'neu' WHERE rowid % 97 = 0");
  return { main: readFileSync(path), wal: readFileSync(`${path}-wal`) };
}
const CK = checkpointedPair();
const ckPages = CK.main.length / 4096;

/** Ungültige Hauptdateien neben einem nicht leeren -wal (main null = Hauptdatei fehlt). */
const INVALID = {
  'Hauptdatei fehlt': { main: null },
  '0 Byte': { main: PAIR.main.subarray(0, 0) },
  '1 Byte': { main: PAIR.main.subarray(0, 1) },
  'abgeschnittener Kopf (50 Byte)': { main: PAIR.main.subarray(0, 50) },
  'nur der 100-Byte-Kopf': { main: PAIR.main.subarray(0, 100) },
  'angebrochene erste Seite (4095 Byte)': { main: PAIR.main.subarray(0, 4095) },
  'eine Seite und ein Byte (4097 Byte)': { main: Buffer.concat([PAIR.main, Buffer.alloc(1)]) },
  'fremde Datei': { main: Buffer.alloc(4096, 0x5a) },
  // auf eine Seitengrenze abgeschnitten (volle Platte, abgebrochene Kopie): Seiten fehlen in Hauptdatei und -wal
  'auf Seitengrenze abgeschnitten: nur Seite 1': { main: CK.main.subarray(0, 4096), wal: CK.wal },
  'auf Seitengrenze abgeschnitten: halbe Datei': { main: CK.main.subarray(0, Math.floor(ckPages / 2) * 4096), wal: CK.wal },
};

/** Eigener Ordner mit crm.db (oder ohne) und dem -wal daneben. */
function lage({ main, wal = PAIR.wal }) {
  const dir = tempDir();
  const path = join(dir, 'crm.db');
  if (main) writeFileSync(path, main);
  writeFileSync(`${path}-wal`, wal);
  return { dir, path, before: snapshot(dir) };
}

const CLI = join(ROOT, 'scripts', 'db-migrate.mjs');
const cli = (args, env) => spawnSync(process.execPath, [CLI, ...args], {
  cwd: ROOT,
  env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  encoding: 'utf8',
});

test('Vorprüfung: Aufbau statt Bytezahl — gültig nur mit vollständigem Kopf aus ganzen Seiten', () => {
  const dir = tempDir();
  const write = (name, bytes) => { const p = join(dir, name); writeFileSync(p, bytes); return p; };
  assert.equal(inspectMainFile(join(dir, 'fehlt.db')).state, 'absent');
  assert.equal(inspectMainFile(write('leer.db', '')).state, 'empty');
  assert.equal(inspectMainFile(write('echt.db', PAIR.main)).state, 'valid', 'Hauptdatei im WAL-Modus, Rest im -wal');
  for (const [name, { main, wal }] of Object.entries(INVALID)) {
    if (!main?.length || wal) continue;
    const info = inspectMainFile(write('x.db', main));
    assert.equal(info.state, 'invalid', name);
    assert.ok(info.reason, name);
  }
  // Kopffelder einzeln verfälscht
  const variant = (offset, value, size = 2) => { const b = Buffer.from(PAIR.main); if (size === 2) b.writeUInt16BE(value, offset); else b[offset] = value; return b; };
  const smallPages = variant(16, 512);
  smallPages[20] = 100; // 512 - 100 = 412 nutzbare Bytes < 480
  // keine Zweierpotenz, aber ganze „Seiten": nur die Zweierpotenz-Regel greift
  const notPow2 = Buffer.concat([PAIR.main, Buffer.alloc(8192)]);
  notPow2.writeUInt16BE(3072, 16);
  const fields = { 'Seitengröße 1000': variant(16, 1000), 'Seitengröße 256': variant(16, 256), 'Seitengröße 3072': notPow2, 'Leseversion 3': variant(19, 3, 1), 'Schreibversion 0': variant(18, 0, 1), 'Nutzlast-Anteil': variant(21, 65, 1), 'Reserve zu groß': smallPages };
  for (const [name, bytes] of Object.entries(fields)) assert.equal(inspectMainFile(write('feld.db', bytes)).state, 'invalid', name);
  // andere gültige Seitengrößen (512, 65536 als 1 im Kopf)
  for (const size of [512, 65536]) {
    const p = join(dir, `seite-${size}.db`);
    const db = new Database(p);
    db.pragma(`page_size = ${size}`);
    db.exec('CREATE TABLE t (a); INSERT INTO t VALUES (1)');
    db.close();
    assert.equal(inspectMainFile(p).state, 'valid', `Seitengröße ${size}`);
  }
  mkdirSync(join(dir, 'ordner.db'));
  assert.equal(inspectMainFile(join(dir, 'ordner.db')).state, 'invalid', 'Ordner statt Datei');
});

test('Vorprüfung folgt Symlinks wie SQLite: -wal neben der echten Datei zählt — auch hinter einem Verweis ins Leere', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'echt.db'), '');
  writeFileSync(join(dir, 'echt.db-wal'), PAIR.wal);
  const link = join(tempDir(), 'verweis.db');
  symlinkSync(join(dir, 'echt.db'), link);
  assert.equal(openProblem(link).verdict, 'orphaned-wal');
  assert.throws(() => assertOpenable(link), { code: 'UNKNOWN_SCHEMA' });
  // Ziel fehlt ganz, nur sein -wal liegt da: SQLite legte das Ziel an und löschte das -wal
  const vol = tempDir();
  writeFileSync(join(vol, 'crm.db-wal'), PAIR.wal);
  const dangling = join(tempDir(), 'crm.db');
  symlinkSync(join(vol, 'crm.db'), dangling);
  const before = snapshot(vol);
  assert.equal(openProblem(dangling).verdict, 'orphaned-wal');
  for (const env of [{}, { NODE_ENV: 'production', PXK_DB_ALLOW_FRESH: '1', PXK_DB_BACKUP_DIR: join(tempDir(), 'b') }]) {
    const result = cli(['--no-seed'], { SQLITE_PATH: dangling, ...env });
    assert.equal(result.status, 12, result.stderr);
    assert.deepEqual(snapshot(vol), before, 'kein Ziel angelegt, -wal bytegleich');
  }
});

test('Vorprüfung löst Pfade physisch wie SQLite auf: „..“ hinter einem Ordner-Symlink und relative Verweisziele', () => {
  const root = tempDir();
  mkdirSync(join(root, 'r', 'x', 'y'), { recursive: true });
  mkdirSync(join(root, 'r', 'x', 'z'), { recursive: true });
  mkdirSync(join(root, 'o'));
  symlinkSync(join(root, 'r', 'x', 'y'), join(root, 'o', 'link'));
  const cut = CK.main.subarray(0, Math.floor(ckPages / 2) * 4096);
  // o/link/../crm.db ist physisch r/x/crm.db (textuell wäre es o/crm.db)
  writeFileSync(join(root, 'r', 'x', 'crm.db'), cut);
  writeFileSync(join(root, 'r', 'x', 'crm.db-wal'), CK.wal);
  assert.equal(openProblem(`${join(root, 'o', 'link')}/../crm.db`).verdict, 'invalid-file', 'nicht path.join: das kürzte „..“ textuell');
  // o/link/crm.db → '../z/crm.db' ist physisch r/x/z/crm.db
  symlinkSync('../z/crm.db', join(root, 'r', 'x', 'y', 'crm.db'));
  writeFileSync(join(root, 'r', 'x', 'z', 'crm.db'), cut);
  writeFileSync(join(root, 'r', 'x', 'z', 'crm.db-wal'), CK.wal);
  assert.equal(openProblem(join(root, 'o', 'link', 'crm.db')).verdict, 'invalid-file');
  // dieselbe Kette ins Leere, nur das -wal liegt am Ziel: verwaist, Migration legt nichts an
  writeFileSync(join(root, 'r', 'x', 'z', 'crm.db'), '');
  rmSync(join(root, 'r', 'x', 'z', 'crm.db'));
  const before = snapshot(join(root, 'r', 'x', 'z'));
  assert.equal(openProblem(join(root, 'o', 'link', 'crm.db')).verdict, 'orphaned-wal');
  const result = cli(['--no-seed'], { SQLITE_PATH: join(root, 'o', 'link', 'crm.db') });
  assert.equal(result.status, 12, result.stderr);
  assert.deepEqual(snapshot(join(root, 'r', 'x', 'z')), before, 'kein Ziel angelegt, -wal bytegleich');
});

/** -wal-Prüfsumme nach https://sqlite.org/fileformat2.html#walformat (unabhängig von lib/db/open.mjs nachgebaut). */
function walSum(data, s = [0, 0]) {
  let [a, b] = s;
  for (let i = 0; i < data.length; i += 8) {
    a = (a + data.readUInt32LE(i) + b) >>> 0;
    b = (b + data.readUInt32LE(i + 4) + a) >>> 0;
  }
  return [a, b];
}

test('Vorprüfung: die Sperr-Byte-Seite bei 1 GiB legt SQLite nie an — sie fehlt nicht (Datenbank über 1 GiB, Hauptdatei kürzer)', () => {
  const pageSize = 65536;
  const lockPage = 0x40000000 / pageSize + 1;
  const path = join(tempDir(), 'gross.db');
  // Hauptdatei: gültiger Kopf, Seiten 1 bis lockPage - 1 (dünn besetzt, belegt kaum Platz)
  const head = Buffer.alloc(100);
  Buffer.from('SQLite format 3\0', 'latin1').copy(head);
  head.writeUInt16BE(1, 16); // 65536
  head[18] = head[19] = 2;
  head[21] = 64; head[22] = 32; head[23] = 32;
  head.writeUInt32BE(7, 24); head.writeUInt32BE(lockPage - 1, 28); head.writeUInt32BE(7, 92);
  writeFileSync(path, head);
  truncateSync(path, (lockPage - 1) * pageSize);
  // -wal: ein Commit-Frame für die Seite nach der Sperr-Byte-Seite
  const walHead = Buffer.alloc(32);
  walHead.writeUInt32BE(0x377f0682, 0); walHead.writeUInt32BE(3007000, 4); walHead.writeUInt32BE(pageSize, 8);
  walHead.writeUInt32BE(0x1234, 16); walHead.writeUInt32BE(0x5678, 20);
  let sum = walSum(walHead.subarray(0, 24));
  walHead.writeUInt32BE(sum[0], 24); walHead.writeUInt32BE(sum[1], 28);
  const frame = Buffer.alloc(24 + pageSize);
  frame.writeUInt32BE(lockPage + 1, 0); frame.writeUInt32BE(lockPage + 1, 4);
  walHead.copy(frame, 8, 16, 24);
  sum = walSum(frame.subarray(24), walSum(frame.subarray(0, 8), sum));
  frame.writeUInt32BE(sum[0], 16); frame.writeUInt32BE(sum[1], 20);
  writeFileSync(`${path}-wal`, Buffer.concat([walHead, frame]));
  assert.equal(openProblem(path).verdict, null, 'vollständig: Seite lockPage zählt nicht');
  // Gegenprobe: fehlt der Frame für lockPage + 1, ist es eine echte Lücke
  frame.writeUInt32BE(lockPage + 2, 0); frame.writeUInt32BE(lockPage + 2, 4);
  sum = walSum(frame.subarray(24), walSum(frame.subarray(0, 8), walSum(walHead.subarray(0, 24))));
  frame.writeUInt32BE(sum[0], 16); frame.writeUInt32BE(sum[1], 20);
  writeFileSync(`${path}-wal`, Buffer.concat([walHead, frame]));
  assert.match(String(openProblem(path).detail), new RegExp(`Seite ${lockPage + 1} fehlt`));
});

test('Vorprüfung: ein nur vorübergehender Befund (gleichzeitiger Schreiber) wird beim erneuten Lesen verworfen', async () => {
  const path = join(tempDir(), 'crm.db');
  writeFileSync(path, PAIR.main.subarray(0, 4095));
  writeFileSync(`${path}-wal`, PAIR.wal);
  // ein anderer Prozess schreibt die erste Seite nach 40 ms fertig (cp: kurz auch 0 Byte)
  const full = join(tempDir(), 'voll.db');
  writeFileSync(full, PAIR.main);
  const writer = spawn('sh', ['-c', `sleep 0.04; cp "${full}" "${path}"`]);
  const exited = new Promise(resolve => writer.once('exit', resolve));
  assert.equal(openProblem(path).verdict, null);
  await exited;
  // bleibt die Datei abgeschnitten, bleibt es beim Befund
  writeFileSync(path, PAIR.main.subarray(0, 4095));
  assert.equal(openProblem(path).verdict, 'invalid-file');
});

test('Vorprüfung: Absturz mitten im Checkpoint (Hauptdatei teils nachgeschrieben, -wal vollständig) bleibt offen — SQLite stellt alles wieder her', () => {
  const path = join(tempDir(), 'crm.db');
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec("CREATE TABLE t (a); INSERT INTO t VALUES ('start')");
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  killedWriter(path, rowsSql(3000));
  // Checkpoint schreibt Seiten aufsteigend: die ersten k Seiten in der Fassung aus dem -wal, dann „Absturz"
  const wal = readFileSync(`${path}-wal`);
  const latest = new Map();
  for (let offset = 32; offset + 24 + 4096 <= wal.length; offset += 24 + 4096) latest.set(wal.readUInt32BE(offset), wal.subarray(offset + 24, offset + 24 + 4096));
  const pages = Math.max(...latest.keys());
  const fd = openSync(path, 'r+');
  for (let page = 1; page <= Math.floor(pages / 2); page += 1) if (latest.has(page)) writeSync(fd, latest.get(page), 0, 4096, (page - 1) * 4096);
  closeSync(fd);
  assert.ok(statSync(path).size < pages * 4096, 'Hauptdatei kürzer als die Datenbank');
  assert.equal(openProblem(path).verdict, null);
  const opened = openDatabase(path, 'apply');
  try {
    assert.equal(opened.prepare('SELECT count(*) AS c FROM t').get().c, 3001);
    assert.equal(opened.pragma('integrity_check', { simple: true }), 'ok');
  } finally {
    opened.close();
  }
});

test('Bericht scheitert nie an Dateisystemfehlern: ENOTDIR → absent, nicht lesbar (EACCES) → invalid-file, kein Stacktrace', () => {
  const file = join(tempDir(), 'datei.txt');
  writeFileSync(file, 'x');
  const notDir = cli(['--report'], { SQLITE_PATH: join(file, 'crm.db') });
  assert.equal(notDir.status, 0, notDir.stderr);
  assert.match(notDir.stdout, /^PXK-DB report verdict=absent$/m);
  const locked = join(tempDir(), 'gesperrt.db');
  writeFileSync(locked, PAIR.main);
  chmodSync(locked, 0o000);
  try {
    if (spawnSync('cat', [locked]).status === 0) return; // als root lesbar: nichts zu prüfen
    for (const [flag, status] of [['--report', 0], ['--check', 12]]) {
      const result = cli([flag], { SQLITE_PATH: locked });
      assert.equal(result.status, status, `${flag}: ${result.stderr}`);
      assert.match(result.stdout, /^PXK-DB report verdict=invalid-file$/m, flag);
      assert.match(result.stdout, /nicht lesbar \(EACCES\)/, flag);
      assert.doesNotMatch(result.stderr, /INTERNAL|\n\s+at /, `${flag}: kein Stacktrace`);
    }
  } finally {
    chmodSync(locked, 0o600);
  }
});

test('M-1 Bibliothek: openDatabase verweigert jede ungültige Lage in jedem Modus, bevor SQLite öffnet', () => {
  for (const [name, fixture] of Object.entries(INVALID)) {
    for (const mode of ['apply', 'app', 'inspect']) {
      const { dir, path, before } = lage(fixture);
      assert.throws(() => openDatabase(path, mode), { code: 'UNKNOWN_SCHEMA' }, `${name} ${mode}`);
      assert.deepEqual(snapshot(dir), before, `${name} ${mode}: Hauptdatei, -wal, -shm unverändert, nichts angelegt`);
    }
  }
});

test('M-1 App: ensureDatabase verweigert jede ungültige Lage ohne Öffnen — Dateien bytegleich, kein -shm, keine neue Datenbank', () => {
  for (const [name, fixture] of Object.entries(INVALID)) {
    const { dir, path, before } = lage(fixture);
    const result = runAppScript({ env: { SQLITE_PATH: path }, body: 'await app.ensureDatabase(); return true;' });
    const expected = fixture.main?.length ? 'UNKNOWN_SCHEMA' : 'DB_NOT_MIGRATED';
    assert.equal(result.error?.code, expected, `${name}: ${JSON.stringify(result)}`);
    assert.deepEqual(snapshot(dir), before, `${name}: unverändert`);
  }
});

test('M-1 Migration: Entwicklung und Produktion verweigern jede ungültige Lage (Exit 12) — Dateien bytegleich, keine Sicherung, keine neue Datenbank', () => {
  for (const [name, fixture] of Object.entries(INVALID)) {
    for (const production of [false, true]) {
      const { dir, path, before } = lage(fixture);
      const backups = join(tempDir(), 'sicherungen');
      const env = { SQLITE_PATH: path, ...(production ? { NODE_ENV: 'production', PXK_DB_BACKUP_DIR: backups, PXK_DB_ALLOW_FRESH: '1' } : {}) };
      const result = cli([], env);
      const label = `${name} ${production ? 'Produktion' : 'Entwicklung'}`;
      assert.equal(result.status, 12, `${label}: ${result.stderr}`);
      assert.match(result.stderr, /^PXK-DB \[UNKNOWN_SCHEMA\] .*(keine gültige SQLite-Hauptdatei|daneben liegt ein nicht leeres -wal)/m, label);
      assert.doesNotMatch(result.stderr, /INTERNAL|\n\s+at /, `${label}: kein Stacktrace`);
      assert.deepEqual(snapshot(dir), before, `${label}: unverändert`);
      assert.equal(existsSync(backups), false, `${label}: keine Sicherung`);
    }
  }
});

test('M-1 Bericht: --report (Exit 0) und --check (Exit 12) öffnen keine ungültige Lage', () => {
  for (const [name, fixture] of Object.entries(INVALID)) {
    for (const [flag, status] of [['--report', 0], ['--check', 12]]) {
      const { dir, path, before } = lage(fixture);
      const result = cli([flag], { SQLITE_PATH: path });
      const label = `${name} ${flag}`;
      assert.equal(result.status, status, `${label}: ${result.stderr}`);
      assert.match(result.stdout, /^PXK-DB report verdict=(invalid-file|orphaned-wal)$/m, label);
      assert.match(result.stdout, /— nicht geöffnet$/m, label);
      assert.deepEqual(snapshot(dir), before, `${label}: unverändert`);
    }
  }
});

test('M-1 AC3-Prüfstand: ungültige Quelle mit -wal → verweigert (Exit 2) — Quelle, -wal, -shm bytegleich, kein Arbeitsordner', { skip }, () => {
  for (const [name, fixture] of Object.entries(INVALID)) {
    const { dir, path, before } = lage(fixture);
    const work = join(tempDir(), 'arbeit');
    const result = spawnSync(process.execPath, [join(project(), 'scripts', 'db-verify-copy.mjs'), `--source=${path}`, `--workdir=${work}`], {
      cwd: tempDir(),
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      encoding: 'utf8',
    });
    assert.equal(result.status, 2, `${name}: ${result.stderr}`);
    assert.match(result.stderr, /^PXK-AC3 refused=Quelle (fehlt|ist leer|ist keine gültige SQLite-Datei)/, name);
    assert.doesNotMatch(result.stderr, /\/(private|var|tmp|Users|home)\//, `${name}: keine Pfade`);
    assert.deepEqual(snapshot(dir), before, `${name}: unverändert`);
    assert.equal(existsSync(work), false, `${name}: kein Arbeitsordner`);
  }
});

test('M-1 gültige Hauptdatei mit -wal: alle Grenzen öffnen normal, die Daten im -wal bleiben erhalten', () => {
  const { path } = source({ walRows: 50 });
  const rows = () => {
    const db = new Database(path, { readonly: true });
    try { return db.prepare("SELECT count(*) AS c FROM leads WHERE id LIKE 'WAL-%'").get().c; } finally { db.close(); }
  };
  assert.equal(inspectMainFile(path).state, 'valid');
  assert.ok(readFileSync(`${path}-wal`).length > 0);
  // Bericht und App öffnen (nur lesend) und ordnen ein — kein Abweisen vor dem Öffnen
  const report = cli(['--report'], { SQLITE_PATH: path });
  assert.match(report.stdout, /^PXK-DB report verdict=legacy-current-adoptable$/m, report.stdout);
  const app = runAppScript({ env: { SQLITE_PATH: path }, body: 'await app.ensureDatabase(); return true;' });
  assert.equal(app.error?.code, 'DB_NOT_MIGRATED', 'geöffnet und als nicht migriert erkannt');
  // Migration übernimmt den Altstand; die Zeilen aus dem -wal sind danach in der Datenbank
  const migrated = cli(['--no-seed'], { SQLITE_PATH: path });
  assert.equal(migrated.status, 0, migrated.stderr);
  assert.match(migrated.stdout, /baselined 0001_baseline \(S5\)/);
  assert.equal(rows(), 50);
});

/**
 * H-2, Gegenstück zu tests/db/wal-damage.test.mjs: Normale Absturzreste bleiben
 * offen — SQLite stellt sie wieder her, ohne Bestätigtes zu verlieren. Dazu
 * gehören abgerissene letzte Frames, Transaktionen ohne Commit, zurückgerollte
 * übergelaufene Transaktionen, Neustarts des -wal (auch nach VACUUM),
 * Abstürze mitten im Schreiben und im Checkpoint, der liegengebliebene
 * Commit-Frame einer nie bestätigten Transaktion hinter einer kürzeren
 * (abgerissen: mit prüfbarem Vorgänger auch ohne -shm; vollständig: mit dem
 * WAL-Index des späteren Schreibers)
 * und ein Stromausfall, nach dem das Ende des -wal fehlt (das -shm aber auf der
 * Platte steht).
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { openDatabase, openProblem } from '../../lib/db/open.mjs';
import { source } from './ac3-helpers.mjs';
import { ROOT, tempDir } from './helpers.mjs';
import { assertAccepted, assertRefused, cli, commitsOf, FRAME, frameAt, frameCount, killedWriter, PAGE, prodPair, rebuiltIndex, restart, rows, sqliteValue } from './wal-helpers.mjs';

const PROD = prodPair();
const damage = (change, wal = PROD.wal) => {
  const copy = Buffer.from(wal);
  change(copy);
  return copy;
};

test('H-2: das unbeschädigte Produktions-Paar ist offen, mit und ohne -shm, SQLite sieht alle Zeilen', () => {
  assert.equal(assertAccepted('ohne -shm', PROD.main, PROD.wal), 240);
  assert.equal(assertAccepted('mit -shm', PROD.main, PROD.wal, { shm: PROD.shm }), 240);
  // ein -shm kürzer als die Index-Köpfe zählt als fehlend (SQLite kürzt es beim ersten Öffnen auf 3 Byte)
  for (const size of [0, 3, 95]) assert.equal(assertAccepted(`-shm ${size} Byte`, PROD.main, PROD.wal, { shm: PROD.shm.subarray(0, size) }), 240);
});

test('H-2: abgerissener letzter Frame, abgerissener Commit-Frame, Commit vor neu berechneten Prüfsummen, zurückgerollte Transaktion → offen', () => {
  assert.equal(assertAccepted('abgerissener letzter Frame', PROD.main, PROD.wal.subarray(0, PROD.wal.length - FRAME / 2)), 180);
  // Kopf des letzten (Commit-)Frames geschrieben, die Seite nur zur Hälfte: Kette bricht genau dort
  const half = damage((wal) => { wal.fill(0, frameAt(frameCount(wal) - 1) + 24 + PAGE / 2, frameAt(frameCount(wal))); });
  assert.equal(assertAccepted('abgerissener Commit-Frame', PROD.main, half), 180);
  // SQLites Absturz zwischen Commit-Frame und dem Neuberechnen der Prüfsummen überschriebener
  // Frames (walFrames → walRewriteChecksums): ein überschriebener Frame bricht die Kette, alle
  // danach angehängten Frames samt Commit tragen noch Salz und Prüfsumme 0 (walEncodeFrame)
  const commits = commitsOf(PROD.wal);
  const lastTx = commits.at(-2) + 1;
  const pending = damage((wal) => {
    wal[frameAt(lastTx) + 24 + 7] ^= 0x01;
    for (let i = lastTx + 1; i <= commits.at(-1); i += 1) wal.fill(0, frameAt(i) + 8, frameAt(i) + 24);
  });
  assert.ok(pending.readUInt32BE(frameAt(commits.at(-1)) + 4) > 1, 'Commit-Frame hält eine Größe über der Hauptdatei');
  assert.equal(assertAccepted('Commit wartet auf neue Prüfsummen', PROD.main, pending), 180);
  // überschrieben wurde der Frame direkt vor dem Commit: nur der Commit-Frame selbst trägt Salz und Prüfsumme 0
  const lone = damage((wal) => {
    wal[frameAt(commits.at(-1) - 1) + 24 + 7] ^= 0x01;
    wal.fill(0, frameAt(commits.at(-1)) + 8, frameAt(commits.at(-1)) + 24);
  });
  assert.equal(assertAccepted('nur der Commit-Frame wartet', PROD.main, lone), 180);
  // Cache übergelaufen, zurückgerollt, dann eine kleine Transaktion: Frames ohne Commit dahinter
  const path = join(tempDir(), 'rollback.db');
  killedWriter(path, `db.exec("CREATE TABLE t (a)"); db.pragma('cache_size = 2'); db.exec("BEGIN"); db.exec(${JSON.stringify(rows(400, 'r'))}); db.exec("ROLLBACK"); db.exec(${JSON.stringify(rows(5, 's'))});`);
  const wal = readFileSync(`${path}-wal`);
  assert.ok(frameCount(wal) > commitsOf(wal).at(-1) + 1, 'Frames der zurückgerollten Transaktion liegen hinter dem letzten Commit');
  assert.equal(assertAccepted('zurückgerollte übergelaufene Transaktion', readFileSync(path), wal), 5);
});

test('H-2: Neustarts des -wal → offen (vollständig zurückgeschrieben, echter Neustart, nach VACUUM)', () => {
  const path = join(tempDir(), 'neustart.db');
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE t (a); ${rows(120, 'n')}`);
  db.pragma('wal_checkpoint(PASSIVE)');
  db.close();
  killedWriter(path, `db.exec(${JSON.stringify(rows(60, 'm'))}); db.pragma('wal_checkpoint(PASSIVE)');`);
  assert.equal(assertAccepted('neuer Kopf über vollständig zurückgeschriebenem -wal', readFileSync(path), damage(restart, readFileSync(`${path}-wal`))), 180);
  // echter Neustart durch SQLite: neue Frames vorn, alte Generation dahinter
  const real = join(tempDir(), 'echt.db');
  killedWriter(real, `db.exec("CREATE TABLE t (a)"); db.exec(${JSON.stringify(rows(150, 'g'))}); db.pragma('wal_checkpoint(PASSIVE)'); db.exec(${JSON.stringify(rows(3, 'h'))});`);
  const realWal = readFileSync(`${real}-wal`);
  const salt = realWal.subarray(16, 24);
  assert.ok(Array.from({ length: frameCount(realWal) }, (_, i) => i).some(i => !realWal.subarray(frameAt(i) + 8, frameAt(i) + 16).equals(salt)), 'alte Generation im -wal');
  assert.equal(assertAccepted('echter Neustart', readFileSync(real), realWal, { shm: readFileSync(`${real}-shm`) }), 153);
  // die Datenbank schrumpfte (VACUUM), dann vollständiger Checkpoint und Neustart: frühere,
  // größere Commits der alten Generation zählen nicht — nur ihr letzter
  const shrunk = join(tempDir(), 'vacuum.db');
  killedWriter(shrunk, `db.exec("CREATE TABLE t (a)"); db.exec(${JSON.stringify(rows(300, 'v'))}); db.exec("DELETE FROM t WHERE rowid > 10"); db.exec("VACUUM"); db.pragma('wal_checkpoint(PASSIVE)'); db.exec(${JSON.stringify(rows(1, 'w'))});`);
  const shrunkMain = readFileSync(shrunk);
  const shrunkWal = readFileSync(`${shrunk}-wal`);
  const older = Array.from({ length: frameCount(shrunkWal) }, (_, i) => i).filter(i => !shrunkWal.subarray(frameAt(i) + 8, frameAt(i) + 16).equals(shrunkWal.subarray(16, 24)));
  assert.ok(older.some(i => shrunkWal.readUInt32BE(frameAt(i) + 4) > shrunkMain.length / PAGE), 'die alte Generation war einmal größer als die Hauptdatei jetzt');
  assert.equal(assertAccepted('Neustart nach VACUUM', shrunkMain, shrunkWal), 11);
});

/**
 * Absturz 1 zerreißt den Commit-Frame einer größeren Transaktion T2 (Kopf geschrieben,
 * Seite nicht — wal.c schreibt beides getrennt). Der nächste Schreiber übernimmt die Lage,
 * schreibt eine kürzere Transaktion T3 und stirbt ebenfalls: T2s Commit-Frame liegt nun
 * hinter der Abbruchstelle, nie bestätigt. Sein WAL-Index (-shm) bleibt liegen.
 */
function abandonedCommit({ checkpoint = false } = {}) {
  const dir = tempDir();
  const db = join(dir, 'crm.db');
  killedWriter(db, `
    const { copyFileSync } = await import('node:fs');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    for (let i = 0; i < 12; i += 1) db.prepare('INSERT INTO t (v) VALUES (?)').run('g1-' + 'x'.repeat(3000));
    db.pragma('wal_checkpoint(FULL)');
    db.prepare('UPDATE t SET v = ? WHERE id = 1').run('T1');
    for (const s of ['-wal', '-shm']) copyFileSync(${JSON.stringify(db)} + s, ${JSON.stringify(db)} + s + '.vorher');
    db.exec('BEGIN');
    for (let i = 0; i < 6; i += 1) db.prepare('INSERT INTO t (v) VALUES (?)').run('T2-' + 'y'.repeat(3000));
    db.exec('COMMIT');
  `);
  const before = readFileSync(`${db}-wal.vorher`);
  const after = readFileSync(`${db}-wal`);
  const own = after.subarray(16, 24);
  const t2 = commitsOf(after).filter(i => after.subarray(frameAt(i) + 8, frameAt(i) + 16).equals(own)).at(-1);
  assert.ok(frameAt(t2 + 1) <= before.length, 'T2s Commit-Frame liegt in schon beschriebenem -wal-Bereich');
  // wie ein SIGKILL zwischen Kopf und Seite des Commit-Frames: Seite noch alt, WAL-Index noch beim Stand nach T1
  const torn = Buffer.from(after);
  before.copy(torn, frameAt(t2) + 24, frameAt(t2) + 24, frameAt(t2 + 1));
  writeFileSync(`${db}-wal`, torn);
  copyFileSync(`${db}-shm.vorher`, `${db}-shm`);
  assert.equal(openProblem(db).verdict, null, 'abgerissener Commit an der Abbruchstelle');
  killedWriter(db, `
    const app = openDatabase(${JSON.stringify(db)}, 'app');
    app.pragma('wal_autocheckpoint = 0');
    app.prepare('UPDATE t SET v = ? WHERE id = 2').run('T3');
    ${checkpoint ? "app.pragma('wal_checkpoint(PASSIVE)'); app.prepare('UPDATE t SET v = ? WHERE id = 3').run('T4');" : ''}
  `, { wal: false });
  return { db, main: readFileSync(db), wal: readFileSync(`${db}-wal`), shm: readFileSync(`${db}-shm`), after, t2 };
}
const t2rows = "SELECT count(*) FROM t WHERE v LIKE 'T2-%'";

test('H-2: liegengebliebener abgerissener Commit einer nie bestätigten Transaktion hinter einer kürzeren → offen, mit und ohne -shm', { timeout: 120000 }, () => {
  const s2 = abandonedCommit();
  const own = s2.wal.subarray(16, 24);
  const stale = commitsOf(s2.wal).filter(i => s2.wal.subarray(frameAt(i) + 8, frameAt(i) + 16).equals(own));
  assert.ok(stale.length >= 2, 'T3s Commit vorn, T2s liegengebliebener Commit dahinter');
  assert.equal(sqliteValue(s2.main, s2.wal, t2rows), 0, 'SQLite kennt T2 nicht');
  assert.equal(sqliteValue(s2.main, s2.wal, "SELECT count(*) FROM t WHERE v = 'T3'"), 1);
  const t3 = "SELECT count(*) FROM t WHERE v = 'T3'";
  assert.equal(openProblem(s2.db).verdict, null, 'an Ort und Stelle offen');
  // T2s Commit-Frame setzt die Kette seines Vorgängers nicht fort (Seite alt): abgerissen —
  // erkennbar ohne -shm, also auch in einer Kopie ohne, mit fremdem oder neu aufgebautem -shm
  assert.equal(assertAccepted('mit -shm', s2.main, s2.wal, { shm: s2.shm, sql: t3 }), 1);
  assert.equal(assertAccepted('ohne -shm', s2.main, s2.wal, { sql: t3 }), 1);
  assert.equal(assertAccepted('fremdes -shm', s2.main, s2.wal, { shm: PROD.shm, sql: t3 }), 1);
  assert.equal(assertAccepted('-shm nach lesendem Öffnen', s2.main, s2.wal, { shm: rebuiltIndex(s2.main, s2.wal), sql: t3 }), 1);
  const linkDir = tempDir();
  symlinkSync(s2.db, join(linkDir, 'verweis.db'));
  assert.equal(openProblem(join(linkDir, 'verweis.db')).verdict, null, 'über einen Verweis offen');
  // ein -shm, das keine reguläre Datei ist (FIFO), hält die Prüfung nicht auf
  const fifo = tempDir();
  for (const [name, bytes] of [['crm.db', s2.main], ['crm.db-wal', s2.wal]]) writeFileSync(join(fifo, name), bytes);
  assert.equal(spawnSync('mkfifo', [join(fifo, 'crm.db-shm')]).status, 0);
  assert.equal(openProblem(join(fifo, 'crm.db')).verdict, null);
  // vollständig geschrieben setzt derselbe Commit-Frame die Kette fort (so liegt er, wenn ein zweiter
  // Prozess das -shm hielt und nach dem Absturz des ersten kürzer weiterschrieb): offen nur mit dem
  // WAL-Index dieses späteren Schreibers — ohne, mit fremdem oder von SQLite neu aufgebautem abgewiesen
  const whole = Buffer.from(s2.wal);
  s2.after.copy(whole, frameAt(s2.t2) + 24, frameAt(s2.t2) + 24, frameAt(s2.t2 + 1));
  assert.equal(assertAccepted('vollständiger Commit-Frame, mit -shm', s2.main, whole, { shm: s2.shm, sql: t3 }), 1);
  assertRefused('vollständiger Commit-Frame', s2.main, whole);
  assertRefused('vollständiger Commit-Frame, fremdes -shm', s2.main, whole, { shm: PROD.shm });
  assertRefused('vollständiger Commit-Frame, -shm nach lesendem Öffnen', s2.main, whole, { shm: rebuiltIndex(s2.main, whole) });
  // nach Checkpoint und Neustart liegt der Rest in einer älteren Generation: seine Kette ist gerissen, er zählt nicht
  const s3 = abandonedCommit({ checkpoint: true });
  assert.equal(sqliteValue(s3.main, s3.wal, "SELECT count(*) FROM t WHERE v IN ('T3', 'T4')"), 2);
  assert.equal(assertAccepted('älter geworden, ohne -shm', s3.main, s3.wal, { sql: "SELECT count(*) FROM t WHERE v IN ('T3', 'T4')" }), 2);
});

test('H-2: Absturz beim Schreiben und im Checkpoint (SIGKILL zu wechselnden Zeitpunkten, Lage mit und ohne -shm) → nie abgewiesen, SQLite liest alles Abgeschlossene', async () => {
  let states = 0;
  for (let round = 0; round < 24; round += 1) {
    const path = join(tempDir(), 'absturz.db');
    const checkpoint = round % 3 === 2;
    const writer = spawn(process.execPath, ['--input-type=module', '-e', `
      import Database from 'better-sqlite3';
      const db = new Database(${JSON.stringify(path)});
      db.pragma('journal_mode = WAL');
      db.pragma('wal_autocheckpoint = 0');
      db.pragma('cache_size = ${round % 2 ? 4 : 2000}');
      db.exec('CREATE TABLE t (a)');
      for (let i = 0; ; i += 1) {
        db.exec('BEGIN');
        db.exec(\`WITH RECURSIVE n(k) AS (SELECT 1 UNION ALL SELECT k + 1 FROM n WHERE k < \${1 + (i * 37) % 300}) INSERT INTO t SELECT printf('%0200d', k) FROM n\`);
        if (i % 4 === 1) db.exec("UPDATE t SET a = a || 'x' WHERE rowid % 3 = 0");
        db.exec(i % 6 === 5 ? 'ROLLBACK' : 'COMMIT');
        if (${checkpoint} || i % 9 === 8) db.pragma(i % 2 ? 'wal_checkpoint(PASSIVE)' : 'wal_checkpoint(FULL)');
        if (i === 0) process.stdout.write('los\\n');
      }
    `], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise(resolve => writer.stdout.once('data', resolve));
    await new Promise(resolve => setTimeout(resolve, 15 + ((round * 53) % 220)));
    writer.kill('SIGKILL');
    await new Promise(resolve => writer.once('close', resolve));
    if (!existsSync(`${path}-wal`) || statSync(`${path}-wal`).size === 0) continue;
    states += 1;
    const copy = join(tempDir(), 'crm.db');
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(`${path}${suffix}`)) copyFileSync(`${path}${suffix}`, `${copy}${suffix}`);
    const seen = sqliteValue(readFileSync(path), readFileSync(`${path}-wal`));
    assert.equal(openProblem(copy).verdict, null, `Runde ${round}: ${JSON.stringify(openProblem(copy))}`);
    const bare = join(tempDir(), 'crm.db');
    for (const suffix of ['', '-wal']) copyFileSync(`${path}${suffix}`, `${bare}${suffix}`);
    assert.equal(openProblem(bare).verdict, null, `Runde ${round} ohne -shm: ${JSON.stringify(openProblem(bare))}`);
    const db = openDatabase(copy, 'apply');
    try {
      assert.equal(db.prepare('SELECT count(*) AS c FROM t').get().c, seen, `Runde ${round}`);
      assert.equal(db.pragma('integrity_check', { simple: true }), 'ok', `Runde ${round}`);
    } finally {
      db.close();
    }
  }
  assert.ok(states >= 12, `genug Absturzzustände (${states})`);
});

test('H-2: Stromausfall bei synchronous=NORMAL — Ende des -wal nie auf der Platte, das -shm des Schreibers schon → offen, SQLite liest den Rest', () => {
  const commits = commitsOf(PROD.wal);
  const keep = frameAt(commits[2] + 1);
  const cases = {
    'Datei endet nach einem Commit': PROD.wal.subarray(0, keep),
    'Ende genullt (Größe erhalten)': damage((wal) => { wal.fill(0, keep); }),
    'nächster Frame angerissen': PROD.wal.subarray(0, keep + 24 + 1000),
    'mitten in der nächsten Transaktion': PROD.wal.subarray(0, keep + 2 * FRAME),
    'mitten in der nächsten Transaktion, Rest genullt': damage((wal) => { wal.fill(0, keep + 2 * FRAME); }),
    'nur der letzte beanspruchte Frame genullt': damage((wal) => { wal.fill(0, frameAt(frameCount(wal) - 1)); }),
    // ein Loch am Anfang der letzten Transaktion, ihr Commit-Frame ganz verloren
    'Loch in der letzten Transaktion, Commit-Frame genullt': damage((wal) => {
      const lastTx = commitsOf(wal).at(-2) + 1;
      wal.fill(0, frameAt(lastTx), frameAt(lastTx + 1));
      wal.fill(0, frameAt(frameCount(wal) - 1));
    }),
  };
  for (const [name, wal] of Object.entries(cases)) {
    const seen = assertAccepted(name, PROD.main, wal, { shm: PROD.shm });
    assert.ok(seen > 0 && seen < 240, `${name}: ${seen}`);
  }
  // steht dagegen der Kopf des letzten bestätigten Commit-Frames mit diesem Salz da (seine Seite nicht), gleicht das
  // Byte für Byte einem Schaden an diesem Frame: abgewiesen (fail-closed; Weg über eine Kopie in der Meldung)
  const tornHead = damage((wal) => {
    const lastTx = commitsOf(wal).at(-2) + 1;
    wal.fill(0, frameAt(lastTx), frameAt(lastTx + 1));
    wal.fill(0, frameAt(frameCount(wal) - 1) + 24 + PAGE / 2, frameAt(frameCount(wal)));
  });
  assertRefused('Loch in der letzten Transaktion, Kopf des Commit-Frames ohne Seite', PROD.main, tornHead, { shm: PROD.shm });
  // die letzte Transaktion ein einziger Frame, von dem nur der Anfang auf der Platte steht
  const one = join(tempDir(), 'ein-frame.db');
  killedWriter(one, `db.exec("CREATE TABLE t (a)"); db.exec("INSERT INTO t VALUES ('x')"); db.exec("UPDATE t SET a = 'y'");`);
  const oneWal = readFileSync(`${one}-wal`);
  const last = frameCount(oneWal) - 1;
  assert.deepEqual(commitsOf(oneWal).slice(-2), [last - 1, last], 'letzte Transaktion: ein Frame');
  const cut = oneWal.subarray(0, frameAt(last) + 24 + 1000);
  assert.equal(assertAccepted('Ein-Frame-Commit angerissen', readFileSync(one), cut, { shm: readFileSync(`${one}-shm`), sql: 'SELECT a FROM t' }), 'x');
});

test('H-2: produktionsförmige CRM-Daten nur im -wal — Migration in Produktion übernimmt sie vollständig', () => {
  const { dir, path } = source({ walRows: 300 });
  assert.ok(statSync(`${path}-wal`).size > 0, 'Daten im -wal');
  assert.equal(openProblem(path).verdict, null);
  const count = () => {
    const db = new Database(path, { readonly: true });
    try { return db.prepare('SELECT count(*) AS c FROM leads').get().c; } finally { db.close(); }
  };
  const before = count();
  const backups = join(tempDir(), 'sicherungen');
  const result = cli([], { SQLITE_PATH: path, RAILWAY_ENVIRONMENT_NAME: 'production', PXK_DB_BACKUP_DIR: backups });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /baselined 0001_baseline \(S5\) seeds=0\/0/);
  assert.equal(count(), before);
  assert.equal(readdirSync(backups).filter(f => f.endsWith('.db')).length, 1);
  assert.ok(readdirSync(dir).includes('quelle.db'));
});

test('H-2: -wal bis 32 Byte liest SQLite nicht — offen, auch mit ungültigem Kopf (nichts darin)', () => {
  const dir = tempDir();
  const path = join(dir, 'crm.db');
  writeFileSync(path, PROD.main);
  for (const bytes of [Buffer.alloc(1, 0x41), Buffer.alloc(32, 0x5a), PROD.wal.subarray(0, 32)]) {
    writeFileSync(`${path}-wal`, bytes);
    assert.equal(openProblem(path).verdict, null, `${bytes.length} Byte`);
  }
  truncateSync(`${path}-wal`, 33);
  assert.equal(openProblem(path).verdict, null, 'gültiger Kopf, angerissener erster Frame');
});

test('H-2: die Vorprüfung lässt die -shm-Sperre (DMS) einer offenen Verbindung desselben Prozesses stehen — ein anderer Prozess hält sich nicht für den einzigen', { timeout: 60000 }, () => {
  const dir = tempDir();
  const path = join(dir, 'crm.db');
  const other = `import Database from 'better-sqlite3'; const db = new Database(${JSON.stringify(path)}); db.prepare('SELECT count(*) FROM t').get(); db.close();`;
  // A: offene Verbindung, dann Vorprüfung im selben Prozess (z. B. zweite Modul-Instanz),
  // dann öffnet und schließt B, dann schreibt A weiter und stirbt
  killedWriter(path, `
    const { spawnSync } = await import('node:child_process');
    const conn = openDatabase(${JSON.stringify(path)}, 'apply');
    conn.pragma('wal_autocheckpoint = 0');
    conn.exec('CREATE TABLE t (x)');
    conn.exec('INSERT INTO t VALUES (1)');
    if (openProblem(${JSON.stringify(path)}).verdict !== null) process.exit(3);
    if (spawnSync(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(other)}], { cwd: ${JSON.stringify(ROOT)} }).status !== 0) process.exit(4);
    conn.exec('INSERT INTO t VALUES (2)');
    conn.exec('INSERT INTO t VALUES (3)');
  `, { wal: false });
  assert.ok(existsSync(`${path}-wal`), 'B hielt sich nicht für die letzte Verbindung');
  const db = new Database(path, { readonly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) FROM t').pluck().get(), 3, 'alle drei abgeschlossenen Zeilen');
  } finally {
    db.close();
  }
});

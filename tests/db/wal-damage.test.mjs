/**
 * H-2: Ein nicht leeres -wal, aus dem SQLite abgeschlossene Transaktionen
 * verwürfe, wird vor dem Öffnen abgewiesen (lib/db/open.mjs, readWal/examine) —
 * SQLite löschte oder überschriebe es sonst mitsamt diesen Daten. Die offenen
 * Gegenstücke (normale Absturzreste) stehen in tests/db/wal-crash.test.mjs.
 *
 * Jede Beschädigung ist so gebaut, dass nur die eine Prüfung sie erkennt
 * (Kopf-Prüfsumme und Frame-Kette sonst neu berechnet). Gegenprobe je Fall:
 * SQLite selbst sieht auf einer Kopie weniger als im unbeschädigten -wal steht.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { openDatabase, openProblem } from '../../lib/db/open.mjs';
import { assertAccepted, assertRefused, commitsOf, FRAME, frameAt, frameCount, killedWriter, lage, PAGE, prodPair, rebuiltIndex, reseal, rechain, resalt, restart, rows, snapshot, sqliteValue, walIndex } from './wal-helpers.mjs';
import { ROOT, tempDir } from './helpers.mjs';

const PROD = prodPair();
const ALL = 240;
const damage = (change, wal = PROD.wal) => {
  const copy = Buffer.from(wal);
  change(copy);
  return copy;
};
/** Vollständige Hauptdatei, dann ein Schreiber, der per SIGKILL endet. */
function afterCheckpoint(setup, script) {
  const path = join(tempDir(), 'basis.db');
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(setup);
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  killedWriter(path, script);
  return { main: readFileSync(path), wal: readFileSync(`${path}-wal`), shm: readFileSync(`${path}-shm`) };
}

test('H-2 L-3: ungültiger -wal-Kopf (Kennung, Version, Seitengröße, Prüfsumme) → abgewiesen, auch bei nur einer Transaktion', () => {
  const cases = {
    // nur die Kennung falsch, Kopf-Prüfsumme und Kette passen dazu
    Kennung: damage((wal) => { wal.writeUInt32BE(0x377f0680, 0); reseal(wal); rechain(wal); }),
    // SQLite öffnet dann gar nicht (SQLITE_CANTOPEN) — trotzdem klar abweisen
    Version: damage((wal) => { wal.writeUInt32BE(3007001, 4); reseal(wal); rechain(wal); }),
    'Seitengröße 3000': damage((wal) => { wal.writeUInt32BE(3000, 8); reseal(wal); }),
    'Seitengröße 131072': damage((wal) => { wal.writeUInt32BE(131072, 8); reseal(wal); }),
    'Seitengröße 0': damage((wal) => { wal.writeUInt32BE(0, 8); reseal(wal); }),
    // gültige, aber andere Seitengröße: nur der Vergleich mit der Hauptdatei sieht es
    'Seitengröße 65536': damage((wal) => { wal.writeUInt32BE(65536, 8); reseal(wal); }),
    // ein Bit in der Prüfpunkt-Nummer, Prüfsumme nicht angepasst
    'Kopf-Prüfsumme': damage((wal) => { wal[15] ^= 0x01; }),
    // je nur eines der beiden gespeicherten Prüfsummen-Wörter: SQLite verwirft das ganze -wal
    'gespeicherte Kopf-Prüfsumme, Wort 0': damage((wal) => { wal[25] ^= 0x01; }),
    'gespeicherte Kopf-Prüfsumme, Wort 1': damage((wal) => { wal[29] ^= 0x01; }),
  };
  for (const [name, wal] of Object.entries(cases)) {
    assert.notEqual(sqliteValue(PROD.main, wal), ALL, `${name}: SQLite verlöre Daten`);
    assertRefused(name, PROD.main, wal);
  }
  const single = join(tempDir(), 'einzeln.db');
  killedWriter(single, `db.exec("BEGIN; CREATE TABLE t (a); ${rows(60, 'e')}; COMMIT");`);
  const main = readFileSync(single);
  const one = readFileSync(`${single}-wal`);
  assert.equal(commitsOf(one).length, 1);
  for (const [name, change] of Object.entries({
    'Kopf-Prüfsumme, eine Transaktion': (wal) => { wal[15] ^= 0x01; },
    'Seitengröße 0, eine Transaktion': (wal) => { wal.writeUInt32BE(0, 8); reseal(wal); },
    'Seitengröße 65536, eine Transaktion': (wal) => { wal.writeUInt32BE(65536, 8); reseal(wal); },
  })) {
    const wal = damage(change, one);
    assert.notEqual(sqliteValue(main, wal), 60, `${name}: SQLite verwürfe die Transaktion`);
    assertRefused(name, main, wal);
  }
});

test('H-2 L-3: -wal aus genau einem Frame (Ein-Seiten-Änderung) — Kopf-Prüfsumme, Salz, Seitengröße 0 → abgewiesen', () => {
  const { main, wal: one } = afterCheckpoint("CREATE TABLE t (a); INSERT INTO t VALUES ('alt'), ('alt')", `db.exec("UPDATE t SET a = 'neu' WHERE rowid = 1");`);
  assert.equal(frameCount(one), 1);
  const changed = "SELECT count(*) FROM t WHERE a = 'neu'";
  assert.equal(sqliteValue(main, one, changed), 1);
  for (const [name, change] of Object.entries({
    'Kopf-Prüfsumme': (wal) => { wal[15] ^= 0x01; },
    'Salz des Frames': (wal) => { wal[frameAt(0) + 8] ^= 0x01; },
  })) {
    const wal = damage(change, one);
    assert.equal(sqliteValue(main, wal, changed), 0, `${name}: SQLite verwürfe die Änderung`);
    assertRefused(name, main, wal);
  }
  // Seitengröße 0 über einer fast leeren Seite (Überlaufseite eines zeroblob): nichts anderes fällt auf
  const blob = join(tempDir(), 'blob.db');
  const bdb = new Database(blob);
  bdb.exec('CREATE TABLE t (b); INSERT INTO t VALUES (zeroblob(20000))');
  bdb.close();
  const blobMain = readFileSync(blob);
  const head = Buffer.alloc(32);
  head.writeUInt32BE(0x377f0682, 0); head.writeUInt32BE(3007000, 4); head.writeUInt32BE(PAGE, 8);
  head.writeUInt32BE(0x1234, 16); head.writeUInt32BE(0x5678, 20);
  const frame = Buffer.alloc(FRAME);
  frame.writeUInt32BE(5, 0);
  frame.writeUInt32BE(blobMain.length / PAGE, 4);
  head.copy(frame, 8, 16, 24);
  blobMain.copy(frame, 24, 4 * PAGE, 5 * PAGE);
  frame[24 + 1000] = 7;
  const valid = Buffer.concat([head, frame]);
  reseal(valid);
  rechain(valid);
  const seven = "SELECT instr(hex(b), '07') > 0 FROM t";
  assert.equal(sqliteValue(blobMain, valid, seven), 1);
  const zero = damage((wal) => { wal.writeUInt32BE(0, 8); reseal(wal); }, valid);
  assert.equal(sqliteValue(blobMain, zero, seven), 0, 'SQLite verwürfe die Änderung');
  assertRefused('Seitengröße 0, ein Frame', blobMain, zero);
});

test('H-2 L-3: -wal mit anderer Seitengröße als die Hauptdatei → abgewiesen', () => {
  const path = join(tempDir(), 'gross.db');
  const db = new Database(path);
  db.pragma('page_size = 8192');
  db.exec('CREATE TABLE t (a)');
  db.close();
  killedWriter(path, `db.exec(${JSON.stringify(rows(60, 'x'))});`);
  const wal = readFileSync(`${path}-wal`);
  assert.equal(wal.readUInt32BE(8), 8192);
  assertRefused('fremdes -wal mit 8192er Seiten', PROD.main, wal);
});

test('H-2 L-3: Salz eines Frames verfälscht (Prüfsumme setzt die Kette fort) → abgewiesen', () => {
  assertRefused('Salz in Frame 1', PROD.main, damage((wal) => { wal[frameAt(0) + 8] ^= 0x01; }));
  assertRefused('Salz in Frame 3', PROD.main, damage((wal) => { wal[frameAt(2) + 12] ^= 0x80; }));
});

// SQLite baut das -shm bei jedem Öffnen neu auf (auch lesend) — die Abweisung hängt nicht davon ab
const refusedAlways = (name, main, wal) => {
  assertRefused(name, main, wal);
  assertRefused(`${name}, -shm nach lesendem Öffnen`, main, wal, { shm: rebuiltIndex(main, wal) });
};

test('H-2 L-3: Abbruch mitten im -wal, dahinter ein vollständiger Commit dieser Generation → abgewiesen, ohne -shm und mit dem von SQLite neu aufgebauten', () => {
  const commits = commitsOf(PROD.wal);
  const second = commits[1];
  const lastTx = commits.at(-2) + 1;
  assert.ok(lastTx < commits.at(-1));
  const cases = {
    'Seitendaten Frame 2': damage((wal) => { wal[frameAt(1) + 24 + 100] ^= 0xff; }),
    // nur Wort 1 der gespeicherten Frame-Prüfsumme
    'Prüfsumme Frame 10, Wort 1': damage((wal) => { wal[frameAt(9) + 21] ^= 0x01; }),
    'Seitennummer 0': damage((wal) => { wal.writeUInt32BE(0, frameAt(second)); }),
    // Kette neu berechnet: nur „Seite 0 ist kein Frame“ hält SQLite dort an
    'Seitennummer 0, Kette gültig': damage((wal) => { wal.writeUInt32BE(0, frameAt(second)); rechain(wal); }),
    // Commit-Markierung des vorletzten Commits zerstört: genau ein Commit folgt noch
    'vorletzter Commit unkenntlich': damage((wal) => { wal.writeUInt32BE(0, frameAt(commits.at(-2)) + 4); }),
    'Bruch in der letzten Transaktion': damage((wal) => { wal[frameAt(lastTx) + 24 + 7] ^= 0x01; }),
    // ein ganzer Frame genullt (Loch): die Suche läuft dahinter weiter
    'genullter Frame': damage((wal) => { wal.fill(0, frameAt(8), frameAt(9)); }),
    // ein Salz mit Null-Byte (zufällig möglich) zählt nicht als „Salz 0“
    'Salz mit Null-Byte': damage((wal) => { resalt(wal, Buffer.from([0x12, 0x00, 0x56, 0x34, 0x00, 0x9a, 0xbc, 0xde])); wal[frameAt(1) + 24 + 100] ^= 0xff; }),
    // zwei Schäden: „noch nicht neu berechnet“ (walEncodeFrame) heißt Salz UND Prüfsumme 0, nicht eins davon
    'Bruch, dann Salz des Commits 0': damage((wal) => { wal[frameAt(lastTx) + 24 + 7] ^= 0x01; wal.fill(0, frameAt(commits.at(-1)) + 8, frameAt(commits.at(-1)) + 16); }),
    'Kopf davor 0, Prüfsumme des Commits 0': damage((wal) => { wal.fill(0, frameAt(commits.at(-1) - 1), frameAt(commits.at(-1) - 1) + 24); wal.fill(0, frameAt(commits.at(-1)) + 16, frameAt(commits.at(-1)) + 24); }),
    // die nachgerechnete Kette läuft auch über einen Frame mit Salz und Prüfsumme 0 (Inhalt unversehrt)
    'Salz und Prüfsumme 0, Prüfsumme vor dem Commit verfälscht': damage((wal) => { wal.fill(0, frameAt(lastTx) + 8, frameAt(lastTx) + 24); wal[frameAt(commits.at(-1) - 1) + 16] ^= 0x01; }),
  };
  for (const [name, wal] of Object.entries(cases)) {
    const seen = sqliteValue(PROD.main, wal);
    assert.ok(typeof seen !== 'number' || seen < ALL, `${name}: SQLite verwürfe abgeschlossene Transaktionen (${seen})`);
    refusedAlways(name, PROD.main, wal);
  }
  // genau ein Commit direkt hinter der Abbruchstelle (Ein-Frame-Transaktionen)
  const { main, wal, shm } = afterCheckpoint("CREATE TABLE t (a); INSERT INTO t VALUES ('alt'), ('alt'), ('alt')", ['T1', 'T2', 'T3'].map((v, i) => `db.exec("UPDATE t SET a = '${v}' WHERE rowid = ${i + 1}");`).join(' '));
  assert.deepEqual(commitsOf(wal), [0, 1, 2]);
  const next = damage((w) => { w[frameAt(1) + 24 + 2000] ^= 0xff; }, wal);
  assert.equal(sqliteValue(main, next, "SELECT count(*) FROM t WHERE a = 'T3'"), 0, 'SQLite verwürfe T3');
  refusedAlways('Commit genau hinter der Abbruchstelle', main, next);
  // ein Loch (genullter Frame) direkt davor: der Commit hat keinen prüfbaren Vorgänger und zählt
  const hole = damage((w) => { w.fill(0, frameAt(1), frameAt(2)); }, wal);
  refusedAlways('Loch direkt vor einem Ein-Frame-Commit', main, hole);
  // der WAL-Index des Schreibers kennt T3 als abgeschlossen: belegt nicht „nie bestätigt“
  assertRefused('Loch direkt vor einem Ein-Frame-Commit, mit -shm', main, hole, { shm });
  // nur das Salz eines Frames ohne Commit verfälscht: abgewiesen, auch neben einem Index, der „nie bestätigt“ belegte
  const prodCommits = commitsOf(PROD.wal);
  const plain = Array.from({ length: frameCount(PROD.wal) }, (_, i) => i).find(i => i > prodCommits[2] && !prodCommits.includes(i));
  const before = prodCommits.filter(i => i < plain).at(-1) + 1;
  assertRefused('nur Salz verfälscht, Index bis davor', PROD.main, damage((w) => { w[frameAt(plain) + 9] ^= 0x01; }), { shm: walIndex({ mxFrame: before, salt: PROD.wal.subarray(16, 24) }) });
  // ein Index, der auch nur einen Frame mehr als das Wiederhergestellte kennt, belegt „nie bestätigt“ nicht
  assertRefused('Loch, Index kennt einen Frame mehr', main, hole, { shm: walIndex({ mxFrame: 2, salt: wal.subarray(16, 24) }) });
  // nur eine Prüfsumme verfälscht (die des vorigen Commit-Frames): der letzte Commit setzt die Kette
  // über die tatsächlichen Bytes fort — SQLite verwürfe beide, der letzte ist unversehrt
  const sumOnly = damage((w) => { w[frameAt(1) + 16] ^= 0x01; }, wal);
  assert.equal(sqliteValue(main, sumOnly, "SELECT group_concat(a) FROM t"), 'T1,alt,alt', 'SQLite verwürfe T2 und T3');
  refusedAlways('nur die Prüfsumme des vorigen Commit-Frames verfälscht', main, sumOnly);
  // ein genullter (oder veralteter) 4-KiB-Block: Ende von Frame 1, Kopf und Seite von Frame 2 — Frame 3 ist
  // ein unversehrter Commit ohne prüfbaren Vorgänger (vier Ein-Frame-Transaktionen)
  const four = afterCheckpoint("CREATE TABLE t (a); INSERT INTO t VALUES ('alt'), ('alt'), ('alt'), ('alt')", ['T1', 'T2', 'T3', 'T4'].map((v, i) => `db.exec("UPDATE t SET a = '${v}' WHERE rowid = ${i + 1}");`).join(' '));
  assert.deepEqual(commitsOf(four.wal), [0, 1, 2, 3]);
  const block = damage((w) => { w.fill(0, 8192, 12288); }, four.wal);
  assert.equal(sqliteValue(four.main, block, "SELECT group_concat(a) FROM t"), 'T1,alt,alt,alt');
  refusedAlways('genullter Block', four.main, block);
  assertRefused('genullter Block, mit -shm', four.main, block, { shm: four.shm });
  const older = damage((w) => { w.fill(0x5a, 8192, frameAt(2)); resalt(w, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])); }, four.wal);
  refusedAlways('veralteter Block (ältere Generation)', four.main, damage((w) => { older.copy(w, 8192, 8192, 12288); }, four.wal));
  // viele Transaktionen, jede ein Frame derselben Seite mit gleicher Größe: jede zählt
  const same = join(tempDir(), 'eine-seite.db');
  killedWriter(same, `db.exec("CREATE TABLE t (a)"); db.exec("INSERT INTO t VALUES ('x')"); for (let i = 0; i < 6; i += 1) db.exec("UPDATE t SET a = 'v" + "' || " + i);`);
  const sameWal = readFileSync(`${same}-wal`);
  assert.equal(new Set(commitsOf(sameWal).slice(1).map(i => sameWal.readUInt32BE(frameAt(i)))).size, 1, 'immer dieselbe Seite');
  refusedAlways('gleichartige Ein-Frame-Commits hinter dem Bruch', readFileSync(same), damage((w) => { w[frameAt(commitsOf(w)[1]) + 24 + 50] ^= 0xff; }, sameWal));
});

test('H-2 L-3: WAL-Index (-shm) des letzten Schreibers kennt mehr abgeschlossene Frames, die alle noch im -wal stehen, als SQLite wiederherstellt → abgewiesen', () => {
  const last = frameCount(PROD.wal) - 1;
  const cases = {
    'Beschädigung mitten im -wal': damage((wal) => { wal[frameAt(1) + 24 + 100] ^= 0xff; }),
    // ohne -shm ein abgerissener Commit-Frame; der Schreiber hatte ihn aber abgeschlossen
    'letzter Commit-Frame beschädigt': damage((wal) => { wal[frameAt(last) + 24 + 100] ^= 0xff; }),
    // Commit-Markierung gelöscht, Kette neu berechnet: SQLite sähe eine offene Transaktion
    'Commit-Markierung des letzten Commits gelöscht': damage((wal) => { wal.writeUInt32BE(0, frameAt(last) + 4); rechain(wal); }),
  };
  for (const [name, wal] of Object.entries(cases)) {
    assert.ok(sqliteValue(PROD.main, wal) !== ALL, `${name}: SQLite verwürfe abgeschlossene Transaktionen`);
    assertRefused(name, PROD.main, wal, { shm: PROD.shm });
  }
  // auch ein Index, den SQLite vor dem Schaden neu aufgebaut hat (iChange 0), kennt die Frames
  assertRefused('Index vor dem Schaden neu aufgebaut', PROD.main, cases['letzter Commit-Frame beschädigt'], { shm: rebuiltIndex(PROD.main, PROD.wal) });
  // die letzte Transaktion ist ein einziger Frame: auch ein Frame mehr zählt
  const single = afterCheckpoint("CREATE TABLE t (a); INSERT INTO t VALUES ('alt')", ['T1', 'T2', 'T3'].map(v => `db.exec("UPDATE t SET a = '${v}'");`).join(' '));
  assert.deepEqual(commitsOf(single.wal), [0, 1, 2]);
  const lastOne = damage((w) => { w[frameAt(2) + 24 + 2000] ^= 0xff; }, single.wal);
  assert.equal(sqliteValue(single.main, lastOne, "SELECT a FROM t"), 'T2', 'SQLite verwürfe T3');
  assertRefused('letzte Ein-Frame-Transaktion beschädigt', single.main, lastOne, { shm: single.shm });
  const commitField = damage((w) => { w.writeUInt32BE(0, frameAt(2) + 4); }, single.wal);
  assert.equal(sqliteValue(single.main, commitField, "SELECT a FROM t"), 'T2', 'SQLite verwürfe T3');
  assertRefused('Commit-Feld der letzten Ein-Frame-Transaktion 0, mit -shm', single.main, commitField, { shm: single.shm });
  // auch ein -wal aus nur zwei Frames: der WAL-Index wird gelesen
  const two = afterCheckpoint("CREATE TABLE t (a); INSERT INTO t VALUES ('alt')", ['T1', 'T2'].map(v => `db.exec("UPDATE t SET a = '${v}'");`).join(' '));
  assert.equal(frameCount(two.wal), 2);
  assertRefused('-wal aus zwei Frames, der letzte beschädigt', two.main, damage((w) => { w[frameAt(1) + 24 + 2000] ^= 0xff; }, two.wal), { shm: two.shm });
  // Salz und Prüfsumme des letzten Commit-Frames verfälscht, Seite unversehrt: die Kette über die tatsächlichen
  // Bytes ergibt die Prüfsumme, die der Index für diesen Frame festhält (aFrameCksum) — er stand vollständig da
  const saltless = damage((wal) => { wal.fill(0, frameAt(last) + 8, frameAt(last) + 24); });
  assertRefused('Salz und Prüfsumme des letzten Commits 0, mit -shm', PROD.main, saltless, { shm: PROD.shm });
  assertRefused('Salz und Prüfsumme des letzten Commits fremd, mit -shm', PROD.main, damage((wal) => { wal[frameAt(last) + 13] ^= 0x01; wal[frameAt(last) + 17] ^= 0x01; }), { shm: PROD.shm });
  // ebenso mit einem Index, den SQLite vor dem Schaden neu aufbaute (iChange 0), und über zwei solche Frames
  assertRefused('Salz und Prüfsumme des letzten Commits 0, Index neu aufgebaut', PROD.main, saltless, { shm: rebuiltIndex(PROD.main, PROD.wal) });
  const lastStart = commitsOf(PROD.wal).at(-2) + 1;
  assertRefused('Salz und Prüfsumme zweier Frames der letzten Transaktion 0, mit -shm', PROD.main, damage((wal) => { wal.fill(0, frameAt(lastStart) + 8, frameAt(lastStart) + 24); wal.fill(0, frameAt(last) + 8, frameAt(last) + 24); }), { shm: PROD.shm });
  // die letzten beiden Frames: dann prüft nur die Kette über alle tatsächlichen Bytes (g2), auch über Frames mit Salz 0
  assertRefused('Salz und Prüfsumme der letzten beiden Frames 0, mit -shm', PROD.main, damage((wal) => { wal.fill(0, frameAt(last - 1) + 8, frameAt(last - 1) + 24); wal.fill(0, frameAt(last) + 8, frameAt(last) + 24); }), { shm: PROD.shm });
  // ein -wal aus genau einem Frame liest sein -shm ebenso
  const one = afterCheckpoint("CREATE TABLE t (a); INSERT INTO t VALUES ('alt')", `db.exec("UPDATE t SET a = 'neu'");`);
  assert.equal(frameCount(one.wal), 1);
  const oneBroken = damage((w) => { w[frameAt(0) + 24 + 2000] ^= 0xff; }, one.wal);
  assert.equal(sqliteValue(one.main, oneBroken, "SELECT a FROM t"), 'alt', 'SQLite verwürfe das UPDATE');
  assertRefused('-wal aus einem Frame, beschädigt, mit -shm', one.main, oneBroken, { shm: one.shm });
  // zwei Schäden: der Commit-Frame der vorletzten Transaktion genullt (oder ein 4-KiB-Block darüber), dazu ein Bit einer
  // gespeicherten Prüfsumme der unversehrten letzten — oder deren Salz: der letzte bestätigte Commit-Frame steht noch da (g3)
  const lastCommits = commitsOf(PROD.wal);
  const prevCommit = lastCommits.at(-2);
  const spot = (wal) => wal.fill(0, frameAt(prevCommit) + 8, frameAt(prevCommit) + 24 + 64);
  const block = (wal) => { const start = Math.floor((frameAt(prevCommit) + 8) / 4096) * 4096; wal.fill(0, Math.max(start, 32), start + 4096); };
  const twoSpots = {
    'Commit-Frame davor genullt, Prüfsumme des letzten Commits': damage((wal) => { spot(wal); wal[frameAt(last) + 19] ^= 0x01; }),
    'Commit-Frame davor genullt, Prüfsumme des Frames vor dem letzten Commit': damage((wal) => { spot(wal); wal[frameAt(last - 1) + 19] ^= 0x01; }),
    '4-KiB-Block über dem Commit-Frame davor genullt, Prüfsumme des letzten Commits': damage((wal) => { block(wal); wal[frameAt(last) + 19] ^= 0x01; }),
  };
  for (const [name, wal] of Object.entries(twoSpots)) {
    assert.ok(sqliteValue(PROD.main, wal) < ALL, `${name}: SQLite verwürfe abgeschlossene Transaktionen`);
    assertRefused(`${name}, mit -shm`, PROD.main, wal, { shm: PROD.shm });
  }
  // dasselbe mit verfälschtem Salz des letzten Commits, Hauptdatei vollständig (keine ältere Generation zu groß):
  // seine Bytes setzen die gespeicherte Prüfsumme des Frames davor zu aFrameCksum fort
  const updates = afterCheckpoint(`CREATE TABLE t (a); ${rows(120, 'v')}`, ['0', '1', '2'].map((digit, i) => `db.exec("UPDATE t SET a = replace(a, '${digit}', '${i + 1}')");`).join(' '));
  const updateCommits = commitsOf(updates.wal);
  assert.equal(updateCommits.length, 3);
  assert.ok(updateCommits[2] - updateCommits[1] >= 2, 'letzte Transaktion aus mehreren Frames');
  const saltedLast = damage((wal) => {
    wal.fill(0, frameAt(updateCommits[1]) + 8, frameAt(updateCommits[1]) + 24 + 64);
    wal[frameAt(updateCommits[2]) + 9] ^= 0x01;
  }, updates.wal);
  assert.equal(sqliteValue(updates.main, saltedLast, "SELECT count(*) FROM t WHERE a LIKE 'v1%'"), 120, 'SQLite läse nur den Stand nach T1');
  assertRefused('Commit-Frame davor genullt, Salz des letzten Commits, mit -shm', updates.main, saltedLast, { shm: updates.shm });
  // ebenso, wenn die Abbruchstelle genau der Frame vor dem letzten Commit ist (seine Seite verfälscht, seine Prüfsumme nicht)
  const beforeLast = damage((wal) => {
    wal[frameAt(updateCommits[2] - 1) + 24 + 100] ^= 0x01;
    wal[frameAt(updateCommits[2]) + 9] ^= 0x01;
  }, updates.wal);
  assertRefused('Seite des Frames vor dem letzten Commit, Salz des letzten Commits, mit -shm', updates.main, beforeLast, { shm: updates.shm });
  // ohne -shm gleicht das einem Commit vor neu berechneten Prüfsummen (walEncodeFrame): offen
  assert.equal(assertAccepted('Salz und Prüfsumme des letzten Commits 0, ohne -shm', PROD.main, saltless), 180);
  // das -shm zählt neben dem echten Ziel (wie bei SQLite), nicht neben einem Verweis darauf
  const damaged = cases['letzter Commit-Frame beschädigt'];
  const viaLink = (shmAtTarget) => {
    const { path } = lage(PROD.main, damaged, shmAtTarget ? PROD.shm : null);
    const link = join(tempDir(), 'verweis.db');
    symlinkSync(path, link);
    if (!shmAtTarget) writeFileSync(`${link}-shm`, PROD.shm);
    return openProblem(link).verdict;
  };
  assert.equal(viaLink(true), 'damaged-wal', '-shm neben dem Ziel');
  assert.equal(viaLink(false), null, '-shm nur neben dem Verweis belegt nichts');
  // nur ein Index, den SQLite selbst als gültig läse, belegt etwas: sonst wie ohne -shm
  // (dort ein abgerissener letzter Commit-Frame, ein normaler Absturzrest)
  const torn = damage((wal) => { wal.fill(0, frameAt(last) + 24 + PAGE / 2, frameAt(last + 1)); });
  const claim = { mxFrame: last + 1, salt: PROD.wal.subarray(16, 24) };
  assertRefused('gültiger Index kennt den abgerissenen Frame als abgeschlossen', PROD.main, torn, { shm: walIndex(claim) });
  const forged = {
    'anderes Salz': walIndex({ ...claim, salt: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]) }),
    'nur Salz-2 anders': walIndex({ ...claim, salt: Buffer.concat([claim.salt.subarray(0, 4), Buffer.from([9, 9, 9, 9])]) }),
    'nur Salz-1 anders': walIndex({ ...claim, salt: Buffer.concat([Buffer.from([9, 9, 9, 9]), claim.salt.subarray(4)]) }),
    'Prüfsumme falsch': (() => { const shm = walIndex(claim); shm[40] ^= 1; shm[88] ^= 1; return shm; })(),
    'Kopien verschieden': (() => { const shm = walIndex(claim); shm[48 + 8] ^= 1; return shm; })(),
    'nicht initialisiert': walIndex({ ...claim, isInit: 0 }),
    'andere Version': walIndex({ ...claim, version: 3007001 }),
  };
  for (const [name, shm] of Object.entries(forged)) assert.equal(assertAccepted(`-shm ${name}`, PROD.main, torn, { shm }), 180, name);
  // ein -shm, das sich nicht lesen lässt, ist kein fehlendes (SQLite öffnet dann gar nicht): abgewiesen
  const { dir, path, before } = lage(PROD.main, damaged, PROD.shm);
  chmodSync(`${path}-shm`, 0o000);
  try {
    assert.equal(openProblem(path).verdict, 'invalid-file');
    assert.match(openProblem(path).detail, /WAL-Index \(-shm\) neben der Datei ist nicht lesbar/);
    for (const mode of ['apply', 'app', 'inspect']) assert.throws(() => openDatabase(path, mode), { code: 'UNKNOWN_SCHEMA' }, mode);
  } finally {
    chmodSync(`${path}-shm`, 0o600);
  }
  assert.deepEqual(snapshot(dir), before, 'Hauptdatei, -wal und -shm bytegleich');
  // ebenso, wenn ein Kindprozess (-shm oder Kopf der Hauptdatei, D1) nicht startet (EAGAIN), das Zeitlimit reißt oder durch ein Signal endet
  const faults = {
    EAGAIN: "{ status: null, signal: null, error: Object.assign(new Error('spawnSync EAGAIN'), { code: 'EAGAIN' }) }",
    Zeitlimit: "{ status: null, signal: 'SIGTERM', error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }) }",
    Signal: "{ status: null, signal: 'SIGKILL' }",
  };
  for (const [name, fault] of Object.entries(faults)) for (const shm of [true, false]) {
    const preload = join(tempDir(), 'kind.mjs');
    writeFileSync(preload, `
      import { createRequire, syncBuiltinESMExports } from 'node:module';
      const cp = createRequire(import.meta.url)('node:child_process');
      const real = cp.spawnSync;
      cp.spawnSync = function (file, args, options) {
        if (args?.[0] === '-e' && String(args[1]).includes('process.argv[1]') && String(args[2]).endsWith('-shm') === ${shm}) return { pid: 0, output: [null, '', ''], stdout: '', stderr: '', ...${fault} };
        return real.call(this, file, args, options);
      };
      syncBuiltinESMExports();
    `);
    const child = spawnSync(process.execPath, ['--import', preload, '--input-type=module', '-e', `
      const { openProblem } = await import(${JSON.stringify(join(ROOT, 'lib', 'db', 'open.mjs'))});
      const { verdict, detail } = openProblem(${JSON.stringify(path)});
      process.stdout.write(JSON.stringify({ verdict, detail }));
    `], { encoding: 'utf8' });
    const label = `${name} (${shm ? '-shm' : 'Kopf der Hauptdatei'}): ${child.stderr}`;
    const { verdict, detail } = JSON.parse(child.stdout || '{}');
    assert.equal(verdict, 'invalid-file', label);
    // abgewiesen wegen genau dieses Kindprozesses — kein Rückfall auf Lesen in diesem Prozess
    assert.match(detail, shm ? /WAL-Index \(-shm\) neben der Datei ist nicht lesbar/ : /keine gültige SQLite-Hauptdatei \(nicht lesbar \(Kindprozess\)\)/, label);
  }
  // der Kindprozess erbt die Umgebung nicht: ein NODE_OPTIONS dieses Prozesses stört ihn nicht
  const { path: plainEnv } = lage(PROD.main, PROD.wal, PROD.shm);
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--require=${join(tempDir(), 'gibt-es-nicht.cjs')}`;
  try {
    assert.equal(openProblem(plainEnv).verdict, null);
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
  }
  // verschwindet das -shm nach der Prüfung auf Existenz (die letzte Verbindung schließt und löscht es),
  // zählt es als fehlend — kein „nicht lesbar“ (bei jedem Lesedurchgang erneut, wie bei ständigem Öffnen und Schließen)
  const { path: closing } = lage(PROD.main, PROD.wal, PROD.shm);
  const vanish = join(tempDir(), 'weg.mjs');
  writeFileSync(vanish, `
    import { createRequire, syncBuiltinESMExports } from 'node:module';
    const require = createRequire(import.meta.url);
    const cp = require('node:child_process');
    const fs = require('node:fs');
    const real = cp.spawnSync;
    cp.spawnSync = function (file, args, options) {
      if (!(args?.[0] === '-e' && String(args[1]).includes('process.argv[1]') && String(args[2]).endsWith('-shm'))) return real.call(this, file, args, options);
      const saved = fs.readFileSync(args[2]);
      fs.rmSync(args[2]);
      try { return real.call(this, file, args, options); } finally { fs.writeFileSync(args[2], saved); }
    };
    syncBuiltinESMExports();
  `);
  const gone = spawnSync(process.execPath, ['--import', vanish, '--input-type=module', '-e', `
    const { openProblem } = await import(${JSON.stringify(join(ROOT, 'lib', 'db', 'open.mjs'))});
    process.stdout.write(String(openProblem(${JSON.stringify(closing)}).verdict));
  `], { encoding: 'utf8' });
  assert.equal(gone.stdout, 'null', gone.stderr);
});

test('H-2 L-3: ältere -wal-Generation, die nie in der Hauptdatei stand → abgewiesen (je Generation zählt ihr letzter Commit)', () => {
  const resalted = damage(restart);
  assert.notEqual(sqliteValue(PROD.main, resalted), ALL);
  assertRefused('neuer Kopf, Hauptdatei ohne die Daten', PROD.main, resalted);
  // ältere Generation aus nur einem Frame, dem Abbruch-Frame selbst: sein Commit zählt
  const head = Buffer.from(PROD.wal.subarray(0, 32));
  restart(head);
  const lone = Buffer.concat([head, PROD.wal.subarray(frameAt(1), frameAt(2))]);
  assert.ok(lone.readUInt32BE(frameAt(0) + 4) > 1);
  assertRefused('einzelner Frame älterer Generation', PROD.main, lone);
  // Commits mit Größe 2, dann größer: der letzte zählt, nicht der erste
  const grown = afterCheckpoint('CREATE TABLE t (a)', `db.exec("INSERT INTO t VALUES ('x')"); db.exec(${JSON.stringify(rows(60, 'g'))}); db.exec("UPDATE t SET a = 'y' WHERE rowid = 1");`);
  assert.equal(grown.main.length / PAGE, 2);
  const sizes = commitsOf(grown.wal).map(i => grown.wal.readUInt32BE(frameAt(i) + 4));
  assert.ok(sizes[0] === 2 && sizes.at(-1) > 2, `Größen ${sizes}`);
  assertRefused('erst kleiner, dann größerer Commit', grown.main, damage(restart, grown.wal));
  // zwei ältere Generationen: die jüngere (zuletzt gewachsene) zählt, auch wenn die ältere passt
  const twice = join(tempDir(), 'zweimal.db');
  killedWriter(twice, `db.exec("CREATE TABLE t (a)"); db.exec(${JSON.stringify(rows(150, 'g'))}); db.pragma('wal_checkpoint(PASSIVE)'); db.exec(${JSON.stringify(rows(40, 'h'))});`);
  const twiceMain = readFileSync(twice);
  const twiceWal = readFileSync(`${twice}-wal`);
  const twiceCommits = commitsOf(twiceWal).map(i => twiceWal.readUInt32BE(frameAt(i) + 4));
  assert.ok(Math.max(...twiceCommits) > twiceMain.length / PAGE, 'jüngere Generation größer als die Hauptdatei');
  assertRefused('zwei ältere Generationen', twiceMain, damage(restart, twiceWal));
  // die zweite (ältere) Generation ist die zu große: auch sie zählt, getrennt nach Salz
  const head2 = Buffer.from(PROD.wal.subarray(0, 32));
  restart(head2);
  const small = Buffer.from(PROD.wal.subarray(frameAt(0), frameAt(1)));
  small.writeUInt32BE(1, 4);
  // eigene Generation: eigenes Salz und eigene Kette (die nächste Generation setzt sie nicht fort)
  Buffer.from([9, 9, 9, 9, 8, 8, 8, 8, 7, 7, 7, 7, 6, 6, 6, 6]).copy(small, 8);
  assertRefused('ältere Generation hinter einer passenden', PROD.main, Buffer.concat([head2, small, PROD.wal.subarray(frameAt(1))]));
});

test('H-2 L-3: Commit-Abdeckung — nur nicht abgeschlossene Frames decken fehlende Seiten nicht ab', () => {
  // Hauptdatei im DELETE-Modus (Kopf-Seitenzahl gültig), auf 2 Seiten gekürzt
  const path = join(tempDir(), 'voll.db');
  const db = new Database(path);
  db.exec(`CREATE TABLE t (a); ${rows(120, 'v')}`);
  db.close();
  const full = readFileSync(path);
  const pages = full.length / PAGE;
  assert.ok(pages > 4);
  const main = full.subarray(0, 2 * PAGE);
  // -wal von Hand: Frames für Seiten 3..pages, keiner mit Commit
  const head = Buffer.alloc(32);
  head.writeUInt32BE(0x377f0682, 0); head.writeUInt32BE(3007000, 4); head.writeUInt32BE(PAGE, 8);
  head.writeUInt32BE(7, 16); head.writeUInt32BE(9, 20);
  const frames = [];
  for (let page = 3; page <= pages; page += 1) {
    const frame = Buffer.alloc(FRAME);
    frame.writeUInt32BE(page, 0);
    head.copy(frame, 8, 16, 24);
    full.copy(frame, 24, (page - 1) * PAGE, page * PAGE);
    frames.push(frame);
  }
  const wal = Buffer.concat([head, ...frames]);
  reseal(wal);
  rechain(wal);
  assertRefused('Seiten nur in nicht abgeschlossenen Frames', main, wal, { verdict: 'invalid-file' });
  // mit Commit im letzten Frame sind sie abgedeckt
  wal.writeUInt32BE(pages, frameAt(frames.length - 1) + 4);
  rechain(wal);
  assert.equal(sqliteValue(main, wal), 120);
});

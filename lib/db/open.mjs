/**
 * Eine Regel für Pfad und Verbindungsaufbau — für App, CLI und Tests.
 * Welche Sicherheitsregeln gelten, entscheidet lib/db/environment.mjs.
 */
import Database from 'better-sqlite3';
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readlinkSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { MigrationError } from './errors.mjs';
import { assertSupportedRuntime } from './runtime.mjs';
import { readIndexHeader, walChecksum, walIndexEnd } from './wal-index.mjs';

/** Pfad der CRM-Datenbank: SQLITE_PATH oder ./data/crm.db (wie bisher in lib/d1-node.ts). */
export function resolveDbPath(env = process.env, cwd = process.cwd()) {
  return env.SQLITE_PATH || resolve(cwd, 'data', 'crm.db');
}

const MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
const WAL_MAGIC = [0x377f0682, 0x377f0683];
const WAL_VERSION = 3007000;
const WAL_HEADER = 32;
const FRAME_HEADER = 24;
/** SQLITE_MAX_SYMLINK in os_unix.c (appendOnePathElement: `nSymlink++ > 200`, also 201 aufgelöste Verweise). */
const SQLITE_MAX_SYMLINK = 200;

/** Fehler, die „Datei gibt es hier nicht" bedeuten (auch: ein Pfadteil ist keine Ordner). */
const missing = (error) => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
const validPageSize = (size) => size >= 512 && size <= 65536 && (size & (size - 1)) === 0;

/**
 * Prüft die Hauptdatei nur mit fs, bevor SQLite sie öffnet (M-1).
 *
 * SQLite verändert beim Öffnen einer unvollständigen Hauptdatei das daneben
 * liegende -wal: Bei 0 oder 1 Byte löscht es das -wal (auch schreibgeschützt),
 * bei einem abgeschnittenen Kopf oder einer angebrochenen ersten Seite
 * schreibt eine Lese-Schreib-Verbindung das -wal beim Schließen in die
 * Hauptdatei zurück und löscht es; schreibgeschützt entsteht ein -shm.
 * Entschieden wird deshalb nicht nach Bytezahl, sondern nach Aufbau
 * (https://sqlite.org/fileformat2.html#the_database_header): gültig ist nur
 * eine Datei mit vollständigem, plausiblem 100-Byte-Kopf, die aus ganzen
 * Seiten besteht. Im WAL-Modus darf sie kürzer sein als die Datenbank (der
 * Rest liegt im -wal), aber nie eine angebrochene Seite enthalten — ob die
 * Seiten bis zur Datenbankgröße vollständig sind, prüft openProblem mit dem -wal.
 *
 * @param {string} path
 * @returns {{ state: 'absent' | 'empty' | 'valid' | 'invalid', bytes: number, reason?: string, pageSize?: number, headerPages?: number | null }}
 *   `headerPages`: Seitenzahl laut Dateikopf, nur wenn SQLite sie gelten lässt (Bytes 24–27 = 92–95)
 */
export function inspectMainFile(path) {
  let stats;
  const head = Buffer.alloc(100);
  let length;
  try {
    stats = statSync(path);
    if (!stats.isFile()) return { state: 'invalid', bytes: 0, reason: 'keine reguläre Datei' };
    if (stats.size === 0) return { state: 'empty', bytes: 0 };
    const fd = openSync(path, 'r');
    try {
      length = readSync(fd, head, 0, head.length, 0);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (missing(error)) return { state: 'absent', bytes: 0 };
    return { state: 'invalid', bytes: stats?.size ?? 0, reason: `nicht lesbar (${error?.code ?? 'Fehler'})` };
  }
  const reason = headerProblem(head.subarray(0, length), stats.size);
  if (reason) return { state: 'invalid', bytes: stats.size, reason };
  const raw = head.readUInt16BE(16);
  const headerPages = head.readUInt32BE(28) > 0 && head.readUInt32BE(24) === head.readUInt32BE(92) ? head.readUInt32BE(28) : null;
  return { state: 'valid', bytes: stats.size, pageSize: raw === 1 ? 65536 : raw, headerPages };
}

/** Dieselben Kopf-Prüfungen, mit denen SQLite eine Datei ablehnt, plus: nur ganze Seiten. */
function headerProblem(head, size) {
  if (head.length < 100) return `kürzer als der 100-Byte-Dateikopf (${size} Bytes)`;
  if (!head.subarray(0, 16).equals(MAGIC)) return 'kein SQLite-Dateikopf';
  const raw = head.readUInt16BE(16);
  const pageSize = raw === 1 ? 65536 : raw;
  if (!validPageSize(pageSize)) return `ungültige Seitengröße ${raw}`;
  if (![1, 2].includes(head[18]) || ![1, 2].includes(head[19])) return `unbekannte Formatversion ${head[18]}/${head[19]}`;
  if (pageSize - head[20] < 480 || head[21] !== 64 || head[22] !== 32 || head[23] !== 32) return 'ungültige Felder im Dateikopf';
  if (size % pageSize !== 0) return `${size} Bytes sind keine ganzen Seiten zu ${pageSize} Bytes (abgeschnitten?)`;
  return null;
}

/**
 * Pfad, an dem SQLite Hauptdatei und -wal tatsächlich sucht — aufgelöst wie
 * dort (os_unix.c, unixFullPathname): ein relativer Pfad wird ungekürzt hinter
 * das Arbeitsverzeichnis gehängt (nicht path.join: das kürzte „link/..“
 * textuell, SQLite und das Dateisystem gehen aber erst durch den Verweis),
 * dann Abschnitt für Abschnitt, Symlinks per readlink, „..“ gegen den schon
 * aufgelösten (physischen) Pfad, höchstens SQLITE_MAX_SYMLINK + 1 Verweise; ein
 * fehlender Abschnitt wird unverändert angehängt. So zählt das -wal neben dem
 * echten Ziel, auch hinter Ordner-Symlinks und Verweisen ins Leere.
 *
 * @returns {string | null} null, wenn ein Verweisziel kein gültiges UTF-8 ist:
 *   Node läse es verlustbehaftet, SQLite nutzte die Bytes — keine gemeinsame Datei
 */
export function sqlitePath(path) {
  const pending = (isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`).split(sep).filter(Boolean).reverse();
  let current = sep;
  let links = 0;
  while (pending.length) {
    const part = pending.pop();
    if (part === '.') continue;
    if (part === '..') {
      current = dirname(current);
      continue;
    }
    const next = join(current, part);
    let target = null;
    try {
      if (lstatSync(next).isSymbolicLink()) target = readlinkSync(next, { encoding: 'buffer' });
    } catch { /* fehlt: so anhängen */ }
    if (target !== null) {
      const text = target.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(target)) return null;
      target = text;
    }
    // mehr Verweise löst SQLite nicht auf (SQLITE_CANTOPEN); dann öffnet es nichts
    if (target === null || links > SQLITE_MAX_SYMLINK) {
      current = next;
      continue;
    }
    links += 1;
    if (isAbsolute(target)) current = sep;
    pending.push(...target.split(sep).filter(Boolean).reverse());
  }
  return current;
}

/**
 * Was SQLite beim Öffnen aus dem -wal wiederherstellen würde (wie wal.c,
 * walIndexRecover): bis 32 Byte nichts; sonst gültiger Kopf mit Prüfsumme,
 * dann Frames mit passendem Salz und fortlaufender Prüfsumme bis zum ersten
 * ungültigen (Abbruchstelle); es zählen nur Frames bis zum letzten Commit. Nur lesen.
 *
 * Dazu, was SQLite dabei verwürfe, obwohl es kein Absturzrest ist (H-2) —
 * SQLite löschte oder überschriebe das -wal danach mitsamt diesen Daten:
 * - ein Kopf, den SQLite verwirft (Kennung, Seitengröße, Prüfsumme) oder mit
 *   dem es gar nicht öffnet (Version): SQLite schreibt den Kopf in einem Stück
 *   und synchronisiert ihn vor dem ersten Frame, er ist nie halb geschrieben;
 * - ein Frame, dessen Prüfsumme die Kette fortsetzt, nur das Salz nicht: ein
 *   Frame dieser Generation mit verfälschtem Salz (bei einem älteren Frame
 *   passt die Prüfsumme nicht zur neuen Kette);
 * - ein Commit-Frame dieser Generation hinter der Abbruchstelle, der die Kette fortsetzt —
 *   ab der gespeicherten Prüfsumme seines Vorgängers oder ab der über die Bytes seit dem
 *   letzten gültigen Frame nachgerechneten (nur eine Prüfsumme verfälscht) —, oder der keinen
 *   prüfbaren Vorgänger hat (zählt, weil nicht prüfbar). Ein abgerissener (Kopf geschrieben,
 *   Seite nicht — wal.c schreibt beides getrennt) setzt sie nicht fort und zählt nicht. Ein
 *   vollständiger bleibt etwa liegen, wenn ein zweiter Prozess das -shm hielt und nach dem
 *   Absturz des ersten kürzer weiterschrieb: dessen seit dem letzten Neuaufbau beschriebener
 *   WAL-Index (iChange > 0) kennt nichts dahinter (mxFrame ≤ wiederhergestellt) — ein von SQLite
 *   neu aufgebauter (iChange 0) zeigt das nicht;
 * - abgeschlossene Frames, die der letzte Schreiber kannte (WAL-Index, -shm: mxFrame) und
 *   SQLite nicht wiederherstellt, wenn (g1) alle ihre Köpfe noch das Salz dieser Generation
 *   tragen (die Seiten prüft g1 nicht), (g2) die Kette über ihre tatsächlichen Bytes
 *   (Seitennummer, Commit, Seite) die Prüfsumme des Index ergibt (aFrameCksum) oder (g3) ihr
 *   letzter Commit-Frame selbst noch dasteht: mit diesem Salz, oder seine Bytes setzen die
 *   gespeicherte Prüfsumme des Frames davor zu aFrameCksum fort. Verfälschtes Salz oder
 *   Prüfsumme über unveränderten Seiten sieht so aus — ebenso ein Stromausfall, der nur
 *   einen Teil auf die Platte brachte (Köpfe ohne ihre Seiten; Seiten, deren neu berechnete
 *   Köpfe einer übergelaufenen Transaktion fehlen): abgewiesen, obwohl SQLite dort nur nie
 *   synchronisierte Transaktionen verlöre. Sonst (Datei kürzer; Köpfe nicht mehr von dieser
 *   Generation und Seiten genullt oder veraltet) gilt: nie vollständig auf die Platte gekommen —
 *   Stromausfall bei synchronous=NORMAL, das -shm wird nie synchronisiert. Zwei unabhängige
 *   Schäden (etwa der letzte Commit-Frame ohne Salz und sein Vorgänger zerstört) sehen ebenso
 *   aus und bleiben offen; SQLite verlöre dann auch bestätigte Transaktionen.
 * Frames mit Salz und Prüfsumme 0 (so schreibt SQLite, bis es Prüfsummen
 * überschriebener Frames neu rechnet: walEncodeFrame) zählen für (d) und (e) nicht.
 * `olderCommit` meldet je älterer Generation hinter der Abbruchstelle deren
 * letzten Commit, soweit ihre Prüfsummenkette ab dem ersten sichtbaren Frame
 * hält (liegengebliebene Reste danach zählen nicht), das Größte davon.
 *
 * @param {string} path -wal
 * @param {string} indexPath -shm
 * @returns {{ bytes: number, unreadable?: string, indexUnreadable?: true, damage: string | null, pageSize: number | null, pages: Set<number>, dbSize: number, olderCommit: number }}
 *   `dbSize`: Seitenzahl nach dem letzten Commit im -wal (0 = keiner)
 */
function readWal(path, indexPath) {
  const result = { bytes: 0, damage: null, pageSize: null, pages: new Set(), dbSize: 0, olderCommit: 0 };
  // WAL-Index vor dem -wal (erst Frames, dann Index: er wirkt nie weiter); nur, wenn SQLite im -wal etwas liest
  const indexHeader = walBytes(path) > WAL_HEADER ? readIndexHeader(indexPath) : null;
  if (indexHeader === undefined) return { ...result, bytes: 1, indexUnreadable: true };
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    if (missing(error)) return result;
    return { ...result, bytes: 1, unreadable: error?.code ?? 'Fehler' };
  }
  try {
    result.bytes = fstatSync(fd).size;
    if (result.bytes <= WAL_HEADER) return result;
    const head = Buffer.alloc(WAL_HEADER);
    if (readSync(fd, head, 0, WAL_HEADER, 0) < WAL_HEADER) return { ...result, unreadable: 'kürzer als gemeldet' };
    const magic = head.readUInt32BE(0);
    const pageSize = head.readUInt32BE(8);
    const damaged = (reason) => ({ ...result, damage: reason });
    if (!WAL_MAGIC.includes(magic)) return damaged('-wal-Kopf ohne gültige Kennung');
    if (!validPageSize(pageSize)) return damaged(`-wal-Kopf mit ungültiger Seitengröße ${pageSize}`);
    // Prüfsummen-Wörter: Bit 0 der Kennung = big-endian
    const word = magic & 1 ? 'readUInt32BE' : 'readUInt32LE';
    let sum = walChecksum(head.subarray(0, 24), [0, 0], word);
    if (sum[0] !== head.readUInt32BE(24) || sum[1] !== head.readUInt32BE(28)) return damaged('Prüfsumme des -wal-Kopfs stimmt nicht');
    if (head.readUInt32BE(4) !== WAL_VERSION) return damaged(`unbekannte -wal-Version ${head.readUInt32BE(4)}`);
    result.pageSize = pageSize;
    const salt = head.subarray(16, 24);
    const frame = Buffer.alloc(FRAME_HEADER + pageSize);
    const frames = Math.floor((result.bytes - WAL_HEADER) / frame.length);
    const at = (index) => WAL_HEADER + index * frame.length;
    // Prüfsumme dieses Frames, fortgesetzt von `from`
    const chain = (from) => walChecksum(frame.subarray(FRAME_HEADER), walChecksum(frame.subarray(0, 8), from, word), word);
    const stored = () => [frame.readUInt32BE(16), frame.readUInt32BE(20)];
    const same = (sum) => sum[0] === frame.readUInt32BE(16) && sum[1] === frame.readUInt32BE(20);
    const continues = (from) => same(chain(from));
    const pending = [];
    let committed = 0;
    let stop = 0;
    for (; stop < frames; stop += 1) {
      if (readSync(fd, frame, 0, frame.length, at(stop)) < frame.length) break;
      const page = frame.readUInt32BE(0);
      const next = chain(sum);
      const chained = same(next);
      const ownSalt = frame.subarray(8, 16).equals(salt);
      if (page === 0 || !ownSalt || !chained) {
        if (page !== 0 && !ownSalt && chained) return damaged(`Frame ${stop + 1} im -wal: nur das Salz ist verfälscht`);
        break;
      }
      sum = next;
      pending.push(page);
      const commit = frame.readUInt32BE(4);
      if (commit > 0) {
        for (const done of pending) result.pages.add(done);
        pending.length = 0;
        result.dbSize = commit;
        committed = stop + 1;
      }
    }
    // stehen die Frames, die der WAL-Index als abgeschlossen kennt, alle noch mit diesem Salz da?
    const present = (to) => to <= frames && Array.from({ length: to - committed }, (_, i) => at(committed + i))
      .every(offset => readSync(fd, frame, 0, FRAME_HEADER, offset) === FRAME_HEADER && frame.subarray(8, 16).equals(salt));
    const shm = walIndexEnd(indexHeader, salt);
    if (shm && shm.known > committed && present(shm.known)) {
      return damaged(`der WAL-Index (-shm) kennt ${shm.known} abgeschlossene Frames, alle stehen im -wal, SQLite stellte nur ${committed} wieder her`);
    }
    // (g3) der letzte vom Index bestätigte Commit-Frame steht selbst noch da
    const lastClaimed = () => {
      const from = shm.known - 2 >= stop && readSync(fd, frame, 0, FRAME_HEADER, at(shm.known - 2)) === FRAME_HEADER ? stored() : null;
      if (readSync(fd, frame, 0, frame.length, at(shm.known - 1)) < frame.length) return false;
      return (frame.subarray(8, 16).equals(salt) && frame.readUInt32BE(4) > 0) || (from !== null && chain(from).every((value, i) => value === shm.sum[i]));
    };
    if (shm && shm.known > committed && shm.known <= frames && lastClaimed()) {
      return damaged(`der WAL-Index (-shm) kennt ${shm.known} abgeschlossene Frames, ihr letzter Commit-Frame steht noch im -wal, SQLite stellte nur ${committed} wieder her`);
    }
    const unconfirmed = shm !== null && shm.written && shm.known <= committed;
    // ab der Abbruchstelle: Commits dieser Generation, ältere Generationen
    const lastCommits = [];
    let group = null;
    let previous = null;
    let recomputed = sum;
    let confirmed = false;
    for (let index = stop; index < frames; index += 1) {
      if (readSync(fd, frame, 0, frame.length, at(index)) < frame.length) break;
      const commit = frame.readUInt32BE(4);
      const before = previous;
      recomputed = chain(recomputed);
      const whole = before === null || continues(before) || same(recomputed);
      // der Index bestätigt bis hier, und seine Prüfsumme ist die über die tatsächlichen Bytes (g)
      if (shm && index === shm.known - 1 && recomputed.every((value, i) => value === shm.sum[i])) confirmed = true;
      previous = null;
      // Salz und Prüfsumme 0: noch nicht neu berechnet (bricht eine ältere Kette)
      if (frame.subarray(8, FRAME_HEADER).every(byte => byte === 0)) {
        if (group) group.broken = true;
        continue;
      }
      const frameSalt = frame.subarray(8, 16);
      if (frameSalt.equals(salt)) {
        if (commit > 0 && index > stop && whole && !unconfirmed) {
          return damaged(`Frame ${index + 1} im -wal schließt eine Transaktion ab, die SQLite hinter der Abbruchstelle (Frame ${stop + 1}) verwürfe — kein WAL-Index eines späteren Schreibers belegt, dass sie nie bestätigt wurde`);
        }
        previous = stored();
        continue;
      }
      if (!group || !group.salt.equals(frameSalt)) {
        group = { salt: Buffer.from(frameSalt), sum: null, broken: false };
        lastCommits.push(0);
      } else if (!group.broken && !continues(group.sum)) {
        group.broken = true;
      }
      group.sum = stored();
      if (commit > 0 && !group.broken) lastCommits[lastCommits.length - 1] = commit;
    }
    if (confirmed) {
      return damaged(`der WAL-Index (-shm) bestätigt ${shm.known} abgeschlossene Frames, ihre Seiten stehen unverändert im -wal, SQLite stellte nur ${committed} wieder her`);
    }
    result.olderCommit = lastCommits.reduce((max, commit) => Math.max(max, commit), 0);
    return result;
  } catch (error) {
    return { ...result, bytes: Math.max(result.bytes, 1), unreadable: error?.code ?? 'Fehler' };
  } finally {
    closeSync(fd);
  }
}

const walBytes = (path) => { try { return statSync(path).size; } catch { return 0; } };

/**
 * Erste Seite, die weder in der Hauptdatei noch als gültiger Frame im -wal
 * liegt — bis zur Datenbankgröße nach dem letzten Commit im -wal (sonst laut
 * Dateikopf). So bleibt der Normalfall offen (WAL-Modus: Hauptdatei kurz,
 * Rest im -wal; Absturz mitten im Checkpoint), eine auf eine Seitengrenze
 * abgeschnittene Kopie neben ihrem -wal aber nicht: SQLite schriebe das -wal
 * beim Schließen in die lückenhafte Datei und löschte es.
 */
function firstMissingPage(main, wal) {
  const mainPages = main.bytes / main.pageSize;
  const dbSize = wal.dbSize || main.headerPages || mainPages;
  // Die Seite mit dem Sperr-Byte bei 1 GiB legt SQLite nie an (PENDING_BYTE_PAGE).
  const lockPage = Math.floor(0x40000000 / main.pageSize) + 1;
  // höchstens wal.pages.size + 2 Schritte: jeder Schritt findet eine Lücke oder verbraucht eine Seite aus dem -wal
  for (let page = mainPages + 1; page <= dbSize; page += 1) if (page !== lockPage && !wal.pages.has(page)) return page;
  return null;
}

/**
 * Darf SQLite diese Datei öffnen? Nein bei einer ungültigen oder
 * unvollständigen Hauptdatei, bei fehlender oder leerer Hauptdatei mit nicht
 * leerem -wal daneben (SQLite löschte es), bei einem -wal, aus dem SQLite
 * abgeschlossene Transaktionen verwürfe (readWal), und bei einem Pfad, den
 * better-sqlite3 anders an SQLite gäbe (Leerraum am Rand wird dort gekürzt).
 * Nur fs, nichts wird angelegt oder verändert.
 *
 * @param {string} path
 * @returns {{ main: ReturnType<typeof inspectMainFile>, verdict: 'invalid-file' | 'orphaned-wal' | 'damaged-wal' | 'unsafe-path' | null, detail: string | null, target: string | null }}
 *   `target`: die Datei, die SQLite unter `path` öffnet (sqlitePath)
 */
export function openProblem(path) {
  // Ein gleichzeitiger Schreiber (Checkpoint, neue Datei) kann für einen
  // Augenblick eine Lücke vortäuschen. Ein Befund zählt deshalb nur, wenn er
  // auch bei drei weiteren Lesedurchgängen über rund 150 ms besteht — eine
  // abgeschnittene Kopie bleibt abgeschnitten.
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let result = examine(path);
  for (let attempt = 0; result.verdict && attempt < 3; attempt += 1) {
    Atomics.wait(pause, 0, 0, 50);
    result = examine(path);
  }
  return result;
}

/** Ein Lesedurchgang für openProblem. */
function examine(path) {
  // ohne Datei (SQLite: temporär bzw. im Speicher) — nichts zu prüfen, SQLite nennt dafür ''
  if (path === '' || path === ':memory:') return { main: { state: 'absent', bytes: 0 }, verdict: null, detail: null, target: '' };
  const unsafe = (reason, consequence) => ({ main: { state: 'invalid', bytes: 0, reason }, verdict: 'unsafe-path', detail: `${reason} — ${consequence}`, target: null });
  if (path !== path.trim()) return unsafe('Pfad beginnt oder endet mit Leerraum', 'better-sqlite3 kürzte ihn und öffnete eine andere Datei als geprüft');
  // Erst das -wal, dann die Hauptdatei: Ein Schreiber legt Seiten in der
  // Hauptdatei ab, bevor er sie aus dem -wal nimmt, und schreibt die erste
  // Seite einer neuen Datei, bevor ein -wal entsteht. Beide über denselben
  // aufgelösten Pfad wie SQLite (H-1).
  const target = sqlitePath(path);
  if (target === null) return unsafe('ein Verweis im Pfad zeigt auf ein Ziel, das kein gültiges UTF-8 ist', 'die geprüfte Datei wäre nicht sicher dieselbe, die SQLite öffnet');
  const wal = readWal(`${target}-wal`, `${target}-shm`);
  // ein -wal neben einem Verweis selbst nutzt SQLite nicht, verwaist ist es trotzdem
  const strayWal = target !== path && (() => { try { return statSync(`${path}-wal`).size > 0; } catch { return false; } })();
  const main = inspectMainFile(target);
  const found = (verdict, detail) => ({ main, verdict, detail, target });
  const invalid = (reason) => found('invalid-file', `keine gültige SQLite-Hauptdatei (${reason})`);
  if (main.state === 'invalid') return invalid(main.reason);
  if (main.state === 'absent' || main.state === 'empty') {
    if (wal.bytes > 0 || strayWal) return found('orphaned-wal', `Hauptdatei ${main.state === 'empty' ? 'ist leer' : 'fehlt'}, daneben liegt ein nicht leeres -wal`);
    return found(null, null);
  }
  if (wal.bytes > 0) {
    if (wal.indexUnreadable) return found('invalid-file', 'der WAL-Index (-shm) neben der Datei ist nicht lesbar (Rechte, Prozesslimit oder Zeitlimit) — ob SQLite abgeschlossene Transaktionen verwürfe, lässt sich nicht prüfen');
    if (wal.unreadable) return invalid(`-wal nicht lesbar (${wal.unreadable})`);
    const damaged = (reason) => found('damaged-wal', `${reason} — SQLite verwürfe abgeschlossene Transaktionen und löschte das -wal`);
    if (wal.damage) return damaged(wal.damage);
    if (wal.pageSize && wal.pageSize !== main.pageSize) return damaged(`-wal hat Seitengröße ${wal.pageSize}, die Hauptdatei ${main.pageSize}`);
    // Eine ältere Generation überspringt SQLite; harmlos nur, wenn sie ganz in
    // der Hauptdatei steht (Neustart des -wal erst nach vollständigem Checkpoint).
    const mainPages = main.bytes / main.pageSize;
    if (wal.olderCommit > mainPages) return damaged(`ältere -wal-Generation reicht bis Seite ${wal.olderCommit}, die Hauptdatei hat ${mainPages}`);
    const gap = firstMissingPage(main, wal);
    if (gap) return invalid(`Seite ${gap} fehlt in Hauptdatei und -wal — abgeschnitten?`);
  }
  return found(null, null);
}

/**
 * Wirft UNKNOWN_SCHEMA, bevor SQLite eine Datei öffnet, die es nicht öffnen darf (siehe openProblem).
 * @returns {ReturnType<typeof openProblem>} Ergebnis ohne Befund (mit `target`)
 */
export function assertOpenable(path) {
  const problem = openProblem(path);
  const { verdict, detail } = problem;
  if (verdict === 'invalid-file') {
    throw new MigrationError('UNKNOWN_SCHEMA', path, `${detail} — nicht geöffnet, Nebendateien unberührt; Datei bzw. Volume prüfen`);
  }
  if (verdict === 'damaged-wal') throw new MigrationError('UNKNOWN_SCHEMA', path, `${detail} — nicht geöffnet, Hauptdatei, -wal und -shm unberührt; vor jedem Blick mit SQLite (auch nur lesend) alle drei kopieren, dann Kopie bzw. Volume prüfen. Nach Stromausfall oder Host-Absturz (synchronous=NORMAL) können es nie synchronisierte letzte Transaktionen sein: eine Kopie mit SQLite lesend und schreibend öffnen, eine Abfrage ausführen (etwa PRAGMA integrity_check) und schließen übernimmt, was SQLite lesen kann (danach ist ihr -wal weg oder leer; nur öffnen und schließen oder nur lesend ändert nichts) — prüfen und nur bewusst zurückspielen`);
  if (verdict === 'unsafe-path') throw new MigrationError('UNKNOWN_SCHEMA', path, `${detail} — nicht geöffnet`);
  if (verdict) throw new MigrationError('UNKNOWN_SCHEMA', path, `${detail} (unvollständige Kopie oder Wiederherstellung?) — nichts geöffnet, nichts geschrieben`);
  return problem;
}

/**
 * Welche Datei hat SQLite selbst aufgelöst (PRAGMA database_list)? Direkt nach dem Öffnen: Die Pragma liest
 * nichts aus der Datei, legt kein -shm an, fasst kein -wal an. Weicht sie von der geprüften ab (H-1), wird
 * geschlossen, bevor SQLite eine Seite gelesen hat.
 */
function assertCheckedFile(db, path, target) {
  const opened = db.pragma('database_list').find(entry => entry.name === 'main')?.file;
  if (opened === target) return;
  db.close();
  throw new MigrationError('UNKNOWN_SCHEMA', path, 'SQLite öffnete eine andere Datei als geprüft (Symlink geändert?) — geschlossen, bevor SQLite eine Seite las; fehlte die Datei dort, hat SQLite sie leer angelegt');
}

/**
 * Öffnet die Datenbank.
 * - `apply`: für den Migrationslauf; legt Datei und Ordner bei Bedarf an.
 * - `app`: für Requests; die Datei muss existieren (wird nie still neu angelegt).
 * - `inspect`: nur lesen; setzt weder journal_mode noch foreign_keys.
 *
 * Vorher, in jedem Modus: unterstützte Node-Laufzeit (lib/db/runtime.mjs) und
 * eine Datei, die SQLite öffnen darf (assertOpenable) — sonst wird nichts
 * geöffnet. Danach, vor dem ersten Lesen: SQLite hat genau die geprüfte Datei
 * geöffnet (assertCheckedFile).
 *
 * busy_timeout kommt vor journal_mode: Mehrere Prozesse, die gleichzeitig eine
 * frische Datei öffnen, scheitern sonst mit SQLITE_BUSY beim Umschalten auf WAL.
 *
 * @param {string} path
 * @param {'apply' | 'app' | 'inspect'} mode
 * @returns {import('better-sqlite3').Database}
 */
export function openDatabase(path, mode) {
  assertSupportedRuntime();
  const { target } = assertOpenable(path);
  if (mode === 'inspect') {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    assertCheckedFile(db, path, target);
    db.pragma('busy_timeout = 8000');
    return db;
  }
  if (mode === 'apply') mkdirSync(dirname(path), { recursive: true });
  if (mode === 'app' && !existsSync(path)) {
    throw new MigrationError('DB_NOT_MIGRATED', path, 'Datenbankdatei fehlt — vor dem Start npm run db:migrate ausführen');
  }
  const db = new Database(path, { fileMustExist: mode === 'app' });
  assertCheckedFile(db, path, target);
  try {
    db.pragma('busy_timeout = 8000');
    enableWal(db);
    db.pragma('foreign_keys = ON');
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/**
 * WAL nur einschalten, wenn die Datei noch nicht im WAL-Modus ist. Öffnen
 * mehrere Prozesse gleichzeitig eine frische Datei, liefert SQLite beim
 * Umschalten SQLITE_BUSY, ohne den busy_timeout abzuwarten (Deadlock-Schutz) —
 * dann kurz warten und erneut prüfen, höchstens so lange wie busy_timeout.
 */
function enableWal(db) {
  const deadline = Date.now() + 8000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      if (db.pragma('journal_mode', { simple: true }) !== 'wal') db.pragma('journal_mode = WAL');
      return;
    } catch (error) {
      if (error?.code !== 'SQLITE_BUSY' || Date.now() > deadline) throw error;
      Atomics.wait(pause, 0, 0, 25);
    }
  }
}


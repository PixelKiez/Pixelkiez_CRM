/**
 * Eine Regel für Pfad und Verbindungsaufbau — für App, CLI und Tests.
 * Welche Sicherheitsregeln gelten, entscheidet lib/db/environment.mjs.
 */
import Database from 'better-sqlite3';
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readlinkSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { MigrationError } from './errors.mjs';
import { assertSupportedRuntime } from './runtime.mjs';

/** Pfad der CRM-Datenbank: SQLITE_PATH oder ./data/crm.db (wie bisher in lib/d1-node.ts). */
export function resolveDbPath(env = process.env, cwd = process.cwd()) {
  return env.SQLITE_PATH || resolve(cwd, 'data', 'crm.db');
}

const MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
const WAL_MAGIC = [0x377f0682, 0x377f0683];
const WAL_VERSION = 3007000;
const WAL_HEADER = 32;
const FRAME_HEADER = 24;

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
 * dort (os_unix.c, unixFullPathname): Abschnitt für Abschnitt, Symlinks per
 * readlink, „..“ gegen den schon aufgelösten (physischen) Pfad, höchstens 100
 * Verweise; ein fehlender Abschnitt wird unverändert angehängt. So zählt das
 * -wal neben dem echten Ziel, auch hinter Ordner-Symlinks und Verweisen ins Leere.
 */
function sqlitePath(path) {
  const pending = (isAbsolute(path) ? path : join(process.cwd(), path)).split(sep).filter(Boolean).reverse();
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
      if (lstatSync(next).isSymbolicLink()) target = readlinkSync(next);
    } catch { /* fehlt: so anhängen */ }
    if (target === null || links >= 100) {
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
 * walIndexRecover): gültiger Kopf mit Prüfsumme, dann Frames mit passendem
 * Salz und fortlaufender Prüfsumme bis zum ersten ungültigen; es zählen nur
 * Frames bis zum letzten Commit. Nur lesen.
 *
 * @returns {{ bytes: number, unreadable?: string, pageSize: number | null, pages: Set<number>, dbSize: number }}
 *   `dbSize`: Seitenzahl nach dem letzten Commit im -wal (0 = keiner)
 */
function readWal(path) {
  const result = { bytes: 0, pageSize: null, pages: new Set(), dbSize: 0 };
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    if (missing(error)) return result;
    return { ...result, bytes: 1, unreadable: error?.code ?? 'Fehler' };
  }
  try {
    result.bytes = fstatSync(fd).size;
    const head = Buffer.alloc(WAL_HEADER);
    if (result.bytes < WAL_HEADER || readSync(fd, head, 0, WAL_HEADER, 0) < WAL_HEADER) return result;
    const magic = head.readUInt32BE(0);
    const pageSize = head.readUInt32BE(8);
    if (!WAL_MAGIC.includes(magic) || head.readUInt32BE(4) !== WAL_VERSION || !validPageSize(pageSize)) return result;
    // Prüfsummen-Wörter: Bit 0 der Kennung = big-endian
    const word = magic & 1 ? 'readUInt32BE' : 'readUInt32LE';
    let sum = walChecksum(head.subarray(0, 24), [0, 0], word);
    if (sum[0] !== head.readUInt32BE(24) || sum[1] !== head.readUInt32BE(28)) return result;
    result.pageSize = pageSize;
    const salt = head.subarray(16, 24);
    const frame = Buffer.alloc(FRAME_HEADER + pageSize);
    const pending = [];
    for (let offset = WAL_HEADER; offset + frame.length <= result.bytes; offset += frame.length) {
      if (readSync(fd, frame, 0, frame.length, offset) < frame.length) break;
      const page = frame.readUInt32BE(0);
      if (page === 0 || !frame.subarray(8, 16).equals(salt)) break;
      sum = walChecksum(frame.subarray(FRAME_HEADER), walChecksum(frame.subarray(0, 8), sum, word), word);
      if (sum[0] !== frame.readUInt32BE(16) || sum[1] !== frame.readUInt32BE(20)) break;
      pending.push(page);
      const commit = frame.readUInt32BE(4);
      if (commit > 0) {
        for (const committed of pending) result.pages.add(committed);
        pending.length = 0;
        result.dbSize = commit;
      }
    }
    return result;
  } catch (error) {
    return { ...result, bytes: Math.max(result.bytes, 1), unreadable: error?.code ?? 'Fehler' };
  } finally {
    closeSync(fd);
  }
}

/** Prüfsumme des WAL-Formats über Paare von 32-Bit-Wörtern (wal.c, walChecksumBytes). */
function walChecksum(data, [s1, s2], word) {
  for (let i = 0; i < data.length; i += 8) {
    s1 = (s1 + data[word](i) + s2) >>> 0;
    s2 = (s2 + data[word](i + 4) + s1) >>> 0;
  }
  return [s1, s2];
}

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
 * unvollständigen Hauptdatei und bei fehlender oder leerer Hauptdatei mit
 * nicht leerem -wal daneben (SQLite löschte es). Nur fs, nichts wird angelegt
 * oder verändert.
 *
 * @param {string} path
 * @returns {{ main: ReturnType<typeof inspectMainFile>, verdict: 'invalid-file' | 'orphaned-wal' | null, detail: string | null }}
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
  // Erst das -wal, dann die Hauptdatei: Ein Schreiber legt Seiten in der
  // Hauptdatei ab, bevor er sie aus dem -wal nimmt, und schreibt die erste
  // Seite einer neuen Datei, bevor ein -wal entsteht.
  const target = sqlitePath(path);
  const wal = readWal(`${target}-wal`);
  // ein -wal neben einem Verweis selbst nutzt SQLite nicht, verwaist ist es trotzdem
  const strayWal = target !== path && (() => { try { return statSync(`${path}-wal`).size > 0; } catch { return false; } })();
  const main = inspectMainFile(path);
  const invalid = (reason) => ({ main, verdict: 'invalid-file', detail: `keine gültige SQLite-Hauptdatei (${reason})` });
  if (main.state === 'invalid') return invalid(main.reason);
  if (main.state === 'absent' || main.state === 'empty') {
    if (wal.bytes > 0 || strayWal) {
      return { main, verdict: 'orphaned-wal', detail: `Hauptdatei ${main.state === 'empty' ? 'ist leer' : 'fehlt'}, daneben liegt ein nicht leeres -wal` };
    }
    return { main, verdict: null, detail: null };
  }
  if (wal.bytes > 0) {
    if (wal.unreadable) return invalid(`-wal nicht lesbar (${wal.unreadable})`);
    if (wal.dbSize && wal.pageSize !== main.pageSize) return invalid(`-wal hat Seitengröße ${wal.pageSize}, die Hauptdatei ${main.pageSize}`);
    const gap = firstMissingPage(main, wal);
    if (gap) return invalid(`Seite ${gap} fehlt in Hauptdatei und -wal — abgeschnitten?`);
  }
  return { main, verdict: null, detail: null };
}

/** Wirft UNKNOWN_SCHEMA, bevor SQLite eine Datei öffnet, die es nicht öffnen darf (siehe openProblem). */
export function assertOpenable(path) {
  const { main, verdict, detail } = openProblem(path);
  if (verdict === 'invalid-file') {
    throw new MigrationError('UNKNOWN_SCHEMA', path, `${detail} — nicht geöffnet, Nebendateien unberührt; Datei bzw. Volume prüfen`);
  }
  if (verdict) throw new MigrationError('UNKNOWN_SCHEMA', path, `${detail} (unvollständige Kopie oder Wiederherstellung?) — nichts geöffnet, nichts geschrieben`);
  return main;
}

/**
 * Öffnet die Datenbank.
 * - `apply`: für den Migrationslauf; legt Datei und Ordner bei Bedarf an.
 * - `app`: für Requests; die Datei muss existieren (wird nie still neu angelegt).
 * - `inspect`: nur lesen; setzt weder journal_mode noch foreign_keys.
 *
 * Vorher, in jedem Modus: unterstützte Node-Laufzeit (lib/db/runtime.mjs) und
 * eine Datei, die SQLite öffnen darf (assertOpenable) — sonst wird nichts geöffnet.
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
  assertOpenable(path);
  if (mode === 'inspect') {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 8000');
    return db;
  }
  if (mode === 'apply') mkdirSync(dirname(path), { recursive: true });
  if (mode === 'app' && !existsSync(path)) {
    throw new MigrationError('DB_NOT_MIGRATED', path, 'Datenbankdatei fehlt — vor dem Start npm run db:migrate ausführen');
  }
  const db = new Database(path, { fileMustExist: mode === 'app' });
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


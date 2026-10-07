/**
 * WAL-Index (-shm) und Prüfsumme des WAL-Formats für die Vorprüfung in
 * lib/db/open.mjs (H-2). Nur lesen, nichts anlegen oder verändern.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { endianness } from 'node:os';

/** Kopf des WAL-Index im -shm (WalIndexHdr), zweimal hintereinander. */
const WAL_INDEX_HEADER = 48;
/** WALINDEX_MAX_VERSION in wal.c. */
const WAL_INDEX_VERSION = 3007000;

/**
 * Kindprozess: die ersten 96 Byte einer regulären Datei als Hex, sonst „-“ (auch, wenn sie inzwischen
 * fehlt: die letzte Verbindung schloss und löschte sie); jeder andere Lesefehler endet mit Exit 1.
 */
const READ_INDEX = "const fs=require('fs');const p=process.argv[1];let o='-';try{if(fs.statSync(p).isFile()){const fd=fs.openSync(p,'r');const b=Buffer.alloc(96);if(fs.readSync(fd,b,0,96,0)===96)o=b.toString('hex');fs.closeSync(fd)}}catch(e){if(e.code!=='ENOENT')throw e}process.stdout.write(o)";

/**
 * Beide Kopien des WAL-Index-Kopfs aus dem -shm, nur lesend, in einem eigenen
 * Prozess: Schlösse dieser Prozess einen Deskriptor des -shm, gäbe POSIX alle
 * seine fcntl-Sperren darauf frei, auch die DMS-Sperre einer hier offenen
 * SQLite-Verbindung (ein anderer Prozess hielte sich für den ersten).
 * @returns {Buffer | null | undefined} null: kein -shm (mehr), keine reguläre
 *   Datei oder kürzer als die Köpfe (so lässt SQLite es nach dem Kürzen beim ersten Öffnen);
 *   undefined: nicht lesbar (Lesefehler, Start des Kindprozesses, Zeitlimit, Signal)
 */
export function readIndexHeader(path) {
  if (!existsSync(path)) return null;
  const child = spawnSync(process.execPath, ['-e', READ_INDEX, path], { encoding: 'utf8', env: {}, timeout: 5000 });
  if (child.status === 0 && child.stdout === '-') return null;
  return child.status === 0 && child.stdout.length === 4 * WAL_INDEX_HEADER ? Buffer.from(child.stdout, 'hex') : undefined;
}

/**
 * Was der WAL-Index-Kopf belegt, geprüft wie walIndexTryHdr: zwei gleiche
 * Kopien, initialisiert, Prüfsumme (Bytereihenfolge dieser Maschine), Version
 * und dasselbe Salz wie der -wal-Kopf.
 * @param {Buffer | null} both readIndexHeader
 * @param {Buffer} salt Salz aus dem -wal-Kopf
 * @returns {{ known: number, written: boolean, sum: [number, number] } | null} mxFrame;
 *   ob seit dem letzten Neuaufbau (walIndexRecover: iChange 0) ein Schreiber
 *   abgeschlossen hat; aFrameCksum, die Prüfsumme nach Frame mxFrame. null ohne
 *   gültigen, zu diesem -wal passenden Index.
 */
export function walIndexEnd(both, salt) {
  if (!both) return null;
  const header = both.subarray(0, WAL_INDEX_HEADER);
  if (!header.equals(both.subarray(WAL_INDEX_HEADER)) || header[12] === 0) return null;
  const word = endianness() === 'LE' ? 'readUInt32LE' : 'readUInt32BE';
  const sum = walChecksum(header.subarray(0, 40), [0, 0], word);
  if (sum[0] !== header[word](40) || sum[1] !== header[word](44)) return null;
  if (header[word](0) !== WAL_INDEX_VERSION || !header.subarray(32, 40).equals(salt)) return null;
  return { known: header[word](16), written: header[word](8) !== 0, sum: [header[word](24), header[word](28)] };
}

/** Prüfsumme des WAL-Formats über Paare von 32-Bit-Wörtern (wal.c, walChecksumBytes). */
export function walChecksum(data, [s1, s2], word) {
  for (let i = 0; i < data.length; i += 8) {
    s1 = (s1 + data[word](i) + s2) >>> 0;
    s2 = (s2 + data[word](i + 4) + s1) >>> 0;
  }
  return [s1, s2];
}

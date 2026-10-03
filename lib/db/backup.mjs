/**
 * Geprüfte Sicherung vor dem ersten Schreibzugriff einer Migration.
 *
 * better-sqlite3 db.backup() kopiert seitenweise und WAL-konsistent im
 * laufenden Betrieb. Die Kopie wird anschließend geöffnet und geprüft
 * (integrity_check, Schema-Fingerabdruck, Inhalts-Digest). Schlägt irgendein
 * Schritt fehl, schreibt die Migration nichts.
 *
 * Sicherungen enthalten users.google_tokens (OAuth-Zugänge) und sind wie
 * Geheimnisse zu behandeln: Ordner 0700, Datei 0600. Der Runner löscht nie
 * Sicherungen; Aufbewahrung und Ablage außerhalb des Volumes entscheidet ein
 * Mensch. Eine Kopie, deren Prüfung scheitert, wird in *.unverified
 * umbenannt — jede Datei pre-*.db ist also geprüft.
 */
import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { MigrationError } from './errors.mjs';
import { contentDigest, fingerprint, sameFingerprint, stableStringify } from './fingerprint.mjs';

const fileSize = (path) => (existsSync(path) ? statSync(path).size : 0);
const compactUtc = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ dir: string, label: string, digest: object, now?: Date, token?: string,
 *   statfs?: typeof statfsSync, afterCopy?: (path: string) => void }} options
 *   `token` macht den Dateinamen eindeutig (Standard: PID und Zufall), damit
 *   parallele Läufe nie dieselbe Datei beschreiben; `statfs` und `afterCopy`
 *   nur für Tests.
 * @returns {Promise<{ path: string, sha256: string, bytes: number }>}
 */
export async function backupVerified(db, {
  dir,
  label,
  digest,
  now = new Date(),
  token = `${process.pid}-${randomBytes(3).toString('hex')}`,
  statfs = statfsSync,
  afterCopy = () => {},
}) {
  const source = db.name;
  if (!source || source === ':memory:') throw new MigrationError('BACKUP_FAILED', String(source), 'Datenbank hat keine Datei');
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new MigrationError('BACKUP_FAILED', dir, `Sicherungsordner nicht anlegbar (${error.code ?? error.message})`);
  }
  const needed = 2 * (fileSize(source) + fileSize(`${source}-wal`));
  let free;
  try {
    const stats = statfs(dir);
    free = Number(stats.bavail) * Number(stats.bsize);
  } catch (error) {
    throw new MigrationError('BACKUP_FAILED', dir, `freier Speicher nicht ermittelbar (${error.code ?? error.message})`);
  }
  if (free < needed) throw new MigrationError('BACKUP_FAILED', dir, `zu wenig freier Speicher (${free} < ${needed} Bytes)`);

  // Exklusiv anlegen (0600): existiert die Datei schon, wird sie nie überschrieben.
  const path = join(dir, `pre-${label}-${compactUtc(now)}-${token}.db`);
  try {
    closeSync(openSync(path, 'wx', 0o600));
  } catch (error) {
    const reason = error.code === 'EEXIST' ? 'Sicherungsdatei existiert bereits' : `Sicherungsdatei nicht anlegbar (${error.code ?? error.message})`;
    throw new MigrationError('BACKUP_FAILED', path, reason);
  }
  try {
    await db.backup(path);
  } catch (error) {
    throw unverified(path, `Sicherung fehlgeschlagen (${error.message})`);
  }

  let copy;
  try {
    afterCopy(path);
    copy = new Database(path, { fileMustExist: true });
    copy.pragma('journal_mode = DELETE');
    const integrity = copy.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`integrity_check: ${integrity}`);
    if (!sameFingerprint(fingerprint(copy), fingerprint(db))) throw new Error('Schema der Kopie weicht ab');
    if (stableStringify(contentDigest(copy)) !== stableStringify(digest)) throw new Error('Inhalt der Kopie weicht ab');
  } catch (error) {
    try { copy?.close(); } catch { /* Fehler unten melden */ }
    copy = null;
    throw unverified(path, `Prüfung der Sicherung fehlgeschlagen (${error.message})`);
  } finally {
    copy?.close();
  }
  const bytes = statSync(path).size;
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  return { path, sha256, bytes };
}

/** Ungeprüfte Kopie umbenennen (nie löschen) und den Fehler melden. */
function unverified(path, detail) {
  let note = '';
  try {
    renameSync(path, `${path}.unverified`);
    note = ' — Kopie als .unverified abgelegt';
  } catch { /* Umbenennen ist nur Kennzeichnung */ }
  return new MigrationError('BACKUP_FAILED', path, `${detail}${note}`);
}

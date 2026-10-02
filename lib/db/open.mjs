/**
 * Eine Regel für Pfad, Umgebung und Verbindungsaufbau — für App, CLI und Tests.
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { MigrationError } from './errors.mjs';

/** Pfad der CRM-Datenbank: SQLITE_PATH oder ./data/crm.db (wie bisher in lib/d1-node.ts). */
export function resolveDbPath(env = process.env, cwd = process.cwd()) {
  return env.SQLITE_PATH || resolve(cwd, 'data', 'crm.db');
}

/**
 * Produktion erkennen: NODE_ENV=production. railway.json baut mit NIXPACKS,
 * dessen Node-Provider NODE_ENV=production als Umgebungsvariable des Images
 * setzt (Nixpacks-Doku, Node-Provider). Achtung: `next start` setzt NODE_ENV
 * nur für den eigenen Prozess — der Pre-Start-Schritt sieht ausschließlich die
 * echte Umgebung. Bericht und Lauf geben deshalb `mode=` aus; vor Release B
 * muss der Release-A-Bericht in Produktion mode=production zeigen.
 */
export function isProductionEnv(env = process.env) {
  return env.NODE_ENV === 'production';
}

/**
 * Öffnet die Datenbank.
 * - `apply`: für den Migrationslauf; legt Datei und Ordner bei Bedarf an.
 * - `app`: für Requests; die Datei muss existieren (wird nie still neu angelegt).
 * - `inspect`: nur lesen; setzt weder journal_mode noch foreign_keys.
 *
 * busy_timeout kommt vor journal_mode: Mehrere Prozesse, die gleichzeitig eine
 * frische Datei öffnen, scheitern sonst mit SQLITE_BUSY beim Umschalten auf WAL.
 *
 * @param {string} path
 * @param {'apply' | 'app' | 'inspect'} mode
 * @returns {import('better-sqlite3').Database}
 */
export function openDatabase(path, mode) {
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


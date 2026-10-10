/**
 * Arbeitsbereich des AC3-Prüfstands (scripts/db-verify-copy.mjs): anlegen und
 * nachweislich löschen (M-4, M-1). Nur Dateisystem, keine Ausgabe.
 *
 * Nachgewiesen gelöscht heißt (M-1): Vorher stehen alle festgehaltenen Ordner
 * (der Ordner über dem obersten angelegten, jeder angelegte Ordner bis
 * <workdir>, ac3-XXXXXX) noch an ihrem Pfad und sind dieselben wie beim Anlegen
 * (Gerät/Inode); gelöscht wird ohne `force` (fehlt der Ordner inzwischen, ist
 * das ein Fehler); danach meldet lstat ENOENT und der Ordner darüber ist noch
 * derselbe. Ein unerreichbarer, verschobener oder ersetzter Ordner zählt nie
 * als gelöscht, und ein fremder Ordner an derselben Stelle wird nie gelöscht.
 * Der Ordner darüber darf ein Symlink sein (macOS: /tmp) — er wird verfolgt;
 * die selbst angelegten Ordner müssen echte Ordner sein.
 */
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';

/**
 * Arbeitsbereich <workdir>/ac3-XXXXXX (mkdtemp, 0700). Fehlt <workdir>, legt der Prüfstand es an
 * und merkt sich den obersten neuen Ordner; jeder Schritt steht sofort in run.scratch.
 * Jeder angelegte Ordner und der Ordner darüber werden festgehalten (pin).
 */
export function createScratch(run, workdir) {
  run.scratch = { workdir, created: null, root: null, ids: new Map() };
  run.scratch.created = mkdirSync(workdir, { recursive: true, mode: 0o700 }) ?? null;
  pin(run.scratch, run.scratch.created ? dirname(run.scratch.created) : workdir, true);
  // jeder angelegte Ordner vom obersten bis <workdir> (kein Zwischenordner darf ersetzt werden)
  if (run.scratch.created) {
    for (let dir = workdir; ; dir = dirname(dir)) {
      pin(run.scratch, dir);
      if (dir === run.scratch.created || dir === dirname(dir)) break;
    }
  }
  chmodSync(workdir, 0o700);
  run.scratch.root = mkdtempSync(join(workdir, 'ac3-'));
  pin(run.scratch, run.scratch.root);
  return run.scratch.root;
}

/** Gerät und Inode eines Ordners festhalten (`follow`: ein Symlink dorthin zählt als der Ordner). */
function pin(scratch, dir, follow = false) {
  const { dev, ino } = (follow ? statSync : lstatSync)(dir, { bigint: true });
  scratch.ids.set(dir, { dev, ino, follow });
}

/** Ist `dir` noch der festgehaltene Ordner? Nicht erreichbar oder ersetzt: nein (Fehler werden geworfen). */
function samePinned(scratch, dir) {
  const id = scratch.ids.get(dir);
  if (!id) return false;
  const stats = (id.follow ? statSync : lstatSync)(dir, { bigint: true });
  return stats.isDirectory() && stats.dev === id.dev && stats.ino === id.ino;
}

/** Nachweislich fehlt: nur ENOENT. Kein Zugriff, kein Ordner im Pfad o. ä. ist kein Nachweis (wirft). */
function absent(path) {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

const isWithin = (path, dir) => {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/**
 * Löscht den Arbeitsbereich und weist nach, dass nichts übrig ist. Liegt die
 * Quelle (aufgelöst) im zu löschenden Ordner, wird nichts gelöscht und das
 * Aufräumen gilt als gescheitert. Erst aufrufen, wenn kein Migrationsschritt mehr läuft.
 * @param {{ workdir: string, created: string | null, root: string | null, ids: Map<string, { dev: bigint, ino: bigint, follow: boolean }> } | null} scratch
 * @param {string | null} source aufgelöster Pfad der Quelle
 * @returns {boolean} true = nachweislich nichts übrig
 */
export function removeScratch(scratch, source) {
  const target = scratch && (scratch.created ?? scratch.root);
  // ohne angelegten Ordner gab es nie Klartext (ein vorhandenes <workdir> war beim Start leer)
  if (!target) return true;
  const parent = scratch.created ? dirname(scratch.created) : scratch.workdir;
  try {
    // jeder festgehaltene Ordner steht noch an seinem Pfad (ac3-XXXXXX nicht verschoben oder ersetzt)
    for (const dir of scratch.ids.keys()) if (!samePinned(scratch, dir)) return false;
    if (!source || isWithin(source, realpathSync(target))) return false;
    rmSync(target, { recursive: true, maxRetries: 2 });
    if (!absent(target) || !samePinned(scratch, parent)) return false;
    // ein angelegtes <workdir> samt ac3-XXXXXX ist mit target gelöscht, ein vorhandenes wieder leer
    return Boolean(scratch.created) || readdirSync(scratch.workdir).length === 0;
  } catch {
    return false;
  }
}

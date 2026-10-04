/**
 * Unterstützte Node-Laufzeit (PXK-113): Node >=22.14.0 <23 mit Node-API >= 10
 * — wie "engines" in package.json.
 *
 * better-sqlite3 13 stürzt unter Node 22.13 (Node-API 9) beim Laden seiner
 * nativen Binary mit SIGSEGV ab: ohne Meldung und ohne Exit-Code. Deshalb wird
 * die Laufzeit geprüft, bevor better-sqlite3 eine Datenbank öffnet — in
 * Skripten als erster Import (lib/db/runtime-gate.mjs), in der App in
 * openDatabase (lib/db/open.mjs). Geprüft werden Node-Version und Node-API;
 * ausgegeben werden nur diese beiden Versionsangaben.
 *
 * Keine Abhängigkeiten außer errors.mjs, damit die Prüfung vor allem anderen laufen kann.
 */
import { MigrationError } from './errors.mjs';

export const SUPPORTED_NODE = '>=22.14.0 <23';
export const MIN_NODE_API = 10;

/** Version nur mit harmlosen Zeichen ausgeben. */
const shown = (value) => String(value ?? 'unbekannt').replace(/[^0-9A-Za-z.+-]/g, '?').slice(0, 32);

/**
 * @param {{ node?: string, napi?: string }} [versions] Standard: process.versions
 * @returns {string | null} Grund, warum diese Laufzeit nicht unterstützt wird, sonst null
 */
export function runtimeProblem(versions = process.versions) {
  // Nur Release-Versionen X.Y.Z; Vorab- und Nightly-Stände (z. B. 22.14.0-pre) gelten als nicht unterstützt.
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(versions.node ?? ''));
  const major = match ? Number(match[1]) : NaN;
  const minor = match ? Number(match[2]) : NaN;
  const napi = /^\d+$/.test(String(versions.napi ?? '')) ? Number(versions.napi) : NaN;
  if (major === 22 && minor >= 14 && napi >= MIN_NODE_API) return null;
  return `Node v${shown(versions.node)} (Node-API ${shown(versions.napi)}) wird nicht unterstützt — erforderlich: Node ${SUPPORTED_NODE} mit Node-API >= ${MIN_NODE_API} (better-sqlite3 13); nichts geöffnet, nichts geschrieben`;
}

/** Wirft UNSUPPORTED_RUNTIME, bevor better-sqlite3 benutzt wird. */
export function assertSupportedRuntime(versions = process.versions) {
  const problem = runtimeProblem(versions);
  if (problem) throw new MigrationError('UNSUPPORTED_RUNTIME', 'node', problem);
}

/**
 * Erster Import der Skripte (scripts/db-migrate.mjs, scripts/db-verify-copy.mjs):
 * Läuft Node außerhalb des unterstützten Bereichs (lib/db/runtime.mjs), endet
 * der Prozess hier mit klarer Meldung und Exit 17 — bevor ein späterer Import
 * better-sqlite3 lädt. ES-Module werden in Importreihenfolge ausgewertet.
 */
import { EXIT_CODES } from './errors.mjs';
import { runtimeProblem } from './runtime.mjs';

const problem = runtimeProblem();
if (problem) {
  process.stderr.write(`PXK-DB [UNSUPPORTED_RUNTIME] node: ${problem}\n`);
  process.exit(EXIT_CODES.UNSUPPORTED_RUNTIME);
}

/**
 * Nur lesender Bericht über eine Datenbank (für die Release-A-Prüfung).
 * Öffnet die Datei schreibgeschützt und setzt keine PRAGMAs außer busy_timeout.
 * Ausgabe: Einordnung, Ledger, Fingerabdruck-Hashes, integrity_check, je
 * Tabelle Zeilenzahl und ein 16-stelliger Digest — nie Zeileninhalte.
 */
import { existsSync, statSync } from 'node:fs';
import { checkLedger, classify, createReferences, loadMigrations } from './migrate.mjs';
import { contentDigest, fingerprint } from './fingerprint.mjs';
import { openDatabase } from './open.mjs';
import { MigrationError } from './errors.mjs';

/**
 * @param {{ dbPath: string, migrationsDir?: string, mode?: string, modeReason?: string, pathSource?: string }} options
 *   `mode` (production/development) mit `modeReason` (die Signale aus
 *   lib/db/environment.mjs) und `pathSource` (SQLITE_PATH/default) zeigen,
 *   welche Regeln ein Lauf in dieser Umgebung anwenden würde.
 * @returns {{ ok: boolean, verdict: string, lines: string[] }}
 */
export function buildReport({ dbPath, migrationsDir, mode, modeReason, pathSource }) {
  const lines = [];
  const add = (key, value) => lines.push(`PXK-DB report ${key}=${value}`);
  let verdict = 'error';
  let ok = false;
  let db;
  if (mode) add('mode', mode);
  if (modeReason) add('mode_reason', modeReason);
  if (pathSource) add('sqlite_path', `${pathSource} ${dbPath}`);
  try {
    if (!existsSync(dbPath)) {
      add('file', 'absent');
      add('verdict', 'absent');
      return { ok: true, verdict: 'absent', lines };
    }
    add('file', `present bytes=${statSync(dbPath).size}`);
    const set = loadMigrations(migrationsDir);
    add('migration_files', `${set.migrations.length} (letzte ${set.migrations[set.migrations.length - 1].name})`);
    const refs = createReferences(set);
    db = openDatabase(dbPath, 'inspect');
    add('user_version', db.pragma('user_version', { simple: true }));
    const integrity = db.pragma('integrity_check', { simple: true });
    add('integrity_check', integrity === 'ok' ? 'ok' : 'FEHLER');
    const state = classify(db, set, refs);
    add('class', state.kind + (state.variant ? ` ${state.variant}` : ''));
    if (state.kind === 'UNKNOWN') {
      add('unknown_reason', state.reason ?? '-');
      if (state.nearest) add('nearest_variant', state.nearest);
      for (const difference of state.differences ?? []) add('difference', difference);
    }
    const fp = fingerprint(db);
    add('fingerprint', `structural=${fp.hashes.structural.slice(0, 16)} text=${fp.hashes.text.slice(0, 16)}`);
    for (const [table, info] of Object.entries(contentDigest(db))) add(`table.${table}`, `rows=${info.rows} digest=${info.sha256.slice(0, 16)}`);

    if (state.kind === 'MIGRATED') {
      try {
        const { head, rows } = checkLedger(db, set, { full: true, refs });
        for (const row of rows) add('ledger', `${row.version} ${row.name} ${row.kind}${row.legacy_variant ? ` ${row.legacy_variant}` : ''}`);
        verdict = head === set.migrations.length ? 'migrated-current' : `migrations-pending ${set.migrations.length - head}`;
      } catch (error) {
        if (!(error instanceof MigrationError)) throw error;
        add('ledger_error', `${error.code} ${error.detail}`);
        verdict = 'ledger-invalid';
      }
    } else if (state.kind === 'LEGACY_EXACT') {
      verdict = state.variant === 'S5' ? 'legacy-current-adoptable' : `legacy-outdated-${state.variant}-opt-in-required`;
    } else if (state.kind === 'EMPTY') {
      verdict = 'empty';
    } else {
      verdict = 'unknown-schema';
    }
    ok = integrity === 'ok' && !['unknown-schema', 'ledger-invalid'].includes(verdict);
  } catch (error) {
    add('error', error instanceof MigrationError ? `${error.code} ${error.detail}` : `REPORT_ERROR ${error.message}`);
    verdict = 'error';
    ok = false;
  } finally {
    try { db?.close(); } catch { /* Bericht darf nie scheitern */ }
  }
  add('verdict', verdict);
  return { ok, verdict, lines };
}

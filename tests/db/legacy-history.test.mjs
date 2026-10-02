import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { classify, createReferences, loadMigrations } from '../../lib/db/migrate.mjs';
import { MIGRATIONS_DIR, ROOT } from './helpers.mjs';

/**
 * Prüft die Altstände S1–S5 unabhängig von lib/db/legacy.mjs: Die Fixture
 * enthält das DDL, das ensureDatabase() des jeweiligen Releases tatsächlich
 * ausgeführt hat (aus der git-Historie extrahiert).
 */
const { releases } = JSON.parse(readFileSync(join(ROOT, 'tests/db/fixtures/legacy-history.json'), 'utf8'));
const set = loadMigrations(MIGRATIONS_DIR);
const refs = createReferences(set);

/** Wie ensureDatabase() des Releases: CREATE … IF NOT EXISTS, dann fehlende Spalten per ALTER. */
function boot(db, release) {
  for (const sql of release.creates) db.exec(sql);
  for (const [table, column, definition] of release.columns) {
    if (!db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}

test('Fixture deckt jedes Release seit der Railway-Portierung ab', () => {
  assert.deepEqual(releases.map(r => r.variant), ['S1', 'S2', 'S3', 'S4', 'S5']);
  assert.deepEqual(releases.flatMap(r => r.commits), ['0a0c430', 'c759b67', 'b8a8f0d', 'db260fe', '48b7333', 'cd2c098']);
});

test('jedes Release erzeugt auf leerer Datei genau seinen Altstand', () => {
  for (const release of releases) {
    const db = new Database(':memory:');
    boot(db, release);
    assert.deepEqual(classify(db, set, refs), { kind: 'LEGACY_EXACT', variant: release.variant }, release.commits.join('/'));
    db.close();
  }
});

test('jeder Upgrade-Pfad über spätere Releases ergibt den Altstand des zuletzt gestarteten', () => {
  for (let from = 0; from < releases.length; from += 1) {
    for (let to = from; to < releases.length; to += 1) {
      const db = new Database(':memory:');
      for (const release of releases.slice(from, to + 1)) boot(db, release);
      const path = `${releases[from].variant}→${releases[to].variant}`;
      assert.deepEqual(classify(db, set, refs), { kind: 'LEGACY_EXACT', variant: releases[to].variant }, path);
      db.close();
    }
  }
});

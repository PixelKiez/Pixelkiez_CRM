import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { contentDigest, tableColumns } from '../../lib/db/fingerprint.mjs';
import { runMigrations } from '../../lib/db/migrate.mjs';
import { openDatabase } from '../../lib/db/open.mjs';
import { runSeeds } from '../../lib/db/seed.mjs';
import { DOCUMENT_TEMPLATES, SEED_TEMPLATES } from '../../lib/db/seed-templates.mjs';
import { MIGRATIONS_DIR, ROOT, errorCode, tempDir } from './helpers.mjs';

/**
 * Eingefrorene Prüfsummen aus dem echten cd2c098-Code:
 * - Vorlagen: JSON von [slug, name, kind, subject, body_html] der 8 Vorlagen in
 *   Einfügereihenfolge, per TypeScript-AST aus `git show cd2c098:lib/database.ts`.
 * - Seed-Inhalt: contentDigest() ohne updated_at einer Datenbank, die
 *   ensureDatabase() von cd2c098 befüllt hat.
 */
const TEMPLATES_SHA256 = '6b0fa3069a2479c03e90a6d9d9ca10c26dd1f4b3e8c9ebd75c550919889ad069';
const CD2C098_SEED_DIGEST = {
  email_templates: { rows: 8, sha256: '121af92c0151b5ba6677c8d50e695ddf1ad5bf012b6ba57810872f45b66ea8d5' },
  leads: { rows: 952, sha256: '8a5af0d6451ddca945422f0719b7029f42974a1b05f6c452bebe439fa60e9b62' },
};

const migrated = async () => {
  const db = openDatabase(join(tempDir(), 'crm.db'), 'apply');
  await runMigrations(db, { migrationsDir: MIGRATIONS_DIR });
  return db;
};
const withoutUpdatedAt = (db) => {
  const columns = tableColumns(db);
  return {
    email_templates: columns.email_templates.filter(c => c !== 'updated_at'),
    leads: columns.leads.filter(c => c !== 'updated_at'),
  };
};

test('Vorlagen sind unverändert aus cd2c098 übernommen', () => {
  const list = [...SEED_TEMPLATES, ...DOCUMENT_TEMPLATES].map(t => [t.slug, t.name, t.kind, t.subject, t.body_html]);
  assert.equal(createHash('sha256').update(JSON.stringify(list)).digest('hex'), TEMPLATES_SHA256);
});

test('Seeds schreiben dieselben Zeilen wie cd2c098 (ohne updated_at)', async () => {
  const db = await migrated();
  assert.deepEqual(runSeeds(db), { templatesInserted: 8, leadsInserted: 952 });
  assert.deepEqual(contentDigest(db, withoutUpdatedAt(db)), CD2C098_SEED_DIGEST);
  db.close();
});

test('Seed-Wiederholung: keine Duplikate, bearbeitete Vorlage bleibt, gelöschter Standard-Slug kehrt zurück', async () => {
  const db = await migrated();
  runSeeds(db);
  db.prepare("UPDATE email_templates SET subject = 'selbst bearbeitet' WHERE slug = 'angebot'").run();
  const before = contentDigest(db);
  assert.deepEqual(runSeeds(db), { templatesInserted: 0, leadsInserted: 0 });
  assert.deepEqual(contentDigest(db), before);
  assert.equal(db.prepare("SELECT subject FROM email_templates WHERE slug = 'angebot'").get().subject, 'selbst bearbeitet');
  db.prepare("DELETE FROM email_templates WHERE slug = 'nachfassen'").run();
  assert.deepEqual(runSeeds(db), { templatesInserted: 1, leadsInserted: 0 });
  assert.equal(db.prepare('SELECT count(*) AS c FROM email_templates').get().c, 8);
  db.close();
});

test('Lead-Seed nur bei leerer Tabelle', async () => {
  const db = await migrated();
  db.prepare("INSERT INTO leads (id, name, updated_at) VALUES ('PK-T1', 'Testfirma', '2026-10-02T00:00:00.000Z')").run();
  assert.deepEqual(runSeeds(db), { templatesInserted: 8, leadsInserted: 0 });
  assert.equal(db.prepare('SELECT count(*) AS c FROM leads').get().c, 1);
  db.close();
});

test('fehlende Lead-Quelle ist nur bei leerer Tabelle ein Fehler (SEED_SOURCE_MISSING) — gelesen wird vor jedem Schreibzugriff', async () => {
  const db = await migrated();
  const missing = join(tempDir(), 'fehlt.json');
  const error = await errorCode(() => runSeeds(db, { leadsJson: missing }));
  assert.equal(error?.code, 'SEED_SOURCE_MISSING');
  assert.equal(db.prepare('SELECT count(*) AS c FROM leads').get().c, 0);
  assert.equal(db.prepare('SELECT count(*) AS c FROM email_templates').get().c, 0, 'auch keine Vorlagen: der Lauf scheitert, bevor er schreibt');
  db.prepare("INSERT INTO leads (id, name, updated_at) VALUES ('PK-T1', 'Testfirma', '2026-10-02T00:00:00.000Z')").run();
  assert.deepEqual(runSeeds(db, { leadsJson: missing }), { templatesInserted: 8, leadsInserted: 0 });
  db.close();
});

test('Lead-Seed scheitert mittendrin (doppelte id an Position 501) → SEED_FAILED, 0 Leads', async () => {
  const db = await migrated();
  const leads = JSON.parse(readFileSync(join(ROOT, 'db/seeds/leads.json'), 'utf8'));
  const broken = [...leads.slice(0, 500), leads[0], ...leads.slice(500)];
  const path = join(tempDir(), 'leads-kaputt.json');
  writeFileSync(path, JSON.stringify(broken));
  const error = await errorCode(() => runSeeds(db, { leadsJson: path }));
  assert.equal(error?.code, 'SEED_FAILED');
  assert.equal(error.exitCode, 16);
  assert.match(error.message, /\[SEED_FAILED\] leads: .*UNIQUE/);
  assert.equal(db.prepare('SELECT count(*) AS c FROM leads').get().c, 0, 'keine halben Startdaten');
  db.close();
});

test('Vorlagen-Seed scheitert bei der fünften Vorlage → SEED_FAILED, keine Vorlage angelegt', async () => {
  const db = await migrated();
  const fifth = [...SEED_TEMPLATES, ...DOCUMENT_TEMPLATES][4].slug;
  db.exec(`CREATE TEMP TRIGGER stop_seed BEFORE INSERT ON email_templates WHEN NEW.slug = '${fifth}' BEGIN SELECT RAISE(ABORT, 'Testabbruch'); END`);
  const error = await errorCode(() => runSeeds(db));
  assert.equal(error?.code, 'SEED_FAILED');
  assert.match(error.message, /\[SEED_FAILED\] email_templates: .*Testabbruch/);
  assert.equal(db.prepare('SELECT count(*) AS c FROM email_templates').get().c, 0);
  assert.equal(db.prepare('SELECT count(*) AS c FROM leads').get().c, 0, 'Lead-Seed lief nicht weiter');
  db.close();
});

/**
 * Idempotente Seeds — getrennt von den Schema-Migrationen, laufen erst, wenn
 * die Datenbank auf dem Stand aller Migrationen ist. Verhalten wie bis cd2c098:
 *
 * - Vorlagen: jeder fehlende Slug wird angelegt, bestehende (auch selbst
 *   bearbeitete) bleiben unangetastet; gelöschte Standard-Slugs kehren zurück.
 * - Leads: die 952 Startdatensätze aus data/leads.json nur, wenn `leads` leer
 *   ist — jetzt in einer einzigen Transaktion (alles oder nichts).
 *
 * Jeder SQL-Fehler wird als SEED_FAILED gemeldet; die jeweilige Transaktion ist
 * dann vollständig zurückgerollt.
 */
import { readFileSync } from 'node:fs';
import { MigrationError } from './errors.mjs';
import { DOCUMENT_TEMPLATES, SEED_TEMPLATES } from './seed-templates.mjs';

const DEFAULT_LEADS_JSON = new URL('../../data/leads.json', import.meta.url);

const LEAD_INSERT = 'INSERT INTO leads (id,status,priority,score,name,category,street,zip,city,phone,email,website,website_status,website_class,age_score,problems,pitch,source,last_contact,next_action,follow_up,notes,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)';
const TEMPLATE_INSERT = 'INSERT INTO email_templates (slug,name,kind,subject,body_html,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(slug) DO NOTHING';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ leadsJson?: string | URL, now?: () => string, log?: (line: string) => void }} [options]
 * @returns {{ templatesInserted: number, leadsInserted: number }}
 */
export function runSeeds(db, { leadsJson = DEFAULT_LEADS_JSON, now = () => new Date().toISOString(), log = () => {} } = {}) {
  const templatesInserted = atomically(db, 'email_templates', () => {
    const existing = new Set(db.prepare('SELECT slug FROM email_templates').all().map(row => row.slug));
    const missing = [...SEED_TEMPLATES, ...DOCUMENT_TEMPLATES].filter(t => !existing.has(t.slug));
    if (!missing.length) return 0;
    const at = now();
    const insert = db.prepare(TEMPLATE_INSERT);
    let inserted = 0;
    for (const t of missing) inserted += insert.run(t.slug, t.name, t.kind, t.subject, t.body_html, at).changes;
    return inserted;
  });

  const leadsInserted = atomically(db, 'leads', () => {
    const { count } = db.prepare('SELECT COUNT(*) AS count FROM leads').get();
    if (Number(count) > 0) return 0;
    let leads;
    try {
      leads = JSON.parse(readFileSync(leadsJson, 'utf8'));
    } catch (error) {
      throw new MigrationError('SEED_SOURCE_MISSING', 'data/leads.json', `Startdaten nicht lesbar (${error.code ?? error.message})`);
    }
    const at = now();
    const insert = db.prepare(LEAD_INSERT);
    for (const lead of leads) {
      insert.run(lead.id, lead.status, lead.priority, lead.score, lead.name, lead.category, lead.street, lead.zip, lead.city, lead.phone, lead.email, lead.website, lead.websiteStatus, lead.websiteClass, lead.ageScore, lead.problems, lead.pitch, lead.source, lead.lastContact, lead.nextAction, lead.followUp, lead.notes, at);
    }
    return leads.length;
  });

  // Wie bisher: Statistik nur nach tatsächlich eingespielten Startdaten.
  if (leadsInserted > 0) db.pragma('optimize');
  if (templatesInserted || leadsInserted) log(`PXK-DB seeds templates=${templatesInserted} leads=${leadsInserted}`);
  return { templatesInserted, leadsInserted };
}

/** Eine IMMEDIATE-Transaktion; SQL-Fehler werden zu SEED_FAILED. */
function atomically(db, table, fn) {
  try {
    return db.transaction(fn).immediate();
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw new MigrationError('SEED_FAILED', table, `Seed zurückgerollt (${error.code ?? 'SQLITE'}: ${error.message})`);
  }
}

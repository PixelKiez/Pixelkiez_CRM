/**
 * Idempotente Seeds — getrennt von den Schema-Migrationen, laufen erst, wenn
 * die Datenbank auf dem Stand aller Migrationen ist. Verhalten wie bis cd2c098:
 *
 * - Vorlagen: jeder fehlende Slug wird angelegt, bestehende (auch selbst
 *   bearbeitete) bleiben unangetastet; gelöschte Standard-Slugs kehren zurück.
 * - Leads: die 952 Startdatensätze aus db/seeds/leads.json nur, wenn `leads`
 *   leer ist — in einer einzigen Transaktion (alles oder nichts).
 *
 * Die Startdaten liegen unter db/seeds und nicht unter data/: Auf Railway ist
 * /app/data das Volume und verdeckt alles, was das Image dort mitbringt.
 *
 * Vorab wird nur gelesen (planSeeds). Ist nichts zu tun, schreibt der Lauf
 * nichts — keine Transaktion, kein PRAGMA optimize. Vor dem ersten Schreiben
 * ruft runSeeds `beforeWrite` unter der Schreibsperre auf; wirft es, bleibt die
 * Datenbank unberührt (so hängt das CLI den Produktions-Sicherungszwang an).
 *
 * Jeder SQL-Fehler wird als SEED_FAILED gemeldet; die jeweilige Transaktion ist
 * dann vollständig zurückgerollt.
 */
import { readFileSync } from 'node:fs';
import { MigrationError } from './errors.mjs';
import { contentDigest, stableStringify } from './fingerprint.mjs';
import { DOCUMENT_TEMPLATES, SEED_TEMPLATES } from './seed-templates.mjs';

const DEFAULT_LEADS_JSON = new URL('../../db/seeds/leads.json', import.meta.url);
const TEMPLATES = [...SEED_TEMPLATES, ...DOCUMENT_TEMPLATES];

const LEAD_INSERT = 'INSERT INTO leads (id,status,priority,score,name,category,street,zip,city,phone,email,website,website_status,website_class,age_score,problems,pitch,source,last_contact,next_action,follow_up,notes,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)';
const TEMPLATE_INSERT = 'INSERT INTO email_templates (slug,name,kind,subject,body_html,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(slug) DO NOTHING';

const missingTemplates = (db) => {
  const existing = new Set(db.prepare('SELECT slug FROM email_templates').all().map(row => row.slug));
  return TEMPLATES.filter(t => !existing.has(t.slug));
};
const leadsEmpty = (db) => Number(db.prepare('SELECT COUNT(*) AS count FROM leads').get().count) === 0;

/**
 * Nur lesend: Was würden die Seeds jetzt anlegen?
 * @param {import('better-sqlite3').Database} db
 * @returns {{ templates: string[], leads: boolean, writes: boolean }}
 */
export function planSeeds(db) {
  const templates = missingTemplates(db).map(t => t.slug);
  const leads = leadsEmpty(db);
  return { templates, leads, writes: templates.length > 0 || leads };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ leadsJson?: string | URL, now?: () => string, log?: (line: string) => void,
 *   beforeWrite?: () => void }} [options]
 *   `beforeWrite` läuft einmal, unter der Schreibsperre und vor dem ersten INSERT.
 * @returns {{ templatesInserted: number, leadsInserted: number }}
 */
export function runSeeds(db, { leadsJson = DEFAULT_LEADS_JSON, now = () => new Date().toISOString(), log = () => {}, beforeWrite = () => {} } = {}) {
  const plan = planSeeds(db);
  if (!plan.writes) return { templatesInserted: 0, leadsInserted: 0 };
  // Startdaten vor jedem Schreibzugriff lesen: fehlt die Quelle, bleibt alles unberührt.
  const leads = plan.leads ? readSeedLeads(leadsJson) : null;
  let authorized = false;
  const authorize = () => {
    if (!authorized) beforeWrite();
    authorized = true;
  };

  const templatesInserted = !plan.templates.length ? 0 : atomically(db, 'email_templates', () => {
    const missing = missingTemplates(db);
    if (!missing.length) return 0;
    authorize();
    const at = now();
    const insert = db.prepare(TEMPLATE_INSERT);
    let inserted = 0;
    for (const t of missing) inserted += insert.run(t.slug, t.name, t.kind, t.subject, t.body_html, at).changes;
    return inserted;
  });

  const leadsInserted = !leads ? 0 : atomically(db, 'leads', () => {
    if (!leadsEmpty(db)) return 0;
    authorize();
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

/**
 * Schreibschranke für den Produktions-Sicherungszwang (D4), als `beforeWrite` für
 * runSeeds — sie läuft unter der Schreibsperre, vor dem ersten INSERT:
 * - `required` ohne `backup`: Die Prüfung vorab ergab nichts zu tun, unter der
 *   Sperre müsste doch geschrieben werden (paralleler Schreiber) → STATE_CHANGED.
 * - `digestAtBackup`: Seit der Sicherung haben sich Daten geändert → BACKUP_STALE.
 * In beiden Fällen wird nichts geschrieben.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ required: boolean, backup: object | null, digestAtBackup?: object | null }} state
 */
export function seedWriteGate(db, { required, backup, digestAtBackup = null }) {
  return () => {
    if (required && !backup) {
      throw new MigrationError('STATE_CHANGED', 'seeds', 'Seeds müssten schreiben, die Prüfung davor ergab nichts zu tun — ohne Sicherung nichts geschrieben, Lauf wiederholen');
    }
    if (digestAtBackup && stableStringify(contentDigest(db)) !== stableStringify(digestAtBackup)) {
      throw new MigrationError('BACKUP_STALE', db.name, 'Daten haben sich seit der Sicherung geändert (paralleler Schreiber?) — nichts geschrieben');
    }
  };
}

/** Startdaten lesen; fehlt die Quelle oder ist sie kaputt → SEED_SOURCE_MISSING. */
export function readSeedLeads(leadsJson = DEFAULT_LEADS_JSON) {
  try {
    return JSON.parse(readFileSync(leadsJson, 'utf8'));
  } catch (error) {
    throw new MigrationError('SEED_SOURCE_MISSING', 'db/seeds/leads.json', `Startdaten nicht lesbar (${error.code ?? error.message})`);
  }
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

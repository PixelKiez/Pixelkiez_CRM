import { batch, getSqlite, prepare } from '@/lib/d1-node';
import seedLeads from '@/data/leads.json';
import type { Lead } from '@/lib/types';

let ready: Promise<void> | null = null;
const createStatements = [
  `CREATE TABLE IF NOT EXISTS leads (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'Neu', priority TEXT NOT NULL DEFAULT 'Mittel', score INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL, category TEXT, street TEXT, zip TEXT, city TEXT, phone TEXT, email TEXT, website TEXT, website_status TEXT NOT NULL DEFAULT 'Prüfen', website_class TEXT, age_score INTEGER NOT NULL DEFAULT 0, problems TEXT, pitch TEXT, source TEXT, last_contact TEXT, next_action TEXT, follow_up TEXT, notes TEXT, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS activities (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id TEXT NOT NULL, type TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS email_templates (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'general', subject TEXT NOT NULL, body_html TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS appointments (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id TEXT NOT NULL, title TEXT NOT NULL, start_ts TEXT NOT NULL, end_ts TEXT NOT NULL, location TEXT, notes TEXT, gcal_event_id TEXT, gcal_link TEXT, status TEXT NOT NULL DEFAULT 'geplant', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_status_score ON leads(status, score DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_website_status ON leads(website_status)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_follow_up ON leads(follow_up)`,
  `CREATE INDEX IF NOT EXISTS idx_activities_lead_id ON activities(lead_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_appointments_lead_id ON appointments(lead_id, start_ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_appointments_start ON appointments(start_ts)`,
  `CREATE TABLE IF NOT EXISTS invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id TEXT NOT NULL, number TEXT NOT NULL UNIQUE, issued_at TEXT NOT NULL, service_date TEXT, net_cents INTEGER NOT NULL, vat_rate INTEGER NOT NULL DEFAULT 19, vat_cents INTEGER NOT NULL, gross_cents INTEGER NOT NULL, title TEXT, status TEXT NOT NULL DEFAULT 'offen', paid_at TEXT, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_invoices_lead_id ON invoices(lead_id, issued_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_invoices_issued ON invoices(issued_at)`,
];

/**
 * Nachträglich ergänzte Spalten an `leads`.
 * CREATE TABLE IF NOT EXISTS ändert bestehende Tabellen nicht — auf dem
 * Railway-Volume liegt eine gefüllte Datenbank, die erweitert werden muss.
 */
const LEAD_COLUMNS: Array<[string, string]> = [
  ['price_cents', 'INTEGER'],            // Festpreis Webseite, manuell gepflegt
  ['won_at', 'TEXT'],                    // wann der Kunde gewonnen wurde
  ['lost_reason', 'TEXT'],               // strukturierter Absagegrund
  ['recontact_at', 'TEXT'],              // Wiedervorlage (z. B. in 6 Monaten)
  ['contact_attempts', 'INTEGER NOT NULL DEFAULT 0'], // erfolglose Anrufversuche
];

function migrateLeadColumns() {
  const db = getSqlite();
  const existing = new Set(
    (db.prepare('PRAGMA table_info(leads)').all() as Array<{ name: string }>).map(row => row.name),
  );
  for (const [name, definition] of LEAD_COLUMNS) {
    if (!existing.has(name)) db.prepare(`ALTER TABLE leads ADD COLUMN ${name} ${definition}`).run();
  }
}

const SEED_TEMPLATES: Array<{ slug: string; name: string; kind: string; subject: string; body_html: string }> = [
  {
    slug: 'erstkontakt',
    name: 'Erstkontakt · Vorstellung',
    kind: 'general',
    subject: 'Bessere Online-Sichtbarkeit für {{firma}}',
    body_html: `<p>Guten Tag {{ansprechpartner}},</p>
<p>mir ist aufgefallen, dass <strong>{{firma}}</strong> aktuell {{website_hinweis}} – dabei suchen Kundinnen und Kunden in {{stadt}} genau nach <em>{{branche}}</em>.</p>
<p>Ich helfe lokalen Betrieben in Reinickendorf, mit einer schnellen, modernen Webseite gefunden zu werden – zu fairen Konditionen und ohne Technik-Stress.</p>
<p>Hätten Sie diese Woche 15 Minuten für ein kurzes Telefonat?</p>
<p>Beste Grüße<br/>{{absender}}</p>`,
  },
  {
    slug: 'nachfassen',
    name: 'Nachfassen · Follow-up',
    kind: 'general',
    subject: 'Kurze Nachfrage: Sichtbarkeit für {{firma}}',
    body_html: `<p>Guten Tag {{ansprechpartner}},</p>
<p>ich wollte kurz nachfassen, ob meine letzte Nachricht zu Ihrer digitalen Sichtbarkeit angekommen ist.</p>
<p>Gerne zeige ich Ihnen in 10 Minuten am Telefon, welche konkreten Verbesserungen für <strong>{{firma}}</strong> möglich wären.</p>
<p>Wann passt es Ihnen?</p>
<p>Beste Grüße<br/>{{absender}}</p>`,
  },
  {
    slug: 'angebot',
    name: 'Angebot · Webauftritt',
    kind: 'general',
    subject: 'Ihr Angebot: Moderner Webauftritt für {{firma}}',
    body_html: `<p>Guten Tag {{ansprechpartner}},</p>
<p>wie besprochen erhalten Sie hier das Angebot für einen modernen Webauftritt für <strong>{{firma}}</strong>:</p>
<ul>
  <li>Individuelles, mobil optimiertes Design</li>
  <li>Lokale Google-Sichtbarkeit für {{stadt}}</li>
  <li>Kontaktformular &amp; Anruf-Buttons</li>
  <li>Betreuung aus einer Hand</li>
</ul>
<p>Ich freue mich auf Ihre Rückmeldung.</p>
<p>Beste Grüße<br/>{{absender}}</p>`,
  },
  {
    slug: 'termin_bestaetigung',
    name: 'Terminbestätigung',
    kind: 'termin_confirm',
    subject: 'Termin bestätigt: {{termin_datum}} um {{termin_zeit}} Uhr',
    body_html: `<p>Guten Tag {{ansprechpartner}},</p>
<p>vielen Dank für Ihre Zeit. Ich bestätige gerne unseren Termin:</p>
<table style="border-collapse:collapse;margin:12px 0;">
  <tr><td style="padding:6px 14px 6px 0;color:#68736e;">Datum</td><td style="padding:6px 0;"><strong>{{termin_datum}}</strong></td></tr>
  <tr><td style="padding:6px 14px 6px 0;color:#68736e;">Uhrzeit</td><td style="padding:6px 0;"><strong>{{termin_zeit}} Uhr</strong></td></tr>
  <tr><td style="padding:6px 14px 6px 0;color:#68736e;">Ort</td><td style="padding:6px 0;"><strong>{{termin_ort}}</strong></td></tr>
  <tr><td style="padding:6px 14px 6px 0;color:#68736e;">Thema</td><td style="padding:6px 0;">{{termin_titel}}</td></tr>
</table>
<p>Sollten Sie den Termin verschieben müssen, melden Sie sich einfach kurz.</p>
<p>Beste Grüße<br/>{{absender}}</p>`,
  },
];

/**
 * Startvorlagen für Präsentation, Diagnose, Vertrag und Rechnung.
 * Bewusst schlicht gehalten — sie sind zum Überschreiben mit den echten
 * Pixelkiez-Inhalten gedacht. Folien werden an `<!-- folie -->` getrennt.
 */
const DOCUMENT_TEMPLATES: Array<{ slug: string; name: string; kind: string; subject: string; body_html: string }> = [
  {
    slug: 'praesentation_standard',
    name: 'Verkaufspräsentation · Standard',
    kind: 'praesentation',
    subject: 'Webauftritt für {{firma}}',
    body_html: `<h1>{{firma}}</h1>
<p class="lead">Ein moderner Webauftritt für {{branche}} in {{stadt}}</p>
<p>Vorgestellt von {{absender}}</p>
<!-- folie -->
<h2>Ihre Ausgangslage</h2>
<ul>
  <li>Aktuelle Webseite: {{website_status}}</li>
  <li>{{website_hinweis}}</li>
  <li>Beobachtete Punkte: {{probleme}}</li>
</ul>
<!-- folie -->
<h2>Was Ihre Kunden heute erleben</h2>
<p>Wer in {{stadt}} nach <strong>{{branche}}</strong> sucht, entscheidet in Sekunden. Ohne auffindbaren, mobil nutzbaren Auftritt landet die Anfrage beim Wettbewerb.</p>
<!-- folie -->
<h2>Unser Vorschlag</h2>
<ul>
  <li>Individuelles, mobil optimiertes Design</li>
  <li>Lokale Google-Sichtbarkeit für {{stadt}}</li>
  <li>Kontaktformular und Anruf-Buttons</li>
  <li>Betreuung aus einer Hand</li>
</ul>
<!-- folie -->
<h2>Investition</h2>
<p class="price">{{preis}}</p>
<p>Festpreis, keine versteckten Kosten.</p>
<!-- folie -->
<h2>Nächster Schritt</h2>
<p>{{naechste_aktion}}</p>
<p>{{absender}} · {{absender_telefon}} · {{absender_email}}</p>`,
  },
  {
    slug: 'diagnose_standard',
    name: 'Website-Diagnose · Standard',
    kind: 'diagnose',
    subject: 'Diagnose {{firma}}',
    body_html: `<h1>Website-Diagnose</h1>
<h2>{{firma}}</h2>
<table>
  <tr><td>Branche</td><td>{{branche}}</td></tr>
  <tr><td>Standort</td><td>{{plz}} {{stadt}}</td></tr>
  <tr><td>Webseite</td><td>{{website}}</td></tr>
  <tr><td>Status</td><td>{{website_status}}</td></tr>
  <tr><td>Bewertung</td><td>{{score}} von 100</td></tr>
</table>
<h3>Befund</h3>
<p>{{website_hinweis}}</p>
<h3>Auffälligkeiten</h3>
<p>{{probleme}}</p>
<h3>Empfehlung</h3>
<p>{{pitch}}</p>
<p class="footer">Erstellt am {{datum}} von {{absender}}</p>`,
  },
  {
    slug: 'vertrag_standard',
    name: 'Vertrag · Webseitenerstellung',
    kind: 'vertrag',
    subject: 'Vertrag über die Erstellung einer Webseite',
    body_html: `<h1>Vertrag über die Erstellung einer Webseite</h1>
<p><strong>zwischen</strong></p>
<p>{{anbieter_name}}<br/>{{anbieter_strasse}}<br/>{{anbieter_plz}} {{anbieter_ort}}<br/>— nachfolgend Auftragnehmer —</p>
<p><strong>und</strong></p>
<p>{{firma}}<br/>{{strasse}}<br/>{{plz}} {{stadt}}<br/>— nachfolgend Auftraggeber —</p>
<h3>§ 1 Gegenstand</h3>
<p>Der Auftragnehmer erstellt für den Auftraggeber einen Webauftritt einschließlich Konzeption, Gestaltung, technischer Umsetzung und Veröffentlichung.</p>
<h3>§ 2 Vergütung</h3>
<p>Es gilt ein Festpreis von <strong>{{preis}}</strong> zuzüglich der gesetzlichen Umsatzsteuer.</p>
<h3>§ 3 Mitwirkung</h3>
<p>Der Auftraggeber stellt Texte, Bilder und Zugänge rechtzeitig bereit.</p>
<h3>§ 4 Schlussbestimmungen</h3>
<p>Änderungen bedürfen der Textform. Sollte eine Bestimmung unwirksam sein, bleibt der Vertrag im Übrigen wirksam.</p>
<table class="sign">
  <tr><td>{{anbieter_ort}}, {{datum}}</td><td>{{stadt}}, {{datum}}</td></tr>
  <tr><td class="sig">Auftragnehmer</td><td class="sig">Auftraggeber</td></tr>
</table>`,
  },
  {
    slug: 'rechnung_standard',
    name: 'Rechnung · Standard',
    kind: 'rechnung',
    subject: 'Rechnung {{rechnungsnummer}}',
    body_html: `<p class="sender">{{anbieter_name}} · {{anbieter_strasse}} · {{anbieter_plz}} {{anbieter_ort}}</p>
<p class="recipient">{{firma}}<br/>{{strasse}}<br/>{{plz}} {{stadt}}</p>
<h1>Rechnung {{rechnungsnummer}}</h1>
<table class="meta">
  <tr><td>Rechnungsdatum</td><td>{{rechnungsdatum}}</td></tr>
  <tr><td>Leistungsdatum</td><td>{{leistungsdatum}}</td></tr>
</table>
<table class="items">
  <tr><th>Position</th><th>Betrag</th></tr>
  <tr><td>{{leistung}}</td><td>{{netto}}</td></tr>
  <tr><td>Umsatzsteuer {{ust_satz}} %</td><td>{{ust_betrag}}</td></tr>
  <tr class="total"><td>Gesamtbetrag</td><td>{{brutto}}</td></tr>
</table>
<p>Bitte überweisen Sie den Betrag innerhalb von 14 Tagen auf folgendes Konto:</p>
<p>{{anbieter_bank}}<br/>IBAN {{anbieter_iban}}<br/>BIC {{anbieter_bic}}</p>
<p class="footer">{{anbieter_name}} · Steuernummer {{anbieter_steuernummer}} · USt-IdNr. {{anbieter_ustid}}</p>`,
  },
];

export async function ensureDatabase() {
  if (ready) return ready;
  ready = (async () => {
    for (const sql of createStatements) prepare(sql).run();
    migrateLeadColumns();
    await seedTemplatesIfEmpty();
    const count = await prepare('SELECT COUNT(*) AS count FROM leads').first<{ count: number }>();
    if (Number(count?.count || 0) > 0) return;
    const insert = `INSERT INTO leads (id,status,priority,score,name,category,street,zip,city,phone,email,website,website_status,website_class,age_score,problems,pitch,source,last_contact,next_action,follow_up,notes,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
    const now = new Date().toISOString();
    const statements = (seedLeads as Lead[]).map(lead => prepare(insert).bind(lead.id,lead.status,lead.priority,lead.score,lead.name,lead.category,lead.street,lead.zip,lead.city,lead.phone,lead.email,lead.website,lead.websiteStatus,lead.websiteClass,lead.ageScore,lead.problems,lead.pitch,lead.source,lead.lastContact,lead.nextAction,lead.followUp,lead.notes,now));
    for (let i=0;i<statements.length;i+=60) await batch(statements.slice(i,i+60));
    await prepare('PRAGMA optimize').run();
  })();
  return ready;
}

/**
 * Legt fehlende Vorlagen an — einzeln, nicht nur bei leerer Tabelle.
 * Auf dem Railway-Volume liegen bereits E-Mail-Vorlagen; die Dokumentvorlagen
 * müssen trotzdem nachgezogen werden. Bestehende Einträge bleiben unangetastet,
 * damit selbst bearbeitete Vorlagen nicht überschrieben werden.
 */
async function seedTemplatesIfEmpty() {
  const { results } = await prepare('SELECT slug FROM email_templates').all<{ slug: string }>();
  const existing = new Set(results.map(row => row.slug));
  const missing = [...SEED_TEMPLATES, ...DOCUMENT_TEMPLATES].filter(t => !existing.has(t.slug));
  if (!missing.length) return;
  const now = new Date().toISOString();
  const insert = 'INSERT INTO email_templates (slug,name,kind,subject,body_html,updated_at) VALUES (?,?,?,?,?,?)';
  await batch(missing.map(t => prepare(insert).bind(t.slug, t.name, t.kind, t.subject, t.body_html, now)));
}

export function getD1() {
  return {
    prepare(sql: string) {
      return prepare(sql);
    },
    batch,
  };
}

export function rowToLead(row: Record<string, unknown>): Lead {
  return { id:String(row.id),status:String(row.status),priority:String(row.priority),score:Number(row.score),name:String(row.name),category:row.category as string|null,street:row.street as string|null,zip:row.zip as string|null,city:row.city as string|null,phone:row.phone as string|null,email:row.email as string|null,website:row.website as string|null,websiteStatus:String(row.website_status),websiteClass:row.website_class as string|null,ageScore:Number(row.age_score),problems:row.problems as string|null,pitch:row.pitch as string|null,source:row.source as string|null,lastContact:row.last_contact as string|null,nextAction:row.next_action as string|null,followUp:row.follow_up as string|null,notes:row.notes as string|null,updatedAt:String(row.updated_at),
    priceCents: row.price_cents === null || row.price_cents === undefined ? null : Number(row.price_cents),
    wonAt: (row.won_at as string | null) ?? null,
    lostReason: (row.lost_reason as string | null) ?? null,
    recontactAt: (row.recontact_at as string | null) ?? null,
    contactAttempts: Number(row.contact_attempts ?? 0) };
}

export function rowToInvoice(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    leadId: String(row.lead_id),
    number: String(row.number),
    issuedAt: String(row.issued_at),
    serviceDate: (row.service_date as string | null) ?? null,
    netCents: Number(row.net_cents),
    vatRate: Number(row.vat_rate),
    vatCents: Number(row.vat_cents),
    grossCents: Number(row.gross_cents),
    title: (row.title as string | null) ?? null,
    status: String(row.status),
    paidAt: (row.paid_at as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function rowToTemplate(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    slug: String(row.slug),
    name: String(row.name),
    kind: String(row.kind),
    subject: String(row.subject),
    bodyHtml: String(row.body_html),
    updatedAt: String(row.updated_at),
  };
}

export function rowToAppointment(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    leadId: String(row.lead_id),
    title: String(row.title),
    startTs: String(row.start_ts),
    endTs: String(row.end_ts),
    location: (row.location as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    gcalEventId: (row.gcal_event_id as string | null) ?? null,
    gcalLink: (row.gcal_link as string | null) ?? null,
    status: String(row.status),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

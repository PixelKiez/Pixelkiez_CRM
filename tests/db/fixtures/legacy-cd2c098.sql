-- Testfixture: das Schema von cd2c098 in genau der Form, in der der alte Code
-- es ausgeführt hat (CREATE ... IF NOT EXISTS aus lib/database.ts, danach die
-- migrateColumns-ALTERs). Extrahiert per TypeScript-AST aus
-- git show cd2c098f5c054d6a00098188c198f5ce644449be:lib/database.ts.
-- Bewusst unabhängig von db/migrations/0001_baseline.sql, damit AC1/AC3 nicht zirkulär prüfen.
CREATE TABLE IF NOT EXISTS leads (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'Neu', priority TEXT NOT NULL DEFAULT 'Mittel', score INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL, category TEXT, street TEXT, zip TEXT, city TEXT, phone TEXT, email TEXT, website TEXT, website_status TEXT NOT NULL DEFAULT 'Prüfen', website_class TEXT, age_score INTEGER NOT NULL DEFAULT 0, problems TEXT, pitch TEXT, source TEXT, last_contact TEXT, next_action TEXT, follow_up TEXT, notes TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS activities (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id TEXT NOT NULL, type TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS email_templates (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'general', subject TEXT NOT NULL, body_html TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS appointments (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id TEXT NOT NULL, title TEXT NOT NULL, start_ts TEXT NOT NULL, end_ts TEXT NOT NULL, location TEXT, notes TEXT, gcal_event_id TEXT, gcal_link TEXT, status TEXT NOT NULL DEFAULT 'geplant', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_leads_status_score ON leads(status, score DESC);
CREATE INDEX IF NOT EXISTS idx_leads_website_status ON leads(website_status);
CREATE INDEX IF NOT EXISTS idx_leads_follow_up ON leads(follow_up);
CREATE INDEX IF NOT EXISTS idx_activities_lead_id ON activities(lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_appointments_lead_id ON appointments(lead_id, start_ts DESC);
CREATE INDEX IF NOT EXISTS idx_appointments_start ON appointments(start_ts);
CREATE TABLE IF NOT EXISTS invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id TEXT NOT NULL, number TEXT NOT NULL UNIQUE, issued_at TEXT NOT NULL, service_date TEXT, net_cents INTEGER NOT NULL, vat_rate INTEGER NOT NULL DEFAULT 19, vat_cents INTEGER NOT NULL, gross_cents INTEGER NOT NULL, title TEXT, status TEXT NOT NULL DEFAULT 'offen', paid_at TEXT, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_invoices_lead_id ON invoices(lead_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_issued ON invoices(issued_at);
CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, display_name TEXT NOT NULL, signature TEXT, phone TEXT, google_tokens TEXT, google_email TEXT, google_calendar_id TEXT NOT NULL DEFAULT 'primary', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
ALTER TABLE leads ADD COLUMN price_cents INTEGER;
ALTER TABLE leads ADD COLUMN won_at TEXT;
ALTER TABLE leads ADD COLUMN lost_reason TEXT;
ALTER TABLE leads ADD COLUMN recontact_at TEXT;
ALTER TABLE leads ADD COLUMN contact_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN owner_email TEXT;
ALTER TABLE invoices ADD COLUMN kind TEXT NOT NULL DEFAULT 'komplett';
ALTER TABLE invoices ADD COLUMN share_percent INTEGER NOT NULL DEFAULT 100;
ALTER TABLE activities ADD COLUMN actor_email TEXT;

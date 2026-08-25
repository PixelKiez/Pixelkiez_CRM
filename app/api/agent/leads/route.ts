import { requireAgentAuth } from '@/lib/agent-auth';
import { ensureDatabase, getD1, rowToLead } from '@/lib/database';
import type { Lead } from '@/lib/types';

const FIELDS: Record<string, string> = {
  status: 'status', priority: 'priority', score: 'score', name: 'name', category: 'category',
  street: 'street', zip: 'zip', city: 'city', phone: 'phone', email: 'email', website: 'website',
  websiteStatus: 'website_status', websiteClass: 'website_class', ageScore: 'age_score',
  problems: 'problems', pitch: 'pitch', source: 'source',
  lastContact: 'last_contact', nextAction: 'next_action', followUp: 'follow_up', notes: 'notes',
};

type Payload = Partial<Lead> & { id?: string };

async function nextLeadId(): Promise<string> {
  const db = getD1();
  const row = await db.prepare("SELECT MAX(CAST(SUBSTR(id,4) AS INTEGER)) AS max_id FROM leads WHERE id LIKE 'PK-%'").first<{ max_id: number }>();
  return `PK-${String(Number(row?.max_id || 0) + 1).padStart(4, '0')}`;
}

async function insertLead(payload: Payload): Promise<Lead> {
  const db = getD1();
  const id = payload.id?.trim() || (await nextLeadId());
  const now = new Date().toISOString();
  const values: Record<string, unknown> = {
    id, status: payload.status || 'Neu', priority: payload.priority || 'Mittel', score: Number(payload.score ?? 50),
    name: (payload.name || '').trim(), category: payload.category ?? null,
    street: payload.street ?? null, zip: payload.zip ?? null, city: payload.city ?? 'Berlin',
    phone: payload.phone ?? null, email: payload.email ?? null, website: payload.website ?? null,
    website_status: payload.websiteStatus || 'Prüfen', website_class: payload.websiteClass ?? null,
    age_score: Number(payload.ageScore ?? 0), problems: payload.problems ?? null, pitch: payload.pitch ?? null,
    source: payload.source ?? 'agent', last_contact: payload.lastContact ?? null,
    next_action: payload.nextAction ?? 'Erstkontakt vorbereiten', follow_up: payload.followUp ?? null,
    notes: payload.notes ?? null, updated_at: now,
  };
  const cols = Object.keys(values);
  await db
    .prepare(`INSERT INTO leads (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .bind(...cols.map(c => values[c]))
    .run();
  await db
    .prepare('INSERT INTO activities (lead_id,type,detail,created_at) VALUES (?,?,?,?)')
    .bind(id, 'created', `Angelegt via Agent${payload.source ? ` (${payload.source})` : ''}`, now)
    .run();
  const row = await db.prepare('SELECT * FROM leads WHERE id=?').bind(id).first<Record<string, unknown>>();
  return rowToLead(row!);
}

/** Einzel-Lead anlegen. */
export async function POST(request: Request) {
  const denied = await requireAgentAuth(request);
  if (denied) return denied;
  await ensureDatabase();
  const body = (await request.json()) as Payload | { leads?: Payload[] };
  const items = Array.isArray((body as { leads?: Payload[] }).leads) ? (body as { leads: Payload[] }).leads : [body as Payload];
  const created: Lead[] = [];
  const errors: Array<{ index: number; error: string; name?: string }> = [];
  for (let i = 0; i < items.length; i++) {
    const payload = items[i];
    if (!payload?.name?.trim()) { errors.push({ index: i, error: 'name fehlt', name: payload?.name }); continue; }
    try { created.push(await insertLead(payload)); }
    catch (error) { errors.push({ index: i, error: error instanceof Error ? error.message : String(error), name: payload.name }); }
  }
  return Response.json({ ok: errors.length === 0, created, errors }, { status: created.length ? 201 : 400 });
}
export { FIELDS };

import { requireAgentAuth } from '@/lib/agent-auth';
import { ensureDatabase, getD1, rowToLead } from '@/lib/database';
import { FIELDS } from '@/app/api/agent/leads/route';

/** Enrich / Update eines Leads durch den Agent. */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await requireAgentAuth(request);
  if (denied) return denied;
  await ensureDatabase();
  const { id } = await context.params;
  const body = (await request.json()) as Record<string, unknown>;
  const changes = Object.entries(body).filter(([key]) => FIELDS[key]);
  if (!changes.length) return Response.json({ error: 'Keine gültige Änderung.' }, { status: 400 });
  const db = getD1();
  const now = new Date().toISOString();
  const sql = `UPDATE leads SET ${changes.map(([key]) => `${FIELDS[key]}=?`).join(', ')}, updated_at=? WHERE id=?`;
  await db.prepare(sql).bind(...changes.map(([, value]) => (value === '' ? null : value)), now, id).run();
  await db
    .prepare('INSERT INTO activities (lead_id,type,detail,created_at) VALUES (?,?,?,?)')
    .bind(id, 'enriched', `Agent aktualisierte: ${changes.map(([key]) => key).join(', ')}`, now)
    .run();
  const row = await db.prepare('SELECT * FROM leads WHERE id=?').bind(id).first<Record<string, unknown>>();
  if (!row) return Response.json({ error: 'Lead nicht gefunden.' }, { status: 404 });
  return Response.json({ lead: rowToLead(row) });
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await requireAgentAuth(request);
  if (denied) return denied;
  await ensureDatabase();
  const { id } = await context.params;
  const row = await getD1().prepare('SELECT * FROM leads WHERE id=?').bind(id).first<Record<string, unknown>>();
  if (!row) return Response.json({ error: 'Lead nicht gefunden.' }, { status: 404 });
  return Response.json({ lead: rowToLead(row) });
}

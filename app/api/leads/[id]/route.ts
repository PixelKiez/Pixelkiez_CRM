import { ensureDatabase, getD1, rowToLead } from '@/lib/database';
import { LEAD_COLUMNS, syncLeadPatch } from '@/lib/lead-sync';

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  await ensureDatabase();
  const { id } = await context.params;
  const body = (await request.json()) as Record<string, unknown>;
  const db = getD1();

  const current = await db.prepare('SELECT status, won_at, price_cents FROM leads WHERE id=?').bind(id)
    .first<{ status: string; won_at: string | null; price_cents: number | null }>();
  if (!current) return Response.json({ error: 'Lead nicht gefunden.' }, { status: 404 });

  const result = syncLeadPatch(current, body);
  if ('error' in result) return Response.json({ error: result.error }, { status: 400 });

  const changes = Object.entries(result.patch);
  const now = new Date().toISOString();
  const sql = `UPDATE leads SET ${changes.map(([key]) => `${LEAD_COLUMNS[key]}=?`).join(', ')}, updated_at=? WHERE id=?`;
  await db.prepare(sql).bind(...changes.map(([, value]) => value), now, id).run();

  const detail = [`Aktualisiert: ${changes.map(([key]) => key).join(', ')}`, ...result.notes].join(' · ');
  await db.prepare('INSERT INTO activities (lead_id,type,detail,created_at) VALUES (?,?,?,?)')
    .bind(id, 'updated', detail, now).run();

  const row = await db.prepare('SELECT * FROM leads WHERE id=?').bind(id).first<Record<string, unknown>>();
  if (!row) return Response.json({ error: 'Lead nicht gefunden.' }, { status: 404 });
  return Response.json({ lead: rowToLead(row), notes: result.notes });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  await ensureDatabase();
  const { id } = await context.params;
  const db = getD1();
  const row = await db.prepare('SELECT id FROM leads WHERE id=?').bind(id).first();
  if (!row) return Response.json({ error: 'Lead nicht gefunden.' }, { status: 404 });
  await db.batch([
    db.prepare('DELETE FROM activities WHERE lead_id=?').bind(id),
    db.prepare('DELETE FROM invoices WHERE lead_id=?').bind(id),
    db.prepare('DELETE FROM appointments WHERE lead_id=?').bind(id),
    db.prepare('DELETE FROM leads WHERE id=?').bind(id),
  ]);
  return Response.json({ ok: true });
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  await ensureDatabase();
  const { id } = await context.params;
  const db = getD1();
  const [row, activity, invoices] = await Promise.all([
    db.prepare('SELECT * FROM leads WHERE id=?').bind(id).first<Record<string, unknown>>(),
    db.prepare('SELECT * FROM activities WHERE lead_id=? ORDER BY created_at DESC LIMIT 20').bind(id).all(),
    db.prepare('SELECT * FROM invoices WHERE lead_id=? ORDER BY issued_at DESC').bind(id).all(),
  ]);
  if (!row) return Response.json({ error: 'Lead nicht gefunden.' }, { status: 404 });
  return Response.json({ lead: rowToLead(row), activities: activity.results, invoices: invoices.results });
}

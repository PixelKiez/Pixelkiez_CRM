import { ensureDatabase, getD1, rowToInvoice } from '@/lib/database';

const ALLOWED_STATUS = ['offen', 'bezahlt', 'storniert'];

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  await ensureDatabase();
  const { id } = await context.params;
  const body = (await request.json()) as { status?: string; paidAt?: string | null; notes?: string };
  const db = getD1();

  const current = await db.prepare('SELECT * FROM invoices WHERE id=?').bind(id).first<Record<string, unknown>>();
  if (!current) return Response.json({ error: 'Rechnung nicht gefunden.' }, { status: 404 });

  const status = body.status?.trim();
  if (status && !ALLOWED_STATUS.includes(status)) {
    return Response.json({ error: `Unbekannter Status: ${status}` }, { status: 400 });
  }

  const now = new Date().toISOString();
  // "bezahlt" ohne Zahldatum ergibt keine auswertbare Zahl — deshalb ergänzen.
  const paidAt = status === 'bezahlt' ? (body.paidAt ?? (current.paid_at as string | null) ?? now)
    : status ? null : (current.paid_at as string | null);

  await db.prepare('UPDATE invoices SET status=?, paid_at=?, notes=?, updated_at=? WHERE id=?')
    .bind(status ?? String(current.status), paidAt, body.notes ?? (current.notes as string | null), now, id).run();

  if (status) {
    await db.prepare('INSERT INTO activities (lead_id,type,detail,created_at) VALUES (?,?,?,?)')
      .bind(String(current.lead_id), 'invoice_status', `Rechnung ${String(current.number)}: ${status}`, now).run();
  }

  const row = await db.prepare('SELECT * FROM invoices WHERE id=?').bind(id).first<Record<string, unknown>>();
  return Response.json({ invoice: rowToInvoice(row!) });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  await ensureDatabase();
  const { id } = await context.params;
  const db = getD1();
  const row = await db.prepare('SELECT id FROM invoices WHERE id=?').bind(id).first();
  if (!row) return Response.json({ error: 'Rechnung nicht gefunden.' }, { status: 404 });
  await db.prepare('DELETE FROM invoices WHERE id=?').bind(id).run();
  return Response.json({ ok: true });
}

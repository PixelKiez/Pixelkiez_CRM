import { ensureDatabase, getD1, rowToTemplate } from '@/lib/database';

const EDITABLE: Record<string, string> = { name: 'name', kind: 'kind', subject: 'subject', bodyHtml: 'body_html' };

async function loadRow(id: number) {
  return getD1().prepare('SELECT * FROM email_templates WHERE id=?').bind(id).first<Record<string, unknown>>();
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  await ensureDatabase();
  const { id } = await context.params;
  const row = await loadRow(Number(id));
  if (!row) return Response.json({ error: 'Vorlage nicht gefunden.' }, { status: 404 });
  return Response.json({ template: rowToTemplate(row) });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  await ensureDatabase();
  const { id } = await context.params;
  const body = (await request.json()) as Record<string, unknown>;
  const changes = Object.entries(body).filter(([key]) => EDITABLE[key]);
  if (!changes.length) return Response.json({ error: 'Keine gültige Änderung.' }, { status: 400 });
  const now = new Date().toISOString();
  const sql = `UPDATE email_templates SET ${changes.map(([key]) => `${EDITABLE[key]}=?`).join(', ')}, updated_at=? WHERE id=?`;
  await getD1().prepare(sql).bind(...changes.map(([, value]) => String(value ?? '')), now, Number(id)).run();
  const row = await loadRow(Number(id));
  if (!row) return Response.json({ error: 'Vorlage nicht gefunden.' }, { status: 404 });
  return Response.json({ template: rowToTemplate(row) });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  await ensureDatabase();
  const { id } = await context.params;
  const row = await loadRow(Number(id));
  if (!row) return Response.json({ error: 'Vorlage nicht gefunden.' }, { status: 404 });
  if (String(row.kind) === 'termin_confirm')
    return Response.json({ error: 'Die Terminbestätigung ist ein Systemplatzhalter und kann nur bearbeitet werden.' }, { status: 400 });
  await getD1().prepare('DELETE FROM email_templates WHERE id=?').bind(Number(id)).run();
  return Response.json({ ok: true });
}

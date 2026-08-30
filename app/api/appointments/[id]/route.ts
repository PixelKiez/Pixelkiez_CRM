import { ensureDatabase, getD1 } from '@/lib/database';
import { currentUserEmail } from '@/lib/current-user';
import { deleteCalendarEvent } from '@/lib/google';

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  await ensureDatabase();
  const { id } = await context.params;
  const db = getD1();
  const row = await db.prepare('SELECT * FROM appointments WHERE id=?').bind(Number(id)).first<Record<string, unknown>>();
  if (!row) return Response.json({ error: 'Termin nicht gefunden.' }, { status: 404 });
  const eventId = row.gcal_event_id ? String(row.gcal_event_id) : null;
  const warnings: string[] = [];
  if (eventId) {
    try { await deleteCalendarEvent(eventId, await currentUserEmail()); }
    catch (error) { warnings.push(`Google-Event konnte nicht gelöscht werden: ${error instanceof Error ? error.message : String(error)}`); }
  }
  await db.prepare('DELETE FROM appointments WHERE id=?').bind(Number(id)).run();
  await db
    .prepare('INSERT INTO activities (lead_id,type,detail,created_at) VALUES (?,?,?,?)')
    .bind(String(row.lead_id), 'appointment_cancelled', `Termin gelöscht: ${row.title}`, new Date().toISOString())
    .run();
  return Response.json({ ok: true, warnings });
}

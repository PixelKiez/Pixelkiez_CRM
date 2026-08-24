import { ensureDatabase, getD1 } from '@/lib/database';
import { loadSmtpConfig } from '@/lib/settings';
import { sendSmtpMail } from '@/lib/smtp';

export async function POST(request: Request) {
  await ensureDatabase();
  const db = getD1();
  const body = (await request.json()) as { leadId?: string; to?: string; subject?: string; html?: string };
  const subject = body.subject?.trim();
  const html = body.html?.trim();
  if (!subject || !html) return Response.json({ error: 'Betreff und Nachricht sind erforderlich.' }, { status: 400 });

  let recipient = body.to?.trim() || '';
  if (!recipient && body.leadId) {
    const row = await db.prepare('SELECT email FROM leads WHERE id=?').bind(body.leadId).first<{ email: string | null }>();
    recipient = row?.email ?? '';
  }
  if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient))
    return Response.json({ error: 'Kein gültiger Empfänger vorhanden.' }, { status: 400 });

  const config = await loadSmtpConfig();
  if (!config) return Response.json({ error: 'E-Mail ist nicht eingerichtet. Konfiguriere dein Postfach unter Einstellungen.' }, { status: 428 });

  try {
    await sendSmtpMail(config, { to: recipient, subject, html });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .prepare('INSERT INTO activities (lead_id,type,detail,created_at) VALUES (?,?,?,?)')
      .bind(body.leadId ?? '', 'email_failed', `${subject} → ${recipient} · ${message}`, new Date().toISOString())
      .run();
    return Response.json({ error: `Versand fehlgeschlagen: ${message}` }, { status: 502 });
  }

  const now = new Date().toISOString();
  if (body.leadId) {
    await db.batch([
      db.prepare('INSERT INTO activities (lead_id,type,detail,created_at) VALUES (?,?,?,?)').bind(body.leadId, 'email_sent', `${subject} → ${recipient}`, now),
      db.prepare('UPDATE leads SET last_contact=?, updated_at=? WHERE id=?').bind(now, now, body.leadId),
    ]);
  }
  return Response.json({ ok: true, to: recipient });
}

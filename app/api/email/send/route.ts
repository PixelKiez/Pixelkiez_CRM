import { ensureDatabase, getD1, rowToLead, rowToTemplate } from '@/lib/database';
import { loadSmtpConfig } from '@/lib/settings';
import { sendSmtpMail } from '@/lib/smtp';
import { buildLeadContext, renderTemplate, type TemplateContext } from '@/lib/template-render';
import type { Lead } from '@/lib/types';

type Body = {
  leadId?: string;
  to?: string;
  subject?: string;
  html?: string;
  templateId?: number;
  variables?: Record<string, string>;
  ansprechpartner?: string;
};

export async function POST(request: Request) {
  await ensureDatabase();
  const db = getD1();
  const body = (await request.json()) as Body;

  // Lead + optionalen Kontext laden
  let lead: Lead | null = null;
  if (body.leadId) {
    const row = await db.prepare('SELECT * FROM leads WHERE id=?').bind(body.leadId).first<Record<string, unknown>>();
    if (row) lead = rowToLead(row);
  }

  // Betreff/HTML entweder direkt oder via Template
  let subject = body.subject?.trim() || '';
  let html = body.html?.trim() || '';
  if (body.templateId) {
    const tRow = await db.prepare('SELECT * FROM email_templates WHERE id=?').bind(body.templateId).first<Record<string, unknown>>();
    if (!tRow) return Response.json({ error: 'Vorlage nicht gefunden.' }, { status: 404 });
    const template = rowToTemplate(tRow);
    const config = await loadSmtpConfig();
    const ctx: TemplateContext = lead
      ? buildLeadContext(lead, { ansprechpartner: body.ansprechpartner, absender: config?.senderName || '', ...(body.variables ?? {}) })
      : { ...(body.variables ?? {}), absender: config?.senderName || '' };
    subject = renderTemplate(template.subject, ctx);
    html = renderTemplate(template.bodyHtml, ctx);
  }
  if (!subject || !html) return Response.json({ error: 'Betreff und Nachricht sind erforderlich.' }, { status: 400 });

  let recipient = body.to?.trim() || lead?.email || '';
  if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient))
    return Response.json({ error: 'Kein gültiger Empfänger vorhanden.' }, { status: 400 });

  const config = await loadSmtpConfig();
  if (!config)
    return Response.json({ error: 'E-Mail ist nicht eingerichtet. Konfiguriere dein Postfach unter Einstellungen.' }, { status: 428 });

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
  return Response.json({ ok: true, to: recipient, subject });
}

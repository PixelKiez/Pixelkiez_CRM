import { ensureDatabase, getD1, rowToAppointment, rowToLead } from '@/lib/database';
import { currentProfile } from '@/lib/current-user';
import { createCalendarEvent } from '@/lib/google';
import { loadSmtpConfig, loadStoredSettings } from '@/lib/settings';
import { sendSmtpMail } from '@/lib/smtp';
import { buildAppointmentContext, buildLeadContext, renderTemplate } from '@/lib/template-render';
import type { Appointment, Lead } from '@/lib/types';

async function findTerminConfirmTemplate() {
  const row = await getD1()
    .prepare("SELECT * FROM email_templates WHERE kind='termin_confirm' ORDER BY updated_at DESC LIMIT 1")
    .first<Record<string, unknown>>();
  return row ? { subject: String(row.subject), bodyHtml: String(row.body_html) } : null;
}

export async function GET(request: Request) {
  await ensureDatabase();
  const url = new URL(request.url);
  const leadId = url.searchParams.get('leadId');
  const upcoming = url.searchParams.get('upcoming') === '1';
  const db = getD1();
  const clauses: string[] = [];
  const args: unknown[] = [];
  if (leadId) { clauses.push('a.lead_id=?'); args.push(leadId); }
  if (upcoming) { clauses.push('a.start_ts >= ?'); args.push(new Date().toISOString()); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { results } = await db
    .prepare(`SELECT a.*, l.name AS lead_name FROM appointments a LEFT JOIN leads l ON l.id=a.lead_id ${where} ORDER BY a.start_ts ASC`)
    .bind(...args)
    .all<Record<string, unknown>>();
  const appointments: Appointment[] = results.map(row => ({ ...rowToAppointment(row), leadName: row.lead_name ? String(row.lead_name) : undefined }));
  return Response.json({ appointments });
}

export async function POST(request: Request) {
  await ensureDatabase();
  const body = (await request.json()) as {
    leadId?: string; title?: string; startTs?: string; endTs?: string;
    location?: string; notes?: string; sendConfirmation?: boolean; ansprechpartner?: string;
  };
  if (!body.leadId || !body.title?.trim() || !body.startTs || !body.endTs)
    return Response.json({ error: 'leadId, title, startTs und endTs sind erforderlich.' }, { status: 400 });
  const start = new Date(body.startTs);
  const end = new Date(body.endTs);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start)
    return Response.json({ error: 'Ungültiger Zeitraum.' }, { status: 400 });

  const db = getD1();
  const leadRow = await db.prepare('SELECT * FROM leads WHERE id=?').bind(body.leadId).first<Record<string, unknown>>();
  if (!leadRow) return Response.json({ error: 'Lead nicht gefunden.' }, { status: 404 });
  const lead: Lead = rowToLead(leadRow);

  let gcalEventId: string | null = null;
  let gcalLink: string | null = null;
  const stored = await loadStoredSettings();
  // Persönlicher Kalender hat Vorrang; der frühere gemeinsame Zugang bleibt Rückfallebene.
  const me = await currentProfile();
  const hasGoogle = Boolean(me?.googleConnected || stored.google_oauth_tokens);
  const warnings: string[] = [];
  if (hasGoogle) {
    try {
      const event = await createCalendarEvent({
        summary: `${body.title} · ${lead.name}`,
        description: [body.notes || '', body.title, `Lead: ${lead.name} (${lead.id})`].filter(Boolean).join('\n\n'),
        location: body.location || undefined,
        startIso: start.toISOString(),
        endIso: end.toISOString(),
        attendeeEmail: lead.email || undefined,
        userEmail: me?.email,
      });
      gcalEventId = event.id;
      gcalLink = event.htmlLink;
    } catch (error) {
      warnings.push(`Google-Kalender-Fehler: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    warnings.push('Google-Kalender nicht verbunden — Termin wurde nur intern gespeichert.');
  }

  const now = new Date().toISOString();
  await db
    .prepare(`INSERT INTO appointments (lead_id,title,start_ts,end_ts,location,notes,gcal_event_id,gcal_link,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?, 'geplant', ?, ?)`)
    .bind(lead.id, body.title.trim(), start.toISOString(), end.toISOString(), body.location ?? null, body.notes ?? null, gcalEventId, gcalLink, now, now)
    .run();
  const inserted = await db
    .prepare('SELECT * FROM appointments WHERE rowid = last_insert_rowid()')
    .first<Record<string, unknown>>();
  const appointment: Appointment = rowToAppointment(inserted!);

  await db
    .prepare('INSERT INTO activities (lead_id,type,detail,created_at) VALUES (?,?,?,?)')
    .bind(lead.id, 'appointment_created', `${body.title} — ${start.toLocaleString('de-DE')}${gcalEventId ? ' · GCal' : ''}`, now)
    .run();

  let mailStatus: 'sent' | 'skipped' | 'failed' = 'skipped';
  if (body.sendConfirmation && lead.email) {
    const smtp = await loadSmtpConfig();
    const template = await findTerminConfirmTemplate();
    if (!smtp) warnings.push('SMTP nicht konfiguriert — Bestätigungsmail wurde nicht gesendet.');
    else if (!template) warnings.push('Terminbestätigungs-Vorlage fehlt.');
    else {
      const ctx = { ...buildLeadContext(lead, { ansprechpartner: body.ansprechpartner, absender: me?.displayName || smtp.senderName || '' }), ...buildAppointmentContext(appointment) };
      const subject = renderTemplate(template.subject, ctx);
      const html = renderTemplate(template.bodyHtml, ctx);
      try {
        await sendSmtpMail(smtp, { to: lead.email, subject, html, senderName: me?.displayName });
        await db
          .prepare('INSERT INTO activities (lead_id,type,detail,created_at) VALUES (?,?,?,?)')
          .bind(lead.id, 'email_sent', `Terminbestätigung → ${lead.email}`, new Date().toISOString())
          .run();
        mailStatus = 'sent';
      } catch (error) {
        mailStatus = 'failed';
        warnings.push(`Bestätigungsmail fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } else if (body.sendConfirmation && !lead.email) {
    warnings.push('Keine E-Mail-Adresse hinterlegt — Bestätigung nicht möglich.');
  }

  return Response.json({ appointment, warnings, mailStatus }, { status: 201 });
}

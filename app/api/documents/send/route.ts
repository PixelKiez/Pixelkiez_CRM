import { ensureDatabase, getD1, rowToInvoice, rowToLead, rowToTemplate } from '@/lib/database';
import { loadCompanyProfile, loadSmtpConfig } from '@/lib/settings';
import { buildDocumentContext, buildInvoiceExtras } from '@/lib/document-context';
import { renderTemplate } from '@/lib/template-render';
import { sendSmtpMail } from '@/lib/smtp';

const SENDABLE: Record<string, string> = { vertrag: 'Vertrag', rechnung: 'Rechnung', diagnose: 'Diagnose' };

/** Rahmen für den Anhang, damit die Datei allein geöffnet lesbar ist. */
function wrapDocument(title: string, body: string): string {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${title}</title><style>
body{margin:0;padding:40px;background:#fff;font-family:Arial,Helvetica,sans-serif;color:#1d2b25;font-size:13.5px;line-height:1.7;}
main{max-width:760px;margin:auto;}h1{font-size:23px;margin:0 0 22px;}h2{font-size:18px;margin:26px 0 10px;}h3{font-size:14px;margin:22px 0 6px;}
table{width:100%;border-collapse:collapse;margin:14px 0 20px;}td,th{padding:9px 10px;border-bottom:1px solid #e8ede9;text-align:left;vertical-align:top;}
tr.total td{font-weight:700;font-size:15px;border-top:2px solid #1d2b25;border-bottom:0;}
table.items td:last-child,table.items th:last-child{text-align:right;}
.footer{margin-top:34px;padding-top:12px;border-top:1px solid #e8ede9;font-size:10.5px;color:#68736e;}
.price{font-size:26px;font-weight:600;color:#0e5c40;}
@media print{body{padding:0;}}
</style></head><body><main>${body}</main></body></html>`;
}

export async function POST(request: Request) {
  await ensureDatabase();
  const body = (await request.json()) as { leadId?: string; kind?: string; to?: string; invoiceId?: number; message?: string };
  const leadId = body.leadId?.trim();
  const kind = body.kind?.trim() ?? '';
  if (!leadId || !SENDABLE[kind]) {
    return Response.json({ error: `leadId und eine gültige Art erforderlich (${Object.keys(SENDABLE).join(', ')}).` }, { status: 400 });
  }

  const db = getD1();
  const leadRow = await db.prepare('SELECT * FROM leads WHERE id=?').bind(leadId).first<Record<string, unknown>>();
  if (!leadRow) return Response.json({ error: 'Lead nicht gefunden.' }, { status: 404 });
  const lead = rowToLead(leadRow);

  const to = body.to?.trim() || lead.email || '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return Response.json({ error: 'Keine gültige Empfängeradresse hinterlegt.' }, { status: 400 });
  }

  const templateRow = await db.prepare('SELECT * FROM email_templates WHERE kind=? ORDER BY id LIMIT 1').bind(kind)
    .first<Record<string, unknown>>();
  if (!templateRow) return Response.json({ error: `Keine Vorlage für „${SENDABLE[kind]}" hinterlegt.` }, { status: 428 });
  const template = rowToTemplate(templateRow);

  const company = await loadCompanyProfile();
  let extras = {};
  if (kind === 'rechnung') {
    const invoiceRow = body.invoiceId
      ? await db.prepare('SELECT * FROM invoices WHERE id=? AND lead_id=?').bind(body.invoiceId, leadId).first<Record<string, unknown>>()
      : await db.prepare('SELECT * FROM invoices WHERE lead_id=? ORDER BY issued_at DESC LIMIT 1').bind(leadId).first<Record<string, unknown>>();
    if (!invoiceRow) return Response.json({ error: 'Für diesen Kunden existiert noch keine Rechnung.' }, { status: 428 });
    extras = buildInvoiceExtras(rowToInvoice(invoiceRow), company.invoice_service_label || 'Erstellung einer Webseite');
  }

  const context = buildDocumentContext(lead, company, extras);
  const documentHtml = renderTemplate(template.bodyHtml, context);
  const subject = renderTemplate(template.subject, context) || `${SENDABLE[kind]} · ${lead.name}`;

  const config = await loadSmtpConfig();
  if (!config) return Response.json({ error: 'SMTP ist nicht vollständig eingerichtet.' }, { status: 428 });

  const intro = body.message?.trim()
    ? `<p>${body.message.trim().replace(/\n/g, '<br/>')}</p>`
    : `<p>Guten Tag,</p><p>anbei erhalten Sie ${SENDABLE[kind] === 'Rechnung' ? 'Ihre Rechnung' : `Ihren ${SENDABLE[kind]}`} von ${company.company_name || 'Pixelkiez'}.</p>`;

  const filename = `${kind}-${lead.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'dokument'}.html`;

  try {
    await sendSmtpMail(config, {
      to,
      subject,
      html: `<div style="padding:26px 30px;">${intro}<p style="color:#68736e;font-size:12px;">Das vollständige Dokument finden Sie im Anhang.</p></div><hr style="border:0;border-top:1px solid #e3e8e5;"/><div style="padding:26px 30px;">${documentHtml}</div>`,
      attachments: [{ filename, content: wrapDocument(subject, documentHtml) }],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: `Versand fehlgeschlagen: ${message}` }, { status: 502 });
  }

  const now = new Date().toISOString();
  await db.prepare('INSERT INTO activities (lead_id,type,detail,created_at) VALUES (?,?,?,?)')
    .bind(leadId, 'document_sent', `${SENDABLE[kind]} an ${to} gesendet`, now).run();
  await db.prepare('UPDATE leads SET last_contact=?, updated_at=? WHERE id=?').bind(now, now, leadId).run();

  return Response.json({ ok: true, to, subject });
}

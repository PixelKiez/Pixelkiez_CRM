import { ensureDatabase, getD1, rowToInvoice } from '@/lib/database';
import { canInvoice } from '@/lib/crm-vocab';
import { loadCompanyProfile, saveSetting } from '@/lib/settings';

/** Baut die nächste Rechnungsnummer, z. B. PK-2026-0007. */
function formatNumber(prefix: string, counter: number): string {
  const base = prefix.trim() || `PK-${new Date().getFullYear()}-`;
  return `${base}${String(counter).padStart(4, '0')}`;
}

export async function GET(request: Request) {
  await ensureDatabase();
  const leadId = new URL(request.url).searchParams.get('leadId');
  const db = getD1();
  const sql = leadId
    ? 'SELECT i.*, l.name AS lead_name FROM invoices i LEFT JOIN leads l ON l.id=i.lead_id WHERE i.lead_id=? ORDER BY i.issued_at DESC'
    : 'SELECT i.*, l.name AS lead_name FROM invoices i LEFT JOIN leads l ON l.id=i.lead_id ORDER BY i.issued_at DESC LIMIT 200';
  const statement = leadId ? db.prepare(sql).bind(leadId) : db.prepare(sql);
  const { results } = await statement.all<Record<string, unknown>>();
  return Response.json({
    invoices: results.map(row => ({ ...rowToInvoice(row), leadName: (row.lead_name as string | null) ?? undefined })),
  });
}

export async function POST(request: Request) {
  await ensureDatabase();
  const body = (await request.json()) as { leadId?: string; netCents?: number; title?: string; serviceDate?: string };
  const leadId = body.leadId?.trim();
  if (!leadId) return Response.json({ error: 'leadId fehlt.' }, { status: 400 });

  const db = getD1();
  const lead = await db.prepare('SELECT id, status, price_cents FROM leads WHERE id=?').bind(leadId)
    .first<{ id: string; status: string; price_cents: number | null }>();
  if (!lead) return Response.json({ error: 'Lead nicht gefunden.' }, { status: 404 });

  // Fachliche Regel aus der Anforderung: Rechnungen nur für gewonnene Kunden.
  if (!canInvoice(lead.status)) {
    return Response.json(
      { error: `Rechnungen sind nur für gewonnene Kunden möglich. Aktueller Status: ${lead.status}.` },
      { status: 409 },
    );
  }

  const netCents = Number.isInteger(body.netCents) ? Number(body.netCents) : lead.price_cents;
  if (!netCents || netCents <= 0) {
    return Response.json({ error: 'Kein Festpreis hinterlegt. Bitte zuerst den Preis am Kunden eintragen.' }, { status: 400 });
  }

  const company = await loadCompanyProfile();
  const vatRate = Number(company.invoice_vat_rate) || 19;
  const vatCents = Math.round((netCents * vatRate) / 100);
  const now = new Date().toISOString();
  const prefix = company.invoice_prefix || `PK-${new Date().getFullYear()}-`;
  let counter = Number(company.invoice_next_number) || 1;

  // Die UNIQUE-Bedingung auf `number` ist die eigentliche Absicherung;
  // bei Kollision wird hochgezählt und erneut versucht.
  for (let attempt = 0; attempt < 10; attempt++) {
    const number = formatNumber(prefix, counter);
    try {
      await db.prepare(
        'INSERT INTO invoices (lead_id,number,issued_at,service_date,net_cents,vat_rate,vat_cents,gross_cents,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      ).bind(
        leadId, number, now, body.serviceDate || null, netCents, vatRate, vatCents, netCents + vatCents,
        body.title?.trim() || company.invoice_service_label || 'Erstellung einer Webseite', 'offen', now, now,
      ).run();

      await saveSetting('invoice_next_number', String(counter + 1));
      await db.prepare('INSERT INTO activities (lead_id,type,detail,created_at) VALUES (?,?,?,?)')
        .bind(leadId, 'invoice_created', `Rechnung ${number} erstellt`, now).run();

      const row = await db.prepare('SELECT * FROM invoices WHERE number=?').bind(number).first<Record<string, unknown>>();
      return Response.json({ invoice: rowToInvoice(row!) }, { status: 201 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/UNIQUE|constraint/i.test(message)) throw error;
      counter += 1;
    }
  }
  return Response.json({ error: 'Rechnungsnummer konnte nicht vergeben werden.' }, { status: 500 });
}

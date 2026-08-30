import { ensureDatabase, getD1, rowToInvoice } from '@/lib/database';
import { INVOICE_KIND_VALUES, canInvoice, invoiceKindTitle } from '@/lib/crm-vocab';
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
  const body = (await request.json()) as { leadId?: string; netCents?: number; title?: string; serviceDate?: string; kind?: string };
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

  const kind = body.kind?.trim() || 'komplett';
  if (!INVOICE_KIND_VALUES.includes(kind)) {
    return Response.json({ error: `Unbekannte Rechnungsart: ${kind}. Erlaubt: ${INVOICE_KIND_VALUES.join(', ')}` }, { status: 400 });
  }

  const price = lead.price_cents ?? 0;
  if (price <= 0 && !Number.isInteger(body.netCents)) {
    return Response.json({ error: 'Kein Festpreis hinterlegt. Bitte zuerst den Preis am Kunden eintragen.' }, { status: 400 });
  }

  // Bereits berechnete Beträge (Stornos zählen nicht mit).
  const existing = await db.prepare("SELECT kind, net_cents FROM invoices WHERE lead_id=? AND status<>'storniert'")
    .bind(leadId).all<{ kind: string; net_cents: number }>();
  const alreadyInvoiced = existing.results.reduce((sum, row) => sum + row.net_cents, 0);

  if (kind === 'anzahlung' && existing.results.some(row => row.kind === 'anzahlung')) {
    return Response.json({ error: 'Für diesen Kunden existiert bereits eine Anzahlungsrechnung.' }, { status: 409 });
  }

  const share = kind === 'komplett' ? 100 : 50;
  let netCents: number;
  if (Number.isInteger(body.netCents)) {
    netCents = Number(body.netCents);
  } else if (kind === 'anzahlung') {
    netCents = Math.round(price / 2);
  } else {
    // Restbetrag und Gesamtbetrag rechnen gegen bereits Berechnetes.
    netCents = price - alreadyInvoiced;
  }

  if (netCents <= 0) {
    return Response.json(
      { error: `Kein offener Betrag: Festpreis ${(price / 100).toFixed(2)} €, bereits berechnet ${(alreadyInvoiced / 100).toFixed(2)} €.` },
      { status: 409 },
    );
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
      const service = company.invoice_service_label || 'Erstellung einer Webseite';
      // Die Position trägt die Stufe, damit sie auch in unveränderten Vorlagen sichtbar ist.
      const title = body.title?.trim()
        || (kind === 'komplett' ? service : `${service} — ${invoiceKindTitle(kind)} (${share} %)`);

      await db.prepare(
        'INSERT INTO invoices (lead_id,number,issued_at,service_date,net_cents,vat_rate,vat_cents,gross_cents,title,status,kind,share_percent,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ).bind(
        leadId, number, now, body.serviceDate || null, netCents, vatRate, vatCents, netCents + vatCents,
        title, 'offen', kind, share, now, now,
      ).run();

      await saveSetting('invoice_next_number', String(counter + 1));
      await db.prepare('INSERT INTO activities (lead_id,type,detail,created_at) VALUES (?,?,?,?)')
        .bind(leadId, 'invoice_created', `${invoiceKindTitle(kind)} ${number} über ${(netCents / 100).toFixed(2)} € netto erstellt`, now).run();

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

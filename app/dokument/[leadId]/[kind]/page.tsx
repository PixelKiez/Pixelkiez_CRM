import { notFound } from 'next/navigation';
import { ensureDatabase, getD1, rowToInvoice, rowToLead, rowToTemplate } from '@/lib/database';
import { loadCompanyProfile } from '@/lib/settings';
import { buildDocumentContext, buildInvoiceExtras, splitSlides } from '@/lib/document-context';
import { renderTemplate, type TemplateContext } from '@/lib/template-render';
import Slides from './slides';
import DocumentToolbar from './toolbar';

export const dynamic = 'force-dynamic';

const KIND_TITLES: Record<string, string> = {
  praesentation: 'Präsentation',
  diagnose: 'Diagnose',
  vertrag: 'Vertrag',
  rechnung: 'Rechnung',
};

export default async function DocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ leadId: string; kind: string }>;
  searchParams: Promise<{ template?: string; invoice?: string }>;
}) {
  const { leadId, kind } = await params;
  const { template: templateSlug, invoice: invoiceId } = await searchParams;
  if (!KIND_TITLES[kind]) notFound();

  await ensureDatabase();
  const db = getD1();

  const leadRow = await db.prepare('SELECT * FROM leads WHERE id=?').bind(leadId).first<Record<string, unknown>>();
  if (!leadRow) notFound();
  const lead = rowToLead(leadRow);

  const templateRow = templateSlug
    ? await db.prepare('SELECT * FROM email_templates WHERE slug=?').bind(templateSlug).first<Record<string, unknown>>()
    : await db.prepare('SELECT * FROM email_templates WHERE kind=? ORDER BY id LIMIT 1').bind(kind).first<Record<string, unknown>>();

  if (!templateRow) {
    return (
      <main className="doc-shell">
        <div className="doc-empty">
          <h1>Keine Vorlage hinterlegt</h1>
          <p>Für „{KIND_TITLES[kind]}" existiert noch keine Vorlage. Lege sie im CRM unter <strong>Vorlagen</strong> an und wähle als Art „{KIND_TITLES[kind]}".</p>
          <a className="primary" href="/">Zurück zum CRM</a>
        </div>
      </main>
    );
  }
  const template = rowToTemplate(templateRow);
  const company = await loadCompanyProfile();

  let extras: TemplateContext = {};
  if (kind === 'rechnung') {
    const invoiceRow = invoiceId
      ? await db.prepare('SELECT * FROM invoices WHERE id=? AND lead_id=?').bind(invoiceId, leadId).first<Record<string, unknown>>()
      : await db.prepare('SELECT * FROM invoices WHERE lead_id=? ORDER BY issued_at DESC LIMIT 1').bind(leadId).first<Record<string, unknown>>();
    if (!invoiceRow) {
      return (
        <main className="doc-shell">
          <div className="doc-empty">
            <h1>Noch keine Rechnung</h1>
            <p>Für <strong>{lead.name}</strong> wurde bisher keine Rechnung erzeugt. Erstelle sie im Kundendatensatz — das ist nur bei gewonnenen Kunden möglich.</p>
            <a className="primary" href="/">Zurück zum CRM</a>
          </div>
        </main>
      );
    }
    extras = buildInvoiceExtras(rowToInvoice(invoiceRow), company.invoice_service_label || 'Erstellung einer Webseite');
  }

  const context = buildDocumentContext(lead, company, extras);
  const html = renderTemplate(template.bodyHtml, context);
  const title = `${KIND_TITLES[kind]} · ${lead.name}`;

  if (kind === 'praesentation') {
    return <Slides slides={splitSlides(html)} title={title} leadName={lead.name} />;
  }

  return (
    <main className="doc-shell">
      <DocumentToolbar title={title} />
      <article className={`doc-sheet doc-${kind}`} dangerouslySetInnerHTML={{ __html: html }} />
    </main>
  );
}

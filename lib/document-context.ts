/**
 * Baut den Platzhalter-Kontext für Präsentation, Diagnose, Vertrag und Rechnung.
 * Setzt auf `buildLeadContext` auf und ergänzt Preis, Anbieterdaten und Datum.
 */
import { formatEuro } from '@/lib/crm-vocab';
import { buildLeadContext, type TemplateContext } from '@/lib/template-render';
import type { CompanyKey } from '@/lib/settings';
import type { Invoice, Lead } from '@/lib/types';

const dateDE = (value: string | Date) =>
  new Date(value).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

export function buildDocumentContext(
  lead: Lead,
  company: Record<CompanyKey, string>,
  extras: TemplateContext = {},
): TemplateContext {
  return {
    ...buildLeadContext(lead, {
      absender: company.company_contact || company.company_name || '',
      absender_email: company.company_email || '',
      absender_telefon: company.company_phone || '',
    }),
    // Kundenbezogen
    preis: formatEuro(lead.priceCents),
    preis_netto: formatEuro(lead.priceCents),
    website_status: lead.websiteStatus,
    score: lead.score,
    naechste_aktion: lead.nextAction || 'Termin für das weitere Vorgehen abstimmen',
    notizen: lead.notes || '',
    datum: dateDE(new Date()),
    // Anbieterdaten
    anbieter_name: company.company_name || 'Pixelkiez',
    anbieter_strasse: company.company_street || '',
    anbieter_plz: company.company_zip || '',
    anbieter_ort: company.company_city || '',
    anbieter_steuernummer: company.company_tax_number || '',
    anbieter_ustid: company.company_vat_id || '',
    anbieter_bank: company.company_bank || '',
    anbieter_iban: company.company_iban || '',
    anbieter_bic: company.company_bic || '',
    anbieter_telefon: company.company_phone || '',
    anbieter_email: company.company_email || '',
    ...extras,
  };
}

/** Ergänzt die rechnungsspezifischen Platzhalter. */
export function buildInvoiceExtras(invoice: Invoice, serviceLabel: string): TemplateContext {
  return {
    rechnungsnummer: invoice.number,
    rechnungsdatum: dateDE(invoice.issuedAt),
    leistungsdatum: invoice.serviceDate ? dateDE(invoice.serviceDate) : dateDE(invoice.issuedAt),
    leistung: invoice.title || serviceLabel,
    netto: formatEuro(invoice.netCents),
    ust_satz: String(invoice.vatRate),
    ust_betrag: formatEuro(invoice.vatCents),
    brutto: formatEuro(invoice.grossCents),
  };
}

/** Trennt eine Präsentationsvorlage an `<!-- folie -->` in einzelne Folien. */
export function splitSlides(html: string): string[] {
  return html
    .split(/<!--\s*folie\s*-->/i)
    .map(part => part.trim())
    .filter(Boolean);
}

import type { Appointment, Lead } from '@/lib/types';

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Kontext-Objekt mit allen bekannten Platzhaltern (Werte werden HTML-escaped ausser für body-Templates schon vorbereitet). */
export type TemplateContext = Record<string, string | number | null | undefined>;

/** Ersetzt `{{key}}` Platzhalter. Unbekannte Keys bleiben leer. Werte werden HTML-escaped. */
export function renderTemplate(source: string, ctx: TemplateContext): string {
  return source.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    const value = ctx[key];
    if (value === undefined || value === null || value === '') return '';
    return escapeHtml(String(value));
  });
}

export function buildLeadContext(lead: Lead, extras: TemplateContext = {}): TemplateContext {
  const websiteHint = lead.websiteStatus === 'Nein'
    ? 'über keine eigene Webseite verfügt'
    : lead.websiteStatus === 'Prüfen'
      ? 'im Web nur schwer auffindbar ist'
      : 'seine Online-Sichtbarkeit noch nicht ausschöpft';
  return {
    firma: lead.name,
    branche: lead.category || 'Ihr Gewerbe',
    stadt: lead.city || 'Berlin',
    plz: lead.zip || '',
    strasse: lead.street || '',
    telefon: lead.phone || '',
    email: lead.email || '',
    website: lead.website || '',
    ansprechpartner: extras.ansprechpartner ?? '',
    website_hinweis: websiteHint,
    probleme: lead.problems || '',
    pitch: lead.pitch || '',
    status: lead.status,
    prioritaet: lead.priority,
    absender: extras.absender ?? '',
    ...extras,
  };
}

export function buildAppointmentContext(appt: Appointment): TemplateContext {
  const start = new Date(appt.startTs);
  const end = new Date(appt.endTs);
  const datum = start.toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' });
  const zeit = start.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const bisZeit = end.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  return {
    termin_titel: appt.title,
    termin_datum: datum,
    termin_zeit: zeit,
    termin_bis: bisZeit,
    termin_ort: appt.location || 'Telefon',
    termin_notiz: appt.notes || '',
    termin_link: appt.gcalLink || '',
  };
}

/** Sammelt alle {{platzhalter}} aus einem Text — nützlich fürs UI. */
export function extractPlaceholders(source: string): string[] {
  const set = new Set<string>();
  for (const match of source.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) set.add(match[1]);
  return [...set];
}

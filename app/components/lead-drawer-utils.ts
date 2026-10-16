import type { Lead } from '@/lib/types';
import { STATUS_OPTIONS } from '@/lib/crm-vocab';

export const statusOptions = STATUS_OPTIONS;
export type LeadDrawerTab = 'overview' | 'call' | 'email' | 'appointment' | 'activity';

export function monthsAhead(months: number): string {
  const date = new Date();
  date.setMonth(date.getMonth() + months);
  return date.toISOString().slice(0, 10);
}

export function centsToInput(cents: number | null | undefined): string {
  return typeof cents === 'number' ? (cents / 100).toFixed(2) : '';
}

export function inputToCents(value: string): number | null {
  const normalised = value.replace(/\s/g, '').replace(',', '.');
  if (!normalised) return null;
  const euro = Number(normalised);
  return Number.isFinite(euro) && euro >= 0 ? Math.round(euro * 100) : null;
}

export function leadLabel(value: string | null): string {
  return value ? value.replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Nicht angegeben';
}

export function contactHref(kind: string, value: string): string {
  return kind === 'phone'
    ? `tel:${value.replace(/\s/g, '')}`
    : kind === 'email'
      ? `mailto:${value}`
      : value.startsWith('http') ? value : `https://${value}`;
}

export function smartAction(lead: Lead): string {
  return lead.websiteStatus === 'Nein' && lead.phone
    ? 'Telefonischer Erstkontakt: lokales Webseiten-Paket anbieten'
    : lead.websiteStatus === 'Prüfen'
      ? 'Website und Firmenidentität vor der Ansprache verifizieren'
      : lead.email
        ? 'Kurze personalisierte E-Mail mit konkretem Verbesserungsvorschlag senden'
        : 'Kontaktdaten ergänzen und Ansprechpartner recherchieren';
}

function fmtLocalDatetime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function defaultStart(): string {
  const date = new Date();
  date.setMinutes(0, 0, 0);
  date.setDate(date.getDate() + 1);
  date.setHours(10);
  return fmtLocalDatetime(date);
}

export function addMinutes(iso: string, minutes: number): string {
  const date = new Date(iso);
  date.setMinutes(date.getMinutes() + minutes);
  return fmtLocalDatetime(date);
}

export function leadActivityLabel(type: string): string {
  return type === 'email_sent' ? 'E-Mail gesendet'
    : type === 'email_failed' ? 'Versand fehlgeschlagen'
      : type === 'created' ? 'Lead angelegt'
        : type === 'enriched' ? 'Angereichert (Agent)'
          : type === 'agent_note' ? 'Agent-Notiz'
            : type === 'appointment_created' ? 'Termin angelegt'
              : type === 'appointment_cancelled' ? 'Termin abgesagt'
                : 'Bearbeitet';
}

export type LeadAnalysisUiStatus =
  | 'idle'
  | 'loading'
  | 'not_connected'
  | 'invalid_website'
  | 'not_authorized'
  | 'unavailable';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Maps only fixed route codes; server-provided prose is deliberately ignored. */
export function mapLeadAnalysisResponse(httpStatus: number, payload: unknown): LeadAnalysisUiStatus {
  const code = isRecord(payload) ? payload.status : undefined;
  if (code === 'NOT_CONNECTED') return 'not_connected';
  if (code === 'INVALID_WEBSITE') return 'invalid_website';
  if (code === 'NOT_AUTHORIZED' || httpStatus === 401 || httpStatus === 403) return 'not_authorized';
  return 'unavailable';
}

/** Fixed, safe status copy; it never implies that a website was examined. */
export function leadAnalysisStatusMessage(status: LeadAnalysisUiStatus): string {
  switch (status) {
    case 'idle':
      return 'Beim Klick wird nur der gespeicherte Website-Eintrag geprüft. Es wird keine Website besucht.';
    case 'loading':
      return 'CRM-Anfrage läuft. Es wird keine Website besucht oder untersucht.';
    case 'not_connected':
      return 'Nicht verbunden. Es wurde keine Website untersucht.';
    case 'invalid_website':
      return 'Im Lead ist keine gültige Website gespeichert; es wurde nichts untersucht.';
    case 'not_authorized':
      return 'Sitzung oder Herkunft konnte nicht bestätigt werden; es wurde nichts untersucht.';
    case 'unavailable':
      return 'Die Funktion ist derzeit nicht verfügbar; es wurde keine Website untersucht.';
  }
}

/**
 * Einzige Quelle für Status- und Grundwerte.
 *
 * Oberfläche, REST-API und Agent-API greifen alle hierauf zu, damit ein Agent
 * keinen Status schreiben kann, den das Dashboard nicht kennt.
 */

export const STATUS_OPTIONS = [
  'Neu',
  'E Mail gesendet',
  'Recherche offen',
  'Telefonat geplant',
  'Erstgespräch geplant',
  'Angebot gesendet',
  'Wiedervorlage',
  'Gewonnen',
  'Verloren',
  'Ausgeschlossen',
] as const;
export type LeadStatus = (typeof STATUS_OPTIONS)[number];

/** Gewonnene Kunden — zählen in den Umsatz und dürfen Rechnungen bekommen. */
export const WON_STATUS = ['Gewonnen'] as const;
/** Endgültig verlorene Kunden. */
export const LOST_STATUS = ['Verloren', 'Ausgeschlossen'] as const;
/** Kunde bleibt interessiert, nur der Zeitpunkt passt nicht. */
export const RECONTACT_STATUS = 'Wiedervorlage';

export const isWon = (status: string) => (WON_STATUS as readonly string[]).includes(status);
export const isLost = (status: string) => (LOST_STATUS as readonly string[]).includes(status);
export const isRecontact = (status: string) => status === RECONTACT_STATUS;
/** Alles, was noch aktiv in Bearbeitung ist. */
export const isOpen = (status: string) => !isWon(status) && !isLost(status) && !isRecontact(status);

/**
 * Absage- und Verlaufsgründe, die Team und Agenten setzen können.
 * `keepsLead` markiert Gründe, bei denen der Kunde im System aktiv bleibt.
 */
export const LOST_REASONS = [
  { value: 'kein_interesse', label: 'Kein Interesse', keepsLead: false },
  { value: 'nicht_erreicht', label: 'Dreimal nicht erreicht', keepsLead: false },
  { value: 'keine_anrufe', label: 'Möchte nicht angerufen werden', keepsLead: false },
  { value: 'kein_budget', label: 'Kein Budget', keepsLead: false },
  { value: 'anderer_anbieter', label: 'Hat sich für einen anderen Anbieter entschieden', keepsLead: false },
  { value: 'spaeter', label: 'Interesse, aber späterer Zeitpunkt', keepsLead: true },
  { value: 'sonstiges', label: 'Sonstiger Grund', keepsLead: false },
] as const;
export type LostReason = (typeof LOST_REASONS)[number]['value'];

export const LOST_REASON_VALUES = LOST_REASONS.map(r => r.value) as readonly string[];
export const lostReasonLabel = (value: string | null | undefined) =>
  LOST_REASONS.find(r => r.value === value)?.label ?? (value || '');

/** Ab dieser Zahl erfolgloser Versuche schlägt die Oberfläche „nicht erreicht" vor. */
export const MAX_CONTACT_ATTEMPTS = 3;

/** Kunden mit diesem Grund dürfen nicht mehr angerufen werden. */
export const isCallBlocked = (reason: string | null | undefined) => reason === 'keine_anrufe';

/** Rechnungen sind nur für gewonnene Kunden zulässig. */
export const canInvoice = (status: string) => isWon(status);

export const formatEuro = (cents: number | null | undefined) =>
  typeof cents === 'number' && Number.isFinite(cents)
    ? (cents / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })
    : '—';

/** ISO-Woche als sortierbarer Schlüssel, z. B. 2026-W35. */
export function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export const monthKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

export const monthLabel = (key: string) => {
  const [year, month] = key.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString('de-DE', { month: 'short', year: 'numeric' });
};

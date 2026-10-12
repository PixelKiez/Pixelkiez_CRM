/**
 * Hält Status, Absagegrund, Wiedervorlage und Gewonnen-Datum widerspruchsfrei.
 *
 * Wird von der Oberfläche (`/api/leads/[id]`) und der Agent-API gleichermaßen
 * benutzt, damit ein Agent keinen Zustand erzeugen kann, den das Dashboard
 * falsch auswertet — etwa "Gewonnen" ohne Datum oder "Verloren" mit gesetzter
 * Wiedervorlage.
 */
import {
  LOST_REASONS,
  LOST_REASON_VALUES,
  MAX_CONTACT_ATTEMPTS,
  RECONTACT_STATUS,
  STATUS_OPTIONS,
  isLost,
  isWon,
} from '@/lib/crm-vocab';

/** Spaltennamen in der Datenbank für die vom Client erlaubten Felder. */
export const LEAD_COLUMNS: Record<string, string> = {
  status: 'status', priority: 'priority', score: 'score', name: 'name', category: 'category',
  street: 'street', zip: 'zip', city: 'city', phone: 'phone', email: 'email', website: 'website',
  websiteStatus: 'website_status', websiteClass: 'website_class', problems: 'problems', pitch: 'pitch',
  lastContact: 'last_contact', nextAction: 'next_action', followUp: 'follow_up', notes: 'notes',
  priceCents: 'price_cents', wonAt: 'won_at', lostReason: 'lost_reason',
  recontactAt: 'recontact_at', contactAttempts: 'contact_attempts',
  ownerEmail: 'owner_email',
};

export type LeadPatch = Record<string, unknown>;
export type SyncResult = { patch: LeadPatch; notes: string[] } | { error: string };

/**
 * Benannte Gesprächsausgänge für Agenten.
 * Ein Agent schickt `{"action":"nicht_erreicht"}` statt selbst Status, Grund
 * und Zähler konsistent halten zu müssen.
 */
export const AGENT_ACTIONS = ['nicht_erreicht', 'kein_interesse', 'keine_anrufe', 'spaeter', 'gewonnen'] as const;
export type AgentAction = (typeof AGENT_ACTIONS)[number];

export function actionToPatch(
  action: string,
  current: { status: string; contact_attempts?: unknown },
  options: { months?: number } = {},
): LeadPatch | { error: string } {
  const attempts = Number(current.contact_attempts ?? 0);
  switch (action) {
    case 'nicht_erreicht': {
      const next = attempts + 1;
      // Erst ab dem dritten erfolglosen Versuch gilt der Lead als verloren.
      return next >= MAX_CONTACT_ATTEMPTS
        ? { contactAttempts: next, lostReason: 'nicht_erreicht', status: 'Verloren' }
        : { contactAttempts: next, lastContact: new Date().toISOString() };
    }
    case 'kein_interesse':
      return { status: 'Verloren', lostReason: 'kein_interesse' };
    case 'keine_anrufe':
      return { status: 'Verloren', lostReason: 'keine_anrufe' };
    case 'spaeter':
      return { status: RECONTACT_STATUS, lostReason: 'spaeter', recontactAt: monthsFromNow(options.months ?? 6) };
    case 'gewonnen':
      return { status: 'Gewonnen' };
    default:
      return { error: `Unbekannte Aktion: ${action}. Erlaubt: ${AGENT_ACTIONS.join(', ')}` };
  }
}

const keepsLead = (reason: string) => LOST_REASONS.find(r => r.value === reason)?.keepsLead ?? false;

/**
 * PXK-133: Ein Lead-Feld ist ein Einzelwert. better-sqlite3 spreizt Arrays in die folgenden
 * SQL-Parameter und liest Objekte als benannte Parameter; true/false prüft syncLeadPatch gesondert.
 */
export const isNonScalar = (value: unknown) => typeof value === 'object' && value !== null;
export const invalidValueError = (key: string) => `Ungültiger Wert für ${key}: nur Text, Zahl oder null erlaubt.`;

/** Monate auf ein ISO-Datum addieren (für „Wiedervorlage in X Monaten"). */
export function monthsFromNow(months: number, from = new Date()): string {
  const date = new Date(from.getTime());
  date.setMonth(date.getMonth() + months);
  return date.toISOString().slice(0, 10);
}

/**
 * Prüft die Eingaben und ergänzt abhängige Felder.
 * `current` ist der Datenbankstand, `input` die gewünschte Änderung.
 */
export function syncLeadPatch(current: { status: string; won_at?: unknown; price_cents?: unknown }, input: LeadPatch): SyncResult {
  const patch: LeadPatch = {};
  const notes: string[] = [];

  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(LEAD_COLUMNS, key)) continue;
    if (isNonScalar(value)) return { error: invalidValueError(key) };
    patch[key] = value === '' ? null : value;
  }
  if (!Object.keys(patch).length) return { error: 'Keine gültige Änderung.' };

  // --- Wertebereiche prüfen -------------------------------------------------
  if (patch.status !== undefined && !(STATUS_OPTIONS as readonly string[]).includes(String(patch.status))) {
    return { error: `Unbekannter Status: ${String(patch.status)}` };
  }
  if (patch.lostReason !== undefined && patch.lostReason !== null && !LOST_REASON_VALUES.includes(String(patch.lostReason))) {
    return { error: `Unbekannter Grund: ${String(patch.lostReason)}` };
  }
  if (patch.priceCents !== undefined && patch.priceCents !== null) {
    const cents = Number(patch.priceCents);
    if (!Number.isFinite(cents) || cents < 0 || !Number.isInteger(cents)) {
      return { error: 'Preis muss eine ganze Zahl in Cent sein.' };
    }
    patch.priceCents = cents;
  }
  if (patch.contactAttempts !== undefined && patch.contactAttempts !== null) {
    const attempts = Number(patch.contactAttempts);
    if (!Number.isFinite(attempts) || attempts < 0) return { error: 'Kontaktversuche müssen eine Zahl ≥ 0 sein.' };
    patch.contactAttempts = Math.trunc(attempts);
  }
  // PXK-133: priceCents/contactAttempts sind hier schon Zahlen (true → 1 bleibt PXK-117), Status/Grund geprüft.
  const unbindable = Object.keys(patch).find(key => typeof patch[key] === 'boolean');
  if (unbindable) return { error: invalidValueError(unbindable) };

  // --- Grund bestimmt den Status -------------------------------------------
  // "Interesse, aber später" darf den Kunden nicht verlieren.
  if (patch.lostReason && patch.status === undefined) {
    const reason = String(patch.lostReason);
    patch.status = keepsLead(reason) ? RECONTACT_STATUS : 'Verloren';
    notes.push(`Status automatisch auf „${patch.status}" gesetzt`);
  }
  if (patch.lostReason && keepsLead(String(patch.lostReason)) && patch.recontactAt === undefined) {
    patch.recontactAt = monthsFromNow(6);
    notes.push('Wiedervorlage in 6 Monaten vorgemerkt');
  }

  // Wiedervorlagedatum ohne passenden Status -> Status nachziehen.
  if (patch.recontactAt && patch.status === undefined && !isWon(current.status)) {
    patch.status = RECONTACT_STATUS;
    notes.push('Status automatisch auf „Wiedervorlage" gesetzt');
  }

  const nextStatus = patch.status !== undefined ? String(patch.status) : current.status;

  // --- Gewonnen-Datum pflegen ----------------------------------------------
  if (isWon(nextStatus)) {
    if (!current.won_at && patch.wonAt === undefined) {
      patch.wonAt = new Date().toISOString();
      notes.push('Gewonnen-Datum gesetzt');
    }
    // Ein gewonnener Kunde hat weder Absagegrund noch Wiedervorlage.
    if (patch.lostReason === undefined) patch.lostReason = null;
    if (patch.recontactAt === undefined) patch.recontactAt = null;
  } else if (current.won_at && patch.wonAt === undefined) {
    patch.wonAt = null;
    notes.push('Gewonnen-Datum entfernt, da Status nicht mehr „Gewonnen"');
  }

  // --- Verloren: Wiedervorlage ergibt keinen Sinn ---------------------------
  if (isLost(nextStatus) && patch.recontactAt === undefined) patch.recontactAt = null;

  // --- Wiedervorlage braucht ein Datum --------------------------------------
  if (nextStatus === RECONTACT_STATUS && !patch.recontactAt) {
    patch.recontactAt = monthsFromNow(6);
    notes.push('Wiedervorlage ohne Datum — auf 6 Monate gesetzt');
  }

  return { patch, notes };
}

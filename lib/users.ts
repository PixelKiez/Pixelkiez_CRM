/**
 * Nutzerprofile.
 *
 * Die Anmeldung selbst prüft weiterhin `AUTH_USERS` (siehe lib/auth.ts) — hier
 * liegen nur Anzeigename, Signatur und der persönliche Kalenderzugang. Ein
 * Profil entsteht automatisch beim ersten Zugriff, damit niemand erst etwas
 * anlegen muss, bevor er arbeiten kann.
 */
import { getD1 } from '@/lib/database';

export type UserProfile = {
  email: string;
  displayName: string;
  signature: string;
  phone: string;
  googleEmail: string | null;
  googleCalendarId: string;
  googleConnected: boolean;
};

/** „ben.poersch@gmail.com" → „Ben Poersch" */
export function defaultDisplayName(email: string): string {
  const local = email.split('@')[0] ?? email;
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || email;
}

function toProfile(row: Record<string, unknown>): UserProfile {
  return {
    email: String(row.email),
    displayName: String(row.display_name || defaultDisplayName(String(row.email))),
    signature: (row.signature as string | null) ?? '',
    phone: (row.phone as string | null) ?? '',
    googleEmail: (row.google_email as string | null) ?? null,
    googleCalendarId: String(row.google_calendar_id || 'primary'),
    googleConnected: Boolean(row.google_tokens),
  };
}

/** Lädt das Profil und legt es beim ersten Mal an. */
export async function ensureUser(email: string): Promise<UserProfile> {
  const key = email.trim().toLowerCase();
  const db = getD1();
  const existing = await db.prepare('SELECT * FROM users WHERE email=?').bind(key).first<Record<string, unknown>>();
  if (existing) return toProfile(existing);

  const now = new Date().toISOString();
  await db.prepare(
    'INSERT INTO users (email,display_name,signature,phone,google_calendar_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(email) DO NOTHING',
  ).bind(key, defaultDisplayName(key), '', '', 'primary', now, now).run();

  const row = await db.prepare('SELECT * FROM users WHERE email=?').bind(key).first<Record<string, unknown>>();
  return toProfile(row!);
}

const EDITABLE: Record<string, string> = {
  displayName: 'display_name',
  signature: 'signature',
  phone: 'phone',
  googleCalendarId: 'google_calendar_id',
};

export async function saveUser(email: string, patch: Record<string, unknown>): Promise<UserProfile> {
  const key = email.trim().toLowerCase();
  await ensureUser(key);
  const changes = Object.entries(patch).filter(([field]) => EDITABLE[field]);
  if (changes.length) {
    const db = getD1();
    const sql = `UPDATE users SET ${changes.map(([f]) => `${EDITABLE[f]}=?`).join(', ')}, updated_at=? WHERE email=?`;
    await db.prepare(sql).bind(
      ...changes.map(([field, value]) => {
        const text = String(value ?? '').trim();
        // Ein leerer Anzeigename würde die Oberfläche und E-Mails entstellen.
        if (field === 'displayName' && !text) return defaultDisplayName(key);
        if (field === 'googleCalendarId' && !text) return 'primary';
        return text;
      }),
      new Date().toISOString(), key,
    ).run();
  }
  return ensureUser(key);
}

/** Alle bekannten Profile — für Zuständigkeits-Auswahl und Anzeige. */
export async function listUsers(): Promise<UserProfile[]> {
  const { results } = await getD1().prepare('SELECT * FROM users ORDER BY display_name COLLATE NOCASE').all<Record<string, unknown>>();
  return results.map(toProfile);
}

/** Persönliche Google-Tokens. */
export async function loadUserTokens(email: string): Promise<{ tokens: string | null; googleEmail: string | null; calendarId: string }> {
  const row = await getD1().prepare('SELECT google_tokens, google_email, google_calendar_id FROM users WHERE email=?')
    .bind(email.trim().toLowerCase()).first<{ google_tokens: string | null; google_email: string | null; google_calendar_id: string | null }>();
  return {
    tokens: row?.google_tokens ?? null,
    googleEmail: row?.google_email ?? null,
    calendarId: row?.google_calendar_id?.trim() || 'primary',
  };
}

export async function saveUserTokens(email: string, tokens: string, googleEmail: string | null): Promise<void> {
  const key = email.trim().toLowerCase();
  await ensureUser(key);
  await getD1().prepare('UPDATE users SET google_tokens=?, google_email=COALESCE(?,google_email), updated_at=? WHERE email=?')
    .bind(tokens, googleEmail, new Date().toISOString(), key).run();
}

export async function clearUserTokens(email: string): Promise<void> {
  await getD1().prepare('UPDATE users SET google_tokens=NULL, google_email=NULL, updated_at=? WHERE email=?')
    .bind(new Date().toISOString(), email.trim().toLowerCase()).run();
}

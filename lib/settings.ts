import { getD1 } from '@/lib/database';
import type { SmtpConfig } from '@/lib/smtp';

export const SMTP_KEYS = ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from', 'smtp_sender_name'] as const;
export type SmtpKey = (typeof SMTP_KEYS)[number];

export const AGENT_KEY_SETTING = 'agent_api_key';
export const GOOGLE_TOKEN_SETTING = 'google_oauth_tokens';
export const GOOGLE_EMAIL_SETTING = 'google_email';
export const GOOGLE_CALENDAR_SETTING = 'google_calendar_id';

export type StoredSettings = Partial<Record<SmtpKey, string>> & {
  smtp_pass_set: boolean;
  agent_api_key?: string;
  google_oauth_tokens?: string;
  google_email?: string;
  google_calendar_id?: string;
};

function envFallback(): Partial<Record<SmtpKey, string>> {
  return {
    smtp_host: process.env.SMTP_HOST,
    smtp_port: process.env.SMTP_PORT,
    smtp_user: process.env.SMTP_USER,
    smtp_pass: process.env.SMTP_PASS,
    smtp_from: process.env.SMTP_FROM,
    smtp_sender_name: process.env.SMTP_SENDER_NAME,
  };
}

/** Lädt gespeicherte SMTP-Einstellungen; env-Variablen füllen Lücken. */
export async function loadSmtpConfig(): Promise<SmtpConfig | null> {
  const stored = await loadStoredSettings();
  const fallback = envFallback();
  const get = (key: SmtpKey) => stored[key]?.trim() || fallback[key]?.trim() || '';
  const host = get('smtp_host');
  const user = get('smtp_user');
  const pass = get('smtp_pass');
  const from = get('smtp_from');
  if (!host || !user || !pass || !from) return null;
  const port = Number(get('smtp_port')) || 465;
  return { host, port, user, pass, from, senderName: get('smtp_sender_name') || undefined };
}

const ALL_KEYS = [...SMTP_KEYS, AGENT_KEY_SETTING, GOOGLE_TOKEN_SETTING, GOOGLE_EMAIL_SETTING, GOOGLE_CALENDAR_SETTING] as const;

export async function loadStoredSettings(): Promise<StoredSettings> {
  const db = getD1();
  const placeholders = ALL_KEYS.map(() => '?').join(',');
  const rows = await db.prepare(`SELECT key, value FROM settings WHERE key IN (${placeholders})`).bind(...ALL_KEYS).all<{ key: string; value: string }>();
  const result: StoredSettings = { smtp_pass_set: false };
  for (const row of rows.results) {
    if (row.key === 'smtp_pass') result.smtp_pass_set = Boolean(row.value);
    else if (row.key === AGENT_KEY_SETTING) result.agent_api_key = row.value;
    else if (row.key === GOOGLE_TOKEN_SETTING) result.google_oauth_tokens = row.value;
    else if (row.key === GOOGLE_EMAIL_SETTING) result.google_email = row.value;
    else if (row.key === GOOGLE_CALENDAR_SETTING) result.google_calendar_id = row.value;
    else result[row.key as Exclude<SmtpKey, 'smtp_pass'>] = row.value;
  }
  return result;
}

export async function saveSmtpSettings(patch: Record<string, string>): Promise<void> {
  const db = getD1();
  const entries = Object.entries(patch).filter(([key]) => (SMTP_KEYS as readonly string[]).includes(key));
  if (!entries.length) return;
  await db.batch(
    entries.map(([key, value]) =>
      db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key, String(value ?? '')),
    ),
  );
}

export async function saveSetting(key: string, value: string): Promise<void> {
  const db = getD1();
  await db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key, value).run();
}

export async function deleteSetting(key: string): Promise<void> {
  const db = getD1();
  await db.prepare('DELETE FROM settings WHERE key=?').bind(key).run();
}

/** Liest den Agent-API-Key aus DB → Fallback env AGENT_API_KEY. */
export async function loadAgentKey(): Promise<string | null> {
  const stored = await loadStoredSettings();
  return stored.agent_api_key?.trim() || process.env.AGENT_API_KEY?.trim() || null;
}

/** Erzeugt einen kryptographisch starken URL-sicheren Token. */
export function generateAgentKey(): string {
  const { randomBytes } = require('node:crypto') as typeof import('node:crypto');
  return randomBytes(32).toString('base64url');
}

export function maskKey(key: string | undefined | null): string | undefined {
  if (!key) return undefined;
  if (key.length <= 8) return `${key[0]}••••${key.slice(-2)}`;
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

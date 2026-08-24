import { getD1 } from '@/lib/database';
import type { SmtpConfig } from '@/lib/smtp';

export const SMTP_KEYS = ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from', 'smtp_sender_name'] as const;
export type SmtpKey = (typeof SMTP_KEYS)[number];

export type StoredSettings = Partial<Record<SmtpKey, string>> & { smtp_pass_set: boolean };

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

export async function loadStoredSettings(): Promise<StoredSettings> {
  const db = getD1();
  const rows = await db.prepare(`SELECT key, value FROM settings WHERE key IN ('smtp_host','smtp_port','smtp_user','smtp_pass','smtp_from','smtp_sender_name')`).all<{ key: string; value: string }>();
  const result: StoredSettings = { smtp_pass_set: false };
  for (const row of rows.results) {
    if (row.key === 'smtp_pass') result.smtp_pass_set = Boolean(row.value);
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

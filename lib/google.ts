import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import {
  GOOGLE_CALENDAR_SETTING,
  GOOGLE_EMAIL_SETTING,
  GOOGLE_TOKEN_SETTING,
  deleteSetting,
  loadStoredSettings,
  saveSetting,
} from '@/lib/settings';
import { clearUserTokens, loadUserTokens, saveUserTokens } from '@/lib/users';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
];

function envRedirectUri(): string {
  const configured = process.env.GOOGLE_REDIRECT_URI?.trim();
  if (configured) return configured;
  const base = process.env.APP_BASE_URL?.trim();
  if (base) return `${base.replace(/\/$/, '')}/api/auth/google/callback`;
  return 'http://localhost:3000/api/auth/google/callback';
}

/** Erzeugt einen OAuth2-Client mit Env-basierten Client-Credentials. */
export function createOAuthClient(): OAuth2Client {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET fehlen.');
  return new google.auth.OAuth2(clientId, clientSecret, envRedirectUri());
}

export function buildAuthUrl(state: string): string {
  return createOAuthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GOOGLE_SCOPES,
    state,
  });
}

/**
 * Lädt die Tokens des angegebenen Nutzers.
 *
 * Jeder verbindet seinen eigenen Google-Kalender; Termine landen dadurch bei
 * dem, der sie anlegt. Fehlt ein persönlicher Zugang, greift der frühere
 * gemeinsame Zugang aus den Einstellungen als Rückfallebene — sonst wären
 * bestehende Termine nach dem Umbau nicht mehr erreichbar.
 */
export async function loadOAuthClient(userEmail?: string | null): Promise<{ client: OAuth2Client; email: string | null; calendarId: string }> {
  const client = createOAuthClient();

  let raw: string | null = null;
  let googleEmail: string | null = null;
  let calendarId = 'primary';
  let persist: (value: string) => Promise<void>;

  const personal = userEmail ? await loadUserTokens(userEmail) : null;
  if (personal?.tokens) {
    raw = personal.tokens;
    googleEmail = personal.googleEmail;
    calendarId = personal.calendarId;
    persist = value => saveUserTokens(userEmail!, value, googleEmail);
  } else {
    const stored = await loadStoredSettings();
    if (!stored.google_oauth_tokens) throw new Error('Google ist noch nicht verbunden.');
    raw = stored.google_oauth_tokens;
    googleEmail = stored.google_email ?? null;
    calendarId = stored.google_calendar_id?.trim() || 'primary';
    persist = value => saveSetting(GOOGLE_TOKEN_SETTING, value);
  }

  const tokens = JSON.parse(raw);
  client.setCredentials(tokens);
  client.on('tokens', async next => {
    // Refresh-Response mergen und dort ablegen, wo sie hergekommen ist
    await persist(JSON.stringify({ ...tokens, ...next }));
  });
  return { client, email: googleEmail, calendarId };
}

export async function exchangeCodeForTokens(code: string, userEmail?: string | null): Promise<{ email: string; tokens: unknown }> {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  const oauth = google.oauth2({ version: 'v2', auth: client });
  const info = await oauth.userinfo.get();
  const email = info.data.email ?? '';

  if (userEmail) await saveUserTokens(userEmail, JSON.stringify(tokens), email || null);
  else {
    await saveSetting(GOOGLE_TOKEN_SETTING, JSON.stringify(tokens));
    if (email) await saveSetting(GOOGLE_EMAIL_SETTING, email);
  }
  return { email, tokens };
}

export async function disconnectGoogle(userEmail?: string | null): Promise<void> {
  if (userEmail) {
    await clearUserTokens(userEmail);
    return;
  }
  await deleteSetting(GOOGLE_TOKEN_SETTING);
  await deleteSetting(GOOGLE_EMAIL_SETTING);
  await deleteSetting(GOOGLE_CALENDAR_SETTING);
}

export async function createCalendarEvent(input: {
  summary: string;
  description?: string;
  location?: string;
  startIso: string;
  endIso: string;
  attendeeEmail?: string;
  timeZone?: string;
  /** Kalender dieses Nutzers verwenden. */
  userEmail?: string | null;
}): Promise<{ id: string; htmlLink: string | null }> {
  const { client, calendarId } = await loadOAuthClient(input.userEmail);
  const calendar = google.calendar({ version: 'v3', auth: client });
  const timeZone = input.timeZone || 'Europe/Berlin';
  const response = await calendar.events.insert({
    calendarId,
    sendUpdates: input.attendeeEmail ? 'all' : 'none',
    requestBody: {
      summary: input.summary,
      description: input.description,
      location: input.location,
      start: { dateTime: input.startIso, timeZone },
      end: { dateTime: input.endIso, timeZone },
      attendees: input.attendeeEmail ? [{ email: input.attendeeEmail }] : undefined,
      reminders: { useDefault: true },
    },
  });
  return { id: response.data.id!, htmlLink: response.data.htmlLink ?? null };
}

export async function deleteCalendarEvent(eventId: string, userEmail?: string | null): Promise<void> {
  const { client, calendarId } = await loadOAuthClient(userEmail);
  const calendar = google.calendar({ version: 'v3', auth: client });
  await calendar.events.delete({ calendarId, eventId, sendUpdates: 'all' }).catch(() => undefined);
}

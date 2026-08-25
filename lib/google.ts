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

/** Lädt gespeicherte Tokens; erstellt einen initialisierten OAuth-Client oder wirft. */
export async function loadOAuthClient(): Promise<{ client: OAuth2Client; email: string | null; calendarId: string }> {
  const client = createOAuthClient();
  const stored = await loadStoredSettings();
  if (!stored.google_oauth_tokens) throw new Error('Google ist noch nicht verbunden.');
  const tokens = JSON.parse(stored.google_oauth_tokens);
  client.setCredentials(tokens);
  client.on('tokens', async next => {
    // Refresh-Response mergen und persistieren
    const merged = { ...tokens, ...next };
    await saveSetting(GOOGLE_TOKEN_SETTING, JSON.stringify(merged));
  });
  return {
    client,
    email: stored.google_email ?? null,
    calendarId: stored.google_calendar_id?.trim() || 'primary',
  };
}

export async function exchangeCodeForTokens(code: string): Promise<{ email: string; tokens: unknown }> {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  const oauth = google.oauth2({ version: 'v2', auth: client });
  const info = await oauth.userinfo.get();
  const email = info.data.email ?? '';
  await saveSetting(GOOGLE_TOKEN_SETTING, JSON.stringify(tokens));
  if (email) await saveSetting(GOOGLE_EMAIL_SETTING, email);
  return { email, tokens };
}

export async function disconnectGoogle(): Promise<void> {
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
}): Promise<{ id: string; htmlLink: string | null }> {
  const { client, calendarId } = await loadOAuthClient();
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

export async function deleteCalendarEvent(eventId: string): Promise<void> {
  const { client, calendarId } = await loadOAuthClient();
  const calendar = google.calendar({ version: 'v3', auth: client });
  await calendar.events.delete({ calendarId, eventId, sendUpdates: 'all' }).catch(() => undefined);
}

import { NextResponse } from 'next/server';
import { findUser, loadUsers, verifyPassword } from '@/lib/auth';
import { SESSION_COOKIE, SESSION_MAX_AGE, createSessionToken, getAuthSecret } from '@/lib/session';

// scrypt braucht die Node-Runtime.
export const runtime = 'nodejs';

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map<string, { count: number; resetAt: number }>();

function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || request.headers.get('x-real-ip')?.trim() || 'unbekannt';
}

/** Einfache Bremse gegen Passwort-Raten. Zählt Fehlversuche je IP. */
function registerAttempt(ip: string): boolean {
  const now = Date.now();
  if (attempts.size > 5000) {
    for (const [key, value] of attempts) if (value.resetAt <= now) attempts.delete(key);
  }
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt <= now) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_ATTEMPTS;
}

export async function POST(request: Request) {
  const secret = getAuthSecret();
  if (!secret) {
    return NextResponse.json({ error: 'Server nicht konfiguriert: AUTH_SECRET fehlt.' }, { status: 503 });
  }
  if (!loadUsers().length) {
    return NextResponse.json({ error: 'Server nicht konfiguriert: AUTH_USERS fehlt.' }, { status: 503 });
  }

  const ip = clientIp(request);
  if (registerAttempt(ip)) {
    return NextResponse.json({ error: 'Zu viele Fehlversuche. Bitte in 15 Minuten erneut versuchen.' }, { status: 429 });
  }

  let email = '';
  let password = '';
  try {
    const body = (await request.json()) as { email?: unknown; password?: unknown };
    email = typeof body.email === 'string' ? body.email : '';
    // Randständige Leerzeichen stammen aus Passwortmanagern und Mobiltastaturen
    // und sind nie Teil des Passworts.
    password = typeof body.password === 'string' ? body.password.trim() : '';
  } catch {
    return NextResponse.json({ error: 'Ungültige Anfrage.' }, { status: 400 });
  }

  if (!email.trim() || !password) {
    return NextResponse.json({ error: 'E-Mail und Passwort sind erforderlich.' }, { status: 400 });
  }

  const user = findUser(email);
  // Gleiche Meldung für unbekannte Adresse und falsches Passwort, damit sich
  // gültige Adressen nicht erraten lassen.
  if (!user || !verifyPassword(password, user)) {
    return NextResponse.json({ error: 'E-Mail oder Passwort ist falsch.' }, { status: 401 });
  }

  attempts.delete(ip);
  const response = NextResponse.json({ ok: true, email: user.email });
  response.cookies.set(SESSION_COOKIE, await createSessionToken(user.email, secret), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_MAX_AGE,
  });
  return response;
}

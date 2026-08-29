/**
 * Signierte Session-Cookies auf Basis der Web-Crypto-API.
 *
 * Bewusst ohne `node:crypto`, damit dieselbe Datei in der Middleware (Edge-
 * Runtime) und in Route-Handlern (Node-Runtime) funktioniert.
 *
 * Token-Format: `<base64url(payload)>.<base64url(hmac-sha256)>`
 */

export const SESSION_COOKIE = 'crm_session';
/** Gültigkeit einer Anmeldung in Sekunden (7 Tage). */
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

export type Session = { sub: string; exp: number };

/** Liest das Signaturgeheimnis; zu kurze Werte gelten als nicht gesetzt. */
export function getAuthSecret(): string | null {
  const secret = process.env.AUTH_SECRET?.trim();
  return secret && secret.length >= 16 ? secret : null;
}

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function signPayload(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return toBase64Url(new Uint8Array(signature));
}

/** Erzeugt ein signiertes Token für die angegebene E-Mail-Adresse. */
export async function createSessionToken(email: string, secret: string): Promise<string> {
  const session: Session = { sub: email, exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE };
  const payload = toBase64Url(encoder.encode(JSON.stringify(session)));
  return `${payload}.${await signPayload(payload, secret)}`;
}

/** Prüft Signatur und Ablaufzeit. Gibt bei jedem Fehler `null` zurück. */
export async function verifySessionToken(token: string, secret: string): Promise<Session | null> {
  const separator = token.indexOf('.');
  if (separator < 1) return null;

  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!constantTimeEqual(signature, await signPayload(payload, secret))) return null;

  try {
    const session = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as Session;
    if (typeof session.sub !== 'string' || typeof session.exp !== 'number') return null;
    if (session.exp * 1000 <= Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

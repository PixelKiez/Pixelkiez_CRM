/**
 * Ermittelt den angemeldeten Nutzer in Server-Komponenten und Route-Handlern.
 *
 * Die Middleware lässt nur gültige Sitzungen durch; hier wird das Cookie nur
 * noch gelesen, um zu wissen, *wer* gerade arbeitet.
 */
import { cookies } from 'next/headers';
import { SESSION_COOKIE, getAuthSecret, verifySessionToken } from '@/lib/session';
import { ensureUser, type UserProfile } from '@/lib/users';

/** E-Mail des angemeldeten Nutzers, ohne Datenbankzugriff. */
export async function currentUserEmail(): Promise<string | null> {
  const secret = getAuthSecret();
  if (!secret) return null;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await verifySessionToken(token, secret);
  return session?.sub ?? null;
}

/** Vollständiges Profil; legt es beim ersten Aufruf an. */
export async function currentProfile(): Promise<UserProfile | null> {
  const email = await currentUserEmail();
  return email ? ensureUser(email) : null;
}

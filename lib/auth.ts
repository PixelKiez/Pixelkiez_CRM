/**
 * Benutzerverwaltung für die CRM-Anmeldung.
 *
 * Die Zugangsdaten liegen in der Environment-Variable `AUTH_USERS` statt in der
 * Datenbank: Die SQLite-Datei (siehe `lib/d1-node.ts`) liegt auf Railway ohne
 * gemountetes Volume im Container und wäre nach jedem Deploy leer.
 *
 * Format (Komma-getrennt, Werte in Hex):
 *   AUTH_USERS="anna@example.de:<salt>:<hash>,bernd@example.de:<salt>:<hash>"
 *
 * Einträge erzeugt `node scripts/create-user.mjs <email> <passwort>`.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;

export type CrmUser = { email: string; salt: string; hash: string };

/** Parst `AUTH_USERS`; unvollständige Einträge werden übersprungen. */
export function loadUsers(): CrmUser[] {
  const raw = process.env.AUTH_USERS?.trim();
  if (!raw) return [];

  const users: CrmUser[] = [];
  for (const entry of raw.split(',')) {
    const parts = entry.trim().split(':');
    if (parts.length !== 3) continue;
    const [email, salt, hash] = parts.map(part => part.trim());
    if (!email || !salt || !hash) continue;
    users.push({ email: email.toLowerCase(), salt, hash });
  }
  return users;
}

export function findUser(email: string): CrmUser | null {
  const needle = email.trim().toLowerCase();
  return loadUsers().find(user => user.email === needle) ?? null;
}

/** Leitet Salt und Hash für ein Passwort ab (scrypt, 64 Byte). */
export function hashPassword(password: string, salt = randomBytes(16).toString('hex')): { salt: string; hash: string } {
  return { salt, hash: scryptSync(password, salt, KEY_LENGTH).toString('hex') };
}

/** Vergleicht ein Passwort laufzeitkonstant gegen den gespeicherten Hash. */
export function verifyPassword(password: string, user: CrmUser): boolean {
  const expected = Buffer.from(user.hash, 'hex');
  // Buffer.from ignoriert ungültige Hex-Zeichen still — Länge prüfen.
  if (expected.length !== KEY_LENGTH) return false;
  return timingSafeEqual(scryptSync(password, user.salt, KEY_LENGTH), expected);
}

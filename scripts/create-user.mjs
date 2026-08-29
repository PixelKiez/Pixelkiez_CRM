#!/usr/bin/env node
/**
 * Erzeugt einen Eintrag für die Environment-Variable AUTH_USERS.
 *
 *   node scripts/create-user.mjs anna@firma.de 'Passwort123'
 *
 * Ohne Argumente wird zusätzlich ein passendes AUTH_SECRET vorgeschlagen.
 * Mehrere Nutzer werden in AUTH_USERS mit Komma getrennt.
 */
import { randomBytes, scryptSync } from 'node:crypto';

const KEY_LENGTH = 64;
const [email, password] = process.argv.slice(2);

if (!email || !password) {
  console.error('Aufruf: node scripts/create-user.mjs <email> <passwort>\n');
  console.error('Frisches AUTH_SECRET (falls noch keines gesetzt ist):');
  console.error(`  AUTH_SECRET=${randomBytes(32).toString('base64url')}`);
  process.exit(1);
}

if (email.includes(':') || email.includes(',')) {
  console.error('Die E-Mail-Adresse darf weder ":" noch "," enthalten.');
  process.exit(1);
}

if (password.length < 10) {
  console.error('Bitte ein Passwort mit mindestens 10 Zeichen verwenden.');
  process.exit(1);
}

const salt = randomBytes(16).toString('hex');
const hash = scryptSync(password, salt, KEY_LENGTH).toString('hex');

console.log(`${email.toLowerCase()}:${salt}:${hash}`);

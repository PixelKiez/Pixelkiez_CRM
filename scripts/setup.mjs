#!/usr/bin/env node
/**
 * Einmaliges Cloudflare-Setup für das CRM:
 *  1. Prüft Wrangler-Login
 *  2. Legt die D1-Datenbank an (oder findet eine bestehende)
 *  3. Speichert die Datenbank-ID in d1-database-id.txt
 *
 * Danach genügt:  npm run deploy
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DB_NAME = 'reinickendorf-crm';
const idFile = resolve(process.cwd(), 'd1-database-id.txt');
const wr = (...args) => execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

console.log('① Prüfe Cloudflare-Login …');
let who;
try {
  who = wr('whoami');
} catch {
  console.error('\n✖ Nicht eingeloggt. Bitte zuerst ausführen:\n\n    npx wrangler login\n\n(öffnet den Browser – danach dieses Skript erneut starten)\n');
  process.exit(1);
}
const accountLine = who.split('\n').find(l => /@/.test(l));
if (!/You are logged in|logged in/i.test(who)) {
  console.error('✖ Login-Status unklar. Bitte erneut versuchen oder manuell einloggen.');
  process.exit(1);
}
console.log(`   eingeloggt als ${accountLine?.trim() || 'Cloudflare-Konto'} ✓`);

if (existsSync(idFile)) {
  console.log(`② Datenbank-ID bereits vorhanden (${readFileSync(idFile, 'utf8').trim().slice(0, 12)}…) – überspringe Anlage.`);
} else {
  console.log(`② Suche D1-Datenbank "${DB_NAME}" …`);
  let existingId;
  try {
    const list = JSON.parse(wr('d1', 'list', '--json'));
    const found = Array.isArray(list) ? list.find(db => db.name === DB_NAME) : null;
    existingId = found?.uuid ?? found?.database_id;
  } catch { /* Liste nicht lesbar – Anlage folgt */ }

  if (existingId) {
    console.log(`   bestehende Datenbank gefunden ✓`);
  } else {
    console.log(`   lege neue Datenbank an …`);
    const out = wr('d1', 'create', DB_NAME);
    const match = out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (!match) { console.error('✖ Konnte Datenbank-ID aus der Ausgabe nicht lesen:\n' + out); process.exit(1); }
    existingId = match[0];
  }
  writeFileSync(idFile, existingId + '\n');
  console.log(`   gespeichert in d1-database-id.txt ✓`);
}

console.log(`
✔ Setup abgeschlossen!

Nächster Schritt – deployen:

    npm run deploy

Die App ist danach unter https://${DB_NAME}.<dein-account>.workers.dev erreichbar
(exakte URL zeigt der Deploy-Befehl). Schema + 952 Start-Leads werden beim
ersten Aufruf automatisch angelegt.`);

#!/usr/bin/env node
/**
 * Deployt das CRM zu Cloudflare Workers:  npm run deploy
 * (Einmaliges Setup vorher: npm run setup)
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const databaseId =
  process.env.D1_DATABASE_ID ??
  (existsSync(resolve(process.cwd(), 'd1-database-id.txt')) ? readFileSync(resolve(process.cwd(), 'd1-database-id.txt'), 'utf8').trim() : '');

if (!databaseId || !/^[0-9a-f-]{36}$/i.test(databaseId)) {
  console.error('\n✖ Keine gültige D1-Datenbank-ID gefunden.\n');
  console.error('  Einmalig einrichten (Login prüfen, Datenbank anlegen, ID speichern):\n');
  console.error('    npm run setup\n');
  process.exit(1);
}

const serverDir = resolve(process.cwd(), 'dist/server');
const configPath = resolve(serverDir, 'wrangler.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));

const workerName = process.env.WORKER_NAME || 'reinickendorf-crm';
config.name = workerName;
const d1 = config.d1_databases?.[0];
if (!d1) {
  console.error('✖ Keine D1-Bindung in dist/server/wrangler.json gefunden.');
  process.exit(1);
}
d1.database_name = process.env.D1_NAME || 'reinickendorf-crm';
d1.database_id = databaseId;

writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log(`→ Wrangler-Konfiguration geschrieben (Worker "${workerName}", D1 ${d1.database_name}).`);

execSync('npx wrangler deploy', { cwd: serverDir, stdio: 'inherit' });
console.log('\n✔ Deploy abgeschlossen. Erster Aufruf erstellt Schema + Seed automatisch.');

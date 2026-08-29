import { requireAgentAuth } from '@/lib/agent-auth';
import { ensureDatabase } from '@/lib/database';

/** Einfacher Auth-Check für Hermes. Antwortet mit 200 + { ok:true } wenn der Bearer stimmt. */
export async function GET(request: Request) {
  // requireAgentAuth liest die settings-Tabelle — die muss vorher existieren.
  await ensureDatabase();
  const denied = await requireAgentAuth(request);
  if (denied) return denied;
  return Response.json({ ok: true, service: 'reinickendorf-crm', time: new Date().toISOString() });
}

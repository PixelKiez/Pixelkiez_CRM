import { requireAgentAuth } from '@/lib/agent-auth';

/** Einfacher Auth-Check für Hermes. Antwortet mit 200 + { ok:true } wenn der Bearer stimmt. */
export async function GET(request: Request) {
  const denied = await requireAgentAuth(request);
  if (denied) return denied;
  return Response.json({ ok: true, service: 'reinickendorf-crm', time: new Date().toISOString() });
}

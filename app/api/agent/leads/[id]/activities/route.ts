import { requireAgentAuth } from '@/lib/agent-auth';
import { ensureDatabase, getD1 } from '@/lib/database';

/** Fügt eine Aktivitätsnotiz zum Lead hinzu (z. B. Recherche-Log, Website-Analyse, Anruf-Ergebnis). */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await requireAgentAuth(request);
  if (denied) return denied;
  await ensureDatabase();
  const { id } = await context.params;
  const body = (await request.json()) as { type?: string; detail?: string };
  const type = (body.type || 'agent_note').trim();
  const detail = (body.detail || '').trim();
  if (!detail) return Response.json({ error: 'detail fehlt.' }, { status: 400 });
  const now = new Date().toISOString();
  await getD1()
    .prepare('INSERT INTO activities (lead_id,type,detail,created_at) VALUES (?,?,?,?)')
    .bind(id, type, detail, now)
    .run();
  return Response.json({ ok: true });
}

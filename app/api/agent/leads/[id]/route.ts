import { requireAgentAuth } from '@/lib/agent-auth';
import { ensureDatabase, getD1, rowToLead } from '@/lib/database';
import { AGENT_ACTIONS, LEAD_COLUMNS, actionToPatch, invalidValueError, isNonScalar, syncLeadPatch } from '@/lib/lead-sync';

/**
 * Enrich / Update eines Leads durch den Agent.
 *
 * Nimmt entweder einzelne Felder oder eine benannte Aktion entgegen:
 *   { "action": "nicht_erreicht" }
 *   { "action": "spaeter", "months": 6 }
 *   { "status": "Gewonnen", "priceCents": 149000 }
 *
 * Läuft durch dieselbe Synchronisation wie die Oberfläche, damit Agenten keine
 * Zustände erzeugen können, die das Dashboard falsch auswertet.
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await requireAgentAuth(request);
  if (denied) return denied;
  await ensureDatabase();

  const { id } = await context.params;
  const body = (await request.json()) as Record<string, unknown> & { action?: string; months?: number };
  const db = getD1();

  const current = await db.prepare('SELECT status, won_at, price_cents, contact_attempts FROM leads WHERE id=?').bind(id)
    .first<{ status: string; won_at: string | null; price_cents: number | null; contact_attempts: number }>();
  if (!current) return Response.json({ error: 'Lead nicht gefunden.' }, { status: 404 });

  // PXK-133: action/months als Array oder Objekt würden still umgedeutet (Audit-Text, Monatszahl).
  if (isNonScalar(body.action)) return Response.json({ error: invalidValueError('action'), allowedActions: AGENT_ACTIONS }, { status: 400 });
  // PXK-133: action als Zahl oder Wahrheitswert wurde still übergangen, die übrigen Felder trotzdem geschrieben
  // (bei true/5 sogar als „Agent-Aktion: …“ protokolliert). null bleibt wie bisher „keine Aktion“.
  if (body.action !== undefined && body.action !== null && typeof body.action !== 'string') {
    return Response.json({ error: `Ungültige Aktion: action muss Text sein. Erlaubt: ${AGENT_ACTIONS.join(', ')}`, allowedActions: AGENT_ACTIONS }, { status: 400 });
  }
  if (isNonScalar(body.months)) return Response.json({ error: invalidValueError('months') }, { status: 400 });

  let input: Record<string, unknown> = {};
  if (typeof body.action === 'string') {
    const fromAction = actionToPatch(body.action, current, { months: Number(body.months) || undefined });
    if ('error' in fromAction) return Response.json({ error: fromAction.error, allowedActions: AGENT_ACTIONS }, { status: 400 });
    input = fromAction;
  }
  // Ausdrücklich gesetzte Felder haben Vorrang vor der Aktion.
  for (const [key, value] of Object.entries(body)) {
    if (key !== 'action' && key !== 'months') input[key] = value;
  }

  const result = syncLeadPatch(current, input);
  if ('error' in result) return Response.json({ error: result.error }, { status: 400 });

  const changes = Object.entries(result.patch);
  const now = new Date().toISOString();
  const sql = `UPDATE leads SET ${changes.map(([key]) => `${LEAD_COLUMNS[key]}=?`).join(', ')}, updated_at=? WHERE id=?`;
  await db.prepare(sql).bind(...changes.map(([, value]) => value), now, id).run();

  const detail = [
    body.action ? `Agent-Aktion: ${body.action}` : `Agent aktualisierte: ${changes.map(([key]) => key).join(', ')}`,
    ...result.notes,
  ].join(' · ');
  await db.prepare('INSERT INTO activities (lead_id,type,detail,created_at) VALUES (?,?,?,?)')
    .bind(id, 'enriched', detail, now).run();

  const row = await db.prepare('SELECT * FROM leads WHERE id=?').bind(id).first<Record<string, unknown>>();
  if (!row) return Response.json({ error: 'Lead nicht gefunden.' }, { status: 404 });
  return Response.json({ lead: rowToLead(row), notes: result.notes });
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await requireAgentAuth(request);
  if (denied) return denied;
  await ensureDatabase();
  const { id } = await context.params;
  const row = await getD1().prepare('SELECT * FROM leads WHERE id=?').bind(id).first<Record<string, unknown>>();
  if (!row) return Response.json({ error: 'Lead nicht gefunden.' }, { status: 404 });
  return Response.json({ lead: rowToLead(row) });
}

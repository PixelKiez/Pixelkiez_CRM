import { requireAgentAuth } from '@/lib/agent-auth';
import { ensureDatabase, getD1, rowToLead } from '@/lib/database';

/**
 * Duplikat-Check für den Agent vor dem Anlegen:
 * GET /api/agent/leads/search?website=…&phone=…&name=…
 * Gibt bis zu 10 Kandidaten zurück.
 */
export async function GET(request: Request) {
  const denied = await requireAgentAuth(request);
  if (denied) return denied;
  await ensureDatabase();
  const url = new URL(request.url);
  const website = url.searchParams.get('website')?.trim().toLowerCase();
  const phone = url.searchParams.get('phone')?.replace(/\s/g, '');
  const name = url.searchParams.get('name')?.trim();
  const clauses: string[] = [];
  const args: unknown[] = [];
  if (website) { clauses.push('LOWER(website) LIKE ?'); args.push(`%${website}%`); }
  if (phone) { clauses.push("REPLACE(phone,' ','') = ?"); args.push(phone); }
  if (name) { clauses.push('LOWER(name) LIKE ?'); args.push(`%${name.toLowerCase()}%`); }
  if (!clauses.length) return Response.json({ error: 'website, phone oder name Parameter erforderlich.' }, { status: 400 });
  const { results } = await getD1()
    .prepare(`SELECT * FROM leads WHERE ${clauses.join(' OR ')} LIMIT 10`)
    .bind(...args)
    .all();
  return Response.json({ leads: results.map(r => rowToLead(r as Record<string, unknown>)) });
}

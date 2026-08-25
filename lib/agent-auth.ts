import { loadAgentKey } from '@/lib/settings';

const NO_KEY_ERROR = { error: 'Agent-API ist nicht aktiviert. Setze einen Key in den Einstellungen.' };
const BAD_KEY_ERROR = { error: 'Ungültiges Bearer-Token.' };

/**
 * Prüft `Authorization: Bearer <token>` gegen den konfigurierten Agent-Key.
 * Gibt bei Fehler ein fertiges `Response` zurück, sonst `null`.
 */
export async function requireAgentAuth(request: Request): Promise<Response | null> {
  const expected = await loadAgentKey();
  if (!expected) return Response.json(NO_KEY_ERROR, { status: 503 });

  const header = request.headers.get('authorization') || request.headers.get('Authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  if (!token || !constantTimeEqual(token, expected)) return Response.json(BAD_KEY_ERROR, { status: 401 });
  return null;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

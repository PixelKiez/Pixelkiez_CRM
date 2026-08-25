import { randomBytes } from 'node:crypto';
import { buildAuthUrl } from '@/lib/google';

/** Startet den OAuth-Flow: 302 → Google Consent-Screen. */
export async function GET() {
  try {
    const state = randomBytes(16).toString('hex');
    const url = buildAuthUrl(state);
    return Response.redirect(url, 302);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 500 });
  }
}

import { ensureDatabase } from '@/lib/database';
import { exchangeCodeForTokens } from '@/lib/google';

/** Nimmt den Auth-Code entgegen, tauscht Tokens aus, redirected zur Einstellungen-Seite. */
export async function GET(request: Request) {
  await ensureDatabase();
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const back = new URL('/', url.origin);
  back.hash = 'settings';
  if (error) { back.searchParams.set('google', 'error'); back.searchParams.set('detail', error); return Response.redirect(back.toString(), 302); }
  if (!code) { back.searchParams.set('google', 'missing_code'); return Response.redirect(back.toString(), 302); }
  try {
    const { email } = await exchangeCodeForTokens(code);
    back.searchParams.set('google', 'connected');
    if (email) back.searchParams.set('email', email);
  } catch (err) {
    back.searchParams.set('google', 'error');
    back.searchParams.set('detail', err instanceof Error ? err.message : String(err));
  }
  return Response.redirect(back.toString(), 302);
}

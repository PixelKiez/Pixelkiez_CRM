import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, getAuthSecret, verifySessionToken } from '@/lib/session';

/** Ohne Anmeldung erreichbar: Login-Seite, Login-Endpunkt, Health-Check. */
const PUBLIC_PATHS = ['/login', '/api/auth/login', '/api/health'];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some(path => pathname === path || pathname.startsWith(`${path}/`));
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Die Agent-API authentifiziert sich per Bearer-Token (lib/agent-auth.ts)
  // und darf nicht zusätzlich ein Session-Cookie verlangen.
  if (pathname.startsWith('/api/agent/')) return NextResponse.next();
  if (isPublic(pathname)) return NextResponse.next();

  const secret = getAuthSecret();
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  // Fehlt AUTH_SECRET, bleibt alles gesperrt — der Login-Endpunkt meldet warum.
  const session = secret && token ? await verifySessionToken(token, secret) : null;
  if (session) return NextResponse.next();

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Nicht angemeldet.' }, { status: 401 });
  }

  const target = request.nextUrl.clone();
  target.pathname = '/login';
  target.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname + request.nextUrl.search)}`;
  return NextResponse.redirect(target);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|woff2?)$).*)'],
};

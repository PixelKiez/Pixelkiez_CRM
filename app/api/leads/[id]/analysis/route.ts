import { currentUserEmail } from '@/lib/current-user';
import { verifyMigrated } from '@/lib/d1-node';
import { openDatabase, resolveDbPath } from '@/lib/db/open.mjs';
import { isValidStoredWebsite, PXAPI_PROVIDER_ENABLED } from '@/lib/pxapi-analysis';

type RouteContext = { params: Promise<{ id: string }> };

function respond(status: string, message: string, httpStatus: number): Response {
  return Response.json(
    { status, message },
    { status: httpStatus, headers: { 'Cache-Control': 'no-store' } },
  );
}

function hasSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    const parsedOrigin = new URL(origin);
    return parsedOrigin.origin === origin && parsedOrigin.origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  if (!hasSameOrigin(request)) {
    return respond('NOT_AUTHORIZED', 'Die Herkunft der Anfrage konnte nicht bestätigt werden; es wurde nichts untersucht.', 403);
  }

  let userEmail: string | null;
  try {
    userEmail = await currentUserEmail();
  } catch {
    return respond('NOT_AUTHORIZED', 'Die Sitzung konnte nicht bestätigt werden; es wurde nichts untersucht.', 401);
  }
  if (!userEmail) {
    return respond('NOT_AUTHORIZED', 'Eine gültige CRM-Sitzung ist erforderlich; es wurde nichts untersucht.', 401);
  }

  let id: string;
  try {
    ({ id } = await context.params);
  } catch {
    return respond('ANALYSIS_UNAVAILABLE', 'Die Anfrage konnte nicht verarbeitet werden; es wurde nichts untersucht.', 400);
  }
  if (!id || id.length > 128 || id !== id.trim() || /[\u0000-\u001f\u007f]/.test(id)) {
    return respond('ANALYSIS_UNAVAILABLE', 'Die Lead-Kennung ist ungültig; es wurde nichts untersucht.', 400);
  }

  let leadFound = false;
  let storedWebsite: unknown;
  try {
    const database = openDatabase(resolveDbPath(), 'inspect');
    try {
      verifyMigrated(database);
      const row = database.prepare('SELECT website FROM leads WHERE id=?').get(id) as { website?: unknown } | undefined;
      leadFound = row !== undefined;
      storedWebsite = row?.website;
    } finally {
      database.close();
    }
  } catch {
    return respond('ANALYSIS_UNAVAILABLE', 'Die gespeicherte Lead-Website konnte nicht geprüft werden; es wurde nichts untersucht.', 503);
  }

  if (!leadFound) {
    return respond('ANALYSIS_UNAVAILABLE', 'Der Lead wurde nicht gefunden; es wurde nichts untersucht.', 404);
  }
  if (!isValidStoredWebsite(storedWebsite)) {
    return respond('INVALID_WEBSITE', 'Im Lead ist keine gültige Website gespeichert; es wurde nichts untersucht.', 400);
  }

  if (!PXAPI_PROVIDER_ENABLED) {
    return respond('NOT_CONNECTED', 'Die PXAPI ist in Phase A deaktiviert; es wurde keine Website untersucht.', 503);
  }

  return respond('ANALYSIS_UNAVAILABLE', 'Die Funktion ist nicht verfügbar; es wurde keine Website untersucht.', 503);
}

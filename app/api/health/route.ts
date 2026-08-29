/**
 * Öffentlicher Health-Check für Railway (siehe `railway.json`).
 * Bewusst ohne Anmeldung und ohne Datenbankzugriff, damit ein Deployment nicht
 * an einer fehlenden Session oder einem kalten DB-Start scheitert.
 */
export async function GET() {
  return Response.json({ ok: true });
}

import { ensureDatabase } from '@/lib/database';
import { currentUserEmail } from '@/lib/current-user';
import { ensureUser, listUsers, saveUser } from '@/lib/users';

export async function GET() {
  await ensureDatabase();
  const email = await currentUserEmail();
  if (!email) return Response.json({ error: 'Nicht angemeldet.' }, { status: 401 });
  const [profile, users] = await Promise.all([ensureUser(email), listUsers()]);
  return Response.json({ profile, users });
}

export async function PUT(request: Request) {
  await ensureDatabase();
  const email = await currentUserEmail();
  if (!email) return Response.json({ error: 'Nicht angemeldet.' }, { status: 401 });
  const body = (await request.json()) as Record<string, unknown>;
  // Jeder pflegt ausschliesslich das eigene Profil — die Adresse kommt aus
  // der Sitzung, nicht aus der Anfrage.
  const profile = await saveUser(email, body);
  return Response.json({ profile });
}

import { ensureDatabase } from '@/lib/database';
import { currentUserEmail } from '@/lib/current-user';
import { disconnectGoogle } from '@/lib/google';

export async function POST() {
  await ensureDatabase();
  await disconnectGoogle(await currentUserEmail());
  return Response.json({ ok: true });
}

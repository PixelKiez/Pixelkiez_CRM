import { ensureDatabase } from '@/lib/database';
import { disconnectGoogle } from '@/lib/google';

export async function POST() {
  await ensureDatabase();
  await disconnectGoogle();
  return Response.json({ ok: true });
}

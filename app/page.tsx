import { cookies } from 'next/headers';
import CrmApp from './crm-app';
import { SESSION_COOKIE, getAuthSecret, verifySessionToken } from '@/lib/session';

export default async function Home() {
  // Die Middleware lässt nur angemeldete Aufrufe durch; hier wird die Session
  // nur noch gelesen, um den angemeldeten Nutzer anzuzeigen.
  const secret = getAuthSecret();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = secret && token ? await verifySessionToken(token, secret) : null;

  return <CrmApp userEmail={session?.sub ?? null} />;
}

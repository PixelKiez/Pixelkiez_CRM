import type { Metadata } from 'next';
import LoginForm from './login-form';

export const metadata: Metadata = {
  title: 'Anmelden · Pixelkiez CRM',
  robots: { index: false, follow: false },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next } = await searchParams;
  const target = Array.isArray(next) ? next[0] : next;
  // Nur seiteninterne Ziele zulassen, damit der Parameter nicht als
  // Weiterleitung auf fremde Domains missbraucht werden kann.
  const safeNext = target && target.startsWith('/') && !target.startsWith('//') ? target : '/';

  return <LoginForm next={safeNext} />;
}

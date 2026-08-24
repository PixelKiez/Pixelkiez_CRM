import { ensureDatabase } from '@/lib/database';
import { loadSmtpConfig, loadStoredSettings, saveSmtpSettings } from '@/lib/settings';
import { sendSmtpMail } from '@/lib/smtp';

function masked(settings: Awaited<ReturnType<typeof loadStoredSettings>>) {
  return {
    smtp_host: settings.smtp_host ?? '',
    smtp_port: Number(settings.smtp_port ?? '') || '',
    smtp_user: settings.smtp_user ?? '',
    smtp_from: settings.smtp_from ?? '',
    smtp_sender_name: settings.smtp_sender_name ?? '',
    smtp_pass_set: settings.smtp_pass_set,
  };
}

export async function GET() {
  await ensureDatabase();
  const [settings, active] = await Promise.all([loadStoredSettings(), loadSmtpConfig()]);
  return Response.json({ settings: masked(settings), active: Boolean(active), host: active?.host ?? null, from: active?.from ?? null });
}

export async function PUT(request: Request) {
  await ensureDatabase();
  const body = (await request.json()) as Record<string, unknown>;
  const patch: Record<string, string> = {};
  for (const key of ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from', 'smtp_sender_name']) {
    if (typeof body[key] === 'string' && (key !== 'smtp_pass' || (body[key] as string).length > 0)) patch[key] = body[key] as string;
  }
  await saveSmtpSettings(patch);
  const settings = await loadStoredSettings();
  return Response.json({ ok: true, settings: masked(settings) });
}

export async function POST(request: Request) {
  await ensureDatabase();
  const body = (await request.json()) as { to?: string };
  const to = body.to?.trim();
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return Response.json({ error: 'Gültige Test-Empfängeradresse erforderlich.' }, { status: 400 });
  const config = await loadSmtpConfig();
  if (!config) return Response.json({ error: 'SMTP unvollständig: Host, Benutzer, Passwort und Absender werden benötigt.' }, { status: 428 });
  try {
    await sendSmtpMail(config, {
      to,
      subject: 'Testmail – Reinickendorf Akquise OS',
      html: '<h2 style="margin-top:0;">Verbindung steht ✅</h2><p>Dein CRM ist erfolgreich mit dem Postfach verbunden.</p><p style="color:#68736e;font-size:12px;">Gesendet über ' + config.host + ':' + config.port + '</p>',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: `Test fehlgeschlagen: ${message}` }, { status: 502 });
  }
  return Response.json({ ok: true });
}

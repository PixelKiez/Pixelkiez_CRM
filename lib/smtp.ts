import { connect } from 'cloudflare:sockets';

export type SmtpConfig = {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  senderName?: string;
};

const TIMEOUT_MS = 15_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function b64(input: string): string {
  const bytes = encoder.encode(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

class TimeoutError extends Error {}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${label}: Zeitüberschreitung (${TIMEOUT_MS / 1000}s).`)), TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

class SmtpSession {
  private socket: Socket;
  private writer: WritableStreamDefaultWriter;
  private reader: ReadableStreamDefaultReader;
  private buffer = '';

  constructor(socket: Socket) {
    this.socket = socket;
    this.writer = socket.writable.getWriter();
    this.reader = socket.readable.getReader();
  }

  private async pump(): Promise<void> {
    const { value, done } = await this.reader.read();
    if (done) throw new Error('Verbindung wurde vom Server geschlossen.');
    this.buffer += decoder.decode(value, { stream: true });
  }

  /** Liest eine vollständige Antwort — mehrzeilig ("250-…") bis zur Finalzeile ("250 …"). */
  async read(): Promise<string> {
    let reply = '';
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline === -1) {
        await withTimeout(this.pump(), 'Warten auf Serverantwort');
        continue;
      }
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      reply += `${line}\n`;
      if (/^\d{3} /.test(line)) return reply;
    }
  }

  code(reply: string): number {
    return Number(reply.slice(0, 3));
  }

  write(line: string): void {
    void this.writer.write(encoder.encode(`${line}\r\n`));
  }

  async command(line: string, expected: number, label: string): Promise<string> {
    this.write(line);
    const reply = await this.read();
    if (this.code(reply) !== expected) throw new Error(`${label} fehlgeschlagen: ${reply.trim()}`);
    return reply;
  }

  close(): void {
    try {
      this.write('QUIT');
    } catch {
      /* Verbindung ggf. bereits geschlossen */
    }
    void this.socket.close().catch(() => {});
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function htmlToText(html: string): string {
  return escapeHtml(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );
}

function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${b64(value)}?=`;
}

/** Baut RFC-5322-Nachricht mit multipart/alternative (Text + HTML). */
function buildMessage(cfg: SmtpConfig, to: string, subject: string, html: string): string {
  const boundary = `----=_rk_${crypto.randomUUID().replaceAll('-', '')}`;
  const domain = cfg.from.split('@')[1] || 'localhost';
  const fromName = cfg.senderName?.trim();
  const date = new Date().toUTCString().replace('GMT', '+0000');
  return [
    `From: ${fromName ? `${encodeHeader(fromName)} <${cfg.from}>` : cfg.from}`,
    `To: <${to}>`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${date}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    htmlToText(html),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    `<!doctype html><html lang="de"><body style="margin:0;background:#f4f6f5;padding:32px 12px;font-family:Arial,Helvetica,sans-serif;color:#18221f;"><div style="max-width:600px;margin:auto;background:#ffffff;border-radius:12px;border:1px solid #e3e8e5;overflow:hidden;">${html}</div></body></html>`,
    `--${boundary}--`,
    '',
  ]
    .join('\r\n')
    .replace(/\r\n\./g, '\r\n..');
}

/**
 * Sendet eine E-Mail über einen klassischen SMTP-Server (z. B. smtp.hostinger.com).
 * Port 465 → implizites TLS, Port 587 → STARTTLS. Nutzt cloudflare:sockets.
 */
export async function sendSmtpMail(
  cfg: SmtpConfig,
  mail: { to: string; subject: string; html: string },
): Promise<void> {
  const implicitTls = cfg.port === 465;
  const socket = connect(`${cfg.host}:${cfg.port}`, {
    secureTransport: implicitTls ? 'on' : 'starttls',
    allowHalfOpen: false,
  });
  const session = new SmtpSession(socket);
  try {
    const greeting = await withTimeout(session.read(), 'Verbindungsaufbau');
    if (session.code(greeting) !== 220) throw new Error(`Server begrüßt nicht: ${greeting.trim()}`);

    const ehlo = () => session.command(`EHLO akquise.local`, 250, 'EHLO');
    await ehlo();

    if (!implicitTls) {
      await session.command('STARTTLS', 220, 'STARTTLS');
      await socket.startTls();
      await ehlo();
    }

    const authPlain = btoa(`\0${cfg.user}\0${cfg.pass}`);
    await session.command(`AUTH PLAIN ${authPlain}`, 235, 'Anmeldung');

    await session.command(`MAIL FROM:<${cfg.from}>`, 250, 'Absender');
    await session.command(`RCPT TO:<${mail.to}>`, 250, 'Empfänger');
    await session.command('DATA', 354, 'Datenübergabe');

    session.write(buildMessage(cfg, mail.to, mail.subject, mail.html));
    session.write('.');
    const accepted = await session.read();
    if (session.code(accepted) !== 250) throw new Error(`Nachricht abgelehnt: ${accepted.trim()}`);
  } catch (error) {
    session.close();
    if (error instanceof TypeError && /startTls|secure/i.test(String(error.message)))
      throw new Error(`TLS-Fehler: ${error.message}. Prüfe Port (465 oder 587).`);
    throw error;
  }
  session.close();
}

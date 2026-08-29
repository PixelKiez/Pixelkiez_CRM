import nodemailer from 'nodemailer';

export type SmtpConfig = {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  senderName?: string;
};

/**
 * Sendet eine E-Mail über einen klassischen SMTP-Server (z. B. smtp.hostinger.com).
 * Port 465 → implizites TLS, Port 587 → STARTTLS (nodemailer regelt beides).
 */
export type MailAttachment = { filename: string; content: string; contentType?: string };

export async function sendSmtpMail(
  cfg: SmtpConfig,
  mail: { to: string; subject: string; html: string; attachments?: MailAttachment[] },
): Promise<void> {
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });

  try {
    await transporter.sendMail({
      from: cfg.senderName?.trim() ? { name: cfg.senderName.trim(), address: cfg.from } : cfg.from,
      to: mail.to,
      subject: mail.subject,
      attachments: mail.attachments?.map(file => ({
        filename: file.filename,
        content: file.content,
        contentType: file.contentType ?? 'text/html; charset=utf-8',
      })),
      html: `<!doctype html><html lang="de"><body style="margin:0;background:#f4f6f5;padding:32px 12px;font-family:Arial,Helvetica,sans-serif;color:#18221f;"><div style="max-width:600px;margin:auto;background:#ffffff;border-radius:12px;border:1px solid #e3e8e5;overflow:hidden;">${mail.html}</div></body></html>`,
      text: mail.html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`SMTP-Fehler (${cfg.host}:${cfg.port}): ${message}`);
  }
}

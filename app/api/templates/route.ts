import { ensureDatabase, getD1, rowToTemplate } from '@/lib/database';

export async function GET() {
  await ensureDatabase();
  const { results } = await getD1()
    .prepare('SELECT * FROM email_templates ORDER BY kind, name COLLATE NOCASE')
    .all<Record<string, unknown>>();
  return Response.json({ templates: results.map(rowToTemplate) });
}

export async function POST(request: Request) {
  await ensureDatabase();
  const body = (await request.json()) as { slug?: string; name?: string; kind?: string; subject?: string; bodyHtml?: string };
  const name = body.name?.trim();
  const subject = body.subject?.trim();
  const bodyHtml = body.bodyHtml?.trim();
  if (!name || !subject || !bodyHtml)
    return Response.json({ error: 'Name, Betreff und Inhalt sind erforderlich.' }, { status: 400 });
  const slug = (body.slug?.trim() || slugify(name)) + '_' + Date.now().toString(36);
  const kind = body.kind?.trim() || 'general';
  const now = new Date().toISOString();
  const db = getD1();
  await db
    .prepare('INSERT INTO email_templates (slug,name,kind,subject,body_html,updated_at) VALUES (?,?,?,?,?,?)')
    .bind(slug, name, kind, subject, bodyHtml, now)
    .run();
  const row = await db.prepare('SELECT * FROM email_templates WHERE slug=?').bind(slug).first<Record<string, unknown>>();
  return Response.json({ template: rowToTemplate(row!) }, { status: 201 });
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'vorlage';
}

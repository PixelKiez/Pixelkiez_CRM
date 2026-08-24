/**
 * In-Memory-Mock des CRM-Backends für die lokale Vorschau ohne Server.
 * Ersetzt window.fetch und simuliert alle API-Routen gegen die Seed-Daten.
 */
import seedLeads from '../data/leads.json';

type Lead = Record<string, unknown> & { id: string };

const db = {
  leads: structuredClone(seedLeads) as Lead[],
  activities: [] as Array<Record<string, unknown>>,
  settings: { smtp_host: 'smtp.hostinger.com', smtp_port: 465 } as Record<string, unknown>,
};

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
let seq = Date.now();

function logActivity(leadId: string, type: string, detail: string) {
  const lead = db.leads.find(l => l.id === leadId);
  db.activities.unshift({ id: seq++, lead_id: leadId, type, detail, created_at: new Date().toISOString(), name: lead?.name ?? '' });
}

function stats() {
  const t = db.leads;
  const n = (f: (l: Lead) => boolean) => t.filter(f).length;
  return {
    total: t.length,
    withoutWebsite: n(l => l.websiteStatus === 'Nein'),
    checking: n(l => l.websiteStatus === 'Prüfen'),
    withWebsite: n(l => l.websiteStatus === 'Ja'),
    contacted: n(l => l.status !== 'Neu'),
    highPriority: n(l => l.priority === 'Hoch'),
    withPhone: n(l => !!l.phone),
    withEmail: n(l => !!l.email),
  };
}

async function route(method: string, url: string, body: unknown): Promise<{ status: number; data: unknown }> {
  await wait(120 + Math.random() * 180); // echte Netzwerk-Latenz simulieren
  const path = url.split('?')[0];
  const parts = path.split('/').filter(Boolean);

  if (method === 'GET' && path === '/api/leads') {
    const counts: Record<string, number> = {};
    for (const l of db.leads) counts[String(l.status)] = (counts[String(l.status)] ?? 0) + 1;
    return { status: 200, data: { leads: db.leads, stats: stats(), statusCounts: counts, activities: db.activities.slice(0, 14) } };
  }

  if (parts[0] === 'api' && parts[1] === 'leads' && parts.length === 3) {
    const id = decodeURIComponent(parts[2]);
    const idx = db.leads.findIndex(l => l.id === id);
    if (method === 'GET') {
      if (idx < 0) return { status: 404, data: { error: 'Lead nicht gefunden.' } };
      return { status: 200, data: { lead: db.leads[idx], activities: db.activities.filter(a => a.lead_id === id) } };
    }
    if (method === 'PATCH') {
      if (idx < 0) return { status: 404, data: { error: 'Lead nicht gefunden.' } };
      const patch = body as Record<string, unknown>;
      db.leads[idx] = { ...db.leads[idx], ...patch, updatedAt: new Date().toISOString() };
      logActivity(id, 'updated', `Aktualisiert: ${Object.keys(patch).join(', ')}`);
      return { status: 200, data: { lead: db.leads[idx] } };
    }
    if (method === 'DELETE') {
      if (idx < 0) return { status: 404, data: { error: 'Lead nicht gefunden.' } };
      db.leads.splice(idx, 1);
      db.activities = db.activities.filter(a => a.lead_id !== id);
      return { status: 200, data: { ok: true } };
    }
  }

  if (method === 'POST' && path === '/api/leads') {
    const b = body as Record<string, string>;
    if (!b.name?.trim()) return { status: 400, data: { error: 'Unternehmensname fehlt.' } };
    const nums = db.leads.map(l => Number(String(l.id).replace('PK-', '')) || 0);
    const id = `PK-${String(Math.max(0, ...nums) + 1).padStart(4, '0')}`;
    const lead: Lead = {
      id, status: 'Neu', priority: b.priority || 'Mittel', score: 50, name: b.name.trim(),
      category: b.category || null, street: null, zip: b.zip || null, city: 'Berlin',
      phone: b.phone || null, email: b.email || null, website: null,
      websiteStatus: b.websiteStatus || 'Prüfen', websiteClass: null, ageScore: 0,
      problems: null, pitch: null, source: 'Manuell angelegt',
      lastContact: null, nextAction: b.nextAction || 'Erstkontakt vorbereiten',
      followUp: null, notes: null, updatedAt: new Date().toISOString(),
    };
    db.leads.unshift(lead);
    logActivity(id, 'created', 'Lead manuell angelegt');
    return { status: 201, data: { lead } };
  }

  if (method === 'POST' && path === '/api/email/send') {
    const b = body as { leadId?: string; to?: string; subject?: string };
    const to = b.to || db.leads.find(l => l.id === b.leadId)?.email;
    if (!to) return { status: 400, data: { error: 'Kein gültiger Empfänger vorhanden.' } };
    await wait(700);
    if (b.leadId) {
      const lead = db.leads.find(l => l.id === b.leadId);
      if (lead) lead.lastContact = new Date().toISOString();
      logActivity(b.leadId, 'email_sent', `${b.subject} → ${to} (Vorschau-Simulation)`);
    }
    return { status: 200, data: { ok: true, to } };
  }

  if (path === '/api/settings') {
    if (method === 'GET')
      return { status: 200, data: { settings: { smtp_host: db.settings.smtp_host ?? '', smtp_port: db.settings.smtp_port ?? '', smtp_user: '', smtp_from: '', smtp_sender_name: '', smtp_pass_set: false }, active: false, host: null, from: null } };
    if (method === 'PUT') { Object.assign(db.settings, body as Record<string, unknown>); return { status: 200, data: { ok: true } }; }
    if (method === 'POST') { await wait(900); return { status: 200, data: { ok: true } }; }
  }

  return { status: 404, data: { error: `Vorschau: Route unbekannt (${method} ${path})` } };
}

const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url.replace(location.origin, '');
  const method = init?.method ?? 'GET';
  let body: unknown;
  try { body = init?.body ? JSON.parse(init.body as string) : undefined; } catch { body = undefined; }
  const result = await route(method, String(url), body);
  return new Response(JSON.stringify(result.data), { status: result.status, headers: { 'Content-Type': 'application/json' } });
};

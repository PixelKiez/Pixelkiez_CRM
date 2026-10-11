/**
 * PXK-114 Charakterisierung der Agent-API-Handler (Anlegen, Suche, Lesen, PATCH, Aktivitäten) auf Handler-Ebene:
 * echter Request, echte Wegwerf-SQLite. Auth-Matrix und Ping: agent-auth.test.ts.
 * KNOWN_WEAKNESS(<Kategorie>, <Jira>) markiert Verhalten, das das genannte Ticket bewusst ändert; der Test hält es
 * nur fest und erklärt es nicht für akzeptabel.
 * Block 2i (PXK-133) prüft zusätzlich den Browser-PATCH /api/leads/[id] auf dieselbe Ablehnung (CI erlaubt genau fünf Testdateien).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TEST_AGENT_KEY as KEY, bearer, callRoute, getLead, loadAgentRoutes, patchLead as patch, postActivity as addActivity, postLeads as post, searchLeads as search,
  type RouteResult,
} from '../support/route';
import { createTestDb, disposeAll, type SeedLead, type TestDb, type TestDbOptions } from '../support/test-db';
import { LEAD_COLUMNS } from '@/lib/lead-sync';

const NOW = '2026-10-10T12:00:00.000Z';
const ALLOWED_ACTIONS = ['nicht_erreicht', 'kein_interesse', 'keine_anrufe', 'spaeter', 'gewonnen'];
const ALLOWED = `Erlaubt: ${ALLOWED_ACTIONS.join(', ')}`;
const BIND_ERROR = 'SQLite3 can only bind numbers, strings, bigints, buffers, and null';
const INJECTED = 'PXK114_INJECTED_ACTIVITY_FAILURE';
const TOO_FEW = 'Too few parameter values were provided';
const TOO_MANY = 'Too many parameter values were provided';
const SEEDED_AT = '2026-01-01T00:00:00.000Z';
const INVALID = (key: string) => `Ungültiger Wert für ${key}: nur Text, Zahl oder null erlaubt.`;
const LEAD_KEYS = [
  'id', 'status', 'priority', 'score', 'name', 'category', 'street', 'zip', 'city', 'phone', 'email', 'website', 'websiteStatus',
  'websiteClass', 'ageScore', 'problems', 'pitch', 'source', 'lastContact', 'nextAction', 'followUp', 'notes', 'updatedAt',
  'priceCents', 'wonAt', 'lostReason', 'recontactAt', 'contactAttempts', 'ownerEmail',
];
const L1: SeedLead = { id: 'PK-0001', name: 'Lead 1' };

async function setup(options: TestDbOptions = { agentKey: KEY }) {
  const db = await createTestDb(options);
  const r = await loadAgentRoutes();
  return { db, r };
}
const ids = (res: { json?: unknown }) => ((res.json as { created: Array<{ id: string }> }).created ?? []).map(lead => lead.id);
const leadOf = (res: { json?: unknown }) => (res.json as { lead: Record<string, unknown> }).lead;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  disposeAll();
  vi.useRealTimers();
});

describe('2c POST /api/agent/leads', () => {
  it('C-01 {name} auf leerer DB → 201, Standardwerte, Aktivität', async () => {
    const { r, db } = await setup();
    const res = await post(r, { name: 'Bäckerei Test' });
    expect(res.status).toBe(201);
    const lead = {
      id: 'PK-0001', status: 'Neu', priority: 'Mittel', score: 50, name: 'Bäckerei Test', category: null, street: null, zip: null,
      city: 'Berlin', phone: null, email: null, website: null, websiteStatus: 'Prüfen', websiteClass: null, ageScore: 0, problems: null,
      pitch: null, source: 'agent', lastContact: null, nextAction: 'Erstkontakt vorbereiten', followUp: null, notes: null, updatedAt: NOW,
      priceCents: null, wonAt: null, lostReason: null, recontactAt: null, contactAttempts: 0, ownerEmail: null,
    };
    expect(res.json).toEqual({ ok: true, created: [lead], errors: [] });
    expect(db.get('SELECT * FROM leads')).toMatchObject({
      id: 'PK-0001', status: 'Neu', priority: 'Mittel', score: 50, city: 'Berlin', website_status: 'Prüfen', age_score: 0, source: 'agent',
      next_action: 'Erstkontakt vorbereiten', updated_at: NOW, contact_attempts: 0, price_cents: null, won_at: null, lost_reason: null,
      recontact_at: null, owner_email: null,
    });
    expect(db.all('SELECT * FROM activities')).toEqual([
      { id: 1, lead_id: 'PK-0001', type: 'created', detail: 'Angelegt via Agent', created_at: NOW, actor_email: null },
    ]);
  });
  it('C-02 angelegter Lead hat genau 29 Schlüssel in fester Reihenfolge', async () => {
    const { r } = await setup();
    const res = await post(r, { name: 'Bäckerei Test' });
    const [lead] = (res.json as { created: object[] }).created;
    expect(Object.keys(lead)).toEqual(LEAD_KEYS);
  });
  it("C-03 source 'hermes' / '' / null", async () => {
    const { r, db } = await setup();
    await post(r, { name: 'A', source: 'hermes' });
    await post(r, { name: 'B', source: '' });
    await post(r, { name: 'C', source: null });
    expect(db.all('SELECT l.id, l.source, a.detail FROM leads l JOIN activities a ON a.lead_id = l.id ORDER BY l.id')).toEqual([
      { id: 'PK-0001', source: 'hermes', detail: 'Angelegt via Agent (hermes)' },
      { id: 'PK-0002', source: '', detail: 'Angelegt via Agent' },
      { id: 'PK-0003', source: 'agent', detail: 'Angelegt via Agent' },
    ]);
  });
  it('C-04 {leads:[A,B]} → 201, PK-0001/PK-0002, zwei Aktivitäten', async () => {
    const { r, db } = await setup();
    const res = await post(r, { leads: [{ name: 'A' }, { name: 'B' }] });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ ok: true, errors: [] });
    expect(ids(res)).toEqual(['PK-0001', 'PK-0002']);
    expect(db.count('activities')).toBe(2);
  });
  it("C-05 {} / {name:'   '} → 400, name fehlt, nichts geschrieben", async () => {
    const { r, db } = await setup();
    const a = await post(r, {});
    expect(a.status).toBe(400);
    expect(a.json).toEqual({ ok: false, created: [], errors: [{ index: 0, error: 'name fehlt' }] });
    const b = await post(r, { name: '   ' });
    expect(b.status).toBe(400);
    expect(b.json).toEqual({ ok: false, created: [], errors: [{ index: 0, error: 'name fehlt', name: '   ' }] });
    expect([db.count('leads'), db.count('activities')]).toEqual([0, 0]);
  });
  it('C-06 {leads:[A,{},C]} → 201, ok:false, Teilerfolg', async () => {
    const { r } = await setup();
    const res = await post(r, { leads: [{ name: 'A' }, {}, { name: 'C' }] });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ ok: false, errors: [{ index: 1, error: 'name fehlt' }] });
    expect(ids(res)).toEqual(['PK-0001', 'PK-0002']);
  });
  it('C-07 KNOWN_WEAKNESS(error-format, PXK-117) {leads:[]} → 400 zusammen mit ok:true', async () => {
    const { r } = await setup();
    const res = await post(r, { leads: [] });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ ok: true, created: [], errors: [] });
  });
  it("C-08 {leads:'x'} / [{name}] / {leads:[null]} → 400 name fehlt an Index 0", async () => {
    const { r, db } = await setup();
    for (const body of [{ leads: 'x' }, [{ name: 'x' }], { leads: [null] }]) {
      const res = await post(r, body);
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ ok: false, created: [], errors: [{ index: 0, error: 'name fehlt' }] });
    }
    expect(db.count('leads')).toBe(0);
  });
  it("C-09 id ' X-1 ' wird getrimmt", async () => {
    const { r } = await setup();
    expect(ids(await post(r, { name: 'A', id: ' X-1 ' }))).toEqual(['X-1']);
  });
  it('C-10 KNOWN_WEAKNESS(error-format, PXK-117) dieselbe explizite id zweimal → zweiter Aufruf 400 UNIQUE, keine zweite Zeile/Aktivität', async () => {
    const { r, db } = await setup();
    expect((await post(r, { name: 'A', id: 'X-1' })).status).toBe(201);
    const res = await post(r, { name: 'A', id: 'X-1' });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ ok: false, created: [], errors: [{ index: 0, error: 'UNIQUE constraint failed: leads.id', name: 'A' }] });
    expect([db.count('leads'), db.count('activities')]).toEqual([1, 1]);
  });
  it("C-11 Nummernvergabe: PK-0041→42, pk-0099→PK-0100, PK-ABC ignoriert, PK-9999→PK-10000, id ''/'  ' automatisch", async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [{ id: 'PK-0041', name: 'x' }] });
    expect(ids(await post(r, { name: 'A' }))).toEqual(['PK-0042']);
    db.run("INSERT INTO leads (id, name, updated_at) VALUES ('pk-0099', 'x', ?)", SEEDED_AT);
    expect(ids(await post(r, { name: 'B' }))).toEqual(['PK-0100']);
    db.run("INSERT INTO leads (id, name, updated_at) VALUES ('PK-ABC', 'x', ?)", SEEDED_AT);
    expect(ids(await post(r, { name: 'C' }))).toEqual(['PK-0101']);
    db.run("INSERT INTO leads (id, name, updated_at) VALUES ('PK-9999', 'x', ?)", SEEDED_AT);
    expect(ids(await post(r, { name: 'D' }))).toEqual(['PK-10000']);
    expect(ids(await post(r, { name: 'E', id: '' }))).toEqual(['PK-10001']);
    expect(ids(await post(r, { name: 'F', id: '  ' }))).toEqual(['PK-10002']);
  });
  it("C-12 KNOWN_WEAKNESS(input-validation, PXK-117) status 'Foo' / 'Gewonnen', priority 'Ultra' werden ungeprüft gespeichert", async () => {
    const { r, db } = await setup();
    for (const body of [{ name: 'A', status: 'Foo' }, { name: 'B', status: 'Gewonnen' }, { name: 'C', priority: 'Ultra' }]) {
      expect((await post(r, body)).status).toBe(201);
    }
    expect(db.all('SELECT id, status, priority, won_at FROM leads ORDER BY id')).toEqual([
      { id: 'PK-0001', status: 'Foo', priority: 'Mittel', won_at: null },
      { id: 'PK-0002', status: 'Gewonnen', priority: 'Mittel', won_at: null },
      { id: 'PK-0003', status: 'Neu', priority: 'Ultra', won_at: null },
    ]);
  });
  it('C-13 KNOWN_WEAKNESS(lead-state, PXK-118) lostReason/contactAttempts/priceCents/ownerEmail/wonAt/recontactAt beim Anlegen ignoriert', async () => {
    const { r, db } = await setup();
    await post(r, { name: 'A', lostReason: 'keine_anrufe', contactAttempts: 5, priceCents: 100, ownerEmail: 'a@b.de', wonAt: NOW, recontactAt: '2027-01-01' });
    expect(db.get('SELECT lost_reason, contact_attempts, price_cents, owner_email, won_at, recontact_at FROM leads')).toEqual({
      lost_reason: null, contact_attempts: 0, price_cents: null, owner_email: null, won_at: null, recontact_at: null,
    });
  });
  it("C-14 ''/null-Standardwerte und score-Umwandlung", async () => {
    const { r, db } = await setup();
    await post(r, { name: 'A', status: '', priority: '', websiteStatus: '', city: null, nextAction: null, score: null });
    await post(r, { name: 'B', city: '', nextAction: '', score: '' });
    await post(r, { name: 'C', score: '70' });
    await post(r, { name: 'D', score: 75.5 });
    expect(db.all('SELECT id, status, priority, website_status, city, next_action, score, typeof(score) AS t FROM leads ORDER BY id')).toEqual([
      { id: 'PK-0001', status: 'Neu', priority: 'Mittel', website_status: 'Prüfen', city: 'Berlin', next_action: 'Erstkontakt vorbereiten', score: 50, t: 'integer' },
      { id: 'PK-0002', status: 'Neu', priority: 'Mittel', website_status: 'Prüfen', city: '', next_action: '', score: 0, t: 'integer' },
      { id: 'PK-0003', status: 'Neu', priority: 'Mittel', website_status: 'Prüfen', city: 'Berlin', next_action: 'Erstkontakt vorbereiten', score: 70, t: 'integer' },
      { id: 'PK-0004', status: 'Neu', priority: 'Mittel', website_status: 'Prüfen', city: 'Berlin', next_action: 'Erstkontakt vorbereiten', score: 75.5, t: 'real' },
    ]);
  });
  it("C-15 KNOWN_WEAKNESS(error-format, PXK-117) score 'abc' / ageScore 'x' → NaN → NULL → 400 NOT NULL", async () => {
    const { r, db } = await setup();
    const a = await post(r, { name: 'A', score: 'abc' });
    expect(a.status).toBe(400);
    expect(a.json).toEqual({ ok: false, created: [], errors: [{ index: 0, error: 'NOT NULL constraint failed: leads.score', name: 'A' }] });
    const b = await post(r, { name: 'B', ageScore: 'x' });
    expect(b.json).toEqual({ ok: false, created: [], errors: [{ index: 0, error: 'NOT NULL constraint failed: leads.age_score', name: 'B' }] });
    expect(db.count('leads')).toBe(0);
  });
  it('C-16 KNOWN_WEAKNESS(input-validation, PXK-117) phone/zip als JSON-Zahl → als REAL-Text gespeichert', async () => {
    const { r, db } = await setup();
    const res = await post(r, { name: 'A', phone: 4930123, zip: 13403 });
    expect(res.status).toBe(201);
    expect(db.get('SELECT phone, zip, typeof(phone) AS tp FROM leads')).toEqual({ phone: '4930123.0', zip: '13403.0', tp: 'text' });
    expect((res.json as { created: Array<{ phone: unknown; zip: unknown }> }).created[0]).toMatchObject({ phone: '4930123.0', zip: '13403.0' });
  });
  it('C-17 KNOWN_WEAKNESS(non-scalar-binding, PXK-133) phone {} → 400 RangeError-Text (Objekt = benannte Parameter); true → 400 Bindungsfehler; keine Zeile', async () => {
    const { r, db } = await setup();
    const object = await post(r, { name: 'A', phone: {} });
    expect([object.status, object.json]).toEqual([400, { ok: false, created: [], errors: [{ index: 0, error: TOO_FEW, name: 'A' }] }]);
    const bool = await post(r, { name: 'A', phone: true });
    expect([bool.status, bool.json]).toEqual([400, { ok: false, created: [], errors: [{ index: 0, error: BIND_ERROR, name: 'A' }] }]);
    expect(db.count('leads')).toBe(0);
  });
  it('C-22 KNOWN_WEAKNESS(non-scalar-binding, PXK-133) Array-Werte werden als Parameterliste gespreizt → Wert landet in der Nachbarspalte', async () => {
    const { r, db } = await setup();
    const shifted = await post(r, { name: 'A', phone: ['p', 'SHIFTED'], email: [] });
    expect(shifted.status).toBe(201);
    expect(db.get('SELECT phone, email FROM leads')).toEqual({ phone: 'p', email: 'SHIFTED' });
    const tooMany = await post(r, { name: 'B', phone: ['a', 'b'] });
    expect([tooMany.status, tooMany.json]).toEqual([400, { ok: false, created: [], errors: [{ index: 0, error: TOO_MANY, name: 'B' }] }]);
    expect(db.count('leads')).toBe(1);
  });
  it('C-18 KNOWN_WEAKNESS(error-format, PXK-117) name 123 → Handler wirft TypeError, nichts geschrieben (Bulk-Fall: F-10)', async () => {
    const { r, db } = await setup();
    const single = await post(r, { name: 123 });
    expect(single.thrown).toMatchObject({ name: 'TypeError', message: expect.stringMatching(/is not a function/) });
    expect([db.count('leads'), db.count('activities')]).toEqual([0, 0]);
  });
  it('C-19 KNOWN_WEAKNESS(error-format, PXK-117) id 7 (Zahl) → 400 is not a function, keine Zeile', async () => {
    const { r, db } = await setup();
    const res = await post(r, { name: 'A', id: 7 });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ ok: false, created: [], errors: [{ index: 0, error: expect.stringMatching(/is not a function/), name: 'A' }] });
    expect(db.count('leads')).toBe(0);
  });
  it("C-20 KNOWN_WEAKNESS(error-format, PXK-117) Body 'not json' / leer / 'null' → Handler wirft, nichts geschrieben", async () => {
    const { r, db } = await setup();
    expect((await post(r, 'not json')).thrown).toMatchObject({ name: 'SyntaxError', message: `Unexpected token 'o', "not json" is not valid JSON` });
    expect((await post(r, '')).thrown).toMatchObject({ name: 'SyntaxError', message: 'Unexpected end of JSON input' });
    expect((await post(r, 'null')).thrown).toMatchObject({ name: 'TypeError', message: "Cannot read properties of null (reading 'leads')" });
    expect(db.count('leads')).toBe(0);
  });
  it("C-21 nur name wird getrimmt (city ' X ' bleibt)", async () => {
    const { r, db } = await setup();
    await post(r, { name: '  Foo  ', city: ' X ' });
    expect(db.get('SELECT name, city FROM leads')).toEqual({ name: 'Foo', city: ' X ' });
  });
});

describe('2d GET /api/agent/leads/search', () => {
  const W = (id: string, website: string | null, extra: Record<string, string> = {}): SeedLead => ({ id, name: `L ${id}`, website, ...extra });
  it('S-01 ohne Parameter → 400', async () => {
    const { r } = await setup();
    const res = await search(r, '');
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: 'website, phone oder name Parameter erforderlich.' });
  });
  it('S-02 leere/Leerzeichen-Parameter werden übersprungen → 400', async () => {
    const { r } = await setup();
    expect((await search(r, '?website=&name=%20&phone=%20')).status).toBe(400);
  });
  it('S-03 website case-insensitiv als Teilstring; NULL-Websites nie', async () => {
    const { r } = await setup({ agentKey: KEY, leads: [W('PK-0001', 'https://www.baecker.de'), W('PK-0002', null)] });
    const res = await search(r, '?website=BAECKER');
    expect(res.status).toBe(200);
    expect((res.json as { leads: Array<{ id: string }> }).leads.map(l => l.id)).toEqual(['PK-0001']);
  });
  it('S-04 KNOWN_WEAKNESS(search, PXK-118) ?website=%25 → jeder Lead mit Website', async () => {
    const { r } = await setup({ agentKey: KEY, leads: [W('PK-0001', 'a.de'), W('PK-0002', 'b.de'), W('PK-0003', 'c.de'), W('PK-0004', null)] });
    const res = await search(r, '?website=%25');
    expect((res.json as { leads: Array<{ id: string }> }).leads.map(l => l.id).sort()).toEqual(['PK-0001', 'PK-0002', 'PK-0003']);
  });
  it('S-05 KNOWN_WEAKNESS(search, PXK-118) ?website=a_b → _ ist Platzhalter (trifft axb.de)', async () => {
    const { r } = await setup({ agentKey: KEY, leads: [W('PK-0001', 'axb.de'), W('PK-0002', 'a_b.de'), W('PK-0003', 'ab.de')] });
    const res = await search(r, '?website=a_b');
    expect((res.json as { leads: Array<{ id: string }> }).leads.map(l => l.id).sort()).toEqual(['PK-0001', 'PK-0002']);
  });
  it('S-06 KNOWN_WEAKNESS(search, PXK-118) phone: im Parameter wird jedes Whitespace entfernt, in der DB nur Leerzeichen (Tab gespeichert → kein Treffer)', async () => {
    const { r } = await setup({
      agentKey: KEY,
      leads: [
        { id: 'PK-0001', name: 'a', phone: '030 123 456' },
        { id: 'PK-0002', name: 'b', phone: '030-123-456' },
        { id: 'PK-0003', name: 'c', phone: '030\t123456' },
      ],
    });
    const hits = async (qs: string) => ((await search(r, qs)).json as { leads: Array<{ id: string }> }).leads.map(l => l.id).sort();
    expect(await hits('?phone=030123456')).toEqual(['PK-0001']);
    expect(await hits('?phone=030%20123456')).toEqual(['PK-0001']);
    expect(await hits('?phone=030%09123456')).toEqual(['PK-0001']);
  });
  it('S-07 KNOWN_WEAKNESS(search, PXK-118) ?phone=+4930999 (+ unkodiert) → Leerzeichen, kein Treffer; %2B trifft', async () => {
    const { r } = await setup({ agentKey: KEY, leads: [{ id: 'PK-0001', name: 'a', phone: '+4930999' }] });
    expect(((await search(r, '?phone=+4930999')).json as { leads: unknown[] }).leads).toEqual([]);
    expect(((await search(r, '?phone=%2B4930999')).json as { leads: Array<{ id: string }> }).leads.map(l => l.id)).toEqual(['PK-0001']);
  });
  it('S-08 KNOWN_WEAKNESS(search, PXK-118) name: Umlaute nur, wenn schon klein gespeichert (SQLite LOWER faltet nur ASCII)', async () => {
    const { r } = await setup({ agentKey: KEY, leads: [{ id: 'PK-0001', name: 'Bäckerei Müller' }, { id: 'PK-0002', name: 'ÄRZTE HAUS' }] });
    const hits = async (qs: string) => ((await search(r, qs)).json as { leads: Array<{ id: string }> }).leads.map(l => l.id);
    expect(await hits('?name=b%C3%A4ckerei')).toEqual(['PK-0001']);
    expect(await hits('?name=B%C3%84CKEREI')).toEqual(['PK-0001']);
    expect(await hits('?name=%C3%A4rzte')).toEqual([]);
    expect(await hits('?name=%C3%84RZTE')).toEqual([]);
  });
  it('S-09 KNOWN_WEAKNESS(search, PXK-118) ?name=100%25 → % ist Platzhalter', async () => {
    const { r } = await setup({ agentKey: KEY, leads: [{ id: 'PK-0001', name: 'Foo 100% Bar' }, { id: 'PK-0002', name: 'Foo 1000 Bar' }, { id: 'PK-0003', name: 'Foo 10 Bar' }] });
    expect(((await search(r, '?name=100%25')).json as { leads: Array<{ id: string }> }).leads.map(l => l.id).sort()).toEqual(['PK-0001', 'PK-0002']);
  });
  it('S-10 mehrere Parameter → ODER-Verknüpfung', async () => {
    const { r } = await setup({
      agentKey: KEY,
      leads: [{ id: 'PK-0001', name: 'a', phone: '030111' }, { id: 'PK-0002', name: 'Zebra' }, { id: 'PK-0003', name: 'c', website: 'c.de' }],
    });
    const res = await search(r, '?website=nomatch&phone=030111&name=zebra');
    expect((res.json as { leads: Array<{ id: string }> }).leads.map(l => l.id).sort()).toEqual(['PK-0001', 'PK-0002']);
  });
  it('S-11 12 Treffer → genau 10 (kein ORDER BY: nur Anzahl und Teilmenge)', async () => {
    const leads = Array.from({ length: 12 }, (_, i) => ({ id: `PK-${String(i + 1).padStart(4, '0')}`, name: `Treffer ${i}` }));
    const { r } = await setup({ agentKey: KEY, leads });
    const found = ((await search(r, '?name=treffer')).json as { leads: Array<{ id: string }> }).leads.map(l => l.id);
    expect(found).toHaveLength(10);
    expect(new Set(found).size).toBe(10);
    for (const id of found) expect(leads.map(l => l.id)).toContain(id);
  });
  it('S-12 keine Treffer → 200 {leads:[]}; Treffer haben die 29-Schlüssel-Abbildung', async () => {
    const { r } = await setup({ agentKey: KEY, leads: [L1] });
    const none = await search(r, '?name=nichts');
    expect([none.status, none.json]).toEqual([200, { leads: [] }]);
    const hit = await search(r, '?name=lead');
    expect(Object.keys((hit.json as { leads: object[] }).leads[0])).toEqual(LEAD_KEYS);
  });
});

describe('2e GET /api/agent/leads/[id]', () => {
  it('G-01 vorhandene id → 200 {lead}', async () => {
    const { r } = await setup({ agentKey: KEY, leads: [L1] });
    const res = await getLead(r, 'PK-0001');
    expect(res.status).toBe(200);
    expect(Object.keys(res.json as object)).toEqual(['lead']);
    expect(leadOf(res)).toMatchObject({ id: 'PK-0001', name: 'Lead 1', status: 'Neu', updatedAt: SEEDED_AT });
  });
  it('G-02 unbekannte id → 404', async () => {
    const { r } = await setup();
    const res = await getLead(r, 'NOPE');
    expect([res.status, res.json]).toEqual([404, { error: 'Lead nicht gefunden.' }]);
  });
  it('G-03 pk-0001 bei PK-0001 → 404 (Groß-/Kleinschreibung zählt)', async () => {
    const { r } = await setup({ agentKey: KEY, leads: [L1] });
    expect((await getLead(r, 'pk-0001')).status).toBe(404);
  });
});

describe('2f PATCH /api/agent/leads/[id]', () => {
  const lastActivity = (db: Awaited<ReturnType<typeof setup>>['db']) =>
    db.get<{ type: string; detail: string; created_at: string }>('SELECT type, detail, created_at FROM activities ORDER BY id DESC LIMIT 1');

  it('U-01 unbekannte id mit {action:foo} / {} → 404 (Suche vor Prüfung)', async () => {
    const { r } = await setup();
    for (const body of [{ action: 'foo' }, {}]) expect([(await patch(r, 'NOPE', body)).status]).toEqual([404]);
  });
  it('U-02 KNOWN_WEAKNESS(error-format, PXK-117) unbekannte id mit kaputtem JSON → SyntaxError (JSON vor Suche)', async () => {
    const { r } = await setup();
    expect((await patch(r, 'NOPE', '{kaputt')).thrown?.name).toBe('SyntaxError');
  });
  it('U-03 {action:foo} → 400 mit allowedActions, nichts geschrieben', async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [L1] });
    const before = db.snapshot();
    const res = await patch(r, 'PK-0001', { action: 'foo' });
    expect([res.status, res.json]).toEqual([400, { error: `Unbekannte Aktion: foo. ${ALLOWED}`, allowedActions: ALLOWED_ACTIONS }]);
    expect(db.snapshot()).toEqual(before);
  });
  it("U-04 {action:''} → 400 'Unbekannte Aktion: . Erlaubt: …'", async () => {
    const { r } = await setup({ agentKey: KEY, leads: [L1] });
    expect((await patch(r, 'PK-0001', { action: '' })).json).toEqual({ error: `Unbekannte Aktion: . ${ALLOWED}`, allowedActions: ALLOWED_ACTIONS });
  });
  it('U-05 KNOWN_WEAKNESS(input-validation, PXK-117) {action:5} → 400 Keine gültige Änderung; {action:5, notes} → 200 mit Detail Agent-Aktion: 5', async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [L1] });
    expect((await patch(r, 'PK-0001', { action: 5 })).json).toEqual({ error: 'Keine gültige Änderung.' });
    const ok = await patch(r, 'PK-0001', { action: 5, notes: 'n' });
    expect(ok.status).toBe(200);
    expect(lastActivity(db)?.detail).toBe('Agent-Aktion: 5');
  });
  it('U-06 Sync-Fehler (status Foo / lostReason bogus / priceCents -1 / contactAttempts -1) → 400, nichts geschrieben', async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [L1] });
    const before = db.snapshot();
    const cases: Array<[object, string]> = [
      [{ status: 'Foo' }, 'Unbekannter Status: Foo'],
      [{ lostReason: 'bogus' }, 'Unbekannter Grund: bogus'],
      [{ priceCents: -1 }, 'Preis muss eine ganze Zahl in Cent sein.'],
      [{ contactAttempts: -1 }, 'Kontaktversuche müssen eine Zahl ≥ 0 sein.'],
    ];
    for (const [body, error] of cases) {
      const res = await patch(r, 'PK-0001', body);
      expect([res.status, res.json]).toEqual([400, { error }]);
    }
    expect(db.snapshot()).toEqual(before);
  });
  it('U-07 {foo:1} / {} / {lost_reason} / {id} → 400 Keine gültige Änderung.', async () => {
    const { r } = await setup({ agentKey: KEY, leads: [L1] });
    for (const body of [{ foo: 1 }, {}, { lost_reason: 'x' }, { id: 'X' }]) {
      const res = await patch(r, 'PK-0001', body);
      expect([res.status, res.json]).toEqual([400, { error: 'Keine gültige Änderung.' }]);
    }
  });
  it('U-08 {action:nicht_erreicht} → Zähler 1, lastContact NOW, Status Neu', async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [L1] });
    const res = await patch(r, 'PK-0001', { action: 'nicht_erreicht' });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ lead: { contactAttempts: 1, lastContact: NOW, status: 'Neu' }, notes: [] });
    expect(lastActivity(db)).toEqual({ type: 'enriched', detail: 'Agent-Aktion: nicht_erreicht', created_at: NOW });
  });
  it('U-09 dreimal nicht_erreicht mit fortschreitender Uhr → Verloren, lastContact vom zweiten Aufruf', async () => {
    const { r } = await setup({ agentKey: KEY, leads: [L1] });
    const t = ['2026-10-10T12:00:00.000Z', '2026-10-11T12:00:00.000Z', '2026-10-12T12:00:00.000Z'];
    let res;
    for (const time of t) {
      vi.setSystemTime(new Date(time));
      res = await patch(r, 'PK-0001', { action: 'nicht_erreicht' });
    }
    expect(leadOf(res!)).toMatchObject({ status: 'Verloren', lostReason: 'nicht_erreicht', recontactAt: null, lastContact: t[1], contactAttempts: 3, updatedAt: t[2] });
  });
  it("U-10 KNOWN_WEAKNESS(input-validation, PXK-117) spaeter mit months '3' / 0 / 'abc' / -1 / 1e9", async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [L1] });
    const at = async (body: object) => leadOf(await patch(r, 'PK-0001', { action: 'spaeter', ...body })).recontactAt;
    expect(await at({})).toBe('2027-04-10');
    expect(await at({ months: '3' })).toBe('2027-01-10');
    expect(await at({ months: 0 })).toBe('2027-04-10');
    expect(await at({ months: 'abc' })).toBe('2027-04-10');
    expect(await at({ months: -1 })).toBe('2026-09-10');
    const before = db.snapshot();
    const huge = await patch(r, 'PK-0001', { action: 'spaeter', months: 1e9 });
    expect(huge.thrown).toMatchObject({ name: 'RangeError', message: 'Invalid time value' });
    expect(db.snapshot()).toEqual(before);
  });
  it('U-11 {action:gewonnen} → wonAt NOW, Hinweis, Detail mit Hinweis', async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [L1] });
    const res = await patch(r, 'PK-0001', { action: 'gewonnen' });
    expect(res.json).toMatchObject({ lead: { status: 'Gewonnen', wonAt: NOW, lostReason: null, recontactAt: null }, notes: ['Gewonnen-Datum gesetzt'] });
    expect(lastActivity(db)?.detail).toBe('Agent-Aktion: gewonnen · Gewonnen-Datum gesetzt');
  });
  it('U-12 {action:kein_interesse} → Verloren/kein_interesse, recontactAt null', async () => {
    const { r } = await setup({ agentKey: KEY, leads: [L1] });
    expect(leadOf(await patch(r, 'PK-0001', { action: 'kein_interesse' }))).toMatchObject({ status: 'Verloren', lostReason: 'kein_interesse', recontactAt: null });
  });
  it('U-13 {action:gewonnen, status:Neu} → Neu, kein wonAt, Detail nur Aktion', async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [L1] });
    const res = await patch(r, 'PK-0001', { action: 'gewonnen', status: 'Neu' });
    expect(res.json).toMatchObject({ lead: { status: 'Neu', wonAt: null }, notes: [] });
    expect(lastActivity(db)?.detail).toBe('Agent-Aktion: gewonnen');
  });
  it('U-14 {status:Gewonnen} → Detail mit Schlüsselliste und Hinweis', async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [L1] });
    await patch(r, 'PK-0001', { status: 'Gewonnen' });
    expect(lastActivity(db)?.detail).toBe('Agent aktualisierte: status, wonAt, lostReason, recontactAt · Gewonnen-Datum gesetzt');
  });
  it('U-15 {recontactAt} → Wiedervorlage, Detail mit Hinweis', async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [L1] });
    expect(leadOf(await patch(r, 'PK-0001', { recontactAt: '2027-03-01' }))).toMatchObject({ status: 'Wiedervorlage', recontactAt: '2027-03-01' });
    expect(lastActivity(db)?.detail).toBe('Agent aktualisierte: recontactAt, status · Status automatisch auf „Wiedervorlage" gesetzt');
  });
  it('U-16 KNOWN_WEAKNESS(machine-principal, PXK-116) {ownerEmail} → owner_email gesetzt (geteilter Agent-Key weist jeden Lead beliebig zu)', async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [L1] });
    await patch(r, 'PK-0001', { ownerEmail: 'a@b.de' });
    expect(db.get('SELECT owner_email FROM leads')).toEqual({ owner_email: 'a@b.de' });
    expect(lastActivity(db)?.detail).toBe('Agent aktualisierte: ownerEmail');
  });
  it('U-17 jeder Erfolg: updated_at = NOW = created_at der Aktivität', async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [L1] });
    vi.setSystemTime(new Date('2026-10-10T13:14:15.678Z'));
    await patch(r, 'PK-0001', { notes: 'x' });
    expect(db.get('SELECT updated_at FROM leads')).toEqual({ updated_at: '2026-10-10T13:14:15.678Z' });
    expect(lastActivity(db)?.created_at).toBe('2026-10-10T13:14:15.678Z');
  });
  it("U-18 {website:''} → NULL", async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [{ ...L1, website: 'x.de' }] });
    await patch(r, 'PK-0001', { website: '' });
    expect(db.get('SELECT website FROM leads')).toEqual({ website: null });
  });
  it('U-19 KNOWN_WEAKNESS(input-validation, PXK-117) leere/NULL-Pflichtfelder → SqliteError NOT NULL, nichts geschrieben', async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [L1] });
    const before = db.snapshot();
    const cases: Array<[object, string]> = [
      [{ name: '' }, 'name'], [{ name: null }, 'name'], [{ priority: '' }, 'priority'], [{ score: null }, 'score'],
      [{ websiteStatus: '' }, 'website_status'], [{ contactAttempts: null }, 'contact_attempts'], [{ contactAttempts: '' }, 'contact_attempts'],
    ];
    for (const [body, column] of cases) {
      expect((await patch(r, 'PK-0001', body)).thrown).toEqual({ name: 'SqliteError', code: 'SQLITE_CONSTRAINT_NOTNULL', message: `NOT NULL constraint failed: leads.${column}` });
    }
    expect(db.snapshot()).toEqual(before);
  });
  it('U-20 {notes:{a:1}} / {notes:true} → 400 Ungültiger Wert (PXK-133), kein Handler-Wurf, nichts geschrieben', async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [L1] });
    const before = db.snapshot();
    for (const notes of [{ a: 1 }, true]) {
      const res = await patch(r, 'PK-0001', { notes });
      expect([res.thrown, res.status, res.json]).toEqual([undefined, 400, { error: INVALID('notes') }]);
    }
    expect(db.snapshot()).toEqual(before);
  });
  it('U-26 Array-Werte → 400 Ungültiger Wert (PXK-133), keine Verschiebung in andere Spalten, kein Lead geändert', async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [L1, { id: 'PK-0002', name: 'Lead 2' }] });
    const before = db.snapshot();
    for (const body of [{ notes: ['x', 'SHIFTED'], city: [] }, { notes: ['x', 'y'] }]) {
      const res = await patch(r, 'PK-0001', body);
      expect([res.thrown, res.status, res.json]).toEqual([undefined, 400, { error: INVALID('notes') }]);
    }
    expect(db.get("SELECT notes, city, updated_at FROM leads WHERE id = 'PK-0001'")).toEqual({ notes: null, city: null, updated_at: SEEDED_AT });
    expect(db.get("SELECT notes, city, updated_at FROM leads WHERE id = 'PK-0002'")).toEqual({ notes: null, city: null, updated_at: SEEDED_AT });
    expect(db.snapshot()).toEqual(before);
  });
  it('U-27 PXK-133 authentifizierter PATCH: Array-Werte umgehen Status-, Grund- und Preisprüfung nicht mehr (400, nichts geschrieben)', async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [L1, { id: 'PK-0002', name: 'Lead 2' }, { id: 'PK-0003', name: 'Lead 3' }, { id: 'PK-0004', name: 'Lead 4' }] });
    const before = db.snapshot();
    const priceShift = { notes: ['n', -5], priceCents: 100, recontactAt: [] };
    const statusShift = { notes: ['n', 'KEIN_GUELTIGER_STATUS'], status: 'Neu', recontactAt: [] };
    const reasonShift = { status: 'Verloren', notes: ['n', 'frei_erfunden'], lostReason: 'kein_interesse', recontactAt: [] };
    // Kontrolle: dieselben Werte als Skalar werden abgelehnt, ohne Schlüssel gibt es 401 — nichts geschrieben.
    expect(await patch(r, 'PK-0001', { status: 'KEIN_GUELTIGER_STATUS' })).toMatchObject({ status: 400, json: { error: 'Unbekannter Status: KEIN_GUELTIGER_STATUS' } });
    expect(await patch(r, 'PK-0002', { lostReason: 'frei_erfunden' })).toMatchObject({ status: 400, json: { error: 'Unbekannter Grund: frei_erfunden' } });
    expect(await patch(r, 'PK-0004', { priceCents: -5 })).toMatchObject({ status: 400, json: { error: 'Preis muss eine ganze Zahl in Cent sein.' } });
    expect((await patch(r, 'PK-0003', statusShift, bearer('nope'))).status).toBe(401);
    expect(db.snapshot()).toEqual(before);
    // Mit gültigem Schlüssel: dieselben Werte im Array werden vor jedem SQL abgelehnt.
    for (const [id, body] of [['PK-0001', statusShift], ['PK-0002', reasonShift], ['PK-0004', priceShift]] as const) {
      const res = await patch(r, id, body);
      expect([id, res.thrown, res.status, res.json]).toEqual([id, undefined, 400, { error: INVALID('notes') }]);
    }
    const seeded = (id: string) => ({ id, status: 'Neu', lost_reason: null, notes: null, recontact_at: null, price_cents: null, updated_at: SEEDED_AT });
    expect(db.all('SELECT id, status, lost_reason, notes, recontact_at, price_cents, updated_at FROM leads ORDER BY id')).toEqual(
      ['PK-0001', 'PK-0002', 'PK-0003', 'PK-0004'].map(seeded),
    );
    expect(db.all('SELECT lead_id, detail FROM activities ORDER BY id')).toEqual([]);
    expect(db.snapshot()).toEqual(before);
  });
  it("U-21 KNOWN_WEAKNESS(input-validation, PXK-117) {score:'abc'} → 200, INTEGER-Spalte hält TEXT, Antwort score null", async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [L1] });
    const res = await patch(r, 'PK-0001', { score: 'abc' });
    expect(res.status).toBe(200);
    expect(leadOf(res).score).toBeNull();
    expect(db.get('SELECT score, typeof(score) AS t FROM leads')).toEqual({ score: 'abc', t: 'text' });
  });
  it("U-22 KNOWN_WEAKNESS(input-validation, PXK-117) {zip:13403} → '13403.0'", async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [L1] });
    await patch(r, 'PK-0001', { zip: 13403 });
    expect(db.get('SELECT zip FROM leads')).toEqual({ zip: '13403.0' });
  });
  it('U-23 KNOWN_WEAKNESS(error-format, PXK-117) Body null auf vorhandenem Lead → TypeError, nichts geschrieben', async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [L1] });
    const before = db.snapshot();
    expect((await patch(r, 'PK-0001', 'null')).thrown).toMatchObject({ name: 'TypeError', message: "Cannot read properties of null (reading 'action')" });
    expect(db.snapshot()).toEqual(before);
  });
  it("U-24 KNOWN_WEAKNESS(input-validation, PXK-117) {recontactAt:'garbage'} / {wonAt:'x'} werden angenommen", async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [L1, { id: 'PK-0002', name: 'Lead 2' }] });
    expect((await patch(r, 'PK-0001', { recontactAt: 'garbage' })).status).toBe(200);
    expect((await patch(r, 'PK-0002', { wonAt: 'x' })).status).toBe(200);
    expect(db.all('SELECT id, status, recontact_at, won_at FROM leads ORDER BY id')).toEqual([
      { id: 'PK-0001', status: 'Wiedervorlage', recontact_at: 'garbage', won_at: null },
      { id: 'PK-0002', status: 'Neu', recontact_at: null, won_at: 'x' },
    ]);
  });
  it("U-25 gespeicherter Zähler 'abc' + nicht_erreicht → 400 Kontaktversuche", async () => {
    const { r } = await setup({ agentKey: KEY, leads: [{ ...L1, contact_attempts: 'abc' }] });
    const res = await patch(r, 'PK-0001', { action: 'nicht_erreicht' });
    expect([res.status, res.json]).toEqual([400, { error: 'Kontaktversuche müssen eine Zahl ≥ 0 sein.' }]);
  });
});

describe('2g POST /api/agent/leads/[id]/activities', () => {
  it('A-01 KNOWN_WEAKNESS(machine-principal, PXK-116) {detail} → 200 {ok:true}, Typ agent_note, actor_email NULL (kein Principal im Audit)', async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [L1] });
    const res = await addActivity(r, 'PK-0001', { detail: 'Recherche ok' });
    expect([res.status, res.json]).toEqual([200, { ok: true }]);
    expect(db.all('SELECT * FROM activities')).toEqual([{ id: 1, lead_id: 'PK-0001', type: 'agent_note', detail: 'Recherche ok', created_at: NOW, actor_email: null }]);
  });
  it("A-02 detail fehlt / '' / '   ' → 400, keine Zeile", async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [L1] });
    for (const body of [{}, { detail: '' }, { detail: '   ' }]) {
      const res = await addActivity(r, 'PK-0001', body);
      expect([res.status, res.json]).toEqual([400, { error: 'detail fehlt.' }]);
    }
    expect(db.count('activities')).toBe(0);
  });
  it("A-03 type ' call ', detail '  x  ' → getrimmt", async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [L1] });
    await addActivity(r, 'PK-0001', { type: ' call ', detail: '  x  ' });
    expect(db.get('SELECT type, detail FROM activities')).toEqual({ type: 'call', detail: 'x' });
  });
  it("A-04 KNOWN_WEAKNESS(input-validation, PXK-117) type '' → agent_note; type '   ' → leerer Typ gespeichert", async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [L1] });
    await addActivity(r, 'PK-0001', { type: '', detail: 'a' });
    await addActivity(r, 'PK-0001', { type: '   ', detail: 'b' });
    expect(db.all('SELECT type, detail FROM activities ORDER BY id')).toEqual([{ type: 'agent_note', detail: 'a' }, { type: '', detail: 'b' }]);
  });
  it('A-05 KNOWN_WEAKNESS(error-format, PXK-117) type 5 / detail 5 → TypeError trim is not a function, keine Zeile', async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [L1] });
    for (const body of [{ type: 5, detail: 'x' }, { detail: 5 }]) {
      expect((await addActivity(r, 'PK-0001', body)).thrown).toMatchObject({ name: 'TypeError', message: expect.stringMatching(/trim is not a function/) });
    }
    expect(db.count('activities')).toBe(0);
  });
  it('A-06 KNOWN_WEAKNESS(referential-integrity, PXK-118) unbekannter Lead → 200, verwaiste Aktivität', async () => {
    const { r, db } = await setup();
    expect((await addActivity(r, 'NOPE-1', { detail: 'x' })).status).toBe(200);
    expect(db.all('SELECT lead_id FROM activities')).toEqual([{ lead_id: 'NOPE-1' }]);
    expect(db.count('leads')).toBe(0);
  });
  it('A-07 KNOWN_WEAKNESS(error-format, PXK-117) kaputtes JSON / null → SyntaxError / TypeError', async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [L1] });
    expect((await addActivity(r, 'PK-0001', '{kaputt')).thrown?.name).toBe('SyntaxError');
    expect((await addActivity(r, 'PK-0001', 'null')).thrown).toMatchObject({ name: 'TypeError', message: "Cannot read properties of null (reading 'type')" });
    expect(db.count('activities')).toBe(0);
  });
  it('A-08 Aktivität ändert updated_at des Leads nicht', async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [L1] });
    await addActivity(r, 'PK-0001', { detail: 'x' });
    expect(db.get('SELECT updated_at FROM leads')).toEqual({ updated_at: SEEDED_AT });
  });
});

describe('2h nicht-atomare Schreibvorgänge und Wiederholungen', () => {
  const trigger = (when: string) =>
    `CREATE TRIGGER pxk114_fail BEFORE INSERT ON activities ${when} BEGIN SELECT RAISE(ABORT, '${INJECTED}'); END`;

  it('F-01 KNOWN_WEAKNESS(no-transaction, PXK-115) PATCH keine_anrufe, Aktivität scheitert → Lead trotzdem geändert', async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [L1] });
    db.app();
    db.exec(trigger("WHEN NEW.type = 'enriched'"));
    const res = await patch(r, 'PK-0001', { action: 'keine_anrufe' });
    expect(res.thrown).toEqual({ name: 'SqliteError', code: 'SQLITE_CONSTRAINT_TRIGGER', message: INJECTED });
    expect(db.get('SELECT status, lost_reason, updated_at FROM leads')).toEqual({ status: 'Verloren', lost_reason: 'keine_anrufe', updated_at: NOW });
    expect(db.count('activities')).toBe(0);
  });
  it('F-02 KNOWN_WEAKNESS(no-transaction, PXK-115) POST, Aktivität scheitert → 400, Lead bleibt ohne Aktivität; Wiederholung legt PK-0002 an', async () => {
    const { r, db } = await setup();
    db.app();
    db.exec(trigger("WHEN NEW.type = 'created'"));
    const res = await post(r, { name: 'A' });
    expect([res.status, res.json]).toEqual([400, { ok: false, created: [], errors: [{ index: 0, error: INJECTED, name: 'A' }] }]);
    await post(r, { name: 'A' });
    expect(db.all('SELECT id FROM leads ORDER BY id')).toEqual([{ id: 'PK-0001' }, { id: 'PK-0002' }]);
    expect(db.count('activities')).toBe(0);
  });
  it('F-03 KNOWN_WEAKNESS(no-transaction, PXK-115) Bulk A,B, Aktivität von B scheitert → 201 ok:false, B ohne Aktivität', async () => {
    const { r, db } = await setup();
    db.app();
    db.exec(trigger("WHEN NEW.lead_id = 'PK-0002'"));
    const res = await post(r, { leads: [{ name: 'A' }, { name: 'B' }] });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ ok: false, errors: [{ index: 1, error: INJECTED, name: 'B' }] });
    expect(ids(res)).toEqual(['PK-0001']);
    expect(db.all('SELECT id FROM leads ORDER BY id')).toEqual([{ id: 'PK-0001' }, { id: 'PK-0002' }]);
    expect(db.all('SELECT lead_id FROM activities')).toEqual([{ lead_id: 'PK-0001' }]);
  });
  it('F-04 BEFORE UPDATE-Trigger → PATCH wirft, Lead unverändert, keine Aktivität (UPDATE selbst ist atomar)', async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [L1] });
    db.app();
    db.exec(`CREATE TRIGGER pxk114_fail_update BEFORE UPDATE ON leads BEGIN SELECT RAISE(ABORT, '${INJECTED}'); END`);
    const before = db.snapshot();
    expect((await patch(r, 'PK-0001', { action: 'keine_anrufe' })).thrown).toMatchObject({ code: 'SQLITE_CONSTRAINT_TRIGGER', message: INJECTED });
    expect(db.snapshot()).toEqual(before);
  });
  it('F-05 KNOWN_WEAKNESS(idempotency, PXK-115) nicht_erreicht wiederholt → 0→1→2, zwei Aktivitäten', async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [L1] });
    await patch(r, 'PK-0001', { action: 'nicht_erreicht' });
    await patch(r, 'PK-0001', { action: 'nicht_erreicht' });
    expect(db.get('SELECT contact_attempts FROM leads')).toEqual({ contact_attempts: 2 });
    expect(db.count('activities')).toBe(2);
  });
  it('F-06 KNOWN_WEAKNESS(idempotency, PXK-115) derselbe POST zweimal → PK-0001 und PK-0002', async () => {
    const { r, db } = await setup();
    await post(r, { name: 'A', phone: '030 1' });
    await post(r, { name: 'A', phone: '030 1' });
    expect(db.all('SELECT id FROM leads ORDER BY id')).toEqual([{ id: 'PK-0001' }, { id: 'PK-0002' }]);
  });
  it('F-07 KNOWN_WEAKNESS(idempotency, PXK-115) dieselbe Aktivität zweimal → 2 Zeilen', async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [L1] });
    await addActivity(r, 'PK-0001', { detail: 'x' });
    await addActivity(r, 'PK-0001', { detail: 'x' });
    expect(db.count('activities')).toBe(2);
  });
  it('F-08 KNOWN_WEAKNESS(idempotency, PXK-115) keine_anrufe wiederholt → gleicher Zustand, weitere Aktivität, updated_at rückt vor', async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [L1] });
    await patch(r, 'PK-0001', { action: 'keine_anrufe' });
    vi.setSystemTime(new Date('2026-10-10T13:00:00.000Z'));
    await patch(r, 'PK-0001', { action: 'keine_anrufe' });
    expect(db.get('SELECT status, lost_reason, updated_at FROM leads')).toEqual({ status: 'Verloren', lost_reason: 'keine_anrufe', updated_at: '2026-10-10T13:00:00.000Z' });
    expect(db.count('activities')).toBe(2);
  });
  it('F-09 KNOWN_WEAKNESS(idempotency, PXK-115) gewonnen wiederholt → zweiter Aufruf ohne Hinweis, wonAt bleibt, aber neue Aktivität und updated_at rückt vor', async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [L1] });
    await patch(r, 'PK-0001', { action: 'gewonnen' });
    vi.setSystemTime(new Date('2026-10-10T13:00:00.000Z'));
    const second = await patch(r, 'PK-0001', { action: 'gewonnen' });
    expect(second.json).toMatchObject({ lead: { wonAt: NOW }, notes: [] });
    expect(db.get('SELECT won_at, updated_at FROM leads')).toEqual({ won_at: NOW, updated_at: '2026-10-10T13:00:00.000Z' });
    expect(db.all<{ detail: string }>('SELECT detail FROM activities ORDER BY id').map(a => a.detail)).toEqual([
      'Agent-Aktion: gewonnen · Gewonnen-Datum gesetzt', 'Agent-Aktion: gewonnen',
    ]);
  });
  it('F-10 KNOWN_WEAKNESS(no-transaction, PXK-115) Bulk mit name 123 an Index 1 → Index 0 bleibt, Handler wirft', async () => {
    const { r, db } = await setup();
    const res = await post(r, { leads: [{ name: 'A' }, { name: 123 }] });
    expect(res.thrown?.name).toBe('TypeError');
    expect([db.count('leads'), db.count('activities')]).toEqual([1, 1]);
  });
  it('F-11 AFTER INSERT-Trigger löscht den Lead → PATCH 404 nach seinen Schreibvorgängen (zweiter 404-Zweig)', async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [L1] });
    db.app();
    db.exec('CREATE TRIGGER pxk114_delete_lead AFTER INSERT ON activities BEGIN DELETE FROM leads WHERE id = NEW.lead_id; END');
    const res = await patch(r, 'PK-0001', { action: 'kein_interesse' });
    expect([res.status, res.json]).toEqual([404, { error: 'Lead nicht gefunden.' }]);
    expect(db.count('leads')).toBe(0);
    expect(db.all('SELECT lead_id, detail FROM activities')).toEqual([{ lead_id: 'PK-0001', detail: 'Agent-Aktion: kein_interesse' }]);
  });
  it('F-12 KNOWN_WEAKNESS(no-transaction, PXK-115) zwei parallele nicht_erreicht ab 1 → beide 200, Zähler nur 2 (verlorenes Update), 3-Versuche-Regel greift nicht', async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [{ ...L1, contact_attempts: 1 }] });
    const res = await Promise.all([patch(r, 'PK-0001', { action: 'nicht_erreicht' }), patch(r, 'PK-0001', { action: 'nicht_erreicht' })]);
    expect(res.map(x => x.status)).toEqual([200, 200]);
    expect(db.get('SELECT status, contact_attempts, lost_reason FROM leads')).toEqual({ status: 'Neu', contact_attempts: 2, lost_reason: null });
    expect(db.all('SELECT detail FROM activities')).toEqual([{ detail: 'Agent-Aktion: nicht_erreicht' }, { detail: 'Agent-Aktion: nicht_erreicht' }]);
  });
  it('F-13 KNOWN_WEAKNESS(no-transaction, PXK-115) zwei parallele POST → dieselbe nächste ID (SELECT MAX vor INSERT): 201 + 400 UNIQUE, nur PK-0001', async () => {
    const { r, db } = await setup();
    const res = await Promise.all([post(r, { name: 'A' }), post(r, { name: 'B' })]);
    expect(res.map(x => x.status)).toEqual([201, 400]);
    expect(res[1].json).toEqual({ ok: false, created: [], errors: [{ index: 0, error: 'UNIQUE constraint failed: leads.id', name: 'B' }] });
    expect(db.all('SELECT id, name FROM leads')).toEqual([{ id: 'PK-0001', name: 'A' }]);
  });
});

describe('2i PXK-133 PATCH Browser (/api/leads/[id]) und Agent: nur Einzelwerte, gleiche Ablehnung', () => {
  const WIEDERVORLAGE: SeedLead = { id: 'PK-0002', name: 'Wiedervorlage GmbH', status: 'Wiedervorlage', lost_reason: 'spaeter', recontact_at: '2027-01-15' };
  const KEINE_ANRUFE: SeedLead = { id: 'PK-0003', name: 'Keine Anrufe GmbH', status: 'Verloren', lost_reason: 'keine_anrufe' };
  const SENTINEL: SeedLead = { id: 'PK-0099', name: 'Sentinel' };
  const ROUTES = ['browser', 'agent'] as const;
  async function both(leads: SeedLead[] = [L1, WIEDERVORLAGE, KEINE_ANRUFE, SENTINEL]) {
    const { r, db } = await setup({ agentKey: KEY, leads });
    const browser = await import('@/app/api/leads/[id]/route');
    const routes = {
      browser: (id: string, body: unknown) => callRoute(browser.PATCH, { method: 'PATCH', path: `/api/leads/${id}`, body, params: { id } }),
      agent: (id: string, body: unknown) => patch(r, id, body),
    };
    return { db, routes };
  }
  /** Antwort und jedes schreibende SQL, das der Handler dabei vorbereitet (dieselbe Verbindung wie die Fixture). */
  async function call(db: TestDb, run: () => Promise<RouteResult>) {
    const spy = vi.spyOn(db.app(), 'prepare');
    try {
      const res = await run();
      const writes = spy.mock.calls.map(([sql]) => String(sql)).filter(sql => /^\s*(UPDATE|INSERT|DELETE)/i.test(sql));
      return { res: res.thrown ? { thrown: res.thrown } : { status: res.status, json: res.json }, writes };
    } finally {
      spy.mockRestore();
    }
  }
  const rejected = (key: string, extra: object = {}) => ({ res: { status: 400, json: { error: INVALID(key), ...extra } }, writes: [] });

  it('V-10 jedes Lead-Feld × Array/Objekt/verschachtelt, true/false außer status/lostReason/priceCents/contactAttempts: Browser und Agent → identisch 400, kein UPDATE/INSERT, DB unverändert', async () => {
    const { db, routes } = await both();
    const before = db.snapshot();
    const VALUES: Array<[string, unknown]> = [
      ['[]', []], ["['x']", ['x']], ["['a','b']", ['a', 'b']], ["[['n']]", [['n']]], ['[{a:1}]', [{ a: 1 }]],
      ['{}', {}], ['{a:1}', { a: 1 }], ['{a:{b:1}}', { a: { b: 1 } }], ['true', true], ['false', false],
    ];
    // true/false: status/lostReason → Vokabelfehler (V-02), priceCents/contactAttempts → Zahl (LS-34, PXK-117)
    const BOOLEAN_ELSEWHERE = ['status', 'lostReason', 'priceCents', 'contactAttempts'];
    const got: unknown[] = [];
    const want: unknown[] = [];
    for (const key of Object.keys(LEAD_COLUMNS)) {
      for (const [label, value] of VALUES) {
        if (typeof value === 'boolean' && BOOLEAN_ELSEWHERE.includes(key)) continue;
        for (const route of ROUTES) {
          got.push([route, key, label, await call(db, () => routes[route]('PK-0001', { [key]: value }))]);
          want.push([route, key, label, rejected(key)]);
        }
      }
    }
    expect(got).toHaveLength(484);
    expect(got).toEqual(want);
    expect(db.snapshot()).toEqual(before);
  });
  it('V-11 Verschiebe-Bodies (Status/Grund/Preis, Gewonnen ohne Datum, keine_anrufe, negative Versuche) und 1-Element-Arrays → beide Routen 400, kein UPDATE/INSERT', async () => {
    const { db, routes } = await both();
    const before = db.snapshot();
    const cases: Array<[object, string]> = [
      [{ notes: ['n', 'KEIN_GUELTIGER_STATUS'], status: 'Neu', recontactAt: [] }, 'notes'],
      [{ status: 'Verloren', notes: ['n', 'frei_erfunden'], lostReason: 'kein_interesse', recontactAt: [] }, 'notes'],
      [{ notes: ['n', -5], priceCents: 100, recontactAt: [] }, 'notes'],
      [{ notes: ['n', 'Gewonnen'], status: 'Neu', recontactAt: [] }, 'notes'],
      [{ notes: ['n', 'keine_anrufe'], lostReason: 'spaeter', recontactAt: [] }, 'notes'],
      [{ notes: ['n', -7], contactAttempts: 1, recontactAt: [] }, 'notes'],
      [{ status: ['Gewonnen'] }, 'status'],
      [{ lostReason: ['keine_anrufe'] }, 'lostReason'],
      [{ priceCents: [5] }, 'priceCents'],
    ];
    for (const [body, key] of cases) {
      for (const route of ROUTES) expect([route, body, await call(db, () => routes[route]('PK-0001', body))]).toEqual([route, body, rejected(key)]);
    }
    expect(db.snapshot()).toEqual(before);
  });
  it('V-12 gemischt gültig + ungültig → beide Routen 400 mit dem ersten Nicht-Einzelwert, der gültige Teil wird nicht geschrieben; unbekannte id bleibt 404', async () => {
    const { db, routes } = await both();
    const before = db.snapshot();
    const cases: Array<[object, string]> = [
      [{ notes: 'Neue Notiz', city: { a: 1 } }, 'city'],
      [{ notes: 'Neue Notiz', phone: true }, 'phone'],
      [{ notes: 'Neue Notiz', city: [{ a: 1 }] }, 'city'],
      [{ status: 'Gewonnen', notes: ['a', 'b'] }, 'notes'],
      [{ status: 'KEIN_GUELTIGER_STATUS', notes: { a: 1 } }, 'notes'],
    ];
    for (const [body, key] of cases) {
      for (const route of ROUTES) expect([route, body, await call(db, () => routes[route]('PK-0001', body))]).toEqual([route, body, rejected(key)]);
    }
    for (const route of ROUTES) {
      expect([route, await call(db, () => routes[route]('NOPE-404', { notes: { a: 1 } }))]).toEqual([route, { res: { status: 404, json: { error: 'Lead nicht gefunden.' } }, writes: [] }]);
    }
    expect(db.snapshot()).toEqual(before);
  });
  it('V-13 Vokabular aus crm-vocab in Browser und Agent gleich: ungültiger Status/Grund/Preis/Versuche → identisch 400, nichts geschrieben', async () => {
    const { db, routes } = await both();
    const before = db.snapshot();
    const cases: Array<[object, string]> = [
      [{ status: 'KEIN_GUELTIGER_STATUS' }, 'Unbekannter Status: KEIN_GUELTIGER_STATUS'],
      [{ status: 'neu' }, 'Unbekannter Status: neu'],
      [{ lostReason: 'frei_erfunden' }, 'Unbekannter Grund: frei_erfunden'],
      [{ priceCents: -5 }, 'Preis muss eine ganze Zahl in Cent sein.'],
      [{ contactAttempts: -1 }, 'Kontaktversuche müssen eine Zahl ≥ 0 sein.'],
      [{ status: true }, 'Unbekannter Status: true'],
      [{ lostReason: false }, 'Unbekannter Grund: false'],
    ];
    for (const [body, error] of cases) {
      for (const route of ROUTES) {
        expect([route, body, await call(db, () => routes[route]('PK-0001', body))]).toEqual([route, body, { res: { status: 400, json: { error } }, writes: [] }]);
      }
    }
    expect(db.snapshot()).toEqual(before);
  });
  it("V-14 Kontrolle: gültige Notiz, UI-Entwurf (null, '', Zahlen, Zusatzschlüssel) und Übernahme gehen auf beiden Routen durch; fremdes Wiedervorlagedatum eines Neu-Leads bleibt", async () => {
    for (const route of ROUTES) {
      const { db, routes } = await both([{ ...L1, recontact_at: '2027-03-03' }]);
      const note = await routes[route]('PK-0001', { notes: 'Neue Notiz' });
      expect([route, note.status, leadOf(note).notes, leadOf(note).updatedAt]).toEqual([route, 200, 'Neue Notiz', NOW]);
      const draft = { ...leadOf(note), notes: 'Entwurf', website: '', priceCents: 149000, contactAttempts: 1, lostReason: '', followUp: null };
      expect(Object.keys(draft)).toEqual(LEAD_KEYS);
      expect([route, (await routes[route]('PK-0001', draft)).status]).toEqual([route, 200]);
      expect([route, (await routes[route]('PK-0001', { ownerEmail: 'team@pixelkiez.test' })).status]).toEqual([route, 200]);
      expect(db.get('SELECT status, notes, website, price_cents, contact_attempts, lost_reason, recontact_at, owner_email FROM leads')).toEqual({
        status: 'Neu', notes: 'Entwurf', website: null, price_cents: 149000, contact_attempts: 1, lost_reason: null, recontact_at: '2027-03-03',
        owner_email: 'team@pixelkiez.test',
      });
      expect(db.all<{ type: string }>('SELECT type FROM activities ORDER BY id').map(a => a.type)).toEqual(Array(3).fill(route === 'browser' ? 'updated' : 'enriched'));
      disposeAll();
    }
  });
  it('V-15 Agent: action/months als Array oder Objekt → 400 vor actionToPatch, kein Audit „Agent-Aktion: …“, nichts geschrieben; Browser ignoriert beide wie bisher', async () => {
    const { db, routes } = await both();
    const before = db.snapshot();
    for (const body of [{ action: ['gewonnen'], notes: 'x' }, { action: ['gewonnen'] }, { action: {}, notes: 'x' }, { action: { a: 'keine_anrufe' } }]) {
      expect([body, await call(db, () => routes.agent('PK-0001', body))]).toEqual([body, rejected('action', { allowedActions: ALLOWED_ACTIONS })]);
    }
    for (const body of [{ action: 'spaeter', months: [3] }, { action: 'spaeter', months: {} }, { action: 'spaeter', months: [1e9] }, { notes: 'x', months: [3] }]) {
      expect([body, await call(db, () => routes.agent('PK-0001', body))]).toEqual([body, rejected('months')]);
    }
    expect(db.snapshot()).toEqual(before);
    // Die Oberfläche kennt keine Aktion: action/months bleiben dort unbekannte Schlüssel.
    expect((await routes.browser('PK-0001', { action: ['gewonnen'], months: [3], notes: 'x' })).status).toBe(200);
    expect(db.all('SELECT lead_id, type, detail FROM activities ORDER BY id')).toEqual([{ lead_id: 'PK-0001', type: 'updated', detail: 'Aktualisiert: notes' }]);
  });
  it('V-16 keine_anrufe-Marker und Status bleiben bei Nicht-Einzelwerten auf beiden Routen stehen; ein __proto__-Objekt wird wie jeder unbekannte Schlüssel ignoriert', async () => {
    const { db, routes } = await both();
    const MARKED = { status: 'Verloren', lost_reason: 'keine_anrufe', won_at: null, recontact_at: null };
    const marker = () => db.get('SELECT status, lost_reason, won_at, recontact_at FROM leads WHERE id = ?', 'PK-0003');
    expect(marker()).toEqual(MARKED);
    const cases: Array<[object, string]> = [
      [{ notes: ['n', 'kein_interesse'], lostReason: 'spaeter', recontactAt: [] }, 'notes'],
      [{ status: ['Neu'] }, 'status'],
      [{ lostReason: [] }, 'lostReason'],
      [{ lostReason: [null] }, 'lostReason'],
    ];
    for (const [body, key] of cases) {
      for (const route of ROUTES) expect([route, body, await call(db, () => routes[route]('PK-0003', body))]).toEqual([route, body, rejected(key)]);
    }
    expect(marker()).toEqual(MARKED);
    for (const route of ROUTES) {
      const res = await routes[route]('PK-0003', '{"__proto__":{"status":"Gewonnen"},"notes":"x"}');
      expect([route, res.status, (res.json as { notes?: unknown }).notes]).toEqual([route, 200, []]);
      expect([route, marker()]).toEqual([route, MARKED]);
    }
    expect(db.all('SELECT type, detail FROM activities ORDER BY id')).toEqual([
      { type: 'updated', detail: 'Aktualisiert: notes, recontactAt' },
      { type: 'enriched', detail: 'Agent aktualisierte: notes, recontactAt' },
    ]);
  });
  it('V-17 Wiedervorlage mit eigenem Datum: abgelehnte Nicht-Einzelwerte (auch recontactAt true/false, vorher Bindungsfehler bzw. +6 Monate) lassen recontact_at auf beiden Routen unverändert', async () => {
    const { db, routes } = await both();
    const before = db.snapshot();
    const cases: Array<[object, string]> = [
      [{ notes: { a: 1 } }, 'notes'],
      [{ notes: ['n', 'x'], city: [] }, 'notes'],
      [{ recontactAt: ['2027-02-01'] }, 'recontactAt'],
      [{ recontactAt: {} }, 'recontactAt'],
      [{ recontactAt: false }, 'recontactAt'],
      [{ recontactAt: true }, 'recontactAt'],
      [{ notes: 'x', recontactAt: false }, 'recontactAt'],
    ];
    for (const [body, key] of cases) {
      for (const route of ROUTES) expect([route, body, await call(db, () => routes[route]('PK-0002', body))]).toEqual([route, body, rejected(key)]);
    }
    expect(db.get('SELECT status, lost_reason, recontact_at FROM leads WHERE id = ?', 'PK-0002')).toEqual({ status: 'Wiedervorlage', lost_reason: 'spaeter', recontact_at: '2027-01-15' });
    expect(db.snapshot()).toEqual(before);
  });
  it('V-18 KNOWN_WEAKNESS(lead-state, PXK-136) gültiger PATCH ohne status/recontactAt auf Wiedervorlage setzt das Rückrufdatum auf +6 Monate zurück (beide Routen, von PXK-133 unverändert)', async () => {
    const { db, routes } = await both();
    const bodies = { browser: [{ notes: 'Rückruf' }, { ownerEmail: 'team@pixelkiez.test' }], agent: [{ notes: 'Rückruf' }, { ownerEmail: 'team@pixelkiez.test' }, { action: 'nicht_erreicht' }] };
    for (const route of ROUTES) {
      for (const body of bodies[route]) {
        db.run("UPDATE leads SET recontact_at = '2027-01-15' WHERE id = 'PK-0002'");
        const res = await routes[route]('PK-0002', body);
        expect([route, body, res.status, leadOf(res).recontactAt, (res.json as { notes?: unknown }).notes])
          .toEqual([route, body, 200, '2027-04-10', ['Wiedervorlage ohne Datum — auf 6 Monate gesetzt']]);
      }
    }
  });
});

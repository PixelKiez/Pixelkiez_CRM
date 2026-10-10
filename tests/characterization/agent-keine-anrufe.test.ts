/**
 * PXK-114 Charakterisierung: Was nach `keine_anrufe` (Opt-out „nicht mehr anrufen“) über die Agent-API noch geht.
 * Heute schützt nichts den Marker: KNOWN_WEAKNESS(contact-policy/opt-out, PXK-119); PXK-118 führt UI- und Agent-Pfad
 * dafür auf einen LeadService zusammen. Die Tests halten das Ist-Verhalten fest und erklären es nicht für akzeptabel;
 * vor der Live-Aktivierung muss PXK-119 es ändern.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bearer, callRoute, loadAgentRoutes, type AgentRoutes } from '../support/route';
import { ROOT, createTestDb, disposeAll, type TestDb } from '../support/test-db';

const KEY = 'test-agent-key-0123456789';
const AUTH = bearer(KEY);
const T0 = '2026-10-10T12:00:00.000Z';
const T1 = '2026-10-10T13:00:00.000Z';
const LEAD = { id: 'PK-0001', name: 'Kein Anruf GmbH', phone: '030 555', website: 'https://kein-anruf.de' };

let db: TestDb;
let r: AgentRoutes;

const patch = (body: unknown) => callRoute(r.lead.PATCH, { method: 'PATCH', path: '/api/agent/leads/PK-0001', headers: AUTH, body, params: { id: 'PK-0001' } });
const row = () => db.get<Record<string, unknown>>('SELECT status, lost_reason, recontact_at, won_at, contact_attempts, last_contact, updated_at FROM leads WHERE id = ?', 'PK-0001');
const details = () => db.all<{ detail: string }>('SELECT detail FROM activities ORDER BY id').map(a => a.detail);

/** K0: Lead L1, dann PATCH {action:'keine_anrufe'} um T0; danach steht die Uhr auf T1. */
async function k0(seedAttempts = 0) {
  db = await createTestDb({ agentKey: KEY, leads: [{ ...LEAD, contact_attempts: seedAttempts }] });
  r = await loadAgentRoutes();
  vi.setSystemTime(new Date(T0));
  const res = await patch({ action: 'keine_anrufe' });
  vi.setSystemTime(new Date(T1));
  return res;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(T0));
});
afterEach(() => {
  disposeAll();
  vi.useRealTimers();
});

describe('keine_anrufe und Folgeaufrufe (Ist-Verhalten)', () => {
  it('K-01 K0: Verloren / keine_anrufe, notes []', async () => {
    const res = await k0();
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ lead: { status: 'Verloren', lostReason: 'keine_anrufe', recontactAt: null }, notes: [] });
    expect(details()).toEqual(['Agent-Aktion: keine_anrufe']);
  });
  it('K-02 KNOWN_WEAKNESS(idempotency, PXK-115) keine_anrufe wiederholt → unverändert, zweite Aktivität, updated_at neu', async () => {
    await k0();
    await patch({ action: 'keine_anrufe' });
    expect(row()).toMatchObject({ status: 'Verloren', lost_reason: 'keine_anrufe', updated_at: T1 });
    expect(details()).toEqual(['Agent-Aktion: keine_anrufe', 'Agent-Aktion: keine_anrufe']);
  });
  it('K-03 KNOWN_WEAKNESS(contact-policy/opt-out, PXK-119) {status:Neu} → Neu, Marker bleibt', async () => {
    await k0();
    expect((await patch({ status: 'Neu' })).json).toMatchObject({ lead: { status: 'Neu', lostReason: 'keine_anrufe' }, notes: [] });
    expect(details().at(-1)).toBe('Agent aktualisierte: status');
  });
  it('K-04 KNOWN_WEAKNESS(contact-policy/opt-out, PXK-119) {status:Wiedervorlage} → Wiedervorlage +6 Monate, Marker bleibt', async () => {
    await k0();
    await patch({ status: 'Wiedervorlage' });
    expect(row()).toMatchObject({ status: 'Wiedervorlage', recontact_at: '2027-04-10', lost_reason: 'keine_anrufe' });
    expect(details().at(-1)).toBe('Agent aktualisierte: status, recontactAt · Wiedervorlage ohne Datum — auf 6 Monate gesetzt');
  });
  it('K-05 KNOWN_WEAKNESS(contact-policy/opt-out, PXK-119) {recontactAt} → automatisch Wiedervorlage, Marker bleibt', async () => {
    await k0();
    await patch({ recontactAt: '2027-01-15' });
    expect(row()).toMatchObject({ status: 'Wiedervorlage', recontact_at: '2027-01-15', lost_reason: 'keine_anrufe' });
    expect(details().at(-1)).toBe('Agent aktualisierte: recontactAt, status · Status automatisch auf „Wiedervorlage" gesetzt');
  });
  it('K-06 KNOWN_WEAKNESS(contact-policy/opt-out, PXK-119) {action:spaeter} → Marker durch spaeter ersetzt', async () => {
    await k0();
    await patch({ action: 'spaeter' });
    expect(row()).toMatchObject({ status: 'Wiedervorlage', lost_reason: 'spaeter', recontact_at: '2027-04-10' });
    expect(details().at(-1)).toBe('Agent-Aktion: spaeter');
  });
  it('K-07 KNOWN_WEAKNESS(contact-policy/opt-out, PXK-119) {action:gewonnen} → Gewonnen, Marker gelöscht', async () => {
    await k0();
    await patch({ action: 'gewonnen' });
    expect(row()).toMatchObject({ status: 'Gewonnen', won_at: T1, lost_reason: null });
    expect(details().at(-1)).toBe('Agent-Aktion: gewonnen · Gewonnen-Datum gesetzt');
  });
  it('K-08 KNOWN_WEAKNESS(contact-policy/opt-out, PXK-119) {action:kein_interesse} → Marker ersetzt', async () => {
    await k0();
    await patch({ action: 'kein_interesse' });
    expect(row()).toMatchObject({ status: 'Verloren', lost_reason: 'kein_interesse' });
    expect(details().at(-1)).toBe('Agent-Aktion: kein_interesse');
  });
  it('K-09 KNOWN_WEAKNESS(contact-policy/opt-out, PXK-119) nicht_erreicht (0) → Anrufversuch trotz Opt-out protokolliert', async () => {
    await k0();
    await patch({ action: 'nicht_erreicht' });
    expect(row()).toMatchObject({ status: 'Verloren', lost_reason: 'keine_anrufe', contact_attempts: 1, last_contact: T1 });
    expect(details().at(-1)).toBe('Agent-Aktion: nicht_erreicht');
  });
  it('K-10 KNOWN_WEAKNESS(contact-policy/opt-out, PXK-119) nicht_erreicht (2) → Marker durch nicht_erreicht überschrieben', async () => {
    await k0(2);
    await patch({ action: 'nicht_erreicht' });
    expect(row()).toMatchObject({ status: 'Verloren', lost_reason: 'nicht_erreicht', contact_attempts: 3 });
  });
  it("K-11 KNOWN_WEAKNESS(contact-policy/opt-out, PXK-119) {lostReason:null} / {lostReason:''} → Marker gelöscht, bleibt Verloren", async () => {
    for (const lostReason of [null, '']) {
      await k0();
      await patch({ lostReason });
      expect(row()).toMatchObject({ status: 'Verloren', lost_reason: null });
      expect(details().at(-1)).toBe('Agent aktualisierte: lostReason, recontactAt');
      db.dispose();
    }
  });
  it('K-12 KNOWN_WEAKNESS(contact-policy/opt-out, PXK-119) {lostReason:kein_budget} → Marker ersetzt', async () => {
    await k0();
    await patch({ lostReason: 'kein_budget' });
    expect(row()).toMatchObject({ status: 'Verloren', lost_reason: 'kein_budget' });
    expect(details().at(-1)).toBe('Agent aktualisierte: lostReason, status, recontactAt · Status automatisch auf „Verloren" gesetzt');
  });
  it('K-13 KNOWN_WEAKNESS(contact-policy/opt-out, PXK-119) {lostReason:spaeter} → Wiedervorlage 2027-04-10', async () => {
    await k0();
    await patch({ lostReason: 'spaeter' });
    expect(row()).toMatchObject({ status: 'Wiedervorlage', lost_reason: 'spaeter', recontact_at: '2027-04-10' });
    expect(details().at(-1)).toBe(
      'Agent aktualisierte: lostReason, status, recontactAt · Status automatisch auf „Wiedervorlage" gesetzt · Wiedervorlage in 6 Monaten vorgemerkt',
    );
  });
  it('K-14 {status:Ausgeschlossen} → Marker bleibt', async () => {
    await k0();
    await patch({ status: 'Ausgeschlossen' });
    expect(row()).toMatchObject({ status: 'Ausgeschlossen', lost_reason: 'keine_anrufe' });
    expect(details().at(-1)).toBe('Agent aktualisierte: status, recontactAt');
  });
  it('K-15 {notes:x} → Marker bleibt', async () => {
    await k0();
    await patch({ notes: 'x' });
    expect(row()).toMatchObject({ status: 'Verloren', lost_reason: 'keine_anrufe' });
    expect(details().at(-1)).toBe('Agent aktualisierte: notes, recontactAt');
  });
  it('K-16 KNOWN_WEAKNESS(contact-policy/opt-out, PXK-119) GET und Suche liefern den Lead ungefiltert', async () => {
    await k0();
    const get = await callRoute(r.lead.GET, { headers: AUTH, params: { id: 'PK-0001' } });
    expect(get.json).toMatchObject({ lead: { id: 'PK-0001', lostReason: 'keine_anrufe' } });
    for (const qs of ['?phone=030555', '?name=kein%20anruf', '?website=kein-anruf']) {
      const res = await callRoute(r.search.GET, { path: `/api/agent/leads/search${qs}`, headers: AUTH });
      expect(res.json).toMatchObject({ leads: [{ id: 'PK-0001', lostReason: 'keine_anrufe' }] });
    }
  });
  it('K-17 KNOWN_WEAKNESS(contact-policy/opt-out, PXK-119) Aktivität auf dem Lead → 200', async () => {
    await k0();
    const res = await callRoute(r.activities.POST, { method: 'POST', headers: AUTH, body: { type: 'call', detail: 'angerufen' }, params: { id: 'PK-0001' } });
    expect([res.status, res.json]).toEqual([200, { ok: true }]);
  });
  it('K-18 KNOWN_WEAKNESS(contact-policy/opt-out, PXK-119) neuer Lead mit gleicher Nummer/Name → ohne Marker', async () => {
    await k0();
    const res = await callRoute(r.leads.POST, { method: 'POST', headers: AUTH, body: { name: LEAD.name, phone: LEAD.phone } });
    expect(res.status).toBe(201);
    expect((res.json as { created: Array<Record<string, unknown>> }).created[0]).toMatchObject({ id: 'PK-0002', lostReason: null, status: 'Neu' });
  });
  it('K-19 KNOWN_WEAKNESS(contact-policy/opt-out, PXK-119) POST mit lostReason keine_anrufe → ignoriert', async () => {
    await k0();
    await callRoute(r.leads.POST, { method: 'POST', headers: AUTH, body: { name: 'Neu GmbH', lostReason: 'keine_anrufe' } });
    expect(db.get('SELECT lost_reason, status FROM leads WHERE id = ?', 'PK-0002')).toEqual({ lost_reason: null, status: 'Neu' });
  });
  it('K-20 KNOWN_WEAKNESS(contact-policy/opt-out, PXK-119) statisch: app/api/agent/** nutzt isCallBlocked nirgends', () => {
    const dir = join(ROOT, 'app', 'api', 'agent');
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(f => /\.(ts|tsx)$/.test(f));
    expect(files.length).toBe(5);
    expect(files.filter(f => readFileSync(join(dir, f), 'utf8').includes('isCallBlocked'))).toEqual([]);
  });
});

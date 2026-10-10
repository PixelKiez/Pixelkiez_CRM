/**
 * PXK-114 Charakterisierung der Agent-Authentifizierung (lib/agent-auth.ts) über alle sechs Handler, plus Ping.
 * Echter Request, echte Wegwerf-SQLite. KNOWN_WEAKNESS(<Kategorie>, <Jira>) markiert Verhalten, das das genannte
 * Ticket bewusst ändert; der Test hält es nur fest und erklärt es nicht für akzeptabel.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HANDLER_NAMES, TEST_AGENT_KEY as KEY, TEST_AUTH as AUTH, bearer, callRoute, loadAgentRoutes, patchLead, postActivity, postLeads, probeAll, type AgentRoutes,
} from '../support/route';
import { ROOT, createTestDb, disposeAll, type SeedLead, type TestDb, type TestDbOptions } from '../support/test-db';

const NOW = '2026-10-10T12:00:00.000Z';
const BAD_KEY = { error: 'Ungültiges Bearer-Token.' };
const NO_KEY = { error: 'Agent-API ist nicht aktiviert. Setze einen Key in den Einstellungen.' };
const PASS = { ping: 200, create: 201, search: 400, get: 404, patch: 404, activities: 200 };
const all = (status: number | string) => Object.fromEntries(HANDLER_NAMES.map(name => [name, status]));
const L1: SeedLead = { id: 'PK-0001', name: 'Lead 1' };

async function setup(options: TestDbOptions = { agentKey: KEY }) {
  const db = await createTestDb(options);
  const r = await loadAgentRoutes();
  return { db, r };
}
const statuses = (probe: Awaited<ReturnType<typeof probeAll>>) => Object.fromEntries(Object.entries(probe).map(([k, v]) => [k, v.status]));
const bodies = (probe: Awaited<ReturnType<typeof probeAll>>) => [...new Set(Object.values(probe).map(v => JSON.stringify(v.json)))];

/** Die drei schreibenden Handler mit denselben Headern/Query; liefert die Status und prüft, dass nichts geschrieben wurde. */
async function writesRejected(db: TestDb, r: AgentRoutes, headers: Record<string, string>, query = '') {
  const before = db.snapshot();
  const result = [
    (await postLeads(r, { name: 'A' }, headers, query)).status,
    (await patchLead(r, 'PK-0001', { action: 'keine_anrufe' }, headers, query)).status,
    (await postActivity(r, 'PK-0001', { detail: 'x' }, headers, query)).status,
  ];
  expect(db.snapshot()).toEqual(before);
  return result;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  disposeAll();
  vi.useRealTimers();
});

describe('2a Auth-Matrix (je Fall alle sechs Handler)', () => {
  it('AU-01 ohne Authorization-Header → 401, schreibende Handler ändern nichts', async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [L1] });
    const probe = await probeAll(r, {});
    expect(statuses(probe)).toEqual(all(401));
    expect(bodies(probe)).toEqual([JSON.stringify(BAD_KEY)]);
    expect(await writesRejected(db, r, {})).toEqual([401, 401, 401]);
  });
  it('AU-02 Bearer nope → 401', async () => {
    const { r } = await setup();
    expect(statuses(await probeAll(r, bearer('nope')))).toEqual(all(401));
  });
  it('AU-03 falsches Token gleicher Länge → 401 (voller Vergleich in constantTimeEqual)', async () => {
    const { r } = await setup();
    expect(statuses(await probeAll(r, bearer('x'.repeat(KEY.length))))).toEqual(all(401));
  });
  it("AU-04 'Bearer' / 'Bearer   ' → 401", async () => {
    const { r } = await setup();
    expect(statuses(await probeAll(r, { authorization: 'Bearer' }))).toEqual(all(401));
    expect(statuses(await probeAll(r, { authorization: 'Bearer   ' }))).toEqual(all(401));
  });
  it("AU-05 'bearer KEY' → bestanden", async () => {
    const { r } = await setup();
    expect(statuses(await probeAll(r, { authorization: `bearer ${KEY}` }))).toEqual(PASS);
  });
  it("AU-06 'BEARER KEY' → bestanden", async () => {
    const { r } = await setup();
    expect(statuses(await probeAll(r, { authorization: `BEARER ${KEY}` }))).toEqual(PASS);
  });
  it("AU-07 '   Bearer    KEY   ' → bestanden", async () => {
    const { r } = await setup();
    expect(statuses(await probeAll(r, { authorization: `   Bearer    ${KEY}   ` }))).toEqual(PASS);
  });
  it("AU-08 'Bearer<TAB>KEY' → bestanden", async () => {
    const { r } = await setup();
    expect(statuses(await probeAll(r, { authorization: `Bearer\t${KEY}` }))).toEqual(PASS);
  });
  it('AU-09 Basic / Token / nackter Key → 401', async () => {
    const { r } = await setup();
    for (const authorization of [`Basic ${KEY}`, `Token ${KEY}`, KEY]) expect(statuses(await probeAll(r, { authorization }))).toEqual(all(401));
  });
  it('AU-10 Key nur in ?token= / ?access_token= / ?key= → 401, schreibende Handler ändern nichts', async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [L1] });
    for (const param of ['token', 'access_token', 'key']) {
      const res = await callRoute(r.ping.GET, { path: `/api/agent/ping?${param}=${KEY}` });
      expect(res.status).toBe(401);
      expect(await writesRejected(db, r, {}, `?${param}=${KEY}`)).toEqual([401, 401, 401]);
    }
  });
  it('AU-11 zwei gültige Authorization-Werte → zusammengefügt → 401', async () => {
    const { r } = await setup();
    const headers: Array<[string, string]> = [['authorization', `Bearer ${KEY}`], ['authorization', `Bearer ${KEY}`]];
    expect(new Headers(headers).get('authorization')).toBe(`Bearer ${KEY}, Bearer ${KEY}`);
    expect(statuses(await probeAll(r, headers))).toEqual(all(401));
  });
  it('AU-12 Bearer KEY extra / Bearer KEY, Basic abc → 401', async () => {
    const { r } = await setup();
    for (const authorization of [`Bearer ${KEY} extra`, `Bearer ${KEY}, Basic abc`]) expect(statuses(await probeAll(r, { authorization }))).toEqual(all(401));
  });
  it('AU-13 KNOWN_WEAKNESS(auth-minor, PXK-116) Token in Großbuchstaben / nur Präfix des Keys → 401; ungleiche Länge bricht in constantTimeEqual früh ab (Längen-Leak)', async () => {
    const { r } = await setup();
    expect(statuses(await probeAll(r, bearer(KEY.toUpperCase())))).toEqual(all(401));
    expect(statuses(await probeAll(r, bearer(KEY.slice(0, 8))))).toEqual(all(401));
    // Stolperdraht für PXK-116: der frühe Abbruch bei ungleicher Länge steht heute so im Code.
    expect(readFileSync(join(ROOT, 'lib', 'agent-auth.ts'), 'utf8')).toMatch(/function constantTimeEqual[^{]*\{\s*if \(a\.length !== b\.length\) return false;/);
  });
  it('AU-14 nur x-authorization → 401', async () => {
    const { r } = await setup();
    expect(statuses(await probeAll(r, { 'x-authorization': `Bearer ${KEY}` }))).toEqual(all(401));
  });
  it('AU-15 KNOWN_WEAKNESS(auth-minor, PXK-116) weder settings-Zeile noch Env-Key → 503 mit und ohne Header, nichts geschrieben', async () => {
    const { r, db } = await setup({ leads: [L1] });
    for (const headers of [AUTH, {}]) {
      const probe = await probeAll(r, headers);
      expect(statuses(probe)).toEqual(all(503));
      expect(bodies(probe)).toEqual([JSON.stringify(NO_KEY)]);
      expect(await writesRejected(db, r, headers)).toEqual([503, 503, 503]);
    }
  });
  it("AU-16 settings-Wert NULL / '   ', kein Env → 503", async () => {
    for (const value of [null, '   ']) {
      const { r, db } = await setup({ settings: { agent_api_key: value } });
      expect(statuses(await probeAll(r, AUTH))).toEqual(all(503));
      db.dispose();
    }
  });
  it('AU-17 keine Zeile, Env AGENT_API_KEY=envKey: Bearer envKey bestanden / Bearer KEY 401', async () => {
    vi.stubEnv('AGENT_API_KEY', 'envKey');
    const { r } = await setup({});
    expect(statuses(await probeAll(r, bearer('envKey')))).toEqual(PASS);
    expect(statuses(await probeAll(r, AUTH))).toEqual(all(401));
  });
  it("AU-18 Env '   ' → 503", async () => {
    vi.stubEnv('AGENT_API_KEY', '   ');
    const { r } = await setup({});
    expect(statuses(await probeAll(r, bearer('envKey')))).toEqual(all(503));
  });
  it('AU-19 DB-Key und Env-Key: Env-Token 401 / DB-Token bestanden (DB gewinnt)', async () => {
    vi.stubEnv('AGENT_API_KEY', 'envKey');
    const { r } = await setup();
    expect(statuses(await probeAll(r, bearer('envKey')))).toEqual(all(401));
    expect(statuses(await probeAll(r, AUTH))).toEqual(PASS);
  });
  it("AU-20 gespeichert '  KEY\\n' → Bearer KEY bestanden (getrimmt)", async () => {
    const { r } = await setup({ settings: { agent_api_key: `  ${KEY}\n` } });
    expect(statuses(await probeAll(r, AUTH))).toEqual(PASS);
  });
  it("AU-21 gespeichert '   ' und Env gesetzt → Env-Key gilt", async () => {
    vi.stubEnv('AGENT_API_KEY', 'envKey');
    const { r } = await setup({ settings: { agent_api_key: '   ' } });
    expect(statuses(await probeAll(r, bearer('envKey')))).toEqual(PASS);
  });
  it("AU-22 Env '  envKey  ' → getrimmt, bestanden", async () => {
    vi.stubEnv('AGENT_API_KEY', '  envKey  ');
    const { r } = await setup({});
    expect(statuses(await probeAll(r, bearer('envKey')))).toEqual(PASS);
  });
  it('AU-23 settings-Zeile mitten im Test geändert → alter Key sofort 401 (kein Cache)', async () => {
    const { r, db } = await setup();
    expect(statuses(await probeAll(r, AUTH))).toEqual(PASS);
    db.run("UPDATE settings SET value = 'rotated-key' WHERE key = 'agent_api_key'");
    expect(statuses(await probeAll(r, AUTH))).toEqual(all(401));
    expect((await callRoute(r.ping.GET, { headers: bearer('rotated-key') })).status).toBe(200);
  });
  it('AU-24 falsches Token auf POST / PATCH / activities → nichts geschrieben', async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [L1] });
    expect(await writesRejected(db, r, bearer('nope'))).toEqual([401, 401, 401]);
  });
  it('AU-25 Auth vor dem Body: kaputtes JSON ohne/mit falschem Token → 401 statt SyntaxError, nichts geschrieben', async () => {
    const { r, db } = await setup({ agentKey: KEY, leads: [L1] });
    const before = db.snapshot();
    for (const headers of [{}, bearer('nope')]) {
      const results = [
        await postLeads(r, '{kaputt', headers),
        await patchLead(r, 'PK-0001', '{kaputt', headers),
        await postActivity(r, 'PK-0001', '{kaputt', headers),
      ];
      expect(results.map(res => [res.status, res.json])).toEqual(Array(3).fill([401, BAD_KEY]));
    }
    expect(db.snapshot()).toEqual(before);
  });
});

describe('2b Ping', () => {
  it('P-01 GET mit AUTH → 200, genau drei Schlüssel', async () => {
    const { r } = await setup();
    const res = await callRoute(r.ping.GET, { path: '/api/agent/ping', headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.headers?.['content-type']).toMatch(/^application\/json/);
    expect(res.json).toEqual({ ok: true, service: 'reinickendorf-crm', time: NOW });
    expect(Object.keys(res.json as object)).toEqual(['ok', 'service', 'time']);
    expect(res.text).toBe(`{"ok":true,"service":"reinickendorf-crm","time":"${NOW}"}`);
    expect(Buffer.from(res.bytes ?? []).toString('utf8')).toBe(res.text);
  });
});

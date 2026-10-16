import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentUserEmail } from '@/lib/current-user';
import { verifyMigrated } from '@/lib/d1-node';
import { openDatabase, resolveDbPath } from '@/lib/db/open.mjs';
import { POST } from '@/app/api/leads/[id]/analysis/route';

vi.mock('@/lib/current-user', () => ({ currentUserEmail: vi.fn() }));
vi.mock('@/lib/d1-node', () => ({ verifyMigrated: vi.fn() }));
vi.mock('@/lib/db/open.mjs', () => ({ openDatabase: vi.fn(), resolveDbPath: vi.fn() }));

function installDatabase(website: string | null | undefined) {
  const get = vi.fn().mockReturnValue(website === undefined ? undefined : { website });
  const prepare = vi.fn(() => ({ get }));
  const close = vi.fn();
  const database = { prepare, close } as unknown as ReturnType<typeof openDatabase>;
  vi.mocked(resolveDbPath).mockReturnValue('/readonly/crm.db');
  vi.mocked(openDatabase).mockReturnValue(database);
  vi.mocked(verifyMigrated).mockImplementation(() => undefined);
  return { database, prepare, get, close };
}

function makeRequest(origin: string | null = 'http://localhost', body: unknown = { target_url: 'https://attacker.example.test/' }) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (origin) headers.set('origin', origin);
  return new Request('http://localhost/api/leads/lead-01/analysis', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function expectReadOnlyLookup(db: ReturnType<typeof installDatabase>) {
  expect(openDatabase).toHaveBeenCalledWith('/readonly/crm.db', 'inspect');
  expect(openDatabase).toHaveBeenCalledOnce();
  expect(verifyMigrated).toHaveBeenCalledWith(db.database);
  expect(db.prepare.mock.calls).toEqual([['SELECT website FROM leads WHERE id=?']]);
  expect(db.get).toHaveBeenCalledWith('lead-01');
  expect(db.close).toHaveBeenCalledOnce();
}

const context = { params: Promise.resolve({ id: 'lead-01' }) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(currentUserEmail).mockResolvedValue('user@example.test');
  installDatabase('https://saved.example.test/');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('POST /api/leads/[id]/analysis', () => {
  // currentUserEmail returns null for both absent cookies and expired tokens.
  it.each(['missing', 'expired'])('rejects a %s session before opening SQLite', async () => {
    vi.mocked(currentUserEmail).mockResolvedValue(null);

    const response = await POST(makeRequest(), context);
    const body = await response.json() as { status: string };

    expect(response.status).toBe(401);
    expect(body.status).toBe('NOT_AUTHORIZED');
    expect(openDatabase).not.toHaveBeenCalled();
  });

  it('fails closed if session validation throws', async () => {
    vi.mocked(currentUserEmail).mockRejectedValue(new Error('session verification detail'));

    const response = await POST(makeRequest(), context);
    const body = await response.json() as { status: string; message: string };

    expect(response.status).toBe(401);
    expect(body.status).toBe('NOT_AUTHORIZED');
    expect(body.message).not.toContain('session verification detail');
    expect(openDatabase).not.toHaveBeenCalled();
  });

  it.each([
    ['foreign', 'https://attacker.example.test'],
    ['missing', null],
  ])('rejects a %s Origin before database access', async (_reason: string, origin: string | null) => {
    const response = await POST(makeRequest(origin), context);
    const body = await response.json() as { status: string };

    expect(response.status).toBe(403);
    expect(body.status).toBe('NOT_AUTHORIZED');
    expect(openDatabase).not.toHaveBeenCalled();
  });

  it.each([null, 'javascript:alert(1)'])('rejects missing or invalid saved website (%s)', async (website: string | null) => {
    const db = installDatabase(website);
    const response = await POST(makeRequest(), context);
    const body = await response.json() as { status: string };

    expect(response.status).toBe(400);
    expect(body.status).toBe('INVALID_WEBSITE');
    expectReadOnlyLookup(db);
  });

  it('uses the valid same-origin request and remains explicitly NOT_CONNECTED', async () => {
    const db = installDatabase('https://saved.example.test/');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('PXAPI_BASE_URL', 'https://pxapi.example.test');

    const response = await POST(makeRequest(), context);
    const body = await response.json() as { status: string; message: string };

    expect(response.status).toBe(503);
    expect(body.status).toBe('NOT_CONNECTED');
    expect(body.message).toContain('keine Website untersucht');
    expectReadOnlyLookup(db);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns unavailable for an unknown lead and closes the read-only connection', async () => {
    const db = installDatabase(undefined);
    const response = await POST(makeRequest(), context);
    const body = await response.json() as { status: string };

    expect(response.status).toBe(404);
    expect(body.status).toBe('ANALYSIS_UNAVAILABLE');
    expectReadOnlyLookup(db);
  });

  it('closes the read-only connection and hides database details on query failure', async () => {
    const db = installDatabase('https://saved.example.test/');
    db.get.mockImplementation(() => { throw new Error('internal database detail'); });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(makeRequest(), context);
    const body = await response.json() as { status: string; message: string };

    expect(response.status).toBe(503);
    expect(body.status).toBe('ANALYSIS_UNAVAILABLE');
    expect(body.message).not.toContain('internal database detail');
    expect(openDatabase).toHaveBeenCalledWith('/readonly/crm.db', 'inspect');
    expect(db.close).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

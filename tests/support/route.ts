/**
 * Ruft einen echten App-Router-Handler mit einem echten Request auf (PXK-114).
 *
 * Charakterisiert wird auf Handler-Ebene: Wirft der Handler (Promise abgelehnt),
 * kommt { thrown } zurück — Next.js machte daraus eine 500-Antwort.
 */
export type RouteParams = Record<string, string>;

export type RouteHandler<P extends RouteParams> = (request: Request, context: { params: Promise<P> }) => Response | Promise<Response>;

export type CallOptions<P extends RouteParams> = {
  method?: string;
  /** Pfad inkl. optionaler Query, z. B. '/api/agent/leads/search?phone=030' */
  path?: string;
  query?: Record<string, string>;
  /** Objekt oder Liste von Paaren (für doppelte Header) */
  headers?: Record<string, string> | Array<[string, string]>;
  /** Objekt → JSON (mit content-type), String → unverändert als Body */
  body?: unknown;
  params?: P;
};

type Answered = { status: number; headers: Record<string, string>; bytes: Uint8Array; text: string; json: unknown; thrown?: undefined };
type Thrown = { thrown: { name: string; code: string | undefined; message: string } } & { [K in keyof Omit<Answered, 'thrown'>]?: undefined };
/** Entweder eine Antwort oder ein abgelehnter Handler — nie beides. */
export type RouteResult = Answered | Thrown;

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export async function callRoute<P extends RouteParams>(handler: RouteHandler<P>, options: CallOptions<P> = {}): Promise<RouteResult> {
  const { method = 'GET', path = '/', query, headers = {}, body, params = {} as P } = options;
  const url = new URL(path, 'http://localhost');
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  const requestHeaders = new Headers(headers);
  const init: RequestInit = { method, headers: requestHeaders };
  if (body !== undefined) {
    if (typeof body === 'string') init.body = body;
    else {
      init.body = JSON.stringify(body);
      if (!requestHeaders.has('content-type')) requestHeaders.set('content-type', 'application/json');
    }
  }
  let response: Response;
  try {
    response = await handler(new Request(url, init), { params: Promise.resolve(params) });
  } catch (error) {
    const e = error as { name?: unknown; code?: unknown; message?: unknown };
    return { thrown: { name: String(e?.name ?? typeof error), code: typeof e?.code === 'string' ? e.code : undefined, message: String(e?.message ?? error) } };
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: Object.fromEntries(response.headers.entries()), bytes, text, json };
}

/**
 * Importiert alle fünf Agent-Routen (sechs Handler) aus dem aktuellen Modulgraphen.
 * Erst NACH createTestDb()/pointAppAt() aufrufen, damit sie dieselbe lib/d1-node-Instanz nutzen.
 */
export async function loadAgentRoutes() {
  const [ping, leads, search, lead, activities] = await Promise.all([
    import('@/app/api/agent/ping/route'),
    import('@/app/api/agent/leads/route'),
    import('@/app/api/agent/leads/search/route'),
    import('@/app/api/agent/leads/[id]/route'),
    import('@/app/api/agent/leads/[id]/activities/route'),
  ]);
  return { ping, leads, search, lead, activities };
}
export type AgentRoutes = Awaited<ReturnType<typeof loadAgentRoutes>>;

/** Die sechs Handler mit einer Standard-Anfrage, deren Ergebnis „Auth bestanden“ eindeutig erkennen lässt. */
export const HANDLER_PROBES = {
  ping: (r: AgentRoutes, headers: CallOptions<RouteParams>['headers']) => callRoute(r.ping.GET, { path: '/api/agent/ping', headers }),
  create: (r: AgentRoutes, headers: CallOptions<RouteParams>['headers']) =>
    callRoute(r.leads.POST, { method: 'POST', path: '/api/agent/leads', headers, body: { name: 'A' } }),
  search: (r: AgentRoutes, headers: CallOptions<RouteParams>['headers']) => callRoute(r.search.GET, { path: '/api/agent/leads/search', headers }),
  get: (r: AgentRoutes, headers: CallOptions<RouteParams>['headers']) =>
    callRoute(r.lead.GET, { path: '/api/agent/leads/NOPE-404', headers, params: { id: 'NOPE-404' } }),
  patch: (r: AgentRoutes, headers: CallOptions<RouteParams>['headers']) =>
    callRoute(r.lead.PATCH, { method: 'PATCH', path: '/api/agent/leads/NOPE-404', headers, body: { status: 'Neu' }, params: { id: 'NOPE-404' } }),
  activities: (r: AgentRoutes, headers: CallOptions<RouteParams>['headers']) =>
    callRoute(r.activities.POST, { method: 'POST', path: '/api/agent/leads/PK-0001/activities', headers, body: { detail: 'x' }, params: { id: 'PK-0001' } }),
} as const;
export type HandlerName = keyof typeof HANDLER_PROBES;
export const HANDLER_NAMES = Object.keys(HANDLER_PROBES) as HandlerName[];

/** Ruft alle sechs Handler nacheinander und liefert je Handler Status (oder 'threw:<code|name>') und Body. */
export async function probeAll(r: AgentRoutes, headers: CallOptions<RouteParams>['headers']) {
  const out: Record<string, { status: number | string; json?: unknown }> = {};
  for (const name of HANDLER_NAMES) {
    const res = await HANDLER_PROBES[name](r, headers);
    out[name] = res.thrown ? { status: `threw:${res.thrown.code ?? res.thrown.name}` } : { status: res.status, json: res.json };
  }
  return out;
}

/** Schlüssel, den die Tests als settings.agent_api_key anlegen, und der passende Header. */
export const TEST_AGENT_KEY = 'test-agent-key-0123456789';
export const TEST_AUTH = bearer(TEST_AGENT_KEY);
type AuthHeaders = CallOptions<RouteParams>['headers'];

/** Kurzformen der fünf Agent-Aufrufe; `query` hängt z. B. '?token=…' an den Pfad. */
export const postLeads = (r: AgentRoutes, body: unknown, headers: AuthHeaders = TEST_AUTH, query = '') =>
  callRoute(r.leads.POST, { method: 'POST', path: `/api/agent/leads${query}`, headers, body });
export const searchLeads = (r: AgentRoutes, query: string, headers: AuthHeaders = TEST_AUTH) =>
  callRoute(r.search.GET, { path: `/api/agent/leads/search${query}`, headers });
export const getLead = (r: AgentRoutes, id: string, headers: AuthHeaders = TEST_AUTH) =>
  callRoute(r.lead.GET, { path: `/api/agent/leads/${id}`, headers, params: { id } });
export const patchLead = (r: AgentRoutes, id: string, body: unknown, headers: AuthHeaders = TEST_AUTH, query = '') =>
  callRoute(r.lead.PATCH, { method: 'PATCH', path: `/api/agent/leads/${id}${query}`, headers, body, params: { id } });
export const postActivity = (r: AgentRoutes, id: string, body: unknown, headers: AuthHeaders = TEST_AUTH, query = '') =>
  callRoute(r.activities.POST, { method: 'POST', path: `/api/agent/leads/${id}/activities${query}`, headers, body, params: { id } });

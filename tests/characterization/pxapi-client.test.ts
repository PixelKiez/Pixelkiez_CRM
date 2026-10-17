import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPxapiAnalysisRequest } from '@/lib/pxapi-analysis';
import { createPxapiClient, type PxapiFetch } from '@/lib/pxapi-client';

const input = {
  runId: 'run-01',
  requestId: 'request-01',
  requestedAt: '2026-10-16T00:00:00Z',
  targetUrl: 'https://example.test/',
};
const baseUrl = 'https://pxapi.example.test';

type RunState = 'CREATED' | 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

function makeEnvelope(state: RunState = 'SUCCEEDED') {
  const terminal = state === 'SUCCEEDED' || state === 'FAILED' || state === 'CANCELLED';
  return {
    analysis_run_request: createPxapiAnalysisRequest(input),
    analysis_run_state: {
      schema_version: '1.0.0',
      run_id: input.runId,
      state,
      entered_at: input.requestedAt,
      ...(terminal ? { finished_at: input.requestedAt } : {}),
      ...(state === 'FAILED' ? { failure: { code: 'PAGE_FETCH_FAILED' } } : {}),
    },
    stage_executions: [],
    measurements: [],
    website_evidence: [],
    diagnostic_findings: [],
  };
}

function makeDanglingFindingReferenceEnvelope() {
  const envelope = makeEnvelope() as unknown as { diagnostic_findings: Record<string, unknown>[] };
  envelope.diagnostic_findings = [{
    schema_version: '1.0.0',
    run_id: input.runId,
    finding_id: 'finding-01',
    rule_id: 'HTTPS_TRANSPORT',
    rule_version: '1.0.0',
    finding_class: 'OBSERVATION',
    evidence_refs: ['missing-evidence'],
    finding_summary: 'A bounded observation.',
    business_impact: 'A bounded potential impact.',
    recommended_action: 'A bounded recommendation.',
    limitation: 'A bounded limitation.',
  }];
  return envelope;
}

function makeDanglingMeasurementReferenceEnvelope() {
  const envelope = makeEnvelope() as unknown as { website_evidence: Record<string, unknown>[] };
  envelope.website_evidence = [{
    schema_version: '1.0.0',
    run_id: input.runId,
    evidence_id: 'evidence-01',
    source_url: input.targetUrl,
    observed_at: input.requestedAt,
    scenario: 'HOMEPAGE_FETCH',
    collector: 'PXAPI',
    collector_version: '1.0.0',
    assessment: { collection_mode: 'OBSERVED', result_state: 'UNKNOWN' },
    measurement_refs: ['missing-measurement'],
  }];
  return envelope;
}

function jsonResponse(value: unknown, status = 200, contentType = 'application/json; charset=utf-8'): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': contentType } });
}

function client(fetcher: PxapiFetch, overrides: {
  baseUrl?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
} = {}) {
  return createPxapiClient({ baseUrl, fetcher, ...overrides });
}

let globalFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  globalFetch = vi.fn();
  vi.stubGlobal('fetch', globalFetch);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('offline PXAPI v1 client', () => {
  it('posts a canonical public-mode request only through the injected transport', async () => {
    const fetcher = vi.fn<PxapiFetch>().mockResolvedValue(jsonResponse(makeEnvelope()));
    const result = await client(fetcher).analyze(input);

    expect(result).toMatchObject({ kind: 'completed', envelope: makeEnvelope() });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(globalFetch).not.toHaveBeenCalled();
    const call = fetcher.mock.calls[0];
    if (!call) throw new Error('Expected the injected transport to be called.');
    const [url, init] = call;
    expect(url).toBe('https://pxapi.example.test/v1/analysis-runs');
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
    });
    const headers = new Headers(init?.headers);
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.has('authorization')).toBe(false);
    expect(JSON.parse(String(init?.body))).toEqual(createPxapiAnalysisRequest(input));
    expect(JSON.parse(String(init?.body))).not.toHaveProperty('requester_ref');
  });

  it('returns a FAILED run as analysis failure, not as a successful result', async () => {
    const fetcher = vi.fn<PxapiFetch>().mockResolvedValue(jsonResponse(makeEnvelope('FAILED')));
    const result = await client(fetcher).analyze(input);

    expect(result).toEqual({ kind: 'analysis_failed', runId: input.runId });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('treats a valid non-terminal run as an unknown outcome', async () => {
    const fetcher = vi.fn<PxapiFetch>().mockResolvedValue(jsonResponse(makeEnvelope('RUNNING')));
    const result = await client(fetcher).analyze(input);

    expect(result).toEqual({ kind: 'outcome_unknown', reason: 'non_terminal_run', runState: 'RUNNING' });
  });

  it('preserves empty findings without inventing a website-health conclusion', async () => {
    const fetcher = vi.fn<PxapiFetch>().mockResolvedValue(jsonResponse(makeEnvelope()));
    const result = await client(fetcher).analyze(input);

    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') throw new Error('Expected a validated completed envelope.');
    expect(result.envelope.diagnostic_findings).toEqual([]);
    expect(result).not.toHaveProperty('websiteHealthy');
    expect(result).not.toHaveProperty('score');
  });

  it.each(['run_id', 'request_id', 'target_url'] as const)('rejects a response with a mismatched %s', async (field: 'run_id' | 'request_id' | 'target_url') => {
    const envelope = makeEnvelope();
    if (field === 'run_id') {
      envelope.analysis_run_request.run_id = 'other-run';
      envelope.analysis_run_state.run_id = 'other-run';
    } else if (field === 'request_id') {
      envelope.analysis_run_request.request_id = 'other-request';
    } else {
      envelope.analysis_run_request.target_url = 'https://other.example.test/';
    }
    const fetcher = vi.fn<PxapiFetch>().mockResolvedValue(jsonResponse(envelope));
    const result = await client(fetcher).analyze(input);

    expect(result).toEqual({ kind: 'outcome_unknown', reason: 'request_mismatch' });
  });

  it('rejects schema drift and an unsupported UNKNOWN run state', async () => {
    const envelope = makeEnvelope() as unknown as Record<string, unknown>;
    envelope.unexpected_member = 'ignored only by no valid contract';
    const fetcher = vi.fn<PxapiFetch>().mockResolvedValue(jsonResponse(envelope));
    const result = await client(fetcher).analyze(input);
    expect(result).toEqual({ kind: 'outcome_unknown', reason: 'schema_mismatch' });

    const unknownState = makeEnvelope() as unknown as { analysis_run_state: Record<string, unknown> };
    unknownState.analysis_run_state.state = 'UNKNOWN';
    const unknownFetcher = vi.fn<PxapiFetch>().mockResolvedValue(jsonResponse(unknownState));
    const unknownResult = await client(unknownFetcher).analyze(input);
    expect(unknownResult).toEqual({ kind: 'outcome_unknown', reason: 'schema_mismatch' });
  });

  it('rejects an HTTP-200 envelope with a dangling finding evidence reference', async () => {
    const fetcher = vi.fn<PxapiFetch>().mockResolvedValue(jsonResponse(makeDanglingFindingReferenceEnvelope(), 200));
    const result = await client(fetcher).analyze(input);

    expect(result).toEqual({ kind: 'outcome_unknown', reason: 'schema_mismatch' });
    expect(result.kind).not.toBe('completed');
  });

  it('rejects an HTTP-200 envelope with a dangling evidence measurement reference', async () => {
    const fetcher = vi.fn<PxapiFetch>().mockResolvedValue(jsonResponse(makeDanglingMeasurementReferenceEnvelope(), 200));
    const result = await client(fetcher).analyze(input);

    expect(result).toEqual({ kind: 'outcome_unknown', reason: 'schema_mismatch' });
    expect(result.kind).not.toBe('completed');
  });

  it('requires JSON content type before parsing a success response', async () => {
    const fetcher = vi.fn<PxapiFetch>().mockResolvedValue(jsonResponse(makeEnvelope(), 200, 'text/plain'));
    const result = await client(fetcher).analyze(input);

    expect(result).toEqual({ kind: 'outcome_unknown', reason: 'unexpected_content_type' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects malformed JSON and invalid UTF-8 without returning parser details', async () => {
    const malformed = vi.fn<PxapiFetch>().mockResolvedValue(new Response('{', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    expect(await client(malformed).analyze(input)).toEqual({ kind: 'outcome_unknown', reason: 'invalid_json' });

    const invalidUtf8 = vi.fn<PxapiFetch>().mockResolvedValue(new Response(new Uint8Array([0xff]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    expect(await client(invalidUtf8).analyze(input)).toEqual({ kind: 'outcome_unknown', reason: 'invalid_utf8' });
  });

  it('enforces the response-byte ceiling while streaming the body', async () => {
    const fetcher = vi.fn<PxapiFetch>().mockResolvedValue(new Response('x'.repeat(64), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const result = await client(fetcher, { maxResponseBytes: 16 }).analyze(input);

    expect(result).toEqual({ kind: 'outcome_unknown', reason: 'response_too_large' });
  });

  it('returns a safe rate-limit outcome and never retries', async () => {
    const fetcher = vi.fn<PxapiFetch>().mockResolvedValue(new Response('private upstream detail', { status: 429 }));
    const result = await client(fetcher).analyze(input);

    expect(result).toEqual({ kind: 'rate_limited', status: 429 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('private upstream detail');
  });

  it('treats 5xx as an unknown outcome and does not expose the upstream body or retry', async () => {
    const fetcher = vi.fn<PxapiFetch>().mockResolvedValue(new Response('private upstream detail', { status: 503 }));
    const result = await client(fetcher).analyze(input);

    expect(result).toEqual({ kind: 'outcome_unknown', reason: 'upstream_error', status: 503 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('private upstream detail');
  });

  it('maps other non-200 responses to a bounded rejection without parsing their body', async () => {
    const fetcher = vi.fn<PxapiFetch>().mockResolvedValue(new Response('private detail', { status: 422 }));
    const result = await client(fetcher).analyze(input);

    expect(result).toEqual({ kind: 'http_rejected', status: 422 });
    expect(JSON.stringify(result)).not.toContain('private detail');
  });

  it('maps transport exceptions to an unknown outcome without exposing exception text', async () => {
    const fetcher = vi.fn<PxapiFetch>().mockRejectedValue(new Error('private transport detail'));
    const result = await client(fetcher).analyze(input);

    expect(result).toEqual({ kind: 'outcome_unknown', reason: 'transport_error' });
    expect(JSON.stringify(result)).not.toContain('private transport detail');
  });

  it('bounds a pending transport with an aborting timeout and does not retry', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<PxapiFetch>().mockImplementation(() => new Promise<Response>(() => undefined));
    const pending = client(fetcher, { timeoutMs: 10 }).analyze(input);
    await vi.advanceTimersByTimeAsync(10);

    expect(await pending).toEqual({ kind: 'outcome_unknown', reason: 'timeout' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1].signal?.aborted).toBe(true);
  });

  it('bounds response-body reading with the same timeout', async () => {
    vi.useFakeTimers();
    const stalledBody = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
    });
    const fetcher = vi.fn<PxapiFetch>().mockResolvedValue(new Response(stalledBody, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const pending = client(fetcher, { timeoutMs: 10 }).analyze(input);
    await vi.advanceTimersByTimeAsync(10);

    expect(await pending).toEqual({ kind: 'outcome_unknown', reason: 'timeout' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('sanitizes response stream read failures', async () => {
    const failedBody = new ReadableStream<Uint8Array>({
      start: controller => controller.error(new Error('private body detail')),
    });
    const fetcher = vi.fn<PxapiFetch>().mockResolvedValue(new Response(failedBody, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const result = await client(fetcher).analyze(input);

    expect(result).toEqual({ kind: 'outcome_unknown', reason: 'response_read_error' });
    expect(JSON.stringify(result)).not.toContain('private body detail');
  });

  it.each([
    'not a URL',
    'ftp://pxapi.example.test',
    'https://pxapi.example.test/path',
    'https://pxapi.example.test/?q=value',
    'https://pxapi.example.test/#fragment',
  ])('fails closed for invalid base URL %s before transport', async (invalidBaseUrl: string) => {
    const fetcher = vi.fn<PxapiFetch>();
    const result = await client(fetcher, { baseUrl: invalidBaseUrl }).analyze(input);

    expect(result).toEqual({ kind: 'invalid_configuration' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fails closed for invalid request or transport limits before transport', async () => {
    const fetcher = vi.fn<PxapiFetch>();
    const sameIds = { ...input, requestId: input.runId };
    expect(await client(fetcher).analyze(sameIds)).toEqual({ kind: 'invalid_request' });
    expect(await client(fetcher, { timeoutMs: 0 }).analyze(input)).toEqual({ kind: 'invalid_configuration' });
    expect(await client(fetcher, { maxResponseBytes: 0 }).analyze(input)).toEqual({ kind: 'invalid_configuration' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses browser runtime before calling the injected transport', async () => {
    vi.stubGlobal('window', {});
    const fetcher = vi.fn<PxapiFetch>();
    const result = await client(fetcher).analyze(input);

    expect(result).toEqual({ kind: 'client_runtime' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

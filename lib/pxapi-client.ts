import {
  createPxapiAnalysisRequest,
  validatePxapiAnalysisRequest,
  validatePxapiAnalysisResponse,
} from '@/lib/pxapi-analysis';
import type { PxapiAnalysisRequest } from '@/lib/pxapi-analysis';

export const PXAPI_CLIENT_TIMEOUT_MS = 25_000;
export const PXAPI_CLIENT_MAX_RESPONSE_BYTES = 1_048_576;
export const PXAPI_ANALYSIS_RUNS_PATH = '/v1/analysis-runs';

export type PxapiFetch = (input: string | URL, init: RequestInit) => Promise<Response>;
export type PxapiAnalysisInput = Parameters<typeof createPxapiAnalysisRequest>[0];
export type PxapiRunState = 'CREATED' | 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

type JsonObject = Record<string, unknown>;

export type PxapiAnalysisEnvelope = {
  analysis_run_request: PxapiAnalysisRequest & { requester_ref?: string };
  analysis_run_state: JsonObject & { run_id: string; state: PxapiRunState };
  stage_executions: JsonObject[];
  measurements: JsonObject[];
  website_evidence: JsonObject[];
  diagnostic_findings: JsonObject[];
};

export type PxapiOutcomeUnknownReason =
  | 'timeout'
  | 'transport_error'
  | 'upstream_error'
  | 'unexpected_content_type'
  | 'response_too_large'
  | 'response_read_error'
  | 'invalid_utf8'
  | 'invalid_json'
  | 'schema_mismatch'
  | 'request_mismatch'
  | 'non_terminal_run'
  | 'response_processing_error';

export type PxapiClientResult =
  | { kind: 'completed'; envelope: PxapiAnalysisEnvelope }
  | { kind: 'analysis_failed'; runId: string }
  | { kind: 'analysis_cancelled'; runId: string }
  | { kind: 'rate_limited'; status: 429 }
  | { kind: 'http_rejected'; status: number }
  | { kind: 'outcome_unknown'; reason: PxapiOutcomeUnknownReason; status?: number; runState?: 'CREATED' | 'QUEUED' | 'RUNNING' }
  | { kind: 'invalid_request' }
  | { kind: 'invalid_configuration' }
  | { kind: 'client_runtime' };

export type PxapiClientOptions = {
  baseUrl: string;
  fetcher: PxapiFetch;
  /** Tests may lower the hard ceiling; callers cannot raise it. */
  timeoutMs?: number;
  /** Tests may lower the hard ceiling; callers cannot raise it. */
  maxResponseBytes?: number;
};

const ABORTED = Symbol('pxapi-client-aborted');

type ReadBodyResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: 'response_too_large' | 'response_read_error' };

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function endpointFor(baseUrl: string): string | undefined {
  if (typeof baseUrl !== 'string' || baseUrl !== baseUrl.trim()) return undefined;
  try {
    const base = new URL(baseUrl);
    if (base.protocol !== 'http:' && base.protocol !== 'https:') return undefined;
    if (base.username || base.password || base.search || base.hash || base.pathname !== '/') return undefined;
    return new URL(PXAPI_ANALYSIS_RUNS_PATH, base).toString();
  } catch {
    return undefined;
  }
}

function boundedLimit(value: number | undefined, maximum: number): number | undefined {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 1) return undefined;
  return Math.min(value, maximum);
}

function discardBody(response: Response): void {
  if (response.body) void response.body.cancel().catch(() => undefined);
}

function waitForSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(ABORTED);
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(ABORTED);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      value => {
        cleanup();
        resolve(value);
      },
      error => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<ReadBodyResult> {
  const contentLength = response.headers.get('content-length')?.trim();
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    discardBody(response);
    return { ok: false, reason: 'response_too_large' };
  }

  if (!response.body) return { ok: true, bytes: new Uint8Array() };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await waitForSignal(reader.read(), signal);
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        void reader.cancel().catch(() => undefined);
        return { ok: false, reason: 'response_too_large' };
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error === ABORTED) throw error;
    return { ok: false, reason: 'response_read_error' };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A timed-out pending read can keep the lock until cancellation settles.
    }
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

function responseState(value: unknown): PxapiRunState | undefined {
  if (!isRecord(value) || !isRecord(value.analysis_run_state)) return undefined;
  const state = value.analysis_run_state.state;
  if (state === 'CREATED' || state === 'QUEUED' || state === 'RUNNING'
    || state === 'SUCCEEDED' || state === 'FAILED' || state === 'CANCELLED') return state;
  return undefined;
}

/**
 * Server-side, deliberately unconnected PXAPI-v1 client core.
 * A transport must be supplied explicitly; this module never reads credentials or environment variables.
 */
export function createPxapiClient(options: PxapiClientOptions): {
  analyze(input: PxapiAnalysisInput): Promise<PxapiClientResult>;
} {
  return {
    async analyze(input): Promise<PxapiClientResult> {
      if (typeof window !== 'undefined') return { kind: 'client_runtime' };
      if (!options || typeof options !== 'object') return { kind: 'invalid_configuration' };

      const endpoint = endpointFor(options.baseUrl);
      const timeoutMs = boundedLimit(options.timeoutMs, PXAPI_CLIENT_TIMEOUT_MS);
      const maxResponseBytes = boundedLimit(options.maxResponseBytes, PXAPI_CLIENT_MAX_RESPONSE_BYTES);
      if (!endpoint || typeof options.fetcher !== 'function' || timeoutMs === undefined || maxResponseBytes === undefined) {
        return { kind: 'invalid_configuration' };
      }

      let request: PxapiAnalysisRequest;
      try {
        request = createPxapiAnalysisRequest(input);
      } catch {
        return { kind: 'invalid_request' };
      }
      if (!validatePxapiAnalysisRequest(request).valid) return { kind: 'invalid_request' };

      const controller = new AbortController();
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutOutcome = new Promise<PxapiClientResult>(resolve => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          resolve({ kind: 'outcome_unknown', reason: 'timeout' });
        }, timeoutMs);
      });

      const operation = async (): Promise<PxapiClientResult> => {
        const response = await options.fetcher(endpoint, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
          },
          body: JSON.stringify(request),
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error',
          signal: controller.signal,
        });

        if (response.status === 429) {
          discardBody(response);
          return { kind: 'rate_limited', status: 429 };
        }
        if (response.status >= 500 && response.status <= 599) {
          discardBody(response);
          return { kind: 'outcome_unknown', reason: 'upstream_error', status: response.status };
        }
        if (response.status !== 200) {
          discardBody(response);
          return { kind: 'http_rejected', status: response.status };
        }

        const mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
        if (mediaType !== 'application/json') {
          discardBody(response);
          return { kind: 'outcome_unknown', reason: 'unexpected_content_type' };
        }

        const body = await readBoundedBody(response, maxResponseBytes, controller.signal);
        if (!body.ok) return { kind: 'outcome_unknown', reason: body.reason };

        let parsed: unknown;
        try {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(body.bytes);
          parsed = JSON.parse(text) as unknown;
        } catch (error) {
          if (error === ABORTED) throw error;
          return {
            kind: 'outcome_unknown',
            reason: error instanceof TypeError ? 'invalid_utf8' : 'invalid_json',
          };
        }

        let validation: ReturnType<typeof validatePxapiAnalysisResponse>;
        try {
          validation = validatePxapiAnalysisResponse(parsed);
        } catch {
          return { kind: 'outcome_unknown', reason: 'response_processing_error' };
        }
        if (!validation.valid) return { kind: 'outcome_unknown', reason: 'schema_mismatch' };
        if (!isRecord(parsed) || !isRecord(parsed.analysis_run_request)) {
          return { kind: 'outcome_unknown', reason: 'schema_mismatch' };
        }

        const returnedRequest = parsed.analysis_run_request;
        if (returnedRequest.run_id !== request.run_id
          || returnedRequest.request_id !== request.request_id
          || returnedRequest.target_url !== request.target_url) {
          return { kind: 'outcome_unknown', reason: 'request_mismatch' };
        }

        const runId = request.run_id;
        const state = responseState(parsed);
        if (!state) return { kind: 'outcome_unknown', reason: 'schema_mismatch' };
        if (state === 'FAILED') return { kind: 'analysis_failed', runId };
        if (state === 'CANCELLED') return { kind: 'analysis_cancelled', runId };
        if (state !== 'SUCCEEDED') {
          return { kind: 'outcome_unknown', reason: 'non_terminal_run', runState: state };
        }

        return { kind: 'completed', envelope: parsed as unknown as PxapiAnalysisEnvelope };
      };

      try {
        return await Promise.race([operation(), timeoutOutcome]);
      } catch {
        return {
          kind: 'outcome_unknown',
          reason: timedOut ? 'timeout' : 'transport_error',
        };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPxapiAnalysisRequest,
  getPxapiProviderState,
  isValidStoredWebsite,
  validatePxapiAnalysisRequest,
  validatePxapiAnalysisResponse,
  validatePxapiProblem,
} from '@/lib/pxapi-analysis';
import {
  addMinutes,
  centsToInput,
  contactHref,
  defaultStart,
  inputToCents,
  leadActivityLabel,
  leadAnalysisStatusMessage,
  leadLabel,
  mapLeadAnalysisResponse,
  monthsAhead,
  smartAction,
} from '@/app/components/lead-drawer-utils';
import type { Lead } from '@/lib/types';

const targetUrl = 'https://example.test/';
const timestamp = '2026-09-05T09:12:44Z';

function makeResponse() {
  const request = createPxapiAnalysisRequest({
    runId: 'run-01',
    requestId: 'request-01',
    requestedAt: timestamp,
    targetUrl,
  });
  const assessment: Record<string, unknown> = { collection_mode: 'OBSERVED', result_state: 'KNOWN' };
  const measurement: Record<string, unknown> = {
    schema_version: '1.0.0',
    run_id: 'run-01',
    measurement_id: 'measurement-01',
    metric_id: 'HTTPS_TRANSPORT',
    source_url: targetUrl,
    observed_at: timestamp,
    collector: 'PXAPI',
    collector_version: '1.0.0',
    assessment: { ...assessment },
    result: { value_type: 'BOOLEAN', boolean_value: true },
  };
  const evidence: Record<string, unknown> = {
    schema_version: '1.0.0',
    run_id: 'run-01',
    evidence_id: 'evidence-01',
    source_url: targetUrl,
    observed_at: timestamp,
    scenario: 'HOMEPAGE_FETCH',
    collector: 'PXAPI',
    collector_version: '1.0.0',
    assessment: { ...assessment },
    polarity: 'POSITIVE',
    measurement_refs: ['measurement-01'],
  };
  const finding: Record<string, unknown> = {
    schema_version: '1.0.0',
    run_id: 'run-01',
    finding_id: 'finding-01',
    rule_id: 'HTTPS_TRANSPORT',
    rule_version: '1.0.0',
    finding_class: 'OBSERVATION',
    evidence_refs: ['evidence-01'],
    finding_summary: 'The public page uses HTTPS.',
    business_impact: 'Encrypted transport can protect visitor traffic.',
    recommended_action: 'Keep HTTPS enabled.',
    limitation: 'This observation does not assess other pages.',
  };
  return {
    analysis_run_request: request,
    analysis_run_state: {
      schema_version: '1.0.0',
      run_id: 'run-01',
      state: 'SUCCEEDED',
      entered_at: timestamp,
      finished_at: timestamp,
    },
    stage_executions: [{
      schema_version: '1.0.0',
      run_id: 'run-01',
      stage_id: 'PAGE_FETCH',
      status: 'SUCCEEDED',
      started_at: timestamp,
      finished_at: timestamp,
    }],
    measurements: [measurement],
    website_evidence: [evidence],
    diagnostic_findings: [finding],
  };
}

describe('PXAPI analysis contracts', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('builds only the approved public-mode request without requester PII', () => {
    const request = createPxapiAnalysisRequest({
      runId: 'run-01',
      requestId: 'request-01',
      requestedAt: timestamp,
      targetUrl,
    });

    expect(request).toEqual({
      schema_version: '1.0.0',
      run_id: 'run-01',
      request_id: 'request-01',
      requested_at: timestamp,
      target_url: targetUrl,
      scan_mode: 'PUBLIC_NON_INVASIVE',
    });
    expect(validatePxapiAnalysisRequest(request).valid).toBe(true);
  });

  it('rejects non-public scan modes and structurally invalid stored websites', () => {
    const request = createPxapiAnalysisRequest({
      runId: 'run-01',
      requestId: 'request-01',
      requestedAt: timestamp,
      targetUrl,
    });
    expect(validatePxapiAnalysisRequest({ ...request, scan_mode: 'OWNER_VERIFIED_CONTROLLED' }).valid).toBe(false);
    expect(isValidStoredWebsite('https://example.test/')).toBe(true);
    expect(isValidStoredWebsite('example.test')).toBe(false);
    expect(isValidStoredWebsite('ftp://example.test')).toBe(false);
    expect(isValidStoredWebsite('https://user:secret@example.test/')).toBe(false);
    expect(isValidStoredWebsite(null)).toBe(false);
  });

  it('validates canonical response schemas and all document references', () => {
    expect(validatePxapiAnalysisResponse(makeResponse(), { expectedTargetUrl: targetUrl })).toEqual({ valid: true, issues: [] });
  });

  it('rejects dangling evidence-to-measurement references', () => {
    const response = makeResponse();
    response.measurements = [];

    const result = validatePxapiAnalysisResponse(response);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({ path: '/website_evidence/0/measurement_refs/0', keyword: 'reference' });
  });

  it('does not allow findings to turn UNKNOWN evidence into website claims', () => {
    const response = makeResponse();
    response.measurements[0].assessment = { collection_mode: 'OBSERVED', result_state: 'UNKNOWN' };
    delete response.measurements[0].result;
    response.website_evidence[0].assessment = { collection_mode: 'OBSERVED', result_state: 'UNKNOWN' };
    delete response.website_evidence[0].polarity;

    const result = validatePxapiAnalysisResponse(response);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({ path: '/diagnostic_findings/0/evidence_refs/0', keyword: 'reference' });
  });

  it('validates the canonical problem contract', () => {
    expect(validatePxapiProblem({
      schema_version: '1.0.0',
      code: 'PXAPI_NOT_CONNECTED',
      title: 'Not connected',
      detail: 'The analysis provider is disabled.',
      errors: [],
    }).valid).toBe(true);
  });

  it('keeps the provider disconnected even when a base URL is configured', () => {
    vi.stubEnv('PXAPI_BASE_URL', 'https://pxapi.example.test');
    expect(getPxapiProviderState()).toBe('NOT_CONNECTED');
  });
});

describe('lead analysis presentation helpers', () => {
  it('maps only fixed server status codes and never renders server-provided detail', () => {
    expect(mapLeadAnalysisResponse(503, { status: 'NOT_CONNECTED', message: 'secret detail' })).toBe('not_connected');
    expect(leadAnalysisStatusMessage('not_connected')).toContain('keine Website untersucht');
    expect(mapLeadAnalysisResponse(500, { status: 'UNKNOWN', message: 'secret detail' })).toBe('unavailable');
    expect(leadAnalysisStatusMessage('unavailable')).not.toContain('secret detail');
  });
});

describe('existing lead drawer helpers', () => {
  const lead = (overrides: Partial<Lead>) => ({
    websiteStatus: 'Prüfen',
    phone: null,
    email: null,
    lostReason: null,
    ...overrides,
  }) as Lead;

  it('preserves euro input and cents conversion', () => {
    expect(centsToInput(149000)).toBe('1490.00');
    expect(inputToCents(' 1490,00 ')).toBe(149000);
    expect(inputToCents('')).toBeNull();
    expect(inputToCents('-1')).toBeNull();
    expect(inputToCents('invalid')).toBeNull();
  });

  it('preserves labels and contact-link normalization', () => {
    expect(leadLabel('web_design')).toBe('Web Design');
    expect(leadLabel(null)).toBe('Nicht angegeben');
    expect(contactHref('phone', '0 3 0')).toBe('tel:030');
    expect(contactHref('email', 'a@example.test')).toBe('mailto:a@example.test');
    expect(contactHref('website', 'example.test')).toBe('https://example.test');
  });

  it('preserves next-step and activity labels', () => {
    expect(smartAction(lead({ websiteStatus: 'Nein', phone: '030' }))).toContain('Telefonischer Erstkontakt');
    expect(smartAction(lead({ websiteStatus: 'Prüfen' }))).toContain('verifizieren');
    expect(smartAction(lead({ websiteStatus: 'Ja', email: 'a@example.test' }))).toContain('E-Mail');
    expect(smartAction(lead({ websiteStatus: 'Ja' }))).toContain('Kontaktdaten ergänzen');
    expect(leadActivityLabel('email_sent')).toBe('E-Mail gesendet');
    expect(leadActivityLabel('unknown')).toBe('Bearbeitet');
  });

  it('preserves date helper output formats', () => {
    expect(defaultStart()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(addMinutes('2026-10-15T10:00', 30)).toBe('2026-10-15T10:30');
    expect(monthsAhead(6)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

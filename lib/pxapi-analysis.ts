import Ajv2020 from 'ajv/dist/2020.js';
import type { AnySchema, ValidateFunction } from 'ajv';
import assessmentSchema from '@/config/pxapi/v1/assessment.v1.json';
import analysisRunRequestSchema from '@/config/pxapi/v1/analysis-run-request.v1.json';
import analysisRunStateSchema from '@/config/pxapi/v1/analysis-run-state.v1.json';
import commonSchema from '@/config/pxapi/v1/common.v1.json';
import diagnosticFindingSchema from '@/config/pxapi/v1/diagnostic-finding.v1.json';
import measurementRecordSchema from '@/config/pxapi/v1/measurement-record.v1.json';
import problemSchema from '@/config/pxapi/v1/problem.v1.json';
import stageExecutionRecordSchema from '@/config/pxapi/v1/stage-execution-record.v1.json';
import websiteEvidenceSchema from '@/config/pxapi/v1/website-evidence.v1.json';

export const PXAPI_PROVIDER_ENABLED = false as const;
export const PXAPI_SCHEMA_VERSION = '1.0.0' as const;
export const PXAPI_SCAN_MODE = 'PUBLIC_NON_INVASIVE' as const;

export type PxapiAnalysisRequest = {
  schema_version: typeof PXAPI_SCHEMA_VERSION;
  run_id: string;
  request_id: string;
  requested_at: string;
  target_url: string;
  scan_mode: typeof PXAPI_SCAN_MODE;
};

export type PxapiValidationIssue = { path: string; keyword: string };
export type PxapiValidationResult =
  | { valid: true; issues: [] }
  | { valid: false; issues: PxapiValidationIssue[] };

type JsonRecord = Record<string, unknown>;

const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
const schemas: AnySchema[] = [
  commonSchema as AnySchema,
  assessmentSchema as AnySchema,
  analysisRunRequestSchema as AnySchema,
  analysisRunStateSchema as AnySchema,
  stageExecutionRecordSchema as AnySchema,
  measurementRecordSchema as AnySchema,
  websiteEvidenceSchema as AnySchema,
  diagnosticFindingSchema as AnySchema,
  problemSchema as AnySchema,
];
for (const schema of schemas) ajv.addSchema(schema);

function validator(id: string): ValidateFunction {
  const found = ajv.getSchema(id);
  if (!found) throw new Error('PXAPI schema registration failed.');
  return found;
}

const validateRequestSchema = validator('urn:pxapi:schema:analysis-run-request:1.0.0');
const validateRunStateSchema = validator('urn:pxapi:schema:analysis-run-state:1.0.0');
const validateStageSchema = validator('urn:pxapi:schema:stage-execution-record:1.0.0');
const validateMeasurementSchema = validator('urn:pxapi:schema:measurement-record:1.0.0');
const validateEvidenceSchema = validator('urn:pxapi:schema:website-evidence:1.0.0');
const validateFindingSchema = validator('urn:pxapi:schema:diagnostic-finding:1.0.0');
const validateProblemSchema = validator('urn:pxapi:schema:problem:1.0.0');

const RESPONSE_KEYS = [
  'analysis_run_request',
  'analysis_run_state',
  'stage_executions',
  'measurements',
  'website_evidence',
  'diagnostic_findings',
] as const;

const RESPONSE_ARRAYS = [
  ['stage_executions', validateStageSchema],
  ['measurements', validateMeasurementSchema],
  ['website_evidence', validateEvidenceSchema],
  ['diagnostic_findings', validateFindingSchema],
] as const;

function record(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function result(issues: PxapiValidationIssue[]): PxapiValidationResult {
  return issues.length === 0
    ? { valid: true, issues: [] }
    : { valid: false, issues: issues.slice(0, 50) };
}

function schemaIssues(validate: ValidateFunction, value: unknown, prefix = ''): PxapiValidationIssue[] {
  if (validate(value)) return [];
  return (validate.errors ?? []).map((error: { instancePath: string; keyword: string }) => ({
    path: `${prefix}${error.instancePath}`,
    keyword: error.keyword,
  }));
}

function prefixed(issues: PxapiValidationIssue[], prefix: string): PxapiValidationIssue[] {
  return issues.map(issue => ({ ...issue, path: `${prefix}${issue.path}` }));
}

function fieldString(value: unknown, key: string): string | undefined {
  if (!record(value)) return undefined;
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

function isKnownAssessment(value: unknown): boolean {
  return record(value) && value.result_state === 'KNOWN';
}

function hasKnownMeasurement(value: unknown): boolean {
  return record(value)
    && isKnownAssessment(value.assessment)
    && record(value.result);
}

function duplicateIdIssues(
  documents: unknown[],
  idField: string,
  path: string,
): PxapiValidationIssue[] {
  const seen = new Set<string>();
  const issues: PxapiValidationIssue[] = [];
  documents.forEach((document, index) => {
    const id = fieldString(document, idField);
    if (!id) return;
    if (seen.has(id)) issues.push({ path: `${path}/${index}/${idField}`, keyword: 'uniqueItems' });
    else seen.add(id);
  });
  return issues;
}

/** Builds an in-memory canonical request; it performs no I/O and includes no requester identity. */
export function createPxapiAnalysisRequest(input: {
  runId: string;
  requestId: string;
  requestedAt: string;
  targetUrl: string;
}): PxapiAnalysisRequest {
  return {
    schema_version: PXAPI_SCHEMA_VERSION,
    run_id: input.runId,
    request_id: input.requestId,
    requested_at: input.requestedAt,
    target_url: input.targetUrl,
    scan_mode: PXAPI_SCAN_MODE,
  };
}

/** The local profile accepts only public, non-invasive requests. */
export function validatePxapiAnalysisRequest(value: unknown): PxapiValidationResult {
  const issues = schemaIssues(validateRequestSchema, value);
  if (record(value) && value.scan_mode !== PXAPI_SCAN_MODE) {
    issues.push({ path: '/scan_mode', keyword: 'const' });
  }
  if (record(value) && typeof value.run_id === 'string' && value.run_id === value.request_id) {
    issues.push({ path: '/request_id', keyword: 'not' });
  }
  return result(issues);
}

/** Structural URL check only; this never resolves DNS, follows redirects, or contacts a site. */
export function isValidStoredWebsite(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) return false;
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) return false;
    if (parsed.username || parsed.password) return false;
  } catch {
    return false;
  }
  return validatePxapiAnalysisRequest(createPxapiAnalysisRequest({
    runId: 'validation-run',
    requestId: 'validation-request',
    requestedAt: '2026-01-01T00:00:00Z',
    targetUrl: value,
  })).valid;
}

/** Validates all evidence/measurement/finding links without mutating the response. */
export function validatePxapiEvidenceReferences(value: unknown): PxapiValidationResult {
  if (!record(value)) return result([{ path: '', keyword: 'type' }]);

  const measurements = Array.isArray(value.measurements) ? value.measurements : [];
  const evidence = Array.isArray(value.website_evidence) ? value.website_evidence : [];
  const findings = Array.isArray(value.diagnostic_findings) ? value.diagnostic_findings : [];
  const request = value.analysis_run_request;
  const runId = fieldString(request, 'run_id');
  const issues: PxapiValidationIssue[] = [];
  const measurementsById = new Map<string, unknown>();
  const evidenceById = new Map<string, unknown>();

  issues.push(...duplicateIdIssues(measurements, 'measurement_id', '/measurements'));
  issues.push(...duplicateIdIssues(evidence, 'evidence_id', '/website_evidence'));
  issues.push(...duplicateIdIssues(findings, 'finding_id', '/diagnostic_findings'));

  for (const measurement of measurements) {
    const id = fieldString(measurement, 'measurement_id');
    if (id && !measurementsById.has(id)) measurementsById.set(id, measurement);
  }
  for (const document of evidence) {
    const id = fieldString(document, 'evidence_id');
    if (id && !evidenceById.has(id)) evidenceById.set(id, document);
  }

  evidence.forEach((document, evidenceIndex) => {
    const evidenceRunId = fieldString(document, 'run_id');
    if (runId && evidenceRunId && evidenceRunId !== runId) {
      issues.push({ path: `/website_evidence/${evidenceIndex}/run_id`, keyword: 'const' });
    }
    const refs = record(document) && Array.isArray(document.measurement_refs) ? document.measurement_refs : [];
    let hasEstablishedMeasurement = false;
    refs.forEach((reference, refIndex) => {
      if (typeof reference !== 'string') return;
      const measurement = measurementsById.get(reference);
      if (!measurement) {
        issues.push({ path: `/website_evidence/${evidenceIndex}/measurement_refs/${refIndex}`, keyword: 'reference' });
        return;
      }
      const measurementRunId = fieldString(measurement, 'run_id');
      if (evidenceRunId && measurementRunId && evidenceRunId !== measurementRunId) {
        issues.push({ path: `/website_evidence/${evidenceIndex}/measurement_refs/${refIndex}`, keyword: 'reference' });
      }
      if (hasKnownMeasurement(measurement)) hasEstablishedMeasurement = true;
    });
    if (isKnownAssessment(record(document) ? document.assessment : undefined) && !hasEstablishedMeasurement) {
      issues.push({ path: `/website_evidence/${evidenceIndex}/measurement_refs`, keyword: 'reference' });
    }
  });

  findings.forEach((finding, findingIndex) => {
    const findingRunId = fieldString(finding, 'run_id');
    if (runId && findingRunId && findingRunId !== runId) {
      issues.push({ path: `/diagnostic_findings/${findingIndex}/run_id`, keyword: 'const' });
    }
    const refs = record(finding) && Array.isArray(finding.evidence_refs) ? finding.evidence_refs : [];
    refs.forEach((reference, refIndex) => {
      if (typeof reference !== 'string') return;
      const citedEvidence = evidenceById.get(reference);
      const path = `/diagnostic_findings/${findingIndex}/evidence_refs/${refIndex}`;
      if (!citedEvidence) {
        issues.push({ path, keyword: 'reference' });
        return;
      }
      const citedRunId = fieldString(citedEvidence, 'run_id');
      if ((findingRunId && citedRunId && findingRunId !== citedRunId) || !isKnownAssessment(record(citedEvidence) ? citedEvidence.assessment : undefined)) {
        issues.push({ path, keyword: 'reference' });
        return;
      }
      const measurementRefs = record(citedEvidence) && Array.isArray(citedEvidence.measurement_refs)
        ? citedEvidence.measurement_refs
        : [];
      const grounded = measurementRefs.some(measurementId =>
        typeof measurementId === 'string' && hasKnownMeasurement(measurementsById.get(measurementId)),
      );
      if (!grounded) issues.push({ path, keyword: 'reference' });
    });
  });

  return result(issues);
}

/** Validates the six-document success envelope returned by the pinned PXAPI v1 adapter. */
export function validatePxapiAnalysisResponse(
  value: unknown,
  options: { expectedTargetUrl?: string } = {},
): PxapiValidationResult {
  if (!record(value)) return result([{ path: '', keyword: 'type' }]);
  const issues: PxapiValidationIssue[] = [];
  const keys = Object.keys(value);
  if (RESPONSE_KEYS.some(key => !Object.prototype.hasOwnProperty.call(value, key))) {
    issues.push({ path: '', keyword: 'required' });
  }
  if (keys.some(key => !(RESPONSE_KEYS as readonly string[]).includes(key))) {
    issues.push({ path: '', keyword: 'additionalProperties' });
  }

  issues.push(...prefixed(validatePxapiAnalysisRequest(value.analysis_run_request).issues, '/analysis_run_request'));
  issues.push(...schemaIssues(validateRunStateSchema, value.analysis_run_state, '/analysis_run_state'));
  for (const [key, validate] of RESPONSE_ARRAYS) {
    const documents = value[key];
    if (!Array.isArray(documents)) {
      issues.push({ path: `/${key}`, keyword: 'type' });
      continue;
    }
    documents.forEach((document, index) => {
      issues.push(...schemaIssues(validate, document, `/${key}/${index}`));
    });
  }

  const requestRunId = fieldString(value.analysis_run_request, 'run_id');
  if (options.expectedTargetUrl && fieldString(value.analysis_run_request, 'target_url') !== options.expectedTargetUrl) {
    issues.push({ path: '/analysis_run_request/target_url', keyword: 'const' });
  }

  const runScopedDocuments: Array<{ path: string; document: unknown }> = [
    { path: 'analysis_run_state', document: value.analysis_run_state },
  ];
  for (const [key] of RESPONSE_ARRAYS) {
    const documents = value[key];
    if (Array.isArray(documents)) {
      documents.forEach((document, index) => runScopedDocuments.push({ path: `${key}/${index}`, document }));
    }
  }
  for (const { path, document } of runScopedDocuments) {
    const documentRunId = fieldString(document, 'run_id');
    if (requestRunId && documentRunId && documentRunId !== requestRunId) {
      issues.push({ path: `/${path}/run_id`, keyword: 'const' });
    }
  }

  issues.push(...validatePxapiEvidenceReferences(value).issues);
  return result(issues);
}

/** Validates the transport-neutral canonical problem document; error text is never exposed by this module. */
export function validatePxapiProblem(value: unknown): PxapiValidationResult {
  return result(schemaIssues(validateProblemSchema, value));
}

/** The Phase-A provider switch is intentionally constant and ignores environment configuration. */
export function getPxapiProviderState(): 'NOT_CONNECTED' {
  return 'NOT_CONNECTED';
}

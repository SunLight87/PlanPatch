// Adapted from work/one-shot-probe-20261027/diagnostics.mjs. Keep this allowlist
// boundary: never retain provider messages, raw headers, raw exceptions or bodies.
const CODES = new Set([
  'token_rate_limit_exceeded', 'ip_rate_limit_exceeded',
  'token_concurrency_rate_limit_exceeded', 'model_concurrency_rate_limit_exceeded',
  'process_concurrency_rate_limit_exceeded', 'global_concurrency_rate_limit_exceeded',
  'rate_limit_exceeded', 'insufficient_quota', 'quota_exceeded',
  'invalid_api_key', 'model_not_found', 'unsupported_parameter', 'invalid_parameter'
]);
const TYPES = new Set(['rate_limit_error', 'authentication_error', 'permission_error',
  'invalid_request_error', 'server_error', 'not_found_error']);
export const MAX_ERROR_BYTES = 16 * 1024;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function parseRetryAfter(value) {
  if (typeof value !== 'string' || value.length > 64) return undefined;
  if (/^(0|[1-9][0-9]{0,7})$/.test(value)) {
    const seconds = Number(value);
    return seconds <= 31_536_000 ? { kind: 'seconds', seconds } : undefined;
  }
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/.test(value)) return undefined;
  const date = new Date(value);
  if (Number.isFinite(date.getTime()) && date.toUTCString() === value) return { kind: 'http-date', at: date.toISOString() };
  return undefined;
}

export function safeFailureDiagnostics(response) {
  const diagnostics = { bodyStatus: 'unavailable' };
  const retryAfter = parseRetryAfter(response.headers?.['retry-after']);
  if (retryAfter) diagnostics.retryAfter = retryAfter;
  if (['BODY_LIMIT', 'TIMEOUT', 'NETWORK_ERROR', 'ABORTED'].includes(response.bodyReadError)) {
    diagnostics.bodyStatus = response.bodyReadError; return diagnostics;
  }
  if (typeof response.body !== 'string' || !response.body.length) return diagnostics;
  if (Buffer.byteLength(response.body, 'utf8') > MAX_ERROR_BYTES) { diagnostics.bodyStatus = 'BODY_LIMIT'; return diagnostics; }
  let body;
  try { body = JSON.parse(response.body); } catch { diagnostics.bodyStatus = 'invalid_json'; return diagnostics; }
  diagnostics.bodyStatus = 'json';
  if (!record(body)) return diagnostics;
  const top = record(body.error) ? body.error : undefined;
  const nested = record(body.detail) && record(body.detail.error) ? body.detail.error : undefined;
  if (top && nested) { diagnostics.bodyStatus = 'ambiguous_envelope'; return diagnostics; }
  const error = top ?? nested;
  if (!error) return diagnostics;
  if (CODES.has(error.code)) diagnostics.errorCode = error.code;
  if (TYPES.has(error.type)) diagnostics.errorType = error.type;
  return diagnostics;
}

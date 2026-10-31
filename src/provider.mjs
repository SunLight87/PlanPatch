import { StageBudget, BudgetError } from './budget.mjs';
import { MAX_ERROR_BYTES, safeFailureDiagnostics } from './diagnostics.mjs';
import { performance } from 'node:perf_hooks';

// Transport safety/diagnostic semantics adapted from work/one-shot-probe-20261027.
// This module never reads keys, files, environment variables, or global fetch.
export const MAX_RESPONSE_BYTES = 64 * 1024;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const providerBudgets = new WeakMap();
const traceToken = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
const safeCodes = new Set(['INVALID_CONFIGURATION', 'INVALID_REQUEST', 'HTTP_FAILURE', 'TIMEOUT', 'NETWORK_ERROR',
  'ABORTED', 'BODY_LIMIT', 'INVALID_RESPONSE', 'MODEL_MISMATCH', 'INCOMPLETE_RESPONSE', 'STAGE_HALTED', 'BUDGET_SETTLEMENT_FAILURE',
  'EVENT_DEADLINE_PASSED', 'SOURCE_REVISION_MISMATCH', 'PRICE_EVIDENCE_HASH_MISMATCH', 'PRICE_EVIDENCE_STALE',
  'AUTHORIZATION_CHANGED', 'SEND_GATE_REJECTED']);

export class ProviderError extends Error {
  constructor(code, diagnostics = {}) {
    const safe = safeCodes.has(code) ? code : 'NETWORK_ERROR';
    super(safe); this.name = 'ProviderError'; this.code = safe;
    this.diagnostics = Object.freeze(diagnostics);
  }
}
function demand(ok, code) { if (!ok) throw new ProviderError(code); }
function prepareTraceContext(context) {
  if (context === undefined) return {};
  demand(record(context), 'INVALID_REQUEST');
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(context); } catch { throw new ProviderError('INVALID_REQUEST'); }
  demand(Reflect.ownKeys(descriptors).every(key => ['runId', 'agentId', 'attemptId'].includes(key)), 'INVALID_REQUEST');
  const result = {};
  for (const key of ['runId', 'agentId', 'attemptId']) {
    const descriptor = descriptors[key];
    demand(descriptor && 'value' in descriptor && traceToken(descriptor.value), 'INVALID_REQUEST');
    result[key] = descriptor.value;
  }
  return result;
}
function notifyObserver(observer, event) {
  if (!observer) return;
  try { Promise.resolve(observer(event)).catch(() => {}); } catch { /* Observers cannot reject execution. */ }
}
const traceTime = () => ({ at: new Date().toISOString(), monotonicMs: performance.now() });
function prepareMessages(messages, byteLimit) {
  demand(Array.isArray(messages) && messages.length > 0 && messages.length <= 32, 'INVALID_REQUEST');
  let bytes = 0;
  return messages.map(message => {
    demand(record(message) && ['system', 'user', 'assistant'].includes(message.role) && typeof message.content === 'string', 'INVALID_REQUEST');
    demand(Object.keys(message).every(key => ['role', 'content'].includes(key)), 'INVALID_REQUEST');
    bytes += Buffer.byteLength(message.content, 'utf8');
    demand(bytes <= byteLimit, 'INVALID_REQUEST');
    return { role: message.role, content: message.content };
  });
}
function safeStatus(response) {
  return Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599 ? response.status : undefined;
}
function readRetryAfter(response) {
  try { return response.headers?.get?.('retry-after'); } catch { return undefined; }
}
async function boundedBody(response, limit, operation) {
  demand(response.body && typeof response.body.getReader === 'function', 'INVALID_RESPONSE');
  const reader = response.body.getReader();
  operation.reader = reader;
  const chunks = []; let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      demand(chunk.value instanceof Uint8Array, 'INVALID_RESPONSE');
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new ProviderError('BODY_LIMIT');
      chunks.push(Buffer.from(chunk.value));
    }
    return Buffer.concat(chunks, bytes).toString('utf8');
  } finally {
    operation.reader = null;
    try { reader.releaseLock(); } catch { /* Never expose a stream exception. */ }
  }
}
function cancelBody(operation) {
  try { Promise.resolve(operation.reader?.cancel()).catch(() => {}); } catch { /* Best effort; deadline still settles locally. */ }
  try { Promise.resolve(operation.response?.body?.cancel()).catch(() => {}); } catch { /* Locked or already canceled. */ }
}
function decodeSuccess(body, model) {
  let parsed;
  try { parsed = JSON.parse(body); } catch { throw new ProviderError('INVALID_RESPONSE'); }
  demand(record(parsed) && parsed.model === model, 'MODEL_MISMATCH');
  demand(Array.isArray(parsed.choices) && parsed.choices.length === 1, 'INVALID_RESPONSE');
  const choice = parsed.choices[0], message = choice?.message;
  // Truncation, tool requests and reasoning-only responses cannot count as a completed generation.
  demand(choice?.finish_reason === 'stop', 'INCOMPLETE_RESPONSE');
  demand(record(message) && message.role === 'assistant' && typeof message.content === 'string' && message.content.trim().length > 0
    && !message.tool_calls && !message.function_call, 'INCOMPLETE_RESPONSE');
  const usage = {};
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    usage[key] = count(parsed.usage?.[key]) ? parsed.usage[key] : null;
  }
  return { content: message.content, usage: Object.values(usage).some(value => value !== null) ? usage : null };
}

export const isProviderForBudget = (provider, budget) => providerBudgets.get(provider) === budget && budget instanceof StageBudget;

export function createProvider({ endpoint, model, apiKey, fetchImpl, budget, timeoutMs = 120_000, onTrace, beforeSend,
  notAfter, now = Date.now } = {}) {
  demand(budget instanceof StageBudget && typeof fetchImpl === 'function'
    && typeof apiKey === 'string' && /^[A-Za-z0-9._~+/-]{16,512}={0,2}$/.test(apiKey)
    && Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 120_000
    && (onTrace === undefined || typeof onTrace === 'function')
    && (beforeSend === undefined || typeof beforeSend === 'function' && beforeSend.constructor?.name !== 'AsyncFunction')
    && typeof now === 'function' && (notAfter === undefined || Number.isSafeInteger(notAfter) && notAfter > 0), 'INVALID_CONFIGURATION');
  const policy = budget.requestPolicy;
  demand(endpoint === policy.endpoint && model === policy.model, 'INVALID_CONFIGURATION');
  const maxOutputTokens = policy.maxOutputTokens;

  const provider = Object.freeze({
    async generate({ reservationId, messages, signal, traceContext, onTrace: requestTrace } = {}) {
      demand(!signal || signal instanceof AbortSignal, 'INVALID_REQUEST');
      demand(!signal?.aborted, 'ABORTED');
      demand(requestTrace === undefined || typeof requestTrace === 'function', 'INVALID_REQUEST');
      const context = prepareTraceContext(traceContext);
      const body = JSON.stringify({ model, messages: prepareMessages(messages, policy.maxRequestBytes), max_tokens: maxOutputTokens, stream: false,
        ...(policy.reasoningEffort != null ? { reasoning_effort: policy.reasoningEffort } : {}),
        ...(policy.responseFormat != null ? { response_format: { type: policy.responseFormat } } : {}) });
      // Full serialized bytes, including roles, model and caps, are bounded by the price evidence.
      budget.assertRequestPolicy({ endpoint, model, maxOutputTokens, requestBytes: Buffer.byteLength(body, 'utf8') });
      const { policyRevision } = budget.begin(reservationId); // fsync precedes the sole fetch invocation.

      const controller = new AbortController(), operation = { response: null, reader: null };
      let status, retryAfter, timer, abortListener, cancellationCode;
      let failureRecorded = false, reservationSettled = false, settlementFailed = false;
      let postStarted = false, traceEnded = false, transportSettled = false, responseComplete = false, usage = null;
      let transportEndedAt, canceledAt;
      const trace = (type, outcome = null, timestamp = traceTime()) => {
        const event = Object.freeze({ type, ...timestamp, reservationId,
          ...context, policyRevision, status: type === 'POST_STARTED' ? 'STARTED' : outcome === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED',
          outcome, httpStatus: status ?? null, usage: usage ? Object.freeze({ ...usage }) : null,
          localSettled: type === 'POST_ENDED', transportSettled,
          remoteOutcome: responseComplete && !cancellationCode ? 'RESPONSE_OBSERVED' : 'UNKNOWN' });
        notifyObserver(onTrace, event);
        if (requestTrace !== onTrace) notifyObserver(requestTrace, event);
      };
      const endTrace = outcome => {
        if (!postStarted || traceEnded) return;
        // Delivery follows durable settlement, but timing describes the observed
        // transport boundary (or the explicit local cancellation), never fsync time.
        traceEnded = true; trace('POST_ENDED', outcome, canceledAt ?? transportEndedAt ?? traceTime());
      };
      const latchFailure = code => {
        if (failureRecorded || reservationSettled) return;
        failureRecorded = true;
        try { budget.fail(reservationId, code); }
        catch { settlementFailed = true; }
      };
      let cancel;
      const canceled = new Promise((_, reject) => { cancel = code => {
        if (cancellationCode) return;
        cancellationCode = code;
        canceledAt = traceTime();
        // Persist before abort callbacks can dispatch another generation.
        latchFailure(code);
        controller.abort(); cancelBody(operation); reject(new ProviderError(code));
      }; });
      timer = setTimeout(() => cancel('TIMEOUT'), timeoutMs);
      if (signal) { abortListener = () => cancel('ABORTED'); signal.addEventListener('abort', abortListener, { once: true }); }
      if (signal?.aborted) cancel('ABORTED');
      try {
        const request = (async () => {
          try {
            if (cancellationCode) throw new ProviderError(cancellationCode);
            let response;
            try {
              if (beforeSend) {
                try {
                  const result = beforeSend();
                  if (result && typeof result.then === 'function') {
                    // A thenable is never awaited; observe rejection before failing closed.
                    Promise.resolve(result).catch(() => {});
                    throw new ProviderError('SEND_GATE_REJECTED');
                  }
                } catch (error) {
                  const code = safeCodes.has(error?.code) ? error.code : 'SEND_GATE_REJECTED';
                  throw new ProviderError(code);
                }
              }
              // begin() has already durably consumed the attempt. Recheck after
              // fsync and the final synchronous gate, before the actual POST clock.
              try { budget.assertRequestPolicy({ endpoint, model, maxOutputTokens, requestBytes: Buffer.byteLength(body, 'utf8') }); }
              catch (error) { throw new ProviderError(safeCodes.has(error?.code) ? error.code : 'SEND_GATE_REJECTED'); }
              const options = { method: 'POST', redirect: 'manual', credentials: 'omit', cache: 'no-store',
                referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
                body, signal: controller.signal };
              let pending;
              // Last wall-clock admission occurs after all synchronous filesystem,
              // source, price and ledger work, immediately before the POST boundary.
              if (notAfter !== undefined && !(now() < notAfter)) throw new ProviderError('EVENT_DEADLINE_PASSED');
              const startedAt = traceTime();
              postStarted = true;
              try { pending = fetchImpl(endpoint, options); }
              catch (error) {
                transportEndedAt = traceTime();
                // Even a reentrant observer must see this synchronous failure latched.
                latchFailure(cancellationCode ?? 'NETWORK_ERROR'); throw error;
              }
              finally { trace('POST_STARTED', null, startedAt); }
              response = await pending;
            } catch (error) {
              transportEndedAt ??= traceTime();
              throw new ProviderError(cancellationCode ?? (error instanceof ProviderError ? error.code : 'NETWORK_ERROR'));
            }
            operation.response = response;
            if (cancellationCode) { cancelBody(operation); throw new ProviderError(cancellationCode); }
            status = safeStatus(response); retryAfter = readRetryAfter(response);
            demand(status !== undefined && response.redirected !== true, 'INVALID_RESPONSE');
            // HTTP failure is already known at headers, even when diagnostics stall.
            if (status !== 200) {
              latchFailure('HTTP_FAILURE');
              if (settlementFailed) throw new ProviderError('BUDGET_SETTLEMENT_FAILURE');
            }
            let responseBody;
            try { responseBody = await boundedBody(response, status === 200 ? MAX_RESPONSE_BYTES : MAX_ERROR_BYTES, operation); }
            catch (error) {
              transportEndedAt ??= traceTime();
              const code = cancellationCode ?? (error instanceof ProviderError ? error.code : 'NETWORK_ERROR');
              latchFailure(code);
              controller.abort(); cancelBody(operation);
              if (status !== 200) throw new ProviderError(code, { httpStatus: status,
                ...safeFailureDiagnostics({ headers: { 'retry-after': retryAfter }, bodyReadError: code }) });
              throw new ProviderError(code);
            }
            transportEndedAt = traceTime();
            responseComplete = true;
            if (status !== 200) throw new ProviderError('HTTP_FAILURE', { httpStatus: status,
              ...safeFailureDiagnostics({ headers: { 'retry-after': retryAfter }, body: responseBody }) });
            const decoded = decodeSuccess(responseBody, model);
            usage = decoded.usage;
            return decoded;
          } catch (error) {
            transportEndedAt ??= traceTime();
            latchFailure(cancellationCode ?? (error instanceof ProviderError ? error.code : 'NETWORK_ERROR'));
            throw error;
          } finally { transportEndedAt ??= traceTime(); transportSettled = true; }
        })();
        const result = await Promise.race([request, canceled]);
        const settled = budget.succeed(reservationId);
        reservationSettled = true;
        if (!settled.accepted) throw new ProviderError('STAGE_HALTED');
        endTrace('SUCCEEDED');
        return { ok: true, content: result.content, metadata: { httpStatus: 200, model, usage: result.usage } };
      } catch (error) {
        const code = cancellationCode ?? (error instanceof ProviderError ? error.code : 'NETWORK_ERROR');
        const diagnostics = status !== undefined && status !== 200 && !(error instanceof ProviderError && error.diagnostics.httpStatus)
          ? { httpStatus: status, ...safeFailureDiagnostics({ headers: { 'retry-after': retryAfter }, bodyReadError: code }) }
          : { ...(status !== undefined ? { httpStatus: status } : {}), ...(error instanceof ProviderError ? error.diagnostics : {}) };
        // Late success after another failure/stop is already recorded INCOMPLETE by succeed().
        latchFailure(code);
        controller.abort(); cancelBody(operation);
        if (settlementFailed || error instanceof BudgetError) {
          endTrace('BUDGET_SETTLEMENT_FAILURE'); throw new ProviderError('BUDGET_SETTLEMENT_FAILURE', diagnostics);
        }
        endTrace(code);
        throw new ProviderError(code, diagnostics);
      } finally {
        clearTimeout(timer);
        if (abortListener) signal.removeEventListener('abort', abortListener);
      }
    }
  });
  providerBudgets.set(provider, budget);
  return provider;
}

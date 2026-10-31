import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { performance } from 'node:perf_hooks';
import { StageBudget } from '../src/budget.mjs';
import { createProvider, isProviderForBudget, MAX_RESPONSE_BYTES } from '../src/provider.mjs';
import { MAX_ERROR_BYTES, parseRetryAfter, safeFailureDiagnostics } from '../src/diagnostics.mjs';

const NOW = Date.UTC(2026, 9, 30), SECRET = 'synthetic_secret_do_not_log_12345';
let networkAttempts = 0;
const forbid = () => { networkAttempts++; throw new Error('OFFLINE_NETWORK_FORBIDDEN'); };
globalThis.fetch = forbid;
for (const [object, methods] of [[http, ['request', 'get']], [https, ['request', 'get']],
  [net, ['connect', 'createConnection']], [tls, ['connect']]]) for (const method of methods) object[method] = forbid;

function fixture(t, fetchImpl, options = {}, policyOverrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'planpatch-provider-'));
  let clock = NOW;
  const auth = { granted: true, id: 'synthetic-provider-auth', stageId: 'synthetic-provider-stage', currency: 'CNY',
    maximumSpendCny: 1, maximumPosts: 8, allowedTaskIds: ['task-1'],
    ledgerDirectory: path.join(root, 'ledger'), identityFile: path.join(root, 'identity.json'),
    requestPolicy: { endpoint: 'https://offline.invalid/v1/chat/completions', model: 'synthetic-model', maxOutputTokens: 1024,
      maxRequestBytes: 4096, cashUpperBoundCny: '0.1', evidenceSha256: 'b'.repeat(64), verifiedAt: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW + 1_800_000).toISOString(), coversAllBillableTokens: true, ...policyOverrides } };
  const budget = StageBudget.open({ authorization: auth, now: () => clock });
  t.after(() => { try { budget.close(); } finally { fs.rmSync(root, { recursive: true, force: true }); } });
  const config = { endpoint: auth.requestPolicy.endpoint, model: auth.requestPolicy.model, apiKey: SECRET, fetchImpl, budget, ...options };
  return { root, auth, budget, config, provider: createProvider(config), setClock: value => { clock = value; } };
}
function hold(budget, count = 1) {
  return budget.reserveBatch({ taskId: 'task-1', runId: 'run-1', requests: Array.from({ length: count }, () => ({ purpose: 'initial' })) });
}
const messages = [{ role: 'user', content: 'Synthetic question only.' }];
function success(overrides = {}) {
  return JSON.stringify({ model: 'synthetic-model', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Synthetic answer.' } }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, private: SECRET }, ...overrides });
}
const response = (body = success(), status = 200, headers = {}) => new Response(body, { status, headers });
const isCode = expected => error => error.code === expected && error.message === expected;
function assertSafe(value) {
  const text = JSON.stringify(value);
  assert.equal(text.includes(SECRET), false); assert.equal(text.includes('private.invalid'), false);
  assert.equal(text.includes('Authorization'), false); assert.equal(text.includes('raw-provider-message'), false);
}

test('one configured POST is reserved before fetch and returns only completed content + safe metadata', async t => {
  const calls = []; let f;
  f = fixture(t, async (url, options) => {
    calls.push({ url, options }); assert.equal(f.budget.inspect().inFlight, 1); assert.equal(f.budget.inspect().reservedPosts, 1);
    const ledger = JSON.parse(fs.readFileSync(path.join(f.auth.ledgerDirectory, 'ledger.json'), 'utf8'));
    assert.equal(ledger.reservations[0].status, 'IN_FLIGHT');
    return response();
  });
  const [r] = hold(f.budget);
  const result = await f.provider.generate({ reservationId: r.id, messages });
  assert.deepEqual(result, { ok: true, content: 'Synthetic answer.', metadata: { httpStatus: 200, model: 'synthetic-model',
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } } });
  assert.equal(calls.length, 1); assert.equal(calls[0].url, f.auth.requestPolicy.endpoint);
  assert.equal(calls[0].options.method, 'POST'); assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[0].options.credentials, 'omit'); assert.equal(calls[0].options.headers.Authorization, `Bearer ${SECRET}`);
  assert.deepEqual(JSON.parse(calls[0].options.body), { model: 'synthetic-model', messages, max_tokens: 1024, stream: false });
  assert.equal(f.budget.inspect().reservations[0].status, 'SUCCEEDED');
  assertSafe(result); assertSafe(f.budget.inspect());
  assertSafe(fs.readFileSync(path.join(f.auth.ledgerDirectory, 'ledger.json'), 'utf8'));
  await assert.rejects(f.provider.generate({ reservationId: r.id, messages }), isCode('RESERVATION_NOT_HELD'));
  assert.equal(calls.length, 1);
});

test('absent or wholly unknown usage is explicitly null', async t => {
  for (const usage of [undefined, {}, { prompt_tokens: -1, completion_tokens: '2', total_tokens: null }]) {
    const f = fixture(t, async () => response(success({ usage }))); const [r] = hold(f.budget);
    const result = await f.provider.generate({ reservationId: r.id, messages });
    assert.deepEqual(result.metadata, { httpStatus: 200, model: 'synthetic-model', usage: null });
  }
});

test('only immutable explicit policy options determine wire fields; null deliberately omits them', async t => {
  for (const reasoningEffort of [null, 'low', 'medium', 'xhigh', 'none']) for (const responseFormat of [null, 'json_object']) {
    const calls = [];
    const f = fixture(t, async (_url, init) => { calls.push(JSON.parse(init.body)); return response(); },
      { reasoningEffort: 'untrusted', responseFormat: 'json_schema', reasoning_effort: 'untrusted',
        response_format: { type: 'json_schema' } }, { reasoningEffort, responseFormat });
    // Mutation of the caller's original policy cannot change the normalized budget snapshot.
    f.auth.requestPolicy.reasoningEffort = 'untrusted'; f.auth.requestPolicy.responseFormat = 'json_schema';
    assert.equal(Object.isFrozen(f.budget.requestPolicy), true);
    const [r] = hold(f.budget);
    await f.provider.generate({ reservationId: r.id, messages, reasoningEffort: 'untrusted', responseFormat: 'json_schema',
      reasoning_effort: 'untrusted', response_format: { type: 'json_schema' }, max_tokens: 999999,
      options: { reasoning_effort: 'untrusted', response_format: { type: 'json_schema' } } });
    assert.deepEqual(calls, [{ model: 'synthetic-model', messages, max_tokens: 1024, stream: false,
      ...(reasoningEffort === null ? {} : { reasoning_effort: reasoningEffort }),
      ...(responseFormat === null ? {} : { response_format: { type: 'json_object' } }) }]);
    assert.equal(f.budget.inspect().reservedPosts, 1); assert.equal(f.budget.inspect().reservedMicros, 100000);
  }
});

test('full serialized option bytes are admitted before begin or fetch, with exact boundary acceptance', async t => {
  const body = JSON.stringify({ model: 'synthetic-model', messages, max_tokens: 1024, stream: false,
    reasoning_effort: 'medium', response_format: { type: 'json_object' } });
  const size = Buffer.byteLength(body, 'utf8');
  assert.ok(Buffer.byteLength(JSON.stringify({ model: 'synthetic-model', messages, max_tokens: 1024, stream: false }), 'utf8') < size - 1);
  for (const maxRequestBytes of [size - 1, size]) {
    let calls = 0, begins = 0;
    const f = fixture(t, async () => { calls++; return response(); }, {},
      { reasoningEffort: 'medium', responseFormat: 'json_object', maxRequestBytes });
    const [r] = hold(f.budget), begin = f.budget.begin.bind(f.budget);
    f.budget.begin = id => { begins++; return begin(id); };
    if (maxRequestBytes < size) {
      const before = f.budget.inspect();
      await assert.rejects(f.provider.generate({ reservationId: r.id, messages }), isCode('REQUEST_TOO_LARGE'));
      assert.equal(begins, 0); assert.equal(calls, 0); assert.deepEqual(f.budget.inspect(), before);
    } else {
      await f.provider.generate({ reservationId: r.id, messages }); assert.equal(begins, 1); assert.equal(calls, 1);
    }
  }
});

test('partial usage marks missing fields null and preserves a known zero', async t => {
  const f = fixture(t, async () => response(success({ usage: { prompt_tokens: 0, completion_tokens: 'unknown' } })));
  const [r] = hold(f.budget); const result = await f.provider.generate({ reservationId: r.id, messages });
  assert.deepEqual(result.metadata.usage, { prompt_tokens: 0, completion_tokens: null, total_tokens: null });
});

test('missing explicit key/fetch or changed endpoint/model fails closed', t => {
  const { config } = fixture(t, async () => response());
  for (const change of [{ apiKey: undefined }, { fetchImpl: undefined }, { model: 'other' },
    { endpoint: 'https://private.invalid/v1/chat/completions' }, { timeoutMs: 120_001 }]) {
    assert.throws(() => createProvider({ ...config, ...change }), isCode('INVALID_CONFIGURATION'));
  }
});

test('untrusted messages cannot change model, add tools, or exceed the full UTF-8 payload cap', async t => {
  let calls = 0; const { budget, provider } = fixture(t, async () => { calls++; return response(); }); const [r] = hold(budget);
  for (const invalid of [[{ role: 'tool', content: 'override' }], [{ role: 'user', content: 'x', tools: [] }],
    [{ role: 'user', content: '中'.repeat(2000) }], [{ role: 'user', content: { url: 'https://private.invalid' } }]]) {
    await assert.rejects(provider.generate({ reservationId: r.id, messages: invalid }), error => ['INVALID_REQUEST', 'REQUEST_TOO_LARGE'].includes(error.code));
  }
  assert.equal(calls, 0); assert.equal(budget.inspect().reservedPosts, 1);
  assert.equal(budget.inspect().reservations[0].status, 'HELD');
});

test('price evidence is rechecked immediately before each generation', async t => {
  let calls = 0; const f = fixture(t, async () => { calls++; return response(); }); const [r] = hold(f.budget);
  f.setClock(NOW + 1_800_000);
  await assert.rejects(f.provider.generate({ reservationId: r.id, messages }), isCode('PRICE_EVIDENCE_STALE'));
  assert.equal(calls, 0);
});

test('HTTP failure stores status, safe Retry-After and allowed code only; no retry or fallback', async t => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; return response(JSON.stringify({ error: { code: 'model_concurrency_rate_limit_exceeded',
    type: 'rate_limit_error', message: `${SECRET} raw-provider-message https://private.invalid` }, raw: SECRET }), 429,
  { 'Retry-After': '7', Location: 'https://private.invalid', Authorization: SECRET }); });
  const [r] = hold(f.budget);
  await assert.rejects(f.provider.generate({ reservationId: r.id, messages }), error => {
    assert.equal(error.code, 'HTTP_FAILURE');
    assert.deepEqual(error.diagnostics, { httpStatus: 429, bodyStatus: 'json', retryAfter: { kind: 'seconds', seconds: 7 },
      errorCode: 'model_concurrency_rate_limit_exceeded', errorType: 'rate_limit_error' });
    assertSafe({ message: error.message, diagnostics: error.diagnostics, stack: error.stack }); return true;
  });
  assert.equal(calls, 1); assert.equal(f.budget.inspect().haltCode, 'HTTP_FAILURE');
  await assert.rejects(f.provider.generate({ reservationId: r.id, messages }), isCode('STAGE_HALTED')); assert.equal(calls, 1);
});

test('redirect status is not followed and a falsely followed response also fails closed', async t => {
  for (const followed of [false, true]) {
    let calls = 0;
    const f = fixture(t, async (_url, options) => {
      calls++; assert.equal(options.redirect, 'manual');
      return followed ? { status: 200, redirected: true, body: response().body }
        : response('raw-provider-message', 302, { location: 'https://private.invalid', 'retry-after': '2' });
    });
    const [r] = hold(f.budget);
    await assert.rejects(f.provider.generate({ reservationId: r.id, messages }), isCode(followed ? 'INVALID_RESPONSE' : 'HTTP_FAILURE'));
    assert.equal(calls, 1); assert.equal(f.budget.inspect().halted, true);
  }
});

test('network exception is discarded and permanently consumes the attempt', async t => {
  let calls = 0; const f = fixture(t, async () => { calls++; throw new Error(`${SECRET} https://private.invalid raw-provider-message`); });
  const [r] = hold(f.budget);
  await assert.rejects(f.provider.generate({ reservationId: r.id, messages }), error => {
    assert.equal(error.code, 'NETWORK_ERROR'); assertSafe({ ...error, stack: error.stack }); return true;
  });
  assert.equal(calls, 1); assert.equal(f.budget.inspect().reservedMicros, 100_000); assert.equal(f.budget.inspect().halted, true);
});

test('deadline settles even if injected fetch ignores abort and never completes', async t => {
  let calls = 0, abortSignal; const f = fixture(t, (_url, options) => {
    calls++; abortSignal = options.signal; return new Promise(() => {});
  }, { timeoutMs: 15 }); const [r] = hold(f.budget);
  await assert.rejects(f.provider.generate({ reservationId: r.id, messages }), isCode('TIMEOUT'));
  assert.equal(calls, 1); assert.equal(abortSignal.aborted, true); assert.equal(f.budget.inspect().haltCode, 'TIMEOUT');
});

test('stalled partial error body preserves status and Retry-After on timeout', async t => {
  const f = fixture(t, async () => ({ status: 429, headers: new Headers({ 'retry-after': '13' }),
    body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }) }), { timeoutMs: 15 });
  const [r] = hold(f.budget);
  await assert.rejects(f.provider.generate({ reservationId: r.id, messages }), error => {
    assert.equal(error.code, 'TIMEOUT'); assert.deepEqual(error.diagnostics,
      { httpStatus: 429, bodyStatus: 'TIMEOUT', retryAfter: { kind: 'seconds', seconds: 13 } }); return true;
  });
});

test('response and error bodies have independent streaming byte limits', async t => {
  for (const [status, limit] of [[200, MAX_RESPONSE_BYTES], [500, MAX_ERROR_BYTES]]) {
    const f = fixture(t, async () => response('中'.repeat(Math.ceil(limit / 3) + 1), status)); const [r] = hold(f.budget);
    await assert.rejects(f.provider.generate({ reservationId: r.id, messages }), error => {
      assert.equal(error.code, 'BODY_LIMIT');
      if (status === 500) assert.deepEqual(error.diagnostics, { httpStatus: 500, bodyStatus: 'BODY_LIMIT' });
      assertSafe(error.diagnostics); return true;
    });
    assert.equal(f.budget.inspect().haltCode, status === 200 ? 'BODY_LIMIT' : 'HTTP_FAILURE');
  }
});

test('partial error body interruption retains already observed HTTP evidence', async t => {
  let reads = 0;
  const f = fixture(t, async () => ({ status: 503, headers: new Headers({ 'retry-after': '3' }),
    body: new ReadableStream({ pull(controller) { if (reads++ === 0) controller.enqueue(new TextEncoder().encode('{')); else controller.error(new Error(SECRET)); } }) }));
  const [r] = hold(f.budget);
  await assert.rejects(f.provider.generate({ reservationId: r.id, messages }), error => {
    assert.equal(error.code, 'NETWORK_ERROR'); assert.deepEqual(error.diagnostics,
      { httpStatus: 503, bodyStatus: 'NETWORK_ERROR', retryAfter: { kind: 'seconds', seconds: 3 } }); return true;
  });
});

test('truncation, model mismatch, reasoning-only, tools, malformed JSON and multiple choices halt', async t => {
  const invalid = [
    ['{', 'INVALID_RESPONSE'],
    [success({ model: 'other' }), 'MODEL_MISMATCH'],
    [success({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'partial' } }] }), 'INCOMPLETE_RESPONSE'],
    [success({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', reasoning_content: SECRET } }] }), 'INCOMPLETE_RESPONSE'],
    [success({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: 'tools', tool_calls: [{}] } }] }), 'INCOMPLETE_RESPONSE'],
    [success({ choices: [] }), 'INVALID_RESPONSE'],
    [success({ choices: [{ finish_reason: 'stop' }, { finish_reason: 'stop' }] }), 'INVALID_RESPONSE']
  ];
  for (const [body, expected] of invalid) {
    const f = fixture(t, async () => response(body)); const [r] = hold(f.budget);
    await assert.rejects(f.provider.generate({ reservationId: r.id, messages }), error => {
      assert.equal(error.code, expected); assert.equal(error.diagnostics.httpStatus, 200); return true;
    });
    assert.equal(f.budget.inspect().haltCode, expected);
  }
});

test('caller abort consumes attempt and an eventual result cannot publish or reset halt', async t => {
  let resolveFetch; const f = fixture(t, () => new Promise(resolve => { resolveFetch = resolve; })); const [r] = hold(f.budget);
  const controller = new AbortController(); const result = f.provider.generate({ reservationId: r.id, messages, signal: controller.signal });
  controller.abort(); await assert.rejects(result, isCode('ABORTED'));
  resolveFetch(response()); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.budget.inspect().haltCode, 'ABORTED'); assert.equal(f.budget.inspect().reservations[0].status, 'FAILED');
});

test('one concurrent failure fences other in-flight content and all future sends', async t => {
  const resolvers = []; let calls = 0;
  const f = fixture(t, () => { calls++; return new Promise(resolve => resolvers.push(resolve)); }); const held = hold(f.budget, 3);
  const first = f.provider.generate({ reservationId: held[0].id, messages });
  const late = f.provider.generate({ reservationId: held[1].id, messages });
  resolvers[0](response('{}', 500)); await assert.rejects(first, isCode('HTTP_FAILURE'));
  resolvers[1](response()); await assert.rejects(late, isCode('STAGE_HALTED'));
  await assert.rejects(f.provider.generate({ reservationId: held[2].id, messages }), isCode('STAGE_HALTED'));
  assert.equal(calls, 2); assert.equal(f.budget.inspect().reservations[1].status, 'INCOMPLETE');
});

test('synchronous fetch failure latches before another call in the same event-loop job', async t => {
  let calls = 0;
  const f = fixture(t, () => { calls++; throw new Error(SECRET); }); const held = hold(f.budget, 2);
  const first = f.provider.generate({ reservationId: held[0].id, messages });
  const second = f.provider.generate({ reservationId: held[1].id, messages });
  await Promise.all([assert.rejects(first, isCode('NETWORK_ERROR')), assert.rejects(second, isCode('STAGE_HALTED'))]);
  assert.equal(calls, 1);
});

test('failure headers latch before a stalled diagnostic body completes', async t => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; return { status: 429, headers: new Headers({ 'retry-after': '2' }),
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([123])); } }) }; }, { timeoutMs: 30 });
  const held = hold(f.budget, 2); const first = f.provider.generate({ reservationId: held[0].id, messages });
  // Let fetch response headers resolve; its body remains pending.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.budget.inspect().haltCode, 'HTTP_FAILURE');
  const observed = assert.rejects(first, isCode('TIMEOUT'));
  await assert.rejects(f.provider.generate({ reservationId: held[1].id, messages }), isCode('STAGE_HALTED'));
  await observed; assert.equal(calls, 1);
});

test('fourth concurrent request cannot reach fetch; unused hold remains reserved', async t => {
  const resolvers = []; let calls = 0;
  const f = fixture(t, () => { calls++; return new Promise(resolve => resolvers.push(resolve)); }); const held = hold(f.budget, 4);
  const results = held.slice(0, 3).map(r => f.provider.generate({ reservationId: r.id, messages }));
  await assert.rejects(f.provider.generate({ reservationId: held[3].id, messages }), isCode('IN_FLIGHT_LIMIT'));
  assert.equal(calls, 3); resolvers.forEach(resolve => resolve(response())); await Promise.all(results);
  assert.equal(f.budget.inspect().reservedPosts, 4);
});

test('safe diagnostics reject secret strings, malformed/ambiguous envelopes and invalid Retry-After', () => {
  for (const header of [SECRET, '-1', '1.5', '1,2', '1\r\nX:secret', '999999999', 'Wed, 31 Feb 2027 12:00:00 GMT']) {
    assert.equal(parseRetryAfter(header), undefined);
  }
  assert.deepEqual(parseRetryAfter('0'), { kind: 'seconds', seconds: 0 });
  assert.deepEqual(parseRetryAfter('Fri, 30 Oct 2026 12:00:00 GMT'), { kind: 'http-date', at: '2026-10-30T12:00:00.000Z' });
  const body = JSON.stringify({ error: { code: SECRET, type: SECRET, message: SECRET } });
  assert.deepEqual(safeFailureDiagnostics({ body, headers: { 'retry-after': SECRET, location: 'https://private.invalid' } }), { bodyStatus: 'json' });
  assert.deepEqual(safeFailureDiagnostics({ body: '{' }), { bodyStatus: 'invalid_json' });
  assert.deepEqual(safeFailureDiagnostics({ body: JSON.stringify({ error: { code: 'invalid_api_key' }, detail: { error: { code: 'quota_exceeded' } } }) }),
    { bodyStatus: 'ambiguous_envelope' });
  assert.deepEqual(safeFailureDiagnostics({ body: JSON.stringify({ detail: { error: { code: 'quota_exceeded', type: 'rate_limit_error', message: SECRET } } }) }),
    { bodyStatus: 'json', errorCode: 'quota_exceeded', errorType: 'rate_limit_error' });
});

test('all provider fixtures performed zero real network attempts', () => { assert.equal(networkAttempts, 0); });

const traceContext = { runId: 'synthetic-run', agentId: 'A', attemptId: 'attempt-1' };

test('trace binds exact injected POST boundaries to immutable safe context and known usage', async t => {
  const traces = [], perCall = []; let f;
  f = fixture(t, (_url, options) => {
    // The actual injected call precedes any potentially slow observer callback.
    assert.equal(traces.length, 0); assert.equal(perCall.length, 0);
    assert.equal(f.budget.inspect().reservations[0].policyRevision, 0);
    assert.equal(options.method, 'POST'); return response();
  }, { onTrace: event => { traces.push(event); } });
  const [held] = hold(f.budget), callerContext = { ...traceContext };
  const result = f.provider.generate({ reservationId: held.id, messages: [{ role: 'user', content: SECRET }],
    traceContext: callerContext, onTrace: event => { perCall.push(event); } });
  callerContext.agentId = 'changed'; await result;
  assert.equal(isProviderForBudget(f.provider, f.budget), true);
  assert.equal(isProviderForBudget({ generate() {} }, f.budget), false);
  assert.equal(isProviderForBudget(f.provider, {}), false);
  assert.deepEqual(perCall, traces); assert.equal(traces.length, 2);
  const [start, end] = traces;
  assert.deepEqual(Object.keys(start).sort(), ['type', 'at', 'monotonicMs', 'reservationId', 'runId', 'agentId', 'attemptId',
    'policyRevision', 'status', 'outcome', 'httpStatus', 'usage', 'localSettled', 'transportSettled', 'remoteOutcome'].sort());
  assert.equal(start.reservationId, held.id); assert.equal(start.agentId, 'A'); assert.equal(end.agentId, 'A');
  assert.equal(start.status, 'STARTED'); assert.equal(start.outcome, null); assert.equal(start.httpStatus, null);
  assert.equal(start.usage, null); assert.equal(start.localSettled, false); assert.equal(start.transportSettled, false);
  assert.equal(start.remoteOutcome, 'UNKNOWN');
  assert.equal(end.type, 'POST_ENDED'); assert.equal(end.status, 'SUCCEEDED'); assert.equal(end.outcome, 'SUCCEEDED');
  assert.equal(end.httpStatus, 200); assert.equal(end.localSettled, true); assert.equal(end.transportSettled, true);
  assert.equal(end.remoteOutcome, 'RESPONSE_OBSERVED');
  assert.deepEqual(end.usage, { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
  for (const event of traces) {
    assert.equal(new Date(event.at).toISOString(), event.at); assert.equal(Number.isFinite(event.monotonicMs), true);
    assert.equal(Object.isFrozen(event), true); assertSafe(event);
    assert.equal(JSON.stringify(event).includes('offline.invalid'), false);
    assert.equal(JSON.stringify(event).includes('content'), false);
  }
  assert.equal(Object.isFrozen(end.usage), true); assert.ok(end.monotonicMs >= start.monotonicMs);
});

test('throwing and async-rejecting observers cannot change send, settlement or safe result', async t => {
  for (const onTrace of [() => { throw new Error(SECRET); }, async () => { throw new Error(SECRET); }]) {
    let calls = 0; const events = [];
    const f = fixture(t, () => { calls++; return response(success({ usage: undefined })); }, { onTrace });
    const [held] = hold(f.budget);
    const result = await f.provider.generate({ reservationId: held.id, messages, traceContext,
      onTrace: event => { events.push(event); assert.throws(() => { event.outcome = SECRET; }); } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(result.ok, true); assert.equal(calls, 1); assert.equal(events.length, 2);
    assert.equal(events[1].usage, null); assert.equal(f.budget.inspect().halted, false);
    assert.equal(f.budget.inspect().reservations[0].status, 'SUCCEEDED');
  }
});

test('timeout of an abort-ignoring fetch reports local settlement and remote unknown only', async t => {
  const events = []; let resolveFetch, signal;
  const f = fixture(t, (_url, options) => { signal = options.signal; return new Promise(resolve => { resolveFetch = resolve; }); },
    { timeoutMs: 15, onTrace: event => events.push(event) });
  const [held] = hold(f.budget);
  await assert.rejects(f.provider.generate({ reservationId: held.id, messages, traceContext }), isCode('TIMEOUT'));
  assert.equal(events.length, 2); const end = events[1];
  assert.equal(end.type, 'POST_ENDED'); assert.equal(end.outcome, 'TIMEOUT'); assert.equal(end.status, 'FAILED');
  assert.equal(end.localSettled, true); assert.equal(end.transportSettled, false);
  assert.equal(end.remoteOutcome, 'UNKNOWN'); assert.equal(end.httpStatus, null); assert.equal(end.usage, null);
  assert.equal(signal.aborted, true);
  resolveFetch(response()); await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.length, 2); assert.equal(events[1].remoteOutcome, 'UNKNOWN');
  assert.equal(f.budget.inspect().reservedPosts, 1); assert.equal(f.budget.inspect().reservations[0].status, 'FAILED');
});

test('caller abort and stalled HTTP error body never fabricate a remote completion', async t => {
  for (const httpFailure of [false, true]) {
    const events = [], controller = new AbortController();
    const f = fixture(t, () => httpFailure
      ? { status: 429, headers: new Headers({ 'retry-after': '5' }),
        body: new ReadableStream({ start(stream) { stream.enqueue(new Uint8Array([123])); } }) }
      : new Promise(() => {}), { onTrace: event => events.push(event), timeoutMs: 1000 });
    const [held] = hold(f.budget), pending = f.provider.generate({ reservationId: held.id, messages, signal: controller.signal, traceContext });
    await new Promise(resolve => setImmediate(resolve)); controller.abort(); await assert.rejects(pending, isCode('ABORTED'));
    assert.equal(events.length, 2); const end = events[1];
    assert.equal(end.outcome, 'ABORTED'); assert.equal(end.remoteOutcome, 'UNKNOWN'); assert.equal(end.usage, null);
    assert.equal(end.httpStatus, httpFailure ? 429 : null); assert.equal(end.localSettled, true);
    assert.equal(f.budget.inspect().haltCode, httpFailure ? 'HTTP_FAILURE' : 'ABORTED');
  }
});

test('safe failure trace distinguishes complete HTTP response from uncertain network rejection', async t => {
  for (const networkError of [false, true]) {
    const events = [];
    const f = fixture(t, () => { if (networkError) throw new Error(SECRET);
      return response(JSON.stringify({ error: { code: 'quota_exceeded', message: SECRET } }), 429);
    }, { onTrace: event => events.push(event) });
    const [held] = hold(f.budget);
    await assert.rejects(f.provider.generate({ reservationId: held.id, messages, traceContext }), isCode(networkError ? 'NETWORK_ERROR' : 'HTTP_FAILURE'));
    assert.equal(events.length, 2); const end = events[1];
    assert.equal(end.transportSettled, true); assert.equal(end.remoteOutcome, networkError ? 'UNKNOWN' : 'RESPONSE_OBSERVED');
    assert.equal(end.httpStatus, networkError ? null : 429); assert.equal(end.usage, null); assertSafe(events);
  }
});

test('invalid trace context or rejected budget admission emits no POST and does not spend the hold twice', async t => {
  const events = []; let calls = 0;
  const f = fixture(t, () => { calls++; return response(); }, { onTrace: event => events.push(event) });
  const [held] = hold(f.budget);
  for (const context of [{ ...traceContext, prompt: SECRET }, { ...traceContext, runId: 'https://private.invalid' },
    { ...traceContext, attemptId: '' }, { ...traceContext, attemptId: 'a'.repeat(129) }, { agentId: 'A' }]) {
    await assert.rejects(f.provider.generate({ reservationId: held.id, messages, traceContext: context }), isCode('INVALID_REQUEST'));
  }
  let accessorCalls = 0;
  const accessor = { ...traceContext, get runId() { accessorCalls++; return SECRET; } };
  const proxy = new Proxy(traceContext, { ownKeys() { throw new Error(SECRET); } });
  for (const context of [accessor, proxy]) {
    await assert.rejects(f.provider.generate({ reservationId: held.id, messages, traceContext: context }), isCode('INVALID_REQUEST'));
  }
  assert.equal(accessorCalls, 0);
  f.setClock(NOW + 1_800_000);
  await assert.rejects(f.provider.generate({ reservationId: held.id, messages, traceContext }), isCode('PRICE_EVIDENCE_STALE'));
  assert.equal(events.length, 0); assert.equal(calls, 0); assert.equal(f.budget.inspect().reservedPosts, 1);
  assert.equal(f.budget.inspect().reservations[0].status, 'HELD');
  f.budget.refreshPriceEvidence({ ...f.auth.requestPolicy, evidenceSha256: 'c'.repeat(64),
    verifiedAt: new Date(NOW + 1_800_000).toISOString(), expiresAt: new Date(NOW + 3_600_000).toISOString() });
  await f.provider.generate({ reservationId: held.id, messages, traceContext });
  assert.equal(calls, 1); assert.equal(events.length, 2);
  assert.equal(events[0].policyRevision, 1); assert.equal(events[1].policyRevision, 1);
  assert.equal(f.budget.inspect().reservations[0].policyRevision, 1); assert.equal(networkAttempts, 0);
});

test('transport timestamps exclude slow observer delivery and durable success settlement', async t => {
  const events = []; let fetchedAt, observerAt, bodyEndedAt, settleStartedAt, endDeliveredAt;
  const spin = milliseconds => { const until = performance.now() + milliseconds; while (performance.now() < until) {} };
  let read = false;
  const f = fixture(t, () => {
    fetchedAt = performance.now();
    return { status: 200, body: { getReader() { return {
      async read() {
        if (!read) { read = true; return { done: false, value: new TextEncoder().encode(success()) }; }
        bodyEndedAt = performance.now(); return { done: true };
      }, releaseLock() {}
    }; } } };
  }, { onTrace: event => {
    events.push(event);
    if (event.type === 'POST_STARTED') { observerAt = performance.now(); spin(25); }
    else endDeliveredAt = performance.now();
  } });
  const originalSucceed = f.budget.succeed.bind(f.budget);
  f.budget.succeed = id => { settleStartedAt = performance.now(); spin(30); return originalSucceed(id); };
  const [held] = hold(f.budget); await f.provider.generate({ reservationId: held.id, messages, traceContext });
  const [start, end] = events;
  assert.ok(start.monotonicMs <= fetchedAt); assert.ok(fetchedAt <= observerAt);
  assert.ok(end.monotonicMs >= bodyEndedAt); assert.ok(end.monotonicMs <= settleStartedAt);
  assert.ok(endDeliveredAt - end.monotonicMs >= 30);
  assert.equal(end.transportSettled, true); assert.equal(end.remoteOutcome, 'RESPONSE_OBSERVED');
});

test('synchronous fetch failure latches before a trace observer can reenter generation', async t => {
  let calls = 0, f, held, second;
  f = fixture(t, () => { calls++; throw new Error(SECRET); }, { onTrace: event => {
    if (event.type === 'POST_STARTED') second = f.provider.generate({ reservationId: held[1].id, messages });
  } });
  held = hold(f.budget, 2);
  await assert.rejects(f.provider.generate({ reservationId: held[0].id, messages, traceContext }), isCode('NETWORK_ERROR'));
  await assert.rejects(second, isCode('STAGE_HALTED'));
  assert.equal(calls, 1); assert.equal(f.budget.inspect().reservedPosts, 2);
});

for (const code of ['EVENT_DEADLINE_PASSED', 'SOURCE_REVISION_MISMATCH', 'PRICE_EVIDENCE_HASH_MISMATCH'])
  test(`synchronous beforeSend ${code} runs after durable begin, consumes failure and emits zero POST traces`, async t => {
    const events = []; let calls = 0, f;
    f = fixture(t, () => { calls++; return response(); }, { onTrace: event => events.push(event), beforeSend() {
      const ledger = JSON.parse(fs.readFileSync(path.join(f.auth.ledgerDirectory, 'ledger.json'), 'utf8'));
      assert.equal(ledger.reservations[0].status, 'IN_FLIGHT');
      throw Object.assign(new Error(SECRET), { code });
    } });
    const [held] = hold(f.budget);
    await assert.rejects(f.provider.generate({ reservationId: held.id, messages, traceContext }), isCode(code));
    assert.equal(calls, 0); assert.deepEqual(events, []);
    const state = f.budget.inspect(); assert.equal(state.halted, true); assert.equal(state.reservedPosts, 1); assert.equal(state.reservations[0].status, 'FAILED');
    assertSafe(state);
  });

test('beforeSend cannot be async or return a thenable, and rejected promises are observed', async t => {
  const f = fixture(t, () => { throw new Error('FETCH_FORBIDDEN'); });
  assert.throws(() => createProvider({ ...f.config, beforeSend: async () => {} }), isCode('INVALID_CONFIGURATION'));
  const provider = createProvider({ ...f.config, beforeSend: () => Promise.reject(new Error(SECRET)) });
  const [held] = hold(f.budget);
  await assert.rejects(provider.generate({ reservationId: held.id, messages, traceContext }), isCode('SEND_GATE_REJECTED'));
  assert.equal(f.budget.inspect().halted, true);
});

for (const action of ['stop', 'expire']) test(`budget ${action} inside beforeSend is checked again before native invocation`, async t => {
  let calls = 0, f; const events = [];
  f = fixture(t, () => { calls++; return response(); }, { onTrace: event => events.push(event), beforeSend() {
    if (action === 'stop') f.budget.stop(); else f.setClock(NOW + 1800000);
  } });
  const [held] = hold(f.budget);
  await assert.rejects(f.provider.generate({ reservationId: held.id, messages, traceContext }), isCode(action === 'stop' ? 'STAGE_HALTED' : 'PRICE_EVIDENCE_STALE'));
  assert.equal(calls, 0); assert.deepEqual(events, []); assert.equal(f.budget.inspect().halted, true);
});

for (const crossed of [true, false]) test(`final wall-clock gate ${crossed ? 'rejects crossing' : 'permits a send before'} deadline after synchronous gate and ledger reads`, async t => {
  let calls = 0, time = NOW; const events = [];
  const f = fixture(t, () => { calls++; return response(); }, { notAfter: NOW + 1000, now: () => time,
    beforeSend() { time = NOW + (crossed ? 1001 : 999); }, onTrace: event => events.push(event) });
  const [held] = hold(f.budget);
  if (crossed) {
    await assert.rejects(f.provider.generate({ reservationId: held.id, messages, traceContext }), isCode('EVENT_DEADLINE_PASSED'));
    assert.equal(calls, 0); assert.deepEqual(events, []); assert.equal(f.budget.inspect().halted, true);
    assert.equal(f.budget.inspect().reservations[0].status, 'FAILED');
  } else {
    await f.provider.generate({ reservationId: held.id, messages, traceContext });
    assert.equal(calls, 1); assert.equal(events[0].type, 'POST_STARTED'); assert.equal(f.budget.inspect().halted, false);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRun, verifyFrozenBundle } from '../src/coordinator.mjs';
import { parseRoleOutput } from '../src/transport-protocol.mjs';
import { createOfflineTransportFixture, roleResult, providerResponse } from './transport-fixtures.mjs';

globalThis.fetch = () => { throw new Error('REAL_FETCH_FORBIDDEN'); };
const sample = async (id = 'community-update') => JSON.parse(await readFile(new URL(`../samples/${id}.json`, import.meta.url), 'utf8'));
async function fixture(t, options = {}, input) {
  const root = await mkdtemp(join(tmpdir(), 'planpatch-transport-'));
  const f = createOfflineTransportFixture({ root, ...options });
  let run;
  t.after(async () => {
    if (run) await run.stop();
    f.close();
    assert.equal(dirname(resolve(root)).toLowerCase(), resolve(tmpdir()).toLowerCase());
    assert.ok(root.includes('planpatch-transport-'));
    await rm(root, { recursive: true, force: true });
  });
  run = await createRun({ input: input ?? await sample(), mode: 'OFFLINE_TRANSPORT', runDirectory: join(root, 'run'), transport: f.transport, onEvent: f.onEvent });
  return { ...f, run, root };
}

test('OFFLINE_TRANSPORT real provider/Mozaik bridge has fake POST overlap, causal C snapshot, prepaid mutation and rechecks', async t => {
  const f = await fixture(t, { holdReview: true, delays: { facts: 1, review: 1, owner: 1, recheck: 1 } });
  const result = await f.run.start();
  assert.equal(result.status, 'FINISHED');
  assert.deepEqual(result.counters, { generationPosts: 0, realGenerationPosts: 0, fakeGenerationPosts: 4, mockInvocations: 0, maxConcurrentAgents: 2 });
  assert.equal(result.mode, 'OFFLINE_TRANSPORT');
  assert.equal(result.acceptance, 'CONDITIONAL'); assert.equal(result.readyToSubmit, false);
  assert.equal(f.stats.fakePosts, 4); assert.equal(f.stats.maximumInFlight, 2);
  assert.equal(result.proposal.capacity, 24); assert.equal(result.proposal.waitlist, 12);
  const a = f.requests.find(item => item.task.kind === 'facts'), b = f.requests.find(item => item.task.kind === 'review');
  const c = f.requests.find(item => item.task.kind === 'owner');
  assert.ok(a.startedMs < b.endedMs && b.startedMs < a.endedMs);
  assert.ok(c.startedMs >= a.endedMs && c.endedMs < b.endedMs);
  assert.equal(c.task.snapshot.evidenceVersion, 1); assert.equal(c.task.snapshot.proposalVersion, 0);
  const event = type => result.events.find(item => item.type === type);
  const patch = event('PATCH_APPLIED');
  assert.equal(event('OWNER_SNAPSHOT_TRIGGERED').causedBy, event('EVIDENCE_PUBLISHED').id);
  assert.equal(patch.heldRecheckSlots.length, 1);
  assert.deepEqual(patch.recheckCoverage, [{ slotId: patch.heldRecheckSlots[0], requirements: patch.affectedRequirements }]);
  const bStart = result.events.find(item => item.type === 'POST_STARTED' && item.agentId === 'B');
  assert.ok(result.events.indexOf(patch) < result.events.findIndex(item => item.type === 'POST_ENDED' && item.reservationId === bStart.reservationId));
  const bEnd = result.events.find(item => item.type === 'POST_ENDED' && item.reservationId === bStart.reservationId);
  assert.ok(bStart.monotonicMs < event('EVIDENCE_PUBLISHED').monotonicMs);
  assert.ok(event('EVIDENCE_PUBLISHED').monotonicMs <= event('OWNER_SNAPSHOT_TRIGGERED').monotonicMs);
  assert.ok(event('OWNER_SNAPSHOT_TRIGGERED').monotonicMs < patch.monotonicMs);
  assert.ok(patch.monotonicMs < bEnd.monotonicMs);
  const starts = result.events.filter(item => item.type === 'POST_STARTED'), ends = result.events.filter(item => item.type === 'POST_ENDED');
  assert.equal(starts.length, 4); assert.equal(ends.length, 4);
  for (const start of starts) {
    assert.equal(start.mode, 'OFFLINE_TRANSPORT'); assert.equal(start.transportKind, 'INJECTED_FAKE'); assert.equal(start.runId, result.runId);
    assert.ok(ends.some(end => end.reservationId === start.reservationId && end.remoteOutcome === 'RESPONSE_OBSERVED'));
  }
  assert.equal(event('CHECK_REJECTED').code, 'STALE_CHECK');
  assert.ok(result.checks.every(item => item.proposalVersion === 1 && item.evidenceVersion === 1));
  assert.equal(f.budget.inspect().reservedPosts, 4); assert.equal(f.budget.inspect().halted, false);
  assert.ok(f.budget.inspect().reservations.every(item => item.status === 'SUCCEEDED'));
  const frozen = await f.run.freeze(); assert.equal(verifyFrozenBundle(frozen), true);
  assert.equal(frozen.mode, 'OFFLINE_TRANSPORT'); assert.equal(frozen.snapshot.counters.realGenerationPosts, 0);
  assert.ok(frozen.manifest.coreSources['provider-inference.mjs']); assert.ok(frozen.manifest.coreSources['transport-protocol.mjs']);
  const frozenText = JSON.stringify(f.run.snapshot());
  f.budget.stop(); // Stage lifecycle can advance, while this historical artifact stays immutable.
  assert.equal(JSON.stringify(f.run.snapshot()), frozenText);
  assert.equal(verifyFrozenBundle(frozen), true);
});

test('OFFLINE_TRANSPORT needs real provider bound to the same explicitly injected StageBudget and LIVE stays disabled', async t => {
  const f = await fixture(t); const input = await sample();
  await assert.rejects(createRun({ input, mode: 'OFFLINE_TRANSPORT', runDirectory: join(f.root, 'missing') }), { code: 'OFFLINE_TRANSPORT_INJECTION_REQUIRED' });
  await assert.rejects(createRun({ input, mode: 'OFFLINE_TRANSPORT', runDirectory: join(f.root, 'forged'),
    transport: { ...f.transport, provider: { generate() {} } } }), { code: 'OFFLINE_TRANSPORT_INJECTION_REQUIRED' });
  await assert.rejects(createRun({ input, mode: 'LIVE', runDirectory: join(f.root, 'live'), transport: f.transport }), { code: 'LIVE_DISABLED_NO_AUTHORIZATION' });
  assert.equal(f.stats.fakePosts, 0);
});

for (const [name, mutate] of [
  ['unknown top key', result => { result.tools = ['read_file']; }],
  ['unknown nested key', result => { result.evidence.facts[0].authority = true; }],
  ['forged source', result => { result.evidence.facts[0].sourceIds[0] = 'forged'; }],
  ['forged quote', result => { result.evidence.facts[0].quotes[0].text = 'a fabricated exact quote'; }],
  ['stale snapshot', result => { result.baseEvidenceVersion++; }],
  ['wrong role', result => { result.agentId = 'C'; }],
  ['omitted evidence', result => { result.evidence.facts.pop(); }],
]) test(`invalid A ${name} halts after HTTP success, without C, patch or repair`, async t => {
  const f = await fixture(t, { respond({ task, result }) { if (task.kind === 'facts') mutate(result); return providerResponse(result); } });
  const result = await f.run.start();
  assert.equal(result.status, 'FAILED'); assert.equal(result.error.code, 'INVALID_AGENT_OUTPUT');
  assert.equal(f.budget.inspect().haltCode, 'INVALID_AGENT_OUTPUT');
  assert.equal(f.budget.inspect().reservedPosts, 3); assert.equal(result.counters.fakeGenerationPosts, 2);
  assert.equal(result.proposalVersion, 0); assert.equal(result.evidenceVersion, 0);
  assert.ok(!result.events.some(item => ['PATCH_APPLIED', 'OWNER_SNAPSHOT_TRIGGERED'].includes(item.type)));
  assert.equal(f.budget.inspect().reservations[0].status, 'SUCCEEDED');
});

for (const [name, content] of [['nonJSON', 'not json'], ['truncatedJSON', '{"schemaVersion":1'],
  ['duplicate keys', '{"schemaVersion":0,"schemaVersion":1}']]) test(`${name} role response fails without schema repair`, async t => {
  const f = await fixture(t, { respond({ task, result }) { return providerResponse(task.kind === 'facts' ? content : result); } });
  const result = await f.run.start(); assert.equal(result.error.code, 'INVALID_AGENT_OUTPUT'); assert.equal(f.stats.fakePosts, 2);
});

for (const [name, options] of [['truncated provider generation', { finishReason: 'length' }],
  ['provider tool call', { message: { tool_calls: [{ id: 'forged-tool', type: 'function', function: { name: 'read_file', arguments: '{}' } }] } }]])
  test(`${name} halts before any role output is published`, async t => {
    const f = await fixture(t, { respond({ task, result }) { return providerResponse(result, task.kind === 'facts' ? options : {}); } });
    const result = await f.run.start(); assert.equal(result.status, 'FAILED'); assert.equal(result.error.code, 'INCOMPLETE_RESPONSE');
    assert.equal(result.evidenceVersion, 0); assert.equal(result.proposalVersion, 0); assert.equal(f.stats.fakePosts, 2);
    assert.equal(f.budget.inspect().halted, true);
  });

test('invalid owner batch cannot omit required domain changes or forge partial changes', async t => {
  const f = await fixture(t, { respond({ task, result }) { if (task.kind === 'owner') result.changes.pop(); return providerResponse(result); } });
  const result = await f.run.start(); assert.equal(result.status, 'FAILED'); assert.equal(result.error.code, 'INVALID_AGENT_OUTPUT');
  assert.equal(result.proposalVersion, 0); assert.equal(f.budget.inspect().reservedPosts, 3);
});

test('B 429 while A is pending immediately halts the shared stage before any publication or C', async t => {
  const f = await fixture(t, { holdFacts: true, delays: { facts: 1, review: 1 }, respond({ task, result }) {
    return task.kind === 'review' ? providerResponse('', { status: 429, headers: { 'retry-after': '600' } }) : providerResponse(result);
  } });
  const result = await f.run.start(); assert.equal(result.status, 'FAILED'); assert.equal(result.error.code, 'HTTP_FAILURE');
  assert.equal(f.budget.inspect().haltCode, 'HTTP_FAILURE'); assert.equal(result.proposalVersion, 0); assert.equal(result.evidenceVersion, 0);
  assert.equal(f.stats.fakePosts, 2); assert.ok(!result.events.some(item => item.type === 'EVIDENCE_PUBLISHED'));
});

test('B 429 during C fences C result and patch even though A evidence already published', async t => {
  const f = await fixture(t, { holdReview: true, holdOwner: true, releaseReviewOnOwner: true,
    delays: { facts: 1, review: 1, owner: 1 }, respond({ task, result }) {
    return task.kind === 'review' ? providerResponse('', { status: 429 }) : providerResponse(result);
  } });
  const result = await f.run.start(); assert.equal(result.status, 'FAILED'); assert.equal(result.evidenceVersion, 1);
  assert.equal(result.proposalVersion, 0); assert.equal(f.stats.fakePosts, 3);
  assert.ok(!result.events.some(item => item.type === 'PATCH_APPLIED'));
});

test('insufficient mandatory recheck allowance leaves both plan and attachment unchanged with no partial holds', async t => {
  const f = await fixture(t, { maximumPosts: 3 }); const original = (await sample()).original;
  const result = await f.run.start(); assert.equal(result.status, 'FAILED'); assert.equal(result.error.code, 'STAGE_POST_LIMIT');
  assert.equal(result.proposalVersion, 0); assert.deepEqual(result.proposal, original);
  assert.equal(f.budget.inspect().reservedPosts, 3); assert.equal(f.stats.fakePosts, 3); assert.equal(f.budget.inspect().halted, true);
});

test('stop durably latches budget before abort and ignores transport that completes after local cancellation', async t => {
  const f = await fixture(t, { delays: { facts: 70, review: 100 } });
  const started = f.run.start(); const stopped = f.run.stop();
  assert.equal(f.budget.inspect().haltCode, 'STAGE_STOPPED');
  await stopped; await started;
  const result = f.run.snapshot(); assert.equal(result.status, 'STOPPED'); assert.equal(result.proposalVersion, 0);
  assert.equal(result.counters.fakeGenerationPosts, 2); assert.equal(result.counters.realGenerationPosts, 0);
  assert.ok(!result.events.some(item => ['PATCH_APPLIED', 'EVIDENCE_PUBLISHED'].includes(item.type)));
  assert.ok(result.events.filter(item => item.type === 'POST_ENDED').every(item => item.remoteOutcome === 'UNKNOWN'));
  const before = JSON.stringify(result); await new Promise(resolve => setTimeout(resolve, 130));
  assert.equal(JSON.stringify(f.run.snapshot()), before);
});

test('stop during C aborts the shared provider signal before owner publication or any recheck send', async t => {
  let f, stopping;
  f = await fixture(t, { holdReview: true, delays: { facts: 1, review: 1, owner: 1 }, respond({ task, result }) {
    if (task.kind === 'owner') stopping = f.run.stop();
    return providerResponse(result);
  } });
  const result = await f.run.start(); await stopping;
  assert.equal(result.status, 'STOPPED'); assert.equal(result.evidenceVersion, 1); assert.equal(result.proposalVersion, 0);
  assert.equal(f.budget.inspect().haltCode, 'STAGE_STOPPED'); assert.equal(f.stats.fakePosts, 3);
  assert.ok(!result.events.some(item => ['PATCH_APPLIED', 'AFFECTED_RECHECK_STARTED'].includes(item.type)));
});

test('no-change, oracle isolation and strict key ordering work through serialized provider messages', async t => {
  const input = await sample('community-no-change'); input.expected = { marker: 'FORBIDDEN_TEST_ORACLE' };
  const f = await fixture(t, { respond({ result }) { return providerResponse(Object.fromEntries(Object.entries(result).reverse())); } }, input);
  const result = await f.run.start(); assert.equal(result.status, 'FINISHED'); assert.equal(result.proposalVersion, 0);
  assert.deepEqual(result.proposal, input.original); assert.equal(f.stats.fakePosts, 4);
  assert.ok(!JSON.stringify(f.requests).includes('FORBIDDEN_TEST_ORACLE'));
});

test('paraphrased annotations are accepted only with exact supported semantics, and replaced before publication', async t => {
  const rewrite = value => {
    if (value && typeof value === 'object') for (const key of Object.keys(value)) {
      if (['summary', 'reason'].includes(key)) value[key] = 'UNTRUSTED_FREE_FORM_ANNOTATION';
      else rewrite(value[key]);
    }
  };
  const f = await fixture(t, { holdReview: true, delays: { facts: 1, review: 1, owner: 1, recheck: 1 }, respond({ result }) {
    rewrite(result); return providerResponse(result);
  } });
  const result = await f.run.start(); assert.equal(result.status, 'FINISHED');
  assert.equal(result.proposal.capacity, 24); assert.ok(!JSON.stringify(result).includes('UNTRUSTED_FREE_FORM_ANNOTATION'));
});

test('renewed external price evidence admits the same stage without restoring any allowance', async t => {
  const f = await fixture(t, { holdReview: true, delays: { facts: 1, review: 1, owner: 1, recheck: 1 } });
  f.setClock(f.now + 1_800_000);
  assert.throws(() => f.budget.reserveBatch({ taskId: 'task-1', runId: 'stale', requests: [{ purpose: 'initial' }] }), { code: 'PRICE_EVIDENCE_STALE' });
  assert.equal(f.budget.inspect().reservedPosts, 0);
  f.budget.refreshPriceEvidence({ ...f.authorization.requestPolicy, evidenceSha256: 'd'.repeat(64),
    verifiedAt: new Date(f.now + 1_800_000).toISOString(), expiresAt: new Date(f.now + 3_600_000).toISOString() });
  const result = await f.run.start(); assert.equal(result.status, 'FINISHED');
  assert.equal(result.transportBudget.reservedPosts, 4);
  assert.ok(result.events.filter(item => item.type === 'POST_STARTED').every(item => item.policyRevision === 1));
  assert.ok(result.transportBudget.reservations.every(item => item.policyRevision === 1));
});

test('same stage restart keeps prior run/task counts and halt without restoring allowance', async t => {
  const f = await fixture(t, { maximumPosts: 12 }); await f.run.start();
  const before = f.budget.inspect(); f.budget.close(); const reopened = f.openBudget();
  t.after(() => reopened.close()); assert.equal(reopened.inspect().reservedPosts, before.reservedPosts);
  const providerBoundToOldLedger = f.provider;
  await assert.rejects(createRun({ input: await sample(), mode: 'OFFLINE_TRANSPORT', runDirectory: join(f.root, 'second'),
    transport: { ...f.transport, budget: reopened, provider: providerBoundToOldLedger } }), { code: 'OFFLINE_TRANSPORT_INJECTION_REQUIRED' });
  assert.throws(() => reopened.reserveBatch({ taskId: 'task-1', runId: 'another-run', requests: Array.from({ length: 5 }, () => ({ purpose: 'initial' })) }), { code: 'TASK_POST_LIMIT' });
  assert.equal(reopened.inspect().reservedPosts, 4); reopened.stop(); reopened.close();
  const halted = f.openBudget(); assert.equal(halted.inspect().halted, true); assert.equal(halted.inspect().reservedPosts, 4); halted.close();
});

test('complete valid JSON with duplicate version key cannot hide overridden fields', () => {
  const task = { schemaVersion: 1, agentId: 'B', kind: 'review', requirements: ['all'],
    snapshot: { proposalVersion: 0, evidenceVersion: 0, sources: [], proposal: { registered: 0, capacity: 0, waitlist: 0, weatherBackup: '待确认' }, attachment: {} } };
  const valid = JSON.stringify(roleResult(task));
  assert.throws(() => parseRoleOutput(valid.replace('"baseProposalVersion":0', '"baseProposalVersion":1,"baseProposalVersion":0'), task), { code: 'INVALID_AGENT_OUTPUT' });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { StageBudget } from '../src/budget.mjs';

const NOW = Date.UTC(2026, 9, 30, 0, 0);
// Deliberately no credential reads, real fetch, sockets, production ledger or production auth.
globalThis.fetch = () => { throw new Error('OFFLINE_NETWORK_FORBIDDEN'); };
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'planpatch-budget-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const auth = { granted: true, id: 'synthetic-auth', stageId: 'synthetic-stage', currency: 'CNY',
    maximumSpendCny: '10', maximumPosts: 16, allowedTaskIds: ['task-1', 'task-2'],
    ledgerDirectory: path.join(root, 'ledger'), identityFile: path.join(root, 'stage-identity.json'),
    requestPolicy: { endpoint: 'https://offline.invalid/v1/chat/completions', model: 'synthetic-model',
      maxOutputTokens: 1024, maxRequestBytes: 4096, cashUpperBoundCny: '0.1', evidenceSha256: 'a'.repeat(64),
      verifiedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 1_800_000).toISOString(), coversAllBillableTokens: true }, ...overrides };
  let clock = NOW;
  const open = authorization => StageBudget.open({ authorization: authorization ?? auth, now: () => clock });
  return { root, auth, open, setClock: value => { clock = value; } };
}
const reserve = (b, count = 1, taskId = 'task-1', runId = 'run-1') => b.reserveBatch({ taskId, runId,
  requests: Array.from({ length: count }, () => ({ purpose: 'initial' })) });
const succeed = (b, r) => { b.begin(r.id); assert.equal(b.succeed(r.id).accepted, true); };
const code = expected => error => error.code === expected && error.message === expected;

test('authorization and current all-token price evidence are mandatory', t => {
  assert.throws(() => StageBudget.open(), code('AUTHORIZATION_REQUIRED'));
  const { auth, open } = fixture(t);
  assert.throws(() => open({ ...auth, granted: false }), code('AUTHORIZATION_REQUIRED'));
  assert.throws(() => open({ ...auth, maximumSpendCny: undefined }), code('INVALID_CNY_AMOUNT'));
  assert.throws(() => open({ ...auth, requestPolicy: { ...auth.requestPolicy, coversAllBillableTokens: false } }), code('PRICE_EVIDENCE_REQUIRED'));
  assert.throws(() => StageBudget.open({ authorization: auth, now: () => NOW + 1_800_000 }), code('PRICE_EVIDENCE_STALE'));
  assert.throws(() => open({ ...auth, identityFile: path.join(auth.ledgerDirectory, 'identity.json') }), code('IDENTITY_MUST_BE_OUTSIDE_LEDGER'));
  assert.equal(fs.existsSync(auth.ledgerDirectory), false);
});

test('mutation and all mandatory rechecks are one atomic, prepaid reservation', t => {
  const { open } = fixture(t, { maximumPosts: 3, maximumSpendCny: '0.3' }); const b = open();
  const held = b.reserveMutation({ taskId: 'task-1', runId: 'run-1', mandatoryRechecks: 2 });
  assert.deepEqual(held.map(r => r.purpose), ['revision', 'mandatory_recheck', 'mandatory_recheck']);
  assert.equal(b.inspect().reservedMicros, 300_000);
  assert.throws(() => reserve(b), code('STAGE_POST_LIMIT'));
  assert.equal(b.inspect().reservedPosts, 3);
  held.forEach(r => succeed(b, r)); b.close();
});

test('insufficient mutation cash or post allowance creates no partial holds', t => {
  for (const limitation of [{ maximumPosts: 2 }, { maximumSpendCny: '0.2' }]) {
    const { open } = fixture(t, limitation); const b = open();
    assert.throws(() => b.reserveMutation({ taskId: 'task-1', runId: 'r', mandatoryRechecks: 2 }),
      code(limitation.maximumPosts ? 'STAGE_POST_LIMIT' : 'STAGE_CNY_LIMIT'));
    assert.equal(b.inspect().reservedPosts, 0); b.close();
  }
});

test('task/run changes and restart do not restore aggregate CNY or posts', t => {
  const { open } = fixture(t, { maximumPosts: 3, maximumSpendCny: '0.3' }); let b = open();
  reserve(b, 2).forEach(r => succeed(b, r)); b.close(); b = open();
  reserve(b, 1, 'task-2', 'different-run').forEach(r => succeed(b, r));
  assert.equal(b.inspect().remainingPosts, 0); assert.equal(b.inspect().remainingMicros, 0);
  assert.throws(() => reserve(b, 1, 'task-1', 'third-run'), code('STAGE_POST_LIMIT')); b.close();
});

test('per logical task remains eight across run ids and reopening', t => {
  const { open } = fixture(t); let b = open(); reserve(b, 8).forEach(r => succeed(b, r)); b.close(); b = open();
  assert.throws(() => reserve(b, 1, 'task-1', 'new-run'), code('TASK_POST_LIMIT'));
  assert.throws(() => reserve(b, 1, 'renamed-task', 'new-run'), code('TASK_NOT_AUTHORIZED'));
  succeed(b, reserve(b, 1, 'task-2')[0]); b.close();
});

test('concurrent admission allows at most three sends and each hold is one-shot', t => {
  const { open } = fixture(t); const b = open(); const held = reserve(b, 4);
  held.slice(0, 3).forEach(r => b.begin(r.id));
  assert.equal(b.inspect().inFlight, 3);
  assert.throws(() => b.begin(held[3].id), code('IN_FLIGHT_LIMIT'));
  assert.throws(() => b.begin(held[0].id), code('RESERVATION_NOT_HELD'));
  b.succeed(held[0].id); b.begin(held[3].id);
  held.slice(1).forEach(r => b.succeed(r.id));
  assert.throws(() => b.begin(held[0].id), code('RESERVATION_NOT_HELD')); b.close();
});

test('any failure irreversibly halts the stage, consumes all held cash, and fences late success', t => {
  const { open } = fixture(t); let b = open(); const held = reserve(b, 3);
  b.begin(held[0].id); b.begin(held[1].id); b.fail(held[0].id, 'TIMEOUT');
  assert.deepEqual(b.succeed(held[1].id), { accepted: false, code: 'STAGE_HALTED' });
  assert.throws(() => b.begin(held[2].id), code('STAGE_HALTED'));
  assert.throws(() => reserve(b, 1, 'task-2'), code('STAGE_HALTED'));
  assert.equal(b.inspect().reservedMicros, 300_000); b.close(); b = open();
  assert.equal(b.inspect().haltCode, 'TIMEOUT'); assert.equal(b.inspect().reservedPosts, 3);
  assert.throws(() => reserve(b), code('STAGE_HALTED')); b.close();
});

test('unused holds conservatively consume and latch halt on close', t => {
  const { open } = fixture(t); let b = open(); reserve(b, 2); b.close(); b = open();
  assert.equal(b.inspect().haltCode, 'UNSETTLED_RESERVATIONS');
  assert.equal(b.inspect().reservedPosts, 2); assert.ok(b.inspect().reservations.every(r => r.status === 'INCOMPLETE'));
  assert.throws(() => reserve(b), code('STAGE_HALTED')); b.close();
});

test('stop is durable and blocks publication of in-flight results', t => {
  const { open } = fixture(t); let b = open(); const [r] = reserve(b); b.begin(r.id); b.stop();
  assert.equal(b.succeed(r.id).accepted, false); b.close(); b = open();
  assert.equal(b.inspect().haltCode, 'STAGE_STOPPED'); assert.throws(() => reserve(b), code('STAGE_HALTED')); b.close();
});

test('same-process and cross-process owners cannot open a second stage writer', t => {
  const { auth, open } = fixture(t); const b = open();
  assert.throws(() => open(), code('STAGE_LOCKED'));
  const source = `import {StageBudget} from ${JSON.stringify(new URL('../src/budget.mjs', import.meta.url).href)};
    try { StageBudget.open({authorization:JSON.parse(process.argv[1]),now:()=>${NOW}}); process.exit(9); }
    catch(e) { process.stdout.write(e.code); }`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source, JSON.stringify(auth)], { encoding: 'utf8' });
  assert.equal(child.status, 0); assert.equal(child.stdout, 'STAGE_LOCKED'); b.close();
});

test('hard process exit leaves a lock: no timeout, pid check, or restart clears it', t => {
  const { auth, open } = fixture(t);
  const source = `import {StageBudget} from ${JSON.stringify(new URL('../src/budget.mjs', import.meta.url).href)};
    const b=StageBudget.open({authorization:JSON.parse(process.argv[1]),now:()=>${NOW}});
    b.reserveBatch({taskId:'task-1',runId:'crashed',requests:[{purpose:'initial'}]}); process.exit(0);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source, JSON.stringify(auth)], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const lock = path.join(auth.ledgerDirectory, 'stage.lock');
  fs.utimesSync(lock, new Date(0), new Date(0));
  assert.throws(() => open(), code('STAGE_LOCKED')); assert.equal(fs.existsSync(lock), true);
  // Simulate manual forensic lock removal, never a production recovery API.
  fs.unlinkSync(lock); const b = open();
  assert.equal(b.inspect().haltCode, 'UNSETTLED_RESERVATIONS'); assert.equal(b.inspect().reservedPosts, 1); b.close();
});

test('deleting a ledger cannot reset its external immutable identity', t => {
  const { auth, open } = fixture(t); const b = open(); b.close();
  fs.unlinkSync(path.join(auth.ledgerDirectory, 'ledger.json'));
  assert.throws(() => open(), code('LEDGER_IDENTITY_MISSING'));
});

test('changed authorization or ledger directory cannot reuse an existing stage identity', t => {
  for (const change of ['id', 'cash', 'path']) {
    const { auth, root, open } = fixture(t); const b = open(); b.close();
    const changed = change === 'id' ? { ...auth, id: 'replacement' }
      : change === 'cash' ? { ...auth, maximumSpendCny: '100' }
      : { ...auth, ledgerDirectory: path.join(root, 'new-ledger') };
    assert.throws(() => open(changed), code(change === 'path' ? 'LEDGER_MISSING' : 'AUTHORIZATION_IDENTITY_MISMATCH'));
  }
});

test('external ledger modification or lock tampering blocks all further operations', t => {
  for (const target of ['ledger.json', 'stage.lock']) {
    const { auth, open } = fixture(t); const b = open();
    fs.appendFileSync(path.join(auth.ledgerDirectory, target), '\n');
    assert.throws(() => reserve(b), code('LEDGER_EXTERNALLY_MODIFIED'));
    assert.throws(() => b.close(), code('LEDGER_IO_OR_INTEGRITY_FAILURE'));
    assert.equal(fs.existsSync(path.join(auth.ledgerDirectory, 'stage.lock')), true);
  }
});

test('swapping an older same-authorization ledger snapshot cannot reset stage spend', t => {
  const { auth, open } = fixture(t); const b = open();
  const ledger = path.join(auth.ledgerDirectory, 'ledger.json'), original = fs.readFileSync(ledger);
  succeed(b, reserve(b)[0]); b.close();
  fs.writeFileSync(ledger, original);
  assert.throws(() => open(), code('LEDGER_CHECKPOINT_MISMATCH'));
  assert.equal(fs.existsSync(path.join(auth.ledgerDirectory, 'stage.lock')), true);
});

test('a missing or partially committed external checkpoint never recreates allowance', t => {
  for (const missing of [true, false]) {
    const { auth, open } = fixture(t); const b = open(); b.close();
    const head = `${auth.identityFile}.head.json`;
    if (missing) fs.unlinkSync(head);
    else { const parsed = JSON.parse(fs.readFileSync(head, 'utf8')); parsed.revision++; fs.writeFileSync(head, JSON.stringify(parsed)); }
    assert.throws(() => open(), code(missing ? 'LEDGER_CHECKPOINT_MISSING' : 'LEDGER_CHECKPOINT_MISMATCH'));
  }
});

test('a failed ledger commit preserves its lock and high-water checkpoint', t => {
  const { auth, open } = fixture(t); const b = open();
  const rename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (target === path.join(auth.ledgerDirectory, 'ledger.json')) throw new Error('synthetic IO failure');
    return rename(source, target);
  };
  try { assert.throws(() => reserve(b), code('LEDGER_IO_OR_INTEGRITY_FAILURE')); }
  finally { fs.renameSync = rename; }
  assert.throws(() => b.close(), code('LEDGER_IO_OR_INTEGRITY_FAILURE'));
  const lock = path.join(auth.ledgerDirectory, 'stage.lock'); assert.equal(fs.existsSync(lock), true);
  fs.unlinkSync(lock); // Test-only forensic intervention cannot turn this into a reset.
  assert.throws(() => open(), code('LEDGER_CHECKPOINT_MISMATCH'));
});

test('malformed durable ledger fails closed without replacement', t => {
  const { auth, open } = fixture(t); const b = open(); b.close();
  const ledger = path.join(auth.ledgerDirectory, 'ledger.json'); fs.writeFileSync(ledger, '{');
  assert.throws(() => open(), code('LEDGER_IO_OR_INTEGRITY_FAILURE'));
  assert.equal(fs.readFileSync(ledger, 'utf8'), '{');
});

test('decimal micro-CNY accounting has no float refill and zero-price still consumes posts', t => {
  const { auth, open } = fixture(t, { maximumSpendCny: '0.000003', maximumPosts: 3 });
  const b = open({ ...auth, requestPolicy: { ...auth.requestPolicy, cashUpperBoundCny: '0.000001' } });
  reserve(b, 3).forEach(r => succeed(b, r)); assert.equal(b.inspect().remainingMicros, 0); b.close();
  const zero = fixture(t, { maximumSpendCny: 0, maximumPosts: 1 });
  const free = zero.open({ ...zero.auth, requestPolicy: { ...zero.auth.requestPolicy, cashUpperBoundCny: 0 } });
  succeed(free, reserve(free)[0]); assert.throws(() => reserve(free), code('STAGE_POST_LIMIT')); free.close();
});

const renewedPolicy = (auth, revision = 1) => ({ ...auth.requestPolicy,
  evidenceSha256: String(revision + 1).repeat(64), verifiedAt: new Date(NOW + revision * 1_800_000).toISOString(),
  expiresAt: new Date(NOW + (revision + 1) * 1_800_000).toISOString() });

test('legacy normalized policy and durable authorization hash retain their original shape', t => {
  const f = fixture(t), b = f.open(), p = f.auth.requestPolicy;
  const expectedPolicy = { endpoint: p.endpoint, model: p.model, maxOutputTokens: p.maxOutputTokens,
    maxRequestBytes: p.maxRequestBytes, cashUpperBoundMicros: 100000, evidenceSha256: p.evidenceSha256,
    verifiedAt: p.verifiedAt, expiresAt: p.expiresAt, coversAllBillableTokens: true };
  assert.deepEqual(b.requestPolicy, expectedPolicy);
  const normalized = { id: f.auth.id, stageId: f.auth.stageId, currency: 'CNY', maximumMicros: 10000000,
    maximumPosts: 16, allowedTaskIds: ['task-1', 'task-2'], ledgerDirectory: f.auth.ledgerDirectory,
    identityFile: f.auth.identityFile, requestPolicy: expectedPolicy };
  const hash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  assert.equal(JSON.parse(fs.readFileSync(f.auth.identityFile, 'utf8')).authorizationHash, hash);
  succeed(b, reserve(b)[0]); b.close();
  const reopened = f.open(); assert.deepEqual(reopened.requestPolicy, expectedPolicy);
  assert.equal(reopened.inspect().reservedPosts, 1); reopened.close();
});

test('request options require a complete pair and reject unknown values and schema objects before enrollment', t => {
  const f = fixture(t);
  for (const options of [{ reasoningEffort: null }, { responseFormat: null },
    ...['high', 'LOW', false, {}, undefined].map(reasoningEffort => ({ reasoningEffort, responseFormat: null })),
    ...['json_schema', 'text', { type: 'json_object' }, { type: 'json_schema', json_schema: {} }, undefined]
      .map(responseFormat => ({ reasoningEffort: null, responseFormat }))]) {
    assert.throws(() => f.open({ ...f.auth, requestPolicy: { ...f.auth.requestPolicy, ...options } }), code('INVALID_REQUEST_OPTIONS'));
    assert.equal(fs.existsSync(f.auth.ledgerDirectory), false); assert.equal(fs.existsSync(f.auth.identityFile), false);
  }
});

test('request option presence and values are immutable across renewal and reopening without restoring allowance', t => {
  for (const initial of [{}, { reasoningEffort: null, responseFormat: null },
    { reasoningEffort: 'medium', responseFormat: 'json_object' }]) {
    const f = fixture(t); Object.assign(f.auth.requestPolicy, initial);
    const b = f.open(); succeed(b, reserve(b)[0]);
    const ledger = path.join(f.auth.ledgerDirectory, 'ledger.json'), bytes = fs.readFileSync(ledger, 'utf8');
    f.setClock(NOW + 1800000);
    for (const next of [{}, { reasoningEffort: null, responseFormat: null },
      { reasoningEffort: 'low', responseFormat: null }, { reasoningEffort: 'medium', responseFormat: 'json_object' }]) {
      if (JSON.stringify(initial) === JSON.stringify(next)) continue;
      const policy = renewedPolicy(f.auth); delete policy.reasoningEffort; delete policy.responseFormat;
      Object.assign(policy, next);
      assert.throws(() => b.refreshPriceEvidence(policy), code('REQUEST_POLICY_MISMATCH'));
      assert.equal(fs.readFileSync(ledger, 'utf8'), bytes);
      assert.equal(b.inspect().reservedPosts, 1); assert.equal(b.inspect().reservedMicros, 100000);
    }
    b.refreshPriceEvidence(renewedPolicy(f.auth)); b.close();
    const original = f.open(); assert.equal(original.policyRevision, 1); assert.equal(original.inspect().reservedPosts, 1); original.close();
    const changedPolicy = { ...f.auth.requestPolicy, reasoningEffort: 'xhigh', responseFormat: null };
    const before = fs.readFileSync(ledger, 'utf8'), identity = fs.readFileSync(f.auth.identityFile, 'utf8');
    assert.throws(() => f.open({ ...f.auth, requestPolicy: changedPolicy }), code('AUTHORIZATION_IDENTITY_MISMATCH'));
    assert.equal(fs.readFileSync(ledger, 'utf8'), before); assert.equal(fs.readFileSync(f.auth.identityFile, 'utf8'), identity);
  }
});

test('durable policy history rejects changed request options even with a matching checkpoint', t => {
  for (const change of [{ reasoningEffort: 'low' }, { responseFormat: null }, { removePair: true }]) {
    const f = fixture(t); Object.assign(f.auth.requestPolicy, { reasoningEffort: 'medium', responseFormat: 'json_object' });
    const b = f.open(); succeed(b, reserve(b)[0]); f.setClock(NOW + 1800000);
    b.refreshPriceEvidence(renewedPolicy(f.auth)); b.close();
    const filename = path.join(f.auth.ledgerDirectory, 'ledger.json'), state = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const p = state.policyHistory[1].policy;
    if (change.removePair) { delete p.reasoningEffort; delete p.responseFormat; } else Object.assign(p, change);
    const bytes = JSON.stringify(state, null, 2) + '\n'; fs.writeFileSync(filename, bytes);
    const head = JSON.parse(fs.readFileSync(`${f.auth.identityFile}.head.json`, 'utf8'));
    head.ledgerHash = createHash('sha256').update(bytes).digest('hex'); fs.writeFileSync(`${f.auth.identityFile}.head.json`, JSON.stringify(head));
    assert.throws(f.open, code('LEDGER_INVALID'));
    assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).reservations.length, 1);
  }
});

test('renewal preserves identity, previous holds and spend and records actual send policy revision', t => {
  const f = fixture(t, { maximumPosts: 3, maximumSpendCny: '0.3' }); let b = f.open();
  const identity = fs.readFileSync(f.auth.identityFile, 'utf8');
  const held = reserve(b, 2); succeed(b, held[0]);
  f.setClock(NOW + 1_800_000);
  assert.throws(() => reserve(b), code('PRICE_EVIDENCE_STALE'));
  assert.throws(() => b.begin(held[1].id), code('PRICE_EVIDENCE_STALE'));
  const before = b.inspect();
  assert.deepEqual(b.refreshPriceEvidence(renewedPolicy(f.auth)), { policyRevision: 1 });
  assert.deepEqual(b.inspect().reservations, before.reservations);
  assert.equal(b.inspect().reservedMicros, before.reservedMicros);
  assert.deepEqual(b.begin(held[1].id), { id: held[1].id, policyRevision: 1 }); b.succeed(held[1].id);
  assert.deepEqual(b.inspect().reservations.map(r => r.policyRevision), [0, 1]); b.close();

  // Original identity opens even after both original and current evidence expire.
  f.setClock(NOW + 3_600_000); b = f.open();
  assert.equal(b.requestPolicy.evidenceSha256, renewedPolicy(f.auth).evidenceSha256);
  assert.equal(b.policyRevision, 1);
  assert.throws(() => reserve(b), code('PRICE_EVIDENCE_STALE'));
  assert.deepEqual(b.refreshPriceEvidence(renewedPolicy(f.auth, 2)), { policyRevision: 2 });
  succeed(b, reserve(b, 1, 'task-2', 'after-restart')[0]);
  assert.equal(b.inspect().remainingPosts, 0); assert.equal(b.inspect().remainingMicros, 0);
  assert.throws(() => reserve(b), code('STAGE_POST_LIMIT'));
  assert.equal(fs.readFileSync(f.auth.identityFile, 'utf8'), identity);
  const ledger = JSON.parse(fs.readFileSync(path.join(f.auth.ledgerDirectory, 'ledger.json'), 'utf8'));
  const head = JSON.parse(fs.readFileSync(`${f.auth.identityFile}.head.json`, 'utf8'));
  assert.equal(ledger.policyHistory.length, 3); assert.equal(head.revision, ledger.revision); b.close();
});

test('renewal cannot change any authorized bounds, use stale evidence or run in flight', t => {
  const f = fixture(t); const b = f.open(), [held] = reserve(b);
  f.setClock(NOW + 1_800_000);
  const next = renewedPolicy(f.auth), ledger = path.join(f.auth.ledgerDirectory, 'ledger.json');
  const bytes = fs.readFileSync(ledger, 'utf8');
  for (const change of [{ endpoint: 'https://other.invalid/v1/chat/completions' }, { model: 'other-model' },
    { maxOutputTokens: 1000 }, { maxRequestBytes: 4000 }, { cashUpperBoundCny: '0.09' },
    { cashUpperBoundCny: '0.11' }, { coversAllBillableTokens: false }, { extra: 'not-evidence' },
    { evidenceSha256: f.auth.requestPolicy.evidenceSha256 }, { verifiedAt: f.auth.requestPolicy.verifiedAt },
    { expiresAt: f.auth.requestPolicy.expiresAt }, { verifiedAt: new Date(NOW + 1_800_001).toISOString() }]) {
    assert.throws(() => b.refreshPriceEvidence({ ...next, ...change }));
    assert.equal(fs.readFileSync(ledger, 'utf8'), bytes);
  }
  assert.throws(() => b.refreshPriceEvidence(f.auth.requestPolicy), code('PRICE_EVIDENCE_STALE'));
  b.refreshPriceEvidence(next); b.begin(held.id);
  f.setClock(NOW + 3_600_000);
  assert.throws(() => b.refreshPriceEvidence(renewedPolicy(f.auth, 2)), code('PRICE_RENEWAL_IN_FLIGHT'));
  b.succeed(held.id); b.refreshPriceEvidence(renewedPolicy(f.auth, 2));
  f.setClock(NOW + 5_400_000);
  assert.throws(() => b.refreshPriceEvidence({ ...renewedPolicy(f.auth, 3), evidenceSha256: next.evidenceSha256 }),
    code('PRICE_EVIDENCE_NOT_ADVANCING'));
  f.setClock(NOW + 1_800_000);
  assert.throws(() => reserve(b), code('PRICE_EVIDENCE_STALE'));
  assert.throws(() => b.refreshPriceEvidence(next), code('PRICE_EVIDENCE_NOT_ADVANCING')); b.close();
});

test('renewal does not reset per-task count, stop or malformed-output halt', t => {
  const f = fixture(t); let b = f.open(); reserve(b, 8).forEach(r => succeed(b, r));
  f.setClock(NOW + 1_800_000); b.refreshPriceEvidence(renewedPolicy(f.auth));
  assert.throws(() => reserve(b, 1, 'task-1', 'renamed'), code('TASK_POST_LIMIT'));
  const held = reserve(b, 3, 'task-2'); succeed(b, held[0]); b.begin(held[1].id);
  b.haltForInvalidOutput();
  assert.equal(b.inspect().haltCode, 'INVALID_AGENT_OUTPUT');
  assert.equal(b.inspect().reservations[8].status, 'SUCCEEDED');
  assert.equal(b.succeed(held[1].id).accepted, false);
  assert.throws(() => b.begin(held[2].id), code('STAGE_HALTED'));
  assert.throws(() => b.refreshPriceEvidence(renewedPolicy(f.auth, 2)), code('STAGE_HALTED'));
  b.stop(); b.close(); b = f.open();
  assert.equal(b.inspect().haltCode, 'INVALID_AGENT_OUTPUT');
  assert.equal(b.inspect().reservedPosts, 11); assert.equal(b.inspect().reservedMicros, 1_100_000);
  assert.throws(() => b.refreshPriceEvidence(renewedPolicy(f.auth, 2)), code('STAGE_HALTED')); b.close();
  const stopped = fixture(t), stoppedBudget = stopped.open(); stoppedBudget.stop();
  assert.throws(() => stoppedBudget.refreshPriceEvidence(renewedPolicy(stopped.auth)), code('STAGE_HALTED')); stoppedBudget.close();
});

test('renewed evidence cannot be rolled back below the existing external checkpoint', t => {
  const f = fixture(t); const b = f.open(), ledger = path.join(f.auth.ledgerDirectory, 'ledger.json');
  const previous = fs.readFileSync(ledger);
  f.setClock(NOW + 1_800_000); b.refreshPriceEvidence(renewedPolicy(f.auth)); b.close();
  fs.writeFileSync(ledger, previous);
  assert.throws(() => f.open(), code('LEDGER_CHECKPOINT_MISMATCH'));
});

test('partial renewal commit retains the advanced checkpoint and fails closed', t => {
  const f = fixture(t), b = f.open(), rename = fs.renameSync;
  f.setClock(NOW + 1_800_000);
  fs.renameSync = (source, target) => {
    if (target === path.join(f.auth.ledgerDirectory, 'ledger.json')) throw new Error('synthetic renewal IO failure');
    return rename(source, target);
  };
  try { assert.throws(() => b.refreshPriceEvidence(renewedPolicy(f.auth)), code('LEDGER_IO_OR_INTEGRITY_FAILURE')); }
  finally { fs.renameSync = rename; }
  assert.throws(() => reserve(b), code('LEDGER_IO_OR_INTEGRITY_FAILURE'));
  fs.unlinkSync(path.join(f.auth.ledgerDirectory, 'stage.lock')); // Test-only forensic action.
  assert.throws(() => f.open(), code('LEDGER_CHECKPOINT_MISMATCH'));
});

test('reopening a manually inspected crash stage preserves the original logical failure latch', t => {
  const f = fixture(t);
  const source = `import {StageBudget} from ${JSON.stringify(new URL('../src/budget.mjs', import.meta.url).href)};
    const b=StageBudget.open({authorization:JSON.parse(process.argv[1]),now:()=>${NOW}});
    const [r]=b.reserveBatch({taskId:'task-1',runId:'crashed',requests:[{purpose:'initial'}]});
    b.begin(r.id); b.haltForInvalidOutput(); process.exit(0);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source, JSON.stringify(f.auth)], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  // Test-only forensic lock removal after the owning child process has exited.
  fs.unlinkSync(path.join(f.auth.ledgerDirectory, 'stage.lock'));
  f.setClock(NOW + 1_800_000); const b = f.open();
  assert.equal(b.inspect().haltCode, 'INVALID_AGENT_OUTPUT'); assert.equal(b.inspect().reservedPosts, 1);
  assert.equal(b.inspect().reservations[0].status, 'INCOMPLETE');
  assert.throws(() => b.refreshPriceEvidence(renewedPolicy(f.auth)), code('STAGE_HALTED')); b.close();
});

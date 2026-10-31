import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createSyntheticStageHarness, trustedSourceRevision, PHASE_ID, LIVE_DEADLINE } from '../src/trusted-stage.mjs';
import { StageBudget, RECOVERY_ID } from '../src/budget.mjs';
import { createRun, verifyFrozenBundle } from '../src/coordinator.mjs';
import { roleResult, providerResponse } from './transport-fixtures.mjs';

globalThis.fetch = () => { throw Error('REAL_FETCH_FORBIDDEN'); };
const sha = value => createHash('sha256').update(value).digest('hex');
const bytes = value => `${JSON.stringify(value, null, 2)}\n`;
const NOW = Date.UTC(2026, 9, 31, 5);
function inventory(root) {
  const result = {};
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, item.name);
    if (item.isDirectory()) Object.assign(result, inventory(file)); else result[file] = sha(fs.readFileSync(file));
  }
  return result;
}
function fixture(t, { respond } = {}) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'planpatch-live-test-'));
  const sourceRoot = path.join(root, 'source'); fs.mkdirSync(sourceRoot);
  for (const dir of ['src', 'public', 'samples', 'scripts', 'test']) fs.mkdirSync(path.join(sourceRoot, dir));
  for (const file of ['package.json', 'package-lock.json', 'server.mjs', 'CONTRACT.md', 'src/source.mjs'])
    fs.writeFileSync(path.join(sourceRoot, file), 'synthetic original source\n');
  const input = JSON.parse(fs.readFileSync(new URL('../samples/community-update.json', import.meta.url), 'utf8'));
  fs.writeFileSync(path.join(sourceRoot, 'samples/community-update.json'), bytes(input));
  let clock = NOW, stage, releaseReview;
  const reviewGate = new Promise(resolve => { releaseReview = resolve; });
  const stats = { keyReads: 0, fakePosts: 0 }, requests = [];
  const harness = createSyntheticStageHarness({ root, sourceRoot, now: () => clock,
    credential() { stats.keyReads++; return 'synthetic_not_a_real_credential_12345'; },
    async fetchImpl(endpoint, init) {
      assert.equal(endpoint, 'https://offline.invalid/v1/chat/completions'); assert.equal(init.method, 'POST');
      stats.fakePosts++;
      const task = JSON.parse(JSON.parse(init.body).messages.findLast(message => message.role === 'user').content);
      requests.push(task);
      if (task.kind === 'review') await reviewGate;
      return respond ? respond({ task, result: roleResult(task) }) : providerResponse(roleResult(task));
    } });
  fs.mkdirSync(harness.paths.stage, { recursive: true });
  const price = { schemaVersion: 1, kind: 'OFFICIAL_PRICE_CHECK', synthetic: true, currency: 'CNY',
    verifiedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 1800000).toISOString(),
    sourceUrls: ['https://offline.invalid/pricing'], endpoint: 'https://offline.invalid/v1/chat/completions', model: 'synthetic-model',
    maxOutputTokens: 1024, maxRequestBytes: 32768, cashUpperBoundCny: '0.1', coversAllBillableTokens: true,
    reasoningEffort: 'low', responseFormat: 'json_object', basis: 'CASH_FULL_REQUEST', notes: 'SYNTHETIC TEST ONLY' };
  const requestPolicy = Object.fromEntries(['endpoint', 'model', 'maxOutputTokens', 'maxRequestBytes', 'cashUpperBoundCny',
    'verifiedAt', 'expiresAt', 'coversAllBillableTokens', 'reasoningEffort', 'responseFormat'].map(key => [key, price[key]]));
  requestPolicy.evidenceSha256 = sha(bytes(price));
  const text = 'SYNTHETIC TEST ONLY: no actual user authority or real requests.';
  const auth = { schemaVersion: 1, kind: 'SYNTHETIC_TEST_AUTHORIZATION', granted: true, synthetic: true,
    id: PHASE_ID, stageId: PHASE_ID, currency: 'CNY', maximumSpendCny: '5', maximumPosts: 8,
    allowedTaskIds: ['community-update'], productRevision: trustedSourceRevision(sourceRoot), deadline: LIVE_DEADLINE,
    recordedAt: new Date(NOW).toISOString(), humanAuthorization: { reference: 'synthetic:old', text, sha256: sha(text) }, requestPolicy };
  fs.writeFileSync(harness.paths.authorization, bytes(auth)); fs.writeFileSync(harness.paths.price, bytes(price));
  const budgetAuth = { ...auth, ledgerDirectory: harness.paths.ledger, identityFile: harness.paths.identity };
  const open = () => { stage = harness.open({ send: true, taskId: 'community-update' }); return stage; };
  const close = () => { stage?.close(); stage = undefined; };
  // Reproduce the three consumed rows without ever issuing a network/fake POST.
  const original = open().transport.budget;
  const slots = original.reserveBatch({ taskId: 'community-update', runId: 'synthetic-old-run',
    requests: [{ purpose: 'initial' }, { purpose: 'initial' }, { purpose: 'revision' }] });
  original.begin(slots[0].id); original.begin(slots[1].id);
  original.fail(slots[0].id, 'TIMEOUT'); original.fail(slots[1].id, 'ABORTED'); close();
  stats.keyReads = 0;
  const preserved = Object.fromEntries([harness.paths.authorization, harness.paths.identity, harness.paths.binding,
    harness.paths.price].map(file => [file, fs.readFileSync(file)]));
  const ledgerFile = path.join(harness.paths.ledger, 'ledger.json'), headFile = `${harness.paths.identity}.head.json`;
  const baseLedger = fs.readFileSync(ledgerFile), baseHead = fs.readFileSync(headFile);
  const base = JSON.parse(baseLedger);
  clock = NOW + 1000;
  fs.appendFileSync(path.join(sourceRoot, 'src/source.mjs'), 'synthetic recovery source\n');
  const freshPrice = { ...price, verifiedAt: new Date(clock).toISOString(), expiresAt: new Date(clock + 1800000).toISOString() };
  const grant = { schemaVersion: 1, kind: 'SYNTHETIC_TEST_RECOVERY', synthetic: true, granted: true, id: RECOVERY_ID,
    stageId: PHASE_ID, originalAuthorizationSha256: sha(preserved[harness.paths.authorization]),
    expectedCheckpoint: { ledgerSha256: sha(baseLedger), headSha256: sha(baseHead),
      identitySha256: sha(preserved[harness.paths.identity]), revision: base.revision },
    fromSourceRevision: auth.productRevision, toSourceRevision: trustedSourceRevision(sourceRoot), maximumSpendCny: '5', maximumPosts: 8,
    historicalReservationsSha256: sha(JSON.stringify(base.reservations)), historicalReservationCount: 3, expectedHaltCode: 'TIMEOUT',
    allowedTaskId: 'community-update', maximumNewPosts: 4, timeoutMs: 120000,
    requestBounds: Object.fromEntries(['endpoint', 'model', 'maxOutputTokens', 'maxRequestBytes', 'cashUpperBoundCny',
      'coversAllBillableTokens', 'reasoningEffort', 'responseFormat'].map(key => [key, price[key]])),
    freshPriceSha256: sha(bytes(freshPrice)), deadline: LIVE_DEADLINE, recordedAt: new Date(clock).toISOString(),
    humanAuthorization: { reference: 'synthetic:recovery', text, sha256: sha(text) } };
  const saveGrant = () => { fs.mkdirSync(path.dirname(harness.paths.recovery), { recursive: true }); fs.writeFileSync(harness.paths.recovery, bytes(grant)); };
  const savePrice = () => { fs.mkdirSync(path.dirname(harness.paths.recoveryPrice), { recursive: true }); fs.writeFileSync(harness.paths.recoveryPrice, bytes(freshPrice)); };
  t.after(() => {
    try { close(); } catch { /* Deliberately broken synthetic crash locks remain until temp cleanup. */ }
    assert.equal(path.dirname(path.resolve(root)).toLowerCase(), path.resolve(tmpdir()).toLowerCase());
    assert.ok(path.basename(root).startsWith('planpatch-live-test-')); fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, sourceRoot, harness, stats, requests, input, grant, auth, budgetAuth, base, baseLedger, baseHead, preserved,
    freshPrice, saveGrant, savePrice, open, close, ledgerFile, headFile, setClock(value) { clock = value; },
    now: () => clock, prepare() { saveGrant(); savePrice(); },
    onEvent(event) { if (['PATCH_APPLIED', 'NO_CHANGE', 'RUN_FAILED', 'RUN_STOPPED'].includes(event.type)) releaseReview(); } };
}

test('old halt stays blocked; recovery preflight is read-only and pending grant never sends or reads key', t => {
  const f = fixture(t); const before = inventory(f.root);
  assert.equal(f.harness.preflight().code, 'SOURCE_REVISION_MISMATCH');
  assert.throws(() => f.harness.activateRecovery({ activate: true }));
  assert.deepEqual(inventory(f.root), before);
  f.prepare(); const pending = inventory(f.root);
  assert.equal(f.harness.preflightRecovery().status, 'RECOVERY_PREFLIGHT_PASSED');
  assert.equal(f.harness.preflight().code, 'STAGE_HALTED');
  assert.throws(f.open, { code: 'STAGE_HALTED' });
  assert.throws(() => f.harness.activateRecovery({}), { code: 'EXPLICIT_ACTIVATION_REQUIRED' });
  assert.equal(f.stats.keyReads, 0); assert.equal(f.stats.fakePosts, 0); assert.deepEqual(inventory(f.root), pending);
});

for (const [name, mutate] of [
  ['disabled', g => { g.granted = false; }], ['synthetic in production kind', g => { g.synthetic = false; g.kind = 'RECORDED_USER_RECOVERY'; }],
  ['unknown key', g => { g.force = true; }], ['phase', g => { g.stageId = 'new-phase'; }],
  ['original binding', g => { g.originalAuthorizationSha256 = 'a'.repeat(64); }],
  ['stale checkpoint', g => { g.expectedCheckpoint.revision--; }], ['head', g => { g.expectedCheckpoint.headSha256 = 'a'.repeat(64); }],
  ['identity', g => { g.expectedCheckpoint.identitySha256 = 'a'.repeat(64); }],
  ['source', g => { g.toSourceRevision = 'a'.repeat(64); }], ['count', g => { g.maximumPosts++; }],
  ['cash', g => { g.maximumSpendCny = '6'; }], ['new posts', g => { g.maximumNewPosts = 5; }],
  ['timeout', g => { g.timeoutMs = 60000; }], ['model', g => { g.requestBounds.model = 'changed-model'; }],
  ['reasoning', g => { g.requestBounds.reasoningEffort = 'none'; }],
  ['output cap', g => { g.requestBounds.maxOutputTokens = 2048; }],
  ['price', g => { g.freshPriceSha256 = 'a'.repeat(64); }], ['human evidence', g => { g.humanAuthorization.text += 'changed'; }],
  ['old reservations', g => { g.historicalReservationsSha256 = 'a'.repeat(64); }],
]) test(`recovery rejects ${name} before key, lock, writes or sends`, t => {
  const f = fixture(t); mutate(f.grant); f.prepare(); const before = inventory(f.root);
  assert.equal(f.harness.preflightRecovery().status, 'BLOCKED');
  assert.throws(() => f.harness.activateRecovery({ activate: true }));
  assert.equal(f.stats.keyReads, 0); assert.equal(f.stats.fakePosts, 0); assert.deepEqual(inventory(f.root), before);
});

test('one recovery retains original bytes and three rows, makes four fake POSTs, keeps seven on restart and cannot reuse spare one', async t => {
  const f = fixture(t); f.prepare();
  assert.equal(f.harness.activateRecovery({ activate: true }).status, 'RECOVERY_ACTIVATED');
  assert.equal(f.stats.keyReads, 0); assert.equal(f.stats.fakePosts, 0);
  assert.equal(f.harness.preflight().status, 'PREFLIGHT_PASSED');
  const stage = f.open(), budget = stage.transport.budget;
  assert.equal(budget.inspect().reservedPosts, 3); assert.equal(budget.inspect().halted, false);
  assert.deepEqual(budget.inspect().historicalHalt, { halted: true, code: 'TIMEOUT' });
  const run = await createRun({ input: f.input, mode: 'OFFLINE_TRANSPORT', runDirectory: stage.runDirectory,
    transport: stage.transport, onEvent: f.onEvent });
  const result = await run.start(); assert.equal(result.status, 'FINISHED');
  assert.equal(f.stats.fakePosts, 4); assert.equal(result.counters.fakeGenerationPosts, 4);
  const bundle = await run.freeze(); assert.equal(verifyFrozenBundle(bundle), true);
  assert.equal(bundle.fullSourceRevision, f.grant.toSourceRevision); assert.equal(bundle.snapshot.recovery.timeoutMs, 120000);
  const event = type => result.events.find(e => e.type === type), patch = event('PATCH_APPLIED');
  assert.equal(event('OWNER_SNAPSHOT_TRIGGERED').causedBy, event('EVIDENCE_PUBLISHED').id);
  const oldB = result.events.find(e => e.type === 'POST_STARTED' && e.agentId === 'B');
  const oldBEnd = result.events.find(e => e.type === 'POST_ENDED' && e.reservationId === oldB.reservationId);
  assert.ok(patch.monotonicMs < oldBEnd.monotonicMs);
  assert.deepEqual(patch.recheckCoverage, [{ slotId: patch.heldRecheckSlots[0], requirements: patch.affectedRequirements }]);
  assert.equal(f.requests.filter(task => task.kind === 'recheck').length, 1);
  assert.deepEqual(f.requests.find(task => task.kind === 'recheck').requirements, patch.affectedRequirements);
  assert.equal(event('CHECK_REJECTED').code, 'STALE_CHECK');
  assert.equal(result.checks.find(c => c.id === 'weather-backup').status, 'UNKNOWN');
  assert.equal(budget.inspect().reservedPosts, 7); assert.equal(budget.inspect().remainingPosts, 1);
  assert.equal(budget.inspect().recovery.remainingPosts, 0); f.close();
  const persisted = JSON.parse(fs.readFileSync(f.ledgerFile));
  assert.equal(persisted.halted, true); assert.equal(persisted.haltCode, 'TIMEOUT');
  assert.deepEqual(persisted.reservations.slice(0, 3), f.base.reservations);
  assert.deepEqual(fs.readFileSync(path.join(f.harness.paths.ledger, 'recovery-base-ledger.json')), f.baseLedger);
  assert.deepEqual(fs.readFileSync(path.join(f.harness.paths.ledger, 'recovery-base-head.json')), f.baseHead);
  for (const [file, original] of Object.entries(f.preserved)) assert.deepEqual(fs.readFileSync(file), original);
  const keyReads = f.stats.keyReads, before = inventory(f.root);
  assert.equal(f.harness.preflight().code, 'RECOVERY_RUN_LIMIT'); assert.throws(f.open, { code: 'RECOVERY_RUN_LIMIT' });
  assert.throws(() => f.harness.activateRecovery({ activate: true }), { code: 'RECOVERY_ALREADY_USED' });
  assert.equal(f.stats.keyReads, keyReads); assert.deepEqual(inventory(f.root), before);
  const reopened = StageBudget.open({ authorization: f.budgetAuth, now: f.now });
  assert.equal(reopened.inspect().reservedPosts, 7);
  assert.throws(() => reopened.reserveBatch({ taskId: 'community-update', runId: 'second-run', requests: [{ purpose: 'initial' }] }),
    { code: 'RECOVERY_RUN_LIMIT' }); reopened.close();
});

for (const mode of ['failure', 'stop', 'unsettled close']) test(`new ${mode} halts recovery permanently and original grant cannot reopen it`, t => {
  const f = fixture(t); f.prepare(); f.harness.activateRecovery({ activate: true });
  const budget = f.open().transport.budget;
  const slot = budget.reserveBatch({ taskId: 'community-update', runId: 'new-run', requests: [{ purpose: 'initial' }] })[0];
  if (mode === 'failure') { budget.begin(slot.id); budget.fail(slot.id, 'TIMEOUT'); }
  if (mode === 'stop') budget.stop();
  f.close();
  const state = JSON.parse(fs.readFileSync(f.ledgerFile));
  assert.equal(state.schedulingEpoch.halted, true); assert.equal(state.schedulingEpoch.haltEvents.length, 1);
  assert.deepEqual(state.reservations.slice(0, 3), f.base.reservations);
  assert.equal(f.harness.preflight().code, 'STAGE_HALTED');
  assert.throws(() => f.harness.activateRecovery({ activate: true }), { code: 'RECOVERY_ALREADY_USED' });
  assert.equal(f.stats.fakePosts, 0);
});

test('concurrent owner prevents activation without deleting its lock', t => {
  const f = fixture(t); f.prepare(); const held = StageBudget.open({ authorization: f.budgetAuth, now: f.now });
  const before = inventory(f.root);
  assert.throws(() => f.harness.activateRecovery({ activate: true }), { code: 'STAGE_LOCKED' });
  assert.deepEqual(inventory(f.root), before); assert.equal(f.stats.keyReads, 0); held.close();
  assert.equal(f.harness.activateRecovery({ activate: true }).status, 'RECOVERY_ACTIVATED');
});

for (const boundary of ['snapshot', 'head', 'head after rename', 'ledger', 'ledger after rename']) test(`partial activation at ${boundary} leaves a blocked lock/checkpoint without reset`, t => {
  const f = fixture(t); f.prepare();
  const write = fs.writeFileSync, rename = fs.renameSync, open = fs.openSync; let intercepted = false, snapshotFd;
  fs.openSync = (file, ...args) => {
    const fd = open(file, ...args);
    if (file === path.join(f.harness.paths.ledger, 'recovery-base-ledger.json')) snapshotFd = fd;
    return fd;
  };
  fs.writeFileSync = (file, ...args) => {
    if (boundary === 'snapshot' && snapshotFd !== undefined && file === snapshotFd && !intercepted) { intercepted = true; throw Error('synthetic crash'); }
    return write(file, ...args);
  };
  fs.renameSync = (from, to) => {
    if (!intercepted && ((boundary === 'head' && to === f.headFile) || (boundary === 'ledger' && to === f.ledgerFile))) {
      intercepted = true; throw Error('synthetic crash');
    }
    if (!intercepted && ((boundary === 'head after rename' && to === f.headFile)
      || (boundary === 'ledger after rename' && to === f.ledgerFile))) {
      rename(from, to); intercepted = true; throw Error('synthetic crash after durable rename');
    }
    return rename(from, to);
  };
  try { assert.throws(() => f.harness.activateRecovery({ activate: true })); }
  finally { fs.writeFileSync = write; fs.renameSync = rename; fs.openSync = open; }
  assert.equal(intercepted, true); assert.equal(f.harness.preflight().status, 'BLOCKED');
  assert.throws(() => f.harness.activateRecovery({ activate: true }), { code: 'STAGE_LOCKED' });
  assert.equal(f.stats.keyReads, 0); assert.equal(f.stats.fakePosts, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.ledgerFile)).reservations.slice(0, 3), f.base.reservations);
});

test('a late success after a recovery failure stays incomplete and cannot consume the unused recovery allowance', t => {
  const f = fixture(t); f.prepare(); f.harness.activateRecovery({ activate: true });
  const budget = f.open().transport.budget;
  const slots = budget.reserveBatch({ taskId: 'community-update', runId: 'new-run',
    requests: [{ purpose: 'initial' }, { purpose: 'initial' }] });
  slots.forEach(slot => budget.begin(slot.id));
  budget.fail(slots[0].id, 'TIMEOUT');
  assert.deepEqual(budget.succeed(slots[1].id), { accepted: false, code: 'STAGE_HALTED' });
  assert.throws(() => budget.reserveBatch({ taskId: 'community-update', runId: 'new-run',
    requests: [{ purpose: 'revision' }] }), { code: 'STAGE_HALTED' });
  const state = budget.inspect();
  assert.equal(state.reservedPosts, 5); assert.equal(state.recovery.remainingPosts, 2);
  assert.deepEqual(state.reservations.slice(3).map(row => row.status), ['FAILED', 'INCOMPLETE']);
  f.close(); assert.equal(f.harness.preflight().code, 'STAGE_HALTED');
  assert.throws(() => f.harness.activateRecovery({ activate: true }), { code: 'RECOVERY_ALREADY_USED' });
});

for (const phase of ['before reservation', 'held', 'in flight'])
  test(`recovery child exit ${phase} leaves its exclusive lock and does not make its grant reusable`, t => {
    const f = fixture(t); f.prepare(); f.harness.activateRecovery({ activate: true });
    const code = `import { StageBudget } from ${JSON.stringify(new URL('../src/budget.mjs', import.meta.url).href)};
      const budget = StageBudget.open({ authorization: ${JSON.stringify(f.budgetAuth)}, now: () => ${NOW + 1000} });
      ${phase === 'before reservation' ? '' : `const [slot] = budget.reserveBatch({ taskId: 'community-update', runId: 'crashed-run', requests: [{ purpose: 'initial' }] });`}
      ${phase === 'in flight' ? 'budget.begin(slot.id);' : ''}
      process.exit(0);`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 10000,
      env: Object.fromEntries(['SystemRoot', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]])) });
    assert.equal(child.status, 0, child.stderr);
    const before = inventory(f.root);
    assert.equal(f.harness.preflight().code, 'STAGE_LOCKED'); assert.throws(f.open, { code: 'STAGE_LOCKED' });
    assert.throws(() => f.harness.activateRecovery({ activate: true }), { code: 'STAGE_LOCKED' });
    assert.deepEqual(inventory(f.root), before); assert.equal(f.stats.keyReads, 0); assert.equal(f.stats.fakePosts, 0);
    const state = JSON.parse(fs.readFileSync(f.ledgerFile));
    assert.equal(state.reservations.length, phase === 'before reservation' ? 3 : 4);
    assert.deepEqual(state.reservations.slice(0, 3), f.base.reservations);
  });

for (const mutation of ['missing check', 'duplicate check', 'wrong source', 'stale version'])
  test(`batched ${mutation} is rejected without partial model check publication`, async t => {
    const f = fixture(t, { respond({ task, result }) {
      if (task.kind === 'recheck') {
        if (mutation === 'missing check') result.checks.pop();
        if (mutation === 'duplicate check') result.checks.push(result.checks[0]);
        if (mutation === 'wrong source') result.checks[0].sourceIds = ['forged'];
        if (mutation === 'stale version') result.baseEvidenceVersion--;
      }
      return providerResponse(result);
    } }); f.prepare(); f.harness.activateRecovery({ activate: true }); const stage = f.open();
    const run = await createRun({ input: f.input, mode: 'OFFLINE_TRANSPORT', runDirectory: stage.runDirectory,
      transport: stage.transport, onEvent: f.onEvent });
    const result = await run.start(); assert.equal(result.status, 'FAILED'); assert.equal(result.error.code, 'INVALID_AGENT_OUTPUT');
    assert.equal(f.stats.fakePosts, 4); assert.equal(stage.transport.budget.inspect().halted, true);
    assert.ok(!result.events.some(e => e.type === 'CHECKS_PUBLISHED')); assert.equal(result.readyToSubmit, false);
  });

test('recovery price expiry/source edits/snapshot tamper block before key reads', t => {
  for (const mutation of ['price expiry', 'source edit', 'snapshot tamper']) {
    const f = fixture(t); f.prepare(); f.harness.activateRecovery({ activate: true });
    if (mutation === 'price expiry') f.setClock(NOW + 1801000);
    if (mutation === 'source edit') fs.appendFileSync(path.join(f.sourceRoot, 'src/source.mjs'), 'drift');
    if (mutation === 'snapshot tamper') fs.appendFileSync(path.join(f.harness.paths.ledger, 'recovery-base-ledger.json'), ' ');
    const before = inventory(f.root);
    assert.equal(f.harness.preflight().status, 'BLOCKED'); assert.throws(f.open);
    assert.equal(f.stats.keyReads, 0); assert.deepEqual(inventory(f.root), before);
  }
});

for (const mutation of ['source', 'price', 'grant', 'snapshot'])
  test(`recovery ${mutation} drift after reservation consumes its hold, sends nothing and permanently halts`, async t => {
    const f = fixture(t); f.prepare(); f.harness.activateRecovery({ activate: true }); const stage = f.open();
    const slot = stage.transport.budget.reserveBatch({ taskId: 'community-update', runId: 'synthetic-drift', requests: [{ purpose: 'initial' }] })[0];
    if (mutation === 'source') fs.appendFileSync(path.join(f.sourceRoot, 'src/source.mjs'), 'drift');
    if (mutation === 'price') fs.appendFileSync(f.harness.paths.recoveryPrice, ' ');
    if (mutation === 'grant') fs.appendFileSync(f.harness.paths.recovery, ' ');
    if (mutation === 'snapshot') fs.appendFileSync(path.join(f.harness.paths.ledger, 'recovery-base-ledger.json'), ' ');
    const traces = [];
    await assert.rejects(stage.transport.provider.generate({ reservationId: slot.id, messages: [{ role: 'user', content: '{}' }],
      onTrace: event => traces.push(event) }));
    assert.equal(f.stats.fakePosts, 0); assert.deepEqual(traces, []);
    const state = stage.transport.budget.inspect(); assert.equal(state.reservedPosts, 4); assert.equal(state.halted, true);
    assert.equal(state.reservations[3].status, 'FAILED'); assert.deepEqual(state.reservations.slice(0, 3), f.base.reservations);
    f.close(); assert.throws(() => f.harness.activateRecovery({ activate: true }));
  });

test('restoring the pre-recovery ledger cannot roll back the external checkpoint or recreate recovery allowance', t => {
  const f = fixture(t); f.prepare(); f.harness.activateRecovery({ activate: true });
  fs.writeFileSync(f.ledgerFile, f.baseLedger); const before = inventory(f.root);
  assert.equal(f.harness.preflight().code, 'LEDGER_CHECKPOINT_MISMATCH');
  assert.throws(() => f.harness.activateRecovery({ activate: true }), { code: 'LEDGER_CHECKPOINT_MISMATCH' });
  assert.deepEqual(inventory(f.root), before); assert.equal(f.stats.keyReads, 0);
});

test('ordinary production preflight is read-only with current authorization, and recovery cannot be auto-activated', () => {
  const cwd = new URL('..', import.meta.url);
  const source = `import fs from 'node:fs'; let keys=0,writes=0,calls=0;
    const env=process.env;process.env=new Proxy(env,{get(t,k){if(k==='PLANPATCH_API_KEY'){keys++;throw Error('KEY_READ');}return t[k];}});
    globalThis.fetch=()=>{calls++;throw Error('NETWORK');};
    for(const name of ['writeFileSync','mkdirSync','renameSync','unlinkSync'])fs[name]=()=>{writes++;throw Error('WRITE');};
    const open=fs.openSync;fs.openSync=(p,flags,...a)=>{if(flags!=='r'){writes++;throw Error('WRITE_OPEN');}return open(p,flags,...a);};
    const m=await import('./src/trusted-stage.mjs');const report=m.preflightLive();
    console.log(JSON.stringify({report,keys,writes,calls}));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); const result = JSON.parse(child.stdout);
  assert.equal(result.report.status, 'BLOCKED'); assert.equal(result.report.readOnly, true);
  assert.equal(result.keys, 0); assert.equal(result.writes, 0); assert.equal(result.calls, 0);
});

test('production recovery CLI rejects arbitrary paths and never accepts a send flag', () => {
  for (const args of [['--send'], ['--activate', '--activate'], ['--root', tmpdir()]]) {
    const child = spawnSync(process.execPath, ['scripts/run-recovery.mjs', ...args], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    assert.equal(child.status, 2); assert.equal(JSON.parse(child.stdout).code, 'INVALID_CLI_ARGUMENTS');
  }
});

for (const entry of ['run-live.mjs', 'run-recovery.mjs'])
  test(`default ${entry} only reports admission without credential reads, network calls, activation or production writes`, () => {
    const code = `import fs from 'node:fs'; let keys=0,writes=0,calls=0;
      const env=process.env;process.env=new Proxy(env,{get(t,k){if(k==='PLANPATCH_API_KEY'){keys++;throw Error('KEY_READ');}return t[k];}});
      globalThis.fetch=()=>{calls++;throw Error('NETWORK');};
      for(const name of ['writeFileSync','mkdirSync','renameSync','unlinkSync'])fs[name]=()=>{writes++;throw Error('WRITE');};
      const open=fs.openSync;fs.openSync=(p,flags,...a)=>{if(flags!=='r'){writes++;throw Error('WRITE_OPEN');}return open(p,flags,...a);};
      process.argv=[process.execPath,${JSON.stringify(entry)}];
      await import(${JSON.stringify(new URL(`../scripts/${entry}`, import.meta.url).href)});
      console.log(JSON.stringify({keys,writes,calls}));`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 10000 });
    const lines = child.stdout.trim().split('\n'), stats = JSON.parse(lines.pop());
    const report = JSON.parse(lines.join('\n'));
    assert.equal(child.status, report.status === 'BLOCKED' ? 2 : 0, child.stderr);
    assert.ok(['BLOCKED', 'PREFLIGHT_PASSED', 'RECOVERY_PREFLIGHT_PASSED'].includes(report.status));
    assert.equal(report.readOnly, true); assert.equal(report.realGenerationPosts, 0);
    assert.deepEqual(stats, { keys: 0, writes: 0, calls: 0 });
  });

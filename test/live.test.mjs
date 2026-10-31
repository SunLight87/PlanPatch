import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { preflightLive, openTrustedStage, createSyntheticStageHarness, trustedSourceRevision, PHASE_ID, LIVE_DEADLINE, TRUSTED_PATHS } from '../src/trusted-stage.mjs';
import { runLive } from '../src/live-entry.mjs';
import { createRun, verifyFrozenBundle } from '../src/coordinator.mjs';
import { revisionManifest } from '../scripts/revision.mjs';
import { roleResult, providerResponse } from './transport-fixtures.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const bytes = value => `${JSON.stringify(value, null, 2)}\n`;
const NOW = Date.UTC(2026, 9, 30, 12);
const sample = async () => JSON.parse(await readFile(new URL('../samples/community-update.json', import.meta.url), 'utf8'));

async function fixture(t, { maximumPosts = 16, maximumSpendCny = '2', respond, credential,
  reasoningEffort = null, responseFormat = null } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'planpatch-live-test-'));
  const sourceRoot = path.join(root, 'source');
  await mkdir(sourceRoot);
  for (const dir of ['src', 'public', 'samples', 'scripts', 'test']) await mkdir(path.join(sourceRoot, dir));
  for (const file of ['package.json', 'package-lock.json', 'server.mjs', 'CONTRACT.md', 'src/source.mjs'])
    await writeFile(path.join(sourceRoot, file), 'synthetic source fixture\n');
  for (const id of ['community-update', 'community-no-change'])
    await copyFile(new URL(`../samples/${id}.json`, import.meta.url), path.join(sourceRoot, 'samples', `${id}.json`));
  let clock = NOW, stage;
  const stats = { fakePosts: 0 }, requests = [], bodies = [];
  const harness = createSyntheticStageHarness({ root, sourceRoot, now: () => clock, ...(credential ? { credential } : {}), async fetchImpl(endpoint, init) {
    assert.equal(endpoint, 'https://offline.invalid/v1/chat/completions');
    stats.fakePosts++;
    const body = JSON.parse(init.body); bodies.push(body);
    const task = JSON.parse(body.messages.findLast(item => item.role === 'user').content);
    requests.push(task);
    return respond ? respond({ task, result: roleResult(task) }) : providerResponse(roleResult(task));
  } });
  await mkdir(harness.paths.stage, { recursive: true });
  const price = { schemaVersion: 1, kind: 'OFFICIAL_PRICE_CHECK', synthetic: true, currency: 'CNY',
    verifiedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 1800000).toISOString(),
    sourceUrls: ['https://offline.invalid/pricing'], endpoint: 'https://offline.invalid/v1/chat/completions', model: 'synthetic-model',
    maxOutputTokens: 1024, maxRequestBytes: 64000, cashUpperBoundCny: '0.1', coversAllBillableTokens: true,
    reasoningEffort, responseFormat,
    basis: 'CASH_FULL_REQUEST', notes: 'Synthetic offline evidence; never spending authorization.' };
  const humanText = 'SYNTHETIC TEST ONLY. This grants no real money or request permission.';
  const policy = Object.fromEntries(['endpoint', 'model', 'maxOutputTokens', 'maxRequestBytes', 'cashUpperBoundCny',
    'verifiedAt', 'expiresAt', 'coversAllBillableTokens', 'reasoningEffort', 'responseFormat'].map(key => [key, price[key]]));
  policy.evidenceSha256 = sha(bytes(price));
  const auth = { schemaVersion: 1, kind: 'SYNTHETIC_TEST_AUTHORIZATION', granted: true, synthetic: true,
    id: PHASE_ID, stageId: PHASE_ID, currency: 'CNY', maximumSpendCny, maximumPosts,
    allowedTaskIds: ['community-update', 'community-no-change'], productRevision: trustedSourceRevision(sourceRoot),
    deadline: LIVE_DEADLINE, recordedAt: new Date(NOW).toISOString(),
    humanAuthorization: { reference: 'synthetic:test', text: humanText, sha256: sha(humanText) }, requestPolicy: policy };
  const saveAuth = () => writeFile(harness.paths.authorization, bytes(auth));
  const savePrice = () => writeFile(harness.paths.price, bytes(price));
  await saveAuth(); await savePrice();
  t.after(async () => {
    stage?.close();
    assert.equal(path.dirname(path.resolve(root)).toLowerCase(), path.resolve(tmpdir()).toLowerCase());
    assert.ok(path.basename(root).startsWith('planpatch-live-test-'));
    await rm(root, { recursive: true, force: true });
  });
  return { root, sourceRoot, harness, auth, price, saveAuth, savePrice, stats, requests, bodies,
    setClock(value) { clock = value; }, open() { stage = harness.open({ send: true, taskId: 'community-update' }); return stage; },
    close() { stage?.close(); stage = undefined; } };
}
function inventory(root) {
  const result = {};
  function walk(dir) { for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const filename = path.join(dir, item.name);
    if (item.isDirectory()) walk(filename); else result[path.relative(root, filename)] = sha(fs.readFileSync(filename));
  } }
  walk(root); return result;
}

test('production missing authorization preflight has zero key reads, fetches, locks or writes', () => {
  const savedEnv = process.env, originalFetch = globalThis.fetch;
  const originalRead = fs.readFileSync;
  const methods = ['writeFileSync', 'mkdirSync', 'openSync', 'renameSync', 'unlinkSync'];
  const originals = Object.fromEntries(methods.map(name => [name, fs[name]]));
  let credentials = 0, calls = 0, writes = 0;
  process.env = new Proxy(savedEnv, { get(target, key) { if (key === 'PLANPATCH_API_KEY') { credentials++; throw new Error('KEY_READ_FORBIDDEN'); } return target[key]; } });
  globalThis.fetch = () => { calls++; throw new Error('NETWORK_FORBIDDEN'); };
  for (const method of methods) fs[method] = () => { writes++; throw new Error('WRITE_FORBIDDEN'); };
  // The real workspace can already have an immutable funded authorization.
  // Model absence explicitly, without deleting/rewriting that production file.
  fs.readFileSync = (file, ...args) => {
    if (String(file) === TRUSTED_PATHS.authorization) throw Object.assign(new Error('synthetic absence'), { code: 'ENOENT' });
    return originalRead(file, ...args);
  };
  try {
    const report = preflightLive();
    assert.equal(report.code, 'AUTHORIZATION_MISSING'); assert.equal(report.readOnly, true);
    assert.equal(report.realGenerationPosts, 0); assert.equal(report.liveAcceptance, 'NOT_RUN');
    assert.equal(credentials, 0); assert.equal(calls, 0); assert.equal(writes, 0);
  } finally { process.env = savedEnv; globalThis.fetch = originalFetch; fs.readFileSync = originalRead;
    for (const method of methods) fs[method] = originals[method]; }
});

test('complete source hash matches the existing revision manifest, including test and entry files', async () => {
  assert.equal(trustedSourceRevision(), (await revisionManifest()).productRevision);
});

test('production gate rejects a copied synthetic authorization in an isolated product tree', async t => {
  const f = await fixture(t);
  for (const file of ['trusted-stage.mjs', 'budget.mjs', 'provider.mjs', 'diagnostics.mjs', 'domain.mjs'])
    await copyFile(new URL(`../src/${file}`, import.meta.url), path.join(f.sourceRoot, 'src', file));
  const stageDir = path.join(f.sourceRoot, 'var', 'trusted-event-mvp'); await mkdir(stageDir, { recursive: true });
  await writeFile(path.join(stageDir, 'authorization.json'), bytes(f.auth));
  const moduleUrl = pathToFileURL(path.join(f.sourceRoot, 'src/trusted-stage.mjs')).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `const m=await import(${JSON.stringify(moduleUrl)});console.log(JSON.stringify(m.preflightLive()));`], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); assert.equal(JSON.parse(child.stdout).code, 'INVALID_AUTHORIZATION');
  assert.equal(fs.existsSync(path.join(stageDir, 'ledger')), false);
});

test('missing synthetic key occurs after read-only admission, writes no ledger and permits explicit correction on same phase', async t => {
  let keyReads = 0, key;
  const f = await fixture(t, { credential() { keyReads++; return key; } });
  assert.equal(f.harness.preflight().status, 'PREFLIGHT_PASSED'); assert.equal(keyReads, 0);
  const before = inventory(f.root);
  assert.throws(f.open, { code: 'API_KEY_MISSING_OR_INVALID' });
  assert.equal(keyReads, 1); assert.equal(f.stats.fakePosts, 0);
  assert.deepEqual(inventory(f.root), before);
  assert.equal(fs.existsSync(f.harness.paths.identity), false); assert.equal(fs.existsSync(f.harness.paths.binding), false);
  key = 'synthetic_not_a_real_credential_12345'; const stage = f.open();
  assert.equal(stage.transport.budget.inspect().reservedPosts, 0); f.close();
  const enrolled = inventory(f.root); key = undefined;
  assert.throws(f.open, { code: 'API_KEY_MISSING_OR_INVALID' }); assert.deepEqual(inventory(f.root), enrolled);
  key = 'synthetic_not_a_real_credential_12345';
  assert.equal(f.open().transport.budget.inspect().halted, false); assert.equal(f.stats.fakePosts, 0);
});

for (const missing of [true, false]) test(`selected fixed sample ${missing ? 'missing' : 'id mismatch'} blocks before key reads or ledger enrollment`, async t => {
  let keyReads = 0;
  const f = await fixture(t, { credential() { keyReads++; return 'synthetic_not_a_real_credential_12345'; } });
  const filename = path.join(f.sourceRoot, 'samples/community-update.json');
  if (missing) await rm(filename); else { const input = await sample(); input.id = 'different-task'; await writeFile(filename, bytes(input)); }
  f.auth.productRevision = trustedSourceRevision(f.sourceRoot); await f.saveAuth();
  const before = inventory(f.root), code = missing ? 'TASK_SAMPLE_MISSING' : 'TASK_SAMPLE_ID_MISMATCH';
  assert.equal(f.harness.preflight({ taskId: 'community-update' }).code, code); assert.throws(f.open, { code });
  assert.equal(keyReads, 0); assert.deepEqual(inventory(f.root), before); assert.equal(fs.existsSync(f.harness.paths.identity), false);
});

test('public production APIs and CLI reject fetch/path/budget overrides and implicit sends', async () => {
  await assert.rejects(runLive({ send: true, fetchImpl() {} }), { code: 'INVALID_LIVE_OPTIONS' });
  assert.throws(() => openTrustedStage({ send: true, root: tmpdir() }), { code: 'INVALID_LIVE_OPTIONS' });
  assert.throws(() => openTrustedStage({ taskId: 'community-update' }), { code: 'EXPLICIT_SEND_REQUIRED' });
  const cli = spawnSync(process.execPath, ['scripts/run-live.mjs', '--ledger', 'arbitrary'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(cli.status, 2); assert.equal(JSON.parse(cli.stdout).code, 'INVALID_CLI_ARGUMENTS');
});

test('qualified synthetic preflight is read-only, explicit send required, and harness cannot mint LIVE', async t => {
  const f = await fixture(t); const before = inventory(f.root);
  assert.equal(f.harness.preflight().status, 'PREFLIGHT_PASSED');
  assert.deepEqual(f.harness.preflight().requestOptions, { reasoningEffort: null, responseFormat: null });
  assert.deepEqual(inventory(f.root), before);
  assert.throws(() => f.harness.open({ taskId: 'community-update' }), { code: 'EXPLICIT_SEND_REQUIRED' });
  assert.deepEqual(inventory(f.root), before);
  const stage = f.open();
  await assert.rejects(createRun({ input: await sample(), mode: 'LIVE', runDirectory: stage.runDirectory, transport: stage.transport }), { code: 'LIVE_DISABLED_NO_AUTHORIZATION' });
  await assert.rejects(createRun({ input: await sample(), mode: 'LIVE', runDirectory: stage.runDirectory,
    transport: { ...stage.transport, live: true, authorized: true } }), { code: 'LIVE_DISABLED_NO_AUTHORIZATION' });
  assert.equal(f.stats.fakePosts, 0);
});

test('explicit trusted options are exposed read-only and survive renewal and reopening unchanged', async t => {
  let keys = 0;
  const f = await fixture(t, { reasoningEffort: 'medium', responseFormat: 'json_object',
    credential() { keys++; return 'synthetic_not_a_real_credential_12345'; } });
  const before = inventory(f.root), report = f.harness.preflight();
  assert.equal(report.status, 'PREFLIGHT_PASSED'); assert.equal(keys, 0); assert.deepEqual(inventory(f.root), before);
  assert.deepEqual(report.requestOptions, { reasoningEffort: 'medium', responseFormat: 'json_object' });
  const stage = f.open();
  const slot = stage.transport.budget.reserveBatch({ taskId: 'community-update', runId: 'synthetic-options', requests: [{ purpose: 'initial' }] })[0];
  await stage.transport.provider.generate({ reservationId: slot.id, messages: [{ role: 'user',
    content: JSON.stringify({ agentId: 'A', kind: 'facts', snapshot: { sources: [], proposal: {}, proposalVersion: 0, evidenceVersion: 0 } }) }] });
  assert.equal(f.bodies[0].reasoning_effort, 'medium'); assert.deepEqual(f.bodies[0].response_format, { type: 'json_object' });
  const spent = stage.transport.budget.inspect(); f.close();
  f.setClock(NOW + 1800000); f.price.verifiedAt = new Date(NOW + 1800000).toISOString();
  f.price.expiresAt = new Date(NOW + 3600000).toISOString(); await f.savePrice();
  assert.equal(f.harness.preflight().status, 'PREFLIGHT_PASSED');
  const renewed = f.open().transport.budget;
  assert.equal(renewed.policyRevision, 1); assert.equal(renewed.inspect().remainingMicros, spent.remainingMicros);
  assert.equal(renewed.inspect().reservedPosts, spent.reservedPosts);
  assert.equal(renewed.requestPolicy.reasoningEffort, 'medium'); assert.equal(renewed.requestPolicy.responseFormat, 'json_object');
});

for (const [name, mutate] of [
  ['missing pair', p => { delete p.reasoningEffort; delete p.responseFormat; }],
  ['missing reasoning', p => { delete p.reasoningEffort; }],
  ['missing format', p => { delete p.responseFormat; }],
  ['unknown reasoning', p => { p.reasoningEffort = 'high'; }],
  ['unknown format', p => { p.responseFormat = 'json_schema'; }],
  ['schema object', p => { p.responseFormat = { type: 'json_schema', json_schema: {} }; }],
  ['format object', p => { p.responseFormat = { type: 'json_object' }; }],
]) test(`trusted authorization rejects ${name} before price, ledger or credential reads`, async t => {
  let keys = 0, forbiddenReads = 0;
  const f = await fixture(t, { credential() { keys++; return 'synthetic_not_a_real_credential_12345'; } });
  mutate(f.auth.requestPolicy); await f.saveAuth();
  const before = inventory(f.root), read = fs.readFileSync;
  fs.readFileSync = (filename, ...rest) => {
    if (String(filename) === f.harness.paths.price || String(filename).startsWith(f.harness.paths.ledger)
      || String(filename).startsWith(f.harness.paths.identity)) { forbiddenReads++; throw new Error('FORBIDDEN_READ'); }
    return read(filename, ...rest);
  };
  try {
    assert.equal(f.harness.preflight().code, 'INVALID_PRICE_POLICY'); assert.throws(f.open, { code: 'INVALID_PRICE_POLICY' });
  } finally { fs.readFileSync = read; }
  assert.equal(keys, 0); assert.equal(forbiddenReads, 0); assert.equal(f.stats.fakePosts, 0);
  assert.deepEqual(inventory(f.root), before); assert.equal(fs.existsSync(f.harness.paths.ledger), false);
});

test('isolated production gate rejects omitted request options before credentials or ledger enrollment', async t => {
  const f = await fixture(t);
  for (const file of ['trusted-stage.mjs', 'budget.mjs', 'provider.mjs', 'diagnostics.mjs', 'domain.mjs'])
    await copyFile(new URL(`../src/${file}`, import.meta.url), path.join(f.sourceRoot, 'src', file));
  const stageDir = path.join(f.sourceRoot, 'var', 'trusted-event-mvp'); await mkdir(stageDir, { recursive: true });
  const auth = structuredClone(f.auth); auth.kind = 'RECORDED_USER_AUTHORIZATION'; auth.synthetic = false;
  delete auth.requestPolicy.reasoningEffort; delete auth.requestPolicy.responseFormat;
  await writeFile(path.join(stageDir, 'authorization.json'), bytes(auth));
  const moduleUrl = pathToFileURL(path.join(f.sourceRoot, 'src/trusted-stage.mjs')).href;
  const source = `import fs from 'node:fs'; let keys=0,ledgerReads=0;
    const env=process.env; process.env=new Proxy(env,{get(t,k){if(k==='PLANPATCH_API_KEY'){keys++;throw Error('NO_KEY_READ');}return t[k];}});
    const read=fs.readFileSync; fs.readFileSync=(f,...a)=>{if(String(f).includes('ledger.json')){ledgerReads++;throw Error('NO_LEDGER_READ');}return read(f,...a);};
    const m=await import(${JSON.stringify(moduleUrl)}); const report=m.preflightLive(); let code;
    try {m.openTrustedStage({send:true,taskId:'community-update'});}catch(e){code=e.code;}
    console.log(JSON.stringify({report,code,keys,ledgerReads}));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout); assert.equal(result.report.code, 'INVALID_PRICE_POLICY');
  assert.equal(result.code, 'INVALID_PRICE_POLICY'); assert.equal(result.keys, 0); assert.equal(result.ledgerReads, 0);
  assert.equal(fs.existsSync(path.join(stageDir, 'ledger')), false);
});

for (const [name, mutate, code] of [
  ['missing pair', p => { delete p.reasoningEffort; delete p.responseFormat; }, 'INVALID_PRICE_EVIDENCE'],
  ['half pair', p => { delete p.responseFormat; }, 'INVALID_PRICE_EVIDENCE'],
  ['changed reasoning', p => { p.reasoningEffort = 'low'; }, 'REQUEST_POLICY_MISMATCH'],
  ['changed format', p => { p.responseFormat = 'json_object'; }, 'REQUEST_POLICY_MISMATCH'],
  ['unknown reasoning', p => { p.reasoningEffort = 'high'; }, 'INVALID_PRICE_POLICY'],
  ['schema format', p => { p.responseFormat = 'json_schema'; }, 'INVALID_PRICE_POLICY'],
]) test(`price evidence rejects ${name} on initial admission and renewal without writes`, async t => {
  for (const enrolled of [false, true]) {
    let keys = 0;
    const f = await fixture(t, { credential() { keys++; return 'synthetic_not_a_real_credential_12345'; } });
    if (enrolled) { f.open(); f.close(); f.setClock(NOW + 1800000);
      f.price.verifiedAt = new Date(NOW + 1800000).toISOString(); f.price.expiresAt = new Date(NOW + 3600000).toISOString(); }
    mutate(f.price); await f.savePrice(); const before = inventory(f.root), previousKeys = keys;
    assert.equal(f.harness.preflight().code, code); assert.throws(f.open, { code });
    assert.equal(keys, previousKeys); assert.equal(f.stats.fakePosts, 0); assert.deepEqual(inventory(f.root), before);
  }
});

test('trusted authorization options cannot change after enrollment even with matching price evidence', async t => {
  const f = await fixture(t); const stage = f.open();
  const slot = stage.transport.budget.reserveBatch({ taskId: 'community-update', runId: 'synthetic-options', requests: [{ purpose: 'initial' }] })[0];
  stage.transport.budget.begin(slot.id); stage.transport.budget.succeed(slot.id); f.close();
  const ledger = await readFile(path.join(f.harness.paths.ledger, 'ledger.json'));
  f.price.reasoningEffort = 'medium'; f.auth.requestPolicy.reasoningEffort = 'medium';
  f.auth.requestPolicy.evidenceSha256 = sha(bytes(f.price)); await f.saveAuth(); await f.savePrice();
  assert.equal(f.harness.preflight().code, 'AUTHORIZATION_CHANGED'); assert.throws(f.open, { code: 'AUTHORIZATION_CHANGED' });
  assert.deepEqual(await readFile(path.join(f.harness.paths.ledger, 'ledger.json')), ledger);
});

test('read-only admission rejects changed durable option history with a matching external checkpoint', async t => {
  const f = await fixture(t, { reasoningEffort: 'medium', responseFormat: 'json_object' });
  f.open(); f.close(); f.setClock(NOW + 1800000);
  f.price.verifiedAt = new Date(NOW + 1800000).toISOString(); f.price.expiresAt = new Date(NOW + 3600000).toISOString();
  await f.savePrice(); f.open(); f.close();
  const filename = path.join(f.harness.paths.ledger, 'ledger.json'), state = JSON.parse(await readFile(filename, 'utf8'));
  state.policyHistory[1].policy.reasoningEffort = 'low'; await writeFile(filename, bytes(state));
  const headFile = `${f.harness.paths.identity}.head.json`, head = JSON.parse(await readFile(headFile, 'utf8'));
  head.ledgerHash = sha(bytes(state)); await writeFile(headFile, bytes(head));
  const before = inventory(f.root);
  assert.equal(f.harness.preflight().code, 'LEDGER_INVALID'); assert.throws(f.open, { code: 'LEDGER_INVALID' });
  assert.deepEqual(inventory(f.root), before); assert.equal(f.stats.fakePosts, 0);
});

for (const [name, mutate, code] of [
  ['disabled grant', auth => { auth.granted = false; }, 'AUTHORIZATION_REQUIRED'],
  ['unknown field', auth => { auth.fetchImpl = true; }, 'INVALID_AUTHORIZATION'],
  ['wrong phase', auth => { auth.stageId = 'renamed-phase'; }, 'INVALID_AUTHORIZATION'],
  ['missing count', auth => { delete auth.maximumPosts; }, 'INVALID_AUTHORIZATION'],
  ['missing cash', auth => { auth.maximumSpendCny = null; }, 'INVALID_AUTHORIZATION'],
  ['forged human hash', auth => { auth.humanAuthorization.text += 'altered'; }, 'HUMAN_AUTHORIZATION_EVIDENCE_REQUIRED'],
  ['stale source', auth => { auth.productRevision = 'a'.repeat(64); }, 'SOURCE_REVISION_MISMATCH'],
  ['altered policy ceiling', auth => { auth.requestPolicy.maxOutputTokens = 512; }, 'REQUEST_POLICY_MISMATCH'],
]) test(`synthetic gate rejects ${name} without enrollment or dispatch`, async t => {
  const f = await fixture(t); mutate(f.auth); await f.saveAuth();
  assert.equal(f.harness.preflight().code, code);
  assert.throws(f.open, { code });
  assert.equal(fs.existsSync(f.harness.paths.ledger), false); assert.equal(f.stats.fakePosts, 0);
});

for (const [name, modify, code] of [
  ['byte hash drift', async f => { await writeFile(f.harness.paths.price, bytes(f.price) + ' '); }, 'PRICE_EVIDENCE_HASH_MISMATCH'],
  ['expired evidence', async f => { f.setClock(NOW + 1800000); }, 'PRICE_EVIDENCE_STALE'],
  ['non HTTPS source', async f => { f.price.sourceUrls = ['http://offline.invalid/pricing']; await f.savePrice(); }, 'INVALID_PRICE_EVIDENCE'],
  ['source edit', async f => { await writeFile(path.join(f.sourceRoot, 'src/source.mjs'), 'changed source'); }, 'SOURCE_REVISION_MISMATCH'],
  ['deadline', async f => { f.setClock(Date.parse(LIVE_DEADLINE)); }, 'EVENT_DEADLINE_PASSED'],
]) test(`synthetic gate rejects ${name} before stage creation`, async t => {
  const f = await fixture(t); await modify(f);
  assert.equal(f.harness.preflight().code, code); assert.throws(f.open, { code });
  assert.equal(fs.existsSync(f.harness.paths.identity), false); assert.equal(f.stats.fakePosts, 0);
});

test('synthetic gated execution reuses coordinator and freezes only OFFLINE_TRANSPORT evidence', async t => {
  const f = await fixture(t); const stage = f.open();
  const run = await createRun({ input: await sample(), mode: 'OFFLINE_TRANSPORT', runDirectory: stage.runDirectory, transport: stage.transport });
  const result = await run.start(); assert.equal(result.status, 'FINISHED'); assert.equal(f.stats.fakePosts, 4);
  assert.equal(result.counters.realGenerationPosts, 0); assert.equal(result.counters.fakeGenerationPosts, 4);
  assert.equal(result.fullSourceRevision, f.auth.productRevision);
  const bundle = await run.freeze(); assert.equal(bundle.mode, 'OFFLINE_TRANSPORT'); assert.equal(verifyFrozenBundle(bundle), true);
  assert.ok(bundle.snapshot.events.filter(event => event.type === 'POST_STARTED').every(event => event.transportKind === 'INJECTED_FAKE'));
});

test('same fixed ledger survives reopen and evidence renewal with no allowance restoration', async t => {
  const f = await fixture(t); let stage = f.open();
  const slot = stage.transport.budget.reserveBatch({ taskId: 'community-update', runId: 'synthetic-first', requests: [{ purpose: 'initial' }] })[0];
  await stage.transport.provider.generate({ reservationId: slot.id, messages: [{ role: 'user', content: JSON.stringify({ agentId: 'A', kind: 'facts', snapshot: { sources: [], proposal: {}, proposalVersion: 0, evidenceVersion: 0 } }) }] });
  const before = stage.transport.budget.inspect(); f.close();
  f.setClock(NOW + 1800000);
  f.price.verifiedAt = new Date(NOW + 1800000).toISOString(); f.price.expiresAt = new Date(NOW + 3600000).toISOString(); await f.savePrice();
  assert.equal(f.harness.preflight().status, 'PREFLIGHT_PASSED');
  stage = f.open(); const after = stage.transport.budget.inspect();
  assert.equal(after.reservedPosts, before.reservedPosts); assert.equal(after.remainingMicros, before.remainingMicros);
  assert.equal(after.policyRevision, 1); assert.equal(after.reservations[0].status, 'SUCCEEDED');
  stage.stop(); f.close(); assert.equal(f.harness.preflight().code, 'STAGE_HALTED');
  assert.throws(f.open, { code: 'STAGE_HALTED' }); assert.equal(f.stats.fakePosts, 1);
});

test('renamed ledger cannot enroll a replacement, even when authorization and price remain valid', async t => {
  const f = await fixture(t); f.open(); f.close();
  await rename(f.harness.paths.ledger, `${f.harness.paths.ledger}-renamed`);
  assert.equal(f.harness.preflight().code, 'LEDGER_IDENTITY_MISSING'); assert.throws(f.open, { code: 'LEDGER_IDENTITY_MISSING' });
  assert.equal(fs.existsSync(f.harness.paths.ledger), false);
});

test('restored older ledger is rejected by the external high-water checkpoint', async t => {
  const f = await fixture(t); const stage = f.open(); const filename = path.join(f.harness.paths.ledger, 'ledger.json');
  const old = await readFile(filename);
  stage.transport.budget.reserveBatch({ taskId: 'community-update', runId: 'synthetic-first', requests: [{ purpose: 'initial' }] });
  f.close(); await writeFile(filename, old);
  assert.equal(f.harness.preflight().code, 'LEDGER_CHECKPOINT_MISMATCH'); assert.throws(f.open, { code: 'LEDGER_CHECKPOINT_MISMATCH' });
});

test('external authorization binding rejects changed caps or human evidence across restarts', async t => {
  const f = await fixture(t); f.open(); f.close(); f.auth.maximumPosts++; await f.saveAuth();
  assert.equal(f.harness.preflight().code, 'AUTHORIZATION_CHANGED'); assert.throws(f.open, { code: 'AUTHORIZATION_CHANGED' });
});

test('source drift after reservation consumes held attempt and durably halts without a POST trace', async t => {
  const f = await fixture(t); const stage = f.open(), traces = [];
  const slot = stage.transport.budget.reserveBatch({ taskId: 'community-update', runId: 'synthetic-drift', requests: [{ purpose: 'initial' }] })[0];
  await writeFile(path.join(f.sourceRoot, 'src/new-file.mjs'), 'new source file');
  await assert.rejects(stage.transport.provider.generate({ reservationId: slot.id, messages: [{ role: 'user', content: '{}' }], onTrace: event => traces.push(event) }), { code: 'SOURCE_REVISION_MISMATCH' });
  assert.equal(f.stats.fakePosts, 0); assert.deepEqual(traces, []);
  const state = stage.transport.budget.inspect(); assert.equal(state.reservedPosts, 1); assert.equal(state.halted, true); assert.equal(state.reservations[0].status, 'FAILED');
});

test('deadline between reservation and send yields zero calls/traces and a durable consumed failure', async t => {
  const f = await fixture(t); const stage = f.open(), traces = [];
  const slot = stage.transport.budget.reserveBatch({ taskId: 'community-update', runId: 'synthetic-expiry', requests: [{ purpose: 'initial' }] })[0];
  // Keep budget price admission valid while crossing the official event deadline.
  // The final provider hook is tested below independently of time-based pre-admission.
  const original = stage.transport.budget.begin.bind(stage.transport.budget);
  stage.transport.budget.begin = id => { const result = original(id); f.setClock(Date.parse(LIVE_DEADLINE)); return result; };
  await assert.rejects(stage.transport.provider.generate({ reservationId: slot.id, messages: [{ role: 'user', content: '{}' }], onTrace: event => traces.push(event) }), { code: 'EVENT_DEADLINE_PASSED' });
  assert.equal(f.stats.fakePosts, 0); assert.deepEqual(traces, []);
  assert.equal(stage.transport.budget.inspect().halted, true); assert.equal(stage.transport.budget.inspect().reservedPosts, 1);
});

test('price-byte changes after enrollment stop dispatch without in-flight renewal or cap changes', async t => {
  const f = await fixture(t); const stage = f.open();
  const slot = stage.transport.budget.reserveBatch({ taskId: 'community-update', runId: 'synthetic-price-drift', requests: [{ purpose: 'initial' }] })[0];
  await writeFile(f.harness.paths.price, bytes(f.price) + ' ');
  await assert.rejects(stage.transport.provider.generate({ reservationId: slot.id, messages: [{ role: 'user', content: '{}' }] }), { code: 'PRICE_EVIDENCE_HASH_MISMATCH' });
  assert.equal(stage.transport.budget.inspect().halted, true); assert.equal(stage.transport.budget.inspect().policyRevision, 0); assert.equal(f.stats.fakePosts, 0);
});

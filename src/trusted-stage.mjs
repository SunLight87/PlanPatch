import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { StageBudget, RECOVERY_ID, validateRecoveryGrant, recoveryScheduling } from './budget.mjs';
import { createProvider } from './provider.mjs';
import { normalizeInput, deepFreeze } from './domain.mjs';

export const PHASE_ID = 'PLANPATCH_EVENT_MVP_20261030';
export const LIVE_DEADLINE = '2026-10-31T19:00:00Z';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Captured at module initialization, never supplied by a caller. This assumes a trusted
// Node runtime: same-account source edits/preloads are outside this local gate's boundary.
const nativeFetch = globalThis.fetch;
const capabilities = new WeakMap();
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const demand = (ok, code) => { if (!ok) fail(code); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const token = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const money = value => {
  demand(typeof value === 'string' && /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(value), 'INVALID_AUTHORIZATION');
  const [whole, fraction = ''] = value.split('.');
  const micros = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  demand(micros <= BigInt(Number.MAX_SAFE_INTEGER), 'INVALID_AUTHORIZATION');
  return Number(micros);
};
const POLICY_KEYS = ['endpoint', 'model', 'maxOutputTokens', 'maxRequestBytes', 'cashUpperBoundCny',
  'evidenceSha256', 'verifiedAt', 'expiresAt', 'coversAllBillableTokens', 'reasoningEffort', 'responseFormat'];
const BOUNDS = ['endpoint', 'model', 'maxOutputTokens', 'maxRequestBytes', 'cashUpperBoundCny', 'coversAllBillableTokens',
  'reasoningEffort', 'responseFormat'];

function paths(root) {
  const stage = path.join(root, 'var', 'trusted-event-mvp');
  return Object.freeze({ stage, authorization: path.join(stage, 'authorization.json'),
    price: path.join(stage, 'price-evidence.json'), ledger: path.join(stage, 'ledger'),
    identity: path.join(root, 'var', `${PHASE_ID}.identity.json`),
    binding: path.join(root, 'var', `${PHASE_ID}.identity.json.authorization.json`), runs: path.join(stage, 'runs'),
    recovery: path.join(stage, 'recoveries', `${RECOVERY_ID}.json`),
    recoveryPrice: path.join(stage, 'recoveries', `${RECOVERY_ID}.price.json`) });
}
export const TRUSTED_PATHS = paths(ROOT);

function plain(filename, directory = false) {
  const stat = fs.lstatSync(filename);
  const expected = path.resolve(filename), actual = fs.realpathSync(filename);
  demand(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile())
    && (process.platform === 'win32' ? actual.toLowerCase() === expected.toLowerCase() : actual === expected), 'UNSAFE_STAGE_PATH');
}
function read(filename, missingCode) {
  try { plain(filename); return fs.readFileSync(filename); }
  catch (error) { if (error.code === 'ENOENT') fail(missingCode); throw error; }
}
function json(bytes, code) { try { return JSON.parse(bytes.toString('utf8')); } catch { fail(code); } }
function exists(filename) { try { fs.lstatSync(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }

/** Exact same complete source set/encoding as scripts/revision.mjs, synchronously
 * checked immediately before every dispatch (including additions/removals). */
export function trustedSourceRevision(sourceRoot = ROOT) {
  const files = ['package.json', 'package-lock.json', 'server.mjs', 'CONTRACT.md'];
  function walk(directory) {
    plain(path.join(sourceRoot, directory), true);
    for (const item of fs.readdirSync(path.join(sourceRoot, directory), { withFileTypes: true })) {
      const relative = `${directory}/${item.name}`;
      if (item.isDirectory()) walk(relative);
      else { demand(item.isFile() && !item.isSymbolicLink(), 'UNSAFE_SOURCE_PATH'); files.push(relative); }
    }
  }
  for (const dir of ['src', 'public', 'samples', 'scripts', 'test']) walk(dir);
  files.sort(); const hashes = {};
  for (const file of files) hashes[file] = sha(read(path.join(sourceRoot, file), 'SOURCE_REVISION_UNAVAILABLE'));
  return sha(JSON.stringify(hashes));
}
function dates(policy, now, fresh) {
  const checked = Date.parse(policy.verifiedAt), expiry = Date.parse(policy.expiresAt);
  demand(typeof policy.verifiedAt === 'string' && typeof policy.expiresAt === 'string'
    && Number.isFinite(checked) && Number.isFinite(expiry) && expiry > checked && expiry - checked <= 1800000
    && (!fresh || (now >= checked && now < expiry)), 'PRICE_EVIDENCE_STALE');
}
function policy(value) {
  demand(exact(value, POLICY_KEYS) && hex(value.evidenceSha256) && value.coversAllBillableTokens === true
    && [null, 'low', 'medium', 'xhigh', 'none'].includes(value.reasoningEffort)
    && [null, 'json_object'].includes(value.responseFormat), 'INVALID_PRICE_POLICY');
  let endpoint; try { endpoint = new URL(value.endpoint); } catch { fail('INVALID_PRICE_POLICY'); }
  demand(endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash
    && endpoint.href === value.endpoint && endpoint.pathname.endsWith('/chat/completions')
    && typeof value.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(value.model)
    && Number.isSafeInteger(value.maxOutputTokens) && value.maxOutputTokens > 0 && value.maxOutputTokens <= 1024
    && Number.isSafeInteger(value.maxRequestBytes) && value.maxRequestBytes >= 128 && value.maxRequestBytes <= 1048576,
  'INVALID_PRICE_POLICY');
  money(value.cashUpperBoundCny); dates(value, 0, false);
}
function validateAuthorization(auth, context) {
  demand(auth?.granted === true, 'AUTHORIZATION_REQUIRED');
  demand(exact(auth, ['schemaVersion', 'kind', 'granted', 'synthetic', 'id', 'stageId', 'currency', 'maximumSpendCny',
    'maximumPosts', 'allowedTaskIds', 'productRevision', 'deadline', 'recordedAt', 'humanAuthorization', 'requestPolicy'])
    && auth.schemaVersion === 1 && auth.kind === (context.test ? 'SYNTHETIC_TEST_AUTHORIZATION' : 'RECORDED_USER_AUTHORIZATION')
    && auth.synthetic === context.test && auth.id === PHASE_ID && auth.stageId === PHASE_ID && auth.currency === 'CNY'
    && auth.deadline === LIVE_DEADLINE && Number.isSafeInteger(auth.maximumPosts) && auth.maximumPosts > 0 && auth.maximumPosts <= 100000
    && Array.isArray(auth.allowedTaskIds) && auth.allowedTaskIds.length > 0 && auth.allowedTaskIds.every(token)
    && new Set(auth.allowedTaskIds).size === auth.allowedTaskIds.length && hex(auth.productRevision), 'INVALID_AUTHORIZATION');
  demand(money(auth.maximumSpendCny) >= 0, 'INVALID_AUTHORIZATION');
  const human = auth.humanAuthorization;
  demand(exact(human, ['reference', 'text', 'sha256']) && typeof human.reference === 'string' && human.reference.trim().length > 0
    && human.reference.length <= 2048 && typeof human.text === 'string' && human.text.trim().length > 0 && human.text.length <= 32000
    && hex(human.sha256) && sha(human.text) === human.sha256, 'HUMAN_AUTHORIZATION_EVIDENCE_REQUIRED');
  demand(typeof auth.recordedAt === 'string' && Number.isFinite(Date.parse(auth.recordedAt)) && Date.parse(auth.recordedAt) <= context.now(), 'INVALID_AUTHORIZATION');
  policy(auth.requestPolicy);
  if (context.test) demand(new URL(auth.requestPolicy.endpoint).hostname === 'offline.invalid', 'TEST_HARNESS_REJECTED');
  // Existence only defers this check. The immutable original binding plus the
  // complete recovery record/checkpoint must still validate before admission.
  demand(auth.productRevision === trustedSourceRevision(context.sourceRoot) || exists(context.paths.recovery), 'SOURCE_REVISION_MISMATCH');
}
function checkedPrice(context, auth, filename = context.paths.price) {
  const bytes = read(filename, 'PRICE_EVIDENCE_MISSING'), record = json(bytes, 'INVALID_PRICE_EVIDENCE');
  demand(exact(record, ['schemaVersion', 'kind', 'synthetic', 'currency', 'verifiedAt', 'expiresAt', 'sourceUrls', 'endpoint',
    'model', 'maxOutputTokens', 'maxRequestBytes', 'cashUpperBoundCny', 'coversAllBillableTokens', 'basis', 'notes',
    'reasoningEffort', 'responseFormat'])
    && record.schemaVersion === 1 && record.kind === 'OFFICIAL_PRICE_CHECK' && record.synthetic === context.test
    && record.currency === 'CNY' && ['CASH_FULL_REQUEST', 'VERIFIED_FREE'].includes(record.basis)
    && typeof record.notes === 'string' && record.notes.trim().length > 0
    && Array.isArray(record.sourceUrls) && record.sourceUrls.length > 0 && record.sourceUrls.every(value => {
      try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash; } catch { return false; }
    }), 'INVALID_PRICE_EVIDENCE');
  const result = Object.fromEntries(POLICY_KEYS.map(key => [key, key === 'evidenceSha256' ? sha(bytes) : record[key]]));
  policy(result); dates(result, context.now(), true);
  demand(BOUNDS.every(key => result[key] === auth.requestPolicy[key]), 'REQUEST_POLICY_MISMATCH');
  demand(record.basis !== 'VERIFIED_FREE' || money(result.cashUpperBoundCny) === 0, 'INVALID_PRICE_EVIDENCE');
  return result;
}
function ledgerState(context, { activation = false } = {}) {
  const p = context.paths, files = [p.identity, `${p.identity}.head.json`, path.join(p.ledger, 'ledger.json'), p.binding];
  const present = files.map(exists);
  demand(present.every(Boolean) || present.every(value => !value), 'LEDGER_IDENTITY_MISSING');
  if (exists(p.ledger)) plain(p.ledger, true);
  demand(!exists(path.join(p.ledger, 'stage.lock')), 'STAGE_LOCKED');
  if (!present[0]) { demand(!exists(p.ledger), 'LEDGER_IDENTITY_MISSING'); return null; }
  const identity = json(read(files[0]), 'LEDGER_INVALID'), head = json(read(files[1]), 'LEDGER_INVALID');
  const bytes = read(files[2]), state = json(bytes, 'LEDGER_INVALID');
  demand(identity.authorizationHash === state.authorizationHash && head.authorizationHash === state.authorizationHash
    && head.revision === state.revision && head.ledgerHash === sha(bytes), 'LEDGER_CHECKPOINT_MISMATCH');
  demand(typeof state.halted === 'boolean', 'LEDGER_INVALID');
  const recovery = recoveryScheduling(state);
  demand(activation || !(recovery?.epoch.halted ?? state.halted), 'STAGE_HALTED');
  demand(Array.isArray(state.reservations) && !state.reservations.some(item => ['HELD', 'IN_FLIGHT'].includes(item.status)), 'UNSETTLED_RESERVATIONS');
  return state;
}
function normalizedBudgetAuthorization(context, auth) {
  const p = auth.requestPolicy;
  return { id: auth.id, stageId: auth.stageId, currency: 'CNY', maximumMicros: money(auth.maximumSpendCny),
    maximumPosts: auth.maximumPosts, allowedTaskIds: [...auth.allowedTaskIds].sort(), ledgerDirectory: context.paths.ledger,
    identityFile: context.paths.identity, requestPolicy: { endpoint: p.endpoint, model: p.model,
      maxOutputTokens: p.maxOutputTokens, maxRequestBytes: p.maxRequestBytes, cashUpperBoundMicros: money(p.cashUpperBoundCny),
      evidenceSha256: p.evidenceSha256, verifiedAt: p.verifiedAt, expiresAt: p.expiresAt, coversAllBillableTokens: true,
      reasoningEffort: p.reasoningEffort, responseFormat: p.responseFormat } };
}
function readonlyAdmission(context, auth, state, taskId) {
  const normalized = normalizedBudgetAuthorization(context, auth), cost = normalized.requestPolicy.cashUpperBoundMicros;
  const reservations = state?.reservations ?? [];
  if (state) {
    const recovery = recoveryScheduling(state);
    demand(state.schemaVersion === 1 && Number.isSafeInteger(state.revision) && state.revision >= 0
      && state.authorizationHash === sha(JSON.stringify(normalized))
      && (recovery ? state.haltCode === 'TIMEOUT' : state.haltCode === null), 'LEDGER_INVALID');
    const ids = new Set();
    for (const [index, item] of reservations.entries()) {
      demand(typeof item.id === 'string' && /^[a-f0-9-]{36}$/.test(item.id) && !ids.has(item.id)
        && auth.allowedTaskIds.includes(item.taskId) && token(item.runId)
        && (recovery && index < 3 ? ['FAILED', 'INCOMPLETE'].includes(item.status) : item.status === 'SUCCEEDED')
        && ['generation', 'initial', 'draft', 'revision', 'mandatory_recheck', 'targeted_analysis'].includes(item.purpose)
        && item.cashUpperBoundMicros === cost, 'LEDGER_INVALID');
      ids.add(item.id);
    }
    const history = state.policyHistory ?? [{ revision: 0, policy: normalized.requestPolicy }];
    demand(Array.isArray(history) && history.length > 0 && history.length <= state.revision + 1, 'LEDGER_INVALID');
    const hashes = new Set();
    for (const [index, entry] of history.entries()) {
      const p = entry.policy;
      demand(entry.revision === index && exact(p, Object.keys(normalized.requestPolicy))
        && ['endpoint', 'model', 'maxOutputTokens', 'maxRequestBytes', 'cashUpperBoundMicros', 'coversAllBillableTokens',
          'reasoningEffort', 'responseFormat']
          .every(key => p[key] === normalized.requestPolicy[key]) && hex(p.evidenceSha256) && !hashes.has(p.evidenceSha256), 'LEDGER_INVALID');
      dates(p, 0, false); hashes.add(p.evidenceSha256);
      demand(index === 0 ? JSON.stringify(p) === JSON.stringify(normalized.requestPolicy)
        : Date.parse(p.verifiedAt) > Date.parse(history[index - 1].policy.verifiedAt)
          && Date.parse(p.expiresAt) > Date.parse(history[index - 1].policy.expiresAt), 'LEDGER_INVALID');
    }
    demand(reservations.every(item => item.policyRevision === undefined || Number.isSafeInteger(item.policyRevision)
      && item.policyRevision >= 0 && item.policyRevision < history.length), 'LEDGER_INVALID');
    demand(auth.allowedTaskIds.every(id => reservations.filter(item => item.taskId === id).length <= 8), 'LEDGER_INVALID');
    if (recovery) demand(recovery.epoch.runId === null && recovery.remainingPosts === 4
      && (taskId === undefined || taskId === recovery.grant.allowedTaskId), 'RECOVERY_RUN_LIMIT');
  }
  demand(reservations.length + 3 <= auth.maximumPosts && Number.isSafeInteger((reservations.length + 3) * cost)
    && (reservations.length + 3) * cost <= normalized.maximumMicros
    && (taskId === undefined || reservations.filter(item => item.taskId === taskId).length + 3 <= 8), 'STAGE_ADMISSION_REJECTED');
}

function budgetAuthorization(context, auth) {
  return { granted: true, id: auth.id, stageId: auth.stageId, currency: auth.currency,
    maximumSpendCny: auth.maximumSpendCny, maximumPosts: auth.maximumPosts, allowedTaskIds: auth.allowedTaskIds,
    ledgerDirectory: context.paths.ledger, identityFile: context.paths.identity, requestPolicy: auth.requestPolicy };
}
function checkedRecovery(context, auth, authorizationBytes, state, activation = false) {
  const raw = read(context.paths.recovery, 'RECOVERY_GRANT_MISSING');
  const grant = json(raw, 'INVALID_RECOVERY_GRANT'); validateRecoveryGrant(grant);
  demand(grant.synthetic === context.test && grant.kind === (context.test ? 'SYNTHETIC_TEST_RECOVERY' : 'RECORDED_USER_RECOVERY')
    && grant.stageId === PHASE_ID && grant.originalAuthorizationSha256 === sha(authorizationBytes)
    && grant.fromSourceRevision === auth.productRevision && grant.toSourceRevision === trustedSourceRevision(context.sourceRoot)
    && grant.maximumSpendCny === auth.maximumSpendCny && grant.maximumPosts === auth.maximumPosts
    && auth.allowedTaskIds.includes(grant.allowedTaskId) && grant.deadline === LIVE_DEADLINE
    && Date.parse(grant.recordedAt) >= Date.parse(auth.recordedAt) && Date.parse(grant.recordedAt) <= context.now()
    && context.now() < Date.parse(grant.deadline)
    && BOUNDS.every(key => grant.requestBounds[key] === auth.requestPolicy[key]), 'RECOVERY_POLICY_MISMATCH');
  demand(context.test || grant.requestBounds.model === 'Qwen3.8-Flash-Next', 'RECOVERY_POLICY_MISMATCH');
  demand(state && state.authorizationHash === sha(JSON.stringify(normalizedBudgetAuthorization(context, auth)))
    && json(read(context.paths.binding), 'AUTHORIZATION_BINDING_INVALID').authorizationSha256 === sha(authorizationBytes),
  'AUTHORIZATION_CHANGED');
  const cp = grant.expectedCheckpoint, identityBytes = read(context.paths.identity), hash = sha(raw);
  let baseBytes, headBytes;
  if (activation) {
    demand(state.recoveryHistory === undefined && state.schedulingEpoch === undefined, 'RECOVERY_ALREADY_USED');
    demand(state.halted === true && state.haltCode === 'TIMEOUT', 'RECOVERY_CHECKPOINT_MISMATCH');
    baseBytes = read(path.join(context.paths.ledger, 'ledger.json')); headBytes = read(`${context.paths.identity}.head.json`);
  } else {
    const recovery = recoveryScheduling(state);
    demand(recovery && recovery.grantSha256 === hash && JSON.stringify(recovery.grant) === JSON.stringify(grant), 'RECOVERY_GRANT_CHANGED');
    baseBytes = read(path.join(context.paths.ledger, 'recovery-base-ledger.json'), 'RECOVERY_SNAPSHOT_MISSING');
    headBytes = read(path.join(context.paths.ledger, 'recovery-base-head.json'), 'RECOVERY_SNAPSHOT_MISSING');
  }
  const base = json(baseBytes, 'LEDGER_INVALID'), head = json(headBytes, 'LEDGER_INVALID');
  demand(sha(baseBytes) === cp.ledgerSha256 && sha(headBytes) === cp.headSha256 && sha(identityBytes) === cp.identitySha256
    && base.revision === cp.revision && base.authorizationHash === state.authorizationHash
    && head.revision === cp.revision && head.ledgerHash === cp.ledgerSha256 && head.authorizationHash === state.authorizationHash
    && base.halted === true && base.haltCode === 'TIMEOUT' && Array.isArray(base.reservations) && base.reservations.length === 3
    && sha(JSON.stringify(base.reservations)) === grant.historicalReservationsSha256
    && sha(JSON.stringify(state.reservations.slice(0, 3))) === grant.historicalReservationsSha256
    && base.reservations[0].status === 'FAILED' && base.reservations[1].status === 'FAILED'
    && base.reservations[2].status === 'INCOMPLETE', 'RECOVERY_CHECKPOINT_MISMATCH');
  const currentPolicy = checkedPrice(context, auth, context.paths.recoveryPrice);
  demand(currentPolicy.evidenceSha256 === grant.freshPriceSha256, 'PRICE_EVIDENCE_HASH_MISMATCH');
  const previous = base.policyHistory?.at(-1)?.policy ?? normalizedBudgetAuthorization(context, auth).requestPolicy;
  demand(Date.parse(currentPolicy.verifiedAt) > Date.parse(previous.verifiedAt)
    && Date.parse(currentPolicy.expiresAt) > Date.parse(previous.expiresAt), 'PRICE_EVIDENCE_NOT_ADVANCING');
  return { grant, grantSha256: hash, currentPolicy };
}
function evaluate(context, taskId) {
  // Authorization is intentionally the first file read; absent authorization must
  // block even when no task is selected, without credentials, ledger or price reads.
  const authorizationBytes = read(context.paths.authorization, 'AUTHORIZATION_MISSING');
  const auth = json(authorizationBytes, 'INVALID_AUTHORIZATION');
  validateAuthorization(auth, context);
  demand(context.now() < Date.parse(LIVE_DEADLINE), 'EVENT_DEADLINE_PASSED');
  if (taskId !== undefined) demand(token(taskId) && auth.allowedTaskIds.includes(taskId), 'TASK_NOT_AUTHORIZED');
  const state = ledgerState(context);
  if (state) demand(json(read(context.paths.binding), 'AUTHORIZATION_BINDING_INVALID').authorizationSha256 === sha(authorizationBytes), 'AUTHORIZATION_CHANGED');
  const recovery = state?.recoveryHistory ? checkedRecovery(context, auth, authorizationBytes, state) : null;
  // A pending record cannot migrate source or unlock halt by merely existing.
  demand(recovery || auth.productRevision === trustedSourceRevision(context.sourceRoot), 'SOURCE_REVISION_MISMATCH');
  const currentPolicy = recovery?.currentPolicy ?? checkedPrice(context, auth);
  const previous = state ? state.policyHistory?.at(-1)?.policy ?? normalizedBudgetAuthorization(context, auth).requestPolicy : undefined;
  if (!state) {
    demand(currentPolicy.evidenceSha256 === auth.requestPolicy.evidenceSha256
      && currentPolicy.verifiedAt === auth.requestPolicy.verifiedAt && currentPolicy.expiresAt === auth.requestPolicy.expiresAt, 'PRICE_EVIDENCE_HASH_MISMATCH');
    dates(auth.requestPolicy, context.now(), true);
  }
  else if (previous) {
    demand(currentPolicy.evidenceSha256 === previous.evidenceSha256
      ? currentPolicy.verifiedAt === previous.verifiedAt && currentPolicy.expiresAt === previous.expiresAt
      : Date.parse(currentPolicy.verifiedAt) > Date.parse(previous.verifiedAt) && Date.parse(currentPolicy.expiresAt) > Date.parse(previous.expiresAt), 'PRICE_EVIDENCE_NOT_ADVANCING');
  }
  readonlyAdmission(context, auth, state, taskId);
  let selectedInput;
  for (const id of taskId === undefined ? auth.allowedTaskIds : [taskId]) {
    const raw = json(read(path.join(context.sourceRoot, 'samples', `${id}.json`), 'TASK_SAMPLE_MISSING'), 'TASK_SAMPLE_INVALID');
    demand(raw.id === id, 'TASK_SAMPLE_ID_MISMATCH');
    let normalized;
    try { normalized = normalizeInput(raw); } catch { fail('TASK_SAMPLE_INVALID'); }
    if (id === taskId) selectedInput = normalized;
  }
  return { auth, currentPolicy, input: selectedInput, authorizationHash: sha(authorizationBytes), recovery,
    effectiveSourceRevision: recovery?.grant.toSourceRevision ?? auth.productRevision };
}
const production = () => ({ paths: TRUSTED_PATHS, sourceRoot: ROOT, now: Date.now, test: false });
function options(value, allowed) { demand(value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => allowed.includes(key)), 'INVALID_LIVE_OPTIONS'); }
function inspect(context, { taskId } = {}) {
  try {
    const { auth, effectiveSourceRevision, recovery } = evaluate(context, taskId);
    return { status: 'PREFLIGHT_PASSED', code: 'EXPLICIT_SEND_REQUIRED', phaseId: PHASE_ID, productRevision: effectiveSourceRevision,
      ...(recovery ? { recoveryId: recovery.grant.id, recoverySha256: recovery.grantSha256, timeoutMs: recovery.grant.timeoutMs,
        plannedMaximumNewPosts: 4, historicalReservations: 3, historicalHalt: 'TIMEOUT' } : {}),
      taskIds: [...auth.allowedTaskIds], requestOptions: { reasoningEffort: auth.requestPolicy.reasoningEffort,
        responseFormat: auth.requestPolicy.responseFormat }, readOnly: true, realGenerationPosts: 0, liveAcceptance: 'NOT_RUN',
      trustBoundary: 'Recorded human authorization and official-price provenance require human verification.' };
  } catch (error) { return { status: 'BLOCKED', code: error.code ?? 'PREFLIGHT_FAILED', phaseId: PHASE_ID,
    readOnly: true, realGenerationPosts: 0, liveAcceptance: 'NOT_RUN' }; }
}
export function preflightLive(optionsValue = {}) { options(optionsValue, ['taskId']); return inspect(production(), optionsValue); }

function evaluateRecovery(context) {
  const authorizationBytes = read(context.paths.authorization, 'AUTHORIZATION_MISSING');
  const auth = json(authorizationBytes, 'INVALID_AUTHORIZATION'); validateAuthorization(auth, context);
  demand(context.now() < Date.parse(LIVE_DEADLINE), 'EVENT_DEADLINE_PASSED');
  const state = ledgerState(context, { activation: true });
  const recovery = checkedRecovery(context, auth, authorizationBytes, state, true);
  demand(state.reservations.length + 4 <= auth.maximumPosts
    && state.reservations.every(r => r.cashUpperBoundMicros === money(auth.requestPolicy.cashUpperBoundCny))
    && (state.reservations.length + 4) * money(auth.requestPolicy.cashUpperBoundCny) <= money(auth.maximumSpendCny)
    && state.reservations.filter(r => r.taskId === recovery.grant.allowedTaskId).length + 4 <= 8, 'STAGE_ADMISSION_REJECTED');
  demand(!exists(path.join(context.paths.ledger, 'recovery-base-ledger.json'))
    && !exists(path.join(context.paths.ledger, 'recovery-base-head.json')), 'RECOVERY_ACTIVATION_INCOMPLETE');
  return { auth, authorizationBytes, ...recovery };
}
function inspectRecovery(context) {
  try {
    const { grant, grantSha256 } = evaluateRecovery(context);
    return { status: 'RECOVERY_PREFLIGHT_PASSED', code: 'EXPLICIT_ACTIVATION_REQUIRED', readOnly: true,
      phaseId: PHASE_ID, recoveryId: grant.id, recoverySha256: grantSha256, productRevision: grant.toSourceRevision,
      retainedReservations: 3, maximumNewPosts: 4, timeoutMs: 120000, realGenerationPosts: 0 };
  } catch (error) { return { status: 'BLOCKED', code: error.code ?? 'RECOVERY_PREFLIGHT_FAILED', readOnly: true,
    phaseId: PHASE_ID, realGenerationPosts: 0 }; }
}
function activateRecovery(context, optionsValue) {
  options(optionsValue, ['activate']); demand(optionsValue.activate === true, 'EXPLICIT_ACTIVATION_REQUIRED');
  const validated = evaluateRecovery(context), { auth, authorizationBytes, grant, grantSha256, currentPolicy } = validated;
  // No credential lookup or transport construction exists on this path.
  const budget = StageBudget.open({ authorization: budgetAuthorization(context, auth), now: context.now });
  try {
    demand(sha(read(context.paths.authorization)) === sha(authorizationBytes), 'AUTHORIZATION_CHANGED');
    demand(trustedSourceRevision(context.sourceRoot) === grant.toSourceRevision, 'SOURCE_REVISION_MISMATCH');
    demand(sha(read(context.paths.recovery)) === grantSha256, 'RECOVERY_GRANT_CHANGED');
    demand(checkedPrice(context, auth, context.paths.recoveryPrice).evidenceSha256 === currentPolicy.evidenceSha256,
      'PRICE_EVIDENCE_HASH_MISMATCH');
    const state = budget.activateRecovery({ grant, grantSha256, currentPolicy });
    return { status: 'RECOVERY_ACTIVATED', phaseId: PHASE_ID, recoveryId: grant.id, recoverySha256: grantSha256,
      productRevision: grant.toSourceRevision, retainedReservations: 3, reservedPosts: state.reservedPosts,
      maximumNewPosts: 4, timeoutMs: 120000, historicalHalt: state.historicalHalt, realGenerationPosts: 0,
      liveAcceptance: 'NOT_RUN', readyToSubmit: false };
  } finally { budget.close(); }
}
export function preflightTrustedRecovery(optionsValue = {}) {
  options(optionsValue, []); return inspectRecovery(production());
}
export function activateTrustedRecovery(optionsValue = {}) { return activateRecovery(production(), optionsValue); }

function open(context, { send, taskId }, fetchImpl, credential) {
  demand(send === true, 'EXPLICIT_SEND_REQUIRED');
  const validated = evaluate(context, taskId), { auth, currentPolicy, authorizationHash, effectiveSourceRevision, recovery } = validated;
  demand(taskId !== undefined, 'TASK_REQUIRED');
  plain(path.dirname(context.paths.stage), true); plain(context.paths.stage, true);
  // Configuration absence is not a generation failure. All read-only gates and
  // admission precede the sole lookup; no lock/identity/ledger is created on absence.
  demand(context.now() < Date.parse(LIVE_DEADLINE), 'EVENT_DEADLINE_PASSED');
  demand(typeof fetchImpl === 'function', 'NATIVE_FETCH_UNAVAILABLE');
  const apiKey = credential();
  demand(typeof apiKey === 'string' && /^[A-Za-z0-9._~+/-]{16,512}={0,2}$/.test(apiKey), 'API_KEY_MISSING_OR_INVALID');
  const budgetAuth = budgetAuthorization(context, auth);
  const firstEnrollment = !exists(context.paths.identity);
  const budget = StageBudget.open({ authorization: budgetAuth, now: context.now });
  let closed = false;
  try {
    if (firstEnrollment) {
      const fd = fs.openSync(context.paths.binding, 'wx', 0o600);
      try { fs.writeFileSync(fd, `${JSON.stringify({ schemaVersion: 1, authorizationSha256: authorizationHash })}\n`); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    }
    if (budget.requestPolicy.evidenceSha256 !== currentPolicy.evidenceSha256) budget.refreshPriceEvidence(currentPolicy);
    const state = budget.inspect();
    demand(!state.halted, 'STAGE_HALTED');
    if (recovery) demand(state.remainingPosts >= 4 && state.recovery.remainingPosts === 4
      && state.remainingMicros >= money(auth.requestPolicy.cashUpperBoundCny) * 4, 'STAGE_ADMISSION_REJECTED');
    demand(state.remainingPosts >= 3 && state.remainingMicros >= money(auth.requestPolicy.cashUpperBoundCny) * 3
      && state.reservations.filter(item => item.taskId === taskId).length + 3 <= 8, 'STAGE_ADMISSION_REJECTED');
    const beforeDispatch = () => {
      demand(!closed, 'STAGE_CLOSED');
      demand(context.now() < Date.parse(LIVE_DEADLINE), 'EVENT_DEADLINE_PASSED');
      demand(sha(read(context.paths.authorization, 'AUTHORIZATION_MISSING')) === authorizationHash, 'AUTHORIZATION_CHANGED');
      demand(effectiveSourceRevision === trustedSourceRevision(context.sourceRoot), 'SOURCE_REVISION_MISMATCH');
      const next = recovery ? checkedRecovery(context, auth, read(context.paths.authorization),
        json(read(path.join(context.paths.ledger, 'ledger.json')), 'LEDGER_INVALID')).currentPolicy : checkedPrice(context, auth);
      const current = budget.requestPolicy;
      demand(next.evidenceSha256 === current.evidenceSha256, 'PRICE_EVIDENCE_HASH_MISMATCH');
      demand(!budget.inspect().halted, 'STAGE_HALTED');
      demand(context.now() < Date.parse(LIVE_DEADLINE), 'EVENT_DEADLINE_PASSED');
    };
    // Fresh authoritative lock/ledger/admission checks fence races since preflight.
    beforeDispatch();
    const provider = createProvider({ budget, endpoint: currentPolicy.endpoint, model: currentPolicy.model, apiKey,
      fetchImpl, beforeSend: beforeDispatch, notAfter: Date.parse(LIVE_DEADLINE), now: context.now,
      timeoutMs: recovery?.grant.timeoutMs ?? 30000 });
    const runDirectory = path.join(context.paths.runs, randomUUID());
    const transport = Object.freeze({ ...(context.test ? { offline: true } : {}), budget, provider, taskId,
      beforeDispatch, fullSourceRevision: effectiveSourceRevision,
      ...(recovery ? { recovery: { id: recovery.grant.id, grantSha256: recovery.grantSha256, epoch: 1, maximumNewPosts: 4, timeoutMs: 120000 } } : {}) });
    if (!context.test) capabilities.set(transport, { runDirectory, taskId, fullSourceRevision: effectiveSourceRevision });
    return Object.freeze({ transport, runDirectory, input: deepFreeze(validated.input), productRevision: effectiveSourceRevision,
      recovery: transport.recovery ?? null,
      close() { if (!closed) { capabilities.delete(transport); budget.close(); closed = true; } },
      stop() { if (!closed) budget.stop(); } });
  } catch (error) {
    try { budget.stop(); } finally { budget.close(); }
    throw error;
  }
}
export function openTrustedStage(optionsValue = {}) {
  options(optionsValue, ['send', 'taskId']);
  return open(production(), optionsValue, nativeFetch, () => process.env.PLANPATCH_API_KEY);
}
export function validateTrustedLiveTransport(transport, { runDirectory, inputId }) {
  const capability = capabilities.get(transport);
  demand(capability && capability.runDirectory === runDirectory && capability.taskId === inputId, 'LIVE_DISABLED_NO_AUTHORIZATION');
  transport.beforeDispatch();
  return capability.fullSourceRevision;
}

/** Deliberately separate, temp-only synthetic harness. It cannot mint LIVE capability,
 * access production paths/environment, or accept a genuine authorization. */
export function createSyntheticStageHarness({ root, sourceRoot = ROOT, now, fetchImpl,
  credential = () => 'synthetic_not_a_real_credential_12345' } = {}) {
  const resolved = path.resolve(root ?? '.');
  demand(path.dirname(resolved).toLowerCase() === path.resolve(tmpdir()).toLowerCase()
    && path.basename(resolved).startsWith('planpatch-live-test-') && typeof now === 'function' && typeof fetchImpl === 'function'
    && typeof credential === 'function', 'TEST_HARNESS_REJECTED');
  plain(resolved, true);
  const context = { paths: paths(resolved), sourceRoot, now, test: true };
  return Object.freeze({ paths: context.paths, preflight: opts => inspect(context, opts),
    preflightRecovery: () => inspectRecovery(context),
    activateRecovery: opts => activateRecovery(context, opts),
    open(opts) { options(opts, ['send', 'taskId']); return open(context, opts, fetchImpl, credential); } });
}

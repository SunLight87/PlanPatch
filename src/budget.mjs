import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// No defaults grant permission. Callers must supply a new, explicit stage authorization.
// One owner holds the stage lock for its lifetime; a crashed owner's lock is never reclaimed.
export const BUDGET_LIMITS = Object.freeze({ perTaskPosts: 8, inFlightPosts: 3 });
const SCALE = 1_000_000; // Exact integer micro-CNY, not floating point running totals.
const PURPOSES = new Set(['generation', 'initial', 'draft', 'revision', 'mandatory_recheck', 'targeted_analysis']);
const STATES = new Set(['HELD', 'IN_FLIGHT', 'SUCCEEDED', 'FAILED', 'INCOMPLETE']);
const FAILURES = new Set(['GENERATION_FAILURE', 'HTTP_FAILURE', 'TIMEOUT', 'NETWORK_ERROR', 'ABORTED',
  'BODY_LIMIT', 'INVALID_RESPONSE', 'MODEL_MISMATCH', 'INCOMPLETE_RESPONSE', 'INVALID_AGENT_OUTPUT', 'STAGE_STOPPED', 'UNSETTLED_RESERVATIONS']);
const sha = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => record(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const token = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const equalPath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

export class BudgetError extends Error {
  constructor(code) { super(code); this.name = 'BudgetError'; this.code = code; }
}
function demand(ok, code) { if (!ok) throw new BudgetError(code); }
function money(value) {
  demand((typeof value === 'number' || typeof value === 'string') && /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(String(value)), 'INVALID_CNY_AMOUNT');
  const [whole, fraction = ''] = String(value).split('.');
  const micros = BigInt(whole) * BigInt(SCALE) + BigInt(fraction.padEnd(6, '0'));
  demand(micros <= BigInt(Number.MAX_SAFE_INTEGER), 'INVALID_CNY_AMOUNT');
  return Number(micros);
}
function normalizedEndpoint(value) {
  demand(typeof value === 'string' && value.length <= 1024, 'INVALID_ENDPOINT');
  let url;
  try { url = new URL(value); } catch { throw new BudgetError('INVALID_ENDPOINT'); }
  demand(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
    && url.href === value && url.pathname.endsWith('/chat/completions'), 'INVALID_ENDPOINT');
  return value;
}
function absoluteFile(value) {
  demand(typeof value === 'string' && path.isAbsolute(value) && path.basename(value) !== '.', 'INVALID_LEDGER_PATH');
  return path.resolve(value);
}
function existingPlainPath(filename, directory) {
  const stat = fs.lstatSync(filename);
  demand(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()), 'UNSAFE_LEDGER_PATH');
  demand(equalPath(fs.realpathSync(filename), path.resolve(filename)), 'UNSAFE_LEDGER_PATH');
}
function isMissing(filename) {
  try { fs.lstatSync(filename); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
function flushDirectory(directory) {
  // Windows does not expose a portable directory fsync through node:fs. Files are fsynced.
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function exclusiveWrite(filename, bytes) {
  const fd = fs.openSync(filename, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  flushDirectory(path.dirname(filename));
}
function validatePolicyDates(policy) {
  const checked = Date.parse(policy.verifiedAt), expires = Date.parse(policy.expiresAt);
  demand(typeof policy.verifiedAt === 'string' && typeof policy.expiresAt === 'string'
    && Number.isFinite(checked) && Number.isFinite(expires) && expires > checked
    && expires - checked <= 30 * 60 * 1000, 'PRICE_EVIDENCE_STALE');
}
function validatePolicyTime(policy, now) {
  validatePolicyDates(policy);
  demand(Number.isFinite(now) && now >= Date.parse(policy.verifiedAt) && now < Date.parse(policy.expiresAt), 'PRICE_EVIDENCE_STALE');
}
function requestOptions(policy) {
  const hasReasoning = Object.hasOwn(policy, 'reasoningEffort'), hasFormat = Object.hasOwn(policy, 'responseFormat');
  demand(hasReasoning === hasFormat, 'INVALID_REQUEST_OPTIONS');
  if (!hasReasoning) return {}; // Preserve legacy normalized keys and authorization hashes.
  demand([null, 'low', 'medium', 'xhigh', 'none'].includes(policy.reasoningEffort)
    && [null, 'json_object'].includes(policy.responseFormat), 'INVALID_REQUEST_OPTIONS');
  // null deliberately omits the wire field; it does not mean disabled reasoning.
  return { reasoningEffort: policy.reasoningEffort, responseFormat: policy.responseFormat };
}
function requestPolicyConfig(policy) {
  demand(record(policy) && /^[a-f0-9]{64}$/.test(policy.evidenceSha256) && policy.coversAllBillableTokens === true, 'PRICE_EVIDENCE_REQUIRED');
  demand(typeof policy.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(policy.model), 'INVALID_MODEL');
  demand(Number.isSafeInteger(policy.maxOutputTokens) && policy.maxOutputTokens > 0 && policy.maxOutputTokens <= 1024
    && Number.isSafeInteger(policy.maxRequestBytes) && policy.maxRequestBytes >= 128 && policy.maxRequestBytes <= 1_048_576, 'INVALID_REQUEST_CAP');
  demand(typeof policy.verifiedAt === 'string' && typeof policy.expiresAt === 'string', 'PRICE_EVIDENCE_REQUIRED');
  const result = Object.freeze({ endpoint: normalizedEndpoint(policy.endpoint), model: policy.model,
    maxOutputTokens: policy.maxOutputTokens, maxRequestBytes: policy.maxRequestBytes,
    cashUpperBoundMicros: money(policy.cashUpperBoundCny), evidenceSha256: policy.evidenceSha256,
    verifiedAt: policy.verifiedAt, expiresAt: policy.expiresAt, coversAllBillableTokens: true, ...requestOptions(policy) });
  validatePolicyDates(result);
  return result;
}
function sameBounds(a, b) {
  return ['endpoint', 'model', 'maxOutputTokens', 'maxRequestBytes', 'cashUpperBoundMicros', 'coversAllBillableTokens']
    .every(key => a[key] === b[key])
    && ['reasoningEffort', 'responseFormat'].every(key => Object.hasOwn(a, key) === Object.hasOwn(b, key) && a[key] === b[key]);
}
function advancesEvidence(next, previous) {
  return next.evidenceSha256 !== previous.evidenceSha256
    && Date.parse(next.verifiedAt) > Date.parse(previous.verifiedAt)
    && Date.parse(next.expiresAt) > Date.parse(previous.expiresAt);
}
function authorizationConfig(auth) {
  demand(record(auth) && auth.granted === true, 'AUTHORIZATION_REQUIRED');
  demand(token(auth.id) && token(auth.stageId) && auth.currency === 'CNY', 'INVALID_AUTHORIZATION');
  demand(Number.isSafeInteger(auth.maximumPosts) && auth.maximumPosts > 0 && auth.maximumPosts <= 100_000, 'INVALID_AUTHORIZATION');
  demand(Array.isArray(auth.allowedTaskIds) && auth.allowedTaskIds.length > 0 && auth.allowedTaskIds.length <= 100_000
    && auth.allowedTaskIds.every(token) && new Set(auth.allowedTaskIds).size === auth.allowedTaskIds.length, 'INVALID_AUTHORIZATION');
  const ledgerDirectory = absoluteFile(auth.ledgerDirectory), identityFile = absoluteFile(auth.identityFile);
  const relative = path.relative(ledgerDirectory, identityFile);
  demand(relative && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)), 'IDENTITY_MUST_BE_OUTSIDE_LEDGER');
  const policy = requestPolicyConfig(auth.requestPolicy);
  const normalized = {
    id: auth.id, stageId: auth.stageId, currency: 'CNY', maximumMicros: money(auth.maximumSpendCny), maximumPosts: auth.maximumPosts,
    allowedTaskIds: Object.freeze([...auth.allowedTaskIds].sort()), ledgerDirectory, identityFile,
    requestPolicy: policy
  };
  return Object.freeze(normalized);
}

export const RECOVERY_ID = 'submission-20261031';
const RECOVERY_KEYS = ['schemaVersion', 'kind', 'synthetic', 'granted', 'id', 'stageId', 'originalAuthorizationSha256',
  'expectedCheckpoint', 'fromSourceRevision', 'toSourceRevision', 'maximumSpendCny', 'maximumPosts',
  'historicalReservationsSha256', 'historicalReservationCount', 'expectedHaltCode', 'allowedTaskId', 'maximumNewPosts',
  'timeoutMs', 'requestBounds', 'freshPriceSha256', 'deadline', 'recordedAt', 'humanAuthorization'];
/** One deliberately narrow recovery, never a general reset or an additional budget. */
export function validateRecoveryGrant(grant) {
  demand(exact(grant, RECOVERY_KEYS) && grant.schemaVersion === 1 && grant.granted === true
    && typeof grant.synthetic === 'boolean' && grant.kind === (grant.synthetic ? 'SYNTHETIC_TEST_RECOVERY' : 'RECORDED_USER_RECOVERY')
    && grant.id === RECOVERY_ID && token(grant.stageId) && hex(grant.originalAuthorizationSha256)
    && hex(grant.fromSourceRevision) && hex(grant.toSourceRevision) && grant.fromSourceRevision !== grant.toSourceRevision
    && grant.maximumSpendCny === '5' && grant.maximumPosts === 8 && grant.historicalReservationCount === 3
    && hex(grant.historicalReservationsSha256) && grant.expectedHaltCode === 'TIMEOUT'
    && grant.allowedTaskId === 'community-update' && grant.maximumNewPosts === 4 && grant.timeoutMs === 120000
    && hex(grant.freshPriceSha256) && Number.isFinite(Date.parse(grant.deadline))
    && Number.isFinite(Date.parse(grant.recordedAt)), 'INVALID_RECOVERY_GRANT');
  const checkpoint = grant.expectedCheckpoint;
  demand(exact(checkpoint, ['ledgerSha256', 'headSha256', 'identitySha256', 'revision']) && integer(checkpoint.revision)
    && ['ledgerSha256', 'headSha256', 'identitySha256'].every(key => hex(checkpoint[key])), 'INVALID_RECOVERY_GRANT');
  const p = grant.requestBounds;
  demand(exact(p, ['endpoint', 'model', 'maxOutputTokens', 'maxRequestBytes', 'cashUpperBoundCny', 'coversAllBillableTokens',
    'reasoningEffort', 'responseFormat']) && p.maxOutputTokens === 1024 && p.maxRequestBytes === 32768
    && p.reasoningEffort === 'low' && p.responseFormat === 'json_object' && p.coversAllBillableTokens === true,
  'INVALID_RECOVERY_GRANT');
  normalizedEndpoint(p.endpoint); money(p.cashUpperBoundCny);
  demand(typeof p.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(p.model), 'INVALID_RECOVERY_GRANT');
  const human = grant.humanAuthorization;
  demand(exact(human, ['reference', 'text', 'sha256']) && typeof human.reference === 'string'
    && human.reference.trim().length > 0 && human.reference.length <= 2048 && typeof human.text === 'string'
    && human.text.trim().length > 0 && human.text.length <= 32000 && hex(human.sha256) && sha(human.text) === human.sha256,
  'HUMAN_AUTHORIZATION_EVIDENCE_REQUIRED');
  return grant;
}

/** Pure, read-only state validation shared by the preflight and locked writer. */
export function recoveryScheduling(state) {
  if (state.recoveryHistory === undefined && state.schedulingEpoch === undefined) return null;
  demand(Array.isArray(state.recoveryHistory) && state.recoveryHistory.length === 1
    && exact(state.recoveryHistory[0], ['grant', 'grantSha256']), 'LEDGER_INVALID');
  const { grant, grantSha256 } = state.recoveryHistory[0]; validateRecoveryGrant(grant);
  const epoch = state.schedulingEpoch;
  demand(hex(grantSha256) && exact(epoch, ['epoch', 'grantSha256', 'runId', 'halted', 'haltCode', 'haltEvents'])
    && epoch.epoch === 1 && epoch.grantSha256 === grantSha256 && (epoch.runId === null || token(epoch.runId))
    && typeof epoch.halted === 'boolean' && (epoch.halted ? FAILURES.has(epoch.haltCode) : epoch.haltCode === null)
    && Array.isArray(epoch.haltEvents) && epoch.haltEvents.length === (epoch.halted ? 1 : 0)
    && state.halted === true && state.haltCode === grant.expectedHaltCode
    && state.revision > grant.expectedCheckpoint.revision && Array.isArray(state.reservations)
    && state.reservations.length >= 3 && sha(JSON.stringify(state.reservations.slice(0, 3))) === grant.historicalReservationsSha256,
  'LEDGER_INVALID');
  demand(state.reservations.slice(0, 3).every(r => r.recoveryEpoch === undefined)
    && state.reservations.slice(0, 3).filter(r => r.status === 'FAILED').length === 2
    && state.reservations[2].status === 'INCOMPLETE', 'LEDGER_INVALID');
  const added = state.reservations.slice(3);
  demand(added.length <= grant.maximumNewPosts && (added.length === 0 ? epoch.runId === null : token(epoch.runId))
    && added.every(r => r.recoveryEpoch === 1 && r.runId === epoch.runId && r.taskId === grant.allowedTaskId
      && (!['FAILED', 'INCOMPLETE'].includes(r.status) || epoch.halted)), 'LEDGER_INVALID');
  if (epoch.halted) demand(exact(epoch.haltEvents[0], ['code', 'revision']) && epoch.haltEvents[0].code === epoch.haltCode
    && integer(epoch.haltEvents[0].revision) && epoch.haltEvents[0].revision > grant.expectedCheckpoint.revision
    && epoch.haltEvents[0].revision <= state.revision, 'LEDGER_INVALID');
  return { grant, grantSha256, epoch, usedPosts: added.length, remainingPosts: grant.maximumNewPosts - added.length };
}

export class StageBudget {
  #auth; #clock; #paths; #state; #expected; #identityBytes; #headBytes; #lockBytes; #closed = false; #broken = false;
  static open({ authorization, now = Date.now } = {}) { return new StageBudget(authorization, now); }

  constructor(authorization, clock) {
    this.#auth = authorizationConfig(authorization);
    demand(typeof clock === 'function', 'INVALID_CLOCK');
    this.#clock = clock;
    const directory = this.#auth.ledgerDirectory;
    this.#paths = { directory, ledger: path.join(directory, 'ledger.json'), lock: path.join(directory, 'stage.lock'),
      identity: this.#auth.identityFile, head: `${this.#auth.identityFile}.head.json` };
    const authHash = sha(JSON.stringify(this.#auth));
    let lockAcquired = false;
    try {
      existingPlainPath(path.dirname(directory), true);
      existingPlainPath(path.dirname(this.#paths.identity), true);
      const identityMissing = isMissing(this.#paths.identity);
      // Existing identities can reopen with expired evidence for renewal only.
      // The original authorization, including its original policy, must still match.
      if (identityMissing) validatePolicyTime(this.#auth.requestPolicy, this.#clock());
      if (isMissing(directory)) {
        demand(identityMissing, 'LEDGER_MISSING');
        fs.mkdirSync(directory, { mode: 0o700 });
      }
      existingPlainPath(directory, true);
      demand(identityMissing === isMissing(this.#paths.ledger), 'LEDGER_IDENTITY_MISSING');
      demand(identityMissing === isMissing(this.#paths.head), 'LEDGER_CHECKPOINT_MISSING');
      this.#lockBytes = json({ schemaVersion: 1, owner: randomUUID() });
      try { exclusiveWrite(this.#paths.lock, this.#lockBytes); lockAcquired = true; }
      catch (error) { if (error.code === 'EEXIST') throw new BudgetError('STAGE_LOCKED'); throw error; }
      if (identityMissing) {
        // Write the non-resettable external identity before creating a spendable ledger.
        exclusiveWrite(this.#paths.identity, json({ schemaVersion: 1, authorizationHash: authHash }));
        const initialBytes = json({ schemaVersion: 1, authorizationHash: authHash, revision: 0,
          halted: false, haltCode: null, reservations: [], policyHistory: [{ revision: 0, policy: this.#auth.requestPolicy }] });
        exclusiveWrite(this.#paths.ledger, initialBytes);
        exclusiveWrite(this.#paths.head, json({ schemaVersion: 1, authorizationHash: authHash, revision: 0, ledgerHash: sha(initialBytes) }));
      }
      existingPlainPath(this.#paths.identity, false);
      existingPlainPath(this.#paths.ledger, false);
      existingPlainPath(this.#paths.head, false);
      this.#identityBytes = fs.readFileSync(this.#paths.identity, 'utf8');
      const identity = JSON.parse(this.#identityBytes);
      demand(identity.schemaVersion === 1 && identity.authorizationHash === authHash, 'AUTHORIZATION_IDENTITY_MISMATCH');
      const bytes = fs.readFileSync(this.#paths.ledger, 'utf8');
      this.#state = JSON.parse(bytes);
      this.#validateState(this.#state, authHash);
      this.#expected = sha(bytes);
      this.#headBytes = fs.readFileSync(this.#paths.head, 'utf8');
      const head = JSON.parse(this.#headBytes);
      demand(head.schemaVersion === 1 && head.authorizationHash === authHash && head.revision === this.#state.revision
        && head.ledgerHash === this.#expected, 'LEDGER_CHECKPOINT_MISMATCH');
      if (this.#state.reservations.some(r => r.status === 'HELD' || r.status === 'IN_FLIGHT')) {
        // If a human removes a crash lock, an unsettled ledger still cannot resume.
        this.#write(state => {
          this.#latchHalt(state, 'UNSETTLED_RESERVATIONS');
          for (const r of state.reservations) if (r.status === 'HELD' || r.status === 'IN_FLIGHT') r.status = 'INCOMPLETE';
        });
      }
    } catch (error) {
      // An unsuccessful open leaves its acquired lock in place: inspect, never auto-recover.
      this.#broken = lockAcquired;
      if (error instanceof BudgetError) throw error;
      throw new BudgetError('LEDGER_IO_OR_INTEGRITY_FAILURE');
    }
  }

  #validateState(state, authHash) {
    demand(record(state) && state.schemaVersion === 1 && state.authorizationHash === authHash && integer(state.revision)
      && typeof state.halted === 'boolean' && (state.halted ? FAILURES.has(state.haltCode) : state.haltCode === null)
      && Array.isArray(state.reservations) && state.reservations.length <= this.#auth.maximumPosts, 'LEDGER_INVALID');
    const recovery = recoveryScheduling(state);
    if (recovery) {
      const grant = recovery.grant;
      demand(grant.stageId === this.#auth.stageId && grant.maximumPosts === this.#auth.maximumPosts
        && money(grant.maximumSpendCny) === this.#auth.maximumMicros
        && this.#auth.allowedTaskIds.includes(grant.allowedTaskId)
        && sameBounds(requestPolicyConfig({ ...grant.requestBounds, evidenceSha256: grant.freshPriceSha256,
          verifiedAt: this.#auth.requestPolicy.verifiedAt, expiresAt: this.#auth.requestPolicy.expiresAt }), this.#auth.requestPolicy),
      'RECOVERY_POLICY_MISMATCH');
    }
    const history = this.#policyHistory(state);
    demand(Array.isArray(history) && history.length > 0 && history.length <= state.revision + 1, 'LEDGER_INVALID');
    const evidenceHashes = new Set();
    for (const [revision, entry] of history.entries()) {
      demand(record(entry) && entry.revision === revision && record(entry.policy)
        && Object.keys(entry.policy).length === Object.keys(this.#auth.requestPolicy).length
        && sameBounds(entry.policy, this.#auth.requestPolicy) && /^[a-f0-9]{64}$/.test(entry.policy.evidenceSha256), 'LEDGER_INVALID');
      validatePolicyDates(entry.policy);
      demand(!evidenceHashes.has(entry.policy.evidenceSha256), 'LEDGER_INVALID'); evidenceHashes.add(entry.policy.evidenceSha256);
      demand(revision === 0 ? JSON.stringify(entry.policy) === JSON.stringify(this.#auth.requestPolicy)
        : advancesEvidence(entry.policy, history[revision - 1].policy), 'LEDGER_INVALID');
    }
    const ids = new Set(), counts = new Map(); let micros = 0, inFlight = 0;
    for (const r of state.reservations) {
      demand(record(r) && typeof r.id === 'string' && /^[a-f0-9-]{36}$/.test(r.id) && !ids.has(r.id)
        && this.#auth.allowedTaskIds.includes(r.taskId) && token(r.runId) && PURPOSES.has(r.purpose)
        && STATES.has(r.status) && r.cashUpperBoundMicros === this.#auth.requestPolicy.cashUpperBoundMicros, 'LEDGER_INVALID');
      // Old v1 ledgers had no send-policy field and remain readable without rewriting them.
      demand(r.policyRevision === undefined || (integer(r.policyRevision) && r.policyRevision < history.length
        && r.status !== 'HELD'), 'LEDGER_INVALID');
      ids.add(r.id); counts.set(r.taskId, (counts.get(r.taskId) ?? 0) + 1); micros += r.cashUpperBoundMicros;
      if (r.status === 'IN_FLIGHT') inFlight++;
      demand(integer(micros) && counts.get(r.taskId) <= BUDGET_LIMITS.perTaskPosts, 'LEDGER_INVALID');
      if (r.status === 'FAILED' || r.status === 'INCOMPLETE') demand(state.halted, 'LEDGER_INVALID');
      if (!recovery) demand(r.recoveryEpoch === undefined, 'LEDGER_INVALID');
    }
    demand(micros <= this.#auth.maximumMicros && inFlight <= BUDGET_LIMITS.inFlightPosts, 'LEDGER_INVALID');
  }

  #guard() {
    demand(!this.#closed, 'BUDGET_CLOSED'); demand(!this.#broken, 'LEDGER_IO_OR_INTEGRITY_FAILURE');
    try {
      for (const filename of [this.#paths.identity, this.#paths.head, this.#paths.ledger, this.#paths.lock]) existingPlainPath(filename, false);
      demand(fs.readFileSync(this.#paths.identity, 'utf8') === this.#identityBytes
        && fs.readFileSync(this.#paths.head, 'utf8') === this.#headBytes
        && sha(fs.readFileSync(this.#paths.ledger)) === this.#expected
        && fs.readFileSync(this.#paths.lock, 'utf8') === this.#lockBytes, 'LEDGER_EXTERNALLY_MODIFIED');
    } catch (error) {
      this.#broken = true;
      if (error instanceof BudgetError) throw error;
      throw new BudgetError('LEDGER_IO_OR_INTEGRITY_FAILURE');
    }
  }

  #write(update) {
    this.#guard();
    const next = structuredClone(this.#state); update(next); next.revision++;
    this.#validateState(next, this.#state.authorizationHash);
    const bytes = json(next), temporary = path.join(this.#paths.directory, `ledger-${randomUUID()}.tmp`);
    const headBytes = json({ schemaVersion: 1, authorizationHash: next.authorizationHash, revision: next.revision, ledgerHash: sha(bytes) });
    const headTemporary = `${this.#paths.head}-${randomUUID()}.tmp`;
    try {
      exclusiveWrite(temporary, bytes);
      exclusiveWrite(headTemporary, headBytes);
      // Advance the external high-water checkpoint first. A partial commit cannot
      // restore an older spendable ledger, even after manual crash-lock removal.
      fs.renameSync(headTemporary, this.#paths.head);
      flushDirectory(path.dirname(this.#paths.head));
      fs.renameSync(temporary, this.#paths.ledger);
      flushDirectory(this.#paths.directory);
      this.#state = next; this.#expected = sha(bytes); this.#headBytes = headBytes;
    } catch { this.#broken = true; throw new BudgetError('LEDGER_IO_OR_INTEGRITY_FAILURE'); }
  }

  #policyHistory(state = this.#state) {
    return state.policyHistory === undefined ? [{ revision: 0, policy: this.#auth.requestPolicy }] : state.policyHistory;
  }
  #currentPolicy() { return this.#policyHistory().at(-1).policy; }
  #isHalted() { return recoveryScheduling(this.#state)?.epoch.halted ?? this.#state.halted; }
  #latchHalt(state, code) {
    if (state.schedulingEpoch) {
      if (!state.schedulingEpoch.halted) {
        state.schedulingEpoch.halted = true; state.schedulingEpoch.haltCode = code;
        state.schedulingEpoch.haltEvents.push({ code, revision: state.revision + 1 });
      }
    } else if (!state.halted) { state.halted = true; state.haltCode = code; }
  }
  #admit() { this.#guard(); demand(!this.#isHalted(), 'STAGE_HALTED'); validatePolicyTime(this.#currentPolicy(), this.#clock()); }
  #reservation(id) {
    const found = this.#state.reservations.find(r => r.id === id);
    demand(found, 'RESERVATION_NOT_FOUND'); return found;
  }

  get requestPolicy() { this.#guard(); return Object.freeze({ ...this.#currentPolicy() }); }
  get policyRevision() { this.#guard(); return this.#policyHistory().length - 1; }

  activateRecovery({ grant, grantSha256, currentPolicy } = {}) {
    this.#guard(); validateRecoveryGrant(grant);
    demand(hex(grantSha256) && !this.#state.recoveryHistory && !this.#state.schedulingEpoch, 'RECOVERY_ALREADY_USED');
    demand(this.#state.halted === true && this.#state.haltCode === 'TIMEOUT'
      && this.#state.reservations.length === 3 && this.#state.reservations.every(r => !['HELD', 'IN_FLIGHT'].includes(r.status))
      && sha(JSON.stringify(this.#state.reservations)) === grant.historicalReservationsSha256, 'RECOVERY_CHECKPOINT_MISMATCH');
    const cp = grant.expectedCheckpoint;
    demand(cp.revision === this.#state.revision && cp.ledgerSha256 === this.#expected && cp.headSha256 === sha(this.#headBytes)
      && cp.identitySha256 === sha(this.#identityBytes), 'RECOVERY_CHECKPOINT_MISMATCH');
    demand(this.#clock() >= Date.parse(grant.recordedAt) && this.#clock() < Date.parse(grant.deadline), 'RECOVERY_EXPIRED');
    const next = requestPolicyConfig(currentPolicy);
    validatePolicyTime(next, this.#clock());
    demand(next.evidenceSha256 === grant.freshPriceSha256 && sameBounds(next, this.#auth.requestPolicy)
      && advancesEvidence(next, this.#currentPolicy()), 'RECOVERY_POLICY_MISMATCH');
    // Exclusive immutable snapshots precede the high-water commit. A partial
    // activation leaves a lock/snapshot and is never automatically retried.
    try {
      exclusiveWrite(path.join(this.#paths.directory, 'recovery-base-ledger.json'), fs.readFileSync(this.#paths.ledger));
      exclusiveWrite(path.join(this.#paths.directory, 'recovery-base-head.json'), this.#headBytes);
      this.#write(state => {
        state.recoveryHistory = [{ grant: structuredClone(grant), grantSha256 }];
        state.schedulingEpoch = { epoch: 1, grantSha256, runId: null, halted: false, haltCode: null, haltEvents: [] };
        state.policyHistory ??= structuredClone(this.#policyHistory(state));
        state.policyHistory.push({ revision: state.policyHistory.length, policy: next });
      });
    } catch (error) { this.#broken = true; throw error instanceof BudgetError ? error : new BudgetError('LEDGER_IO_OR_INTEGRITY_FAILURE'); }
    return this.inspect();
  }

  refreshPriceEvidence(policy) {
    this.#guard(); demand(!this.#isHalted(), 'STAGE_HALTED');
    demand(!this.#state.reservations.some(r => r.status === 'IN_FLIGHT'), 'PRICE_RENEWAL_IN_FLIGHT');
    demand(record(policy) && Object.keys(policy).every(key => ['endpoint', 'model', 'maxOutputTokens', 'maxRequestBytes',
      'cashUpperBoundCny', 'evidenceSha256', 'verifiedAt', 'expiresAt', 'coversAllBillableTokens',
      'reasoningEffort', 'responseFormat'].includes(key)), 'REQUEST_POLICY_MISMATCH');
    const next = requestPolicyConfig(policy), previous = this.#currentPolicy();
    demand(sameBounds(next, this.#auth.requestPolicy), 'REQUEST_POLICY_MISMATCH');
    validatePolicyTime(next, this.#clock());
    demand(advancesEvidence(next, previous) && !this.#policyHistory().some(entry => entry.policy.evidenceSha256 === next.evidenceSha256),
      'PRICE_EVIDENCE_NOT_ADVANCING');
    const revision = this.#policyHistory().length;
    this.#write(state => {
      state.policyHistory ??= structuredClone(this.#policyHistory(state));
      state.policyHistory.push({ revision, policy: next });
    });
    return Object.freeze({ policyRevision: revision });
  }
  assertRequestPolicy({ endpoint, model, maxOutputTokens, requestBytes }) {
    this.#admit();
    const p = this.#currentPolicy();
    demand(endpoint === p.endpoint && model === p.model && maxOutputTokens === p.maxOutputTokens, 'REQUEST_POLICY_MISMATCH');
    demand(integer(requestBytes) && requestBytes > 0 && requestBytes <= p.maxRequestBytes, 'REQUEST_TOO_LARGE');
  }

  reserveBatch({ taskId, runId, requests } = {}) {
    this.#admit();
    demand(this.#auth.allowedTaskIds.includes(taskId) && token(runId), 'TASK_NOT_AUTHORIZED');
    demand(Array.isArray(requests) && requests.length > 0 && requests.length <= 8
      && requests.every(r => record(r) && PURPOSES.has(r.purpose)), 'INVALID_RESERVATION');
    const used = this.#state.reservations;
    const recovery = recoveryScheduling(this.#state);
    if (recovery) demand(taskId === recovery.grant.allowedTaskId
      && (recovery.epoch.runId === null || recovery.epoch.runId === runId)
      && recovery.usedPosts + requests.length <= recovery.grant.maximumNewPosts, 'RECOVERY_RUN_LIMIT');
    demand(used.filter(r => r.taskId === taskId).length + requests.length <= 8, 'TASK_POST_LIMIT');
    demand(used.length + requests.length <= this.#auth.maximumPosts, 'STAGE_POST_LIMIT');
    const totalMicros = used.reduce((n, r) => n + r.cashUpperBoundMicros, 0) + requests.length * this.#auth.requestPolicy.cashUpperBoundMicros;
    demand(integer(totalMicros) && totalMicros <= this.#auth.maximumMicros, 'STAGE_CNY_LIMIT');
    const held = requests.map(r => ({ id: randomUUID(), taskId, runId, purpose: r.purpose,
      cashUpperBoundMicros: this.#auth.requestPolicy.cashUpperBoundMicros, status: 'HELD', ...(recovery ? { recoveryEpoch: 1 } : {}) }));
    this.#write(state => { if (recovery) state.schedulingEpoch.runId ??= runId; state.reservations.push(...held); });
    return held.map(r => Object.freeze({ ...r }));
  }

  reserveMutation({ taskId, runId, mandatoryRechecks } = {}) {
    demand(integer(mandatoryRechecks) && mandatoryRechecks <= 7, 'INVALID_RECHECK_COUNT');
    return this.reserveBatch({ taskId, runId, requests: [{ purpose: 'revision' },
      ...Array.from({ length: mandatoryRechecks }, () => ({ purpose: 'mandatory_recheck' }))] });
  }

  begin(reservationId) {
    this.#admit();
    demand(this.#reservation(reservationId).status === 'HELD', 'RESERVATION_NOT_HELD');
    demand(this.#state.reservations.filter(r => r.status === 'IN_FLIGHT').length < 3, 'IN_FLIGHT_LIMIT');
    const policyRevision = this.#policyHistory().length - 1;
    this.#write(state => { Object.assign(state.reservations.find(r => r.id === reservationId), { status: 'IN_FLIGHT', policyRevision }); });
    return Object.freeze({ id: reservationId, policyRevision });
  }

  succeed(reservationId) {
    this.#guard(); demand(this.#reservation(reservationId).status === 'IN_FLIGHT', 'RESERVATION_NOT_IN_FLIGHT');
    const accepted = !this.#isHalted();
    this.#write(state => { state.reservations.find(r => r.id === reservationId).status = accepted ? 'SUCCEEDED' : 'INCOMPLETE'; });
    return Object.freeze({ accepted, ...(accepted ? {} : { code: 'STAGE_HALTED' }) });
  }

  fail(reservationId, code = 'GENERATION_FAILURE') {
    this.#guard();
    demand(['HELD', 'IN_FLIGHT'].includes(this.#reservation(reservationId).status), 'RESERVATION_ALREADY_SETTLED');
    const safeCode = FAILURES.has(code) ? code : 'GENERATION_FAILURE';
    this.#write(state => {
      state.reservations.find(r => r.id === reservationId).status = 'FAILED';
      this.#latchHalt(state, safeCode);
    });
  }

  stop() {
    this.#guard();
    if (!this.#isHalted()) this.#write(state => this.#latchHalt(state, 'STAGE_STOPPED'));
  }

  haltForInvalidOutput() {
    this.#guard();
    if (!this.#isHalted()) this.#write(state => this.#latchHalt(state, 'INVALID_AGENT_OUTPUT'));
  }

  inspect() {
    this.#guard();
    const reservations = structuredClone(this.#state.reservations);
    const reservedMicros = reservations.reduce((n, r) => n + r.cashUpperBoundMicros, 0);
    const recovery = recoveryScheduling(this.#state);
    return { schemaVersion: 1, revision: this.#state.revision, policyRevision: this.#policyHistory().length - 1,
      halted: this.#isHalted(), haltCode: recovery ? recovery.epoch.haltCode : this.#state.haltCode,
      ...(recovery ? { historicalHalt: { halted: this.#state.halted, code: this.#state.haltCode },
        recovery: { id: recovery.grant.id, grantSha256: recovery.grantSha256, epoch: 1,
          runId: recovery.epoch.runId, remainingPosts: recovery.remainingPosts } } : {}),
      reservedPosts: reservations.length, remainingPosts: this.#auth.maximumPosts - reservations.length,
      reservedMicros, remainingMicros: this.#auth.maximumMicros - reservedMicros,
      inFlight: reservations.filter(r => r.status === 'IN_FLIGHT').length, reservations };
  }

  close() {
    if (this.#closed) return;
    this.#guard();
    if (this.#state.reservations.some(r => r.status === 'HELD' || r.status === 'IN_FLIGHT')) {
      this.#write(state => {
        this.#latchHalt(state, 'UNSETTLED_RESERVATIONS');
        for (const r of state.reservations) if (r.status === 'HELD' || r.status === 'IN_FLIGHT') r.status = 'INCOMPLETE';
      });
    }
    this.#guard();
    try { fs.unlinkSync(this.#paths.lock); flushDirectory(this.#paths.directory); this.#closed = true; }
    catch { this.#broken = true; throw new BudgetError('LEDGER_IO_OR_INTEGRITY_FAILURE'); }
  }
}

export const openStageBudget = options => StageBudget.open(options);

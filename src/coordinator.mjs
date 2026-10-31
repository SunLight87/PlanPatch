import { mkdir, open, readFile, appendFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { normalizeInput, clone, deepFreeze, codedError, versionsMatch, extractEvidence, evidenceFindings,
  affectedRequirements, applyVersionedPatch, applyVersionedChecks, evaluateChecks } from './domain.mjs';
import { ROLES, taskPayload } from './prompts.mjs';
import { createMockInferenceRunner } from './mock-inference.mjs';
import { createMozaikRuntime } from './mozaik-runtime.mjs';
import { createProviderInferenceRunner } from './provider-inference.mjs';
import { StageBudget } from './budget.mjs';
import { isProviderForBudget } from './provider.mjs';
import { validateTrustedLiveTransport } from './trusted-stage.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const encoded = value => `${JSON.stringify(value, null, 2)}\n`;
const CORE_FILES = ['coordinator.mjs', 'domain.mjs', 'mozaik-runtime.mjs', 'prompts.mjs', 'mock-inference.mjs', 'provider-inference.mjs', 'transport-protocol.mjs', 'budget.mjs', 'provider.mjs', 'diagnostics.mjs', 'trusted-stage.mjs', 'live-entry.mjs'];

/** Logical slots only. This is not a funded provider ledger or an authorization to send POSTs. */
export class MockBudget {
  #entries = [];
  #limit = 8;
  reserveBatch(purposes) {
    if (!Array.isArray(purposes) || !purposes.length || purposes.some(item => typeof item !== 'string')) throw codedError('INVALID_MOCK_RESERVATION');
    if (this.#entries.length + purposes.length > this.#limit) throw codedError('MOCK_BUDGET_EXHAUSTED');
    const result = purposes.map(purpose => ({ id: `mock-slot-${this.#entries.length + 1}`, purpose, dispatched: false }));
    // Assign IDs after the entire batch was checked, and never refund failed or abandoned slots.
    result.forEach((entry, index) => { entry.id = `mock-slot-${this.#entries.length + index + 1}`; });
    this.#entries.push(...result);
    return result.map(entry => deepFreeze({ id: entry.id, purpose: entry.purpose }));
  }
  consume(token) {
    const entry = this.#entries.find(item => item.id === token?.id && item.purpose === token?.purpose);
    if (!entry || entry.dispatched) throw codedError('INVALID_MOCK_SLOT');
    entry.dispatched = true;
  }
  snapshot() { return { kind: 'MOCK_LOGICAL_ONLY', limit: this.#limit, reserved: this.#entries.length,
    dispatched: this.#entries.filter(item => item.dispatched).length, entries: clone(this.#entries) }; }
}

function payloadOf(bundle) {
  return { schemaVersion: bundle.schemaVersion, mode: bundle.mode, runId: bundle.runId, createdAt: bundle.createdAt,
    productRevision: bundle.productRevision, fullSourceRevision: bundle.fullSourceRevision, snapshot: bundle.snapshot };
}
function artifactFiles(snapshot) {
  return { 'snapshot.json': encoded(snapshot), 'original.json': encoded(snapshot.original),
    'proposal.json': encoded(snapshot.proposal), 'attachment.json': encoded(snapshot.attachment),
    'sources.json': encoded(snapshot.sources), 'events.jsonl': snapshot.events.map(item => JSON.stringify(item)).join('\n') + '\n' };
}
export function verifyFrozenBundle(bundle) {
  try {
    if (bundle.schemaVersion !== 1 || !['MOCK', 'OFFLINE_TRANSPORT', 'LIVE'].includes(bundle.mode) || bundle.snapshot?.mode !== bundle.mode
      || (bundle.mode === 'LIVE' ? !/^[a-f0-9]{64}$/.test(bundle.fullSourceRevision)
        || bundle.snapshot.fullSourceRevision !== bundle.fullSourceRevision || bundle.snapshot.counters.fakeGenerationPosts !== 0
        || bundle.snapshot.counters.realGenerationPosts !== bundle.snapshot.counters.generationPosts
        || bundle.snapshot.liveAcceptance !== 'NOT_CHECKED'
        : bundle.snapshot?.counters?.realGenerationPosts !== 0 || bundle.snapshot?.counters?.generationPosts !== 0) || !bundle.snapshot?.frozen
      || bundle.snapshot.runId !== bundle.runId || bundle.snapshot.artifactStatus !== 'FROZEN'
      || bundle.manifest.algorithm !== 'SHA-256' || bundle.manifest.payloadSha256 !== hash(encoded(payloadOf(bundle)))) return false;
    if (Object.keys(bundle.manifest.coreSources).sort().join('|') !== [...CORE_FILES].sort().join('|')
      || Object.values(bundle.manifest.coreSources).some(value => !/^[a-f0-9]{64}$/.test(value))
      || bundle.productRevision !== `planpatch-core-sha256:${hash(encoded(bundle.manifest.coreSources))}`) return false;
    const files = Object.entries(artifactFiles(bundle.snapshot));
    return bundle.manifest.files.length === files.length && files.every(([path, data]) => bundle.manifest.files.some(item => item.path === path
      && item.sha256 === hash(data) && item.bytes === Buffer.byteLength(data)));
  } catch { return false; }
}

export async function createRun({ input, mode = 'MOCK', runDirectory, onEvent = () => {}, transport }) {
  // A mode string/true flag/provider object cannot mint production capability.
  if (!['MOCK', 'OFFLINE_TRANSPORT', 'LIVE'].includes(mode)) throw codedError('MODE_UNSUPPORTED');
  const live = mode === 'LIVE';
  const fullSourceRevision = live ? validateTrustedLiveTransport(transport, { runDirectory, inputId: input?.id }) : transport?.fullSourceRevision;
  const offline = mode === 'OFFLINE_TRANSPORT';
  const guarded = offline || live;
  if (offline && (!transport || transport.offline !== true || !(transport.budget instanceof StageBudget)
    || !isProviderForBudget(transport.provider, transport.budget) || typeof transport.taskId !== 'string'))
    throw codedError('OFFLINE_TRANSPORT_INJECTION_REQUIRED');
  if (!guarded && transport !== undefined) throw codedError('TRANSPORT_MODE_MISMATCH');
  const normalized = normalizeInput(input);
  if (typeof runDirectory !== 'string' || !runDirectory.length || typeof onEvent !== 'function') throw codedError('INVALID_RUN_OPTIONS');
  const sourceHashes = Object.fromEntries(await Promise.all(CORE_FILES.map(async file => [file, hash(await readFile(new URL(file, import.meta.url)))])));
  const productRevision = `planpatch-core-sha256:${hash(encoded(sourceHashes))}`;
  await mkdir(runDirectory, { recursive: true });
  const runId = `planpatch-${randomUUID()}`;
  // A directory cannot silently reset/resume a previous run.
  try {
    const marker = await open(join(runDirectory, 'run.json'), 'wx');
    try { await marker.writeFile(encoded({ runId, mode, synthetic: true, productRevision, fullSourceRevision }), 'utf8'); } finally { await marker.close(); }
  } catch { throw codedError('RUN_DIRECTORY_UNAVAILABLE'); }
  await writeFile(join(runDirectory, 'input.json'), encoded(normalized), { encoding: 'utf8', flag: 'wx' });
  const startedAt = performance.now(), budget = guarded ? transport.budget : new MockBudget();
  const abortController = new AbortController();
  const state = { runId, mode, synthetic: true, title: normalized.title, productRevision, ...(fullSourceRevision ? { fullSourceRevision } : {}),
    ...(transport?.recovery ? { recovery: clone(transport.recovery) } : {}),
    ...(live ? { liveAcceptance: 'NOT_CHECKED' } : {}), status: 'CREATED', artifactStatus: 'NONE',
    acceptance: 'NOT_CHECKED', proposalVersion: 0, evidenceVersion: 0, original: clone(normalized.original),
    proposal: clone(normalized.original), attachment: clone(normalized.attachment), sources: clone(normalized.sources),
    constraints: clone(normalized.constraints), findings: [], decisions: [], unresolved: [], checks: [], events: [],
    evidence: { facts: [], conflicts: [], unknowns: [] }, agents: Object.entries(ROLES).map(([id, role]) => ({ id, name: role.name, status: 'IDLE' })),
    counters: { generationPosts: 0, realGenerationPosts: 0, fakeGenerationPosts: 0, mockInvocations: 0, maxConcurrentAgents: 0 },
    evidenceLabel: live ? 'LIVE · 真实生成 POST · 合成活动材料 · A01/A02 待单独核查 · 非提交许可'
      : offline ? 'OFFLINE_TRANSPORT · 合成测试授权 · fake POST · 真实生成请求 0 · 非 LIVE 验收' : 'MOCK · 合成材料 · 真实 Mozaik 事件调度 · 无模型网络请求', readyToSubmit: false, frozen: false };
  let execution = null, frozenBundle = null, freezing = null, persistence = Promise.resolve(), ioFailed = false;
  let runtime;
  const snapshot = () => frozenBundle ? clone(frozenBundle.snapshot)
    : clone({ ...state, ...(guarded ? { transportBudget: budget.inspect() } : { mockBudget: budget.snapshot() }) });
  const active = () => state.status === 'RUNNING' && !ioFailed && (!guarded || !budget.inspect().halted);
  const haltTransport = () => {
    if (!guarded) return;
    budget.stop();
    abortController.abort();
  };
  const assertActive = () => { if (!active()) throw codedError(ioFailed ? 'PERSISTENCE_FAILED' : 'RUN_STOPPED'); };
  const persist = () => {
    const snapshotText = encoded(snapshot());
    persistence = persistence.then(async () => {
      await writeFile(join(runDirectory, 'snapshot.tmp'), snapshotText, 'utf8');
      await rename(join(runDirectory, 'snapshot.tmp'), join(runDirectory, 'snapshot.json'));
    }).catch(() => {
      ioFailed = true;
      state.status = 'FAILED'; state.acceptance = 'FAILED'; state.error = { code: 'PERSISTENCE_FAILED' };
      haltTransport(); runtime?.close();
    });
  };
  const emit = (type, details = {}) => {
    const event = { id: `${runId}:${state.events.length + 1}`, type, at: new Date().toISOString(),
      monotonicMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
      proposalVersion: state.proposalVersion, evidenceVersion: state.evidenceVersion,
      ...JSON.parse(JSON.stringify(details)) };
    state.events.push(event);
    const line = `${JSON.stringify(event)}\n`;
    persistence = persistence.then(() => appendFile(join(runDirectory, 'events.jsonl'), line, 'utf8')).catch(() => {
      ioFailed = true; state.status = 'FAILED'; state.acceptance = 'FAILED'; state.error = { code: 'PERSISTENCE_FAILED' }; haltTransport(); runtime?.close();
    });
    persist();
    queueMicrotask(() => { try { onEvent(deepFreeze(clone(event))); } catch { /* Observers cannot mutate or fail the writer. */ } });
    return event;
  };
  runtime = createMozaikRuntime({ runner: guarded ? createProviderInferenceRunner({ ...transport, mode }) : createMockInferenceRunner(),
    mode, model: guarded ? 'planpatch-guarded-provider' : 'planpatch-deterministic-mock', onSignal(signal) {
    if (state.frozen) return;
    const agent = state.agents.find(item => item.id === signal.agentId);
    if (active() && agent) agent.status = signal.type === 'AGENT_STARTED' ? 'RUNNING' : 'IDLE';
    emit(signal.type, { ...signal, summary: signal.type === 'LATE_RESULT_DISCARDED' ? '停止后到达的结果已丢弃。' : `${signal.agentId} ${signal.kind}` });
  } });
  state.agents.forEach(agent => { agent.mozaikParticipantId = runtime.identities.find(item => item.id === agent.id).mozaikParticipantId; });
  emit('RUN_CREATED', { summary: live ? '可信 CLI 入口；真实请求计数独立保留，未自动通过 LIVE 验收。'
    : offline ? '仅 OFFLINE_TRANSPORT；注入合成测试预算和 fake fetch，非用户支出授权。' : '仅 MOCK；真实网络生成、云端遥测与提交均未启用。' });

  const failRun = error => {
    if (['STOPPED', 'FAILED'].includes(state.status)) return;
    haltTransport();
    state.status = 'FAILED'; state.acceptance = 'FAILED';
    const codes = new Set(['MOCK_BUDGET_EXHAUSTED', 'PERSISTENCE_FAILED', 'STALE_PATCH', 'STALE_RECHECK', 'INVALID_FACT_OUTPUT',
      'UNSUPPORTED_PATCH', 'INVALID_AGENT_OUTPUT', 'HTTP_FAILURE', 'TIMEOUT', 'NETWORK_ERROR', 'ABORTED', 'BODY_LIMIT',
      'INVALID_RESPONSE', 'MODEL_MISMATCH', 'INCOMPLETE_RESPONSE', 'STAGE_HALTED', 'BUDGET_SETTLEMENT_FAILURE',
      'TASK_POST_LIMIT', 'STAGE_POST_LIMIT', 'STAGE_CNY_LIMIT', 'PRICE_EVIDENCE_STALE', 'EVENT_DEADLINE_PASSED',
      'SOURCE_REVISION_MISMATCH', 'PRICE_EVIDENCE_HASH_MISMATCH', 'AUTHORIZATION_CHANGED']);
    const code = codes.has(error?.code) ? error.code : 'CORE_RUN_FAILED';
    state.error = { code }; state.agents.forEach(agent => { agent.status = 'FAILED'; });
    runtime.close();
    emit('RUN_FAILED', { code, summary: '运行已失败关闭；没有自动重试，不推断远端取消或费用退回。' });
  };

  const reserve = purposes => {
    assertActive();
    try {
      if (guarded) transport.beforeDispatch?.();
      const slots = guarded ? budget.reserveBatch({ taskId: transport.taskId, runId,
        requests: purposes.map(purpose => ({ purpose: purpose.startsWith('recheck:') ? 'mandatory_recheck' : purpose === 'owner' ? 'revision' : 'initial' })) }) : budget.reserveBatch(purposes);
      emit(guarded ? 'TRANSPORT_SLOTS_RESERVED' : 'MOCK_SLOTS_RESERVED', { slots: slots.map(item => item.id), purposes, summary: `已原子持有 ${slots.length} 个${guarded ? '请求' : '离线逻辑'}额度。` });
      return slots;
    } catch (error) { emit(guarded ? 'TRANSPORT_BUDGET_REJECTED' : 'MOCK_BUDGET_EXHAUSTED', { summary: '请求门禁拒绝；不提交未持有复查额度的修改。' }); throw error; }
  };
  const task = (agentId, kind, slot, requirements = ['all']) => {
    assertActive();
    if (!guarded) budget.consume(slot);
    const payload = taskPayload(agentId, kind, state, requirements);
    if (!guarded) state.counters.mockInvocations++;
    state.counters.maxConcurrentAgents = Math.max(state.counters.maxConcurrentAgents, runtime.activeCount + 1);
    emit('AGENT_DISPATCHED', { agentId, kind, slotId: slot.id, requirements,
      baseProposalVersion: payload.snapshot.proposalVersion, baseEvidenceVersion: payload.snapshot.evidenceVersion,
      snapshotSha256: hash(encoded(payload.snapshot)),
      summary: `${agentId} 读取方案 v${state.proposalVersion} / 证据 v${state.evidenceVersion}。` });
    const executionOptions = guarded ? { reservationId: slot.id, signal: abortController.signal,
      traceContext: { runId, agentId, attemptId: slot.id }, onTrace(trace) {
        if (state.frozen) return;
        if (trace.type === 'POST_STARTED') {
          if (live) { state.counters.realGenerationPosts++; state.counters.generationPosts++; }
          else state.counters.fakeGenerationPosts++;
        }
        emit(trace.type, { ...trace, providerMonotonicMs: trace.monotonicMs,
          monotonicMs: Math.round((trace.monotonicMs - startedAt) * 1000) / 1000,
          mode, transportKind: live ? 'NATIVE_FETCH' : 'INJECTED_FAKE', realGenerationPosts: state.counters.realGenerationPosts });
      } } : {};
    return runtime.dispatch(agentId, payload, executionOptions).catch(error => {
      // Observe B failures immediately while A/C are pending. The halt fences every writer.
      failRun(error);
      throw error;
    });
  };
  const publishChecks = output => {
    if (!active()) return false;
    const result = applyVersionedChecks(state, output);
    emit(result.applied ? 'CHECKS_PUBLISHED' : 'CHECK_REJECTED', { agentId: 'B', code: result.code,
      baseProposalVersion: output.baseProposalVersion, baseEvidenceVersion: output.baseEvidenceVersion,
      checkIds: output.checks?.map(item => item.id), summary: result.applied ? '检查已发布，并绑定当前双版本。' : '旧版本检查不可覆盖当前方案。' });
    return result.applied;
  };
  const execute = async () => {
    state.status = 'RUNNING'; emit('RUN_STARTED');
    let initialReview;
    try {
      const initialSlots = reserve(guarded ? ['facts', 'review', 'owner'] : ['facts', 'review']);
      // Both calls dispatch synchronously into different actual Mozaik Agent handlers.
      const factsPromise = task('A', 'facts', initialSlots[0]);
      initialReview = task('B', 'review', initialSlots[1]);
      // Capture rejection immediately, including if A fails/stops before B settles.
      initialReview.catch(() => {});
      const output = await factsPromise;
      assertActive();
      const derived = extractEvidence(state.sources);
      if (!versionsMatch(state, output) || JSON.stringify(output.evidence) !== JSON.stringify(derived)
        || JSON.stringify(output.findings) !== JSON.stringify(evidenceFindings(derived, state.proposal))) throw codedError('INVALID_FACT_OUTPUT');
      state.evidence = clone(output.evidence); state.findings = clone(output.findings);
      state.unresolved = clone(output.evidence.unknowns); state.evidenceVersion++;
      state.checks = [];
      const evidenceEvent = emit('EVIDENCE_PUBLISHED', { agentId: 'A', findingIds: state.findings.map(item => item.id),
        summary: '新事实已形成独立证据版本；立即通知方案负责人。' });
      const ownerSlot = guarded ? initialSlots[2] : reserve(['owner'])[0];
      emit('OWNER_SNAPSHOT_TRIGGERED', { agentId: 'C', causedBy: evidenceEvent.id, consumedEvidenceVersion: state.evidenceVersion,
        summary: 'C 由新证据触发，不等待 B 整轮结束。' });
      const patch = await task('C', 'owner', ownerSlot);
      assertActive();
      if (!versionsMatch(state, patch)) {
        emit('PATCH_REJECTED', { agentId: 'C', code: 'STALE_PATCH', summary: '旧快照补丁被拒绝。' });
        throw codedError('STALE_PATCH');
      }
      const requirements = affectedRequirements(patch.changes ?? []);
      // Atomic hold for ALL affected checks precedes the sole deterministic proposal writer.
      // One bounded inference checks the complete affected set on one snapshot.
      // The slot covers every requirement; it is held before the sole writer.
      const checkIds = requirements.length ? requirements : ['all'];
      const recheckSlots = reserve(['recheck:all']);
      const recheckCoverage = [{ slotId: recheckSlots[0].id, requirements: [...checkIds] }];
      assertActive();
      const result = applyVersionedPatch(state, patch, { requirements });
      if (!result.applied && result.code !== 'NO_CHANGE') throw codedError(result.code);
      state.artifactStatus = 'CANDIDATE';
      if (result.applied) {
        state.decisions.push({ id: `revision-${state.proposalVersion}`, agentId: 'C', summary: '按一致材料最小修订方案并同步附件；未知事项保留。',
          changes: clone(patch.changes), sourceIds: [...new Set(patch.changes.flatMap(change => change.sourceIds))],
          proposalVersion: state.proposalVersion, evidenceVersion: state.evidenceVersion });
        emit('PATCH_APPLIED', { agentId: 'C', changes: clone(patch.changes), affectedRequirements: requirements,
          heldRecheckSlots: recheckSlots.map(item => item.id), recheckCoverage, summary: '单写入者已提交补丁；完整受影响集合的复查额度已持有。' });
      } else {
        state.decisions.push({ id: 'no-change', agentId: 'C', summary: '没有支持改动的新事实，方案和附件保持原样。' });
        emit('NO_CHANGE', { agentId: 'C', summary: '材料与方案一致，无需为改写而改写。' });
      }
      const oldChecks = await initialReview;
      assertActive();
      publishChecks(oldChecks);
      assertActive();
      emit('AFFECTED_RECHECK_STARTED', { agentId: 'B', slotId: recheckSlots[0].id, requirements: checkIds, summary: '按同一快照完整复查所有受影响要求。' });
      const checked = await task('B', 'recheck', recheckSlots[0], checkIds);
      assertActive();
      // Guard the writer as well as the transport protocol: no partial batch.
      const expectedIds = evaluateChecks(state, checkIds).checks.map(item => item.id);
      if (!Array.isArray(checked.checks) || JSON.stringify(checked.checks.map(item => item.id)) !== JSON.stringify(expectedIds)
        || !publishChecks(checked)) throw codedError('STALE_RECHECK');
      // Nonaffected requirements still need current-version checks. The same deterministic B
      // review result is complete; publishing a local policy evaluation is NOT another inference.
      const currentIds = new Set(state.checks.map(item => item.id));
      const policyChecks = evaluateChecks(state).checks.filter(item => !currentIds.has(item.id));
      if (policyChecks.length) {
        const policyResult = { baseProposalVersion: state.proposalVersion, baseEvidenceVersion: state.evidenceVersion, checks: policyChecks };
        applyVersionedChecks(state, policyResult);
        emit('POLICY_CHECKS_PUBLISHED', { checkIds: policyChecks.map(item => item.id), summary: '本地固定规则补足未受补丁影响的检查；不计作模型推理。' });
      }
      for (const check of state.checks.filter(item => item.status === 'UNKNOWN')) if (!state.unresolved.some(item => item.id === check.id))
        state.unresolved.push({ id: check.id, summary: check.summary, sourceIds: check.sourceIds });
      state.acceptance = state.checks.some(item => item.status === 'FAIL') ? 'FAILED' : 'CONDITIONAL';
      state.status = 'FINISHED'; state.agents.forEach(agent => { agent.status = 'DONE'; });
      emit('RUN_FINISHED', { summary: `核对结束；${mode}、未知事项与人工复核边界继续保留。` });
    } catch (error) {
      failRun(error);
      runtime.close();
    } finally {
      if (initialReview) await initialReview.catch(() => {});
      await persistence;
    }
    return snapshot();
  };

  const freeze = async () => {
    if (frozenBundle) return frozenBundle;
    if (freezing) return freezing;
    if (['CREATED', 'RUNNING'].includes(state.status)) throw codedError('RUN_NOT_COMPLETE');
    freezing = (async () => {
      if (execution) await execution;
      await persistence;
      if (ioFailed) throw codedError('PERSISTENCE_FAILED');
      runtime.close(); state.artifactStatus = 'FROZEN'; state.frozen = true;
      emit('ARTIFACT_FROZEN', { summary: `冻结快照与文件清单，SHA-256 绑定；仍为 ${mode}，不能据此宣称可提交。` });
      await persistence;
      if (ioFailed) throw codedError('PERSISTENCE_FAILED');
      const bundle = { schemaVersion: 1, mode, runId, createdAt: new Date().toISOString(), productRevision,
        ...(fullSourceRevision ? { fullSourceRevision } : {}), snapshot: snapshot() };
      const files = artifactFiles(bundle.snapshot);
      bundle.manifest = { algorithm: 'SHA-256', payloadSha256: hash(encoded(payloadOf(bundle))), coreSources: sourceHashes,
        files: Object.entries(files).map(([path, data]) => ({ path, sha256: hash(data), bytes: Buffer.byteLength(data) })) };
      try {
        const directory = join(runDirectory, 'frozen'); await mkdir(directory);
        for (const [path, data] of Object.entries(files)) await writeFile(join(directory, path), data, { encoding: 'utf8', flag: 'wx' });
        await writeFile(join(directory, 'bundle.json'), encoded(bundle), { encoding: 'utf8', flag: 'wx' });
      } catch {
        // A partial export is retained for diagnosis, never presented as a completed freeze.
        state.frozen = false; state.artifactStatus = 'CANDIDATE'; state.status = 'FAILED'; state.acceptance = 'FAILED';
        state.error = { code: 'FREEZE_PERSISTENCE_FAILED' };
        emit('ARTIFACT_FREEZE_FAILED', { code: 'FREEZE_PERSISTENCE_FAILED', summary: '冻结文件未完整写入；保留局部文件，不自动重试或覆盖。' });
        await persistence;
        throw codedError('FREEZE_PERSISTENCE_FAILED');
      }
      frozenBundle = deepFreeze(bundle);
      return frozenBundle;
    })();
    return freezing;
  };
  return {
    start() {
      if (state.frozen) return Promise.resolve(snapshot());
      if (execution) return execution;
      if (state.status !== 'CREATED') return Promise.resolve(snapshot());
      execution = execute();
      return execution;
    },
    async stop() {
      if (state.frozen || ['FINISHED', 'FAILED'].includes(state.status)) return;
      if (state.status !== 'STOPPED') {
        haltTransport();
        state.status = 'STOPPED'; state.acceptance = 'FAILED'; state.agents.forEach(agent => { agent.status = 'STOPPED'; });
        runtime.close(); emit('RUN_STOPPED', { summary: '已阻止后续调度和结果发布；不声称远端取消或费用退回。' });
      }
      if (execution) await execution;
      await persistence;
    },
    snapshot, freeze,
  };
}

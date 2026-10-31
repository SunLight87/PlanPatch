import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { StageBudget } from '../src/budget.mjs';
import { createProvider } from '../src/provider.mjs';
import { extractEvidence, evidenceFindings, proposeRevision, evaluateChecks } from '../src/domain.mjs';

const NOW = Date.UTC(2026, 9, 30, 12);
// This helper creates synthetic TEST authorization only. It is not user spending
// authorization and never opens existing project ledgers or reads credentials.
export function roleResult(task) {
  let result;
  if (task.kind === 'facts') {
    const evidence = extractEvidence(task.snapshot.sources);
    result = { baseProposalVersion: task.snapshot.proposalVersion, baseEvidenceVersion: task.snapshot.evidenceVersion,
      evidence, findings: evidenceFindings(evidence, task.snapshot.proposal) };
  } else if (task.kind === 'owner') result = proposeRevision(task.snapshot);
  else result = evaluateChecks(task.snapshot, task.requirements);
  return { schemaVersion: 1, agentId: task.agentId, kind: task.kind, ...result };
}
export function providerResponse(content, { status = 200, finishReason = 'stop', message = {}, headers = {} } = {}) {
  return new Response(status !== 200 ? JSON.stringify({ error: 'synthetic failure' }) : JSON.stringify({ model: 'synthetic-model',
    choices: [{ finish_reason: finishReason, message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content), ...message } }],
    usage: null }), { status, headers });
}
export function createOfflineTransportFixture({ root, maximumPosts = 8, maximumSpendCny = '1', taskIds = ['task-1'],
  delays = { facts: 5, review: 120, owner: 5, recheck: 1 }, respond, timeoutMs = 10000,
  holdReview = false, holdFacts = false, holdOwner = false, releaseReviewOnOwner = false } = {}) {
  let clock = NOW, inFlight = 0;
  let releaseReview;
  const reviewGate = new Promise(resolve => { releaseReview = resolve; });
  let releasePending;
  const pendingGate = new Promise(resolve => { releasePending = resolve; });
  const requests = [], stats = { fakePosts: 0, maximumInFlight: 0, realGenerationPosts: 0 };
  const authorization = { granted: true, id: 'synthetic-transport-auth', stageId: 'synthetic-transport-stage', currency: 'CNY',
    maximumSpendCny, maximumPosts, allowedTaskIds: taskIds,
    ledgerDirectory: join(root, 'synthetic-ledger'), identityFile: join(root, 'synthetic-stage-identity.json'),
    requestPolicy: { endpoint: 'https://offline.invalid/v1/chat/completions', model: 'synthetic-model', maxOutputTokens: 1024,
      maxRequestBytes: 64000, cashUpperBoundCny: '0.1', evidenceSha256: 'c'.repeat(64),
      verifiedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 1_800_000).toISOString(), coversAllBillableTokens: true } };
  const openBudget = () => StageBudget.open({ authorization, now: () => clock });
  const budget = openBudget();
  const provider = createProvider({ budget, ...authorization.requestPolicy, apiKey: 'synthetic_not_a_real_credential_12345', timeoutMs,
    async fetchImpl(endpoint, options) {
      if (endpoint !== authorization.requestPolicy.endpoint || options.method !== 'POST') throw new Error('SYNTHETIC_REQUEST_REJECTED');
      const body = JSON.parse(options.body), task = JSON.parse(body.messages.findLast(item => item.role === 'user').content);
      const request = { task, index: ++stats.fakePosts, startedMs: performance.now(), endedMs: null };
      requests.push(request); inFlight++; stats.maximumInFlight = Math.max(stats.maximumInFlight, inFlight);
      try {
        await new Promise(resolve => setTimeout(resolve, delays[task.kind] ?? 0));
        if (holdReview && task.kind === 'review') await reviewGate;
        if ((holdFacts && task.kind === 'facts') || (holdOwner && task.kind === 'owner')) await pendingGate;
        const result = roleResult(task);
        return respond ? await respond({ task, result, request, signal: options.signal }) : providerResponse(result);
      } finally { inFlight--; request.endedMs = performance.now(); }
    } });
  return { authorization, budget, provider, requests, stats, openBudget, releaseReview,
    onEvent(event) {
      if (releaseReviewOnOwner && event.type === 'AGENT_STARTED' && event.agentId === 'C') releaseReview();
      if (['PATCH_APPLIED', 'NO_CHANGE', 'RUN_STOPPED', 'RUN_FAILED'].includes(event.type)) releaseReview();
      if (['RUN_STOPPED', 'RUN_FAILED'].includes(event.type)) releasePending();
    },
    setClock(value) { clock = value; }, now: NOW,
    transport: { offline: true, taskId: taskIds[0], budget, provider }, close() { budget.close(); } };
}


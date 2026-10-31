import { networkGuardSnapshot } from './offline-network-guard.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { root, revisionManifest, sha256 } from './revision.mjs';
import { createRun, verifyFrozenBundle } from '../src/coordinator.mjs';
import { createOfflineTransportFixture } from '../test/transport-fixtures.mjs';

// A reproducible fake-HTTP integration demo, never a real spending authorization.
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const outputDirectory = path.join(root, 'var', 'offline-transport', stamp);
await mkdir(outputDirectory, { recursive: true });
const revision = await revisionManifest();
const input = JSON.parse(await readFile(path.join(root, 'samples/community-update.json'), 'utf8'));
const fixture = createOfflineTransportFixture({ root: outputDirectory, holdReview: true, delays: { facts: 10, review: 1, owner: 1, recheck: 1 } });
let report;
try {
  const run = await createRun({ input, mode: 'OFFLINE_TRANSPORT', runDirectory: path.join(outputDirectory, 'run'), transport: fixture.transport, onEvent: fixture.onEvent });
  const result = await run.start();
  assert.equal(result.status, 'FINISHED');
  assert.equal(result.mode, 'OFFLINE_TRANSPORT');
  assert.equal(result.counters.realGenerationPosts, 0);
  assert.equal(fixture.stats.fakePosts, 7);
  const events = result.events;
  const find = type => events.find(event => event.type === type);
  const starts = events.filter(event => event.type === 'POST_STARTED');
  const end = start => events.find(event => event.type === 'POST_ENDED' && event.reservationId === start.reservationId);
  assert.equal(starts.length, 7);
  const a = starts.find(event => event.agentId === 'A');
  const b = starts.find(event => event.agentId === 'B');
  const c = starts.find(event => event.agentId === 'C');
  const overlapMs = Math.min(end(a).monotonicMs, end(b).monotonicMs) - Math.max(a.monotonicMs, b.monotonicMs);
  assert.ok(overlapMs > 0);
  assert.ok(c.monotonicMs >= end(a).monotonicMs && end(c).monotonicMs < end(b).monotonicMs);
  assert.equal(find('OWNER_SNAPSHOT_TRIGGERED').causedBy, find('EVIDENCE_PUBLISHED').id);
  assert.equal(find('OWNER_SNAPSHOT_TRIGGERED').consumedEvidenceVersion, 1);
  assert.ok(find('PATCH_APPLIED').monotonicMs < end(b).monotonicMs);
  assert.equal(find('CHECK_REJECTED').code, 'STALE_CHECK');
  const budget = fixture.budget.inspect();
  assert.equal(budget.reservedPosts, 7);
  assert.equal(budget.halted, false);
  assert.ok(budget.reservations.every(item => item.status === 'SUCCEEDED'));
  const bundle = await run.freeze();
  assert.ok(verifyFrozenBundle(bundle));
  for (const item of bundle.manifest.files) {
    const bytes = await readFile(path.join(outputDirectory, 'run/frozen', item.path));
    assert.equal(bytes.length, item.bytes); assert.equal(sha256(bytes), item.sha256);
  }
  const networkGuard = networkGuardSnapshot();
  assert.equal(networkGuard.externalAttempts, 0);
  report = { status: 'PASS', mode: 'OFFLINE_TRANSPORT', transportKind: 'INJECTED_FAKE', recordedAt: new Date().toISOString(),
    runId: result.runId, outputDirectory, productRevision: revision.productRevision,
    fakePosts: fixture.stats.fakePosts, realGenerationPosts: 0, fakePostOverlapMs: overlapMs,
    causalChecks: ['A/B fake POST intervals overlap', 'A evidence event causes C fresh snapshot', 'C completes and patch commits before initial B ends',
      'stale B result rejected', 'mandatory rechecks held before mutation', 'all seven reservations consumed in one stage', 'six frozen artifact hashes match'],
    artifactFilesVerified: bundle.manifest.files.length, networkGuard,
    traceClock: 'Monotonic timestamps relative to run start; provider captures actual invocation/transport settlement',
    intervals: starts.map(start => ({ agentId: start.agentId, reservationId: start.reservationId, attemptId: start.attemptId,
      startMs: start.monotonicMs, endMs: end(start).monotonicMs, outcome: end(start).outcome,
      remoteOutcome: end(start).remoteOutcome, policyRevision: start.policyRevision })),
    stageBudget: budget, liveAcceptance: 'NOT_RUN', readyToSubmit: false,
    limitations: ['Synthetic authorization, price evidence, credential string, responses and usage; no real provider contacted',
      'Fake timing is deliberately controlled and does not measure model performance', 'No A01/A02 LIVE or human semantic acceptance'] };
  await writeFile(path.join(outputDirectory, 'product-revision.json'), JSON.stringify(revision, null, 2) + '\n');
  await writeFile(path.join(outputDirectory, 'frozen-bundle.json'), JSON.stringify(bundle, null, 2) + '\n');
  await writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
} finally { fixture.close(); }
await writeFile(path.join(root, 'var/latest-offline-transport.json'), JSON.stringify({ outputDirectory, runId: report.runId,
  mode: report.mode, productRevision: report.productRevision }, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, mode: report.mode, runId: report.runId, outputDirectory,
  fakePosts: report.fakePosts, realGenerationPosts: 0, fakePostOverlapMs: report.fakePostOverlapMs, productRevision: report.productRevision }, null, 2));

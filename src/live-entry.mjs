import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRun } from './coordinator.mjs';
import { openTrustedStage, preflightLive, PHASE_ID } from './trusted-stage.mjs';

const coded = code => Object.assign(new Error(code), { code });

/** Public production API has no dependency, path, credential, endpoint or fetch overrides. */
export async function runLive(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => !['send', 'taskId'].includes(key)) || (options.send !== undefined && typeof options.send !== 'boolean'))
    throw coded('INVALID_LIVE_OPTIONS');
  if (options.send !== true) return preflightLive({ taskId: options.taskId });
  const stage = openTrustedStage(options);
  let run, interrupted = false, stopping, signalName;
  const stop = signal => {
    interrupted = true; signalName ??= signal;
    // Durable latch happens synchronously, before any signal-triggered await.
    stage.stop();
    if (run) stopping ??= run.stop();
  };
  const sigint = () => stop('SIGINT'), sigterm = () => stop('SIGTERM');
  process.on('SIGINT', sigint); process.on('SIGTERM', sigterm);
  try {
    await mkdir(stage.runDirectory, { recursive: true });
    if (interrupted) throw coded('CLI_CANCELLED_BEFORE_RUN');
    run = await createRun({ input: stage.input, mode: 'LIVE', runDirectory: stage.runDirectory, transport: stage.transport });
    // A signal during asynchronous initialization must also stop a CREATED run.
    if (interrupted) await run.stop();
    const result = await run.start();
    if (stopping) await stopping;
    const bundle = await run.freeze();
    const report = { schemaVersion: 1, phaseId: PHASE_ID, mode: 'LIVE', status: result.status,
      productRevision: stage.productRevision, coreRevision: bundle.productRevision, runId: result.runId,
      ...(stage.recovery ? { recovery: stage.recovery } : {}),
      realGenerationPosts: bundle.snapshot.counters.realGenerationPosts, fakeGenerationPosts: 0,
      liveAcceptance: 'NOT_CHECKED', readyToSubmit: false, interrupted, signal: signalName ?? null,
      remoteCancellation: 'UNKNOWN', remoteUsage: null, outputDirectory: stage.runDirectory,
      ...(result.error ? { error: result.error } : {}) };
    await writeFile(path.join(stage.runDirectory, 'live-report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return report;
  } catch (error) {
    stage.stop();
    if (run) {
      await run.stop();
      // Retain a safe partial/final artifact if possible. Never retry failed freeze.
      if (!run.snapshot().frozen && run.snapshot().error?.code !== 'FREEZE_PERSISTENCE_FAILED') await run.freeze().catch(() => {});
    }
    const code = error?.code && /^[A-Z][A-Z0-9_]+$/.test(error.code) ? error.code : 'LIVE_ENTRY_FAILED';
    const snapshot = run?.snapshot();
    const failureReport = { schemaVersion: 1, phaseId: PHASE_ID, mode: 'LIVE', status: 'FAILED',
      productRevision: stage.productRevision, runId: snapshot?.runId ?? null,
      ...(stage.recovery ? { recovery: stage.recovery } : {}),
      realGenerationPosts: snapshot?.counters.realGenerationPosts ?? 0, fakeGenerationPosts: 0,
      liveAcceptance: 'NOT_CHECKED', readyToSubmit: false, interrupted, signal: signalName ?? null,
      remoteCancellation: 'UNKNOWN', remoteUsage: null, outputDirectory: stage.runDirectory, error: { code } };
    // Failed persistence can prevent even this safe report; retain partial artifacts
    // and the stopped ledger rather than overwriting/retrying a completed report.
    await writeFile(path.join(stage.runDirectory, 'live-report.json'), `${JSON.stringify(failureReport, null, 2)}\n`, { flag: 'wx', mode: 0o600 }).catch(() => {});
    throw coded(code);
  } finally {
    process.removeListener('SIGINT', sigint); process.removeListener('SIGTERM', sigterm);
    stage.close();
  }
}

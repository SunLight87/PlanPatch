import { preflightTrustedRecovery, activateTrustedRecovery } from '../src/trusted-stage.mjs';

// This command never creates an authorization, chooses a path, reads a key or
// sends a request. The default is read-only; activation consumes a recorded,
// exact-checkpoint human recovery grant, retaining the original stage identity.
try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--activate'))
    throw Object.assign(new Error('INVALID_CLI_ARGUMENTS'), { code: 'INVALID_CLI_ARGUMENTS' });
  const report = args.length ? activateTrustedRecovery({ activate: true }) : preflightTrustedRecovery();
  console.log(JSON.stringify(report, null, 2));
  if (report.status === 'BLOCKED') process.exitCode = 2;
} catch (error) {
  console.log(JSON.stringify({ status: 'BLOCKED', code: error.code ?? 'RECOVERY_FAILED', realGenerationPosts: 0,
    liveAcceptance: 'NOT_RUN', readyToSubmit: false }));
  process.exitCode = 2;
}

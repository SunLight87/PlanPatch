import { runLive } from '../src/live-entry.mjs';

function parse(args) {
  const result = {}; const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!['--send', '--task'].includes(flag) || seen.has(flag)) throw Object.assign(new Error('INVALID_CLI_ARGUMENTS'), { code: 'INVALID_CLI_ARGUMENTS' });
    seen.add(flag);
    if (flag === '--send') result.send = true;
    else {
      const value = args[++index];
      if (!value || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) throw Object.assign(new Error('INVALID_CLI_ARGUMENTS'), { code: 'INVALID_CLI_ARGUMENTS' });
      result.taskId = value;
    }
  }
  return result;
}
try {
  const report = await runLive(parse(process.argv.slice(2)));
  console.log(JSON.stringify(report, null, 2));
  if (report.status === 'BLOCKED' || ['FAILED', 'STOPPED'].includes(report.status)) process.exitCode = 2;
} catch (error) {
  console.log(JSON.stringify({ status: 'BLOCKED', code: error.code ?? 'LIVE_ENTRY_FAILED',
    liveAcceptance: 'NOT_RUN', readyToSubmit: false }));
  process.exitCode = 2;
}

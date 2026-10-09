import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork, spawnSync } from 'node:child_process';
import { CopilotClient, RuntimeConnection, ToolSet } from '@github/copilot-sdk';
import { configAt, requireThat, safeError } from '../src/common.js';
import { cliPath, prepareWorkiq, workiqRuntimeError } from '../src/runtime.js';

export async function probeWorkiq(client, pluginDirectories) {
  const report = { status: 'blocked', phase: 'client-start' };
  let session;
  try {
    await client.start();
    report.phase = 'session-create';
    session = await client.createSession({
      pluginDirectories, enableConfigDiscovery: false,
      mcpOAuthTokenStorage: 'persistent', availableTools: new ToolSet().addMcp('workiq-fetch'),
      onPermissionRequest: () => ({ kind: 'denied-by-rules' })
    });
    report.phase = 'readiness';
    report.lifecycle = {};
    await prepareWorkiq(session, report.lifecycle);
    report.status = 'discovery-ready';
    report.phase = 'discovery-complete';
    report.discovery = 'fetch-advertised; principal and collection still unverified';
  } catch (error) {
    report.phase = report.lifecycle?.phase ?? report.phase;
    report.error = safeError(workiqRuntimeError(error, report.phase));
  } finally {
    try { await session?.disconnect(); }
    catch (error) { report.disconnectError = safeError(workiqRuntimeError(error, 'runtime')); }
    try {
      const errors = await client.stop();
      if (errors?.length) report.stopError = { code: 'blocked-runtime', message: 'Runtime stop reported cleanup errors; raw details suppressed.' };
    } catch (error) { report.stopError = safeError(workiqRuntimeError(error, 'runtime')); }
  }
  if (report.disconnectError || report.stopError) report.status = 'blocked';
  return report;
}

async function inspect(args) {
  let configPath = 'pilot.example.json';
  let probe = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--probe') probe = true;
    else if (args[i] === '--config') {
      requireThat(args[i + 1] && !args[i + 1].startsWith('--'), '--config requires a file path');
      configPath = args[++i];
    } else requireThat(false, 'Only --config <path> and --probe are supported');
  }
  const config = configAt(configPath);
  const executable = cliPath(config.runtime.cliPath);
  const version = spawnSync(executable, ['--no-auto-update', '--version'], { encoding: 'utf8' });
  const cliVersion = version.stdout?.match(/GitHub Copilot CLI (\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/)?.[1];
  requireThat(version.status === 0 && cliVersion, 'Could not read the installed CLI version', 'blocked-runtime');
  const report = {
    mode: probe ? 'explicit-single-discovery-probe' : 'offline-context-only',
    cliVersion, status: 'not-probed',
    agentSessionMarkerPresent: Boolean(process.env.COPILOT_AGENT_SESSION_ID),
    copilotHomeOverridePresent: Boolean(process.env.COPILOT_HOME),
    keychainDisableOverridePresent: Boolean(process.env.COPILOT_DISABLE_KEYTAR),
    sdkMode: 'copilot-cli', configDirectoryOverride: false, enableConfigDiscovery: false,
    explicitPluginDirectory: true, mcpOAuthTokenStorage: 'persistent',
    principalRead: false, evidenceReads: 0, modelCalls: 0, authRecoveryInvoked: false,
    unstructuredRuntimeOutput: 'suppressed'
  };
  if (probe) {
    const client = new CopilotClient({
      connection: RuntimeConnection.forStdio({ path: executable }),
      mode: 'copilot-cli', workingDirectory: config.stateDirectory, logLevel: 'error', useLoggedInUser: true
    });
    Object.assign(report, await probeWorkiq(client, [config.runtime.workiqPluginDirectory]));
  }
  return report;
}

const scriptPath = fileURLToPath(import.meta.url);
export function isolatedReport(args, entrypoint = scriptPath) {
  // SDK stderr is forwarded verbatim; only our structured IPC report may leave the child.
  return new Promise(resolveReport => {
    const child = fork(entrypoint, args, { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let report;
    child.once('message', message => { report = message; });
    child.once('error', () => {
      report = { status: 'blocked', error: { code: 'blocked-runtime', message: 'Repro process failed; raw details suppressed.' } };
    });
    child.once('close', code => resolveReport(code === 0 && report ? report : {
      status: 'blocked', error: { code: 'blocked-runtime', message: 'Repro process did not finish normally; raw output suppressed.' }
    }));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  let report;
  if (process.send) {
    try { report = await inspect(process.argv.slice(2)); }
    catch (error) { report = { status: 'blocked', error: safeError(workiqRuntimeError(error, 'runtime')) }; }
    process.send(report);
  } else {
    report = await isolatedReport(process.argv.slice(2));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === 'blocked' ? 2 : 0;
  }
}

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const native = require('./1js-declarative-e2e.cjs');

let stage = 'native-load';
function main() {
  const request = native.validateRequest(JSON.parse(process.env.PILOT_DECLARATIVE_REQUEST));
  const root = fs.realpathSync(process.cwd());
  assert.equal(request.options.installDependencies, false);
  Object.assign(process.env, {
    DONT_UPDATE_ENV: 'true', XLO_OMNI_FLIGHT: 'true',
    XLO_SHARED_AGENT_SHELL_FLIGHT: 'true'
  });
  delete process.env.EXCELAGENT_CDP_ENDPOINT;
  const api = native.nativeApi(root);
  const selected = native.selectCases(root, request, api);
  const selection = api.loader.loadExcelAgentExecutionSelection();
  assert(selected.every(item => selection.enabledCaseKeys.includes(item.scenario.id)));
  console.log(`PILOT_PREFLIGHT_SELECTION:${JSON.stringify({
    caseIds: selected.map(item => item.scenario.id),
    declarations: selected.map(({ file, sha256 }) => ({ file, sha256 })),
    nativeCaseInvocations: 0
  })}`);
  const app = path.join(root, native.APP);
  for (const command of ['typecheck', 'declarative:validate-repair']) {
    stage = command;
    execFileSync(process.execPath, [request.options.yarnEntryPoint, '--silent', command], {
      cwd: app, env: {
        ...process.env,
        PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}`
      },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      timeout: request.options.commandTimeoutMs ?? 600000,
      maxBuffer: 4 * 1024 * 1024
    });
  }
  console.log('PILOT_PREFLIGHT_NATIVE:passed');
}
try { main(); }
catch (error) {
  const output = `${error.message ?? ''}\n${error.stdout ?? ''}\n${error.stderr ?? ''}`;
  const missing = output.match(/Cannot find module '(@?[A-Za-z0-9_./-]+)'/);
  console.log(`PILOT_PREFLIGHT_FAILURE:${JSON.stringify({
    stage, exitCode: Number.isInteger(error.status) ? error.status : null,
    missingModule: missing?.[1] ?? null,
    typeErrors: [...new Set(output.match(/\bTS\d{4,6}\b/g) ?? [])]
  })}`);
  process.exitCode = 1;
}

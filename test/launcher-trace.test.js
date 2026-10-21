import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { nativeCommand } from '../src/native-command.js';
import { minimalEnvironment, command } from '../src/workers.js';

async function waitForProcessExit(pid) {
  try {
    return await command('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
      fileURLToPath(new URL('./fixtures/wait-for-process-exit.ps1', import.meta.url)),
      '-ProcessId', String(pid)], process.cwd(), 15000, minimalEnvironment());
  } catch (error) {
    error.message += `\nExit-barrier diagnostics: ${JSON.stringify({
      code: error.code, signal: error.signal, killed: error.killed, stdout: error.stdout, stderr: error.stderr
    })}`;
    throw error;
  }
}

for (const mode of ['blocked-filesystem', 'dispatch-child']) test(`launcher traces ${mode} without changing native behavior`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'launcher-trace-'));
  let launcherPid;
  t.after(async () => {
    if (process.platform === 'win32' && launcherPid !== undefined) await waitForProcessExit(launcherPid);
    rmSync(root, { recursive: true, force: true });
  });
  const script = join(root, '.yarn', 'releases', 'synthetic.cjs');
  mkdirSync(join(root, '.yarn', 'releases'), { recursive: true });
  writeFileSync(script, mode === 'blocked-filesystem'
    ? `const fs=require('node:fs');while(true){try{fs.mkdirSync(${JSON.stringify(join(root, 'absent', 'child'))});}catch{}}`
    : `require('node:child_process').spawn(process.execPath,['-e',` +
      `'console.log(JSON.stringify({marker:process.env.OAGENT_ADO_ARTIFACTS_AUTHENTICATED,` +
      `options:process.env.NODE_OPTIONS,trace:process.env.PILOT_LAUNCHER_DIAGNOSTIC}))'],{stdio:'inherit'});`);
  const tracer = fileURLToPath(new URL('../src/launcher-trace.cjs', import.meta.url));
  const execution = nativeCommand(process.execPath, [script], root,
    // The Windows supervisor compiles its job-object helper before launching Node.
    // Leave enough startup headroom when the full test suite saturates the runner.
    mode === 'blocked-filesystem' ? 45000 : 5000, {
    ...minimalEnvironment(), OAGENT_ADO_ARTIFACTS_AUTHENTICATED: '1',
    NODE_OPTIONS: `--require=${JSON.stringify(tracer)}`,
    PILOT_LAUNCHER_DIAGNOSTIC: JSON.stringify({ directory: root })
  });
  if (mode === 'blocked-filesystem') await assert.rejects(execution, error => error.killed === true);
  else assert.deepEqual(JSON.parse((await execution).stdout), { marker: '1' });
  const trace = readFileSync(join(root, 'launcher-trace.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  launcherPid = trace[0].pid;
  assert.equal(trace[0].authHookSuppressed, true);
  assert.equal(trace[0].suppressionIsAuthenticationProof, false);
  assert.equal(trace[0].environmentNames.includes('NODE_OPTIONS'), false);
  assert.equal(trace[0].environmentNames.includes('PILOT_LAUNCHER_DIAGNOSTIC'), false);
  assert.ok(trace.some(row => row.point === 'module-load' && row.request === script));
  if (mode === 'blocked-filesystem') {
    const errors = trace.filter(row => row.point === 'mkdir-failed');
    assert.ok(errors.length >= 8 && errors.length <= 26);
    assert.equal(errors[0].code, 'ENOENT');
    assert.match(errors[0].stack, /synthetic.cjs/);
    assert.equal(trace.some(row => row.point === 'command-dispatch'), false);
  } else assert.ok(trace.some(row => row.point === 'command-returned' && row.childPid > 0));
  assert.throws(() => process.kill(trace[0].pid, 0), error => error.code === 'ESRCH');
});

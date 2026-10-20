import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { hash, requireThat } from './common.js';

const exec = promisify(execFile);
const supervisor = fileURLToPath(new URL('./native-command.ps1', import.meta.url));

export function nativeTemporaryDirectory(stateDirectory, key) {
  const path = join(stateDirectory, 'nt', hash(key).slice(0, 24));
  requireThat(process.platform !== 'win32' || path.length <= 180,
    'Native TEMP needs a shorter private stateDirectory for Windows Node compile-cache paths',
    'blocked-validation');
  return path;
}

export async function nativeCommand(executable, args, cwd, timeout, env) {
  const options = { cwd, env, windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' };
  if (process.platform !== 'win32') return exec(executable, args, options);
  const host = /^pwsh(?:\.exe)?$/i.test(basename(executable)) ? executable : 'pwsh.exe';
  const jobName = `Local\\PilotNative-${randomUUID()}`;
  const invoke = request => exec(host,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', supervisor], {
      ...options,
      ...(request.action === 'drain' ? { timeout: 20000 } : {}),
      env: { ...env, PILOT_NATIVE_COMMAND: JSON.stringify(request) }
    });
  let result, failure;
  try { result = await invoke({ executable, args, jobName }); }
  catch (error) { failure = error; }
  try { await invoke({ action: 'drain', jobName }); }
  catch {
    const error = failure ?? new Error('Native command process-tree exit was not confirmed');
    error.containmentFailure = true;
    throw error;
  }
  if (failure) {
    failure.ownedProcessesExited = true;
    throw failure;
  }
  return { ...result, ownedProcessesExited: true };
}

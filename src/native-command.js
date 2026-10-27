import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { hash, requireThat, PilotError } from './common.js';

const exec = promisify(execFile);
const supervisor = fileURLToPath(new URL('./native-command.ps1', import.meta.url));
// Cache only trusted code bytes, never a Job handle, child output or a mutable disk artifact.
const compiledJobs = new Map();

function compiledJob(host, options, jobName) {
  const key = JSON.stringify([host, options.env?.Path, options.env?.PATH,
    options.env?.SystemRoot, options.env?.SYSTEMROOT]);
  if (!compiledJobs.has(key)) {
    const compiled = exec(host,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', supervisor], {
        ...options, timeout: 20000, signal: undefined,
        env: { ...options.env, PILOT_NATIVE_COMMAND: JSON.stringify({ action: 'compile', jobName }) }
      }).then(({ stdout }) => {
      requireThat(/^[A-Za-z0-9+/]+={0,2}\r?\n$/.test(stdout),
        'Native job compilation did not produce an assembly', 'blocked-native-environment');
      return stdout;
    }).catch(error => {
      compiledJobs.delete(key);
      throw error;
    });
    compiledJobs.set(key, compiled);
  }
  return compiledJobs.get(key);
}

export function nativeTemporaryDirectory(stateDirectory, key) {
  const path = join(stateDirectory, 'nt', hash(key).slice(0, 24));
  requireThat(process.platform !== 'win32' || path.length <= 180,
    'Native TEMP needs a shorter private stateDirectory for Windows Node compile-cache paths',
    'blocked-validation');
  return path;
}

export function nativeCommand(executable, args, cwd, timeout, env, { signal } = {}) {
  const options = { cwd, env, signal, windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' };
  if (process.platform !== 'win32') return exec(executable, args, options);
  const pathExt = Object.entries(env ?? {}).find(([key]) => key.toUpperCase() === 'PATHEXT')?.[1];
  if (!(typeof pathExt === 'string' && pathExt.split(';').some(value => value.toUpperCase() === '.EXE')))
    return Promise.reject(new PilotError('blocked-native-environment',
      'Native validation requires PATHEXT including .EXE; restore the host environment before retrying'));
  const host = /^pwsh(?:\.exe)?$/i.test(basename(executable)) ? executable : 'pwsh.exe';
  const jobName = `Local\\PilotNative-${randomUUID()}`;
  const assembly = compiledJob(host, options, jobName);
  const invoke = request => {
    const launched = exec(host,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', supervisor], {
        ...options,
        ...(request.action === 'drain' ? { timeout: 20000, signal: undefined } : {}),
        env: { ...env, PILOT_NATIVE_COMMAND: JSON.stringify({ ...request, assemblyFromStdin: true }) }
      });
    let compilationFailed = false;
    const input = assembly.catch(error => {
      compilationFailed = true;
      throw error;
    }).then(bytes => pipeline(Readable.from([bytes]), launched.child.stdin)).catch(error => {
      launched.child.kill();
      throw error;
    });
    const completed = Promise.allSettled([launched, input]).then(([result, written]) => {
      if (compilationFailed) throw written.reason;
      if (result.status === 'rejected') throw result.reason;
      if (written.status === 'rejected') throw written.reason;
      return result.value;
    });
    completed.child = launched.child;
    return completed;
  };
  const launched = invoke({ executable, args, jobName });
  const completed = (async () => {
    let result, failure;
    try { result = await launched; }
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
  })();
  completed.child = launched.child;
  return completed;
}

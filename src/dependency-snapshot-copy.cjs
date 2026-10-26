const assert = require('node:assert/strict');
const { appendFileSync, closeSync, lstatSync, openSync, realpathSync } = require('node:fs');
const { basename, dirname, isAbsolute, join, relative, resolve, sep } = require('node:path');
const { spawnSync } = require('node:child_process');

let completedPaths = 0, activePath = null, failedPath = null, progressFd = null;
const copyTimings = [];
function progress(status, error = null) {
  // Bound synchronous journal writes while retaining each directory's copy timing.
  if (status === 'copying' && completedPaths % 10 !== 0) return;
  if (progressFd !== null) appendFileSync(progressFd, `${JSON.stringify({
    recordedAt: new Date().toISOString(),
    status, completedPaths, activePaths: activePath === null ? [] : [activePath], failedPath,
    copyTimings,
    ...(error ? { timeout: error.code === 'ETIMEDOUT',
      nativeExitCode: Number.isInteger(error.nativeExitCode) ? error.nativeExitCode : null } : {})
  })}\n`);
  copyTimings.length = 0;
}
try {
  const request = JSON.parse(process.env.PILOT_DEPENDENCY_COPY);
  delete process.env.PILOT_DEPENDENCY_COPY;
  const { snapshot, workspace, paths, deadline } = request;
  assert(isAbsolute(snapshot) && isAbsolute(workspace));
  const source = realpathSync(snapshot), target = realpathSync(workspace);
  const outside = relative(source, target);
  assert(outside === '..' || outside.startsWith(`..${sep}`) || isAbsolute(outside));
  assert(Array.isArray(paths) && paths.length > 0 && paths.length <= 50);
  assert(Number.isSafeInteger(deadline));
  if (request.progressPath !== undefined) {
    const path = resolve(request.progressPath);
    assert(realpathSync(dirname(path)) === dirname(target) &&
      basename(path).startsWith(`${basename(target)}.dependency-copy-`) &&
      basename(path).endsWith('.jsonl') && lstatSync(path).isFile() &&
      !lstatSync(path).isSymbolicLink());
    progressFd = openSync(path, 'a');
  }
  for (const path of paths) {
    assert(typeof path === 'string' && path && !isAbsolute(path) &&
      !/[:\0\r\n]/.test(path) &&
      path.split(/[\\/]/).every(part => part && part !== '.' && part !== '..'));
    assert(lstatSync(join(source, path)).isDirectory());
    activePath = path;
    progress('copying');
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Object.assign(new Error('Copy deadline reached'), { code: 'ETIMEDOUT' });
    const copyStarted = Date.now();
    const result = spawnSync('robocopy', [join(source, path), join(target, path),
      '/MIR', '/SL', '/SJ', '/MT:32', '/R:1', '/W:1',
      '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], {
      cwd: target, env: process.env, windowsHide: true,
      timeout: remaining, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8'
    });
    copyTimings.push({ path, durationMs: Date.now() - copyStarted,
      nativeExitCode: Number.isInteger(result.status) ? result.status : null,
      timeout: result.error?.code === 'ETIMEDOUT' });
    if (result.error) throw result.error;
    if (!Number.isInteger(result.status) || result.status < 0 || result.status >= 8)
      throw Object.assign(new Error('Dependency directory copy failed'),
        { nativeExitCode: result.status });
    completedPaths++;
    activePath = null;
  }
  progress('passed');
  console.log(`PILOT_DEPENDENCY_COPY:${JSON.stringify({ completedPaths })}`);
} catch (error) {
  failedPath = activePath;
  activePath = null;
  try { progress('failed', error); }
  catch (progressError) {
    console.error(`PILOT_DEPENDENCY_COPY_PROGRESS_FAILURE:${JSON.stringify({
      code: typeof progressError.code === 'string' ? progressError.code : null
    })}`);
  }
  console.log(`PILOT_DEPENDENCY_COPY_FAILURE:${JSON.stringify({
    completedPaths, failedPath, timeout: error.code === 'ETIMEDOUT',
    nativeExitCode: Number.isInteger(error.nativeExitCode) ? error.nativeExitCode : null
  })}`);
  process.exitCode = 1;
} finally {
  if (progressFd !== null) closeSync(progressFd);
}

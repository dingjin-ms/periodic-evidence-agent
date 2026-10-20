const assert = require('node:assert/strict');
const { lstatSync, realpathSync } = require('node:fs');
const { isAbsolute, join, relative, sep } = require('node:path');
const { spawnSync } = require('node:child_process');

let completedPaths = 0;
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
  for (const path of paths) {
    assert(typeof path === 'string' && path && !isAbsolute(path) &&
      !/[:\0\r\n]/.test(path) &&
      path.split(/[\\/]/).every(part => part && part !== '.' && part !== '..'));
    assert(lstatSync(join(source, path)).isDirectory());
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Object.assign(new Error('Copy deadline reached'), { code: 'ETIMEDOUT' });
    const result = spawnSync('robocopy', [join(source, path), join(target, path),
      '/MIR', '/SL', '/SJ', '/MT:32', '/R:1', '/W:1',
      '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], {
      cwd: target, env: process.env, windowsHide: true,
      timeout: remaining, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8'
    });
    if (result.error) throw result.error;
    if (!Number.isInteger(result.status) || result.status < 0 || result.status >= 8)
      throw Object.assign(new Error('Dependency directory copy failed'),
        { nativeExitCode: result.status });
    completedPaths++;
  }
  console.log(`PILOT_DEPENDENCY_COPY:${JSON.stringify({ completedPaths })}`);
} catch (error) {
  console.log(`PILOT_DEPENDENCY_COPY_FAILURE:${JSON.stringify({
    completedPaths, timeout: error.code === 'ETIMEDOUT',
    nativeExitCode: Number.isInteger(error.nativeExitCode) ? error.nativeExitCode : null
  })}`);
  process.exitCode = 1;
}

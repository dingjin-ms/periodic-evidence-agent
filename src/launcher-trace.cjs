const fs = require('node:fs');
const path = require('node:path');

if (process.env.PILOT_LAUNCHER_DIAGNOSTIC) {
  const request = JSON.parse(process.env.PILOT_LAUNCHER_DIAGNOSTIC);
  delete process.env.PILOT_LAUNCHER_DIAGNOSTIC;
  delete process.env.NODE_OPTIONS;
  const tracePath = path.join(request.directory, 'launcher-trace.jsonl');
  const record = value => fs.appendFileSync(tracePath,
    JSON.stringify({ ...value, pid: process.pid, at: new Date().toISOString() }) + '\n');
  record({ point: 'bootstrap', argv: process.argv, execArgv: process.execArgv, cwd: process.cwd(),
    environmentNames: Object.keys(process.env).sort(),
    authHookSuppressed: process.env.OAGENT_ADO_ARTIFACTS_AUTHENTICATED === '1',
    temporaryPathLength: process.env.TEMP?.length, suppressionIsAuthenticationProof: false });
  const Module = require('node:module'), load = Module._load;
  let loads = 0, spawns = 0, failures = 0;
  Module._load = function (request, ...rest) {
    if (loads < 32 && /(?:corepack|[\\/]\.yarn[\\/](?:releases|plugins)[\\/])/.test(request)) {
      loads++;
      record({ point: 'module-load', request });
    }
    return load.call(this, request, ...rest);
  };
  const childProcess = require('node:child_process');
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
    const original = childProcess[name];
    childProcess[name] = function (executable, args, ...rest) {
      const tracked = spawns++ < 32;
      if (tracked) record({ point: 'command-dispatch', api: name, executable,
        args: Array.isArray(args) ? args : null });
      const result = original.call(this, executable, args, ...rest);
      if (tracked) record({ point: 'command-returned', api: name, childPid: result?.pid ?? null });
      return result;
    };
  }
  const mkdir = fs.mkdirSync;
  fs.mkdirSync = function (...args) {
    try { return mkdir.apply(this, args); }
    catch (error) {
      failures++;
      if (failures <= 8 || (failures <= 1048576 && (failures & (failures - 1)) === 0))
        record({ point: 'mkdir-failed', count: failures, code: error.code,
          pathLength: String(args[0]).length, stack: error.stack });
      throw error;
    }
  };
  Module.syncBuiltinESMExports();
  process.on('exit', code => record({ point: 'launcher-exit', code }));
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync,
  realpathSync, openSync, fsyncSync, closeSync, rmSync
} from 'node:fs';
import { fork, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, relative, isAbsolute, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { command } from '../src/workers.js';
import { Ledger } from '../src/ledger.js';
import { hash, json } from '../src/common.js';
import { preparationStageNames } from '../src/preparation-attempt.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function durable(path, value, flag = 'wx') {
  const fd = openSync(path, flag, 0o600);
  try { writeFileSync(fd, json(value) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
}
async function waitFor(check, label, timeoutMs = 5000) {
  const start = performance.now();
  while (!check()) {
    assert.ok(performance.now() - start < timeoutMs, `Timed out: ${label}`);
    await delay(20);
  }
}
function lock(ctx) {
  const ledger = new Ledger(join(ctx.parent, 'controller'), { readOnly: true });
  try { return ledger.db.prepare('SELECT * FROM locks').all().map(value => ({ ...value })); }
  finally { ledger.close(); }
}
function receipts(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? receipts(path) : entry.name === 'r.json'
      ? [{ path, type: JSON.parse(readFileSync(path)).type, sha256: hash(readFileSync(path)) }] : [];
  });
}
async function inspect(ctx, pids) {
  assert.ok(pids.every(pid => Number.isSafeInteger(pid) && pid > 0));
  const result = await command('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference='Stop';$records=@(foreach($id in @(${pids.join(',')})){` +
    `try{$p=[System.Diagnostics.Process]::GetProcessById($id)}` +
    `catch [System.ArgumentException]{[pscustomobject]@{pid=$id;gone=$true};continue};` +
    `try{$unused=$p.Handle;if($p.HasExited){[pscustomobject]@{pid=$id;gone=$true};continue};` +
    `$started=$p.StartTime.ToUniversalTime().Ticks.ToString();` +
    `$info=Get-CimInstance Win32_Process -Filter "ProcessId=$id";` +
    `if($p.HasExited){[pscustomobject]@{pid=$id;gone=$true}}` +
    `else{[pscustomobject]@{pid=$id;gone=$false;started=$started;parent=[int]$info.ParentProcessId}}}` +
    `finally{$p.Dispose()}});ConvertTo-Json -Compress -InputObject $records`], ctx.root, 10000);
  return JSON.parse(result.stdout);
}
async function holdProcesses(ctx, identities) {
  assert.ok(identities.every(value => Number.isSafeInteger(value.pid) && value.pid > 0 &&
    /^\d+$/.test(value.started)));
  // Keep the checkpoint generations allocated until reconciliation finishes, not just during each query.
  const holder = spawn('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference='Stop';$held=@();try{` +
    identities.map(value =>
      `$p=[System.Diagnostics.Process]::GetProcessById(${value.pid});$held+=,$p;$unused=$p.Handle;` +
      `if($p.HasExited -or $p.StartTime.ToUniversalTime().Ticks.ToString() -cne '${value.started}')` +
      `{throw 'Checkpoint process generation changed before capture'};`).join('') +
    `[Console]::Out.WriteLine('ready');$null=[Console]::In.ReadLine()}` +
    `finally{foreach($p in $held){$p.Dispose()}}`],
  { cwd: ctx.root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, timeout: 90000 });
  let stdout = '', stderr = '';
  holder.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
  holder.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
  const closed = new Promise((resolve, reject) => {
    holder.once('error', reject);
    holder.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Checkpoint handle holder failed (${code ?? signal}): ${stderr}`));
    });
  });
  let released = false;
  ctx.releaseProcesses = async () => {
    if (!released) {
      released = true;
      holder.stdin.end();
    }
    await closed;
  };
  await Promise.race([
    waitFor(() => stdout.trim() === 'ready', 'checkpoint process handles', 10000),
    closed.then(() => { throw new Error('Checkpoint handle holder exited before release'); })
  ]);
}
async function stopCaptured(ctx, identity) {
  assert.ok(Number.isSafeInteger(identity.pid) && identity.pid > 0 && /^\d+$/.test(identity.started));
  // Holding the process handle prevents the PID from being recycled between the check and Stop-Process.
  await command('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference='Stop';$p=[System.Diagnostics.Process]::GetProcessById(${identity.pid});` +
    `try{$unused=$p.Handle;if($p.StartTime.ToUniversalTime().Ticks.ToString() -cne '${identity.started}')` +
    `{throw 'Process generation changed; no termination'};` +
    `Stop-Process -Id ${identity.pid} -Force -ErrorAction Stop;` +
    `if(-not $p.WaitForExit(5000)){throw 'Process exit unconfirmed'}}finally{$p.Dispose()}`],
  ctx.root, 10000);
}
function audit(ctx, action, detail = {}) {
  durable(ctx.auditPath, { action, elapsedMs: performance.now() - ctx.started, ...detail }, 'a');
}
async function sourceBinding(ctx) {
  return {
    revision: (await command('git', ['rev-parse', 'HEAD'], ctx.source)).stdout.trim(),
    status: (await command('git', ['status', '--porcelain=v1'], ctx.source)).stdout.trim(),
    files: Object.fromEntries(ctx.files.map(name => [name, hash(readFileSync(join(ctx.source, name)))]))
  };
}
async function drain(ctx, checkpoint) {
  assert.deepEqual(lock(ctx), [checkpoint.lease], 'Lease identity changed; retain state');
  assert.equal(dirname(checkpoint.attemptRoot), ctx.parent, 'Attempt escaped its declared parent');
  assert.deepEqual(await sourceBinding(ctx), checkpoint.source, 'Original source changed; retain state');
  const identities = await inspect(ctx, checkpoint.processes.map(value => value.pid));
  const owner = identities[0];
  if (!owner.gone) {
    audit(ctx, 'blocked-owner-present');
    throw new Error('Original owner is still present or its PID was reused; retain state');
  }
  for (let i = 1; i < identities.length; i++) {
    if (!identities[i].gone && identities[i].started !== checkpoint.processes[i].started) {
      audit(ctx, 'blocked-generation-changed', { pid: identities[i].pid });
      throw new Error('Process generation changed; retain state');
    }
  }
  audit(ctx, 'drain-intent', { checkpointSha256: hash(json(checkpoint)), observed: identities });
  if (!identities[1].gone) {
    audit(ctx, 'supervisor-termination-intent', { pid: identities[1].pid });
    await stopCaptured(ctx, checkpoint.processes[1]);
  }
  const start = performance.now();
  let after;
  do {
    after = await inspect(ctx, checkpoint.processes.map(value => value.pid));
    if (after.every(value => value.gone)) break;
    assert.ok(performance.now() - start < 5000, 'Drain unconfirmed; retain lease and data');
  } while (true);
  audit(ctx, 'drain-confirmed', { observed: after });
}
async function discardAndRecover(ctx, checkpoint) {
  assert.deepEqual(await sourceBinding(ctx), checkpoint.source);
  assert.deepEqual(lock(ctx), [checkpoint.lease]);
  assert.equal(dirname(checkpoint.attemptRoot), ctx.parent);
  assert.ok((await inspect(ctx, checkpoint.processes.map(value => value.pid))).every(value => value.gone),
    'A captured PID is present; refuse cleanup, including PID reuse');
  audit(ctx, 'discard-intent', { data: join(checkpoint.attemptRoot, 'data') });
  rmSync(join(checkpoint.attemptRoot, 'data'), { recursive: true });
  audit(ctx, 'data-discarded', { receiptsRemaining: receipts(checkpoint.attemptRoot).length });
  const ledger = new Ledger(join(ctx.parent, 'controller'));
  try { ledger.recoverLock(checkpoint.lease.name, checkpoint.lease.owner); }
  finally { ledger.close(); }
  audit(ctx, 'lease-recovered', { name: checkpoint.lease.name, owner: checkpoint.lease.owner });
}
function startDriver(ctx, mode, name) {
  const resultPath = join(ctx.root, `${name}.json`);
  const child = fork(ctx.driver, [ctx.request, mode, resultPath], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true
  });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  return { child, closed, resultPath };
}
async function assertBlockedRestart(ctx, checkpoint, name) {
  const before = readdirSync(ctx.parent);
  const published = receipts(join(checkpoint.attemptRoot, 'data'));
  const restart = startDriver(ctx, 'restart', name);
  await waitFor(() => existsSync(restart.resultPath), `${name} rejection`, 10000);
  const result = JSON.parse(readFileSync(restart.resultPath));
  assert.equal(result.returned, false);
  assert.equal(result.error.code, 'overlap');
  assert.equal((await restart.closed).code, 2);
  assert.deepEqual(lock(ctx), [checkpoint.lease]);
  assert.deepEqual(readdirSync(ctx.parent), before, 'Restart created another attempt');
  assert.deepEqual(receipts(join(checkpoint.attemptRoot, 'data')), published);
  audit(ctx, name, result);
}

test('process inspection reports an exited checkpoint process as gone while its handle remains held',
  { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
    const ctx = { root: realpathSync.native(mkdtempSync(join(tmpdir(), 'preparation-process-handles-'))) };
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      stdio: 'ignore', windowsHide: true
    });
    t.after(async () => {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await ctx.releaseProcesses?.();
      } finally { rmSync(ctx.root, { recursive: true }); }
    });
    const [identity] = await inspect(ctx, [child.pid]);
    assert.equal(identity.gone, false);
    await holdProcesses(ctx, [identity]);
    await stopCaptured(ctx, identity);
    assert.deepEqual(await inspect(ctx, [child.pid]), [{ pid: child.pid, gone: true }]);
  });

test('forced preparation parent termination blocks restart until audited private-state discard and owner recovery',
  { skip: process.platform !== 'win32', timeout: 90000 }, async t => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'preparation-parent-crash-')));
    const ctx = {
      root, source: join(root, 'original'), parent: join(root, 'attempts'),
      auditPath: join(root, 'recovery.jsonl'), driver: join(root, 'driver.mjs'),
      request: join(root, 'request.json'), started: performance.now(),
      files: ['.gitignore', 'package.json', 'fixture.lock', 'build.js', 'source.txt']
    };
    mkdirSync(ctx.source);
    mkdirSync(ctx.parent);
    const content = ['node_modules/\ndist/\n', '{"private":true}\n', 'locked\n',
      'export default 1;\n', 'original source bytes\n'];
    ctx.files.forEach((name, i) => writeFileSync(join(ctx.source, name), content[i]));
    const git = args => command('git', ['-c', 'core.autocrlf=false', ...args], ctx.source);
    await git(['init', '--quiet']);
    await git(['add', '.']);
    await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '--quiet', '-m', 'Local parent termination fixture']);
    const source = await sourceBinding(ctx);
    const ready = join(root, 'ready.json');
    const frozen = join(root, 'frozen.json');
    const profile = join(root, 'profile.mjs');
    const leaf = join(root, 'leaf.mjs');
    writeFileSync(leaf, 'setInterval(()=>{},1000);\n');
    const plan = {
      version: 2, stages: ['dependencies', 'compile', 'policy', 'test'],
      testOnlyPrefixes: ['test/'], lockfilePaths: ['package.json', 'fixture.lock'],
      buildConfigPaths: ['build.js'], dependencySnapshotPaths: ['node_modules'],
      preparedOutputPaths: ['dist']
    };
    writeFileSync(profile, `// PILOT_VALIDATION_PLAN: ${json(plan)}
import {writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {spawn} from 'node:child_process';
const stage=process.env.PILOT_VALIDATION_STAGE;
if(stage==='fingerprint')console.log('PILOT_VALIDATION_FINGERPRINT:'+JSON.stringify({
node:process.version,corepack:'fixture',yarn:'fixture',platform:process.platform,architecture:process.arch}));
if(stage==='dependencies'){
mkdirSync('node_modules/fixture',{recursive:true});writeFileSync('node_modules/fixture/value.js','dependency\\n');
}
if(stage==='compile'){
mkdirSync('dist');writeFileSync('dist/value.js','partial compile\\n');
writeFileSync('source.txt','private interrupted mutation\\n');
writeFileSync('.fixture-stage.lock','partial compile\\n');
const child=spawn(process.execPath,[${json(leaf)}],{stdio:'ignore',windowsHide:true});
writeFileSync(${json(ready + '.tmp')},JSON.stringify({pid:process.pid,child:child.pid,workspace:process.cwd()}));
renameSync(${json(ready + '.tmp')},${json(ready)});
setInterval(()=>{},1000);
}
`);
    const api = new URL('../src/preparation-attempt.js', import.meta.url).href;
    writeFileSync(ctx.driver, `
import {readFileSync,writeFileSync,openSync,fsyncSync,closeSync,existsSync,renameSync} from 'node:fs';
import {runPreparationAttempt} from ${json(api)};
const [request,mode,resultPath]=process.argv.slice(2);
const options=JSON.parse(readFileSync(request));
let active;
const abort=new AbortController();
const save=(path,value)=>{const fd=openSync(path+'.tmp','wx',0o600);
try{writeFileSync(fd,JSON.stringify(value));fsyncSync(fd)}finally{closeSync(fd)}
renameSync(path+'.tmp',path)};
process.on('message',message=>{
if(message==='abort')abort.abort();
if(message==='freeze'){
if(mode!=='owner'||active?.stage!=='compile'||active.phase!=='start'||!existsSync(${json(ready)}))
throw new Error('Compile boundary no longer active');
save(${json(frozen)},{controllerPid:active.processId});
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
}});
try{
const outcome=await runPreparationAttempt({...options,signal:abort.signal,onProgress:event=>{active=event}});
save(resultPath,{returned:true,outcome});
}catch(error){save(resultPath,{returned:false,error:{code:error.code,message:error.message}});process.exitCode=2}
finally{process.disconnect()}
`);
    const gate = {
      id: 'parent-crash', approved: true, isolationVerified: true,
      executable: process.execPath, args: ['{profile}'],
      profilePath: profile, profileSha256: hash(readFileSync(profile)), timeoutMs: 30000
    };
    durable(ctx.request, {
      config: { limits: { maxValidationInfrastructureRetries: 0 } },
      job: { id: 'fixture', workspace: ctx.source },
      repo: { id: 'fixture', owner: 'fixture', remote: ctx.source,
        referenceCheckout: ctx.source, validationGates: [gate] },
      revision: source.revision, attemptParent: ctx.parent, wholeTimeoutMs: 60000,
      stageTimeoutMs: Object.fromEntries(preparationStageNames.map(name => [name, 45000]))
    });
    let checkpoint, recovered = false, reported = false;
    const owner = startDriver(ctx, 'owner', 'owner-result');
    t.after(async () => {
      let savedAudit;
      try {
        if (!recovered) {
          if (checkpoint && existsSync(frozen)) {
            if (owner.child.exitCode === null && owner.child.signalCode === null)
              await stopCaptured(ctx, checkpoint.processes[0]);
            await drain(ctx, checkpoint);
            await discardAndRecover(ctx, checkpoint);
          } else {
            if (owner.child.connected) owner.child.send('abort');
            await waitFor(() => owner.child.exitCode !== null || owner.child.signalCode !== null,
              `Cooperative fixture cleanup; otherwise retain ${root}`, 10000);
          }
        }
        if (existsSync(join(ctx.parent, 'controller', 'ledger.sqlite')))
          assert.equal(lock(ctx).length, 0, `Unreconciled fixture retained at ${root}`);
        if (existsSync(ctx.auditPath)) savedAudit = readFileSync(ctx.auditPath, 'utf8');
        await ctx.releaseProcesses?.();
        rmSync(root, { recursive: true, maxRetries: 3 });
      } finally {
        try { await ctx.releaseProcesses?.(); }
        finally {
          if (!reported) t.diagnostic(json({
            kind: 'preparation-parent-crash-incomplete', retainedRoot: existsSync(root) ? root : null,
            checkpoint, audit: existsSync(ctx.auditPath) ? readFileSync(ctx.auditPath, 'utf8') : savedAudit ?? null
          }));
        }
      }
    });
    await waitFor(() => existsSync(ready), 'active compile', 45000);
    const attemptRoots = readdirSync(ctx.parent).filter(name => name.startsWith('preparation-'));
    assert.equal(attemptRoots.length, 1);
    const attemptRoot = join(ctx.parent, attemptRoots[0]);
    const progress = readFileSync(join(attemptRoot, 'progress.jsonl'), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line));
    const compile = progress.find(event => event.stage === 'compile' && event.phase === 'start');
    assert.ok(compile, 'Readiness must be backed by trusted controller progress');
    const workload = JSON.parse(readFileSync(ready));
    const suffix = relative(join(attemptRoot, 'data'), realpathSync.native(workload.workspace));
    assert.ok(suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
    const [controller, profileProcess] = await inspect(ctx, [compile.processId, workload.pid]);
    const processes = await inspect(ctx,
      [owner.child.pid, controller.parent, compile.processId, profileProcess.parent, workload.pid, workload.child]);
    assert.ok(processes.every(value => !value.gone));
    for (let i = 1; i < processes.length; i++) assert.equal(processes[i].parent, processes[i - 1].pid);
    await holdProcesses(ctx, processes);
    const leases = lock(ctx);
    assert.equal(leases.length, 1);
    assert.equal(leases[0].pid, owner.child.pid);
    assert.equal(leases[0].name, `preparation-attempt:${hash(realpathSync.native(ctx.source))}`);
    assert.deepEqual(receipts(join(attemptRoot, 'data')).map(value => value.type), ['dependencies']);
    assert.equal(readFileSync(join(workload.workspace, 'source.txt'), 'utf8'), 'private interrupted mutation\n');
    assert.equal(existsSync(join(workload.workspace, '.fixture-stage.lock')), true);
    checkpoint = { source, attemptRoot, lease: leases[0], processes, profileSha256: gate.profileSha256 };
    durable(join(root, 'external-checkpoint.json'), checkpoint);
    audit(ctx, 'checkpoint', checkpoint);
    owner.child.send('freeze');
    await waitFor(() => existsSync(frozen), 'fixture driver freeze');
    assert.equal(JSON.parse(readFileSync(frozen)).controllerPid, compile.processId);
    await assert.rejects(drain(ctx, checkpoint), /Original owner is still present/);
    await stopCaptured(ctx, processes[0]);
    await owner.closed;
    audit(ctx, 'owner-forcibly-terminated', { pid: processes[0].pid });
    assert.equal(existsSync(owner.resultPath), false, 'Forced termination must bypass the parent result');
    assert.equal(existsSync(join(attemptRoot, 'outcome.json')), false);
    assert.equal(readFileSync(join(attemptRoot, 'journal.jsonl'), 'utf8').includes('"kind":"attempt-finished"'), false);
    await assertBlockedRestart(ctx, checkpoint, 'restart-before-drain');
    const afterOwnerKill = await inspect(ctx, processes.map(value => value.pid));
    const mismatch = structuredClone(checkpoint);
    const generationGuardProbe = 'synthetic-live-auditor-mismatch';
    mismatch.processes[1] = { ...mismatch.processes[1], pid: process.pid, started: '0' };
    await assert.rejects(drain(ctx, mismatch), { message: 'Process generation changed; retain state' });
    assert.equal(readFileSync(ctx.auditPath, 'utf8').trim().split('\n').map(JSON.parse).at(-1).action,
      'blocked-generation-changed');
    assert.deepEqual(lock(ctx), [checkpoint.lease]);
    assert.equal(existsSync(join(attemptRoot, 'data')), true);
    await drain(ctx, checkpoint);
    await assertBlockedRestart(ctx, checkpoint, 'restart-after-drain');
    await discardAndRecover(ctx, checkpoint);
    recovered = true;
    assert.deepEqual(lock(ctx), []);
    assert.equal(existsSync(join(attemptRoot, 'data')), false);
    assert.equal(receipts(ctx.parent).length, 0);
    assert.equal(existsSync(join(attemptRoot, 'outcome.json')), false);
    assert.deepEqual(readdirSync(ctx.parent).filter(name => name.startsWith('preparation-')), attemptRoots);
    assert.deepEqual(await sourceBinding(ctx), source);
    assert.equal(hash(readFileSync(profile)), gate.profileSha256);
    const auditBytes = readFileSync(ctx.auditPath);
    t.diagnostic(json({
      kind: 'preparation-parent-crash', wallMs: performance.now() - ctx.started,
      source, profileSha256: gate.profileSha256, afterOwnerKill, generationGuardProbe,
      partialReceiptTypes: ['dependencies'], recovered: true, nativeReuseProved: false,
      auditSha256: hash(auditBytes), audit: auditBytes.toString('utf8').trim().split('\n').map(JSON.parse)
    }));
    reported = true;
  });

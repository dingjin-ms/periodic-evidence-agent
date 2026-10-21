import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync,
  realpathSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { command } from '../src/workers.js';
import { Ledger } from '../src/ledger.js';
import { hash, json, PilotError } from '../src/common.js';
import { runPreparationAttempt, preparationStageNames } from '../src/preparation-attempt.js';
import {
  withPreparationProgress, preparationStage, preparationFailureDiagnostic
} from '../src/preparation-progress.js';

test('preparation diagnostics allowlist structured fields without reading raw error text', () => {
  const marker = 'fixture-sensitive-command-environment-and-output';
  const error = { code: 128, signal: 'SIGTERM', killed: true };
  for (const field of ['message', 'stack', 'stdout', 'stderr', 'cmd', 'path', 'env'])
    Object.defineProperty(error, field, { get() { throw new Error(marker); } });
  assert.deepEqual(preparationFailureDiagnostic(error), {
    exitCode: 128, systemCode: null, signal: 'SIGTERM', killed: true
  });
  assert.deepEqual(preparationFailureDiagnostic({ code: 'ENOENT' }), {
    exitCode: null, systemCode: 'ENOENT', signal: null, killed: false
  });
  const unknown = preparationFailureDiagnostic({ code: marker, signal: marker, killed: marker });
  assert.deepEqual(unknown, { exitCode: null, systemCode: null, signal: null, killed: false });
  const broken = Object.defineProperty({}, 'code', { get() { throw new Error(marker); } });
  assert.deepEqual(preparationFailureDiagnostic(broken), {
    secondaryError: { code: 'preparation-diagnostic-unavailable',
      message: 'Secondary preparation failure details could not be inspected.' }
  });
});

test('shared command re-export preserves the caller abort signal', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(command(process.execPath, ['-e', 'process.exit(0)'],
    process.cwd(), undefined, undefined, controller.signal),
  { name: 'AbortError', code: 'ABORT_ERR' });
});

test('controller progress failure preserves an already raised primary rejection', async () => {
  const primary = new PilotError('blocked-validation', 'original content rejection');
  const marker = 'fixture-sensitive-progress-exception';
  await assert.rejects(withPreparationProgress('fixture', event => {
    if (event.phase === 'failed') throw new Error(marker);
  }, () => preparationStage('compile', () => { throw primary; })), error => {
    assert.equal(error, primary);
    assert.equal(error.code, 'blocked-validation');
    assert.equal(error.message, 'original content rejection');
    assert.equal(error.secondaryError.code, 'preparation-progress-failed');
    assert.equal(json(error).includes(marker), false);
    return true;
  });
});

for (const [name, parentPath] of [
  ['dot-prefixed nested', source => join(source, '..attempts')],
  ['case-aliased identical', source => source.toLowerCase()]
]) test(`a ${name} attempt parent is rejected before reading source or creating state`,
  { skip: process.platform !== 'win32' }, async t => {
    const root = mkdtempSync(join(tmpdir(), 'preparation-overlap-fixture-'));
    const source = join(root, 'source');
    const parent = parentPath(source);
    mkdirSync(parent, { recursive: true });
    t.after(() => rmSync(root, { recursive: true, force: true }));
    await assert.rejects(runPreparationAttempt({
      config: {}, job: { workspace: source },
      repo: { validationGates: [{ id: 'fixture' }] }, revision: 'a'.repeat(40),
      attemptParent: parent, wholeTimeoutMs: 60000,
      stageTimeoutMs: Object.fromEntries(preparationStageNames.map(name => [name, 45000]))
    }), error => error.code === 'blocked-preparation-plan');
    assert.equal(existsSync(join(parent, 'controller')), false);
  });

function receipts(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return receipts(path);
    return entry.name === 'r.json' ? [path] : [];
  });
}
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'preparation-attempt-fixture-'));
  const source = join(root, 'original');
  const parent = join(root, 'attempts');
  mkdirSync(source);
  mkdirSync(parent);
  writeFileSync(join(source, '.gitignore'), 'node_modules/\ndist/\n');
  writeFileSync(join(source, 'package.json'), '{"private":true}\n');
  writeFileSync(join(source, 'fixture.lock'), 'locked\n');
  writeFileSync(join(source, 'build.js'), 'export default 1;\n');
  writeFileSync(join(source, 'source.txt'), 'original source bytes\n');
  const git = args => command('git', ['-c', 'core.autocrlf=false', ...args], source);
  await git(['init', '--quiet']);
  await git(['add', '.']);
  await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Local interruption fixture']);
  const revision = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const plan = {
    version: 2, stages: ['dependencies', 'compile', 'policy', 'test'],
    testOnlyPrefixes: ['test/'], lockfilePaths: ['package.json', 'fixture.lock'],
    buildConfigPaths: ['build.js'], dependencySnapshotPaths: ['node_modules'],
    preparedOutputPaths: ['dist']
  };
  const profile = join(root, 'profile.mjs');
  const readyPath = join(root, 'ready.json');
  const child = join(root, 'leaf.mjs');
  writeFileSync(child, 'setInterval(()=>{},1000);\n');
  writeFileSync(profile, `// PILOT_VALIDATION_PLAN: ${json(plan)}
import {writeFileSync,readFileSync,mkdirSync,renameSync} from 'node:fs';
import {spawn} from 'node:child_process';
const stage=process.env.PILOT_VALIDATION_STAGE;
const [target,ready,leaf,startupDelay='0']=process.argv.slice(2);
if(stage===target)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Number(startupDelay));
console.log('{"kind":"stage","stage":"forged-product-stage","phase":"start"}');
if(stage==='fingerprint')console.log('PILOT_VALIDATION_FINGERPRINT:'+JSON.stringify({
  node:process.version,corepack:'fixture',yarn:'fixture',platform:process.platform,architecture:process.arch}));
if(stage==='dependencies'){
  mkdirSync('node_modules/fixture',{recursive:true});
  for(let i=0;i<128;i++)writeFileSync('node_modules/fixture/'+i+'.js','dependency '+i+'\\n');
}
if(stage==='compile'){
  mkdirSync('dist');
  writeFileSync('dist/value.js','compiled\\n');
}
if(stage==='dependencies'&&target==='mutate')writeFileSync('source.txt','rejected source mutation\\n');
if(stage===target){
  writeFileSync('source.txt','interrupted mutation in disposable snapshot\\n');
  writeFileSync('.fixture-stage.lock','partial stage\\n');
  const descendant=spawn(process.execPath,[leaf],{stdio:'ignore',windowsHide:true});
  writeFileSync(ready+'.tmp',JSON.stringify({pid:process.pid,child:descendant.pid,workspace:process.cwd()}));
  renameSync(ready+'.tmp',ready);
  setInterval(()=>{},1000);
}
`);
  const gate = {
    id: 'interruption', approved: true, isolationVerified: true,
    executable: process.execPath, args: ['{profile}', 'none', readyPath, child],
    profilePath: profile, profileSha256: hash(readFileSync(profile)), timeoutMs: 30000
  };
  const options = {
    config: { limits: { maxValidationInfrastructureRetries: 0 } },
    job: { id: 'fixture', workspace: source },
    repo: { id: 'fixture', owner: 'fixture', remote: source,
      referenceCheckout: source, validationGates: [gate] },
    revision, attemptParent: parent, wholeTimeoutMs: 60000,
    stageTimeoutMs: Object.fromEntries(preparationStageNames.map(name => [name, 45000]))
  };
  t.after(() => {
    const ledger = new Ledger(join(parent, 'controller'));
    try {
      assert.equal(ledger.db.prepare('SELECT COUNT(*) AS count FROM locks').get().count, 0,
        'Fixture must not remove an unreleased lease');
    } finally { ledger.close(); }
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return { root, source, parent, readyPath, options, gate };
}
function assertSource(ctx) {
  assert.equal(readFileSync(join(ctx.source, 'source.txt'), 'utf8'), 'original source bytes\n');
}
async function assertExited(pid, checkedAt, workspace) {
  try { process.kill(pid, 0); }
  catch (error) {
    if (error.code === 'ESRCH') return;
    throw error;
  }
  // Final source inspection can spawn Git after drain and recycle an exited PID.
  const observed = await command('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference='Stop';try{` +
    `[System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().ToString('o')` +
    `}catch [System.ArgumentException]{'gone'}`], workspace);
  const started = observed.stdout.trim();
  if (started === 'gone') return;
  const startedMs = Date.parse(started);
  assert.ok(Number.isFinite(checkedAt) && Number.isFinite(startedMs) && startedMs >= checkedAt,
    `Original process must have exited: ${json({ pid, checkedAt, startedMs })}`);
}

test('exit assertions reject a surviving owner and distinguish a newer PID generation',
  { skip: process.platform !== 'win32' }, async () => {
    await assert.rejects(assertExited(process.pid, Date.now() + 60000, tmpdir()),
      error => error.code === 'ERR_ASSERTION');
    await assertExited(process.pid, 0, tmpdir());
  });

async function assertRollback(outcome, ctx) {
  assert.equal(outcome.accepted, false, json(outcome));
  assert.equal(outcome.privateDataRemoved, true, json(outcome));
  assert.equal(outcome.lockReleased, true, json(outcome));
  assert.equal(outcome.sourceUnchanged, true);
  assert.equal(outcome.ownedProcessesExited, true);
  assert.equal(receipts(join(outcome.attemptRoot, 'data')).length, 0);
  assert.equal(existsSync(join(outcome.attemptRoot, 'data')), false);
  assertSource(ctx);
  for (const pid of [outcome.controllerPid, outcome.supervisorPid].filter(Boolean))
    await assertExited(pid, outcome.processExitCheckStartedMs, ctx.root);
}

function validationImportFault(ctx, marker) {
  const preload = join(ctx.root, 'validation-import-fault.mjs');
  writeFileSync(preload, `
import {registerHooks} from 'node:module';
registerHooks({load(url,context,nextLoad){
  if(url===${json(new URL('../src/workers.js', import.meta.url).href)})
    throw Object.assign(new Error(${json(marker)}),{code:'ENOENT'});
  return nextLoad(url,context);
}});
`);
  return pathToFileURL(preload).href;
}

test('preparation overlap refusal does not load worker execution before admission',
  { skip: process.platform !== 'win32' }, async t => {
    const ctx = await fixture(t);
    const ledger = new Ledger(join(ctx.parent, 'controller'));
    const name = `preparation-attempt:${hash(realpathSync.native(ctx.source))}`;
    const owner = ledger.acquire(name);
    const before = readdirSync(ctx.parent);
    const marker = 'fixture-worker-execution-import-before-admission';
    const preload = validationImportFault(ctx, marker);
    const api = new URL('../src/preparation-attempt.js', import.meta.url).href;
    try {
      await assert.rejects(command(process.execPath, ['--import', preload, '--input-type=module', '-e', `
import {runPreparationAttempt} from ${json(api)};
try {
  await runPreparationAttempt(${json(ctx.options)});
  process.exitCode=1;
} catch(error) {
  console.log(JSON.stringify({code:error.code}));
  process.exitCode=2;
}
`], ctx.root, 10000), error => {
        assert.equal(error.code, 2);
        assert.deepEqual(JSON.parse(error.stdout), { code: 'overlap' });
        assert.equal(error.stderr.includes(marker), false);
        return true;
      });
      assert.equal(ledger.db.prepare('SELECT owner FROM locks WHERE name=?').get(name).owner, owner);
      assert.deepEqual(readdirSync(ctx.parent), before);
      assertSource(ctx);
    } finally {
      ledger.release(name, owner);
      ledger.close();
    }
  });

for (const step of ['clone', 'checkout']) {
  test(`real Git ${step} failure retains only its substep and safe diagnostic without preparing receipts`,
    async t => {
      const ctx = await fixture(t);
      const root = join(ctx.parent, 'child');
      mkdirSync(join(root, 'data'), { recursive: true });
      const marker = `fixture-sensitive-${step}-argument`;
      writeFileSync(join(root, 'request.json'), json({
        ...ctx.options,
        job: { ...ctx.options.job, workspace: step === 'clone' ? join(ctx.root, marker) : ctx.source },
        revision: step === 'checkout' ? marker : ctx.options.revision
      }));
      const child = fileURLToPath(new URL('../src/preparation-attempt-child.js', import.meta.url));
      const preload = validationImportFault(ctx, marker);
      await assert.rejects(command(process.execPath, ['--import', preload, child, root], root, 60000),
        error => error.code === 1);
      const text = readFileSync(join(root, 'progress.jsonl'), 'utf8');
      const events = text.trim().split('\n').map(JSON.parse);
      const steps = events.filter(event => event.kind === 'materialization-step')
        .map(({ step, phase }) => [step, phase]);
      assert.deepEqual(steps, step === 'clone' ? [['clone', 'start']] :
        [['clone', 'start'], ['clone', 'finish'], ['checkout', 'start']]);
      const failed = events.at(-1);
      assert.equal(failed.kind, 'infrastructure-failed');
      assert.equal(failed.operation, `source-${step}`);
      assert.deepEqual(failed.diagnostic, {
        exitCode: 128, systemCode: null, signal: null, killed: false
      });
      assert.equal(text.includes(marker), false);
      assert.equal(events.some(event => event.stage === 'preparation' ||
        event.kind === 'complete'), false);
      assert.equal(existsSync(join(root, 'child-result.json')), false);
      assert.equal(receipts(join(root, 'data')).length, 0);
      assert.equal(existsSync(join(root, 'request.json')), false);
      assertSource(ctx);
    });
}

for (const brokenDiagnostic of [false, true]) {
  test(`a native ${brokenDiagnostic ? 'diagnostic exception' : 'clone refusal'} keeps controller-incomplete classification through cleanup`,
  { skip: process.platform !== 'win32' }, async t => {
    const ctx = await fixture(t);
    const marker = 'fixture-sensitive-infrastructure-exception';
    const preload = join(ctx.root, 'diagnostic-fault.mjs');
    const previousOptions = process.env.NODE_OPTIONS;
    if (brokenDiagnostic) {
      writeFileSync(preload, `
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
childProcess.execFile=(executable,args,options,callback)=>{
  const error=new Error(${json(marker)});
  Object.defineProperty(error,'code',{get(){throw new Error(${json(marker)})}});
  callback(error,${json(marker)},${json(marker)});
};
syncBuiltinESMExports();
`);
    } else {
      writeFileSync(join(ctx.source, '.git', 'refs', 'heads', 'missing-object'), 'a'.repeat(40) + '\n');
    }
    let outcome;
    try {
      if (brokenDiagnostic)
        process.env.NODE_OPTIONS = `${previousOptions ?? ''} --import=${pathToFileURL(preload).href}`;
      outcome = await runPreparationAttempt(ctx.options);
    } finally {
      if (previousOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previousOptions;
    }
    assert.equal(outcome.status, 'incomplete', json(outcome));
    assert.equal(outcome.reason, 'controller-incomplete');
    assert.equal(outcome.controllerRejection, null);
    assert.deepEqual(outcome.infrastructureFailure, {
      operation: 'source-clone',
      diagnostic: brokenDiagnostic ? {
        secondaryError: { code: 'preparation-diagnostic-unavailable',
          message: 'Secondary preparation failure details could not be inspected.' }
      } : { exitCode: 128, systemCode: null, signal: null, killed: false }
    });
    await assertRollback(outcome, ctx);
    const retained = ['progress.jsonl', 'journal.jsonl', 'outcome.json']
      .map(path => readFileSync(join(outcome.attemptRoot, path), 'utf8')).join('\n');
    assert.equal(retained.includes('missing-object'), false);
    assert.equal(retained.includes(marker), false);
    const persisted = JSON.parse(readFileSync(join(outcome.attemptRoot, 'outcome.json')));
    assert.deepEqual(persisted.infrastructureFailure, outcome.infrastructureFailure);
  });
}

test('validation runtime import failure retains its diagnostic after source materialization',
  { skip: process.platform !== 'win32' }, async t => {
    const ctx = await fixture(t);
    const marker = 'fixture-sensitive-validation-import';
    const preload = validationImportFault(ctx, marker);
    const previousOptions = process.env.NODE_OPTIONS;
    let outcome;
    try {
      process.env.NODE_OPTIONS = [previousOptions, `--import=${json(preload)}`]
        .filter(Boolean).join(' ');
      outcome = await runPreparationAttempt(ctx.options);
    } finally {
      if (previousOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previousOptions;
    }
    assert.equal(outcome.status, 'incomplete', json(outcome));
    assert.equal(outcome.reason, 'controller-incomplete');
    assert.deepEqual(outcome.infrastructureFailure, {
      operation: 'validation-preparation',
      diagnostic: { exitCode: null, systemCode: 'ENOENT', signal: null, killed: false }
    });
    await assertRollback(outcome, ctx);
    const retained = ['progress.jsonl', 'journal.jsonl', 'outcome.json']
      .map(path => readFileSync(join(outcome.attemptRoot, path), 'utf8')).join('\n');
    assert.equal(retained.includes(marker), false);
    const events = readFileSync(join(outcome.attemptRoot, 'progress.jsonl'), 'utf8')
      .trim().split('\n').map(JSON.parse);
    assert.equal(events.some(event => event.stage === 'source-materialization' &&
      event.phase === 'finish'), true);
    assert.equal(events.some(event => event.kind === 'complete'), false);
  });

for (const stage of ['dependencies', 'compile']) {
  test(`cancelling active ${stage} drains descendants, discards partial state and releases ownership`,
    { skip: process.platform !== 'win32' }, async t => {
      const ctx = await fixture(t);
      ctx.gate.args[1] = stage;
      const controller = new AbortController();
      let observedReady = null, observedReceiptCount = null;
      const timer = setInterval(() => {
        if (observedReady || !existsSync(ctx.readyPath)) return;
        observedReady = JSON.parse(readFileSync(ctx.readyPath));
        observedReceiptCount = receipts(ctx.parent).length;
        controller.abort(new Error('fixture-sensitive-abort-reason'));
      }, 10);
      let outcome;
      try { outcome = await runPreparationAttempt({ ...ctx.options, signal: controller.signal }); }
      finally { clearInterval(timer); }
      assert.equal(outcome.reason, 'cancelled', json(outcome));
      assert.equal(outcome.stage, stage);
      assert.ok(observedReady);
      assert.equal(observedReceiptCount, stage === 'compile' ? 1 : 0);
      for (const pid of [observedReady.pid, observedReady.child])
        await assertExited(pid, outcome.processExitCheckStartedMs, ctx.root);
      await assertRollback(outcome, ctx);
      assert.equal(json(outcome).includes('fixture-sensitive-abort-reason'), false);
    });
}

function compileReadBarrier(ctx) {
  const attemptParent = realpathSync.native(ctx.parent);
  const preload = join(ctx.root, 'hold-verification.mjs');
  // Hold the actual single-pass content read, not just its asynchronously observed start event.
  writeFileSync(preload, `
import fs from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { isMainThread } from 'node:worker_threads';
if(basename(process.argv[1] ?? '')==='preparation-attempt-child.js'||!isMainThread){
  const read=fs.readFileSync;
  fs.readFileSync=(path,...args)=>{
    const result=read(path,...args);
    if(typeof path==='string'&&path.startsWith(${json(attemptParent + sep)})&&
      path.endsWith(join('dist','value.js'))){
      const root=join(${json(attemptParent)},relative(${json(attemptParent)},path).split(sep)[0]);
      const events=read(join(root,'progress.jsonl'),'utf8').trim().split('\\n').map(JSON.parse);
      const active=events.at(-1);
      if(active.stage==='compile-output-capture'&&active.phase==='start'){
        fs.writeFileSync(${json(ctx.readyPath + '.tmp')},JSON.stringify(active));
        fs.renameSync(${json(ctx.readyPath + '.tmp')},${json(ctx.readyPath)});
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
        throw new Error('Verification read was not interrupted');
      }
    }
    return result;
  };
  syncBuiltinESMExports();
}
`);
  return preload;
}

async function expireReadyStage(t, ctx, stage, budget) {
  let elapsed = 0, ready = null, started = null;
  const clock = t.mock.method(performance, 'now', () => elapsed);
  // Advance only the parent test clock; native containment timers remain real.
  const timer = setInterval(() => {
    if (ready || !started || !existsSync(ctx.readyPath)) return;
    ready = JSON.parse(readFileSync(ctx.readyPath));
    elapsed = budget;
  }, 10);
  let outcome;
  try {
    outcome = await runPreparationAttempt({
      ...ctx.options,
      stageTimeoutMs: { ...ctx.options.stageTimeoutMs, [stage]: budget },
      onProgress: event => {
        if (event.stage === stage && event.phase === 'start') started = event;
      }
    });
  } finally {
    clearInterval(timer);
    clock.mock.restore();
  }
  const progress = join(outcome.attemptRoot, 'progress.jsonl');
  const events = existsSync(progress)
    ? readFileSync(progress, 'utf8').split('\n').slice(0, -1).map(JSON.parse) : null;
  assert.ok(ready, `Budget must wait for active ${stage}: ${json({ outcome, events })}`);
  assert.equal(events.some(event => event.kind === 'stage' &&
    event.id === started.id && event.phase !== 'start'), false,
  'Budget must interrupt an in-flight phase, not reject a completed phase');
  return { outcome, ready, started };
}

test('compile content-capture cancellation never publishes its unverified receipt',
  { skip: process.platform !== 'win32' }, async t => {
    const ctx = await fixture(t);
    // The controller canonicalizes aliases, including hosted Windows short temp paths.
    ctx.parent = ctx.parent.toUpperCase();
    ctx.options.attemptParent = ctx.parent;
    const preload = compileReadBarrier(ctx);
    const controller = new AbortController();
    let interruptedId = null, publishedBeforeCancel = null;
    let observedRead = null, outcome;
    const previousOptions = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = [previousOptions,
      `--import=${json(pathToFileURL(preload).href)}`].filter(Boolean).join(' ');
    const timer = setInterval(() => {
      if (observedRead || !interruptedId || !existsSync(ctx.readyPath)) return;
      observedRead = JSON.parse(readFileSync(ctx.readyPath));
      publishedBeforeCancel = receipts(ctx.parent).map(path => JSON.parse(readFileSync(path)).type);
      controller.abort();
    }, 10);
    try {
      outcome = await runPreparationAttempt({
        ...ctx.options, signal: controller.signal,
        onProgress: event => {
          if (event.stage === 'compile-output-capture' && event.phase === 'start')
            interruptedId = event.id;
        }
      });
    } finally {
      clearInterval(timer);
      if (previousOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previousOptions;
    }
    assert.equal(outcome.reason, 'cancelled', json(outcome));
    assert.ok(interruptedId);
    assert.ok(observedRead, 'Cancellation must wait for an active compile verification read');
    assert.equal(observedRead.id, interruptedId);
    assert.equal(observedRead.processId, outcome.controllerPid);
    assert.deepEqual(publishedBeforeCancel, ['dependencies']);
    await assertRollback(outcome, ctx);
    const events = readFileSync(join(outcome.attemptRoot, 'progress.jsonl'), 'utf8')
      .trim().split('\n').map(JSON.parse);
    assert.equal(events.some(event => event.kind === 'stage' &&
      event.id === interruptedId && event.phase === 'finish'), false,
    'Must interrupt actual in-flight verification, not a completed phase');
  });

test('a stage budget cancels the attempt and a fresh attempt can acquire the released lease',
  { skip: process.platform !== 'win32' }, async t => {
    const ctx = await fixture(t);
    ctx.gate.args[1] = 'dependencies';
    ctx.gate.args.push('6000');
    const { outcome: failed, ready } = await expireReadyStage(t, ctx, 'dependencies', 5000);
    assert.equal(failed.reason, 'stage-budget', json(failed));
    assert.equal(failed.stage, 'dependencies');
    for (const pid of [ready.pid, ready.child])
      await assertExited(pid, failed.processExitCheckStartedMs, ctx.root);
    await assertRollback(failed, ctx);
    ctx.gate.args[1] = 'none';
    const events = [];
    const prepared = await runPreparationAttempt({
      ...ctx.options, onProgress: event => { events.push(event); }
    });
    assert.equal(prepared.status, 'prepared', json(prepared));
    assert.equal(prepared.accepted, true);
    assert.equal(prepared.lockReleased, true);
    assert.equal(prepared.sourceUnchanged, true);
    assert.notEqual(prepared.attemptRoot, failed.attemptRoot);
    assert.equal(events.some(event => event.stage === 'forged-product-stage'), false,
      'Product stdout must never create trusted stage notifications');
    assert.deepEqual(events.filter(event => event.phase === 'start' &&
      ['dependencies', 'compile'].includes(event.stage)).map(event => event.stage),
    ['dependencies', 'compile']);
    const persisted = receipts(join(prepared.attemptRoot, 'data'));
    assert.equal(persisted.length, 2);
    for (const path of persisted) {
      const { integrity, ...body } = JSON.parse(readFileSync(path));
      assert.equal(hash(json(body)), integrity);
    }
    assertSource(ctx);
  });

test('a case-aliased concurrent runner cannot steal the active controller lease',
  { skip: process.platform !== 'win32' }, async t => {
    const ctx = await fixture(t);
    ctx.gate.args[1] = 'dependencies';
    const controller = new AbortController();
    let conflict, conflictError, check;
    const pending = runPreparationAttempt({ ...ctx.options, signal: controller.signal });
    const timer = setInterval(() => {
      if (conflict || !existsSync(ctx.readyPath)) return;
      conflict = 'checking';
      check = (async () => { try {
        await assert.rejects(runPreparationAttempt({
          ...ctx.options,
          job: { ...ctx.options.job, workspace: ctx.source.toLowerCase() }
        }), error => error.code === 'overlap');
        conflict = 'rejected';
      } catch (error) { conflictError = error; }
      finally { controller.abort(); } })();
    }, 10);
    let outcome;
    try { outcome = await pending; }
    finally { clearInterval(timer); }
    await check;
    if (conflictError) throw conflictError;
    assert.equal(conflict, 'rejected');
    await assertRollback(outcome, ctx);
  });

for (const stage of ['compile', 'compile-output-capture']) {
  test(`${stage} budget interrupts its active phase without accepting partial preparation`,
    { skip: process.platform !== 'win32' }, async t => {
      const ctx = await fixture(t);
      if (stage === 'compile') ctx.gate.args[1] = stage;
      const previousOptions = process.env.NODE_OPTIONS;
      if (stage === 'compile-output-capture') process.env.NODE_OPTIONS = [
        previousOptions, `--import=${json(pathToFileURL(compileReadBarrier(ctx)).href)}`
      ].filter(Boolean).join(' ');
      let result;
      try { result = await expireReadyStage(t, ctx, stage, stage === 'compile' ? 5000 : 1); }
      finally {
        if (previousOptions === undefined) delete process.env.NODE_OPTIONS;
        else process.env.NODE_OPTIONS = previousOptions;
      }
      const { outcome, ready, started } = result;
      assert.equal(outcome.reason, 'stage-budget', json(outcome));
      assert.equal(outcome.stage, stage);
      await assertRollback(outcome, ctx);
      if (stage === 'compile') {
        for (const pid of [ready.pid, ready.child])
          await assertExited(pid, outcome.processExitCheckStartedMs, ctx.root);
      } else {
        assert.equal(ready.id, started.id);
        assert.equal(ready.processId, outcome.controllerPid);
      }
    });
}

test('controller rejection keeps its blocked classification and reason through attempt rollback',
  { skip: process.platform !== 'win32' }, async t => {
    const ctx = await fixture(t);
    ctx.gate.args[1] = 'mutate';
    const outcome = await runPreparationAttempt(ctx.options);
    assert.equal(outcome.status, 'blocked', json(outcome));
    assert.equal(outcome.reason, 'blocked-validation');
    assert.equal(outcome.controllerRejection.blockedReason, 'blocked-validation');
    assert.match(outcome.controllerRejection.error.message, /dependency preparation mutated source/);
    await assertRollback(outcome, ctx);
  });

for (const asynchronous of [false, true]) {
  test(`an unavailable ${asynchronous ? 'async' : 'sync'} parent progress sink cancels without exposing its exception`,
    { skip: process.platform !== 'win32' }, async t => {
    const ctx = await fixture(t);
    const fail = () => { throw new Error('fixture-sensitive-sink-value'); };
    const outcome = await runPreparationAttempt({
      ...ctx.options, onProgress: asynchronous ? async () => fail() : fail
    });
    assert.equal(outcome.reason, 'progress-unavailable', json(outcome));
    await assertRollback(outcome, ctx);
    const retained = readFileSync(join(outcome.attemptRoot, 'journal.jsonl'), 'utf8') + json(outcome);
    assert.equal(retained.includes('fixture-sensitive-sink-value'), false);
  });
}

test('final evidence failure rejects and discards otherwise prepared private receipts',
  { skip: process.platform !== 'win32' }, async t => {
    const ctx = await fixture(t);
    const outcome = await runPreparationAttempt({
      ...ctx.options, onProgress: event => {
        if (event.stage !== 'preparation' || event.phase !== 'finish') return;
        const attempt = readdirSync(ctx.parent).find(name => name.startsWith('preparation-'));
        assert.ok(attempt);
        mkdirSync(join(ctx.parent, attempt, 'outcome.tmp'));
      }
    });
    assert.equal(outcome.status, 'incomplete', json(outcome));
    assert.equal(outcome.secondaryError.code, 'preparation-evidence-failed');
    assert.equal(outcome.prepared, undefined);
    assert.equal(existsSync(join(outcome.attemptRoot, 'outcome.json')), false);
    await assertRollback(outcome, ctx);
  });

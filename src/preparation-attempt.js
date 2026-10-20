import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync,
  openSync, closeSync, fsyncSync, renameSync, rmSync, realpathSync } from 'node:fs';
import { join, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { command } from './workers.js';
import { nativeCommand } from './native-command.js';
import { Ledger } from './ledger.js';
import { hash, json, positive, requireThat } from './common.js';

const childPath = fileURLToPath(new URL('./preparation-attempt-child.js', import.meta.url));
const stages = new Set([
  'source-materialization', 'preparation', 'fingerprint', 'authentication',
  'dependency-checkout', 'compile-checkout', 'dependency-materialization', 'lfs-materialization',
  'dependencies', 'compile', 'dependency-output-capture', 'compile-output-capture',
  'dependency-output-verification', 'compile-output-verification',
  'verification-baseline', 'verification-full', 'verification-settlement'
]);
const within = (root, path) => {
  const suffix = relative(root, path);
  return suffix !== '' && suffix !== '..' &&
    !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
};
const processGone = pid => {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === 'ESRCH') return true; throw error; }
};
async function sourceState(workspace) {
  const git = args => command('git', ['-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=.git/no-hooks', ...args], workspace, undefined,
  { ...process.env, GIT_OPTIONAL_LOCKS: '0' });
  const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const status = (await git(['status', '--porcelain=v1', '--untracked-files=no'])).stdout.trim();
  return { head, status };
}

export async function runPreparationAttempt({
  config, job, repo, revision, attemptParent, wholeTimeoutMs,
  stageTimeoutMs, signal, onProgress = () => {}
}) {
  requireThat(process.platform === 'win32',
    'Bounded preparation requires verified Windows Job Object containment',
    'blocked-preparation-platform');
  positive(wholeTimeoutMs, 'wholeTimeoutMs');
  requireThat(wholeTimeoutMs <= 2147483647,
    'Whole budget exceeds the supported native timer range', 'blocked-preparation-plan');
  requireThat(repo.validationGates.length === 1,
    'Bounded preparation requires exactly one gate', 'blocked-preparation-plan');
  for (const [stage, timeout] of Object.entries(stageTimeoutMs)) {
    requireThat(stages.has(stage), 'Unknown controller preparation stage', 'blocked-preparation-plan');
    positive(timeout, `stageTimeoutMs.${stage}`);
    requireThat(timeout <= wholeTimeoutMs, 'Stage budget exceeds whole budget', 'blocked-preparation-plan');
  }
  requireThat(stages.size === Object.keys(stageTimeoutMs).length,
    'An explicit budget is required for every controller preparation stage',
    'blocked-preparation-plan');
  requireThat(typeof onProgress === 'function',
    'Progress observer must be a controller function', 'blocked-preparation-plan');
  const source = realpathSync.native(job.workspace);
  const parent = realpathSync.native(attemptParent);
  requireThat(source !== parent && !within(source, parent) && !within(parent, source),
    'Attempt parent must be disjoint from the source checkout', 'blocked-preparation-plan');
  const before = await sourceState(source);
  requireThat(before.head === revision && before.status === '',
    'Preparation requires a clean exact-revision source', 'blocked-preparation-source');
  if (signal?.aborted) return {
    status: 'incomplete', accepted: false, reason: 'cancelled',
    sourceRevision: revision, sourceUnchanged: true,
    lockReleased: true, privateDataRemoved: true, ownedProcessesExited: true,
    nativeReuseProved: false
  };
  const ledger = new Ledger(join(parent, 'controller'));
  const lockName = `preparation-attempt:${hash(source)}`;
  let owner;
  try { owner = ledger.acquire(lockName); }
  catch (error) { ledger.close(); throw error; }
  let root, journal, pending, closed, poll, heartbeat;
  const controller = new AbortController();
  const active = new Map();
  const started = performance.now();
  let seen = 0, controllerPid = null, supervisorPid = null;
  let ended = false, sinkFailed = false, stopped = null, drainConfirmed = false;
  const outcome = {
    status: 'incomplete', accepted: false, controllerRejection: null,
    sourceRevision: revision, nativeReuseProved: false
  };
  const event = (kind, detail = {}) => {
    writeFileSync(journal, json({ kind, monotonicMs: performance.now() - started, ...detail }) + '\n');
    fsyncSync(journal);
  };
  const stop = (reason, stage = null) => {
    if (stopped) return;
    stopped = { reason, stage };
    controller.abort();
  };
  const externalAbort = () => stop('cancelled', [...active.values()].at(-1)?.stage ?? null);
  try {
    root = mkdtempSync(join(parent, 'preparation-'));
    outcome.attemptRoot = root;
    mkdirSync(join(root, 'data'));
    journal = openSync(join(root, 'journal.jsonl'), 'wx', 0o600);
    event('attempt-start', { sourceRevision: revision, wholeTimeoutMs, stageTimeoutMs });
    writeFileSync(join(root, 'request.json'), json({
      config, job: { ...job, workspace: source }, repo, revision, wholeTimeoutMs
    }), { flag: 'wx', mode: 0o600 });
    signal?.addEventListener('abort', externalAbort, { once: true });
    if (signal?.aborted) externalAbort();
    const consume = () => {
      const path = join(root, 'progress.jsonl');
      if (!existsSync(path)) return;
      const text = readFileSync(path, 'utf8');
      requireThat(Buffer.byteLength(text) <= 1024 * 1024,
        'Preparation progress exceeded its bound', 'blocked-preparation-progress');
      const lines = text.split('\n').slice(0, -1);
      while (seen < lines.length) {
        const update = JSON.parse(lines[seen]);
        requireThat(!ended && update.sequence === seen + 1 &&
          Number.isFinite(update.elapsedMs) && update.elapsedMs >= 0 &&
          Number.isSafeInteger(update.processId) &&
          update.processId > 0, 'Invalid controller progress sequence', 'blocked-preparation-progress');
        if (!controllerPid) controllerPid = update.processId;
        requireThat(update.processId === controllerPid, 'Controller identity changed',
          'blocked-preparation-progress');
        seen++;
        if (update.kind === 'stage') {
          requireThat(update.gateId === repo.validationGates[0].id &&
            stages.has(update.stage) && Number.isSafeInteger(update.id) &&
            ['start', 'finish', 'failed'].includes(update.phase),
          'Unknown controller preparation progress', 'blocked-preparation-progress');
          const key = update.id;
          if (update.phase === 'start') {
            requireThat(!active.has(key), 'Duplicate active preparation stage', 'blocked-preparation-progress');
            active.set(key, { stage: update.stage, started: performance.now(),
              elapsedMs: update.elapsedMs });
          } else {
            requireThat(active.get(key)?.stage === update.stage,
              'Mismatched controller stage boundary', 'blocked-preparation-progress');
            if (update.elapsedMs - active.get(key).elapsedMs >= stageTimeoutMs[update.stage])
              stop('stage-budget', update.stage);
            active.delete(key);
          }
          event('controller-stage', { update });
          const observed = onProgress(Object.freeze({ ...update }));
          if (observed && typeof observed.then === 'function') {
            Promise.resolve(observed).then(
              () => stop('progress-unavailable'), () => stop('progress-unavailable'));
            requireThat(false, 'Parent progress observers must be synchronous',
              'blocked-preparation-progress');
          }
        } else if (update.kind === 'materialization-step') {
          requireThat(active.get(0)?.stage === 'source-materialization' &&
            ['clone', 'checkout'].includes(update.step) &&
            ['start', 'finish'].includes(update.phase),
          'Unknown controller materialization progress', 'blocked-preparation-progress');
          event('controller-materialization', { update });
        } else {
          requireThat(['start', 'complete', 'infrastructure-failed'].includes(update.kind),
            'Unknown controller progress record', 'blocked-preparation-progress');
          if (update.kind === 'complete') ended = true;
          if (update.kind === 'infrastructure-failed') {
            requireThat(['controller-start', 'source-clone', 'source-checkout',
              'validation-preparation', 'result-publication'].includes(update.operation),
            'Unknown controller failure operation', 'blocked-preparation-progress');
            outcome.infrastructureFailure = {
              operation: update.operation, diagnostic: update.diagnostic
            };
          }
          event('controller-lifecycle', { update });
        }
      }
    };
    const check = () => {
      try {
        consume();
        for (const { stage, started: entryStarted } of active.values())
          if (performance.now() - entryStarted >= stageTimeoutMs[stage])
            stop('stage-budget', stage);
      } catch {
        sinkFailed = true;
        stop('progress-unavailable');
      }
    };
    pending = nativeCommand(process.execPath, [childPath, root], root, wholeTimeoutMs,
      process.env, { signal: controller.signal });
    supervisorPid = pending.child.pid ?? null;
    closed = new Promise(resolve => pending.child.once('close', () => resolve()));
    poll = setInterval(check, 10);
    heartbeat = setInterval(() => {
      try { event('heartbeat', { active: [...active.values()].map(value => value.stage) }); }
      catch { sinkFailed = true; stop('progress-unavailable'); }
    }, 5000);
    let executionFailed = false;
    try { await pending; }
    catch { executionFailed = true; }
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Contained process drain failed')), 10000);
        closed.finally(() => clearTimeout(timer));
      })
    ]);
    clearInterval(poll);
    clearInterval(heartbeat);
    check();
    outcome.processExitCheckStartedMs = Date.now();
    drainConfirmed = supervisorPid !== null && processGone(supervisorPid) &&
      (controllerPid === null || processGone(controllerPid));
    requireThat(drainConfirmed, 'Owned preparation processes did not exit', 'blocked-preparation-drain');
    const elapsed = performance.now() - started;
    if (elapsed >= wholeTimeoutMs && !stopped) stopped = { reason: 'whole-budget', stage: null };
    if (stopped || executionFailed || sinkFailed || !ended || active.size) {
      outcome.reason = stopped?.reason ?? 'controller-incomplete';
      outcome.stage = stopped?.stage ?? null;
    } else {
      const child = JSON.parse(readFileSync(join(root, 'child-result.json')));
      requireThat(Array.isArray(child.gates) && child.gates.length === 1,
        'Controller result is incomplete', 'blocked-preparation-result');
      const gate = child.gates[0];
      requireThat(gate.gateId === repo.validationGates[0].id,
        'Controller result gate changed', 'blocked-preparation-result');
      if (gate.accepted) {
        requireThat(within(join(root, 'data', 'state'), gate.receiptPath) &&
          within(join(root, 'data', 'state'), gate.dependencyReceiptPath),
        'Controller receipt escaped private state', 'blocked-preparation-result');
        outcome.accepted = true;
        outcome.status = 'prepared';
        outcome.prepared = gate;
      } else {
        outcome.status = gate.status ?? 'blocked';
        outcome.reason = gate.blockedReason ?? gate.error?.code;
        outcome.controllerRejection = gate;
      }
    }
  } catch {
    outcome.reason ??= 'controller-infrastructure';
    stop(outcome.reason);
  } finally {
    signal?.removeEventListener('abort', externalAbort);
    clearInterval(poll);
    clearInterval(heartbeat);
    if (!pending) drainConfirmed = true;
    outcome.ownedProcessesExited = drainConfirmed;
    if (!drainConfirmed) {
      outcome.accepted = false;
      outcome.status = 'incomplete';
      outcome.reason = 'drain-unconfirmed';
    }
    try {
      const after = await sourceState(source);
      outcome.sourceUnchanged = json(before) === json(after);
      if (!outcome.sourceUnchanged) {
        outcome.accepted = false;
        outcome.status = 'incomplete';
        outcome.reason = 'source-changed';
      }
      if (!outcome.accepted && root && drainConfirmed)
        rmSync(join(root, 'data'), { recursive: true, force: true, maxRetries: 3 });
      outcome.privateDataRemoved = root ? !existsSync(join(root, 'data')) : false;
      if (drainConfirmed && (outcome.accepted || outcome.privateDataRemoved || !root)) {
        ledger.release(lockName, owner);
        outcome.lockReleased = true;
      } else outcome.lockReleased = false;
    } catch {
      outcome.accepted = false;
      outcome.status = 'incomplete';
      outcome.secondaryError = {
        code: 'preparation-cleanup-failed', message: 'Private preparation cleanup or source inspection failed.'
      };
      outcome.lockReleased = false;
    }
    outcome.wallMs = performance.now() - started;
    outcome.supervisorPid = supervisorPid;
    outcome.controllerPid = controllerPid;
    if (root) {
      try {
        event('attempt-finished', { outcome });
        const temporary = join(root, 'outcome.tmp');
        const fd = openSync(temporary, 'wx', 0o600);
        try { writeFileSync(fd, json(outcome)); fsyncSync(fd); }
        finally { closeSync(fd); }
        renameSync(temporary, join(root, 'outcome.json'));
      } catch {
        outcome.accepted = false;
        outcome.status = 'incomplete';
        outcome.secondaryError = {
          code: 'preparation-evidence-failed', message: 'Final preparation evidence could not be persisted.'
        };
        if (drainConfirmed) {
          try {
            rmSync(join(root, 'data'), { recursive: true, force: true, maxRetries: 3 });
            outcome.privateDataRemoved = !existsSync(join(root, 'data'));
            delete outcome.prepared;
          } catch {
            outcome.privateDataRemoved = false;
            outcome.cleanupError = {
              code: 'preparation-cleanup-failed', message: 'Private preparation cleanup failed.'
            };
          }
        }
      }
    }
    if (journal !== undefined) closeSync(journal);
    ledger.close();
  }
  return outcome;
}

export const preparationStageNames = Object.freeze([...stages]);

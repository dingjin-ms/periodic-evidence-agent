import { spawn } from 'node:child_process';
import { openSync, closeSync, writeSync, fsyncSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { captureProcessIdentity, verifyProcessRelease } from './process-identity.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
export function admitPhase(plan) {
  if (!plan || !Number.isSafeInteger(plan.nativeDeadlineMs) || plan.nativeDeadlineMs <= 0 ||
      !Number.isSafeInteger(plan.cleanupMs) || plan.cleanupMs < 60000 ||
      !Number.isSafeInteger(plan.foregroundMs) || plan.foregroundMs > 600000 ||
      plan.nativeDeadlineMs + plan.cleanupMs + 30000 > plan.foregroundMs)
    throw new Error('Phase deadline plus cleanup/startup must fit the supported 600000ms foreground owner; split independent work or stop.');
  if (!plan.executable || !Array.isArray(plan.args) || !plan.cwd || !plan.output || !plan.sourcePins?.length)
    throw new Error('Exact executable, arguments, cwd, output and source pins are required.');
  for (const pin of plan.sourcePins) if (sha(readFileSync(pin.path)) !== pin.sha256) throw new Error('Source pin changed: ' + pin.path);
  if (!existsSync(plan.executable) || !existsSync(plan.cwd)) throw new Error('Executable or cwd is absent');
  if (existsSync(plan.output)) throw new Error('Attempt exists; inspect it, never redispatch');
}
export async function runPhase(plan) {
  admitPhase(plan);
  const output = resolve(plan.output);
  mkdirSync(output);
  const started = Date.now();
  const events = openSync(join(output, 'phases.jsonl'), 'wx');
  const event = (phase, detail = {}) => { writeSync(events, JSON.stringify({ phase, at: new Date().toISOString(), elapsedMs: Date.now() - started, ...detail }) + '\n'); fsyncSync(events); };
  const supervisor = resolve(fileURLToPath(new URL('./request-phase-supervisor.ps1', import.meta.url)));
  save(join(output, 'reservation.json'), { ...plan, supervisorSha256: sha(readFileSync(supervisor)), startedAt: new Date(started).toISOString(), noRetry: true });
  event('reserved');
  const stdout = openSync(join(output, 'stdout.log'), 'wx');
  const stderr = openSync(join(output, 'stderr.log'), 'wx');
  const env = { ...process.env, ...(plan.env ?? {}), PILOT_PHASE_NATIVE_EVENTS: join(output, 'native-phases.jsonl'),
    PILOT_NATIVE_COMMAND: JSON.stringify({ executable: plan.executable, args: plan.args, nativeDeadlineMs: plan.nativeDeadlineMs }) };
  const child = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', supervisor], {
    cwd: plan.cwd, env, windowsHide: true, stdio: ['ignore', stdout, stderr]
  });
  let identity, timedOut = false, spawnError = null;
  const closed = new Promise(resolveClose => {
    child.once('error', error => { spawnError = error.code ?? 'spawn-error'; });
    child.once('close', (exitCode, signal) => resolveClose({ exitCode, signal }));
  });
  try {
    if (child.pid) {
      identity = captureProcessIdentity(child.pid);
      save(join(output, 'child.json'), identity);
      event('supervisor-started', { pid: child.pid });
    }
  } catch (error) { event('identity-unavailable'); }
  const timer = setTimeout(() => {
    timedOut = true;
    event('supervisor-deadline', { layer: 'supervisor-startup-or-drain' });
    // Only this exact owned supervisor handle is terminated. Its non-inheritable
    // kill-on-close Job Object contains all native descendants.
    child.kill();
  }, Math.max(1, plan.nativeDeadlineMs + 30000 - (Date.now() - started)));
  const terminal = await closed;
  clearTimeout(timer);
  fsyncSync(stdout); fsyncSync(stderr); closeSync(stdout); closeSync(stderr);
  event('supervisor-exited', terminal);
  let cleanup, nativeEvents = [];
  try {
    if (existsSync(join(output, 'native-phases.jsonl'))) nativeEvents = readFileSync(join(output, 'native-phases.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const childEvent = nativeEvents.find(row => row.phase === 'native-started');
    const identities = identity ? [identity] : [];
    if (identity && childEvent) identities.push({ ...identity, pid: childEvent.detail.pid, creationTimeTicks: childEvent.detail.creationTimeTicks });
    cleanup = identity ? { state: 'recorded-supervisor-released', processes: verifyProcessRelease(identities),
      containment: nativeEvents.some(row => row.phase === 'containment-established') ? 'confirmed-kill-on-close-job' : 'unconfirmed',
      nativeChildRecorded: Boolean(childEvent), descendantsEnumerated: false } : { state: 'identity-unverified' };
  } catch { cleanup = { state: 'release-unverified' }; }
  const nativeTimeout = nativeEvents.some(row => row.phase === 'native-deadline');
  if (nativeTimeout) timedOut = true;
  let sourceUnchanged = false;
  try { sourceUnchanged = plan.sourcePins.every(pin => sha(readFileSync(pin.path)) === pin.sha256); } catch {}
  const receipt = { ...terminal, timedOut, timeoutLayer: nativeTimeout ? 'native-child' : timedOut ? 'supervisor-startup-or-drain' : null,
    spawnError, sourceUnchanged, cleanup,
    durationMs: Date.now() - started, finishedAt: new Date().toISOString(),
    stdoutSha256: sha(readFileSync(join(output, 'stdout.log'))), stderrSha256: sha(readFileSync(join(output, 'stderr.log'))),
    status: terminal.exitCode === 0 && !timedOut && !spawnError && sourceUnchanged && cleanup.state === 'recorded-supervisor-released' && cleanup.containment === 'confirmed-kill-on-close-job' && cleanup.nativeChildRecorded ? 'passed' : 'failed' };
  save(join(output, 'terminal.json'), receipt);
  event('collected', { status: receipt.status }); closeSync(events);
  return receipt;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await runPhase(JSON.parse(readFileSync(process.argv[2]))); console.log(JSON.stringify(result)); process.exitCode = result.status === 'passed' ? 0 : 1; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

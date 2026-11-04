import { readFileSync, mkdirSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configAt, hash, requireThat } from './common.js';
import { admitRequestPhase, requestPhases } from './request-phases.js';
import { runPhase } from './request-phase-owner.js';

export async function ownRequestPhase(args) {
  if (args[0] !== 'run-test-request' || process.env.PILOT_REQUEST_PHASE_CHILD === '1') return false;
  const value = key => args[args.indexOf(key) + 1];
  if (!args.includes('--config')) return false;
  const configFile = resolve(value('--config')), config = configAt(configFile);
  const repo = config.repositories.find(row => row.id === config.adoTestRequests?.repoId);
  if (!repo?.requestExecution?.phases) return false;
  requireThat(process.platform === 'win32', 'Durable request phase ownership is currently Windows-only', 'blocked-config');
  const name = args.includes('--phase') ? value('--phase') : 'review';
  let budget;
  if (name === 'review') {
    requireThat(!args.includes('--execute'), 'Use review-only, then explicit maintained request phases', 'blocked-config');
    const policy = repo.requestExecution.phases;
    budget = config.localFilter.timeoutMs + 30000;
    requireThat(policy.scopeApproved === true && budget + 90000 <= policy.foregroundMs &&
      policy.foregroundMs <= 600000 && Date.now() + budget + 60000 < Date.parse(policy.expiresAt),
    'Review allocation does not fit its foreground owner or expiry', 'blocked-budget');
  } else budget = admitRequestPhase(config, repo, name).budgets[name.startsWith('validate-') ? 'validate' : name];
  const root = join(config.stateDirectory, 'request-invocations'); mkdirSync(root, { recursive: true });
  const sourceRoot = fileURLToPath(new URL('.', import.meta.url));
  const sourcePins = readdirSync(sourceRoot).filter(name => lstatSync(join(sourceRoot, name)).isFile())
    .map(name => ({ path: join(sourceRoot, name), sha256: hash(readFileSync(join(sourceRoot, name))) }));
  sourcePins.push({ path: configFile, sha256: hash(readFileSync(configFile)) });
  // Same request/config/phase is one invocation. A missing terminal record cannot authorize replay.
  const runKey = hash(JSON.stringify([value('--id'), hash(readFileSync(configFile))]));
  const runRoot = join(root, runKey); mkdirSync(runRoot, { recursive: true });
  const controllerSha256 = hash(JSON.stringify(sourcePins));
  for (const entry of readdirSync(root)) {
    const other = join(root, entry);
    if (other === runRoot || !lstatSync(other).isDirectory()) continue;
    for (const phase of readdirSync(other)) {
      const reservation = join(other, phase, 'reservation.json');
      if (existsSync(reservation)) {
        const previous = JSON.parse(readFileSync(reservation));
        const index = previous.args.indexOf('--id');
        requireThat(previous.args[index + 1] !== value('--id'),
          'Same request has an invocation under different pins; reconcile without renewed budget', 'blocked-reconciliation');
      }
    }
  }
  const output = join(runRoot, name);
  if (existsSync(output)) {
    const terminal = join(output, 'terminal.json');
    requireThat(existsSync(terminal) && JSON.parse(readFileSync(terminal)).status === 'passed' &&
      JSON.parse(readFileSync(join(output, 'reservation.json'))).controllerSha256 === controllerSha256,
      'Prior CLI phase is interrupted or uncertain; reconcile without replay', 'blocked-reconciliation');
    console.log(JSON.stringify({ phase: name, replayed: true, output, receipt: JSON.parse(readFileSync(terminal)) }));
    return true;
  }
  // A successor cannot consume a child checkpoint before its owning process was collected.
  const order = ['review', ...requestPhases(repo)];
  const prior = order[order.indexOf(name) - 1];
  if (prior) {
    const priorOutput = join(runRoot, prior);
    requireThat(existsSync(join(priorOutput, 'terminal.json')) &&
      JSON.parse(readFileSync(join(priorOutput, 'terminal.json'))).status === 'passed' &&
      JSON.parse(readFileSync(join(priorOutput, 'reservation.json'))).controllerSha256 === controllerSha256,
    'Prior phase owner did not collect a successful terminal result', 'blocked-reconciliation');
  }
  const receipt = await runPhase({ executable: process.execPath,
    args: [fileURLToPath(new URL('./cli.js', import.meta.url)), ...args], cwd: process.cwd(), output,
    nativeDeadlineMs: budget, cleanupMs: 60000, foregroundMs: repo.requestExecution.phases.foregroundMs,
    sourcePins, controllerSha256, env: { PILOT_REQUEST_PHASE_CHILD: '1' }, effects: `One normal request ${name} phase; no retry` });
  console.log(JSON.stringify({ phase: name, output, ...receipt }));
  process.exitCode = receipt.status === 'passed' ? 0 : 1;
  return true;
}

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { hash, json, requireThat, boundedPath, safeError, now } from './common.js';
import { nativeCommand } from './native-command.js';
import { requireExecutionAuthorization } from './execution-authorization.js';
import { minimalEnvironment } from './workers.js';

export function requestExecutionPolicy(repo) {
  const policy = repo.requestExecution;
  if (policy === undefined) return null;
  requireThat(policy?.enabled === true && policy.scopeApproved === true && policy.approvalRef?.trim() &&
    policy.nativeHooks === '.githooks', 'Request execution requires approved native-hook policy', 'blocked-authorization');
  const check = step => {
    requireThat(step && isAbsolute(step.executable) && /^[a-f0-9]{64}$/.test(step.executableSha256 ?? '') &&
      hash(readFileSync(step.executable)) === step.executableSha256 && Array.isArray(step.args) &&
      step.args.every(arg => typeof arg === 'string') && Number.isSafeInteger(step.timeoutMs) && step.timeoutMs > 0 && step.timeoutMs <= 120000,
    'Request preparation command must be pinned and bounded', 'blocked-config');
    requireThat(Array.isArray(step.files) && step.files.length > 0 && step.files.length <= 20 &&
      step.files.every(pin => isAbsolute(pin.path) && /^[a-f0-9]{64}$/.test(pin.sha256) && hash(readFileSync(pin.path)) === pin.sha256),
    'Request preparation tool files changed', 'blocked-reconciliation');
  };
  check(policy.preflight);
  requireThat(Array.isArray(policy.requiredCapabilities) && policy.requiredCapabilities.length > 0 &&
    policy.requiredCapabilities.every(name => typeof name === 'string' && /^[a-z][a-z0-9-]{1,79}$/.test(name)),
  'Explicit readiness capability population required', 'blocked-config');
  if (policy.formatMarkdown) {
    check(policy.formatMarkdown);
    requireThat(policy.formatMarkdown.args.includes('--write'), 'Formatter must declare write mode', 'blocked-config');
  }
  return policy;
}
export function requestHookEnvironment(repo, environment) {
  if (!requestExecutionPolicy(repo)) return environment;
  for (const name of ['SKIP_PRE_COMMIT', 'SKIP_PRE_PUSH', 'HUSKY']) {
    const value = environment[name];
    requireThat(value === undefined || (name === 'HUSKY' ? value !== '0' : !/^(1|true)$/i.test(value)),
      'Native hook bypass is not permitted by request execution', 'blocked-authorization');
  }
  const targetRef = repo.pr?.targetRef;
  requireThat(typeof targetRef === 'string' && /^refs\/heads\/[A-Za-z0-9._/-]+$/.test(targetRef) &&
    !targetRef.includes('..') && !targetRef.endsWith('/'), 'Native hooks need an exact approved target', 'blocked-config');
  return { ...environment, SYSTEM_PULLREQUEST_TARGETBRANCH: targetRef };
}

function population(workspace) {
  const git = args => execFileSync('git', ['-C', workspace, ...args], { timeout: 10000, maxBuffer: 1024 * 1024 }).toString().split('\0').filter(Boolean);
  const files = [...new Set([...git(['diff', '--name-only', '--no-renames', '-z', 'HEAD']),
    ...git(['ls-files', '--others', '--exclude-standard', '-z'])])].sort();
  return files.map(path => ({ path, sha256: hash(readFileSync(boundedPath(workspace, path))) }));
}
const op = (ledger, id) => ledger.status().operations.find(row => row.id === id);
const pins = policy => hash(json(policy));
const run = (step, workspace, files, execute) => execute(step.executable,
  step.args.map(arg => arg.replaceAll('{workspace}', workspace)).concat(files), workspace, step.timeoutMs, minimalEnvironment());

export async function preflightRequestExecution(config, ledger, job, repo, execute = nativeCommand) {
  const policy = requestExecutionPolicy(repo);
  if (!policy) return null;
  const id = `${job.id}:request-preflight`;
  requireThat(!op(ledger, id), 'Request preflight already attempted; reconcile without replay', 'blocked-reconciliation');
  const before = population(job.workspace), configurationSha256 = hash(json(config)), policySha256 = pins(policy);
  ledger.operation(id, job.id, 'request-execution-preflight', { configurationSha256, policySha256, revision: job.base_revision });
  try {
    requireThat(existsSync(join(job.workspace, policy.nativeHooks, 'pre-commit')) &&
      existsSync(join(job.workspace, policy.nativeHooks, 'pre-push')), 'Native hooks are missing from candidate', 'blocked-validation');
    requireExecutionAuthorization(config, repo, 'model');
    const result = await run(policy.preflight, job.workspace, [], execute);
    requireExecutionAuthorization(config, repo, 'model');
    const readiness = JSON.parse(result.stdout);
    requireThat(readiness.sourceRevision === job.base_revision && typeof readiness.evidenceRef === 'string' && readiness.evidenceRef.trim(),
      'Readiness must identify source and qualification evidence', 'blocked-reconciliation');
    requireThat(readiness.status === 'ready' && Array.isArray(readiness.capabilities) &&
      policy.requiredCapabilities.every(name => readiness.capabilities.includes(name)),
    'Required harness readiness is missing, not an authoring opportunity', 'blocked-harness');
    requireThat(hash(json(config)) === configurationSha256 && pins(requestExecutionPolicy(repo)) === policySha256 &&
      json(population(job.workspace)) === json(before), 'Preflight changed source or authority', 'blocked-reconciliation');
    const receipt = { configurationSha256, policySha256, revision: job.base_revision,
      readiness, stdoutSha256: hash(result.stdout), stderrSha256: hash(result.stderr ?? ''), checkedAt: now() };
    ledger.finishOperation(id, 'passed', receipt);
    return receipt;
  } catch (error) { ledger.finishOperation(id, 'blocked', { configurationSha256, policySha256, error: safeError(error) }); throw error; }
}

export async function formatAcceptedMarkdown(config, ledger, job, repo, proposal, round, execute = nativeCommand) {
  const policy = requestExecutionPolicy(repo);
  if (!policy?.formatMarkdown) return null;
  const before = population(job.workspace), files = before.filter(file => file.path.endsWith('.md'));
  const id = `${job.id}:accepted-format:${round}`, policySha256 = pins(policy), configurationSha256 = hash(json(config));
  const previous = op(ledger, id);
  if (previous) {
    const receipt = JSON.parse(previous.detail);
    requireThat(previous.state === 'complete' && receipt.configurationSha256 === configurationSha256 &&
      receipt.policySha256 === policySha256 && receipt.proposalSha256 === hash(json(proposal)) &&
      json(receipt.after) === json(before) && receipt.originals.every(file => hash(readFileSync(file.artifact)) === file.sha256),
    'Accepted formatting changed or is uncertain; no automatic replay', 'blocked-reconciliation');
    return { ...receipt, replayed: true };
  }
  if (!files.length) return null;
  const directory = join(config.stateDirectory, 'accepted-format', hash(id));
  mkdirSync(directory, { recursive: true });
  const originals = files.map((file, index) => {
    const content = readFileSync(boundedPath(job.workspace, file.path));
    const path = join(directory, `${index}.md`); writeFileSync(path, content, { flag: 'wx' });
    return { ...file, artifact: path };
  });
  ledger.operation(id, job.id, 'accepted-markdown-format', { proposal: structuredClone(proposal), before, originals, policySha256, configurationSha256 });
  try {
    requireExecutionAuthorization(config, repo, 'commit');
    const result = await run(policy.formatMarkdown, job.workspace, files.map(file => file.path), execute);
    requireExecutionAuthorization(config, repo, 'commit');
    const after = population(job.workspace);
    requireThat(pins(requestExecutionPolicy(repo)) === policySha256 && hash(json(config)) === configurationSha256 &&
      json(before.map(file => file.path)) === json(after.map(file => file.path)), 'Formatting changed scope or authority', 'blocked-reconciliation');
    for (const file of before) {
      const next = after.find(row => row.path === file.path);
      if (next.sha256 === file.sha256) continue;
      const original = originals.find(row => row.path === file.path);
      const normalize = bytes => bytes.toString('utf8').trim().split(/\s+/).join(' ');
      requireThat(original && normalize(readFileSync(original.artifact)) === normalize(readFileSync(boundedPath(job.workspace, file.path))),
        'Formatting altered executable bytes or Markdown content', 'blocked-scope');
    }
    const receipt = { before, after, originals, proposalSha256: hash(json(proposal)), policySha256, configurationSha256,
      controllerTransform: true, modelReinvoked: false, stdoutSha256: hash(result.stdout), stderrSha256: hash(result.stderr ?? ''), formattedAt: now() };
    ledger.finishOperation(id, 'complete', receipt); return receipt;
  } catch (error) { ledger.finishOperation(id, 'blocked', { before, originals, policySha256, configurationSha256, error: safeError(error) }); throw error; }
}

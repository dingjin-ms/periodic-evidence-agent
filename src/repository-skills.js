import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { boundedPath, hash, requireThat } from './common.js';

const exec = promisify(execFile);
async function execute(executable, args, cwd, timeout = 120000, env = process.env) {
  return exec(executable, args, { cwd, env, windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
}

export function resolveSkillBinding(config, repoId, capability, bindingId = null,
  { requireQualified = true, requireEnabled = true, requireRouted = true } = {}) {
  const repo = config.repositories.find(candidate => candidate.id === repoId);
  requireThat(repo, `Unknown repository ${repoId}`, 'blocked-owner');
  if (requireRouted)
    requireThat(repo.routingApproved === true && repo.owner, `Repository ${repoId} ownership is unresolved`);
  const bindings = repo.skillBindings ?? [];
  const matches = bindings.filter(binding => binding.capability === capability &&
    (!bindingId || binding.id === bindingId));
  requireThat(matches.length === 1, `Repository ${repoId} needs one unambiguous ${capability} skill binding`,
    'blocked-owner');
  const binding = matches[0];
  if (requireEnabled)
    requireThat(binding.enabled === true, `Repository skill binding ${binding.id} is disabled`, 'blocked-config');
  if (requireQualified)
    requireThat(binding.qualification === 'qualified', `Repository skill binding ${binding.id} is unqualified`,
      'blocked-config');
  requireThat(typeof binding.skillPath === 'string' && binding.skillPath.length > 0 &&
    !isAbsolute(binding.skillPath), `Repository skill binding ${binding.id} has an invalid path`, 'blocked-scope');
  requireThat(Array.isArray(binding.requestedOutcomes) && binding.requestedOutcomes.length > 0,
    `Repository skill binding ${binding.id} has no requested outcomes`);
  requireThat(binding.sideEffects && ['commit', 'push', 'createDraftPR'].every(key =>
    typeof binding.sideEffects[key] === 'boolean'), `Repository skill binding ${binding.id} lacks explicit side effects`);
  return { repo, binding };
}

export function loadRepositorySkill(config, assignment, workspace, sourceRevision) {
  requireThat(assignment.skillBindingId && assignment.capability,
    'Repository skill execution requires an assignment capability and binding');
  const { binding } = resolveSkillBinding(config, assignment.repoId, assignment.capability,
    assignment.skillBindingId);
  const path = boundedPath(workspace, binding.skillPath);
  requireThat(statSync(path).isFile() && statSync(path).size <= config.limits.maxFileBytes,
    'Repository skill exceeds the configured read limit', 'blocked-budget');
  return {
    binding,
    instructions: readFileSync(path, 'utf8'),
    skillRevision: sourceRevision,
    skillPath: binding.skillPath.replaceAll('\\', '/')
  };
}

export function normalizeSkillResult(loaded, result) {
  requireThat(result && typeof result === 'object' &&
    ['succeeded', 'failed', 'needs-input', 'blocked'].includes(result.status),
  'Repository skill returned an invalid status', 'blocked-result');
  const arrays = ['changedFiles', 'testsAddedOrUpdated', 'behaviorCardsAddedOrUpdated', 'unknowns'];
  for (const field of arrays)
    requireThat(Array.isArray(result[field] ?? []) && (result[field] ?? []).every(value =>
      typeof value === 'string' && value.length > 0), `Repository skill returned invalid ${field}`, 'blocked-result');
  requireThat(typeof result.needsHumanDecision === 'boolean',
    'Repository skill must explicitly state whether a human decision is needed', 'blocked-result');
  const normalized = {
    bindingId: loaded.binding.id, capability: loaded.binding.capability,
    skillPath: loaded.skillPath, skillRevision: loaded.skillRevision,
    status: result.status, classification: result.classification ?? null,
    changedFiles: [...new Set(result.changedFiles ?? [])].sort(),
    testsAddedOrUpdated: [...new Set(result.testsAddedOrUpdated ?? [])].sort(),
    behaviorCardsAddedOrUpdated: [...new Set(result.behaviorCardsAddedOrUpdated ?? [])].sort(),
    unknowns: [...new Set(result.unknowns ?? [])].sort(),
    needsHumanDecision: result.needsHumanDecision
  };
  if (normalized.status === 'succeeded' && normalized.changedFiles.length === 0 &&
      normalized.testsAddedOrUpdated.length === 0)
    requireThat(result.classification === 'existing-coverage',
      'A successful no-change skill result must identify existing coverage', 'blocked-result');
  return normalized;
}

export async function qualifyRepositorySkill(config, repoId, capability, bindingId = null, runCommand = execute) {
  const { repo, binding } = resolveSkillBinding(config, repoId, capability, bindingId,
    { requireQualified: false, requireEnabled: false, requireRouted: false });
  requireThat(isAbsolute(repo.referenceCheckout) && repo.baseRef && repo.remote,
    `Repository ${repoId} reference checkout, base and remote are required for qualification`);
  const run = args => runCommand('git', ['-c', 'core.hooksPath=', ...args], repo.referenceCheckout);
  const baseRevision = (await run(['rev-parse', '--verify', `${repo.baseRef}^{commit}`])).stdout.trim();
  requireThat(/^[a-f0-9]{40,64}$/.test(baseRevision), 'Repository skill qualification resolved an invalid base revision');
  const remote = (await run(['remote', 'get-url', 'origin'])).stdout.trim().replace(/\/$/, '');
  requireThat(remote.toLowerCase() === repo.remote.replace(/\/$/, '').toLowerCase(),
    `Repository ${repoId} origin does not match its configured remote`, 'blocked-scope');
  await run(['cat-file', '-e', `${baseRevision}:${binding.skillPath.replaceAll('\\', '/')}`]);
  const content = (await run(['show', `${baseRevision}:${binding.skillPath.replaceAll('\\', '/')}`])).stdout;
  requireThat(Buffer.byteLength(content) <= config.limits.maxFileBytes,
    'Repository skill exceeds the configured read limit', 'blocked-budget');
  return {
    repoId, bindingId: binding.id, capability: binding.capability,
    referenceCheckout: repo.referenceCheckout, remote, baseRef: repo.baseRef, baseRevision,
    skillPath: binding.skillPath.replaceAll('\\', '/'), skillSha256: hash(content),
    state: 'qualified-read-only', sideEffects: binding.sideEffects
  };
}

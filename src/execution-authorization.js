import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { hash, requireThat } from './common.js';

export function requireStandaloneAlAllocation(approval, root, count, purpose, repo) {
  requireThat(approval.format === 'al-e2e-model-allocation-v1' && approval.approvedBy === 'parent' &&
    approval.model === 'gpt-6-luna' && typeof root === 'string' && isAbsolute(root) && approval.runDirectory === root &&
    typeof approval.repoId === 'string' && approval.repoId.length > 0 &&
    /^[a-f0-9]{40}$/.test(approval.baseRevision ?? '') &&
    (!repo || (approval.repoId === repo.id && approval.baseRevision === repo.baseRef)) &&
    ['filter', 'proposer'].includes(purpose) && Number.isSafeInteger(count) && count > 0 &&
    approval.maxTotalSessions === 30 && Number.isSafeInteger(approval.priorActualSessions) &&
    approval.priorActualSessions >= 0 && Number.isSafeInteger(approval.maxAdditionalSessions) &&
    approval.maxAdditionalSessions >= count &&
    approval.priorActualSessions + approval.maxAdditionalSessions <= 30 &&
    Array.isArray(approval.purposes) && approval.purposes.includes(purpose) &&
    typeof approval.allowPublication === 'boolean' && Date.parse(approval.deadlineAt) > Date.now(),
  'AL model calls need a current parent-coordinated, repository/source/run-bound allocation within the global cap',
  'blocked-authorization');
}

export function requireExecutionAuthorization(config, repo, action) {
  const binding = config.runtime?.executionAuthorization;
  if (binding === undefined) return null;
  requireThat(binding && ['model', 'commit', 'push', 'draft'].includes(action) &&
    binding.repoId === repo.id && binding.baseRevision === repo.baseRef &&
    typeof binding.reference?.path === 'string' && isAbsolute(binding.reference.path) &&
    /^[a-f0-9]{64}$/.test(binding.reference?.sha256 ?? ''),
  'Execution authorization is not bound to this repository/source', 'blocked-authorization');
  const bytes = readFileSync(binding.reference.path);
  requireThat(hash(bytes) === binding.reference.sha256,
    'Execution authorization changed after reservation', 'blocked-authorization');
  const authority = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  if (authority.format === 'al-e2e-model-allocation-v1') {
    requireStandaloneAlAllocation(authority, binding.runDirectory, binding.sessionCount, binding.purpose, repo);
    requireThat(binding.purpose !== 'proposer' || (config.runtime.authoringModel === authority.model &&
      (repo.skillBindings ?? []).every(skill => (skill.authoringProvider ?? 'copilot-sdk') === 'copilot-sdk')),
    'AL Proposer requires the pinned model and copilot-sdk authoring provider', 'blocked-authorization');
    requireThat(action === 'model' || (binding.purpose === 'proposer' && authority.allowPublication === true),
      `Execution authorization does not permit ${action}`, 'blocked-authorization');
    return authority;
  }
  requireThat(authority.format === 'al-recurring-authorization-v1' &&
    authority.planSha256 === binding.planSha256 &&
    Date.parse(authority.approvedAt) <= Date.now() && Date.parse(authority.expiresAt) > Date.now() &&
    (action === 'model' ? authority.allowModels === true : authority.allowPublication === true),
  `Execution authorization expired or does not permit ${action}`, 'blocked-authorization');
  return authority;
}

export function authorizedModelTimeout(config, repo, configuredTimeout) {
  const authority = requireExecutionAuthorization(config, repo, 'model');
  if (!authority) return configuredTimeout;
  const remaining = Date.parse(authority.format === 'al-e2e-model-allocation-v1'
    ? authority.deadlineAt : authority.expiresAt) - Date.now();
  requireThat(remaining > 0, 'Execution authorization expired before model submission', 'blocked-authorization');
  return Math.min(configuredTimeout, remaining);
}

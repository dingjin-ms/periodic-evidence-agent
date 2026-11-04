import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { hash, json, requireThat, boundedPath, now } from './common.js';

export const requestPhases = repo => ['prepare', 'author', 'commit', ...repo.validationGates.map(gate => `validate-${gate.id}`), 'publish'];
const git = (workspace, args) => execFileSync('git', ['-C', workspace, ...args], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 }).toString();
function source(workspace) {
  const paths = [...new Set([...git(workspace, ['diff', '--name-only', '--no-renames', '-z', 'HEAD']).split('\0'),
    ...git(workspace, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0')].filter(Boolean))].sort();
  return { head: git(workspace, ['rev-parse', 'HEAD']).trim(),
    files: paths.map(path => ({ path, sha256: hash(readFileSync(boundedPath(workspace, path))) })) };
}
export function admitRequestPhase(config, repo, phase) {
  const policy = repo.requestExecution?.phases;
  if (!phase) { requireThat(!policy, 'Phased requests require an explicit --phase', 'blocked-config'); return null; }
  requireThat(requestPhases(repo).includes(phase) && policy?.scopeApproved === true && policy.approvalRef?.trim() &&
    Date.parse(policy.expiresAt) > Date.now() && policy.foregroundMs <= 600000 && policy.foregroundMs >= 120000 &&
    Number.isSafeInteger(policy.maxTotalMs) && policy.maxTotalMs > 0 &&
    config.limits.maxValidationRepairRounds === 0 && config.limits.maxValidationInfrastructureRetries === 0 &&
    !repo.remoteValidation && !repo.draftBuild?.enabled && !config.rsi?.enabled && !repo.changeFile &&
    repo.validationGates.length > 0 && repo.validationGates.every(gate => !gate.profile && !gate.profilePath),
  'Phased requests need current bounded zero-retry local authority', 'blocked-authorization');
  const names = requestPhases(repo), budgets = policy.budgets;
  const budgetFor = name => name.startsWith('validate-') ? budgets.validate : budgets[name];
  requireThat(budgets && names.every(name => Number.isSafeInteger(budgetFor(name)) && budgetFor(name) > 0 &&
    budgetFor(name) + 90000 <= policy.foregroundMs), 'Indivisible request phase exceeds foreground ownership', 'blocked-budget');
  const required = { prepare: (repo.provisionTimeoutMs ?? 120000) + (repo.requestExecution.tools?.timeoutMs ?? 0) + repo.requestExecution.preflight.timeoutMs,
    author: config.limits.workerMinutes * 60000,
    commit: (repo.requestExecution.formatMarkdown?.timeoutMs ?? 0) + (repo.requestExecution.commitTimeoutMs ?? 120000),
    publish: (repo.requestExecution.pushTimeoutMs ?? 120000) + (repo.requestExecution.draftTimeoutMs ?? 120000),
    ...Object.fromEntries(repo.validationGates.map(gate => [`validate-${gate.id}`, gate.timeoutMs + (repo.provisionTimeoutMs ?? 120000) + (repo.requestExecution.tools?.timeoutMs ?? 0)])) };
  requireThat(budgetFor(phase) >= required[phase] && Date.now() + budgetFor(phase) + 60000 < Date.parse(policy.expiresAt),
    'Request phase cannot fit its native budgets or authority expiry', 'blocked-budget');
  return policy;
}
export function readRequestPhase(config, ledger, job, repo, phase) {
  const policy = admitRequestPhase(config, repo, phase);
  if (!policy) return null;
  const rows = ledger.status().operations.filter(row => row.job_id === job.id && row.kind === 'request-phase');
  requireThat(rows.every(row => row.state === 'complete'), 'Interrupted request phase needs reconciliation; never replay effects', 'blocked-reconciliation');
  const names = requestPhases(repo), budgetMs = policy.budgets[phase.startsWith('validate-') ? 'validate' : phase];
  const priorName = names[names.indexOf(phase) - 1];
  const previous = rows.find(row => row.id === `${job.id}:phase:${priorName}`);
  requireThat(phase === 'prepare' ? rows.length === 0 : previous && rows.length === names.indexOf(phase),
    'Request phase is out of order or already consumed', 'blocked-reconciliation');
  const receipt = previous ? JSON.parse(previous.detail) : null;
  if (receipt) requireThat(receipt.configurationSha256 === hash(json(config)) && receipt.assignmentSha256 === hash(json(ledger.get('assignment', job.id))) &&
    receipt.workspace === job.workspace && json(source(job.workspace)) === json(receipt.source) && job.state === 'phase-complete',
  'Request checkpoint source/config/assignment changed', 'blocked-reconciliation');
  const usedMs = rows.reduce((sum, row) => sum + JSON.parse(row.detail).elapsedMs, 0);
  requireThat(usedMs + budgetMs <= policy.maxTotalMs, 'Total request allocation exhausted', 'blocked-budget');
  return { phase, policy, names, budgetMs, receipt, usedMs, configurationSha256: hash(json(config)), started: Date.now(), id: `${job.id}:phase:${phase}` };
}
export function startRequestPhase(config, ledger, job, phase) {
  if (!phase) return;
  ledger.operation(phase.id, job.id, 'request-phase', { phase: phase.phase, configurationSha256: hash(json(config)),
    startedAt: now(), budgetMs: phase.budgetMs, usedMs: phase.usedMs });
}
export function completeRequestPhase(config, ledger, job, phase, payload) {
  const elapsedMs = Date.now() - phase.started;
  requireThat(hash(json(config)) === phase.configurationSha256 && elapsedMs <= phase.budgetMs && Date.now() < Date.parse(phase.policy.expiresAt),
    'Request phase exceeded its allocation; checkpoint is not continuable', 'blocked-budget');
  const receipt = { phase: phase.phase, configurationSha256: hash(json(config)),
    assignmentSha256: hash(json(ledger.get('assignment', job.id))), workspace: job.workspace, source: source(job.workspace),
    payload, elapsedMs, totalUsedMs: phase.usedMs + elapsedMs, finishedAt: now(), processesCollected: true };
  ledger.transaction(() => {
    ledger.finishOperation(phase.id, 'complete', receipt);
    ledger.moveJob(job.id, 'running', 'phase-complete');
  });
  return { state: 'phase-complete', phase: phase.phase, assignmentId: job.id, nextPhase: phase.names[phase.names.indexOf(phase.phase) + 1], publication: 'none' };
}

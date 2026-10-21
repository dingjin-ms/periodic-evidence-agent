import { activeWorkerCount, activeRepositoryWorkerCount } from './agency-executor.js';
import { dispatch } from './workers.js';
import { now, positive, requireThat, safeError, uuid } from './common.js';

function preparedJobs(ledger) {
  return ledger.db.prepare(`SELECT j.id,j.repo,j.updated_at,r.body
    FROM jobs j JOIN records r ON r.kind='assignment' AND r.id=j.id
    WHERE j.state='prepared'
    AND r.version=(SELECT MAX(latest.version) FROM records latest
      WHERE latest.kind='assignment' AND latest.id=j.id)
    ORDER BY j.updated_at,j.repo,j.id`).all().map(row => ({
    id: row.id, repoId: row.repo, updatedAt: row.updated_at,
    assignment: JSON.parse(row.body)
  }));
}

export function selectPreparedAssignments(config, ledger, { limit = null } = {}) {
  const globalLimit = positive(config.limits.maxWorkers, 'maxWorkers');
  const repositoryLimit = positive(
    config.limits.maxWorkersPerRepository ?? 1, 'maxWorkersPerRepository');
  const requested = limit === null ? globalLimit : positive(limit, 'scheduler limit');
  const available = Math.max(0, globalLimit - activeWorkerCount(ledger));
  const maximum = Math.min(requested, available);
  const selected = [];
  const pending = preparedJobs(ledger);
  const repositoryOrder = [...new Set(pending.map(job => job.repoId))]
    .filter(id => config.repositories.some(repo => repo.id === id));
  const activeByRepository = new Map(config.repositories.map(repo => [
    repo.id, activeRepositoryWorkerCount(ledger, repo.id)
  ]));
  const selectedByRepository = new Map();
  while (selected.length < maximum) {
    let progressed = false;
    for (const repoId of repositoryOrder) {
      const index = pending.findIndex(job => job.repoId === repoId);
      if (index < 0) continue;
      const active = activeByRepository.get(repoId) ?? 0;
      const reserved = selectedByRepository.get(repoId) ?? 0;
      if (active + reserved >= repositoryLimit) continue;
      selected.push(pending.splice(index, 1)[0]);
      selectedByRepository.set(repoId, reserved + 1);
      progressed = true;
      if (selected.length >= maximum) break;
    }
    if (!progressed) break;
  }
  return {
    active: activeWorkerCount(ledger),
    globalLimit,
    repositoryLimit,
    available,
    selected,
    deferred: pending
  };
}

export async function schedulePreparedAssignments(config, ledger, {
  execute = false,
  limit = null,
  authorizeCommit = false,
  authorizePush = false,
  authorizeDraftPR = false
} = {}, dependencies = {}) {
  requireThat(config.activation.dispatch, 'Worker dispatch is disabled');
  if (execute) {
    requireThat(authorizeCommit === true && authorizePush === true &&
      authorizeDraftPR === true,
    'Scheduler execution requires explicit commit, push and Draft PR authorization',
    'blocked-config');
  }
  const owner = ledger.acquire('assignment-scheduler');
  let operationId;
  let selection;
  let executions = [];
  try {
    selection = selectPreparedAssignments(config, ledger, { limit });
    if (!execute || selection.selected.length === 0)
      return { mode: execute ? 'execute' : 'preview', ...selection, results: [] };
    operationId = `assignment-scheduler:${uuid()}`;
    ledger.operation(operationId, 'controller', 'assignment-scheduler', {
      selectedAssignmentIds: selection.selected.map(job => job.id),
      selectedRepositories: selection.selected.map(job => job.repoId),
      globalLimit: selection.globalLimit,
      repositoryLimit: selection.repositoryLimit,
      startedAt: now()
    });
    const launch = dependencies.dispatchAssignment ?? dispatch;
    executions = selection.selected.map(async job => {
      try {
        const result = await launch(config, ledger, job.id,
          dependencies.dispatchDependencies?.[job.id] ??
            dependencies.dispatchDependencies ?? {});
        return {
          assignmentId: job.id, repoId: job.repoId,
          state: result?.state ?? ledger.job(job.id)?.state ?? null,
          outcome: result?.outcome ?? null,
          ...(result?.actions ? { actions: result.actions } : {})
        };
      } catch (error) {
        return {
          assignmentId: job.id, repoId: job.repoId,
          state: ledger.job(job.id)?.state ?? null,
          error: safeError(error)
        };
      }
    });
  } finally {
    ledger.release('assignment-scheduler', owner);
  }
  const results = await Promise.all(executions);
  const completedAt = now();
  const state = results.some(result => result.error ||
    ['action-required-auth', 'blocked', 'blocked-auth', 'failed', 'uncertain',
      'partial', 'partial-or-blocked', 'draft-pr-validation-failed'].includes(result.state) ||
    ['blocked', 'draft-pr-validation-failed', 'diagnostic-failed'].includes(result.outcome))
    ? 'partial' : 'completed';
  ledger.finishOperation(operationId, state, {
    selectedAssignmentIds: selection.selected.map(job => job.id),
    selectedRepositories: selection.selected.map(job => job.repoId),
    globalLimit: selection.globalLimit,
    repositoryLimit: selection.repositoryLimit,
    results,
    completedAt
  });
  return { mode: 'execute', state, ...selection, results, operationId, completedAt };
}

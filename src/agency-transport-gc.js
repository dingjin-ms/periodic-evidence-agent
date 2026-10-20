import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  now, PilotError, safeError, uuid, workspaceCleanupPolicy
} from './common.js';
import { adoAccessToken, adoGitEnvironment } from './ado-auth.js';

const exec = promisify(execFile);
const deliveredOutcomes = ['draft-pr-validated', 'draft-pr-validation-failed'];

function retain(condition, reason) {
  if (!condition) throw new PilotError('transport-retained', reason);
}
function exactTransportRef(ref, assignmentId, kind, round) {
  return ref === `refs/heads/pilot-agency-${kind}/${assignmentId}/round-${round}`;
}
function inside(root, path) {
  const rel = relative(root, path);
  return rel === '' ||
    (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
async function git(workspace, args, env = process.env) {
  const result = await exec('git', [
    '-c', 'core.hooksPath=.git/no-hooks',
    '-c', 'credential.interactive=never',
    ...args
  ], {
    cwd: workspace,
    env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_PUSH: '1' },
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
    encoding: 'utf8'
  });
  return result.stdout.trim();
}
async function gitEnvironment(config, repo, getToken, purpose) {
  return /^https:\/\/(?:dev\.azure\.com\/|[^/]+\.visualstudio\.com\/)/i.test(repo.remote)
    ? adoGitEnvironment(await getToken(config, purpose))
    : process.env;
}
async function remoteHead(config, repo, ref, workspace, getToken) {
  const env = await gitEnvironment(config, repo, getToken,
    'Agency transport cleanup verification');
  const output = await git(workspace,
    ['ls-remote', '--heads', '--', repo.remote, ref], env);
  const lines = output.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return null;
  retain(lines.length === 1 && lines[0].split(/\s+/)[1] === ref,
    `Transport ref ${ref} is ambiguous`);
  return lines[0].split(/\s+/)[0];
}
async function deleteRemoteRefs(config, repo, refs, workspace, getToken) {
  const env = await gitEnvironment(config, repo, getToken,
    'Agency transport branch deletion');
  await git(workspace, ['push', '--no-verify', '--', repo.remote,
    ...refs.map(ref => `:${ref}`)], env);
}
function remoteRounds(ledger, assignmentId) {
  return ledger.db.prepare(`SELECT id,detail FROM operations
    WHERE job_id=? AND kind='agency-remote-result' AND state='completed'
    ORDER BY updated_at,id`).all(assignmentId).map(row => ({
    operationId: row.id,
    ...JSON.parse(row.detail)
  }));
}

export async function cleanupAgencyTransport(config, ledger, assignmentId,
  { execute = false } = {}, dependencies = {}) {
  const existing = ledger.transportCleanup(assignmentId);
  if (existing?.state === 'removed') return { ...existing, checkedAt: now() };
  const job = ledger.job(assignmentId);
  let owner;
  let operationId;
  let detail = {
    assignmentId,
    state: 'skipped',
    reason: 'Agency transport branches retained',
    checkedAt: now()
  };
  try {
    retain(job?.state === 'completed', 'Task is not completed');
    owner = ledger.acquire(`transport-cleanup:${assignmentId}`);
    const unfinished = ledger.db.prepare(`SELECT id,kind FROM operations
      WHERE job_id=? AND state IN ('started','running','reserved','uncertain')`)
      .all(assignmentId);
    retain(unfinished.length === 0 ||
      (existing?.state === 'deleting' &&
        unfinished.every(operation =>
          operation.kind === 'agency-transport-cleanup')),
    'Task has an unfinished operation');
    retain(!ledger.db.prepare('SELECT name FROM locks WHERE owner<>? LIMIT 1')
      .get(owner), 'Another controller operation holds a lock');
    const result = ledger.all('workerResult').filter(item =>
      item.assignmentId === assignmentId &&
      item.attemptId === job.session_id).at(-1);
    retain(result && deliveredOutcomes.includes(result.outcome) &&
      !result.blocker && result.draftPR?.isDraft === true &&
      result.draftPR.headRevision === result.sourceRevision,
    'Task has no complete Draft PR delivery receipt');
    const policy = workspaceCleanupPolicy(config);
    retain(Number.isFinite(Date.parse(result.reportedAt)) &&
      Date.now() - Date.parse(result.reportedAt) >=
        policy.retentionHours * 3600000,
    'Transport branches are within their retention period');
    const repo = config.repositories.find(item => item.id === job.repo);
    retain(repo?.remote, 'Repository remote is unavailable');
    const workspace = existsSync(job.workspace ?? '')
      ? job.workspace : repo.referenceCheckout;
    retain(workspace && existsSync(workspace),
      'No trusted checkout is available for transport cleanup');
    const verifyCheckout = dependencies.verifyCheckout ??
      (async () => await git(workspace, ['remote', 'get-url', 'origin']) ===
        repo.remote);
    retain(await verifyCheckout(config, repo, workspace),
      'Cleanup checkout remote differs from the configured repository');
    const artifacts = [
      ...(result.validation ?? []),
      ...(result.validationAttempts ?? []).flatMap(attempt =>
        attempt.validation ?? [])
    ].flatMap(validation => validation.artifactRefs ?? []);
    const stateRoot = realpathSync.native(resolve(config.stateDirectory));
    const physicalWorkspace = realpathSync.native(workspace);
    retain(artifacts.length > 0 && artifacts.every(path =>
      isAbsolute(path) && existsSync(path) && lstatSync(path).isFile() &&
      inside(stateRoot, realpathSync.native(path)) &&
      !inside(physicalWorkspace, realpathSync.native(path))),
    'Validation evidence is missing or is not preserved outside the workspace');
    const rounds = remoteRounds(ledger, assignmentId);
    retain(rounds.length > 0, 'No completed Agency remote rounds were recorded');
    const refs = [];
    for (const round of rounds) {
      retain(Number.isInteger(round.round) &&
        /^[a-f0-9]{40,64}$/.test(round.baseRevision) &&
        /^[a-f0-9]{40,64}$/.test(round.resultRevision) &&
        exactTransportRef(round.inputRef, assignmentId, 'base', round.round) &&
        exactTransportRef(round.resultRef, assignmentId, 'result', round.round),
      'Agency transport receipt has invalid branch bindings');
      refs.push(
        { ref: round.inputRef, revision: round.baseRevision },
        { ref: round.resultRef, revision: round.resultRevision }
      );
    }
    retain(new Set(refs.map(item => item.ref)).size === refs.length,
      'Agency transport receipt contains duplicate refs');
    const inspect = dependencies.remoteHead ?? remoteHead;
    const observed = await Promise.all(refs.map(async item => ({
      ...item,
      observedRevision: await inspect(config, repo, item.ref, workspace,
        dependencies.getToken ?? adoAccessToken)
    })));
    const finalRef = `refs/heads/pilot/${assignmentId}`;
    const finalRevision = await inspect(config, repo, finalRef, workspace,
      dependencies.getToken ?? adoAccessToken);
    retain(finalRevision === result.sourceRevision,
      'Final delivered branch is missing or differs from the delivery receipt');
    if (['deleting', 'failed'].includes(existing?.state) &&
      observed.every(item => item.observedRevision === null)) {
      detail = {
        ...existing,
        state: 'removed',
        reason: 'Previously deleted Agency transport refs reconciled',
        checkedAt: now()
      };
      const prior = ledger.db.prepare(`SELECT id FROM operations
        WHERE job_id=? AND kind='agency-transport-cleanup'
        ORDER BY updated_at DESC LIMIT 1`).get(assignmentId);
      if (prior) ledger.finishOperation(prior.id, 'completed', detail);
      ledger.recordTransportCleanup(assignmentId, detail);
      return detail;
    }
    for (const item of observed)
      retain(item.observedRevision === item.revision,
        `Transport ref ${item.ref} is missing or differs from its retained receipt`);
    detail = {
      ...detail,
      state: 'eligible',
      reason: 'Final delivery is retained and exact Agency transport refs can be removed',
      repoId: repo.id,
      remote: repo.remote,
      sourceRef: finalRef,
      sourceRevision: result.sourceRevision,
      refs
    };
    if (!execute) return detail;
    operationId = `${assignmentId}:transport-cleanup:${uuid()}`;
    const deleting = {
      ...detail,
      state: 'deleting',
      operationId,
      checkedAt: now()
    };
    detail = deleting;
    ledger.operation(operationId, assignmentId, 'agency-transport-cleanup',
      deleting);
    ledger.recordTransportCleanup(assignmentId, deleting);
    const remove = dependencies.deleteRemoteRefs ?? deleteRemoteRefs;
    await remove(config, repo, refs.map(item => item.ref), workspace,
      dependencies.getToken ?? adoAccessToken);
    for (const item of refs)
      retain(await inspect(config, repo, item.ref, workspace,
        dependencies.getToken ?? adoAccessToken) === null,
      `Transport ref ${item.ref} still exists after deletion`);
    detail = {
      ...detail,
      state: 'removed',
      reason: 'Exact Agency input and result branches removed',
      checkedAt: now()
    };
    ledger.finishOperation(operationId, 'completed', detail);
  } catch (error) {
    const sideEffecting = Boolean(operationId) ||
      ['deleting', 'failed'].includes(existing?.state);
    detail = {
      ...detail,
      state: ['transport-retained', 'overlap'].includes(error.code) &&
        !sideEffecting ? 'skipped' : 'failed',
      reason: error.code === 'transport-retained'
        ? error.message : safeError(error).message,
      checkedAt: now(),
      ...error.code === 'transport-retained' ? {} : { error: safeError(error) }
    };
    if (operationId) ledger.finishOperation(operationId, 'failed', detail);
  } finally {
    try {
      if (execute && job && owner)
        ledger.recordTransportCleanup(assignmentId, detail);
    } finally {
      if (owner) ledger.release(`transport-cleanup:${assignmentId}`, owner);
    }
  }
  return detail;
}

export async function cleanupAgencyTransports(config, ledger,
  { execute = false } = {}, dependencies = {}) {
  const ids = ledger.db.prepare(`SELECT DISTINCT job_id FROM operations
    WHERE kind='agency-remote-result' ORDER BY job_id`).all()
    .map(row => row.job_id);
  const results = [];
  for (const id of ids)
    results.push(await cleanupAgencyTransport(
      config, ledger, id, { execute }, dependencies));
  return results;
}

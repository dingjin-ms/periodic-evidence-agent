import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { hash, json, PilotError, positive, requireThat, safeError } from './common.js';

const terminalStates = new Set(['Completed', 'Failed', 'Cancelled']);
const diagnosticLabels = new Set([
  'Created', 'Queued', 'Scheduled', 'Starting', 'Initializing', 'InProgress',
  'Running', 'Completed', 'Failed', 'Cancelled', 'Canceled', 'Succeeded',
  'Success', 'Failure', 'None'
]);
const diagnosticLabel = value => value === null ? null :
  diagnosticLabels.has(value) ? value : 'Unrecognized';
const remoteSucceeded = inspected => inspected.state === 'Completed' &&
  inspected.outcomeCode === 'Succeeded' &&
  inspected.jobOutcomeType === 'Succeeded' && inspected.result === 'Success';

function persistRemoteOperation(ledger, operationId, state, detail) {
  try {
    ledger.finishOperation(operationId, state, detail);
  } catch {
    throw new PilotError('blocked-reconciliation',
      `Agency remote submission may already exist; recovery/timing evidence could not be persisted for ${operationId}. ` +
      (detail.jobId ? `Preserve original job ID ${detail.jobId} and query only that job. ` :
        'Its job ID is unknown; the reserved operation is not proof of non-submission. ') +
      'Do not resubmit, delete the reservation or reset the assignment to prepared.');
  }
}

function valueAt(value, path) {
  let current = value;
  for (const part of path) current = current?.[part];
  return current;
}

function firstString(value, paths) {
  for (const path of paths) {
    const candidate = valueAt(value, path);
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return null;
}

export function parseAgencyJson(output) {
  requireThat(typeof output === 'string' && Buffer.byteLength(output) <= 4 * 1024 * 1024,
    'Agency remote output exceeded the protocol limit', 'blocked-protocol');
  const trimmed = output.trim();
  requireThat(trimmed.length > 0, 'Agency remote returned no JSON', 'blocked-protocol');
  try {
    return JSON.parse(trimmed);
  } catch {}
  const starts = [...trimmed.matchAll(/(?:^|\r?\n)(?=[{[])/g)].map(match =>
    match.index + match[0].length);
  for (const start of starts.reverse()) {
    try { return JSON.parse(trimmed.slice(start)); } catch {}
  }
  throw new PilotError('blocked-protocol', 'Agency remote returned malformed JSON');
}

export function remoteJobArguments(provider, repo, branch, prompt) {
  requireThat(repo.pr?.provider === 'ado' && repo.pr.organization &&
    repo.pr.project && repo.pr.repositoryId,
  'Agency remote currently requires an Azure DevOps repository mapping',
  'blocked-config');
  requireThat(typeof branch === 'string' && /^[a-zA-Z0-9._/-]+$/.test(branch) &&
    !branch.startsWith('/') && !branch.endsWith('/') && !branch.includes('..'),
  'Agency remote branch is invalid', 'blocked-scope');
  requireThat(typeof prompt === 'string' && prompt.length > 0 &&
    Buffer.byteLength(prompt) <= 24000,
  'Agency remote prompt exceeds the bounded Windows command-line payload',
  'blocked-budget');
  const args = [
    '--no-aec', 'remote', 'create', 'job',
    '--repo-type', 'ado',
    '--organization', repo.pr.organization,
    '--project', repo.pr.project,
    '--repository', repo.pr.repositoryId,
    '--branch', branch,
    '--prompt', prompt,
    '--output', 'json'
  ];
  if (provider.profile) args.push('--profile', provider.profile);
  if (provider.model) args.push('--model', provider.model);
  if (provider.modelReasoningEffort)
    args.push('--model-reasoning-effort', provider.modelReasoningEffort);
  if (provider.modelContext) args.push('--model-context', provider.modelContext);
  if (provider.plugin) args.push('--plugin', provider.plugin);
  if (provider.compute) args.push('--compute', provider.compute);
  if (provider.computeTag) args.push('--compute-tag', provider.computeTag);
  if (provider.pipelineProjectId)
    args.push('--pipeline-project-id', provider.pipelineProjectId);
  if (provider.pipelineId) args.push('--pipeline-id', String(provider.pipelineId));
  if (provider.pipelineRef) args.push('--pipeline-ref', provider.pipelineRef);
  return args;
}

export function launchAgencyRemote(executable, args, { cwd, timeoutMs }) {
  return new Promise((resolveLaunch, rejectLaunch) => {
    const child = spawn(executable, args, {
      cwd, windowsHide: true, timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '', settled = false;
    const collect = (current, chunk) => {
      const next = current + chunk;
      if (Buffer.byteLength(next) > 4 * 1024 * 1024)
        throw new PilotError('blocked-runtime',
          'Agency remote output exceeded the protocol limit');
      return next;
    };
    const reject = error => {
      if (!settled) {
        settled = true;
        rejectLaunch(error);
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      try { stdout = collect(stdout, chunk); } catch (error) {
        child.kill();
        reject(error);
      }
    });
    child.stderr.on('data', chunk => {
      try { stderr = collect(stderr, chunk); } catch (error) {
        child.kill();
        reject(error);
      }
    });
    child.once('error', () => reject(new PilotError('blocked-runtime',
      'Agency remote process could not be started')));
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolveLaunch({ stdout, stderr });
      else rejectLaunch(new PilotError('blocked-runtime',
        `Agency remote command did not complete successfully (code=${code ?? 'none'}, signal=${signal ?? 'none'}); inspect Agency diagnostics.`));
    });
  });
}

export function remoteJobIdentity(value) {
  const jobId = firstString(value, [
    ['jobId'], ['id'], ['job', 'jobId'], ['job', 'id']
  ]);
  requireThat(jobId && /^[a-zA-Z0-9._:-]{8,200}$/.test(jobId),
    'Agency remote create response omitted a valid job ID', 'blocked-protocol');
  return jobId;
}

export function inspectRemoteJob(value) {
  const state = firstString(value, [['state'], ['job', 'state']]);
  requireThat(state, 'Agency remote job state is missing', 'blocked-protocol');
  const sourceBranch = firstString(value, [
    ['sourceBranch'], ['sourceRefName'],
    ['azDoContext', 'sourceBranchName'],
    ['pullRequest', 'sourceBranch'], ['pullRequest', 'sourceRefName'],
    ['repository', 'sourceBranch'], ['repositoryContext', 'sourceBranch'],
    ['job', 'sourceBranch'], ['job', 'sourceRefName'],
    ['job', 'pullRequest', 'sourceBranch'], ['job', 'pullRequest', 'sourceRefName']
  ]);
  const result = firstString(value, [['result'], ['job', 'result']]);
  const outcomeCode = firstString(value, [
    ['outcome', 'code'], ['job', 'outcome', 'code']
  ]);
  const jobOutcomeType = firstString(value, [
    ['jobOutcomeType'], ['job', 'jobOutcomeType']
  ]);
  return {
    state, terminal: terminalStates.has(state), sourceBranch,
    result, outcomeCode, jobOutcomeType, raw: value
  };
}

export async function executeAgencyRemoteJob(config, ledger, current, repo, provider,
  input, dependencies = {}) {
  const operationId = `${current.id}:agency-remote:${input.round}`;
  requireThat(typeof input.resultBranch === 'string' &&
    /^[a-zA-Z0-9._/-]+$/.test(input.resultBranch) &&
    !input.resultBranch.startsWith('/') &&
    !input.resultBranch.endsWith('/') &&
    !input.resultBranch.includes('..'),
  'Agency remote result branch is invalid', 'blocked-scope');
  const createArguments = remoteJobArguments(
    provider, repo, input.branch, input.prompt);
  const request = {
    assignmentId: current.id,
    round: input.round,
    baseRevision: input.baseRevision,
    branch: input.branch,
    resultBranch: input.resultBranch,
    providerSha256: hash(json(provider)),
    promptSha256: hash(input.prompt)
  };
  const clock = dependencies.monotonicNow ?? (() => performance.now());
  const started = clock();
  const timing = {
    measurement: 'controller-observed',
    startedAt: new Date().toISOString(),
    submissionMs: null,
    pollWaitMs: 0,
    inspectionMs: 0,
    pollCount: 0,
    stateTransitions: [],
    stateTransitionsTruncated: false,
    lastObservedAfterMs: null
  };
  const snapshot = () => ({
    ...timing, totalMs: clock() - started,
    stateTransitions: [...timing.stateTransitions]
  });
  const record = (state, detail) => {
    const measured = snapshot();
    persistRemoteOperation(ledger, operationId, state,
      { ...request, ...detail, timing: measured });
    return measured;
  };
  let lastObservedState = null;
  const observe = inspected => {
    const observedAfterMs = clock() - started;
    timing.lastObservedAfterMs = observedAfterMs;
    const state = diagnosticLabel(inspected.state);
    if (state === lastObservedState) return;
    lastObservedState = state;
    if (timing.stateTransitions.length < 32)
      timing.stateTransitions.push({ state, observedAfterMs });
    else timing.stateTransitionsTruncated = true;
  };
  ledger.operation(operationId, current.id, 'agency-remote-authoring', {
    ...request, submissionState: 'reserved', timing: snapshot()
  });
  const launch = dependencies.launch ?? launchAgencyRemote;
  const createTimeoutMs = Math.min(
    positive(config.limits.workerMinutes, 'workerMinutes') * 60000,
    120000);
  let created, jobId;
  const submissionStarted = clock();
  try {
    created = parseAgencyJson((await launch(
      provider.executable,
      createArguments,
      { cwd: current.workspace, timeoutMs: createTimeoutMs })).stdout);
    jobId = remoteJobIdentity(created);
  } catch (error) {
    timing.submissionMs = clock() - submissionStarted;
    record('started', { submissionState: 'uncertain' });
    throw new PilotError('blocked-reconciliation',
      `Agency remote submission is uncertain; do not submit a replacement job. ${safeError(error).message}`);
  }
  timing.submissionMs = clock() - submissionStarted;
  record('accepted', { submissionState: 'accepted', jobId });
  const uncertainInspection = error => {
    record('uncertain', {
      submissionState: 'accepted', jobId,
      lastState: lastObservedState, inspectionError: safeError(error)
    });
    return new PilotError('blocked-reconciliation',
      'Agency remote job was accepted but its state is uncertain; reconcile the recorded job ID without resubmitting.');
  };
  const intervalMs = (provider.pollSeconds ?? 30) * 1000;
  const deadline = clock() +
    positive(config.limits.workerMinutes, 'workerMinutes') * 60000;
  const sleep = dependencies.sleep ?? (milliseconds =>
    new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds)));
  let inspected;
  try {
    inspected = inspectRemoteJob(created);
  } catch (error) {
    throw uncertainInspection(error);
  }
  observe(inspected);
  record('accepted', { submissionState: 'accepted', jobId, lastState: lastObservedState });
  while (!inspected.terminal && clock() < deadline) {
    const waitStarted = clock();
    await sleep(intervalMs);
    timing.pollWaitMs += clock() - waitStarted;
    const inspectionStarted = clock();
    timing.pollCount++;
    try {
      const response = await launch(provider.executable,
        ['--no-aec', 'remote', 'get', jobId],
        { cwd: current.workspace, timeoutMs: Math.min(intervalMs, 120000) });
      inspected = inspectRemoteJob(parseAgencyJson(response.stdout));
    } catch (error) {
      timing.inspectionMs += clock() - inspectionStarted;
      throw uncertainInspection(error);
    }
    timing.inspectionMs += clock() - inspectionStarted;
    observe(inspected);
    record('accepted', { submissionState: 'accepted', jobId, lastState: lastObservedState });
  }
  if (!inspected.terminal) {
    record('uncertain', {
      submissionState: 'accepted', jobId,
      lastState: lastObservedState
    });
    throw new PilotError('blocked-reconciliation',
      'Agency remote job exceeded the controller deadline; reconcile the recorded job ID without resubmitting.');
  }
  const succeeded = remoteSucceeded(inspected);
  const completedTiming = record(succeeded ? 'completed' : 'failed', {
    submissionState: 'accepted', jobId,
    state: diagnosticLabel(inspected.state), result: diagnosticLabel(inspected.result),
    outcomeCode: diagnosticLabel(inspected.outcomeCode),
    jobOutcomeType: diagnosticLabel(inspected.jobOutcomeType),
    sourceBranch: input.resultBranch,
    contextSourceBranch: inspected.sourceBranch
  });
  requireThat(succeeded,
    `Agency remote job ${jobId} did not complete successfully`,
    'blocked-result');
  return {
    jobId, ...inspected, timing: completedTiming,
    contextSourceBranch: inspected.sourceBranch,
    sourceBranch: input.resultBranch
  };
}

export async function reconcileAgencyRemoteJob(config, ledger, assignmentId, round,
  dependencies = {}) {
  requireThat(typeof assignmentId === 'string' && assignmentId &&
    Number.isSafeInteger(round) && round >= 0,
  'Remote reconciliation requires an exact assignment ID and nonnegative round');
  const lockName = `dispatch:${assignmentId}`;
  const owner = ledger.acquire(lockName);
  try {
    const operationId = `${assignmentId}:agency-remote:${round}`;
    const operation = ledger.db.prepare(
      'SELECT * FROM operations WHERE id=? AND job_id=? AND kind=?')
      .get(operationId, assignmentId, 'agency-remote-authoring');
    requireThat(operation, 'No recorded Remote authoring operation; no submission authorized',
      'blocked-reconciliation');
    const detail = JSON.parse(operation.detail);
    requireThat(detail.submissionState === 'accepted' && detail.jobId,
      'Remote submission identity is unknown. A reserved/uncertain operation is not proof of non-submission; reconcile externally without resubmitting.',
      'blocked-reconciliation');
    requireThat(['accepted', 'uncertain'].includes(operation.state),
      'Remote authoring operation is already terminal; observation recovery cannot reopen it',
      'blocked-reconciliation');
    const jobId = remoteJobIdentity({ jobId: detail.jobId });
    const assignment = ledger.get('assignment', assignmentId);
    const provider = config.authoringProviders?.[assignment?.authoringProvider];
    requireThat(provider?.type === 'agency-remote' &&
      hash(json(provider)) === detail.providerSha256,
    'Remote reconciliation requires the original pinned provider configuration',
    'blocked-reconciliation');
    const job = ledger.job(assignmentId);
    requireThat(job?.workspace, 'Original Remote workspace receipt is missing; reconcile externally',
      'blocked-reconciliation');
    const clock = dependencies.monotonicNow ?? (() => performance.now());
    const started = clock();
    const recovery = {
      measurement: 'controller-observed',
      startedAt: new Date().toISOString(),
      attemptCount: (detail.reconciliationTiming?.attemptCount ?? 0) + 1,
      totalInspectionMs: detail.reconciliationTiming?.totalInspectionMs ?? 0
    };
    const save = (state, observed) => {
      const inspectionMs = clock() - started;
      persistRemoteOperation(ledger, operationId, state, {
        ...detail, ...observed,
        reconciliationTiming: {
          ...recovery, inspectionMs,
          totalInspectionMs: recovery.totalInspectionMs + inspectionMs
        }
      });
    };
    let inspected;
    try {
      const response = await (dependencies.launch ?? launchAgencyRemote)(
        provider.executable, ['--no-aec', 'remote', 'get', jobId], {
          cwd: job.workspace,
          timeoutMs: Math.min(positive(config.limits.workerMinutes, 'workerMinutes') * 60000, 120000)
        });
      const value = parseAgencyJson(response.stdout);
      if (value.jobId || value.id || value.job?.jobId || value.job?.id)
        requireThat(remoteJobIdentity(value) === jobId,
          'Remote inspection returned a different job identity', 'blocked-protocol');
      inspected = inspectRemoteJob(value);
    } catch (error) {
      save('uncertain', { inspectionError: safeError(error) });
      throw new PilotError('blocked-reconciliation',
        `Remote job ${jobId} remains uncertain; inspect the same job without resubmitting.`);
    }
    const succeeded = remoteSucceeded(inspected);
    const state = inspected.terminal ? succeeded ? 'completed' : 'failed' : 'accepted';
    save(state, {
      lastState: diagnosticLabel(inspected.state), state: diagnosticLabel(inspected.state),
      result: diagnosticLabel(inspected.result),
      outcomeCode: diagnosticLabel(inspected.outcomeCode),
      jobOutcomeType: diagnosticLabel(inspected.jobOutcomeType),
      inspectionError: null
    });
    return {
      operationId, jobId, state, remoteState: diagnosticLabel(inspected.state),
      terminal: inspected.terminal, succeeded, recoveryOnly: true,
      nextAction: 'Observation only: assignment, source import, native validation and publication are not resumed or authorized. Never reset or redispatch this assignment.'
    };
  } finally { ledger.release(lockName, owner); }
}

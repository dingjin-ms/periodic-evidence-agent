import { spawn } from 'node:child_process';
import { hash, json, PilotError, positive, requireThat, safeError } from './common.js';

const terminalStates = new Set(['Completed', 'Failed', 'Cancelled']);

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
  ledger.operation(operationId, current.id, 'agency-remote-authoring', {
    ...request, submissionState: 'reserved'
  });
  const launch = dependencies.launch ?? launchAgencyRemote;
  const createTimeoutMs = Math.min(
    positive(config.limits.workerMinutes, 'workerMinutes') * 60000,
    120000);
  let created;
  try {
    created = parseAgencyJson((await launch(
      provider.executable,
      createArguments,
      { cwd: current.workspace, timeoutMs: createTimeoutMs })).stdout);
  } catch (error) {
    throw new PilotError('blocked-reconciliation',
      `Agency remote submission is uncertain; do not submit a replacement job. ${safeError(error).message}`);
  }
  const jobId = remoteJobIdentity(created);
  ledger.finishOperation(operationId, 'accepted', {
    ...request, submissionState: 'accepted', jobId
  });
  const intervalMs = (provider.pollSeconds ?? 30) * 1000;
  const deadline = Date.now() +
    positive(config.limits.workerMinutes, 'workerMinutes') * 60000;
  const sleep = dependencies.sleep ?? (milliseconds =>
    new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds)));
  let inspected = inspectRemoteJob(created);
  while (!inspected.terminal && Date.now() < deadline) {
    await sleep(intervalMs);
    let response;
    try {
      response = await launch(provider.executable,
        ['--no-aec', 'remote', 'get', jobId],
        { cwd: current.workspace, timeoutMs: Math.min(intervalMs, 120000) });
    } catch (error) {
      ledger.finishOperation(operationId, 'uncertain', {
        ...request, submissionState: 'accepted', jobId,
        inspectionError: safeError(error)
      });
      throw new PilotError('blocked-reconciliation',
        'Agency remote job was accepted but its state is uncertain; reconcile the recorded job ID without resubmitting.');
    }
    inspected = inspectRemoteJob(parseAgencyJson(response.stdout));
  }
  if (!inspected.terminal) {
    ledger.finishOperation(operationId, 'uncertain', {
      ...request, submissionState: 'accepted', jobId,
      lastState: inspected.state
    });
    throw new PilotError('blocked-reconciliation',
      'Agency remote job exceeded the controller deadline; reconcile the recorded job ID without resubmitting.');
  }
  const succeeded = inspected.state === 'Completed' &&
    inspected.outcomeCode === 'Succeeded' &&
    inspected.jobOutcomeType === 'Succeeded' &&
    inspected.result === 'Success';
  ledger.finishOperation(operationId, succeeded ? 'completed' : 'failed', {
    ...request, submissionState: 'accepted', jobId,
    state: inspected.state, result: inspected.result,
    outcomeCode: inspected.outcomeCode,
    jobOutcomeType: inspected.jobOutcomeType,
    sourceBranch: input.resultBranch,
    contextSourceBranch: inspected.sourceBranch
  });
  requireThat(succeeded,
    `Agency remote job ${jobId} did not complete successfully`,
    'blocked-result');
  return {
    jobId, ...inspected,
    contextSourceBranch: inspected.sourceBranch,
    sourceBranch: input.resultBranch
  };
}

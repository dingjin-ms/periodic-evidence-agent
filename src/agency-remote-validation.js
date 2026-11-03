import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync,
  createReadStream
} from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { hash, json, now, requireThat, PilotError, safeError } from './common.js';
import { createAgencyValidationTransport, agencyArtifactTransportPath } from './agency-validation-transport.js';

const stages = ['fingerprint', 'authentication-check', 'authentication', 'dependencies', 'compile', 'policy', 'test'];
const digest = /^[a-f0-9]{64}$/;
const revisionPattern = /^[a-f0-9]{40}$/;
const read = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const save = (path, value) => {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  if (existsSync(path)) {
    requireThat(hash(readFileSync(path)) === hash(bytes), 'Existing remote evidence changed; do not overwrite', 'blocked-reconciliation');
  } else writeFileSync(path, bytes, { flag: 'wx' });
};

export function remoteValidationContract(repo, revision) {
  const selection = repo.remoteValidation;
  requireThat(selection?.type === 'agency-remote' && isAbsolute(selection.contractPath) &&
    digest.test(selection.contractSha256 ?? '') &&
    hash(readFileSync(selection.contractPath)) === selection.contractSha256,
  'Remote validation requires an unchanged, explicitly pinned private contract', 'blocked-validation');
  const contract = read(selection.contractPath);
  requireThat(contract.schema === 'agency-oa-validation-contract-v1' &&
    contract.repoId === repo.id && contract.candidate === revision && revisionPattern.test(revision) &&
    repo.validationGates.length === 1 && contract.gateId === repo.validationGates[0].id &&
    contract.profileSha256 === repo.validationGates[0].profileSha256 &&
    digest.test(contract.profileSha256) &&
    hash(readFileSync(repo.validationGates[0].profilePath)) === contract.profileSha256 &&
    repo.validationGates[0].approved === true,
  'Remote candidate/profile/gate binding differs from the qualified pipeline; do not submit', 'blocked-validation');
  validateRemotePipelineContract(contract, revision);
  return contract;
}

export function validateRemotePipelineContract(contract, revision, { dynamicProfile = false } = {}) {
  const p = contract.pipeline;
  requireThat(p && revisionPattern.test(p.revision) && digest.test(p.yamlSha256) &&
    Number.isSafeInteger(p.definitionId) && p.definitionId > 0 &&
    Number.isSafeInteger(p.definitionRevision) && p.definitionRevision > 0 &&
    /^refs\/heads\/[^\s]+$/.test(p.ref) && typeof p.yamlPath === 'string' &&
    !p.yamlPath.split(/[\\/]/).includes('..') &&
    /^https:\/\/dev\.azure\.com\/[a-zA-Z0-9-]+$/.test(p.organization) &&
    /^[a-zA-Z0-9_.-]+$/.test(p.project) && /^[a-zA-Z0-9_.-]+$/.test(p.repositoryId) &&
    typeof p.artifactPrefix === 'string' && /^[a-zA-Z0-9_.-]+$/.test(p.artifactPrefix),
  'Remote validation needs exact approved ADO pipeline/source/artifact pins', 'blocked-config');
  requireThat(Array.isArray(contract.requiredTasks) && contract.requiredTasks.length > 0 &&
    new Set(contract.requiredTasks).size === contract.requiredTasks.length &&
    contract.requiredTasks.every(name => typeof name === 'string' && name) &&
    contract.requiredTasks.includes(contract.prepareTask) && contract.requiredTasks.includes(contract.validationTask) &&
    contract.testPopulation?.suites > 0 && Number.isSafeInteger(contract.testPopulation.suites) &&
    contract.testPopulation?.tests > 0 && Number.isSafeInteger(contract.testPopulation.tests) &&
    typeof contract.testPopulation.path === 'string' && contract.testPopulation.path.length > 0 &&
    Array.isArray(contract.sourceInputs) && contract.sourceInputs.length > 0 &&
    new Set(contract.sourceInputs).size === contract.sourceInputs.length &&
    contract.sourceInputs.every(path => typeof path === 'string' && path &&
      !win32.isAbsolute(path) && !path.split(/[\\/]/).some(part => part === '..' || part === '.')) &&
    win32.isAbsolute(contract.executable ?? '') &&
    (dynamicProfile ? contract.profilePath === undefined : win32.isAbsolute(contract.profilePath ?? '')),
  'Remote validation requires trusted producer tasks, source inputs, commands and exact case population', 'blocked-config');
  requireThat(['maximumRunnerMinutes', 'queueMinutes', 'cancellationMinutes', 'pollSeconds']
    .every(key => Number.isInteger(contract[key])) &&
    Number.isSafeInteger(contract.maximumArtifactBytes) && contract.maximumArtifactBytes > 0 &&
    contract.maximumArtifactBytes <= 16 * 1024 ** 3 &&
    contract.maximumRunnerMinutes > 0 && contract.maximumRunnerMinutes <= 60 &&
    contract.queueMinutes > 0 && contract.queueMinutes <= 15 &&
    contract.cancellationMinutes > 0 && contract.cancellationMinutes <= 5 &&
    contract.pollSeconds >= 1 && contract.pollSeconds <= 60,
  'Remote validation exceeds bounded runner/queue/cancellation policy', 'blocked-config');
  const request = contract.request;
  requireThat(request?.compute?.$type === 'pipeline' && request.compute.pipelineId === p.definitionId &&
    request.compute.pipelineRefOverride === p.ref && request.context?.repository?.$type === 'ado' &&
    request.context.repository.organization === new URL(p.organization).pathname.slice(1) &&
    request.context.repository.project === p.project &&
    request.metadata?.candidate === revision && request.metadata?.pipelineCommit === p.revision &&
    request.metadata?.profileSha256 === contract.profileSha256 &&
    request.metadata?.pipelineYamlSha256 === p.yamlSha256 &&
    request.metadata?.productPullRequests === 'forbidden' &&
    request.additionalOptions?.pluginOptions?.includeDefaults === false &&
    typeof request.prompt === 'string' && request.prompt.length > 0,
  'Remote request differs from approved read-only, candidate-bound pipeline', 'blocked-config');
  return contract;
}

export async function artifactInventory(root, maximumBytes) {
  const inventory = [];
  let bytes = 0;
  async function walk(directory, prefix = '') {
    requireThat(!lstatSync(directory).isSymbolicLink(), 'Artifact directory is a link', 'blocked-result');
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), relative = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(path);
      requireThat(!stat.isSymbolicLink() && (!stat.isFile() || stat.nlink <= 1),
        'Artifact links are not acceptable execution evidence', 'blocked-result');
      if (stat.isDirectory()) await walk(path, relative);
      else {
        requireThat(stat.isFile() && inventory.length < 100000 &&
          (bytes += stat.size) <= maximumBytes, 'Artifact inventory exceeds policy', 'blocked-result');
        const hasher = createHash('sha256');
        for await (const chunk of createReadStream(path)) hasher.update(chunk);
        inventory.push({ path: relative, bytes: stat.size, sha256: hasher.digest('hex') });
      }
    }
  }
  await walk(root);
  requireThat(inventory.length > 0, 'Successful download returned no artifacts', 'blocked-result');
  return inventory;
}

export async function verifyRemoteValidation(contract, directory, observation, expectedJobId, workspace, reservedAt = null) {
  const { job, build, timeline, logs, artifacts } = observation;
  const p = contract.pipeline;
  requireThat(job?.jobId === expectedJobId && job.pipelineRun?.runId === build?.id &&
    job.pipelineRun?.definitionId === p.definitionId &&
    build.status === 'completed' && build.definitionId === p.definitionId &&
    build.definitionRevision === p.definitionRevision &&
    build.sourceVersion === p.revision && build.sourceBranch === p.ref &&
    hash(observation.pipelineYaml ?? '') === p.yamlSha256,
  'Actual build/source/definition does not match the recorded Agency request', 'blocked-result');
  const elapsed = Date.parse(build.finishTime) - Date.parse(build.startTime);
  requireThat(Number.isFinite(elapsed) && elapsed > 0 &&
    elapsed <= contract.maximumRunnerMinutes * 60000 &&
    (!reservedAt || Date.parse(build.queueTime ?? build.startTime) >= Date.parse(reservedAt) - 120000),
  'Actual runner duration is missing or exceeds the authorized budget', 'blocked-result');
  const task = name => {
    const matches = timeline.filter(t => t.type === 'Task' && t.name === name);
    requireThat(matches.length === 1 && matches[0].state === 'completed',
      `Trusted producer task is missing or ambiguous: ${name}`, 'blocked-result');
    return matches[0];
  };
  const taskLog = name => {
    const producer = task(name);
    const matches = logs.filter(log => log.taskId === producer.id && log.logId === producer.logId);
    requireThat(matches.length === 1 && Array.isArray(matches[0].lines),
      `Missing independently fetched producer log: ${name}`, 'blocked-result');
    return matches[0].lines.join('\n');
  };
  const expectedArtifact = `${p.artifactPrefix}${build.id}`;
  requireThat(artifacts.filter(a => a.name === expectedArtifact).length === 1,
    'Missing or ambiguous build-owned artifact', 'blocked-result');
  const inventory = await artifactInventory(join(directory, 'job-artifact'), contract.maximumArtifactBytes);
  const root = join(directory, 'job-artifact', 'validation-probe');
  const prepared = read(join(root, 'prepared.json')), result = read(join(root, 'result.json'));
  const fileHash = name => hash(readFileSync(join(root, name)));
  const prepareLog = taskLog(contract.prepareTask), gateLog = taskLog(contract.validationTask);
  requireThat(prepared.candidate === contract.candidate && result.candidate === contract.candidate &&
    Number(prepared.buildId) === build.id && Number(result.buildId) === build.id &&
    Number(prepared.definitionId) === p.definitionId &&
    prepared.profileSha256 === contract.profileSha256 && result.profileSha256 === contract.profileSha256 &&
    fileHash('validation-profile.ps1') === contract.profileSha256 &&
    prepared.localReceiptsImported === false && prepared.initialNodeModulesPresent === false &&
    prepared.productWritesAuthorized === false && result.cwd === prepared.cwd &&
    prepared.schema === 'agency-real-validation-probe-v1' &&
    result.schema === 'agency-real-validation-probe-v1' && result.controllerAcceptance === false &&
    win32.isAbsolute(prepared.cwd) && prepared.agentOs === 'Windows_NT' &&
    prepareLog.includes(`PROBE_PREPARED candidate=${contract.candidate} build=${build.id} cwd=${prepared.cwd} profile=${contract.profileSha256} preparedSha256=${fileHash('prepared.json')}`),
  'Remote source/profile/preparation evidence is not bound to its trusted producer', 'blocked-result');
  requireThat(json(Object.keys(prepared.inputs).sort()) === json([...contract.sourceInputs].sort()),
    'Prepared source input population differs from qualification', 'blocked-result');
  for (const path of contract.sourceInputs) {
    const bytes = readFileSync(join(workspace, ...path.split(/[\\/]/)));
    const lf = bytes.toString('utf8').replace(/\r\n/g, '\n');
    requireThat([hash(bytes), hash(lf), hash(lf.replace(/\n/g, '\r\n'))].includes(prepared.inputs[path]),
      `Remote source bytes differ from the actual candidate: ${path}`, 'blocked-result');
  }
  requireThat(Array.isArray(result.stages) && result.stages.length > 0 &&
    result.stages.length <= stages.length &&
    json(result.stages.map(s => s.stage)) === json(stages.slice(0, result.stages.length)),
  'Remote stages are missing, duplicated or out of order', 'blocked-result');
  let previous = Date.parse(result.startedAt);
  for (const stage of result.stages) {
    requireThat(stage.candidate === contract.candidate && stage.cwd === prepared.cwd &&
      stage.executable === contract.executable &&
      json(stage.arguments) === json(['-NoLogo', '-NoProfile', '-NonInteractive', '-File', contract.profilePath]) &&
      Number.isInteger(stage.exitCode) && stage.log === `${stage.stage}.log` &&
      digest.test(stage.logSha256) && fileHash(stage.log) === stage.logSha256 &&
      Date.parse(stage.startedAt) >= previous && Date.parse(stage.finishedAt) >= Date.parse(stage.startedAt) &&
      gateLog.includes(`PROBE_STAGE_END stage=${stage.stage} exit=${stage.exitCode} logSha256=${stage.logSha256}`),
    `Remote command/exit/log evidence differs from trusted execution: ${stage.stage}`, 'blocked-result');
    requireThat(Date.parse(stage.startedAt) >= Date.parse(build.startTime) &&
      Date.parse(stage.finishedAt) <= Date.parse(build.finishTime),
    'Stage timing is outside the actual build', 'blocked-result');
    previous = Date.parse(stage.finishedAt);
  }
  const files = read(join(root, 'artifacts.json')), names = new Set();
  for (const file of files) {
    requireThat(typeof file.name === 'string' && file.name && !/[\\/]/.test(file.name) &&
      !['.', '..'].includes(file.name) && !names.has(file.name),
    'Unsafe or duplicate validation artifact entry', 'blocked-result');
    names.add(file.name);
    requireThat(lstatSync(join(root, file.name)).size === file.bytes && fileHash(file.name) === file.sha256,
      'Validation artifact hash/size differs from trusted output', 'blocked-result');
  }
  requireThat(['prepared.json', 'result.json', 'validation-profile.ps1'].every(name => names.has(name)) &&
    result.stages.every(stage => names.has(stage.log)) &&
    gateLog.includes(`PROBE_RESULT state=${result.state} gatesPassed=${result.gatesPassed ? 'True' : 'False'} candidate=${contract.candidate}`),
  'Missing final trusted validation output', 'blocked-result');
  const passed = result.gatesPassed === true;
  if (passed) {
    requireThat(job.state === 'Completed' && job.result === 'Success' && build.result === 'succeeded' &&
      contract.requiredTasks.every(name => task(name).result === 'succeeded') &&
      result.stages.length === stages.length && result.stages.every(stage => stage.exitCode === 0) &&
      result.sourceCleanAfter === true && result.authentication?.state === 'ready' &&
      result.authentication?.tokenRecorded === false &&
      result.authentication?.provider === 'artifacts-npm-credprovider' &&
      result.authentication?.providerVersion === '1.2.1',
    'A green Agency job cannot substitute for all actual gates/source seals', 'blocked-result');
    const output = readFileSync(join(root, 'test.log'), 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
    const population = contract.testPopulation;
    requireThat(output.includes(`PASS ${population.path}`) &&
      new RegExp(`^Test Suites:[ \\t]+${population.suites} passed, ${population.suites} total[ \\t]*\\r?$`, 'm').test(output) &&
      new RegExp(`^Tests:[ \\t]+${population.tests} passed, ${population.tests} total[ \\t]*\\r?$`, 'm').test(output) &&
      [...output.matchAll(/^Test Suites:/gm)].length === 1 && [...output.matchAll(/^Tests:/gm)].length === 1,
    'Expected real test population did not execute', 'blocked-result');
  } else {
    requireThat(build.result !== 'succeeded' && result.stages.some(stage => stage.exitCode !== 0),
      'Remote failure lacks an independently observed failed command', 'blocked-result');
  }
  return {
    status: passed ? 'passed' : ['compile', 'policy', 'test'].includes(result.failedStage) ? 'failed' : 'blocked',
    blockedReason: passed || ['compile', 'policy', 'test'].includes(result.failedStage) ? null : 'runner-unavailable',
    jobId: expectedJobId, buildId: build.id, pipelineRevision: p.revision,
    sourceRevision: contract.candidate, profileSha256: contract.profileSha256,
    executionLocation: 'agency-remote', controllerAcceptance: passed,
    stages: result.stages, environment: prepared, inventory,
    caseCounts: passed ? contract.testPopulation : null
  };
}

export async function runAgencyRemoteValidation(config, ledger, job, repo, revision, options = {}, dependencies = {}) {
  const contract = remoteValidationContract(repo, revision);
  return runRemoteValidationOperation(config, ledger, job, repo, revision, contract,
    verifyRemoteValidation, options, dependencies);
}

export async function reconcileAgencyRemoteValidation(config, ledger, request, dependencies = {}) {
  requireThat(config.statePolicy?.accessApproved === true &&
    request?.schema === 'controller-remote-validation-reconciliation-v1' &&
    typeof request.operationId === 'string' && request.operationId &&
    /^[a-zA-Z0-9_.-]+$/.test(request.jobId ?? '') &&
    digest.test(request.requestSha256 ?? ''),
  'Remote identity recovery needs approved state storage, the original operation/request hash and a job ID',
  'blocked-reconciliation');
  const repo = config.repositories.find(repository => repository.id === request.repoId);
  requireThat(repo?.remoteValidation?.type === 'agency-remote',
    'Remote identity recovery requires the original configured repository', 'blocked-reconciliation');
  const contract = remoteValidationContract(repo, request.revision);
  const lock = `remote-validation:${request.operationId}`, owner = ledger.acquire(lock);
  try {
    const operation = ledger.db.prepare('SELECT * FROM operations WHERE id=?').get(request.operationId);
    requireThat(operation?.kind === 'agency-remote-validation' &&
      ['started', 'uncertain'].includes(operation.state),
    'Only an existing unresolved validation reservation can be reconciled', 'blocked-reconciliation');
    const detail = JSON.parse(operation.detail);
    const directory = join(config.stateDirectory, 'remote-validation', hash(request.operationId));
    requireThat(!detail.jobId && detail.directory === directory &&
      detail.sourceRevision === request.revision &&
      detail.contractSha256 === repo.remoteValidation.contractSha256 &&
      detail.requestSha256 === request.requestSha256 &&
      !existsSync(join(directory, 'created.json')),
    'Recovery differs from the original reservation or already has a creation identity; use normal resume',
    'blocked-reconciliation');
    const wire = readFileSync(join(directory, 'request.json'));
    const expected = structuredClone(contract.request);
    expected.metadata.controllerValidationId = request.operationId;
    expected.metadata.controllerContractSha256 = detail.contractSha256;
    requireThat(hash(wire) === detail.requestSha256 && json(JSON.parse(wire)) === json(expected) &&
      json(read(join(directory, 'contract.json'))) === json(contract),
    'Reserved request or contract changed; identity recovery refused', 'blocked-reconciliation');
    const call = dependencies.transport ?? createAgencyValidationTransport(config, { save });
    let observation;
    try { observation = await call('reconcile', { contract, jobId: request.jobId }, directory); }
    catch {
      throw new PilotError('blocked-reconciliation',
        'Read-only job lookup failed; the original reservation remains unresolved and must not be resubmitted');
    }
    const job = observation?.job;
    const reservedAt = Date.parse(detail.reservedAt), createdAt = Date.parse(job?.createdAt);
    requireThat(job?.jobId === request.jobId &&
      job.metadata && !Array.isArray(job.metadata) &&
      Object.entries(expected.metadata).every(([key, value]) => job.metadata[key] === value) &&
      Number.isFinite(reservedAt) && Number.isFinite(createdAt) &&
      createdAt >= reservedAt - 120000 && createdAt <= Date.now() + 120000 &&
      (!job.pipelineRun || job.pipelineRun.definitionId === contract.pipeline.definitionId),
    'Service job identity, metadata, creation time or pipeline differs from the reserved request',
    'blocked-reconciliation');
    const artifact = join(directory, 'reconciled.json');
    const previous = existsSync(artifact) ? read(artifact) : null;
    const record = {
      schema: 'agency-validation-identity-reconciliation-v1',
      operationId: request.operationId, jobId: request.jobId,
      requestSha256: detail.requestSha256, contractSha256: detail.contractSha256,
      sourceRevision: detail.sourceRevision, jobCreatedAt: job.createdAt,
      metadataSha256: hash(json(expected.metadata)),
      observedAt: previous?.observedAt ?? now(),
      validationPerformed: false, newJobSubmitted: false
    };
    requireThat(Number.isFinite(Date.parse(record.observedAt)),
      'Saved reconciliation observation time is invalid', 'blocked-reconciliation');
    try {
      save(artifact, record);
      ledger.finishOperation(request.operationId, 'accepted', {
        ...detail, jobId: request.jobId, reconciliationArtifact: artifact,
        reconciliationArtifactSha256: hash(readFileSync(artifact))
      });
    } catch {
      throw new PilotError('blocked-reconciliation',
        'Verified job identity could not be durably reconciled; retry only this read-only recovery, never submission');
    }
    return {
      schema: 'controller-remote-validation-reconciliation-result-v1',
      operationId: request.operationId, jobId: request.jobId, state: 'identity-verified',
      recoveryOnly: true, validationPerformed: false, newJobSubmitted: false,
      artifactRefs: [artifact], nextAction: 'resume-original-validation'
    };
  } finally { ledger.release(lock, owner); }
}

export async function runRemoteValidationOperation(config, ledger, job, repo, revision,
  contract, verify, options = {}, dependencies = {}, kind = 'agency-remote-validation') {
  requireThat(config.activation.dispatch === true && config.statePolicy?.accessApproved === true,
    'Remote validation needs explicit dispatch activation and approved state storage', 'blocked-authorization');
  const maximumJobs = config.limits.maxRemoteValidationJobs;
  requireThat(maximumJobs == null || (Number.isSafeInteger(maximumJobs) && maximumJobs > 0),
    'maxRemoteValidationJobs must be a positive safe integer, null or omitted', 'blocked-config');
  const tag = kind === 'agency-remote-validation' ? 'agency-validation' : kind;
  const id = `${job.id}:${tag}:${revision}:${repo.remoteValidation.contractSha256}`;
  const directory = join(config.stateDirectory, 'remote-validation', hash(id));
  const lock = `remote-validation:${id}`, owner = ledger.acquire(lock);
  const clock = dependencies.clock ?? Date.now;
  const wait = dependencies.sleep ?? sleep;
  try {
    const call = dependencies.transport ?? createAgencyValidationTransport(config, { save });
    let operation = ledger.db.prepare('SELECT * FROM operations WHERE id=?').get(id);
    let detail;
    if (operation) {
      detail = JSON.parse(operation.detail);
      requireThat(options.resume === true && detail.contractSha256 === repo.remoteValidation.contractSha256,
        'Remote validation already reserved; use explicit resume, never resubmit', 'blocked-reconciliation');
      if (!detail.jobId && existsSync(join(directory, 'created.json'))) {
        const created = read(join(directory, 'created.json'));
        requireThat(typeof created.jobId === 'string' && /^[a-zA-Z0-9_.-]+$/.test(created.jobId),
          'Saved creation response has no valid job ID', 'blocked-reconciliation');
        detail.jobId = created.jobId;
        ledger.finishOperation(id, 'accepted', detail);
      }
      requireThat(detail.jobId, 'Submission identity is uncertain; reconcile externally without resubmitting',
        'blocked-reconciliation');
      if (['passed', 'failed', 'blocked'].includes(operation.state)) {
        const receipt = read(detail.artifact);
        requireThat(hash(readFileSync(detail.artifact)) === detail.artifactSha256 &&
          json(await artifactInventory(join(directory, 'job-artifact'), contract.maximumArtifactBytes)) === json(receipt.inventory),
          'Completed remote validation receipt changed', 'blocked-reconciliation');
        return [gateResult(repo, revision, detail, receipt)];
      }
    } else {
      requireThat(options.resume !== true, 'No reserved remote validation exists to resume', 'blocked-reconciliation');
      const request = structuredClone(contract.request);
      request.metadata.controllerValidationId = id;
      request.metadata.controllerContractSha256 = repo.remoteValidation.contractSha256;
      detail = { contractSha256: repo.remoteValidation.contractSha256, sourceRevision: revision,
        requestSha256: hash(`${JSON.stringify(request, null, 2)}\n`), directory, reservedAt: new Date(clock()).toISOString(), deadline: clock() +
          (contract.queueMinutes + contract.maximumRunnerMinutes) * 60000 };
      mkdirSync(directory, { recursive: true });
      save(join(directory, 'contract.json'), contract);
      save(join(directory, 'request.json'), request);
      const preflight = await call('preflight', { contract }, directory);
      requireThat(preflight?.preflightPassed === true,
        'Read-only remote pipeline qualification was not confirmed; no job reserved', 'blocked-validation');
      ledger.transaction(() => {
        if (maximumJobs != null) {
          const count = ledger.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE kind IN ('agency-remote-validation', 'agency-workspace-loop', 'agency-workspace-authoring')").get().n;
          requireThat(count < maximumJobs,
            'Remote validation new-job budget exhausted', 'blocked-authorization');
        }
        ledger.operation(id, job.id, kind, detail);
      });
      let created;
      try { created = await call('submit', { contract, request, requestSha256: detail.requestSha256 }, directory); }
      catch (error) {
        ledger.finishOperation(id, 'uncertain', { ...detail, error: safeError(error) });
        throw new PilotError('blocked-reconciliation', 'Remote submission uncertain; resume the same reservation, never submit a replacement');
      }
      requireThat(typeof created.jobId === 'string' && /^[a-zA-Z0-9_.-]+$/.test(created.jobId),
        'Remote creation identity missing; do not resubmit', 'blocked-reconciliation');
      detail.jobId = created.jobId;
      ledger.finishOperation(id, 'accepted', detail);
    }
    let observation;
    while (true) {
      try { observation = await call('inspect', { contract, jobId: detail.jobId }, directory); }
      catch (error) {
        ledger.finishOperation(id, 'uncertain', { ...detail, error: safeError(error) });
        throw new PilotError('blocked-reconciliation', 'Remote inspection failed; resume the recorded job without resubmission');
      }
      const build = observation.build;
      detail.lastObservation = {
        observedAt: now(), agencyState: observation.job?.state ?? null,
        agencyResult: observation.job?.result ?? null, buildId: build?.id ?? null,
        buildStatus: build?.status ?? null, buildResult: build?.result ?? null
      };
      ledger.finishOperation(id, detail.cancellationReservedAt ? 'cancellation-reserved' : 'accepted', detail);
      if (build?.status === 'completed' &&
        ['Completed', 'Failed', 'Cancelled'].includes(observation.job?.state)) break;
      const runnerExceeded = build?.startTime &&
        clock() - Date.parse(build.startTime) > contract.maximumRunnerMinutes * 60000;
      const queueExceeded = !build?.startTime &&
        clock() - Date.parse(detail.reservedAt) > contract.queueMinutes * 60000;
      if (!detail.cancellationReservedAt && (runnerExceeded || queueExceeded || clock() > detail.deadline)) {
        detail.cancellationReservedAt = new Date(clock()).toISOString();
        ledger.finishOperation(id, 'cancellation-reserved', detail);
        try { await call('cancel', { contract, jobId: detail.jobId, buildId: build?.id ?? null }, directory); }
        catch (error) {
          ledger.finishOperation(id, 'uncertain', { ...detail, error: safeError(error) });
          throw new PilotError('blocked-reconciliation', 'Cancellation outcome uncertain; reconcile both Agency and actual build');
        }
      }
      if (detail.cancellationReservedAt &&
        clock() - Date.parse(detail.cancellationReservedAt) > contract.cancellationMinutes * 60000)
        throw new PilotError('blocked-reconciliation', 'Cancellation not confirmed; no replacement job permitted');
      await wait(contract.pollSeconds * 1000);
    }
    const downloaded = await call('download', { contract, jobId: detail.jobId }, directory);
    save(join(directory, `observation-${Date.now()}.json`), downloaded);
    const receipt = await verify(contract, directory, downloaded, detail.jobId, job.workspace, detail.reservedAt);
    receipt.requestSha256 = detail.requestSha256;
    receipt.contractSha256 = detail.contractSha256;
    receipt.observedAt = now();
    receipt.controller = {
      executorSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
      transportSha256: hash(readFileSync(fileURLToPath(
        new URL('./agency-validation-transport.js', import.meta.url)))),
      artifactTransportSha256: hash(readFileSync(agencyArtifactTransportPath))
    };
    const artifact = join(directory, `controller-acceptance-${Date.now()}.json`);
    save(artifact, receipt);
    detail = { ...detail, artifact, artifactSha256: hash(readFileSync(artifact)),
      buildId: receipt.buildId, status: receipt.status, blockedReason: receipt.blockedReason };
    ledger.finishOperation(id, receipt.status, detail);
    return [gateResult(repo, revision, detail, receipt)];
  } finally { ledger.release(lock, owner); }
}

function gateResult(repo, revision, detail, receipt) {
  return {
    gateId: repo.validationGates[0].id, sourceRevision: receipt.sourceRevision,
    commandOrRunUrl: `${repo.remoteValidation.type}:${detail.jobId}/build/${receipt.buildId}`,
    status: receipt.status, artifactRefs: [detail.artifact], owner: repo.owner,
    nextCheckAt: null, attemptCount: 1, blockedReason: receipt.blockedReason
  };
}

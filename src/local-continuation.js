import { realpathSync, readFileSync, existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configAt, hash, json, now, requireThat, utc } from './common.js';
import { qualifyRepositorySkill, skillQualificationId, verifyRepositorySkillWorkspace } from './repository-skills.js';
import { command, makePlannedImprovementAssignment, requireCurrentAssignment,
  verifyPreservedChange, verifyContinuationPredecessor } from './workers.js';

export function importReviewedContinuation(config, ledger, nextLedger, assignment, qualification, source) {
  const runId = nextLedger.startRun(source, config.window);
  for (const evidenceId of assignment.evidenceIds) {
    const evidence = ledger.get('evidence', evidenceId);
    const capture = ledger.db.prepare('SELECT body FROM captures WHERE hash=?')
      .get(evidence.capture.sha256);
    requireThat(capture && hash(capture.body) === evidence.capture.sha256,
      'Original captured evidence is unavailable or changed', 'blocked-reconciliation');
    const imported = nextLedger.evidence(structuredClone(evidence),
      JSON.parse(Buffer.from(capture.body).toString('utf8')), runId);
    requireThat(imported.id === evidenceId, 'Continuation changed original evidence identity');
    const tracked = ledger.trackedState(evidence);
    requireThat(!tracked || tracked.state !== 'reconciliation-required',
      'Source eligibility requires reconciliation', 'blocked-reconciliation');
    if (tracked) nextLedger.setTrackedState(imported, tracked.state, tracked.reason);
  }
  nextLedger.finishRun(runId, 'complete');
  nextLedger.put(ledger.get('investigation', assignment.investigationId, assignment.investigationVersion));
  nextLedger.put(ledger.get('areaToImprove', assignment.improvementId, assignment.improvementVersion));
  nextLedger.put(ledger.get('testCoveragePlan', assignment.testCoveragePlanId, assignment.testCoveragePlanVersion));
  nextLedger.qualify(skillQualificationId(assignment.repoId, assignment.skillBindingId), qualification);
}

export async function prepareLocalPreModelContinuation(config, ledger, id, nextConfig, nextLedger,
  authorization) {
  const priorRoot = realpathSync(ledger.directory);
  const nextRoot = realpathSync(nextLedger.directory);
  const separate = (a, b) => {
    const path = relative(a, b);
    return path.startsWith('..') || isAbsolute(path);
  };
  requireThat(separate(priorRoot, nextRoot) && separate(nextRoot, priorRoot) &&
    realpathSync(config.stateDirectory) === priorRoot &&
    realpathSync(nextConfig.stateDirectory) === nextRoot,
  'Continuation requires a separate fresh ledger matching its configuration', 'blocked-reconciliation');
  const comparableNext = structuredClone(nextConfig);
  if (nextConfig.limits.maxAiCreditsPerSession !== config.limits.maxAiCreditsPerSession) {
    const change = authorization?.runtimeBudgetChange;
    requireThat(change?.previousCeiling === config.limits.maxAiCreditsPerSession &&
      change?.newCeiling === nextConfig.limits.maxAiCreditsPerSession &&
      Number.isFinite(change.newCeiling) && change.newCeiling > 0,
    'A runtime credit-ceiling change requires explicit authorization of both values',
    'blocked-authorization');
    comparableNext.limits.maxAiCreditsPerSession = config.limits.maxAiCreditsPerSession;
  }
  requireThat(json({ ...config, stateDirectory: null }) ===
    json({ ...comparableNext, stateDirectory: null }),
  'Continuation cannot change source, permissions, validation, routing or budgets', 'blocked-reconciliation');
  requireThat(authorization?.approved === true && authorization.authorizedBy === 'user' &&
    authorization.previousAssignmentId === id && authorization.maxModelAttempts === 1 &&
    authorization.nextConfigSha256 === hash(json(nextConfig)) &&
    /^[a-f0-9]{40,64}$/.test(authorization.controllerRevision ?? '') &&
    typeof authorization.reason === 'string' && authorization.reason.trim(),
  'An explicit source/config-bound one-attempt user authorization is required', 'blocked-authorization');
  utc(authorization.authorizedAt);
  requireThat((await command('git', ['rev-parse', 'HEAD'],
    fileURLToPath(new URL('..', import.meta.url)))).stdout.trim() === authorization.controllerRevision,
  'Continuation controller revision differs from the authorization', 'blocked-authorization');
  const owner = ledger.acquire('dispatch');
  let nextOwner;
  try {
    nextOwner = nextLedger.acquire('dispatch');
    const job = ledger.job(id);
    const assignment = ledger.get('assignment', id);
    const results = ledger.all('workerResult').filter(result => result.assignmentId === id);
    const result = results[0];
    requireThat(job?.state === 'blocked' && job.workspace && assignment?.execution === 'local' &&
      assignment.skillBindingId && assignment.testCoveragePlanId &&
      authorization.previousAttemptId === job.session_id &&
      authorization.sourceRevision === job.base_revision &&
      results.length === 1 && result.attemptId === job.session_id &&
      result.outcome === 'blocked' && result.sourceRevision === null &&
      result.draftPR === null && result.skillExecution === null &&
      result.validation.length === 0 && result.validationAttempts.length === 0 &&
      result.toolUsage?.used === 0 && result.toolUsage.rounds.length === 0 &&
      Object.values(result.toolUsage.byTool).every(count => count === 0) &&
      Date.parse(authorization.authorizedAt) >= Date.parse(result.reportedAt) &&
      Date.parse(authorization.authorizedAt) <= Date.now() + 60000,
    'The exact blocked attempt must prove no model, validation or publication execution',
    'blocked-reconciliation');
    const failure = JSON.parse(job.error ?? 'null');
    requireThat(failure?.code === 'blocked-repository-git' ||
      (failure?.code === 'blocked-reconciliation' &&
        failure.message === 'Repository skill content changed after qualification'),
    'Only a reconciled pre-model repository-skill Git failure can continue', 'blocked-reconciliation');
    requireThat(!ledger.status().operations.some(operation => operation.job_id === id),
      'Prior operations or continuation require reconciliation; no duplicate attempt', 'blocked-reconciliation');
    const nextState = nextLedger.status();
    requireThat(nextState.counts.length === 0 && nextState.jobs.length === 0 &&
      nextState.operations.length === 0 && nextState.runs.length === 0,
    'Continuation destination must be empty', 'blocked-reconciliation');
    const investigation = ledger.get('investigation', assignment.investigationId);
    requireCurrentAssignment(config, ledger, investigation, assignment);
    const latestEvidence = new Set(ledger.latestEvidence().map(evidence => evidence.id));
    requireThat(assignment.evidenceIds.every(evidenceId => latestEvidence.has(evidenceId) &&
      !['Removed', 'Resolved', 'Closed'].includes(ledger.get('evidence', evidenceId).sourceStatus)),
    'Continuation source evidence is superseded or no longer eligible', 'blocked-reconciliation');
    const qualification = await qualifyRepositorySkill(nextConfig, assignment.repoId,
      assignment.capability, assignment.skillBindingId);
    verifyRepositorySkillWorkspace(nextConfig, assignment, job.workspace, job.base_revision, qualification);
    requireThat(!(await command('git', ['-c', 'core.longpaths=true', 'status', '--porcelain'],
      job.workspace)).stdout.trim(),
    'Blocked workspace has edits; pre-model continuation is unsafe', 'blocked-reconciliation');
    const detail = {
      priorAssignmentId: id, priorAttemptId: job.session_id,
      priorResultId: result.id, priorResultSha256: hash(json(result)),
      priorJobSha256: hash(json(job)), priorStateDirectory: resolve(config.stateDirectory),
      nextStateDirectory: resolve(nextConfig.stateDirectory), authorization,
      authorizationSha256: hash(json(authorization)), qualification, preparedAt: now()
    };
    const operationId = `${id}:pre-model-continuation`;
    ledger.operation(operationId, id, 'pre-model-continuation', detail);
    nextLedger.transaction(() => {
      importReviewedContinuation(config, ledger, nextLedger, assignment, qualification,
        'pre-model-continuation:captured-evidence-import');
      const rebuilt = makePlannedImprovementAssignment(nextConfig, nextLedger, investigation,
        assignment.testCoveragePlanId, assignment.requestedOutcome, assignment.testCoveragePlanVersion);
      requireThat(json(rebuilt) === json(assignment), 'Continuation changed logical assignment semantics');
      const nextJob = nextLedger.prepare(rebuilt, { bucket: operationId, maxNew: 1 });
      detail.nextAttemptId = nextJob.session_id;
      nextLedger.operation(operationId, id, 'continued-from-pre-model-failure', detail);
      nextLedger.finishOperation(operationId, 'prepared', detail);
    });
    ledger.finishOperation(operationId, 'prepared', detail);
    return { assignment, job: nextLedger.job(id), audit: detail };
  } finally {
    if (nextOwner) nextLedger.release('dispatch', nextOwner);
    ledger.release('dispatch', owner);
  }
}

export async function prepareLocalValidationContinuation(config, ledger, id, nextConfig,
  nextLedger, authorization, proposal) {
  if (authorization?.kind === 'native-workspace-bin-path')
    return (await import('./local-native-bin-continuation.js')).prepareNativeBinContinuation(
      config, ledger, id, nextConfig, nextLedger, authorization, proposal);
  if (authorization?.kind === 'native-launcher-cache-path')
    return (await import('./local-native-cache-continuation.js')).prepareNativeCacheContinuation(
      config, ledger, id, nextConfig, nextLedger, authorization, proposal);
  if (authorization?.kind === 'native-wrapper-separator')
    return (await import('./local-native-wrapper-continuation.js')).prepareNativeWrapperContinuation(
      config, ledger, id, nextConfig, nextLedger, authorization, proposal);
  if (authorization?.kind === 'discovery-placement')
    return prepareDiscoveryPlacementContinuation(config, ledger, id, nextConfig,
      nextLedger, authorization, proposal);
  const priorRoot = realpathSync(ledger.directory), nextRoot = realpathSync(nextLedger.directory);
  const separate = (a, b) => {
    const path = relative(a, b);
    return path.startsWith('..') || isAbsolute(path);
  };
  requireThat(separate(priorRoot, nextRoot) && separate(nextRoot, priorRoot) &&
    realpathSync(config.stateDirectory) === priorRoot &&
    realpathSync(nextConfig.stateDirectory) === nextRoot,
  'Validation continuation requires a separate fresh configured ledger', 'blocked-reconciliation');
  const comparableNext = structuredClone(nextConfig);
  const lfsChanges = [];
  for (const repo of comparableNext.repositories) {
    const before = config.repositories.find(candidate => candidate.id === repo.id);
    for (const gate of repo.validationGates) {
      const oldGate = before?.validationGates.find(candidate => candidate.id === gate.id);
      if (oldGate && json(gate.lfsPaths ?? []) !== json(oldGate.lfsPaths ?? [])) {
        lfsChanges.push({ repoId: repo.id, gateId: gate.id,
          previous: oldGate.lfsPaths ?? [], next: gate.lfsPaths ?? [] });
        if (oldGate.lfsPaths === undefined) delete gate.lfsPaths;
        else gate.lfsPaths = oldGate.lfsPaths;
      }

    }
  }
  requireThat(json({ ...config, stateDirectory: null }) ===
    json({ ...comparableNext, stateDirectory: null }) &&
    lfsChanges.length > 0 && json(lfsChanges) === json(authorization?.lfsChanges) &&
    nextConfig.limits.maxValidationRepairRounds === 0 &&
    nextConfig.limits.maxValidationInfrastructureRetries === 0,
  'Validation continuation may change only state and explicitly pinned LFS materialization',
  'blocked-reconciliation');
  requireThat(authorization?.approved === true && authorization.authorizedBy === 'user' &&
    authorization.scope === 'future-local-runs' && authorization.maxModelAttempts === 0 &&
    authorization.previousAssignmentId === id &&
    authorization.nextConfigSha256 === hash(json(nextConfig)) &&
    authorization.proposalSha256 === hash(json(proposal)) &&
    /^[a-f0-9]{40,64}$/.test(authorization.controllerRevision ?? '') &&
    typeof authorization.reason === 'string' && authorization.reason.trim(),
  'Source/config/proposal-bound future-local authorization is required', 'blocked-authorization');
  utc(authorization.authorizedAt);
  utc(authorization.recordedAt);
  requireThat(Date.parse(authorization.authorizedAt) <= Date.parse(authorization.recordedAt) &&
    Date.parse(authorization.recordedAt) <= Date.now() + 60000 &&
    (await command('git', ['rev-parse', 'HEAD'],
      fileURLToPath(new URL('..', import.meta.url)))).stdout.trim() === authorization.controllerRevision,
  'Validation continuation authorization/controller timestamp or revision differs',
  'blocked-authorization');
  const proofBytes = readFileSync(authorization.provisioningProofPath);
  requireThat(hash(proofBytes) === authorization.provisioningProofSha256,
    'Provisioning unblock evidence changed', 'blocked-reconciliation');
  const proof = JSON.parse(proofBytes);
  requireThat(proof.state === 'passed' && proof.clean === true &&
    proof.revision === authorization.sourceRevision &&
    proof.materialization?.revision === authorization.sourceRevision &&
    Array.isArray(proof.materialization.objects) && proof.materialization.objects.length > 0 &&
    proof.nativeValidationInvoked === false && proof.modelInvoked === false &&
    proof.publicationInvoked === false,
  'A source-bound, validation-free provisioning proof is required', 'blocked-reconciliation');
  const owner = ledger.acquire('dispatch');
  let nextOwner;
  try {
    nextOwner = nextLedger.acquire('dispatch');
    const job = ledger.job(id), assignment = ledger.get('assignment', id);
    const results = ledger.all('workerResult').filter(result => result.assignmentId === id);
    const result = results[0];
    requireThat(job?.state === 'blocked' && job.workspace && assignment?.execution === 'local' &&
      assignment.skillBindingId && assignment.testCoveragePlanId && results.length === 1 &&
      result.attemptId === authorization.previousAttemptId &&
      result.sourceRevision === authorization.sourceRevision &&
      result.toolUsage?.used > 0 && result.toolUsage.byTool.pilot_write > 0 &&
      result.toolUsage.byTool.pilot_finish === 1 && result.toolUsage.rounds.length === 1 &&
      result.toolUsage.rounds[0].status === 'completed' &&
      result.validationAttempts.length === 1 && result.validation.length > 0 &&
      result.validation.every(gate => gate.status !== 'passed' &&
        gate.artifactRefs.length > 0 && gate.artifactRefs.every(path => existsSync(path))) &&
      Date.parse(authorization.recordedAt) >= Date.parse(result.reportedAt),
    'Validation continuation requires one terminal, model-authored, unpublished failed run',
    'blocked-reconciliation');
    for (const gate of result.validation) {
      for (const path of gate.artifactRefs) {
        const artifact = JSON.parse(readFileSync(path, 'utf8'));
        requireThat(artifact.revision === result.sourceRevision &&
          ['blocked', 'failed'].includes(artifact.status) &&
          Array.isArray(artifact.telemetry?.validationTimings) &&
          artifact.telemetry.validationTimings.length === 0,
        'Only a terminal preparation failure before native test execution may continue',
        'blocked-reconciliation');
      }
    }
    const operations = ledger.status().operations.filter(operation => operation.job_id === id);
    requireThat(operations.every(operation =>
      ['commit', 'validation', 'continued-from-pre-model-failure'].includes(operation.kind) &&
      ['completed', 'failed', 'blocked', 'prepared'].includes(operation.state)) &&
      operations.filter(operation => operation.kind === 'commit' && operation.state === 'completed' &&
        JSON.parse(operation.detail).revision === result.sourceRevision).length === 1,
    'Publication, prior continuation or uncertain operations require reconciliation',
    'blocked-reconciliation');
    const nextState = nextLedger.status();
    requireThat(!nextState.counts.length && !nextState.jobs.length &&
      !nextState.operations.length && !nextState.runs.length,
    'Validation continuation destination must be empty', 'blocked-reconciliation');
    const investigation = ledger.get('investigation', assignment.investigationId);
    requireCurrentAssignment(config, ledger, investigation, assignment);
    const latest = new Set(ledger.latestEvidence().map(evidence => evidence.id));
    requireThat(assignment.evidenceIds.every(evidenceId => latest.has(evidenceId) &&
      !['Removed', 'Resolved', 'Closed'].includes(ledger.get('evidence', evidenceId).sourceStatus)),
    'Validation continuation evidence is stale or excluded', 'blocked-reconciliation');
    const files = await verifyPreservedChange(config, assignment, job, result, proposal);
    const qualification = await qualifyRepositorySkill(nextConfig, assignment.repoId,
      assignment.capability, assignment.skillBindingId);
    requireThat(qualification.baseRevision === job.base_revision &&
      qualification.skillSha256 === assignment.skillQualification.skillSha256,
    'Validation continuation changed the reviewed source or native skill', 'blocked-reconciliation');
    for (const change of lfsChanges) {
      requireThat(change.repoId === assignment.repoId && change.previous.length === 0 &&
        change.next.length > 0 && change.next.every(path =>
          proof.materialization.objects.some(object => object.path === path &&
            /^[a-f0-9]{64}$/.test(object.oid) && Number.isSafeInteger(object.size) && object.size >= 0)),
      'LFS contract additions lack exact verified provisioning evidence', 'blocked-reconciliation');
      for (const path of change.next) {
        const object = proof.materialization.objects.find(object => object.path === path);
        const pointer = (await command('git', ['-c', 'core.longpaths=true', 'show',
          `${result.sourceRevision}:${path}`], job.workspace)).stdout.trim();
        requireThat(pointer === `version https://git-lfs.github.com/spec/v1\n` +
          `oid sha256:${object.oid}\nsize ${object.size}`,
        'Provisioning proof differs from the exact source LFS pointer', 'blocked-reconciliation');
      }
    }
    const detail = {
      priorStateDirectory: priorRoot, nextStateDirectory: nextRoot,
      priorAssignment: assignment, priorJob: job, priorResult: result, proposal, files,
      priorResultSha256: hash(json(result)), priorOperationsSha256: hash(json(operations)), authorization,
      authorizationSha256: hash(json(authorization)), qualification, preparedAt: now()
    };
    const operationId = `${id}:validation-continuation`;
    ledger.operation(operationId, id, 'validation-continuation', detail);
    let rebuilt;
    nextLedger.transaction(() => {
      importReviewedContinuation(config, ledger, nextLedger, assignment, qualification,
        'validation-continuation:captured-evidence-import');
      rebuilt = makePlannedImprovementAssignment(nextConfig, nextLedger, investigation,
        assignment.testCoveragePlanId, assignment.requestedOutcome, assignment.testCoveragePlanVersion);
      requireThat(json({ ...assignment, id: null, skillQualification: null }) ===
        json({ ...rebuilt, id: null, skillQualification: null }),
      'Validation continuation changed assignment semantics', 'blocked-reconciliation');
      const nextJob = nextLedger.prepare(rebuilt, { bucket: operationId, maxNew: 1 });
      detail.nextAttemptId = nextJob.session_id;
      detail.nextAssignmentId = rebuilt.id;
      nextLedger.operation(operationId, rebuilt.id, 'continued-from-validation-failure', detail);
      nextLedger.finishOperation(operationId, 'prepared', detail);
    });
    ledger.finishOperation(operationId, 'prepared', detail);
    return { assignment: rebuilt, job: nextLedger.job(rebuilt.id), audit: detail };
  } finally {
    if (nextOwner) nextLedger.release('dispatch', nextOwner);
    ledger.release('dispatch', owner);
  }
}

function originalValidationContinuation(ledger, id) {
  const operation = ledger.status().operations.find(row =>
    row.job_id === id && row.kind === 'continued-from-validation-failure');
  requireThat(operation?.state === 'prepared',
    'Discovery placement requires a recorded original validation continuation', 'blocked-reconciliation');
  const detail = JSON.parse(operation.detail);
  requireThat(!detail.originalContinuation && detail.authorization.kind === undefined &&
    detail.priorResult.toolUsage.used > 0 &&
    detail.priorResult.toolUsage.byTool.pilot_write > 0 &&
    detail.priorResult.toolUsage.byTool.pilot_finish === 1,
  'Only one discovery-placement correction of original model authoring is supported',
  'blocked-reconciliation');
  verifyContinuationPredecessor(detail, operation.id, detail.nextAttemptId);
  return { operationId: operation.id, detail };
}

export function selectLocalValidationRoleOrigin(config, ledger, id) {
  requireThat(realpathSync(config.stateDirectory) === realpathSync(ledger.directory),
    'Role origin configuration does not match its predecessor ledger', 'blocked-reconciliation');
    const authored = ledger.status().operations.find(row =>
      row.job_id === id && row.kind === 'authoring-successor-from-diagnostic');
    if (authored) {
      const detail = JSON.parse(authored.detail), job = ledger.job(id);
      requireThat(authored.state === 'prepared' && detail.nextAssignmentId === id &&
        detail.nextAttemptId === job?.session_id && detail.inputSha256 === hash(json(detail.input)) &&
        isAbsolute(detail.originalRoleOrigin?.stateDirectory ?? '') &&
        typeof detail.originalRoleOrigin.assignmentId === 'string',
      'Recorded authoring successor role lineage changed', 'blocked-reconciliation');
      return detail.originalRoleOrigin;
    }
  const continuation = ledger.status().operations.find(row =>
    row.job_id === id && row.kind === 'continued-from-validation-failure');
  if (!continuation) return { stateDirectory: ledger.directory, assignmentId: id };
  const continued = JSON.parse(continuation.detail);
  if (continued.nativeWrapperCorrection) {
    const linked = ledger.db.prepare('SELECT kind,state,detail FROM operations WHERE id=?')
      .get(`${id}:recorded-role-handoff`);
    const role = linked && JSON.parse(linked.detail);
    requireThat(continuation.state === 'prepared' && linked?.state === 'recorded' &&
      linked.kind === 'recorded-role-handoff' && role.nextAssignmentId === id &&
      role.nextAttemptId === ledger.job(id)?.session_id &&
      role.previousAssignmentId === continued.priorJob.id &&
      isAbsolute(role.roleVerificationOrigin?.stateDirectory ?? '') &&
      typeof role.roleVerificationOrigin.assignmentId === 'string',
    'Native continuation recorded role origin changed', 'blocked-reconciliation');
    verifyContinuationPredecessor(continued, continuation.id, ledger.job(id).session_id);
    return role.roleVerificationOrigin;
  }
  const { detail } = originalValidationContinuation(ledger, id);
  const linked = ledger.db.prepare('SELECT kind,state,detail FROM operations WHERE id=?')
    .get(`${id}:recorded-role-handoff`);
  requireThat(linked?.kind === 'recorded-role-handoff' && linked.state === 'recorded',
    'Continuation role origin requires its recorded handoff', 'blocked-reconciliation');
  const role = JSON.parse(linked.detail);
  requireThat(role.nextAssignmentId === id && role.nextAttemptId === ledger.job(id)?.session_id &&
    role.previousAssignmentId === detail.priorJob.id &&
    isAbsolute(role.previousConfigPath ?? '') &&
    realpathSync(configAt(role.previousConfigPath).stateDirectory) === detail.priorStateDirectory &&
    role.recordedRoleHandoff?.assignmentId === detail.priorJob.id &&
    role.recordedRoleHandoff?.sourceRevision === detail.priorJob.base_revision,
  'Continuation role origin differs from original authoring lineage', 'blocked-reconciliation');
  return { stateDirectory: detail.priorStateDirectory, assignmentId: detail.priorJob.id };
}

async function prepareDiscoveryPlacementContinuation(config, ledger, id, nextConfig,
  nextLedger, authorization, proposal) {
  const priorRoot = realpathSync(ledger.directory), nextRoot = realpathSync(nextLedger.directory);
  const separate = (a, b) => relative(a, b).startsWith('..') || isAbsolute(relative(a, b));
  const nonDot = path => !resolve(path).split(/[\\/]/).some(part => part.startsWith('.'));
  requireThat(separate(priorRoot, nextRoot) && separate(nextRoot, priorRoot) &&
    realpathSync(config.stateDirectory) === priorRoot &&
    realpathSync(nextConfig.stateDirectory) === nextRoot && nonDot(nextRoot) &&
    json({ ...config, stateDirectory: null }) === json({ ...nextConfig, stateDirectory: null }) &&
    nextConfig.limits.maxValidationRepairRounds === 0 &&
    nextConfig.limits.maxValidationInfrastructureRetries === 0,
  'Discovery correction may change only the separate non-dot state location',
  'blocked-reconciliation');
  requireThat(authorization.approved === true && authorization.authorizedBy === 'user' &&
    authorization.scope === 'future-local-runs' && authorization.maxModelAttempts === 0 &&
    authorization.previousAssignmentId === id &&
    authorization.nextConfigSha256 === hash(json(nextConfig)) &&
    authorization.proposalSha256 === hash(json(proposal)) &&
    /^[a-f0-9]{40,64}$/.test(authorization.controllerRevision ?? '') &&
    typeof authorization.reason === 'string' && authorization.reason.trim(),
  'Source/config/proposal-bound discovery authorization is required', 'blocked-authorization');
  utc(authorization.authorizedAt);
  utc(authorization.recordedAt);
  requireThat(Date.parse(authorization.authorizedAt) <= Date.parse(authorization.recordedAt) &&
    Date.parse(authorization.recordedAt) <= Date.now() + 60000 &&
    (await command('git', ['rev-parse', 'HEAD'],
      fileURLToPath(new URL('..', import.meta.url)))).stdout.trim() === authorization.controllerRevision,
  'Discovery correction authorization/controller differs', 'blocked-authorization');
  const pinned = reference => {
    requireThat(reference && isAbsolute(reference.path ?? '') &&
      hash(readFileSync(reference.path)) === reference.sha256,
    'Discovery correction evidence changed', 'blocked-reconciliation');
    return JSON.parse(readFileSync(reference.path));
  };
  const diagnostic = pinned(authorization.discoveryDiagnostic);
  const proof = pinned(authorization.placementProof);
  requireThat(diagnostic.sourceRevision === authorization.sourceRevision &&
    diagnostic.nativeValidationInvoked === false && diagnostic.testBodiesExecuted === 0 &&
    diagnostic.sourceModified === false && diagnostic.actual.exists === true &&
    diagnostic.actual.rootsMatch === true && diagnostic.actual.ignored === false &&
    diagnostic.actual.testMatch === false &&
    diagnostic.controls.nonDotDirectoryStringsOnlyMatch === true &&
    proof.kind === 'discovery-placement' && proof.state === 'passed' && proof.clean === true &&
    proof.revision === authorization.sourceRevision && proof.nextStateDirectory === nextRoot &&
    proof.nativeValidationInvoked === false && proof.testBodiesExecuted === 0 &&
    proof.modelInvoked === false && proof.publicationInvoked === false &&
    proof.discovery.rootsMatch === true && proof.discovery.testMatch === true &&
    proof.discovery.ignored === false && proof.discovery.sha256 === diagnostic.actual.sha256 &&
    nonDot(proof.workspace),
  'Source-bound zero-body discovery diagnosis and non-dot placement proof are required',
  'blocked-reconciliation');
  requireThat((await command('git', ['-c', 'core.longpaths=true', 'rev-parse', 'HEAD'],
    proof.workspace)).stdout.trim() === authorization.sourceRevision &&
    !(await command('git', ['-c', 'core.longpaths=true', 'status', '--porcelain'],
      proof.workspace)).stdout.trim(),
  'Placement proof checkout changed', 'blocked-reconciliation');
  const owner = ledger.acquire('dispatch');
  let nextOwner;
  try {
    nextOwner = nextLedger.acquire('dispatch');
    const job = ledger.job(id), assignment = ledger.get('assignment', id);
    const origin = originalValidationContinuation(ledger, id);
    selectLocalValidationRoleOrigin(config, ledger, id);
    const results = ledger.all('workerResult').filter(row => row.assignmentId === id);
    const result = results[0];
    requireThat(job?.state === 'blocked' && assignment?.execution === 'local' &&
      results.length === 1 && result.outcome === 'blocked' && result.draftPR === null &&
      result.attemptId === job.session_id && result.attemptId === authorization.previousAttemptId &&
      result.sourceRevision === authorization.sourceRevision &&
      origin.detail.nextAttemptId === job.session_id &&
      result.toolUsage.used === 0 && result.toolUsage.rounds.length === 0 &&
      result.validationAttempts.length === 1 && result.validation.length === 1 &&
      assignment.validationGates.length === 1 && result.validation[0].status === 'failed' &&
      result.validation[0].attemptCount === 1 && result.validation[0].artifactRefs.length === 1 &&
      Date.parse(authorization.recordedAt) >= Date.parse(result.reportedAt) &&
      json(origin.detail.proposal) === json(proposal),
    'Discovery correction requires the exact failed zero-model continuation',
    'blocked-reconciliation');
    const failure = pinned(authorization.discoveryFailure);
    const timings = failure.telemetry?.validationTimings;
    const selector = proof.discovery.selector;
    requireThat(result.validation[0].artifactRefs[0] === authorization.discoveryFailure.path &&
      failure.revision === result.sourceRevision && failure.status === 'failed' &&
      failure.output?.exitCode === 1 && !failure.output.timeout &&
      typeof selector === 'string' && selector.length > 0 &&
      proof.discovery.path.endsWith(`/${selector}`) &&
      failure.output.stderr.includes('No tests found, exiting with code 1') &&
      failure.output.stderr.includes(`Files: "${selector}"`) &&
      !/PILOT_(?:NATIVE_)?CHANGED_CASE:/.test(failure.output.stdout) &&
      Array.isArray(timings) && timings.filter(stage => stage.id === 'test').length === 1 &&
      timings.filter(stage => stage.id === 'policy').length === 1 &&
      Array.isArray(proof.absentCaseArtifacts) && proof.absentCaseArtifacts.length > 0 &&
      proof.absentCaseArtifacts.every(path => isAbsolute(path) && !existsSync(path)),
    'Only exact zero-body test-discovery failure may receive a placement correction',
    'blocked-reconciliation');
    const operations = ledger.status().operations.filter(row => row.job_id === id);
    requireThat(operations.every(row =>
      ['continued-from-validation-failure', 'recorded-role-handoff', 'role-validation-execution',
        'reuse-authored-revision', 'validation'].includes(row.kind) &&
      ['prepared', 'recorded', 'completed', 'failed'].includes(row.state)),
    'Prior correction, publication or uncertain operation requires reconciliation',
    'blocked-reconciliation');
    const nextState = nextLedger.status();
    requireThat(!nextState.counts.length && !nextState.jobs.length &&
      !nextState.operations.length && !nextState.runs.length,
    'Discovery correction destination must be empty', 'blocked-reconciliation');
    const investigation = ledger.get('investigation', assignment.investigationId);
    requireCurrentAssignment(config, ledger, investigation, assignment);
    const files = await verifyPreservedChange(config, assignment, job, result, proposal);
    requireThat(files.some(file => file.path === proof.discovery.path &&
      file.sha256 === proof.discovery.sha256),
    'Discovery proof is not an unchanged authored test', 'blocked-reconciliation');
    await verifyPreservedChange(config, origin.detail.priorAssignment, origin.detail.priorJob,
      origin.detail.priorResult, proposal);
    const qualification = await qualifyRepositorySkill(nextConfig, assignment.repoId,
      assignment.capability, assignment.skillBindingId);
    requireThat(qualification.baseRevision === job.base_revision &&
      qualification.skillSha256 === assignment.skillQualification.skillSha256 &&
      qualification.validationContractSha256 === assignment.skillQualification.validationContractSha256,
    'Discovery correction changed the source, skill or native gate', 'blocked-reconciliation');
    const detail = {
      priorStateDirectory: priorRoot, nextStateDirectory: nextRoot,
      priorAssignment: assignment, priorJob: job, priorResult: result, proposal, files,
      priorResultSha256: hash(json(result)), priorOperationsSha256: hash(json(operations)),
      originalContinuation: origin, authorization, authorizationSha256: hash(json(authorization)),
      qualification, preparedAt: now()
    };
    const operationId = `${id}:validation-continuation`;
    ledger.operation(operationId, id, 'validation-continuation', detail);
    let rebuilt;
    nextLedger.transaction(() => {
      importReviewedContinuation(config, ledger, nextLedger, assignment, qualification,
        'discovery-placement-continuation:captured-evidence-import');
      rebuilt = makePlannedImprovementAssignment(nextConfig, nextLedger, investigation,
        assignment.testCoveragePlanId, assignment.requestedOutcome, assignment.testCoveragePlanVersion);
      requireThat(json(rebuilt) === json(assignment),
        'Discovery correction changed the logical assignment', 'blocked-reconciliation');
      const nextJob = nextLedger.prepare(rebuilt, { bucket: operationId, maxNew: 1 });
      detail.nextAttemptId = nextJob.session_id;
      detail.nextAssignmentId = rebuilt.id;
      nextLedger.operation(operationId, rebuilt.id, 'continued-from-validation-failure', detail);
      nextLedger.finishOperation(operationId, 'prepared', detail);
    });
    ledger.finishOperation(operationId, 'prepared', detail);
    return { assignment: rebuilt, job: nextLedger.job(rebuilt.id), audit: detail };
  } finally {
    if (nextOwner) nextLedger.release('dispatch', nextOwner);
    ledger.release('dispatch', owner);
  }
}

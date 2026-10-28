import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, json, now, requireThat, utc } from './common.js';
import { importReviewedContinuation } from './local-continuation.js';
import { qualifyRepositorySkill } from './repository-skills.js';
import { command, makePlannedImprovementAssignment, prepareValidation,
  rebindPreparedTestProfile, requireCurrentAssignment, verifyPreservedChange } from './workers.js';

const pin = reference => {
  requireThat(isAbsolute(reference?.path ?? '') &&
    hash(readFileSync(reference.path)) === reference.sha256,
  'Jest cache continuation evidence changed', 'blocked-reconciliation');
  return JSON.parse(readFileSync(reference.path, 'utf8'));
};
const separate = (a, b) => {
  const path = relative(resolve(a), resolve(b));
  return path.startsWith(`..`) || isAbsolute(path);
};

export function isolateNativeJestCache(profile, artifactsDirectory) {
  requireThat(isAbsolute(artifactsDirectory) && !/['\r\n]/.test(artifactsDirectory),
    'Native Jest artifacts require an absolute literal directory', 'blocked-reconciliation');
  const directory = "    $resultDirectory = Join-Path $PSScriptRoot 'al-native-results'";
  const invocation = '            --passWithNoTests=false --json --outputFile $output';
  requireThat(profile.split(directory).length === 2 && profile.split(invocation).length === 2,
    'Expected exactly one native Jest result directory and full-suite invocation',
    'blocked-reconciliation');
  return profile.replace(directory,
    `    $resultDirectory = '${artifactsDirectory}'\n` +
    "    $cacheDirectory = Join-Path $resultDirectory ('cache-' + [guid]::NewGuid().ToString('N').Substring(0, 12))")
    .replace(invocation, `${invocation} --cacheDirectory $cacheDirectory`);
}

export function verifyNativeJestCacheFailure(artifact, revision) {
  const stages = artifact.telemetry?.validationTimings ?? [];
  const cleanup = stages.find(stage => stage.id === 'cleanup');
  const outputCheck = cleanup?.subphases?.find(stage => stage.id === 'verify-prepared-outputs');
  const proofs = artifact.output?.stdout?.split(/\r?\n/)
    .filter(line => line.startsWith('PILOT_VALIDATION_TEST_RESULT:')) ?? [];
  requireThat(artifact.status === 'blocked' && artifact.blockedReason === 'prepared-cache-corrupt' &&
    artifact.revision === revision && artifact.telemetry.validationRevision === revision &&
    stages.filter(stage => stage.id === 'test').length === 1 &&
    stages.find(stage => stage.id === 'test').outputSha256 &&
    cleanup?.cache === 'invalidated' && outputCheck?.reason === 'rename:node_modules/.cache/jest' &&
    proofs.length === 1,
  'Continuation requires the exact post-test native Jest cache mutation', 'blocked-reconciliation');
  const proof = JSON.parse(proofs[0].slice('PILOT_VALIDATION_TEST_RESULT:'.length));
  requireThat(Number.isInteger(proof.suiteCount) && proof.suiteCount > 0 &&
    Number.isInteger(proof.testCount) && proof.testCount > 0 &&
    proof.selectedTests?.length > 0 && /^[a-f0-9]{64}$/.test(proof.resultSha256) &&
    artifact.output.stderr.includes(`Test Suites: ${proof.suiteCount} passed, ${proof.suiteCount} total`) &&
    new RegExp(`Tests:\\s+${proof.testCount} passed, ${proof.testCount} total`).test(artifact.output.stderr),
  'Original native run must independently show nonempty passing full-suite discovery',
  'blocked-reconciliation');
  return proof;
}

export function verifyNativeJestCacheContinuation(config, detail) {
  const correction = detail.nativeJestCacheCorrection;
  const authorization = detail.authorization;
  requireThat(authorization.kind === 'native-jest-cache-isolation' &&
    authorization.maxModelAttempts === 0 && correction,
  'Missing zero-model native Jest cache correction', 'blocked-reconciliation');
  for (const name of ['workers.js', 'local-continuation.js', 'local-jest-cache-continuation.js']) {
    const reference = authorization.controllerSources?.[name];
    requireThat(reference?.path === fileURLToPath(new URL(name, import.meta.url)) &&
      hash(readFileSync(reference.path)) === reference.sha256,
    'Continuation controller source bytes changed', 'blocked-reconciliation');
  }
  pin(authorization.userAuthorization);
  const artifact = pin(authorization.nativeArtifact);
  verifyNativeJestCacheFailure(artifact, detail.priorResult.sourceRevision);
  const previous = correction.priorConfig.repositories[0].validationGates[0];
  const next = config.repositories[0].validationGates[0];
  requireThat(artifact.profileSha256 === previous.profileSha256 &&
    hash(readFileSync(previous.profilePath)) === previous.profileSha256 &&
    hash(readFileSync(next.profilePath)) === next.profileSha256 &&
    readFileSync(next.profilePath, 'utf8') ===
      isolateNativeJestCache(readFileSync(previous.profilePath, 'utf8'), correction.artifactsDirectory),
  'Only durable native results and the explicit Jest cache directory may change',
  'blocked-reconciliation');
  const comparable = structuredClone(config);
  comparable.repositories[0].validationGates[0].profilePath = previous.profilePath;
  comparable.repositories[0].validationGates[0].profileSha256 = previous.profileSha256;
  requireThat(json({ ...comparable, stateDirectory: null }) ===
    json({ ...correction.priorConfig, stateDirectory: null }),
  'Jest cache correction changed another permission, source, budget or gate',
  'blocked-reconciliation');
  const artifactRoot = realpathSync(correction.artifactsDirectory);
  const privateRoot = realpathSync(config.stateDirectory);
  requireThat(!separate(privateRoot, artifactRoot) && artifactRoot !== privateRoot &&
    [detail.priorJob.workspace, config.runtime.validationCacheDirectory,
      config.repositories[0].referenceCheckout].every(root => root &&
        separate(realpathSync(root), artifactRoot)),
  'Native Jest artifacts must remain private and outside all immutable/source workspaces',
  'blocked-reconciliation');
}

export async function prepareNativeJestCacheContinuation(config, ledger, id, nextConfig,
  nextLedger, authorization, proposal) {
  const priorRoot = realpathSync(ledger.directory), nextRoot = realpathSync(nextLedger.directory);
  requireThat(separate(priorRoot, nextRoot) && separate(nextRoot, priorRoot) &&
    realpathSync(config.stateDirectory) === priorRoot &&
    realpathSync(nextConfig.stateDirectory) === nextRoot &&
    config.repositories.length === 1 && nextConfig.repositories.length === 1 &&
    config.repositories[0].validationGates.length === 1 &&
    nextConfig.repositories[0].validationGates.length === 1,
  'Jest cache continuation requires separate private state and one unchanged repository/gate',
  'blocked-reconciliation');
  requireThat(authorization?.approved === true && authorization.authorizedBy === 'user' &&
    authorization.kind === 'native-jest-cache-isolation' && authorization.maxModelAttempts === 0 &&
    authorization.previousAssignmentId === id &&
    authorization.nextConfigSha256 === hash(json(nextConfig)) &&
    authorization.proposalSha256 === hash(json(proposal)) &&
    nextConfig.limits.maxValidationRepairRounds === 0 &&
    nextConfig.limits.maxValidationInfrastructureRetries === 0,
  'Exact source/config/proposal-bound zero-model authority is required', 'blocked-authorization');
  utc(authorization.recordedAt);
  requireThat((await command('git', ['rev-parse', 'HEAD'],
    fileURLToPath(new URL('..', import.meta.url)))).stdout.trim() === authorization.controllerRevision,
  'Controller revision changed', 'blocked-reconciliation');
  const owner = ledger.acquire('dispatch'); let nextOwner;
  try {
    nextOwner = nextLedger.acquire('dispatch');
    const state = nextLedger.status();
    requireThat(!state.jobs.length && !state.counts.length && !state.operations.length && !state.runs.length,
      'Continuation destination must be unused', 'blocked-reconciliation');
    const job = ledger.job(id), assignment = ledger.get('assignment', id);
    const results = ledger.all('workerResult').filter(result => result.assignmentId === id);
    const result = results[0], operations = ledger.status().operations.filter(row => row.job_id === id);
    requireThat(job?.state === 'blocked' && assignment?.execution === 'local' &&
      job.session_id === authorization.previousAttemptId && results.length === 1 &&
      result.sourceRevision === authorization.sourceRevision && result.validation.length === 1 &&
      result.validationAttempts.length === 1 &&
      result.validation[0].artifactRefs.length === 1 &&
      result.validation[0].artifactRefs[0] === authorization.nativeArtifact.path &&
      operations.length === 2 &&
      operations.some(row => row.kind === 'commit' && row.state === 'completed' &&
        JSON.parse(row.detail).revision === result.sourceRevision) &&
      operations.some(row => row.kind === 'validation' && row.state === 'blocked' &&
        JSON.parse(row.detail).artifact === authorization.nativeArtifact.path) &&
      Date.parse(authorization.recordedAt) >= Date.parse(result.reportedAt) &&
      Date.parse(authorization.recordedAt) <= Date.now() + 60000,
    'Only the exact terminal, committed, unpublished native-cache failure may continue once',
    'blocked-reconciliation');
    const files = await verifyPreservedChange(config, assignment, job, result, proposal);
    const investigation = ledger.get('investigation', assignment.investigationId);
    requireCurrentAssignment(config, ledger, investigation, assignment);
    const qualification = await qualifyRepositorySkill(nextConfig, assignment.repoId,
      assignment.capability, assignment.skillBindingId);
    requireThat(qualification.baseRevision === job.base_revision &&
      qualification.skillSha256 === assignment.skillQualification.skillSha256,
    'Continuation changed the qualified source or authoring skill', 'blocked-reconciliation');
    const detail = {
      priorStateDirectory: priorRoot, nextStateDirectory: nextRoot, priorAssignment: assignment,
      priorJob: job, priorResult: result, proposal, files,
      priorResultSha256: hash(json(result)), priorOperationsSha256: hash(json(operations)),
      authorization, authorizationSha256: hash(json(authorization)), qualification, preparedAt: now(),
      nativeTestProfile: true,
      nativeJestCacheCorrection: { priorConfig: config,
        artifactsDirectory: authorization.artifactsDirectory }
    };
    verifyNativeJestCacheContinuation(nextConfig, detail);
    const operationId = `${id}:native-jest-cache-continuation`;
    ledger.operation(operationId, id, 'validation-continuation', detail);
    let rebuilt;
    nextLedger.transaction(() => {
      importReviewedContinuation(nextConfig, ledger, nextLedger, assignment, qualification,
        'native-jest-cache-continuation:captured-evidence-import');
      rebuilt = makePlannedImprovementAssignment(nextConfig, nextLedger, investigation,
        assignment.testCoveragePlanId, assignment.requestedOutcome, assignment.testCoveragePlanVersion);
      requireThat(json({ ...assignment, id: null, skillQualification: null }) ===
        json({ ...rebuilt, id: null, skillQualification: null }),
      'Continuation changed assignment semantics', 'blocked-reconciliation');
      const nextJob = nextLedger.prepare(rebuilt, { bucket: operationId, maxNew: 1 });
      Object.assign(detail, { nextAttemptId: nextJob.session_id, nextAssignmentId: rebuilt.id });
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

export async function prepareJestCacheContinuationValidation(config, job, repo, revision, detail) {
  verifyNativeJestCacheContinuation(config, detail);
  const prior = detail.nativeJestCacheCorrection.priorConfig;
  const previousGate = prior.repositories[0].validationGates[0], nextGate = repo.validationGates[0];
  const prepared = await prepareValidation(prior, job, prior.repositories[0], revision);
  if (prepared[previousGate.id]?.error) return prepared;
  const receiptPath = join(config.stateDirectory, 'native-test-profile-rebind.json');
  requireThat(!existsSync(receiptPath), 'Native profile continuation may prepare only once',
    'blocked-reconciliation');
  const rebound = await rebindPreparedTestProfile(prepared[previousGate.id],
    previousGate, nextGate, receiptPath);
  return { [nextGate.id]: rebound };
}

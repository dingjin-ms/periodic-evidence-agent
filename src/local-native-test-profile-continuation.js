import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, json, now, requireThat, utc } from './common.js';
import { importReviewedContinuation } from './local-continuation.js';
import { qualifyRepositorySkill } from './repository-skills.js';
import {
  command, makePlannedImprovementAssignment, requireCurrentAssignment,
  verifyPreservedChange, verifyTestOnlyProfileChange
} from './workers.js';

export async function prepareNativeTestProfileContinuation(config, ledger, id,
  nextConfig, nextLedger, authorization, proposal) {
  const priorRoot = realpathSync(ledger.directory), nextRoot = realpathSync(nextLedger.directory);
  const separated = (left, right) => {
    const path = relative(left, right);
    return path.startsWith('..') || isAbsolute(path);
  };
  requireThat(separated(priorRoot, nextRoot) && separated(nextRoot, priorRoot) &&
    resolve(config.stateDirectory) === priorRoot && resolve(nextConfig.stateDirectory) === nextRoot,
  'Test-profile continuation requires separate configured ledgers', 'blocked-reconciliation');
  const comparable = structuredClone(nextConfig);
  const changes = [];
  for (const repo of comparable.repositories) {
    const previous = config.repositories.find(value => value.id === repo.id);
    for (const gate of repo.validationGates) {
      const before = previous?.validationGates.find(value => value.id === gate.id);
      if (before && gate.profileSha256 !== before.profileSha256) {
        verifyTestOnlyProfileChange(before, gate);
        changes.push({ repoId: repo.id, gateId: gate.id,
          before: before.profileSha256, after: gate.profileSha256 });
        gate.profileSha256 = before.profileSha256;
        gate.profilePath = before.profilePath;
      }
    }
  }
  requireThat(changes.length === 1 &&
    json({ ...config, stateDirectory: null }) === json({ ...comparable, stateDirectory: null }),
  'Test-profile continuation cannot change permissions, budgets, source or preparation',
  'blocked-reconciliation');
  requireThat(authorization?.approved === true && authorization.authorizedBy === 'user' &&
    authorization.previousAssignmentId === id && authorization.maxModelAttempts === 0 &&
    authorization.nextConfigSha256 === hash(json(nextConfig)) &&
    authorization.previousConfigSha256 === hash(json(config)) &&
    json(authorization.profileChanges) === json(changes) &&
    typeof authorization.reason === 'string' && authorization.reason.trim(),
  'A source/config-bound infrastructure-only continuation authorization is required',
  'blocked-authorization');
  utc(authorization.authorizedAt);
  requireThat((await command('git', ['rev-parse', 'HEAD'],
    fileURLToPath(new URL('..', import.meta.url)))).stdout.trim() === authorization.controllerRevision,
  'Continuation controller revision changed', 'blocked-authorization');
  const owner = ledger.acquire('dispatch');
  let nextOwner;
  try {
    nextOwner = nextLedger.acquire('dispatch');
    const job = ledger.job(id), assignment = ledger.get('assignment', id);
    const result = ledger.all('workerResult').filter(value => value.assignmentId === id).at(-1);
    requireThat(job?.state === 'blocked' && assignment?.execution === 'local' &&
      assignment.skillBindingId && authorization.previousAttemptId === job.session_id &&
      authorization.sourceRevision === result?.sourceRevision &&
      result?.id === authorization.previousResultId && result.validation.length === 1 &&
      result.validation[0].status === 'failed' && !result.validation[0].blockedReason &&
      result.validation[0].gateId === changes[0].gateId &&
      result.validation[0].sourceRevision === result.sourceRevision,
    'Continuation requires the exact terminal native test failure', 'blocked-reconciliation');
    const reference = authorization.failureArtifact;
    requireThat(isAbsolute(reference?.path ?? '') &&
      hash(readFileSync(reference.path)) === reference.sha256 &&
      result.validation[0].artifactRefs.includes(reference.path),
    'Native failure evidence changed', 'blocked-reconciliation');
    const artifact = JSON.parse(readFileSync(reference.path));
    requireThat(artifact.revision === result.sourceRevision &&
      artifact.profileSha256 === changes[0].before && artifact.status === 'failed' &&
      artifact.output?.exitCode === 1 && /Cannot find module/.test(artifact.output.stderr) &&
      artifact.telemetry?.validationTimings?.some(value => value.id === 'test'),
    'Native failure does not establish the source-resolution problem', 'blocked-reconciliation');
    const operations = ledger.status().operations.filter(value => value.job_id === id);
    requireThat(!operations.some(value =>
      ['push', 'draft-pr', 'draft-build', 'validation-continuation'].includes(value.kind)),
    'Prior publication or continuation requires reconciliation', 'blocked-reconciliation');
    const empty = nextLedger.status();
    requireThat(empty.counts.length === 0 && empty.jobs.length === 0 &&
      empty.operations.length === 0 && empty.runs.length === 0,
    'Continuation destination must be empty', 'blocked-reconciliation');
    const investigation = ledger.get('investigation', assignment.investigationId);
    requireCurrentAssignment(config, ledger, investigation, assignment);
    const files = await verifyPreservedChange(config, assignment, job, result, proposal);
    const qualification = await qualifyRepositorySkill(nextConfig, assignment.repoId,
      assignment.capability, assignment.skillBindingId);
    requireThat(qualification.baseRevision === job.base_revision,
      'Native profile correction changed the product source', 'blocked-reconciliation');
    const detail = {
      priorStateDirectory: priorRoot, priorAssignment: assignment, priorJob: job,
      priorResult: result, priorResultSha256: hash(ledger.db.prepare(
        "SELECT body FROM records WHERE kind='workerResult' AND id=?").get(result.id).body),
      priorOperationsSha256: hash(json(ledger.db.prepare(
        'SELECT * FROM operations WHERE job_id=? ORDER BY updated_at DESC').all(id))),
      authorization, proposal, files, nativeTestProfile: changes[0], preparedAt: now()
    };
    const operationId = `${id}:native-test-profile-continuation`;
    ledger.operation(operationId, id, 'validation-continuation', detail);
    importReviewedContinuation(config, ledger, nextLedger, assignment, qualification,
      'native-test-profile:preserved-evidence');
    const nextAssignment = makePlannedImprovementAssignment(nextConfig, nextLedger,
      investigation, assignment.testCoveragePlanId, assignment.requestedOutcome,
      assignment.testCoveragePlanVersion);
    const nextJob = nextLedger.prepare(nextAssignment, { bucket: operationId, maxNew: 1 });
    detail.nextAttemptId = nextJob.session_id;
    nextLedger.operation(operationId, nextAssignment.id, 'continued-from-validation-failure', detail);
    nextLedger.finishOperation(operationId, 'prepared', detail);
    ledger.finishOperation(operationId, 'prepared', detail);
    return { assignment: nextAssignment, job: nextJob, audit: detail };
  } finally {
    if (nextOwner) nextLedger.release('dispatch', nextOwner);
    ledger.release('dispatch', owner);
  }
}

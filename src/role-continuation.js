import { isAbsolute } from 'node:path';
import { configAt, hash, json, now, requireThat, safeError } from './common.js';
import { Ledger } from './ledger.js';
import { prepareLocalValidationContinuation, selectLocalValidationRoleOrigin } from './local-continuation.js';
import { dispatchLocalValidationContinuation } from './workers.js';
import { roleExecutionIdentity, verifyRecordedRoleHandoff } from './role-replay.js';

function previousState(input) {
  requireThat(typeof input?.previousConfigPath === 'string' && isAbsolute(input.previousConfigPath) &&
    typeof input.previousAssignmentId === 'string' && input.previousAssignmentId.length > 0,
  'Role continuation requires the exact previous config and assignment', 'blocked-reconciliation');
  const config = configAt(input.previousConfigPath);
  return { config, ledger: new Ledger(config.stateDirectory) };
}

function verifyPreviousRoleHandoff(previous, assignmentId, reference, expectedOrigin) {
  const origin = selectLocalValidationRoleOrigin(previous.config, previous.ledger, assignmentId);
  requireThat(typeof origin?.stateDirectory === 'string' && isAbsolute(origin.stateDirectory) &&
    typeof origin.assignmentId === 'string' && origin.assignmentId.length > 0,
  'Role continuation requires a validated original authoring identity', 'blocked-reconciliation');
  if (expectedOrigin) {
    requireThat(origin.stateDirectory === expectedOrigin.stateDirectory &&
      origin.assignmentId === expectedOrigin.assignmentId,
    'Role continuation original authoring identity changed after preparation', 'blocked-reconciliation');
  }
  const originLedger = origin.stateDirectory === previous.ledger.directory
    ? previous.ledger : new Ledger(origin.stateDirectory, { readOnly: true });
  try {
    return { origin, handoff: verifyRecordedRoleHandoff(reference, originLedger, origin.assignmentId) };
  } finally {
    if (originLedger !== previous.ledger) originLedger.close();
  }
}

export async function continueRoleValidation(config, ledger, input, mode) {
  requireThat(['prepare', 'execute'].includes(mode),
    'Role continuation requires exactly one of --prepare or --execute', 'blocked-authorization');
  const execution = await roleExecutionIdentity('proposer');
  if (mode === 'prepare') {
    requireThat(input?.recordedRoleHandoff,
      'Role continuation requires an actual recorded Collector/FILTER handoff', 'blocked-reconciliation');
    requireThat(Object.keys(input).every(key => ['previousConfigPath', 'previousAssignmentId',
      'authorization', 'preservedProposal', 'recordedRoleHandoff'].includes(key)),
    'Role continuation preparation contains unsupported input fields', 'blocked-reconciliation');
    const previous = previousState(input);
    try {
      const verified = verifyPreviousRoleHandoff(previous, input.previousAssignmentId,
        input.recordedRoleHandoff);
      const recordedRoleHandoff = verified.handoff;
      const prepared = await prepareLocalValidationContinuation(previous.config, previous.ledger,
        input.previousAssignmentId, config, ledger, input.authorization, input.preservedProposal);
      const detail = { previousConfigPath: input.previousConfigPath,
        previousAssignmentId: input.previousAssignmentId, recordedRoleHandoff,
        roleVerificationOrigin: verified.origin,
        nextAssignmentId: prepared.assignment.id, nextAttemptId: prepared.job.session_id,
        inputSha256: hash(json(input)), execution };
      ledger.transaction(() => {
        const id = `${prepared.assignment.id}:recorded-role-handoff`;
        ledger.operation(id, prepared.assignment.id, 'recorded-role-handoff', detail);
        ledger.finishOperation(id, 'recorded', detail);
      });
      return { ...prepared, recordedRoleHandoff, roleExecution: execution };
    } finally { previous.ledger.close(); }
  }

  requireThat(typeof input?.assignmentId === 'string' && input.assignmentId.length > 0 &&
    Object.keys(input).length === 1,
  'Role continuation execution requires only its prepared assignmentId', 'blocked-reconciliation');
  const linked = ledger.db.prepare('SELECT kind,state,detail FROM operations WHERE id=?')
    .get(`${input.assignmentId}:recorded-role-handoff`);
  requireThat(linked?.kind === 'recorded-role-handoff' && linked.state === 'recorded',
    'Role continuation has no prepared Collector/FILTER handoff', 'blocked-reconciliation');
  const detail = JSON.parse(linked.detail);
  requireThat(detail.nextAssignmentId === input.assignmentId &&
    detail.nextAttemptId === ledger.job(input.assignmentId)?.session_id,
  'Role continuation handoff does not match the prepared attempt', 'blocked-reconciliation');
  const previous = previousState(detail);
  let verified;
  try {
    verified = verifyPreviousRoleHandoff(previous, detail.previousAssignmentId, detail.recordedRoleHandoff,
      detail.roleVerificationOrigin ?? {
        stateDirectory: previous.config.stateDirectory, assignmentId: detail.previousAssignmentId
      });
  } finally { previous.ledger.close(); }
  const operationId = `${input.assignmentId}:role-validation-execution`;
  const trace = { execution, inputSha256: hash(json(input)), startedAt: now(),
    recordedRoleHandoff: verified.handoff, roleVerificationOrigin: verified.origin,
    previousAssignmentId: detail.previousAssignmentId,
    attemptId: detail.nextAttemptId, pid: process.pid };
  ledger.operation(operationId, input.assignmentId, 'role-validation-execution', trace);
  try {
    const result = await dispatchLocalValidationContinuation(config, ledger, input.assignmentId);
    ledger.finishOperation(operationId, 'completed', {
      ...trace, finishedAt: now(), workerResultId: result.id, workerResultSha256: hash(json(result)),
      outcome: result.outcome, sourceRevision: result.sourceRevision
    });
    return result;
  } catch (error) {
    ledger.finishOperation(operationId, 'failed', { ...trace, finishedAt: now(), error: safeError(error) });
    throw error;
  }
}

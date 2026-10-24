import { requireThat, safeError } from './common.js';
import { failureDetails } from './failure-details.js';
import { captureArtifact, digest, loopOperation, readLoopArtifact } from './loop-controller.js';

// Local rule-based diagnosis: no source, model, worker, repair or adoption effects.
// A fixed snapshot is the review identity, not the number of trigger deliveries.
export function reviewLoopFailure(ledger, pins, failure, evidence = null) {
  const snapshot = { format: 'loop-failure-snapshot-v1', pins, failure, evidence };
  const id = failure.runId + ':failure-review:' + digest(snapshot);
  try {
    const prior = loopOperation(ledger, id);
    if (prior?.detail.result) {
      prior.detail.result.artifacts.forEach(a => readLoopArtifact(ledger, a));
      return prior.detail.result;
    }
    for (const receipt of failure.receipts ?? [])
      receipt.artifacts.forEach(a => readLoopArtifact(ledger, a));
    for (const artifact of evidence?.artifacts ?? []) readLoopArtifact(ledger, artifact);
    const details = failureDetails(failure);
    const throttled = failure.stage === 'collect' && details.statusCode === 429;
    const diagnosis = throttled
      ? 'A source returned HTTP 429; collection coverage remains incomplete.'
      : 'The admitted ' + failure.stage + ' stage did not produce a verified successful receipt.';
    const proposal = throttled
      ? 'Propose a separately authorized bounded continuation of the confirmed rejected read, honoring server retry timing and existing call/time limits; retain predecessor receipts and old-thread reply coverage.'
      : 'Inspect the original stage operation and referenced receipts, reconcile its existing execution, and propose a targeted change after identifying the cause; never relaunch an uncertain effect.';
    const value = { format: 'loop-failure-review-v1', method: 'deterministic-rules-v1',
      snapshotSha256: digest(snapshot), diagnosis, details,
      uncertainties: [throttled ? 'The service quota and whether waiting resolves it are unknown.'
        : 'The root cause and any unrecorded external outcome remain unknown.'],
      proposal, acceptanceTests: ['The original loop remains blocked and partial coverage is not released.',
        'Repeated triggers and lost acknowledgments do not duplicate source or model effects.',
        'Status and retry timing survive all reporting boundaries; no cursor advance or automatic retry.'],
      lifecycle: { capture: 'complete', diagnosis: 'complete', proposal: 'proposed',
        execution: 'not-authorized', evaluation: 'not-run', adoption: 'not-run' },
      actualUsage: { sourceCalls: 0, modelSessions: 0, workerSessions: 0 },
      remainingBudget: 'Existing reservations remain consumed or reserved; this review releases none.' };
    return ledger.transaction(() => {
      requireThat(!loopOperation(ledger, id), 'Failure review already reserved', 'blocked-reconciliation');
      ledger.operation(id, failure.runId, 'loop-failure-review', { snapshotSha256: digest(snapshot) });
      const result = { state: 'diagnosed-and-proposed', method: value.method, operationId: id,
        artifacts: [captureArtifact(ledger, snapshot), captureArtifact(ledger, value)] };
      ledger.finishOperation(id, 'recorded', { snapshotSha256: digest(snapshot), result });
      return result;
    });
  } catch (error) {
    // Never replace the producer failure or recursively review a review failure.
    return { state: 'blocked', operationId: id, ...safeError(error) };
  }
}

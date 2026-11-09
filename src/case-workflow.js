import { hash, json, now, requireThat } from './common.js';
import { approvedCaseBatch, completedOperation, operationRow } from './case-generation.js';
import { requireGeneratedCaseLineage } from './case-lineage.js';
import { readCurrentTestRequest } from './ado-test-request.js';
import { runTestRequest } from './test-request-flow.js';

export async function runGeneratedCaseRequest(config, ledger, batchId, caseId, options = {}, dependencies = {}) {
  requireThat(options.authorizeReview === true && (!options.execute ||
    options.authorizeCommit && options.authorizePush && options.authorizeDraftPR),
  'Generated request review and execution need independent explicit grants', 'blocked-authorization');
  const { batch } = approvedCaseBatch(config, ledger, batchId);
  requireThat(batch.draft.cases.some(item => item.id === caseId), 'Unknown generated case', 'blocked-scope');
  const receipt = completedOperation(ledger, `${batchId}:publication:${caseId}`, 'case-publication');
  const current = await (dependencies.read ?? readCurrentTestRequest)(config, receipt.itemId);
  requireGeneratedCaseLineage(config, ledger, current, { execution: true });
  const id = `${batchId}:intake:${caseId}`;
  const lineage = { batchId, caseId, publicationSha256: hash(json(receipt)) };
  if (!operationRow(ledger, id)) {
    ledger.operation(id, batchId, 'case-request-lineage', {});
    ledger.finishOperation(id, 'complete', lineage);
  }
  const outcome = await runTestRequest(config, ledger, receipt.itemId, options, dependencies);
  const resultId = `${batchId}:workflow2:${caseId}`;
  const result = { format: 'case-workflow2-receipt-v1', caseId, state: outcome.state,
    intakeId: outcome.intakeId, assignmentId: outcome.assignmentId ?? null,
    publication: outcome.publication ?? 'none', observedAt: now() };
  if (!operationRow(ledger, resultId)) ledger.operation(resultId, batchId, 'case-workflow2-result', {});
  ledger.finishOperation(resultId, 'complete', result);
  return outcome;
}

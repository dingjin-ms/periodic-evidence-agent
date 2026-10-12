import { hash, json, requireThat } from './common.js';
import { readAgencyRequest, previewAgencyResult, selectAgency, validateFilterAnalysisPolicy,
  recordAgencyPolicyEvaluation, filterCandidateSourcesMatch } from './agency-executor.js';
import { checkFilterBatchResult, consolidateFilterBatches } from './filter-batches.js';

export function evaluateFilterExecution(config, ledger, manifest, taskId, resultBytes, input, policy) {
  const request = readAgencyRequest(ledger, taskId);
  requireThat(request, 'Missing immutable FILTER request', 'blocked-reconciliation');
  const s = request.selection;
  validateFilterAnalysisPolicy(policy, s);
  const result = JSON.parse(resultBytes), checked = checkFilterBatchResult(config, manifest, result);
  const batch = manifest.batches.find(b => b.id === taskId), wire = JSON.parse(request.request);
  requireThat(batch && result.batchId === taskId && checked.resultSha256 === hash(resultBytes) &&
    checked.state === 'checked-not-qualified' && result.status === 'complete' &&
    batch.payload === wire.prompt && batch.payloadSha256 === s.payloadSha256 &&
    batch.analysisPayloadSha256 === s.analysisPayloadSha256 &&
    hash(manifest.request.instructions) === s.instructionsSha256,
  'Policy evaluation requires complete exact original manifest/request/result binding', 'blocked-reconciliation');
  requireThat(filterCandidateSourcesMatch(s, result),
    'Candidate repository or source revision differs from actual execution source', 'blocked-reconciliation');
  const integrity = { policy, manifestSha256: hash(`${JSON.stringify(manifest, null, 2)}\n`),
    payloadSha256: batch.payloadSha256, analysisPayloadSha256: batch.analysisPayloadSha256 };
  const verdict = previewAgencyResult(ledger, taskId, input, { policy, integrity, analysisCheck: checked });
  return { format: 'filter-policy-evaluation-v1', policy, policySha256: hash(json(policy)), taskId,
    evaluatedAt: input.observedAt, requestSha256: request.requestSha256,
    jobId: request.submission.jobId, manifestSha256: integrity.manifestSha256,
    payloadSha256: batch.payloadSha256, analysisPayloadSha256: batch.analysisPayloadSha256,
    resultSha256: checked.resultSha256,
    historicalTerminalSha256: request.terminal ? hash(json(request.terminal)) : null,
    historicalCompliance: false, inputSha256: hash(json(input)), input, verdict };
}
export function recordFilterExecutionEvaluation(config, ledger, manifest, taskId, resultBytes, input, policy) {
  const evaluation = evaluateFilterExecution(config, ledger, manifest, taskId, resultBytes, input, policy);
  return recordAgencyPolicyEvaluation(ledger, taskId, evaluation);
}
export function reconcileFilterExecutionCohort(config, ledger, manifest, resultBytes, policy = null) {
  requireThat(Array.isArray(resultBytes) && resultBytes.every(value => typeof value === 'string'),
    'FILTER execution reconciliation requires exact result bytes', 'invalid-record');
  const results = resultBytes.map(bytes => {
    const result = JSON.parse(bytes), checked = checkFilterBatchResult(config, manifest, result);
    requireThat(checked.resultSha256 === hash(bytes),
      'FILTER result bytes must match their canonical membership check', 'blocked-result');
    return { result, checked };
  });
  const consolidation = consolidateFilterBatches(config, manifest, results.map(value => value.result));
  ledger.db.exec('SAVEPOINT filter_execution_snapshot');
  try {
    const batches = manifest.batches.map(batch => {
      const matching = results.filter(value => value.result.batchId === batch.id);
      const request = readAgencyRequest(ledger, batch.id);
      const blocked = reason => ({ batchId: batch.id, state: 'blocked', reasons: [reason] });
      if (policy && request) {
        validateFilterAnalysisPolicy(policy, request.selection);
        const evaluations = ledger.db.prepare(
          "SELECT body FROM agency_receipts WHERE task_id=? AND kind LIKE 'policy-evaluation:%'")
          .all(batch.id).map(row => JSON.parse(row.body)).filter(e => json(e.policy) === json(policy));
        if (!matching.length || !evaluations.length)
          return blocked('Missing result or append-only policy evaluation');
        const latest = evaluations.sort((a, b) => a.evaluatedAt.localeCompare(b.evaluatedAt)).at(-1);
        if (evaluations.some(e => e.evaluatedAt === latest.evaluatedAt && json(e) !== json(latest)))
          return blocked('Conflicting policy evaluations at the same observation time');
        if (matching.some(value => value.checked.resultSha256 !== latest.resultSha256))
          return blocked('Result differs from policy evaluation');
        const current = evaluateFilterExecution(config, ledger, manifest, batch.id,
          resultBytes[results.indexOf(matching[0])], latest.input, policy);
        if (json(current) !== json(latest)) return blocked('Policy evaluation no longer reproduces');
        return { batchId: batch.id, state: current.verdict.state, reasons: current.verdict.reasons,
          jobId: current.jobId, resultSha256: current.resultSha256,
          analysisPassed: current.verdict.analysisPassed, publicationPassed: current.verdict.publicationPassed,
          assuranceLimitations: current.verdict.assuranceLimitations };
      }
      if (!matching.length || !request?.terminal)
        return blocked('Missing result or immutable terminal execution receipt');
      const selection = selectAgency(config, batch.id);
      const s = request.selection, wire = JSON.parse(request.request);
      if (!selection || json(selection) !== json(s) || s.role !== 'filter' || s.resultKind !== 'analysis' ||
        s.allowPush !== false || (!s.captureVerification && !s.analysisPolicy) || s.payloadSha256 !== batch.payloadSha256 ||
        s.analysisPayloadSha256 !== batch.analysisPayloadSha256 ||
        s.instructionsSha256 !== hash(manifest.request.instructions) ||
        request.requestSha256 !== hash(request.request) || wire.prompt !== batch.payload)
        return blocked('Reserved execution differs from the selected source/profile/manifest contract');
      const terminal = request.terminal;
      if (matching.some(value => value.checked.state !== 'checked-not-qualified' ||
        value.result.status !== 'complete' || value.checked.resultSha256 !== terminal.receipt.analysis?.resultSha256 ||
        value.checked.payloadSha256 !== terminal.receipt.analysis?.payloadSha256 ||
        value.checked.validator !== terminal.receipt.analysis?.validator))
        return blocked('Supplied complete result differs from the immutable execution analysis receipt');
      if (matching.some(value => !filterCandidateSourcesMatch(s, value.result)))
        return blocked('Candidate repository or source revision differs from actual execution source');
      const verdict = previewAgencyResult(ledger, batch.id, terminal.receipt);
      if (json(verdict) !== json(terminal.verdict))
        return blocked('Current execution grading differs from the immutable terminal verdict');
      return { batchId: batch.id, state: verdict.state, reasons: verdict.reasons,
        jobId: request.submission.jobId, resultSha256: matching[0].checked.resultSha256,
        analysisPassed: verdict.analysisPassed, publicationPassed: verdict.publicationPassed };
    });
    const complete = consolidation.state === 'complete-held' &&
      batches.every(batch => batch.state === 'completed' && batch.analysisPassed === true);
    return { format: 'source-bound-filter-cohort-v1', state: complete ? 'complete-held' : 'blocked',
      dispatchAllowed: false, cohortId: manifest.cohortId, manifestSha256: consolidation.manifestSha256,
      structuralState: consolidation.state, batches, consolidation: complete ? consolidation : null,
      sourceCoverageComplete: null, semanticReadingProvenByHelper: false,
      ...(policy ? { analysisPolicy: policy, historicalCompliance: false } : {}) };
  } finally {
    ledger.db.exec('RELEASE filter_execution_snapshot');
  }
}

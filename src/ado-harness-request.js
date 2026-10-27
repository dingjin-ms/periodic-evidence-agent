import { hash, json, requireThat, utc, PilotError } from './common.js';
import { adoAccessToken } from './ado-auth.js';
import { readTestRequest, selectedItem, testRequestPolicy, testRequestPolicySha256 } from './ado-test-request.js';
import { resolveSkillBinding, skillQualificationId, repositorySkillWritePrefixes, repositorySkillWriteFiles } from './repository-skills.js';

export const harnessRequestTag = 'AgenticHarnessRequest';
const assessmentKind = 'ado-test-request-capability';
const operation = (ledger, id) => ledger.status().operations.find(row => row.id === id);
export function testRequestReceipt(ledger, id) {
  const row = operation(ledger, id);
  requireThat(row?.kind === 'ado-test-request-intake' && row.state === 'complete',
    'Test-request intake is absent or incomplete', 'blocked-reconciliation');
  return JSON.parse(row.detail);
}
export function harnessPolicy(config) {
  const policy = testRequestPolicy(config).harnessSupport;
  requireThat(policy?.enabled === true && policy.scopeApproved === true && policy.approvalRef?.trim(),
    'Harness support requires its own approved policy', 'blocked-authorization');
  requireThat(policy.capability === 'e2e-harness-authoring' && policy.requestedOutcome === 'extend-e2e-harness',
    'Harness support requires a separate harness-only capability and outcome', 'blocked-config');
  return policy;
}
function assessmentKey(evidence) {
  const namespace = evidence.scopeId.endsWith(':harness')
    ? evidence.source.namespace.replace(/\/harness$/, '') : evidence.source.namespace;
  return `test-capability-${hash(json([namespace, evidence.source.recordId]))}`;
}
export function currentCapabilityAssessment(ledger, evidence) {
  const rows = ledger.status().operations.filter(row => row.kind === assessmentKind && row.state === 'complete');
  return rows.map(row => JSON.parse(row.detail)).filter(row => row.key === assessmentKey(evidence))
    .sort((a, b) => b.sequence - a.sequence)[0] ?? null;
}
export function requireCoverageCapability(config, ledger, evidence, sourceRevision) {
  const assessment = currentCapabilityAssessment(ledger, evidence);
  if (!assessment && config.adoTestRequests.harnessSupport?.enabled !== true) return;
  requireThat(assessment?.decision === 'supported' && assessment.evidenceId === evidence.id &&
    assessment.sourceRevision === sourceRevision,
  'Coverage is held until a current supported harness assessment is recorded', 'blocked-harness');
}
export function recordCapabilityAssessment(config, ledger, input) {
  const keys = ['format', 'intakeId', 'intakeSha256', 'sourceRevision', 'reviewedAt', 'reviewer',
    'decision', 'missingCapabilities', 'sourcePaths', 'rationale', 'verificationEvidence'];
  requireThat(input && Object.keys(input).length === keys.length && keys.every(key => Object.hasOwn(input, key)) &&
    input.format === 'ado-test-request-capability-v1', 'Invalid capability assessment', 'invalid-record');
  requireThat(['supported', 'needs-harness', 'needs-evidence', 'blocked-environment'].includes(input.decision),
    'Invalid capability decision', 'invalid-record');
  for (const key of ['reviewer', 'rationale']) requireThat(typeof input[key] === 'string' && input[key].trim() &&
    input[key].length <= 4000, `Capability assessment needs bounded ${key}`, 'invalid-record');
  for (const key of ['missingCapabilities', 'sourcePaths', 'verificationEvidence']) requireThat(Array.isArray(input[key]) &&
    input[key].length <= 30 && input[key].every(value => typeof value === 'string' && value.trim() && value.length <= 2000),
  `Invalid capability assessment ${key}`, 'invalid-record');
  requireThat(input.decision === 'needs-harness' ? input.missingCapabilities.length > 0 : input.missingCapabilities.length === 0,
    'Only a proven harness gap may declare missing capabilities', 'invalid-record');
  requireThat(/^[a-f0-9]{40,64}$/.test(input.sourceRevision) && input.sourcePaths.length > 0,
    'Capability assessment requires inspected source paths and revision', 'invalid-record');
  const policy = testRequestPolicy(config);
  requireThat(config.statePolicy.accessApproved === true, 'Capability review requires approved local state');
  const receipt = testRequestReceipt(ledger, input.intakeId);
  requireThat(!receipt.harness && receipt.state === 'needs-review' && receipt.policySha256 === testRequestPolicySha256(policy) &&
    input.intakeSha256 === hash(json(receipt)), 'Capability review intake changed or is incomplete', 'blocked-reconciliation');
  const evidence = ledger.get('evidence', receipt.evidenceId);
  requireThat(ledger.latestEvidence().some(row => row.id === evidence.id), 'Capability review was superseded', 'blocked-reconciliation');
  utc(input.reviewedAt);
  requireThat(Date.parse(input.reviewedAt) >= Date.parse(evidence.observedAt) && Date.parse(input.reviewedAt) <= Date.now(),
    'Capability review timestamp is stale or in the future');
  const { binding } = resolveSkillBinding(config, policy.repoId, policy.capability);
  requireThat(ledger.qualification(skillQualificationId(policy.repoId, binding.id))?.baseRevision === input.sourceRevision,
    'Capability review must match the qualified harness revision', 'blocked-reconciliation');
  const id = `capability-review-${hash(json(input))}`;
  const comparable = value => json(Object.fromEntries(keys.filter(key => key !== 'reviewedAt')
    .map(key => [key, value[key]])));
  return ledger.transaction(() => {
    const prior = operation(ledger, id);
    const previous = currentCapabilityAssessment(ledger, evidence);
    const freshnessId = previous ? `${previous.id}:latest-review` : null;
    const freshness = freshnessId && operation(ledger, freshnessId);
    const latestReviewedAt = freshness ? JSON.parse(freshness.detail).reviewedAt : previous?.reviewedAt;
    if (previous && comparable(previous) === comparable(input) &&
      Date.parse(input.reviewedAt) >= Date.parse(latestReviewedAt)) {
      if (!freshness) ledger.operation(freshnessId, receipt.id, 'ado-capability-review-freshness', {});
      ledger.finishOperation(freshnessId, 'complete', { reviewedAt: input.reviewedAt });
      return previous;
    }
    if (prior?.state === 'complete') {
      requireThat(previous?.id === id, 'Capability assessment was superseded', 'blocked-reconciliation');
      return JSON.parse(prior.detail);
    }
    if (previous) {
      requireThat(Date.parse(input.reviewedAt) > Date.parse(latestReviewedAt),
        'Capability review must advance its timestamp', 'blocked-reconciliation');
      const gaps = ledger.status().operations.filter(row => row.kind === assessmentKind && row.state === 'complete')
        .map(row => JSON.parse(row.detail)).filter(row => row.key === previous.key && row.decision === 'needs-harness');
      if (gaps.length && input.decision === 'supported')
        requireThat(gaps.every(gap => input.sourceRevision !== gap.sourceRevision) && input.verificationEvidence.length > 0,
          'Resuming coverage requires a new harness revision and verification evidence', 'blocked-harness');
    }
    const result = { ...structuredClone(input), id, key: assessmentKey(evidence), evidenceId: evidence.id,
      sequence: (previous?.sequence ?? 0) + 1 };
    ledger.operation(id, receipt.id, assessmentKind, result);
    ledger.finishOperation(id, 'complete', result);
    return result;
  });
}
export function requireHarnessRequest(config, ledger, receipt) {
  const policy = harnessPolicy(config);
  const evidence = ledger.get('evidence', receipt.evidenceId);
  const assessment = currentCapabilityAssessment(ledger, evidence);
  const original = testRequestReceipt(ledger, receipt.originalIntakeId ?? receipt.id);
  requireThat(ledger.latestEvidence().some(row => row.id === original.evidenceId) &&
    original.policySha256 === testRequestPolicySha256(testRequestPolicy(config)) &&
    (!receipt.assessmentId || receipt.assessmentId === assessment?.id),
  'Harness source or assessment was superseded', 'blocked-reconciliation');
  requireThat(assessment?.decision === 'needs-harness' && assessment.intakeId === (receipt.originalIntakeId ?? receipt.id) &&
    assessment.intakeSha256 === hash(json(original)),
    'Harness authoring requires a current source-bound capability gap', 'blocked-harness');
  requireThat(evidence.fields['System.Tags'].split(';').map(tag => tag.trim()).includes(harnessRequestTag),
    `Harness work requires the exact ${harnessRequestTag} tag`, 'blocked-authorization');
  const { repo, binding } = resolveSkillBinding(config, testRequestPolicy(config).repoId, policy.capability);
  requireThat(!binding.inputFormat && (binding.authoringProvider ?? 'copilot-sdk') === 'copilot-sdk',
    'Harness authoring currently requires the bounded local SDK worker', 'blocked-config');
  const coverage = resolveSkillBinding(config, repo.id, testRequestPolicy(config).capability).binding;
  const paths = value => [...repositorySkillWritePrefixes(repo, value), ...repositorySkillWriteFiles(repo, value)]
    .map(path => path.toLowerCase());
  const coveragePaths = paths(coverage);
  requireThat(paths(binding).every(path => coveragePaths.every(other =>
    path !== other && !path.startsWith(`${other}/`) && !other.startsWith(`${path}/`))),
  'Harness and coverage write bounds must not overlap', 'blocked-scope');
  return { policy, assessment };
}
const escapeHtml = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
export function capabilityComment(assessment) {
  requireThat(assessment.decision === 'needs-harness', 'Only proven harness gaps may publish unsupported notices');
  return `<p>This E2E case is not yet supported by the test harness. This is not a claim that the product functionality is unsupported.</p>` +
    `<ul>${assessment.missingCapabilities.map(gap => `<li>${escapeHtml(gap)}</li>`).join('')}</ul>` +
    `<p>No coverage PR will be proposed while this gap remains. Add <code>${harnessRequestTag}</code> to request the agentic system to author a separate harness-support Draft PR with validation tests. After integration and verification, the original case will be reassessed for coverage.</p>` +
    `<p>Reviewed harness revision: ${assessment.sourceRevision}. Receipt: ${assessment.id}.</p>`;
}
function requireFeedbackPolicy(config, authorized) {
  requireThat(config.statePolicy?.accessApproved === true,
    'ADO feedback requires approved local state', 'blocked-authorization');
  const policy = testRequestPolicy(config);
  requireThat(authorized && policy.feedback?.enabled === true && policy.feedback.scopeApproved === true &&
    policy.feedback.approvalRef?.trim(), 'ADO feedback requires explicit comment authorization and approved policy', 'blocked-authorization');
  return policy;
}
function feedbackRequestKey(ledger, row) {
  const detail = JSON.parse(row.detail);
  if (detail.requestKey) return detail.requestKey;
  const receipt = testRequestReceipt(ledger, row.job_id);
  return assessmentKey(ledger.get('evidence', receipt.evidenceId));
}
function requireNoUncertainFeedback(ledger, requestKey) {
  const uncertain = ledger.status().operations.find(row => row.kind === 'ado-test-request-feedback' &&
    row.state === 'started' && feedbackRequestKey(ledger, row) === requestKey);
  requireThat(!uncertain, `ADO comment outcome is uncertain (${uncertain?.id}); reconcile before any publication for this request`,
    'blocked-reconciliation');
}
export function reconcileCapabilityComment(config, ledger, input, { authorizeReconciliation = false } = {}) {
  const policy = requireFeedbackPolicy(config, authorizeReconciliation);
  const keys = ['operationId', 'expectedOperationSha256', 'disposition', 'commentId', 'reviewer', 'reviewedAt', 'evidenceRef'];
  requireThat(input && Object.keys(input).length === keys.length && keys.every(key => Object.hasOwn(input, key)) &&
    ['posted', 'not-posted'].includes(input.disposition) &&
    ['reviewer', 'evidenceRef'].every(key => typeof input[key] === 'string' && input[key].trim() && input[key].length <= 2000) &&
    (input.disposition === 'posted' ? Number.isSafeInteger(input.commentId) && input.commentId > 0 : input.commentId === null),
  'Feedback reconciliation requires an exact operation and documented human inspection', 'invalid-record');
  utc(input.reviewedAt);
  return ledger.transaction(() => {
    const row = operation(ledger, input.operationId);
    requireThat(row?.kind === 'ado-test-request-feedback' && row.state === 'started' &&
      hash(json(row)) === input.expectedOperationSha256 && Date.parse(input.reviewedAt) >= Date.parse(row.updated_at) &&
      Date.parse(input.reviewedAt) <= Date.now(), 'Feedback operation changed or reconciliation is stale', 'blocked-reconciliation');
    const receipt = testRequestReceipt(ledger, row.job_id);
    const evidence = ledger.get('evidence', receipt.evidenceId);
    requireThat(receipt.policySha256 === testRequestPolicySha256(policy), 'Feedback scope changed', 'blocked-scope');
    selectedItem({ id: Number(evidence.source.recordId), rev: Number(evidence.source.revision), fields: evidence.fields },
      Number(evidence.source.recordId), policy);
    const result = { ...JSON.parse(row.detail), state: input.disposition === 'posted' ? 'commented' : 'not-posted',
      workItemId: Number(evidence.source.recordId), commentId: input.commentId, reconciliation: structuredClone(input) };
    ledger.finishOperation(row.id, input.disposition === 'posted' ? 'complete' : 'not-posted', result);
    return result;
  });
}
function validatedHarnessResult(ledger, assignmentId) {
  const assignment = ledger.get('assignment', assignmentId);
  requireThat(assignment?.capability === 'e2e-harness-authoring', 'Feedback assignment is not harness work');
  const result = ledger.all('workerResult').find(result => result.assignmentId === assignmentId &&
    result.outcome === 'draft-pr-validated' && result.draftPR?.isDraft === true &&
    result.draftPR.headRevision === result.sourceRevision);
  requireThat(result, 'Harness Draft PR has not been validated', 'blocked-reconciliation');
  return { assignment, result };
}
export async function reconcileHarnessAssociation(config, ledger, input, {
  authorizeReconciliation = false, read = readTestRequest
} = {}) {
  const policy = requireFeedbackPolicy(config, authorizeReconciliation);
  const keys = ['assignmentId', 'assessmentId', 'reviewer', 'reviewedAt', 'evidenceRef'];
  requireThat(input && Object.keys(input).length === keys.length && keys.every(key =>
    typeof input[key] === 'string' && input[key].trim() && input[key].length <= 2000),
  'Harness association requires exact work, assessment and review evidence', 'invalid-record');
  utc(input.reviewedAt);
  const { assignment, result } = validatedHarnessResult(ledger, input.assignmentId);
  const harnessReceipt = testRequestReceipt(ledger, ledger.get('evidence', assignment.evidenceIds[0]).scopeId);
  const original = testRequestReceipt(ledger, harnessReceipt.originalIntakeId);
  const oldEvidence = ledger.get('evidence', original.evidenceId);
  const assessment = currentCapabilityAssessment(ledger, oldEvidence);
  requireThat(assessment?.id === input.assessmentId && assessment.decision === 'needs-harness' &&
    Date.parse(input.reviewedAt) >= Date.parse(assessment.reviewedAt) && Date.parse(input.reviewedAt) <= Date.now(),
  'Harness association assessment changed or review is stale', 'blocked-reconciliation');
  const priorAssessment = JSON.parse(operation(ledger, harnessReceipt.assessmentId).detail);
  const receipt = testRequestReceipt(ledger, assessment.intakeId);
  const evidence = ledger.get('evidence', receipt.evidenceId);
  const invariantFields = fields => Object.fromEntries(Object.entries(fields).filter(([key]) => key !== 'System.Title'));
  requireThat(original.policySha256 === testRequestPolicySha256(policy) && receipt.policySha256 === original.policySha256 &&
    assessmentKey(evidence) === assessmentKey(oldEvidence) &&
    json(invariantFields(evidence.fields)) === json(invariantFields(oldEvidence.fields)) &&
    assessment.sourceRevision === priorAssessment.sourceRevision &&
    json([...assessment.missingCapabilities].sort()) === json([...priorAssessment.missingCapabilities].sort()),
  'Harness association may only reconcile a title-only revision with the same capability gap and policy', 'blocked-reconciliation');
  const raw = await read(config, Number(evidence.source.recordId));
  requireThat(Buffer.byteLength(json(raw)) <= policy.maxResponseBytes &&
    hash(json(selectedItem(raw, Number(evidence.source.recordId), policy))) === receipt.captureSha256,
  'ADO request changed before harness association', 'blocked-reconciliation');
  const id = `harness-feedback-association-${hash(json([input.assignmentId, input.assessmentId]))}`;
  return ledger.transaction(() => {
    requireThat(currentCapabilityAssessment(ledger, evidence)?.id === assessment.id &&
      ledger.latestEvidence().some(row => row.id === evidence.id), 'Harness association was superseded', 'blocked-reconciliation');
    const previous = operation(ledger, id);
    if (previous?.state === 'complete') return JSON.parse(previous.detail);
    const association = { ...structuredClone(input), resultId: result.id, captureSha256: receipt.captureSha256 };
    ledger.operation(id, assignment.id, 'ado-harness-feedback-association', association);
    ledger.finishOperation(id, 'complete', association);
    return association;
  });
}
export async function publishCapabilityComment(config, ledger, assessmentId, {
  authorizeComment = false, retryRejected = false, assignmentId = null,
  read = readTestRequest, getToken = adoAccessToken, fetchResponse = fetch
} = {}) {
  const policy = requireFeedbackPolicy(config, authorizeComment);
  const row = operation(ledger, assessmentId);
  requireThat(row?.kind === assessmentKind && row.state === 'complete', 'Unknown capability assessment');
  const assessment = JSON.parse(row.detail);
  const receipt = testRequestReceipt(ledger, assessment.intakeId);
  const evidence = ledger.get('evidence', receipt.evidenceId);
  requireThat(currentCapabilityAssessment(ledger, evidence)?.id === assessmentId &&
    receipt.policySha256 === testRequestPolicySha256(policy), 'Capability feedback was superseded', 'blocked-reconciliation');
  let text = capabilityComment(assessment);
  if (assignmentId) {
    const { assignment, result } = validatedHarnessResult(ledger, assignmentId);
    const harnessReceipt = testRequestReceipt(ledger, ledger.get('evidence', assignment.evidenceIds[0]).scopeId);
    const associationRow = operation(ledger, `harness-feedback-association-${hash(json([assignmentId, assessmentId]))}`);
    const association = associationRow?.state === 'complete' ? JSON.parse(associationRow.detail) : null;
    requireThat(harnessReceipt.assessmentId === assessmentId || (association?.resultId === result.id &&
      association.captureSha256 === receipt.captureSha256),
    'Harness result needs source-checked association reconciliation for this assessment', 'blocked-reconciliation');
    text = `<p>The agentic system proposed a separate harness-support Draft PR: ${escapeHtml(result.draftPR.url)}.</p>` +
      `<p>Coverage remains held pending human review, integration and harness qualification. Receipt: ${assessmentId}.</p>`;
  }
  const id = `test-request-comment-${hash(json([assessment.key, evidence.source.revision,
    assessment.sourceRevision, [...assessment.missingCapabilities].sort(), assignmentId]))}`;
  const previous = operation(ledger, id);
  if (previous?.state === 'complete') return JSON.parse(previous.detail);
  requireNoUncertainFeedback(ledger, assessment.key);
  if (previous) requireThat(retryRejected && ['rejected', 'not-posted'].includes(previous.state),
    'ADO comment was rejected or reconciled not-posted; explicit --retry-rejected is required', 'blocked-authorization');
  requireThat(Buffer.byteLength(text, 'utf8') <= 65536, 'ADO feedback comment exceeded its bound', 'blocked-budget');
  const token = await getToken(config, 'ADO test-request feedback');
  const raw = await read(config, Number(evidence.source.recordId));
  requireThat(Buffer.byteLength(json(raw)) <= policy.maxResponseBytes, 'ADO request exceeded its feedback read bound', 'partial');
  const current = selectedItem(raw, Number(evidence.source.recordId), policy);
  requireThat(hash(json(current)) === receipt.captureSha256, 'ADO request changed before feedback; recollect and review', 'blocked-reconciliation');
  ledger.transaction(() => {
    requireThat(testRequestPolicySha256(requireFeedbackPolicy(config, authorizeComment)) === receipt.policySha256,
      'Feedback policy changed before publication', 'blocked-reconciliation');
    requireThat(currentCapabilityAssessment(ledger, evidence)?.id === assessmentId &&
      ledger.latestEvidence().some(row => row.id === evidence.id),
    'Capability feedback was superseded during its source read', 'blocked-reconciliation');
    requireNoUncertainFeedback(ledger, assessment.key);
    const currentOperation = operation(ledger, id);
    requireThat(json(currentOperation) === json(previous), 'Feedback operation changed during source read', 'blocked-reconciliation');
    const detail = { assessmentId, requestKey: assessment.key,
      attempts: previous ? (JSON.parse(previous.detail).attempts ?? 1) + 1 : 1,
      ...(previous ? { prior: { state: previous.state, detail: JSON.parse(previous.detail) } } : {}) };
    if (previous) ledger.finishOperation(id, 'started', detail);
    else ledger.operation(id, receipt.id, 'ado-test-request-feedback', detail);
  });
  // Persist before the external write. A timeout/crash never permits a blind retry.
  try {
    const url = `https://dev.azure.com/${encodeURIComponent(policy.organization)}/${encodeURIComponent(policy.project)}/_apis/wit/workItems/${evidence.source.recordId}/comments?format=html&api-version=7.1-preview.4`;
    const response = await fetchResponse(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: json({ text }) });
    if ([401, 403].includes(response.status)) {
      ledger.finishOperation(id, 'rejected', { ...JSON.parse(operation(ledger, id).detail), status: response.status });
      throw new PilotError('blocked-auth', `ADO feedback rejected with HTTP ${response.status}; restore authorization, then use --retry-rejected`);
    }
    requireThat(response.ok, `ADO feedback returned HTTP ${response.status}`, 'failed-source');
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      requireThat(size <= policy.maxResponseBytes, 'ADO feedback response exceeded its bound', 'partial');
      chunks.push(chunk);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requireThat(Number.isSafeInteger(result.id) && result.id > 0 && result.workItemId === current.id,
      'ADO comment acknowledgement is invalid', 'blocked-reconciliation');
    const receipt = { ...JSON.parse(operation(ledger, id).detail), state: 'commented',
      assessmentId, workItemId: current.id, commentId: result.id };
    ledger.finishOperation(id, 'complete', receipt);
    return receipt;
  } catch (error) {
    if (operation(ledger, id)?.state === 'rejected') throw error;
    throw new PilotError('blocked-reconciliation', 'ADO comment outcome is uncertain; inspect the receipt marker on the work item before reconciliation. No automatic repost.');
  }
}

import { hash, json, now, positive, requireThat, utc } from './common.js';
import { captureVerificationProtocol, verifyFilterCaptureInput, requiredFilterCaptureIds } from './filter-capture-verifier.js';
import { validateFilterManifest } from './filter-batches.js';

const digest = /^[a-f0-9]{64}$/;
const revision = /^[a-f0-9]{40,64}$/;
const text = value => typeof value === 'string' && value.trim().length > 0;
const analysisPayloadHash = selection => selection.analysisPayloadSha256 ?? selection.payloadSha256;
const digestInputEvidence = 'source-bound-stdin-digest-v1';
export function validateFilterAnalysisPolicy(policy, selection) {
  shape(policy, ['id', 'approvedBy', 'approvedAt', 'approvalRef']);
  utc(policy.approvedAt);
  requireThat(policy.id === 'local-readonly-filter-v1' && text(policy.approvedBy) &&
    text(policy.approvalRef) && Date.parse(policy.approvedAt) <= Date.now() &&
    selection.role === 'filter' && selection.resultKind === 'analysis' && selection.allowPush === false,
  'Local analysis policy requires explicit approved read-only FILTER scope', 'blocked-scope');
  return policy;
}
function shape(value, keys, required = keys) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => keys.includes(key)) && required.every(key => Object.hasOwn(value, key)),
  'Invalid Agency derived contract shape; raw output and undeclared fields are forbidden', 'invalid-record');
}
function tables(ledger) {
  ledger.db.exec(`
    CREATE TABLE IF NOT EXISTS agency_requests(
      task_id TEXT PRIMARY KEY, budget_id TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agency_receipts(
      task_id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(task_id,kind));
    CREATE TRIGGER IF NOT EXISTS immutable_agency_request BEFORE UPDATE ON agency_requests
      BEGIN SELECT RAISE(ABORT,'Agency requests are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_agency_request_delete BEFORE DELETE ON agency_requests
      BEGIN SELECT RAISE(ABORT,'Agency requests are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_agency_receipt BEFORE UPDATE ON agency_receipts
      BEGIN SELECT RAISE(ABORT,'Agency receipts are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_agency_receipt_delete BEFORE DELETE ON agency_receipts
      BEGIN SELECT RAISE(ABORT,'Agency receipts are immutable'); END;
  `);
}
function stored(ledger, taskId, kind) {
  const row = ledger.db.prepare('SELECT body FROM agency_receipts WHERE task_id=? AND kind=?').get(taskId, kind);
  return row ? JSON.parse(row.body) : null;
}
function receipt(ledger, taskId, kind, value) {
  const old = stored(ledger, taskId, kind);
  requireThat(!old || json(old) === json(value), 'Immutable Agency receipt conflict', 'blocked-reconciliation');
  if (!old) ledger.db.prepare('INSERT INTO agency_receipts VALUES(?,?,?)').run(taskId, kind, json(value));
  return value;
}
export function selectAgency(config, taskId) {
  const selections = (config.agency?.selections ?? []).filter(s => s.taskId === taskId);
  requireThat(selections.length <= 1, 'Ambiguous Agency task selection');
  if (!selections.length) return null;
  const s = selections[0];
  const keys = ['taskId', 'repoId', 'role', 'suiteId', 'profileId', 'qualificationId', 'qualificationSha256',
    'sourceRevision', 'targetRef', 'payloadSha256', 'instructionsSha256', 'resultKind', 'allowPush',
    'dispatchAllowed', 'maxExecutionSeconds', 'allowedPaths', 'forbiddenPaths', 'caseContract'];
  shape(s, [...keys, 'analysisPayloadSha256', 'captureVerification', 'analysisPolicy'], keys);
  if (s.analysisPolicy) {
    validateFilterAnalysisPolicy(s.analysisPolicy, s);
    requireThat(!s.captureVerification, 'Select one explicit FILTER assurance policy', 'blocked-qualification');
  }
  if (s.captureVerification !== undefined) {
    const captureKeys = ['protocol', 'verifierSha256', 'pipelineDefinitionId', 'stepName',
      'pipelineSourceRevision', 'bootstrapSha256'];
    shape(s.captureVerification, [...captureKeys, 'inputEvidenceKind', 'agentProfileSha256',
      'sourceAttestationStepName'], captureKeys);
    if (Object.hasOwn(s.captureVerification, 'inputEvidenceKind')) requireThat(
      s.captureVerification.inputEvidenceKind === digestInputEvidence &&
      digest.test(s.captureVerification.agentProfileSha256) && text(s.captureVerification.sourceAttestationStepName) &&
      s.captureVerification.sourceAttestationStepName !== s.captureVerification.stepName,
      'Unsupported capture input evidence contract', 'blocked-qualification');
    else requireThat(!Object.hasOwn(s.captureVerification, 'agentProfileSha256') &&
      !Object.hasOwn(s.captureVerification, 'sourceAttestationStepName'),
      'A runner profile pin requires the explicit source-bound digest contract', 'blocked-qualification');
    requireThat(s.role === 'filter' && s.resultKind === 'analysis' && s.allowPush === false &&
      digest.test(s.analysisPayloadSha256) && s.captureVerification.protocol === captureVerificationProtocol &&
      digest.test(s.captureVerification.verifierSha256) && text(s.captureVerification.pipelineDefinitionId) &&
      text(s.captureVerification.stepName) && revision.test(s.captureVerification.pipelineSourceRevision) &&
      digest.test(s.captureVerification.bootstrapSha256),
    'Capture execution verification requires a pinned read-only FILTER envelope', 'blocked-qualification');
  }
  if (Object.hasOwn(s, 'analysisPayloadSha256')) requireThat(s.role === 'filter' && s.resultKind === 'analysis' &&
    digest.test(s.analysisPayloadSha256), 'Inner payload envelopes are restricted to hashed FILTER analysis', 'blocked-scope');
  requireThat(['collector', 'filter', 'proposer'].includes(s.role) &&
    ['analysis', 'validation'].includes(s.resultKind) && revision.test(s.sourceRevision) &&
    [s.payloadSha256, s.instructionsSha256, s.qualificationSha256].every(v => digest.test(v)) &&
    [s.taskId, s.repoId, s.suiteId, s.profileId, s.qualificationId, s.targetRef].every(text) &&
    typeof s.allowPush === 'boolean' && s.dispatchAllowed === true &&
    (!s.allowPush || (s.role === 'proposer' && s.resultKind === 'validation')) &&
    Array.isArray(s.allowedPaths) && Array.isArray(s.forbiddenPaths) &&
    [...s.allowedPaths, ...s.forbiddenPaths].every(safePath),
  'Agency selection must explicitly bind an authorized task, suite, source, profile and payload', 'blocked-qualification');
  positive(s.maxExecutionSeconds, 'Agency execution seconds');
  shape(s.caseContract, ['cases', 'scenarios', 'commands']);
  requireThat(Array.isArray(s.caseContract.cases) && Array.isArray(s.caseContract.scenarios) &&
    Array.isArray(s.caseContract.commands), 'Invalid Agency case contract');
  for (const c of s.caseContract.cases) {
    shape(c, ['suite', 'title', 'status']);
    requireThat(text(c.suite) && text(c.title) && ['passed', 'skipped'].includes(c.status), 'Invalid expected case');
  }
  requireThat(new Set(s.caseContract.cases.map(c => json([c.suite, c.title]))).size === s.caseContract.cases.length &&
    s.caseContract.scenarios.every(text) && new Set(s.caseContract.scenarios).size === s.caseContract.scenarios.length,
  'Duplicate case or scenario contract');
  for (const c of s.caseContract.commands) {
    shape(c, ['id', 'phase', 'command', 'cwd']);
    requireThat([c.id, c.command, c.cwd].every(text) &&
      ['build', 'test', 'coverage', 'hook'].includes(c.phase), 'Invalid command contract');
  }
  requireThat(new Set(s.caseContract.commands.map(c => c.id)).size === s.caseContract.commands.length,
    'Duplicate command contract');
  if (s.resultKind === 'validation') requireThat(s.caseContract.cases.some(c => c.status === 'passed') &&
    s.caseContract.scenarios.length > 0 && s.caseContract.commands.some(c => c.phase === 'test'),
  'Validation requires executing cases, commands and scenario proof', 'blocked-qualification');
  return structuredClone(s);
}
function safePath(path) {
  return text(path) && !/^(?:\/|\\|[a-z]:)/i.test(path) && !path.includes('\\') &&
    !path.split('/').some(p => ['', '.', '..', '.git'].includes(p));
}
export function agencyTaskId(assignment) {
  const marker = assignment.requiredCapabilities.find(c => c.startsWith('agency-task:'));
  requireThat(assignment.execution === 'hosted' && marker, 'Missing Agency task binding');
  return marker.slice('agency-task:'.length);
}
export function bindAgencyAssignment(config, assignment) {
  const selection = selectAgency(config, assignment.id);
  if (!selection) return assignment;
  requireThat(selection.repoId === assignment.repoId && selection.role === 'proposer' &&
    selection.allowPush === assignment.permissions.createDraftPR &&
    assignment.validationGates.every(id => selection.caseContract.commands.some(c => c.id === id)) &&
    (!assignment.skillQualification || assignment.skillQualification.baseRevision === selection.sourceRevision),
  'Agency selection conflicts with assignment permissions or source', 'blocked-qualification');
  assignment.execution = 'hosted';
  assignment.workspace.baseRevision = selection.sourceRevision;
  assignment.requiredCapabilities.push(`agency-task:${assignment.id}`, `agency-selection:${hash(json(selection))}`);
  assignment.id = `assignment-${hash(json([assignment.id, selection]))}`;
  return assignment;
}
export function requireAgencyQualification(config, ledger, taskId) {
  const selection = selectAgency(config, taskId);
  requireThat(selection, 'Task has no explicit Agency selection', 'blocked-qualification');
  const profile = config.agency?.profiles?.[selection.profileId];
  shape(profile, ['organization', 'project', 'repository', 'initMode']);
  requireThat([profile.organization, profile.project, profile.repository].every(text) && profile.initMode === 'lite',
    'Only an explicitly qualified existing Agency profile is supported', 'blocked-qualification');
  const q = ledger.qualification(selection.qualificationId);
  requireThat(q && hash(json(q)) === selection.qualificationSha256 && q.status === 'qualified',
    'Agency qualification is missing, changed or not positive', 'blocked-qualification');
  shape(q, ['status', 'binding', 'runtime', 'expiresAt', 'evidenceRef']);
  const binding = { repoId: selection.repoId, role: selection.role, suiteId: selection.suiteId,
    profileId: selection.profileId, profileSha256: hash(json(profile)), sourceRevision: selection.sourceRevision,
    targetRef: selection.targetRef, instructionsSha256: selection.instructionsSha256,
    caseContractSha256: hash(json(selection.caseContract)) };
  if (selection.captureVerification) binding.captureVerification = selection.captureVerification;
  if (selection.analysisPolicy) binding.analysisPolicy = selection.analysisPolicy;
  requireThat(json(q.binding) === json(binding) && text(q.evidenceRef),
    'Agency qualification does not cover this exact repository/task/suite/profile/source contract', 'blocked-qualification');
  utc(q.expiresAt);
  requireThat(Date.parse(q.expiresAt) > Date.now(), 'Agency qualification expired', 'blocked-qualification');
  shape(q.runtime, ['modelId', 'tokenizerId', 'contextTokens', 'maxOutputTokens', 'estimation'],
    ['modelId', 'tokenizerId', 'contextTokens', 'maxOutputTokens']);
  requireThat(text(q.runtime.modelId), 'Agency effective model must be verified');
  if (q.runtime.estimation) {
    const e = q.runtime.estimation;
    shape(e, ['approvalId', 'approvedBy', 'approvedAt', 'accountingMethod', 'planningCap', 'maxInputTokens',
      'instructionReserve', 'codeReserve', 'outputReserve', 'safetyReserve', 'requestOverheadReserve', 'uncertainty', 'maxConcurrent']);
    utc(e.approvedAt);
    requireThat(selection.role === 'filter' && selection.resultKind === 'analysis' && !selection.allowPush &&
      q.runtime.tokenizerId === null && q.runtime.contextTokens === null && q.runtime.maxOutputTokens === null &&
      [e.approvalId, e.approvedBy, e.uncertainty].every(text) &&
      Date.parse(e.approvedAt) <= Date.now() &&
      e.accountingMethod === 'utf8-byte-conservative-estimate-v1' && e.maxConcurrent === 2,
    'Estimated capacity requires explicit bounded FILTER-only trial approval; unknown capacity stays null', 'blocked-qualification');
    for (const key of ['planningCap', 'maxInputTokens', 'instructionReserve', 'codeReserve', 'outputReserve',
      'safetyReserve', 'requestOverheadReserve']) positive(e[key], key);
  } else {
    requireThat(text(q.runtime.tokenizerId), 'Agency tokenizer must be verified');
    positive(q.runtime.contextTokens, 'contextTokens'); positive(q.runtime.maxOutputTokens, 'maxOutputTokens');
  }
  return { selection, profile, qualification: q };
}
export function inspectAgencyRequest(ledger, taskId) {
  tables(ledger);
  return readAgencyRequest(ledger, taskId);
}
export function readAgencyRequest(ledger, taskId) {
  const tableCount = ledger.db.prepare(
    "SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN ('agency_requests','agency_receipts')").get().n;
  if (tableCount !== 2) return null;
  const row = ledger.db.prepare('SELECT body FROM agency_requests WHERE task_id=?').get(taskId);
  if (!row) return null;
  const request = JSON.parse(row.body);
  const submission = stored(ledger, taskId, 'submission');
  return { ...request, submissionState: submission?.state ?? 'uncertain', submission,
    terminal: stored(ledger, taskId, 'terminal'), resubmitAllowed: false };
}
function activeRequests(ledger) {
  tables(ledger);
  return ledger.db.prepare(`SELECT r.body FROM agency_requests r
    WHERE NOT EXISTS(SELECT 1 FROM agency_receipts t WHERE t.task_id=r.task_id AND t.kind='terminal')
    AND NOT EXISTS(SELECT 1 FROM agency_receipts s WHERE s.task_id=r.task_id AND s.kind='submission'
      AND json_extract(s.body,'$.state')='rejected')`).all()
    .map(r => JSON.parse(r.body));
}
export function activeAgencyRequests(ledger, standaloneOnly = false) {
  return activeRequests(ledger).filter(r => !standaloneOnly || r.selection.role !== 'proposer').length;
}
export function activeWorkerCount(ledger, excludedTaskId = null) {
  const shared = new Set(activeRequests(ledger).map(r => json(['task', r.taskId])));
  const jobs = ledger.db.prepare(`SELECT j.id,r.body FROM jobs j
    LEFT JOIN records r ON r.kind='assignment' AND r.id=j.id
    WHERE j.state IN ('dispatching','claimed','running','uncertain')`).all();
  for (const row of jobs) {
    const assignment = row.body ? JSON.parse(row.body) : null;
    shared.add(json(assignment?.execution === 'hosted'
      ? ['task', agencyTaskId(assignment)] : ['job', row.id]));
  }
  if (excludedTaskId !== null) shared.delete(json(['task', excludedTaskId]));
  return shared.size;
}
export function activeRepositoryWorkerCount(ledger, repoId, excludedJobId = null) {
  return ledger.db.prepare(`SELECT COUNT(*) AS n FROM jobs
    WHERE repo=? AND id<>COALESCE(?, '') AND state IN
      ('dispatching','claimed','running','uncertain')`)
    .get(repoId, excludedJobId).n;
}
export function agencyFilterRunnerMetadata(selection) {
  const capture = selection.captureVerification;
  requireThat(capture?.inputEvidenceKind === digestInputEvidence &&
    selection.role === 'filter' && selection.allowPush === false && selection.targetRef === 'refs/heads/main' &&
    Number.isInteger(selection.maxExecutionSeconds) &&
    selection.maxExecutionSeconds >= 300 && selection.maxExecutionSeconds <= 14100,
  'FILTER runner requires its reviewed main-source contract and a 300..14100 second task wait', 'blocked-scope');
  const metadata = {
    initMode: 'lite', trustProfile: 'filter-capture-v1', expectedAgent: 'filter-evidence-reader',
    expectedProtectedSourceSha: selection.sourceRevision, agentProfileDigest: capture.agentProfileSha256,
    requestDigest: selection.payloadSha256, captureProtocol: capture.protocol,
    captureVerifierSha256: capture.verifierSha256, captureAnalysisPayloadSha256: selection.analysisPayloadSha256,
    captureRepoId: selection.repoId, capturePipelineSourceRevision: capture.pipelineSourceRevision,
    captureBootstrapSha256: capture.bootstrapSha256,
    copilotTaskWaitTimeoutSeconds: String(selection.maxExecutionSeconds)
  };
  requireThat(Object.values(metadata).every(text) &&
    [capture.agentProfileSha256, selection.payloadSha256, capture.verifierSha256,
      selection.analysisPayloadSha256, capture.bootstrapSha256].every(value => digest.test(value)) &&
    revision.test(selection.sourceRevision) && revision.test(capture.pipelineSourceRevision) &&
    capture.protocol === captureVerificationProtocol,
  'FILTER runner metadata requires complete source/profile/payload/verifier pins', 'blocked-scope');
  return metadata;
}
export function reserveAgencyRequest(config, ledger, taskId, input, manifest = null) {
  requireThat(config.activation.dispatch && config.statePolicy.accessApproved, 'Agency dispatch/storage is disabled');
  const { selection: s, profile, qualification: q } = requireAgencyQualification(config, ledger, taskId);
  requireThat(s.role !== 'filter' || s.captureVerification || s.analysisPolicy,
    'New FILTER requests require qualified worker capture-verifier execution; legacy receipts are read-only history',
    'blocked-qualification');
  shape(input, ['request', 'requestSha256', 'preflight', 'tokenBudget']);
  requireThat(text(input.request) && hash(input.request) === input.requestSha256,
    'Agency request must preserve exact serialized bytes and SHA256', 'blocked-reconciliation');
  let wire;
  try { wire = JSON.parse(input.request); } catch { requireThat(false, 'Agency request is not JSON', 'invalid-record'); }
  const trustedFilter = s.captureVerification?.inputEvidenceKind === digestInputEvidence;
  shape(wire, ['organization', 'project', 'repository', 'targetBranch', 'prompt', 'options', 'metadata',
    ...(trustedFilter ? ['agent', 'sourceBranch'] : [])]);
  shape(wire.options, ['allowPush', 'pullRequest', ...(trustedFilter || s.analysisPolicy ? ['branch'] : [])]);
  shape(wire.options.pullRequest, ['create', 'publish']);
  if (s.analysisPolicy) {
    shape(wire.options.branch, ['createSourceBranch']);
    requireThat(wire.options.branch.createSourceBranch === false,
      'Local FILTER requests must disable source branch creation', 'blocked-scope');
  }
  if (trustedFilter) {
    shape(wire.agent, ['name', 'type']);
    shape(wire.options.branch, ['createSourceBranch']);
    const metadata = agencyFilterRunnerMetadata(s);
    shape(wire.metadata, Object.keys(metadata));
    requireThat(wire.agent.name === 'filter-evidence-reader' && wire.agent.type === 'Repo' &&
      wire.sourceBranch === s.targetRef && wire.options.branch.createSourceBranch === false &&
      Object.entries(metadata).every(([key, value]) => typeof value === 'string' && wire.metadata[key] === value),
    'Agency wire request differs from the qualified FILTER runner/profile/metadata contract', 'blocked-scope');
  } else shape(wire.metadata, ['initMode']);
  requireThat(wire.organization === profile.organization && wire.project === profile.project &&
    wire.repository === profile.repository &&
    wire.targetBranch === (trustedFilter ? s.targetRef : s.targetRef.replace(/^refs\/heads\//, '')) &&
    wire.metadata.initMode === profile.initMode && wire.options.allowPush === s.allowPush &&
    wire.options.pullRequest.create === false && wire.options.pullRequest.publish === false &&
    typeof wire.prompt === 'string' && hash(wire.prompt) === s.payloadSha256,
  'Agency wire request differs from the exact qualified payload/profile/publication policy', 'blocked-scope');
  if (s.analysisPayloadSha256) {
    let envelope;
    try { envelope = JSON.parse(wire.prompt); } catch { requireThat(false, 'FILTER prompt envelope is not JSON', 'invalid-record'); }
    shape(envelope, ['payloadSha256', 'payload']);
    requireThat(envelope.payloadSha256 === s.analysisPayloadSha256 && typeof envelope.payload === 'string' &&
      hash(envelope.payload) === s.analysisPayloadSha256,
    'FILTER envelope must retain the exact prepared payload and its real hash', 'blocked-reconciliation');
  }
  let localIntegrity = null;
  if (s.analysisPolicy) {
    validateFilterManifest(config, manifest);
    const batch = manifest.batches.find(b => b.id === taskId);
    requireThat(batch?.payload === wire.prompt && batch.payloadSha256 === s.payloadSha256 &&
      batch.analysisPayloadSha256 === s.analysisPayloadSha256 &&
      hash(manifest.request.instructions) === s.instructionsSha256,
    'Local FILTER policy requires exact lossless manifest/payload/instructions', 'blocked-reconciliation');
    localIntegrity = { policy: s.analysisPolicy, manifestSha256: hash(`${JSON.stringify(manifest, null, 2)}\n`),
      payloadSha256: batch.payloadSha256, analysisPayloadSha256: batch.analysisPayloadSha256 };
  }
  shape(input.preflight, ['repoId', 'targetRef', 'sourceRevision', 'observedAt', 'requestSha256']);
  utc(input.preflight.observedAt);
  const age = Date.now() - Date.parse(input.preflight.observedAt);
  requireThat(input.preflight.repoId === s.repoId && input.preflight.targetRef === s.targetRef &&
    input.preflight.sourceRevision === s.sourceRevision && input.preflight.requestSha256 === input.requestSha256 &&
    age >= 0 && age <= positive(config.agency.preflightMaxAgeSeconds, 'preflightMaxAgeSeconds') * 1000,
  'Fresh exact-source preflight is required because the provider target is a mutable branch', 'blocked-reconciliation');
  if (q.runtime.estimation) {
    const e = q.runtime.estimation, b = input.tokenBudget;
    shape(b, ['mode', 'payloadSha256', 'modelId', 'tokenizerId', 'inputTokens', 'approvalId', 'accountingMethod', 'uncertainty']);
    requireThat(b.mode === 'estimated' && b.payloadSha256 === s.payloadSha256 && b.modelId === q.runtime.modelId &&
      b.tokenizerId === null && b.approvalId === e.approvalId && b.accountingMethod === e.accountingMethod &&
      b.uncertainty === e.uncertainty && b.inputTokens === Buffer.byteLength(wire.prompt, 'utf8') &&
      b.inputTokens <= e.maxInputTokens && b.inputTokens + e.instructionReserve + e.codeReserve +
        e.outputReserve + e.safetyReserve + e.requestOverheadReserve <= e.planningCap,
    'Estimated payload does not fit the explicitly approved planning cap/reserves or estimator binding', 'blocked-budget');
  } else {
    shape(input.tokenBudget, ['payloadSha256', 'modelId', 'tokenizerId', 'inputTokens']);
    requireThat(input.tokenBudget.payloadSha256 === s.payloadSha256 &&
      input.tokenBudget.modelId === q.runtime.modelId && input.tokenBudget.tokenizerId === q.runtime.tokenizerId &&
      positive(input.tokenBudget.inputTokens, 'inputTokens') + q.runtime.maxOutputTokens <= q.runtime.contextTokens,
    'Exact payload exceeds or lacks a verified model/tokenizer budget', 'blocked-budget');
  }
  requireThat(text(config.agency.budgetId) &&
    s.maxExecutionSeconds <= positive(config.agency.maxExecutionSeconds, 'maxExecutionSeconds'),
  'Agency requires an explicit bounded execution budget', 'blocked-budget');
  requireThat(text(config.agency.monitorOwner), 'Agency requires a durable monitoring owner');
  positive(config.agency.monitorCadenceSeconds, 'monitorCadenceSeconds');
  tables(ledger);
  return ledger.transaction(() => {
    requireThat(!inspectAgencyRequest(ledger, taskId), 'Agency request already reserved; reconcile, never resubmit', 'blocked-reconciliation');
    const stopped = ledger.db.prepare(`SELECT 1 FROM agency_requests r JOIN agency_receipts s ON s.task_id=r.task_id
      WHERE r.budget_id=? AND s.kind='submission' AND json_extract(s.body,'$.state') IN ('rejected','uncertain') LIMIT 1`)
      .get(config.agency.budgetId);
    requireThat(!stopped, 'A rejected or uncertain POST stopped this Agency budget; no replacement requests', 'blocked-reconciliation');
    const count = ledger.db.prepare('SELECT COUNT(*) n FROM agency_requests WHERE budget_id=?').get(config.agency.budgetId).n;
    requireThat(count < positive(config.agency.maxRequests, 'maxRequests'), 'Agency request budget exhausted', 'blocked-budget');
    if (s.allowPush) {
      const drafts = ledger.db.prepare("SELECT COUNT(*) n FROM agency_requests WHERE budget_id=? AND json_extract(body,'$.selection.allowPush')=1")
        .get(config.agency.budgetId).n;
      requireThat(config.agency.maxDraftPullRequests === 1 && drafts < 1, 'Agency draft budget exhausted', 'blocked-budget');
    }
    const concurrent = positive(config.agency.maxConcurrent, 'Agency maxConcurrent');
    requireThat(!q.runtime.estimation || concurrent <= q.runtime.estimation.maxConcurrent,
      'Estimated trial exceeds approved FILTER concurrency', 'blocked-budget');
    const active = activeRequests(ledger);
    requireThat(active.length < concurrent &&
      activeWorkerCount(ledger, taskId) < positive(config.limits.maxWorkers, 'maxWorkers'),
    'Shared Agency/local worker concurrency budget exhausted', 'blocked-budget');
    const reservedAt = now();
    const record = { taskId, selection: s, qualificationSha256: s.qualificationSha256,
      runtime: q.runtime, ...input, reservedAt, monitor: {
        owner: config.agency.monitorOwner, cadenceSeconds: config.agency.monitorCadenceSeconds,
        deadlineAt: new Date(Date.parse(reservedAt) + s.maxExecutionSeconds * 1000).toISOString(),
        overdueAction: 'read-only reconciliation; never retry or cancel automatically'
      } };
    ledger.db.prepare('INSERT INTO agency_requests VALUES(?,?,?)').run(taskId, config.agency.budgetId, json(record));
    if (localIntegrity) receipt(ledger, taskId, 'local-filter-integrity', localIntegrity);
    ledger.operation(`agency:${taskId}`, taskId, 'agency-submission', { requestSha256: input.requestSha256, state: 'uncertain' });
    return inspectAgencyRequest(ledger, taskId);
  });
}
export function recordAgencySubmission(ledger, taskId, input) {
  const request = inspectAgencyRequest(ledger, taskId);
  requireThat(request, 'Agency request must be journaled before submission');
  shape(input, ['operation', 'state', 'requestSha256', 'jobId', 'httpStatus', 'observedAt']);
  utc(input.observedAt);
  requireThat(input.operation === 'jobs-create' && input.requestSha256 === request.requestSha256 &&
    ['accepted', 'rejected', 'uncertain'].includes(input.state) &&
    (input.jobId === null || text(input.jobId)) &&
    (input.httpStatus === null || (Number.isInteger(input.httpStatus) && input.httpStatus >= 100 && input.httpStatus <= 599)),
  'Invalid Agency submission receipt; validation-only responses are not job creation', 'invalid-record');
  requireThat(input.state !== 'accepted' || (text(input.jobId) && input.httpStatus >= 200 && input.httpStatus < 300),
    'Agency acceptance requires a real returned job handle and successful HTTP status');
  requireThat(input.state !== 'rejected' || (input.jobId === null && input.httpStatus >= 400 && input.httpStatus < 500),
    'Only a definitive pre-job client rejection is rejected; ambiguous server outcomes remain uncertain');
  return ledger.transaction(() => {
    if (input.jobId) {
      const duplicate = ledger.db.prepare("SELECT task_id FROM agency_receipts WHERE kind='submission' AND json_extract(body,'$.jobId')=? AND task_id<>?")
        .get(input.jobId, taskId);
      requireThat(!duplicate, 'Agency handle is already bound to another task', 'blocked-reconciliation');
    }
    receipt(ledger, taskId, 'submission', input);
    ledger.finishOperation(`agency:${taskId}`, input.state, { requestSha256: request.requestSha256, jobId: input.jobId });
    return inspectAgencyRequest(ledger, taskId);
  });
}
export function filterCandidateSourcesMatch(selection, result) {
  return Array.isArray(result?.candidates) && result.candidates.every(candidate =>
    candidate?.repository === selection.repoId && candidate.sourceRevision === selection.sourceRevision);
}
export function recordAgencyAnalysisCheck(ledger, taskId, resultBytes, validate) {
  const request = inspectAgencyRequest(ledger, taskId);
  requireThat(request?.selection.resultKind === 'analysis' && typeof validate === 'function' && text(resultBytes),
    'Analysis requires a reserved task and a local result validator');
  const checked = validate(resultBytes);
  shape(checked, ['state', 'payloadSha256', 'resultSha256', 'validator']);
  requireThat(checked.state === 'checked-not-qualified' &&
    checked.payloadSha256 === analysisPayloadHash(request.selection) && checked.resultSha256 === hash(resultBytes) &&
    text(checked.validator), 'Local analysis validator did not verify the exact payload and complete result', 'blocked-result');
  if (request.selection.role === 'filter') {
    const result = JSON.parse(resultBytes);
    requireThat(checked.validator === 'filter-batch-result-v1' && result.status === 'complete' &&
      filterCandidateSourcesMatch(request.selection, result),
    'FILTER requires complete results bound to the execution repository and source revision', 'blocked-result');
    requiredFilterCaptureIds(JSON.parse(request.request).prompt, resultBytes);
  }
  return ledger.transaction(() => {
    receipt(ledger, taskId, 'analysis-check', checked);
    if (request.selection.captureVerification) receipt(ledger, taskId, 'capture-requirements', {
      ...requiredFilterCaptureIds(JSON.parse(request.request).prompt, resultBytes), resultSha256: checked.resultSha256
    });
    return checked;
  });
}
export function recordAgencyCaptureCheck(ledger, taskId, inspectExecution) {
  const request = inspectAgencyRequest(ledger, taskId), s = request?.selection;
  requireThat(s?.captureVerification && request.submission?.jobId && typeof inspectExecution === 'function',
  'Capture acceptance requires a pinned request and submitted job', 'blocked-result');
  const binding = { repoId: s.repoId, targetRef: s.targetRef, sourceRevision: s.sourceRevision,
    verifierSha256: s.captureVerification.verifierSha256, payloadSha256: s.payloadSha256,
    analysisPayloadSha256: s.analysisPayloadSha256 };
  const input = { format: captureVerificationProtocol, binding, prompt: JSON.parse(request.request).prompt };
  // The provider adapter inspects the enforced pipeline step, not a model-authored result or local preflight.
  const execution = inspectExecution({ jobId: request.submission.jobId, taskId, input });
  const digestOnly = s.captureVerification.inputEvidenceKind === digestInputEvidence;
  shape(execution, ['executionKind', 'executionId', 'jobId', 'pipeline', 'verifierSha256',
    'inputSerialization', 'inputSha256', 'exitCode', 'stdout', 'evidenceRefs',
    ...(digestOnly ? ['inputEvidenceKind', 'stdinByteLength'] : ['stdin'])]);
  requireBoundPipeline(request, execution, s.captureVerification.stepName);
  requireThat(execution.verifierSha256 === binding.verifierSha256 &&
    execution.inputSerialization === 'json-stringify-v1' && execution.inputSha256 === hash(json(input)) &&
    (digestOnly ? execution.inputEvidenceKind === digestInputEvidence &&
      execution.stdinByteLength === Buffer.byteLength(json(input), 'utf8') : execution.stdin === json(input)) &&
    execution.exitCode === 0 && text(execution.stdout),
  'Observed worker execution does not match the pinned verifier/input/job or did not succeed', 'blocked-result');
  const actual = JSON.parse(execution.stdout);
  const expected = verifyFilterCaptureInput(input, actual.source);
  requireThat(json(actual) === json(expected),
    'Worker capture receipt differs from deterministic source/payload-bound verification', 'blocked-result');
  return ledger.transaction(() => receipt(ledger, taskId, 'capture-check', {
    protocol: captureVerificationProtocol, jobId: execution.jobId, executionKind: execution.executionKind,
    executionId: execution.executionId, pipeline: execution.pipeline, inputSerialization: execution.inputSerialization,
    ...(digestOnly ? { inputEvidenceKind: digestInputEvidence, stdinByteLength: execution.stdinByteLength } : {}),
    verifierSha256: execution.verifierSha256, inputSha256: execution.inputSha256,
    receiptSha256: hash(execution.stdout), payloadSha256: s.payloadSha256,
    analysisPayloadSha256: s.analysisPayloadSha256,
    sourceRevision: s.sourceRevision, captures: actual.captures,
    evidenceRefs: execution.evidenceRefs, semanticReadingProven: false
  }));
}
function requireBoundPipeline(request, execution, stepName) {
  const c = request.selection.captureVerification;
  shape(execution.pipeline, ['buildId', 'definitionId', 'sourceRevision', 'bootstrapSha256',
    'stepName', 'state', 'result', 'log']);
  shape(execution.pipeline.log, ['id', 'sha256']);
  refs(execution.evidenceRefs, request.submission.jobId);
  requireThat(execution.executionKind === 'pipeline-step' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(execution.executionId) &&
    execution.jobId === request.submission.jobId && text(execution.pipeline.buildId) &&
    execution.pipeline.definitionId === c.pipelineDefinitionId &&
    execution.pipeline.sourceRevision === c.pipelineSourceRevision &&
    execution.pipeline.bootstrapSha256 === c.bootstrapSha256 &&
    execution.pipeline.stepName === stepName &&
    execution.pipeline.state === 'completed' && execution.pipeline.result === 'succeeded' &&
    text(execution.pipeline.log.id) && digest.test(execution.pipeline.log.sha256),
  'Observed worker pipeline step differs from the qualified job/source/helper/step contract', 'blocked-result');
}
export function recordAgencySourceCheck(ledger, taskId, inspectExecution) {
  const request = inspectAgencyRequest(ledger, taskId), s = request?.selection;
  requireThat(s?.captureVerification?.inputEvidenceKind === digestInputEvidence && request.submission?.jobId &&
    typeof inspectExecution === 'function', 'Terminal source verification requires a submitted qualified FILTER job', 'blocked-result');
  const execution = inspectExecution({ jobId: request.submission.jobId, taskId });
  shape(execution, ['executionKind', 'executionId', 'jobId', 'pipeline', 'source', 'evidenceRefs']);
  requireBoundPipeline(request, execution, s.captureVerification.sourceAttestationStepName);
  shape(execution.source, ['repoId', 'targetRef', 'revision', 'status']);
  requireThat(execution.source.repoId === s.repoId && execution.source.targetRef === s.targetRef &&
    execution.source.revision === s.sourceRevision && execution.source.status === '',
  'Post-analysis source is dirty or differs from the qualified checkout', 'blocked-result');
  return ledger.transaction(() => receipt(ledger, taskId, 'source-check', execution));
}
function inspectAgencyStepLog(observed, marker, format, fields) {
  shape(observed, ['jobId', 'pipeline', 'step', 'logText', 'evidenceRefs']);
  shape(observed.pipeline, ['buildId', 'definitionId', 'sourceRevision']);
  shape(observed.step, ['executionId', 'stepName', 'state', 'result', 'logId']);
  refs(observed.evidenceRefs, observed.jobId);
  const id = value => {
    requireThat(text(value) || (Number.isSafeInteger(value) && value > 0),
      'Invalid inspected pipeline or log identifier', 'blocked-result');
    return String(value);
  };
  const buildId = id(observed.pipeline.buildId), definitionId = id(observed.pipeline.definitionId);
  const logId = id(observed.step.logId);
  requireThat(typeof observed.logText === 'string' && Buffer.byteLength(observed.logText, 'utf8') <= 1024 * 1024,
    'Worker gate log is missing or exceeds the 1 MiB inspection limit', 'blocked-result');
  const lines = observed.logText.split(/\r?\n/).filter(line => line.includes(marker));
  requireThat(lines.length === 1, 'Worker gate log must contain exactly one execution envelope', 'blocked-result');
  const match = lines[0].match(new RegExp(
    `^(?:\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z )?${marker} (.+)$`));
  requireThat(match, 'Malformed worker execution log marker', 'blocked-result');
  const envelope = JSON.parse(match[1]);
  shape(envelope, ['format', 'jobId', 'executionKind', 'executionId', 'pipeline', ...fields]);
  shape(envelope.pipeline, ['buildId', 'definitionId', 'sourceRevision', 'bootstrapSha256', 'stepName']);
  requireThat(envelope.format === format &&
    envelope.jobId === observed.jobId && envelope.executionKind === 'pipeline-step' &&
    envelope.executionId === observed.step.executionId &&
    id(envelope.pipeline.buildId) === buildId &&
    id(envelope.pipeline.definitionId) === definitionId &&
    envelope.pipeline.sourceRevision === observed.pipeline.sourceRevision &&
    envelope.pipeline.stepName === observed.step.stepName &&
    observed.step.state === 'completed' && observed.step.result === 'succeeded',
  'Worker log does not match its independently inspected job/pipeline/timeline', 'blocked-result');
  return { envelope, execution: {
    executionKind: envelope.executionKind, executionId: envelope.executionId, jobId: envelope.jobId,
    pipeline: { ...envelope.pipeline, buildId, definitionId, state: observed.step.state, result: observed.step.result,
      log: { id: logId, sha256: hash(observed.logText) } },
    evidenceRefs: observed.evidenceRefs
  } };
}
export function inspectAgencyCaptureLog(observed) {
  const { envelope, execution } = inspectAgencyStepLog(observed, 'AGENCY_FILTER_CAPTURE_RECEIPT_V1',
    'agency-filter-capture-execution-v1', ['verifierSha256', 'inputEvidenceKind', 'inputSerialization',
      'inputSha256', 'stdinByteLength', 'exitCode', 'stdout']);
  requireThat(envelope.inputEvidenceKind === digestInputEvidence, 'Invalid capture input evidence kind', 'blocked-result');
  return { ...execution, verifierSha256: envelope.verifierSha256, inputSerialization: envelope.inputSerialization,
    inputEvidenceKind: digestInputEvidence, stdinByteLength: envelope.stdinByteLength,
    inputSha256: envelope.inputSha256, exitCode: envelope.exitCode, stdout: envelope.stdout,
  };
}
export function inspectAgencySourceLog(observed) {
  const { envelope, execution } = inspectAgencyStepLog(observed, 'AGENCY_FILTER_SOURCE_RECEIPT_V1',
    'agency-filter-source-execution-v1', ['source']);
  shape(envelope.source, ['repoId', 'targetRef', 'revision', 'status']);
  return { ...execution, source: envelope.source };
}
function refs(values, jobId) {
  requireThat(Array.isArray(values) && values.length > 0, 'Missing inspected job-local evidence references', 'invalid-record');
  for (const v of values) {
    shape(v, ['ref', 'sha256']);
    requireThat(text(jobId) && typeof v.ref === 'string' && v.ref.startsWith(`job-local:${jobId}:`) &&
      v.ref.length > `job-local:${jobId}:`.length && digest.test(v.sha256),
    'Only hashed job-local evidence references may be exported', 'invalid-record');
  }
}
export function previewAgencyResult(ledger, taskId, input, evaluation = null) {
  const request = readAgencyRequest(ledger, taskId);
  requireThat(request?.submission?.jobId && ['accepted', 'uncertain'].includes(request.submission.state),
    'An unbound or rejected Agency request cannot reconcile to success', 'blocked-reconciliation');
  shape(input, ['requestSha256', 'jobId', 'observedAt', 'provider', 'pipeline', 'source', 'runtime',
    'inspection', 'publication', 'validation', 'analysis']);
  utc(input.observedAt);
  requireThat(input.requestSha256 === request.requestSha256 && input.jobId === request.submission.jobId,
    'Agency result does not match request and returned handle', 'blocked-reconciliation');
  shape(input.provider, ['state', 'result']);
  shape(input.pipeline, ['id', 'state', 'result']);
  shape(input.inspection, ['approved', 'evidenceRefs']);
  refs(input.inspection.evidenceRefs, input.jobId);
  const reasons = [], s = request.selection;
  const policy = evaluation?.policy ?? s.analysisPolicy;
  const localPolicy = policy ? validateFilterAnalysisPolicy(policy, s) : null;
  if (localPolicy) requireThat(Date.parse(input.observedAt) >= Date.parse(policy.approvedAt),
    'Prospective policy evaluation must be observed after approval', 'blocked-reconciliation');
  const limitations = localPolicy ? [
    'Prospective local analysis acceptance is not historical compliance with a stronger policy.',
    'Local lossless capture validation does not prove semantic reading or worker hash execution.',
    'No dedicated final clean-worktree attestation or sandbox guarantee is claimed.',
    'Publication policy is a request restriction, not exhaustive verification of external effects.'
  ] : [];
  const check = (condition, message) => { if (!condition) reasons.push(message); return Boolean(condition); };
  if (localPolicy) {
    const wire = JSON.parse(request.request);
    const integrity = evaluation?.integrity ?? stored(ledger, taskId, 'local-filter-integrity');
    check(request.requestSha256 === hash(request.request) && hash(wire.prompt) === s.payloadSha256 &&
      wire.options?.allowPush === false && wire.options?.pullRequest?.create === false &&
      wire.options?.pullRequest?.publish === false,
    'Local FILTER policy requires exact submitted payload and explicit no-push/no-PR request policy');
    check(integrity && json(integrity.policy) === json(policy) &&
      integrity.payloadSha256 === s.payloadSha256 && integrity.analysisPayloadSha256 === s.analysisPayloadSha256,
    'Local FILTER policy requires independently validated lossless payload integrity');
    check(!s.analysisPolicy || json(s.analysisPolicy) === json(policy),
      'New request policy cannot be replaced during terminal reconciliation');
    check(!s.analysisPolicy || wire.options?.branch?.createSourceBranch === false,
      'New local FILTER request did not disable source branch creation');
  }
  shape(input.runtime, ['profileId', 'instructionsSha256', 'modelId', 'tokenizerId']);
  check(input.runtime.profileId === s.profileId && input.runtime.instructionsSha256 === s.instructionsSha256 &&
    input.runtime.modelId === request.runtime.modelId && input.runtime.tokenizerId === request.runtime.tokenizerId,
  'Observed runtime/profile/instruction binding differs from qualification');
  const providerPassed = check(input.provider.state === 'Completed' && input.provider.result === 'Success',
    'Provider terminal state and explicit positive result are both required');
  const pipelinePassed = check(text(input.pipeline.id) && input.pipeline.state === 'completed' && input.pipeline.result === 'succeeded',
    'An actual successful terminal pipeline is required, not a policy/check status');
  check(input.inspection.approved === true, 'Derived evidence has not been inspected for permitted export');
  shape(input.source, ['repoId', 'targetRef', 'baseRevision', 'checkoutRevision', 'outputRevision',
    'testedRevision', 'commitParents', 'changedPaths', 'unchangedDuringValidation', 'evidenceRefs']);
  refs(input.source.evidenceRefs, input.jobId);
  const source = input.source;
  check(source.repoId === s.repoId && source.targetRef === s.targetRef &&
    source.baseRevision === s.sourceRevision && source.checkoutRevision === s.sourceRevision &&
    (revision.test(source.outputRevision) || (localPolicy && source.outputRevision === null)) && (s.resultKind === 'validation'
      ? source.testedRevision === source.outputRevision && source.unchangedDuringValidation === true
      : source.testedRevision === null && source.unchangedDuringValidation === null),
  'Source/checkout/output/tested pins do not match; analysis cannot claim test execution');
  requireThat((Array.isArray(source.commitParents) || (localPolicy && source.commitParents === null)) &&
    (Array.isArray(source.changedPaths) || (localPolicy && source.changedPaths === null)), 'Invalid source ancestry/path proof');
  check((localPolicy && source.outputRevision === null) ||
    source.outputRevision === s.sourceRevision || source.commitParents?.includes(s.sourceRevision),
    'Output parent does not prove the pinned authoring baseline');
  check((localPolicy && source.changedPaths === null) || source.changedPaths.every(p => safePath(p) &&
    s.allowedPaths.some(a => p === a || p.startsWith(`${a}/`)) &&
    !s.forbiddenPaths.some(a => p === a || p.startsWith(`${a}/`))), 'Changed paths exceed the approved scope');
  if (!s.allowPush) check((source.outputRevision === s.sourceRevision || (localPolicy && source.outputRevision === null)) &&
    (source.changedPaths?.length === 0 || (localPolicy && source.changedPaths === null)),
    'Read-only analysis changed source');
  if (!localPolicy && s.captureVerification?.inputEvidenceKind === digestInputEvidence) {
    const sourceCheck = stored(ledger, taskId, 'source-check'), c = s.captureVerification;
    check(sourceCheck && sourceCheck.jobId === input.jobId &&
      sourceCheck.pipeline.buildId === input.pipeline.id &&
      sourceCheck.pipeline.definitionId === c.pipelineDefinitionId &&
      sourceCheck.pipeline.sourceRevision === c.pipelineSourceRevision &&
      sourceCheck.pipeline.bootstrapSha256 === c.bootstrapSha256 &&
      sourceCheck.pipeline.stepName === c.sourceAttestationStepName &&
      sourceCheck.source.repoId === s.repoId && sourceCheck.source.targetRef === s.targetRef &&
      sourceCheck.source.revision === source.outputRevision && sourceCheck.source.status === '',
    'FILTER requires inspected post-analysis source proof; preflight and pipeline source are not final checkout evidence');
  }
  let publicationPassed, publicationPolicyPassed;
  if (localPolicy) {
    const p = input.publication;
    if (p !== null) {
      const required = ['pushPerformed', 'pullRequest', 'createdPullRequests', 'otherPullRequestsModified', 'merged'];
      shape(p, [...required, 'sourceBranchCreated'], required);
      requireThat(['pushPerformed', 'otherPullRequestsModified', 'merged'].every(k =>
        p[k] === null || typeof p[k] === 'boolean') &&
        (!Object.hasOwn(p, 'sourceBranchCreated') || p.sourceBranchCreated === null ||
          typeof p.sourceBranchCreated === 'boolean') &&
        (p.createdPullRequests === null || (Number.isSafeInteger(p.createdPullRequests) && p.createdPullRequests >= 0)),
      'Malformed publication observations', 'invalid-record');
    }
    publicationPolicyPassed = check(p === null || (p.pushPerformed !== true && p.pullRequest === null &&
      (p.createdPullRequests === null || p.createdPullRequests === 0) &&
      p.otherPullRequestsModified !== true && p.merged !== true && p.sourceBranchCreated !== true),
    'Observed publication mutation violates read-only FILTER policy');
    publicationPassed = p && p.pushPerformed === false && p.pullRequest === null &&
      p.createdPullRequests === 0 && p.otherPullRequestsModified === false && p.merged === false &&
      p.sourceBranchCreated === false
      ? true : publicationPolicyPassed ? null : false;
  } else {
    shape(input.publication, ['pushPerformed', 'pullRequest', 'createdPullRequests', 'otherPullRequestsModified', 'merged']);
    const publicationEffectsAllowed = check(input.publication.otherPullRequestsModified === false && input.publication.merged === false &&
      input.publication.createdPullRequests === (s.allowPush ? 1 : 0),
    'Publication exceeded the single-draft/no-other-PR/no-merge contract or effects are unknown');
    if (!s.allowPush) publicationPassed = check(input.publication.pushPerformed === false && input.publication.pullRequest === null,
      'Read-only task pushed or mutated a pull request, or publication effects are unknown') && publicationEffectsAllowed;
    else {
      const pr = input.publication.pullRequest;
      if (pr !== null) shape(pr, ['url', 'state', 'isDraft', 'autoComplete', 'headRevision', 'remoteRevision', 'targetRef', 'evidenceRefs']);
      if (pr) refs(pr.evidenceRefs, input.jobId);
      publicationPassed = check(pr && input.publication.pushPerformed === true && text(pr.url) &&
        /^https:\/\//.test(pr.url) && pr.state === 'active' && pr.isDraft === true && pr.autoComplete === null &&
        pr.headRevision === source.outputRevision && pr.remoteRevision === source.outputRevision && pr.targetRef === s.targetRef,
      'Publication requires an active draft, exact tested/remote/head pins, target and unset autocomplete') && publicationEffectsAllowed;
    }
  }
  let testsPassed = false, coveragePassed = false, analysisPassed = false, buildPassed = null, caseCounts = null;
  if (s.resultKind === 'analysis') {
    check(input.validation === null, 'Analysis must not claim test qualification');
    if (input.analysis !== null) {
      shape(input.analysis, ['payloadSha256', 'resultSha256', 'validator', 'membershipValidated', 'evidenceRefs']);
      refs(input.analysis.evidenceRefs, input.jobId);
    }
    const localCheck = evaluation?.analysisCheck ?? stored(ledger, taskId, 'analysis-check');
    analysisPassed = check(localCheck && input.analysis?.payloadSha256 === analysisPayloadHash(s) &&
      digest.test(input.analysis?.resultSha256) && text(input.analysis?.validator) &&
      input.analysis.resultSha256 === localCheck.resultSha256 && input.analysis.validator === localCheck.validator &&
      input.analysis?.membershipValidated === true,
    'Analysis requires exact-payload, independently validated result/membership evidence');
    if (s.captureVerification && !localPolicy) {
      const captureCheck = stored(ledger, taskId, 'capture-check');
      const requirements = stored(ledger, taskId, 'capture-requirements');
      const capturePassed = check(requirements && requirements.resultSha256 === localCheck?.resultSha256 &&
        (requirements.requiredIds.length === 0 || (captureCheck && captureCheck.jobId === input.jobId &&
        captureCheck.pipeline.buildId === input.pipeline.id &&
        captureCheck.pipeline.definitionId === s.captureVerification.pipelineDefinitionId &&
        captureCheck.pipeline.sourceRevision === s.captureVerification.pipelineSourceRevision &&
        captureCheck.pipeline.bootstrapSha256 === s.captureVerification.bootstrapSha256 &&
        captureCheck.pipeline.stepName === s.captureVerification.stepName &&
        captureCheck.protocol === s.captureVerification.protocol &&
        captureCheck.inputEvidenceKind === s.captureVerification.inputEvidenceKind &&
        captureCheck.verifierSha256 === s.captureVerification.verifierSha256 &&
        captureCheck.payloadSha256 === s.payloadSha256 &&
        captureCheck.analysisPayloadSha256 === s.analysisPayloadSha256 &&
        captureCheck.sourceRevision === s.sourceRevision &&
        requirements.requiredIds.every(id => captureCheck.captures.some(c => c.evidenceId === id)))),
      'FILTER requires inspected worker capture-verifier execution; local packaging and prose are not execution proof');
      analysisPassed = Boolean(analysisPassed && capturePassed);
    }
  } else {
    check(input.analysis === null, 'Validation cannot substitute an analysis receipt');
    if (input.validation !== null) {
      const v = input.validation;
      shape(v, ['commands', 'cases', 'scenarios', 'assertionsPreserved']);
      requireThat(Array.isArray(v.commands) && Array.isArray(v.cases) && Array.isArray(v.scenarios), 'Invalid validation populations');
      for (const c of v.commands) {
        shape(c, ['id', 'phase', 'command', 'cwd', 'exitCode', 'sourceRevision', 'evidenceRefs']);
        refs(c.evidenceRefs, input.jobId);
      }
      const commandPassed = expected => {
        const matches = v.commands.filter(c => c.id === expected.id);
        return matches.length === 1 && matches[0].phase === expected.phase && matches[0].command === expected.command &&
          matches[0].cwd === expected.cwd && matches[0].exitCode === 0 && matches[0].sourceRevision === source.testedRevision;
      };
      const builds = s.caseContract.commands.filter(c => c.phase === 'build');
      buildPassed = builds.length ? builds.every(commandPassed) : null;
      check(v.commands.length === s.caseContract.commands.length && s.caseContract.commands.every(commandPassed),
        'Required build/test/coverage/hook commands are missing, failed or source-mismatched');
      for (const c of v.cases) {
        shape(c, ['suite', 'title', 'status', 'bodyExecuted', 'invocations', 'retryCount', 'evidenceRefs']);
        refs(c.evidenceRefs, input.jobId);
      }
      caseCounts = { expected: s.caseContract.cases.length, actual: v.cases.length,
        passed: v.cases.filter(c => c.status === 'passed').length,
        failed: v.cases.filter(c => c.status === 'failed').length,
        skipped: v.cases.filter(c => c.status === 'skipped').length };
      testsPassed = check(s.caseContract.commands.filter(c => c.phase === 'test').every(commandPassed) &&
        v.cases.length === s.caseContract.cases.length && s.caseContract.cases.every(expected => {
        const matches = v.cases.filter(c => c.suite === expected.suite && c.title === expected.title);
        const c = matches[0];
        return matches.length === 1 && c.status === expected.status && c.retryCount === 0 &&
          (expected.status === 'passed' ? c.bodyExecuted === true && c.invocations === 1
            : c.bodyExecuted === false && c.invocations === 0);
      }), 'Exact expected/pass/fail/skip population and executed case bodies are not proven');
      for (const scenario of v.scenarios) {
        shape(scenario, ['id', 'preconditionVerified', 'pathActivated', 'evidenceRefs']);
        refs(scenario.evidenceRefs, input.jobId);
      }
      coveragePassed = check(s.caseContract.commands.filter(c => c.phase === 'coverage').every(commandPassed) &&
        v.assertionsPreserved === true &&
        v.scenarios.length === s.caseContract.scenarios.length && s.caseContract.scenarios.every(id => {
          const matches = v.scenarios.filter(p => p.id === id);
          return matches.length === 1 && matches[0].preconditionVerified === true && matches[0].pathActivated === true;
        }), 'Required scenario preconditions/path activation and preserved assertions are not proven');
    } else check(false, 'Missing derived validation receipt');
  }
  const verdict = { state: reasons.length ? 'blocked' : 'completed', providerPassed, pipelinePassed,
    buildPassed, testsPassed, caseCounts, coveragePassed, analysisPassed, publicationPassed,
    validationQualified: s.resultKind === 'validation' && reasons.length === 0, reasons };
  if (localPolicy) Object.assign(verdict, { analysisPolicy: policy, publicationPolicyPassed,
    assuranceLimitations: limitations, historicalCompliance: false });
  return verdict;
}
export function recordAgencyPolicyEvaluation(ledger, taskId, evaluation) {
  const request = readAgencyRequest(ledger, taskId);
  validateFilterAnalysisPolicy(evaluation.policy, request?.selection ?? {});
  requireThat(evaluation.requestSha256 === request.requestSha256 &&
    evaluation.jobId === request.submission?.jobId,
  'Policy evaluation differs from immutable request/job', 'blocked-reconciliation');
  return ledger.transaction(() => receipt(ledger, taskId,
    `policy-evaluation:${hash(json(evaluation))}`, evaluation));
}
export function reconcileAgencyResult(ledger, taskId, input) {
  const verdict = previewAgencyResult(ledger, taskId, input);
  return ledger.transaction(() => {
    receipt(ledger, taskId, 'terminal', { receipt: input, verdict });
    return verdict;
  });
}

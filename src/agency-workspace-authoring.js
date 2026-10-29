import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { hash, json, requireThat } from './common.js';
import { checkStage2Files } from './stage2.js';
import { requireCurrentAssignment } from './workers.js';
import { runRemoteValidationOperation } from './agency-remote-validation.js';
import { verifyWorkspaceAuthoring, workspaceAuthoringContract } from './agency-workspace-loop.js';
import { nativeCommand } from './native-command.js';
import { validationEnvironment } from '../scripts/validation/agency-workspace-loop.mjs';

function pinnedJson(reference, workspace) {
  requireThat(typeof reference?.path === 'string' && isAbsolute(reference.path) &&
    /^[a-f0-9]{64}$/.test(reference.sha256 ?? ''),
  'Authoring source authorization requires exact local artifact references', 'blocked-authorization');
  const stat = lstatSync(reference.path);
  const location = relative(realpathSync(workspace), realpathSync(reference.path));
  requireThat(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 &&
    (location === '..' || location.startsWith(`..${sep}`) || isAbsolute(location)) &&
    hash(readFileSync(reference.path)) === reference.sha256,
  'Authoring source authorization artifact changed', 'blocked-reconciliation');
  return JSON.parse(readFileSync(reference.path, 'utf8').replace(/^\uFEFF/, ''));
}

export async function requireWorkspaceAuthoringSource(config, ledger, repo, request, contract) {
  requireThat(config.statePolicy?.accessApproved === true,
    'Source authorization requires approved private evidence access', 'blocked-authorization');
  const approval = pinnedJson({
    path: request.sourceApprovalPath, sha256: contract.loop.authoring.sourceApprovalSha256
  }, request.workspace);
  const stage2 = approval?.schema === 'controller-authoring-source-approval-v1';
  requireThat((stage2 || approval?.schema === 'controller-authoring-assignment-approval-v1') &&
    approval.repoId === repo.id && approval.baseRevision === request.baseRevision &&
    approval.allowedPath === contract.loop.allowedPath &&
    approval.evidenceSha256 === contract.loop.authoring.evidenceSha256 &&
    typeof approval.assignmentId === 'string' && approval.assignmentId === request.assignmentId &&
    approval.executionAuthorized === true && approval.productPublication === false &&
    approval.maximumNewJobs === 1 && approval.maximumRepairs === 2 &&
    typeof approval.authority === 'string' && approval.authority.trim().length > 0 &&
    typeof approval.receivedAt === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(approval.receivedAt) &&
    Number.isFinite(Date.parse(approval.receivedAt)),
  'A held coverage proposal is not explicit source-bound execution authorization', 'blocked-authorization');
  const native = contract.loop.authoring.nativeWorkflow;
  requireThat(native ? approval.nativeWorkflowSha256 === hash(json(native))
    : !Object.hasOwn(approval, 'nativeWorkflowSha256'),
  'Native card, fitness and reviewer capabilities require their own exact source authorization',
  'blocked-authorization');
  const assignment = ledger.get('assignment', approval.assignmentId);
  requireThat(assignment?.repoId === repo.id && assignment.intent === 'improvement' &&
    assignment.permissions.editCode === true && assignment.permissions.runValidation === true &&
    assignment.testCoveragePlanId && ledger.job(assignment.id)?.state === 'prepared',
  'Authoring qualification requires a current, prepared, test-coverage assignment', 'blocked-authorization');
  const investigation = ledger.get('investigation', assignment.investigationId);
  requireCurrentAssignment(config, ledger, investigation, assignment);
  const plan = ledger.get('testCoveragePlan', assignment.testCoveragePlanId);
  let evidenceRefs, sourceRoute;
  if (stage2) {
    const proposal = pinnedJson(approval.coverageProposal, request.workspace);
    pinnedJson(approval.coverageHandoff, request.workspace);
    const checked = checkStage2Files(config, approval.coverageProposal.path, approval.coverageHandoff.path);
    const candidate = proposal.candidates.find(value => value.id === approval.coverageCandidateId);
    requireThat(candidate && checked.candidateGates.some(gate => gate.id === candidate.id &&
      gate.contractTargetApproval === 'approved-direction-only') &&
      ['extend existing test', 'new integration/E2E scenario'].includes(candidate.classification) &&
      candidate.blockers.length === 0 && candidate.target.inspectedRef === request.baseRevision &&
      candidate.target.repository === approval.targetRepository,
    'The selected coverage direction requires complete ownership and fresh exact-target reconciliation',
    'blocked-reconciliation');
    evidenceRefs = candidate.evidenceRefs;
    sourceRoute = { mode: 'held-stage2', proposalId: checked.proposalId, candidateId: candidate.id };
  } else {
    const improvement = ledger.get('areaToImprove', assignment.improvementId);
    requireThat(['coverageProposal', 'coverageHandoff', 'coverageCandidateId', 'targetRepository']
      .every(key => !Object.hasOwn(approval, key)) &&
      approval.review?.assignmentSha256 === hash(json(assignment)) &&
      [['investigation', investigation], ['improvement', improvement], ['coveragePlan', plan]]
        .every(([key, record]) => record && approval.review[key]?.id === record.id &&
          approval.review[key].version === record.version &&
          approval.review[key].sha256 === hash(json(record))),
    'Reviewed-assignment authorization must pin the current native review, improvement, plan and assignment; it cannot waive a held Stage2 handoff',
    'blocked-authorization');
    evidenceRefs = assignment.evidenceIds.map(id => {
      const record = ledger.get('evidence', id);
      return { evidenceId: id, recordId: record.source.recordId, revision: record.source.revision,
        artifactRef: record.capture.artifactRef, sha256: record.capture.sha256 };
    });
    sourceRoute = { mode: 'reviewed-assignment', investigationId: investigation.id,
      investigationVersion: investigation.version, coveragePlanId: plan.id, coveragePlanVersion: plan.version };
  }
  requireThat(plan?.sourceRevision === request.baseRevision &&
    contract.loop.requiredSkillPaths.includes(assignment.skillQualification.skillPath) &&
    assignment.evidenceIds.length === evidenceRefs.length &&
    assignment.evidenceIds.every(id => evidenceRefs.some(ref => ref.evidenceId === id)) &&
    ((assignment.allowedWriteFiles ?? []).includes(contract.loop.allowedPath) ||
      (assignment.allowedWritePrefixes ?? []).some(prefix =>
        contract.loop.allowedPath.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))),
  'The assignment plan, source evidence or qualified write scope differs from the remote authoring contract',
  'blocked-reconciliation');
  if (native) requireThat((assignment.allowedWriteFiles ?? []).includes(native.cardPath) ||
    (assignment.allowedWritePrefixes ?? []).some(prefix =>
      native.cardPath.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)),
  'The native behavior card is outside the qualified assignment write scope', 'blocked-reconciliation');
  const skill = await nativeCommand('git.exe', ['-C', request.workspace, 'show',
    `${request.baseRevision}:${assignment.skillQualification.skillPath}`], request.workspace, 120000,
  validationEnvironment(process.env));
  requireThat(hash(skill.stdout) === assignment.skillQualification.skillSha256,
    'The remote native skill differs from the assignment read-only qualification', 'blocked-reconciliation');
  const evidenceBytes = readFileSync(request.evidencePath);
  const evidence = pinnedJson({ path: request.evidencePath, sha256: approval.evidenceSha256 }, request.workspace);
  requireThat(evidenceBytes.length <= 128 * 1024 &&
    evidence.schema === 'controller-authoring-evidence-v1' && Array.isArray(evidence.records) &&
    evidence.records.length === evidenceRefs.length &&
    new Set(evidence.records.map(record => record.reference?.evidenceId)).size === evidence.records.length,
  'Remote authoring requires the complete bounded evidence, never a truncated source summary', 'blocked-authorization');
  for (const ref of evidenceRefs) {
    const captured = evidence.records.find(record => record.reference?.evidenceId === ref.evidenceId);
    const record = ledger.get('evidence', ref.evidenceId);
    const body = ledger.db.prepare('SELECT body FROM captures WHERE hash=?').get(ref.sha256)?.body;
    requireThat(captured && ['evidenceId', 'recordId', 'revision', 'artifactRef', 'sha256']
      .every(key => captured.reference[key] === ref[key]) &&
      record?.source.kind === 'ado' && record.source.provenance === 'authenticated-source' &&
      record.source.recordId === ref.recordId && record.source.revision === ref.revision &&
      record.capture.sha256 === ref.sha256 && record.capture.artifactRef === ref.artifactRef &&
      (typeof body === 'string' || ArrayBuffer.isView(body)) &&
      captured.bodyBase64 === Buffer.from(body).toString('base64') && hash(body) === ref.sha256,
    'Only the complete authenticated source capture selected by the qualified assignment may be sent',
    'blocked-reconciliation');
  }
  return { assignmentId: assignment.id, ...sourceRoute, evidenceSha256: hash(evidenceBytes),
    sourceApprovalSha256: contract.loop.authoring.sourceApprovalSha256 };
}

export async function runAgencyWorkspaceAuthoring(config, ledger, repo, request, options = {}, dependencies = {}) {
  requireThat(config.activation.dispatch === true && config.statePolicy?.accessApproved === true,
    'Authoring qualification requires explicit dispatch activation and approved state storage', 'blocked-authorization');
  const contract = workspaceAuthoringContract(repo, request);
  const authorization = await requireWorkspaceAuthoringSource(config, ledger, repo, request, contract);
  const lock = `dispatch:${authorization.assignmentId}`, owner = ledger.acquire(lock);
  try {
    await requireWorkspaceAuthoringSource(config, ledger, repo, request, contract);
    requireThat(config.activation.dispatch === true && config.statePolicy?.accessApproved === true,
      'Authoring qualification requires explicit dispatch activation and approved state storage', 'blocked-authorization');
    const git = async args => (await nativeCommand('git.exe', ['-C', request.workspace, ...args],
      request.workspace, 120000, validationEnvironment(process.env))).stdout.trim();
    requireThat(await git(['rev-parse', 'HEAD']) === request.baseRevision &&
      await git(['status', '--porcelain']) === '',
    'Authoring qualification requires a clean isolated exact-base checkout', 'blocked-reconciliation');
    return await runRemoteValidationOperation(config, ledger,
      { id: authorization.assignmentId, workspace: request.workspace },
      { ...repo, remoteValidation: { type: 'agency-workspace-authoring',
        contractPath: request.contractPath, contractSha256: request.contractSha256 } },
      request.baseRevision, contract, async (...args) => {
        await requireWorkspaceAuthoringSource(config, ledger, repo, request, contract);
        return { ...await verifyWorkspaceAuthoring(...args), sourceAuthorization: authorization };
      }, options, dependencies, 'agency-workspace-authoring');
  } finally { ledger.release(lock, owner); }
}

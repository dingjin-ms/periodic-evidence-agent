import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { hash, json, now, positive, requireThat, validateRecord } from './common.js';
import { describeAgent } from './agents.js';
import { persistReviewedInvestigation } from './coordinator.js';
import { importCapturedEvidence } from './filter-handoff.js';
import { planImprovement } from './improvements.js';
import { requireEligibleImprovementInvestigation } from './review-decisions.js';
import { command, minimalEnvironment } from './workers.js';

function pinnedBytes(reference) {
  requireThat(reference && typeof reference.path === 'string' && isAbsolute(reference.path) &&
    /^[a-f0-9]{64}$/.test(reference.sha256 ?? ''),
  'Recorded role input requires an absolute path and SHA256', 'blocked-reconciliation');
  const bytes = readFileSync(reference.path);
  requireThat(hash(bytes) === reference.sha256,
    'Recorded role input changed', 'blocked-reconciliation');
  return bytes;
}

function pinnedJson(reference) {
  const bytes = pinnedBytes(reference);
  return { value: JSON.parse(bytes.toString('utf8')), bytes };
}

function heldReplay(config, ledger) {
  requireThat(config.statePolicy.accessApproved === true && !config.activation.collect &&
    !config.activation.dispatch && realpathSync(config.stateDirectory) === realpathSync(ledger.directory),
  'Recorded role replay requires approved separate storage with collection and dispatch disabled',
  'blocked-authorization');
  requireThat(ledger.status().jobs.length === 0,
    'Recorded role replay cannot use a worker ledger', 'blocked-reconciliation');
}

function recordReference(record) {
  return { kind: record.recordType, id: record.id, version: record.version ?? 1,
    sha256: hash(json(record)) };
}

export async function roleExecutionIdentity(role) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const environment = minimalEnvironment();
  const revision = await command('git', ['rev-parse', 'HEAD'], root, 30000, environment);
  const status = await command('git', ['status', '--porcelain', '--untracked-files=no'], root, 30000, environment);
  const definition = describeAgent(role);
  return { controllerRevision: revision.stdout.trim(), controllerTrackedTreeClean: !status.stdout.trim(),
    adapterSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
    skill: definition.skill, procedures: definition.procedures };
}

function receipt(db, reference, kind) {
  requireThat(reference && typeof reference.operationId === 'string' &&
    /^[a-f0-9]{64}$/.test(reference.sha256 ?? ''),
  'Recorded role receipt reference is required', 'blocked-reconciliation');
  const row = db.prepare('SELECT kind,state,detail FROM operations WHERE id=?').get(reference.operationId);
  requireThat(row?.kind === kind && row.state === 'recorded' && hash(row.detail) === reference.sha256,
    'Recorded role receipt is missing, incomplete or changed', 'blocked-reconciliation');
  return JSON.parse(row.detail);
}

function persistReceipt(ledger, kind, input, detail) {
  const operationId = `${kind}:${hash(json(input))}`;
  const previous = ledger.db.prepare('SELECT kind,state,detail FROM operations WHERE id=?').get(operationId);
  if (previous) {
    requireThat(previous.kind === kind && previous.state === 'recorded',
      'Recorded role operation requires reconciliation', 'blocked-reconciliation');
    const result = JSON.parse(previous.detail);
    requireThat(result.inputSha256 === hash(json(input)),
      'Recorded role replay input conflicts with its receipt', 'blocked-reconciliation');
    return { ...result, recordedRoleHandoff: {
      stateDirectory: realpathSync(ledger.directory), operationId, sha256: hash(previous.detail)
    } };
  }
  const result = { ...detail, inputSha256: hash(json(input)), recordedAt: now() };
  ledger.operation(operationId, detail.assignmentId ?? operationId, kind, result);
  ledger.finishOperation(operationId, 'recorded', result);
  return { ...result, recordedRoleHandoff: {
    stateDirectory: realpathSync(ledger.directory), operationId, sha256: hash(json(result))
  } };
}

export async function replayRecordedEvidence(config, ledger, input) {
  heldReplay(config, ledger);
  requireThat(input?.format === 'recorded-evidence-replay-v1' &&
    Array.isArray(input.evidence) && input.evidence.length > 0,
  'Recorded evidence replay requires an explicit nonempty inventory', 'blocked-reconciliation');
  requireThat(input.evidence.length <= positive(config.limits.maxItems, 'maxItems'),
    'Recorded evidence inventory exceeds its configured item bound', 'blocked-scope');
  const evidence = [], captures = [];
  for (const item of input.evidence) {
    const record = pinnedJson(item.record).value;
    validateRecord(record, 'evidence');
    requireThat(record.source.provenance !== 'synthetic',
      'Recorded role replay does not accept synthetic evidence', 'blocked-scope');
    const capture = pinnedJson(item.capture);
    requireThat(record.capture.sha256 === item.capture.sha256 &&
      hash(json(capture.value)) === record.capture.sha256,
    'Recorded evidence capture is not the original canonical source payload', 'blocked-reconciliation');
    evidence.push(record);
    captures.push({ sha256: record.capture.sha256, contentBase64: capture.bytes.toString('base64') });
  }
  requireThat(new Set(evidence.map(record => record.id)).size === evidence.length,
    'Recorded evidence inventory contains duplicate identities', 'blocked-reconciliation');
  const execution = await roleExecutionIdentity('collector');
  return ledger.transaction(() => {
    const records = importCapturedEvidence(ledger, {
      retainedIds: evidence.map(record => record.id), cohortId: hash(json(input))
    }, { evidence, captures, index: { sources: [{ window: config.window }] } }, 'collector-replay');
    return persistReceipt(ledger, 'recorded-collector-import', input, {
      format: 'recorded-collector-result-v1', execution,
      mode: 'saved-evidence-import', freshCollection: false, completeSourceCoverage: false,
      recordReferences: records.map(recordReference),
      captureReferences: records.map(record => ({ evidenceId: record.id, sha256: record.capture.sha256 })),
      runIds: ledger.db.prepare('SELECT id FROM runs WHERE source=?')
        .all(`collector-replay:${hash(json(input))}`).map(row => row.id)
    });
  });
}

export async function replayRecordedReview(config, ledger, input) {
  heldReplay(config, ledger);
  requireThat(input?.format === 'recorded-review-replay-v1' &&
    typeof input.collectorReceipt?.stateDirectory === 'string' &&
    realpathSync(input.collectorReceipt?.stateDirectory) === realpathSync(ledger.directory),
  'Recorded review requires the same held Collector ledger', 'blocked-reconciliation');
  const collector = receipt(ledger.db, input.collectorReceipt, 'recorded-collector-import');
  const review = pinnedJson(input.review).value;
  const improvement = pinnedJson(input.improvement).value;
  const plan = pinnedJson(input.testCoveragePlan).value;
  const planningInput = pinnedJson(input.planningInput).value;
  const assignment = pinnedJson(input.assignment).value;
  requireThat(['captured-inputs', 'recovered-input-projection'].includes(input.inputProvenance?.mode),
    'Recorded review must distinguish captured inputs from recovered projections', 'blocked-reconciliation');
  if (input.inputProvenance.mode === 'recovered-input-projection') {
    requireThat(Array.isArray(input.inputProvenance.sources) && input.inputProvenance.sources.length > 0,
      'Recovered inputs require pinned original recovery artifacts', 'blocked-reconciliation');
    input.inputProvenance.sources.forEach(pinnedBytes);
  }
  validateRecord(assignment, 'assignment');
  validateRecord(improvement, 'areaToImprove');
  validateRecord(plan, 'testCoveragePlan');
  requireThat(json(collector.recordReferences.map(record => record.id)) === json(assignment.evidenceIds) &&
    json(review.investigation?.evidenceIds) === json(assignment.evidenceIds) &&
    review.investigation?.id === assignment.investigationId &&
    review.investigation?.version === assignment.investigationVersion &&
    improvement.id === assignment.improvementId && improvement.version === assignment.improvementVersion &&
    plan.id === assignment.testCoveragePlanId && plan.version === assignment.testCoveragePlanVersion &&
    plan.sourceRevision === assignment.skillQualification?.baseRevision,
  'Recorded review does not match the original assignment and source versions', 'blocked-reconciliation');
  const execution = await roleExecutionIdentity('filter');
  return ledger.transaction(() => {
    const investigation = persistReviewedInvestigation(config, ledger, review, {
      allowImportedInitialVersion: true, allowIdempotentReplay: true
    });
    requireEligibleImprovementInvestigation(investigation);
    ledger.put(improvement);
    ledger.put(plan);
    const replayed = planImprovement(ledger, planningInput);
    requireThat(json(replayed.improvement) === json(improvement) &&
      json(replayed.testCoveragePlan) === json(plan),
    'Recorded planning input changed the original decision', 'blocked-reconciliation');
    return persistReceipt(ledger, 'recorded-filter-replay', input, {
      format: 'recorded-filter-result-v1', execution,
      mode: 'saved-review-replay', freshReview: false, completeCohortAcceptance: false,
      held: true, dispatchAllowed: false, collectorReceipt: input.collectorReceipt,
      inputProvenance: input.inputProvenance,
      assignmentId: assignment.id, assignmentSha256: hash(json(assignment)),
      sourceRevision: plan.sourceRevision,
      recordReferences: [investigation, improvement, plan].map(recordReference)
    });
  });
}

export function verifyRecordedRoleHandoff(reference, previousLedger, previousAssignmentId) {
  requireThat(reference && typeof reference.stateDirectory === 'string' &&
    isAbsolute(reference.stateDirectory) &&
    realpathSync(reference.stateDirectory) !== realpathSync(previousLedger.directory),
  'Continuation requires a separate recorded role handoff ledger', 'blocked-reconciliation');
  const db = new DatabaseSync(join(reference.stateDirectory, 'ledger.sqlite'), { readOnly: true });
  try {
    const filtered = receipt(db, reference, 'recorded-filter-replay');
    const collected = receipt(db, filtered.collectorReceipt, 'recorded-collector-import');
    const assignment = previousLedger.get('assignment', previousAssignmentId);
    requireThat(assignment && filtered.format === 'recorded-filter-result-v1' &&
      collected.format === 'recorded-collector-result-v1' && filtered.assignmentId === assignment.id &&
      filtered.assignmentSha256 === hash(json(assignment)) &&
      filtered.sourceRevision === assignment.skillQualification?.baseRevision &&
      filtered.held === true && filtered.dispatchAllowed === false &&
      filtered.freshReview === false && filtered.completeCohortAcceptance === false &&
      collected.freshCollection === false && collected.completeSourceCoverage === false &&
      json(collected.recordReferences.map(record => record.id)) === json(assignment.evidenceIds),
    'Recorded role handoff does not bind the preserved assignment', 'blocked-reconciliation');
    const expected = [
      { kind: 'investigation', id: assignment.investigationId, version: assignment.investigationVersion },
      { kind: 'areaToImprove', id: assignment.improvementId, version: assignment.improvementVersion },
      { kind: 'testCoveragePlan', id: assignment.testCoveragePlanId, version: assignment.testCoveragePlanVersion }
    ];
    requireThat(json(filtered.recordReferences.map(({ kind, id, version }) => ({ kind, id, version }))) ===
      json(expected) && collected.recordReferences.every(ref => ref.kind === 'evidence') &&
      json(collected.captureReferences.map(ref => ref.evidenceId)) === json(assignment.evidenceIds),
    'Recorded role handoff has incomplete record or capture coverage', 'blocked-reconciliation');
    for (const ref of [...collected.recordReferences, ...filtered.recordReferences]) {
      const row = db.prepare('SELECT body FROM records WHERE kind=? AND id=? AND version=?')
        .get(ref.kind, ref.id, ref.version);
      const original = previousLedger.get(ref.kind, ref.id, ref.version);
      requireThat(row && original && hash(row.body) === ref.sha256 &&
        hash(json(original)) === ref.sha256 &&
        json(previousLedger.get(ref.kind, ref.id)) === json(original),
      'Recorded role handoff has missing, changed or superseded source records', 'blocked-reconciliation');
    }
    for (const ref of collected.captureReferences) {
      const replayed = db.prepare('SELECT body FROM captures WHERE hash=?').get(ref.sha256);
      const original = previousLedger.db.prepare('SELECT body FROM captures WHERE hash=?').get(ref.sha256);
      requireThat(replayed && original && hash(replayed.body) === ref.sha256 && hash(original.body) === ref.sha256,
        'Recorded role handoff capture changed', 'blocked-reconciliation');
    }
    return { ...reference, assignmentId: assignment.id,
      collectorReceipt: filtered.collectorReceipt, sourceRevision: filtered.sourceRevision };
  } finally { db.close(); }
}

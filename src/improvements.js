import { hash, json, now, requireThat, validateRecord } from './common.js';
import { requireEligibleImprovementInvestigation, validateExistingFixesReview } from './review-decisions.js';

function texts(values, name) {
  requireThat(Array.isArray(values) && values.length > 0 &&
    values.every(value => typeof value === 'string' && value.length > 0), `${name} must contain nonempty strings`);
  return [...new Set(values)].sort();
}

function comparable(record) {
  const copy = structuredClone(record);
  delete copy.version;
  delete copy.createdAt;
  delete copy.updatedAt;
  return json(copy);
}

export function recordAreaToImprove(ledger, input) {
  const investigationIds = texts(input.investigationIds, 'investigationIds');
  const investigations = investigationIds.map(id => ledger.get('investigation', id));
  requireThat(investigations.every(Boolean), 'Area-to-improve references an unknown investigation', 'invalid-record');
  investigations.forEach(requireEligibleImprovementInvestigation);
  requireThat(investigations.every(investigation =>
    ledger.get('investigation', investigation.id)?.version === investigation.version),
  'Area-to-improve references a superseded investigation', 'blocked-reconciliation');

  const evidenceIds = texts(input.evidenceIds ??
    investigations.flatMap(investigation => investigation.evidenceIds), 'evidenceIds');
  const latestEvidence = new Set(ledger.latestEvidence().map(evidence => evidence.id));
  requireThat(evidenceIds.every(id => latestEvidence.has(id)), 'Area-to-improve references missing or superseded evidence',
    'blocked-reconciliation');
  const repoIds = texts(input.repoIds, 'repoIds');
  const capabilities = texts(input.capabilities, 'capabilities');
  const aggregationKey = json([
    input.category,
    input.theme.trim().toLowerCase().replace(/\s+/g, ' '),
    repoIds,
    capabilities
  ]);
  const id = `improvement-${hash(aggregationKey)}`;
  const previous = ledger.get('areaToImprove', id);
  const timestamp = now();
  const record = {
    recordType: 'areaToImprove', schemaVersion: '1.0', id,
    version: (previous?.version ?? 0) + 1, aggregationKey,
    investigationIds, evidenceIds, category: input.category,
    state: input.state ?? 'routing-pending',
    observedBehavior: input.observedBehavior,
    expectedBehavior: input.expectedBehavior ?? null,
    rationale: input.rationale, priority: input.priority ?? 'medium',
    repoIds, capabilities,
    createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp
  };
  validateRecord(record);
  if (previous && comparable(previous) === comparable(record)) return previous;
  return ledger.put(record);
}

export function recordTestCoveragePlan(ledger, input) {
  const improvement = ledger.get('areaToImprove', input.improvementId);
  requireThat(improvement && improvement.version === input.improvementVersion,
    'Test coverage plan references a missing or superseded improvement', 'blocked-reconciliation');
  requireThat(improvement.repoIds.includes(input.repoId) && improvement.capabilities.includes(input.capability),
    'Test coverage plan routing is outside the improvement bounds', 'blocked-scope');
  const existingTests = [...new Map((input.existingTests ?? []).map(test =>
    [json([test.path, test.identifier]), { path: test.path, identifier: test.identifier }])).values()]
    .sort((a, b) => json(a).localeCompare(json(b)));
  const coverageGaps = [...new Set(input.coverageGaps ?? [])].sort();
  const unknowns = [...new Set(input.unknowns ?? [])].sort();
  let disposition = 'unknown';
  if (existingTests.length) disposition = 'linked';
  else if (input.searchStatus === 'complete' && coverageGaps.length) disposition = 'coverage-gap';
  else if (!unknowns.length) unknowns.push('Repository test coverage was not completely established.');
  if (input.searchStatus === 'complete' || disposition !== 'unknown')
    requireThat(/^[a-f0-9]{40,64}$/.test(input.sourceRevision ?? ''),
      'Complete or linked test coverage must be bound to a repository commit',
      'blocked-reconciliation');
  const id = `test-plan-${hash(json([improvement.id, improvement.version, input.repoId, input.capability]))}`;
  const previous = ledger.get('testCoveragePlan', id);
  const record = {
    recordType: 'testCoveragePlan', schemaVersion: '1.0', id,
    version: (previous?.version ?? 0) + 1,
    improvementId: improvement.id, improvementVersion: improvement.version,
    repoId: input.repoId, capability: input.capability,
    sourceRevision: input.sourceRevision ?? null,
    searchStatus: input.searchStatus, disposition, existingTests,
    coverageGaps, unknowns, rationale: input.rationale,
    ...(input.skillInput ? { skillInput: structuredClone(input.skillInput) } : {}),
    ...(input.existingFixesReview !== undefined ? { existingFixesReview: structuredClone(input.existingFixesReview) } : {}),
    createdAt: now()
  };
  validateRecord(record);
  const result = previous && comparable(previous) === comparable(record) ? previous : record;
  if (result.existingFixesReview) {
    const investigation = ledger.get('investigation', result.existingFixesReview.investigationId);
    requireThat(investigation && improvement.investigationIds.includes(investigation.id),
      'Existing fix review does not reference an investigation in this improvement', 'blocked-reconciliation');
    validateExistingFixesReview(investigation, result);
  }
  return result === previous ? previous : ledger.put(result);
}

export function planImprovement(ledger, input) {
  requireThat(input && typeof input === 'object' && input.improvement && input.testCoverage,
    'Improvement planning requires improvement and testCoverage inputs', 'invalid-record');
  const improvement = recordAreaToImprove(ledger, input.improvement);
  const testCoveragePlan = recordTestCoveragePlan(ledger, {
    ...input.testCoverage,
    improvementId: improvement.id,
    improvementVersion: improvement.version
  });
  return { improvement, testCoveragePlan };
}

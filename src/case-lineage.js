import { hash, json, requireThat } from './common.js';
import { approvedCaseBatch, completedOperation, operationRow } from './case-generation.js';

export function requireGeneratedCaseLineage(config, ledger, item, { execution = false, sourceRevision } = {}) {
  const mappings = ledger.status().operations.filter(row => row.kind === 'case-ado-mapping' && row.state === 'complete')
    .map(row => JSON.parse(row.detail)).filter(mapping => mapping.itemId === item.id);
  const marked = item.fields?.['System.Description']?.includes('GeneratedCaseOrigin:') ||
    item.fields?.['System.Tags']?.split(';').map(tag => tag.trim()).includes('GeneratedCaseRequest');
  if (!marked && mappings.length === 0) return null;
  requireThat(mappings.length === 1, 'Generated request lacks trusted local lineage; marker is not authority', 'blocked-reconciliation');
  const mapping = mappings[0], { batch, bundle } = approvedCaseBatch(config, ledger, mapping.batchId);
  const destination = bundle.admission.destination;
  requireThat(sourceRevision === undefined || sourceRevision === bundle.admission.repositoryRevision,
    'Generated-case coverage discovery revision changed from its approved baseline', 'blocked-reconciliation');
  requireThat(config.adoTestRequests?.organization === destination.organization &&
    config.adoTestRequests?.project === destination.project && config.adoTestRequests?.repoId === bundle.admission.repoId,
  'Generated request belongs to a different configured destination or repository', 'blocked-scope');
  const canonical = batch.draft.cases.find(value => value.id === mapping.caseId);
  const receipt = completedOperation(ledger, `${mapping.batchId}:publication:${mapping.caseId}`, 'case-publication');
  const verified = completedOperation(ledger, `${mapping.batchId}:publication:${mapping.caseId}:verification`, 'case-publication-verification');
  requireThat(verified.state === 'verified' && verified.publicationSha256 === hash(json(receipt)),
    'Generated publication is currently held after verification failure', 'blocked-reconciliation');
  requireThat(canonical && canonical.revision === mapping.caseRevision && json(mapping) === json(receipt) &&
    item.rev === receipt.revision && Object.entries(receipt.fields).every(([key, value]) => item.fields[key] === value),
  'Generated request differs from the approved publication revision', 'blocked-reconciliation');
  requireThat(canonical.blockers.length === 0 && !batch.draft.conflicts.some(conflict =>
    conflict.requirementIds.some(id => batch.draft.requirements.find(requirement => requirement.id === id)?.caseIds.includes(canonical.id))),
  'Generated expectations have unresolved blockers or conflicts', 'blocked-result');
  // Attachment verification is not a native input capability. Do not silently drop fixtures.
  if (execution) {
    const route = config.caseGeneration.workflow2;
    requireThat(route?.enabled === true && route.scopeApproved === true && route.approvalRef?.trim() &&
      route.layer === 'e2e' && route.repoId === bundle.admission.repoId &&
      route.capability === config.adoTestRequests.capability && !/integration|harness/i.test(route.capability) &&
      config.adoTestRequests.automation?.requireSupportMatrix === true,
    'Generated E2E cases need an explicitly approved E2E route and independent native support assessment', 'blocked-capability');
    requireThat(canonical.fixtureIds.length === 0,
      'Generated request needs a qualified native fixture-access adapter; attachment existence is insufficient', 'blocked-fixture-access');
  }
  const bindingId = `${mapping.batchId}:intake:${mapping.caseId}`;
  if (operationRow(ledger, bindingId)) {
    const binding = completedOperation(ledger, bindingId, 'case-request-lineage');
    requireThat(binding.publicationSha256 === hash(json(receipt)), 'Generated request lineage binding changed', 'blocked-reconciliation');
  }
  return { batchId: mapping.batchId, caseId: mapping.caseId, requiredTestLayer: 'e2e', publicationSha256: hash(json(receipt)) };
}

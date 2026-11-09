import ExcelJS from 'exceljs';
import { readFileSync } from 'node:fs';
import { hash, json, requireThat } from './common.js';
import { casePolicy, completedOperation, loadCaseBatch, operationRow } from './case-generation.js';
import { casePublicationFields } from './case-publication.js';
import { completeRunEvidence, persistRunArtifact } from './state-retention.js';

const artifactLayout = 'case-artifact-layout-v2';
const refs = values => values.map(value => `${value.sourceId}: ${value.section}`).join('\n');
const list = values => values.length ? values.join('\n') : 'None';
const html = value => String(value ?? 'Unknown').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const cellHtml = value => typeof value === 'string' && /^https:\/\/[^\s]+$/.test(value)
  ? `<a href="${html(value)}">${html(value)}</a>` : html(value).replaceAll('\n', '<br>');
function table(rows) {
  if (!rows.length) return '<p>None.</p>';
  const keys = Object.keys(rows[0]);
  return `<table><thead><tr>${keys.map(key => `<th>${html(key)}</th>`).join('')}</tr></thead><tbody>` +
    rows.map(row => `<tr>${keys.map(key => `<td>${cellHtml(row[key])}</td>`).join('')}</tr>`).join('') +
    '</tbody></table>';
}
export function caseArtifactView(config, ledger, batchId) {
  casePolicy(config);
  const { batch, bundle } = loadCaseBatch(config, ledger, batchId, { verifyCurrentInputs: false });
  const generated = completedOperation(ledger, `${batch.bundleId}:draft`, 'case-generation-output');
  const publication = batch.draft.cases.map(item => {
    const row = operationRow(ledger, `${batchId}:publication:${item.id}`);
    if (row?.state === 'complete') {
      const receipt = JSON.parse(row.detail);
      const check = operationRow(ledger, `${row.id}:verification`);
      const detail = check ? JSON.parse(check.detail) : null;
      return detail?.state === 'blocked' ? { ...receipt, state: 'Previously published; latest verification blocked',
        error: detail.error.message, lastVerificationAt: detail.observedAt } : receipt;
    }
    const mutations = ledger.status().operations.filter(row => row.job_id === batchId &&
      row.id.startsWith(`${batchId}:publication:${item.id}:`));
    const created = mutations.find(row => row.id.endsWith(':create') && row.state === 'complete');
    const failures = mutations.filter(row => row.kind === 'case-publication-failure').map(row => JSON.parse(row.detail));
    return { caseId: item.id, state: created ? 'Item created; required publication verification incomplete'
      : failures.length ? 'Blocked' : 'Unpublished draft', itemId: created ? JSON.parse(created.detail).result.id : null,
    revision: null, operation: 'blocked', attachments: [], error: failures.at(-1)?.error?.message ?? 'Publication not performed' };
  });
  const delivery = batch.draft.cases.map(item => {
    const row = operationRow(ledger, `${batchId}:workflow2:${item.id}`);
    return { caseId: item.id, ...(row ? JSON.parse(row.detail) : { state: 'Not run' }) };
  });
  return { batchId, batch, bundle, generatedAt: generated.generatedAt, publication, delivery };
}
export function caseArtifactSheets(view) {
  const { batch, bundle, publication, delivery } = view, draft = batch.draft;
  const pub = id => publication.find(item => item.caseId === id);
  const counts = field => [...new Set(draft.cases.map(item => item[field]))]
    .map(value => `${value}: ${draft.cases.filter(item => item[field] === value).length}`).join('\n') || 'No selected cases';
  const coverage = kind => {
    const population = draft.requirements.filter(item => item.kind === kind && item.disposition !== 'not-applicable');
    return `${population.filter(item => item.depth === 'full').length}/${population.length} distinct ${kind} items with full designed coverage; not execution`;
  };
  return {
    'Read Me': [
      { Topic: 'Purpose', Detail: 'Source-driven proposed E2E cases. Design, publication and native execution are separate.' },
      { Topic: 'Scope and exclusions', Detail: bundle.admission.scope },
      { Topic: 'Baseline / artifact version', Detail: `${batch.baselineId} / canonical-case-batch-v1 / ${artifactLayout} / ${view.batchId}` },
      { Topic: 'Generated UTC', Detail: view.generatedAt },
      { Topic: 'Product / environment', Detail: `${bundle.admission.product}\n${bundle.admission.environment}` },
      { Topic: 'Selection count / approved ceiling', Detail: `${draft.cases.length} / ${configCeiling(view)}` },
      { Topic: 'Cadence (proposed only)', Detail: counts('cadence') },
      { Topic: 'Design readiness', Detail: counts('readiness') },
      { Topic: 'Status legend', Detail: 'Designed/automation-ready does not mean implemented. Published requires verified ADO fields and attachment downloads. Not run is not Passed. No schedules are installed.' },
      { Topic: 'Coverage denominators', Detail: ['requirement', 'checklist', 'bug'].map(coverage).join('\n') },
      { Topic: 'Validated scheduled protection', Detail: '0; this pipeline does not deploy or verify schedules. Current protection freshness is unverified.' },
      { Topic: 'Source limitations', Detail: list(bundle.sources.filter(source => source.access !== 'complete').map(source => `${source.id}: ${source.access}; ${source.limitations}`)) },
      { Topic: 'Source freshness', Detail: 'This projection uses captured snapshots only. Rendering does not retrieve sources or requalify current approval.' },
      { Topic: 'Navigation', Detail: 'Cases links to Steps and Test Files by stable ID. Coverage maps distinct requirements to cases. Sources retains export scope and trust; Decisions and Changes retains holds and history.' },
      { Topic: 'Long text', Detail: 'Rows expand for wrapped content within the Excel row-height limit. Use coverage.html for full text when an exceptionally long entry exceeds that limit. Desktop Excel visual inspection is separate.' }
    ],
    Cases: draft.cases.map(item => ({
      'Case ID': item.id, Revision: item.revision, Title: item.title, Objective: item.objective,
      Journey: item.journey, Risk: item.risk, 'Why E2E': item.e2eRationale, Priority: item.priority,
      Categories: list(item.categories), Reuse: item.existingTest ? `${item.existingTest.layer}: ${item.existingTest.path}` : 'New proposal',
      Owner: item.owner, 'Design readiness': item.readiness, Blockers: list(item.blockers),
      'Proposed cadence': item.cadence, 'Cadence reason': item.cadenceReason, Sources: refs(item.sourceRefs),
      'ADO ID': pub(item.id).itemId ?? 'Not created', 'ADO URL': pub(item.id).url ?? 'Unpublished',
      'ADO revision': pub(item.id).revision ?? 'Unknown', 'Publication status': pub(item.id).state,
      'Workflow 2 outcome': delivery.find(result => result.caseId === item.id)?.state ?? 'Not run',
      'Execution result': 'Not established by case design', 'Schedule state': 'Not deployed'
    })),
    Steps: draft.cases.flatMap(item => item.steps.map(step => ({
      'Case ID': item.id, Revision: item.revision, Number: step.number, Phase: step.phase,
      Action: step.action, 'Input / fixture': step.input, 'Expected result': step.expected,
      Evidence: step.evidence, Sources: refs(step.sourceRefs), 'Timeout ms': step.timeoutMs ?? 'Unknown'
    }))),
    'Test Files': draft.cases.flatMap(item => item.fixtureIds.length ? item.fixtureIds.map(id => {
      const file = bundle.admission.fixtures.find(file => file.id === id);
      const attached = pub(item.id).attachments.find(attachment => attachment.fixtureId === id);
      return { 'Case ID': item.id, Revision: item.revision, 'File ID': id, Name: file.name,
        Required: 'Required', 'Referenced steps': item.steps.filter(step => step.input.includes(id)).map(step => step.number).join(', ') || 'See case inputs',
        Purpose: file.purpose, Provenance: file.provenance, Version: file.version, Bytes: file.size ?? 'Missing', SHA256: file.sha256 ?? 'Missing',
        Handling: `${file.handling}\n${file.blocker ?? ''}`, 'Sharing approval': file.shareApprovalRef ?? 'Not approved', 'Attachment ID': attached?.attachmentId ?? 'Not verified',
        'Attachment URL': attached?.url ?? 'Not verified', 'Linked item': attached?.itemId ?? 'Not verified',
        'Verified UTC': attached?.verifiedAt ?? 'Not verified', 'Native access': 'Held until a qualified native fixture adapter is available' };
    }) : [{ 'Case ID': item.id, Revision: item.revision, 'File ID': 'None', Name: 'No test files required',
      Required: 'None', 'Referenced steps': 'None', Purpose: item.noFilesReason, Provenance: 'Not applicable',
      Version: 'Not applicable', Bytes: 0, SHA256: 'Not applicable', Handling: 'Not applicable',
      'Sharing approval': 'Not applicable', 'Attachment ID': 'Not applicable', 'Attachment URL': 'Not applicable',
      'Linked item': pub(item.id).itemId ?? 'Not created', 'Verified UTC': 'Not applicable', 'Native access': 'No files required' }]),
    'Execution Plan': draft.cases.map(item => ({ 'Case ID': item.id, Revision: item.revision,
      Configurations: item.executionPlan.configurationCount, 'Parameter rows': item.executionPlan.parameterRows,
      'Projected executions': item.executionPlan.projectedExecutions, Environment: item.executionPlan.environment,
      'Identity role': item.executionPlan.identityRole, Versions: item.executionPlan.versions, Dependencies: item.executionPlan.dependencies,
      'Proposed trigger': item.executionPlan.proposedTrigger, 'Time zone': item.executionPlan.timeZone,
      'Estimated runtime ms': item.executionPlan.estimatedRuntimeMs ?? 'Unknown', 'Measured runtime': 'Not run',
      'Timeout ms': item.executionPlan.timeoutMs ?? 'Unknown', Retries: item.executionPlan.retries,
      Isolation: item.executionPlan.isolation, Cleanup: item.executionPlan.cleanup, Diagnostics: item.executionPlan.diagnostics,
      'Triage owner': item.executionPlan.triageOwner, 'Design readiness evidence': list(item.executionPlan.readinessEvidence),
      'Active schedule': 'None' })),
    Coverage: draft.requirements.map(item => ({ 'Requirement ID': item.id, Kind: item.kind, Behavior: item.behavior,
      Sources: refs(item.sourceRefs), 'Case IDs': list(item.caseIds), Disposition: item.disposition, 'Design depth': item.depth,
      Reason: item.reason, 'Residual risk': item.residualRisk, Owner: item.owner, 'Next action': item.nextAction,
      'Latest execution': 'Not established', 'Source baseline': batch.baselineId })),
    Sources: bundle.sources.map(source => ({
      'Source ID': source.id, Type: source.type, Title: source.title, URL: source.url,
      Revision: source.revision ?? 'Provider revision unavailable; snapshot hash only',
      'Modified UTC': source.modifiedAt ?? 'Unknown', 'Retrieved UTC': source.retrievedAt,
      Approval: source.approval, Applicability: source.applicability, Access: source.access,
      Limitations: source.limitations, SHA256: source.sha256 ?? 'Unavailable', 'Atomic items': list(source.itemIds)
    })),
    'Decisions and Changes': [
      ...draft.decisions.map(detail => ({ Kind: 'Decision', ID: batch.baselineId, Detail: detail })),
      ...draft.conflicts.map(conflict => ({ Kind: 'Unresolved conflict', ID: list(conflict.requirementIds),
        Detail: `${conflict.reason}\n${refs(conflict.sourceRefs)}\nOwner: ${conflict.owner}\nNext: ${conflict.nextAction}` })),
      ...batch.changes.map(change => ({ Kind: change.change, ID: change.caseId, Detail: `Case revision: ${change.revision ?? 'Retired'}` })),
      ...publication.map(receipt => ({ Kind: 'Publication', ID: receipt.caseId,
        Detail: `${receipt.state}; ADO ${receipt.itemId ?? 'not created'}, revision ${receipt.revision ?? 'unknown'}\n${receipt.error ?? receipt.verifiedAt ?? ''}` })),
      ...delivery.map(result => ({ Kind: 'Workflow 2', ID: result.caseId, Detail: `${result.state}; ${result.assignmentId ?? 'No assignment'}; ${result.publication ?? 'No PR'}` }))
    ]
  };
}
function configCeiling(view) {
  return view.bundle.caseCeiling;
}
export async function renderCaseArtifacts(config, ledger, batchId) {
  const view = caseArtifactView(config, ledger, batchId);
  // Version the layout so a re-render never overwrites previously registered evidence.
  const sheets = caseArtifactSheets(view), id = `case-artifacts-${hash(json({ layout: artifactLayout, view }))}`;
  if (operationRow(ledger, id)?.state === 'complete') {
    const receipt = completedOperation(ledger, id, 'case-artifacts');
    for (const artifact of receipt.artifacts) requireThat(hash(readFileSync(artifact.path)) === artifact.sha256,
      'Rendered artifact bytes changed after registration', 'blocked-reconciliation');
    return receipt;
  }
  requireThat(!operationRow(ledger, id), 'Artifact rendering was interrupted; preserve evidence and reconcile', 'blocked-reconciliation');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'periodic-evidence-agent';
  workbook.created = new Date(view.generatedAt);
  workbook.modified = new Date(view.generatedAt);
  for (const [name, rows] of Object.entries(sheets)) {
    const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    const keys = Object.keys(rows[0] ?? { Status: '' });
    sheet.columns = keys.map(key => ({ header: key, key, width: /ID|Revision|Number|Bytes/.test(key) ? 20 : 48 }));
    for (const row of rows) {
      const added = sheet.addRow(row);
      let wrappedLines = 1;
      added.eachCell(cell => {
        requireThat(String(cell.value).length <= 32767, 'Workbook cell exceeds Excel text limits; refine the case batch', 'blocked-budget');
        const width = Math.max(1, sheet.getColumn(cell.col).width - 4);
        wrappedLines = Math.max(wrappedLines, String(cell.value ?? '').split(/\r?\n/).reduce(
          (count, line) => count + Math.max(1, Math.ceil(line.length / width)), 0));
        if (typeof cell.value === 'string' && /^https:\/\/[^\s]+$/.test(cell.value))
          cell.value = { text: cell.value, hyperlink: cell.value };
        cell.alignment = { vertical: 'top', wrapText: true };
      });
      added.height = Math.min(409.5, Math.max(75, wrappedLines * 15 + 10));
    }
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).height = 30;
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, sheet.rowCount), column: keys.length } };
  }
  const sections = [
    ['Executive summary', sheets['Read Me']],
    ['Source inventory and trust', sheets.Sources],
    ['Selected regression protection', sheets.Cases],
    ['Coverage and gaps', sheets.Coverage],
    ['Not covered and why', sheets.Coverage.filter(row => !['selected', 'reused'].includes(row.Disposition) || row['Design depth'] !== 'full')],
    ['Automation operations', sheets['Execution Plan']],
    ['Versions and iteration changes', [{ Baseline: view.batch.baselineId, Previous: view.batch.previousBatchId ?? 'None',
      Controller: view.bundle.controllerRevision, Repository: view.bundle.admission.repositoryRevision,
      'Prompt SHA256': view.bundle.promptSha256, 'Configuration SHA256': view.bundle.configSha256,
      'Generated UTC': view.generatedAt }, ...sheets['Decisions and Changes'].filter(row => ['added', 'changed', 'unchanged', 'retired'].includes(row.Kind))
      .map(row => ({ Baseline: row.ID, Previous: row.Kind, Controller: row.Detail, Repository: '', 'Prompt SHA256': '', 'Configuration SHA256': '', 'Generated UTC': '' }))]],
    ['Publication and quality review', sheets['Decisions and Changes']]
  ];
  const report = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Case coverage and decisions</title>' +
    '<style>body{font-family:Segoe UI,sans-serif}table{border-collapse:collapse}td,th{border:1px solid #888;padding:8px;vertical-align:top}h2{margin-top:2em}</style>' +
    `<h1>Case coverage and decisions: ${html(view.batch.baselineId)}</h1>` +
    sections.map(([title, rows], index) => `<h2>${index + 1}. ${title}</h2>${table(rows)}`).join('') +
    `<h3>Detailed steps</h3>${table(sheets.Steps)}<h3>Required files</h3>${table(sheets['Test Files'])}` +
    '<p>Workbook: <a href="cases.xlsx">cases.xlsx</a>. XLSX structure is checked by automated tests; desktop Excel visual inspection and live product qualification are separate.</p></html>';
  const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());
  const checked = new ExcelJS.Workbook();
  await checked.xlsx.load(xlsx);
  requireThat(checked.worksheets.length === 8 && checked.getWorksheet('Cases').rowCount === view.batch.draft.cases.length + 1,
    'Workbook structural validation failed', 'blocked-result');
  ledger.operation(id, batchId, 'case-artifacts', {});
  const artifacts = [
    persistRunArtifact(config, id, 'cases.xlsx', xlsx),
    persistRunArtifact(config, id, 'coverage.html', report),
    persistRunArtifact(config, id, 'publication-manifest.json', json({ format: 'case-publication-manifest-v1',
      batchId, baselineId: view.batch.baselineId, mappingVerified: Boolean(view.bundle.admission.destination.template.verifiedAt),
      destination: view.bundle.admission.destination, cases: view.batch.draft.cases.map(item => ({
        caseId: item.id, revision: item.revision, fields: casePublicationFields(view.bundle, item),
        fixtureIds: item.fixtureIds, publication: view.publication.find(result => result.caseId === item.id) })) }))
  ];
  completeRunEvidence(config, id);
  const receipt = { format: 'case-artifacts-receipt-v1', state: 'rendered', batchId, artifacts, schedulesDeployed: false };
  ledger.finishOperation(id, 'complete', receipt);
  return receipt;
}

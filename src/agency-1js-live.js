import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { hash, now, requireThat, PilotError, safeError } from './common.js';
import { nativeCommand } from './native-command.js';

const adoScope = '499b84ac-1321-427f-aa17-267ca6975798/.default';
const agencyScope = 'api://81bbac67-d541-4a6d-a48b-b1c0f9a57888/.default';
const agencyRoot = 'https://copilotswe.app.prod.gitops.startclean.microsoft.com/api/agency';
const revision = /^[a-f0-9]{40}$/;

export function oneJsLiveRequest(overrides = {}) {
  const branch = overrides.branch ?? 'user/dingjin/pea-1js-agency-same-workspace-authoring-20261102';
  const sourceRevision = overrides.sourceRevision ?? '7b5304e5d2684f78c34ff88ebe46bb7674ad1484';
  return {
    schema: 'pea-1js-agency-live-request-v1',
    sourceRevision,
    branch,
    orchestratorDefinitionId: 37948,
    runnerDefinitionId: 35960,
    profile: 'bizchat-excel-five-by-four-v1',
    scenario: 'bizchat-create-excel-five-by-four',
    expected: { fileName: 'AgencyLive.xlsx', worksheet: 'AgencyLive', rows: 5, columns: 4,
      headerRows: 1, dataRows: 4 },
    maximumMinutes: 75,
    pollSeconds: 30,
    payload: {
      templateParameters: {
        workItemId: 11590949, maxConcurrentJobs: 1, nativeCrossOfficeScenario: 'None',
        nativeCrossOfficeAuthoringProfile: 'bizchat-excel-five-by-four-v1',
        agencyModel: 'claude-opus-4.8', testCaseTagFilter: 'None', testCaseIds: '12057194',
        agencyServiceConnection: '1js-agency-connection', agentBaseBranch: branch,
        debugSimulatePrId: 'None',
        testSuiteUrl: 'https://office.visualstudio.com/OC/_testPlans/define?planId=11940271&suiteId=12093434',
        dryRun: false, maxPollAttempts: 100, tripsRing: 'DF', batchSize: 1, pipelineId: 35960,
        app: 'excel', pollIntervalSeconds: 30, pipelineRef: branch, urlOverride: 'None',
        tags: 'PEA-1JS-Same-Workspace-Live-5x4', tripsServiceConnection: 'pptAgencyTripsSC'
      },
      resources: { repositories: { self: { refName: `refs/heads/${branch}` } } }
    }
  };
}

function validateRequest(request) {
  requireThat(request?.schema === 'pea-1js-agency-live-request-v1' && revision.test(request.sourceRevision) &&
    /^user\/dingjin\/[A-Za-z0-9._/-]+$/.test(request.branch) &&
    request.orchestratorDefinitionId === 37948 && request.runnerDefinitionId === 35960 &&
    request.payload?.templateParameters?.nativeCrossOfficeScenario === 'None' &&
    request.payload.templateParameters.nativeCrossOfficeAuthoringProfile === request.profile &&
    request.payload.templateParameters.maxConcurrentJobs === 1 && request.payload.templateParameters.batchSize === 1 &&
    request.payload.templateParameters.pipelineRef === request.branch &&
    request.payload.templateParameters.agentBaseBranch === request.branch &&
    request.payload.resources.repositories.self.refName === `refs/heads/${request.branch}`,
  '1JS live request is outside the fixed single-job same-workspace contract', 'blocked-config');
}

function files(root, name, found = []) {
  if (!existsSync(root)) return found;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files(path, name, found);
    else if (entry.name === name && !path.replaceAll('\\', '/').includes('/attachments/')) found.push(path);
  }
  return found;
}

function zipEntries(bytes) {
  const result = new Map();
  for (let offset = 0; offset + 30 <= bytes.length;) {
    if (bytes.readUInt32LE(offset) !== 0x04034b50) { offset++; continue; }
    const method = bytes.readUInt16LE(offset + 8), compressed = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26), extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength, data = bytes.subarray(start, start + compressed);
    if (method === 0) result.set(name, data);
    else if (method === 8) result.set(name, inflateRawSync(data));
    offset = start + compressed;
  }
  return result;
}

function relationshipTarget(source, predicate) {
  for (const element of source?.match(/<Relationship\b[^>]*>/g) ?? []) {
    const attributes = Object.fromEntries([...element.matchAll(/([A-Za-z:]+)="([^"]*)"/g)]
      .map(match => [match[1], match[2]]));
    if (predicate(attributes)) return attributes.Target;
  }
  return undefined;
}

export function verifyOneJsLiveArtifact(root, request, observation, productRepositoryPath) {
  validateRequest(request);
  requireThat(isAbsolute(productRepositoryPath ?? '') && existsSync(join(productRepositoryPath, '.git')),
    'Controller acceptance requires the isolated pinned 1JS checkout', 'blocked-config');
  const git = args => execFileSync('git', args, { cwd: productRepositoryPath, encoding: 'utf8' }).trim();
  requireThat(git(['rev-parse', 'HEAD']) === request.sourceRevision && git(['status', '--porcelain']) === '',
    'Controller 1JS checkout must be clean at the pinned runner revision', 'blocked-result');
  const resultFiles = files(root, 'same-workspace-result.json');
  const receiptFiles = files(root, 'authoring-receipt.json');
  const bundleFiles = files(root, 'candidate.bundle');
  const workbookFiles = files(root, 'generated-workbook.xlsx').filter(path => !path.includes('attachments'));
  const authFiles = files(root, 'm365-auth-status.json');
  requireThat([resultFiles, receiptFiles, bundleFiles, workbookFiles, authFiles].every(list => list.length === 1),
    'Exact same-workspace authoring/product artifact set is missing or ambiguous', 'blocked-result');
  const result = JSON.parse(readFileSync(resultFiles[0], 'utf8'));
  const receipt = JSON.parse(readFileSync(receiptFiles[0], 'utf8'));
  const authentication = JSON.parse(readFileSync(authFiles[0], 'utf8'));
  const expectedFiles = [
    'ooui/apps/cross-office-client-e2e/failure-lifecycle/case-lifecycle-catalog.json',
    'ooui/apps/cross-office-client-e2e/scenarios/bizchat-create-excel-five-by-four/scenario.yaml'
  ];
  requireThat(result.status === 'passed' && result.profile === request.profile && receipt.profile === request.profile &&
    result.base === request.sourceRevision && receipt.base === request.sourceRevision &&
    result.candidate === receipt.candidate && revision.test(result.candidate) &&
    result.bundleSha256 === receipt.bundleSha256 && result.bundleSha256 === hash(readFileSync(bundleFiles[0])) &&
    result.skillSha256 === receipt.skillSha256 && result.scenarioSha256 === receipt.scenarioSha256 &&
    JSON.stringify(receipt.changedFiles) === JSON.stringify(expectedFiles) &&
    result.workbook.fileName === request.expected.fileName && result.workbook.worksheet === request.expected.worksheet &&
    result.workbook.rows === request.expected.rows && result.workbook.columns === request.expected.columns &&
    result.workbook.headerRows === request.expected.headerRows && result.workbook.dataRows === request.expected.dataRows &&
    result.junit.tests === 1 && result.junit.failures === 0 && result.junit.errors === 0 && result.junit.skipped === 0,
  'Trusted same-workspace result does not match the fixed Controller contract', 'blocked-result');
  execFileSync('git', ['bundle', 'verify', bundleFiles[0]], { cwd: productRepositoryPath, stdio: 'pipe' });
  const bundleHeads = execFileSync('git', ['bundle', 'list-heads', bundleFiles[0]], { encoding: 'utf8' });
  requireThat(bundleHeads.includes(result.candidate), 'Candidate bundle does not contain the accepted candidate', 'blocked-result');
  execFileSync('git', ['bundle', 'unbundle', bundleFiles[0]], { cwd: productRepositoryPath, stdio: 'pipe' });
  requireThat(git(['rev-parse', `${result.candidate}^`]) === request.sourceRevision &&
    git(['diff', '--name-only', `${request.sourceRevision}..${result.candidate}`]).split(/\r?\n/).sort().join('\n') ===
      expectedFiles.sort().join('\n'),
  'Candidate lineage or changed-file set differs from the accepted authoring receipt', 'blocked-result');
  const blobHash = path => createHash('sha256').update(execFileSync('git', ['show', `${result.candidate}:${path}`],
    { cwd: productRepositoryPath })).digest('hex');
  requireThat(blobHash(receipt.scenarioPath) === receipt.scenarioSha256 &&
    blobHash(receipt.controllerRegistrationPath) === receipt.controllerRegistrationSha256,
  'Candidate bundle blobs differ from the authoring receipt', 'blocked-result');
  requireThat(authentication.ok === true && authentication.stage === 'DONE' && authentication.code === 'OK' &&
    authentication.jobId === observation.job.jobId && authentication.attempts === 1 &&
    Number.isSafeInteger(authentication.storageStateBytes) && authentication.storageStateBytes > 0,
  'TRIPS FIC authentication evidence is missing or does not match the Agency job', 'blocked-result');
  const workbookBytes = readFileSync(workbookFiles[0]);
  requireThat(hash(workbookBytes) === result.workbook.sha256, 'Workbook bytes differ from the product assertion', 'blocked-result');
  const zip = zipEntries(workbookBytes);
  const workbook = zip.get('xl/workbook.xml')?.toString('utf8');
  const relations = zip.get('xl/_rels/workbook.xml.rels')?.toString('utf8');
  requireThat(workbook && relations, 'Workbook OpenXML identity parts are missing', 'blocked-result');
  const sheet = [...workbook.matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*(?:r:id|id)="([^"]+)"/g)]
    .find(match => match[1] === request.expected.worksheet);
  requireThat(sheet, 'Expected worksheet is absent from OpenXML', 'blocked-result');
  const target = relationshipTarget(relations, attributes => attributes.Id === sheet[2]);
  requireThat(target, 'Worksheet OpenXML relationship is missing', 'blocked-result');
  const sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  const sheetXml = zip.get(sheetPath)?.toString('utf8');
  const sheetRelPath = sheetPath.replace(/\/([^/]+)$/, '/_rels/$1.rels');
  const sheetRels = zip.get(sheetRelPath)?.toString('utf8');
  const tableTarget = relationshipTarget(sheetRels, attributes => attributes.Type?.endsWith('/table'));
  requireThat(sheetXml && tableTarget, 'Worksheet table relationship is missing', 'blocked-result');
  const normalized = new URL(tableTarget, `file:///${sheetPath}`).pathname.slice(1);
  const tableXml = zip.get(normalized)?.toString('utf8');
  const range = tableXml?.match(/<table\b[^>]*ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"/) ?? [];
  const column = value => [...value].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);
  const rows = Number(range[4]) - Number(range[2]) + 1, columns = column(range[3] ?? '') - column(range[1] ?? '') + 1;
  requireThat(tableXml && rows === request.expected.rows && columns === request.expected.columns,
    'Independent OpenXML table dimensions differ from the product result', 'blocked-result');
  return {
    schema: 'pea-1js-agency-controller-live-acceptance-v2', status: 'passed', controllerAcceptance: true,
    acceptedAt: now(), sourceRevision: request.sourceRevision, candidate: result.candidate,
    orchestratorRunId: observation.parent.id, runnerRunId: observation.child.id,
    agencyJobId: observation.job.jobId, agent: observation.job.agent?.name,
    authentication: { mechanism: 'TRIPS FIC', attempts: authentication.attempts,
      storageStateBytes: authentication.storageStateBytes },
    skillSha256: result.skillSha256, scenarioSha256: result.scenarioSha256,
    bundleSha256: result.bundleSha256, junit: result.junit,
    workbook: { ...result.workbook, independentReader: 'OpenXML ZIP/XML', range: range[0].match(/ref="([^"]+)/)?.[1] },
    repair: { productRepairOccurred: false, statement: 'First product execution passed; product repair path was not exercised.' },
    boundaries: { productPRCreated: false, productPRMerged: false, periodicTaskEnabled: false, localBrowserFallback: false }
  };
}

export async function runOneJsLiveController(config, ledger, request, options = {}, dependencies = {}) {
  validateRequest(request);
  requireThat(config.activation?.dispatch === true && config.statePolicy?.accessApproved === true,
    '1JS live execution requires dispatch and approved private state storage', 'blocked-authorization');
  const transport = dependencies.transport ?? createOneJsLiveTransport(config, dependencies);
  const wait = dependencies.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const operationId = `agency-1js-live:${hash(JSON.stringify(request))}`;
  const directory = join(config.stateDirectory, 'agency-1js-live', hash(operationId).slice(0, 24));
  mkdirSync(directory, { recursive: true });
  let row = ledger.db.prepare('SELECT * FROM operations WHERE id=?').get(operationId);
  let detail = row ? JSON.parse(row.detail) : { requestSha256: hash(JSON.stringify(request)), reservedAt: now(), directory };
  if (!row) {
    ledger.operation(operationId, '1js-agency-live', 'agency-1js-live', detail);
    try {
      const created = await transport('submit', { request }, directory);
      requireThat(Number.isSafeInteger(created.parentRunId), 'Orchestrator run identity missing', 'blocked-reconciliation');
      detail.parentRunId = created.parentRunId;
      ledger.finishOperation(operationId, 'accepted', detail);
    } catch (error) {
      ledger.finishOperation(operationId, 'uncertain', { ...detail, error: safeError(error) });
      throw new PilotError('blocked-reconciliation', '1JS live submission uncertain; resume this reservation, never submit another');
    }
  } else requireThat(options.resume === true, '1JS live operation already exists; resume it instead of submitting again', 'blocked-reconciliation');
  const deadline = Date.parse(detail.reservedAt) + request.maximumMinutes * 60000;
  let observation;
  while (Date.now() < deadline) {
    observation = await transport('inspect', { request, parentRunId: detail.parentRunId }, directory);
    detail.observation = observation;
    ledger.finishOperation(operationId, 'accepted', detail);
    if (observation.terminal) break;
    await wait(request.pollSeconds * 1000);
  }
  requireThat(observation?.terminal, '1JS live execution exceeded its bounded timeout', 'blocked-reconciliation');
  requireThat(observation.parent.result === 'succeeded' && observation.child.result === 'succeeded' &&
    observation.job.state === 'Completed' && observation.job.result === 'Success',
  'Orchestrator, Agency job, and runner must all succeed', 'blocked-result');
  const artifactRoot = await transport('download', { request, observation }, directory);
  const acceptance = verifyOneJsLiveArtifact(artifactRoot, request, observation,
    config.oneJsLive?.productRepositoryPath);
  const acceptancePath = join(directory, 'controller-acceptance.json');
  writeFileSync(acceptancePath, `${JSON.stringify(acceptance, null, 2)}\n`, { flag: existsSync(acceptancePath) ? 'w' : 'wx' });
  ledger.finishOperation(operationId, 'passed', { ...detail, acceptancePath, acceptanceSha256: hash(readFileSync(acceptancePath)) });
  return acceptance;
}

export function createOneJsLiveTransport(config, dependencies = {}) {
  const fetchResponse = dependencies.fetch ?? fetch;
  const execute = dependencies.execute ?? nativeCommand;
  let credentials;
  async function token(scope) {
    credentials ??= new (await import('@azure/identity')).AzureCliCredential({ tenantId: config.identity.tenantId });
    const value = await credentials.getToken(scope);
    requireThat(value?.token, 'Designated Azure CLI sign-in unavailable', 'blocked-auth');
    const claims = JSON.parse(Buffer.from(value.token.split('.')[1], 'base64url').toString('utf8'));
    requireThat(claims.tid === config.identity.tenantId && claims.oid === config.identity.objectId,
      'Designated identity mismatch', 'blocked-auth');
    return value.token;
  }
  async function request(url, scope, init = {}) {
    const response = await fetchResponse(url, { ...init, headers: { Authorization: `Bearer ${await token(scope)}`,
      Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    signal: AbortSignal.timeout(120000) });
    requireThat(response.ok, `Approved live endpoint returned HTTP ${response.status}`,
      [401, 403].includes(response.status) ? 'blocked-auth' : 'blocked-result');
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
  const ado = path => `https://dev.azure.com/office/Office/_apis/${path}`;
  return async (operation, input, directory) => {
    if (operation === 'submit') {
      const run = await request(ado('pipelines/37948/runs?api-version=7.1'), adoScope,
        { method: 'POST', body: JSON.stringify(input.request.payload) });
      requireThat(run?.pipeline?.id === 37948 && run?.resources?.repositories?.self?.version === input.request.sourceRevision,
        'Queued orchestrator did not bind the pinned 1JS revision', 'blocked-result');
      return { parentRunId: run.id };
    }
    if (operation === 'inspect') {
      const parent = await request(ado(`build/builds/${input.parentRunId}?api-version=7.1`), adoScope);
      requireThat(parent?.definition?.id === 37948 && parent.sourceVersion === input.request.sourceRevision,
        'Observed orchestrator is outside the pinned source', 'blocked-result');
      const timeline = await request(ado(`build/builds/${input.parentRunId}/timeline?api-version=7.1`), adoScope);
      const task = timeline.records?.find(record => record.name === 'Create Agency jobs (fan-out)' && record.log?.id);
      let jobId;
      if (task) {
        const logResponse = await fetchResponse(ado(`build/builds/${input.parentRunId}/logs/${task.log.id}?api-version=7.1`),
          { headers: { Authorization: `Bearer ${await token(adoScope)}` }, signal: AbortSignal.timeout(120000) });
        const log = await logResponse.text();
        jobId = log.match(/Agency job created:\s*([A-Za-z0-9_.-]+)/)?.[1];
      }
      if (!jobId) return { terminal: false, parent: { id: parent.id, status: parent.status, result: parent.result } };
      const job = await request(`${agencyRoot}/jobs/${jobId}`, agencyScope);
      const childId = job.pipelineRun?.runId;
      const child = childId ? await request(ado(`build/builds/${childId}?api-version=7.1`), adoScope) : null;
      if (child) requireThat(child.definition?.id === 35960 && child.sourceVersion === input.request.sourceRevision,
        'Agency runner is outside the pinned definition/source', 'blocked-result');
      return { terminal: parent.status === 'completed' && child?.status === 'completed' &&
        ['Completed', 'Failed', 'Cancelled'].includes(job.state),
      parent: { id: parent.id, status: parent.status, result: parent.result },
      child: child && { id: child.id, status: child.status, result: child.result }, job,
      authentication: { mechanism: 'TRIPS FIC' } };
    }
    requireThat(operation === 'download', 'Unsupported 1JS live transport operation');
    const artifact = join(directory, 'runner-artifact');
    if (!existsSync(artifact)) {
      mkdirSync(artifact, { recursive: true });
      await execute('az', ['pipelines', 'runs', 'artifact', 'download', '--organization', 'https://dev.azure.com/office',
        '--project', 'Office', '--run-id', String(input.observation.child.id), '--artifact-name', 'drop',
        '--path', artifact, '--only-show-errors'], process.cwd(), 10 * 60000, process.env);
    }
    return artifact;
  };
}

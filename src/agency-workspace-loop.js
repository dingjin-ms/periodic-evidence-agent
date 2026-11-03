import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, json, requireThat } from './common.js';
import { nativeCommand } from './native-command.js';
import {
  artifactInventory, runRemoteValidationOperation, validateRemotePipelineContract
} from './agency-remote-validation.js';
import {
  authoringLoopCompletionInstructions, authoringLoopToolNames, completeSourceRead,
  fitnessTargetCommand, loopCompletionInstructions, loopInventory, loopToolNames, nativeReviewArguments,
  nativeReviewerAgent, requireAppendOnlyTestChange,
  readManagedEventPrefix, readRequestEvidenceEvent,
  requireCardChange, requireFitnessOutcome, requireNativeWorkflow, requirePassedTestPopulation,
  requireTypeOnlyChange, validationEnvironment
} from '../scripts/validation/agency-workspace-loop.mjs';

const runnerPath = fileURLToPath(new URL('../scripts/validation/agency-workspace-loop.mjs', import.meta.url));
const nativePath = fileURLToPath(new URL('./native-command.ps1', import.meta.url));
const read = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const gateStages = ['compile', 'policy', 'test'];
const preparationStages = ['fingerprint', 'authentication-check', 'authentication', 'dependencies'];
const git = async (workspace, args) => (await nativeCommand('git.exe',
  ['-C', workspace, ...args], workspace, 120000, validationEnvironment(process.env))).stdout;

export function workspaceLoopContract(repo, request) {
  return productLoopContract(repo, request, false);
}

export function workspaceAuthoringContract(repo, request) {
  return productLoopContract(repo, request, true);
}

function productLoopContract(repo, request, authoring) {
  const requestSchema = authoring ? 'controller-workspace-authoring-request-v1' : 'controller-workspace-loop-request-v1';
  const contractSchema = authoring ? 'agency-oa-workspace-authoring-contract-v1' : 'agency-oa-workspace-loop-contract-v1';
  const completion = authoring ? authoringLoopCompletionInstructions : loopCompletionInstructions;
  requireThat(repo && request?.schema === requestSchema &&
    /^[a-zA-Z0-9_.-]+$/.test(request.id ?? '') && request.repoId === repo?.id &&
    typeof request.workspace === 'string' && isAbsolute(request.workspace) &&
    /^[a-f0-9]{40}$/.test(request.baseRevision ?? '') &&
    typeof request.contractPath === 'string' && isAbsolute(request.contractPath) &&
    /^[a-f0-9]{64}$/.test(request.contractSha256 ?? '') &&
    hash(readFileSync(request.contractPath)) === request.contractSha256,
  'Loop qualification requires its own exact source, isolated workspace and hash-pinned private contract',
  'blocked-validation');
  const contract = read(request.contractPath);
  requireThat(contract?.schema === contractSchema,
    'An explicit bounded OA workspace-loop contract is required', 'blocked-validation');
  requireThat(typeof contract.request?.prompt === 'string' &&
    contract.request.prompt.endsWith(`\n${completion}`) &&
    contract.request.metadata?.completionPolicySha256 === hash(completion),
  'Loop requests must pin remote completion separately from subsequent controller acceptance',
  'blocked-validation');
  validateRemotePipelineContract(contract, request.baseRevision, { dynamicProfile: true });
  const sourcePath = path => typeof path === 'string' && !win32.isAbsolute(path) &&
    path.split('/').every(part => part && part !== '.' && part !== '..' && !part.includes('\\'));
  requireThat(contract.schema === contractSchema &&
    contract.repoId === repo.id && contract.candidate === request.baseRevision &&
    repo.validationGates?.length === 1 && repo.validationGates[0].approved === true &&
    contract.gateId === repo.validationGates[0].id &&
    contract.profileSha256 === repo.validationGates[0].profileSha256 &&
    hash(readFileSync(repo.validationGates[0].profilePath)) === contract.profileSha256 &&
    contract.loop?.runnerSha256 === hash(readFileSync(runnerPath)) &&
    contract.loop?.nativeCommandSha256 === hash(readFileSync(nativePath)) &&
    contract.loop.maximumRepairs === 2 && contract.loop.maximumNewJobs === 1 &&
    contract.loop.typeOnly === !authoring && contract.loop.productPublication === false &&
    contract.loop.productionAssignment === false &&
    (authoring ? contract.loop.appendOnly === true : contract.loop.authoring === undefined) &&
    sourcePath(contract.loop.allowedPath) &&
    Array.isArray(contract.sourceInputs) && contract.sourceInputs.includes(contract.loop.allowedPath) &&
    contract.loop.allowedPath.endsWith('.test.ts') &&
    ((repo.allowedWriteFiles ?? []).includes(contract.loop.allowedPath) ||
      (repo.allowedWritePrefixes ?? []).some(prefix => contract.loop.allowedPath.startsWith(
        prefix.endsWith('/') ? prefix : `${prefix}/`))) &&
    contract.sourceInputs.every(sourcePath) &&
    contract.testPopulation?.suites === 1 && (authoring
      ? Number.isSafeInteger(contract.testPopulation.tests) && contract.testPopulation.tests > 0
      : contract.testPopulation.tests === 3) &&
    Array.isArray(contract.loop.requiredSkillPaths) && contract.loop.requiredSkillPaths.length >= 2 &&
    contract.loop.requiredSkillPaths.every(path => contract.sourceInputs.includes(path)) &&
    Array.isArray(contract.loop.toolNames) &&
    contract.loop.toolNames.join() === (authoring ? authoringLoopToolNames : loopToolNames).join() &&
    /^[a-f0-9]{64}$/.test(contract.loop.agentSha256 ?? '') && sourcePath(contract.loop.agentPath) &&
    contract.loop.agentPath.includes('/agents/') && contract.loop.agentPath.endsWith('.md') &&
    contract.loop.pluginManifestPath === `${contract.loop.agentPath.slice(0, contract.loop.agentPath.lastIndexOf('/agents/'))}/plugin.json` &&
    /^[a-f0-9]{64}$/.test(contract.loop.pluginManifestSha256 ?? '') &&
    contract.request?.customAgent?.type === 'Spec' &&
    contract.request.customAgent.name ===
      `ado-git:${new URL(contract.pipeline.organization).pathname.slice(1)}/${contract.pipeline.project}/${contract.pipeline.repositoryId}:${contract.loop.agentPath.replace(/(?:\.agent)?\.md$/, '')}@${contract.pipeline.revision}` &&
    contract.request.plugins?.length === 0,
  'Loop qualification must bind the trusted runner, bounded native skill tools and original real gates',
  'blocked-validation');
  if (authoring) {
    const a = contract.loop.authoring;
    requireThat(a && ['agents/office-agent', 'agents/excel-agent'].includes(a.projectPath) &&
      a.projectName === `@officeagent-agent/${a.projectPath.split('/').at(-1)}` &&
      Number.isSafeInteger(a.baselineTests) && a.baselineTests > 0 &&
      [undefined, 'request-tool-v1', 'request-session-v1'].includes(a.evidenceTransport) &&
      contract.testPopulation.tests > a.baselineTests &&
      contract.loop.allowedPath.startsWith(`${a.projectPath}/tests/integration/`) &&
      contract.testPopulation.path === contract.loop.allowedPath.slice(`${a.projectPath}/`.length) &&
      /^[a-f0-9]{64}$/.test(a.evidenceSha256 ?? '') &&
      /^[a-f0-9]{64}$/.test(a.sourceApprovalSha256 ?? '') &&
      [request.evidencePath, request.sourceApprovalPath].every(path => typeof path === 'string' && isAbsolute(path)) &&
      hash(readFileSync(request.evidencePath)) === a.evidenceSha256 &&
      hash(readFileSync(request.sourceApprovalPath)) === a.sourceApprovalSha256,
    'New-test authoring requires its own project, larger exact population, complete evidence and source approval',
    'blocked-validation');
    if (['request-tool-v1', 'request-session-v1'].includes(a.evidenceTransport)) requireThat(contract.request.prompt.includes(
      `\n<approved-evidence-base64>\n${readFileSync(request.evidencePath).toString('base64')}\n</approved-evidence-base64>\n`),
    'Request-tool authoring must carry the complete approved evidence in the private request', 'blocked-validation');
    requireNativeWorkflow(a.nativeWorkflow, a.projectPath);
    if (a.nativeWorkflow) requireThat(a.nativeWorkflow.reviewerModel === contract.request.modelConfiguration?.model,
      'The independent reviewer must use the explicitly pinned approved model', 'blocked-validation');
    if (a.nativeWorkflow) requireThat([
      a.nativeWorkflow.cardPath, 'docs/skills/Integration-test-core/scripts/probe-fitness.mjs',
      ...a.nativeWorkflow.fitness.map(probe => probe.path)
    ].every(path => contract.sourceInputs.includes(path)) &&
      ((repo.allowedWriteFiles ?? []).includes(a.nativeWorkflow.cardPath) ||
        (repo.allowedWritePrefixes ?? []).some(prefix =>
          a.nativeWorkflow.cardPath.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))),
    'Native workflow requires pinned source inputs and the exact approved behavior-card write scope',
    'blocked-validation');
  }
  return contract;
}

export async function verifyWorkspaceLoop(contract, directory, observation, expectedJobId, workspace, reservedAt) {
  requireThat(contract.schema === 'agency-oa-workspace-loop-contract-v1',
    'The type-only verifier cannot accept another loop protocol', 'blocked-result');
  return verifyProductLoop(contract, directory, observation, expectedJobId, workspace, reservedAt, false);
}

export async function verifyWorkspaceAuthoring(contract, directory, observation, expectedJobId, workspace, reservedAt) {
  requireThat(contract.schema === 'agency-oa-workspace-authoring-contract-v1',
    'The new-test verifier requires its separate authoring protocol', 'blocked-result');
  return verifyProductLoop(contract, directory, observation, expectedJobId, workspace, reservedAt, true);
}

async function verifyProductLoop(contract, directory, observation, expectedJobId, workspace, reservedAt, authoring) {
  const { job, build, timeline, logs, artifacts } = observation, p = contract.pipeline;
  const native = authoring ? contract.loop.authoring.nativeWorkflow : undefined;
  const allowedPaths = [contract.loop.allowedPath, ...(native ? [native.cardPath] : [])];
  requireThat(job?.jobId === expectedJobId && job.state === 'Completed' && job.result === 'Success' &&
    build?.status === 'completed' && build.result === 'succeeded' &&
    job.pipelineRun?.runId === build.id && job.pipelineRun.definitionId === p.definitionId &&
    build.definitionId === p.definitionId && build.definitionRevision === p.definitionRevision &&
    build.sourceVersion === p.revision && build.sourceBranch === p.ref &&
    hash(observation.pipelineYaml ?? '') === p.yamlSha256 &&
    Array.isArray(artifacts) && Array.isArray(timeline) && Array.isArray(logs) &&
    artifacts.filter(artifact => artifact.name === `${p.artifactPrefix}${build.id}`).length === 1,
  'The loop job/build/source/artifact identity is not independently qualified', 'blocked-result');
  const elapsed = Date.parse(build.finishTime) - Date.parse(build.startTime);
  requireThat(Number.isFinite(elapsed) && elapsed > 0 && elapsed <= contract.maximumRunnerMinutes * 60000 &&
    Date.parse(build.queueTime ?? build.startTime) >= Date.parse(reservedAt) - 120000,
  'The actual loop exceeded its reserved execution budget', 'blocked-result');
  const task = name => {
    const matches = timeline.filter(record => record.type === 'Task' && record.name === name);
    requireThat(matches.length === 1 && matches[0].state === 'completed' &&
      matches[0].result === 'succeeded', `Missing or unsuccessful trusted loop task: ${name}`, 'blocked-result');
    return matches[0];
  };
  const taskLog = name => {
    const producer = task(name);
    const found = logs.filter(log => log.taskId === producer.id && log.logId === producer.logId);
    requireThat(found.length === 1 && Array.isArray(found[0].lines),
      'The independent producer log is missing or ambiguous', 'blocked-result');
    return found[0].lines.join('\n');
  };
  contract.requiredTasks.forEach(task);
  const inventory = await artifactInventory(join(directory, 'job-artifact'), contract.maximumArtifactBytes);
  const root = join(directory, 'job-artifact', 'workspace-loop');
  requireThat(existsSync(join(root, 'loop-result.json')), 'No trusted loop result was produced', 'blocked-result');
  const result = read(join(root, 'loop-result.json')), prepared = read(join(root, 'loop-prepared.json'));
  const m = read(join(root, 'manifest.json')), state = read(join(root, 'loop-state.json'));
  const fileHash = name => hash(readFileSync(join(root, name)));
  const prefix = authoring ? 'agency-workspace-authoring' : 'agency-workspace-loop';
  requireThat(result.schema === `${prefix}-result-v1` &&
    prepared.schema === `${prefix}-prepared-v1` &&
    m.schema === `${prefix}-manifest-v1` && state.schema === `${prefix}-state-v1` &&
    (authoring || [result, prepared, m].every(value => value.authoring === undefined)) &&
    result.baseRevision === contract.candidate && prepared.baseRevision === contract.candidate &&
    m.baseRevision === contract.candidate && /^[a-f0-9]{40}$/.test(result.candidate ?? '') &&
    result.candidate !== contract.candidate &&
    [result, prepared, m, state].every(value => String(value.buildId) === String(build.id)) &&
    [result, prepared, m].every(value => value.pipelineRevision === p.revision) &&
    [result, prepared, m].every(value => value.profileSha256 === contract.profileSha256) &&
    result.workspace === m.workspace && prepared.workspace === m.workspace &&
    win32.isAbsolute(m.workspace) && win32.isAbsolute(m.directory) &&
    win32.basename(m.directory) === `pilot-loop-${build.id}` &&
    m.profilePath === win32.join(m.directory, 'profile.ps1') &&
    m.runnerPath === win32.join(m.directory, 'server.mjs') &&
    m.nativeCommandPath === win32.join(m.directory, 'native-command.ps1') &&
    m.nugetDirectory === win32.join(win32.dirname(m.directory), `pilot-nuget-${build.id}`) &&
    m.executable === contract.executable &&
    m.runnerSha256 === contract.loop.runnerSha256 &&
    m.nativeCommandSha256 === contract.loop.nativeCommandSha256 &&
    m.allowedPath === contract.loop.allowedPath && m.maximumRepairs === 2 &&
    json(m.testPopulation) === json(contract.testPopulation) &&
    json(result.testPopulation) === json(contract.testPopulation) &&
    json(m.sourceInputs) === json(contract.sourceInputs) &&
    json(m.requiredSkillPaths) === json(contract.loop.requiredSkillPaths) &&
    fileHash('profile.ps1') === contract.profileSha256 &&
    fileHash('server.mjs') === contract.loop.runnerSha256 &&
    fileHash('native-command.ps1') === contract.loop.nativeCommandSha256 &&
    result.preparedSha256 === fileHash('loop-prepared.json') &&
    result.manifestSha256 === fileHash('manifest.json') &&
    prepared.manifestSha256 === result.manifestSha256 && result.stateSha256 === fileHash('loop-state.json') &&
    result.remoteWorkComplete === true && result.controllerAcceptance === false &&
    result.controllerAcceptanceStatus === 'pending-external' && result.localReceiptsImported === false &&
    result.sourceCleanAfter === true && result.gatesPassed === true && state.finished === true &&
    state.phase === 'ready' && Array.isArray(result.rounds) && Array.isArray(state.rounds) &&
    json(state.rounds) === json(result.rounds) && Array.isArray(state.plans) &&
    state.plans.length > 0 && Array.isArray(state.skillReads) &&
    contract.loop.requiredSkillPaths.every(path => state.skillReads.includes(path)) &&
    taskLog(contract.prepareTask).includes(`LOOP_PREPARED base=${contract.candidate} build=${build.id} preparedSha256=${fileHash('loop-prepared.json')}`) &&
    taskLog(contract.validationTask).includes(`LOOP_RESULT base=${contract.candidate} candidate=${result.candidate} build=${build.id} resultSha256=${fileHash('loop-result.json')}`) &&
    json(await loopInventory(root)) === json(result.inventory),
  'A trusted loop manifest, source, skill, runner, producer seal or full artifact changed', 'blocked-result');
  if (authoring) {
    requireThat(m.authoring?.evidencePath === win32.join(m.directory, 'evidence.json') &&
      Object.entries(contract.loop.authoring).every(([key, value]) => json(m.authoring[key]) === json(value)) &&
      json(prepared.authoring) === json(m.authoring) && json(result.authoring) === json(m.authoring) &&
      state.evidenceReadSha256 === contract.loop.authoring.evidenceSha256 &&
      fileHash('evidence.json') === contract.loop.authoring.evidenceSha256,
    'The authored result is not bound to the approved source payload and native project', 'blocked-result');
    if (m.authoring.evidenceTransport === 'request-session-v1') {
      const binding = state.evidenceRequest;
      requireThat(binding?.promptSha256 === hash(contract.request.prompt) &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(binding.sessionId ?? ''),
      'Managed request evidence is not bound to the exact approved request', 'blocked-result');
      const events = inventory.filter(item => /^session_[0-9]{8}_[0-9]{6}_[0-9]+\/events\.jsonl$/.test(item.path))
        .map(item => ({ path: join(directory, 'job-artifact', ...item.path.split('/')),
          first: readManagedEventPrefix(join(directory, 'job-artifact', ...item.path.split('/'))).split('\n', 1)[0] }))
        .filter(item => {
          const event = JSON.parse(item.first);
          return event.type === 'session.start' && event.data?.sessionId === binding.sessionId;
        });
      requireThat(events.length === 1, 'The independently downloaded managed request session is missing or ambiguous',
        'blocked-result');
      const actual = readRequestEvidenceEvent(events[0].path, binding.sessionId);
      requireThat(json(actual.binding) === json(binding) &&
        hash(Buffer.from(actual.contentBase64, 'base64')) === m.authoring.evidenceSha256,
      'Managed request evidence differs from the original downloaded session events', 'blocked-result');
    }
    if (native) requireThat(fileHash('reviewer.md') === native.reviewerAgentSha256 &&
      readFileSync(join(root, 'reviewer.md'), 'utf8') === nativeReviewerAgent &&
      m.reviewAgentSpec ===
        `ado-git:${new URL(p.organization).pathname.slice(1)}/${p.project}/${p.repositoryId}:${native.reviewerAgentPath.replace(/(?:\.agent)?\.md$/, '')}@${p.revision}`,
    'The independent reviewer agent or immutable source differs from its pinned specification', 'blocked-result');
  }
  const project = read(join(root, 'inspection-project.json'));
  const baseline = read(join(root, 'inspection-baseline.json'));
  const cards = read(join(root, 'inspection-cards.json'));
  requireThat(project.matchCount === 1 &&
    project.matches?.[0]?.project === (authoring ? contract.loop.authoring.projectPath : 'agents/office-agent') &&
    baseline.baseRevision === contract.candidate && Array.isArray(baseline.changedFiles) &&
    cards.strict === false && cards.scoreGateResult === 'passed',
  'The required source-bound native skill inspections did not complete', 'blocked-result');
  const checkStages = (records, names, candidate, fitnessSourcePath) => {
    requireThat(Array.isArray(records) && records.length === names.length &&
      records.every((record, index) => record.stage === names[index] &&
        record.candidate === candidate && String(record.buildId) === String(build.id) &&
        record.cwd === m.workspace && record.executable === contract.executable &&
        record.fitnessSourcePath === fitnessSourcePath &&
        json(record.arguments) === json(['-NoLogo', '-NoProfile', '-NonInteractive', '-File', m.profilePath]) &&
        json(record.supervisorArguments) === json(['-NoLogo', '-NoProfile', '-NonInteractive', '-File', m.nativeCommandPath]) &&
        /^[a-zA-Z0-9_.-]+\.log$/.test(record.log ?? '') && record.logSha256 === fileHash(record.log) &&
        Number.isSafeInteger(record.exitCode) && Date.parse(record.startedAt) >= Date.parse(build.startTime) &&
        Date.parse(record.finishedAt) >= Date.parse(record.startedAt) &&
        Date.parse(record.finishedAt) <= Date.parse(build.finishTime)),
    'Actual loop stage, command, revision, time, exit code or full log differs', 'blocked-result');
  };
  checkStages(prepared.stages, preparationStages, contract.candidate);
  checkStages(result.stages, gateStages, result.candidate);
  if (native) for (const [index, round] of result.rounds.entries()) {
    if (!round.passed) continue;
    requireThat(Array.isArray(round.nativeFitness) && round.nativeFitness.length === native.fitness.length &&
      round.nativeReview?.completed === true,
    'A green baseline cannot replace both native fitness probes and independent coverage review',
    'blocked-result');
    for (const [probeIndex, record] of round.nativeFitness.entries()) {
      const probe = native.fitness[probeIndex], command = record.command;
      checkStages(record.stages, ['compile', 'test'], round.candidate, probe.path);
      requireThat(json(read(join(root, `fitness-${index}-${probe.kind}-stages.json`))) === json(record.stages),
        'Native fitness stages did not execute inside the corresponding approved probe', 'blocked-result');
      requireThat(record.kind === probe.kind && record.path === probe.path &&
        /^[a-f0-9]{64}$/.test(record.sourceBeforeSha256 ?? '') &&
        record.sourceAfterSha256 === record.sourceBeforeSha256 &&
        json(command.arguments) === json([
          win32.join(m.workspace, ...'docs/skills/Integration-test-core/scripts/probe-fitness.mjs'.split('/')),
          '--file', probe.path, '--kind', probe.kind, '--find', probe.find,
          '--replace', probe.replace, '--no-baseline', '--json', '--',
          ...fitnessTargetCommand(m, index, probe.kind, command.executable)
        ]),
      'Native fitness source, exact approved patch, trusted command, native result or provenance changed',
      'blocked-result');
      requireFitnessOutcome(record, contract.testPopulation,
        stage => readFileSync(join(root, stage.log), 'utf8'));
    }
    const review = round.nativeReview, command = review.command;
    const request = read(join(root, `review-request-${index}.json`));
    const privateDirectory = win32.join(win32.dirname(m.directory), `pilot-native-review-private-${review.sessionId}`);
    const diagnosticDirectory = win32.join(privateDirectory, 'logs');
    requireThat(review.sessionId !== m.sessionId && request.sessionId === review.sessionId &&
      request.round === index && request.candidate === round.candidate &&
      review.completed === true && review.candidate === round.candidate &&
      json(command.arguments) === json(nativeReviewArguments(m, review.sessionId, diagnosticDirectory)) &&
      m.requiredSkillPaths.every(path => /^[a-f0-9]{64}$/.test(review.reads?.[path]?.sha256 ?? '')) &&
      review.reads?.[m.allowedPath]?.sha256 === fileHash('candidate.test.ts') &&
      review.reads?.[native.cardPath]?.sha256 === fileHash('candidate.card.md') &&
      Date.parse(result.stages[0].startedAt) >= Date.parse(command.finishedAt),
    'Independent native review process, new session, exact model/tools, source-bound report or exit changed',
    'blocked-result');
  }
  for (const path of contract.sourceInputs) {
    requireThat(/^[a-f0-9]{64}$/.test(prepared.inputs?.[path] ?? '') &&
      prepared.sourceBlobs?.[path] === (await git(workspace, ['rev-parse', `${contract.candidate}:${path}`])).trim(),
    'Prepared native skill, dependency or validation input is not bound to the base tree', 'blocked-result');
    if (authoring && contract.loop.requiredSkillPaths.includes(path)) {
      const source = await git(workspace, ['show', `${contract.candidate}:${path}`]);
      requireThat(completeSourceRead(state.skillReadRanges?.[path], source.split('\n').length),
        'The complete pinned native skill documents were not read', 'blocked-result');
    }
  }
  requireThat([...prepared.stages, ...result.stages].every(record => record.exitCode === 0) &&
    result.rounds.length >= (authoring ? 1 : 2) &&
    result.rounds.length <= contract.loop.maximumRepairs + (authoring ? 1 : 2) &&
    result.rounds.at(-1).candidate === result.candidate && result.rounds.at(-1).passed,
  'A green job cannot substitute for the configured command gates and bounded failure/fix loop', 'blocked-result');
  const baseSource = await git(workspace, ['show', `${contract.candidate}:${contract.loop.allowedPath}`]);
  const exportedSource = readFileSync(join(root, 'candidate.test.ts'), 'utf8');
  const baseCard = native ? await git(workspace, ['show', `${contract.candidate}:${native.cardPath}`]) : null;
  const exportedCard = native ? readFileSync(join(root, 'candidate.card.md'), 'utf8') : null;
  if (native) {
    requireCardChange(baseCard, exportedCard);
    requireThat(baseCard !== exportedCard, 'The native behavior card was not updated', 'blocked-result');
  }
  const requireSourceChange = authoring ? requireAppendOnlyTestChange : requireTypeOnlyChange;
  requireSourceChange(baseSource, exportedSource);
  const bundleHash = inventory.find(item => item.path === 'workspace-loop/candidate.bundle')?.sha256;
  const bundleBytes = readFileSync(join(root, 'candidate.bundle'));
  requireThat(hash(bundleBytes) === bundleHash, 'Candidate bundle changed after inventory', 'blocked-result');
  // Git's bundle reader cannot open long Windows artifact paths, even with core.longpaths.
  const staging = mkdtempSync(join(tmpdir(), 'pea-verified-bundle-'));
  const bundle = join(staging, 'candidate.bundle');
  try {
    writeFileSync(bundle, bundleBytes, { flag: 'wx', mode: 0o600 });
    requireThat(hash(readFileSync(bundle)) === bundleHash,
      'Staged candidate bundle differs from the original inventory', 'blocked-result');
    const refs = (await git(workspace, ['bundle', 'list-heads', bundle])).trim();
    requireThat(refs === `${result.candidate} HEAD`, 'Candidate bundle has unexpected refs', 'blocked-result');
    await git(workspace, ['bundle', 'verify', bundle]);
    await git(workspace, ['fetch', '--no-tags', '--no-write-fetch-head', '--no-auto-maintenance', bundle, 'HEAD']);
    requireThat(fileHash('candidate.bundle') === bundleHash,
      'Original candidate bundle changed during import', 'blocked-result');
  } finally { rmSync(staging, { recursive: true, force: true }); }
  let previous = contract.candidate;
  for (const [index, round] of result.rounds.entries()) {
    const names = gateStages.slice(0, round.stages.length);
    requireThat(round.index === index && /^[a-f0-9]{40}$/.test(round.candidate ?? '') &&
      round.profileSha256 === contract.profileSha256 &&
      round.workspace === m.workspace && String(round.buildId) === String(build.id) &&
      round.stages.length > 0 && round.stages.length <= gateStages.length,
    'Invalid or substituted validation round', 'blocked-result');
    checkStages(round.stages, names, round.candidate);
    if (index === 0 && !authoring) {
      const log = readFileSync(join(root, round.stages[0].log), 'utf8');
      requireThat(round.candidate === contract.candidate && round.stages.length === 1 &&
        round.stages[0].exitCode !== 0 && round.repairable === true &&
        /error TS\d{4}\b/.test(log) && log.includes(contract.loop.allowedPath.split('/').at(-1)),
      'No actual scoped baseline failure preceded the remote repair', 'blocked-result');
    } else {
      const changed = (await git(workspace, ['diff', '--name-only', previous, round.candidate]))
        .trim().split(/\r?\n/).filter(Boolean);
      requireThat((await git(workspace, ['show', '-s', '--format=%P', round.candidate])).trim() === previous &&
        changed.includes(contract.loop.allowedPath) && changed.every(path => allowedPaths.includes(path)),
      'Candidate history escaped the bounded same-workspace change scope', 'blocked-result');
      requireSourceChange(baseSource, await git(workspace, ['show', `${round.candidate}:${contract.loop.allowedPath}`]));
      if (native) requireCardChange(baseCard, await git(workspace, ['show', `${round.candidate}:${native.cardPath}`]));
      previous = round.candidate;
    }
    requireThat(round.passed === (round.stages.length === gateStages.length &&
      round.stages.every(stage => stage.exitCode === 0)) &&
      round.stages.slice(0, -1).every(stage => stage.exitCode === 0) &&
      (index === result.rounds.length - 1 || !round.passed),
    'Round success or early termination contradicts actual command exits', 'blocked-result');
    if (native && round.passed) {
      requirePassedTestPopulation(readFileSync(join(root, round.stages.at(-1).log), 'utf8'),
        contract.testPopulation);
      requireThat(Array.isArray(round.nativeFitness) && round.nativeFitness.length === 2 &&
        round.nativeReview?.completed === true,
      'A green baseline cannot replace both native fitness probes and independent coverage review',
      'blocked-result');
      for (const [probeIndex, record] of round.nativeFitness.entries()) {
        const probe = native.fitness[probeIndex], command = record.command;
        const target = fitnessTargetCommand(m, index, probe.kind, command.executable);
        const sourceSha256 = hash(await git(workspace, ['show', `${contract.candidate}:${probe.path}`]));
        requireThat(record.kind === probe.kind && record.path === probe.path &&
          record.sourceBeforeSha256 === sourceSha256 && record.sourceAfterSha256 === sourceSha256 &&
          win32.isAbsolute(command.executable) && win32.basename(command.executable).toLowerCase() === 'node.exe' &&
          command.stage === `fitness-${probe.kind}` && command.candidate === round.candidate &&
          String(command.buildId) === String(build.id) && command.cwd === m.workspace &&
          json(command.arguments) === json([
            win32.join(m.workspace, ...'docs/skills/Integration-test-core/scripts/probe-fitness.mjs'.split('/')),
            '--file', probe.path, '--kind', probe.kind, '--find', probe.find,
            '--replace', probe.replace, '--no-baseline', '--json', '--', ...target
          ]) &&
          json(command.supervisorArguments) === json(['-NoLogo', '-NoProfile', '-NonInteractive',
            '-File', m.nativeCommandPath]) &&
          command.log === `round-${index}-fitness-${probe.kind}.log` &&
          command.logSha256 === fileHash(command.log) &&
          json(read(join(root, command.log))) === json(record.result) &&
          record.result.command === target.join(' ') &&
          Date.parse(command.startedAt) >= Date.parse(round.stages.at(-1).finishedAt) &&
          Date.parse(command.finishedAt) >= Date.parse(command.startedAt) &&
          Date.parse(command.finishedAt) <= Date.parse(build.finishTime),
        'Native fitness source, exact approved patch, trusted command, native result or provenance changed',
        'blocked-result');
        checkStages(record.stages, ['compile', 'test'], round.candidate, probe.path);
        requireThat(json(read(join(root, `fitness-${index}-${probe.kind}-stages.json`))) === json(record.stages) &&
          record.stages.every(stage =>
          stage.log === `round-fitness-${index}-${probe.kind}-${stage.stage}.log` &&
          Date.parse(stage.startedAt) >= Date.parse(command.startedAt) &&
          Date.parse(stage.finishedAt) <= Date.parse(command.finishedAt)),
        'Native fitness stages did not execute inside the corresponding approved probe', 'blocked-result');
        requireFitnessOutcome(record, contract.testPopulation,
          stage => readFileSync(join(root, stage.log), 'utf8'));
      }
      const review = round.nativeReview, command = review.command;
      const request = read(join(root, `review-request-${index}.json`));
      const privateDirectory = win32.join(win32.dirname(m.directory), `pilot-native-review-private-${review.sessionId}`);
      const diagnosticDirectory = win32.join(privateDirectory, 'logs');
      const { command: ignoredCommand, executableSha256, reportSha256, profileSha256, ...report } = review;
      requireThat(review.schema === 'agency-native-coverage-review-v1' &&
        review.verdict === 'approved' && review.completed === true &&
        review.candidate === round.candidate && String(review.buildId) === String(build.id) &&
        review.round === index && /^[a-f0-9-]{36}$/.test(review.sessionId ?? '') &&
        review.sessionId !== m.sessionId && request.sessionId === review.sessionId &&
        request.round === index && request.candidate === round.candidate &&
        review.evidenceReadSha256 === m.authoring.evidenceSha256 &&
        json(read(join(root, `review-${index}.json`))) === json(report) &&
        reportSha256 === fileHash(`review-${index}.json`) && /^[a-f0-9]{64}$/.test(executableSha256) &&
        profileSha256 === fileHash(`review-profile-${index}.toml`) &&
        readFileSync(join(root, `review-profile-${index}.toml`), 'utf8') ===
          `[profiles.controller-native-review-${review.sessionId}]\n` &&
        win32.isAbsolute(command.executable) && win32.basename(command.executable).toLowerCase() === 'agency.exe' &&
        command.stage === 'native-review' && command.candidate === round.candidate &&
        String(command.buildId) === String(build.id) &&
        command.cwd === win32.join(privateDirectory, 'workspace') &&
        json(command.arguments) === json(nativeReviewArguments(m, review.sessionId, diagnosticDirectory)) &&
        json(command.supervisorArguments) === json(['-NoLogo', '-NoProfile', '-NonInteractive',
          '-File', m.nativeCommandPath]) &&
        command.exitCode === 0 && command.providerDiagnosticsRetained === false &&
        command.log === `round-${index}-native-review.log` && command.logSha256 === fileHash(command.log) &&
        readFileSync(join(root, command.log)).length === 0 &&
        Date.parse(command.startedAt) >= Date.parse(round.nativeFitness.at(-1).command.finishedAt) &&
        Date.parse(command.finishedAt) >= Date.parse(command.startedAt) &&
        Date.parse(command.finishedAt) - Date.parse(command.startedAt) <= 10 * 60000 &&
        Date.parse(command.finishedAt) <= Date.parse(build.finishTime) &&
        Date.parse(result.stages[0].startedAt) >= Date.parse(command.finishedAt) &&
        Array.isArray(review.findings) && review.findings.length === 0 &&
        Array.isArray(review.residuals) && review.residuals.length <= 20 &&
        Array.isArray(review.calls) && review.calls.some(call => call.name === 'review_submit'),
      'Independent native review process, new session, exact model/tools, source-bound report or exit changed',
      'blocked-result');
      for (const path of [...m.requiredSkillPaths, m.allowedPath, native.cardPath]) {
        const source = await git(workspace, ['show', `${round.candidate}:${path}`]);
        requireThat(review.reads?.[path]?.sha256 === hash(source) &&
          completeSourceRead(review.reads[path].ranges, source.split('\n').length),
        'Independent review did not read the complete actual candidate and native workflow', 'blocked-result');
      }
    }
    if (!round.passed) {
      const output = readFileSync(join(root, round.stages.at(-1).log), 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
      const types = round.stages.length === 1 && round.stages[0].exitCode !== 0 &&
        /error TS\d{4}\b/.test(output) && output.includes(contract.loop.allowedPath.split('/').at(-1));
      const assertions = authoring && round.stages.length === gateStages.length &&
        round.stages.at(-1).exitCode !== 0 && output.includes(`FAIL ${contract.testPopulation.path}`) &&
        /^Tests:[ \t]+[1-9][0-9]* failed\b/m.test(output);
      requireThat(round.repairable === true && (types || assertions),
        'Only a real scoped test-type or authorized assertion failure permits another repair', 'blocked-result');
    }
  }
  requireThat(await git(workspace, ['show', `${result.candidate}:${contract.loop.allowedPath}`]) === exportedSource,
    'Exported candidate content differs from the sealed Git revision', 'blocked-result');
  if (native) requireThat(await git(workspace, ['show', `${result.candidate}:${native.cardPath}`]) === exportedCard,
    'Exported native behavior card differs from the sealed Git revision', 'blocked-result');
  const output = readFileSync(join(root, 'round-final-test.log'), 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
  requirePassedTestPopulation(output, contract.testPopulation);
  return { status: 'passed', blockedReason: null, jobId: expectedJobId, buildId: build.id,
    sourceRevision: result.candidate, baseRevision: contract.candidate, profileSha256: contract.profileSha256,
    executionLocation: 'agency-remote', controllerAcceptance: true, inventory,
    stages: [...prepared.stages, ...result.stages], rounds: result.rounds,
    caseCounts: contract.testPopulation, qualificationOnly: true, productionAssignment: false,
    publicationPerformed: false, ...(authoring ? { authoring: contract.loop.authoring } : {}),
    protocolVerifierSha256: hash(readFileSync(fileURLToPath(import.meta.url))) };
}

export async function runAgencyWorkspaceLoop(config, ledger, repo, request, options = {}, dependencies = {}) {
  const contract = workspaceLoopContract(repo, request);
  requireThat((await git(request.workspace, ['rev-parse', 'HEAD'])).trim() === request.baseRevision &&
    (await git(request.workspace, ['status', '--porcelain'])).trim() === '',
  'Loop qualification needs a clean isolated exact-base checkout', 'blocked-authorization');
  return runRemoteValidationOperation(config, ledger,
    { id: `workspace-loop:${request.id}`, workspace: request.workspace },
    { ...repo, remoteValidation: { type: 'agency-workspace-loop',
      contractPath: request.contractPath, contractSha256: request.contractSha256 } },
    request.baseRevision, contract, verifyWorkspaceLoop, options, dependencies, 'agency-workspace-loop');
}

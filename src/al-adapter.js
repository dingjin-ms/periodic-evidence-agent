import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { channel } from 'node:diagnostics_channel';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configAt, hash, json, now, requireThat, safeError } from './common.js';
import { Ledger } from './ledger.js';
import { command, preflightValidationAuthentication, prepareValidation, runValidation } from './workers.js';
import { qualifyRepositorySkill } from './repository-skills.js';
import { nativeCommand } from './native-command.js';

export const alOwners = [
  { path: 'server/session-protocol', package: '@augloop/session-protocol',
    tests: 'test/integration-evolution', runner: 'mocha', testScript: 'gulp test' },
  { path: 'utils/doclab-serialization', package: '@augloop-utils/doclab-serialization',
    tests: 'tests', runner: 'jest', testScript: 'run -T jest' },
  { path: 'utils/eval-vnext-config-resolver', package: '@augloop-utils/eval-vnext-config-resolver',
    tests: 'tests', runner: 'jest', testScript: 'run -T jest' },
  { path: 'utils/excel-agent-in-container-proxy', package: '@augloop-utils/excel-agent-in-container-proxy',
    tests: 'tests', runner: 'jest', testScript: 'run -T jest' }
];
const controllerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profilePath = join(controllerRoot, 'scripts', 'validation', 'augloop-integration.ps1');
export const alTestPrefixes = alOwners.map(owner => `${owner.path}/${owner.tests}`);
export const alReference = path => ({ path: resolve(path), sha256: hash(readFileSync(path)) });
const read = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const put = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });

export async function withAlPreparationProgress(root, operation) {
  const progress = channel('periodic-evidence-agent.validation-preparation');
  const observe = event => {
    const value = `${JSON.stringify({ observedAt: now(), ...event })}\n`;
    appendFileSync(join(root, 'native-progress.ndjson'), value, { mode: 0o600 });
    writeFileSync(join(root, 'native-subphase.json'), value, { mode: 0o600 });
  };
  progress.subscribe(observe);
  try { return await operation(); }
  finally { progress.unsubscribe(observe); }
}

export function requireAlPaths(paths) {
  requireThat(Array.isArray(paths) && paths.length > 0, 'AL requires a nonempty candidate work set', 'blocked-scope');
  for (const path of paths) requireThat(typeof path === 'string' &&
    !/[\\:\0\r\n]/.test(path) &&
    !path.split('/').some(part => ['', '.', '..'].includes(part)) &&
    alTestPrefixes.some(prefix => path.startsWith(`${prefix}/`) &&
      (path.endsWith('.integration.test.ts') || path.startsWith(`${prefix}/fixtures/`))),
  `Unsupported AL owner or non-integration path: ${path}`, 'blocked-scope');
  requireThat(paths.some(path => path.endsWith('.integration.test.ts')),
    'AL requires a changed integration test, not fixtures alone', 'blocked-scope');
}

export async function inspectAlSource(repo, execute = command) {
  const git = args => execute('git', ['--no-pager', ...args], repo.referenceCheckout);
  const revision = (await git(['rev-parse', '--verify', `${repo.baseRef}^{commit}`])).stdout.trim();
  requireThat(/^[a-f0-9]{40}$/.test(revision), 'AL needs an exact pinned source revision', 'blocked-config');
  requireThat(!(await git(['status', '--porcelain'])).stdout.trim(),
    'AL reference checkout must be clean', 'blocked-scope');
  const files = [];
  for (const owner of alOwners) {
    const path = `${owner.path}/package.json`;
    const source = (await git(['show', `${revision}:${path}`])).stdout;
    const manifest = JSON.parse(source);
    requireThat(manifest.name === owner.package && manifest.scripts?.build === 'gulp build' &&
      manifest.scripts?.test === owner.testScript,
    `Unsupported native AL contract: ${owner.path}`, 'blocked-config');
    files.push({ path, sha256: hash(source), owner: owner.path, package: manifest.name,
      testScript: manifest.scripts.test, runner: owner.runner,
      workspaceDependencies: Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })
        .filter(([, version]) => version.startsWith('workspace:')).map(([name]) => name).sort() });
  }
  for (const path of ['AGENTS.md', '.github/skills/tests/SKILL.md', 'server/test-config.json',
    'jest.config.base.js', ...alOwners.filter(owner => owner.runner === 'jest').map(owner => `${owner.path}/jest.config.js`)]) {
    const source = (await git(['show', `${revision}:${path}`])).stdout;
    files.push({ path, sha256: hash(source) });
  }
  return { revision, files, profile: alReference(profilePath), testPrefixes: alTestPrefixes };
}

export function alNativeConfig(template, root, mode) {
  const config = structuredClone(template);
  requireThat(config.repositories.length === 1, 'AL native request needs exactly one repository', 'blocked-owner');
  const repo = config.repositories[0];
  requireThat(repo.remote.replace(/\/$/, '').toLowerCase() ===
    'https://dev.azure.com/office/iss/_git/augloop-workflows',
  'AL adapter cannot route another repository', 'blocked-owner');
  config.stateDirectory = join(root, 'state');
  config.runtime.validationCacheDirectory = join(root, 'cache');
  delete config.runtime.authoringFeedback;
  delete config.runtime.executionAuthorization;
  config.activation = { collect: false, review: false, dispatch: false };
  config.limits.maxValidationInfrastructureRetries = 0;
  config.limits.maxWorkers = 1;
  repo.allowedWritePrefixes = [...alTestPrefixes];
  repo.allowedWriteFiles = [];
  repo.routingApproved = false;
  repo.routingRules = ['All four supported AL integration owners; no production, shared harness, manifests, runners or CI edits.'];
  for (const binding of repo.skillBindings) {
    binding.allowedWritePrefixes = [...alTestPrefixes];
    binding.allowedWriteFiles = [];
    binding.enabled = false;
    binding.qualification = 'unqualified';
    binding.sideEffects = { commit: false, push: false, createDraftPR: false };
  }
  repo.validationGates = [{
    id: 'al-four-owner-native', approved: true, isolationVerified: false,
    executable: repo.validationGates[0].executable,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', '{profile}',
      '-Mode', mode, '-ArtifactDirectory', join(root, 'native-artifacts')],
    profilePath, profileSha256: alReference(profilePath).sha256, timeoutMs: 3600000,
    testRebuiltOutputPaths: alOwners.map(owner => `${owner.path}/dist`)
  }];
  return config;
}

export function inspectAlNativeProof(results, expectedRevision, mode, profileSha256) {
  requireThat(results.length === 1 && results[0].status === 'passed' &&
    results[0].sourceRevision === expectedRevision && results[0].artifactRefs.length === 1,
  'All AL native stages and immutable-output cleanup must pass', 'blocked-validation');
  const artifact = read(results[0].artifactRefs[0]);
  requireThat(artifact.status === 'passed' && artifact.revision === expectedRevision &&
    /^[a-f0-9]{64}$/.test(profileSha256 ?? '') && artifact.profileSha256 === profileSha256,
    'AL native artifact does not bind the accepted exact head', 'blocked-reconciliation');
  const marker = 'PILOT_VALIDATION_TEST_RESULT:';
  const proofs = (artifact.output?.stdout ?? '').split(/\r?\n/)
    .filter(line => line.startsWith(marker)).map(line => JSON.parse(line.slice(marker.length)));
  requireThat(proofs.length === alOwners.length && new Set(proofs.map(proof => proof.owner)).size === alOwners.length,
    'AL needs independent native results for all four owners', 'blocked-validation');
  for (const owner of alOwners) {
    const proof = proofs.find(item => item.owner === owner.path);
    requireThat(proof?.package === owner.package && proof.runner === owner.runner &&
      proof.mode === mode && proof.sourceRevision === expectedRevision &&
      proof.suiteCount > 0 && proof.testCount > 0 &&
      (mode !== 'qualification' || proof.selectedTests.length > 0) &&
      alReference(proof.resultPath).sha256 === proof.resultSha256,
    `Incomplete native AL proof: ${owner.path}`, 'blocked-validation');
  }
  return { artifact: alReference(results[0].artifactRefs[0]), owners: proofs };
}

export function requireAlQualification(qualified, repo) {
  requireThat(qualified.state === 'qualified-native-backend' &&
    qualified.baseRevision === repo.baseRef && qualified.revision === repo.baseRef &&
    qualified.profile.sha256 === repo.validationGates[0].profileSha256 &&
    alReference(qualified.config.path).sha256 === qualified.config.sha256,
  'AL backend qualification source/profile/configuration differs from the requested backend', 'blocked-reconciliation');
  const previousConfig = read(qualified.config.path), prior = previousConfig.repositories;
  requireThat(qualified.cacheDirectory === previousConfig.runtime?.validationCacheDirectory &&
    qualified.artifact?.path === qualified.validation?.[0]?.artifactRefs?.[0] &&
    alReference(qualified.artifact.path).sha256 === qualified.artifact.sha256,
  'AL qualification sealed artifact or cache binding changed', 'blocked-reconciliation');
  requireThat(prior.length === 1 && prior[0].id === repo.id && prior[0].remote === repo.remote &&
    prior[0].baseRef === repo.baseRef && prior[0].validationGates.length === 1,
  'AL qualification belongs to a different repository', 'blocked-reconciliation');
  const gate = prior[0].validationGates[0], next = repo.validationGates[0];
  requireThat(gate.approved === true && gate.id === next.id && gate.executable === next.executable &&
    gate.profileSha256 === next.profileSha256 &&
    json(gate.testRebuiltOutputPaths) === json(next.testRebuiltOutputPaths),
  'AL qualification native runner or immutable-output contract changed', 'blocked-reconciliation');
  const inspected = inspectAlNativeProof(qualified.validation, qualified.baseRevision, 'qualification', qualified.profile.sha256);
  requireThat(json(inspected.artifact) === json(qualified.artifact) &&
    json(inspected.owners) === json(qualified.owners),
  'AL qualification sealed owner proofs changed', 'blocked-reconciliation');
  return inspected;
}

export async function authenticateAlNative(config, repo, revision, root, approved, execute = command) {
  const actions = await preflightValidationAuthentication(config, repo, revision, execute, { force: true });
  put(join(root, 'authentication-preflight.json'), { observedAt: now(), forced: true, actions });
  if (!actions.length) return;
  requireThat(approved === true, 'Native authentication remediation needs explicit request approval', 'blocked-auth');
  for (const [index, action] of actions.entries()) {
    requireThat(action.feedCount === 1 && action.remediation.args.includes('AugmentationLoop'),
      'AL remediation must use the existing single-feed contract route', 'blocked-auth');
    const run = execute === command ? nativeCommand : execute;
    const result = await run(action.remediation.command, action.remediation.args,
      action.remediation.cwd, 600000, process.env);
    put(join(root, `authentication-remediation-${index}.json`), {
      observedAt: now(), gateId: action.gateId, exitCode: 0,
      outputSha256: hash(json(result)), tokenRecorded: false
    });
  }
  const remaining = await preflightValidationAuthentication(config, repo, revision, execute, { force: true });
  put(join(root, 'authentication-recheck.json'), { observedAt: now(), actions: remaining });
  requireThat(!remaining.length, 'AL authentication remains blocked after one remediation', 'blocked-auth');
}

export async function runAlNative(request, mode, { execute = command } = {}) {
  requireThat(['qualification', 'candidate'].includes(mode), 'Unknown AL native mode', 'blocked-config');
  requireThat(request.nativeExecutionApproved === true && isAbsolute(request.runDirectory),
    'AL native execution requires explicit approval and an absolute fresh run directory', 'blocked-authorization');
  const root = resolve(request.runDirectory);
  requireThat(!existsSync(root), 'AL run directory already exists; preserve/reconcile it instead of overwriting', 'blocked-reconciliation');
  mkdirSync(root, { recursive: true });
  const template = configAt(request.templateConfig);
  const config = alNativeConfig(template, root, mode);
  const repo = config.repositories[0];
  let ledger;
  try {
    const source = await inspectAlSource(repo, execute);
    put(join(root, 'source-contracts.json'), source);
    let revision = source.revision, workspace = repo.referenceCheckout;
    if (mode === 'candidate') {
      requireThat(request.qualification && alReference(request.qualification.path).sha256 === request.qualification.sha256,
        'Candidate replay requires a pinned completed backend qualification', 'blocked-reconciliation');
      const qualified = read(request.qualification.path);
      requireAlQualification(qualified, repo);
      requireThat(request.originalCandidate && alReference(request.originalCandidate.path).sha256 === request.originalCandidate.sha256,
        'Replay requires the original genuine model-result receipt', 'blocked-reconciliation');
      const original = read(request.originalCandidate.path);
      revision = original.authoredHead;
      requireThat(original.baseRevision === source.revision && original.workerResult?.sourceRevision === revision &&
        original.workerResult?.skillExecution?.status === 'succeeded' && original.workerResult?.evidenceIds?.length > 0,
      'Original candidate provenance is incomplete', 'blocked-reconciliation');
      workspace = request.candidateCheckout;
      requireThat(isAbsolute(workspace), 'Replay needs a checkout already containing the original candidate', 'blocked-config');
      const head = (await execute('git', ['rev-parse', 'HEAD'], workspace)).stdout.trim();
      requireThat(head === revision && !(await execute('git', ['status', '--porcelain'], workspace)).stdout.trim(),
        'Replay source must be clean at the exact original authored commit', 'blocked-reconciliation');
      const changed = (await execute('git', ['diff', '--name-only', '--no-renames', source.revision, revision, '--'], workspace))
        .stdout.trim().split(/\r?\n/);
      requireAlPaths(changed);
      requireThat(json([...changed].sort()) === json([...original.changedFiles].sort()),
        'Replay changed paths differ from original model receipt', 'blocked-reconciliation');
      config.runtime.validationCacheDirectory = qualified.cacheDirectory;
      repo.validationGates[0].isolationVerified = true;
      put(join(root, 'candidate-provenance.json'), { original: request.originalCandidate, qualification: request.qualification,
        revision, changedFiles: changed, mode: 'deterministic-original-candidate-replay', modelCalls: 0 });
    }
    put(join(root, 'config.json'), config);
    put(join(root, 'execution-start.json'), { observedAt: now(), mode, baseRevision: source.revision, revision,
      profile: source.profile, config: alReference(join(root, 'config.json')), actualModelSessionsStarted: 0 });
    await authenticateAlNative(config, repo, source.revision, root, request.authenticationRemediationApproved, execute);
    ledger = new Ledger(config.stateDirectory);
    const job = { id: `al-native-${mode}-${hash(json([root, revision]))}`,
      workspace, base_revision: source.revision, repo_id: repo.id };
    const onProgress = event => {
      writeFileSync(join(root, 'progress.json'), `${JSON.stringify({ observedAt: now(), mode, ...event }, null, 2)}\n`);
      console.log(json({ observedAt: now(), mode, ...event }));
    };
    const validation = await withAlPreparationProgress(root, async () => {
      const prepared = await prepareValidation(config, job, repo, source.revision, execute, { onProgress });
      put(join(root, 'preparation.json'), prepared);
      return runValidation(config, ledger, job, repo, revision, execute, undefined, prepared);
    });
    put(join(root, 'validation.json'), validation);
    const proof = inspectAlNativeProof(validation, revision, mode, source.profile.sha256);
    requireThat(alReference(profilePath).sha256 === source.profile.sha256,
      'AL profile changed during native execution', 'blocked-reconciliation');
    const skill = await qualifyRepositorySkill(config, repo.id, 'integration-test-authoring');
    put(join(root, 'skill-provenance.json'), skill);
    const result = {
      format: 'al-native-backend-result-v1',
      state: mode === 'qualification' ? 'qualified-native-backend' : 'validated-original-candidate-replay',
      observedAt: now(), baseRevision: source.revision, revision, profile: source.profile,
      config: alReference(join(root, 'config.json')), cacheDirectory: config.runtime.validationCacheDirectory,
      validation, ...proof, skillProvenance: alReference(join(root, 'skill-provenance.json')),
      actualModelSessionsStarted: 0, freshEvidenceE2E: false, publicationPerformed: false,
      qualificationMeaning: 'Real isolated native preparation, owner tests and immutable-output cleanup; not new candidate authoring or fresh evidence E2E.'
    };
    put(join(root, 'result.json'), result);
    return result;
  } catch (error) {
    put(join(root, 'failure.json'), { observedAt: now(), mode, error: safeError(error),
      diagnostic: error.message, actualModelSessionsStarted: 0, publicationPerformed: false });
    throw error;
  } finally { ledger?.close(); }
}

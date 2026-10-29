import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { join, relative, resolve, isAbsolute, dirname, basename } from 'node:path';
import { boundedPath, hash, json, requireThat, safeError, utc, validateRecord } from './common.js';
import { describeAgent } from './agents.js';
import { pinRsiEvaluation } from './rsi-evaluation.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const trust = 'captured-controller-state-not-independent-e2e-qualification';
const terminal = new Set(['finished']);
const errorHandoffs = new WeakMap();
const protectedPaths = [
  'src/rsi-', 'src/agents.js', 'src/common.js',
  'src/self-improvement', 'scaffold/contracts.schema.json',
  '.github/skills/evidence-rsi'
];

function controllerIdentity() {
  const files = [];
  function add(path, name) {
    const stat = lstatSync(path);
    requireThat(!stat.isSymbolicLink(), 'Linked RSI controller inputs are unsupported', 'blocked-scope');
    if (stat.isDirectory()) {
      for (const child of readdirSync(path).sort()) add(join(path, child), `${name}/${child}`);
    } else {
      requireThat(stat.isFile() && stat.nlink === 1, 'RSI controller input is not a regular file', 'blocked-scope');
      files.push({ path: name, sha256: hash(readFileSync(path)) });
    }
  }
  for (const name of ['src', '.github/skills', 'scaffold/contracts.schema.json',
    'scaffold/coordinator.instructions.md', 'APP-NATIVE.md', 'package.json', 'package-lock.json'])
    add(join(root, name), name);
  return validateRecord({
    sourceSha256: hash(json(files)),
    skillSha256: describeAgent('rsi').skill.sha256,
    dependencyLockSha256: hash(readFileSync(join(root, 'package-lock.json'))),
    nodeVersion: process.version
  }, 'rsiControllerIdentity');
}
// This pin belongs to the loaded controller, not a later tree observed after execution.
const loadedIdentity = controllerIdentity();
export function pinRsiController() {
  const current = controllerIdentity();
  requireThat(json(current) === json(loadedIdentity),
    'RSI controller/skill source changed in this process; retain the original run', 'blocked-reconciliation');
  return structuredClone(loadedIdentity);
}

export function rsiPolicy(config) {
  const policy = validateRecord(config.rsi ?? { enabled: false }, 'rsiPolicy');
  if (policy.enabled) requireThat(config.statePolicy?.accessApproved === true,
    'RSI requires approved local outcome storage', 'blocked-authorization');
  return policy;
}

export function rsiAutomationPolicy(config) {
  const policy = rsiPolicy(config);
  if (!policy.enabled || !policy.automation) return null;
  const automation = validateRecord(policy.automation, 'rsiAutomation');
  if (automation.executionMode !== 'app-hosted') {
    const provider = config.authoringProviders?.[automation.authoringProvider];
    requireThat(provider?.type === 'agency-local' && isAbsolute(provider.executable) &&
      /^[a-zA-Z0-9_.-]+$/.test(provider.profile),
    'RSI automation needs an explicitly configured restricted Local Agency provider', 'blocked-authorization');
  }
  requireThat(!automation.evaluation.flowPlan || automation.executionMode === 'app-hosted',
    'App role flow evaluation requires app-hosted execution', 'blocked-authorization');
  requireThat(isAbsolute(automation.referenceCheckout),
    'RSI automation requires an explicit reference checkout', 'blocked-scope');
  pinRsiEvaluation(automation.evaluation, automation.referenceCheckout);
  return automation;
}

function verificationGit(args, cwd, admit) {
  const timeout = Math.min(10000, admit());
  requireThat(Number.isSafeInteger(timeout) && timeout > 0,
    'RSI verification admission expired', 'blocked-budget');
  return execFileSync('git', ['--no-pager', '--no-optional-locks', '-c', 'core.longpaths=true', ...args], {
    cwd, encoding: 'utf8', timeout, maxBuffer: 1048576,
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

export function isCleanRsiHead(status, revision) {
  const lines = status.trim().split(/\r?\n/);
  return lines.filter(line => line.startsWith('# branch.oid ')).join('\n') === `# branch.oid ${revision}` &&
    lines.filter(line => line.startsWith('# branch.head ')).length === 1 &&
    lines.every(line => line.startsWith('# '));
}

function pinTargetBaseline(config, admit = () => 10000) {
  const automatic = config.rsi.automation;
  const target = config.rsi.targetBaseline ?? (automatic ? {
    referenceCheckout: automatic.referenceCheckout, revision: automatic.baselineRevision,
    branch: automatic.targetBranch
  } : null);
  if (!target) return null;
  validateRecord(target, 'rsiTargetBaseline');
  requireThat(isAbsolute(target.referenceCheckout) && (!automatic ||
    (resolve(target.referenceCheckout) === resolve(automatic.referenceCheckout) &&
      target.revision === automatic.baselineRevision && target.branch === automatic.targetBranch)),
  'RSI publication target conflicts with the automation baseline', 'blocked-reconciliation');
  const git = args => verificationGit(args, target.referenceCheckout, admit);
  const repository = config.rsi.targetRepository;
  requireThat([`https://github.com/${repository}`, `https://github.com/${repository}.git`,
    `git@github.com:${repository}`, `git@github.com:${repository}.git`]
    .includes(git(['remote', 'get-url', 'origin'])) &&
    git(['rev-parse', `refs/heads/${target.branch}`]) === target.revision &&
    isCleanRsiHead(git(['status', '--porcelain=v2', '--branch', '--untracked-files=all']), target.revision),
  'RSI publication target baseline is stale or differs from its pinned repository', 'blocked-reconciliation');
  return { ...target, referenceCheckout: realpathSync.native(target.referenceCheckout) };
}

export function assertRsiProducerNamespace(config) {
  let parent = resolve(config.stateDirectory);
  const suffix = [];
  while (!existsSync(parent)) {
    suffix.unshift(basename(parent));
    requireThat(dirname(parent) !== parent, 'Cannot resolve producer state root', 'blocked-scope');
    parent = dirname(parent);
  }
  const state = resolve(realpathSync.native(parent), ...suffix);
  const reserved = relative(join(realpathSync.native(root), '.state', 'rsi'), state);
  requireThat((reserved === '..' || reserved.startsWith('..\\') || reserved.startsWith('../') ||
    isAbsolute(reserved)),
  'Flow state cannot open or alter an offline RSI qualification root', 'blocked-scope');
  for (let path = state; ; path = dirname(path)) {
    requireThat(!existsSync(join(path, '.rsi-root.json')),
      'Flow state cannot open or alter an offline RSI qualification root', 'blocked-scope');
    if (dirname(path) === path) break;
  }
}

function checked(config, ledger) {
  const policy = rsiPolicy(config);
  requireThat(policy.enabled, 'RSI is disabled for this configuration', 'blocked-authorization');
  assertRsiProducerNamespace(config);
  const path = relative(resolve(config.stateDirectory), resolve(ledger.directory));
  requireThat(path !== '..' && !path.startsWith(`..\\`) && !path.startsWith('../') && !isAbsolute(path),
    'RSI ledger is outside the configured producer state', 'blocked-scope');
  requireThat(!ledger.db.prepare("SELECT 1 FROM operations WHERE kind='rsi-store'").get(),
    'Flow outcomes cannot enter an offline qualification store', 'blocked-scope');
  return policy;
}

const bindingId = (origin, flowId) => `rsi-flow-${hash(json([origin, flowId]))}`;
const taskId = observationId => `rsi-task-${hash(observationId)}`;
function bounded(value, policy) {
  requireThat(Buffer.byteLength(json(value)) <= policy.maxObservationBytes,
    'RSI outcome exceeds its configured byte bound; original producer evidence is retained', 'blocked-budget');
  return value;
}
function queue(ledger, observation) {
  const id = taskId(observation.id);
  return ledger.get('rsiWorkItem', id) ?? ledger.put({
    recordType: 'rsiWorkItem', schemaVersion: '1.0', id, version: 1,
    observationId: observation.id, state: 'queued', claim: null,
    proposal: null, publicationKey: null, result: null
  });
}
function bindingIsCurrent(binding) {
  return json(binding.controller) === json(loadedIdentity) &&
    describeAgent('rsi').skill.sha256 === binding.controller.skillSha256;
}
function handoff(observation, work, binding) {
  requireThat(observation && binding?.id === observation.bindingId,
    'RSI work item has no original observation/binding', 'blocked-reconciliation');
  const skill = describeAgent('rsi').skill;
  const stale = !bindingIsCurrent(binding);
  return {
    state: work.state, observationId: observation.id, payloadSha256: observation.payloadSha256,
    taskId: work.id, taskVersion: work.version,
    nextRole: work.state === 'finished' || stale ? null : 'rsi',
    skill: { ...skill, sha256: binding.controller.skillSha256 },
    controller: binding.controller, bindingState: stale ? 'stale-controller' : 'current',
    invocation: stale ? 'blocked-stale-controller' : 'host-must-invoke-skill',
    modelExecutedByHelper: false,
    qualification: 'not-inferred'
  };
}

export function bindRsiProducer(config, ledger, origin, flowId, upstream = null) {
  if (!rsiPolicy(config).enabled) return null;
  const policy = checked(config, ledger);
  rsiAutomationPolicy(config);
  const binding = validateRecord({
    recordType: 'rsiFlowBinding', schemaVersion: '1.0', id: bindingId(origin, flowId),
    version: 1, origin, flowId, configSha256: hash(json(config)), controller: pinRsiController(),
    upstream, targetBaseline: pinTargetBaseline(config)
  });
  bounded(binding, policy);
  return ledger.transaction(() => {
    const old = ledger.get('rsiFlowBinding', binding.id);
    if (!old) requireThat(ledger.all('rsiFlowBinding').length < policy.maxObservations,
      'RSI producer admission bound reached', 'blocked-budget');
    return ledger.put(binding);
  });
}

function requireBinding(config, ledger, origin, flowId) {
  const binding = ledger.get('rsiFlowBinding', bindingId(origin, flowId));
  requireThat(binding && binding.configSha256 === hash(json(config)) &&
    json(binding.controller) === json(pinRsiController()),
  'RSI requires the original pre-execution source/configuration binding; do not relabel old evidence',
  'blocked-reconciliation');
  return binding;
}

function capture(config, ledger, binding, payload) {
  const policy = checked(config, ledger);
  const payloadSha256 = hash(json(payload));
  const observation = bounded(validateRecord({
    recordType: 'rsiFlowObservation', schemaVersion: '1.0',
    id: `rsi-observation-${hash(json([binding.id, payloadSha256]))}`, version: 1,
    bindingId: binding.id, payloadSha256, payload
  }), policy);
  return ledger.transaction(() => {
    const old = ledger.get('rsiFlowObservation', observation.id);
    if (!old) requireThat(ledger.all('rsiFlowObservation').length < policy.maxObservations,
      'RSI observation bound reached; no observation was dropped or overwritten', 'blocked-budget');
    const saved = ledger.put(observation);
    return handoff(saved, queue(ledger, saved), binding);
  });
}

function workerArtifacts(config, assignmentId, policy) {
  const directory = join(config.stateDirectory, 'runs', assignmentId);
  if (!existsSync(join(directory, 'manifest.json'))) return { state: 'unavailable', files: [] };
  const path = boundedPath(config.stateDirectory, join('runs', assignmentId, 'manifest.json'));
  const stat = lstatSync(path);
  requireThat(stat.size <= policy.maxObservationBytes && stat.nlink === 1,
    'RSI producer manifest exceeds its bound or is linked', 'blocked-budget');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  requireThat(manifest.runId === assignmentId && Array.isArray(manifest.artifacts),
    'RSI producer artifact manifest has the wrong identity', 'blocked-reconciliation');
  const files = [];
  let bytes = stat.size;
  for (const entry of manifest.artifacts) {
    requireThat(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 &&
      typeof entry.path === 'string', 'Malformed producer artifact entry', 'blocked-reconciliation');
    bytes += entry.bytes;
    requireThat(bytes <= policy.maxObservationBytes,
      'RSI trace capture exceeds its bound; original artifacts remain retained', 'blocked-budget');
    const artifactPath = boundedPath(directory, entry.path);
    const metadata = lstatSync(artifactPath);
    requireThat(metadata.isFile() && metadata.nlink === 1 && metadata.size === entry.bytes,
      'Producer artifact changed before RSI capture', 'blocked-reconciliation');
    const content = readFileSync(artifactPath);
    requireThat(hash(content) === entry.sha256, 'Producer artifact hash changed', 'blocked-reconciliation');
    files.push({ path: entry.path, sha256: entry.sha256, bytes: entry.bytes });
  }
  const days = config.statePolicy.rawEvidenceDays;
  requireThat(Number.isInteger(days) && days >= 1 && days <= 7,
    'RSI raw artifact references require the existing 1-7 day retention policy', 'blocked-authorization');
  const expiresAt = new Date(Date.parse(utc(manifest.completedAt ?? manifest.createdAt)) +
    days * 86400000).toISOString();
  return { state: 'referenced', runId: assignmentId, expiresAt,
    manifestSha256: hash(readFileSync(path)), files };
}

export function inspectRsiArtifacts(config, observation, nowMs = Date.now()) {
  const artifacts = observation.payload.data.artifacts;
  if (!artifacts || artifacts.state !== 'referenced') return { state: 'unavailable', files: [] };
  requireThat(Number.isFinite(nowMs), 'RSI artifact inspection needs a finite clock', 'invalid-record');
  if (nowMs >= Date.parse(utc(artifacts.expiresAt)))
    return { state: 'expired', expiresAt: artifacts.expiresAt, files: artifacts.files };
  const directory = join(config.stateDirectory, 'runs', artifacts.runId);
  if (!existsSync(join(directory, 'manifest.json')))
    return { state: 'unavailable', expiresAt: artifacts.expiresAt, files: artifacts.files };
  const manifest = boundedPath(config.stateDirectory, join('runs', artifacts.runId, 'manifest.json'));
  requireThat(lstatSync(manifest).isFile() && lstatSync(manifest).nlink === 1 &&
    lstatSync(manifest).size <= config.rsi.maxObservationBytes,
  'RSI artifact manifest is linked or exceeds its read bound', 'blocked-budget');
  if (hash(readFileSync(manifest)) !== artifacts.manifestSha256)
    return { state: 'changed', expiresAt: artifacts.expiresAt, files: artifacts.files };
  const files = artifacts.files.map((entry, index) => {
    if (!existsSync(join(directory, entry.path))) return { ...entry, state: 'unavailable' };
    const path = boundedPath(directory, entry.path);
    const info = lstatSync(path);
    const matches = info.isFile() && info.nlink === 1 && info.size === entry.bytes &&
      hash(readFileSync(path)) === entry.sha256;
    return { ...entry, state: matches ? 'available' : 'changed', readPath: `rsi-artifacts/${index}` };
  });
  return { state: files.every(entry => entry.state === 'available') ? 'available' : 'unavailable',
    expiresAt: artifacts.expiresAt, files };
}

export function readRsiArtifact(config, observation, index) {
  const available = inspectRsiArtifacts(config, observation);
  const entry = available.files[index];
  requireThat(available.state === 'available' && entry?.state === 'available',
    `RSI raw artifact is ${available.state}; no retained copy or substitute is available`, 'unavailable');
  return readFileSync(boundedPath(config.stateDirectory,
    join('runs', observation.payload.data.artifacts.runId, entry.path)), 'utf8');
}

export function captureWorkerRsiOutcome(config, ledger, workerResultId) {
  const policy = checked(config, ledger);
  const result = ledger.get('workerResult', workerResultId);
  requireThat(result, 'Unknown immutable worker result', 'blocked-reconciliation');
  validateRecord(result);
  const binding = requireBinding(config, ledger, 'worker', result.assignmentId);
  // Redelivery retains metadata, never a second raw-artifact retention lease.
  const old = ledger.all('rsiFlowObservation').find(row =>
    row.bindingId === binding.id && row.payload.data.workerResult?.id === result.id);
  if (old) return ledger.transaction(() => {
    requireThat(hash(json(old.payload)) === old.payloadSha256 &&
      json(old.payload.data.workerResult) === json(result),
    'RSI captured worker result changed', 'blocked-reconciliation');
    return handoff(old, queue(ledger, old), binding);
  });
  const assignment = ledger.get('assignment', result.assignmentId);
  requireThat(assignment && json(assignment.evidenceIds) === json(result.evidenceIds),
    'Worker outcome has no matching assignment/evidence binding', 'blocked-reconciliation');
  const evidence = assignment.evidenceIds.map(id => ledger.get('evidence', id));
  requireThat(evidence.every(Boolean), 'Worker evidence is unavailable for RSI', 'blocked-reconciliation');
  const captures = [...new Set(evidence.map(row => row.capture?.sha256).filter(Boolean))].map(sha256 => {
    const row = ledger.db.prepare('SELECT body FROM captures WHERE hash=?').get(sha256);
    requireThat(row, 'Original source capture is unavailable for RSI', 'blocked-reconciliation');
    const bytes = Buffer.isBuffer(row.body) ? row.body : Buffer.from(row.body);
    requireThat(hash(bytes) === sha256, 'Original source capture hash changed', 'blocked-reconciliation');
    return { sha256, contentBase64: bytes.toString('base64') };
  });
  return capture(config, ledger, binding, {
    kind: 'worker', outcome: result.outcome, evidenceTrust: trust,
    data: {
      workerResult: result, assignment, evidence, captures,
      investigation: ledger.get('investigation', assignment.investigationId, assignment.investigationVersion),
      operations: ledger.db.prepare('SELECT id,kind,state,detail FROM operations WHERE job_id=? ORDER BY id')
        .all(assignment.id).map(row => ({ ...row, detail: JSON.parse(row.detail) })),
      artifacts: workerArtifacts(config, assignment.id, policy),
      upstreamExecution: 'inspect-original-receipts-not-inferred-from-worker-success'
    }
  });
}

export function captureAppRsiOutcome(config, ledger, runId, summary) {
  const policy = checked(config, ledger);
  const binding = requireBinding(config, ledger, 'app-flow', runId);
  requireThat(summary.runId === runId, 'RSI app summary belongs to a different run', 'blocked-reconciliation');
  const row = ledger.db.prepare('SELECT body FROM app_runs WHERE id=?').get(runId);
  requireThat(row && JSON.parse(row.body).configHash === binding.configSha256,
    'RSI app run configuration changed', 'blocked-reconciliation');
  const selected = new Set(summary.collection.flatMap(pass => pass.evidenceIds ?? []));
  const scopedSummary = {
    ...summary,
    report: {
      issues: summary.report.issues.filter(issue => selected.has(issue.evidenceId)),
      audit: summary.report.audit.filter(issue => selected.has(issue.evidenceId)),
      summary: Object.fromEntries(Object.entries(summary.report.summary)
        .map(([key, ids]) => [key, ids.filter(id => selected.has(id))])),
      scope: 'selected-app-run-evidence-only'
    }
  };
  const payload = {
    kind: 'app-flow', outcome: summary.state, evidenceTrust: trust,
    data: {
      run: JSON.parse(row.body), summary: scopedSummary,
      events: ledger.db.prepare('SELECT id,pass,body FROM app_events WHERE run_id=? ORDER BY id')
        .all(runId).map(event => ({ ...event, body: JSON.parse(event.body) })),
      upstreamExecution: 'app-tool-receipts-not-cryptographic-execution-attestation'
    }
  };
  // Keep large receipts in their original producer ledger. The bounded observation
  // pins every byte; callers read finite pages without renewing raw retention.
  if (Buffer.byteLength(json(payload)) + 1024 > policy.maxObservationBytes) {
    const run = payload.data.run;
    const expiresAt = new Date(Date.parse(utc(run.startedAt)) +
      config.statePolicy.rawEvidenceDays * 86400000).toISOString();
    payload.data.events = payload.data.events.map(event => {
      const original = ledger.db.prepare('SELECT body FROM app_events WHERE id=? AND run_id=?').get(event.id, runId).body;
      return { id: event.id, pass: event.pass, sha256: hash(original), bytes: Buffer.byteLength(original) };
    });
    payload.data.eventReferences = { format: 'producer-event-pages-v1', runId, expiresAt,
      pageBytes: Math.min(16384, Math.floor(policy.maxObservationBytes / 4)),
      encoding: 'base64', readPath: 'rsi-events/INDEX/PAGE' };
  }
  return capture(config, ledger, binding, payload);
}

export function readRsiEvent(config, ledger, observation, index, page, nowMs = Date.now()) {
  const references = observation.payload.data.eventReferences;
  const entry = observation.payload.data.events?.[index];
  requireThat(hash(json(observation.payload)) === observation.payloadSha256 &&
    references?.format === 'producer-event-pages-v1' && entry &&
    Number.isSafeInteger(index) && index >= 0 && Number.isSafeInteger(page) && page >= 0 &&
    Number.isFinite(nowMs) && nowMs < Date.parse(utc(references.expiresAt)),
  'RSI event reference is expired or invalid', 'unavailable');
  requireThat(Number.isSafeInteger(references.pageBytes) && references.pageBytes > 0 &&
    references.pageBytes <= Math.min(16384, Math.floor(config.rsi.maxObservationBytes / 4)),
  'RSI event page exceeds its bound', 'blocked-budget');
  const row = ledger.db.prepare('SELECT body FROM app_events WHERE id=? AND run_id=? AND pass=?')
    .get(entry.id, references.runId, entry.pass);
  requireThat(row && hash(row.body) === entry.sha256 && Buffer.byteLength(row.body) === entry.bytes,
    'Original RSI event is unavailable or changed', 'unavailable');
  const bytes = Buffer.from(row.body), offset = page * references.pageBytes;
  requireThat(Number.isSafeInteger(offset) && offset < bytes.length, 'Invalid RSI event page', 'invalid-record');
  return { sha256: entry.sha256, bytes: bytes.length, offset,
    contentBase64: bytes.subarray(offset, offset + references.pageBytes).toString('base64'),
    nextPage: offset + references.pageBytes < bytes.length ? page + 1 : null };
}

export async function withRsiWorker(config, ledger, assignmentId, execute, upstream = null, dependencies = {}) {
  if (!rsiPolicy(config).enabled) return { result: await execute(), rsi: null };
  bindRsiProducer(config, ledger, 'worker', assignmentId, upstream);
  const deliver = async () => {
    const results = ledger.latest('workerResult').filter(row => row.assignmentId === assignmentId);
    if (!results.length) return { state: 'blocked', error: {
      code: 'unavailable', message: 'Producer has no terminal worker result; reconcile execution, never rerun for RSI.'
    } };
    try {
      const handoffs = results.map(row => captureWorkerRsiOutcome(config, ledger, row.id));
      if (!config.rsi.automation) return { state: 'delivered', handoffs };
      const { runRsiPending } = await import('./rsi-execution.js');
      const execution = await runRsiPending(config, ledger, {}, dependencies);
      return { state: 'delivered',
        handoffs: results.map(row => captureWorkerRsiOutcome(config, ledger, row.id)), execution };
    } catch (error) {
      return { state: 'blocked', error: safeError(error), workerResultIds: results.map(row => row.id) };
    }
  };
  try {
    const result = await execute();
    return { result, rsi: await deliver() };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error('Producer failed without an error object');
    errorHandoffs.set(failure, await deliver());
    throw failure;
  }
}
export function rsiErrorHandoff(error) { return errorHandoffs.get(error); }

function taskContext(config, ledger, input, runId = null) {
  checked(config, ledger);
  const observation = ledger.get('rsiFlowObservation', input.observationId);
  requireThat(observation && observation.payloadSha256 === hash(json(observation.payload)),
    'Unknown or changed RSI observation', 'blocked-reconciliation');
  const binding = ledger.get('rsiFlowBinding', observation.bindingId);
  requireThat(binding, 'Missing RSI producer binding', 'blocked-reconciliation');
  requireThat(runId === null || (binding.origin === 'app-flow' && binding.flowId === runId),
    'RSI observation belongs to a different app run', 'blocked-scope');
  requireBinding(config, ledger, binding.origin, binding.flowId);
  const work = ledger.get('rsiWorkItem', taskId(observation.id));
  requireThat(work, 'Missing RSI work item; recapture the exact outcome', 'blocked-reconciliation');
  return { observation, binding, work };
}
function exactClaim(input) {
  return { observationId: input.observationId, claimId: input.claimId, executorId: input.executorId };
}
function claimed(work, input) {
  requireThat(work.claim && json(work.claim) === json(exactClaim(input)),
    'RSI claim/executor changed; reconcile the original execution handle', 'overlap');
}
function save(ledger, work, change, admit) {
  admit();
  return ledger.put({ ...work, ...change, version: work.version + 1 });
}

function verifyCandidate(config, proposal, binding, admit) {
  requireThat(binding.targetBaseline && json(binding.targetBaseline) === json(pinTargetBaseline(config, admit)) &&
    proposal.baselineRevision === binding.targetBaseline.revision,
  'RSI proposal must use its independently pinned publication target baseline', 'blocked-reconciliation');
  const path = resolve(proposal.workspace);
  const canonical = value => {
    const resolved = existsSync(value) ? realpathSync.native(value) : resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  requireThat(isAbsolute(proposal.workspace) && canonical(path) !== canonical(root) &&
    canonical(path) !== canonical(binding.targetBaseline.referenceCheckout) &&
    !(config.repositories ?? []).some(repo => canonical(path) === canonical(repo.referenceCheckout)),
  'RSI candidate requires its own isolated checkout', 'blocked-scope');
  const metadata = lstatSync(path);
  requireThat(metadata.isDirectory() && !metadata.isSymbolicLink(),
    'RSI candidate checkout is linked or unavailable', 'blocked-scope');
  const git = args => verificationGit(args, path, admit);
  requireThat(resolve(git(['rev-parse', '--show-toplevel'])) === path &&
    isCleanRsiHead(git(['status', '--porcelain=v2', '--branch', '--untracked-files=all']), proposal.candidateRevision),
  'RSI candidate must be the exact clean checkout HEAD', 'blocked-reconciliation');
  const target = config.rsi.targetRepository;
  requireThat([
    `https://github.com/${target}`, `https://github.com/${target}.git`,
    `git@github.com:${target}`, `git@github.com:${target}.git`
  ].includes(git(['remote', 'get-url', 'origin'])),
  'RSI candidate remote differs from the authorized repository', 'blocked-scope');
  git(['merge-base', '--is-ancestor', proposal.baselineRevision, proposal.candidateRevision]);
  const changed = git(['diff', '--no-renames', '--name-only',
    proposal.baselineRevision, proposal.candidateRevision]).split(/\r?\n/).filter(Boolean).sort();
  requireThat(json(changed) === json([...proposal.changedFiles].sort()),
    'RSI changed-file declaration differs from the actual candidate diff', 'blocked-scope');
  const entries = git(['ls-tree', '-r', proposal.candidateRevision, '--', ...changed]);
  requireThat(!entries.split(/\r?\n/).some(line => /^(120000|160000) /.test(line)),
    'RSI candidate cannot introduce symbolic links or submodules', 'blocked-scope');
  for (const name of changed) {
    const file = join(path, name);
    if (existsSync(file)) {
      const checkedPath = boundedPath(path, name);
      requireThat(lstatSync(checkedPath).isFile() && lstatSync(checkedPath).nlink === 1,
        'Linked or non-file RSI candidate changes are not allowed', 'blocked-scope');
    }
  }
}

export function rsiWork(config, ledger, operation, input = {}, { runId = null, admit = () => 10000 } = {}) {
  const policy = checked(config, ledger);
  if (operation === 'status') {
    requireThat(Object.keys(input).length === 0, 'RSI status takes no request payload', 'invalid-record');
    const bindings = new Map(ledger.all('rsiFlowBinding').filter(binding => runId === null ||
      (binding.origin === 'app-flow' && binding.flowId === runId)).map(binding => [binding.id, binding]));
    const observations = ledger.all('rsiFlowObservation').filter(row => bindings.has(row.bindingId));
    const ids = new Set(observations.map(row => row.id));
    const work = ledger.latest('rsiWorkItem').filter(row => ids.has(row.observationId));
    const capturedResults = new Set(observations.filter(row => row.payload.kind === 'worker')
      .map(row => row.payload.data.workerResult.id));
    const results = ledger.latest('workerResult');
    const undelivered = [], unresolvedProducers = [];
    for (const binding of bindings.values()) {
      if (binding.origin !== 'worker') continue;
      const produced = results.filter(row => row.assignmentId === binding.flowId);
      if (!produced.length) unresolvedProducers.push({
        bindingId: binding.id, assignmentId: binding.flowId, state: 'execution-unreconciled',
        nextAction: 'Reconcile the original worker execution; never redispatch for RSI.'
      });
      for (const result of produced.filter(row => !capturedResults.has(row.id))) {
        const current = bindingIsCurrent(binding);
        undelivered.push({
          bindingId: binding.id, assignmentId: binding.flowId, workerResultId: result.id,
          controller: binding.controller, state: current ? 'capture-pending' : 'blocked-stale-controller',
          operation: current ? 'capture' : null,
          request: current ? { workerResultId: result.id } : null
        });
      }
    }
    return { state: 'recorded',
      observations: observations.map(({ payload, ...row }) => ({ ...row, outcome: payload.outcome })),
      work, undelivered, unresolvedProducers,
      pending: work.filter(row => !terminal.has(row.state)).map(row => {
        const observation = observations.find(observation => observation.id === row.observationId);
        return handoff(observation, row, bindings.get(observation.bindingId));
      }),
      execution: 'host-invoked-skill', qualification: 'not-inferred' };
  }
  if (operation === 'inspect') {
    requireThat(Object.keys(input).length === 1 && typeof input.observationId === 'string',
      'RSI inspect requires only observationId', 'invalid-record');
    const context = taskContext(config, ledger, input, runId);
    return { ...context, rawArtifacts: inspectRsiArtifacts(config, context.observation), qualification: 'not-inferred' };
  }
  if (operation === 'read-event') {
    requireThat(Object.keys(input).length === 3 && typeof input.observationId === 'string',
      'Event reads require observationId, index and page', 'invalid-record');
    const context = taskContext(config, ledger, input, runId);
    return readRsiEvent(config, ledger, context.observation, input.index, input.page);
  }
  if (operation === 'capture') {
    requireThat(runId === null, 'App-native capture uses its own app-end boundary', 'blocked-scope');
    requireThat(Object.keys(input).length === 1 && typeof input.workerResultId === 'string',
      'RSI capture requires only the original workerResultId', 'invalid-record');
    return captureWorkerRsiOutcome(config, ledger, input.workerResultId);
  }
  requireThat(['claim', 'propose', 'reserve-publication', 'result'].includes(operation),
    'Unknown RSI work operation', 'blocked-scope');
  validateRecord(input, operation === 'propose' ? 'rsiProposalInput'
    : operation === 'result' ? 'rsiResultInput' : 'rsiClaimInput');
  bounded(input, policy);
  return ledger.transaction(() => {
    admit();
    const { work, binding } = taskContext(config, ledger, input, runId);
    if (operation === 'claim') {
      if (binding.targetBaseline) requireThat(json(binding.targetBaseline) === json(pinTargetBaseline(config, admit)),
        'RSI publication target changed before authoring', 'blocked-reconciliation');
      if (work.claim) { claimed(work, input); return work; }
      requireThat(work.state === 'queued' && !ledger.latest('rsiWorkItem').some(row =>
        row.id !== work.id && ['claimed', 'proposed', 'publishing'].includes(row.state)),
      'Another RSI execution is active; do not launch overlapping workers', 'overlap');
      return save(ledger, work, { state: 'claimed', claim: exactClaim(input) }, admit);
    }
    claimed(work, input);
    if (operation === 'propose') {
      if (work.proposal) {
        requireThat(json(work.proposal) === json(input), 'RSI proposal is immutable', 'blocked-reconciliation');
        verifyCandidate(config, input, binding, admit);
        return work;
      }
      requireThat(work.state === 'claimed', 'RSI task is not awaiting a proposal', 'blocked-reconciliation');
      requireThat(input.baselineRevision !== input.candidateRevision,
        'A current/current result is no demonstrated change, not an improvement PR', 'blocked-result');
      requireThat(input.changedFiles.every(path =>
        !path.split('/').some(part => part === '.' || part === '..') &&
        policy.allowedWritePrefixes.some(prefix => path === prefix || path.startsWith(`${prefix}/`)) &&
        !protectedPaths.some(prefix => path.startsWith(prefix))),
      'RSI proposal exceeds its write scope or changes its judge/authority', 'blocked-scope');
      verifyCandidate(config, input, binding, admit);
      const proposals = ledger.latest('rsiWorkItem').filter(row => row.proposal);
      requireThat(proposals.length < policy.maxProposals, 'RSI proposal budget exhausted', 'blocked-budget');
      requireThat(!proposals.some(row => {
        const observation = ledger.get('rsiFlowObservation', row.observationId);
        return observation.bindingId === binding.id || row.proposal.failureFamily === input.failureFamily;
      }), 'RSI flow/failure family already has a proposal; reconcile it instead of creating another', 'overlap');
      return save(ledger, work, { state: 'proposed', proposal: input }, admit);
    }
    if (operation === 'reserve-publication') {
      requireThat(policy.allowDraftPR, 'RSI draft publication is not authorized', 'blocked-authorization');
      requireThat(work.proposal, 'RSI publication requires a recorded proposal', 'blocked-reconciliation');
      verifyCandidate(config, work.proposal, binding, admit);
      if (work.publicationKey) return { ...work, createAllowed: false, nextAction: 'Reconcile the exact existing PR; never create again.' };
      requireThat(work.state === 'proposed', 'RSI publication requires a recorded proposal', 'blocked-reconciliation');
      const publicationKey = `rsi-pr-${hash(json([policy.targetRepository, work.id, work.proposal]))}`;
      return { ...save(ledger, work, { state: 'publishing', publicationKey }, admit),
        createAllowed: true, targetRepository: policy.targetRepository,
        qualification: 'unverified-proposal', mergeAllowed: false };
    }
    if (work.result) {
      requireThat(json(work.result) === json(input), 'RSI result is immutable', 'blocked-reconciliation');
      return work;
    }
    requireThat(['claimed', 'proposed', 'publishing'].includes(work.state),
      'RSI task cannot accept a terminal result', 'blocked-reconciliation');
    if (input.outcome === 'draft-reported') {
      requireThat(work.state === 'publishing' && input.draftPR &&
        input.draftPR.publicationKey === work.publicationKey &&
        input.draftPR.headRevision === work.proposal.candidateRevision,
      'RSI draft must match the reserved candidate/publication identity', 'blocked-result');
      const url = new URL(input.draftPR.url);
      requireThat(url.origin === 'https://github.com' && !url.username && !url.password && !url.search && !url.hash &&
        url.pathname.startsWith(`/${policy.targetRepository}/pull/`) &&
        /^[1-9][0-9]*$/.test(url.pathname.slice(`/${policy.targetRepository}/pull/`.length)),
      'RSI draft URL is outside the configured repository', 'blocked-scope');
    } else {
      requireThat(!input.draftPR && work.state !== 'publishing',
        'Uncertain publication must be reconciled, not closed or retried', 'blocked-reconciliation');
      requireThat(!work.proposal || input.outcome === 'blocked',
        'A proposed change cannot be relabelled no-change', 'blocked-reconciliation');
    }
    return save(ledger, work, { state: 'finished', result: input }, admit);
  });
}

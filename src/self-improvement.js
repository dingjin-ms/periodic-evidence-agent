import {
  existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, realpathSync, writeFileSync
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, json, now, requireThat, uuid, validateRecord } from './common.js';
import { Ledger } from './ledger.js';
import { assertStateDirectoryIgnored, persistRunArtifact } from './state-retention.js';

export const selfImprovementRoot = fileURLToPath(new URL('..', import.meta.url));
export const selfImprovementFixture = join(selfImprovementRoot, 'test', 'fixtures', 'self-improvement');
export const metricContract = 'recovery-core-metrics-v1';
const markerName = '.rsi-root.json';
const observationKind = 'selfImprovementObservation';
const experimentKind = 'selfImprovementExperiment';
const bootstrapId = 'rsi-store';
const tables = ['records', 'captures', 'observations', 'cursors', 'source_blocks',
  'unblock_events', 'qualifications', 'assignment_budgets', 'discoveries',
  'tracked_state', 'runs', 'locks', 'jobs', 'operations', 'workspace_cleanup', 'transport_cleanup'];
const ledgerSourceSha256 = () => hash(readFileSync(new URL('./ledger.js', import.meta.url)));
const policyHash = policy => hash(json(policy));
const experimentId = (store, observation, identity) =>
  `rsi-experiment-${hash(json([{
    observationId: observation.observationId, observationVersion: observation.observationVersion
  }, identity, policyHash(store.policy), store.marker.storeId]))}`;

export function selfImprovementWorkload() {
  return JSON.parse(readFileSync(join(selfImprovementFixture, 'workload.json'), 'utf8'));
}

function samePath(left, right) {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function inspectRsiPath(root, path, { missing = false, directory = false } = {}) {
  const target = resolve(path), base = resolve(root), rel = relative(base, target);
  requireThat(rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel),
  'RSI path escapes its allocated root', 'blocked-rsi-root');
  let current = base, canonical = null;
  for (const part of ['', ...rel.split(sep).filter(Boolean)]) {
    if (part) current = join(current, part);
    const info = lstatSync(current, { throwIfNoEntry: false });
    if (!info) {
      requireThat(missing, 'RSI path is unavailable', 'blocked-rsi-root');
      continue;
    }
    requireThat(!info.isSymbolicLink() &&
      (info.isDirectory() || (info.isFile() && info.nlink === 1)),
    'RSI linked or unsupported path refused', 'blocked-rsi-root');
    canonical = current;
  }
  // The deepest existing component's canonical path includes every inspected ancestor.
  if (canonical) requireThat(samePath(realpathSync.native(canonical), canonical),
    'RSI canonical path alias refused', 'blocked-rsi-root');
  if (directory && existsSync(target))
    requireThat(lstatSync(target).isDirectory(), 'RSI directory required', 'blocked-rsi-root');
  return target;
}

function policyRoot(policy, checkoutRoot = selfImprovementRoot) {
  validateRecord(policy, 'selfImprovementPolicy');
  const checkout = realpathSync.native(checkoutRoot);
  const root = resolve(checkout, policy.stateDirectory);
  requireThat(samePath(dirname(root), join(checkout, '.state', 'rsi')) &&
    /^[a-z0-9][a-z0-9-]{0,79}$/.test(basename(root)) &&
    policy.stateDirectory.replaceAll('\\', '/') === `.state/rsi/${basename(root)}`,
  'RSI requires an explicit named child of this checkout .state/rsi', 'blocked-rsi-root');
  inspectRsiPath(checkout, root, { missing: true, directory: true });
  return root;
}

function readMarker(root) {
  const path = inspectRsiPath(root, join(root, markerName));
  const marker = JSON.parse(readFileSync(path, 'utf8'));
  requireThat(json(Object.keys(marker).sort()) ===
    json(['format', 'root', 'storeId'].sort()) &&
    marker.format === 'self-improvement-root-v1' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(marker.storeId) &&
    samePath(marker.root, root),
  'RSI root marker identity mismatch', 'blocked-rsi-root');
  return marker;
}

function schemaHash(ledger) {
  return hash(json(ledger.db.prepare(
    "SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"
  ).all()));
}

function inspectNamespace(ledger, { empty = false } = {}) {
  const actual = ledger.db.prepare(
    "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map(row => row.name);
  requireThat(json(actual) === json([...tables].sort()) &&
    ledger.db.prepare('PRAGMA table_info(observations)').all().some(row => row.name === 'context'),
  'Unrecognized RSI ledger schema; automatic migration is prohibited', 'blocked-rsi-root');
  for (const table of tables) {
    if (!empty && ['records', 'operations', 'locks'].includes(table)) continue;
    requireThat(ledger.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n === 0,
      'Populated fixture/product or incomplete foreign store refused', 'blocked-rsi-root');
  }
  if (!empty) {
    requireThat(!ledger.db.prepare(
      'SELECT 1 FROM records WHERE kind NOT IN (?,?) LIMIT 1'
    ).get(observationKind, experimentKind) &&
      !ledger.db.prepare("SELECT 1 FROM operations WHERE kind NOT IN ('rsi-store','rsi-evaluation') LIMIT 1").get() &&
      !ledger.db.prepare("SELECT 1 FROM locks WHERE name != 'rsi-owner' LIMIT 1").get(),
    'Mixed RSI/controller namespaces refused', 'blocked-rsi-root');
    for (const kind of [observationKind, experimentKind])
      for (const record of ledger.all(kind)) validateRecord(record);
  }
}

function inspectDatabaseFile(root) {
  const path = inspectRsiPath(root, join(root, 'ledger.sqlite'));
  const bytes = readFileSync(path);
  requireThat(bytes.subarray(0, 16).toString() === 'SQLite format 3\0' &&
    bytes[18] === 1 && bytes[19] === 1,
  'RSI requires its checkpointed rollback-journal database; foreign or interrupted WAL stores are not opened',
  'blocked-rsi-root');
}

function inspectStore(root, policy, marker) {
  for (const name of ['ledger.sqlite', 'ledger.sqlite-wal', 'ledger.sqlite-shm', 'ledger.sqlite-journal'])
    inspectRsiPath(root, join(root, name), { missing: name !== 'ledger.sqlite' });
  requireThat(!['ledger.sqlite-wal', 'ledger.sqlite-shm', 'ledger.sqlite-journal']
    .some(name => existsSync(join(root, name))),
  'RSI database sidecars require explicit reconciliation, not automatic recovery', 'blocked-rsi-root');
  inspectDatabaseFile(root);
  const ledger = new Ledger(root, { readOnly: true });
  try {
    inspectNamespace(ledger);
    const row = ledger.db.prepare('SELECT * FROM operations WHERE id=?').get(bootstrapId);
    const detail = row && JSON.parse(row.detail);
    requireThat(row?.kind === 'rsi-store' && row.state === 'initialized' &&
      detail.storeId === marker.storeId && detail.markerSha256 === hash(json(marker)) &&
      detail.ledgerSourceSha256 === ledgerSourceSha256() &&
      detail.schemaSha256 === schemaHash(ledger) && detail.policySha256 === policyHash(policy),
    'RSI bootstrap/schema/policy identity differs; no writable open permitted', 'blocked-rsi-root');
  } finally { ledger.close(); }
}

export function initializeSelfImprovement(policy, {
  checkoutRoot = selfImprovementRoot, resume = false, expectedStoreId = null, afterMarker = null
} = {}) {
  const root = policyRoot(policy, checkoutRoot);
  let marker;
  if (existsSync(join(root, markerName))) {
    requireThat(resume && expectedStoreId, 'RSI root already exists; explicit initialization resume required',
      'blocked-reconciliation');
    marker = readMarker(root);
    requireThat(marker.storeId === expectedStoreId, 'RSI initialization store ID changed',
      'blocked-reconciliation');
    requireThat(readdirSync(root).every(name =>
      [markerName, 'ledger.sqlite', 'ledger.sqlite-wal', 'ledger.sqlite-shm'].includes(name)),
    'Initialization resume refuses unknown files', 'blocked-rsi-root');
    if (existsSync(join(root, 'ledger.sqlite'))) {
      for (const name of readdirSync(root)) inspectRsiPath(root, join(root, name));
      requireThat(!['ledger.sqlite-wal', 'ledger.sqlite-shm']
        .some(name => existsSync(join(root, name))),
      'RSI database sidecars require explicit reconciliation, not automatic recovery', 'blocked-rsi-root');
      inspectDatabaseFile(root);
      const existing = new Ledger(root, { readOnly: true });
      try {
        if (existing.db.prepare('SELECT 1 FROM operations WHERE id=?').get(bootstrapId)) {
          inspectStore(root, policy, marker);
          return { state: 'initialized', storeId: marker.storeId, root };
        }
        inspectNamespace(existing, { empty: true });
      } finally { existing.close(); }
    }
  } else {
    requireThat(!resume && (!existsSync(root) || readdirSync(root).length === 0),
      'RSI init accepts only a new or empty directory', 'blocked-rsi-root');
    requireThat(assertStateDirectoryIgnored({ stateDirectory: root }, checkoutRoot).checked,
      'RSI state must belong to an ignored directory in a Git checkout', 'blocked-rsi-root');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    marker = { format: 'self-improvement-root-v1', storeId: uuid(), root };
    writeFileSync(join(root, markerName), json(marker), { flag: 'wx', mode: 0o600 });
    afterMarker?.();
  }
  const ledger = new Ledger(root);
  try {
    ledger.db.exec('PRAGMA journal_mode=DELETE');
    inspectNamespace(ledger, { empty: true });
    ledger.transaction(() => {
      const detail = { storeId: marker.storeId, markerSha256: hash(json(marker)),
        ledgerSourceSha256: ledgerSourceSha256(), schemaSha256: schemaHash(ledger),
        policySha256: policyHash(policy) };
      ledger.operation(bootstrapId, bootstrapId, 'rsi-store', detail);
      ledger.finishOperation(bootstrapId, 'initialized', detail);
    });
  } finally { ledger.close(); }
  return { state: 'initialized', storeId: marker.storeId, root };
}

export function openSelfImprovementStore(policy, {
  checkoutRoot = selfImprovementRoot, readOnly = false
} = {}) {
  const root = policyRoot(policy, checkoutRoot);
  const marker = readMarker(root);
  inspectStore(root, policy, marker);
  requireThat(json(readMarker(root)) === json(marker), 'RSI root changed during admission',
    'blocked-rsi-root');
  const ledger = new Ledger(root, { readOnly });
  if (!readOnly) ledger.db.exec('PRAGMA journal_mode=DELETE');
  const fixedPolicy = structuredClone(policy);
  Object.freeze(fixedPolicy.limits);
  Object.freeze(fixedPolicy);
  return Object.freeze({ root, marker: Object.freeze(marker), policy: fixedPolicy, ledger,
    readOnly, close() { this.ledger.close(); } });
}

function writable(store) {
  requireThat(!store.readOnly, 'RSI operation requires an explicitly writable store',
    'blocked-reconciliation');
}

export function selfImprovementIdentity() {
  const files = [];
  function add(path, label) {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) {
      const dependencyRoot = realpathSync(join(selfImprovementRoot, 'node_modules'));
      const target = realpathSync(path), rel = relative(dependencyRoot, target);
      requireThat(/(?:^|\/)node_modules\/\.bin\/[^/]+$/.test(label) &&
        rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) && lstatSync(target).isFile(),
      'Only internal npm executable launchers may be dependency links', 'blocked-reconciliation');
      files.push({ path: label, link: readlinkSync(path), sha256: hash(readFileSync(target)) });
      return;
    }
    if (info.isDirectory()) {
      for (const name of readdirSync(path).sort()) add(join(path, name), `${label}/${name}`);
    } else {
      requireThat(info.isFile(), 'Unsupported source/dependency input', 'blocked-reconciliation');
      files.push({ path: label, sha256: hash(readFileSync(path)) });
    }
  }
  for (const path of ['src', 'scaffold/contracts.schema.json', 'pilot.example.json',
    'package.json', 'package-lock.json', 'test/fixtures/self-improvement'])
    add(resolve(selfImprovementRoot, path), path);
  const sourceSha256 = hash(json(files));
  files.length = 0;
  requireThat(existsSync(join(selfImprovementRoot, 'node_modules')),
    'Locked dependencies are unavailable; restore them outside evaluation', 'blocked-config');
  add(join(selfImprovementRoot, 'node_modules'), 'node_modules');
  const git = args => execFileSync('git', ['--no-pager', '--no-optional-locks', ...args], {
    cwd: selfImprovementRoot, encoding: 'utf8', windowsHide: true, timeout: 10000,
    maxBuffer: 4 * 1024 * 1024
  }).trim();
  return validateRecord({
    revision: git(['rev-parse', 'HEAD']), sourceSha256,
    evaluatorSha256: hash(json(['self-improvement.js', 'self-improvement-evaluation.js', 'self-improvement-cli.js'].map(name =>
      ({ path: name, sha256: hash(readFileSync(join(selfImprovementRoot, 'src', name))) })))),
    driverSha256: hash(readFileSync(new URL('./self-improvement-candidate-runner.js', import.meta.url))),
    nativeTestSha256: hash(readFileSync(join(selfImprovementFixture, 'native-case.txt'))),
    dependenciesSha256: hash(json(files)),
    workloadSha256: hash(readFileSync(join(selfImprovementFixture, 'workload.json'))),
    nodeSha256: hash(readFileSync(process.execPath)), nodeVersion: process.version,
    gitVersion: git(['--version']), platform: process.platform,
    workingTreeModified: Boolean(git(['status', '--porcelain', '--untracked-files=normal']))
  }, 'selfImprovementIdentity');
}

export function recordSelfImprovementObservation(store, input) {
  writable(store);
  const bundle = selfImprovementWorkload();
  requireThat(json(input) === json(bundle),
    'Only the pinned synthetic recovery scenario is admitted; private/live import is unavailable',
    'blocked-scope');
  const digest = hash(readFileSync(join(selfImprovementFixture, 'workload.json')));
  const id = `rsi-observation-${digest}`;
  return store.ledger.transaction(() => store.ledger.get(observationKind, id) ??
    store.ledger.put({
      recordType: observationKind, schemaVersion: '1.0', id, version: 1,
      provenance: 'synthetic', evidenceKind: 'scenario-definition-not-live-observation',
      adapter: bundle.adapter, family: bundle.family, workloadSha256: digest,
      bundle, createdAt: now()
    }));
}

export function prepareSelfImprovementExperiment(store, input) {
  writable(store);
  requireThat(json(Object.keys(input).sort()) === json(['observationId', 'observationVersion']),
    'Prepare requires an exact observation ID/version', 'invalid-record');
  const observation = store.ledger.get(observationKind, input.observationId, input.observationVersion);
  requireThat(observation && json(observation.bundle) === json(selfImprovementWorkload()),
    'Missing or changed synthetic observation', 'blocked-reconciliation');
  const identity = selfImprovementIdentity();
  requireThat(identity.workloadSha256 === observation.workloadSha256,
    'Observed workload bytes changed', 'blocked-reconciliation');
  const id = experimentId(store, input, identity);
  return store.ledger.transaction(() => {
    const existing = store.ledger.get(experimentKind, id);
    if (existing) {
      requireThat(json(existing.identity) === json(identity) &&
        existing.policySha256 === policyHash(store.policy) &&
        existing.observationId === observation.id && existing.observationVersion === observation.version,
      'Persisted preparation pins differ from their immutable identity', 'blocked-reconciliation');
      return existing;
    }
    const experiments = store.ledger.latest(experimentKind);
    requireThat(!experiments.some(row => ['prepared', 'evaluating'].includes(row.state)),
      'An RSI experiment still owns the active slot; explicit disposition is required', 'overlap');
    requireThat(experiments.filter(row => row.family === observation.family).length <
      store.policy.limits.maxCandidateVersions,
    'RSI family admission budget exhausted; no implicit reset', 'blocked-budget');
    return store.ledger.put({
      recordType: experimentKind, schemaVersion: '1.0', id, version: 1,
      observationId: observation.id, observationVersion: observation.version,
      family: observation.family, purpose: 'current-current-qualification', state: 'prepared',
      policySha256: policyHash(store.policy), identity, metricContract,
      createdAt: now(), updatedAt: now(), reservation: null, result: null, decision: null
    });
  });
}

export function nextSelfImprovementVersion(store, expected, changes) {
  writable(store);
  const current = store.ledger.get(experimentKind, expected.id);
  requireThat(current?.version === expected.version && json(current) === json(expected),
    'RSI experiment version changed', 'blocked-reconciliation');
  requireThat(Object.keys(changes).every(key => ['state', 'reservation', 'result', 'decision'].includes(key)) &&
    ({ prepared: ['evaluating', 'abandoned'], evaluating: ['evaluated', 'abandoned'] })[current.state]
      ?.includes(changes.state),
  'RSI transition cannot reset terminal state or alter frozen inputs', 'blocked-reconciliation');
  return store.ledger.put({ ...current, ...changes, version: current.version + 1, updatedAt: now() });
}

export function reserveSelfImprovementEvaluation(store, id, expectedVersion) {
  writable(store);
  requireThat(store.policy.executionApproved, 'Offline fixture execution requires explicit policy approval',
    'blocked-authorization');
  return store.ledger.transaction(() => {
    const experiment = store.ledger.get(experimentKind, id);
    requireThat(experiment?.state === 'prepared' && experiment.version === expectedVersion &&
      experiment.policySha256 === policyHash(store.policy) &&
      experiment.id === experimentId(store, {
        observationId: experiment.observationId, observationVersion: experiment.observationVersion
      }, experiment.identity),
    'Only the exact never-evaluated prepared experiment may execute', 'blocked-reconciliation');
    const reservation = { operationId: `${id}:evaluation`, runId: id };
    store.ledger.operation(reservation.operationId, id, 'rsi-evaluation', {
      ownerPid: process.pid, ownerCompleted: false, children: [], fixtureRoots: [],
      reservedAt: now(), budgetConsumed: true
    });
    return nextSelfImprovementVersion(store, experiment, { state: 'evaluating', reservation });
  });
}

export function selfImprovementOperation(store, experiment) {
  const row = experiment.reservation && store.ledger.db.prepare(
    'SELECT * FROM operations WHERE id=?'
  ).get(experiment.reservation.operationId);
  requireThat(experiment.reservation?.runId === experiment.id &&
    experiment.reservation.operationId === `${experiment.id}:evaluation` &&
    row?.kind === 'rsi-evaluation' && row.job_id === experiment.id,
    'Missing RSI evaluation reservation', 'blocked-reconciliation');
  const detail = JSON.parse(row.detail);
  requireThat(detail.budgetConsumed === true && Number.isInteger(detail.ownerPid) &&
    detail.ownerPid > 0 && Array.isArray(detail.children) && Array.isArray(detail.fixtureRoots),
  'Invalid RSI reservation ownership', 'blocked-reconciliation');
  return { ...row, detail };
}

export function updateSelfImprovementOperation(store, experiment, changes) {
  writable(store);
  const operation = selfImprovementOperation(store, experiment);
  requireThat(operation.state === 'started', 'RSI reservation is already terminal',
    'blocked-reconciliation');
  store.ledger.finishOperation(operation.id, operation.state, { ...operation.detail, ...changes });
}

export function rsiDirectoryBytes(root) {
  if (!existsSync(root)) return 0;
  let total = 0;
  function visit(path) {
    inspectRsiPath(root, path);
    const info = lstatSync(path);
    if (info.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
    else total += info.size;
  }
  visit(root);
  return total;
}

export function persistSelfImprovementArtifact(store, experiment, name, value) {
  writable(store);
  const current = store.ledger.get(experimentKind, experiment.id);
  requireThat(experiment.reservation && current?.state === 'evaluating' &&
    current.version === experiment.version && selfImprovementOperation(store, experiment).state === 'started',
  'Only the current reserved evaluation may write RSI evidence', 'blocked-reconciliation');
  requireThat(typeof name === 'string' && /^[a-z0-9][a-z0-9.-]{0,100}\.(json|md)$/.test(name) &&
    name !== 'manifest.json', 'RSI artifacts require a bounded flat filename', 'blocked-scope');
  const content = typeof value === 'string' ? value : json(value);
  const bytes = Buffer.byteLength(content);
  const runs = join(store.root, 'runs');
  const manifestPath = inspectRsiPath(store.root,
    join(runs, experiment.reservation.runId, 'manifest.json'), { missing: true });
  const oldManifest = existsSync(manifestPath) ? readFileSync(manifestPath) : null;
  const manifest = oldManifest ? JSON.parse(oldManifest) : {
    schemaVersion: 1, runId: experiment.reservation.runId, state: 'active',
    createdAt: now(), completedAt: null, artifacts: []
  };
  let growth = 0;
  if (!manifest.artifacts.some(entry => entry.path === name)) {
    manifest.artifacts.push({ path: name, bytes, sha256: hash(content), createdAt: now() });
    growth = bytes + Buffer.byteLength(`${JSON.stringify(manifest, null, 2)}\n`) - (oldManifest?.length ?? 0);
  }
  // Reserve the exact maximum manifest growth when active becomes completed.
  requireThat(rsiDirectoryBytes(runs) + growth + 25 <= store.policy.limits.maxArtifactBytes,
    'RSI artifact storage ceiling reached', 'blocked-budget');
  return persistRunArtifact({ stateDirectory: store.root }, experiment.reservation.runId, name, content);
}

function processPresent(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

export async function recordSelfImprovementDecision(store, input) {
  writable(store);
  requireThat(json(Object.keys(input).sort()) ===
    json(['action', 'expectedVersion', 'experimentId', 'operatorConfirmedStopped', 'reason', 'storeId'].sort()) &&
    ['adopt-sealed-completion', 'abandon'].includes(input.action) &&
    input.storeId === store.marker.storeId && input.operatorConfirmedStopped === true &&
    typeof input.reason === 'string' && input.reason.trim().length >= 10,
  'Only an explicit exact-store adopt/abandon disposition is supported; no promotion',
  'blocked-authorization');
  const experiment = store.ledger.get(experimentKind, input.experimentId);
  requireThat(experiment?.version === input.expectedVersion &&
    ['prepared', 'evaluating'].includes(experiment.state),
  'RSI disposition version/state differs', 'blocked-reconciliation');
  const operation = experiment.reservation ? selfImprovementOperation(store, experiment) : null;
  if (operation) {
    requireThat(operation.state === 'started' &&
      (operation.detail.ownerCompleted || !processPresent(operation.detail.ownerPid)) &&
      operation.detail.children.every(child => child.exited || !processPresent(child.pid)),
    'Known evaluator/child process remains present; reconcile without stealing ownership',
    'blocked-reconciliation');
  }
  const decision = { action: input.action, reason: input.reason,
    operatorAttested: true, recordedAt: now() };
  if (input.action === 'adopt-sealed-completion') {
    requireThat(operation, 'No reserved evaluation exists to adopt', 'blocked-reconciliation');
    const { finalizeSelfImprovementEvaluation } = await import('./self-improvement-evaluation.js');
    return finalizeSelfImprovementEvaluation(store, experiment, decision);
  }
  return store.ledger.transaction(() => {
    const result = nextSelfImprovementVersion(store, experiment, { state: 'abandoned', decision });
    if (operation) store.ledger.finishOperation(operation.id, 'abandoned', {
      ...operation.detail, decision, budgetConsumed: true
    });
    return result;
  });
}

export async function selfImprovementStatus(policy, options = {}) {
  const root = policyRoot(policy, options.checkoutRoot);
  if (!existsSync(root)) return { state: 'uninitialized', createsState: false };
  const marker = readMarker(root);
  if (!existsSync(join(root, 'ledger.sqlite')))
    return { state: 'initialization-incomplete', storeId: marker.storeId, createsState: false };
  const store = openSelfImprovementStore(policy, { ...options, readOnly: true });
  try {
    const { inspectSelfImprovementEvidence } = await import('./self-improvement-evaluation.js');
    return { state: 'initialized', storeId: marker.storeId, createsState: false,
      stateOwner: policy.stateOwner, automaticCleanup: false, archiveAllowed: false,
      observations: store.ledger.latest(observationKind),
      experiments: store.ledger.latest(experimentKind).map(experiment => ({
        ...experiment, evidence: inspectSelfImprovementEvidence(store, experiment)
      })) };
  } finally { store.close(); }
}

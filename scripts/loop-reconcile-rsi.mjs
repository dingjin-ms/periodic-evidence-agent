// Explicit capture-only recovery using the producer's exact original controller.
// No source read, model call, receipt synthesis or baseline rebinding is permitted.
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hash, json, requireThat } from '../src/common.js';
import { Ledger } from '../src/ledger.js';
import { openApp, appStatus } from '../src/app-native.js';
import { createNativeLoopAdapter, nativeLoopSettings } from '../src/loop-native-adapter.js';
import { normalizeLoopRequest, loopOperation, digest, readLoopArtifact, captureArtifact, roleReceipt } from '../src/loop-controller.js';

const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1];
requireThat(['--request', '--producer-root', '--approval-ref'].every(name => args.includes(name)),
  'Use --request, --producer-root and --approval-ref for explicit original-producer capture recovery');
const { pins, runId } = normalizeLoopRequest(JSON.parse(readFileSync(option('--request'))));
requireThat(pins.rsiMode === 'capture-only', 'This command cannot recover evaluated RSI');
for (const file of pins.configuration) requireThat(hash(readFileSync(file.path)) === file.sha256,
  'Pinned configuration bytes changed; recovery is forbidden');
const adapter = createNativeLoopAdapter(), settings = nativeLoopSettings(pins, runId);
requireThat(Object.values(pins.adapters).every(binding => digest(binding) === digest(adapter.binding)),
  'Recovery must use the exact admitted controller adapter');
const ledger = new Ledger(pins.stateOwner.directory);
const lock = 'evidence-loop:' + runId, owner = ledger.acquire(lock);
let release, source;
try {
  await adapter.preflight({ pins, runId });
  release = await adapter.acquireRun({ pins, runId }, ledger);
  const operationId = runId + ':rsi', operation = loopOperation(ledger, operationId);
  requireThat(operation?.detail.request && !operation.detail.receipt,
    'An original uncompleted RSI intent is required; completed receipts are never replaced');
  const role = operation.detail.request;
  requireThat(role.runId === runId && role.stage === 'rsi' && digest(role.pins) === digest(pins) && role.upstream.length === 3,
    'RSI intent does not match the admitted request');
  for (const receipt of role.upstream) {
    const original = loopOperation(ledger, receipt.operationId);
    requireThat(original?.detail.receipt && digest(original.detail.receipt) === digest(receipt) &&
      receipt.requestSha256 === digest(original.detail.request), 'Upstream receipt changed');
    receipt.artifacts.forEach(artifact => readLoopArtifact(ledger, artifact));
    if (original.detail.request.stage !== 'proposer' || receipt.outcome === 'proposed')
      await adapter.verify(original.detail.request, receipt, ledger);
  }
  ({ ledger: source } = openApp(settings.collector, settings.collectionRunId, true));
  const binding = source.all('rsiFlowBinding').find(row => row.origin === 'app-flow' && row.flowId === settings.collectionRunId);
  requireThat(binding && binding.configSha256 === hash(json(settings.collector)), 'Original producer binding is missing or changed');
  const root = option('--producer-root'), files = [];
  function add(name) {
    const path = join(root, name), stat = lstatSync(path);
    requireThat(!stat.isSymbolicLink(), 'Linked producer inputs are forbidden');
    if (stat.isDirectory()) for (const child of readdirSync(path).sort()) add(name + '/' + child);
    else {
      requireThat(stat.isFile() && stat.nlink === 1, 'Producer inputs must be regular unlinked files');
      files.push({ path: name, sha256: hash(readFileSync(path)) });
    }
  }
  for (const name of ['src', '.github/skills', 'scaffold/contracts.schema.json',
    'scaffold/coordinator.instructions.md', 'APP-NATIVE.md', 'package.json', 'package-lock.json']) add(name);
  requireThat(hash(json(files)) === binding.controller.sourceSha256 && process.version === binding.controller.nodeVersion,
    'Original producer code or Node version does not match its pre-execution binding');
  // Import only after the complete executable source fingerprint has matched.
  const producer = await import(pathToFileURL(join(root, 'src/rsi-flow.js')).href);
  requireThat(json(producer.pinRsiController()) === json(binding.controller), 'Original RSI identity differs');
  const reconciliation = { approvalRef: option('--approval-ref'), originalController: binding.controller,
    requestSha256: digest(role), newSourceReads: 0, newModelCalls: 0 };
  const auditId = runId + ':rsi-capture-reconciliation';
  const prior = loopOperation(ledger, auditId);
  requireThat(!prior || digest(prior.detail) === digest(reconciliation), 'RSI recovery authorization changed');
  if (!prior) ledger.operation(auditId, runId, 'loop-rsi-reconciliation', reconciliation);
  const summary = { ...appStatus(source, settings.collectionRunId), loop: {
    runId, receipts: role.upstream,
    results: role.upstream.map(receipt => JSON.parse(readLoopArtifact(ledger, receipt.artifacts[0])))
  } };
  producer.captureAppRsiOutcome(settings.collector, source, settings.collectionRunId, summary);
  const status = producer.rsiWork(settings.collector, source, 'status', {}, { runId: settings.collectionRunId });
  requireThat(status.observations.length > 0, 'Original producer did not create an observation');
  const value = { collector: status.observations, upstream: role.upstream,
    scope: 'connected loop observation captured by the exact original producer; manual analysis pending', reconciliation };
  const receipt = roleReceipt(role, 'captured', [captureArtifact(ledger, value)], status.observations.map(row => row.id));
  await adapter.verify(role, receipt, ledger);
  ledger.finishOperation(operationId, 'recorded', { request: role, receipt });
  console.log(JSON.stringify({ state: 'captured', runId, originalProducerVerified: true,
    observations: status.observations.length, newSourceReads: 0, newModelCalls: 0 }));
} finally {
  source?.close();
  try { release?.(); } finally { ledger.release(lock, owner); ledger.close(); }
}

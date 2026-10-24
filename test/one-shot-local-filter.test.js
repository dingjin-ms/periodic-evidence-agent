import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setup } from '../scripts/test-support/one-shot-fixture.mjs';
import { prepareOneShotFilterBudget, executeOneShotLocalFilter, advanceOneShotHandoff } from '../src/one-shot-handoff.js';
import { prepareLoopLocalFilter } from '../src/loop-local-filter.js';
import { captureArtifact } from '../src/loop-controller.js';
import { readOneShotCollectionReceipt } from '../src/one-shot-collection.js';

function connection(s, count, { fail = false } = {}) {
  return async (_config, _directory, action) => {
    count.value++;
    if (fail) throw new Error('Synthetic provider failure');
    return action({ createSession: async options => {
      let listener;
      assert.deepEqual(options.tools.map(tool => tool.name), ['pilot_filter_source', 'pilot_filter_finish']);
      assert.equal(options.onPermissionRequest().kind, 'denied-by-rules');
      return { sessionId: 'synthetic-local-session',
        on: callback => { listener = callback; return () => {}; },
        rpc: { tools: { initializeAndValidate: async () => {} }, options: { update: async () => {} } },
        sendAndWait: async () => {
          listener({ id: 'synthetic-event', type: 'assistant.turn_start' });
          const result = JSON.parse(await options.tools.find(tool => tool.name === 'pilot_filter_finish').handler({ result: s.result }));
          assert.equal(result.state, 'held', JSON.stringify(result));
        }, disconnect: async () => {} };
    } });
  };
}

test('fresh collection flows through the actual restricted SDK helper and accepted no-candidate gate', async t => {
  const s = await setup(t, { local: true }), calls = { value: 0 };
  await executeOneShotLocalFilter(s.config, s.execution, s.input, { connect: connection(s, calls) });
  const result = await advanceOneShotHandoff(s.config, s.ledger, s.input, { execute: true });
  assert.equal(result.state, 'complete-no-candidate', JSON.stringify(result.blocker));
  assert.equal(result.accepted.cohort.executor, 'local-sdk');
  assert.equal(result.accepted.sourceCoverageComplete, true);
  await executeOneShotLocalFilter(s.config, s.execution, s.input, { connect: connection(s, calls) });
  assert.equal(calls.value, 1);
  assert.deepEqual(await advanceOneShotHandoff(s.config, s.ledger, s.input), result);
});

test('result JSON alone cannot bypass local execution evidence', async t => {
  const s = await setup(t, { local: true });
  prepareOneShotFilterBudget(s.config, s.execution, s.input);
  writeFileSync(s.resultPath, JSON.stringify(s.result, null, 2) + '\n');
  assert.equal((await advanceOneShotHandoff(s.config, s.ledger, s.input)).state, 'blocked');
});

test('completed model work is recovered after output-write failure without another session', async t => {
  const s = await setup(t, { local: true }), calls = { value: 0 };
  s.input.filter.resultPaths = [join(dirname(s.resultPath), 'missing', 'result.json')];
  await assert.rejects(executeOneShotLocalFilter(s.config, s.execution, s.input, { connect: connection(s, calls) }));
  mkdirSync(dirname(s.input.filter.resultPaths[0]));
  await executeOneShotLocalFilter(s.config, s.execution, s.input, { connect: connection(s, calls) });
  assert.equal(calls.value, 1);
  assert.equal((await advanceOneShotHandoff(s.config, s.ledger, s.input)).state, 'complete-no-candidate');
});

test('failed or uncertain local model execution never automatically retries', async t => {
  const s = await setup(t, { local: true }), calls = { value: 0 };
  const run = () => executeOneShotLocalFilter(s.config, s.execution, s.input, { connect: connection(s, calls, { fail: true }) });
  await assert.rejects(run(), /blocked or uncertain/);
  await assert.rejects(run(), /blocked or uncertain/);
  assert.equal(calls.value, 1);
});

for (const change of ['credits', 'soft', 'aggregate']) test('local FILTER preflight preserves explicit ' + change + ' budget approval', async t => {
  const s = await setup(t, { local: true }), calls = { value: 0 };
  if (change === 'credits') s.config.limits.maxAiCreditsPerSession = 1;
  if (change === 'soft') s.config.localFilter.acceptSoftCreditLimit = false;
  if (change === 'aggregate') s.input.authorization.maxFilterAiCredits = 1;
  await assert.rejects(executeOneShotLocalFilter(s.config, s.execution, s.input, { connect: connection(s, calls) }),
    { code: change === 'aggregate' ? 'blocked-budget' : 'action-required-budget' });
  assert.equal(calls.value, 0);
  assert.equal(s.execution.db.prepare("SELECT COUNT(*) n FROM operations WHERE kind='one-shot-local-filter'").get().n, 0);
});

test('controller prepares exact whole-corpus local handoff automatically', async t => {
  const s = await setup(t, { local: true });
  const settings = { root: dirname(s.resultPath), collector: s.collectionConfig, proposer: s.config,
    collectionReceiptSha256: s.input.collection.receiptSha256,
    bundle: { localFilterPlan: { instructions: s.manifest.request.instructions,
      groupingReview: s.manifest.request.groupingReview,
      sharing: { audience: 'synthetic-only', approvalRef: 'synthetic-only' },
      routing: s.input.routing, authorization: s.input.authorization } } };
  const request = { runId: 'fresh', pins: { stateOwner: { id: 'test' } }, upstream: [{ artifacts: [captureArtifact(s.ledger,
    readOneShotCollectionReceipt(s.collectionConfig, s.collector, 'fresh'))] }] };
  await prepareLoopLocalFilter(settings, request, s.ledger,
    async (_config, input) => ({ sha256: input.sha256, model: input.model, tokenizer: input.tokenizer, tokens: 5 }));
  const input = JSON.parse(readFileSync(join(settings.root, 'handoff.json')));
  const manifest = JSON.parse(readFileSync(input.filter.manifestPath));
  assert.equal(manifest.batches.length, 1);
  s.result = { ...s.result, cohortId: manifest.cohortId, batchId: manifest.batches[0].id,
    payloadSha256: manifest.batches[0].analysisPayloadSha256,
    titles: { ...s.result.titles, indexSha256: manifest.batches[0].indexSha256 } };
  await executeOneShotLocalFilter(s.config, s.execution, input, { connect: connection(s, { value: 0 }) });
  assert.equal((await advanceOneShotHandoff(s.config, s.ledger, input)).state, 'complete-no-candidate');
});

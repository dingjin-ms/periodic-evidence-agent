import { readFileSync, writeFileSync, openSync, closeSync, fsyncSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { command, prepareValidation } from './workers.js';
import { json } from './common.js';

const root = process.argv[2];
const requestPath = join(root, 'request.json');
const request = JSON.parse(readFileSync(requestPath, 'utf8'));
unlinkSync(requestPath);
const descriptor = openSync(join(root, 'progress.jsonl'), 'wx', 0o600);
let sequence = 0;
const started = performance.now();
function record(event) {
  writeFileSync(descriptor, json({
    sequence: ++sequence, processId: process.pid,
    elapsedMs: performance.now() - started, ...event
  }) + '\n');
  fsyncSync(descriptor);
}
try {
  record({ kind: 'start' });
  const { config, job, repo, revision } = request;
  const workspace = join(root, 'data', 'source');
  record({ kind: 'stage', gateId: repo.validationGates[0].id,
    id: 0, stage: 'source-materialization', phase: 'start' });
  await command('git', ['-c', 'core.hooksPath=.git/no-hooks',
    'clone', '--no-hardlinks', '--no-checkout', '--', job.workspace, workspace],
  join(root, 'data'), request.wholeTimeoutMs);
  await command('git', ['-c', 'core.hooksPath=.git/no-hooks', '-c', 'core.autocrlf=false',
    'checkout', '--detach', revision], workspace, request.wholeTimeoutMs);
  record({ kind: 'stage', gateId: repo.validationGates[0].id,
    id: 0, stage: 'source-materialization', phase: 'finish' });
  const prepared = await prepareValidation(
    { ...config, stateDirectory: join(root, 'data', 'state') },
    { ...job, workspace }, repo, revision, undefined, {
      onProgress: event => record({ kind: 'stage', ...event })
    });
  const gates = Object.entries(prepared).map(([gateId, value]) => {
    if (value?.error) return {
      gateId, accepted: false, error: value.error,
      status: value.failure.status,
      blockedReason: value.failure.blockedReason,
      secondaryError: value.failure.output.secondaryError ?? null
    };
    if (!value) return { gateId, accepted: false,
      error: { code: 'blocked-preparation-plan', message: 'A staged validation plan is required' } };
    return {
      gateId, accepted: true, receiptPath: value.receiptPath,
      dependencyReceiptPath: value.dependencyReceiptPath,
      integrity: value.integrity, outputsSha256: value.outputs.sha256
    };
  });
  writeFileSync(join(root, 'child-result.json'), json({ gates }), { flag: 'wx', mode: 0o600 });
  record({ kind: 'complete' });
} catch {
  record({ kind: 'infrastructure-failed' });
  process.exitCode = 1;
} finally {
  fsyncSync(descriptor);
  closeSync(descriptor);
}

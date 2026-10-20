import { readFileSync, writeFileSync, openSync, closeSync, fsyncSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { command, prepareValidation } from './workers.js';
import { json } from './common.js';
import { preparationFailureDiagnostic } from './preparation-progress.js';

const root = process.argv[2];
const requestPath = join(root, 'request.json');
const request = JSON.parse(readFileSync(requestPath, 'utf8'));
unlinkSync(requestPath);
const descriptor = openSync(join(root, 'progress.jsonl'), 'wx', 0o600);
let sequence = 0;
const started = performance.now();
let operation = 'controller-start';
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
  for (const [step, args, cwd] of [
    ['clone', ['-c', 'core.hooksPath=.git/no-hooks',
      'clone', '--no-hardlinks', '--no-checkout', '--', job.workspace, workspace], join(root, 'data')],
    ['checkout', ['-c', 'core.hooksPath=.git/no-hooks', '-c', 'core.autocrlf=false',
      'checkout', '--detach', revision], workspace]
  ]) {
    operation = `source-${step}`;
    record({ kind: 'materialization-step', step, phase: 'start' });
    await command('git', args, cwd, request.wholeTimeoutMs);
    record({ kind: 'materialization-step', step, phase: 'finish' });
  }
  record({ kind: 'stage', gateId: repo.validationGates[0].id,
    id: 0, stage: 'source-materialization', phase: 'finish' });
  operation = 'validation-preparation';
  const prepared = await prepareValidation(
    { ...config, stateDirectory: join(root, 'data', 'state') },
    { ...job, workspace }, repo, revision, undefined, {
      onProgress: event => record({ kind: 'stage', ...event })
    });
  operation = 'result-publication';
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
} catch (error) {
  process.exitCode = 1;
  record({ kind: 'infrastructure-failed', operation,
    diagnostic: preparationFailureDiagnostic(error) });
} finally {
  fsyncSync(descriptor);
  closeSync(descriptor);
}

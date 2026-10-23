import { readFileSync } from 'node:fs';
import { Ledger } from './ledger.js';
import { requireThat, safeError } from './common.js';
import { normalizeLoopRequest, runEvidenceLoop, loopOperation, loopStages, digest } from './loop-controller.js';
import { createNativeLoopAdapter } from './loop-native-adapter.js';
import { createMailboxLoopAdapter } from './loop-mailbox-adapter.js';

export async function loopMain(origin, argv = process.argv.slice(2)) {
  const option = name => argv[argv.indexOf(name) + 1];
  requireThat(argv.includes('--request'), 'An explicit --request file is required; no example/live defaults');
  const input = JSON.parse(readFileSync(option('--request'), 'utf8'));
  if (argv.includes('--occurrence')) input.occurrence = option('--occurrence');
  input.origin = origin;
  const { pins, runId } = normalizeLoopRequest(input);
  const native = createNativeLoopAdapter(), mailbox = createMailboxLoopAdapter(native);
  const adapters = Object.fromEntries(loopStages.map(stage => [stage,
    pins.adapters[stage].id === mailbox.binding.id ? mailbox : native]));
  const ledger = new Ledger(pins.stateOwner.directory);
  try {
    if (argv.includes('--drain')) {
      const stage = option('--drain');
      requireThat(loopStages.includes(stage) && adapters[stage] === mailbox, 'Drain requires a bound mailbox role');
      const operation = loopOperation(ledger, runId + ':' + stage);
      requireThat(operation?.detail.request, 'Controller must reserve this role before host execution');
      requireThat(digest(operation.detail.request.pins) === digest(pins),
        'Mailbox invocation changed the original run pins', 'blocked-reconciliation');
      return await mailbox.drain(operation.detail.request, ledger);
    }
    return await runEvidenceLoop(input, ledger, adapters);
  } finally { ledger.close(); }
}

export async function printLoopMain(origin) {
  try {
    const result = await loopMain(origin);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.state === 'blocked') process.exitCode = 2;
  } catch (error) {
    process.stdout.write(JSON.stringify({ state: 'blocked', ...safeError(error) }) + '\n');
    process.exitCode = 2;
  }
}

import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { requireThat, safeError } from './common.js';
import {
  initializeSelfImprovement, openSelfImprovementStore, prepareSelfImprovementExperiment,
  recordSelfImprovementDecision, recordSelfImprovementObservation, selfImprovementStatus,
  selfImprovementWorkload
} from './self-improvement.js';
import {
  evaluateSelfImprovement, inspectSelfImprovementEvidence, renderSelfImprovementComparison
} from './self-improvement-evaluation.js';

const [action, ...args] = process.argv.slice(2);
const allowed = {
  init: ['--policy', '--resume', '--store-id'],
  observe: ['--policy'], prepare: ['--policy', '--file'],
  evaluate: ['--policy', '--file'], decision: ['--policy', '--file'],
  status: ['--policy'], report: ['--policy', '--file']
};
let store;
try {
  requireThat(allowed[action], 'Use self-improvement init|observe|prepare|evaluate|decision|status|report',
    'blocked-scope');
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    requireThat(allowed[action].includes(key) && !(key in options),
      'Unknown, duplicate or inappropriate RSI option; product configs and role dispatch are not accepted',
      'blocked-scope');
    if (key === '--resume') options[key] = true;
    else {
      const value = args[++index];
      requireThat(value && !value.startsWith('--'), 'RSI option value required', 'blocked-scope');
      options[key] = value;
    }
  }
  requireThat(options['--policy'], 'RSI requires an explicit policy file', 'blocked-authorization');
  const read = path => {
    const fullPath = resolve(path);
    const stat = lstatSync(fullPath);
    requireThat(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 65536,
      'RSI input must be a bounded regular JSON file', 'blocked-scope');
    return JSON.parse(readFileSync(fullPath, 'utf8'));
  };
  const policy = read(options['--policy']);
  let result;
  if (action === 'init') {
    requireThat(Boolean(options['--resume']) === Boolean(options['--store-id']),
      'Initialization resume requires its exact --store-id', 'blocked-reconciliation');
    result = initializeSelfImprovement(policy, {
      resume: options['--resume'] ?? false, expectedStoreId: options['--store-id'] ?? null
    });
  } else if (action === 'status') result = await selfImprovementStatus(policy);
  else {
    const input = options['--file'] ? read(options['--file']) : null;
    requireThat(action === 'observe' || input, 'RSI operation requires an explicit --file', 'blocked-scope');
    if (['evaluate', 'report'].includes(action))
      requireThat(JSON.stringify(Object.keys(input).sort()) ===
        JSON.stringify(['expectedVersion', 'experimentId']) &&
        typeof input.experimentId === 'string' && Number.isInteger(input.expectedVersion) && input.expectedVersion > 0,
      'Evaluation/report requires exact experimentId and expectedVersion', 'invalid-record');
    store = openSelfImprovementStore(policy, { readOnly: action === 'report' });
    if (action === 'observe') result = recordSelfImprovementObservation(store, selfImprovementWorkload());
    else if (action === 'prepare') result = prepareSelfImprovementExperiment(store, input);
    else if (action === 'evaluate')
      result = await evaluateSelfImprovement(store, input.experimentId, input.expectedVersion);
    else if (action === 'decision') result = await recordSelfImprovementDecision(store, input);
    else {
      const experiment = store.ledger.get('selfImprovementExperiment', input.experimentId);
      requireThat(experiment?.version === input.expectedVersion && experiment.state === 'evaluated',
        'Report requires the exact finalized experiment version', 'blocked-reconciliation');
      const evidence = inspectSelfImprovementEvidence(store, experiment);
      requireThat(evidence.state === 'verified', 'Report evidence is incomplete, invalid or stale',
        'blocked-reconciliation');
      result = renderSelfImprovementComparison(evidence.comparison);
    }
  }
  if (typeof result === 'string') process.stdout.write(result);
  else console.log(JSON.stringify(result, null, 2));
  if (result?.comparison && result.comparison.qualification !== 'harness-qualified') process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify(safeError(error)));
  process.exitCode = 1;
} finally { store?.close(); }

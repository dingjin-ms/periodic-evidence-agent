// Materialize a reviewable request from an already approved private settings file.
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { configAt, requireThat } from '../src/common.js';
import { fileArtifact, digest, loopStages, normalizeLoopRequest } from '../src/loop-controller.js';
import { nativeBinding } from '../src/loop-native-adapter.js';

const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1];
requireThat(['--settings', '--occurrence', '--output'].every(name => args.includes(name)),
  'Use --settings approved.local.json --occurrence UTC --output request.local.json');
const path = realpathSync(option('--settings')), settings = JSON.parse(readFileSync(path));
const config = configAt(settings.collectorConfig);
const configuration = [path, settings.collectorConfig, settings.proposerConfig].map(fileArtifact);
const binding = nativeBinding();
requireThat(['native', 'mailbox'].includes(settings.adapter), 'Select native or mailbox explicitly');
if (settings.adapter === 'mailbox') binding.id = 'mailbox:' + binding.id;
const request = { format: 'evidence-loop-v1', workflowId: settings.workflowId, origin: 'manual',
  occurrence: option('--occurrence'), timeZone: settings.timeZone, rsiMode: settings.rsiMode,
  stateOwner: settings.stateOwner, configuration, deadlineAt: settings.deadlineAt, budgets: settings.budgets,
  sourcePolicySha256: digest({ identity: config.identity, sources: config.sources, passes: settings.collection.passes }),
  executionPolicySha256: digest({ collector: configuration[1], proposer: configuration[2],
    executeProposer: settings.executeProposer, rsiMode: settings.rsiMode }),
  adapters: Object.fromEntries(loopStages.map(stage => [stage, binding])) };
normalizeLoopRequest(request);
writeFileSync(option('--output'), JSON.stringify(request, null, 2) + '\n', { flag: 'wx', mode: 0o600 });

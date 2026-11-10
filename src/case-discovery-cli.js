import { readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundedPath, configAt, requireThat } from './common.js';
import { Ledger } from './ledger.js';
import { assertStateDirectoryIgnored } from './state-retention.js';
import { beginCaseDiscovery, captureDiscoveryReceipt, discoveryContext, finalizeDiscovery, reserveDiscoveryTask } from './case-discovery.js';
import { applyDiscoveryConfig } from './case-discovery-config.js';

export async function runCaseDiscoveryCommand(action, args, dependencies = {}) {
  const definitions = {
    'case-discover-start': [['--config', '--file'], ['--authorize-discovery', '--refresh']],
    'case-discover-context': [['--config', '--run'], []],
    'case-discover-reserve': [['--config', '--run', '--file'], ['--authorize-discovery']],
    'case-discover-capture': [['--config', '--run', '--file'], ['--authorize-discovery']],
    'case-discover-finalize': [['--config', '--run', '--file'], ['--authorize-discovery']],
    'case-discover-apply': [['--config', '--run'], ['--authorize-config-update']]
  };
  requireThat(definitions[action], 'Unknown discovery command', 'blocked-scope');
  const [values, switches] = definitions[action], parsed = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    requireThat([...values, ...switches].includes(key) && !Object.hasOwn(parsed, key),
      'Unknown or duplicate discovery option', 'blocked-scope');
    if (values.includes(key)) requireThat(args[index + 1] && !args[index + 1].startsWith('--'),
      'Discovery option requires a value', 'invalid-record');
    parsed[key] = values.includes(key) ? args[++index] : true;
  }
  requireThat(values.filter(key => key !== '--config').every(key => parsed[key]) &&
    switches.filter(key => key !== '--refresh').every(key => parsed[key]),
  'Discovery commands require their inputs and explicit stage authorization', 'blocked-authorization');
  const root = resolve(dependencies.projectRoot ?? fileURLToPath(new URL('..', import.meta.url)));
  const config = configAt(resolve(parsed['--config'] ?? join(root, 'pilot.local.json')));
  requireThat(config.statePolicy.accessApproved === true, 'Approve private discovery storage first', 'blocked-authorization');
  const base = { ...config, stateDirectory: join(config.stateDirectory, 'case-generation') };
  assertStateDirectoryIgnored(base);
  const ledger = new Ledger(join(base.stateDirectory, 'discovery'));
  try {
    const input = () => {
      const path = boundedPath(config.stateDirectory, relative(config.stateDirectory, resolve(parsed['--file'])));
      requireThat(statSync(path).isFile() && statSync(path).size <= 1048576,
        'Discovery input must be a bounded private JSON file', 'blocked-budget');
      return JSON.parse(readFileSync(path, 'utf8'));
    };
    if (action === 'case-discover-start') return beginCaseDiscovery(base, ledger, input(),
      { authorizeDiscovery: true, refresh: parsed['--refresh'] === true }, { projectRoot: root });
    if (action === 'case-discover-context') return discoveryContext(base, ledger, parsed['--run']);
    if (action === 'case-discover-reserve') return reserveDiscoveryTask(base, ledger, parsed['--run'], input(), true);
    if (action === 'case-discover-capture') return captureDiscoveryReceipt(base, ledger, parsed['--run'], input(), true);
    if (action === 'case-discover-finalize') return finalizeDiscovery(base, ledger, parsed['--run'], input(), true);
    return await applyDiscoveryConfig(base, ledger, parsed['--run'], { authorizeConfigUpdate: true });
  } finally { ledger.close(); }
}

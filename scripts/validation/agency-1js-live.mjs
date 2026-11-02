import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { Ledger } from '../../src/ledger.js';
import { oneJsLiveRequest, runOneJsLiveController } from '../../src/agency-1js-live.js';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const configPath = args.get('--config');
if (!configPath) throw new Error('--config is required');
const config = JSON.parse(readFileSync(resolve(configPath), 'utf8'));
const ledger = new Ledger(config.stateDirectory);
try {
  const result = await runOneJsLiveController(config, ledger, oneJsLiveRequest(),
    { resume: args.get('--resume') === 'true' });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  ledger.close();
}

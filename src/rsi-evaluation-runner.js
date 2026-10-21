import { readFileSync, lstatSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { hash, json, requireThat, validateRecord } from './common.js';

const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
function verifyDriver() {
  for (const file of [{ path: input.profile.driverPath, sha256: input.profile.driverSha256 },
    ...input.profile.dependencies]) {
    const info = lstatSync(file.path);
    requireThat(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 &&
      hash(readFileSync(file.path)) === file.sha256, 'RSI evaluation driver changed', 'blocked-reconciliation');
  }
}
verifyDriver();
requireThat(hash(json(input.observation)) === input.observationSha256,
  'RSI evaluation input changed', 'blocked-reconciliation');
const driver = await import(pathToFileURL(input.profile.driverPath).href);
requireThat(typeof driver.runFlow === 'function', 'RSI driver must export runFlow', 'blocked-validation');
const result = validateRecord(await driver.runFlow({
  workspace: input.workspace, revision: input.revision, observation: input.observation,
  cases: input.profile.cases, directory: input.directory
}), 'rsiDriverResult');
verifyDriver();
process.stdout.write(json({
  format: 'rsi-e2e-observation-v1', revision: input.revision,
  observationSha256: input.observationSha256, profileSha256: hash(json(input.profile)), result
}));

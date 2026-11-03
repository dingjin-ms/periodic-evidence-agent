import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { runAlNative } from '../src/al-adapter.js';
import { pinnedInput, runAlWorkflow } from '../src/al-workflow.js';
import { discoverAlCapabilities } from '../src/al-capabilities.js';
import { runAlRecurring } from '../src/al-recurring.js';
import { configAt, requireThat } from '../src/common.js';

const [operation, requestPath, ...extra] = process.argv.slice(2);
if (!['qualify', 'replay', 'collect', 'batch', 'filter', 'reconcile', 'prepare', 'propose', 'continue',
  'capabilities', 'cycle'].includes(operation) ||
    !requestPath || extra.length)
  throw Error('Usage: node scripts\\augloop.mjs qualify|replay|collect|batch|filter|reconcile|prepare|propose|continue|capabilities|cycle <private-request.json>');
const request = JSON.parse(readFileSync(requestPath, 'utf8').replace(/^\uFEFF/, ''));
let result;
if (operation === 'capabilities') {
  requireThat(isAbsolute(request.runDirectory) && !existsSync(request.runDirectory),
    'Capability discovery needs a fresh absolute receipt directory');
  mkdirSync(request.runDirectory, { recursive: true });
  writeFileSync(join(request.runDirectory, 'request.json'), `${JSON.stringify(request, null, 2)}\n`, { flag: 'wx' });
  try {
    result = await discoverAlCapabilities(configAt(request.templateConfig), {
      qualification: request.qualification ? pinnedInput(request.qualification) : null,
      onProgress: progress => writeFileSync(join(request.runDirectory, 'progress.json'), JSON.stringify(progress))
    });
    writeFileSync(join(request.runDirectory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    writeFileSync(join(request.runDirectory, 'failure.json'), JSON.stringify({
      code: error.code, message: error.message, automaticRetry: false
    }), { flag: 'wx' });
    throw error;
  }
} else result = operation === 'cycle' ? await runAlRecurring(request) : ['qualify', 'replay'].includes(operation)
  ? await runAlNative(request, operation === 'qualify' ? 'qualification' : 'candidate')
  : await runAlWorkflow(operation, request);
console.log(JSON.stringify(result, null, 2));

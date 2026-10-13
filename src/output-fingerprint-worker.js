import { parentPort } from 'node:worker_threads';
import { outputPathFingerprint } from './output-fingerprint.js';

parentPort.on('message', ({ workspace, index, path }) => {
  try {
    const value = outputPathFingerprint(workspace, path);
    parentPort.postMessage({
      index, valid: value !== null, serialized: JSON.stringify(value)
    });
  } catch (error) {
    parentPort.postMessage({ index, error: error.message });
  }
});

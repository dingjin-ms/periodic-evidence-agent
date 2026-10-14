import { parentPort } from 'node:worker_threads';
import {
  dependencyEntryFingerprint, outputPathFingerprint
} from './output-fingerprint.js';

parentPort.on('message', ({ workspace, index, mode, path, dependencyPath, entryPath }) => {
  try {
    const value = mode === 'dependency-entry'
      ? dependencyEntryFingerprint(workspace, dependencyPath, entryPath)
      : outputPathFingerprint(workspace, path);
    parentPort.postMessage({
      index, valid: value !== null, serialized: JSON.stringify(value)
    });
  } catch (error) {
    parentPort.postMessage({ index, error: error.message });
  }
});

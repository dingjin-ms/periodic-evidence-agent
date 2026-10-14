import { parentPort } from 'node:worker_threads';
import {
  dependencyEntryFingerprint, dependencyEntryFingerprintWithEntries,
  outputPathFingerprint, outputPathFingerprintWithEntries
} from './output-fingerprint.js';

parentPort.on('message', ({
  workspace, index, mode, path, dependencyPath, entryPath, captureEntries
}) => {
  try {
    const result = captureEntries
      ? mode === 'dependency-entry'
        ? dependencyEntryFingerprintWithEntries(
          workspace, dependencyPath, entryPath)
        : outputPathFingerprintWithEntries(workspace, path)
      : null;
    const value = result?.value ?? (mode === 'dependency-entry'
      ? dependencyEntryFingerprint(workspace, dependencyPath, entryPath)
      : outputPathFingerprint(workspace, path));
    parentPort.postMessage({
      index, valid: value !== null, serialized: JSON.stringify(value),
      entries: result?.entries ?? null
    });
  } catch (error) {
    parentPort.postMessage({ index, error: error.message });
  }
});

import { parentPort } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import {
  dependencyEntriesFingerprint, dependencyEntryFingerprint, dependencyEntryFingerprintWithEntries,
  outputPathFingerprint, outputPathFingerprintWithEntries, pathFingerprint
} from './output-fingerprint.js';

parentPort.on('message', ({
  workspace, index, mode, path, paths, dependencyPath, entryPath, entryPaths, captureEntries,
  measure = false
}) => {
  try {
    const started = performance.now();
    const fingerprint = (mode, entryPath) => {
      if (mode === 'tree-path') {
        const entries = captureEntries ? [] : null;
        return { value: pathFingerprint(workspace, path, entries), entries };
      }
      const result = captureEntries
        ? mode === 'dependency-entry'
          ? dependencyEntryFingerprintWithEntries(
            workspace, dependencyPath, entryPath)
          : outputPathFingerprintWithEntries(workspace, path)
        : null;
      return captureEntries ? result : {
        value: mode === 'dependency-entry'
          ? dependencyEntryFingerprint(workspace, dependencyPath, entryPath)
          : outputPathFingerprint(workspace, path)
      };
    };
    const treePaths = () => {
      const entries = captureEntries ? [] : null;
      const values = [];
      for (const path of paths) {
        const value = pathFingerprint(workspace, path, entries);
        if (!value) return null;
        values.push(value);
      }
      return { value: values, entries };
    };
    const result = mode === 'tree-paths' ? treePaths()
      : mode === 'dependency-entries'
      ? dependencyEntriesFingerprint(workspace, dependencyPath, entryPaths, captureEntries)
      : fingerprint(mode, entryPath);
    const valid = result?.value != null;
    const value = valid ? result.value : null;
    const computed = performance.now();
    const serialized = JSON.stringify(value);
    const timing = {
      computeMs: computed - started,
      serializeMs: performance.now() - computed
    };
    parentPort.postMessage({
      index, valid, serialized,
      ...(measure ? { timing } : {}),
      ...(captureEntries
        ? { entries: valid ? result.entries : null }
        : {})
    });
  } catch (error) {
    parentPort.postMessage({ index, error: error.message });
  }
});

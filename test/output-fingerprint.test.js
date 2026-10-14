import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { outputPathFingerprint } from '../src/output-fingerprint.js';

test('parallel fingerprint workers stay schema-free and preserve complete output hashes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'output-fingerprint-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'output'));
  writeFileSync(join(root, 'output', 'synthetic.txt'), 'synthetic output\n');
  const paths = ['output', 'output/synthetic.txt', 'missing'];
  const expected = paths.map(path => outputPathFingerprint(root, path));
  const entry = new URL('../src/output-fingerprint-worker.js', import.meta.url).href;
  const bootstrap = `
    const fs = require('node:fs');
    const { syncBuiltinESMExports } = require('node:module');
    const { workerData } = require('node:worker_threads');
    const readFile = fs.readFileSync;
    fs.readFileSync = (path, ...args) => {
      if (String(path).endsWith('contracts.schema.json'))
        throw Error('Fingerprint workers must not initialize controller schemas');
      return readFile(path, ...args);
    };
    syncBuiltinESMExports();
    import(workerData.entry).catch(error => { throw error; });
  `;
  for (let round = 0; round < 4; round++) {
    const workers = Array.from({ length: 8 }, () =>
      new Worker(bootstrap, { eval: true, workerData: { entry } }));
    try {
      await Promise.all(workers.map(async worker => {
        for (const [index, path] of paths.entries()) {
          const reply = once(worker, 'message');
          worker.postMessage({ workspace: root, index, path });
          const [result] = await reply;
          assert.deepEqual(result, {
            index, valid: expected[index] !== null,
            serialized: JSON.stringify(expected[index])
          });
        }
      }));
    } finally {
      await Promise.all(workers.map(worker => worker.terminate()));
    }
  }
});

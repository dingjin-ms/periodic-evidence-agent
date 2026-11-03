// Offline synthetic traversal; no WorkIQ client or workplace data is used.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configAt } from '../src/common.js';
import { beginApp, openApp } from '../src/app-native.js';
import { principalPath } from '../src/runtime.js';
const { collectCliWorkiq } = await import(process.argv[2]
  ? pathToFileURL(resolve(process.argv[2])).href : '../src/cli-collection.js');
const roots = Number(process.argv[3] ?? 200);
if (!Number.isSafeInteger(roots) || roots < 1 || roots > 1000) throw Error('Expected 1..1000 roots');
const config = configAt('pilot.example.json');
config.stateDirectory = mkdtempSync(join(tmpdir(), 'workiq-benchmark-'));
config.statePolicy.accessApproved = true;
config.sources.workiq.enabled = true;
config.sources.workiq.scopeApproved = true;
config.sources.workiq.seeds = [config.sources.workiq.seeds[0]];
config.runtime.workiqCli = { enabled: true, executable: process.execPath, packageVersion: '1.0.1', timeoutMs: 1000 };
Object.assign(config.dryRun.limits, { maxItems: 20000, maxCalls: 1500 });
beginApp(config, { runId: 'benchmark', dryRun: true, provenance: 'app-tool' });
const { ledger } = openApp(config, 'benchmark');
const message = id => ({ id, createdDateTime: '2026-01-01T00:00:00Z',
  lastModifiedDateTime: '2026-01-01T00:00:00Z', body: { contentType: 'text', content: 'Synthetic benchmark' } });
let calls = 0;
const started = performance.now();
try {
  const result = await collectCliWorkiq(config, ledger, 'benchmark', async () => ({
    close: async () => {},
    read: async path => {
      calls++;
      let data;
      if (path === principalPath) data = { id: config.identity.objectId, userPrincipalName: config.identity.designatedUser };
      else if (path.includes('/replies?')) {
        const rootId = path.split('/messages/')[1].split('/')[0];
        data = { value: Array.from({ length: 14 }, (_, i) => message(`${rootId}-reply-${i}`)) };
      } else {
        const url = new URL(path, 'https://scope.invalid');
        const offset = Number(url.searchParams.get('$skiptoken') ?? 0);
        data = { value: Array.from({ length: Math.min(50, roots - offset) }, (_, i) => message(`root-${offset + i}`)) };
        if (offset + 50 < roots) {
          url.searchParams.set('$skiptoken', String(offset + 50));
          data['@odata.nextLink'] = url.pathname + url.search;
        }
      }
      return { structuredContent: { results: [{ statusCode: 200, data }] } };
    }
  }));
  const pass = result.collection.find(p => p.pass === 'workiq:created');
  console.log(JSON.stringify({ roots, calls, examined: pass.examinedRecords, evidence: pass.evidenceCount,
    state: pass.state, elapsedMs: Math.round(performance.now() - started) }));
  if (pass.state !== 'complete' || pass.examinedRecords !== roots * 15) process.exitCode = 1;
} finally { ledger.close(); rmSync(config.stateDirectory, { recursive: true, force: true }); }

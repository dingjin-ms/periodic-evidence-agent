import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { createAlAgencyLiveE2eRequest } from '../src/al-agency-controller.js';

function fixture() {
  return { schema: 'pea-al-agency-live-e2e-request-v1', baseRevision: 'a'.repeat(40),
    peaRevision: 'c'.repeat(40),
    runnerPath: resolve('scripts/validation/augloop-agency-runner.mjs'),
    preloadPath: resolve('scripts/validation/augloop-agency-node-preload.cjs'),
    skillSha256: 'b'.repeat(64),
    organization: 'office', project: 'ISS', repository: 'augloop-workflows',
    branch: 'feature/fixture/al-base', pipelineId: 38919,
    pipelineRef: 'refs/heads/feature/fixture/al-base' };
}

test('builds an explicit source- and asset-bound AL same-workspace request', () => {
  const request = createAlAgencyLiveE2eRequest(fixture());
  assert.equal(request.modelConfiguration.model, 'gpt-6-luna');
  assert.deepEqual(request.plugins, [{
    name: `ado-git:office/ISS/augloop-workflows:utils/excel-agent-in-container-proxy@${'a'.repeat(40)}`,
    type: 'Spec'
  }]);
  assert.equal(request.additionalOptions.pluginOptions.includeDefaults, false);
  assert.equal(request.metadata.maxModelSessions, '1');
  assert.equal(request.metadata.softCreditLimit, '30');
  assert.equal(request.metadata.maxRepairAttempts, '2');
  assert.equal(request.metadata.maximumJobMinutes, '90');
  assert.equal(request.metadata.maximumControllerMinutes, '180');
  assert.equal(request.metadata.skillName, 'excel-agent-in-container-proxy-integration-tests');
  assert.equal(request.metadata.skillPlugin, request.plugins[0].name);
  assert.match(request.prompt, /Do not design or regenerate validation infrastructure/);
  assert.match(request.prompt, /Each line is index:SHA-256:base64-chunk/);
  assert.match(request.prompt, /literal ASCII\/UTF-8 bytes of the base64-chunk string itself/);
  assert.match(request.prompt, /never hash decoded chunk bytes/);
  assert.match(request.prompt, /at most four lines each/);
  assert.match(request.prompt, /Never manually repair, infer, delete or substitute a chunk/);
  assert.match(request.prompt, /do not run any focused product test, build or validation command first/);
  assert.match(request.prompt, /separate ordinary powershell tool call with mode "sync" and initial_wait 600/);
  assert.match(request.prompt, /command must contain only a direct invocation/);
  assert.match(request.prompt, /Do not combine input creation, checks, variables, assignments/);
  assert.match(request.prompt, /do not request interactive approval or special permissions/);
  assert.match(request.prompt, /Run the controller once only/);
  assert.match(request.prompt, /periodic heartbeats/);
  assert.match(request.prompt, /Never call stop_powershell merely because the controller remains running/);
  assert.match(request.prompt, /use read_powershell on that same shell until it completes/);
  assert.match(request.prompt, /prints a bounded failure diagnostic to the same shell/);
  assert.match(request.prompt, new RegExp(request.metadata.runnerSha256));
  assert.match(request.prompt, new RegExp(request.metadata.preloadSha256));
  assert.match(request.prompt, new RegExp(request.metadata.skillSha256));
  assert.equal(Buffer.byteLength(JSON.stringify(request)) < 28000, true);

  const sections = request.prompt.matchAll(/(?:Runner|Preload) chunks begin:\n([\s\S]*?)\n(?:Runner|Preload) chunks end/g);
  const assets = [...sections].map(section => section[1].split('\n').map(line => {
    const [index, sha256, value] = line.split(':');
    assert.equal(createHash('sha256').update(value).digest('hex'), sha256);
    return { index: Number(index), value };
  }).sort((left, right) => left.index - right.index));
  assert.deepEqual(assets.map(chunks => createHash('sha256').update(gunzipSync(Buffer.from(
    chunks.map(chunk => chunk.value).join(''), 'base64'))).digest('hex')),
  [request.metadata.runnerSha256, request.metadata.preloadSha256]);
});

test('rejects unpinned sources and non-pipeline requests', () => {
  for (const mutate of [
    value => { value.baseRevision = 'HEAD'; },
    value => { value.peaRevision = 'HEAD'; },
    value => { value.runnerPath = 'relative.mjs'; },
    value => { value.skillSha256 = 'unbound'; },
    value => { value.pipelineId = 0; },
    value => { value.branch = '../other'; }
  ]) {
    const invalid = fixture(); mutate(invalid);
    assert.throws(() => createAlAgencyLiveE2eRequest(invalid), /Invalid explicit/);
  }
});

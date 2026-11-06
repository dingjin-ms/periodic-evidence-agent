import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Ledger } from '../src/ledger.js';
import { hash, json } from '../src/common.js';
import { materializeRequestTools, verifyRequestTools } from '../src/request-tools.js';
import { admitRequestPhase } from '../src/request-phases.js';

for (const mode of ['ready', 'changed-source', 'missing-source', 'changed-manifest', 'target-drift', 'existing-target']) {
  test(`fresh request tools ${mode}`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'request-tools-')), workspace = join(root, 'work'); mkdirSync(workspace);
    const git = args => execFileSync('git', ['-C', workspace, '-c', 'core.hooksPath=.git/no-hooks',
      '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args], { encoding: 'utf8' }).trim();
    writeFileSync(join(workspace, '.gitignore'), 'node_modules/\n'); writeFileSync(join(workspace, 'lock.json'), '{}');
    git(['init', '--quiet']); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'base']);
    const revision = git(['rev-parse', 'HEAD']); git(['update-ref', 'refs/remotes/origin/main', revision]);
    const tool = join(root, 'tool.js'); writeFileSync(tool, 'export const tool = true;');
    const manifest = { format: 'request-local-tools-v1', sourceRevision: revision, targetRef: 'refs/heads/main', targetRevision: revision,
      provenance: 'Synthetic pinned local fixture, not live qualification', roots: ['node_modules'], links: [],
      runtimePins: [{ path: process.execPath, sha256: hash(readFileSync(process.execPath)) }],
      sourcePins: [{ path: 'lock.json', sha256: hash('{}'), checkoutSha256: hash('{}') }],
      files: [{ path: 'node_modules/tool.js', source: tool, sha256: hash(readFileSync(tool)), mode: 0o644 }] };
    const path = join(root, 'manifest.json'); writeFileSync(path, json(manifest));
    const repo = { baseRef: revision, pr: { targetRef: manifest.targetRef }, requestExecution: { tools: {
      scopeApproved: true, approvalRef: 'fixture', timeoutMs: 10000, manifest: { path, sha256: hash(readFileSync(path)) } } } };
    const config = { stateDirectory: join(root, 'state') }, ledger = new Ledger(config.stateDirectory);
    t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
    if (mode === 'changed-source') writeFileSync(tool, 'changed');
    if (mode === 'missing-source') rmSync(tool);
    if (mode === 'changed-manifest') writeFileSync(path, '{}');
    if (mode === 'target-drift') {
      writeFileSync(join(workspace, 'new.txt'), 'new'); git(['add', '.']);
      git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'other']);
      git(['update-ref', 'refs/remotes/origin/main', git(['rev-parse', 'HEAD'])]);
    }
    if (mode === 'existing-target') mkdirSync(join(workspace, 'node_modules'));
    const invoke = () => materializeRequestTools(config, ledger, { id: 'job', workspace, base_revision: revision }, repo);
    if (mode === 'ready') {
      const receipt = await invoke(); assert.equal(receipt.copied, true); await verifyRequestTools(repo, workspace);
      assert.equal(readFileSync(join(workspace, 'node_modules/tool.js'), 'utf8'), 'export const tool = true;');
      assert.equal(git(['status', '--porcelain']), '');
      await assert.rejects(invoke(), /attempted/);
    } else {
      await assert.rejects(invoke()); assert.equal(existsSync(join(workspace, 'node_modules/tool.js')), false);
    }
  });
}
test('phase admission refuses aggregate native budget and expiry', () => {
  const config = { limits: { maxValidationRepairRounds: 0, maxValidationInfrastructureRetries: 0, workerMinutes: 8 } };
  const repo = { provisionTimeoutMs: 30000, validationGates: [{ timeoutMs: 120000 }], requestExecution: { preflight: { timeoutMs: 30000 },
    phases: { scopeApproved: true, approvalRef: 'fixture', foregroundMs: 600000, maxTotalMs: 1200000,
      expiresAt: new Date(Date.now() + 3600000).toISOString(), budgets: { prepare: 120000, author: 480000, commit: 180000, validate: 300000, publish: 240000 } } } };
  assert.ok(admitRequestPhase(config, repo, 'author'));
  repo.requestExecution.phases.budgets.author = 520000;
  assert.throws(() => admitRequestPhase(config, repo, 'author'), /foreground/);
  repo.requestExecution.phases.budgets.author = 480000;
  repo.requestExecution.phases.expiresAt = '2000-01-01T00:00:00Z';
  assert.throws(() => admitRequestPhase(config, repo, 'author'), /authority/);
});

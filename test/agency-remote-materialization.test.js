import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  command, materializeAgencyRemoteResult
} from '../src/workers.js';

async function git(cwd, args) {
  return (await command('git', [
    '-c', 'core.autocrlf=false',
    '-c', 'core.safecrlf=false',
    '-c', 'user.name=Agency Fixture',
    '-c', 'user.email=agency@example.invalid',
    ...args
  ], cwd)).stdout.trim();
}

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'agency-remote-materialization-'));
  const workspace = join(root, 'workspace');
  mkdirSync(join(workspace, 'test'), { recursive: true });
  writeFileSync(join(workspace, 'test', 'base.txt'), 'base\n');
  await git(workspace, ['init', '--quiet']);
  await git(workspace, ['add', '.']);
  await git(workspace, ['commit', '--quiet', '-m', 'base']);
  const baseRevision = await git(workspace, ['rev-parse', 'HEAD']);
  const result = join(root, 'result');
  await git(root, ['clone', '--quiet', workspace, result]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { workspace, result, baseRevision };
}

async function resultRevision(fixture, assignmentId, writes = {},
  envelopeOverride = {}) {
  for (const [path, content] of Object.entries(writes)) {
    const target = join(fixture.result, path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
  const resultPath = join(
    fixture.result, '.periodic-evidence-agent', 'result.json');
  mkdirSync(join(resultPath, '..'), { recursive: true });
  writeFileSync(resultPath, JSON.stringify({
    schemaVersion: '1.0',
    assignmentId,
    round: 0,
    baseRevision: fixture.baseRevision,
    proposal: { outcome: 'propose-change' },
    ...envelopeOverride
  }));
  await git(fixture.result, ['add', '--all']);
  await git(fixture.result, ['commit', '--quiet', '-m', 'result']);
  const revision = await git(fixture.result, ['rev-parse', 'HEAD']);
  await git(fixture.workspace, ['fetch', '--quiet', fixture.result, revision]);
  return revision;
}

function context(fixture) {
  const assignment = { id: 'assignment-fixture', bounds: { maxItems: 10 } };
  let proposal = null;
  return {
    config: { limits: { maxFileBytes: 4096 } },
    current: { workspace: fixture.workspace },
    assignment,
    repo: { allowedWritePrefixes: ['test'] },
    toolkit: {
      use() {},
      finish(value) { proposal = value; }
    },
    proposal: () => proposal
  };
}

async function materialize(fixture, revision) {
  const value = context(fixture);
  const receipt = await materializeAgencyRemoteResult(
    value.config, value.current, value.assignment, value.repo, value.toolkit,
    fixture.baseRevision, { sourceBranch: 'result', round: 0 }, {
      fetchRemoteHead: async () => ({
        ref: 'refs/heads/result',
        revision
      })
    });
  return { ...value, receipt };
}

test('Agency remote materialization imports only approved regular files', async t => {
  const current = await fixture(t);
  const revision = await resultRevision(current, 'assignment-fixture', {
    'test/result.txt': 'remote\n'
  });
  const materialized = await materialize(current, revision);
  assert.equal(readFileSync(
    join(current.workspace, 'test', 'result.txt'), 'utf8'), 'remote\n');
  assert.equal(materialized.receipt.sourceRevision, revision);
  assert.deepEqual(materialized.receipt.changedFiles, ['test/result.txt']);
  assert.equal(materialized.proposal().outcome, 'propose-change');
});

test('Agency remote materialization rejects forbidden paths', async t => {
  const current = await fixture(t);
  const revision = await resultRevision(current, 'assignment-fixture', {
    'src/forbidden.txt': 'forbidden\n'
  });
  await assert.rejects(materialize(current, revision), error =>
    error.code === 'blocked-scope' &&
    /outside the approved prefixes/.test(error.message));
});

test('Agency remote materialization rejects malformed envelopes', async t => {
  const current = await fixture(t);
  const revision = await resultRevision(current, 'wrong-assignment', {
    'test/result.txt': 'remote\n'
  });
  await assert.rejects(materialize(current, revision), error =>
    error.code === 'blocked-reconciliation' &&
    /does not match the submitted assignment/.test(error.message));
});

test('Agency remote materialization rejects symlink tree entries', async t => {
  const current = await fixture(t);
  const linkTarget = join(current.result, 'link-target');
  writeFileSync(linkTarget, 'target');
  const blob = await git(current.result, ['hash-object', '-w', 'link-target']);
  rmSync(linkTarget);
  await git(current.result, [
    'update-index', '--add', '--cacheinfo', `120000,${blob},test/link`
  ]);
  const resultPath = join(
    current.result, '.periodic-evidence-agent', 'result.json');
  mkdirSync(join(resultPath, '..'), { recursive: true });
  writeFileSync(resultPath, JSON.stringify({
    schemaVersion: '1.0',
    assignmentId: 'assignment-fixture',
    round: 0,
    baseRevision: current.baseRevision,
    proposal: { outcome: 'propose-change' }
  }));
  await git(current.result, ['add', resultPath]);
  await git(current.result, ['commit', '--quiet', '-m', 'symlink result']);
  const revision = await git(current.result, ['rev-parse', 'HEAD']);
  await git(current.workspace, ['fetch', '--quiet', current.result, revision]);
  await assert.rejects(materialize(current, revision), error =>
    error.code === 'blocked-scope' &&
    /non-regular file/.test(error.message));
});

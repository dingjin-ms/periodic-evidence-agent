import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync,
  rmSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preparationGit } from '../src/validation-workspace.js';
import { createOwnedResource, bindResourceGit, updateResource, resourceRecord,
  retireResource, reconcileResources, claimPreflight, abandonPreflight } from '../src/resource-lifecycle.js';
import { hash } from '../src/common.js';
import { command } from '../src/command.js';
import { DatabaseSync } from 'node:sqlite';
import { runCodingTask, closeCodingTask, monitorResourceLifecycle } from '../src/task-lifecycle.js';
import { persistRunArtifact, completeRunEvidence, pruneState } from '../src/state-retention.js';

async function fixture(t, kind = 'validation') {
  const root = mkdtempSync(join(tmpdir(), 'f6-28cce0a9-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'), state = join(root, 'state');
  mkdirSync(source);
  const git = async args => (await command('git',
    ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args], source, 30000)).stdout.trim();
  await git(['init', '-q']);
  await git(['config', 'user.name', 'Synthetic']);
  await git(['config', 'user.email', 'synthetic@example.test']);
  writeFileSync(join(source, '.gitignore'), 'node_modules/\n.store/\n');
  writeFileSync(join(source, 'source.txt'), 'synthetic');
  await git(['add', '.']); await git(['commit', '-qm', 'baseline']);
  const revision = await git(['rev-parse', 'HEAD']);
  const workspace = join(state, `${kind}-workspaces`, 'attempt');
  const resource = await createOwnedResource(state, { source, workspace, revision,
    kind, assignmentId: 'assignment', attemptId: 'attempt',
    cachePaths: ['node_modules'],
    references: kind === 'preflight' ? ['validation-handoff'] : [] });
  await git(['worktree', 'add', '--detach', '--', workspace, revision]);
  await bindResourceGit(state, resource.id);
  const proof = join(state, 'proof.json');
  writeFileSync(proof, JSON.stringify({ status: 'passed', primaryError: null }));
  const evidence = [{ path: proof, sha256: hash(readFileSync(proof)) }];
  const finish = update => updateResource(state, resource.id, {
    processesExited: true, releaseRequested: true, evidence, ...update
  });
  return { root, source, state, workspace, revision, resource, git, proof, evidence, finish };
}

describe('owned resource lifecycle', { concurrency: 3 }, () => {
for (const outcome of ['passed', 'failed', 'cancelled']) {
  test(`${outcome}: archive after evidence and process exit, unregister exactly and repeat safely`, async t => {
    const f = await fixture(t);
    mkdirSync(join(f.workspace, 'node_modules'));
    writeFileSync(join(f.workspace, 'node_modules', 'cache'), 'regenerable');
    writeFileSync(join(f.workspace, 'ignored-diagnostic.log'), 'unique failed-run evidence');
    writeFileSync(f.proof, JSON.stringify({ outcome, primaryError: outcome === 'failed' ? 'business' : null }));
    f.evidence[0].sha256 = hash(readFileSync(f.proof));
    await f.finish({ primaryError: outcome === 'failed' ? { code: 'business' } : null });
    const result = await retireResource(f.state, f.resource.id);
    assert.equal(result.stage, 'complete', result.cleanupError?.message);
    assert(!existsSync(f.workspace));
    const snapshot = join(result.archive, 'snapshot');
    assert.equal(readFileSync(join(snapshot, 'ignored-diagnostic.log'), 'utf8'), 'unique failed-run evidence');
    assert(!existsSync(join(snapshot, 'node_modules')));
    assert(!existsSync(join(snapshot, '.git')));
    assert(!(await f.git(['worktree', 'list', '--porcelain'])).includes(f.workspace.replaceAll('\\', '/')));
    assert.equal((await retireResource(f.state, f.resource.id)).stage, 'complete');
    assert.equal(await f.git(['status', '--porcelain']), '');
  });
}

test('passed preflight is retained until the exact validation consumer releases it', async t => {
  const f = await fixture(t, 'preflight');
  await f.finish({ releaseRequested: false });
  assert.deepEqual(await reconcileResources(f.state), []);
  assert(existsSync(f.workspace));
  await claimPreflight(f.state, f.resource.id, f.workspace, f.revision, 'validation:consumer');
  await assert.rejects(claimPreflight(f.state, f.resource.id, f.workspace, f.revision, 'another-consumer'),
    /not available/);
  assert.equal((await retireResource(f.state, f.resource.id)).status, 'blocked');
  assert(existsSync(f.workspace));
  await f.finish({ references: [] });
  assert.equal((await retireResource(f.state, f.resource.id)).stage, 'complete');
});

for (const reference of ['seed:other-task', 'approval:source', 'proof:unique', 'validation:other-task']) {
  test(`live reference ${reference} prevents disposal`, async t => {
    const f = await fixture(t);
    await f.finish({ references: [reference] });
    assert.equal((await retireResource(f.state, f.resource.id)).status, 'blocked');
    assert(existsSync(f.workspace));
  });
}

for (const phase of ['moving', 'renamed', 'unregistering', 'unregistered', 'cache-removal']) {
  test(`startup resumes interruption at ${phase} using durable directory identity`, async t => {
    const f = await fixture(t);
    mkdirSync(join(f.workspace, 'node_modules'));
    writeFileSync(join(f.workspace, 'node_modules', 'cache'), 'cache');
    await f.finish();
    let stopped = false;
    const initial = await retireResource(f.state, f.resource.id, {
      checkpoint: stage => { if (stage === phase && !stopped) { stopped = true; throw new Error('stop'); } }
    });
    assert(stopped);
    assert.equal(initial.status, 'blocked');
    const results = await reconcileResources(f.state);
    assert.equal(results[0].stage, 'complete', results[0].cleanupError?.message);
    assert(!existsSync(f.workspace));
  });
}

test('directory replacement is preserved even when the old directory still exists elsewhere', async t => {
  const f = await fixture(t);
  await f.finish();
  renameSync(f.workspace, `${f.workspace}-old`);
  mkdirSync(f.workspace);
  writeFileSync(join(f.workspace, 'canary'), 'other task');
  assert.equal((await retireResource(f.state, f.resource.id)).status, 'blocked');
  assert.equal(readFileSync(join(f.workspace, 'canary'), 'utf8'), 'other task');
  assert(existsSync(`${f.workspace}-old`));
});

test('links inside dependencies are unlinked without visiting their external targets', async t => {
  const f = await fixture(t);
  const external = join(f.root, 'external');
  mkdirSync(external); writeFileSync(join(external, 'canary'), 'external');
  mkdirSync(join(f.workspace, 'node_modules'));
  symlinkSync(external, join(f.workspace, 'node_modules', 'external'),
    process.platform === 'win32' ? 'junction' : 'dir');
  await f.finish();
  assert.equal((await retireResource(f.state, f.resource.id)).stage, 'complete');
  assert.equal(readFileSync(join(external, 'canary'), 'utf8'), 'external');
});

test('namespace link replacement blocks cleanup before changing the target', async t => {
  const f = await fixture(t);
  await f.finish();
  const ns = join(f.state, 'validation-workspaces');
  renameSync(ns, `${ns}-old`);
  symlinkSync(`${ns}-old`, ns, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await retireResource(f.state, f.resource.id)).status, 'blocked');
  assert(existsSync(f.workspace));
});

for (const missing of ['pointer', 'registration', 'both']) {
test(`missing Git ${missing} does not hide an owned residual directory`, async t => {
  const f = await fixture(t);
  await f.finish();
  const record = resourceRecord(f.state, f.resource.id);
  if (missing !== 'registration') unlinkSync(join(f.workspace, '.git'));
  // Simulate an interrupted external Git deregistration, not a cleanup operation.
  if (missing !== 'pointer') rmSync(record.adminDirectory, { recursive: true, force: true });
  assert.equal((await reconcileResources(f.state))[0].stage, 'complete');
  assert(!existsSync(f.workspace));
});
}

test('unknown residuals and an interrupted live command are retained and reported', async t => {
  const f = await fixture(t);
  const unknown = join(f.state, 'validation-workspaces', 'unknown');
  mkdirSync(unknown); writeFileSync(join(unknown, 'canary'), 'unowned');
  assert(!(await reconcileResources(f.state)).some(row => row.id === f.resource.id));
  const { stdout } = await command(process.execPath, ['-e', 'console.log(process.pid)'], f.root);
  const path = join(f.state, 'resource-lifecycle', `${f.resource.id}.json`);
  const journal = resourceRecord(f.state, f.resource.id);
  journal.leasePid = Number(stdout.trim());
  writeFileSync(path, JSON.stringify(journal));
  const result = await reconcileResources(f.state);
  assert(result.some(row => row.reason?.includes('process exit')));
  assert(result.some(row => row.reason?.includes('Unknown ownership')));
  assert(existsSync(unknown));
  assert(existsSync(f.workspace));
});

test('cleanup failure preserves the primary failure and never reports completion', async t => {
  const f = await fixture(t);
  await f.finish({ primaryError: { code: 'business-failed' } });
  const result = await retireResource(f.state, f.resource.id, {
    checkpoint: stage => { if (stage === 'unregistering') throw new Error('cleanup occupied'); }
  });
  assert.equal(result.status, 'blocked');
  const saved = resourceRecord(f.state, f.resource.id);
  assert.equal(saved.primaryError.code, 'business-failed');
  assert(saved.cleanupError);
  assert.notEqual(saved.stage, 'complete');
  assert(existsSync(join(saved.archive, 'snapshot', 'source.txt')));
});

test('evidence must be external, intact and persisted before cleanup', async t => {
  const f = await fixture(t);
  await f.finish();
  writeFileSync(f.proof, 'changed');
  assert.equal((await retireResource(f.state, f.resource.id)).status, 'blocked');
  assert(existsSync(f.workspace));
});

test('wrong Git common owner and unowned preexisting directories cannot be adopted', async t => {
  const f = await fixture(t);
  const other = join(f.root, 'other'); mkdirSync(other);
  await preparationGit(other, ['init', '-q'], 30000);
  await assert.rejects(createOwnedResource(f.state, {
    kind: 'validation', workspace: f.workspace, source: other, revision: f.revision,
    assignmentId: 'another', attemptId: 'another'
  }), /fresh/);
  const journal = join(f.state, 'resource-lifecycle', `${f.resource.id}.json`);
  const record = JSON.parse(readFileSync(journal));
  record.commonDirectory = join(other, '.git');
  writeFileSync(journal, JSON.stringify(record));
  await assert.rejects(bindResourceGit(f.state, f.resource.id), /common owner/);
  assert(existsSync(f.workspace));
});

for (const phase of ['renamed', 'cache-removal']) {
  test(`an abruptly terminated controller leaves a recoverable journal at ${phase}`, async t => {
    const f = await fixture(t);
    mkdirSync(join(f.workspace, 'node_modules'));
    writeFileSync(join(f.workspace, 'node_modules', 'cache'), 'cache');
    await f.finish();
    const module = new URL('../src/resource-lifecycle.js', import.meta.url).href;
    const marker = join(f.root, 'terminated-phase.txt');
    const code = `import { writeFileSync } from 'node:fs';
      import { retireResource, resourceRecord } from ${JSON.stringify(module)};
      const record = resourceRecord(${JSON.stringify(f.state)}, ${JSON.stringify(f.resource.id)});
      record.leasePid = process.pid;
      writeFileSync(${JSON.stringify(join(f.state, 'resource-lifecycle', `${f.resource.id}.json`))},
        JSON.stringify(record));
      await retireResource(${JSON.stringify(f.state)}, ${JSON.stringify(f.resource.id)}, {
        checkpoint(stage) {
          if (stage === ${JSON.stringify(phase)}) {
            writeFileSync(${JSON.stringify(marker)}, stage);
            process.kill(process.pid, 'SIGKILL');
          }
        }
      });`;
    await assert.rejects(command(process.execPath, ['--input-type=module', '-e', code], f.root, 120000));
    assert.equal(readFileSync(marker, 'utf8'), phase);
    assert.equal(resourceRecord(f.state, f.resource.id).stage, phase === 'renamed' ? 'moving' : 'cache-removal');
    assert(!existsSync(f.workspace));
    const results = await reconcileResources(f.state);
    assert.equal(results[0].stage, 'complete', results[0].cleanupError?.message);
    assert(!existsSync(f.workspace));
  });
}

test('an archive link cannot redirect a same-volume move outside the owned state', async t => {
  const f = await fixture(t);
  await f.finish();
  const external = join(f.root, 'external'); mkdirSync(external);
  writeFileSync(join(external, 'canary'), 'outside');
  mkdirSync(join(f.state, 'resource-archives'));
  symlinkSync(external, f.resource.archive, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await retireResource(f.state, f.resource.id)).status, 'blocked');
  assert(existsSync(f.workspace));
  assert.equal(readFileSync(join(external, 'canary'), 'utf8'), 'outside');
});

for (const phase of ['renamed', 'cache-removal']) {
test(`a cache replaced at ${phase} cannot be deleted using an earlier identity`, async t => {
  const f = await fixture(t);
  mkdirSync(join(f.workspace, 'node_modules'));
  writeFileSync(join(f.workspace, 'node_modules', 'original'), 'original');
  await f.finish();
  const result = await retireResource(f.state, f.resource.id, { checkpoint(stage, record) {
    if (stage !== phase) return;
    const path = join(record.archive, 'snapshot', 'node_modules');
    renameSync(path, `${path}-old`); mkdirSync(path);
    writeFileSync(join(path, 'canary'), 'other owner');
  } });
  assert.equal(result.status, 'blocked');
  assert.equal(readFileSync(join(result.archive, 'snapshot', 'node_modules', 'canary'), 'utf8'), 'other owner');
});
}

test('nested repositories block dependency deletion and preserve all their files', async t => {
  const f = await fixture(t);
  const path = join(f.workspace, 'node_modules', 'another-repo');
  mkdirSync(path, { recursive: true });
  mkdirSync(join(path, '.git')); writeFileSync(join(path, 'canary'), 'another task');
  await f.finish();
  const result = await retireResource(f.state, f.resource.id);
  assert.equal(result.status, 'blocked');
  assert.equal(readFileSync(join(result.archive, 'snapshot', 'node_modules', 'another-repo', 'canary'), 'utf8'), 'another task');
});

test('an undeclared cache-shaped directory is preserved instead of classified by name', async t => {
  const f = await fixture(t);
  mkdirSync(join(f.workspace, '.store')); writeFileSync(join(f.workspace, '.store', 'unique'), 'proof');
  await f.finish();
  const result = await retireResource(f.state, f.resource.id);
  assert.equal(result.stage, 'complete');
  assert.equal(readFileSync(join(result.archive, 'snapshot', '.store', 'unique'), 'utf8'), 'proof');
});

test('explicit abandonment releases only an unconsumed successful preflight', async t => {
  const f = await fixture(t, 'preflight');
  await f.finish({ releaseRequested: false });
  assert.equal((await abandonPreflight(f.state, f.resource.id)).stage, 'complete');
  assert.equal((await abandonPreflight(f.state, f.resource.id)).stage, 'complete');
});

test('another owned resource retains its exact source even without a manual reference string', async t => {
  const f = await fixture(t);
  await createOwnedResource(f.state, {
    kind: 'validation', workspace: join(f.state, 'validation-workspaces', 'consumer'),
    source: f.workspace, revision: f.revision,
    assignmentId: 'consumer', attemptId: 'consumer', references: ['running']
  });
  await f.finish();
  assert.equal((await retireResource(f.state, f.resource.id)).status, 'blocked');
  assert(existsSync(f.workspace));
});

test('ordinary retention protects referenced proof until its archived copy is durable', async t => {
  const f = await fixture(t);
  const config = { stateDirectory: f.state, statePolicy: { rawEvidenceDays: 1 } };
  const proof = persistRunArtifact(config, 'proof-run', 'proof.json', '{"status":"passed"}');
  const ref = { path: proof.path, sha256: hash(readFileSync(proof.path)) };
  completeRunEvidence(config, 'proof-run', 'blocked');
  await f.finish({ references: ['investigation:proof'], evidence: [ref] });
  const options = { nowMs: Date.now() + 8 * 86400000 };
  const lease = new DatabaseSync(join(f.state, 'resource-lifecycle', 'lease.sqlite'));
  lease.exec('BEGIN IMMEDIATE');
  try { assert.throws(() => pruneState(config, options), /ownership transition is active/); }
  finally { lease.exec('ROLLBACK'); lease.close(); }
  assert(pruneState(config, options).retained.some(row => row.reason === 'resource-lifecycle-reference'));
  assert(existsSync(proof.path));
  await f.finish({ references: [], evidence: [ref] });
  const retired = await retireResource(f.state, f.resource.id);
  assert.equal(retired.stage, 'complete');
  assert.deepEqual(pruneState(config, options).deletedRunIds, ['proof-run']);
  assert.equal(hash(readFileSync(retired.archivedEvidence[0].path)), ref.sha256);
});

test('managed coding task closes into the real merge monitor without publishing or merging', async t => {
  const f = await fixture(t);
  const config = { stateDirectory: join(f.root, 'task-state') };
  const run = await runCodingTask(config, {
    source: f.source, revision: f.revision, branch: 'synthetic-owned-task',
    executable: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 30000
  });
  assert.equal(run.status, 'retained', run.error?.message);
  const receipt = (name, format, status) => {
    const path = join(f.root, name);
    writeFileSync(path, JSON.stringify({ format, status, repository: 'synthetic/fixture',
      number: 7, revision: f.revision }));
    return { path, sha256: hash(readFileSync(path)) };
  };
  const request = { resourceId: run.resourceId, repository: 'synthetic/fixture',
    number: 7, revision: f.revision,
    validation: receipt('validation.json', 'coding-task-validation-v1', 'passed'),
    handover: receipt('handover.json', 'coding-task-handover-v1', 'complete') };
  let pr = { state: 'OPEN', isDraft: true, mergedAt: null, headRefOid: f.revision,
    statusCheckRollup: [] };
  const options = { getPullRequest: async () => pr };
  const pending = await closeCodingTask(config, request, options);
  assert(pending.some(row => row.status === 'retained'));
  assert(existsSync(run.workspace));
  assert((await closeCodingTask(config, request, options)).some(row => row.status === 'retained'));
  const mergeRef = 'merge:synthetic/fixture#7';
  await updateResource(config.stateDirectory, run.resourceId, { references: [mergeRef, 'seed:another-task'] });
  assert((await monitorResourceLifecycle(config, options)).some(row => row.status === 'blocked'));
  assert(resourceRecord(config.stateDirectory, run.resourceId).references.includes('seed:another-task'));
  await updateResource(config.stateDirectory, run.resourceId, { references: [mergeRef] });
  pr = { ...pr, state: 'MERGED', isDraft: false, mergedAt: new Date().toISOString(),
    statusCheckRollup: [{ status: 'IN_PROGRESS', conclusion: null }] };
  assert((await monitorResourceLifecycle(config, options)).some(row => row.status === 'blocked'));
  assert(existsSync(run.workspace));
  pr.statusCheckRollup = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
  writeFileSync(join(run.workspace, 'uncommitted-canary'), 'unfinished work');
  const dirty = (await monitorResourceLifecycle(config, options)).find(row => row.id === run.resourceId);
  assert.equal(dirty.status, 'blocked');
  assert.equal(readFileSync(join(run.workspace, 'uncommitted-canary'), 'utf8'), 'unfinished work');
  unlinkSync(join(run.workspace, 'uncommitted-canary'));
  const result = (await monitorResourceLifecycle(config, options)).find(row => row.id === run.resourceId);
  assert.equal(result.stage, 'complete', result.cleanupError?.message);
  assert(existsSync(result.bundle.path));
  assert(!existsSync(run.workspace));
  const recovered = join(f.root, 'recovered');
  await command('git', ['clone', '--quiet', result.bundle.path, recovered], f.root);
  assert.equal((await command('git', ['rev-parse', 'HEAD'], recovered)).stdout.trim(), f.revision);
  assert.equal((await monitorResourceLifecycle(config, options)).find(row => row.id === run.resourceId).stage,
    'complete');
});
});

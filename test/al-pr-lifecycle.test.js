import test from 'node:test';
import assert from 'node:assert/strict';
import { observeAlDraft } from '../src/al-pr-lifecycle.js';

function fixture() {
  const head = 'a'.repeat(40), merge = 'b'.repeat(40), repositoryId = '11111111-1111-1111-1111-111111111111';
  const remote = 'https://dev.azure.com/office/ISS/_git/augloop-workflows';
  const config = { repositories: [{ id: 'augloop-workflows', remote, baseRef: 'c'.repeat(40),
    pr: { provider: 'ado', organization: 'office', project: 'ISS', repositoryId, targetRef: 'refs/heads/main' } }] };
  const expected = { isDraft: true, headRevision: head, url: `${remote}/pullrequest/123` };
  const pr = { pullRequestId: 123, repository: { id: repositoryId,
    project: { id: '22222222-2222-2222-2222-222222222222' } },
  targetRefName: 'refs/heads/main', status: 'active', isDraft: true,
  lastMergeSourceCommit: { commitId: head }, lastMergeCommit: { commitId: merge } };
  const policies = { count: 1, value: [{ configuration: { isBlocking: true, isEnabled: true },
    status: 'approved', context: { buildId: 7 } }] };
  const build = { id: 7, status: 'completed', result: 'succeeded', sourceVersion: merge,
    sourceBranch: 'refs/pull/123/merge' };
  const paths = [];
  const read = async path => {
    paths.push(path);
    return structuredClone(path.startsWith('policy/') ? policies : path.startsWith('build/') ? build : pr);
  };
  return { config, expected, pr, policies, build, paths, options: { read,
    deadlineAt: new Date(Date.now() + 60000).toISOString() } };
}
test('AL lifecycle reads current PR policies and exact merge builds without queue/merge actions', async () => {
  const f = fixture(), result = await observeAlDraft(f.config, f.expected, f.options);
  assert.equal(result.state, 'draft-required-policies-approved');
  assert.equal(result.readCalls, 4);
  assert.equal(result.mergeOrQueuePerformed, false);
  assert.equal(f.paths.filter(path => path.startsWith('git/')).length, 2);
  assert.ok(f.paths.every(path => path.includes('api-version=')));
});
test('AL lifecycle cannot reuse stale head, wrong merge build or empty policy coverage', async () => {
  const f = fixture();
  f.pr.lastMergeSourceCommit.commitId = 'd'.repeat(40);
  assert.equal((await observeAlDraft(f.config, f.expected, f.options)).state, 'head-changed-revalidation-required');
  assert.equal(f.paths.length, 1);
  f.pr.lastMergeSourceCommit.commitId = f.expected.headRevision;
  f.build.sourceVersion = 'e'.repeat(40);
  assert.equal((await observeAlDraft(f.config, f.expected, f.options)).state, 'draft-policy-work-pending');
  f.build.id = 8;
  await assert.rejects(observeAlDraft(f.config, f.expected, f.options), /different build identity/);
  f.policies.value = []; f.policies.count = 0;
  await assert.rejects(observeAlDraft(f.config, f.expected, f.options), /No required policies/);
  await assert.rejects(observeAlDraft(f.config, { ...f.expected, url: 'https://example.invalid/pullrequest/123' },
    f.options), /different AL repository/);
  await assert.rejects(observeAlDraft(f.config, f.expected, { ...f.options, deadlineAt: '2000-01-01T00:00:00Z' }),
    /authorization expired/);
});

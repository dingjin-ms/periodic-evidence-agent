import { adoAccessToken } from './ado-auth.js';
import { requireThat, now } from './common.js';
import { requireAlRepository } from './al-capabilities.js';

export async function observeAlDraft(config, expected, { read, maxPolicyBuilds = 10, deadlineAt } = {}) {
  requireThat(config.repositories.length === 1, 'AL PR observation needs one repository', 'blocked-owner');
  const repo = config.repositories[0];
  requireAlRepository(repo);
  requireThat(repo.pr?.provider === 'ado' && repo.pr.organization === 'office' && repo.pr.project === 'ISS' &&
    typeof repo.pr.repositoryId === 'string' && repo.pr.targetRef?.startsWith('refs/heads/') &&
    expected?.isDraft === true && /^[a-f0-9]{40}$/.test(expected.headRevision ?? '') &&
    Number.isSafeInteger(maxPolicyBuilds) && maxPolicyBuilds > 0 && maxPolicyBuilds <= 10,
  'AL PR observation requires an exact native publisher receipt and bounded policy reads', 'blocked-config');
  const prefix = `${repo.remote.replace(/\/$/, '')}/pullrequest/`;
  requireThat(expected.url?.startsWith(prefix) && /^[1-9]\d*$/.test(expected.url.slice(prefix.length)),
    'PR belongs to a different AL repository', 'blocked-owner');
  const id = Number(expected.url.slice(prefix.length));
  const base = 'https://dev.azure.com/office/ISS/_apis';
  let readCalls = 0;
  const request = async path => {
    requireThat(Date.parse(deadlineAt) > Date.now(), 'AL PR observation authorization expired', 'blocked-authorization');
    requireThat(++readCalls <= maxPolicyBuilds + 3, 'AL PR observation read budget exhausted', 'blocked-budget');
    if (read) return read(path);
    const token = await adoAccessToken(config, 'AL read-only Draft/PR-policy observation');
    const response = await fetch(`${base}/${path}`, { method: 'GET',
      headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(30000) });
    requireThat(response.ok, `AL PR read returned HTTP ${response.status}`,
      [401, 403].includes(response.status) ? 'blocked-auth' : 'blocked-pr');
    requireThat(!response.headers.get('x-ms-continuationtoken'),
      'AL PR policy response is incomplete; reconcile pagination explicitly', 'partial');
    return response.json();
  };
  const prPath = `git/repositories/${encodeURIComponent(repo.pr.repositoryId)}/pullrequests/${id}?api-version=7.1`;
  const pr = await request(prPath);
  requireThat(pr.pullRequestId === id && pr.repository?.id === repo.pr.repositoryId &&
    pr.targetRefName === repo.pr.targetRef, 'ADO returned a different PR identity/target', 'blocked-reconciliation');
  const common = { format: 'al-draft-observation-v1', observedAt: now(), expected,
    currentHead: pr.lastMergeSourceCommit?.commitId, status: pr.status, isDraft: pr.isDraft,
    readOnly: true, mergeOrQueuePerformed: false };
  if (pr.status !== 'active' || pr.isDraft !== true)
    return { ...common, state: 'operator-lifecycle-change', readCalls };
  if (pr.lastMergeSourceCommit?.commitId !== expected.headRevision)
    return { ...common, state: 'head-changed-revalidation-required', readCalls };
  const project = pr.repository.project?.id, mergeRevision = pr.lastMergeCommit?.commitId;
  requireThat(/^[a-f0-9-]{36}$/i.test(project ?? '') && /^[a-f0-9]{40}$/.test(mergeRevision ?? ''),
    'Current PR project/merge context is unavailable', 'blocked-reconciliation');
  const artifact = `vstfs:///CodeReview/CodeReviewId/${project}/${id}`;
  const evaluations = await request(`policy/evaluations?artifactId=${encodeURIComponent(artifact)}&api-version=7.1-preview.1`);
  requireThat(Array.isArray(evaluations.value) &&
    (evaluations.count === undefined || evaluations.count === evaluations.value.length),
  'Incomplete PR policy evaluations', 'blocked-reconciliation');
  const required = evaluations.value.filter(value => value.configuration?.isBlocking === true &&
    value.configuration.isEnabled !== false);
  requireThat(required.length > 0, 'No required policies found; do not infer CI success', 'blocked-reconciliation');
  const buildIds = [...new Set(required.map(value => value.context?.buildId).filter(value => value !== undefined))];
  requireThat(buildIds.length > 0 && buildIds.length <= maxPolicyBuilds &&
    buildIds.every(value => Number.isSafeInteger(value) && value > 0),
  'Required exact-merge build context is missing or exceeds the read budget', 'blocked-reconciliation');
  const builds = [];
  for (const buildId of buildIds) {
    const build = await request(`build/builds/${buildId}?api-version=7.1`);
    requireThat(build.id === buildId, 'ADO returned a different build identity', 'blocked-reconciliation');
    builds.push(build);
  }
  const after = await request(prPath);
  requireThat(after.lastMergeSourceCommit?.commitId === expected.headRevision &&
    after.lastMergeCommit?.commitId === mergeRevision && after.isDraft === true && after.status === 'active',
  'PR changed during lifecycle observation', 'blocked-reconciliation');
  const passed = required.every(value => value.status === 'approved') &&
    builds.every(build => buildIds.includes(build.id) && build.sourceVersion === mergeRevision &&
      build.sourceBranch === `refs/pull/${id}/merge` && build.status === 'completed' && build.result === 'succeeded');
  return { ...common, mergeRevision, state: passed ? 'draft-required-policies-approved' : 'draft-policy-work-pending',
    requiredPolicies: required, builds, readCalls,
    reviewInterface: 'AI/human findings still require operator review at this exact head; this observer never approves, queues, pushes or merges.' };
}

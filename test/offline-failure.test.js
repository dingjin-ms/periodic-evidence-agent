import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/offline-failure.yml', import.meta.url), 'utf8');
const script = workflow.split('          script: |')[1].replace(/^ {12}/gm, '');
const execute = new (Object.getPrototypeOf(async function () {}).constructor)(
  'github', 'context', 'core', script);

function fixture(overrides = {}) {
  const run = {
    id: 123, run_number: 10, run_attempt: 1, conclusion: 'failure',
    event: 'pull_request', head_branch: 'fixture', head_sha: 'a'.repeat(40),
    html_url: 'https://github.com/fixture/repository/actions/runs/123', ...overrides
  };
  const pull = {
    number: 7, state: 'open', head: { sha: run.head_sha },
    base: { ref: 'master', repo: { full_name: 'fixture/repository' } }
  };
  const data = { pulls: [pull], comments: [], issues: [] };
  const calls = [];
  const github = {
    rest: {
      repos: { listPullRequestsAssociatedWithCommit: 'pulls' },
      issues: {
        listComments: 'comments', listForRepo: 'issues',
        createComment: async request => calls.push(['comment', request]),
        create: async request => calls.push(['issue', request])
      }
    },
    paginate: async endpoint => data[endpoint]
  };
  return {
    run, pull, data, calls, github,
    execute: () => execute(github, {
      repo: { owner: 'fixture', repo: 'repository' }, payload: { workflow_run: run }
    }, { notice: message => calls.push(['notice', message]) })
  };
}

test('offline failure alerts the current master PR without reading checkout or logs', async () => {
  const f = fixture();
  await f.execute();
  assert.equal(f.calls.length, 1);
  const [kind, request] = f.calls[0];
  assert.equal(kind, 'comment');
  assert.equal(request.issue_number, 7);
  assert.match(request.body, /@dingjin-ms/);
  assert.ok(request.body.includes(f.run.head_sha));
  assert.ok(request.body.includes(f.run.html_url));
  assert.match(request.body, /Do not merge a failing or pending revision/);
});

test('offline failure skips stale, closed, foreign and non-master PRs', async () => {
  const f = fixture();
  f.data.pulls = [
    { ...f.pull, head: { sha: 'b'.repeat(40) } },
    { ...f.pull, state: 'closed' },
    { ...f.pull, base: { ...f.pull.base, ref: 'topic' } },
    { ...f.pull, base: { ref: 'master', repo: { full_name: 'other/repository' } } }
  ];
  await f.execute();
  assert.deepEqual(f.calls.map(([kind]) => kind), ['notice']);
});

test('offline failure deduplicates bot alerts but not user-supplied markers or new attempts', async () => {
  const f = fixture();
  const body = '<!-- offline-failure:123:1 -->';
  f.data.comments = [{ user: { login: 'contributor' }, body }];
  await f.execute();
  assert.equal(f.calls.length, 1);
  f.calls.length = 0;
  f.data.comments.push({ user: { login: 'github-actions[bot]' }, body });
  await f.execute();
  assert.equal(f.calls.length, 0);
  f.run.run_attempt = 2;
  await f.execute();
  assert.equal(f.calls.length, 1);
});

test('offline master failure opens an issue and deduplicates closed alerts', async () => {
  const f = fixture({ event: 'push', head_branch: 'master', conclusion: 'timed_out' });
  await f.execute();
  assert.equal(f.calls.length, 1);
  const [kind, request] = f.calls[0];
  assert.equal(kind, 'issue');
  assert.match(request.title, /master offline checks failed/);
  assert.match(request.body, /Hold further merges/);
  f.calls.length = 0;
  f.data.issues = [{ body: request.body, state: 'closed' }];
  await f.execute();
  assert.equal(f.calls.length, 0);
});

test('offline notification ignores successful, cancelled and non-master push runs', async () => {
  for (const overrides of [
    { conclusion: 'success' }, { conclusion: 'cancelled' },
    { event: 'push', head_branch: 'topic' }, { event: 'workflow_dispatch' }
  ]) {
    const f = fixture(overrides);
    f.github.paginate = async () => assert.fail('Unrelated runs must not read or write notification data');
    await f.execute();
    assert.equal(f.calls.length, 0);
  }
});

test('offline notification surfaces API failures instead of reporting delivery', async () => {
  const f = fixture();
  f.github.rest.issues.createComment = async () => { throw new Error('fixture permission denied'); };
  await assert.rejects(f.execute(), /fixture permission denied/);
  assert.equal(f.calls.length, 0);
});

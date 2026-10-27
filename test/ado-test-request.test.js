import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Ledger } from '../src/ledger.js';
import { configAt } from '../src/common.js';
import { adoRecord, wiql } from '../src/sources.js';
import { savedTestRequestLink, testRequestLink, testRequestRows } from '../src/ado-request-link.js';
import { parseTestRequest, collectTestRequest, testRequestPolicy, readTestRequest, listTestRequests } from '../src/ado-test-request.js';

const sample = readFileSync(new URL('../scaffold/ado-test-request.sample.md', import.meta.url), 'utf8');
const policy = JSON.parse(readFileSync(new URL('../scaffold/ado-test-request.policy.example.json', import.meta.url)));
test('saved template link references its owning team without putting rich text in the URL', () => {
  const template = JSON.parse(readFileSync(new URL('../scaffold/ado-test-request.template-ref.json', import.meta.url)));
  const url = new URL(savedTestRequestLink(template));
  assert.equal(url.pathname, '/office/OC/_workitems/create/Bug');
  assert.deepEqual([...url.searchParams.keys()], ['templateId', 'ownerId']);
  assert.equal(url.searchParams.get('templateId'), template.templateId);
  assert.equal(url.searchParams.get('ownerId'), template.teamId);
  assert.ok(url.href.length < 200);
  assert.throws(() => savedTestRequestLink({ ...template, templateId: 'not-a-template' }), /real template/);
  const generated = spawnSync(process.execPath, ['scripts/create-ado-request-link.mjs'], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  assert.equal(generated.stdout.trim(), url.href);
});

test('creation link includes all five fields without HTML or lost area separators', () => {
  const url = new URL(testRequestLink(policy));
  assert.equal(url.origin, 'https://dev.azure.com');
  assert.equal(url.pathname, '/office/OC/_workitems/create/Bug');
  assert.equal(url.searchParams.get('[System.AreaPath]'), policy.areaPath);
  assert.equal(url.searchParams.get('[System.Tags]'), policy.tag);
  assert.ok(url.href.length < 2000);
  const description = url.searchParams.get('[System.Description]');
  assert.doesNotMatch(description, /[<>]/);
  assert.deepEqual(parseTestRequest(description).missing, testRequestRows.map(([label]) => label));
  assert.throws(() => testRequestLink({ ...policy, areaPath: 'x'.repeat(2000) }), /sharing length/);
});

test('ADO rich-text wrappers preserve a filled plain-text template', () => {
  const url = new URL(testRequestLink(policy));
  const description = url.searchParams.get('[System.Description]')
    .replace(/\[[^\]]+\]/g, 'Filled example');
  const richText = description.split('\n').map(line => `<div>${line}</div>`).join('');
  assert.deepEqual(parseTestRequest(richText), parseTestRequest(description));
  assert.equal(parseTestRequest(richText).missing.length, 0);
});

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'test-request-'));
  const ledger = new Ledger(root);
  const config = configAt('pilot.example.json');
  config.stateDirectory = root;
  config.statePolicy.accessApproved = true;
  config.adoTestRequests = { ...policy, enabled: true, scopeApproved: true, approvalRef: 'synthetic-test-approval' };
  const item = { id: 123, rev: 1, snapshotAt: '2026-10-01T00:00:00Z', fields: {
    'System.TeamProject': 'OC', 'System.AreaPath': policy.areaPath,
    'System.WorkItemType': 'Bug', 'System.State': 'New', 'System.Tags': policy.tag,
    'System.Title': 'Synthetic formula preservation request', 'System.CreatedDate': '2026-10-01T00:00:00Z',
    'System.Description': sample
  } };
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  return { config, ledger, item };
}

test('queue discovery is independently approved, scoped and fails closed on overflow', async t => {
  const { config } = setup(t);
  await assert.rejects(listTestRequests(config), /bounded approval/);
  config.adoTestRequests.automation = { queue: { enabled: true, scopeApproved: true, approvalRef: 'fixture', maxItems: 2 } };
  let requests = 0;
  const transport = workItems => ({ getToken: async () => 'fixture', fetchResponse: async (url, options) => {
    requests++; assert.match(url, /\$top=3/); assert.equal(options.redirect, 'error');
    const query = JSON.parse(options.body).query;
    assert.match(query, /Automation/); assert.match(query, /AgenticTestRequest/); assert.match(query, /ORDER BY \[System.Id\] ASC/);
    return Response.json({ asOf: '2026-10-01T00:00:00Z', workItems });
  } });
  assert.deepEqual((await listTestRequests(config, transport([{ id: 1 }, { id: 2 }]))).ids, [1, 2]);
  await assert.rejects(listTestRequests(config, transport([{ id: 1 }, { id: 2 }, { id: 3 }])), /exceeds its bound/);
  await assert.rejects(listTestRequests(config, transport([{ id: 1 }, { id: 1 }])), /malformed/);
  assert.equal(requests, 3);
});

test('transport queries approved scope before details and pins the batch snapshot', async t => {
  const { config, item } = setup(t);
  const calls = [];
  const result = await readTestRequest(config, 123, {
    getToken: async () => 'fixture-token',
    fetchResponse: async (url, options) => {
      calls.push({ url, options });
      assert.equal(options.redirect, 'error');
      assert.equal(options.method, 'POST');
      const body = JSON.parse(options.body);
      if (calls.length === 1) {
        assert.match(body.query, /System.AreaPath.*Automation/);
        assert.match(body.query, /System.Id.*123/);
        assert.match(body.query, /AgenticTestRequest/);
        return Response.json({ asOf: '2026-10-01T00:00:00Z', workItems: [{ id: 123 }] });
      }
      assert.deepEqual(body.ids, [123]);
      assert.equal(body.asOf, '2026-10-01T00:00:00Z');
      assert.equal(body.errorPolicy, 'Fail');
      return Response.json({ value: [item] });
    }
  });
  assert.equal(calls.length, 2);
  assert.equal(result.id, 123);
});

test('transport never fetches unmatched details or follows redirects and enforces response bound', async t => {
  const { config } = setup(t);
  for (const mode of ['unmatched', 'redirect', 'oversize', 'auth']) {
    let calls = 0;
    await assert.rejects(readTestRequest(config, 123, {
      getToken: async () => 'fixture-token',
      fetchResponse: async () => {
        calls++;
        if (mode === 'redirect') return new Response('', { status: 302 });
        if (mode === 'auth') return new Response('', { status: 403 });
        if (mode === 'oversize') return new Response('x'.repeat(262145));
        return Response.json({ asOf: '2026-10-01T00:00:00Z', workItems: [] });
      }
    }));
    assert.equal(calls, 1);
  }
});

test('five-field sample preserves user language and explicit synthetic-input permission', () => {
  const request = parseTestRequest(sample);
  assert.deepEqual(request.missing, []);
  assert.match(request.fields.inputFiles, /Agent may create synthetic inputs/);
  assert.match(request.fields.expectedResult, /remains a formula/);
  const template = readFileSync(new URL('../scaffold/ado-test-request.template.md', import.meta.url), 'utf8');
  assert.equal(parseTestRequest(template).missing.length, 5);
});

test('ADO rich HTML supports headings, entities, lists and links without executing markup', () => {
  const html = '<table><tr><th>Field</th><th>Value</th></tr>' + [
    ['Starting context', '<p>Standard starting state</p>'],
    ['Input files / data', '<a href="https://example.invalid/input">Input</a> &amp; synthetic data'],
    ['Steps / prompts', '<ol><li>First turn</li><li>Confirm &quot;Yes&quot;</li></ol>'],
    ['Expected result', '<b>A &lt; B</b><script>hidden()</script>'],
    ['Constraints / special rules', 'None']
  ].map(([key, value]) => `<tr><td><strong>${key}</strong></td><td>${value}</td></tr>`).join('') + '</table>';
  const parsed = parseTestRequest(html);
  assert.deepEqual(parsed.missing, []);
  assert.equal(parsed.fields.expectedResult, 'A < B');
  assert.match(parsed.fields.steps, /First turn\nConfirm "Yes"/);
  assert.match(parsed.fields.inputFiles, /https:\/\/example.invalid\/input/);
  assert.equal(parsed.fields.constraints, 'None');
});

test('duplicate and ambiguous rows fail closed, incomplete input reports field names', () => {
  assert.throws(() => parseTestRequest(sample + '\n| Starting context | duplicate |'), /duplicate/);
  assert.throws(() => parseTestRequest(sample.replace('Standard starting state:', 'A | B:')), /ambiguous/);
  const incomplete = parseTestRequest('| Starting context | Standard starting state |\n| Constraints / special rules | None |');
  assert.equal(incomplete.missing.length, 3);
  assert.throws(() => parseTestRequest('x'.repeat(262145)), /size bound/);
});

test('intake is opt-in independently of the existing ADO collector', async t => {
  const { config, ledger } = setup(t);
  let reads = 0;
  config.adoTestRequests.enabled = false;
  await assert.rejects(collectTestRequest(config, ledger, 123, { read: () => { reads++; } }), /approved policy/);
  assert.equal(reads, 0);
  assert.equal(ledger.all('evidence').length, 0);
});

for (const [field, value] of [
  ['System.TeamProject', 'Other'], ['System.AreaPath', policy.areaPath + 'Other'],
  ['System.WorkItemType', 'Task'], ['System.State', 'Closed'], ['System.Tags', policy.tag + 'Other']
]) test(`intake rejects out-of-scope ${field} without persisting`, async t => {
  const { config, ledger, item } = setup(t);
  item.fields[field] = value;
  await assert.rejects(collectTestRequest(config, ledger, 123, { read: async () => item }), /approved test-request/);
  assert.equal(ledger.all('evidence').length, 0);
  assert.equal(ledger.status().operations.length, 0);
});

test('unchanged request replays once and changed source or policy cannot rewrite it', async t => {
  const { config, ledger, item } = setup(t);
  const read = async () => item;
  const first = await collectTestRequest(config, ledger, 123, { read });
  assert.equal(first.state, 'needs-review');
  assert.deepEqual(await collectTestRequest(config, ledger, 123, { read }), first);
  assert.equal(ledger.all('evidence').length, 1);
  assert.equal(ledger.status().jobs.length, 0);
  item.fields['System.Description'] += '\nchanged';
  await assert.rejects(collectTestRequest(config, ledger, 123, { read }), /immutable source/);
  item.fields['System.Description'] = sample;
  config.adoTestRequests.approvalRef = 'changed-policy';
  await assert.rejects(collectTestRequest(config, ledger, 123, { read }), /policy/);
});

test('revisions advance numerically and stale delivery is rejected', async t => {
  const { config, ledger, item } = setup(t);
  const read = async () => item;
  item.rev = 9;
  await collectTestRequest(config, ledger, 123, { read });
  item.rev = 10;
  await collectTestRequest(config, ledger, 123, { read });
  assert.equal(ledger.latestEvidence()[0].source.revision, '10');
  item.rev = 9;
  await assert.rejects(collectTestRequest(config, ledger, 123, { read }), /stale/);
});

test('incomplete request remains needs-information without creating an assignment', async t => {
  const { config, ledger, item } = setup(t);
  delete item.fields['System.Description'];
  const result = await collectTestRequest(config, ledger, 123, { read: async () => item });
  assert.equal(result.state, 'needs-information');
  assert.equal(result.request.missing.length, 5);
  assert.equal(ledger.status().jobs.length, 0);
});

test('malformed identity, oversized response and unsafe policy fail closed', async t => {
  const { config, ledger, item } = setup(t);
  item.id++;
  await assert.rejects(collectTestRequest(config, ledger, 123, { read: async () => item }), /identity/);
  item.id--;
  item.fields['System.Description'] = 'x'.repeat(262145);
  await assert.rejects(collectTestRequest(config, ledger, 123, { read: async () => item }), /bound/);
  config.adoTestRequests.organization = 'office/Other';
  assert.throws(() => testRequestPolicy(config), /organization/);
});

test('existing resolved-bug collector is unchanged and rejects new requests', t => {
  const { item } = setup(t);
  assert.throws(() => adoRecord(item, 'query', '2026-10-01T00:00:00Z'), /Resolved or Closed/);
  const query = wiql({ start: '2026-10-01T00:00:00Z', end: '2026-10-02T00:00:00Z' });
  assert.match(query, /'Resolved', 'Closed'/);
  assert.match(query, /'Fixed', 'Duplicate'/);
  assert.doesNotMatch(query, /AgenticTestRequest/);
});

test('feedback CLI rejects local state denial before opening or pruning a ledger', t => {
  const root = mkdtempSync(join(tmpdir(), 'feedback-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = configAt('pilot.example.json');
  config.stateDirectory = join(root, 'must-not-exist');
  config.statePolicy.accessApproved = false;
  const path = join(root, 'config.json');
  writeFileSync(path, JSON.stringify(config));
  for (const args of [
    ['comment-test-request', '--assessment', 'missing', '--authorize-comment'],
    ['reconcile-test-request-comment', '--file', 'missing.json', '--authorize-reconciliation']
  ]) {
    const output = spawnSync(process.execPath, ['src/cli.js', ...args, '--config', path], { encoding: 'utf8' });
    assert.notEqual(output.status, 0);
    assert.match(output.stderr + output.stdout, /approved local state/);
    assert.equal(existsSync(config.stateDirectory), false);
  }
});

test('CLI refuses implicit reads, unknown flags and missing execution choice', () => {
  for (const args of [
    ['ado-test-request', '--id', '123', '--config', 'pilot.example.json'],
    ['ado-test-request', '--id', '123', '--collect', '--config', 'pilot.example.json', '--surprise'],
    ['submit-test-request', '--file', 'missing.json', '--config', 'pilot.example.json'],
    ['assess-test-request', '--file', 'missing.json'],
    ['comment-test-request', '--assessment', 'missing', '--config', 'pilot.example.json'],
    ['comment-test-request', '--assessment', 'missing', '--authorize-comment', '--config', 'pilot.example.json', '--surprise']
  ]) {
    const output = spawnSync(process.execPath, ['src/cli.js', ...args], { encoding: 'utf8' });
    assert.notEqual(output.status, 0);
    assert.match(output.stderr + output.stdout, /test-request|Test-request/);
  }
});

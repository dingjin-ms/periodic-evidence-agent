import test from 'node:test';
import assert from 'node:assert/strict';
import { requiredSourceGroups } from '../src/loop-local-filter.js';
test('required grouping closes versions, threads and links transitively and deterministically', () => {
  const record = (id, recordId, thread, links = []) => ({ id, url: 'https://example.invalid/' + id,
    source: { kind: 'workiq', namespace: 'channel', recordId }, fields: thread ? { thread } : {}, links });
  const thread = { teamId: 't', channelId: 'c', rootId: 'r' };
  const rows = [record('a', 'one', thread), record('b', 'two', thread),
    record('c', 'two'), record('d', 'three', null, [{ url: 'https://example.invalid/c' }]), record('e', 'four')];
  const groups = requiredSourceGroups(rows);
  assert.deepEqual(groups.map(g => g.memberIds).sort(), [['a', 'b', 'c', 'd'], ['e']]);
  assert.deepEqual(requiredSourceGroups([...rows].reverse()), groups);
  assert.deepEqual(requiredSourceGroups([]), []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { countO200k } from '../src/o200k-counter.js';

const ranks = new Map(Array.from({ length: 256 }, (_, i) => [String.fromCharCode(i), i]));
for (const [i, word] of ['ab', 'ba', 'aa', 'bb', 'aba', 'bab', 'aab', 'bba', 'abab', 'baba', 'aaaa'].entries())
  ranks.set(word, 256 + i);
function reference(text) {
  if (ranks.has(text)) return 1;
  const parts = [...text];
  while (parts.length > 1) {
    let best = -1, rank = Infinity;
    for (let i = 0; i + 1 < parts.length; i++) {
      const r = ranks.get(parts[i] + parts[i + 1]) ?? Infinity;
      if (r < rank) { rank = r; best = i; }
    }
    if (best < 0) break;
    parts.splice(best, 2, parts[best] + parts[best + 1]);
  }
  return parts.length;
}
test('heap BPE matches independent leftmost-lowest-rank reference across randomized inputs', () => {
  let seed = 17;
  for (let i = 0; i < 1000; i++) {
    let word = '';
    for (let j = 0; j < 1 + i % 127; j++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; word += seed & 256 ? 'a' : 'b'; }
    assert.equal(countO200k(word, ranks, 4), reference(word));
  }
});
test('tokenizer covers Unicode whitespace and text exactly and rejects malformed inputs', () => {
  const bytesOnly = new Map(Array.from({ length: 256 }, (_, i) => [String.fromCharCode(i), i]));
  for (const text of ['', 'hello world', '中🙂\u0085\uFEFF', "I'm WE'RE", '123456\r\n'])
    assert.equal(countO200k(text, bytesOnly, 1), Buffer.byteLength(text));
  assert.throws(() => countO200k('\uD800', bytesOnly, 1), /well-formed/);
  assert.throws(() => countO200k('a'.repeat(1048577), bytesOnly, 1), /1 MiB/);
});

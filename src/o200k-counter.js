import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// o200k_base pre-tokenization pattern and vocabulary identity from OpenAI tiktoken.
// MIT notice: scaffold/TIKTOKEN-LICENSE.txt. BPE implementation below is local JS.
export const o200kVocabularySha256 = '446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d';
const pattern = /[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]*[\p{Ll}\p{Lm}\p{Lo}\p{M}]+(?i:'s|'t|'re|'ve|'m|'ll|'d)?|[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]+[\p{Ll}\p{Lm}\p{Lo}\p{M}]*(?i:'s|'t|'re|'ve|'m|'ll|'d)?|\p{N}{1,3}| ?[^\p{White_Space}\p{L}\p{N}]+[\r\n\/]*|\p{White_Space}*[\r\n]+|\p{White_Space}+(?![^\p{White_Space}])|\p{White_Space}+/gu;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function loadO200k(path) {
  const bytes = readFileSync(path);
  if (hash(bytes) !== o200kVocabularySha256) throw new Error('o200k_base vocabulary checksum mismatch');
  const ranks = new Map();
  let maxBytes = 0;
  for (const line of bytes.toString('ascii').trim().split(/\r?\n/)) {
    const [encoded, rank] = line.split(' '), token = Buffer.from(encoded, 'base64');
    ranks.set(token.toString('latin1'), Number(rank)); maxBytes = Math.max(maxBytes, token.length);
  }
  return text => countO200k(text, ranks, maxBytes);
}
function countPiece(bytes, ranks, maxBytes) {
  if (!bytes.length) return 0;
  if (bytes.length <= maxBytes && ranks.has(bytes.toString('latin1'))) return 1;
  const nodes = Array.from(bytes, (_byte, index) => ({ start: index, end: index + 1,
    prev: index - 1, next: index + 1 < bytes.length ? index + 1 : -1, version: 0, live: true }));
  const heap = [];
  const less = (a, b) => a.rank < b.rank || a.rank === b.rank && a.left < b.left;
  const push = entry => {
    heap.push(entry);
    for (let i = heap.length - 1; i > 0;) {
      const parent = (i - 1) >> 1;
      if (!less(heap[i], heap[parent])) break;
      [heap[i], heap[parent]] = [heap[parent], heap[i]]; i = parent;
    }
  };
  const pop = () => {
    const first = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) {
        const left = i * 2 + 1, right = left + 1;
        if (left >= heap.length) break;
        const best = right < heap.length && less(heap[right], heap[left]) ? right : left;
        if (!less(heap[best], heap[i])) break;
        [heap[i], heap[best]] = [heap[best], heap[i]]; i = best;
      }
    }
    return first;
  };
  const pair = left => {
    if (left < 0) return;
    const a = nodes[left], right = a.next;
    if (!a.live || right < 0) return;
    const b = nodes[right];
    if (b.end - a.start > maxBytes) return;
    const rank = ranks.get(bytes.subarray(a.start, b.end).toString('latin1'));
    if (rank !== undefined) push({ left, right, a: a.version, b: b.version, rank });
  };
  for (let i = 0; i < nodes.length; i++) pair(i);
  let count = nodes.length;
  while (heap.length) {
    const p = pop(), a = nodes[p.left], b = nodes[p.right];
    if (!a.live || !b.live || a.next !== p.right || a.version !== p.a || b.version !== p.b) continue;
    a.end = b.end; a.next = b.next; a.version++; b.live = false; count--;
    if (b.next >= 0) nodes[b.next].prev = p.left;
    pair(a.prev); pair(p.left);
  }
  return count;
}
export function countO200k(text, ranks, maxBytes) {
  if (typeof text !== 'string' || !text.isWellFormed() || Buffer.byteLength(text) > 1048576)
    throw new Error('Tokenizer requires well-formed text within 1 MiB');
  let count = 0, length = 0;
  for (const match of text.matchAll(pattern)) {
    length += match[0].length;
    count += countPiece(Buffer.from(match[0]), ranks, maxBytes);
  }
  if (length !== text.length) throw new Error('Tokenizer did not cover the complete input');
  return count;
}

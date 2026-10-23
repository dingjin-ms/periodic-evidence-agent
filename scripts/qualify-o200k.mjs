import assert from 'node:assert/strict';
import { loadO200k, o200kVocabularySha256 } from '../src/o200k-counter.js';
const count = loadO200k(process.argv[2]);
const vectors = [['hello world', 2], ['antidisestablishmentarianism', 6], ['2 + 2 = 4', 7], ['お誕生日おめでとう', 8]];
for (const [text, expected] of vectors) assert.equal(count(text), expected, text);
console.log(JSON.stringify({ tokenizer: 'o200k_base', vocabularySha256: o200kVocabularySha256,
  vectorsPassed: vectors.length, modelInvoked: false,
  scope: 'Ordinary text tokenization; transport/system/tool overhead must be reserved separately' }, null, 2));

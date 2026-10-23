import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadO200k } from '../src/o200k-counter.js';
const input = JSON.parse(readFileSync(0, 'utf8'));
const sha256 = createHash('sha256').update(input.text).digest('hex');
if (input.tokenizer !== 'o200k_base' || input.sha256 !== sha256 || !input.model)
  throw new Error('Tokenizer request pins mismatch');
const count = loadO200k(process.argv[2]);
process.stdout.write(JSON.stringify({ sha256, model: input.model, tokenizer: input.tokenizer, tokens: count(input.text) }));

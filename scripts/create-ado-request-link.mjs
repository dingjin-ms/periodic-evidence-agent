import { readFileSync } from 'node:fs';
import { savedTestRequestLink } from '../src/ado-request-link.js';

const template = JSON.parse(readFileSync(
  new URL('../scaffold/ado-test-request.template-ref.json', import.meta.url), 'utf8'));
console.log(savedTestRequestLink(template));

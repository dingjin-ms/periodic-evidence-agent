import { readFileSync } from 'node:fs';
import { testRequestLink } from '../src/ado-request-link.js';

const policy = JSON.parse(readFileSync(
  new URL('../scaffold/ado-test-request.policy.example.json', import.meta.url), 'utf8'));
console.log(testRequestLink(policy));

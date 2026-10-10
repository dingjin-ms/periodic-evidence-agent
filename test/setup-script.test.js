import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSetupPlan } from '../scripts/setup.mjs';

test('one-click setup installs, initializes repositories, diagnoses, checks and demos', () => {
  const plan = buildSetupPlan(['--repo', 'office-agent', '--allow-clone']);
  assert.deepEqual(plan.steps.map(step => step.label), [
    'Installing locked dependencies',
    'Setting up repository checkouts and skills',
    'Checking local configuration',
    'Running the complete offline check',
    'Running the synthetic demo'
  ]);
  assert.deepEqual(plan.repositoryArgs, [
    '--config', 'pilot.local.json', '--repo', 'office-agent', '--allow-clone'
  ]);
  assert.equal(plan.steps[1].args.includes('office-agent'), true);
  assert.equal(plan.steps[1].args.includes('--allow-clone'), true);
});

test('setup supports a fast repository-only diagnostic rerun without hard-coded repos', () => {
  const plan = buildSetupPlan([
    '--skip-install', '--skip-checks', '--repo', 'omr', '--config', 'dev.local.json'
  ]);
  assert.deepEqual(plan.repositoryArgs,
    ['--repo', 'omr', '--config', 'dev.local.json']);
  assert.deepEqual(plan.steps.map(step => step.kind), ['node', 'node']);
  assert.deepEqual(plan.steps[0].args,
    ['src/cli.js', 'setup', '--repo', 'omr', '--config', 'dev.local.json']);
  assert.deepEqual(plan.steps[1].args,
    ['src/cli.js', 'doctor', '--config', 'dev.local.json']);
});

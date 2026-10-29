import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { boundedPath, hash, json, requireThat, safeError } from './common.js';
import { agentInvocation, describeAgent } from './agents.js';

const roles = ['collector', 'filter', 'proposer'];
const operations = new Set(['app-begin', 'app-append', 'app-unavailable', 'app-block', 'app-status',
  'app-review', 'app-plan-improvement', 'app-worker', 'app-end', 'filter-batches',
  'filter-batch-check', 'filter-consolidate', 'filter-execution-check',
  'submit-filter-handoff', 'submit-reviewed-handoff']);
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value);
const queryRunner = `
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const { path, query } = JSON.parse(readFileSync(0, 'utf8'));
const db = new DatabaseSync(path, { readOnly: true });
try { process.stdout.write(JSON.stringify(db.prepare(query).all())); }
finally { db.close(); }
`;
function shape(value, allowed, required = allowed) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key)),
  'Invalid app flow plan shape', 'invalid-record');
}
function predicate(value, steps) {
  shape(value, ['id', 'step', 'pointer', 'equals', 'ledger'], ['step', 'pointer', 'equals']);
  requireThat(steps.some(step => step.id === value.step) &&
    typeof value.pointer === 'string' && value.pointer.startsWith('/'),
  'Flow assertion must bind a declared step and JSON pointer', 'invalid-record');
  if (value.ledger) {
    shape(value.ledger, ['path', 'query']);
    requireThat(typeof value.ledger.path === 'string' && !isAbsolute(value.ledger.path) &&
      !value.ledger.path.split(/[\\/]/).includes('..') &&
      typeof value.ledger.query === 'string' && value.ledger.query.length <= 8000 &&
      /^SELECT\s/i.test(value.ledger.query) &&
      !value.ledger.query.includes(';'),
    'Flow ledger assertions require a bounded relative path and one read-only SELECT', 'invalid-record');
  }
}
export function readAppFlowPlan(profile) {
  const file = profile.flowPlan;
  requireThat(isAbsolute(file.path), 'App flow plan requires an absolute pinned path', 'blocked-scope');
  const info = lstatSync(file.path);
  requireThat(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 1048576 &&
    hash(readFileSync(file.path)) === file.sha256, 'App flow plan changed', 'blocked-reconciliation');
  const plan = JSON.parse(readFileSync(file.path, 'utf8'));
  shape(plan, ['format', 'cases']);
  requireThat(plan.format === 'rsi-app-role-flow-plan-v1' && Array.isArray(plan.cases) &&
    json(plan.cases.map(item => item.id)) === json(profile.cases.map(item => item.id)),
  'App flow plan must retain the exact ordered case inventory', 'invalid-record');
  for (const [index, selected] of plan.cases.entries()) {
    shape(selected, ['id', 'config', 'runId', 'production', 'steps', 'workStarted', 'assertions']);
    requireThat(identifier(selected.id) && identifier(selected.runId) &&
      typeof selected.production === 'boolean' && selected.config?.executionMode === 'app-native' &&
      selected.config.stateDirectory === '${state}' && !selected.config.rsi?.enabled &&
      Array.isArray(selected.steps) && selected.steps.length >= 3 && selected.steps.length <= 64,
    'App flow cases require isolated app-native state with recursive RSI disabled', 'invalid-record');
    requireThat(new Set(selected.steps.map(step => step.id)).size === selected.steps.length,
      'App flow steps must be unique', 'invalid-record');
    let previous = 0;
    for (const step of selected.steps) {
      shape(step, ['id', 'role', 'operation', 'options', 'input', 'hostInput'], ['id', 'role', 'operation']);
      const order = roles.indexOf(step.role);
      requireThat(identifier(step.id) && order >= previous && operations.has(step.operation),
        'App flow must use existing Collector/FILTER/Proposer entrypoints in order', 'blocked-scope');
      previous = order;
      agentInvocation(step.role, step.operation);
      requireThat(!step.options || (Array.isArray(step.options) && step.options.length <= 24 &&
        step.options.every(value => typeof value === 'string' && value.length < 1000) &&
        !step.options.some(value => ['--config', '--run', '--production', '--file'].includes(value))),
      'App flow owns its configuration, run, namespace and input flags', 'blocked-scope');
      requireThat(!(step.hostInput && Object.hasOwn(step, 'input')),
        'A step cannot replace a pinned input with host input', 'invalid-record');
      if (step.hostInput) {
        requireThat(step.role !== 'collector',
          'Comparison collection inputs must be pinned once, not recollected separately for each arm',
          'blocked-scope');
        shape(step.hostInput, ['instructions']);
        requireThat(typeof step.hostInput.instructions === 'string' && step.hostInput.instructions.length > 0 &&
          step.hostInput.instructions.length <= 8000, 'Host step needs bounded instructions', 'invalid-record');
      }
    }
    requireThat(selected.steps[0].operation === 'app-begin' &&
      selected.steps.at(-1).operation === 'app-end' &&
      roles.every(role => selected.steps.some(step => step.role === role)),
    'App flow must begin, traverse the existing roles and end explicitly', 'invalid-record');
    const begin = selected.steps[0].input;
    requireThat(begin?.dryRun === !selected.production &&
      [selected.runId, '${runId}'].includes(begin?.runId),
    'App flow begin input must match its pinned run and dry/production namespace', 'blocked-scope');
    predicate(selected.workStarted, selected.steps);
    requireThat(Array.isArray(selected.assertions) &&
      json(selected.assertions.map(item => item.id)) === json(profile.cases[index].assertions),
    'App flow assertions must match the pinned metric inventory', 'invalid-record');
    for (const assertion of selected.assertions) predicate(assertion, selected.steps);
    if (profile.cases[index].population !== 'guard') requireThat(selected.workStarted.ledger &&
      roles.every(role => selected.assertions.some(assertion => assertion.ledger &&
        selected.steps.find(step => step.id === assertion.step).role === role)),
    'Normal flow coverage needs durable ledger assertions for every role, not successful envelopes',
    'blocked-validation');
  }
  return plan;
}
function at(value, pointer) {
  for (const key of pointer.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return { known: false };
    value = value[key];
  }
  return { known: true, value };
}
function expand(value, paths) {
  if (typeof value === 'string') return value.replace(/\$\{(state|workspace|directory|runId)\}/g, (_, key) => paths[key]);
  if (Array.isArray(value)) return value.map(item => expand(item, paths));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item, paths)]));
  return value;
}
function evaluatePredicates(assertions, outputs, paths, admit, env) {
  let previous = null;
  return assertions.map(assertion => {
    if (!outputs.has(assertion.step)) { previous = null; return { known: false }; }
    let source = outputs.get(assertion.step);
    if (assertion.ledger) {
      const path = boundedPath(paths.directory, expand(assertion.ledger.path, paths));
      if (!existsSync(path)) { previous = null; return { known: false }; }
      const info = lstatSync(path);
      requireThat(info.isFile() && info.nlink === 1, 'Flow ledger is not a regular file', 'blocked-scope');
      const query = assertion.ledger.query;
      if (previous?.path === path && previous.query === query) source = previous.rows;
      else {
        previous = null;
        source = JSON.parse(execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning',
          '--input-type=module', '-e', queryRunner], {
          input: json({ path, query }), timeout: Math.min(admit(), 10000),
          maxBuffer: 1048576, windowsHide: true, encoding: 'utf8', env
        }));
        admit();
        // Reuse only immediately adjacent identical reads, never across another child.
        previous = { path, query, rows: source };
      }
    } else previous = null;
    const actual = at(source, assertion.pointer);
    return { known: actual.known, passed: actual.known && json(actual.value) === json(assertion.equals) };
  });
}
function roleResult(output, step) {
  let result;
  try { result = JSON.parse(output.stdout.trim() ? output.stdout : output.stderr); }
  catch { requireThat(false, 'App flow command has no structured role result; inspect its retained output',
    'blocked-result'); }
  requireThat(result?.format === 'agent-operation-result-v1' && result.role === step.role &&
    result.operation === step.operation && ['result', 'error'].includes(result.kind),
  'App flow returned the wrong role/operation envelope', 'blocked-result');
  requireThat(result.kind === 'error' || [0, 2].includes(output.exitCode),
    'App flow command failed outside its structured partial-result contract', 'blocked-result');
  return result;
}
export async function runAppRoleFlow(input, { admit, persist, hostInput, execute, ledger, retainRaw, readRaw }) {
  const { profile, workspace, revision, observationSha256, directory, phase, executionId, deadline, env } = input;
  const plan = readAppFlowPlan(profile);
  const cases = [], artifacts = [], diagnostics = [];
  for (const selected of plan.cases) {
    admit();
    const caseDirectory = join(directory, hash(selected.id).slice(0, 16));
    mkdirSync(caseDirectory, { recursive: true, mode: 0o700 });
    persist(join(caseDirectory, 'owner.json'), { executionId, phase, caseId: selected.id, revision });
    const paths = { directory: caseDirectory, state: join(caseDirectory, 'state'), workspace, runId: selected.runId };
    const configPath = persist(join(caseDirectory, 'flow-config.json'), expand(selected.config, paths)).ref;
    const outputs = new Map();
    let unknown = false, failed = false;
    for (const step of selected.steps) {
      if (failed && step.operation !== 'app-end') continue;
      admit();
      const key = hash(json([executionId, phase, selected.id, step.id]));
      const operationId = `rsi-app-flow:${key}`;
      const receiptFile = join(caseDirectory, `${step.id}.json`);
      const existing = ledger.db.prepare('SELECT state,detail FROM operations WHERE id=?').get(operationId);
      let result;
      if (existsSync(receiptFile)) {
        const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
        requireThat(existing?.state === 'completed' && JSON.parse(existing.detail).sha256 ===
          hash(readFileSync(receiptFile)) && receipt.revision === revision &&
          receipt.profileSha256 === hash(json(profile)) && receipt.observationSha256 === observationSha256,
        'App flow step receipt changed', 'blocked-reconciliation');
        result = roleResult(readRaw(receipt.artifact), step);
        artifacts.push(receipt.artifact);
      } else {
        requireThat(!existing, 'App flow step has an unknown prior effect; do not repeat it', 'blocked-reconciliation');
        let stepInput = step.input;
        const skill = describeAgent(step.role).skill;
        const skillPath = boundedPath(workspace, skill.path);
        if (step.hostInput) stepInput = await hostInput(`flow-${key.slice(0, 40)}`, {
          operation: 'continue-existing-flow-role', role: step.role,
          skill: { ...skill, path: skillPath, sha256: hash(readFileSync(skillPath)) }, workspace, revision,
          configPath, runId: selected.runId, production: selected.production,
          command: step.operation, instructions: step.hostInput.instructions,
          deadline, publicationAllowed: false,
          priorArtifacts: [...artifacts], resultContract: 'Existing role command input, never scores or success assertions',
          rawFlowInput: true
        });
        const args = ['--disable-warning=ExperimentalWarning', join(workspace, 'src', 'cli.js'),
          'agent', step.role, step.operation,
          '--config', configPath, ...expand(step.options ?? [], paths)];
        if (step.operation.startsWith('app-') && step.operation !== 'app-begin') {
          args.push('--run', selected.runId);
          if (selected.production) args.push('--production');
        }
        if (stepInput !== undefined) {
          const reference = retainRaw(`${key}-input`, expand(stepInput, paths));
          args.push('--file', reference.path);
        }
        const admittedMs = admit(), admittedAt = Date.now();
        ledger.operation(operationId, executionId, 'rsi-app-flow-step', {
          revision, profileSha256: hash(json(profile)), observationSha256, role: step.role, operation: step.operation
        });
        let output;
        try {
          const timeout = Math.min(deadline - Date.now(), admittedMs - (Date.now() - admittedAt));
          requireThat(timeout > 0, 'RSI app flow deadline expired', 'blocked-budget');
          output = { ...await execute(process.execPath, args, workspace, Math.ceil(timeout), env), exitCode: 0 };
        } catch (error) {
          if (typeof error.code !== 'number' || typeof error.stdout !== 'string' ||
            error.killed || error.signal) {
            let artifact = null, artifactError = null;
            try {
              artifact = retainRaw(`${key}-interrupted`, {
                stdout: error.stdout ?? null, stderr: error.stderr ?? null, error: safeError(error)
              });
            } catch (captureError) { artifactError = safeError(captureError); }
            ledger.finishOperation(operationId, 'unknown', {
              revision, profileSha256: hash(json(profile)), observationSha256,
              error: safeError(error), artifact, artifactError
            });
            throw error;
          }
          output = { stdout: error.stdout, stderr: error.stderr ?? '', exitCode: error.code };
        }
        const reference = retainRaw(`${key}-output`, output);
        const receipt = persist(receiptFile, {
          revision, profileSha256: hash(json(profile)), observationSha256,
          artifact: reference
        });
        ledger.finishOperation(operationId, 'completed', receipt);
        artifacts.push(reference);
        result = roleResult(output, step);
      }
      outputs.set(step.id, result);
      if (result.kind === 'error') failed = true;
    }
    let started, assertions;
    try {
      const [marker, ...values] = evaluatePredicates(
        [selected.workStarted, ...selected.assertions], outputs, paths, admit, env);
      started = marker.known && marker.passed;
      unknown = !marker.known;
      assertions = selected.assertions.map((assertion, index) => {
        const value = values[index];
        if (!started) return { id: assertion.id, state: unknown ? 'unknown' : 'not-run' };
        return { id: assertion.id, state: value.known ? value.passed ? 'passed' : 'failed' : 'unknown' };
      });
    } catch (error) {
      diagnostics.push({ caseId: selected.id, error: safeError(error) });
      unknown = true; started = false;
      assertions = selected.assertions.map(({ id }) => ({ id, state: 'unknown' }));
    }
    cases.push({ id: selected.id, started, assertions,
      outcome: unknown || assertions.some(item => item.state === 'unknown') ? 'unknown' :
        failed && profile.cases.find(item => item.id === selected.id).population !== 'guard' ? 'failed' :
        started && assertions.every(item => item.state === 'passed') ? 'passed' : 'failed' });
  }
  readAppFlowPlan(profile);
  return { format: 'rsi-e2e-observation-v1', revision, observationSha256,
    profileSha256: hash(json(profile)), result: { cases, violations: [] }, artifacts, diagnostics,
    scope: 'existing-app-role-entrypoints-and-durable-ledger-assertions' };
}

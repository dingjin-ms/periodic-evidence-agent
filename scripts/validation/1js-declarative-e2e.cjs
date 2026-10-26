const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');

const APP = 'ooui/apps/excel-agent-declarative-e2e';
const SCENARIOS = `${APP}/declarative/scenarios/`;
const REGISTRATION_FILES = [
  `${APP}/declarative/catalog/reviewed-cases.json`,
  `${APP}/lifecycle/catalog.json`,
  `${APP}/declarative/excel-agent-capability-matrix.json`,
  `${APP}/package.json`
];
const FORMAT = '1js-declarative-e2e-v1';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sorted = values => [...new Set(values)].sort();

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function inside(root, file) {
  check(typeof file === 'string' && file && !file.includes('\\') &&
    !file.includes(':') && !path.isAbsolute(file) &&
    file.split('/').every(part => part && part !== '.' && part !== '..'),
  `Unsafe repository path: ${file}`);
  const target = path.resolve(root, file);
  const realRoot = fs.realpathSync(root);
  const real = fs.realpathSync(target);
  const relative = path.relative(realRoot, real);
  check(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative), `Repository path escapes the workspace: ${file}`);
  check(fs.statSync(real).isFile(), `Expected a regular repository file: ${file}`);
  return target;
}

function git(root, args) {
  return execFileSync('git', ['--no-pager', '-c', 'core.longpaths=true', ...args], {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  }).trim();
}

function changedScenarios(files) {
  const declarations = files.filter(file =>
    file.startsWith(SCENARIOS) && /\.ya?ml$/.test(file));
  check(declarations.length > 0,
    'The assignment must explicitly add or update an L3 scenario; shared-only edits need a reviewed case selection.');
  return sorted(declarations);
}

function validateRequest(request) {
  check(request?.format === FORMAT && typeof request.assignmentId === 'string' &&
    request.assignmentId && /^[a-f0-9]{40,64}$/.test(request.baseRevision) &&
    /^[a-f0-9]{40,64}$/.test(request.sourceRevision) &&
    Array.isArray(request.evidenceIds) && request.evidenceIds.length > 0 &&
    request.evidenceIds.every(id => typeof id === 'string' && id) &&
    Array.isArray(request.inputItemIds) && request.inputItemIds.length > 0 &&
    request.inputItemIds.every(id => typeof id === 'string' && id) &&
    new Set(request.inputItemIds).size === request.inputItemIds.length &&
    Array.isArray(request.changedFiles) && request.changedFiles.length > 0 &&
    request.changedFiles.every(file => typeof file === 'string' && file) &&
    new Set(request.changedFiles).size === request.changedFiles.length,
  'A source-bound Controller assignment is required; arbitrary case selection is not supported.');
  check(request.options && Number.isInteger(request.options.maxCases) &&
    request.options.maxCases > 0 && request.options.maxCases <= 10,
  'A bounded maxCases between one and ten is required.');
  check(path.isAbsolute(request.options.yarnEntryPoint ?? '') &&
    /\.c?js$/.test(request.options.yarnEntryPoint),
  'Configure the installed Yarn/Corepack JavaScript entry point once for this repository.');
  check(request.options.commandTimeoutMs === undefined ||
    (Number.isSafeInteger(request.options.commandTimeoutMs) && request.options.commandTimeoutMs > 0),
  'The native command timeout must be a positive integer.');
  check(request.attemptId === undefined || /^[a-f0-9]{64}$/.test(request.attemptId),
    'The Controller attempt must be SHA-256 bound.');
  check(request.profileSha256 === undefined || /^[a-f0-9]{64}$/.test(request.profileSha256),
    'The Controller profile must be SHA-256 bound.');
  check(request.controllerTimeoutMs === undefined ||
    (Number.isSafeInteger(request.controllerTimeoutMs) && request.controllerTimeoutMs > 0),
  'The Controller timeout must be a positive integer.');
  const cdp = new URL(request.options.cdpEndpoint);
  check(cdp.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(cdp.hostname) &&
    !cdp.username && !cdp.password && !cdp.search && !cdp.hash && cdp.pathname === '/',
  'The local E2E requires an explicit loopback HTTP CDP endpoint.');
  return request;
}

function nativeUnitEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) =>
    !['XLO_OMNI_FLIGHT', 'XLO_SHARED_AGENT_SHELL_FLIGHT', 'EXCELAGENT_CDP_ENDPOINT',
      'EXCEL_AGENT_LOCAL_OUTPUT_ROOT'].includes(key.toUpperCase())));
}

function runYarn(root, request, args, cwd = root, environment = process.env) {
  check(fs.statSync(request.options.yarnEntryPoint).isFile(),
    'The configured Yarn/Corepack entry point is unavailable.');
  return execFileSync(process.execPath, [request.options.yarnEntryPoint, ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true, timeout: commandBudget(request),
    maxBuffer: 16 * 1024 * 1024,
    env: { ...environment, PATH: `${path.dirname(process.execPath)}${path.delimiter}${environment.PATH ?? environment.Path ?? ''}` }
  });
}

function nativeApi(root) {
  const app = path.join(root, APP);
  const appRequire = createRequire(path.join(app, 'package.json'));
  appRequire('ts-node').register({
    project: path.join(app, 'declarative', 'tsconfig.json'),
    transpileOnly: false
  });
  return {
    loader: appRequire(path.join(app, 'declarative', 'src', 'excelAgentDeclaration.ts')),
    catalog: appRequire(path.join(app, 'declarative', 'src', 'catalogParity.ts')),
    parseYaml: appRequire('yaml').parse,
    sanitizeDiagnosticText: appRequire('@1js/declarative-e2e-runtime').sanitizeDiagnosticText
  };
}

function loadNative(root, request) {
  try { return nativeApi(root); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND' || request.options.installDependencies !== true)
      throw error;
    console.log('Installing missing 1JS dependencies with the repository scoped installer.');
    runYarn(root, request, ['fast', '@1js/excel-agent-declarative-e2e', '--skip-auth'],
      path.join(root, 'ooui'));
    runYarn(root, request, ['lage', 'build', '--to', '@1js/excel-agent-declarative-e2e'],
      path.join(root, 'ooui'));
    return nativeApi(root);
  }
}

function assertAdditiveShared(before, after, kind) {
  const message = 'Shared edits change existing consumers; an explicitly reviewed consumer-closure handoff is required.';
  if (kind === 'composites') {
    const { composites: prior, ...original } = before;
    const { composites: current, ...updated } = after;
    assert.deepEqual(updated, original, message);
    check(Array.isArray(prior) && Array.isArray(current), message);
    assert.deepEqual(current.slice(0, prior.length), prior, message);
  } else if (kind === 'ui-map') {
    const { targets, scopes, ...original } = before;
    const { targets: nextTargets, scopes: nextScopes, ...updated } = after;
    assert.deepEqual(updated, original, message);
    for (const [prior, current] of [[targets, nextTargets], [scopes, nextScopes]]) {
      check(prior && current && !Array.isArray(prior) && !Array.isArray(current), message);
      for (const [key, value] of Object.entries(prior))
        assert.deepEqual(current[key], value, message);
    }
  } else {
    assert.deepEqual(after, before, message);
  }
}

function selectCases(root, request, api) {
  const shared = {
    [`${APP}/declarative/composites/excel-agent.yaml`]: 'composites',
    [`${APP}/declarative/ui-map.yaml`]: 'ui-map',
    [`${APP}/declarative/resources.yaml`]: 'resources'
  };
  for (const file of request.changedFiles.filter(file => Object.hasOwn(shared, file))) {
    const baseline = api.parseYaml(git(root, ['show', `${request.baseRevision}:${file}`]));
    const current = api.parseYaml(fs.readFileSync(inside(root, file), 'utf8'));
    assertAdditiveShared(baseline, current, shared[file]);
  }
  const files = changedScenarios(request.changedFiles);
  const config = api.loader.loadExcelAgentDeclarationConfig();
  const all = api.loader.loadExcelAgentScenarios(undefined, config);
  const selected = files.map(file => {
    const absolute = inside(root, file);
    const scenario = api.loader.loadExcelAgentScenario(absolute, config);
    check(scenario.metadata.account.lane === 'aad-enterprise',
      `Unsupported local identity lane for ${scenario.id}; no fallback is permitted.`);
    check(/^excel-agent\.aad\.[a-z0-9-]+$/.test(scenario.id),
      `Unsupported Excel Agent scenario identity: ${scenario.id}`);
    check(all.filter(item => item.id === scenario.id).length === 1 &&
      all.filter(item => item.name === scenario.name).length === 1,
    `Scenario identity or title is ambiguous: ${scenario.id}`);
    const entry = api.catalog.scenarioCatalogEntry(scenario);
    check(entry.assertions.length > 0 && scenario.cleanup?.length > 0 &&
      scenario.verification?.assertions?.some(item =>
        item.protected === true && item.provider !== 'account'),
    `Scenario ${scenario.id} needs protected business assertions and explicit cleanup.`);
    return { file, sha256: digest(fs.readFileSync(absolute)), scenario, entry };
  });
  check(selected.length <= request.options.maxCases,
    'The authored case batch exceeds its approved bound.');
  check(selected.length === request.inputItemIds.length,
    'Every reviewed input item must have exactly one explicitly selected authored scenario.');
  check(Array.isArray(request.testsAddedOrUpdated) &&
    JSON.stringify(sorted(request.testsAddedOrUpdated)) ===
      JSON.stringify(sorted(selected.map(item => item.scenario.id))),
  'The native scenario identities must exactly match the skill test report.');
  return selected;
}

function registrationUpdates(documents, selected, policy) {
  check(policy?.approved === true && ['P0', 'P1', 'P2'].includes(policy.priority),
    'Controller-owned registration requires an explicit repository policy approval.');
  const [catalog, lifecycle, matrix, pkg] = structuredClone(documents);
  check(catalog.schemaVersion === 1 && lifecycle.schemaVersion === 1 &&
    matrix.schemaVersion === 1 && Array.isArray(matrix.cases) &&
    catalog.packageName === '@1js/excel-agent-declarative-e2e' &&
    lifecycle.packageName === catalog.packageName &&
    Array.isArray(catalog.cases) && Array.isArray(lifecycle.cases),
  'Unsupported repository catalog/lifecycle schema; request an owner capability handoff.');
  assert.deepEqual(catalog, lifecycle,
    'Existing lifecycle/catalog drift must be resolved by its owner before registration.');
  let number = Math.max(0, ...[...catalog.cases, ...(catalog.disabledCases ?? [])]
    .map(item => item.number));
  check(Number.isInteger(number), 'Catalog case numbers are invalid.');
  for (const { scenario, entry } of selected) {
    check(!(catalog.disabledCases ?? []).some(item => item.semanticId === scenario.id),
      `Registration cannot re-enable disabled case ${scenario.id}.`);
    const prior = catalog.cases.find(item => item.semanticId === scenario.id);
    const command = `e2e:ci:${scenario.id.replaceAll('.', ':')}`;
    if (prior) {
      check(prior.title === scenario.name &&
        JSON.stringify(sorted(prior.tags)) === JSON.stringify(sorted(scenario.tags)),
      `Registration cannot rename or retag existing case ${scenario.id}.`);
    } else {
      check(scenario.tags.includes('omni-supported') &&
        scenario.tags.includes('omni-observing') &&
        !scenario.tags.includes('omni-blocking'),
      'New regression cases must be explicitly observing, not production-blocking.');
      const item = {
        number: ++number, semanticId: scenario.id, priority: policy.priority,
        topology: 'AAD', title: scenario.name, command,
        tags: scenario.tags, caseKey: scenario.id
      };
      catalog.cases.push(item);
      lifecycle.cases.push(structuredClone(item));
    }
    const nativeCommand = `cross-env EXCEL_AGENT_DECLARATIVE_SCENARIO=${scenario.id} yarn test:e2e`;
    check(!pkg.scripts[command] || pkg.scripts[command] === nativeCommand,
      `Existing per-case command is incompatible: ${command}`);
    pkg.scripts[command] = nativeCommand;
    const { tags, ...contract } = entry;
    const previous = matrix.cases.find(item => item.semanticId === scenario.id);
    if (previous) {
      for (const field of ['assertions', 'cleanup']) {
        check(previous[field].every(item =>
          contract[field].some(value => JSON.stringify(value) === JSON.stringify(item))),
        `Registration cannot remove or replace an existing ${field} contract for ${scenario.id}.`);
      }
      matrix.cases[matrix.cases.indexOf(previous)] = contract;
    } else {
      matrix.cases.push(contract);
    }
  }
  return [catalog, lifecycle, matrix, pkg];
}

function assertExecution(summary, selected, readAttachment) {
  check(summary?.status === 'passed' && Array.isArray(summary.cases) &&
    summary.cases.length === selected.length * 5,
  'Native runner did not produce exactly five passing attempts per selected case.');
  const counts = new Map(selected.map(item => [item.scenario.id, new Set()]));
  for (const result of summary.cases) {
    const selectedCase = selected.find(item =>
      result.title === item.scenario.name ||
      result.title.startsWith(`${item.scenario.name} @`));
    check(selectedCase && result.status === 'passed' &&
      result.expectedStatus === 'passed' && result.retry === 0 &&
      Number.isInteger(result.repeatEachIndex) &&
      result.repeatEachIndex >= 0 && result.repeatEachIndex < 5 &&
      Array.isArray(result.errors) && result.errors.length === 0 &&
      Array.isArray(result.diagnosticErrors) && result.diagnosticErrors.length === 0,
    'Native attempts must be expected passes, without skips, retries, errors or missing diagnostics.');
    const repeats = counts.get(selectedCase.scenario.id);
    check(!repeats.has(result.repeatEachIndex), 'Duplicate native repetition receipt.');
    repeats.add(result.repeatEachIndex);
    const attachments = result.attachments.filter(item =>
      item.name === 'local-declarative-execution-summary');
    check(attachments.length === 1, 'Exactly one native execution summary is required per attempt.');
    const execution = readAttachment(attachments[0].file);
    check(execution.format === 'local-declarative-execution-summary-v1' &&
      execution.scenarioId === selectedCase.scenario.id &&
      Array.isArray(execution.declarations) &&
      execution.declarations.some(item =>
        item.sha256 === selectedCase.sha256 &&
        item.path.replaceAll('\\', '/').endsWith(selectedCase.file.replace(`${APP}/`, ''))),
    'Native execution evidence does not match the authored scenario bytes.');
    check(Array.isArray(execution.events) &&
      !execution.events.some(event => ['failed', 'skipped'].includes(event.status)) &&
      execution.events.some(event => event.phase === 'scenario' && event.status === 'passed') &&
      execution.events.some(event =>
        event.phase === 'protected-contract' && event.status === 'passed') &&
      execution.events.some(event => event.phase === 'cleanup' && event.status === 'passed'),
    'Native execution must prove protected business assertions, scenario completion and cleanup.');
    for (const step of selectedCase.scenario.cleanup) {
      check(execution.events.some(event =>
        event.phase === 'cleanup' && event.status === 'passed' && event.stepId === step.id),
      `Missing cleanup receipt for ${step.id}.`);
    }
  }
  check([...counts.values()].every(repeats => repeats.size === 5),
    'Incomplete native repetition population.');
}

async function browserTargets(endpoint) {
  const response = await fetch(new URL('/json/list', endpoint), {
    signal: AbortSignal.timeout(10000)
  });
  check(response.ok, `CDP discovery failed: HTTP ${response.status}`);
  const targets = await response.json();
  check(Array.isArray(targets) && targets.every(item =>
    typeof item.id === 'string' && typeof item.type === 'string'),
  'Malformed CDP target inventory.');
  return targets.filter(item => item.type === 'page').map(item => ({ id: item.id, url: item.url }));
}

function assertBrowserCleanup(before, after) {
  assert.deepEqual(sorted(after.map(item => item.id)), sorted(before.map(item => item.id)),
    'Local E2E left new tabs open or closed a pre-existing tab; no automatic tab deletion is permitted.');
  for (const item of before) {
    check(after.find(other => other.id === item.id)?.url === item.url,
      'Local E2E navigated a pre-existing user tab.');
  }
}

const DIAGNOSTIC_LIMIT = 8192;
const SUMMARY_LIMIT = 4 * 1024 * 1024;
const commandBudget = request => request.options.commandTimeoutMs ?? 1800000;
const attemptBinding = request => ({
  attemptId: request.attemptId ?? digest(Buffer.from(request.outputRoot)),
  assignmentId: request.assignmentId, sourceRevision: request.sourceRevision,
  profileSha256: request.profileSha256 ?? null
});

function diagnosticError(error, stage, sanitize = () => '[diagnostic text omitted]') {
  const text = value => {
    const raw = String(value ?? '');
    const safe = sanitize(raw);
    return { text: safe.slice(0, DIAGNOSTIC_LIMIT), truncated: safe.length > DIAGNOSTIC_LIMIT,
      bytes: Buffer.byteLength(raw), sha256: digest(Buffer.from(raw)) };
  };
  return {
    stage, message: text(error.message),
    code: typeof error.code === 'number' ? error.code :
      /^(?:ETIMEDOUT|ENOENT|EACCES|EPERM|EIO|ENOSPC|ENOBUFS|ABORT_ERR|ERR_[A-Z_]+)$/.test(error.code ?? '')
        ? error.code : null,
    exitCode: Number.isInteger(error.status) ? error.status :
      Number.isInteger(error.code) ? error.code : null,
    signal: /^SIG[A-Z0-9]+$/.test(error.signal ?? '') ? error.signal : null,
    timeout: error.code === 'ETIMEDOUT',
    cancelled: error.code === 'ABORT_ERR' || error.name === 'AbortError',
    killed: error.killed === true, stdout: text(error.stdout), stderr: text(error.stderr)
  };
}

function interruptionType(error) {
  if (error.timeout) return 'timeout';
  if (error.cancelled) return 'cancelled';
  if (error.signal) return 'signal';
  return 'command-failure';
}

function writeDiagnostic(file, value, exclusive = true) {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  check(Buffer.byteLength(bytes) <= 1024 * 1024, 'Controller diagnostic exceeded its size bound.');
  fs.writeFileSync(file, bytes,
    { flag: exclusive ? 'wx' : 'w', mode: 0o600, flush: true });
}

function nativeProgress(outputRoot) {
  const result = { summaryRef: null, nativeStatus: null, completedRounds: [],
    lastCompletedRound: null, error: null };
  try {
    const directories = fs.readdirSync(outputRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory());
    check(directories.length === 1, 'Native batch is missing or ambiguous.');
    const file = path.join(outputRoot, directories[0].name, 'summary.json');
    const info = fs.lstatSync(file);
    check(info.isFile() && !info.isSymbolicLink() && info.size <= SUMMARY_LIMIT,
      'Native summary is not a bounded ordinary file.');
    const bytes = fs.readFileSync(file);
    check(bytes.length <= SUMMARY_LIMIT, 'Native summary exceeded its bound.');
    result.summaryRef = { path: file, sha256: digest(bytes), bytes: bytes.length };
    const summary = JSON.parse(bytes);
    check(Array.isArray(summary.cases) && summary.cases.length <= 50,
      'Native summary has an invalid case population.');
    result.nativeStatus = ['running', 'passed', 'failed', 'timedout', 'interrupted']
      .includes(summary.status) ? summary.status : null;
    result.completedRounds = summary.cases.filter(item =>
      ['passed', 'failed', 'timedOut', 'skipped'].includes(item.status) &&
      Number.isInteger(item.repeatEachIndex) && item.repeatEachIndex >= 0 &&
      item.repeatEachIndex < 5 && Number.isInteger(item.retry) && item.retry >= 0 &&
      typeof item.title === 'string').map(item => ({
      titleSha256: digest(Buffer.from(item.title)), repeatEachIndex: item.repeatEachIndex,
      retry: item.retry, status: item.status
    }));
    result.lastCompletedRound = result.completedRounds.at(-1) ?? null;
  } catch (error) {
    result.error = diagnosticError(error, 'native-summary');
  }
  return result;
}

function pageEvidence(pages) {
  check(Array.isArray(pages) && pages.length <= 256 && pages.every(item =>
    typeof item.id === 'string' && item.id.length <= 256 &&
    typeof item.url === 'string'), 'Browser inventory exceeded its diagnostic bound.');
  return pages.map(item => ({ id: item.id, urlSha256: digest(Buffer.from(item.url)) }));
}

function ownedPageEvidence(output, before, after) {
  const pages = [];
  for (const line of String(output ?? '').split(/\r?\n/)) {
    if (pages.length >= 50) break;
    if (!line.startsWith('[local-owned-page] ') || line.length > DIAGNOSTIC_LIMIT) continue;
    try {
      const item = JSON.parse(line.slice('[local-owned-page] '.length));
      if (typeof item.targetId !== 'string' || item.targetId.length > 256 ||
          typeof item.testTitle !== 'string') continue;
      pages.push({
        targetId: item.targetId, titleSha256: digest(Buffer.from(item.testTitle)),
        preExisting: before.some(page => page.id === item.targetId),
        presentAfter: after ? after.some(page => page.id === item.targetId) : null,
        roundAttribution: 'not-reported-by-native-harness'
      });
    } catch (error) {
      pages.push({ observationError: diagnosticError(error, 'owned-page-log') });
    }
  }
  return pages;
}

async function runNativeAttempt(request, {
  run, targets = () => browserTargets(request.options.cdpEndpoint),
  sanitize = () => '[diagnostic text omitted]', write = writeDiagnostic
}) {
  const binding = attemptBinding(request);
  const root = request.outputRoot;
  const primaryRef = path.join(root, 'primary-command.json');
  const cleanupRef = path.join(root, 'browser-cleanup.json');
  const diagnosticRef = path.join(root, 'controller-diagnostic.json');
  const before = await targets();
  const primary = { format: '1js-native-command-v1', ...binding,
    status: 'running', startedAt: new Date().toISOString(),
    finishedAt: null, budgetMs: commandBudget(request), error: null };
  write(primaryRef, primary);
  write(cleanupRef, { format: '1js-browser-cleanup-v1', ...binding,
    status: 'pending', before: pageEvidence(before), after: null });
  let output, primaryError;
  try {
    output = await run();
    primary.status = 'passed';
    primary.exitCode = 0;
    const captured = diagnosticError({ stdout: output }, 'native-command', sanitize);
    primary.output = { stdout: captured.stdout, stderr: captured.stderr };
  } catch (error) {
    primaryError = error;
    primary.status = 'failed';
    primary.error = diagnosticError(error, 'native-command', sanitize);
    primary.exitCode = primary.error.exitCode;
  }
  primary.finishedAt = new Date().toISOString();
  const secondary = [];
  const save = (file, body, exclusive = true) => {
    try { write(file, body, exclusive); }
    catch (error) { secondary.push(diagnosticError(error, `persist-${path.basename(file)}`, sanitize)); }
  };
  // Persist the command outcome before any network query or cleanup assertion.
  save(primaryRef, primary, false);
  const cleanup = { format: '1js-browser-cleanup-v1', ...binding,
    startedAt: new Date().toISOString(), finishedAt: null,
    status: 'failed', before: pageEvidence(before), after: null, errors: [] };
  let after;
  try {
    after = await targets();
    cleanup.after = pageEvidence(after);
    assertBrowserCleanup(before, after);
    cleanup.status = 'verified';
  } catch (error) {
    cleanup.errors.push(diagnosticError(error, 'browser-restoration', sanitize));
  }
  cleanup.finishedAt = new Date().toISOString();
  save(cleanupRef, cleanup, false);
  const diagnostic = {
    format: '1js-controller-diagnostic-v1', ...binding,
    startedAt: primary.startedAt, finishedAt: cleanup.finishedAt,
    effectiveBudgets: { nativeCommandMs: primary.budgetMs,
      controllerMs: request.controllerTimeoutMs ?? null, browserQueryMs: 10000 },
    interruption: primary.error ? interruptionType(primary.error) : null,
    primaryErrorRef: primary.error ? primaryRef : null, primaryCommandRef: primaryRef,
    primary, cleanupRef, cleanup,
    native: nativeProgress(root),
    ownedPages: ownedPageEvidence(primaryError?.stdout ?? output, before, after),
    secondaryErrors: secondary
  };
  save(diagnosticRef, diagnostic);
  if (primaryError || cleanup.status !== 'verified' || secondary.length) {
    const reasons = [
      ...(primary.error ? [`native command: ${interruptionType(primary.error)} (exit=${primary.error.exitCode}, signal=${primary.error.signal})`] : []),
      ...(cleanup.status !== 'verified' ? ['browser restoration failed'] : []),
      ...secondary.map(error => error.stage)
    ];
    const failure = new Error(`Native attempt failed: ${reasons.join('; ')}. Diagnostics: ${diagnosticRef}`);
    failure.diagnostic = diagnostic;
    throw failure;
  }
  return diagnosticRef;
}

function recordControllerInterruption(request, error, startedAt) {
  const file = path.join(request.outputRoot, 'controller-interruption.json');
  const primary = diagnosticError(error, 'controller-process');
  const diagnostic = {
    format: '1js-controller-interruption-v1', ...attemptBinding(request),
    scope: 'controller-profile-process',
    startedAt, finishedAt: new Date().toISOString(),
    interruption: primary.cancelled || primary.timeout ? interruptionType(primary) :
      error.killed ? 'controller-termination' : interruptionType(primary),
    effectiveBudgets: { nativeCommandMs: commandBudget(request),
      controllerMs: request.controllerTimeoutMs ?? null },
    primary, primaryErrorRef: file, timeoutConfirmed: primary.timeout,
    native: nativeProgress(request.outputRoot),
    profileCommandRef: path.join(request.outputRoot, 'primary-command.json'),
    profileCleanupRef: path.join(request.outputRoot, 'browser-cleanup.json'),
    browserRestoration: 'unverified'
  };
  fs.mkdirSync(request.outputRoot, { recursive: true });
  writeDiagnostic(file, diagnostic);
  return file;
}

let profileSanitizer;
function profileFailure(error, sanitize = profileSanitizer) {
  if (error.diagnostic) return error.message;
  const diagnostic = diagnosticError(error, 'profile', sanitize);
  if (/Your token is invalid|Authentication to package feed failed/i
    .test(`${error.stdout ?? ''}\n${error.stderr ?? ''}`))
    diagnostic.prerequisite = 'Authentication to package feed failed';
  return JSON.stringify(diagnostic);
}

async function main() {
  const request = validateRequest(JSON.parse(process.env.PILOT_DECLARATIVE_REQUEST ?? 'null'));
  check(!request.profileSha256 || digest(fs.readFileSync(__filename)) === request.profileSha256,
    'The Controller profile bytes do not match this attempt.');
  const action = process.env.PILOT_DECLARATIVE_ACTION ?? 'validate';
  check(['register', 'validate'].includes(action), 'Unsupported declarative Controller action.');
  const root = fs.realpathSync(process.cwd());
  check(git(root, ['rev-parse', 'HEAD']) === request.sourceRevision,
    'Workspace does not match the exact requested revision.');
  check(git(root, ['merge-base', '--is-ancestor', request.baseRevision, request.sourceRevision]) === '',
    'Requested validation revision is not descended from the qualified source.');
  Object.assign(process.env, {
    DONT_UPDATE_ENV: 'true', XLO_OMNI_FLIGHT: 'true',
    XLO_SHARED_AGENT_SHELL_FLIGHT: 'true',
    EXCELAGENT_CDP_ENDPOINT: request.options.cdpEndpoint
  });
  const api = loadNative(root, request);
  profileSanitizer = api.sanitizeDiagnosticText;
  const selected = selectCases(root, request, api);
  if (action === 'register') {
    const documents = REGISTRATION_FILES.map(file => readJson(inside(root, file)));
    const baseline = REGISTRATION_FILES.map(file =>
      JSON.parse(git(root, ['show', `${request.baseRevision}:${file}`])));
    const updates = registrationUpdates(baseline, selected, request.options.registration);
    const changed = [];
    for (let index = 0; index < updates.length; index++) {
      if (JSON.stringify(documents[index]) === JSON.stringify(updates[index])) continue;
      const file = inside(root, REGISTRATION_FILES[index]);
      fs.writeFileSync(file, `${JSON.stringify(updates[index], null, 2)}\n`);
      changed.push(REGISTRATION_FILES[index]);
    }
    if (changed.length)
      runYarn(root, request, ['prettier', '--write',
        ...changed.map(file => path.relative(path.join(root, 'ooui'), path.join(root, file)))],
      path.join(root, 'ooui'));
    console.log(`PILOT_DECLARATIVE_REGISTRATION:${JSON.stringify({
      caseIds: selected.map(item => item.scenario.id), changedFiles: sorted(changed),
      fileSha256: Object.fromEntries(changed.map(file =>
        [file, digest(fs.readFileSync(inside(root, file)))]))
    })}`);
    return;
  }
  check(!git(root, ['status', '--porcelain']), 'Validation requires a clean final-SHA checkout.');
  check(path.isAbsolute(request.outputRoot ?? '') && !fs.existsSync(request.outputRoot),
    'Validation requires a fresh persistent output directory.');
  fs.mkdirSync(request.outputRoot, { recursive: true });
  const app = path.join(root, APP);
  runYarn(root, request, ['--silent', 'typecheck'], app);
  runYarn(root, request, ['--silent', 'declarative:unit'], app,
    nativeUnitEnvironment(process.env));
  runYarn(root, request, ['--silent', 'declarative:validate-repair'], app);
  const selection = api.loader.loadExcelAgentExecutionSelection();
  check(selected.every(item => selection.enabledCaseKeys.includes(item.scenario.id)),
    'The selected case is not enabled by the native execution-selection policy.');
  Object.assign(process.env, { EXCEL_AGENT_LOCAL_OUTPUT_ROOT: request.outputRoot });
  await runNativeAttempt(request, {
    sanitize: api.sanitizeDiagnosticText,
    run: () => runYarn(root, request, [
      '--silent', 'declarative:local', '--lane', 'aad-enterprise',
      ...selected.flatMap(item => ['--case', item.scenario.id]),
      '--repeat', '5', '--max-failures', '1'
    ], app)
  });
  const outputs = fs.readdirSync(request.outputRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory());
  check(outputs.length === 1, 'Native launcher must produce exactly one bounded batch.');
  const evidence = path.join(request.outputRoot, outputs[0].name);
  const selectionReceipt = readJson(path.join(evidence, 'selection.json'));
  check(selectionReceipt.kind === 'runtime-selection' &&
    selectionReceipt.lane === 'aad-enterprise' && selectionReceipt.repeats === 5,
  'Native selection does not prove the requested five-pass AAD batch.');
  assert.deepEqual(
    selectionReceipt.selected.map(item => ({ id: item.id, sha256: item.sha256 }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    selected.map(item => ({ id: item.scenario.id, sha256: item.sha256 }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    'Native selection differs from the exact authored scenario batch.');
  assertExecution(readJson(path.join(evidence, 'summary.json')), selected, file => {
    const relative = path.relative(evidence, file);
    check(relative && !path.isAbsolute(relative) && !relative.startsWith('..'),
      'Native execution attachment escapes the bounded evidence directory.');
    return readJson(file);
  });
  check(git(root, ['rev-parse', 'HEAD']) === request.sourceRevision &&
    !git(root, ['status', '--porcelain']), 'Native validation mutated the source.');
  const receipt = {
    format: FORMAT, assignmentId: request.assignmentId,
    evidenceIds: request.evidenceIds, inputItemIds: request.inputItemIds,
    baseRevision: request.baseRevision, sourceRevision: request.sourceRevision,
    caseIds: selected.map(item => item.scenario.id), repeats: 5, retries: 0, workers: 1,
    status: 'passed', browserCleanup: 'verified', evidence,
    completedAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(request.outputRoot, 'receipt.json'),
    JSON.stringify(receipt, null, 2), { flag: 'wx' });
  console.log(`PILOT_DECLARATIVE_RECEIPT:${JSON.stringify(receipt)}`);
}

module.exports = {
  APP, SCENARIOS, REGISTRATION_FILES, FORMAT, changedScenarios, validateRequest,
  registrationUpdates, assertExecution, assertBrowserCleanup, selectCases, nativeApi,
  assertAdditiveShared, nativeUnitEnvironment, runNativeAttempt, nativeProgress,
  recordControllerInterruption, main, profileFailure
};
if (require.main === module) {
  main().catch(error => {
    console.error(`PILOT_VALIDATION_PROFILE_ERROR: ${profileFailure(error)}`);
    process.exitCode = 1;
  });
}

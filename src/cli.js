#!/usr/bin/env node
import { resolve } from 'node:path';
import { readFileSync, lstatSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { configAt, readJson, safeError, requireThat, proposerExecutorFlight } from './common.js';
import { Ledger } from './ledger.js';
import { collect, acceptReview, reviewPending, route, report, reconcile, tick, runOnce, nextDailyWake } from './coordinator.js';
import { smokeRuntime, withWorkiq, principalPath, verifyPrincipal } from './runtime.js';
import { adoTransport } from './sources.js';
import { dryRun } from './dry-run.js';
import { beginApp, openApp, appendApp, blockApp, unavailableApp, appStatus, finishApp, appReview, appWorker, appPlanImprovement, collectAppAdo, reconcileAppAdo, listAppRuns, importParentReceipts, prepareWorkiqContinuation, threadContext } from './app-native.js';
import { assertRsiProducerNamespace, rsiAutomationPolicy, rsiErrorHandoff, rsiPolicy, rsiWork } from './rsi-flow.js';
import { runRsiPending } from './rsi-execution.js';
import { collectCliWorkiq, reconcileCliWorkiq } from './cli-collection.js';
import { persistIcmReplay } from './icm-replay.js';
import { prepareStage2, checkStage2Files } from './stage2.js';
import { prepareTitleIndex, materializeTitleScreen } from './filter.js';
import { prepareFilterBatches, sizeFilterGroups, checkFilterBatchFiles, consolidateFilterBatches } from './filter-batches.js';
import { reconcileFilterExecutionCohort } from './filter-execution.js';
import { planImprovement } from './improvements.js';
import { qualifyRepositorySkill, skillQualificationId } from './repository-skills.js';
import { bootstrapLocalRepository } from './local-settings.js';
import { setupLocalEnvironment } from './setup.js';
import { publishReviewReceipt, verifyReviewReceipt } from './pr-review-receipt.js';
import { acceptReviewedHandoff } from './reviewed-handoff.js';
import { acceptFilterProposerHandoff } from './filter-handoff.js';
import { cleanupWorkspaces } from './workspace-gc.js';
import { schedulePreparedAssignments } from './assignment-scheduler.js';
import { cleanupAgencyTransports } from './agency-transport-gc.js';
import { reconcileAgencyRemoteJob } from './agency-remote-authoring.js';
import { describeAgent, describeAgents, agentInvocation, agentOperationResult, agentOperationError } from './agents.js';
import { replayRecordedEvidence, replayRecordedReview } from './role-replay.js';
import { continueRoleValidation } from './role-continuation.js';
import { prepareLocalValidationDiagnostic, dispatchLocalValidationDiagnostic } from './local-diagnostic.js';
import { prepareLocalAuthoringSuccessor, dispatchLocalAuthoringSuccessor } from './local-authoring-successor.js';
import { exportE2eProof, checkE2eProof } from './e2e-proof.js';
import { assertStateDirectoryIgnored, pruneState } from './state-retention.js';

const invocationArgs = process.argv.slice(2);
const roleInvocation = invocationArgs[0] === 'agent';
const role = roleInvocation ? invocationArgs[1] : null;
const [action = 'help', ...args] = roleInvocation ? invocationArgs.slice(2) : invocationArgs;
const configIndex = args.indexOf('--config');
const configFile = configIndex >= 0 ? args[configIndex + 1] :
['setup', 'bootstrap-repo', 'submit-reviewed-handoff', 'submit-filter-handoff',
  'workspace-gc', 'transport-gc', 'dispatch-ready', 'reconcile-remote-authoring'].includes(action)
    ? 'pilot.local.json' : 'pilot.example.json';
function option(name) {
  const index = args.indexOf(name); return index < 0 ? null : args[index + 1];
}
function options(name) {
  return args.flatMap((value, index) => value === name && args[index + 1] ? [args[index + 1]] : []);
}
function failedOutcome(result) {
  if (Array.isArray(result)) return result.some(failedOutcome);
  if (!result || typeof result !== 'object') return false;
  return Boolean(result.error) ||
    result.state === 'failed' ||
    ['action-required-auth', 'blocked', 'blocked-auth', 'partial', 'partial-or-blocked',
      'draft-pr-validation-failed'].includes(result.state) ||
    ['blocked', 'draft-pr-validation-failed', 'diagnostic-failed'].includes(result.outcome) ||
    ['collection', 'reviews', 'workers', 'result', 'results', 'workspaces', 'rsi', 'execution']
      .some(key => failedOutcome(result[key]));
}
const help = `Local evidence pilot (live operations disabled by default)
  node src\\cli.js self-improvement init|observe|prepare|evaluate|decision|status|report --policy rsi.local.json [--file request.json]
  node src\\cli.js agents
  node src\\cli.js agent collector|filter|proposer|rsi help
  node src\\cli.js agent ROLE EXISTING_COMMAND [existing command arguments]
  node src\\cli.js agent collector replay-evidence --file captured-inputs.json --config held-replay.local.json
  node src\\cli.js agent filter replay-review --file recorded-review.json --config held-replay.local.json
  node src\\cli.js agent proposer continue-local-validation --prepare|--execute --file request.json --config next.local.json
  node src\\cli.js agent proposer diagnose-local-validation --prepare|--execute --file request.json --config diagnostic.local.json
  node src\\cli.js agent proposer continue-local-authoring --prepare|--execute --file request.json --config successor.local.json
  node src\\cli.js setup [--repo ID ...] [--allow-clone] [--search-root C:\\src] [--clone-root D:\\repos]
  node src\\cli.js bootstrap-repo --repo office-agent --config pilot.local.json [--search-root C:\\src] [--clone-root D:\\repos]
  node src\\cli.js pr-review-publish --repo OWNER/REPO --pr NUMBER --file review-receipt.local.json [--approve-other-author]
  node src\\cli.js pr-review-verify --repo OWNER/REPO --pr NUMBER
  node src\\cli.js submit-reviewed-handoff --file reviewed-handoff.json --config pilot.local.json --prepare
  node src\\cli.js submit-reviewed-handoff --file reviewed-handoff.json --config pilot.local.json --execute --authorize-synthetic --authorize-commit --authorize-push --authorize-draft-pr
  node src\\cli.js submit-filter-handoff --file filter-handoff.json --config pilot.local.json --prepare [--intent improvement|defect-fix]
  node src\\cli.js submit-filter-handoff --file filter-handoff.json --config pilot.local.json --execute [--intent improvement|defect-fix] --authorize-commit --authorize-push --authorize-draft-pr
  node src\\cli.js status [--config pilot.local.json]
  node src\\cli.js workspace-gc --config pilot.local.json [--execute]
  node src\\cli.js transport-gc --config pilot.local.json [--execute]
  node src\\cli.js reconcile-remote-authoring --assignment ID --round N --config pilot.local.json
  node src\\cli.js dispatch-ready --config pilot.local.json [--execute --limit N --authorize-commit --authorize-push --authorize-draft-pr]
  node src\\cli.js state-prune [--dry-run] [--config pilot.local.json]
  node src\\cli.js doctor
  node src\\cli.js runtime-smoke
  node src\\cli.js auth-check
  node src\\cli.js dry-run --config pilot.example.json
  node src\\cli.js dry-run --collect --auth-refreshed --config pilot.example.json
  node src\\cli.js collect --config pilot.local.json
  node src\\cli.js run --config pilot.local.json
  node src\\cli.js review --file review.json --config pilot.local.json
  node src\\cli.js review-pending --config pilot.local.json
  node src\\cli.js dispatch --intent rca-only|defect-fix|improvement --config pilot.local.json
  node src\\cli.js report
  node src\\cli.js reconcile
  node src\\cli.js recover-lock --name NAME --owner EXACT_OWNER
  node src\\cli.js unblock-source --source ado:created --reason "Verified supported reauthentication"
  node src\\cli.js tick --config pilot.local.json
  node src\\cli.js serve --config pilot.local.json
  node src\\cli.js app-begin --file begin.json
  node src\\cli.js app-runs
  node src\\cli.js app-import-parent --run ID --file parent-receipts.json
  node src\\cli.js app-append --run ID --file receipt-batch.json
  node src\\cli.js app-unavailable --run ID --file unavailable.json
  node src\\cli.js app-block --run ID --file authentication-failure.json
  node src\\cli.js app-status --run ID
  node src\\cli.js app-end --run ID [--production] --config pilot.local.json
  node src\\cli.js agent rsi app-rsi-work --run ID [--production] --operation status|inspect|claim|propose|reserve-publication|result [--file request.json] --config pilot.local.json
  node src\\cli.js agent rsi rsi-work --operation status|inspect|capture|claim|propose|reserve-publication|result [--file request.json] --config pilot.local.json
  node src\\cli.js agent rsi rsi-run [--file host-action.json] --config pilot.local.json
  node src\\cli.js agent rsi app-rsi-run --run ID [--production] [--file host-action.json] --config pilot.local.json
  node src\\cli.js app-ado --run ID --pass ado:created|ado:changed --collect
  node src\\cli.js app-ado-reconcile --run ID --pass ado:created|ado:changed
  node src\\cli.js app-workiq-cli --run ID --pass workiq:created|workiq:changed --collect --config pilot.local.json
  node src\\cli.js app-workiq-cli-reconcile --run ID --pass workiq:created|workiq:changed --config pilot.local.json
  node src\\cli.js app-workiq-continue --from-run OLD --run NEW --pass workiq:created|workiq:changed --authorize-additional-budget
  node src\\cli.js app-thread-context --run ID --pass workiq:created|workiq:changed
  node src\\cli.js icm-replay --file receipt-bundle.json --config pilot.local.json
  node src\\cli.js stage2-handoff --file source-ledgers.json --output private-handoff.json
  node src\\cli.js filter-title-index --file source-ledgers.json --output private-titles.json
  node src\\cli.js filter-title-materialize --file title-decisions.json --index private-titles.json --output private-details.json
  node src\\cli.js filter-batches --file batch-request.json --output private-batches.json
  node src\\cli.js filter-batch-size --file batch-request.json --output private-sizes.json
  node src\\cli.js filter-batch-check --file batch-result.json --manifest private-batches.json
  node src\\cli.js filter-consolidate --file result-paths.json --manifest private-batches.json --output consolidation.json
  node src\\cli.js filter-execution-check --file result-paths.json --manifest private-batches.json --ledger execution.sqlite
  node src\\cli.js e2e-proof-export --file private-proof-request.json --output e2e-evidence\\RUN_ID
  node src\\cli.js e2e-proof-check --file private-proof-request.json --bundle e2e-evidence\\RUN_ID
  node src\\cli.js stage2-proposal-check --file private-proposal.json --handoff private-handoff.json
  node src\\cli.js app-review --run ID --production --file review.json
  node src\\cli.js app-plan-improvement --run ID --production --file improvement-plan.json
  node src\\cli.js app-worker --run ID --production --operation prepare|claim|bind|result|uncertain --file action.json
  node src\\cli.js plan-improvement --file improvement-plan.json --config pilot.local.json
  node src\\cli.js qualify-skill --repo office-agent --capability integration-test-authoring --binding oa-integration-test-core --config pilot.local.json
App commands default to isolated dry-run storage. They never call SDK WorkIQ.
Only app-ado --collect and explicitly configured app-workiq-cli --collect perform source reads.
No source writes, merge, validation retry/cancel or automatic lock stealing.`;
let ledger, agent;
let automaticPruneConfig;
try {
  requireThat(!(roleInvocation && action === 'self-improvement'),
    'Self-improvement is not an evidence-role operation', 'blocked-scope');
  if (roleInvocation) agent = agentInvocation(role, action);
  if (['rsi-work', 'app-rsi-work', 'rsi-run', 'app-rsi-run', 'app-end'].includes(action)) {
    const allowed = new Set(['--config',
      ...(action.startsWith('app-') ? ['--run', '--production'] : []),
      ...(action.endsWith('-work') ? ['--operation', '--file'] : []),
      ...(action.endsWith('-run') ? ['--file'] : [])]);
    const seen = new Set();
    for (let index = 0; index < args.length; index++) {
      const key = args[index];
      requireThat(allowed.has(key) && !seen.has(key), 'Unknown or duplicate RSI option', 'blocked-scope');
      seen.add(key);
      if (key !== '--production') requireThat(args[++index] && !args[index].startsWith('--'),
        'RSI option requires a value', 'blocked-scope');
    }
    requireThat(seen.has('--config') && (!action.startsWith('app-') || seen.has('--run')),
      'RSI flow commands require explicit --config and the app run when applicable', 'blocked-authorization');
    if (action.endsWith('-work')) {
      const operation = option('--operation');
      requireThat(['status', 'inspect', ...(action === 'rsi-work' ? ['capture'] : []),
        'claim', 'propose', 'reserve-publication', 'result'].includes(operation),
        'Unknown RSI work operation', 'blocked-scope');
      requireThat((operation === 'status') !== seen.has('--file'),
        'RSI status takes no file; all other operations require one', 'blocked-scope');
    }
  }
  if (action === 'continue-local-validation')
    requireThat(args.includes('--prepare') !== args.includes('--execute') &&
      option('--file') && option('--config'),
    'Role continuation requires explicit --file, --config and exactly one of --prepare or --execute',
    'blocked-authorization');
  if (['diagnose-local-validation', 'continue-local-authoring'].includes(action)) {
    const label = action === 'diagnose-local-validation' ? 'Local diagnostic' : 'Authoring successor';
    requireThat(args.filter(arg => ['--prepare', '--execute'].includes(arg)).length === 1 &&
      ['--file', '--config'].every(name => option(name) && !option(name).startsWith('--')),
    `${label} requires explicit --file, --config and exactly one of --prepare or --execute`,
    'blocked-authorization');
  }
  if (action === 'help') console.log(agent
    ? JSON.stringify(agentOperationResult(agent, describeAgent(role)), null, 2)
    : help);
  else if (action === 'agents') console.log(JSON.stringify(describeAgents(), null, 2));
  else if (action === 'self-improvement') {
    // Keep the judge out of this process's normal worker imports and automatic pruning.
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('./self-improvement-cli.js', import.meta.url)), ...args
    ], { stdio: 'inherit', windowsHide: true, shell: false, timeout: 3660000 });
    requireThat(!result.error && result.status !== null,
      'RSI command did not finish; inspect retained state without retrying execution',
      'blocked-reconciliation');
    process.exitCode = result.status;
  }
  else if (action === 'setup') {
    const result = await setupLocalEnvironment({
      settingsPath: configFile,
      templatePath: option('--template') ?? 'pilot.example.json',
      repoIds: options('--repo'),
      searchRoots: options('--search-root'),
      cloneRoot: option('--clone-root'),
      allowClone: args.includes('--allow-clone')
    });
    const setupConfig = configAt(resolve(configFile));
    ledger = new Ledger(setupConfig.stateDirectory);
    for (const qualification of result.qualifications)
      ledger.qualify(skillQualificationId(qualification.repoId, qualification.bindingId), qualification);
    console.log(JSON.stringify(result, null, 2));
  }
  else if (action === 'bootstrap-repo') {
    requireThat(option('--repo'), 'bootstrap-repo requires --repo');
    const result = await bootstrapLocalRepository({
      settingsPath: configFile,
      templatePath: option('--template') ?? 'pilot.example.json',
      repoId: option('--repo'),
      searchRoots: options('--search-root'),
      cloneRoot: option('--clone-root'),
      allowClone: true
    });
    console.log(JSON.stringify(result, null, 2));
  }
  else if (action === 'pr-review-publish') {
    requireThat(option('--repo') && option('--pr') && option('--file'),
      'pr-review-publish requires --repo, --pr and --file');
    const result = await publishReviewReceipt({
      repository: option('--repo'),
      number: Number(option('--pr')),
      receipt: readJson(resolve(option('--file'))),
      approveOtherAuthor: args.includes('--approve-other-author')
    });
    console.log(JSON.stringify(result, null, 2));
  }
  else if (action === 'pr-review-verify') {
    requireThat(option('--repo') && option('--pr'), 'pr-review-verify requires --repo and --pr');
    const result = await verifyReviewReceipt({
      repository: option('--repo'),
      number: Number(option('--pr'))
    });
    console.log(JSON.stringify(result, null, 2));
  }
  else {
    const config = configAt(resolve(configFile));
    if (['rsi-work', 'app-rsi-work', 'rsi-run', 'app-rsi-run'].includes(action))
      requireThat(rsiPolicy(config).enabled, 'RSI is disabled for this configuration', 'blocked-authorization');
    if (config.rsi?.enabled || ['rsi-work', 'app-rsi-work', 'rsi-run', 'app-rsi-run', 'app-end'].includes(action))
      assertRsiProducerNamespace(config);
    if (['rsi-run', 'app-rsi-run'].includes(action))
      requireThat(rsiAutomationPolicy(config), 'RSI automation is not authorized', 'blocked-authorization');
    if (config.statePolicy.accessApproved) assertStateDirectoryIgnored(config);
    if (action !== 'state-prune') {
      automaticPruneConfig = config;
      pruneState(config);
    }
    const appAction = action.startsWith('app-');
    if (config.executionMode === 'app-native' && !appAction &&
      ['auth-check', 'dry-run', 'collect', 'run', 'dispatch', 'continue-local-validation', 'diagnose-local-validation',
        'continue-local-authoring', 'review-pending', 'tick', 'serve', 'runtime-smoke'].includes(action)) {
      requireThat(option('--execution-mode') === 'standalone-sdk',
        'App-native mode does not launch SDK gates/workers/schedules. Use app-* commands; legacy SDK requires explicit --execution-mode standalone-sdk');
    }
    if (!appAction && !['dry-run', 'icm-replay', 'stage2-handoff', 'stage2-proposal-check', 'state-prune',
      'filter-title-index', 'filter-title-materialize', 'filter-batches', 'filter-batch-size',
      'filter-batch-check', 'filter-consolidate', 'filter-execution-check',
      'e2e-proof-export', 'e2e-proof-check'].includes(action))
      ledger = new Ledger(config.stateDirectory);
    if (appAction && !['app-begin', 'app-runs', 'app-workiq-continue'].includes(action)) {
      requireThat(option('--run'), 'App commands require --run');
      ({ ledger } = openApp(config, option('--run'), !args.includes('--production')));
    }
    const input = () => { requireThat(option('--file'), 'Command requires --file'); return readJson(resolve(option('--file'))); };
    let result;
    switch (action) {
      case 'app-end': result = await finishApp(config, ledger, option('--run')); break;
      case 'rsi-run':
      case 'app-rsi-run':
        if (option('--file')) {
          const file = lstatSync(resolve(option('--file')));
          requireThat(file.isFile() && !file.isSymbolicLink() && file.nlink === 1 &&
            file.size <= Math.min(65536, config.rsi.maxObservationBytes),
          'RSI host action must be a bounded regular JSON file', 'blocked-scope');
        }
        result = await runRsiPending(config, ledger, {
          runId: action === 'app-rsi-run' ? option('--run') : null,
          hostAction: option('--file') ? input() : null
        });
        break;
      case 'rsi-work':
      case 'app-rsi-work': {
        requireThat(option('--operation'), 'RSI work requires --operation');
        if (option('--file')) {
          const file = lstatSync(resolve(option('--file')));
          requireThat(file.isFile() && !file.isSymbolicLink() && file.nlink === 1 &&
            file.size <= Math.min(65536, config.rsi.maxObservationBytes),
          'RSI input must be a bounded regular JSON file', 'blocked-scope');
        }
        result = rsiWork(config, ledger, option('--operation'),
          option('--file') ? input() : {},
          { runId: action === 'app-rsi-work' ? option('--run') : null });
        break;
      }
      case 'replay-evidence': result = await replayRecordedEvidence(config, ledger, input()); break;
      case 'replay-review': result = await replayRecordedReview(config, ledger, input()); break;
      case 'continue-local-validation':
        result = await continueRoleValidation(config, ledger, input(),
          args.includes('--prepare') ? 'prepare' : 'execute'); break;
      case 'diagnose-local-validation': {
        const request = input();
        if (args.includes('--prepare')) result = await prepareLocalValidationDiagnostic(config, ledger, request);
        else {
          requireThat(typeof request?.diagnosticId === 'string' && request.diagnosticId.length > 0 &&
            Object.keys(request).length === 1,
          'Local diagnostic execution requires only its prepared diagnosticId', 'blocked-reconciliation');
          result = await dispatchLocalValidationDiagnostic(config, ledger, request.diagnosticId);
        }
        break;
      }
      case 'continue-local-authoring': {
        const request = input();
        if (args.includes('--prepare')) result = await prepareLocalAuthoringSuccessor(config, ledger, request);
        else {
          requireThat(typeof request?.assignmentId === 'string' && request.assignmentId.length > 0 &&
            Object.keys(request).length === 1,
          'Authoring successor execution requires only its prepared assignmentId', 'blocked-reconciliation');
          result = await dispatchLocalAuthoringSuccessor(config, ledger, request.assignmentId);
        }
        break;
      }
      case 'state-prune':
        result = pruneState(config, { dryRun: args.includes('--dry-run') });
        break;
      case 'filter-batch-size':
        requireThat(option('--output'), 'Batch measurement requires --output');
        result = sizeFilterGroups(config, input(), option('--output')); break;
      case 'filter-batches':
        requireThat(option('--output'), 'Batch preparation requires --output');
        result = await prepareFilterBatches(config, input(), option('--output')); break;
      case 'filter-batch-check':
        requireThat(option('--file') && option('--manifest'), 'Batch check requires --file and --manifest');
        result = checkFilterBatchFiles(config, option('--manifest'), option('--file')); break;
      case 'filter-consolidate': {
        requireThat(option('--manifest') && option('--output'), 'Consolidation requires --manifest and --output');
        const files = input();
        requireThat(Array.isArray(files) && files.every(p => typeof p === 'string'),
          'Consolidation --file must contain an array of result paths');
        result = consolidateFilterBatches(config, readJson(option('--manifest')),
          files.map(p => readJson(resolve(p))), option('--output')); break;
      }
      case 'filter-execution-check': {
        requireThat(option('--manifest') && option('--ledger'), 'Execution check requires --manifest and --ledger');
        const files = input();
        requireThat(Array.isArray(files) && files.every(p => typeof p === 'string'),
          'Execution check --file must contain an array of result paths');
        const db = new DatabaseSync(resolve(option('--ledger')), { readOnly: true });
        try {
          result = reconcileFilterExecutionCohort(config, { db }, readJson(option('--manifest')),
           files.map(p => readFileSync(resolve(p), 'utf8')),
           option('--policy') ? readJson(option('--policy')) : null);
        } finally { db.close(); }
        break;
      }
      case 'e2e-proof-export':
        requireThat(option('--output'), 'E2E proof export requires --output');
        result = exportE2eProof(config, input(), option('--output')); break;
      case 'e2e-proof-check':
        requireThat(option('--bundle'), 'E2E proof check requires --bundle');
        result = checkE2eProof(config, input(), option('--bundle')); break;
      case 'filter-title-index':
        requireThat(option('--output'), 'Title index requires an explicit private output path');
        result = prepareTitleIndex(config, input(), option('--output')); break;
      case 'filter-title-materialize':
        requireThat(option('--file') && option('--index') && option('--output'),
          'Title materialization requires --file, --index and --output');
        result = materializeTitleScreen(config, option('--index'), option('--file'), option('--output')); break;
      case 'icm-replay':
        requireThat(!args.includes('--collect'), 'IcM replay is offline only; it does not launch a live connector');
        result = persistIcmReplay(config, input()); break;
      case 'stage2-handoff':
        requireThat(option('--output'), 'Stage2 requires an explicit private output path');
        result = prepareStage2(config, input(), option('--output')); break;
      case 'stage2-proposal-check':
        requireThat(option('--file') && option('--handoff'), 'Proposal check requires --file and --handoff');
        result = checkStage2Files(config, option('--file'), option('--handoff')); break;
      case 'app-begin': result = beginApp(config, input()); break;
      case 'app-runs': result = listAppRuns(config); break;
      case 'app-import-parent': result = await importParentReceipts(config, ledger, option('--run'), input()); break;
      case 'app-append': result = await appendApp(config, ledger, option('--run'), input()); break;
      case 'app-block': {
        result = blockApp(config, ledger, option('--run'), input());
        if (config.rsi?.enabled) result = await finishApp(config, ledger, option('--run'));
        break;
      }
      case 'app-unavailable': result = unavailableApp(ledger, option('--run'), input()); break;
      case 'app-status': result = appStatus(ledger, option('--run')); break;
      case 'app-review': result = appReview(config, ledger, option('--run'), input()); break;
      case 'app-plan-improvement': result = appPlanImprovement(config, ledger, option('--run'), input()); break;
      case 'app-worker': {
        result = appWorker(config, ledger, option('--run'), option('--operation'), input());
        if (config.rsi?.enabled && ['result', 'agency-result'].includes(option('--operation')))
          result = { ...result, rsi: (await finishApp(config, ledger, option('--run'))).rsi };
        break;
      }
      case 'app-ado':
        requireThat(args.includes('--collect'), 'Live ADO reads require explicit --collect');
        result = await collectAppAdo(config, ledger, option('--run'), option('--pass')); break;
      case 'app-ado-reconcile':
        result = await reconcileAppAdo(config, ledger, option('--run'), option('--pass')); break;
      case 'app-workiq-cli':
        requireThat(args.includes('--collect'), 'Live CLI reads require explicit --collect');
        result = await collectCliWorkiq(config, ledger, option('--run'), undefined, option('--pass') ?? 'workiq:created'); break;
      case 'app-workiq-cli-reconcile':
        result = await reconcileCliWorkiq(config, ledger, option('--run'), option('--pass') ?? 'workiq:created'); break;
      case 'app-workiq-continue':
        requireThat(!args.includes('--production'), 'Continuation currently supports collection-only dry runs');
        result = await prepareWorkiqContinuation(config, { fromRunId: option('--from-run'), runId: option('--run'),
          pass: option('--pass') ?? 'workiq:created', additionalBudgetApproved: args.includes('--authorize-additional-budget') }); break;
      case 'app-thread-context':
        result = threadContext(ledger, option('--run'), option('--pass') ?? 'workiq:created'); break;
      case 'doctor':
        result = {
          node: process.version, activation: config.activation, initialWindow: config.window,
          identityConfigured: Boolean(config.identity.designatedUser && config.identity.tenantId && config.identity.objectId),
          workiqSeeds: config.sources.workiq.seeds.length, repositoryMappings: config.repositories.length,
          proposerExecutors: config.repositories.map(repo => ({
            repoId: repo.id, selection: proposerExecutorFlight(repo) ?? 'legacy-per-task',
            readinessVerified: false
          })),
          reviewMethod: config.reviewMethod, scheduleEnabled: config.schedule.enabled,
          icm: 'Explicit incident-created mode supports app-append receipt ingestion. Offline icm-replay remains audit-only. Legacy owner exports require saved-query verification; no helper launches an IcM connector.',
          validation: 'Fixed configured repo-native runners in isolated task workspaces; none assumed from repository names.',
          liveAccessVerified: false
        };
        break;
      case 'runtime-smoke': result = await smokeRuntime(config, process.cwd()); break;
      case 'dry-run': result = await dryRun(config, {
        collectRequested: args.includes('--collect'), authRefreshed: args.includes('--auth-refreshed')
      }); break;
      case 'auth-check': {
        result = [];
        if (!option('--source') || option('--source') === 'workiq') try {
          await withWorkiq(config, async read => verifyPrincipal(config, await read(principalPath)));
          result.push({ source: 'workiq', state: 'authenticated', principalMatched: true, evidenceAccessVerified: false });
        } catch (error) { result.push({ source: 'workiq', state: 'blocked', error: safeError(error) }); }
        if (!option('--source') || option('--source') === 'ado') try {
          const request = await adoTransport(config);
          await request('wiql', { query: "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'OC' AND [System.Id] = 0" });
          result.push({ source: 'ado', state: 'authenticated', principalMatched: true, evidenceAccessVerified: false });
        } catch (error) { result.push({ source: 'ado', state: 'blocked', error: safeError(error) }); }
        if (!option('--source') || option('--source') === 'icm')
          result.push({ source: 'icm', state: 'blocked', error: { code: 'blocked-scope',
            message: 'No IcM authentication call made. Helpers do not launch the connector; incident-created app-append requires captured identity and exact scoped receipts.' } });
        break;
      }
      case 'status': result = ledger.status(); break;
      case 'workspace-gc':
        result = await cleanupWorkspaces(config, ledger, { execute: args.includes('--execute') });
        break;
      case 'collect': result = await collect(config, ledger); break;
      case 'run': result = await runOnce(config, ledger); break;
      case 'review':
        requireThat(option('--file'), 'review requires --file');
        result = acceptReview(config, ledger, readJson(resolve(option('--file')))); break;
      case 'review-pending': result = await reviewPending(config, ledger); break;
      case 'plan-improvement': result = planImprovement(ledger, input()); break;
      case 'qualify-skill': {
        requireThat(option('--repo') && option('--capability'), 'qualify-skill requires --repo and --capability');
        result = await qualifyRepositorySkill(config, option('--repo'), option('--capability'), option('--binding'));
        ledger.qualify(skillQualificationId(result.repoId, result.bindingId), result);
        break;
      }
      case 'submit-reviewed-handoff': {
        requireThat(args.includes('--prepare') !== args.includes('--execute'),
          `${action} requires exactly one of --prepare or --execute`);
        const handoff = input();
        const handoffOptions = {
          execute: args.includes('--execute'),
          authorizeSynthetic: args.includes('--authorize-synthetic'),
          authorizeCommit: args.includes('--authorize-commit'),
          authorizePush: args.includes('--authorize-push'),
          authorizeDraftPR: args.includes('--authorize-draft-pr')
        };
        result = await acceptReviewedHandoff(config, ledger, handoff, {
          ...handoffOptions,
          source: 'submit-reviewed-handoff'
        });
        break;
      }
      case 'submit-filter-handoff': {
        requireThat(args.includes('--prepare') !== args.includes('--execute'),
          `${action} requires exactly one of --prepare or --execute`);
        const intent = option('--intent') ?? 'improvement';
        requireThat(['improvement', 'defect-fix'].includes(intent),
          `${action} --intent must be improvement or defect-fix`);
        result = await acceptFilterProposerHandoff(config, ledger, input(), {
          intent,
          execute: args.includes('--execute'),
          authorizeCommit: args.includes('--authorize-commit'),
          authorizePush: args.includes('--authorize-push'),
          authorizeDraftPR: args.includes('--authorize-draft-pr')
        });
        break;
      }
      case 'dispatch-ready':
        result = await schedulePreparedAssignments(config, ledger, {
          execute: args.includes('--execute'),
          limit: option('--limit') === null ? null : Number(option('--limit')),
          authorizeCommit: args.includes('--authorize-commit'),
          authorizePush: args.includes('--authorize-push'),
          authorizeDraftPR: args.includes('--authorize-draft-pr')
        });
        break;
      case 'transport-gc':
        result = await cleanupAgencyTransports(config, ledger, {
          execute: args.includes('--execute')
        });
        break;
      case 'reconcile-remote-authoring':
        requireThat(option('--assignment') && /^\d+$/.test(option('--round') ?? ''),
          'Remote reconciliation requires --assignment ID and --round N');
        result = await reconcileAgencyRemoteJob(config, ledger,
          option('--assignment'), Number(option('--round')));
        break;
      case 'dispatch': result = await route(config, ledger, option('--intent') ?? 'rca-only'); break;
      case 'report': result = report(ledger); break;
      case 'reconcile': result = reconcile(ledger); break;
      case 'recover-lock':
        requireThat(option('--name') && option('--owner'), 'Exact lock name and owner are required');
        ledger.recoverLock(option('--name'), option('--owner')); result = { recovered: option('--name') }; break;
      case 'unblock-source':
        requireThat(option('--source'), 'Exact source:lane key is required');
        ledger.unblockSource(option('--source'), option('--reason')); result = { unblocked: option('--source') }; break;
      case 'tick': result = await tick(config, ledger); break;
      case 'serve': {
        requireThat(config.schedule.enabled, 'Schedule is disabled');
        nextDailyWake(config.schedule);
        let stopped = false;
        process.once('SIGINT', () => { stopped = true; });
        process.once('SIGTERM', () => { stopped = true; });
        while (!stopped) {
          const current = configAt(resolve(configFile));
          if (!current.schedule.enabled) break;
          const until = nextDailyWake(current.schedule).getTime();
          while (!stopped && Date.now() < until) await new Promise(done => setTimeout(done, Math.min(1000, until - Date.now())));
          if (stopped) break;
          const refreshed = configAt(resolve(configFile));
          if (!refreshed.schedule.enabled) break;
          try { console.log(JSON.stringify(await tick(refreshed, ledger))); }
          catch (error) { console.error(JSON.stringify(safeError(error))); process.exitCode = 2; break; }
        }
        result = { state: 'stopped' }; break;
      }
      default: throw new Error(`Unknown command: ${action}`);
    }
    console.log(JSON.stringify(agent ? agentOperationResult(agent, result) : result, null, 2));
    if (failedOutcome(result)) process.exitCode = 2;
  }
} catch (error) {
  const failure = safeError(error);
  const rsi = rsiErrorHandoff(error);
  if (rsi) failure.rsi = rsi;
  console.error(JSON.stringify(agent ? agentOperationError(agent, failure) : failure, null, 2));
  process.exitCode = 1;
} finally {
  ledger?.close();
  if (automaticPruneConfig) {
    try { pruneState(automaticPruneConfig); }
    catch (error) {
      console.error(JSON.stringify(safeError(error), null, 2));
      process.exitCode = 1;
    }
  }
}

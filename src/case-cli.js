import { resolve } from 'node:path';
import { configAt, hash, json, readJson, requireThat } from './common.js';
import { Ledger } from './ledger.js';
import { assertStateDirectoryIgnored } from './state-retention.js';
import { admitCaseSources, approveCaseBatch, casePolicy, generateCaseBatch, loadCaseBatch, recordCaseDraft } from './case-generation.js';
import { publishCaseBatch } from './case-publication.js';
import { renderCaseArtifacts } from './case-artifacts.js';
import { runGeneratedCaseRequest } from './case-workflow.js';

export function caseRequestOptions(parsed) {
  const options = {
    authorizeReview: Boolean(parsed['--authorize-review']), execute: Boolean(parsed['--execute']),
    authorizeCommit: Boolean(parsed['--authorize-commit']), authorizePush: Boolean(parsed['--authorize-push']),
    authorizeDraftPR: Boolean(parsed['--authorize-draft-pr']), authorizeComment: Boolean(parsed['--authorize-comment'])
  };
  const phase = parsed['--phase'];
  if (phase !== undefined) {
    requireThat(options.execute, 'A request phase requires --execute', 'blocked-config');
    requireThat(typeof phase === 'string' && /^(prepare|author|commit|publish|validate-[A-Za-z0-9._-]+)$/.test(phase),
      'Unknown request phase', 'blocked-config');
    options.phase = phase;
  }
  return options;
}

export async function runCaseCommand(action, args) {
  if (['case-start', 'case-context', 'case-source-begin', 'case-source-recover', 'case-source-result', 'case-submit', 'case-publish-reviewed'].includes(action)) {
    const { runCaseUrlCommand } = await import('./case-url-flow.js');
    return runCaseUrlCommand(action, args);
  }
  const definitions = {
    'case-sources': [['--config', '--file'], ['--authorize-import']],
    'case-generate': [['--config', '--bundle'], ['--authorize-generation']],
    'case-import-draft': [['--config', '--file'], ['--authorize-import']],
    'case-approve': [['--config', '--file'], ['--authorize-approval']],
    'case-status': [['--config', '--batch'], []],
    'case-render': [['--config', '--batch'], []],
    'case-publish': [['--config', '--batch'], ['--authorize-publication']],
    'case-run-request': [['--config', '--batch', '--case', '--phase'], ['--authorize-review', '--execute',
      '--authorize-commit', '--authorize-push', '--authorize-draft-pr', '--authorize-comment']]
  };
  requireThat(definitions[action], 'Unknown case-generation command', 'blocked-scope');
  const [values, switches] = definitions[action], parsed = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    requireThat([...values, ...switches].includes(key) && !Object.hasOwn(parsed, key),
      'Unknown or duplicate case-generation option', 'blocked-scope');
    if (values.includes(key)) requireThat(args[index + 1] && !args[index + 1].startsWith('--'),
      'Case-generation option requires a value');
    parsed[key] = values.includes(key) ? args[++index] : true;
  }
  requireThat(values.filter(key => key !== '--phase').every(key => parsed[key]),
    'Case-generation commands require explicit configuration and inputs', 'blocked-authorization');
  const requestOptions = action === 'case-run-request' ? caseRequestOptions(parsed) : null;
  if (requestOptions) requireThat(requestOptions.authorizeReview &&
    (!requestOptions.execute || requestOptions.authorizeCommit && requestOptions.authorizePush && requestOptions.authorizeDraftPR),
  'Request execution and review need independent grants', 'blocked-authorization');
  else requireThat(switches.every(key => parsed[key]), 'Missing explicit stage authorization', 'blocked-authorization');
  const config = configAt(resolve(parsed['--config']));
  casePolicy(config);
  assertStateDirectoryIgnored(config);
  const ledger = new Ledger(config.stateDirectory);
  try {
    const file = () => readJson(resolve(parsed['--file']));
    if (action === 'case-sources') {
      const bundle = await admitCaseSources(config, ledger, file(), { authorizeImport: true });
      return { state: 'sources-admitted', bundleId: bundle.id, baselineId: bundle.admission.baselineId,
        sources: bundle.sources.map(({ id, access, sha256 }) => ({ id, access, sha256 })) };
    }
    if (action === 'case-import-draft') {
      const input = file();
      requireThat(Object.keys(input).sort().join(',') === 'bundleId,draft,generator' &&
        typeof input.generator === 'string' && input.generator.trim(), 'Draft import requires a declared generator and exact bundle');
      return recordCaseDraft(config, ledger, input.bundleId, input.draft, `import:${input.generator}`);
    }
    if (action === 'case-generate') return await generateCaseBatch(config, ledger, parsed['--bundle'], { authorizeGeneration: true });
    if (action === 'case-approve') return approveCaseBatch(config, ledger, file(), { authorizeApproval: true });
    if (action === 'case-status') {
      const { batch } = loadCaseBatch(config, ledger, parsed['--batch'], { verifyCurrentInputs: false });
      return { batchId: parsed['--batch'], batchSha256: hash(json(batch)), batch,
        currentAdmission: 'Not checked by status; publishing and execution recheck current inputs',
        operations: ledger.status().operations.filter(row => row.job_id === parsed['--batch']).map(({ id, kind, state }) => ({ id, kind, state })) };
    }
    if (action === 'case-render') return await renderCaseArtifacts(config, ledger, parsed['--batch']);
    if (action === 'case-publish') return await publishCaseBatch(config, ledger, parsed['--batch'], { authorizePublication: true });
    return await runGeneratedCaseRequest(config, ledger, parsed['--batch'], parsed['--case'], requestOptions);
  } finally { ledger.close(); }
}

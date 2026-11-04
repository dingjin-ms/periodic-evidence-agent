import { requireThat } from './common.js';
import { runTestRequest, runTestRequestQueue } from './test-request-flow.js';

// Shared by the real CLI and deterministic transport tests. Dependencies remain
// in-process test seams; no fixture/provider override is exposed as a CLI flag.
export async function executeRequestCli(config, ledger, action, args, dependencies = {}) {
  requireThat(['run-test-request', 'run-test-request-queue'].includes(action), 'Unknown request action');
  const value = key => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
  const options = {
    authorizeReview: args.includes('--authorize-review'), execute: args.includes('--execute'),
    authorizeCommit: args.includes('--authorize-commit'), authorizePush: args.includes('--authorize-push'),
    authorizeDraftPR: args.includes('--authorize-draft-pr'), authorizeComment: args.includes('--authorize-comment'),
    phase: value('--phase')
  };
  return action === 'run-test-request-queue'
    ? runTestRequestQueue(config, ledger, options, dependencies)
    : runTestRequest(config, ledger, Number(value('--id')), options, dependencies);
}

export const help = `Local evidence pilot (live operations disabled by default)
  node src\\cli.js self-improvement init|observe|prepare|evaluate|decision|status|report --policy rsi.local.json [--file request.json]
  node src\\cli.js agents
  node src\\cli.js agent collector|filter|proposer|rsi help
  node src\\cli.js agent ROLE EXISTING_COMMAND [existing command arguments]
  node src\\cli.js agent collector replay-evidence --file captured-inputs.json --config held-replay.local.json
  node src\\cli.js agent filter replay-review --file recorded-review.json --config held-replay.local.json
  node src\\cli.js agent proposer continue-local-validation --prepare|--execute --file request.json --config next.local.json
  node src\\cli.js agent proposer diagnose-local-validation --prepare|--execute --file request.json --config diagnostic.local.json
  node src\\cli.js agent proposer continue-local-authoring --prepare|--execute --file request.json --config successor.local.json
  node src\\cli.js agent proposer continue-runtime-launch --prepare|--execute --file request.json --config next.local.json
  node src\\cli.js agent proposer continue-authoring-tools --prepare|--execute --file request.json --config next.local.json
  node src\\cli.js agent proposer continue-native-preparation --prepare|--execute --file request.json --config next.local.json
  node src\\cli.js agent proposer continue-native-source --prepare|--execute --file request.json --config next.local.json
  node src\\cli.js agent collector one-shot-begin --file collection.json --config collector.local.json
  node src\\cli.js agent collector one-shot-collect --run ID --collect [--resume] --config collector.local.json
  node src\\cli.js agent collector one-shot-status|one-shot-stop --run ID --config collector.local.json
  node src\\cli.js agent filter one-shot-filter-prepare --file handoff.json --config proposer.local.json
  node src\\cli.js agent filter one-shot-filter-reserve --file handoff.json --task ID --request reservation.json --config proposer.local.json
  node src\\cli.js agent proposer one-shot-handoff --check --file handoff.json --config proposer.local.json
  node src\\cli.js agent proposer one-shot-handoff --execute [--resume-auth] --authorize-commit --authorize-push --authorize-draft-pr --file handoff.json --config proposer.local.json
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
  node src\\cli.js task-run --config pilot.local.json --file task.local.json
  node src\\cli.js task-close --config pilot.local.json --file task-close.local.json
  node src\\cli.js resource-abandon-preflight --config pilot.local.json --resource ID
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
  node src\\cli.js filter-local-preflight --config local-filter.local.json
  node src\\cli.js filter-local-run --manifest private-batches.json --batch ID --output private-result.json --execution-mode standalone-sdk
  node src\\cli.js filter-local-retry-prepare --file retry-request.json --output next.local.json --config pilot.local.json
  node src\\cli.js local-e2e --check|--filter|--execute --file run.local.json --config pilot.local.json [--review review.local.json]
  node src\\cli.js local-e2e --execute --authorize-commit --authorize-push --authorize-draft-pr --review review.local.json --file run.local.json --config pilot.local.json [--resume-auth]
  node src\\cli.js e2e-proof-export --file private-proof-request.json --output e2e-evidence\\RUN_ID
  node src\\cli.js e2e-proof-check --file private-proof-request.json --bundle e2e-evidence\\RUN_ID
  node src\\cli.js stage2-proposal-check --file private-proposal.json --handoff private-handoff.json
  node src\\cli.js app-review --run ID --production --file review.json
  node src\\cli.js app-plan-improvement --run ID --production --file improvement-plan.json
  node src\\cli.js app-worker --run ID --production --operation prepare|claim|bind|result|uncertain --file action.json
  node src\\cli.js plan-improvement --file improvement-plan.json --config pilot.local.json
  node src\\cli.js qualify-skill --repo office-agent --capability integration-test-authoring --binding oa-integration-test-core --config pilot.local.json
App commands default to isolated dry-run storage. They never call SDK WorkIQ.
App source reads use app-ado --collect and explicitly configured app-workiq-cli --collect.
one-shot-collect --collect coordinates those same local reads under an aggregate reservation.
one-shot-filter-* only reserve/check local state; the host must supply the qualified external FILTER executor.
No source writes, merge, validation retry/cancel or automatic lock stealing.`;

## Crew-authored ADO test requests

This opt-in lane supports explicit-ID intake and **system-owned review/delivery
passes**, plus bounded queue discovery. The existing resolved Fixed/Duplicate
bug collector, FILTER cohort and daily deployment remain unchanged. Request evidence has its own
`ado-test-request` kind and namespace; it is not relabeled as a resolved bug,
confirmed defect or synthetic reviewed-handoff fixture.

### Crew workflow

Generate a shareable **new Bug link with the five-field template prefilled**:

```powershell
node scripts/create-ado-request-link.mjs
```

The link selects the saved **Agentic test request - Automation** template owned
by the Excel Agent team. Its `System.Description` contains a formatted HTML table
stored in ADO, not HTML or Markdown embedded in the URL. The checked-in
`ado-test-request.template-ref.json` pins the real template and owning team IDs.
It includes the title prefix, area and tag. Replace the bracketed guidance in the
new form before saving. Generating or opening the link does not create a work
item or change intake activation. The [copyable table](ado-test-request.template.md)
remains available as a fallback. The owner-selected area is
`OC\Excel\Intelligence\Copilot\Excel Agent\Automation` in `office/OC`.
The initial policy example selects Bug, New/Active, and exact tag
`AgenticTestRequest`; these are explicit rollout settings, not auto-created ADO
fields or a globally enabled rule. HTML tables from ADO's editor and Markdown
tables are accepted. Blank/placeholder rows return `needs-information` with
field names. Duplicate fields or ambiguous rows are rejected.

Users describe behavior, not selectors, repository file paths, shell commands,
model/provider settings or permission grants. Input links and attachments are
references only: this command does not fetch them. “Agent may create synthetic
inputs” grants permission to generate test data, not source evidence or a claim
of product validation. Semantic feasibility, file access, expected behavior and
existing coverage still need review. An unsupported scenario stays held.

Start with [the single-record SuperApp sample](ado-test-request.single-record.sample.md).
It targets a meaningful minimum nonempty-table boundary using the existing
cross-app structural verifier. The separate [formula-preservation sample](ado-test-request.sample.md)
is retained as a capability-gap example: current structural checks cannot prove
formula preservation. Both are synthetic onboarding requests, not observed
product defects. FILTER eligibility does not replace native discovery or a real
passing E2E run.

### Operator configuration and commands

Use a new task-owned configuration and state directory. Put the contents of
[the inert policy example](ado-test-request.policy.example.json) under the
configuration key `adoTestRequests`. Explicitly approve that scope and record
`approvalRef`; do not edit a running daily configuration or reuse its ledger.
Configure the designated tenant/user and normal repository ownership, exact
revision qualification, write limits, worker budgets and validation gates.
Every request in this policy maps to its single configured repository capability;
the ticket cannot choose another route. Start with one qualified lane.

```powershell
node src/cli.js ado-test-request --id 123 --collect --config pilot.local.json
```

This makes a bounded scope WIQL read, then fetches only that returned ID at the
same snapshot (at most two source calls), with no pagination,
attachment download, source write, model or worker. A same-revision replay must
match the prior captured fields and policy. New revisions invalidate old reviews;
stale deliveries and changed same-revision content fail closed. The receipt
reports `needs-information` or `needs-review`, never automatic eligibility.

An upstream operator/reviewer inspects the request and qualified repository and
writes an `ado-test-request-handoff-v1` document validated by
`scaffold/contracts.schema.json` (`adoTestRequestHandoff`). It binds:

- `intakeId` and SHA-256 of `JSON.stringify(intakeReceipt)`;
- `reviewedAt`, reviewer/method, exclusions, behavioral analysis and ownership;
- the **actual** inspected repository `sourceRevision`, complete coverage search,
  remaining assertions and no unresolved unknowns;
- configured capability/outcome and any validated repository-native skill input.

The review/planning structure reuses `reviewedHandoff`, but not its synthetic
source or `qualified-base` placeholder. No automatic reviewer or fake review is
created by intake. The regression scanner exclusions remain applicable to the
requested behavioral work: filing a request as a work item does not make it a
production defect, nor permit product features or infrastructure-only changes.
Existing fix links needing reconciliation are held for the existing regression
flow rather than discarded. Preparation does not dispatch:

```powershell
node src/cli.js submit-test-request --file handoff.local.json --prepare --config pilot.local.json
```

Only after the separately configured repository and execution grants:

```powershell
node src/cli.js submit-test-request --file handoff.local.json --execute --authorize-commit --authorize-push --authorize-draft-pr --config pilot.local.json
```

Execution re-reads the exact ADO ID and checks the captured revision/fields,
policy and current review before calling the existing planner/worker/validation/
Draft PR machinery. Ordinary `dispatch` and `dispatch-ready` cannot bypass this
source recheck. No synthetic override exists for request evidence. The worker
gets scenario data, not ticket-defined authority. Same-receipt preparation is
idempotent; completed/uncertain workers are not relaunched. Updates after review
require explicit reconciliation, not automatic second PRs. Configuring RSI
continues using the existing outcome-capture gates.

### System-owned execution

`run-test-request` replaces an operator-authored handoff with a bounded live SDK
FILTER session. It reads the real request, reads only pinned source, records the
capability decision, and passes an eligible model-authored plan directly to the
existing planner/PROPOSER/native-validation/Draft-PR gates. The model has no shell,
source mutation, browser or publication tool. Review success alone cannot publish.

```powershell
node src/cli.js run-test-request --id 123 --authorize-review --authorize-comment --config request.local.json
node src/cli.js run-test-request --id 123 --authorize-review --execute --authorize-commit --authorize-push --authorize-draft-pr --authorize-comment --config request.local.json
node src/cli.js run-test-request-queue --authorize-review --authorize-comment --config request.local.json
```

The first command reviews and prepares eligible work without dispatch. The second
allows existing independently approved publication gates. Held requests post the
source-bound reason; validated coverage results post their actual Draft PR URL.
The queue command is one finite tick, not a background service; it uses the same
flags for execution. It queries only the approved area/type/state/tag and fails
closed on overflow instead of silently processing a truncated queue. Configure a
separately approved scheduler to invoke ticks; no shared daily deployment changes
or service installation are made by these commands.

Required `adoTestRequests.automation` fields are `enabled`, `scopeApproved`,
`approvalRef`, `model`, `maxRequests` (1..20), and `sourcePaths` (bounded committed
files/directories). Optional `environmentEvidence` contains bounded operator
observations, never authority. Queue discovery additionally requires `queue` with
`enabled`, `scopeApproved`, `approvalRef`, and `maxItems` (1..20). Use the existing
approved standalone `localFilter` limits/source pins and credit-policy acceptance;
its source revision must match repository qualification. Feedback needs its
independent policy; publication needs normal repository/dispatch grants.

Set `automation.requireSupportMatrix: true` to require a fully read skill entry
and a per-requirement `support` result. Its `skill` state is `supported`,
`unsupported`, or `unknown`; its separate `environment` state is `ready`, `blocked`,
or `unknown`. Each requirement cites completely delivered pinned files. Schema
expressibility, registered native actions/verifiers, lifecycle registration and
skill write bounds all matter. Missing runtime access is not a missing assertion.
A blocked environment cannot dispatch even when every business assertion is
supported. Revise sample requirements only with user authorization; never drop an
assertion merely to turn a blocked run green. Recollect the changed ADO revision.

Source requests may execute concurrently. Each receives its own immutable call ID
before awaiting Git, and finish waits for all outstanding reads; receipt collisions
must never make a successfully delivered source appear unreadable. Source errors
are retained separately from successful read receipts.

Each request holds a ledger lock. Started/interrupted model or dispatch attempts
are never automatically retried. Completed receipts are replayed. ADO feedback
increments work-item revision: unchanged selected fields can reuse a completed
feedback/result receipt, but never authorize new work from an old review. Changed
request content or source pins require fresh review or explicit reconciliation.
Failed or uncertain feedback retains the existing no-blind-repost gate.

Known limits: incomplete templates currently return missing fields in the command
result; automatic clarification comments and automatic harness implementation are
not provided by this command. A `needs-harness` result uses the separately reviewed
harness-request lane. A blocked live environment remains blocked, not a validated
coverage claim. Autonomous successful product qualification and a durable watcher
must be demonstrated separately before calling the full self-service system live.

### Scope of the low-level handoff commands

The CLI returns clarification fields, prepared assignment IDs and normal worker
results/PR links. The opt-in [harness-support lane](ADO-HARNESS-REQUESTS.md) adds
source-bound capability holds, authorized ADO gap/validated-harness-PR comments,
and tag-requested agent authoring of a separate harness Draft before coverage.
It does not watch the queue, fetch attachments, create sample work items, or deploy
a schedule. There is no promise of immediate pickup just because a crew files an ADO.

Offline qualification uses injected ADO/model/PR boundaries with disposable Git
and SQLite resources, but real planning, bounded file tools, commit, validation,
local-bare push and RSI capture. The sample test also fails against an intentional
formula-to-value mutation. This proves the controller path and its synthetic
oracle; it is not an Office/Excel browser E2E run or proof of a new product bug.
For live qualification select a real work item, inspect the qualified product
harness and native behavior, and preserve a test-only Draft PR for review. Never
merge an experiment output automatically.

## Crew-authored ADO test requests

This is an opt-in **explicit-ID intake and reviewed handoff**, not an automatic
queue watcher. The existing resolved Fixed/Duplicate bug collector, FILTER
cohort and daily deployment remain unchanged. Request evidence has its own
`ado-test-request` kind and namespace; it is not relabeled as a resolved bug,
confirmed defect or synthetic reviewed-handoff fixture.

### Crew workflow

Generate a shareable **new Bug link with the five-field template prefilled**:

```powershell
node scripts/create-ado-request-link.mjs
```

The link uses plain-text Markdown in `System.Description`, not HTML in the URL.
It includes the title prefix, area and tag. Replace the bracketed guidance in the
new form before saving. This generates a link only; it never creates a work item
or changes intake activation. ADO rich-text wrappers around the Markdown are
accepted by intake. The [copyable table](ado-test-request.template.md) remains
available as a fallback. The owner-selected area is
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

[The sample request](ado-test-request.sample.md) asks for duplicate removal that
preserves row-relative formulas. It is a synthetic experiment, not a real bug
report. Its observable assertions are designed to distinguish correct output
from a superficially correct row count or hard-coded calculated values.

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

### Scope of this increment

The CLI returns clarification fields, prepared assignment IDs and normal worker
results/PR links for the operator to relay. It **does not yet comment on ADO,
watch the queue, fetch attachments, create sample work items, or deploy a
schedule**. Those require separately approved transport and recovery contracts.
There is no promise of immediate pickup just because a crew files an ADO.

Offline qualification uses injected ADO/model/PR boundaries with disposable Git
and SQLite resources, but real planning, bounded file tools, commit, validation,
local-bare push and RSI capture. The sample test also fails against an intentional
formula-to-value mutation. This proves the controller path and its synthetic
oracle; it is not an Office/Excel browser E2E run or proof of a new product bug.
For live qualification select a real work item, inspect the qualified product
harness and native behavior, and preserve a test-only Draft PR for review. Never
merge an experiment output automatically.

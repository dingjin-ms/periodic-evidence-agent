## Harness support for explicit ADO E2E requests

The agentic system owns harness authoring. Feature crews describe their E2E case;
they do not design selectors, modify readers or implement the harness themselves.
This extends the explicit-ID intake in [ADO-TEST-REQUESTS.md](ADO-TEST-REQUESTS.md).
It does not deploy an ADO watcher or change the resolved-bug scanner.

### Flow

1. The reviewing agent inspects the original request and pinned cross-app harness.
   Submit a source-bound capability assessment. Distinguish `needs-harness` from
   `needs-evidence`, `blocked-environment`, and `supported`.
2. For a proven gap, the controller can post a bounded comment on that same ADO:
   “not yet supported by the test harness,” the missing capability, and the exact
   opt-in tag `AgenticHarnessRequest`. This does not claim a product defect.
3. The requester adds that tag, retaining `AgenticTestRequest`. Collect the new
   revision and reassess it. The agent prepares a harness-only handoff; the normal
   bounded SDK proposer authors the reusable mechanisms and their contract tests.
   The controller validates, commits, pushes and opens a separate Draft PR only
   with the existing explicit execution grants.
4. Link the validated harness Draft back to the ADO. Human review and integration
   remain outside the autonomous loop. Do not add the product coverage scenario
   to the harness Draft or relax its original assertions.
5. After integration, qualify the new harness revision and submit a `supported`
   assessment with verification evidence. The agent then prepares the original
   coverage handoff against that revision. PR creation alone never clears the hold.

The current transport uses the tag, not arbitrary comment text, as the authoring
opt-in. An ADO description, tag or comment cannot grant repository write scope,
model access, authentication, commit/push permission or merge authorization.

### Configuration

The inert intake policy example contains independent `feedback` and
`harnessSupport` sections. Enable them only in an approved task-owned config.
Feedback requires `enabled`, `scopeApproved`, `approvalRef` and the invocation's
`--authorize-comment`, plus `statePolicy.accessApproved` before opening the ledger.
Feedback grants are checked at each publication but excluded from the immutable
intake policy hash: enabling feedback does not require editing the ADO revision.
Scope, routing and harness-authoring policy remain pinned. Pre-release receipts
created with the old full-policy hash require explicit migration; no old receipt
is silently rewritten by this change.
Harness support requires its own approved section and a
qualified repository-native binding for capability `e2e-harness-authoring`, outcome
`extend-e2e-harness`, on the same configured repository.

Configure harness write prefixes narrowly (readers, schemas, runner helpers and
harness contract tests), disjoint from the coverage binding's scenario prefixes
and files. Existing coverage bounds are not widened. The binding must use the
bounded local `copilot-sdk` authoring provider without declarative scenario input.
A real repository-owned harness-authoring skill and validation gates must be
qualified before execution; the controller does not create or pretend to qualify
that product skill. Other authoring providers are rejected in this increment.
Both ADO coverage and harness assignments must select the final local SDK
executor. `agency-remote`, `agency-local` and hosted Agency selections are
explicitly unsupported for this evidence lane until their complete source-hold
lifecycle is integrated. Preparation and shared dispatch reject them, including
previously persisted assignments; the configured-model/remote-seed paths also
recheck before effects. No seed push or remote launch is authorized by an ADO
request. This restriction does not change those providers for other evidence
lanes. Do not silently switch providers to bypass it.

If `repo.draftBuild.enabled` is enabled (including 1JS), supply a separate
`repo.draftBuild.harness` contract: `enabled: true`, `scopeApproved: true`, an
`approvalRef`, `provider: "ado"`, a unique `id`, a positive `definitionId` different
from the coverage pipeline, `testPaths` naming 1–100 committed regular harness
contract-test files inside the assignment write scope, and optional bounded
`templateParameters`. The pipeline owner must approve/implement the
`harnessSelection` JSON parameter (`harness-contract-selection-v1`: base/source
revisions, test paths, contract hash). It must run those tests at `sourceVersion`.
No pipeline is configured by this change. Missing/unapproved contracts block
before push; there is no fallback to the product new-scenario pipeline. Coverage
assignments retain the existing `newCaseSelection` gate unchanged. The queued
receipt and PR description explicitly label harness-only remote validation.

With `harnessSupport.enabled`, coverage preparation and dispatch require a current
`supported` assessment. In legacy configurations without this opt-in, the old
coverage path stays compatible; recording a gap still holds that request.

### Agent/controller commands

Run intake first and preserve its receipt. The upstream reviewing agent produces
this JSON (IDs, revision, paths and timestamps must come from actual inspection):

```json
{
  "format": "ado-test-request-capability-v1",
  "intakeId": "test-request-REPLACE",
  "intakeSha256": "REPLACE_WITH_RECEIPT_SHA256",
  "sourceRevision": "REPLACE_WITH_QUALIFIED_COMMIT",
  "reviewedAt": "2026-10-27T00:00:00Z",
  "reviewer": "configured-reviewing-agent",
  "decision": "needs-harness",
  "missingCapabilities": ["The workbook reader does not retain formula metadata."],
  "sourcePaths": ["ooui/apps/cross-office-client-e2e/e2e/xlsxWorkbookData.ts"],
  "rationale": "Inspection shows cached scalar results cannot establish formula preservation.",
  "verificationEvidence": []
}
```

```powershell
node src/cli.js assess-test-request --file assessment.local.json --config pilot.local.json
node src/cli.js comment-test-request --assessment CAPABILITY_RECEIPT_ID --authorize-comment --config pilot.local.json
```

The second command is an external write, unlike intake/review. Only selected
scope IDs can receive comments. HTML is escaped; raw request data, credentials
and arbitrary reviewer prose are not copied to ADO. Network operations are
bounded, redirects are rejected and only the configured ADO host is used.

After the exact tag appears and the new intake is assessed, produce the same
review/planning structure as `ado-test-request-handoff-v1`, with these differences:

- `format`: `ado-harness-request-handoff-v1`.
- `planning.improvement.category`: `test-maintainability`.
- `planning.improvement.capabilities`: `["e2e-harness-authoring"]`.
- `planning.testCoverage.capability`: `e2e-harness-authoring`.
- `planning.requestedOutcome`: `extend-e2e-harness`.
- Source revision matches both the assessment and the harness binding qualification.
- Review describes the harness behavior, keeps product claims separate, and lists
  required positive/negative contract tests. No declarative product scenario input.

The existing `testCoverage` planning record describes harness contract-test gaps
in this lane; it is not permission to generate the original E2E coverage scenario.
All exclusion review, repository ownership, validation and publication checks
still apply. The current format supports reviewed functional harness mechanisms,
not a general infrastructure/product-maintenance exemption.

```powershell
node src/cli.js submit-test-request --file harness-handoff.local.json --prepare --config pilot.local.json
node src/cli.js submit-test-request --file harness-handoff.local.json --execute --authorize-commit --authorize-push --authorize-draft-pr --config pilot.local.json
node src/cli.js comment-test-request --assessment CAPABILITY_RECEIPT_ID --assignment HARNESS_ASSIGNMENT_ID --authorize-comment --config pilot.local.json
```

These explicit commands are orchestration entrypoints, not a background service.
The upstream agent invokes them; it supplies a real review rather than an invented
FILTER result. No new model/provider selection or daily configuration is installed.

### Recovery and qualification

- Harness and coverage use distinct source-bound assignment identities. The
  original ADO revision is rechecked before either can dispatch, before branch
  push and before Draft creation. Shared assignment admission rechecks capability
  holds and source-bound review/policy at publication boundaries as well as
  dispatch. A new hold retains authored source/validation as blocked work without
  publishing it; a hold arriving during push blocks subsequent build/PR effects
  without pretending an already completed push was undone. An ordinary `dispatch`
  cannot bypass the dedicated entrypoint. Production Git-push, ADO-build and
  ADO-Draft transports also recheck after authentication and PR lookup, at the
  actual mutation boundary. A final synchronous ledger check follows each source
  refresh with no intervening awaited work. Comment feedback similarly reads the
  source after authentication. These checks cannot undo a remote write already
  accepted while a later hold arrives; retained operation receipts remain the
  authority for that case.
- ADO test-request work is explicitly unsupported through `appWorker`: preparation,
  claim (including replay), binding and result actions reject this evidence kind.
  Use the dedicated source-rechecking controller. Existing app-native work for
  other evidence kinds is unchanged; no app-native grants are inferred from a
  prepared test-request assignment.
- Replaying a handoff does not create another assignment. Existing harness work
  from another revision requires reconciliation, not a second proposal. Completed
  or uncertain workers are not relaunched automatically. Equivalent capability
  reassessment (only the review timestamp changed) returns the existing receipt,
  preserving prepared work and Draft feedback. A separate latest-review timestamp
  advances monotonically; delayed decisions cannot clear a more recently reviewed
  hold. A material assessment change still invalidates the old handoff.
- Feedback persists an operation before POST. Same request revision/gap/harness
  revision reuses its completed comment receipt, even if reviewed again. A timeout,
  malformed acknowledgement or crash leaves an uncertain operation: inspect the
  receipt marker on the ADO and reconcile; there is no blind automatic repost or
  lock stealing. Any unresolved write blocks publication for the logical ADO
  request across revisions, even after recollection. Posting requires the
  captured revision still to match; if the ticket changes, recollect and review.
- Definitive HTTP 401/403 rejections retain their status as `rejected`, not
  ambiguous acceptance. After restoring authorization, the same publication can
  use `--retry-rejected` (with `--authorize-comment`). Retries remain source-checked,
  serialized and retain the previous attempt evidence.
- Returning from any historical proven gap to `supported` requires a different
  qualified revision and nonempty verification evidence. Evidence references are
  reviewer-attested, not an automatic proof that a PR merged or a live E2E passed.
  An intermediate `needs-evidence` state does not remove this requirement.
- Existing coverage assignments still follow the repository's normal explicit
  reconciliation rule; the new lane does not silently supersede prior work.

A title-only ADO revision can be associated with an existing validated harness
Draft for reporting, without rewriting its assignment or rerunning the proposer.
After collection/reassessment, supply `assignmentId`, current `assessmentId`,
`reviewer`, `reviewedAt` and `evidenceRef` to the explicitly authorized command:

```powershell
node src/cli.js reconcile-harness-association --file association.local.json --authorize-reconciliation --config pilot.local.json
```

It re-reads the ADO source, compares the original and current scope/template/tags
(all captured fields except title), requires the same gap and harness revision,
and binds the exact validated result to the current capture. Only then can
`comment-test-request --assessment CURRENT --assignment EXISTING` report the Draft.
Other scenario changes require substantive reconciliation; this operation does
not grant execution, clear the coverage hold, or bypass uncertain-write blocking.

For a genuinely uncertain write, an authorized operator must inspect the exact
ADO comment history/receipt marker and supply a reconciliation document:
`operationId`, `expectedOperationSha256` (SHA-256 of `JSON.stringify(operationRow)`
from ledger status), `disposition` (`posted` or `not-posted`), `commentId` (positive
integer for posted, null otherwise), `reviewer`, `reviewedAt`, and `evidenceRef`.
This is an explicit human-attested decision, not automatic proof of remote absence.
Never attest `not-posted` from a timeout alone. Confirm the original publisher has
terminated and no request remains in flight before reconciliation; this command
is not a way to steal a live publisher's ownership. The CLI checks the exact unchanged
operation and approval, records the decision, and performs no remote write.
A confirmed `posted` result becomes the completed receipt; confirmed `not-posted`
permits an explicitly requested `--retry-rejected` publication.

```powershell
node src/cli.js reconcile-test-request-comment --file reconciliation.local.json --authorize-reconciliation --config pilot.local.json
```

The comment transport sends explicit `format=html`, as required by the
[ADO comments API contract](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/comments/add-work-item-comment?view=azure-devops-rest-7.1).

Offline tests exercise real SQLite, isolated Git, bounded worker tools, commit,
validation and local-bare push, with injected model/ADO/Draft boundaries. They
check tag/scope/policy/source gates, negative formula evidence, disjoint writes,
replay and uncertain comment delivery. They do not claim a real SuperApp run,
live ADO comment, product harness implementation, or deployment.

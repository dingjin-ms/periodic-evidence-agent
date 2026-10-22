# Run the agentic loop with RSI enabled

This operator runbook follows **Collector -> FILTER -> Proposer -> RSI** using
the existing Copilot App host and durable controller ledger. RSI inspects the
agent system's outcome; it does not turn a product bug into permission to
modify the controller. A blocked, partial or no-candidate flow can still supply
an RSI observation.

**Source baseline:** `ec269c3fb318acd7a7cbd7b491edeff0a64a1551` on `master`.
Commands and contracts below were checked against that revision. Record the
revision you actually run; do not apply this guide to an older checkout or
change the controller/configuration underneath an existing run.

**There is no single invocation that starts and proves a live full loop.**
`agent ROLE COMMAND` delegates an existing helper; it does not execute the role
skill. The app host supplies collection/review/execution handoffs. Opt-in RSI
automation can continue in that same app model, but its `awaiting-host` requests
must actually be consumed. The optional [one-shot controls](../ONE-SHOT.md)
reserve bounded work; they still require an authorized external FILTER executor.
Neither path establishes universal unattended operation.

## 1. Prepare without authorizing a live run

Use Node.js 24+, npm, Git and, on Windows, PowerShell 7.3+ with a working
`PATHEXT` including `.EXE`. Use a dedicated controller checkout with protected,
local, gitignored state, not network-shared SQLite. Preserve that checkout and
its ledger through review/resumption. An app conversation is an execution
handle, not the state owner.

From the controller root, this is an **account-free preparatory check**, not
the live loop:

```powershell
git rev-parse HEAD
npm ci --ignore-scripts
npm run demo
```

`synthetic-demo-passed` means fixture assertions passed. The demo deliberately
retains incomplete source coverage and uses simulated model/publication
boundaries; it creates no real product PR. See [demo coverage](../README.md#offline-demo-coverage).
The separate `self-improvement` command qualifies a current/current recovery
harness; it is not the end-of-flow `rsi` runner and does not prove benefit from
a candidate. Its explicit policy, owner and retention requirements are in
[offline qualification](../APP-NATIVE.md#offline-self-improvement-qualification).
Do not use its `.state\rsi` store as a producer-flow ledger.

Optional `npm run setup` is the broader devbox preparation: locked controller
dependencies, configured product checkouts/skill qualification, diagnostics,
offline checks and demo. It does not authenticate, install product dependencies
or authorize writes. Use `--allow-clone` only with cloning approval. See
[setup](../README.md#devbox-repository-setup); do not run setup merely to inspect
an existing flow.

Create a local configuration only if one does not already exist:

```powershell
if (-not (Test-Path .\pilot.local.json)) {
  Copy-Item .\pilot.example.json .\pilot.local.json
}
```

Use **`pilot.example.json`**, not the portable
`configuration.template.json`, as the runtime starting point. All examples in
this guide are templates: `EXACT_*`, `APPROVED_*`, `example/agent-system`,
`operator@example.invalid` and `C:\private\...` are local placeholders, not
identities, grants or usable source receipts. Keep configurations, request
files, evidence, private evaluation plans and receipts out of Git. Never put
credentials, headers, cookies, raw workplace content or actual incident details
in this runbook or a public PR.

Before beginning, the operator must resolve and explicitly approve:

| Boundary | Required decision |
| --- | --- |
| Host and state | `executionMode: "app-native"`, stable `agent.id`, approved `stateDirectory`, `statePolicy.accessApproved: true`, `retention: "bounded-local"` and `rawEvidenceDays` from 1 to 7. |
| Source scope | Designated delegated user/tenant/object ID; exact enabled sources and `scopeApproved`; WorkIQ seed resources; half-open UTC `window.start`/`window.end`; permitted follow-up depth/items/calls. Empty scope is not tenant-wide access. |
| Finite execution | Explicit `limits.maxItems`, `maxCalls`, assignment/concurrency limits, `workerMinutes`, `workerMaxToolCalls`, credit/file/repair bounds as required by the selected executor. `null` is unresolved, not unlimited. |
| Activation | `activation.collect`, `review`, `dispatch` default false and are separate grants. For the production path below, approve the required settings **before** `app-begin`; do not flip them mid-run. Keep `schedule.enabled: false`. |
| Repository work | Exact owner/routing rules, configured app project, trusted remote, clean reference/base/target revision, bounded writes, commit identity, validation gates and draft policy. Primary checkouts are references only. |
| Skills and sharing | Discover the four project skills. Qualify the selected repo-native binding at its exact source/skill/validation-contract hashes. Approve each material's audience before sharing FILTER inputs. |
| RSI | Agent-system target, independent baseline, write scope, capture/proposal limits; separate authoring, commit, evaluation and optional publication approvals as described below. |

These gates are cumulative. Skill installation, an enabled flag, a successful
identity read or a prepared assignment does not grant the other permissions.
The configured `agent-evidence-review` policy does not add a new human approval
for each eligible finding; unresolved scope, sharing, execution and publication
authority still require the operator's decision.

The deployed ADO adapter has **fixed product-specific selectors**, documented
in [configuration](../README.md#configuring-an-authorized-manual-pilot).
It is not a generic organization/area adapter. Both created and changed lanes
require `System.State` **Resolved or Closed** AND
`Microsoft.VSTS.Common.ResolvedReason` **Fixed or Duplicate**. There is no
`System.Reason` fallback. Changing deployment scope requires a reviewed adapter
change, not a substituted query.

For repository work, Proposer selects only `evidence-1js-owner`,
`evidence-office-owner` or `evidence-oa-owner` for its configured repository.
Unknown ownership/binding is blocked. Qualification is read-only and does not
enable routing or side effects:

```powershell
npm run pilot -- qualify-skill --repo APPROVED_REPO_ID --capability APPROVED_CAPABILITY --binding APPROVED_BINDING_ID --config .\pilot.local.json
npm run pilot -- doctor --config .\pilot.local.json
npm run pilot -- agents
```

`doctor` is configuration diagnostics, not authentication, live validation or
E2E qualification. Product dependency/authentication and native validation
prerequisites remain separate; use the [execution guide](../EXECUTION-GUIDE.md)
and the selected owner skill, not guessed commands.

## 2. Choose the RSI policy before the producer begins

### Capture-only is the safe first opt-in

RSI is disabled when `rsi` is absent or exactly `{ "enabled": false }`.
Add this object as **the `rsi` property** of the approved runtime configuration,
replacing the target and narrowing write prefixes to the intended scope:

```json
{
  "enabled": true,
  "targetRepository": "example/agent-system",
  "allowedWritePrefixes": ["src", "test", ".github/skills"],
  "maxObservations": 20,
  "maxObservationBytes": 1048576,
  "maxProposals": 2,
  "allowDraftPR": false
}
```

This matches [the policy example](rsi-flow.example.json). It authorizes bounded
capture only when local storage is approved. It does **not** launch a model,
grant edits/commits, publish a PR or merge. Without `automation`, the owner must
invoke `evidence-rsi` on the returned handoff in the approved host.

To permit a later **manual** candidate proposal, also pin `rsi.targetBaseline`
before starting the producer:

```json
{
  "referenceCheckout": "C:\\private\\agent-reference",
  "revision": "EXACT_BASELINE_40_HEX_SHA",
  "branch": "APPROVED_TARGET_BRANCH"
}
```

The reference must be clean at that local branch and revision, with an origin
matching `targetRepository`. A capture-only flow without this pin remains
analysis-only. Do not choose a later ancestor after authoring to hide edits.

### App-hosted authoring and paired evaluation

For an approved operational attempt, add `rsi.automation` **before** beginning
the producer. The following is a shape/example budget, not approval to spend it:

```json
{
  "executionMode": "app-hosted",
  "authoringApproved": true,
  "localCommitApproved": true,
  "referenceCheckout": "C:\\private\\agent-reference",
  "baselineRevision": "EXACT_BASELINE_40_HEX_SHA",
  "targetBranch": "APPROVED_TARGET_BRANCH",
  "gitAuthor": {
    "name": "Approved operator",
    "email": "operator@example.invalid"
  },
  "timeoutMs": 1800000,
  "maxToolCalls": 100,
  "maxFileBytes": 262144,
  "maxWorkspaceBytes": 536870912,
  "evaluation": {
    "flowPlan": {
      "path": "C:\\private\\evaluation\\flow-plan.local.json",
      "sha256": "EXACT_PLAN_SHA256"
    },
    "timeoutMs": 600000,
    "cases": [
      {
        "id": "recovery-case",
        "population": "recovery",
        "assertions": ["collector-recorded", "filter-recorded", "proposer-validated"]
      },
      {
        "id": "healthy-case",
        "population": "healthy",
        "assertions": ["collector-recorded", "filter-recorded", "proposer-validated"]
      },
      {
        "id": "guard-case",
        "population": "guard",
        "assertions": ["unauthorized-dispatch-refused"]
      }
    ]
  }
}
```

Supply a real, independently reviewed plan matching that ordered case/assertion
inventory; labels alone are not assertions. The schema is
[`$defs.rsiAutomation`](contracts.schema.json). Keep `allowDraftPR: false`
unless the optional publication step was separately approved before the run.
If `targetBaseline` is also supplied, it must agree exactly with automation.

This mode uses the **existing app model**. Omit `authoringProvider` and
`maxAiCredits`; they are rejected in `app-hosted` mode. `maxToolCalls` is a host
instruction, not an enforced app-tool counter. App model-credit and in-flight
tool enforcement remain the host's responsibility.

The reference must be a dedicated **full clean clone** (`.git` directory, not
an app worktree's `.git` file), fit within one third of `maxWorkspaceBytes`,
and match the pinned target. The controller creates separate baseline and
candidate clones. The evaluation plan must be outside both source checkouts,
hash-pinned before authoring, within its approved raw-data lease, and satisfy
[the app-role plan contract](../APP-NATIVE.md#evaluation-through-the-existing-app-roles):

- Each case embeds a complete app-native config with
  `stateDirectory: "${state}"` and RSI disabled. Steps begin with `app-begin`,
  visit Collector, FILTER and Proposer in order, then finish with `app-end`.
- Collector inputs are pinned captured receipts, not new independent source
  reads in each arm; preserve their real provenance. Collector `hostInput`
  is forbidden. FILTER/Proposer may yield semantic inputs to the same host.
- Non-guard cases need a ledger-backed intended-work marker and ledger-backed
  assertions for **every role**. Bind real terminal assignment/validation
  outcomes, not only preparation, an empty cohort, exit zero or an envelope.
- Predicates use exact step IDs, JSON pointers and `equals`; ledger predicates
  use relative case-local paths and one bounded read-only `SELECT`. The fixed
  controller evaluates them, not the candidate or authoring model.

The clones need already-approved dependencies resolvable by Node. The runner
does not install packages or authenticate. If no meaningful plan, source-bound
validation binding or required host capability exists, stop at capture/analysis;
do not invent passing predicates to make this example executable.

### Optional standalone native adapter, not an app fallback

`rsi.automation.executionMode: "native"` (also the omitted-mode compatibility
default) requires an existing configured `authoringProviders` entry of type
`agency-local`, an absolute executable, a named profile, `authoringProvider`
and finite `maxAiCredits`. It exposes only the five restricted `pilot_*` tools.
Native evaluation uses `driverPath`, `driverSha256`, declared
`dependencies: [{path, sha256}]`, timeout and the same three case populations;
it cannot use `flowPlan`. See [the native contract](../APP-NATIVE.md#opt-in-native-rsi-execution).

The driver exports `runFlow({workspace, revision, observation, cases, directory})`
and owns intended-work assertions. Pin its complete reviewed dependency closure
outside both checkouts. The source/process boundaries are not a hostile-code
sandbox. Native mode is not required for the app path, not an SDK fallback and
not permission to install a host, change profiles or retry an uncertain attempt.

## 3. Begin one finite producer flow and collect

For the production app-native path below, use one approved, unchanged
`pilot.local.json` and one new run ID. Create an ignored `begin.local.json`:

```json
{
  "runId": "example-rsi-run",
  "executorSessionId": "ACTUAL_APP_SESSION_HANDLE",
  "dryRun": false,
  "provenance": "app-tool"
}
```

Replace the session handle with the actual host handle (or omit the optional
field). `app-tool` is only for actual app/source work, never synthetic fixtures.
Run IDs use 1-128 ASCII letters/digits/dot/dash/underscore, beginning with a
letter or digit. First inspect existing runs; begin only if this is new work:

```powershell
$RunId = 'example-rsi-run'
npm run pilot -- agent collector app-runs --config .\pilot.local.json
npm run pilot -- agent collector app-begin --file .\begin.local.json --config .\pilot.local.json
npm run pilot -- agent collector app-status --run $RunId --production --config .\pilot.local.json
```

`app-begin` takes the namespace from its JSON; subsequent production operations
need `--production`. A `dryRun: true` run uses separate collection-only storage
and cannot review/dispatch. Adding `--production` cannot promote it.
Creation binds the original RSI controller, skill, configuration and target
baseline atomically before execution.

Give the existing host a bounded instruction such as:

> Use evidence-collector for the approved run and configuration. Read persisted
> status first. Collect only the approved source passes, UTC window and budgets;
> persist exact receipts and explicit gaps. Do not review, dispatch, extend
> scope, retry authentication or change configuration.

The host follows the [Collector skill](../.github/skills/evidence-collector/SKILL.md)
and [receipt contracts](../APP-NATIVE.md#receipt-batch-schema). For WorkIQ it
verifies this host's exact `/me` ID and UPN, then imports permitted responses
incrementally:

```powershell
npm run pilot -- agent collector app-append --run $RunId --production --file .\receipt-batch.local.json --config .\pilot.local.json
```

Receipt files carry actual event/call IDs, UTC observations, request paths,
response bytes, source revisions, `asOf` and continuation links. The helper
does not call app tools; imports are `app-tool-reported`, not independently
authenticated local execution. Do not fabricate receipts from summaries.

Only if separately authorized, the direct ADO adapter executes these two
distinct passes; **these commands make network reads**:

```powershell
npm run pilot -- agent collector app-ado --run $RunId --production --pass ado:created --collect --config .\pilot.local.json
npm run pilot -- agent collector app-ado --run $RunId --production --pass ado:changed --collect --config .\pilot.local.json
```

Preserve created/changed counts separately. For WorkIQ, exhaust roots and
replies, including replies to old roots; follow only the recorded next request.
Metadata without bodies/revisions is incomplete evidence. Item and read-call
budgets include examined out-of-window records and identity calls, not just
findings. A modified-time lane needs separate approval and is not a delta feed.

Unavailable IcM remains unknown coverage: record `app-unavailable` with
`{"pass":"icm:created","reason":"no-approved-connector"}` rather than inventing
zero incidents. The separately approved incident-created receipt mode is not
saved-query timestamp equivalence; see [its contract](../APP-NATIVE.md#explicit-incident-created-icm-receipts).
No related-link reads are implicit.

**Checkpoint:** read `app-status` and retain `summaryPath`, exact per-pass
states, evidence/capture references and counts. `complete` is collection-only
completeness, not review/validation/E2E success. The app summary includes the
standard passes; an unavailable/not-started source can keep it
`partial-or-blocked` even when the approved selected passes are exhausted.
Report that scope honestly. Do not promote partial coverage to a complete
cohort. If the intended scope cannot complete, end the flow at step 6 and let
RSI inspect the real blocker; an explicitly limited review must remain labeled
limited, not a successful complete-cohort handoff.

## 4. FILTER: review the exact evidence, then hold or route

Invoke `evidence-filter` in the approved host with the recorded run, source
versions and acceptance scope. It uses the coordinator/planner procedures;
these are not extra agents to spawn. Read all retained complete records and
apply all 14 typed scanner exclusions to defects **and** improvements.
Title-only screening excludes only obvious cases with an exact quote and
reason; ambiguous/missing titles retain details. Unknown ownership, missing
records, conflicting analyses and unknown coverage remain blockers.

For the direct app-native review route, prepare the existing investigation
bundle, then persist it:

```powershell
npm run pilot -- agent filter app-review --run $RunId --production --file .\review.local.json --config .\pilot.local.json
npm run pilot -- agent filter app-plan-improvement --run $RunId --production --file .\plan.local.json --config .\pilot.local.json
```

`review.local.json` is `{ "investigation": <record>, "exclusionsChecked": [...] }`,
with all exclusions and exact evidence IDs. Follow
[the investigation identity/version contract](../APP-NATIVE.md#native-repo-agent-tracking-not-activated-in-this-pilot),
not a made-up ID. The planning command is for eligible coverage improvements;
it persists `areaToImprove` and `testCoveragePlan` before assignment. These
commands record the host's review, not helper-launched semantic execution.
Direct app review is not a qualified hosted batch/cohort execution receipt.

For complete-record **batch** execution, instead use the existing
`filter-batches` -> authorized executor -> `filter-batch-check` ->
`filter-consolidate` / `filter-execution-check` path. Preserve every record,
related-context group, sharing approval, tokenizer/reserve budget, original
request/result hash and immutable execution receipt. Oversized groups block;
never truncate. A structural check or one accepted batch is not complete-cohort
acceptance. The approved private hosted transport is not supplied by the public
CLI. Details: [batch contract](../APP-NATIVE.md#complete-record-filter-batches)
and [execution guide](../EXECUTION-GUIDE.md#5-collect-evidence-and-run-filter).

For a fresh one-shot cohort, reserve aggregate FILTER budgets before submission
and use `one-shot-handoff --check` / separately authorized `--execute`, not
structural consolidation alone. That route has distinct collection/execution
configurations, direct-adapter provenance requirements and its own immutable
authorization; do not graft it onto an already-begun app run.

Before proposing regression tests, invoke the installed coverage-analysis
skill and pinned coverage reference. Discover existing assertions/harnesses
first. Incomplete/empty search is `unknown`, not a gap. Keep `existingFixes`
and duplicate/canonical links even when the canonical bug is outside scope;
do not fetch it implicitly or claim canonical reconciliation.

For resolved ADO inputs, only a current complete coverage plan, qualified
test-authoring skill and bounded **test-only** assignment may pass. Known fixes
need `testCoveragePlan.existingFixesReview` bound to the current investigation,
complete evidence set, next/current plan version as applicable and inspected
repository revision. Every original fix URL appears exactly once. Only
`product-fix-with-remaining-coverage-gap` passes; satisfied, in-flight,
unresolved, missing or stale review blocks. Handoff inputs use
`routing.existingFixesReview`; plan inputs use `testCoverage.existingFixesReview`.
See [the reconciliation fields](../README.md#configuring-an-authorized-manual-pilot).

**Checkpoint:** persist exact review/plan versions, exclusions and held
candidate/no-candidate decision. A complete accepted cohort with no candidate
ends without Proposer; it can still proceed to RSI. Partial coverage is not
successful no-candidate completion.

## 5. Proposer: one claimed assignment, one isolated execution

Only after existing source/review/ownership/skill/activation gates admit work,
the coordinator prepares and claims the durable assignment. For the coverage
path, an ignored prepare file has this shape:

```json
{
  "investigationId": "EXACT_INVESTIGATION_ID",
  "repoId": "APPROVED_REPO_ID",
  "intent": "improvement",
  "testCoveragePlanId": "EXACT_PLAN_ID",
  "requestedOutcome": "add-or-update-tests"
}
```

Use the qualified binding's actual requested outcome, not necessarily the
example above. Then:

```powershell
npm run pilot -- agent proposer app-worker --run $RunId --production --operation prepare --file .\prepare.local.json --config .\pilot.local.json
npm run pilot -- agent proposer app-worker --run $RunId --production --operation claim --file .\worker-claim.local.json --config .\pilot.local.json
```

Claim input is `{assignmentId, claimId, coordinatorAgentId}`: the returned
assignment, a stable caller claim and configured durable `agent.id`.
Persist it **before** any external launch. `flights.proposerExecutor` selects
the existing local app-session or qualified hosted path; never fail over.
For local app execution, the approved host creates one isolated product
session/worktree for the configured project, supplies `evidence-proposer` and
the selected owner/native skill, then binds the actual handle:

```powershell
npm run pilot -- agent proposer app-worker --run $RunId --production --operation bind --file .\worker-bind.local.json --config .\pilot.local.json
```

Bind input is `{assignmentId, claimId, sessionId, projectId, workspace,
baseRevision}`. Use the actual isolated workspace and exact checked-out base.
Never execute in the product reference checkout. Helpers track the launch;
they do not create app sessions or enforce an OS sandbox. The parent app
continues to own the flow; the product session is not a replacement RSI host.

The owner may act only within its pinned assignment and skill write bounds.
Run only approved native validation against the **exact clean candidate HEAD**,
retain raw terminal results for every required gate and distinguish pending,
blocked, skipped and failed work. An idle session, PR policy badge or wrapper
exit zero is not source-bound validation. Do not retry/cancel/requeue without
authorization. Commit, push and draft creation are separately gated; no merge.

Return a durable result artifact with source revision, changes, gate/run IDs,
raw evidence references and any exact draft identity. Record:

```powershell
npm run pilot -- agent proposer app-worker --run $RunId --production --operation result --file .\worker-result.local.json --config .\pilot.local.json
```

Result input is `{assignmentId, claimId, sessionId, outcome, evidenceRef}`.
Outcomes are `rca-complete` (RCA-only assignments), `blocked`, or
`draft-reported`. **The app tracker leaves blocked/draft outcomes uncertain
and sets `validationQualified: false`.** It does not automatically qualify
product tests from the report. Keep external validation reconciliation visible;
do not relabel a code-change assignment as RCA-complete to clear it.

The standalone controlled proposer route described in the execution guide
owns model/validation/publication itself and has different terminal receipts;
do not mix its ledger/results with app-native tracking.

## 6. Complete the producer boundary and inspect RSI

With RSI enabled, terminal `app-worker` and `app-block` CLI actions already
capture the handoff; under automation they can also start/yield RSI execution.
Inspect their returned `rsi` field before issuing another command. At other
flow endings (including partial, failed and no-candidate), the owner calls:

```powershell
npm run pilot -- agent collector app-end --run $RunId --production --config .\pilot.local.json
npm run pilot -- agent rsi app-rsi-work --run $RunId --production --operation status --config .\pilot.local.json
```

**`app-end` is not a passive stop command when automation is approved.**
It captures the selected run and may advance that approved RSI execution.
It does not cancel in-flight work or certify all prior phases. Repeating the
same capture retains the same observation/task; do not rerun product work to
obtain a greener observation.

Save the exact observation/task IDs, payload hash, original controller/skill
pins and delivery/execution state. `nextRole: "rsi"` plus
`invocation: "host-must-invoke-skill"` means **queued for host execution**,
not that RSI ran. A role envelope's `acceptance: "not-inferred"` is intentional.
Inspect with `observation.local.json` containing only
`{"observationId":"EXACT_OBSERVATION_ID"}`:

```powershell
npm run pilot -- agent rsi app-rsi-work --run $RunId --production --operation inspect --file .\observation.local.json --config .\pilot.local.json
```

Without automation, invoke `evidence-rsi`, then claim before any authorized
manual authoring using `{observationId, claimId, executorId}` and
`app-rsi-work --operation claim --file .\rsi-claim.local.json`. Use a stable
claim and actual executor handle. Resume that claim, never steal it. The
manual `propose` / `result` schemas are
[`rsiProposalInput` / `rsiResultInput`](contracts.schema.json).
`no-change`, `insufficient-evidence` and `blocked` are legitimate results.
A manual proposal with artifact references is **not** independently verified
benefit. Do not claim evaluation that was not run.

For standalone worker-ledger outcomes, use `agent rsi rsi-work` (no `--run`
or `--production`). `status.undelivered` supplies exact `{workerResultId}`
requests for `--operation capture`; recover those immutable terminal results
before claiming. `unresolvedProducers` has no terminal result and calls for
reconciliation, not redispatch. App-native capture uses `app-end`, not `capture`.

## 7. Consume app-hosted continuations and compare both arms

If the original policy includes app-hosted automation, completion returns
`rsi.execution`. To discover/resume that same execution after interruption:

```powershell
npm run pilot -- agent rsi app-rsi-run --run $RunId --production --config .\pilot.local.json
```

Do not separately claim manual RSI work or launch another provider/session.
For every `state: "awaiting-host"`:

1. Read `invocation.ref`, verify its `sha256`, and load the exact
   `request.skill.path`/hash. Use `request.workspace`, which may be the
   baseline during evaluation. Keep original config, namespace, controller,
   execution ID and deadline.
2. Write the claim below with IDs/hash from that request and the **actual
   existing app session handle**, and submit it before semantic work.
3. Perform only `request.task`. Authoring uses `evidence-rsi` in the isolated
   candidate and returns `rsiSkillDecision`; the controller owns commit and
   evaluation admission. Evaluation uses the evaluated checkout's existing
   FILTER/Proposer skill and returns that command's **input**, never a grade.
4. Submit `action: "complete"` with the same IDs/hash/session and a `result`
   object matching the requested contract. Consume the next yield in the same
   host without another human prompt for already-approved work. If the host
   cannot continue, report the concrete blocker.

```json
{
  "executionId": "EXACT_EXECUTION_ID",
  "phase": "EXACT_PHASE",
  "requestSha256": "EXACT_REQUEST_SHA256",
  "hostSessionId": "ACTUAL_APP_SESSION_HANDLE",
  "action": "claim"
}
```

```powershell
npm run pilot -- agent rsi app-rsi-run --run $RunId --production --file .\host-action.local.json --config .\pilot.local.json
```

Authoring `propose-change` needs `title`, `description`, `findings` and the
complete `skillResult` (status, `fix:FAMILY` or `improvement:FAMILY`,
changed files, test/card lists, unknowns, human-decision flag). See
[`rsiSkillDecision` and `rsiHostAction`](contracts.schema.json); do not substitute
a prose success message. Identical completed actions can resume; conflicting
results, unknown in-flight effects or a different host cannot.

Keep original producer evidence intact. The candidate can change only allowed
prefixes, and never the protected judge/authority paths:
`src/rsi-*`, `src/self-improvement*`, `src/agents.js`, `src/common.js`,
`scaffold/contracts.schema.json`, `.github/skills/evidence-rsi*`.
Do not change permissions, budgets, evaluators, approval rules or protected
skill content to win. Checks cover the **whole pinned-target-to-candidate diff**,
clean HEAD, repository identity and target drift, not just declared edit names.

The fixed parent independently compares baseline/candidate runs using the same
observation, pinned plan/driver and case/assertion inventory. Both source
checkouts stay unchanged during evaluation; comparison arms do not publish.
Recovery/completion gain must preserve previously passing cases, healthy and
guard success, and assertion coverage, with no unknowns or violations.
Pre-work target failures remain unsuccessful selected cases, not excluded data.

Read retained `comparison.json` and `comparison.md` in the execution's
`rsi-executions` directory:

| Result | Meaning / next action |
| --- | --- |
| `demonstrated-benefit`, `qualified: true` | Gain on this exact common inventory only; proposal admission may proceed. |
| `no-demonstrated-benefit` | Equal correct outcomes or no verified gain; do not force an improvement PR. |
| `regression` | Lost passing behavior/coverage or failed controls; retain candidate and failure evidence. |
| `inconclusive` | Missing, mismatched or unknown evidence; not success. |
| execution `finished` with blocked result | Terminal attempt, not a qualified improvement; preserve the unblock condition. |
| execution `proposed`, `publication: "not-authorized"` | Qualified local proposal with draft publication disabled; a valid stopping point. |

No cost, token, recurrence, held-out generalization, product-coverage or
full-loop productivity gain follows from this comparison unless separately
measured. `modelExecutedByHelper: false` / `hostExecution: app-host-reported`
distinguish host reports from helper-launched model execution.

## 8. Optional draft publication, never automatic adoption

Default to the local proposal. If publication was explicitly approved in the
original policy (`rsi.allowDraftPR: true`), also require the host's existing
repository grant and public-content review. Do not edit an existing run's
config to turn publication on after seeing a result.

For app-hosted automation, **before claiming publication**, verify the app PR
tool can address the exact candidate clone. A current-session-only tool that
cannot target that clone is a capability blocker. Do not launch another host
or use a fallback publisher. The first publication host claim reserves the
stable key. Only its fresh response with
`invocation.publication.createAllowed: true` permits creation. Replayed/lost
acknowledgments are reconcile-only, even if no PR is immediately visible.

Use the supplied `[RSI]` title and retain the publication key in the body.
Include a sanitized before/after comparison and limitations, not private
paths, receipts, workplace evidence or internal product code. Ordinary
Proposer PRs do not use `[RSI]`. Complete the host action with:

```json
{
  "url": "https://github.com/example/agent-system/pull/1",
  "isDraft": true,
  "headRevision": "EXACT_CANDIDATE_40_HEX_SHA",
  "publicationKey": "EXACT_PUBLICATION_KEY"
}
```

This is the publication action's `result` object, not the entire host action.
Verify live repository, head/base and draft identity against the pinned
candidate/target before reporting it. The native automated publisher additionally
requires a **private** repository and exact live target SHA; public publishing
is blocked rather than implicitly approved.

Outside automation, reserve using `app-rsi-work --operation reserve-publication`
and the exact claim file before any external effect. Only its first
`createAllowed: true` response admits creation. Record the exact draft through
`--operation result` using `rsiResultInput`. Manual reservation/`draft-reported`
is a host receipt, not independent improvement qualification.

If push/create or its acknowledgment is uncertain, look up the original
branch/PR using the exact repository, candidate SHA and publication key.
Record the matching receipt only; never repeat creation, close the reservation
as no-change, or rewrite the ledger. Keep merge/auto-merge/deployment disabled.
Review, merge and adoption are separate human decisions. RSI must not feed
its own bookkeeping back into a new RSI flow; a later ordinary producer run
provides new evidence of whether an adopted change helped.

## 9. Observe, recover within bounds, and stop

Keep a private handoff record with the controller revision, unchanged config
path/hash, namespace/run/summary path, pass states/cursors, review/plan versions,
assignment/claim/session and source SHA, validation evidence, RSI
observation/task/execution/request IDs, baseline/candidate/comparison hashes,
publication key/receipt and next authorized owner. Chat text alone is not a
resume point.

| Condition | Bounded response |
| --- | --- |
| WorkIQ identity mismatch or explicit authentication failure | Retain partial evidence and the observed failure; stop reads. Another host's identity receipt is not proof for this host. No automatic CLI/Graph fallback, token transfer, auth probe loop or scheduled retry. Supported host refresh and a separately authorized attempt are required. |
| Validation `action-required-auth` | Explain the pinned Azure Artifacts credential provider requirement. If `requiresInstallApproval`, obtain approval. Run only the returned `remediation` from its declared `cwd`; the user completes Microsoft sign-in/MFA. Never capture credential diagnostics or ask for tokens. Retry the original controller command **once** after success; the assignment stays `prepared`. A second failure/decline remains blocked. |
| One-shot pre-dispatch authentication block | Use its single explicit `--resume-auth` only after the positive recorded pre-dispatch block and supported remediation, while the same prepared assignment has no workspace/result/provider operation. It is not a retry for ambiguous dispatch. Do not delete a trusted dependency-cache receipt to force auth. |
| Partial/over-cap collection or unavailable source | Retain counts, pending request and unexamined/unknown records; no complete-cohort release. Parser failure after ADO transport capture uses offline `app-ado-reconcile`, not another collection. An approved WorkIQ budget continuation is a **distinct** bounded run via `app-workiq-continue`; never renew caps in place or reuse expired nextLinks. |
| Stale config/controller/skill, target drift or evidence version | Resume with the original pinned owner/checkout/config, not today's skill. `stale-controller` is blocked. Reconcile the original attempt; new configuration requires separately authorized new work, not relabeling old evidence. |
| Unknown worker launch or validation/publication effect | Keep assignment, claim, handle and operation reservation. Use existing handle/receipt reconciliation; `app-worker --operation uncertain` records an unbound launch. Do not spawn, dispatch, retry, cancel or publish again. |
| Expired/changed/missing raw artifact | Inspection reports `expired`, `changed` or `unavailable`; immutable hashes do not recreate raw evidence. Do not recopy artifacts, renew their lease or infer successful execution. |
| Capture/storage/tool/deadline limit | Stop admission and preserve producer evidence. Do not raise caps, truncate evidence, drop selected cases or change evaluator/approval rules. Record the actual bound and blocked delivery separately from the producer outcome. |
| `awaiting-host` or interrupted RSI | Resume `app-rsi-run` without `--file` in the original controller, then the exact bound host request. Completed phases are reused; an unknown in-flight effect is blocked, not retried. |

### The capture-bound limitation at this revision

`maxObservationBytes` has a schema maximum of **1,048,576 bytes (1 MiB)**.
Previously, aggregated inline transport observations exceeding that bound
failed closed while retaining producer evidence; a collector-candidate adoption
was rolled back for future runs after such a failure.

At the source baseline above, oversized **app-event** payloads now retain
hash/byte/run/event references to their original producer ledger instead of
copying all receipt bodies into the observation. This is a lossless reference
path, not truncation or a raised cap. Use `app-rsi-work --operation read-event`
with `{observationId, index, page}`; decode/concatenate the base64 pages and
verify the full event hash before parsing. Pages are at most 16 KiB before
base64 encoding. Native reads use `rsi-events/INDEX/PAGE`.

The observation's remaining metadata/summary and worker trace captures still
fail closed when their bounds are exceeded. Deleted, changed or expired
referenced evidence cannot be read. Event expiry is measured from the original
run start plus `rawEvidenceDays`; reads never renew it. The fix does not repair
historical runs or establish live app-host qualification.

### Stopping and retention

For the main app path, stop initiating new reads, assignments or host actions;
persist the current truthful status and owner/blocker. Do not use `app-end`
as cancellation: with approved RSI automation it advances the completion
handoff. There is no generic RSI cancel/reset/rebudget command. Leave unknown
in-flight work for reconciliation. The optional `one-shot-stop` is cooperative
between passes, not cancellation of an active source request.

RSI's total persisted deadline includes restarts; each comparison arm also has
a persisted deadline including host yields. Schema ceilings are 60 minutes
total and 30 minutes per arm, not suggested grants. Budgets are not refunded,
and immutable RSI metadata is not automatically pruned. There is one active
RSI task per ledger; duplicate flow/failure-family proposals are rejected.
Configured execution-tree storage checks are not a hard OS quota.

Raw run artifacts retain the original 1-7 day policy. Existing source-capture
retention remains separate; immutable metadata is not a permanent raw copy.
CLI startup/exit can prune eligible completed/blocked raw-run artifacts;
active runs are not deleted. Use `state-prune --dry-run --config
.\pilot.local.json` for a preview, not a ledger reset. Never delete the whole
state tree to unblock work.

**Completion report:** distinguish collected scope, accepted review scope,
actual product execution/validation, RSI invocation, paired comparison and
draft publication. A legitimate finite result can be blocked, insufficient
evidence, no-change or an unpublished proposal. Offline fixtures, a queued
handoff and a green wrapper do not prove live semantic continuation, universal
unattended E2E, held-out generalization, reduced cost or improved productivity.

## Contract map

| Area | Authoritative implementation / procedure |
| --- | --- |
| Role routing and CLI flags | [`src/agents.js`](../src/agents.js), [`src/cli.js`](../src/cli.js), [project skills](../APP-NATIVE.md#project-skills) |
| Config, begin, receipt and app worker lifecycle | [`src/common.js`](../src/common.js), [`src/app-native.js`](../src/app-native.js), [APP-NATIVE](../APP-NATIVE.md#entry-points) |
| Capture, target pins, claims and publication reservation | [`src/rsi-flow.js`](../src/rsi-flow.js), [`evidence-rsi`](../.github/skills/evidence-rsi/SKILL.md) |
| Isolated execution, continuations and commit/publication | [`src/rsi-execution.js`](../src/rsi-execution.js), [host continuation contract](../APP-NATIVE.md#app-hosted-rsi-continuations) |
| App-role plan and independent grading | [`src/rsi-app-flow.js`](../src/rsi-app-flow.js), [`src/rsi-evaluation.js`](../src/rsi-evaluation.js), [review requirements](../CONTRIBUTING.md#self-improvement-review-evidence) |
| Exact JSON shapes | [`contracts.schema.json`](contracts.schema.json): `rsiPolicy`, `rsiAutomation`, `rsiHostAction`, `rsiSkillDecision`, `rsiClaimInput`, `rsiProposalInput`, `rsiResultInput` |

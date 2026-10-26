# Shared daily controller

## Continuing when a source is unavailable

For a newly admitted run, set `collection.sourceFailurePolicy` to
`complete-source-kinds` in its private native settings. This policy is pinned
before collection; existing admitted runs retain their original contract.
The default remains strict when the field is absent.

Collection attempts independent source kinds even if another fails. Only kinds
whose selected passes all completed with authenticated, bounded, verified
receipts enter FILTER. For example, failed Teams enumeration excludes all
WorkIQ evidence while complete ADO created/changed evidence can continue through
FILTER, eligible Proposer and RSI. If one selected ADO pass fails, the entire
ADO cohort is excluded. No partial evidence is promoted or failed read retried.

The report distinguishes `coverage.filterReady` from
`coverage.sourceCoverageComplete`, lists missing sources, and records a
`sourceFailureReview` independently of downstream completion. A completed loop
with missing sources means successful processing of the available complete
cohorts, not complete coverage of every requested source. All sources missing,
changed artifacts, invalid provenance and unresolved integrity failures remain
blockers. RSI capture/diagnosis is not evaluated improvement or adoption.

Manual and scheduled callers now use one versioned controller. It owns admission,
stage order, aggregate reservations, receipt propagation and terminal reporting in
the existing Ledger's operations/captures/locks. The control journal references the
authoritative one-shot source, FILTER and worker ledgers; it does not replace their
acceptance records or introduce another storage engine. Inner schedulers remain disabled.

## Failed-stage diagnosis

After an admitted collection, FILTER or Proposer stage blocks or throws, the
controller records a separate
failure review without releasing downstream product stages. The loop report keeps
its original blocked state, stage and error;
failureReview reports the independent review outcome and two hashed capture
artifacts (immutable failure snapshot and diagnosis/proposal). Admission/preflight
failures and pending host work do not trigger this path. RSI failures do not
recursively trigger another review.

The initial reviewer is explicitly deterministic (deterministic-rules-v1), with
zero source calls, model sessions and worker sessions. It identifies confirmed
HTTP 429 and proposes a bounded continuation for separate approval; for other
failures it records the missing verified outcome and an investigation proposal,
without claiming a root cause. Diagnosis/proposal, execution, evaluation and
adoption are separate lifecycle fields. This is not a new model-based RSI session
or an evaluated improvement, and does not change the successful capture-only path.

The native snapshot includes original controller/configuration pins and producer
bindings, source coverage/counts/reservations, upstream receipts, transport call
IDs/request hashes, recorded-response versus unknown-effect indicators, and exact
response capture hashes. Raw captures remain private local artifacts under the
existing state-owner retention boundary; do not publish them. HTTP status and
validated retry timing propagate through CLI errors, collection blockers and the
controller report. Missing counts remain unknown; reservations are never refunded.

Review identity is the snapshot hash. Snapshot and review commit atomically in
the existing ledger; repeated delivery or a lost local acknowledgment reuses the
same review. Missing or changed artifacts block review while preserving the
original failure. Existing source/model resume rules still apply; this path never
retries a read, advances a cursor, resets a ledger or launches a repair.

Deployment requires a newly pinned release and approved configuration for future
occurrences. Do not patch a failed occurrence's producer binding in place. The
PILOT-44 occurrence and daily deployed schedule are not migrated by this code
change. Model-based diagnosis needs its own bounded authorization and durable
provider execution contract; it is deliberately not enabled by capture-only.

The native adapter invokes supported one-shot collection and release machinery.
With filterExecutor=local-sdk it prepares the complete corpus, runs the existing
restricted SDK FILTER and reconciles its immutable execution evidence automatically.
Agency execution retains its explicit host continuation. Missing qualifications or
budget approval remain blockers; installing this path does not establish live acceptance.

See [automatic local FILTER setup](scaffold/LOCAL-LOOP.md) for the local SDK path,
verified o200k tokenization and explicit soft-credit approval.

## Commands

Use Node 24+, the same pinned checkout, and approved private absolute paths. First
review a native settings file with the fields below, plus existing approved
collector/proposer configurations described in ONE-SHOT.md. No credentials belong
in any of these files. The request builder hashes existing files and source code;
it does not authenticate, qualify bindings or grant permissions.

```powershell
node scripts/loop-request.mjs --settings C:\private\loop.local.json --occurrence 2026-10-23T01:00:00Z --output C:\private\daily-request.local.json
node scripts/loop-manual.mjs --request C:\private\daily-request.local.json
node scripts/loop-scheduled.mjs --request C:\private\daily-request.local.json --occurrence 2026-10-23T01:00:00Z
```

Both commands call runEvidenceLoop. The scheduled wrapper receives the **scheduled
occurrence timestamp**, never its completion time or a delayed host's current time.
For the next day pass the next occurrence; do not edit policy/configuration pins.
The builder leaves window absent so the controller derives the previous complete
calendar day in the explicit timezone. An explicit half-open UTC window is allowed
for parity/replay-contract tests, and overrides that derivation. Singapore's October
23 occurrence selects [October 21 16:00Z, October 22 16:00Z). DST days need not be 24h.

Private native settings (values are contract examples, **not authorization**):

```json
{
  "format": "loop-native-settings-v1",
  "workflowId": "daily-evidence-rsi",
  "timeZone": "Asia/Singapore",
  "adapter": "native",
  "rsiMode": "capture-only",
  "deadlineAt": "2026-10-30T00:00:00Z",
  "stateOwner": {
    "id": "approved-local-controller",
    "directory": "C:/private/daily-loop-state",
    "accessApproved": true,
    "retentionDays": 7
  },
  "collectorConfig": "C:/private/collector.local.json",
  "proposerConfig": "C:/private/proposer.local.json",
  "executeProposer": false,
  "collection": {
    "dryRun": true,
    "passes": ["ado:created", "ado:changed"],
    "authorization": {
      "approvedBy": "authorizing-user",
      "approvedAt": "2026-10-23T00:00:00Z",
      "approvalRef": "private:approved-daily-collection",
      "deadlineAt": "2026-10-30T00:00:00Z",
      "maxItems": 4000,
      "maxCalls": 600
    }
  },
  "filterHost": {
    "id": "approved-current-host",
    "approvalRef": "private:filter-sharing-and-execution",
    "qualificationRef": "private:qualified-runtime-source-task-contract",
    "maxRequests": 10,
    "maxExecutionSeconds": 6000,
    "maxReservedTokens": 200000
  },
  "budgets": {
    "collect": { "maxEffects": 600, "timeoutMs": 3600000 },
    "filter": { "maxEffects": 10, "timeoutMs": 6000000 },
    "proposer": { "maxEffects": 11, "timeoutMs": 3600000 },
    "rsi": { "maxEffects": 1, "timeoutMs": 3600000 }
  }
}
```

Source selection must include every enabled kind's created pass. IcM is explicitly
unsupported by this adapter. WorkIQ stays in its intentional collection-only
namespace; authenticated provenance is retained and the separate downstream gate
is still mandatory. Repository authoring/validation bindings and finite worker
limits are required even when the eventual cohort has no candidate. Native helper
authorization deadlines, aggregate FILTER tokens/time and provider-specific worker
budgets remain authoritative; core budget fields cannot expand them. Adapter code
is trusted to enforce its declared bounds, not sandboxed by the controller.

## State and host handoffs

The approved state root contains the existing ledger.sqlite. Per-occurrence
specialization is deterministic under loops/RUN_ID/: collector/, proposer/,
collector.config.json and proposer.config.json. No parent evidence ledger is opened
for mutation. The full request pins configuration file bytes, source/execution
policy, owner, retention, adapters and budgets. Trigger origin/occurrence is audit
metadata, excluded from the execution contract after window resolution. The run ID
uses workflow/window/timezone/policy. A separate atomic occurrence reservation in
the same ledger rejects attempts to replace a day's policy silently.
The identifier uses a 128-bit hash prefix to keep nested Windows SQLite paths
short; every reuse still compares the full immutable pin hash, so an ID collision
blocks rather than adopting another request. Windows preflight rejects state roots
whose derived SQLite path is too long. Use a short approved root such as C:/private.

After collection, filter-request.json names the exact role request, collected
receipt and bound host. Follow ONE-SHOT.md using the derived configs:

1. Read the exact complete collected corpus. Prepare full grouping/material-sharing
   approval and verified token accounting; produce a manifest and future result paths.
2. Specialize **only agency.selections** in proposer.config.json for those concrete
   task IDs. Profiles, source/repository policies, permissions, limits and the
   deterministic per-run agency budget ID cannot change. Qualify task bindings in
   the separate FILTER execution ledger using the existing contract.
3. Prepare the one-shot handoff with the exact collection receipt SHA, manifest SHA,
   execution ledger and result paths. Reserve the whole FILTER cohort and each exact
   request **before** submitting through the approved host. Inspect and reconcile
   original task receipts using AGENCY-EXECUTOR.md; do not fabricate execution proof.
4. Save that unchanged one-shot handoff as loops/RUN_ID/handoff.json. Invoke either
   wrapper again. Missing/partial/unqualified results remain blocked. The controller
   reproduces the existing accepted-cohort gate; only eligible candidates can reach
   the existing proposer dispatcher, and only if executeProposer and existing
   separate commit/push/draft permissions all allow it.

The host owns its submission/observation, original request IDs and session handles.
The controller pins its handoff/config at first acceptance and revalidates source,
manifest, execution and result artifacts on every resume, including terminal runs.
It does not infer semantic truth from hashes or a role's name.

Capture-only RSI records a connected observation under the existing pre-execution
collector binding, including exact FILTER/proposer receipts and their accepted
results, with manual analysis explicitly pending. Worker RSI
bindings remain owned by the existing dispatcher. Evaluated mode requires the
existing configured RSI automation and a paired comparison receipt; capture, idle,
or no-change-without-comparison never becomes evaluated success. The native adapter
runs RSI automation on that connected observation. Oversized observations block
under the existing RSI byte limit. Full live producer/evaluator qualification
remains an integration acceptance dependency. No merge or adoption is automated.

## Adapter contract and portability

An adapter exposes binding (ID plus code revision), capabilities, preflight,
execute, resume and verify. A loop-role-request-v1 carries run/operation IDs, pinned
policy, finite reservation and all prior receipts. Receipts identify the exact
request SHA, outcome, original ledger IDs and hash-bound artifacts. Awaiting-host
and blocked results must include a concrete code and action. The core imports no
host, model, authentication or provider orchestration code.

Two shipped adapters exercise this boundary:

| Adapter | Execution / resumption |
| --- | --- |
| local-one-shot-v1 | Invokes local helpers, including opt-in local SDK FILTER; external Agency FILTER and app-hosted RSI may await the approved current host |
| mailbox:local-one-shot-v1 | Only journals roles during controller invocation; a foreground host explicitly drains the reserved role through the same native domain gates |

For mailbox settings use adapter=mailbox when building the original request. After
the wrapper reports awaiting-host, drain its named stage and invoke the wrapper
again:

```powershell
node scripts/loop-manual.mjs --request C:\private\daily-request.local.json --drain collect
node scripts/loop-scheduled.mjs --request C:\private\daily-request.local.json --occurrence 2026-10-23T01:00:00Z
```

Drain does not launch a different model/harness; it executes one reserved role in
the foreground. Both adapters have synthetic conformance coverage. This is a
distinct durable host transport, not a second independently qualified live model
provider. Cross-adapter resumption is intentionally refused. Supporting another
provider requires its own verified implementation and live qualification.

## Recovery and retention

Reservations precede effects, with immutable receipt captures afterward. A lost
acknowledgment invokes adapter resume, never execute. Collection resumes its exact
one-shot passes and only reconciles uncertain source reads from original transport.
Proposer and RSI retain their existing attempt/publication reconciliation rules.
Missing helper journals after an uncertain intent stay blocked. A changed harness,
configuration hash or result cannot reset a run. Manual auth recovery remains the
existing one-shot procedure; this controller never automatically spends that retry.

An abandoned lock is never timed out or stolen. Inspect the exact owner/PID and use
Ledger.recoverLock(name, expectedOwner) only after the recorded process is absent.
Recovering a lock does not authorize repeating its effect. Preserve original
operations, reservations and receipts; reconcile through existing helper controls.
Restore original immutable artifacts rather than regenerating them under the same
IDs. A policy replacement for an admitted day requires operator investigation and
an explicit new approved workflow decision; no automatic reset command is provided.

This is single-host local SQLite ownership, not multi-host/network-share safety.
Use one canonical approved state root per workflow across all triggers. An empty
platform run list is not a lock. Do not prune active/uncertain runs. Apply existing
bounded-local raw evidence retention with operator review; deleting an expired
artifact makes later verification blocked, not successful. Never delete admission
tombstones to reclaim space or permit a second dispatch.

## Daily schedule migration and acceptance

Autopilot 983aa9d6-b795-463a-8ef4-24ce67d14a62 was paused when PILOT-22 was
closed as superseded on October 23. PILOT-25 now owns implementation, integration,
live acceptance and the eventual switch; do not wait for PILOT-22 to reopen.
Reuse that autopilot, preserving trigger 5d94f0c6-9bd6-407c-bf12-15c8b6e8a27a,
cron 0 9 * * *, timezone Asia/Singapore and create_issue mode:

1. Integrate/review this PR together with the separate fix-reference/product setup
   dependencies. Pin the accepted checkout and provision approved private settings,
   source identity/scope, FILTER host, repository validation and declared RSI mode.
2. Build a request for a chosen occurrence. Run the exact manual command, complete
   the existing host continuations, then run the scheduled wrapper for that same
   occurrence. Compare run ID, pins, plan, receipts and no additional source/worker
   effects. Test a distinct day. Record live source/product/evaluator evidence.
3. Only after PILOT-25 live acceptance replace the autopilot's retained-evidence-only prose
   with the exact scheduled command above, approved durable request path, checkout
   pin and occurrence from the trigger. Retain 09:00 Asia/Singapore. Remove the old
   prohibition on collection; authorize only the bounded collection in the request.
   An awaiting-host result must retain the named continuation, not trigger a new run.
4. Keep rollback as the old schedule configuration plus preserved ledgers. Do not
   reissue an already admitted occurrence from a different store or old script.

Local tests cover concurrent admission, each stage's lost acknowledgment, restart,
unknown outcomes, configuration/artifact drift, budgets, unavailable capabilities,
partial collection, no-candidate and meaningful synthetic four-stage work through
both transports. A native integration test additionally uses real collection,
FILTER acceptance and RSI capture helpers with a synthetic empty source and both
actual wrapper executables. None is a live source/product/RSI acceptance run.

WorkIQ deployments that throttle sequential enumeration can set
`runtime.workiqCli.minReadIntervalMs` (0–60000) before admission. This spaces reads
after the preceding response; it does not retry, hide calls from the source budget
or convert incomplete coverage into success. HTTP 429 is reported as
`blocked-throttled`, preserving the server's `retryAfterSeconds` when supplied.
A terminated run remains unchanged; a newly authorized collection iteration must
retain its predecessor and first rule out unknown reads, rather than resetting it.

### Explicit recovery after completed collection

A native settings bundle may declare `collectionReuse` with `approvedBy`,
`approvalRef`, `requestPath`, `requestSha256` and `receiptSha256`. This is an explicit
successor request with a new workflow identity, not a reset or a change to old pins.
It requires the exact original collector configuration, owner, source policy and
window, and a completed, independently rechecked collection receipt. Any original
FILTER execution/handoff, Proposer intent or RSI intent prevents this recovery.
Only one successor can claim the collection, and its invocation holds the original
controller's enforced lock throughout execution. Chained and mailbox recovery are
not supported. Source reads are not repeated and no old receipt is rewritten.

This permits correcting a pre-submission FILTER preparation or capacity error.
Required source versions, thread members and explicit links are grouped together
mechanically before verified token packing; singleton groups are insufficient.

If a recovered collection predates a controller update, its RSI producer binding
still names the original code and Node version. Keep that producer installation.
For an existing capture-only RSI intent, the following command verifies its full
source fingerprint and the original upstream receipts, invokes the actual original
capture helper, verifies the resulting observation, then reconciles the role:

```powershell
& ORIGINAL_NODE scripts/loop-reconcile-rsi.mjs --request APPROVED_REQUEST --producer-root ORIGINAL_CHECKOUT --approval-ref APPROVAL_REFERENCE
```

Use real approved paths, then resume the normal manual/scheduled wrapper. This
command cannot rebind a producer, recover evaluated RSI, launch a model, or replace
a completed receipt. The observation remains attributed to the original producer;
it does not qualify an evaluated improvement to a newer controller.

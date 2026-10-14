# Agency executor integration

> This document describes hosted Agency task reservation and reconciliation.
> The opt-in [local and remote Agency authoring providers](AGENCY-LOCAL-AUTHORING.md)
> are separate transports that keep final validation and publication on the
> Controller path. Neither model is a merge authority.

The local runtime and SQLite ledger remain the scheduler and state owner.
`collector`, `filter`, and `proposer` are the only selectable roles. Agency is
an explicitly qualified task executor, not a replacement main controller or a
replacement model callback. Local execution, including qualified local E2E
harnesses, remains the default. No repository-wide hosted switch exists.

The `agency-remote` authoring provider is not this hosted executor. It delegates
only source investigation and authoring, transports one audited result commit
back to the Controller, and leaves validation, repair policy, final push and
Draft PR creation local. Hosted execution instead reserves and reconciles a
qualified externally owned task/result lifecycle.

This module does not contain endpoints, authentication, private repository
identifiers, a provider client, or automatic polling/submission. Resolve these
through the approved private runtime. Unknown effective model, tokenizer, source,
profile, account/ring/harness or suite qualification is a blocker, not permission
to infer defaults. The explicit bounded FILTER estimation exception below is
the only alternative to verified tokenizer/capacity accounting.
A qualified integration suite does not qualify E2E or another
repository. Local E2E source/account/ring requirements are unchanged.

## Private configuration and qualification

`config.agency` contains:

| Field | Contract |
| --- | --- |
| `profiles` | Map from private profile ID to exactly `{organization, project, repository, initMode}`; the supported existing initialization mode is `lite`. |
| `selections` | Explicit per-task selections described below. General assignment routing can remain local, but a missing selection for this Agency FILTER path blocks reservation; it never invokes a local model fallback. |
| `budgetId`, `maxRequests` | Durable bounded request bucket; every reservation, including uncertain/rejected requests, consumes one slot. |
| `maxConcurrent` | Positive cap, additionally bounded by the shared local `limits.maxWorkers`. Standalone FILTER requests also count against local worker admission. |
| `maxDraftPullRequests` | Set to `1` to authorize at most one draft reservation in the bucket, otherwise authoring is blocked. |
| `maxExecutionSeconds` | Positive upper bound on each selected task's requested duration. |
| `preflightMaxAgeSeconds` | Positive maximum age of read-only exact-ref verification before reservation. |
| `monitorOwner`, `monitorCadenceSeconds` | Explicit durable owner and positive cadence. The reservation records a deadline and forbids automatic retry/cancellation on expiry. |

Each selection has exactly:

```text
taskId, repoId, role, suiteId, profileId,
qualificationId, qualificationSha256,
sourceRevision, targetRef, payloadSha256, instructionsSha256,
resultKind, allowPush, dispatchAllowed, maxExecutionSeconds,
allowedPaths, forbiddenPaths, caseContract
```

`dispatchAllowed` must be explicitly true in this separately approved execution
configuration. A held FILTER/replay artifact with `dispatchAllowed:false` is
never launch authorization. Its source run remains unmodified.
New FILTER reservations additionally require either the versioned `captureVerification`
contract below or the explicitly approved `analysisPolicy` described next, and
`analysisPayloadSha256`. Legacy selections remain readable for
historical reconciliation but cannot reserve another FILTER request.
`resultKind` is `analysis` or `validation`; only a `proposer` validation task
may set `allowPush:true`. `allowedPaths` and `forbiddenPaths` use repository-relative
slash-separated paths. Forbidden paths take precedence.

`caseContract` contains `cases`, `scenarios`, and `commands`. Cases are exact
`{suite,title,status}` entries (`passed` or a preserved authored `skipped`).
Scenarios are unique required scenario IDs. Commands are unique
`{id,phase,command,cwd}` entries, where phase is `build`, `test`, `coverage`, or
`hook`. Validation requires an executing case, a test command and scenario proof.
Assignment validation-gate IDs must occur in the command contract.

Persist qualification with the existing `ledger.qualify(qualificationId, q)`.
This is a local owner operation recording inspected evidence, not a network probe.
`qualificationSha256` is `SHA256(JSON.stringify(q))`. The qualified object is:

```text
{
  status: "qualified",
  binding: {
    repoId, role, suiteId, profileId, profileSha256, sourceRevision, targetRef,
    instructionsSha256, caseContractSha256
  },
  runtime: { modelId, tokenizerId, contextTokens, maxOutputTokens },
  expiresAt: "<explicit UTC timestamp>",
  evidenceRef: "<private inspected qualification reference>"
}
```

Hashes of profiles and case contracts use `SHA256(JSON.stringify(value))`.
Binding order is as shown; qualification is an exact snapshot, not an unordered
partial match. The qualification must be positive, unexpired and match all pins.
Tests use synthetic fixtures only; they do not create real qualifications.

### Essential local read-only FILTER policy

The integration-first pilot can use the existing Agency route without shared
runner changes. Explicitly select `analysisPolicy` instead of `captureVerification`:

```json
{
  "id": "local-readonly-filter-v1",
  "approvedBy": "<authorizing user or coordinator>",
  "approvedAt": "<UTC approval timestamp>",
  "approvalRef": "<durable approval provenance>"
}
```

Append the same object to `q.binding.analysisPolicy`. This policy is restricted
to `role:"filter"`, `resultKind:"analysis"`, `allowPush:false`; it does not alter
proposer, validation, or the stronger capture-policy defaults.
`reserveAgencyRequest(config, ledger, taskId, input, manifest)` additionally
requires the full original manifest under this policy. It validates local
lossless evidence/captures, source corpus and exact submitted OUTER/INNER/
instruction identity before reservation. Missing selection or manifest blocks,
never silently falls back to another executor.

Use the existing wire with explicit `allowPush:false`, PR
`create:false,publish:false`, and `options.branch.createSourceBranch:false`
for new local-policy requests (no `sourceBranch` or profile override). This
suppresses the existing API's default branch-creation behavior without shared
runner changes. Historical omitted controls remain unknown, not retroactively
present. Optional `publication.sourceBranchCreated` records an observed boolean
or `null`; observed creation blocks and missing/unknown is not verified false.
Source refs must be actual analyzed refs attributable
to the job; provider and actual pipeline success, exact job/request/result
identity, supported complete per-record decisions and local membership validation
remain mandatory. A worker repeat of capture hashing and a dedicated final
clean-worktree step are not required. Unknown final source observations may be
`null`, but an observed different revision or changed path blocks.
Unknown publication fields stay `null`. They yield `publicationPassed:null` and
an explicit assurance limitation, not verified zero effects. Observed pushes,
PR mutations, merges or source modifications block. This is request-policy
acceptance, not a sandbox or exhaustive effects audit.

The normal new-job result path remains `recordAgencyAnalysisCheck` followed by
`reconcileAgencyResult`; `readAgencyRequest(ledger, taskId).terminal.verdict`
exposes its immutable verdict. Gate the first new request before reserving the
remaining approved jobs; no retries/replacements or budget expansion.

Historical jobs can be assessed prospectively using
`evaluateFilterExecution(config, ledger, originalManifest, taskId, exactResultBytes,
observedInput, policy)` in `src/filter-execution.js`. Its recording counterpart,
`recordFilterExecutionEvaluation`, appends a content-addressed
`policy-evaluation:*` receipt. Each snapshot binds the original request/job,
manifest/payload/result, explicit policy hash, observed input and prior terminal
hash; it sets `historicalCompliance:false`. Never edit historical prompts,
selections, results or negative terminal receipts to claim past compliance.
Preserve original output bytes and separately checked canonical serialization.
For a sealed ledger, use a new private snapshot for append-only evaluations.

`reconcileFilterExecutionCohort(config, ledger, manifest, resultBytes, policy)`
accepts those separate evaluations only when that policy is explicitly supplied,
reproduces their grades, and requires the entire original cohort. Its CLI uses
`filter-execution-check ... --policy policy.json`; no option means the original
grading path. Missing batches remain blocked. Reusing an old result against new
source/instruction/payload pins is forbidden: retain its original lineage, or
execute a coherent new manifest. A successful captured-cohort handoff (including
no eligible candidate) is not a product integration-test pass, periodic
readiness, or complete source collection. WorkIQ/auth/IcM limitations stay visible.

### Enforced worker capture verification

This stronger policy is optional, not a prerequisite for the existing-Agency
local-policy route above. When selected instead of `analysisPolicy`, new FILTER
selections and their qualification `binding` must both include:

```text
captureVerification: {
  protocol: "filter-capture-verification-v1",
  verifierSha256: "<SHA256 of the actually deployed verifier bytes>",
  pipelineDefinitionId: "<qualified definition ID string>",
  stepName: "<qualified enforced pre-analysis timeline step name>",
  pipelineSourceRevision: "<reviewed helper-delivery source commit>",
  bootstrapSha256: "<SHA256 of the reviewed bootstrap invoking this verifier>"
}
```

This is a new execution contract, not a reinterpretation of sealed historical
receipts. Removing or changing it invalidates qualification. The dependency-free
`src/filter-capture-verifier.js` exports the archival reconstruction routine also
used by the packer, and provides this executable:

```text
node filter-capture-verifier.js CHECKOUT
```

The identical bytes can be delivered as `filter-capture-verifier.mjs` in the
runner's temporary directory, outside the checked source tree. The `.mjs`
extension avoids depending on that directory's package configuration. Renaming
does not change the approved SHA256; reformatting, bundling or changing line
endings does and requires a new pin. Standalone-delivery regressions execute an
exact copy and reject changed executable bytes; they are not hosted-run proof.
The verifier's narrowly scoped `-text` Git attribute preserves its approved
bytes across platforms rather than silently converting line endings.
Delivery qualification must hash the actual Git blob as well as the local
file: matching code text is insufficient. After changing attributes, a normal
`git add` can reuse the previously normalized index; refresh only this path
with `git add --renormalize -- src/filter-capture-verifier.js` and compare the
staged blob's SHA256 with the approved executable before committing.

Its stdin is exactly compact `JSON.stringify(input)`, without a trailing newline
(`inputSerialization:"json-stringify-v1"`):

```text
{
  format: "filter-capture-verification-v1",
  binding: {
    repoId, targetRef, sourceRevision, verifierSha256,
    payloadSha256, analysisPayloadSha256
  },
  prompt: "<exact actual OUTER prompt string>"
}
```

The enforced bootstrap must obtain `prompt` from the authoritative bound job,
not from a model's reconstruction, a metadata digest or a controller-only file.
The verifier checks its own file hash, actual initial/final clean git HEAD/status,
outer/inner/index/record bindings, and computed SHA256 and UTF-8 byte length for
each reconstructed capture (or exact base64 and SHA256 for inline captures).
It rejects noncanonical stdin and emits the hash of its actual canonical stdin.
It verifies **all delivered captures before analysis**, because final title
decisions do not yet exist. It neither reads a final result nor claims semantic
reading. A nonzero exit must block inference in the reviewed pipeline wiring.
Stdout is a pretty-printed JSON receipt with the bindings, input serialization/hash, source observations,
`captures:[{evidenceId,captureSha256,byteLength}]`, and
`semanticReadingProven:false`. No capture bodies are emitted.

`recordAgencyCaptureCheck(ledger, taskId, inspectExecution)` accepts this receipt
only through an explicitly trusted provider-adapter callback. The callback gets
`{jobId,taskId,input}` and must return inspected **actual execution evidence**:

```text
{
  executionKind: "pipeline-step", executionId: "<timeline task GUID>", jobId,
  pipeline: {
    buildId, definitionId, sourceRevision, bootstrapSha256,
    stepName, state: "completed", result: "succeeded",
    log: { id, sha256 }
  },
  verifierSha256,
  inputSerialization: "json-stringify-v1",
  stdin: "<actual serialized stdin bytes decoded as UTF-8>",
  inputSha256, exitCode: 0, stdout: "<exact verifier stdout>",
  evidenceRefs: [{ref:"job-local:<jobId>:<artifact>",sha256}]
}
```

The callback is a trusted adapter boundary, **not a JSON self-attestation API**.
It must verify the job/build association, actual timeline step and log, pinned
pipeline/helper source proving invocation, actual deployed verifier file hash,
and actual stdin/stdout bytes (or the explicitly pinned digest-attested input
mode below). A green existing gate, arbitrary model tool call,
model final prose, metadata-only hashes, or a local execution cannot satisfy it.
The helper checks actual stdin byte equality and hash against the specified
serialization, recomputes expected capture rows, and stores a separate immutable
`capture-check` receipt without persisting the full stdin. Terminal reconciliation
also matches the verifier's build ID to the actual terminal pipeline ID.

#### Sanitized digest-attested input

A reviewed runner may avoid exporting a duplicate of the sensitive stdin.
This is a separate opt-in contract: add
`inputEvidenceKind:"source-bound-stdin-digest-v1"` and
`agentProfileSha256:"<SHA256 of actual reviewed LF profile bytes>"`, plus
`sourceAttestationStepName:"AgencyFilterSourceAttestation"`, to the
selection's `captureVerification` and its qualification binding. Without this pin, the
original exact-stdin inspection contract remains mandatory.

In this mode the trusted inspector returns `inputEvidenceKind` and
`stdinByteLength` **instead of** `stdin`. The bootstrap must hash and count
the actual UTF-8 bytes passed to the verifier, and emit one sanitized line:

```text
AGENCY_FILTER_CAPTURE_RECEIPT_V1 <compact JSON envelope>
```

The envelope has exactly:

```text
{
  format: "agency-filter-capture-execution-v1", jobId,
  executionKind: "pipeline-step", executionId,
  pipeline: {buildId, definitionId, sourceRevision, bootstrapSha256, stepName},
  verifierSha256, inputEvidenceKind: "source-bound-stdin-digest-v1",
  inputSerialization: "json-stringify-v1", inputSha256, stdinByteLength,
  exitCode, stdout
}
```

`inspectAgencyCaptureLog(observed)` parses this envelope and joins it to
independently obtained job/build/timeline observations:

```text
{
  jobId, pipeline: {buildId, definitionId, sourceRevision},
  step: {executionId, stepName, state, result, logId},
  logText, evidenceRefs
}
```

Build, definition and log IDs accept strings or positive safe-integer API values
and normalize to strings for ledger comparison; the original log bytes remain
unchanged. `logText` is the exact retrieved gate log, limited to 1 MiB
of UTF-8; its hash is recorded. A standard ADO UTC timestamp prefix is supported.
Missing/duplicate/malformed envelopes, unexpected fields (including raw stdin),
or a differing or unsuccessful task fail closed. This pure parser does not
authenticate inputs: the private adapter must retrieve the actual associated
job, build, timeline and log and verify the reviewed source/helper invocation.
Do not populate these observations by copying fields out of the log itself.

`recordAgencyCaptureCheck` compares the logged input digest and byte length
with the canonical input derived from the reserved authoritative prompt, and
independently compares the verifier's stdout input digest and all capture rows.
Acceptance therefore attests source-bound execution input by digest; it does
not claim literal stdin retrieval. Regenerated bytes are never represented as
inspected raw stdin. The immutable receipt retains the explicit evidence kind,
and terminal reconciliation requires that same qualification-bound kind.

This opt-in also selects the reviewed `filter-capture-v1` runner wire contract:
top-level `agent:{name:"filter-evidence-reader",type:"Repo"}`, full
`sourceBranch` and `targetBranch` equal to `refs/heads/main`, and
`options.branch:{createSourceBranch:false}` alongside the existing explicit
no-push/no-PR-creation options. No plugin, model, pipeline or other override is
accepted. `agencyFilterRunnerMetadata(selection)` builds the exact permitted
all-string metadata from the pins; it does not reserve or authorize a request:

```text
initMode, trustProfile, expectedAgent, expectedProtectedSourceSha,
agentProfileDigest, requestDigest, captureProtocol, captureVerifierSha256,
captureAnalysisPayloadSha256, captureRepoId, capturePipelineSourceRevision,
captureBootstrapSha256, copilotTaskWaitTimeoutSeconds
```

The source/profile/OUTER/INNER/verifier/bootstrap values must exactly match the
selection. The task-wait string is exactly `String(maxExecutionSeconds)`, an
integer in the supported inclusive range 300..14100 seconds. This sets the
runner's task wait, not a provider cancellation policy. Existing monitor
deadlines and the no-automatic-cancellation rule remain unchanged. The runtime
still needs separate deployment/capability and publication evidence; these
request fields cannot establish effects.

#### Post-analysis checkout evidence

The source-reading profile cannot execute shell/git commands. Its pre-analysis
capture receipt cannot prove checkout state after inference. Digest-mode
qualification therefore also pins the distinct, fixed post-analysis step named
above. The runner must enforce this lifecycle ordering and only admit the step
after its successful trusted pre-gate. It observes actual final git HEAD and
porcelain status including untracked files, without rerunning capture analysis,
copying the prompt, or claiming publication effects.

The one-line source receipt is
`AGENCY_FILTER_SOURCE_RECEIPT_V1 <compact JSON>` with exactly:

```text
{
  format: "agency-filter-source-execution-v1", jobId,
  executionKind: "pipeline-step", executionId,
  pipeline: {buildId, definitionId, sourceRevision, bootstrapSha256, stepName},
  source: {repoId, targetRef, revision, status}
}
```

`inspectAgencySourceLog(observed)` uses the same authenticated observation shape
and bounded log/timeline checks as the capture parser.
`recordAgencySourceCheck(ledger, taskId, inspectExecution)` calls its trusted
adapter with `{jobId,taskId}` and records a separate immutable `source-check`.
The source must be the selected revision with an explicitly empty status.
Terminal grading joins this receipt to the same actual completed build and
qualified post-step/helper/source pins. Missing, failed, dirty, changed,
wrong-build or preflight-only proof remains blocked. The terminal
`source.outputRevision` must equal this actual observation; neither the
pipeline source revision nor the preflight snapshot may fill it by inference.
No publication effect field is derived from this receipt.

`recordAgencyAnalysisCheck` continues to run the strict FILTER membership
validator and additionally stores result-hash-bound `capture-requirements`.
Terminal acceptance joins the final retained IDs (and their required context
IDs) to the preverified rows. `excluded-title` remains exempt from a full-read
claim; an all-excluded result has no retained-capture requirement. A pre-analysis
receipt does **not** claim to have seen or verified a future final result.
Missing/mismatched execution proof blocks analysis even with positive provider,
pipeline and membership outcomes. Capture integrity still does not prove
semantic reading, source investigation, or absence of publication effects.

**Stronger capture-policy deployment limitation (not a local-policy prerequisite):**
this repository does not install its verifier into a hosted worker or publish a
shared-runner patch. Any future deployment must separately qualify delivery of
the pinned bytes, authoritative prompt access, enforced pre-analysis invocation,
receipt preservation and intended read capabilities. An empty tool list is not
proof of denied capabilities. No deployed qualification, product edit, live
recovery or retry is authorized by these offline APIs.

Publication fields remain unknown unless the provider adapter establishes
explicit effects or a separately reviewed, runtime-bound exhaustive restriction.
`allowPush:false`, automatic-PR flags, clean git status, omitted PR fields and
successful progress reports are not universal no-publication proof. The
corrective capture contract does not convert any publication null to false.

### Source-bound cohort and colleague handoff

`reconcileFilterExecutionCohort(config, ledger, manifest, resultBytes)` in
`src/filter-execution.js` is the read-only completion gate for a corrected
cohort. Supply exact canonical checked result strings and the ledger containing
the actual executions. It requires every manifest batch, the matching selected
source/profile/payload/instruction pins, and each immutable terminal receipt.
It reuses `previewAgencyResult` to regrade capture, runtime, source and
publication evidence inside a read snapshot without recording or modifying
receipts. A mismatch with the recorded verdict remains blocked.

The executable read-only entrypoint is:

```powershell
node src\cli.js filter-execution-check --config corrected.local.json --file result-paths.json --manifest corrected-batches.json --ledger execution.sqlite
```

It prints the report as JSON and exits nonzero for a blocked cohort. It opens
only the explicit execution ledger in read-only mode, does not initialize the
configured default state directory, and never collects, reserves, dispatches
or records a new terminal receipt.

Only a fully qualified cohort exposes `consolidation`, in the existing
`filter-consolidation-v1` handoff format. Missing/partial/conflicting results,
missing execution, or source mismatches withhold it. Under the stronger capture
policy, missing worker capture proof and unknown publication effects also block;
under the explicitly selected local policy they are assurance limitations as
specified above. One successful canary is not complete-cohort readiness.
`dispatchAllowed` stays false; this endpoint does not implement or launch the
colleague's downstream work. `sourceCoverageComplete:null` explicitly avoids
promoting complete processing of the captured cohort into complete collection.
Preserved source coverage, missing passes and historical limitations still
apply. The existing structural consolidation/binding helpers remain structural
checks, not substitutes for this execution gate.

### Explicit estimated FILTER trial

A user-approved bounded FILTER trial may use estimates without pretending an
exact tokenizer or deployed default-tier input allowance is known. This is
restricted to `role:"filter"`, `resultKind:"analysis"`, `allowPush:false`.
Keep `runtime.tokenizerId`, `contextTokens`, and `maxOutputTokens` **null** and
add this object to the immutable qualified `runtime`:

```text
estimation: {
  approvalId, approvedBy, approvedAt,
  accountingMethod: "utf8-byte-conservative-estimate-v1",
  planningCap, maxInputTokens, instructionReserve, codeReserve, outputReserve,
  safetyReserve, requestOverheadReserve,
  uncertainty, maxConcurrent: 2
}
```

All planning cap/reserves are positive, explicitly selected values, not inferred
provider capacity. Approval/provenance and uncertainty are mandatory. The
effective model remains positively identified and unchanged; no model override
is sent. `tokenBudget` then has exactly:

```text
{
  mode: "estimated", payloadSha256, modelId, tokenizerId: null, inputTokens,
  approvalId, accountingMethod: "utf8-byte-conservative-estimate-v1", uncertainty
}
```

Here `inputTokens` denotes **estimated units**, computed as the exact UTF-8 byte
length of `prompt` (one estimated unit per byte), not actual tokenizer output.
The module recomputes it. Estimated units must fit `maxInputTokens`, and the sum
of units and all five instruction/code/output/safety/request-overhead reserves
must fit the approved planning cap. No reserve is dropped or silently absorbed.
`config.agency.maxConcurrent` cannot exceed
two or the shared local worker limit. No inherent model catalog value is treated
as a verified default input allowance. Rejected or explicitly uncertain POSTs
stop further reservations in the same approved budget, with no smaller resend,
retry, replacement, or local fallback.

For workers, obtain the ordinary assignment ID with no selection for that task.
Use that ID as `selection.taskId`. `makeAssignment` then selects hosted execution,
pins the selection hash and task ID in `requiredCapabilities`, pins the source
revision and derives a new immutable assignment ID. Normal
`requireCurrentAssignment`, daily assignment budgets, claims and shared worker
caps still apply. Hosted native workers do not require a local app project,
checkout, Git skill-workspace check, SDK model preflight, commit, test or push.

## Request seam

`reserveAgencyRequest(config, ledger, taskId, input, manifest)` is synchronous and must
commit before the **single** external POST. It accepts exactly:

```text
{
  request: "<exact serialized JSON wire bytes as a UTF-8 string>",
  requestSha256,
  preflight: { repoId, targetRef, sourceRevision, observedAt, requestSha256 },
  tokenBudget: { payloadSha256, modelId, tokenizerId, inputTokens }
}
```

`request` has only the existing wire fields `organization`, `project`,
`repository`, `targetBranch`, `prompt`, `options`, and `metadata`.
`prompt` must hash to the exact selected full payload. `targetBranch` is the
selected target without the `refs/heads/` prefix.
`options` is `{allowPush, pullRequest:{create:false,publish:false}}`;
`metadata` is `{initMode:"lite"}`. No invented source SHA, role, agent, model or
OBO fields are added to the API. Source, role, instruction, case and retention
requirements belong in the exact approved prompt and local contract.
For `local-readonly-filter-v1`, the original validated `manifest` argument and
`options.branch:{createSourceBranch:false}` are mandatory. No `sourceBranch`,
agent or profile override is allowed in that mode. The separately qualified
digest-mode wire extension above applies only to the optional stronger policy.

When a FILTER worker must return its input hash, an optional
`selection.analysisPayloadSha256` avoids asking it to hash its own prompt.
In this mode the actual prompt is a counted JSON envelope containing exactly
`{payloadSha256, payload}`: the hash of, and exact string from, the prepared
batch. Both inner digest and exact inner bytes are checked.
`selection.payloadSha256` and `tokenBudget.payloadSha256` still bind the **outer**
actual prompt; all its bytes count toward the budget. The local FILTER checker
and analysis receipt bind `analysisPayloadSha256`, the **inner** prepared batch
digest. No uncounted wrapper, inaccessible API metadata or corrected guessed
hash is accepted.

The input token count plus reserved output tokens must fit the qualified
context limit. The caller supplies a measured count for the verified tokenizer,
not a character-count estimate. Read-only ref preflight must bind the exact
request and source because the provider API targets a mutable branch.
Actual hosted checkout/source is independently checked at completion.

The immutable request table stores exact bytes, hashes, qualification/runtime
pins, local monitoring owner and deadline. The module checks requested bounds;
it does not claim the provider enforces a timeout or invent a timeout API field.
The approved prompt/profile and monitoring owner must enforce/observe those
bounds without unauthorized cancellation or replacement.

After the external POST, use
`recordAgencySubmission(ledger, taskId, {operation:"jobs-create",state,requestSha256,jobId,httpStatus,observedAt})`.
`state` is `accepted`, `rejected`, or `uncertain`; acceptance requires a real job
handle and HTTP 2xx. Only a definitive pre-job client rejection may be labelled
rejected. Ambiguous errors, including server errors, remain uncertain.
There is no provider idempotency or hash-lookup guarantee.
A validation-only endpoint response, even HTTP 2xx with a would-be UUID, is not
job acceptance. The transport must identify the actual create operation.

`inspectAgencyRequest(ledger, taskId)` returns the durable request and receipts.
Reservation without a submission receipt is **uncertain**, including after
restart. All reservations prohibit another POST. A known returned handle permits
read-only reconciliation; an unknown handle blocks result acceptance.
Never retry, replace, cancel, or fall back locally automatically.

Shared worker admission counts the union of active local jobs and every
nonterminal Agency reservation, deduplicated by hosted task ID. An uncertain
submission retains its slot even after a restart or a legacy job transition to
`blocked`; SDK and app-native admission use the same accounting. A definitive
pre-job rejection or terminal reconciliation releases the reservation's slot.

## Existing dispatch surfaces

App-native workers retain `prepare` and `claim`. Then use the existing
`app-worker --operation` command with the following actions and JSON input:

| Action | Input, in addition to `assignmentId` and `claimId` |
| --- | --- |
| `agency-reserve` | `agencyRequest`: the request input above; moves claimed to uncertain before POST. |
| `agency-submission` | `agencySubmission`: the submission receipt above; binds the real handle. |
| `agency-result` | `agencyResult`: the inspected derived result below. |

Local `bind`/`result` actions are rejected for hosted assignments. Collection-only
dry runs still cannot prepare or claim workers. No new CLI or assignment-schema
fields are required.

The SDK path uses `dispatch(config,ledger,id,{agencyRequest,agencyTransport})`.
An approved injected transport receives only the exact reserved request string
and returns the submission receipt. Without that transport it blocks before
provisioning. An exception records uncertainty, never invokes `runModel` or
local commit/test/PR callbacks. Use
`reconcileHostedAssignment(ledger, assignmentId, derivedResult)` for completion.

FILTER uses its independently authorized batch ID as `taskId` and the generic
reservation API, not an invented repository assignment. Persist a nonqualifying
local check with `recordAgencyAnalysisCheck(ledger,taskId,resultBytes,validate)`.
The synchronous callback must run the repository's full FILTER validator and
return exactly `{state:"checked-not-qualified",payloadSha256,resultSha256,validator}`.
Its hash must match `resultBytes` exactly. For a canonical FILTER result use
`JSON.stringify(result,null,2) + "\n"`. Project the callback result to these four
fields; do not discard unresolved members or force partial results to complete.
This receipt alone does not qualify anything: positive provider and source
reconciliation remains mandatory.

For every FILTER assurance policy, candidate `repository` is the selected
logical `repoId` and `sourceRevision` must equal the actual selected execution
revision. A private provider repository name is not an implicit alias. A
different repository/revision needs its own qualified analysis, not a candidate
relabeled by the controller. The analysis check, prospective evaluation and
read-only cohort gate enforce these pins; historical receipts remain immutable
but cannot release mismatched candidates. Empty candidate sets remain valid.

These are local JavaScript APIs and ledger operations, not authenticated
submit/observe CLI commands. The private adapter owns the one approved POST,
authentication and exact job/build/source/result observation. Those tools,
credentials, raw provider output and local execution artifacts are not shipped
here. `filter-execution-check` only reads an explicit ledger; app-worker Agency
actions record supplied inputs and do not perform provider network operations.
Use `readAgencyRequest` for inspection without table initialization.

## Derived result and grading

`reconcileAgencyResult(ledger,taskId,result)` accepts only allowlisted derived
fields. See `test/agency-executor.test.js` for a complete synthetic fixture and
`src/agency-executor.js` for the strict nested shapes.
Top-level fields are `requestSha256`, `jobId`, `observedAt`, `provider`, `pipeline`,
`runtime`, `source`, `inspection`, `publication`, `validation`, and `analysis`.

Provider success requires **`Completed` and `Success`**, both explicit.
Pipeline success independently requires a real run ID, `completed` and
`succeeded`; it never substitutes for provider or semantic success. Runtime,
instructions, baseline, actual checkout, output, tested revision, direct output
parent and allowed diff paths must match. This first adapter supports a
single-commit combined authoring result or unchanged read-only source; it does
not infer multi-commit ancestry or author-only/validator-only qualification.

Build/test/coverage/hook command evidence is graded separately. Exact case
populations, executed bodies, expected skips, no extra retries, preserved
assertions, and positive scenario precondition/path activation are required.
A zero exit code, empty test suite, test title or passing final output alone is
insufficient. Verdicts expose separate provider/pipeline/build/test/coverage/
analysis/publication axes and expected/actual/pass/fail/skip counts.

Publication must prove the exact created-PR count, no other PR modifications,
no merge and known push effects. An authoring result requires one active draft,
unset autocomplete, expected target, and identical output/tested/remote/PR head
pins. `allowPush:false` forbids **both** pushes and PR mutations.

Raw stdout, stderr, Jest/core exports, logs and undeclared fields are rejected.
Only inspected derived values and hashed `job-local:<returned-job-id>:<ref>`
references may cross this boundary. Missing evidence is blocked, not successful.
Analysis requires matching payload/result hashes and the persisted independent
local membership check; it always leaves `validationQualified:false`.
Its source receipt keeps `testedRevision` and `unchangedDuringValidation` null
rather than inventing test execution. Checkout and unchanged output still pin
the exact analysis source.

Receipts are immutable and duplicate identical receipts are idempotent. Submit
only terminal derived evidence to result reconciliation, not polling snapshots.
A blocked terminal receipt remains a recorded blocker; do not overwrite it or
launch a replacement automatically. Source/evidence amendments require explicit
owner reconciliation, not a second invocation with conflicting terminal facts.

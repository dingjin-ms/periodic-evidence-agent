# Independent agents: manual app-hosted pilot

## Project skills

Role procedures live in `.github\skills` and can be shared with this repository:

| Skill | Role |
|---|---|
| `evidence-collector` | Scoped source reads, receipt import, paging and coverage |
| `evidence-coordinator` | Exclusion review, ownership, atomic assignment and reconciliation |
| `evidence-improvement-planner` | Area aggregation, test discovery/linking and qualified capability selection |
| `evidence-1js-owner` | Claimed 1JS RCA/fix/validation work |
| `evidence-office-owner` | Claimed Office src RCA/fix/validation work |
| `evidence-oa-owner` | Claimed OfficeAgent integration-test work through its repo-native skill |

Ask a skills-capable Copilot host to use the named skill for the corresponding
task, for example: "Use evidence-collector to inspect the existing run's status;
do not make source calls." Reload/reopen the project if the host has not yet
discovered newly added project skills. No global installation was performed.
Product project sessions do not automatically inherit this project's skill
files; supply the selected procedure and durable assignment when handing off.

Skills separate procedures, not operating-system permissions or running agents.
They neither launch sessions nor authorize scans just by being installed.
The collector and reviewer currently share the configured durable coordinator
identity; the two repo owners retain their distinct logical IDs. This change
does not create separate daemons, enable automation, change approved scopes or
remove activation gates. The shared repo-owner reference avoids diverging
validation and draft-only policies.

## Ownership and safety

`pilot.example.json` selects `executionMode: app-native` and durable
`agent.id: excel-evidence-coordinator`. Repo-owner agent IDs are
`repo-owner:<repoId>`. The project configuration and SQLite ledger are their
durable state. Conversations may execute work but are not agent identities.
Session IDs in receipts are provenance; a native worker session ID is an
optional execution handle. A new conversation can use `app-runs` and
`app-status` without reading the original session's files/history.

WorkIQ is read through the executing app host's `workiq-fetch`, after verifying
that host's `/me?$select=id,userPrincipalName` against the configured identity.
Another session's success is not proof for this host. On explicit auth failure,
stop: no retry, alternate client, Graph substitute, token transfer or automated
sign-in. The app records successful reads and the latest failure locally.
The standalone SDK's historical auth result is irrelevant to this mode.

Helpers import/validate/report local receipts; they do not call app tools.
Only `app-ado --collect` performs network reads, using delegated Azure CLI and
verifying tenant/object ID before every ADO query. Its UPN is the configured
directory-ID binding, not a separately returned UPN.

Dry runs cannot review, prepare/claim workers, qualify validation, consume
production assignment budget or schedule anything. Source writes are absent.
Future automation belongs to the independent agents and remains **disabled**:
same-session automation is neither implemented nor the target architecture.

## Entry points

Run from the cloned project root. Commands accept `--config <path>`; otherwise
they use the disabled synthetic `pilot.example.json`. For real or previously
recorded pilot work, supply `--config .\pilot.local.json` on every command.
Create that ignored file from the example only if it does not already exist.
Resolve identity, scope and storage approval before any receipt import.

```powershell
npm run pilot -- app-runs
npm run pilot -- app-begin --file begin.json
npm run pilot -- app-append --run RUN_ID --file receipt-batch.json
npm run pilot -- app-block --run RUN_ID --file authentication-failure.json
npm run pilot -- app-unavailable --run RUN_ID --file unavailable.json
npm run pilot -- app-status --run RUN_ID
```

Inputs are UTF-8 JSON. Identifiers are 1-128 ASCII letters/digits/dot/dash/
underscore, starting with a letter/digit. All times must be explicit UTC.
Object keys are checked; unknown fields are rejected unless within permitted
source response data. Never include headers, cookies, bearer tokens, OAuth
objects, credential stores or logs. The importer rejects credential-shaped
fields/strings but is not a general secret-redaction service: the collector
must save only permitted source data.

### Begin schema

```json
{
  "runId": "example-run",
  "executorSessionId": "optional-app-session-id",
  "dryRun": true,
  "provenance": "app-tool"
}
```

`executorSessionId` is optional provenance. `provenance` is `app-tool` for
actual app receipts or `synthetic` for tests. Run ID reuse is idempotent only
with identical inputs/configuration. The disabled example uses a fixed October
8 UTC fixture window and limits of 2,000 examined items / 300 calls **per pass**.
These are not permission to collect or approved recurring defaults. Real users
must approve their window and limits. Identity calls count against read limits.
Root metadata pages and replies share the Teams pass budget.

Storage is `.state\app-native\dry-runs\<runId>\ledger.sqlite`, with a
`<runId>-summary.json` snapshot. Production is separate:
`.state\app-native\live\ledger.sqlite`, requires activation and
`dryRun:false` at begin plus `--production` on later commands.

### Receipt-batch schema

```json
{
  "eventId": "unique-event-id",
  "pass": "workiq:created",
  "calls": [{
    "id": "actual-tool-call-id",
    "actorSessionId": "optional-executing-app-session-id",
    "completionEventId": "optional-host-completion-event-id",
    "requestedAt": "2026-10-09T01:00:00Z",
    "observedAt": "2026-10-09T01:00:01Z",
    "tool": "workiq-fetch",
    "request": { "entityUrls": ["/me?$select=id,userPrincipalName"] },
    "response": { "results": [{
      "statusCode": 200,
      "data": {
        "id": "22222222-2222-4222-8222-222222222222",
        "userPrincipalName": "collector@example.invalid"
      }
    }] }
  }]
}
```

The identity and timestamps above are synthetic contract examples, not receipts.
`requestedAt`, `actorSessionId` and `completionEventId` are optional; other
call keys above are required. A call has exactly one `response` or `failure`.
Success envelope allows `results`, optional `requestId` and string `note`;
one result with `statusCode:200` and `data`. Preserve actual source envelope,
message IDs/revisions and returned `@odata.nextLink`, not a model summary.
The importer records event IDs, receipts, capture hashes and immutable evidence.
Submitting the same event again does not double-count; changed content for the
same event ID fails.

First WorkIQ receipt must be the exact `/me` read. Later receipts must match
the reported `nextRequest` path, scope and continuation, with only approved
message projections. Metadata-only projection is allowed if it includes `id`
and `createdDateTime`; absence of body/etag remains explicit. Backend page caps
of 20 are accepted within the maximum 50. Raw and URL-encoded channel IDs are
normalized for comparison, not broadened.

All root metadata in a returned page is accepted before traversing replies.
Replies to older roots must be enumerated too. An unconsumed next root page or
reply request means **partial**, never full-day completeness. `evidenceCount`
is the observed in-window subset, not a daily total until complete.
`examinedRecords` includes out-of-window roots. No model classification occurs.
No related-link follow-up runs implicitly; approved follow-up budgets remain
separate and no out-of-scope link is fetched.

Durable imported evidence is `source.provenance: app-tool-reported`, not
independently authenticated by the local importer. Synthetic imports stay
`synthetic`. Direct ADO adapter evidence is `authenticated-source`.
The local trust boundary is the app-owned receipt file; receipts are not
cryptographically attested remote executions.

### Failure and terminal blocker schema

For a failed expected call, replace `response` with:

```json
{
  "code": "blocked-auth",
  "statusCode": 500,
  "errorCode": "AuthenticationRequired",
  "recoveryAction": "Reauthenticate",
  "requestId": "actual-request-id"
}
```

Only `code` is mandatory; allowed codes are `blocked-auth`, `unavailable`,
`failed-source`. Record only observed status/error IDs, not invented causes.
No error's arbitrary raw text is required.

If an in-scope detail read fails outside the traversal's immediate next page,
use `app-block` with `{eventId, pass:"workiq:created", call:<failed receipt>}`.
It accepts a terminal auth failure, retains already imported metadata,
increments attempt counts, and clears **continuation eligibility**, not
previously committed source cursors. It never converts partial evidence to
empty success. A blocked/budget-exhausted run cannot accept more traversal
receipts; reauthentication and a separately authorized new run are needed.

IcM unavailable input:
`{"pass":"icm:created","reason":"no-approved-connector"}`.
Unstarted/unavailable counts are null, not clean zero.

### ADO collection and offline recovery

```powershell
npm run pilot -- app-ado --run RUN_ID --pass ado:created --collect
npm run pilot -- app-ado --run RUN_ID --pass ado:changed --collect
```

Both preserve the approved area, Bug/non-Removed filters and explicit UTC
window. Changed observations do not inflate new-cohort counts.
Each pass establishes an asOf snapshot, then queries and batches by it.
Native identity validation precedes service reads. Auth failure in one pass
blocks the other; operations are journaled before reads to prevent duplicate
launches after a crash.

Raw permitted transport receipts persist incrementally. If parsing/import
fails after reads, fix the local parser and use:

```powershell
npm run pilot -- app-ado-reconcile --run RUN_ID --pass ado:changed
```

This replays **already persisted transport data**, not another live scan.
The observed changed pass used this path for a source relation URL containing
spaces: evidence URLs are now URI-normalized; raw source receipts remain intact.

ADO app receipt imports use `pass: ado:created|ado:changed`, `tool:
ado-delegated-read`, `request:{endpoint:"wiql"|"workitemsbatch",body:<actual>}`
and the actual JSON response. Query/batch order must exactly match the
deterministic scoped collector. The batch also requires
`principal:{objectId,tenantId,userPrincipalName,verifiedAt,toolCallId}`.
Imported principal receipts are app-reported, not independent local auth.
Complete passes alone advance `app:<pass>` cursors; failures retain prior
committed cursors. Revisions and captures deduplicate across created/changed.

### Importing an external app receipt bundle

```powershell
npm run pilot -- app-import-parent --run RUN_ID --file .\receipts\parent-receipts.json --config .\pilot.local.json
```

Accepts `parent-app-source-receipts-v1`: `appSessionId`, matching
`sourceWindow`, and ordered `receipts` carrying `provenance:app-tool-reported`,
`appSessionId`, `toolName:workiq-fetch`, `toolCallId`, `requestPath`,
`requestedAt`, `observedAt`, `completionEventId`, `envelope`.
The complete credential-free original bundle is copied into SQLite captures;
later resumes do not need the original session directory. The final auth
failure overrides continuation despite prior successful identity/page reads.

## Native repo-agent tracking (not activated in this pilot)

`app-review --run ID --production --file review.json` reuses the existing
investigation schema and **all 14 exclusionsChecked**. All exclusions govern
both defect and improvement intents. Unknown ownership remains blocked;
functional does not mean confirmed code defect.

Supply `{ "investigation": <record>, "exclusionsChecked": <all 14 names> }`.
The investigation ID is `investigation-` followed by SHA-256 of the UTF-8 JSON
array `[primaryEvidence.source.namespace, primaryEvidence.source.recordId]`.
The first version is 1; subsequent reviews increment it by one. Use exact
persisted evidence IDs. Recorded app reviews are `external-app-agent` actions,
not SDK model execution.

Before `prepare`, `app-plan-improvement --run ID --production --file plan.json`
can persist a versioned `areaToImprove` and source-bound `testCoveragePlan`.
Incomplete or empty discovery is `unknown`, not a confirmed gap. Existing test
links take precedence over proposed additions. A coverage-backed prepare pins
the exact improvement and plan versions, capability, requested outcome and
qualified repository skill binding into the assignment.

`qualify-skill` is a read-only repository preflight. It may run while routing
and the binding remain disabled/unqualified; it verifies the configured
reference checkout, origin, base revision and skill path and records the exact
skill content fingerprint. It does not enable the binding or approve source
writes. OfficeAgent uses the repo-wide
`.github/skills/integration-test-authoring/SKILL.md` router, which then resolves
an exact project and project-local integration shell from the isolated checkout.

`app-worker --run ID --production --operation OP --file action.json`:

| OP | JSON fields |
|---|---|
| `prepare` | `investigationId`, `repoId`, `intent` (`rca-only`, `defect-fix`, `improvement`) |
| `claim` | `assignmentId`, caller-generated `claimId`, durable `coordinatorAgentId` |
| `bind` | `assignmentId`, same `claimId`, actual `sessionId`, configured `projectId`, isolated `workspace`, 40-64 hex `baseRevision` |
| `result` | `assignmentId`, same `claimId`, bound `sessionId`, `outcome`, local durable `evidenceRef` |
| `uncertain` | `assignmentId`, same `claimId` |

Prepare enforces reviewed evidence, exclusions, ownership, write/validation
bounds and the two-new-assignment budget. Claim is atomic and enforces one
active worker; a crash/uncertain launch retains ownership, never auto-relaunches.
Only after claiming may the approved app executor call native `create_session`
with the configured project and isolated worktree, then bind the returned
handle/source revision. No helper launches sessions or mutates repositories.
If creation is uncertain, inspect existing app sessions and bind the accepted
one; do not repeat creation.

Result outcomes: `rca-complete` for RCA-only work, `blocked`, `draft-reported`.
The latter two stay uncertain/visible; a report of a draft never qualifies
source validation. This narrow pilot records handles/results, not a replacement
for app permission enforcement or product validation. Native sessions are not
OS sandboxes and instructions alone are not enforcement. Repo-specific routing,
tool permissions and validation are unresolved, so activation remains off.
No merges, auto-completion, source writes or duplicate validation are authorized.

## Demonstrated live pilot (not release qualification)

An October 2026 local pilot recorded ADO created 47, ADO changed 59 (39 changed-only),
each complete for the query at its recorded snapshot using three reads.
WorkIQ: 20 examined root metadata records, one in-window root, no bodies or
replies; parent identity + page succeeded, then a detail read returned
`AuthenticationRequired` (500). Three attempts including identity.
IcM unavailable. The overall result is **partial-or-blocked**, with zero
reviews, classifications, worker claims/launches, PRs, source writes or schedule
activation. These aggregate observations are not inferred from classification.
The underlying personal configuration, receipt IDs and raw source evidence are
excluded from the sharing package. This historical outcome is not reproducible
proof of a colleague's access. No end-to-end qualification is claimed.
See [the sharing gate](README.md#validation-and-sharing-gate).

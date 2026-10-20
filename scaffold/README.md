# Evidence-to-PR local pilot scaffold

**Local coordinator, local repository workers first. Agency is deferred.**
This is an integration template package, not a running service, installed custom
agent, or scheduled automation. No source scan, PR, build, or worker has been
launched by creating these files.

The original internally supplied scanner requirements informed these collection
and audit contracts. Personal source-document links are deliberately omitted.
All 14 exclusions remain in the schema and configuration template. A deploying
team must confirm its approved scanner policy; this package grants no source
access or permission to change that policy.

## Contents

| File | Purpose |
| --- | --- |
| `coordinator.instructions.md` | Collection, evidence review, durable routing and follow-through |
| `repo-worker.instructions.md` | Repo RCA, scoped edits, draft PRs and validation results |
| `configuration.template.json` | Known Excel Agent seeds, permissions, and unresolved deployment inputs |
| `contracts.schema.json` | JSON Schema 2020-12 portable record contracts |
| `example-flows.json` | Synthetic records and example success, exclusion and recovery paths |

The schema root accepts each record type, a configuration template, or the
example bundle. Use the appropriate `$defs` entry when validating a specific
record. Validate formats as well as structure. The schema is not a permissions
engine, scheduler, state store, or proof that an adapter is ready.

For a structural check from this package directory in PowerShell 7:

```powershell
Test-Json -Json (Get-Content -Raw .\configuration.template.json) -SchemaFile .\contracts.schema.json
Test-Json -Json (Get-Content -Raw .\example-flows.json) -SchemaFile .\contracts.schema.json
```

Both should return `True`. Cross-record invariants below require separate checks
when integrating the ledger; these commands alone do not establish live readiness.

## Local execution model

```text
Manual trigger initially; periodic trigger only after qualification
  -> local coordinator with WorkIQ and source-specific collectors
  -> durable evidence / investigations / assignments / results
  -> existing repo agent in an isolated local task workspace
  -> draft PR + source-bound validation
  -> coordinator records results and blockers
```

WorkIQ is required for the pilot but is not a substitute for complete ADO
enumeration or authenticated IcM access. Each source has a separate identity
reference and readiness check. Delegated user access and occasional
reauthentication are acceptable; raw credentials must not enter configuration,
messages, handoff records, PRs, or artifacts.

The current app can create project sessions and isolated worktrees and send
messages to them. Those are candidate local dispatch bindings, not a wired
adapter in this package. At integration time, map logical repo IDs to configured
project IDs and verify workspace isolation. Do not guess ownership from repo
names or clone every repo for every investigation. Never modify, build, or run
tests in a primary reference checkout.

Independent logical agents own durable configuration and ledger state outside
conversation lifetime. App sessions are temporary execution handles only.
Same-session automation is not the target architecture. Any future scheduler
must reload the same durable ledger and pass separate qualification; this
package registers none. See [the current implementation](../APP-NATIVE.md).

## Configuration and activation

`null` means unresolved, not automatic, empty success, or unlimited. An empty
source scope means no scan is configured, not all accessible data. The known
source selectors are copied from the supplied prompt, but `verified: false`
means the backing permissions, filters and adapter behavior have not been
checked. The configuration is deliberately disabled.

This schema validates **disabled templates only**. Before a live implementation
can activate a resolved configuration, it must supply an activation preflight
and runtime configuration validation. Do not simply flip the booleans and call
the template operational.

### First manual run prerequisites

1. Bind existing ADO, IcM and WorkIQ collectors; confirm the designated user and
   supported credential broker. Allow read-only tools, not generic source writes.
2. Supply START_DATE and END_DATE. Convert inclusive UTC calendar dates to
   `[START_DATE 00:00:00Z, day-after-END_DATE 00:00:00Z)`.
3. Verify source scope and IcM query 599514's actual filters. Configure WorkIQ
   workplace seeds and follow-up boundaries through APIs that enforce those
   boundaries. Filtering already retrieved out-of-scope content is insufficient.
4. Set numeric discovery/execution budgets, protected state storage, retention,
   run ownership and dispatch reconciliation. Do not run without durable state.
5. Resolve whether the scanner's "manual review" means human review or
   evidence-backed agent review. A confidence number is not authorization.
6. Register repo ownership, local dispatch, isolation guarantees, capabilities,
   base revision discovery and required validation gates.

Start with bounded read-only collection. Once these bindings work, eligible
findings can automatically proceed to repo investigation, draft PR proposals and
normal validation; there is no new per-assignment coordinator approval gate.
Excluded records remain audit-only for **both defects and improvements**.
Merge is not authorized.

Before periodic operation, separately configure changed-evidence revisits,
overlap handling, cadence, time zone, machine availability, and token renewal.
Demonstrate repeat execution after a fresh host process and explicit
reauthentication handling. A working interactive call is not sufficient.

## Contracts and durable state

| Record | Identity and purpose |
| --- | --- |
| `evidence` | Immutable observed version of a source record; includes source namespace/ID/revision, scope, provenance, query/snapshot timestamps and permitted content |
| `investigation` | Stable ID plus increasing version; evidence-backed classification, report/handoff eligibility, RCA hypotheses and repo ownership |
| `assignment` | Stable dispatch ID tied to an investigation version and repo; intent, permissions, bounds, dependencies and acceptance criteria |
| `workerResult` | Immutable result ID tied to assignment and attempt; findings, exact code revision, PR, validation and blockers |
| `run` | One source collection attempt; window, before/after cursor, gaps and outcome |

Separate source-record identity from evidence-version identity. Deduplicate ADO
by `(namespace, Bug ID)` and IcM by `(namespace, Incident ID)`, with versions
retained. Use explicit links for cross-source associations, never title similarity.
Do not sum bug and incident totals as a unique-root-cause count.

Store the exact permitted captured payload in protected storage and hash its
actual bytes with SHA-256; `capture.artifactRef` identifies those bytes. Hashes do
not grant permission to retain sensitive data. If retention is not permitted or
capture fails, record the reason and limitation rather than manufacture a hash.
Do not mix title, tags, description or review evidence from different revisions.

WorkIQ collection, related reads and tracked revisits represent an empty or
absent message subject as a null evidence title. Nonempty subjects remain
unchanged; raw messages and capture hashes retain the original subject. Invalid
nonstring subjects still fail evidence validation.

The state adapter must atomically claim runs/assignments and persist prepared
dispatches before calling an external worker. Persist returned worker handles
immediately. On restart, reconcile by stable assignment ID using the host's
existing sessions/jobs before redispatch. If acceptance is uncertain and the
host cannot look up the prior dispatch, mark it blocked for reconciliation:
never blindly submit again. Do not claim exactly-once execution from a prompt.

For this pilot, partial/failed/auth-blocked source runs retain their prior cursor.
Persist already collected evidence, then safely replay/deduplicate after recovery.
Commit a new cursor only after the intended source interval and records are
durably complete. Track cursors per source. A completed ADO scan does not make an
unavailable IcM source complete.

### Lifecycle rules

| Entity | Permitted progression |
| --- | --- |
| Collection | `collecting` -> `complete`, `partial`, `blocked-auth`, or `failed`; recovery creates a new run ID |
| Investigation | `triaged` -> `assigned`, `waiting`, `blocked`, or `closed`; new evidence produces a new version and may move closed work to `reopened` |
| Assignment | `prepared` -> `dispatched` -> `running` -> `completed` or `blocked`; blocked work resumes only after its explicit unblock condition |
| Superseded work | A new investigation version may supersede prepared work; reconcile active work and its existing PR before issuing a replacement |
| Validation | Record `not-run`, `queued`, `running`, `passed`, `failed`, or `blocked` per gate and exact code revision |

A worker's draft PR can exist while validation is pending or failed. Neither
assignment completion nor successful validation means an incident is resolved,
a PR is merged, or a fix is deployed. Never modify source tickets to imply that.
Keep active validation ownership and a next check until terminal evidence; an
externally blocked run waits for its concrete unblock, not blind polling.

### Checks beyond JSON Schema

An eventual ledger/adapter must enforce these invariants, which JSON Schema
cannot express across records:

- Evidence, scope, repository, assignment and dependency references resolve;
  IDs are unique at their documented granularity and dependencies are acyclic.
- Assignment evidence belongs to the referenced investigation version. Scope and
  permissions are no broader than the configuration and source permissions.
- Excluded or unavailable investigations cannot be dispatched. Evidence that
  requires clarification stays in collection/review, not an excluded-item
  improvement queue.
- An assignment's repo has an explicit owner and required capabilities. Unknown
  ownership is a visible blocker, not a default worker selection.
- Existing fixes/PRs are checked before dispatch. Updated evidence reconciles
  existing work rather than creating duplicate PRs.
- A `draft-pr-validated` result covers **every** assigned validation gate, with
  no duplicates, successful raw evidence, and all gate revisions equal to the
  result revision and current PR head. A later code change invalidates that
  validated status until fresh results are recorded.
- Windows are ordered, timestamps retain their meaning, and failed/partial runs
  do not advance cursors. Missing evidence never becomes a clean zero-result scan.
- Apply the same exclusion gate to defect-fix and improvement intents. An
  improvement must address eligible existing functionality, not add an excluded
  feature, cosmetic change, or infrastructure task.

## Later Agency migration

Keep evidence, investigation and assignment IDs and schemas unchanged. Replace
the scheduling, identity and execution bindings only after Agency-hosted WorkIQ
and repo tooling are qualified. Ability to submit an Agency job with a workload
identity does not establish downstream WorkIQ access. No Agency enrollment is
required to use or review this package.

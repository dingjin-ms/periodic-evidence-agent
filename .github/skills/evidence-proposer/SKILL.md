---
name: evidence-proposer
description: >-
  Execute the Proposer role of periodic-evidence-agent for an authorized durable
  repository assignment, selecting its existing repo-owner skill and returning
  source-bound results. Not for new evidence collection, FILTER review or
  unassigned product development.
---

# Proposer agent entrypoint

This is the repository execution role, not another scheduler or publisher.
Use the existing assignment, claim and selected executor; do not launch a
parallel worker. A session or hosted job is an execution handle, not ownership.

## Input

Receive the selected configuration and a durable, authorized assignment with
its exact investigation/evidence versions, qualified repository skill/source,
write bounds, validation gates and permissions. For app-native work retain the
configured coordinator identity, claim and bound execution handle.

Use `npm run pilot -- agent proposer help` to discover the versioned descriptor.
Facade commands delegate to existing helpers without relaxing their guards:

```powershell
npm run pilot -- agent proposer app-worker --run RUN_ID --production --operation result --file result.json --config pilot.local.json
```

A role selection, prepared assignment or `--production` flag is not permission
to execute. Synthetic reviewed-handoff support cannot substitute for real
source ingestion or an accepted real FILTER handoff.

For a fresh bounded cohort, use
[`one-shot-handoff --check|--execute`](../../../ONE-SHOT.md) instead of
inferring acceptance from structural consolidation alone. It requires the exact
complete collection receipt, pre-reserved cohort budgets and accepted immutable
FILTER executions. Real authenticated collection-only WorkIQ captures keep
their provenance through the separately authorized handoff. No-candidate ends
without dispatch; partial coverage never counts as no-candidate success.

## Repository procedure

Select only the configured assignment's owner procedure:

| Repository | Procedure |
|---|---|
| `1js` | [1JS owner](../evidence-1js-owner/SKILL.md) |
| `office-src` | [Office owner](../evidence-office-owner/SKILL.md) |
| `office-agent` | [OfficeAgent owner](../evidence-oa-owner/SKILL.md) |

An unknown repository or missing qualification is blocked, not guessed.
These are internal implementations of Proposer, not additional top-level roles.
Follow the selected procedure and source-pinned native skill in the isolated
workspace. Never execute in the reference checkout.

Resolved/Closed ADO evidence is regression input only when its captured
`Microsoft.VSTS.Common.ResolvedReason` is Fixed or Duplicate and the controller
admits a current, qualified, bounded test-only coverage assignment. A terminal
status or product-fix link alone is not authority to execute. Preserve
`existingFixes` and its source-bound coverage reconciliation; satisfied,
in-flight, unknown or changed work stays blocked. Do not fetch an out-of-area
canonical duplicate or infer that its work has been reconciled.

Keep the existing backend in charge. The restricted SDK model submits through
`pilot_finish`; the controller owns validation and publication. App-native work
uses its existing host permissions and claim/bind/result protocol. Do not create
an alternate worker, publisher, validation runner or local/hosted failover path.

## Output and resumption

Return the assignment-linked durable worker result, evidence references,
changed source revision, per-gate native results, and verified draft identity
when authorized and actually published. Otherwise return an explicit blocked,
held or uncertain state with owner and unblock condition.

A helper returning a result does not establish validation or publication
success. Every gate must pass at the exact clean publication HEAD; prior
qualification on another source revision is not changed-case validation.

Preserve failed and pre-model blocked attempts. Resume only through the existing
reconciliation path and concrete continuation authorization. Never reset the
ledger or blindly redispatch because no model call was recorded.
The one-shot path permits one explicit `--resume-auth` only after a positively
recorded pre-dispatch authentication block and supported remediation, while the
same local assignment has no workspace, result or worker/provider operation.
Unknown dispatch outcomes or a second auth failure remain blocked.

When RSI is enabled, return the normal controller's `rsi` handoff to the flow
owner even if authoring or validation failed. In app-native flows, the terminal
worker CLI action captures it; otherwise the owner calls `app-end`. The owner
invokes `evidence-rsi` in the approved host. Do not treat a queued task as a
completed RSI invocation or rerun product work to reconstruct its artifacts.

For the exact CLI-not-on-PATH rejection before authoring,
`agent proposer continue-runtime-launch --prepare|--execute` accepts a fresh
one-attempt user authorization and content-bound offline launcher smoke. It
rechecks zero tool/validation/publication activity, immutable predecessor receipts,
source eligibility and the clean owned checkout. The continuation reuses that
task checkout once without resetting the blocked job or enabling general
dispatch. Other runtime or subsequent model/native failures are not admitted.

For the exact read-only `bounded-edit-capability-unavailable` authoring result,
use `agent proposer continue-authoring-tools --prepare|--execute` only after
repairing the advertised tool contract and obtaining a fresh explicit user
authorization. Keep the old result immutable, requalify the source, verify the
owned clean workspace and any consumed runtime-reuse lineage, and claim reuse
once. Only explicitly authorized authoring/repair budget changes are allowed;
never alter native gates, production code or publication limits.

A read-only missing-mid-flow-assertion result may use that entrypoint only after
an owner-reviewed, source/content-bound existing-capability proof resolves the
reported gap without changing the harness. Preserve and recheck every consumed
ancestor and use a new attempt-specific reservation. Where the user's original
grant explicitly covers continuation until validation, bind its original time
and the prior authorization hash with `scope: "until-native-validation"`; never
fabricate a fresh approval time. The same native, write-scope and publication
limits remain mandatory.

If authoring succeeded but first registration failed before any commit or native
test, preserve that result and exact authored diff. Use a content-bound
`registrationRecovery` review only after proving native setup recovered. The
same entrypoint rechecks the unchanged authored bytes and blocked registration
before a fresh bounded authoring round. Do not admit owner-metadata drift,
committed proposals, product invocations or publication through this path.

For an already-authored candidate, use
`agent proposer continue-local-validation --prepare|--execute` only under the
[recorded handoff contract](../../../APP-NATIVE.md#recorded-source-role-handoff)
and its separately authorized validation-only continuation. The actual Collector
and FILTER replay receipts must match the original worker ledger. Keep the
original model proposal and source revision; this operation must not invoke a
new authoring model or create another candidate commit.

For the specifically recorded dependency-fingerprint timeout after an approved
commit but before the first native invocation, use
`agent proposer continue-native-preparation --prepare|--execute`. It requires
the immutable failure and owner request/approval hashes, the same clean approved
commit, no native output directory or publication operations, and the original
until-validation grant/time linked by its authorization hash. It reuses the owned
checkout once in fresh private state with zero initial model calls or commits.
Native gates, source qualification and zero infrastructure retries cannot change.
One recorded zero-stage workspace-base field mismatch can be continued once with
both predecessor reservations intact; nested dispatch corrections are rejected.
Later test-only repair remains bounded and requires a new external owner review;
an already-invoked native failure is never admitted as a preparation failure.

## Authority

No new evidence collection, reinterpretation of FILTER acceptance, permission
expansion, uncontrolled retries, duplicate workers, merge or deployment.
Respect the configured budgets and source/publication gates. Skills are
procedures, not OS sandboxes.

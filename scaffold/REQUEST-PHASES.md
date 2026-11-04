## Fresh local tools and durable request phases

`run-test-request` supports a separately approved `requestExecution.phases` policy.
The CLI owns each Windows phase in a kill-on-close Job Object, drains stdout and
stderr to private files, and collects native/supervisor identity and terminal
receipts before returning. No service, detached model or operator adapter is used.

Start with the existing review-only command. Continue the same config/state and
exact request using one invocation per phase:

```powershell
node src/cli.js run-test-request --id REQUEST_ID --authorize-review --config approved.json
node src/cli.js run-test-request --id REQUEST_ID --authorize-review --execute --authorize-commit --authorize-push --authorize-draft-pr --phase prepare --config approved.json
node src/cli.js run-test-request --id REQUEST_ID --authorize-review --execute --authorize-commit --authorize-push --authorize-draft-pr --phase author --config approved.json
node src/cli.js run-test-request --id REQUEST_ID --authorize-review --execute --authorize-commit --authorize-push --authorize-draft-pr --phase commit --config approved.json
node src/cli.js run-test-request --id REQUEST_ID --authorize-review --execute --authorize-commit --authorize-push --authorize-draft-pr --phase validate-GATE_ID --config approved.json
node src/cli.js run-test-request --id REQUEST_ID --authorize-review --execute --authorize-commit --authorize-push --authorize-draft-pr --phase publish --config approved.json
```

Run `validate-GATE_ID` once for **each configured native gate, in order**. Prepare
copies tools then checks readiness. Author retains the genuine accepted proposal
and tool accounting without committing. Commit performs permitted Markdown
formatting/finalization and native hooks. Each validation gets its own fresh
source-bound workspace and copied tools. Publish requires every gate at the same
clean commit; uncertain push/PR results cannot be replayed. No new planning file,
model budget or hand-authored candidate is introduced at the boundaries.

Policy fields: `scopeApproved`, `approvalRef`, `expiresAt`, `foregroundMs` (at most
600000), `maxTotalMs`, and `budgets` with `prepare`, `author`, `commit`, `validate`
and `publish` milliseconds. Each indivisible budget plus90000ms startup/cleanup
must fit the foreground owner. Native command/provision/materialization bounds
must fit the chosen phase; they are not shortened to make admission pass. Every
validation phase uses the same configured `validate` ceiling. FILTER elapsed time
and all worker phases count against the total; model tool limits and existing
credit/expiry gates remain intact. The configured credit ceiling is soft, not a
promise of provider monetary enforcement.

A phase checkpoint pins config, assignment, source/file population and cumulative
usage. Continuation rechecks ADO, skill/assignment, tool bytes and owner terminal
receipt. Changed or interrupted state fails closed. Completed CLI invocations may
return their old terminal receipt as `replayed`; this is historical output, not a
new freshness check or permission to run another phase. No automatic retry exists.

Initial supported phase lane: ordinary local ADO requests, zero model-repair and
infrastructure retries, fixed native command gates, no profile-based staged/live
gates, changefile generation, RSI or remote builds. Those unsupported combinations
are rejected, not silently skipped. A future live gate needs an independently
bounded integration; do not relabel offline qualification as live readiness.

### Tool manifest

`requestExecution.tools` contains `scopeApproved`, `approvalRef`, `timeoutMs`
(at most300000), and a pinned absolute `manifest.path`/`manifest.sha256`.
`request-local-tools-v1` includes:

- exact `sourceRevision`, `targetRef`, `targetRevision` and provenance;
- `sourcePins`: repository path, Git-blob SHA256 and checkout SHA256 for locks,
  manifests, hook source and normal command entries;
- `runtimePins`: absolute executable/file paths with SHA256;
- nonoverlapping ignored destination `roots`, `files` (relative destination,
  absolute approved local source, SHA256, mode0644/0755), and internal `links`.

`captureLocalToolFiles` can inventory explicitly allowed local cache inputs;
`packageRoot:true` follows that package's existing dependency resolution. It
never downloads/installs or issues a trusted qualification. Embedded fixture
package manifests are not dependency roots. The approved manifest must cover
normal generated entry targets, not replace them with fabricated shims.

Materialization verifies sources before writing, copies bytes exclusively into
new ignored roots, and creates links **only within the new candidate**. It never
writes through donor junctions. A missing remote-tracking target may be bound to
its exact already-local pinned Git object; drift is rejected and no fetch occurs.
A partial clone retains read-only local Git object alternates, not mutable tool
sharing. Missing/changed source, conflicting target, deadline or partial copy
retains a blocked receipt. Use a distinct explicitly reconciled attempt, never
reuse the partial output or retry a model/publication effect.

Tool copying and phase control are not observer qualification. Required
original-open/live/current-turn/GridLink/cleanup evidence remains fail-closed.

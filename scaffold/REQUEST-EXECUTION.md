## Maintained request preflight and deterministic formatting

The normal `run-test-request` path can enable a separately approved repository
`requestExecution` policy. It is included in the validation-contract hash and
therefore in skill qualification; do not retrofit it onto an admitted assignment.

Required fields:

- `enabled: true`, `scopeApproved: true`, nonempty `approvalRef`;
- `nativeHooks: ".githooks"`;
- `requiredCapabilities`: the explicit nonempty capability population;
- `preflight`: pinned absolute executable/SHA256, arguments, positive timeout at
  most120000ms, and a nonempty `files` array of exact absolute tool/profile hashes;
- optional `formatMarkdown`: the same command contract, with `--write` in args.

Only `{workspace}` is substituted in arguments. Preflight runs in the actual
isolated candidate before PROPOSER and must emit JSON with `status: ready`, the
exact `sourceRevision`, `evidenceRef`, and all required `capabilities`. Source
mutation, stale files, missing observers, failed command or changed authority
blocks authoring. No implicit install/authentication is performed. The maintained
`node scripts/cross-app-preflight.mjs WORKSPACE PROFILE` implements read-only
candidate module/file checks and source-bound capability qualification checks.
It reports missing capability names; it does not manufacture a ready observer.

After genuine PROPOSER acceptance, the dispatcher automatically captures original
Markdown bytes and runs the pinned formatter only on changed Markdown paths. It
retains the model proposal and before/after file hashes under local state. The
file population must remain exact; executable changes or non-whitespace Markdown
changes are rejected. All normal validation executes on the resulting bytes.
Successful idempotent format recovery returns the retained receipt without
running the formatter again; failed/uncertain output refuses replay. No additional
model call or operator repair file is needed for this Markdown-only operation.

Commit and push explicitly select the normal `.githooks` when this policy is
enabled. Other repository gates, source checks, grants and no-replay remain intact.
The policy does not qualify dependencies just because hook files exist; the
preflight profile must pin the required native command/tool closure and active
capability evidence. The independent native validators still run during Git.

### Readiness profile

`cross-app-readiness-v1` binds `sourceRevision`, `approvalRef`, a nonempty `files`
list of repository-relative SHA256 pins, `modules` with package owner/name, and
`capabilities` with name/status/sourceRevision/evidenceRef/expiresAt. Only current
`qualified` capabilities are returned. The profile and preflight command must be
included in the approved command-file hashes. An operator evidence reference is
not a newly observed product fact. Missing qualification remains blocked.

### Exact next qualification shape

```powershell
node src/cli.js run-test-request --id REQUEST_ID --authorize-review --execute --authorize-commit --authorize-push --authorize-draft-pr --config qualification.local.json
```

Before running, bind the current private ADO capture, integrated controller and
canonical product skill revision/hash, ready observer profile, isolated dependency
and native-hook resources, and explicit fresh per-stage model authority. Do not
provide a sample PR, operator handoff or prewritten candidate. This command is
preparation guidance, **not authorization to spend a model allocation**. Any
manual intervention means the no-intervention qualification did not pass.

Known live gaps remain documented in the product's `READINESS.md`. Do not submit
this command until those required capabilities and a distinct current FILTER and
PROPOSER allocation exist. Prior historical sessions and budgets cannot be reused.

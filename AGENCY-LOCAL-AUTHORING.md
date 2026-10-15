# Authoring providers

The Controller supports three authoring transports for repository-skill
assignments. `copilot-sdk` remains the default. `agency-local` and
`agency-remote` are explicit opt-in providers; neither replaces the evidence
controller, the hosted Agency executor, or final publication policy.

When either Agency provider is selected, Agency performs only bounded
investigation and authoring. The Controller still:

- provisions and attests the isolated checkout;
- loads the pinned repository skill;
- owns the cumulative tool-call budget;
- commits each authoring round;
- validates each exact revision outside the model tool surface;
- supplies bounded failure diagnostics to repair rounds;
- pushes the final branch and creates an active Draft PR; and
- prohibits merge.

## Comparison

Provider choice changes authoring compute and result transport, not repository
policy or delivery authority.

| Dimension | Copilot SDK | Local Agency | Remote Agency |
|---|---|---|---|
| Selection | Default when omitted or `copilot-sdk` | Explicit skill binding | Explicit skill binding |
| Authoring compute | Local Controller process | Local Agency process | Agency remote job |
| Model transport | Direct SDK session | Agency CLI with authenticated MCP bridge | Agency CLI remote job on an exact staging branch |
| Source result | Controller workspace | Controller workspace through `pilot_write` | One commit on a separate deterministic result branch |
| Repair continuity | Existing SDK context | Exact Agency session UUID | New source-bound remote round with bounded diagnostics |
| Commit and validation | Controller-owned | Controller-owned | Controller imports approved files, commits and validates locally |
| Final push and Draft PR | Controller-owned | Controller-owned | Controller-owned |
| Merge | Prohibited | Prohibited | Prohibited |
| Recommended use | Stable baseline | Local orchestration experiments | Qualified remote compute without final publication authority |

There is no automatic fallback between providers. Missing, changed or failing
Agency configuration blocks the assignment instead of silently switching to
the SDK path. Qualify both paths against the same repository skill and
validation contract before enabling Agency for that binding.

## Local Agency configuration

The SDK provider remains the default. An omitted
`skillBindings[].authoringProvider`, or the explicit value `copilot-sdk`, uses
the existing `@github/copilot-sdk` session unchanged.

To opt one qualified skill binding into Local Agency, define a provider and
reference its ID:

```json
{
  "authoringProviders": {
    "agency-oa": {
      "type": "agency-local",
      "executable": "C:\\absolute\\path\\to\\agency.exe",
      "profile": "periodic-evidence-isolated"
    }
  },
  "repositories": [
    {
      "id": "office-agent",
      "skillBindings": [
        {
          "id": "oa-integration-test-core",
          "authoringProvider": "agency-oa"
        }
      ]
    }
  ]
}
```

The real binding retains all other required fields shown in
`pilot.example.json`. The executable must be an absolute path. The profile name
identifies a controller-generated empty profile in the session's private state
directory; it does not depend on mutable user-global Agency configuration. The
launcher starts Agency from that controller-owned directory and uses
`--profile-only`, so ambient global and product-workspace MCP sources are not
loaded. Current Agency/Copilot CLI builds require
`limits.maxAiCreditsPerSession` to be at least `30` when this provider is used;
the controller still passes that value as a hard per-session ceiling.

Provider configuration is SHA-256 pinned into new assignments. Changing a
binding, executable or profile after preparation causes current-assignment
reconciliation to fail rather than silently switching transports. The
assignment remains `execution: "local"`;
`config.agency.selections` and the hosted executor are not involved.

## Remote Agency configuration

Remote Agency is selected on one exact skill binding:

```json
{
  "authoringProviders": {
    "agency-oa": {
      "type": "agency-remote",
      "executable": "C:\\.Tools\\agency\\CurrentVersion\\agency.exe",
      "profile": "periodic-evidence-isolated",
      "model": "gpt-5.6-sol",
      "pollSeconds": 30
    }
  },
  "repositories": [
    {
      "id": "office-agent",
      "skillBindings": [
        {
          "id": "oa-integration-test-core",
          "authoringProvider": "agency-oa"
        }
      ]
    }
  ]
}
```

The Controller prepares local validation dependencies and compile outputs before
submitting a remote job. Authentication or runner preparation failures therefore
block without consuming remote compute. It pushes an immutable exact-base branch
named `pilot-agency-base/<assignment>/round-<n>`.

The remote prompt requires one transport commit containing only approved source
paths and `.periodic-evidence-agent/result.json`, followed by a non-force push
of `pilot-agency-result/<assignment>/round-<n>` through the full Agency proxy
with LFS push disabled. Agency v2 does not otherwise persist workspace edits,
and parsed logs may contain no authoritative diff.

Before import, the Controller verifies terminal success, exact-base ancestry,
a commit count from 1 through 20, bounded approved paths, regular Git blob
modes, file-size limits and exact assignment/round/base envelope bindings. Only
approved source files are restored; the transport envelope is never copied into
the final commit. Accepted or uncertain jobs are never automatically replaced.

## Concurrent repository scheduling

The Controller can launch several prepared assignments with `dispatch-ready`.
`limits.maxWorkers` bounds all local and hosted workers together.
`limits.maxWorkersPerRepository` defaults to one, allowing OA, 1JS and Office
to progress concurrently without placing two heavy validation jobs in the same
repository lane. Every assignment uses its own durable dispatch lock, while
the active-count check and `prepared -> dispatching` transition occur together
in one immediate SQLite transaction.

The scheduler does not weaken publication policy: execution still requires
explicit commit, push and Draft PR authorization, every assignment passes
normal dispatch admission, and no merge is performed. An overlapping
scheduler cannot resubmit a claimed or uncertain job. This is same-machine
concurrency only; a future multi-machine Controller requires shared durable
leases and external validation runners rather than a network-shared SQLite
database.

After the delivery retention interval, `transport-gc` can preview or remove
only the exact deterministic `pilot-agency-base/...` and
`pilot-agency-result/...` refs recorded for completed remote rounds. It first
verifies their remote tips and the preserved final `pilot/<assignment>` branch.
The final branch and Draft PR are never automatically deleted.

## Permission boundary

For every dispatch attempt, the controller:

1. Generates one explicit UUID-backed Agency/Copilot session.
2. Starts an authenticated local RPC endpoint using a random one-time token.
3. Writes a private temporary MCP configuration that launches
   `src/agency-mcp-bridge.js`.
4. Keeps Agency logs under the controller state directory and its manual
   retention/access policy.
5. Starts Agency with default MCPs, configured plugins, built-in MCPs, custom
   instructions, ask-user, remote control and remote export disabled.
6. Restricts the model-visible tool set to:
   `pilot_list`, `pilot_search`, `pilot_read`, `pilot_write`, and
   `pilot_finish`.

The bridge owns no repository policy. It forwards authenticated JSON requests
to the controller-owned `WorkerTools`, which enforce path bounds, file-size
limits, write prefixes, edit permission, result shape, duplicate finish
rejection and the cumulative call budget.

`pilot_list` accepts an optional repository-relative `path`. If a repository's
root tracked-file inventory exceeds the shared file-size limit, the controller
fails that call with an instruction to list a narrower directory instead of
sending an unbounded tool result into the model context.

Agency stdout, stderr and final prose are not authoritative. A successful
process exit without an accepted `pilot_finish` triggers one finalization-only
resume of the same explicit session while the authenticated controller remains
active. That turn may correct a concrete mechanical defect already identified
in an authored file, but it may not restart broad investigation. If it also
omits `pilot_finish`, the assignment blocks. Unknown tools, malformed requests,
incorrect tokens, process startup failures, timeouts, nonzero exits and failed
session resume all fail closed.

## Local Agency repair rounds

Round zero starts the explicit session ID. Each validation repair round resumes
that exact ID; it never selects the most recent session. The controller sends
the same shared prompt contract used by the SDK provider plus the current
structured validation diagnostics. `WorkerTools.usage` remains shared across
all rounds, and every changed round is committed and validated as a distinct
revision.

## Qualification and rollout

Qualify each repository independently. Start with deterministic fake-process
tests, then run an approved low-credit smoke in an isolated non-production
repository before enabling a live binding. OA, 1JS and Office may each use the
provider, but each repository still needs its own qualified skill, write
prefixes, validation gates, commit identity and Draft PR configuration.

The controller never merges a PR. Enabling this provider does not authorize
merge or change the existing human-review requirement.

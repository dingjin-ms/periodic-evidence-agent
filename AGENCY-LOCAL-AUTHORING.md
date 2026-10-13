# Local Agency authoring provider

The Local Agency authoring provider is an optional model transport for
repository-skill assignments. It does not replace the evidence controller, the
hosted Agency executor, or any repository side effect.

When selected, Agency performs only the bounded authoring conversation. The
existing local controller still:

- provisions and attests the isolated checkout;
- loads the pinned repository skill;
- owns the cumulative tool-call budget;
- commits each authoring round;
- validates each exact revision outside the model tool surface;
- supplies bounded failure diagnostics to repair rounds;
- pushes the final branch and creates an active Draft PR; and
- prohibits merge.

## Configuration

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

## Repair rounds

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

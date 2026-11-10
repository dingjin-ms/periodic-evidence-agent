# Evidence URL discovery before Workflow 2

Discovery finds **where the relevant evidence is**. Existing collectors then
read that evidence for case design. A URL list is not approved product behavior.
Use the [discovery skill](../.github/skills/discover-test-evidence/SKILL.md) for an
explicitly requested scoped investigation; ordinary generation from configured
URLs does not silently authorize broad discovery.

## Separate stages

1. Establish scope, private storage, designated identity and finite budgets.
2. Discover and qualify URLs for Bizchat, GHCP, CPNB and Code.
3. Validate a selection manifest, coverage and gaps.
4. With separate permission, apply the selected catalog to
   [generateE2E.config.json](../generateE2E.config.json).
5. With generation permission, start a new [URL-first case run](CASE-GENERATION.md).

Discovery never writes remote ADO items, creates assignments, executes product
tests, generates final cases, commits or publishes PRs. It uses the app host;
there is no extra service, SDK model invocation or automatic subagent launch.
Host receipts are tool-reported. Controller checks do not establish OS isolation,
source authenticity, product authority or exhaustive search.

## Fresh independent deep discovery

Every new user request to discover/find evidence requires a fresh independent
deep search, including repeated requests for the same topic. Configured URLs are
not discovery seeds or search boundaries; users need not provide source URLs.
Search from the requested feature/integration within approved namespaces, not
just the existing catalog or its linked neighborhood. Compare existing URLs and
prior manifests with fresh findings afterward, not instead of searching.

Account for requirements/checklists, failures, specifications/documents, Figma
designs, implementation and existing tests with substantive originals or explicit
search/access/capability/budget gaps. Follow relevant fresh results in depth;
metadata, a fixed handful of links and failed searches do not establish coverage.
The [skill](../.github/skills/discover-test-evidence/SKILL.md) specifies provider
fallbacks, visual reads and requirement/test-oracle conflict handling.

Use `--refresh` once to start each new discovery request, then continue its
returned run ID. Explicit resume/status/report-existing-results requests and
executor retries reuse the recorded run without recollection. A new request
does not bypass authentication, unresolved calls, scope or budget safeguards.
Editing this guidance does not itself authorize a source search.

## Agent/controller operations

The skill prepares the private JSON; users need not write routine manifests.
Every file input must be inside the existing approved deployment state directory.
Keep the same explicit `--config` option on every command when nondefault.

```powershell
node src\cli.js case-discover-start --file PRIVATE_REQUEST --authorize-discovery --refresh
node src\cli.js case-discover-context --run RUN_ID
node src\cli.js case-discover-reserve --run RUN_ID --file PRIVATE_TASK --authorize-discovery
node src\cli.js case-discover-capture --run RUN_ID --file PRIVATE_RECEIPT --authorize-discovery
node src\cli.js case-discover-finalize --run RUN_ID --file PRIVATE_SELECTION --authorize-discovery
node src\cli.js case-discover-apply --run RUN_ID --authorize-config-update
```

The [controller-owned schemas](contracts.schema.json) define `caseDiscoveryRequest`,
`caseDiscoveryTask`, `caseDiscoveryReceipt`, `caseDiscoverySelection` and catalog
records. The agent cannot create a permissive replacement schema for acceptance.

The request includes `format:case-discovery-request-v1`, approval reference,
scope, all four surfaces, approved concrete HTTPS namespace prefixes, exact tool
names with versions (null when unknown), model (nullable), and all six limits.
Maximum allowed limits are 120 calls, 90 minutes, 1 MiB per receipt, 10 MiB total,
100 candidates and 30 selected sources. Smaller approved limits take precedence.
Identity calls and pagination count; pending calls reserve a full response bound.
The initial cutoff is recorded in UTC; a 90-day recent-change lookback does not
exclude older authoritative evidence that remains applicable.

A task declares `id`, `kind` (identity/search/read), `provider`
(workiq/ado/figma/repository), `toolName`, exact `url`, `query` (nullable),
`surfaces` and `identityRef` (null for identity and repository tasks).
For searches, URL identifies the approved search namespace and query is exact.
Every provider call/page needs a reservation; no opaque multi-call task.

Identity tasks use provider identity locators, not an arbitrary content URL:
WorkIQ's locator is `https://graph.microsoft.com/v1.0/me` but execution must be
the native WorkIQ `/me` operation, not a direct Graph request. Figma uses
`https://api.figma.com/v1/me`; ADO uses the approved organization's
`https://dev.azure.com/ORGANIZATION/_apis/connectionData`.
The receipt normalizes the actual provider identity into `id` and
`userPrincipalName`, or Figma `email`, with the actual response retained.
ADO connectionData uses its provider ID and Account property; that provider ID
is not assumed to be the Entra object ID. This host-reported account check does
not replace the native ADO adapter's delegated object/tenant token checks.
Only identity locators get the identity-read exception to content namespace scope.

A receipt includes the reserved `operationId`, actual UTC `observedAt`, sanitized
`response`, `access` (full/partial/metadata-only/blocked), `identity` (nullable),
`candidate` (nullable) and limitations. Qualified candidates need substantive
exact-source reads and include type, title, exactLocation, sourceVersion
(nullable), authority, authorityBasis (nullable), applicability and limitations.
Repository candidates require a full commit and exact file location. Stable
source IDs are computed from canonical URLs; a URL shared by surfaces is one
candidate with multiple surface associations.
Use actual source responses, never a model-generated replacement.
Blocked receipts also require `failureKind` (auth/access/source/capability).
An auth failure stops subsequent reads for that provider; a source-specific
access failure does not stop unrelated useful work. Neither permits repeating
the failed exact operation or silently buying a new scope/budget.

Selections decide selected/held/rejected for every candidate. Coverage contains
one row for each surface, with status searched/partial/not-found/unavailable,
actual operation IDs and reason. Incomplete rows and held candidates require
gaps. Superseded candidates cannot be selected as current evidence.

## What stronger acceptance checks mean

Think of receiving ten documents. "The files look fine" is not a check.
A useful receipt says **which ten were expected, which ten were checked, what
was checked, what failed, and what was not checked**.

| Question | Required measurable check | Deliberate failure test |
|---|---|---|
| Did we examine every candidate? | Expected and examined ID sets match exactly; counts are recorded | Omit one candidate or repeat one ID |
| Did we account for every surface? | Exactly four unique coverage rows, with resolving call references | Remove Code's row |
| Did a search actually run? | Searched/not-found rows reference successful scoped search receipts | Claim searched with no operation |
| Was the source actually qualified? | Selected candidates come from exact reads, not search metadata | Submit a search hit as a full candidate |
| Is incomplete coverage visible? | Incomplete/held scope has explicit gap records | Hide an unavailable surface without a gap |
| Can we trust the bytes? | Manifest and applied-config hashes match retained records | Change one hash or selected URL |
| Did we preserve the user's edits? | Current config matches the recorded baseline before replacement | Edit the config after discovery |
| Did the check itself work? | Each gate has a negative regression that must reject the bad case | Run the intentional bad input |

Zero candidates after an actual scoped search is an honest outcome, not a useful
selection. A sealed zero-selected manifest stays blocked and cannot update config.
Four coverage rows alone do not prove broad or complete evidence.

The acceptance report records expected/examined IDs and counts, selected count,
calls examined, four-surface accounting, check version, and explicitly not-run
independent authority review and product execution. Invalid input fails with a
nonzero CLI result rather than a success-shaped receipt.

Offline synthetic tests prove the controller's rejection and wiring behavior.
They do **not** prove the LLM understands product semantics. Separate bounded
agent evaluations should cover older-approved/newer-draft conflicts, bug versus
requirement, misleading notifications, unavailable Figma search, partial
pagination and injected source instructions. Model evaluations require explicit
credit/runtime authorization; they are not implicit default CI or live discovery.

## Configuration and readiness

Existing primary inputs, template/sample, guidance and unrelated keys are
preserved. New `discovery` metadata binds the run/manifest hash, and `sources`
contains the selected IDs, types, URLs and surface associations only.
No raw content, private paths, identity records or credentials are projected.
Discovery-backed collection uses template/sample plus the selected catalog,
not retained legacy behavioral URLs. A mandatory legacy Figma/checklist URL is
not invented when discovery finds none. Legacy five-URL mode remains strict.

States mean different things:

- `selection-qualified`: selected locators/provenance pass structural checks.
- `partial`: usable selections coexist with explicit gaps/held choices.
- `blocked`: no selected sources; no config application.
- `configuration-applied`: local replacement was read back at its expected hash.
- Existing `ready-for-design`: captured context is available, not approved
  expectations, complete coverage or runnable automation.

An unambiguous supported slice may proceed with other surfaces explicitly
excluded/blocked. The case batch still has a default ceiling of 15 across all
selected surfaces. Independent source/case QA and publication grants still apply.

Config publication records intent before replacement and reconciles old/new
hashes after interruption. Unknown drift blocks rather than overwrites.
Filesystem replacement and SQLite completion are not one transaction, and
external editors do not honor controller locks. Preserve prior bytes privately;
do not claim a filesystem compare-and-swap guarantee.

For an explicit resume, reconcile the same run's retained responses; never
reread pending/uncertain calls or treat resumption as a new discovery request.
Authentication failures require supported remediation and a separately approved
new pass, not repeated calls. `--refresh` creates a child of the matching prior
request binding; changed instructions/identity/scope require reviewed new input.
Existing case runs retain their root config-drift blocker. Apply a selection
before starting a new case run, never rewrite the old run to adopt it.

Historical fixture metadata and event-order evidence may guide source selection,
but reproduction, generator execution, full claims/criteria/journeys packaging,
unattended SDK discovery and scheduling are out of scope.

## Design references

- [Claude AI-native SDLC playbook](https://claude.com/resources/articles/the-ai-native-sdlc-playbook):
  stage artifacts, explicit source of truth, deterministic controls and prompt evaluations.
- [Copilot Cowork engineering lessons](https://commandline.microsoft.com/how-we-built-copilot-cowork-python-to-rust-migration/):
  narrow contracts, host authority, non-vacuous checks and bounded loops.

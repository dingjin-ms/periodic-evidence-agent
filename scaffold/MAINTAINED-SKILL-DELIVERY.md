## ADO with a ready harness and canonical skill

`run-test-request` is the normal entrypoint. Its FILTER authors the reviewed plan;
PROPOSER receives it through `acceptTestRequest` and the existing dispatcher,
validation and Draft transports. A hand-authored plan, seeded candidate or
manually published PR is not required input. Injected external boundaries in
integration tests are synthetic qualification, not live model/product proof.

The canonical product-repository entry for cross-app declarative authoring is
`.github/skills/author-declarative-e2e-test/SKILL.md`; it references
`ui-e2e-automation` for shared UI principles. A WAC-only workspace skill or an
installed copy is not a substitute. The configured binding selects the entry;
this controller does not infer a path from a sample PR.

Before FILTER model submission, the controller reads the pinned Git blob,
checks its revision/path/SHA256 against skill qualification and includes its
contents in `repositorySkill`. The complete model-input budget includes these
bytes. This local pinned-file read precedes model admission; existing action authorization is rechecked at session/tool/submission boundaries. Missing,
stale, changed or oversized skill content blocks model submission.

PROPOSER loads the same qualified skill from its isolated checkout and embeds
its instructions in the normal authoring prompt. Both stages record a
`repository-skill-delivery` operation at model-input submission, including
session, source revision, path, byte count and content hash. This records
**submitted input**, not model comprehension, task completion or capability
readiness. External bundles remain unsupported for request FILTER; no ambient
skill installation is substituted.

The source-bound integration fixture exercises intake → FILTER planning →
PROPOSER bounded writes/finish → normal Git/validation/push → injected Draft
transport, and checks both actual SDK-boundary prompts and matching delivery
receipts. It contains no required sample PR. Scope, authorization, publication
grants, source freshness, no-replay and unsupported-capability gates remain in
force.

A ready harness is a separate requirement. Original-workbook editing still needs
qualified live/saved/conversation/current-request observers and navigation
capabilities. A documented missing observer, inert failure declaration or passing
fixture does not make it ready. Do not reuse historical one-session allocations
for live qualification; it needs distinct current per-stage authority. No model
calls are implied by these offline checks.

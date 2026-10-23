# Automatic local FILTER in the shared loop

The native adapter now supports filterExecutor=local-sdk. It uses the existing
restricted SDK tools and acceptance validator; it does not translate a host-written
result into execution proof or create Agency receipts for a local session.

Configure localFilter with explicit maxRequests, maxToolCalls, timeoutMs,
maxSourceBytes, maxRequestBytes, useExistingLogin and exact sources (repoId/revision).
Each repository must select qualificationRefresh=local and baseRef equal to that
revision. The controller performs the existing read-only skill qualification before
source collection and stores it in the per-run proposer ledger.

The installed CLI requires a minimum 30-credit session ceiling. It is a **soft
ceiling**: an in-flight call can exceed it. localFilterPreflight requires explicit
acceptSoftCreditLimit=true; neither this adapter nor its request builder sets that
approval. Ordinary authorization to iterate is not silently converted into acceptance
of an unknown overrun. Keep the flag false until the owner accepts that behavior.

Add localFilterPlan to the native settings file with:

- instructions: bounded read-only FILTER instructions;
- groupingReview: reviewer, reviewedAt and rationale approving an exact singleton
  source-record partition, not asserting semantic review;
- sharing: approved audience and approvalRef for all collected materials;
- routing: the existing repository authoring capability;
- authorization: the one-shot handoff authorization from ONE-SHOT.md, plus
  maxFilterAiCredits. The whole cohort's per-session ceilings must fit that explicit
  aggregate allocation. Proposer credits remain a separate allocation.

The controller constructs all groups, coverage/material hashes, manifest and result
paths from the actual collection receipt. It reserves the complete cohort before
any model submission. Every batch has an additional durable intent before calling
executeLocalFilterBatch. On resumption a missing or unfinished outcome is blocked;
a completed model result is recovered from immutable analysis/session receipts.
Output-file failure never permits another model submission. Automatic local retry
forks are intentionally not supported in this one-shot path.

The same source, canonical membership, complete opened-file coverage, model-event,
session, terminal and result checks in reconcileLocalFilterCohort remain mandatory.
All batches must pass before Proposer eligibility. Source collection, FILTER and
proposer state remain separate, with no retroactive promotion of an old collection.

## Verified local tokenization

scripts/count-o200k.mjs accepts the existing tokenizer JSON protocol on stdin and
an absolute o200k_base.tiktoken vocabulary path as its positional argument. It performs
ordinary-text BPE locally and verifies OpenAI's published vocabulary SHA256
446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d. No vocabulary is
bundled, downloaded at runtime, or replaced with an estimated byte/token ratio.

Use scripts/qualify-o200k.mjs with that path for known-vector checks. Bind the counter
script, source module, vocabulary and Node executable hashes using filterBatching.counter.
The implementation requires Node 24 and rejects malformed Unicode or inputs over 1 MiB.
The tokenizer pattern is derived from MIT-licensed OpenAI tiktoken; its notice is in
TIKTOKEN-LICENSE.txt. Tests compare heap BPE with an independent reference over 1,000
inputs, including tie ordering, plus Unicode input coverage.

Pin a read-only authenticated model-catalog response that actually reports
tokenizer=o200k_base for the selected concrete model. Do not assume a tokenizer for
an arbitrary provider or auto-selected model. Record that evidence and the counter
verification in filterBatching.verificationRef. System instructions, source-analysis
capacity, tool definitions, output and transport overhead still need explicit
reserves. These are capacity reservations, not measured usage or a hard billing cap.

Run the normal loop-request, loop-manual and loop-scheduled scripts documented in
LOOP-CONTROLLER.md. The requested execution and recovery contracts are identical;
source or provider authentication failure is preserved as a real blocker. Capture-only
RSI and an accepted no-candidate outcome remain distinct from an evaluated improvement
or a validated product-test publication.

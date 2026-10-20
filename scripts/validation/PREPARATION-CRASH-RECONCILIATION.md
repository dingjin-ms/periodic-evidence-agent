# Preparation parent termination: blocked restart and explicit reconciliation

This is a small offline boundary fixture, **not an automatic recovery API**.
It does not extend the cancellation runner's production support, qualify power
loss/storage failures, authorize real preparation, or prove native reuse.
The original cancellation PR remains limited to a surviving parent.

```powershell
node --test --test-reporter=spec test\preparation-crash.test.js
```

Windows and Node 24+ are required. The fixture has a 90-second test budget,
60-second native attempt budget, explicit 45-second controller stage budgets,
30-second profile timeout and bounded process inspection/exit checks. These are
small-fixture budgets, not estimates or approved budgets for a real product.
It uses an isolated five-file Git source and a pinned local Node profile; it
does not install dependencies or read/modify any retained product state.

## What is exercised

The real `runPreparationAttempt` API completes dependency preparation and enters
compile. The profile creates partial output, a private source mutation, a stage
lock and a grandchild. Controller progress, rather than product stdout, binds
the compile boundary. An external test auditor captures the lease name/owner,
source revision/content hashes, profile hash, exact attempt root, and OS process
IDs, creation ticks and parent relationships. The auditor fsyncs this checkpoint
**before** requesting a fixture-only driver pause and forcing owner termination.
The pause makes the injection deterministic; it is not controller progress or
an added production recovery mechanism.

Two new Node processes restart the same source/attempt-parent/plan: once after
owner termination, and once after explicit native-job drain but before lease
recovery. Both must throw `overlap`, leave the lease and receipt inventory
unchanged, and create no new attempt. The previously verified dependency receipt
may exist in private state; there must be no compile receipt or accepted final
outcome. No partially completed attempt is promoted to prepared state.

**Killing the Node owner does not imply killing its native job.** The
`KILL_ON_JOB_CLOSE` handle is owned by the outer PowerShell supervisor, not by
the initiating Node process. The fixture records which captured generations
actually survive. If necessary, only explicit, generation-bound supervisor
termination is used to drain them; the test does not infer exit from a dead
parent or timeout. A run in which they have already exited does **not** exercise
or prove the manual supervisor-termination branch.

## Safe explicit reconciliation order

The helper in `test/preparation-crash.test.js` is test-only. It demonstrates this
operator procedure under a quiesced, externally audited fixture; it is not a
general-purpose cleanup command or authority granted to a skill.

1. Stop all other launchers/writers for the affected source and configured
   attempt parent. Do not change attempt parents to bypass an existing lease.
   Preserve the journals, external checkpoint and original failure evidence.
2. Match the exact lease name and expected owner, original source revision and
   complete fixture source hashes, and the directly owned attempt directory.
   A missing/mismatching binding blocks reconciliation. A live recorded owner,
   including a reused owner PID, must block it.
3. Match the captured native supervisor and descendant generations against OS
   creation ticks and the previously captured ancestry. Unknown ownership,
   inaccessible process information or PID reuse is **not permission to kill**.
   The fixture tests live-owner and mismatched-generation refusal before
   destructive actions. If the supervisor has already exited, its negative
   checkpoint instead deliberately references the live auditor PID with an
   impossible creation time. The diagnostic labels this synthetic guard probe
   separately; it is not a real reused-PID event or orphan-drain observation.
4. Fsync a drain intent. Hold an OS handle for the matched supervisor while
   checking creation time and using `Stop-Process -Id <exact PID> -Force`.
   Holding the handle prevents PID recycling during check/termination. Confirm
   all captured processes are absent within the declared drain budget; an
   unconfirmed drain leaves both lease and private state intact.
5. A fresh-process restart must still refuse the stale lease. Recheck original
   source hashes/status, lease owner, directory bounds and process absence.
   Fsync a discard intent; remove **only** that attempt's disposable `data`
   subtree. Preserve its parent journal, external checkpoint and audit trail.
   Fsync the discard record. Do not edit receipts or reset the original source.
6. Only now explicitly call `Ledger.recoverLock(name, expectedOwner)`, then record
   the release. This API alone checks only the recorded owner PID and is **not**
   sufficient proof of job drain, source preservation or state reconciliation.
   It conservatively refuses a live/reused owner PID. Do not bypass that refusal
   with SQL deletion, lock age, or a different owner token.
7. Confirm no receipts remain in the discarded attempt, the original source
   remains byte-identical, and no new attempt has been launched. Release is not
   permission to silently resume preparation; a later preparation requires its
   own explicit authorization and budgets.

If a real crash lacks a trustworthy external identity checkpoint, the existing
runner's PID-only journal is insufficient to reconstruct generation-bound kill
authority. **Remain blocked.** Do not extrapolate the fixture's successful
reconciliation to an arbitrary orphaned job. Namespace exclusion is scoped to
the configured attempt parent, not a machine-wide preparation mutex.

The TAP diagnostic contains the source/profile bindings, observed post-kill
processes, fsynced audit records and audit hash before temporary-fixture cleanup.
Failed cases report available checkpoint/audit evidence; unreconciled state is
retained rather than recursively removed. Tests do not read process command
lines, environment variables or credentials. Process termination on a running
Windows system is not proof of directory-fsync, SQLite or receipt durability
across power loss. The old 99-minute failure remains unattributed and real native
reuse remains unproved.

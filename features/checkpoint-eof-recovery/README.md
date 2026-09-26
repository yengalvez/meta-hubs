# Checkpoint transport loss: abort-only service recovery

Candidate dated 2026-09-26. Baselines: Hubs prod-2026-03-11 and Hubs CE 2.1.0. This changes operator-side backup/recovery tooling, not avatar bytes, application schemas or the accepted checkpoint format. Local tests are not a live recovery acceptance.

## Contract

A durable-v2 checkpoint with legacy artifact format persists a private sibling directory `<OUTPUT>.abort-recovery` before stopping any writer. Its receipt records the exact cluster/Namespace/PVC, original operation and Lease, lock identity, writer identities/specifications/replica counts and hashes of private input copies. Directory permissions are 0700; private files are 0600. Retain it outside shared logs, Git, public artifacts and the accepted DB+media backup.

Transport loss invalidates the interrupted checkpoint. Never delete the old failure marker or resume the old stream to pretend continuity. A separate operation may recover service only after checking the receipt, canonical manifest/control-plane/RBAC, expected identities, no conflicting storage consumer, and a new serialization Lease. It cannot restore data, publish/import avatars, accept that checkpoint or initiate another backup.

Supported initial state: the exact five writers are fully paused and the recovery fence is active. A parent originally at zero remains at zero; recovery never enables an optional module. Partial initial pause, legacy runtime, freeze format, unsupported identities and persistent API outage remain fail-closed. They are not covered by this runbook.

## Operator sequence

Only use a frozen, reviewed source matching the pre-backup manifest and generator. Before a rollout from the older product contract, use the baseline-compatible backup source: the new product generator cannot reproduce the old deployment. Never weaken manifest verification to bridge that mismatch.

1. Reconcile the original process/log and confirm it cannot continue writing. Do not start a duplicate backup.
2. Retain the invalid copy and private sibling receipt. Restore connectivity; do not modify cluster data or permissions as a diagnostic.
3. From the reviewed backup-source root, prepare an abort-only plan:
   ```bash
   R="<absolute-output-path>.abort-recovery"
   node hubs-cloud/community-edition/apply/recover-avatar-checkpoint.js plan "$R/receipt.json" "$R/plan.json"
   ```
4. Review the exact destination and plan hash without displaying private receipt/input bodies. Execute that same plan:
   ```bash
   node hubs-cloud/community-edition/apply/recover-avatar-checkpoint.js execute "$R/receipt.json" "$R/plan.json" "<packetSha256>"
   ```
5. If transport fails again, reconcile state by repeating the exact same execute/plan/hash. Preserve `plan.json.journal.json`; never invent another journal or repeat ambiguous mutations manually.
6. A `service_restored_lease_release_unconfirmed` result is failure pending readback, not success. A persistent API failure retains the lock/fence and must be reported.
7. After terminal success, run the documented live verifier and cold-browser acceptance. The interrupted backup remains invalid. A new checkpoint is a separate supervised operation.

The tool uses canonical helper/Lease/fence validators and UID/resourceVersion preconditions. Reentry must authorize only writer Pods whose lineage and template match the receipt and whose restoration is proven by this journal. A foreign ret-pvc consumer must block continuation.

## Verification and rollback

Before the local kubectl child is allowed through its private gate, a purely
temporal guard misalignment may be realigned under the original startup
deadline. Affected monitors must publish a new causal counter increment and
pass another complete audit. This does not extend the ten-second freshness
budget, cancellation reserve or startup deadline. Identity/hash/read failures,
failure markers, counter regression and Lease failure remain fatal. Once the
gate opens, and during post-stream acceptance, stale guards still fail closed;
this is not a retry of a destructive operation or an interrupted backup.

Safe stream diagnostics include only guard index/counter and monotonic
age/observation numbers. The historic F `guard-stale:0` did not include enough
evidence to distinguish real stalled progress from serial observation cost.
The deterministic regression demonstrates the latter mechanism, not the
confirmed cause of that historic failure. Focused tests are wired into both
the local security section and the existing CI workflow.

Focused regressions cover capture-before-pause, source permissions/durability, EOF on reads/watch/CAS, expired or competing Leases, lost mutation responses, helper cleanup, interrupted recovery/reentry, foreign PVC consumers and original zero replicas. Run the real checkpoint shell entrypoint with the isolated recovery fixtures from a clean committed tree as well; unit adapters alone do not cover this hook.

Relevant files: `deployment/create-checkpoint.sh`, `checkpoint-recovery-receipt.mjs`, `lib/recovery-safety.sh`, writer/quiescence watchers and Cloud `apply/recover-avatar-checkpoint.js`. No manual RBAC patch, generated-manifest edit, raw apply, image hotpatch or secret output is allowed. Reverting tooling before an operation is safe; during an incident keep the source/receipt/journal pinned until its state is reconciled. This runbook does not authorize discarding an uncertain receipt.

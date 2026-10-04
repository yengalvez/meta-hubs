# Checkpoint transport loss: abort-only service recovery

Candidate dated 2026-09-26. Baselines: Hubs prod-2026-03-11 and Hubs CE 2.1.0. This changes operator-side backup/recovery tooling, not avatar bytes, application schemas or the accepted checkpoint format. Local tests are not a live recovery acceptance.

The recovery/H5 receipt footprint includes the consumed external admission-fence
test, rather than unrelated `tests/scripts` units. New harness dependencies must
extend that footprint and its regression; static/security retain whole-tree
coverage. No input, toolchain, cleanup or final-full acceptance guard is waived.

## Versioned signed closure candidate (2026-10-03)

Monitor envelopes remain schema1. Signed backup envelopes require the exact
selected keyring path/UUID pair; unsigned envelopes must not accept that field.
The Bash parent and Node durable watcher must hash the same capability including
that selection. No key is created or read by the metadata comparator. Private
file/hash/READY/process identity checks and cryptographic resource verification
remain independent and mandatory. Focused shell/cross-language regressions do
not replace watcher startup, representative Kubernetes recovery or exact full.

The existing durable-monitor fixture now exercises both complete Bash starters
and real Node watchers together: signed READY/progress/final/join, rejection of
a changed key selection, and an external timeout with retained wrapper pipes.
The owner renews the synthetic Lease; GET/LIST/WATCH only consume its causal
history. Three native cases and thirteen affected unsigned/default cases pass.
The timeout must retain native143, discard both monitors without positive final
evidence, and close all owned processes by identity. This lane uses the real
attested 30-second fixture join override, not the production 300-second join.
It proves local startup/teardown compatibility, not historical PGSQL causation,
representative Kubernetes recovery, operational SLOs or the exact final full.

The local candidate adds explicit authority2/consumer3/baseline4/receipt2 and
metadata4/inventory5/freeze2 readers, rather than reinterpreting historical
versions. Positive writers bind full spec and UID/RV/generation before the first
pause and through resume/receipt removal; a writer originally at zero receives
no PATCH, resume receipt or invented generation. Signed public projections are
separate from private specs/key material; key selection is explicit and never
creates or imports a key. Existing monitor/Lease/fence/consumer guards and
30/10-second limits with the two-second cancellation reserve remain mandatory.

Restore retains its own destination consumer1 and checkpoint-restore lock. It
clears inherited backup key selectors only in its own process before loading
the shared library; the parent environment and backup guards are unchanged.
Destination original replicas come from a verified immutable ACTIVE-input
snapshot, not a paused live scale or the source's authority. Generator/YAML
failures use fixed diagnostics; input identity/content drift fails closed.

New root regressions are registered once in the shared AUD-065 aggregate and
its security inventory. Local focal results and directed reviews are not a
frozen full, runtime restoration, three complete cycles or production acceptance.
The combined historical/new SDK gate reached154/155; its single incorrect
status-RV expectation was corrected and the affected two-case boundary passed.
The candidate now implements explicit positional plan-authority/execute-authority
CLI entrypoints with existing keyring/ID selection and receipt2, without API
adapters, environment fallback or key creation. Static review is closed; the
initial plan SyntaxError was reproduced as truncated synthetic transport and
corrected only in the fixture. The former complete CLI gate was10/11 with one
native90s timeout during progressing second execution/reentry. Closed-field
measurement identified repeated private-reader process startup, not a proven
historical multimedia cause. The clean publication reader now uses one dirfd
helper instead of five, retaining four byte-read passes, inode/ancestor custody,
fresh key loads and the historical reconciliation path for pending/link states.
The unchanged1MiB request limit is checked before startup; oversized headers
select the historical reader. Directed review closed both compatibility findings.
Publication17/17 and key custody9/9 pass on these bytes. The previously failing
fresh-process reentry case now passes in112686.617ms total: recovery itself
77189.553ms, below the unchanged90s per-CLI limit, followed by mutation-free
terminal replay. All observed processes have terminal metrics and no metric
errors; fixture transport remains synthetic. This is not a new complete CLI
suite, frozen full, operational latency acceptance or representative runtime cycle.
Historical manual execution stays disabled; neither these APIs nor an ad-hoc
invocation constitute an accepted operational reentry recipe.

## Local interpreter and scheduling harness (2026-10-02)

Recovery requires Bash4.1+. Refuse unsupported interpreters before resetting
capabilities or parsing the coprocess worker. Native local helpers bind their
validated executable before sanitizing PostgreSQL's environment; they must not
continue after a failed `source`. No production Bash override is introduced.
The deterministic scheduling harness invokes the real ordered full-audit
dispatcher but explicitly models worker-boundary timing and counter observations.
It does not attest native IPC, guardian ownership or reaping. Those retain the
native recovery matrix and exact full-gate requirements, without altered
30/10-second bounds or two-second cancellation reserve.

## Isolated full-cycle inputs (2026-10-01)

The existing staging preparer now offers only the two explicit recovery input
transitions `active -> restore-fence -> active`. The first chooses a new
canonical epoch; the second preserves it. It requires a private source with
installed/activated bots and the digest-pinned official runner family, changes
only phase/epoch bytes and uses the existing private no-clobber publisher.
No provider key is required for bots-only. File preparation grants no restore,
checkpoint, UID, journal, attestation or apply authority; those existing gates
remain mandatory. Legacy/BASE sources cannot be reclassified as durable here.

Five new normal regressions cover preservation/refusals/private publication,
bots-only without AI credentials and the actual offline Cloud generator plus
unchanged verifier in both phases. These are synthetic inputs, not cluster
restores or official images. The separate three-cycle entry recipe is
[recorded with limits](../../DOC/fiabilidad-tres-ciclos-2026-10-01.md); current
order remains exclusively in the canonical active plan.

## Contract

A durable-v2 checkpoint with legacy artifact format persists a private sibling directory `<OUTPUT>.abort-recovery` before stopping any writer. Its receipt records the exact cluster/Namespace/PVC, original operation and Lease, lock identity, writer identities/specifications/replica counts and hashes of private input copies. Directory permissions are 0700; private files are 0600. Retain it outside shared logs, Git, public artifacts and the accepted DB+media backup.

Transport loss invalidates the interrupted checkpoint. Never delete the old failure marker or resume the old stream to pretend continuity. A separate operation may recover service only after checking the receipt, canonical manifest/control-plane/RBAC, expected identities, no conflicting storage consumer, and a new serialization Lease. It cannot restore data, publish/import avatars, accept that checkpoint or initiate another backup.

Supported initial state: the exact five writers are fully paused and the recovery fence is active. A parent originally at zero remains at zero; recovery never enables an optional module. Partial initial pause, legacy runtime, freeze format, unsupported identities and persistent API outage remain fail-closed. They are not covered by this runbook.

## Historical receipt1 operator sequence (frozen implementation only)

The sequence below documents the older frozen implementation used for the
historical abort-only incident. It is NOT an executable recipe for the new
versioned candidate above: its new authority CLI is not yet functionally
accepted, and receipt2 uses the authority-aware coordinator. Retain the source pinned by the incident; do not replace
it with another candidate, infer execute authority or reuse the interrupted copy.

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

Representative copy/restore/deploy/rollback acceptance requires actual official
runtime images, not the historical PAUSE service aliases. Cloud's manual
`runtime-images-build-push.yml` produces the existing consumer's coordinated
Reticulum/parent/runner receipt and four separate Sigstore bundles from one
clean `master` SHA/run/attempt. Its source guard and cross-repository contract
tests are registered in Cloud CI and root AUD-065 gates. The receipt is public
metadata, not a checkpoint or restore authority; local unsigned fixtures prove
only shape/wiring. A real successful hosted run, integrated-root provenance
verification and isolated full cycles remain mandatory. No guard, checkpoint
format, recovery deadline or runtime is changed by this producer.

Before the local kubectl child is allowed through its private gate, a purely
temporal guard misalignment may be realigned under the original startup
deadline. Affected monitors must publish a new causal counter increment and
pass another complete audit. This does not extend the ten-second freshness
budget, cancellation reserve or startup deadline. Identity/hash/read failures,
failure markers, counter regression and Lease failure remain fatal. Once the
gate opens, and during post-stream acceptance, stale guards still fail closed;
this is not a retry of a destructive operation or an interrupted backup.

While that private gate remains closed, observe every validated progress marker
between the serial full audits. These intermediate reads grant no authority:
only a genuine counter increment advances its causal lower bound, dated to the
previous observation, and each guard still needs a complete signed audit before
its increment can satisfy the launch round. A failed read or counter regression
is fatal. The final continuity/identity/Lease checks and two-second cancellation
reserve remain mandatory. Do not use these observations during a running stream
or increase the thirty-second startup/ten-second freshness limits.

After the exact stream child has been waited/reaped and its PID/start-identity
capability retired, post-audit may also observe all counters between expensive
full audits. This is bookkeeping, not temporal realignment: all inherited guard
deadlines must remain unexpired before crediting any increment and after costly
operations. Expiry is latched irreversibly, including a publisher that stops for
ten seconds and then resumes. Unchanged counters keep their old causal bounds.
Each full audit remains mandatory, followed by a joint continuity/freshness
check; a running or unreaped child cannot opt into this post-stream path.

### Post-stream observation during full audits (2026-10-02)

The native shell fixture reproduced a healthy slow publisher being rejected
because a blocking full audit prevented timely counter observations. A source
round below ten seconds can still exhaust its conservative causal lower bound
when the receiver serially audits other guards. This demonstrates a local
observer defect; it does not establish the unrecorded cause of a live failure.

ONLY after the stream's real wait/reap retires its destructive capability, one
gated, owned process group executes all the unchanged complete predicates in
their original order for each sweep. The foreground continues capability-bound
counter observations, preserving previous-observation lower bounds and the
irreversible expiry latch. Native exit zero AND the private guardian handshake
are required, including a READY buffered after a cheap audit has already exited.
Post-reap baselines are captured before any complete audit, so a valid increment
during it is not discarded in favor of another round within the same deadline.

The guardian shares only its own verified process group and the owner's private
control pipe. EOF/owner death or the original absolute deadline revokes that
group, including descendants. Normal retirement checks PID/start identity;
parent cleanup requires its running-child proof or the waited/reaped group.
There is no new service, coordinator generation, configuration input or retry
authority. Pre-launch/running paths, all complete PGSQL/writer/durable guards,
Lease/fence/UID/hash checks, thirty/ten-second limits and two-second cancellation
reserve remain unchanged. Interrupted copies remain invalid.

The final affected native matrix passed 57/57 with real exit zero and unchanged
source hashes. It includes an 8.5-second healthy publisher plus at least twelve
complete slow audits, cheap audits under the original startup window, native
audit exit 7, blocked audit deadlines, expired progress and SIGKILL of the
observer. Failure cases assert that audit groups/descendants are gone. This is
local regression evidence, NOT recovery-section/full or isolated/live acceptance.
The exact frozen candidate must still renew only invalid receipts and pass full.
Revert the tooling only before an operation; an active incident retains its
pinned source, receipt and journal until reconciliation.

Ordinary backup failures emit a bounded, allowlisted stage/status/reason on
stderr without enabling a diagnostic flag. Archive stdout is unchanged. A
failed command retains its original exit status and first cause, while the
storage pipeline records supervisor and compressor statuses separately.
Never print command arguments, private paths or Kubernetes/marker payloads.

The 2026-09-27 regression reproduces healthy one-second counters timing out when
three serial audits cost two seconds each. Intermediate sampling resolves this
modeled defect and asymmetric monitor periods without accepting stopped counters.
It does not establish the cause of the live `guard-refresh-timeout:0` incident:
its reported index identifies the limiting freshness budget, not necessarily a
monitor missing an increment. The deterministic harness does not measure the
runtime cost of marker reads; retain the focused shell entrypoint verification.
The 2026-09-30 post-stream regression additionally reproduces a false rejection
with healthy publishers during serial audits and a missed final joint deadline.
Real local publishers with twelve delayed full audits cover the positive path;
deterministic negatives cover expiry and late resumption. These are demonstrated
tooling defects, not proof of the unrecorded cause of real checkpoint22960.

The complete shell checkpoint fixture subsequently measured the local PGSQL
source guard at seven to eight seconds per round, dominated by backup-guard
validation. Its guard index is zero in DB streams; writer/durable are one/two
and their observed progress remained healthy. The PGSQL round now removes only
adjacent duplicate cluster/Lease/lock validators and the duplicate durable
quiescence inventory; their complete equivalents remain inside its backup guard.
The serialization Lease is explicitly mandatory. Legacy retains direct runner
quiescence, and all five consumers, both parent capabilities, active fence and
exact PGSQL Pod/Deployment/ReplicaSet ownership remain validated before progress.
Regressions execute the actual Bash orchestration, check each retained family,
reject a missing Lease requirement and suppress publication after every failed
family. End-to-end fixture and exact full-gate acceptance remain separate.
Nested lock/durable/quiescence/fence failures preserve their first closed
component in the private PGSQL marker. Actual-composite regressions cover
authorization loss only at an inner boundary; metadata and payload negatives
cover marker-to-reporter redaction without replacing a prior stale cause.

Safe stream diagnostics include only guard index/counter and monotonic
age/observation numbers. The historic F `guard-stale:0` did not include enough
evidence to distinguish real stalled progress from serial observation cost.
The deterministic regression demonstrates the latter mechanism, not the
confirmed cause of that historic failure. Focused tests are wired into both
the local security section and the existing CI workflow.

Focused regressions cover capture-before-pause, source permissions/durability, EOF on reads/watch/CAS, expired or competing Leases, lost mutation responses, helper cleanup, interrupted recovery/reentry, foreign PVC consumers and original zero replicas. Run the real checkpoint shell entrypoint with the isolated recovery fixtures from a clean committed tree as well; unit adapters alone do not cover this hook.

For a Lease-only change, the existing shell harness also accepts
`YENHUBS_RECOVERY_TEST_FOCUS=serialization-lease-contract`. It runs the same
original Lease block plus unchanged shared setup, and preserves that block's
call in the full path. J92419 passed55 checks (45 shared and10 Lease) in18.94s;
this is a measured local test, not a complete recovery or operational SLO.
The mandatory final `verify-project.sh --full` is not replaced by focused runs.

Relevant files: `deployment/create-checkpoint.sh`, `checkpoint-recovery-receipt.mjs`, `lib/recovery-safety.sh`, writer/quiescence watchers and Cloud `apply/recover-avatar-checkpoint.js`. No manual RBAC patch, generated-manifest edit, raw apply, image hotpatch or secret output is allowed. Reverting tooling before an operation is safe; during an incident keep the source/receipt/journal pinned until its state is reconciled. This runbook does not authorize discarding an uncertain receipt.

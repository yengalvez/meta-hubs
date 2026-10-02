import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const source = readFileSync(new URL("../../deployment/backup-ret-storage-quiesced.sh", import.meta.url), "utf8");
const library = readFileSync(new URL("../../deployment/lib/recovery-safety.sh", import.meta.url), "utf8");
function extract(name, text = source) {
  const start = text.indexOf(`\n${name}() {\n`);
  assert.notEqual(start, -1, name);
  const end = text.indexOf("\n}\n", start);
  assert.notEqual(end, -1, name);
  return text.slice(start + 1, end + 3);
}
// Execute the actual storage sweep and its complete durable validator. Only
// external validators are fixtures. The sleep fixture terminates one round;
// these are orchestration regressions, never a benchmark or transport proof.
const functions = ["require_parent_freeze_fence_capability", "require_parent_durable_monitor_capability",
  "require_parent_checkpoint_guards", "monitor", "require_freeze_storage_stream_boundary"]
  .map(name => extract(name)).join("\n") + "\n" +
  ["recovery_require_operation_lock", "recovery_require_checkpoint_runner_quiescence_exact",
    "recovery_require_recovery_operation_fence_state", "recovery_require_durable_runner_quiescence_monitor_healthy"]
    .map(name => extract(name, library)).join("\n");
const harness = String.raw`
set -u
umask 077
fixture="$1" fault="$2" CHECKPOINT_RUNNER_GENERATION="$3" lane="$4"
: >"$fixture/calls"
RECOVERY_OPERATION_OWNER=checkpoint-backup
RECOVERY_CONSUMER_CONTRACT_JSON='owned-fixture-contract'
hash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
CHECKPOINT_DURABLE_FENCE_BASELINE_PATH="$fixture/baseline"
CHECKPOINT_DURABLE_FENCE_BASELINE_SHA256="$hash"
printf '[]' >"$fixture/baseline"
if [[ "$CHECKPOINT_RUNNER_GENERATION" == legacy-absent ]]; then
  CHECKPOINT_DURABLE_FENCE_BASELINE_PATH= CHECKPOINT_DURABLE_FENCE_BASELINE_SHA256=
fi
PARENT_FREEZE_FENCE_CAPABILITY=
RECOVERY_OPERATION_LOCK_NAME=fixture-lock NAMESPACE=fixture HELPER_POD=fixture-helper
PARENT_WRITER_MONITOR_BASELINE_PATH=/fixture/control PARENT_WRITER_MONITOR_BASELINE_SHA256="$hash"
PARENT_WRITER_MONITOR_PID=123 PARENT_WRITER_MONITOR_CONTRACT_PATH=/fixture/contract
PARENT_DURABLE_MONITOR_CONTROL_BASELINE_PATH=/fixture/control PARENT_DURABLE_MONITOR_CONTROL_BASELINE_SHA256="$hash"
PARENT_DURABLE_MONITOR_PID=124 PARENT_DURABLE_MONITOR_START_IDENTITY=fixture-identity
PARENT_RECOVERY_OPERATION_FENCE_ACTIVE_IDENTITY=fixture-fence
PARENT_DURABLE_MONITOR_AUTHORITY_SHA256="$hash" PARENT_DURABLE_MONITOR_CAPABILITY_SHA256="$hash"
PARENT_DURABLE_MONITOR_READY_PATH="$fixture/ready" PARENT_DURABLE_MONITOR_FAILURE_PATH="$fixture/durable-failure"
PARENT_DURABLE_MONITOR_PROGRESS_PATH="$fixture/durable-progress"
printf 'ready:fixture-marker\n' >"$fixture/ready"
: >"$fixture/durable-failure"
printf '{"paths":{"stop":"fixture-stop","final":"fixture-final"}}\n' >"$fixture/authority"
MONITOR_STOP="$fixture/stop" MONITOR_FAILURE="$fixture/failure"
MONITOR_PROGRESS="$fixture/progress" MONITOR_POLL_SECONDS=1
if [[ "$lane" == freeze ]]; then
  PARENT_FREEZE_FENCE_CAPABILITY=fixture-freeze
  PARENT_WRITER_MONITOR_PID= PARENT_WRITER_MONITOR_CONTRACT_PATH= PARENT_WRITER_MONITOR_BASELINE_PATH=
fi
[[ "$fault" != control-baseline ]] || PARENT_DURABLE_MONITOR_CONTROL_BASELINE_SHA256=badhash
[[ "$fault" != same-parent-pid ]] || PARENT_DURABLE_MONITOR_PID="$PARENT_WRITER_MONITOR_PID"
record(){ printf '%s\n' "$1" >>"$fixture/calls"; }
check(){ record "$1"; [[ "$fault" != "$1" ]]; }
inner_fence_fault(){
  [[ "${'${RECOVERY_FENCE_STATE_FAILURE_DETAIL:-}'}" == "$1" ]] || return 1
  case "$fault" in
    "inner-fence-$2-pre") [[ "$(<"$fixture/calls")" != *active-fence* ]] ;;
    "inner-fence-$2-post") [[ "$(<"$fixture/calls")" == *active-fence* ]] ;;
    *) return 1 ;;
  esac
}
recovery_require_cluster_identity(){
  check cluster || return 1
  [[ "$fault" != inner-quiescence-lock || "${'${RECOVERY_RUNNER_QUIESCENCE_FAILURE_DETAIL:-}'}" != operation-lock ]] || return 1
  ! inner_fence_fault operation-lock lock
}
recovery_require_operation_serialization(){
  check serialization || return 1
  [[ "$fault" != inner-quiescence-serialization || "${'${RECOVERY_RUNNER_QUIESCENCE_FAILURE_DETAIL:-}'}" != serialization ]] || return 1
  ! inner_fence_fault serialization serialization
}
recovery_require_pvc_identity(){ [[ "$1" == ret-pvc ]] && check pvc; }
recovery_kubectl(){ record operation-lock; printf 'fixture-lock-json\n'; }
recovery_operation_lock_json_is_exact(){ [[ "$1" == fixture-lock-json ]] && check lock-identity; }
recovery_require_consumer_contract_entry(){
  [[ "$1" == owned-fixture-contract && "$3" == 0 ]] || return 1
  check "consumer-$2"
}
require_parent_writer_monitor_capability(){ check writer; }
recovery_require_freeze_checkpoint_fence(){ [[ "$1" == fixture-freeze ]] && check freeze; }
recovery_private_values_file_is_acceptable(){ [[ "$1" == "$fixture/baseline" ]]; }
recovery_file_size_bytes(){ printf '2\n'; }
recovery_sha256_digest(){ printf '%s\n' "$hash"; }
recovery_durable_fence_inventory_json_is_canonical(){ [[ "$1" == '[]' ]]; }
recovery_capture_durable_quiescence_into(){ check quiescence || return 1; printf -v "$1" '%s' '[]'; }
recovery_require_no_managed_bot_runner_pods(){ check quiescence; }
recovery_require_no_legacy_parent_runner_pods(){ check legacy-parent-absence; }
recovery_monitor_authority_sha256_for_ready(){ printf '%s\n' "$hash"; }
recovery_runner_watch_marker_is_exact(){ return 0; }
recovery_monitor_authority_path(){ printf '%s\n' "$fixture/authority"; }
recovery_durable_runner_monitor_control_capability_sha256(){ printf '%s\n' "$hash"; }
recovery_durable_runner_monitor_authority_is_exact(){ check durable-authority; }
recovery_durable_runner_monitor_positive_marker(){ printf 'fixture-marker\n'; }
recovery_stream_guard_progress_value(){ check durable-progress; }
recovery_process_identity_is_live(){ check durable-process; }
recovery_checkpoint_writer_monitor_file_is_exact(){ check durable-baseline; }
recovery_read_recovery_operation_fence_state(){ [[ "$1" == active && "$2" == fixture-fence ]] && check active-fence; }
require_helper_policy(){ check helper-policy; }
require_helper_pod(){ check helper-pod; }
recovery_require_exact_pvc_consumers(){ [[ "$1" == ret-pvc && "$2" == fixture-helper ]] && check pvc-consumers; }
recovery_write_stream_guard_progress(){
  [[ "$1" == "$fixture/progress" && "$2" == 1 ]] || return 1
  check publish
}
sleep(){ : >"$fixture/stop"; }
status=0
if [[ "$lane" == freeze ]]; then
  require_freeze_storage_stream_boundary || status=$?
else
  monitor || status=$?
fi
printf 'status=%s\n' "$status"
`;

function run(fault = "none", generation = "durable-v2", lane = "normal") {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "yenhubs-storage-sweep-"));
  chmodSync(fixture, 0o700);
  // Retain this small private deterministic fixture for diagnosis; no deletion
  // of paths owned by another run and no access to API/DB/provider credentials.
  const result = spawnSync("/bin/bash", ["-c", `${functions}\n${harness}`, "fixture", fixture, fault, generation, lane], {
    encoding: "utf8", timeout: 5000,
    env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin", HOME: fixture, LANG: "C", LC_ALL: "C" }
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const text = readFileSync(path.join(fixture, "calls"), "utf8").trim();
  const calls = text ? text.split("\n") : [];
  let failure = "";
  try { failure = readFileSync(path.join(fixture, "failure"), "utf8").trim(); } catch {}
  return { status: Number(result.stdout.match(/^status=(\d+)$/m)?.[1]), calls, failure,
    count: family => calls.filter(value => value === family).length };
}

test("durable storage sweep audits exact runner inventory once through the full parent validator", () => {
  const r = run();
  assert.equal(r.status, 0, JSON.stringify(r));
  assert.equal(r.count("quiescence"), 1, JSON.stringify(r.calls));
  assert.equal(r.count("operation-lock"), 5, "outer guard, full durable validator, quiescence and both active-fence boundaries remain");
  for (const family of ["cluster", "serialization", "pvc", "lock-identity", "writer", "legacy-parent-absence",
    "durable-authority", "durable-process", "durable-progress", "durable-baseline", "active-fence", "helper-policy", "helper-pod", "pvc-consumers"])
    assert.ok(r.count(family) > 0, family);
  assert.equal(r.count("publish"), 1);
  assert.equal(r.calls.at(-1), "publish", "progress follows the entire round, not an independent heartbeat");
});

test("legacy storage sweep preserves both existing runner and legacy-parent absence audits", () => {
  const r = run("none", "legacy-absent");
  assert.equal(r.status, 0);
  assert.equal(r.count("quiescence"), 2);
  assert.equal(r.count("legacy-parent-absence"), 2);
  assert.equal(r.count("durable-authority"), 0);
  assert.equal(r.count("writer"), 1);
  assert.equal(r.count("publish"), 1);
});

test("storage rejects an unknown runner generation before publishing progress", () => {
  const r = run("none", "unknown-generation");
  assert.equal(r.status, 1);
  assert.equal(r.count("publish"), 0);
  assert.equal(r.failure, "parent_checkpoint_guard_failed");
});

test("freeze storage boundary retains all five zero-writer checks and exact runner absence", () => {
  const r = run("none", "legacy-absent", "freeze");
  assert.equal(r.status, 0);
  assert.equal(r.count("quiescence"), 1);
  assert.equal(r.count("freeze"), 1);
  assert.equal(r.count("writer"), 0);
  assert.equal(r.count("publish"), 0, "the real freeze boundary is not the legacy monitor");
  for (const writer of ["reticulum", "pgbouncer", "pgbouncer-t", "bot-orchestrator", "coturn"])
    assert.equal(r.count(`consumer-${writer}`), 1, writer);
});

for (const fault of ["cluster", "serialization", "pvc", "lock-identity", "writer", "quiescence", "legacy-parent-absence",
  "durable-authority", "durable-process", "durable-progress", "durable-baseline", "active-fence", "control-baseline", "same-parent-pid",
  "helper-policy", "helper-pod", "pvc-consumers", "inner-quiescence-serialization", "inner-quiescence-lock",
  "inner-fence-serialization-pre", "inner-fence-serialization-post", "inner-fence-lock-pre", "inner-fence-lock-post"]) {
  test(`storage never publishes progress when ${fault} fails`, () => {
    const r = run(fault);
    assert.equal(r.status, 1, JSON.stringify(r));
    assert.equal(r.count("publish"), 0, JSON.stringify(r));
    const component = ({ "helper-policy": "helper_policy_failed", "helper-pod": "helper_pod_failed", "pvc-consumers": "pvc_consumers_failed" })[fault];
    assert.equal(r.failure, component ?? "parent_checkpoint_guard_failed");
  });
}

for (const fault of ["freeze", ...["reticulum", "pgbouncer", "pgbouncer-t", "bot-orchestrator", "coturn"].map(name => `consumer-${name}`)]) {
  test(`freeze storage boundary rejects ${fault} failure`, () => {
    const r = run(fault, "legacy-absent", "freeze");
    assert.equal(r.status, 1, JSON.stringify(r));
    assert.equal(r.count("publish"), 0);
    assert.equal(r.failure, "", "the boundary returns failure directly, without a monitor marker");
  });
}

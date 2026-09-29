import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const source = readFileSync(new URL("../../deployment/backup-retdb.sh", import.meta.url), "utf8");
const library = readFileSync(new URL("../../deployment/lib/recovery-safety.sh", import.meta.url), "utf8");
function extract(name, text = source) {
  const start = text.indexOf(`\n${name}() {\n`);
  assert.notEqual(start, -1, name);
  const end = text.indexOf("\n}\n", start);
  assert.notEqual(end, -1, name);
  return text.slice(start + 1, end + 3);
}
// Run the real PGSQL monitor and complete backup-guard orchestration. Only
// their external validators are fixtures. Each call records its family and
// a deterministic cost; neither real kubectl nor a database is involved.
const functions = ["require_parent_durable_monitor_capability", "require_backup_guard", "record_pgsql_source_monitor_failure", "monitor_exact_pgsql_source"]
  .map(name => extract(name)).join("\n") + "\n" +
  ["recovery_pgsql_source_monitor_failure_code_is_exact", "recovery_require_operation_lock",
    "recovery_require_checkpoint_runner_quiescence_exact", "recovery_require_recovery_operation_fence_state",
    "recovery_require_durable_runner_quiescence_monitor_healthy"].map(name => extract(name, library)).join("\n");
const harness = String.raw`
set -u
fixture="$1" fault="$2" CHECKPOINT_RUNNER_GENERATION="$3"
: >"$fixture/calls"
COORDINATED=1 RECOVERY_OPERATION_OWNER=checkpoint-backup
RECOVERY_SERIALIZATION_LEASE_REQUIRED=1
[[ "$fault" != lease-not-required ]] || RECOVERY_SERIALIZATION_LEASE_REQUIRED=0
RECOVERY_CONSUMER_CONTRACT_JSON='owned-fixture-contract'
hash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
CHECKPOINT_DURABLE_FENCE_BASELINE_PATH="$fixture/baseline"
CHECKPOINT_DURABLE_FENCE_BASELINE_SHA256="$hash"
printf '[]' >"$fixture/baseline"
if [[ "$CHECKPOINT_RUNNER_GENERATION" == legacy-absent ]]; then
  CHECKPOINT_DURABLE_FENCE_BASELINE_PATH= CHECKPOINT_DURABLE_FENCE_BASELINE_SHA256=
fi
PARENT_FREEZE_FENCE_CAPABILITY=
RECOVERY_OPERATION_LOCK_NAME=fixture-lock NAMESPACE=fixture
PARENT_WRITER_MONITOR_BASELINE_PATH=/fixture/control PARENT_WRITER_MONITOR_BASELINE_SHA256="$hash"
PARENT_DURABLE_MONITOR_CONTROL_BASELINE_PATH=/fixture/control PARENT_DURABLE_MONITOR_CONTROL_BASELINE_SHA256="$hash"
PARENT_WRITER_MONITOR_PID=123 PARENT_DURABLE_MONITOR_PID=124 PARENT_DURABLE_MONITOR_START_IDENTITY=fixture-identity
PARENT_RECOVERY_OPERATION_FENCE_ACTIVE_IDENTITY=fixture-fence
PARENT_DURABLE_MONITOR_AUTHORITY_SHA256="$hash" PARENT_DURABLE_MONITOR_CAPABILITY_SHA256="$hash"
PARENT_DURABLE_MONITOR_READY_PATH="$fixture/ready" PARENT_DURABLE_MONITOR_FAILURE_PATH="$fixture/durable-failure"
PARENT_DURABLE_MONITOR_PROGRESS_PATH="$fixture/durable-progress"
printf 'ready:fixture-marker\n' >"$fixture/ready"
: >"$fixture/durable-failure"
printf '{"paths":{"stop":"fixture-stop","final":"fixture-final"}}\n' >"$fixture/authority"
DB_SOURCE_MONITOR_STOP="$fixture/stop" DB_SOURCE_MONITOR_FAILURE="$fixture/failure"
DB_SOURCE_MONITOR_PROGRESS="$fixture/progress" DB_SOURCE_MONITOR_POLL_SECONDS=1
record(){ printf '%s %s\n' "$1" "$2" >>"$fixture/calls"; }
check(){ record "$1" "$2"; [[ "$fault" != "$1" ]]; }
inner_fence_fault(){
  [[ "${'${RECOVERY_FENCE_STATE_FAILURE_DETAIL:-}'}" == "$1" ]] || return 1
  case "$fault" in
    "inner-fence-$2-pre") [[ "$(<"$fixture/calls")" != *active-fence* ]] ;;
    "inner-fence-$2-post") [[ "$(<"$fixture/calls")" == *active-fence* ]] ;;
    *) return 1 ;;
  esac
}
recovery_require_cluster_identity(){
  check cluster 300 || return 1
  [[ "$fault" != inner-quiescence-lock || "${'${RECOVERY_RUNNER_QUIESCENCE_FAILURE_DETAIL:-}'}" != operation-lock ]] || return 1
  ! inner_fence_fault operation-lock lock
}
recovery_require_operation_serialization(){
  check serialization 300 || return 1
  [[ "$fault" != inner-quiescence-serialization || "${'${RECOVERY_RUNNER_QUIESCENCE_FAILURE_DETAIL:-}'}" != serialization ]] || return 1
  ! inner_fence_fault serialization serialization
}
recovery_require_pvc_identity(){ [[ "$1" == ret-pvc ]] && check pvc 100; }
recovery_kubectl(){ record operation-lock 300; printf 'fixture-lock-json\n'; }
recovery_operation_lock_json_is_exact(){ [[ "$1" == fixture-lock-json ]] && check lock-identity 100; }
recovery_require_consumer_contract_entry(){
  [[ "$1" == owned-fixture-contract && "$3" == 0 ]] || return 1
  check "consumer-$2" 100
}
require_parent_writer_monitor_capability(){ check writer 1200; }
require_parent_freeze_fence_capability(){ check freeze 1200; }
recovery_private_values_file_is_acceptable(){ [[ "$1" == "$fixture/baseline" ]]; }
recovery_file_size_bytes(){ printf '2\n'; }
recovery_sha256_digest(){ printf '%s\n' "$hash"; }
recovery_durable_fence_inventory_json_is_canonical(){ [[ "$1" == '[]' ]]; }
recovery_capture_durable_quiescence_into(){ check quiescence 3000 || return 1; printf -v "$1" '%s' '[]'; }
recovery_require_no_managed_bot_runner_pods(){ check quiescence 3000; }
recovery_require_no_legacy_parent_runner_pods(){ check legacy-parent-absence 100; }
recovery_monitor_authority_sha256_for_ready(){ printf '%s\n' "$hash"; }
recovery_runner_watch_marker_is_exact(){ return 0; }
recovery_monitor_authority_path(){ printf '%s\n' "$fixture/authority"; }
recovery_durable_runner_monitor_control_capability_sha256(){ printf '%s\n' "$hash"; }
recovery_durable_runner_monitor_authority_is_exact(){ check durable-authority 200; }
recovery_durable_runner_monitor_positive_marker(){ printf 'fixture-marker\n'; }
recovery_stream_guard_progress_value(){ check durable-progress 100; }
recovery_process_identity_is_live(){ check durable-process 100; }
recovery_checkpoint_writer_monitor_file_is_exact(){ check durable-baseline 100; }
recovery_read_recovery_operation_fence_state(){ [[ "$1" == active && "$2" == fixture-fence ]] && check active-fence 200; }
require_exact_pgsql_source_now(){ check pgsql-source 300; }
recovery_write_stream_guard_progress(){
  [[ "$1" == "$fixture/progress" && "$2" == 1 ]] || return 1
  record publish 0
}
sleep(){ : >"$fixture/stop"; }
status=0
monitor_exact_pgsql_source || status=$?
printf 'status=%s\n' "$status"
`;

function run(fault = "none", generation = "durable-v2") {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "yenhubs-pgsql-sweep-"));
  try {
    const result = spawnSync("/bin/bash", ["-c", `${functions}\n${harness}`, "fixture", fixture, fault, generation], {
      encoding: "utf8", timeout: 5000
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const text = readFileSync(path.join(fixture, "calls"), "utf8").trim();
    const calls = (text ? text.split("\n") : []).map(line => {
      const [family, cost] = line.split(" ");
      return { family, cost: Number(cost) };
    });
    let failure = "";
    try { failure = readFileSync(path.join(fixture, "failure"), "utf8").trim(); } catch {}
    return {
      status: Number(result.stdout.match(/^status=(\d+)$/m)?.[1]),
      calls, failure,
      cost: calls.reduce((sum, call) => sum + call.cost, 0),
      count: family => calls.filter(call => call.family === family).length
    };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

test("durable PGSQL sweep audits each quiescence once while retaining complete nested validators", () => {
  const r = run();
  assert.equal(r.status, 0, JSON.stringify(r));
  assert.equal(r.count("quiescence"), 1, JSON.stringify(r.calls));
  assert.equal(r.count("operation-lock"), 5, "backup guard, durable parent, exact quiescence and both fence boundaries retain their lock checks");
  for (const family of ["cluster", "serialization", "pvc", "lock-identity", "writer", "durable-authority", "durable-process", "durable-progress", "durable-baseline", "active-fence", "pgsql-source"])
    assert.ok(r.count(family) > 0, family);
  for (const writer of ["reticulum", "pgbouncer", "pgbouncer-t", "bot-orchestrator", "coturn"])
    assert.equal(r.count(`consumer-${writer}`), 1, writer);
  assert.equal(r.count("publish"), 1);
  assert.equal(r.calls.at(-1).family, "publish", "progress follows the complete round, never a separate heartbeat");
});

test("legacy PGSQL sweep retains its direct exact quiescence validation", () => {
  const r = run("none", "legacy-absent");
  assert.equal(r.status, 0);
  assert.equal(r.count("quiescence"), 1);
  assert.equal(r.count("durable-authority"), 0);
  assert.equal(r.count("writer"), 1);
  assert.equal(r.count("pgsql-source"), 1);
  assert.equal(r.count("publish"), 1);
});

test("PGSQL monitor cannot rely on a lock whose serialization Lease was not required", () => {
  const r = run("lease-not-required");
  assert.equal(r.status, 1);
  assert.equal(r.count("publish"), 0);
  assert.equal(r.failure, "pgsql_source_monitor_failed:serialization");
});

for (const fault of ["cluster", "serialization", "pvc", "lock-identity", "writer", "quiescence", "durable-authority", "durable-process", "durable-progress", "durable-baseline", "active-fence", "pgsql-source",
  ...["reticulum", "pgbouncer", "pgbouncer-t", "bot-orchestrator", "coturn"].map(name => `consumer-${name}`)]) {
  test(`PGSQL round never publishes progress after ${fault} fails`, () => {
    const r = run(fault);
    assert.equal(r.status, 1, JSON.stringify(r));
    assert.equal(r.count("publish"), 0, JSON.stringify(r));
    const component = ({ cluster: "cluster-identity", pvc: "pvc-identity", "lock-identity": "operation-lock",
      writer: "parent-writer", quiescence: "runner-quiescence" })[fault] || fault;
    assert.equal(r.failure, `pgsql_source_monitor_failed:${component}`, "preserve the first exact component, not a later generic parent failure");
  });
}

for (const fault of ["inner-quiescence-serialization", "inner-quiescence-lock", "inner-fence-serialization-pre",
  "inner-fence-serialization-post", "inner-fence-lock-pre", "inner-fence-lock-post"]) {
  test(`PGSQL preserves authorization failure reached only inside ${fault}`, () => {
    const r = run(fault);
    assert.equal(r.status, 1, JSON.stringify(r));
    assert.equal(r.count("publish"), 0);
    // The outer authorization already passed. The deeper validator must not
    // replace this reason with generic runner-quiescence or active-fence.
    assert.ok(r.count("operation-lock") > 1);
    const component = fault.includes("serialization") ? "serialization" : "cluster-identity";
    assert.equal(r.failure, `pgsql_source_monitor_failed:${component}`);
  });
}

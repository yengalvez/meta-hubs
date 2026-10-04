import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const source = readFileSync(new URL("../../deployment/backup-retdb.sh", import.meta.url), "utf8");
const library = readFileSync(new URL("../../deployment/lib/recovery-safety.sh", import.meta.url), "utf8");
const bash = process.platform === "darwin" ? "/opt/homebrew/bin/bash" : "bash";
function extract(name, text = source) {
  const start = text.indexOf(`\n${name}() {\n`);
  assert.notEqual(start, -1, name);
  const end = text.indexOf("\n}\n", start);
  assert.notEqual(end, -1, name);
  return text.slice(start + 1, end + 3);
}
// Run the real serial PGSQL monitor, complete backup guard and source guardian.
// The guardian checks an owned native fixture job and its original identity;
// Cluster/database validators and parent capabilities remain fixtures. The
// separate owned-round tests cover the gated parallel publisher. No real
// kubectl or database is involved.
const functions = ["require_parent_durable_monitor_capability", "require_backup_guard", "record_pgsql_source_monitor_failure", "db_source_guardian_is_usable", "monitor_exact_pgsql_source"]
  .map(name => extract(name)).join("\n") + "\n" +
  ["recovery_pgsql_source_monitor_failure_code_is_exact", "recovery_require_operation_lock",
    "recovery_require_checkpoint_runner_quiescence_exact", "recovery_require_recovery_operation_fence_state",
    "recovery_require_durable_runner_quiescence_monitor_healthy", "recovery_process_start_identity"].map(name => extract(name, library)).join("\n") + "\n" +
  extract("recovery_process_identity_is_live", library)
    .replace("recovery_process_identity_is_live()", "native_process_identity_is_live()");
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
recovery_process_identity_is_live(){
  if [[ "$1" == "$DB_SOURCE_GUARDIAN_PID" ]]; then
    record guardian-identity 0
    native_process_identity_is_live "$@"
  else
    check durable-process 100
  fi
}
recovery_checkpoint_writer_monitor_file_is_exact(){ check durable-baseline 100; }
recovery_read_recovery_operation_fence_state(){ [[ "$1" == active && "$2" == fixture-fence ]] && check active-fence 200; }
require_exact_pgsql_source_now(){ check pgsql-source 300; }
recovery_write_stream_guard_progress(){
  [[ "$1" == "$fixture/progress" && "$2" == 1 ]] || return 1
  record publish 0
}
sleep(){ : >"$fixture/stop"; }
# Stay on the real serial guard path: this fixture is not an owned publisher.
DB_SOURCE_PUBLISHER_ACTIVE=0 DB_SOURCE_OWNED_GROUP="$BASHPID"
fixture_guardian_pid=
stop_fixture_guardian(){
  [[ -n "$fixture_guardian_pid" ]] || return 0
  local active_jobs guardian_status
  active_jobs="$(builtin jobs -pr; builtin jobs -ps)"
  if [[ $'\n'"$active_jobs"$'\n' == *$'\n'"$fixture_guardian_pid"$'\n'* ]]; then
    kill -TERM "$fixture_guardian_pid" || return 1
  fi
  if wait "$fixture_guardian_pid"; then guardian_status=0; else guardian_status=$?; fi
  fixture_guardian_pid=
  printf 'guardian_cleanup_status=%s\n' "$guardian_status"
}
trap stop_fixture_guardian EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Node alone owns the control pipe's writer. Explicit fd 3 survives Bash's
# background stdin=/dev/null rule; EOF also retires this isolated fixture when
# Node is killed and cannot run finally. The guardian still pins its OWN group.
exec 3<&0
(
  trap - EXIT INT TERM
  guardian_pid="$BASHPID" guardian_group="$DB_SOURCE_OWNED_GROUP"
  own_group="$(command ps -o pgid= -p "$guardian_pid" | tr -d '[:space:]')" || exit 1
  [[ "$own_group" == "$guardian_group" ]] || exit 1
  printf 'guardian_control_ready=1\n'
  IFS= read -r guardian_control <&3 || :
  own_group="$(command ps -o pgid= -p "$guardian_pid" | tr -d '[:space:]')" || exit 1
  [[ "$BASHPID" == "$guardian_pid" && "$own_group" == "$guardian_group" ]] || exit 1
  kill -KILL -- "-$guardian_group"
) &
fixture_guardian_pid=$!
DB_SOURCE_GUARDIAN_PID="$fixture_guardian_pid"
DB_SOURCE_GUARDIAN_IDENTITY="$(recovery_process_start_identity "$DB_SOURCE_GUARDIAN_PID")" || exit 1
fixture_guardian_group="$(command ps -o pgid= -p "$DB_SOURCE_GUARDIAN_PID" | tr -d '[:space:]')" || exit 1
[[ "$fixture_guardian_group" == "$DB_SOURCE_OWNED_GROUP" ]] || exit 1
if [[ "$fault" == owner-lifetime ]]; then
  db_source_guardian_is_usable || exit 1
  fixture_owner_identity="$(recovery_process_start_identity "$DB_SOURCE_OWNED_GROUP")" || exit 1
  printf 'fixture_owner=%s:%s\n' "$DB_SOURCE_OWNED_GROUP" "$fixture_owner_identity"
  printf 'fixture_guardian=%s:%s\n' "$DB_SOURCE_GUARDIAN_PID" "$DB_SOURCE_GUARDIAN_IDENTITY"
  command mkfifo "$fixture/owner-pause" || exit 1
  IFS= read -r owner_input <"$fixture/owner-pause"
  exit 119
fi
case "$fault" in
  guardian-group) DB_SOURCE_OWNED_GROUP=$((BASHPID + 1)) ;;
  guardian-identity) DB_SOURCE_GUARDIAN_IDENTITY=foreign-reused-start ;;
  guardian-job) stop_fixture_guardian || exit 1 ;;
esac
status=0
monitor_exact_pgsql_source || status=$?
printf 'status=%s\n' "$status"
`;

function observe(child, onOutput = () => {}) {
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; onOutput(stdout); });
  child.stderr.on("data", data => { stderr += data; });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

async function run(fault = "none", generation = "durable-v2") {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "yenhubs-pgsql-sweep-"));
  const child = spawn(bash, ["-c", `${functions}\n${harness}`, "fixture", fixture, fault, generation], {
    // Its shell and native guardian share this fixture's own process group.
    detached: true, stdio: ["pipe", "pipe", "pipe"]
  });
  const closed = observe(child);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.stdin.destroy(); }, 5000);
  try {
    const result = await closed;
    assert.equal(timedOut, false, "the original five-second fixture deadline is a failure, never acceptance");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(Number(result.stdout.match(/^guardian_cleanup_status=(\d+)$/m)?.[1]), 143,
      "the original fixture job is terminated and natively joined on every path");
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
    clearTimeout(timer);
    child.stdin.destroy();
    await closed.catch(() => {});
    rmSync(fixture, { recursive: true, force: true });
  }
}

const nativeActorCheck = ["recovery_process_start_identity", "recovery_process_identity_is_live"]
  .map(name => extract(name, library)).join("\n") + '\nrecovery_process_identity_is_live "$1" "$2"';
function actorStatus([pid, identity]) {
  const result = spawnSync(bash, ["-c", nativeActorCheck, "actor-check", pid, identity], {
    encoding: "utf8", timeout: 5000
  });
  assert.ifError(result.error);
  return result.status;
}

// The launcher owns Bash's only control writer. Its own stdin is a second
// owner pipe: killing the outer test runner also closes this writer transitively.
const launcher = String.raw`
const { spawn } = require("node:child_process");
const child = spawn(process.argv[1], ["-c", process.argv[2], "fixture", process.argv[3], "owner-lifetime", "durable-v2"], {
  detached: true, stdio: ["pipe", "pipe", "pipe"]
});
process.stdin.on("end", () => child.stdin.destroy());
process.stdin.resume();
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.once("error", () => process.exit(1));
child.once("close", status => process.exit(status ?? 1));
`;
for (const signal of ["SIGTERM", "SIGKILL"]) {
  test(`killing the fixture launcher with ${signal} retires both original native child identities`, async () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), "yenhubs-pgsql-sweep-owner-"));
    const wrapper = spawn(process.execPath, ["-e", launcher, bash, `${functions}\n${harness}`, fixture], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let resolveReady, rejectReady, timedOut = false;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const closed = observe(wrapper, output => {
      const actors = ["owner", "guardian"].map(kind =>
        output.match(new RegExp(`^fixture_${kind}=([1-9][0-9]*):((?:darwin|linux):[^:\\n]+:[0-9]+)$`, "m")));
      if (output.includes("guardian_control_ready=1\n") && actors.every(Boolean))
        resolveReady(actors.map(match => [match[1], match[2]]));
    });
    closed.then(() => rejectReady(new Error("fixture exited before native identities were ready")), rejectReady);
    const deadline = Date.now() + 5000;
    const timer = setTimeout(() => {
      timedOut = true;
      wrapper.stdin.destroy();
      rejectReady(new Error("fixture launcher exceeded the original five-second deadline"));
    }, 5000);
    try {
      const actors = await ready;
      assert.notEqual(actors[0][0], actors[1][0]);
      for (const actor of actors) assert.equal(actorStatus(actor), 0, "capture the original live identity before killing its launcher");
      assert.equal(wrapper.kill(signal), true, "signal only the actual child launcher handle, never an adopted PID/group");
      const result = await closed;
      assert.equal(result.signal, signal);
      while (actors.some(actor => actorStatus(actor) !== 1)) {
        assert.ok(Date.now() < deadline, "both original child identities must retire within the original fixture deadline");
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.equal(timedOut, false);
      assert.ok(Date.now() < deadline);
    } finally {
      clearTimeout(timer);
      wrapper.stdin.destroy();
      if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill("SIGKILL");
      await closed.catch(() => {});
      rmSync(fixture, { recursive: true, force: true });
    }
  });
}

test("durable PGSQL sweep audits each quiescence once while retaining complete nested validators", async () => {
  const r = await run();
  assert.equal(r.status, 0, JSON.stringify(r));
  assert.equal(r.count("quiescence"), 1, JSON.stringify(r.calls));
  assert.equal(r.count("operation-lock"), 5, "backup guard, durable parent, exact quiescence and both fence boundaries retain their lock checks");
  for (const family of ["cluster", "serialization", "pvc", "lock-identity", "writer", "durable-authority", "durable-process", "durable-progress", "durable-baseline", "active-fence", "pgsql-source"])
    assert.ok(r.count(family) > 0, family);
  for (const writer of ["reticulum", "pgbouncer", "pgbouncer-t", "bot-orchestrator", "coturn"])
    assert.equal(r.count(`consumer-${writer}`), 1, writer);
  assert.equal(r.count("publish"), 1);
  assert.equal(r.count("guardian-identity"), 1);
  assert.equal(r.calls.at(-1).family, "publish", "progress follows the complete round, never a separate heartbeat");
});

test("legacy PGSQL sweep retains its direct exact quiescence validation", async () => {
  const r = await run("none", "legacy-absent");
  assert.equal(r.status, 0);
  assert.equal(r.count("quiescence"), 1);
  assert.equal(r.count("durable-authority"), 0);
  assert.equal(r.count("writer"), 1);
  assert.equal(r.count("pgsql-source"), 1);
  assert.equal(r.count("publish"), 1);
  assert.equal(r.count("guardian-identity"), 1);
});

for (const fault of ["guardian-group", "guardian-identity", "guardian-job"]) {
  test(`PGSQL serial sweep cannot publish with ${fault} outside the source guardian contract`, async () => {
    const r = await run(fault);
    assert.equal(r.status, 1, JSON.stringify(r));
    assert.equal(r.count("pgsql-source"), 1, "the complete guard and source round ran before the guardian rejected publication");
    assert.equal(r.count("quiescence"), 1);
    assert.equal(r.count("operation-lock"), 5);
    assert.equal(r.count("publish"), 0);
    assert.equal(r.failure, "pgsql_source_monitor_failed:source-guardian");
  });
}

test("PGSQL monitor cannot rely on a lock whose serialization Lease was not required", async () => {
  const r = await run("lease-not-required");
  assert.equal(r.status, 1);
  assert.equal(r.count("publish"), 0);
  assert.equal(r.failure, "pgsql_source_monitor_failed:serialization");
});

for (const fault of ["cluster", "serialization", "pvc", "lock-identity", "writer", "quiescence", "durable-authority", "durable-process", "durable-progress", "durable-baseline", "active-fence", "pgsql-source",
  ...["reticulum", "pgbouncer", "pgbouncer-t", "bot-orchestrator", "coturn"].map(name => `consumer-${name}`)]) {
  test(`PGSQL round never publishes progress after ${fault} fails`, async () => {
    const r = await run(fault);
    assert.equal(r.status, 1, JSON.stringify(r));
    assert.equal(r.count("publish"), 0, JSON.stringify(r));
    const component = ({ cluster: "cluster-identity", pvc: "pvc-identity", "lock-identity": "operation-lock",
      writer: "parent-writer", quiescence: "runner-quiescence" })[fault] || fault;
    assert.equal(r.failure, `pgsql_source_monitor_failed:${component}`, "preserve the first exact component, not a later generic parent failure");
  });
}

for (const fault of ["inner-quiescence-serialization", "inner-quiescence-lock", "inner-fence-serialization-pre",
  "inner-fence-serialization-post", "inner-fence-lock-pre", "inner-fence-lock-post"]) {
  test(`PGSQL preserves authorization failure reached only inside ${fault}`, async () => {
    const r = await run(fault);
    assert.equal(r.status, 1, JSON.stringify(r));
    assert.equal(r.count("publish"), 0);
    // The outer authorization already passed. The deeper validator must not
    // replace this reason with generic runner-quiescence or active-fence.
    assert.ok(r.count("operation-lock") > 1);
    const component = fault.includes("serialization") ? "serialization" : "cluster-identity";
    assert.equal(r.failure, `pgsql_source_monitor_failed:${component}`);
  });
}

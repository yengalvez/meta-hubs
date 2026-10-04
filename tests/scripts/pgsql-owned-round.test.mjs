import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const backup = readFileSync(new URL("../../deployment/backup-retdb.sh", import.meta.url), "utf8");
const library = readFileSync(new URL("../../deployment/lib/recovery-safety.sh", import.meta.url), "utf8");
const bash = process.platform === "darwin" ? "/opt/homebrew/bin/bash" : "bash";
const authorityReset = backup.slice(backup.indexOf("umask 077\n") + "umask 077\n".length, backup.indexOf("\nif [[ $# -ne 1 ]]"));
function fn(name, source = backup) {
  const start = source.indexOf(`${name}() {\n`);
  assert.notEqual(start, -1, name);
  const end = source.indexOf("\n}\n", start);
  assert.notEqual(end, -1, name);
  return source.slice(start, end + 3);
}
function sourceFunctions() {
  return [...backup.matchAll(/^([a-z_]+)\(\) \{/gm)]
    .map(match => match[1])
    .filter(name => name.startsWith("db_source_") || ["start_db_source_monitor", "stop_db_source_monitor", "monitor_exact_pgsql_source", "record_pgsql_source_monitor_failure", "require_backup_guard"].includes(name))
    .map(name => fn(name)).join("\n");
}
async function run(script, env = {}, afterExit = null) {
  const fixture = mkdtempSync(join(tmpdir(), "yenhubs-pgsql-owned-"));
  const localEnv = { PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin", HOME: process.env.HOME, TMPDIR: tmpdir(), TEST_ROOT: fixture, W_STATUS: "0", D_STATUS: "0", ...env };
  const child = spawn(bash, ["-c", `set -euo pipefail
source deployment/lib/recovery-safety.sh
umask 077
${sourceFunctions()}
OUTPUT_PATH="$TEST_ROOT/output"
DUMP_STREAM_GUARD_ARGS=()
PARENT_STREAM_GUARD_ARGS=()
DB_SOURCE_MONITOR_PID= DB_SOURCE_MONITOR_START_IDENTITY=
DB_SOURCE_MONITOR_STOP= DB_SOURCE_MONITOR_FAILURE= DB_SOURCE_MONITOR_PROGRESS=
DB_SOURCE_MONITOR_CONTROL_FD= DB_SOURCE_MONITOR_READ_FD= DB_SOURCE_MONITOR_ROUND_DIR=
DB_SOURCE_MONITOR_OWNED_PID= DB_SOURCE_MONITOR_OWNED_IDENTITY=
DB_SOURCE_MONITOR_GROUP_PROVEN=0
${fn("stop_db_source_monitor").replace("stop_db_source_monitor()", "original_stop_monitor()")}
stop_db_source_monitor() {
  local joined_pid="$DB_SOURCE_MONITOR_PID" owned_pid="$DB_SOURCE_MONITOR_OWNED_PID"
  local status observed
  if original_stop_monitor "$@"; then status=0; else status=$?; fi
  if [[ -n "$joined_pid" && "$joined_pid" == "$owned_pid" && -z "$DB_SOURCE_MONITOR_PID" ]]; then
    if wait "$joined_pid"; then observed=0; else observed=$?; fi
    [[ "$observed" == "$DB_SOURCE_MONITOR_LAST_STATUS" ]] || exit 101
    printf '%s:%s\\n' "$joined_pid" "$observed" >>"$TEST_ROOT/native-joins"
  fi
  return "$status"
}
actor() {
  local identity
  identity="$(recovery_process_start_identity "$1")" || return 93
  recovery_process_identity_is_live "$1" "$identity" || return 94
  printf '%s:%s\\n' "$1" "$identity" >>"$TEST_ROOT/actors"
}
${script}`], {
    cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: localEnv
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", value => { stdout += value; });
  child.stderr.on("data", value => { stderr += value; });
  let verifiedRetired = false, timedOut = false;
  function retireTestGroups() {
    // A fixture watchdog must also retire an isolated publisher when its
    // guardian is the injected fault. Reuse the real identity/group primitive,
    // never signal a positive PID from a record or adopt a foreign/reused one.
    if (existsSync(join(fixture, "actors"))) {
      for (const record of new Set(readFileSync(join(fixture, "actors"), "utf8").trim().split("\n"))) {
        const boundary = record.indexOf(":"), pid = record.slice(0, boundary), identity = record.slice(boundary + 1);
        if (!/^[1-9][0-9]*$/.test(pid) || !/^(darwin|linux):[^:]+:[0-9]+$/.test(identity)) continue;
        spawnSync(bash, ["-c", 'source deployment/lib/recovery-safety.sh; recovery_process_identity_is_live "$1" "$2" && [[ "$(ps -o pgid= -p "$1" | tr -d "[:space:]")" == "$1" ]] && recovery_revoke_process_group_immediate "$1" "$2"', "owned-retire", pid, identity], { cwd: root, encoding: "utf8", timeout: 5000, env: localEnv });
      }
    }
    // This handle is the actual detached test owner, not an adopted PID.
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }
  }
  const timer = setTimeout(() => { timedOut = true; retireTestGroups(); }, 12000);
  try {
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status, signal) => resolve({ status, signal }));
    });
    const exited = new Promise(resolve => child.once("exit", resolve));
    await exited;
    const afterExitResult = afterExit ? await afterExit({ fixture, child, localEnv }) : null;
    const result = await closed;
    const actors = existsSync(join(fixture, "actors")) ? readFileSync(join(fixture, "actors"), "utf8").trim().split("\n") : [];
    for (const actor of actors) {
      const boundary = actor.indexOf(":");
      const pid = actor.slice(0, boundary), identity = actor.slice(boundary + 1);
      assert.match(pid, /^[1-9][0-9]*$/);
      assert.match(identity, /^(darwin|linux):[^:]+:[0-9]+$/);
      const check = spawnSync(bash, ["-c", `source deployment/lib/recovery-safety.sh; recovery_process_identity_is_live "$1" "$2"`, "owned-check", pid, identity], { cwd: root, encoding: "utf8", timeout: 5000, env: localEnv });
      assert.ifError(check.error);
      assert.equal(check.status, 1, `owned actor still live: ${pid}; ${stderr}`);
    }
    verifiedRetired = true;
    assert.equal(timedOut, false, "the finite fixture deadline is FAIL, never acceptance");
    const files = Object.fromEntries(readdirSync(fixture).filter(name => !name.includes("pgsql-round")).map(name => [name, readFileSync(join(fixture, name), "utf8")]));
    return { ...result, stdout, stderr, files, actorCount: actors.length, afterExitResult };
  } finally {
    clearTimeout(timer);
    if (!verifiedRetired) retireTestGroups();
    rmSync(fixture, { recursive: true, force: true });
  }
}

test("a killed source publisher cannot leave its real descendant alive", async () => {
  const result = await run(`
monitor_exact_pgsql_source() {
  sleep 30 &
  printf '%s\\n' "$!" >"$TEST_ROOT/descendant"
  actor "$!"
  actor "$BASHPID"
  actor "$DB_SOURCE_GUARDIAN_PID"
  recovery_write_stream_guard_progress "$DB_SOURCE_MONITOR_PROGRESS" 1
  while [[ ! -e "$DB_SOURCE_MONITOR_STOP" ]]; do sleep 0.05; done
}
start_db_source_monitor
descendant="$(<"$TEST_ROOT/descendant")"
kill -0 "$descendant"
kill -KILL "$DB_SOURCE_MONITOR_PID"
if stop_db_source_monitor; then exit 90; fi
for ((attempt=0; attempt<40; attempt++)); do
  kill -0 "$descendant" 2>/dev/null || break
  sleep 0.05
done
if kill -0 "$descendant" 2>/dev/null; then
  printf 'owned-descendant-survived\\n' >&2
  exit 91
fi
printf 'retired\\n'
`);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "retired\n");
  assert.equal(result.actorCount, 3);
});

test("owner SIGKILL with a real surviving pipeline cannot retain the source control writer", async () => {
  const pipelineFixture = `
monitor_exact_pgsql_source() {
  actor "$BASHPID"
  actor "$DB_SOURCE_GUARDIAN_PID"
  sleep 30 &
  actor "$!"
  recovery_write_stream_guard_progress "$DB_SOURCE_MONITOR_PROGRESS" 1
  while [[ ! -e "$DB_SOURCE_MONITOR_STOP" ]]; do sleep 0.05; done
}
start_db_source_monitor
printf '%s' "$DB_SOURCE_MONITOR_PID" >"$TEST_ROOT/source.pid"
printf '%s' "$DB_SOURCE_MONITOR_START_IDENTITY" >"$TEST_ROOT/source.identity"
(
  actor "$BASHPID"
  printf '%s' "$BASHPID" >"$TEST_ROOT/pipeline.pid"
  recovery_process_start_identity "$BASHPID" >"$TEST_ROOT/pipeline.identity"
  if { : >&"$DB_SOURCE_MONITOR_CONTROL_FD"; } 2>/dev/null; then
    printf held >"$TEST_ROOT/pipeline.fd"
  else
    printf closed >"$TEST_ROOT/pipeline.fd"
  fi
  # A real Bash pipeline member keeps inherited shell FDs live; exec sleep
  # could close the descriptor and hide the owner's capability leak.
  while :; do sleep 1; done
) | (
  actor "$BASHPID"
  : >"$TEST_ROOT/pipeline-right.ready"
  exec sleep 30
) >/dev/null 2>&1 &
for ((attempt=0; attempt<100; attempt++)); do
  [[ -e "$TEST_ROOT/pipeline.fd" && -e "$TEST_ROOT/pipeline-right.ready" ]] && break
  sleep 0.01
done
[[ -e "$TEST_ROOT/pipeline.fd" && -e "$TEST_ROOT/pipeline-right.ready" ]]
kill -KILL "$BASHPID"
`;
  const observe = ({ child, localEnv }) => spawnSync(bash, ["-c", `
source deployment/lib/recovery-safety.sh
source_pid="$(<"$TEST_ROOT/source.pid")"
source_identity="$(<"$TEST_ROOT/source.identity")"
pipeline_pid="$(<"$TEST_ROOT/pipeline.pid")"
pipeline_identity="$(<"$TEST_ROOT/pipeline.identity")"
recovery_process_identity_is_live "$pipeline_pid" "$pipeline_identity" || exit 102
[[ "$(ps -o pgid= -p "$pipeline_pid" | tr -d '[:space:]')" == "$1" ]] || exit 103
for ((attempt=0; attempt<40; attempt++)); do
  kill -0 "$source_pid" 2>/dev/null || break
  sleep 0.05
done
status=0
if recovery_process_identity_is_live "$source_pid" "$source_identity"; then status=104; fi
recovery_process_identity_is_live "$pipeline_pid" "$pipeline_identity" || status=105
printf 'source-retired:%s:pipeline-live\\n' "$status"
# This STILL-LIVE exact pipeline member pins the detached fixture owner's
# own group. One atomic retirement signal; never signal a reaped empty PGID.
if recovery_process_identity_is_live "$pipeline_pid" "$pipeline_identity" &&
   [[ "$(ps -o pgid= -p "$pipeline_pid" | tr -d '[:space:]')" == "$1" ]]; then
  kill -KILL -- "-$1"
fi
exit "$status"
`, "pipeline-observer", String(child.pid)], { cwd: root, encoding: "utf8", timeout: 5000, env: localEnv });
  // Reproduce the rejected writer duplication without reverting shared files.
  // The pipeline must remain alive AND retain the publisher for this RED
  // control: merely observing an open FD before exec would not prove the leak.
  const leakyStart = fn("start_db_source_monitor").replace(
    '  DB_SOURCE_MONITOR_CONTROL_FD="$pipe_write"',
    '  exec {DB_SOURCE_MONITOR_CONTROL_FD}>&"$pipe_write"\n  exec {pipe_write}>&-'
  );
  assert.notEqual(leakyStart, fn("start_db_source_monitor"));
  const red = await run(`${leakyStart}\n${pipelineFixture}`, {}, observe);
  assert.equal(red.signal, "SIGKILL", red.stderr);
  assert.ifError(red.afterExitResult.error);
  assert.equal(red.afterExitResult.status, 104, red.afterExitResult.stdout);
  assert.equal(red.files["pipeline.fd"], "held");
  const result = await run(pipelineFixture, {}, observe);
  assert.equal(result.signal, "SIGKILL", result.stderr);
  assert.ifError(result.afterExitResult.error);
  assert.equal(result.afterExitResult.status, 0, result.afterExitResult.stdout);
  assert.equal(result.files["pipeline.fd"], "closed");
  assert.ok(result.actorCount >= 5);
});

const roundFixture = `
COORDINATED=1 RECOVERY_OPERATION_OWNER=checkpoint-backup
RECOVERY_CONSUMER_CONTRACT_JSON=synthetic RECOVERY_SERIALIZATION_LEASE_REQUIRED=1
CHECKPOINT_RUNNER_GENERATION=durable-v2 PARENT_FREEZE_FENCE_CAPABILITY=
CHECKPOINT_DURABLE_FENCE_BASELINE_PATH=synthetic CHECKPOINT_DURABLE_FENCE_BASELINE_SHA256=synthetic
event() { printf '%s\\n' "$1" >>"$TEST_ROOT/events"; }
recovery_require_operation_lock() { event lock; }
recovery_require_consumer_contract_entry() { event "consumer-$2"; }
require_parent_writer_monitor_capability() {
  actor "$BASHPID"
  event W-start
  : >"$TEST_ROOT/W.started"
  # This barrier requires actual overlap; the original serial predicate
  # cannot reach D while W is blocked here.
  for ((attempt=0; attempt<100; attempt++)); do
    [[ -e "$TEST_ROOT/D.started" ]] && break
    sleep 0.01
  done
  [[ -e "$TEST_ROOT/D.started" ]] || return 31
  sleep 0.08
  event W-end
  : >"$TEST_ROOT/W.ended"
  return "$W_STATUS"
}
require_parent_durable_monitor_capability() {
  actor "$BASHPID"
  event D-start
  : >"$TEST_ROOT/D.started"
  sleep 0.02
  event D-end
  : >"$TEST_ROOT/D.ended"
  DB_PARENT_DURABLE_FAILURE_REASON=active-fence
  return "$D_STATUS"
}
require_exact_pgsql_source_now() {
  [[ -e "$TEST_ROOT/W.ended" && -e "$TEST_ROOT/D.ended" ]] || return 81
  event pgsql
}
${fn("monitor_exact_pgsql_source").replace("monitor_exact_pgsql_source()", "original_monitor()")}
monitor_exact_pgsql_source() {
  actor "$BASHPID"
  actor "$DB_SOURCE_GUARDIAN_PID"
  original_monitor
}
${fn("recovery_write_stream_guard_progress", library).replace("recovery_write_stream_guard_progress()", "original_progress()")}
recovery_write_stream_guard_progress() {
  original_progress "$@" || return $?
  event "publish-$2"
}
`;

test("healthy real workers overlap after all five consumers and join before PGSQL/publication", async () => {
  const result = await run(`${roundFixture}
start_db_source_monitor
source_pid="$DB_SOURCE_MONITOR_PID"
stop_db_source_monitor
[[ "$DB_SOURCE_MONITOR_LAST_STATUS" == 0 ]]
kill -0 -- "-$source_pid" 2>/dev/null && exit 82
printf 'healthy\\n'
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "healthy\n", "private IPC never enters archive stdout");
  const events = result.files.events.trim().split("\n");
  assert.deepEqual(events.slice(0, 6), ["lock", "consumer-reticulum", "consumer-pgbouncer", "consumer-pgbouncer-t", "consumer-bot-orchestrator", "consumer-coturn"]);
  assert.ok(events.indexOf("D-start") < events.indexOf("W-end"));
  assert.ok(events.indexOf("W-start") < events.indexOf("D-end"));
  for (const end of ["W-end", "D-end"]) assert.ok(events.indexOf(end) < events.indexOf("pgsql"));
  assert.ok(events.indexOf("pgsql") < events.indexOf("publish-1"));
  const progress = Object.entries(result.files).filter(([name]) => /^output\.pgsql-monitor-progress\.[^.]+$/.test(name));
  assert.equal(progress.length, 1);
  assert.match(progress[0][1], /^[1-9][0-9]*\n$/);
  assert.ok(result.actorCount >= 4);
});

test("healthy STOP joins its pins and never signals the historical source PGID afterwards", async () => {
  const result = await run(`${roundFixture}
TEST_OWNER_PID="$BASHPID"
wait() {
  local status
  if builtin wait "$@"; then status=0; else status=$?; fi
  if [[ "$BASHPID" == "$TEST_OWNER_PID" && "$1" == "$DB_SOURCE_MONITOR_OWNED_PID" ]]; then
    printf 'owner-joined:%s:%s\\n' "$1" "$status" >>"$TEST_ROOT/retirement"
  elif [[ "$BASHPID" != "$TEST_OWNER_PID" && "$1" == "$DB_SOURCE_GUARDIAN_PID" ]]; then
    printf 'guardian-joined:%s:%s\\n' "$1" "$status" >>"$TEST_ROOT/retirement"
  fi
  return "$status"
}
kill() {
  if [[ "$*" == *" -"[0-9]* ]]; then
    printf 'group-signal:%s\\n' "$*" >>"$TEST_ROOT/retirement"
  fi
  builtin kill "$@"
}
start_db_source_monitor
stop_db_source_monitor
printf 'stopped\\n'
`);
  assert.equal(result.status, 0, result.stderr);
  const events = result.files.retirement.trim().split("\n");
  const guardian = events.findIndex(value => /^guardian-joined:[0-9]+:0$/.test(value));
  const owner = events.findIndex(value => /^owner-joined:[0-9]+:0$/.test(value));
  assert.ok(guardian >= 0 && owner > guardian, events.join("\n"));
  assert.ok(!events.slice(owner + 1).some(value => value.startsWith("group-signal:")), "no signal is authorized after losing the last source-group pin");
});

test("revoke never signals after the snapshot publisher and guardian pins really retire", async () => {
  const result = await run(`${roundFixture}
TEST_OWNER_PID="$BASHPID" TEST_REVOKE_INTERLEAVE=0
monitor_exact_pgsql_source() {
  actor "$BASHPID"
  actor "$DB_SOURCE_GUARDIAN_PID"
  printf '%s' "$DB_SOURCE_GUARDIAN_PID" >"$TEST_ROOT/guardian.pid"
  printf '%s' "$DB_SOURCE_GUARDIAN_IDENTITY" >"$TEST_ROOT/guardian.identity"
  recovery_write_stream_guard_progress "$DB_SOURCE_MONITOR_PROGRESS" 1
  while [[ ! -e "$DB_SOURCE_MONITOR_STOP" ]]; do sleep 0.01; done
  while [[ ! -e "$TEST_ROOT/allow-source-exit" ]]; do sleep 0.01; done
  return 0
}
ps() {
  local snapshot
  if [[ "$TEST_REVOKE_INTERLEAVE" == 1 && "$*" == "-o pgid= -p $DB_SOURCE_MONITOR_PID" ]]; then
    # The old revoke has already proved jobs/start. Capture a REAL last PGID
    # snapshot while both pins are still live, then release healthy STOP.
    snapshot="$(command ps "$@")" || return $?
    recovery_process_identity_is_live "$DB_SOURCE_MONITOR_PID" "$DB_SOURCE_MONITOR_START_IDENTITY" || return 107
    event snapshot-live
    : >"$TEST_ROOT/allow-source-exit"
    printf '%s\\n' "$snapshot"
  else
    command ps "$@"
  fi
}
kill() {
  local joined_status guardian_pid guardian_identity
  if [[ "$BASHPID" == "$TEST_OWNER_PID" && "$*" == "-KILL -- -$DB_SOURCE_MONITOR_PID" ]]; then
    # Interpose immediately BEFORE the old signal, not its status. Native
    # wait proves the publisher really exited; its healthy path already
    # natively joined/disarmed the guardian. Neither former pin may be alive.
    if builtin wait "$DB_SOURCE_MONITOR_PID"; then joined_status=0; else joined_status=$?; fi
    [[ "$joined_status" == 0 ]] || return 108
    guardian_pid="$(<"$TEST_ROOT/guardian.pid")"
    guardian_identity="$(<"$TEST_ROOT/guardian.identity")"
    if recovery_process_identity_is_live "$DB_SOURCE_MONITOR_PID" "$DB_SOURCE_MONITOR_START_IDENTITY" ||
       recovery_process_identity_is_live "$guardian_pid" "$guardian_identity"; then return 109; fi
    event last-pins-retired-native0
    event historical-group-signal
    # This is a real empty historical PGID, not simulated kernel reuse. Never
    # deliver the RED signal if any current group member could receive it.
    if builtin kill -0 -- "-$DB_SOURCE_MONITOR_PID" 2>/dev/null; then return 110; fi
  fi
  builtin kill "$@"
}
start_db_source_monitor
TEST_REVOKE_INTERLEAVE=1
if stop_db_source_monitor revoke; then stop_status=0; else stop_status=$?; fi
printf 'native:%s:stop:%s\\n' "$DB_SOURCE_MONITOR_LAST_STATUS" "$stop_status"
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.actorCount, 2);
  const events = result.files.events || "";
  assert.ok(!events.includes("historical-group-signal"), `real last pins retired before the attempted signal:\n${events}`);
  assert.match(result.stdout, /^native:(143|137):stop:\1\n$/, "EOF cancellation retains the true native signal status, not healthy0");
});

test("injected environment cannot select owned joins in preflight or final serial guards", async () => {
  const result = await run(`${roundFixture}
require_parent_writer_monitor_capability() { event W-serial; }
require_parent_durable_monitor_capability() { event D-serial; }
db_source_join_parent_round() { event forbidden-owned-join; return 106; }
export DB_SOURCE_OWNED_GROUP="$BASHPID" DB_SOURCE_PUBLISHER_ACTIVE=1
export DB_SOURCE_ROUND=7 DB_SOURCE_GUARDIAN_PID="$BASHPID" DB_SOURCE_GUARDIAN_IDENTITY=foreign
${authorityReset}
for phase in preflight final; do require_backup_guard; done
printf 'serial\\n'
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "serial\n");
  assert.ok(!result.files.events.includes("forbidden-owned-join"));
  assert.deepEqual(result.files.events.trim().split("\n").filter(value => value.endsWith("-serial")), ["W-serial", "D-serial", "W-serial", "D-serial"]);
});

test("RED control: the original serial predicate cannot satisfy the real overlap barrier", async () => {
  const serialGuard = fn("require_backup_guard").replace(/  # Only the gated PGSQL publisher[\s\S]*?\n  fi\n/, "");
  assert.ok(!serialGuard.includes("db_source_join_parent_round"));
  const result = await run(`${roundFixture}
${serialGuard}
if start_db_source_monitor; then stop_db_source_monitor revoke; exit 98; fi
printf '%s\\n' "$(<"$DB_SOURCE_MONITOR_FAILURE")"
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "pgsql_source_monitor_failed:parent-writer\n");
  assert.ok(result.files.events.includes("W-start\n"));
  assert.ok(!result.files.events.includes("D-start\n"));
  assert.ok(!result.files.events.includes("publish-"));
});

for (const failed of ["lock", "consumer-pgbouncer-t"]) {
  test(`common ${failed} rejection starts neither complete branch`, async () => {
    const replacement = failed === "lock"
      ? 'recovery_require_operation_lock() { event lock; return 1; }'
      : 'recovery_require_consumer_contract_entry() { event "consumer-$2"; [[ "$2" != pgbouncer-t ]]; }';
    const result = await run(`${roundFixture}
${replacement}
if start_db_source_monitor; then stop_db_source_monitor revoke; exit 99; fi
printf '%s\\n' "$(<"$DB_SOURCE_MONITOR_FAILURE")"
`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `pgsql_source_monitor_failed:${failed === "lock" ? "operation-lock" : failed}\n`);
    assert.ok(!result.files.events.includes("W-start\n"));
    assert.ok(!result.files.events.includes("D-start\n"));
    assert.ok(!result.files.events.includes("publish-"));
    const progress = Object.entries(result.files).filter(([name]) => /^output\.pgsql-monitor-progress\.[^.]+$/.test(name));
    assert.equal(progress.length, 1);
    assert.equal(progress[0][1], "", "no actual marker publication after guard rejection");
  });
}

for (const [name, writer, durable, reason] of [["writer", 1, 0, "parent-writer"], ["durable", 0, 1, "active-fence"], ["both preserve W priority", 1, 1, "parent-writer"]]) {
  test(`${name} rejection retains the closed original cause and publishes nothing`, async () => {
    const result = await run(`${roundFixture}
if start_db_source_monitor; then stop_db_source_monitor revoke; exit 83; fi
[[ "$DB_SOURCE_MONITOR_LAST_STATUS" != 0 ]]
printf '%s\\n' "$(<"$DB_SOURCE_MONITOR_FAILURE")"
`, { W_STATUS: String(writer), D_STATUS: String(durable) });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `pgsql_source_monitor_failed:${reason}\n`);
    assert.ok(result.files.events.includes("W-end\n"));
    assert.ok(result.files.events.includes("D-end\n"));
    assert.ok(!result.files.events.includes("pgsql\n"));
    assert.ok(!result.files.events.includes("publish-"));
  });
}

test("a worker's real SIGKILL/missing receipt cannot become a successful join", async () => {
  const result = await run(`${roundFixture}
require_parent_writer_monitor_capability() {
  actor "$BASHPID"
  event W-killed
  kill -KILL "$BASHPID"
}
if start_db_source_monitor; then stop_db_source_monitor revoke; exit 84; fi
printf '%s\\n' "$(<"$DB_SOURCE_MONITOR_FAILURE")"
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "pgsql_source_monitor_failed:source-owned-round\n");
  assert.ok(!result.files.events.includes("publish-"));
});

test("native worker exit0 without a closed receipt is rejected", async () => {
  const result = await run(`${roundFixture}
db_source_parent_branch() { actor "$BASHPID"; return 0; }
if start_db_source_monitor; then stop_db_source_monitor revoke; exit 95; fi
printf '%s\\n' "$(<"$DB_SOURCE_MONITOR_FAILURE")"
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "pgsql_source_monitor_failed:source-owned-round\n");
  assert.ok(!result.files.events.includes("publish-"));
});

test("a proven W rejection remains first cause when D's real join is SIGKILL/missing receipt", async () => {
  const result = await run(`${roundFixture}
require_parent_durable_monitor_capability() {
  actor "$BASHPID"
  event D-start
  : >"$TEST_ROOT/D.started"
  kill -KILL "$BASHPID"
}
if start_db_source_monitor; then stop_db_source_monitor revoke; exit 100; fi
printf '%s\\n' "$(<"$DB_SOURCE_MONITOR_FAILURE")"
`, { W_STATUS: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "pgsql_source_monitor_failed:parent-writer\n");
  assert.ok(!result.files.events.includes("publish-"));
});

for (const [name, value, joined] of [
  ["missing newline", "branch:v1:W:1:123:0:complete", 0],
  ["duplicate", "branch:v1:W:1:123:0:complete\nbranch:v1:W:1:123:0:complete\n", 0],
  ["wrong branch", "branch:v1:D:1:123:0:complete\n", 0],
  ["wrong round", "branch:v1:W:2:123:0:complete\n", 0],
  ["wrong PID", "branch:v1:W:1:124:0:complete\n", 0],
  ["status mismatch", "branch:v1:W:1:123:0:complete\n", 37],
  ["wait127", "branch:v1:W:1:123:127:parent-writer\n", 127],
  ["untrusted detail", "branch:v1:W:1:123:1:private-sentinel\n", 1],
  ["NUL", "branch:v1:W:1:123:0:complete\0\n", 0]
]) {
  test(`closed branch receipt refuses ${name}`, async () => {
    // Encode the hostile bytes as numeric printf octals, never a shell program.
    const bytes = [...Buffer.from(value)].map(byte => `\\${byte.toString(8).padStart(3, "0")}`).join("");
    const result = await run(`
DB_SOURCE_MONITOR_ROUND_DIR="$TEST_ROOT"
DB_SOURCE_ROUND=1
printf '%b' '${bytes}' >"$TEST_ROOT/W.result"
if db_source_branch_result W 123 ${joined}; then exit 85; fi
printf 'refused\\n'
`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "refused\n");
  });
}

test("a closed source protocol reader does not attest healthy native exit0", async () => {
  const result = await run(`${roundFixture}
start_db_source_monitor
exec {DB_SOURCE_MONITOR_READ_FD}<&-
DB_SOURCE_MONITOR_READ_FD=
if stop_db_source_monitor; then exit 86; fi
printf 'refused:%s\\n' "$DB_SOURCE_MONITOR_LAST_STATUS"
`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^refused:(0|141)\n$/);
});

test("guardian death rejects the round before any publication", async () => {
  const result = await run(`${roundFixture}
${roundFixture.slice(roundFixture.indexOf("require_exact_pgsql_source_now()"), roundFixture.indexOf("original_progress()")).replace("require_exact_pgsql_source_now()", "original_exact_source()")}
require_exact_pgsql_source_now() {
  original_exact_source || return $?
  kill -KILL "$DB_SOURCE_GUARDIAN_PID"
  sleep 0.05
}
if start_db_source_monitor; then stop_db_source_monitor revoke; exit 87; fi
printf '%s\\n' "$(<"$DB_SOURCE_MONITOR_FAILURE")"
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "pgsql_source_monitor_failed:source-guardian\n");
  assert.ok(!result.files.events.includes("publish-"));
});

for (const [state, accepted] of [[" \tSN\n", true], ["Ss", true], ["TN", false], ["ZN", false], ["", false], ["?", false]]) {
  test(`guardian kernel-state flags ${state.trim() || "empty"} preserve native job and identity requirements`, async () => {
    const actualPs = 'command ps -o state= -p "$DB_SOURCE_GUARDIAN_PID"';
    const fixturePs = 'test_kernel_state "$DB_SOURCE_GUARDIAN_PID"';
    const predicate = fn("db_source_guardian_is_usable").replace(actualPs, fixturePs);
    assert.notEqual(predicate, fn("db_source_guardian_is_usable"));
    assert.equal(predicate.replace(fixturePs, actualPs), fn("db_source_guardian_is_usable"));
    const result = await run(`
${predicate}
test_kernel_state() {
  [[ "$1" == "$DB_SOURCE_GUARDIAN_PID" ]] || return 118
  printf '%s\\n' "$TEST_KERNEL_STATE"
}
DB_SOURCE_OWNED_GROUP="$BASHPID"
sleep 30 &
DB_SOURCE_GUARDIAN_PID=$!
DB_SOURCE_GUARDIAN_IDENTITY="$(recovery_process_start_identity "$DB_SOURCE_GUARDIAN_PID")"
actor "$DB_SOURCE_GUARDIAN_PID"
if db_source_guardian_is_usable; then observed=accepted; else observed=rejected; fi
identity="$DB_SOURCE_GUARDIAN_IDENTITY"
DB_SOURCE_GUARDIAN_IDENTITY=foreign-reused-start
if db_source_guardian_is_usable; then exit 119; fi
DB_SOURCE_GUARDIAN_IDENTITY="$identity"
kill -TERM "$DB_SOURCE_GUARDIAN_PID"
if builtin wait "$DB_SOURCE_GUARDIAN_PID"; then exit 120; else status=$?; fi
[[ "$status" == 143 ]]
if db_source_guardian_is_usable; then exit 121; fi
printf '%s\\n' "$observed"
`, { TEST_KERNEL_STATE: state });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${accepted ? "accepted" : "rejected"}\n`);
    assert.equal(result.actorCount, 1);
  });
}

test("a real locally niced guardian remains usable with native kernel-state flags", async () => {
  const originalPublisher = fn("db_source_owned_publisher");
  const nicedPublisher = originalPublisher.replace("command python3 -I -c '", "command nice -n 1 python3 -I -c '");
  assert.notEqual(nicedPublisher, originalPublisher);
  assert.equal(nicedPublisher.replace("command nice -n 1 python3 -I -c '", "command python3 -I -c '"), originalPublisher);
  const result = await run(`${roundFixture}
${nicedPublisher}
${fn("db_source_guardian_is_usable").replace("db_source_guardian_is_usable()", "original_niced_guardian_predicate()")}
db_source_guardian_is_usable() {
  if [[ ! -e "$TEST_ROOT/niced-guardian-state" ]]; then
    actor "$BASHPID"
    actor "$DB_SOURCE_GUARDIAN_PID"
    command ps -o state= -p "$DB_SOURCE_GUARDIAN_PID" >"$TEST_ROOT/niced-guardian-state"
    command ps -o ni= -p "$DB_SOURCE_GUARDIAN_PID" >"$TEST_ROOT/niced-guardian-priority"
  fi
  original_niced_guardian_predicate
}
monitor_exact_pgsql_source() { original_monitor; }
start_db_source_monitor
stop_db_source_monitor
printf 'niced-healthy\\n'
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "niced-healthy\n");
  assert.ok(Number(result.files["niced-guardian-priority"].trim()) >= 1);
  const state = result.files["niced-guardian-state"].trim();
  assert.match(state, /^[RSIDU]/);
  if (process.platform === "darwin") assert.ok(state.includes("N"), `real niced guardian lacked the expected native N flag: ${state}`);
  assert.ok(result.actorCount >= 4);
});

for (const fault of ["KILL", "STOP"]) {
  test(`guardian SIG${fault} with a really STOPPED writer and blocked durable descendants retires the whole round`, async () => {
    const result = await run(`${roundFixture}
${fn("monitor_exact_pgsql_source").replace("monitor_exact_pgsql_source()", "original_owned_monitor()")}
monitor_exact_pgsql_source() {
  actor "$BASHPID"
  actor "$DB_SOURCE_GUARDIAN_PID"
  original_owned_monitor
}
require_parent_writer_monitor_capability() {
  local descendant
  actor "$BASHPID"
  sleep 30 &
  descendant=$!
  actor "$descendant"
  printf '%s' "$BASHPID" >"$TEST_ROOT/stopped-writer.pid"
  event W-blocked
  kill -STOP "$BASHPID"
  wait "$descendant"
  event forbidden-W-complete
}
require_parent_durable_monitor_capability() {
  local descendant writer state
  actor "$BASHPID"
  sleep 30 &
  descendant=$!
  actor "$descendant"
  for ((attempt=0; attempt<100; attempt++)); do
    [[ -s "$TEST_ROOT/stopped-writer.pid" ]] && break
    sleep 0.01
  done
  writer="$(<"$TEST_ROOT/stopped-writer.pid")"
  for ((attempt=0; attempt<100; attempt++)); do
    state="$(command ps -o state= -p "$writer")" || return 111
    [[ "$state" == *T* ]] && break
    sleep 0.01
  done
  [[ "$state" == *T* ]] || return 112
  event W-really-stopped
  event D-blocked
  recovery_process_identity_is_live "$DB_SOURCE_GUARDIAN_PID" "$DB_SOURCE_GUARDIAN_IDENTITY" || return 113
  kill -${fault} "$DB_SOURCE_GUARDIAN_PID"
  event guardian-${fault}-sent
  wait "$descendant"
  event forbidden-D-complete
}
if start_db_source_monitor; then stop_db_source_monitor revoke; exit 114; fi
[[ "$DB_SOURCE_MONITOR_LAST_STATUS" == 137 ]]
printf '%s\\n' "$(<"$DB_SOURCE_MONITOR_FAILURE")"
`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "pgsql_source_monitor_failed:source-guardian\n");
    assert.equal(result.actorCount, 6);
    assert.ok(result.files.events.includes("W-really-stopped\n"));
    assert.ok(result.files.events.includes("D-blocked\n"));
    assert.ok(result.files.events.includes(`guardian-${fault}-sent\n`));
    assert.ok(!result.files.events.includes("forbidden-"));
    assert.ok(!result.files.events.includes("pgsql\n"));
    assert.ok(!result.files.events.includes("publish-"));
    const progress = Object.entries(result.files).filter(([name]) => /^output\.pgsql-monitor-progress\.[^.]+$/.test(name));
    assert.equal(progress.length, 1);
    assert.equal(progress[0][1], "");
    assert.match(result.files["native-joins"], /^[1-9][0-9]*:137\n$/);
  });
}

test("a STOPPED writer remains pending after durable exit0 until its real CONT and both terminal joins", async () => {
  const result = await run(`${roundFixture}
wait() {
  local active pid status
  if [[ "$BASHPID" == "\${DB_SOURCE_OWNED_GROUP:-}" && -s "$TEST_ROOT/stopped-writer.pid" &&
        ( "$1" == "$(<"$TEST_ROOT/stopped-writer.pid")" || "$1" == "$(<"$TEST_ROOT/durable.pid")" ) ]]; then
    active="$(builtin jobs -pr; builtin jobs -ps)"
    for pid in $active; do
      [[ "$pid" != "$1" ]] || event premature-native-join
    done
  fi
  if builtin wait "$@"; then status=0; else status=$?; fi
  printf 'wait:%s:%s\\n' "$1" "$status" >>"$TEST_ROOT/wait-events"
  return "$status"
}
require_parent_writer_monitor_capability() {
  local descendant
  actor "$BASHPID"
  sleep 1 &
  descendant=$!
  actor "$descendant"
  printf '%s' "$BASHPID" >"$TEST_ROOT/stopped-writer.pid"
  event W-start
  kill -STOP "$BASHPID"
  wait "$descendant"
  event W-end
  : >"$TEST_ROOT/W.ended"
}
require_parent_durable_monitor_capability() {
  actor "$BASHPID"
  printf '%s' "$BASHPID" >"$TEST_ROOT/durable.pid"
  (
    local writer state
    actor "$BASHPID"
    for ((attempt=0; attempt<100; attempt++)); do
      [[ -s "$TEST_ROOT/stopped-writer.pid" ]] && break
      sleep 0.01
    done
    writer="$(<"$TEST_ROOT/stopped-writer.pid")"
    for ((attempt=0; attempt<100; attempt++)); do
      state="$(command ps -o state= -p "$writer")" || exit 115
      [[ "$state" == *T* && -s "$DB_SOURCE_MONITOR_ROUND_DIR/D.result" ]] && break
      sleep 0.01
    done
    [[ "$state" == *T* && -s "$DB_SOURCE_MONITOR_ROUND_DIR/D.result" ]] || exit 116
    sleep 2
    [[ ! -s "$DB_SOURCE_MONITOR_PROGRESS" && "$(<"$TEST_ROOT/events")" != *pgsql* ]] || exit 117
    event stopped-writer-pending
    kill -CONT "$writer"
  ) >&2 &
  event D-end
  : >"$TEST_ROOT/D.ended"
}
if start_db_source_monitor; then
  stop_db_source_monitor
else
  status=$?
  printf 'native:%s detail:%s waits:%s\\n' "\${DB_SOURCE_MONITOR_LAST_STATUS:-missing}" "$(<"$DB_SOURCE_MONITOR_FAILURE")" "$(<"$TEST_ROOT/wait-events")" >&2
  exit "$status"
fi
printf 'stopped-pending-healthy\\n'
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "stopped-pending-healthy\n");
  assert.ok(result.files.events.includes("stopped-writer-pending\n"));
  assert.ok(!result.files.events.includes("premature-native-join"));
  const events = result.files.events.trim().split("\n");
  assert.ok(events.indexOf("D-end") < events.indexOf("stopped-writer-pending"));
  assert.ok(events.indexOf("stopped-writer-pending") < events.indexOf("W-end"));
  assert.ok(events.indexOf("W-end") < events.indexOf("pgsql"));
  assert.ok(events.indexOf("pgsql") < events.indexOf("publish-1"));
});

test("early publisher exit retains original status37 and cannot fabricate progress", async () => {
  const result = await run(`
monitor_exact_pgsql_source() { actor "$BASHPID"; actor "$DB_SOURCE_GUARDIAN_PID"; return 37; }
if start_db_source_monitor; then stop_db_source_monitor revoke; exit 88; fi
printf 'original:%s\\n' "$DB_SOURCE_MONITOR_LAST_STATUS"
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "original:37\n");
});

test("early publisher exit0 without STOP remains rejection, not a healthy receipt", async () => {
  const result = await run(`
monitor_exact_pgsql_source() { actor "$BASHPID"; actor "$DB_SOURCE_GUARDIAN_PID"; return 0; }
if start_db_source_monitor; then stop_db_source_monitor revoke; exit 96; fi
printf '%s\\n' "$(<"$DB_SOURCE_MONITOR_FAILURE")"
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "pgsql_source_monitor_failed:source-owned-round\n");
});

test("the guardian handshake cannot obtain a second startup allowance", async () => {
  const result = await run(`
recovery_stream_poll_seconds() { printf '1\\n'; }
recovery_monotonic_milliseconds() { printf '31000\\n'; }
recovery_runner_watch_marker_is_exact() { return 0; }
recovery_stream_guard_process_is_healthy() { return 0; }
recovery_stream_guard_progress_value() { printf '1\\n'; }
printf 'already-published\\n' >"$TEST_ROOT/progress"
if recovery_wait_for_stream_guard_initial_progress 123 exact empty "$TEST_ROOT/progress" 30 1000; then exit 97; else status=$?; fi
[[ "$status" == 3 ]]
printf 'same-deadline\\n'
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "same-deadline\n");
});

test("foreign PID and mismatched/reused identity are refused without signalling them", async () => {
  const result = await run(`${roundFixture}
start_db_source_monitor
source_pid="$DB_SOURCE_MONITOR_PID" source_identity="$DB_SOURCE_MONITOR_START_IDENTITY"
sleep 30 &
foreign_pid=$!
actor "$foreign_pid"
DB_SOURCE_MONITOR_PID="$foreign_pid"
if stop_db_source_monitor revoke; then exit 89; fi
kill -0 "$foreign_pid"
kill -0 "$source_pid"
DB_SOURCE_MONITOR_PID="$source_pid"
DB_SOURCE_MONITOR_START_IDENTITY=wrong-reused-start
if stop_db_source_monitor revoke; then exit 90; fi
kill -0 "$source_pid"
DB_SOURCE_MONITOR_START_IDENTITY="$source_identity"
stop_db_source_monitor
kill -TERM "$foreign_pid"
wait "$foreign_pid" || :
printf 'foreign-untouched\\n'
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "foreign-untouched\n");
});

for (const signal of ["exit", "TERM", "KILL"]) {
  test(`owner ${signal === "exit" ? "early exit37" : `SIG${signal}`} retires source/guardian/blocked worker descendants`, async () => {
    const result = await run(`${roundFixture}
require_parent_writer_monitor_capability() {
  actor "$BASHPID"
  sleep 30 &
  actor "$!"
  : >"$TEST_ROOT/blocked"
  wait "$!"
}
require_parent_durable_monitor_capability() {
  actor "$BASHPID"
  sleep 30 &
  actor "$!"
  wait "$!"
}
monitor_exact_pgsql_source() {
  actor "$BASHPID"
  actor "$DB_SOURCE_GUARDIAN_PID"
  recovery_write_stream_guard_progress "$DB_SOURCE_MONITOR_PROGRESS" 1
  require_backup_guard || return $?
  event forbidden-publish
}
trap 'stop_db_source_monitor revoke || :' EXIT
trap 'stop_db_source_monitor revoke || :; exit 143' TERM
start_db_source_monitor
for ((attempt=0; attempt<100; attempt++)); do
  [[ -e "$TEST_ROOT/blocked" ]] && break
  sleep 0.01
done
[[ -e "$TEST_ROOT/blocked" ]] || exit 92
${signal === "exit" ? "exit 37" : `kill -${signal} "$BASHPID"`}
sleep 30
`);
    if (signal === "exit") assert.equal(result.status, 37, result.stderr);
    else if (signal === "TERM") assert.equal(result.status, 143, result.stderr);
    else assert.equal(result.signal, "SIGKILL", result.stderr);
    assert.ok(result.actorCount >= 5);
    assert.ok(!result.files.events.includes("forbidden-publish"));
  });
}

test("EOF on the owner capability revokes the exact source group", async () => {
  const result = await run(`${roundFixture}
start_db_source_monitor
source_pid="$DB_SOURCE_MONITOR_PID"
exec {DB_SOURCE_MONITOR_CONTROL_FD}>&-
DB_SOURCE_MONITOR_CONTROL_FD=
if stop_db_source_monitor; then exit 93; fi
# The live guardian finishes its existing TERM-to-KILL retirement after the
# publisher's native wait. Observe it finitely; never signal a reaped PGID.
for ((attempt=0; attempt<40; attempt++)); do
  kill -0 -- "-$source_pid" 2>/dev/null || break
  sleep 0.05
done
kill -0 -- "-$source_pid" 2>/dev/null && exit 94
printf 'eof-retired\\n'
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "eof-retired\n");
});

for (const reason of ["source-owned-round", "source-guardian"]) {
  test(`the new closed ${reason} detail reaches the real safe reporter`, async () => {
    const result = await run(`
printf 'pgsql_source_monitor_failed:${reason}\\n' >"$TEST_ROOT/failure"
component="$(recovery_stream_guard_failure_detail "$TEST_ROOT/failure")"
recovery_report_stream_failure 1 running "guard-process:0:$component"
`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, `recovery_stream_stage:running\nrecovery_stream_status:1\nrecovery_stream_detail:guard-process:0:pgsql-source:${reason}\n`);
  });
}

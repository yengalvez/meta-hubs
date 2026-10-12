import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createMonthlyTestProcessOwner } from "../../deployment/monthly-test-process-owner.mjs";
import { nativeBashArguments, nativeShellEnvironment, resolveNativeBash } from "../recovery/native-bash.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const backup = readFileSync(new URL("../../deployment/backup-retdb.sh", import.meta.url), "utf8");
function extract(name) {
  const start = backup.indexOf(`${name}() {\n`);
  assert.notEqual(start, -1, name);
  const end = backup.indexOf("\n}\n", start);
  assert.notEqual(end, -1, name);
  return backup.slice(start, end + 3);
}
const baselineCommit = "b17c1d66ef84dfbb5369f6015ffdcb37b9c57e87";
function baselineFunctions() {
  // A pinned LOCAL historical blob, not an old backup route. Git is already
  // required by the monthly candidate gate. No provider or recovery operation.
  const source = execFileSync("git", ["show", `${baselineCommit}:deployment/lib/recovery-safety.sh`],
    { cwd: root, env: nativeShellEnvironment(), encoding: "utf8", timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
  return ["recovery_monotonic_milliseconds", "recovery_kubectl_stream_supervised"].map(name => {
    const start = source.indexOf(`${name}() {\n`), end = source.indexOf("\n}\n", start);
    assert.ok(start >= 0 && end > start, name);
    return source.slice(start, end + 3);
  }).join("\n");
}
const sourceFunctions = [...backup.matchAll(/^([a-z_]+)\(\) \{/gm)].map(match => match[1])
  .filter(name => name.startsWith("db_source_") || ["start_db_source_monitor", "stop_db_source_monitor",
    "monitor_exact_pgsql_source", "record_pgsql_source_monitor_failure", "require_backup_guard"].includes(name))
  .map(extract).join("\n");

// Use the ORIGINAL PGSQL publisher, gated W/D branches, exact native joins,
// guardian and supervisor. Only Kubernetes predicates and provider are local
// finite fixtures. No credentials, API, snapshots or changed production limits.
for (const { baseline, setupFault = false } of [{ baseline: true }, { baseline: false }, { baseline: false, setupFault: true }]) {
test(`native full PGSQL sweeps under local reader cost (${setupFault ? "partial spawn cleanup" : baseline ? "pinned RED" : "current GREEN"})`, async t => {
  const evidence = realpathSync(mkdtempSync(join(tmpdir(), "yenhubs-pgsql-supervisor-latency-")));
  chmodSync(evidence, 0o700);
  const bin = join(evidence, "bin"); mkdirSync(bin, { mode: 0o700 });
  const bash = resolveNativeBash();
  writeFileSync(join(bin, "kubectl"), `#!${bash}\nset -euo pipefail\nprintf started >"$LOCAL_EVIDENCE/provider.started"\nsleep 18 &\nwait "$!"\nprintf complete >"$LOCAL_EVIDENCE/provider.complete"\n`, { mode: 0o700 });
  const publishers = [];
  let owner, supervisor, retirement, timedOut = false, timer, setupFailureObserved = false;
  try {
  const pinnedSource = baseline ? baselineFunctions() : "";
  for (let n = 1; n < 3; n++) {
    const directory = join(evidence, `guard-${n}`); mkdirSync(directory, { mode: 0o700 });
    writeFileSync(join(directory, "failure"), "", { mode: 0o600 });
    writeFileSync(join(directory, "progress"), "1\n", { mode: 0o600 });
    const child = spawn(setupFault && n === 2 ? join(evidence, "absent-python-for-negative") : "python3", ["-I", "-c", `import os,pathlib,sys,time
p=pathlib.Path(sys.argv[1]); n=1
while True:
 n+=1; q=p/'progress.next'; q.write_text(str(n)+'\\n'); q.chmod(0o600); os.replace(q,p/'progress'); time.sleep(.1)
`, directory], { env: nativeShellEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
    const started = new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    publishers.push({ child, closed: new Promise(resolve => child.once("close", resolve)) });
    await started;
  }
  const program = String.raw`
umask 077
${sourceFunctions}
${pinnedSource}
OUTPUT_PATH="$LOCAL_EVIDENCE/output"
DUMP_STREAM_GUARD_ARGS=() PARENT_STREAM_GUARD_ARGS=()
DB_SOURCE_MONITOR_PID= DB_SOURCE_MONITOR_START_IDENTITY=
DB_SOURCE_MONITOR_STOP= DB_SOURCE_MONITOR_FAILURE= DB_SOURCE_MONITOR_PROGRESS=
DB_SOURCE_MONITOR_CONTROL_FD= DB_SOURCE_MONITOR_READ_FD= DB_SOURCE_MONITOR_ROUND_DIR=
DB_SOURCE_MONITOR_OWNED_PID= DB_SOURCE_MONITOR_OWNED_IDENTITY= DB_SOURCE_MONITOR_GROUP_PROVEN=0
COORDINATED=1 RECOVERY_OPERATION_OWNER=checkpoint-backup
RECOVERY_CONSUMER_CONTRACT_JSON=synthetic RECOVERY_SERIALIZATION_LEASE_REQUIRED=1
CHECKPOINT_RUNNER_GENERATION=durable-v2 PARENT_FREEZE_FENCE_CAPABILITY=
CHECKPOINT_DURABLE_FENCE_BASELINE_PATH=synthetic CHECKPOINT_DURABLE_FENCE_BASELINE_SHA256=synthetic
event() { printf '%s:%s\n' "$(recovery_monotonic_milliseconds)" "$1" >>"$LOCAL_EVIDENCE/sweeps"; }
recovery_require_operation_lock() { event lock; sleep .04; }
recovery_require_consumer_contract_entry() { event "consumer-$2"; sleep .04; }
require_parent_writer_monitor_capability() { event W-start; sleep .6; event W-end; }
require_parent_durable_monitor_capability() { event D-start; sleep .9; event D-end; }
require_exact_pgsql_source_now() { event pgsql; sleep .15; }
eval "$(declare -f recovery_write_stream_guard_progress | sed '1s/recovery_write_stream_guard_progress/original_progress/')"
recovery_write_stream_guard_progress() { original_progress "$@" && event "publish-$2"; }
eval "$(declare -f recovery_monotonic_milliseconds | sed '1s/recovery_monotonic_milliseconds/original_clock/')"
recovery_monotonic_milliseconds() {
  # Ordinary cold native-reader/scheduler cost, not a longer guard allowance.
  if [[ "@{stream_diagnostic_stage:-}" == running ]]; then sleep .04; fi
  original_clock
}
eval "$(declare -f recovery_stream_guard_process_is_healthy | sed '1s/recovery_stream_guard_process_is_healthy/original_guard_health/')"
recovery_stream_guard_process_is_healthy(){
  if [[ "$#" == 3 && "@{stream_diagnostic_stage:-}" == running ]]; then sleep 1.4; fi
  original_guard_health "$@"
}
eval "$(declare -f recovery_report_stream_failure | sed '1s/recovery_report_stream_failure/original_report/')"
recovery_report_stream_failure(){
  original_report "$@"
  if [[ "@{2:-}" == running ]]; then
    printf 'now=%s\naccepted=%s\nbound=%s\nlast_observation=%s\ndisk=%s\n' \
      "$(original_clock)" "@{guard_last_progress[0]}" "@{guard_last_progress_milliseconds[0]}" \
      "@{guard_last_observation_milliseconds[0]}" "$(<"@{guard_progress_markers[0]}")" \
      >"$LOCAL_EVIDENCE/rejection-clock"
  fi
}
trap 'stop_db_source_monitor revoke || :' EXIT
start_db_source_monitor
for n in 0 1; do
  pid="@{LOCAL_PUBLISHERS[$n]}"
  identity="$(recovery_process_start_identity "$pid")"
  PARENT_STREAM_GUARD_ARGS+=(--guard-process "$pid" "$identity" "$LOCAL_EVIDENCE/guard-$((n+1))/failure" "$LOCAL_EVIDENCE/guard-$((n+1))/progress" 10)
done
DUMP_STREAM_GUARD_ARGS+=("@{PARENT_STREAM_GUARD_ARGS[@]}")
result=0
recovery_kubectl_stream_supervised 0 30 "@{DUMP_STREAM_GUARD_ARGS[@]}" -- exec local-only || result=$?
printf '%s\n' "$result" >"$LOCAL_EVIDENCE/supervisor.status"
stop_db_source_monitor || result=1
exit "$result"
`.replaceAll("@{", "${");
    const completion = new Promise(resolve => {
      supervisor = spawn(bash, nativeBashArguments(join(root, "deployment/lib/recovery-safety.sh"),
        `LOCAL_PUBLISHERS=(${publishers.map(({ child }) => child.pid).join(" ")})\n${program}`), {
        cwd: root, env: { ...nativeShellEnvironment(), PATH: `${bin}:${dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin`,
          LOCAL_EVIDENCE: evidence, EXPECTED_KUBE_CONTEXT: "local-fixture-no-api" }, stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "", stderr = "", error;
      supervisor.stdout.on("data", bytes => { stdout += bytes; });
      supervisor.stderr.on("data", bytes => { stderr += bytes; });
      supervisor.once("error", value => { error = value; });
      supervisor.once("close", (code, signal) => resolve({ code, signal, stdout, stderr, error }));
    });
    owner = createMonthlyTestProcessOwner(supervisor, { pollMilliseconds: 200 });
    await owner.ready;
    timer = setTimeout(() => { timedOut = true; void owner.retire(); }, 120000);
    const result = await completion;
    writeFileSync(join(evidence, "result.json"), JSON.stringify(result) + "\n", { mode: 0o600 });
    t.diagnostic(`local PGSQL/supervisor evidence: ${evidence}`);
    assert.ifError(result.error);
    assert.equal(timedOut, false, "the finite fixture deadline is failure, never acceptance");
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.code, baseline ? 1 : 0, result.stderr);
    if (baseline) {
      assert.match(result.stderr, /recovery_stream_stage:running\n/);
      assert.match(result.stderr, /cancellation-reserve:[0-2]:remaining-ms:-?\d+:required-ms:2000/);
      assert.equal(existsSync(join(evidence, "provider.complete")), false);
    } else assert.equal(readFileSync(join(evidence, "provider.complete"), "utf8"), "complete");
    const events = readFileSync(join(evidence, "sweeps"), "utf8").trim().split("\n");
    assert.ok(events.filter(row => row.includes(":publish-")).length >= 3);
    for (const required of ["lock", "consumer-reticulum", "consumer-pgbouncer", "consumer-pgbouncer-t",
      "consumer-bot-orchestrator", "consumer-coturn", "W-end", "D-end", "pgsql"]) {
      assert.ok(events.some(row => row.endsWith(`:${required}`)), required);
    }
    const absent = await owner.observeFresh();
    writeFileSync(join(evidence, "native-absence.json"), JSON.stringify(absent) + "\n", { mode: 0o600 });
    assert.equal(absent.unproven, false);
    assert.equal(absent.tracking, 0);
    assert.deepEqual(absent.members, []);
    assert.deepEqual(absent.unattributed, []);
  } catch (error) {
    if (!setupFault) throw error;
    assert.equal(error.code, "ENOENT");
    assert.equal(publishers.length, 2);
    setupFailureObserved = true;
  } finally {
    clearTimeout(timer);
    try {
      if (owner) { try { retirement = await owner.retire(); } finally { owner.close(); } }
      else if (supervisor) supervisor.kill("SIGTERM");
    } finally {
      for (const { child } of publishers) child.kill("SIGTERM");
      await Promise.all(publishers.map(({ closed }) => closed));
    }
    if (owner) assert.equal(retirement.absenceVerified, true, "cleanup cannot grant test acceptance");
  }
  if (setupFault) {
    assert.equal(setupFailureObserved, true);
    assert.equal(publishers[0].child.signalCode, "SIGTERM", "original first child must close natively after partial setup failure");
    assert.equal(existsSync(join(evidence, "provider.started")), false);
  } else assert.ok(existsSync(join(evidence, "sweeps")));
});
}

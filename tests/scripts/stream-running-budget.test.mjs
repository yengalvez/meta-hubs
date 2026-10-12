import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createMonthlyTestProcessOwner } from "../../deployment/monthly-test-process-owner.mjs";
import { nativeBashArguments, nativeShellEnvironment, resolveNativeBash } from "../recovery/native-bash.mjs";

const source = readFileSync(new URL("../../deployment/lib/recovery-safety.sh", import.meta.url), "utf8");
function extract(name) {
  const start = source.indexOf(`    ${name}() {\n`);
  assert.notEqual(start, -1, name);
  const end = source.indexOf("\n    }\n", start);
  assert.notEqual(end, -1, name);
  return source.slice(start, end + 7);
}
const functions = ["stream_record_diagnostic", "require_reaped_stream_guard_freshness",
  "observe_supervised_stream_child_completion", "observe_running_stream_guard_progress",
  "supervised_stream_guards_are_continuously_healthy", "supervised_stream_guard_remaining_milliseconds",
  "supervised_stream_guard_has_cancellation_reserve"];

// Run the actual Bash observer, with only external predicate latency and the
// publisher/clock simulated. No API, credentials, real snapshot or retries.
function simulate({ fault = "none", cost = 1400, rounds = 8 } = {}) {
  const harness = String.raw`
set -u
fault="$1" cost="$2" rounds="$3"
clock=0 checks=0 completed=0 status=0 job_checks=0
stream_is_gated=0 stream_child_reaped=0 stream_diagnostic_stage=running stream_diagnostic_detail=
stream_child_completion_observed=0
stream_pid=41 stream_start_identity=exact
post_stream_guard_deadline_failed=0 supervised_stream_guard_failure_kind=
guard_cancel_reserve_milliseconds=2000
guard_pids=(11 12 13) guard_start_identities=(x x x)
guard_failure_markers=(/fixture/f0 /fixture/f1 /fixture/f2)
guard_ready_markers=(/fixture/r0 /fixture/r1 /fixture/r2)
guard_progress_markers=(/fixture/p0 /fixture/p1 /fixture/p2)
guard_authority_paths=(/fixture/r0.authority.json /fixture/r1.authority.json /fixture/r2.authority.json)
guard_authority_sha256s=(synthetic synthetic synthetic)
guard_maximum_stale_seconds=(10 10 10)
guard_last_progress=(1 1 1) guard_last_progress_milliseconds=(0 0 0)
guard_last_observation_milliseconds=(0 0 0)
supervised_stream_guard_remaining_milliseconds_value= supervised_stream_guard_remaining_index=
supervised_stream_child_is_running(){
  job_checks=$((job_checks+1))
  [[ "$fault" != completed && ( "$fault" != regression-completed || "$job_checks" == 1 ) ]]
}
recovery_monotonic_milliseconds(){ [[ "$fault" != clock ]] || return 1; printf '%s\n' "$clock"; }
recovery_stream_guard_process_is_healthy(){
  checks=$((checks+1)); clock=$((clock+cost))
  [[ "$fault" != process && "$fault" != failure-marker ]]
}
recovery_stream_guard_failure_detail(){ [[ "$fault" == failure-marker ]] && printf 'identity:changed\n'; }
recovery_read_private_file_once(){ [[ "$fault" != hash ]]; }
recovery_stream_guard_progress_value(){
  local number="@{1##*/p}"
  [[ "$fault" != read ]] || return 1
  if [[ "$fault" == regression || "$fault" == regression-completed ]]; then printf '0\n'
  elif [[ "$number" == 0 && "$fault" == frozen ]]; then printf '1\n'
  elif [[ "$number" == 0 && "$fault" == late && "$clock" -le 10000 ]]; then printf '1\n'
  else printf '%s\n' "$((clock/200+1))"; fi
}
for ((round=0;round<rounds;round++)); do
  clock=$((clock+1000))
  supervised_stream_guards_are_continuously_healthy || { status=1; break; }
  [[ "$stream_child_completion_observed" == 0 ]] || break
  supervised_stream_guard_has_cancellation_reserve || { status=1; break; }
  completed=$((completed+1))
done
printf 'status=%s\nclock=%s\nchecks=%s\ncompleted=%s\nremaining=%s\ndiagnostic=%s\n' \
  "$status" "$clock" "$checks" "$completed" "$supervised_stream_guard_remaining_milliseconds_value" "$stream_diagnostic_detail"
(IFS=,; printf 'bounds=%s\nprogress=%s\n' "@{guard_last_progress_milliseconds[*]}" "@{guard_last_progress[*]}")
printf 'handoff=%s\n' "$stream_child_completion_observed"
`.replaceAll("@{", "${");
  const result = spawnSync("bash", ["-c", functions.map(extract).join("\n") + "\n" + harness,
    "fixture", fault, String(cost), String(rounds)], { encoding: "utf8", timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return Object.fromEntries(result.stdout.trim().split("\n").map(row => {
    const at = row.indexOf("="), value = row.slice(at + 1);
    return [row.slice(0, at), /^-?\d+$/.test(value) ? Number(value) : value];
  }));
}

test("running supervisor does not consume healthy three-guard freshness with serial observation cost", () => {
  const result = simulate();
  assert.equal(result.status, 0, JSON.stringify(result));
  assert.equal(result.completed, 8);
  assert.equal(result.checks, 24, "all identity/failure/authority predicates still run");
  assert.ok(result.remaining > 2000);
});

test("completed child hands off before serial predicates, without crediting counters or claiming acceptance", () => {
  const result = simulate({ fault: "completed" });
  assert.equal(result.status, 0, JSON.stringify(result));
  assert.equal(result.handoff, 1);
  assert.equal(result.completed, 0);
  assert.equal(result.checks, 0);
  assert.equal(result.bounds, "0,0,0");
  assert.equal(result.progress, "1,1,1");
});

test("completion cannot hide an already observed counter regression", () => {
  const result = simulate({ fault: "regression-completed" });
  assert.equal(result.status, 1);
  assert.equal(result.handoff, 0);
  assert.equal(result.progress, "1,1,1");
  assert.equal(result.diagnostic, "guard-progress-regression:0");
});

for (const [clock, tableCost, pending, expected] of [[7900, 0, 0, 0], [8100, 0, 0, 1],
  [10000, 0, 0, 1], [7900, 200, 0, 1], [7900, 0, 1, 0],
  [7900, 200, 1, 1], [7900, 2200, 1, 1]]) {
  test(`completion handoff never waives reserve (${clock},${tableCost},${pending})`, () => {
    const script = String.raw`
set -u
clock="$1" table_cost="$2" pending="$3"
stream_child_completion_observed=0 stream_diagnostic_detail=
guard_cancel_reserve_milliseconds=2000 guard_pids=(11 12 13)
guard_last_progress_milliseconds=(0 0 0) guard_maximum_stale_seconds=(10 10 10)
recovery_monotonic_milliseconds(){ printf '%s\n' "$clock"; }
supervised_stream_child_is_running(){ clock=$((clock+table_cost)); [[ "$pending" == 1 ]]; }
result=0
observe_supervised_stream_child_completion || result=$?
printf '%s %s\n' "$result" "$stream_child_completion_observed"
`;
    const result = spawnSync("bash", ["-c", ["stream_record_diagnostic",
      "supervised_stream_guard_remaining_milliseconds", "supervised_stream_guard_has_cancellation_reserve",
      "observe_supervised_stream_child_completion"].map(extract).join("\n") + script,
    "fixture", String(clock), String(tableCost), String(pending)], { encoding: "utf8", timeout: 5000 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${expected} ${expected === 0 && pending === 0 ? 1 : 0}\n`);
  });
}

for (const jobControl of [false, true]) test(`native stopped child remains pending (job control ${jobControl})`, () => {
  const script = String.raw`
set -u
[[ "$1" != true ]] || set -m
python3 -I -c 'import os,signal,time; os.kill(os.getpid(), signal.SIGSTOP); time.sleep(20)' &
stream_pid=$!
trap 'kill -CONT "$stream_pid" 2>/dev/null || :; kill -TERM "$stream_pid" 2>/dev/null || :; wait "$stream_pid" 2>/dev/null || :' EXIT
for ((i=0;i<100;i++)); do
  [[ "$(/bin/ps -o stat= -p "$stream_pid")" == *T* ]] && break
  sleep .01
done
[[ "$(/bin/ps -o stat= -p "$stream_pid")" == *T* ]] || exit 2
supervised_stream_child_is_running || exit 3
`;
  const result = spawnSync(resolveNativeBash(), ["--noprofile", "--norc", "-c",
    extract("supervised_stream_child_is_running") + script, "fixture", String(jobControl)],
  { env: nativeShellEnvironment(), encoding: "utf8", timeout: 5000 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
});

for (const fault of ["frozen", "late", "process", "failure-marker", "hash", "read", "regression", "clock"]) {
  test(`running supervisor rejects ${fault} without granting fresh authority`, () => {
    const result = simulate({ fault });
    assert.equal(result.status, 1, JSON.stringify(result));
    if (["frozen", "late"].includes(fault)) {
      assert.equal(result.bounds.split(",")[0], "0");
      assert.equal(result.progress.split(",")[0], "1");
      assert.ok(result.clock <= 10000, JSON.stringify(result));
    }
  });
}

for (const freeze of [false, true]) test(`native three-guard observer ${freeze ? "revokes a frozen guard within 10 seconds" : "completes a healthy local child"} under serial predicate latency`, async t => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const evidence = realpathSync(mkdtempSync(join(tmpdir(), "yenhubs-running-budget-")));
  chmodSync(evidence, 0o700);
  const bin = join(evidence, "bin"); mkdirSync(bin, { mode: 0o700 });
  const publisher = String.raw`
import os, pathlib, sys, time
root = pathlib.Path(sys.argv[1]); until = time.monotonic() + 90; counter = 1
started = pathlib.Path(sys.argv[2]); freeze = sys.argv[3] == 'yes'
while time.monotonic() < until:
    if freeze and started.exists():
        frozen = root / 'frozen'
        if not frozen.exists():
            frozen.write_text(str(time.clock_gettime_ns(time.CLOCK_MONOTONIC) // 1000000))
        time.sleep(.1)
        continue
    counter += 1
    next_path = root / 'progress.next'
    next_path.write_text(str(counter) + '\n'); next_path.chmod(0o600)
    os.replace(next_path, root / 'progress')
    time.sleep(.1)
`;
  const bash = resolveNativeBash();
  writeFileSync(join(bin, "kubectl"), `#!${bash}\nset -euo pipefail\nsleep 16 &\ndescendant=$!\nprintf '%s %s\\n' "$$" "$descendant" >"$LOCAL_EVIDENCE/child-processes"\nprintf 'start\\n' >"$LOCAL_EVIDENCE/child-start"\nwait "$descendant"\nprintf 'complete\\n' >"$LOCAL_EVIDENCE/child-complete"\n`, { mode: 0o700 });
  const publishers = [];
  let owner, supervisor;
  try {
    for (let i = 0; i < 3; i++) {
      const path = join(evidence, `guard-${i}`); mkdirSync(path, { mode: 0o700 });
      writeFileSync(join(path, "failure"), "", { mode: 0o600 });
      writeFileSync(join(path, "progress"), "1\n", { mode: 0o600 });
      const child = spawn("python3", ["-I", "-c", publisher, path, join(evidence, "child-start"), freeze && i === 0 ? "yes" : "no"], {
        env: nativeShellEnvironment(), stdio: ["ignore", "pipe", "pipe"]
      });
      const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
      publishers.push({ child, closed });
    }
    const program = String.raw`
eval "$(declare -f recovery_stream_guard_process_is_healthy | sed '1s/recovery_stream_guard_process_is_healthy/original_guard_health/')"
recovery_stream_guard_process_is_healthy(){
  if [[ "$#" == 3 && "@{stream_diagnostic_stage:-}" == running ]]; then sleep 1.4; fi
  original_guard_health "$@"
}
args=()
for n in 0 1 2; do
  pid="@{LOCAL_PUBLISHERS[$n]}"
  identity="$(recovery_process_start_identity "$pid")"
  args+=(--guard-process "$pid" "$identity" "$LOCAL_EVIDENCE/guard-$n/failure" "$LOCAL_EVIDENCE/guard-$n/progress" 10)
done
result=0
recovery_kubectl_stream_supervised 0 30 "@{args[@]}" -- exec local-only || result=$?
exit "$result"
`.replaceAll("@{", "${");
    let closedResult;
    const completion = new Promise(resolve => {
      supervisor = spawn(bash, nativeBashArguments(join(root, "deployment/lib/recovery-safety.sh"),
        `LOCAL_PUBLISHERS=(${publishers.map(({ child }) => child.pid).join(" ")})\n${program}`), {
        cwd: root, env: { ...nativeShellEnvironment(), PATH: `${bin}:${dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin`,
          EXPECTED_KUBE_CONTEXT: "local-fixture-no-api", LOCAL_EVIDENCE: evidence },
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "", stderr = "", error;
      supervisor.stdout.on("data", bytes => { stdout += bytes; });
      supervisor.stderr.on("data", bytes => { stderr += bytes; });
      supervisor.once("error", value => { error = value; });
      supervisor.once("close", (code, signal) => {
        closedResult = { code, signal, stdout, stderr, error };
        resolve(closedResult);
      });
    });
    owner = createMonthlyTestProcessOwner(supervisor, { pollMilliseconds: 200 });
    await owner.ready;
    const launchDeadline = performance.now() + 60000;
    while (!existsSync(join(evidence, "child-start")) && !closedResult && performance.now() < launchDeadline) await delay(100);
    assert.ok(existsSync(join(evidence, "child-start")), `local child did not start: ${closedResult?.stderr ?? "deadline"}`);
    const fixturePids = readFileSync(join(evidence, "child-processes"), "utf8").trim().split(" ").map(Number);
    assert.equal(fixturePids.length, 2);
    const running = await owner.observe();
    const fixtureIdentities = fixturePids.map(pid => running.members.find(row => row.pid === pid));
    assert.ok(fixtureIdentities.every(Boolean), "bind the local child and its sleep descendant before acceptance");
    const result = await completion;
    writeFileSync(join(evidence, "result.json"), JSON.stringify(result) + "\n", { mode: 0o600 });
    t.diagnostic(`local native evidence: ${evidence}`);
    assert.ifError(result.error);
    assert.equal(result.code, freeze ? 1 : 0, result.stderr);
    assert.equal(result.signal, null);
    // Observe native identities BEFORE test cleanup. A return timestamp or an
    // absent completion marker cannot prove the supervised descendants stopped.
    const absent = await owner.observe();
    assert.equal(absent.unproven, false);
    assert.equal(absent.tracking, 0);
    assert.deepEqual(absent.members, []);
    assert.deepEqual(absent.unattributed, []);
    const clock = spawnSync("python3", ["-I", "-c", "import time; print(time.clock_gettime_ns(time.CLOCK_MONOTONIC) // 1000000)"], {
      env: nativeShellEnvironment(), encoding: "utf8", timeout: 5000
    });
    assert.ifError(clock.error);
    assert.equal(clock.status, 0, clock.stderr);
    const absenceObservedAt = Number(clock.stdout.trim());
    assert.ok(Number.isSafeInteger(absenceObservedAt));
    writeFileSync(join(evidence, "native-absence.json"), JSON.stringify({ fixtureIdentities, absent, absenceObservedAt }) + "\n", { mode: 0o600 });
    if (freeze) {
      assert.ok(!existsSync(join(evidence, "child-complete")), "failed capture never completes");
      const frozenAt = Number(readFileSync(join(evidence, "guard-0/frozen"), "utf8"));
      assert.ok(absenceObservedAt - frozenAt > 0 && absenceObservedAt - frozenAt < 10000,
        `native descendant absence observed after ${absenceObservedAt - frozenAt}ms`);
      assert.match(result.stderr, /recovery_stream_stage:running\n/);
      assert.match(result.stderr, /cancellation-reserve:0:remaining-ms:-?\d+:required-ms:2000/);
    } else {
      assert.equal(readFileSync(join(evidence, "child-complete"), "utf8"), "complete\n");
    }
  } finally {
    // Cleanup is unconditional but can never turn a failed absence/deadline
    // assertion above into acceptance. Retire only identity-bound local lineage.
    let retirement;
    try {
      if (owner) {
        try { retirement = await owner.retire(); }
        finally { owner.close(); }
        writeFileSync(join(evidence, "fixture-retirement.json"), JSON.stringify(retirement) + "\n", { mode: 0o600 });
      } else if (supervisor) supervisor.kill("SIGTERM");
    } finally {
      for (const { child } of publishers) child.kill("SIGTERM");
      await Promise.all(publishers.map(({ closed }) => closed));
    }
    if (owner) assert.equal(retirement.absenceVerified, true, "local fixture cleanup must be proven independently of test outcome");
  }
});

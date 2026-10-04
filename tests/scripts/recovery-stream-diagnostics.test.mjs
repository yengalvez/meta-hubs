import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const library = readFileSync(new URL("../../deployment/lib/recovery-safety.sh", import.meta.url), "utf8");
function fn(name, indent = "") {
  const start = library.indexOf(`${indent}${name}() {\n`);
  assert.notEqual(start, -1, name);
  const end = library.indexOf(`\n${indent}}\n`, start);
  assert.notEqual(end, -1, name);
  return library.slice(start, end + indent.length + 3);
}
const reporter = fn("recovery_report_stream_failure");
function run(script, env = {}) {
  const result = spawnSync("bash", ["-c", `${reporter}\n${script}`], {
    cwd: root, encoding: "utf8", timeout: 5000,
    env: { ...process.env, RECOVERY_STREAM_DIAGNOSTIC_CONTEXT: "", ...env }
  });
  assert.ifError(result.error);
  assert.equal(result.stdout, "", "archive stdout must contain no diagnostic");
  return result;
}

test("normal backup emits the exact safe reason without a diagnostic flag", () => {
  const result = run('recovery_report_stream_failure 1 post-audit "guard-stale:0:counter:5:age-ms:12000:observation-ms:12345"');
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "recovery_stream_stage:post-audit\nrecovery_stream_status:1\nrecovery_stream_detail:guard-stale:0:counter:5:age-ms:12000:observation-ms:12345\n");
});

test("legacy diagnostic labels remain compatible, including real command status", () => {
  const result = run("recovery_report_stream_failure 137 command", { RECOVERY_STREAM_DIAGNOSTIC_CONTEXT: "database-restore" });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "database_restore_stream_stage:command\ndatabase_restore_stream_status:137\n");
});

test("success is silent and does not invent a failure", () => {
  const result = run("recovery_report_stream_failure 0 running sentinel");
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

for (const detail of ["/private/secret-sentinel", "guard-process:0:private-sentinel", "EOF token=private-sentinel", "command:1\nprivate-sentinel"]) {
  test(`untrusted detail is never printed (${JSON.stringify(detail)})`, () => {
    const result = run('recovery_report_stream_failure 1 "$TEST_STAGE" "$TEST_DETAIL"', {
      TEST_STAGE: "private-stage-sentinel", TEST_DETAIL: detail,
      RECOVERY_STREAM_DIAGNOSTIC_CONTEXT: "private-context-sentinel"
    });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "recovery_stream_stage:unknown\nrecovery_stream_status:1\nrecovery_stream_detail:redacted\n");
  });
}

for (const detail of ["guard-stale:0", "guard-process:1:watch:watch_terminated", "guard-refresh-timeout:0:-8:counter:3:age-ms:10008:observation-ms:777", "lease-window:0:1900", "cancellation-reserve", "guard-progress-regression:2"]) {
  test(`allowlisted failure remains actionable: ${detail}`, () => {
    const result = run('recovery_report_stream_failure 1 running "$TEST_DETAIL"', { TEST_DETAIL: detail });
    assert.equal(result.status, 0);
    assert.match(result.stderr, /recovery_stream_stage:running\nrecovery_stream_status:1\n/);
    assert.ok(result.stderr.endsWith(`recovery_stream_detail:${detail}\n`));
  });
}

test("early argument failure reports safely and preserves its exit code", () => {
  const result = run('source deployment/lib/recovery-safety.sh; recovery_kubectl_stream_supervised invalid 100 --exec private-sentinel');
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "recovery_stream_stage:arguments\nrecovery_stream_status:2\nrecovery_stream_detail:arguments\n");
});

test("the recovery library refuses unsupported Bash before initializing capabilities", () => {
  const shell = process.platform === "darwin" ? "/bin/bash" : "bash";
  const result = spawnSync(shell, ["-c", 'RECOVERY_MATERIALIZED_DIR=unchanged; source deployment/lib/recovery-safety.sh; status=$?; printf "%s:%s:%s\\n" "$status" "$RECOVERY_MATERIALIZED_DIR" "${BASH_VERSINFO[0]}"'], {
    cwd: root, encoding: "utf8", timeout: 5000
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  if (process.platform === "darwin") {
    assert.equal(result.stdout, "2:unchanged:3\n");
    assert.equal(result.stderr, "recovery_requires_bash_4_1_or_newer\n");
    const executed = spawnSync(shell, ["deployment/lib/recovery-safety.sh"], {
      cwd: root, encoding: "utf8", timeout: 5000
    });
    assert.ifError(executed.error);
    assert.equal(executed.status, 2);
    assert.equal(executed.stdout, "");
    assert.equal(executed.stderr, "recovery_requires_bash_4_1_or_newer\n");
  } else {
    assert.match(result.stdout, /^0::[4-9][0-9]*\n$/);
    assert.equal(result.stderr, "");
  }
});

test("EXIT reporter preserves the first cause and original status", () => {
  const result = run(`${fn("supervised_stream_audit_cleanup", "    ")}\n${fn("report_stream_diagnostic", "    ")}\nguard_audit_control_fd=\nguard_audit_read_fd=\nguard_audit_pid=\nstream_diagnostic_stage=refresh\nstream_diagnostic_detail=lease-check\ntrap report_stream_diagnostic EXIT\nexit 37`);
  assert.equal(result.status, 37);
  assert.equal(result.stderr, "recovery_stream_stage:refresh\nrecovery_stream_status:37\nrecovery_stream_detail:lease-check\n");
});

function pgsqlMarkerReport(value, { mode = 0o600, link = false, first = "" } = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "yenhubs-pgsql-detail-"));
  try {
    const marker = join(fixture, "failure");
    writeFileSync(marker, value, { mode: 0o600 });
    chmodSync(marker, mode);
    if (link) symlinkSync(marker, join(fixture, "link"));
    return run(`${fn("recovery_runner_watch_marker_is_exact")}
${fn("recovery_pgsql_source_monitor_failure_code_is_exact")}
${fn("recovery_stream_guard_failure_detail")}
${fn("stream_record_diagnostic", "    ")}
stream_diagnostic_detail="$TEST_FIRST"
if component="$(recovery_stream_guard_failure_detail "$TEST_MARKER")"; then
  stream_record_diagnostic "guard-process:0:$component"
else
  stream_record_diagnostic guard-process:0
fi
recovery_report_stream_failure 1 running "$stream_diagnostic_detail"
`, { TEST_MARKER: link ? join(fixture, "link") : marker, TEST_FIRST: first });
  } finally {
    rmSync(fixture, { recursive: true });
  }
}

const pgsqlFailureCodes = [
  "serialization", "cluster-identity", "pvc-identity", "operation-lock", "backup-guard",
  "consumer-reticulum", "consumer-pgbouncer", "consumer-pgbouncer-t", "consumer-bot-orchestrator", "consumer-coturn",
  "parent-writer", "freeze-fence", "runner-quiescence", "durable-authority", "durable-process", "durable-progress",
  "durable-baseline", "active-fence", "pgsql-source", "progress_publish_failed"
];
for (const code of pgsqlFailureCodes) {
  test(`the real private PGSQL marker preserves its closed component ${code} through the reporter`, () => {
    const result = pgsqlMarkerReport(`pgsql_source_monitor_failed:${code}\n`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, `recovery_stream_stage:running\nrecovery_stream_status:1\nrecovery_stream_detail:guard-process:0:pgsql-source:${code}\n`);
  });
}
for (const value of [
  "pgsql_source_monitor_failed:unknown-secret-sentinel",
  "pgsql_source_monitor_failed:/private/secret-sentinel",
  "pgsql_source_monitor_failed:serialization\nsecret-sentinel",
  "serialization"
]) {
  test(`the PGSQL marker rejects an unrecognized or multiline payload ${JSON.stringify(value)}`, () => {
    const result = pgsqlMarkerReport(value);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "recovery_stream_stage:running\nrecovery_stream_status:1\nrecovery_stream_detail:guard-process:0\n");
  });
}
for (const options of [{ mode: 0o644 }, { link: true }]) {
  test(`the PGSQL detail parser rejects unsafe marker metadata ${JSON.stringify(options)}`, () => {
    const result = pgsqlMarkerReport("pgsql_source_monitor_failed:serialization\n", options);
    assert.equal(result.status, 0);
    assert.ok(result.stderr.endsWith("recovery_stream_detail:guard-process:0\n"));
  });
}
test("a later PGSQL component never overwrites the first stale guard cause", () => {
  const result = pgsqlMarkerReport("pgsql_source_monitor_failed:serialization\n", { first: "guard-stale:0" });
  assert.equal(result.status, 0);
  assert.ok(result.stderr.endsWith("recovery_stream_detail:guard-stale:0\n"));
  assert.ok(!result.stderr.includes("serialization"));
});

for (const commandStatus of [0, 1, 37, 143]) {
  test(`the real supervised local child retains command exit ${commandStatus} and archive stdout`, () => {
    const fixture = mkdtempSync(join(tmpdir(), "yenhubs-stream-status-"));
    try {
      // The isolated Python launcher invokes only this owned local executable.
      // No kubectl binary, cluster, credentials or timing overrides are used.
      writeFileSync(join(fixture, "kubectl"), '#!/bin/bash\nprintf "archive-sentinel"\nexit "$TEST_COMMAND_STATUS"\n', { mode: 0o700 });
      const result = spawnSync("bash", ["-c", "set -euo pipefail; source deployment/lib/recovery-safety.sh; recovery_kubectl_stream 10 -- exec local-fixture"], {
        cwd: root, encoding: "utf8", timeout: 20000,
        env: { ...process.env, PATH: `${fixture}:${process.env.PATH}`, EXPECTED_KUBE_CONTEXT: "fixture-context",
          RECOVERY_STREAM_DIAGNOSTIC_CONTEXT: "", TEST_COMMAND_STATUS: String(commandStatus) }
      });
      assert.ifError(result.error);
      assert.equal(result.status, commandStatus, result.stderr);
      assert.equal(result.stdout, "archive-sentinel");
      assert.equal(result.stderr, commandStatus === 0 ? "" :
        `recovery_stream_stage:command\nrecovery_stream_status:${commandStatus}\nrecovery_stream_detail:command-exit\n`);
    } finally {
      rmSync(fixture, { recursive: true });
    }
  });
}

const storageSource = readFileSync(new URL("../../deployment/backup-ret-storage-quiesced.sh", import.meta.url), "utf8");
const pipelineStart = storageSource.indexOf("if recovery_kubectl_stream_guarded 3600 \\\n");
const pipelineEnd = storageSource.indexOf('STORAGE_FAILURE_STAGE="stream-boundary"', pipelineStart);
assert.ok(pipelineStart >= 0 && pipelineEnd > pipelineStart, "exact production pipeline block found");
const pipeline = storageSource.slice(pipelineStart, pipelineEnd);
for (const [supervisorStatus, compressorStatus] of [[0, 0], [37, 0], [0, 9], [37, 9]]) {
  test(`storage pipeline distinguishes supervisor ${supervisorStatus} from compressor ${compressorStatus}`, () => {
    const result = spawnSync("/bin/bash", ["-c", `set -euo pipefail
PARENT_STREAM_GUARD_ARGS=(fixture-parent) LOCAL_STORAGE_STREAM_GUARD_ARGS=(fixture-local)
NAMESPACE=fixture HELPER_POD=local PARTIAL_PATH=/dev/null
recovery_kubectl_stream_guarded(){ printf archive; return ${supervisorStatus}; }
gzip(){ command cat >/dev/null; return ${compressorStatus}; }
${pipeline}
printf 'status=%s supervisor=%s compressor=%s\\n' "$archive_status" "${'${archive_pipeline_status[0]}'}" "${'${archive_pipeline_status[1]}'}"
`], { cwd: root, encoding: "utf8", timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, supervisorStatus || compressorStatus ?
      `storage_backup_stream_exit:supervisor=${supervisorStatus} compressor=${compressorStatus}\n` : "");
    assert.equal(result.stdout, `status=${compressorStatus || supervisorStatus} supervisor=${supervisorStatus} compressor=${compressorStatus}\n`);
  });
}

// Pure qualification of the test-only origin oracle; this never invokes the
// native recovery harness, publishers, supervisors, API fixture or clocks.
const recoveryHarness = readFileSync(new URL("../recovery/test-recovery-safety.sh", import.meta.url), "utf8");
const originStart = recoveryHarness.indexOf("verify_stream_guard_freshness_origin_trace() {\n");
const originEnd = recoveryHarness.indexOf("\n}\n", originStart);
assert.ok(originStart >= 0 && originEnd > originStart);
const originValidator = recoveryHarness.slice(originStart, originEnd + 3);

function freshnessOriginFixture(kind = "observer") {
  const publishers = Array.from({ length: 3 }, (_, guard) => {
    const rows = [{ event: "start", guard, pid: 100 + guard, counter: 1, at_ms: 1000 }];
    const end = kind === "healthy" ? 3400 : kind === "publisher" && guard === 2 ? 4000 : 15800;
    let counter = 1;
    for (let before_ms = 1200; before_ms <= end; before_ms += 200) {
      rows.push({ event: "publish", guard, pid: 100 + guard, counter: ++counter, before_ms, after_ms: before_ms + 1 });
    }
    if (kind === "publisher" && guard === 2) {
      rows.push({ event: "pause-start", guard, pid: 102, counter, at_ms: 4100 });
    }
    rows.push({ event: "stop", guard, pid: 100 + guard, counter, at_ms: kind === "healthy" ? 3500 : 16000 });
    return rows;
  });
  const read = (guard, before_ms, { foreground = true, counter = Math.floor((before_ms - 1000) / 200) + 1, observation_ms = before_ms - 5 } = {}) => ({
    event: "read", guard, before_ms, after_ms: before_ms + 5, counter, status: 0,
    reader: foreground ? "foreground" : "other", stage: foreground ? "post-audit" : "guard-baseline",
    observation_ms: foreground ? observation_ms : null
  });
  const readers = [0, 1, 2].map(guard => read(guard, 1100 + guard * 10, { foreground: false, counter: 1 }));
  readers.push(...[0, 1, 2].map(guard => read(guard, 3000 + guard * 20)));
  if (kind === "observer") {
    readers.push({ event: "observer-delay", guard: 0, before_ms: 4000, after_ms: 15500,
      reader: "foreground", stage: "post-audit", reaped: 1, gated: 0, handles_empty: true });
    readers.push(read(0, 15510, { observation_ms: 3995 }));
  } else if (kind === "publisher") {
    for (const time of [5000, 6500]) {
      readers.push(...[0, 1, 2].map(guard => read(guard, time + guard * 20,
        guard === 2 ? { counter: 16 } : {})));
    }
  }
  readers.push({ event: "supervisor-stop", at_ms: kind === "healthy" ? 3300 : 15600, status: kind === "healthy" ? 0 : 1 });
  return { publishers, readers, kind,
    log: kind === "healthy" ? "" : `database_restore_stream_stage:post-audit\ndatabase_restore_stream_status:1\ndatabase_restore_stream_detail:guard-stale:${kind === "publisher" ? "2:counter:16:age-ms:10100:observation-ms:6535" : "0:counter:11:age-ms:14000:observation-ms:2995"}\n` };
}

function qualifyFreshnessOrigin(fixture, alterFiles = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), "yenhubs-origin-oracle-"));
  try {
    const observations = join(directory, "observations");
    mkdirSync(observations);
    const encode = rows => `${rows.map(row => JSON.stringify(row)).join("\n")}\n`;
    fixture.publishers.forEach((rows, guard) => writeFileSync(join(observations, `publisher-${guard}.jsonl`), encode(rows)));
    writeFileSync(join(observations, "readers.jsonl"), encode(fixture.readers));
    writeFileSync(join(directory, "supervisor.log"), fixture.log);
    alterFiles(observations);
    const result = spawnSync("bash", ["-c", `${originValidator}\nverify_stream_guard_freshness_origin_trace "$1" "$2" "$3"`, "_",
      `post-audit-${fixture.kind === "observer" ? "observer-delay" : fixture.kind === "publisher" ? "expired-progress" : "healthy"}`,
      directory, fixture.kind === "healthy" ? "0" : "1"], { cwd: root, encoding: "utf8", timeout: 5000 });
    assert.ifError(result.error);
    return result;
  } finally {
    rmSync(directory, { recursive: true });
  }
}

for (const [kind, expected] of [["healthy", "healthy-control"], ["publisher", "publisher-paused-with-continuous-observation"], ["observer", "foreground-delay-with-continuous-publication"]]) {
  test(`freshness origin trace qualifies complete ${kind} records without running native recovery`, () => {
    const result = qualifyFreshnessOrigin(freshnessOriginFixture(kind));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `freshness_origin_trace:${expected}\n`);
  });
}

test("freshness origin trace rejects publisher pause with a later foreground observation gap", () => {
  const fixture = freshnessOriginFixture("publisher");
  for (const [index, time] of [[6, 4200], [9, 4500]]) {
    for (let guard = 0; guard < 3; guard++) {
      const row = fixture.readers[index + guard];
      row.before_ms = time + guard * 20;
      row.after_ms = row.before_ms + 5;
      row.observation_ms = row.before_ms - 5;
      row.counter = guard === 2 ? 16 : Math.floor((row.before_ms - 1000) / 200) + 1;
    }
  }
  fixture.log = fixture.log.replace("observation-ms:6535", "observation-ms:4535");
  const result = qualifyFreshnessOrigin(fixture);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "freshness_origin_trace:incomplete-or-inconsistent\n");
});

const invalidOriginTraces = [
  ["missing publisher stop", f => f.publishers[0].pop()],
  ["duplicate publication counter", f => { f.publishers[0][2].counter = 2; }],
  ["unknown publisher event", f => { f.publishers[1][2].event = "unknown"; }],
  ["out-of-order publication bracket", f => { f.publishers[2][2].before_ms = 1; }],
  ["duplicate publisher PID", f => { f.publishers[1].forEach(row => { row.pid = 100; }); }],
  ["unknown reader field", f => { f.readers[0].payload = "not-an-origin"; }],
  ["missing supervisor terminal", f => f.readers.pop()],
  ["failed original reader", f => { f.readers[0].status = 1; }],
  ["delay outside foreground", f => { f.readers[6].reader = "other"; }],
  ["delay before reap", f => { f.readers[6].reaped = 0; }],
  ["short observer delay", f => { f.readers[6].after_ms = 15000; }],
  ["late counter not advanced", f => { f.readers[7].counter = 11; }],
  ["stale observation without matching real read", f => { f.log = f.log.replace("observation-ms:2995", "observation-ms:2996"); }],
  ["stale counter incompatible with its observation", f => { f.log = f.log.replace("counter:11:", "counter:3:"); }],
  ["second observer delay", f => { f.readers.splice(6, 0, { ...f.readers[6] }); }],
  ["one publisher freezes during observer pause", f => {
    f.publishers[2] = f.publishers[2].filter(row => row.event !== "publish" || row.after_ms < 4000);
    f.publishers[2].at(-1).counter = f.publishers[2].at(-2).counter;
  }],
];
for (const [name, mutate] of invalidOriginTraces) {
  test(`freshness origin trace rejects ${name}`, () => {
    const fixture = freshnessOriginFixture();
    mutate(fixture);
    const result = qualifyFreshnessOrigin(fixture);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "freshness_origin_trace:incomplete-or-inconsistent\n");
  });
}

for (const [name, alterFiles] of [
  ["truncated JSONL", dir => writeFileSync(join(dir, "publisher-0.jsonl"), '{"event":')],
  ["missing trace file", dir => rmSync(join(dir, "publisher-1.jsonl"))],
  ["duplicate JSON field", dir => {
    const path = join(dir, "readers.jsonl");
    writeFileSync(path, readFileSync(path, "utf8").replace('"guard":0', '"guard":0,"guard":0'));
  }],
]) {
  test(`freshness origin trace rejects ${name}`, () => {
    const result = qualifyFreshnessOrigin(freshnessOriginFixture(), alterFiles);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "freshness_origin_trace:incomplete-or-inconsistent\n");
  });
}

function nativeTraceProgram(marker) {
  const start = recoveryHarness.indexOf(`<<'${marker}'\n`);
  const end = recoveryHarness.indexOf(`\n${marker}\n`, start);
  assert.ok(start >= 0 && end > start, marker);
  return recoveryHarness.slice(start + `<<'${marker}'\n`.length, end);
}
const nativeTraceGenerate = nativeTraceProgram("CHECKPOINT_PGSQL_NATIVE_TRACE_GENERATE");
const nativeTraceVerify = nativeTraceProgram("CHECKPOINT_PGSQL_NATIVE_TRACE_VERIFY");
const selectorStart = recoveryHarness.indexOf("checkpoint_pgsql_native_trace_selected() {\n");
const nativeTraceSelector = recoveryHarness.slice(selectorStart, recoveryHarness.indexOf("\n}\n", selectorStart) + 3);

test("pgsql native trace selector accepts only the explicit existing DB-stable focus", () => {
  for (const [flag, focus, selectedCase, status] of [["1", "checkpoint-children", "db-stable", 0],
    ["0", "checkpoint-children", "db-stable", 1], ["1", "checkpoint-children", "db-source-monitor-abort", 1],
    ["1", "pgsql-guard-round-native", "db-stable", 1], ["2", "checkpoint-children", "db-stable", 1]]) {
    const result = spawnSync("bash", ["-c", `${nativeTraceSelector}\ncheckpoint_pgsql_native_trace_selected`], {
      cwd: root, encoding: "utf8", timeout: 5000,
      env: { ...process.env, YENHUBS_PGSQL_NATIVE_FRESHNESS_TRACE: flag,
        YENHUBS_RECOVERY_TEST_FOCUS: focus, YENHUBS_RECOVERY_TEST_CASE: selectedCase }
    });
    assert.ifError(result.error);
    assert.equal(result.status, status);
    assert.equal(result.stdout + result.stderr, "");
  }
});

function withNativeTraceCopy(callback) {
  const directory = mkdtempSync(join(tmpdir(), "yenhubs-native-trace-pure-"));
  const trace = join(directory, "trace");
  try {
    const result = spawnSync(process.execPath, ["-", root, join(root, "tests/recovery/test-recovery-safety.sh"), trace], {
      input: nativeTraceGenerate, cwd: root, encoding: "utf8", timeout: 5000
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout + result.stderr, "");
    return callback(trace);
  } finally {
    rmSync(directory, { recursive: true });
  }
}

const nativeWallCallsites = ["preconditions", "lock-lease-initial",
  "consumer-reticulum", "consumer-pgbouncer", "consumer-pgbouncer-t", "consumer-bot-orchestrator", "consumer-coturn",
  "writer-authority-export", "writer-monitor-authority-privacy-progress", "writer-process-before-boundary",
  "writer-boundary-lock-lease-before", "writer-contracts-baselines", "writer-live-boundary", "writer-boundary-lock-lease-after",
  "writer-process-after-boundary", "writer-progress-export", "durable-authority-export",
  "durable-monitor-authority-privacy", "durable-control-baseline", "durable-monitor-authority-contract",
  "durable-monitor-progress", "durable-process-before", "durable-lock-lease", "durable-baseline",
  "durable-runner-quiescence", "durable-process-after", "durable-progress-export", "durable-active-fence"];

function seedNativeTraceRecords(trace) {
  const row = (event, pid, at_ms, counter, phase = "publisher", observation_ms = null, status = 0) =>
    ({ event, pid, at_ms, counter, status, phase, observation_ms });
  const child = [row("child-start", 100, 10, 0, "child"), row("child-stop", 100, 2000, 0, "child")];
  const names = ["cycle-start", "guard-end", "identity-end", "formatter-before", "formatter-after", "cycle-end"];
  const publisher = [row("monitor-start", 101, 20, 0)];
  [[30, 400, 450, 460, 470, 480], [700, 1100, 1150, 1160, 1170, 1180]].forEach((times, index) =>
    times.forEach((at_ms, stage) => publisher.push(row(names[stage], 101, at_ms, index + 1))));
  publisher.push(row("monitor-stop", 101, 1800, 2));
  const readers = [];
  for (const [pid, before, counter, phase, observation] of [[201, 500, 1, "startup", null],
    [202, 1200, 2, "refresh", 1190], [203, 1400, 2, "post-audit", 1390], [204, 1600, 2, "post-audit", 1590]]) {
    readers.push(row("reader-before", pid, before, 0, phase, observation), row("reader-after", pid, before + 20, counter, phase, observation));
  }
  const segments = [];
  for (let counter = 1; counter <= 2; counter++) {
    const start = 1_800_000_000_000_000 + counter * 10000;
    const wall = (event, callsite, wall_us) =>
      ({ event, callsite, clock: "WALL_CLOCK_EPOCHREALTIME", pid: 101, counter, wall_us, status: 0 });
    segments.push(wall("round-before", "require_backup_guard", start));
    nativeWallCallsites.forEach((callsite, index) => {
      segments.push(wall("before", callsite, start + 10 + index * 30), wall("after", callsite, start + 30 + index * 30));
    });
    segments.push(wall("round-after", "require_backup_guard", start + 1000));
  }
  const fixture = { child, publisher, readers, segments };
  for (const [name, rows] of Object.entries(fixture)) {
    writeFileSync(join(trace, `${name}.jsonl`), `${rows.map(value => JSON.stringify(value)).join("\n")}\n`, { mode: 0o600 });
  }
  writeFileSync(join(trace, "native-exit"), "0\n", { mode: 0o600 });
  return fixture;
}

function runNativeTraceOracle(trace) {
  const result = spawnSync(process.execPath, ["-", trace], { input: nativeTraceVerify, cwd: root, encoding: "utf8", timeout: 5000 });
  assert.ifError(result.error);
  return result;
}

test("pgsql native trace copies strip byte-exactly and bind all original helper paths explicitly", () => {
  withNativeTraceCopy(trace => {
    const manifest = JSON.parse(readFileSync(join(trace, "instrumentation.json"), "utf8"));
    assert.equal(manifest.fixture_only, true);
    assert.equal(manifest.original_library_dir, realpathSync(join(root, "deployment/lib")));
    for (const [name, relative] of [["child", "deployment/backup-retdb.sh"], ["library", "deployment/lib/recovery-safety.sh"]]) {
      let stripped = readFileSync(join(trace, relative), "utf8");
      for (const insertion of manifest.insertions.filter(item => item.file === name)) {
        const exactLine = `\n${insertion.line}\n`;
        assert.equal(stripped.split(exactLine).length, 2);
        stripped = stripped.replace(exactLine, "\n");
      }
      assert.equal(stripped, readFileSync(manifest.sources[name], "utf8"));
      const parsed = spawnSync("bash", ["-n", join(trace, relative)], { cwd: root, encoding: "utf8", timeout: 5000 });
      assert.ifError(parsed.error);
      assert.equal(parsed.status, 0, parsed.stderr);
    }
    const parsed = spawnSync("bash", ["-n", join(trace, "hooks.sh")], { cwd: root, encoding: "utf8", timeout: 5000 });
    assert.ifError(parsed.error);
    assert.equal(parsed.status, 0, parsed.stderr);
  });
});

test("pgsql native trace wall hooks gate on the monitor guard stack and preserve the native status without subprocesses", () => {
  withNativeTraceCopy(trace => {
    const result = spawnSync("bash", ["-c", `set -euo pipefail
source "$1/hooks.sh"
CHECKPOINT_PGSQL_NATIVE_TRACE_DIR="$1"
checkpoint_pgsql_native_trace_wall_clock_ready
node(){ return 99; }; python3(){ return 99; }; date(){ return 99; }
for expected in 0 1 37; do
  if checkpoint_pgsql_native_trace_wall_segment before preconditions "$expected"; then observed=0; else observed=$?; fi
  [[ "$observed" == "$expected" && ! -e "$1/segments.jsonl" ]]
done
require_backup_guard(){
  checkpoint_pgsql_native_trace_wall_segment before preconditions 0
  checkpoint_pgsql_native_trace_wall_segment after preconditions 37
}
monitor_exact_pgsql_source(){ local progress=2; require_backup_guard; }
if monitor_exact_pgsql_source; then observed=0; else observed=$?; fi
[[ "$observed" == 37 ]]
`, "_", trace], { cwd: root, encoding: "utf8", timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout + result.stderr, "");
    const rows = readFileSync(join(trace, "segments.jsonl"), "utf8").trimEnd().split("\n").map(JSON.parse);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].pid, rows[1].pid);
    assert.deepEqual(rows.map(row => [row.event, row.counter, row.status, row.clock]),
      [["before", 3, 0, "WALL_CLOCK_EPOCHREALTIME"], ["after", 3, 37, "WALL_CLOCK_EPOCHREALTIME"]]);
    assert.ok(rows[1].wall_us >= rows[0].wall_us);
  });
});

test("pgsql native trace wall preflight rejects a missing EPOCHREALTIME builtin", () => {
  withNativeTraceCopy(trace => {
    const result = spawnSync("bash", ["-c", `set -euo pipefail
source "$1/hooks.sh"
checkpoint_pgsql_native_trace_wall_clock_ready
unset EPOCHREALTIME
if checkpoint_pgsql_native_trace_wall_clock_ready; then exit 1; fi
`, "_", trace], { cwd: root, encoding: "utf8", timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout + result.stderr, "");
  });
});

test("pgsql native trace wall preflight accepts the sanitized runner context before any parent or DB starts", () => {
  withNativeTraceCopy(trace => {
    function harnessFunction(name, next) {
      const start = recoveryHarness.indexOf(`${name}() {\n`);
      const end = recoveryHarness.indexOf(`\n${next}() {\n`, start);
      assert.ok(start >= 0 && end > start, name);
      return recoveryHarness.slice(start, end);
    }
    const script = join(trace, "preflight-context.sh");
    writeFileSync(script, `set -euo pipefail
umask 077
source "$1/hooks.sh"
${nativeTraceSelector}
${harnessFunction("expect_success", "expect_failure")}
${harnessFunction("checkpoint_pgsql_native_trace_prepare", "verify_checkpoint_pgsql_native_trace")}
${harnessFunction("run_checkpoint_backup_child", "seed_already_fenced_legacy_restore_lock")}
ROOT_DIR="$2"
PASS_COUNT=0 FAIL_COUNT=0 LAST_OUTPUT=""
LEGACY_DEPLOYMENTS_JSON=fixture-legacy KUBERNETES_DEPLOYMENTS_JSON=fixture-durable
pass(){ PASS_COUNT=$((PASS_COUNT + 1)); }
fail(){ FAIL_COUNT=$((FAIL_COUNT + 1)); printf '%s\\n' "$2" >&2; }
recovery_test_profile_checkpoint_timing(){ :; }
# Stop after the real readiness/prefix, before generation or any parent/API/DB.
node(){ printf 'preflight-ready\\n'; }
seed_recovery_operation_fence_binding_state(){ printf 'pre-parent-stop\\n'; exit 0; }
stop_checkpoint_backup_writer_guard(){ :; }
start_checkpoint_backup_writer_guard(){ printf 'unexpected-parent-start\\n' >&2; exit 99; }
expect_success 'isolated selected preflight' run_checkpoint_backup_child \\
  db "$1/preflight-output" durable-v2 fixture-baseline fixture-sha fence-stable ""
[[ "$PASS_COUNT" == 1 && "$FAIL_COUNT" == 0 &&
   "$LAST_OUTPUT" == $'preflight-ready\\npre-parent-stop' &&
   ! -e "$1/preflight-output" && ! -e "$1/preflight-output.pgsql-native-trace" ]]
`, { mode: 0o600 });
    const result = spawnSync(process.platform === "darwin" ? "/opt/homebrew/bin/bash" : "bash",
      [script, trace, root], { cwd: root, encoding: "utf8", timeout: 5000,
        env: { PATH: process.platform === "darwin" ?
          "/opt/homebrew/bin:/Users/yengalvez/.node/bin:/usr/bin:/bin:/usr/sbin:/sbin" : process.env.PATH,
          HOME: process.platform === "darwin" ? "/Users/yengalvez" : process.env.HOME,
          TMPDIR: process.platform === "darwin" ? "/private/tmp" : tmpdir(),
          YENHUBS_RECOVERY_TEST_FOCUS: "checkpoint-children", YENHUBS_RECOVERY_TEST_CASE: "db-stable",
          YENHUBS_PGSQL_NATIVE_FRESHNESS_TRACE: "1", YENHUBS_RECOVERY_TEST_KEEP_TMP: "1" }
      });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout + result.stderr, "");
  });
});

test("pgsql native trace wall samples preserve the caller locale and normalize only the builtin rendering",
  { skip: process.platform !== "darwin" && "requires the macOS comma-decimal locale from the reported runner" }, () => {
  withNativeTraceCopy(trace => {
    const result = spawnSync("bash", ["-c", `set -euo pipefail
source "$1/hooks.sh"
CHECKPOINT_PGSQL_NATIVE_TRACE_DIR="$1"
# Explicit comma-decimal locale, independent of the test runner's locale.
export LC_ALL=es_ES.UTF-8
[[ "\${EPOCHREALTIME-}" =~ ^[0-9]+,[0-9]{6}$ ]]
checkpoint_pgsql_native_trace_wall_clock_ready
[[ "$LC_ALL" == es_ES.UTF-8 && "\${EPOCHREALTIME-}" =~ ^[0-9]+,[0-9]{6}$ ]]
node(){ return 99; }; python3(){ return 99; }; date(){ return 99; }
require_backup_guard(){
  checkpoint_pgsql_native_trace_wall_segment before preconditions 0
  [[ "$LC_ALL" == es_ES.UTF-8 && "\${EPOCHREALTIME-}" =~ ^[0-9]+,[0-9]{6}$ ]] || return 98
  checkpoint_pgsql_native_trace_wall_segment after preconditions 37
}
monitor_exact_pgsql_source(){ local progress=2; require_backup_guard; }
if monitor_exact_pgsql_source; then observed=0; else observed=$?; fi
[[ "$observed" == 37 && "$LC_ALL" == es_ES.UTF-8 && "\${EPOCHREALTIME-}" =~ ^[0-9]+,[0-9]{6}$ ]]
`, "_", trace], { cwd: root, encoding: "utf8", timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout + result.stderr, "");
    const rows = readFileSync(join(trace, "segments.jsonl"), "utf8").trimEnd().split("\n").map(JSON.parse);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(row => [row.event, row.counter, row.status, row.clock]),
      [["before", 3, 0, "WALL_CLOCK_EPOCHREALTIME"], ["after", 3, 37, "WALL_CLOCK_EPOCHREALTIME"]]);
    assert.ok(rows.every(row => Number.isSafeInteger(row.wall_us)));
    assert.ok(rows[1].wall_us >= rows[0].wall_us);
  });
});

test("pgsql native trace complete pure records report brackets without assigning an origin", () => {
  withNativeTraceCopy(trace => {
    seedNativeTraceRecords(trace);
    const result = runNativeTraceOracle(trace);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout.replace(/^pgsql_native_freshness_trace:/, ""));
    assert.equal(summary.native_exit, 0);
    assert.equal(summary.rounds, 2);
    assert.equal(summary.reads, 4);
    assert.equal(summary.maximum_formatter_ms, 10);
    assert.equal(summary.maximum_reader_ms, 20);
    assert.equal(summary.origin, "indeterminate");
  });
});

test("pgsql native trace wall segments sum only the flat same-round partition in their own clock domain", () => {
  withNativeTraceCopy(trace => {
    seedNativeTraceRecords(trace);
    const result = runNativeTraceOracle(trace);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout.replace(/^pgsql_native_freshness_trace:/, ""));
    assert.equal(summary.wall_clock_segments.clock, "WALL_CLOCK_EPOCHREALTIME");
    assert.equal(summary.wall_clock_segments.unit, "microseconds");
    assert.equal(summary.wall_clock_segments.hook_events, 116);
    assert.equal(summary.wall_clock_segments.security_clock, false);
    assert.deepEqual(summary.wall_clock_segments.rounds.map(round => [round.counter, round.total_us,
      round.measured_us, round.unattributed_us]), [[1, 1000, 560, 440], [2, 1000, 560, 440]]);
    assert.equal(summary.maximum_guard_ms, 400, "wall and monotonic epochs are never subtracted");
  });
});

test("pgsql native trace preserves native failure even when its wall breakdown is complete", () => {
  withNativeTraceCopy(trace => {
    const fixture = seedNativeTraceRecords(trace);
    fixture.child[1].status = 1;
    writeFileSync(join(trace, "child.jsonl"), `${fixture.child.map(row => JSON.stringify(row)).join("\n")}\n`);
    writeFileSync(join(trace, "native-exit"), "1\n");
    const result = runNativeTraceOracle(trace);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    const summary = JSON.parse(result.stdout.replace(/^pgsql_native_freshness_trace:/, ""));
    assert.equal(summary.native_exit, 1);
    assert.equal(summary.wall_clock_segments.rounds.length, 2);
  });
});

for (const [name, mutate] of [
  ["absent coverage", f => { f.segments = []; }],
  ["missing round terminal", f => f.segments.pop()],
  ["incomplete pair", f => f.segments.splice(2, 1)],
  ["interleaved pairs", f => { [f.segments[2], f.segments[3]] = [f.segments[3], f.segments[2]]; }],
  ["overlapping pairs", f => { f.segments[3].wall_us = f.segments[2].wall_us - 1; }],
  ["ambiguous PID", f => { f.segments[2].pid = 999; }],
  ["ambiguous counter", f => { f.segments[2].counter = 2; }],
  ["ambiguous callsite", f => { f.segments[2].callsite = "lock-lease-initial"; }],
  ["duplicate callsite", f => { f.segments[3].callsite = f.segments[4].callsite = "preconditions"; }],
  ["clock regression", f => { f.segments[2].wall_us = f.segments[1].wall_us - 1; }],
  ["mixed clocks", f => { f.segments[2].clock = "monotonic"; }],
  ["unknown field", f => { f.segments[2].payload = "not-a-cost"; }],
  ["failed segment", f => { f.segments[2].status = 1; }],
  ["out-of-round event", f => { f.segments[1].wall_us = f.segments[0].wall_us - 1; }],
]) {
  test(`pgsql native trace rejects wall ${name}`, () => {
    withNativeTraceCopy(trace => {
      const fixture = seedNativeTraceRecords(trace);
      mutate(fixture);
      writeFileSync(join(trace, "segments.jsonl"), fixture.segments.length ?
        `${fixture.segments.map(row => JSON.stringify(row)).join("\n")}\n` : "");
      const result = runNativeTraceOracle(trace);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "pgsql_native_freshness_trace:indeterminate-incomplete-or-inconsistent\n");
    });
  });
}

for (const [name, mutate] of [
  ["missing monitor terminal", f => f.publisher.pop()],
  ["only one actual round", f => { f.publisher.splice(7, 6); f.publisher.at(-1).counter = 1; }],
  ["reordered guard and identity", f => { [f.publisher[2].event, f.publisher[3].event] = [f.publisher[3].event, f.publisher[2].event]; }],
  ["incomplete reader bracket", f => f.readers.pop()],
  ["reader counter without a publication", f => { f.readers[1].counter = 3; }],
  ["reader phase drift", f => { f.readers[1].phase = "running"; }],
  ["native exit mismatch", f => { f.child[1].status = 7; }],
  ["missing post-audit observations", f => { f.readers = f.readers.filter(row => row.phase !== "post-audit"); }],
  ["null post-audit observation", f => { f.readers.filter(row => row.phase === "post-audit").forEach(row => { row.observation_ms = null; }); }],
  ["causally obsolete post-audit observation", f => {
    f.readers[4].observation_ms = f.readers[5].observation_ms = 1190;
    f.readers[6].observation_ms = f.readers[7].observation_ms = 1390;
  }],
  ["serialized counter regression", f => {
    f.publisher[11].at_ms = 1700;
    f.publisher[12].at_ms = 1710;
    f.readers[5].counter = 1;
  }],
]) {
  test(`pgsql native trace rejects ${name} as indeterminate`, () => {
    withNativeTraceCopy(trace => {
      const fixture = seedNativeTraceRecords(trace);
      mutate(fixture);
      for (const [sink, rows] of Object.entries(fixture)) {
        writeFileSync(join(trace, `${sink}.jsonl`), `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);
      }
      const result = runNativeTraceOracle(trace);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "pgsql_native_freshness_trace:indeterminate-incomplete-or-inconsistent\n");
    });
  });
}

for (const [name, alter] of [
  ["modified literal copy", trace => {
    const file = join(trace, "deployment/backup-retdb.sh");
    writeFileSync(file, `${readFileSync(file, "utf8")}\n`);
  }],
  ["modified hooks", trace => {
    const file = join(trace, "hooks.sh");
    writeFileSync(file, `${readFileSync(file, "utf8")}\n`);
  }],
  ["trace write or clock failure", trace => writeFileSync(join(trace, "invalid"), "invalid\n")],
  ["missing wall trace file", trace => rmSync(join(trace, "segments.jsonl"))],
  ["truncated wall JSONL", trace => writeFileSync(join(trace, "segments.jsonl"), '{"event":')],
  ["blank wall record", trace => {
    const file = join(trace, "segments.jsonl");
    writeFileSync(file, `${readFileSync(file, "utf8")}\n`);
  }],
  ["ambiguous wall manifest coverage", trace => {
    const file = join(trace, "instrumentation.json"), manifest = JSON.parse(readFileSync(file, "utf8"));
    manifest.wall_clock_segments.callsites.pop();
    writeFileSync(file, JSON.stringify(manifest));
  }],
]) {
  test(`pgsql native trace rejects ${name}`, () => {
    withNativeTraceCopy(trace => {
      seedNativeTraceRecords(trace);
      alter(trace);
      const result = runNativeTraceOracle(trace);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "pgsql_native_freshness_trace:indeterminate-incomplete-or-inconsistent\n");
    });
  });
}

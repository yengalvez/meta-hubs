import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

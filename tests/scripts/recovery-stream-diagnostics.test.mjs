import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  const result = spawnSync("/bin/bash", ["-c", `${reporter}\n${script}`], {
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

test("EXIT reporter preserves the first cause and original status", () => {
  const result = run(`${fn("report_stream_diagnostic", "    ")}\nstream_diagnostic_stage=refresh\nstream_diagnostic_detail=lease-check\ntrap report_stream_diagnostic EXIT\nexit 37`);
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
      const result = spawnSync("/bin/bash", ["-c", "set -euo pipefail; source deployment/lib/recovery-safety.sh; recovery_kubectl_stream 10 -- exec local-fixture"], {
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

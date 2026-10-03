import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const suiteUrl = new URL("../recovery/test-recovery-safety.sh", import.meta.url);
const backupUrl = new URL("../../deployment/backup-retdb.sh", import.meta.url);
const suite = readFileSync(suiteUrl, "utf8");
const backup = readFileSync(backupUrl, "utf8");
const library = readFileSync(new URL("../../deployment/lib/recovery-safety.sh", import.meta.url), "utf8");
function heredoc(marker) {
  const start = suite.indexOf(`<<'${marker}'\n`);
  const end = suite.indexOf(`\n${marker}\n`, start);
  assert.ok(start >= 0 && end > start, marker);
  return suite.slice(start + `<<'${marker}'\n`.length, end);
}
function fn(text, name) {
  const start = text.indexOf(`\n${name}() {\n`) + 1;
  assert.ok(start > 0, name);
  const end = text.indexOf("\n}\n", start);
  assert.ok(end > start, name);
  return text.slice(start, end + 3);
}
const extractor = heredoc("PGSQL_GUARD_ROUND_EXTRACT");
const measure = heredoc("PGSQL_GUARD_ROUND_MEASURE");
// Pure extraction/contract checks only: this never sources the fixture,
// starts the native monitors, measures a round or substitutes its validators.
const extracted = spawnSync(process.execPath, ["-", suiteUrl.pathname, backupUrl.pathname], {
  input: extractor, encoding: "utf8", timeout: 5000
});
assert.ifError(extracted.error);
assert.equal(extracted.status, 0, extracted.stderr);
const parts = JSON.parse(extracted.stdout);
const monitor = fn(backup, "monitor_exact_pgsql_source");
const nativeStart = suite.indexOf("\nrun_pgsql_guard_round_native() (\n") + 1;
const nativeEnd = suite.indexOf("\n)\n", nativeStart);
assert.ok(nativeStart > 0 && nativeEnd > nativeStart);
const native = suite.slice(nativeStart, nativeEnd + 3);
const dispatchStart = suite.indexOf('\nif [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == pgsql-guard-round-native ]]; then\n') + 1;
const dispatchEnd = suite.indexOf("\nfi\n", dispatchStart);
assert.ok(dispatchStart > nativeEnd && dispatchEnd > dispatchStart);
const dispatch = suite.slice(dispatchStart, dispatchEnd + 4);

test("native extraction is literal and limited to the current fixture helpers and production guard definitions", () => {
  assert.equal(parts.preamble, backup.slice(0, backup.indexOf("require_parent_writer_monitor_capability() {")));
  assert.equal(parts.capabilities, ["require_parent_writer_monitor_capability", "require_parent_freeze_fence_capability",
    "require_parent_durable_monitor_capability"].map(name => fn(backup, name)).join("\n\n"));
  assert.equal(parts.guards, ["require_backup_guard", "require_exact_pgsql_source_now",
    "record_pgsql_source_monitor_failure"].map(name => fn(backup, name)).join("\n\n"));
  assert.equal(parts.fixture_helpers, ["reset_stub", "seed_recovery_operation_fence_binding_state",
    "seed_serialization_lease", "seed_restore_lock", "seed_checkpoint_backup_guard",
    "start_checkpoint_backup_writer_guard", "stop_checkpoint_backup_writer_guard"]
    .map(name => fn(suite, name)).join("\n\n"));
  const setupStart = suite.indexOf('\nmkdir -p "$TMP_DIR/bin" "$TMP_DIR/stub-state"\n') + 1;
  assert.equal(parts.fixture_setup, suite.slice(setupStart, suite.indexOf("\nreset_stub() {\n") + 1));
  assert.doesNotMatch(parts.fixture_helpers, /^(?:require_|recovery_require_)\w+\(\)/m,
    "the native entry must not redefine real validators");
  assert.doesNotMatch(parts.fixture_setup, /^expect_(?:success|failure)|^run_\w+_tests\b/m);
});

test("one measured round retains exactly both production calls and their failure arms", () => {
  const start = monitor.indexOf("    require_backup_guard || {\n");
  const end = monitor.indexOf("    progress=$((progress + 1))\n");
  assert.equal(parts.round, monitor.slice(start, end));
  assert.equal(parts.round, '    require_backup_guard || {\n' +
    '      record_pgsql_source_monitor_failure "${DB_BACKUP_GUARD_FAILURE_REASON:-backup-guard}"\n' +
    '      return 1\n    }\n    require_exact_pgsql_source_now || {\n' +
    '      record_pgsql_source_monitor_failure pgsql-source\n      return 1\n    }\n');
  assert.doesNotMatch(parts.round, /while|sleep|recovery_write_stream_guard_progress|pg_dump/);
  assert.equal(parts.publish_poll, monitor.slice(end, monitor.indexOf("  done\n", end)));
  assert.match(parts.publish_poll, /recovery_write_stream_guard_progress/);
  assert.match(parts.publish_poll, /sleep "\$DB_SOURCE_MONITOR_POLL_SECONDS"/);
});

test("PGSQL identity is initialized literally before the timer, with no dump or contract capture", () => {
  const start = backup.indexOf('PGSQL_PODS_JSON="$(recovery_kubectl get pod -n "$NAMESPACE" -l app=pgsql -o json)"\n');
  assert.equal(parts.identity, backup.slice(start, backup.indexOf("require_pgsql_source() {\n", start)));
  assert.match(parts.identity, /IFS=\$'\\t' read -r PGSQL_POD PGSQL_POD_UID PGSQL_DEPLOYMENT_UID/);
  assert.doesNotMatch(parts.identity, /pg_dump|capture_live_database_contract|require_backup_guard/);
  assert.doesNotMatch(native, /run_checkpoint_backup_child|deployment\/backup-retdb\.sh"\s*\\?\n\s*"\$output_root/);
});

test("the real library and concurrent healthy paced parents remain bound outside the measurement", () => {
  assert.match(parts.preamble, /source "\$SCRIPT_DIR\/lib\/recovery-safety\.sh"/);
  assert.match(native, /ln -s "\$ROOT_DIR\/deployment\/lib" "\$case_root\/deployment\/lib"/);
  assert.match(native, /STUB_DEPLOYMENTS_JSON="\$KUBERNETES_DEPLOYMENTS_JSON" seed_checkpoint_backup_guard/);
  assert.match(native, /seed_recovery_operation_fence_binding_state active/);
  assert.match(native, /STUB_RUNNER_NAMESPACE=present STUB_RUNNER_POD_PROFILE=fence-stable/);
  assert.match(native, /STUB_MONITOR_WATCH_PACE=1\s*\\\n\s*start_checkpoint_backup_writer_guard healthy durable-v2/);
  assert.match(native, /"\$DURABLE_FENCE_BASELINE_FIXTURE" "\$DURABLE_FENCE_BASELINE_SHA"/);
  assert.match(native, /trap 'stop_checkpoint_backup_writer_guard' EXIT/);
  assert.doesNotMatch(native, /kill -STOP|stale-helper|start_checkpoint_backup_writer_guard stale/);
  assert.doesNotMatch(measure, /start_checkpoint|stop_checkpoint|source |kill |date|monotonic_milliseconds\(\)/);
});

test("native startup 30 and stale 10 override harness 120 before parents, retaining reserve 2", () => {
  const setup = native.indexOf('source "$case_root/fixture-setup.sh"');
  const startup = native.indexOf("export RECOVERY_TEST_STREAM_GUARD_INITIAL_DEADLINE_SECONDS=30");
  const stale = native.indexOf("export RECOVERY_TEST_STREAM_GUARD_MAX_STALE_SECONDS=10");
  const parents = native.indexOf("start_checkpoint_backup_writer_guard healthy durable-v2");
  assert.ok(setup >= 0 && startup > setup && stale > startup && parents > stale);
  assert.doesNotMatch(native, /INITIAL_DEADLINE_SECONDS=120|MAX_STALE_SECONDS=(?:[2-9][0-9]|1[1-9])/);
  assert.match(library, /local guard_cancel_reserve_milliseconds=2000/);
  assert.match(measure, /startup_seconds=30 stale_seconds=10 cancellation_reserve_seconds=2/);
});

test("Bash builtin time reports the true round exit and excludes publication and poll", () => {
  assert.match(measure, /TIMEFORMAT='PGSQL_GUARD_ROUND_NATIVE duration_seconds=%3R'/);
  assert.match(measure, /if \{ time pgsql_guard_round_native_once; \}/);
  assert.match(measure, /else\n  round_status=\$\?\nfi/);
  assert.match(measure, /if \[\[ "\$round_status" == 0 \]\]; then\n  pgsql_guard_round_native_publish_poll\nfi\nexit "\$round_status"/);
  assert.match(measure, /no-SLO,no-historical-cause; clock=Bash-time-wall-clock-may-adjust/);
  assert.match(measure, /overhead=timed-function-and-failure-arms; setup-publication-poll-cleanup=excluded/);
  assert.doesNotMatch(native, /\/usr\/bin\/time|TIMEFORMAT=.*\$|function time|time\(\)|faketime/);
  const script = parts.preamble + parts.capabilities + "\n" + parts.guards + "\n" + parts.identity +
    "pgsql_guard_round_native_once() {\n" + parts.round + "}\n" +
    "pgsql_guard_round_native_publish_poll() {\n  local progress=0\n" + parts.publish_poll + "}\n" + measure;
  const syntax = spawnSync("bash", ["-n", "-s"], { input: script, encoding: "utf8", timeout: 5000 });
  assert.ifError(syntax.error);
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("opt-in dispatch exits before unrelated suites and propagates failure without retry", () => {
  assert.ok(dispatchEnd < suite.indexOf('\nSIZE_FIXTURE="$TMP_DIR/file-size-fixture"\n'));
  assert.doesNotMatch(dispatch, /expect_|run_\w+_tests|while|for |\|\|/);
  // Exercise only the small selector, not the native entry or any validator.
  const result = spawnSync("bash", ["-c", 'set -e\nrun_pgsql_guard_round_native() { printf "selected-once\\n"; return 7; }\n' +
    dispatch + '\nprintf "unrelated-suite-reached\\n"\n'], {
    env: { ...process.env, YENHUBS_RECOVERY_TEST_FOCUS: "pgsql-guard-round-native" },
    encoding: "utf8", timeout: 5000
  });
  assert.ifError(result.error);
  assert.equal(result.status, 7);
  assert.equal(result.stdout, "selected-once\n");
  assert.equal(result.stderr, "");
});

test("non-unique source anchors fail closed before any fixture or native command can run", () => {
  const injected = extractor.replace('const backup = fs.readFileSync(process.argv[3], "utf8");',
    'const backup = fs.readFileSync(process.argv[3], "utf8") + "\\n    require_backup_guard || {\\n";');
  const result = spawnSync(process.execPath, ["-", suiteUrl.pathname, backupUrl.pathname], {
    input: injected, encoding: "utf8", timeout: 5000
  });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /non-unique extraction anchor/);
});

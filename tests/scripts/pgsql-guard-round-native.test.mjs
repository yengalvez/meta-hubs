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
const profileHelpers = heredoc("PGSQL_GUARD_ROUND_PROFILE");
// Pure extraction/contract checks only: this never sources the fixture,
// starts the native monitors, measures a round or substitutes its validators.
function runExtractor(profile = "0", input = extractor) {
  return spawnSync(process.execPath, ["-", suiteUrl.pathname, backupUrl.pathname], {
    input, env: { ...process.env, YENHUBS_PGSQL_ROUND_PROFILE: profile }, encoding: "utf8", timeout: 5000
  });
}
const extracted = runExtractor();
assert.ifError(extracted.error);
assert.equal(extracted.status, 0, extracted.stderr);
const parts = JSON.parse(extracted.stdout);
const profiledExtraction = runExtractor("1");
assert.ifError(profiledExtraction.error);
assert.equal(profiledExtraction.status, 0, profiledExtraction.stderr);
const profiledParts = JSON.parse(profiledExtraction.stdout);
const monitor = fn(backup, "monitor_exact_pgsql_source");
const nativeStart = suite.indexOf("\nrun_pgsql_guard_round_native() (\n") + 1;
const nativeEnd = suite.indexOf("\n)\n", nativeStart);
assert.ok(nativeStart > 0 && nativeEnd > nativeStart);
const native = suite.slice(nativeStart, nativeEnd + 3);
const dispatchStart = suite.indexOf('\nif [[ "${YENHUBS_RECOVERY_TEST_FOCUS:-}" == pgsql-guard-round-native ]]; then\n', nativeEnd) + 1;
const dispatchEnd = suite.indexOf("\nfi\n", dispatchStart);
assert.ok(dispatchStart > nativeEnd && dispatchEnd > dispatchStart);
const dispatch = suite.slice(dispatchStart, dispatchEnd + 4);

const checkpointSelector = suite.slice(suite.indexOf("checkpoint_pgsql_native_trace_selected() {\n"),
  suite.indexOf("# shellcheck source=tests/recovery/lib/harness-profile.sh"));
const checkpointChild = fn(suite, "run_checkpoint_backup_child");
const checkpointParents = fn(suite, "start_checkpoint_backup_writer_guard");
const standaloneUnavailable = "PGSQL standalone measurement is unavailable after publisher-owned lifecycle; use checkpoint-children/db-stable ordinary timing without tracing.\n";

test("publisher-owned standalone measurement rejects both profile modes before fixture or parent boundaries", () => {
  // Literal preflight + entry/dispatch, with the first filesystem boundary
  // replaced by a failing observable sentinel. No fixture or monitor runs.
  for (const [profile, invocation] of [["0", "dispatch"], ["1", "dispatch"], ["0", "direct"], ["1", "direct"],
    ["0", "conditional"], ["1", "conditional"]]) {
    const result = spawnSync("bash", ["-c", `set -euo pipefail
ROOT_DIR=/never-created TMP_DIR=/never-created
${checkpointSelector}
mkdir(){ printf 'unexpected-fixture-boundary\\n'; exit 97; }
start_checkpoint_backup_writer_guard(){ printf 'unexpected-parent-boundary\\n'; exit 98; }
${native}
${invocation === "dispatch" ? dispatch : invocation === "conditional" ?
  'if run_pgsql_guard_round_native; then exit 99; else exit "$?"; fi' : "run_pgsql_guard_round_native"}
printf 'unexpected-suite-boundary\\n'
`], {
      encoding: "utf8", timeout: 5000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME,
        YENHUBS_RECOVERY_TEST_FOCUS: invocation === "dispatch" ? "pgsql-guard-round-native" : "checkpoint-children",
        YENHUBS_PGSQL_ROUND_PROFILE: profile,
        YENHUBS_PGSQL_NATIVE_ORDINARY_TIMING: "0", YENHUBS_PGSQL_NATIVE_FRESHNESS_TRACE: "0" }
    });
    assert.ifError(result.error);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, standaloneUnavailable);
  }
});

function runCheckpointTiming({ ordinary = "1", trace = "0", focus = "checkpoint-children", selectedCase = "db-stable",
  child = "db", generation = "durable-v2", profile = "fence-stable", writer = "healthy", stub = "", prefix = false } = {}) {
  // Execute the literal selector/function in expect_success's command-substitution
  // context. Parents, filesystem preparation and the child env launch are inert
  // boundary probes: no monitor, API, DB, trace generator or child is executed.
  const body = prefix ? checkpointChild.slice(0, checkpointChild.indexOf('  if [[ "$generation" == durable-v2 ]]; then')) +
    '  printf "prefix:%s:%s:%s:%s:%s\\n" "$RECOVERY_STREAM_POLL_SECONDS" "$RECOVERY_TEST_STREAM_GUARD_INITIAL_DEADLINE_SECONDS" "$RECOVERY_TEST_STREAM_GUARD_MAX_STALE_SECONDS" "$fixture_monitor_poll_seconds" "$db_child_path"\n  trap - EXIT INT TERM\n}\n' : checkpointChild;
  const input = `set -euo pipefail
${checkpointSelector}
${fn(suite, "expect_success")}
${body}
ROOT_DIR=/literal-root
LEGACY_DEPLOYMENTS_JSON=legacy KUBERNETES_DEPLOYMENTS_JSON=durable
STAMP=fixture DUMP_SHA=fixture STORAGE_SHA=fixture RUNNER_EVIDENCE_LIVE_DIR=fixture
PASS_COUNT=0 FAIL_COUNT=0 LAST_OUTPUT=""
export RECOVERY_STREAM_POLL_SECONDS=0.01 RECOVERY_TEST_STREAM_GUARD_INITIAL_DEADLINE_SECONDS=120
unset RECOVERY_TEST_STREAM_GUARD_MAX_STALE_SECONDS
pass(){ PASS_COUNT=$((PASS_COUNT + 1)); }
fail(){ FAIL_COUNT=$((FAIL_COUNT + 1)); printf '%s\\n' "$2" >&2; }
recovery_test_profile_checkpoint_timing(){ :; }
seed_recovery_operation_fence_binding_state(){ :; }
start_checkpoint_backup_writer_guard(){
  printf 'parents:%s:%s:%s:%s\\n' "$RECOVERY_STREAM_POLL_SECONDS" "$RECOVERY_TEST_STREAM_GUARD_INITIAL_DEADLINE_SECONDS" "\${RECOVERY_TEST_STREAM_GUARD_MAX_STALE_SECONDS:-default10}" "$STUB_MONITOR_WATCH_PACE"
}
stop_checkpoint_backup_writer_guard(){ :; }
checkpoint_pgsql_native_trace_prepare(){ printf 'trace-prepared\\n'; }
mkdir(){ :; }
env(){
  local poll="$RECOVERY_STREAM_POLL_SECONDS" stale="\${RECOVERY_TEST_STREAM_GUARD_MAX_STALE_SECONDS:-default10}" trace_dir= path=
  while [[ "$1" == *=* ]]; do
    case "$1" in
      RECOVERY_STREAM_POLL_SECONDS=*) poll="\${1#*=}" ;;
      RECOVERY_TEST_STREAM_GUARD_MAX_STALE_SECONDS=*) stale="\${1#*=}" ;;
      CHECKPOINT_PGSQL_NATIVE_TRACE_DIR=*) trace_dir="\${1#*=}" ;;
    esac
    shift
  done
  path="$1"
  printf 'child:%s:%s:%s:%s:%s\\n' "$poll" "$RECOVERY_TEST_STREAM_GUARD_INITIAL_DEADLINE_SECONDS" "$stale" "$trace_dir" "$path"
}
expect_success 'pure selected timing' run_checkpoint_backup_child "$1" /never-created "$2" fixture fixture "$3" "" "$4"
printf '%s\\n' "$LAST_OUTPUT"
[[ "$PASS_COUNT" == 1 && "$FAIL_COUNT" == 0 ]]
`;
  return spawnSync("bash", ["-c", input, "_", child, generation, profile, writer], {
    encoding: "utf8", timeout: 5000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, STUB_MODE: stub,
      YENHUBS_PGSQL_NATIVE_ORDINARY_TIMING: ordinary, YENHUBS_PGSQL_NATIVE_FRESHNESS_TRACE: trace,
      YENHUBS_RECOVERY_TEST_FOCUS: focus, YENHUBS_RECOVERY_TEST_CASE: selectedCase }
  });
}

test("checkpoint child ordinary timing opt-in restores 1/30/10 before both parent launches and preserves the original child/lib", () => {
  const result = runCheckpointTiming();
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "parents:1:30:10:1\nchild:1:30:10::/literal-root/deployment/backup-retdb.sh\n");
  assert.equal(result.stderr, "");
  assert.match(backup, /source "\$SCRIPT_DIR\/lib\/recovery-safety\.sh"/);
  assert.match(checkpointParents, /source "\$ROOT_DIR\/deployment\/lib\/recovery-safety\.sh"/);
  assert.match(checkpointParents, /recovery_start_checkpoint_writer_monitor[\s\S]+recovery_start_durable_runner_quiescence_monitor/);
  assert.doesNotMatch(checkpointParents, /(?:RECOVERY_STREAM_POLL_SECONDS|RECOVERY_TEST_STREAM_GUARD_(?:INITIAL_DEADLINE|MAX_STALE)_SECONDS)=/);
});

test("checkpoint child ordinary timing disabled keeps accelerated fixture defaults, while the original tracer still restores ordinary timing", () => {
  const disabled = runCheckpointTiming({ ordinary: "0" });
  assert.ifError(disabled.error);
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.equal(disabled.stdout, "parents:0.01:120:default10:1\nchild:0.25:120:::/literal-root/deployment/backup-retdb.sh\n");
  for (const ordinary of ["0", "1"]) {
    const traced = runCheckpointTiming({ ordinary, trace: "1", prefix: true });
    assert.ifError(traced.error);
    assert.equal(traced.status, 0, traced.stderr);
    assert.equal(traced.stdout, "trace-prepared\nprefix:1:30:10:1:/never-created.pgsql-native-trace/deployment/backup-retdb.sh\n");
    assert.equal(traced.stderr, "");
  }
});

test("checkpoint child ordinary timing rejects non-exact opt-ins and selectors before any fixture boundary", () => {
  for (const options of [{ ordinary: "2" }, { ordinary: "01" }, { ordinary: "" }, { ordinary: "true" },
    { focus: "pgsql-guard-round-native" }, { focus: "" }, { selectedCase: "db-source-monitor-abort" }, { selectedCase: "" }]) {
    const result = runCheckpointTiming(options);
    assert.ifError(result.error);
    assert.equal(result.status, 2, JSON.stringify(options) + result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "PGSQL ordinary timing requires 0 or 1 and checkpoint-children/db-stable only.\n");
  }
});

test("checkpoint child ordinary timing rejects non-healthy or non-durable DB invocations before parents", () => {
  for (const options of [{ child: "storage" }, { generation: "legacy-absent" }, { profile: "fence-drift" },
    { writer: "stale" }, { stub: "db-source-monitor-stall" }]) {
    const result = runCheckpointTiming(options);
    assert.ifError(result.error);
    assert.equal(result.status, 1, JSON.stringify(options) + result.stderr);
    assert.equal(result.stdout, "\n");
    assert.equal(result.stderr, "\n");
  }
});

test("checkpoint PGSQL trace generation strips to the current original child/lib and covers every monitor failure arm", () => {
  // Run the actual generator with writes redirected to process-local memory.
  // It reads the original sources but creates no fixture or native actor.
  const generator = heredoc("CHECKPOINT_PGSQL_NATIVE_TRACE_GENERATE");
  const input = generator.replace('const fs = require("node:fs");', String.raw`
const originalFs = require("node:fs");
const files = new Map();
const fs = { ...originalFs,
  existsSync(file) { if (file !== process.argv[4]) throw new Error("unexpected existence probe"); return false; },
  mkdirSync(file) { if (file !== process.argv[4] + "/deployment/lib") throw new Error("unexpected directory"); },
  writeFileSync(file, bytes) { if (!file.startsWith(process.argv[4] + "/") || files.has(file)) throw new Error("unexpected write"); files.set(file, bytes); }
};
`) + '\nprocess.stdout.write(JSON.stringify(Object.fromEntries(files)));\n';
  const root = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
  const result = spawnSync(process.execPath, ["-", root, suiteUrl.pathname, "/virtual-pgsql-trace"], {
    input, encoding: "utf8", timeout: 5000
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const files = JSON.parse(result.stdout);
  const manifest = JSON.parse(files["/virtual-pgsql-trace/instrumentation.json"]);
  for (const [file, name, original] of [["child", "deployment/backup-retdb.sh", backup],
    ["library", "deployment/lib/recovery-safety.sh", library]]) {
    let stripped = files[`/virtual-pgsql-trace/${name}`];
    for (const hook of manifest.insertions.filter(item => item.file === file)) stripped = stripped.replace("\n" + hook.line + "\n", "\n");
    assert.equal(stripped, original, "removing insert-only hooks retains literal current source");
  }
  const failureHooks = manifest.insertions.filter(item => item.file === "child" &&
    item.line.includes('checkpoint_pgsql_native_trace_record monitor-stop "$progress" 1'));
  assert.equal(failureHooks.length, monitor.split("\n      return 1\n").length - 1);
  assert.equal(failureHooks.length, 4);
});

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

test("one measured round retains current pre-publication checks, including STOP/guardian, not the owned publisher lifecycle", () => {
  const start = monitor.indexOf("    require_backup_guard || {\n");
  const end = monitor.indexOf("    progress=$((progress + 1))\n");
  assert.equal(parts.round, monitor.slice(start, end));
  assert.equal(parts.round, '    require_backup_guard || {\n' +
    '      record_pgsql_source_monitor_failure "${DB_BACKUP_GUARD_FAILURE_REASON:-backup-guard}"\n' +
    '      return 1\n    }\n    require_exact_pgsql_source_now || {\n' +
    '      record_pgsql_source_monitor_failure pgsql-source\n      return 1\n    }\n' +
    '    [[ ! -e "$DB_SOURCE_MONITOR_STOP" ]] || return 0\n' +
    '    db_source_guardian_is_usable || {\n' +
    '      record_pgsql_source_monitor_failure source-guardian\n      return 1\n    }\n');
  // This fragment excludes publication/poll and does not construct the owned
  // publisher, its guardian or its joins. Literal extraction is not evidence
  // that the standalone measurement executes a complete publisher lifecycle.
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
  assert.match(measure, /else\n  if \[\[ "\$round_status" == 0 \]\]; then\n    pgsql_guard_round_native_publish_poll\n  fi\nfi\nexit "\$round_status"/);
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
  const result = runExtractor("0", injected);
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /non-unique extraction anchor/);
});

function stripProfile(text) {
  for (const insertion of profiledParts.profile.insertions) text = text.replace("\n" + insertion, "\n");
  return text;
}
function runPureHooks(body) {
  // Actual builtin clock/arithmetic hooks only, without the native fixture,
  // clocks replaced, validators, parents or persistence.
  return spawnSync("bash", ["-c", "set -euo pipefail\n" + profileHelpers + "\n" + body], {
    encoding: "utf8", timeout: 5000
  });
}
function probeBash(command) {
  const script = ["clock=0",
    'if [[ "${EPOCHREALTIME:-}" =~ ^[0-9]{1,12}\\.[0-9]{6}$ ]]; then clock=1; fi',
    "printf '%s\\t%s\\t%s\\n' \"${BASH_VERSINFO[0]}\" \"${BASH_VERSINFO[1]}\" \"$clock\""
  ].join("\n");
  const result = spawnSync(command, ["-c", script], { encoding: "utf8", timeout: 5000 });
  if (result.error?.code === "ENOENT") return null;
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const match = result.stdout.match(/^(\d+)\t(\d+)\t([01])\n$/);
  assert.ok(match, "actual selected Bash version and clock capability");
  return { command, major: Number(match[1]), minor: Number(match[2]), clock: match[3] === "1" };
}
const selectedBash = probeBash("bash");
assert.ok(selectedBash, "the baseline Bash interpreter must be available from PATH");
const olderBash = [selectedBash, ...["/bin/bash", "/usr/bin/bash"].map(probeBash)]
  .find(candidate => candidate && candidate.major < 5);
const clockPositiveOptions = {
  skip: selectedBash.major < 5 ? `selected Bash ${selectedBash.major}.${selectedBash.minor} has no Bash 5 builtin clock` : false
};

test("disabled profiling keeps original fragments and emits no profile instrumentation", () => {
  assert.equal(parts.profile, undefined);
  for (const key of Object.keys(parts)) assert.equal(profiledParts[key], parts[key]);
  assert.match(native, /if \[\[ "\$\{YENHUBS_PGSQL_ROUND_PROFILE:-0\}" == 1 \]\] &&\n\s*\(\(BASH_VERSINFO\[0\] < 5\)\)/);
  assert.match(native, /if \$profile == "1" then \.profile\.guards else \.guards end/);
  assert.match(native, /if \$profile == "1" then \.profile\.round else \.round end/);
  assert.match(native, /if \$profile == "1" then \.profile\.publish_poll else \.publish_poll end/);
});

test("stripping every defined profile hook recovers every original check and failure arm byte for byte", () => {
  for (const key of ["guards", "round", "publish_poll"])
    assert.equal(stripProfile(profiledParts.profile[key]), parts[key], key);
  const hooks = profiledParts.profile.insertions;
  assert.equal(hooks.length, 8);
  for (const hook of hooks) {
    const combined = ["guards", "round", "publish_poll"].map(key => profiledParts.profile[key]).join("\n");
    assert.equal(combined.split("\n" + hook).length, 2, "each exact insertion has one location");
  }
  const guard = profiledParts.profile.guards;
  const stages = [...guard.matchAll(/pgsql_round_profile_begin ([a-z-]+) /g)].map(match => match[1]);
  assert.deepEqual(stages, ["operation-lock", "consumers", "parent-capability", "durable-capability"]);
  assert.match(guard, /pgsql_round_profile_begin consumers[^\n]*\n  for deployment in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do/);
  assert.match(guard, /pgsql_round_profile_end 0[^\n]*\n  DB_BACKUP_GUARD_FAILURE_REASON=""/);
  assert.match(profiledParts.profile.round, /pgsql_round_profile_begin pgsql-identity[^\n]*\n    require_exact_pgsql_source_now \|\| \{/);
  assert.match(profiledParts.profile.publish_poll, /pgsql_round_profile_end 0[^\n]*\n    sleep "\$DB_SOURCE_MONITOR_POLL_SECONDS"/);
  const script = parts.preamble + parts.capabilities + "\n" + profiledParts.profile.guards + "\n" + parts.identity +
    "pgsql_guard_round_native_once() {\n" + profiledParts.profile.round + "}\n" +
    "pgsql_guard_round_native_publish_poll() {\n  local progress=0\n" + profiledParts.profile.publish_poll + "}\n" +
    profileHelpers + "\n" + measure;
  const syntax = spawnSync("bash", ["-n", "-s"], { input: script, encoding: "utf8", timeout: 5000 });
  assert.ifError(syntax.error);
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("ambiguous stage anchors and dropped failure arms are rejected before fixture effects", () => {
  const duplicate = extractor.replace('const backup = fs.readFileSync(process.argv[3], "utf8");',
    'const backup = fs.readFileSync(process.argv[3], "utf8").replace("  recovery_require_operation_lock || {", "  recovery_require_operation_lock || {\\n  recovery_require_operation_lock || {");');
  const duplicated = runExtractor("1", duplicate);
  assert.ifError(duplicated.error);
  assert.notEqual(duplicated.status, 0);
  assert.equal(duplicated.stdout, "");
  assert.match(duplicated.stderr, /non-unique extraction anchor/);
  const dropped = runExtractor("1", extractor.replace("let stripped = generated;",
    'generated = generated.replace("    return 1\\n", "");\n    let stripped = generated;'));
  assert.ifError(dropped.error);
  assert.notEqual(dropped.status, 0);
  assert.equal(dropped.stdout, "");
  assert.match(dropped.stderr, /profile stripping changed native source/);
});

test("profile hooks retain the static privacy contract and reject unknown stage labels", () => {
  assert.match(profileHelpers, /local timestamp="\$\{EPOCHREALTIME:-\}"/);
  assert.doesNotMatch(profileHelpers, /\b(?:node|python3?|date|sleep|exec|env)\b|\$\((?!\()|set -x|BASH_COMMAND|PS4|EPOCHREALTIME=/);
  assert.doesNotMatch(profileHelpers, /OUTPUT_DIR|ROOT_DIR|NAMESPACE|PID|READY_PATH/);
  const unknown = runPureHooks('pgsql_round_profile_begin private-sentinel\nprintf "invalid=%s\\n" "$PGSQL_ROUND_PROFILE_INVALID"\n');
  assert.ifError(unknown.error);
  assert.equal(unknown.status, 0, unknown.stderr);
  assert.equal(unknown.stdout, "PGSQL_ROUND_PROFILE stage=profile-invalid status=2 valid=0\ninvalid=1\n");
  assert.doesNotMatch(unknown.stdout + unknown.stderr, /private-sentinel/);
});

test("Bash 5 builtin clock emits valid numeric stage duration and status", clockPositiveOptions, () => {
  assert.equal(selectedBash.clock, true, "selected Bash 5 or newer must expose its real builtin clock");
  const result = runPureHooks('pgsql_round_profile_begin operation-lock\npgsql_round_profile_end 7\nprintf "invalid=%s\\n" "$PGSQL_ROUND_PROFILE_INVALID"\n');
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^PGSQL_ROUND_PROFILE stage=operation-lock elapsed_us=[0-9]+ status=7 valid=1\ninvalid=0\n$/);
  assert.equal(result.stderr, "");
});

test("invalid and negative elapsed inputs reject without a fake clock or fabricated duration", () => {
  const result = runPureHooks(String.raw`
pgsql_round_profile_elapsed 100 125
[[ "$PGSQL_ROUND_PROFILE_ELAPSED" == 25 ]]
for pair in '125 100' 'bad 125' '100 bad' '100 9999999999999999999'; do
  read -r start end <<<"$pair"
  if pgsql_round_profile_elapsed "$start" "$end"; then exit 99; fi
done
pgsql_round_profile_begin pgsql-identity
PGSQL_ROUND_PROFILE_START=bad
pgsql_round_profile_end 1
printf 'invalid=%s\n' "$PGSQL_ROUND_PROFILE_INVALID"
`);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "PGSQL_ROUND_PROFILE stage=pgsql-identity status=1 valid=0\ninvalid=1\n");
  assert.equal(result.stderr, "");
  assert.match(measure, /if \[\[ "\$round_status" == 0 && "\$PGSQL_ROUND_PROFILE_INVALID" == 0 \]\]; then/);
  assert.match(measure, /if \[\[ "\$round_status" == 0 && "\$PGSQL_ROUND_PROFILE_INVALID" != 0 \]\]; then\n    round_status=2/);
  assert.match(measure, /exit "\$round_status"$/);
});

test("hook overhead is a separate bounded builtin sample, never subtracted or included in the guard interval", () => {
  assert.ok(measure.indexOf("pgsql_round_profile_overhead") < measure.indexOf("time pgsql_guard_round_native_once"));
  assert.match(profileHelpers, /for \(\(sample=0; sample<100; sample\+\+\)\)/);
  assert.match(profileHelpers, /done >\/dev\/null/);
  assert.match(profileHelpers, /overhead_includes-loop overhead_excludes-real-output-I\/O no-SLO no-historical-cause/);
  assert.match(profileHelpers, /clock=EPOCHREALTIME-wall-may-adjust elapsed=unadjusted stage_edges=hooks-plus-shell-housekeeping overhead_samples=100/);
  assert.doesNotMatch(parts.round + profiledParts.profile.round, /overhead/);
});

test("Bash 5 builtin clock measures the actual bounded hook overhead", clockPositiveOptions, () => {
  assert.equal(selectedBash.clock, true, "selected Bash 5 or newer must expose its real builtin clock");
  const result = runPureHooks("pgsql_round_profile_overhead\n");
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^PGSQL_ROUND_PROFILE stage=hook-overhead samples=100 elapsed_us=[0-9]+ status=0 valid=1\nPGSQL_ROUND_PROFILE_LIMITS [^\n]+\n$/);
  assert.equal(result.stderr, "");
});

test("an available older Bash also rejects publisher-owned standalone profiling before fixture effects", {
  skip: !olderBash ? "no older Bash interpreter is available for the real rejection check" : false
}, () => {
  assert.ok(native.indexOf("((BASH_VERSINFO[0] < 5))") < native.indexOf('mkdir -p "$case_root/deployment"'));
  // The incompatibility precedes even the old version/profile check. Keep
  // compatible pure hooks, but do not grant old Bash a partial native path.
  const result = spawnSync(olderBash.command, ["-c", 'set -euo pipefail\nTMP_DIR=/dev/null ROOT_DIR=/dev/null\n' +
    checkpointSelector + '\n' + native + '\nrun_pgsql_guard_round_native\n'], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, YENHUBS_PGSQL_ROUND_PROFILE: "1",
      YENHUBS_RECOVERY_TEST_FOCUS: "pgsql-guard-round-native" }, encoding: "utf8", timeout: 5000
  });
  assert.ifError(result.error);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, standaloneUnavailable);
});

test("invalid profiling never changes native nonzero exits to success", () => {
  const rejection = measure.match(/  if \[\[ "\$round_status" == 0 && "\$PGSQL_ROUND_PROFILE_INVALID" != 0 \]\]; then\n    round_status=2\n  fi/);
  assert.ok(rejection, "actual final rejection decision");
  const result = runPureHooks('for round_status in 0 1 7 143; do\n  PGSQL_ROUND_PROFILE_INVALID=1\n' +
    rejection[0] + '\n  printf "%s\\n" "$round_status"\ndone\n');
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "2\n1\n7\n143\n");
  assert.equal(result.stderr, "");
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const driver = fs.readFileSync(path.join(root, "deployment/create-checkpoint.sh"), "utf8");
const shell = process.env.YENHUBS_TEST_BASH || "bash";
const stamp = "20261003-010000";
function fn(name, alias = name) {
  const match = driver.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, "m"));
  assert.ok(match, `production function ${name}`);
  return match[0].replace(`${name}()`, `${alias}()`);
}
function section(start, end) {
  const first = driver.indexOf(start), last = driver.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `production section ${start}`);
  return driver.slice(first, last);
}
const initialization = section('OUTPUT_DIR=""\n', "# shellcheck source=") +
  section("CONSUMERS=(", "checkpoint_timing_transition() {");
const terminalStart = driver.indexOf("checkpoint_set_failure_context final-claim claim\n");
assert.ok(terminalStart >= 0, "real terminal publication sequence");
const terminal = driver.slice(terminalStart);
const functions = [
  "checkpoint_artifacts", "checkpoint_timing_transition", "checkpoint_report_timing",
  "checkpoint_failure_context_is_safe", "checkpoint_set_failure_context",
  "checkpoint_record_pending_signal", "restore_checkpoint_signal_traps",
  "finish_checkpoint_local_capability_boundary", "checkpoint_uses_freeze_admission_fence",
  "claim_final_output_directory", "checkpoint_directory_cleanup_allowlist",
  "cleanup_checkpoint_staging_directory", "cleanup_checkpoint_final_claim",
  "cleanup_checkpoint_durable_monitor", "cleanup_checkpoint_writer_monitor", "cleanup_runner_monitor",
  "release_lock_if_safe", "release_serialization_if_owned", "checkpoint_report_resume_failure",
  "resume_writers_with_single_reentry", "checkpoint_error", "checkpoint_interrupted",
  "acquire_checkpoint_publish_lock", "acquire_checkpoint_staging_directory"
].map(name => fn(name)).join("\n");
const artifacts = [
  "checkpoint-metadata.json", "configured-value-keys.txt", "database-contract.json",
  "deployment-images.json", "digitalocean-cluster.json", "digitalocean-load-balancers.json",
  "digitalocean-volumes.json", "git-state.txt", "k8s-configmaps-redacted.json",
  "k8s-hcce-structure.json", "runner-cutover-evidence.json",
  `retdb-${stamp}.sql.gz`, `ret-storage-${stamp}.tar.gz`
];

// This is a terminal-order regression, NOT the five real writer CAS/rollouts.
// Run the actual terminal source, claim/commit, SHA/layout validators, private
// directory tokens, cleanup and ERR/EXIT handlers. The entry fixture satisfies
// that terminal's exact artifact/hash contract; payload content validation,
// backup streams, monitor evidence and all cluster operations are out of scope.
// resume_writers is explicitly a stub. Its failure is persistent, so the real
// error handler's existing two bounded recovery attempts cannot hide a failure.
function run(mode) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "yenhubs-publication-order-")));
  fs.chmodSync(directory, 0o700);
  const input = path.join(directory, "input"), output = path.join(directory, "checkpoint");
  const eventsPath = path.join(directory, "events");
  fs.mkdirSync(input, { mode: 0o700 });
  let manifest = "";
  for (const name of artifacts) {
    const bytes = Buffer.from(`synthetic terminal payload: ${name}\n`);
    fs.writeFileSync(path.join(input, name), bytes, { mode: 0o600 });
    manifest += `${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`;
  }
  fs.writeFileSync(path.join(input, "SHA256SUMS"), manifest, { mode: 0o600 });
  fs.writeFileSync(eventsPath, "", { mode: 0o600 });
  const script = `set -Eeuo pipefail
umask 077
source deployment/lib/recovery-safety.sh
${initialization}
${functions}
${fn("checkpoint_validate_manifest", "production_validate_manifest")}
${fn("commit_final_output_directory", "production_commit_final_output_directory")}
${fn("cleanup_local_artifacts", "production_cleanup_local_artifacts")}
TIMESTAMP="$TEST_STAMP"
OUTPUT_PARENT="$TEST_DIRECTORY"
FINAL_OUTPUT_DIR="$TEST_OUTPUT"
PUBLISH_LOCK="\${FINAL_OUTPUT_DIR}.yenhubs-publish-lock"
CHECKPOINT_FORMAT=legacy
CHECKPOINT_RUNNER_MODE=process-local
CHECKPOINT_RUNNER_GENERATION=legacy-absent
VALUES_SOURCE_FILE=unused-terminal-fixture
evidence_fence_state=legacy-absent
evidence_manifest=unused-terminal-fixture
RECOVERY_OPERATION_ID=0123456789abcdef0123456789abcdef
WRITERS_MUTATED=1
OPERATION_LOCK_OWNED=1
SERIALIZATION_LEASE_OWNED=1
FIXTURE_PHASE=paused
FIXTURE_RESUME_CALLS=0
FIXTURE_LOCK_PRESENT=1
FIXTURE_LEASE_PRESENT=1
fixture_snapshot() {
  local event="$1" status="\${2:-0}" marker=0 token=0
  if [[ -f "$FINAL_OUTPUT_DIR/.yenhubs-incomplete" &&
        ! -L "$FINAL_OUTPUT_DIR/.yenhubs-incomplete" ]]; then
    [[ "$(<"$FINAL_OUTPUT_DIR/.yenhubs-incomplete")" == "yenhubs-incomplete:$RECOVERY_OPERATION_ID" ]] || return 96
    marker=1
  fi
  [[ -z "$FINAL_OUTPUT_DIR_PRIVATE_TOKEN" ]] || token=1
  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' \\
    "$event" "$FIXTURE_PHASE" "$marker" "$FINAL_CLAIM_OWNED" \\
    "$FINAL_PUBLICATION_COMMITTED" "$token" "$FIXTURE_RESUME_CALLS" \\
    "$WRITERS_MUTATED" "$CHECKPOINT_FAILURE_STAGE" "$CHECKPOINT_FAILURE_CODE" \\
    "$status" >>"$TEST_EVENTS"
}
checkpoint_validate_manifest() {
  local status=0
  fixture_snapshot manifest-before
  if production_validate_manifest "$@"; then :; else status=$?; fi
  fixture_snapshot manifest-after "$status"
  return "$status"
}
commit_final_output_directory() {
  fixture_snapshot publication-before
  production_commit_final_output_directory
  fixture_snapshot publication-after
}
cleanup_local_artifacts() {
  fixture_snapshot cleanup-before
  production_cleanup_local_artifacts
  fixture_snapshot cleanup-after
}
# Every remote/monitor peer needed by this terminal has a closed local stub.
recovery_kubectl() { printf 'unexpected_remote_call\\n' >&2; return 97; }
recovery_require_operation_serialization() {
  fixture_snapshot serialization-check
  [[ "$FIXTURE_LEASE_PRESENT" == 1 ]]
}
recovery_require_operation_lock() {
  fixture_snapshot operation-lock-check
  [[ "$FIXTURE_LOCK_PRESENT" == 1 ]]
}
recovery_release_operation_lock() {
  fixture_snapshot operation-lock-release
  [[ "$WRITERS_MUTATED" == 0 && "$FIXTURE_LOCK_PRESENT" == 1 ]] || return 97
  FIXTURE_LOCK_PRESENT=0
}
recovery_release_operation_serialization() {
  fixture_snapshot serialization-release
  [[ "$FIXTURE_LEASE_PRESENT" == 1 ]] || return 97
  FIXTURE_LEASE_PRESENT=0
}
handoff_runner_monitor() { fixture_snapshot runner-handoff; }
require_checkpoint_writer_monitor_healthy() { fixture_snapshot writer-monitor; }
stop_checkpoint_durable_monitor_before_writer_monitor() { fixture_snapshot durable-stop; }
stop_checkpoint_writer_monitor_before_resume() { fixture_snapshot writer-stop; }
recovery_verify_runner_cutover_evidence_live() {
  [[ "$2" == "$FINAL_OUTPUT_DIR/runner-cutover-evidence.json" &&
     "$3" == "$FINAL_OUTPUT_DIR/deployment-images.json" && "$6" == checkpoint ]] || return 97
  fixture_snapshot cutover-evidence
}
resume_writers() {
  FIXTURE_RESUME_CALLS=$((FIXTURE_RESUME_CALLS + 1))
  fixture_snapshot resume-before
  if [[ "$TEST_MODE" == resume-failure ]]; then
    fixture_snapshot resume-failed 7
    return 7
  fi
  if [[ "$TEST_MODE" == postresume-hash-failure ]]; then
    printf 'changed during resume\\n' >>"$FINAL_OUTPUT_DIR/database-contract.json"
  fi
  WRITERS_MUTATED=0
  FIXTURE_PHASE=resumed
  fixture_snapshot resume-after
}
trap cleanup_local_artifacts EXIT
trap checkpoint_error ERR
trap 'checkpoint_interrupted 130' INT
trap 'checkpoint_interrupted 143' TERM
acquire_checkpoint_publish_lock
acquire_checkpoint_staging_directory
for artifact in "$TEST_INPUT"/*; do cp "$artifact" "$OUTPUT_DIR/"; done
# The actual manifest validator must admit this positive entry BEFORE any
# injected resume failure; fixture setup must not be mistaken for the RED.
checkpoint_validate_manifest "$OUTPUT_DIR"
fixture_snapshot entry-valid
${terminal}
`;
  try {
    const result = spawnSync(shell, ["--noprofile", "--norc", "-c", script], {
      cwd: root, encoding: "utf8", timeout: 30000,
      env: { PATH: process.env.PATH || "/usr/bin:/bin", LC_ALL: "C", LANG: "C", TZ: "UTC",
        TEST_DIRECTORY: directory, TEST_INPUT: input, TEST_OUTPUT: output,
        TEST_EVENTS: eventsPath, TEST_STAMP: stamp, TEST_MODE: mode }
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, "the terminal must exit itself, not time out or be signalled");
    const names = ["event", "phase", "marker", "owned", "committed", "token", "resumeCalls", "writers", "stage", "code", "status"];
    const events = fs.readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map(line => {
      const values = line.split("\t");
      assert.equal(values.length, names.length, `complete observation: ${line}`);
      return Object.fromEntries(names.map((name, index) => [name, values[index]]));
    });
    assert.ok(events.some(event => event.event === "entry-valid"),
      `real SHA/layout entry must reach the terminal: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /unexpected_remote_call|unbound variable|command not found|private directory operation failed/);
    const files = fs.existsSync(output) ? fs.readdirSync(output).sort() : null;
    return { ...result, events, files };
  } finally {
    // Only this test's newly created synthetic, private fixture is retired.
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
function assertUnpublished(event) {
  assert.ok(event, "the claimed-path boundary must be observed");
  assert.equal(event.marker, "1", `${event.event}: incomplete marker is still present`);
  assert.equal(event.owned, "1", `${event.event}: cleanup still owns the exact claim`);
  assert.equal(event.committed, "0", `${event.event}: publication is not committed`);
  assert.equal(event.token, "1", `${event.event}: private claim capability is retained`);
}

test("successful terminal resumes, revalidates postconditions, then publishes once", () => {
  const r = run("success");
  assert.equal(r.status, 0, r.stderr);
  const resume = r.events.find(event => event.event === "resume-before");
  assert.ok(resume, "positive terminal reaches resume");
  assertUnpublished(resume);
  const resumed = r.events.findIndex(event => event.event === "resume-after");
  const checked = r.events.findIndex(event => event.event === "manifest-after" && event.phase === "resumed" && event.status === "0");
  const committing = r.events.findIndex(event => event.event === "publication-before");
  assert.ok(resumed >= 0 && checked > resumed && committing > checked,
    "actual terminal order must be resume -> real postresume manifest check -> marker commit");
  for (const guard of ["serialization-check", "operation-lock-check"]) {
    const index = r.events.findIndex(event => event.event === guard && event.phase === "resumed");
    assert.ok(index > resumed && index < committing, `${guard} is repeated after resume, before commit`);
    assertUnpublished(r.events[index]);
  }
  assertUnpublished(r.events[checked]);
  assertUnpublished(r.events[committing]);
  const committed = r.events.filter(event => event.event === "publication-after");
  assert.equal(committed.length, 1);
  assert.equal(committed[0].marker, "0");
  assert.equal(committed[0].owned, "0");
  assert.equal(committed[0].committed, "1");
  assert.equal(committed[0].resumeCalls, "1", "no cleanup-triggered resume retry on success");
  assert.deepEqual(r.files, [...artifacts, "SHA256SUMS"].sort());
  assert.match(r.stdout, /Complete quiescent YenHubs checkpoint published:/);
});

test("resume failure retains marker and cleanup ownership until failed-terminal cleanup", () => {
  const r = run("resume-failure");
  assert.equal(r.status, 7, "real ERR/EXIT handlers must preserve the original failed status");
  const failed = r.events.filter(event => event.event === "resume-failed");
  assert.equal(failed.length, 3, "one terminal attempt plus the real error handler's two explicit bounded attempts");
  for (const event of failed) assertUnpublished(event);
  assertUnpublished(r.events.find(event => event.event === "cleanup-before"));
  assert.equal(r.events.some(event => event.event === "publication-after"), false);
  assert.equal(r.files, null, "real capability-bound cleanup retires the incomplete claim");
  assert.doesNotMatch(r.stdout, /Complete quiescent YenHubs checkpoint published:/);
});

test("postresume hash postcondition failure never commits an apparently complete checkpoint", () => {
  const r = run("postresume-hash-failure");
  assert.equal(r.status, 1, "the actual postresume SHA validator must reject the injected changed bytes");
  const failed = r.events.find(event => event.event === "manifest-after" && event.phase === "resumed" && event.status === "1");
  assert.ok(failed, "observe the real validator's failure, not a textual ordering match");
  assertUnpublished(failed);
  assertUnpublished(r.events.find(event => event.event === "cleanup-before"));
  assert.equal(r.events.filter(event => event.event === "resume-before").length, 1,
    "postcondition failure after successful resume must not trigger another resume");
  assert.equal(r.events.some(event => event.event === "publication-after"), false);
  assert.equal(r.files, null, "failed postcondition cannot leave a complete-looking artifact directory");
  assert.match(r.stderr, /SHA256SUMS verification failed for database-contract.json/);
  assert.doesNotMatch(r.stdout, /Complete quiescent YenHubs checkpoint published:/);
});

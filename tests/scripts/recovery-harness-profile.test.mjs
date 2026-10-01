import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const harness = readFileSync(resolve(root, "tests/recovery/test-recovery-safety.sh"), "utf8");
const helper = resolve(root, "tests/recovery/lib/harness-profile.sh");
const functions = ["pass", "fail", "expect_success", "expect_failure", "expect_failure_status"]
  .map(name => {
    const definition = harness.match(new RegExp(`^${name}\\(\\) \\{[^\\n]*\\}`, "m")) ??
      harness.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"));
    assert.ok(definition, `existing harness function ${name}`);
    return definition[0];
  }).join("\n");

function run(output, flag = "1", mode = "success", seedMatches = true) {
  const command = mode === "success"
    ? `expect_success 'profiled command' printf '%s' "$input"`
    : mode === "failure"
      ? `expect_failure 'expected failure' 'expected fixture failure' bash -c 'printf "%s" "$1"; exit 13' _ "$input"`
      : mode === "status"
        ? `expect_failure_status 'expected status' 'expected fixture failure' 13 bash -c 'printf "%s" "$1"; exit 13' _ "$input"`
        : `expect_failure_status 'expected status' 'expected fixture failure' 13 printf '%s' "$input"`;
  const result = spawnSync("bash", ["-c", `set -euo pipefail
PASS_COUNT=0; FAIL_COUNT=0; LAST_OUTPUT=''
${existsSync(helper) ? `source '${helper}'` : ""}
${functions}
input="$(cat)"
${seedMatches ? "[[ 'original-match' =~ (original-match) ]]" : "BASH_REMATCH=()"}
${command}
[[ "$LAST_OUTPUT" == "$input" ]]
${seedMatches ? "[[ \"${BASH_REMATCH[1]}\" == 'original-match' ]]" : "[[ \"${#BASH_REMATCH[@]}\" == 0 ]]"}
printf 'CAPTURE_UNCHANGED=1 PASS=%s FAIL=%s\\n' "$PASS_COUNT" "$FAIL_COUNT"
`], { input: output, encoding: "utf8", env: { ...process.env, YENHUBS_RECOVERY_TEST_PROFILE: flag } });
  assert.equal(result.status, 0, result.stderr);
  if (mode === "wrong-status") assert.match(result.stderr, /not ok 1 - expected status/);
  return result.stdout;
}

const timing = (stage, result = "complete") =>
  `YENHUBS_TIMING operation=checkpoint stage=${stage} stage_seconds=2 total_seconds=10 result=${result}`;

test("profile is opt-in and keeps successful captured output unchanged", () => {
  const result = run(timing("quiescence"), "0");
  assert.doesNotMatch(result, /YENHUBS_TIMING/);
  assert.match(result, /CAPTURE_UNCHANGED=1 PASS=1 FAIL=0/);
});

test("successful checkpoint exposes its closed phase metrics only", () => {
  const lines = ["private fixture content", timing("quiescence"), timing("database-backup"), timing("storage-backup"), timing("local-cleanup", "success")];
  const result = run(lines.join("\n"));
  for (const line of lines.slice(1)) assert.ok(result.includes(`RECOVERY_TEST_PROFILE ${line}\n`));
  assert.doesNotMatch(result, /private fixture content/);
  assert.match(result, /CAPTURE_UNCHANGED=1 PASS=1 FAIL=0/);
});

test("profile keeps expected failures and their status oracles", () => {
  for (const mode of ["failure", "status"]) {
    const result = run(`expected fixture failure\n${timing("resume", "failure")}`, "1", mode);
    assert.ok(result.includes(`RECOVERY_TEST_PROFILE ${timing("resume", "failure")}\n`));
    assert.match(result, /CAPTURE_UNCHANGED=1 PASS=1 FAIL=0/);
    assert.doesNotMatch(result, /expected fixture failure/);
  }
});

test("profile accepts every current checkpoint phase and terminal result", () => {
  const stages = ["pre-publication", "quiescence", "database-backup", "storage-backup", "content-validation", "checksum-manifest", "staging-verification", "final-claim", "artifact-transfer", "claimed-verification", "terminal-boundary", "precommit", "publication", "resume", "lock-release", "serialization-release", "local-cleanup"];
  const lines = stages.map(stage => timing(stage));
  lines.push(timing("resume", "interrupted"));
  const result = run(lines.join("\n"));
  assert.equal(result.split("\n").filter(line => line.startsWith("RECOVERY_TEST_PROFILE ")).length, lines.length);
});

test("unknown stages and results cannot leak through the metric channel", () => {
  const result = run([timing("private-fixture-label"), timing("resume", "private-fixture-label")].join("\n"));
  assert.doesNotMatch(result, /RECOVERY_TEST_PROFILE|private-fixture-label/);
});

test("extra fields, prefixes and control characters cannot leak through", () => {
  const valid = timing("quiescence");
  const result = run([`${valid} token=private-fixture-content`, `prefix ${valid}`, `${valid}\r`, `${valid}\u001b[31m`, valid].join("\n"));
  assert.equal(result.split("\n").filter(line => line.startsWith("RECOVERY_TEST_PROFILE ")).length, 1);
  assert.doesNotMatch(result, /private-fixture-content|\u001b|\r/);
});

test("invalid, negative and unbounded counters are not emitted", () => {
  const valid = timing("quiescence");
  const result = run([valid.replace("stage_seconds=2", "stage_seconds=-2"), valid.replace("total_seconds=10", "total_seconds=private"), valid.replace("stage_seconds=2", "stage_seconds=9999999999"), valid].join("\n"));
  assert.equal(result.split("\n").filter(line => line.startsWith("RECOVERY_TEST_PROFILE ")).length, 1);
});

test("invalid opt-in values do not turn profiling on", () => {
  for (const flag of ["", "true", "01", "2"]) assert.doesNotMatch(run(timing("resume"), flag), /RECOVERY_TEST_PROFILE/);
});

test("diagnostic output does not convert an unexpected command status to PASS", () => {
  const result = run(`expected fixture failure\n${timing("resume", "success")}`, "1", "wrong-status");
  assert.match(result, /CAPTURE_UNCHANGED=1 PASS=0 FAIL=1/);
});

test("profiling also preserves an initially empty regex match array", () => {
  const result = run(timing("resume"), "1", "success", false);
  assert.ok(result.includes(`RECOVERY_TEST_PROFILE ${timing("resume")}\n`));
});

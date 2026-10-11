import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = readFileSync(new URL("../../deployment/create-monthly-snapshot.sh", import.meta.url), "utf8");

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "yenhubs-monthly-entrypoint-"));
  const entrypoint = join(directory, "create-monthly-snapshot.sh");
  writeFileSync(entrypoint, source, { mode: 0o700 });
  // Only this fixed adjacent coordinator is available. It records the selected
  // route and inherited guard inputs without accessing a cluster or private data.
  writeFileSync(join(directory, "create-checkpoint.sh"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' coordinator "$CHECKPOINT_BACKEND" "$CHECKPOINT_FORMAT" "$#" "$1" \\
  "$EXPECTED_KUBE_CONTEXT" "$MONTHLY_JOURNAL_ROOT" "$ALLOW_CHECKPOINT_DOWNTIME"
exit "\${FIXTURE_COORDINATOR_STATUS:-0}"
`, { mode: 0o700 });
  const output = join(directory, "capture with spaces");
  const environment = { PATH: process.env.PATH, EXPECTED_KUBE_CONTEXT: "fixture-context",
    MONTHLY_JOURNAL_ROOT: join(directory, "journal"), ALLOW_CHECKPOINT_DOWNTIME: "1" };
  const run = (overrides = {}, args = [output]) => {
    const result = spawnSync("bash", [entrypoint, ...args], {
      env: { ...environment, ...overrides }, encoding: "utf8", timeout: 5000
    });
    assert.ifError(result.error);
    return result;
  };
  return { directory, output, environment, run };
}

test("fixed monthly entrypoint pins the native backend and delegates guard inputs exactly once", () => {
  const f = fixture();
  for (const environment of [{}, { CHECKPOINT_BACKEND: "native-monthly", CHECKPOINT_FORMAT: "native-monthly-v1" }]) {
    const result = f.run(environment);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(result.stdout.trimEnd().split("\n"), ["coordinator", "native-monthly", "legacy", "1", f.output,
      f.environment.EXPECTED_KUBE_CONTEXT, f.environment.MONTHLY_JOURNAL_ROOT, "1"]);
  }
});

test("legacy, empty and conflicting selectors are rejected before the coordinator runs", () => {
  const f = fixture();
  for (const environment of [
    { CHECKPOINT_BACKEND: "legacy" }, { CHECKPOINT_BACKEND: "" }, { CHECKPOINT_BACKEND: "sql" },
    { CHECKPOINT_FORMAT: "legacy" }, { CHECKPOINT_FORMAT: "" }, { CHECKPOINT_FORMAT: "durable-v2" },
    { CHECKPOINT_FORMAT: "freeze-bundle-v1" }, { CHECKPOINT_FORMAT: "freeze-bundle-v2" },
    { CHECKPOINT_BACKEND: "legacy", CHECKPOINT_FORMAT: "native-monthly-v1" }
  ]) {
    const result = f.run(environment);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Monthly snapshots require CHECKPOINT_(BACKEND|FORMAT)=/);
  }
});

test("monthly entrypoint refuses missing, relative or extra output arguments before capture", () => {
  const f = fixture();
  for (const args of [[], ["relative"], [f.output, "extra"]]) {
    const result = f.run({}, args);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Usage: create-monthly-snapshot.sh/);
  }
});

test("the original coordinator's nonzero native exit is preserved without retry or fallback", () => {
  const f = fixture(), result = f.run({ FIXTURE_COORDINATOR_STATUS: "23" });
  assert.equal(result.status, 23, result.stderr);
  assert.equal(result.stdout.split("\n").filter(line => line === "coordinator").length, 1);
  assert.equal(result.stderr, "");
  assert.match(source, /exec env CHECKPOINT_BACKEND=native-monthly CHECKPOINT_FORMAT=legacy \\\n\s+"\$SCRIPT_DIR\/create-checkpoint\.sh" "\$1"/);
});

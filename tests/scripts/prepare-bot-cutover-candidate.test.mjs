import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("private runner image update accepts only the exact digest repository and preserves other values", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "yenhubs-runner-values-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "values.yaml");
  fs.writeFileSync(file, 'Namespace: "hcce"\nPERMS_KEY: "fixture-not-a-secret"\n', { mode: 0o600 });
  const script = new URL("../../deployment/prepare-bot-cutover-candidate.mjs", import.meta.url);
  const invoke = value => spawnSync(process.execPath, [script.pathname, "--set", file, "OVERRIDE_BOT_RUNNER_IMAGE", value], { encoding: "utf8" });
  const image = `ghcr.io/yengalvez/bot-runner@sha256:${"a".repeat(64)}`;
  const accepted = invoke(image);
  assert.equal(accepted.status, 0, accepted.stderr);
  const content = fs.readFileSync(file, "utf8");
  assert.ok(content.includes(`OVERRIDE_BOT_RUNNER_IMAGE: "${image}"`));
  assert.ok(content.includes('PERMS_KEY: "fixture-not-a-secret"'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(accepted.stdout.includes("fixture-not-a-secret"), false);
  for (const invalid of ["ghcr.io/yengalvez/bot-runner:latest", image.replace("bot-runner", "hubs"), `${image}/suffix`]) {
    assert.equal(invoke(invalid).status, 2);
    assert.equal(fs.readFileSync(file, "utf8"), content);
  }
});

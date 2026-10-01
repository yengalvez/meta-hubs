import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const driver = fileURLToPath(new URL("../../scripts/verify-project.sh", import.meta.url));
const assetPath = "https://assets.example.invalid/hubs/";
const server = "hubs.example.invalid";
const shells = [...new Set(["/bin/bash", "/opt/homebrew/bin/bash"].filter(path => {
  const probe = spawnSync(path, ["--version"], { encoding: "utf8" });
  return probe.status === 0;
}))];

const command = [
  'source "$1"',
  'ROOT_DIR="$2"',
  'npm() {',
  '  printf "%s|%s|%s|%s\\n" "${PWD##*/}" "$*" "${BASE_ASSETS_PATH-UNSET}" "${RETICULUM_SERVER-UNSET}"',
  '  if [[ "$*" == test && "${PWD##*/}" == "${FAIL_UNIT_STAGE-none}" ]]; then return 97; fi',
  '}',
  "run_hubs",
  'printf "parent|%s|%s\\n" "${BASE_ASSETS_PATH-UNSET}" "${RETICULUM_SERVER-UNSET}"'
].join("\n");

function runFixture(t, shell, hasBuildValues, failingStage) {
  const fixture = mkdtempSync(join(tmpdir(), "yenhubs-hubs-build-env-test-"));
  mkdirSync(join(fixture, "hubs", "admin"), { recursive: true });
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: fixture, TMPDIR: fixture, LANG: "C", LC_ALL: "C" };
  if (hasBuildValues) Object.assign(env, { BASE_ASSETS_PATH: assetPath, RETICULUM_SERVER: server });
  if (failingStage) env.FAIL_UNIT_STAGE = failingStage;
  const result = spawnSync(shell, ["-c", command, "_", driver, fixture], {
    env,
    cwd: resolve(fixture),
    encoding: "utf8",
    timeout: 10000
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return { result, rows: result.stdout.trim().split("\n") };
}

function expectedCalls(hasBuildValues) {
  const values = hasBuildValues ? `${assetPath}|${server}` : "UNSET|UNSET";
  return [
    `hubs|ci|${values}`,
    "hubs|test|UNSET|UNSET",
    `hubs|run build|${values}`,
    `admin|ci --legacy-peer-deps|${values}`,
    "admin|test|UNSET|UNSET",
    `admin|run build|${values}`,
    `parent|${values}`
  ];
}

assert.ok(shells.length > 0, "an actual Bash is required");
for (const shell of shells) {
  test(`Hubs unit stages isolate deployment variables while both builds and parent retain them (${shell})`, t => {
    const { result, rows } = runFixture(t, shell, true);
    assert.equal(result.status, 0, result.stderr);
    // Inspect every observed call, not a mock return that errexit can ignore.
    assert.deepEqual(rows, expectedCalls(true));
  });

  test(`Hubs verification preserves absent deployment variables (${shell})`, t => {
    const { result, rows } = runFixture(t, shell, false);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(rows, expectedCalls(false));
  });

  test(`a failed Hubs or Admin unit stage prevents subsequent builds (${shell})`, t => {
    for (const stage of ["hubs", "admin"]) {
      const { result, rows } = runFixture(t, shell, false, stage);
      assert.equal(result.status, 97, result.stderr);
      assert.deepEqual(rows, expectedCalls(false).slice(0, stage === "hubs" ? 2 : 5));
    }
  });

  test(`Hubs receipt binds both build variables without changing Dialog or Reticulum (${shell})`, t => {
    const fixture = mkdtempSync(join(tmpdir(), "yenhubs-hubs-build-fingerprint-test-"));
    t.after(() => rmSync(fixture, { recursive: true, force: true }));
    const fingerprintCommand = [
      'source "$1"',
      "verification_section_harness_sha256 hubs",
      "verification_section_harness_sha256 dialog",
      "verification_section_harness_sha256 reticulum"
    ].join("\n");
    const fingerprints = values => {
      const env = { PATH: process.env.PATH, HOME: fixture, TMPDIR: fixture, LANG: "C", LC_ALL: "C", ...values };
      const result = spawnSync(shell, ["-c", fingerprintCommand, "_", driver], {
        env, encoding: "utf8", timeout: 10000
      });
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.equal(result.status, 0, result.stderr);
      const hashes = result.stdout.trim().split("\n");
      assert.equal(hashes.length, 3);
      for (const hash of hashes) assert.match(hash, /^[a-f0-9]{64}$/);
      return hashes;
    };
    const baseline = fingerprints({ BASE_ASSETS_PATH: assetPath, RETICULUM_SERVER: server });
    for (const values of [
      { BASE_ASSETS_PATH: `${assetPath}new/`, RETICULUM_SERVER: server },
      { BASE_ASSETS_PATH: assetPath, RETICULUM_SERVER: `new.${server}` }
    ]) {
      const changed = fingerprints(values);
      assert.notEqual(changed[0], baseline[0]);
      assert.deepEqual(changed.slice(1), baseline.slice(1));
    }
    const absent = fingerprints({});
    for (const values of [{ BASE_ASSETS_PATH: "" }, { RETICULUM_SERVER: "" }]) {
      const empty = fingerprints(values);
      assert.notEqual(empty[0], absent[0], "unset and present-empty must remain distinct");
      assert.deepEqual(empty.slice(1), absent.slice(1));
    }
  });
}

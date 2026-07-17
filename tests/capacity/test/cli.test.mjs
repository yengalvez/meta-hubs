import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPACITY_ROOT, canonicalJson, loadCatalogue, loadThresholds } from "../lib/io.mjs";
import { validateCatalogue, validateThresholds } from "../lib/schema.mjs";
import {
  buildTestPlan,
  makePassingEvidence,
  promoteFixtureEvidenceToPhysical,
  setRawThresholdMetric
} from "../test-support/fixtures.mjs";

const execFileAsync = promisify(execFile);
const cli = resolve(CAPACITY_ROOT, "bin/capacity.mjs");
const base = [
  cli,
  "run",
  "--scenario", "local-smoke",
  "--target", "http://localhost:4000/test-room",
  "--bots", "0"
];

test("run defaults to a profile-complete dry run and generates no load", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    ...base,
    "--client", "mobile",
    "--audio", "active",
    "--transport", "forced-turn"
  ], { env: { PATH: process.env.PATH ?? "" } });
  const result = JSON.parse(stdout);
  assert.equal(result.state, "DRY_RUN");
  assert.equal(result.execution, false);
  assert.equal(result.plan.run.executionEnabled, false);
  assert.deepEqual(result.plan.workload.media, {
    audio: "active",
    transport: "forced-turn",
    video: "disabled",
    screenShare: "disabled"
  });
  assert.equal(result.driver.implementation, "playwright");
  assert.equal(result.driver.maximumClientsPerShard, 2);
  assert.equal(result.driver.productionAllowed, false);
});

test("execution requires one immutable saved plan before importing or launching browsers", async () => {
  await assert.rejects(
    () => execFileAsync(process.execPath, [
      ...base,
      "--execute",
      "--ack-staging", "anything",
      "--collector-endpoint", "http://localhost:4318/v1/capacity-sample"
    ], { env: { PATH: process.env.PATH ?? "" } }),
    error => {
      const result = JSON.parse(error.stdout);
      return error.code === 2 && result.error.code === "PLAN_REQUIRED";
    }
  );
});

test("arbitrary driver injection and production targets remain hard denied", async () => {
  await assert.rejects(
    () => execFileAsync(process.execPath, [...base, "--driver", "/tmp/anything"], { env: { PATH: process.env.PATH ?? "" } }),
    error => JSON.parse(error.stdout).error.code === "ARGUMENT_INVALID"
  );
  await assert.rejects(
    () => execFileAsync(process.execPath, [
      cli,
      "run",
      "--scenario", "local-smoke",
      "--target", "https://staging.meta-hubs.org/test-room",
      "--bots", "0"
    ], { env: { PATH: process.env.PATH ?? "" } }),
    error => JSON.parse(error.stdout).error.code === "PRODUCTION_TARGET_DENIED"
  );
});

test("a threshold STOP exits nonzero while preserving the closed report", async () => {
  const scenarios = validateCatalogue(await loadCatalogue());
  const thresholds = validateThresholds(await loadThresholds());
  const plan = buildTestPlan({ scenarios });
  let evidence = makePassingEvidence(plan, thresholds);
  setRawThresholdMetric(evidence, thresholds, "runtime.oomCount", (_value, index) => index === 0 ? 0 : 1);
  evidence = promoteFixtureEvidenceToPhysical(plan, evidence);
  const rawSamples = evidence.raw.samples;
  delete evidence.raw.samples;
  const directory = await mkdtemp(join(tmpdir(), "capacity-stop-cli-"));
  const evidencePath = join(directory, "evidence.json");
  const planPath = join(directory, "plan.json");
  const rawPath = join(directory, "raw.ndjson");
  await writeFile(evidencePath, JSON.stringify(evidence));
  await writeFile(planPath, JSON.stringify(plan));
  await writeFile(rawPath, rawSamples.map(sample => `${canonicalJson(sample)}\n`).join(""));
  try {
    await assert.rejects(
      () => execFileAsync(process.execPath, [
        cli,
        "report",
        "--plan", planPath,
        "--evidence", evidencePath,
        "--raw", rawPath
      ], { env: { PATH: process.env.PATH ?? "" } }),
      error => {
        const result = JSON.parse(error.stdout);
        return error.code === 3 && result.state === "STOPPED" && result.breaches[0].metric === "runtime.oomCount";
      }
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

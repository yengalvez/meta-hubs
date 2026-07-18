import test from "node:test";
import assert from "node:assert/strict";
import { loadCatalogue, loadThresholds } from "../lib/io.mjs";
import { validateCatalogue, validateThresholds } from "../lib/schema.mjs";

test("the checked-in catalogue contains the five bounded scenarios", async () => {
  const scenarios = validateCatalogue(await loadCatalogue());
  assert.deepEqual([...scenarios.keys()], [
    "local-smoke",
    "room-30",
    "room-100-experimental",
    "total-300",
    "total-10000-model"
  ]);
  assert.equal(scenarios.get("total-300").totalParticipants, 300);
  assert.equal(scenarios.get("total-10000-model").mode, "model-only");
});

test("catalogue rejects a bot variant above ten", async () => {
  const catalogue = structuredClone(await loadCatalogue());
  catalogue.scenarios[0].botVariants = [0, 5, 11];
  assert.throws(
    () => validateCatalogue(catalogue),
    error => error.code === "SCHEMA_INVALID" && error.details.some(detail => detail.path.endsWith("botVariants"))
  );
});

test("catalogue rejects a physical scenario above 300", async () => {
  const catalogue = structuredClone(await loadCatalogue());
  const scenario = catalogue.scenarios.find(item => item.id === "total-300");
  scenario.totalParticipants = 301;
  assert.throws(
    () => validateCatalogue(catalogue),
    error => error.code === "SCHEMA_INVALID" && error.details.some(detail => detail.message.includes("capped at 300"))
  );
});

test("catalogue rejects omission of a required scenario", async () => {
  const catalogue = structuredClone(await loadCatalogue());
  catalogue.scenarios = catalogue.scenarios.filter(item => item.id !== "room-30");
  assert.throws(
    () => validateCatalogue(catalogue),
    error => error.code === "SCHEMA_INVALID" && error.details.some(detail => detail.message.includes("missing room-30"))
  );
});

test("catalogue and threshold schemas reject unreviewed fields", async () => {
  const catalogue = await loadCatalogue();
  catalogue.scenarios[0].certified = true;
  assert.throws(() => validateCatalogue(catalogue), error => error.code === "SCHEMA_INVALID");

  const thresholds = await loadThresholds();
  thresholds.metrics["client.fpsP10"].unreviewed = true;
  assert.throws(() => validateThresholds(thresholds), error => error.code === "THRESHOLD_SCHEMA_INVALID");
});

test("physical workload phases must be explicit and sum to the scenario duration", async () => {
  const catalogue = structuredClone(await loadCatalogue());
  catalogue.scenarios[0].plateauSeconds -= 1;
  assert.throws(
    () => validateCatalogue(catalogue),
    error => error.code === "SCHEMA_INVALID" &&
      error.details.some(detail => detail.message.includes("rampUpSeconds + plateauSeconds"))
  );
});

test("threshold schema requires provisional, bounded stop rules", async () => {
  const thresholds = validateThresholds(await loadThresholds());
  assert.equal(thresholds.provisional, true);
  assert.equal(thresholds.metrics["join.failureRate"].max, 0.01);
  assert.equal(thresholds.metrics["kubernetes.cpuUtilization"].sustainedMs, 300000);

  const invalidThresholds = structuredClone(thresholds);
  invalidThresholds.metrics["join.failureRate"] = { min: 0, max: 1, unit: "ratio", stop: true };
  assert.throws(() => validateThresholds(invalidThresholds), error => error.code === "THRESHOLD_SCHEMA_INVALID");
});

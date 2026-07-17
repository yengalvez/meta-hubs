import test from "node:test";
import assert from "node:assert/strict";
import { loadThresholds } from "../lib/io.mjs";
import { validateThresholds } from "../lib/schema.mjs";
import { StopMonitor } from "../lib/stop-monitor.mjs";

const thresholds = validateThresholds(await loadThresholds());
const runId = "11111111-1111-4111-8111-111111111111";

function sample(metric, value, observedAt) {
  return { type: "sample", runId, metric, value, observedAt };
}

test("immediate criterion stops only above its maximum", () => {
  const monitor = new StopMonitor(thresholds, { runId });
  assert.equal(monitor.observe(sample("join.failureRate", 0.01, "2026-07-17T10:00:00.000Z")), null);
  const stop = monitor.observe(sample("join.failureRate", 0.0101, "2026-07-17T10:00:01.000Z"));
  assert.equal(stop.metric, "join.failureRate");
  assert.equal(stop.value, 0.0101);
});

test("minimum criterion stops below the bound", () => {
  const monitor = new StopMonitor(thresholds, { runId });
  assert.equal(monitor.observe(sample("client.fpsP10", 30, "2026-07-17T10:00:00.000Z")), null);
  assert.equal(
    monitor.observe(sample("client.fpsP10", 29.9, "2026-07-17T10:00:01.000Z")).metric,
    "client.fpsP10"
  );
});

test("sustained criterion waits five minutes and resets after recovery", () => {
  const monitor = new StopMonitor(thresholds, { runId });
  assert.equal(monitor.observe(sample("kubernetes.cpuUtilization", 0.81, "2026-07-17T10:00:00.000Z")), null);
  assert.equal(monitor.observe(sample("kubernetes.cpuUtilization", 0.9, "2026-07-17T10:04:59.999Z")), null);
  const stop = monitor.observe(sample("kubernetes.cpuUtilization", 0.82, "2026-07-17T10:05:00.000Z"));
  assert.equal(stop.metric, "kubernetes.cpuUtilization");
  assert.equal(stop.violationStartedAt, "2026-07-17T10:00:00.000Z");

  const reset = new StopMonitor(thresholds, { runId });
  assert.equal(reset.observe(sample("kubernetes.cpuUtilization", 0.9, "2026-07-17T10:00:00.000Z")), null);
  assert.equal(reset.observe(sample("kubernetes.cpuUtilization", 0.7, "2026-07-17T10:04:00.000Z")), null);
  assert.equal(reset.observe(sample("kubernetes.cpuUtilization", 0.9, "2026-07-17T10:05:00.000Z")), null);
  assert.equal(reset.observe(sample("kubernetes.cpuUtilization", 0.9, "2026-07-17T10:09:59.999Z")), null);
});

test("malformed samples invalidate the driver protocol", () => {
  const monitor = new StopMonitor(thresholds, { runId });
  assert.throws(
    () => monitor.observe(sample("join.failureRate", Number.NaN, "2026-07-17T10:00:00.000Z")),
    error => error.code === "DRIVER_PROTOCOL_INVALID"
  );
  assert.throws(
    () => monitor.observe(sample("join.failureRate", 0, "not-a-date")),
    error => error.code === "DRIVER_PROTOCOL_INVALID"
  );
  assert.throws(
    () => monitor.observe(sample("join.failureRate", -1, "2026-07-17T10:00:00.000Z")),
    error => error.code === "DRIVER_PROTOCOL_INVALID"
  );
  assert.throws(
    () => monitor.observe(sample("runtime.oomCount", 0.5, "2026-07-17T10:00:00.000Z")),
    error => error.code === "DRIVER_PROTOCOL_INVALID"
  );
});

test("unknown metrics, wrong runs and timestamp rollback invalidate live evidence", () => {
  assert.throws(
    () => new StopMonitor(thresholds, { runId }).observe(sample("typo.cpu", 1, "2026-07-17T10:00:00.000Z")),
    error => error.code === "DRIVER_PROTOCOL_INVALID"
  );
  assert.throws(
    () => new StopMonitor(thresholds, { runId }).observe({
      ...sample("join.failureRate", 0, "2026-07-17T10:00:00.000Z"),
      runId: "22222222-2222-4222-8222-222222222222"
    }),
    error => error.code === "DRIVER_PROTOCOL_INVALID"
  );

  const rollback = new StopMonitor(thresholds, { runId });
  rollback.observe(sample("join.failureRate", 0, "2026-07-17T10:00:01.000Z"));
  assert.throws(
    () => rollback.observe(sample("join.failureRate", 0, "2026-07-17T10:00:00.000Z")),
    error => error.code === "DRIVER_PROTOCOL_INVALID"
  );
});

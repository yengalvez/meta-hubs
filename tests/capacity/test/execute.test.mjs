import test from "node:test";
import assert from "node:assert/strict";
import { CapacityProtocolSession } from "../lib/execute.mjs";
import { loadCatalogue, loadThresholds } from "../lib/io.mjs";
import { validateCatalogue, validateThresholds } from "../lib/schema.mjs";
import { buildTestPlan, makePassingEvidence } from "../test-support/fixtures.mjs";

const scenarios = validateCatalogue(await loadCatalogue());
const thresholds = validateThresholds(await loadThresholds());
const plan = buildTestPlan({ scenarios });
const passing = makePassingEvidence(plan, thresholds);

test("pure protocol evaluator can validate complete evidence without launching a driver", () => {
  const session = new CapacityProtocolSession({ plan, thresholds });
  const report = session.ingest(JSON.stringify({ type: "result", evidence: passing }));
  assert.equal(report.state, "PASSED");
  assert.equal(session.finish().run.id, plan.run.id);
});

test("protocol result with a missing collector is INVALID", () => {
  const incomplete = structuredClone(passing);
  incomplete.collectors = incomplete.collectors.filter(collector => collector.name !== "webrtc");
  const session = new CapacityProtocolSession({ plan, thresholds });
  assert.throws(
    () => session.ingest(JSON.stringify({ type: "result", evidence: incomplete })),
    error => error.code === "COLLECTOR_EVIDENCE_MISSING"
  );
});

test("live breach returns a closed STOPPED result", () => {
  const session = new CapacityProtocolSession({ plan, thresholds });
  const report = session.ingest(JSON.stringify({
    type: "sample",
    runId: plan.run.id,
    metric: "join.failureRate",
    value: 0.02,
    observedAt: "2026-07-17T10:00:00.000Z"
  }));
  assert.equal(report.state, "STOPPED");
  assert.equal(report.breach.metric, "join.failureRate");
  assert.deepEqual(Object.keys(report).sort(), [
    "breach",
    "certified",
    "note",
    "planId",
    "runId",
    "schemaVersion",
    "state"
  ]);
});

test("protocol rejects unknown events, extra result fields and trailing events", () => {
  assert.throws(
    () => new CapacityProtocolSession({ plan, thresholds }).ingest(JSON.stringify({
      type: "secret-event",
      value: "UNTRUSTED_PRIVATE_TEXT_7B2A"
    })),
    error => error.code === "DRIVER_PROTOCOL_INVALID" && !JSON.stringify(error).includes("PRIVATE_TEXT")
  );

  assert.throws(
    () => new CapacityProtocolSession({ plan, thresholds }).ingest(JSON.stringify({
      type: "result",
      evidence: passing,
      note: "UNTRUSTED_PRIVATE_TEXT_7B2A"
    })),
    error => error.code === "DRIVER_PROTOCOL_INVALID" && !JSON.stringify(error).includes("PRIVATE_TEXT")
  );

  const completed = new CapacityProtocolSession({ plan, thresholds });
  completed.ingest(JSON.stringify({ type: "result", evidence: passing }));
  assert.throws(
    () => completed.ingest(JSON.stringify({ type: "result", evidence: passing })),
    error => error.code === "DRIVER_PROTOCOL_INVALID"
  );
});

test("completed evidence cannot rebind live samples from outside its run window", () => {
  const session = new CapacityProtocolSession({ plan, thresholds });
  session.ingest(JSON.stringify({
    type: "sample",
    runId: plan.run.id,
    metric: "join.failureRate",
    value: 0,
    observedAt: plan.run.issuedAt
  }));
  assert.throws(
    () => session.ingest(JSON.stringify({ type: "result", evidence: passing })),
    error => error.code === "DRIVER_PROTOCOL_INVALID"
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { loadCatalogue, loadThresholds } from "../lib/io.mjs";
import { buildReport } from "../lib/report.mjs";
import { validateCatalogue, validateThresholds } from "../lib/schema.mjs";
import { buildTestPlan, makePassingEvidence } from "../test-support/fixtures.mjs";

const scenarios = validateCatalogue(await loadCatalogue());
const thresholds = validateThresholds(await loadThresholds());
const plan = buildTestPlan({ scenarios });
const passing = makePassingEvidence(plan, thresholds);

test("complete run-bound evidence produces a provisional, non-certifying pass", () => {
  const report = buildReport({ plan, evidence: passing, thresholds });
  assert.equal(report.state, "PASSED");
  assert.equal(report.certified, false);
  assert.equal(report.run.id, plan.run.id);
  assert.equal(report.collectors.length, thresholds.requiredCollectors.length);
  assert.equal(report.rooms[0].finalUrl, plan.rooms[0].target);
  assert.equal(Object.hasOwn(report.rooms[0].workers[0], "participantIds"), false);
});

test("run nonce, issue time, common window and driver/browser identity are mandatory", () => {
  for (const mutate of [
    evidence => { evidence.run.id = "22222222-2222-4222-8222-222222222222"; },
    evidence => { evidence.run.issuedAt = "2026-07-17T09:54:00.000Z"; },
    evidence => { evidence.run.startedAt = "2026-07-17T11:00:00.001Z"; evidence.run.endedAt = "2026-07-17T11:01:00.001Z"; },
    evidence => { evidence.run.driver.sha256 = "not-a-hash"; },
    evidence => { evidence.run.driver.nodeVersion = "v20.0.0"; },
    evidence => { evidence.run.browser.profile = "unknown-profile"; }
  ]) {
    const evidence = structuredClone(passing);
    mutate(evidence);
    assert.throws(
      () => buildReport({ plan, evidence, thresholds }),
      error => error.code === "RUN_EVIDENCE_INVALID"
    );
  }

  const splitWindow = structuredClone(passing);
  splitWindow.collectors[0].startedAt = "2035-01-01T00:00:00.000Z";
  splitWindow.collectors[0].endedAt = "2035-01-01T00:01:00.000Z";
  assert.throws(
    () => buildReport({ plan, evidence: splitWindow, thresholds }),
    error => error.code === "COLLECTOR_EVIDENCE_MISSING"
  );
});

test("missing, duplicate, sparse or cross-run collector evidence is invalid", () => {
  const missing = structuredClone(passing);
  missing.collectors = missing.collectors.filter(collector => collector.name !== "dialog");
  assert.throws(
    () => buildReport({ plan, evidence: missing, thresholds }),
    error => error.code === "COLLECTOR_EVIDENCE_MISSING"
  );

  const duplicate = structuredClone(passing);
  duplicate.collectors[1].name = duplicate.collectors[0].name;
  assert.throws(
    () => buildReport({ plan, evidence: duplicate, thresholds }),
    error => error.code === "EVIDENCE_INVALID"
  );

  const sparse = structuredClone(passing);
  sparse.collectors[0].samples = 1;
  assert.throws(
    () => buildReport({ plan, evidence: sparse, thresholds }),
    error => error.code === "COLLECTOR_EVIDENCE_MISSING"
  );

  const wrongRun = structuredClone(passing);
  wrongRun.collectors[0].runId = "22222222-2222-4222-8222-222222222222";
  assert.throws(
    () => buildReport({ plan, evidence: wrongRun, thresholds }),
    error => error.code === "COLLECTOR_EVIDENCE_MISSING"
  );
});

test("same-origin redirects and incomplete or duplicate room/worker populations are invalid", () => {
  const redirected = structuredClone(passing);
  redirected.rooms[0].finalUrl = "http://localhost:4000/different-room";
  assert.throws(
    () => buildReport({ plan, evidence: redirected, thresholds }),
    error => error.code === "ROOM_EVIDENCE_INVALID"
  );

  const duplicateParticipant = structuredClone(passing);
  duplicateParticipant.rooms[0].workers[0].participantIds[1] =
    duplicateParticipant.rooms[0].workers[0].participantIds[0];
  assert.throws(
    () => buildReport({ plan, evidence: duplicateParticipant, thresholds }),
    error => error.code === "WORKER_EVIDENCE_INVALID"
  );

  const shortPlateau = structuredClone(passing);
  shortPlateau.rooms[0].plateauParticipantSeconds -= 1;
  assert.throws(
    () => buildReport({ plan, evidence: shortPlateau, thresholds }),
    error => error.code === "ROOM_EVIDENCE_INVALID"
  );

  const multiPlan = buildTestPlan({ scenarios, scenarioId: "total-300", botsPerRoom: 10 });
  const multiEvidence = makePassingEvidence(multiPlan, thresholds);
  const multiReport = buildReport({ plan: multiPlan, evidence: multiEvidence, thresholds });
  assert.equal(multiReport.rooms.length, 12);
  assert.equal(multiReport.rooms.reduce((sum, room) => sum + room.uniqueParticipants, 0), 300);

  const incompleteRooms = structuredClone(multiEvidence);
  incompleteRooms.rooms.pop();
  assert.throws(
    () => buildReport({ plan: multiPlan, evidence: incompleteRooms, thresholds }),
    error => error.code === "ROOM_EVIDENCE_INVALID"
  );
});

test("lobby and room phases are closed and require the complete plateau", () => {
  const missing = structuredClone(passing);
  delete missing.participantPhases;
  assert.throws(
    () => buildReport({ plan, evidence: missing, thresholds }),
    error => error.code === "EVIDENCE_SCHEMA_INVALID"
  );

  const incompleteEntry = structuredClone(passing);
  incompleteEntry.participantPhases.room.peak = plan.totals.participants - 1;
  assert.throws(
    () => buildReport({ plan, evidence: incompleteEntry, thresholds }),
    error => error.code === "PARTICIPANT_PHASE_EVIDENCE_INVALID"
  );

  const zeroRoomDuration = structuredClone(passing);
  zeroRoomDuration.participantPhases.room.participantSeconds = 0;
  assert.throws(
    () => buildReport({ plan, evidence: zeroRoomDuration, thresholds }),
    error => error.code === "PARTICIPANT_PHASE_EVIDENCE_INVALID"
  );

  const extra = structuredClone(passing);
  extra.participantPhases.room.note = "UNTRUSTED_PRIVATE_TEXT_7B2A";
  assert.throws(
    () => buildReport({ plan, evidence: extra, thresholds }),
    error => error.code === "EVIDENCE_SCHEMA_INVALID" && !JSON.stringify(error).includes("PRIVATE_TEXT")
  );
});

test("metric set is exact and physically impossible values invalidate evidence", () => {
  const missing = structuredClone(passing);
  delete missing.metrics["webrtc.rttP95Ms"];
  assert.throws(
    () => buildReport({ plan, evidence: missing, thresholds }),
    error => error.code === "METRIC_EVIDENCE_MISSING"
  );

  const extra = structuredClone(passing);
  extra.metrics["driver.untrusted"] = "UNTRUSTED_PRIVATE_TEXT_7B2A";
  assert.throws(
    () => buildReport({ plan, evidence: extra, thresholds }),
    error => error.code === "METRIC_EVIDENCE_MISSING" && !JSON.stringify(error).includes("PRIVATE_TEXT")
  );

  for (const [metric, value] of [
    ["join.failureRate", -1],
    ["join.failureRate", 1.1],
    ["runtime.oomCount", -7],
    ["runtime.oomCount", 0.5],
    ["webrtc.rttP95Ms", -100]
  ]) {
    const evidence = structuredClone(passing);
    evidence.metrics[metric] = value;
    assert.throws(
      () => buildReport({ plan, evidence, thresholds }),
      error => error.code === "METRIC_EVIDENCE_MISSING" && error.details.invalidMetrics.includes(metric)
    );
  }
});

test("a post-run threshold breach is STOPPED", () => {
  const evidence = structuredClone(passing);
  evidence.metrics["runtime.oomCount"] = 1;
  const report = buildReport({ plan, evidence, thresholds });
  assert.equal(report.state, "STOPPED");
  assert.equal(report.breaches[0].metric, "runtime.oomCount");
});

test("sustained evidence uses a coherent fifteen-minute room-30 window", () => {
  const roomPlan = buildTestPlan({ scenarios, scenarioId: "room-30" });
  const shortBreach = makePassingEvidence(roomPlan, thresholds);
  shortBreach.metrics["kubernetes.cpuUtilization"] = {
    peakValue: 0.9,
    maxBreachDurationMs: 299999
  };
  assert.equal(buildReport({ plan: roomPlan, evidence: shortBreach, thresholds }).state, "PASSED");

  const sustainedBreach = structuredClone(shortBreach);
  sustainedBreach.metrics["kubernetes.cpuUtilization"].maxBreachDurationMs = 300000;
  const report = buildReport({ plan: roomPlan, evidence: sustainedBreach, thresholds });
  assert.equal(report.state, "STOPPED");
  assert.equal(report.breaches[0].metric, "kubernetes.cpuUtilization");
});

test("different plan or run nonce is invalid", () => {
  const wrongPlan = structuredClone(passing);
  wrongPlan.planId = "plan-other";
  assert.throws(
    () => buildReport({ plan, evidence: wrongPlan, thresholds }),
    error => error.code === "EVIDENCE_PLAN_MISMATCH"
  );

  const wrongRun = structuredClone(passing);
  wrongRun.run.id = "22222222-2222-4222-8222-222222222222";
  assert.throws(
    () => buildReport({ plan, evidence: wrongRun, thresholds }),
    error => error.code === "RUN_EVIDENCE_INVALID"
  );
});

test("failed evidence is closed and never propagates driver text", () => {
  const failed = {
    schemaVersion: 1,
    planId: plan.planId,
    driverState: "failed",
    runId: plan.run.id,
    failureCode: "driver-failed"
  };
  const report = buildReport({ plan, thresholds, evidence: failed });
  assert.equal(report.state, "FAILED");
  assert.equal(report.reason, "capacity driver reported failure");

  const leaking = { ...failed, reason: "UNTRUSTED_PRIVATE_TEXT_7B2A" };
  assert.throws(
    () => buildReport({ plan, thresholds, evidence: leaking }),
    error => error.code === "EVIDENCE_SCHEMA_INVALID" && !JSON.stringify(error).includes("PRIVATE_TEXT")
  );
});

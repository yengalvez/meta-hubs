import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJson, loadCatalogue, loadThresholds } from "../lib/io.mjs";
import { trackedCollectorMappingIdentity } from "../lib/collector-contract.mjs";
import { makeRawSample } from "../lib/provenance.mjs";
import { buildReport as buildStrictReport } from "../lib/report.mjs";
import { validateCatalogue, validateThresholds } from "../lib/schema.mjs";
import { PARTICIPANT_JOIN_METRICS, PROMETHEUS_COUNTER_METRICS } from "../lib/metric-contracts.mjs";
import {
  buildTestPlan,
  makePassingEvidence,
  promoteFixtureEvidenceToPhysical,
  refreshRawArtifact,
  setRawMetricValues,
  setRawThresholdMetric
} from "../test-support/fixtures.mjs";

const scenarios = validateCatalogue(await loadCatalogue());
const thresholds = validateThresholds(await loadThresholds());
const buildReport = options => buildStrictReport({ ...options, allowTestFixtures: true });
const plan = buildTestPlan({ scenarios });
const passing = makePassingEvidence(plan, thresholds);

function replacePhysicalMetricInventory(evidence, metric, inventory) {
  const seriesInventory = structuredClone(evidence.collectorMapping.configuration.seriesInventory);
  seriesInventory[metric] = structuredClone(inventory);
  const mapping = trackedCollectorMappingIdentity({
    listenPort: evidence.collectorMapping.configuration.listenPort,
    prometheusUrl: evidence.collectorMapping.configuration.prometheusUrl,
    maxSampleAgeSeconds: evidence.collectorMapping.configuration.maxSampleAgeSeconds,
    seriesInventory
  });
  const inventorySha256 = createHash("sha256")
    .update(canonicalJson(mapping.configuration.seriesInventory))
    .digest("hex");
  evidence.collectorMapping = mapping;
  evidence.raw.samples = evidence.raw.samples.map(sample => {
    if (sample.source.kind !== "prometheus") return sample;
    const semanticProof = structuredClone(sample.source.semanticProof);
    if (sample.metric === metric) {
      const template = semanticProof.series[0];
      semanticProof.series = inventory.map(labels => ({ ...structuredClone(template), labels }));
    }
    const sourceMapping = mapping.configuration.metrics[sample.metric];
    return makeRawSample({
      ...sample,
      source: {
        ...sample.source,
        mappingSha256: mapping.sha256,
        sourceMetric: sourceMapping.sourceMetric,
        querySha256: sourceMapping.querySha256,
        inventorySha256,
        semanticProof
      }
    });
  }).sort((left, right) =>
    Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.id.localeCompare(right.id)
  );
  refreshRawArtifact(evidence);
  return evidence;
}

test("raw-bound zero-bot evidence produces a provisional non-certifying pass", () => {
  const report = buildReport({ plan, evidence: passing, thresholds });
  assert.equal(report.state, "PASSED");
  assert.equal(report.certified, false);
  assert.equal(report.run.id, plan.run.id);
  assert.equal(report.collectors.length, thresholds.requiredCollectors.length);
  assert.equal(report.collectors.some(item => item.name === "bots"), true);
  assert.equal(Object.keys(report.metrics).some(name => name.startsWith("bots.")), true);
  assert.deepEqual(report.rooms[0].bots, {
    state: "observed", desired: 0, active: 0, authenticated: 0,
    spawnAcknowledged: 0, navmeshReady: 0
  });
  assert.equal(Object.hasOwn(report.rooms[0].workers[0], "participantIds"), false);
  assert.match(report.provenance.rawArtifact.sha256, /^[0-9a-f]{64}$/);
  assert.ok(report.provenance.aggregates["webrtc.rttP95Ms"].sampleCount > 0);
  assert.match(report.provenance.aggregates["webrtc.rttP95Ms"].sampleIdsSha256, /^[0-9a-f]{64}$/);
  assert.equal(
    report.provenance.aggregates["webrtc.rttP95Ms"].rawSha256,
    report.provenance.rawArtifact.sha256
  );
  assert.equal(report.provenance.population.phases.room.length, plan.totals.participants * 2);
  assert.match(report.integrity.sha256, /^[0-9a-f]{64}$/);
});

test("production report API rejects fixture driver and fixture sample sources by default", () => {
  assert.throws(
    () => buildStrictReport({ plan, evidence: passing, thresholds }),
    error => error.code === "RUN_EVIDENCE_INVALID"
  );
  const disguised = structuredClone(passing);
  disguised.run.driver.name = "yenhubs-playwright-capacity";
  assert.throws(
    () => buildStrictReport({ plan, evidence: disguised, thresholds }),
    error => error.code === "RAW_SAMPLE_INVALID"
  );
});

test("production provenance binds ICE, Prometheus and generator values to their real measurement source", () => {
  const physical = promoteFixtureEvidenceToPhysical(plan, makePassingEvidence(plan, thresholds));
  assert.equal(buildStrictReport({ plan, evidence: physical, thresholds }).state, "PASSED");

  for (const mutateSource of [
    sample => sample.metric === "webrtc.iceServerAttestationValid"
      ? { ...sample.source, iceServerUrls: ["turns:unreviewed-capacity-staging.example.org:5349"] }
      : null,
    sample => sample.metric === "webrtc.iceServerAttestationValid"
      ? { kind: "browser", sourceObservedAt: sample.observedAt }
      : null,
    sample => sample.metric === "generator.cpuUtilization"
      ? { ...sample.source, cpuPercent: sample.source.cpuPercent + 1 }
      : null,
    sample => sample.collector === "reticulum"
      ? { kind: "host", sourceObservedAt: sample.observedAt }
      : null
  ]) {
    const forged = structuredClone(physical);
    const index = forged.raw.samples.findIndex(sample => mutateSource(sample) !== null);
    const original = forged.raw.samples[index];
    forged.raw.samples[index] = makeRawSample({ ...original, source: mutateSource(original) });
    forged.raw.samples.sort((left, right) =>
      Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.id.localeCompare(right.id)
    );
    refreshRawArtifact(forged);
    assert.throws(
      () => buildStrictReport({ plan, evidence: forged, thresholds }),
      error => error.code === "RAW_SAMPLE_INVALID"
    );
  }
});

test("every measurement source timestamp must remain inside the signed run window", () => {
  const physical = promoteFixtureEvidenceToPhysical(plan, makePassingEvidence(plan, thresholds));
  const preRun = new Date(Date.parse(physical.run.startedAt) - 1).toISOString();
  for (const sourceKind of ["browser", "host-process-tree", "prometheus"]) {
    const forged = structuredClone(physical);
    const index = forged.raw.samples.findIndex(sample => sample.source.kind === sourceKind);
    assert.notEqual(index, -1);
    const original = forged.raw.samples[index];
    forged.raw.samples[index] = makeRawSample({
      ...original,
      source: { ...original.source, sourceObservedAt: preRun }
    });
    forged.raw.samples.sort((left, right) =>
      Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.id.localeCompare(right.id)
    );
    refreshRawArtifact(forged);
    assert.throws(
      () => buildStrictReport({ plan, evidence: forged, thresholds }),
      error => error.code === "RAW_SAMPLE_INVALID"
    );
  }
});

test("offline Prometheus validation rejects one stalled entity even when the aggregate minimum advances", () => {
  const physical = replacePhysicalMetricInventory(
    promoteFixtureEvidenceToPhysical(plan, makePassingEvidence(plan, thresholds)),
    "runtime.notReadySeconds",
    [{ instance: "runtime-a" }, { instance: "runtime-b" }]
  );
  assert.equal(buildStrictReport({ plan, evidence: physical, thresholds }).state, "PASSED");
  const runStartedAtMs = Date.parse(physical.run.startedAt);
  const mutateAt = (offsetSeconds, sourceTimes) => {
    const observedAt = new Date(runStartedAtMs + offsetSeconds * 1000).toISOString();
    const index = physical.raw.samples.findIndex(sample =>
      sample.metric === "runtime.notReadySeconds" && sample.observedAt === observedAt
    );
    assert.notEqual(index, -1);
    const sample = physical.raw.samples[index];
    const semanticProof = structuredClone(sample.source.semanticProof);
    semanticProof.windowStartedAt = physical.run.startedAt;
    semanticProof.series = semanticProof.series.map((item, seriesIndex) => ({
      ...item,
      currentObservedAt: new Date(runStartedAtMs + sourceTimes[seriesIndex] * 1000).toISOString()
    }));
    physical.raw.samples[index] = makeRawSample({
      ...sample,
      source: {
        ...sample.source,
        sourceObservedAt: new Date(runStartedAtMs + Math.min(...sourceTimes) * 1000).toISOString(),
        semanticProof
      }
    });
  };
  mutateAt(15, [14, 15]);
  mutateAt(30, [30, 15]);
  physical.raw.samples.sort((left, right) =>
    Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.id.localeCompare(right.id)
  );
  refreshRawArtifact(physical);
  assert.throws(
    () => buildStrictReport({ plan, evidence: physical, thresholds }),
    error => error.code === "PROMETHEUS_SAMPLE_REUSED"
  );
});

test("external raw NDJSON samples are authoritative and cannot be omitted", () => {
  const evidence = structuredClone(passing);
  const rawSamples = evidence.raw.samples;
  delete evidence.raw.samples;

  const report = buildReport({ plan, evidence, thresholds, rawSamples });
  assert.equal(report.state, "PASSED");
  assert.equal(report.provenance.rawArtifact.sha256, evidence.raw.artifact.sha256);
  assert.throws(
    () => buildReport({ plan, evidence, thresholds }),
    error => error.code === "RAW_PROVENANCE_MISSING"
  );
});

test("run nonce, issue time, window and driver/browser identity are mandatory", () => {
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
    assert.throws(() => buildReport({ plan, evidence, thresholds }), error => error.code === "RUN_EVIDENCE_INVALID");
  }
});

test("self-declared aggregates without raw provenance and altered raw artifacts are invalid", () => {
  const missingRaw = structuredClone(passing);
  missingRaw.raw = { format: "yenhubs-capacity-ndjson-v3", artifact: passing.raw.artifact, samples: [] };
  assert.throws(
    () => buildReport({ plan, evidence: missingRaw, thresholds }),
    error => error.code === "RAW_PROVENANCE_MISSING"
  );

  const forgedAggregate = structuredClone(passing);
  forgedAggregate.metrics["webrtc.rttP95Ms"] = 1;
  assert.throws(
    () => buildReport({ plan, evidence: forgedAggregate, thresholds }),
    error => error.code === "AGGREGATE_PROVENANCE_INVALID"
  );

  const corruptedArtifact = structuredClone(passing);
  corruptedArtifact.raw.artifact.sha256 = "f".repeat(64);
  assert.throws(
    () => buildReport({ plan, evidence: corruptedArtifact, thresholds }),
    error => error.code === "RAW_ARTIFACT_INVALID"
  );
});

test("collectors are unique, raw-counted, run-bound and gap-bounded", () => {
  const missing = structuredClone(passing);
  missing.collectors = missing.collectors.filter(collector => collector.name !== "dialog");
  assert.throws(() => buildReport({ plan, evidence: missing, thresholds }), error => error.code === "COLLECTOR_EVIDENCE_MISSING");

  const duplicate = structuredClone(passing);
  duplicate.collectors[1].name = duplicate.collectors[0].name;
  assert.throws(() => buildReport({ plan, evidence: duplicate, thresholds }), error => error.code === "EVIDENCE_INVALID");

  for (const mutate of [
    evidence => { evidence.collectors[0].samples -= 1; },
    evidence => { evidence.collectors[0].runId = "22222222-2222-4222-8222-222222222222"; },
    evidence => { evidence.collectors[0].startedAt = "2035-01-01T00:00:00.000Z"; }
  ]) {
    const evidence = structuredClone(passing);
    mutate(evidence);
    assert.throws(() => buildReport({ plan, evidence, thresholds }), error => error.code === "COLLECTOR_EVIDENCE_MISSING");
  }

  const gap = structuredClone(passing);
  gap.raw.samples = gap.raw.samples.filter(sample =>
    sample.collector !== "dialog" || sample.observedAt === gap.run.startedAt || sample.observedAt === gap.run.endedAt
  );
  gap.collectors.find(item => item.name === "dialog").samples = gap.raw.samples.filter(item => item.collector === "dialog").length;
  refreshRawArtifact(gap);
  assert.throws(() => buildReport({ plan, evidence: gap, thresholds }), error => error.code === "RAW_SAMPLING_GAP");
});

test("room, worker and phase aggregates must equal participant raw measurements", () => {
  const redirected = structuredClone(passing);
  redirected.rooms[0].finalUrl = "http://localhost:4000/different-room";
  assert.throws(() => buildReport({ plan, evidence: redirected, thresholds }), error => error.code === "ROOM_EVIDENCE_INVALID");

  const duplicateParticipant = structuredClone(passing);
  duplicateParticipant.rooms[0].workers[0].participantIds[1] = duplicateParticipant.rooms[0].workers[0].participantIds[0];
  assert.throws(() => buildReport({ plan, evidence: duplicateParticipant, thresholds }), error => error.code === "WORKER_EVIDENCE_INVALID");

  const forgedPlateau = structuredClone(passing);
  forgedPlateau.rooms[0].plateauParticipantSeconds -= 1;
  assert.throws(() => buildReport({ plan, evidence: forgedPlateau, thresholds }), error => error.code === "ROOM_EVIDENCE_INVALID");

  const rawShortPlateau = structuredClone(passing);
  setRawMetricValues(rawShortPlateau, "client.plateauPresenceSeconds", plan.workload.plateau.durationSeconds - 1);
  assert.throws(
    () => buildReport({ plan, evidence: rawShortPlateau, thresholds }),
    error => error.code === "PARTICIPANT_RAW_EVIDENCE_INVALID"
  );

  const forgedPhase = structuredClone(passing);
  forgedPhase.participantPhases.room.participantSeconds -= 1;
  assert.throws(
    () => buildReport({ plan, evidence: forgedPhase, thresholds }),
    error => error.code === "PARTICIPANT_PHASE_EVIDENCE_INVALID"
  );
});

test("multi-room raw population remains complete and unique", () => {
  const multiPlan = buildTestPlan({ scenarios, scenarioId: "total-300", botsPerRoom: 0 });
  const multiEvidence = makePassingEvidence(multiPlan, thresholds);
  const report = buildReport({ plan: multiPlan, evidence: multiEvidence, thresholds });
  assert.equal(report.rooms.length, 12);
  assert.equal(report.rooms.reduce((sum, room) => sum + room.uniqueParticipants, 0), 300);

  const incomplete = structuredClone(multiEvidence);
  incomplete.rooms.pop();
  assert.throws(() => buildReport({ plan: multiPlan, evidence: incomplete, thresholds }), error => error.code === "ROOM_EVIDENCE_INVALID");

  const phaseIndex = multiEvidence.raw.samples.findIndex(sample =>
    sample.metric === "client.fpsP10" && sample.dimensions.phase === "plateau"
  );
  const originalPhaseSample = multiEvidence.raw.samples[phaseIndex];
  const forgedPhaseSample = makeRawSample({
    ...originalPhaseSample,
    dimensions: { ...originalPhaseSample.dimensions, phase: "ramp-up" }
  });
  multiEvidence.raw.samples[phaseIndex] = forgedPhaseSample;
  multiEvidence.raw.samples.sort((left, right) =>
    Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.id.localeCompare(right.id)
  );
  refreshRawArtifact(multiEvidence);
  assert.throws(
    () => buildReport({ plan: multiPlan, evidence: multiEvidence, thresholds }),
    error => error.code === "RAW_SAMPLE_INVALID"
  );
  multiEvidence.raw.samples = multiEvidence.raw.samples.filter(sample => sample.id !== forgedPhaseSample.id);
  multiEvidence.raw.samples.push(originalPhaseSample);
  multiEvidence.raw.samples.sort((left, right) =>
    Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.id.localeCompare(right.id)
  );

  const assertMissingSeries = (predicate, collector) => {
    const originalSamples = multiEvidence.raw.samples;
    multiEvidence.raw.samples = originalSamples.filter(sample => !predicate(sample));
    const claim = multiEvidence.collectors.find(item => item.name === collector);
    const originalCount = claim.samples;
    claim.samples = multiEvidence.raw.samples.filter(sample => sample.collector === collector).length;
    refreshRawArtifact(multiEvidence);
    assert.throws(
      () => buildReport({ plan: multiPlan, evidence: multiEvidence, thresholds }),
      error => error.code === "RAW_SAMPLING_CARDINALITY_INVALID"
    );
    multiEvidence.raw.samples = originalSamples;
    claim.samples = originalCount;
  };
  assertMissingSeries(
    sample => sample.metric === "generator.cpuUtilization" && sample.dimensions.instance === "host-012",
    "generator"
  );
  assertMissingSeries(
    sample => sample.metric === "bots.state.active" && sample.dimensions.roomId === "room-012",
    "bots"
  );
  assertMissingSeries(
    sample => ["bots.appearanceP95Ms", "bots.navmeshFailureCount", "bots.errorCount"].includes(sample.metric) &&
      sample.dimensions.roomId !== "room-001",
    "bots"
  );
});

test("one participant series cannot stand in for the declared population", () => {
  const incomplete = structuredClone(passing);
  incomplete.raw.samples = incomplete.raw.samples.filter(sample =>
    sample.metric !== "client.fpsP10" || sample.dimensions.participantId === "participant-000001"
  );
  incomplete.collectors.find(item => item.name === "client").samples =
    incomplete.raw.samples.filter(sample => sample.collector === "client").length;
  refreshRawArtifact(incomplete);
  assert.throws(
    () => buildReport({ plan, evidence: incomplete, thresholds }),
    error => error.code === "PARTICIPANT_SERIES_INCOMPLETE"
  );
});

test("every join metric requires exactly one sample from every planned participant", () => {
  for (const metric of PARTICIPANT_JOIN_METRICS) {
    const incomplete = structuredClone(passing);
    incomplete.raw.samples = incomplete.raw.samples.filter(sample =>
      sample.metric !== metric || sample.dimensions.participantId === "participant-000001"
    );
    incomplete.collectors.find(item => item.name === "client").samples =
      incomplete.raw.samples.filter(sample => sample.collector === "client").length;
    refreshRawArtifact(incomplete);
    assert.throws(
      () => buildReport({ plan, evidence: incomplete, thresholds }),
      error => error.code === "PARTICIPANT_SERIES_INCOMPLETE" && error.details.metric === metric
    );
  }

  const shifted = structuredClone(passing);
  const index = shifted.raw.samples.findIndex(sample =>
    sample.metric === "join.sceneP95Ms" && sample.dimensions.participantId === "participant-000001"
  );
  const original = shifted.raw.samples[index];
  shifted.raw.samples[index] = makeRawSample({
    ...original,
    observedAt: new Date(Date.parse(original.observedAt) + 1).toISOString()
  });
  shifted.raw.samples.sort((left, right) =>
    Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.id.localeCompare(right.id)
  );
  refreshRawArtifact(shifted);
  assert.throws(
    () => buildReport({ plan, evidence: shifted, thresholds }),
    error => error.code === "PARTICIPANT_SERIES_INCOMPLETE" && error.details.metric === "join.sceneP95Ms"
  );
});

test("global Prometheus counters require a complete interval series", () => {
  for (const metric of PROMETHEUS_COUNTER_METRICS.filter(name => !name.startsWith("bots."))) {
    const incomplete = structuredClone(passing);
    let retained = false;
    incomplete.raw.samples = incomplete.raw.samples.filter(sample => {
      if (sample.metric !== metric) return true;
      if (retained) return false;
      retained = true;
      return true;
    });
    const collector = incomplete.raw.samples.find(sample => sample.metric === metric).collector;
    incomplete.collectors.find(item => item.name === collector).samples =
      incomplete.raw.samples.filter(sample => sample.collector === collector).length;
    refreshRawArtifact(incomplete);
    assert.throws(
      () => buildReport({ plan, evidence: incomplete, thresholds }),
      error => error.code === "RAW_SAMPLING_GAP" && error.details.metric === metric
    );
  }
});

test("join counters without temporal phase events cannot prove lobby or room occupancy", () => {
  const countersOnly = structuredClone(passing);
  countersOnly.raw.samples = countersOnly.raw.samples.filter(sample => sample.metric !== "phase.lobby.join");
  countersOnly.collectors.find(item => item.name === "client").samples =
    countersOnly.raw.samples.filter(sample => sample.collector === "client").length;
  refreshRawArtifact(countersOnly);
  assert.throws(
    () => buildReport({ plan, evidence: countersOnly, thresholds }),
    error => error.code === "PHASE_EVIDENCE_INVALID"
  );
});

test("zero-bot runs still require a complete observed zero timeline", () => {
  const incomplete = structuredClone(passing);
  const botSamples = incomplete.raw.samples.filter(sample => sample.metric === "bots.state.active");
  const omittedId = botSamples[Math.floor(botSamples.length / 2)].id;
  incomplete.raw.samples = incomplete.raw.samples.filter(sample => sample.id !== omittedId);
  incomplete.collectors.find(item => item.name === "bots").samples =
    incomplete.raw.samples.filter(sample => sample.collector === "bots").length;
  refreshRawArtifact(incomplete);
  assert.throws(
    () => buildReport({ plan, evidence: incomplete, thresholds }),
    error => ["RAW_SAMPLING_GAP", "BOT_EVIDENCE_INVALID"].includes(error.code)
  );
});

test("numeric domains are checked after a matching raw aggregation", () => {
  for (const [metric, value] of [
    ["join.failureRate", 1.1],
    ["runtime.oomCount", 0.5]
  ]) {
    const evidence = structuredClone(passing);
    setRawThresholdMetric(evidence, thresholds, metric, value);
    assert.throws(
      () => buildReport({ plan, evidence, thresholds }),
      error => error.code === "METRIC_EVIDENCE_MISSING" && error.details.invalidMetrics.includes(metric)
    );
  }

  const negative = structuredClone(passing);
  const index = negative.raw.samples.findIndex(sample => sample.metric === "webrtc.rttP95Ms");
  negative.raw.samples[index] = makeRawSample({
    ...negative.raw.samples[index],
    value: -1
  });
  refreshRawArtifact(negative);
  assert.throws(() => buildReport({ plan, evidence: negative, thresholds }), error => error.code === "RAW_SAMPLE_INVALID");
});

test("raw stop breaches stop; changing only the claimed aggregate cannot", () => {
  const breached = structuredClone(passing);
  setRawThresholdMetric(breached, thresholds, "runtime.oomCount", 1);
  const report = buildReport({ plan, evidence: breached, thresholds });
  assert.equal(report.state, "STOPPED");
  assert.equal(report.metrics["runtime.oomCount"], 1);
  assert.equal(report.breaches[0].metric, "runtime.oomCount");

  const claimedOnly = structuredClone(passing);
  claimedOnly.metrics["runtime.oomCount"] = 1;
  assert.throws(
    () => buildReport({ plan, evidence: claimedOnly, thresholds }),
    error => error.code === "AGGREGATE_PROVENANCE_INVALID"
  );
});

test("sustained stop duration is derived from timestamped raw samples", () => {
  const roomPlan = buildTestPlan({ scenarios, scenarioId: "room-30" });
  const shortBreach = makePassingEvidence(roomPlan, thresholds);
  setRawThresholdMetric(shortBreach, thresholds, "kubernetes.cpuUtilization", (_value, index) => index < 19 ? 0.9 : 0.4);
  assert.equal(shortBreach.metrics["kubernetes.cpuUtilization"].maxBreachDurationMs, 285000);
  assert.equal(buildReport({ plan: roomPlan, evidence: shortBreach, thresholds }).state, "PASSED");

  const sustained = makePassingEvidence(roomPlan, thresholds);
  setRawThresholdMetric(sustained, thresholds, "kubernetes.cpuUtilization", (_value, index) => index < 20 ? 0.9 : 0.4);
  assert.equal(sustained.metrics["kubernetes.cpuUtilization"].maxBreachDurationMs, 300000);
  assert.equal(buildReport({ plan: roomPlan, evidence: sustained, thresholds }).state, "STOPPED");
});

test("bot variants require exact per-room desired/active/authenticated/ACK/navmesh state", () => {
  for (const botsPerRoom of [5, 10]) {
    const botPlan = buildTestPlan({ scenarios, botsPerRoom });
    const evidence = makePassingEvidence(botPlan, thresholds);
    const report = buildReport({ plan: botPlan, evidence, thresholds });
    assert.ok(report.collectors.some(item => item.name === "bots"));
    assert.equal(report.metrics["bots.navmeshFailureCount"], 0);
    assert.deepEqual(report.rooms[0].bots, {
      state: "observed",
      desired: botsPerRoom,
      active: botsPerRoom,
      authenticated: botsPerRoom,
      spawnAcknowledged: botsPerRoom,
      navmeshReady: botsPerRoom
    });
  }

  const botPlan = buildTestPlan({ scenarios, botsPerRoom: 5 });
  const incomplete = makePassingEvidence(botPlan, thresholds);
  setRawMetricValues(incomplete, "bots.state.spawnAck", 4);
  assert.throws(() => buildReport({ plan: botPlan, evidence: incomplete, thresholds }), error => error.code === "BOT_EVIDENCE_INVALID");
});

test("physical bot readiness binds the same exact bot identities across every authoritative state", () => {
  const botPlan = buildTestPlan({ scenarios, botsPerRoom: 5 });
  const physical = promoteFixtureEvidenceToPhysical(
    botPlan,
    makePassingEvidence(botPlan, thresholds)
  );
  assert.equal(buildStrictReport({ plan: botPlan, evidence: physical, thresholds }).state, "PASSED");
  const index = physical.raw.samples.findIndex(sample => sample.metric === "bots.state.active");
  assert.notEqual(index, -1);
  const sample = physical.raw.samples[index];
  const semanticProof = structuredClone(sample.source.semanticProof);
  semanticProof.series.find(item => item.labels.bot_id === "bot-005").value = 0;
  semanticProof.series.find(item => item.labels.bot_id === "bot-006").value = 1;
  physical.raw.samples[index] = makeRawSample({
    ...sample,
    source: { ...sample.source, semanticProof }
  });
  physical.raw.samples.sort((left, right) =>
    Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.id.localeCompare(right.id)
  );
  refreshRawArtifact(physical);
  assert.throws(
    () => buildStrictReport({ plan: botPlan, evidence: physical, thresholds }),
    error => error.code === "BOT_IDENTITY_STATE_INVALID"
  );
});

test("mobile active-audio forced-TURN proof is per participant and non-vacuous", () => {
  const profilePlan = buildTestPlan({
    scenarios,
    clientProfile: "mobile",
    audioMode: "active",
    transportMode: "forced-turn"
  });
  const evidence = makePassingEvidence(profilePlan, thresholds);
  const report = buildReport({ plan: profilePlan, evidence, thresholds });
  assert.deepEqual(report.profiles, {
    client: "mobile", runtime: "chromium-mobile-emulation", audio: "active", transport: "forced-turn"
  });

  const falseRelay = structuredClone(evidence);
  setRawMetricValues(falseRelay, "webrtc.selectedCandidateRelay", (_value, index) => index === 0 ? 0 : 1);
  assert.throws(() => buildReport({ plan: profilePlan, evidence: falseRelay, thresholds }), error => error.code === "PROFILE_EVIDENCE_INVALID");
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
  assert.match(report.integrity.sha256, /^[0-9a-f]{64}$/);

  const leaking = { ...failed, reason: "UNTRUSTED_PRIVATE_TEXT_7B2A" };
  assert.throws(
    () => buildReport({ plan, thresholds, evidence: leaking }),
    error => error.code === "EVIDENCE_SCHEMA_INVALID" && !JSON.stringify(error).includes("PRIVATE_TEXT")
  );
});

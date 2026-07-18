import test from "node:test";
import assert from "node:assert/strict";
import {
  OBSERVABILITY_METRIC_CONTRACTS,
  advancePrometheusSeriesProgress,
  aggregateHistogramQuantile,
  deriveCounterIntervalDelta,
  derivePrometheusSemanticValue,
  observabilityReadinessSummary,
  weightedRatio
} from "../lib/observability-contract.mjs";
import {
  assertPhysicalExecutionReady,
  trackedPhysicalReadinessSummary,
  validatePhysicalGeneratorInventory
} from "../lib/physical-readiness.mjs";
import { parsePrometheusVectorSet, startPrometheusCollector } from "../lib/server-collector.mjs";

function vector(entries, evaluationTimestamp = 1_752_746_400, sourceMetric) {
  return {
    status: "success",
    data: {
      resultType: "vector",
      result: entries.map(({ labels, value }) => ({
        metric: sourceMetric ? { __name__: sourceMetric, ...labels } : labels,
        value: [evaluationTimestamp, String(value)]
      }))
    }
  };
}

test("all server observability contracts remain unavailable and production collection is blocked", async () => {
  const summary = observabilityReadinessSummary();
  assert.equal(Object.keys(OBSERVABILITY_METRIC_CONTRACTS).length, 39);
  assert.equal(summary.state, "BLOCKED");
  assert.equal(summary.physicalExecutionAllowed, false);
  assert.equal(summary.certified, false);
  assert.equal(summary.unavailableMetrics.length, 39);
  assert.ok(Object.values(OBSERVABILITY_METRIC_CONTRACTS).every(contract =>
    contract.sourceStatus === "unavailable" && contract.producerArtifactSha256 === null &&
    contract.ruleArtifactSha256 === null && contract.scrapeArtifactSha256 === null));
  await assert.rejects(
    () => startPrometheusCollector({ config: {}, thresholds: {} }),
    error => error.code === "OBSERVABILITY_UNAVAILABLE"
  );
});

test("readiness enumerates every missing prerequisite and candidate-local hashes cannot authorize it", () => {
  const readiness = trackedPhysicalReadinessSummary();
  assert.equal(readiness.state, "BLOCKED");
  assert.equal(readiness.physicalExecutionAllowed, false);
  assert.equal(readiness.certified, false);
  assert.equal(readiness.baseReview.baseOwnedPolicySha256, null);
  assert.equal(readiness.baseReview.reviewAttestationSha256, null);
  assert.ok(readiness.missingPrerequisites.includes("base-owned-readiness-policy-not-materialized"));
  assert.ok(readiness.missingPrerequisites.includes("reticulum-db-arbitration-fencing-not-deployed-and-attested"));
  assert.ok(readiness.missingPrerequisites.includes("prometheus-query-semantics-not-tracked"));
  assert.ok(readiness.missingPrerequisites.includes("prometheus-run-bound-baseline-not-tracked"));
  assert.ok(readiness.missingPrerequisites.includes("metric-unavailable:reticulum.errorCount"));
  assert.throws(
    () => assertPhysicalExecutionReady({
      baseOwnedPolicySha256: "a".repeat(64),
      reviewAttestationSha256: "b".repeat(64)
    }),
    error => error.code === "PHYSICAL_READINESS_BLOCKED"
  );
});

test("multi-series values require the exact signed inventory and separate source timestamps", () => {
  const observedAt = "2026-07-17T10:00:00.000Z";
  const evaluationTimestamp = Date.parse(observedAt) / 1000;
  const sourceMetric = "yenhubs_dialog_eventLoopLagP95Ms";
  const expectedSeries = [{ instance: "dialog-0" }, { instance: "dialog-1" }];
  const values = vector([
    { labels: { instance: "dialog-0" }, value: 0.2 },
    { labels: { instance: "dialog-1" }, value: 0.4 }
  ], evaluationTimestamp, sourceMetric);
  const freshness = vector([
    { labels: { instance: "dialog-0" }, value: evaluationTimestamp - 3 },
    { labels: { instance: "dialog-1" }, value: evaluationTimestamp - 2 }
  ], evaluationTimestamp, sourceMetric);
  const parsed = parsePrometheusVectorSet(values, freshness, {
    observedAt,
    maxSampleAgeSeconds: 30,
    service: "dialog",
    requiredLabels: ["instance"],
    expectedSeries,
    sourceMetric
  });
  assert.deepEqual(parsed.map(item => item.instance), ["dialog-0", "dialog-1"]);
  assert.deepEqual(parsed.map(item => item.sourceObservedAt), [
    "2026-07-17T09:59:57.000Z",
    "2026-07-17T09:59:58.000Z"
  ]);

  const missingReplica = structuredClone(values);
  missingReplica.data.result.pop();
  assert.throws(
    () => parsePrometheusVectorSet(missingReplica, freshness, {
      observedAt,
      maxSampleAgeSeconds: 30,
      service: "dialog",
      requiredLabels: ["instance"],
      expectedSeries,
      sourceMetric
    }),
    error => error.code === "PROMETHEUS_CARDINALITY_INVALID"
  );
});

test("fresh evaluation timestamps cannot hide stale source data", () => {
  const observedAt = "2026-07-17T10:00:00.000Z";
  const evaluationTimestamp = Date.parse(observedAt) / 1000;
  const sourceMetric = "yenhubs_runtime_notReadySeconds";
  const values = vector([{ labels: { instance: "reticulum-0" }, value: 1 }], evaluationTimestamp, sourceMetric);
  const staleFreshness = vector([
    { labels: { instance: "reticulum-0" }, value: evaluationTimestamp - 31 }
  ], evaluationTimestamp, sourceMetric);
  assert.throws(
    () => parsePrometheusVectorSet(values, staleFreshness, {
      observedAt,
      maxSampleAgeSeconds: 30,
      service: "reticulum",
      requiredLabels: ["instance"],
      expectedSeries: [{ instance: "reticulum-0" }],
      sourceMetric
    }),
    error => error.code === "PROMETHEUS_SAMPLE_INVALID"
  );
});

test("per-entity progress is atomic and rejects stalled or rebound counter series", () => {
  const progress = new Map();
  const histogram = (instance, previousObservedAt, currentObservedAt, previous, current) => ({
    labels: { instance },
    previousObservedAt,
    currentObservedAt,
    buckets: [
      { le: 1, previous, current, resets: 0 },
      { le: "+Inf", previous, current, resets: 0 }
    ]
  });
  advancePrometheusSeriesProgress(progress, {
    metric: "database.queryP95Ms",
    roomId: "all",
    series: [
      histogram("database-a", "2026-07-17T10:00:00.000Z", "2026-07-17T10:00:14.000Z", 0, 100),
      histogram("database-b", "2026-07-17T10:00:00.000Z", "2026-07-17T10:00:15.000Z", 0, 100)
    ]
  });
  const beforeStall = structuredClone(progress);
  assert.throws(
    () => advancePrometheusSeriesProgress(progress, {
      metric: "database.queryP95Ms",
      roomId: "all",
      series: [
        histogram("database-a", "2026-07-17T10:00:14.000Z", "2026-07-17T10:00:30.000Z", 100, 200),
        histogram("database-b", "2026-07-17T10:00:15.000Z", "2026-07-17T10:00:15.000Z", 100, 100)
      ]
    }),
    error => error.code === "PROMETHEUS_SAMPLE_REUSED"
  );
  assert.deepEqual(progress, beforeStall);

  const histogramGap = structuredClone(progress);
  assert.throws(
    () => advancePrometheusSeriesProgress(histogramGap, {
      metric: "database.queryP95Ms",
      roomId: "all",
      series: [
        histogram("database-a", "2026-07-17T10:00:14.000Z", "2026-07-17T10:00:30.000Z", 101, 200),
        histogram("database-b", "2026-07-17T10:00:15.000Z", "2026-07-17T10:00:30.000Z", 100, 200)
      ]
    }),
    error => error.code === "PROMETHEUS_COUNTER_CONTINUITY_INVALID"
  );

  const counterProgress = new Map();
  advancePrometheusSeriesProgress(counterProgress, {
    metric: "network.loadBalancerRequestRate",
    roomId: "all",
    series: [{
      labels: { instance: "load-balancer-a" },
      previousObservedAt: "2026-07-17T10:00:00.000Z",
      currentObservedAt: "2026-07-17T10:00:15.000Z",
      previous: 0,
      current: 150,
      resets: 0
    }]
  });
  for (const rebound of [
    { previousObservedAt: "2026-07-17T10:00:16.000Z", previous: 150 },
    { previousObservedAt: "2026-07-17T10:00:15.000Z", previous: 151 }
  ]) {
    assert.throws(
      () => advancePrometheusSeriesProgress(structuredClone(counterProgress), {
        metric: "network.loadBalancerRequestRate",
        roomId: "all",
        series: [{
          labels: { instance: "load-balancer-a" },
          ...rebound,
          currentObservedAt: "2026-07-17T10:00:30.000Z",
          current: 300,
          resets: 0
        }]
      }),
      error => error.code === "PROMETHEUS_COUNTER_CONTINUITY_INVALID"
    );
  }
});

test("ratio counters use interval deltas, reject resets, and permit only a zero-width baseline", () => {
  const common = {
    metricType: "ratio",
    runStartedAt: "2026-07-17T10:00:00.000Z",
    runEndedAt: "2026-07-17T10:01:00.000Z"
  };
  const baseline = derivePrometheusSemanticValue({
    ...common,
    windowStartedAt: "2026-07-17T10:00:00.000Z",
    windowEndedAt: "2026-07-17T10:00:00.000Z",
    series: [{
      labels: { instance: "coturn-a" },
      previousObservedAt: "2026-07-17T10:00:00.000Z",
      currentObservedAt: "2026-07-17T10:00:00.000Z",
      previousNumerator: 20,
      currentNumerator: 20,
      numeratorResets: 0,
      previousDenominator: 100,
      currentDenominator: 100,
      denominatorResets: 0
    }]
  });
  assert.equal(baseline.value, 0);

  const interval = {
    ...common,
    windowStartedAt: "2026-07-17T10:00:00.000Z",
    windowEndedAt: "2026-07-17T10:00:15.000Z",
    series: [{
      labels: { instance: "coturn-a" },
      previousObservedAt: "2026-07-17T10:00:00.000Z",
      currentObservedAt: "2026-07-17T10:00:15.000Z",
      previousNumerator: 20,
      currentNumerator: 21,
      numeratorResets: 0,
      previousDenominator: 100,
      currentDenominator: 200,
      denominatorResets: 0
    }]
  };
  assert.equal(derivePrometheusSemanticValue(interval).value, 0.01);
  assert.throws(
    () => derivePrometheusSemanticValue({
      ...interval,
      series: [{ ...interval.series[0], denominatorResets: 1 }]
    }),
    error => error.code === "COUNTER_RESET_INVALID"
  );
});

test("throughput normalizes each entity by its real source interval", () => {
  const derived = derivePrometheusSemanticValue({
    metricType: "throughput",
    runStartedAt: "2026-07-17T10:00:00.000Z",
    runEndedAt: "2026-07-17T10:01:00.000Z",
    windowStartedAt: "2026-07-17T10:00:00.000Z",
    windowEndedAt: "2026-07-17T10:00:15.000Z",
    series: [
      {
        labels: { instance: "load-balancer-a" },
        previousObservedAt: "2026-07-17T10:00:00.000Z",
        currentObservedAt: "2026-07-17T10:00:14.000Z",
        previous: 0,
        current: 140,
        resets: 0
      },
      {
        labels: { instance: "load-balancer-b" },
        previousObservedAt: "2026-07-17T10:00:01.000Z",
        currentObservedAt: "2026-07-17T10:00:15.000Z",
        previous: 20,
        current: 160,
        resets: 0
      }
    ]
  });
  assert.equal(derived.value, 20);
});

test("an explicitly zero-bot appearance histogram accepts honest empty bucket deltas only with contextual permission", () => {
  const proof = {
    metricType: "histogram",
    runStartedAt: "2026-07-17T10:00:00.000Z",
    runEndedAt: "2026-07-17T10:01:00.000Z",
    windowStartedAt: "2026-07-17T10:00:00.000Z",
    windowEndedAt: "2026-07-17T10:00:15.000Z",
    series: [{
      labels: { instance: "bot-runner-a" },
      previousObservedAt: "2026-07-17T10:00:00.000Z",
      currentObservedAt: "2026-07-17T10:00:15.000Z",
      buckets: [
        { le: 1, previous: 0, current: 0, resets: 0 },
        { le: "+Inf", previous: 0, current: 0, resets: 0 }
      ]
    }]
  };
  assert.throws(
    () => derivePrometheusSemanticValue(proof),
    error => error.code === "METRIC_SEMANTICS_INVALID"
  );
  assert.equal(derivePrometheusSemanticValue({ ...proof, allowEmptyHistogram: true }).value, 0);
});

test("histograms aggregate buckets before quantiles and ratios are denominator weighted", () => {
  const aggregatedP95 = aggregateHistogramQuantile([
    { buckets: [{ le: 1, count: 95 }, { le: 10, count: 100 }, { le: "+Inf", count: 100 }] },
    { buckets: [{ le: 1, count: 0 }, { le: 10, count: 100 }, { le: "+Inf", count: 100 }] }
  ]);
  assert.ok(Math.abs(aggregatedP95 - 9.142857) < 0.00001);
  assert.notEqual(aggregatedP95, (1 + 9.55) / 2);
  assert.equal(weightedRatio([
    { numerator: 1, denominator: 1 },
    { numerator: 0, denominator: 99 }
  ]), 0.01);
  assert.throws(
    () => aggregateHistogramQuantile([
      { buckets: [{ le: 10, count: 1 }, { le: 1, count: 2 }, { le: "+Inf", count: 2 }] }
    ]),
    error => error.code === "METRIC_SEMANTICS_INVALID"
  );
  assert.throws(
    () => derivePrometheusSemanticValue({
      metricType: "histogram",
      runStartedAt: "2026-07-17T10:00:00.000Z",
      runEndedAt: "2026-07-17T10:01:00.000Z",
      windowStartedAt: "2026-07-17T10:00:00.000Z",
      windowEndedAt: "2026-07-17T10:00:15.000Z",
      series: [{
        labels: { instance: "database-a" },
        previousObservedAt: "2026-07-17T10:00:00.000Z",
        currentObservedAt: "2026-07-17T10:00:15.000Z",
        buckets: [
          { le: 1, previous: 100, current: 101, resets: 0 },
          { le: "+Inf", previous: 0, current: 1, resets: 0 }
        ]
      }]
    }),
    error => error.code === "METRIC_SEMANTICS_INVALID"
  );
});

test("counter resets, pod churn and pre-run windows fail closed", () => {
  const base = {
    previous: [{ entity: "pod-a", value: 10 }],
    current: [{ entity: "pod-a", value: 12 }],
    resets: [{ entity: "pod-a", value: 0 }],
    runStartedAt: "2026-07-17T10:00:00.000Z",
    runEndedAt: "2026-07-17T10:01:00.000Z",
    windowStartedAt: "2026-07-17T10:00:00.000Z",
    windowEndedAt: "2026-07-17T10:00:15.000Z"
  };
  assert.deepEqual(deriveCounterIntervalDelta(base), {
    value: 2,
    resetObserved: false,
    certified: false
  });
  assert.throws(
    () => deriveCounterIntervalDelta({ ...base, resets: [{ entity: "pod-a", value: 1 }] }),
    error => error.code === "COUNTER_RESET_INVALID"
  );
  assert.throws(
    () => deriveCounterIntervalDelta({
      ...base,
      previous: [{ entity: "pod-a", value: 1 }],
      current: [{ entity: "pod-a", value: 0 }],
      resets: [{ entity: "pod-a", value: 1 }]
    }),
    error => error.code === "COUNTER_RESET_INVALID"
  );
  assert.throws(
    () => deriveCounterIntervalDelta({
      ...base,
      current: [{ entity: "pod-a", value: 2 }]
    }),
    error => error.code === "COUNTER_RESET_INVALID"
  );
  assert.throws(
    () => deriveCounterIntervalDelta({
      ...base,
      current: [{ entity: "pod-b", value: 12 }],
      resets: [{ entity: "pod-b", value: 0 }]
    }),
    error => error.code === "COUNTER_SERIES_CHURN"
  );
  assert.throws(
    () => deriveCounterIntervalDelta({ ...base, windowStartedAt: "2026-07-17T09:59:59.000Z" }),
    error => error.code === "COUNTER_SCOPE_INVALID"
  );
  assert.throws(
    () => deriveCounterIntervalDelta({ ...base, windowEndedAt: "2026-07-17T10:01:01.000Z" }),
    error => error.code === "COUNTER_SCOPE_INVALID"
  );
});

test("physical hosts require unique machine identity and a zero-orphan STOP proof", () => {
  const plan = {
    planId: "plan-physical-inventory-test",
    run: { id: "11111111-1111-4111-8111-111111111111" },
    executionTopology: { hosts: [{ id: "host-001" }, { id: "host-002" }] }
  };
  const run = { id: plan.run.id, endedAt: "2026-07-17T10:01:00.000Z" };
  const hosts = [
    {
      hostId: "host-001",
      machineId: "machine-0001",
      bootId: "boot-id-0001",
      cgroupPath: `/capacity/${plan.run.id}/host-001`,
      rootPid: 101,
      liveDescendantCountAfterStop: 0,
      liveBrowserCountAfterStop: 0
    },
    {
      hostId: "host-002",
      machineId: "machine-0002",
      bootId: "boot-id-0002",
      cgroupPath: `/capacity/${plan.run.id}/host-002`,
      rootPid: 202,
      liveDescendantCountAfterStop: 0,
      liveBrowserCountAfterStop: 0
    }
  ];
  const inventory = {
    schemaVersion: 1,
    planId: plan.planId,
    runId: plan.run.id,
    observedAt: run.endedAt,
    hosts
  };
  assert.equal(validatePhysicalGeneratorInventory(inventory, { plan, run }).hosts.length, 2);
  const duplicateMachine = structuredClone(inventory);
  duplicateMachine.hosts[1].machineId = duplicateMachine.hosts[0].machineId;
  assert.throws(
    () => validatePhysicalGeneratorInventory(duplicateMachine, { plan, run }),
    error => error.code === "PHYSICAL_HOST_IDENTITY_INVALID"
  );
  const orphan = structuredClone(inventory);
  orphan.hosts[0].liveDescendantCountAfterStop = 1;
  assert.throws(
    () => validatePhysicalGeneratorInventory(orphan, { plan, run }),
    error => error.code === "PHYSICAL_HOST_IDENTITY_INVALID"
  );
  const rebound = structuredClone(inventory);
  rebound.runId = "22222222-2222-4222-8222-222222222222";
  assert.throws(
    () => validatePhysicalGeneratorInventory(rebound, { plan, run }),
    error => error.code === "PHYSICAL_HOST_IDENTITY_INVALID"
  );
  const cgroupSubstring = structuredClone(inventory);
  cgroupSubstring.hosts[0].cgroupPath = `/capacity/${plan.run.id}-forged/host-001`;
  assert.throws(
    () => validatePhysicalGeneratorInventory(cgroupSubstring, { plan, run }),
    error => error.code === "PHYSICAL_HOST_IDENTITY_INVALID"
  );
  assert.throws(
    () => validatePhysicalGeneratorInventory(inventory, { plan, run, expectedHostIds: ["host-999"] }),
    error => error.code === "PHYSICAL_HOST_IDENTITY_INVALID"
  );
});

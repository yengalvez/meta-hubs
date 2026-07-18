import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadThresholds } from "../lib/io.mjs";
import { validateThresholds } from "../lib/schema.mjs";
import {
  parsePrometheusSample,
  parsePrometheusVectorSet,
  queryPrometheusSemanticMetric,
  validateCollectorConfig
} from "../lib/server-collector.mjs";
import {
  trackedCollectorConfig,
  trackedCollectorMappingIdentity,
  validateTrackedCollectorMappingIdentity
} from "../lib/collector-contract.mjs";
import { canonicalJson } from "../lib/io.mjs";
import { observabilityReadinessSummary } from "../lib/observability-contract.mjs";
import { BOT_STATE_METRICS } from "../lib/metric-contracts.mjs";

const thresholds = validateThresholds(await loadThresholds());
function config() {
  return trackedCollectorConfig();
}

test("semantic Prometheus mapping is hash-bound while physical evidence remains unavailable", () => {
  const valid = validateCollectorConfig(config(), thresholds);
  assert.equal(observabilityReadinessSummary().state, "BLOCKED");
  assert.equal(valid.listenHost, "127.0.0.1");
  assert.equal(Object.keys(valid.metrics).length > 30, true);
  assert.equal(valid.mapping.version, "v4");
  assert.equal(valid.metrics["runtime.oomCount"].query, "yenhubs_runtime_oomCount");
  assert.equal(valid.metrics["bots.errorCount"].query, 'yenhubs_bots_errorCount{room="{room}"}');
  assert.ok(Object.values(valid.metrics).every(mapping => !/\b(?:increase|rate|histogram_quantile)\s*\(/.test(mapping.query)));
  assert.ok(Object.entries(valid.seriesInventory).every(([metric, series]) =>
    Object.hasOwn(BOT_STATE_METRICS, metric)
      ? series.length === 10
      : series.length === 1
  ));

  const missing = config();
  delete missing.metrics["dialog.eventLoopLagP95Ms"];
  assert.throws(() => validateCollectorConfig(missing, thresholds), error => error.code === "COLLECTOR_CONFIG_INVALID");

  const exposed = config();
  exposed.listenHost = "0.0.0.0";
  assert.throws(() => validateCollectorConfig(exposed, thresholds), error => error.code === "COLLECTOR_CONFIG_INVALID");

  const unscopedBot = config();
  unscopedBot.metrics["bots.state.active"].query = `sum by (instance) (${unscopedBot.metrics["bots.state.active"].sourceMetric})`;
  assert.throws(() => validateCollectorConfig(unscopedBot, thresholds), error => error.code === "COLLECTOR_CONFIG_INVALID");

  for (const query of [
    "vector(0)",
    "scalar(0)",
    "label_replace(up, \"x\", \"y\", \"z\", \".*\")",
    "0",
    "yenhubs_dialog_eventLoopLagP95Ms * 0"
  ]) {
    const synthetic = config();
    synthetic.metrics["dialog.eventLoopLagP95Ms"].query = query;
    assert.throws(() => validateCollectorConfig(synthetic, thresholds), error => error.code === "COLLECTOR_CONFIG_INVALID");
  }
});

test("a self-hash cannot authorize extra collector configuration", () => {
  for (const mutate of [
    identity => { identity.configuration.unreviewed = true; },
    identity => { identity.configuration.metrics["dialog.eventLoopLagP95Ms"].unreviewed = true; },
    identity => { identity.configuration.prometheusUrl = "https://prometheus-capacity-staging.example.org/"; }
  ]) {
    const identity = trackedCollectorMappingIdentity();
    mutate(identity);
    identity.sha256 = createHash("sha256")
      .update(canonicalJson(identity.configuration))
      .digest("hex");
    assert.throws(
      () => validateTrackedCollectorMappingIdentity(identity),
      error => error.code === "COLLECTOR_MAPPING_INVALID"
    );
  }
});

test("legacy single-vector parser stays strict and is not used as semantic evidence", () => {
  const observedAt = "2026-07-17T10:00:00.000Z";
  const valid = {
    status: "success",
    data: {
      resultType: "vector",
      result: [{ metric: { instance: "dialog-0" }, value: [Date.parse(observedAt) / 1000, "0.42"] }]
    }
  };
  assert.deepEqual(parsePrometheusSample(valid, {
    observedAt, maxSampleAgeSeconds: 30, service: "dialog", requiredLabels: ["instance"]
  }), {
    value: 0.42,
    labels: { instance: "dialog-0" },
    instance: "dialog-0",
    sourceObservedAt: observedAt
  });

  const stale = structuredClone(valid);
  stale.data.result[0].value[0] -= 31;
  assert.throws(
    () => parsePrometheusSample(stale, {
      observedAt, maxSampleAgeSeconds: 30, service: "dialog", requiredLabels: ["instance"]
    }),
    error => error.code === "PROMETHEUS_SAMPLE_INVALID"
  );

  const ambiguous = structuredClone(valid);
  ambiguous.data.result.push(structuredClone(ambiguous.data.result[0]));
  assert.throws(
    () => parsePrometheusSample(ambiguous, {
      observedAt, maxSampleAgeSeconds: 30, service: "dialog", requiredLabels: ["instance"]
    }),
    error => error.code === "PROMETHEUS_SAMPLE_INVALID"
  );

  const extraLabel = structuredClone(valid);
  extraLabel.data.result[0].metric.token = "unreviewed-channel";
  assert.throws(
    () => parsePrometheusSample(extraLabel, {
      observedAt, maxSampleAgeSeconds: 30, service: "dialog", requiredLabels: ["instance"]
    }),
    error => error.code === "PROMETHEUS_SAMPLE_INVALID"
  );
});

test("semantic parsing validates and strips Prometheus metric and fixed room labels", () => {
  const observedAt = "2026-07-17T10:00:15.000Z";
  const epoch = Date.parse(observedAt) / 1000;
  const sourceMetric = "yenhubs_bots_state_active";
  const labels = { bot_id: "bot-001", instance: "runner-a", room: "room-001" };
  const values = vector([{ labels, value: 1 }], epoch, sourceMetric);
  const freshness = vector([{ labels, value: epoch }], epoch, sourceMetric);
  const options = {
    observedAt,
    maxSampleAgeSeconds: 30,
    service: "bots",
    requiredLabels: ["bot_id", "instance"],
    expectedSeries: [{ bot_id: "bot-001", instance: "runner-a" }],
    sourceMetric,
    fixedLabels: { room: "room-001" }
  };
  assert.deepEqual(parsePrometheusVectorSet(values, freshness, options)[0].labels, {
    bot_id: "bot-001",
    instance: "runner-a"
  });
  for (const mutate of [
    body => { body.data.result[0].metric.__name__ = "yenhubs_bots_state_desired"; },
    body => { body.data.result[0].metric.room = "room-002"; }
  ]) {
    const forged = structuredClone(values);
    mutate(forged);
    assert.throws(
      () => parsePrometheusVectorSet(forged, freshness, options),
      error => error.code === "PROMETHEUS_SAMPLE_INVALID"
    );
  }
});

function sourceMetricForQuery(query) {
  const expression = query.startsWith("timestamp(")
    ? query.slice("timestamp(".length, -1)
    : query.startsWith("resets(")
      ? query.slice("resets(".length, query.lastIndexOf("["))
      : query;
  return expression.match(/^[a-zA-Z_:][a-zA-Z0-9_:]*/)?.[0];
}

function vector(entries, evaluationTimestamp, sourceMetric) {
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

test("real collector path derives counters, rejects resets, and aggregates histograms and ratios", async () => {
  const runStartedAt = "2026-07-17T10:00:00.000Z";
  const observedAt = "2026-07-17T10:00:15.000Z";
  const runEndedAt = "2026-07-17T10:01:00.000Z";
  const previousEpoch = Date.parse(runStartedAt) / 1000;
  const currentEpoch = Date.parse(observedAt) / 1000;
  const rawConfig = config();
  for (const metric of ["runtime.oomCount", "database.queryP95Ms", "coturn.allocationFailureRate"]) {
    rawConfig.seriesInventory[metric] = [{ instance: "source-a" }, { instance: "source-b" }];
  }
  const safeConfig = validateCollectorConfig(rawConfig, thresholds);
  const originalFetch = globalThis.fetch;
  let counterResetValue = 0;
  let histogramResetValue = 0;
  let ratioResetValue = 0;
  const observedQueries = [];
  globalThis.fetch = async input => {
    const url = new URL(input);
    const query = url.searchParams.get("query");
    const evaluationTimestamp = Number(url.searchParams.get("time"));
    observedQueries.push(query);
    let entries;
    if (query === "yenhubs_runtime_oomCount") {
      entries = evaluationTimestamp === previousEpoch
        ? [
            { labels: { instance: "source-a" }, value: 10 },
            { labels: { instance: "source-b" }, value: 20 }
          ]
        : [
            { labels: { instance: "source-a" }, value: 12 },
            { labels: { instance: "source-b" }, value: 23 }
          ];
    } else if (query === "timestamp(yenhubs_runtime_oomCount)") {
      entries = [
        { labels: { instance: "source-a" }, value: evaluationTimestamp },
        { labels: { instance: "source-b" }, value: evaluationTimestamp }
      ];
    } else if (query === "resets(yenhubs_runtime_oomCount[15001ms])") {
      entries = [
        { labels: { instance: "source-a" }, value: counterResetValue },
        { labels: { instance: "source-b" }, value: counterResetValue }
      ];
    } else if (query === "yenhubs_database_queryP95Ms_bucket") {
      entries = evaluationTimestamp === previousEpoch
        ? [
            { labels: { instance: "source-a", le: "1" }, value: 0 },
            { labels: { instance: "source-a", le: "10" }, value: 0 },
            { labels: { instance: "source-a", le: "+Inf" }, value: 0 },
            { labels: { instance: "source-b", le: "1" }, value: 0 },
            { labels: { instance: "source-b", le: "10" }, value: 0 },
            { labels: { instance: "source-b", le: "+Inf" }, value: 0 }
          ]
        : [
            { labels: { instance: "source-a", le: "1" }, value: 95 },
            { labels: { instance: "source-a", le: "10" }, value: 100 },
            { labels: { instance: "source-a", le: "+Inf" }, value: 100 },
            { labels: { instance: "source-b", le: "1" }, value: 0 },
            { labels: { instance: "source-b", le: "10" }, value: 100 },
            { labels: { instance: "source-b", le: "+Inf" }, value: 100 }
          ];
    } else if (query === "timestamp(yenhubs_database_queryP95Ms_bucket)") {
      entries = [
        { labels: { instance: "source-a", le: "1" }, value: currentEpoch },
        { labels: { instance: "source-a", le: "10" }, value: currentEpoch },
        { labels: { instance: "source-a", le: "+Inf" }, value: currentEpoch },
        { labels: { instance: "source-b", le: "1" }, value: currentEpoch },
        { labels: { instance: "source-b", le: "10" }, value: currentEpoch },
        { labels: { instance: "source-b", le: "+Inf" }, value: currentEpoch }
      ];
      if (evaluationTimestamp === previousEpoch) {
        entries = entries.map(entry => ({ ...entry, value: previousEpoch }));
      }
    } else if (query === "resets(yenhubs_database_queryP95Ms_bucket[15001ms])") {
      entries = [
        { labels: { instance: "source-a", le: "1" }, value: histogramResetValue },
        { labels: { instance: "source-a", le: "10" }, value: histogramResetValue },
        { labels: { instance: "source-a", le: "+Inf" }, value: histogramResetValue },
        { labels: { instance: "source-b", le: "1" }, value: histogramResetValue },
        { labels: { instance: "source-b", le: "10" }, value: histogramResetValue },
        { labels: { instance: "source-b", le: "+Inf" }, value: histogramResetValue }
      ];
    } else if (query === "yenhubs_coturn_allocationFailureRate_numerator") {
      entries = evaluationTimestamp === previousEpoch
        ? [
            { labels: { instance: "source-a" }, value: 10 },
            { labels: { instance: "source-b" }, value: 20 }
          ]
        : [
            { labels: { instance: "source-a" }, value: 11 },
            { labels: { instance: "source-b" }, value: 20 }
          ];
    } else if (query === "yenhubs_coturn_allocationFailureRate_denominator") {
      entries = evaluationTimestamp === previousEpoch
        ? [
            { labels: { instance: "source-a" }, value: 100 },
            { labels: { instance: "source-b" }, value: 200 }
          ]
        : [
            { labels: { instance: "source-a" }, value: 101 },
            { labels: { instance: "source-b" }, value: 299 }
          ];
    } else if (query.startsWith("timestamp(yenhubs_coturn_allocationFailureRate_")) {
      entries = [
        { labels: { instance: "source-a" }, value: evaluationTimestamp },
        { labels: { instance: "source-b" }, value: evaluationTimestamp }
      ];
    } else if (query === "resets(yenhubs_coturn_allocationFailureRate_numerator[15001ms])" ||
        query === "resets(yenhubs_coturn_allocationFailureRate_denominator[15001ms])") {
      entries = [
        { labels: { instance: "source-a" }, value: ratioResetValue },
        { labels: { instance: "source-b" }, value: ratioResetValue }
      ];
    } else {
      throw new Error(`Unexpected Prometheus query: ${query}`);
    }
    return new Response(JSON.stringify(vector(entries, evaluationTimestamp, sourceMetricForQuery(query))), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const collect = metric => queryPrometheusSemanticMetric({
    config: safeConfig,
    metric,
    mapping: safeConfig.metrics[metric],
    observedAt,
    runStartedAt,
    runEndedAt,
    intervalSeconds: 15,
    signal: AbortSignal.timeout(5_000)
  });
  try {
    const counter = await collect("runtime.oomCount");
    assert.equal(counter.value, 5);
    assert.equal(counter.semanticProof.resetObserved, false);
    assert.equal(counter.semanticProof.certified, false);
    counterResetValue = 1;
    await assert.rejects(
      () => collect("runtime.oomCount"),
      error => error.code === "COUNTER_RESET_INVALID"
    );
    counterResetValue = 0;
    const histogram = await collect("database.queryP95Ms");
    assert.ok(Math.abs(histogram.value - 9.142857) < 0.00001);
    assert.equal(histogram.semanticProof.series.length, 2);
    histogramResetValue = 1;
    await assert.rejects(
      () => collect("database.queryP95Ms"),
      error => error.code === "COUNTER_RESET_INVALID"
    );
    histogramResetValue = 0;
    const ratio = await collect("coturn.allocationFailureRate");
    assert.equal(ratio.value, 0.01);
    assert.equal(ratio.semanticProof.series.length, 2);
    ratioResetValue = 1;
    await assert.rejects(
      () => collect("coturn.allocationFailureRate"),
      error => error.code === "COUNTER_RESET_INVALID"
    );
    assert.ok(observedQueries.includes("resets(yenhubs_runtime_oomCount[15001ms])"));
    assert.ok(observedQueries.includes("resets(yenhubs_database_queryP95Ms_bucket[15001ms])"));
    assert.ok(observedQueries.includes("yenhubs_database_queryP95Ms_bucket"));
    assert.ok(observedQueries.includes("yenhubs_coturn_allocationFailureRate_numerator"));
    assert.ok(observedQueries.includes("resets(yenhubs_coturn_allocationFailureRate_numerator[15001ms])"));
    assert.ok(observedQueries.includes("resets(yenhubs_coturn_allocationFailureRate_denominator[15001ms])"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reset queries cover the real lagged baseline for every interval counter family", async () => {
  const runStartedAt = "2026-07-17T10:00:00.000Z";
  const intervalStartedAt = "2026-07-17T10:00:15.000Z";
  const baselineObservedAt = "2026-07-17T10:00:14.000Z";
  const observedAt = "2026-07-17T10:00:30.000Z";
  const runEndedAt = "2026-07-17T10:01:00.000Z";
  const intervalEpoch = Date.parse(intervalStartedAt) / 1000;
  const currentEpoch = Date.parse(observedAt) / 1000;
  const baselineEpoch = Date.parse(baselineObservedAt) / 1000;
  const safeConfig = validateCollectorConfig(config(), thresholds);
  const originalFetch = globalThis.fetch;
  const queries = [];
  globalThis.fetch = async input => {
    const url = new URL(input);
    const query = url.searchParams.get("query");
    const evaluationTimestamp = Number(url.searchParams.get("time"));
    queries.push(query);
    const previous = evaluationTimestamp === intervalEpoch;
    let entries;
    if (query === "yenhubs_runtime_oomCount") {
      entries = [{ labels: { instance: "fixture-1" }, value: previous ? 10 : 12 }];
    } else if (query === "yenhubs_network_loadBalancerRequestRate") {
      entries = [{ labels: { instance: "fixture-1" }, value: previous ? 100 : 132 }];
    } else if (query === "yenhubs_database_queryP95Ms_bucket") {
      entries = previous
        ? [
            { labels: { instance: "fixture-1", le: "1" }, value: 0 },
            { labels: { instance: "fixture-1", le: "10" }, value: 0 },
            { labels: { instance: "fixture-1", le: "+Inf" }, value: 0 }
          ]
        : [
            { labels: { instance: "fixture-1", le: "1" }, value: 95 },
            { labels: { instance: "fixture-1", le: "10" }, value: 100 },
            { labels: { instance: "fixture-1", le: "+Inf" }, value: 100 }
          ];
    } else if (query === "yenhubs_coturn_allocationFailureRate_numerator") {
      entries = [{ labels: { instance: "fixture-1" }, value: previous ? 10 : 11 }];
    } else if (query === "yenhubs_coturn_allocationFailureRate_denominator") {
      entries = [{ labels: { instance: "fixture-1" }, value: previous ? 100 : 200 }];
    } else if (query.startsWith("timestamp(yenhubs_database_queryP95Ms_bucket)")) {
      entries = ["1", "10", "+Inf"].map(le => ({
        labels: { instance: "fixture-1", le },
        value: previous ? baselineEpoch : currentEpoch
      }));
    } else if (query.startsWith("timestamp(yenhubs_")) {
      entries = [{
        labels: { instance: "fixture-1" },
        value: previous ? baselineEpoch : currentEpoch
      }];
    } else if (query.startsWith("resets(") && query.endsWith("[16001ms])")) {
      entries = query.includes("_bucket")
        ? ["1", "10", "+Inf"].map(le => ({ labels: { instance: "fixture-1", le }, value: 0 }))
        : [{ labels: { instance: "fixture-1" }, value: 0 }];
    } else {
      throw new Error(`Unexpected Prometheus query: ${query}`);
    }
    return new Response(JSON.stringify(vector(entries, evaluationTimestamp, sourceMetricForQuery(query))), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const collect = metric => queryPrometheusSemanticMetric({
    config: safeConfig,
    metric,
    mapping: safeConfig.metrics[metric],
    observedAt,
    runStartedAt,
    runEndedAt,
    intervalSeconds: 15,
    intervalStartedAt,
    signal: AbortSignal.timeout(5_000)
  });
  try {
    assert.equal((await collect("runtime.oomCount")).value, 2);
    assert.equal((await collect("network.loadBalancerRequestRate")).value, 2);
    assert.equal((await collect("database.queryP95Ms")).semanticProof.windowStartedAt, baselineObservedAt);
    assert.equal((await collect("coturn.allocationFailureRate")).value, 0.01);
    assert.ok(queries.includes("resets(yenhubs_runtime_oomCount[16001ms])"));
    assert.ok(queries.includes("resets(yenhubs_network_loadBalancerRequestRate[16001ms])"));
    assert.ok(queries.includes("resets(yenhubs_database_queryP95Ms_bucket[16001ms])"));
    assert.ok(queries.includes("resets(yenhubs_coturn_allocationFailureRate_numerator[16001ms])"));
    assert.ok(queries.includes("resets(yenhubs_coturn_allocationFailureRate_denominator[16001ms])"));
    assert.equal(queries.some(query => query.startsWith("resets(") && query.endsWith("[16000ms])")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gauge semantics accept a fresh in-run scrape timestamp that is not the evaluation millisecond", async () => {
  const runStartedAt = "2026-07-17T10:00:00.000Z";
  const observedAt = "2026-07-17T10:00:15.000Z";
  const sourceObservedAt = "2026-07-17T10:00:14.000Z";
  const evaluationEpoch = Date.parse(observedAt) / 1000;
  const sourceEpoch = Date.parse(sourceObservedAt) / 1000;
  const safeConfig = validateCollectorConfig(config(), thresholds);
  const mapping = safeConfig.metrics["runtime.notReadySeconds"];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = new URL(input);
    const query = url.searchParams.get("query");
    const entries = [{ labels: { instance: "fixture-1" }, value: query.startsWith("timestamp(") ? sourceEpoch : 2 }];
    return new Response(JSON.stringify(vector(entries, evaluationEpoch, sourceMetricForQuery(query))), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  try {
    const sample = await queryPrometheusSemanticMetric({
      config: safeConfig,
      metric: "runtime.notReadySeconds",
      mapping,
      observedAt,
      runStartedAt,
      runEndedAt: "2026-07-17T10:01:00.000Z",
      intervalSeconds: 15,
      signal: AbortSignal.timeout(5_000)
    });
    assert.equal(sample.value, 2);
    assert.equal(sample.sourceObservedAt, sourceObservedAt);
    assert.equal(sample.semanticProof.windowStartedAt, runStartedAt);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a first interval with only a pre-run counter baseline stays blocked instead of contaminating the run", async () => {
  const runStartedAt = "2026-07-17T10:00:00.000Z";
  const observedAt = "2026-07-17T10:00:15.000Z";
  const runStartedEpoch = Date.parse(runStartedAt) / 1000;
  const observedEpoch = Date.parse(observedAt) / 1000;
  const safeConfig = validateCollectorConfig(config(), thresholds);
  const mapping = safeConfig.metrics["runtime.oomCount"];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = new URL(input);
    const query = url.searchParams.get("query");
    const evaluationEpoch = Number(url.searchParams.get("time"));
    const previous = evaluationEpoch === runStartedEpoch;
    const value = query.startsWith("timestamp(")
      ? previous ? runStartedEpoch - 1 : observedEpoch - 1
      : previous ? 10 : 12;
    return new Response(JSON.stringify(vector([
      { labels: { instance: "fixture-1" }, value }
    ], evaluationEpoch, sourceMetricForQuery(query))), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  try {
    await assert.rejects(
      () => queryPrometheusSemanticMetric({
        config: safeConfig,
        metric: "runtime.oomCount",
        mapping,
        observedAt,
        runStartedAt,
        runEndedAt: "2026-07-17T10:01:00.000Z",
        intervalSeconds: 15,
        signal: AbortSignal.timeout(5_000)
      }),
      error => error.code === "PROMETHEUS_SAMPLE_INVALID"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("early counter collection never queries a baseline or reset window before run start", async () => {
  const runStartedAt = "2026-07-17T10:00:00.000Z";
  const observedAt = "2026-07-17T10:00:05.000Z";
  const runEndedAt = "2026-07-17T10:01:00.000Z";
  const runStartedEpoch = Date.parse(runStartedAt) / 1000;
  const config = validateCollectorConfig(trackedCollectorConfig(), thresholds);
  const mapping = config.metrics["runtime.oomCount"];
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async input => {
    const url = new URL(input);
    const query = url.searchParams.get("query");
    const evaluationTimestamp = Number(url.searchParams.get("time"));
    requests.push({ query, evaluationTimestamp });
    let entries;
    if (query === "yenhubs_runtime_oomCount") {
      entries = [{
        labels: { instance: "fixture-1" },
        value: evaluationTimestamp === runStartedEpoch ? 10 : 12
      }];
    } else if (query === "timestamp(yenhubs_runtime_oomCount)") {
      entries = [{ labels: { instance: "fixture-1" }, value: evaluationTimestamp }];
    } else if (query === "resets(yenhubs_runtime_oomCount[5001ms])") {
      entries = [{ labels: { instance: "fixture-1" }, value: 0 }];
    } else if (query === "resets(yenhubs_runtime_oomCount[15s])") {
      // This represents the pre-run reset that the old fixed interval leaked
      // into the first five seconds of the signed run.
      entries = [{ labels: { instance: "fixture-1" }, value: 1 }];
    } else {
      throw new Error(`Unexpected Prometheus query: ${query}`);
    }
    return new Response(JSON.stringify(vector(entries, evaluationTimestamp, sourceMetricForQuery(query))), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const collect = at => queryPrometheusSemanticMetric({
    config,
    metric: "runtime.oomCount",
    mapping,
    observedAt: at,
    runStartedAt,
    runEndedAt,
    intervalSeconds: 15,
    signal: AbortSignal.timeout(5_000)
  });
  try {
    const baseline = await collect(runStartedAt);
    assert.equal(baseline.value, 0);
    assert.equal(requests.some(item => item.query.startsWith("resets(")), false);
    requests.length = 0;
    const firstInterval = await collect(observedAt);
    assert.equal(firstInterval.value, 2);
    assert.ok(requests.every(item => item.evaluationTimestamp >= runStartedEpoch));
    assert.ok(requests.some(item => item.query === "resets(yenhubs_runtime_oomCount[5001ms])"));
    assert.equal(requests.some(item => item.query === "resets(yenhubs_runtime_oomCount[15s])"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

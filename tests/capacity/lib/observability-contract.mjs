import { createHash } from "node:crypto";
import { invalid } from "./errors.mjs";
import { canonicalJson } from "./io.mjs";

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function canonicalTime(value) {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? milliseconds
    : null;
}

// This file describes the evidence that would be required to make every
// server-side capacity metric meaningful. It intentionally does not assign
// Prometheus metric names: no matching exporters or recording rules are
// currently tracked in this repository, so inventing names here would turn a
// design requirement into apparent observability.
const groups = {
  counter: [
    "reticulum.errorCount",
    "runtime.oomCount",
    "runtime.evictionCount",
    "runtime.workerDeathCount",
    "runtime.restartCount",
    "network.loadBalancerDropCount",
    "database.deadlockCount",
    "dialog.errorCount",
    "bots.navmeshFailureCount",
    "bots.errorCount"
  ],
  histogram: [
    "reticulum.channelJoinP95Ms",
    "network.loadBalancerP95Ms",
    "database.connectionUtilizationP95",
    "database.poolUtilizationP95",
    "database.queryP95Ms",
    "database.poolWaitP95Ms",
    "dialog.workerSaturationP95",
    "dialog.eventLoopLagP95Ms",
    "bots.appearanceP95Ms"
  ],
  ratio: [
    "reticulum.websocketDisconnectRate",
    "network.loadBalancer5xxRate",
    "coturn.allocationFailureRate",
    "coturn.relayFailureRate"
  ],
  utilization: [
    "kubernetes.cpuUtilization",
    "kubernetes.memoryUtilization",
    "kubernetes.podMemoryLimitUtilization"
  ],
  throughput: [
    "network.loadBalancerRequestRate",
    "coturn.trafficBytesPerSecond",
    "dialog.trafficMessagesPerSecond"
  ],
  duration: ["runtime.notReadySeconds"],
  nodeCapacity: ["model.nodeCpuMillicores", "model.nodeMemoryMiB"],
  clusterUsage: ["model.usedCpuMillicores", "model.usedMemoryMiB"],
  authoritativeState: [
    "bots.state.desired",
    "bots.state.active",
    "bots.state.authenticated",
    "bots.state.spawnAck",
    "bots.state.navmeshReady"
  ]
};

export const AUTHORITATIVE_BOT_STATE_METRICS = Object.freeze([...groups.authoritativeState]);

function semantics(metric, type) {
  const roomScoped = metric.startsWith("bots.");
  if (type === "counter") return {
    entityScope: roomScoped ? "room-and-service-instance" : "service-instance",
    requiredEvidence: "raw-counter-series-plus-explicit-reset-series",
    crossEntityAggregation: "sum-per-interval-deltas-after-exact-entity-coverage"
  };
  if (type === "histogram") return {
    entityScope: roomScoped ? "room-and-service-instance" : "service-instance",
    requiredEvidence: "cumulative-histogram-buckets",
    crossEntityAggregation: "sum-buckets-by-upper-bound-then-histogram-quantile"
  };
  if (type === "ratio") return {
    entityScope: "service-instance",
    requiredEvidence: "raw-numerator-and-denominator-counters",
    crossEntityAggregation: "sum-numerators-divided-by-sum-denominators"
  };
  if (type === "utilization") return {
    entityScope: metric.includes("podMemory") ? "kubernetes-pod" : "kubernetes-node",
    requiredEvidence: "raw-used-and-capacity-or-limit-gauges",
    crossEntityAggregation: metric.includes("podMemory")
      ? "maximum-per-pod-used-divided-by-limit"
      : "maximum-per-node-used-divided-by-allocatable"
  };
  if (type === "throughput") return {
    entityScope: "service-instance",
    requiredEvidence: "raw-monotonic-byte-or-event-counter",
    crossEntityAggregation: "sum-per-instance-rates-after-exact-entity-coverage"
  };
  if (type === "duration") return {
    entityScope: "kubernetes-pod",
    requiredEvidence: "pod-readiness-condition-and-transition-timestamp",
    crossEntityAggregation: "maximum-current-not-ready-duration"
  };
  if (type === "nodeCapacity") return {
    entityScope: "kubernetes-node",
    requiredEvidence: "node-allocatable-inventory",
    crossEntityAggregation: "validate-every-node-then-retain-per-node-capacity"
  };
  if (type === "clusterUsage") return {
    entityScope: "kubernetes-node",
    requiredEvidence: "raw-node-usage-gauges",
    crossEntityAggregation: "sum-all-nodes-per-tick-then-temporal-p95"
  };
  return {
    entityScope: "room-and-authoritative-bot-id",
    requiredEvidence: "deduplicated-authoritative-bot-identities",
    crossEntityAggregation: "count-unique-bot-identities-per-room"
  };
}

const entries = [];
for (const [type, metrics] of Object.entries(groups)) {
  for (const metric of metrics) {
    entries.push([metric, Object.freeze({
      sourceStatus: "unavailable",
      metricType: type,
      ...semantics(metric, type),
      freshnessProof: "per-entity-source-timestamp-required",
      runScope: "dedicated-run-or-explicit-run-label-required",
      producerArtifactSha256: null,
      ruleArtifactSha256: null,
      scrapeArtifactSha256: null
    })]);
  }
}

export const OBSERVABILITY_METRIC_CONTRACTS = Object.freeze(Object.fromEntries(entries));
export const OBSERVABILITY_CONTRACT_SHA256 = createHash("sha256")
  .update(canonicalJson(OBSERVABILITY_METRIC_CONTRACTS))
  .digest("hex");

export function observabilityReadinessSummary() {
  const unavailable = Object.entries(OBSERVABILITY_METRIC_CONTRACTS)
    .filter(([, contract]) => contract.sourceStatus !== "available")
    .map(([metric]) => metric)
    .sort();
  return {
    schemaVersion: 1,
    state: unavailable.length === 0 ? "READY" : "BLOCKED",
    physicalExecutionAllowed: false,
    certified: false,
    contractSha256: OBSERVABILITY_CONTRACT_SHA256,
    unavailableMetrics: unavailable
  };
}

export function assertObservabilityReady() {
  const summary = observabilityReadinessSummary();
  if (summary.state !== "READY") {
    throw invalid(
      "Physical collection requires tracked producers, rules and scrape evidence for every metric",
      "OBSERVABILITY_UNAVAILABLE",
      { unavailableMetrics: summary.unavailableMetrics }
    );
  }
  return summary;
}

export function advancePrometheusSeriesProgress(progress, { metric, roomId, series }) {
  if (!(progress instanceof Map) || typeof metric !== "string" || metric.length === 0 ||
      typeof roomId !== "string" || roomId.length === 0 || !Array.isArray(series) || series.length === 0) {
    throw invalid("Prometheus series progression input is invalid", "PROMETHEUS_SAMPLE_INVALID");
  }
  const metricType = OBSERVABILITY_METRIC_CONTRACTS[metric]?.metricType;
  if (typeof metricType !== "string") {
    throw invalid("Prometheus series progression metric is unknown", "PROMETHEUS_SAMPLE_INVALID");
  }
  const counterLike = metricType === "counter" || metricType === "throughput";
  const counterRatio = metricType === "ratio";
  const counterHistogram = metricType === "histogram";
  const updates = [];
  const requestKeys = new Set();
  for (const item of series) {
    if (!item?.labels || typeof item.labels !== "object" || Array.isArray(item.labels) ||
        Object.keys(item.labels).length === 0) {
      throw invalid("Prometheus series progression identity is invalid", "PROMETHEUS_SAMPLE_INVALID");
    }
    const observedAtMs = canonicalTime(item.currentObservedAt);
    const labelIdentity = canonicalJson(item.labels);
    const key = `${metric}/${roomId}/${labelIdentity}`;
    if (observedAtMs === null || requestKeys.has(key)) {
      throw invalid("Prometheus series progression timestamp or identity is invalid", "PROMETHEUS_SAMPLE_INVALID");
    }
    const previousState = progress.get(key);
    if (previousState) {
      if (observedAtMs <= previousState.currentObservedAtMs) {
        throw invalid("Prometheus source timestamp did not advance for every entity", "PROMETHEUS_SAMPLE_REUSED", {
          metric,
          roomId,
          labels: item.labels
        });
      }
      if (counterLike &&
          (canonicalTime(item.previousObservedAt) !== previousState.currentObservedAtMs ||
            item.previous !== previousState.current)) {
        throw invalid(
          "Prometheus counter baseline does not continue the preceding entity sample",
          "PROMETHEUS_COUNTER_CONTINUITY_INVALID",
          { metric, roomId, labels: item.labels }
        );
      }
      if (counterRatio &&
          (canonicalTime(item.previousObservedAt) !== previousState.currentObservedAtMs ||
            item.previousNumerator !== previousState.currentNumerator ||
            item.previousDenominator !== previousState.currentDenominator)) {
        throw invalid(
          "Prometheus ratio counter baseline does not continue the preceding entity sample",
          "PROMETHEUS_COUNTER_CONTINUITY_INVALID",
          { metric, roomId, labels: item.labels }
        );
      }
      if (counterHistogram &&
          (canonicalTime(item.previousObservedAt) !== previousState.currentObservedAtMs ||
            canonicalJson(item.buckets.map(bucket => ({ le: bucket.le, count: bucket.previous }))) !==
              canonicalJson(previousState.currentBuckets))) {
        throw invalid(
          "Prometheus histogram bucket baseline does not continue the preceding entity sample",
          "PROMETHEUS_COUNTER_CONTINUITY_INVALID",
          { metric, roomId, labels: item.labels }
        );
      }
    }
    requestKeys.add(key);
    updates.push([key, {
      currentObservedAtMs: observedAtMs,
      ...(counterLike ? { current: item.current } : {}),
      ...(counterRatio ? {
        currentNumerator: item.currentNumerator,
        currentDenominator: item.currentDenominator
      } : {}),
      ...(counterHistogram ? {
        currentBuckets: item.buckets.map(bucket => ({ le: bucket.le, count: bucket.current }))
      } : {})
    }]);
  }
  for (const [key, state] of updates) progress.set(key, state);
  return progress;
}

export function validateAuthoritativeBotIdentityState({ samples, rooms }) {
  if (!Array.isArray(samples) || !Array.isArray(rooms) || rooms.length === 0) {
    throw invalid("Authoritative bot identity input is invalid", "BOT_IDENTITY_STATE_INVALID");
  }
  const plannedRooms = new Map(rooms.map(room => [room.id, room.bots]));
  if (plannedRooms.size !== rooms.length || [...plannedRooms].some(([roomId, bots]) =>
    typeof roomId !== "string" || ![0, 5, 10].includes(bots)
  )) throw invalid("Authoritative bot room plan is invalid", "BOT_IDENTITY_STATE_INVALID");
  const metricSet = new Set(AUTHORITATIVE_BOT_STATE_METRICS);
  const fullNamespace = Array.from({ length: 10 }, (_, index) => `bot-${String(index + 1).padStart(3, "0")}`);
  const groupsByRoomAndTime = new Map();
  for (const sample of samples.filter(item => metricSet.has(item?.metric))) {
    const desired = plannedRooms.get(sample.roomId);
    if (desired === undefined || typeof sample.observedAt !== "string" || !Array.isArray(sample.series)) {
      throw invalid("Authoritative bot sample scope is invalid", "BOT_IDENTITY_STATE_INVALID");
    }
    const identities = sample.series.map(item => item?.labels?.bot_id).sort();
    const activeIdentities = sample.series
      .filter(item => item?.value === 1)
      .map(item => item.labels.bot_id)
      .sort();
    if (canonicalJson(identities) !== canonicalJson(fullNamespace) ||
        sample.series.some(item => ![0, 1].includes(item?.value)) ||
        canonicalJson(activeIdentities) !== canonicalJson(fullNamespace.slice(0, desired))) {
      throw invalid("Authoritative bot identity namespace or state is invalid", "BOT_IDENTITY_STATE_INVALID", {
        metric: sample.metric,
        roomId: sample.roomId
      });
    }
    const key = `${sample.roomId}/${sample.observedAt}`;
    if (!groupsByRoomAndTime.has(key)) groupsByRoomAndTime.set(key, new Set());
    if (groupsByRoomAndTime.get(key).has(sample.metric)) {
      throw invalid("Authoritative bot identity state is duplicated", "BOT_IDENTITY_STATE_INVALID");
    }
    groupsByRoomAndTime.get(key).add(sample.metric);
  }
  if (groupsByRoomAndTime.size === 0 || [...groupsByRoomAndTime.values()].some(metrics =>
    canonicalJson([...metrics].sort()) !== canonicalJson([...metricSet].sort())
  ) || [...plannedRooms.keys()].some(roomId => ![...groupsByRoomAndTime.keys()].some(key => key.startsWith(`${roomId}/`)))) {
    throw invalid("Authoritative bot identity state is incomplete", "BOT_IDENTITY_STATE_INVALID");
  }
  return true;
}

export function weightedRatio(series) {
  if (!Array.isArray(series) || series.length === 0 || series.some(item =>
    !item || !Number.isFinite(item.numerator) || !Number.isFinite(item.denominator) ||
    item.numerator < 0 || item.denominator < 0 || item.numerator > item.denominator
  )) throw invalid("Ratio evidence must contain bounded numerator/denominator pairs", "METRIC_SEMANTICS_INVALID");
  const numerator = series.reduce((sum, item) => sum + item.numerator, 0);
  const denominator = series.reduce((sum, item) => sum + item.denominator, 0);
  if (denominator <= 0) throw invalid("Ratio evidence denominator must be positive", "METRIC_SEMANTICS_INVALID");
  return numerator / denominator;
}

function bucketKey(value) {
  if (value === "+Inf") return "+Inf";
  if (!Number.isFinite(value)) throw invalid("Histogram upper bounds must be finite or +Inf", "METRIC_SEMANTICS_INVALID");
  return String(value);
}

export function aggregateHistogramQuantile(series, quantile = 0.95) {
  if (!Array.isArray(series) || series.length === 0 || !Number.isFinite(quantile) || quantile <= 0 || quantile >= 1) {
    throw invalid("Histogram evidence or quantile is invalid", "METRIC_SEMANTICS_INVALID");
  }
  const totals = new Map();
  let expectedBounds = null;
  for (const item of series) {
    if (!item || !Array.isArray(item.buckets) || item.buckets.length < 2) {
      throw invalid("Histogram evidence requires cumulative buckets", "METRIC_SEMANTICS_INVALID");
    }
    let previous = -1;
    let previousBound = -Infinity;
    const bounds = [];
    for (const bucket of item.buckets) {
      const key = bucketKey(bucket.le);
      const currentBound = key === "+Inf" ? Infinity : Number(key);
      if (!Number.isFinite(bucket.count) || bucket.count < 0 || bucket.count < previous ||
          currentBound <= previousBound) {
        throw invalid("Histogram buckets must be finite and cumulative", "METRIC_SEMANTICS_INVALID");
      }
      previous = bucket.count;
      previousBound = currentBound;
      bounds.push(key);
      totals.set(key, (totals.get(key) ?? 0) + bucket.count);
    }
    if (bounds.at(-1) !== "+Inf" || (expectedBounds && canonicalJson(bounds) !== canonicalJson(expectedBounds))) {
      throw invalid("Histogram series must share one ordered +Inf-terminated bucket layout", "METRIC_SEMANTICS_INVALID");
    }
    expectedBounds ??= bounds;
  }
  const total = totals.get("+Inf");
  if (!Number.isFinite(total) || total <= 0) throw invalid("Histogram total must be positive", "METRIC_SEMANTICS_INVALID");
  const rank = total * quantile;
  let lowerBound = 0;
  let lowerCount = 0;
  for (const key of expectedBounds) {
    const count = totals.get(key);
    if (count >= rank) {
      if (key === "+Inf") return lowerBound;
      const upperBound = Number(key);
      const bucketCount = count - lowerCount;
      if (bucketCount <= 0) return upperBound;
      return lowerBound + (upperBound - lowerBound) * ((rank - lowerCount) / bucketCount);
    }
    lowerBound = Number(key);
    lowerCount = count;
  }
  throw invalid("Histogram quantile could not be derived", "METRIC_SEMANTICS_INVALID");
}

export function deriveCounterIntervalDelta({
  previous,
  current,
  resets,
  runStartedAt,
  runEndedAt,
  windowStartedAt,
  windowEndedAt
}) {
  const canonicalTime = value => {
    const milliseconds = typeof value === "string" ? Date.parse(value) : NaN;
    return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value ? milliseconds : NaN;
  };
  const runStartMs = canonicalTime(runStartedAt);
  const runEndMs = canonicalTime(runEndedAt);
  const windowStartMs = canonicalTime(windowStartedAt);
  const windowEndMs = canonicalTime(windowEndedAt);
  if (![runStartMs, runEndMs, windowStartMs, windowEndMs].every(Number.isFinite) ||
      runStartMs >= runEndMs || windowStartMs < runStartMs || windowStartMs >= windowEndMs || windowEndMs > runEndMs ||
      !Array.isArray(previous) || !Array.isArray(current) || !Array.isArray(resets)) {
    throw invalid("Counter interval must be scoped inside the signed run", "COUNTER_SCOPE_INVALID");
  }
  const index = values => {
    const result = new Map();
    for (const item of values) {
      if (!item || typeof item.entity !== "string" || item.entity.length === 0 ||
          !Number.isFinite(item.value) || item.value < 0 || result.has(item.entity)) {
        throw invalid("Counter series identity or value is invalid", "COUNTER_SERIES_INVALID");
      }
      result.set(item.entity, item.value);
    }
    return result;
  };
  const before = index(previous);
  const after = index(current);
  const resetIndex = index(resets);
  const entities = [...before.keys()].sort();
  if (canonicalJson(entities) !== canonicalJson([...after.keys()].sort()) ||
      canonicalJson(entities) !== canonicalJson([...resetIndex.keys()].sort())) {
    throw invalid("Counter pod/instance churn requires a new signed inventory and cannot be hidden", "COUNTER_SERIES_CHURN");
  }
  let total = 0;
  for (const entity of entities) {
    const start = before.get(entity);
    const end = after.get(entity);
    const resetCount = resetIndex.get(entity);
    if (!Number.isInteger(resetCount)) throw invalid("Counter reset proof must be an integer", "COUNTER_RESET_INVALID");
    if (resetCount > 0) {
      throw invalid(
        "Counter resets invalidate the interval until an externally reviewed continuity source exists",
        "COUNTER_RESET_INVALID"
      );
    }
    if (end < start && resetCount < 1) {
      throw invalid("A counter decrease requires an explicit reset proof", "COUNTER_RESET_INVALID");
    }
    total += end - start;
  }
  return { value: total, resetObserved: false, certified: false };
}

export function derivePrometheusSemanticValue({
  metricType,
  series,
  runStartedAt,
  runEndedAt,
  windowStartedAt,
  windowEndedAt,
  allowEmptyHistogram = false
}) {
  const supported = new Set([
    "counter", "histogram", "ratio", "utilization", "throughput", "duration",
    "nodeCapacity", "clusterUsage", "authoritativeState"
  ]);
  const runStartMs = canonicalTime(runStartedAt);
  const runEndMs = canonicalTime(runEndedAt);
  const windowStartMs = canonicalTime(windowStartedAt);
  const windowEndMs = canonicalTime(windowEndedAt);
  if (!supported.has(metricType) || !Array.isArray(series) || series.length === 0 ||
      [runStartMs, runEndMs, windowStartMs, windowEndMs].some(value => value === null) ||
      runStartMs >= runEndMs || windowStartMs < runStartMs || windowStartMs > windowEndMs ||
      windowEndMs > runEndMs) {
    throw invalid("Prometheus semantic proof is outside the signed run", "METRIC_SEMANTICS_INVALID");
  }
  const identities = new Set();
  let earliestCurrentMs = Infinity;
  const checked = series.map(item => {
    if (!item?.labels || typeof item.labels !== "object" || Array.isArray(item.labels) ||
        Object.keys(item.labels).length === 0 || Object.values(item.labels).some(value =>
          typeof value !== "string" || value.length === 0 || value.length > 256
        )) {
      throw invalid("Prometheus semantic series identity is invalid", "METRIC_SEMANTICS_INVALID");
    }
    const identity = canonicalJson(item.labels);
    if (identities.has(identity)) {
      throw invalid("Prometheus semantic series identity is duplicated", "METRIC_SEMANTICS_INVALID");
    }
    identities.add(identity);
    const currentObservedAtMs = canonicalTime(item.currentObservedAt);
    if (currentObservedAtMs === null || currentObservedAtMs < Math.max(windowStartMs, runStartMs) ||
        currentObservedAtMs > windowEndMs) {
      throw invalid("Prometheus semantic source timestamp is outside its interval", "METRIC_SEMANTICS_INVALID");
    }
    earliestCurrentMs = Math.min(earliestCurrentMs, currentObservedAtMs);
    return { item, identity, currentObservedAtMs };
  });

  let value;
  let resetObserved = false;
  if (["counter", "throughput"].includes(metricType)) {
    const previous = [];
    const current = [];
    const resets = [];
    const throughputRates = [];
    for (const { item, identity, currentObservedAtMs } of checked) {
      if (!exactKeys(item, [
        "labels", "previousObservedAt", "currentObservedAt", "previous", "current", "resets"
      ])) throw invalid("Counter semantic series schema is closed", "METRIC_SEMANTICS_INVALID");
      const previousObservedAtMs = canonicalTime(item.previousObservedAt);
      const zeroWidthBaseline = windowStartMs === windowEndMs;
      if (previousObservedAtMs === null || previousObservedAtMs < windowStartMs ||
          previousObservedAtMs < runStartMs ||
          (zeroWidthBaseline ? currentObservedAtMs !== previousObservedAtMs : currentObservedAtMs <= previousObservedAtMs) ||
          !Number.isFinite(item.previous) || item.previous < 0 ||
          !Number.isFinite(item.current) || item.current < 0 ||
          !Number.isInteger(item.resets) || item.resets < 0 ||
          (zeroWidthBaseline && (item.previous !== item.current || item.resets !== 0))) {
        throw invalid("Counter semantic interval is invalid", "METRIC_SEMANTICS_INVALID");
      }
      previous.push({ entity: identity, value: item.previous });
      current.push({ entity: identity, value: item.current });
      resets.push({ entity: identity, value: item.resets });
      if (!zeroWidthBaseline) {
        throughputRates.push((item.current - item.previous) / ((currentObservedAtMs - previousObservedAtMs) / 1000));
      }
    }
    const delta = windowStartMs === windowEndMs
      ? { value: 0, resetObserved: false, certified: false }
      : deriveCounterIntervalDelta({
          previous,
          current,
          resets,
          runStartedAt,
          runEndedAt,
          windowStartedAt,
          windowEndedAt
        });
    resetObserved = delta.resetObserved;
    value = metricType === "throughput"
      ? windowStartMs === windowEndMs ? 0 : throughputRates.reduce((sum, rate) => sum + rate, 0)
      : delta.value;
  } else if (metricType === "histogram") {
    const zeroWidthBaseline = windowStartMs === windowEndMs;
    const intervalBuckets = checked.map(({ item, currentObservedAtMs }) => {
      const previousObservedAtMs = canonicalTime(item?.previousObservedAt);
      if (!exactKeys(item, ["labels", "previousObservedAt", "currentObservedAt", "buckets"]) ||
          previousObservedAtMs === null || previousObservedAtMs < windowStartMs ||
          previousObservedAtMs < runStartMs ||
          (zeroWidthBaseline
            ? currentObservedAtMs !== previousObservedAtMs
            : currentObservedAtMs <= previousObservedAtMs) ||
          !Array.isArray(item.buckets) || item.buckets.length < 2) {
        throw invalid("Histogram semantic series schema is closed", "METRIC_SEMANTICS_INVALID");
      }
      let previousCumulative = -1;
      let currentCumulative = -1;
      let previousBound = -Infinity;
      const bounds = [];
      const buckets = item.buckets.map(bucket => {
        const key = bucketKey(bucket?.le);
        const currentBound = key === "+Inf" ? Infinity : Number(key);
        if (currentBound <= previousBound) {
          throw invalid("Histogram bucket bounds must be strictly ordered", "METRIC_SEMANTICS_INVALID");
        }
        previousBound = currentBound;
        bounds.push(key);
        if (!exactKeys(bucket, ["le", "previous", "current", "resets"]) ||
            !Number.isFinite(bucket.previous) || bucket.previous < 0 ||
            !Number.isFinite(bucket.current) || bucket.current < 0 ||
            !Number.isInteger(bucket.resets) || bucket.resets < 0 ||
            bucket.resets > 0 || bucket.current < bucket.previous ||
            (zeroWidthBaseline && bucket.current !== bucket.previous)) {
          throw invalid("Histogram bucket interval or reset proof is invalid", "COUNTER_RESET_INVALID");
        }
        if (bucket.previous < previousCumulative || bucket.current < currentCumulative) {
          throw invalid("Histogram previous and current buckets must each be cumulative", "METRIC_SEMANTICS_INVALID");
        }
        previousCumulative = bucket.previous;
        currentCumulative = bucket.current;
        return { le: bucket.le, count: bucket.current - bucket.previous };
      });
      if (bounds.at(-1) !== "+Inf") {
        throw invalid("Histogram bucket layout must terminate in +Inf", "METRIC_SEMANTICS_INVALID");
      }
      return {
        buckets
      };
    });
    const emptyInterval = intervalBuckets.every(item =>
      item.buckets.every(bucket => bucket.count === 0)
    );
    value = zeroWidthBaseline || (allowEmptyHistogram === true && emptyInterval)
      ? 0
      : aggregateHistogramQuantile(intervalBuckets);
  } else if (metricType === "ratio") {
    const zeroWidthBaseline = windowStartMs === windowEndMs;
    const previousNumerators = [];
    const currentNumerators = [];
    const numeratorResets = [];
    const previousDenominators = [];
    const currentDenominators = [];
    const denominatorResets = [];
    const intervalRatios = [];
    for (const { item, identity, currentObservedAtMs } of checked) {
      if (!exactKeys(item, [
        "labels", "previousObservedAt", "currentObservedAt",
        "previousNumerator", "currentNumerator", "numeratorResets",
        "previousDenominator", "currentDenominator", "denominatorResets"
      ])) throw invalid("Ratio counter semantic series schema is closed", "METRIC_SEMANTICS_INVALID");
      const previousObservedAtMs = canonicalTime(item.previousObservedAt);
      if (previousObservedAtMs === null || previousObservedAtMs < windowStartMs ||
          previousObservedAtMs < runStartMs ||
          (zeroWidthBaseline ? currentObservedAtMs !== previousObservedAtMs : currentObservedAtMs <= previousObservedAtMs) ||
          !Number.isFinite(item.previousNumerator) || item.previousNumerator < 0 ||
          !Number.isFinite(item.currentNumerator) || item.currentNumerator < 0 ||
          !Number.isInteger(item.numeratorResets) || item.numeratorResets < 0 ||
          !Number.isFinite(item.previousDenominator) || item.previousDenominator < 0 ||
          !Number.isFinite(item.currentDenominator) || item.currentDenominator < 0 ||
          !Number.isInteger(item.denominatorResets) || item.denominatorResets < 0 ||
          (zeroWidthBaseline && (
            item.previousNumerator !== item.currentNumerator || item.numeratorResets !== 0 ||
            item.previousDenominator !== item.currentDenominator || item.denominatorResets !== 0
          ))) {
        throw invalid("Ratio counter semantic interval is invalid", "METRIC_SEMANTICS_INVALID");
      }
      previousNumerators.push({ entity: identity, value: item.previousNumerator });
      currentNumerators.push({ entity: identity, value: item.currentNumerator });
      numeratorResets.push({ entity: identity, value: item.numeratorResets });
      previousDenominators.push({ entity: identity, value: item.previousDenominator });
      currentDenominators.push({ entity: identity, value: item.currentDenominator });
      denominatorResets.push({ entity: identity, value: item.denominatorResets });
      intervalRatios.push({
        numerator: item.currentNumerator - item.previousNumerator,
        denominator: item.currentDenominator - item.previousDenominator
      });
    }
    if (zeroWidthBaseline) {
      value = 0;
    } else {
      const numeratorDelta = deriveCounterIntervalDelta({
        previous: previousNumerators,
        current: currentNumerators,
        resets: numeratorResets,
        runStartedAt,
        runEndedAt,
        windowStartedAt,
        windowEndedAt
      });
      const denominatorDelta = deriveCounterIntervalDelta({
        previous: previousDenominators,
        current: currentDenominators,
        resets: denominatorResets,
        runStartedAt,
        runEndedAt,
        windowStartedAt,
        windowEndedAt
      });
      resetObserved = numeratorDelta.resetObserved || denominatorDelta.resetObserved;
      value = weightedRatio(intervalRatios);
    }
  } else if (metricType === "utilization") {
    const ratios = checked.map(({ item }) => {
      if (!exactKeys(item, ["labels", "currentObservedAt", "numerator", "denominator"]) ||
          !Number.isFinite(item.numerator) || item.numerator < 0 ||
          !Number.isFinite(item.denominator) || item.denominator <= 0 || item.numerator > item.denominator) {
        throw invalid("Ratio semantic series schema is closed", "METRIC_SEMANTICS_INVALID");
      }
      return { numerator: item.numerator, denominator: item.denominator };
    });
    value = Math.max(...ratios.map(item => item.numerator / item.denominator));
  } else {
    const botIdentities = new Set();
    const values = checked.map(({ item }) => {
      if (!exactKeys(item, ["labels", "currentObservedAt", "value"]) ||
          !Number.isFinite(item.value) || item.value < 0) {
        throw invalid("Gauge semantic series schema is closed", "METRIC_SEMANTICS_INVALID");
      }
      if (metricType === "authoritativeState") {
        const botId = item.labels.bot_id;
        if (typeof botId !== "string" || !/^bot-(?:00[1-9]|010)$/.test(botId) ||
            botIdentities.has(botId) || ![0, 1].includes(item.value)) {
          throw invalid("Authoritative bot states require unique binary bot identities", "METRIC_SEMANTICS_INVALID");
        }
        botIdentities.add(botId);
      }
      return item.value;
    });
    if (metricType === "nodeCapacity") {
      if (new Set(values).size !== 1) {
        throw invalid("Every node must expose one identical capacity", "METRIC_SEMANTICS_INVALID");
      }
      [value] = values;
    } else if (["clusterUsage", "authoritativeState"].includes(metricType)) {
      value = values.reduce((sum, item) => sum + item, 0);
    } else {
      value = Math.max(...values);
    }
  }
  if (!Number.isFinite(value) || value < 0) {
    throw invalid("Derived Prometheus semantic value is invalid", "METRIC_SEMANTICS_INVALID");
  }
  return {
    value,
    sourceObservedAt: new Date(earliestCurrentMs).toISOString(),
    resetObserved,
    certified: false
  };
}

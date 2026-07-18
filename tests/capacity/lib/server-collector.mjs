import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { invalid } from "./errors.mjs";
import { BOT_STATE_METRICS, METRIC_CONTRACTS, MODEL_OBSERVATION_METRICS } from "./metric-contracts.mjs";
import { canonicalJson } from "./io.mjs";
import { validateTarget } from "./security.mjs";
import {
  TRACKED_COLLECTOR_METRICS,
  TRACKED_MAPPING_REVIEW,
  trackedCollectorMappingIdentity
} from "./collector-contract.mjs";
import {
  OBSERVABILITY_METRIC_CONTRACTS,
  advancePrometheusSeriesProgress,
  assertObservabilityReady,
  derivePrometheusSemanticValue,
  validateAuthoritativeBotIdentityState
} from "./observability-contract.mjs";

const SERVER_COLLECTORS = new Set([
  "reticulum", "load-balancer", "kubernetes", "database", "coturn", "dialog", "bots"
]);
const FORBIDDEN_PROMQL = /\b(?:vector|scalar|label_replace)\s*\(/i;
const SYNTHETIC_ARITHMETIC = /(?:^|[^0-9.])(?:\*|\/|\+|-)\s*0(?:\.0+)?(?:\b|$)|(?:^|[^0-9.])0(?:\.0+)?\s*(?:\*|\/)/;
const SYNTHETIC_SOURCE = /(?:^|_)(?:test|fake|fixture|synthetic|constant)(?:_|$)/i;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_PROMETHEUS_BYTES = 1024 * 1024;
const TRACKED_SCENARIOS = new Map(JSON.parse(
  readFileSync(new URL("../scenarios.yaml", import.meta.url), "utf8")
).scenarios.map(scenario => [scenario.id, scenario]));

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function canonicalIso(value) {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value ? milliseconds : null;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function expectedMetricContracts(thresholds) {
  const result = {};
  for (const [name, contract] of Object.entries(METRIC_CONTRACTS)) {
    if (SERVER_COLLECTORS.has(contract.collector)) result[name] = contract;
  }
  Object.assign(result, MODEL_OBSERVATION_METRICS, BOT_STATE_METRICS);
  if (Object.keys(result).some(name => !thresholds.metrics[name] && !name.startsWith("model.") && !name.startsWith("bots.state."))) {
    throw invalid("Collector metric contracts drifted from thresholds", "COLLECTOR_CONFIG_INVALID");
  }
  return result;
}

function validateReviewedMapping(mapping) {
  if (!exactKeys(mapping, ["id", "version", "reviewedAt", "reviewerId"]) ||
      !/^[a-z0-9][a-z0-9-]{2,63}$/.test(mapping.id) || !/^v[1-9][0-9]{0,5}$/.test(mapping.version) ||
      canonicalIso(mapping.reviewedAt) === null || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(mapping.reviewerId)) {
    throw invalid("Collector mapping must have a versioned review identity", "COLLECTOR_CONFIG_INVALID");
  }
}

export function validateCollectorConfig(config, thresholds) {
  if (!exactKeys(config, [
    "schemaVersion", "mapping", "listenHost", "listenPort", "prometheusUrl", "maxSampleAgeSeconds",
    "seriesInventory", "metrics"
  ]) || config.schemaVersion !== 3 || config.listenHost !== "127.0.0.1" ||
      !Number.isInteger(config.listenPort) || config.listenPort < 1024 || config.listenPort > 65535 ||
      !Number.isInteger(config.maxSampleAgeSeconds) || config.maxSampleAgeSeconds < 1 || config.maxSampleAgeSeconds > 60) {
    throw invalid("Collector configuration schema is closed and loopback-only", "COLLECTOR_CONFIG_INVALID");
  }
  validateReviewedMapping(config.mapping);
  if (canonicalJson(config.mapping) !== canonicalJson(TRACKED_MAPPING_REVIEW)) {
    throw invalid("Collector mapping review identity differs from the tracked contract", "COLLECTOR_CONFIG_INVALID");
  }
  const prometheus = validateTarget(config.prometheusUrl);
  const prometheusUrl = new URL(prometheus.canonical);
  if (prometheus.classification !== "local" || prometheusUrl.pathname !== "/") {
    throw invalid("Prometheus endpoint must be one loopback origin", "COLLECTOR_CONFIG_INVALID");
  }
  const contracts = expectedMetricContracts(thresholds);
  const names = Object.keys(config.metrics ?? {}).sort();
  const expectedNames = Object.keys(contracts).sort();
  if (names.length !== expectedNames.length || names.some((name, index) => name !== expectedNames[index])) {
    throw invalid("Prometheus mapping must cover every server metric exactly", "COLLECTOR_CONFIG_INVALID");
  }
  if (!exactKeys(config.seriesInventory, expectedNames)) {
    throw invalid("Prometheus inventory must cover every server metric exactly", "COLLECTOR_CONFIG_INVALID");
  }
  const safeMetrics = {};
  for (const [name, mapping] of Object.entries(config.metrics)) {
    const contract = contracts[name];
    if (!exactKeys(mapping, ["collector", "sourceMetric", "query", "service", "requiredLabels"]) ||
        mapping.collector !== contract.collector ||
        typeof mapping.sourceMetric !== "string" || !/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(mapping.sourceMetric) ||
        SYNTHETIC_SOURCE.test(mapping.sourceMetric) || typeof mapping.query !== "string" ||
        mapping.query.length < mapping.sourceMetric.length || mapping.query.length > 4096 ||
        !mapping.query.includes(mapping.sourceMetric) || FORBIDDEN_PROMQL.test(mapping.query) || SYNTHETIC_ARITHMETIC.test(mapping.query) ||
        /^\s*[+-]?(?:\d+\.?\d*|\.\d+)\s*$/.test(mapping.query) ||
        typeof mapping.service !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(mapping.service) ||
        !Array.isArray(mapping.requiredLabels) || mapping.requiredLabels.length === 0 || mapping.requiredLabels.length > 8 ||
        mapping.requiredLabels.some(label => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(label)) ||
        new Set(mapping.requiredLabels).size !== mapping.requiredLabels.length ||
        canonicalJson(mapping.requiredLabels) !== canonicalJson([...mapping.requiredLabels].sort())) {
      throw invalid("Prometheus metric mapping lacks a real source/query/label contract", "COLLECTOR_CONFIG_INVALID", { metric: name });
    }
    if (canonicalJson(mapping) !== canonicalJson(TRACKED_COLLECTOR_METRICS[name])) {
      throw invalid("Prometheus mapping differs from the tracked reviewed query contract", "COLLECTOR_CONFIG_INVALID", { metric: name });
    }
    const roomScoped = mapping.collector === "bots";
    if (roomScoped !== mapping.query.includes("{room}")) {
      throw invalid("Bot queries must be room-scoped and other queries must omit {room}", "COLLECTOR_CONFIG_INVALID", { metric: name });
    }
    safeMetrics[name] = {
      ...mapping,
      querySha256: sha256(mapping.query)
    };
    const inventory = config.seriesInventory[name];
    if (!Array.isArray(inventory) || inventory.length === 0 || inventory.length > 128 ||
        inventory.some(labels => !exactKeys(labels, mapping.requiredLabels) ||
          Object.values(labels).some(value => typeof value !== "string" || value.length === 0 || value.length > 256)) ||
        new Set(inventory.map(labels => canonicalJson(labels))).size !== inventory.length ||
        canonicalJson(inventory) !== canonicalJson([...inventory].sort((left, right) =>
          canonicalJson(left).localeCompare(canonicalJson(right))
        ))) {
      throw invalid("Prometheus inventory is malformed, duplicated or non-canonical", "COLLECTOR_CONFIG_INVALID", {
        metric: name
      });
    }
    if (Object.hasOwn(BOT_STATE_METRICS, name) &&
        (inventory.length !== 10 || new Set(inventory.map(labels => labels.bot_id)).size !== inventory.length ||
          inventory.some(labels => !/^bot-(?:00[1-9]|010)$/.test(labels.bot_id)))) {
      throw invalid("Authoritative bot inventory must bind ten unique stable bot identities", "COLLECTOR_CONFIG_INVALID", {
        metric: name
      });
    }
  }
  const botInventories = Object.keys(BOT_STATE_METRICS).map(name => canonicalJson(config.seriesInventory[name]));
  if (new Set(botInventories).size !== 1) {
    throw invalid("Every authoritative bot state must use one identical bot identity namespace", "COLLECTOR_CONFIG_INVALID");
  }
  return {
    ...config,
    prometheusUrl: prometheus.canonical,
    seriesInventory: structuredClone(config.seriesInventory),
    metrics: safeMetrics,
    mappingIdentity: trackedCollectorMappingIdentity({
      listenPort: config.listenPort,
      prometheusUrl: prometheus.canonical,
      maxSampleAgeSeconds: config.maxSampleAgeSeconds,
      seriesInventory: config.seriesInventory
    })
  };
}

function sanitizeLabels(labels, requiredLabels, {
  sourceMetric,
  fixedLabels = {},
  requireMetricName = false
} = {}) {
  const labelNames = labels && typeof labels === "object" && !Array.isArray(labels)
    ? Object.keys(labels).sort()
    : [];
  const hasMetricName = labelNames.includes("__name__");
  const expectedLabelNames = [
    ...requiredLabels,
    ...Object.keys(fixedLabels),
    ...(hasMetricName ? ["__name__"] : [])
  ].sort();
  if (!labels || typeof labels !== "object" || Array.isArray(labels) ||
      canonicalJson(labelNames) !== canonicalJson(expectedLabelNames) ||
      (requireMetricName && !hasMetricName) ||
      (hasMetricName && labels.__name__ !== sourceMetric) ||
      Object.entries(fixedLabels).some(([key, value]) => labels[key] !== value)) {
    throw invalid("Prometheus sample labels do not prove the configured source", "PROMETHEUS_SAMPLE_INVALID");
  }
  const result = {};
  for (const key of requiredLabels) {
    const value = labels[key];
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) || typeof value !== "string" || value.length === 0 || value.length > 256) {
      throw invalid("Prometheus sample labels are malformed", "PROMETHEUS_SAMPLE_INVALID");
    }
    result[key] = value;
  }
  return result;
}

function safeInstance(labels, fallback) {
  const raw = labels.pod ?? labels.instance ?? fallback;
  const normalized = String(raw).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return normalized || fallback;
}

export function parsePrometheusSample(body, { observedAt, maxSampleAgeSeconds, service, requiredLabels }) {
  if (!exactKeys(body, ["status", "data"]) || body.status !== "success" ||
      !exactKeys(body.data, ["resultType", "result"]) || body.data.resultType !== "vector" ||
      !Array.isArray(body.data.result) || body.data.result.length !== 1) {
    throw invalid("Prometheus query must return exactly one vector result", "PROMETHEUS_SAMPLE_INVALID");
  }
  const item = body.data.result[0];
  if (!exactKeys(item, ["metric", "value"]) || !Array.isArray(item.value) || item.value.length !== 2) {
    throw invalid("Prometheus vector sample schema is invalid", "PROMETHEUS_SAMPLE_INVALID");
  }
  const sourceObservedAtMs = Number(item.value[0]) * 1000;
  const requestedAtMs = Date.parse(observedAt);
  const value = Number(item.value[1]);
  if (!Number.isFinite(sourceObservedAtMs) || sourceObservedAtMs > requestedAtMs ||
      requestedAtMs - sourceObservedAtMs > maxSampleAgeSeconds * 1000 || !Number.isFinite(value) || value < 0) {
    throw invalid("Prometheus sample is stale, future-dated or outside the non-negative domain", "PROMETHEUS_SAMPLE_INVALID");
  }
  const labels = sanitizeLabels(item.metric, requiredLabels);
  return {
    value,
    labels,
    instance: safeInstance(labels, service),
    sourceObservedAt: new Date(sourceObservedAtMs).toISOString()
  };
}

function vectorItems(body, label) {
  if (!exactKeys(body, ["status", "data"]) || body.status !== "success" ||
      !exactKeys(body.data, ["resultType", "result"]) || body.data.resultType !== "vector" ||
      !Array.isArray(body.data.result) || body.data.result.length === 0) {
    throw invalid(`${label} must return a non-empty Prometheus vector`, "PROMETHEUS_SAMPLE_INVALID");
  }
  return body.data.result;
}

function labelIdentity(labels) {
  return canonicalJson(labels);
}

// A production-capable collector must pair every value query with a separate
// timestamp(source) proof. The timestamp attached to an instant PromQL result
// is the evaluation time and is therefore deliberately ignored here.
export function parsePrometheusVectorSet(valueBody, freshnessBody, {
  observedAt,
  maxSampleAgeSeconds,
  service,
  requiredLabels,
  expectedSeries,
  sourceMetric,
  fixedLabels = {},
  requireValueMetricName = true
}) {
  const requestedAtMs = canonicalIso(observedAt);
  if (requestedAtMs === null || !Number.isInteger(maxSampleAgeSeconds) || maxSampleAgeSeconds < 1 ||
      typeof service !== "string" || service.length === 0) {
    throw invalid("Prometheus collection timestamp or service scope is invalid", "PROMETHEUS_SAMPLE_INVALID");
  }
  if (!Array.isArray(expectedSeries) || expectedSeries.length === 0) {
    throw invalid("Prometheus collection requires an exact signed series inventory", "PROMETHEUS_INVENTORY_REQUIRED");
  }
  const expected = new Map();
  for (const labels of expectedSeries) {
    const checked = sanitizeLabels(labels, requiredLabels);
    const key = labelIdentity(checked);
    if (expected.has(key)) throw invalid("Prometheus expected inventory contains duplicates", "PROMETHEUS_INVENTORY_INVALID");
    expected.set(key, checked);
  }
  const values = new Map();
  for (const item of vectorItems(valueBody, "Value query")) {
    if (!exactKeys(item, ["metric", "value"]) || !Array.isArray(item.value) || item.value.length !== 2) {
      throw invalid("Prometheus value vector schema is invalid", "PROMETHEUS_SAMPLE_INVALID");
    }
    const labels = sanitizeLabels(item.metric, requiredLabels, {
      sourceMetric,
      fixedLabels,
      requireMetricName: requireValueMetricName
    });
    const key = labelIdentity(labels);
    const value = Number(item.value[1]);
    if (!Number.isFinite(Number(item.value[0])) || !Number.isFinite(value) || value < 0 || values.has(key)) {
      throw invalid("Prometheus values must be unique and non-negative", "PROMETHEUS_SAMPLE_INVALID");
    }
    values.set(key, { value, labels });
  }
  const freshness = new Map();
  for (const item of vectorItems(freshnessBody, "Freshness query")) {
    if (!exactKeys(item, ["metric", "value"]) || !Array.isArray(item.value) || item.value.length !== 2) {
      throw invalid("Prometheus freshness vector schema is invalid", "PROMETHEUS_SAMPLE_INVALID");
    }
    const labels = sanitizeLabels(item.metric, requiredLabels, { sourceMetric, fixedLabels });
    const key = labelIdentity(labels);
    const sourceObservedAtMs = Number(item.value[1]) * 1000;
    if (!Number.isFinite(Number(item.value[0])) || !Number.isFinite(sourceObservedAtMs) || sourceObservedAtMs > requestedAtMs ||
        requestedAtMs - sourceObservedAtMs > maxSampleAgeSeconds * 1000 || freshness.has(key)) {
      throw invalid("Prometheus source timestamp is stale, future-dated or duplicated", "PROMETHEUS_SAMPLE_INVALID");
    }
    freshness.set(key, sourceObservedAtMs);
  }
  const actualKeys = [...values.keys()].sort();
  const freshnessKeys = [...freshness.keys()].sort();
  const expectedKeys = [...expected.keys()].sort();
  if (canonicalJson(actualKeys) !== canonicalJson(expectedKeys) ||
      canonicalJson(freshnessKeys) !== canonicalJson(expectedKeys)) {
    throw invalid("Prometheus vectors do not match the exact signed entity inventory", "PROMETHEUS_CARDINALITY_INVALID");
  }
  return expectedKeys.map(key => ({
    value: values.get(key).value,
    labels: values.get(key).labels,
    instance: safeInstance(values.get(key).labels, service),
    sourceObservedAt: new Date(freshness.get(key)).toISOString()
  }));
}

export function parsePrometheusHistogramSet(valueBody, freshnessBody, {
  observedAt,
  maxSampleAgeSeconds,
  requiredLabels,
  expectedSeries,
  sourceMetric,
  fixedLabels = {},
  requireValueMetricName = true
}) {
  const requestedAtMs = canonicalIso(observedAt);
  if (requestedAtMs === null || !Array.isArray(requiredLabels) || requiredLabels.includes("le") ||
      !Array.isArray(expectedSeries) || expectedSeries.length === 0) {
    throw invalid("Histogram collection requires one exact entity inventory", "PROMETHEUS_INVENTORY_REQUIRED");
  }
  const expected = new Map(expectedSeries.map(labels => {
    const checked = sanitizeLabels(labels, requiredLabels);
    return [labelIdentity(checked), checked];
  }));
  if (expected.size !== expectedSeries.length) {
    throw invalid("Histogram inventory contains duplicate entities", "PROMETHEUS_INVENTORY_INVALID");
  }
  const values = new Map();
  for (const item of vectorItems(valueBody, "Histogram value query")) {
    const labels = sanitizeLabels(item?.metric, [...requiredLabels, "le"].sort(), {
      sourceMetric,
      fixedLabels,
      requireMetricName: requireValueMetricName
    });
    const entityLabels = Object.fromEntries(requiredLabels.map(label => [label, labels[label]]));
    const entityKey = labelIdentity(entityLabels);
    const bucketKeyValue = labels.le;
    const value = Number(item?.value?.[1]);
    if (!expected.has(entityKey) || !Array.isArray(item.value) || item.value.length !== 2 ||
        !Number.isFinite(Number(item.value[0])) || !Number.isFinite(value) || value < 0) {
      throw invalid("Histogram bucket value is invalid", "PROMETHEUS_SAMPLE_INVALID");
    }
    if (!values.has(entityKey)) values.set(entityKey, new Map());
    if (values.get(entityKey).has(bucketKeyValue)) {
      throw invalid("Histogram bucket is duplicated", "PROMETHEUS_SAMPLE_INVALID");
    }
    values.get(entityKey).set(bucketKeyValue, value);
  }
  const freshness = new Map();
  for (const item of vectorItems(freshnessBody, "Histogram freshness query")) {
    const labels = sanitizeLabels(item?.metric, [...requiredLabels, "le"].sort(), {
      sourceMetric,
      fixedLabels
    });
    const entityLabels = Object.fromEntries(requiredLabels.map(label => [label, labels[label]]));
    const entityKey = labelIdentity(entityLabels);
    const bucketKeyValue = labels.le;
    const sourceObservedAtMs = Number(item?.value?.[1]) * 1000;
    const key = `${entityKey}/${bucketKeyValue}`;
    if (!expected.has(entityKey) || !Array.isArray(item.value) || item.value.length !== 2 ||
        !Number.isFinite(Number(item.value[0])) || !Number.isFinite(sourceObservedAtMs) ||
        sourceObservedAtMs > requestedAtMs || requestedAtMs - sourceObservedAtMs > maxSampleAgeSeconds * 1000 ||
        freshness.has(key)) {
      throw invalid("Histogram bucket freshness is invalid", "PROMETHEUS_SAMPLE_INVALID");
    }
    freshness.set(key, sourceObservedAtMs);
  }
  if (values.size !== expected.size) {
    throw invalid("Histogram entities do not match the exact inventory", "PROMETHEUS_CARDINALITY_INVALID");
  }
  return [...expected.entries()].map(([entityKey, labels]) => {
    const buckets = values.get(entityKey);
    if (!buckets || buckets.size < 2 || !buckets.has("+Inf")) {
      throw invalid("Histogram requires a complete +Inf-terminated bucket set", "PROMETHEUS_CARDINALITY_INVALID");
    }
    const sourceTimes = [...buckets.keys()].map(le => freshness.get(`${entityKey}/${le}`));
    if (sourceTimes.some(value => !Number.isFinite(value)) || new Set(sourceTimes).size !== 1 ||
        freshness.size !== [...values.values()].reduce((sum, item) => sum + item.size, 0)) {
      throw invalid("Histogram value/freshness bucket sets differ", "PROMETHEUS_CARDINALITY_INVALID");
    }
    const ordered = [...buckets.entries()]
      .map(([le, count]) => ({ le: le === "+Inf" ? "+Inf" : Number(le), count }))
      .sort((left, right) => {
        if (left.le === "+Inf") return 1;
        if (right.le === "+Inf") return -1;
        return left.le - right.le;
      });
    return {
      labels,
      currentObservedAt: new Date(sourceTimes[0]).toISOString(),
      buckets: ordered
    };
  });
}

async function boundedJsonResponse(response, maximumBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) throw invalid("Prometheus response is oversized", "PROMETHEUS_QUERY_FAILED");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > maximumBytes) throw invalid("Prometheus response is oversized", "PROMETHEUS_QUERY_FAILED");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw invalid("Prometheus response is not strict JSON", "PROMETHEUS_QUERY_FAILED");
  }
}

async function queryPrometheusBody({ config, query, observedAt, signal }) {
  const endpoint = new URL("/api/v1/query", config.prometheusUrl);
  endpoint.searchParams.set("query", query);
  endpoint.searchParams.set("time", String(Date.parse(observedAt) / 1000));
  const response = await fetch(endpoint, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)])
  });
  if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0] !== "application/json") {
    throw invalid("Prometheus query failed closed", "PROMETHEUS_QUERY_FAILED");
  }
  return boundedJsonResponse(response, MAX_PROMETHEUS_BYTES);
}

function semanticSelector(mapping, roomId, suffix = "") {
  return mapping.query
    .replace(mapping.sourceMetric, `${mapping.sourceMetric}${suffix}`)
    .replaceAll("{room}", roomId ?? "");
}

function promqlRangeDuration(milliseconds) {
  if (!Number.isInteger(milliseconds) || milliseconds <= 0) {
    throw invalid("Prometheus counter interval must be positive", "PROMETHEUS_SAMPLE_INVALID");
  }
  return milliseconds % 1000 === 0 ? `${milliseconds / 1000}s` : `${milliseconds}ms`;
}

function resetWindowDuration({ windowStartedAt, observedAt, runStartedAt }) {
  const windowStartedAtMs = canonicalIso(windowStartedAt);
  const observedAtMs = canonicalIso(observedAt);
  const runStartedAtMs = canonicalIso(runStartedAt);
  if ([windowStartedAtMs, observedAtMs, runStartedAtMs].some(value => value === null) ||
      windowStartedAtMs < runStartedAtMs || windowStartedAtMs > observedAtMs) {
    throw invalid("Prometheus reset proof interval is outside the run", "PROMETHEUS_SAMPLE_INVALID");
  }
  return observedAtMs - windowStartedAtMs;
}

function inclusiveResetRange(milliseconds) {
  // PromQL range selectors are left-open and right-closed. Source timestamps
  // are millisecond-canonical, so one extra millisecond includes the exact
  // baseline sample needed for resets() to compare the first transition.
  return promqlRangeDuration(milliseconds + 1);
}

async function queryValueAndFreshness({ config, query, observedAt, signal }) {
  return Promise.all([
    queryPrometheusBody({ config, query, observedAt, signal }),
    queryPrometheusBody({ config, query: `timestamp(${query})`, observedAt, signal })
  ]);
}

export async function queryPrometheusSemanticMetric({
  config,
  metric,
  mapping,
  observedAt,
  runStartedAt,
  runEndedAt,
  roomId,
  intervalSeconds,
  intervalStartedAt,
  allowEmptyHistogram = false,
  signal
}) {
  const contract = OBSERVABILITY_METRIC_CONTRACTS[metric];
  const metricType = contract?.metricType;
  const expectedSeries = config.seriesInventory[metric];
  const selector = semanticSelector(mapping, roomId);
  const fixedLabels = roomId === undefined ? {} : { room: roomId };
  const parseSet = (
    values,
    freshness,
    at = observedAt,
    sourceMetric = mapping.sourceMetric,
    requireValueMetricName = true
  ) => parsePrometheusVectorSet(values, freshness, {
    observedAt: at,
    maxSampleAgeSeconds: config.maxSampleAgeSeconds,
    service: mapping.service,
    requiredLabels: mapping.requiredLabels,
    expectedSeries,
    sourceMetric,
    fixedLabels,
    requireValueMetricName
  });
  let series;
  let windowStartedAt = observedAt;
  const intervalMetric = ["counter", "throughput", "histogram", "ratio"].includes(metricType);
  let candidateStart;
  if (intervalMetric) {
    const observedAtMs = Date.parse(observedAt);
    const runStartedAtMs = Date.parse(runStartedAt);
    const requestedStartMs = intervalStartedAt === undefined
      ? Math.max(runStartedAtMs, observedAtMs - intervalSeconds * 1000)
      : Date.parse(intervalStartedAt);
    const candidateStartMs = requestedStartMs;
    if (![observedAtMs, runStartedAtMs, candidateStartMs].every(Number.isFinite) ||
        candidateStartMs < runStartedAtMs || candidateStartMs > observedAtMs ||
        (intervalStartedAt !== undefined && new Date(candidateStartMs).toISOString() !== intervalStartedAt)) {
      throw invalid("Prometheus interval is outside the run", "PROMETHEUS_SAMPLE_INVALID");
    }
    candidateStart = new Date(candidateStartMs).toISOString();
  }
  if (["counter", "throughput"].includes(metricType)) {
    const [[previousValues, previousFreshness], [currentValues, currentFreshness]] = await Promise.all([
      queryValueAndFreshness({ config, query: selector, observedAt: candidateStart, signal }),
      queryValueAndFreshness({ config, query: selector, observedAt, signal })
    ]);
    const previous = parseSet(previousValues, previousFreshness, candidateStart);
    const current = parseSet(currentValues, currentFreshness);
    const previousByIdentity = new Map(previous.map(item => [labelIdentity(item.labels), item]));
    const currentByIdentity = new Map(current.map(item => [labelIdentity(item.labels), item]));
    windowStartedAt = new Date(Math.min(...previous.map(item => Date.parse(item.sourceObservedAt)))).toISOString();
    const resetElapsedMs = resetWindowDuration({
      windowStartedAt,
      observedAt,
      runStartedAt
    });
    const resetValues = resetElapsedMs === 0 ? null : await queryPrometheusBody({
      config,
      query: `resets(${selector}[${inclusiveResetRange(resetElapsedMs)}])`,
      observedAt,
      signal
    });
    const resets = resetValues === null
      ? current.map(item => ({ ...item, value: 0 }))
      : parseSet(resetValues, currentFreshness, observedAt, mapping.sourceMetric, false);
    const resetByIdentity = new Map(resets.map(item => [labelIdentity(item.labels), item]));
    series = expectedSeries.map(labels => {
      const key = labelIdentity(labels);
      return {
        labels,
        previousObservedAt: previousByIdentity.get(key).sourceObservedAt,
        currentObservedAt: currentByIdentity.get(key).sourceObservedAt,
        previous: previousByIdentity.get(key).value,
        current: currentByIdentity.get(key).value,
        resets: resetByIdentity.get(key).value
      };
    });
  } else if (metricType === "histogram") {
    const query = semanticSelector(mapping, roomId, "_bucket");
    const bucketSourceMetric = `${mapping.sourceMetric}_bucket`;
    const parseHistogram = (values, freshness, at, requireValueMetricName = true) => parsePrometheusHistogramSet(values, freshness, {
      observedAt: at,
      maxSampleAgeSeconds: config.maxSampleAgeSeconds,
      requiredLabels: mapping.requiredLabels,
      expectedSeries,
      sourceMetric: bucketSourceMetric,
      fixedLabels,
      requireValueMetricName
    });
    const [[previousValues, previousFreshness], [currentValues, currentFreshness]] = await Promise.all([
      queryValueAndFreshness({ config, query, observedAt: candidateStart, signal }),
      queryValueAndFreshness({ config, query, observedAt, signal })
    ]);
    const previous = parseHistogram(previousValues, previousFreshness, candidateStart);
    const current = parseHistogram(currentValues, currentFreshness, observedAt);
    windowStartedAt = new Date(Math.min(...previous.map(item => Date.parse(item.currentObservedAt)))).toISOString();
    const resetElapsedMs = resetWindowDuration({
      windowStartedAt,
      observedAt,
      runStartedAt
    });
    const resetValues = resetElapsedMs === 0 ? null : await queryPrometheusBody({
      config,
      query: `resets(${query}[${inclusiveResetRange(resetElapsedMs)}])`,
      observedAt,
      signal
    });
    const resets = resetValues === null
      ? current.map(item => ({
          ...item,
          buckets: item.buckets.map(bucket => ({ ...bucket, count: 0 }))
        }))
      : parseHistogram(resetValues, currentFreshness, observedAt, false);
    const previousByIdentity = new Map(previous.map(item => [labelIdentity(item.labels), item]));
    const currentByIdentity = new Map(current.map(item => [labelIdentity(item.labels), item]));
    const resetByIdentity = new Map(resets.map(item => [labelIdentity(item.labels), item]));
    series = expectedSeries.map(labels => {
      const key = labelIdentity(labels);
      const before = previousByIdentity.get(key);
      const after = currentByIdentity.get(key);
      const reset = resetByIdentity.get(key);
      const beforeBounds = before.buckets.map(bucket => bucket.le);
      if (canonicalJson(beforeBounds) !== canonicalJson(after.buckets.map(bucket => bucket.le)) ||
          canonicalJson(beforeBounds) !== canonicalJson(reset.buckets.map(bucket => bucket.le))) {
        throw invalid("Histogram bucket layout changed inside the interval", "PROMETHEUS_SAMPLE_INVALID");
      }
      return {
        labels,
        previousObservedAt: before.currentObservedAt,
        currentObservedAt: after.currentObservedAt,
        buckets: before.buckets.map((bucket, index) => ({
          le: bucket.le,
          previous: bucket.count,
          current: after.buckets[index].count,
          resets: reset.buckets[index].count
        }))
      };
    });
  } else if (metricType === "ratio") {
    const numeratorQuery = semanticSelector(mapping, roomId, "_numerator");
    const denominatorQuery = semanticSelector(mapping, roomId, "_denominator");
    const [
      [previousNumeratorValues, previousNumeratorFreshness],
      [currentNumeratorValues, currentNumeratorFreshness],
      [previousDenominatorValues, previousDenominatorFreshness],
      [currentDenominatorValues, currentDenominatorFreshness]
    ] = await Promise.all([
      queryValueAndFreshness({ config, query: numeratorQuery, observedAt: candidateStart, signal }),
      queryValueAndFreshness({ config, query: numeratorQuery, observedAt, signal }),
      queryValueAndFreshness({ config, query: denominatorQuery, observedAt: candidateStart, signal }),
      queryValueAndFreshness({ config, query: denominatorQuery, observedAt, signal })
    ]);
    const numeratorSourceMetric = `${mapping.sourceMetric}_numerator`;
    const denominatorSourceMetric = `${mapping.sourceMetric}_denominator`;
    const previousNumerators = parseSet(
      previousNumeratorValues, previousNumeratorFreshness, candidateStart, numeratorSourceMetric
    );
    const currentNumerators = parseSet(
      currentNumeratorValues, currentNumeratorFreshness, observedAt, numeratorSourceMetric
    );
    const previousDenominators = parseSet(
      previousDenominatorValues, previousDenominatorFreshness, candidateStart, denominatorSourceMetric
    );
    const currentDenominators = parseSet(
      currentDenominatorValues, currentDenominatorFreshness, observedAt, denominatorSourceMetric
    );
    const index = values => new Map(values.map(item => [labelIdentity(item.labels), item]));
    const previousNumeratorByIdentity = index(previousNumerators);
    const currentNumeratorByIdentity = index(currentNumerators);
    const previousDenominatorByIdentity = index(previousDenominators);
    const currentDenominatorByIdentity = index(currentDenominators);
    const previousTimes = new Set();
    for (const labels of expectedSeries) {
      const key = labelIdentity(labels);
      const previousNumerator = previousNumeratorByIdentity.get(key);
      const currentNumerator = currentNumeratorByIdentity.get(key);
      const previousDenominator = previousDenominatorByIdentity.get(key);
      const currentDenominator = currentDenominatorByIdentity.get(key);
      if (previousNumerator.sourceObservedAt !== previousDenominator.sourceObservedAt ||
          currentNumerator.sourceObservedAt !== currentDenominator.sourceObservedAt) {
        throw invalid("Ratio numerator and denominator timestamps differ", "PROMETHEUS_SAMPLE_INVALID");
      }
      previousTimes.add(previousNumerator.sourceObservedAt);
    }
    windowStartedAt = new Date(Math.min(...[...previousTimes].map(value => Date.parse(value)))).toISOString();
    const resetElapsedMs = resetWindowDuration({
      windowStartedAt,
      observedAt,
      runStartedAt
    });
    const [numeratorResetValues, denominatorResetValues] = resetElapsedMs === 0
      ? [null, null]
      : await Promise.all([
          queryPrometheusBody({
            config,
            query: `resets(${numeratorQuery}[${inclusiveResetRange(resetElapsedMs)}])`,
            observedAt,
            signal
          }),
          queryPrometheusBody({
            config,
            query: `resets(${denominatorQuery}[${inclusiveResetRange(resetElapsedMs)}])`,
            observedAt,
            signal
          })
        ]);
    const numeratorResets = numeratorResetValues === null
      ? currentNumerators.map(item => ({ ...item, value: 0 }))
      : parseSet(numeratorResetValues, currentNumeratorFreshness, observedAt, numeratorSourceMetric, false);
    const denominatorResets = denominatorResetValues === null
      ? currentDenominators.map(item => ({ ...item, value: 0 }))
      : parseSet(denominatorResetValues, currentDenominatorFreshness, observedAt, denominatorSourceMetric, false);
    const numeratorResetByIdentity = index(numeratorResets);
    const denominatorResetByIdentity = index(denominatorResets);
    series = expectedSeries.map(labels => {
      const key = labelIdentity(labels);
      const previousNumerator = previousNumeratorByIdentity.get(key);
      const currentNumerator = currentNumeratorByIdentity.get(key);
      const previousDenominator = previousDenominatorByIdentity.get(key);
      const currentDenominator = currentDenominatorByIdentity.get(key);
      return {
        labels,
        previousObservedAt: previousNumerator.sourceObservedAt,
        currentObservedAt: currentNumerator.sourceObservedAt,
        previousNumerator: previousNumerator.value,
        currentNumerator: currentNumerator.value,
        numeratorResets: numeratorResetByIdentity.get(key).value,
        previousDenominator: previousDenominator.value,
        currentDenominator: currentDenominator.value,
        denominatorResets: denominatorResetByIdentity.get(key).value
      };
    });
  } else if (metricType === "utilization") {
    const numeratorQuery = semanticSelector(mapping, roomId, "_used");
    const denominatorQuery = semanticSelector(mapping, roomId, "_capacity");
    const [[numeratorValues, numeratorFreshness], [denominatorValues, denominatorFreshness]] = await Promise.all([
      queryValueAndFreshness({ config, query: numeratorQuery, observedAt, signal }),
      queryValueAndFreshness({ config, query: denominatorQuery, observedAt, signal })
    ]);
    const numerator = parseSet(
      numeratorValues, numeratorFreshness, observedAt, `${mapping.sourceMetric}_used`
    );
    const denominator = parseSet(
      denominatorValues, denominatorFreshness, observedAt, `${mapping.sourceMetric}_capacity`
    );
    const numeratorByIdentity = new Map(numerator.map(item => [labelIdentity(item.labels), item]));
    const denominatorByIdentity = new Map(denominator.map(item => [labelIdentity(item.labels), item]));
    series = expectedSeries.map(labels => {
      const key = labelIdentity(labels);
      const left = numeratorByIdentity.get(key);
      const right = denominatorByIdentity.get(key);
      if (left.sourceObservedAt !== right.sourceObservedAt) {
        throw invalid("Ratio numerator and denominator timestamps differ", "PROMETHEUS_SAMPLE_INVALID");
      }
      return {
        labels,
        currentObservedAt: left.sourceObservedAt,
        numerator: left.value,
        denominator: right.value
      };
    });
  } else {
    const [values, freshness] = await queryValueAndFreshness({ config, query: selector, observedAt, signal });
    series = parseSet(values, freshness).map(item => ({
      labels: item.labels,
      currentObservedAt: item.sourceObservedAt,
      value: item.value
    }));
  }
  if (!intervalMetric) windowStartedAt = runStartedAt;
  const derived = derivePrometheusSemanticValue({
    metricType,
    series,
    runStartedAt,
    runEndedAt,
    windowStartedAt,
    windowEndedAt: observedAt,
    allowEmptyHistogram
  });
  return {
    value: derived.value,
    sourceObservedAt: derived.sourceObservedAt,
    semanticProof: {
      metricType,
      windowStartedAt,
      windowEndedAt: observedAt,
      resetObserved: derived.resetObserved,
      certified: false,
      series
    }
  };
}

async function mapLimit(items, limit, operation) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await operation(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function readRequest(request) {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) throw invalid("Collector request is too large", "COLLECTOR_REQUEST_INVALID");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw invalid("Collector request is too large", "COLLECTOR_REQUEST_INVALID");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw invalid("Collector request must be strict JSON", "COLLECTOR_REQUEST_INVALID");
  }
}

function validateRequest(body) {
  const observedAtMs = canonicalIso(body?.observedAt);
  const runStartedAtMs = canonicalIso(body?.runStartedAt);
  const scenario = TRACKED_SCENARIOS.get(body?.scenarioId);
  if (!exactKeys(body, ["schemaVersion", "runId", "runStartedAt", "observedAt", "scenarioId", "phase", "profiles", "rooms"]) ||
      body.schemaVersion !== 2 || typeof body.runId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.runId) ||
      observedAtMs === null || runStartedAtMs === null || !scenario || scenario.mode !== "physical" ||
      !Array.isArray(body.rooms) || body.rooms.length === 0 || body.rooms.length > 12 ||
      !exactKeys(body.profiles, ["client", "runtime", "audio", "transport"]) ||
      !["desktop", "mobile"].includes(body.profiles.client) ||
      body.profiles.runtime !== (body.profiles.client === "mobile" ? "chromium-mobile-emulation" : "chromium-desktop-emulation") ||
      !["muted", "active"].includes(body.profiles.audio) || !["direct", "forced-turn"].includes(body.profiles.transport)) {
    throw invalid("Collector request schema is closed", "COLLECTOR_REQUEST_INVALID");
  }
  const offsetMs = observedAtMs - runStartedAtMs;
  const rampEndMs = scenario.rampUpSeconds * 1000;
  const plateauEndMs = rampEndMs + scenario.plateauSeconds * 1000;
  const expectedPhase = offsetMs < rampEndMs ? "ramp-up" : offsetMs <= plateauEndMs ? "plateau" : "ramp-down";
  if (offsetMs < 0 || offsetMs > scenario.durationSeconds * 1000 || body.phase !== expectedPhase) {
    throw invalid("Collector phase does not match the tracked scenario run window", "COLLECTOR_REQUEST_INVALID");
  }
  for (const room of body.rooms) {
    if (!exactKeys(room, ["id", "bots"]) || !/^room-\d{3}$/.test(room.id) || ![0, 5, 10].includes(room.bots)) {
      throw invalid("Collector room request is invalid", "COLLECTOR_REQUEST_INVALID");
    }
  }
  if (new Set(body.rooms.map(room => room.id)).size !== body.rooms.length ||
      new Set(body.rooms.map(room => room.bots)).size !== 1) {
    throw invalid("Collector rooms must be unique and use one bot variant", "COLLECTOR_REQUEST_INVALID");
  }
  return body;
}

export async function startPrometheusCollector({ config, thresholds, allowTestObservability = false }) {
  if (!allowTestObservability) assertObservabilityReady();
  const safeConfig = validateCollectorConfig(config, thresholds);
  const intervalSeconds = thresholds.maxCollectorIntervalSeconds;
  const inventorySha256 = sha256(canonicalJson(safeConfig.seriesInventory));
  const lastSourceTimestamp = new Map();
  const lastIntervalEvaluation = new Map();
  let activeRequest = false;
  const server = createServer(async (request, response) => {
    let ownsActiveRequest = false;
    try {
      if (request.method !== "POST" || request.url !== "/v1/capacity-sample" ||
          request.headers["content-type"]?.split(";", 1)[0] !== "application/json") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end('{"state":"INVALID","error":{"code":"COLLECTOR_ROUTE_INVALID"}}\n');
        return;
      }
      if (activeRequest) {
        response.writeHead(429, { "content-type": "application/json", "cache-control": "no-store" });
        response.end('{"state":"INVALID","error":{"code":"COLLECTOR_BUSY"}}\n');
        return;
      }
      activeRequest = true;
      ownsActiveRequest = true;
      const body = validateRequest(await readRequest(request));
      const tasks = [];
      for (const [metric, mapping] of Object.entries(safeConfig.metrics)) {
        if (mapping.collector === "bots") {
          for (const room of body.rooms) tasks.push({ metric, mapping, roomId: room.id });
        } else tasks.push({ metric, mapping, roomId: "all" });
      }
      const samples = await mapLimit(tasks, 8, async task => {
        const scopeKey = `${task.metric}/${task.roomId}`;
        const sample = await queryPrometheusSemanticMetric({
          config: safeConfig,
          metric: task.metric,
          mapping: task.mapping,
          observedAt: body.observedAt,
          runStartedAt: body.runStartedAt,
          runEndedAt: new Date(
            Date.parse(body.runStartedAt) + TRACKED_SCENARIOS.get(body.scenarioId).durationSeconds * 1000
          ).toISOString(),
          roomId: task.roomId === "all" ? undefined : task.roomId,
          intervalSeconds,
          intervalStartedAt: lastIntervalEvaluation.get(scopeKey),
          allowEmptyHistogram: task.metric === "bots.appearanceP95Ms" &&
            body.rooms.some(room => room.id === task.roomId && room.bots === 0),
          signal: AbortSignal.timeout(10_000)
        });
        return {
          collector: task.mapping.collector,
          metric: task.metric,
          value: sample.value,
          roomId: task.roomId,
          service: task.mapping.service,
          instance: `${task.mapping.service}-aggregate`,
          sourceMetric: task.mapping.sourceMetric,
          sourceQuerySha256: task.mapping.querySha256,
          sourceObservedAt: sample.sourceObservedAt,
          inventorySha256,
          semanticProof: sample.semanticProof
        };
      });
      const nextSourceTimestamp = new Map(lastSourceTimestamp);
      const nextIntervalEvaluation = new Map(lastIntervalEvaluation);
      validateAuthoritativeBotIdentityState({
        rooms: body.rooms,
        samples: samples
          .filter(sample => sample.collector === "bots" && sample.semanticProof.metricType === "authoritativeState")
          .map(sample => ({
            metric: sample.metric,
            roomId: sample.roomId,
            observedAt: body.observedAt,
            series: sample.semanticProof.series
          }))
      });
      for (const sample of samples) {
        advancePrometheusSeriesProgress(nextSourceTimestamp, {
          metric: sample.metric,
          roomId: sample.roomId,
          series: sample.semanticProof.series
        });
        nextIntervalEvaluation.set(`${sample.metric}/${sample.roomId}`, body.observedAt);
      }
      lastSourceTimestamp.clear();
      for (const [key, value] of nextSourceTimestamp) lastSourceTimestamp.set(key, value);
      lastIntervalEvaluation.clear();
      for (const [key, value] of nextIntervalEvaluation) lastIntervalEvaluation.set(key, value);
      const payload = {
        schemaVersion: 2,
        runId: body.runId,
        observedAt: body.observedAt,
        phase: body.phase,
        mapping: safeConfig.mappingIdentity,
        samples
      };
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(`${JSON.stringify(payload)}\n`);
    } catch (error) {
      response.writeHead(422, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(`{"state":"INVALID","error":{"code":"${error?.code ?? "COLLECTOR_FAILED"}"}}\n`);
    } finally {
      if (ownsActiveRequest) activeRequest = false;
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(safeConfig.listenPort, safeConfig.listenHost, resolveListen);
  });
  return server;
}

import { createHash } from "node:crypto";
import {
  BOT_STATE_METRICS,
  METRIC_CONTRACTS,
  MODEL_OBSERVATION_METRICS
} from "./metric-contracts.mjs";
import { invalid } from "./errors.mjs";
import { canonicalJson } from "./io.mjs";

const SERVER_COLLECTORS = new Set([
  "reticulum", "load-balancer", "kubernetes", "database", "coturn", "dialog", "bots"
]);

export const TRACKED_MAPPING_REVIEW = Object.freeze({
  id: "yenhubs-capacity-prometheus",
  version: "v4",
  reviewedAt: "2026-07-17T09:00:00.000Z",
  reviewerId: "capacity-contract-reviewer"
});

function trackedContracts() {
  const contracts = {};
  for (const [name, contract] of Object.entries(METRIC_CONTRACTS)) {
    if (SERVER_COLLECTORS.has(contract.collector)) contracts[name] = contract;
  }
  Object.assign(contracts, MODEL_OBSERVATION_METRICS, BOT_STATE_METRICS);
  return contracts;
}

export const TRACKED_COLLECTOR_METRICS = Object.freeze(Object.fromEntries(
  Object.entries(trackedContracts()).map(([name, contract]) => {
    const sourceMetric = `yenhubs_${name.replaceAll(".", "_")}`;
    const selector = contract.collector === "bots"
      ? `${sourceMetric}{room="{room}"}`
      : sourceMetric;
    const query = selector;
    const authoritativeBotState = Object.hasOwn(BOT_STATE_METRICS, name);
    return [name, Object.freeze({
      collector: contract.collector,
      sourceMetric,
      query,
      service: contract.collector,
      requiredLabels: Object.freeze(authoritativeBotState ? ["bot_id", "instance"] : ["instance"])
    })];
  })
));

export const TRACKED_COLLECTOR_CONTRACT_SHA256 = createHash("sha256")
  .update(canonicalJson({ mapping: TRACKED_MAPPING_REVIEW, metrics: TRACKED_COLLECTOR_METRICS }))
  .digest("hex");

export function trackedCollectorConfig({
  listenPort = 4318,
  prometheusUrl = "http://localhost:9090/",
  maxSampleAgeSeconds = 30,
  seriesInventory = Object.fromEntries(
    Object.keys(TRACKED_COLLECTOR_METRICS).map(name => [name,
      Object.hasOwn(BOT_STATE_METRICS, name)
        ? Array.from({ length: 10 }, (_, index) => ({
            bot_id: `bot-${String(index + 1).padStart(3, "0")}`,
            instance: "fixture-1"
          }))
        : [{ instance: "fixture-1" }]
    ])
  )
} = {}) {
  return {
    schemaVersion: 3,
    mapping: structuredClone(TRACKED_MAPPING_REVIEW),
    listenHost: "127.0.0.1",
    listenPort,
    prometheusUrl,
    maxSampleAgeSeconds,
    seriesInventory: structuredClone(seriesInventory),
    metrics: structuredClone(TRACKED_COLLECTOR_METRICS)
  };
}

export function trackedCollectorMappingIdentity(options = {}) {
  const config = trackedCollectorConfig(options);
  const metrics = Object.fromEntries(Object.entries(config.metrics).map(([name, mapping]) => [name, {
    ...mapping,
    querySha256: createHash("sha256").update(mapping.query).digest("hex")
  }]));
  const configuration = { ...config, metrics };
  return {
    ...structuredClone(TRACKED_MAPPING_REVIEW),
    sha256: createHash("sha256").update(canonicalJson(configuration)).digest("hex"),
    contractSha256: TRACKED_COLLECTOR_CONTRACT_SHA256,
    configuration
  };
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

export function validateTrackedCollectorMappingIdentity(identity) {
  if (!exactKeys(identity, [
    "id", "version", "reviewedAt", "reviewerId", "sha256", "contractSha256", "configuration"
  ]) || canonicalJson({
    id: identity.id,
    version: identity.version,
    reviewedAt: identity.reviewedAt,
    reviewerId: identity.reviewerId
  }) !== canonicalJson(TRACKED_MAPPING_REVIEW) ||
      identity.contractSha256 !== TRACKED_COLLECTOR_CONTRACT_SHA256 ||
      !/^[0-9a-f]{64}$/.test(identity.sha256) ||
      !exactKeys(identity.configuration, [
        "schemaVersion", "mapping", "listenHost", "listenPort", "prometheusUrl",
        "maxSampleAgeSeconds", "seriesInventory", "metrics"
      ]) || identity.configuration.schemaVersion !== 3 ||
      canonicalJson(identity.configuration.mapping) !== canonicalJson(TRACKED_MAPPING_REVIEW) ||
      identity.configuration.listenHost !== "127.0.0.1" ||
      !Number.isInteger(identity.configuration.listenPort) || identity.configuration.listenPort < 1024 ||
      identity.configuration.listenPort > 65535 ||
      !Number.isInteger(identity.configuration.maxSampleAgeSeconds) ||
      identity.configuration.maxSampleAgeSeconds < 1 || identity.configuration.maxSampleAgeSeconds > 60 ||
      createHash("sha256").update(canonicalJson(identity.configuration)).digest("hex") !== identity.sha256) {
    throw invalid("Collector mapping identity is outside the tracked closed contract", "COLLECTOR_MAPPING_INVALID");
  }
  let prometheus;
  try {
    prometheus = new URL(identity.configuration.prometheusUrl);
  } catch {
    throw invalid("Collector Prometheus origin is invalid", "COLLECTOR_MAPPING_INVALID");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(prometheus.hostname.toLowerCase());
  if (!loopback || !["http:", "https:"].includes(prometheus.protocol) || prometheus.pathname !== "/" ||
      prometheus.username || prometheus.password || prometheus.search || prometheus.hash ||
      prometheus.toString() !== identity.configuration.prometheusUrl) {
    throw invalid("Collector Prometheus origin is not closed loopback", "COLLECTOR_MAPPING_INVALID");
  }
  const names = Object.keys(identity.configuration.metrics ?? {}).sort();
  const expectedNames = Object.keys(TRACKED_COLLECTOR_METRICS).sort();
  if (canonicalJson(names) !== canonicalJson(expectedNames)) {
    throw invalid("Collector mapping metric set differs from the tracked contract", "COLLECTOR_MAPPING_INVALID");
  }
  if (!exactKeys(identity.configuration.seriesInventory, expectedNames)) {
    throw invalid("Collector series inventory must cover every metric exactly", "COLLECTOR_MAPPING_INVALID");
  }
  for (const name of expectedNames) {
    const mapping = identity.configuration.metrics[name];
    if (!exactKeys(mapping, [
      "collector", "sourceMetric", "query", "service", "requiredLabels", "querySha256"
    ]) || canonicalJson({
      collector: mapping.collector,
      sourceMetric: mapping.sourceMetric,
      query: mapping.query,
      service: mapping.service,
      requiredLabels: mapping.requiredLabels
    }) !== canonicalJson(TRACKED_COLLECTOR_METRICS[name]) ||
        mapping.querySha256 !== createHash("sha256").update(mapping.query).digest("hex")) {
      throw invalid("Collector metric mapping differs from the tracked contract", "COLLECTOR_MAPPING_INVALID", { metric: name });
    }
    const inventory = identity.configuration.seriesInventory[name];
    if (!Array.isArray(inventory) || inventory.length === 0 || inventory.length > 128 ||
        inventory.some(labels => !exactKeys(labels, mapping.requiredLabels) ||
          Object.values(labels).some(value => typeof value !== "string" || value.length === 0 || value.length > 256)) ||
        new Set(inventory.map(labels => canonicalJson(labels))).size !== inventory.length ||
        canonicalJson(inventory) !== canonicalJson([...inventory].sort((left, right) =>
          canonicalJson(left).localeCompare(canonicalJson(right))
        ))) {
      throw invalid("Collector metric inventory is not one canonical exact series set", "COLLECTOR_MAPPING_INVALID", {
        metric: name
      });
    }
    if (Object.hasOwn(BOT_STATE_METRICS, name) &&
        (inventory.length !== 10 || new Set(inventory.map(labels => labels.bot_id)).size !== inventory.length ||
          inventory.some(labels => !/^bot-(?:00[1-9]|010)$/.test(labels.bot_id)))) {
      throw invalid("Collector bot inventory does not bind ten unique identities", "COLLECTOR_MAPPING_INVALID", {
        metric: name
      });
    }
  }
  if (new Set(Object.keys(BOT_STATE_METRICS).map(name =>
    canonicalJson(identity.configuration.seriesInventory[name])
  )).size !== 1) {
    throw invalid("Collector bot state inventories differ", "COLLECTOR_MAPPING_INVALID");
  }
  return identity;
}

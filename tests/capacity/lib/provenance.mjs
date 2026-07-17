import { createHash } from "node:crypto";
import { invalid } from "./errors.mjs";
import { canonicalJson, stableId } from "./io.mjs";
import { validateTrackedCollectorMappingIdentity } from "./collector-contract.mjs";
import {
  BOT_STATE_METRICS,
  METRIC_CONTRACTS,
  MODEL_OBSERVATION_METRICS,
  PARTICIPANT_JOIN_METRICS,
  PARTICIPANT_EVIDENCE_METRICS,
  PHASE_EVENT_METRICS,
  PROFILE_METRICS,
  expectedCollectors,
  expectedThresholdMetrics,
  requiredRawContracts
} from "./metric-contracts.mjs";
import {
  OBSERVABILITY_METRIC_CONTRACTS,
  advancePrometheusSeriesProgress,
  derivePrometheusSemanticValue,
  validateAuthoritativeBotIdentityState
} from "./observability-contract.mjs";

const DIMENSION_KEYS = [
  "roomId",
  "workerId",
  "participantId",
  "service",
  "instance",
  "clientProfile",
  "audioMode",
  "transportMode",
  "phase"
];
const MAPPING_KEYS = ["id", "version", "reviewedAt", "reviewerId", "sha256", "contractSha256", "configuration"];

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

export function rawArtifact(samples) {
  const hash = createHash("sha256");
  let bytes = 0;
  for (const sample of samples) {
    const line = `${canonicalJson(sample)}\n`;
    bytes += Buffer.byteLength(line, "utf8");
    hash.update(line);
  }
  return {
    name: "raw.ndjson",
    sha256: hash.digest("hex"),
    bytes,
    sampleCount: samples.length
  };
}

function sampleLink(samples, rawSha256) {
  const hash = createHash("sha256");
  for (const sample of samples) hash.update(`${sample.id}\n`);
  return {
    sampleCount: samples.length,
    sampleIdsSha256: hash.digest("hex"),
    firstSampleId: samples[0].id,
    lastSampleId: samples.at(-1).id,
    firstObservedAt: samples[0].observedAt,
    lastObservedAt: samples.at(-1).observedAt,
    rawSha256
  };
}

export function makeRawSample({ runId, collector, metric, value, observedAt, dimensions, source }) {
  const effectiveSource = source ?? {
    kind: collector === "client" || collector === "webrtc" ? "browser" : collector === "generator" ? "host" : "fixture",
    sourceObservedAt: observedAt
  };
  const core = { runId, collector, metric, value, observedAt, dimensions, source: effectiveSource };
  return { id: stableId("sample", core), ...core };
}

function percentile(values, percent) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil((percent / 100) * sorted.length) - 1);
  return sorted[index];
}

function aggregateValues(samples, aggregation, rule) {
  const values = samples.map(sample => sample.value);
  let value;
  if (aggregation === "sum") value = values.reduce((sum, item) => sum + item, 0);
  else if (aggregation === "mean") value = values.reduce((sum, item) => sum + item, 0) / values.length;
  else if (aggregation === "p95") value = percentile(values, 95);
  else if (aggregation === "p10") value = percentile(values, 10);
  else if (aggregation === "max") value = Math.max(...values);
  else if (aggregation === "latest") value = samples.at(-1).value;
  else throw invalid("Raw metric aggregation is unsupported", "RAW_PROVENANCE_INVALID");

  if (!rule?.sustainedMs) return value;
  let activeStart = null;
  let longest = 0;
  for (const sample of samples) {
    const time = Date.parse(sample.observedAt);
    const violates = Object.hasOwn(rule, "max") ? sample.value > rule.max : sample.value < rule.min;
    if (violates) activeStart ??= time;
    else if (activeStart !== null) {
      longest = Math.max(longest, time - activeStart);
      activeStart = null;
    }
  }
  if (activeStart !== null) longest = Math.max(longest, Date.parse(samples.at(-1).observedAt) - activeStart);
  return { peakValue: value, maxBreachDurationMs: longest };
}

export function deriveRawAggregate(samples, aggregation, rule) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw invalid("Raw aggregate requires at least one sample", "RAW_PROVENANCE_MISSING");
  }
  return aggregateValues(samples, aggregation, rule);
}

function participantIndex(plan) {
  const index = new Map();
  for (const room of plan.rooms) {
    for (const worker of room.workers) {
      for (let offset = 0; offset < worker.participantCount; offset += 1) {
        const participantId = `participant-${String(worker.participantStart + offset).padStart(6, "0")}`;
        index.set(participantId, { roomId: room.id, workerId: worker.id });
      }
    }
  }
  return index;
}

function validateDimensions(sample, plan, participants) {
  if (!exactKeys(sample.dimensions, DIMENSION_KEYS)) return false;
  const dimensions = sample.dimensions;
  if (
    dimensions.clientProfile !== plan.scenario.clientProfile ||
    dimensions.audioMode !== plan.scenario.audioMode ||
    dimensions.transportMode !== plan.scenario.transportMode ||
    !["ramp-up", "lobby", "plateau", "ramp-down"].includes(dimensions.phase) ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(dimensions.service) ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(dimensions.instance)
  ) return false;

  if (sample.collector === "client" || sample.collector === "webrtc") {
    const expected = participants.get(dimensions.participantId);
    return Boolean(expected && expected.roomId === dimensions.roomId && expected.workerId === dimensions.workerId);
  }
  if (sample.collector === "bots") {
    return plan.rooms.some(room => room.id === dimensions.roomId) &&
      dimensions.workerId === "all" && dimensions.participantId === "all";
  }
  return dimensions.roomId === "all" && dimensions.workerId === "all" && dimensions.participantId === "all";
}

function validateMappingIdentity(mapping) {
  if (!exactKeys(mapping, MAPPING_KEYS)) return false;
  try {
    validateTrackedCollectorMappingIdentity(mapping);
    return true;
  } catch {
    return false;
  }
}

function validateSampleSource(sample, collectorMapping, maximumAgeMs, allowTestFixtures, plan, run) {
  const source = sample.source;
  const sourceMs = canonicalIso(source?.sourceObservedAt);
  const observedMs = Date.parse(sample.observedAt);
  if (sourceMs === null || sourceMs > observedMs || observedMs - sourceMs > maximumAgeMs) return false;
  if (source.kind === "fixture") {
    return allowTestFixtures === true && exactKeys(source, ["kind", "sourceObservedAt"]);
  }
  if (source.kind === "browser-ice") {
    const allowed = new Set(plan.security.coturnUrls);
    return exactKeys(source, ["kind", "sourceObservedAt", "iceServerUrls"]) &&
      Array.isArray(source.iceServerUrls) && source.iceServerUrls.length <= 16 &&
      source.iceServerUrls.every(value => typeof value === "string" && allowed.has(value)) &&
      new Set(source.iceServerUrls).size === source.iceServerUrls.length &&
      canonicalJson(source.iceServerUrls) === canonicalJson([...source.iceServerUrls].sort()) &&
      (plan.scenario.transportMode !== "forced-turn" ||
        source.iceServerUrls.some(value => /^turns?:/i.test(value)));
  }
  if (source.kind === "host-process-tree") {
    const validProcessTree = exactKeys(source, [
      "kind", "sourceObservedAt", "measurementSource", "rootPid", "processCount",
      "browserRootProcessCount", "cpuPercent", "rssBytes", "systemCpuCount", "totalMemoryBytes"
    ]) && sample.collector === "generator" && [
      "generator.cpuUtilization", "generator.memoryUtilization", "generator.rssMiB",
      "generator.browserProcessCount", "generator.processCount"
    ].includes(sample.metric) &&
      source.measurementSource === "ps-process-tree-v1" && Number.isInteger(source.rootPid) && source.rootPid > 0 &&
      Number.isInteger(source.processCount) && source.processCount > 0 &&
      Number.isInteger(source.browserRootProcessCount) && source.browserRootProcessCount >= 0 &&
      Number.isFinite(source.cpuPercent) && source.cpuPercent >= 0 &&
      Number.isInteger(source.rssBytes) && source.rssBytes > 0 &&
      Number.isInteger(source.systemCpuCount) && source.systemCpuCount > 0 &&
      Number.isInteger(source.totalMemoryBytes) && source.totalMemoryBytes > 0;
    if (!validProcessTree) return false;
    const expected = {
      "generator.cpuUtilization": Math.min(1, source.cpuPercent / 100 / source.systemCpuCount),
      "generator.memoryUtilization": source.rssBytes / source.totalMemoryBytes,
      "generator.rssMiB": source.rssBytes / 1024 ** 2,
      "generator.browserProcessCount": source.browserRootProcessCount,
      "generator.processCount": source.processCount
    };
    return sample.value === expected[sample.metric];
  }
  if (source.kind === "host-event-loop") {
    return sample.collector === "generator" && sample.metric === "generator.eventLoopLagP95Ms" &&
      exactKeys(source, ["kind", "sourceObservedAt", "measurementSource", "rootPid"]) &&
      source.measurementSource === "node-perf-hooks-monitor-event-loop-delay-v1" &&
      Number.isInteger(source.rootPid) && source.rootPid > 0;
  }
  if (source.kind === "browser") {
    return ["client", "webrtc"].includes(sample.collector) &&
      sample.metric !== "webrtc.iceServerAttestationValid" &&
      exactKeys(source, ["kind", "sourceObservedAt"]);
  }
  const mapping = collectorMapping.configuration?.metrics?.[sample.metric];
  if (source.kind !== "prometheus" || !exactKeys(source, [
    "kind", "mappingSha256", "sourceMetric", "querySha256", "sourceObservedAt",
    "inventorySha256", "semanticProof"
  ]) || source.mappingSha256 !== collectorMapping.sha256 || !mapping ||
      source.sourceMetric !== mapping.sourceMetric ||
      source.querySha256 !== createHash("sha256").update(mapping.query).digest("hex") ||
      !/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(source.sourceMetric) || !/^[0-9a-f]{64}$/.test(source.querySha256) ||
      source.inventorySha256 !== createHash("sha256")
        .update(canonicalJson(collectorMapping.configuration.seriesInventory))
        .digest("hex") ||
      !exactKeys(source.semanticProof, [
        "metricType", "windowStartedAt", "windowEndedAt", "resetObserved", "certified", "series"
      ]) || source.semanticProof.metricType !== OBSERVABILITY_METRIC_CONTRACTS[sample.metric]?.metricType ||
      source.semanticProof.windowEndedAt !== sample.observedAt || source.semanticProof.certified !== false ||
      !Array.isArray(source.semanticProof.series)) {
    return false;
  }
  if (sample.dimensions.instance !== `${mapping.service}-aggregate` ||
      canonicalJson(source.semanticProof.series.map(item => item?.labels)) !==
        canonicalJson(collectorMapping.configuration.seriesInventory[sample.metric]) ||
      source.semanticProof.series.some(item => {
        const currentMs = canonicalIso(item?.currentObservedAt);
        return currentMs === null || currentMs > observedMs || observedMs - currentMs > maximumAgeMs;
      })) return false;
  try {
    const derived = derivePrometheusSemanticValue({
      metricType: source.semanticProof.metricType,
      series: source.semanticProof.series,
      runStartedAt: run.startedAt,
      runEndedAt: run.endedAt,
      windowStartedAt: source.semanticProof.windowStartedAt,
      windowEndedAt: source.semanticProof.windowEndedAt,
      allowEmptyHistogram: sample.metric === "bots.appearanceP95Ms" &&
        plan.rooms.some(room => room.id === sample.dimensions.roomId && room.bots === 0)
    });
    return Math.abs(derived.value - sample.value) <= Number.EPSILON * Math.max(1, Math.abs(sample.value)) * 16 &&
      derived.sourceObservedAt === source.sourceObservedAt &&
      derived.resetObserved === source.semanticProof.resetObserved;
  } catch {
    return false;
  }
}

function validateCollectorCoverage(samples, run, maximumGapMs) {
  const runStart = Date.parse(run.startedAt);
  const runEnd = Date.parse(run.endedAt);
  const ordered = [...samples]
    .filter(sample => Date.parse(sample.observedAt) >= runStart && Date.parse(sample.observedAt) <= runEnd)
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  if (ordered.length === 0) return false;
  const first = Date.parse(ordered[0].observedAt);
  const last = Date.parse(ordered.at(-1).observedAt);
  if (first < runStart || first - runStart > maximumGapMs || last > runEnd || runEnd - last > maximumGapMs) return false;
  for (let index = 1; index < ordered.length; index += 1) {
    if (Date.parse(ordered[index].observedAt) - Date.parse(ordered[index - 1].observedAt) > maximumGapMs) return false;
  }
  return true;
}

export function collectorCoverageWindow(plan, run, collector) {
  if (collector === "client" || collector === "webrtc") {
    const startedAtMs = Date.parse(run.startedAt) + plan.workload.rampUp.durationSeconds * 1000;
    return {
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt: new Date(startedAtMs + plan.workload.plateau.durationSeconds * 1000).toISOString(),
      coverageSeconds: plan.workload.plateau.durationSeconds
    };
  }
  return {
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    coverageSeconds: plan.scenario.durationSeconds
  };
}

function intervalMetricCoverageWindow(plan, run, collector) {
  if (collector === "client" || collector === "webrtc") {
    const startedAtMs = Date.parse(run.startedAt) + plan.workload.rampUp.durationSeconds * 1000;
    const endedAtMs = startedAtMs + plan.workload.plateau.durationSeconds * 1000;
    return {
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt: new Date(endedAtMs).toISOString(),
      coverageSeconds: plan.workload.plateau.durationSeconds
    };
  }
  return {
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    coverageSeconds: plan.scenario.durationSeconds
  };
}

function sameAggregate(actual, derived) {
  return canonicalJson(actual) === canonicalJson(derived);
}

function expectedClientIntervalTimes(plan, run, intervalSeconds) {
  const ramp = plan.workload.rampUp.durationSeconds;
  const plateauEnd = ramp + plan.workload.plateau.durationSeconds;
  const offsets = new Set([ramp, plateauEnd]);
  for (let offset = 0; offset <= plan.scenario.durationSeconds; offset += intervalSeconds) {
    if (offset >= ramp && offset <= plateauEnd) offsets.add(offset);
  }
  for (let offset = ramp + plan.workload.movement.intervalSeconds; offset < plateauEnd;
    offset += plan.workload.movement.intervalSeconds) offsets.add(offset);
  const startedAtMs = Date.parse(run.startedAt);
  return [...offsets].sort((left, right) => left - right)
    .map(offset => new Date(startedAtMs + offset * 1000).toISOString());
}

function expectedRunIntervalTimes(plan, run, intervalSeconds) {
  const offsets = new Set([
    0,
    plan.workload.rampUp.durationSeconds,
    plan.workload.rampUp.durationSeconds + plan.workload.plateau.durationSeconds,
    plan.scenario.durationSeconds
  ]);
  for (let offset = 0; offset <= plan.scenario.durationSeconds; offset += intervalSeconds) offsets.add(offset);
  for (let offset = plan.workload.rampUp.durationSeconds + plan.workload.movement.intervalSeconds;
    offset < plan.workload.rampUp.durationSeconds + plan.workload.plateau.durationSeconds;
    offset += plan.workload.movement.intervalSeconds) offsets.add(offset);
  const startedAtMs = Date.parse(run.startedAt);
  return [...offsets].sort((left, right) => left - right)
    .map(offset => new Date(startedAtMs + offset * 1000).toISOString());
}

function expectedPhase(plan, run, sample) {
  if (sample.metric === "phase.lobby.join" || sample.metric === "phase.lobby.leave") return "lobby";
  const offsetMs = Date.parse(sample.observedAt) - Date.parse(run.startedAt);
  const rampEndMs = plan.workload.rampUp.durationSeconds * 1000;
  const plateauEndMs = rampEndMs + plan.workload.plateau.durationSeconds * 1000;
  if (offsetMs < rampEndMs) return "ramp-up";
  if (offsetMs <= plateauEndMs) return "plateau";
  return "ramp-down";
}

export function validateRawEvidence({
  plan,
  run,
  raw,
  rawSamples,
  claimedMetrics,
  claimedCollectors,
  collectorMapping,
  thresholds,
  allowTestFixtures = false
}) {
  const hasEmbeddedSamples = exactKeys(raw, ["format", "artifact", "samples"]);
  const hasExternalSamples = exactKeys(raw, ["format", "artifact"]);
  if ((!hasEmbeddedSamples && !hasExternalSamples) || raw.format !== "yenhubs-capacity-ndjson-v3") {
    throw invalid("Completed evidence requires the closed raw NDJSON provenance contract", "RAW_PROVENANCE_MISSING");
  }
  const samplesInput = hasEmbeddedSamples ? raw.samples : rawSamples;
  if (!Array.isArray(samplesInput) || samplesInput.length === 0) {
    throw invalid("Raw provenance must contain timestamped samples", "RAW_PROVENANCE_MISSING");
  }
  if (!validateMappingIdentity(collectorMapping)) {
    throw invalid("Completed evidence requires one reviewed collector mapping identity", "COLLECTOR_MAPPING_INVALID");
  }
  const expectedArtifact = rawArtifact(samplesInput);
  if (!exactKeys(raw.artifact, ["name", "sha256", "bytes", "sampleCount"]) ||
      canonicalJson(raw.artifact) !== canonicalJson(expectedArtifact)) {
    throw invalid("Raw artifact hash, size or sample count is invalid", "RAW_ARTIFACT_INVALID");
  }

  const contracts = requiredRawContracts(plan, thresholds);
  const allowedCollectors = new Set(expectedCollectors(plan, thresholds));
  const participants = participantIndex(plan);
  const startedAtMs = Date.parse(run.startedAt);
  const endedAtMs = Date.parse(run.endedAt);
  const ids = new Set();
  const byMetric = new Map();
  const byCollector = new Map();
  const sourceProgress = new Map();
  let previousTime = -Infinity;

  for (const sample of samplesInput) {
    if (!exactKeys(sample, ["id", "runId", "collector", "metric", "value", "observedAt", "dimensions", "source"])) {
      throw invalid("Raw sample schema is closed", "RAW_SAMPLE_INVALID");
    }
    const time = canonicalIso(sample.observedAt);
    const sourceTime = canonicalIso(sample?.source?.sourceObservedAt);
    const expectedId = makeRawSample({
      runId: sample.runId,
      collector: sample.collector,
      metric: sample.metric,
      value: sample.value,
      observedAt: sample.observedAt,
      dimensions: sample.dimensions,
      source: sample.source
    }).id;
    const contract = contracts[sample.metric];
    if (
      sample.runId !== plan.run.id ||
      sample.id !== expectedId ||
      ids.has(sample.id) ||
      !Number.isFinite(sample.value) || sample.value < 0 ||
      time === null || time < startedAtMs || time > endedAtMs || time < previousTime ||
      sourceTime === null || sourceTime < startedAtMs || sourceTime > endedAtMs ||
      !contract || contract.collector !== sample.collector ||
      !allowedCollectors.has(sample.collector) ||
      !validateDimensions(sample, plan, participants) ||
      sample.dimensions.phase !== expectedPhase(plan, run, sample) ||
      !validateSampleSource(
        sample,
        collectorMapping,
        thresholds.maxCollectorIntervalSeconds * 2000,
        allowTestFixtures,
        plan,
        run
      )
    ) throw invalid("Raw sample is not bound to the plan, metric or run window", "RAW_SAMPLE_INVALID", {
      metric: sample?.metric,
      sampleId: sample?.id
    });
    if (sample.source.kind === "prometheus") {
      advancePrometheusSeriesProgress(sourceProgress, {
        metric: sample.metric,
        roomId: sample.dimensions.roomId,
        series: sample.source.semanticProof.series
      });
    }
    ids.add(sample.id);
    previousTime = time;
    if (!byMetric.has(sample.metric)) byMetric.set(sample.metric, []);
    if (!byCollector.has(sample.collector)) byCollector.set(sample.collector, []);
    byMetric.get(sample.metric).push(sample);
    byCollector.get(sample.collector).push(sample);
  }

  if (!allowTestFixtures) {
    validateAuthoritativeBotIdentityState({
      rooms: plan.rooms.map(room => ({ id: room.id, bots: room.bots })),
      samples: samplesInput
        .filter(sample => sample.source.kind === "prometheus" &&
          sample.source.semanticProof.metricType === "authoritativeState")
        .map(sample => ({
          metric: sample.metric,
          roomId: sample.dimensions.roomId,
          observedAt: sample.observedAt,
          series: sample.source.semanticProof.series
        }))
    });
  }

  const maximumGapMs = thresholds.maxCollectorIntervalSeconds * 1000;
  for (const [name, contract] of Object.entries(contracts)) {
    const coverage = intervalMetricCoverageWindow(plan, run, contract.collector);
    if (contract.sampling === "interval" && !validateCollectorCoverage(byMetric.get(name) ?? [], coverage, maximumGapMs)) {
      throw invalid("Interval metric has a missing or stale raw sampling window", "RAW_SAMPLING_GAP", { metric: name });
    }
  }

  const expectedParticipantTimes = expectedClientIntervalTimes(plan, run, thresholds.maxCollectorIntervalSeconds);
  const joinObservedAt = expectedParticipantTimes[0];
  for (const name of PARTICIPANT_JOIN_METRICS) {
    const samples = byMetric.get(name) ?? [];
    const perParticipant = new Map();
    for (const sample of samples) {
      const participantId = sample.dimensions.participantId;
      if (perParticipant.has(participantId) || sample.observedAt !== joinObservedAt) {
        throw invalid("Every join metric requires exactly one plateau-bound sample per participant", "PARTICIPANT_SERIES_INCOMPLETE", {
          metric: name,
          participantId
        });
      }
      perParticipant.set(participantId, sample);
    }
    if (samples.length !== participants.size || perParticipant.size !== participants.size ||
        [...participants.keys()].some(participantId => !perParticipant.has(participantId))) {
      throw invalid("Every join metric requires exactly one sample for every planned participant", "PARTICIPANT_SERIES_INCOMPLETE", {
        metric: name
      });
    }
  }
  for (const [name, contract] of Object.entries(contracts)) {
    if (contract.sampling !== "interval" || !["client", "webrtc"].includes(contract.collector)) continue;
    const samples = byMetric.get(name) ?? [];
    const perParticipant = new Map();
    for (const sample of samples) {
      const participantId = sample.dimensions.participantId;
      if (!perParticipant.has(participantId)) perParticipant.set(participantId, []);
      perParticipant.get(participantId).push(sample.observedAt);
    }
    if (perParticipant.size !== participants.size) {
      throw invalid("Every client/WebRTC interval series must cover every participant", "PARTICIPANT_SERIES_INCOMPLETE", { metric: name });
    }
    for (const participantId of participants.keys()) {
      const actualTimes = perParticipant.get(participantId) ?? [];
      if (canonicalJson(actualTimes) !== canonicalJson(expectedParticipantTimes)) {
        throw invalid("Participant interval cardinality or timestamps are incomplete", "PARTICIPANT_SERIES_INCOMPLETE", {
          metric: name,
          participantId
        });
      }
    }
  }

  const expectedRunTimes = expectedRunIntervalTimes(plan, run, thresholds.maxCollectorIntervalSeconds);
  for (const [name, contract] of Object.entries(contracts)) {
    if (contract.sampling !== "interval" || ["client", "webrtc"].includes(contract.collector)) continue;
    const samples = byMetric.get(name) ?? [];
    const groups = new Map();
    if (contract.collector === "bots") {
      for (const sample of samples) {
        if (!groups.has(sample.dimensions.roomId)) groups.set(sample.dimensions.roomId, []);
        groups.get(sample.dimensions.roomId).push(sample.observedAt);
      }
      if (groups.size !== plan.rooms.length) {
        throw invalid("Every bot interval metric must cover every room", "RAW_SAMPLING_CARDINALITY_INVALID", { metric: name });
      }
      for (const room of plan.rooms) {
        if (canonicalJson(groups.get(room.id) ?? []) !== canonicalJson(expectedRunTimes)) {
          throw invalid("Bot interval series has missing, duplicate or shifted timestamps", "RAW_SAMPLING_CARDINALITY_INVALID", {
            metric: name,
            roomId: room.id
          });
        }
      }
    } else if (contract.collector === "generator") {
      for (const sample of samples) {
        if (!groups.has(sample.dimensions.instance)) groups.set(sample.dimensions.instance, []);
        groups.get(sample.dimensions.instance).push(sample.observedAt);
      }
      if (groups.size !== plan.executionTopology.hosts.length) {
        throw invalid("Every generator interval metric must cover every planned host", "RAW_SAMPLING_CARDINALITY_INVALID", { metric: name });
      }
      for (const host of plan.executionTopology.hosts) {
        if (canonicalJson(groups.get(host.id) ?? []) !== canonicalJson(expectedRunTimes)) {
          throw invalid("Generator host series has missing, duplicate or shifted timestamps", "RAW_SAMPLING_CARDINALITY_INVALID", {
            metric: name,
            hostId: host.id
          });
        }
      }
    } else if (canonicalJson(samples.map(sample => sample.observedAt)) !== canonicalJson(expectedRunTimes)) {
      throw invalid("Server interval metric has missing, duplicate or shifted timestamps", "RAW_SAMPLING_CARDINALITY_INVALID", {
        metric: name
      });
    }
  }

  const expectedCollectorNames = expectedCollectors(plan, thresholds);
  if (!Array.isArray(claimedCollectors) || claimedCollectors.length !== expectedCollectorNames.length) {
    throw invalid("Collector evidence must match the bot variant", "COLLECTOR_EVIDENCE_MISSING");
  }
  if (new Set(claimedCollectors.map(item => item?.name)).size !== claimedCollectors.length) {
    throw invalid("Collector evidence names must be unique", "EVIDENCE_INVALID");
  }
  const collectorMap = new Map(claimedCollectors.map(item => [item?.name, item]));
  const safeCollectors = [];
  for (const name of expectedCollectorNames) {
    const samples = byCollector.get(name) ?? [];
    const claim = collectorMap.get(name);
    const coverage = collectorCoverageWindow(plan, run, name);
    if (!exactKeys(claim, ["name", "status", "samples", "coverageSeconds", "startedAt", "endedAt", "runId"]) ||
        claim.status !== "complete" || claim.runId !== plan.run.id || claim.samples !== samples.length ||
        claim.coverageSeconds !== coverage.coverageSeconds || claim.startedAt !== coverage.startedAt ||
        claim.endedAt !== coverage.endedAt || !validateCollectorCoverage(samples, coverage, maximumGapMs)) {
      throw invalid("Every collector must be derived from gap-bounded raw samples", "COLLECTOR_EVIDENCE_MISSING", {
        invalidCollectors: [name]
      });
    }
    safeCollectors.push({
      name,
      runId: plan.run.id,
      samples: samples.length,
      coverageSeconds: coverage.coverageSeconds,
      startedAt: coverage.startedAt,
      endedAt: coverage.endedAt
    });
  }

  const expectedMetricNames = expectedThresholdMetrics(plan, thresholds);
  if (!exactKeys(claimedMetrics, expectedMetricNames)) {
    throw invalid("Metric evidence must match the selected bot variant", "METRIC_EVIDENCE_MISSING");
  }
  const aggregates = {};
  const aggregateProvenance = {};
  for (const name of expectedMetricNames) {
    const samples = byMetric.get(name) ?? [];
    const contract = METRIC_CONTRACTS[name];
    if (samples.length === 0) throw invalid("Every aggregate requires raw samples", "RAW_PROVENANCE_MISSING", { metric: name });
    const derived = aggregateValues(samples, contract.aggregation, thresholds.metrics[name]);
    if (!sameAggregate(claimedMetrics[name], derived)) {
      throw invalid("Claimed metric does not equal its raw aggregation", "AGGREGATE_PROVENANCE_INVALID", { metric: name });
    }
    aggregates[name] = derived;
    aggregateProvenance[name] = {
      collector: contract.collector,
      aggregation: contract.aggregation,
      ...sampleLink(samples, expectedArtifact.sha256)
    };
  }

  const expectedProfileValues = {
    "client.profileMobile": plan.scenario.clientProfile === "mobile" ? 1 : 0,
    "client.audioTrackActive": plan.scenario.audioMode === "active" ? 1 : 0,
    "webrtc.selectedCandidateRelay": plan.scenario.transportMode === "forced-turn" ? 1 : 0,
    "webrtc.iceServerAttestationValid": 1
  };
  const profileProvenance = {};
  for (const [name, expected] of Object.entries(expectedProfileValues)) {
    const samples = byMetric.get(name) ?? [];
    const coveredParticipants = new Set(samples.map(sample => sample.dimensions.participantId));
    if (samples.length !== plan.totals.participants || coveredParticipants.size !== plan.totals.participants ||
        samples.some(sample => sample.value !== expected)) {
      throw invalid("Client, audio and transport profiles require per-participant raw proof", "PROFILE_EVIDENCE_INVALID", { metric: name });
    }
    profileProvenance[name] = sampleLink(samples, expectedArtifact.sha256);
  }

  const modelObservations = {};
  const modelObservationProvenance = {};
  for (const [name, contract] of Object.entries(MODEL_OBSERVATION_METRICS)) {
    const samples = byMetric.get(name) ?? [];
    if (samples.length === 0 || samples.some(sample => sample.value <= 0)) {
      throw invalid("Capacity model observations require positive raw samples", "MODEL_OBSERVATION_MISSING", { metric: name });
    }
    modelObservations[name] = aggregateValues(samples, contract.aggregation);
    modelObservationProvenance[name] = {
      collector: contract.collector,
      aggregation: contract.aggregation,
      ...sampleLink(samples, expectedArtifact.sha256)
    };
  }

  return {
    artifact: expectedArtifact,
    collectorMapping: { ...collectorMapping },
    byMetric,
    collectors: safeCollectors,
    metrics: aggregates,
    aggregateProvenance,
    modelObservations,
    modelObservationProvenance,
    profileProvenance
  };
}

export function validateBotRawState({ plan, rawResult, evidenceRooms }) {
  const botMetrics = Object.keys(BOT_STATE_METRICS);
  const provenance = { state: "observed", rooms: {} };
  const planRooms = new Map(plan.rooms.map(room => [room.id, room]));
  const states = evidenceRooms.map(room => {
    if (!exactKeys(room.bots, ["state", "desired", "active", "authenticated", "spawnAcknowledged", "navmeshReady"]) ||
        room.bots.state !== "observed") {
      throw invalid("Bot room evidence schema is closed", "BOT_EVIDENCE_INVALID");
    }
    const derived = {};
    for (const name of botMetrics) {
      const samples = (rawResult.byMetric.get(name) ?? []).filter(sample => sample.dimensions.roomId === room.id);
      if (samples.length === 0 || samples.some(sample => sample.value !== planRooms.get(room.id)?.bots)) {
        throw invalid("Bot readiness counts must remain equal to desired for the complete timeline", "BOT_EVIDENCE_INVALID");
      }
      derived[name] = samples.at(-1).value;
    }
    const desired = planRooms.get(room.id)?.bots;
    const expected = {
      state: "observed",
      desired,
      active: desired,
      authenticated: desired,
      spawnAcknowledged: desired,
      navmeshReady: desired
    };
    if (
      derived["bots.state.desired"] !== desired || derived["bots.state.active"] !== desired ||
      derived["bots.state.authenticated"] !== desired || derived["bots.state.spawnAck"] !== desired ||
      derived["bots.state.navmeshReady"] !== desired || canonicalJson(room.bots) !== canonicalJson(expected)
    ) throw invalid("Desired, active, authenticated, spawn ACK and navmesh-ready bot counts must agree", "BOT_EVIDENCE_INVALID");
    provenance.rooms[room.id] = Object.fromEntries(botMetrics.map(name => {
      const samples = (rawResult.byMetric.get(name) ?? []).filter(sample => sample.dimensions.roomId === room.id);
      return [name, sampleLink(samples, rawResult.artifact.sha256)];
    }));
    return expected;
  });
  return { states, provenance };
}

function requireExactKeys(value, expected, code, message) {
  if (!exactKeys(value, expected)) throw invalid(message, code);
}

function participantEventMap(rawResult, metric, participantTotal) {
  const samples = rawResult.byMetric.get(metric) ?? [];
  const result = new Map();
  for (const sample of samples) {
    if (sample.value !== 1 || result.has(sample.dimensions.participantId)) {
      throw invalid("Phase events require one value=1 event per participant", "PHASE_EVIDENCE_INVALID", { metric });
    }
    result.set(sample.dimensions.participantId, sample);
  }
  if (result.size !== participantTotal) {
    throw invalid("Phase events are incomplete", "PHASE_EVIDENCE_INVALID", { metric });
  }
  return result;
}

function intervalPopulation(intervals) {
  const changes = new Map();
  let participantMilliseconds = 0;
  for (const { start, end } of intervals) {
    if (end < start) throw invalid("Participant phase interval is reversed", "PHASE_EVIDENCE_INVALID");
    if (end === start) continue;
    changes.set(start, (changes.get(start) ?? 0) + 1);
    changes.set(end, (changes.get(end) ?? 0) - 1);
    participantMilliseconds += end - start;
  }
  let concurrent = 0;
  let peak = 0;
  for (const time of [...changes.keys()].sort((left, right) => left - right)) {
    concurrent += changes.get(time);
    peak = Math.max(peak, concurrent);
  }
  return { peak, participantSeconds: participantMilliseconds / 1000 };
}

export function validateParticipantRawEvidence({ plan, rawResult, evidenceRooms, participantPhases, maxCollectorIntervalSeconds }) {
  requireExactKeys(participantPhases, ["lobby", "room"], "PARTICIPANT_PHASE_EVIDENCE_INVALID", "Participant phase schema is closed");
  if (!Array.isArray(evidenceRooms) || evidenceRooms.length !== plan.rooms.length) {
    throw invalid("Evidence must contain every planned room exactly once", "ROOM_EVIDENCE_INVALID");
  }
  const lobbyJoin = participantEventMap(rawResult, "phase.lobby.join", plan.totals.participants);
  const lobbyLeave = participantEventMap(rawResult, "phase.lobby.leave", plan.totals.participants);
  const roomJoin = participantEventMap(rawResult, "phase.room.join", plan.totals.participants);
  const roomLeave = participantEventMap(rawResult, "phase.room.leave", plan.totals.participants);
  const clientCollector = rawResult.collectors.find(collector => collector.name === "client");
  if (!clientCollector) {
    throw invalid("Client collector is required to anchor the plateau window", "COLLECTOR_EVIDENCE_MISSING");
  }
  const plateauStartMs = Date.parse(clientCollector.startedAt);
  const plateauEndMs = plateauStartMs + plan.workload.plateau.durationSeconds * 1000;
  const lobbyIntervals = [];
  const roomPlateauIntervals = [];
  const phaseValues = new Map();
  for (const participantId of lobbyJoin.keys()) {
    const lobbyStart = Date.parse(lobbyJoin.get(participantId).observedAt);
    const lobbyEnd = Date.parse(lobbyLeave.get(participantId).observedAt);
    const roomStart = Date.parse(roomJoin.get(participantId).observedAt);
    const roomEnd = Date.parse(roomLeave.get(participantId).observedAt);
    if (lobbyEnd !== roomStart || roomEnd < roomStart) {
      throw invalid("Lobby leave and room join events must form one real temporal handoff", "PHASE_EVIDENCE_INVALID");
    }
    const overlapStart = Math.max(roomStart, plateauStartMs);
    const overlapEnd = Math.min(roomEnd, plateauEndMs);
    lobbyIntervals.push({ start: lobbyStart, end: lobbyEnd });
    roomPlateauIntervals.push({ start: overlapStart, end: Math.max(overlapStart, overlapEnd) });
    const plateauSeries = (rawResult.byMetric.get("client.fpsP10") ?? [])
      .filter(sample => sample.dimensions.participantId === participantId &&
        Date.parse(sample.observedAt) >= plateauStartMs && Date.parse(sample.observedAt) <= plateauEndMs);
    phaseValues.set(participantId, {
      lobbySeconds: (lobbyEnd - lobbyStart) / 1000,
      plateauSeconds: Math.max(0, overlapEnd - overlapStart) / 1000,
      plateauSamples: plateauSeries.length
    });
  }
  const lobbyPopulation = intervalPopulation(lobbyIntervals);
  const roomPopulation = intervalPopulation(roomPlateauIntervals);
  const evidenceRoomMap = new Map(evidenceRooms.map(room => [room?.id, room]));
  if (evidenceRoomMap.size !== plan.rooms.length) throw invalid("Evidence room ids must be unique", "ROOM_EVIDENCE_INVALID");
  const byMetricParticipant = new Map();
  for (const metric of Object.keys(PARTICIPANT_EVIDENCE_METRICS)) {
    const metricSamples = rawResult.byMetric.get(metric) ?? [];
    const metricMap = new Map();
    for (const sample of metricSamples) {
      metricMap.set(sample.dimensions.participantId, sample);
    }
    if (metricSamples.length !== plan.totals.participants || metricMap.size !== plan.totals.participants) {
      throw invalid("Every participant aggregate requires one raw participant measurement", "PARTICIPANT_RAW_EVIDENCE_MISSING", { metric });
    }
    byMetricParticipant.set(metric, metricMap);
  }

  const minimumPlateauSamples = Math.max(
    2,
    Math.ceil(plan.workload.plateau.durationSeconds / maxCollectorIntervalSeconds) + 1
  );
  const safeRooms = [];
  const populationProvenance = { rooms: {}, phases: {} };
  let lobbyParticipantSeconds = 0;
  let roomParticipantSeconds = 0;
  let globalMinimumSamples = Number.POSITIVE_INFINITY;

  for (const plannedRoom of plan.rooms) {
    const room = evidenceRoomMap.get(plannedRoom.id);
    requireExactKeys(
      room,
      ["id", "finalUrl", "uniqueParticipants", "plateauPeak", "plateauSeconds", "plateauSamples", "plateauParticipantSeconds", "workers", "bots"],
      "ROOM_EVIDENCE_INVALID",
      "Room evidence schema is closed"
    );
    const workerMap = new Map((room.workers ?? []).map(worker => [worker?.id, worker]));
    if (workerMap.size !== plannedRoom.workers.length) throw invalid("Worker evidence ids must be unique", "WORKER_EVIDENCE_INVALID");
    const safeWorkers = [];
    const roomParticipantIds = [];
    const roomSampleIds = [];
    let roomParticipantSecondsValue = 0;
    let roomMinimumSamples = Number.POSITIVE_INFINITY;

    for (const plannedWorker of plannedRoom.workers) {
      const worker = workerMap.get(plannedWorker.id);
      requireExactKeys(
        worker,
        ["id", "uniqueParticipants", "participantIds", "plateauPeak", "plateauSamples", "plateauParticipantSeconds"],
        "WORKER_EVIDENCE_INVALID",
        "Worker evidence schema is closed"
      );
      const expectedIds = Array.from({ length: plannedWorker.participantCount }, (_, offset) =>
        `participant-${String(plannedWorker.participantStart + offset).padStart(6, "0")}`
      );
      roomParticipantIds.push(...expectedIds);
      if (!Array.isArray(worker.participantIds) || canonicalJson(worker.participantIds) !== canonicalJson(expectedIds)) {
        throw invalid("Worker participant identities do not match the plan", "WORKER_EVIDENCE_INVALID");
      }
      let workerSeconds = 0;
      let workerMinimumSamples = Number.POSITIVE_INFINITY;
      const workerSampleIds = [];
      for (const participantId of expectedIds) {
        const values = {};
        for (const metric of Object.keys(PARTICIPANT_EVIDENCE_METRICS)) {
          const sample = byMetricParticipant.get(metric).get(participantId);
          values[metric] = sample.value;
          workerSampleIds.push(sample.id);
        }
        if (
          values["client.lobbyJoined"] !== 1 || values["client.roomJoined"] !== 1 ||
          values["client.finalUrlMatched"] !== 1 ||
          values["client.lobbyPresenceSeconds"] !== phaseValues.get(participantId).lobbySeconds ||
          values["client.plateauPresenceSeconds"] !== phaseValues.get(participantId).plateauSeconds ||
          !Number.isInteger(values["client.plateauSampleCount"]) ||
          values["client.plateauSampleCount"] !== phaseValues.get(participantId).plateauSamples ||
          values["client.plateauSampleCount"] < minimumPlateauSamples ||
          !Number.isInteger(values["client.movementActionCount"]) ||
          values["client.movementActionCount"] < Math.max(
            1,
            Math.floor((plan.workload.plateau.durationSeconds - 1) / plan.workload.movement.intervalSeconds)
          )
        ) throw invalid("Participant did not prove lobby, room, final URL and complete plateau", "PARTICIPANT_RAW_EVIDENCE_INVALID");
        lobbyParticipantSeconds += values["client.lobbyPresenceSeconds"];
        workerSeconds += values["client.plateauPresenceSeconds"];
        workerMinimumSamples = Math.min(workerMinimumSamples, values["client.plateauSampleCount"]);
      }
      const workerPopulation = intervalPopulation(expectedIds.map(participantId => {
        const start = Math.max(Date.parse(roomJoin.get(participantId).observedAt), plateauStartMs);
        const end = Math.min(Date.parse(roomLeave.get(participantId).observedAt), plateauEndMs);
        return { start, end: Math.max(start, end) };
      }));
      const derivedWorker = {
        id: plannedWorker.id,
        uniqueParticipants: plannedWorker.participantCount,
        plateauPeak: workerPopulation.peak,
        plateauSamples: workerMinimumSamples,
        plateauParticipantSeconds: workerPopulation.participantSeconds
      };
      const claimedWorker = { ...worker };
      delete claimedWorker.participantIds;
      if (canonicalJson(claimedWorker) !== canonicalJson(derivedWorker)) {
        throw invalid("Worker aggregate does not equal raw participant measurements", "WORKER_EVIDENCE_INVALID");
      }
      safeWorkers.push(derivedWorker);
      roomParticipantSecondsValue += workerSeconds;
      roomMinimumSamples = Math.min(roomMinimumSamples, workerMinimumSamples);
      roomSampleIds.push(...workerSampleIds);
      populationProvenance.rooms[`${plannedRoom.id}/${plannedWorker.id}`] = [...new Set(workerSampleIds)];
    }
    const roomPopulationValue = intervalPopulation(roomParticipantIds.map(participantId => {
      const start = Math.max(Date.parse(roomJoin.get(participantId).observedAt), plateauStartMs);
      const end = Math.min(Date.parse(roomLeave.get(participantId).observedAt), plateauEndMs);
      return { start, end: Math.max(start, end) };
    }));
    const derivedRoom = {
      id: plannedRoom.id,
      finalUrl: plannedRoom.target,
      uniqueParticipants: plannedRoom.participantCount,
      plateauPeak: roomPopulationValue.peak,
      plateauSeconds: plan.workload.plateau.durationSeconds,
      plateauSamples: roomMinimumSamples,
      plateauParticipantSeconds: roomPopulationValue.participantSeconds,
      workers: safeWorkers,
      bots: room.bots
    };
    const claimedRoom = { ...room, workers: safeWorkers };
    if (canonicalJson(claimedRoom) !== canonicalJson(derivedRoom)) {
      throw invalid("Room aggregate does not equal raw participant measurements", "ROOM_EVIDENCE_INVALID");
    }
    safeRooms.push(derivedRoom);
    roomParticipantSeconds += roomPopulationValue.participantSeconds;
    globalMinimumSamples = Math.min(globalMinimumSamples, roomMinimumSamples);
    populationProvenance.rooms[plannedRoom.id] = [...new Set(roomSampleIds)];
  }

  const derivedPhases = {
    lobby: {
      peak: lobbyPopulation.peak,
      samples: lobbyJoin.size + lobbyLeave.size,
      participantSeconds: lobbyPopulation.participantSeconds
    },
    room: {
      peak: roomPopulation.peak,
      samples: globalMinimumSamples,
      participantSeconds: roomPopulation.participantSeconds
    }
  };
  if (canonicalJson(participantPhases) !== canonicalJson(derivedPhases)) {
    throw invalid("Participant phase aggregates do not equal raw participant measurements", "PARTICIPANT_PHASE_EVIDENCE_INVALID");
  }
  populationProvenance.phases.lobby = [
    ...(rawResult.byMetric.get("phase.lobby.join") ?? []),
    ...(rawResult.byMetric.get("phase.lobby.leave") ?? [])
  ].map(sample => sample.id);
  populationProvenance.phases.room = [
    ...(rawResult.byMetric.get("phase.room.join") ?? []),
    ...(rawResult.byMetric.get("phase.room.leave") ?? [])
  ].map(sample => sample.id);
  return { rooms: safeRooms, participantPhases: derivedPhases, provenance: populationProvenance };
}

export function provenanceContractCoverage(thresholds) {
  return {
    thresholdMetrics: Object.keys(METRIC_CONTRACTS),
    catalogueMetrics: Object.keys(thresholds.metrics),
    profileMetrics: Object.keys(PROFILE_METRICS),
    participantMetrics: Object.keys(PARTICIPANT_EVIDENCE_METRICS),
    modelMetrics: Object.keys(MODEL_OBSERVATION_METRICS)
  };
}

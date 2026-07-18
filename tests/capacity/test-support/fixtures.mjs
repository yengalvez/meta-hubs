import { createHash } from "node:crypto";
import { buildPlan } from "../lib/plan.mjs";
import {
  BOT_STATE_METRICS,
  METRIC_CONTRACTS,
  MODEL_OBSERVATION_METRICS,
  PARTICIPANT_EVIDENCE_METRICS,
  PHASE_EVENT_METRICS,
  PROFILE_METRICS,
  expectedCollectors,
  expectedThresholdMetrics,
  requiredRawContracts
} from "../lib/metric-contracts.mjs";
import {
  collectorCoverageWindow,
  deriveRawAggregate,
  makeRawSample,
  rawArtifact
} from "../lib/provenance.mjs";
import { signedDocumentBinding } from "../lib/trust.mjs";
import { signTestDocument } from "./trust.mjs";
import { trackedCollectorMappingIdentity } from "../lib/collector-contract.mjs";
import { OBSERVABILITY_METRIC_CONTRACTS } from "../lib/observability-contract.mjs";
import { canonicalJson } from "../lib/io.mjs";

export const TEST_RUN_ID = "11111111-1111-4111-8111-111111111111";
export const TEST_ISSUED_AT = "2026-07-17T09:55:00.000Z";
export const TEST_STARTED_AT = "2026-07-17T10:00:00.000Z";

export function makeTestEnvironment(
  collectorMappingSha256 = trackedCollectorMappingIdentity().sha256,
  overrides = {}
) {
  const unsigned = {
    schemaVersion: 1,
    capturedAt: TEST_ISSUED_AT,
    region: "test-region-1",
    nodePool: { sku: "s-4vcpu-8gb", nodeCount: 12 },
    replicas: { reticulum: 1, dialog: 2, coturn: 2 },
    deployment: {
      hubsCommit: "1".repeat(40),
      hubsImageDigest: `sha256:${"2".repeat(64)}`,
      hubsCloudCommit: "3".repeat(40),
      reticulumImageDigest: `sha256:${"4".repeat(64)}`,
      dialogImageDigest: `sha256:${"5".repeat(64)}`,
      coturnImageDigest: `sha256:${"6".repeat(64)}`,
      sceneId: "test-scene",
      collectorMappingSha256
    },
    ...overrides
  };
  return signTestDocument(unsigned, "environment-snapshot");
}

export function makeTestAttestation(
  target = "https://capacity-staging.example.org/{room}",
  {
    scenarioId = "local-smoke",
    executionEnabled = false,
    environment = makeTestEnvironment()
  } = {}
) {
  const origin = new URL(target.replaceAll("{room}", "room-001")).origin;
  const canonicalTarget = new URL(target.replaceAll("{room}", "capacity-room-placeholder"))
    .toString().replace("capacity-room-placeholder", "{room}");
  const environmentBinding = signedDocumentBinding(environment, "environment-snapshot");
  return signTestDocument({
    schemaVersion: 1,
    id: "capacity-staging-review",
    environment: "staging",
    approvedAt: "2026-07-17T09:00:00.000Z",
    expiresAt: "2026-08-01T09:00:00.000Z",
    reviewerId: "capacity-reviewer",
    targetOrigins: [origin],
    collectorEndpoints: ["https://collector-capacity-staging.example.org/v1/capacity-sample"],
    serviceOrigins: {
      hubs: [origin],
      reticulum: ["wss://reticulum-capacity-staging.example.org"],
      dialog: ["wss://dialog-capacity-staging.example.org"],
      assets: ["https://assets-capacity-staging.example.org"]
    },
    coturnUrls: ["turns:coturn-capacity-staging.example.org:5349"],
    planBinding: {
      scenarioId,
      targetTemplate: canonicalTarget,
      executionEnabled,
      environmentSha256: environmentBinding.sha256
    }
  }, "remote-attestation");
}

export function buildTestPlan({
  scenarios,
  scenarioId = "local-smoke",
  target,
  botsPerRoom = 0,
  clientProfile = "desktop",
  audioMode = "muted",
  transportMode = "direct",
  executionEnabled = false,
  environment,
  runId = TEST_RUN_ID,
  issuedAt = TEST_ISSUED_AT
}) {
  const scenario = scenarios.get(scenarioId);
  const effectiveTarget = target ??
    (scenario.roomCount > 1
      ? "https://capacity-staging.example.org/{room}"
      : "http://localhost:4000/test-room");
  const remote = !["localhost", "127.0.0.1", "::1"].includes(
    new URL(effectiveTarget.replaceAll("{room}", "room-001")).hostname.replace(/^\[|\]$/g, "")
  );
  const effectiveEnvironment = environment ?? ((remote || executionEnabled) ? makeTestEnvironment() : undefined);
  return buildPlan({
    scenario,
    target: effectiveTarget,
    botsPerRoom,
    clientProfile,
    audioMode,
    transportMode,
    executionEnabled,
    environment: effectiveEnvironment,
    ...(remote ? {
      attestation: makeTestAttestation(effectiveTarget, {
        scenarioId,
        executionEnabled,
        environment: effectiveEnvironment
      })
    } : {}),
    runId,
    issuedAt
  });
}

function schedule(startedAt, endedAt, intervalSeconds) {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  const values = [];
  for (let time = start; time <= end; time += intervalSeconds * 1000) values.push(new Date(time).toISOString());
  if (values.at(-1) !== endedAt) values.push(endedAt);
  return values;
}

function participants(plan) {
  const result = [];
  for (const room of plan.rooms) {
    for (const worker of room.workers) {
      for (let offset = 0; offset < worker.participantCount; offset += 1) {
        result.push({
          roomId: room.id,
          workerId: worker.id,
          participantId: `participant-${String(worker.participantStart + offset).padStart(6, "0")}`
        });
      }
    }
  }
  return result;
}

function dimensions(plan, collector, location = {}) {
  return {
    roomId: location.roomId ?? "all",
    workerId: location.workerId ?? "all",
    participantId: location.participantId ?? "all",
    service: collector === "client" ? "hubs-client" : collector,
    instance: location.instance ?? (collector === "client" || collector === "webrtc" ? location.workerId : "fixture-1"),
    clientProfile: plan.scenario.clientProfile,
    audioMode: plan.scenario.audioMode,
    transportMode: plan.scenario.transportMode,
    phase: location.phase ?? "plateau"
  };
}

function passingMetric(rule) {
  if (Object.hasOwn(rule, "min")) return rule.min;
  if (rule.unit === "count") return 0;
  if (rule.max === 0) return 0;
  return rule.max / 2;
}

export function makePassingEvidence(plan, thresholds, { startedAt = TEST_STARTED_AT, modelOffset = 0 } = {}) {
  const endedAt = new Date(Date.parse(startedAt) + plan.scenario.durationSeconds * 1000).toISOString();
  const timestampSet = new Set(schedule(startedAt, endedAt, thresholds.maxCollectorIntervalSeconds));
  const clientCoverageStartedAt = new Date(
    Date.parse(startedAt) + plan.workload.rampUp.durationSeconds * 1000
  ).toISOString();
  const plateauEndedAt = new Date(
    Date.parse(clientCoverageStartedAt) + plan.workload.plateau.durationSeconds * 1000
  ).toISOString();
  const clientTimestampSet = new Set(schedule(
    clientCoverageStartedAt,
    plateauEndedAt,
    thresholds.maxCollectorIntervalSeconds
  ));
  for (let offset = plan.workload.movement.intervalSeconds;
    offset < plan.workload.plateau.durationSeconds;
    offset += plan.workload.movement.intervalSeconds) {
    clientTimestampSet.add(new Date(Date.parse(clientCoverageStartedAt) + offset * 1000).toISOString());
  }
  timestampSet.add(clientCoverageStartedAt);
  timestampSet.add(plateauEndedAt);
  for (let offset = plan.workload.movement.intervalSeconds;
    offset < plan.workload.plateau.durationSeconds;
    offset += plan.workload.movement.intervalSeconds) {
    timestampSet.add(new Date(Date.parse(clientCoverageStartedAt) + offset * 1000).toISOString());
  }
  const timestamps = [...timestampSet].sort();
  const clientTimestamps = [...clientTimestampSet].sort();
  const plateauSamples = clientTimestamps.length;
  const participantList = participants(plan);
  const contracts = requiredRawContracts(plan, thresholds);
  const rawSamples = [];
  const phaseAt = observedAt => {
    const value = Date.parse(observedAt);
    if (value < Date.parse(clientCoverageStartedAt)) return "ramp-up";
    if (value <= Date.parse(plateauEndedAt)) return "plateau";
    return "ramp-down";
  };
  const add = (collector, metric, value, observedAt, location = {}) => rawSamples.push(makeRawSample({
    runId: plan.run.id,
    collector,
    metric,
    value,
    observedAt,
    dimensions: dimensions(plan, collector, { ...location, phase: location.phase ?? phaseAt(observedAt) }),
    source: { kind: "fixture", sourceObservedAt: observedAt }
  }));

  for (const [name, contract] of Object.entries(contracts)) {
    if (Object.hasOwn(PROFILE_METRICS, name) || Object.hasOwn(PARTICIPANT_EVIDENCE_METRICS, name) ||
        Object.hasOwn(BOT_STATE_METRICS, name) ||
        Object.hasOwn(PHASE_EVENT_METRICS, name) ||
        Object.hasOwn(MODEL_OBSERVATION_METRICS, name)) continue;
    const rule = thresholds.metrics[name];
    const value = name === "generator.processCount" ? 20
      : name === "generator.browserProcessCount" ? 1
        : name === "generator.memoryUtilization" ? 0.25
        : passingMetric(rule);
    const locations = contract.collector === "client" || contract.collector === "webrtc"
      ? participantList
        : contract.collector === "bots"
        ? plan.rooms.map(room => ({ roomId: room.id }))
        : contract.collector === "generator"
          ? plan.executionTopology.hosts.map(host => ({ instance: host.id }))
        : [{}];
    const clientSide = contract.collector === "client" || contract.collector === "webrtc";
    const times = contract.sampling === "event"
      ? [clientSide ? clientCoverageStartedAt : startedAt]
      : clientSide ? clientTimestamps : timestamps;
    for (const observedAt of times) {
      const semanticType = OBSERVABILITY_METRIC_CONTRACTS[name]?.metricType;
      for (const location of locations) {
        const emptyBotAppearance = name === "bots.appearanceP95Ms" &&
          plan.rooms.some(room => room.id === location.roomId && room.bots === 0);
        const effectiveValue = emptyBotAppearance ||
            (["counter", "throughput", "histogram", "ratio"].includes(semanticType) && observedAt === startedAt)
          ? 0
          : value;
        add(contract.collector, name, effectiveValue, observedAt, location);
      }
    }
  }

  const profileValues = {
    "client.profileMobile": plan.scenario.clientProfile === "mobile" ? 1 : 0,
    "client.audioTrackActive": plan.scenario.audioMode === "active" ? 1 : 0,
    "webrtc.selectedCandidateRelay": plan.scenario.transportMode === "forced-turn" ? 1 : 0,
    "webrtc.iceServerAttestationValid": 1
  };
  for (const [name, value] of Object.entries(profileValues)) {
    const contract = PROFILE_METRICS[name];
    for (const participant of participantList) {
      add(contract.collector, name, value, clientCoverageStartedAt, participant);
    }
  }

  const lobbyJoinedAt = new Date(
    Date.parse(startedAt) + plan.workload.rampUp.durationSeconds * 500
  ).toISOString();
  for (const participant of participantList) {
    add("client", "phase.lobby.join", 1, lobbyJoinedAt, { ...participant, phase: "lobby" });
    add("client", "phase.lobby.leave", 1, clientCoverageStartedAt, { ...participant, phase: "lobby" });
    add("client", "phase.room.join", 1, clientCoverageStartedAt, { ...participant, phase: "plateau" });
    add("client", "phase.room.leave", 1, endedAt, { ...participant, phase: "ramp-down" });
  }

  const participantEvidenceValues = {
    "client.lobbyJoined": 1,
    "client.roomJoined": 1,
    "client.lobbyPresenceSeconds": plan.workload.rampUp.durationSeconds / 2,
    "client.plateauPresenceSeconds": plan.workload.plateau.durationSeconds,
    "client.plateauSampleCount": plateauSamples,
    "client.finalUrlMatched": 1,
    "client.movementActionCount": Math.max(
      1,
      Math.floor((plan.workload.plateau.durationSeconds - 1) / plan.workload.movement.intervalSeconds)
    )
  };
  for (const [name, value] of Object.entries(participantEvidenceValues)) {
    for (const participant of participantList) add("client", name, value, endedAt, participant);
  }

  const modelValues = {
    "model.nodeCpuMillicores": 4000,
    "model.nodeMemoryMiB": 8192,
    "model.usedCpuMillicores": 800 + plan.totals.participants * 8 + modelOffset,
    "model.usedMemoryMiB": 1500 + plan.totals.participants * 10 + modelOffset
  };
  for (const [name, value] of Object.entries(modelValues)) {
    for (const observedAt of timestamps) add("kubernetes", name, value, observedAt, {});
  }

  for (const room of plan.rooms) {
    for (const name of Object.keys(BOT_STATE_METRICS)) {
      for (const observedAt of timestamps) add("bots", name, room.bots, observedAt, { roomId: room.id });
    }
  }

  rawSamples.sort((left, right) =>
    Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.id.localeCompare(right.id)
  );
  const metrics = {};
  for (const name of expectedThresholdMetrics(plan, thresholds)) {
    const metricSamples = rawSamples.filter(sample => sample.metric === name);
    metrics[name] = deriveRawAggregate(metricSamples, METRIC_CONTRACTS[name].aggregation, thresholds.metrics[name]);
  }
  const collectors = expectedCollectors(plan, thresholds).map(name => {
    const collectorSamples = rawSamples.filter(sample => sample.collector === name);
    const coverage = collectorCoverageWindow(plan, { startedAt, endedAt }, name);
    return {
      name,
      status: "complete",
      samples: collectorSamples.length,
      coverageSeconds: coverage.coverageSeconds,
      startedAt: coverage.startedAt,
      endedAt: coverage.endedAt,
      runId: plan.run.id
    };
  });

  return {
    schemaVersion: 1,
    planId: plan.planId,
    driverState: "completed",
    run: {
      id: plan.run.id,
      issuedAt: plan.run.issuedAt,
      startedAt,
      endedAt,
      driver: {
        name: "protocol-fixture-driver",
        version: "0.1.0",
        sha256: "0".repeat(64),
        protocol: plan.runtime.driverProtocol,
        nodeVersion: "v22.11.0"
      },
      browser: {
        name: "chromium",
        version: "126.0.6478.0",
        profile: plan.runtime.browserProfile
      }
    },
    collectorMapping: trackedCollectorMappingIdentity(),
    collectors,
    participantPhases: {
      lobby: {
        peak: plan.totals.participants,
        samples: plan.totals.participants * 2,
        participantSeconds: plan.totals.participants * plan.workload.rampUp.durationSeconds / 2
      },
      room: {
        peak: plan.totals.participants,
        samples: plateauSamples,
        participantSeconds: plan.totals.participants * plan.workload.plateau.durationSeconds
      }
    },
    rooms: plan.rooms.map(room => ({
      id: room.id,
      finalUrl: room.target,
      uniqueParticipants: room.participantCount,
      plateauPeak: room.participantCount,
      plateauSeconds: plan.workload.plateau.durationSeconds,
      plateauSamples,
      plateauParticipantSeconds: room.participantCount * plan.workload.plateau.durationSeconds,
      bots: room.bots === 0
        ? {
            state: "observed", desired: 0, active: 0, authenticated: 0,
            spawnAcknowledged: 0, navmeshReady: 0
          }
        : {
            state: "observed", desired: room.bots, active: room.bots,
            authenticated: room.bots, spawnAcknowledged: room.bots, navmeshReady: room.bots
          },
      workers: room.workers.map(worker => ({
        id: worker.id,
        uniqueParticipants: worker.participantCount,
        participantIds: Array.from({ length: worker.participantCount }, (_, offset) =>
          `participant-${String(worker.participantStart + offset).padStart(6, "0")}`
        ),
        plateauPeak: worker.participantCount,
        plateauSamples,
        plateauParticipantSeconds: worker.participantCount * plan.workload.plateau.durationSeconds
      }))
    })),
    metrics,
    raw: {
      format: "yenhubs-capacity-ndjson-v3",
      artifact: rawArtifact(rawSamples),
      samples: rawSamples
    }
  };
}

export function makePhysicalGeneratorInventory(plan, run) {
  return {
    schemaVersion: 1,
    planId: plan.planId,
    runId: plan.run.id,
    observedAt: run.endedAt,
    hosts: plan.executionTopology.hosts.map((host, index) => ({
      hostId: host.id,
      machineId: `machine-${String(index + 1).padStart(8, "0")}`,
      bootId: `boot-id-${String(index + 1).padStart(8, "0")}`,
      cgroupPath: `/yenhubs-capacity/${plan.run.id}/${host.id}`,
      rootPid: 4200 + index,
      liveDescendantCountAfterStop: 0,
      liveBrowserCountAfterStop: 0
    }))
  };
}

export function setRawThresholdMetric(evidence, thresholds, metric, valueOrFunction) {
  setRawMetricValues(evidence, metric, valueOrFunction);
  const samples = evidence.raw.samples.filter(sample => sample.metric === metric);
  evidence.metrics[metric] = deriveRawAggregate(samples, METRIC_CONTRACTS[metric].aggregation, thresholds.metrics[metric]);
  return evidence;
}

export function setRawMetricValues(evidence, metric, valueOrFunction) {
  let metricIndex = 0;
  evidence.raw.samples = evidence.raw.samples.map(sample => {
    if (sample.metric !== metric) return sample;
    const value = typeof valueOrFunction === "function"
      ? valueOrFunction(sample.value, metricIndex++, sample)
      : valueOrFunction;
    return makeRawSample({
      runId: sample.runId,
      collector: sample.collector,
      metric: sample.metric,
      value,
      observedAt: sample.observedAt,
      dimensions: sample.dimensions,
      source: sample.source
    });
  });
  evidence.raw.samples.sort((left, right) =>
    Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.id.localeCompare(right.id)
  );
  evidence.raw.artifact = rawArtifact(evidence.raw.samples);
  return evidence;
}

export function refreshRawArtifact(evidence) {
  evidence.raw.artifact = rawArtifact(evidence.raw.samples);
  return evidence;
}

function semanticProofForValue({
  metric,
  value,
  observedAt,
  run,
  labels,
  intervalSeconds = 15,
  intervalStartedAt,
  histogramShapeValue = value,
  inventory = [labels],
  counterPrevious = 0
}) {
  const metricType = OBSERVABILITY_METRIC_CONTRACTS[metric]?.metricType;
  const observedAtMs = Date.parse(observedAt);
  const windowStartedAt = intervalStartedAt ?? new Date(Math.max(
    Date.parse(run.startedAt), observedAtMs - intervalSeconds * 1000
  )).toISOString();
  const windowStartOffsetSeconds = (Date.parse(windowStartedAt) - Date.parse(run.startedAt)) / 1000;
  const windowEndOffsetSeconds = (observedAtMs - Date.parse(run.startedAt)) / 1000;
  const intervalDurationSeconds = (observedAtMs - Date.parse(windowStartedAt)) / 1000;
  let series;
  if (["counter", "throughput"].includes(metricType)) {
    series = [{
      labels,
      previousObservedAt: windowStartedAt,
      currentObservedAt: observedAt,
      previous: counterPrevious,
      current: counterPrevious + (intervalDurationSeconds === 0
        ? 0
        : metricType === "throughput" ? value * intervalDurationSeconds : value),
      resets: 0
    }];
  } else if (metricType === "histogram") {
    const upper = histogramShapeValue === 0 ? 0 : histogramShapeValue / 0.95;
    const observationsPerSecond = histogramShapeValue === 0 ? 0 : 100;
    const previousCount = windowStartOffsetSeconds * observationsPerSecond;
    const currentCount = windowEndOffsetSeconds * observationsPerSecond;
    series = [{
      labels,
      previousObservedAt: windowStartedAt,
      currentObservedAt: observedAt,
      buckets: [
        { le: upper, previous: previousCount, current: currentCount, resets: 0 },
        { le: "+Inf", previous: previousCount, current: currentCount, resets: 0 }
      ]
    }];
  } else if (metricType === "ratio") {
    series = [{
      labels,
      previousObservedAt: windowStartedAt,
      currentObservedAt: observedAt,
      previousNumerator: value * windowStartOffsetSeconds,
      currentNumerator: value * windowEndOffsetSeconds,
      numeratorResets: 0,
      previousDenominator: windowStartOffsetSeconds,
      currentDenominator: windowEndOffsetSeconds,
      denominatorResets: 0
    }];
  } else if (metricType === "utilization") {
    series = [{ labels, currentObservedAt: observedAt, numerator: value, denominator: 1 }];
  } else if (metricType === "authoritativeState") {
    series = inventory.map((identity, index) => ({
      labels: identity,
      currentObservedAt: observedAt,
      value: index < value ? 1 : 0
    }));
  } else {
    series = [{ labels, currentObservedAt: observedAt, value }];
  }
  return {
    metricType,
    windowStartedAt,
    windowEndedAt: observedAt,
    resetObserved: false,
    certified: false,
    series
  };
}

export function promoteFixtureEvidenceToPhysical(plan, evidence) {
  const promoted = structuredClone(evidence);
  const lastIntervalTimestamp = new Map();
  const lastCounterValue = new Map();
  const histogramShapeValues = new Map();
  for (const sample of promoted.raw.samples) {
    if (OBSERVABILITY_METRIC_CONTRACTS[sample.metric]?.metricType !== "histogram") continue;
    const key = `${sample.metric}/${sample.dimensions.roomId}`;
    histogramShapeValues.set(key, Math.max(histogramShapeValues.get(key) ?? 0, sample.value));
  }
  promoted.run.driver = {
    ...promoted.run.driver,
    name: "yenhubs-playwright-capacity",
    version: "1.0.0",
    sha256: "d".repeat(64)
  };
  promoted.raw.samples = promoted.raw.samples.map(sample => {
    let source;
    if (sample.metric === "webrtc.iceServerAttestationValid") {
      source = {
        kind: "browser-ice",
        sourceObservedAt: sample.observedAt,
        iceServerUrls: plan.security.coturnUrls
      };
    } else if (sample.collector === "client" || sample.collector === "webrtc") {
      source = { kind: "browser", sourceObservedAt: sample.observedAt };
    } else if (sample.metric === "generator.eventLoopLagP95Ms") {
      source = {
        kind: "host-event-loop",
        sourceObservedAt: sample.observedAt,
        measurementSource: "node-perf-hooks-monitor-event-loop-delay-v1",
        rootPid: 4242
      };
    } else if (sample.collector === "generator") {
      source = {
        kind: "host-process-tree",
        sourceObservedAt: sample.observedAt,
        measurementSource: "ps-process-tree-v1",
        rootPid: 4242,
        processCount: 20,
        browserRootProcessCount: 1,
        cpuPercent: 340,
        rssBytes: 2048 * 1024 ** 2,
        systemCpuCount: 8,
        totalMemoryBytes: 8192 * 1024 ** 2
      };
    } else {
      const mapping = promoted.collectorMapping.configuration.metrics[sample.metric];
      const inventory = promoted.collectorMapping.configuration.seriesInventory[sample.metric];
      const labels = inventory[0];
      const metricType = OBSERVABILITY_METRIC_CONTRACTS[sample.metric]?.metricType;
      const intervalScope = `${sample.metric}/${sample.dimensions.roomId}/${canonicalJson(labels)}`;
      const intervalStartedAt = ["counter", "throughput", "histogram", "ratio"].includes(metricType)
        ? lastIntervalTimestamp.get(intervalScope) ?? promoted.run.startedAt
        : undefined;
      const semanticProof = semanticProofForValue({
        metric: sample.metric,
        value: sample.value,
        observedAt: sample.observedAt,
        run: promoted.run,
        labels,
        intervalSeconds: promoted.collectorMapping.configuration.maxSampleAgeSeconds / 2,
        intervalStartedAt,
        histogramShapeValue: histogramShapeValues.get(`${sample.metric}/${sample.dimensions.roomId}`),
        inventory,
        counterPrevious: lastCounterValue.get(intervalScope) ?? 0
      });
      source = {
        kind: "prometheus",
        mappingSha256: promoted.collectorMapping.sha256,
        sourceMetric: mapping.sourceMetric,
        querySha256: mapping.querySha256,
        sourceObservedAt: sample.observedAt,
        inventorySha256: createHash("sha256")
          .update(canonicalJson(promoted.collectorMapping.configuration.seriesInventory))
          .digest("hex"),
        semanticProof
      };
      if (intervalStartedAt !== undefined) lastIntervalTimestamp.set(intervalScope, sample.observedAt);
      if (["counter", "throughput"].includes(metricType)) {
        lastCounterValue.set(intervalScope, semanticProof.series[0].current);
      }
    }
    return makeRawSample({
      runId: sample.runId,
      collector: sample.collector,
      metric: sample.metric,
      value: sample.value,
      observedAt: sample.observedAt,
      dimensions: source.kind === "prometheus"
        ? { ...sample.dimensions, instance: `${promoted.collectorMapping.configuration.metrics[sample.metric].service}-aggregate` }
        : sample.dimensions,
      source
    });
  }).sort((left, right) =>
    Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.id.localeCompare(right.id)
  );
  promoted.raw.artifact = rawArtifact(promoted.raw.samples);
  return promoted;
}

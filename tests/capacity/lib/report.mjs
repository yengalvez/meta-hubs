import { invalid } from "./errors.mjs";
import { valueMatchesUnit, violates } from "./stop-monitor.mjs";

const FAILED_CODES = new Set(["driver-failed", "protocol-failed", "cancelled"]);

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function requireExactKeys(value, expected, message) {
  if (!exactKeys(value, expected)) throw invalid(message, "EVIDENCE_SCHEMA_INVALID");
}

function parseCanonicalIso(value) {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) return null;
  return milliseconds;
}

function safeRule(rule) {
  return {
    ...(Object.hasOwn(rule, "min") ? { min: rule.min } : { max: rule.max }),
    unit: rule.unit,
    stop: true,
    ...(rule.sustainedMs ? { sustainedMs: rule.sustainedMs } : {})
  };
}

function validateRun(plan, run) {
  requireExactKeys(run, ["id", "issuedAt", "startedAt", "endedAt", "driver", "browser"], "Run evidence schema is closed");
  requireExactKeys(
    run.driver,
    ["name", "version", "sha256", "protocol", "nodeVersion"],
    "Driver identity schema is closed"
  );
  requireExactKeys(run.browser, ["name", "version", "profile"], "Browser identity schema is closed");

  const issuedAtMs = parseCanonicalIso(run.issuedAt);
  const startedAtMs = parseCanonicalIso(run.startedAt);
  const endedAtMs = parseCanonicalIso(run.endedAt);
  const planIssuedAtMs = parseCanonicalIso(plan.run.issuedAt);
  const startDeadlineMs = parseCanonicalIso(plan.run.startDeadlineAt);
  const validDriver =
    typeof run.driver.name === "string" &&
    /^[a-z0-9][a-z0-9-]{2,63}$/.test(run.driver.name) &&
    typeof run.driver.version === "string" &&
    /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(run.driver.version) &&
    typeof run.driver.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(run.driver.sha256) &&
    run.driver.protocol === plan.runtime.driverProtocol &&
    typeof run.driver.nodeVersion === "string" &&
    /^v22\.\d+\.\d+$/.test(run.driver.nodeVersion);
  const validBrowser =
    run.browser.name === "chromium" &&
    typeof run.browser.version === "string" &&
    /^\d+(?:\.\d+){1,3}$/.test(run.browser.version) &&
    run.browser.profile === plan.runtime.browserProfile;
  const validWindow =
    run.id === plan.run.id &&
    run.issuedAt === plan.run.issuedAt &&
    issuedAtMs === planIssuedAtMs &&
    startedAtMs !== null &&
    endedAtMs !== null &&
    startedAtMs >= issuedAtMs &&
    startedAtMs <= startDeadlineMs &&
    endedAtMs - startedAtMs === plan.scenario.durationSeconds * 1000;
  if (!validDriver || !validBrowser || !validWindow) {
    throw invalid("Run window or driver/browser identity does not match the plan", "RUN_EVIDENCE_INVALID");
  }

  return {
    id: plan.run.id,
    issuedAt: plan.run.issuedAt,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    driver: {
      name: run.driver.name,
      version: run.driver.version,
      sha256: run.driver.sha256,
      protocol: run.driver.protocol,
      nodeVersion: run.driver.nodeVersion
    },
    browser: {
      name: run.browser.name,
      version: run.browser.version,
      profile: run.browser.profile
    }
  };
}

function validateCollector(collector, plan, run, maxCollectorIntervalSeconds) {
  if (!exactKeys(collector, ["name", "status", "samples", "coverageSeconds", "startedAt", "endedAt", "runId"])) {
    return false;
  }
  const minimumSamples = Math.max(
    2,
    Math.ceil(plan.scenario.durationSeconds / maxCollectorIntervalSeconds) + 1
  );
  return (
    collector.status === "complete" &&
    collector.runId === plan.run.id &&
    Number.isInteger(collector.samples) &&
    collector.samples >= minimumSamples &&
    collector.coverageSeconds === plan.scenario.durationSeconds &&
    collector.startedAt === run.startedAt &&
    collector.endedAt === run.endedAt
  );
}

function expectedParticipantIds(worker) {
  return Array.from({ length: worker.participantCount }, (_, offset) =>
    `participant-${String(worker.participantStart + offset).padStart(6, "0")}`
  );
}

function validateRoomEvidence(plan, evidenceRooms, maxCollectorIntervalSeconds) {
  if (!Array.isArray(evidenceRooms) || evidenceRooms.length !== plan.rooms.length) {
    throw invalid("Evidence must contain every planned room exactly once", "ROOM_EVIDENCE_INVALID");
  }
  const roomMap = new Map(evidenceRooms.map(room => [room?.id, room]));
  if (roomMap.size !== plan.rooms.length) {
    throw invalid("Evidence room ids must be unique", "ROOM_EVIDENCE_INVALID");
  }
  const globalParticipants = new Set();
  const safeRooms = [];
  const minimumPlateauSamples = Math.max(
    2,
    Math.ceil(plan.workload.plateau.durationSeconds / maxCollectorIntervalSeconds) + 1
  );

  for (const plannedRoom of plan.rooms) {
    const room = roomMap.get(plannedRoom.id);
    requireExactKeys(
      room,
      [
        "id",
        "finalUrl",
        "uniqueParticipants",
        "plateauPeak",
        "plateauSeconds",
        "plateauSamples",
        "plateauParticipantSeconds",
        "workers"
      ],
      "Room evidence schema is closed"
    );
    if (
      room.id !== plannedRoom.id ||
      room.finalUrl !== plannedRoom.target ||
      room.uniqueParticipants !== plannedRoom.participantCount ||
      room.plateauPeak !== plannedRoom.participantCount ||
      room.plateauSeconds !== plan.workload.plateau.durationSeconds ||
      !Number.isInteger(room.plateauSamples) ||
      room.plateauSamples < minimumPlateauSamples ||
      room.plateauParticipantSeconds !== plannedRoom.participantCount * plan.workload.plateau.durationSeconds ||
      !Array.isArray(room.workers) ||
      room.workers.length !== plannedRoom.workers.length
    ) {
      throw invalid("Room evidence does not match the planned URL, population or plateau", "ROOM_EVIDENCE_INVALID");
    }

    const workerMap = new Map(room.workers.map(worker => [worker?.id, worker]));
    if (workerMap.size !== plannedRoom.workers.length) {
      throw invalid("Worker evidence ids must be unique within each room", "WORKER_EVIDENCE_INVALID");
    }
    const safeWorkers = [];
    for (const plannedWorker of plannedRoom.workers) {
      const worker = workerMap.get(plannedWorker.id);
      requireExactKeys(
        worker,
        [
          "id",
          "uniqueParticipants",
          "participantIds",
          "plateauPeak",
          "plateauSamples",
          "plateauParticipantSeconds"
        ],
        "Worker evidence schema is closed"
      );
      const expectedIds = expectedParticipantIds(plannedWorker);
      const validIds =
        Array.isArray(worker.participantIds) &&
        worker.participantIds.length === expectedIds.length &&
        worker.participantIds.every((id, index) => id === expectedIds[index] && !globalParticipants.has(id));
      if (
        worker.id !== plannedWorker.id ||
        worker.uniqueParticipants !== plannedWorker.participantCount ||
        worker.plateauPeak !== plannedWorker.participantCount ||
        !Number.isInteger(worker.plateauSamples) ||
        worker.plateauSamples < minimumPlateauSamples ||
        worker.plateauParticipantSeconds !== plannedWorker.participantCount * plan.workload.plateau.durationSeconds ||
        !validIds
      ) {
        throw invalid("Worker evidence does not match its planned unique participants or plateau", "WORKER_EVIDENCE_INVALID");
      }
      for (const id of worker.participantIds) globalParticipants.add(id);
      safeWorkers.push({
        id: plannedWorker.id,
        uniqueParticipants: worker.uniqueParticipants,
        plateauPeak: worker.plateauPeak,
        plateauSamples: worker.plateauSamples,
        plateauParticipantSeconds: worker.plateauParticipantSeconds
      });
    }
    safeRooms.push({
      id: plannedRoom.id,
      finalUrl: plannedRoom.target,
      uniqueParticipants: room.uniqueParticipants,
      plateauPeak: room.plateauPeak,
      plateauSeconds: room.plateauSeconds,
      plateauSamples: room.plateauSamples,
      plateauParticipantSeconds: room.plateauParticipantSeconds,
      workers: safeWorkers
    });
  }
  if (globalParticipants.size !== plan.totals.participants) {
    throw invalid("Participant identities must be unique across every room and worker", "ROOM_EVIDENCE_INVALID");
  }
  return safeRooms;
}

function validateParticipantPhases(plan, participantPhases, maxCollectorIntervalSeconds) {
  requireExactKeys(participantPhases, ["lobby", "room"], "Participant phase schema is closed");
  const minimumSamples = Math.max(
    2,
    Math.ceil(plan.scenario.durationSeconds / maxCollectorIntervalSeconds) + 1
  );
  const safePhases = {};
  for (const name of ["lobby", "room"]) {
    const phase = participantPhases[name];
    requireExactKeys(phase, ["peak", "samples", "participantSeconds"], "Participant phase entry schema is closed");
    const valid =
      Number.isInteger(phase.peak) &&
      phase.peak >= 0 &&
      phase.peak <= plan.totals.participants &&
      Number.isInteger(phase.samples) &&
      phase.samples >= minimumSamples &&
      typeof phase.participantSeconds === "number" &&
      Number.isFinite(phase.participantSeconds) &&
      phase.participantSeconds >= 0 &&
      phase.participantSeconds <= plan.totals.participants * plan.scenario.durationSeconds;
    if (!valid) {
      throw invalid("Lobby and room phase evidence must cover the run with plausible counts", "PARTICIPANT_PHASE_EVIDENCE_INVALID");
    }
    safePhases[name] = {
      peak: phase.peak,
      samples: phase.samples,
      participantSeconds: phase.participantSeconds
    };
  }
  if (
    participantPhases.room.peak !== plan.totals.participants ||
    participantPhases.room.participantSeconds <
      plan.totals.participants * plan.workload.plateau.durationSeconds
  ) {
    throw invalid("Every participant must enter and remain for the complete plateau", "PARTICIPANT_PHASE_EVIDENCE_INVALID", {
      expectedRoomPeak: plan.totals.participants
    });
  }
  return safePhases;
}

export function buildReport({ plan, evidence, thresholds }) {
  if (!plan || plan.state !== "PLANNED" || plan.run?.executionEnabled !== false) {
    throw invalid("Report requires a validated disabled-execution plan", "PLAN_REQUIRED");
  }
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) || evidence.schemaVersion !== 1) {
    throw invalid("Evidence schemaVersion must equal 1", "EVIDENCE_INVALID");
  }
  if (evidence.planId !== plan.planId) {
    throw invalid("Evidence planId does not match the requested plan", "EVIDENCE_PLAN_MISMATCH");
  }
  if (evidence.driverState === "failed") {
    requireExactKeys(
      evidence,
      ["schemaVersion", "planId", "driverState", "runId", "failureCode"],
      "Failed evidence schema is closed"
    );
    if (evidence.runId !== plan.run.id || !FAILED_CODES.has(evidence.failureCode)) {
      throw invalid("Failed evidence is not bound to this run", "RUN_EVIDENCE_INVALID");
    }
    return {
      schemaVersion: 1,
      state: "FAILED",
      planId: plan.planId,
      runId: plan.run.id,
      reason: "capacity driver reported failure",
      certified: false
    };
  }
  requireExactKeys(
    evidence,
    ["schemaVersion", "planId", "driverState", "run", "collectors", "participantPhases", "rooms", "metrics"],
    "Completed evidence schema is closed"
  );
  if (evidence.driverState !== "completed") {
    throw invalid("Evidence driverState must be completed or failed", "EVIDENCE_INVALID");
  }

  const safeRun = validateRun(plan, evidence.run);
  if (!Array.isArray(evidence.collectors) || evidence.collectors.length !== thresholds.requiredCollectors.length) {
    throw invalid("Evidence collectors must exactly match the required set", "COLLECTOR_EVIDENCE_MISSING");
  }
  const collectorNames = evidence.collectors.map(collector => collector?.name);
  if (new Set(collectorNames).size !== collectorNames.length) {
    throw invalid("Evidence collector names must be unique", "EVIDENCE_INVALID");
  }
  const collectorMap = new Map(evidence.collectors.map(collector => [collector?.name, collector]));
  const invalidCollectors = thresholds.requiredCollectors.filter(name =>
    !validateCollector(collectorMap.get(name), plan, safeRun, thresholds.maxCollectorIntervalSeconds)
  );
  if (invalidCollectors.length) {
    throw invalid("Every required collector must cover the same run window", "COLLECTOR_EVIDENCE_MISSING", {
      invalidCollectors
    });
  }

  const safePhases = validateParticipantPhases(
    plan,
    evidence.participantPhases,
    thresholds.maxCollectorIntervalSeconds
  );
  const safeRooms = validateRoomEvidence(plan, evidence.rooms, thresholds.maxCollectorIntervalSeconds);
  const expectedMetricNames = Object.keys(thresholds.metrics);
  if (!exactKeys(evidence.metrics, expectedMetricNames)) {
    throw invalid("Metric evidence must contain exactly the tracked metrics", "METRIC_EVIDENCE_MISSING");
  }

  const invalidMetrics = [];
  const breaches = [];
  const evaluatedMetrics = {};
  for (const [metric, rule] of Object.entries(thresholds.metrics)) {
    const rawValue = evidence.metrics[metric];
    if (rule.sustainedMs) {
      const validSustainedEvidence =
        exactKeys(rawValue, ["peakValue", "maxBreachDurationMs"]) &&
        valueMatchesUnit(rawValue.peakValue, rule.unit) &&
        Number.isInteger(rawValue.maxBreachDurationMs) &&
        rawValue.maxBreachDurationMs >= 0 &&
        rawValue.maxBreachDurationMs <= plan.scenario.durationSeconds * 1000;
      if (!validSustainedEvidence) {
        invalidMetrics.push(metric);
        continue;
      }
      const peakViolates = violates(rawValue.peakValue, rule);
      if (!peakViolates && rawValue.maxBreachDurationMs > 0) {
        invalidMetrics.push(metric);
        continue;
      }
      evaluatedMetrics[metric] = {
        peakValue: rawValue.peakValue,
        maxBreachDurationMs: rawValue.maxBreachDurationMs
      };
      if (peakViolates && rawValue.maxBreachDurationMs >= rule.sustainedMs) {
        breaches.push({
          metric,
          value: rawValue.peakValue,
          maxBreachDurationMs: rawValue.maxBreachDurationMs,
          rule: safeRule(rule)
        });
      }
      continue;
    }
    if (!valueMatchesUnit(rawValue, rule.unit)) {
      invalidMetrics.push(metric);
      continue;
    }
    evaluatedMetrics[metric] = rawValue;
    if (violates(rawValue, rule)) {
      breaches.push({ metric, value: rawValue, rule: safeRule(rule) });
    }
  }
  if (invalidMetrics.length) {
    throw invalid("Every stop metric requires valid finite evidence", "METRIC_EVIDENCE_MISSING", {
      invalidMetrics
    });
  }

  return {
    schemaVersion: 1,
    state: breaches.length ? "STOPPED" : "PASSED",
    planId: plan.planId,
    run: safeRun,
    scenarioId: plan.scenario.id,
    certified: false,
    provisionalThresholds: thresholds.provisional,
    totals: { ...plan.totals },
    collectors: thresholds.requiredCollectors.map(name => ({
      name,
      runId: plan.run.id,
      samples: collectorMap.get(name).samples,
      coverageSeconds: collectorMap.get(name).coverageSeconds,
      startedAt: safeRun.startedAt,
      endedAt: safeRun.endedAt
    })),
    participantPhases: safePhases,
    rooms: safeRooms,
    metrics: evaluatedMetrics,
    breaches,
    note: breaches.length
      ? "One or more stop criteria were breached; this run cannot support a capacity claim."
      : "Provisional thresholds passed; this single run is not by itself a capacity certification."
  };
}

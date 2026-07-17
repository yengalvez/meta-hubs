import { createHash } from "node:crypto";
import { invalid } from "./errors.mjs";
import { canonicalJson } from "./io.mjs";
import { validatePlan } from "./plan-contract.mjs";
import { validateBotRawState, validateParticipantRawEvidence, validateRawEvidence } from "./provenance.mjs";
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

function sealReport(report) {
  return {
    ...report,
    integrity: {
      algorithm: "sha256",
      sha256: createHash("sha256").update(canonicalJson(report)).digest("hex")
    }
  };
}

function validateRun(plan, run, allowTestFixtures) {
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
    (allowTestFixtures === true
      ? typeof run.driver.name === "string" && /^[a-z0-9][a-z0-9-]{2,63}$/.test(run.driver.name)
      : run.driver.name === "yenhubs-playwright-capacity") &&
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

export function buildReport({
  plan,
  evidence,
  thresholds,
  rawSamples = undefined,
  allowTestFixtures = false,
  allowTestTrust = false
}) {
  validatePlan(plan, { productionOnly: !(allowTestFixtures || allowTestTrust) });
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
    return sealReport({
      schemaVersion: 1,
      state: "FAILED",
      planId: plan.planId,
      runId: plan.run.id,
      reason: "capacity driver reported failure",
      certified: false
    });
  }
  requireExactKeys(
    evidence,
    [
      "schemaVersion", "planId", "driverState", "run", "collectorMapping", "collectors",
      "participantPhases", "rooms", "metrics", "raw"
    ],
    "Completed evidence schema is closed"
  );
  if (evidence.driverState !== "completed") {
    throw invalid("Evidence driverState must be completed or failed", "EVIDENCE_INVALID");
  }

  const safeRun = validateRun(plan, evidence.run, allowTestFixtures);
  const rawResult = validateRawEvidence({
    plan,
    run: safeRun,
    raw: evidence.raw,
    rawSamples,
    claimedMetrics: evidence.metrics,
    claimedCollectors: evidence.collectors,
    collectorMapping: evidence.collectorMapping,
    thresholds,
    allowTestFixtures
  });

  const population = validateParticipantRawEvidence({
    plan,
    rawResult,
    evidenceRooms: evidence.rooms,
    participantPhases: evidence.participantPhases,
    maxCollectorIntervalSeconds: thresholds.maxCollectorIntervalSeconds
  });
  const safePhases = population.participantPhases;
  const safeRooms = population.rooms;
  const bots = validateBotRawState({ plan, rawResult, evidenceRooms: evidence.rooms });
  safeRooms.forEach((room, index) => { room.bots = bots.states[index]; });

  const invalidMetrics = [];
  const breaches = [];
  const evaluatedMetrics = {};
  for (const [metric, rawValue] of Object.entries(rawResult.metrics)) {
    const rule = thresholds.metrics[metric];
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

  const report = {
    schemaVersion: 1,
    state: breaches.length ? "STOPPED" : "PASSED",
    planId: plan.planId,
    run: safeRun,
    scenarioId: plan.scenario.id,
    certified: false,
    provisionalThresholds: thresholds.provisional,
    totals: { ...plan.totals },
    profiles: {
      client: plan.scenario.clientProfile,
      runtime: plan.scenario.clientRuntime,
      audio: plan.scenario.audioMode,
      transport: plan.scenario.transportMode
    },
    collectorMapping: rawResult.collectorMapping,
    collectors: rawResult.collectors,
    participantPhases: safePhases,
    rooms: safeRooms,
    metrics: evaluatedMetrics,
    provenance: {
      rawArtifact: rawResult.artifact,
      collectorMapping: rawResult.collectorMapping,
      aggregates: rawResult.aggregateProvenance,
      population: population.provenance,
      profiles: rawResult.profileProvenance,
      modelObservations: rawResult.modelObservationProvenance,
      bots: bots.provenance
    },
    modelObservations: rawResult.modelObservations,
    breaches,
    note: breaches.length
      ? "One or more stop criteria were breached; this run cannot support a capacity claim."
      : "Provisional thresholds passed; this single run is not by itself a capacity certification."
  };
  return sealReport(report);
}

import { buildPlan } from "../lib/plan.mjs";

export const TEST_RUN_ID = "11111111-1111-4111-8111-111111111111";
export const TEST_ISSUED_AT = "2026-07-17T09:55:00.000Z";
export const TEST_STARTED_AT = "2026-07-17T10:00:00.000Z";

export function buildTestPlan({ scenarios, scenarioId = "local-smoke", target, botsPerRoom = 0 }) {
  const scenario = scenarios.get(scenarioId);
  const effectiveTarget = target ??
    (scenario.roomCount > 1
      ? "https://capacity-staging.example.org/{room}"
      : "http://localhost:4000/test-room");
  return buildPlan({
    scenario,
    target: effectiveTarget,
    botsPerRoom,
    runId: TEST_RUN_ID,
    issuedAt: TEST_ISSUED_AT
  });
}

function passingMetric(rule) {
  if (Object.hasOwn(rule, "min")) return rule.min;
  if (rule.unit === "count") return 0;
  if (rule.max === 0) return 0;
  return rule.max / 2;
}

export function makePassingEvidence(plan, thresholds, { startedAt = TEST_STARTED_AT } = {}) {
  const endedAt = new Date(Date.parse(startedAt) + plan.scenario.durationSeconds * 1000).toISOString();
  const samples = Math.max(
    2,
    Math.ceil(plan.scenario.durationSeconds / thresholds.maxCollectorIntervalSeconds) + 1
  );
  const plateauSamples = Math.max(
    2,
    Math.ceil(plan.workload.plateau.durationSeconds / thresholds.maxCollectorIntervalSeconds) + 1
  );
  const metrics = {};
  for (const [name, rule] of Object.entries(thresholds.metrics)) {
    const value = passingMetric(rule);
    metrics[name] = rule.sustainedMs ? { peakValue: value, maxBreachDurationMs: 0 } : value;
  }

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
    collectors: thresholds.requiredCollectors.map(name => ({
      name,
      status: "complete",
      samples,
      coverageSeconds: plan.scenario.durationSeconds,
      startedAt,
      endedAt,
      runId: plan.run.id
    })),
    participantPhases: {
      lobby: {
        peak: plan.totals.participants,
        samples,
        participantSeconds: plan.totals.participants * plan.workload.rampUp.durationSeconds / 2
      },
      room: {
        peak: plan.totals.participants,
        samples,
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
    metrics
  };
}

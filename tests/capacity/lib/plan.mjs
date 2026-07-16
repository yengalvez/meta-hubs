import { randomUUID } from "node:crypto";
import { invalid } from "./errors.mjs";
import { stableId } from "./io.mjs";
import { validateTarget } from "./safety.mjs";

function renderRoomTarget(template, roomId, roomCount) {
  if (template.includes("{room}")) return template.replaceAll("{room}", roomId);
  if (roomCount === 1) return template;
  throw invalid("Multi-room plan is missing its target placeholder", "ROOM_TEMPLATE_REQUIRED");
}

function canonicalIso(value) {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString() === value ? milliseconds : null;
}

function validUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function buildPlan({
  scenario,
  target,
  botsPerRoom,
  runId = randomUUID(),
  issuedAt = new Date().toISOString()
}) {
  if (!scenario) throw invalid("Scenario is required to build a plan", "SCENARIO_REQUIRED");
  if (scenario.mode !== "physical") {
    throw invalid("Model-only scenarios do not produce physical plans", "MODEL_PLAN_DENIED");
  }
  if (!Number.isInteger(botsPerRoom) || botsPerRoom < 0 || botsPerRoom > 10) {
    throw invalid("--bots must be an integer within 0..10", "BOT_COUNT_INVALID");
  }
  if (!scenario.botVariants.includes(botsPerRoom)) {
    throw invalid("--bots must select one declared scenario variant", "BOT_VARIANT_INVALID", { allowed: scenario.botVariants });
  }
  if (!validUuid(runId)) throw invalid("Run id must be a UUID", "RUN_ID_INVALID");
  const issuedAtMs = canonicalIso(issuedAt);
  if (issuedAtMs === null) throw invalid("Run issuedAt must be a canonical ISO timestamp", "RUN_TIME_INVALID");
  const targetInfo = validateTarget(target, { roomCount: scenario.roomCount });
  const seed = {
    schemaVersion: 1,
    scenarioId: scenario.id,
    target: targetInfo.canonical,
    botsPerRoom,
    participants: scenario.totalParticipants,
    rooms: scenario.roomCount,
    durationSeconds: scenario.durationSeconds,
    rampUpSeconds: scenario.rampUpSeconds,
    plateauSeconds: scenario.plateauSeconds,
    rampDownSeconds: scenario.rampDownSeconds,
    movementProfile: scenario.movementProfile,
    audioProfile: scenario.audioProfile
  };
  const planId = stableId("plan", seed);
  const workloadSeed = stableId("workload", seed);
  const rooms = [];
  let globalParticipantOffset = 0;
  let workerNumber = 0;

  for (let roomIndex = 0; roomIndex < scenario.roomCount; roomIndex += 1) {
    const roomId = `room-${String(roomIndex + 1).padStart(3, "0")}`;
    const workers = [];
    let roomParticipantOffset = 0;
    while (roomParticipantOffset < scenario.participantsPerRoom) {
      const participantCount = Math.min(
        scenario.participantsPerWorker,
        scenario.participantsPerRoom - roomParticipantOffset
      );
      workers.push({
        id: `worker-${String(++workerNumber).padStart(3, "0")}`,
        participantStart: globalParticipantOffset + roomParticipantOffset + 1,
        participantCount
      });
      roomParticipantOffset += participantCount;
    }
    rooms.push({
      id: roomId,
      target: renderRoomTarget(targetInfo.canonical, roomId, scenario.roomCount),
      participantCount: scenario.participantsPerRoom,
      bots: botsPerRoom,
      workers
    });
    globalParticipantOffset += scenario.participantsPerRoom;
  }

  const plannedParticipants = rooms.reduce((sum, room) => sum + room.participantCount, 0);
  const plannedBots = rooms.reduce((sum, room) => sum + room.bots, 0);
  if (plannedParticipants !== scenario.totalParticipants || plannedParticipants > 300) {
    throw invalid("Planner violated the physical participant invariant", "PLANNER_INVARIANT_FAILED", {
      plannedParticipants,
      expected: scenario.totalParticipants
    });
  }
  if (rooms.some(room => room.bots > 10)) {
    throw invalid("Planner violated the per-room bot invariant", "PLANNER_INVARIANT_FAILED");
  }

  return {
    schemaVersion: 1,
    state: "PLANNED",
    planId,
    run: {
      id: runId,
      issuedAt,
      startDeadlineAt: new Date(issuedAtMs + 60 * 60 * 1000).toISOString(),
      executionEnabled: false
    },
    scenario: {
      id: scenario.id,
      classification: scenario.classification,
      durationSeconds: scenario.durationSeconds,
      audioProfile: scenario.audioProfile
    },
    targetClassification: targetInfo.classification,
    runtime: {
      nodeMajor: 22,
      driverProtocol: "yenhubs-ndjson-v1",
      browserProfile: "chromium-desktop-synthetic-v1"
    },
    workload: {
      seed: workloadSeed,
      rampUp: {
        durationSeconds: scenario.rampUpSeconds,
        strategy: "linear",
        participantsPerSecond: scenario.totalParticipants / scenario.rampUpSeconds
      },
      plateau: {
        durationSeconds: scenario.plateauSeconds,
        requiredConcurrentParticipants: scenario.totalParticipants
      },
      rampDown: {
        durationSeconds: scenario.rampDownSeconds,
        strategy: "graceful-leave"
      },
      movement: {
        profile: scenario.movementProfile,
        intervalSeconds: 30
      },
      media: {
        audio: scenario.audioProfile,
        video: "disabled",
        screenShare: "disabled"
      }
    },
    totals: {
      participants: plannedParticipants,
      rooms: rooms.length,
      workers: workerNumber,
      bots: plannedBots,
      botsPerRoom
    },
    rooms
  };
}

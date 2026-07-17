import { randomUUID } from "node:crypto";
import { invalid } from "./errors.mjs";
import { buildExecutionTopology, sealPlan, validatePlan } from "./plan-contract.mjs";
import { buildSecurityBinding, validateTarget } from "./security.mjs";
import { signedDocumentBinding } from "./trust.mjs";

const CLIENT_PROFILES = new Set(["desktop", "mobile"]);
const AUDIO_MODES = new Set(["muted", "active"]);
const TRANSPORT_MODES = new Set(["direct", "forced-turn"]);

function renderRoomTarget(template, roomId, roomCount) {
  if (template.includes("{room}")) return template.replaceAll("{room}", roomId);
  if (roomCount === 1) return template;
  throw invalid("Multi-room plan is missing its target placeholder", "ROOM_TEMPLATE_REQUIRED");
}

function canonicalIso(value) {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value ? milliseconds : null;
}

function validUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function buildPlan({
  scenario,
  target,
  botsPerRoom,
  clientProfile = "desktop",
  audioMode = "muted",
  transportMode = "direct",
  attestation,
  environment,
  executionEnabled = false,
  runId = randomUUID(),
  issuedAt = new Date().toISOString()
}) {
  if (!scenario || scenario.mode !== "physical") {
    throw invalid("A physical scenario is required to build a plan", scenario ? "MODEL_PLAN_DENIED" : "SCENARIO_REQUIRED");
  }
  if (![0, 5, 10].includes(botsPerRoom) || !scenario.botVariants.includes(botsPerRoom)) {
    throw invalid("--bots must select exactly 0, 5 or 10", "BOT_VARIANT_INVALID");
  }
  if (!CLIENT_PROFILES.has(clientProfile)) throw invalid("Client profile must be desktop or mobile", "CLIENT_PROFILE_INVALID");
  if (!AUDIO_MODES.has(audioMode)) throw invalid("Audio mode must be muted or active", "AUDIO_MODE_INVALID");
  if (!TRANSPORT_MODES.has(transportMode)) throw invalid("Transport mode must be direct or forced-turn", "TRANSPORT_MODE_INVALID");
  if (typeof executionEnabled !== "boolean") throw invalid("Execution state must be boolean", "EXECUTION_STATE_INVALID");
  if (!validUuid(runId)) throw invalid("Run id must be a UUID", "RUN_ID_INVALID");
  const issuedAtMs = canonicalIso(issuedAt);
  if (issuedAtMs === null) throw invalid("Run issuedAt must be canonical ISO", "RUN_TIME_INVALID");
  const targetInfo = validateTarget(target, { roomCount: scenario.roomCount });
  const environmentBinding = environment
    ? signedDocumentBinding(environment, "environment-snapshot")
    : null;
  if ((executionEnabled || targetInfo.classification === "attested-staging") && !environmentBinding) {
    throw invalid("Remote or execution-enabled plans require a signed environment snapshot", "ENVIRONMENT_EVIDENCE_REQUIRED");
  }
  const planBinding = {
    scenarioId: scenario.id,
    targetTemplate: targetInfo.canonical,
    executionEnabled,
    environmentSha256: environmentBinding?.sha256 ?? null
  };
  const security = buildSecurityBinding({ targetInfo, attestation, issuedAt, planBinding });
  const rooms = [];
  const allWorkers = [];
  let participantOffset = 0;

  for (let roomIndex = 0; roomIndex < scenario.roomCount; roomIndex += 1) {
    const roomId = `room-${String(roomIndex + 1).padStart(3, "0")}`;
    const workers = [];
    let roomOffset = 0;
    while (roomOffset < scenario.participantsPerRoom) {
      const participantCount = Math.min(scenario.participantsPerWorker, scenario.participantsPerRoom - roomOffset);
      const worker = {
        id: `worker-${String(allWorkers.length + 1).padStart(3, "0")}`,
        participantStart: participantOffset + roomOffset + 1,
        participantCount,
        hostId: null,
        _roomId: roomId
      };
      workers.push(worker);
      allWorkers.push(worker);
      roomOffset += participantCount;
    }
    rooms.push({
      id: roomId,
      target: renderRoomTarget(targetInfo.canonical, roomId, scenario.roomCount),
      participantCount: scenario.participantsPerRoom,
      bots: botsPerRoom,
      workers
    });
    participantOffset += scenario.participantsPerRoom;
  }
  const executionTopology = buildExecutionTopology(allWorkers);
  for (const worker of allWorkers) delete worker._roomId;
  const draft = {
    schemaVersion: 1,
    state: "PLANNED",
    planId: "pending",
    run: {
      id: runId,
      issuedAt,
      startDeadlineAt: new Date(issuedAtMs + 60 * 60 * 1000).toISOString(),
      executionEnabled
    },
    scenario: {
      ...scenario,
      clientProfile,
      clientRuntime: clientProfile === "mobile" ? "chromium-mobile-emulation" : "chromium-desktop-emulation",
      audioMode,
      transportMode
    },
    targetTemplate: targetInfo.canonical,
    targetClassification: targetInfo.classification,
    security,
    environment: environmentBinding,
    runtime: {
      nodeMajor: 22,
      driverProtocol: "yenhubs-ndjson-v3",
      browserProfile: `chromium-${clientProfile}-capacity-v3`
    },
    workload: {
      seed: "pending",
      rampUp: {
        durationSeconds: scenario.rampUpSeconds,
        strategy: "linear",
        participantsPerSecond: scenario.totalParticipants / scenario.rampUpSeconds
      },
      plateau: {
        durationSeconds: scenario.plateauSeconds,
        requiredConcurrentParticipants: scenario.totalParticipants
      },
      rampDown: { durationSeconds: scenario.rampDownSeconds, strategy: "graceful-leave" },
      movement: { profile: scenario.movementProfile, intervalSeconds: 30 },
      media: { audio: audioMode, transport: transportMode, video: "disabled", screenShare: "disabled" }
    },
    executionTopology,
    totals: {
      participants: participantOffset,
      rooms: rooms.length,
      workers: allWorkers.length,
      bots: rooms.length * botsPerRoom,
      botsPerRoom
    },
    rooms
  };
  return validatePlan(sealPlan(draft));
}

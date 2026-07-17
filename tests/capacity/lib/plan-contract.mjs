import { invalid } from "./errors.mjs";
import { canonicalJson, stableId } from "./io.mjs";
import { validateSecurityBinding, validateTarget } from "./security.mjs";
import { readFileSync } from "node:fs";

const TRACKED_CATALOGUE = JSON.parse(readFileSync(new URL("../scenarios.yaml", import.meta.url), "utf8"));
const TRACKED_SCENARIOS = new Map(TRACKED_CATALOGUE.scenarios.map(scenario => [scenario.id, scenario]));

const TOP_LEVEL_KEYS = [
  "schemaVersion", "state", "planId", "run", "scenario", "targetTemplate",
  "targetClassification", "security", "environment", "runtime", "workload", "executionTopology",
  "totals", "rooms"
];
const CLIENT_PROFILES = new Set(["desktop", "mobile"]);
const AUDIO_MODES = new Set(["muted", "active"]);
const TRANSPORT_MODES = new Set(["direct", "forced-turn"]);
export const HOST_BROWSER_LIMIT = 4;
export const HOST_CONTEXT_LIMIT = 30;

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

function validUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function renderRoomTarget(template, roomId, roomCount) {
  if (template.includes("{room}")) return template.replaceAll("{room}", roomId);
  if (roomCount === 1) return template;
  throw invalid("Multi-room plan is missing its target placeholder", "ROOM_TEMPLATE_REQUIRED");
}

export function buildExecutionTopology(workers) {
  const hosts = [];
  let current = null;
  for (const worker of workers) {
    if (!current || current.plannedContexts + worker.participantCount > HOST_CONTEXT_LIMIT ||
        (worker._roomId && current._roomId !== worker._roomId)) {
      current = {
        id: `host-${String(hosts.length + 1).padStart(3, "0")}`,
        workerIds: [],
        plannedBrowserProcesses: 1,
        plannedContexts: 0,
        ...(worker._roomId ? { _roomId: worker._roomId } : {})
      };
      hosts.push(current);
    }
    current.workerIds.push(worker.id);
    current.plannedContexts += worker.participantCount;
    worker.hostId = current.id;
  }
  for (const host of hosts) delete host._roomId;
  return {
    mode: hosts.length === 1 ? "single-host-bounded" : "distributed-workers",
    aggregatorId: "aggregator-001",
    maxBrowserProcessesPerHost: HOST_BROWSER_LIMIT,
    maxContextsPerHost: HOST_CONTEXT_LIMIT,
    hosts
  };
}

export function planIdentityCore(plan) {
  return {
    schemaVersion: plan.schemaVersion,
    run: plan.run,
    scenario: plan.scenario,
    targetTemplate: plan.targetTemplate,
    targetClassification: plan.targetClassification,
    security: plan.security,
    environment: plan.environment,
    runtime: plan.runtime,
    workload: {
      rampUp: plan.workload.rampUp,
      plateau: plan.workload.plateau,
      rampDown: plan.workload.rampDown,
      movement: plan.workload.movement,
      media: plan.workload.media
    },
    executionTopology: plan.executionTopology,
    totals: plan.totals,
    rooms: plan.rooms
  };
}

export function sealPlan(draft) {
  const core = planIdentityCore(draft);
  return {
    ...draft,
    planId: stableId("plan", core),
    workload: { ...draft.workload, seed: stableId("workload", core) }
  };
}

function fail(message, code = "PLAN_INTEGRITY_INVALID") {
  throw invalid(message, code);
}

export function validatePlan(plan, { requireExecutionEnabled, productionOnly = false } = {}) {
  if (!exactKeys(plan, TOP_LEVEL_KEYS) || plan.schemaVersion !== 1 || plan.state !== "PLANNED") {
    fail("Plan schema is closed", "PLAN_SCHEMA_INVALID");
  }
  if (!exactKeys(plan.run, ["id", "issuedAt", "startDeadlineAt", "executionEnabled"]) ||
      !validUuid(plan.run.id) || typeof plan.run.executionEnabled !== "boolean") {
    fail("Plan run identity is invalid", "PLAN_SCHEMA_INVALID");
  }
  const issuedAtMs = canonicalIso(plan.run.issuedAt);
  const deadlineMs = canonicalIso(plan.run.startDeadlineAt);
  if (issuedAtMs === null || deadlineMs !== issuedAtMs + 60 * 60 * 1000) fail("Plan run window is not canonical");
  if (requireExecutionEnabled !== undefined && plan.run.executionEnabled !== requireExecutionEnabled) {
    fail("Plan execution state does not match the requested operation", "PHYSICAL_EXECUTION_DISABLED");
  }
  const trackedScenario = TRACKED_SCENARIOS.get(plan.scenario?.id);
  const scenarioKeys = trackedScenario
    ? [...Object.keys(trackedScenario), "clientProfile", "clientRuntime", "audioMode", "transportMode"]
    : [];
  const planCatalogueScenario = trackedScenario
    ? Object.fromEntries(Object.keys(trackedScenario).map(key => [key, plan.scenario?.[key]]))
    : null;
  if (!trackedScenario || !exactKeys(plan.scenario, scenarioKeys) ||
      canonicalJson(planCatalogueScenario) !== canonicalJson(trackedScenario) ||
      trackedScenario.mode !== "physical" || !CLIENT_PROFILES.has(plan.scenario.clientProfile) ||
      plan.scenario.clientRuntime !== (plan.scenario.clientProfile === "mobile" ? "chromium-mobile-emulation" : "chromium-desktop-emulation") ||
      !AUDIO_MODES.has(plan.scenario.audioMode) || !TRANSPORT_MODES.has(plan.scenario.transportMode)) {
    fail("Plan scenario/profile contract is invalid", "PLAN_SCHEMA_INVALID");
  }
  if (plan.environment !== null && (!exactKeys(plan.environment, ["sha256", "capturedAt", "signerKeyId"]) ||
      !/^[0-9a-f]{64}$/.test(plan.environment.sha256) || canonicalIso(plan.environment.capturedAt) === null ||
      !/^[a-z0-9][a-z0-9-]{2,63}$/.test(plan.environment.signerKeyId))) {
    fail("Plan environment binding is invalid", "PLAN_SCHEMA_INVALID");
  }
  if (productionOnly && plan.environment?.signerKeyId.startsWith("test-")) {
    fail("Production plan validation rejects test trust anchors", "SIGNATURE_UNTRUSTED");
  }
  if (plan.run.executionEnabled && plan.environment === null) {
    fail("Execution-enabled plans require a signed environment binding", "ENVIRONMENT_EVIDENCE_REQUIRED");
  }
  const targetInfo = validateTarget(plan.targetTemplate, { roomCount: plan.totals?.rooms });
  if (targetInfo.classification !== plan.targetClassification) fail("Plan target classification is inconsistent");
  validateSecurityBinding(plan.security, {
    target: plan.targetTemplate,
    issuedAt: plan.run.issuedAt,
    productionOnly,
    planBinding: {
      scenarioId: plan.scenario.id,
      targetTemplate: plan.targetTemplate,
      executionEnabled: plan.run.executionEnabled,
      environmentSha256: plan.environment?.sha256 ?? null
    }
  });
  if (plan.security.mode === "attested-remote" &&
      Date.parse(plan.security.attestation.expiresAt) < deadlineMs + plan.scenario.durationSeconds * 1000) {
    fail("Remote attestation must cover the latest complete run window", "PLAN_SECURITY_INVALID");
  }
  if (!exactKeys(plan.runtime, ["nodeMajor", "driverProtocol", "browserProfile"]) ||
      plan.runtime.nodeMajor !== 22 || plan.runtime.driverProtocol !== "yenhubs-ndjson-v3" ||
      plan.runtime.browserProfile !== `chromium-${plan.scenario.clientProfile}-capacity-v3`) {
    fail("Plan runtime contract is invalid");
  }
  if (!exactKeys(plan.workload, ["seed", "rampUp", "plateau", "rampDown", "movement", "media"]) ||
      !exactKeys(plan.workload.rampUp, ["durationSeconds", "strategy", "participantsPerSecond"]) ||
      !exactKeys(plan.workload.plateau, ["durationSeconds", "requiredConcurrentParticipants"]) ||
      !exactKeys(plan.workload.rampDown, ["durationSeconds", "strategy"]) ||
      !exactKeys(plan.workload.movement, ["profile", "intervalSeconds"]) ||
      !exactKeys(plan.workload.media, ["audio", "transport", "video", "screenShare"])) {
    fail("Plan workload schema is closed", "PLAN_SCHEMA_INVALID");
  }
  const ramp = plan.workload.rampUp.durationSeconds;
  const plateau = plan.workload.plateau.durationSeconds;
  const rampDown = plan.workload.rampDown.durationSeconds;
  if (![ramp, plateau, rampDown].every(value => Number.isInteger(value) && value > 0) ||
      ramp + plateau + rampDown !== plan.scenario.durationSeconds ||
      plan.workload.rampUp.strategy !== "linear" || plan.workload.rampDown.strategy !== "graceful-leave" ||
      plan.workload.rampUp.participantsPerSecond !== plan.totals.participants / ramp ||
      plan.workload.plateau.requiredConcurrentParticipants !== plan.totals.participants ||
      plan.workload.movement.profile !== "bounded-keyboard-patrol-v1" ||
      plan.workload.movement.intervalSeconds !== 30 || plan.workload.media.audio !== plan.scenario.audioMode ||
      plan.workload.media.transport !== plan.scenario.transportMode || plan.workload.media.video !== "disabled" ||
      plan.workload.media.screenShare !== "disabled") {
    fail("Plan timeline or workload invariants are invalid");
  }
  if (!exactKeys(plan.totals, ["participants", "rooms", "workers", "bots", "botsPerRoom"]) ||
      !Number.isInteger(plan.totals.participants) || plan.totals.participants < 1 || plan.totals.participants > 300 ||
      !Number.isInteger(plan.totals.rooms) || plan.totals.rooms < 1 ||
      !Number.isInteger(plan.totals.workers) || plan.totals.workers < 1 ||
      ![0, 5, 10].includes(plan.totals.botsPerRoom) || !Number.isInteger(plan.totals.bots)) {
    fail("Plan totals exceed the closed physical envelope");
  }
  if (!Array.isArray(plan.rooms) || plan.rooms.length !== plan.totals.rooms) fail("Plan room count is inconsistent");
  const workerIds = new Set();
  const workers = [];
  let nextParticipant = 1;
  let participantTotal = 0;
  for (const [roomIndex, room] of plan.rooms.entries()) {
    const expectedRoomId = `room-${String(roomIndex + 1).padStart(3, "0")}`;
    if (!exactKeys(room, ["id", "target", "participantCount", "bots", "workers"]) ||
        room.id !== expectedRoomId || room.target !== renderRoomTarget(plan.targetTemplate, expectedRoomId, plan.totals.rooms) ||
        !Number.isInteger(room.participantCount) || room.participantCount < 1 ||
        room.bots !== plan.totals.botsPerRoom || !Array.isArray(room.workers) || room.workers.length < 1) {
      fail("Plan room invariants are invalid");
    }
    let roomParticipants = 0;
    for (const worker of room.workers) {
      const expectedWorkerId = `worker-${String(workers.length + 1).padStart(3, "0")}`;
      if (!exactKeys(worker, ["id", "participantStart", "participantCount", "hostId"]) ||
          worker.id !== expectedWorkerId || workerIds.has(worker.id) ||
          worker.participantStart !== nextParticipant || !Number.isInteger(worker.participantCount) ||
          worker.participantCount < 1 || worker.participantCount > 10 ||
          !/^host-\d{3}$/.test(worker.hostId)) {
        fail("Worker ids and participant ranges must be unique and contiguous");
      }
      workerIds.add(worker.id);
      workers.push({ ...worker, _roomId: room.id });
      nextParticipant += worker.participantCount;
      roomParticipants += worker.participantCount;
    }
    if (roomParticipants !== room.participantCount) fail("Room participant total does not equal worker ranges");
    participantTotal += roomParticipants;
  }
  const expectedTopologyWorkers = workers.map(worker => ({ ...worker, hostId: undefined }));
  for (const worker of expectedTopologyWorkers) delete worker.hostId;
  const expectedTopology = buildExecutionTopology(expectedTopologyWorkers);
  const expectedAssignments = new Map(expectedTopologyWorkers.map(worker => [worker.id, worker.hostId]));
  if (workers.some(worker => worker.hostId !== expectedAssignments.get(worker.id)) ||
      canonicalJson(plan.executionTopology) !== canonicalJson(expectedTopology)) {
    fail("Execution topology and host assignments are not reproducible");
  }
  if (participantTotal !== plan.totals.participants || workers.length !== plan.totals.workers ||
      plan.totals.bots !== plan.totals.rooms * plan.totals.botsPerRoom ||
      plan.totals.participants !== trackedScenario.totalParticipants ||
      plan.totals.rooms !== trackedScenario.roomCount ||
      !trackedScenario.botVariants.includes(plan.totals.botsPerRoom)) {
    fail("Plan declared totals do not equal rooms/workers/bots");
  }
  const core = planIdentityCore(plan);
  if (plan.planId !== stableId("plan", core) || plan.workload.seed !== stableId("workload", core)) {
    fail("Plan id or workload seed does not match canonical plan content");
  }
  return plan;
}

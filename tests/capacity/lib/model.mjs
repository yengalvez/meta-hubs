import { invalid } from "./errors.mjs";
import { stableId } from "./io.mjs";

function requireFinite(input, key, { min = 0, max = Number.POSITIVE_INFINITY, integer = false } = {}) {
  const value = input[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw invalid(`Model input ${key} is invalid`, "MODEL_INPUT_INVALID", { key });
  }
  return value;
}

export function buildCapacityModel({ scenario, input, botsPerRoom }) {
  if (!scenario || scenario.mode !== "model-only") {
    throw invalid("Capacity modelling requires the model-only scenario", "MODEL_SCENARIO_REQUIRED");
  }
  if (!input || input.schemaVersion !== 1) {
    throw invalid("Model input schemaVersion must equal 1", "MODEL_INPUT_INVALID");
  }
  if (typeof input.observedAt !== "string" || !Number.isFinite(Date.parse(input.observedAt))) {
    throw invalid("Model input requires an ISO observedAt timestamp", "MODEL_INPUT_INVALID");
  }
  if (!input.source || typeof input.source.reference !== "string" || input.source.reference.length < 3) {
    throw invalid("Model input requires a traceable source.reference", "MODEL_INPUT_INVALID");
  }
  const baseline = input.baseline;
  if (!baseline || typeof baseline !== "object") {
    throw invalid("Model input requires an observed baseline", "MODEL_INPUT_INVALID");
  }

  const sampleRooms = requireFinite(baseline, "sampleRooms", { min: 2, integer: true });
  const observedBotsPerRoom = requireFinite(baseline, "botsPerRoom", { min: 0, max: 10, integer: true });
  if (!scenario.botVariants.includes(botsPerRoom) || botsPerRoom !== observedBotsPerRoom) {
    throw invalid("Model bot variant must be declared and match the observed baseline", "MODEL_INPUT_INVALID", {
      allowed: scenario.botVariants
    });
  }
  const nodeCpuMillicores = requireFinite(baseline, "nodeCpuMillicores", { min: 1 });
  const nodeMemoryMiB = requireFinite(baseline, "nodeMemoryMiB", { min: 1 });
  const fixedCpuMillicores = requireFinite(baseline, "fixedCpuMillicores", { min: 0 });
  const fixedMemoryMiB = requireFinite(baseline, "fixedMemoryMiB", { min: 0 });
  const perRoomCpuMillicores = requireFinite(baseline, "perRoomCpuMillicores", { min: 1 });
  const perRoomMemoryMiB = requireFinite(baseline, "perRoomMemoryMiB", { min: 1 });
  const headroomRatio = requireFinite(baseline, "headroomRatio", { min: 0.1, max: 0.8 });
  const operationalRoomsPerNodeCap = requireFinite(baseline, "operationalRoomsPerNodeCap", { min: 1, integer: true });

  const cpuBudget = nodeCpuMillicores * (1 - headroomRatio) - fixedCpuMillicores;
  const memoryBudget = nodeMemoryMiB * (1 - headroomRatio) - fixedMemoryMiB;
  if (cpuBudget <= 0 || memoryBudget <= 0) {
    throw invalid("Fixed load and headroom leave no room capacity", "MODEL_INPUT_INVALID");
  }
  const roomsByCpu = Math.floor(cpuBudget / perRoomCpuMillicores);
  const roomsByMemory = Math.floor(memoryBudget / perRoomMemoryMiB);
  const roomsPerNode = Math.min(roomsByCpu, roomsByMemory, operationalRoomsPerNodeCap);
  if (roomsPerNode < 1) {
    throw invalid("Observed baseline cannot host one model room", "MODEL_INPUT_INVALID");
  }

  const roomCount = Math.ceil(scenario.totalParticipants / scenario.participantsPerRoom);
  const workerNodes = Math.ceil(roomCount / roomsPerNode);
  const modelCore = {
    scenarioId: scenario.id,
    observedAt: input.observedAt,
    source: input.source.reference,
    totalParticipants: scenario.totalParticipants,
    participantsPerRoom: scenario.participantsPerRoom,
    roomCount,
    botsPerRoom,
    roomsPerNode,
    workerNodes
  };

  return {
    schemaVersion: 1,
    state: "MODELLED",
    modelId: stableId("model", modelCore),
    certified: false,
    physicalExecutionAllowed: false,
    source: {
      observedAt: input.observedAt,
      reference: input.source.reference,
      sampleRooms
    },
    demand: {
      totalParticipants: scenario.totalParticipants,
      participantsPerRoom: scenario.participantsPerRoom,
      rooms: roomCount,
      botsPerRoom,
      totalBots: roomCount * botsPerRoom
    },
    perNode: {
      cpuBudgetMillicores: Math.round(cpuBudget * 1000) / 1000,
      memoryBudgetMiB: Math.round(memoryBudget * 1000) / 1000,
      roomsByCpu,
      roomsByMemory,
      operationalRoomsPerNodeCap,
      plannedRooms: roomsPerNode
    },
    projection: {
      workerNodes
    },
    caveats: [
      "Architecture model only; it is not load-test evidence or a capacity certification.",
      "The projection covers the supplied per-room CPU and memory baseline only.",
      "Database, SFU, TURN, storage, network, failure domains and regional control planes require separate measured models.",
      "The projection applies only to the selected observed bot variant; bot orchestrator capacity requires its own measured model.",
      "No infrastructure resources are created by this command."
    ]
  };
}

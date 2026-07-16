import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { CAPACITY_ROOT, loadCatalogue, readJsonFile } from "../lib/io.mjs";
import { buildCapacityModel } from "../lib/model.mjs";
import { validateCatalogue } from "../lib/schema.mjs";

const scenarios = validateCatalogue(await loadCatalogue());
const scenario = scenarios.get("total-10000-model");
const input = await readJsonFile(resolve(CAPACITY_ROOT, "examples/model-input.json"));

test("10,000 model is deterministic, non-certifying and physically disabled", () => {
  const model = buildCapacityModel({ scenario, input, botsPerRoom: 0 });
  assert.equal(model.state, "MODELLED");
  assert.equal(model.certified, false);
  assert.equal(model.physicalExecutionAllowed, false);
  assert.deepEqual(model.demand, {
    totalParticipants: 10000,
    participantsPerRoom: 25,
    rooms: 400,
    botsPerRoom: 0,
    totalBots: 0
  });
  assert.equal(model.perNode.roomsByCpu, 10);
  assert.equal(model.perNode.roomsByMemory, 7);
  assert.equal(model.perNode.plannedRooms, 7);
  assert.equal(model.projection.workerNodes, 58);
  assert.equal(buildCapacityModel({ scenario, input, botsPerRoom: 0 }).modelId, model.modelId);
  assert.ok(model.caveats.some(caveat => caveat.includes("not load-test evidence")));
});

test("model requires measured, traceable inputs", () => {
  const missingSource = structuredClone(input);
  delete missingSource.source;
  assert.throws(
    () => buildCapacityModel({ scenario, input: missingSource, botsPerRoom: 0 }),
    error => error.code === "MODEL_INPUT_INVALID"
  );

  const oneRoom = structuredClone(input);
  oneRoom.baseline.sampleRooms = 1;
  assert.throws(
    () => buildCapacityModel({ scenario, input: oneRoom, botsPerRoom: 0 }),
    error => error.code === "MODEL_INPUT_INVALID"
  );
});

test("model refuses to reuse a baseline for a different bot variant", () => {
  assert.throws(
    () => buildCapacityModel({ scenario, input, botsPerRoom: 5 }),
    error => error.code === "MODEL_INPUT_INVALID"
  );
});

test("physical scenario cannot be presented as a model-only result", () => {
  assert.throws(
    () => buildCapacityModel({ scenario: scenarios.get("room-30"), input, botsPerRoom: 0 }),
    error => error.code === "MODEL_SCENARIO_REQUIRED"
  );
});

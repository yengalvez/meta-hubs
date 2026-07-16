import test from "node:test";
import assert from "node:assert/strict";
import { loadCatalogue } from "../lib/io.mjs";
import { buildPlan } from "../lib/plan.mjs";
import { validateCatalogue } from "../lib/schema.mjs";

const scenarios = validateCatalogue(await loadCatalogue());

test("30-person plan shards one room into three ten-client workers", () => {
  const plan = buildPlan({
    scenario: scenarios.get("room-30"),
    target: "https://capacity-staging.example.org/room",
    botsPerRoom: 5
  });
  assert.deepEqual(plan.totals, { participants: 30, rooms: 1, workers: 3, bots: 5, botsPerRoom: 5 });
  assert.deepEqual(plan.rooms[0].workers.map(worker => worker.participantCount), [10, 10, 10]);
  assert.deepEqual(plan.rooms[0].workers.map(worker => worker.participantStart), [1, 11, 21]);
  assert.equal(plan.run.executionEnabled, false);
  assert.equal(plan.workload.rampUp.durationSeconds, 120);
  assert.equal(plan.workload.plateau.durationSeconds, 660);
  assert.equal(plan.workload.rampDown.durationSeconds, 120);
  assert.equal(plan.workload.movement.profile, "bounded-waypoint-patrol-v1");
  assert.deepEqual(plan.workload.media, {
    audio: "muted-synthetic",
    video: "disabled",
    screenShare: "disabled"
  });
  assert.match(plan.workload.seed, /^workload-[0-9a-f]{12}$/);
});

test("300-person plan preserves twelve room boundaries and all participant ids", () => {
  const args = {
    scenario: scenarios.get("total-300"),
    target: "https://capacity-staging.example.org/{room}",
    botsPerRoom: 10
  };
  const plan = buildPlan(args);
  assert.equal(plan.totals.participants, 300);
  assert.equal(plan.totals.rooms, 12);
  assert.equal(plan.totals.workers, 36);
  assert.equal(plan.totals.bots, 120);
  assert.ok(plan.rooms.every(room => room.participantCount === 25));
  assert.ok(plan.rooms.every(room => room.bots === 10));
  assert.ok(plan.rooms.every(room => room.workers.map(worker => worker.participantCount).join(",") === "10,10,5"));
  assert.equal(plan.rooms[0].workers[0].participantStart, 1);
  assert.equal(plan.rooms.at(-1).workers.at(-1).participantStart, 296);
  assert.match(plan.rooms[0].target, /room-001/);
  assert.match(plan.rooms.at(-1).target, /room-012/);
  assert.equal(buildPlan(args).planId, plan.planId, "identical inputs must produce an identical plan id");
});

test("planner requires one of the declared bot variants", () => {
  assert.throws(
    () => buildPlan({
      scenario: scenarios.get("local-smoke"),
      target: "http://localhost:4000/test-room",
      botsPerRoom: 4
    }),
    error => error.code === "BOT_VARIANT_INVALID"
  );
});

test("model-only scenario cannot produce a physical plan", () => {
  assert.throws(
    () => buildPlan({
      scenario: scenarios.get("total-10000-model"),
      target: "https://capacity-staging.example.org/{room}",
      botsPerRoom: 0
    }),
    error => error.code === "MODEL_PLAN_DENIED"
  );
});

test("run identity and issue time are strict while plan and workload ids remain reproducible", () => {
  const base = {
    scenario: scenarios.get("local-smoke"),
    target: "http://localhost:4000/test-room",
    botsPerRoom: 0,
    issuedAt: "2026-07-17T09:55:00.000Z"
  };
  const first = buildPlan({ ...base, runId: "11111111-1111-4111-8111-111111111111" });
  const second = buildPlan({ ...base, runId: "22222222-2222-4222-8222-222222222222" });
  assert.equal(first.planId, second.planId);
  assert.equal(first.workload.seed, second.workload.seed);
  assert.notEqual(first.run.id, second.run.id);
  assert.equal(first.run.startDeadlineAt, "2026-07-17T10:55:00.000Z");

  assert.throws(
    () => buildPlan({ ...base, runId: "not-a-uuid" }),
    error => error.code === "RUN_ID_INVALID"
  );
  assert.throws(
    () => buildPlan({ ...base, runId: first.run.id, issuedAt: "2026-07-17 09:55:00Z" }),
    error => error.code === "RUN_TIME_INVALID"
  );
});

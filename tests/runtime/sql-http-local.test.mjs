import test from "node:test";
import assert from "node:assert/strict";
import { runtimeCases } from "./reticulum-local.mjs";
import { integrationNetworkProfile, stopDrainCases, finishStopDrainCleanup } from "./sql-http-local.mjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

test("STOP native selector selects exactly the two new cases, never an accepted mode", () => {
  assert.deepEqual(runtimeCases("--sql-http-stop-drain"), [{ profile: "sql-http-stop-drain", count: 2 }]);
  assert.deepEqual(stopDrainCases("sql-http-stop-drain"), ["bots-off-child", "durable-stop-pending"]);
  for (const mode of ["--stop", "--sql-http-stop", "--sql-http-stop-drain-all"]) {
    assert.throws(() => runtimeCases(mode), /explicit_native_target_required/);
  }
  for (const profile of [undefined, "sql-http-canary", "sql-http-reentry", "stop-drain-all"]) {
    assert.throws(() => stopDrainCases(profile), /explicit_stop_drain_profile_required/);
  }
});

test("STOP native CLI requires both explicit caches before any native effect", () => {
  for (const args of [["--sql-http-stop-drain"],
    ["--sql-http-stop-drain", "--pg-bin", "/missing", "--cache-reticulum", "/missing"],
    ["--sql-http-stop-drain", "--pg-bin", "/missing", "--cache-reticulum", "/missing", "--wrong-cache", "/missing"]]) {
    const result = spawnSync(process.execPath, [new URL("./reticulum-local.mjs", import.meta.url).pathname, ...args], {
      env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 5000
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /RET_LOCAL_FAIL:arguments:explicit_native_target_required/);
    assert.equal(result.stdout, "");
  }
});

test("STOP native guards retain the real lifecycle, producer and nonterminal proof boundary", () => {
  const read = name => fs.readFileSync(new URL(name, import.meta.url), "utf8");
  const child = read("./sql-http-child.cjs");
  const seed = child.slice(child.indexOf('message.type === "seed-stop-runner"'), child.indexOf('message.type === "stopping-runner"'));
  assert.match(seed, /spawn\(process\.execPath/);
  assert.match(seed, /attachRunnerLifecycleHandlers\(message\.hub_sid, info, child\)/);
  assert.doesNotMatch(seed, /seedReadyRoomForTests|resetRuntimeStateForTests|deleteRunnerStateForTests|kill:.*true|42_424/);
  const durable = read("./reticulum-stop-drain.exs");
  assert.match(durable, /BotConfigAdmission\.insert\(admin\)/);
  assert.match(durable, /BotConfigAdmission\.update\(admin\)/);
  assert.match(durable, /Supervisor\.terminate_child\(Ret\.Supervisor, BotRuntimeOutboxDispatcher\)/);
  assert.match(durable, /Supervisor\.restart_child\(Ret\.Supervisor, BotRuntimeOutboxDispatcher\)/);
  assert.match(durable, /state\.store_module == Store/);
  assert.match(durable, /state\.delivery_module == Ret\.BotOrchestrator/);
  assert.match(durable, /event\.delivered_at == nil/);
  assert.doesNotMatch(durable, /enqueue_stop|Repo\.(?:delete|update_all)|setRoomStopProofForTests/);
  const integrated = read("./sql-http-local.mjs").split("async function runSqlHttpStopDrain")[1];
  assert.match(integrated, /replay\.status, 202/);
  assert.match(integrated, /state: "pending"/);
  assert.doesNotMatch(integrated, /setRoomStopProofForTests|deleteRunnerStateForTests|resetRuntimeStateForTests/);
});

test("STOP cleanup releases listener after actor/PID errors and propagates the first failure", { timeout: 1000 }, async () => {
  for (const broken of ["actor", "runner"]) {
    const first = new Error(`injected_${broken}_cleanup_failure`), later = new Error("later_listener_error");
    const events = [];
    let listening = true, cleanupPass = false;
    const run = finishStopDrainCleanup({
      actorCleanups: [async () => { events.push("actor-1"); if (broken === "actor") throw first; },
        async () => { events.push("actor-2"); }],
      verifyRunnerAbsent: () => { events.push("runner-oracle"); if (broken === "runner") throw first; },
      releaseSockets: () => { events.push("socket-release"); },
      closeListener: () => { events.push("listener-close"); listening = false; throw later; }
    }).then(() => { cleanupPass = true; });
    await assert.rejects(run, error => error === first);
    assert.equal(listening, false); assert.equal(cleanupPass, false);
    assert.deepEqual(events, ["actor-1", "actor-2", "runner-oracle", "socket-release", "listener-close"]);
  }
});

test("STOP cleanup preserves the original oracle failure through all cleanup failures", { timeout: 1000 }, async () => {
  const original = new Error("original_test_oracle_failure"), cleanupError = new Error("cleanup_failure");
  const events = [];
  await assert.rejects(finishStopDrainCleanup({
    actorCleanups: [async () => { events.push("actor"); throw cleanupError; }],
    verifyRunnerAbsent: () => { events.push("runner-oracle"); throw cleanupError; },
    releaseSockets: () => { events.push("socket-release"); throw cleanupError; },
    closeListener: () => { events.push("listener-close"); throw cleanupError; }
  }, original), error => error === original);
  assert.deepEqual(events, ["actor", "runner-oracle", "socket-release", "listener-close"]);
});

test("SQL HTTP canary selects only two new integrated cases", () => {
  assert.deepEqual(runtimeCases("--sql-http-canary"), [{ profile: "sql-http-canary", count: 2 }]);
  assert.throws(() => runtimeCases("--sql-http-all"), /explicit_native_target_required/);
});

test("SQL HTTP reentry selects only one previously unobserved OFF ON window", () => {
  assert.deepEqual(runtimeCases("--sql-http-reentry"), [{ profile: "sql-http-reentry", count: 1 }]);
  assert.throws(() => runtimeCases("--sql-http-reentry-all"), /explicit_native_target_required/);
});

test("integrated confinement permits exactly two owned ports and no wildcard destination", () => {
  const profile = integrationNetworkProfile([55321, 55322]);
  assert.match(profile, /\(deny network\*\)/);
  assert.equal((profile.match(/network-outbound/g) || []).length, 2);
  for (const port of [55321, 55322]) assert.ok(profile.includes(`remote ip "localhost:${port}"`));
  assert.doesNotMatch(profile, /remote ip "localhost:\*"|allow network\*/);
});

test("invalid, duplicate, missing or additional destinations fail closed", () => {
  for (const ports of [undefined, [], [55321], [55321, 55321], [55321, 55322, 55323],
    [55321, 1023], [55321, 65536], [55321, "55322"], [55321, 55322.5], [55321, NaN]]) {
    assert.throws(() => integrationNetworkProfile(ports), /two_distinct_owned_ports_required/);
  }
});

test("integrated CLI cannot default either dependency cache or start an ambiguous target", () => {
  for (const args of [["--sql-http-canary"],
    ["--sql-http-canary", "--pg-bin", "/missing", "--cache-reticulum", "/missing"],
    ["--sql-http-reentry"],
    ["--sql-http-reentry", "--pg-bin", "/missing", "--cache-reticulum", "/missing"],
    ["--sql-http-all", "--pg-bin", "/missing", "--cache-reticulum", "/missing", "--cache-bot-orchestrator", "/missing"]]) {
    const result = spawnSync(process.execPath, [new URL("./reticulum-local.mjs", import.meta.url).pathname, ...args], {
      env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 5000
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /RET_LOCAL_FAIL:arguments:explicit_native_target_required/);
    assert.equal(result.stdout, "");
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { runtimeCases } from "./reticulum-local.mjs";
import { integrationNetworkProfile, stopDrainCases, periodicCases, finishStopDrainCleanup } from "./sql-http-local.mjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

test("periodic native selector selects one automatic bots OFF case and no accepted mode", () => {
  assert.deepEqual(runtimeCases("--sql-http-periodic"), [{ profile: "sql-http-periodic", count: 1 }]);
  assert.deepEqual(periodicCases("sql-http-periodic"), ["bots-off-periodic"]);
  for (const mode of ["--periodic", "--sql-http-periodic-all", "--sql-http-auto"]) {
    assert.throws(() => runtimeCases(mode), /explicit_native_target_required/);
  }
  for (const profile of [undefined, "sql-http-canary", "sql-http-reentry", "sql-http-stop-drain"]) {
    assert.throws(() => periodicCases(profile), /explicit_periodic_profile_required/);
  }
});

test("periodic native CLI requires both explicit caches before any native effect", () => {
  for (const args of [["--sql-http-periodic"],
    ["--sql-http-periodic", "--pg-bin", "/missing", "--cache-reticulum", "/missing"],
    ["--sql-http-periodic", "--pg-bin", "/missing", "--cache-reticulum", "/missing", "--wrong-cache", "/missing"]]) {
    const result = spawnSync(process.execPath, [new URL("./reticulum-local.mjs", import.meta.url).pathname, ...args], {
      env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 5000
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /RET_LOCAL_FAIL:arguments:explicit_native_target_required/);
    assert.equal(result.stdout, "");
  }
});

test("periodic native guard binds the unchanged real product timer and autostart cleanup", () => {
  const source = fs.readFileSync(new URL("../../hubs-cloud/community-edition/services/bot-orchestrator/app.js", import.meta.url), "utf8");
  assert.match(source, /const RET_SYNC_INTERVAL_MS = parsePositiveInt\(process\.env\.RET_SYNC_INTERVAL_MS, 30_000\);/);
  const timer = source.slice(source.indexOf("function startActiveRoomSyncTimer()"), source.indexOf("function startServer("));
  const originalBlock = `function startActiveRoomSyncTimer() {
    const syncTimer = setInterval(() => {
      syncActiveRoomsFromReticulum().catch(error => {
        console.warn("Periodic active room sync failed unexpectedly.", error.name || "Error");
      });
    }, RET_SYNC_INTERVAL_MS);
    syncTimer.unref();
    return syncTimer;
  }`;
  assert.equal(timer.replace(/\s+/g, " ").trim(), originalBlock.replace(/\s+/g, " ").trim());
  const server = source.slice(source.indexOf("function startServer("), source.indexOf("function resetRuntimeStateForTests("));
  assert.match(server, /validateRuntimeConfiguration\(\);/);
  assert.match(server, /if \(RUNNER_AUTOSTART\) \{[\s\S]*syncTimer = startActiveRoomSyncTimer\(\);/);
  assert.match(server, /if \(syncTimer\) clearInterval\(syncTimer\);/);
  assert.match(server, /manager\.cleanupOrphans\(\)[\s\S]*manager\.reconcile\(\)[\s\S]*superviseRunners\(\)/);
  assert.equal((source.match(/startActiveRoomSyncTimer\(/g) || []).length, 2);
});

test("periodic native guard rejects manual sync, fake readiness handles and replacement scheduling", () => {
  const read = name => fs.readFileSync(new URL(name, import.meta.url), "utf8");
  const child = read("./sql-http-child.cjs");
  assert.match(child, /assert\.equal\(process\.env\.RUNNER_AUTOSTART, "false"\)/);
  const timer = child.slice(child.indexOf('message.type === "start-periodic"'), child.indexOf('message.type === "seed"'));
  assert.match(timer, /assert\.equal\(periodic, true\)/);
  assert.match(timer, /assert\.equal\(process\.env\.RET_SYNC_INTERVAL_MS, undefined\)/);
  assert.match(timer, /activeSyncTimer = internals\.startActiveRoomSyncTimer\(\);/);
  assert.doesNotMatch(timer, /setInterval|syncActiveRoomsFromReticulum|seedReadyRoomForTests|resetRuntimeStateForTests/);
  for (const type of ["seed", "sync"]) {
    const start = child.indexOf(`message.type === "${type}"`);
    const branch = child.slice(start, child.indexOf("} else if", start));
    assert.match(branch, /assert\.equal\(periodic, false\)/);
  }
  assert.match(child, /clearInterval\(activeSyncTimer\)/);
  const driver = read("./sql-http-local.mjs");
  const observation = driver.slice(driver.indexOf("async function preparePeriodicWindow"), driver.indexOf("export async function runSqlHttpCanary"));
  assert.doesNotMatch(observation, /sendBot\("sync"\)|setInterval|seedReadyRoomForTests|resetRuntimeStateForTests|deleteRunnerStateForTests/);
  assert.match(observation, /socket abort precedes the unchanged 15s chat budget/);
  assert.match(observation, /commit_to_capabilities_off[\s\S]*commit_to_readiness_503[\s\S]*commit_to_socket_close/);
  const preparation = driver.slice(driver.indexOf("await preparePeriodicWindow(sendBot, get)"), driver.indexOf('const seed = await sendBot("seed",'));
  assert.match(preparation, /sendBot\("seed-stop-runner"/);
  assert.doesNotMatch(preparation, /sendBot\("sync"\)/);
  const revocation = driver.slice(driver.indexOf("assert.equal(transition.sql_committed_bots_off"), driver.indexOf('} else if (testCase === "chat-off")'));
  assert.match(revocation, /observePeriodicOff/);
  assert.doesNotMatch(revocation, /sendBot\("sync"\)/);
  const cleanup = driver.slice(driver.indexOf('"periodic_actor_cleanup_timeout"'), driver.indexOf("export function stopDrainCases"));
  assert.match(cleanup, /periodic owned runner absent after actor cleanup/);
  assert.match(cleanup, /releaseSockets[\s\S]*closeListener[\s\S]*if \(first\) throw first/);
  const fixture = read("./reticulum-sql-http.exs");
  const selected = fixture.slice(fixture.indexOf('"sql-http-periodic" ->'), fixture.indexOf('"sql-http-reentry" ->'));
  assert.equal((selected.match(/run_case\(/g) || []).length, 1);
  assert.match(selected, /run_case\("bots-off-periodic", warm\)/);
  assert.match(fixture, /do: "features\|enable_room_bots"/);
  assert.match(fixture, /length\(Enum\.uniq\(\[owner_sql, request_sql, off_sql\]\)\) == 3/);
  assert.match(fixture, /Cachex\.get\(:app_config, ""\)/);
  assert.match(fixture, /AppConfig\.set_config_value\(key, false\)/);
  assert.match(fixture, /do: handshake\("off-periodic-observed", 15_000\)/);
  assert.match(fixture, /Task\.await\(task, timeout\)/);
});

test("periodic native total chat budget is anchored before request admission, not the model POST", () => {
  const source = fs.readFileSync(new URL("./sql-http-local.mjs", import.meta.url), "utf8");
  assert.ok(/if \(periodic \|\| testCase === "chat-off"\) current\.requestBeforeReadyAt = performance\.now\(\);\s*acknowledge\("ready"\);/.test(source),
    "monotonic ancla must precede the ACK that admits the real chat");
  const observation = source.slice(source.indexOf("async function observePeriodicOff"), source.indexOf("export async function runSqlHttpCanary"));
  assert.ok(/Number\.isFinite\(current\.requestBeforeReadyAt\)/.test(observation));
  assert.ok(/current\.closedAt - current\.requestBeforeReadyAt < 14_000/.test(observation));
  assert.ok(!/assert\.ok\(current\.closedAt - current\.openedAt < 14_000/.test(observation));
  assert.ok(observation.includes("request_before_ready_to_socket_close_ms"));
  assert.ok(observation.includes("model_request_to_socket_close_ms"));
});

test("periodic native stale cache fixture spans the automatic GET without extending TTL", () => {
  const read = name => fs.readFileSync(new URL(name, import.meta.url), "utf8");
  const source = read("./reticulum-sql-http.exs").replace(/^\s*#.*$/gm, "");
  assert.ok(/if kind == "bots-off-periodic" do\s*assert warm\["features"\]\["enable_room_bots"\] === true\s*assert warm\["features"\]\["enable_bot_chat"\] === true\s*assert \{:ok, true\} = Cachex\.put\(:app_config, "", warm\)\s*assert \{:ok, \^warm\} = Cachex\.get\(:app_config, ""\)\s*end\s*AppConfig\.set_config_value\(key, false\)/.test(source),
    "late ON fill must occur immediately before the independent OFF write, never after COMMIT");
  const observation = source.slice(source.indexOf('do: handshake("off-periodic-observed"'), source.indexOf('if kind == "chat-off-on"'));
  assert.ok(observation.includes('assert {:ok, ^warm} = Cachex.get(:app_config, "")'),
    "raw stale ON must still exist after the automatic GET was observed");
  const driver = read("./sql-http-local.mjs");
  assert.ok(/if \(age >= 25_000\)/.test(driver));
  assert.ok(/assert\.ok\(age < 28_000/.test(driver));
  assert.ok(driver.includes('assert.equal(verified.raw_cache_still_on_after_periodic_get, true)'));
  assert.ok(!/Cachex\.(?:put|expire|refresh).*ttl|Cachex\.expire|expiration\(/.test(source));
  const product = read("../../hubs-cloud/community-edition/services/reticulum/lib/ret/application.ex");
  assert.ok(/id: :app_config_cache,[\s\S]*expiration: expiration\(default: :timer\.seconds\(10\)\)/.test(product));
});

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

// Execute only the owned fixture bodies with pure doubles. Neither helper can
// reach the driver setup, spawn an actor, open HTTP or use a dependency cache.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const canarySource = () => fs.readFileSync(new URL("./sql-http-local.mjs", import.meta.url), "utf8");
function chatOffOracle({ closedAt = 1500, closedBeforeSync, requestBeforeReadyAt = 100,
  pending = {}, events = [] } = {}) {
  const source = canarySource(), marker = '} else if (testCase === "chat-off") {';
  const start = source.indexOf(marker) + marker.length;
  const end = source.indexOf('} else {\n        if (testCase === "chat-off-on")', start);
  assert.ok(start >= marker.length && end > start, "exact chat-off fixture body required");
  const run = new AsyncFunction("assert", "performance", "transition", "current", "sendBot",
    "healthModules", "bounded", "acknowledge", `let elapsed; ${source.slice(start, end)} return elapsed;`);
  const current = { calls: ["/v1/moderations", "/v1/responses"], response: { writableFinished: false },
    socket: { destroyed: false }, closed: { promise: Promise.resolve() }, requestBeforeReadyAt,
    closedAt: closedBeforeSync, ...pending };
  return run(assert, { now: () => 1000 }, { sql_committed_off: true, three_distinct_sql_owners: true,
    raw_cache_still_on: true }, current, async type => {
    assert.equal(type, "sync"); events.push("sync");
    current.closedAt = closedAt; current.unfinished = true; current.socket.destroyed = true;
    return { authoritative: true, count: 1 };
  }, async () => ({ bots_enabled: true, ai_enabled: false }), async (promise, code, ms) => {
    assert.equal(code, "model_socket_not_cancelled"); assert.equal(ms, 2000); return promise;
  }, line => { assert.equal(line, "off-synced"); events.push("ack"); });
}

test("SQL HTTP canary chat-off accepts held then post-sync cancellation before the original deadline", async () => {
  const events = [];
  assert.equal(await chatOffOracle({ events }), 500);
  assert.deepEqual(events, ["sync", "ack"]);
});

test("SQL HTTP canary chat-off rejects deadline-only and pre-sync closure instead of emitting PASS", async () => {
  for (const change of [{ closedAt: 14_100 }, { closedAt: 15_100 }, { closedAt: 999 },
    { closedAt: NaN }, { requestBeforeReadyAt: NaN }, { requestBeforeReadyAt: null }, { closedBeforeSync: 500 },
    { pending: { response: { writableFinished: true } } }, { pending: { socket: { destroyed: true } } }]) {
    const events = [];
    await assert.rejects(chatOffOracle({ ...change, events }), { code: "ERR_ASSERTION" });
    assert.ok(!events.includes("ack"), "invalid temporal order must never acknowledge off-synced");
    if (change.closedBeforeSync !== undefined || change.pending) assert.deepEqual(events, [], "sync requires a held open socket");
  }
});

test("SQL HTTP canary chat-off request anchor immediately precedes the admission ACK", () => {
  assert.ok(/if \(periodic \|\| testCase === "chat-off"\) current\.requestBeforeReadyAt = performance\.now\(\);\s*acknowledge\("ready"\);/.test(canarySource()),
    "chat-off monotonic anchor must immediately precede the admission ACK");
});

function canaryCleanupOracle({ originalFailure, broken, callbackError = false } = {}) {
  const source = canarySource(), start = source.indexOf("    if (periodic) {", source.indexOf("  } finally {", source.indexOf("export async function runSqlHttpCanary")));
  const end = source.lastIndexOf("\n  }", source.indexOf("\n  const sourceAfter = snapshot();", start));
  assert.ok(start >= 0 && end > start, "exact canary finally body required");
  const run = new AsyncFunction("assert", "periodic", "finishStopDrainCleanup", "beam", "beamExit",
    "bot", "botExit", "sockets", "provider", "denied", "cleanup", "failure", "bounded", "fail",
    `try { if (failure) throw failure; } finally { ${source.slice(start, end)} } return cleanup;`);
  const events = [], injected = new Error(`injected_${broken || "none"}`), later = new Error("later_cleanup_failure");
  const actor = name => ({ exitCode: null, signalCode: null, stdin: { end() { events.push(`${name}-stdin`); } },
    kill(signal) { events.push(`${name}-${signal}`); if (broken === name) throw injected; } });
  const listener = name => ({ listening: true, close(done) {
    events.push(name); this.listening = false;
    if (broken === name) { if (callbackError) return done(injected); throw injected; }
    if (broken === "beam" || broken === "bot" || broken === "socket") throw later;
    done();
  } });
  const provider = listener("provider"), denied = listener("denied");
  const sockets = new Set([{ destroy() { events.push("socket"); if (broken === "socket") throw injected; } }]);
  const promise = run(assert, false, finishStopDrainCleanup, actor("beam"), Promise.resolve(),
    actor("bot"), Promise.resolve(), sockets, provider, denied, true, originalFailure,
    async promise => promise, code => { throw new Error(code); });
  return { promise, events, injected, provider, denied };
}

test("SQL HTTP canary cleanup closes both actors socket and listeners on success", async () => {
  const { promise, events, provider, denied } = canaryCleanupOracle();
  assert.equal(await promise, true);
  assert.deepEqual(events, ["beam-stdin", "beam-SIGTERM", "bot-stdin", "bot-SIGTERM", "socket", "provider", "denied"]);
  assert.equal(provider.listening, false); assert.equal(denied.listening, false);
});

test("SQL HTTP canary cleanup attempts every resource and preserves the first injected error", async () => {
  for (const broken of ["beam", "bot", "socket", "provider", "denied"]) {
    for (const originalFailure of [undefined, new Error("original_oracle_failure")]) {
      const { promise, events, injected, provider, denied } = canaryCleanupOracle({ broken, originalFailure });
      await assert.rejects(promise, error => error === (originalFailure || injected));
      assert.deepEqual(events, ["beam-stdin", "beam-SIGTERM", "bot-stdin", "bot-SIGTERM", "socket", "provider", "denied"]);
      assert.equal(provider.listening, false); assert.equal(denied.listening, false);
    }
  }
});

test("SQL HTTP canary cleanup rejects listener callback errors without omitting the other listener", async () => {
  const { promise, events, injected } = canaryCleanupOracle({ broken: "provider", callbackError: true });
  await assert.rejects(promise, error => error === injected);
  assert.deepEqual(events.slice(-2), ["provider", "denied"]);
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

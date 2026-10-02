// Explicit finite integrated modes on the existing owned Reticulum runner.
// Actual SQL/HTTPoison/Express/fetch; provider, readiness and chat-entry seams
// remain synthetic. No provider, Kubernetes, production or SLO acceptance.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const fail = code => { throw new Error(code); };
const sha = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
};
const bounded = (promise, code, ms = 5000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(code)), ms);
  })]).finally(() => clearTimeout(timer));
};
const listen = server => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen({ host: "127.0.0.1", port: 0 }, () => resolve(server.address().port));
});
async function reservePort() {
  const server = net.createServer(), port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}

export function integrationNetworkProfile(ports) {
  if (!Array.isArray(ports) || ports.length !== 2 || new Set(ports).size !== 2 ||
      ports.some(port => !Number.isInteger(port) || port < 1024 || port > 65535)) {
    fail("two_distinct_owned_ports_required");
  }
  return `(version 1)(allow default)(deny network*)(allow network-bind(local ip "localhost:*"))(allow network-inbound(local ip "localhost:*"))${ports.map(port => `(allow network-outbound(remote ip "localhost:${port}"))`).join("")}`;
}

function stageQueue(child, log) {
  let partial = "", bytes = 0, waiting;
  const queue = [];
  child.stdout.on("data", chunk => {
    fs.writeSync(log, chunk); bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) { waiting?.reject(new Error("owned_stdout_limit")); return; }
    partial += chunk.toString("utf8");
    for (;;) {
      const end = partial.indexOf("\n"); if (end < 0) break;
      const line = partial.slice(0, end); partial = partial.slice(end + 1);
      if (!line.startsWith("SQL_HTTP_SIGNAL:")) continue;
      try {
        const event = JSON.parse(line.slice("SQL_HTTP_SIGNAL:".length));
        if (waiting) { const target = waiting; waiting = null; target.resolve(event); }
        else queue.push(event);
      } catch { waiting?.reject(new Error("owned_signal_invalid")); }
    }
  });
  return async (kind, testCase) => {
    if (waiting) fail("parallel_owned_stage_wait");
    const pending = deferred();
    if (queue.length) pending.resolve(queue.shift()); else waiting = pending;
    const event = await bounded(pending.promise, `sql_http_stage_${kind}_timeout`, kind === "setup" ? 20000 : 5000);
    assert.equal(event.kind, kind);
    if (testCase !== null) assert.equal(event.test_case, testCase);
    return event;
  };
}

function childMessages(child) {
  const pending = new Map(); let sequence = 0;
  child.on("message", message => {
    if (message?.pid !== child.pid) {
      for (const value of pending.values()) value.reject(new Error("owned_child_identity"));
      return;
    }
    const value = pending.get(message.id);
    if (value) { pending.delete(message.id); value.resolve(message); }
  });
  child.once("exit", () => {
    for (const value of pending.values()) value.reject(new Error("owned_bot_exited"));
  });
  child.once("error", () => {
    for (const value of pending.values()) value.reject(new Error("owned_bot_spawn_failed"));
  });
  return async (type, data = {}) => {
    const id = String(++sequence), value = deferred(); pending.set(id, value);
    child.send({ type, id, ...data });
    const message = await bounded(value.promise, "owned_bot_message_timeout");
    assert.equal(message.type, type); assert.equal(message.ok, true);
    return message;
  };
}

export async function runSqlHttpCanary({ root, work, log, env, application, pgPort, mix, botCache }) {
  const profile = env.RET_LOCAL_PROFILE;
  if (profile === "sql-http-stop-drain") {
    return runSqlHttpStopDrain({ root, work, log, env, application, pgPort, mix, botCache });
  }
  const expectedCases = { "sql-http-canary": ["positive", "chat-off"], "sql-http-reentry": ["chat-off-on"] }[profile];
  assert.ok(expectedCases, "explicit integrated profile required");
  assert.ok(work.startsWith("/private/tmp/ynret-local-"));
  assert.equal(fs.statSync(work).mode & 0o777, 0o700);
  const began = performance.now(), results = [];
  const snapshot = () => Object.fromEntries([".", "hubs", "hubs-cloud"].map(name => {
    const location = name === "." ? root : path.join(root, name);
    const git = args => {
      const result = spawnSync("/usr/bin/git", ["-C", location, ...args], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 5000 });
      assert.equal(result.status, 0); assert.equal(result.signal, null); return result.stdout.trim();
    };
    assert.equal(git(["status", "--porcelain=v1", "--untracked-files=normal"]), "", "source clean");
    return [name, git(["rev-parse", "HEAD"])];
  }));
  const sourceBefore = snapshot();
  const cloud = path.join(root, "hubs-cloud"), relative = "community-edition/services/bot-orchestrator";
  const source = path.join(cloud, relative), cache = fs.realpathSync(botCache);
  for (const name of ["package.json", "package-lock.json"]) assert.equal(sha(path.join(source, name)), sha(path.join(cache, name)), "exact dependency cache");
  const inventory = spawnSync("/usr/bin/git", ["-C", cloud, "ls-files", "-z", "--", relative], {
    env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 5000
  });
  assert.equal(inventory.status, 0); assert.equal(inventory.signal, null);
  const botApplication = path.join(work, "bot-orchestrator");
  for (const file of inventory.stdout.split("\0").filter(Boolean)) {
    const name = file.slice(relative.length + 1), input = path.join(cloud, file), output = path.join(botApplication, name);
    assert.ok(name && !name.startsWith("../") && fs.lstatSync(input).isFile());
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 }); fs.copyFileSync(input, output);
  }
  assert.ok(fs.existsSync(path.join(botApplication, "app.js")));
  fs.cpSync(path.join(cache, "node_modules"), path.join(botApplication, "node_modules"), { recursive: true, dereference: true });
  fs.copyFileSync(path.join(root, "tests/runtime/sql-http-child.cjs"), path.join(work, "sql-http-child.cjs"));

  let current, bot, beam, botExit, beamExit, sendBot;
  let cleanup = false, failure;
  const ownedExit = child => {
    const result = new Promise((resolve, reject) => {
      child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
    });
    result.catch(() => {}); return result;
  };
  const sockets = new Set(); let deniedConnections = 0;
  const provider = http.createServer(async (req, res) => {
    try {
      assert.ok(current, "case selected before any request");
      assert.equal(req.method, "POST");
      let body = "";
      for await (const chunk of req) { body += chunk; assert.ok(Buffer.byteLength(body) <= 32768); }
      assert.ok(["/v1/moderations", "/v1/responses"].includes(req.url));
      if (req.url === "/v1/responses") assert.equal(JSON.parse(body).store, false);
      current.calls.push(req.url);
      if (req.url === "/v1/responses") {
        assert.equal(current.calls.length, 2);
        current.response = res; current.socket = req.socket;
        const active = current;
        res.once("close", () => {
          active.unfinished = !res.writableFinished; active.closedAt = performance.now(); active.closed.resolve();
        });
        current.held.resolve();
      } else {
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ results: [{ flagged: false }] }));
      }
    } catch (error) { current?.held.reject(error); res.destroy(); }
  });
  const denied = net.createServer(socket => { deniedConnections++; sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  provider.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  try {
    const providerPort = await listen(provider), deniedPort = await listen(denied);
    const retPort = await reservePort(), botPort = await reservePort();
    assert.equal(new Set([pgPort, providerPort, deniedPort, retPort, botPort]).size, 5);
    const key = crypto.randomBytes(32).toString("hex");
    const botEnv = {
      PATH: "/usr/bin:/bin", HOME: path.join(work, "home"), TMPDIR: work, LANG: "C", LC_ALL: "C", TZ: "UTC",
      RUNNER_AUTOSTART: "false", YENHUBS_BOTS_ENABLED: "true", YENHUBS_AI_ENABLED: "true",
      HUBS_BASE_URL: "http://private-test.invalid", RET_INTERNAL_ENDPOINT: `http://127.0.0.1:${retPort}`,
      BOT_ORCHESTRATOR_ACCESS_KEY: key, OPENAI_API_KEY: "owned-synthetic-key-never-provider", OPENAI_MODEL: "gpt-6-luna",
      OPENAI_ENDPOINT: `http://127.0.0.1:${providerPort}/v1/responses`,
      OPENAI_MODERATION_ENDPOINT: `http://127.0.0.1:${providerPort}/v1/moderations`
    };
    bot = spawn("/usr/bin/sandbox-exec", ["-p", integrationNetworkProfile([providerPort, retPort]), process.execPath,
      path.join(work, "sql-http-child.cjs"), String(botPort), String(deniedPort)], {
      cwd: work, env: botEnv, stdio: ["ignore", log, log, "ipc"]
    });
    botExit = ownedExit(bot);
    sendBot = childMessages(bot);
    const started = await sendBot("start");
    assert.equal(started.port, botPort); assert.equal(started.denied, true); assert.equal(started.native_fetch, true);
    assert.equal(deniedConnections, 0);
    const healthModules = async () => {
      const response = await fetch(`http://127.0.0.1:${botPort}/health`, { signal: AbortSignal.timeout(2000) });
      assert.equal(response.status, 200); return (await response.json()).modules;
    };
    const beamEnv = { ...env, RET_LOCAL_HTTP_PORT: String(retPort), RET_LOCAL_BOT_PORT: String(botPort),
      RET_LOCAL_BOT_KEY: key, RET_LOCAL_DENIED_PORT: String(deniedPort) };
    beam = spawn("/usr/bin/sandbox-exec", ["-p", integrationNetworkProfile([pgPort, botPort]), mix, "run", "--no-start", "--no-compile",
      path.join(root, "tests/runtime/reticulum-local.exs")], {
      cwd: application, env: beamEnv, stdio: ["pipe", "pipe", log]
    });
    beamExit = ownedExit(beam);
    beam.stdin.on("error", () => { fs.writeSync(log, "OWNED_BEAM_INPUT_CLOSED\n"); });
    const waitStage = stageQueue(beam, log), seen = new Set();
    const acknowledge = line => { assert.equal(beam.exitCode, null); beam.stdin.write(`OWNED_SQL_HTTP:${line}\n`); };
    for (let index = 0; index < expectedCases.length; index++) {
      const setup = await waitStage("setup", null), testCase = setup.test_case;
      assert.ok(expectedCases.includes(testCase) && !seen.has(testCase)); seen.add(testCase);
      assert.ok(/^[A-Za-z0-9_-]{1,64}$/.test(setup.hub_sid));
      assert.equal(setup.real_http_client, true); assert.equal(setup.denied, true);
      current = { calls: [], held: deferred(), closed: deferred(), response: null };
      const seed = await sendBot("seed", { hub_sid: setup.hub_sid, bots: setup.bots });
      assert.equal(seed.synthetic_readiness, true);
      const on = await sendBot("sync");
      assert.equal(on.authoritative, true); assert.equal(on.count, 1);
      const ready = await fetch(`http://127.0.0.1:${botPort}/ready`, { signal: AbortSignal.timeout(2000) });
      assert.equal(ready.status, 200); assert.equal((await ready.json()).ok, true);
      assert.deepEqual(await healthModules(), { bots_enabled: true, ai_enabled: true });
      acknowledge("ready");
      const begun = await waitStage("request-started", testCase);
      assert.equal(begun.distinct_sql_owners, true);
      await bounded(current.held.promise, "actual_provider_model_not_reached");
      assert.deepEqual(current.calls, ["/v1/moderations", "/v1/responses"]);
      assert.equal(current.response.writableFinished, false); assert.equal(current.socket.destroyed, false);
      acknowledge("model-held");
      const transition = await waitStage("transition", testCase);
      assert.equal(transition.request_pending, true);
      let elapsed;
      if (testCase === "chat-off") {
        assert.equal(transition.sql_committed_off, true); assert.equal(transition.three_distinct_sql_owners, true);
        assert.equal(transition.raw_cache_still_on, true);
        const before = performance.now(), off = await sendBot("sync");
        assert.equal(off.authoritative, true); assert.equal(off.count, 1);
        assert.deepEqual(await healthModules(), { bots_enabled: true, ai_enabled: false });
        await bounded(current.closed.promise, "model_socket_not_cancelled", 2000);
        assert.equal(current.unfinished, true); assert.equal(current.socket.destroyed, true);
        assert.deepEqual(current.calls, ["/v1/moderations", "/v1/responses"]);
        elapsed = Math.round(current.closedAt - before);
        acknowledge("off-synced");
      } else {
        if (testCase === "chat-off-on") {
          assert.equal(transition.sql_committed_off_then_on, true);
          assert.equal(transition.three_distinct_sql_owners, true);
          assert.equal(transition.raw_cache_still_on, true);
          assert.equal(transition.old_policy_revision_invalid, true);
          // Deliberately omit an intermediate OFF snapshot. The actual next
          // authenticated GET sees ON; only Reticulum's final fence can reject
          // the old request. This is not a socket-cancellation/periodicity claim.
          const restored = await sendBot("sync");
          assert.equal(restored.authoritative, true); assert.equal(restored.count, 1);
          assert.deepEqual(await healthModules(), { bots_enabled: true, ai_enabled: true });
          assert.equal(current.response.writableFinished, false); assert.equal(current.socket.destroyed, false);
        }
        current.response.writeHead(200, { "content-type": "application/json" });
        current.response.end(JSON.stringify({ status: "completed", output_text: JSON.stringify({ reply: "owned integrated reply" }) }));
        acknowledge("released");
      }
      const verified = await waitStage("verified", testCase);
      assert.equal(verified.no_command, true); assert.equal(verified.no_old_reply, testCase !== "positive");
      assert.equal(verified.status, testCase === "positive" ? 200 : testCase === "chat-off" ? 502 : 403);
      assert.deepEqual(current.calls, testCase === "chat-off"
        ? ["/v1/moderations", "/v1/responses"] : ["/v1/moderations", "/v1/responses", "/v1/moderations"]);
      assert.equal(deniedConnections, 0);
      results.push({ test_case: testCase, outcome: "PASS", actual_provider_phases: current.calls.length,
        ...(elapsed === undefined ? {} : { snapshot_to_socket_close_ms: elapsed, socket_unfinished_before_cleanup: true }) });
      acknowledge("verified");
    }
    assert.deepEqual([...seen].sort(), [...expectedCases].sort());
    assert.deepEqual(await bounded(beamExit, "owned_beam_exit_timeout", 10000), { code: 0, signal: null });
    assert.equal(fs.readFileSync(path.join(application, `local-result-${profile}.txt`), "utf8"), `${expectedCases.length}/${expectedCases.length}\n`);
    await sendBot("shutdown");
    assert.deepEqual(await bounded(botExit, "owned_bot_exit_timeout"), { code: 0, signal: null });
    cleanup = true;
  } catch (error) {
    failure = error; fs.writeSync(log, String(error.stack) + "\n"); throw error;
  } finally {
    for (const [child, exit] of [[beam, beamExit], [bot, botExit]]) {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.stdin?.end(); child.kill("SIGTERM");
        try { await bounded(exit, "owned_child_cleanup_timeout", 3000); }
        catch { child.kill("SIGKILL"); await bounded(exit, "owned_child_forced_cleanup_timeout", 3000); }
      }
    }
    for (const socket of sockets) socket.destroy();
    for (const server of [provider, denied]) {
      if (server.listening) await bounded(new Promise(resolve => server.close(resolve)), "owned_listener_cleanup_timeout", 2000);
    }
    cleanup &&= !provider.listening && !denied.listening;
    if (!cleanup && !failure) fail("sql_http_cleanup_not_verified");
  }
  const sourceAfter = snapshot(); assert.deepEqual(sourceAfter, sourceBefore);
  return { scope: "actual-SQL-HTTP-synthetic-provider-readiness-ConnTest-not-browser-Kubernetes",
    results, source_before: sourceBefore, source_after: sourceAfter, source_unchanged_clean: true,
    denied_connections: deniedConnections, cleanup, elapsed_ms: Math.round(performance.now() - began) };
}

export function stopDrainCases(profile) {
  if (profile !== "sql-http-stop-drain") fail("explicit_stop_drain_profile_required");
  return ["bots-off-child", "durable-stop-pending"];
}

export async function finishStopDrainCleanup({ actorCleanups, verifyRunnerAbsent, releaseSockets, closeListener }, originalFailure) {
  let failure = originalFailure;
  const attempt = async action => {
    try { await action(); } catch (error) { failure ??= error; }
  };
  try {
    for (const action of actorCleanups) await attempt(action);
    await attempt(verifyRunnerAbsent);
  } finally {
    try { await attempt(releaseSockets); }
    finally { await attempt(closeListener); }
  }
  // Resource release cannot turn a failed oracle into cleanup acceptance or
  // replace the original failure with a later cleanup error.
  if (failure) throw failure;
}

async function runSqlHttpStopDrain({ root, work, log, env, application, pgPort, mix, botCache }) {
  const expected = stopDrainCases(env.RET_LOCAL_PROFILE), results = [], began = performance.now();
  assert.ok(work.startsWith("/private/tmp/ynret-local-"));
  assert.equal(fs.statSync(work).mode & 0o777, 0o700);
  const snapshot = () => Object.fromEntries([".", "hubs", "hubs-cloud"].map(name => {
    const git = args => {
      const result = spawnSync("/usr/bin/git", ["-C", path.join(root, name), ...args], {
        env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 5000
      });
      assert.equal(result.status, 0); assert.equal(result.signal, null); return result.stdout.trim();
    };
    assert.equal(git(["status", "--porcelain=v1", "--untracked-files=normal"]), "", "source clean");
    return [name, git(["rev-parse", "HEAD"])];
  }));
  const sourceBefore = snapshot(), cloud = path.join(root, "hubs-cloud");
  const relative = "community-edition/services/bot-orchestrator", source = path.join(cloud, relative);
  const cache = fs.realpathSync(botCache);
  for (const name of ["package.json", "package-lock.json"]) {
    assert.equal(sha(path.join(source, name)), sha(path.join(cache, name)), "exact dependency cache");
  }
  const inventory = spawnSync("/usr/bin/git", ["-C", cloud, "ls-files", "-z", "--", relative], {
    env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 5000
  });
  assert.equal(inventory.status, 0); assert.equal(inventory.signal, null);
  const botApplication = path.join(work, "bot-orchestrator");
  for (const file of inventory.stdout.split("\0").filter(Boolean)) {
    const name = file.slice(relative.length + 1), input = path.join(cloud, file), output = path.join(botApplication, name);
    assert.ok(name && !name.startsWith("../") && fs.lstatSync(input).isFile());
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 }); fs.copyFileSync(input, output);
  }
  assert.ok(fs.existsSync(path.join(botApplication, "app.js")));
  fs.cpSync(path.join(cache, "node_modules"), path.join(botApplication, "node_modules"), { recursive: true, dereference: true });
  for (const name of ["sql-http-child.cjs", "stop-drain-child.cjs"]) {
    const output = path.join(work, name);
    fs.copyFileSync(path.join(root, "tests/runtime", name), output); fs.chmodSync(output, 0o600);
  }
  let bot, beam, botExit, beamExit, runnerPid, failure, cleanup = false, deniedConnections = 0;
  const sockets = new Set();
  const denied = net.createServer(socket => {
    deniedConnections++; sockets.add(socket); socket.once("close", () => sockets.delete(socket));
  });
  const ownedExit = child => {
    const pending = new Promise((resolve, reject) => {
      child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
    });
    pending.catch(() => {}); return pending;
  };
  const pidAbsent = pid => {
    try { process.kill(pid, 0); return false; }
    catch (error) { if (error.code === "ESRCH") return true; throw error; }
  };
  try {
    const deniedPort = await listen(denied), retPort = await reservePort(), botPort = await reservePort();
    assert.equal(new Set([pgPort, deniedPort, retPort, botPort]).size, 4);
    const key = crypto.randomBytes(32).toString("hex");
    const botEnv = { PATH: "/usr/bin:/bin", HOME: path.join(work, "home"), TMPDIR: work, LANG: "C", LC_ALL: "C", TZ: "UTC",
      RET_LOCAL_STOP_DRAIN: "true", RUNNER_AUTOSTART: "false", YENHUBS_BOTS_ENABLED: "true", YENHUBS_AI_ENABLED: "true",
      HUBS_BASE_URL: "http://private-test.invalid", RET_INTERNAL_ENDPOINT: `http://127.0.0.1:${retPort}`,
      BOT_ORCHESTRATOR_ACCESS_KEY: key, OPENAI_API_KEY: "owned-synthetic-key-never-provider", OPENAI_MODEL: "gpt-6-luna",
      // No provider is contacted by either STOP case; even these unused URLs
      // point to the denied peer, never an external/default endpoint.
      OPENAI_ENDPOINT: `http://127.0.0.1:${deniedPort}/v1/responses`,
      OPENAI_MODERATION_ENDPOINT: `http://127.0.0.1:${deniedPort}/v1/moderations` };
    bot = spawn("/usr/bin/sandbox-exec", ["-p", integrationNetworkProfile([retPort, botPort]), process.execPath,
      path.join(work, "sql-http-child.cjs"), String(botPort), String(deniedPort)], {
      cwd: work, env: botEnv, stdio: ["ignore", log, log, "ipc"]
    });
    botExit = ownedExit(bot);
    const sendBot = childMessages(bot), started = await sendBot("start");
    assert.equal(started.denied, true); assert.equal(started.native_fetch, true); assert.equal(deniedConnections, 0);
    const get = async route => {
      const response = await fetch(`http://127.0.0.1:${botPort}${route}`, { signal: AbortSignal.timeout(2000) });
      return { status: response.status, body: await response.json() };
    };
    const health = async () => { const result = await get("/health"); assert.equal(result.status, 200); return result.body; };
    beam = spawn("/usr/bin/sandbox-exec", ["-p", integrationNetworkProfile([pgPort, botPort]), mix, "run", "--no-start", "--no-compile",
      path.join(root, "tests/runtime/reticulum-local.exs")], {
      cwd: application, env: { ...env, RET_LOCAL_HTTP_PORT: String(retPort), RET_LOCAL_BOT_PORT: String(botPort),
        RET_LOCAL_BOT_KEY: key, RET_LOCAL_DENIED_PORT: String(deniedPort) }, stdio: ["pipe", "pipe", log]
    });
    beamExit = ownedExit(beam);
    beam.stdin.on("error", () => { fs.writeSync(log, "OWNED_BEAM_INPUT_CLOSED\n"); });
    const waitStage = stageQueue(beam, log), seen = new Set();
    const acknowledge = line => { assert.equal(beam.exitCode, null); beam.stdin.write(`OWNED_SQL_HTTP:${line}\n`); };
    for (let index = 0; index < expected.length; index++) {
      const setup = await waitStage("setup", null), kind = setup.test_case;
      assert.ok(expected.includes(kind) && !seen.has(kind)); seen.add(kind);
      assert.ok(/^[A-Za-z0-9_-]{1,64}$/.test(setup.hub_sid));
      for (const field of ["real_http_client", "denied", "real_admission", "config_delivered"]) assert.equal(setup[field], true);
      if (kind === "bots-off-child") {
        const seed = await sendBot("seed-stop-runner", { hub_sid: setup.hub_sid, bots: setup.bots });
        assert.equal(seed.real_handle, true); assert.equal(seed.synthetic_runner_readiness, true);
        assert.ok(Number.isInteger(seed.runner_pid) && seed.runner_pid > 1); runnerPid = seed.runner_pid;
        assert.equal(pidAbsent(runnerPid), false);
        const on = await sendBot("sync"); assert.equal(on.authoritative, true);
        const ready = await get("/ready"); assert.equal(ready.status, 200); assert.equal(ready.body.ok, true);
        assert.deepEqual((await health()).modules, { bots_enabled: true, ai_enabled: true });
        acknowledge("ready");
        const off = await waitStage("off-committed", kind);
        for (const field of ["sql_committed_off", "distinct_sql_owners", "raw_cache_still_on", "no_sql_stop_from_global_off"]) assert.equal(off[field], true);
        const synced = await sendBot("sync"); assert.equal(synced.authoritative, true);
        const stopping = await sendBot("stopping-runner");
        assert.equal(stopping.runner_pid, runnerPid); assert.equal(stopping.lifecycle, "stopping");
        assert.equal(stopping.alive, true); assert.equal(stopping.removed, false); assert.equal(stopping.sigterm_count, 1);
        assert.equal(pidAbsent(runnerPid), false);
        const draining = await get("/ready");
        assert.equal(draining.status, 503); assert.equal(draining.body.ok, false);
        assert.equal(draining.body.stopping_hubs.length, 1); assert.equal(draining.body.process_hubs.length, 1);
        const during = await health(); assert.equal(during.runner_processes, 1);
        assert.deepEqual(during.modules, { bots_enabled: false, ai_enabled: false });
        const exited = await sendBot("release-runner-exit");
        assert.deepEqual(exited.exit, { code: 0, signal: null }); assert.equal(exited.lifecycle_finished, true);
        assert.equal(exited.real_pid_absent, true); assert.equal(exited.sigterm_count, 1); assert.equal(pidAbsent(runnerPid), true);
        // Existing exit handler is the removal oracle, not reset/delete seams.
        // Two explicit OFF resyncs test no replacement; no scheduler/ghost claim.
        for (let pass = 0; pass < 2; pass++) {
          assert.equal((await sendBot("sync")).authoritative, true);
          const stopped = await health(); assert.equal(stopped.runner_processes, 0); assert.equal(stopped.queued_rooms, 0);
          assert.deepEqual(stopped.modules, { bots_enabled: false, ai_enabled: false });
          const drained = await get("/ready"); assert.equal(drained.status, 200);
          assert.equal(drained.body.process_hubs.length, 0); assert.equal(drained.body.stopping_hubs.length, 0);
          assert.equal(pidAbsent(runnerPid), true);
        }
        acknowledge("off-synced-and-exited");
        const verified = await waitStage("verified", kind); assert.equal(verified.no_sql_stop_from_global_off, true);
        results.push({ test_case: kind, outcome: "PASS", real_sigterm_count: 1, ready_503_before_exit: true,
          real_pid_absent_before_cleanup: true, existing_exit_handler_removed_runner: true, no_respawn_after_two_off_resyncs: true });
      } else {
        acknowledge("producer-ready");
        const verified = await waitStage("verified", kind);
        for (const field of ["delivered_at_null", "actual_dispatcher_restart", "distinct_claim_owners", "backoff_preserved", "dispatcher_installed_while_off"]) assert.equal(verified[field], true);
        assert.equal(verified.status, 202); assert.equal(verified.attempts, 2); assert.equal(verified.hub_sid, setup.hub_sid);
        assert.ok(Number.isSafeInteger(verified.runtime_revision) && verified.runtime_revision > 1);
        assert.ok(Number.isSafeInteger(verified.revoke_epoch) && verified.revoke_epoch > 0);
        const payload = { protocol: "yenhubs-bot-runtime-v2", operation_id: verified.operation_id,
          hub_sid: setup.hub_sid, runtime_revision: verified.runtime_revision, revoke_epoch: verified.revoke_epoch };
        const observed = await sendBot("stop-events"), events = observed.events.filter(event => event.payload.operation_id === payload.operation_id);
        assert.ok(events.length >= 2, "two actual default-dispatcher HTTP attempts");
        for (const event of events) { assert.equal(event.status, 202); assert.deepEqual(event.payload, payload); }
        // Real idempotent replay observes the response body; no fabricated ACK
        // or Kubernetes proof is installed, including after dispatcher restart.
        const replay = await fetch(`http://127.0.0.1:${botPort}/internal/bots/room-stop`, {
          method: "POST", headers: { "content-type": "application/json", "x-ret-bot-orchestrator-access-key": key },
          body: JSON.stringify(payload), signal: AbortSignal.timeout(2000)
        });
        assert.equal(replay.status, 202); assert.deepEqual(await replay.json(), { ...payload, state: "pending" });
        results.push({ test_case: kind, outcome: "PASS", status: 202, delivered_at_null: true,
          actual_dispatcher_restart: true, attempts: verified.attempts, exact_identity_retained: true,
          real_backoff_preserved: true, no_kubernetes_absence_proof: true });
      }
      assert.equal(deniedConnections, 0); acknowledge("verified");
    }
    assert.deepEqual([...seen].sort(), [...expected].sort());
    assert.deepEqual(await bounded(beamExit, "owned_beam_exit_timeout", 10000), { code: 0, signal: null });
    assert.equal(fs.readFileSync(path.join(application, "local-result-sql-http-stop-drain.txt"), "utf8"), "2/2\n");
    await sendBot("shutdown");
    assert.deepEqual(await bounded(botExit, "owned_bot_exit_timeout"), { code: 0, signal: null });
    assert.equal(pidAbsent(runnerPid), true); cleanup = true;
  } catch (error) {
    failure = error;
    fs.writeSync(log, String(error.stack) + "\n"); throw error;
  } finally {
    await finishStopDrainCleanup({
      actorCleanups: [[beam, beamExit], [bot, botExit]].map(([child, exited]) => async () => {
        if (child && child.exitCode === null && child.signalCode === null) {
          child.stdin?.end(); child.kill("SIGTERM");
          try { await bounded(exited, "owned_child_cleanup_timeout", 3000); }
          catch { child.kill("SIGKILL"); await bounded(exited, "owned_child_forced_cleanup_timeout", 3000); }
        }
      }),
      verifyRunnerAbsent: async () => {
        // The owned IPC fixture exits on parent disconnect even on failure;
        // verify its PID, never a removed test-state entry.
        if (runnerPid !== undefined) {
          const deadline = performance.now() + 3000;
          while (!pidAbsent(runnerPid) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
          assert.equal(pidAbsent(runnerPid), true, "owned runner cleanup");
        }
      },
      releaseSockets: () => { for (const socket of sockets) socket.destroy(); },
      closeListener: async () => {
        if (denied.listening) await bounded(new Promise(resolve => denied.close(resolve)), "owned_listener_cleanup_timeout", 2000);
      }
    }, failure);
    cleanup &&= !denied.listening;
  }
  assert.equal(cleanup, true); assert.equal(deniedConnections, 0);
  const sourceAfter = snapshot(); assert.deepEqual(sourceAfter, sourceBefore);
  return { scope: "actual-admission-SQL-HTTP-local-child-STOP-pending-not-ghost-scheduler-Kubernetes",
    results, source_before: sourceBefore, source_after: sourceAfter, source_unchanged_clean: true,
    denied_connections: deniedConnections, cleanup, elapsed_ms: Math.round(performance.now() - began) };
}

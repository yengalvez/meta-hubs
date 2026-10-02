// ONE opt-in integrated canary on the existing owned Reticulum native runner.
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
  assert.equal(env.RET_LOCAL_PROFILE, "sql-http-canary");
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
    for (let index = 0; index < 2; index++) {
      const setup = await waitStage("setup", null), testCase = setup.test_case;
      assert.ok(["positive", "chat-off"].includes(testCase) && !seen.has(testCase)); seen.add(testCase);
      assert.ok(/^[A-Za-z0-9_-]{1,64}$/.test(setup.hub_sid));
      assert.equal(setup.real_http_client, true); assert.equal(setup.denied, true);
      current = { calls: [], held: deferred(), closed: deferred(), response: null };
      const seed = await sendBot("seed", { hub_sid: setup.hub_sid, bots: setup.bots });
      assert.equal(seed.synthetic_readiness, true);
      const on = await sendBot("sync");
      assert.equal(on.authoritative, true); assert.equal(on.count, 1); assert.equal(on.ready, true);
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
        current.response.writeHead(200, { "content-type": "application/json" });
        current.response.end(JSON.stringify({ status: "completed", output_text: JSON.stringify({ reply: "owned integrated reply" }) }));
        acknowledge("released");
      }
      const verified = await waitStage("verified", testCase);
      assert.equal(verified.no_command, true); assert.equal(verified.no_old_reply, testCase === "chat-off");
      assert.equal(verified.status, testCase === "positive" ? 200 : 502);
      assert.deepEqual(current.calls, testCase === "positive"
        ? ["/v1/moderations", "/v1/responses", "/v1/moderations"] : ["/v1/moderations", "/v1/responses"]);
      assert.equal(deniedConnections, 0);
      results.push({ test_case: testCase, outcome: "PASS", actual_provider_phases: current.calls.length,
        ...(elapsed === undefined ? {} : { snapshot_to_socket_close_ms: elapsed, socket_unfinished_before_cleanup: true }) });
      acknowledge("verified");
    }
    assert.deepEqual([...seen].sort(), ["chat-off", "positive"]);
    assert.deepEqual(await bounded(beamExit, "owned_beam_exit_timeout", 10000), { code: 0, signal: null });
    assert.equal(fs.readFileSync(path.join(application, "local-result-sql-http-canary.txt"), "utf8"), "2/2\n");
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

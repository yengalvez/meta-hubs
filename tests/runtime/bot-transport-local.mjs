// Opt-in macOS native HTTP cancellation sample; no public/paid provider,
// Kubernetes, default DB, complete runner/profile or deployment acceptance.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const relativeBot = "community-edition/services/bot-orchestrator";
const cloud = path.join(root, "hubs-cloud");
const source = path.join(cloud, relativeBot);
const sha = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const fail = code => { throw new Error(code); };

export function transportCases(mode) {
  if (mode === "--canary") return [
    { name: "positive-model", phase: 2, transition: "positive" },
    { name: "ai-off-model", phase: 2, transition: "ai-off" }
  ];
  if (mode === "--boundaries") return [
    { name: "ai-off-input", phase: 1, transition: "ai-off" },
    { name: "ai-off-output", phase: 3, transition: "ai-off" },
    { name: "off-on-model", phase: 2, transition: "off-on" },
    { name: "disconnect-model", phase: 2, transition: "disconnect" }
  ];
  fail("explicit_transport_target_required");
}

export function outboundProfile(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) fail("invalid_owned_port");
  return `(version 1)(allow default)(deny network*)(allow network-bind(local ip "localhost:*"))(allow network-inbound(local ip "localhost:*"))(allow network-outbound(remote ip "localhost:${port}"))`;
}

const listen = server => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen({ host: "127.0.0.1", port: 0 }, () => resolve(server.address().port));
});
const bounded = (promise, label, ms = 5000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  })]).finally(() => clearTimeout(timer));
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // A failure before the matching phase wait must not be an unhandled rejection.
  promise.catch(() => {});
  return { promise, resolve, reject };
};

async function main() {
  const args = process.argv.slice(2);
  let work, log;
  let phase = "arguments", outcome = "FAIL";
  const started = performance.now(), results = [];
  const receipt = () => {
    if (work) fs.writeFileSync(path.join(work, "summary.json"), JSON.stringify({
      scope: "native-loopback-http-synthetic-provider-and-readiness-not-production",
      phase, outcome, node: process.version, results,
      elapsed_ms: Math.round(performance.now() - started)
    }, null, 2) + "\n", { mode: 0o600 });
  };
  try {
    if (process.platform !== "darwin" || args.length !== 3 || args[1] !== "--cache-bot-orchestrator") {
      fail("explicit_transport_target_required");
    }
    const cases = transportCases(args[0]);
    const cache = fs.realpathSync(args[2]);
    for (const name of ["package.json", "package-lock.json"]) {
      if (sha(path.join(cache, name)) !== sha(path.join(source, name))) fail("cache_source_mismatch");
    }
    fs.accessSync("/usr/bin/sandbox-exec", fs.constants.X_OK);
    work = fs.mkdtempSync("/private/tmp/ynbot-http-"); fs.chmodSync(work, 0o700);
    fs.mkdirSync(path.join(work, "home"), { mode: 0o700 });
    log = fs.openSync(path.join(work, "private.log"), "wx", 0o600);
    phase = "materialize-owned-source-and-cache"; receipt();
    const application = path.join(work, "bot-orchestrator");
    const tracked = spawnSync("/usr/bin/git", ["-C", cloud, "ls-files", "-z", "--", relativeBot], {
      encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, timeout: 5000
    });
    if (tracked.status !== 0) fail("source_inventory_failed");
    for (const file of tracked.stdout.split("\0").filter(Boolean)) {
      const relative = file.slice(relativeBot.length + 1);
      const input = path.join(cloud, file), output = path.join(application, relative);
      if (!relative || relative.startsWith("../") || !fs.lstatSync(input).isFile()) fail("unsafe_source");
      fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 }); fs.copyFileSync(input, output);
    }
    if (!fs.existsSync(path.join(application, "app.js"))) fail("missing_current_app");
    fs.cpSync(path.join(cache, "node_modules"), path.join(application, "node_modules"), {
      recursive: true, dereference: true
    });
    fs.copyFileSync(path.join(root, "tests/runtime/bot-transport-child.cjs"), path.join(work, "child.cjs"));
    for (const testCase of cases) {
      phase = `http-${testCase.name}`; receipt(); process.stdout.write(`BOT_HTTP_STAGE:${phase}\n`);
      results.push(await runCase(testCase, work, log)); receipt();
    }
    assert.equal(results.length, cases.length);
    assert.ok(results.every(result => result.outcome === "PASS" && result.cleanup));
    outcome = "PASS";
  } catch (error) {
    process.exitCode = 1;
    process.stderr.write(`BOT_HTTP_FAIL:${phase}:${/^[a-z0-9_-]+$/.test(error.message) ? error.message : "inspect_private_log"}\n`);
    if (log !== undefined) fs.writeSync(log, String(error.stack) + "\n");
  } finally {
    phase = "terminal"; receipt(); if (log !== undefined) fs.closeSync(log);
    if (work) process.stdout.write(`BOT_HTTP_RESULT:${outcome}:cases=${results.length}:scratch=${work}\n`);
  }
}

async function runCase(testCase, work, log) {
  const began = performance.now();
  const held = deferred(), heldClosed = deferred(), failedProvider = deferred();
  const providerCalls = [], sockets = new Set(), deniedSockets = new Set();
  let heldResponse, heldSocket, heldUnfinished = false, heldClosedAt, deniedConnections = 0;
  let child, childExit, childReady, childStopped, childTransitioned;
  let request, apiPort, requestController, childStoppedNormally = false, cleanup = false;
  let result, firstFailure;
  const reply = res => {
    const payload = res.req.url === "/v1/moderations"
      ? { results: [{ flagged: false }] }
      : { status: "completed", output_text: JSON.stringify({ reply: "owned synthetic reply" }) };
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(payload));
  };
  const provider = http.createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST");
      assert.ok(["/v1/moderations", "/v1/responses"].includes(req.url));
      let body = "";
      for await (const chunk of req) { body += chunk; assert.ok(Buffer.byteLength(body) <= 32768); }
      const decoded = JSON.parse(body);
      if (req.url === "/v1/responses") assert.equal(decoded.store, false);
      providerCalls.push(req.url);
      if (providerCalls.length === testCase.phase) {
        heldResponse = res; heldSocket = req.socket;
        res.once("close", () => {
          heldUnfinished = !res.writableFinished; heldClosedAt = performance.now(); heldClosed.resolve();
        });
        held.resolve();
      } else { reply(res); }
    } catch (error) {
      failedProvider.reject(error); held.reject(error); res.destroy();
    }
  });
  provider.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  const denied = net.createServer(socket => {
    deniedConnections++; deniedSockets.add(socket); socket.once("close", () => deniedSockets.delete(socket));
  });
  try {
    const providerPort = await listen(provider), deniedPort = await listen(denied);
    const reserve = net.createServer(); apiPort = await listen(reserve);
    await new Promise(resolve => reserve.close(resolve));
    const accessKey = crypto.randomBytes(32).toString("hex");
    childReady = deferred(); childStopped = deferred(); childTransitioned = deferred();
    const env = {
      PATH: "/usr/bin:/bin", HOME: path.join(work, "home"), TMPDIR: work,
      LC_ALL: "C", LANG: "C", TZ: "UTC", RUNNER_AUTOSTART: "false",
      YENHUBS_BOTS_ENABLED: "true", YENHUBS_AI_ENABLED: "true",
      HUBS_BASE_URL: "http://private-test.invalid", RET_INTERNAL_ENDPOINT: "http://private-test.invalid",
      BOT_ORCHESTRATOR_ACCESS_KEY: accessKey, OPENAI_API_KEY: "owned-synthetic-key-never-provider",
      OPENAI_MODEL: "gpt-6-luna",
      OPENAI_ENDPOINT: `http://127.0.0.1:${providerPort}/v1/responses`,
      OPENAI_MODERATION_ENDPOINT: `http://127.0.0.1:${providerPort}/v1/moderations`
    };
    child = spawn("/usr/bin/sandbox-exec", ["-p", outboundProfile(providerPort), process.execPath,
      path.join(work, "child.cjs"), String(apiPort), String(deniedPort)], {
      cwd: work, env, stdio: ["ignore", log, log, "ipc"]
    });
    childExit = new Promise(resolve => child.once("exit", (code, signal) => {
      childReady.reject(new Error("owned_child_exited_before_ready"));
      childTransitioned.reject(new Error("owned_child_exited_before_transition"));
      childStopped.reject(new Error("owned_child_exited_before_stop"));
      resolve({ code, signal });
    }));
    child.once("error", error => childReady.reject(error));
    child.on("message", message => {
      if (message?.pid !== child.pid) { childReady.reject(new Error("child_identity_mismatch")); return; }
      if (message.type === "ready") childReady.resolve(message);
      else if (message.type === "transitioned") childTransitioned.resolve(message);
      else if (message.type === "stopped") childStopped.resolve(message);
      else if (message.type === "failed") childReady.reject(new Error(message.code));
    });
    const ready = await bounded(childReady.promise, "owned_child_ready_timeout");
    assert.equal(ready.port, apiPort); assert.equal(ready.denied, true); assert.equal(ready.native_fetch, true);
    assert.equal(deniedConnections, 0);
    requestController = new AbortController();
    request = fetch(`http://127.0.0.1:${apiPort}/internal/bots/chat`, {
      method: "POST", signal: requestController.signal,
      headers: { "content-type": "application/json", "x-ret-bot-orchestrator-access-key": accessKey },
      body: JSON.stringify({ hub_sid: "owned-transport", bot_id: "bot-1", requester_id: "owned-test",
        message: "hola", context: { waypoints: [] } })
    });
    request.catch(() => {});
    await bounded(Promise.race([held.promise, failedProvider.promise]), "provider_not_reached");
    const expectedPrefix = ["/v1/moderations", "/v1/responses", "/v1/moderations"].slice(0, testCase.phase);
    assert.deepEqual(providerCalls, expectedPrefix);
    assert.equal(heldResponse.writableFinished, false);
    assert.equal(heldSocket.destroyed, false);
    let settled = false; request.finally(() => { settled = true; }).catch(() => {});
    await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
    if (testCase.transition === "positive") {
      reply(heldResponse);
      const response = await bounded(request, "positive_response_timeout");
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { reply: "owned synthetic reply", action: null });
      assert.deepEqual(providerCalls, ["/v1/moderations", "/v1/responses", "/v1/moderations"]);
    } else {
      const beforeRevocation = performance.now();
      if (testCase.transition === "disconnect") requestController.abort();
      else {
        child.send({ type: testCase.transition });
        const changed = await bounded(childTransitioned.promise, "off_transition_timeout", 2000);
        assert.equal(changed.operation, testCase.transition);
      }
      await bounded(heldClosed.promise, "held_transport_not_closed", 2000);
      assert.equal(heldUnfinished, true); assert.equal(heldSocket.destroyed, true);
      if (testCase.transition === "disconnect") {
        await assert.rejects(bounded(request, "disconnect_result_timeout", 2000), { name: "AbortError" });
      } else {
        const response = await bounded(request, "revoked_response_timeout", 2000);
        assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "ai_unavailable" });
      }
      assert.deepEqual(providerCalls, expectedPrefix);
      result = { revocation_to_transport_close_ms: Math.round(heldClosedAt - beforeRevocation), transport_closed_unfinished: true };
    }
    assert.equal(deniedConnections, 0);
    result = { name: testCase.name, outcome: "PASS", provider_phases: providerCalls.length,
      denied_connections: deniedConnections, ...result };
  } catch (error) {
    firstFailure = error;
    throw error;
  } finally {
    // Owned requests first, then owned child API, then owned stub sockets.
    requestController?.abort();
    if (request) await request.catch(() => {});
    if (child && child.exitCode === null && child.signalCode === null) {
      child.send({ type: "shutdown" });
      try {
        await bounded(childStopped.promise, "owned_child_stop_timeout", 2000);
        const exit = await bounded(childExit, "owned_child_exit_timeout", 2000);
        assert.deepEqual(exit, { code: 0, signal: null }); childStoppedNormally = true;
      } catch {
        child.kill("SIGTERM"); await bounded(childExit, "owned_child_forced_exit_timeout", 3000);
      }
    }
    for (const socket of sockets) socket.destroy();
    for (const socket of deniedSockets) socket.destroy();
    for (const server of [provider, denied]) {
      if (server.listening) await bounded(new Promise(resolve => server.close(resolve)), "owned_stub_stop_timeout", 2000);
    }
    cleanup = childStoppedNormally && !provider.listening && !denied.listening;
    if (!cleanup) {
      fs.writeSync(log, "OWNED_HTTP_CLEANUP_NOT_VERIFIED\n");
      if (!firstFailure) fail("owned_http_cleanup_not_verified");
    }
  }
  return { ...result, cleanup, elapsed_ms: Math.round(performance.now() - began) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

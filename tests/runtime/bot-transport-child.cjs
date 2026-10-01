// Only bot-transport-local.mjs's sanitized, confined, synthetic child target.
// No default environment, Kubernetes, real runner or public provider is used.
const assert = require("node:assert/strict");
const { app, internals } = require("./bot-orchestrator/app.js");
const nativeFetch = global.fetch;
const [portText, deniedText] = process.argv.slice(2);
const port = Number(portText), deniedPort = Number(deniedText);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
assert.ok(Number.isInteger(deniedPort) && deniedPort >= 1024 && deniedPort <= 65535);
assert.equal(process.env.RUNNER_AUTOSTART, "false");
assert.equal(process.env.RET_INTERNAL_ENDPOINT, "http://private-test.invalid");
assert.ok(process.send);
internals.validateRuntimeConfiguration();

let server;
const send = message => process.send({ ...message, pid: process.pid });
const bots = { enabled: true, chat_enabled: true, count: 1, mobility: "static" };

async function start() {
  // This is a readiness FIXTURE, not an authenticated real runner. It selects
  // the existing chat/provider path without claiming STOP/Kubernetes readiness.
  assert.equal(internals.seedReadyRoomForTests("owned-transport", bots), true);
  server = app.listen(port, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve); server.once("error", reject);
  });
  assert.equal(server.address().address, "127.0.0.1");
  // Prove the outbound rule against an ACTUAL listening denied peer. This
  // request must fail AND the peer's independent connection count must be zero.
  let denied = false;
  try { await nativeFetch(`http://127.0.0.1:${deniedPort}/denied`, { signal: AbortSignal.timeout(1500) }); }
  catch { denied = true; }
  assert.equal(denied, true);
  assert.equal(global.fetch, nativeFetch);
  send({ type: "ready", port, denied: true, native_fetch: true });
}

process.on("message", message => {
  if (message?.type === "ai-off" || message?.type === "off-on") {
    internals.applyModuleCapabilities({ bots_enabled: true, ai_enabled: false });
    if (message.type === "off-on") {
      internals.applyModuleCapabilities({ bots_enabled: true, ai_enabled: true });
    }
    send({ type: "transitioned", operation: message.type });
  } else if (message?.type === "shutdown") {
    // The parent first reconciles its requests/owned sockets. Only then stop
    // this owned child server; never terminate an unrelated PID/service.
    internals.resetRuntimeStateForTests();
    server.close(error => {
      if (error) process.exitCode = 1;
      send({ type: "stopped" });
      process.disconnect();
    });
    server.closeAllConnections();
  } else {
    send({ type: "failed", code: "unknown_owned_message" });
    process.exitCode = 1;
  }
});

start().catch(() => { send({ type: "failed", code: "owned_child_start" }); process.exit(1); });

// Confined local canary child; source app and native fetch are not replaced.
const assert = require("node:assert/strict");
const { app, internals } = require("./bot-orchestrator/app.js");
const nativeFetch = global.fetch;
const [port, deniedPort] = process.argv.slice(2).map(Number);
for (const value of [port, deniedPort]) assert.ok(Number.isInteger(value) && value >= 1024 && value <= 65535);
assert.equal(process.env.RUNNER_AUTOSTART, "false");
assert.match(process.env.RET_INTERNAL_ENDPOINT, /^http:\/\/127\.0\.0\.1:[0-9]{4,5}$/);
assert.ok(process.send);
internals.validateRuntimeConfiguration();
let server, busy = false;
const send = (message, response) => process.send({ id: message.id, type: message.type, pid: process.pid, ok: true, ...response });
process.on("message", async message => {
  try {
    assert.equal(busy, false); busy = true;
    assert.equal(global.fetch, nativeFetch);
    if (message.type === "start") {
      assert.equal(server, undefined);
      server = app.listen(port, "127.0.0.1");
      await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
      assert.equal(server.address().address, "127.0.0.1");
      let denied = false;
      try { await nativeFetch(`http://127.0.0.1:${deniedPort}/denied`, { signal: AbortSignal.timeout(1500) }); }
      catch { denied = true; }
      assert.equal(denied, true); send(message, { port, denied, native_fetch: true });
    } else if (message.type === "seed") {
      // Only readiness is seeded. Authoritative capabilities/config below
      // MUST come from real authenticated HTTP + SQL, not this fixture.
      internals.resetRuntimeStateForTests();
      assert.equal(internals.seedReadyRoomForTests(message.hub_sid, message.bots), true);
      send(message, { synthetic_readiness: true });
    } else if (message.type === "sync") {
      const synced = await internals.syncActiveRoomsFromReticulum();
      assert.equal(synced.ok, true); assert.equal(synced.authoritative, true);
      send(message, { authoritative: synced.authoritative, count: synced.count,
        ready: internals.runnerReadinessSnapshot().ok });
    } else if (message.type === "shutdown") {
      internals.resetRuntimeStateForTests();
      await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
      send(message, {}); process.disconnect();
    } else { throw new Error("unknown_owned_message"); }
  } catch (error) {
    process.send({ id: message.id, type: "failed", pid: process.pid, ok: false });
    console.error(error.stack); process.exitCode = 1;
  } finally { busy = false; }
});

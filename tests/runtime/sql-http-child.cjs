// Confined local canary child; source app and native fetch are not replaced.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const crypto = require("node:crypto");
const { app, internals } = require("./bot-orchestrator/app.js");
const nativeFetch = global.fetch;
const [port, deniedPort] = process.argv.slice(2).map(Number);
for (const value of [port, deniedPort]) assert.ok(Number.isInteger(value) && value >= 1024 && value <= 65535);
assert.equal(process.env.RUNNER_AUTOSTART, "false");
assert.match(process.env.RET_INTERNAL_ENDPOINT, /^http:\/\/127\.0\.0\.1:[0-9]{4,5}$/);
assert.ok(process.send);
internals.validateRuntimeConfiguration();
let server, busy = false, ownedRunner;
const stopEvents = [];
const bounded = promise => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("owned_runner_timeout")), 3000);
  })]).finally(() => clearTimeout(timer));
};
const runnerAlive = () => {
  assert.ok(ownedRunner);
  try { process.kill(ownedRunner.child.pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
};
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
      if (process.env.RET_LOCAL_STOP_DRAIN === "true") {
        // Observe actual dispatcher HTTP without replacing Express, fetch,
        // auth, response bytes or the product STOP proof.
        server.prependListener("request", (req, res) => {
          if (req.method !== "POST" || req.url !== "/internal/bots/room-stop") return;
          let body = "";
          req.on("data", chunk => { body += chunk; assert.ok(Buffer.byteLength(body) <= 8192); });
          res.once("finish", () => {
            assert.ok(stopEvents.length < 64);
            stopEvents.push({ status: res.statusCode, payload: JSON.parse(body) });
          });
        });
      }
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
      send(message, { authoritative: synced.authoritative, count: synced.count });
    } else if (message.type === "seed-stop-runner") {
      assert.equal(process.env.RET_LOCAL_STOP_DRAIN, "true");
      assert.equal(ownedRunner, undefined);
      const bots = internals.normalizeConfig(message.bots), now = Date.now();
      const child = spawn(process.execPath, [path.join(__dirname, "stop-drain-child.cjs"), "owned-stop-drain"], {
        cwd: __dirname, env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
          LANG: "C", LC_ALL: "C", TZ: "UTC" }, stdio: ["ignore", "inherit", "inherit", "ipc"]
      });
      let signalResolve, spawnResolve;
      const signalled = new Promise(resolve => { signalResolve = resolve; });
      const spawned = new Promise(resolve => { spawnResolve = resolve; });
      const exited = new Promise((resolve, reject) => {
        child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
      });
      exited.catch(() => {});
      const info = { backend: "ghost", lifecycle: "running", spawned: true, ipcConnected: true,
        processGeneration: crypto.randomUUID(), process: child,
        configFingerprint: internals.runnerConfigFingerprint(bots), configRevision: 1,
        pendingConfigFingerprint: null, pendingConfigRevision: null, desiredBots: bots.count, activeBots: bots.count,
        authenticated: true, authoritativeSpawnAcks: true, navigationStatus: "ready", botStatusReason: "ready",
        lastRuntimeStatusAt: now, startedAt: Math.max(1, now - 1000), readySince: Math.max(1, now - 1000), ready: true };
      assert.equal(internals.setRunnerStateForTests(message.hub_sid, info), true);
      const lifecycle = internals.attachRunnerLifecycleHandlers(message.hub_sid, info, child);
      ownedRunner = { child, info, lifecycle, signalled, exited, signals: 0 };
      child.on("message", event => {
        assert.equal(event.pid, child.pid);
        if (event.type === "spawned") spawnResolve(event);
        else { assert.equal(event.type, "sigterm"); ownedRunner.signals = event.signals; signalResolve(event); }
      });
      await bounded(spawned);
      assert.equal(runnerAlive(), true);
      send(message, { synthetic_runner_readiness: true, real_handle: true, runner_pid: child.pid });
    } else if (message.type === "stopping-runner") {
      assert.equal(process.env.RET_LOCAL_STOP_DRAIN, "true");
      await bounded(ownedRunner.signalled);
      assert.equal(ownedRunner.signals, 1);
      assert.equal(ownedRunner.info.lifecycle, "stopping");
      assert.equal(ownedRunner.info.ready, false);
      assert.equal(ownedRunner.lifecycle.isFinished(), false);
      assert.equal(runnerAlive(), true);
      send(message, { lifecycle: "stopping", ready: false, alive: true, sigterm_count: 1,
        runner_pid: ownedRunner.child.pid, removed: false });
    } else if (message.type === "release-runner-exit") {
      assert.equal(process.env.RET_LOCAL_STOP_DRAIN, "true");
      assert.equal(ownedRunner.info.lifecycle, "stopping");
      ownedRunner.child.send({ type: "release-exit" });
      const exit = await bounded(ownedRunner.exited);
      assert.deepEqual(exit, { code: 0, signal: null });
      assert.equal(ownedRunner.lifecycle.isFinished(), true);
      assert.equal(runnerAlive(), false);
      send(message, { exit, real_pid_absent: true, lifecycle_finished: true, sigterm_count: ownedRunner.signals });
    } else if (message.type === "stop-events") {
      assert.equal(process.env.RET_LOCAL_STOP_DRAIN, "true");
      send(message, { events: stopEvents });
    } else if (message.type === "shutdown") {
      if (process.env.RET_LOCAL_STOP_DRAIN === "true" && ownedRunner) assert.equal(runnerAlive(), false);
      internals.resetRuntimeStateForTests();
      await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
      send(message, {}); process.disconnect();
    } else { throw new Error("unknown_owned_message"); }
  } catch (error) {
    process.send({ id: message.id, type: "failed", pid: process.pid, ok: false });
    console.error(error.stack); process.exitCode = 1;
  } finally { busy = false; }
});

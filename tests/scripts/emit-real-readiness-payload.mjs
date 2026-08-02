#!/usr/bin/env node

// Emits one HTTP 200 /ready payload from the real bot-orchestrator handler.
// The root shell gate consumes this JSON so its contract cannot drift from an
// invented fixture.

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const appPath = process.env.READINESS_APP_PATH
  ? path.resolve(process.env.READINESS_APP_PATH)
  : path.join(root, "hubs-cloud/community-edition/services/bot-orchestrator/app.js");

process.env.BOT_RUNNER_ACCESS_KEY = "root-contract-test-runner-key-32-chars";
process.env.BOT_ORCHESTRATOR_ACCESS_KEY = "root-contract-test-orchestrator-key-32-chars";
process.env.OPENAI_API_KEY = "";
process.env.RUNNER_AUTOSTART = "false";

const require = createRequire(import.meta.url);
const originalLog = console.log;
console.log = () => {};
const { startServer, internals } = require(appPath);
const requiredInternals = [
  "applyGhostAuthStatus",
  "applyGhostRuntimeStatus",
  "runnerConfigFingerprint",
  "setRunnerStateForTests",
  "syncActiveRoomsFromReticulum",
  "resetRuntimeStateForTests"
];
for (const name of requiredInternals) {
  if (typeof internals?.[name] !== "function") {
    throw new Error(`Real readiness contract helper is missing: ${name}`);
  }
}

internals.resetRuntimeStateForTests();
const server = startServer(0);
if (!server.listening) await new Promise(resolve => server.once("listening", resolve));

try {
  const hubSid = "root-contract-room";
  const bots = { enabled: true, count: 1, mobility: "static", chat_enabled: false, prompt: "" };
  await internals.syncActiveRoomsFromReticulum({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ hubs: [{ hub_sid: hubSid, runtime_revision: 1, bots }] })
    })
  });

  const now = Date.now();
  const fingerprint = internals.runnerConfigFingerprint(bots);
  const processGeneration = randomUUID();
  const runner = {
    backend: "ghost",
    lifecycle: "starting",
    spawned: true,
    ipcConnected: true,
    processGeneration,
    process: { pid: 4242, connected: true, kill: () => true },
    configFingerprint: fingerprint,
    configRevision: 1,
    pendingConfigFingerprint: null,
    pendingConfigRevision: null,
    desiredBots: 1,
    activeBots: 0,
    authenticated: false,
    authoritativeSpawnAcks: false,
    ready: false,
    navigationStatus: "pending",
    botStatusReason: "pending",
    startedAt: now,
    lastRuntimeStatusAt: 0
  };
  internals.applyGhostAuthStatus(runner, { authenticated: true, processGeneration });
  const accepted = internals.applyGhostRuntimeStatus(
    runner,
    {
      desired: 1,
      active: 1,
      authenticated: true,
      authoritativeSpawnAcks: true,
      navigationReady: true,
      ready: true,
      reason: "ready",
      configFingerprint: fingerprint,
      configRevision: 1,
      processGeneration
    },
    now
  );
  if (!accepted) {
    throw new Error("Could not apply the authoritative runtime fixture in the real handler");
  }
  if (!internals.setRunnerStateForTests(hubSid, runner)) {
    throw new Error("Could not install the authoritative runner fixture in the real handler");
  }

  const response = await fetch(`http://127.0.0.1:${server.address().port}/ready`);
  const payload = await response.text();
  if (response.status !== 200) {
    throw new Error(`Real /ready returned HTTP ${response.status}: ${payload}`);
  }
  process.stdout.write(payload);
} finally {
  internals.resetRuntimeStateForTests();
  await new Promise((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve()))
  );
  console.log = originalLog;
}

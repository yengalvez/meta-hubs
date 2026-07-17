import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { setMaxListeners } from "node:events";
import { link, lstat, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { cpus, freemem, totalmem } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { promisify } from "node:util";
import { invalid } from "./errors.mjs";
import { CAPACITY_ROOT, canonicalJson, readNdjsonFile, resolveContainedPath } from "./io.mjs";
import {
  METRIC_CONTRACTS,
  expectedCollectors,
  expectedThresholdMetrics,
  requiredRawContracts
} from "./metric-contracts.mjs";
import {
  collectorCoverageWindow,
  deriveRawAggregate,
  makeRawSample,
  rawArtifact
} from "./provenance.mjs";
import { buildReport } from "./report.mjs";
import { validateEnvironmentSnapshot } from "./model.mjs";
import { validatePlan } from "./plan-contract.mjs";
import { assertExecutionSafety } from "./safety.mjs";
import { assertAllowedBrowserUrl } from "./security.mjs";
import { StopMonitor } from "./stop-monitor.mjs";
import { computeTrackedTreeIdentity } from "./integrity.mjs";
import {
  loadProductionSignerFromEnvironment,
  signAndVerifyDocument,
  signedDocumentBinding,
  verifySignedDocument
} from "./trust.mjs";
import {
  validateTrackedCollectorMappingIdentity
} from "./collector-contract.mjs";
import { validatePhysicalGeneratorInventory } from "./physical-readiness.mjs";
import {
  OBSERVABILITY_METRIC_CONTRACTS,
  derivePrometheusSemanticValue
} from "./observability-contract.mjs";

const DRIVER_VERSION = "1.0.0";
const SERVER_COLLECTORS = new Set([
  "reticulum",
  "load-balancer",
  "kubernetes",
  "database",
  "coturn",
  "dialog",
  "bots"
]);
const MOBILE_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 14; YenHubs Capacity Mobile) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36";
const MAX_RAW_SAMPLES = 500_000;
const MAX_RAW_BYTES = 256 * 1024 * 1024;
const execFileAsync = promisify(execFile);

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function canonicalIso(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function dimensions(plan, collector, location = {}) {
  return {
    roomId: location.roomId ?? "all",
    workerId: location.workerId ?? "all",
    participantId: location.participantId ?? "all",
    service: location.service ?? (collector === "client" ? "hubs-client" : collector),
    instance: location.instance ?? ((collector === "client" || collector === "webrtc") ? location.workerId : "unknown"),
    clientProfile: plan.scenario.clientProfile,
    audioMode: plan.scenario.audioMode,
    transportMode: plan.scenario.transportMode,
    phase: location.phase ?? "plateau"
  };
}

function phaseForTick(plan, startedAtMs, tickMs) {
  const offsetSeconds = (tickMs - startedAtMs) / 1000;
  if (offsetSeconds < plan.workload.rampUp.durationSeconds) return "ramp-up";
  if (offsetSeconds <= plan.workload.rampUp.durationSeconds + plan.workload.plateau.durationSeconds) return "plateau";
  return "ramp-down";
}

function measuredPopulation(intervals) {
  const changes = new Map();
  let participantMilliseconds = 0;
  for (const interval of intervals) {
    if (interval.end <= interval.start) continue;
    changes.set(interval.start, (changes.get(interval.start) ?? 0) + 1);
    changes.set(interval.end, (changes.get(interval.end) ?? 0) - 1);
    participantMilliseconds += interval.end - interval.start;
  }
  let concurrent = 0;
  let peak = 0;
  for (const time of [...changes.keys()].sort((left, right) => left - right)) {
    concurrent += changes.get(time);
    peak = Math.max(peak, concurrent);
  }
  return { peak, participantSeconds: participantMilliseconds / 1000 };
}

function participantDefinitions(plan) {
  const result = [];
  for (const room of plan.rooms) {
    for (const worker of room.workers) {
      for (let offset = 0; offset < worker.participantCount; offset += 1) {
        result.push({
          room,
          worker,
          roomId: room.id,
          workerId: worker.id,
          participantId: `participant-${String(worker.participantStart + offset).padStart(6, "0")}`,
          ordinal: worker.participantStart + offset
        });
      }
    }
  }
  return result;
}

function timeline(plan, startedAtMs, intervalSeconds) {
  const offsets = new Set([0, plan.scenario.durationSeconds]);
  for (let offset = 0; offset <= plan.scenario.durationSeconds; offset += intervalSeconds) offsets.add(offset);
  offsets.add(plan.workload.rampUp.durationSeconds);
  offsets.add(plan.workload.rampUp.durationSeconds + plan.workload.plateau.durationSeconds);
  for (
    let offset = plan.workload.rampUp.durationSeconds + plan.workload.movement.intervalSeconds;
    offset < plan.workload.rampUp.durationSeconds + plan.workload.plateau.durationSeconds;
    offset += plan.workload.movement.intervalSeconds
  ) offsets.add(offset);
  return [...offsets].sort((a, b) => a - b).map(offset => startedAtMs + offset * 1000);
}

async function delayUntil(deadlineMs, signal, poll = undefined) {
  if (signal.aborted) throw invalid("Capacity run was stopped", "DRIVER_CANCELLED");
  while (deadlineMs > Date.now()) {
    if (poll) await poll();
    if (signal.aborted) throw invalid("Capacity run was stopped", "DRIVER_CANCELLED");
    const remaining = Math.min(1000, deadlineMs - Date.now());
    await new Promise((resolveDelay, reject) => {
      const finish = () => {
        signal.removeEventListener("abort", cancel);
        resolveDelay();
      };
      const timer = setTimeout(finish, remaining);
      const cancel = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        reject(invalid("Capacity run was stopped", "DRIVER_CANCELLED"));
      };
      signal.addEventListener("abort", cancel, { once: true });
    });
  }
}

async function readSharedStop(path, plan) {
  if (!path) return null;
  let bytes;
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > 4096) {
      throw invalid("Distributed stop control is not a bounded regular file", "DISTRIBUTED_STOP_INVALID");
    }
    bytes = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error?.state === "INVALID") throw error;
    throw invalid("Distributed stop control could not be read", "DISTRIBUTED_STOP_INVALID", { reason: error.code ?? "unknown" });
  }
  let stop;
  try {
    stop = JSON.parse(bytes);
  } catch {
    throw invalid("Distributed stop control is not strict JSON", "DISTRIBUTED_STOP_INVALID");
  }
  return validateSharedStopDocument(stop, plan);
}

export function validateSharedStopDocument(stop, plan) {
  if (!exactKeys(stop, ["schemaVersion", "state", "planId", "runId", "observedAt", "code", "hostId"]) ||
      stop.schemaVersion !== 1 || !["STOPPED", "FAILED"].includes(stop.state) || stop.planId !== plan.planId ||
      stop.runId !== plan.run.id || !Number.isFinite(Date.parse(stop.observedAt)) ||
      typeof stop.code !== "string" || !/^[-A-Za-z0-9_.]{3,80}$/.test(stop.code) ||
      !/^host-\d{3}$/.test(stop.hostId)) {
    throw invalid("Distributed stop control is not bound to the plan", "DISTRIBUTED_STOP_INVALID");
  }
  return stop;
}

async function publishSharedStop(path, plan, hostId, state, code) {
  if (!path) return;
  const payload = {
    schemaVersion: 1,
    state,
    planId: plan.planId,
    runId: plan.run.id,
    observedAt: new Date().toISOString(),
    code,
    hostId
  };
  const temporary = `${path}.${hostId}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, jsonBytes(payload, true), { flag: "wx", mode: 0o600 });
    try {
      // Creating a hard link is an atomic no-clobber publication on the same
      // shared filesystem, so peers can never observe a partially written JSON
      // control document and simultaneous terminal writers cannot overwrite it.
      await link(temporary, path);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  } finally {
    await unlink(temporary).catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function assertSameFinalTarget(actual, expected) {
  const finalUrl = new URL(actual);
  const planned = new URL(expected);
  if (finalUrl.origin !== planned.origin || finalUrl.pathname !== planned.pathname ||
      finalUrl.search !== planned.search || finalUrl.hash !== planned.hash) {
    throw invalid("A browser redirected outside its exact planned room", "BROWSER_TARGET_MISMATCH");
  }
}

async function clickVisible(page, role, names, timeout = 60_000) {
  for (const name of names) {
    const locator = page.getByRole(role, { name, exact: true });
    if (await locator.isVisible({ timeout: 500 }).catch(() => false)) {
      await locator.click({ timeout });
      return;
    }
  }
  throw invalid("Expected Hubs room control is unavailable", "ROOM_ENTRY_FAILED");
}

export async function installInstrumentation(context, forceRelay, allowedCoturnUrls) {
  await context.addInitScript(({ forceRelay: relay, allowedCoturnUrls: coturnAllowlist }) => {
    const byteLength = value => {
      if (value === undefined || value === null) return 0;
      if (typeof value === "string") return new TextEncoder().encode(value).byteLength;
      if (value instanceof ArrayBuffer) return value.byteLength;
      if (ArrayBuffer.isView(value)) return value.byteLength;
      if (typeof Blob !== "undefined" && value instanceof Blob) return value.size;
      if (typeof URLSearchParams !== "undefined" && value instanceof URLSearchParams) {
        return new TextEncoder().encode(value.toString()).byteLength;
      }
      return 0;
    };
    const allowedIceServers = new Set(coturnAllowlist.map(value => value.toLowerCase()));
    window.__yenCapacity = {
      peerConnections: [],
      streams: [],
      frameTimes: [],
      disconnected: false,
      openWebSockets: 0,
      previousReceivedBytes: 0,
      previousSentBytes: 0,
      previousStatsAt: performance.now(),
      httpRequestBytes: 0,
      webSocketReceivedBytes: 0,
      webSocketSentBytes: 0,
      iceServersValid: true,
      observedIceServerUrls: [],
      allowedIceServerUrls: [...allowedIceServers].sort(),
      instrumentationReady: false
    };
    const NativeWebSocket = window.WebSocket;
    if (typeof NativeWebSocket !== "function") throw new Error("capacity-websocket-hook-unavailable");
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args) {
        const socket = new target(...args);
        const nativeSend = socket.send.bind(socket);
        socket.send = value => {
          window.__yenCapacity.webSocketSentBytes += byteLength(value);
          return nativeSend(value);
        };
        socket.addEventListener("message", event => {
          window.__yenCapacity.webSocketReceivedBytes += byteLength(event.data);
        });
        socket.addEventListener("open", () => { window.__yenCapacity.openWebSockets += 1; }, { once: true });
        socket.addEventListener("close", () => {
          window.__yenCapacity.openWebSockets = Math.max(0, window.__yenCapacity.openWebSockets - 1);
        }, { once: true });
        return socket;
      }
    });
    const NativePeerConnection = window.RTCPeerConnection;
    if (typeof NativePeerConnection !== "function" ||
        typeof NativePeerConnection.prototype?.setConfiguration !== "function") {
      throw new Error("capacity-webrtc-hook-unavailable");
    }
    const validateIceConfiguration = (input = {}) => {
      const supplied = input ?? {};
      const observedUrls = (supplied.iceServers ?? []).flatMap(server => {
        const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
        return urls.filter(value => typeof value === "string").map(value => value.toLowerCase());
      }).sort();
      const valid = observedUrls.every(value => allowedIceServers.has(value)) &&
        (!relay || observedUrls.some(value => /^turns?:/i.test(value)));
      window.__yenCapacity.observedIceServerUrls.push(...observedUrls);
      if (!valid) {
        window.__yenCapacity.iceServersValid = false;
        throw new DOMException("Unattested ICE server configuration", "SecurityError");
      }
      return { ...supplied, ...(relay ? { iceTransportPolicy: "relay" } : {}) };
    };
    const nativeSetConfiguration = NativePeerConnection.prototype.setConfiguration;
    NativePeerConnection.prototype.setConfiguration = function(configuration) {
      return nativeSetConfiguration.call(this, validateIceConfiguration(configuration));
    };
    const GuardedPeerConnection = new Proxy(NativePeerConnection, {
      construct(target, args) {
        const configuration = validateIceConfiguration(args[0] ?? {});
        const peerConnection = new target(configuration, args[1]);
        window.__yenCapacity.peerConnections.push(peerConnection);
        peerConnection.addEventListener("connectionstatechange", () => {
          if (["disconnected", "failed", "closed"].includes(peerConnection.connectionState)) {
            window.__yenCapacity.disconnected = true;
          }
        });
        return peerConnection;
      }
    });
    window.RTCPeerConnection = GuardedPeerConnection;
    if (typeof window.webkitRTCPeerConnection === "function") {
      window.webkitRTCPeerConnection = GuardedPeerConnection;
    }
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init = {}) => {
      window.__yenCapacity.httpRequestBytes += byteLength(init.body);
      return nativeFetch(input, init);
    };
    const nativeXhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function(body) {
      window.__yenCapacity.httpRequestBytes += byteLength(body);
      return nativeXhrSend.call(this, body);
    };
    const mediaDevices = navigator.mediaDevices;
    if (mediaDevices?.getUserMedia) {
      const nativeGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);
      mediaDevices.getUserMedia = async constraints => {
        const stream = await nativeGetUserMedia(constraints);
        window.__yenCapacity.streams.push(stream);
        return stream;
      };
    }
    const frame = timestamp => {
      window.__yenCapacity.frameTimes.push(timestamp);
      if (window.__yenCapacity.frameTimes.length > 240) window.__yenCapacity.frameTimes.shift();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    window.__yenCapacity.instrumentationReady = true;
  }, { forceRelay, allowedCoturnUrls });
}

async function enterRoom(browser, definition, plan) {
  const mobile = plan.scenario.clientProfile === "mobile";
  const diagnostics = {
    errors: 0,
    warnings: 0,
    requestFailures: 0,
    statusErrors: 0,
    deniedOrigins: 0,
    emittedErrors: 0,
    emittedWarnings: 0,
    emittedRequestFailures: 0,
    emittedStatusErrors: 0
  };
  const context = await browser.newContext({
    locale: "es-ES",
    serviceWorkers: "block",
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 720 },
    ...(mobile ? { userAgent: MOBILE_USER_AGENT, isMobile: true, hasTouch: true } : {})
  });
  if (plan.scenario.audioMode === "active") {
    await context.grantPermissions(["microphone"], { origin: new URL(definition.room.target).origin });
  }
  await context.route("**/*", async route => {
    try {
      assertAllowedBrowserUrl(route.request().url(), plan.security);
      await route.continue();
    } catch {
      diagnostics.deniedOrigins += 1;
      await route.abort("blockedbyclient");
    }
  });
  if (typeof context.routeWebSocket !== "function") {
    await context.close();
    throw invalid("The pinned browser lacks the mandatory WebSocket routing hook", "BROWSER_HOOK_UNAVAILABLE");
  }
  await context.routeWebSocket(/.*/, webSocketRoute => {
    try {
      assertAllowedBrowserUrl(webSocketRoute.url(), plan.security);
      webSocketRoute.connectToServer();
    } catch {
      diagnostics.deniedOrigins += 1;
      webSocketRoute.close({ code: 1008, reason: "origin denied" });
    }
  });
  await installInstrumentation(
    context,
    plan.scenario.transportMode === "forced-turn",
    plan.security.coturnUrls
  );
  const page = await context.newPage();
  const instrumentationReady = await page.evaluate(() =>
    window.__yenCapacity?.instrumentationReady === true &&
    typeof window.RTCPeerConnection === "function" &&
    typeof window.RTCPeerConnection.prototype?.setConfiguration === "function" &&
    (typeof window.webkitRTCPeerConnection !== "function" ||
      window.webkitRTCPeerConnection === window.RTCPeerConnection)
  );
  if (!instrumentationReady) {
    await context.close();
    throw invalid("Mandatory browser confinement instrumentation is unavailable", "BROWSER_HOOK_UNAVAILABLE");
  }
  page.on("console", message => {
    if (message.type() === "error") diagnostics.errors += 1;
    if (message.type() === "warning") diagnostics.warnings += 1;
  });
  page.on("pageerror", () => { diagnostics.errors += 1; });
  page.on("requestfailed", () => { diagnostics.requestFailures += 1; });
  page.on("response", response => {
    if (response.status() >= 400) diagnostics.statusErrors += 1;
  });
  const navigationStartedAtMs = Date.now();
  await page.goto(definition.room.target, { waitUntil: "domcontentloaded", timeout: 60_000 });
  assertSameFinalTarget(page.url(), definition.room.target);
  await clickVisible(page, "button", ["Entrar a la sala", "Enter Room", "Join Room"]);
  const lobbyAtMs = Date.now();
  const textbox = page.getByRole("textbox", { name: /Nombre para mostrar|Display name/i });
  await textbox.waitFor({ state: "visible", timeout: 60_000 });
  await textbox.fill(`capacity-${definition.participantId}`);
  await clickVisible(page, "button", ["Aceptar", "Accept"]);
  await clickVisible(page, "button", ["Entrar a la sala", "Enter Room"]);
  const skipTour = page.getByRole("button", { name: /Saltar recorrido|Skip Tour/i });
  if (await skipTour.isVisible().catch(() => false)) await skipTour.click();
  await page.waitForFunction(() =>
    window.APP && window.NAF?.clientId && window.AFRAME?.scenes?.[0]?.is("entered") &&
    document.querySelector("#avatar-rig")?.components?.["player-info"],
  undefined, { timeout: 60_000 });
  await page.evaluate(audioActive => {
    if (!window.APP?.mediaDevicesManager || !window.APP?.dialog) throw new Error("media-state-unavailable");
    window.APP.mediaDevicesManager.micEnabled = audioActive;
  }, plan.scenario.audioMode === "active");
  await page.waitForFunction(audioActive =>
    Boolean(window.APP?.mediaDevicesManager?.isMicEnabled) === audioActive,
  plan.scenario.audioMode === "active", { timeout: 10_000 });
  assertSameFinalTarget(page.url(), definition.room.target);
  const enteredAtMs = Date.now();
  return {
    ...definition,
    context,
    page,
    diagnostics,
    navigationStartedAtMs,
    lobbyAtMs,
    enteredAtMs,
    plateauSamples: 0,
    movementActions: 0,
    closed: false
  };
}

async function browserStats(record, plan, requireProfileProof = false) {
  const result = await record.page.evaluate(({ audioActive, mobileExpected, relayExpected }) => {
    const instrumentation = window.__yenCapacity;
    const frameTimes = instrumentation.frameTimes;
    let fps = 0;
    if (frameTimes.length >= 2) {
      const duration = frameTimes.at(-1) - frameTimes[0];
      fps = duration > 0 ? ((frameTimes.length - 1) * 1000) / duration : 0;
      instrumentation.frameTimes = [];
    }
    const audioTracks = instrumentation.streams.flatMap(stream => stream.getAudioTracks());
    const mediaManager = window.APP?.mediaDevicesManager;
    const appTrack = mediaManager?.audioTrack;
    const appMediaObserved = Boolean(mediaManager && window.APP?.dialog);
    const appMicEnabled = Boolean(mediaManager?.isMicEnabled);
    const appMicShared = Boolean(mediaManager?.isMicShared);
    const mobileObserved = /Mobile|Android/.test(navigator.userAgent) || matchMedia("(max-width: 600px)").matches;
    return Promise.all(instrumentation.peerConnections.map(pc => pc.getStats())).then(reports => {
      let packetsLost = 0;
      let packetsReceived = 0;
      let rttMs = 0;
      let receivedBytes = performance.getEntriesByType("resource")
        .reduce((sum, entry) => sum + Math.max(0, entry.transferSize ?? entry.encodedBodySize ?? 0), 0) +
        instrumentation.webSocketReceivedBytes;
      let sentBytes = instrumentation.httpRequestBytes + instrumentation.webSocketSentBytes;
      let audioReports = 0;
      let selectedPairs = 0;
      let selectedRelays = 0;
      for (const report of reports) {
        const entries = [...report.values()];
        for (const stat of entries) {
          if (stat.type === "inbound-rtp") {
            packetsLost += Math.max(0, stat.packetsLost ?? 0);
            packetsReceived += Math.max(0, stat.packetsReceived ?? 0);
            if (stat.kind === "audio" || stat.mediaType === "audio") audioReports += 1;
            receivedBytes += Math.max(0, stat.bytesReceived ?? 0);
          }
          if (stat.type === "outbound-rtp") {
            sentBytes += Math.max(0, stat.bytesSent ?? 0);
          }
          if (stat.type === "data-channel") {
            receivedBytes += Math.max(0, stat.bytesReceived ?? 0);
            sentBytes += Math.max(0, stat.bytesSent ?? 0);
          }
          if (stat.type === "remote-inbound-rtp" && Number.isFinite(stat.roundTripTime)) {
            rttMs = Math.max(rttMs, stat.roundTripTime * 1000);
          }
          const selectedByTransport = entries.some(entry =>
            entry.type === "transport" && entry.selectedCandidatePairId === stat.id
          );
          if (stat.type === "candidate-pair" &&
              (stat.selected === true || selectedByTransport || (stat.nominated === true && stat.state === "succeeded"))) {
            selectedPairs += 1;
            const local = report.get(stat.localCandidateId);
            const remote = report.get(stat.remoteCandidateId);
            if (local?.candidateType === "relay" || remote?.candidateType === "relay") selectedRelays += 1;
          }
        }
      }
      const currentStatsAt = performance.now();
      const elapsedSeconds = Math.max(0.001, (currentStatsAt - instrumentation.previousStatsAt) / 1000);
      const receiveBytesPerSecond = Math.max(0, receivedBytes - instrumentation.previousReceivedBytes) / elapsedSeconds;
      const sendBytesPerSecond = Math.max(0, sentBytes - instrumentation.previousSentBytes) / elapsedSeconds;
      instrumentation.previousReceivedBytes = receivedBytes;
      instrumentation.previousSentBytes = sentBytes;
      instrumentation.previousStatsAt = currentStatsAt;
      const serverNow = window.NAF?.connection?.getServerTime?.();
      const browserNow = performance.now();
      const remoteAvatarGaps = [...document.querySelectorAll("[networked]")]
        .map(element => ({
          element,
          networked: element.components?.networked,
          botTransform: element.components?.["bot-transform"]
        }))
        .filter(item => item.networked && !item.networked.isMine?.() && /avatar|bot/i.test(item.networked.data?.template ?? ""))
        .map(({ element, botTransform }) => {
          const eid = element.eid ?? element.object3D?.eid;
          const ecsTimestamp = Number.isInteger(eid) ? window.APP?.world?.Networked?.timestamp?.[eid] : undefined;
          if (Number.isFinite(serverNow) && Number.isFinite(ecsTimestamp)) return Math.max(0, serverNow - ecsTimestamp);
          if (Number.isFinite(botTransform?._lastReceivedAt)) return Math.max(0, browserNow - botTransform._lastReceivedAt);
          return Number.POSITIVE_INFINITY;
        });
      const avatarUpdateGapMs = remoteAvatarGaps.length > 0 && remoteAvatarGaps.every(Number.isFinite)
        ? Math.max(...remoteAvatarGaps)
        : 60000;
      const effectiveIceConfigurations = instrumentation.peerConnections.map(pc => pc.getConfiguration());
      const effectiveIceServerUrls = effectiveIceConfigurations.flatMap(configuration =>
        (configuration.iceServers ?? []).flatMap(server => {
          const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
          return urls.filter(value => typeof value === "string").map(value => value.toLowerCase());
        })
      );
      const effectiveIcePoliciesValid = effectiveIceConfigurations.every(configuration =>
        !relayExpected || configuration.iceTransportPolicy === "relay"
      );
      const effectiveIceServersValid = effectiveIceServerUrls.every(value =>
        new Set(instrumentation.allowedIceServerUrls).has(value)
      ) && (!relayExpected || effectiveIceServerUrls.some(value => /^turns?:/i.test(value)));
      const transportProof = selectedPairs > 0 && effectiveIcePoliciesValid &&
        (relayExpected ? selectedRelays === selectedPairs : selectedRelays === 0);
      const observedTracks = [...audioTracks, ...(appTrack ? [appTrack] : [])];
      const audioProof = audioActive
        ? appMediaObserved && appMicShared && appMicEnabled && observedTracks.length > 0 &&
          observedTracks.some(track => track.enabled && track.readyState === "live")
        : appMediaObserved && !appMicEnabled;
      return {
        fps,
        packetLoss: packetsLost + packetsReceived > 0 ? packetsLost / (packetsLost + packetsReceived) : 0,
        rttMs,
        avatarUpdateGapMs,
        receiveBytesPerSecond,
        sendBytesPerSecond,
        webSocketConcurrentCount: instrumentation.openWebSockets,
        audioFailure: audioActive && audioReports === 0 ? 1 : 0,
        disconnected: instrumentation.disconnected || selectedPairs === 0 ? 1 : 0,
        mobileProof: mobileObserved === mobileExpected,
        audioProof,
        transportProof,
        relaySelected: selectedRelays > 0,
        iceServerAttestationValid: instrumentation.iceServersValid && effectiveIceServersValid &&
          [...new Set(instrumentation.observedIceServerUrls)]
            .every(value => new Set(instrumentation.allowedIceServerUrls).has(value)) &&
          (!relayExpected || instrumentation.observedIceServerUrls.some(value => /^turns?:/i.test(value))),
        iceServerUrls: [...new Set(effectiveIceServerUrls)].sort()
      };
    });
  }, {
    audioActive: plan.scenario.audioMode === "active",
    mobileExpected: plan.scenario.clientProfile === "mobile",
    relayExpected: plan.scenario.transportMode === "forced-turn"
  });
  if (requireProfileProof && (!result.mobileProof || !result.audioProof || !result.transportProof ||
      !result.iceServerAttestationValid || result.fps <= 0)) {
    throw invalid("Browser did not prove the selected client, audio and transport profile", "PROFILE_EVIDENCE_INVALID");
  }
  return result;
}

async function performMovement(record) {
  const before = await record.page.evaluate(() => {
    const position = document.querySelector("#avatar-rig")?.object3D?.position;
    return position ? { x: position.x, y: position.y, z: position.z } : null;
  });
  if (!before) throw invalid("Avatar position is unavailable for movement proof", "MOVEMENT_EVIDENCE_INVALID");
  await record.page.keyboard.press(record.ordinal % 2 ? "KeyW" : "KeyA", { delay: 200 });
  await record.page.waitForTimeout(100);
  const after = await record.page.evaluate(() => {
    const position = document.querySelector("#avatar-rig")?.object3D?.position;
    return position ? { x: position.x, y: position.y, z: position.z } : null;
  });
  const distance = after ? Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z) : 0;
  if (distance < 0.001) {
    throw invalid("Browser action did not move the authoritative avatar rig", "MOVEMENT_EVIDENCE_INVALID");
  }
  record.movementActions += 1;
}

function serverMetricNames(plan, thresholds) {
  const contracts = requiredRawContracts(plan, thresholds);
  return Object.entries(contracts)
    .filter(([, contract]) => SERVER_COLLECTORS.has(contract.collector))
    .map(([name]) => name);
}

async function boundedResponseJson(response, maximumBytes = 2 * 1024 * 1024) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw invalid("Server collector response is oversized", "SERVER_COLLECTOR_INVALID");
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > maximumBytes) throw invalid("Server collector response is oversized", "SERVER_COLLECTOR_INVALID");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw invalid("Server collector response is not strict bounded JSON", "SERVER_COLLECTOR_INVALID");
  }
}

export async function collectServerSamples({ endpoint, plan, thresholds, observedAt, phase, runStartedAt, signal }) {
  if (typeof runStartedAt !== "string" ||
      phase !== phaseForTick(plan, Date.parse(runStartedAt), Date.parse(observedAt))) {
    throw invalid("Collector phase must be derived from the signed run window", "SERVER_COLLECTOR_INVALID");
  }
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: 2,
      runId: plan.run.id,
      runStartedAt,
      observedAt,
      scenarioId: plan.scenario.id,
      phase,
      profiles: {
        client: plan.scenario.clientProfile,
        runtime: plan.scenario.clientRuntime,
        audio: plan.scenario.audioMode,
        transport: plan.scenario.transportMode
      },
      rooms: plan.rooms.map(room => ({ id: room.id, bots: room.bots }))
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)])
  });
  if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0] !== "application/json") {
    throw invalid("Server collector endpoint failed closed", "SERVER_COLLECTOR_FAILED");
  }
  const body = await boundedResponseJson(response);
  let checkedMapping;
  try {
    checkedMapping = validateTrackedCollectorMappingIdentity(body?.mapping);
  } catch {
    throw invalid("Server collector mapping is outside the closed tracked contract", "SERVER_COLLECTOR_INVALID");
  }
  if (!exactKeys(body, ["schemaVersion", "runId", "observedAt", "phase", "mapping", "samples"]) ||
      body.schemaVersion !== 2 || body.runId !== plan.run.id || body.observedAt !== observedAt || body.phase !== phase ||
      !Array.isArray(body.samples)) {
    throw invalid("Server collector response schema is closed", "SERVER_COLLECTOR_INVALID");
  }
  const expectedNames = serverMetricNames(plan, thresholds);
  const seen = new Set();
  const samples = body.samples.map(sample => {
    if (!exactKeys(sample, [
      "collector", "metric", "value", "roomId", "service", "instance", "sourceMetric",
      "sourceQuerySha256", "sourceObservedAt", "inventorySha256", "semanticProof"
    ]) ||
        !SERVER_COLLECTORS.has(sample.collector) || !expectedNames.includes(sample.metric) ||
        !Number.isFinite(sample.value) || sample.value < 0 ||
        typeof sample.service !== "string" || typeof sample.instance !== "string" ||
        !/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(sample.sourceMetric) ||
        !/^[0-9a-f]{64}$/.test(sample.sourceQuerySha256) ||
        !/^[0-9a-f]{64}$/.test(sample.inventorySha256)) {
      throw invalid("Server collector sample is outside the closed contract", "SERVER_COLLECTOR_INVALID");
    }
    const contract = requiredRawContracts(plan, thresholds)[sample.metric];
    const mapping = checkedMapping.configuration.metrics[sample.metric];
    const sourceObservedAtMs = Date.parse(sample.sourceObservedAt);
    if (contract.collector !== sample.collector || sample.service !== mapping.service ||
        sample.instance !== `${mapping.service}-aggregate` ||
        sample.sourceMetric !== mapping.sourceMetric || sample.sourceQuerySha256 !== mapping.querySha256 ||
        sample.inventorySha256 !== createHash("sha256")
          .update(canonicalJson(checkedMapping.configuration.seriesInventory))
          .digest("hex") ||
        !Number.isFinite(sourceObservedAtMs) || canonicalIso(sourceObservedAtMs) !== sample.sourceObservedAt ||
        sourceObservedAtMs > Date.parse(observedAt) ||
        Date.parse(observedAt) - sourceObservedAtMs > thresholds.maxCollectorIntervalSeconds * 2000) {
      throw invalid("Server metric source does not match the tracked collector mapping", "SERVER_COLLECTOR_INVALID");
    }
    const semanticContract = OBSERVABILITY_METRIC_CONTRACTS[sample.metric];
    if (!exactKeys(sample.semanticProof, [
      "metricType", "windowStartedAt", "windowEndedAt", "resetObserved", "certified", "series"
    ]) || sample.semanticProof.metricType !== semanticContract?.metricType ||
        sample.semanticProof.windowEndedAt !== observedAt || sample.semanticProof.certified !== false) {
      throw invalid("Server metric semantic proof schema is invalid", "SERVER_COLLECTOR_INVALID");
    }
    let derived;
    try {
      derived = derivePrometheusSemanticValue({
        metricType: sample.semanticProof.metricType,
        series: sample.semanticProof.series,
        runStartedAt,
        runEndedAt: new Date(Date.parse(runStartedAt) + plan.scenario.durationSeconds * 1000).toISOString(),
        windowStartedAt: sample.semanticProof.windowStartedAt,
        windowEndedAt: sample.semanticProof.windowEndedAt,
        allowEmptyHistogram: sample.metric === "bots.appearanceP95Ms" &&
          plan.rooms.some(room => room.id === sample.roomId && room.bots === 0)
      });
    } catch {
      throw invalid("Server metric semantic proof cannot be recomputed", "SERVER_COLLECTOR_INVALID");
    }
    const actualInventory = sample.semanticProof.series.map(item => item.labels);
    const expectedInventory = checkedMapping.configuration.seriesInventory[sample.metric];
    if (canonicalJson(actualInventory) !== canonicalJson(expectedInventory) ||
        Math.abs(derived.value - sample.value) > Number.EPSILON * Math.max(1, Math.abs(sample.value)) * 16 ||
        derived.sourceObservedAt !== sample.sourceObservedAt ||
        derived.resetObserved !== sample.semanticProof.resetObserved) {
      throw invalid("Server metric value does not equal its exact series semantics", "SERVER_COLLECTOR_INVALID");
    }
    let seriesKey;
    if (sample.collector === "bots") {
      if (!plan.rooms.some(room => room.id === sample.roomId)) throw invalid("Bot sample room is not planned", "SERVER_COLLECTOR_INVALID");
      seriesKey = `${sample.metric}/${sample.roomId}`;
    } else {
      if (sample.roomId !== "all") throw invalid("Server aggregate room must be all", "SERVER_COLLECTOR_INVALID");
      seriesKey = sample.metric;
    }
    if (seen.has(seriesKey)) throw invalid("Server collector duplicated a metric series", "SERVER_COLLECTOR_INVALID");
    seen.add(seriesKey);
    return makeRawSample({
      runId: plan.run.id,
      collector: sample.collector,
      metric: sample.metric,
      value: sample.value,
      observedAt,
      dimensions: dimensions(plan, sample.collector, {
        roomId: sample.roomId,
        service: sample.service,
        instance: sample.instance,
        phase
      }),
      source: {
        kind: "prometheus",
        mappingSha256: checkedMapping.sha256,
        sourceMetric: sample.sourceMetric,
        querySha256: sample.sourceQuerySha256,
        sourceObservedAt: sample.sourceObservedAt,
        inventorySha256: sample.inventorySha256,
        semanticProof: sample.semanticProof
      }
    });
  });
  for (const name of expectedNames) {
    if (name.startsWith("bots.")) {
      for (const room of plan.rooms) {
        if (!seen.has(`${name}/${room.id}`)) throw invalid("Server collector omitted bot room evidence", "SERVER_COLLECTOR_MISSING");
      }
    } else if (!seen.has(name)) throw invalid("Server collector omitted a required metric", "SERVER_COLLECTOR_MISSING");
  }
  return { samples, mapping: checkedMapping };
}

function safeStop(breach, plan) {
  return {
    schemaVersion: 1,
    state: "STOPPED",
    planId: plan.planId,
    runId: plan.run.id,
    certified: false,
    breach: {
      metric: breach.metric,
      value: breach.value,
      observedAt: breach.observedAt,
      ...(breach.violationStartedAt ? { violationStartedAt: breach.violationStartedAt } : {})
    },
    note: "The first live stop threshold aborted every shard; no trailing samples were accepted."
  };
}

async function closeAll(browsers) {
  await Promise.allSettled(browsers.map(browser => browser.close()));
}

async function writeRawSamples(path, samples, { allowEmpty = false } = {}) {
  const artifact = rawArtifact(samples);
  if ((!allowEmpty && samples.length === 0) || samples.length > MAX_RAW_SAMPLES || artifact.bytes > MAX_RAW_BYTES) {
    throw invalid("Raw evidence exceeds its bounded sample or byte envelope", "RAW_ARTIFACT_TOO_LARGE");
  }
  const handle = await open(path, "wx", 0o600);
  try {
    for (let index = 0; index < samples.length; index += 1000) {
      const batch = samples.slice(index, index + 1000)
        .map(sample => `${canonicalJson(sample)}\n`)
        .join("");
      await handle.write(batch);
    }
  } finally {
    await handle.close();
  }
}

export function extendAggregateRawEnvelope(envelope, artifact) {
  if (!exactKeys(envelope, ["samples", "bytes"]) ||
      !Number.isInteger(envelope.samples) || envelope.samples < 0 ||
      !Number.isInteger(envelope.bytes) || envelope.bytes < 0 ||
      !exactKeys(artifact, ["path", "sha256", "bytes"]) ||
      !Number.isInteger(artifact.bytes) || artifact.bytes < 1) {
    throw invalid("Aggregate raw envelope is malformed", "RAW_ARTIFACT_TOO_LARGE");
  }
  const next = {
    samples: envelope.samples,
    bytes: envelope.bytes + artifact.bytes
  };
  if (next.bytes > MAX_RAW_BYTES) {
    throw invalid("Aggregate raw evidence exceeds its global byte envelope", "RAW_ARTIFACT_TOO_LARGE");
  }
  return next;
}

function extendAggregateSampleEnvelope(envelope, count) {
  if (!Number.isInteger(count) || count < 1) {
    throw invalid("Aggregate raw sample count is malformed", "RAW_ARTIFACT_TOO_LARGE");
  }
  const next = { ...envelope, samples: envelope.samples + count };
  if (next.samples > MAX_RAW_SAMPLES) {
    throw invalid("Aggregate raw evidence exceeds its global sample envelope", "RAW_ARTIFACT_TOO_LARGE");
  }
  return next;
}

function jsonBytes(value, pretty = false) {
  return Buffer.from(`${JSON.stringify(value, null, pretty ? 2 : 0)}\n`, "utf8");
}

function artifactEntry(path, bytes) {
  return {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length
  };
}

function eventIndex(rawSamples, metric) {
  const result = new Map();
  for (const sample of rawSamples.filter(item => item.metric === metric)) {
    if (result.has(sample.dimensions.participantId)) {
      throw invalid("Participant phase event is duplicated", "SHARD_AGGREGATION_INVALID", { metric });
    }
    result.set(sample.dimensions.participantId, sample);
  }
  return result;
}

export function buildCompletedEvidence({ plan, thresholds, rawSamples, run, collectorMapping }) {
  const metrics = {};
  for (const name of expectedThresholdMetrics(plan, thresholds)) {
    const samples = rawSamples.filter(sample => sample.metric === name);
    metrics[name] = deriveRawAggregate(samples, METRIC_CONTRACTS[name].aggregation, thresholds.metrics[name]);
  }
  const collectors = expectedCollectors(plan, thresholds).map(name => {
    const samples = rawSamples.filter(sample => sample.collector === name);
    const coverage = collectorCoverageWindow(plan, run, name);
    return {
      name,
      status: "complete",
      samples: samples.length,
      coverageSeconds: coverage.coverageSeconds,
      startedAt: coverage.startedAt,
      endedAt: coverage.endedAt,
      runId: plan.run.id
    };
  });
  const lobbyJoin = eventIndex(rawSamples, "phase.lobby.join");
  const lobbyLeave = eventIndex(rawSamples, "phase.lobby.leave");
  const roomJoin = eventIndex(rawSamples, "phase.room.join");
  const roomLeave = eventIndex(rawSamples, "phase.room.leave");
  const plateauStartMs = Date.parse(run.startedAt) + plan.workload.rampUp.durationSeconds * 1000;
  const plateauEndMs = plateauStartMs + plan.workload.plateau.durationSeconds * 1000;
  const participantIds = participantDefinitions(plan).map(item => item.participantId);
  if ([lobbyJoin, lobbyLeave, roomJoin, roomLeave].some(index => index.size !== participantIds.length)) {
    throw invalid("Aggregated shards do not contain every participant phase", "SHARD_AGGREGATION_INVALID");
  }
  const lobbyPopulation = measuredPopulation(participantIds.map(participantId => ({
    start: Date.parse(lobbyJoin.get(participantId).observedAt),
    end: Date.parse(lobbyLeave.get(participantId).observedAt)
  })));
  const roomInterval = participantId => ({
    start: Math.max(plateauStartMs, Date.parse(roomJoin.get(participantId).observedAt)),
    end: Math.min(plateauEndMs, Date.parse(roomLeave.get(participantId).observedAt))
  });
  const roomPopulation = measuredPopulation(participantIds.map(roomInterval));
  const plateauSampleCount = participantId => rawSamples.filter(sample =>
    sample.metric === "client.fpsP10" && sample.dimensions.participantId === participantId &&
    Date.parse(sample.observedAt) >= plateauStartMs && Date.parse(sample.observedAt) <= plateauEndMs
  ).length;
  const rooms = plan.rooms.map(room => {
    const workers = room.workers.map(worker => {
      const ids = Array.from({ length: worker.participantCount }, (_, offset) =>
        `participant-${String(worker.participantStart + offset).padStart(6, "0")}`
      );
      const population = measuredPopulation(ids.map(roomInterval));
      return {
        id: worker.id,
        uniqueParticipants: worker.participantCount,
        participantIds: ids,
        plateauPeak: population.peak,
        plateauSamples: Math.min(...ids.map(plateauSampleCount)),
        plateauParticipantSeconds: population.participantSeconds
      };
    });
    const ids = workers.flatMap(worker => worker.participantIds);
    const population = measuredPopulation(ids.map(roomInterval));
    return {
      id: room.id,
      finalUrl: room.target,
      uniqueParticipants: room.participantCount,
      plateauPeak: population.peak,
      plateauSeconds: plan.workload.plateau.durationSeconds,
      plateauSamples: Math.min(...ids.map(plateauSampleCount)),
      plateauParticipantSeconds: population.participantSeconds,
      bots: {
        state: "observed",
        desired: room.bots,
        active: room.bots,
        authenticated: room.bots,
        spawnAcknowledged: room.bots,
        navmeshReady: room.bots
      },
      workers
    };
  });
  return {
    schemaVersion: 1,
    planId: plan.planId,
    driverState: "completed",
    run,
    collectorMapping,
    collectors,
    participantPhases: {
      lobby: {
        peak: lobbyPopulation.peak,
        samples: participantIds.length * 2,
        participantSeconds: lobbyPopulation.participantSeconds
      },
      room: {
        peak: roomPopulation.peak,
        samples: Math.min(...participantIds.map(plateauSampleCount)),
        participantSeconds: roomPopulation.participantSeconds
      }
    },
    rooms,
    metrics,
    raw: {
      format: "yenhubs-capacity-ndjson-v3",
      artifact: rawArtifact(rawSamples)
    }
  };
}

export async function writeCompletedBundle({
  outputDirectory,
  plan,
  rawSamples,
  evidence,
  report,
  environment,
  collectorEndpoint,
  driverSha256,
  generatorInventory,
  signer
}) {
  const checkedGeneratorInventory = validatePhysicalGeneratorInventory(generatorInventory, {
    plan,
    run: evidence?.run
  });
  const executionConfig = {
    schemaVersion: 1,
    planId: plan.planId,
    driverProtocol: plan.runtime.driverProtocol,
    collectorEndpoint,
    workerHosts: plan.executionTopology.hosts.map(host => host.id)
  };
  const packageLockBytes = await readFile(resolve(CAPACITY_ROOT, "package-lock.json"));
  const harnessTree = await computeTrackedTreeIdentity();
  const bytes = {
    plan: jsonBytes(plan, true),
    evidence: jsonBytes(evidence),
    report: jsonBytes(report, true),
    environment: jsonBytes(environment, true),
    executionConfig: jsonBytes(executionConfig, true),
    lockfile: packageLockBytes,
    collectorConfig: jsonBytes(evidence.collectorMapping, true),
    generatorInventory: jsonBytes(checkedGeneratorInventory, true),
    harnessTree: jsonBytes(harnessTree, true)
  };
  const paths = {
    plan: "plan.json",
    raw: "raw.ndjson",
    evidence: "evidence.json",
    report: "report.json",
    environment: "environment.json",
    executionConfig: "execution-config.json",
    lockfile: "package-lock.json",
    collectorConfig: "collector-config.json",
    generatorInventory: "generator-inventory.json",
    harnessTree: "harness-tree.json"
  };
  await writeFile(resolve(outputDirectory, paths.plan), bytes.plan, { flag: "wx", mode: 0o600 });
  await writeRawSamples(resolve(outputDirectory, paths.raw), rawSamples);
  await writeFile(resolve(outputDirectory, paths.evidence), bytes.evidence, { flag: "wx", mode: 0o600 });
  await writeFile(resolve(outputDirectory, paths.report), bytes.report, { flag: "wx", mode: 0o600 });
  await writeFile(resolve(outputDirectory, paths.environment), bytes.environment, { flag: "wx", mode: 0o600 });
  await writeFile(resolve(outputDirectory, paths.executionConfig), bytes.executionConfig, { flag: "wx", mode: 0o600 });
  await writeFile(resolve(outputDirectory, paths.lockfile), bytes.lockfile, { flag: "wx", mode: 0o600 });
  await writeFile(resolve(outputDirectory, paths.collectorConfig), bytes.collectorConfig, { flag: "wx", mode: 0o600 });
  await writeFile(resolve(outputDirectory, paths.generatorInventory), bytes.generatorInventory, { flag: "wx", mode: 0o600 });
  await writeFile(resolve(outputDirectory, paths.harnessTree), bytes.harnessTree, { flag: "wx", mode: 0o600 });
  const raw = rawArtifact(rawSamples);
  const artifacts = {
    plan: artifactEntry(paths.plan, bytes.plan),
    raw: { path: paths.raw, sha256: raw.sha256, bytes: raw.bytes },
    evidence: artifactEntry(paths.evidence, bytes.evidence),
    report: artifactEntry(paths.report, bytes.report),
    environment: artifactEntry(paths.environment, bytes.environment),
    executionConfig: artifactEntry(paths.executionConfig, bytes.executionConfig),
    lockfile: artifactEntry(paths.lockfile, bytes.lockfile),
    collectorConfig: artifactEntry(paths.collectorConfig, bytes.collectorConfig),
    generatorInventory: artifactEntry(paths.generatorInventory, bytes.generatorInventory),
    harnessTree: artifactEntry(paths.harnessTree, bytes.harnessTree)
  };
  const rawIntegrity = signAndVerifyDocument({
    schemaVersion: 1,
    runId: plan.run.id,
    planId: plan.planId,
    artifact: artifacts.raw
  }, {
    purpose: "raw-artifact",
    signer,
    productionOnly: !signer.keyId.startsWith("test-")
  });
  const manifestCore = {
    schemaVersion: 4,
    runId: plan.run.id,
    planId: plan.planId,
    artifacts,
    rawIntegrity,
    execution: {
      driverSha256,
      lockfileSha256: artifacts.lockfile.sha256,
      configSha256: artifacts.executionConfig.sha256,
      attestationSha256: plan.security.attestationSha256,
      environmentSha256: artifacts.environment.sha256,
      collectorMappingSha256: evidence.collectorMapping.sha256,
      collectorConfigSha256: artifacts.collectorConfig.sha256,
      generatorInventorySha256: artifacts.generatorInventory.sha256,
      harnessTreeSha256: harnessTree.sha256,
      collectorEndpoint
    }
  };
  const manifest = signAndVerifyDocument(manifestCore, {
    purpose: "bundle-manifest",
    signer,
    productionOnly: !signer.keyId.startsWith("test-")
  });
  await writeFile(resolve(outputDirectory, "manifest.json"), jsonBytes(manifest, true), { flag: "wx", mode: 0o600 });
  return manifest;
}

export async function writeShardBundle({
  outputDirectory,
  plan,
  rawSamples,
  shard,
  environment,
  generatorInventory,
  signer
}) {
  const checkedGeneratorInventory = validatePhysicalGeneratorInventory(generatorInventory, {
    plan,
    run: shard?.run,
    expectedHostIds: [shard?.hostId]
  });
  const planBytes = jsonBytes(plan, true);
  const shardBytes = jsonBytes(shard, true);
  const environmentBytes = jsonBytes(environment, true);
  const generatorInventoryBytes = jsonBytes(checkedGeneratorInventory, true);
  const lockfileBytes = await readFile(resolve(CAPACITY_ROOT, "package-lock.json"));
  const raw = rawArtifact(rawSamples);
  const harnessTree = await computeTrackedTreeIdentity();
  const harnessTreeBytes = jsonBytes(harnessTree, true);
  await writeFile(resolve(outputDirectory, "plan.json"), planBytes, { flag: "wx", mode: 0o600 });
  await writeRawSamples(resolve(outputDirectory, "raw.ndjson"), rawSamples);
  await writeFile(resolve(outputDirectory, "shard.json"), shardBytes, { flag: "wx", mode: 0o600 });
  await writeFile(resolve(outputDirectory, "environment.json"), environmentBytes, { flag: "wx", mode: 0o600 });
  await writeFile(resolve(outputDirectory, "generator-inventory.json"), generatorInventoryBytes, { flag: "wx", mode: 0o600 });
  await writeFile(resolve(outputDirectory, "package-lock.json"), lockfileBytes, { flag: "wx", mode: 0o600 });
  await writeFile(resolve(outputDirectory, "harness-tree.json"), harnessTreeBytes, { flag: "wx", mode: 0o600 });
  const rawIntegrity = signAndVerifyDocument({
    schemaVersion: 1,
    runId: plan.run.id,
    planId: plan.planId,
    artifact: { path: "raw.ndjson", sha256: raw.sha256, bytes: raw.bytes }
  }, { purpose: "raw-artifact", signer, productionOnly: !signer.keyId.startsWith("test-") });
  const manifestCore = {
    schemaVersion: 3,
    state: "SHARD_COMPLETE",
    runId: plan.run.id,
    planId: plan.planId,
    hostId: shard.hostId,
    rawIntegrity,
    artifacts: {
      plan: artifactEntry("plan.json", planBytes),
      raw: { path: "raw.ndjson", sha256: raw.sha256, bytes: raw.bytes },
      shard: artifactEntry("shard.json", shardBytes),
      environment: artifactEntry("environment.json", environmentBytes),
      generatorInventory: artifactEntry("generator-inventory.json", generatorInventoryBytes),
      lockfile: artifactEntry("package-lock.json", lockfileBytes),
      harnessTree: artifactEntry("harness-tree.json", harnessTreeBytes)
    }
  };
  const manifest = signAndVerifyDocument(manifestCore, {
    purpose: "shard-manifest",
    signer,
    productionOnly: !signer.keyId.startsWith("test-")
  });
  await writeFile(resolve(outputDirectory, "manifest.json"), jsonBytes(manifest, true), { flag: "wx", mode: 0o600 });
  return manifest;
}

async function readBoundFile(path, maximumBytes, label) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    throw invalid(`${label} could not be inspected`, "SHARD_ARTIFACT_INVALID", { reason: error.code ?? "unknown" });
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0 || metadata.size > maximumBytes) {
    throw invalid(`${label} is not a bounded regular file`, "SHARD_ARTIFACT_INVALID");
  }
  return readFile(path);
}

function localArtifactPath(directory, path) {
  if (typeof path !== "string" || !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(path)) {
    throw invalid("Shard artifact path must be one local filename", "SHARD_ARTIFACT_INVALID");
  }
  const candidate = resolve(directory, path);
  if (relative(directory, candidate).startsWith("..")) {
    throw invalid("Shard artifact escaped its manifest directory", "SHARD_ARTIFACT_INVALID");
  }
  return candidate;
}

async function loadShardManifest(path, shardRootDirectory, { allowTestTrust = false } = {}) {
  const absolute = resolve(path);
  const local = relative(resolve(shardRootDirectory), absolute);
  const manifestPath = await resolveContainedPath(shardRootDirectory, local, "shard manifest");
  const manifestBytes = await readBoundFile(manifestPath, 2 * 1024 * 1024, "shard manifest");
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw invalid("Shard manifest is not strict JSON", "SHARD_ARTIFACT_INVALID");
  }
  verifySignedDocument(manifest, { purpose: "shard-manifest", productionOnly: !allowTestTrust });
  verifySignedDocument(manifest.rawIntegrity, { purpose: "raw-artifact", productionOnly: !allowTestTrust });
  if (!exactKeys(manifest, ["schemaVersion", "state", "runId", "planId", "hostId", "rawIntegrity", "artifacts", "signature"]) ||
      manifest.schemaVersion !== 3 || manifest.state !== "SHARD_COMPLETE" ||
      !exactKeys(manifest.artifacts, [
        "plan", "raw", "shard", "environment", "generatorInventory", "lockfile", "harnessTree"
      ]) ||
      canonicalJson(manifest.rawIntegrity.artifact) !== canonicalJson(manifest.artifacts.raw) ||
      manifest.rawIntegrity.runId !== manifest.runId || manifest.rawIntegrity.planId !== manifest.planId) {
    throw invalid("Shard manifest schema is closed", "SHARD_ARTIFACT_INVALID");
  }
  const directory = dirname(manifestPath);
  const loaded = {};
  for (const [name, maximumBytes] of Object.entries({
    plan: 2 * 1024 * 1024,
    raw: 256 * 1024 * 1024,
    shard: 2 * 1024 * 1024,
    environment: 2 * 1024 * 1024,
    generatorInventory: 2 * 1024 * 1024,
    lockfile: 4 * 1024 * 1024,
    harnessTree: 2 * 1024 * 1024
  })) {
    const claim = manifest.artifacts[name];
    if (!exactKeys(claim, ["path", "sha256", "bytes"]) || !/^[0-9a-f]{64}$/.test(claim.sha256) ||
        !Number.isInteger(claim.bytes) || claim.bytes < 1) {
      throw invalid("Shard artifact claim is invalid", "SHARD_ARTIFACT_INVALID", { artifact: name });
    }
    const bytes = await readBoundFile(localArtifactPath(directory, claim.path), maximumBytes, `${name} shard artifact`);
    if (bytes.length !== claim.bytes || createHash("sha256").update(bytes).digest("hex") !== claim.sha256) {
      throw invalid("Shard artifact hash or byte count is invalid", "SHARD_ARTIFACT_INVALID", { artifact: name });
    }
    loaded[name] = bytes;
  }
  let plan;
  let shard;
  let environment;
  let generatorInventory;
  let harnessTree;
  try {
    plan = JSON.parse(loaded.plan.toString("utf8"));
    shard = JSON.parse(loaded.shard.toString("utf8"));
    environment = JSON.parse(loaded.environment.toString("utf8"));
    generatorInventory = JSON.parse(loaded.generatorInventory.toString("utf8"));
    harnessTree = JSON.parse(loaded.harnessTree.toString("utf8"));
  } catch {
    throw invalid("Shard JSON artifact is malformed", "SHARD_ARTIFACT_INVALID");
  }
  validatePlan(plan, { requireExecutionEnabled: true, productionOnly: !allowTestTrust });
  validateEnvironmentSnapshot(environment, undefined, shard.run?.startedAt, {
    productionOnly: !allowTestTrust
  });
  validatePhysicalGeneratorInventory(generatorInventory, {
    plan,
    run: shard.run,
    expectedHostIds: [shard.hostId]
  });
  const rawSamples = await readNdjsonFile(localArtifactPath(directory, manifest.artifacts.raw.path), "capacity shard raw evidence");
  if (canonicalJson(rawArtifact(rawSamples)) !== canonicalJson({
    name: "raw.ndjson",
    sha256: manifest.artifacts.raw.sha256,
    bytes: manifest.artifacts.raw.bytes,
    sampleCount: rawSamples.length
  })) {
    throw invalid("Shard raw NDJSON identity is invalid", "SHARD_ARTIFACT_INVALID");
  }
  const currentHarnessTree = await computeTrackedTreeIdentity();
  if (canonicalJson(harnessTree) !== canonicalJson(currentHarnessTree)) {
    throw invalid("Shard harness tree differs from the checked-in production tree", "SHARD_ARTIFACT_INVALID");
  }
  return {
    manifest,
    plan,
    shard,
    environment,
    generatorInventory,
    rawSamples,
    lockfileSha256: manifest.artifacts.lockfile.sha256
  };
}

export async function aggregateCapacityShards({
  plan,
  thresholds,
  shardManifestPaths,
  shardRootDirectory,
  collectorEndpoint,
  acknowledgement,
  environment,
  outputDirectory,
  signer,
  allowTestTrust = false
}) {
  const safety = assertExecutionSafety({ plan, acknowledgement, collectorEndpoint, allowTestTrust });
  if (plan.executionTopology.mode !== "distributed-workers" ||
      !Array.isArray(shardManifestPaths) || shardManifestPaths.length !== plan.executionTopology.hosts.length ||
      typeof shardRootDirectory !== "string") {
    throw invalid("Aggregation requires exactly one shard manifest per planned host", "SHARD_SET_INCOMPLETE");
  }
  const safeEnvironment = validateEnvironmentSnapshot(environment, undefined, undefined, {
    productionOnly: !allowTestTrust
  });
  if (canonicalJson(signedDocumentBinding(safeEnvironment, "environment-snapshot", {
    productionOnly: !allowTestTrust
  })) !== canonicalJson(plan.environment)) {
    throw invalid("Aggregation environment does not match the signed plan binding", "ENVIRONMENT_EVIDENCE_INVALID");
  }
  const evidenceSigner = signer ?? await loadProductionSignerFromEnvironment();
  const loaded = [];
  let aggregateRawEnvelope = { samples: 0, bytes: 0 };
  for (const path of shardManifestPaths) {
    const item = await loadShardManifest(path, shardRootDirectory, { allowTestTrust });
    aggregateRawEnvelope = extendAggregateRawEnvelope(aggregateRawEnvelope, item.manifest.artifacts.raw);
    aggregateRawEnvelope = extendAggregateSampleEnvelope(aggregateRawEnvelope, item.rawSamples.length);
    loaded.push(item);
  }
  const byHost = new Map();
  const generatorInventoryByHost = new Map();
  let run = null;
  let collectorMapping = null;
  let driverSha256 = null;
  let lockfileSha256 = null;
  const rawSamples = [];
  for (const item of loaded) {
    const shard = item.shard;
    if (!exactKeys(shard, [
      "schemaVersion", "state", "certified", "planId", "runId", "hostId", "workerIds",
      "participantIds", "collectorLeader", "collectorMapping", "generatorPreflight", "run", "rawArtifact"
    ]) || shard.schemaVersion !== 1 || shard.state !== "SHARD_COMPLETE" || shard.certified !== false ||
        shard.planId !== plan.planId || shard.runId !== plan.run.id || item.manifest.hostId !== shard.hostId ||
        canonicalJson(item.plan) !== canonicalJson(plan) || byHost.has(shard.hostId) ||
        canonicalJson(item.environment) !== canonicalJson(safeEnvironment) ||
        canonicalJson(shard.rawArtifact) !== canonicalJson(rawArtifact(item.rawSamples))) {
      throw invalid("Shard is not bound to the exact plan and environment", "SHARD_AGGREGATION_INVALID");
    }
    const host = plan.executionTopology.hosts.find(candidate => candidate.id === shard.hostId);
    let checkedPreflight;
    try {
      checkedPreflight = validateHostPreflight(plan, shard.hostId, shard.generatorPreflight?.observed, {
        requireProcessTree: true
      });
    } catch {
      throw invalid("Shard generator preflight is invalid", "SHARD_AGGREGATION_INVALID");
    }
    const expectedParticipants = participantDefinitions(plan)
      .filter(definition => host?.workerIds.includes(definition.workerId))
      .map(definition => definition.participantId);
    if (!host || canonicalJson(shard.generatorPreflight) !== canonicalJson(checkedPreflight) ||
        canonicalJson(shard.workerIds) !== canonicalJson(host.workerIds) ||
        canonicalJson(shard.participantIds) !== canonicalJson(expectedParticipants) ||
        shard.collectorLeader !== (shard.hostId === plan.executionTopology.hosts[0].id)) {
      throw invalid("Shard host assignment or participant range is invalid", "SHARD_AGGREGATION_INVALID");
    }
    if (shard.collectorLeader) {
      if (collectorMapping || !shard.collectorMapping) {
        throw invalid("Exactly one shard must carry the server collector mapping", "SHARD_AGGREGATION_INVALID");
      }
      collectorMapping = shard.collectorMapping;
    } else if (shard.collectorMapping !== null) {
      throw invalid("Non-leader shards cannot duplicate server collection", "SHARD_AGGREGATION_INVALID");
    }
    if (run && canonicalJson(run) !== canonicalJson(shard.run)) {
      throw invalid("All shards must share one exact run and browser identity", "SHARD_AGGREGATION_INVALID");
    }
    run ??= shard.run;
    driverSha256 ??= shard.run.driver.sha256;
    lockfileSha256 ??= item.lockfileSha256;
    if (driverSha256 !== shard.run.driver.sha256 || lockfileSha256 !== item.lockfileSha256) {
      throw invalid("Shard driver or lockfile identities differ", "SHARD_AGGREGATION_INVALID");
    }
    byHost.set(shard.hostId, shard);
    generatorInventoryByHost.set(shard.hostId, item.generatorInventory);
    for (const sample of item.rawSamples) rawSamples.push(sample);
    item.rawSamples.length = 0;
  }
  if (byHost.size !== plan.executionTopology.hosts.length || !collectorMapping ||
      safeEnvironment.deployment.collectorMappingSha256 !== collectorMapping.sha256) {
    throw invalid("Distributed shard set or collector identity is incomplete", "SHARD_SET_INCOMPLETE");
  }
  rawSamples.sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.id.localeCompare(right.id));
  if (rawSamples.some(sample => sample?.source?.kind === "fixture")) {
    throw invalid("Physical shard aggregation rejects fixture or synthetic sources", "SHARD_AGGREGATION_INVALID");
  }
  const evidence = buildCompletedEvidence({ plan, thresholds, rawSamples, run, collectorMapping });
  const report = buildReport({ plan, evidence, thresholds, rawSamples, allowTestTrust });
  const generatorInventory = validatePhysicalGeneratorInventory({
    schemaVersion: 1,
    planId: plan.planId,
    runId: plan.run.id,
    observedAt: [...generatorInventoryByHost.values()]
      .map(item => item.observedAt)
      .sort()
      .at(-1),
    hosts: plan.executionTopology.hosts.map(host =>
      structuredClone(generatorInventoryByHost.get(host.id).hosts[0])
    )
  }, { plan, run });
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const manifest = await writeCompletedBundle({
    outputDirectory,
    plan,
    rawSamples,
    evidence,
    report,
    environment: safeEnvironment,
    collectorEndpoint: safety.collectorEndpoint,
    driverSha256,
    generatorInventory,
    signer: evidenceSigner
  });
  return { ...report, artifactManifest: manifest };
}

async function writeForensicBundle({
  outputDirectory,
  plan,
  rawSamples,
  state,
  detail,
  collectorMapping,
  environment,
  signer
}) {
  rawSamples.sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.id.localeCompare(right.id));
  const artifact = rawArtifact(rawSamples);
  const partialEvidence = {
    schemaVersion: 1,
    state,
    planId: plan.planId,
    runId: plan.run.id,
    detail,
    collectorMapping,
    rawArtifact: artifact
  };
  const planBytes = jsonBytes(plan, true);
  const evidenceBytes = jsonBytes(partialEvidence, true);
  const environmentBytes = environment ? jsonBytes(environment, true) : null;
  const harnessTree = await computeTrackedTreeIdentity();
  const harnessTreeBytes = jsonBytes(harnessTree, true);
  await writeFile(resolve(outputDirectory, "plan.json"), planBytes, { flag: "wx", mode: 0o600 });
  await writeRawSamples(resolve(outputDirectory, "raw.ndjson"), rawSamples, { allowEmpty: true });
  await writeFile(resolve(outputDirectory, "evidence.json"), evidenceBytes, { flag: "wx", mode: 0o600 });
  await writeFile(resolve(outputDirectory, "harness-tree.json"), harnessTreeBytes, { flag: "wx", mode: 0o600 });
  if (environmentBytes) {
    await writeFile(resolve(outputDirectory, "environment.json"), environmentBytes, { flag: "wx", mode: 0o600 });
  }
  const artifacts = {
    plan: artifactEntry("plan.json", planBytes),
    raw: { path: "raw.ndjson", sha256: artifact.sha256, bytes: artifact.bytes },
    evidence: artifactEntry("evidence.json", evidenceBytes),
    harnessTree: artifactEntry("harness-tree.json", harnessTreeBytes),
    ...(environmentBytes ? { environment: artifactEntry("environment.json", environmentBytes) } : {})
  };
  const rawIntegrity = signAndVerifyDocument({
    schemaVersion: 1,
    runId: plan.run.id,
    planId: plan.planId,
    artifact: artifacts.raw
  }, { purpose: "raw-artifact", signer, productionOnly: !signer.keyId.startsWith("test-") });
  const manifest = signAndVerifyDocument({
    schemaVersion: 2,
    state,
    runId: plan.run.id,
    planId: plan.planId,
    rawIntegrity,
    artifacts
  }, { purpose: "forensic-manifest", signer, productionOnly: !signer.keyId.startsWith("test-") });
  await writeFile(resolve(outputDirectory, "manifest.json"), jsonBytes(manifest, true), { flag: "wx", mode: 0o600 });
  return manifest;
}

export async function writeStoppedBundle(args) {
  return writeForensicBundle({
    ...args,
    state: "STOPPED",
    detail: args.stopped.breach
  });
}

export async function writeFailureBundle({ error, ...args }) {
  return writeForensicBundle({
    ...args,
    state: "FAILED",
    detail: { code: error?.code ?? "UNEXPECTED_ERROR" }
  });
}

export function parseProcessTreeSnapshot(text, rootPid = process.pid) {
  if (typeof text !== "string" || !Number.isInteger(rootPid) || rootPid < 1) {
    throw invalid("Generator process-tree snapshot is invalid", "HOST_PREFLIGHT_INVALID");
  }
  const rows = text.split("\n").map(line => line.trim()).filter(Boolean).map(line => {
    const match = line.match(/^(\d+)\s+(\d+)\s+([0-9.]+)\s+(\d+)\s+(.+)$/);
    if (!match) throw invalid("Generator ps output is malformed", "HOST_PREFLIGHT_INVALID");
    return {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      cpuPercent: Number(match[3]),
      rssKiB: Number(match[4]),
      command: match[5]
    };
  });
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  const tree = rows.filter(row => descendants.has(row.pid));
  if (!tree.some(row => row.pid === rootPid)) {
    throw invalid("Generator root process is absent from ps output", "HOST_PREFLIGHT_INVALID");
  }
  const browserPattern = /(?:^|\/)(?:chromium|chrome|google chrome|(?:chrome-)?headless[-_]shell)(?:\s|$)/i;
  return {
    source: "ps-process-tree-v1",
    rootPid,
    processCount: tree.length,
    browserRootProcessCount: tree.filter(row => row.ppid === rootPid && browserPattern.test(row.command)).length,
    cpuPercent: tree.reduce((sum, row) => sum + row.cpuPercent, 0),
    rssBytes: tree.reduce((sum, row) => sum + row.rssKiB * 1024, 0)
  };
}

export async function collectProcessTreeMetrics(rootPid = process.pid) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,%cpu=,rss=,comm="], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C" }
    }));
  } catch (error) {
    throw invalid("Generator process tree could not be measured with ps", "HOST_PREFLIGHT_INVALID", {
      reason: error.code ?? "unknown"
    });
  }
  return parseProcessTreeSnapshot(stdout, rootPid);
}

async function readLinuxIdentity(path, label) {
  let value;
  try {
    value = (await readFile(path, "utf8")).trim().toLowerCase();
  } catch (error) {
    throw invalid(`Physical generator ${label} is unavailable`, "PHYSICAL_HOST_IDENTITY_INVALID", {
      reason: error.code ?? "unknown"
    });
  }
  if (!/^[a-z0-9][a-z0-9-]{7,127}$/.test(value)) {
    throw invalid(`Physical generator ${label} is malformed`, "PHYSICAL_HOST_IDENTITY_INVALID");
  }
  return value;
}

async function readDedicatedCgroupPath(runId) {
  let cgroups;
  try {
    cgroups = await readFile("/proc/self/cgroup", "utf8");
  } catch (error) {
    throw invalid("Physical generator cgroup identity is unavailable", "PHYSICAL_HOST_IDENTITY_INVALID", {
      reason: error.code ?? "unknown"
    });
  }
  const unified = cgroups.split(/\r?\n/).find(line => line.startsWith("0::"));
  const path = unified?.slice(3);
  if (typeof path !== "string" || path.length > 512 || !path.startsWith("/") ||
      path.split("/").includes("..") || !path.split("/").includes(runId)) {
    throw invalid(
      "Physical execution requires one dedicated cgroup whose path is bound to the run id",
      "PHYSICAL_HOST_IDENTITY_INVALID"
    );
  }
  return path;
}

export function parseCgroupProcessSnapshot(text, rootPid, processNames = {}) {
  if (typeof text !== "string" || !Number.isInteger(rootPid) || rootPid < 1 ||
      !processNames || typeof processNames !== "object" || Array.isArray(processNames)) {
    throw invalid("Generator cgroup process snapshot is invalid", "PHYSICAL_HOST_IDENTITY_INVALID");
  }
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.some(line => !/^[1-9][0-9]*$/.test(line))) {
    throw invalid("Generator cgroup process list is malformed", "PHYSICAL_HOST_IDENTITY_INVALID");
  }
  const pids = lines.map(Number);
  if (pids.length === 0 || new Set(pids).size !== pids.length || !pids.includes(rootPid)) {
    throw invalid("Generator root PID is not uniquely present in its dedicated cgroup", "PHYSICAL_HOST_IDENTITY_INVALID");
  }
  const remaining = pids.filter(pid => pid !== rootPid);
  return {
    liveDescendantCountAfterStop: remaining.length,
    liveBrowserCountAfterStop: remaining.filter(pid =>
      /(?:chrome|chromium|headless[-_ ]?shell)/i.test(String(processNames[pid] ?? ""))
    ).length
  };
}

async function readCgroupTerminationState(cgroupPath, rootPid) {
  const cgroupDirectory = resolve("/sys/fs/cgroup", `.${cgroupPath}`);
  let text;
  try {
    text = await readFile(resolve(cgroupDirectory, "cgroup.procs"), "utf8");
  } catch (error) {
    throw invalid("Physical generator cgroup process proof is unavailable", "PHYSICAL_HOST_IDENTITY_INVALID", {
      reason: error.code ?? "unknown"
    });
  }
  const pids = text.split(/\r?\n/).filter(line => /^[1-9][0-9]*$/.test(line)).map(Number);
  const processNames = Object.fromEntries(await Promise.all(pids.filter(pid => pid !== rootPid).map(async pid => {
    const name = await readFile(`/proc/${pid}/comm`, "utf8").catch(() => "");
    return [pid, name.trim()];
  })));
  return parseCgroupProcessSnapshot(text, rootPid, processNames);
}

export async function capturePhysicalGeneratorInventory({ plan, run, hostId, rootPid = process.pid }) {
  const [machineId, bootId, cgroupPath] = await Promise.all([
    readLinuxIdentity("/etc/machine-id", "machine id"),
    readLinuxIdentity("/proc/sys/kernel/random/boot_id", "boot id"),
    readDedicatedCgroupPath(plan.run.id)
  ]);
  const termination = await readCgroupTerminationState(cgroupPath, rootPid);
  return validatePhysicalGeneratorInventory({
    schemaVersion: 1,
    planId: plan.planId,
    runId: plan.run.id,
    observedAt: new Date().toISOString(),
    hosts: [{
      hostId,
      machineId,
      bootId,
      cgroupPath,
      rootPid,
      ...termination
    }]
  }, { plan, run, expectedHostIds: [hostId] });
}

export function validateHostPreflight(plan, workerHostId, snapshot = {
  cpuCount: cpus().length,
  totalMemoryBytes: totalmem(),
  freeMemoryBytes: freemem()
}, { requireProcessTree = false } = {}) {
  const distributed = plan.executionTopology.mode === "distributed-workers";
  if (distributed && !workerHostId) {
    throw invalid("Distributed plans require one explicit worker host identity", "DISTRIBUTED_HOST_REQUIRED");
  }
  const hostId = workerHostId ?? plan.executionTopology.hosts[0]?.id;
  const host = plan.executionTopology.hosts.find(item => item.id === hostId);
  if (!host || host.plannedBrowserProcesses > plan.executionTopology.maxBrowserProcessesPerHost ||
      host.plannedContexts > plan.executionTopology.maxContextsPerHost) {
    throw invalid("Worker host assignment exceeds the reproducible host cap", "HOST_PREFLIGHT_INVALID");
  }
  const requiredCpuCount = Math.max(2, Math.ceil(host.plannedContexts / 10));
  const requiredTotalMemoryBytes = Math.max(4 * 1024 ** 3, host.plannedContexts * 256 * 1024 ** 2);
  const requiredFreeMemoryBytes = Math.max(1024 ** 3, host.plannedContexts * 128 * 1024 ** 2);
  if (!Number.isInteger(snapshot.cpuCount) || snapshot.cpuCount < requiredCpuCount ||
      !Number.isFinite(snapshot.totalMemoryBytes) || snapshot.totalMemoryBytes < requiredTotalMemoryBytes ||
      !Number.isFinite(snapshot.freeMemoryBytes) || snapshot.freeMemoryBytes < requiredFreeMemoryBytes) {
    throw invalid("Generator host lacks the minimum CPU or free memory preflight", "HOST_PREFLIGHT_INSUFFICIENT");
  }
  if (requireProcessTree && (!exactKeys(snapshot.processTree, [
    "source", "rootPid", "processCount", "browserRootProcessCount", "cpuPercent", "rssBytes"
  ]) || snapshot.processTree.source !== "ps-process-tree-v1" ||
      !Number.isInteger(snapshot.processTree.rootPid) || snapshot.processTree.rootPid < 1 ||
      !Number.isInteger(snapshot.processTree.processCount) || snapshot.processTree.processCount < 1 ||
      snapshot.processTree.browserRootProcessCount !== 0 ||
      !Number.isFinite(snapshot.processTree.cpuPercent) || snapshot.processTree.cpuPercent < 0 ||
      !Number.isInteger(snapshot.processTree.rssBytes) || snapshot.processTree.rssBytes < 1)) {
    throw invalid("Generator preflight requires a real ps process-tree baseline", "HOST_PREFLIGHT_INVALID");
  }
  return {
    ...host,
    hostId,
    distributed,
    requirements: { requiredCpuCount, requiredTotalMemoryBytes, requiredFreeMemoryBytes },
    observed: structuredClone(snapshot)
  };
}

export async function runCapacityDriver({
  plan,
  thresholds,
  collectorEndpoint,
  acknowledgement,
  workerHostId,
  environment,
  startAt,
  signer,
  sharedStopFile,
  allowTestTrust = false
}) {
  const safety = assertExecutionSafety({ plan, acknowledgement, collectorEndpoint, allowTestTrust });
  const executionCheckAt = Date.now();
  if (executionCheckAt < Date.parse(plan.run.issuedAt) || executionCheckAt > Date.parse(plan.run.startDeadlineAt)) {
    throw invalid("Physical execution is outside the signed plan start window", "EXECUTION_WINDOW_INVALID");
  }
  const processTreePreflight = await collectProcessTreeMetrics();
  const hostPreflight = validateHostPreflight(plan, workerHostId, {
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
    processTree: processTreePreflight
  }, { requireProcessTree: true });
  const safeEnvironment = validateEnvironmentSnapshot(environment, undefined, undefined, {
    productionOnly: !allowTestTrust
  });
  const environmentBinding = signedDocumentBinding(safeEnvironment, "environment-snapshot", {
    productionOnly: !allowTestTrust
  });
  if (canonicalJson(environmentBinding) !== canonicalJson(plan.environment)) {
    throw invalid("Execution environment does not match the signed plan binding", "ENVIRONMENT_EVIDENCE_INVALID");
  }
  const evidenceSigner = signer ?? await loadProductionSignerFromEnvironment();
  const scheduledStartMs = startAt === undefined ? null : Date.parse(startAt);
  if (startAt !== undefined && (!Number.isFinite(scheduledStartMs) ||
      new Date(scheduledStartMs).toISOString() !== startAt || scheduledStartMs < Date.now() + 30_000 ||
      scheduledStartMs > Date.parse(plan.run.startDeadlineAt))) {
    throw invalid("Scheduled start must be canonical and inside the plan run window", "DISTRIBUTED_START_INVALID");
  }
  if (hostPreflight.distributed && startAt === undefined) {
    throw invalid("Distributed workers require one shared scheduled start", "DISTRIBUTED_START_REQUIRED");
  }
  if (hostPreflight.distributed && (typeof sharedStopFile !== "string" || sharedStopFile.length === 0)) {
    throw invalid("Distributed workers require one shared stop-control file", "DISTRIBUTED_STOP_REQUIRED");
  }
  const effectiveStartAt = canonicalIso(scheduledStartMs ?? Date.now());
  validateEnvironmentSnapshot(safeEnvironment, undefined, effectiveStartAt, {
    productionOnly: !allowTestTrust
  });
  if (await readSharedStop(sharedStopFile, plan)) {
    throw invalid("Distributed stop control already contains a terminal state", "DISTRIBUTED_STOP_INVALID");
  }
  const outputRoot = resolve(CAPACITY_ROOT, "output/playwright/capacity");
  const runDirectory = resolve(outputRoot, plan.run.id);
  const outputDirectory = hostPreflight.distributed
    ? resolve(runDirectory, "shards", hostPreflight.hostId)
    : runDirectory;
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  if (hostPreflight.distributed) await mkdir(resolve(runDirectory, "shards"), { recursive: true, mode: 0o700 });
  await mkdir(outputDirectory, { recursive: false, mode: 0o700 });
  const driverBytes = await readFile(new URL(import.meta.url));
  const driverSha256 = createHash("sha256").update(driverBytes).digest("hex");
  const launchArgs = plan.scenario.audioMode === "active"
    ? ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]
    : [];
  const browsers = [];
  const browserByWorker = new Map();
  const selectedWorkerIds = new Set(hostPreflight.workerIds);
  const rawSamples = [];
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true, args: launchArgs });
    browsers.push(browser);
    for (const workerId of selectedWorkerIds) browserByWorker.set(workerId, browser);
    const launchedTree = await collectProcessTreeMetrics();
    if (launchedTree.browserRootProcessCount !== hostPreflight.plannedBrowserProcesses) {
      throw invalid("Playwright launch did not produce the exact planned browser process tree", "HOST_PREFLIGHT_INVALID");
    }
    // Distributed workers may spend several minutes waiting at the common
    // start barrier. Poll the shared terminal control throughout that wait so
    // a failed peer cancels every pre-launched browser before any room traffic.
    while (scheduledStartMs !== null && scheduledStartMs > Date.now()) {
      const peerStop = await readSharedStop(sharedStopFile, plan);
      if (peerStop && peerStop.hostId !== hostPreflight.hostId) {
        const stopped = {
          schemaVersion: 1,
          state: "STOPPED",
          planId: plan.planId,
          runId: plan.run.id,
          certified: false,
          breach: {
            metric: "distributed.peerStop",
            value: 1,
            observedAt: peerStop.observedAt
          },
          note: "A peer worker published a shared terminal stop before the scheduled start."
        };
        await closeAll(browsers);
        const artifactManifest = await writeStoppedBundle({
          outputDirectory,
          plan,
          rawSamples,
          stopped,
          collectorMapping: null,
          environment: safeEnvironment,
          signer: evidenceSigner
        });
        return { ...stopped, artifactManifest };
      }
      await new Promise(resolveDelay => setTimeout(
        resolveDelay,
        Math.min(1000, scheduledStartMs - Date.now())
      ));
    }
  } catch (error) {
    await closeAll(browsers);
    await publishSharedStop(sharedStopFile, plan, hostPreflight.hostId, "FAILED", error?.code ?? "UNEXPECTED_ERROR");
    const forensicDirectory = resolve(outputDirectory, "forensic");
    await mkdir(forensicDirectory, { recursive: false, mode: 0o700 });
    await writeFailureBundle({
      outputDirectory: forensicDirectory,
      plan,
      rawSamples: [],
      error,
      collectorMapping: null,
      environment: safeEnvironment,
      signer: evidenceSigner
    });
    throw error;
  }
  // Browser processes are pre-launched outside the measured ramp. Every
  // context/page and room join remains inside the run window.
  const startedAtMs = scheduledStartMs ?? Date.now();
  const startedAt = canonicalIso(startedAtMs);
  const endedAtMs = startedAtMs + plan.scenario.durationSeconds * 1000;
  const endedAt = canonicalIso(endedAtMs);
  const abortController = new AbortController();
  setMaxListeners(0, abortController.signal);
  abortController.signal.addEventListener("abort", () => {
    // Playwright navigation and room-entry helpers do not accept an
    // AbortSignal. Closing the browser tree is the fail-closed cancellation
    // primitive that stops their network traffic immediately.
    void closeAll(browsers);
  }, { once: true });
  const monitor = new StopMonitor(thresholds, {
    runId: plan.run.id,
    earliestObservedAt: startedAt,
    latestObservedAt: endedAt
  });
  const eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
  eventLoopHistogram.enable();
  let collectorMapping = null;
  let stopped = null;
  let acceptingSamples = true;
  const pollSharedStop = async () => {
    const peerStop = await readSharedStop(sharedStopFile, plan);
    if (!peerStop || peerStop.hostId === hostPreflight.hostId) return;
    stopped = {
      schemaVersion: 1,
      state: "STOPPED",
      planId: plan.planId,
      runId: plan.run.id,
      certified: false,
      breach: {
        metric: "distributed.peerStop",
        value: 1,
        observedAt: peerStop.observedAt
      },
      note: "A peer worker published a shared terminal stop."
    };
    acceptingSamples = false;
    abortController.abort();
  };
  let sharedStopPollBusy = false;
  let sharedStopPollError = null;
  const sharedStopTimer = sharedStopFile ? setInterval(async () => {
    if (sharedStopPollBusy || abortController.signal.aborted) return;
    sharedStopPollBusy = true;
    try {
      await pollSharedStop();
    } catch (error) {
      sharedStopPollError = error;
      abortController.abort();
    } finally {
      sharedStopPollBusy = false;
    }
  }, 1000) : null;
  sharedStopTimer?.unref();
  const addSamples = samples => {
    if (!acceptingSamples) throw invalid("Samples after stop are forbidden", "DRIVER_TRAILING_SAMPLE");
    if (rawSamples.length + samples.length > MAX_RAW_SAMPLES) {
      throw invalid("Driver exceeded the bounded raw sample envelope", "RAW_ARTIFACT_TOO_LARGE");
    }
    for (const sample of samples) {
      rawSamples.push(sample);
      if (thresholds.metrics[sample.metric]) {
        const breach = monitor.observe({
          type: "sample",
          runId: sample.runId,
          metric: sample.metric,
          value: sample.value,
          observedAt: sample.observedAt
        });
        if (breach) {
          stopped = safeStop(breach, plan);
          acceptingSamples = false;
          abortController.abort();
          return;
        }
      }
    }
  };

  const records = [];
  const definitions = participantDefinitions(plan).filter(definition => selectedWorkerIds.has(definition.workerId));
  const expectedParticipantCount = definitions.length;
  const collectorLeader = !hostPreflight.distributed ||
    hostPreflight.hostId === plan.executionTopology.hosts[0].id;
  let launchFailure = null;

  try {
    const launchPromises = definitions.map(async definition => {
      const entryBudgetMs = Math.min(60_000, Math.max(5_000, plan.workload.rampUp.durationSeconds * 500));
      const launchWindowMs = Math.max(0, plan.workload.rampUp.durationSeconds * 1000 - entryBudgetMs);
      const offsetMs = Math.floor(
        ((definitions.indexOf(definition)) / Math.max(1, expectedParticipantCount - 1)) * launchWindowMs
      );
      await delayUntil(startedAtMs + offsetMs, abortController.signal, pollSharedStop);
      const record = await enterRoom(browserByWorker.get(definition.workerId), definition, plan);
      records.push(record);
      return record;
    });
    Promise.all(launchPromises).catch(error => {
      launchFailure = error;
      abortController.abort();
    });

    const rampEndMs = startedAtMs + plan.workload.rampUp.durationSeconds * 1000;
    const plateauEndMs = rampEndMs + plan.workload.plateau.durationSeconds * 1000;
    const ticks = timeline(plan, startedAtMs, thresholds.maxCollectorIntervalSeconds);
    for (const tickMs of ticks) {
      await delayUntil(tickMs, abortController.signal, pollSharedStop);
      if (launchFailure) throw launchFailure;
      if (stopped) break;
      if (tickMs === rampEndMs) {
        await Promise.all(launchPromises);
        if (records.length !== expectedParticipantCount || records.some(record => record.enteredAtMs > rampEndMs)) {
          throw invalid("Every participant must enter before the plateau", "RAMP_UP_INCOMPLETE");
        }
        const observedAt = canonicalIso(tickMs);
        for (const record of [...records].sort((a, b) => a.ordinal - b.ordinal)) {
          const location = record;
          addSamples([
            makeRawSample({ runId: plan.run.id, collector: "client", metric: "phase.lobby.join", value: 1, observedAt: canonicalIso(record.lobbyAtMs), dimensions: dimensions(plan, "client", { ...location, phase: "lobby" }) }),
            makeRawSample({ runId: plan.run.id, collector: "client", metric: "phase.lobby.leave", value: 1, observedAt: canonicalIso(record.enteredAtMs), dimensions: dimensions(plan, "client", { ...location, phase: "lobby" }) }),
            makeRawSample({
              runId: plan.run.id,
              collector: "client",
              metric: "phase.room.join",
              value: 1,
              observedAt: canonicalIso(record.enteredAtMs),
              dimensions: dimensions(plan, "client", {
                ...location,
                phase: phaseForTick(plan, startedAtMs, record.enteredAtMs)
              })
            }),
            makeRawSample({ runId: plan.run.id, collector: "client", metric: "join.failureRate", value: 0, observedAt, dimensions: dimensions(plan, "client", location) }),
            makeRawSample({ runId: plan.run.id, collector: "client", metric: "join.lobbyP95Ms", value: record.lobbyAtMs - record.navigationStartedAtMs, observedAt, dimensions: dimensions(plan, "client", location) }),
            makeRawSample({ runId: plan.run.id, collector: "client", metric: "join.sceneP95Ms", value: record.enteredAtMs - record.navigationStartedAtMs, observedAt, dimensions: dimensions(plan, "client", location) })
          ]);
          if (stopped) break;
        }
      }
      if (stopped) break;
      const observedAt = canonicalIso(tickMs);
      const phase = phaseForTick(plan, startedAtMs, tickMs);
      const activeRecords = tickMs >= rampEndMs && tickMs <= plateauEndMs
        ? records.filter(item => !item.closed).sort((left, right) => left.ordinal - right.ordinal)
        : [];
      const [serverCollection, clientStats] = await Promise.all([
        collectorLeader && tickMs > startedAtMs ? collectServerSamples({
          endpoint: safety.collectorEndpoint,
          plan,
          thresholds,
          observedAt,
          phase,
          runStartedAt: startedAt,
          signal: abortController.signal
        }) : Promise.resolve({ samples: [], mapping: null }),
        Promise.all(activeRecords.map(async record => ({
          record,
          stats: await browserStats(record, plan, tickMs === rampEndMs)
        })))
      ]);
      if (Date.now() > tickMs + thresholds.maxCollectorIntervalSeconds * 1000) {
        throw invalid("A real collector sample missed its bounded observation window", "COLLECTOR_INTERVAL_OVERRUN");
      }
      if (serverCollection.mapping && collectorMapping &&
          canonicalJson(collectorMapping) !== canonicalJson(serverCollection.mapping)) {
        throw invalid("Collector mapping identity changed during the run", "COLLECTOR_MAPPING_CHANGED");
      }
      collectorMapping ??= serverCollection.mapping;
      if (collectorMapping && safeEnvironment.deployment.collectorMappingSha256 !== collectorMapping.sha256) {
        throw invalid("Execution environment is not bound to the active collector mapping", "ENVIRONMENT_MAPPING_MISMATCH");
      }
      addSamples(serverCollection.samples);
      if (stopped) break;
      const processTree = await collectProcessTreeMetrics();
      const generatorLocation = { service: "capacity-generator", instance: hostPreflight.hostId, phase };
      const processTreeSource = {
        kind: "host-process-tree",
        sourceObservedAt: observedAt,
        measurementSource: processTree.source,
        rootPid: processTree.rootPid,
        processCount: processTree.processCount,
        browserRootProcessCount: processTree.browserRootProcessCount,
        cpuPercent: processTree.cpuPercent,
        rssBytes: processTree.rssBytes,
        systemCpuCount: cpus().length,
        totalMemoryBytes: totalmem()
      };
      const eventLoopSource = {
        kind: "host-event-loop",
        sourceObservedAt: observedAt,
        measurementSource: "node-perf-hooks-monitor-event-loop-delay-v1",
        rootPid: process.pid
      };
      addSamples([
        makeRawSample({ runId: plan.run.id, collector: "generator", metric: "generator.cpuUtilization", value: Math.min(1, processTree.cpuPercent / 100 / Math.max(1, cpus().length)), observedAt, dimensions: dimensions(plan, "generator", generatorLocation), source: processTreeSource }),
        makeRawSample({ runId: plan.run.id, collector: "generator", metric: "generator.memoryUtilization", value: processTree.rssBytes / totalmem(), observedAt, dimensions: dimensions(plan, "generator", generatorLocation), source: processTreeSource }),
        makeRawSample({ runId: plan.run.id, collector: "generator", metric: "generator.rssMiB", value: processTree.rssBytes / 1024 ** 2, observedAt, dimensions: dimensions(plan, "generator", generatorLocation), source: processTreeSource }),
        makeRawSample({ runId: plan.run.id, collector: "generator", metric: "generator.eventLoopLagP95Ms", value: Number.isFinite(eventLoopHistogram.percentile(95)) ? eventLoopHistogram.percentile(95) / 1e6 : 0, observedAt, dimensions: dimensions(plan, "generator", generatorLocation), source: eventLoopSource }),
        makeRawSample({ runId: plan.run.id, collector: "generator", metric: "generator.browserProcessCount", value: processTree.browserRootProcessCount, observedAt, dimensions: dimensions(plan, "generator", generatorLocation), source: processTreeSource }),
        makeRawSample({ runId: plan.run.id, collector: "generator", metric: "generator.processCount", value: processTree.processCount, observedAt, dimensions: dimensions(plan, "generator", generatorLocation), source: processTreeSource })
      ]);
      eventLoopHistogram.reset();
      if (stopped) break;

      for (const { record, stats } of clientStats) {
        if (record.diagnostics.deniedOrigins > 0) {
          throw invalid("Browser attempted one or more origins outside the plan allowlist", "BROWSER_ORIGIN_DENIED");
        }
        if (tickMs >= rampEndMs && tickMs <= plateauEndMs) record.plateauSamples += 1;
        const location = record;
        const errorDelta = record.diagnostics.errors - record.diagnostics.emittedErrors;
        const warningDelta = record.diagnostics.warnings - record.diagnostics.emittedWarnings;
        const requestFailureDelta = record.diagnostics.requestFailures - record.diagnostics.emittedRequestFailures;
        const statusErrorDelta = record.diagnostics.statusErrors - record.diagnostics.emittedStatusErrors;
        record.diagnostics.emittedErrors = record.diagnostics.errors;
        record.diagnostics.emittedWarnings = record.diagnostics.warnings;
        record.diagnostics.emittedRequestFailures = record.diagnostics.requestFailures;
        record.diagnostics.emittedStatusErrors = record.diagnostics.statusErrors;
        addSamples([
          makeRawSample({ runId: plan.run.id, collector: "client", metric: "client.consoleErrorCount", value: errorDelta, observedAt, dimensions: dimensions(plan, "client", location) }),
          makeRawSample({ runId: plan.run.id, collector: "client", metric: "client.consoleWarningCount", value: warningDelta, observedAt, dimensions: dimensions(plan, "client", location) }),
          makeRawSample({ runId: plan.run.id, collector: "client", metric: "client.fpsP10", value: stats.fps, observedAt, dimensions: dimensions(plan, "client", location) }),
          makeRawSample({ runId: plan.run.id, collector: "client", metric: "client.disconnectRate", value: stats.disconnected, observedAt, dimensions: dimensions(plan, "client", location) }),
          makeRawSample({ runId: plan.run.id, collector: "client", metric: "client.httpRequestFailureCount", value: requestFailureDelta, observedAt, dimensions: dimensions(plan, "client", location) }),
          makeRawSample({ runId: plan.run.id, collector: "client", metric: "client.httpStatusErrorCount", value: statusErrorDelta, observedAt, dimensions: dimensions(plan, "client", location) }),
          makeRawSample({ runId: plan.run.id, collector: "client", metric: "client.websocketConcurrentCount", value: stats.webSocketConcurrentCount, observedAt, dimensions: dimensions(plan, "client", location) }),
          makeRawSample({ runId: plan.run.id, collector: "client", metric: "network.clientReceiveBytesPerSecond", value: stats.receiveBytesPerSecond, observedAt, dimensions: dimensions(plan, "client", location) }),
          makeRawSample({ runId: plan.run.id, collector: "webrtc", metric: "network.clientSendBytesPerSecond", value: stats.sendBytesPerSecond, observedAt, dimensions: dimensions(plan, "webrtc", location) }),
          makeRawSample({ runId: plan.run.id, collector: "webrtc", metric: "webrtc.packetLossP95", value: stats.packetLoss, observedAt, dimensions: dimensions(plan, "webrtc", location) }),
          makeRawSample({ runId: plan.run.id, collector: "webrtc", metric: "webrtc.rttP95Ms", value: stats.rttMs, observedAt, dimensions: dimensions(plan, "webrtc", location) }),
          makeRawSample({ runId: plan.run.id, collector: "webrtc", metric: "webrtc.audioFailureRate", value: stats.audioFailure, observedAt, dimensions: dimensions(plan, "webrtc", location) }),
          makeRawSample({ runId: plan.run.id, collector: "client", metric: "avatar.networkUpdateGapP95Ms", value: stats.avatarUpdateGapMs, observedAt, dimensions: dimensions(plan, "client", location) })
        ]);
        if (stopped) break;
        if (tickMs === rampEndMs) {
          addSamples([
            makeRawSample({ runId: plan.run.id, collector: "client", metric: "client.profileMobile", value: plan.scenario.clientProfile === "mobile" ? 1 : 0, observedAt, dimensions: dimensions(plan, "client", location) }),
            makeRawSample({ runId: plan.run.id, collector: "client", metric: "client.audioTrackActive", value: plan.scenario.audioMode === "active" ? 1 : 0, observedAt, dimensions: dimensions(plan, "client", location) }),
            makeRawSample({ runId: plan.run.id, collector: "webrtc", metric: "webrtc.selectedCandidateRelay", value: stats.relaySelected ? 1 : 0, observedAt, dimensions: dimensions(plan, "webrtc", location) }),
            makeRawSample({
              runId: plan.run.id,
              collector: "webrtc",
              metric: "webrtc.iceServerAttestationValid",
              value: stats.iceServerAttestationValid ? 1 : 0,
              observedAt,
              dimensions: dimensions(plan, "webrtc", location),
              source: {
                kind: "browser-ice",
                sourceObservedAt: observedAt,
                iceServerUrls: stats.iceServerUrls
              }
            })
          ]);
        }
        if (stopped) break;
      }
      if (stopped) break;

      const isMovementTick = tickMs > rampEndMs && tickMs < plateauEndMs &&
        (tickMs - rampEndMs) % (plan.workload.movement.intervalSeconds * 1000) === 0;
      if (isMovementTick) {
        await Promise.all(records.filter(item => !item.closed).map(performMovement));
      }

      if (tickMs >= plateauEndMs) {
        const elapsedRampDown = tickMs - plateauEndMs;
        const shouldHaveLeft = Math.floor(
          (elapsedRampDown / Math.max(1, plan.workload.rampDown.durationSeconds * 1000)) * expectedParticipantCount
        );
        const toClose = records
          .sort((a, b) => a.ordinal - b.ordinal)
          .slice(0, shouldHaveLeft)
          .filter(record => !record.closed);
        for (const record of toClose) {
          const closeObservedAt = observedAt;
          const lobbySeconds = (record.enteredAtMs - record.lobbyAtMs) / 1000;
          if (lobbySeconds > plan.workload.rampUp.durationSeconds) {
            throw invalid("Measured lobby presence exceeded the bounded ramp", "RAMP_UP_INCOMPLETE");
          }
          const location = { ...record, phase: "ramp-down" };
          addSamples([
            makeRawSample({ runId: plan.run.id, collector: "client", metric: "phase.room.leave", value: 1, observedAt: closeObservedAt, dimensions: dimensions(plan, "client", location) }),
            ...Object.entries({
              "client.lobbyJoined": 1,
              "client.roomJoined": 1,
              "client.lobbyPresenceSeconds": lobbySeconds,
              "client.plateauPresenceSeconds": plan.workload.plateau.durationSeconds,
              "client.plateauSampleCount": record.plateauSamples,
              "client.finalUrlMatched": 1,
              "client.movementActionCount": record.movementActions
            }).map(([metric, value]) => makeRawSample({ runId: plan.run.id, collector: "client", metric, value, observedAt: closeObservedAt, dimensions: dimensions(plan, "client", location) }))
          ]);
          record.leftAtMs = tickMs;
          if (stopped) break;
        }
        if (!stopped) {
          await Promise.all(toClose.map(record => record.context.close()));
          for (const record of toClose) record.closed = true;
        }
      }
      if (!stopped && Date.now() > tickMs + thresholds.maxCollectorIntervalSeconds * 1000) {
        throw invalid("A driver action exceeded the bounded observation interval", "DRIVER_INTERVAL_OVERRUN");
      }
      if (stopped) break;
    }
    if (stopped) {
      await publishSharedStop(sharedStopFile, plan, hostPreflight.hostId, "STOPPED", stopped.breach.metric);
      await closeAll(browsers);
      const artifactManifest = await writeStoppedBundle({
        outputDirectory,
        plan,
        rawSamples,
        stopped,
        collectorMapping,
        environment: safeEnvironment,
        signer: evidenceSigner
      });
      return { ...stopped, artifactManifest };
    }
    if (launchFailure) throw launchFailure;
    if (records.some(record => !record.closed)) throw invalid("Ramp-down did not close every participant", "RAMP_DOWN_INCOMPLETE");

    rawSamples.sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.id.localeCompare(right.id));
    const run = {
      id: plan.run.id,
      issuedAt: plan.run.issuedAt,
      startedAt,
      endedAt,
      driver: {
        name: "yenhubs-playwright-capacity",
        version: DRIVER_VERSION,
        sha256: driverSha256,
        protocol: plan.runtime.driverProtocol,
        nodeVersion: process.version
      },
      browser: {
        name: "chromium",
        version: browsers[0].version(),
        profile: plan.runtime.browserProfile
      }
    };
    await closeAll(browsers);
    const generatorInventory = await capturePhysicalGeneratorInventory({
      plan,
      run,
      hostId: hostPreflight.hostId
    });
    if (hostPreflight.distributed) {
      const shard = {
        schemaVersion: 1,
        state: "SHARD_COMPLETE",
        certified: false,
        planId: plan.planId,
        runId: plan.run.id,
        hostId: hostPreflight.hostId,
        workerIds: [...hostPreflight.workerIds],
        participantIds: definitions.map(definition => definition.participantId),
        collectorLeader,
        collectorMapping,
        generatorPreflight: hostPreflight,
        run,
        rawArtifact: rawArtifact(rawSamples)
      };
      const artifactManifest = await writeShardBundle({
        outputDirectory,
        plan,
        rawSamples,
        shard,
        environment: safeEnvironment,
        generatorInventory,
        signer: evidenceSigner
      });
      return { ...shard, artifactManifest };
    }
    const evidence = buildCompletedEvidence({ plan, thresholds, rawSamples, run, collectorMapping });
    const report = buildReport({ plan, evidence, thresholds, rawSamples, allowTestTrust });
    const manifest = await writeCompletedBundle({
      outputDirectory,
      plan,
      rawSamples,
      evidence,
      report,
      environment: safeEnvironment,
      collectorEndpoint: safety.collectorEndpoint,
      driverSha256,
      generatorInventory,
      signer: evidenceSigner
    });
    return { ...report, artifactManifest: manifest };
  } catch (error) {
    if (sharedStopPollError && !stopped) error = sharedStopPollError;
    if (stopped) {
      await publishSharedStop(sharedStopFile, plan, hostPreflight.hostId, "STOPPED", stopped.breach.metric);
      await closeAll(browsers);
      const artifactManifest = await writeStoppedBundle({
        outputDirectory,
        plan,
        rawSamples,
        stopped,
        collectorMapping,
        environment: safeEnvironment,
        signer: evidenceSigner
      });
      return { ...stopped, artifactManifest };
    }
    await publishSharedStop(sharedStopFile, plan, hostPreflight.hostId, "FAILED", error?.code ?? "UNEXPECTED_ERROR");
    if (!stopped) {
      const forensicDirectory = resolve(outputDirectory, "forensic");
      await mkdir(forensicDirectory, { recursive: true, mode: 0o700 });
      await writeFailureBundle({
        outputDirectory: forensicDirectory,
        plan,
        rawSamples,
        error,
        collectorMapping,
        environment: safeEnvironment,
        signer: evidenceSigner
      });
    }
    throw error;
  } finally {
    acceptingSamples = false;
    if (sharedStopTimer) clearInterval(sharedStopTimer);
    eventLoopHistogram.disable();
    await closeAll(browsers);
  }
}

export function driverContractSummary(plan, thresholds) {
  return {
    implementation: "playwright",
    browserShards: plan.totals.workers,
    maximumClientsPerShard: Math.max(...plan.rooms.flatMap(room => room.workers.map(worker => worker.participantCount))),
    clientRuntime: plan.scenario.clientRuntime,
    generatorHosts: plan.executionTopology.hosts.length,
    maximumBrowserProcessesPerHost: plan.executionTopology.maxBrowserProcessesPerHost,
    maximumContextsPerHost: plan.executionTopology.maxContextsPerHost,
    distributedAggregationRequired: plan.executionTopology.mode === "distributed-workers",
    rawProtocol: "yenhubs-capacity-ndjson-v3",
    movementProof: "bounded-keyboard-input-plus-avatar-rig-displacement",
    requiredServerCollectors: expectedCollectors(plan, thresholds).filter(name => SERVER_COLLECTORS.has(name)),
    requiredServerMetrics: serverMetricNames(plan, thresholds),
    outputRoot: "tests/capacity/output/playwright/capacity/<runId>",
    arbitraryDriverAllowed: false,
    productionAllowed: false
  };
}

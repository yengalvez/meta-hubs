#!/usr/bin/env node

// Watches the complete Pod event stream during destructive recovery windows.
// It emits no Kubernetes payloads and records only a fixed failure code.

import crypto from "node:crypto";
import fs from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  classifyRunnerNamespacePod,
  completeRunnerNamespaceInventory
} = require("../hubs-cloud/community-edition/apply/runner-guard-reconciliation.js");

const MAX_LIST_BYTES = 8 * 1024 * 1024;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const WATCH_TIMEOUT_SECONDS = 2;
const FINAL_STABLE_SECONDS = 61;
const FINAL_WATCH_TIMEOUT_SECONDS = 65;
const MAX_DURABLE_BASELINE_BYTES = 1024 * 1024;
const DURABLE_RUNNER_NAMESPACE = "hcce-bot-runners";
const SHA256 = /^[a-f0-9]{64}$/;
const RUNNER_NAME = /^bot-runner-[a-f0-9]{16}-[a-f0-9]{8}$/;
const ROOM_KEY = /^[a-f0-9]{20}$/;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const activeChildren = new Set();

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function exactArguments(argv) {
  if (![12, 14].includes(argv.length)) fail("arguments");
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      ![
        "--context", "--namespace", "--runner-namespace", "--stop", "--failure", "--ready",
        "--progress"
      ].includes(key) ||
      !value || values.has(key)
    ) fail("arguments");
    values.set(key, value);
  }
  if (values.size !== argv.length / 2) fail("arguments");
  for (const required of [
    "--context", "--namespace", "--runner-namespace", "--stop", "--failure", "--ready"
  ]) {
    if (!values.has(required)) fail("arguments");
  }
  if ((argv.length === 14) !== values.has("--progress")) fail("arguments");
  if (!/^[A-Za-z0-9_.:@/-]{1,253}$/.test(values.get("--context"))) fail("context");
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(values.get("--namespace"))) fail("namespace");
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(values.get("--runner-namespace"))) {
    fail("runner_namespace");
  }
  for (const marker of ["--stop", "--failure", "--ready", "--progress"]) {
    if (!values.has(marker)) continue;
    if (!path.isAbsolute(values.get(marker))) fail("marker_path");
  }
  return values;
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validResourceVersion(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value !== "0" && !/[\u0000-\u001f\u007f]/u.test(value);
}

function durableFenceRecord(record) {
  return {
    name: record.name,
    uid: record.uid,
    room_key: record.roomKey,
    process_generation: record.processGeneration,
    state: "fenced"
  };
}

function canonicalDurableFenceInventory(value) {
  if (!Array.isArray(value) || value.length > 10_000) {
    fail("durable_fence_baseline_contract");
  }
  const names = new Set();
  const uids = new Set();
  const normalized = value.map(record => {
    if (
      !object(record) ||
      Object.keys(record).sort().join(",") !==
        "name,process_generation,room_key,state,uid" ||
      typeof record.name !== "string" || !RUNNER_NAME.test(record.name) ||
      typeof record.uid !== "string" || !record.uid ||
      /[\u0000-\u001f\u007f]/u.test(record.uid) ||
      typeof record.room_key !== "string" || !ROOM_KEY.test(record.room_key) ||
      typeof record.process_generation !== "string" ||
      !UUID_V4.test(record.process_generation) || record.state !== "fenced" ||
      names.has(record.name) || uids.has(record.uid)
    ) {
      fail("durable_fence_baseline_contract");
    }
    names.add(record.name);
    uids.add(record.uid);
    return {
      name: record.name,
      uid: record.uid,
      room_key: record.room_key,
      process_generation: record.process_generation,
      state: "fenced"
    };
  }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  return JSON.stringify(normalized);
}

function normalizeCompleteRunnerPodList(podList, namespace) {
  if (
    namespace !== DURABLE_RUNNER_NAMESPACE ||
    !object(podList) || podList.apiVersion !== "v1" || podList.kind !== "PodList" ||
    !object(podList.metadata) || !validResourceVersion(podList.metadata.resourceVersion) ||
    (Object.hasOwn(podList.metadata, "continue") && podList.metadata.continue !== "") ||
    (Object.hasOwn(podList.metadata, "remainingItemCount") &&
      podList.metadata.remainingItemCount !== 0) ||
    !Array.isArray(podList.items)
  ) {
    fail("durable_runner_list_contract");
  }
  const names = new Set();
  const items = podList.items.map(pod => {
    if (
      !object(pod) || (pod.apiVersion !== undefined && pod.apiVersion !== "v1") ||
      (pod.kind !== undefined && pod.kind !== "Pod") || !object(pod.metadata) ||
      typeof pod.metadata.name !== "string" || !pod.metadata.name ||
      pod.metadata.namespace !== namespace || names.has(pod.metadata.name)
    ) {
      fail("durable_runner_list_item_contract");
    }
    names.add(pod.metadata.name);
    // Kubernetes may omit TypeMeta from objects embedded in a LIST. It is
    // restored only after the collection and namespace have been checked;
    // watch event objects must carry exact TypeMeta themselves.
    return { ...pod, apiVersion: "v1", kind: "Pod" };
  });
  return { ...podList, items };
}

function durableInventoryFromPodList(podList, namespace) {
  let inventory;
  try {
    inventory = completeRunnerNamespaceInventory(
      normalizeCompleteRunnerPodList(podList, namespace)
    );
  } catch (error) {
    if (error?.code && String(error.code).startsWith("durable_")) throw error;
    fail("durable_runner_namespace_contract");
  }
  if (!validResourceVersion(inventory.resourceVersion)) {
    fail("durable_runner_list_contract");
  }
  if (inventory.runners.size !== 0 || inventory.intents.size !== 0) {
    fail("durable_runner_namespace_not_quiescent");
  }
  const fences = [...inventory.fences.values()]
    .map(({ record }) => durableFenceRecord(record));
  const canonical = canonicalDurableFenceInventory(fences);
  return {
    resourceVersion: inventory.resourceVersion,
    fences: JSON.parse(canonical),
    canonical
  };
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid &&
    left.nlink === right.nlink && left.isFile() && right.isFile();
}

function privateBaselineDescriptor(baselinePath, flags, expectedSize = null) {
  if (typeof baselinePath !== "string" || !path.isAbsolute(baselinePath)) {
    fail("durable_fence_baseline_path");
  }
  let descriptor;
  try {
    const before = fs.lstatSync(baselinePath, { bigint: true });
    descriptor = fs.openSync(
      baselinePath,
      flags | (fs.constants.O_NOFOLLOW || 0)
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const currentUid = typeof process.getuid === "function"
      ? BigInt(process.getuid())
      : opened.uid;
    if (
      !sameFileIdentity(before, opened) || before.isSymbolicLink() ||
      opened.uid !== currentUid || (opened.mode & 0o7777n) !== 0o600n ||
      opened.size > BigInt(MAX_DURABLE_BASELINE_BYTES) ||
      (expectedSize !== null && opened.size !== BigInt(expectedSize))
    ) {
      fail("durable_fence_baseline_file_contract");
    }
    return { descriptor, identity: opened };
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    if (error?.code && String(error.code).startsWith("durable_")) throw error;
    fail("durable_fence_baseline_file_contract");
  }
}

function writeInitialDurableFenceBaseline(baselinePath, canonical) {
  const bytes = Buffer.from(canonical, "utf8");
  if (bytes.length < 2 || bytes.length > MAX_DURABLE_BASELINE_BYTES) {
    fail("durable_fence_baseline_size");
  }
  let descriptor;
  try {
    const opened = privateBaselineDescriptor(
      baselinePath,
      fs.constants.O_RDWR,
      0
    );
    descriptor = opened.descriptor;
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(baselinePath, { bigint: true });
    if (
      !sameFileIdentity(opened.identity, after) || !sameFileIdentity(after, named) ||
      after.size !== BigInt(bytes.length) || (after.mode & 0o7777n) !== 0o600n
    ) {
      fail("durable_fence_baseline_identity_changed");
    }
    const readback = Buffer.alloc(bytes.length);
    if (
      fs.readSync(descriptor, readback, 0, readback.length, 0) !== bytes.length ||
      !crypto.timingSafeEqual(readback, bytes)
    ) {
      fail("durable_fence_baseline_write");
    }
    fs.closeSync(descriptor);
    descriptor = undefined;
    return crypto.createHash("sha256").update(bytes).digest("hex");
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    if (error?.code && String(error.code).startsWith("durable_")) throw error;
    fail("durable_fence_baseline_write");
  } finally {
    bytes.fill(0);
  }
}

function readDurableFenceBaseline(baselinePath, expectedSha256) {
  if (typeof expectedSha256 !== "string" || !SHA256.test(expectedSha256)) {
    fail("durable_fence_baseline_digest");
  }
  let descriptor;
  let bytes;
  try {
    const opened = privateBaselineDescriptor(baselinePath, fs.constants.O_RDONLY);
    descriptor = opened.descriptor;
    if (opened.identity.size < 2n) fail("durable_fence_baseline_size");
    bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(baselinePath, { bigint: true });
    if (
      !sameFileIdentity(opened.identity, after) || !sameFileIdentity(after, named) ||
      after.size !== BigInt(bytes.length)
    ) {
      fail("durable_fence_baseline_identity_changed");
    }
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    if (digest !== expectedSha256) fail("durable_fence_baseline_digest");
    const source = bytes.toString("utf8");
    let value;
    try {
      value = JSON.parse(source);
    } catch {
      fail("durable_fence_baseline_json");
    }
    if (canonicalDurableFenceInventory(value) !== source) {
      fail("durable_fence_baseline_not_canonical");
    }
    fs.closeSync(descriptor);
    descriptor = undefined;
    return { canonical: source, fences: value, sha256: digest };
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    if (error?.code && String(error.code).startsWith("durable_")) throw error;
    fail("durable_fence_baseline_read");
  } finally {
    if (bytes) bytes.fill(0);
  }
}

function durableRunnerListRawPath(namespace) {
  if (namespace !== DURABLE_RUNNER_NAMESPACE) fail("durable_runner_list_path");
  return `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods`;
}

function durableRunnerWatchRawPath(namespace, resourceVersion, timeoutSeconds = 600) {
  if (
    namespace !== DURABLE_RUNNER_NAMESPACE ||
    !validResourceVersion(resourceVersion) ||
    !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600
  ) {
    fail("durable_runner_watch_path");
  }
  const query = new URLSearchParams({
    watch: "true",
    allowWatchBookmarks: "true",
    resourceVersion,
    timeoutSeconds: String(timeoutSeconds)
  });
  return `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods?${query.toString()}`;
}

class DurableRunnerWatchEvidence {
  constructor(namespace, initialResourceVersion, fences) {
    if (
      namespace !== DURABLE_RUNNER_NAMESPACE ||
      !validResourceVersion(initialResourceVersion)
    ) {
      fail("durable_runner_watch_evidence_input");
    }
    const canonical = canonicalDurableFenceInventory(fences);
    this.namespace = namespace;
    this.lastResourceVersion = initialResourceVersion;
    this.lastBookmarkResourceVersion = null;
    this.bookmarkSequence = 0;
    this.baselineCanonical = canonical;
    this.baselineByName = new Map(
      JSON.parse(canonical).map(record => [record.name, record])
    );
    this.violation = false;
    this.error = null;
  }

  ingest(event) {
    if (this.error || this.violation) return;
    if (!object(event) || typeof event.type !== "string" || !object(event.object)) {
      this.error = "durable_runner_watch_event_contract";
      return;
    }
    if (event.type === "ERROR") {
      this.error = event.object?.code === 410
        ? "durable_runner_watch_resource_version_expired"
        : "durable_runner_watch_error_event";
      return;
    }
    if (!["ADDED", "MODIFIED", "DELETED", "BOOKMARK"].includes(event.type)) {
      this.error = "durable_runner_watch_event_type";
      return;
    }
    const resourceVersion = event.object?.metadata?.resourceVersion;
    if (!validResourceVersion(resourceVersion)) {
      this.error = event.type === "BOOKMARK"
        ? "durable_runner_watch_bookmark_contract"
        : "durable_runner_watch_event_resource_version";
      return;
    }
    this.lastResourceVersion = resourceVersion;
    if (event.type === "BOOKMARK") {
      this.lastBookmarkResourceVersion = resourceVersion;
      this.bookmarkSequence += 1;
      return;
    }
    if (
      event.object.apiVersion !== "v1" || event.object.kind !== "Pod" ||
      event.object?.metadata?.namespace !== this.namespace
    ) {
      this.error = "durable_runner_watch_object_contract";
      return;
    }
    let classified;
    try {
      classified = classifyRunnerNamespacePod(event.object);
    } catch (error) {
      this.error = error?.message === "runner_namespace_unknown_pod"
        ? "durable_runner_watch_unknown_object"
        : "durable_runner_watch_object_contract";
      return;
    }
    if (classified.type !== "fence") {
      this.violation = true;
      return;
    }
    if (event.type !== "MODIFIED") {
      this.violation = true;
      return;
    }
    const observed = durableFenceRecord(classified.record);
    const baseline = this.baselineByName.get(observed.name);
    if (!baseline || canonicalDurableFenceInventory([observed]) !==
      canonicalDurableFenceInventory([baseline])) {
      this.violation = true;
    }
  }

  hasCausalBookmarkAfter(sequence) {
    return Number.isSafeInteger(sequence) && sequence >= 0 &&
      this.bookmarkSequence > sequence &&
      validResourceVersion(this.lastBookmarkResourceVersion);
  }
}

function durableRunnerWatchState(namespace, inventory, baseline) {
  const evidence = new DurableRunnerWatchEvidence(
    namespace,
    inventory.resourceVersion,
    baseline.fences
  );
  return {
    baselineSha256: baseline.sha256,
    bookmarkBaseline: evidence.bookmarkSequence,
    resourceVersion: inventory.resourceVersion,
    watchRawPath: durableRunnerWatchRawPath(namespace, inventory.resourceVersion),
    evidence
  };
}

function captureInitialDurableRunnerWatch({ podList, namespace, baselinePath }) {
  const inventory = durableInventoryFromPodList(podList, namespace);
  const baselineSha256 = writeInitialDurableFenceBaseline(
    baselinePath,
    inventory.canonical
  );
  return durableRunnerWatchState(namespace, inventory, {
    fences: inventory.fences,
    sha256: baselineSha256
  });
}

function prepareDurableRunnerWatchHandoff({
  podList,
  namespace,
  baselinePath,
  baselineSha256
}) {
  // Handoffs are deliberately read-only: the caller supplies both the original
  // path and digest, and a fresh LIST must match them before its exact-RV watch
  // can become a successor. Current state is never captured or adopted here.
  const baseline = readDurableFenceBaseline(baselinePath, baselineSha256);
  const inventory = durableInventoryFromPodList(podList, namespace);
  if (inventory.canonical !== baseline.canonical) {
    fail("durable_fence_inventory_changed");
  }
  return durableRunnerWatchState(namespace, inventory, baseline);
}

function forbiddenRecoveryPod(pod, namespace, parentNamespace) {
  const labels = pod.metadata.labels || {};
  return namespace !== parentNamespace || labels.app === "bot-runner" ||
    labels.component === "bot-runner" ||
    labels["yenhubs.org/managed-by"] === "bot-orchestrator" ||
    (namespace === parentNamespace && pod.spec.serviceAccountName === "bot-orchestrator");
}

function validatePod(pod, namespace) {
  if (
    !object(pod) || !object(pod.metadata) ||
    typeof pod.metadata.name !== "string" || !pod.metadata.name ||
    typeof pod.metadata.uid !== "string" || !pod.metadata.uid ||
    pod.metadata.namespace !== namespace ||
    (pod.metadata.labels !== undefined && !object(pod.metadata.labels)) ||
    !object(pod.spec) ||
    (pod.spec.serviceAccountName !== undefined &&
      typeof pod.spec.serviceAccountName !== "string") ||
    typeof pod.metadata.resourceVersion !== "string" || !pod.metadata.resourceVersion
  ) fail("pod_inventory");
}

function parsePodList(text, namespace, parentNamespace) {
  let list;
  try {
    list = JSON.parse(text);
  } catch {
    fail("pod_list_json");
  }
  if (
    !object(list) || list.apiVersion !== "v1" || list.kind !== "PodList" ||
    !object(list.metadata) || typeof list.metadata.resourceVersion !== "string" ||
    !list.metadata.resourceVersion || !Array.isArray(list.items)
  ) fail("pod_list_contract");
  for (const pod of list.items) {
    validatePod(pod, namespace);
    if (forbiddenRecoveryPod(pod, namespace, parentNamespace)) fail("runner_present");
  }
  return list.metadata.resourceVersion;
}

function listPods(kubectl, context, namespace, parentNamespace) {
  try {
    return parsePodList(execFileSync(kubectl, [
      "--context", context,
      "--request-timeout=45s",
      "get", "--raw", `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods`
    ], {
      encoding: "utf8",
      maxBuffer: MAX_LIST_BYTES,
      stdio: ["ignore", "pipe", "ignore"]
    }), namespace, parentNamespace);
  } catch (error) {
    if (error?.code && String(error.code).startsWith("runner_")) throw error;
    if (error?.code && String(error.code).startsWith("pod_")) throw error;
    fail("pod_list_failed");
  }
}

function openMarker(markerPath, flags) {
  let descriptor;
  try {
    descriptor = fs.openSync(markerPath, flags | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 2048) {
      fs.closeSync(descriptor);
      fail("marker_contract");
    }
    return descriptor;
  } catch (error) {
    if (error?.code === "marker_contract") throw error;
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    const contractError = new Error("marker_contract");
    contractError.code = "marker_contract";
    contractError.causeCode = error?.code;
    throw contractError;
  }
}

function writeMarker(markerPath, value) {
  let descriptor;
  try {
    descriptor = openMarker(markerPath, fs.constants.O_WRONLY);
    fs.ftruncateSync(descriptor, 0);
    fs.writeFileSync(descriptor, `${value}\n`, { encoding: "utf8" });
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    if (error?.code === "marker_contract") throw error;
    fail("marker_write");
  }
}

function writeProgressMarker(markerPath, value) {
  const nextPath = `${markerPath}.next`;
  let descriptor;
  try {
    descriptor = fs.openSync(
      nextPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600
    );
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) fail("marker_contract");
    fs.writeFileSync(descriptor, `${value}\n`, { encoding: "utf8" });
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(nextPath, markerPath);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(nextPath); } catch {}
    if (error?.code === "marker_contract") throw error;
    fail("marker_write");
  }
}

function readMarker(markerPath) {
  let descriptor;
  try {
    descriptor = openMarker(markerPath, fs.constants.O_RDONLY);
    const value = fs.readFileSync(descriptor, "utf8");
    fs.closeSync(descriptor);
    return value;
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    if (error?.code === "marker_contract") throw error;
    fail("marker_read");
  }
}

function stopRequest(markerPath, namespaces) {
  const value = readMarker(markerPath);
  if (value === "") return null;
  if (value === "discard\n") return { discard: true };
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail("stop_contract");
  }
  if (
    !object(parsed) || Object.keys(parsed).sort().join(",") !== "boundaries,stop" ||
    parsed.stop !== true || !Array.isArray(parsed.boundaries) ||
    parsed.boundaries.length !== namespaces.length
  ) fail("stop_contract");
  const boundaries = new Map();
  for (const boundary of parsed.boundaries) {
    if (
      !object(boundary) ||
      Object.keys(boundary).sort().join(",") !== "namespace,resourceVersion" ||
      !namespaces.includes(boundary.namespace) || boundaries.has(boundary.namespace) ||
      typeof boundary.resourceVersion !== "string" || !boundary.resourceVersion
    ) fail("stop_contract");
    boundaries.set(boundary.namespace, boundary.resourceVersion);
  }
  return { discard: false, boundaries };
}

function eventResourceVersion(event, namespace, parentNamespace) {
  if (!object(event) || typeof event.type !== "string" || !object(event.object)) {
    fail("watch_event_contract");
  }
  if (event.type === "ERROR") fail("watch_error_event");
  if (event.type === "BOOKMARK") {
    const version = event.object?.metadata?.resourceVersion;
    if (typeof version !== "string" || !version) fail("watch_bookmark_contract");
    return version;
  }
  if (!["ADDED", "MODIFIED", "DELETED"].includes(event.type)) fail("watch_event_type");
  validatePod(event.object, namespace);
  if (forbiddenRecoveryPod(event.object, namespace, parentNamespace)) fail("runner_event");
  return event.object.metadata.resourceVersion;
}

async function watchOnce({
  kubectl, context, namespace, parentNamespace, resourceVersion,
  timeoutSeconds = WATCH_TIMEOUT_SECONDS
}) {
  const query = new URLSearchParams({
    allowWatchBookmarks: "true",
    resourceVersion,
    timeoutSeconds: String(timeoutSeconds),
    watch: "true"
  });
  const rawPath = `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods?${query.toString()}`;
  const requestTimeoutSeconds = Math.max(45, timeoutSeconds + 10);
  const child = spawn(kubectl, [
    "--context", context, `--request-timeout=${requestTimeoutSeconds}s`,
    "get", "--raw", rawPath
  ], {
    stdio: ["ignore", "pipe", "ignore"]
  });
  let buffer = "";
  let latestVersion = resourceVersion;
  let streamError = null;
  const spawned = new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const closed = new Promise(resolve => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  activeChildren.add(child);

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    if (streamError) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer, "utf8") > MAX_EVENT_BYTES) {
      streamError = new Error("watch_event_oversize");
      child.kill("SIGTERM");
      return;
    }
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        latestVersion = eventResourceVersion(JSON.parse(line), namespace, parentNamespace);
      } catch (error) {
        streamError = error;
        child.kill("SIGTERM");
        return;
      }
    }
  });

  await spawned.catch(() => {
    activeChildren.delete(child);
    fail("watch_spawn");
  });

  const watchdog = setTimeout(() => child.kill("SIGKILL"), (timeoutSeconds + 8) * 1000);
  const exit = await closed;
  activeChildren.delete(child);
  clearTimeout(watchdog);
  if (buffer.trim() && !streamError) {
    try {
      latestVersion = eventResourceVersion(JSON.parse(buffer), namespace, parentNamespace);
    } catch (error) {
      streamError = error;
    }
  }
  if (streamError) throw streamError;
  if (exit.code !== 0 || exit.signal) fail("watch_terminated");
  return latestVersion;
}

function requiredFinalStableSeconds(context) {
  if (
    process.env.YENHUBS_RECOVERY_TEST_MODE === "local-fixture" &&
    context === "fixture-context"
  ) {
    const fixtureSeconds = process.env.RECOVERY_TEST_STABLE_ABSENCE_SECONDS || "0";
    if (!/^[0-2]$/.test(fixtureSeconds)) fail("test_stable_window");
    return Number(fixtureSeconds);
  }
  return FINAL_STABLE_SECONDS;
}

async function watchBoundaryStable({
  kubectl, context, namespace, parentNamespace, resourceVersion
}) {
  const requiredSeconds = requiredFinalStableSeconds(context);
  const startedAt = Date.now();
  let latestVersion = resourceVersion;
  do {
    latestVersion = await watchOnce({
      kubectl,
      context,
      namespace,
      parentNamespace,
      resourceVersion: latestVersion,
      timeoutSeconds: FINAL_WATCH_TIMEOUT_SECONDS
    });
  } while (Date.now() - startedAt < requiredSeconds * 1000);
  return latestVersion;
}

async function main() {
  const args = exactArguments(process.argv.slice(2));
  const kubectl = process.env.KUBECTL_BIN || "kubectl";
  const context = args.get("--context");
  const namespace = args.get("--namespace");
  const runnerNamespace = args.get("--runner-namespace");
  const stopPath = args.get("--stop");
  const failurePath = args.get("--failure");
  const readyPath = args.get("--ready");
  const progressPath = args.get("--progress");
  const namespaces = [...new Set([namespace, runnerNamespace])];
  let completedRounds = 0;
  if (
    readMarker(stopPath) !== "" || readMarker(failurePath) !== "" ||
    readMarker(readyPath) !== "" || (progressPath && readMarker(progressPath) !== "")
  ) {
    fail("marker_initial_state");
  }
  const resourceVersions = new Map(
    namespaces.map(currentNamespace => [
      currentNamespace,
      listPods(kubectl, context, currentNamespace, namespace)
    ])
  );

  while (true) {
    const nextVersions = await Promise.all(namespaces.map(currentNamespace => watchOnce({
      kubectl,
      context,
      namespace: currentNamespace,
      parentNamespace: namespace,
      resourceVersion: resourceVersions.get(currentNamespace)
    })));
    namespaces.forEach((currentNamespace, index) => {
      resourceVersions.set(currentNamespace, nextVersions[index]);
    });
    completedRounds += 1;
    if (progressPath) writeProgressMarker(progressPath, String(completedRounds));
    if (completedRounds === 1) writeMarker(readyPath, "ready");
    const requestedStop = stopRequest(stopPath, namespaces);
    if (requestedStop?.discard) return;
    if (requestedStop) {
      // Each stop boundary comes from a complete, empty LIST performed while
      // this watcher is already live. Re-watch from those exact RVs so every
      // ADDED+DELETED event between the boundary LIST and this handoff is
      // replayed by the API server. The close of these exact-RV watches is the
      // observation linearization point; callers keep creation authority inert
      // and enforce a post-close stable-absence window before reactivation.
      await Promise.all(namespaces.map(currentNamespace => watchBoundaryStable({
        kubectl,
        context,
        namespace: currentNamespace,
        parentNamespace: namespace,
        resourceVersion: requestedStop.boundaries.get(currentNamespace)
      })));
      return;
    }
  }
}

async function runCli() {
  try {
    await main();
  } catch (error) {
    if (process.env.YENHUBS_WATCH_TEST_DEBUG === "1") {
      process.stderr.write(
        `watcher_error:${String(error?.stack || error?.code || "watch_failed")}` +
        `:cause=${String(error?.causeCode || "none")}\n`
      );
    }
    for (const child of activeChildren) child.kill("SIGTERM");
    const args = (() => {
      try { return exactArguments(process.argv.slice(2)); } catch { return null; }
    })();
    if (args) {
      try { writeMarker(args.get("--failure"), "runner_watch_failed"); } catch {}
    }
    process.exitCode = 1;
  }
}

export {
  DurableRunnerWatchEvidence,
  canonicalDurableFenceInventory,
  captureInitialDurableRunnerWatch,
  durableInventoryFromPodList,
  durableRunnerListRawPath,
  durableRunnerWatchRawPath,
  prepareDurableRunnerWatchHandoff,
  readDurableFenceBaseline
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCli();
}

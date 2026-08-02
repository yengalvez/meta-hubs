#!/usr/bin/env node

// Publishes bounded health evidence for the durable-v2 runner quiescence
// window. The server-side recovery-operation admission fence is the causal
// authority; this process repeatedly proves fresh, complete Pod snapshots and
// rejects any runner/fence or legacy-parent drift without persisting API data.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  DurableRunnerWatchEvidence,
  durableInventoryFromPodList,
  readDurableFenceBaseline
} from "./watch-bot-runner-pods.mjs";

const require = createRequire(import.meta.url);
const {
  RECOVERY_OPERATION_FENCE_POLICY_NAME,
  admissionPolicyIsObserved,
  exactRecoveryOperationFenceBinding,
  exactRecoveryOperationFencePolicy
} = require("../hubs-cloud/community-edition/apply/runner-activation.js");
const {
  HOLDER_PATTERN,
  LEASE_DURATION_SECONDS,
  MUTATION_LEASE_MAX_AGE_MS,
  OPERATION_LEASE_LABEL,
  OPERATION_LEASE_LABEL_VALUE,
  OPERATION_LEASE_NAME
} = require("../hubs-cloud/community-edition/apply/operation-lease.js");

const RUNNER_NAMESPACE = "hcce-bot-runners";
const MAX_LIST_BYTES = 8 * 1024 * 1024;
const MAX_WATCH_BYTES = 8 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const MAX_CONTROL_BASELINE_BYTES = 2 * 1024 * 1024;
const MAX_CONTROL_OBJECT_BYTES = 2 * 1024 * 1024;
const WATCH_TIMEOUT_SECONDS = 2;
const POD_WATCH_SESSION_TIMEOUT_SECONDS = 30;
const MINIMUM_WATCH_WINDOW_MS = 1_500;
const POD_WATCH_HANDSHAKE_DEADLINE_MS = 7_000;
// The local fixture still spawns a kubectl shim and jq for each namespace.
// Give that real process boundary the same bounded handshake allowance as the
// API path so host scheduling load cannot turn a healthy initial boundary into
// a one-second-only test failure.
const LOCAL_FIXTURE_HANDSHAKE_DEADLINE_MS = POD_WATCH_HANDSHAKE_DEADLINE_MS;
const MAX_INITIAL_POD_EVENTS = 10_000;
const CHILD_DEADLINE_MS = 7_000;
const CHILD_TERM_GRACE_MS = 750;
const INITIAL_EVENTS_END = "k8s.io/initial-events-end";
const activeChildren = new Map();

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return object(value) &&
    Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function validResourceVersion(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value !== "0" && !/[\u0000-\u001f\u007f]/u.test(value);
}

function exactArguments(argv) {
  const allowed = new Set([
    "--context", "--namespace", "--runner-namespace", "--baseline",
    "--baseline-sha256", "--control-baseline", "--control-baseline-sha256",
    "--stop", "--failure", "--ready", "--progress", "--final", "--authority"
  ]);
  if (argv.length !== allowed.size * 2) fail("arguments");
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || !value || values.has(key)) fail("arguments");
    values.set(key, value);
  }
  if (values.size !== allowed.size) fail("arguments");
  if (!/^[A-Za-z0-9_.:@/-]{1,253}$/.test(values.get("--context"))) fail("context");
  for (const key of ["--namespace", "--runner-namespace"]) {
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(values.get(key))) {
      fail("namespace");
    }
  }
  if (values.get("--runner-namespace") !== RUNNER_NAMESPACE ||
      values.get("--namespace") === RUNNER_NAMESPACE) {
    fail("namespace");
  }
  for (const key of ["--baseline-sha256", "--control-baseline-sha256"]) {
    if (!/^[a-f0-9]{64}$/.test(values.get(key))) fail("sha256");
  }
  const paths = [
    "--baseline", "--control-baseline", "--stop", "--failure", "--ready",
    "--progress", "--final", "--authority"
  ].map(key => values.get(key));
  if (paths.some(value => !path.isAbsolute(value)) || new Set(paths).size !== paths.length) {
    fail("marker_path");
  }
  return values;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid &&
    left.nlink === 1n && right.nlink === 1n && left.isFile() && right.isFile();
}

function exactNamedIdentity(filePath, expectedIdentity) {
  let current;
  try {
    current = fs.lstatSync(filePath, { bigint: true });
  } catch {
    fail("file_identity_changed");
  }
  if (current.isSymbolicLink() || !sameFile(expectedIdentity, current)) {
    fail("file_identity_changed");
  }
}

function openMarker(markerPath, flags, maximumBytes = 2048, expectedIdentity = null) {
  let descriptor;
  try {
    const before = fs.lstatSync(markerPath, { bigint: true });
    descriptor = fs.openSync(markerPath, flags | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : opened.uid;
    if (
      before.isSymbolicLink() || !sameFile(before, opened) || opened.uid !== currentUid ||
      (expectedIdentity !== null && !sameFile(expectedIdentity, opened)) ||
      (opened.mode & 0o7777n) !== 0o600n || opened.size > BigInt(maximumBytes)
    ) {
      fail("marker_contract");
    }
    return { descriptor, identity: opened };
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    if (error?.code === "marker_contract") throw error;
    fail("marker_contract");
  }
}

function readMarker(markerPath, expectedIdentity = null) {
  let descriptor;
  let openedIdentity;
  try {
    ({ descriptor, identity: openedIdentity } = openMarker(
      markerPath, fs.constants.O_RDONLY, 2048, expectedIdentity
    ));
    const value = fs.readFileSync(descriptor, "utf8");
    const after = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(markerPath, { bigint: true });
    if (!sameFile(openedIdentity, after) || !sameFile(after, named)) {
      fail("marker_contract");
    }
    fs.closeSync(descriptor);
    return value;
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    throw error;
  }
}

function readPinnedFile(filePath, maximumBytes, expectedIdentity = null) {
  let descriptor;
  let openedIdentity;
  try {
    ({ descriptor, identity: openedIdentity } = openMarker(
      filePath, fs.constants.O_RDONLY, maximumBytes, expectedIdentity
    ));
    const value = fs.readFileSync(descriptor, "utf8");
    const after = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(filePath, { bigint: true });
    if (!sameFile(openedIdentity, after) || !sameFile(after, named)) {
      fail("file_identity_changed");
    }
    fs.closeSync(descriptor);
    return { value, identity: after };
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    throw error;
  }
}

function writeMarker(markerPath, value, expectedIdentity = null) {
  let descriptor;
  let openedIdentity;
  try {
    ({ descriptor, identity: openedIdentity } = openMarker(
      markerPath, fs.constants.O_WRONLY, 2048, expectedIdentity
    ));
    fs.ftruncateSync(descriptor, 0);
    fs.writeFileSync(descriptor, value, { encoding: "utf8" });
    fs.fsyncSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(markerPath, { bigint: true });
    if (!sameFile(openedIdentity, after) || !sameFile(after, named)) {
      fail("marker_contract");
    }
    fs.closeSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    throw error;
  }
}

function writeProgress(markerPath, round, authoritySha256, expectedIdentity) {
  const nextPath = `${markerPath}.next`;
  let descriptor;
  let nextIdentity;
  try {
    descriptor = fs.openSync(
      nextPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW || 0),
      0o600
    );
    nextIdentity = fs.fstatSync(descriptor, { bigint: true });
    if (!nextIdentity.isFile() || nextIdentity.nlink !== 1n ||
        (nextIdentity.mode & 0o7777n) !== 0o600n) {
      fail("marker_contract");
    }
    fs.writeFileSync(
      descriptor, `${authoritySha256}:${round}\n`, { encoding: "ascii" }
    );
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    // Revalidate the published leaf immediately before replacing it. A caller
    // may replace neither the marker nor its .next sibling during a run.
    const current = openMarker(
      markerPath, fs.constants.O_RDONLY, 2048, expectedIdentity
    );
    fs.closeSync(current.descriptor);
    fs.renameSync(nextPath, markerPath);
    const published = openMarker(
      markerPath, fs.constants.O_RDONLY, 2048, nextIdentity
    );
    fs.closeSync(published.descriptor);
    return published.identity;
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(nextPath); } catch {}
    if (error?.code === "marker_contract") throw error;
    fail("marker_write");
  }
}

function parseJson(text, code) {
  try {
    return JSON.parse(text);
  } catch {
    fail(code);
  }
}

function exactControlNamespace(value, name, expectedUid = null) {
  return exactKeys(value, [
    "name", "uid", "resource_version", "phase", "metadata_name_label"
  ]) && value.name === name &&
    typeof value.uid === "string" && value.uid.length > 0 &&
    (expectedUid === null || value.uid === expectedUid) &&
    validResourceVersion(value.resource_version) && value.phase === "Active" &&
    value.metadata_name_label === name;
}

function parseControlBaseline(source, expectedSha256, context, namespace, runnerNamespace) {
  if (sha256(source) !== expectedSha256) fail("control_baseline_digest");
  const baseline = parseJson(source, "control_baseline_json");
  // The producer publishes one exact JSON record followed by LF. Besides
  // excluding alternate serializations, this makes the supplied digest the
  // byte-for-byte capability emitted by watch-checkpoint-writers.mjs.
  if (source !== `${JSON.stringify(baseline)}\n`) fail("control_baseline_serialization");
  const fence = baseline?.recovery_operation_fence;
  if (
    !exactKeys(baseline, [
      "schema_version", "context", "namespace", "namespace_uid", "operation_id",
      "operation_owner", "operation_lock", "lease", "storage_helper", "consumers", "deployments",
      "replica_sets", "pods", "boundaries", "runtime_generation",
      "recovery_operation_fence"
    ]) || baseline.schema_version !== 3 || baseline.context !== context ||
    baseline.namespace !== namespace ||
    typeof baseline.namespace_uid !== "string" || !baseline.namespace_uid ||
    !/^[a-f0-9]{32}$/.test(baseline.operation_id) ||
    !["checkpoint-backup", "checkpoint-restore"].includes(baseline.operation_owner) ||
    baseline.runtime_generation !== "durable-v2" ||
    !Array.isArray(baseline.consumers) || !Array.isArray(baseline.deployments) ||
    !Array.isArray(baseline.replica_sets) || !Array.isArray(baseline.pods) ||
    !object(baseline.boundaries) || !object(baseline.storage_helper) ||
    !exactKeys(baseline.operation_lock, ["name", "uid", "resource_version"]) ||
    !/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(baseline.operation_lock.name) ||
    typeof baseline.operation_lock.uid !== "string" || !baseline.operation_lock.uid ||
    !validResourceVersion(baseline.operation_lock.resource_version) ||
    !exactKeys(baseline.lease, [
      "name", "uid", "holder", "acquire_time", "lease_transitions"
    ]) || baseline.lease.name !== OPERATION_LEASE_NAME ||
    typeof baseline.lease.uid !== "string" || !baseline.lease.uid ||
    !baseline.lease.holder.startsWith("root-recovery:") ||
    !HOLDER_PATTERN.test(baseline.lease.holder) ||
    !Number.isFinite(Date.parse(baseline.lease.acquire_time)) ||
    !Number.isInteger(baseline.lease.lease_transitions) ||
    baseline.lease.lease_transitions < 0 ||
    !exactKeys(fence, ["binding", "namespaces", "policy"]) ||
    !exactKeys(fence.namespaces, ["parent", "runner"]) ||
    !exactControlNamespace(
      fence.namespaces.parent, namespace, baseline.namespace_uid
    ) || !exactControlNamespace(fence.namespaces.runner, runnerNamespace) ||
    !exactKeys(fence.policy, [
      "uid", "resource_version", "generation", "spec_sha256"
    ]) || typeof fence.policy.uid !== "string" || !fence.policy.uid ||
    !validResourceVersion(fence.policy.resource_version) ||
    !Number.isInteger(fence.policy.generation) || fence.policy.generation < 1 ||
    !/^[a-f0-9]{64}$/.test(fence.policy.spec_sha256) ||
    !exactKeys(fence.binding, ["uid", "resource_version", "spec_sha256"]) ||
    typeof fence.binding.uid !== "string" || !fence.binding.uid ||
    !validResourceVersion(fence.binding.resource_version) ||
    !/^[a-f0-9]{64}$/.test(fence.binding.spec_sha256)
  ) {
    fail("control_baseline_contract");
  }
  return baseline;
}

function readControlBaselineCapability(values, expectedIdentity = null) {
  const opened = readPinnedFile(
    values.get("--control-baseline"), MAX_CONTROL_BASELINE_BYTES, expectedIdentity
  );
  const baseline = parseControlBaseline(
    opened.value,
    values.get("--control-baseline-sha256"),
    values.get("--context"),
    values.get("--namespace"),
    values.get("--runner-namespace")
  );
  return {
    baseline,
    canonical: opened.value,
    identity: opened.identity,
    sha256: values.get("--control-baseline-sha256")
  };
}

function signalChild(child, signal) {
  if (!child?.pid) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    fail("kubectl_cleanup");
  }
}

function processGroupExists(child) {
  if (!child?.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    fail("kubectl_cleanup");
  }
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function terminateChildProcessGroup(child, state) {
  if (state.cleanupPromise) return state.cleanupPromise;
  state.cleanupPromise = (async () => {
    try {
      if (!processGroupExists(child)) return;
      signalChild(child, "SIGTERM");
      await delay(CHILD_TERM_GRACE_MS);
      // The kubectl leader can exit on TERM while an exec-credential helper or
      // another descendant remains in its detached process group. Escalate by
      // PGID even after the direct child has closed; checking only exitCode
      // would orphan that descendant.
      if (processGroupExists(child)) signalChild(child, "SIGKILL");
      const deadline = Date.now() + CHILD_TERM_GRACE_MS;
      while (processGroupExists(child) && Date.now() < deadline) {
        await delay(10);
      }
      if (processGroupExists(child)) state.cleanupFailed = true;
    } catch {
      state.cleanupFailed = true;
    }
  })();
  return state.cleanupPromise;
}

async function collectChild(child, state, deadlineMs = CHILD_DEADLINE_MS) {
  const closed = new Promise(resolve => child.once("close", (code, signal) => {
    resolve({ code, signal });
  }));
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    void terminateChildProcessGroup(child, state);
  }, deadlineMs);
  let hardCloseTimer;
  const hardCloseGuard = new Promise(resolve => {
    hardCloseTimer = setTimeout(
      () => resolve({ code: null, signal: "cleanup-deadline" }),
      deadlineMs + CHILD_TERM_GRACE_MS * 2 + 250
    );
  });
  const result = await Promise.race([closed, hardCloseGuard]);
  clearTimeout(deadline);
  clearTimeout(hardCloseTimer);
  if (result.signal === "cleanup-deadline") {
    await terminateChildProcessGroup(child, state);
    fail("kubectl_cleanup");
  }
  if (timedOut || processGroupExists(child)) {
    await terminateChildProcessGroup(child, state);
  }
  activeChildren.delete(child.pid);
  if (state.cleanupFailed) fail("kubectl_cleanup");
  if (timedOut) fail("kubectl_timeout");
  return result;
}

function localFixtureMode(context) {
  return process.env.YENHUBS_RECOVERY_TEST_MODE === "local-fixture" &&
    context === "fixture-context";
}

async function kubectlCapture(
  kubectl,
  context,
  rawPath,
  maximumBytes,
  { requireWatchWindow = false } = {}
) {
  const startedAt = Date.now();
  const child = spawn(kubectl, [
    "--context", context, "--request-timeout=5s", "get", "--raw", rawPath
  ], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const state = {
    stdout: "",
    stderrBytes: 0,
    oversize: false,
    cleanupFailed: false,
    cleanupPromise: null
  };
  child.yenhubsCleanupState = state;
  activeChildren.set(child.pid, child);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    if (state.oversize) return;
    state.stdout += chunk;
    if (Buffer.byteLength(state.stdout, "utf8") > maximumBytes) {
      state.oversize = true;
      try { signalChild(child, "SIGTERM"); } catch { state.cleanupFailed = true; }
    }
  });
  child.stderr.on("data", chunk => {
    state.stderrBytes += chunk.length;
    if (state.stderrBytes > MAX_DIAGNOSTIC_BYTES && !state.oversize) {
      state.oversize = true;
      try { signalChild(child, "SIGTERM"); } catch { state.cleanupFailed = true; }
    }
  });
  const spawned = new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  try {
    await spawned;
  } catch {
    activeChildren.delete(child.pid);
    fail("kubectl_spawn");
  }
  const result = await collectChild(child, state);
  if (state.oversize) fail("kubectl_output_oversize");
  if (result.code !== 0 || result.signal) fail("kubectl_failed");
  if (
    requireWatchWindow &&
    !localFixtureMode(context) &&
    Date.now() - startedAt < MINIMUM_WATCH_WINDOW_MS
  ) {
    fail("watch_early_close");
  }
  return state.stdout;
}

function podListRawPath(namespace) {
  return `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods`;
}

function podWatchRawPath(
  namespace,
  resourceVersion,
  timeoutSeconds = POD_WATCH_SESSION_TIMEOUT_SECONDS
) {
  if (
    !validResourceVersion(resourceVersion) ||
    !Number.isInteger(timeoutSeconds) || timeoutSeconds < 2 || timeoutSeconds > 600
  ) {
    fail("resource_version");
  }
  const query = new URLSearchParams({
    allowWatchBookmarks: "true",
    resourceVersion,
    timeoutSeconds: String(timeoutSeconds),
    watch: "true"
  });
  return `${podListRawPath(namespace)}?${query.toString()}`;
}

function podInitialWatchRawPath(
  namespace,
  resourceVersion,
  timeoutSeconds = POD_WATCH_SESSION_TIMEOUT_SECONDS
) {
  if (
    !validResourceVersion(resourceVersion) ||
    !Number.isInteger(timeoutSeconds) || timeoutSeconds < 2 || timeoutSeconds > 600
  ) {
    fail("resource_version");
  }
  const query = new URLSearchParams({
    allowWatchBookmarks: "true",
    resourceVersion,
    resourceVersionMatch: "NotOlderThan",
    sendInitialEvents: "true",
    timeoutSeconds: String(timeoutSeconds),
    watch: "true"
  });
  return `${podListRawPath(namespace)}?${query.toString()}`;
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function recordPodWatchError(session, error) {
  if (session.error) return;
  session.error = error?.code ? error : codedError("pod_watch_session_failed");
  try { signalChild(session.child, "SIGTERM"); } catch {
    session.cleanupState.cleanupFailed = true;
  }
}

function specialInitialEventsEnd(event) {
  return event?.object?.metadata?.annotations?.[INITIAL_EVENTS_END] === "true";
}

function validateInitialPodState(session, boundaryResourceVersion) {
  const value = {
    apiVersion: "v1",
    kind: "PodList",
    metadata: { resourceVersion: boundaryResourceVersion },
    items: session.initial.items
  };
  if (session.descriptor.key === "runner") {
    runnerListMatchesBaseline(
      value,
      session.descriptor.namespace,
      session.descriptor.baseline.canonical
    );
  } else {
    normalizeCompleteParentList(value, session.descriptor.namespace);
  }
}

function consumePodWatchEvent(session, event) {
  if (!session.initial.required || session.initial.complete) {
    if (specialInitialEventsEnd(event)) {
      fail("pod_watch_initial_boundary_duplicate");
    }
    session.descriptor.cursor = validatePodWatchStream(
      `${JSON.stringify(event)}\n`, session.descriptor
    );
    return;
  }

  if (!object(event) || typeof event.type !== "string" || !object(event.object)) {
    fail("pod_watch_initial_event_contract");
  }
  if (event.type === "ERROR") {
    if (event.object?.code === 410) fail("watch_resource_version_expired");
    fail("watch_error_event");
  }
  if (event.type === "BOOKMARK") {
    if (!specialInitialEventsEnd(event)) {
      fail("pod_watch_initial_boundary_ordinary_bookmark");
    }
    const resourceVersion = event.object?.metadata?.resourceVersion;
    if (
      event.object.apiVersion !== "v1" || event.object.kind !== "Pod" ||
      !validResourceVersion(resourceVersion)
    ) {
      fail("pod_watch_initial_boundary_contract");
    }
    // Kubernetes resourceVersions are opaque. Causality comes exclusively
    // from the exact NotOlderThan request and this server-issued initial-events
    // boundary; no client-side ordering comparison is valid.
    validateInitialPodState(session, resourceVersion);
    if (session.descriptor.key === "runner") {
      session.descriptor.evidence.ingest(event);
      if (session.descriptor.evidence.error) {
        fail(session.descriptor.evidence.error);
      }
      if (session.descriptor.evidence.violation) {
        fail("durable_runner_watch_violation");
      }
    }
    session.descriptor.cursor = resourceVersion;
    session.initial.boundaryResourceVersion = resourceVersion;
    session.initial.items = [];
    session.initial.complete = true;
    return;
  }
  if (
    event.type !== "ADDED" || event.object.apiVersion !== "v1" ||
    event.object.kind !== "Pod"
  ) {
    fail("pod_watch_initial_event_type");
  }
  session.initial.items.push(event.object);
  if (session.initial.items.length > MAX_INITIAL_POD_EVENTS) {
    fail("pod_watch_initial_events_oversize");
  }
}

function consumePodWatchLines(session, { terminal = false } = {}) {
  const lines = session.buffer.split("\n");
  session.buffer = terminal ? "" : lines.pop();
  const complete = terminal ? lines.filter((line, index) =>
    index < lines.length - 1 || line.trim() !== ""
  ) : lines;
  for (const line of complete) {
    if (!line.trim()) continue;
    try {
      consumePodWatchEvent(session, parseJson(line, "watch_event_json"));
    } catch (error) {
      recordPodWatchError(session, error);
      return;
    }
  }
}

function spawnPodWatchSession(
  kubectl,
  context,
  descriptor,
  { requireInitialBoundary = false } = {}
) {
  const rawPath = requireInitialBoundary
    ? podInitialWatchRawPath(descriptor.namespace, descriptor.cursor)
    : podWatchRawPath(descriptor.namespace, descriptor.cursor);
  const child = spawn(kubectl, [
    "--context", context,
    `--request-timeout=${POD_WATCH_SESSION_TIMEOUT_SECONDS + 5}s`,
    "get", "--raw", rawPath
  ], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const cleanupState = {
    cleanupFailed: false,
    cleanupPromise: null
  };
  child.yenhubsCleanupState = cleanupState;
  const session = {
    child,
    cleanupState,
    descriptor,
    rawPath,
    buffer: "",
    stdoutBytes: 0,
    stderrBytes: 0,
    error: null,
    closed: false,
    intentionalClose: false,
    initial: {
      required: requireInitialBoundary,
      complete: !requireInitialBoundary,
      boundaryResourceVersion: null,
      items: []
    },
    startedAt: Date.now(),
    spawnedAt: null,
    exit: null,
    spawned: null,
    closedPromise: null
  };
  activeChildren.set(child.pid, child);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    if (session.error) return;
    session.stdoutBytes += Buffer.byteLength(chunk, "utf8");
    if (session.stdoutBytes > MAX_WATCH_BYTES) {
      recordPodWatchError(session, codedError("kubectl_output_oversize"));
      return;
    }
    session.buffer += chunk;
    consumePodWatchLines(session);
  });
  child.stderr.on("data", chunk => {
    session.stderrBytes += chunk.length;
    if (session.stderrBytes > MAX_DIAGNOSTIC_BYTES) {
      recordPodWatchError(session, codedError("kubectl_output_oversize"));
    }
  });
  session.spawned = new Promise((resolve, reject) => {
    child.once("spawn", () => {
      session.spawnedAt = Date.now();
      resolve();
    });
    child.once("error", error => {
      const wrapped = codedError("kubectl_spawn");
      wrapped.cause = error;
      recordPodWatchError(session, wrapped);
      reject(wrapped);
    });
  });
  session.closedPromise = new Promise(resolve => {
    child.once("close", (code, signal) => {
      consumePodWatchLines(session, { terminal: true });
      session.closed = true;
      session.exit = { code, signal };
      if (session.initial.required && !session.initial.complete && !session.error) {
        recordPodWatchError(session, codedError("pod_watch_initial_boundary_missing"));
      }
      if (!session.intentionalClose && !session.error) {
        const lifetime = Date.now() - (session.spawnedAt || session.startedAt);
        recordPodWatchError(session, codedError(
          lifetime < MINIMUM_WATCH_WINDOW_MS
            ? "watch_early_close"
            : "pod_watch_session_closed"
        ));
      }
      resolve(session.exit);
    });
  });
  return session;
}

function assertPodWatchSessionHealthy(session) {
  if (session.error) throw session.error;
  if (session.closed) fail("pod_watch_session_closed");
  if (!session.spawnedAt) fail("pod_watch_session_not_started");
}

function assertPodWatchGroupHealthy(group) {
  if (!group || !Array.isArray(group.sessions) || group.sessions.length !== 2) {
    fail("pod_watch_group_contract");
  }
  group.sessions.forEach(assertPodWatchSessionHealthy);
}

async function startPodWatchGroup(
  kubectl,
  context,
  descriptors,
  { requireInitialBoundary = false } = {}
) {
  const sessions = descriptors.map(descriptor =>
    spawnPodWatchSession(kubectl, context, descriptor, { requireInitialBoundary })
  );
  const group = { sessions };
  const started = await Promise.allSettled(sessions.map(session => session.spawned));
  const failed = started.find(result => result.status === "rejected");
  if (failed) throw failed.reason;
  assertPodWatchGroupHealthy(group);
  return group;
}

async function waitForPodWatchHandshake(predecessor, successor, context) {
  const deadline = Date.now() + (localFixtureMode(context)
    ? LOCAL_FIXTURE_HANDSHAKE_DEADLINE_MS
    : POD_WATCH_HANDSHAKE_DEADLINE_MS);
  while (!successor.sessions.every(session => session.initial.complete)) {
    if (predecessor) assertPodWatchGroupHealthy(predecessor);
    assertPodWatchGroupHealthy(successor);
    if (Date.now() >= deadline) fail("pod_watch_initial_boundary_timeout");
    await delay(Math.min(20, deadline - Date.now()));
  }
  if (predecessor) assertPodWatchGroupHealthy(predecessor);
  assertPodWatchGroupHealthy(successor);
}

async function closePodWatchGroup(group, { requireClean = true } = {}) {
  if (!group) return;
  group.sessions.forEach(session => { session.intentionalClose = true; });
  const cleanup = await Promise.allSettled(group.sessions.map(session =>
    terminateChildProcessGroup(session.child, session.cleanupState)
  ));
  const closed = await Promise.race([
    Promise.all(group.sessions.map(session => session.closedPromise)).then(() => true),
    delay(CHILD_TERM_GRACE_MS * 2 + 250).then(() => false)
  ]);
  if (
    !closed ||
    cleanup.some(result => result.status === "rejected") ||
    group.sessions.some(session =>
      session.cleanupState.cleanupFailed || processGroupExists(session.child)
    )
  ) {
    fail("kubectl_cleanup");
  }
  group.sessions.forEach(session => activeChildren.delete(session.child.pid));
  if (requireClean) {
    for (const session of group.sessions) {
      if (session.error) throw session.error;
    }
  }
}

function namedControlWatchRawPath(collectionPath, name, resourceVersion) {
  if (!validResourceVersion(resourceVersion)) fail("control_resource_version");
  const query = new URLSearchParams({
    allowWatchBookmarks: "true",
    fieldSelector: `metadata.name=${name}`,
    resourceVersion,
    timeoutSeconds: String(WATCH_TIMEOUT_SECONDS),
    watch: "true"
  });
  return `${collectionPath}?${query.toString()}`;
}

function fixedMetadata(resource, descriptor) {
  const metadata = resource?.metadata;
  if (
    !object(metadata) || metadata.name !== descriptor.name ||
    metadata.uid !== descriptor.expected.uid ||
    metadata.resourceVersion !== descriptor.expected.resource_version ||
    metadata.deletionTimestamp !== undefined ||
    metadata.deletionGracePeriodSeconds !== undefined
  ) {
    fail(`control_${descriptor.key}_identity`);
  }
}

function validateControlNamespace(resource, descriptor) {
  fixedMetadata(resource, descriptor);
  if (
    resource?.apiVersion !== "v1" || resource?.kind !== "Namespace" ||
    resource.metadata.labels?.["kubernetes.io/metadata.name"] !== descriptor.name ||
    resource?.status?.phase !== "Active"
  ) {
    fail(`control_${descriptor.key}_contract`);
  }
}

function validateControlPolicy(resource, descriptor, namespace) {
  fixedMetadata(resource, descriptor);
  if (
    !admissionPolicyIsObserved(resource) ||
    !exactRecoveryOperationFencePolicy(resource, namespace) ||
    resource.metadata.generation !== descriptor.expected.generation ||
    sha256(canonicalJson(resource.spec)) !== descriptor.expected.spec_sha256
  ) {
    fail("control_recovery_policy_contract");
  }
}

function validateControlBinding(resource, descriptor, namespace) {
  fixedMetadata(resource, descriptor);
  if (
    !exactRecoveryOperationFenceBinding(resource, namespace, { active: true }) ||
    sha256(canonicalJson(resource.spec)) !== descriptor.expected.spec_sha256
  ) {
    fail("control_recovery_binding_contract");
  }
}

function validateControlOperationLock(resource, descriptor, controlBaseline) {
  fixedMetadata(resource, descriptor);
  const metadata = resource.metadata;
  if (
    resource?.apiVersion !== "v1" || resource?.kind !== "ConfigMap" ||
    metadata.namespace !== controlBaseline.namespace || resource.immutable !== true ||
    canonicalJson(metadata.labels || {}) !==
      canonicalJson({ "yenhubs.org/recovery-owner": controlBaseline.operation_owner }) ||
    metadata.annotations?.["yenhubs.org/operation-id"] !== controlBaseline.operation_id ||
    canonicalJson(resource.data || {}) !== "{}" ||
    canonicalJson(resource.binaryData || {}) !== "{}"
  ) {
    fail("control_operation_lock_contract");
  }
}

function validateControlLease(resource, descriptor, controlBaseline) {
  const metadata = resource?.metadata;
  const spec = resource?.spec;
  const renewTime = Date.parse(spec?.renewTime);
  const now = Date.now();
  if (
    resource?.apiVersion !== "coordination.k8s.io/v1" || resource?.kind !== "Lease" ||
    !object(metadata) || metadata.name !== descriptor.name ||
    metadata.namespace !== controlBaseline.namespace ||
    metadata.uid !== controlBaseline.lease.uid ||
    !validResourceVersion(metadata.resourceVersion) ||
    metadata.deletionTimestamp !== undefined ||
    canonicalJson(metadata.labels || {}) !== canonicalJson({
      [OPERATION_LEASE_LABEL]: OPERATION_LEASE_LABEL_VALUE
    }) ||
    (metadata.annotations !== undefined && canonicalJson(metadata.annotations) !== "{}") ||
    (metadata.finalizers !== undefined && canonicalJson(metadata.finalizers) !== "[]") ||
    (metadata.ownerReferences !== undefined && canonicalJson(metadata.ownerReferences) !== "[]") ||
    !exactKeys(spec, [
      "acquireTime", "holderIdentity", "leaseDurationSeconds", "leaseTransitions", "renewTime"
    ]) || spec.holderIdentity !== controlBaseline.lease.holder ||
    spec.acquireTime !== controlBaseline.lease.acquire_time ||
    spec.leaseTransitions !== controlBaseline.lease.lease_transitions ||
    spec.leaseDurationSeconds !== LEASE_DURATION_SECONDS || !Number.isFinite(renewTime) ||
    renewTime > now + 5_000 || now - renewTime > MUTATION_LEASE_MAX_AGE_MS
  ) {
    fail("control_operation_lease_contract");
  }
}

function controlDescriptors(controlBaseline) {
  const fence = controlBaseline.recovery_operation_fence;
  const parentNamespace = fence.namespaces.parent;
  const runnerNamespace = fence.namespaces.runner;
  return [
    {
      key: "parent_namespace",
      name: parentNamespace.name,
      expected: parentNamespace,
      getPath: `/api/v1/namespaces/${encodeURIComponent(parentNamespace.name)}`,
      collectionPath: "/api/v1/namespaces",
      mutable: false
    },
    {
      key: "runner_namespace",
      name: runnerNamespace.name,
      expected: runnerNamespace,
      getPath: `/api/v1/namespaces/${encodeURIComponent(runnerNamespace.name)}`,
      collectionPath: "/api/v1/namespaces",
      mutable: false
    },
    {
      key: "recovery_policy",
      name: RECOVERY_OPERATION_FENCE_POLICY_NAME,
      expected: fence.policy,
      getPath: "/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicies/" +
        encodeURIComponent(RECOVERY_OPERATION_FENCE_POLICY_NAME),
      collectionPath: "/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicies",
      mutable: false
    },
    {
      key: "recovery_binding",
      name: RECOVERY_OPERATION_FENCE_POLICY_NAME,
      expected: fence.binding,
      getPath: "/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicybindings/" +
        encodeURIComponent(RECOVERY_OPERATION_FENCE_POLICY_NAME),
      collectionPath: "/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicybindings",
      mutable: false
    },
    {
      key: "operation_lock",
      name: controlBaseline.operation_lock.name,
      expected: controlBaseline.operation_lock,
      getPath: `/api/v1/namespaces/${encodeURIComponent(controlBaseline.namespace)}/configmaps/` +
        encodeURIComponent(controlBaseline.operation_lock.name),
      collectionPath: `/api/v1/namespaces/${encodeURIComponent(controlBaseline.namespace)}/configmaps`,
      mutable: false
    },
    {
      key: "operation_lease",
      name: controlBaseline.lease.name,
      expected: controlBaseline.lease,
      getPath: "/apis/coordination.k8s.io/v1/namespaces/" +
        `${encodeURIComponent(controlBaseline.namespace)}/leases/` +
        encodeURIComponent(controlBaseline.lease.name),
      collectionPath: "/apis/coordination.k8s.io/v1/namespaces/" +
        `${encodeURIComponent(controlBaseline.namespace)}/leases`,
      mutable: true
    }
  ].map(descriptor => ({
    ...descriptor,
    cursor: descriptor.mutable ? null : descriptor.expected.resource_version,
    seenResourceVersions: new Set(),
    requiredResourceVersion: null
  }));
}

function validateControlResource(resource, descriptor, controlBaseline) {
  if (descriptor.key === "parent_namespace" || descriptor.key === "runner_namespace") {
    validateControlNamespace(resource, descriptor);
  } else if (descriptor.key === "recovery_policy") {
    validateControlPolicy(resource, descriptor, controlBaseline.namespace);
  } else if (descriptor.key === "recovery_binding") {
    validateControlBinding(resource, descriptor, controlBaseline.namespace);
  } else if (descriptor.key === "operation_lock") {
    validateControlOperationLock(resource, descriptor, controlBaseline);
  } else if (descriptor.key === "operation_lease") {
    validateControlLease(resource, descriptor, controlBaseline);
  } else {
    fail("control_descriptor");
  }
}

async function readControlResources(
  kubectl,
  context,
  state,
  { initialize = false, requireObserved = false, rememberTargets = false } = {}
) {
  const texts = await Promise.all(state.descriptors.map(descriptor =>
    kubectlCapture(kubectl, context, descriptor.getPath, MAX_CONTROL_OBJECT_BYTES)
  ));
  texts.forEach((text, index) => {
    const descriptor = state.descriptors[index];
    const resource = parseJson(text, `control_${descriptor.key}_json`);
    validateControlResource(resource, descriptor, state.baseline);
    if (initialize && descriptor.mutable) {
      descriptor.cursor = resource.metadata.resourceVersion;
      descriptor.seenResourceVersions.add(descriptor.cursor);
    } else if (descriptor.mutable) {
      const resourceVersion = resource.metadata.resourceVersion;
      if (rememberTargets) descriptor.requiredResourceVersion = resourceVersion;
      if (requireObserved && !descriptor.seenResourceVersions.has(resourceVersion)) {
        // A Lease renewal is the sole permitted control mutation. A terminal
        // GET may only attest an object version already consumed by this
        // monitor's causal watch; otherwise a holder flip-and-restore could
        // hide in the interval between the watch close and the GET.
        fail("control_operation_lease_unobserved_resource_version");
      }
    }
  });
  if (state.descriptors.some(descriptor => !validResourceVersion(descriptor.cursor))) {
    fail("control_cursor_initialization");
  }
}

function validateControlWatchStream(text, descriptor, controlBaseline) {
  let cursor = descriptor.cursor;
  const lines = text.split("\n").filter(line => line.trim() !== "");
  for (const line of lines) {
    const event = parseJson(line, `control_${descriptor.key}_watch_json`);
    if (!object(event) || typeof event.type !== "string" || !object(event.object)) {
      fail(`control_${descriptor.key}_watch_contract`);
    }
    if (event.type === "ERROR") {
      if (event.object?.code === 410) fail("control_watch_resource_version_expired");
      fail("control_watch_error_event");
    }
    const resourceVersion = event.object?.metadata?.resourceVersion;
    if (!validResourceVersion(resourceVersion)) {
      fail(`control_${descriptor.key}_watch_resource_version`);
    }
    if (event.type === "BOOKMARK") {
      cursor = resourceVersion;
      continue;
    }
    if (!descriptor.mutable || event.type !== "MODIFIED") {
      fail(`control_${descriptor.key}_changed`);
    }
    validateControlResource(event.object, descriptor, controlBaseline);
    if (descriptor.seenResourceVersions.has(resourceVersion)) {
      fail("control_operation_lease_resource_version_replay");
    }
    descriptor.seenResourceVersions.add(resourceVersion);
    cursor = resourceVersion;
  }
  return cursor;
}

async function captureControlWatches(kubectl, context, state) {
  const texts = await Promise.all(state.descriptors.map(descriptor =>
    kubectlCapture(
      kubectl,
      context,
      namedControlWatchRawPath(
        descriptor.collectionPath, descriptor.name, descriptor.cursor
      ),
      MAX_CONTROL_OBJECT_BYTES,
      { requireWatchWindow: true }
    )
  ));
  texts.forEach((text, index) => {
    const descriptor = state.descriptors[index];
    descriptor.cursor = validateControlWatchStream(text, descriptor, state.baseline);
    if (
      descriptor.mutable &&
      !descriptor.seenResourceVersions.has(descriptor.requiredResourceVersion)
    ) {
      fail("control_operation_lease_watch_gap");
    }
    descriptor.requiredResourceVersion = null;
  });
}

function normalizeParentPod(pod, namespace, { requireTypeMeta = false } = {}) {
  if (
    !object(pod) ||
    (requireTypeMeta
      ? (pod.apiVersion !== "v1" || pod.kind !== "Pod")
      : ((pod.apiVersion !== undefined && pod.apiVersion !== "v1") ||
        (pod.kind !== undefined && pod.kind !== "Pod"))) ||
    !object(pod.metadata) || pod.metadata.namespace !== namespace ||
    typeof pod.metadata.name !== "string" || !pod.metadata.name ||
    typeof pod.metadata.uid !== "string" || !pod.metadata.uid ||
    !validResourceVersion(pod.metadata.resourceVersion) ||
    (pod.metadata.labels !== undefined && !object(pod.metadata.labels)) ||
    !object(pod.spec) ||
    (pod.spec.serviceAccountName !== undefined &&
      typeof pod.spec.serviceAccountName !== "string")
  ) {
    fail("parent_pod_contract");
  }
  const labels = pod.metadata.labels || {};
  if (
    labels.app === "bot-runner" || labels.component === "bot-runner" ||
    labels["yenhubs.org/managed-by"] === "bot-orchestrator" ||
    pod.spec.serviceAccountName === "bot-orchestrator"
  ) {
    fail("legacy_parent_runner_present");
  }
  return pod;
}

function normalizeCompleteParentList(value, namespace) {
  if (
    !object(value) || value.apiVersion !== "v1" || value.kind !== "PodList" ||
    !object(value.metadata) || !validResourceVersion(value.metadata.resourceVersion) ||
    (Object.hasOwn(value.metadata, "continue") && value.metadata.continue !== "") ||
    (Object.hasOwn(value.metadata, "remainingItemCount") &&
      value.metadata.remainingItemCount !== 0) ||
    !Array.isArray(value.items)
  ) {
    fail("parent_list_contract");
  }
  const names = new Set();
  for (const pod of value.items) {
    normalizeParentPod(pod, namespace);
    if (names.has(pod.metadata.name)) fail("parent_list_contract");
    names.add(pod.metadata.name);
  }
  return value.metadata.resourceVersion;
}

function runnerListMatchesBaseline(value, namespace, baselineCanonical) {
  const inventory = durableInventoryFromPodList(value, namespace);
  if (inventory.canonical !== baselineCanonical) fail("durable_fence_inventory_changed");
  return inventory.resourceVersion;
}

function validateParentLiveEvent(event, namespace) {
  if (!object(event) || typeof event.type !== "string" || !object(event.object)) {
    fail("parent_watch_event_contract");
  }
  if (event.type === "ERROR") {
    if (event.object?.code === 410) fail("watch_resource_version_expired");
    fail("watch_error_event");
  }
  if (event.type === "BOOKMARK") {
    if (!validResourceVersion(event.object.metadata?.resourceVersion)) {
      fail("watch_bookmark_contract");
    }
    return;
  }
  if (!["ADDED", "MODIFIED", "DELETED"].includes(event.type)) {
    fail("parent_watch_event_type");
  }
  normalizeParentPod(event.object, namespace, { requireTypeMeta: true });
}

function podWatchStateFromLists(
  parentList,
  runnerList,
  namespace,
  runnerNamespace,
  baseline
) {
  const parentResourceVersion = normalizeCompleteParentList(parentList, namespace);
  const runnerResourceVersion = runnerListMatchesBaseline(
    runnerList, runnerNamespace, baseline.canonical
  );
  return {
    descriptors: [
      {
        key: "parent",
        namespace,
        cursor: parentResourceVersion,
        baseline,
        evidence: null
      },
      {
        key: "runner",
        namespace: runnerNamespace,
        cursor: runnerResourceVersion,
        baseline,
        evidence: new DurableRunnerWatchEvidence(
          runnerNamespace, runnerResourceVersion, baseline.fences
        )
      }
    ]
  };
}

async function initializePodWatchState(
  kubectl,
  context,
  namespace,
  runnerNamespace,
  baseline
) {
  const [parentListText, runnerListText] = await Promise.all([
    kubectlCapture(kubectl, context, podListRawPath(namespace), MAX_LIST_BYTES),
    kubectlCapture(kubectl, context, podListRawPath(runnerNamespace), MAX_LIST_BYTES)
  ]);
  const state = podWatchStateFromLists(
    parseJson(parentListText, "parent_list_json"),
    parseJson(runnerListText, "durable_runner_list_json"),
    namespace,
    runnerNamespace,
    baseline
  );
  state.namespace = namespace;
  state.runnerNamespace = runnerNamespace;
  state.baseline = baseline;
  state.current = await startPodWatchGroup(
    kubectl, context, state.descriptors, { requireInitialBoundary: true }
  );
  await waitForPodWatchHandshake(null, state.current, context);
  return state;
}

function validatePodWatchStream(text, descriptor) {
  let cursor = descriptor.cursor;
  const lines = text.split("\n").filter(line => line.trim() !== "");
  for (const line of lines) {
    const event = parseJson(line, "watch_event_json");
    if (descriptor.key === "runner") {
      descriptor.evidence.ingest(event);
      if (descriptor.evidence.error) fail(descriptor.evidence.error);
      if (descriptor.evidence.violation) fail("durable_runner_watch_violation");
      cursor = descriptor.evidence.lastResourceVersion;
    } else {
      validateParentLiveEvent(event, descriptor.namespace);
      cursor = event.object.metadata.resourceVersion;
    }
  }
  if (!validResourceVersion(cursor)) fail("pod_watch_cursor");
  return cursor;
}

async function handoffPodWatchState(kubectl, context, state) {
  assertPodWatchGroupHealthy(state.current);
  const [parentListText, runnerListText] = await Promise.all([
    kubectlCapture(kubectl, context, podListRawPath(state.namespace), MAX_LIST_BYTES),
    kubectlCapture(kubectl, context, podListRawPath(state.runnerNamespace), MAX_LIST_BYTES)
  ]);
  assertPodWatchGroupHealthy(state.current);
  const successorState = podWatchStateFromLists(
    parseJson(parentListText, "parent_terminal_list_json"),
    parseJson(runnerListText, "durable_runner_terminal_list_json"),
    state.namespace,
    state.runnerNamespace,
    state.baseline
  );
  const successor = await startPodWatchGroup(
    kubectl, context, successorState.descriptors, { requireInitialBoundary: true }
  );
  await waitForPodWatchHandshake(state.current, successor, context);
  await closePodWatchGroup(state.current);
  assertPodWatchGroupHealthy(successor);
  state.descriptors = successorState.descriptors;
  state.current = successor;
}

async function captureControlRound(kubectl, context, controlState) {
  await readControlResources(kubectl, context, controlState, {
    rememberTargets: true
  });
  await captureControlWatches(kubectl, context, controlState);
  await readControlResources(kubectl, context, controlState, {
    requireObserved: true
  });
}

async function captureRound(kubectl, context, podState, controlState) {
  const results = await Promise.allSettled([
    handoffPodWatchState(kubectl, context, podState),
    captureControlRound(kubectl, context, controlState)
  ]);
  const failed = results.find(result => result.status === "rejected");
  if (failed) throw failed.reason;
  assertPodWatchGroupHealthy(podState.current);
}

function stopRequest(stopPath, expectedIdentity) {
  const value = readMarker(stopPath, expectedIdentity);
  if (value === "") return null;
  if (value === "discard\n") return "discard";
  if (value === "stop\n") return "stop";
  fail("stop_contract");
}

function validateBaselineCapability(values, baselineIdentity, baseline) {
  exactNamedIdentity(values.get("--baseline"), baselineIdentity);
  const current = readDurableFenceBaseline(
    values.get("--baseline"), values.get("--baseline-sha256")
  );
  exactNamedIdentity(values.get("--baseline"), baselineIdentity);
  if (current.canonical !== baseline.canonical) {
    fail("durable_fence_baseline_changed");
  }
}

function validateControlBaselineCapability(values, capability) {
  const current = readControlBaselineCapability(values, capability.identity);
  if (current.canonical !== capability.canonical) {
    fail("control_baseline_changed");
  }
}

function monitorCapabilitySha256(values, durableBaseline, controlCapability) {
  const fence = controlCapability.baseline.recovery_operation_fence;
  return sha256(canonicalJson({
    schema_version: 1,
    context: values.get("--context"),
    parent_namespace: fence.namespaces.parent,
    runner_namespace: fence.namespaces.runner,
    operation_id: controlCapability.baseline.operation_id,
    operation_owner: controlCapability.baseline.operation_owner,
    operation_lock: controlCapability.baseline.operation_lock,
    lease: controlCapability.baseline.lease,
    policy: fence.policy,
    binding: fence.binding,
    durable_fence_baseline_sha256: durableBaseline.sha256,
    control_baseline_sha256: controlCapability.sha256
  }));
}

function validateMonitorAuthority(
  values, durableBaseline, controlCapability, controlCapabilitySha256
) {
  const authoritySource = readPinnedFile(values.get("--authority"), 64 * 1024).value;
  const authority = parseJson(authoritySource, "monitor_authority_json");
  const control = controlCapability.baseline;
  const expected = {
    schema_version: 1,
    kind: "durable-runner-quiescence-monitor",
    pid: process.pid,
    start_identity: authority?.start_identity,
    context: values.get("--context"),
    namespace: values.get("--namespace"),
    namespace_uid: control.namespace_uid,
    operation_id: control.operation_id,
    operation_owner: control.operation_owner,
    runtime_generation: "durable-v2",
    operation_lock: control.operation_lock,
    lease: {
      name: control.lease.name,
      uid: control.lease.uid,
      holder: control.lease.holder
    },
    paths: {
      authority: values.get("--authority"),
      durable_baseline: values.get("--baseline"),
      control_baseline: values.get("--control-baseline"),
      stop: values.get("--stop"),
      failure: values.get("--failure"),
      ready: values.get("--ready"),
      progress: values.get("--progress"),
      final: values.get("--final")
    },
    hashes: {
      durable_baseline_sha256: values.get("--baseline-sha256"),
      control_baseline_sha256: values.get("--control-baseline-sha256"),
      control_capability_sha256: controlCapabilitySha256
    }
  };
  if (
    !object(authority) || !Number.isSafeInteger(authority.pid) ||
    authority.pid !== process.pid || typeof authority.start_identity !== "string" ||
    authority.start_identity.length < 1 || authority.start_identity.length > 512 ||
    authoritySource !== `${canonicalJson(expected)}\n`
  ) fail("monitor_authority");
  return sha256(authoritySource);
}

function validateMarkerIdentities(values, markerIdentities) {
  for (const key of ["--stop", "--failure", "--ready", "--progress", "--final"]) {
    exactNamedIdentity(values.get(key), markerIdentities.get(key));
  }
}

async function monitor(values) {
  const markerIdentities = new Map();
  for (const key of ["--stop", "--failure", "--ready", "--progress", "--final"]) {
    const opened = openMarker(values.get(key), fs.constants.O_RDONLY);
    const initial = fs.readFileSync(opened.descriptor, "utf8");
    fs.closeSync(opened.descriptor);
    if (initial !== "") fail("marker_initial_state");
    markerIdentities.set(key, opened.identity);
  }
  cliFailureIdentity = markerIdentities.get("--failure");
  const baselineIdentity = fs.lstatSync(values.get("--baseline"), { bigint: true });
  exactNamedIdentity(values.get("--baseline"), baselineIdentity);
  const baseline = readDurableFenceBaseline(
    values.get("--baseline"), values.get("--baseline-sha256")
  );
  exactNamedIdentity(values.get("--baseline"), baselineIdentity);
  const controlCapability = readControlBaselineCapability(values);
  const controlState = {
    baseline: controlCapability.baseline,
    descriptors: controlDescriptors(controlCapability.baseline)
  };
  const capabilitySha256 = monitorCapabilitySha256(values, baseline, controlCapability);
  const authoritySha256 = validateMonitorAuthority(
    values, baseline, controlCapability, capabilitySha256
  );
  const kubectl = process.env.KUBECTL_BIN || "kubectl";
  const initialization = await Promise.allSettled([
    initializePodWatchState(
      kubectl,
      values.get("--context"),
      values.get("--namespace"),
      values.get("--runner-namespace"),
      baseline
    ),
    readControlResources(kubectl, values.get("--context"), controlState, {
      initialize: true
    })
  ]);
  const initializationFailure = initialization.find(result =>
    result.status === "rejected"
  );
  if (initializationFailure) throw initializationFailure.reason;
  const podState = initialization[0].value;
  const positiveMarker = [
    baseline.sha256,
    controlCapability.sha256,
    capabilitySha256,
    authoritySha256
  ].join(":");
  let rounds = 0;
  while (true) {
    if (validateMonitorAuthority(
      values, baseline, controlCapability, capabilitySha256
    ) !== authoritySha256) fail("monitor_authority_changed");
    validateBaselineCapability(values, baselineIdentity, baseline);
    validateControlBaselineCapability(values, controlCapability);
    validateMarkerIdentities(values, markerIdentities);
    await captureRound(kubectl, values.get("--context"), podState, controlState);
    // The async Kubernetes round is the widest local race window. Re-pin both
    // capabilities after it before publishing any positive marker.
    validateBaselineCapability(values, baselineIdentity, baseline);
    validateControlBaselineCapability(values, controlCapability);
    validateMarkerIdentities(values, markerIdentities);
    if (validateMonitorAuthority(
      values, baseline, controlCapability, capabilitySha256
    ) !== authoritySha256) fail("monitor_authority_changed");
    assertPodWatchGroupHealthy(podState.current);
    rounds += 1;
    markerIdentities.set("--progress", writeProgress(
      values.get("--progress"), rounds, authoritySha256,
      markerIdentities.get("--progress")
    ));
    if (rounds === 1) {
      writeMarker(
        values.get("--ready"), `ready:${positiveMarker}\n`,
        markerIdentities.get("--ready")
      );
    }
    const requested = stopRequest(values.get("--stop"), markerIdentities.get("--stop"));
    if (requested === "discard") {
      await closePodWatchGroup(podState.current, { requireClean: false });
      podState.current = null;
      return;
    }
    if (requested === "stop") {
      // Drain both retained Pod Watches and parse their terminal buffers before
      // opening the final causal control frontier. FINAL is impossible while a
      // Pod process group remains alive or an event/ERROR arrived during drain.
      assertPodWatchGroupHealthy(podState.current);
      await closePodWatchGroup(podState.current, { requireClean: true });
      podState.current = null;
      await captureControlRound(kubectl, values.get("--context"), controlState);
      validateBaselineCapability(values, baselineIdentity, baseline);
      validateControlBaselineCapability(values, controlCapability);
      validateMarkerIdentities(values, markerIdentities);
      if (validateMonitorAuthority(
        values, baseline, controlCapability, capabilitySha256
      ) !== authoritySha256) fail("monitor_authority_changed");
      writeMarker(
        values.get("--final"), `complete:${positiveMarker}\n`,
        markerIdentities.get("--final")
      );
      return;
    }
  }
}

async function cleanupChildren() {
  let failed = false;
  const children = [...activeChildren.values()];
  const closed = children.map(child => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
    } else {
      child.once("close", resolve);
    }
  }));
  const cleanups = children.map(child => terminateChildProcessGroup(
    child,
    child.yenhubsCleanupState || { cleanupFailed: false, cleanupPromise: null }
  ));
  const cleanupResults = await Promise.allSettled(cleanups);
  if (cleanupResults.some(result => result.status === "rejected")) failed = true;
  await Promise.race([
    Promise.allSettled(closed),
    new Promise(resolve => setTimeout(resolve, CHILD_TERM_GRACE_MS))
  ]);
  if (children.some(child =>
    child.exitCode === null && child.signalCode === null || processGroupExists(child)
  )) {
    failed = true;
  }
  for (const child of children) {
    if (!processGroupExists(child)) activeChildren.delete(child.pid);
  }
  if (failed) fail("kubectl_cleanup");
}

let cliValues = null;
let cliFailureIdentity = null;
let signalHandling = false;

async function handleSignal(status) {
  if (signalHandling) return;
  signalHandling = true;
  try { await cleanupChildren(); } catch {}
  if (cliValues && cliFailureIdentity) {
    try {
      writeMarker(
        cliValues.get("--failure"), "durable_runner_monitor_failed\n",
        cliFailureIdentity
      );
    } catch {}
  }
  process.exit(status);
}

async function runCli() {
  let parsed;
  try {
    parsed = exactArguments(process.argv.slice(2));
    cliValues = parsed;
    await monitor(parsed);
  } catch (error) {
    try { await cleanupChildren(); } catch {}
    if (process.env.YENHUBS_WATCH_TEST_DEBUG === "1") {
      process.stderr.write(`durable_runner_monitor_error:${String(error?.code || "failed")}\n`);
    }
    if (parsed && cliFailureIdentity) {
      try {
        writeMarker(
          parsed.get("--failure"), "durable_runner_monitor_failed\n",
          cliFailureIdentity
        );
      } catch {}
    }
    process.exitCode = 1;
  }
}

export {
  captureRound,
  normalizeCompleteParentList,
  podInitialWatchRawPath,
  podWatchRawPath,
  podWatchStateFromLists,
  validatePodWatchStream
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.on("SIGHUP", () => { void handleSignal(129); });
  process.on("SIGINT", () => { void handleSignal(130); });
  process.on("SIGQUIT", () => { void handleSignal(131); });
  process.on("SIGTERM", () => { void handleSignal(143); });
  await runCli();
}

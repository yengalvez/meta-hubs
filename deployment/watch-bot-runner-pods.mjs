#!/usr/bin/env node

// Watches the complete Pod event stream during destructive recovery windows.
// It emits no Kubernetes payloads and records only a fixed failure code.

import fs from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";

const MAX_LIST_BYTES = 8 * 1024 * 1024;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const WATCH_TIMEOUT_SECONDS = 2;
const FINAL_STABLE_SECONDS = 61;
const FINAL_WATCH_TIMEOUT_SECONDS = 65;
const activeChildren = new Set();

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function exactArguments(argv) {
  if (argv.length !== 12) fail("arguments");
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      ![
        "--context", "--namespace", "--runner-namespace", "--stop", "--failure", "--ready"
      ].includes(key) ||
      !value || values.has(key)
    ) fail("arguments");
    values.set(key, value);
  }
  if (values.size !== 6) fail("arguments");
  if (!/^[A-Za-z0-9_.:@/-]{1,253}$/.test(values.get("--context"))) fail("context");
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(values.get("--namespace"))) fail("namespace");
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(values.get("--runner-namespace"))) {
    fail("runner_namespace");
  }
  for (const marker of ["--stop", "--failure", "--ready"]) {
    if (!path.isAbsolute(values.get(marker))) fail("marker_path");
  }
  return values;
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
      "get", "pod", "-n", namespace, "-o", "json"
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
  const namespaces = [...new Set([namespace, runnerNamespace])];
  let completedRounds = 0;
  if (readMarker(stopPath) !== "" || readMarker(failurePath) !== "" || readMarker(readyPath) !== "") {
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

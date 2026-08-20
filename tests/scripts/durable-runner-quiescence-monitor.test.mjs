import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { guardPodDocumentForIdentity } from "../../hubs-cloud/community-edition/services/bot-orchestrator/kubernetes-runner-manager.js";
import {
  normalizeCompleteParentList,
  podInitialWatchRawPath,
  podWatchRawPath,
  podWatchStateFromLists,
  validatePodWatchStream
} from "../../deployment/watch-durable-runner-quiescence.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const monitorPath = path.join(root, "deployment/watch-durable-runner-quiescence.mjs");
const runnerNamespace = "hcce-bot-runners";
const parentNamespace = "hcce";
const operationLeaseName = "yenhubs-operation-serialization";
const operationId = "a".repeat(32);
const operationLockName = "yenhubs-recovery-operation-lock";
const operationHolder = "root-recovery:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const parentNamespaceUid = "parent-namespace-uid";
const runnerNamespaceUid = "runner-namespace-uid";
const identity = {
  roomKey: "11111111111111111111",
  processGeneration: "11111111-1111-4111-8111-111111111111",
  name: "bot-runner-1111111111111111-11111111"
};

function fencePod(resourceVersion = "fence-rv-1") {
  return {
    ...guardPodDocumentForIdentity(identity, "fence", runnerNamespace),
    metadata: {
      ...guardPodDocumentForIdentity(identity, "fence", runnerNamespace).metadata,
      uid: "fence-uid-1",
      resourceVersion
    },
    status: { phase: "Pending" }
  };
}

function transientFencePod(resourceVersion = "transient-fence-rv-1") {
  const transientIdentity = {
    roomKey: "22222222222222222222",
    processGeneration: "22222222-2222-4222-8222-222222222222",
    name: "bot-runner-2222222222222222-22222222"
  };
  const pod = guardPodDocumentForIdentity(
    transientIdentity, "fence", runnerNamespace
  );
  return {
    ...pod,
    metadata: {
      ...pod.metadata,
      uid: "transient-fence-uid-1",
      resourceVersion
    },
    status: { phase: "Pending" }
  };
}

function parentPod(resourceVersion = "parent-rv-1") {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "hubs-safe-pod",
      namespace: parentNamespace,
      uid: "parent-uid-1",
      resourceVersion,
      labels: { app: "hubs" }
    },
    spec: { serviceAccountName: "default", containers: [{ name: "hubs" }] }
  };
}

const baselineRecord = {
  name: identity.name,
  uid: "fence-uid-1",
  room_key: identity.roomKey,
  process_generation: identity.processGeneration,
  state: "fenced"
};
const baseline = {
  canonical: JSON.stringify([baselineRecord]),
  fences: [baselineRecord],
  sha256: ""
};
baseline.sha256 = crypto.createHash("sha256").update(baseline.canonical).digest("hex");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function microsecondTimestamp(time = Date.now()) {
  return new Date(time).toISOString().replace(/(\.\d{3})Z$/u, "$1000Z");
}

function namespaceResource(name, uid, resourceVersion) {
  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name,
      uid,
      resourceVersion,
      labels: { "kubernetes.io/metadata.name": name }
    },
    status: { phase: "Active" }
  };
}

function controlFixture(
  context = "fixture-context",
  mutateBaseline = null,
  operationOwner = "checkpoint-backup"
) {
  const policy = JSON.parse(fs.readFileSync(path.join(
    root, "tests/recovery/fixtures/recovery-operation-pod-fence-policy.json"
  ), "utf8"));
  const parentWriterVariable = policy.spec.variables.find(variable =>
    variable.name === "isParentWriterCreate"
  );
  if (!parentWriterVariable) throw new Error("fixture_policy_parent_writer_variable_missing");
  if (!parentWriterVariable.expression.includes("!has(request.subResource)")) {
    parentWriterVariable.expression = parentWriterVariable.expression.replace(
      "request.subResource == ''",
      "(!has(request.subResource) || request.subResource == '')"
    );
  }
  const binding = JSON.parse(fs.readFileSync(path.join(
    root, "tests/recovery/fixtures/recovery-operation-pod-fence-binding.json"
  ), "utf8"));
  const acquireTime = microsecondTimestamp(Date.now() - 5_000);
  const parent = namespaceResource(parentNamespace, parentNamespaceUid, "parent-namespace-rv-1");
  const runner = namespaceResource(runnerNamespace, runnerNamespaceUid, "runner-namespace-rv-1");
  const operationLock = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: operationLockName,
      namespace: parentNamespace,
      uid: "operation-lock-uid",
      resourceVersion: "operation-lock-rv-1",
      labels: { "yenhubs.org/recovery-owner": operationOwner },
      annotations: { "yenhubs.org/operation-id": operationId }
    },
    immutable: true
  };
  const lease = {
    apiVersion: "coordination.k8s.io/v1",
    kind: "Lease",
    metadata: {
      name: operationLeaseName,
      namespace: parentNamespace,
      uid: "operation-lease-uid",
      resourceVersion: "operation-lease-rv-1",
      labels: { "yenhubs.org/operation-serialization": "deployment-recovery" }
    },
    spec: {
      acquireTime,
      holderIdentity: operationHolder,
      leaseDurationSeconds: 120,
      leaseTransitions: 0,
      renewTime: microsecondTimestamp()
    }
  };
  const controlBaseline = {
    schema_version: 3,
    runtime_generation: "durable-v2",
    recovery_operation_fence: {
      namespaces: {
        parent: {
          name: parentNamespace,
          uid: parentNamespaceUid,
          resource_version: parent.metadata.resourceVersion,
          phase: "Active",
          metadata_name_label: parentNamespace
        },
        runner: {
          name: runnerNamespace,
          uid: runnerNamespaceUid,
          resource_version: runner.metadata.resourceVersion,
          phase: "Active",
          metadata_name_label: runnerNamespace
        }
      },
      policy: {
        uid: policy.metadata.uid,
        resource_version: policy.metadata.resourceVersion,
        generation: policy.metadata.generation,
        spec_sha256: digest(canonicalJson(policy.spec))
      },
      binding: {
        uid: binding.metadata.uid,
        resource_version: binding.metadata.resourceVersion,
        spec_sha256: digest(canonicalJson(binding.spec))
      }
    },
    operation_id: operationId,
    operation_owner: operationOwner,
    operation_lock: {
      name: operationLockName,
      uid: operationLock.metadata.uid,
      resource_version: operationLock.metadata.resourceVersion
    },
    context,
    namespace: parentNamespace,
    namespace_uid: parentNamespaceUid,
    lease: {
      name: operationLeaseName,
      uid: lease.metadata.uid,
      holder: operationHolder,
      acquire_time: acquireTime,
      lease_transitions: 0
    },
    storage_helper: {},
    consumers: [],
    deployments: [],
    replica_sets: [],
    pods: [],
    boundaries: {}
  };
  if (mutateBaseline) mutateBaseline(controlBaseline);
  const text = `${JSON.stringify(controlBaseline)}\n`;
  return {
    baseline: controlBaseline,
    text,
    sha256: digest(text),
    resources: { parent, runner, policy, binding, operationLock, lease }
  };
}

function monitorCapabilityDigest(control) {
  const fence = control.baseline.recovery_operation_fence;
  return digest(canonicalJson({
    schema_version: 1,
    context: control.baseline.context,
    parent_namespace: fence.namespaces.parent,
    runner_namespace: fence.namespaces.runner,
    operation_id: control.baseline.operation_id,
    operation_owner: control.baseline.operation_owner,
    operation_lock: control.baseline.operation_lock,
    lease: control.baseline.lease,
    policy: fence.policy,
    binding: fence.binding,
    durable_fence_baseline_sha256: baseline.sha256,
    control_baseline_sha256: control.sha256
  }));
}

function event(type, object) {
  return `${JSON.stringify({ type, object })}\n`;
}

function boundary(resourceVersion) {
  return {
    apiVersion: "meta.k8s.io/v1",
    kind: "PartialObjectMetadata",
    metadata: { resourceVersion }
  };
}

function podList(namespace, resourceVersion, items) {
  return {
    apiVersion: "v1",
    kind: "PodList",
    metadata: { resourceVersion },
    items: items.map(item => ({
      ...item,
      metadata: { ...item.metadata, namespace }
    }))
  };
}

function freshPodState() {
  return podWatchStateFromLists(
    podList(parentNamespace, "parent-list-rv", [parentPod()]),
    podList(runnerNamespace, "runner-list-rv", [fencePod()]),
    parentNamespace,
    runnerNamespace,
    baseline
  );
}

function freshPodDescriptor(key) {
  return freshPodState().descriptors.find(descriptor => descriptor.key === key);
}

test("classic Pod Watch query carries only the retained exact cursor", () => {
  const rawPath = podWatchRawPath(runnerNamespace, "opaque/rv:1");
  const parsed = new URL(`https://fixture.invalid${rawPath}`);
  assert.equal(parsed.pathname, "/api/v1/namespaces/hcce-bot-runners/pods");
  assert.equal(parsed.searchParams.get("watch"), "true");
  assert.equal(parsed.searchParams.get("allowWatchBookmarks"), "true");
  assert.equal(parsed.searchParams.has("sendInitialEvents"), false);
  assert.equal(parsed.searchParams.has("resourceVersionMatch"), false);
  assert.equal(parsed.searchParams.get("resourceVersion"), "opaque/rv:1");
  assert.equal(parsed.searchParams.get("timeoutSeconds"), "30");
});

test("successor Pod streaming-list query requires an exact initial-events boundary", () => {
  const rawPath = podInitialWatchRawPath(runnerNamespace, "opaque/rv:2");
  const parsed = new URL(`https://fixture.invalid${rawPath}`);
  assert.equal(parsed.pathname, "/api/v1/namespaces/hcce-bot-runners/pods");
  assert.equal(parsed.searchParams.get("watch"), "true");
  assert.equal(parsed.searchParams.get("allowWatchBookmarks"), "true");
  assert.equal(parsed.searchParams.get("sendInitialEvents"), "true");
  assert.equal(parsed.searchParams.get("resourceVersionMatch"), "NotOlderThan");
  assert.equal(parsed.searchParams.get("resourceVersion"), "opaque/rv:2");
  assert.equal(parsed.searchParams.get("timeoutSeconds"), "30");
});

test("complete raw parent lists may omit item TypeMeta but reject legacy runners", () => {
  const safe = parentPod();
  delete safe.apiVersion;
  delete safe.kind;
  assert.equal(normalizeCompleteParentList({
    apiVersion: "v1",
    kind: "PodList",
    metadata: { resourceVersion: "parent/list:1" },
    items: [safe]
  }, parentNamespace), "parent/list:1");
  const legacy = parentPod();
  legacy.spec.serviceAccountName = "bot-orchestrator";
  assert.throws(() => normalizeCompleteParentList({
    apiVersion: "v1",
    kind: "PodList",
    metadata: { resourceVersion: "parent/list:2" },
    items: [legacy]
  }, parentNamespace), /legacy_parent_runner_present/);
  for (const metadata of [
    { resourceVersion: "parent/list:3", continue: "next-page" },
    { resourceVersion: "parent/list:4", remainingItemCount: 1 }
  ]) {
    assert.throws(() => normalizeCompleteParentList({
      apiVersion: "v1",
      kind: "PodList",
      metadata,
      items: [parentPod()]
    }, parentNamespace), /parent_list_contract/);
  }
});

test("runner classic Watch retains its cursor across status-only modification", () => {
  const descriptor = freshPodDescriptor("runner");
  const modified = fencePod("fence/status:2");
  modified.status = { phase: "Pending", conditions: [{ type: "PodScheduled", status: "False" }] };
  descriptor.cursor = validatePodWatchStream(event("MODIFIED", modified), descriptor);
  assert.equal(descriptor.cursor, "fence/status:2");
  descriptor.cursor = validatePodWatchStream(
    event("BOOKMARK", boundary("runner/boundary:1")), descriptor
  );
  assert.equal(descriptor.cursor, "runner/boundary:1");
});

test("runner classic Watch rejects transient creation, deletion and identity drift", () => {
  assert.throws(() => validatePodWatchStream(
    event("ADDED", fencePod("fence/new:2")), freshPodDescriptor("runner")
  ), /durable_runner_watch_violation/);
  assert.throws(() => validatePodWatchStream(
    event("DELETED", fencePod("fence/deleted:2")), freshPodDescriptor("runner")
  ), /durable_runner_watch_violation/);
  const drifted = fencePod("fence/drift:2");
  drifted.metadata.uid = "replacement-fence-uid";
  assert.throws(() => validatePodWatchStream(
    event("MODIFIED", drifted), freshPodDescriptor("runner")
  ), /durable_runner_watch_violation/);
});

test("classic Watch preserves an idle cursor and rejects 410 or a legacy parent event", () => {
  const idle = freshPodDescriptor("runner");
  assert.equal(validatePodWatchStream("", idle), "runner-list-rv");
  assert.throws(() => validatePodWatchStream(event("ERROR", {
    apiVersion: "v1", kind: "Status", code: 410, metadata: {}
  }), freshPodDescriptor("runner")), /durable_runner_watch_resource_version_expired/);
  const legacy = parentPod("legacy:2");
  legacy.metadata.labels = { app: "bot-runner" };
  assert.throws(() => validatePodWatchStream(
    event("ADDED", legacy), freshPodDescriptor("parent")
  ),
    /legacy_parent_runner_present/);
});

function privateFile(filePath, contents = "") {
  fs.writeFileSync(filePath, contents, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

async function waitFor(predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("fixture_timeout");
}

function runMonitorFixture(mode = "success", options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "yenhubs-durable-monitor."));
  fs.chmodSync(directory, 0o700);
  const context = options.context || "fixture-context";
  const control = controlFixture(
    options.controlContext || context,
    options.mutateControlBaseline || null,
    options.operationOwner ?? "checkpoint-backup"
  );
  const baselinePath = path.join(directory, "fences.json");
  const controlBaselinePath = path.join(directory, "writer-controls.json");
  const stopPath = path.join(directory, "stop");
  const failurePath = path.join(directory, "failure");
  const readyPath = path.join(directory, "ready");
  const progressPath = path.join(directory, "progress");
  const finalPath = path.join(directory, "final");
  const authorityPath = `${readyPath}.authority.json`;
  const descendantPath = path.join(directory, "descendant-pid");
  const leaseGetCountPath = path.join(directory, "lease-get-count");
  const parentListCountPath = path.join(directory, "parent-list-count");
  const runnerListCountPath = path.join(directory, "runner-list-count");
  const parentWatchCountPath = path.join(directory, "parent-watch-count");
  const runnerWatchCountPath = path.join(directory, "runner-watch-count");
  const watchPidPath = path.join(directory, "watch-pids");
  const controlWatchCountPrefix = path.join(directory, "control-watch-count");
  const podWatchLogPath = path.join(directory, "pod-watch-log");
  const watchGatePath = path.join(directory, "watch-gate");
  const watchReleasePath = path.join(directory, "watch-release");
  const kubectlPath = path.join(directory, "kubectl-fixture.mjs");
  privateFile(baselinePath, baseline.canonical);
  privateFile(controlBaselinePath, control.text);
  for (const marker of [stopPath, failurePath, readyPath, progressPath, finalPath]) {
    privateFile(marker);
  }
  fs.writeFileSync(kubectlPath, `#!/usr/bin/env node
import fs from "node:fs";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
const raw = args[args.indexOf("--raw") + 1] || "";
const context = args[args.indexOf("--context") + 1] || "";
const url = new URL(raw, "https://fixture.invalid");
const pathname = url.pathname;
const fence = JSON.parse(process.env.STUB_FENCE_JSON);
const parent = JSON.parse(process.env.STUB_PARENT_JSON);
const controls = JSON.parse(process.env.STUB_CONTROLS_JSON);
const renewedLease = JSON.parse(process.env.STUB_RENEWED_LEASE_JSON);
const transientRunner = JSON.parse(process.env.STUB_TRANSIENT_RUNNER_JSON);
const legacyParent = JSON.parse(process.env.STUB_LEGACY_PARENT_JSON);
const isWatch = url.searchParams.get("watch") === "true";
if (isWatch) fs.appendFileSync(process.env.STUB_WATCH_PID_PATH, String(process.pid) + "\\n");
const isPodCollection = /^\\/api\\/v1\\/namespaces\\/([^/]+)\\/pods$/u.exec(pathname);
const isRunner = isPodCollection && decodeURIComponent(isPodCollection[1]) === "hcce-bot-runners";
const podRv = isRunner ? "runner-list-rv" : "parent-list-rv";

function nextInvocation(counterPath, record = "call") {
  let count = 0;
  try {
    const text = fs.readFileSync(counterPath, "utf8").trim();
    count = text ? text.split("\\n").length : 0;
  } catch {}
  fs.appendFileSync(counterPath, record + "\\n");
  return count + 1;
}

function controlKey(name = "") {
  if (pathname === "/api/v1/namespaces") {
    if (name === "hcce") return "parent";
    if (name === "hcce-bot-runners") return "runner";
  }
  if (pathname === "/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicies") {
    return "policy";
  }
  if (pathname === "/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicybindings") {
    return "binding";
  }
  if (pathname === "/api/v1/namespaces/hcce/configmaps") return "operationLock";
  if (pathname === "/apis/coordination.k8s.io/v1/namespaces/hcce/leases") return "lease";
  const getPaths = {
    "/api/v1/namespaces/hcce": "parent",
    "/api/v1/namespaces/hcce-bot-runners": "runner",
    "/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicies/recovery-operation-pod-fence.yenhubs.org": "policy",
    "/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicybindings/recovery-operation-pod-fence.yenhubs.org": "binding",
    "/api/v1/namespaces/hcce/configmaps/yenhubs-recovery-operation-lock": "operationLock",
    "/apis/coordination.k8s.io/v1/namespaces/hcce/leases/yenhubs-operation-serialization": "lease"
  };
  return getPaths[pathname] || null;
}

function bookmark(resourceVersion, initial = false) {
  const metadata = { resourceVersion };
  if (initial) metadata.annotations = { "k8s.io/initial-events-end": "true" };
  return JSON.stringify({
    type: "BOOKMARK",
    object: {
      apiVersion: initial ? "v1" : "meta.k8s.io/v1",
      kind: initial ? "Pod" : "PartialObjectMetadata",
      metadata
    }
  }) + "\\n";
}

function gateOrHangWatch() {
  if (["hang-watch", "leader-exits-watch", "leader-spontaneous-watch"].includes(
    process.env.STUB_MODE
  )) {
    process.on("SIGTERM", () => {
      if (process.env.STUB_MODE === "leader-exits-watch") process.exit(0);
    });
    const descendant = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      { stdio: "ignore" }
    );
    fs.appendFileSync(process.env.STUB_DESCENDANT_PATH, String(descendant.pid) + "\\n");
    if (process.env.STUB_MODE === "leader-spontaneous-watch") process.exit(0);
    setInterval(() => {}, 1000);
    return true;
  }
  return false;
}

if (!isWatch && isPodCollection) {
  const listIndex = nextInvocation(
    isRunner ? process.env.STUB_RUNNER_LIST_COUNT_PATH : process.env.STUB_PARENT_LIST_COUNT_PATH
  );
  const metadata = {
    resourceVersion: process.env.STUB_MODE === "opaque-numeric-rv"
      ? "900"
      : podRv + "-" + String(listIndex)
  };
  if ((process.env.STUB_MODE === "partial-parent-list" && !isRunner) ||
      (process.env.STUB_MODE === "partial-runner-list" && isRunner)) {
    metadata.continue = "next-page";
    metadata.remainingItemCount = 1;
  }
  if (process.env.STUB_MODE === "truncated-list" && !isRunner) {
    process.stdout.write('{"apiVersion":"v1"');
  } else {
    process.stdout.write(JSON.stringify({apiVersion:"v1",kind:"PodList",metadata,items:[isRunner ? fence : parent]}));
  }
  process.exit(0);
}

if (!isWatch) {
  const key = controlKey();
  if (!key) process.exit(41);
  let resource = controls[key];
  if (key === "lease" && ["lease-renew", "lease-unobserved"].includes(process.env.STUB_MODE)) {
    let count = 0;
    try {
      const text = fs.readFileSync(process.env.STUB_LEASE_GET_COUNT_PATH, "utf8").trim();
      count = text ? text.split("\\n").length : 0;
    } catch {}
    fs.appendFileSync(process.env.STUB_LEASE_GET_COUNT_PATH, "get\\n");
    if (count >= 1) resource = renewedLease;
  }
  process.stdout.write(JSON.stringify(resource));
  process.exit(0);
}

if (gateOrHangWatch()) {
  await new Promise(() => {});
}
if (process.env.STUB_MODE === "gated-watch") {
  fs.appendFileSync(process.env.STUB_WATCH_GATE_PATH, "watch\\n");
  while (!fs.existsSync(process.env.STUB_WATCH_RELEASE_PATH)) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

if (isPodCollection) {
  const watchIndex = nextInvocation(
    isRunner ? process.env.STUB_RUNNER_WATCH_COUNT_PATH : process.env.STUB_PARENT_WATCH_COUNT_PATH,
    raw
  );
  fs.appendFileSync(
    process.env.STUB_POD_WATCH_LOG_PATH,
    "start " + (isRunner ? "runner" : "parent") + " " + String(watchIndex) +
      " " + raw + "\\n"
  );
  const isInitialStream = url.searchParams.get("sendInitialEvents") === "true";
  process.on("SIGTERM", () => {
    if (isRunner && watchIndex === 2 &&
        process.env.STUB_MODE === "runner-event-on-final-drain") {
      const created = JSON.parse(JSON.stringify(transientRunner));
      created.metadata.resourceVersion = "terminal-drain-transient-rv";
      fs.writeSync(1, JSON.stringify({ type: "ADDED", object: created }) + "\\n");
    }
    if (isRunner && watchIndex === 2 &&
        process.env.STUB_MODE === "runner-410-on-final-drain") {
      fs.writeSync(1, JSON.stringify({
        type: "ERROR",
        object: { apiVersion: "v1", kind: "Status", code: 410, metadata: {} }
      }) + "\\n");
    }
    fs.appendFileSync(
      process.env.STUB_POD_WATCH_LOG_PATH,
      "close " + (isRunner ? "runner" : "parent") + " " + String(watchIndex) + "\\n"
    );
    process.exit(0);
  });
  const initialHang = watchIndex === 1 && process.env.STUB_MODE === "initial-hang";
  if (isInitialStream && !initialHang) {
    const initialObject = JSON.parse(JSON.stringify(isRunner ? fence : parent));
    initialObject.metadata.resourceVersion = podRv + "-initial-object-" + String(watchIndex);
    if (isRunner && watchIndex === 2 && process.env.STUB_MODE === "successor-state-drift") {
      initialObject.metadata.uid = "successor-replacement-fence-uid";
    }
    process.stdout.write(JSON.stringify({ type: "ADDED", object: initialObject }) + "\\n");
    if (watchIndex === 2 && process.env.STUB_MODE === "successor-close") {
      process.exit(0);
    } else if (watchIndex === 2 && process.env.STUB_MODE === "successor-ordinary-bookmark") {
      process.stdout.write(bookmark(podRv + "-ordinary-" + String(watchIndex)));
    } else if (watchIndex === 2 && process.env.STUB_MODE === "successor-error") {
      process.stdout.write(JSON.stringify({
        type: "ERROR",
        object: { apiVersion: "v1", kind: "Status", code: 500, metadata: {} }
      }) + "\\n");
    } else if (watchIndex === 2 && process.env.STUB_MODE === "successor-410") {
      process.stdout.write(JSON.stringify({
        type: "ERROR",
        object: { apiVersion: "v1", kind: "Status", code: 410, metadata: {} }
      }) + "\\n");
    } else if (watchIndex === 2 && process.env.STUB_MODE === "successor-oversize") {
      process.stdout.write("x".repeat(8 * 1024 * 1024 + 1024));
    } else if (!(
      (watchIndex === 1 && process.env.STUB_MODE === "initial-no-boundary") ||
      (watchIndex === 2 && process.env.STUB_MODE === "successor-no-boundary")
    )) {
      process.stdout.write(bookmark(
        process.env.STUB_MODE === "opaque-numeric-rv"
          ? "1"
          : podRv + "-initial-end-" + String(watchIndex),
        true
      ));
      if (isRunner && watchIndex === 2 && [
        "runner-event-on-final-drain",
        "runner-410-on-final-drain",
        "terminal-binding-drift",
        "terminal-lock-drift",
        "terminal-lease-drift"
      ].includes(process.env.STUB_MODE)) {
        fs.writeFileSync(process.env.STUB_STOP_PATH, "stop\\n", { mode: 0o600 });
      }
    }
  }
  if (
    isRunner &&
    (
      (process.env.STUB_MODE === "runner-excursion-after-initial-list" && watchIndex === 1) ||
      (process.env.STUB_MODE === "runner-excursion-during-handoff" &&
        watchIndex === 2 && isInitialStream) ||
      (process.env.STUB_MODE === "runner-excursion-between-rounds" &&
        watchIndex === 3 && isInitialStream)
    )
  ) {
    const created = JSON.parse(JSON.stringify(transientRunner));
    created.metadata.resourceVersion = "transient-runner-create-rv";
    const deleted = JSON.parse(JSON.stringify(created));
    deleted.metadata.resourceVersion = "transient-runner-delete-rv";
    process.stdout.write(JSON.stringify({ type: "ADDED", object: created }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "DELETED", object: deleted }) + "\\n");
  } else if (
    !isRunner && process.env.STUB_MODE === "parent-excursion-between-rounds" &&
    watchIndex === 3 && isInitialStream
  ) {
    const created = JSON.parse(JSON.stringify(legacyParent));
    created.metadata.resourceVersion = "legacy-parent-create-rv";
    const deleted = JSON.parse(JSON.stringify(created));
    deleted.metadata.resourceVersion = "legacy-parent-delete-rv";
    process.stdout.write(JSON.stringify({ type: "ADDED", object: created }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "DELETED", object: deleted }) + "\\n");
  } else if (
    isRunner && process.env.STUB_MODE === "pod-watch-410" && watchIndex === 1
  ) {
    process.stdout.write(JSON.stringify({
      type: "ERROR",
      object: { apiVersion: "v1", kind: "Status", code: 410, metadata: {} }
    }) + "\\n");
  } else if (!isInitialStream) {
    process.stdout.write(bookmark(podRv + "-watch-rv-" + String(watchIndex)));
  }
  if (context === "fixture-context") {
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  process.exit(0);
}

const selectedName = (url.searchParams.get("fieldSelector") || "").replace("metadata.name=", "");
const key = controlKey(selectedName);
if (!key) process.exit(42);
const controlWatchIndex = nextInvocation(
  process.env.STUB_CONTROL_WATCH_COUNT_PREFIX + "-" + key
);
const terminalDriftKeys = {
  "terminal-binding-drift": "binding",
  "terminal-lock-drift": "operationLock",
  "terminal-lease-drift": "lease"
};
if (controlWatchIndex === 2 && terminalDriftKeys[process.env.STUB_MODE] === key) {
  const changed = JSON.parse(JSON.stringify(controls[key]));
  changed.metadata.resourceVersion = key + "-terminal-drift-rv";
  if (key === "lease") {
    changed.spec.holderIdentity = "root-recovery:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  } else {
    changed.metadata.annotations = { fixture: "terminal-drift" };
  }
  process.stdout.write(JSON.stringify({ type: "MODIFIED", object: changed }) + "\\n");
  process.exit(0);
}
if (process.env.STUB_MODE === "control-watch-410" && key === "binding") {
  process.stdout.write(JSON.stringify({
    type: "ERROR",
    object: { apiVersion: "v1", kind: "Status", code: 410, metadata: {} }
  }) + "\\n");
  process.exit(0);
}
if (process.env.STUB_MODE === "binding-transient" && key === "binding") {
  const dormant = JSON.parse(JSON.stringify(controls.binding));
  dormant.metadata.resourceVersion = "binding-rv-dormant";
  dormant.spec.matchResources.namespaceSelector = {
    matchExpressions: [{
      key: "kubernetes.io/metadata.name",
      operator: "DoesNotExist"
    }]
  };
  const active = JSON.parse(JSON.stringify(controls.binding));
  active.metadata.resourceVersion = "binding-rv-reactivated";
  process.stdout.write(JSON.stringify({ type: "MODIFIED", object: dormant }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "MODIFIED", object: active }) + "\\n");
  process.exit(0);
}
const fixedMutationKeys = {
  "parent-namespace-modified": "parent",
  "policy-modified": "policy",
  "operation-lock-modified": "operationLock"
};
if (fixedMutationKeys[process.env.STUB_MODE] === key) {
  const changed = JSON.parse(JSON.stringify(controls[key]));
  changed.metadata.resourceVersion = key + "-rv-modified";
  changed.metadata.annotations = { fixture: "changed" };
  process.stdout.write(JSON.stringify({ type: "MODIFIED", object: changed }) + "\\n");
  process.exit(0);
}
if (["lease-renew", "lease-holder-flip", "lease-stale-renew"].includes(process.env.STUB_MODE) &&
    key === "lease" && url.searchParams.get("resourceVersion") === controls.lease.metadata.resourceVersion) {
  const changed = JSON.parse(JSON.stringify(renewedLease));
  if (process.env.STUB_MODE === "lease-holder-flip") {
    changed.spec.holderIdentity = "root-recovery:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  }
  if (process.env.STUB_MODE === "lease-stale-renew") {
    changed.spec.renewTime = "2000-01-01T00:00:00.000000Z";
  }
  process.stdout.write(JSON.stringify({ type: "MODIFIED", object: changed }) + "\\n");
}
process.stdout.write(bookmark(key + "-bookmark-rv"));
`, { mode: 0o700 });
  fs.chmodSync(kubectlPath, 0o700);
  const monitorArguments = [monitorPath,
    "--context", context,
    "--namespace", parentNamespace,
    "--runner-namespace", runnerNamespace,
    "--baseline", baselinePath,
    "--baseline-sha256", baseline.sha256,
    "--control-baseline", controlBaselinePath,
    "--control-baseline-sha256", options.controlSha256 ?? control.sha256,
    "--stop", stopPath,
    "--failure", failurePath,
    "--ready", readyPath,
    "--progress", progressPath,
    "--final", finalPath,
    "--authority", authorityPath
  ];
  const child = spawn("/bin/sh", ["-c", `
authority_path=$1
shift
attempt=0
while [ ! -s "$authority_path" ]; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 500 ] || exit 91
  sleep 0.01
done
exec "$@"
`, "_", authorityPath, process.execPath, ...monitorArguments], {
    env: {
      ...process.env,
      KUBECTL_BIN: kubectlPath,
      YENHUBS_RECOVERY_TEST_MODE: "local-fixture",
      STUB_MODE: mode,
      STUB_STOP_PATH: stopPath,
      STUB_DESCENDANT_PATH: descendantPath,
      STUB_CONTROL_WATCH_COUNT_PREFIX: controlWatchCountPrefix,
      STUB_LEASE_GET_COUNT_PATH: leaseGetCountPath,
      STUB_PARENT_LIST_COUNT_PATH: parentListCountPath,
      STUB_RUNNER_LIST_COUNT_PATH: runnerListCountPath,
      STUB_PARENT_WATCH_COUNT_PATH: parentWatchCountPath,
      STUB_RUNNER_WATCH_COUNT_PATH: runnerWatchCountPath,
      STUB_WATCH_PID_PATH: watchPidPath,
      STUB_POD_WATCH_LOG_PATH: podWatchLogPath,
      STUB_WATCH_GATE_PATH: watchGatePath,
      STUB_WATCH_RELEASE_PATH: watchReleasePath,
      STUB_FENCE_JSON: JSON.stringify(fencePod()),
      STUB_PARENT_JSON: JSON.stringify(parentPod()),
      STUB_TRANSIENT_RUNNER_JSON: JSON.stringify(transientFencePod()),
      STUB_LEGACY_PARENT_JSON: JSON.stringify({
        ...parentPod("legacy-parent-rv"),
        metadata: {
          ...parentPod("legacy-parent-rv").metadata,
          name: "bot-runner-legacy-excursion",
          uid: "legacy-parent-excursion-uid",
          labels: { app: "bot-runner" }
        },
        spec: {
          ...parentPod("legacy-parent-rv").spec,
          serviceAccountName: "bot-orchestrator"
        }
      }),
      STUB_CONTROLS_JSON: JSON.stringify(control.resources),
      STUB_RENEWED_LEASE_JSON: JSON.stringify({
        ...control.resources.lease,
        metadata: {
          ...control.resources.lease.metadata,
          resourceVersion: "operation-lease-rv-2"
        },
        spec: {
          ...control.resources.lease.spec,
          renewTime: microsecondTimestamp()
        }
      })
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const authority = {
    schema_version: 1,
    kind: "durable-runner-quiescence-monitor",
    pid: child.pid,
    start_identity: `fixture-start:${child.pid}`,
    context,
    namespace: parentNamespace,
    namespace_uid: control.baseline.namespace_uid,
    operation_id: control.baseline.operation_id,
    operation_owner: control.baseline.operation_owner,
    runtime_generation: "durable-v2",
    operation_lock: control.baseline.operation_lock,
    lease: {
      name: control.baseline.lease.name,
      uid: control.baseline.lease.uid,
      holder: control.baseline.lease.holder
    },
    paths: {
      authority: authorityPath,
      durable_baseline: baselinePath,
      control_baseline: controlBaselinePath,
      stop: stopPath,
      failure: failurePath,
      ready: readyPath,
      progress: progressPath,
      final: finalPath
    },
    hashes: {
      durable_baseline_sha256: baseline.sha256,
      control_baseline_sha256: options.controlSha256 ?? control.sha256,
      control_capability_sha256: monitorCapabilityDigest(control)
    }
  };
  const authorityText = `${canonicalJson(authority)}\n`;
  privateFile(authorityPath, authorityText);
  const authoritySha256 = digest(authorityText);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => {
    stderr += chunk;
    if (process.env.YENHUBS_WATCH_TEST_DEBUG === "1") process.stderr.write(chunk);
  });
  const closed = new Promise(resolve => child.once("close", (code, signal) => {
    resolve({ code, signal, stdout, stderr });
  }));
  return {
    directory, baselinePath, controlBaselinePath, control, stopPath, failurePath,
    readyPath, progressPath, finalPath, authorityPath, authoritySha256,
    descendantPath, parentListCountPath,
    runnerListCountPath, parentWatchCountPath, runnerWatchCountPath,
    watchPidPath, podWatchLogPath, watchGatePath, watchReleasePath, child, closed
  };
}

function recordedFixtureProcessGroups(fixture) {
  if (!fs.existsSync(fixture.watchPidPath)) return [];
  return [...new Set(fs.readFileSync(fixture.watchPidPath, "utf8").trim()
    .split("\n").map(Number).filter(pid => Number.isSafeInteger(pid) && pid > 1))];
}

function fixtureProcessGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function signalFixtureProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!["EPERM", "ESRCH"].includes(error?.code)) throw error;
  }
}

async function cleanupFixture(fixture) {
  if (fixture.cleanupPromise) return fixture.cleanupPromise;
  fixture.cleanupPromise = (async () => {
    try { fixture.child.kill("SIGTERM"); } catch {}
    await Promise.race([
      fixture.closed,
      new Promise(resolve => setTimeout(resolve, 4_000))
    ]);
    if (fixture.child.exitCode === null && fixture.child.signalCode === null) {
      try { fixture.child.kill("SIGKILL"); } catch {}
    }
    await Promise.race([
      fixture.closed,
      new Promise(resolve => setTimeout(resolve, 1_000))
    ]);
    const processGroups = recordedFixtureProcessGroups(fixture);
    processGroups.forEach(pid => signalFixtureProcessGroup(pid, "SIGTERM"));
    const termDeadline = Date.now() + 750;
    while (processGroups.some(fixtureProcessGroupExists) && Date.now() < termDeadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    processGroups.filter(fixtureProcessGroupExists)
      .forEach(pid => signalFixtureProcessGroup(pid, "SIGKILL"));
    const killDeadline = Date.now() + 750;
    while (processGroups.some(fixtureProcessGroupExists) && Date.now() < killDeadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (fs.existsSync(fixture.descendantPath)) {
      for (const pid of fs.readFileSync(fixture.descendantPath, "utf8").trim()
        .split("\n").map(Number)) {
        if (!Number.isSafeInteger(pid) || pid <= 1) continue;
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
    }
    const cleanupFailed = processGroups.some(fixtureProcessGroupExists);
    fs.rmSync(fixture.directory, { recursive: true, force: true });
    if (cleanupFailed) throw new Error("fixture_process_group_cleanup");
    return processGroups;
  })();
  return fixture.cleanupPromise;
}

async function assertMonitorFailed(fixture) {
  const result = await fixture.closed;
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(fs.readFileSync(fixture.readyPath, "utf8"), "");
  assert.equal(fs.readFileSync(fixture.finalPath, "utf8"), "");
  assert.equal(fs.readFileSync(fixture.failurePath, "utf8"),
    "durable_runner_monitor_failed\n");
}

async function assertMonitorFailedAfterReady(fixture) {
  const result = await fixture.closed;
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.match(fs.readFileSync(fixture.readyPath, "utf8"), /^ready:/u);
  assert.equal(fs.readFileSync(fixture.finalPath, "utf8"), "");
  assert.equal(fs.readFileSync(fixture.failurePath, "utf8"),
    "durable_runner_monitor_failed\n");
}

test("CLI publishes ready/progress/final without API payloads and honors safe stop", async t => {
  const fixture = runMonitorFixture("success", { operationOwner: "checkpoint-restore" });
  t.after(() => cleanupFixture(fixture));
  const positiveCapability = [
    baseline.sha256,
    fixture.control.sha256,
    monitorCapabilityDigest(fixture.control),
    fixture.authoritySha256
  ].join(":");
  await waitFor(() => fs.readFileSync(fixture.readyPath, "utf8") ===
    `ready:${positiveCapability}\n`);
  fs.writeFileSync(fixture.stopPath, "stop\n", { mode: 0o600 });
  const result = await fixture.closed;
  assert.deepEqual({ code: result.code, signal: result.signal }, { code: 0, signal: null });
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(fs.readFileSync(fixture.failurePath, "utf8"), "");
  assert.match(fs.readFileSync(fixture.progressPath, "utf8"),
    /^[a-f0-9]{64}:[1-9][0-9]*\n$/u);
  assert.equal(fs.readFileSync(fixture.finalPath, "utf8"),
    `complete:${positiveCapability}\n`);
});

test("CLI fails closed when the retained Pod cursor expires with 410", async t => {
  const fixture = runMonitorFixture("pod-watch-410");
  t.after(() => cleanupFixture(fixture));
  const result = await fixture.closed;
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(fs.readFileSync(fixture.readyPath, "utf8"), "");
  assert.equal(fs.readFileSync(fixture.finalPath, "utf8"), "");
  assert.equal(fs.readFileSync(fixture.failurePath, "utf8"),
    "durable_runner_monitor_failed\n");
});

for (const mode of ["initial-hang", "initial-no-boundary"]) {
  test(`CLI requires an initial streaming-list boundary after the first LIST: ${mode}`, async t => {
    const fixture = runMonitorFixture(mode);
    t.after(() => cleanupFixture(fixture));
    await assertMonitorFailed(fixture);
  });
}

test("CLI treats numeric-shaped Kubernetes resourceVersions as opaque", async t => {
  const fixture = runMonitorFixture("opaque-numeric-rv");
  t.after(() => cleanupFixture(fixture));
  await waitFor(() => fs.readFileSync(fixture.readyPath, "utf8").startsWith("ready:"));
  const runnerStarts = fs.readFileSync(fixture.podWatchLogPath, "utf8").trim()
    .split("\n").filter(line => line.startsWith("start runner "));
  assert.ok(runnerStarts.length >= 2);
  for (const line of runnerStarts.slice(0, 2)) {
    const rawPath = line.split(" ", 4)[3];
    const url = new URL(`https://fixture.invalid${rawPath}`);
    assert.equal(url.searchParams.get("resourceVersion"), "900");
    assert.equal(url.searchParams.get("resourceVersionMatch"), "NotOlderThan");
    assert.equal(url.searchParams.get("sendInitialEvents"), "true");
  }
  fs.writeFileSync(fixture.stopPath, "stop\n", { mode: 0o600 });
  const result = await fixture.closed;
  assert.deepEqual({ code: result.code, signal: result.signal }, { code: 0, signal: null });
  assert.match(fs.readFileSync(fixture.finalPath, "utf8"), /^complete:/u);
  assert.equal(fs.readFileSync(fixture.failurePath, "utf8"), "");
});

for (const mode of [
  "successor-no-boundary",
  "successor-ordinary-bookmark",
  "successor-error",
  "successor-410",
  "successor-oversize",
  "successor-close",
  "successor-state-drift"
]) {
  test(`CLI rejects an invalid successor streaming-list handshake: ${mode}`, async t => {
    const fixture = runMonitorFixture(mode);
    t.after(() => cleanupFixture(fixture));
    await assertMonitorFailed(fixture);
  });
}

for (const mode of [
  "runner-event-on-final-drain",
  "runner-410-on-final-drain"
]) {
  test(`CLI drains Pod evidence before FINAL and rejects terminal data: ${mode}`, async t => {
    const fixture = runMonitorFixture(mode);
    t.after(() => cleanupFixture(fixture));
    await assertMonitorFailedAfterReady(fixture);
  });
}

for (const mode of [
  "terminal-binding-drift",
  "terminal-lock-drift",
  "terminal-lease-drift"
]) {
  test(`CLI requires a final causal control frontier after Pod drain: ${mode}`, async t => {
    const fixture = runMonitorFixture(mode);
    t.after(() => cleanupFixture(fixture));
    await assertMonitorFailedAfterReady(fixture);
  });
}

for (const mode of [
  "runner-excursion-after-initial-list",
  "runner-excursion-during-handoff"
]) {
  test(`CLI catches a create-delete excursion across a fresh-LIST handoff: ${mode}`, async t => {
    const fixture = runMonitorFixture(mode);
    t.after(() => cleanupFixture(fixture));
    await assertMonitorFailed(fixture);
  });
}

for (const mode of [
  "runner-excursion-between-rounds",
  "parent-excursion-between-rounds"
]) {
  test(`CLI catches a create-delete excursion between completed rounds: ${mode}`, async t => {
    const fixture = runMonitorFixture(mode);
    t.after(() => cleanupFixture(fixture));
    const result = await fixture.closed;
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.match(fs.readFileSync(fixture.readyPath, "utf8"), /^ready:/u);
    assert.equal(fs.readFileSync(fixture.finalPath, "utf8"), "");
    assert.equal(fs.readFileSync(fixture.failurePath, "utf8"),
      "durable_runner_monitor_failed\n");
  });
}

test("CLI sees an active-dormant-active binding transient from its retained cursor", async t => {
  const fixture = runMonitorFixture("binding-transient");
  t.after(() => cleanupFixture(fixture));
  await assertMonitorFailed(fixture);
});

for (const mode of [
  "parent-namespace-modified", "policy-modified", "operation-lock-modified"
]) {
  test(`CLI fails on immutable recovery control drift: ${mode}`, async t => {
    const fixture = runMonitorFixture(mode);
    t.after(() => cleanupFixture(fixture));
    await assertMonitorFailed(fixture);
  });
}

test("CLI fails closed when a retained control cursor expires with 410", async t => {
  const fixture = runMonitorFixture("control-watch-410");
  t.after(() => cleanupFixture(fixture));
  await assertMonitorFailed(fixture);
});

test("CLI accepts only causally observed Lease renewals and retains the next cursor", async t => {
  const fixture = runMonitorFixture("lease-renew");
  t.after(() => cleanupFixture(fixture));
  await waitFor(() => Number(
    fs.readFileSync(fixture.progressPath, "utf8").trim().split(":")[1]
  ) >= 2);
  const lifecycle = fs.readFileSync(fixture.podWatchLogPath, "utf8").trim().split("\n");
  for (const [successor, predecessor] of [[2, 1], [3, 2]]) {
    const successorStart = lifecycle.findIndex(line =>
      line.startsWith(`start runner ${successor} `)
    );
    const predecessorClose = lifecycle.indexOf(`close runner ${predecessor}`);
    assert.ok(successorStart >= 0 && predecessorClose > successorStart,
      `runner Watch ${successor} must start before predecessor ${predecessor} closes`);
  }
  const runnerStarts = lifecycle.filter(line => line.startsWith("start runner "));
  const runnerUrls = runnerStarts.slice(0, 3).map(line => {
    const rawPath = line.split(" ", 4)[3];
    return new URL(`https://fixture.invalid${rawPath}`);
  });
  assert.deepEqual(runnerUrls.map(url => url.searchParams.get("resourceVersion")),
    ["runner-list-rv-1", "runner-list-rv-2", "runner-list-rv-3"]);
  for (const streamingUrl of runnerUrls) {
    assert.equal(streamingUrl.searchParams.get("sendInitialEvents"), "true");
    assert.equal(streamingUrl.searchParams.get("resourceVersionMatch"), "NotOlderThan");
    assert.equal(streamingUrl.searchParams.get("allowWatchBookmarks"), "true");
  }
  fs.writeFileSync(fixture.stopPath, "stop\n", { mode: 0o600 });
  const result = await fixture.closed;
  assert.deepEqual({ code: result.code, signal: result.signal }, { code: 0, signal: null });
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.match(fs.readFileSync(fixture.readyPath, "utf8"),
    /^ready:(?:[a-f0-9]{64}:){3}[a-f0-9]{64}\n$/u);
  assert.match(fs.readFileSync(fixture.finalPath, "utf8"),
    /^complete:(?:[a-f0-9]{64}:){3}[a-f0-9]{64}\n$/u);
});

for (const mode of ["lease-holder-flip", "lease-stale-renew", "lease-unobserved"]) {
  test(`CLI rejects unsafe or non-causal Lease evidence: ${mode}`, async t => {
    const fixture = runMonitorFixture(mode);
    t.after(() => cleanupFixture(fixture));
    await assertMonitorFailed(fixture);
  });
}

for (const [name, options] of [
  ["digest", { controlSha256: "f".repeat(64) }],
  ["operation", {
    mutateControlBaseline: value => { value.operation_id = "b".repeat(32); }
  }],
  ["owner", {
    mutateControlBaseline: value => { value.operation_owner = "aud065-rotation"; }
  }],
  ["context", { controlContext: "different-context" }]
]) {
  test(`CLI rejects a control-baseline ${name} mismatch`, async t => {
    const fixture = runMonitorFixture("success", options);
    t.after(() => cleanupFixture(fixture));
    await assertMonitorFailed(fixture);
  });
}

test("CLI rejects immediate Watch closure outside the exact local fixture", async t => {
  const fixture = runMonitorFixture("success", { context: "production-context" });
  t.after(() => cleanupFixture(fixture));
  await assertMonitorFailed(fixture);
});

for (const target of ["stop", "baseline"]) {
  test(`CLI rejects same-content inode replacement of ${target}`, async t => {
    const fixture = runMonitorFixture();
    t.after(() => cleanupFixture(fixture));
    await waitFor(() => fs.readFileSync(fixture.readyPath, "utf8").startsWith("ready:"));
    const targetPath = target === "stop" ? fixture.stopPath : fixture.baselinePath;
    const replacement = `${targetPath}.replacement`;
    privateFile(replacement, fs.readFileSync(targetPath, "utf8"));
    fs.renameSync(replacement, targetPath);
    const result = await fixture.closed;
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(fs.readFileSync(fixture.finalPath, "utf8"), "");
    assert.equal(fs.readFileSync(fixture.failurePath, "utf8"),
      "durable_runner_monitor_failed\n");
  });
}

test("CLI rejects post-ready monitor-authority tampering", async t => {
  const fixture = runMonitorFixture();
  t.after(() => cleanupFixture(fixture));
  await waitFor(() => fs.readFileSync(fixture.readyPath, "utf8").startsWith("ready:"));
  fs.appendFileSync(fixture.authorityPath, "\n");
  await assertMonitorFailedAfterReady(fixture);
});

for (const target of ["baseline", "control baseline"]) {
  test(`CLI rejects a ${target} replacement during the last asynchronous round`, async t => {
    const fixture = runMonitorFixture("gated-watch");
    t.after(() => cleanupFixture(fixture));
    await waitFor(() => fs.existsSync(fixture.watchGatePath) &&
      fs.readFileSync(fixture.watchGatePath, "utf8").trim().split("\n").length >= 2);
    const targetPath = target === "baseline"
      ? fixture.baselinePath
      : fixture.controlBaselinePath;
    const replacement = `${targetPath}.replacement`;
    privateFile(replacement, fs.readFileSync(targetPath, "utf8"));
    fs.renameSync(replacement, targetPath);
    privateFile(fixture.watchReleasePath, "release\n");
    await assertMonitorFailed(fixture);
  });
}

test("CLI never adopts a replaced failure marker", async t => {
  const fixture = runMonitorFixture();
  t.after(() => cleanupFixture(fixture));
  await waitFor(() => fs.readFileSync(fixture.readyPath, "utf8").startsWith("ready:"));
  const replacement = `${fixture.failurePath}.replacement`;
  privateFile(replacement);
  fs.renameSync(replacement, fixture.failurePath);
  fs.writeFileSync(fixture.stopPath, "invalid\n", { mode: 0o600 });
  const result = await fixture.closed;
  assert.notEqual(result.code, 0);
  assert.equal(fs.readFileSync(fixture.failurePath, "utf8"), "");
  assert.equal(fs.readFileSync(fixture.finalPath, "utf8"), "");
});

for (const mode of ["partial-parent-list", "partial-runner-list", "truncated-list"]) {
  test(`CLI rejects incomplete raw LIST evidence: ${mode}`, async t => {
    const fixture = runMonitorFixture(mode);
    t.after(() => cleanupFixture(fixture));
    const result = await fixture.closed;
    assert.notEqual(result.code, 0);
    assert.equal(fs.readFileSync(fixture.readyPath, "utf8"), "");
    assert.equal(fs.readFileSync(fixture.finalPath, "utf8"), "");
    assert.equal(fs.readFileSync(fixture.failurePath, "utf8"),
      "durable_runner_monitor_failed\n");
  });
}

for (const mode of ["hang-watch", "leader-exits-watch"]) {
  test(`SIGTERM collects the kubectl group and resistant descendants: ${mode}`, async t => {
    const fixture = runMonitorFixture(mode);
    t.after(() => cleanupFixture(fixture));
    await waitFor(() => fs.existsSync(fixture.descendantPath) &&
      fs.readFileSync(fixture.descendantPath, "utf8").trim() !== "");
    const descendantPids = fs.readFileSync(fixture.descendantPath, "utf8").trim()
      .split("\n").map(Number);
    assert.ok(descendantPids.length >= 1 && descendantPids.every(pid =>
      Number.isSafeInteger(pid) && pid > 1));
    fixture.child.kill("SIGTERM");
    const result = await fixture.closed;
    assert.equal(result.code, 143);
    await waitFor(() => descendantPids.every(pid => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return error?.code === "ESRCH";
      }
    }), 5_000);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(fs.readFileSync(fixture.failurePath, "utf8"),
      "durable_runner_monitor_failed\n");
  });
}

for (const [signal, status] of [
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGQUIT", 131]
]) {
  test(`${signal} collects kubectl groups before the monitor exits`, async t => {
    const fixture = runMonitorFixture("hang-watch");
    t.after(() => cleanupFixture(fixture));
    await waitFor(() => fs.existsSync(fixture.descendantPath) &&
      fs.readFileSync(fixture.descendantPath, "utf8").trim() !== "");
    const descendantPids = fs.readFileSync(fixture.descendantPath, "utf8").trim()
      .split("\n").map(Number);
    fixture.child.kill(signal);
    const result = await fixture.closed;
    assert.equal(result.code, status);
    await waitFor(() => descendantPids.every(pid => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return error?.code === "ESRCH";
      }
    }), 5_000);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(fs.readFileSync(fixture.failurePath, "utf8"),
      "durable_runner_monitor_failed\n");
  });
}

test("fixture cleanup reaps kubectl groups after abrupt monitor loss", async t => {
  const fixture = runMonitorFixture("hang-watch");
  t.after(() => cleanupFixture(fixture));
  await waitFor(() => recordedFixtureProcessGroups(fixture).length > 0 &&
    fs.existsSync(fixture.descendantPath) &&
    fs.readFileSync(fixture.descendantPath, "utf8").trim() !== "");
  const processGroups = recordedFixtureProcessGroups(fixture);
  const descendantPids = fs.readFileSync(fixture.descendantPath, "utf8").trim()
    .split("\n").map(Number);
  fixture.child.kill("SIGKILL");
  const result = await fixture.closed;
  assert.deepEqual({ code: result.code, signal: result.signal },
    { code: null, signal: "SIGKILL" });
  const cleanedGroups = await cleanupFixture(fixture);
  assert.deepEqual(cleanedGroups.sort((left, right) => left - right),
    processGroups.sort((left, right) => left - right));
  assert.ok(cleanedGroups.every(pid => !fixtureProcessGroupExists(pid)));
  assert.ok(descendantPids.every(pid => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  }));
});

test("spontaneous kubectl leader exit cannot orphan a resistant process-group descendant", async t => {
  const fixture = runMonitorFixture("leader-spontaneous-watch");
  t.after(() => cleanupFixture(fixture));
  const result = await fixture.closed;
  assert.notEqual(result.code, 0);
  assert.ok(fs.existsSync(fixture.descendantPath));
  const descendantPids = fs.readFileSync(fixture.descendantPath, "utf8").trim()
    .split("\n").map(Number);
  assert.ok(descendantPids.length >= 1 && descendantPids.every(pid =>
    Number.isSafeInteger(pid) && pid > 1));
  await waitFor(() => descendantPids.every(pid => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  }), 5_000);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(fs.readFileSync(fixture.finalPath, "utf8"), "");
  assert.equal(fs.readFileSync(fixture.failurePath, "utf8"),
    "durable_runner_monitor_failed\n");
});

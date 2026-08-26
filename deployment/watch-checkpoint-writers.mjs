#!/usr/bin/env node

// Proves that the five fixed checkpoint consumers remain quiescent for the
// whole coordinated DB + ret-pvc snapshot window. Kubernetes payloads never
// leave this process; the only persistent outputs are an immutable local
// baseline, a monotonic atomic progress marker, a ready marker and one fixed
// failure code.

import crypto from "node:crypto";
import fs from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";

const MAX_LIST_BYTES = 16 * 1024 * 1024;
const MAX_EVENT_BYTES = 4 * 1024 * 1024;
const MAX_CONTRACT_BYTES = 128 * 1024;
const MAX_BASELINE_BYTES = 2 * 1024 * 1024;
const WATCH_TIMEOUT_SECONDS = 2;
const FINAL_STABLE_SECONDS = 61;
const FINAL_OVERLAP_WATCH_SECONDS = 65;
const TERMINAL_POSTCONDITION_TIMEOUT_MILLISECONDS = 55_000;
// One supervised root sequence may spend up to 45s in each exact read and 30s
// in the single PATCH. Keep a bounded 180s command window. The handoff renews
// short Watch requests from their last exact resourceVersion throughout it.
const HANDOFF_COMMIT_TIMEOUT_MILLISECONDS = 180_000;
const RECOVERY_OPERATION_FENCE_NAME = "recovery-operation-pod-fence.yenhubs.org";
const RUNNER_NAMESPACE = "hcce-bot-runners";
const RECOVERY_FENCE_REQUEST_TIMEOUT_SECONDS = 3;
const RECOVERY_FENCE_PROCESS_TIMEOUT_MILLISECONDS = 4000;
const RECOVERY_FENCE_VALIDATION_TIMEOUT_MILLISECONDS = 8500;
const DEPLOYMENT_NAMES = [
  "bot-orchestrator", "coturn", "dialog", "haproxy", "hubs", "nearspark",
  "pgbouncer", "pgbouncer-t", "pgsql", "photomnemonic", "reticulum", "spoke"
];
const WRITER_NAMES = [
  "bot-orchestrator", "coturn", "pgbouncer", "pgbouncer-t", "reticulum"
];
const DEPLOYMENT_NAME_SET = new Set(DEPLOYMENT_NAMES);
const WRITER_NAME_SET = new Set(WRITER_NAMES);
const activeChildren = new Set();
let failureStage = "arguments";
const SAFE_BASELINE_FAILURE_CODES = new Set([
  "baseline_contract", "deployment_inventory", "deployments_list_contract",
  "file_contract", "file_size", "file_write", "kubectl_read", "owner_contract",
  "pod_inventory", "pod_inventory_name_duplicate", "pod_inventory_uid_duplicate",
  "pod_owner_contract", "pod_service_account_projection",
  "pod_spec_contract", "pod_template_contract", "pod_template_drift_baseline",
  "pods_list_contract", "replicaset_inventory", "replicasets_list_contract",
  "reticulum_image_contract", "writer_pod_present",
  // The monitor's watch stage has the same fixed, payload-free error
  // vocabulary. Keep these codes visible in the allowlisted diagnostic so a
  // live watch failure is attributable without exposing Kubernetes output.
  "deployment_event", "deployment_event_contract", "pod_event_contract",
  "pod_event_gvk", "pod_event_metadata", "pod_event_namespace",
  "pod_event_name", "pod_event_uid", "pod_event_resource-version",
  "pod_event_labels", "pod_event_annotations", "pod_event_spec",
  "pod_event_deletion",
  "pod_event_drift", "pod_event_drift_history_missing",
  "pod_event_drift_name", "pod_event_drift_uid", "pod_event_drift_role",
  "pod_event_drift_owner", "pod_event_drift_fingerprint",
  "pod_event_drift_admission", "pod_event_drift_object",
  "pod_event_drift_active_name", "pod_event_drift_active_uid",
  "pod_event_drift_active_role", "pod_event_drift_active_owner",
  "pod_event_drift_active_fingerprint", "pod_event_drift_active_admission",
  "pod_event_drift_active_object", "pod_event_drift_deleted_name",
  "pod_event_drift_deleted_uid", "pod_event_drift_deleted_role",
  "pod_event_drift_deleted_owner", "pod_event_drift_deleted_fingerprint",
  "pod_event_drift_deleted_admission", "pod_event_drift_deleted_object",
  "pod_event_drift_object_annotations", "pod_event_drift_object_creation",
  "pod_event_drift_object_finalizers", "pod_event_drift_object_generate-name",
  "pod_event_drift_object_generation", "pod_event_drift_object_labels",
  "pod_event_drift_object_owners", "pod_event_drift_object_spec",
  "pod_event_drift_object_multiple", "pod_event_drift_object_finalizers_annotations",
  "pod_event_drift_object_finalizers_creation", "pod_event_drift_object_finalizers_generate-name",
  "pod_event_drift_object_finalizers_generation", "pod_event_drift_object_finalizers_labels",
  "pod_event_drift_object_finalizers_owners", "pod_event_drift_object_finalizers_spec",
  "pod_event_drift_object_finalizers_multiple",
  "pod_name_collision", "pod_template_drift_event",
  "replicaset_event", "replicaset_event_contract", "watch_barrier_aborted",
  "watch_barrier_state", "watch_bookmark_contract", "watch_closed",
  "watch_drain_state", "watch_error_event", "watch_event_contract",
  "watch_event_json", "watch_event_type", "watch_not_live", "watch_resource",
  "watch_resource_version", "watch_spawn", "watch_stop_contract",
  "watch_terminated", "writer_pod_event"
]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function diagnosticToken(value) {
  const text = String(value || "other");
  return /^[a-z][a-z0-9_-]{0,63}$/.test(text) ? text : "other";
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactArguments(argv) {
  const mode = argv[0];
  if (!new Set(["monitor", "boundary"]).has(mode)) fail("arguments");
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !value || values.has(key)) fail("arguments");
    values.set(key, value);
  }
  const common = [
    "--context", "--namespace", "--namespace-uid", "--contract",
    "--contract-sha256", "--baseline", "--operation-lock-name",
    "--operation-lock-uid", "--operation-lock-resource-version",
    "--operation-owner", "--operation-id", "--lease-name", "--lease-uid",
    "--lease-holder", "--runtime-generation"
  ];
  const modeSpecific = mode === "monitor"
    ? ["--stop", "--failure", "--ready", "--progress", "--final", "--authority"]
    : ["--baseline-sha256"];
  const expected = [...common, ...modeSpecific].sort();
  if (
    values.size !== expected.length ||
    [...values.keys()].sort().join("\n") !== expected.join("\n")
  ) fail("arguments");
  if (!/^[A-Za-z0-9_.:@/-]{1,253}$/.test(values.get("--context"))) {
    fail("context");
  }
  for (const key of ["--namespace", "--operation-lock-name", "--lease-name"]) {
    if (!/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(values.get(key))) {
      fail("resource_name");
    }
  }
  for (const key of ["--namespace-uid", "--operation-lock-uid", "--lease-uid"]) {
    if (!/^[A-Za-z0-9._:-]{1,253}$/.test(values.get(key))) fail("uid");
  }
  if (!/^[A-Za-z0-9._:-]{1,253}$/.test(values.get("--operation-lock-resource-version"))) {
    fail("resource_version");
  }
  if (!new Set(["checkpoint-backup", "checkpoint-restore"]).has(
    values.get("--operation-owner")
  )) fail("operation_owner");
  if (!/^[a-f0-9]{32}$/.test(values.get("--operation-id"))) fail("operation_id");
  if (!/^root-recovery:[a-f0-9-]{36}$/.test(values.get("--lease-holder"))) {
    fail("lease_holder");
  }
  if (!new Set(["durable-v2", "legacy-absent"]).has(values.get("--runtime-generation"))) {
    fail("runtime_generation");
  }
  for (const key of ["--contract-sha256", "--baseline-sha256"]) {
    if (values.has(key) && !/^[a-f0-9]{64}$/.test(values.get(key))) fail("sha256");
  }
  for (const key of [
    "--contract", "--baseline", "--stop", "--failure", "--ready", "--progress",
    "--final", "--authority"
  ]) {
    if (values.has(key) && !path.isAbsolute(values.get(key))) fail("path");
  }
  const fileKeys = mode === "monitor"
    ? [
        "--contract", "--baseline", "--stop", "--failure", "--ready",
        "--progress", "--final", "--authority"
      ]
    : ["--contract", "--baseline"];
  if (new Set(fileKeys.map(key => values.get(key))).size !== fileKeys.length) {
    fail("path_alias");
  }
  return { mode, values };
}

function openRegularNoFollow(filePath, flags, maximumBytes) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, flags | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > maximumBytes) {
      fs.closeSync(descriptor);
      fail("file_contract");
    }
    return descriptor;
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    if (error?.code === "file_contract") throw error;
    fail("file_contract");
  }
}

function readRegular(filePath, maximumBytes) {
  let descriptor;
  try {
    descriptor = openRegularNoFollow(filePath, fs.constants.O_RDONLY, maximumBytes);
    const value = fs.readFileSync(descriptor, "utf8");
    fs.closeSync(descriptor);
    return value;
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    throw error;
  }
}

function writeRegular(filePath, value, maximumBytes) {
  if (Buffer.byteLength(value, "utf8") > maximumBytes) fail("file_size");
  let descriptor;
  try {
    descriptor = openRegularNoFollow(filePath, fs.constants.O_WRONLY, maximumBytes);
    fs.ftruncateSync(descriptor, 0);
    fs.writeFileSync(descriptor, value, { encoding: "utf8" });
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    throw error;
  }
}

function writeAtomicRegular(filePath, value, maximumBytes) {
  if (Buffer.byteLength(value, "utf8") > maximumBytes) fail("file_size");
  const nextPath = `${filePath}.next`;
  let descriptor;
  try {
    // The parent creates the private 0600 capability. Validate that exact
    // endpoint before replacing it, and create the replacement without
    // following or overwriting any pre-existing path.
    descriptor = openRegularNoFollow(filePath, fs.constants.O_RDONLY, maximumBytes);
    fs.closeSync(descriptor);
    descriptor = undefined;
    descriptor = fs.openSync(
      nextPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600
    );
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) fail("file_contract");
    fs.writeFileSync(descriptor, value, { encoding: "utf8" });
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(nextPath, filePath);
    const directory = fs.openSync(
      path.dirname(filePath), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY
    );
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(nextPath); } catch {}
    if (error?.code === "file_contract") throw error;
    fail("file_write");
  }
}

function writeProgressMarker(markerPath, value, authoritySha256) {
  const nextPath = `${markerPath}.next`;
  let descriptor;
  try {
    // Validate the parent-created capability before replacing it atomically.
    descriptor = openRegularNoFollow(markerPath, fs.constants.O_RDONLY, 2048);
    fs.closeSync(descriptor);
    descriptor = undefined;
    descriptor = fs.openSync(
      nextPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600
    );
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) fail("file_contract");
    fs.writeFileSync(
      descriptor, `${authoritySha256}:${value}\n`, { encoding: "utf8" }
    );
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(nextPath, markerPath);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(nextPath); } catch {}
    if (error?.code === "file_contract") throw error;
    fail("file_write");
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function validateMonitorAuthority(values, options) {
  const authorityText = readRegular(values.get("--authority"), 64 * 1024);
  const authority = parseJson(authorityText, "monitor_authority_json");
  const expected = {
    schema_version: 1,
    kind: "checkpoint-writer-monitor",
    pid: process.pid,
    start_identity: authority?.start_identity,
    context: options.context,
    namespace: options.namespace,
    namespace_uid: options.namespaceUid,
    operation_id: options.operationId,
    operation_owner: options.operationOwner,
    runtime_generation: options.runtimeGeneration,
    operation_lock: {
      name: options.lockName,
      uid: options.lockUid,
      resource_version: options.lockResourceVersion
    },
    lease: {
      name: options.leaseName,
      uid: options.leaseUid,
      holder: options.leaseHolder
    },
    paths: {
      authority: values.get("--authority"),
      contract: values.get("--contract"),
      baseline: values.get("--baseline"),
      stop: values.get("--stop"),
      failure: values.get("--failure"),
      ready: values.get("--ready"),
      progress: values.get("--progress"),
      final: values.get("--final")
    },
    hashes: { contract_sha256: values.get("--contract-sha256") }
  };
  if (
    !object(authority) || !Number.isSafeInteger(authority.pid) ||
    authority.pid !== process.pid || typeof authority.start_identity !== "string" ||
    authority.start_identity.length < 1 || authority.start_identity.length > 512 ||
    authorityText !== `${canonicalJson(expected)}\n`
  ) fail("monitor_authority");
  return sha256(authorityText);
}

function parseJson(text, code) {
  try {
    return JSON.parse(text);
  } catch {
    fail(code);
  }
}

function exactKeys(value, keys) {
  return object(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function exactOrOmittedTypeMeta(value, apiVersion, kind, allowOmitted = false) {
  if (value?.apiVersion === apiVersion && value?.kind === kind) return true;
  return allowOmitted &&
    [undefined, null].includes(value?.apiVersion) &&
    [undefined, null].includes(value?.kind);
}

function canonicalConsumerFingerprint(encoded, code = "consumer_contract") {
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    if (!exactKeys(value, ["selector", "strategy", "template"])) fail(code);
    return Buffer.from(canonicalJson(value)).toString("base64");
  } catch (error) {
    if (error?.code === code) throw error;
    fail(code);
  }
}

function validateConsumerContract(text, expectedDigest, namespace) {
  if (sha256(text) !== expectedDigest) fail("contract_digest");
  const contract = parseJson(text, "contract_json");
  const expectedNames = [
    "bot-orchestrator", "coturn", "pgbouncer", "pgbouncer-t", "reticulum"
  ];
  if (
    !exactKeys(contract, ["schema_version", "operation_id", "consumers"]) ||
    contract.schema_version !== 1 || !/^[a-f0-9]{32}$/.test(contract.operation_id) ||
    !Array.isArray(contract.consumers) || contract.consumers.length !== 5
  ) fail("consumer_contract");
  const seen = new Set();
  for (const consumer of contract.consumers) {
    if (
      !exactKeys(consumer, [
        "name", "uid", "initial_resource_version", "original_replicas",
        "selector", "fingerprint"
      ]) || !expectedNames.includes(consumer.name) || seen.has(consumer.name) ||
      typeof consumer.uid !== "string" || !consumer.uid ||
      typeof consumer.initial_resource_version !== "string" ||
      !consumer.initial_resource_version ||
      !Number.isInteger(consumer.original_replicas) || consumer.original_replicas <= 0 ||
      typeof consumer.selector !== "string" ||
      !/^[A-Za-z0-9._-]+$/.test(consumer.selector) ||
      typeof consumer.fingerprint !== "string" ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(consumer.fingerprint)
    ) fail("consumer_contract");
    canonicalConsumerFingerprint(consumer.fingerprint);
    seen.add(consumer.name);
  }
  if (expectedNames.some(name => !seen.has(name)) || !namespace) fail("consumer_contract");
  return contract;
}

function remainingDeadlineMilliseconds(deadline, code) {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) fail(code);
  return remaining;
}

function kubectlJson(
  kubectl, context, args, maximumBytes = MAX_LIST_BYTES, deadline = null
) {
  const remaining = deadline === null
    ? null
    : remainingDeadlineMilliseconds(deadline, "terminal_postcondition_timeout");
  const requestTimeoutSeconds = remaining === null
    ? 45
    : Math.max(1, Math.min(45, Math.ceil(remaining / 1000)));
  try {
    return parseJson(execFileSync(kubectl, [
      "--context", context, `--request-timeout=${requestTimeoutSeconds}s`, ...args
    ], {
      encoding: "utf8",
      maxBuffer: maximumBytes,
      stdio: ["ignore", "pipe", "ignore"],
      ...(remaining === null ? {} : { timeout: remaining, killSignal: "SIGKILL" })
    }), "kubectl_json");
  } catch (error) {
    if (error?.code && String(error.code).startsWith("kubectl_")) throw error;
    fail("kubectl_read");
  }
}

function kubectlFenceJson(kubectl, context, args, deadline) {
  const remainingMilliseconds = remainingDeadlineMilliseconds(
    deadline, "recovery_fence_timeout"
  );
  try {
    return parseJson(execFileSync(kubectl, [
      "--context", context,
      `--request-timeout=${RECOVERY_FENCE_REQUEST_TIMEOUT_SECONDS}s`,
      ...args
    ], {
      encoding: "utf8",
      maxBuffer: MAX_CONTRACT_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: Math.min(
        RECOVERY_FENCE_PROCESS_TIMEOUT_MILLISECONDS, remainingMilliseconds
      ),
      killSignal: "SIGKILL"
    }), "recovery_fence_json");
  } catch (error) {
    if (error?.code && String(error.code).startsWith("recovery_fence_")) throw error;
    fail("recovery_fence_read");
  }
}

function validateNamespace(kubectl, context, namespace, expectedUid, deadline = null) {
  const value = kubectlJson(
    kubectl, context, ["get", "namespace", namespace, "-o", "json"],
    MAX_LIST_BYTES, deadline
  );
  if (
    value.apiVersion !== "v1" || value.kind !== "Namespace" ||
    value.metadata?.name !== namespace || value.metadata?.uid !== expectedUid ||
    typeof value.metadata?.resourceVersion !== "string" ||
    !value.metadata.resourceVersion || value.metadata.deletionTimestamp !== undefined
  ) fail("namespace_contract");
}

function validateLease(kubectl, context, options, expected = null, deadline = null) {
  const value = kubectlJson(kubectl, context, [
    "get", "lease", options.leaseName, "-n", options.namespace, "-o", "json"
  ], MAX_LIST_BYTES, deadline);
  const metadata = value.metadata;
  const spec = value.spec;
  const acquireEpoch = Date.parse(spec?.acquireTime);
  const renewEpoch = Date.parse(spec?.renewTime);
  const now = Date.now();
  if (
    value.apiVersion !== "coordination.k8s.io/v1" || value.kind !== "Lease" ||
    metadata?.name !== options.leaseName || metadata?.namespace !== options.namespace ||
    metadata?.uid !== options.leaseUid || typeof metadata?.resourceVersion !== "string" ||
    !metadata.resourceVersion || metadata.deletionTimestamp !== undefined ||
    JSON.stringify(metadata.labels || {}) !==
      JSON.stringify({ "yenhubs.org/operation-serialization": "deployment-recovery" }) ||
    ![undefined, null].includes(metadata.ownerReferences) &&
      JSON.stringify(metadata.ownerReferences) !== "[]" ||
    spec?.holderIdentity !== options.leaseHolder || spec?.leaseDurationSeconds !== 120 ||
    !Number.isInteger(spec?.leaseTransitions) || spec.leaseTransitions < 0 ||
    typeof spec?.acquireTime !== "string" || !Number.isFinite(acquireEpoch) ||
    acquireEpoch > now + 5000 ||
    !Number.isFinite(renewEpoch) || renewEpoch > now + 5000 || now - renewEpoch > 40000
  ) fail("lease_contract");
  const identity = {
    name: metadata.name,
    uid: metadata.uid,
    holder: spec.holderIdentity,
    acquire_time: spec.acquireTime,
    lease_transitions: spec.leaseTransitions
  };
  if (expected && JSON.stringify(identity) !== JSON.stringify(expected)) {
    fail("lease_invariant");
  }
  return identity;
}

function validateOperationLock(kubectl, context, options, deadline = null) {
  const value = kubectlJson(kubectl, context, [
    "get", "configmap", options.lockName, "-n", options.namespace, "-o", "json"
  ], MAX_LIST_BYTES, deadline);
  const metadata = value.metadata;
  if (
    value.apiVersion !== "v1" || value.kind !== "ConfigMap" ||
    metadata?.name !== options.lockName || metadata?.namespace !== options.namespace ||
    metadata?.uid !== options.lockUid ||
    metadata?.resourceVersion !== options.lockResourceVersion ||
    metadata.deletionTimestamp !== undefined || value.immutable !== true ||
    JSON.stringify(metadata.labels || {}) !== JSON.stringify({
      "yenhubs.org/recovery-owner": options.operationOwner
    }) ||
    metadata.annotations?.["yenhubs.org/operation-id"] !== options.operationId ||
    JSON.stringify(value.data || {}) !== "{}" || JSON.stringify(value.binaryData || {}) !== "{}"
  ) fail("operation_lock_contract");
}

function validateControlPlane(
  kubectl, context, options, expectedLease = null, deadline = null
) {
  if (options.baseline) {
    validateRecoveryOperationFence(
      kubectl, context, options, options.baseline.recovery_operation_fence,
      deadline
    );
  }
  if (!options.baseline || options.runtimeGeneration === "legacy-absent") {
    validateNamespace(
      kubectl, context, options.namespace, options.namespaceUid, deadline
    );
  }
  const lease = validateLease(kubectl, context, options, expectedLease, deadline);
  validateOperationLock(kubectl, context, options, deadline);
  return lease;
}

function deploymentFingerprint(deployment) {
  return Buffer.from(JSON.stringify({
    selector: deployment.spec.selector,
    strategy: deployment.spec.strategy || {},
    template: deployment.spec.template
  })).toString("base64");
}

function canonicalDeploymentFingerprint(deployment) {
  return Buffer.from(canonicalJson({
    selector: deployment.spec.selector,
    strategy: deployment.spec.strategy || {},
    template: deployment.spec.template
  })).toString("base64");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function recoveryOperationFenceNamespaceSelector(namespace) {
  return {
    matchExpressions: [{
      key: "kubernetes.io/metadata.name",
      operator: "In",
      values: [namespace, RUNNER_NAMESPACE]
    }]
  };
}

function expectedRecoveryOperationFencePolicySpec(namespace) {
  return {
    failurePolicy: "Fail",
    matchConstraints: {
      matchPolicy: "Equivalent",
      namespaceSelector: recoveryOperationFenceNamespaceSelector(namespace),
      objectSelector: {},
      resourceRules: [
        {
          apiGroups: [""],
          apiVersions: ["v1"],
          operations: ["CREATE", "UPDATE", "DELETE"],
          resources: ["pods", "pods/ephemeralcontainers", "pods/eviction", "pods/resize"],
          scope: "Namespaced"
        },
        {
          apiGroups: [""],
          apiVersions: ["v1"],
          operations: ["CONNECT"],
          resources: ["pods/attach", "pods/exec", "pods/portforward", "pods/proxy"],
          scope: "Namespaced"
        }
      ]
    },
    variables: [
      {
        name: "pod",
        expression: "request.operation == 'DELETE' ? oldObject : object"
      },
      {
        name: "labels",
        expression: "has(variables.pod.metadata.labels) ? variables.pod.metadata.labels : {}"
      },
      {
        name: "writerNames",
        expression: "['reticulum', 'pgbouncer', 'pgbouncer-t', 'bot-orchestrator', 'coturn']"
      },
      {
        name: "podNames",
        expression: "[has(variables.pod.metadata.name) ? variables.pod.metadata.name : '',\n has(variables.pod.metadata.generateName) ? variables.pod.metadata.generateName : '']"
      },
      {
        name: "labelValues",
        expression: "['app' in variables.labels ? variables.labels['app'] : '',\n 'component' in variables.labels ? variables.labels['component'] : '',\n 'app.kubernetes.io/name' in variables.labels ? variables.labels['app.kubernetes.io/name'] : '']"
      },
      {
        name: "isParentWriterCreate",
        expression: "request.operation == 'CREATE' && (!has(request.subResource) || request.subResource == '') && request.namespace == '" + namespace + "' && (variables.writerNames.exists(writer, variables.labelValues.exists(value, value == writer)) ||\n (has(variables.pod.spec.serviceAccountName) &&\n  variables.pod.spec.serviceAccountName == 'bot-orchestrator') ||\n variables.pod.spec.containers.exists(container, container.name in variables.writerNames) ||\n variables.podNames.exists(value,\n   variables.writerNames.exists(writer, value == writer || value.startsWith(writer + '-'))) ||\n (has(variables.pod.metadata.ownerReferences) &&\n  variables.pod.metadata.ownerReferences.exists(owner,\n    owner.kind == 'ReplicaSet' &&\n    variables.writerNames.exists(writer,\n      owner.name == writer || owner.name.startsWith(writer + '-')))))"
      }
    ],
    validations: [
      {
        expression: "!variables.isParentWriterCreate",
        message: "recovery operation Pod fence denies database-writer Pod creation while checkpoint or restore is fenced",
        reason: "Forbidden"
      },
      {
        expression: "request.namespace != 'hcce-bot-runners'",
        message: "recovery operation Pod fence denies runner Pod mutation while checkpoint or restore is fenced",
        reason: "Forbidden"
      }
    ]
  };
}

function expectedRecoveryOperationFenceBindingSpec(namespace) {
  return {
    policyName: RECOVERY_OPERATION_FENCE_NAME,
    validationActions: ["Deny"],
    matchResources: {
      matchPolicy: "Equivalent",
      namespaceSelector: recoveryOperationFenceNamespaceSelector(namespace),
      objectSelector: {}
    }
  };
}

function observedRecoveryOperationFencePolicy(policy, namespace) {
  const generation = policy?.metadata?.generation;
  const typeChecking = policy?.status?.typeChecking;
  const warnings = typeChecking?.expressionWarnings;
  const conditions = policy?.status?.conditions;
  return policy?.apiVersion === "admissionregistration.k8s.io/v1" &&
    policy?.kind === "ValidatingAdmissionPolicy" &&
    policy?.metadata?.name === RECOVERY_OPERATION_FENCE_NAME &&
    typeof policy?.metadata?.uid === "string" && policy.metadata.uid.length > 0 &&
    typeof policy?.metadata?.resourceVersion === "string" &&
    policy.metadata.resourceVersion.length > 0 &&
    Number.isInteger(generation) && generation > 0 &&
    policy.metadata.deletionTimestamp === undefined &&
    policy.metadata.deletionGracePeriodSeconds === undefined &&
    canonicalJson(policy.spec) ===
      canonicalJson(expectedRecoveryOperationFencePolicySpec(namespace)) &&
    policy?.status?.observedGeneration === generation &&
    object(typeChecking) &&
    (warnings === undefined || Array.isArray(warnings) && warnings.length === 0) &&
    (conditions === undefined || Array.isArray(conditions) &&
      conditions.every(condition => condition?.status === "True"));
}

function exactActiveRecoveryOperationFenceBinding(binding, namespace) {
  return binding?.apiVersion === "admissionregistration.k8s.io/v1" &&
    binding?.kind === "ValidatingAdmissionPolicyBinding" &&
    binding?.metadata?.name === RECOVERY_OPERATION_FENCE_NAME &&
    typeof binding?.metadata?.uid === "string" && binding.metadata.uid.length > 0 &&
    typeof binding?.metadata?.resourceVersion === "string" &&
    binding.metadata.resourceVersion.length > 0 &&
    binding.metadata.deletionTimestamp === undefined &&
    binding.metadata.deletionGracePeriodSeconds === undefined &&
    canonicalJson(binding.spec) ===
      canonicalJson(expectedRecoveryOperationFenceBindingSpec(namespace));
}

function activeNamespaceIdentity(namespace, expectedName, expectedUid = null) {
  const metadata = namespace?.metadata;
  if (
    namespace?.apiVersion !== "v1" || namespace?.kind !== "Namespace" ||
    metadata?.name !== expectedName ||
    typeof metadata?.uid !== "string" || metadata.uid.length === 0 ||
    expectedUid !== null && metadata.uid !== expectedUid ||
    typeof metadata?.resourceVersion !== "string" ||
    metadata.resourceVersion.length === 0 ||
    metadata.deletionTimestamp !== undefined ||
    metadata.deletionGracePeriodSeconds !== undefined ||
    metadata.labels?.["kubernetes.io/metadata.name"] !== expectedName ||
    namespace?.status?.phase !== "Active"
  ) fail("recovery_fence_namespace_contract");
  return {
    name: expectedName,
    uid: metadata.uid,
    resource_version: metadata.resourceVersion,
    phase: namespace.status.phase,
    metadata_name_label: metadata.labels["kubernetes.io/metadata.name"]
  };
}

function captureRecoveryOperationFence(kubectl, context, options, outerDeadline = null) {
  if (options.runtimeGeneration === "legacy-absent") return null;
  if (options.runtimeGeneration !== "durable-v2") fail("runtime_generation");
  const ownDeadline = performance.now() + RECOVERY_FENCE_VALIDATION_TIMEOUT_MILLISECONDS;
  const deadline = outerDeadline === null
    ? ownDeadline
    : Math.min(outerDeadline, ownDeadline);
  const parentNamespace = kubectlFenceJson(kubectl, context, [
    "get", "namespace", options.namespace, "-o", "json"
  ], deadline);
  const runnerNamespace = kubectlFenceJson(kubectl, context, [
    "get", "namespace", RUNNER_NAMESPACE, "-o", "json"
  ], deadline);
  const policy = kubectlFenceJson(kubectl, context, [
    "get", "validatingadmissionpolicy", RECOVERY_OPERATION_FENCE_NAME, "-o", "json"
  ], deadline);
  const binding = kubectlFenceJson(kubectl, context, [
    "get", "validatingadmissionpolicybinding", RECOVERY_OPERATION_FENCE_NAME,
    "-o", "json"
  ], deadline);
  const namespaces = {
    parent: activeNamespaceIdentity(
      parentNamespace, options.namespace, options.namespaceUid
    ),
    runner: activeNamespaceIdentity(runnerNamespace, RUNNER_NAMESPACE)
  };
  if (!observedRecoveryOperationFencePolicy(policy, options.namespace)) {
    fail("recovery_fence_policy_contract");
  }
  if (!exactActiveRecoveryOperationFenceBinding(binding, options.namespace)) {
    fail("recovery_fence_binding_contract");
  }
  return {
    namespaces,
    policy: {
      uid: policy.metadata.uid,
      resource_version: policy.metadata.resourceVersion,
      generation: policy.metadata.generation,
      spec_sha256: sha256(canonicalJson(policy.spec))
    },
    binding: {
      uid: binding.metadata.uid,
      resource_version: binding.metadata.resourceVersion,
      spec_sha256: sha256(canonicalJson(binding.spec))
    }
  };
}

function recoveryOperationFenceBaselineIsExact(
  value, runtimeGeneration, namespace, namespaceUid
) {
  if (runtimeGeneration === "legacy-absent") return value === null;
  return runtimeGeneration === "durable-v2" &&
    exactKeys(value, ["namespaces", "policy", "binding"]) &&
    exactKeys(value.namespaces, ["parent", "runner"]) &&
    [value.namespaces.parent, value.namespaces.runner].every(namespace =>
      exactKeys(namespace, [
        "name", "uid", "resource_version", "phase", "metadata_name_label"
      ]) &&
      typeof namespace.name === "string" && namespace.name.length > 0 &&
      typeof namespace.uid === "string" && namespace.uid.length > 0 &&
      typeof namespace.resource_version === "string" &&
      namespace.resource_version.length > 0 && namespace.phase === "Active" &&
      namespace.metadata_name_label === namespace.name
    ) &&
    value.namespaces.parent.name === namespace &&
    value.namespaces.parent.uid === namespaceUid &&
    value.namespaces.runner.name === RUNNER_NAMESPACE &&
    exactKeys(value.policy, ["uid", "resource_version", "generation", "spec_sha256"]) &&
    typeof value.policy.uid === "string" && value.policy.uid.length > 0 &&
    typeof value.policy.resource_version === "string" &&
    value.policy.resource_version.length > 0 &&
    Number.isInteger(value.policy.generation) && value.policy.generation > 0 &&
    /^[a-f0-9]{64}$/.test(value.policy.spec_sha256) &&
    exactKeys(value.binding, ["uid", "resource_version", "spec_sha256"]) &&
    typeof value.binding.uid === "string" && value.binding.uid.length > 0 &&
    typeof value.binding.resource_version === "string" &&
    value.binding.resource_version.length > 0 &&
    /^[a-f0-9]{64}$/.test(value.binding.spec_sha256);
}

function validateRecoveryOperationFence(
  kubectl, context, options, expected, deadline = null
) {
  if (!recoveryOperationFenceBaselineIsExact(
    expected, options.runtimeGeneration, options.namespace, options.namespaceUid
  )) {
    fail("recovery_fence_baseline_contract");
  }
  if (options.runtimeGeneration === "legacy-absent") return;
  const current = captureRecoveryOperationFence(kubectl, context, options, deadline);
  if (canonicalJson(current) !== canonicalJson(expected)) {
    fail("recovery_fence_identity_drift");
  }
}

function metadataFingerprint(resource) {
  return sha256(canonicalJson({
    annotations: resource.metadata.annotations || {},
    finalizers: resource.metadata.finalizers || [],
    labels: resource.metadata.labels || {},
    ownerReferences: resource.metadata.ownerReferences || []
  }));
}

function deploymentSpecFingerprint(deployment) {
  return sha256(canonicalJson(deployment.spec));
}

function validateDeploymentEnvelope(
  deployment, namespace, code, allowOmittedTypeMeta = false
) {
  if (
    !object(deployment) ||
    !exactOrOmittedTypeMeta(
      deployment, "apps/v1", "Deployment", allowOmittedTypeMeta
    ) || !object(deployment.metadata) ||
    deployment.metadata.namespace !== namespace ||
    typeof deployment.metadata.name !== "string" || !deployment.metadata.name ||
    typeof deployment.metadata.uid !== "string" || !deployment.metadata.uid ||
    typeof deployment.metadata.resourceVersion !== "string" ||
    !deployment.metadata.resourceVersion ||
    !Number.isInteger(deployment.metadata.generation) ||
    deployment.metadata.generation < 1 || !object(deployment.spec)
  ) fail(code);
}

function deploymentIdentity(deployment) {
  return {
    name: deployment.metadata.name,
    uid: deployment.metadata.uid,
    resource_version: deployment.metadata.resourceVersion,
    generation: deployment.metadata.generation,
    replicas: deployment.spec.replicas,
    selector: deployment.spec.selector.matchLabels.app,
    fingerprint: deploymentFingerprint(deployment),
    spec_fingerprint: deploymentSpecFingerprint(deployment),
    metadata_fingerprint: metadataFingerprint(deployment)
  };
}

function validateDeploymentShape(deployment, event) {
  if (
    deployment.metadata.deletionTimestamp !== undefined ||
    !Number.isInteger(deployment.spec.replicas) || deployment.spec.replicas < 0 ||
    !object(deployment.spec.selector) ||
    JSON.stringify(Object.keys(deployment.spec.selector.matchLabels || {})) !==
      JSON.stringify(["app"]) ||
    JSON.stringify(deployment.spec.selector.matchExpressions || []) !== "[]" ||
    typeof deployment.spec.selector.matchLabels.app !== "string" ||
    !/^[A-Za-z0-9._-]+$/.test(deployment.spec.selector.matchLabels.app) ||
    deployment.spec.template?.metadata?.labels?.app !==
      deployment.spec.selector.matchLabels.app ||
    !object(deployment.spec.template?.spec)
  ) fail(event ? "deployment_event_contract" : "deployment_inventory");
}

function validateDeploymentObject(
  deployment, namespace, expected, consumer = null, event = false,
  allowOmittedTypeMeta = false
) {
  validateDeploymentEnvelope(
    deployment, namespace, event ? "deployment_event_contract" : "deployment_inventory",
    allowOmittedTypeMeta
  );
  validateDeploymentShape(deployment, event);
  const identity = deploymentIdentity(deployment);
  if (
    identity.name !== expected.name || identity.uid !== expected.uid ||
    identity.generation !== expected.generation || identity.replicas !== expected.replicas ||
    identity.selector !== expected.selector || identity.fingerprint !== expected.fingerprint ||
    identity.spec_fingerprint !== expected.spec_fingerprint ||
    identity.metadata_fingerprint !== expected.metadata_fingerprint ||
    (WRITER_NAME_SET.has(identity.name) && identity.replicas !== 0) ||
    (consumer && (
      identity.uid !== consumer.uid || identity.selector !== consumer.selector ||
      canonicalDeploymentFingerprint(deployment) !==
        canonicalConsumerFingerprint(consumer.fingerprint)
    ))
  ) fail(event ? "deployment_drift" : "deployment_inventory");
  return identity;
}

function controllerOwner(resource, kind) {
  const owners = (resource.metadata?.ownerReferences || []).filter(owner => owner.controller === true);
  if (
    owners.length !== 1 || owners[0].apiVersion !== "apps/v1" ||
    owners[0].kind !== kind || typeof owners[0].name !== "string" ||
    !owners[0].name || typeof owners[0].uid !== "string" || !owners[0].uid
  ) fail("owner_contract");
  return { name: owners[0].name, uid: owners[0].uid };
}

function replicaSetFingerprint(replicaSet) {
  return sha256(canonicalJson({
    ownerReferences: replicaSet.metadata.ownerReferences || [],
    spec: replicaSet.spec
  }));
}

function validateReplicaSetEnvelope(
  replicaSet, namespace, code, allowOmittedTypeMeta = false
) {
  if (
    !object(replicaSet) ||
    !exactOrOmittedTypeMeta(
      replicaSet, "apps/v1", "ReplicaSet", allowOmittedTypeMeta
    ) || !object(replicaSet.metadata) ||
    replicaSet.metadata.namespace !== namespace ||
    typeof replicaSet.metadata.name !== "string" || !replicaSet.metadata.name ||
    typeof replicaSet.metadata.uid !== "string" || !replicaSet.metadata.uid ||
    typeof replicaSet.metadata.resourceVersion !== "string" ||
    !replicaSet.metadata.resourceVersion ||
    !Number.isInteger(replicaSet.metadata.generation) ||
    replicaSet.metadata.generation < 1 || !object(replicaSet.spec)
  ) fail(code);
}

function replicaSetIdentity(replicaSet) {
  const owner = controllerOwner(replicaSet, "Deployment");
  return {
    name: replicaSet.metadata.name,
    uid: replicaSet.metadata.uid,
    resource_version: replicaSet.metadata.resourceVersion,
    generation: replicaSet.metadata.generation,
    replicas: replicaSet.spec.replicas,
    owner,
    selector: replicaSet.spec.selector.matchLabels.app,
    fingerprint: replicaSetFingerprint(replicaSet),
    template_fingerprint: podTemplateFingerprint(replicaSet.spec.template),
    metadata_fingerprint: metadataFingerprint(replicaSet)
  };
}

function validateReplicaSetShape(replicaSet, event) {
  if (
    replicaSet.metadata.deletionTimestamp !== undefined ||
    !Number.isInteger(replicaSet.spec.replicas) || replicaSet.spec.replicas < 0 ||
    !object(replicaSet.spec.selector?.matchLabels) ||
    typeof replicaSet.spec.selector.matchLabels.app !== "string" ||
    !/^[A-Za-z0-9._-]+$/.test(replicaSet.spec.selector.matchLabels.app) ||
    !Array.isArray(replicaSet.spec.selector.matchExpressions || []) ||
    replicaSet.spec.template?.metadata?.labels?.app !==
      replicaSet.spec.selector.matchLabels.app ||
    !object(replicaSet.spec.template?.spec)
  ) fail(event ? "replicaset_event_contract" : "replicaset_inventory");
}

function validateReplicaSetObject(
  replicaSet, namespace, deploymentByUid, expected, event = false,
  allowOmittedTypeMeta = false
) {
  validateReplicaSetEnvelope(
    replicaSet, namespace, event ? "replicaset_event_contract" : "replicaset_inventory",
    allowOmittedTypeMeta
  );
  validateReplicaSetShape(replicaSet, event);
  const identity = replicaSetIdentity(replicaSet);
  const deployment = deploymentByUid.get(identity.owner.uid);
  if (
    !deployment || identity.owner.name !== deployment.name ||
    identity.selector !== deployment.selector ||
    identity.name !== expected.name || identity.uid !== expected.uid ||
    identity.generation !== expected.generation || identity.replicas !== expected.replicas ||
    identity.fingerprint !== expected.fingerprint ||
    identity.template_fingerprint !== expected.template_fingerprint ||
    identity.metadata_fingerprint !== expected.metadata_fingerprint ||
    (WRITER_NAME_SET.has(deployment.name) && identity.replicas !== 0)
  ) fail(event ? "replicaset_drift" : "replicaset_inventory");
  return identity;
}

function exactDefaultServiceAccountProjection(volume) {
  if (
    !exactKeys(volume, ["name", "projected"]) ||
    !/^kube-api-access-[a-z0-9]{5}$/.test(volume.name) ||
    !object(volume.projected) ||
    !Object.keys(volume.projected).every(key => ["defaultMode", "sources"].includes(key)) ||
    ![undefined, 420].includes(volume.projected.defaultMode) ||
    !Array.isArray(volume.projected.sources) || volume.projected.sources.length !== 3
  ) return false;
  let tokens = 0;
  let roots = 0;
  let namespaces = 0;
  for (const source of volume.projected.sources) {
    if (!object(source) || Object.keys(source).length !== 1) return false;
    if (object(source.serviceAccountToken)) {
      const token = source.serviceAccountToken;
      if (
        !Object.keys(token).every(key => ["audience", "expirationSeconds", "path"].includes(key)) ||
        token.path !== "token" || !Number.isInteger(token.expirationSeconds) ||
        token.expirationSeconds < 600 || token.expirationSeconds > 86400 ||
        (token.audience !== undefined && typeof token.audience !== "string")
      ) return false;
      tokens += 1;
    } else if (object(source.configMap)) {
      if (canonicalJson(source.configMap) !== canonicalJson({
        items: [{ key: "ca.crt", path: "ca.crt" }], name: "kube-root-ca.crt"
      })) return false;
      roots += 1;
    } else if (object(source.downwardAPI)) {
      if (canonicalJson(source.downwardAPI) !== canonicalJson({
        items: [{
          fieldRef: { apiVersion: "v1", fieldPath: "metadata.namespace" },
          path: "namespace"
        }]
      })) return false;
      namespaces += 1;
    } else {
      return false;
    }
  }
  return tokens === 1 && roots === 1 && namespaces === 1;
}

function exactDefaultServiceAccountMount(mount, name) {
  return canonicalJson(mount) === canonicalJson({
    mountPath: "/var/run/secrets/kubernetes.io/serviceaccount",
    name,
    readOnly: true
  });
}

function defaultNoExecuteToleration(value) {
  if (!object(value)) return false;
  return ["node.kubernetes.io/not-ready", "node.kubernetes.io/unreachable"].includes(value.key) &&
    canonicalJson(value) === canonicalJson({
      effect: "NoExecute", key: value.key, operator: "Exists", tolerationSeconds: 300
    });
}

function normalizePodSpec(value, ignoreAdmittedImagePullSecrets = false) {
  if (!object(value)) fail("pod_spec_contract");
  const spec = structuredClone(value);
  delete spec.nodeName;
  // Priority admission materializes these two fields on Pods from the
  // allowlisted template's priorityClassName. The ReplicaSet contract still
  // freezes that source field, so ignoring the derived copy is not trust in
  // mutable live state.
  delete spec.priority;
  delete spec.preemptionPolicy;
  // Kubernetes defaults an omitted enableServiceLinks to true on the admitted
  // Pod. Canonicalize the template and the Pod to that exact API default; an
  // explicit false remains distinct and therefore still fails closed.
  if (spec.enableServiceLinks === undefined) spec.enableServiceLinks = true;
  // The ServiceAccount admission plugin may copy imagePullSecrets into the Pod
  // when the PodTemplate omits them. Ignore that copy only for the narrow
  // Template-to-Pod comparison. The complete Pod fingerprint and the separate
  // admission projection below retain it to detect replacement drift.
  if (ignoreAdmittedImagePullSecrets) delete spec.imagePullSecrets;
  const serviceAccountName = spec.serviceAccountName || spec.serviceAccount || "default";
  delete spec.serviceAccount;
  spec.serviceAccountName = serviceAccountName;
  if (Array.isArray(spec.tolerations)) {
    spec.tolerations = spec.tolerations.filter(item => !defaultNoExecuteToleration(item));
    if (spec.tolerations.length === 0) delete spec.tolerations;
  }
  const projected = Array.isArray(spec.volumes)
    ? spec.volumes.filter(exactDefaultServiceAccountProjection)
    : [];
  if (projected.length > 1) fail("pod_service_account_projection");
  if (projected.length === 1) {
    const name = projected[0].name;
    spec.volumes = spec.volumes.filter(volume => volume.name !== name);
    if (spec.volumes.length === 0) delete spec.volumes;
    for (const key of ["initContainers", "containers", "ephemeralContainers"]) {
      if (!Array.isArray(spec[key])) continue;
      for (const container of spec[key]) {
        if (!Array.isArray(container.volumeMounts)) continue;
        container.volumeMounts = container.volumeMounts.filter(mount =>
          !exactDefaultServiceAccountMount(mount, name));
        if (container.volumeMounts.length === 0) delete container.volumeMounts;
      }
    }
  }
  return spec;
}

function podTemplateFingerprint(value) {
  if (!object(value?.metadata) || !object(value?.spec)) fail("pod_template_contract");
  if (
    value.metadata.labels !== undefined && !object(value.metadata.labels) ||
    value.metadata.annotations !== undefined && value.metadata.annotations !== null &&
      !object(value.metadata.annotations)
  ) fail("pod_template_contract");
  return sha256(canonicalJson({
    annotations: value.metadata.annotations || {},
    labels: value.metadata.labels || {},
    spec: normalizePodSpec(value.spec, true)
  }));
}

function podAdmissionFingerprint(pod) {
  const serviceAccountName =
    pod.spec?.serviceAccountName || pod.spec?.serviceAccount || "default";
  const imagePullSecrets = pod.spec?.imagePullSecrets || [];
  if (
    typeof serviceAccountName !== "string" || !serviceAccountName ||
    !Array.isArray(imagePullSecrets) || imagePullSecrets.some(secret =>
      !exactKeys(secret, ["name"]) || typeof secret.name !== "string" || !secret.name
    )
  ) fail("pod_service_account_projection");
  return sha256(canonicalJson({ service_account: serviceAccountName, image_pull_secrets: imagePullSecrets }));
}

function validatePodServiceAccountProjection(
  kubectl, context, namespace, pod, replicaSet
) {
  const imagePullSecrets = pod.spec?.imagePullSecrets || [];
  const templateImagePullSecrets = replicaSet.spec?.template?.spec?.imagePullSecrets || [];
  const serviceAccountName = pod.spec?.serviceAccountName || pod.spec?.serviceAccount || "default";
  if (
    !Array.isArray(imagePullSecrets) || imagePullSecrets.some(secret =>
      !exactKeys(secret, ["name"]) || typeof secret.name !== "string" || !secret.name
    ) ||
    !Array.isArray(templateImagePullSecrets) || templateImagePullSecrets.some(secret =>
      !exactKeys(secret, ["name"]) || typeof secret.name !== "string" || !secret.name
    )
  ) fail("pod_service_account_projection");
  if (canonicalJson(templateImagePullSecrets) === canonicalJson(imagePullSecrets)) return;
  if (templateImagePullSecrets.length !== 0) fail("pod_service_account_projection");
  const serviceAccount = kubectlJson(kubectl, context, [
    "get", "serviceaccount", serviceAccountName, "-n", namespace, "-o", "json"
  ]);
  if (
    serviceAccount.apiVersion !== "v1" || serviceAccount.kind !== "ServiceAccount" ||
    serviceAccount.metadata?.name !== serviceAccountName ||
    serviceAccount.metadata?.namespace !== namespace ||
    typeof serviceAccount.metadata?.uid !== "string" || !serviceAccount.metadata.uid ||
    typeof serviceAccount.metadata?.resourceVersion !== "string" ||
    !serviceAccount.metadata.resourceVersion ||
    serviceAccount.metadata.deletionTimestamp !== undefined ||
    canonicalJson(serviceAccount.imagePullSecrets || []) !== canonicalJson(imagePullSecrets)
  ) fail("pod_service_account_projection");
}

function podObjectFingerprint(pod) {
  return sha256(canonicalJson({
    metadata: {
      annotations: pod.metadata.annotations || {},
      creationTimestamp: pod.metadata.creationTimestamp || null,
      finalizers: pod.metadata.finalizers || [],
      generateName: pod.metadata.generateName || null,
      generation: pod.metadata.generation || null,
      labels: pod.metadata.labels || {},
      ownerReferences: pod.metadata.ownerReferences || []
    },
    spec: normalizePodSpec(pod.spec)
  }));
}

function podObjectFingerprintComponents(pod) {
  const metadata = pod.metadata;
  const values = {
    annotations: canonicalJson(metadata.annotations || {}),
    creation: metadata.creationTimestamp || null,
    finalizers: canonicalJson(metadata.finalizers || []),
    "generate-name": metadata.generateName || null,
    generation: metadata.generation || null,
    labels: canonicalJson(metadata.labels || {}),
    owners: canonicalJson(metadata.ownerReferences || []),
    spec: canonicalJson(normalizePodSpec(pod.spec))
  };
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, sha256(canonicalJson(value))])
  );
}

function validatePodEnvelope(
  pod, namespace, code, allowDeleting = false, allowOmittedTypeMeta = false
) {
  const envelopeFail = suffix => fail(
    code === "pod_event_contract" ? `pod_event_${suffix}` : code
  );
  if (!object(pod) ||
      !exactOrOmittedTypeMeta(pod, "v1", "Pod", allowOmittedTypeMeta)) {
    envelopeFail("gvk");
  }
  if (!object(pod.metadata)) envelopeFail("metadata");
  if (pod.metadata.namespace !== namespace) envelopeFail("namespace");
  if (typeof pod.metadata.name !== "string" || !pod.metadata.name) {
    envelopeFail("name");
  }
  if (typeof pod.metadata.uid !== "string" || !pod.metadata.uid) {
    envelopeFail("uid");
  }
  if (typeof pod.metadata.resourceVersion !== "string" ||
      !pod.metadata.resourceVersion) {
    envelopeFail("resource-version");
  }
  // Kubernetes may materialize an omitted annotations map as JSON null in a
  // typed LIST/WATCH response. Treat only that null as the equivalent omission;
  // labels and any other non-object value remain contract failures.
  if (pod.metadata.labels !== undefined && !object(pod.metadata.labels)) {
    envelopeFail("labels");
  }
  if (pod.metadata.annotations !== undefined && pod.metadata.annotations !== null &&
      !object(pod.metadata.annotations)) {
    envelopeFail("annotations");
  }
  if (!object(pod.spec)) envelopeFail("spec");
  if (!allowDeleting && pod.metadata.deletionTimestamp !== undefined) {
    envelopeFail("deletion");
  }
}

function podIdentity(pod, owner, role = "service") {
  const identity = {
    name: pod.metadata.name,
    uid: pod.metadata.uid,
    resource_version: pod.metadata.resourceVersion,
    role,
    owner,
    fingerprint: podTemplateFingerprint(pod),
    admission_fingerprint: podAdmissionFingerprint(pod),
    object_fingerprint: podObjectFingerprint(pod)
  };
  // Keep diagnostic component hashes process-local and non-enumerable so the
  // published baseline contract remains unchanged and no metadata is written.
  Object.defineProperty(identity, "object_components", {
    value: podObjectFingerprintComponents(pod), enumerable: false
  });
  return identity;
}

function reticulumImage(deployment) {
  const matches = (deployment.spec.template?.spec?.containers || []).filter(container =>
    container?.name === "reticulum" && typeof container.image === "string" && container.image);
  if (matches.length !== 1) fail("reticulum_image_contract");
  return matches[0].image;
}

function storageHelperRole(operationOwner) {
  if (operationOwner === "checkpoint-backup") return "ret-storage-backup";
  if (operationOwner === "checkpoint-restore") return "ret-storage-restore";
  fail("operation_owner");
}

function storageHelperContract(operationId, image, operationOwner) {
  const role = storageHelperRole(operationOwner);
  return { name: `${role}-${operationId.slice(0, 12)}`, image };
}

function validateStorageHelperPod(
  pod, namespace, options, baseline, allowDeleting = false,
  allowOmittedTypeMeta = false
) {
  validatePodEnvelope(
    pod, namespace, "storage_helper_contract", allowDeleting,
    allowOmittedTypeMeta
  );
  const metadata = pod.metadata;
  const spec = pod.spec;
  const containers = spec.containers || [];
  const volumes = spec.volumes || [];
  const container = containers[0];
  const volume = volumes[0];
  const mount = container?.volumeMounts?.[0];
  const pvc = volume?.persistentVolumeClaim;
  const helperRole = storageHelperRole(options.operationOwner);
  const helperReadOnly = options.operationOwner === "checkpoint-backup";
  if (
    metadata.name !== baseline.storage_helper.name ||
    canonicalJson(metadata.labels || {}) !== canonicalJson({
      "yenhubs.org/operation-id": options.operationId,
      "yenhubs.org/recovery-owner": helperRole
    }) ||
    canonicalJson(Object.keys(metadata.annotations || {}).sort()) !== canonicalJson([
      "yenhubs.org/operation-lock-uid", "yenhubs.org/operation-token"
    ]) ||
    metadata.annotations["yenhubs.org/operation-lock-uid"] !== options.lockUid ||
    !/^[a-f0-9]{32}$/.test(metadata.annotations["yenhubs.org/operation-token"]) ||
    ![undefined, null].includes(metadata.ownerReferences) &&
      canonicalJson(metadata.ownerReferences) !== "[]" ||
    spec.automountServiceAccountToken !== false || spec.enableServiceLinks !== false ||
    spec.restartPolicy !== "Never" || spec.activeDeadlineSeconds !== 3600 ||
    (spec.hostNetwork ?? false) !== false || (spec.hostPID ?? false) !== false ||
    (spec.hostIPC ?? false) !== false || (spec.shareProcessNamespace ?? false) !== false ||
    (spec.initContainers || []).length !== 0 || (spec.ephemeralContainers || []).length !== 0 ||
    volumes.length !== 1 || !exactKeys(volume, ["name", "persistentVolumeClaim"]) ||
    volume.name !== "storage" ||
    !object(pvc) ||
    Object.keys(pvc).some(key => !["claimName", "readOnly"].includes(key)) ||
    pvc.claimName !== "ret-pvc" ||
    (pvc.readOnly === undefined ? false : pvc.readOnly) !== helperReadOnly ||
    containers.length !== 1 || container?.name !== "helper" ||
    container.image !== baseline.storage_helper.image ||
    canonicalJson(container.command) !== canonicalJson(["sh", "-c", "sleep 3600"]) ||
    (container.args || []).length !== 0 || (container.env || []).length !== 0 ||
    (container.envFrom || []).length !== 0 || (container.ports || []).length !== 0 ||
    (container.volumeDevices || []).length !== 0 ||
    !Array.isArray(container.volumeMounts) || container.volumeMounts.length !== 1 ||
    mount?.name !== "storage" || mount.mountPath !== "/storage" ||
    (mount.readOnly === undefined ? false : mount.readOnly) !== helperReadOnly ||
    (mount.subPath || "") !== "" || (mount.subPathExpr || "") !== "" ||
    container.lifecycle !== undefined && container.lifecycle !== null &&
      (!object(container.lifecycle) || Object.keys(container.lifecycle).length !== 0) ||
    (container.stdin ?? false) !== false || (container.stdinOnce ?? false) !== false ||
    (container.tty ?? false) !== false ||
    spec.securityContext?.runAsNonRoot !== true || spec.securityContext.runAsUser !== 1000 ||
    spec.securityContext.runAsGroup !== 1000 || spec.securityContext.fsGroup !== 1000 ||
    spec.securityContext.fsGroupChangePolicy !== "OnRootMismatch" ||
    spec.securityContext.seccompProfile?.type !== "RuntimeDefault" ||
    (container.securityContext?.privileged ?? false) !== false ||
    container.securityContext?.allowPrivilegeEscalation !== false ||
    container.securityContext.readOnlyRootFilesystem !== true ||
    canonicalJson([...(container.securityContext.capabilities?.drop || [])].sort()) !==
      canonicalJson(["ALL"]) ||
    (container.securityContext.capabilities?.add || []).length !== 0 ||
    (container.securityContext.procMount || "Default") !== "Default"
  ) fail("storage_helper_contract");
  return podIdentity(pod, null, "storage-helper");
}

function listResource(kubectl, context, namespace, resource, deadline = null) {
  const prefixes = {
    deployments: "/apis/apps/v1",
    replicasets: "/apis/apps/v1",
    pods: "/api/v1"
  };
  const prefix = prefixes[resource];
  if (!prefix) fail(`${resource}_list_contract`);
  const value = kubectlJson(kubectl, context, [
    "get", "--raw", `${prefix}/namespaces/${encodeURIComponent(namespace)}/${resource}`
  ], MAX_LIST_BYTES, deadline);
  const expected = {
    deployments: ["apps/v1", "DeploymentList"],
    replicasets: ["apps/v1", "ReplicaSetList"],
    pods: ["v1", "PodList"]
  }[resource];
  if (
    !expected || value.apiVersion !== expected[0] || value.kind !== expected[1] ||
    typeof value.metadata?.resourceVersion !== "string" ||
    !value.metadata.resourceVersion || !Array.isArray(value.items)
  ) fail(`${resource}_list_contract`);
  return value;
}

function captureBaseline(
  kubectl, context, namespace, namespaceUid, contract, lease,
  runtimeGeneration, recoveryOperationFence, operationOwner, operationLock
) {
  const consumerByName = new Map(contract.consumers.map(consumer => [consumer.name, consumer]));
  const deploymentList = listResource(kubectl, context, namespace, "deployments");
  if (deploymentList.items.length !== DEPLOYMENT_NAMES.length) fail("deployment_inventory");
  const deployments = [];
  const rawDeploymentByName = new Map();
  for (const name of DEPLOYMENT_NAMES) {
    const matches = deploymentList.items.filter(item => item.metadata?.name === name);
    if (matches.length !== 1) fail("deployment_inventory");
    const current = matches[0];
    validateDeploymentEnvelope(current, namespace, "deployment_inventory", true);
    validateDeploymentShape(current, false);
    const identity = deploymentIdentity(current);
    const consumer = consumerByName.get(name) || null;
    if (
      WRITER_NAME_SET.has(name) !== Boolean(consumer) ||
      consumer && (
        identity.uid !== consumer.uid || identity.selector !== consumer.selector ||
        canonicalDeploymentFingerprint(current) !==
          canonicalConsumerFingerprint(consumer.fingerprint) ||
        identity.replicas !== 0
      )
    ) fail("deployment_inventory");
    deployments.push(identity);
    rawDeploymentByName.set(name, current);
  }
  if (deploymentList.items.some(item => !DEPLOYMENT_NAME_SET.has(item.metadata?.name))) {
    fail("deployment_inventory");
  }
  const deploymentByUid = new Map(deployments.map(item => [item.uid, item]));
  if (deploymentByUid.size !== DEPLOYMENT_NAMES.length) fail("deployment_inventory");
  const replicaSetList = listResource(kubectl, context, namespace, "replicasets");
  const replicaSets = [];
  const rawReplicaSetByUid = new Map();
  for (const replicaSet of replicaSetList.items) {
    validateReplicaSetEnvelope(replicaSet, namespace, "replicaset_inventory", true);
    const expectedIdentity = replicaSetIdentity(replicaSet);
    const identity = validateReplicaSetObject(
      replicaSet, namespace, deploymentByUid, expectedIdentity, false, true
    );
    replicaSets.push(identity);
    rawReplicaSetByUid.set(identity.uid, replicaSet);
  }
  const replicaSetOwners = new Set(replicaSets.map(item => item.owner.uid));
  if (
    replicaSets.length === 0 || replicaSetOwners.size !== DEPLOYMENT_NAMES.length ||
    deployments.some(deployment => !replicaSetOwners.has(deployment.uid))
  ) fail("replicaset_inventory");
  const replicaSetByUid = new Map(replicaSets.map(item => [item.uid, item]));
  if (replicaSetByUid.size !== replicaSets.length) fail("replicaset_inventory");
  const podList = listResource(kubectl, context, namespace, "pods");
  const pods = [];
  for (const pod of podList.items) {
    validatePodEnvelope(pod, namespace, "pod_inventory", false, true);
    const owner = controllerOwner(pod, "ReplicaSet");
    const replicaSet = replicaSetByUid.get(owner.uid);
    if (!replicaSet || replicaSet.name !== owner.name) fail("pod_owner_contract");
    const rawReplicaSet = rawReplicaSetByUid.get(owner.uid);
    if (!rawReplicaSet) fail("pod_owner_contract");
    const deployment = deploymentByUid.get(replicaSet.owner.uid);
    if (!deployment || WRITER_NAME_SET.has(deployment.name)) fail("writer_pod_present");
    validatePodServiceAccountProjection(
      kubectl, context, namespace, pod, rawReplicaSet
    );
    const identity = podIdentity(pod, owner);
    if (identity.fingerprint !== replicaSet.template_fingerprint) {
      if (process.env.YENHUBS_WATCH_TEST_DEBUG === "1") {
        process.stderr.write(
          `checkpoint_writer_pod_mismatch:${pod.metadata.name}:${owner.name}:` +
          `${identity.fingerprint}:${replicaSet.template_fingerprint}\n`
        );
      }
      fail("pod_template_drift_baseline");
    }
    pods.push(identity);
  }
  const podNames = new Set(pods.map(item => item.name));
  const podUids = new Set(pods.map(item => item.uid));
  if (podNames.size !== pods.length) fail("pod_inventory_name_duplicate");
  if (podUids.size !== pods.length) fail("pod_inventory_uid_duplicate");
  const reticulum = rawDeploymentByName.get("reticulum");
  return {
    schema_version: 3,
    runtime_generation: runtimeGeneration,
    recovery_operation_fence: recoveryOperationFence,
    operation_id: contract.operation_id,
    operation_owner: operationOwner,
    operation_lock: operationLock,
    context,
    namespace,
    namespace_uid: namespaceUid,
    lease,
    storage_helper: storageHelperContract(
      contract.operation_id, reticulumImage(reticulum), operationOwner
    ),
    consumers: contract.consumers.map(consumer => ({
      name: consumer.name,
      uid: consumer.uid,
      selector: consumer.selector,
      fingerprint: consumer.fingerprint
    })).sort((left, right) => left.name.localeCompare(right.name)),
    deployments: deployments.sort((left, right) => left.name.localeCompare(right.name)),
    replica_sets: replicaSets.sort((left, right) => left.name.localeCompare(right.name)),
    pods: pods.sort((left, right) => left.name.localeCompare(right.name)),
    boundaries: {
      deployments: deploymentList.metadata.resourceVersion,
      replicasets: replicaSetList.metadata.resourceVersion,
      pods: podList.metadata.resourceVersion
    }
  };
}

function validateBaseline(
  text, expectedDigest, context, namespace, namespaceUid, contract,
  runtimeGeneration, operationOwner, operationLock, leaseName
) {
  if (expectedDigest && sha256(text) !== expectedDigest) fail("baseline_digest");
  const baseline = parseJson(text, "baseline_json");
  if (
    !exactKeys(baseline, [
      "schema_version", "namespace", "namespace_uid", "lease", "storage_helper",
      "consumers", "deployments", "replica_sets", "pods", "boundaries",
      "runtime_generation", "recovery_operation_fence", "operation_id",
      "operation_owner", "operation_lock", "context"
    ]) || baseline.schema_version !== 3 || baseline.context !== context ||
    baseline.namespace !== namespace ||
    baseline.namespace_uid !== namespaceUid || !Array.isArray(baseline.consumers) ||
    baseline.operation_id !== contract.operation_id ||
    baseline.operation_owner !== operationOwner ||
    !exactKeys(baseline.operation_lock, ["name", "uid", "resource_version"]) ||
    canonicalJson(baseline.operation_lock) !== canonicalJson(operationLock) ||
    baseline.runtime_generation !== runtimeGeneration ||
    !recoveryOperationFenceBaselineIsExact(
      baseline.recovery_operation_fence, runtimeGeneration, namespace, namespaceUid
    ) ||
    !exactKeys(baseline.lease, [
      "name", "uid", "holder", "acquire_time", "lease_transitions"
    ]) || baseline.lease.name !== leaseName ||
    typeof baseline.lease.uid !== "string" || !baseline.lease.uid ||
    typeof baseline.lease.holder !== "string" ||
    typeof baseline.lease.acquire_time !== "string" ||
    !Number.isFinite(Date.parse(baseline.lease.acquire_time)) ||
    !Number.isInteger(baseline.lease.lease_transitions) ||
    baseline.lease.lease_transitions < 0 ||
    !exactKeys(baseline.storage_helper, ["name", "image"]) ||
    baseline.storage_helper.name !== storageHelperContract(
      contract.operation_id, baseline.storage_helper.image, operationOwner
    ).name ||
    typeof baseline.storage_helper.image !== "string" || !baseline.storage_helper.image ||
    !Array.isArray(baseline.deployments) ||
    baseline.deployments.length !== DEPLOYMENT_NAMES.length ||
    !Array.isArray(baseline.replica_sets) || baseline.replica_sets.length === 0 ||
    !Array.isArray(baseline.pods) ||
    !exactKeys(baseline.boundaries, ["deployments", "replicasets", "pods"])
  ) fail("baseline_contract");
  const expectedConsumers = contract.consumers.map(consumer => ({
    name: consumer.name, uid: consumer.uid, selector: consumer.selector,
    fingerprint: consumer.fingerprint
  })).sort((left, right) => left.name.localeCompare(right.name));
  if (JSON.stringify(baseline.consumers) !== JSON.stringify(expectedConsumers)) {
    fail("baseline_contract");
  }
  const expectedConsumerByName = new Map(
    expectedConsumers.map(consumer => [consumer.name, consumer])
  );
  for (const key of ["deployments", "replicasets", "pods"]) {
    if (typeof baseline.boundaries[key] !== "string" || !baseline.boundaries[key]) {
      fail("baseline_contract");
    }
  }
  const names = new Set();
  const deploymentUids = new Set();
  for (const deployment of baseline.deployments) {
    const expectedConsumer = expectedConsumerByName.get(deployment.name);
    if (
      !exactKeys(deployment, [
        "name", "uid", "resource_version", "generation", "replicas", "selector",
        "fingerprint", "spec_fingerprint", "metadata_fingerprint"
      ]) || names.has(deployment.name) || typeof deployment.uid !== "string" ||
      !deployment.uid || typeof deployment.resource_version !== "string" ||
      !deployment.resource_version || !Number.isInteger(deployment.generation) ||
      deployment.generation < 1 || !Number.isInteger(deployment.replicas) ||
      deployment.replicas < 0 || typeof deployment.selector !== "string" ||
      typeof deployment.fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(deployment.spec_fingerprint) ||
      !/^[a-f0-9]{64}$/.test(deployment.metadata_fingerprint) ||
      !DEPLOYMENT_NAME_SET.has(deployment.name) ||
      WRITER_NAME_SET.has(deployment.name) !== Boolean(expectedConsumer) ||
      expectedConsumer && (
        deployment.uid !== expectedConsumer.uid ||
        deployment.selector !== expectedConsumer.selector ||
        canonicalConsumerFingerprint(deployment.fingerprint, "baseline_contract") !==
          canonicalConsumerFingerprint(expectedConsumer.fingerprint, "baseline_contract") ||
        deployment.replicas !== 0
      ) ||
      deploymentUids.has(deployment.uid)
    ) fail("baseline_contract");
    names.add(deployment.name);
    deploymentUids.add(deployment.uid);
  }
  if (
    names.size !== DEPLOYMENT_NAMES.length ||
    baseline.deployments.map(item => item.name).join("\n") !==
      DEPLOYMENT_NAMES.join("\n")
  ) fail("baseline_contract");
  const deploymentByUid = new Map(baseline.deployments.map(item => [item.uid, item]));
  const rsNames = new Set();
  const rsUids = new Set();
  const rsOwners = new Set();
  for (const replicaSet of baseline.replica_sets) {
    const deployment = deploymentByUid.get(replicaSet.owner?.uid);
    if (
      !exactKeys(replicaSet, [
        "name", "uid", "resource_version", "generation", "replicas", "owner", "selector",
        "fingerprint", "template_fingerprint", "metadata_fingerprint"
      ]) || rsNames.has(replicaSet.name) || typeof replicaSet.uid !== "string" ||
      !replicaSet.uid || typeof replicaSet.resource_version !== "string" ||
      !replicaSet.resource_version || !Number.isInteger(replicaSet.generation) ||
      replicaSet.generation < 1 || !Number.isInteger(replicaSet.replicas) ||
      replicaSet.replicas < 0 || !exactKeys(replicaSet.owner, ["name", "uid"]) ||
      typeof replicaSet.selector !== "string" || typeof replicaSet.fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(replicaSet.fingerprint) ||
      !/^[a-f0-9]{64}$/.test(replicaSet.template_fingerprint) ||
      !/^[a-f0-9]{64}$/.test(replicaSet.metadata_fingerprint) || !deployment ||
      replicaSet.owner.name !== deployment.name ||
      replicaSet.selector !== deployment.selector ||
      WRITER_NAME_SET.has(deployment.name) && replicaSet.replicas !== 0 ||
      rsUids.has(replicaSet.uid)
    ) fail("baseline_contract");
    rsNames.add(replicaSet.name);
    rsUids.add(replicaSet.uid);
    rsOwners.add(replicaSet.owner.uid);
  }
  if (
    rsOwners.size !== DEPLOYMENT_NAMES.length ||
    baseline.deployments.some(deployment => !rsOwners.has(deployment.uid)) ||
    baseline.replica_sets.map(item => item.name).join("\n") !==
      [...baseline.replica_sets].map(item => item.name).sort().join("\n")
  ) fail("baseline_contract");
  const replicaSetByUid = new Map(baseline.replica_sets.map(item => [item.uid, item]));
  const podNames = new Set();
  const podUids = new Set();
  for (const pod of baseline.pods) {
    const replicaSet = replicaSetByUid.get(pod.owner?.uid);
    const deployment = replicaSet && deploymentByUid.get(replicaSet.owner.uid);
    if (
      !exactKeys(pod, [
        "name", "uid", "resource_version", "role", "owner", "fingerprint",
        "admission_fingerprint", "object_fingerprint"
      ]) || pod.role !== "service" || !exactKeys(pod.owner, ["name", "uid"]) ||
      typeof pod.name !== "string" || !pod.name || podNames.has(pod.name) ||
      typeof pod.uid !== "string" || !pod.uid || podUids.has(pod.uid) ||
      typeof pod.resource_version !== "string" || !pod.resource_version ||
      !/^[a-f0-9]{64}$/.test(pod.fingerprint) ||
      !/^[a-f0-9]{64}$/.test(pod.admission_fingerprint) ||
      !/^[a-f0-9]{64}$/.test(pod.object_fingerprint) || !replicaSet || !deployment ||
      replicaSet.name !== pod.owner.name || WRITER_NAME_SET.has(deployment.name) ||
      pod.fingerprint !== replicaSet.template_fingerprint
    ) fail("baseline_contract");
    podNames.add(pod.name);
    podUids.add(pod.uid);
  }
  if (
    baseline.pods.map(item => item.name).join("\n") !==
      [...baseline.pods].map(item => item.name).sort().join("\n")
  ) fail("baseline_contract");
  return baseline;
}

function baselineMaps(baseline) {
  const deploymentByUid = new Map(baseline.deployments.map(item => [item.uid, item]));
  const replicaSetByUid = new Map(baseline.replica_sets.map(item => [item.uid, item]));
  const podAdmissionByReplicaSetUid = new Map();
  for (const pod of baseline.pods) {
    const current = podAdmissionByReplicaSetUid.get(pod.owner.uid);
    if (current && current !== pod.admission_fingerprint) fail("baseline_contract");
    podAdmissionByReplicaSetUid.set(pod.owner.uid, pod.admission_fingerprint);
  }
  return {
    consumerByName: new Map(baseline.consumers.map(item => [item.name, item])),
    deploymentByName: new Map(baseline.deployments.map(item => [item.name, item])),
    deploymentByUid,
    replicaSetByName: new Map(baseline.replica_sets.map(item => [item.name, item])),
    replicaSetByUid,
    podAdmissionByReplicaSetUid
  };
}

function validateListedPod(
  pod, namespace, options, baseline, maps, allowDeleting = false
) {
  validatePodEnvelope(pod, namespace, "pod_inventory", allowDeleting, true);
  if (pod.metadata.name === baseline.storage_helper.name) {
    return validateStorageHelperPod(
      pod, namespace, options, baseline, allowDeleting, true
    );
  }
  const owner = controllerOwner(pod, "ReplicaSet");
  const replicaSet = maps.replicaSetByUid.get(owner.uid);
  const deployment = replicaSet && maps.deploymentByUid.get(replicaSet.owner.uid);
  if (
    !replicaSet || replicaSet.name !== owner.name || !deployment ||
    WRITER_NAME_SET.has(deployment.name)
  ) fail("pod_owner_contract");
  const identity = podIdentity(pod, owner);
  if (
    identity.fingerprint !== replicaSet.template_fingerprint ||
    identity.admission_fingerprint !== maps.podAdmissionByReplicaSetUid.get(replicaSet.uid)
  ) {
    fail("pod_template_drift_list");
  }
  return identity;
}

function validateCurrentLists(
  kubectl, context, namespace, options, baseline, deadline = null
) {
  const maps = baselineMaps(baseline);
  const deploymentList = listResource(
    kubectl, context, namespace, "deployments", deadline
  );
  if (deploymentList.items.length !== DEPLOYMENT_NAMES.length) fail("deployment_inventory");
  const writerDeployments = [];
  for (const expected of baseline.deployments) {
    const matches = deploymentList.items.filter(item => item.metadata?.name === expected.name);
    if (matches.length !== 1) fail("deployment_inventory");
    const identity = validateDeploymentObject(
      matches[0], namespace, expected,
      maps.consumerByName.get(expected.name) || null, false, true
    );
    if (WRITER_NAME_SET.has(expected.name)) {
      writerDeployments.push({
        name: identity.name, uid: identity.uid, resource_version: identity.resource_version
      });
    }
  }
  const reticulumMatches = deploymentList.items.filter(item => item.metadata?.name === "reticulum");
  if (
    reticulumMatches.length !== 1 ||
    reticulumImage(reticulumMatches[0]) !== baseline.storage_helper.image
  ) fail("reticulum_image_contract");
  const replicaSetList = listResource(
    kubectl, context, namespace, "replicasets", deadline
  );
  if (replicaSetList.items.length !== baseline.replica_sets.length) {
    fail("replicaset_inventory");
  }
  const seen = new Set();
  const replicaSetIdentities = [];
  for (const replicaSet of replicaSetList.items) {
    validateReplicaSetEnvelope(replicaSet, namespace, "replicaset_inventory", true);
    const expected = maps.replicaSetByName.get(replicaSet.metadata?.name);
    if (!expected) fail("replicaset_added");
    const identity = validateReplicaSetObject(
      replicaSet, namespace, maps.deploymentByUid, expected, false, true
    );
    replicaSetIdentities.push(identity);
    seen.add(expected.name);
  }
  if (seen.size !== baseline.replica_sets.length) fail("replicaset_missing");
  const podList = listResource(kubectl, context, namespace, "pods", deadline);
  const podNames = new Set();
  const podUids = new Set();
  const podIdentities = [];
  for (const pod of podList.items) {
    const allowDeleting = pod.metadata?.name === baseline.storage_helper.name;
    const identity = validateListedPod(
      pod, namespace, options, baseline, maps, allowDeleting
    );
    if (podNames.has(identity.name)) fail("pod_inventory_name_duplicate");
    if (podUids.has(identity.uid)) fail("pod_inventory_uid_duplicate");
    podNames.add(identity.name);
    podUids.add(identity.uid);
    podIdentities.push(identity);
  }
  return {
    boundaries: {
      deployments: deploymentList.metadata.resourceVersion,
      replicasets: replicaSetList.metadata.resourceVersion,
      pods: podList.metadata.resourceVersion
    },
    writer_deployments: writerDeployments.sort((left, right) => left.name.localeCompare(right.name)),
    replica_sets: replicaSetIdentities.sort((left, right) => left.name.localeCompare(right.name)),
    pods: podIdentities.sort((left, right) => left.name.localeCompare(right.name))
  };
}

function reconcileRuntimeState(state, current) {
  const activeNames = new Set();
  for (const pod of current.pods || []) {
    activeNames.add(pod.name);
    state.podByName.set(pod.name, pod);
    state.podHistoryByUid.set(pod.uid, pod);
  }
  for (const name of state.podByName.keys()) {
    if (!activeNames.has(name)) state.podByName.delete(name);
  }
}

function validateReceiptCurrentLists(
  kubectl, context, namespace, options, baseline, handoff, deadline = null
) {
  const maps = baselineMaps(baseline);
  const deploymentList = listResource(
    kubectl, context, namespace, "deployments", deadline
  );
  if (deploymentList.items.length !== DEPLOYMENT_NAMES.length) {
    fail("deployment_inventory");
  }
  const writerDeployments = [];
  let targetIdentity = null;
  for (const expected of baseline.deployments) {
    const matches = deploymentList.items.filter(item => item.metadata?.name === expected.name);
    if (matches.length !== 1) fail("deployment_inventory");
    const identity = expected.name === handoff.target.name
      ? validateReceiptDeploymentObject(
          matches[0], namespace, expected, maps.consumerByName.get(expected.name),
          options.operationId, false, true
        )
      : validateDeploymentObject(
          matches[0], namespace, expected,
          maps.consumerByName.get(expected.name) || null, false, true
        );
    if (expected.name === handoff.target.name) targetIdentity = identity;
    if (WRITER_NAME_SET.has(expected.name)) {
      writerDeployments.push({
        name: identity.name, uid: identity.uid, resource_version: identity.resource_version
      });
    }
  }
  const reticulumMatches = deploymentList.items.filter(
    item => item.metadata?.name === "reticulum"
  );
  if (
    reticulumMatches.length !== 1 ||
    reticulumImage(reticulumMatches[0]) !== baseline.storage_helper.image
  ) fail("reticulum_image_contract");
  const replicaSetList = listResource(
    kubectl, context, namespace, "replicasets", deadline
  );
  if (replicaSetList.items.length !== baseline.replica_sets.length) {
    fail("replicaset_inventory");
  }
  const seen = new Set();
  for (const replicaSet of replicaSetList.items) {
    validateReplicaSetEnvelope(replicaSet, namespace, "replicaset_inventory", true);
    const expected = maps.replicaSetByName.get(replicaSet.metadata?.name);
    if (!expected) fail("replicaset_added");
    validateReplicaSetObject(
      replicaSet, namespace, maps.deploymentByUid, expected, false, true
    );
    seen.add(expected.name);
  }
  if (seen.size !== baseline.replica_sets.length) fail("replicaset_missing");
  const podList = listResource(kubectl, context, namespace, "pods", deadline);
  const podNames = new Set();
  const podUids = new Set();
  for (const pod of podList.items) {
    const allowDeleting = pod.metadata?.name === baseline.storage_helper.name;
    const identity = validateListedPod(
      pod, namespace, options, baseline, maps, allowDeleting
    );
    if (podNames.has(identity.name)) fail("pod_inventory_name_duplicate");
    if (podUids.has(identity.uid)) fail("pod_inventory_uid_duplicate");
    podNames.add(identity.name);
    podUids.add(identity.uid);
  }
  if (!targetIdentity) fail("receipt_target_missing");
  return {
    boundaries: {
      deployments: deploymentList.metadata.resourceVersion,
      replicasets: replicaSetList.metadata.resourceVersion,
      pods: podList.metadata.resourceVersion
    },
    writer_deployments: writerDeployments.sort(
      (left, right) => left.name.localeCompare(right.name)
    ),
    target: targetIdentity
  };
}

function runtimeState(baseline) {
  const podByName = new Map();
  const podHistoryByUid = new Map();
  for (const pod of baseline.pods) {
    const copy = { ...pod };
    if (pod.object_components) {
      Object.defineProperty(copy, "object_components", {
        value: pod.object_components, enumerable: false
      });
    }
    podByName.set(pod.name, copy);
    podHistoryByUid.set(pod.uid, copy);
  }
  return { podByName, podHistoryByUid };
}

function samePodIdentity(actual, expected, allowTerminationMetadataDrift = false) {
  const coreIdentityMatches = actual.name === expected.name && actual.uid === expected.uid &&
    actual.role === expected.role && canonicalJson(actual.owner) === canonicalJson(expected.owner) &&
    actual.fingerprint === expected.fingerprint &&
    actual.admission_fingerprint === expected.admission_fingerprint;
  if (!coreIdentityMatches) return false;
  if (actual.object_fingerprint === expected.object_fingerprint) return true;
  if (!allowTerminationMetadataDrift) return false;
  const actualComponents = actual.object_components || {};
  const expectedComponents = expected.object_components || {};
  return [
    "annotations", "creation", "generate-name", "labels", "owners", "spec"
  ].every(component => actualComponents[component] === expectedComponents[component]);
}

function failPodIdentityDrift(actual, expected, prefix) {
  if (actual.name !== expected.name) fail(`${prefix}_name`);
  if (actual.uid !== expected.uid) fail(`${prefix}_uid`);
  if (actual.role !== expected.role) fail(`${prefix}_role`);
  if (canonicalJson(actual.owner) !== canonicalJson(expected.owner)) {
    fail(`${prefix}_owner`);
  }
  if (actual.fingerprint !== expected.fingerprint) {
    fail(`${prefix}_fingerprint`);
  }
  if (actual.admission_fingerprint !== expected.admission_fingerprint) {
    fail(`${prefix}_admission`);
  }
  if (actual.object_fingerprint !== expected.object_fingerprint) {
    const actualComponents = actual.object_components || {};
    const expectedComponents = expected.object_components || {};
    const differingComponents = [];
    for (const component of [
      "annotations", "creation", "finalizers", "generate-name", "generation",
      "labels", "owners", "spec"
    ]) {
      if (actualComponents[component] !== expectedComponents[component]) {
        differingComponents.push(component);
      }
    }
    if (differingComponents.length === 1) {
      fail(`pod_event_drift_object_${differingComponents[0]}`);
    }
    if (differingComponents.includes("finalizers")) {
      const nonFinalizerComponents = differingComponents.filter(component => component !== "finalizers");
      if (nonFinalizerComponents.length === 1) {
        fail(`pod_event_drift_object_finalizers_${nonFinalizerComponents[0]}`);
      }
      fail("pod_event_drift_object_finalizers_multiple");
    }
    if (differingComponents.length > 1) fail("pod_event_drift_object_multiple");
    fail(`${prefix}_object`);
  }
  fail(prefix);
}

function validatePodEvent(event, namespace, options, baseline, maps, state) {
  const helperEvent = event.object?.metadata?.name === baseline.storage_helper.name;
  // Kubernetes emits a MODIFIED event carrying deletionTimestamp before the
  // terminal DELETED event. Permit that transition only for the exact owned
  // storage helper; ordinary application Pods remain strict fail-closed.
  const allowDeleting = event.type === "DELETED" ||
    (helperEvent && event.type === "MODIFIED");
  // The Kubernetes API can omit the object's GVK in a typed Pod watch event,
  // just as it does for items in a typed PodList. The watch resource itself is
  // already bound to /api/v1/.../pods, so accepting only this exact omission
  // preserves the resource type while avoiding a false contract failure.
  validatePodEnvelope(
    event.object, namespace, "pod_event_contract", allowDeleting, true
  );
  const pod = event.object;
  let identity;
  if (helperEvent) {
    identity = validateStorageHelperPod(
      pod, namespace, options, baseline, allowDeleting, true
    );
  } else {
    const owner = controllerOwner(pod, "ReplicaSet");
    const replicaSet = maps.replicaSetByUid.get(owner.uid);
    const deployment = replicaSet && maps.deploymentByUid.get(replicaSet.owner.uid);
    if (
      !replicaSet || replicaSet.name !== owner.name || !deployment ||
      WRITER_NAME_SET.has(deployment.name)
    ) fail("writer_pod_event");
    identity = podIdentity(pod, owner);
    if (
      identity.fingerprint !== replicaSet.template_fingerprint ||
      identity.admission_fingerprint !== maps.podAdmissionByReplicaSetUid.get(replicaSet.uid)
    ) {
      fail("pod_template_drift_event");
    }
  }
  const active = state.podByName.get(identity.name);
  const historical = state.podHistoryByUid.get(identity.uid);
  const allowTerminationMetadataDrift = event.type === "DELETED" ||
    (helperEvent && event.type === "MODIFIED");
  if (event.type === "ADDED") {
    if (historical) {
      if (!samePodIdentity(identity, historical)) {
        failPodIdentityDrift(identity, historical, "pod_event_drift");
      }
      if (active && !samePodIdentity(identity, active)) fail("pod_name_collision");
      return;
    }
    if (active || [...state.podHistoryByUid.values()].some(item => item.uid === identity.uid)) {
      fail("pod_name_collision");
    }
    state.podByName.set(identity.name, identity);
    state.podHistoryByUid.set(identity.uid, identity);
  } else if (event.type === "MODIFIED") {
    if (!historical) fail("pod_event_drift_history_missing");
    if (!samePodIdentity(identity, historical, allowTerminationMetadataDrift)) {
      failPodIdentityDrift(identity, historical, "pod_event_drift");
    }
    if (active && !samePodIdentity(identity, active, allowTerminationMetadataDrift)) {
      failPodIdentityDrift(identity, active, "pod_event_drift_active");
    }
    if (active) state.podByName.set(identity.name, identity);
    state.podHistoryByUid.set(identity.uid, identity);
  } else {
    if (!historical) fail("pod_event_drift_history_missing");
    if (!samePodIdentity(identity, historical, allowTerminationMetadataDrift)) {
      failPodIdentityDrift(identity, historical, "pod_event_drift_deleted");
    }
    if (active?.uid === identity.uid) state.podByName.delete(identity.name);
  }
}

function validateEvent(resource, event, namespace, options, baseline, state) {
  if (!object(event) || typeof event.type !== "string" || !object(event.object)) {
    fail("watch_event_contract");
  }
  if (event.type === "ERROR") fail("watch_error_event");
  if (event.type === "BOOKMARK") {
    const resourceVersion = event.object?.metadata?.resourceVersion;
    if (typeof resourceVersion !== "string" || !resourceVersion) {
      fail("watch_bookmark_contract");
    }
    return resourceVersion;
  }
  if (!new Set(["ADDED", "MODIFIED", "DELETED"]).has(event.type)) {
    fail("watch_event_type");
  }
  const eventVersion = event.object.metadata?.resourceVersion;
  if (typeof eventVersion !== "string" || !eventVersion) fail("watch_resource_version");
  const maps = baselineMaps(baseline);
  if (resource === "deployments") {
    validateDeploymentEnvelope(event.object, namespace, "deployment_event_contract");
    const expected = maps.deploymentByName.get(event.object.metadata?.name);
    if (!expected || event.type !== "MODIFIED") fail("deployment_event");
    validateDeploymentObject(
      event.object, namespace, expected, maps.consumerByName.get(expected.name) || null, true
    );
  } else if (resource === "replicasets") {
    validateReplicaSetEnvelope(event.object, namespace, "replicaset_event_contract");
    const expected = maps.replicaSetByName.get(event.object.metadata?.name);
    if (!expected || event.type !== "MODIFIED") fail("replicaset_event");
    validateReplicaSetObject(event.object, namespace, maps.deploymentByUid, expected, true);
  } else if (resource === "pods") {
    validatePodEvent(event, namespace, options, baseline, maps, state);
  } else {
    fail("watch_resource");
  }
  return eventVersion;
}

function validateReceiptDeploymentObject(
  deployment, namespace, expected, consumer, operationId, event = false,
  allowOmittedTypeMeta = false
) {
  validateDeploymentEnvelope(
    deployment, namespace, event ? "deployment_event_contract" : "deployment_inventory",
    allowOmittedTypeMeta
  );
  validateDeploymentShape(deployment, event);
  const identity = deploymentIdentity(deployment);
  const annotation = deployment.metadata.annotations?.[
    "yenhubs.org/checkpoint-resume-operation"
  ];
  const normalized = structuredClone(deployment);
  if (annotation !== operationId) fail("receipt_metadata_contract");
  delete normalized.metadata.annotations["yenhubs.org/checkpoint-resume-operation"];
  if (Object.keys(normalized.metadata.annotations).length === 0) {
    delete normalized.metadata.annotations;
  }
  if (
    identity.name !== expected.name || identity.uid !== expected.uid ||
    identity.generation !== expected.generation || identity.replicas !== 0 ||
    identity.selector !== expected.selector || identity.fingerprint !== expected.fingerprint ||
    identity.spec_fingerprint !== expected.spec_fingerprint ||
    metadataFingerprint(normalized) !== expected.metadata_fingerprint ||
    !consumer || identity.uid !== consumer.uid ||
    identity.selector !== consumer.selector ||
    canonicalDeploymentFingerprint(deployment) !==
      canonicalConsumerFingerprint(consumer.fingerprint)
  ) fail(event ? "receipt_deployment_drift" : "receipt_deployment_inventory");
  return identity;
}

function validateReceiptArmTarget(options, handoff) {
  const deployment = kubectlJson(options.kubectl, options.context, [
    "get", "deployment", handoff.target.name, "-n", options.namespace, "-o", "json"
  ]);
  const maps = baselineMaps(options.baseline);
  const expected = maps.deploymentByName.get(handoff.target.name);
  const consumer = maps.consumerByName.get(handoff.target.name);
  validateDeploymentObject(deployment, options.namespace, expected, consumer);
  if (
    Object.prototype.hasOwnProperty.call(
      deployment.metadata.annotations || {},
      "yenhubs.org/checkpoint-resume-operation"
    )
  ) fail("receipt_already_present");
  return deploymentIdentity(deployment);
}

function validateReceiptEvent(resource, event, namespace, options, baseline, state) {
  const handoff = options.receiptHandoff;
  if (!object(event) || typeof event.type !== "string" || !object(event.object)) {
    fail("watch_event_contract");
  }
  if (event.type === "ERROR") fail("watch_error_event");
  if (event.type === "BOOKMARK") {
    const resourceVersion = event.object?.metadata?.resourceVersion;
    if (typeof resourceVersion !== "string" || !resourceVersion) {
      fail("watch_bookmark_contract");
    }
    return resourceVersion;
  }
  if (!new Set(["ADDED", "MODIFIED", "DELETED"]).has(event.type)) {
    fail("watch_event_type");
  }
  const eventVersion = event.object.metadata?.resourceVersion;
  if (typeof eventVersion !== "string" || !eventVersion) fail("watch_resource_version");
  const maps = baselineMaps(baseline);
  if (
    resource === "deployments" &&
    event.object.metadata?.name === handoff.target.name
  ) {
    if (event.type !== "MODIFIED") fail("receipt_event_not_armed");
    const receiptValue = event.object.metadata.annotations?.[
      "yenhubs.org/checkpoint-resume-operation"
    ];
    if (!handoff.armed) {
      if (receiptValue !== undefined) fail("receipt_event_not_armed");
      validateDeploymentObject(
        event.object, namespace, handoff.target,
        maps.consumerByName.get(handoff.target.name), true
      );
      return eventVersion;
    }
    if (receiptValue === undefined && handoff.observedPatchResourceVersion === null) {
      // Status-only updates before the metadata CAS are benign, but they do
      // not advance the armed mutation authority held by the root. Its exact
      // PATCH will conflict and fail closed if it used an older armed RV.
      validateDeploymentObject(
        event.object, namespace, handoff.target,
        maps.consumerByName.get(handoff.target.name), true
      );
    } else {
      validateReceiptDeploymentObject(
        event.object, namespace, handoff.target,
        maps.consumerByName.get(handoff.target.name), options.operationId, true
      );
      if (handoff.observedPatchResourceVersion === null) {
        handoff.observedPatchResourceVersion = eventVersion;
      } else if (eventVersion !== handoff.observedPatchResourceVersion) {
        // Exactly one metadata transition is authorized. A later target RV,
        // even status-only, makes the handoff ambiguous and suppresses ACK.
        fail("receipt_event_ambiguous");
      }
      if (
        handoff.commitPatchResourceVersion !== null &&
        handoff.observedPatchResourceVersion !== handoff.commitPatchResourceVersion
      ) fail("receipt_event_resource_version");
    }
  } else {
    // ReplicaSets and Pods remain under the original strict-zero validator.
    // A metadata-only Deployment receipt has no legitimate descendants.
    return validateEvent(resource, event, namespace, options, baseline, state);
  }
  return eventVersion;
}

async function startWatchSession(options) {
  const { kubectl, context, namespace, resource, resourceVersion, baseline, state,
    timeoutSeconds = WATCH_TIMEOUT_SECONDS,
    allowFixtureImmediateBookmark = true } = options;
  const paths = {
    deployments: "/apis/apps/v1",
    replicasets: "/apis/apps/v1",
    pods: "/api/v1"
  };
  const query = new URLSearchParams({
    allowWatchBookmarks: "true", resourceVersion,
    timeoutSeconds: String(timeoutSeconds), watch: "true"
  });
  const rawPath = `${paths[resource]}/namespaces/${encodeURIComponent(namespace)}/` +
    `${resource}?${query.toString()}`;
  const requestTimeoutSeconds = Math.max(45, timeoutSeconds + 10);
  const child = spawn(kubectl, [
    "--context", context, `--request-timeout=${requestTimeoutSeconds}s`,
    "get", "--raw", rawPath
  ], { stdio: ["ignore", "pipe", "ignore"] });
  const startedAt = performance.now();
  let buffer = "";
  let latestVersion = resourceVersion;
  let streamError = null;
  let sawBookmark = false;
  let closeObserved = false;
  let watchdog = null;
  let finalPromise = null;
  const spawned = new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const closed = new Promise(resolve => {
    child.once("close", (code, signal) => {
      closeObserved = true;
      activeChildren.delete(child);
      if (watchdog !== null) clearTimeout(watchdog);
      resolve({ code, signal });
    });
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
        const event = parseJson(line, "watch_event_json");
        if (event.type === "BOOKMARK") sawBookmark = true;
        latestVersion = options.receiptHandoff
          ? validateReceiptEvent(resource, event, namespace, options, baseline, state)
          : validateEvent(resource, event, namespace, options, baseline, state);
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
  if (!closeObserved) {
    watchdog = setTimeout(() => child.kill("SIGKILL"), (timeoutSeconds + 8) * 1000);
  }

  const finish = ({ intentionalStop = false } = {}) => {
    if (finalPromise) return finalPromise;
    finalPromise = (async () => {
      let stopSent = false;
      if (intentionalStop) {
        await new Promise(resolve => setImmediate(resolve));
        if (!closeObserved && !streamError) {
          stopSent = child.kill("SIGTERM");
          if (!stopSent) await new Promise(resolve => setImmediate(resolve));
        }
      }
      const exit = await closed;
      if (buffer.trim() && !streamError) {
        try {
          const event = parseJson(buffer, "watch_event_json");
          if (event.type === "BOOKMARK") sawBookmark = true;
          latestVersion = options.receiptHandoff
            ? validateReceiptEvent(resource, event, namespace, options, baseline, state)
            : validateEvent(resource, event, namespace, options, baseline, state);
        } catch (error) {
          streamError = error;
        }
      }
      if (streamError) throw streamError;
      const fixtureImmediateBookmark = allowFixtureImmediateBookmark &&
        process.env.YENHUBS_RECOVERY_TEST_MODE === "local-fixture" &&
        context === "fixture-context" && sawBookmark;
      const watchResult = () => options.reportWatchFreshness
        ? { resourceVersion: latestVersion, needsRefresh: !sawBookmark }
        : latestVersion;
      if (stopSent) {
        if (exit.signal !== "SIGTERM") fail("watch_stop_contract");
        return watchResult();
      }
      if (intentionalStop) {
        if (!fixtureImmediateBookmark) fail("watch_not_live");
        return watchResult();
      }
      if (exit.code !== 0 || exit.signal) fail("watch_terminated");
      if (
        performance.now() - startedAt < timeoutSeconds * 750 &&
        !fixtureImmediateBookmark
      ) fail("watch_closed");
      return watchResult();
    })();
    return finalPromise;
  };

  const assertOpen = async () => {
    await new Promise(resolve => setImmediate(resolve));
    if (streamError || closeObserved) {
      await finish();
      const fixtureImmediateBookmark = allowFixtureImmediateBookmark &&
        process.env.YENHUBS_RECOVERY_TEST_MODE === "local-fixture" &&
        context === "fixture-context" && sawBookmark;
      if (!fixtureImmediateBookmark) fail("watch_not_live");
      return false;
    }
    return true;
  };

  const abort = async () => {
    if (!closeObserved) child.kill("SIGTERM");
    const killTimer = setTimeout(() => {
      if (!closeObserved) child.kill("SIGKILL");
    }, 1000);
    try { await closed; } catch {}
    clearTimeout(killTimer);
  };

  return { abort, assertOpen, finish };
}

async function watchOnce(options) {
  const session = await startWatchSession(options);
  return session.finish();
}

function validateHandoffBinding(value, options, authoritySha256) {
  if (
    !exactKeys(value.operation, ["id", "owner"]) ||
    value.operation.id !== options.operationId ||
    value.operation.owner !== "checkpoint-restore" ||
    value.operation.owner !== options.operationOwner ||
    !exactKeys(value.operation_lock, ["name", "resource_version", "uid"]) ||
    value.operation_lock.name !== options.lockName ||
    value.operation_lock.uid !== options.lockUid ||
    value.operation_lock.resource_version !== options.lockResourceVersion ||
    !exactKeys(value.lease, ["holder", "name", "uid"]) ||
    value.lease.name !== options.leaseName || value.lease.uid !== options.leaseUid ||
    value.lease.holder !== options.leaseHolder ||
    value.monitor_authority_sha256 !== authoritySha256 ||
    !/^[a-f0-9]{32}$/.test(value.token) ||
    !exactKeys(value.target, ["name", "uid"]) || value.target.name !== "reticulum" ||
    !exactKeys(value.receipt, [
      "annotation", "mode", "patch_response_resource_version", "value"
    ]) ||
    value.receipt.annotation !== "yenhubs.org/checkpoint-resume-operation" ||
    value.receipt.value !== options.operationId ||
    value.receipt.mode !== "create" ||
    (value.receipt.patch_response_resource_version !== null &&
      typeof value.receipt.patch_response_resource_version !== "string")
  ) fail("handoff_binding");
  const target = options.baseline?.deployments.find(item => item.name === value.target.name);
  if (
    options.runtimeGeneration !== "legacy-absent" || !target ||
    value.target.uid !== target.uid || target.replicas !== 0
  ) fail("handoff_binding");
  return target;
}

function stopRequest(markerPath, options = null, authoritySha256 = null) {
  const value = readRegular(markerPath, 2048);
  if (value === "") return null;
  if (value === "discard\n") return { discard: true };
  const parsed = parseJson(value, "stop_json");
  if (parsed?.handoff === "receipt-arm") {
    if (
      !options || !authoritySha256 ||
      !exactKeys(parsed, [
        "boundaries", "handoff", "lease", "monitor_authority_sha256",
        "operation", "operation_lock", "receipt", "target", "token"
      ]) ||
      !exactKeys(parsed.boundaries, ["deployments", "pods", "replicasets"])
    ) fail("handoff_arm_contract");
    for (const key of ["deployments", "replicasets", "pods"]) {
      if (typeof parsed.boundaries[key] !== "string" || !parsed.boundaries[key]) {
        fail("handoff_arm_contract");
      }
    }
    const target = validateHandoffBinding(parsed, options, authoritySha256);
    if (
      parsed.receipt.patch_response_resource_version !== null
    ) fail("handoff_arm_contract");
    return { discard: false, handoff: "receipt-arm", request: parsed, target };
  }
  if (parsed?.handoff === "receipt-commit") {
    if (
      !options || !authoritySha256 ||
      !exactKeys(parsed, [
        "handoff", "lease", "monitor_authority_sha256", "operation",
        "operation_lock", "receipt", "target", "token"
      ])
    ) fail("handoff_commit_contract");
    const target = validateHandoffBinding(parsed, options, authoritySha256);
    if (
      typeof parsed.receipt.patch_response_resource_version !== "string" ||
      !parsed.receipt.patch_response_resource_version
    ) fail("handoff_commit_contract");
    return { discard: false, handoff: "receipt-commit", request: parsed, target };
  }
  if (
    !exactKeys(parsed, ["stop", "boundaries"]) || parsed.stop !== true ||
    !exactKeys(parsed.boundaries, ["deployments", "replicasets", "pods"])
  ) fail("stop_contract");
  for (const key of ["deployments", "replicasets", "pods"]) {
    if (typeof parsed.boundaries[key] !== "string" || !parsed.boundaries[key]) {
      fail("stop_contract");
    }
  }
  return { discard: false, boundaries: parsed.boundaries };
}

function requiredFinalStableSeconds(context) {
  if (
    process.env.YENHUBS_RECOVERY_TEST_MODE === "local-fixture" &&
    context === "fixture-context"
  ) {
    const seconds = process.env.RECOVERY_TEST_STABLE_ABSENCE_SECONDS || "0";
    if (!/^[0-2]$/.test(seconds)) fail("test_stable_window");
    return Number(seconds);
  }
  return FINAL_STABLE_SECONDS;
}

function terminalOverlapWatchSeconds(context) {
  const seconds = process.env.YENHUBS_WATCH_TEST_TERMINAL_TIMEOUT_SECONDS || "";
  if (seconds === "") return FINAL_OVERLAP_WATCH_SECONDS;
  if (
    process.env.YENHUBS_RECOVERY_TEST_MODE === "local-fixture" &&
    context === "fixture-context" && seconds === "1"
  ) return 1;
  fail("test_terminal_watch_timeout");
}

async function watchBoundaryStable(options, boundaries) {
  const requiredSeconds = requiredFinalStableSeconds(options.context);
  const startedAt = Date.now();
  const resourceVersions = { ...boundaries };
  do {
    const next = await Promise.all(["deployments", "replicasets", "pods"].map(resource =>
      watchOnce({
        ...options, resource, resourceVersion: resourceVersions[resource],
        timeoutSeconds: WATCH_TIMEOUT_SECONDS
      })
    ));
    ["deployments", "replicasets", "pods"].forEach((resource, index) => {
      resourceVersions[resource] = next[index];
    });
    validateControlPlane(options.kubectl, options.context, options, options.baseline.lease);
  } while (Date.now() - startedAt < requiredSeconds * 1000);
  return resourceVersions;
}

async function terminalListWithOverlap(options, resourceVersions) {
  const deadline = performance.now() + TERMINAL_POSTCONDITION_TIMEOUT_MILLISECONDS;
  const terminalWatchSeconds = terminalOverlapWatchSeconds(options.context);
  const requireLiveFixtureCoverage =
    process.env.YENHUBS_WATCH_TEST_REQUIRE_LIVE_TERMINAL === "1" &&
    process.env.YENHUBS_RECOVERY_TEST_MODE === "local-fixture" &&
    options.context === "fixture-context";
  const resources = ["deployments", "replicasets", "pods"];
  let firstCoverage = [];
  let secondCoverage = [];

  const beforeDeadline = async promise => {
    const remaining = remainingDeadlineMilliseconds(
      deadline, "terminal_postcondition_timeout"
    );
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            try { fail("terminal_postcondition_timeout"); } catch (error) { reject(error); }
          }, remaining);
        })
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const startCoverage = async versions => {
    const results = await beforeDeadline(Promise.allSettled(resources.map(resource =>
      startWatchSession({
        ...options,
        resource,
        resourceVersion: versions[resource],
        timeoutSeconds: terminalWatchSeconds,
        allowFixtureImmediateBookmark: !requireLiveFixtureCoverage
      })
    )));
    const sessions = results.filter(result => result.status === "fulfilled")
      .map(result => result.value);
    const rejected = results.find(result => result.status === "rejected");
    if (rejected) {
      await Promise.allSettled(sessions.map(session => session.abort()));
      throw rejected.reason;
    }
    return sessions;
  };

  const abortCoverage = async () => {
    await Promise.allSettled(
      [...firstCoverage, ...secondCoverage].map(session => session.abort())
    );
  };

  try {
    firstCoverage = await startCoverage(resourceVersions);
    const terminal = validateCurrentLists(
      options.kubectl, options.context, options.namespace, options,
      options.baseline, deadline
    );
    await beforeDeadline(Promise.all(
      firstCoverage.map(session => session.assertOpen())
    ));
    secondCoverage = await startCoverage(terminal.boundaries);
    await beforeDeadline(Promise.all(firstCoverage.map(session =>
      session.finish({ intentionalStop: true })
    )));
    validateControlPlane(
      options.kubectl, options.context, options, options.baseline.lease,
      deadline
    );
    await beforeDeadline(Promise.all(
      secondCoverage.map(session => session.assertOpen())
    ));
    await beforeDeadline(Promise.all(secondCoverage.map(session =>
      session.finish({ intentionalStop: true })
    )));
    remainingDeadlineMilliseconds(deadline, "terminal_postcondition_timeout");
    return terminal;
  } catch (error) {
    await abortCoverage();
    throw error;
  }
}

async function startContinuousReceiptCoverage(options, resourceVersions) {
  const resources = ["deployments", "replicasets", "pods"];
  const active = new Map();
  const latestVersions = { ...resourceVersions };
  const firstStarted = new Set();
  const generations = new Map(resources.map(resource => [resource, 0]));
  const drainTargetGenerations = new Map();
  const heldSessions = new Map();
  const heldActive = new Map();
  const heldGenerations = new Map(resources.map(resource => [resource, 0]));
  const heldSnapshotVersions = new Map();
  const heldObservers = [];
  let heldStartCompletion = null;
  let drainRequested = false;
  let barrierRequested = false;
  let heldAbortExpected = false;
  let aborted = false;
  let failure = null;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  const abortActive = async () => {
    await Promise.allSettled([...active.values()].map(session => session.abort()));
  };
  const runners = resources.map(async resource => {
    try {
      while (!aborted) {
        // Count the attempt before awaiting spawn. A drain/barrier requested
        // while spawn is pending must force a later exact-RV generation; the
        // pending attempt itself cannot be mistaken for that successor.
        const generation = generations.get(resource) + 1;
        generations.set(resource, generation);
        const session = await startWatchSession({
          ...options,
          resource,
          resourceVersion: latestVersions[resource],
          timeoutSeconds: WATCH_TIMEOUT_SECONDS
        });
        active.set(resource, session);
        firstStarted.add(resource);
        if (firstStarted.size === resources.length) readyResolve();
        if (aborted) {
          await session.abort();
          active.delete(resource);
          break;
        }
        latestVersions[resource] = await session.finish();
        if (active.get(resource) === session) active.delete(resource);
        if (
          drainRequested &&
          generation >= drainTargetGenerations.get(resource)
        ) {
          break;
        }
        if (!aborted) {
          await new Promise(resolve => setImmediate(resolve));
        }
      }
    } catch (error) {
      if (failure === null) failure = error;
      if (firstStarted.size !== resources.length) readyReject(error);
      aborted = true;
      await abortActive();
      throw error;
    }
  });
  const completion = Promise.allSettled(runners).then(results => {
    const rejected = results.find(result => result.status === "rejected");
    if (rejected && failure === null) failure = rejected.reason;
  });
  try {
    await ready;
  } catch (error) {
    aborted = true;
    await abortActive();
    await completion;
    throw error;
  }

  const drainNaturally = async () => {
    if (drainRequested || aborted) fail("watch_drain_state");
    drainRequested = true;
    for (const resource of resources) {
      drainTargetGenerations.set(resource, generations.get(resource) + 1);
    }
    await completion;
    if (failure !== null) throw failure;
    return { ...latestVersions };
  };

  const recordHeldFailure = error => {
    if (heldAbortExpected) return;
    if (failure === null) {
      if (error instanceof Error) {
        failure = error;
      } else {
        try { fail(String(error)); } catch (heldError) { failure = heldError; }
      }
    }
  };

  const heldIdentityIsExact = () =>
    heldSessions.size === resources.length && heldActive.size === resources.length &&
    heldObservers.length === resources.length && resources.every(resource => {
      const held = heldSessions.get(resource);
      return held && held.resourceVersion === heldSnapshotVersions.get(resource) &&
        held.generation === heldGenerations.get(resource) &&
        heldActive.get(resource) === held.session;
    });

  return {
    async assertHealthy() {
      await new Promise(resolve => setImmediate(resolve));
      if (failure !== null || aborted || drainRequested || barrierRequested) {
        throw failure || new Error("watch_not_live");
      }
    },
    async finishNaturally() {
      if (drainRequested || barrierRequested || aborted) fail("watch_drain_state");
      // A Watch may have closed server-side while a synchronous LIST/GET kept
      // its callback pending. Requiring one complete successor generation per
      // resource after this request closes that invisible interval: the outer
      // Watch is already live, and this inner successor replays from the last
      // parsed exact RV before it is itself allowed to terminate naturally.
      return drainNaturally();
    },
    async barrierNaturally(deadline) {
      if (drainRequested || barrierRequested || aborted) {
        fail("watch_barrier_state");
      }
      barrierRequested = true;
      const beforeDeadline = async promise => {
        const remaining = remainingDeadlineMilliseconds(
          deadline, "receipt_handoff_timeout"
        );
        let timer;
        try {
          return await Promise.race([
            promise,
            new Promise((resolve, reject) => {
              timer = setTimeout(() => {
                try { fail("receipt_handoff_timeout"); } catch (error) { reject(error); }
              }, remaining);
            })
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      };
      const snapshot = { ...latestVersions };
      heldStartCompletion = Promise.allSettled(resources.map(async resource => {
        const generation = heldGenerations.get(resource) + 1;
        heldGenerations.set(resource, generation);
        heldSnapshotVersions.set(resource, snapshot[resource]);
        const session = await startWatchSession({
          ...options,
          resource,
          resourceVersion: snapshot[resource],
          timeoutSeconds: terminalOverlapWatchSeconds(options.context),
          allowFixtureImmediateBookmark: false
        });
        if (aborted) {
          await session.abort();
          fail("watch_barrier_aborted");
        }
        const held = {
          resource,
          generation,
          resourceVersion: snapshot[resource],
          session
        };
        heldSessions.set(resource, held);
        heldActive.set(resource, session);
        // Observe H immediately. Natural close, 410, parse failure and early
        // termination are fatal until the post-ACK abort is explicitly armed.
        heldObservers.push(session.finish().then(
          () => {
            if (heldActive.get(resource) === session) heldActive.delete(resource);
            recordHeldFailure("watch_held_closed");
          },
          error => {
            if (heldActive.get(resource) === session) heldActive.delete(resource);
            recordHeldFailure(error);
          }
        ));
        return held;
      }));
      const starts = await beforeDeadline(heldStartCompletion);
      const rejected = starts.find(result => result.status === "rejected");
      if (rejected) throw rejected.reason;
      if (failure !== null || aborted || !heldIdentityIsExact()) {
        throw failure || new Error("watch_barrier_not_live");
      }
      const sessions = resources.map(resource => heldSessions.get(resource).session);
      const initialOpen = await beforeDeadline(Promise.all(
        sessions.map(session => session.assertOpen())
      ));
      if (
        initialOpen.some(value => value !== true) || failure !== null || aborted ||
        !heldIdentityIsExact()
      ) throw failure || new Error("watch_barrier_not_live");

      // H is live before requesting R. R is one full post-request continuous
      // generation from the latest exact RV; its natural finish is observed
      // while H overlaps the whole interval.
      await beforeDeadline(drainNaturally());
      const finalOpen = await beforeDeadline(Promise.all(
        sessions.map(session => session.assertOpen())
      ));
      if (
        finalOpen.some(value => value !== true) || failure !== null || aborted ||
        !heldIdentityIsExact()
      ) throw failure || new Error("watch_barrier_not_live");
      remainingDeadlineMilliseconds(deadline, "receipt_handoff_timeout");
    },
    assertHeldLocal() {
      if (
        failure !== null || aborted || !barrierRequested ||
        !heldIdentityIsExact()
      ) {
        throw failure || new Error("watch_barrier_not_live");
      }
    },
    async abort() {
      heldAbortExpected = true;
      aborted = true;
      await Promise.allSettled([
        abortActive(),
        ...[...heldSessions.values()].map(held => held.session.abort())
      ]);
      if (heldStartCompletion !== null) await heldStartCompletion;
      await Promise.allSettled(
        [...heldSessions.values()].map(held => held.session.abort())
      );
      await completion;
      await Promise.allSettled(heldObservers);
    }
  };
}

async function receiptCoverageAtZero(options, resourceVersions, handoff) {
  const deadline = performance.now() + TERMINAL_POSTCONDITION_TIMEOUT_MILLISECONDS;
  let firstCoverage = null;
  let retainedCoverage = null;
  try {
    firstCoverage = await startContinuousReceiptCoverage(options, resourceVersions);
    const terminal = validateCurrentLists(
      options.kubectl, options.context, options.namespace, options,
      options.baseline, deadline
    );
    validateReceiptArmTarget(options, handoff);
    await firstCoverage.assertHealthy();
    retainedCoverage = await startContinuousReceiptCoverage(
      options, terminal.boundaries
    );
    // W1 is drained only by its successful natural Watch termination. W2 has
    // already started at the terminal LIST boundaries, so renewal preserves
    // continuous logical coverage without treating SIGTERM as a drain.
    await firstCoverage.finishNaturally();
    validateControlPlane(
      options.kubectl, options.context, options, options.baseline.lease, deadline
    );
    await retainedCoverage.assertHealthy();
    handoff.armed = true;
    return { terminal, coverage: retainedCoverage };
  } catch (error) {
    await Promise.allSettled(
      [firstCoverage, retainedCoverage].filter(Boolean).map(item => item.abort())
    );
    throw error;
  }
}

async function drainReceiptCoverage(options, coverage, handoff) {
  const deadline = performance.now() + TERMINAL_POSTCONDITION_TIMEOUT_MILLISECONDS;
  let finalCoverage = null;
  try {
    const terminal = validateReceiptCurrentLists(
      options.kubectl, options.context, options.namespace, options,
      options.baseline, handoff, deadline
    );
    await coverage.assertHealthy();
    finalCoverage = await startContinuousReceiptCoverage(
      options, terminal.boundaries
    );
    await coverage.finishNaturally();
    remainingDeadlineMilliseconds(deadline, "receipt_handoff_timeout");
    return { terminal, finalCoverage, deadline };
  } catch (error) {
    await Promise.allSettled(
      [coverage, finalCoverage].filter(Boolean).map(item => item.abort())
    );
    throw error;
  }
}

function handoffResponseBinding(options, authoritySha256, token) {
  return {
    token_sha256: sha256(token),
    monitor_authority_sha256: authoritySha256,
    operation: { id: options.operationId, owner: options.operationOwner },
    operation_lock: {
      name: options.lockName,
      uid: options.lockUid,
      resource_version: options.lockResourceVersion
    },
    lease: {
      name: options.leaseName, uid: options.leaseUid, holder: options.leaseHolder
    }
  };
}

async function waitForReceiptCommit(values, options, authoritySha256, arm, handoff, coverage) {
  const deadline = performance.now() + HANDOFF_COMMIT_TIMEOUT_MILLISECONDS;
  while (performance.now() < deadline) {
    const request = stopRequest(values.get("--stop"), options, authoritySha256);
    if (request?.discard) {
      await coverage.abort();
      return null;
    }
    if (request?.handoff === "receipt-commit") {
      if (
        request.request.token !== arm.request.token ||
        request.request.receipt.mode !== arm.request.receipt.mode
      ) fail("handoff_commit_binding");
      const receipt = request.request.receipt;
      if (receipt.mode === "create") {
        handoff.commitPatchResourceVersion = receipt.patch_response_resource_version;
        if (
          handoff.observedPatchResourceVersion !== null &&
          handoff.observedPatchResourceVersion !== handoff.commitPatchResourceVersion
        ) fail("receipt_event_resource_version");
      }
      return request;
    }
    if (request && request.handoff !== "receipt-arm") fail("handoff_state");
    if (
      request?.request.token !== arm.request.token ||
      request?.request.receipt.mode !== arm.request.receipt.mode
    ) fail("handoff_arm_changed");
    await coverage.assertHealthy();
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  fail("receipt_commit_timeout");
}

async function waitForReceiptPatchEvent(handoff, coverage) {
  const deadline = performance.now() + HANDOFF_COMMIT_TIMEOUT_MILLISECONDS;
  while (performance.now() < deadline) {
    if (
      handoff.observedPatchResourceVersion === handoff.commitPatchResourceVersion
    ) return;
    await coverage.assertHealthy();
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  fail("receipt_event_timeout");
}

async function performReceiptHandoff(
  values, monitoredOptions, state, arm, authoritySha256
) {
  let coverage = null;
  let finalCoverage = null;
  const handoff = {
    target: arm.target,
    armed: false,
    observedPatchResourceVersion: null,
    commitPatchResourceVersion: null
  };
  const options = { ...monitoredOptions, state, receiptHandoff: handoff };
  try {
    const stableVersions = await watchBoundaryStable(
      { ...monitoredOptions, state }, arm.request.boundaries
    );
    validateControlPlane(
      options.kubectl, options.context, options, options.baseline.lease
    );
    if (validateMonitorAuthority(values, options) !== authoritySha256) {
      fail("monitor_authority_changed");
    }
    const armedCoverage = await receiptCoverageAtZero(
      options, stableVersions, handoff
    );
    coverage = armedCoverage.coverage;
    validateControlPlane(
      options.kubectl, options.context, options, options.baseline.lease
    );
    if (validateMonitorAuthority(values, options) !== authoritySha256) {
      fail("monitor_authority_changed");
    }
    const armedTarget = armedCoverage.terminal.writer_deployments.find(
      deployment => deployment.name === handoff.target.name
    );
    if (!armedTarget || armedTarget.uid !== handoff.target.uid) {
      fail("receipt_target_missing");
    }
    writeAtomicRegular(values.get("--final"), `${JSON.stringify({
      handoff: "receipt-armed",
      ...handoffResponseBinding(options, authoritySha256, arm.request.token),
      target: {
        name: handoff.target.name,
        uid: handoff.target.uid,
        generation: handoff.target.generation
      },
      receipt: {
        annotation: arm.request.receipt.annotation,
        value: arm.request.receipt.value,
        mode: arm.request.receipt.mode,
        armed_resource_version: armedTarget.resource_version
      },
      deployments: armedCoverage.terminal.writer_deployments
    })}\n`, 2048);

    const commit = await waitForReceiptCommit(
      values, options, authoritySha256, arm, handoff, coverage
    );
    if (commit === null) return;
    await waitForReceiptPatchEvent(handoff, coverage);
    const drained = await drainReceiptCoverage(options, coverage, handoff);
    coverage = null;
    const terminal = drained.terminal;
    finalCoverage = drained.finalCoverage;
    validateControlPlane(
      options.kubectl, options.context, options, options.baseline.lease,
      drained.deadline
    );
    if (validateMonitorAuthority(values, options) !== authoritySha256) {
      fail("monitor_authority_changed");
    }
    const terminalTarget = terminal.writer_deployments.find(
      deployment => deployment.name === handoff.target.name
    );
    if (!terminalTarget || terminalTarget.uid !== handoff.target.uid) {
      fail("receipt_target_missing");
    }
    const ackText = `${JSON.stringify({
      handoff: "receipt-ack",
      ...handoffResponseBinding(options, authoritySha256, arm.request.token),
      target: {
        name: handoff.target.name,
        uid: handoff.target.uid,
        generation: handoff.target.generation
      },
      receipt: {
        annotation: arm.request.receipt.annotation,
        value: arm.request.receipt.value,
        mode: arm.request.receipt.mode,
        patch_response_resource_version:
          commit.request.receipt.patch_response_resource_version,
        terminal_resource_version: terminalTarget.resource_version
      },
      deployments: terminal.writer_deployments
    })}\n`;
    // Start and observe long-held H first, then drain one post-request R
    // generation naturally while H overlaps it. After this await, no
    // event-loop yield or remote read is allowed before the local transfer.
    await finalCoverage.barrierNaturally(drained.deadline);
    if (validateMonitorAuthority(values, options) !== authoritySha256) {
      fail("monitor_authority_changed");
    }
    remainingDeadlineMilliseconds(drained.deadline, "receipt_handoff_timeout");
    finalCoverage.assertHeldLocal();
    writeAtomicRegular(values.get("--final"), ackText, 2048);
    // ACK is the authority-transfer point. Keep W3 live through the atomic
    // publish, then terminate it without claiming coverage beyond the ACK.
    await finalCoverage.abort();
    finalCoverage = null;
  } catch (error) {
    await Promise.allSettled(
      [coverage, finalCoverage].filter(Boolean).map(item => item.abort())
    );
    throw error;
  }
}

function optionsFrom(values) {
  return {
    kubectl: process.env.KUBECTL_BIN || "kubectl",
    context: values.get("--context"), namespace: values.get("--namespace"),
    namespaceUid: values.get("--namespace-uid"),
    lockName: values.get("--operation-lock-name"),
    lockUid: values.get("--operation-lock-uid"),
    lockResourceVersion: values.get("--operation-lock-resource-version"),
    operationOwner: values.get("--operation-owner"),
    operationId: values.get("--operation-id"), leaseName: values.get("--lease-name"),
    leaseUid: values.get("--lease-uid"), leaseHolder: values.get("--lease-holder"),
    runtimeGeneration: values.get("--runtime-generation")
  };
}

async function monitor(values) {
  failureStage = "authority";
  const options = optionsFrom(values);
  const authoritySha256 = validateMonitorAuthority(values, options);
  const contractText = readRegular(values.get("--contract"), MAX_CONTRACT_BYTES);
  const contract = validateConsumerContract(
    contractText, values.get("--contract-sha256"), options.namespace
  );
  if (contract.operation_id !== options.operationId) fail("operation_binding");
  for (const marker of [
    "--stop", "--failure", "--ready", "--progress", "--final", "--baseline"
  ]) {
    if (readRegular(values.get(marker), marker === "--baseline" ? MAX_BASELINE_BYTES : 2048) !== "") {
      fail("marker_initial_state");
    }
  }
  const recoveryOperationFence = captureRecoveryOperationFence(
    options.kubectl, options.context, options
  );
  failureStage = "control-plane";
  const preBaselineOptions = {
    ...options,
    baseline: { recovery_operation_fence: recoveryOperationFence }
  };
  const lease = validateControlPlane(
    preBaselineOptions.kubectl, preBaselineOptions.context, preBaselineOptions
  );
  failureStage = "baseline";
  const baseline = captureBaseline(
    options.kubectl, options.context, options.namespace, options.namespaceUid,
    contract, lease, options.runtimeGeneration, recoveryOperationFence,
    options.operationOwner, {
      name: options.lockName,
      uid: options.lockUid,
      resource_version: options.lockResourceVersion
    }
  );
  failureStage = "control-plane";
  const monitoredOptions = { ...options, baseline };
  validateControlPlane(
    monitoredOptions.kubectl, monitoredOptions.context, monitoredOptions, baseline.lease
  );
  const baselineText = `${JSON.stringify(baseline)}\n`;
  const baselineDigest = sha256(baselineText);
  failureStage = "baseline";
  writeRegular(values.get("--baseline"), baselineText, MAX_BASELINE_BYTES);
  const state = runtimeState(baseline);
  let resourceVersions = { ...baseline.boundaries };
  let rounds = 0;
  while (true) {
    failureStage = "watch";
    if (validateMonitorAuthority(values, options) !== authoritySha256) {
      fail("monitor_authority_changed");
    }
    const next = await Promise.all(["deployments", "replicasets", "pods"].map(resource =>
      watchOnce({
        ...monitoredOptions, state, resource,
        resourceVersion: resourceVersions[resource],
        reportWatchFreshness: true
      })
    ));
    ["deployments", "replicasets", "pods"].forEach((resource, index) => {
      resourceVersions[resource] = next[index].resourceVersion;
    });
    // DigitalOcean's Kubernetes API may close an otherwise healthy short
    // watch without emitting a BOOKMARK.  Keeping the old resourceVersion in
    // that case eventually reaches compaction and fails the recovery guard.
    // Refresh all three validated Lists before the next watch so the state
    // and every boundary move forward together, without accepting an
    // unvalidated resourceVersion or losing the exact pod identity history.
    if (next.some(result => result.needsRefresh)) {
      const refreshed = validateCurrentLists(
        monitoredOptions.kubectl, monitoredOptions.context,
        monitoredOptions.namespace, monitoredOptions, baseline
      );
      reconcileRuntimeState(state, refreshed);
      resourceVersions = { ...refreshed.boundaries };
    }
    validateControlPlane(
      monitoredOptions.kubectl, monitoredOptions.context, monitoredOptions, baseline.lease
    );
    if (validateMonitorAuthority(values, options) !== authoritySha256) {
      fail("monitor_authority_changed");
    }
    rounds += 1;
    writeProgressMarker(
      values.get("--progress"), String(rounds), authoritySha256
    );
    if (rounds === 1) {
      writeRegular(
        values.get("--ready"),
        `ready:${baselineDigest}:${authoritySha256}\n`, 2048
      );
    }
    const stop = stopRequest(values.get("--stop"), monitoredOptions, authoritySha256);
    if (stop?.discard) return;
    if (stop?.handoff === "receipt-commit") fail("handoff_state");
    if (stop?.handoff === "receipt-arm") {
      await performReceiptHandoff(
        values, monitoredOptions, state, stop, authoritySha256
      );
      return;
    }
    if (stop) {
      const finalVersions = await watchBoundaryStable(
        { ...monitoredOptions, state }, stop.boundaries
      );
      validateControlPlane(
        monitoredOptions.kubectl, monitoredOptions.context, monitoredOptions, baseline.lease
      );
      const terminal = await terminalListWithOverlap(
        { ...monitoredOptions, state }, finalVersions
      );
      validateControlPlane(
        monitoredOptions.kubectl, monitoredOptions.context, monitoredOptions, baseline.lease
      );
      if (validateMonitorAuthority(values, options) !== authoritySha256) {
        fail("monitor_authority_changed");
      }
      writeRegular(values.get("--final"), `${JSON.stringify({
        complete: true,
        monitor_authority_sha256: authoritySha256,
        deployments: terminal.writer_deployments
      })}\n`, 2048);
      return;
    }
  }
}

function boundary(values) {
  const options = optionsFrom(values);
  const contractText = readRegular(values.get("--contract"), MAX_CONTRACT_BYTES);
  const contract = validateConsumerContract(
    contractText, values.get("--contract-sha256"), options.namespace
  );
  if (contract.operation_id !== options.operationId) fail("operation_binding");
  const baselineText = readRegular(values.get("--baseline"), MAX_BASELINE_BYTES);
  const baseline = validateBaseline(
    baselineText, values.get("--baseline-sha256"), options.context,
    options.namespace, options.namespaceUid, contract, options.runtimeGeneration,
    options.operationOwner, {
      name: options.lockName,
      uid: options.lockUid,
      resource_version: options.lockResourceVersion
    }, options.leaseName
  );
  const monitoredOptions = { ...options, baseline };
  validateControlPlane(
    monitoredOptions.kubectl, monitoredOptions.context, monitoredOptions, baseline.lease
  );
  const current = validateCurrentLists(
    monitoredOptions.kubectl, monitoredOptions.context, monitoredOptions.namespace,
    monitoredOptions, baseline
  );
  validateControlPlane(
    monitoredOptions.kubectl, monitoredOptions.context, monitoredOptions, baseline.lease
  );
  process.stdout.write(`${JSON.stringify({ stop: true, boundaries: current.boundaries })}\n`);
}

let parsed;
try {
  parsed = exactArguments(process.argv.slice(2));
  if (parsed.mode === "monitor") {
    await monitor(parsed.values);
  } else {
    boundary(parsed.values);
  }
} catch (error) {
  for (const child of activeChildren) child.kill("SIGTERM");
  if (parsed?.mode === "monitor") {
    process.stderr.write(`checkpoint_writer_monitor_stage:${failureStage}\n`);
    const safeCode = SAFE_BASELINE_FAILURE_CODES.has(error?.code)
      ? error.code
      : "other";
    process.stderr.write(`checkpoint_writer_monitor_code:${safeCode}\n`);
  }
  if (process.env.YENHUBS_WATCH_TEST_DEBUG === "1") {
    process.stderr.write(`checkpoint_writer_monitor_error:${String(error?.code || "failed")}\n`);
  }
  if (parsed?.mode === "monitor") {
    try {
      writeRegular(
        parsed.values.get("--failure"),
        `checkpoint_writer_monitor_failed:${diagnosticToken(failureStage)}:` +
          `${diagnosticToken(error?.code)}\n`,
        2048
      );
    } catch {}
  }
  process.exitCode = 1;
}

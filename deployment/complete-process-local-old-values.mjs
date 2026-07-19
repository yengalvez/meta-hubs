#!/usr/bin/env node

// One-time, read-only-live completion of the historical AUD-065 values source.
// The canonical OLD file predates the isolated runner, so it lacks the runner
// verification binding and the exact live kubelet pull config. This tool reads
// those bytes from the bound Kubernetes Secret, proves GHCR access, and replaces
// the private local source only through an exact owner-private CAS.

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseLocalValuesSource } from "./parse-local-values.mjs";
import {
  projectProcessLocalValuesMap,
  readPrivateProcessLocalValuesSource
} from "./project-process-local-values.mjs";
import {
  replacePrivateProcessLocalValuesSource
} from "./process-local-source-transition.mjs";
import {
  validateProcessLocalValuesSnapshot
} from "./process-local-rotation.mjs";
import {
  verifyBotPullConfig,
  verifyGhcrPullAccess
} from "./verify-bot-image-pull-config.mjs";
import {
  withRuntimeImageBuildProvenanceArtifactSnapshot,
  verifyRuntimeImageBuildProvenance
} from "./verify-runtime-image-build-provenance.mjs";
import { withPrivateDockerConfig } from "./with-private-docker-config.mjs";
import operationLeaseModule from "../hubs-cloud/community-edition/apply/operation-lease.js";

const {
  HEARTBEAT_INTERVAL_MS,
  OPERATION_LEASE_NAME,
  OperationLease,
  runLeaseGuardedMutation
} = operationLeaseModule;

const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_KUBECTL_OUTPUT_BYTES = 2 * 1024 * 1024;
const CANONICAL_VALUES = fileURLToPath(
  new URL("./input-values.local.yaml", import.meta.url)
);
const KUBECTL_CANDIDATES = Object.freeze([
  "/opt/homebrew/bin/kubectl",
  "/usr/local/bin/kubectl",
  "/usr/bin/kubectl"
]);
const SUCCESS_TOKENS = Object.freeze({
  completed: "aud065_old_source_completed_v1",
  alreadyComplete: "aud065_old_source_already_complete_v1",
  verified: "aud065_old_source_verified_v1"
});
const GENERIC_ERROR = "AUD-065 OLD source completion failed closed\n";
const RUNTIME_IMAGES = Object.freeze({
  botOrchestrator:
    /^ghcr\.io\/yengalvez\/bot-orchestrator@sha256:[a-f0-9]{64}$/u,
  botRunner: /^ghcr\.io\/yengalvez\/bot-runner@sha256:[a-f0-9]{64}$/u,
  reticulum: /^ghcr\.io\/yengalvez\/reticulum@sha256:[a-f0-9]{64}$/u
});
const SOURCE_COMMIT = /^[a-f0-9]{40}$/u;
const PROVENANCE_INVOCATION =
  /^https:\/\/github\.com\/yengalvez\/hubs-cloud\/actions\/runs\/[1-9][0-9]{0,19}\/attempts\/[1-9][0-9]{0,19}$/u;
const DNS_LABEL = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u;
const KUBE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,252}$/u;
const KUBE_UID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
// Kubernetes defines resourceVersion as an opaque string. Bind it byte-for-byte
// without parsing or ordering assumptions, while rejecting empty/control-heavy
// values that are unsafe for this private evidence contract.
const RESOURCE_VERSION = /^[^\u0000-\u001f\u007f]{1,256}$/u;
const REQUIRED_ADDITIONS = Object.freeze([
  "OVERRIDE_BOT_RUNNER_IMAGE",
  "BOT_IMAGE_PULL_CONFIG_JSON_BASE64"
]);
const ANCHOR_KEY = "OVERRIDE_BOT_ORCHESTRATOR_IMAGE";
const ATTRIBUTION_KEY_DOMAIN = Buffer.from(
  "yenhubs-aud065-old-source-attribution-v1\0",
  "utf8"
);
const PREFLIGHT_RUNNER_IMAGE =
  `ghcr.io/yengalvez/bot-runner@sha256:${"0".repeat(64)}`;
const PREFLIGHT_PULL_CONFIG = Buffer.from(JSON.stringify({
  auths: {
    "ghcr.io": {
      auth: Buffer.from("aud065-preflight:local-contract-only", "utf8")
        .toString("base64")
    }
  }
}), "utf8").toString("base64");

export class ProcessLocalOldSourceCompletionError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProcessLocalOldSourceCompletionError";
    this.code = code;
  }
}

function fail(code) {
  throw new ProcessLocalOldSourceCompletionError(code);
}

function safeStringEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  try {
    return leftBytes.length === rightBytes.length &&
      timingSafeEqual(leftBytes, rightBytes);
  } finally {
    leftBytes.fill(0);
    rightBytes.fill(0);
  }
}

function safeBufferEqual(left, right) {
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) &&
    left.length === right.length && timingSafeEqual(left, right);
}

function wipeMap(values) {
  if (!(values instanceof Map)) return;
  for (const key of values.keys()) values.set(key, "");
  values.clear();
}

function wipeRecord(values) {
  if (!values || typeof values !== "object") return;
  for (const key of Object.keys(values)) values[key] = "";
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return object(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function checkedRuntimeProvenance(value) {
  const imageKeys = Object.keys(RUNTIME_IMAGES).sort();
  if (!exactKeys(value, ["images", "invocationId", "sourceCommit"]) ||
      !SOURCE_COMMIT.test(value.sourceCommit || "") ||
      !PROVENANCE_INVOCATION.test(value.invocationId || "") ||
      !exactKeys(value.images, imageKeys) ||
      imageKeys.some(key => typeof value.images[key] !== "string" ||
        !RUNTIME_IMAGES[key].test(value.images[key]))) {
    fail("runtime_provenance_result_invalid");
  }
  return Object.freeze({
    sourceCommit: value.sourceCommit,
    invocationId: value.invocationId,
    images: Object.freeze(Object.fromEntries(
      imageKeys.map(key => [key, value.images[key]])
    ))
  });
}

function checkedLocalPath(value, code) {
  if (typeof value !== "string" || !path.isAbsolute(value) ||
      /[\u0000\r\n]/u.test(value)) {
    fail(code);
  }
  return value;
}

function checkedContext(value) {
  if (typeof value !== "string" || !KUBE_IDENTIFIER.test(value)) {
    fail("kube_context_invalid");
  }
  return value;
}

function checkedNamespaceUid(value) {
  if (typeof value !== "string" || !KUBE_UID.test(value)) {
    fail("namespace_uid_invalid");
  }
  return value;
}

function trustedExecutable(stat) {
  const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
  return stat.isFile() && Number(stat.mode & 0o022n) === 0 &&
    (uid === null || stat.uid === 0n || stat.uid === uid);
}

export function resolveKubectlExecutable() {
  for (const candidate of KUBECTL_CANDIDATES) {
    try {
      const resolved = fs.realpathSync(candidate);
      const stat = fs.statSync(resolved, { bigint: true });
      if (path.isAbsolute(resolved) && trustedExecutable(stat)) return resolved;
    } catch {
      // Continue through the fixed trusted installation locations.
    }
  }
  fail("kubectl_executable_invalid");
}

function minimalEnvironment() {
  const environment = {
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1"
  };
  for (const name of ["HOME", "KUBECONFIG"]) {
    if (typeof process.env[name] === "string" && process.env[name]) {
      environment[name] = process.env[name];
    }
  }
  return environment;
}

export function runKubectlForOldSource(invocation) {
  return spawnSync(invocation.executable, invocation.args, {
    env: invocation.env,
    input: invocation.input,
    encoding: null,
    timeout: 30_000,
    killSignal: "SIGKILL",
    maxBuffer: MAX_KUBECTL_OUTPUT_BYTES,
    stdio: ["pipe", "pipe", "pipe"]
  });
}

function leaseKubectlResult({ executable, runner, context, args, input }) {
  let result;
  let stdout;
  let stderr;
  let inputBytes;
  try {
    inputBytes = input === undefined
      ? undefined
      : Buffer.from(JSON.stringify(input), "utf8");
    result = runner({
      executable,
      args: [
        "--context", context,
        "--request-timeout=15s",
        ...args
      ],
      env: minimalEnvironment(),
      input: inputBytes
    });
    stdout = result?.stdout;
    stderr = result?.stderr;
    if (result?.error || result?.signal || !Number.isInteger(result?.status) ||
        !Buffer.isBuffer(stdout) || !Buffer.isBuffer(stderr) ||
        stdout.length > MAX_KUBECTL_OUTPUT_BYTES ||
        stderr.length > MAX_KUBECTL_OUTPUT_BYTES) {
      fail("operation_lease_io_failed");
    }
    const diagnostic = stderr.toString("utf8");
    if (result.status === 0) {
      if (stdout.length < 2 || stderr.length !== 0) {
        fail("operation_lease_io_failed");
      }
      return {
        status: 0,
        stdout: Buffer.from(stdout),
        conflict: false,
        notFound: false
      };
    }
    if (stdout.length !== 0 || stderr.length < 1) {
      fail("operation_lease_io_failed");
    }
    return {
      status: result.status,
      stdout: null,
      conflict: diagnostic.includes("Conflict") || diagnostic.includes("AlreadyExists"),
      notFound: diagnostic.includes("NotFound")
    };
  } catch (error) {
    if (error instanceof ProcessLocalOldSourceCompletionError) throw error;
    fail("operation_lease_io_failed");
  } finally {
    if (inputBytes) inputBytes.fill(0);
    if (stdout) stdout.fill(0);
    if (stderr) stderr.fill(0);
  }
}

class BufferedKubectlLeaseClient {
  constructor({ executable, runner, context }) {
    this.executable = executable;
    this.runner = runner;
    this.context = context;
  }

  get(namespace) {
    const result = leaseKubectlResult({
      executable: this.executable,
      runner: this.runner,
      context: this.context,
      args: ["-n", namespace, "get", "lease", OPERATION_LEASE_NAME, "-o", "json"]
    });
    try {
      if (result.status === 0) {
        return parseJson(result.stdout, "operation_lease_json_invalid");
      }
      if (result.notFound) return null;
      fail("operation_lease_read_failed");
    } finally {
      if (result.stdout) result.stdout.fill(0);
    }
  }

  write(verb, document) {
    const result = leaseKubectlResult({
      executable: this.executable,
      runner: this.runner,
      context: this.context,
      args: [verb, "-f", "-", "-o", "json"],
      input: document
    });
    try {
      if (result.status === 0) {
        return {
          resource: parseJson(result.stdout, "operation_lease_json_invalid")
        };
      }
      if (result.conflict) return { conflict: true };
      fail("operation_lease_write_failed");
    } finally {
      if (result.stdout) result.stdout.fill(0);
    }
  }

  create(document) {
    return this.write("create", document);
  }

  replace(document) {
    return this.write("replace", document);
  }
}

class RefreshingOperationLeaseGuard {
  constructor(lease) {
    this.lease = lease;
    this.heartbeat = null;
    this.heartbeatError = null;
    this.acquired = false;
  }

  acquire() {
    this.lease.acquire();
    this.acquired = true;
    this.heartbeat = setInterval(() => {
      try {
        this.lease.renew();
      } catch (error) {
        this.heartbeatError = error;
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeat.unref?.();
  }

  requireHeartbeat() {
    if (this.heartbeatError) throw new Error("operation_lease_heartbeat_lost");
    if (!this.acquired) throw new Error("operation_lease_not_acquired");
  }

  refresh() {
    this.requireHeartbeat();
    this.lease.renew();
    this.requireHeartbeat();
  }

  assertFresh() {
    this.requireHeartbeat();
    this.lease.assertFreshForMutation();
    this.requireHeartbeat();
  }

  release() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    const heartbeatError = this.heartbeatError;
    let releaseError;
    try {
      if (!this.acquired) throw new Error("operation_lease_not_acquired");
      this.lease.release();
    } catch (error) {
      releaseError = error;
    } finally {
      this.acquired = false;
    }
    if (releaseError) throw releaseError;
    if (heartbeatError) throw new Error("operation_lease_heartbeat_lost");
  }
}

export function createOldSourceOperationLeaseGuard({
  kubectlExecutable,
  kubectlRunner,
  expectedKubeContext,
  namespace
}) {
  const client = new BufferedKubectlLeaseClient({
    executable: kubectlExecutable,
    runner: kubectlRunner,
    context: expectedKubeContext
  });
  const lease = new OperationLease(client, {
    namespace,
    holder: `root-recovery:${randomUUID()}`
  });
  return new RefreshingOperationLeaseGuard(lease);
}

function invokeKubectl({ executable, runner, context, args }) {
  let result;
  let stdout;
  let stderr;
  try {
    result = runner({
      executable,
      args: [
        "--context", context,
        "--request-timeout=15s",
        ...args,
        "-o", "json"
      ],
      env: minimalEnvironment()
    });
    stdout = result?.stdout;
    stderr = result?.stderr;
    if (result?.error || result?.signal || result?.status !== 0 ||
        !Buffer.isBuffer(stdout) || !Buffer.isBuffer(stderr) ||
        stdout.length < 2 || stdout.length > MAX_KUBECTL_OUTPUT_BYTES ||
        stderr.length !== 0) {
      fail("kubectl_read_failed");
    }
    return Buffer.from(stdout);
  } catch (error) {
    if (error instanceof ProcessLocalOldSourceCompletionError) throw error;
    fail("kubectl_read_failed");
  } finally {
    if (stdout) stdout.fill(0);
    if (stderr) stderr.fill(0);
  }
}

function parseJson(bytes, code) {
  try {
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) fail(code);
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
    return value;
  } catch (error) {
    if (error instanceof ProcessLocalOldSourceCompletionError) throw error;
    fail(code);
  }
}

function checkedOperationLeaseGuard(value) {
  if (!value || typeof value !== "object" ||
      ["acquire", "refresh", "assertFresh", "release"].some(
        name => typeof value[name] !== "function"
      )) {
    fail("operation_lease_guard_invalid");
  }
  return value;
}

function acquireOperationLease(guard) {
  try {
    guard.acquire();
  } catch {
    fail("operation_lease_acquire_failed");
  }
}

function refreshOperationLease(guard) {
  try {
    guard.refresh();
    guard.assertFresh();
  } catch {
    fail("operation_lease_lost");
  }
}

function assertOperationLeaseFresh(guard) {
  try {
    guard.assertFresh();
  } catch {
    fail("operation_lease_lost");
  }
}

function releaseOperationLease(guard) {
  try {
    guard.release();
  } catch {
    fail("operation_lease_release_failed");
  }
}

function withFreshOperationLease(guard, action) {
  refreshOperationLease(guard);
  let result;
  let actionError;
  try {
    result = runLeaseGuardedMutation(
      () => assertOperationLeaseFresh(guard),
      action
    );
  } catch (error) {
    actionError = error;
  }
  if (actionError) throw actionError;
  return result;
}

async function withFreshOperationLeaseAsync(guard, action) {
  refreshOperationLease(guard);
  let result;
  let actionError;
  try {
    result = await action();
  } catch (error) {
    actionError = error;
  }
  refreshOperationLease(guard);
  if (actionError) throw actionError;
  return result;
}

function liveMetadata(resource, { apiVersion = "v1", kind, name, namespace }) {
  const metadata = resource?.metadata;
  if (resource?.apiVersion !== apiVersion || resource?.kind !== kind ||
      !metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
      metadata.name !== name ||
      (namespace === undefined ? metadata.namespace !== undefined : metadata.namespace !== namespace) ||
      metadata.deletionTimestamp != null || !KUBE_UID.test(metadata.uid || "") ||
      !RESOURCE_VERSION.test(metadata.resourceVersion || "")) {
    fail("live_resource_contract_invalid");
  }
  return { uid: metadata.uid, resourceVersion: metadata.resourceVersion };
}

function decodeParentDeployment(deployment, namespace, expectedBotImage) {
  const metadata = liveMetadata(deployment, {
    apiVersion: "apps/v1",
    kind: "Deployment",
    name: "bot-orchestrator",
    namespace
  });
  const podSpec = deployment?.spec?.template?.spec;
  const containers = podSpec?.containers;
  if (!object(deployment.spec) || !object(deployment.spec.template) ||
      !object(podSpec) || !Array.isArray(containers) || containers.length !== 1 ||
      (podSpec.initContainers !== undefined &&
        (!Array.isArray(podSpec.initContainers) || podSpec.initContainers.length !== 0)) ||
      (podSpec.ephemeralContainers !== undefined &&
        (!Array.isArray(podSpec.ephemeralContainers) ||
          podSpec.ephemeralContainers.length !== 0))) {
    fail("live_parent_contract_invalid");
  }
  const serviceAccountName = podSpec.serviceAccountName ?? "default";
  const imagePullSecrets = podSpec.imagePullSecrets ?? [];
  if (serviceAccountName !== "default" || !Array.isArray(imagePullSecrets) ||
      imagePullSecrets.length !== 0) {
    fail("live_parent_pull_binding_invalid");
  }
  const [container] = containers;
  if (!object(container) || container.name !== "bot-orchestrator" ||
      typeof container.image !== "string" ||
      !RUNTIME_IMAGES.botOrchestrator.test(container.image) ||
      !safeStringEqual(container.image, expectedBotImage)) {
    fail("live_parent_image_mismatch");
  }
  return {
    uid: metadata.uid,
    resourceVersion: metadata.resourceVersion,
    image: container.image
  };
}

function decodePullSecret(secret, namespace) {
  const metadata = liveMetadata(secret, {
    kind: "Secret",
    name: "ghcr-pull",
    namespace
  });
  if (secret.type !== "kubernetes.io/dockerconfigjson" ||
      !object(secret.data) ||
      Object.keys(secret.data).join("\0") !== ".dockerconfigjson" ||
      typeof secret.data[".dockerconfigjson"] !== "string" ||
      !secret.data[".dockerconfigjson"]) {
    fail("live_pull_binding_invalid");
  }
  return {
    uid: metadata.uid,
    resourceVersion: metadata.resourceVersion,
    encodedPullConfig: secret.data[".dockerconfigjson"]
  };
}

function decodeLiveState({
  namespaceBytes,
  secretBytes,
  serviceAccountBytes,
  deploymentBytes
}, {
  namespace,
  expectedNamespaceUid,
  expectedBotImage
}) {
  const namespaceObject = parseJson(namespaceBytes, "namespace_json_invalid");
  const secret = parseJson(secretBytes, "pull_secret_json_invalid");
  const serviceAccount = parseJson(
    serviceAccountBytes,
    "pull_service_account_json_invalid"
  );
  const deployment = parseJson(
    deploymentBytes,
    "parent_deployment_json_invalid"
  );
  const namespaceMetadata = liveMetadata(namespaceObject, {
    kind: "Namespace",
    name: namespace,
    namespace: undefined
  });
  if (namespaceMetadata.uid !== expectedNamespaceUid) fail("namespace_uid_mismatch");
  const pullSecret = decodePullSecret(secret, namespace);
  const serviceAccountMetadata = liveMetadata(serviceAccount, {
    kind: "ServiceAccount",
    name: "default",
    namespace
  });
  if (JSON.stringify(serviceAccount.imagePullSecrets) !==
        JSON.stringify([{ name: "ghcr-pull" }])) {
    fail("live_pull_binding_invalid");
  }
  const parentDeployment = decodeParentDeployment(
    deployment,
    namespace,
    expectedBotImage
  );
  return {
    namespaceUid: namespaceMetadata.uid,
    namespaceResourceVersion: namespaceMetadata.resourceVersion,
    secretUid: pullSecret.uid,
    secretResourceVersion: pullSecret.resourceVersion,
    serviceAccountUid: serviceAccountMetadata.uid,
    serviceAccountResourceVersion: serviceAccountMetadata.resourceVersion,
    parentDeploymentUid: parentDeployment.uid,
    parentDeploymentResourceVersion: parentDeployment.resourceVersion,
    parentImage: parentDeployment.image,
    encodedPullConfig: pullSecret.encodedPullConfig
  };
}

function wipeLiveState(state) {
  wipeRecord(state);
}

function sameLiveState(left, right) {
  if (!left || !right) return false;
  const keys = [
    "namespaceUid",
    "namespaceResourceVersion",
    "secretUid",
    "secretResourceVersion",
    "serviceAccountUid",
    "serviceAccountResourceVersion",
    "parentDeploymentUid",
    "parentDeploymentResourceVersion",
    "parentImage",
    "encodedPullConfig"
  ];
  return keys.every(key => safeStringEqual(left[key], right[key]));
}

function capturePreliminaryPullState({
  kubectlExecutable,
  kubectlRunner,
  expectedKubeContext,
  namespace,
  expectedNamespaceUid,
  expectedBotImage
}) {
  let namespaceBytes;
  let secretBytes;
  let serviceAccountBytes;
  let deploymentBytes;
  try {
    namespaceBytes = invokeKubectl({
      executable: kubectlExecutable,
      runner: kubectlRunner,
      context: expectedKubeContext,
      args: ["get", "namespace", namespace]
    });
    secretBytes = invokeKubectl({
      executable: kubectlExecutable,
      runner: kubectlRunner,
      context: expectedKubeContext,
      args: ["-n", namespace, "get", "secret", "ghcr-pull"]
    });
    serviceAccountBytes = invokeKubectl({
      executable: kubectlExecutable,
      runner: kubectlRunner,
      context: expectedKubeContext,
      args: ["-n", namespace, "get", "serviceaccount", "default"]
    });
    deploymentBytes = invokeKubectl({
      executable: kubectlExecutable,
      runner: kubectlRunner,
      context: expectedKubeContext,
      args: ["-n", namespace, "get", "deployment", "bot-orchestrator"]
    });
    return decodeLiveState({
      namespaceBytes,
      secretBytes,
      serviceAccountBytes,
      deploymentBytes
    }, {
      namespace,
      expectedNamespaceUid,
      expectedBotImage
    });
  } finally {
    if (namespaceBytes) namespaceBytes.fill(0);
    if (secretBytes) secretBytes.fill(0);
    if (serviceAccountBytes) serviceAccountBytes.fill(0);
    if (deploymentBytes) deploymentBytes.fill(0);
  }
}

function captureLivePullState({
  kubectlExecutable,
  kubectlRunner,
  operationLeaseGuard,
  expectedKubeContext,
  namespace,
  expectedNamespaceUid,
  expectedBotImage
}) {
  let namespaceBytes;
  let secretBytes;
  let serviceAccountBytes;
  let deploymentBytes;
  try {
    namespaceBytes = withFreshOperationLease(operationLeaseGuard, () =>
      invokeKubectl({
        executable: kubectlExecutable,
        runner: kubectlRunner,
        context: expectedKubeContext,
        args: ["get", "namespace", namespace]
      })
    );
    secretBytes = withFreshOperationLease(operationLeaseGuard, () =>
      invokeKubectl({
        executable: kubectlExecutable,
        runner: kubectlRunner,
        context: expectedKubeContext,
        args: ["-n", namespace, "get", "secret", "ghcr-pull"]
      })
    );
    serviceAccountBytes = withFreshOperationLease(operationLeaseGuard, () =>
      invokeKubectl({
        executable: kubectlExecutable,
        runner: kubectlRunner,
        context: expectedKubeContext,
        args: ["-n", namespace, "get", "serviceaccount", "default"]
      })
    );
    deploymentBytes = withFreshOperationLease(operationLeaseGuard, () =>
      invokeKubectl({
        executable: kubectlExecutable,
        runner: kubectlRunner,
        context: expectedKubeContext,
        args: ["-n", namespace, "get", "deployment", "bot-orchestrator"]
      })
    );
    return decodeLiveState({
      namespaceBytes,
      secretBytes,
      serviceAccountBytes,
      deploymentBytes
    }, {
      namespace,
      expectedNamespaceUid,
      expectedBotImage
    });
  } finally {
    if (namespaceBytes) namespaceBytes.fill(0);
    if (secretBytes) secretBytes.fill(0);
    if (serviceAccountBytes) serviceAccountBytes.fill(0);
    if (deploymentBytes) deploymentBytes.fill(0);
  }
}

function parseValues(bytes) {
  try {
    return parseLocalValuesSource(bytes.toString("utf8"));
  } catch {
    fail("old_source_invalid");
  }
}

function sourceLineEnding(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_SOURCE_BYTES) {
    fail("old_source_invalid");
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes) || !text.endsWith("\n")) {
    fail("old_source_layout_invalid");
  }
  const endings = text.match(/\r?\n/gu) || [];
  if (endings.length < 1 || endings.some(ending => ending !== endings[0])) {
    fail("old_source_layout_invalid");
  }
  return { text, ending: endings[0] };
}

function insertRequiredAdditions(bytes, runnerImage, encodedPullConfig) {
  const { text, ending } = sourceLineEnding(bytes);
  const matches = [...text.matchAll(
    /^OVERRIDE_BOT_ORCHESTRATOR_IMAGE:[^\r\n]*(?:\r?\n)/gmu
  )];
  if (matches.length !== 1) fail("old_source_anchor_invalid");
  const insertionOffset = matches[0].index + matches[0][0].length;
  const insertion = [
    `OVERRIDE_BOT_RUNNER_IMAGE: ${JSON.stringify(runnerImage)}`,
    `BOT_IMAGE_PULL_CONFIG_JSON_BASE64: ${JSON.stringify(encodedPullConfig)}`,
    ""
  ].join(ending);
  const completed = Buffer.from(
    `${text.slice(0, insertionOffset)}${insertion}${text.slice(insertionOffset)}`,
    "utf8"
  );
  if (completed.length > MAX_SOURCE_BYTES) {
    completed.fill(0);
    fail("old_source_too_large");
  }
  return completed;
}

function validateCompletedValues(values, runnerImage, encodedPullConfig) {
  let snapshot;
  try {
    if (!safeStringEqual(values.get("OVERRIDE_BOT_RUNNER_IMAGE"), runnerImage) ||
        !safeStringEqual(
          values.get("BOT_IMAGE_PULL_CONFIG_JSON_BASE64"),
          encodedPullConfig
        )) {
      fail("completed_source_mismatch");
    }
    snapshot = projectProcessLocalValuesMap(values);
    validateProcessLocalValuesSnapshot(snapshot, { codePrefix: "old_source" });
    verifyBotPullConfig({
      encoded: snapshot.BOT_IMAGE_PULL_CONFIG_JSON_BASE64,
      botImage: snapshot.OVERRIDE_BOT_ORCHESTRATOR_IMAGE,
      runnerImage: snapshot.OVERRIDE_BOT_RUNNER_IMAGE
    });
    return snapshot.OVERRIDE_BOT_ORCHESTRATOR_IMAGE;
  } catch (error) {
    if (error instanceof ProcessLocalOldSourceCompletionError) throw error;
    fail("completed_source_invalid");
  } finally {
    wipeRecord(snapshot);
  }
}

function validateOldSourceContract(values, sourceBytes, complete) {
  let candidateBytes;
  let candidateValues;
  try {
    if (complete) {
      validateCompletedValues(
        values,
        values.get("OVERRIDE_BOT_RUNNER_IMAGE"),
        values.get("BOT_IMAGE_PULL_CONFIG_JSON_BASE64")
      );
      return values.get(ANCHOR_KEY);
    }
    candidateBytes = insertRequiredAdditions(
      sourceBytes,
      PREFLIGHT_RUNNER_IMAGE,
      PREFLIGHT_PULL_CONFIG
    );
    candidateValues = parseValues(candidateBytes);
    return validateCompletedValues(
      candidateValues,
      PREFLIGHT_RUNNER_IMAGE,
      PREFLIGHT_PULL_CONFIG
    );
  } finally {
    if (candidateBytes) candidateBytes.fill(0);
    wipeMap(candidateValues);
  }
}

function deriveAttributionKey(encodedPullConfig) {
  let material;
  try {
    if (typeof encodedPullConfig !== "string" || !encodedPullConfig) {
      fail("pull_config_attribution_invalid");
    }
    material = Buffer.from(encodedPullConfig, "utf8");
    if (material.length < 1 || material.length > MAX_SOURCE_BYTES) {
      fail("pull_config_attribution_invalid");
    }
    return createHash("sha256")
      .update(ATTRIBUTION_KEY_DOMAIN)
      .update(material)
      .digest();
  } finally {
    if (material) material.fill(0);
  }
}

function rollbackCompletedSourceExact({
  sourcePath,
  sourceBytes,
  completedBytes,
  attributionKey
}) {
  let currentBytes;
  let rolledBackBytes;
  try {
    currentBytes = readPrivateProcessLocalValuesSource(sourcePath);
    if (safeBufferEqual(currentBytes, sourceBytes)) return true;
    if (!safeBufferEqual(currentBytes, completedBytes)) {
      fail("old_source_rollback_conflict");
    }
    replacePrivateProcessLocalValuesSource({
      canonicalValuesPath: sourcePath,
      expectedBytes: completedBytes,
      replacementBytes: sourceBytes,
      attributionKey
    });
    rolledBackBytes = readPrivateProcessLocalValuesSource(sourcePath);
    if (!safeBufferEqual(rolledBackBytes, sourceBytes)) {
      fail("old_source_rollback_failed");
    }
    return true;
  } catch (error) {
    if (error instanceof ProcessLocalOldSourceCompletionError) throw error;
    fail("old_source_rollback_failed");
  } finally {
    if (currentBytes) currentBytes.fill(0);
    if (rolledBackBytes) rolledBackBytes.fill(0);
  }
}

function rollbackCompletedSourceWithFreshLease({
  operationLeaseGuard,
  sourcePath,
  sourceBytes,
  completedBytes,
  attributionKey
}) {
  let currentBytes;
  let afterFailureBytes;
  try {
    currentBytes = readPrivateProcessLocalValuesSource(sourcePath);
    if (!safeBufferEqual(currentBytes, completedBytes)) return false;
    try {
      withFreshOperationLease(operationLeaseGuard, () =>
        rollbackCompletedSourceExact({
          sourcePath,
          sourceBytes,
          completedBytes,
          attributionKey
        })
      );
      return true;
    } catch {
      // A failed refresh/assert means the completed CAS is authoritative until
      // a later complete/verify run reconciles it. Never mutate after ownership
      // of the global operation Lease becomes unprovable.
      afterFailureBytes = readPrivateProcessLocalValuesSource(sourcePath);
      if (safeBufferEqual(afterFailureBytes, completedBytes)) {
        fail("old_source_reconciliation_required");
      }
      fail("old_source_rollback_failed");
    }
  } finally {
    if (currentBytes) currentBytes.fill(0);
    if (afterFailureBytes) afterFailureBytes.fill(0);
  }
}

function checkedProvenanceArtifactSnapshot(value) {
  const pathKeys = [
    "botOrchestratorBundlePath",
    "botRunnerBundlePath",
    "receiptBundlePath",
    "receiptPath",
    "reticulumBundlePath"
  ];
  if (!exactKeys(value, [
    "artifactBindings",
    "artifactPaths",
    "privateWorkDirectory",
    "privateWorkDirectoryIdentity"
  ]) || !exactKeys(value.artifactPaths, pathKeys) ||
      (value.artifactBindings !== undefined && !object(value.artifactBindings)) ||
      (value.privateWorkDirectoryIdentity !== undefined &&
        !object(value.privateWorkDirectoryIdentity))) {
    fail("runtime_artifact_snapshot_invalid");
  }
  const privateDirectory = checkedLocalPath(
    value.privateWorkDirectory,
    "runtime_artifact_snapshot_invalid"
  );
  const artifactPaths = Object.fromEntries(pathKeys.map(key => [
    key,
    checkedLocalPath(value.artifactPaths[key], "runtime_artifact_snapshot_invalid")
  ]));
  if (new Set(Object.values(artifactPaths)).size !== pathKeys.length ||
      Object.values(artifactPaths).some(artifactPath => {
        const relative = path.relative(privateDirectory, artifactPath);
        return !relative || relative === ".." || relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative);
      })) {
    fail("runtime_artifact_snapshot_invalid");
  }
  return {
    artifactPaths,
    artifactBindings: value.artifactBindings,
    privateWorkDirectory: privateDirectory,
    privateWorkDirectoryIdentity: value.privateWorkDirectoryIdentity
  };
}

export async function completeProcessLocalOldSource({
  command,
  expectedKubeContext,
  expectedNamespaceUid,
  receiptPath,
  receiptBundlePath,
  botOrchestratorBundlePath,
  botRunnerBundlePath,
  reticulumBundlePath,
  privateWorkDirectory,
  sourcePath = CANONICAL_VALUES,
  kubectlExecutable,
  kubectlRunner = runKubectlForOldSource,
  fetchImpl = globalThis.fetch,
  requestTimeoutMs,
  operationLeaseFactory = createOldSourceOperationLeaseGuard,
  provenanceArtifactSnapshotHelper = withRuntimeImageBuildProvenanceArtifactSnapshot,
  provenanceVerifier = verifyRuntimeImageBuildProvenance,
  privateDockerConfigHelper = withPrivateDockerConfig,
  provenanceSnapshotHooks,
  replacementHooks
}) {
  if (!["complete", "verify"].includes(command)) fail("command_invalid");
  const context = checkedContext(expectedKubeContext);
  const namespaceUid = checkedNamespaceUid(expectedNamespaceUid);
  const provenancePaths = {
    receiptPath: checkedLocalPath(receiptPath, "runtime_artifact_path_invalid"),
    receiptBundlePath: checkedLocalPath(
      receiptBundlePath,
      "runtime_artifact_path_invalid"
    ),
    botOrchestratorBundlePath: checkedLocalPath(
      botOrchestratorBundlePath,
      "runtime_artifact_path_invalid"
    ),
    botRunnerBundlePath: checkedLocalPath(
      botRunnerBundlePath,
      "runtime_artifact_path_invalid"
    ),
    reticulumBundlePath: checkedLocalPath(
      reticulumBundlePath,
      "runtime_artifact_path_invalid"
    )
  };
  const checkedPrivateWorkDirectory = checkedLocalPath(
    privateWorkDirectory,
    "private_work_directory_invalid"
  );
  if (typeof sourcePath !== "string" || !path.isAbsolute(sourcePath) ||
      /[\u0000\r\n]/u.test(sourcePath)) {
    fail("old_source_path_invalid");
  }
  if (typeof kubectlRunner !== "function" || typeof fetchImpl !== "function" ||
      typeof operationLeaseFactory !== "function" ||
      typeof provenanceArtifactSnapshotHelper !== "function" ||
      typeof provenanceVerifier !== "function" ||
      typeof privateDockerConfigHelper !== "function") {
    fail("runner_invalid");
  }
  const executable = kubectlExecutable === undefined
    ? resolveKubectlExecutable()
    : kubectlExecutable;
  if (typeof executable !== "string" || !path.isAbsolute(executable) ||
      /[\u0000\r\n]/u.test(executable)) {
    fail("kubectl_executable_invalid");
  }

  let sourceBytes;
  let completedBytes;
  let confirmedBytes;
  let values;
  let completedValues;
  let firstLive;
  let secondLive;
  let thirdLive;
  let preliminaryLive;
  let botImage;
  let runnerImage;
  let attributionKey;
  let operationLeaseGuard;
  let operationLeaseAcquired = false;
  let operationError;
  let releaseError;
  let successToken;
  const resolvedSourcePath = path.resolve(sourcePath);
  try {
    try {
      sourceBytes = readPrivateProcessLocalValuesSource(resolvedSourcePath);
      values = parseValues(sourceBytes);
      const namespace = values.get("Namespace");
      if (typeof namespace !== "string" || !DNS_LABEL.test(namespace)) {
        fail("old_source_namespace_invalid");
      }
      const presence = REQUIRED_ADDITIONS.map(name => values.has(name));
      if (presence[0] !== presence[1]) fail("old_source_partial_additions");
      if (command === "verify" && !presence[0]) fail("old_source_not_complete");

      botImage = validateOldSourceContract(values, sourceBytes, presence[0]);
      successToken = await provenanceArtifactSnapshotHelper({
        ...provenancePaths,
        privateParentDirectory: checkedPrivateWorkDirectory,
        ...(provenanceSnapshotHooks === undefined
          ? {}
          : { hooks: provenanceSnapshotHooks }),
        callback: async snapshotValue => {
          const snapshot = checkedProvenanceArtifactSnapshot(snapshotValue);
          try {
        preliminaryLive = capturePreliminaryPullState({
          kubectlExecutable: executable,
          kubectlRunner,
          expectedKubeContext: context,
          namespace,
          expectedNamespaceUid: namespaceUid,
          expectedBotImage: botImage
        });
        verifyBotPullConfig({
          encoded: preliminaryLive.encodedPullConfig,
          botImage,
          runnerImage: PREFLIGHT_RUNNER_IMAGE
        });
        const provenance = checkedRuntimeProvenance(await privateDockerConfigHelper({
          encodedDockerConfig: preliminaryLive.encodedPullConfig,
          privateParentDirectory: snapshot.privateWorkDirectory,
          ...(snapshot.privateWorkDirectoryIdentity === undefined
            ? {}
            : {
                expectedPrivateParentIdentity:
                  snapshot.privateWorkDirectoryIdentity
              }),
          callback(dockerConfigDirectory) {
            return provenanceVerifier({
              ...snapshot.artifactPaths,
              ...(snapshot.artifactBindings === undefined
                ? {}
                : { artifactBindings: snapshot.artifactBindings }),
              dockerConfigDirectory
            });
          }
        }));
        runnerImage = provenance.images.botRunner;
          } catch (error) {
        wipeLiveState(preliminaryLive);
        preliminaryLive = undefined;
        throw error;
          }
      if (presence[0] &&
          !safeStringEqual(values.get(REQUIRED_ADDITIONS[0]), runnerImage)) {
        fail("completed_source_mismatch");
      }

      try {
        operationLeaseGuard = checkedOperationLeaseGuard(operationLeaseFactory({
          kubectlExecutable: executable,
          kubectlRunner,
          expectedKubeContext: context,
          namespace
        }));
      } catch (error) {
        if (error instanceof ProcessLocalOldSourceCompletionError) throw error;
        fail("operation_lease_guard_invalid");
      }
      acquireOperationLease(operationLeaseGuard);
      operationLeaseAcquired = true;

      firstLive = captureLivePullState({
        kubectlExecutable: executable,
        kubectlRunner,
        operationLeaseGuard,
        expectedKubeContext: context,
        namespace,
        expectedNamespaceUid: namespaceUid,
        expectedBotImage: botImage
      });
      if (!sameLiveState(preliminaryLive, firstLive)) {
        fail("live_pull_state_changed_before_lease");
      }
      wipeLiveState(preliminaryLive);
      preliminaryLive = undefined;
      // The attested parent and Reticulum images are rollout candidates from a
      // build-only run. AUD-065 intentionally keeps every live workload on its
      // process-local digest, so OLD binds only the derived runner while GHCR
      // verification below uses the parent that is actually present in OLD.
      if (presence[0] &&
          !safeStringEqual(values.get(REQUIRED_ADDITIONS[0]), runnerImage)) {
        fail("attested_runtime_image_mismatch");
      }
      verifyBotPullConfig({
        encoded: firstLive.encodedPullConfig,
        botImage,
        runnerImage
      });
      await withFreshOperationLeaseAsync(operationLeaseGuard, () =>
        verifyGhcrPullAccess({
          encoded: firstLive.encodedPullConfig,
          images: [botImage, runnerImage],
          fetchImpl,
          ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs })
        })
      );
      secondLive = captureLivePullState({
        kubectlExecutable: executable,
        kubectlRunner,
        operationLeaseGuard,
        expectedKubeContext: context,
        namespace,
        expectedNamespaceUid: namespaceUid,
        expectedBotImage: botImage
      });
      if (!sameLiveState(firstLive, secondLive)) {
        fail("live_pull_state_changed");
      }

      if (presence[0]) {
        validateCompletedValues(values, runnerImage, secondLive.encodedPullConfig);
        successToken = command === "verify"
          ? SUCCESS_TOKENS.verified
          : SUCCESS_TOKENS.alreadyComplete;
      } else {
        completedBytes = insertRequiredAdditions(
          sourceBytes,
          runnerImage,
          secondLive.encodedPullConfig
        );
        completedValues = parseValues(completedBytes);
        validateCompletedValues(
          completedValues,
          runnerImage,
          secondLive.encodedPullConfig
        );
        attributionKey = deriveAttributionKey(secondLive.encodedPullConfig);
        let casMutationEntered = false;
        try {
          withFreshOperationLease(operationLeaseGuard, () => {
            casMutationEntered = true;
            replacePrivateProcessLocalValuesSource({
              canonicalValuesPath: resolvedSourcePath,
              expectedBytes: sourceBytes,
              replacementBytes: completedBytes,
              attributionKey,
              hooks: replacementHooks
            });
          });
          confirmedBytes = readPrivateProcessLocalValuesSource(resolvedSourcePath);
          if (!safeBufferEqual(confirmedBytes, completedBytes)) {
            fail("old_source_publication_mismatch");
          }
          thirdLive = captureLivePullState({
            kubectlExecutable: executable,
            kubectlRunner,
            operationLeaseGuard,
            expectedKubeContext: context,
            namespace,
            expectedNamespaceUid: namespaceUid,
            expectedBotImage: botImage
          });
          if (!sameLiveState(secondLive, thirdLive)) {
            fail("live_pull_state_changed_after_cas");
          }
        } catch (error) {
          if (casMutationEntered) {
            rollbackCompletedSourceWithFreshLease({
              operationLeaseGuard,
              sourcePath: resolvedSourcePath,
              sourceBytes,
              completedBytes,
              attributionKey
            });
          }
          throw error;
        }
        successToken = SUCCESS_TOKENS.completed;
      }
          return successToken;
        }
      });
    } catch (error) {
      operationError = error instanceof ProcessLocalOldSourceCompletionError
        ? error
        : new ProcessLocalOldSourceCompletionError("old_source_completion_failed");
    }

    if (operationLeaseAcquired) {
      try {
        releaseOperationLease(operationLeaseGuard);
      } catch (error) {
        releaseError = error instanceof ProcessLocalOldSourceCompletionError
          ? error
          : new ProcessLocalOldSourceCompletionError("operation_lease_release_failed");
      }
      operationLeaseAcquired = false;
    }
    // A release error is ambiguous: the API write may have applied while its
    // acknowledgement was lost. Never roll back a completed local CAS here;
    // the next complete/verify invocation reconciles the exact completed file.
    if (operationError) throw operationError;
    if (releaseError) throw releaseError;
    return successToken;
  } finally {
    if (sourceBytes) sourceBytes.fill(0);
    if (completedBytes) completedBytes.fill(0);
    if (confirmedBytes) confirmedBytes.fill(0);
    if (attributionKey) attributionKey.fill(0);
    wipeMap(values);
    wipeMap(completedValues);
    wipeLiveState(firstLive);
    wipeLiveState(secondLive);
    wipeLiveState(thirdLive);
    wipeLiveState(preliminaryLive);
  }
}

function parseArguments(argv) {
  const command = argv[0];
  const allowed = new Set([
    "--expected-kube-context",
    "--expected-namespace-uid",
    "--receipt",
    "--receipt-bundle",
    "--bot-orchestrator-bundle",
    "--bot-runner-bundle",
    "--reticulum-bundle",
    "--private-work-directory"
  ]);
  if (!["complete", "verify"].includes(command) ||
      argv.length !== 1 + (allowed.size * 2)) {
    fail("arguments_invalid");
  }
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || values.has(flag) || typeof value !== "string" || !value) {
      fail("arguments_invalid");
    }
    values.set(flag, value);
  }
  if (values.size !== allowed.size) fail("arguments_invalid");
  return { command, values };
}

async function main() {
  try {
    const { command, values } = parseArguments(process.argv.slice(2));
    const result = await completeProcessLocalOldSource({
      command,
      expectedKubeContext: values.get("--expected-kube-context"),
      expectedNamespaceUid: values.get("--expected-namespace-uid"),
      receiptPath: values.get("--receipt"),
      receiptBundlePath: values.get("--receipt-bundle"),
      botOrchestratorBundlePath: values.get("--bot-orchestrator-bundle"),
      botRunnerBundlePath: values.get("--bot-runner-bundle"),
      reticulumBundlePath: values.get("--reticulum-bundle"),
      privateWorkDirectory: values.get("--private-work-directory")
    });
    process.stdout.write(`${result}\n`);
  } catch {
    process.stderr.write(GENERIC_ERROR);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

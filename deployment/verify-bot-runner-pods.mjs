#!/usr/bin/env node

// Validates the live, per-room bot-runner Pods without emitting room IDs,
// generation tokens or local credential values. The caller supplies private
// 0600 snapshots and treats any non-zero exit as a hard rollout failure.

import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  readBotOrchestratorConfiguration,
  verifyBotOrchestratorDeployment,
  verifyBotOrchestratorParentPod
} from "./verify-bot-orchestrator-deployment.mjs";

const MAX_JSON_BYTES = 8 * 1024 * 1024;
const TOKEN_VERSION = "v1";
const TOKEN_AUDIENCE = "yenhubs-bot-runner";
const RUNNER_TOKEN_TTL_SECONDS = 3600;
const GENERATED_ENV_NAMES = new Set([
  "BOT_RUNNER_GENERATION_TOKEN",
  "RUNNER_CONTROL_URL",
  "RUNNER_LEASE_HOLDER_ID",
  "RUNNER_POD_UID",
  "RUNNER_PROCESS_GENERATION"
]);
const EXPECTED_RUNNER_STATIC_ENVIRONMENT = Object.freeze({
  GHOST_FEATURED_FETCH_TIMEOUT_MS: "4000",
  GHOST_FEATURED_MAX_BYTES: "524288",
  GHOST_FEATURED_MAX_ENTRIES: "256",
  GHOST_FEATURED_MAX_REDIRECTS: "2",
  GHOST_FEATURED_MAX_REFS: "128",
  GHOST_NAVIGATION_MODE: "navmesh_preferred",
  GHOST_NAVIGATION_RECOVERY_RESTART_MS: "30000",
  GHOST_NAVIGATION_REQUIRE_NAVMESH: "true",
  GHOST_NAVMESH_MAX_ROUTE_POINTS: "64",
  GHOST_NAVMESH_MAX_SNAP_DISTANCE_M: "3",
  GHOST_NAVMESH_MAX_TRIANGLES: "50000",
  GHOST_RAYCAST_MODE: "spoke_colliders",
  GHOST_SCENE_FETCH_TIMEOUT_MS: "10000",
  GHOST_SCENE_MAX_BYTES: "67108864",
  GHOST_SCENE_MAX_EDGES: "200000",
  GHOST_SCENE_MAX_JSON_BYTES: "4194304",
  GHOST_SCENE_MAX_NODES: "50000",
  GHOST_SPAWN_RECOVERY_RESTART_MS: "5000"
});
const RUNNER_STATIC_ENV_NAMES = new Set(Object.keys(EXPECTED_RUNNER_STATIC_ENVIRONMENT));
const ALLOWED_ENV_NAMES = new Set([...GENERATED_ENV_NAMES, ...RUNNER_STATIC_ENV_NAMES]);
const SERVER_POD_METADATA_KEYS = Object.freeze([
  "annotations",
  "creationTimestamp",
  "generation",
  "labels",
  "name",
  "namespace",
  "resourceVersion",
  "uid"
]);
const SERVER_POD_SPEC_KEYS = Object.freeze([
  "activeDeadlineSeconds",
  "automountServiceAccountToken",
  "containers",
  "dnsPolicy",
  "enableServiceLinks",
  "imagePullSecrets",
  "nodeName",
  "preemptionPolicy",
  "priority",
  "restartPolicy",
  "schedulerName",
  "securityContext",
  "serviceAccount",
  "serviceAccountName",
  "shareProcessNamespace",
  "terminationGracePeriodSeconds",
  "tolerations",
  "volumes"
]);
const SERVER_RUNNER_CONTAINER_KEYS = Object.freeze([
  "args",
  "command",
  "env",
  "image",
  "imagePullPolicy",
  "name",
  "readinessProbe",
  "resources",
  "securityContext",
  "terminationMessagePath",
  "terminationMessagePolicy",
  "volumeMounts"
]);
const SERVER_DEFAULT_TOLERATIONS = Object.freeze([
  {
    effect: "NoExecute",
    key: "node.kubernetes.io/not-ready",
    operator: "Exists",
    tolerationSeconds: 300
  },
  {
    effect: "NoExecute",
    key: "node.kubernetes.io/unreachable",
    operator: "Exists",
    tolerationSeconds: 300
  }
]);

class ContractError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function reject(code) {
  throw new ContractError(code);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return object(value) &&
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function exactJson(actual, expected) {
  return isDeepStrictEqual(actual, expected);
}

function sortedUniqueStrings(value, code) {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item)) reject(code);
  const sorted = [...value].sort();
  if (new Set(sorted).size !== sorted.length) reject(code);
  return sorted;
}

function readJson(path, code) {
  let source;
  try {
    const stat = fs.statSync(path);
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_JSON_BYTES) reject(code);
    source = fs.readFileSync(path, "utf8");
    return JSON.parse(source);
  } catch (error) {
    if (error instanceof ContractError) throw error;
    reject(code);
  }
}

function hmacHex(key, value) {
  return crypto.createHmac("sha256", key).update(value).digest("hex");
}

function secureEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyToken(token, key, { hubSid, generation, holderId, recoveryEpoch, nowSeconds }) {
  if (typeof token !== "string" || Buffer.byteLength(token, "utf8") > 2048) {
    reject("token_shape");
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION || !parts[1] || !parts[2]) {
    reject("token_shape");
  }
  const expectedSignature = crypto
    .createHmac("sha256", key)
    .update(`${TOKEN_VERSION}.${parts[1]}`)
    .digest("base64url");
  if (!secureEqual(parts[2], expectedSignature)) reject("token_signature");

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    reject("token_payload");
  }
  if (
    !exactKeys(payload, [
      "aud", "exp", "holder_id", "hub_sid", "process_generation", "recovery_epoch", "v"
    ]) ||
    Buffer.from(JSON.stringify(payload), "utf8").toString("base64url") !== parts[1] ||
    payload.v !== 1 ||
    payload.aud !== TOKEN_AUDIENCE ||
    payload.hub_sid !== hubSid ||
    payload.process_generation !== generation ||
    payload.holder_id !== holderId ||
    payload.recovery_epoch !== recoveryEpoch ||
    !Number.isSafeInteger(payload.exp) ||
    payload.exp <= nowSeconds ||
    payload.exp > nowSeconds + RUNNER_TOKEN_TTL_SECONDS
  ) {
    reject("token_claims");
  }
  return payload;
}

function envRecord(container) {
  if (!Array.isArray(container?.env) || container.env.length === 0 || container.env.length > 64) {
    reject("pod_env_shape");
  }
  const result = new Map();
  for (const entry of container.env) {
    if (!object(entry) || typeof entry.name !== "string" || !ALLOWED_ENV_NAMES.has(entry.name)) {
      reject("pod_env_allowlist");
    }
    if (result.has(entry.name)) reject("pod_env_duplicate");
    if (entry.name === "RUNNER_POD_UID") {
      if (!exactJson(entry, {
        name: "RUNNER_POD_UID",
        valueFrom: { fieldRef: { apiVersion: "v1", fieldPath: "metadata.uid" } }
      })) reject("pod_uid_env");
      result.set(entry.name, entry.valueFrom);
    } else {
      if (!exactKeys(entry, ["name", "value"]) || typeof entry.value !== "string") {
        reject("pod_env_value");
      }
      result.set(entry.name, entry.value);
    }
  }
  for (const required of GENERATED_ENV_NAMES) {
    if (!result.has(required)) reject("pod_env_required");
  }
  if (result.size !== ALLOWED_ENV_NAMES.size) reject("pod_env_exact_set");
  return result;
}

function verifyPod(pod, context) {
  const { key, runnerImage, hubDomain, parent, nowSeconds } = context;
  if (
    !object(pod) || pod.apiVersion !== "v1" || pod.kind !== "Pod" ||
    !exactKeys(pod.metadata, SERVER_POD_METADATA_KEYS) ||
    pod.metadata?.namespace !== parent.runnerNamespace ||
    typeof pod.metadata?.name !== "string" || !pod.metadata.name ||
    typeof pod.metadata?.uid !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      pod.metadata.uid
    ) ||
    typeof pod.metadata.resourceVersion !== "string" ||
    !/^[1-9][0-9]*$/.test(pod.metadata.resourceVersion) ||
    !Number.isSafeInteger(pod.metadata.generation) || pod.metadata.generation < 1 ||
    typeof pod.metadata.creationTimestamp !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(
      pod.metadata.creationTimestamp
    )
  ) reject("pod_metadata");

  const labels = pod.metadata.labels;
  if (!exactKeys(labels, [
    "app",
    "yenhubs.org/generation",
    "yenhubs.org/managed-by",
    "yenhubs.org/room-key",
    "yenhubs.org/runner-protocol"
  ]) ||
      labels.app !== "bot-runner" ||
      labels["yenhubs.org/managed-by"] !== "bot-orchestrator" ||
      labels["yenhubs.org/runner-protocol"] !== "durable-fence-v2") {
    reject("pod_labels");
  }
  const generation = labels["yenhubs.org/generation"];
  const roomKey = labels["yenhubs.org/room-key"];
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(generation) ||
      !/^[0-9a-f]{20}$/.test(roomKey)) reject("pod_identity_labels");

  const annotations = pod.metadata.annotations;
  if (
    !exactKeys(annotations, [
      "yenhubs.org/expires-at",
      "yenhubs.org/parent-name",
      "yenhubs.org/parent-namespace",
      "yenhubs.org/parent-uid"
    ]) ||
    annotations["yenhubs.org/parent-namespace"] !== parent.namespace ||
    annotations["yenhubs.org/parent-name"] !== parent.name ||
    annotations["yenhubs.org/parent-uid"] !== parent.uid
  ) reject("pod_parent_binding");

  const spec = pod.spec;
  if (
    !object(spec) ||
    !exactKeys(spec, SERVER_POD_SPEC_KEYS) ||
    spec.serviceAccountName !== "bot-runner" ||
    spec.serviceAccount !== "bot-runner" ||
    spec.automountServiceAccountToken !== false ||
    !exactJson(spec.imagePullSecrets, [{ name: "bot-images-pull" }]) ||
    spec.enableServiceLinks !== false ||
    spec.dnsPolicy !== "ClusterFirst" ||
    typeof spec.nodeName !== "string" ||
    !/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/.test(spec.nodeName) ||
    spec.nodeName.length > 253 ||
    spec.preemptionPolicy !== "PreemptLowerPriority" ||
    spec.priority !== 0 ||
    spec.restartPolicy !== "Never" ||
    spec.schedulerName !== "default-scheduler" ||
    spec.terminationGracePeriodSeconds !== 10 ||
    spec.activeDeadlineSeconds !== 3600 ||
    spec.shareProcessNamespace !== false ||
    !exactJson(spec.tolerations, SERVER_DEFAULT_TOLERATIONS) ||
    !exactJson(spec.securityContext, {
      runAsNonRoot: true,
      runAsUser: 10001,
      runAsGroup: 10001,
      fsGroup: 10001,
      seccompProfile: { type: "RuntimeDefault" },
      appArmorProfile: { type: "RuntimeDefault" }
    }) ||
    !Array.isArray(spec.containers) || spec.containers.length !== 1 ||
    !exactJson(spec.volumes, [{ name: "runner-tmp", emptyDir: { sizeLimit: "64Mi" } }])
  ) reject("pod_spec");

  const container = spec.containers[0];
  if (
    !exactKeys(container, SERVER_RUNNER_CONTAINER_KEYS) ||
    container.name !== "bot-runner" ||
    container.image !== runnerImage ||
    container.imagePullPolicy !== "Always" ||
    !exactJson(container.command, ["node", "/app/run-ghost-runner.js"]) ||
    !Array.isArray(container.args) || container.args.length !== 5 ||
    container.args[0] !== "--url" || container.args[1] !== `https://${hubDomain}` ||
    container.args[2] !== "--room" || container.args[4] !== "--runner" ||
    typeof container.args[3] !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(container.args[3]) ||
    container.terminationMessagePath !== "/dev/termination-log" ||
    container.terminationMessagePolicy !== "File" ||
    !exactJson(container.securityContext, {
      runAsNonRoot: true,
      runAsUser: 10001,
      runAsGroup: 10001,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
      seccompProfile: { type: "RuntimeDefault" },
      appArmorProfile: { type: "RuntimeDefault" }
    }) ||
    !exactJson(container.resources, {
      requests: { cpu: "25m", memory: "128Mi" },
      limits: { cpu: "500m", memory: "512Mi" }
    }) ||
    !exactJson(container.volumeMounts, [{ name: "runner-tmp", mountPath: "/tmp" }]) ||
    !exactJson(container.readinessProbe, {
      exec: { command: ["test", "-f", "/tmp/runner-ready"] },
      initialDelaySeconds: 5,
      periodSeconds: 5,
      timeoutSeconds: 2,
      successThreshold: 1,
      failureThreshold: 2
    })
  ) reject("pod_container");

  const hubSid = container.args[3];
  const expectedRoomKey = hmacHex(key, hubSid).slice(0, 20);
  const expectedName = `bot-runner-${expectedRoomKey.slice(0, 16)}-${generation.replaceAll("-", "").slice(0, 8)}`;
  if (roomKey !== expectedRoomKey || pod.metadata.name !== expectedName) reject("pod_room_binding");

  const env = envRecord(container);
  if (env.get("RUNNER_CONTROL_URL") !== parent.controlUrl ||
      env.get("RUNNER_LEASE_HOLDER_ID") !== parent.uid ||
      env.get("RUNNER_PROCESS_GENERATION") !== generation) reject("pod_generated_env");
  for (const [name, expectedValue] of parent.runnerEnvironment.entries()) {
    if (env.get(name) !== expectedValue) reject("pod_static_env");
  }
  const tokenPayload = verifyToken(env.get("BOT_RUNNER_GENERATION_TOKEN"), key, {
    hubSid,
    generation,
    holderId: parent.uid,
    recoveryEpoch: parent.recoveryEpoch,
    nowSeconds
  });
  if (annotations["yenhubs.org/expires-at"] !==
      new Date(tokenPayload.exp * 1000).toISOString()) reject("pod_expiry");

  const statuses = pod.status?.containerStatuses;
  const readyCondition = Array.isArray(pod.status?.conditions) &&
    pod.status.conditions.some(condition => condition?.type === "Ready" && condition?.status === "True");
  if (
    pod.status?.phase !== "Running" || !readyCondition ||
    !Array.isArray(statuses) || statuses.length !== 1 ||
    statuses[0]?.name !== "bot-runner" || statuses[0]?.ready !== true ||
    statuses[0]?.restartCount !== 0 || !object(statuses[0]?.state?.running) ||
    typeof statuses[0]?.imageID !== "string"
  ) reject("pod_status");
  const expectedDigest = runnerImage.match(/@sha256:([a-f0-9]{64})$/)?.[1];
  const runtimeDigest = statuses[0].imageID.match(/(?:@|:\/\/)sha256:([a-f0-9]{64})$/)?.[1];
  if (!expectedDigest || runtimeDigest !== expectedDigest) reject("pod_runtime_digest");

  return {
    name: pod.metadata.name,
    uid: pod.metadata.uid,
    publicId: `room-${hmacHex(key, `probe:${hubSid}`).slice(0, 24)}`
  };
}

function verifySnapshot(payload, context) {
  if (!object(payload) || payload.apiVersion !== "v1" || payload.kind !== "PodList" ||
      !Array.isArray(payload.items)) reject("pod_list");
  const verified = payload.items.map(pod => verifyPod(pod, context));
  if (new Set(verified.map(item => item.name)).size !== verified.length ||
      new Set(verified.map(item => item.uid)).size !== verified.length ||
      new Set(verified.map(item => item.publicId)).size !== verified.length) reject("pod_list_duplicate");
  return verified;
}

export function verifyRunnerPodInputs({
  deployment,
  parent,
  podsBefore,
  podsAfter,
  health,
  readiness,
  key,
  botImage,
  runnerImage,
  hubDomain,
  maxActiveRooms,
  maxBotsPerRoom,
  runnerNamespace,
  namespace,
  activationPhase,
  recoveryPhase,
  recoveryEpoch,
  nowSeconds = Math.floor(Date.now() / 1000)
}) {
  if (typeof key !== "string" || Buffer.byteLength(key, "utf8") < 32 ||
      !/^ghcr\.io\/yengalvez\/bot-runner@sha256:[a-f0-9]{64}$/.test(runnerImage) ||
      typeof hubDomain !== "string" || !/^[A-Za-z0-9.-]+$/.test(hubDomain) ||
      typeof namespace !== "string" ||
      !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(namespace) ||
      parent?.metadata?.namespace !== namespace ||
      runnerNamespace !== "hcce-bot-runners" ||
      !["bootstrap", "admission", "active"].includes(activationPhase) ||
      !["active", "restore-fence"].includes(recoveryPhase) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        recoveryEpoch || ""
      ) ||
      !Number.isSafeInteger(nowSeconds)) reject("configuration");

  const deploymentContract = verifyBotOrchestratorDeployment(deployment, {
    namespace,
    runnerNamespace,
    botImage,
    runnerImage,
    hubDomain,
    accessKey: key,
    maxActiveRooms,
    maxBotsPerRoom,
    activationPhase,
    recoveryPhase,
    recoveryEpoch
  });
  const parentIdentity = verifyBotOrchestratorParentPod(parent, deploymentContract);
  const expected = sortedUniqueStrings(readiness?.expected_hubs, "readiness_expected_hubs");
  if (expected.length < 1 ||
      readiness?.configured_room_count !== expected.length ||
      health?.runner_pods !== expected.length ||
      !Number.isSafeInteger(health?.runner_pods) ||
      sortedUniqueStrings(readiness?.process_hubs, "readiness_process_hubs").join("\0") !== expected.join("\0") ||
      sortedUniqueStrings(readiness?.active_hubs, "readiness_active_hubs").join("\0") !== expected.join("\0") ||
      sortedUniqueStrings(health?.active_hubs, "health_active_hubs").join("\0") !== expected.join("\0") ||
      !object(readiness?.runner_bots) || Object.keys(readiness.runner_bots).sort().join("\0") !== expected.join("\0") ||
      !object(health?.runner_bots) || Object.keys(health.runner_bots).sort().join("\0") !== expected.join("\0")) {
    reject("runtime_room_set");
  }

  const context = { key, runnerImage, hubDomain, parent: parentIdentity, nowSeconds };
  const before = verifySnapshot(podsBefore, context);
  const after = verifySnapshot(podsAfter, context);
  const beforeIdentity = before.map(item => `${item.name}\0${item.uid}`).sort();
  const afterIdentity = after.map(item => `${item.name}\0${item.uid}`).sort();
  const podPublicIds = before.map(item => item.publicId).sort();
  if (before.length !== expected.length ||
      beforeIdentity.join("\n") !== afterIdentity.join("\n") ||
      podPublicIds.join("\0") !== expected.join("\0")) reject("pod_snapshot_set");
  return true;
}

function parseArguments(argv) {
  const allowed = new Set([
    "--values", "--namespace", "--runner-namespace", "--deployment", "--parent", "--pods-before", "--pods-after",
    "--health", "--readiness"
  ]);
  const result = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || typeof value !== "string" || !value || result.has(name)) reject("arguments");
    result.set(name, value);
  }
  if (result.size !== allowed.size || argv.length !== allowed.size * 2) reject("arguments");
  return result;
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const valuesPath = args.get("--values");
  const configuration = readBotOrchestratorConfiguration(
    valuesPath,
    args.get("--namespace"),
    args.get("--runner-namespace")
  );
  verifyRunnerPodInputs({
    deployment: readJson(args.get("--deployment"), "deployment_json"),
    parent: readJson(args.get("--parent"), "parent_json"),
    podsBefore: readJson(args.get("--pods-before"), "pods_before_json"),
    podsAfter: readJson(args.get("--pods-after"), "pods_after_json"),
    health: readJson(args.get("--health"), "health_json"),
    readiness: readJson(args.get("--readiness"), "readiness_json"),
    key: configuration.accessKey,
    botImage: configuration.botImage,
    runnerImage: configuration.runnerImage,
    hubDomain: configuration.hubDomain,
    maxActiveRooms: configuration.maxActiveRooms,
    maxBotsPerRoom: configuration.maxBotsPerRoom,
    runnerNamespace: configuration.runnerNamespace,
    namespace: configuration.namespace,
    activationPhase: configuration.activationPhase,
    recoveryPhase: configuration.recoveryPhase,
    recoveryEpoch: configuration.recoveryEpoch
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  try {
    main();
  } catch (error) {
    const code = error instanceof ContractError ? error.code : "unexpected";
    process.stderr.write(`Bot runner Pod contract failed: ${code}.\n`);
    process.exit(1);
  }
}

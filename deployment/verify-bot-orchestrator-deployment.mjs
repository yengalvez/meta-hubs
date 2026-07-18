#!/usr/bin/env node

// Canonical live contract for the bot-orchestrator Deployment returned by the
// Kubernetes API. The verifier accepts only server defaults that Kubernetes
// may materialize in a GET response; every generator-owned field is exact.

import crypto from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const require = createRequire(import.meta.url);
const VALUES_PARSER = fileURLToPath(new URL("./parse-local-values.mjs", import.meta.url));
const GENERATOR_CONTRACT = fileURLToPath(new URL(
  "../hubs-cloud/community-edition/generate_script/verify-manifest-contracts.js",
  import.meta.url
));
const {
  BOT_ORCHESTRATOR_ALLOWED_ENV_NAMES,
  BOT_ORCHESTRATOR_RUNTIME_ENV,
  BOT_ORCHESTRATOR_SECURITY_CONTEXT
} = require(GENERATOR_CONTRACT);

const MAX_JSON_BYTES = 8 * 1024 * 1024;
const RUNNER_NAMESPACE = "hcce-bot-runners";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATIC_ENVIRONMENT = Object.freeze({
  OPENAI_MODEL: "gpt-5-nano",
  OPENAI_TOTAL_BUDGET_MS: "4000",
  ...BOT_ORCHESTRATOR_RUNTIME_ENV,
  GHOST_NAVIGATION_RECOVERY_RESTART_MS: "30000",
  GHOST_SPAWN_RECOVERY_RESTART_MS: "5000",
  GHOST_NAVMESH_MAX_TRIANGLES: "50000",
  GHOST_NAVMESH_MAX_ROUTE_POINTS: "64",
  GHOST_NAVMESH_MAX_SNAP_DISTANCE_M: "3",
  GHOST_FEATURED_FETCH_TIMEOUT_MS: "4000",
  GHOST_FEATURED_MAX_BYTES: "524288",
  GHOST_FEATURED_MAX_REDIRECTS: "2",
  GHOST_FEATURED_MAX_ENTRIES: "256",
  GHOST_FEATURED_MAX_REFS: "128",
  GHOST_SCENE_FETCH_TIMEOUT_MS: "10000",
  GHOST_SCENE_MAX_BYTES: "67108864",
  GHOST_SCENE_MAX_JSON_BYTES: "4194304",
  GHOST_SCENE_MAX_NODES: "50000",
  GHOST_SCENE_MAX_EDGES: "200000",
  RET_SYNC_TIMEOUT_MS: "5000",
  RET_SNAPSHOT_TTL_MS: "120000",
  RUNNER_CONFIG_ACK_TIMEOUT_MS: "15000",
  RUNNER_STARTUP_GRACE_MS: "180000",
  RUNNER_STALE_RESTART_MS: "30000",
  RUNNER_TERMINAL_RECOVERY_GRACE_MS: "15000",
  RUNNER_WATCHDOG_INTERVAL_MS: "5000",
  RUNNER_RESTART_BASE_MS: "3000",
  RUNNER_RESTART_MAX_MS: "60000",
  RUNNER_STABLE_RESET_MS: "30000",
  RUNNER_TERMINATION_GRACE_MS: "10000",
  RUNNER_KILL_GRACE_MS: "5000",
  MAX_BOTS_PER_ROOM: "10"
});
const RUNNER_STATIC_ENV_NAMES = Object.freeze([
  "GHOST_FEATURED_FETCH_TIMEOUT_MS",
  "GHOST_FEATURED_MAX_BYTES",
  "GHOST_FEATURED_MAX_ENTRIES",
  "GHOST_FEATURED_MAX_REDIRECTS",
  "GHOST_FEATURED_MAX_REFS",
  "GHOST_NAVIGATION_MODE",
  "GHOST_NAVIGATION_RECOVERY_RESTART_MS",
  "GHOST_NAVIGATION_REQUIRE_NAVMESH",
  "GHOST_NAVMESH_MAX_ROUTE_POINTS",
  "GHOST_NAVMESH_MAX_SNAP_DISTANCE_M",
  "GHOST_NAVMESH_MAX_TRIANGLES",
  "GHOST_RAYCAST_MODE",
  "GHOST_SCENE_FETCH_TIMEOUT_MS",
  "GHOST_SCENE_MAX_BYTES",
  "GHOST_SCENE_MAX_EDGES",
  "GHOST_SCENE_MAX_JSON_BYTES",
  "GHOST_SCENE_MAX_NODES",
  "GHOST_SPAWN_RECOVERY_RESTART_MS"
]);
const SECRET_ENVIRONMENT = Object.freeze({
  BOT_ORCHESTRATOR_ACCESS_KEY: "BOT_ORCHESTRATOR_ACCESS_KEY",
  OPENAI_API_KEY: "OPENAI_API_KEY"
});
const DOWNWARD_ENVIRONMENT = Object.freeze({
  POD_NAMESPACE: "metadata.namespace",
  ORCHESTRATOR_POD_NAME: "metadata.name",
  ORCHESTRATOR_POD_UID: "metadata.uid"
});

export class BotOrchestratorContractError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function reject(code) {
  throw new BotOrchestratorContractError(code);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactJson(actual, expected) {
  return isDeepStrictEqual(actual, expected);
}

function exactKeys(value, expected) {
  return object(value) &&
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function allowedKeys(value, required, optional, code) {
  if (!object(value)) reject(code);
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (required.some(key => !Object.hasOwn(value, key)) || keys.some(key => !allowed.has(key))) {
    reject(code);
  }
}

function optionalDefault(value, key, expected, code) {
  if (Object.hasOwn(value, key) && !exactJson(value[key], expected)) reject(code);
}

function optionalFalse(value, key, code) {
  if (Object.hasOwn(value, key) && value[key] !== false) reject(code);
}

function readJson(path, code) {
  try {
    const stat = fs.statSync(path);
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_JSON_BYTES) reject(code);
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof BotOrchestratorContractError) throw error;
    reject(code);
  }
}

function readValue(valuesPath, key) {
  try {
    return execFileSync(process.execPath, [VALUES_PARSER, valuesPath, "--get", key], {
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    reject("values_unreadable");
  }
}

export function readBotOrchestratorConfiguration(valuesPath, namespace, runnerNamespace) {
  return {
    namespace,
    runnerNamespace,
    botImage: readValue(valuesPath, "OVERRIDE_BOT_ORCHESTRATOR_IMAGE"),
    runnerImage: readValue(valuesPath, "OVERRIDE_BOT_RUNNER_IMAGE"),
    hubDomain: readValue(valuesPath, "HUB_DOMAIN"),
    accessKey: readValue(valuesPath, "BOT_ORCHESTRATOR_ACCESS_KEY"),
    maxActiveRooms: readValue(valuesPath, "MAX_ACTIVE_ROOMS"),
    maxBotsPerRoom: readValue(valuesPath, "MAX_BOTS_PER_ROOM"),
    activationPhase: readValue(valuesPath, "BOT_RUNNER_ACTIVATION_PHASE"),
    recoveryPhase: readValue(valuesPath, "BOT_RUNNER_RECOVERY_PHASE"),
    recoveryEpoch: readValue(valuesPath, "BOT_RUNNER_RECOVERY_EPOCH")
  };
}

function verifyConfiguration(configuration) {
  if (
    !object(configuration) ||
    typeof configuration.namespace !== "string" ||
    !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(configuration.namespace) ||
    configuration.runnerNamespace !== RUNNER_NAMESPACE ||
    configuration.runnerNamespace === configuration.namespace ||
    !/^ghcr\.io\/yengalvez\/bot-orchestrator@sha256:[a-f0-9]{64}$/.test(configuration.botImage) ||
    !/^ghcr\.io\/yengalvez\/bot-runner@sha256:[a-f0-9]{64}$/.test(configuration.runnerImage) ||
    typeof configuration.hubDomain !== "string" ||
    !/^[A-Za-z0-9.-]+$/.test(configuration.hubDomain) ||
    typeof configuration.accessKey !== "string" ||
    Buffer.byteLength(configuration.accessKey, "utf8") < 32 ||
    typeof configuration.maxActiveRooms !== "string" ||
    !/^(?:[1-9]|10)$/.test(configuration.maxActiveRooms) ||
    configuration.maxBotsPerRoom !== "10" ||
    !["bootstrap", "admission", "active"].includes(configuration.activationPhase) ||
    !["active", "restore-fence"].includes(configuration.recoveryPhase) ||
    !UUID_V4.test(configuration.recoveryEpoch)
  ) reject("configuration");
}

function expectedEnvironment(configuration) {
  const literals = {
    ...STATIC_ENVIRONMENT,
    BOT_RUNNER_IMAGE: configuration.runnerImage,
    BOT_RUNNER_RECOVERY_EPOCH: configuration.recoveryEpoch,
    RUNNER_POD_NAMESPACE: configuration.runnerNamespace,
    RUNNER_CONTROL_URL:
      `http://bot-orchestrator.${configuration.namespace}.svc.cluster.local:5001`,
    HUBS_BASE_URL: `https://${configuration.hubDomain}`,
    MAX_ACTIVE_ROOMS: configuration.maxActiveRooms,
    MAX_BOTS_PER_ROOM: configuration.maxBotsPerRoom
  };
  return BOT_ORCHESTRATOR_ALLOWED_ENV_NAMES.map(name => {
    if (Object.hasOwn(SECRET_ENVIRONMENT, name)) {
      return {
        name,
        valueFrom: { secretKeyRef: { name: "configs", key: SECRET_ENVIRONMENT[name] } }
      };
    }
    if (Object.hasOwn(DOWNWARD_ENVIRONMENT, name)) {
      return {
        name,
        valueFrom: { fieldRef: { apiVersion: "v1", fieldPath: DOWNWARD_ENVIRONMENT[name] } }
      };
    }
    if (!Object.hasOwn(literals, name) || typeof literals[name] !== "string") {
      reject("environment_definition");
    }
    return { name, value: literals[name] };
  });
}

function verifyProbe(probe, { path, initialDelaySeconds, periodSeconds }, code) {
  allowedKeys(
    probe,
    ["httpGet", "initialDelaySeconds", "periodSeconds"],
    ["timeoutSeconds", "successThreshold", "failureThreshold", "terminationGracePeriodSeconds"],
    code
  );
  if (probe.initialDelaySeconds !== initialDelaySeconds || probe.periodSeconds !== periodSeconds) reject(code);
  optionalDefault(probe, "timeoutSeconds", 1, code);
  optionalDefault(probe, "successThreshold", 1, code);
  optionalDefault(probe, "failureThreshold", 3, code);
  if (Object.hasOwn(probe, "terminationGracePeriodSeconds")) reject(code);
  allowedKeys(probe.httpGet, ["path", "port"], ["host", "scheme", "httpHeaders"], code);
  if (probe.httpGet.path !== path || probe.httpGet.port !== 5001) reject(code);
  optionalDefault(probe.httpGet, "host", "", code);
  optionalDefault(probe.httpGet, "scheme", "HTTP", code);
  optionalDefault(probe.httpGet, "httpHeaders", [], code);
}

function verifySecurityContext(securityContext, code) {
  allowedKeys(
    securityContext,
    Object.keys(BOT_ORCHESTRATOR_SECURITY_CONTEXT),
    ["privileged", "procMount"],
    code
  );
  optionalFalse(securityContext, "privileged", code);
  optionalDefault(securityContext, "procMount", "Default", code);
  for (const [name, expected] of Object.entries(BOT_ORCHESTRATOR_SECURITY_CONTEXT)) {
    if (!exactJson(securityContext[name], expected)) reject(code);
  }
}

function verifyPort(port, code) {
  allowedKeys(port, ["containerPort", "name"], ["protocol", "hostPort", "hostIP"], code);
  if (port.containerPort !== 5001 || port.name !== "http") reject(code);
  optionalDefault(port, "protocol", "TCP", code);
  optionalDefault(port, "hostPort", 0, code);
  optionalDefault(port, "hostIP", "", code);
}

function verifyTmpMount(mount, code) {
  allowedKeys(mount, ["name", "mountPath"], ["readOnly", "subPath", "subPathExpr"], code);
  if (mount.name !== "bot-orchestrator-tmp" || mount.mountPath !== "/tmp") reject(code);
  optionalFalse(mount, "readOnly", code);
  optionalDefault(mount, "subPath", "", code);
  optionalDefault(mount, "subPathExpr", "", code);
}

function verifyServiceAccountMount(mount, volumeName, code) {
  if (!exactJson(mount, {
    name: volumeName,
    readOnly: true,
    mountPath: "/var/run/secrets/kubernetes.io/serviceaccount"
  })) reject(code);
}

function verifyContainer(container, configuration, code, serviceAccountVolumeName = null) {
  allowedKeys(
    container,
    [
      "name", "image", "securityContext", "resources", "imagePullPolicy", "ports", "env",
      "volumeMounts", "livenessProbe", "readinessProbe"
    ],
    ["terminationMessagePath", "terminationMessagePolicy"],
    code
  );
  if (
    container.name !== "bot-orchestrator" ||
    container.image !== configuration.botImage ||
    container.imagePullPolicy !== "IfNotPresent" ||
    !exactJson(container.resources, {
      requests: { cpu: "25m", memory: "128Mi" },
      limits: { memory: "512Mi" }
    }) ||
    !Array.isArray(container.ports) || container.ports.length !== 1 ||
    !Array.isArray(container.volumeMounts) ||
    container.volumeMounts.length !== (serviceAccountVolumeName === null ? 1 : 2) ||
    !exactJson(container.env, expectedEnvironment(configuration))
  ) reject(code);
  optionalDefault(container, "terminationMessagePath", "/dev/termination-log", code);
  optionalDefault(container, "terminationMessagePolicy", "File", code);
  verifySecurityContext(container.securityContext, code);
  verifyPort(container.ports[0], code);
  const tmpMounts = container.volumeMounts.filter(mount => mount?.name === "bot-orchestrator-tmp");
  if (tmpMounts.length !== 1) reject(code);
  verifyTmpMount(tmpMounts[0], code);
  if (serviceAccountVolumeName !== null) {
    const serviceAccountMounts = container.volumeMounts.filter(mount => mount?.name === serviceAccountVolumeName);
    if (serviceAccountMounts.length !== 1) reject(code);
    verifyServiceAccountMount(serviceAccountMounts[0], serviceAccountVolumeName, code);
  }
  verifyProbe(container.livenessProbe, { path: "/health", initialDelaySeconds: 10, periodSeconds: 15 }, code);
  verifyProbe(
    container.readinessProbe,
    { path: "/transport-ready", initialDelaySeconds: 5, periodSeconds: 10 },
    code
  );
}

function verifyPodSpec(podSpec, configuration) {
  allowedKeys(
    podSpec,
    ["serviceAccountName", "automountServiceAccountToken", "imagePullSecrets", "containers", "volumes"],
    [
      "restartPolicy", "terminationGracePeriodSeconds", "dnsPolicy", "securityContext",
      "schedulerName", "enableServiceLinks", "hostNetwork", "hostPID", "hostIPC",
      "shareProcessNamespace", "hostUsers", "preemptionPolicy", "serviceAccount"
    ],
    "pod_spec"
  );
  if (
    podSpec.serviceAccountName !== "bot-orchestrator" ||
    podSpec.automountServiceAccountToken !== true ||
    !exactJson(podSpec.imagePullSecrets, [{ name: "bot-images-pull" }]) ||
    !Array.isArray(podSpec.containers) || podSpec.containers.length !== 1 ||
    !exactJson(podSpec.volumes, [{ name: "bot-orchestrator-tmp", emptyDir: { sizeLimit: "256Mi" } }])
  ) reject("pod_spec");
  optionalDefault(podSpec, "restartPolicy", "Always", "pod_spec");
  optionalDefault(podSpec, "terminationGracePeriodSeconds", 30, "pod_spec");
  optionalDefault(podSpec, "dnsPolicy", "ClusterFirst", "pod_spec");
  optionalDefault(podSpec, "securityContext", {}, "pod_spec");
  optionalDefault(podSpec, "schedulerName", "default-scheduler", "pod_spec");
  optionalDefault(podSpec, "enableServiceLinks", true, "pod_spec");
  optionalFalse(podSpec, "hostNetwork", "pod_spec");
  optionalFalse(podSpec, "hostPID", "pod_spec");
  optionalFalse(podSpec, "hostIPC", "pod_spec");
  optionalFalse(podSpec, "shareProcessNamespace", "pod_spec");
  optionalDefault(podSpec, "hostUsers", true, "pod_spec");
  optionalDefault(podSpec, "preemptionPolicy", "PreemptLowerPriority", "pod_spec");
  optionalDefault(podSpec, "serviceAccount", "bot-orchestrator", "pod_spec");
  verifyContainer(podSpec.containers[0], configuration, "container");
}

function extractDeployment(payload, namespace) {
  if (object(payload) && payload.apiVersion === "apps/v1" && payload.kind === "Deployment") {
    return payload;
  }
  if (
    object(payload) &&
    ((payload.apiVersion === "apps/v1" && payload.kind === "DeploymentList") ||
      (payload.apiVersion === "v1" && payload.kind === "List")) &&
    Array.isArray(payload.items)
  ) {
    const matches = payload.items.filter(item =>
      item?.apiVersion === "apps/v1" && item?.kind === "Deployment" &&
      item?.metadata?.namespace === namespace && item?.metadata?.name === "bot-orchestrator"
    );
    if (matches.length === 1) return matches[0];
  }
  reject("deployment_selection");
}

export function verifyBotOrchestratorDeployment(payload, configuration) {
  verifyConfiguration(configuration);
  const deployment = extractDeployment(payload, configuration.namespace);
  if (
    deployment.metadata?.name !== "bot-orchestrator" ||
    deployment.metadata?.namespace !== configuration.namespace ||
    typeof deployment.metadata?.uid !== "string" || !deployment.metadata.uid ||
    deployment.metadata?.deletionTimestamp != null
  ) reject("deployment_metadata");
  const annotations = deployment.metadata?.annotations;
  if (
    !object(annotations) ||
    annotations["cluster-autoscaler.kubernetes.io/safe-to-evict"] !== "true" ||
    annotations["yenhubs.org/runner-activation-phase"] !== configuration.activationPhase ||
    annotations["yenhubs.org/bot-runner-recovery-phase"] !== configuration.recoveryPhase ||
    annotations["yenhubs.org/bot-runner-recovery-epoch"] !== configuration.recoveryEpoch
  ) {
    reject("deployment_metadata");
  }
  const allowedMetadataAnnotations = new Set([
    "cluster-autoscaler.kubernetes.io/safe-to-evict",
    "yenhubs.org/runner-activation-phase",
    "yenhubs.org/bot-runner-recovery-phase",
    "yenhubs.org/bot-runner-recovery-epoch",
    "deployment.kubernetes.io/revision",
    "kubectl.kubernetes.io/last-applied-configuration"
  ]);
  if (Object.keys(annotations).some(name => !allowedMetadataAnnotations.has(name))) {
    reject("deployment_metadata");
  }
  if (Object.hasOwn(annotations, "deployment.kubernetes.io/revision") &&
      !/^[1-9][0-9]*$/.test(annotations["deployment.kubernetes.io/revision"])) {
    reject("deployment_metadata");
  }
  if (Object.hasOwn(annotations, "kubectl.kubernetes.io/last-applied-configuration")) {
    try {
      const applied = JSON.parse(annotations["kubectl.kubernetes.io/last-applied-configuration"]);
      if (applied?.apiVersion !== "apps/v1" || applied?.kind !== "Deployment" ||
          applied?.metadata?.name !== "bot-orchestrator" ||
          applied?.metadata?.namespace !== configuration.namespace) reject("deployment_metadata");
    } catch (error) {
      if (error instanceof BotOrchestratorContractError) throw error;
      reject("deployment_metadata");
    }
  }

  const spec = deployment.spec;
  const expectedReplicas = configuration.recoveryPhase === "restore-fence" ||
    configuration.activationPhase === "bootstrap" ? 0 : 1;
  allowedKeys(
    spec,
    ["replicas", "strategy", "selector", "template"],
    ["revisionHistoryLimit", "progressDeadlineSeconds", "paused", "minReadySeconds"],
    "deployment_spec"
  );
  if (
    spec.replicas !== expectedReplicas ||
    !exactJson(spec.strategy, { type: "Recreate" }) ||
    !exactJson(spec.selector, { matchLabels: { app: "bot-orchestrator" } })
  ) reject("deployment_spec");
  optionalDefault(spec, "revisionHistoryLimit", 10, "deployment_spec");
  optionalDefault(spec, "progressDeadlineSeconds", 600, "deployment_spec");
  optionalFalse(spec, "paused", "deployment_spec");
  optionalDefault(spec, "minReadySeconds", 0, "deployment_spec");
  if (!exactKeys(spec.template, ["metadata", "spec"])) reject("pod_template");
  allowedKeys(spec.template.metadata, ["labels", "annotations"], ["creationTimestamp"], "pod_template");
  optionalDefault(spec.template.metadata, "creationTimestamp", null, "pod_template");
  const templateAnnotations = spec.template.metadata.annotations;
  const checksumAnnotation = "yenhubs.org/bot-orchestrator-access-key-checksum";
  const recoveryEpochAnnotation = "yenhubs.org/bot-runner-recovery-epoch";
  const restartedAtAnnotation = "kubectl.kubernetes.io/restartedAt";
  if (
    !exactJson(spec.template.metadata.labels, { app: "bot-orchestrator" }) ||
    !object(templateAnnotations) ||
    Object.keys(templateAnnotations).some(name =>
      name !== checksumAnnotation && name !== recoveryEpochAnnotation && name !== restartedAtAnnotation
    ) ||
    templateAnnotations[checksumAnnotation] !== crypto
      .createHash("sha256")
      .update(configuration.accessKey)
      .digest("hex") ||
    templateAnnotations[recoveryEpochAnnotation] !== configuration.recoveryEpoch
  ) reject("pod_template");
  if (Object.hasOwn(templateAnnotations, restartedAtAnnotation)) {
    const restartedAt = templateAnnotations[restartedAtAnnotation];
    if (typeof restartedAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(restartedAt) ||
        !Number.isFinite(Date.parse(restartedAt))) reject("pod_template");
  }
  verifyPodSpec(spec.template.spec, configuration);

  const container = spec.template.spec.containers[0];
  const environment = new Map(container.env.map(entry => [entry.name, entry.value]));
  const runnerEnvironment = new Map(
    RUNNER_STATIC_ENV_NAMES.map(name => [name, environment.get(name)])
  );
  return Object.freeze({
    name: deployment.metadata.name,
    namespace: deployment.metadata.namespace,
    uid: deployment.metadata.uid,
    environment: structuredClone(container.env),
    runnerEnvironment,
    runnerNamespace: configuration.runnerNamespace,
    recoveryEpoch: configuration.recoveryEpoch,
    controlUrl: `http://bot-orchestrator.${configuration.namespace}.svc.cluster.local:5001`,
    image: container.image,
    annotations: structuredClone(templateAnnotations),
    configuration: Object.freeze({ ...configuration })
  });
}

function verifyServiceAccountVolume(volume, code) {
  if (!object(volume) || typeof volume.name !== "string" ||
      !/^kube-api-access-[a-z0-9]{5}$/.test(volume.name) ||
      !exactJson(volume.projected, {
        defaultMode: 420,
        sources: [
          { serviceAccountToken: { expirationSeconds: 3607, path: "token" } },
          {
            configMap: {
              name: "kube-root-ca.crt",
              items: [{ key: "ca.crt", path: "ca.crt" }]
            }
          },
          {
            downwardAPI: {
              items: [{
                path: "namespace",
                fieldRef: { apiVersion: "v1", fieldPath: "metadata.namespace" }
              }]
            }
          }
        ]
      }) || !exactKeys(volume, ["name", "projected"])) reject(code);
  return volume.name;
}

function verifyRuntimePodSpec(podSpec, deploymentContract) {
  allowedKeys(
    podSpec,
    [
      "serviceAccountName", "serviceAccount", "automountServiceAccountToken", "imagePullSecrets",
      "containers", "volumes", "restartPolicy", "terminationGracePeriodSeconds", "dnsPolicy",
      "securityContext", "schedulerName", "enableServiceLinks", "nodeName", "preemptionPolicy",
      "priority", "tolerations"
    ],
    ["hostNetwork", "hostPID", "hostIPC", "shareProcessNamespace", "hostUsers"],
    "parent_pod_spec"
  );
  if (
    podSpec.serviceAccountName !== "bot-orchestrator" ||
    podSpec.serviceAccount !== "bot-orchestrator" ||
    podSpec.automountServiceAccountToken !== true ||
    !exactJson(podSpec.imagePullSecrets, [{ name: "bot-images-pull" }]) ||
    podSpec.restartPolicy !== "Always" ||
    podSpec.terminationGracePeriodSeconds !== 30 ||
    podSpec.dnsPolicy !== "ClusterFirst" ||
    !exactJson(podSpec.securityContext, {}) ||
    podSpec.schedulerName !== "default-scheduler" ||
    podSpec.enableServiceLinks !== true ||
    typeof podSpec.nodeName !== "string" || !podSpec.nodeName ||
    podSpec.preemptionPolicy !== "PreemptLowerPriority" ||
    podSpec.priority !== 0 ||
    !exactJson(podSpec.tolerations, [
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
    ]) ||
    !Array.isArray(podSpec.containers) || podSpec.containers.length !== 1 ||
    !Array.isArray(podSpec.volumes) || podSpec.volumes.length !== 2
  ) reject("parent_pod_spec");
  optionalFalse(podSpec, "hostNetwork", "parent_pod_spec");
  optionalFalse(podSpec, "hostPID", "parent_pod_spec");
  optionalFalse(podSpec, "hostIPC", "parent_pod_spec");
  optionalFalse(podSpec, "shareProcessNamespace", "parent_pod_spec");
  optionalDefault(podSpec, "hostUsers", true, "parent_pod_spec");
  const tmpVolumes = podSpec.volumes.filter(volume => volume?.name === "bot-orchestrator-tmp");
  if (tmpVolumes.length !== 1 ||
      !exactJson(tmpVolumes[0], { name: "bot-orchestrator-tmp", emptyDir: { sizeLimit: "256Mi" } })) {
    reject("parent_volumes");
  }
  const projectedVolumes = podSpec.volumes.filter(volume => volume?.name !== "bot-orchestrator-tmp");
  if (projectedVolumes.length !== 1) reject("parent_volumes");
  const serviceAccountVolumeName = verifyServiceAccountVolume(projectedVolumes[0], "parent_volumes");
  verifyContainer(
    podSpec.containers[0],
    deploymentContract.configuration,
    "parent_container",
    serviceAccountVolumeName
  );
}

export function verifyBotOrchestratorParentPod(parent, deploymentContract) {
  if (
    !object(parent) || parent.apiVersion !== "v1" || parent.kind !== "Pod" ||
    typeof parent.metadata?.name !== "string" || !parent.metadata.name ||
    parent.metadata?.namespace !== deploymentContract.namespace ||
    typeof parent.metadata?.uid !== "string" || !parent.metadata.uid ||
    !exactJson(parent.metadata?.annotations, deploymentContract.annotations) ||
    !exactJson(parent.metadata?.labels, {
      app: "bot-orchestrator",
      "pod-template-hash": parent.metadata?.labels?.["pod-template-hash"]
    }) ||
    !/^[a-z0-9]{8,16}$/.test(parent.metadata?.labels?.["pod-template-hash"] || "") ||
    !Array.isArray(parent.metadata?.ownerReferences) ||
    parent.metadata.ownerReferences.length !== 1 ||
    parent.metadata.ownerReferences[0]?.apiVersion !== "apps/v1" ||
    parent.metadata.ownerReferences[0]?.kind !== "ReplicaSet" ||
    typeof parent.metadata.ownerReferences[0]?.name !== "string" ||
    !parent.metadata.ownerReferences[0].name ||
    typeof parent.metadata.ownerReferences[0]?.uid !== "string" ||
    !parent.metadata.ownerReferences[0].uid ||
    parent.metadata.ownerReferences[0]?.controller !== true ||
    parent.metadata.ownerReferences[0]?.blockOwnerDeletion !== true ||
    parent.metadata?.deletionTimestamp != null ||
    parent.status?.phase !== "Running" ||
    !Array.isArray(parent.status?.conditions) ||
    !parent.status.conditions.some(condition => condition?.type === "Ready" && condition?.status === "True")
  ) reject("parent_contract");
  verifyRuntimePodSpec(parent.spec, deploymentContract);
  const statuses = parent.status?.containerStatuses;
  if (
    !Array.isArray(statuses) || statuses.length !== 1 ||
    statuses[0]?.name !== "bot-orchestrator" || statuses[0]?.ready !== true ||
    statuses[0]?.started !== true || !object(statuses[0]?.state?.running) ||
    typeof statuses[0]?.imageID !== "string"
  ) reject("parent_status");
  const expectedDigest = deploymentContract.image.match(/@sha256:([a-f0-9]{64})$/)?.[1];
  const runtimeDigest = statuses[0].imageID.match(/(?:@|:\/\/)sha256:([a-f0-9]{64})$/)?.[1];
  if (!expectedDigest || runtimeDigest !== expectedDigest) reject("parent_runtime_digest");
  return {
    name: parent.metadata.name,
    namespace: parent.metadata.namespace,
    uid: parent.metadata.uid,
    runnerEnvironment: deploymentContract.runnerEnvironment,
    runnerNamespace: deploymentContract.runnerNamespace,
    recoveryEpoch: deploymentContract.recoveryEpoch,
    controlUrl: deploymentContract.controlUrl
  };
}

function parseArguments(argv) {
  const allowed = new Set(["--values", "--namespace", "--runner-namespace", "--deployment"]);
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
  verifyBotOrchestratorDeployment(
    readJson(args.get("--deployment"), "deployment_json"),
    readBotOrchestratorConfiguration(
      args.get("--values"),
      args.get("--namespace"),
      args.get("--runner-namespace")
    )
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  try {
    main();
  } catch (error) {
    const code = error instanceof BotOrchestratorContractError ? error.code : "unexpected";
    process.stderr.write(`Bot orchestrator Deployment contract failed: ${code}.\n`);
    process.exit(1);
  }
}

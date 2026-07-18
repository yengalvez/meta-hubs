#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { verifyRunnerPodInputs } from "../../deployment/verify-bot-runner-pods.mjs";
import {
  deploymentConfiguration,
  fixtureDeployment,
  fixtureParentPod
} from "./bot-orchestrator-deployment-fixture.mjs";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../", import.meta.url));
const hubsCloudRoot = process.env.YENHUBS_HUBS_CLOUD_ROOT || `${root}/hubs-cloud`;
const { KubernetesRunnerManager } = require(
  `${hubsCloudRoot}/community-edition/services/bot-orchestrator/kubernetes-runner-manager.js`
);
const { createRunnerGenerationToken } = require(
  `${hubsCloudRoot}/community-edition/services/bot-orchestrator/runner-generation-token.js`
);

const key = "k".repeat(64);
const runnerImage = `ghcr.io/yengalvez/bot-runner@sha256:${"a".repeat(64)}`;
const hubDomain = "example.invalid";
const hubSid = "Room_1";
const generation = "11111111-1111-4111-8111-111111111111";
const nowSeconds = 2_000_000_000;
const recoveryEpoch = deploymentConfiguration.recoveryEpoch;
const runnerEnvironment = {
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
};
const parent = fixtureParentPod();

const manager = new KubernetesRunnerManager({
  api: { request: async () => ({}) },
  namespace: deploymentConfiguration.runnerNamespace,
  parentNamespace: deploymentConfiguration.namespace,
  ownerPodName: parent.metadata.name,
  ownerPodUid: parent.metadata.uid,
  runnerImage,
  hubsBaseUrl: `https://${hubDomain}`,
  controlUrl: `http://bot-orchestrator.${deploymentConfiguration.namespace}.svc.cluster.local:5001`,
  credentialKey: key,
  runnerEnvironment,
  tokenFactory: claims => createRunnerGenerationToken({ key, recoveryEpoch, ...claims }),
  tokenTtlSeconds: 3600,
  now: () => nowSeconds * 1000
});
const identity = manager.identity(hubSid, generation);
const pod = manager.podDocument(identity);
pod.metadata.uid = "33333333-3333-4333-8333-333333333333";
pod.metadata.resourceVersion = "1000";
pod.metadata.generation = 1;
pod.metadata.creationTimestamp = "2033-05-18T03:33:00Z";
delete pod.spec.hostNetwork;
delete pod.spec.hostPID;
delete pod.spec.hostIPC;
Object.assign(pod.spec, {
  dnsPolicy: "ClusterFirst",
  nodeName: "worker-1",
  preemptionPolicy: "PreemptLowerPriority",
  priority: 0,
  schedulerName: "default-scheduler",
  serviceAccount: "bot-runner",
  tolerations: [
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
  ]
});
Object.assign(pod.spec.containers[0], {
  terminationMessagePath: "/dev/termination-log",
  terminationMessagePolicy: "File"
});
pod.status = {
  phase: "Running",
  conditions: [{ type: "Ready", status: "True" }],
  containerStatuses: [{
    name: "bot-runner",
    ready: true,
    restartCount: 0,
    state: { running: { startedAt: "2033-05-18T03:33:00Z" } },
    imageID: `docker-pullable://ghcr.io/yengalvez/bot-runner@sha256:${"a".repeat(64)}`
  }]
};

const publicId = `room-${crypto
  .createHmac("sha256", key)
  .update(`probe:${hubSid}`)
  .digest("hex")
  .slice(0, 24)}`;
const health = {
  runner_pods: 1,
  active_hubs: [publicId],
  runner_bots: { [publicId]: {} }
};
const readiness = {
  configured_room_count: 1,
  expected_hubs: [publicId],
  process_hubs: [publicId],
  active_hubs: [publicId],
  runner_bots: { [publicId]: {} }
};
const base = {
  deployment: fixtureDeployment(),
  parent,
  podsBefore: { apiVersion: "v1", kind: "PodList", items: [pod] },
  podsAfter: { apiVersion: "v1", kind: "PodList", items: [structuredClone(pod)] },
  health,
  readiness,
  key,
  botImage: deploymentConfiguration.botImage,
  runnerImage,
  hubDomain,
  maxActiveRooms: deploymentConfiguration.maxActiveRooms,
  maxBotsPerRoom: deploymentConfiguration.maxBotsPerRoom,
  runnerNamespace: deploymentConfiguration.runnerNamespace,
  namespace: deploymentConfiguration.namespace,
  activationPhase: deploymentConfiguration.activationPhase,
  recoveryPhase: deploymentConfiguration.recoveryPhase,
  recoveryEpoch,
  nowSeconds
};

assert.equal(verifyRunnerPodInputs(base), true);
const containerdImageId = structuredClone(base);
for (const snapshot of [containerdImageId.podsBefore, containerdImageId.podsAfter]) {
  snapshot.items[0].status.containerStatuses[0].imageID = `containerd://sha256:${"a".repeat(64)}`;
}
assert.equal(verifyRunnerPodInputs(containerdImageId), true);

function rejected(mutator) {
  const candidate = structuredClone(base);
  mutator(candidate);
  assert.throws(() => verifyRunnerPodInputs(candidate));
}

rejected(value => { value.podsBefore.items[0].metadata.labels["yenhubs.org/room-key"] = "0".repeat(20); });
rejected(value => { value.podsBefore.items[0].metadata.generateName = "bot-runner-"; });
rejected(value => { value.podsBefore.items[0].metadata.finalizers = ["attacker.example/finalizer"]; });
rejected(value => { value.podsBefore.items[0].metadata.deletionTimestamp = "2033-05-18T03:34:00Z"; });
rejected(value => { value.podsBefore.items[0].metadata.annotations["attacker.example/inject"] = "true"; });
rejected(value => {
  value.podsBefore.items[0].metadata.ownerReferences = [{
    apiVersion: "v1",
    kind: "Pod",
    name: value.parent.metadata.name,
    uid: value.parent.metadata.uid
  }];
});
rejected(value => { value.podsBefore.items[0].metadata.namespace = "hcce"; });
rejected(value => {
  value.parent.metadata.namespace = "other";
  value.deployment.metadata.namespace = "other";
});
rejected(value => { value.podsBefore.items[0].metadata.annotations["yenhubs.org/parent-uid"] = "replacement-parent"; });
rejected(value => { value.podsBefore.items[0].spec.containers[0].imagePullPolicy = "IfNotPresent"; });
rejected(value => { value.podsBefore.items[0].spec.runtimeClassName = "privileged-runtime"; });
rejected(value => { value.podsBefore.items[0].spec.nodeSelector = { disktype: "attacker" }; });
rejected(value => { value.podsBefore.items[0].spec.tolerations.push({ operator: "Exists" }); });
rejected(value => { value.podsBefore.items[0].spec.hostNetwork = false; });
rejected(value => { value.podsBefore.items[0].spec.securityContext.appArmorProfile.type = "Unconfined"; });
rejected(value => { value.podsBefore.items[0].spec.containers[0].securityContext.appArmorProfile.type = "Unconfined"; });
rejected(value => {
  value.podsBefore.items[0].spec.containers[0].env.find(
    entry => entry.name === "BOT_RUNNER_GENERATION_TOKEN"
  ).value = createRunnerGenerationToken({
    key,
    hubSid,
    processGeneration: generation,
    holderId: parent.metadata.uid,
    expiresAtSeconds: nowSeconds + 3600,
    recoveryEpoch: "55555555-5555-4555-8555-555555555555"
  });
});
rejected(value => {
  value.podsBefore.items[0].spec.containers[0].env.find(
    entry => entry.name === "BOT_RUNNER_GENERATION_TOKEN"
  ).value = createRunnerGenerationToken({
    key,
    hubSid,
    processGeneration: generation,
    holderId: parent.metadata.uid,
    expiresAtSeconds: nowSeconds + 3601,
    recoveryEpoch
  });
});
rejected(value => {
  value.podsBefore.items[0].spec.containers[0].env.find(
    entry => entry.name === "BOT_RUNNER_GENERATION_TOKEN"
  ).value = createRunnerGenerationToken({
    key,
    hubSid,
    processGeneration: generation,
    holderId: parent.metadata.uid,
    expiresAtSeconds: nowSeconds,
    recoveryEpoch
  });
});
rejected(value => { value.podsBefore.items[0].spec.containers[0].securityContext.readOnlyRootFilesystem = false; });
rejected(value => { value.podsBefore.items[0].spec.containers[0].workingDir = "/tmp"; });
rejected(value => { value.podsBefore.items[0].spec.containers[0].tty = true; });
rejected(value => { value.podsBefore.items[0].spec.containers[0].livenessProbe = structuredClone(value.podsBefore.items[0].spec.containers[0].readinessProbe); });
rejected(value => { value.podsBefore.items[0].spec.containers[0].startupProbe = structuredClone(value.podsBefore.items[0].spec.containers[0].readinessProbe); });
rejected(value => { value.podsBefore.items[0].spec.containers[0].env.push({ name: "OPENAI_API_KEY", value: "forbidden" }); });
rejected(value => {
  value.podsBefore.items[0].spec.containers[0].env.find(
    entry => entry.name === "GHOST_NAVIGATION_REQUIRE_NAVMESH"
  ).value = "false";
});
rejected(value => {
  value.parent.spec.containers[0].env.find(
    entry => entry.name === "GHOST_NAVIGATION_REQUIRE_NAVMESH"
  ).value = "false";
});
rejected(value => {
  value.deployment.spec.template.spec.containers[0].securityContext.privileged = true;
});
rejected(value => {
  value.parent.spec.containers[0].env.push({ name: "NODE_OPTIONS", value: "--require=/tmp/x" });
});
rejected(value => {
  value.parent.metadata.annotations[
    "container.apparmor.security.beta.kubernetes.io/bot-orchestrator"
  ] = "unconfined";
});
rejected(value => {
  value.parent.status.containerStatuses[0].imageID = `containerd://sha256:${"f".repeat(64)}`;
});
rejected(value => {
  value.parent.spec.volumes.push({ name: "host", hostPath: { path: "/", type: "Directory" } });
  value.parent.spec.containers[0].volumeMounts.push({ name: "host", mountPath: "/host" });
});
rejected(value => {
  value.parent.spec.containers.push({ name: "sidecar", image: value.botImage });
});
rejected(value => {
  value.parent.spec.initContainers = [{ name: "init", image: value.botImage }];
});
rejected(value => {
  value.parent.spec.ephemeralContainers = [{ name: "debug", image: value.botImage }];
});
rejected(value => { value.parent.spec.runtimeClassName = "privileged-runtime"; });
rejected(value => {
  value.podsBefore.items[0].spec.containers[0].env.push({
    name: "GHOST_SCENE_ALLOW_HTTP",
    value: "true"
  });
});
rejected(value => { value.podsBefore.items[0].status.phase = "Succeeded"; });
rejected(value => { value.podsBefore.items[0].status.containerStatuses[0].imageID = `docker-pullable://x@sha256:${"b".repeat(64)}`; });
rejected(value => { value.podsAfter.items[0].metadata.uid = "replacement-runner"; });
rejected(value => { value.health.runner_pods = 2; });
rejected(value => { value.readiness.expected_hubs = [`room-${"0".repeat(24)}`]; });
rejected(value => { value.podsAfter.items.push(structuredClone(value.podsAfter.items[0])); });

process.stdout.write("Bot runner Pod verifier: 45/45 passed\n");

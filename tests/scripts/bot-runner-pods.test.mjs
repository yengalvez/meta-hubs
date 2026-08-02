#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyRunnerPodInputs } from "../../deployment/verify-bot-runner-pods.mjs";
import {
  canonicalDurableFenceInventory,
  captureInitialDurableRunnerWatch,
  durableInventoryFromPodList,
  durableRunnerListRawPath,
  durableRunnerWatchRawPath,
  prepareDurableRunnerWatchHandoff
} from "../../deployment/watch-bot-runner-pods.mjs";
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
rejected(value => { value.podsBefore.items[0].metadata.labels["yenhubs.org/runner-protocol"] = "legacy"; });
rejected(value => { delete value.podsBefore.items[0].metadata.labels["yenhubs.org/runner-protocol"]; });
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

const runnerNamespace = deploymentConfiguration.runnerNamespace;
const durableRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yenhubs-durable-runner-watch."));
fs.chmodSync(durableRoot, 0o700);

function exactFence(hub, processGeneration, uid, resourceVersion) {
  const fence = manager.guardPodDocument(manager.identity(hub, processGeneration), "fence");
  fence.metadata.uid = uid;
  fence.metadata.resourceVersion = resourceVersion;
  return fence;
}

function exactIntent(hub, processGeneration, uid, resourceVersion) {
  const intent = manager.guardPodDocument(manager.identity(hub, processGeneration), "intent");
  intent.metadata.uid = uid;
  intent.metadata.resourceVersion = resourceVersion;
  return intent;
}

function exactRunner(hub, processGeneration, uid, resourceVersion) {
  const runner = manager.podDocument(manager.identity(hub, processGeneration));
  runner.metadata.uid = uid;
  runner.metadata.resourceVersion = resourceVersion;
  return runner;
}

function podList(resourceVersion, items, { omitItemTypeMeta = false } = {}) {
  const clonedItems = structuredClone(items);
  if (omitItemTypeMeta) {
    for (const item of clonedItems) {
      delete item.apiVersion;
      delete item.kind;
    }
  }
  return {
    apiVersion: "v1",
    kind: "PodList",
    metadata: { resourceVersion },
    items: clonedItems
  };
}

function emptyPrivateFile(name) {
  const filePath = path.join(durableRoot, name);
  fs.writeFileSync(filePath, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
  return filePath;
}

function podEvent(type, value, resourceVersion) {
  const eventPod = structuredClone(value);
  eventPod.metadata.resourceVersion = resourceVersion;
  return { type, object: eventPod };
}

const generationB = "22222222-2222-4222-8222-222222222222";
const generationC = "33333333-3333-4333-8333-333333333333";
const fenceA = exactFence(hubSid, generation, "fence-a-uid", "fence-a-rv");
const fenceB = exactFence("Room_2", generationB, "fence-b-uid", "fence-b-rv");
const initialList = podList("opaque/list:initial", [fenceA], { omitItemTypeMeta: true });
const baselinePath = emptyPrivateFile("fences.json");

try {
  const initial = captureInitialDurableRunnerWatch({
    podList: initialList,
    namespace: runnerNamespace,
    baselinePath
  });
  const expectedFence = {
    name: fenceA.metadata.name,
    uid: fenceA.metadata.uid,
    room_key: fenceA.metadata.labels["yenhubs.org/room-key"],
    process_generation: generation,
    state: "fenced"
  };
  const expectedBaseline = JSON.stringify([expectedFence]);
  assert.equal(fs.readFileSync(baselinePath, "utf8"), expectedBaseline);
  assert.equal(
    initial.baselineSha256,
    crypto.createHash("sha256").update(expectedBaseline).digest("hex")
  );
  assert.equal(initial.resourceVersion, "opaque/list:initial");
  assert.equal(initial.bookmarkBaseline, 0);
  assert.equal(initial.evidence.lastResourceVersion, "opaque/list:initial");
  assert.match(
    initial.watchRawPath,
    /watch=true&allowWatchBookmarks=true&resourceVersion=opaque%2Flist%3Ainitial&timeoutSeconds=600$/
  );

  const unordered = canonicalDurableFenceInventory([
    {
      name: fenceB.metadata.name,
      uid: fenceB.metadata.uid,
      room_key: fenceB.metadata.labels["yenhubs.org/room-key"],
      process_generation: generationB,
      state: "fenced"
    },
    expectedFence
  ]);
  assert.deepEqual(JSON.parse(unordered).map(value => value.name),
    [fenceA.metadata.name, fenceB.metadata.name].sort());
  assert.throws(() => canonicalDurableFenceInventory([expectedFence, expectedFence]),
    /durable_fence_baseline_contract/);

  const beforeHandoff = fs.statSync(baselinePath, { bigint: true });
  const handoffFence = structuredClone(fenceA);
  handoffFence.metadata.resourceVersion = "fence/status:next";
  handoffFence.status = { phase: "Pending" };
  const handoff = prepareDurableRunnerWatchHandoff({
    podList: podList("opaque/handoff:rv", [handoffFence], { omitItemTypeMeta: true }),
    namespace: runnerNamespace,
    baselinePath,
    baselineSha256: initial.baselineSha256
  });
  const afterHandoff = fs.statSync(baselinePath, { bigint: true });
  assert.equal(afterHandoff.ino, beforeHandoff.ino);
  assert.equal(afterHandoff.mtimeNs, beforeHandoff.mtimeNs);
  assert.equal(fs.readFileSync(baselinePath, "utf8"), expectedBaseline);
  assert.equal(handoff.resourceVersion, "opaque/handoff:rv");

  assert.throws(() => prepareDurableRunnerWatchHandoff({
    podList: initialList,
    namespace: runnerNamespace,
    baselinePath,
    baselineSha256: "0".repeat(64)
  }), /durable_fence_baseline_digest/);
  const replacedFence = structuredClone(fenceA);
  replacedFence.metadata.uid = "replacement-fence-uid";
  assert.throws(() => prepareDurableRunnerWatchHandoff({
    podList: podList("replacement-list-rv", [replacedFence]),
    namespace: runnerNamespace,
    baselinePath,
    baselineSha256: initial.baselineSha256
  }), /durable_fence_inventory_changed/);
  assert.throws(() => prepareDurableRunnerWatchHandoff({
    podList: podList("added-list-rv", [fenceA, fenceB]),
    namespace: runnerNamespace,
    baselinePath,
    baselineSha256: initial.baselineSha256
  }), /durable_fence_inventory_changed/);
  assert.equal(fs.readFileSync(baselinePath, "utf8"), expectedBaseline);

  const nonemptyPath = path.join(durableRoot, "nonempty.json");
  fs.writeFileSync(nonemptyPath, "[]", { encoding: "utf8", flag: "wx", mode: 0o600 });
  assert.throws(() => captureInitialDurableRunnerWatch({
    podList: initialList,
    namespace: runnerNamespace,
    baselinePath: nonemptyPath
  }), /durable_fence_baseline_file_contract/);
  const permissivePath = emptyPrivateFile("permissive.json");
  fs.chmodSync(permissivePath, 0o644);
  assert.throws(() => captureInitialDurableRunnerWatch({
    podList: initialList,
    namespace: runnerNamespace,
    baselinePath: permissivePath
  }), /durable_fence_baseline_file_contract/);
  const wrongNamespacePath = emptyPrivateFile("wrong-namespace.json");
  assert.throws(() => captureInitialDurableRunnerWatch({
    podList: podList("wrong-namespace-rv", []),
    namespace: "other-runners",
    baselinePath: wrongNamespacePath
  }), /durable_runner_list_contract/);
  assert.equal(fs.statSync(wrongNamespacePath).size, 0);

  const runner = exactRunner("Room_3", generationC, "runner-c-uid", "runner-c-rv");
  const intent = exactIntent("Room_3", generationC, "intent-c-uid", "intent-c-rv");
  assert.throws(() => durableInventoryFromPodList(
    podList("runner-list-rv", [runner]), runnerNamespace
  ), /durable_runner_namespace_not_quiescent/);
  assert.throws(() => durableInventoryFromPodList(
    podList("intent-list-rv", [intent]), runnerNamespace
  ), /durable_runner_namespace_not_quiescent/);
  const unknown = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "unknown",
      namespace: runnerNamespace,
      uid: "unknown-uid",
      resourceVersion: "unknown-rv",
      labels: {}
    },
    spec: {}
  };
  assert.throws(() => durableInventoryFromPodList(
    podList("unknown-list-rv", [unknown]), runnerNamespace
  ), /durable_runner_namespace_contract/);
  const malformedFence = structuredClone(fenceA);
  malformedFence.metadata.annotations = { "attacker.example/change": "true" };
  assert.throws(() => durableInventoryFromPodList(
    podList("malformed-list-rv", [malformedFence]), runnerNamespace
  ), /durable_runner_namespace_contract/);
  assert.throws(() => durableInventoryFromPodList(
    { ...initialList, metadata: { resourceVersion: "0" } }, runnerNamespace
  ), /durable_runner_list_contract/);

  const allowed = prepareDurableRunnerWatchHandoff({
    podList: initialList,
    namespace: runnerNamespace,
    baselinePath,
    baselineSha256: initial.baselineSha256
  }).evidence;
  const allowedFence = structuredClone(fenceA);
  allowedFence.status = { phase: "Pending", conditions: [{ type: "PodScheduled", status: "False" }] };
  allowed.ingest(podEvent("MODIFIED", allowedFence, "opaque/event:lower"));
  assert.equal(allowed.violation, false);
  assert.equal(allowed.error, null);
  assert.equal(allowed.lastResourceVersion, "opaque/event:lower");
  const bookmarkBaseline = allowed.bookmarkSequence;
  allowed.ingest({
    type: "BOOKMARK",
    object: { metadata: { resourceVersion: "opaque/event:lower" } }
  });
  assert.equal(allowed.hasCausalBookmarkAfter(bookmarkBaseline), true);
  assert.equal(allowed.lastBookmarkResourceVersion, "opaque/event:lower");

  for (const type of ["ADDED", "DELETED"]) {
    const evidence = prepareDurableRunnerWatchHandoff({
      podList: initialList,
      namespace: runnerNamespace,
      baselinePath,
      baselineSha256: initial.baselineSha256
    }).evidence;
    evidence.ingest(podEvent(type, fenceA, `${type.toLowerCase()}-rv`));
    assert.equal(evidence.violation, true);
  }

  const replacedEvidence = prepareDurableRunnerWatchHandoff({
    podList: initialList,
    namespace: runnerNamespace,
    baselinePath,
    baselineSha256: initial.baselineSha256
  }).evidence;
  replacedEvidence.ingest(podEvent("MODIFIED", replacedFence, "replacement-event-rv"));
  assert.equal(replacedEvidence.violation, true);

  for (const managedPod of [runner, intent]) {
    const evidence = prepareDurableRunnerWatchHandoff({
      podList: initialList,
      namespace: runnerNamespace,
      baselinePath,
      baselineSha256: initial.baselineSha256
    }).evidence;
    evidence.ingest(podEvent("MODIFIED", managedPod, "managed-modified-rv"));
    assert.equal(evidence.violation, true);
  }

  const unknownEvidence = prepareDurableRunnerWatchHandoff({
    podList: initialList,
    namespace: runnerNamespace,
    baselinePath,
    baselineSha256: initial.baselineSha256
  }).evidence;
  unknownEvidence.ingest(podEvent("MODIFIED", unknown, "unknown-event-rv"));
  assert.equal(unknownEvidence.error, "durable_runner_watch_unknown_object");

  const missingTypeMeta = prepareDurableRunnerWatchHandoff({
    podList: initialList,
    namespace: runnerNamespace,
    baselinePath,
    baselineSha256: initial.baselineSha256
  }).evidence;
  const noTypeMetaFence = structuredClone(fenceA);
  delete noTypeMetaFence.apiVersion;
  delete noTypeMetaFence.kind;
  missingTypeMeta.ingest(podEvent("MODIFIED", noTypeMetaFence, "no-type-meta-rv"));
  assert.equal(missingTypeMeta.error, "durable_runner_watch_object_contract");

  const expired = prepareDurableRunnerWatchHandoff({
    podList: initialList,
    namespace: runnerNamespace,
    baselinePath,
    baselineSha256: initial.baselineSha256
  }).evidence;
  expired.ingest({ type: "ERROR", object: { code: 410 } });
  assert.equal(expired.error, "durable_runner_watch_resource_version_expired");

  const invalidBookmark = prepareDurableRunnerWatchHandoff({
    podList: initialList,
    namespace: runnerNamespace,
    baselinePath,
    baselineSha256: initial.baselineSha256
  }).evidence;
  invalidBookmark.ingest({ type: "BOOKMARK", object: { metadata: { resourceVersion: "0" } } });
  assert.equal(invalidBookmark.error, "durable_runner_watch_bookmark_contract");
  assert.equal(invalidBookmark.hasCausalBookmarkAfter(0), false);

  assert.equal(
    durableRunnerListRawPath(runnerNamespace),
    `/api/v1/namespaces/${runnerNamespace}/pods`
  );
  assert.equal(
    durableRunnerWatchRawPath(runnerNamespace, "z/10:opaque", 17),
    `/api/v1/namespaces/${runnerNamespace}/pods?` +
      "watch=true&allowWatchBookmarks=true&resourceVersion=z%2F10%3Aopaque&timeoutSeconds=17"
  );
  assert.throws(() => durableRunnerWatchRawPath(runnerNamespace, "0"),
    /durable_runner_watch_path/);
  assert.throws(() => durableRunnerListRawPath("other-runners"),
    /durable_runner_list_path/);

  process.stdout.write("Durable runner/fence causal watcher core: passed\n");
} finally {
  fs.rmSync(durableRoot, { force: true, recursive: true });
}

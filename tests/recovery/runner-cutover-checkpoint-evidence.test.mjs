import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";

import {
  PAIR_DEFINITIONS,
  PARENT_RESOURCE_DEFINITIONS,
  buildCheckpointEvidenceCore,
  canonicalEvidenceFile,
  captureStableCore,
  classifyRunnerPodList,
  environmentInputs,
  evidenceEnvelope,
  liveVerificationContract,
  nextRunnerPodAction,
  validateDeploymentInventory,
  validateEvidenceEnvelope,
  verifyHistoricalSourceCore,
  verifyManifestEpochBinding,
  writePrivateCanonicalJson
} from "../../deployment/runner-cutover-checkpoint-evidence.mjs";

const require = createRequire(import.meta.url);
const {
  CUTOVER_JOURNAL_FINALIZER,
  canonicalJson,
  createCutoverJournal,
  cutoverJournalConfigMap,
  journalHmac,
  sha256Canonical
} = require("../../hubs-cloud/community-edition/apply/cutover-journal.js");
const {
  ADMISSION_POLICY_NAME,
  CUTOVER_JOURNAL_POLICY_NAME,
  FENCE_PROTOCOL_ANNOTATION,
  FENCE_PROTOCOL_VALUE,
  PARENT_FENCE_POLICY_NAME,
  RECOVERY_OPERATION_FENCE_POLICY_NAME,
  RECOVERY_PHASE_ANNOTATION,
  RUNNER_NAMESPACE,
  RUNNER_PROTOCOL_POLICY_NAME,
  exactRecoveryOperationFenceBinding,
  exactRecoveryOperationFencePolicy,
  manifestResourcesFromText
} = require("../../hubs-cloud/community-edition/apply/runner-activation.js");
const {
  GENERATION_LABEL,
  INTENT_STATE_ANNOTATION,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  ROOM_KEY_LABEL,
  RUNNER_APP_LABEL,
  RUNNER_PROTOCOL_LABEL,
  RUNNER_PROTOCOL_VALUE,
  guardPodDocumentForIdentity,
  runnerPodName
} = require("../../hubs-cloud/community-edition/services/bot-orchestrator/kubernetes-runner-manager.js");

const KEY = Buffer.alloc(32, 17);
const KEY_SENTINEL = KEY.toString("hex");
const CONTEXT = "do-ams3-yenhubs";
const NAMESPACE = "hcce";
const NAMESPACE_UID = "parent-namespace-uid";
const OPERATION_ID = "0123456789abcdef0123456789abcdef";
const JOURNAL_OPERATION_ID = "12345678-1234-4234-8234-123456789abc";
const GENERATION = "11111111-1111-4111-8111-111111111111";
const ROOM_KEY = "abcabcabcabcabcabcab";
const MANIFEST_SHA256 = "a".repeat(64);
const SCRIPT = path.resolve("deployment/runner-cutover-checkpoint-evidence.mjs");
const CLOUD_MANIFEST_TEMPLATE = path.resolve(
  "hubs-cloud/community-edition/generate_script/hcce.yam"
);

function privateDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "yenhubs-evidence-test-"));
  fs.chmodSync(directory, 0o700);
  return fs.realpathSync(directory);
}

function writePrivate(directory, name, bytes) {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, bytes, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
  return filePath;
}

function namespace(name, uid, resourceVersion) {
  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name, uid, resourceVersion },
    spec: { finalizers: ["kubernetes"] },
    status: { phase: "Active" }
  };
}

function parentDeployment(resourceVersion = "20", replicas = 0) {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: "bot-orchestrator",
      namespace: NAMESPACE,
      uid: "parent-deployment-uid",
      resourceVersion,
      labels: { app: "bot-orchestrator" },
      annotations: {
        [FENCE_PROTOCOL_ANNOTATION]: FENCE_PROTOCOL_VALUE,
        "yenhubs.org/bot-runner-recovery-phase": "active"
      }
    },
    spec: {
      replicas,
      strategy: { type: "Recreate" },
      selector: { matchLabels: { app: "bot-orchestrator" } },
      template: {
        metadata: {
          labels: { app: "bot-orchestrator" },
          annotations: { [FENCE_PROTOCOL_ANNOTATION]: FENCE_PROTOCOL_VALUE }
        },
        spec: { containers: [{ name: "bot-orchestrator", image: "example.invalid/parent:1" }] }
      }
    }
  };
}

function policy(name) {
  return {
    apiVersion: "admissionregistration.k8s.io/v1",
    kind: "ValidatingAdmissionPolicy",
    metadata: { name },
    spec: {
      failurePolicy: "Fail",
      matchConstraints: { resourceRules: [] },
      validations: [{ expression: "true" }]
    }
  };
}

function binding(name, namespaceName) {
  return {
    apiVersion: "admissionregistration.k8s.io/v1",
    kind: "ValidatingAdmissionPolicyBinding",
    metadata: { name },
    spec: {
      policyName: name,
      validationActions: ["Deny"],
      matchResources: {
        matchPolicy: "Equivalent",
        namespaceSelector: {
          matchLabels: {
            "kubernetes.io/metadata.name": namespaceName
          }
        },
        objectSelector: {}
      }
    }
  };
}

function recoveryOperationFencePair(expectedState = "dormant") {
  const resources = manifestResourcesFromText(
    fs.readFileSync(CLOUD_MANIFEST_TEMPLATE, "utf8").replaceAll("$Namespace", NAMESPACE)
  );
  const policyResource = resources.find(resource =>
    resource?.kind === "ValidatingAdmissionPolicy" &&
    resource?.metadata?.name === RECOVERY_OPERATION_FENCE_POLICY_NAME
  );
  const dormantBinding = resources.find(resource =>
    resource?.kind === "ValidatingAdmissionPolicyBinding" &&
    resource?.metadata?.name === RECOVERY_OPERATION_FENCE_POLICY_NAME
  );
  const bindingResource = structuredClone(dormantBinding);
  if (expectedState === "active") {
    bindingResource.spec.matchResources.namespaceSelector = {
      matchExpressions: [{
        key: "kubernetes.io/metadata.name",
        operator: "In",
        values: [NAMESPACE, RUNNER_NAMESPACE]
      }]
    };
  }
  assert.equal(exactRecoveryOperationFencePolicy(policyResource, NAMESPACE), true);
  assert.equal(exactRecoveryOperationFenceBinding(
    bindingResource,
    NAMESPACE,
    { active: expectedState === "active" }
  ), true);
  return { policy: policyResource, binding: bindingResource };
}

function expectedPairs(expectedRecoveryOperationFenceState = "dormant") {
  return {
    runner_admission: {
      policy: policy(ADMISSION_POLICY_NAME),
      binding: binding(ADMISSION_POLICY_NAME, RUNNER_NAMESPACE)
    },
    runner_protocol: {
      policy: policy(RUNNER_PROTOCOL_POLICY_NAME),
      binding: binding(RUNNER_PROTOCOL_POLICY_NAME, RUNNER_NAMESPACE)
    },
    cutover_journal: {
      policy: policy(CUTOVER_JOURNAL_POLICY_NAME),
      binding: binding(CUTOVER_JOURNAL_POLICY_NAME, NAMESPACE)
    },
    parent_fence: {
      policy: policy(PARENT_FENCE_POLICY_NAME),
      binding: binding(PARENT_FENCE_POLICY_NAME, NAMESPACE)
    },
    recovery_operation_fence: recoveryOperationFencePair(
      expectedRecoveryOperationFenceState
    )
  };
}

function expectedParentResources() {
  return {
    service_account: {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: { name: "bot-orchestrator", namespace: NAMESPACE },
      automountServiceAccountToken: true
    },
    role: {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      metadata: { name: "bot-orchestrator-runner-pods", namespace: NAMESPACE },
      rules: [{ apiGroups: [""], resources: ["pods"], verbs: ["get"] }]
    },
    role_binding: {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: { name: "bot-orchestrator-runner-pods", namespace: NAMESPACE },
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "Role",
        name: "bot-orchestrator-runner-pods"
      },
      subjects: [{ kind: "ServiceAccount", name: "bot-orchestrator", namespace: NAMESPACE }]
    }
  };
}

function liveResource(expected, suffix, resourceVersion) {
  const live = structuredClone(expected);
  live.metadata.uid = `${suffix}-uid`;
  live.metadata.resourceVersion = resourceVersion;
  live.metadata.annotations = {
    ...(live.metadata.annotations || {}),
    "kubectl.kubernetes.io/last-applied-configuration": "server-bookkeeping"
  };
  return live;
}

function livePairs(expected) {
  return Object.fromEntries(PAIR_DEFINITIONS.map(({ key }) => {
    const pair = expected[key];
    const livePolicy = liveResource(pair.policy, `${key}-policy`, "30");
    livePolicy.metadata.generation = 4;
    livePolicy.status = {
      observedGeneration: 4,
      typeChecking: {},
      conditions: [{ type: "Ready", status: "True" }]
    };
    return [key, {
      policy: livePolicy,
      binding: liveResource(pair.binding, `${key}-binding`, "31")
    }];
  }));
}

function liveParentResources(expected) {
  return Object.fromEntries(PARENT_RESOURCE_DEFINITIONS.map(({ key }) => [
    key,
    liveResource(expected[key], `parent-${key}`, "40")
  ]));
}

function expectedRunnerRole(recoveryPhase = "active", { inert = false } = {}) {
  return {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "Role",
    metadata: {
      name: "bot-orchestrator-runner-pods",
      namespace: RUNNER_NAMESPACE,
      annotations: {
        "yenhubs.org/runner-activation-phase": "active",
        [RECOVERY_PHASE_ANNOTATION]: recoveryPhase
      }
    },
    rules: inert
      ? []
      : [{
          apiGroups: [""],
          resources: ["pods"],
          verbs: ["create", "delete", "get", "list", "patch"]
        }]
  };
}

function expectedRunnerRoleBinding(recoveryPhase = "active") {
  return {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "RoleBinding",
    metadata: {
      name: "bot-orchestrator-runner-pods",
      namespace: RUNNER_NAMESPACE,
      annotations: {
        "yenhubs.org/runner-activation-phase": "active",
        [RECOVERY_PHASE_ANNOTATION]: recoveryPhase
      }
    },
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "Role",
      name: "bot-orchestrator-runner-pods"
    },
    subjects: [{ kind: "ServiceAccount", name: "bot-orchestrator", namespace: NAMESPACE }]
  };
}

const RUNNER_CONTROL_PLANE_LIVE_DEFINITIONS = Object.freeze([
  Object.freeze({
    key: "runner_pull_secret",
    suffix: "runner-pull-secret",
    resourceVersion: "43"
  }),
  Object.freeze({
    key: "runner_service_account",
    suffix: "runner-service-account",
    resourceVersion: "44"
  }),
  Object.freeze({
    key: "guard_service_account",
    suffix: "guard-service-account",
    resourceVersion: "45"
  }),
  Object.freeze({ key: "runner_quota", suffix: "runner-quota", resourceVersion: "46" }),
  Object.freeze({ key: "guard_quota", suffix: "guard-quota", resourceVersion: "47" }),
  Object.freeze({
    key: "runner_default_deny",
    suffix: "runner-default-deny",
    resourceVersion: "48"
  }),
  Object.freeze({ key: "runner_egress", suffix: "runner-egress", resourceVersion: "49" })
]);

function expectedRunnerControlPlaneResources() {
  return {
    runner_pull_secret: {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "bot-images-pull", namespace: RUNNER_NAMESPACE },
      type: "kubernetes.io/dockerconfigjson",
      data: { ".dockerconfigjson": Buffer.from("source-registry-auth").toString("base64") }
    },
    runner_service_account: {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: { name: "bot-runner", namespace: RUNNER_NAMESPACE },
      automountServiceAccountToken: false,
      imagePullSecrets: [{ name: "bot-images-pull" }]
    },
    guard_service_account: {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: { name: "bot-runner-guard", namespace: RUNNER_NAMESPACE },
      automountServiceAccountToken: true
    },
    runner_quota: {
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: { name: "bot-runner-capacity", namespace: RUNNER_NAMESPACE },
      spec: { hard: { pods: "10" } }
    },
    guard_quota: {
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: { name: "bot-runner-guard-capacity", namespace: RUNNER_NAMESPACE },
      spec: { hard: { pods: "20" } }
    },
    runner_default_deny: {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "bot-runner-default-deny", namespace: RUNNER_NAMESPACE },
      spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"] }
    },
    runner_egress: {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "bot-runner-egress", namespace: RUNNER_NAMESPACE },
      spec: {
        podSelector: { matchLabels: { app: "bot-runner" } },
        policyTypes: ["Egress"],
        egress: [{ to: [{ namespaceSelector: {} }] }]
      }
    }
  };
}

function expectedControlPlane(
  pairs,
  parentResources,
  runnerRole,
  runnerRoleBinding,
  runnerResources = expectedRunnerControlPlaneResources()
) {
  return {
    namespaces: {
      runner_namespace: {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: { name: RUNNER_NAMESPACE }
      }
    },
    namespaced_resources: {
      parent_service_account: parentResources.service_account,
      parent_role: parentResources.role,
      parent_role_binding: parentResources.role_binding,
      ...runnerResources,
      runner_role: runnerRole,
      runner_role_binding: runnerRoleBinding
    },
    cluster_resources: Object.fromEntries(PAIR_DEFINITIONS.flatMap(({ key }) => [
      [`${key}_policy`, pairs[key].policy],
      [`${key}_binding`, pairs[key].binding]
    ]))
  };
}

function runnerResourcesFromControlPlane(controlPlane) {
  return Object.fromEntries(RUNNER_CONTROL_PLANE_LIVE_DEFINITIONS.map(({ key }) => [
    key,
    controlPlane.namespaced_resources[key]
  ]));
}

function namespacedControlPlaneEntry(evidence, manifest, key) {
  const expected = manifest.expected_control_plane.namespaced_resources[key];
  return evidence.control_plane.namespaced_resources.find(value =>
    value.api_version === expected.apiVersion && value.kind === expected.kind &&
    value.name === expected.metadata.name && value.namespace === expected.metadata.namespace
  );
}

function manifestFixture(recoveryPhase = "active") {
  const expectedRecoveryOperationFenceState = recoveryPhase === "restore-fence"
    ? "active"
    : "dormant";
  const pairs = expectedPairs(expectedRecoveryOperationFenceState);
  const parentResources = expectedParentResources();
  const runnerRole = expectedRunnerRole();
  const runnerRoleBinding = expectedRunnerRoleBinding();
  const deployment = parentDeployment();
  delete deployment.metadata.uid;
  delete deployment.metadata.resourceVersion;
  return {
    manifest_sha256: MANIFEST_SHA256,
    recovery_phase: recoveryPhase,
    recovery_operation_fence_state: expectedRecoveryOperationFenceState,
    recovery_epoch: "33333333-3333-4333-8333-333333333333",
    expected_pairs: pairs,
    expected_control_plane: expectedControlPlane(
      pairs,
      parentResources,
      runnerRole,
      runnerRoleBinding
    ),
    expected_parent_resources: parentResources,
    expected_runner_role: runnerRole,
    expected_runner_role_binding: runnerRoleBinding,
    parent_target: deployment,
    target_hashes: {
      journalPolicy: sha256Canonical(pairs.cutover_journal.policy),
      journalBinding: sha256Canonical(pairs.cutover_journal.binding),
      parentPolicy: sha256Canonical(pairs.parent_fence.policy),
      parentBinding: sha256Canonical(pairs.parent_fence.binding),
      parentDeployment: sha256Canonical(deployment)
    }
  };
}

function targetManifestFixture(recoveryPhase) {
  const target = manifestFixture(recoveryPhase);
  target.manifest_sha256 = "b".repeat(64);
  target.recovery_phase = recoveryPhase;
  target.recovery_epoch = "44444444-4444-4444-8444-444444444444";
  target.expected_pairs.runner_protocol.policy.spec.validations = [
    { expression: "targetPhase == true" }
  ];
  target.expected_parent_resources.role.rules[0].verbs = ["get", "list"];
  target.expected_runner_role = expectedRunnerRole(recoveryPhase, {
    inert: recoveryPhase === "restore-fence"
  });
  target.expected_runner_role_binding = expectedRunnerRoleBinding(recoveryPhase);
  const runnerResources = runnerResourcesFromControlPlane(target.expected_control_plane);
  runnerResources.guard_service_account.automountServiceAccountToken = false;
  runnerResources.runner_quota.spec.hard.pods = "12";
  runnerResources.runner_default_deny.spec.podSelector = {
    matchLabels: { "yenhubs.org/recovery-contract": recoveryPhase }
  };
  runnerResources.runner_pull_secret.data[".dockerconfigjson"] = Buffer.from(
    `target-registry-auth:${recoveryPhase}`
  ).toString("base64");
  target.expected_control_plane = expectedControlPlane(
    target.expected_pairs,
    target.expected_parent_resources,
    target.expected_runner_role,
    target.expected_runner_role_binding,
    runnerResources
  );
  target.parent_target.metadata.annotations[RECOVERY_PHASE_ANNOTATION] = recoveryPhase;
  target.parent_target.spec.template.spec.containers[0].image = "example.invalid/parent:target";
  target.parent_target.spec.replicas = 0;
  target.target_hashes = {
    journalPolicy: sha256Canonical(target.expected_pairs.cutover_journal.policy),
    journalBinding: sha256Canonical(target.expected_pairs.cutover_journal.binding),
    parentPolicy: sha256Canonical(target.expected_pairs.parent_fence.policy),
    parentBinding: sha256Canonical(target.expected_pairs.parent_fence.binding),
    parentDeployment: sha256Canonical(target.parent_target)
  };
  return target;
}

function makeJournal(manifest) {
  return createCutoverJournal({
    mode: "pristine-cutover",
    operationId: JOURNAL_OPERATION_ID,
    authorization: { schemaVersion: 1, ownerApproval: "checkpoint-fixture" },
    expectedKubeContext: CONTEXT,
    namespace: NAMESPACE,
    namespaceUid: NAMESPACE_UID,
    baselineDeployment: {
      name: "bot-orchestrator",
      uid: "parent-deployment-uid",
      resourceVersion: "10"
    },
    manifestSha256: manifest.manifest_sha256,
    targetHashes: manifest.target_hashes,
    issuedAt: "2026-07-19T12:00:00.000Z"
  }, KEY);
}

function exactGuard(
  type,
  state = "unarmed",
  uid = `${type}-uid`,
  resourceVersion = "50",
  suppliedIdentity = null
) {
  const identity = suppliedIdentity || {
    name: runnerPodName(ROOM_KEY, GENERATION),
    roomKey: ROOM_KEY,
    processGeneration: GENERATION
  };
  const pod = guardPodDocumentForIdentity(identity, type, RUNNER_NAMESPACE);
  pod.metadata.uid = uid;
  pod.metadata.resourceVersion = resourceVersion;
  if (type === "intent") pod.metadata.annotations[INTENT_STATE_ANNOTATION] = state;
  pod.status = { phase: "Pending" };
  return pod;
}

function exactRunner(uid = "runner-uid", resourceVersion = "51", suppliedIdentity = null) {
  const identity = suppliedIdentity || {
    name: runnerPodName(ROOM_KEY, GENERATION),
    roomKey: ROOM_KEY,
    processGeneration: GENERATION
  };
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: identity.name,
      namespace: RUNNER_NAMESPACE,
      uid,
      resourceVersion,
      labels: {
        app: RUNNER_APP_LABEL,
        [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
        [RUNNER_PROTOCOL_LABEL]: RUNNER_PROTOCOL_VALUE,
        [ROOM_KEY_LABEL]: identity.roomKey,
        [GENERATION_LABEL]: identity.processGeneration
      }
    },
    spec: { containers: [{ name: "bot-runner" }] },
    status: { phase: "Running" }
  };
}

function runnerIdentity(roomKey, processGeneration = GENERATION) {
  return {
    name: runnerPodName(roomKey, processGeneration),
    roomKey,
    processGeneration
  };
}

function podList(items = [], resourceVersion = "60") {
  return {
    apiVersion: "v1",
    kind: "PodList",
    metadata: { resourceVersion },
    items
  };
}

function baseLive() {
  return {
    cluster_anchor: namespace("kube-system", "cluster-anchor-uid", "1"),
    parent_namespace: namespace(NAMESPACE, NAMESPACE_UID, "2"),
    runner_namespace: null,
    runner_role: null,
    runner_role_binding: null,
    runner_pull_secret: null,
    runner_service_account: null,
    guard_service_account: null,
    runner_quota: null,
    guard_quota: null,
    runner_default_deny: null,
    runner_egress: null,
    journal_config_map: null,
    admission: Object.fromEntries(PAIR_DEFINITIONS.map(({ key }) => [
      key,
      { policy: null, binding: null }
    ])),
    parent_resources: Object.fromEntries(PARENT_RESOURCE_DEFINITIONS.map(({ key }) => [key, null])),
    parent_deployment: parentDeployment(),
    runner_pods: null,
    normalized_parent_target: null
  };
}

function durableLive({
  fences = [],
  replicas = 0,
  recoveryOperationFenceState = "dormant"
} = {}) {
  const manifest = manifestFixture("active");
  const journal = makeJournal(manifest);
  const configMap = cutoverJournalConfigMap(journal);
  configMap.metadata.uid = "journal-configmap-uid";
  configMap.metadata.resourceVersion = "21";
  const deployment = parentDeployment("20", replicas);
  deployment.metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"] =
    "server-bookkeeping";
  const normalized = structuredClone(deployment);
  delete normalized.metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"];
  const admission = livePairs(manifest.expected_pairs);
  admission.recovery_operation_fence.binding.spec = structuredClone(
    recoveryOperationFencePair(recoveryOperationFenceState).binding.spec
  );
  return {
    ...baseLive(),
    runner_namespace: namespace(RUNNER_NAMESPACE, "runner-namespace-uid", "3"),
    journal_config_map: configMap,
    admission,
    parent_resources: liveParentResources(manifest.expected_parent_resources),
    runner_role: liveResource(manifest.expected_runner_role, "runner-role", "41"),
    runner_role_binding: liveResource(
      manifest.expected_runner_role_binding,
      "runner-role-binding",
      "42"
    ),
    ...Object.fromEntries(RUNNER_CONTROL_PLANE_LIVE_DEFINITIONS.map(definition => [
      definition.key,
      liveResource(
        manifest.expected_control_plane.namespaced_resources[definition.key],
        definition.suffix,
        definition.resourceVersion
      )
    ])),
    parent_deployment: deployment,
    runner_pods: podList(fences),
    normalized_parent_target: normalized,
    manifest
  };
}

function durableTargetLive(
  checkpointLive,
  targetManifest,
  { pods = [], replicas = 0, quiescedActive = false } = {}
) {
  const live = structuredClone(checkpointLive);
  live.admission = livePairs(targetManifest.expected_pairs);
  live.parent_resources = liveParentResources(targetManifest.expected_parent_resources);
  const expectedRole = quiescedActive
    ? expectedRunnerRole("restore-fence", { inert: true })
    : targetManifest.expected_runner_role;
  live.runner_role = liveResource(expectedRole, "runner-role", "target-runner-role-rv");
  live.runner_role_binding = liveResource(
    targetManifest.expected_runner_role_binding,
    "runner-role-binding",
    "target-runner-role-binding-rv"
  );
  for (const definition of RUNNER_CONTROL_PLANE_LIVE_DEFINITIONS) {
    live[definition.key] = liveResource(
      targetManifest.expected_control_plane.namespaced_resources[definition.key],
      definition.suffix,
      `target-${definition.key}-rv`
    );
  }
  const deployment = structuredClone(targetManifest.parent_target);
  deployment.metadata.uid = "parent-deployment-uid";
  deployment.metadata.resourceVersion = "target-parent-rv";
  deployment.metadata.annotations = {
    ...(deployment.metadata.annotations || {}),
    "kubectl.kubernetes.io/last-applied-configuration": "server-bookkeeping"
  };
  deployment.spec.replicas = replicas;
  const normalized = structuredClone(deployment);
  delete normalized.metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"];
  live.parent_deployment = deployment;
  live.normalized_parent_target = normalized;
  live.runner_pods = podList(pods, "target-pods-rv");
  live.manifest = targetManifest;
  return live;
}

function secondFence(resourceVersion = "71") {
  const fence = exactGuard("fence", "unarmed", "second-fence-uid", resourceVersion);
  fence.metadata.labels[ROOM_KEY_LABEL] = "bbbbbbbbbbbbbbbbbbbb";
  fence.metadata.labels[GENERATION_LABEL] = "22222222-2222-4222-8222-222222222222";
  fence.metadata.name = runnerPodName(
    fence.metadata.labels[ROOM_KEY_LABEL],
    fence.metadata.labels[GENERATION_LABEL]
  );
  return fence;
}

function advanceDurableResourceVersions(live) {
  live.parent_namespace.metadata.resourceVersion = "102";
  live.runner_namespace.metadata.resourceVersion = "103";
  live.journal_config_map.metadata.resourceVersion = "121";
  for (const { key } of PAIR_DEFINITIONS) {
    live.admission[key].policy.metadata.resourceVersion = `13${key.length}`;
    live.admission[key].binding.metadata.resourceVersion = `14${key.length}`;
  }
  for (const { key } of PARENT_RESOURCE_DEFINITIONS) {
    live.parent_resources[key].metadata.resourceVersion = `15${key.length}`;
  }
  live.runner_role.metadata.resourceVersion = "159";
  live.runner_role_binding.metadata.resourceVersion = "158";
  for (const [index, { key }] of RUNNER_CONTROL_PLANE_LIVE_DEFINITIONS.entries()) {
    live[key].metadata.resourceVersion = String(180 + index);
  }
  live.parent_deployment.metadata.resourceVersion = "120";
  live.runner_pods.metadata.resourceVersion = "160";
  for (const [index, pod] of live.runner_pods.items.entries()) {
    pod.metadata.resourceVersion = String(170 + index);
  }
}

function makeRunnerRoleInert(live) {
  live.runner_role.metadata.annotations[RECOVERY_PHASE_ANNOTATION] = "restore-fence";
  live.runner_role.rules = [];
  return live;
}

function inputs(manifest = null, expectedState = null) {
  const expectedRecoveryOperationFenceState =
    expectedState || manifest?.recovery_operation_fence_state || "dormant";
  return {
    namespace: NAMESPACE,
    expected_kube_context: CONTEXT,
    expected_namespace_uid: NAMESPACE_UID,
    operation_id: OPERATION_ID,
    expected_recovery_operation_fence_state: expectedRecoveryOperationFenceState,
    manifest_contract: manifest,
    cutover_key: manifest ? Buffer.from(KEY) : null
  };
}

function historicalInputs(expectedState = "dormant") {
  const value = inputs(null, expectedState);
  value.cutover_key = Buffer.from(KEY);
  return value;
}

function envelope(core) {
  return evidenceEnvelope(core, OPERATION_ID, {
    started_at_utc: "2026-07-20T00:00:00.000Z",
    completed_at_utc: "2026-07-20T00:00:01.000Z"
  });
}

function verificationBuildOptions(evidence, mode) {
  return {
    expectedParentReplicas: mode.startsWith("active-") ? 1 : 0,
    verificationMode: mode,
    checkpointEvidence: evidence
  };
}

function resignJournalEvidence(evidence, mutate) {
  const parsed = JSON.parse(evidence.journal.canonical_json);
  delete parsed.hmacSha256;
  mutate(parsed);
  parsed.hmacSha256 = journalHmac(parsed, KEY);
  evidence.journal.canonical_json = canonicalJson(parsed);
  evidence.journal.canonical_sha256 = sha256Canonical(parsed);
  evidence.journal.contract = {
    schema_version: parsed.schemaVersion,
    mode: parsed.mode,
    operation: parsed.operation,
    operation_id: parsed.operationId,
    expected_kube_context: parsed.expectedKubeContext,
    namespace: {
      name: parsed.namespace.name,
      uid: parsed.namespace.uid
    },
    baseline_deployment: parsed.baselineDeployment === null
      ? null
      : {
          name: parsed.baselineDeployment.name,
          uid: parsed.baselineDeployment.uid,
          resource_version: parsed.baselineDeployment.resourceVersion
        },
    manifest_sha256: parsed.manifestSha256,
    target_hashes: {
      journal_policy: parsed.targetHashes.journalPolicy,
      journal_binding: parsed.targetHashes.journalBinding,
      parent_policy: parsed.targetHashes.parentPolicy,
      parent_binding: parsed.targetHashes.parentBinding,
      parent_deployment: parsed.targetHashes.parentDeployment
    },
    issued_at: parsed.issuedAt
  };
  return evidence;
}

const DEPLOYMENT_CONTAINERS = Object.freeze({
  "bot-orchestrator": ["bot-orchestrator"],
  coturn: ["coturn"],
  dialog: ["dialog"],
  haproxy: ["haproxy"],
  hubs: ["hubs"],
  nearspark: ["nearspark"],
  pgbouncer: ["pgbouncer"],
  "pgbouncer-t": ["pgbouncer-t"],
  photomnemonic: ["photomnemonic"],
  pgsql: [],
  reticulum: ["postgrest", "reticulum"],
  spoke: ["spoke"]
});
const TEST_REPOSITORIES = Object.freeze({
  "bot-orchestrator/bot-orchestrator": "ghcr.io/yengalvez/bot-orchestrator",
  "coturn/coturn": "ghcr.io/yengalvez/coturn",
  "dialog/dialog": "ghcr.io/yengalvez/dialog",
  "haproxy/haproxy": "ghcr.io/yengalvez/haproxy",
  "hubs/hubs": "ghcr.io/yengalvez/hubs",
  "nearspark/nearspark": "ghcr.io/yengalvez/nearspark",
  "pgbouncer/pgbouncer": "ghcr.io/yengalvez/pgbouncer",
  "pgbouncer-t/pgbouncer-t": "ghcr.io/yengalvez/pgbouncer",
  "photomnemonic/photomnemonic": "ghcr.io/yengalvez/photomnemonic",
  "pgsql/pgsql": "ghcr.io/yengalvez/postgres",
  "pgsql/postgresql": "ghcr.io/yengalvez/postgres",
  "reticulum/postgrest": "ghcr.io/yengalvez/postgrest",
  "reticulum/reticulum": "ghcr.io/yengalvez/reticulum",
  "spoke/spoke": "ghcr.io/yengalvez/spoke"
});

function deploymentInventory(mode, evidence) {
  const postgresContainer = mode === "process-local" ? "postgresql" : "pgsql";
  const deployments = Object.entries(DEPLOYMENT_CONTAINERS).map(([name, containers]) => ({
    name,
    uid: name === "bot-orchestrator" ? "parent-deployment-uid" : `${name}-deployment-uid`,
    replicas: 1,
    init_containers: [],
    containers: [...containers, ...(name === "pgsql" ? [postgresContainer] : [])].map(
      container => {
        const pair = `${name}/${container}`;
        return {
          name: container,
          image: `${TEST_REPOSITORIES[pair]}@sha256:${"8".repeat(64)}`
        };
      }
    )
  }));
  const runtime = mode === "process-local"
    ? {
        generation: "legacy-absent",
        mode,
        image: null,
        control_plane: { state: "legacy-absent" },
        recovery_epoch: { state: "legacy-absent" }
      }
    : {
        generation: "durable-v2",
        mode,
        image: `ghcr.io/yengalvez/bot-runner@sha256:${"9".repeat(64)}`,
        recovery_epoch: {
          state: "bound",
          value: "33333333-3333-4333-8333-333333333333"
        },
        control_plane: durableInventoryControlPlane(evidence)
      };
  return {
    schema_version: 4,
    namespace: NAMESPACE,
    namespace_uid: NAMESPACE_UID,
    bot_runner_runtime: runtime,
    deployments
  };
}

function inventoryIdentity(apiVersion, kind, name, uid, namespaceName = undefined) {
  return {
    api_version: apiVersion,
    kind,
    name,
    ...(namespaceName === undefined ? {} : { namespace: namespaceName }),
    uid,
    resource_version: "inventory-rv"
  };
}

function durableInventoryControlPlane(evidence) {
  const inventoryEntry = value => inventoryIdentity(
    value.api_version,
    value.kind,
    value.name,
    value.uid,
    value.namespace
  );
  return {
    state: "kubernetes-active",
    namespaces: evidence.control_plane.namespaces.map(value => inventoryEntry(value)),
    namespaced_resources: evidence.control_plane.namespaced_resources.map(
      value => inventoryEntry(value)
    ),
    cluster_resources: evidence.control_plane.cluster_resources.map(
      value => inventoryEntry(value)
    )
  };
}

function legacyInventory() {
  return deploymentInventory("process-local");
}

function runHelper(args, environment = process.env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: environment
  });
}

function writeLegacyKubectlStub(directory) {
  const stub = writePrivate(directory, "kubectl", `#!/usr/bin/env node
const args = process.argv.slice(2);
const get = args.indexOf("get");
if (get === -1) process.exit(0);
const kind = args[get + 1];
const name = args[get + 2];
if (kind === "deployment" && name === "bot-orchestrator") {
  process.stdout.write(process.env.STUB_PARENT_DEPLOYMENT_JSON);
} else if (kind === "namespace" && name === "kube-system") {
  process.stdout.write(process.env.STUB_CLUSTER_NAMESPACE_JSON);
} else if (kind === "namespace" && name === "hcce") {
  process.stdout.write(process.env.STUB_PARENT_NAMESPACE_JSON);
}
`);
  fs.chmodSync(stub, 0o700);
  return stub;
}

test("legacy evidence is complete, snake_case, quiesced, and binds the stable cluster anchor", () => {
  const evidence = envelope(buildCheckpointEvidenceCore(baseLive(), inputs()));
  assert.equal(validateEvidenceEnvelope(evidence), evidence);
  assert.equal(evidence.schema_version, 3);
  assert.equal(evidence.recovery_operation_fence_state, "dormant");
  assert.equal(evidence.runtime_generation, "legacy-absent");
  assert.equal(evidence.parent_deployment.replicas, 0);
  assert.deepEqual(evidence.cluster.anchor, {
    api_version: "v1",
    kind: "Namespace",
    name: "kube-system",
    uid: "cluster-anchor-uid"
  });
  assert.equal(Object.hasOwn(evidence.cluster.anchor, "resource_version"), false);
  assert.equal(evidence.admission.parent_resources.absence_verified, true);
  assert.equal(evidence.runner_role, null);
  assert.equal(evidence.runner_role_binding, null);
  assert.deepEqual(evidence.quiescence, { runners: 0, intents: 0, fences: [] });
});

test("durable evidence verifies exact journal HMAC, five hashes, five observed pairs, and fences", () => {
  const fence = exactGuard("fence");
  const live = durableLive({ fences: [fence] });
  const evidence = envelope(buildCheckpointEvidenceCore(live, inputs(live.manifest)));
  assert.equal(validateEvidenceEnvelope(evidence), evidence);
  assert.equal(evidence.runtime_generation, "durable-v2");
  assert.equal(evidence.journal.hmac_verification, "verified-owner-key");
  assert.equal(
    evidence.journal.canonical_json,
    live.journal_config_map.data["journal.json"]
  );
  assert.match(evidence.journal.canonical_json, /"hmacSha256":"[0-9a-f]{64}"/);
  assert.equal(Object.keys(evidence.journal.contract.target_hashes).length, 5);
  assert.deepEqual(Object.keys(evidence.admission.pairs).sort(),
    PAIR_DEFINITIONS.map(({ key }) => key).sort());
  assert.equal(Object.values(evidence.admission.pairs).every(pair => pair.observed), true);
  assert.equal(evidence.control_plane.state, "present");
  assert.equal(evidence.control_plane.namespaces.length, 2);
  assert.equal(evidence.control_plane.namespaced_resources.length, 13);
  assert.equal(evidence.control_plane.cluster_resources.length, 10);
  const secretContract = namespacedControlPlaneEntry(
    evidence,
    live.manifest,
    "runner_pull_secret"
  );
  assert.deepEqual(Object.keys(secretContract).sort(), [
    "api_version",
    "contract_hmac_sha256",
    "kind",
    "name",
    "namespace",
    "resource_version",
    "terminating",
    "uid"
  ]);
  assert.match(secretContract.contract_hmac_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(evidence.runner_role, {
    api_version: "rbac.authorization.k8s.io/v1",
    kind: "Role",
    name: "bot-orchestrator-runner-pods",
    namespace: RUNNER_NAMESPACE,
    uid: "runner-role-uid",
    resource_version: "41",
    contract_sha256: sha256Canonical(live.manifest.expected_runner_role),
    inert_contract_sha256: sha256Canonical(
      expectedRunnerRole("restore-fence", { inert: true })
    ),
    terminating: false
  });
  assert.deepEqual(evidence.runner_role_binding, {
    api_version: "rbac.authorization.k8s.io/v1",
    kind: "RoleBinding",
    name: "bot-orchestrator-runner-pods",
    namespace: RUNNER_NAMESPACE,
    uid: "runner-role-binding-uid",
    resource_version: "42",
    contract_sha256: sha256Canonical(live.manifest.expected_runner_role_binding),
    terminating: false
  });
  assert.equal(evidence.quiescence.fences[0].uid, "fence-uid");
  const serialized = canonicalJson(evidence);
  assert.equal(serialized.includes(KEY_SENTINEL), false);
  assert.equal(serialized.includes("source-registry-auth"), false);
  assert.equal(serialized.includes("PROCESS_LOCAL_CUTOVER_KEY_PATH"), false);
});

test("recovery operation fence evidence binds one explicit dormant or active state", () => {
  const evidenceByState = new Map();
  for (const state of ["dormant", "active"]) {
    const live = durableLive({
      fences: [exactGuard("fence")],
      recoveryOperationFenceState: state
    });
    const evidence = envelope(buildCheckpointEvidenceCore(
      live,
      inputs(live.manifest, state)
    ));
    assert.equal(live.manifest.recovery_phase, "active");
    assert.equal(live.manifest.recovery_operation_fence_state, "dormant");
    assert.equal(validateEvidenceEnvelope(evidence), evidence);
    assert.equal(evidence.recovery_operation_fence_state, state);
    assert.equal(
      evidence.admission.pairs.recovery_operation_fence.binding.uid,
      "recovery_operation_fence-binding-uid"
    );
    assert.match(
      evidence.admission.pairs.recovery_operation_fence.binding.resource_version,
      /^\S+$/
    );
    evidenceByState.set(state, evidence);

    const mislabeled = structuredClone(evidence);
    mislabeled.recovery_operation_fence_state = state === "active" ? "dormant" : "active";
    assert.throws(
      () => validateEvidenceEnvelope(mislabeled),
      /checkpoint_evidence_durable_invalid/
    );
  }
  assert.notEqual(
    evidenceByState.get("dormant").admission.pairs.recovery_operation_fence.binding.spec_sha256,
    evidenceByState.get("active").admission.pairs.recovery_operation_fence.binding.spec_sha256
  );

  const activeLive = durableLive({
    fences: [exactGuard("fence")],
    recoveryOperationFenceState: "active"
  });
  const impossibleActiveManifest = structuredClone(activeLive.manifest);
  const impossibleActivePair = recoveryOperationFencePair("active");
  impossibleActiveManifest.recovery_operation_fence_state = "active";
  impossibleActiveManifest.expected_pairs.recovery_operation_fence = impossibleActivePair;
  impossibleActiveManifest.expected_control_plane.cluster_resources
    .recovery_operation_fence_policy = impossibleActivePair.policy;
  impossibleActiveManifest.expected_control_plane.cluster_resources
    .recovery_operation_fence_binding = impossibleActivePair.binding;
  assert.throws(
    () => buildCheckpointEvidenceCore(
      activeLive,
      inputs(impossibleActiveManifest, "active")
    ),
    /durable_checkpoint_recovery_operation_fence_state_invalid/
  );
  assert.throws(
    () => buildCheckpointEvidenceCore(activeLive, inputs(activeLive.manifest, "dormant")),
    /admission_pair_not_exact|durable_control_plane_manifest_drift/
  );
  const dormantLive = durableLive({ fences: [exactGuard("fence")] });
  assert.throws(
    () => buildCheckpointEvidenceCore(dormantLive, inputs(dormantLive.manifest, "active")),
    /admission_pair_not_exact|durable_control_plane_manifest_drift/
  );
  assert.throws(
    () => buildCheckpointEvidenceCore(baseLive(), inputs(null, "active")),
    /recovery_operation_fence_state_unverifiable/
  );
});

test("historical source permits only the explicit recovery binding CAS with stable identities", () => {
  const fence = exactGuard("fence");
  const checkpointLive = durableLive({ fences: [fence] });
  const checkpoint = envelope(buildCheckpointEvidenceCore(
    checkpointLive,
    inputs(checkpointLive.manifest, "dormant")
  ));
  const activeLive = durableLive({
    fences: [fence],
    replicas: 1,
    recoveryOperationFenceState: "active"
  });
  activeLive.admission.recovery_operation_fence.binding.metadata.resourceVersion = "999";
  const active = buildCheckpointEvidenceCore(
    activeLive,
    historicalInputs("active"),
    verificationBuildOptions(checkpoint, "active-source")
  );
  assert.equal(active.recovery_operation_fence_state, "active");
  assert.equal(
    active.admission.pairs.recovery_operation_fence.binding.uid,
    checkpoint.admission.pairs.recovery_operation_fence.binding.uid
  );
  assert.equal(active.admission.pairs.recovery_operation_fence.binding.resource_version, "999");
  assert.equal(verifyHistoricalSourceCore(active, checkpoint, "active-source"), active);

  const mislabeledActive = structuredClone(active);
  mislabeledActive.recovery_operation_fence_state = "dormant";
  assert.throws(
    () => verifyHistoricalSourceCore(mislabeledActive, checkpoint, "active-source"),
    /checkpoint_evidence_historical_live_mismatch/
  );

  assert.throws(
    () => buildCheckpointEvidenceCore(
      activeLive,
      historicalInputs("dormant"),
      verificationBuildOptions(checkpoint, "active-source")
    ),
    /durable_source_admission_binding_invalid/
  );

  for (const [label, mutate, expectedError] of [
    [
      "binding UID replacement",
      live => { live.admission.recovery_operation_fence.binding.metadata.uid = "replacement"; },
      /durable_source_admission_drift/
    ],
    [
      "binding spec drift",
      live => { live.admission.recovery_operation_fence.binding.spec.paramRef = { name: "bad" }; },
      /durable_source_admission_binding_invalid/
    ],
    [
      "policy UID replacement",
      live => { live.admission.recovery_operation_fence.policy.metadata.uid = "replacement"; },
      /durable_source_admission_drift/
    ],
    [
      "policy generation drift",
      live => {
        live.admission.recovery_operation_fence.policy.metadata.generation = 5;
        live.admission.recovery_operation_fence.policy.status.observedGeneration = 5;
      },
      /durable_source_admission_drift/
    ],
    [
      "policy spec drift",
      live => { live.admission.recovery_operation_fence.policy.spec.failurePolicy = "Ignore"; },
      /durable_source_admission_binding_invalid/
    ]
  ]) {
    const drifted = structuredClone(activeLive);
    mutate(drifted);
    assert.throws(
      () => buildCheckpointEvidenceCore(
        drifted,
        historicalInputs("active"),
        verificationBuildOptions(checkpoint, "active-source")
      ),
      expectedError,
      label
    );
  }
});

test("schema-4 inventory validation requires the complete mode-specific deployment contract", () => {
  const legacyEvidence = envelope(buildCheckpointEvidenceCore(baseLive(), inputs()));
  const legacy = legacyInventory();
  assert.equal(validateDeploymentInventory(legacy, legacyEvidence), legacy);

  const historicalRepositories = structuredClone(legacy);
  historicalRepositories.deployments.find(item => item.name === "pgsql")
    .containers[0].image =
      `docker.io/mozillareality/postgres@sha256:${"a".repeat(64)}`;
  historicalRepositories.deployments.find(item => item.name === "reticulum")
    .containers.find(item => item.name === "postgrest").image =
      `docker.io/mozillareality/postgrest@sha256:${"b".repeat(64)}`;
  historicalRepositories.deployments.find(item => item.name === "pgbouncer")
    .containers[0].image =
      `docker.io/mozillareality/pgbouncer@sha256:${"d".repeat(64)}`;
  historicalRepositories.deployments.find(item => item.name === "pgbouncer-t")
    .containers[0].image =
      `docker.io/mozillareality/pgbouncer@sha256:${"e".repeat(64)}`;
  assert.equal(
    validateDeploymentInventory(historicalRepositories, legacyEvidence),
    historicalRepositories
  );
  for (const [deploymentName, containerName, repository] of [
    ["pgbouncer", "pgbouncer", "docker.io/mozillareality/pgbouncer-lookalike"],
    ["pgbouncer-t", "pgbouncer-t", "docker.io/mozillareality/pgbouncer-lookalike"],
    ["pgsql", "postgresql", "docker.io/mozillareality/postgres-lookalike"],
    ["reticulum", "postgrest", "docker.io/mozillareality/postgrest-lookalike"]
  ]) {
    const lookalike = structuredClone(historicalRepositories);
    lookalike.deployments.find(item => item.name === deploymentName)
      .containers.find(item => item.name === containerName).image =
        `${repository}@sha256:${"c".repeat(64)}`;
    assert.throws(
      () => validateDeploymentInventory(lookalike, legacyEvidence),
      /deployment_inventory_evidence_mismatch:container_image/
    );
  }

  const durableLiveState = durableLive({ fences: [exactGuard("fence")] });
  const durableEvidence = envelope(buildCheckpointEvidenceCore(
    durableLiveState,
    inputs(durableLiveState.manifest)
  ));
  const durable = deploymentInventory("kubernetes-pod", durableEvidence);
  assert.equal(validateDeploymentInventory(durable, durableEvidence), durable);

  const invalidCases = [
    {
      schema_version: 4,
      namespace: NAMESPACE,
      namespace_uid: NAMESPACE_UID,
      bot_runner_runtime: { generation: "legacy-absent" },
      deployments: [{ name: "bot-orchestrator", uid: "parent-deployment-uid" }]
    },
    (() => {
      const value = structuredClone(legacy);
      value.extra = true;
      return value;
    })(),
    (() => {
      const value = structuredClone(legacy);
      value.bot_runner_runtime.mode = "kubernetes-pod";
      return value;
    })(),
    (() => {
      const value = structuredClone(legacy);
      value.deployments.find(item => item.name === "bot-orchestrator").uid = "replacement-parent";
      return value;
    })(),
    (() => {
      const value = structuredClone(legacy);
      value.deployments.find(item => item.name === "coturn").containers[0].image =
        `evil.invalid/coturn@sha256:${"8".repeat(64)}`;
      return value;
    })(),
    (() => {
      const value = structuredClone(legacy);
      value.deployments[0].unexpected = true;
      return value;
    })()
  ];
  for (const invalid of invalidCases) {
    assert.throws(
      () => validateDeploymentInventory(invalid, legacyEvidence),
      /deployment_inventory_evidence_mismatch/
    );
  }

  const wrongParentUid = structuredClone(legacy);
  wrongParentUid.deployments.find(item => item.name === "bot-orchestrator").uid =
    "replacement-parent";
  assert.throws(
    () => validateDeploymentInventory(wrongParentUid, legacyEvidence),
    /deployment_inventory_evidence_mismatch:parent_uid/
  );
  const wrongParentReplicas = structuredClone(legacy);
  wrongParentReplicas.deployments.find(item => item.name === "bot-orchestrator").replicas = 0;
  assert.throws(
    () => validateDeploymentInventory(wrongParentReplicas, legacyEvidence),
    /deployment_inventory_evidence_mismatch:parent_replicas/
  );

  for (const mutate of [
    value => { value.bot_runner_runtime.recovery_epoch.value = "not-a-uuid"; },
    value => { value.bot_runner_runtime.control_plane.namespaces.pop(); },
    value => { value.bot_runner_runtime.control_plane.cluster_resources.pop(); },
    value => {
      value.bot_runner_runtime.control_plane.namespaces[1].uid = "replacement-runner-namespace";
    },
    value => {
      value.bot_runner_runtime.control_plane.cluster_resources[0].uid = "replacement-policy";
    },
    value => {
      value.bot_runner_runtime.control_plane.namespaced_resources[0].uid = "replacement-parent-sa";
    },
    value => {
      value.bot_runner_runtime.control_plane.namespaced_resources.find(resource =>
        resource.api_version === "rbac.authorization.k8s.io/v1" &&
        resource.kind === "Role" && resource.namespace === RUNNER_NAMESPACE &&
        resource.name === "bot-orchestrator-runner-pods"
      ).uid = "replacement-runner-role";
    },
    value => {
      value.bot_runner_runtime.control_plane.namespaced_resources.find(resource =>
        resource.api_version === "rbac.authorization.k8s.io/v1" &&
        resource.kind === "RoleBinding" && resource.namespace === RUNNER_NAMESPACE &&
        resource.name === "bot-orchestrator-runner-pods"
      ).uid = "replacement-runner-role-binding";
    },
    value => { value.bot_runner_runtime.control_plane.unexpected = true; }
  ]) {
    const invalid = structuredClone(durable);
    mutate(invalid);
    assert.throws(
      () => validateDeploymentInventory(invalid, durableEvidence),
      /deployment_inventory_evidence_mismatch/
    );
  }
});

test("offline durable evidence rejects non-exact signed journal nesting and invalid issued_at", () => {
  const live = durableLive({ fences: [exactGuard("fence")] });
  const valid = envelope(buildCheckpointEvidenceCore(live, inputs(live.manifest)));
  assert.equal(validateEvidenceEnvelope(valid), valid);
  const secondsPrecision = resignJournalEvidence(structuredClone(valid), journal => {
    journal.issuedAt = "2026-07-19T12:00:00Z";
  });
  assert.equal(validateEvidenceEnvelope(secondsPrecision), secondsPrecision);
  const cleanInstall = resignJournalEvidence(structuredClone(valid), journal => {
    journal.mode = "clean-install";
    journal.authorizationSha256 = null;
    journal.baselineDeployment = null;
  });
  assert.equal(validateEvidenceEnvelope(cleanInstall), cleanInstall);

  for (const mutate of [
    journal => { journal.namespace.unexpected = true; },
    journal => { journal.targetHashes.unexpected = "a".repeat(64); },
    journal => { journal.baselineDeployment.unexpected = true; },
    journal => { journal.baselineDeployment.name = "replacement-parent"; },
    journal => { journal.baselineDeployment.uid = "replacement-parent-uid"; },
    journal => { journal.baselineDeployment.resourceVersion = ""; },
    journal => { journal.issuedAt = "2026-99-99T12:00:00.000Z"; },
    journal => { journal.issuedAt = "2026-02-30T12:00:00.000Z"; },
    journal => { journal.issuedAt = "2026-07-20T99:00:00.000Z"; }
  ]) {
    const invalid = resignJournalEvidence(structuredClone(valid), mutate);
    assert.throws(
      () => validateEvidenceEnvelope(invalid),
      /checkpoint_evidence_durable_invalid/
    );
  }
  const invalidCleanInstall = resignJournalEvidence(structuredClone(cleanInstall), journal => {
    journal.baselineDeployment = {
      name: "bot-orchestrator",
      uid: "parent-deployment-uid",
      resourceVersion: "10"
    };
  });
  assert.throws(
    () => validateEvidenceEnvelope(invalidCleanInstall),
    /checkpoint_evidence_durable_invalid/
  );
});

test("offline evidence requires finite ordered capture timestamps and canonical fence names", () => {
  const legacy = envelope(buildCheckpointEvidenceCore(baseLive(), inputs()));
  const secondsPrecision = structuredClone(legacy);
  secondsPrecision.capture_window = {
    started_at_utc: "2026-07-20T00:00:00Z",
    completed_at_utc: "2026-07-20T00:00:01Z"
  };
  assert.equal(validateEvidenceEnvelope(secondsPrecision), secondsPrecision);
  for (const [started, completed] of [
    ["2026-99-20T00:00:00.000Z", "2026-07-20T00:00:01.000Z"],
    ["2026-02-30T00:00:00.000Z", "2026-03-02T00:00:01.000Z"],
    ["2026-07-20T99:00:00.000Z", "2026-07-20T00:00:01.000Z"],
    ["2026-07-20T00:00:00.000Z", "2026-99-20T00:00:01.000Z"],
    ["2026-07-20T00:00:02.000Z", "2026-07-20T00:00:01.000Z"]
  ]) {
    const invalid = structuredClone(legacy);
    invalid.capture_window = {
      started_at_utc: started,
      completed_at_utc: completed
    };
    assert.throws(() => validateEvidenceEnvelope(invalid), /shape_invalid/);
  }

  const live = durableLive({ fences: [exactGuard("fence")] });
  const mismatchedFence = envelope(buildCheckpointEvidenceCore(live, inputs(live.manifest)));
  mismatchedFence.quiescence.fences[0].room_key = `b${ROOM_KEY.slice(1)}`;
  assert.throws(() => validateEvidenceEnvelope(mismatchedFence), /shape_invalid/);
});

test("historical source verification accepts resource-version drift and additional permanent fences", () => {
  const checkpointLive = durableLive({ fences: [exactGuard("fence")] });
  const checkpoint = envelope(buildCheckpointEvidenceCore(
    checkpointLive,
    inputs(checkpointLive.manifest)
  ));
  const activeIdentity = runnerIdentity("cccccccccccccccccccc");
  const activeLive = durableLive({
    fences: [
      exactGuard("fence"),
      secondFence(),
      exactRunner("active-runner-uid", "72", activeIdentity),
      exactGuard("intent", "armed", "active-intent-uid", "73", activeIdentity)
    ],
    replicas: 1
  });
  advanceDurableResourceVersions(activeLive);
  const active = buildCheckpointEvidenceCore(
    activeLive,
    historicalInputs(),
    verificationBuildOptions(checkpoint, "active-source")
  );

  assert.equal(active.parent_deployment.replicas, 1);
  assert.equal(active.runner_role.uid, checkpoint.runner_role.uid);
  assert.notEqual(
    active.runner_role.resource_version,
    checkpoint.runner_role.resource_version
  );
  assert.equal(
    active.runner_role.contract_sha256,
    checkpoint.runner_role.contract_sha256
  );
  assert.equal(active.runner_role_binding.uid, checkpoint.runner_role_binding.uid);
  assert.notEqual(
    active.runner_role_binding.resource_version,
    checkpoint.runner_role_binding.resource_version
  );
  assert.equal(
    active.runner_role_binding.contract_sha256,
    checkpoint.runner_role_binding.contract_sha256
  );
  assert.equal(
    active.parent_deployment.spec_sha256,
    checkpoint.parent_deployment.spec_sha256
  );
  assert.equal(verifyHistoricalSourceCore(active, checkpoint, "active-source"), active);
  assert.equal(active.quiescence.fences.length, 2);
  assert.equal(active.quiescence.runners, 1);
  assert.equal(active.quiescence.intents, 1);

  const replacedRoleLive = structuredClone(activeLive);
  replacedRoleLive.runner_role.metadata.uid = "replacement-runner-role-uid";
  assert.throws(
    () => buildCheckpointEvidenceCore(
      replacedRoleLive,
      historicalInputs(),
      verificationBuildOptions(checkpoint, "active-source")
    ),
    /durable_source_runner_role_drift/
  );

  const driftedRoleLive = structuredClone(activeLive);
  driftedRoleLive.runner_role.rules[0].verbs.push("update");
  assert.equal(
    driftedRoleLive.runner_role.metadata.uid,
    checkpoint.runner_role.uid
  );
  assert.throws(
    () => buildCheckpointEvidenceCore(
      driftedRoleLive,
      historicalInputs(),
      verificationBuildOptions(checkpoint, "active-source")
    ),
    /durable_source_runner_role_drift/
  );

  const replacedRoleBindingLive = structuredClone(activeLive);
  replacedRoleBindingLive.runner_role_binding.metadata.uid =
    "replacement-runner-role-binding-uid";
  assert.throws(
    () => buildCheckpointEvidenceCore(
      replacedRoleBindingLive,
      historicalInputs(),
      verificationBuildOptions(checkpoint, "active-source")
    ),
    /durable_source_runner_role_binding_drift/
  );

  const driftedRoleBindingLive = structuredClone(activeLive);
  driftedRoleBindingLive.runner_role_binding.subjects[0].name = "replacement-subject";
  assert.throws(
    () => buildCheckpointEvidenceCore(
      driftedRoleBindingLive,
      historicalInputs(),
      verificationBuildOptions(checkpoint, "active-source")
    ),
    /durable_source_runner_role_binding_drift/
  );

  const quiescedLive = makeRunnerRoleInert(
    durableLive({ fences: [exactGuard("fence")], replicas: 0 })
  );
  advanceDurableResourceVersions(quiescedLive);
  const quiesced = buildCheckpointEvidenceCore(
    quiescedLive,
    historicalInputs(),
    verificationBuildOptions(checkpoint, "quiesced-source")
  );
  assert.equal(
    verifyHistoricalSourceCore(quiesced, checkpoint, "quiesced-source"),
    quiesced
  );
  assert.throws(
    () => verifyHistoricalSourceCore(active, checkpoint, "quiesced-source"),
    /historical_live_mismatch/
  );
  assert.throws(
    () => verifyHistoricalSourceCore(quiesced, checkpoint, "active-source"),
    /historical_live_mismatch/
  );
});

test("historical source rejects same-UID drift in guard SA, quota, policy, and Secret HMAC", () => {
  const checkpointLive = durableLive({ fences: [exactGuard("fence")] });
  const checkpoint = envelope(buildCheckpointEvidenceCore(
    checkpointLive,
    inputs(checkpointLive.manifest)
  ));
  const sourceLive = durableLive({ fences: [exactGuard("fence")], replicas: 1 });
  advanceDurableResourceVersions(sourceLive);
  const cases = [
    live => { live.guard_service_account.automountServiceAccountToken = false; },
    live => { live.runner_quota.spec.hard.pods = "999"; },
    live => { live.runner_default_deny.spec.policyTypes = ["Ingress"]; },
    live => {
      live.runner_pull_secret.data[".dockerconfigjson"] = Buffer.from(
        "same-uid-secret-drift"
      ).toString("base64");
    }
  ];
  for (const mutate of cases) {
    const drifted = structuredClone(sourceLive);
    mutate(drifted);
    assert.equal(
      drifted.runner_pull_secret.metadata.uid,
      checkpointLive.runner_pull_secret.metadata.uid
    );
    assert.equal(
      drifted.guard_service_account.metadata.uid,
      checkpointLive.guard_service_account.metadata.uid
    );
    assert.equal(drifted.runner_quota.metadata.uid, checkpointLive.runner_quota.metadata.uid);
    assert.equal(
      drifted.runner_default_deny.metadata.uid,
      checkpointLive.runner_default_deny.metadata.uid
    );
    assert.throws(
      () => buildCheckpointEvidenceCore(
        drifted,
        historicalInputs(),
        verificationBuildOptions(checkpoint, "active-source")
      ),
      /durable_control_plane_historical_drift/
    );
  }
});

test("target modes validate new manifests while preserving source journal, UIDs, and fences", () => {
  const checkpointLive = durableLive({
    fences: [exactGuard("fence")],
    recoveryOperationFenceState: "active"
  });
  const checkpoint = envelope(buildCheckpointEvidenceCore(
    checkpointLive,
    inputs(checkpointLive.manifest, "active")
  ));
  assert.equal(checkpoint.recovery_operation_fence_state, "active");
  assert.equal(checkpointLive.manifest.recovery_operation_fence_state, "dormant");
  const inventory = deploymentInventory("kubernetes-pod", checkpoint);
  assert.equal(
    verifyManifestEpochBinding(
      "checkpoint",
      inputs(checkpointLive.manifest, "active"),
      inventory,
      checkpoint
    ),
    undefined
  );

  const restoreFenceManifest = targetManifestFixture("restore-fence");
  const restoreFenceLive = durableTargetLive(checkpointLive, restoreFenceManifest, {
    pods: [exactGuard("fence"), secondFence()],
    replicas: 0
  });
  const restoreFence = buildCheckpointEvidenceCore(
    restoreFenceLive,
    inputs(restoreFenceManifest, "active"),
    verificationBuildOptions(checkpoint, "quiesced-target")
  );
  assert.equal(restoreFenceManifest.recovery_operation_fence_state, "active");
  assert.equal(restoreFence.recovery_operation_fence_state, "active");
  assert.equal(
    restoreFence.journal.canonical_json,
    checkpoint.journal.canonical_json
  );
  assert.notEqual(
    restoreFence.parent_deployment.spec_sha256,
    checkpoint.parent_deployment.spec_sha256
  );
  assert.equal(
    verifyHistoricalSourceCore(restoreFence, checkpoint, "quiesced-target"),
    restoreFence
  );
  verifyManifestEpochBinding(
    "quiesced-target",
    inputs(restoreFenceManifest, "active"),
    inventory,
    checkpoint
  );
  assert.throws(
    () => buildCheckpointEvidenceCore(
      restoreFenceLive,
      inputs(restoreFenceManifest, "dormant"),
      verificationBuildOptions(checkpoint, "quiesced-target")
    ),
    /durable_target_recovery_operation_fence_state_invalid/
  );
  const replacedRestoreFenceRole = structuredClone(restoreFenceLive);
  replacedRestoreFenceRole.runner_role.metadata.uid = "replacement-target-role-uid";
  assert.throws(
    () => buildCheckpointEvidenceCore(
      replacedRestoreFenceRole,
      inputs(restoreFenceManifest),
      verificationBuildOptions(checkpoint, "quiesced-target")
    ),
    /durable_target_runner_role_uid_mismatch/
  );
  const replacedRestoreFenceRoleBinding = structuredClone(restoreFenceLive);
  replacedRestoreFenceRoleBinding.runner_role_binding.metadata.uid =
    "replacement-target-role-binding-uid";
  assert.throws(
    () => buildCheckpointEvidenceCore(
      replacedRestoreFenceRoleBinding,
      inputs(restoreFenceManifest),
      verificationBuildOptions(checkpoint, "quiesced-target")
    ),
    /durable_target_runner_role_binding_uid_mismatch/
  );

  const activeManifest = targetManifestFixture("active");
  const quiescedActiveLive = durableTargetLive(checkpointLive, activeManifest, {
    pods: [exactGuard("fence"), secondFence()],
    replicas: 0,
    quiescedActive: true
  });
  const quiescedActive = buildCheckpointEvidenceCore(
    quiescedActiveLive,
    inputs(activeManifest),
    verificationBuildOptions(checkpoint, "quiesced-active-target")
  );
  assert.equal(quiescedActive.quiescence.runners, 0);
  assert.equal(quiescedActive.quiescence.intents, 0);
  assert.equal(
    verifyHistoricalSourceCore(
      quiescedActive,
      checkpoint,
      "quiesced-active-target"
    ),
    quiescedActive
  );
  verifyManifestEpochBinding(
    "quiesced-active-target",
    inputs(activeManifest),
    inventory,
    checkpoint
  );
  const replacedQuiescedActiveRole = structuredClone(quiescedActiveLive);
  replacedQuiescedActiveRole.runner_role.metadata.uid = "replacement-qat-role-uid";
  assert.throws(
    () => buildCheckpointEvidenceCore(
      replacedQuiescedActiveRole,
      inputs(activeManifest),
      verificationBuildOptions(checkpoint, "quiesced-active-target")
    ),
    /durable_target_runner_role_uid_mismatch/
  );
  const replacedQuiescedActiveRoleBinding = structuredClone(quiescedActiveLive);
  replacedQuiescedActiveRoleBinding.runner_role_binding.metadata.uid =
    "replacement-qat-role-binding-uid";
  assert.throws(
    () => buildCheckpointEvidenceCore(
      replacedQuiescedActiveRoleBinding,
      inputs(activeManifest),
      verificationBuildOptions(checkpoint, "quiesced-active-target")
    ),
    /durable_target_runner_role_binding_uid_mismatch/
  );
  assert.throws(
    () => buildCheckpointEvidenceCore(
      durableTargetLive(checkpointLive, restoreFenceManifest, {
        pods: [exactGuard("fence")],
        replicas: 0
      }),
      inputs(restoreFenceManifest),
      verificationBuildOptions(checkpoint, "quiesced-active-target")
    ),
    /manifest_phase_invalid/
  );
  const nonQuiescedIdentity = runnerIdentity("eeeeeeeeeeeeeeeeeeee");
  assert.throws(
    () => buildCheckpointEvidenceCore(
      durableTargetLive(checkpointLive, activeManifest, {
        pods: [
          exactRunner(
            "non-quiesced-runner-uid",
            "non-quiesced-runner-rv",
            nonQuiescedIdentity
          ),
          exactGuard(
            "intent",
            "armed",
            "non-quiesced-intent-uid",
            "non-quiesced-intent-rv",
            nonQuiescedIdentity
          )
        ],
        replicas: 0,
        quiescedActive: true
      }),
      inputs(activeManifest),
      verificationBuildOptions(checkpoint, "quiesced-active-target")
    ),
    /runner_namespace_not_quiescent/
  );

  const activeIdentity = runnerIdentity("dddddddddddddddddddd");
  const activeLive = durableTargetLive(checkpointLive, activeManifest, {
    pods: [
      exactGuard("fence"),
      exactRunner("target-runner-uid", "target-runner-rv", activeIdentity),
      exactGuard("intent", "armed", "target-intent-uid", "target-intent-rv", activeIdentity)
    ],
    replicas: 1
  });
  const active = buildCheckpointEvidenceCore(
    activeLive,
    inputs(activeManifest, "dormant"),
    verificationBuildOptions(checkpoint, "active-target")
  );
  assert.equal(activeManifest.recovery_operation_fence_state, "dormant");
  assert.equal(active.recovery_operation_fence_state, "dormant");
  assert.equal(active.quiescence.runners, 1);
  assert.equal(active.quiescence.intents, 1);
  assert.equal(verifyHistoricalSourceCore(active, checkpoint, "active-target"), active);
  verifyManifestEpochBinding(
    "active-target",
    inputs(activeManifest, "dormant"),
    inventory,
    checkpoint
  );

  const activeFenceTargetLive = structuredClone(activeLive);
  activeFenceTargetLive.admission.recovery_operation_fence.binding.spec = structuredClone(
    recoveryOperationFencePair("active").binding.spec
  );
  assert.throws(
    () => buildCheckpointEvidenceCore(
      activeFenceTargetLive,
      inputs(activeManifest, "active"),
      verificationBuildOptions(checkpoint, "active-target")
    ),
    /durable_target_recovery_operation_fence_state_invalid/
  );

  for (const key of [
    "guard_service_account",
    "runner_quota",
    "runner_default_deny",
    "runner_pull_secret"
  ]) {
    const sourceEntry = namespacedControlPlaneEntry(checkpoint, checkpointLive.manifest, key);
    const targetEntry = namespacedControlPlaneEntry(active, activeManifest, key);
    const fingerprint = key === "runner_pull_secret"
      ? "contract_hmac_sha256"
      : "contract_sha256";
    assert.equal(targetEntry.uid, sourceEntry.uid);
    assert.notEqual(targetEntry[fingerprint], sourceEntry[fingerprint]);
  }

  for (const mutate of [
    live => { live.guard_service_account.automountServiceAccountToken = true; },
    live => { live.runner_quota.spec.hard.pods = "10"; },
    live => { live.runner_default_deny.spec.podSelector = {}; },
    live => {
      live.runner_pull_secret.data[".dockerconfigjson"] = Buffer.from(
        "source-registry-auth"
      ).toString("base64");
    }
  ]) {
    const drifted = structuredClone(activeLive);
    mutate(drifted);
    assert.throws(
      () => buildCheckpointEvidenceCore(
        drifted,
        inputs(activeManifest),
        verificationBuildOptions(checkpoint, "active-target")
      ),
      /durable_control_plane_manifest_drift/
    );
  }

  const sameEpoch = structuredClone(activeManifest);
  sameEpoch.recovery_epoch = checkpointLive.manifest.recovery_epoch;
  assert.throws(
    () => verifyManifestEpochBinding(
      "active-target",
      inputs(sameEpoch),
      inventory,
      checkpoint
    ),
    /recovery_epoch_binding_invalid/
  );
  const replacedUid = structuredClone(active);
  replacedUid.admission.pairs.runner_protocol.policy.uid = "target-replacement-policy-uid";
  assert.throws(
    () => verifyHistoricalSourceCore(replacedUid, checkpoint, "active-target"),
    /historical_live_mismatch/
  );

  const missingFenceLive = durableTargetLive(checkpointLive, activeManifest, {
    pods: [],
    replicas: 1
  });
  const missingFence = buildCheckpointEvidenceCore(
    missingFenceLive,
    inputs(activeManifest),
    verificationBuildOptions(checkpoint, "active-target")
  );
  assert.throws(
    () => verifyHistoricalSourceCore(missingFence, checkpoint, "active-target"),
    /historical_live_mismatch/
  );

  const replacedFenceLive = durableTargetLive(checkpointLive, activeManifest, {
    pods: [exactGuard("fence", "unarmed", "target-replacement-fence-uid")],
    replicas: 1
  });
  const replacedFence = buildCheckpointEvidenceCore(
    replacedFenceLive,
    inputs(activeManifest),
    verificationBuildOptions(checkpoint, "active-target")
  );
  assert.throws(
    () => verifyHistoricalSourceCore(replacedFence, checkpoint, "active-target"),
    /historical_live_mismatch/
  );
});

test("active source rejects unknown Pods and incoherent intent-runner identities", () => {
  const checkpointLive = durableLive();
  const checkpoint = envelope(buildCheckpointEvidenceCore(
    checkpointLive,
    inputs(checkpointLive.manifest)
  ));
  const firstIdentity = runnerIdentity("cccccccccccccccccccc");
  const collidingIdentity = runnerIdentity("ccccccccccccccccdddd");
  assert.equal(firstIdentity.name, collidingIdentity.name);
  const cases = [
    [
      {
        apiVersion: "v1",
        kind: "Pod",
        metadata: {
          name: "unknown",
          namespace: RUNNER_NAMESPACE,
          uid: "unknown-uid",
          resourceVersion: "80",
          labels: { app: "unknown" }
        }
      }
    ],
    [
      exactRunner("conflicting-runner-uid", "81", firstIdentity),
      exactGuard("intent", "armed", "conflicting-intent-uid", "82", collidingIdentity)
    ],
    [
      exactRunner("premature-runner-uid", "83", firstIdentity),
      exactGuard("intent", "unarmed", "unarmed-intent-uid", "84", firstIdentity)
    ]
  ];
  for (const pods of cases) {
    const live = durableLive({ fences: pods, replicas: 1 });
    assert.throws(
      () => buildCheckpointEvidenceCore(
        live,
        inputs(live.manifest),
        verificationBuildOptions(checkpoint, "active-source")
      )
    );
  }

  const quiesced = durableLive({
    fences: [
      exactRunner("quiesced-runner-uid", "85", firstIdentity),
      exactGuard("intent", "armed", "quiesced-intent-uid", "86", firstIdentity)
    ],
    replicas: 0
  });
  makeRunnerRoleInert(quiesced);
  assert.throws(
    () => buildCheckpointEvidenceCore(
      quiesced,
      inputs(quiesced.manifest),
      verificationBuildOptions(checkpoint, "quiesced-source")
    ),
    /runner_namespace_not_quiescent/
  );
});

test("historical source verification rejects missing or replaced fences and parent UID/spec drift", () => {
  const checkpointLive = durableLive({ fences: [exactGuard("fence")] });
  const checkpoint = envelope(buildCheckpointEvidenceCore(
    checkpointLive,
    inputs(checkpointLive.manifest)
  ));

  const missingLive = durableLive({ fences: [], replicas: 1 });
  const missing = buildCheckpointEvidenceCore(
    missingLive,
    inputs(missingLive.manifest),
    verificationBuildOptions(checkpoint, "active-source")
  );
  assert.throws(
    () => verifyHistoricalSourceCore(missing, checkpoint, "active-source"),
    /historical_live_mismatch/
  );

  const replacedLive = durableLive({
    fences: [exactGuard("fence", "unarmed", "replacement-fence-uid")],
    replicas: 1
  });
  const replaced = buildCheckpointEvidenceCore(
    replacedLive,
    inputs(replacedLive.manifest),
    verificationBuildOptions(checkpoint, "active-source")
  );
  assert.throws(
    () => verifyHistoricalSourceCore(replaced, checkpoint, "active-source"),
    /historical_live_mismatch/
  );

  const validLive = durableLive({ fences: [exactGuard("fence")], replicas: 1 });
  const valid = buildCheckpointEvidenceCore(
    validLive,
    inputs(validLive.manifest),
    verificationBuildOptions(checkpoint, "active-source")
  );
  const replacedParent = structuredClone(valid);
  replacedParent.parent_deployment.uid = "replacement-parent-uid";
  assert.throws(
    () => verifyHistoricalSourceCore(replacedParent, checkpoint, "active-source"),
    /historical_live_mismatch/
  );
  const changedSpec = structuredClone(valid);
  changedSpec.parent_deployment.spec_sha256 = "b".repeat(64);
  assert.throws(
    () => verifyHistoricalSourceCore(changedSpec, checkpoint, "active-source"),
    /historical_live_mismatch/
  );
  for (const mutate of [
    current => { current.namespaces.runner.uid = "replacement-runner-namespace-uid"; },
    current => { current.journal.config_map.uid = "replacement-journal-uid"; },
    current => { current.admission.pairs.runner_protocol.policy.uid = "replacement-policy-uid"; },
    current => { current.admission.pairs.runner_protocol.policy.spec_sha256 = "c".repeat(64); },
    current => {
      current.admission.parent_resources.resources.role.uid = "replacement-role-uid";
    },
    current => {
      current.admission.parent_resources.resources.role.contract_sha256 = "d".repeat(64);
    }
  ]) {
    const drifted = structuredClone(valid);
    mutate(drifted);
    assert.throws(
      () => verifyHistoricalSourceCore(drifted, checkpoint, "active-source"),
      /historical_live_mismatch/
    );
  }

  const nonManifestLive = durableLive({ fences: [exactGuard("fence")], replicas: 1 });
  nonManifestLive.parent_deployment.spec.template.spec.containers[0].image =
    "example.invalid/parent:drift";
  assert.throws(
    () => buildCheckpointEvidenceCore(
      nonManifestLive,
      inputs(nonManifestLive.manifest),
      verificationBuildOptions(checkpoint, "active-source")
    ),
    /durable_source_parent_deployment_drift/
  );
});

test("live verification modes bind the historical operation without replacing the current lock ID", () => {
  const currentOperationId = "fedcba9876543210fedcba9876543210";
  assert.deepEqual(liveVerificationContract({
    "recovery-operation-fence-state": "dormant"
  }, currentOperationId), {
    mode: "checkpoint",
    expected_parent_replicas: 0,
    expected_checkpoint_operation_id: currentOperationId,
    expected_recovery_operation_fence_state: "dormant"
  });
  assert.deepEqual(liveVerificationContract({
    "live-mode": "active-source",
    "checkpoint-operation-id": OPERATION_ID,
    "recovery-operation-fence-state": "active"
  }, currentOperationId), {
    mode: "active-source",
    expected_parent_replicas: 1,
    expected_checkpoint_operation_id: OPERATION_ID,
    expected_recovery_operation_fence_state: "active"
  });
  assert.deepEqual(liveVerificationContract({
    "live-mode": "quiesced-source",
    "checkpoint-operation-id": OPERATION_ID,
    "recovery-operation-fence-state": "active"
  }, currentOperationId), {
    mode: "quiesced-source",
    expected_parent_replicas: 0,
    expected_checkpoint_operation_id: OPERATION_ID,
    expected_recovery_operation_fence_state: "active"
  });
  assert.deepEqual(liveVerificationContract({
    "live-mode": "quiesced-target",
    "checkpoint-operation-id": OPERATION_ID,
    "recovery-operation-fence-state": "active"
  }, null), {
    mode: "quiesced-target",
    expected_parent_replicas: 0,
    expected_checkpoint_operation_id: OPERATION_ID,
    expected_recovery_operation_fence_state: "active"
  });
  assert.deepEqual(liveVerificationContract({
    "live-mode": "active-target",
    "checkpoint-operation-id": OPERATION_ID,
    "recovery-operation-fence-state": "dormant"
  }, null), {
    mode: "active-target",
    expected_parent_replicas: 1,
    expected_checkpoint_operation_id: OPERATION_ID,
    expected_recovery_operation_fence_state: "dormant"
  });
  assert.deepEqual(liveVerificationContract({
    "live-mode": "quiesced-active-target",
    "checkpoint-operation-id": OPERATION_ID,
    "recovery-operation-fence-state": "dormant"
  }, null), {
    mode: "quiesced-active-target",
    expected_parent_replicas: 0,
    expected_checkpoint_operation_id: OPERATION_ID,
    expected_recovery_operation_fence_state: "dormant"
  });
  assert.throws(
    () => liveVerificationContract({
      "live-mode": "active-source",
      "recovery-operation-fence-state": "active"
    }, currentOperationId),
    /operation_binding_missing/
  );
  assert.throws(
    () => liveVerificationContract({
      "live-mode": "invalid",
      "recovery-operation-fence-state": "dormant"
    }, currentOperationId),
    /live_mode_invalid/
  );
  for (const state of [undefined, "dormant|active", "both", "ACTIVE"]) {
    assert.throws(
      () => liveVerificationContract({
        "live-mode": "checkpoint",
        ...(state === undefined ? {} : { "recovery-operation-fence-state": state })
      }, currentOperationId),
      /recovery_operation_fence_state_invalid/
    );
  }
  assert.throws(
    () => verifyManifestEpochBinding("invalid", inputs(), legacyInventory(), {}),
    /live_mode_invalid/
  );
});

test("historical source modes also preserve the legacy-absent generation", () => {
  const checkpoint = envelope(buildCheckpointEvidenceCore(baseLive(), inputs()));
  const activeLive = baseLive();
  activeLive.parent_namespace.metadata.resourceVersion = "202";
  activeLive.parent_deployment.metadata.resourceVersion = "220";
  activeLive.parent_deployment.spec.replicas = 1;
  const active = buildCheckpointEvidenceCore(
    activeLive,
    inputs(),
    verificationBuildOptions(checkpoint, "active-source")
  );
  assert.equal(verifyHistoricalSourceCore(active, checkpoint, "active-source"), active);
});

test("journal rejects wrong HMAC, wrong namespace UID, finalizer drift, and termination", () => {
  for (const mutate of [
    live => {
      const parsed = JSON.parse(live.journal_config_map.data["journal.json"]);
      parsed.operationId = "87654321-4321-4321-8321-cba987654321";
      live.journal_config_map.data["journal.json"] = canonicalJson(parsed);
    },
    live => { live.parent_namespace.metadata.uid = "recreated-parent-uid"; },
    live => { live.journal_config_map.metadata.finalizers = ["other.invalid/finalizer"]; },
    live => { live.journal_config_map.metadata.deletionTimestamp = "2026-07-20T00:00:00Z"; }
  ]) {
    const live = durableLive();
    mutate(live);
    assert.throws(
      () => buildCheckpointEvidenceCore(live, inputs(live.manifest)),
      /durable_cutover_journal_invalid|parent_namespace_uid_mismatch/
    );
  }
});

test("durable evidence rejects stale policy status and terminating parent resources", () => {
  const stale = durableLive();
  stale.admission.runner_protocol.policy.status.observedGeneration = 3;
  assert.throws(
    () => buildCheckpointEvidenceCore(stale, inputs(stale.manifest)),
    /admission_policy_not_observed_or_exact/
  );

  const terminating = durableLive();
  terminating.parent_resources.role.metadata.deletionTimestamp = "2026-07-20T00:00:00Z";
  assert.throws(
    () => buildCheckpointEvidenceCore(terminating, inputs(terminating.manifest)),
    /durable_parent_resource_not_exact/
  );
});

test("legacy classification rejects every partial AUD078 residue", () => {
  for (const mutate of [
    live => { live.parent_resources.role = { kind: "Role" }; },
    live => { live.admission.runner_protocol.policy = { kind: "ValidatingAdmissionPolicy" }; },
    live => { live.runner_namespace = namespace(RUNNER_NAMESPACE, "runner-uid", "3"); },
    live => { live.journal_config_map = { kind: "ConfigMap" }; }
  ]) {
    const live = baseLive();
    mutate(live);
    assert.throws(() => buildCheckpointEvidenceCore(live, inputs()), /generation_partial/);
  }
});

test("quiescence rejects runner, intent, unknown, malformed, and terminating Pods", () => {
  const cases = [
    exactRunner(),
    exactGuard("intent", "unarmed"),
    {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: "unknown",
        namespace: RUNNER_NAMESPACE,
        uid: "unknown-uid",
        resourceVersion: "1",
        labels: { app: "unknown" }
      }
    },
    (() => {
      const value = exactGuard("fence");
      value.metadata.labels[ROOM_KEY_LABEL] = "bad";
      return value;
    })(),
    (() => {
      const value = exactGuard("fence");
      value.metadata.deletionTimestamp = "2026-07-20T00:00:00Z";
      return value;
    })()
  ];
  for (const pod of cases) {
    const live = durableLive();
    live.runner_pods = podList([pod]);
    assert.throws(() => buildCheckpointEvidenceCore(live, inputs(live.manifest)));
  }
});

test("classify-pods emits exact sorted records and rejects incomplete, duplicate, or terminating lists", () => {
  const first = exactGuard("fence", "unarmed", "fence-b", "52");
  first.metadata.labels[ROOM_KEY_LABEL] = "bbbbbbbbbbbbbbbbbbbb";
  first.metadata.labels[GENERATION_LABEL] = "22222222-2222-4222-8222-222222222222";
  first.metadata.name = runnerPodName(
    first.metadata.labels[ROOM_KEY_LABEL],
    first.metadata.labels[GENERATION_LABEL]
  );
  const second = exactGuard("fence", "unarmed", "fence-a", "51");
  const result = classifyRunnerPodList(podList([first, second]));
  assert.deepEqual(result.fences.map(item => item.name),
    [...result.fences.map(item => item.name)].sort());
  assert.equal(result.list_resource_version, "60");

  const incomplete = podList([]);
  incomplete.metadata.continue = "next";
  assert.throws(() => classifyRunnerPodList(incomplete), /runner_pod_list_incomplete/);

  const duplicate = exactGuard("fence");
  const duplicateTwo = structuredClone(duplicate);
  duplicateTwo.metadata.uid = "replacement-uid";
  assert.throws(() => classifyRunnerPodList(podList([duplicate, duplicateTwo])), /identity_invalid/);

  const terminating = exactGuard("fence");
  terminating.metadata.deletionTimestamp = "2026-07-20T00:00:00Z";
  assert.throws(() => classifyRunnerPodList(podList([terminating])), /identity_invalid/);
});

test("next-action preserves fences and emits one deterministic causal action", () => {
  const unarmed = nextRunnerPodAction(podList([exactGuard("intent", "unarmed")]));
  assert.deepEqual(
    { action: unarmed.action, reason: unarmed.reason, uid: unarmed.pod.uid },
    { action: "delete-pod", reason: "unarmed-intent", uid: "intent-uid" }
  );

  const armed = exactGuard("intent", "armed");
  const runnerBeforeFence = nextRunnerPodAction(podList([armed, exactRunner()]));
  assert.equal(runnerBeforeFence.action, "delete-pod");
  assert.equal(runnerBeforeFence.reason, "runner-before-fence");
  assert.equal(runnerBeforeFence.pod.resource_version, "51");

  const createFence = nextRunnerPodAction(podList([armed]));
  assert.equal(createFence.action, "create-fence");
  assert.equal(createFence.document.metadata.name, runnerPodName(ROOM_KEY, GENERATION));
  assert.equal(Object.hasOwn(createFence.document.metadata, "uid"), false);

  const fence = exactGuard("fence");
  const deleteArmed = nextRunnerPodAction(podList([armed, fence]));
  assert.equal(deleteArmed.reason, "armed-intent-after-fence");
  assert.equal(deleteArmed.pod.name, armed.metadata.name);

  const noop = nextRunnerPodAction(podList([fence]));
  assert.equal(noop.action, "noop");
  assert.equal(noop.inventory.fences[0].uid, fence.metadata.uid);
  assert.equal(JSON.stringify(noop).includes("delete-fence"), false);

  const orphan = nextRunnerPodAction(podList([exactRunner()]));
  assert.equal(orphan.reason, "orphan-runner");
});

test("same-name identity mismatch never authorizes a fence transition", () => {
  const intent = exactGuard("intent", "armed");
  const runner = exactRunner();
  runner.metadata.labels[ROOM_KEY_LABEL] = "bbbbbbbbbbbbbbbbbbbb";
  assert.throws(() => nextRunnerPodAction(podList([intent, runner])));
});

test("evidence parser requires byte-exact canonical JSON and complete nested shapes", () => {
  const directory = privateDirectory();
  try {
    const evidence = envelope(buildCheckpointEvidenceCore(baseLive(), inputs()));
    const pretty = writePrivate(directory, "pretty.json", `${JSON.stringify(evidence, null, 2)}\n`);
    assert.throws(() => canonicalEvidenceFile(pretty), /not_canonical/);

    const malformed = structuredClone(evidence);
    delete malformed.cluster.anchor.uid;
    assert.throws(() => validateEvidenceEnvelope(malformed), /shape_invalid/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("A-to-B capture rejects drift but is independent of later values-path mutation", () => {
  const stable = baseLive();
  const reader = { collect: () => structuredClone(stable) };
  assert.equal(captureStableCore(reader, inputs()).runtime_generation, "legacy-absent");

  let reads = 0;
  const driftingReader = {
    collect() {
      reads += 1;
      const value = structuredClone(stable);
      if (reads === 2) value.parent_deployment.metadata.resourceVersion = "21";
      return value;
    }
  };
  assert.throws(() => captureStableCore(driftingReader, inputs()), /capture_unstable/);

  const directory = privateDirectory();
  const saved = {
    NAMESPACE: process.env.NAMESPACE,
    EXPECTED_KUBE_CONTEXT: process.env.EXPECTED_KUBE_CONTEXT,
    EXPECTED_NAMESPACE_UID: process.env.EXPECTED_NAMESPACE_UID,
    RECOVERY_OPERATION_ID: process.env.RECOVERY_OPERATION_ID
  };
  try {
    process.env.NAMESPACE = NAMESPACE;
    process.env.EXPECTED_KUBE_CONTEXT = CONTEXT;
    process.env.EXPECTED_NAMESPACE_UID = NAMESPACE_UID;
    process.env.RECOVERY_OPERATION_ID = OPERATION_ID;
    const valuesPath = writePrivate(directory, "values.yaml", `Namespace: ${NAMESPACE}\n`);
    const snapshotted = environmentInputs(valuesPath, null, {
      expectedRecoveryOperationFenceState: "dormant"
    });
    fs.writeFileSync(valuesPath, "Namespace: replaced\n", { mode: 0o600 });
    assert.equal(captureStableCore(reader, snapshotted).runtime_generation, "legacy-absent");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("source verify CLI does not read RECOVERY_OPERATION_ID while checkpoint still requires it", () => {
  const directory = privateDirectory();
  try {
    writeLegacyKubectlStub(directory);
    const evidence = envelope(buildCheckpointEvidenceCore(baseLive(), inputs()));
    const evidencePath = writePrivate(directory, "source-evidence.json", canonicalJson(evidence));
    const inventoryPath = writePrivate(
      directory,
      "source-inventory.json",
      JSON.stringify(legacyInventory())
    );
    const valuesPath = writePrivate(directory, "source-values.yaml", `Namespace: ${NAMESPACE}\n`);
    const {
      RECOVERY_OPERATION_ID: _ignoredOperationId,
      ...environmentWithoutOperationId
    } = process.env;
    const commonEnvironment = {
      ...environmentWithoutOperationId,
      PATH: `${directory}:${process.env.PATH}`,
      NAMESPACE,
      EXPECTED_KUBE_CONTEXT: CONTEXT,
      EXPECTED_NAMESPACE_UID: NAMESPACE_UID,
      STUB_CLUSTER_NAMESPACE_JSON: JSON.stringify(
        namespace("kube-system", "cluster-anchor-uid", "101")
      ),
      STUB_PARENT_NAMESPACE_JSON: JSON.stringify(
        namespace(NAMESPACE, NAMESPACE_UID, "102")
      )
    };
    for (const [mode, replicas] of [["active-source", 1], ["quiesced-source", 0]]) {
      const result = runHelper([
        "verify",
        "--live-mode",
        mode,
        "--checkpoint-operation-id",
        OPERATION_ID,
        "--recovery-operation-fence-state",
        "dormant",
        "--values",
        valuesPath,
        "--inventory",
        inventoryPath,
        "--evidence",
        evidencePath
      ], {
        ...commonEnvironment,
        STUB_PARENT_DEPLOYMENT_JSON: JSON.stringify(parentDeployment("120", replicas))
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    }

    const irrelevantManifestPath = writePrivate(
      directory,
      "must-not-be-read.yaml",
      "not: a generated manifest\n"
    );
    const sourceWithManifest = runHelper([
      "verify",
      "--live-mode",
      "active-source",
      "--checkpoint-operation-id",
      OPERATION_ID,
      "--recovery-operation-fence-state",
      "dormant",
      "--manifest",
      irrelevantManifestPath,
      "--values",
      valuesPath,
      "--inventory",
      inventoryPath,
      "--evidence",
      evidencePath
    ], commonEnvironment);
    assert.equal(sourceWithManifest.status, 1);
    assert.match(sourceWithManifest.stderr, /checkpoint_evidence_manifest_mode_invalid/);
    assert.equal(sourceWithManifest.stdout, "");

    const targetWithoutManifest = runHelper([
      "verify",
      "--live-mode",
      "quiesced-target",
      "--checkpoint-operation-id",
      OPERATION_ID,
      "--recovery-operation-fence-state",
      "dormant",
      "--values",
      valuesPath,
      "--inventory",
      inventoryPath,
      "--evidence",
      evidencePath
    ], commonEnvironment);
    assert.equal(targetWithoutManifest.status, 1);
    assert.match(targetWithoutManifest.stderr, /checkpoint_evidence_manifest_mode_invalid/);
    assert.equal(targetWithoutManifest.stdout, "");

    const checkpoint = runHelper([
      "verify",
      "--live-mode",
      "checkpoint",
      "--recovery-operation-fence-state",
      "dormant",
      "--values",
      valuesPath,
      "--inventory",
      inventoryPath,
      "--evidence",
      evidencePath
    ], {
      ...commonEnvironment,
      STUB_PARENT_DEPLOYMENT_JSON: JSON.stringify(parentDeployment("120", 0))
    });
    assert.equal(checkpoint.status, 1);
    assert.match(checkpoint.stderr, /checkpoint_operation_id_missing/);
    assert.equal(checkpoint.stdout, "");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("classify-pods CLI is silent, canonical, private, and never prints Pod data", () => {
  const directory = privateDirectory();
  try {
    const source = writePrivate(directory, "pods.json", JSON.stringify(podList([exactGuard("fence")])));
    const output = path.join(directory, "classified.json");
    const result = runHelper([
      "classify-pods",
      "--pods",
      source,
      "--output",
      output
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    const raw = fs.readFileSync(output, "utf8");
    assert.equal(raw, canonicalJson(JSON.parse(raw)));
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("validate CLI is offline, silent, canonical, and rejects nested or inventory drift", () => {
  const directory = privateDirectory();
  try {
    const evidence = envelope(buildCheckpointEvidenceCore(baseLive(), inputs()));
    const evidencePath = writePrivate(directory, "evidence.json", canonicalJson(evidence));
    const inventoryPath = writePrivate(
      directory,
      "inventory.json",
      JSON.stringify(legacyInventory())
    );
    const valid = runHelper([
      "validate", "--evidence", evidencePath, "--inventory", inventoryPath
    ], {
      ...process.env,
      NAMESPACE: "must-not-be-read",
      EXPECTED_KUBE_CONTEXT: "must-not-be-read",
      PROCESS_LOCAL_CUTOVER_KEY_PATH: "/must/not/be/read"
    });
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(valid.stdout, "");
    assert.equal(valid.stderr, "");

    const durableLiveState = durableLive({ fences: [exactGuard("fence")] });
    const durableEvidence = envelope(buildCheckpointEvidenceCore(
      durableLiveState,
      inputs(durableLiveState.manifest)
    ));
    const durableEvidencePath = writePrivate(
      directory,
      "durable-evidence.json",
      canonicalJson(durableEvidence)
    );
    const durableInventoryPath = writePrivate(
      directory,
      "durable-inventory.json",
      JSON.stringify(deploymentInventory("kubernetes-pod", durableEvidence))
    );
    const durableValid = runHelper([
      "validate",
      "--evidence",
      durableEvidencePath,
      "--inventory",
      durableInventoryPath
    ], {
      ...process.env,
      PROCESS_LOCAL_CUTOVER_KEY_PATH: "/must/not/be/read"
    });
    assert.equal(durableValid.status, 0, durableValid.stderr);
    assert.equal(durableValid.stdout, "");
    assert.equal(durableValid.stderr, "");

    const nested = structuredClone(evidence);
    nested.cluster.anchor.extra = true;
    const nestedPath = writePrivate(directory, "nested.json", canonicalJson(nested));
    assert.equal(runHelper([
      "validate", "--evidence", nestedPath, "--inventory", inventoryPath
    ]).status, 1);

    const prettyPath = writePrivate(directory, "noncanonical.json", JSON.stringify(evidence, null, 2));
    assert.equal(runHelper([
      "validate", "--evidence", prettyPath, "--inventory", inventoryPath
    ]).status, 1);

    const wrongInventory = legacyInventory();
    wrongInventory.bot_runner_runtime.generation = "durable-v2";
    const wrongInventoryPath = writePrivate(
      directory,
      "wrong-inventory.json",
      JSON.stringify(wrongInventory)
    );
    assert.equal(runHelper([
      "validate", "--evidence", evidencePath, "--inventory", wrongInventoryPath
    ]).status, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("validate-evidence CLI enforces unique control-plane identities and Secret HMAC shape", () => {
  const directory = privateDirectory();
  try {
    const live = durableLive({ fences: [exactGuard("fence")] });
    const durable = envelope(buildCheckpointEvidenceCore(live, inputs(live.manifest)));
    const durablePath = writePrivate(directory, "durable-envelope.json", canonicalJson(durable));
    const valid = runHelper(["validate-evidence", "--evidence", durablePath], {
      ...process.env,
      NAMESPACE: "must-not-be-read",
      EXPECTED_KUBE_CONTEXT: "must-not-be-read",
      PROCESS_LOCAL_CUTOVER_KEY_PATH: "/must/not/be/read"
    });
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(valid.stdout, "");
    assert.equal(valid.stderr, "");

    const duplicate = structuredClone(durable);
    duplicate.control_plane.namespaced_resources[1] = structuredClone(
      duplicate.control_plane.namespaced_resources[0]
    );
    const duplicatePath = writePrivate(
      directory,
      "duplicate-control-plane.json",
      canonicalJson(duplicate)
    );
    const duplicateResult = runHelper(["validate-evidence", "--evidence", duplicatePath]);
    assert.equal(duplicateResult.status, 1);
    assert.match(duplicateResult.stderr, /checkpoint_evidence_durable_invalid/);

    const missingSecretHmac = structuredClone(durable);
    const secret = missingSecretHmac.control_plane.namespaced_resources.find(
      value => value.kind === "Secret" && value.name === "bot-images-pull"
    );
    delete secret.contract_hmac_sha256;
    secret.contract_sha256 = "f".repeat(64);
    const missingSecretHmacPath = writePrivate(
      directory,
      "missing-secret-hmac.json",
      canonicalJson(missingSecretHmac)
    );
    const missingHmacResult = runHelper([
      "validate-evidence", "--evidence", missingSecretHmacPath
    ]);
    assert.equal(missingHmacResult.status, 1);
    assert.match(missingHmacResult.stderr, /checkpoint_evidence_durable_invalid/);

    const legacy = envelope(buildCheckpointEvidenceCore(baseLive(), inputs()));
    const legacyPath = writePrivate(directory, "legacy-envelope.json", canonicalJson(legacy));
    assert.equal(runHelper(["validate-evidence", "--evidence", legacyPath]).status, 0);
    legacy.control_plane.unexpected = true;
    const extraLegacyPath = writePrivate(
      directory,
      "legacy-extra-control-plane.json",
      canonicalJson(legacy)
    );
    const extraLegacy = runHelper(["validate-evidence", "--evidence", extraLegacyPath]);
    assert.equal(extraLegacy.status, 1);
    assert.match(extraLegacy.stderr, /checkpoint_evidence_legacy_invalid/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("private input requires exact 0600 file and 0700 directory modes", () => {
  const directory = privateDirectory();
  try {
    const source = writePrivate(directory, "pods.json", JSON.stringify(podList([])));
    fs.chmodSync(source, 0o700);
    assert.equal(runHelper([
      "classify-pods", "--pods", source, "--output", path.join(directory, "bad-file.json")
    ]).status, 1);
    fs.chmodSync(source, 0o600);

    fs.chmodSync(directory, 0o2700);
    assert.equal(runHelper([
      "classify-pods", "--pods", source, "--output", path.join(directory, "bad-dir.json")
    ]).status, 1);
    fs.chmodSync(directory, 0o700);

    const linked = path.join(directory, "pods-hardlink.json");
    fs.linkSync(source, linked);
    assert.equal(runHelper([
      "classify-pods", "--pods", source, "--output", path.join(directory, "hardlink.json")
    ]).status, 1);
  } finally {
    fs.chmodSync(directory, 0o700);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("same-size in-place input mutation is detected with nanosecond inode snapshots", () => {
  const directory = privateDirectory();
  const savedRead = fs.readFileSync;
  const saved = {
    NAMESPACE: process.env.NAMESPACE,
    EXPECTED_KUBE_CONTEXT: process.env.EXPECTED_KUBE_CONTEXT,
    EXPECTED_NAMESPACE_UID: process.env.EXPECTED_NAMESPACE_UID,
    RECOVERY_OPERATION_ID: process.env.RECOVERY_OPERATION_ID
  };
  try {
    process.env.NAMESPACE = NAMESPACE;
    process.env.EXPECTED_KUBE_CONTEXT = CONTEXT;
    process.env.EXPECTED_NAMESPACE_UID = NAMESPACE_UID;
    process.env.RECOVERY_OPERATION_ID = OPERATION_ID;
    const original = "Namespace: hcce\n";
    const replacement = "Namespace: evil\n";
    assert.equal(Buffer.byteLength(original), Buffer.byteLength(replacement));
    const valuesPath = writePrivate(directory, "values.yaml", original);
    let mutated = false;
    fs.readFileSync = function patchedRead(target, ...args) {
      const result = savedRead.call(fs, target, ...args);
      if (!mutated && typeof target === "number") {
        mutated = true;
        fs.writeFileSync(valuesPath, replacement, { mode: 0o600 });
      }
      return result;
    };
    assert.throws(() => environmentInputs(valuesPath, null, {
      expectedRecoveryOperationFenceState: "dormant"
    }), /checkpoint_values_file_invalid/);
  } finally {
    fs.readFileSync = savedRead;
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("private output readback failure cleans only the newly created inode", () => {
  const directory = privateDirectory();
  const originalFsync = fs.fsyncSync;
  try {
    const output = path.join(directory, "partial.json");
    fs.fsyncSync = () => { throw new Error("injected-fsync-failure"); };
    assert.throws(
      () => writePrivateCanonicalJson(output, { schema_version: 1 }),
      /private_output_create_failed/
    );
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.fsyncSync = originalFsync;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("private output never overwrites or unlinks an existing hard-linked inode", () => {
  const directory = privateDirectory();
  try {
    const original = writePrivate(directory, "original", "preserve");
    const output = path.join(directory, "output");
    fs.linkSync(original, output);
    assert.throws(
      () => writePrivateCanonicalJson(output, { schema_version: 1 }),
      /private_output_create_failed/
    );
    assert.equal(fs.readFileSync(original, "utf8"), "preserve");
    assert.equal(fs.readFileSync(output, "utf8"), "preserve");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("source wipes CLI key buffers in finally and has no shell execution", () => {
  const source = fs.readFileSync(SCRIPT, "utf8");
  assert.equal((source.match(/inputs\.cutover_key\.fill\(0\)/g) || []).length, 2);
  assert.match(source, /valuesBytes\.fill\(0\)/);
  assert.match(source, /manifestBytes\.fill\(0\)/);
  assert.equal(source.includes("execSync"), false);
  assert.equal(source.includes("shell: true"), false);
});

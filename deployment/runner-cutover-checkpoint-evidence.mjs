#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";

import { parseLocalValuesSource } from "./parse-local-values.mjs";

const require = createRequire(import.meta.url);
const {
  CUTOVER_JOURNAL_DATA_KEY,
  CUTOVER_JOURNAL_FINALIZER,
  CUTOVER_JOURNAL_NAME,
  canonicalJson,
  liveDeploymentMatchesNormalizedTarget,
  liveObjectIsUnencumbered,
  liveResourceMatchesTarget,
  parseExactCutoverJournalConfigMap,
  sha256Canonical
} = require("../hubs-cloud/community-edition/apply/cutover-journal.js");
const {
  ADMISSION_POLICY_NAME,
  CUTOVER_JOURNAL_POLICY_NAME,
  PARENT_FENCE_POLICY_NAME,
  RECOVERY_OPERATION_FENCE_POLICY_NAME,
  RECOVERY_PHASE_ANNOTATION,
  RUNNER_NAMESPACE,
  RUNNER_PROTOCOL_POLICY_NAME,
  admissionPolicyIsObserved,
  exactAdmissionBinding,
  exactCutoverJournalBinding,
  exactParentFenceBinding,
  exactRecoveryOperationFenceBinding,
  exactRecoveryOperationFencePolicy,
  exactRunnerProtocolBinding,
  readActivationPlanText
} = require("../hubs-cloud/community-edition/apply/runner-activation.js");
const {
  completeRunnerNamespaceInventory,
  sameGuardIdentity
} = require("../hubs-cloud/community-edition/apply/runner-guard-reconciliation.js");
const {
  operationalDriftErrors,
  serverProjection
} = require("../hubs-cloud/community-edition/apply/live-runner-control-plane.js");
const {
  guardPodDocumentForIdentity,
  runnerPodName
} = require("../hubs-cloud/community-edition/services/bot-orchestrator/kubernetes-runner-manager.js");

const EVIDENCE_SCHEMA_VERSION = 3;
const POD_CLASSIFICATION_SCHEMA_VERSION = 1;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_KEY_BYTES = 4096;
const MIN_KEY_BYTES = 32;
const KUBECTL_TIMEOUT_MS = 30_000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const OPERATION_ID = /^[0-9a-f]{32}$/;
const DNS_NAMESPACE = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
const SAFE_CONTEXT = /^[A-Za-z0-9._:@/+\-]{1,256}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const RUNNER_ROLE_NAME = "bot-orchestrator-runner-pods";
const RUNNER_ROLE_BINDING_NAME = "bot-orchestrator-runner-pods";
const RECOVERY_OPERATION_FENCE_STATES = Object.freeze(["dormant", "active"]);
const LIVE_VERIFICATION_MODES = Object.freeze({
  checkpoint: 0,
  "active-source": 1,
  "quiesced-source": 0,
  "quiesced-target": 0,
  "quiesced-active-target": 0,
  "active-target": 1
});

const PAIR_DEFINITIONS = Object.freeze([
  Object.freeze({
    key: "runner_admission",
    name: ADMISSION_POLICY_NAME,
    bindingIsExact: binding => exactAdmissionBinding(binding)
  }),
  Object.freeze({
    key: "runner_protocol",
    name: RUNNER_PROTOCOL_POLICY_NAME,
    bindingIsExact: binding => exactRunnerProtocolBinding(binding)
  }),
  Object.freeze({
    key: "cutover_journal",
    name: CUTOVER_JOURNAL_POLICY_NAME,
    bindingIsExact: (binding, namespace) => exactCutoverJournalBinding(binding, namespace)
  }),
  Object.freeze({
    key: "parent_fence",
    name: PARENT_FENCE_POLICY_NAME,
    bindingIsExact: (binding, namespace) => exactParentFenceBinding(binding, namespace)
  }),
  Object.freeze({
    key: "recovery_operation_fence",
    name: RECOVERY_OPERATION_FENCE_POLICY_NAME,
    policyIsExact: (policy, namespace) => exactRecoveryOperationFencePolicy(policy, namespace),
    bindingIsExact: (binding, namespace, expectedState) =>
      exactRecoveryOperationFenceBinding(binding, namespace, {
        active: expectedState === "active"
      })
  })
]);
const CONTROL_PLANE_CLUSTER_DEFINITIONS = Object.freeze(PAIR_DEFINITIONS.flatMap(
  definition => [
    Object.freeze({
      key: `${definition.key}_policy`,
      apiVersion: "admissionregistration.k8s.io/v1",
      kind: "ValidatingAdmissionPolicy",
      name: definition.name,
      pairKey: definition.key,
      pairMember: "policy"
    }),
    Object.freeze({
      key: `${definition.key}_binding`,
      apiVersion: "admissionregistration.k8s.io/v1",
      kind: "ValidatingAdmissionPolicyBinding",
      name: definition.name,
      pairKey: definition.key,
      pairMember: "binding"
    })
  ]
));
const PARENT_RESOURCE_DEFINITIONS = Object.freeze([
  Object.freeze({
    key: "service_account",
    apiVersion: "v1",
    kind: "ServiceAccount",
    name: "bot-orchestrator"
  }),
  Object.freeze({
    key: "role",
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "Role",
    name: "bot-orchestrator-runner-pods"
  }),
  Object.freeze({
    key: "role_binding",
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "RoleBinding",
    name: "bot-orchestrator-runner-pods"
  })
]);
const CONTROL_PLANE_NAMESPACE_DEFINITIONS = Object.freeze([
  Object.freeze({
    key: "parent_namespace",
    apiVersion: "v1",
    kind: "Namespace",
    name: null,
    manifest: false
  }),
  Object.freeze({
    key: "runner_namespace",
    apiVersion: "v1",
    kind: "Namespace",
    name: RUNNER_NAMESPACE,
    manifest: true
  })
]);
const CONTROL_PLANE_NAMESPACED_DEFINITIONS = Object.freeze([
  Object.freeze({
    key: "parent_service_account",
    apiVersion: "v1",
    kind: "ServiceAccount",
    namespace: null,
    name: "bot-orchestrator",
    liveKey: "service_account",
    manifest: true
  }),
  Object.freeze({
    key: "parent_role",
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "Role",
    namespace: null,
    name: "bot-orchestrator-runner-pods",
    liveKey: "role",
    manifest: true
  }),
  Object.freeze({
    key: "parent_role_binding",
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "RoleBinding",
    namespace: null,
    name: "bot-orchestrator-runner-pods",
    liveKey: "role_binding",
    manifest: true
  }),
  Object.freeze({
    key: "cutover_journal",
    apiVersion: "v1",
    kind: "ConfigMap",
    namespace: null,
    name: CUTOVER_JOURNAL_NAME,
    liveKey: "journal_config_map",
    manifest: false
  }),
  Object.freeze({
    key: "runner_pull_secret",
    apiVersion: "v1",
    kind: "Secret",
    namespace: RUNNER_NAMESPACE,
    name: "bot-images-pull",
    liveKey: "runner_pull_secret",
    manifest: true,
    secret: true
  }),
  Object.freeze({
    key: "runner_service_account",
    apiVersion: "v1",
    kind: "ServiceAccount",
    namespace: RUNNER_NAMESPACE,
    name: "bot-runner",
    liveKey: "runner_service_account",
    manifest: true
  }),
  Object.freeze({
    key: "guard_service_account",
    apiVersion: "v1",
    kind: "ServiceAccount",
    namespace: RUNNER_NAMESPACE,
    name: "bot-runner-guard",
    liveKey: "guard_service_account",
    manifest: true
  }),
  Object.freeze({
    key: "runner_quota",
    apiVersion: "v1",
    kind: "ResourceQuota",
    namespace: RUNNER_NAMESPACE,
    name: "bot-runner-capacity",
    liveKey: "runner_quota",
    manifest: true
  }),
  Object.freeze({
    key: "guard_quota",
    apiVersion: "v1",
    kind: "ResourceQuota",
    namespace: RUNNER_NAMESPACE,
    name: "bot-runner-guard-capacity",
    liveKey: "guard_quota",
    manifest: true
  }),
  Object.freeze({
    key: "runner_role",
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "Role",
    namespace: RUNNER_NAMESPACE,
    name: RUNNER_ROLE_NAME,
    liveKey: "runner_role",
    manifest: true
  }),
  Object.freeze({
    key: "runner_role_binding",
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "RoleBinding",
    namespace: RUNNER_NAMESPACE,
    name: RUNNER_ROLE_BINDING_NAME,
    liveKey: "runner_role_binding",
    manifest: true
  }),
  Object.freeze({
    key: "runner_default_deny",
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    namespace: RUNNER_NAMESPACE,
    name: "bot-runner-default-deny",
    liveKey: "runner_default_deny",
    manifest: true
  }),
  Object.freeze({
    key: "runner_egress",
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    namespace: RUNNER_NAMESPACE,
    name: "bot-runner-egress",
    liveKey: "runner_egress",
    manifest: true
  })
]);
const EXPECTED_DEPLOYMENTS = Object.freeze([
  "bot-orchestrator",
  "coturn",
  "dialog",
  "haproxy",
  "hubs",
  "nearspark",
  "pgbouncer",
  "pgbouncer-t",
  "photomnemonic",
  "pgsql",
  "reticulum",
  "spoke"
]);
const EXPECTED_CONTAINER_PAIRS = Object.freeze([
  "bot-orchestrator/bot-orchestrator",
  "coturn/coturn",
  "dialog/dialog",
  "haproxy/haproxy",
  "hubs/hubs",
  "nearspark/nearspark",
  "pgbouncer/pgbouncer",
  "pgbouncer-t/pgbouncer-t",
  "photomnemonic/photomnemonic",
  "reticulum/postgrest",
  "reticulum/reticulum",
  "spoke/spoke"
]);
const TRUSTED_IMAGE_REPOSITORIES = Object.freeze({
  "bot-orchestrator/bot-orchestrator": Object.freeze([
    "ghcr.io/yengalvez/bot-orchestrator"
  ]),
  "coturn/coturn": Object.freeze(["ghcr.io/yengalvez/coturn"]),
  "dialog/dialog": Object.freeze(["ghcr.io/yengalvez/dialog"]),
  "haproxy/haproxy": Object.freeze([
    "ghcr.io/yengalvez/haproxy",
    "docker.io/haproxytech/kubernetes-ingress",
    "haproxytech/kubernetes-ingress"
  ]),
  "hubs/hubs": Object.freeze(["ghcr.io/yengalvez/hubs"]),
  "nearspark/nearspark": Object.freeze([
    "ghcr.io/yengalvez/nearspark",
    "docker.io/mozillareality/nearspark",
    "mozillareality/nearspark"
  ]),
  "pgbouncer/pgbouncer": Object.freeze([
    "ghcr.io/yengalvez/pgbouncer",
    "docker.io/edoburu/pgbouncer",
    "edoburu/pgbouncer"
  ]),
  "pgbouncer-t/pgbouncer-t": Object.freeze([
    "ghcr.io/yengalvez/pgbouncer",
    "docker.io/edoburu/pgbouncer",
    "edoburu/pgbouncer"
  ]),
  "photomnemonic/photomnemonic": Object.freeze([
    "ghcr.io/yengalvez/photomnemonic"
  ]),
  "pgsql/pgsql": Object.freeze([
    "ghcr.io/yengalvez/postgres",
    "docker.io/library/postgres",
    "postgres"
  ]),
  "pgsql/postgresql": Object.freeze([
    "ghcr.io/yengalvez/postgres",
    "docker.io/library/postgres",
    "postgres"
  ]),
  "reticulum/postgrest": Object.freeze([
    "ghcr.io/yengalvez/postgrest",
    "docker.io/postgrest/postgrest",
    "postgrest/postgrest"
  ]),
  "reticulum/reticulum": Object.freeze(["ghcr.io/yengalvez/reticulum"]),
  "spoke/spoke": Object.freeze(["ghcr.io/yengalvez/spoke"])
});

function fail(code) {
  throw new Error(code);
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
}

function sha256Bytes(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function requiredString(value, code) {
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(code);
  }
  return value;
}

function recoveryOperationFenceState(value) {
  if (!RECOVERY_OPERATION_FENCE_STATES.includes(value)) {
    fail("recovery_operation_fence_state_invalid");
  }
  return value;
}

function manifestRecoveryOperationFenceState(recoveryPhase) {
  if (recoveryPhase === "active") return "dormant";
  if (recoveryPhase === "restore-fence") return "active";
  fail("checkpoint_manifest_recovery_phase_invalid");
}

function recoveryOperationFenceBindingContract(namespace, expectedState) {
  const state = recoveryOperationFenceState(expectedState);
  const namespaceSelector = state === "active"
    ? {
        matchExpressions: [{
          key: "kubernetes.io/metadata.name",
          operator: "In",
          values: [namespace, RUNNER_NAMESPACE]
        }]
      }
    : {
        matchExpressions: [{
          key: "kubernetes.io/metadata.name",
          operator: "DoesNotExist"
        }]
      };
  const binding = {
    apiVersion: "admissionregistration.k8s.io/v1",
    kind: "ValidatingAdmissionPolicyBinding",
    metadata: { name: RECOVERY_OPERATION_FENCE_POLICY_NAME },
    spec: {
      policyName: RECOVERY_OPERATION_FENCE_POLICY_NAME,
      validationActions: ["Deny"],
      matchResources: {
        matchPolicy: "Equivalent",
        namespaceSelector,
        objectSelector: {}
      }
    }
  };
  if (!exactRecoveryOperationFenceBinding(binding, namespace, { active: state === "active" })) {
    fail("recovery_operation_fence_contract_invalid");
  }
  return binding;
}

function recoveryOperationFenceBindingSpecSha256(namespace, expectedState) {
  return sha256Canonical(
    recoveryOperationFenceBindingContract(namespace, expectedState).spec
  );
}

function recoveryOperationFenceLiveBindingTarget(
  manifestBinding,
  namespace,
  expectedLiveState
) {
  const target = structuredClone(manifestBinding);
  target.spec = structuredClone(
    recoveryOperationFenceBindingContract(namespace, expectedLiveState).spec
  );
  return target;
}

function canonicalUtcTimestamp(value) {
  if (!ISO_UTC.test(value || "")) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const normalizedInput = value.includes(".")
    ? value
    : `${value.slice(0, -1)}.000Z`;
  return new Date(milliseconds).toISOString() === normalizedInput ? milliseconds : null;
}

function sameFileSnapshot(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.uid === right.uid && left.mode === right.mode && left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function sameDirectoryIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid &&
    left.mode === right.mode && left.isDirectory() && right.isDirectory();
}

function privateRegularFileBytes(filePath, maximumBytes, code) {
  if (typeof filePath !== "string" || filePath.length === 0) fail(code);
  const resolved = path.resolve(filePath);
  let stat;
  let parent;
  let real;
  try {
    stat = fs.lstatSync(resolved, { bigint: true });
    parent = fs.lstatSync(path.dirname(resolved), { bigint: true });
    real = fs.realpathSync(resolved);
  } catch (_error) {
    fail(code);
  }
  const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : stat.uid;
  if (
    real !== resolved || !parent.isDirectory() || parent.isSymbolicLink() ||
    parent.uid !== currentUid || (parent.mode & 0o7777n) !== 0o700n ||
    !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.uid !== currentUid ||
    (stat.mode & 0o7777n) !== 0o600n || stat.size < 1n || stat.size > BigInt(maximumBytes)
  ) {
    fail(code);
  }
  let descriptor;
  let bytes;
  try {
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!sameFileSnapshot(stat, opened) || opened.nlink !== 1n || !opened.isFile()) fail(code);
    bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameFileSnapshot(opened, after)) fail(code);
    const parentAfter = fs.lstatSync(path.dirname(resolved), { bigint: true });
    if (!sameDirectoryIdentity(parent, parentAfter) ||
        fs.realpathSync(path.dirname(resolved)) !== path.dirname(resolved)) {
      fail(code);
    }
  } catch (_error) {
    fail(code);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  if (BigInt(bytes.length) !== stat.size) fail(code);
  return bytes;
}

function privateJsonFile(filePath, code) {
  const bytes = privateRegularFileBytes(filePath, MAX_JSON_BYTES, code);
  const source = bytes.toString("utf8");
  try {
    return { source, value: JSON.parse(source) };
  } catch (_error) {
    fail(code);
  } finally {
    bytes.fill(0);
  }
}

function canonicalEvidenceFile(filePath) {
  const { source, value } = privateJsonFile(filePath, "checkpoint_evidence_file_invalid");
  if (source !== canonicalJson(value)) {
    fail("checkpoint_evidence_not_canonical");
  }
  validateEvidenceEnvelope(value);
  return value;
}

function writePrivateCanonicalJson(filePath, value) {
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  const resolved = path.resolve(filePath);
  const parentPath = path.dirname(resolved);
  let parent;
  try {
    parent = fs.lstatSync(parentPath, { bigint: true });
    const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : parent.uid;
    if (
      fs.realpathSync(parentPath) !== parentPath || !parent.isDirectory() ||
      parent.isSymbolicLink() || parent.uid !== currentUid ||
      (parent.mode & 0o7777n) !== 0o700n
    ) {
      fail("private_output_parent_invalid");
    }
  } catch (_error) {
    fail("private_output_parent_invalid");
  }
  let descriptor;
  let directoryDescriptor;
  let createdIdentity = null;
  let failureCode = null;
  try {
    descriptor = fs.openSync(
      resolved,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW || 0),
      0o600
    );
    createdIdentity = fs.fstatSync(descriptor, { bigint: true });
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    const readback = Buffer.alloc(bytes.length);
    const readBytes = fs.readSync(descriptor, readback, 0, readback.length, 0);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(resolved, { bigint: true });
    const parentAfter = fs.lstatSync(parentPath, { bigint: true });
    if (
      readBytes !== bytes.length || !crypto.timingSafeEqual(readback, bytes) ||
      !sameFileSnapshot(opened, named) || opened.nlink !== 1n ||
      opened.uid !== parent.uid || (opened.mode & 0o7777n) !== 0o600n ||
      opened.size !== BigInt(bytes.length) ||
      !sameDirectoryIdentity(parent, parentAfter) || fs.realpathSync(parentPath) !== parentPath
    ) {
      fail("private_output_identity_changed");
    }
    directoryDescriptor = fs.openSync(
      parentPath,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0)
    );
    fs.fsyncSync(directoryDescriptor);
  } catch (_error) {
    failureCode = "private_output_create_failed";
  } finally {
    if (directoryDescriptor !== undefined) fs.closeSync(directoryDescriptor);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  if (failureCode !== null) {
    if (createdIdentity !== null) {
      try {
        const named = fs.lstatSync(resolved, { bigint: true });
        const parentAfter = fs.lstatSync(parentPath, { bigint: true });
        if (
          named.dev === createdIdentity.dev && named.ino === createdIdentity.ino &&
          named.uid === createdIdentity.uid && named.nlink === 1n &&
          sameDirectoryIdentity(parent, parentAfter) && fs.realpathSync(parentPath) === parentPath
        ) {
          fs.unlinkSync(resolved);
          const cleanupDirectory = fs.openSync(
            parentPath,
            fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0)
          );
          try {
            fs.fsyncSync(cleanupDirectory);
          } finally {
            fs.closeSync(cleanupDirectory);
          }
        }
      } catch (_error) {
        // Refuse to unlink anything whose original inode cannot be proved.
      }
    }
    fail(failureCode);
  }
}

function liveIdentity(resource, { includeResourceVersion = true } = {}) {
  const metadata = resource?.metadata;
  if (
    typeof metadata?.uid !== "string" || metadata.uid.length === 0 ||
    (includeResourceVersion &&
      (typeof metadata.resourceVersion !== "string" || metadata.resourceVersion.length === 0)) ||
    metadata.deletionTimestamp !== undefined ||
    metadata.deletionGracePeriodSeconds !== undefined
  ) {
    fail("live_resource_identity_invalid");
  }
  return {
    api_version: resource.apiVersion,
    kind: resource.kind,
    name: metadata.name,
    uid: metadata.uid,
    ...(includeResourceVersion ? { resource_version: metadata.resourceVersion } : {}),
    terminating: false
  };
}

function namespaceEvidence(resource, expectedName, { anchor = false } = {}) {
  if (
    resource?.apiVersion !== "v1" || resource?.kind !== "Namespace" ||
    resource?.metadata?.name !== expectedName || resource?.status?.phase !== "Active"
  ) {
    fail("namespace_contract_invalid");
  }
  const identity = liveIdentity(resource, { includeResourceVersion: !anchor });
  if (anchor) {
    const { terminating: _terminating, ...stable } = identity;
    return stable;
  }
  return identity;
}

function parentDeploymentEvidence(deployment, namespace, expectedReplicas = 0) {
  if (
    ![0, 1].includes(expectedReplicas) ||
    deployment?.apiVersion !== "apps/v1" || deployment?.kind !== "Deployment" ||
    deployment?.metadata?.name !== "bot-orchestrator" ||
    deployment?.metadata?.namespace !== namespace ||
    deployment?.spec?.replicas !== expectedReplicas || !liveObjectIsUnencumbered(deployment)
  ) {
    fail("parent_deployment_contract_invalid");
  }
  const checkpointSpec = structuredClone(deployment.spec);
  checkpointSpec.replicas = 0;
  return {
    api_version: "apps/v1",
    kind: "Deployment",
    name: "bot-orchestrator",
    namespace,
    uid: deployment.metadata.uid,
    resource_version: deployment.metadata.resourceVersion,
    replicas: expectedReplicas,
    spec_sha256: sha256Canonical(checkpointSpec),
    terminating: false
  };
}

function findExactManifestResource(resources, apiVersion, kind, name, namespace = "") {
  const matches = resources.filter(resource =>
    resource?.apiVersion === apiVersion && resource?.kind === kind &&
    resource?.metadata?.name === name && (resource?.metadata?.namespace || "") === namespace
  );
  if (matches.length !== 1) fail("generated_manifest_resource_missing_or_ambiguous");
  return matches[0];
}

function manifestContractFromSnapshot(
  manifestBytes,
  values,
  expectedNamespace,
  {
    expectedRecoveryPhase = "active"
  } = {}
) {
  const recoveryFenceState = manifestRecoveryOperationFenceState(expectedRecoveryPhase);
  let plan;
  try {
    plan = readActivationPlanText(manifestBytes.toString("utf8"));
  } catch (_error) {
    fail("checkpoint_manifest_contract_invalid");
  }
  if (
    values.get("Namespace") !== expectedNamespace ||
    values.get("BOT_RUNNER_ACTIVATION_PHASE") !== "active" ||
    values.get("BOT_RUNNER_RECOVERY_PHASE") !== expectedRecoveryPhase ||
    !UUID_V4.test(values.get("BOT_RUNNER_RECOVERY_EPOCH") || "") ||
    plan.activationPhase !== "active" || plan.recoveryPhase !== expectedRecoveryPhase ||
    plan.recoveryEpoch !== values.get("BOT_RUNNER_RECOVERY_EPOCH")
  ) {
    fail("checkpoint_manifest_values_binding_invalid");
  }

  const expectedPairs = Object.fromEntries(PAIR_DEFINITIONS.map(definition => [
    definition.key,
    {
      policy: findExactManifestResource(
        plan.resources,
        "admissionregistration.k8s.io/v1",
        "ValidatingAdmissionPolicy",
        definition.name
      ),
      binding: findExactManifestResource(
        plan.resources,
        "admissionregistration.k8s.io/v1",
        "ValidatingAdmissionPolicyBinding",
        definition.name
      )
    }
  ]));
  const recoveryFencePair = expectedPairs.recovery_operation_fence;
  if (
    !exactRecoveryOperationFencePolicy(recoveryFencePair.policy, expectedNamespace) ||
    !exactRecoveryOperationFenceBinding(
      recoveryFencePair.binding,
      expectedNamespace,
      { active: recoveryFenceState === "active" }
    )
  ) {
    fail("checkpoint_manifest_recovery_operation_fence_state_invalid");
  }
  const expectedControlPlane = {
    namespaces: Object.fromEntries(
      CONTROL_PLANE_NAMESPACE_DEFINITIONS.filter(definition => definition.manifest).map(
        definition => [
          definition.key,
          findExactManifestResource(
            plan.resources,
            definition.apiVersion,
            definition.kind,
            definition.name
          )
        ]
      )
    ),
    namespaced_resources: Object.fromEntries(
      CONTROL_PLANE_NAMESPACED_DEFINITIONS.filter(definition => definition.manifest).map(
        definition => {
          const namespace = definition.namespace || expectedNamespace;
          return [
            definition.key,
            findExactManifestResource(
              plan.resources,
              definition.apiVersion,
              definition.kind,
              definition.name,
              namespace
            )
          ];
        }
      )
    ),
    cluster_resources: Object.fromEntries(PAIR_DEFINITIONS.flatMap(definition => [
      [`${definition.key}_policy`, expectedPairs[definition.key].policy],
      [`${definition.key}_binding`, expectedPairs[definition.key].binding]
    ]))
  };
  const deployment = findExactManifestResource(
    plan.resources,
    "apps/v1",
    "Deployment",
    "bot-orchestrator",
    expectedNamespace
  );
  const runnerRole = findExactManifestResource(
    plan.resources,
    "rbac.authorization.k8s.io/v1",
    "Role",
    RUNNER_ROLE_NAME,
    RUNNER_NAMESPACE
  );
  const runnerRoleBinding = findExactManifestResource(
    plan.resources,
    "rbac.authorization.k8s.io/v1",
    "RoleBinding",
    RUNNER_ROLE_BINDING_NAME,
    RUNNER_NAMESPACE
  );
  const parentTarget = structuredClone(deployment);
  parentTarget.metadata.annotations = {
    ...(parentTarget.metadata.annotations || {}),
    [RECOVERY_PHASE_ANNOTATION]: expectedRecoveryPhase
  };
  parentTarget.spec = { ...parentTarget.spec, replicas: 0 };
  return {
    manifest_sha256: sha256Bytes(manifestBytes),
    recovery_phase: expectedRecoveryPhase,
    recovery_operation_fence_state: recoveryFenceState,
    recovery_epoch: plan.recoveryEpoch,
    expected_pairs: expectedPairs,
    expected_control_plane: expectedControlPlane,
    expected_parent_resources: Object.fromEntries(PARENT_RESOURCE_DEFINITIONS.map(definition => [
      definition.key,
      findExactManifestResource(
        plan.resources,
        definition.apiVersion,
        definition.kind,
        definition.name,
        expectedNamespace
      )
    ])),
    expected_runner_role: runnerRole,
    expected_runner_role_binding: runnerRoleBinding,
    parent_target: parentTarget,
    target_hashes: {
      journalPolicy: sha256Canonical(expectedPairs.cutover_journal.policy),
      journalBinding: sha256Canonical(expectedPairs.cutover_journal.binding),
      parentPolicy: sha256Canonical(expectedPairs.parent_fence.policy),
      parentBinding: sha256Canonical(expectedPairs.parent_fence.binding),
      parentDeployment: sha256Canonical(parentTarget)
    }
  };
}

function manifestContract(manifestPath, valuesPath, expectedNamespace, options = {}) {
  const valuesBytes = privateRegularFileBytes(
    valuesPath,
    MAX_JSON_BYTES,
    "checkpoint_values_file_invalid"
  );
  let values;
  let manifestBytes;
  try {
    values = parseLocalValuesSource(valuesBytes.toString("utf8"));
    manifestBytes = privateRegularFileBytes(
      manifestPath,
      MAX_MANIFEST_BYTES,
      "checkpoint_manifest_file_invalid"
    );
    return manifestContractFromSnapshot(manifestBytes, values, expectedNamespace, options);
  } catch (_error) {
    if (_error instanceof Error && /^[a-z0-9_]+$/.test(_error.message)) throw _error;
    fail("checkpoint_values_contract_invalid");
  } finally {
    valuesBytes.fill(0);
    if (Buffer.isBuffer(manifestBytes)) manifestBytes.fill(0);
    if (values instanceof Map) values.clear();
  }
}

function admissionAbsentEvidence(namespace) {
  return {
    state: "absent",
    absence_verified: true,
    pairs: Object.fromEntries(PAIR_DEFINITIONS.map(({ key, name }) => [
      key,
      { policy_name: name, binding_name: name }
    ])),
    parent_resources: {
      state: "absent",
      absence_verified: true,
      resources: Object.fromEntries(PARENT_RESOURCE_DEFINITIONS.map(definition => [
        definition.key,
        {
          api_version: definition.apiVersion,
          kind: definition.kind,
          name: definition.name,
          namespace
        }
      ]))
    }
  };
}

function policyEvidence(policy) {
  if (!admissionPolicyIsObserved(policy) || !liveObjectIsUnencumbered(policy)) {
    fail("admission_policy_not_observed_or_exact");
  }
  return {
    name: policy.metadata.name,
    uid: policy.metadata.uid,
    resource_version: policy.metadata.resourceVersion,
    generation: policy.metadata.generation,
    observed_generation: policy.status.observedGeneration,
    spec_sha256: sha256Canonical(policy.spec),
    terminating: false
  };
}

function bindingEvidence(binding) {
  if (!liveObjectIsUnencumbered(binding)) fail("admission_binding_not_exact");
  return {
    name: binding.metadata.name,
    uid: binding.metadata.uid,
    resource_version: binding.metadata.resourceVersion,
    spec_sha256: sha256Canonical(binding.spec),
    terminating: false
  };
}

function withoutKubectlBookkeeping(resource) {
  if (!resource || typeof resource !== "object") return resource;
  const projected = structuredClone(resource);
  const annotations = projected?.metadata?.annotations;
  if (annotations && typeof annotations === "object" && !Array.isArray(annotations)) {
    delete annotations["kubectl.kubernetes.io/last-applied-configuration"];
    if (Object.keys(annotations).length === 0) delete projected.metadata.annotations;
  }
  return projected;
}

function parentResourceMatchesExpected(live, expected) {
  const projected = withoutKubectlBookkeeping(live);
  const expectedTopLevel = new Set(Object.keys(expected || {}));
  const unexpectedTopLevel = Object.keys(projected || {}).filter(key => !expectedTopLevel.has(key));
  const allowedEmptyServiceAccountField = key =>
    projected?.kind === "ServiceAccount" && ["secrets", "imagePullSecrets"].includes(key) &&
    Array.isArray(projected[key]) && projected[key].length === 0;
  if (
    projected?.apiVersion !== expected?.apiVersion || projected?.kind !== expected?.kind ||
    projected?.metadata?.name !== expected?.metadata?.name ||
    projected?.metadata?.namespace !== expected?.metadata?.namespace ||
    !liveObjectIsUnencumbered(projected) ||
    !isDeepStrictEqual(projected?.metadata?.labels || {}, expected?.metadata?.labels || {}) ||
    !isDeepStrictEqual(projected?.metadata?.annotations || {}, expected?.metadata?.annotations || {}) ||
    unexpectedTopLevel.some(key => !allowedEmptyServiceAccountField(key))
  ) {
    return false;
  }
  return Object.keys(expected).every(key =>
    ["apiVersion", "kind", "metadata"].includes(key) ||
      isDeepStrictEqual(projected[key], expected[key])
  );
}

function normalizedControlPlaneContract(resource) {
  const normalized = structuredClone(resource);
  delete normalized.status;
  for (const field of [
    "creationTimestamp",
    "generation",
    "managedFields",
    "resourceVersion",
    "selfLink",
    "uid"
  ]) {
    delete normalized.metadata[field];
  }
  delete normalized.metadata.deletionGracePeriodSeconds;
  delete normalized.metadata.deletionTimestamp;
  if (normalized.metadata.annotations) {
    delete normalized.metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"];
    if (Object.keys(normalized.metadata.annotations).length === 0) {
      delete normalized.metadata.annotations;
    }
  }
  if (normalized.kind === "Namespace" && normalized.metadata.labels) {
    delete normalized.metadata.labels["kubernetes.io/metadata.name"];
    if (Object.keys(normalized.metadata.labels).length === 0) {
      delete normalized.metadata.labels;
    }
  }
  if (normalized.kind === "Namespace" &&
      isDeepStrictEqual(normalized.spec, { finalizers: ["kubernetes"] })) {
    delete normalized.spec;
  }
  if (normalized.kind === "ServiceAccount") {
    for (const field of ["imagePullSecrets", "secrets"]) {
      if (Array.isArray(normalized[field]) && normalized[field].length === 0) {
        delete normalized[field];
      }
    }
  }
  if (normalized.kind === "Secret") {
    if (normalized.binaryData && Object.keys(normalized.binaryData).length === 0) {
      delete normalized.binaryData;
    }
    if (normalized.immutable === false) delete normalized.immutable;
  }
  return normalized;
}

function hmacCanonical(key, value) {
  if (!Buffer.isBuffer(key) || key.length < MIN_KEY_BYTES || key.length > MAX_KEY_BYTES) {
    fail("durable_control_plane_owner_key_invalid");
  }
  return crypto.createHmac("sha256", key)
    .update("yenhubs-control-plane-secret-contract-v1\u0000", "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function exactGeneratedControlPlaneResource(live, expected) {
  const expectedTopLevel = new Set(Object.keys(expected || {}));
  const unexpectedTopLevel = Object.keys(live || {}).filter(key =>
    !expectedTopLevel.has(key) && key !== "status"
  );
  const allowedServerDefault = key =>
    (live?.kind === "Namespace" && key === "spec" &&
      isDeepStrictEqual(live.spec, { finalizers: ["kubernetes"] })) ||
    (live?.kind === "ServiceAccount" && ["imagePullSecrets", "secrets"].includes(key) &&
      Array.isArray(live[key]) && live[key].length === 0) ||
    (live?.kind === "Secret" && key === "immutable" && live.immutable === false) ||
    (live?.kind === "Secret" && key === "binaryData" &&
      live.binaryData && Object.keys(live.binaryData).length === 0);
  return unexpectedTopLevel.every(allowedServerDefault) &&
    operationalDriftErrors(live, expected).length === 0 &&
    isDeepStrictEqual(serverProjection(live, expected), expected);
}

function controlPlaneResourceIsUnencumbered(resource, definition) {
  if (definition.key !== "cutover_journal") return liveObjectIsUnencumbered(resource);
  if (!isDeepStrictEqual(resource?.metadata?.finalizers, [CUTOVER_JOURNAL_FINALIZER])) {
    return false;
  }
  const projected = structuredClone(resource);
  delete projected.metadata.finalizers;
  return liveObjectIsUnencumbered(projected);
}

function controlPlaneContractEntry(resource, definition, cutoverKey) {
  if (
    resource?.apiVersion !== definition.apiVersion || resource?.kind !== definition.kind ||
    resource?.metadata?.name !== definition.name ||
    (Object.hasOwn(definition, "namespace") &&
      resource?.metadata?.namespace !== definition.namespace) ||
    typeof resource?.metadata?.uid !== "string" || resource.metadata.uid.length === 0 ||
    typeof resource?.metadata?.resourceVersion !== "string" ||
    resource.metadata.resourceVersion.length === 0 ||
    !controlPlaneResourceIsUnencumbered(resource, definition)
  ) {
    fail("durable_control_plane_resource_identity_invalid");
  }
  const normalized = normalizedControlPlaneContract(resource);
  const identity = {
    api_version: resource.apiVersion,
    kind: resource.kind,
    name: resource.metadata.name,
    ...(Object.hasOwn(definition, "namespace")
      ? { namespace: resource.metadata.namespace }
      : {}),
    uid: resource.metadata.uid,
    resource_version: resource.metadata.resourceVersion,
    ...(definition.secret
      ? { contract_hmac_sha256: hmacCanonical(cutoverKey, normalized) }
      : { contract_sha256: sha256Canonical(normalized) }),
    terminating: false
  };
  return identity;
}

function sortedControlPlaneEntries(entries) {
  return entries.sort((left, right) => {
    const leftKey = [left.kind, left.namespace || "", left.name].join("\u0000");
    const rightKey = [right.kind, right.namespace || "", right.name].join("\u0000");
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function controlPlaneLiveResource(live, definition) {
  if (definition.key === "parent_namespace") return live.parent_namespace;
  if (definition.key === "runner_namespace") return live.runner_namespace;
  if (definition.pairKey) {
    return live.admission[definition.pairKey][definition.pairMember];
  }
  if (["service_account", "role", "role_binding"].includes(definition.liveKey)) {
    return live.parent_resources[definition.liveKey];
  }
  return live[definition.liveKey];
}

function expectedControlPlaneResource(manifest, definition, verificationMode) {
  if (!definition.manifest && !definition.pairKey) return null;
  if (definition.key === "runner_role") {
    return expectedRunnerRoleForMode(manifest, verificationMode);
  }
  if (definition.pairKey) {
    return manifest.expected_control_plane.cluster_resources[definition.key];
  }
  const group = Object.hasOwn(definition, "namespace")
    ? "namespaced_resources"
    : "namespaces";
  return manifest.expected_control_plane[group][definition.key];
}

function buildControlPlaneContractEvidence(live, inputs, verificationMode) {
  const exactTarget = verificationMode === "checkpoint" || verificationMode.endsWith("-target");
  const manifest = inputs.manifest_contract;
  const materialize = definition => {
    const resolved = {
      ...definition,
      ...(definition.name === null ? { name: inputs.namespace } : {}),
      ...(Object.hasOwn(definition, "namespace") && definition.namespace === null
        ? { namespace: inputs.namespace }
        : {})
    };
    const resource = controlPlaneLiveResource(live, resolved);
    let expected = exactTarget
      ? expectedControlPlaneResource(manifest, resolved, verificationMode)
      : null;
    if (expected !== null && resolved.pairKey === "recovery_operation_fence" &&
        resolved.pairMember === "binding") {
      expected = recoveryOperationFenceLiveBindingTarget(
        expected,
        inputs.namespace,
        inputs.expected_recovery_operation_fence_state
      );
    }
    if (expected !== null && !exactGeneratedControlPlaneResource(resource, expected)) {
      fail("durable_control_plane_manifest_drift");
    }
    const entry = controlPlaneContractEntry(resource, resolved, inputs.cutover_key);
    if (resolved.pairKey === "recovery_operation_fence" &&
        resolved.pairMember === "binding") {
      if (!exactRecoveryOperationFenceBinding(resource, inputs.namespace, {
        active: inputs.expected_recovery_operation_fence_state === "active"
      })) {
        fail("durable_control_plane_manifest_drift");
      }
      entry.contract_sha256 = sha256Canonical(recoveryOperationFenceBindingContract(
        inputs.namespace,
        inputs.expected_recovery_operation_fence_state
      ));
    }
    return entry;
  };
  return {
    state: "present",
    namespaces: sortedControlPlaneEntries(CONTROL_PLANE_NAMESPACE_DEFINITIONS.map(materialize)),
    namespaced_resources: sortedControlPlaneEntries(
      CONTROL_PLANE_NAMESPACED_DEFINITIONS.map(materialize)
    ),
    cluster_resources: sortedControlPlaneEntries(
      CONTROL_PLANE_CLUSTER_DEFINITIONS.map(materialize)
    )
  };
}

function controlPlaneEntryIdentity(value) {
  return [value?.api_version, value?.kind, value?.namespace || "", value?.name].join("\u0000");
}

function controlPlaneContractsMatchHistorical(
  current,
  checkpoint,
  mode,
  currentRecoveryOperationFenceState,
  checkpointRecoveryOperationFenceState
) {
  if (isDeepStrictEqual(current, { state: "legacy-absent" }) &&
      isDeepStrictEqual(checkpoint, { state: "legacy-absent" })) {
    return true;
  }
  if (current?.state !== "present" || checkpoint?.state !== "present") return false;
  const currentRecoveryFenceState = recoveryOperationFenceState(
    currentRecoveryOperationFenceState
  );
  const checkpointRecoveryFenceState = recoveryOperationFenceState(
    checkpointRecoveryOperationFenceState
  );
  const targetMode = mode.endsWith("-target");
  const matchesGroup = (currentGroup, checkpointGroup) => {
    if (!Array.isArray(currentGroup) || !Array.isArray(checkpointGroup) ||
        currentGroup.length !== checkpointGroup.length) {
      return false;
    }
    const historical = new Map(
      checkpointGroup.map(value => [controlPlaneEntryIdentity(value), value])
    );
    if (historical.size !== checkpointGroup.length) return false;
    return currentGroup.every(value => {
      const baseline = historical.get(controlPlaneEntryIdentity(value));
      if (!baseline || value.uid !== baseline.uid || value.terminating !== false ||
          baseline.terminating !== false) {
        return false;
      }
      const runnerRole = value.kind === "Role" && value.namespace === RUNNER_NAMESPACE &&
        value.name === RUNNER_ROLE_NAME;
      const targetManifestResource = targetMode &&
        !(value.kind === "Namespace" && value.name !== RUNNER_NAMESPACE) &&
        !(value.kind === "ConfigMap" && value.name === CUTOVER_JOURNAL_NAME);
      if (targetManifestResource || (mode === "quiesced-source" && runnerRole)) return true;
      const recoveryOperationFenceBinding =
        value.kind === "ValidatingAdmissionPolicyBinding" &&
        value.name === RECOVERY_OPERATION_FENCE_POLICY_NAME;
      if (recoveryOperationFenceBinding &&
          currentRecoveryFenceState !== checkpointRecoveryFenceState) {
        return true;
      }
      const fingerprintKey = value.kind === "Secret"
        ? "contract_hmac_sha256"
        : "contract_sha256";
      return value[fingerprintKey] === baseline[fingerprintKey];
    });
  };
  return matchesGroup(current.namespaces, checkpoint.namespaces) &&
    matchesGroup(current.namespaced_resources, checkpoint.namespaced_resources) &&
    matchesGroup(current.cluster_resources, checkpoint.cluster_resources);
}

function inertRunnerRoleContract(role) {
  const inert = structuredClone(role);
  inert.metadata = {
    ...inert.metadata,
    annotations: {
      ...(inert.metadata?.annotations || {}),
      [RECOVERY_PHASE_ANNOTATION]: "restore-fence"
    }
  };
  inert.rules = [];
  return inert;
}

function expectedRunnerRoleForMode(manifest, verificationMode) {
  return verificationMode === "quiesced-active-target"
    ? inertRunnerRoleContract(manifest.expected_runner_role)
    : structuredClone(manifest.expected_runner_role);
}

function runnerRoleEvidence(live, expected) {
  if (!parentResourceMatchesExpected(live, expected)) {
    fail("durable_runner_role_target_invalid");
  }
  return {
    api_version: live.apiVersion,
    kind: live.kind,
    name: live.metadata.name,
    namespace: live.metadata.namespace,
    uid: live.metadata.uid,
    resource_version: live.metadata.resourceVersion,
    contract_sha256: sha256Canonical(expected),
    inert_contract_sha256: sha256Canonical(inertRunnerRoleContract(expected)),
    terminating: false
  };
}

function sourceRunnerRoleContract(live) {
  if (live?.metadata?.namespace !== RUNNER_NAMESPACE) {
    fail("durable_source_runner_role_invalid");
  }
  return sourceParentResourceContract(live, {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "Role",
    name: RUNNER_ROLE_NAME,
    key: "role"
  });
}

function sourceRunnerRoleEvidence(live, historical, verificationMode) {
  const contractSha256 = sha256Canonical(sourceRunnerRoleContract(live));
  const expectedContractSha256 = verificationMode === "quiesced-source"
    ? historical?.inert_contract_sha256
    : historical?.contract_sha256;
  const current = {
    api_version: live?.apiVersion,
    kind: live?.kind,
    name: live?.metadata?.name,
    namespace: live?.metadata?.namespace,
    uid: live?.metadata?.uid,
    resource_version: live?.metadata?.resourceVersion,
    contract_sha256: contractSha256,
    inert_contract_sha256: historical?.inert_contract_sha256,
    terminating: false
  };
  if (current.uid !== historical?.uid ||
      current.contract_sha256 !== expectedContractSha256) {
    fail("durable_source_runner_role_drift");
  }
  return current;
}

function runnerRoleBindingEvidence(live, expected) {
  if (!parentResourceMatchesExpected(live, expected)) {
    fail("durable_runner_role_binding_target_invalid");
  }
  return {
    api_version: live.apiVersion,
    kind: live.kind,
    name: live.metadata.name,
    namespace: live.metadata.namespace,
    uid: live.metadata.uid,
    resource_version: live.metadata.resourceVersion,
    contract_sha256: sha256Canonical(expected),
    terminating: false
  };
}

function sourceRunnerRoleBindingContract(live) {
  if (live?.metadata?.namespace !== RUNNER_NAMESPACE) {
    fail("durable_source_runner_role_binding_invalid");
  }
  return sourceParentResourceContract(live, {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "RoleBinding",
    name: RUNNER_ROLE_BINDING_NAME,
    key: "role_binding"
  });
}

function sourceRunnerRoleBindingEvidence(live, historical) {
  const current = {
    api_version: live?.apiVersion,
    kind: live?.kind,
    name: live?.metadata?.name,
    namespace: live?.metadata?.namespace,
    uid: live?.metadata?.uid,
    resource_version: live?.metadata?.resourceVersion,
    contract_sha256: sha256Canonical(sourceRunnerRoleBindingContract(live)),
    terminating: false
  };
  if (current.uid !== historical?.uid ||
      current.contract_sha256 !== historical?.contract_sha256) {
    fail("durable_source_runner_role_binding_drift");
  }
  return current;
}

function durableParentResourcesEvidence(liveResources, expectedResources) {
  const resources = {};
  for (const definition of PARENT_RESOURCE_DEFINITIONS) {
    const live = liveResources[definition.key];
    const expected = expectedResources[definition.key];
    if (!parentResourceMatchesExpected(live, expected)) {
      fail("durable_parent_resource_not_exact");
    }
    resources[definition.key] = {
      api_version: live.apiVersion,
      kind: live.kind,
      name: live.metadata.name,
      namespace: live.metadata.namespace,
      uid: live.metadata.uid,
      resource_version: live.metadata.resourceVersion,
      contract_sha256: sha256Canonical(expected),
      terminating: false
    };
  }
  return { state: "present", resources };
}

function admissionDurableEvidence(
  livePairs,
  expectedPairs,
  liveParentResources,
  expectedParentResources,
  namespace,
  expectedRecoveryOperationFenceState
) {
  const recoveryFenceState = recoveryOperationFenceState(
    expectedRecoveryOperationFenceState
  );
  const pairs = {};
  for (const definition of PAIR_DEFINITIONS) {
    const live = livePairs[definition.key];
    const expected = expectedPairs[definition.key];
    const expectedLiveBinding = definition.key === "recovery_operation_fence"
      ? recoveryOperationFenceLiveBindingTarget(
          expected?.binding,
          namespace,
          recoveryFenceState
        )
      : expected?.binding;
    if (
      !liveResourceMatchesTarget(withoutKubectlBookkeeping(live?.policy), expected?.policy) ||
      !liveResourceMatchesTarget(withoutKubectlBookkeeping(live?.binding), expectedLiveBinding) ||
      (definition.policyIsExact && !definition.policyIsExact(live?.policy, namespace)) ||
      !definition.bindingIsExact(live?.binding, namespace, recoveryFenceState)
    ) {
      fail("admission_pair_not_exact");
    }
    pairs[definition.key] = {
      policy: policyEvidence(live.policy),
      binding: bindingEvidence(live.binding),
      observed: true
    };
  }
  return {
    state: "present",
    pairs,
    parent_resources: durableParentResourcesEvidence(
      liveParentResources,
      expectedParentResources
    )
  };
}

function sourceParentResourceContract(live, definition) {
  const projected = withoutKubectlBookkeeping(live);
  if (
    projected?.apiVersion !== definition.apiVersion || projected?.kind !== definition.kind ||
    projected?.metadata?.name !== definition.name || !liveObjectIsUnencumbered(projected)
  ) {
    fail("durable_source_parent_resource_invalid");
  }
  const metadata = {
    name: projected.metadata.name,
    namespace: projected.metadata.namespace
  };
  if (Object.keys(projected.metadata.labels || {}).length > 0) {
    metadata.labels = projected.metadata.labels;
  }
  if (Object.keys(projected.metadata.annotations || {}).length > 0) {
    metadata.annotations = projected.metadata.annotations;
  }
  const contract = {
    apiVersion: projected.apiVersion,
    kind: projected.kind,
    metadata
  };
  if (definition.key === "service_account") {
    if (Object.hasOwn(projected, "automountServiceAccountToken")) {
      contract.automountServiceAccountToken = projected.automountServiceAccountToken;
    }
    if (Array.isArray(projected.imagePullSecrets) && projected.imagePullSecrets.length > 0) {
      contract.imagePullSecrets = projected.imagePullSecrets;
    }
  } else if (definition.key === "role") {
    contract.rules = projected.rules;
  } else if (definition.key === "role_binding") {
    contract.roleRef = projected.roleRef;
    contract.subjects = projected.subjects;
  }
  return contract;
}

function admissionSourceEvidence(
  livePairs,
  liveParentResources,
  checkpointAdmission,
  namespace,
  expectedRecoveryOperationFenceState,
  checkpointRecoveryOperationFenceState
) {
  const recoveryFenceState = recoveryOperationFenceState(
    expectedRecoveryOperationFenceState
  );
  const checkpointRecoveryFenceState = recoveryOperationFenceState(
    checkpointRecoveryOperationFenceState
  );
  const pairs = {};
  for (const definition of PAIR_DEFINITIONS) {
    const live = livePairs[definition.key];
    if ((definition.policyIsExact && !definition.policyIsExact(live?.policy, namespace)) ||
        !definition.bindingIsExact(live?.binding, namespace, recoveryFenceState)) {
      fail("durable_source_admission_binding_invalid");
    }
    const current = {
      policy: policyEvidence(live.policy),
      binding: bindingEvidence(live.binding),
      observed: true
    };
    const historical = checkpointAdmission.pairs[definition.key];
    const recoveryBindingMayTransition =
      definition.key === "recovery_operation_fence" &&
      recoveryFenceState !== checkpointRecoveryFenceState;
    if (current.policy.uid !== historical.policy.uid ||
        current.policy.generation !== historical.policy.generation ||
        current.policy.spec_sha256 !== historical.policy.spec_sha256 ||
        current.binding.uid !== historical.binding.uid ||
        (!recoveryBindingMayTransition &&
          current.binding.spec_sha256 !== historical.binding.spec_sha256)) {
      fail("durable_source_admission_drift");
    }
    pairs[definition.key] = current;
  }
  const resources = {};
  for (const definition of PARENT_RESOURCE_DEFINITIONS) {
    const live = liveParentResources[definition.key];
    const contract = sourceParentResourceContract(live, definition);
    const current = {
      api_version: live.apiVersion,
      kind: live.kind,
      name: live.metadata.name,
      namespace: live.metadata.namespace,
      uid: live.metadata.uid,
      resource_version: live.metadata.resourceVersion,
      contract_sha256: sha256Canonical(contract),
      terminating: false
    };
    const historical = checkpointAdmission.parent_resources.resources[definition.key];
    if (current.uid !== historical.uid ||
        current.contract_sha256 !== historical.contract_sha256) {
      fail("durable_source_parent_resource_drift");
    }
    resources[definition.key] = current;
  }
  return {
    state: "present",
    pairs,
    parent_resources: { state: "present", resources }
  };
}

function journalExpectationsFromEvidence(evidence) {
  const hashes = evidence.journal.contract.target_hashes;
  return {
    manifest_sha256: evidence.journal.contract.manifest_sha256,
    target_hashes: {
      journalPolicy: hashes.journal_policy,
      journalBinding: hashes.journal_binding,
      parentPolicy: hashes.parent_policy,
      parentBinding: hashes.parent_binding,
      parentDeployment: hashes.parent_deployment
    }
  };
}

function podMetadataIsStable(pod) {
  return typeof pod?.metadata?.resourceVersion === "string" &&
    pod.metadata.resourceVersion.length > 0 &&
    pod.metadata.deletionTimestamp === undefined &&
    pod.metadata.deletionGracePeriodSeconds === undefined;
}

function runnerRecord(record, pod) {
  return {
    name: record.name,
    uid: record.uid,
    resource_version: pod.metadata.resourceVersion,
    room_key: record.roomKey,
    process_generation: record.processGeneration
  };
}

function intentRecord(record) {
  return {
    name: record.intentName,
    target_name: record.name,
    uid: record.uid,
    resource_version: record.resourceVersion,
    room_key: record.roomKey,
    process_generation: record.processGeneration,
    state: record.state
  };
}

function fenceRecord(record) {
  return {
    name: record.name,
    uid: record.uid,
    resource_version: record.resourceVersion,
    room_key: record.roomKey,
    process_generation: record.processGeneration,
    state: "fenced"
  };
}

export function classifyRunnerPodList(podList) {
  if (podList?.kind !== "PodList" || !Array.isArray(podList.items)) {
    fail("runner_pod_list_invalid");
  }
  const names = new Set();
  for (const pod of podList.items) {
    if (!podMetadataIsStable(pod) || names.has(pod?.metadata?.name)) {
      fail("runner_namespace_pod_identity_invalid");
    }
    names.add(pod.metadata.name);
  }
  const inventory = completeRunnerNamespaceInventory(podList);
  const runners = [...inventory.runners.values()]
    .map(({ record, pod }) => runnerRecord(record, pod))
    .sort((left, right) => left.name.localeCompare(right.name));
  const intents = [...inventory.intents.values()]
    .map(({ record }) => intentRecord(record))
    .sort((left, right) => left.name.localeCompare(right.name));
  const fences = [...inventory.fences.values()]
    .map(({ record }) => fenceRecord(record))
    .sort((left, right) => left.name.localeCompare(right.name));
  return {
    schema_version: POD_CLASSIFICATION_SCHEMA_VERSION,
    list_resource_version: inventory.resourceVersion,
    runners,
    intents,
    fences
  };
}

function podDeleteAction(reason, record) {
  return {
    schema_version: POD_CLASSIFICATION_SCHEMA_VERSION,
    action: "delete-pod",
    reason,
    pod: {
      name: record.name,
      uid: record.uid,
      resource_version: record.resource_version
    }
  };
}

export function nextRunnerPodAction(podList) {
  const classified = classifyRunnerPodList(podList);
  const inventory = completeRunnerNamespaceInventory(podList);
  const intents = [...inventory.intents.values()]
    .sort((left, right) => left.record.intentName.localeCompare(right.record.intentName));
  for (const { record } of intents) {
    const serializedIntent = intentRecord(record);
    if (record.state === "unarmed") {
      return podDeleteAction("unarmed-intent", serializedIntent);
    }
    if (record.state !== "armed") fail("runner_intent_state_invalid");
    const fence = inventory.fences.get(record.name);
    if (fence) {
      if (!sameGuardIdentity(fence.record, record)) fail("runner_fence_identity_mismatch");
      return podDeleteAction("armed-intent-after-fence", serializedIntent);
    }
    const runner = inventory.runners.get(record.name);
    if (runner) {
      if (!sameGuardIdentity(runner.record, record)) fail("runner_fence_target_identity_mismatch");
      return podDeleteAction("runner-before-fence", runnerRecord(runner.record, runner.pod));
    }
    return {
      schema_version: POD_CLASSIFICATION_SCHEMA_VERSION,
      action: "create-fence",
      identity: {
        name: record.name,
        room_key: record.roomKey,
        process_generation: record.processGeneration
      },
      document: guardPodDocumentForIdentity(record, "fence", RUNNER_NAMESPACE)
    };
  }
  const runners = [...inventory.runners.values()]
    .sort((left, right) => left.record.name.localeCompare(right.record.name));
  if (runners.length > 0) {
    const runner = runners[0];
    if (inventory.fences.has(runner.record.name)) fail("runner_namespace_identity_ambiguous");
    return podDeleteAction("orphan-runner", runnerRecord(runner.record, runner.pod));
  }
  return {
    schema_version: POD_CLASSIFICATION_SCHEMA_VERSION,
    action: "noop",
    inventory: classified
  };
}

function quiescenceEvidence(podList) {
  const classified = classifyRunnerPodList(podList);
  if (classified.runners.length !== 0 || classified.intents.length !== 0) {
    fail("runner_namespace_not_quiescent");
  }
  return { runners: 0, intents: 0, fences: classified.fences };
}

function activeRunnerInventoryEvidence(podList) {
  const classified = classifyRunnerPodList(podList);
  const inventory = completeRunnerNamespaceInventory(podList);
  for (const { record } of inventory.intents.values()) {
    const runner = inventory.runners.get(record.name)?.record;
    const fence = inventory.fences.get(record.name)?.record;
    if ((runner && !sameGuardIdentity(runner, record)) ||
        (fence && !sameGuardIdentity(fence, record)) ||
        (record.state === "unarmed" && (runner || fence))) {
      fail("runner_active_inventory_identity_conflict");
    }
  }
  return {
    runners: classified.runners.length,
    intents: classified.intents.length,
    fences: classified.fences
  };
}

function journalContractEvidence(journal) {
  return {
    schema_version: journal.schemaVersion,
    mode: journal.mode,
    operation: journal.operation,
    operation_id: journal.operationId,
    expected_kube_context: journal.expectedKubeContext,
    namespace: {
      name: journal.namespace.name,
      uid: journal.namespace.uid
    },
    baseline_deployment: journal.baselineDeployment === null
      ? null
      : {
          name: journal.baselineDeployment.name,
          uid: journal.baselineDeployment.uid,
          resource_version: journal.baselineDeployment.resourceVersion
        },
    manifest_sha256: journal.manifestSha256,
    target_hashes: {
      journal_policy: journal.targetHashes.journalPolicy,
      journal_binding: journal.targetHashes.journalBinding,
      parent_policy: journal.targetHashes.parentPolicy,
      parent_binding: journal.targetHashes.parentBinding,
      parent_deployment: journal.targetHashes.parentDeployment
    },
    issued_at: journal.issuedAt
  };
}

function durableJournalEvidence(configMap, journal) {
  const canonical = configMap.data[CUTOVER_JOURNAL_DATA_KEY];
  return {
    state: "present",
    config_map: {
      name: CUTOVER_JOURNAL_NAME,
      namespace: journal.namespace.name,
      uid: configMap.metadata.uid,
      resource_version: configMap.metadata.resourceVersion,
      immutable: true,
      finalizers: [CUTOVER_JOURNAL_FINALIZER],
      terminating: false
    },
    canonical_json: canonical,
    canonical_sha256: sha256Bytes(Buffer.from(canonical, "utf8")),
    hmac_verification: "verified-owner-key",
    contract: journalContractEvidence(journal)
  };
}

function legacyJournalEvidence(namespace) {
  return {
    state: "absent",
    config_map: { name: CUTOVER_JOURNAL_NAME, namespace },
    absence_verified: true
  };
}

function resourcesAreAllAbsent(live) {
  return live.journal_config_map === null && live.runner_namespace === null &&
    live.runner_role === null && live.runner_role_binding === null &&
    live.runner_pull_secret === null && live.runner_service_account === null &&
    live.guard_service_account === null && live.runner_quota === null &&
    live.guard_quota === null && live.runner_default_deny === null &&
    live.runner_egress === null &&
    PAIR_DEFINITIONS.every(({ key }) =>
      live.admission[key].policy === null && live.admission[key].binding === null
    ) && PARENT_RESOURCE_DEFINITIONS.every(({ key }) => live.parent_resources[key] === null);
}

function resourcesAreAllPresent(live) {
  return live.journal_config_map !== null && live.runner_namespace !== null &&
    live.runner_role !== null && live.runner_role_binding !== null && live.runner_pods !== null &&
    live.runner_pull_secret !== null && live.runner_service_account !== null &&
    live.guard_service_account !== null && live.runner_quota !== null &&
    live.guard_quota !== null && live.runner_default_deny !== null &&
    live.runner_egress !== null &&
    PAIR_DEFINITIONS.every(({ key }) =>
      live.admission[key].policy !== null && live.admission[key].binding !== null
    ) && PARENT_RESOURCE_DEFINITIONS.every(({ key }) => live.parent_resources[key] !== null);
}

function runtimeGeneration(live) {
  if (resourcesAreAllAbsent(live)) return "legacy-absent";
  if (resourcesAreAllPresent(live)) return "durable-v2";
  fail("runner_cutover_generation_partial");
}

function buildCommonCore(
  live,
  inputs,
  generation,
  expectedParentReplicas,
  expectedRecoveryOperationFenceState
) {
  const parentNamespace = namespaceEvidence(live.parent_namespace, inputs.namespace);
  if (parentNamespace.uid !== inputs.expected_namespace_uid) {
    fail("parent_namespace_uid_mismatch");
  }
  return {
    runtime_generation: generation,
    recovery_operation_fence_state: expectedRecoveryOperationFenceState,
    cluster: {
      kube_context: inputs.expected_kube_context,
      anchor: namespaceEvidence(live.cluster_anchor, "kube-system", { anchor: true })
    },
    namespaces: {
      parent: parentNamespace,
      runner: generation === "durable-v2"
        ? namespaceEvidence(live.runner_namespace, RUNNER_NAMESPACE)
        : null
    },
    parent_deployment: parentDeploymentEvidence(
      live.parent_deployment,
      inputs.namespace,
      expectedParentReplicas
    )
  };
}

export function buildCheckpointEvidenceCore(
  live,
  inputs,
  {
    expectedParentReplicas = 0,
    verificationMode = "checkpoint",
    checkpointEvidence = null
  } = {}
) {
  const expectedRecoveryOperationFenceState = recoveryOperationFenceState(
    inputs?.expected_recovery_operation_fence_state
  );
  if (![0, 1].includes(expectedParentReplicas) ||
      !Object.hasOwn(LIVE_VERIFICATION_MODES, verificationMode) ||
      LIVE_VERIFICATION_MODES[verificationMode] !== expectedParentReplicas) {
    fail("parent_deployment_replica_contract_invalid");
  }
  const historicalMode = verificationMode !== "checkpoint";
  const targetMode = verificationMode.endsWith("-target");
  if (historicalMode) {
    validateEvidenceEnvelope(checkpointEvidence);
  }
  const generation = runtimeGeneration(live);
  if (generation === "legacy-absent" && expectedRecoveryOperationFenceState !== "dormant") {
    fail("recovery_operation_fence_state_unverifiable");
  }
  if (targetMode && checkpointEvidence.runtime_generation !== "durable-v2") {
    fail("runner_target_generation_invalid");
  }
  if (historicalMode && generation !== checkpointEvidence.runtime_generation) {
    fail("checkpoint_evidence_historical_live_mismatch");
  }
  const common = buildCommonCore(
    live,
    inputs,
    generation,
    expectedParentReplicas,
    expectedRecoveryOperationFenceState
  );
  if (generation === "legacy-absent") {
    if (targetMode) fail("runner_target_generation_invalid");
    return {
      ...common,
      control_plane: { state: "legacy-absent" },
      runner_role: null,
      runner_role_binding: null,
      journal: legacyJournalEvidence(inputs.namespace),
      admission: admissionAbsentEvidence(inputs.namespace),
      quiescence: { runners: 0, intents: 0, fences: [] }
    };
  }
  if ((!historicalMode || targetMode) && !inputs.manifest_contract) {
    fail("durable_checkpoint_manifest_missing");
  }
  const expectedManifestRecoveryPhase = verificationMode === "quiesced-target"
    ? "restore-fence"
    : "active";
  const expectedManifestRecoveryOperationFenceState =
    manifestRecoveryOperationFenceState(expectedManifestRecoveryPhase);
  if ((!historicalMode || targetMode) &&
      inputs.manifest_contract.recovery_phase !== expectedManifestRecoveryPhase) {
    fail("durable_checkpoint_manifest_phase_invalid");
  }
  if ((!historicalMode || targetMode) &&
      inputs.manifest_contract.recovery_operation_fence_state !==
        expectedManifestRecoveryOperationFenceState) {
    fail("durable_checkpoint_recovery_operation_fence_state_invalid");
  }
  if (targetMode && expectedRecoveryOperationFenceState !==
      expectedManifestRecoveryOperationFenceState) {
    fail("durable_target_recovery_operation_fence_state_invalid");
  }
  if (!Buffer.isBuffer(inputs.cutover_key)) {
    fail("durable_checkpoint_inputs_missing");
  }
  const manifest = inputs.manifest_contract;
  const journalExpected = historicalMode
    ? journalExpectationsFromEvidence(checkpointEvidence)
    : null;
  let journal;
  try {
    journal = parseExactCutoverJournalConfigMap(live.journal_config_map, {
      key: inputs.cutover_key,
      expectedKubeContext: inputs.expected_kube_context,
      namespace: inputs.namespace,
      namespaceUid: common.namespaces.parent.uid,
      ...(journalExpected === null ? {} : {
        manifestSha256: journalExpected.manifest_sha256,
        targetHashes: journalExpected.target_hashes
      })
    });
  } catch (_error) {
    fail("durable_cutover_journal_invalid");
  }
  if (
    journal.mode !== "clean-install" &&
    journal.baselineDeployment.uid !== live.parent_deployment.metadata.uid
  ) {
    fail("durable_parent_deployment_uid_mismatch");
  }
  let runnerRole;
  let runnerRoleBinding;
  if (verificationMode === "checkpoint" || targetMode) {
    if (!liveDeploymentMatchesNormalizedTarget(
      withoutKubectlBookkeeping(live.parent_deployment),
      live.normalized_parent_target
    )) {
      fail("durable_parent_deployment_target_invalid");
    }
    runnerRole = runnerRoleEvidence(
      live.runner_role,
      expectedRunnerRoleForMode(manifest, verificationMode)
    );
    runnerRoleBinding = runnerRoleBindingEvidence(
      live.runner_role_binding,
      manifest.expected_runner_role_binding
    );
    if (targetMode && runnerRole.uid !== checkpointEvidence.runner_role.uid) {
      fail("durable_target_runner_role_uid_mismatch");
    }
    if (targetMode &&
        runnerRoleBinding.uid !== checkpointEvidence.runner_role_binding.uid) {
      fail("durable_target_runner_role_binding_uid_mismatch");
    }
  } else {
    runnerRole = sourceRunnerRoleEvidence(
      live.runner_role,
      checkpointEvidence.runner_role,
      verificationMode
    );
    runnerRoleBinding = sourceRunnerRoleBindingEvidence(
      live.runner_role_binding,
      checkpointEvidence.runner_role_binding
    );
    if (common.parent_deployment.uid !== checkpointEvidence.parent_deployment.uid ||
        common.parent_deployment.spec_sha256 !== checkpointEvidence.parent_deployment.spec_sha256) {
      fail("durable_source_parent_deployment_drift");
    }
  }
  const admission = verificationMode === "checkpoint" || targetMode
    ? admissionDurableEvidence(
        live.admission,
        manifest.expected_pairs,
        live.parent_resources,
        manifest.expected_parent_resources,
        inputs.namespace,
        expectedRecoveryOperationFenceState
      )
    : admissionSourceEvidence(
        live.admission,
        live.parent_resources,
        checkpointEvidence.admission,
        inputs.namespace,
        expectedRecoveryOperationFenceState,
        checkpointEvidence.recovery_operation_fence_state
      );
  const controlPlane = buildControlPlaneContractEvidence(live, inputs, verificationMode);
  if (historicalMode && !controlPlaneContractsMatchHistorical(
    controlPlane,
    checkpointEvidence.control_plane,
    verificationMode,
    expectedRecoveryOperationFenceState,
    checkpointEvidence.recovery_operation_fence_state
  )) {
    fail("durable_control_plane_historical_drift");
  }
  return {
    ...common,
    control_plane: controlPlane,
    runner_role: runnerRole,
    runner_role_binding: runnerRoleBinding,
    journal: durableJournalEvidence(live.journal_config_map, journal),
    admission,
    quiescence: verificationMode === "active-source" || verificationMode === "active-target"
      ? activeRunnerInventoryEvidence(live.runner_pods)
      : quiescenceEvidence(live.runner_pods)
  };
}

function evidenceEnvelope(core, operationId, captureWindow) {
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    checkpoint_operation_id: operationId,
    runtime_generation: core.runtime_generation,
    recovery_operation_fence_state: core.recovery_operation_fence_state,
    capture_window: captureWindow,
    cluster: core.cluster,
    namespaces: core.namespaces,
    control_plane: core.control_plane,
    runner_role: core.runner_role,
    runner_role_binding: core.runner_role_binding,
    journal: core.journal,
    admission: core.admission,
    parent_deployment: core.parent_deployment,
    quiescence: core.quiescence
  };
}

function coreFromEnvelope(evidence) {
  return {
    runtime_generation: evidence.runtime_generation,
    recovery_operation_fence_state: evidence.recovery_operation_fence_state,
    cluster: evidence.cluster,
    namespaces: evidence.namespaces,
    control_plane: evidence.control_plane,
    runner_role: evidence.runner_role,
    runner_role_binding: evidence.runner_role_binding,
    journal: evidence.journal,
    admission: evidence.admission,
    parent_deployment: evidence.parent_deployment,
    quiescence: evidence.quiescence
  };
}

function namespaceHistoricalContract(value) {
  return {
    api_version: value?.api_version,
    kind: value?.kind,
    name: value?.name,
    uid: value?.uid,
    terminating: value?.terminating
  };
}

function runnerRoleMatchesHistorical(current, checkpoint, mode) {
  if (checkpoint === null) return current === null;
  const targetMode = mode.endsWith("-target");
  const expectedContractSha256 = mode === "quiesced-source"
    ? checkpoint?.inert_contract_sha256
    : checkpoint?.contract_sha256;
  return current?.api_version === checkpoint?.api_version &&
    current?.kind === checkpoint?.kind && current?.name === checkpoint?.name &&
    current?.namespace === checkpoint?.namespace && current?.uid === checkpoint?.uid &&
    typeof current?.resource_version === "string" && current.resource_version.length > 0 &&
    current?.terminating === false && checkpoint?.terminating === false &&
    (targetMode || (current?.contract_sha256 === expectedContractSha256 &&
      current?.inert_contract_sha256 === checkpoint?.inert_contract_sha256));
}

function runnerRoleBindingMatchesHistorical(current, checkpoint, identityOnly = false) {
  if (checkpoint === null) return current === null;
  return current?.api_version === checkpoint?.api_version &&
    current?.kind === checkpoint?.kind && current?.name === checkpoint?.name &&
    current?.namespace === checkpoint?.namespace && current?.uid === checkpoint?.uid &&
    typeof current?.resource_version === "string" && current.resource_version.length > 0 &&
    current?.terminating === false && checkpoint?.terminating === false &&
    (identityOnly || current?.contract_sha256 === checkpoint?.contract_sha256);
}

function journalHistoricalContract(value) {
  if (value?.state === "absent") return value;
  return {
    state: value?.state,
    config_map: {
      name: value?.config_map?.name,
      namespace: value?.config_map?.namespace,
      uid: value?.config_map?.uid,
      immutable: value?.config_map?.immutable,
      finalizers: value?.config_map?.finalizers,
      terminating: value?.config_map?.terminating
    },
    canonical_json: value?.canonical_json,
    canonical_sha256: value?.canonical_sha256,
    hmac_verification: value?.hmac_verification,
    contract: value?.contract
  };
}

function policyHistoricalContract(value) {
  return {
    name: value?.name,
    uid: value?.uid,
    generation: value?.generation,
    observed_generation: value?.observed_generation,
    spec_sha256: value?.spec_sha256,
    terminating: value?.terminating
  };
}

function bindingHistoricalContract(value) {
  return {
    name: value?.name,
    uid: value?.uid,
    spec_sha256: value?.spec_sha256,
    terminating: value?.terminating
  };
}

function parentResourceHistoricalContract(value) {
  return {
    api_version: value?.api_version,
    kind: value?.kind,
    name: value?.name,
    namespace: value?.namespace,
    uid: value?.uid,
    contract_sha256: value?.contract_sha256,
    terminating: value?.terminating
  };
}

function admissionMatchesHistorical(
  current,
  checkpoint,
  identityOnly = false,
  currentRecoveryOperationFenceState,
  checkpointRecoveryOperationFenceState
) {
  if (current?.state !== checkpoint?.state) return false;
  if (checkpoint.state === "absent") return isDeepStrictEqual(current, checkpoint);
  const currentRecoveryFenceState = recoveryOperationFenceState(
    currentRecoveryOperationFenceState
  );
  const checkpointRecoveryFenceState = recoveryOperationFenceState(
    checkpointRecoveryOperationFenceState
  );
  if (!exactKeys(current.pairs, PAIR_DEFINITIONS.map(({ key }) => key)) ||
      !exactKeys(checkpoint.pairs, PAIR_DEFINITIONS.map(({ key }) => key))) {
    return false;
  }
  for (const { key } of PAIR_DEFINITIONS) {
    const livePair = current.pairs[key];
    const checkpointPair = checkpoint.pairs[key];
    const livePolicy = policyHistoricalContract(livePair?.policy);
    const historicalPolicy = policyHistoricalContract(checkpointPair?.policy);
    const liveBinding = bindingHistoricalContract(livePair?.binding);
    const historicalBinding = bindingHistoricalContract(checkpointPair?.binding);
    const recoveryBindingMayTransition = key === "recovery_operation_fence" &&
      currentRecoveryFenceState !== checkpointRecoveryFenceState;
    if (livePair?.observed !== true || checkpointPair?.observed !== true ||
        livePolicy.name !== historicalPolicy.name || livePolicy.uid !== historicalPolicy.uid ||
        livePolicy.terminating !== false || historicalPolicy.terminating !== false ||
        liveBinding.name !== historicalBinding.name || liveBinding.uid !== historicalBinding.uid ||
        liveBinding.terminating !== false || historicalBinding.terminating !== false ||
        (!identityOnly && (
          livePolicy.generation !== historicalPolicy.generation ||
          livePolicy.observed_generation !== historicalPolicy.observed_generation ||
          livePolicy.spec_sha256 !== historicalPolicy.spec_sha256 ||
          (!recoveryBindingMayTransition &&
            liveBinding.spec_sha256 !== historicalBinding.spec_sha256)
        ))) {
      return false;
    }
  }
  if (current.parent_resources?.state !== "present" ||
      checkpoint.parent_resources?.state !== "present" ||
      !exactKeys(
        current.parent_resources.resources,
        PARENT_RESOURCE_DEFINITIONS.map(({ key }) => key)
      ) ||
      !exactKeys(
        checkpoint.parent_resources.resources,
        PARENT_RESOURCE_DEFINITIONS.map(({ key }) => key)
      )) {
    return false;
  }
  return PARENT_RESOURCE_DEFINITIONS.every(({ key }) => {
    const live = parentResourceHistoricalContract(current.parent_resources.resources[key]);
    const historical = parentResourceHistoricalContract(
      checkpoint.parent_resources.resources[key]
    );
    return live.api_version === historical.api_version && live.kind === historical.kind &&
      live.name === historical.name && live.namespace === historical.namespace &&
      live.uid === historical.uid && live.terminating === false &&
      historical.terminating === false &&
      (identityOnly || live.contract_sha256 === historical.contract_sha256);
  });
}

function parentDeploymentMatchesHistorical(
  current,
  checkpoint,
  expectedReplicas,
  identityOnly = false
) {
  return current?.api_version === checkpoint?.api_version &&
    current?.kind === checkpoint?.kind && current?.name === checkpoint?.name &&
    current?.namespace === checkpoint?.namespace && current?.uid === checkpoint?.uid &&
    current?.replicas === expectedReplicas && checkpoint?.replicas === 0 &&
    (identityOnly || current?.spec_sha256 === checkpoint?.spec_sha256) &&
    current?.terminating === false && checkpoint?.terminating === false;
}

function fencesPreserveHistoricalSubset(current, checkpoint, allowActiveInventory) {
  const activeCountsAreValid = allowActiveInventory &&
    Number.isInteger(current?.runners) && current.runners >= 0 &&
    Number.isInteger(current?.intents) && current.intents >= 0;
  if ((!activeCountsAreValid && (current?.runners !== 0 || current?.intents !== 0)) ||
      checkpoint?.runners !== 0 || checkpoint?.intents !== 0 ||
      !Array.isArray(current?.fences) || !Array.isArray(checkpoint?.fences) ||
      !current.fences.every(exactFenceEvidence) ||
      new Set(current.fences.map(fence => fence.name)).size !== current.fences.length) {
    return false;
  }
  const liveByName = new Map(current.fences.map(fence => [fence.name, fence]));
  return checkpoint.fences.every(historical => {
    const live = liveByName.get(historical.name);
    return live?.uid === historical.uid && live?.room_key === historical.room_key &&
      live?.process_generation === historical.process_generation &&
      live?.state === "fenced" && historical.state === "fenced";
  });
}

function recoveryOperationFenceCoreIsBound(core) {
  const state = core?.recovery_operation_fence_state;
  if (!RECOVERY_OPERATION_FENCE_STATES.includes(state)) return false;
  if (core?.runtime_generation === "legacy-absent") return state === "dormant";
  const namespace = core?.namespaces?.parent?.name;
  const binding = core?.admission?.pairs?.recovery_operation_fence?.binding;
  const controlPlaneBinding = controlPlaneContractByIdentity(
    core?.control_plane?.cluster_resources || [],
    "ValidatingAdmissionPolicyBinding",
    RECOVERY_OPERATION_FENCE_POLICY_NAME
  );
  return DNS_NAMESPACE.test(namespace || "") &&
    exactBindingEvidence(binding, RECOVERY_OPERATION_FENCE_POLICY_NAME) &&
    binding.spec_sha256 === recoveryOperationFenceBindingSpecSha256(namespace, state) &&
    controlPlaneBinding?.uid === binding.uid &&
    controlPlaneBinding?.contract_sha256 === sha256Canonical(
      recoveryOperationFenceBindingContract(namespace, state)
    );
}

export function verifyHistoricalSourceCore(current, checkpointEvidence, mode) {
  const expectedReplicas = LIVE_VERIFICATION_MODES[mode];
  if (!Object.hasOwn(LIVE_VERIFICATION_MODES, mode) || mode === "checkpoint") {
    fail("checkpoint_evidence_live_mode_invalid");
  }
  validateEvidenceEnvelope(checkpointEvidence);
  const targetMode = mode.endsWith("-target");
  const checkpoint = coreFromEnvelope(checkpointEvidence);
  const namespacesMatch = isDeepStrictEqual(
    namespaceHistoricalContract(current?.namespaces?.parent),
    namespaceHistoricalContract(checkpoint.namespaces.parent)
  ) && (checkpoint.namespaces.runner === null
    ? current?.namespaces?.runner === null
    : isDeepStrictEqual(
        namespaceHistoricalContract(current?.namespaces?.runner),
        namespaceHistoricalContract(checkpoint.namespaces.runner)
      ));
  if (
    !recoveryOperationFenceCoreIsBound(current) ||
    current?.runtime_generation !== checkpoint.runtime_generation ||
    !isDeepStrictEqual(current?.cluster, checkpoint.cluster) || !namespacesMatch ||
    !controlPlaneContractsMatchHistorical(
      current?.control_plane,
      checkpoint.control_plane,
      mode,
      current?.recovery_operation_fence_state,
      checkpoint.recovery_operation_fence_state
    ) ||
    !runnerRoleMatchesHistorical(current?.runner_role, checkpoint.runner_role, mode) ||
    !runnerRoleBindingMatchesHistorical(
      current?.runner_role_binding,
      checkpoint.runner_role_binding,
      targetMode
    ) ||
    !isDeepStrictEqual(
      journalHistoricalContract(current?.journal),
      journalHistoricalContract(checkpoint.journal)
    ) || !admissionMatchesHistorical(
      current?.admission,
      checkpoint.admission,
      targetMode,
      current?.recovery_operation_fence_state,
      checkpoint.recovery_operation_fence_state
    ) ||
    !parentDeploymentMatchesHistorical(
      current?.parent_deployment,
      checkpoint.parent_deployment,
      expectedReplicas,
      targetMode
    ) || !fencesPreserveHistoricalSubset(
      current?.quiescence,
      checkpoint.quiescence,
      mode === "active-source" || mode === "active-target"
    )
  ) {
    fail("checkpoint_evidence_historical_live_mismatch");
  }
  return current;
}

function liveVerificationMode(options) {
  const mode = options["live-mode"] || "checkpoint";
  if (!Object.hasOwn(LIVE_VERIFICATION_MODES, mode)) {
    fail("checkpoint_evidence_live_mode_invalid");
  }
  return mode;
}

export function liveVerificationContract(options, currentOperationId) {
  const mode = liveVerificationMode(options);
  const expectedRecoveryOperationFenceState = recoveryOperationFenceState(
    options["recovery-operation-fence-state"]
  );
  const cliCheckpointId = options["checkpoint-operation-id"];
  let expectedCheckpointOperationId = currentOperationId;
  if (mode === "checkpoint") {
    if (cliCheckpointId && cliCheckpointId !== currentOperationId) {
      fail("checkpoint_evidence_operation_mismatch");
    }
  } else {
    expectedCheckpointOperationId = cliCheckpointId;
    if (!OPERATION_ID.test(expectedCheckpointOperationId || "")) {
      fail("checkpoint_evidence_operation_binding_missing");
    }
  }
  return {
    mode,
    expected_parent_replicas: LIVE_VERIFICATION_MODES[mode],
    expected_checkpoint_operation_id: expectedCheckpointOperationId,
    expected_recovery_operation_fence_state: expectedRecoveryOperationFenceState
  };
}

function exactNamespaceEvidence(value, expectedName) {
  return exactKeys(value, [
    "api_version", "kind", "name", "uid", "resource_version", "terminating"
  ]) && value.api_version === "v1" && value.kind === "Namespace" &&
    value.name === expectedName && typeof value.uid === "string" && value.uid.length > 0 &&
    typeof value.resource_version === "string" && value.resource_version.length > 0 &&
    value.terminating === false;
}

function exactControlPlaneContractEntry(value, definition, namespace) {
  const resolvedName = definition.name === null ? namespace : definition.name;
  const resolvedNamespace = Object.hasOwn(definition, "namespace")
    ? (definition.namespace === null ? namespace : definition.namespace)
    : null;
  const fingerprint = definition.secret ? "contract_hmac_sha256" : "contract_sha256";
  const keys = [
    "api_version",
    "kind",
    "name",
    ...(resolvedNamespace === null ? [] : ["namespace"]),
    "uid",
    "resource_version",
    fingerprint,
    "terminating"
  ];
  return exactKeys(value, keys) && value.api_version === definition.apiVersion &&
    value.kind === definition.kind && value.name === resolvedName &&
    (resolvedNamespace === null || value.namespace === resolvedNamespace) &&
    typeof value.uid === "string" && value.uid.length > 0 &&
    typeof value.resource_version === "string" && value.resource_version.length > 0 &&
    HASH.test(value[fingerprint] || "") && value.terminating === false;
}

function exactControlPlaneContractGroup(values, definitions, namespace) {
  if (!Array.isArray(values) || values.length !== definitions.length) return false;
  const indexed = new Map(values.map(value => [controlPlaneEntryIdentity(value), value]));
  if (indexed.size !== values.length) return false;
  const expectedOrder = sortedControlPlaneEntries(values.map(value => ({ ...value })))
    .map(controlPlaneEntryIdentity);
  if (!isDeepStrictEqual(values.map(controlPlaneEntryIdentity), expectedOrder)) return false;
  return definitions.every(definition => {
    const resolvedName = definition.name === null ? namespace : definition.name;
    const resolvedNamespace = Object.hasOwn(definition, "namespace")
      ? (definition.namespace === null ? namespace : definition.namespace)
      : "";
    const value = indexed.get([
      definition.apiVersion,
      definition.kind,
      resolvedNamespace,
      resolvedName
    ].join("\u0000"));
    return exactControlPlaneContractEntry(value, definition, namespace);
  });
}

function controlPlaneContractByIdentity(group, kind, name, namespace = "") {
  return group.find(value => value.kind === kind && value.name === name &&
    (value.namespace || "") === namespace);
}

function exactPresentControlPlaneContracts(controlPlane, evidence, namespace) {
  if (!exactKeys(controlPlane, [
    "state", "namespaces", "namespaced_resources", "cluster_resources"
  ]) || controlPlane.state !== "present" ||
      !exactControlPlaneContractGroup(
        controlPlane.namespaces,
        CONTROL_PLANE_NAMESPACE_DEFINITIONS,
        namespace
      ) ||
      !exactControlPlaneContractGroup(
        controlPlane.namespaced_resources,
        CONTROL_PLANE_NAMESPACED_DEFINITIONS,
        namespace
      ) ||
      !exactControlPlaneContractGroup(
        controlPlane.cluster_resources,
        CONTROL_PLANE_CLUSTER_DEFINITIONS,
        namespace
      )) {
    return false;
  }
  const parentNamespace = controlPlaneContractByIdentity(
    controlPlane.namespaces,
    "Namespace",
    namespace
  );
  const runnerNamespace = controlPlaneContractByIdentity(
    controlPlane.namespaces,
    "Namespace",
    RUNNER_NAMESPACE
  );
  const journal = controlPlaneContractByIdentity(
    controlPlane.namespaced_resources,
    "ConfigMap",
    CUTOVER_JOURNAL_NAME,
    namespace
  );
  const runnerRole = controlPlaneContractByIdentity(
    controlPlane.namespaced_resources,
    "Role",
    RUNNER_ROLE_NAME,
    RUNNER_NAMESPACE
  );
  const runnerRoleBinding = controlPlaneContractByIdentity(
    controlPlane.namespaced_resources,
    "RoleBinding",
    RUNNER_ROLE_BINDING_NAME,
    RUNNER_NAMESPACE
  );
  const recoveryOperationFenceBinding = controlPlaneContractByIdentity(
    controlPlane.cluster_resources,
    "ValidatingAdmissionPolicyBinding",
    RECOVERY_OPERATION_FENCE_POLICY_NAME
  );
  if (parentNamespace?.uid !== evidence.namespaces.parent.uid ||
      runnerNamespace?.uid !== evidence.namespaces.runner.uid ||
      journal?.uid !== evidence.journal.config_map.uid ||
      runnerRole?.uid !== evidence.runner_role.uid ||
      runnerRole?.contract_sha256 !== evidence.runner_role.contract_sha256 ||
      runnerRoleBinding?.uid !== evidence.runner_role_binding.uid ||
      runnerRoleBinding?.contract_sha256 !== evidence.runner_role_binding.contract_sha256 ||
      recoveryOperationFenceBinding?.contract_sha256 !== sha256Canonical(
        recoveryOperationFenceBindingContract(
          namespace,
          evidence.recovery_operation_fence_state
        )
      )) {
    return false;
  }
  for (const definition of PARENT_RESOURCE_DEFINITIONS) {
    const value = controlPlaneContractByIdentity(
      controlPlane.namespaced_resources,
      definition.kind,
      definition.name,
      namespace
    );
    const linked = evidence.admission.parent_resources.resources[definition.key];
    if (value?.uid !== linked.uid || value?.contract_sha256 !== linked.contract_sha256) {
      return false;
    }
  }
  for (const definition of CONTROL_PLANE_CLUSTER_DEFINITIONS) {
    const value = controlPlaneContractByIdentity(
      controlPlane.cluster_resources,
      definition.kind,
      definition.name
    );
    const linked = evidence.admission.pairs[definition.pairKey][definition.pairMember];
    if (value?.uid !== linked.uid) return false;
  }
  return true;
}

function exactRunnerRoleEvidence(value) {
  return exactKeys(value, [
    "api_version",
    "kind",
    "name",
    "namespace",
    "uid",
    "resource_version",
    "contract_sha256",
    "inert_contract_sha256",
    "terminating"
  ]) && value.api_version === "rbac.authorization.k8s.io/v1" && value.kind === "Role" &&
    value.name === RUNNER_ROLE_NAME && value.namespace === RUNNER_NAMESPACE &&
    typeof value.uid === "string" && value.uid.length > 0 &&
    typeof value.resource_version === "string" && value.resource_version.length > 0 &&
    HASH.test(value.contract_sha256 || "") && HASH.test(value.inert_contract_sha256 || "") &&
    value.terminating === false;
}

function exactRunnerRoleBindingEvidence(value) {
  return exactKeys(value, [
    "api_version",
    "kind",
    "name",
    "namespace",
    "uid",
    "resource_version",
    "contract_sha256",
    "terminating"
  ]) && value.api_version === "rbac.authorization.k8s.io/v1" &&
    value.kind === "RoleBinding" && value.name === RUNNER_ROLE_BINDING_NAME &&
    value.namespace === RUNNER_NAMESPACE && typeof value.uid === "string" &&
    value.uid.length > 0 && typeof value.resource_version === "string" &&
    value.resource_version.length > 0 && HASH.test(value.contract_sha256 || "") &&
    value.terminating === false;
}

function exactFenceEvidence(value) {
  const structurallyValid = exactKeys(value, [
    "name",
    "uid",
    "resource_version",
    "room_key",
    "process_generation",
    "state"
  ]) && /^bot-runner-[0-9a-f]{16}-[0-9a-f]{8}$/.test(value.name || "") &&
    typeof value.uid === "string" && value.uid.length > 0 &&
    typeof value.resource_version === "string" && value.resource_version.length > 0 &&
    /^[0-9a-f]{20}$/.test(value.room_key || "") &&
    UUID_V4.test(value.process_generation || "") && value.state === "fenced";
  if (!structurallyValid) return false;
  try {
    return value.name === runnerPodName(value.room_key, value.process_generation);
  } catch (_error) {
    return false;
  }
}

function exactAbsentAdmission(admission, namespace) {
  if (!exactKeys(admission, [
    "state", "absence_verified", "pairs", "parent_resources"
  ]) || admission.state !== "absent" || admission.absence_verified !== true ||
    !exactKeys(admission.pairs, PAIR_DEFINITIONS.map(({ key }) => key))) {
    return false;
  }
  for (const { key, name } of PAIR_DEFINITIONS) {
    if (!isDeepStrictEqual(admission.pairs[key], {
      policy_name: name,
      binding_name: name
    })) return false;
  }
  const parent = admission.parent_resources;
  if (!exactKeys(parent, ["state", "absence_verified", "resources"]) ||
      parent.state !== "absent" || parent.absence_verified !== true ||
      !exactKeys(parent.resources, PARENT_RESOURCE_DEFINITIONS.map(({ key }) => key))) {
    return false;
  }
  return PARENT_RESOURCE_DEFINITIONS.every(definition => isDeepStrictEqual(
    parent.resources[definition.key],
    {
      api_version: definition.apiVersion,
      kind: definition.kind,
      name: definition.name,
      namespace
    }
  ));
}

function exactPolicyEvidence(value, expectedName) {
  return exactKeys(value, [
    "name",
    "uid",
    "resource_version",
    "generation",
    "observed_generation",
    "spec_sha256",
    "terminating"
  ]) && value.name === expectedName && typeof value.uid === "string" && value.uid.length > 0 &&
    typeof value.resource_version === "string" && value.resource_version.length > 0 &&
    Number.isInteger(value.generation) && value.generation > 0 &&
    value.observed_generation === value.generation && HASH.test(value.spec_sha256 || "") &&
    value.terminating === false;
}

function exactBindingEvidence(value, expectedName) {
  return exactKeys(value, [
    "name", "uid", "resource_version", "spec_sha256", "terminating"
  ]) && value.name === expectedName && typeof value.uid === "string" && value.uid.length > 0 &&
    typeof value.resource_version === "string" && value.resource_version.length > 0 &&
    HASH.test(value.spec_sha256 || "") && value.terminating === false;
}

function exactPresentAdmission(admission, namespace, expectedRecoveryOperationFenceState) {
  const recoveryFenceState = recoveryOperationFenceState(
    expectedRecoveryOperationFenceState
  );
  if (!exactKeys(admission, ["state", "pairs", "parent_resources"]) ||
      admission.state !== "present" ||
      !exactKeys(admission.pairs, PAIR_DEFINITIONS.map(({ key }) => key))) {
    return false;
  }
  for (const { key, name } of PAIR_DEFINITIONS) {
    const pair = admission.pairs[key];
    if (!exactKeys(pair, ["policy", "binding", "observed"]) || pair.observed !== true ||
        !exactPolicyEvidence(pair.policy, name) || !exactBindingEvidence(pair.binding, name)) {
      return false;
    }
    if (key === "recovery_operation_fence" &&
        pair.binding.spec_sha256 !== recoveryOperationFenceBindingSpecSha256(
          namespace,
          recoveryFenceState
        )) {
      return false;
    }
  }
  const parent = admission.parent_resources;
  if (!exactKeys(parent, ["state", "resources"]) || parent.state !== "present" ||
      !exactKeys(parent.resources, PARENT_RESOURCE_DEFINITIONS.map(({ key }) => key))) {
    return false;
  }
  return PARENT_RESOURCE_DEFINITIONS.every(definition => {
    const value = parent.resources[definition.key];
    return exactKeys(value, [
      "api_version",
      "kind",
      "name",
      "namespace",
      "uid",
      "resource_version",
      "contract_sha256",
      "terminating"
    ]) && value.api_version === definition.apiVersion && value.kind === definition.kind &&
      value.name === definition.name && value.namespace === namespace &&
      typeof value.uid === "string" && value.uid.length > 0 &&
      typeof value.resource_version === "string" && value.resource_version.length > 0 &&
      HASH.test(value.contract_sha256 || "") && value.terminating === false;
  });
}

function exactParentDeploymentEvidence(value, namespace) {
  return exactKeys(value, [
    "api_version",
    "kind",
    "name",
    "namespace",
    "uid",
    "resource_version",
    "replicas",
    "spec_sha256",
    "terminating"
  ]) && value.api_version === "apps/v1" && value.kind === "Deployment" &&
    value.name === "bot-orchestrator" && value.namespace === namespace &&
    typeof value.uid === "string" && value.uid.length > 0 &&
    typeof value.resource_version === "string" && value.resource_version.length > 0 &&
    value.replicas === 0 && HASH.test(value.spec_sha256 || "") && value.terminating === false;
}

function exactQuiescenceEvidence(value) {
  return exactKeys(value, ["runners", "intents", "fences"]) &&
    value.runners === 0 && value.intents === 0 && Array.isArray(value.fences) &&
    value.fences.every(exactFenceEvidence) &&
    isDeepStrictEqual(
      value.fences.map(fence => fence.name),
      value.fences.map(fence => fence.name).sort()
    ) && new Set(value.fences.map(fence => fence.name)).size === value.fences.length;
}

function exactLegacyJournal(journal, namespace) {
  return exactKeys(journal, ["state", "config_map", "absence_verified"]) &&
    journal.state === "absent" && journal.absence_verified === true &&
    isDeepStrictEqual(journal.config_map, {
      name: CUTOVER_JOURNAL_NAME,
      namespace
    });
}

function exactDurableJournal(journal, evidence) {
  if (!exactKeys(journal, [
    "state",
    "config_map",
    "canonical_json",
    "canonical_sha256",
    "hmac_verification",
    "contract"
  ]) || journal.state !== "present" || journal.hmac_verification !== "verified-owner-key" ||
      typeof journal.canonical_json !== "string" || !HASH.test(journal.canonical_sha256 || "") ||
      sha256Bytes(Buffer.from(journal.canonical_json, "utf8")) !== journal.canonical_sha256 ||
      !exactKeys(journal.config_map, [
        "name",
        "namespace",
        "uid",
        "resource_version",
        "immutable",
        "finalizers",
        "terminating"
      ]) || journal.config_map.name !== CUTOVER_JOURNAL_NAME ||
      journal.config_map.namespace !== evidence.namespaces.parent.name ||
      typeof journal.config_map.uid !== "string" || journal.config_map.uid.length === 0 ||
      typeof journal.config_map.resource_version !== "string" ||
      journal.config_map.resource_version.length === 0 || journal.config_map.immutable !== true ||
      !isDeepStrictEqual(journal.config_map.finalizers, [CUTOVER_JOURNAL_FINALIZER]) ||
      journal.config_map.terminating !== false) {
    return false;
  }
  let parsed;
  try {
    parsed = JSON.parse(journal.canonical_json);
  } catch (_error) {
    return false;
  }
  const issuedAtTime = canonicalUtcTimestamp(parsed?.issuedAt);
  const exactNamespace = exactKeys(parsed?.namespace, ["name", "uid"]) &&
    isDeepStrictEqual(parsed.namespace, {
      name: evidence.namespaces.parent.name,
      uid: evidence.namespaces.parent.uid
    });
  const exactTargetHashes = exactKeys(parsed?.targetHashes, [
    "journalPolicy",
    "journalBinding",
    "parentPolicy",
    "parentBinding",
    "parentDeployment"
  ]) && Object.values(parsed.targetHashes).every(hash => HASH.test(hash));
  const exactBaseline = parsed?.mode === "clean-install"
    ? parsed.baselineDeployment === null && parsed.authorizationSha256 === null
    : exactKeys(parsed?.baselineDeployment, ["name", "uid", "resourceVersion"]) &&
      parsed.baselineDeployment.name === "bot-orchestrator" &&
      parsed.baselineDeployment.uid === evidence.parent_deployment.uid &&
      typeof parsed.baselineDeployment.resourceVersion === "string" &&
      parsed.baselineDeployment.resourceVersion.length > 0 &&
      HASH.test(parsed.authorizationSha256 || "");
  if (canonicalJson(parsed) !== journal.canonical_json || !exactKeys(parsed, [
    "schemaVersion",
    "mode",
    "operation",
    "operationId",
    "authorizationSha256",
    "expectedKubeContext",
    "namespace",
    "baselineDeployment",
    "manifestSha256",
    "targetHashes",
    "issuedAt",
    "hmacSha256"
  ]) || parsed.schemaVersion !== 2 || !HASH.test(parsed.hmacSha256 || "") ||
      !["clean-install", "pristine-cutover"].includes(parsed.mode) ||
      !exactNamespace || !exactTargetHashes || !exactBaseline || issuedAtTime === null) {
    return false;
  }
  let projected;
  try {
    projected = journalContractEvidence(parsed);
  } catch (_error) {
    return false;
  }
  return isDeepStrictEqual(projected, journal.contract) &&
    journal.contract.schema_version === 2 &&
    journal.contract.operation === "first-fence-bootstrap" &&
    UUID_V4.test(journal.contract.operation_id || "") &&
    journal.contract.expected_kube_context === evidence.cluster.kube_context &&
    isDeepStrictEqual(journal.contract.namespace, {
      name: evidence.namespaces.parent.name,
      uid: evidence.namespaces.parent.uid
    }) && HASH.test(journal.contract.manifest_sha256 || "") &&
    exactKeys(journal.contract.target_hashes, [
      "journal_policy",
      "journal_binding",
      "parent_policy",
      "parent_binding",
      "parent_deployment"
    ]) && Object.values(journal.contract.target_hashes).every(hash => HASH.test(hash));
}

function validateEvidenceEnvelope(evidence) {
  const startedAt = canonicalUtcTimestamp(evidence?.capture_window?.started_at_utc);
  const completedAt = canonicalUtcTimestamp(evidence?.capture_window?.completed_at_utc);
  if (
    !exactKeys(evidence, [
      "schema_version",
      "checkpoint_operation_id",
      "runtime_generation",
      "recovery_operation_fence_state",
      "capture_window",
      "cluster",
      "namespaces",
      "control_plane",
      "runner_role",
      "runner_role_binding",
      "journal",
      "admission",
      "parent_deployment",
      "quiescence"
    ]) || evidence.schema_version !== EVIDENCE_SCHEMA_VERSION ||
    !OPERATION_ID.test(evidence.checkpoint_operation_id || "") ||
    !["legacy-absent", "durable-v2"].includes(evidence.runtime_generation) ||
    !RECOVERY_OPERATION_FENCE_STATES.includes(evidence.recovery_operation_fence_state) ||
    !exactKeys(evidence.capture_window, ["started_at_utc", "completed_at_utc"]) ||
    startedAt === null || completedAt === null || completedAt < startedAt
  ) {
    fail("checkpoint_evidence_shape_invalid");
  }
  const namespace = evidence.namespaces?.parent?.name;
  if (!DNS_NAMESPACE.test(namespace || "") ||
      !exactKeys(evidence.cluster, ["kube_context", "anchor"]) ||
      !SAFE_CONTEXT.test(evidence.cluster.kube_context || "") ||
      !isDeepStrictEqual(Object.keys(evidence.cluster.anchor || {}).sort(), [
        "api_version", "kind", "name", "uid"
      ].sort()) || evidence.cluster.anchor.api_version !== "v1" ||
      evidence.cluster.anchor.kind !== "Namespace" ||
      evidence.cluster.anchor.name !== "kube-system" ||
      typeof evidence.cluster.anchor.uid !== "string" || evidence.cluster.anchor.uid.length === 0 ||
      !exactKeys(evidence.namespaces, ["parent", "runner"]) ||
      !exactNamespaceEvidence(evidence.namespaces.parent, namespace) ||
      !exactParentDeploymentEvidence(evidence.parent_deployment, namespace) ||
      !exactQuiescenceEvidence(evidence.quiescence)) {
    fail("checkpoint_evidence_shape_invalid");
  }
  if (evidence.runtime_generation === "durable-v2") {
    if (!exactNamespaceEvidence(evidence.namespaces.runner, RUNNER_NAMESPACE) ||
        !exactRunnerRoleEvidence(evidence.runner_role) ||
        !exactRunnerRoleBindingEvidence(evidence.runner_role_binding) ||
        !exactDurableJournal(evidence.journal, evidence) ||
        !exactPresentAdmission(
          evidence.admission,
          namespace,
          evidence.recovery_operation_fence_state
        ) ||
        !exactPresentControlPlaneContracts(evidence.control_plane, evidence, namespace)) {
      fail("checkpoint_evidence_durable_invalid");
    }
  } else if (evidence.recovery_operation_fence_state !== "dormant" ||
      evidence.namespaces.runner !== null || evidence.runner_role !== null ||
      evidence.runner_role_binding !== null ||
      !isDeepStrictEqual(evidence.control_plane, { state: "legacy-absent" }) ||
      !exactLegacyJournal(evidence.journal, namespace) ||
      !exactAbsentAdmission(evidence.admission, namespace) ||
      evidence.quiescence.fences.length !== 0) {
    fail("checkpoint_evidence_legacy_invalid");
  }
  return evidence;
}

function identityKey(value, namespaced = false) {
  return [
    value?.api_version,
    value?.kind,
    ...(namespaced ? [value?.namespace] : []),
    value?.name
  ].join("\u0000");
}

function exactIdentityList(values, expected, { namespaced = false } = {}) {
  const keys = namespaced
    ? ["api_version", "kind", "name", "namespace", "resource_version", "uid"]
    : ["api_version", "kind", "name", "resource_version", "uid"];
  if (!Array.isArray(values) || values.length !== expected.length ||
      values.some(value => !exactKeys(value, keys) ||
        typeof value.uid !== "string" || value.uid.length === 0 ||
        typeof value.resource_version !== "string" || value.resource_version.length === 0)) {
    return false;
  }
  const indexed = new Map(values.map(value => [identityKey(value, namespaced), value]));
  if (indexed.size !== values.length) return false;
  return expected.every(contract => {
    const value = indexed.get(identityKey(contract, namespaced));
    return value !== undefined &&
      (contract.uid === undefined || value.uid === contract.uid);
  });
}

function durableControlPlaneIsExact(controlPlane, evidence) {
  if (!exactKeys(controlPlane, [
    "cluster_resources",
    "namespaced_resources",
    "namespaces",
    "state"
  ]) || controlPlane.state !== "kubernetes-active") {
    return false;
  }
  const inventoryIdentity = value => ({
    api_version: value.api_version,
    kind: value.kind,
    ...(value.namespace === undefined ? {} : { namespace: value.namespace }),
    name: value.name,
    uid: value.uid
  });
  const namespaces = evidence.control_plane.namespaces.map(inventoryIdentity);
  const namespacedResources = evidence.control_plane.namespaced_resources.map(inventoryIdentity);
  const clusterResources = evidence.control_plane.cluster_resources.map(inventoryIdentity);
  return exactIdentityList(controlPlane.namespaces, namespaces) &&
    exactIdentityList(controlPlane.namespaced_resources, namespacedResources, {
      namespaced: true
    }) && exactIdentityList(controlPlane.cluster_resources, clusterResources);
}

function trustedDeploymentInventoryFailure(deployments, mode, expectedParentUid) {
  if (!Array.isArray(deployments) || deployments.length !== EXPECTED_DEPLOYMENTS.length) {
    return "deployment_count";
  }
  const byName = new Map();
  const pairs = [];
  for (const deployment of deployments) {
    if (!exactKeys(deployment, [
      "containers",
      "init_containers",
      "name",
      "replicas",
      "uid"
    ]) || typeof deployment.name !== "string" ||
        typeof deployment.uid !== "string" || deployment.uid.length === 0 ||
        !Number.isInteger(deployment.replicas) || deployment.replicas < 0 ||
        !Array.isArray(deployment.init_containers) || deployment.init_containers.length !== 0 ||
        !Array.isArray(deployment.containers) || deployment.containers.length === 0 ||
        byName.has(deployment.name)) {
      return "deployment_shape";
    }
    byName.set(deployment.name, deployment);
    const containerNames = new Set();
    for (const container of deployment.containers) {
      if (!exactKeys(container, ["image", "name"]) ||
          typeof container.name !== "string" || container.name.length === 0 ||
          typeof container.image !== "string" || containerNames.has(container.name)) {
        return "container_shape";
      }
      const imageMatch = /^(.*)@sha256:[a-fA-F0-9]{64}$/.exec(container.image);
      const pair = `${deployment.name}/${container.name}`;
      if (!imageMatch || !TRUSTED_IMAGE_REPOSITORIES[pair]?.includes(imageMatch[1])) {
        return "container_image";
      }
      containerNames.add(container.name);
      pairs.push(pair);
    }
  }
  if (!isDeepStrictEqual([...byName.keys()].sort(), [...EXPECTED_DEPLOYMENTS].sort())) {
    return "deployment_names";
  }
  const postgresPair = mode === "process-local" ? "pgsql/postgresql" : "pgsql/pgsql";
  const expectedPairs = [...EXPECTED_CONTAINER_PAIRS, postgresPair].sort();
  const parent = byName.get("bot-orchestrator");
  if (!isDeepStrictEqual(pairs.sort(), expectedPairs)) return "container_pairs";
  if (parent.uid !== expectedParentUid) return "parent_uid";
  if (parent.replicas !== 1) return "parent_replicas";
  return null;
}

export function validateDeploymentInventory(inventory, evidence) {
  validateEvidenceEnvelope(evidence);
  if (!exactKeys(inventory, [
    "bot_runner_runtime",
    "deployments",
    "namespace",
    "namespace_uid",
    "schema_version"
  ]) || inventory.schema_version !== 4 ||
      inventory.namespace !== evidence.namespaces.parent.name ||
      inventory.namespace_uid !== evidence.namespaces.parent.uid ||
      !exactKeys(inventory.bot_runner_runtime, [
        "control_plane",
        "generation",
        "image",
        "mode",
        "recovery_epoch"
      ])) {
    fail("deployment_inventory_evidence_mismatch:envelope");
  }
  if (inventory.bot_runner_runtime.generation !== evidence.runtime_generation) {
    fail("deployment_inventory_evidence_mismatch:runtime_generation");
  }
  const runtime = inventory.bot_runner_runtime;
  const legacy = runtime.generation === "legacy-absent" &&
    runtime.mode === "process-local" && runtime.image === null &&
    isDeepStrictEqual(runtime.recovery_epoch, { state: "legacy-absent" }) &&
    isDeepStrictEqual(runtime.control_plane, { state: "legacy-absent" });
  const durable = runtime.generation === "durable-v2" &&
    runtime.mode === "kubernetes-pod" &&
    typeof runtime.image === "string" &&
    /^ghcr\.io\/yengalvez\/bot-runner@sha256:[a-fA-F0-9]{64}$/.test(runtime.image) &&
    exactKeys(runtime.recovery_epoch, ["state", "value"]) &&
    runtime.recovery_epoch.state === "bound" &&
    UUID_V4.test(runtime.recovery_epoch.value || "") &&
    durableControlPlaneIsExact(runtime.control_plane, evidence);
  if (!legacy && !durable) {
    fail("deployment_inventory_evidence_mismatch:runtime_contract");
  }
  const deploymentFailure = trustedDeploymentInventoryFailure(
    inventory.deployments,
    runtime.mode,
    evidence.parent_deployment.uid
  );
  if (deploymentFailure !== null) {
    fail(`deployment_inventory_evidence_mismatch:${deploymentFailure}`);
  }
  return inventory;
}

function verifyInventory(inventoryPath, evidence) {
  if (!inventoryPath) fail("deployment_inventory_required");
  const inventory = privateJsonFile(inventoryPath, "deployment_inventory_file_invalid").value;
  return validateDeploymentInventory(inventory, evidence);
}

export class KubectlEvidenceReader {
  constructor(context, namespace) {
    if (!SAFE_CONTEXT.test(context || "") || !DNS_NAMESPACE.test(namespace || "")) {
      fail("checkpoint_target_environment_invalid");
    }
    this.context = context;
    this.namespace = namespace;
  }

  run(args, { input = undefined, optional = false, code = "kubectl_read_failed" } = {}) {
    const result = spawnSync(
      "kubectl",
      ["--context", this.context, "--request-timeout=30s", ...args],
      {
        input,
        encoding: "utf8",
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        timeout: KUBECTL_TIMEOUT_MS,
        maxBuffer: MAX_JSON_BYTES
      }
    );
    if (result.error || result.status !== 0) fail(code);
    if (optional && result.stdout.trim() === "") return null;
    try {
      return JSON.parse(result.stdout);
    } catch (_error) {
      fail(`${code}_json_invalid`);
    }
  }

  optional(args, code) {
    return this.run([...args, "--ignore-not-found", "-o", "json"], { optional: true, code });
  }

  required(args, code) {
    return this.run([...args, "-o", "json"], { code });
  }

  normalizedParentTarget(target, live, replicas = 0) {
    if (![0, 1].includes(replicas)) fail("parent_deployment_replica_contract_invalid");
    const candidate = structuredClone(target);
    candidate.metadata = {
      ...candidate.metadata,
      resourceVersion: live.metadata.resourceVersion
    };
    candidate.spec = { ...candidate.spec, replicas };
    delete candidate.status;
    return this.run(
      ["replace", "--dry-run=server", "-f", "-", "-o", "json"],
      { input: JSON.stringify(candidate), code: "parent_deployment_server_normalization_failed" }
    );
  }

  collect(manifest = null, parentReplicas = 0) {
    if (![0, 1].includes(parentReplicas)) {
      fail("parent_deployment_replica_contract_invalid");
    }
    const admission = Object.fromEntries(PAIR_DEFINITIONS.map(({ key, name }) => [
      key,
      {
        policy: this.optional(
          ["get", "validatingadmissionpolicy", name],
          `read_${key}_policy_failed`
        ),
        binding: this.optional(
          ["get", "validatingadmissionpolicybinding", name],
          `read_${key}_binding_failed`
        )
      }
    ]));
    const runnerNamespace = this.optional(
      ["get", "namespace", RUNNER_NAMESPACE],
      "read_runner_namespace_failed"
    );
    const parentDeployment = this.required(
      ["-n", this.namespace, "get", "deployment", "bot-orchestrator"],
      "read_parent_deployment_failed"
    );
    const parentResources = Object.fromEntries(PARENT_RESOURCE_DEFINITIONS.map(definition => [
      definition.key,
      this.optional(
        [
          "-n",
          this.namespace,
          "get",
          definition.kind.toLowerCase(),
          definition.name
        ],
        `read_parent_${definition.key}_failed`
      )
    ]));
    const snapshot = {
      cluster_anchor: this.required(
        ["get", "namespace", "kube-system"],
        "read_cluster_anchor_failed"
      ),
      parent_namespace: this.required(
        ["get", "namespace", this.namespace],
        "read_parent_namespace_failed"
      ),
      runner_namespace: runnerNamespace,
      runner_role: this.optional(
        ["-n", RUNNER_NAMESPACE, "get", "role", RUNNER_ROLE_NAME],
        "read_runner_role_failed"
      ),
      runner_role_binding: this.optional(
        ["-n", RUNNER_NAMESPACE, "get", "rolebinding", RUNNER_ROLE_BINDING_NAME],
        "read_runner_role_binding_failed"
      ),
      runner_pull_secret: this.optional(
        ["-n", RUNNER_NAMESPACE, "get", "secret", "bot-images-pull"],
        "read_runner_pull_secret_failed"
      ),
      runner_service_account: this.optional(
        ["-n", RUNNER_NAMESPACE, "get", "serviceaccount", "bot-runner"],
        "read_runner_service_account_failed"
      ),
      guard_service_account: this.optional(
        ["-n", RUNNER_NAMESPACE, "get", "serviceaccount", "bot-runner-guard"],
        "read_guard_service_account_failed"
      ),
      runner_quota: this.optional(
        ["-n", RUNNER_NAMESPACE, "get", "resourcequota", "bot-runner-capacity"],
        "read_runner_quota_failed"
      ),
      guard_quota: this.optional(
        ["-n", RUNNER_NAMESPACE, "get", "resourcequota", "bot-runner-guard-capacity"],
        "read_guard_quota_failed"
      ),
      runner_default_deny: this.optional(
        ["-n", RUNNER_NAMESPACE, "get", "networkpolicy", "bot-runner-default-deny"],
        "read_runner_default_deny_failed"
      ),
      runner_egress: this.optional(
        ["-n", RUNNER_NAMESPACE, "get", "networkpolicy", "bot-runner-egress"],
        "read_runner_egress_failed"
      ),
      journal_config_map: this.optional(
        ["-n", this.namespace, "get", "configmap", CUTOVER_JOURNAL_NAME],
        "read_cutover_journal_failed"
      ),
      admission,
      parent_resources: parentResources,
      parent_deployment: parentDeployment,
      runner_pods: runnerNamespace === null
        ? null
        : this.required(
            ["-n", RUNNER_NAMESPACE, "get", "pods"],
            "read_runner_pods_failed"
          ),
      normalized_parent_target: null
    };
    if (manifest !== null && resourcesAreAllPresent(snapshot)) {
      snapshot.normalized_parent_target = this.normalizedParentTarget(
        manifest.parent_target,
        parentDeployment,
        parentReplicas
      );
    }
    return snapshot;
  }
}

function environmentInputs(
  valuesPath,
  manifestPath = null,
  {
    requireOperationId = true,
    expectedRecoveryPhase = "active",
    expectedRecoveryOperationFenceState
  } = {}
) {
  const recoveryFenceState = recoveryOperationFenceState(
    expectedRecoveryOperationFenceState
  );
  const valuesBytes = privateRegularFileBytes(
    valuesPath,
    MAX_JSON_BYTES,
    "checkpoint_values_file_invalid"
  );
  let values;
  let manifestBytes;
  try {
    values = parseLocalValuesSource(valuesBytes.toString("utf8"));
  } catch (_error) {
    valuesBytes.fill(0);
    fail("checkpoint_values_contract_invalid");
  }
  try {
    const namespace = requiredString(process.env.NAMESPACE, "checkpoint_namespace_missing");
    const expectedKubeContext = requiredString(
      process.env.EXPECTED_KUBE_CONTEXT,
      "checkpoint_kube_context_missing"
    );
    const expectedNamespaceUid = requiredString(
      process.env.EXPECTED_NAMESPACE_UID,
      "checkpoint_namespace_uid_missing"
    );
    const operationId = requireOperationId
      ? requiredString(
          process.env.RECOVERY_OPERATION_ID,
          "checkpoint_operation_id_missing"
        )
      : null;
    if (
      values.get("Namespace") !== namespace || !DNS_NAMESPACE.test(namespace) ||
      !SAFE_CONTEXT.test(expectedKubeContext) ||
      (requireOperationId && !OPERATION_ID.test(operationId))
    ) {
      fail("checkpoint_environment_binding_invalid");
    }
    let contract = null;
    if (manifestPath) {
      manifestBytes = privateRegularFileBytes(
        manifestPath,
        MAX_MANIFEST_BYTES,
        "checkpoint_manifest_file_invalid"
      );
      contract = manifestContractFromSnapshot(manifestBytes, values, namespace, {
        expectedRecoveryPhase
      });
    }
    return {
      namespace,
      expected_kube_context: expectedKubeContext,
      expected_namespace_uid: expectedNamespaceUid,
      operation_id: operationId,
      expected_recovery_operation_fence_state: recoveryFenceState,
      manifest_contract: contract,
      cutover_key: null
    };
  } finally {
    valuesBytes.fill(0);
    if (Buffer.isBuffer(manifestBytes)) manifestBytes.fill(0);
    values.clear();
  }
}

function readCutoverKey() {
  const keyPath = process.env.PROCESS_LOCAL_CUTOVER_KEY_PATH;
  const bytes = privateRegularFileBytes(keyPath, MAX_KEY_BYTES, "cutover_key_file_invalid");
  if (bytes.length < MIN_KEY_BYTES || bytes.length > MAX_KEY_BYTES) {
    fail("cutover_key_file_invalid");
  }
  return bytes;
}

export function verifyManifestEpochBinding(mode, inputs, inventory, evidence) {
  if (!Object.hasOwn(LIVE_VERIFICATION_MODES, mode)) {
    fail("checkpoint_evidence_live_mode_invalid");
  }
  if (mode.endsWith("-source")) return;
  const targetMode = mode.endsWith("-target");
  if (targetMode && evidence.runtime_generation !== "durable-v2") {
    fail("runner_target_generation_invalid");
  }
  if (evidence.runtime_generation === "legacy-absent") return;
  const sourceEpoch = inventory.bot_runner_runtime.recovery_epoch?.value;
  const manifestEpoch = inputs.manifest_contract?.recovery_epoch;
  if (!UUID_V4.test(sourceEpoch || "") || !UUID_V4.test(manifestEpoch || "") ||
      (mode === "checkpoint" && manifestEpoch !== sourceEpoch) ||
      (targetMode && manifestEpoch === sourceEpoch)) {
    fail("checkpoint_manifest_recovery_epoch_binding_invalid");
  }
}

function captureStableCore(reader, inputs) {
  const firstLive = reader.collect(inputs.manifest_contract);
  const generation = runtimeGeneration(firstLive);
  if (generation === "durable-v2") {
    if (!inputs.manifest_contract) fail("durable_checkpoint_manifest_missing");
    if (!Buffer.isBuffer(inputs.cutover_key)) inputs.cutover_key = readCutoverKey();
  }
  const first = buildCheckpointEvidenceCore(firstLive, inputs);
  const second = buildCheckpointEvidenceCore(
    reader.collect(inputs.manifest_contract),
    inputs
  );
  if (!isDeepStrictEqual(first, second)) fail("checkpoint_evidence_capture_unstable");
  return second;
}

function captureCommand(options) {
  const inputs = environmentInputs(options.values, options.manifest, {
    expectedRecoveryOperationFenceState: options["recovery-operation-fence-state"]
  });
  try {
    const reader = new KubectlEvidenceReader(inputs.expected_kube_context, inputs.namespace);
    const startedAt = new Date().toISOString();
    const core = captureStableCore(reader, inputs);
    const completedAt = new Date().toISOString();
    const evidence = evidenceEnvelope(core, inputs.operation_id, {
      started_at_utc: startedAt,
      completed_at_utc: completedAt
    });
    validateEvidenceEnvelope(evidence);
    const inventory = verifyInventory(options.inventory, evidence);
    verifyManifestEpochBinding("checkpoint", inputs, inventory, evidence);
    writePrivateCanonicalJson(options.output, evidence);
  } finally {
    if (Buffer.isBuffer(inputs.cutover_key)) inputs.cutover_key.fill(0);
  }
}

function verifyCommand(options) {
  const evidence = canonicalEvidenceFile(options.evidence);
  const mode = liveVerificationMode(options);
  const sourceMode = mode.endsWith("-source");
  const targetMode = mode.endsWith("-target");
  if ((sourceMode && options.manifest) || (targetMode && !options.manifest)) {
    fail("checkpoint_evidence_manifest_mode_invalid");
  }
  const inputs = environmentInputs(options.values, sourceMode ? null : options.manifest, {
    requireOperationId: mode === "checkpoint",
    expectedRecoveryPhase: mode === "quiesced-target" ? "restore-fence" : "active",
    expectedRecoveryOperationFenceState: options["recovery-operation-fence-state"]
  });
  try {
    const verification = liveVerificationContract(options, inputs.operation_id);
    if (inputs.expected_recovery_operation_fence_state !==
        verification.expected_recovery_operation_fence_state) {
      fail("recovery_operation_fence_state_invalid");
    }
    if (evidence.checkpoint_operation_id !== verification.expected_checkpoint_operation_id) {
      fail("checkpoint_evidence_operation_mismatch");
    }
    const inventory = verifyInventory(options.inventory, evidence);
    verifyManifestEpochBinding(mode, inputs, inventory, evidence);
    const reader = new KubectlEvidenceReader(inputs.expected_kube_context, inputs.namespace);
    const firstLive = reader.collect(
      sourceMode ? null : inputs.manifest_contract,
      verification.expected_parent_replicas
    );
    const generation = runtimeGeneration(firstLive);
    if (generation === "durable-v2") {
      if (!sourceMode && !inputs.manifest_contract) fail("durable_checkpoint_manifest_missing");
      inputs.cutover_key = readCutoverKey();
    }
    const buildOptions = {
      expectedParentReplicas: verification.expected_parent_replicas,
      verificationMode: mode,
      checkpointEvidence: mode === "checkpoint" ? null : evidence
    };
    const first = buildCheckpointEvidenceCore(firstLive, inputs, buildOptions);
    const second = buildCheckpointEvidenceCore(
      reader.collect(
        sourceMode ? null : inputs.manifest_contract,
        verification.expected_parent_replicas
      ),
      inputs,
      buildOptions
    );
    if (!isDeepStrictEqual(first, second)) {
      fail("checkpoint_evidence_live_unstable");
    }
    if (verification.mode === "checkpoint" &&
        !isDeepStrictEqual(second, coreFromEnvelope(evidence))) {
      fail("checkpoint_evidence_live_mismatch");
    }
    if (verification.mode !== "checkpoint") {
      verifyHistoricalSourceCore(second, evidence, verification.mode);
    }
  } finally {
    if (Buffer.isBuffer(inputs.cutover_key)) inputs.cutover_key.fill(0);
  }
}

function validateCommand(options) {
  const evidence = canonicalEvidenceFile(options.evidence);
  verifyInventory(options.inventory, evidence);
}

function validateEvidenceCommand(options) {
  canonicalEvidenceFile(options.evidence);
}

function parseOptions(argv, allowed, required) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(option) || value === undefined || Object.hasOwn(values, option.slice(2))) {
      fail("checkpoint_evidence_cli_invalid");
    }
    values[option.slice(2)] = value;
  }
  if (required.some(name => !values[name])) fail("checkpoint_evidence_cli_invalid");
  return values;
}

function classifyPodsCommand(options, nextAction = false) {
  const podList = privateJsonFile(options.pods, "runner_pod_list_file_invalid").value;
  const value = nextAction ? nextRunnerPodAction(podList) : classifyRunnerPodList(podList);
  writePrivateCanonicalJson(options.output, value);
}

function safeErrorCode(error) {
  const message = error instanceof Error ? error.message : "unexpected_error";
  return /^[a-z0-9_]+(?::[a-z0-9_]+)*$/.test(message) ? message : "unexpected_error";
}

function main() {
  const [command, ...argv] = process.argv.slice(2);
  try {
    if (command === "capture") {
      captureCommand(parseOptions(
        argv,
        new Set([
          "--manifest",
          "--values",
          "--inventory",
          "--output",
          "--recovery-operation-fence-state"
        ]),
        ["values", "inventory", "output", "recovery-operation-fence-state"]
      ));
      return;
    }
    if (command === "verify") {
      verifyCommand(parseOptions(
        argv,
        new Set([
          "--manifest",
          "--values",
          "--inventory",
          "--evidence",
          "--live-mode",
          "--checkpoint-operation-id",
          "--recovery-operation-fence-state"
        ]),
        ["values", "inventory", "evidence", "recovery-operation-fence-state"]
      ));
      return;
    }
    if (command === "validate") {
      validateCommand(parseOptions(
        argv,
        new Set(["--inventory", "--evidence"]),
        ["inventory", "evidence"]
      ));
      return;
    }
    if (command === "validate-evidence") {
      validateEvidenceCommand(parseOptions(
        argv,
        new Set(["--evidence"]),
        ["evidence"]
      ));
      return;
    }
    if (command === "classify-pods" || command === "next-action") {
      classifyPodsCommand(
        parseOptions(argv, new Set(["--pods", "--output"]), ["pods", "output"]),
        command === "next-action"
      );
      return;
    }
    fail("checkpoint_evidence_cli_invalid");
  } catch (error) {
    process.stderr.write(
      `runner_cutover_checkpoint_evidence_failed:${safeErrorCode(error)}\n`
    );
    process.exitCode = 1;
  }
}

export {
  EVIDENCE_SCHEMA_VERSION,
  PAIR_DEFINITIONS,
  PARENT_RESOURCE_DEFINITIONS,
  captureStableCore,
  canonicalEvidenceFile,
  environmentInputs,
  evidenceEnvelope,
  manifestContract,
  manifestContractFromSnapshot,
  validateEvidenceEnvelope,
  writePrivateCanonicalJson
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

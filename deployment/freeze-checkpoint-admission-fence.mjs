#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const NAME = "freeze-checkpoint-pod-create-fence.yenhubs.org";
const OWNER = "freeze-checkpoint";

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return object(value) && Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}

function text(value, pattern) {
  return typeof value === "string" && pattern.test(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function validateInputs(input) {
  if (!exactKeys(input, [
    "namespace", "namespace_uid", "operation_id", "lock_uid", "lock_resource_version",
    "lease_uid", "lease_holder", "helper_image"
  ])) fail("input_shape");
  if (!text(input.namespace, /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/) ||
      !text(input.namespace_uid, /^[A-Za-z0-9._:-]+$/) ||
      !text(input.operation_id, /^[a-f0-9]{32}$/) ||
      !text(input.lock_uid, /^[A-Za-z0-9._:-]+$/) ||
      !text(input.lock_resource_version, /^[A-Za-z0-9._:-]+$/) ||
      !text(input.lease_uid, /^[A-Za-z0-9._:-]+$/) ||
      !text(input.lease_holder, /^[A-Za-z0-9._:-]+$/) ||
      !text(input.helper_image, /^[^\s@]+@sha256:[a-f0-9]{64}$/)) fail("input_value");
  return input;
}

function metadata(input) {
  return {
    name: NAME,
    labels: { "yenhubs.org/recovery-owner": OWNER },
    annotations: {
      "yenhubs.org/namespace-uid": input.namespace_uid,
      "yenhubs.org/operation-id": input.operation_id,
      "yenhubs.org/operation-lock-uid": input.lock_uid,
      "yenhubs.org/operation-lock-resource-version": input.lock_resource_version,
      "yenhubs.org/serialization-lease-uid": input.lease_uid,
      "yenhubs.org/serialization-lease-holder": input.lease_holder,
      "yenhubs.org/helper-image-sha256": digest(input.helper_image)
    }
  };
}

function helperExpression(input) {
  const labels = `object.metadata.labels.size() == 2 && object.metadata.labels['yenhubs.org/recovery-owner'] == 'ret-storage-backup' && object.metadata.labels['yenhubs.org/operation-id'] == '${input.operation_id}'`;
  const annotations = `object.metadata.annotations.size() == 2 && object.metadata.annotations['yenhubs.org/operation-lock-uid'] == '${input.lock_uid}' && object.metadata.annotations['yenhubs.org/operation-id'] == '${input.operation_id}'`;
  return [
    "request.operation == 'CREATE'",
    `object.metadata.namespace == '${input.namespace}'`,
    `object.metadata.name == 'ret-storage-backup-${input.operation_id.slice(0, 12)}'`,
    labels, annotations,
    "!has(object.metadata.ownerReferences) || object.metadata.ownerReferences.size() == 0",
    "!has(object.metadata.finalizers) || object.metadata.finalizers.size() == 0",
    "object.spec.automountServiceAccountToken == false",
    "object.spec.enableServiceLinks == false",
    "object.spec.restartPolicy == 'Never'",
    "object.spec.terminationGracePeriodSeconds == 1",
    "object.spec.activeDeadlineSeconds == 3600",
    "!has(object.spec.hostNetwork) || object.spec.hostNetwork == false",
    "!has(object.spec.hostPID) || object.spec.hostPID == false",
    "!has(object.spec.hostIPC) || object.spec.hostIPC == false",
    "!has(object.spec.shareProcessNamespace) || object.spec.shareProcessNamespace == false",
    "!has(object.spec.initContainers) || object.spec.initContainers.size() == 0",
    "!has(object.spec.ephemeralContainers) || object.spec.ephemeralContainers.size() == 0",
    "object.spec.containers.size() == 1",
    "object.spec.containers[0].name == 'helper'",
    `object.spec.containers[0].image == '${input.helper_image}'`,
    "object.spec.containers[0].command == ['sh', '-c', 'sleep 3600']",
    "!has(object.spec.containers[0].args) || object.spec.containers[0].args.size() == 0",
    "!has(object.spec.containers[0].env) || object.spec.containers[0].env.size() == 0",
    "!has(object.spec.containers[0].envFrom) || object.spec.containers[0].envFrom.size() == 0",
    "!has(object.spec.containers[0].ports) || object.spec.containers[0].ports.size() == 0",
    "!has(object.spec.containers[0].lifecycle)",
    "object.spec.containers[0].securityContext.allowPrivilegeEscalation == false",
    "!has(object.spec.containers[0].securityContext.privileged) || object.spec.containers[0].securityContext.privileged == false",
    "object.spec.containers[0].securityContext.readOnlyRootFilesystem == true",
    "object.spec.containers[0].securityContext.capabilities.drop == ['ALL']",
    "!has(object.spec.containers[0].securityContext.capabilities.add) || object.spec.containers[0].securityContext.capabilities.add.size() == 0",
    "!has(object.spec.containers[0].securityContext.procMount) || object.spec.containers[0].securityContext.procMount == 'Default'",
    "!has(object.spec.containers[0].volumeDevices) || object.spec.containers[0].volumeDevices.size() == 0",
    "object.spec.volumes.size() == 1",
    "object.spec.volumes[0].name == 'storage'",
    "object.spec.volumes[0].persistentVolumeClaim.claimName == 'ret-pvc'",
    "object.spec.volumes[0].persistentVolumeClaim.readOnly == true",
    "object.spec.containers[0].volumeMounts.size() == 1",
    "object.spec.containers[0].volumeMounts[0].name == 'storage'",
    "object.spec.containers[0].volumeMounts[0].mountPath == '/storage'",
    "object.spec.containers[0].volumeMounts[0].readOnly == true",
    "object.spec.securityContext.runAsNonRoot == true",
    "object.spec.securityContext.runAsUser == 1000",
    "object.spec.securityContext.runAsGroup == 1000",
    "object.spec.securityContext.fsGroup == 1000",
    "object.spec.securityContext.fsGroupChangePolicy == 'OnRootMismatch'",
    "object.spec.securityContext.seccompProfile.type == 'RuntimeDefault'"
  ].map(value => `(${value})`).join(" && ");
}

export function buildHelperPod(inputValue) {
  const input = validateInputs(structuredClone(inputValue));
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: `ret-storage-backup-${input.operation_id.slice(0, 12)}`,
      namespace: input.namespace,
      labels: {
        "yenhubs.org/recovery-owner": "ret-storage-backup",
        "yenhubs.org/operation-id": input.operation_id
      },
      annotations: {
        "yenhubs.org/operation-lock-uid": input.lock_uid,
        "yenhubs.org/operation-id": input.operation_id
      }
    },
    spec: {
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      restartPolicy: "Never",
      terminationGracePeriodSeconds: 1,
      activeDeadlineSeconds: 3600,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        fsGroupChangePolicy: "OnRootMismatch",
        seccompProfile: { type: "RuntimeDefault" }
      },
      containers: [{
        name: "helper",
        image: input.helper_image,
        command: ["sh", "-c", "sleep 3600"],
        securityContext: {
          allowPrivilegeEscalation: false,
          readOnlyRootFilesystem: true,
          capabilities: { drop: ["ALL"] }
        },
        volumeMounts: [{ name: "storage", mountPath: "/storage", readOnly: true }]
      }],
      volumes: [{
        name: "storage",
        persistentVolumeClaim: { claimName: "ret-pvc", readOnly: true }
      }]
    }
  };
}

export function helperRequestIsAllowed(inputValue, request) {
  const input = validateInputs(structuredClone(inputValue));
  if (!object(request) || request.operation !== "CREATE" ||
      request.resource !== "pods" ||
      (request.subResource !== undefined && request.subResource !== "") ||
      !object(request.object)) return false;
  const pod = request.object;
  const expected = buildHelperPod(input);
  const metadata = pod.metadata;
  const spec = pod.spec;
  const container = spec?.containers?.[0];
  return pod.apiVersion === "v1" && pod.kind === "Pod" && object(metadata) &&
    metadata.name === expected.metadata.name && metadata.namespace === input.namespace &&
    JSON.stringify(canonical(metadata.labels)) === JSON.stringify(canonical(expected.metadata.labels)) &&
    JSON.stringify(canonical(metadata.annotations)) ===
      JSON.stringify(canonical(expected.metadata.annotations)) &&
    (metadata.ownerReferences === undefined || metadata.ownerReferences.length === 0) &&
    (metadata.finalizers === undefined || metadata.finalizers.length === 0) &&
    object(spec) && spec.automountServiceAccountToken === false &&
    spec.enableServiceLinks === false && spec.restartPolicy === "Never" &&
    spec.terminationGracePeriodSeconds === 1 &&
    spec.activeDeadlineSeconds === 3600 &&
    ["hostNetwork", "hostPID", "hostIPC", "shareProcessNamespace"]
      .every(key => spec[key] === undefined || spec[key] === false) &&
    (spec.initContainers === undefined || spec.initContainers.length === 0) &&
    (spec.ephemeralContainers === undefined || spec.ephemeralContainers.length === 0) &&
    Array.isArray(spec.containers) && spec.containers.length === 1 &&
    container?.name === "helper" && container.image === input.helper_image &&
    JSON.stringify(container.command) === JSON.stringify(["sh", "-c", "sleep 3600"]) &&
    ["args", "env", "envFrom", "ports", "volumeDevices"]
      .every(key => container[key] === undefined || container[key].length === 0) &&
    container.lifecycle === undefined &&
    container.securityContext?.allowPrivilegeEscalation === false &&
    (container.securityContext?.privileged === undefined ||
      container.securityContext.privileged === false) &&
    container.securityContext?.readOnlyRootFilesystem === true &&
    JSON.stringify(container.securityContext?.capabilities?.drop) === JSON.stringify(["ALL"]) &&
    (container.securityContext?.capabilities?.add === undefined ||
      container.securityContext.capabilities.add.length === 0) &&
    (container.securityContext?.procMount === undefined ||
      container.securityContext.procMount === "Default") &&
    JSON.stringify(container.volumeMounts) ===
      JSON.stringify([{ name: "storage", mountPath: "/storage", readOnly: true }]) &&
    JSON.stringify(spec.volumes) === JSON.stringify([{
      name: "storage", persistentVolumeClaim: { claimName: "ret-pvc", readOnly: true }
    }]) &&
    spec.securityContext?.runAsNonRoot === true &&
    spec.securityContext?.runAsUser === 1000 && spec.securityContext?.runAsGroup === 1000 &&
    spec.securityContext?.fsGroup === 1000 &&
    spec.securityContext?.fsGroupChangePolicy === "OnRootMismatch" &&
    spec.securityContext?.seccompProfile?.type === "RuntimeDefault";
}

export function build(inputValue) {
  const input = validateInputs(structuredClone(inputValue));
  const common = metadata(input);
  return {
    policy: {
      apiVersion: "admissionregistration.k8s.io/v1",
      kind: "ValidatingAdmissionPolicy",
      metadata: common,
      spec: {
        failurePolicy: "Fail",
        matchConstraints: { resourceRules: [{
          apiGroups: [""], apiVersions: ["v1"], operations: ["CREATE", "UPDATE"],
          resources: ["pods", "pods/ephemeralcontainers"], scope: "Namespaced"
        }] },
        validations: [{
          expression: `request.resource.resource == 'pods' && (!has(request.subResource) || request.subResource == '') && ${helperExpression(input)}`,
          message: "freeze checkpoint Pod fence denies this Pod mutation"
        }]
      }
    },
    binding: {
      apiVersion: "admissionregistration.k8s.io/v1",
      kind: "ValidatingAdmissionPolicyBinding",
      metadata: structuredClone(common),
      spec: {
        policyName: NAME,
        validationActions: ["Deny"],
        matchResources: { namespaceSelector: { matchLabels: {
          "kubernetes.io/metadata.name": input.namespace
        } } }
      }
    }
  };
}

function scrubServerResponse(value, kind) {
  const copy = structuredClone(value);
  const metadataKeys = ["creationTimestamp", "generation", "managedFields", "resourceVersion", "uid"];
  for (const key of metadataKeys) delete copy.metadata?.[key];
  delete copy.status;
  if (kind === "policy") {
    const constraints = copy.spec?.matchConstraints;
    if (constraints?.matchPolicy === "Equivalent") delete constraints.matchPolicy;
    for (const key of ["namespaceSelector", "objectSelector"]) {
      if (object(constraints?.[key]) && Object.keys(constraints[key]).length === 0) {
        delete constraints[key];
      }
    }
    if (copy.spec?.paramKind === null) delete copy.spec.paramKind;
    if (Array.isArray(copy.spec?.validations)) {
      for (const validation of copy.spec.validations) {
        if (object(validation) && validation.reason === null) delete validation.reason;
      }
    }
  } else if (kind === "binding") {
    const resources = copy.spec?.matchResources;
    if (resources?.matchPolicy === "Equivalent") delete resources.matchPolicy;
    if (object(resources?.objectSelector) &&
        Object.keys(resources.objectSelector).length === 0) {
      delete resources.objectSelector;
    }
  }
  return copy;
}

export function validatePair(pair, inputValue, requireIdentity = false) {
  const expected = build(inputValue);
  if (!exactKeys(pair, ["policy", "binding"])) fail("pair_shape");
  for (const key of ["policy", "binding"]) {
    const actual = pair[key];
    if (!object(actual) || JSON.stringify(canonical(scrubServerResponse(actual, key))) !==
        JSON.stringify(canonical(expected[key]))) fail(`${key}_contract`);
    if (requireIdentity && (!text(actual.metadata?.uid, /^[A-Za-z0-9._:-]+$/) ||
        !text(actual.metadata?.resourceVersion, /^[A-Za-z0-9._:-]+$/))) fail(`${key}_identity`);
    if (actual.metadata?.deletionTimestamp !== undefined) fail(`${key}_terminating`);
  }
  if (requireIdentity && pair.policy.status?.observedGeneration !== pair.policy.metadata.generation) {
    fail("policy_unobserved");
  }
  return true;
}

export function validateObject(kind, actual, inputValue, requireIdentity = false, requireObserved = false) {
  if (!new Set(["policy", "binding"]).has(kind)) fail("object_kind");
  const expected = build(inputValue)[kind];
  if (!object(actual) || JSON.stringify(canonical(scrubServerResponse(actual, kind))) !==
      JSON.stringify(canonical(expected))) fail(`${kind}_contract`);
  if (requireIdentity && (!text(actual.metadata?.uid, /^[A-Za-z0-9._:-]+$/) ||
      !text(actual.metadata?.resourceVersion, /^[A-Za-z0-9._:-]+$/))) fail(`${kind}_identity`);
  if (actual.metadata?.deletionTimestamp !== undefined) fail(`${kind}_terminating`);
  if (kind === "policy" && requireObserved &&
      actual.status?.observedGeneration !== actual.metadata?.generation) fail("policy_unobserved");
  return true;
}

function readStdin() {
  return JSON.parse(readFileSync(0, "utf8"));
}

function main() {
  const [command] = process.argv.slice(2);
  const value = readStdin();
  if (command === "build") process.stdout.write(`${JSON.stringify(build(value))}\n`);
  else if (command === "validate") {
    validatePair(value.pair, value.input, value.require_identity === true);
    process.stdout.write("ok\n");
  } else if (command === "validate-policy" || command === "validate-binding") {
    validateObject(command.slice(9), value.object, value.input,
      value.require_identity === true, value.require_observed === true);
    process.stdout.write("ok\n");
  } else fail("command");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (error) {
    process.stderr.write(`${error?.code || "failed"}\n`);
    process.exitCode = 1;
  }
}

export { NAME };

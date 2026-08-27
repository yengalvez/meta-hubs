import assert from "node:assert/strict";
import test from "node:test";

import {
  NAME, build, buildHelperPod, helperRequestIsAllowed, validateObject, validatePair
} from "../../deployment/freeze-checkpoint-admission-fence.mjs";

const input = {
  namespace: "hcce",
  namespace_uid: "namespace-uid",
  operation_id: "0123456789abcdef0123456789abcdef",
  lock_uid: "lock-uid",
  lock_resource_version: "lock-rv-1",
  lease_uid: "lease-uid",
  lease_holder: "holder-1",
  helper_image: `docker.io/mozillareality/postgrest@sha256:${"a".repeat(64)}`
};

function admitted(pair) {
  const value = structuredClone(pair);
  for (const [key, uid] of [["policy", "policy-uid"], ["binding", "binding-uid"]]) {
    value[key].metadata.uid = uid;
    value[key].metadata.resourceVersion = `${key}-rv-1`;
    value[key].metadata.generation = 1;
  }
  value.policy.status = { observedGeneration: 1 };
  return value;
}

test("builds one exact fail-closed namespace-scoped pair", () => {
  const pair = build(input);
  assert.equal(pair.policy.metadata.name, NAME);
  assert.equal(pair.binding.metadata.name, NAME);
  assert.equal(pair.policy.spec.failurePolicy, "Fail");
  assert.deepEqual(pair.policy.spec.matchConstraints.resourceRules[0].operations,
    ["CREATE", "UPDATE"]);
  assert.deepEqual(pair.policy.spec.matchConstraints.resourceRules[0].resources,
    ["pods", "pods/ephemeralcontainers"]);
  assert.deepEqual(pair.binding.spec.validationActions, ["Deny"]);
  assert.deepEqual(pair.binding.spec.matchResources.namespaceSelector.matchLabels,
    { "kubernetes.io/metadata.name": "hcce" });
});

test("the sole create exception is operation-bound and structurally read-only", () => {
  const expression = build(input).policy.spec.validations[0].expression;
  for (const fragment of [
    "request.operation == 'CREATE'", "request.subResource == ''",
    "ret-storage-backup-0123456789ab", input.helper_image,
    "automountServiceAccountToken == false", "containers.size() == 1",
    "initContainers.size() == 0", "ephemeralContainers.size() == 0",
    "persistentVolumeClaim.readOnly == true", "volumeMounts[0].readOnly == true",
    "readOnlyRootFilesystem == true", "capabilities.drop == ['ALL']"
  ]) assert.match(expression, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("request validator denies generic, helper variants and ephemeral updates", () => {
  const helper = buildHelperPod(input);
  const request = { operation: "CREATE", resource: "pods", subResource: "", object: helper };
  assert.equal(helperRequestIsAllowed(input, request), true);
  const omittedSubresource = structuredClone(request);
  delete omittedSubresource.subResource;
  assert.equal(helperRequestIsAllowed(input, omittedSubresource), true);
  const realSubresource = structuredClone(request);
  realSubresource.subResource = "ephemeralcontainers";
  assert.equal(helperRequestIsAllowed(input, realSubresource), false);
  const generic = structuredClone(request);
  generic.object.metadata.name = "generic";
  assert.equal(helperRequestIsAllowed(input, generic), false);
  for (const mutation of [
    pod => { pod.spec.containers.push(structuredClone(pod.spec.containers[0])); },
    pod => { pod.spec.initContainers = [structuredClone(pod.spec.containers[0])]; },
    pod => { pod.spec.ephemeralContainers = [structuredClone(pod.spec.containers[0])]; },
    pod => { pod.spec.containers[0].image = `example.invalid/helper@sha256:${"b".repeat(64)}`; },
    pod => { pod.spec.containers[0].volumeMounts[0].readOnly = false; },
    pod => { pod.spec.volumes[0].persistentVolumeClaim.readOnly = false; }
  ]) {
    const variant = structuredClone(request);
    mutation(variant.object);
    assert.equal(helperRequestIsAllowed(input, variant), false);
  }
  const ephemeral = structuredClone(request);
  ephemeral.operation = "UPDATE";
  ephemeral.subResource = "ephemeralcontainers";
  assert.equal(helperRequestIsAllowed(input, ephemeral), false);
});

test("the admission contract denies base Pod and ephemeralcontainers updates", () => {
  const pair = build(input);
  const rule = pair.policy.spec.matchConstraints.resourceRules[0];
  assert.ok(rule.operations.includes("UPDATE"));
  assert.deepEqual(rule.resources, ["pods", "pods/ephemeralcontainers"]);
  for (const subResource of ["", "ephemeralcontainers"]) {
    const request = {
      operation: "UPDATE", resource: "pods", subResource,
      object: buildHelperPod(input)
    };
    assert.equal(helperRequestIsAllowed(input, request), false);
  }
});

test("validates admitted identities and observed policy generation", () => {
  const pair = admitted(build(input));
  assert.equal(validatePair(pair, input, true), true);
  assert.equal(validateObject("policy", pair.policy, input, true, true), true);
});

test("accepts only the observed Kubernetes policy server defaults", () => {
  const pair = admitted(build(input));
  Object.assign(pair.policy.spec.matchConstraints, {
    matchPolicy: "Equivalent", namespaceSelector: {}, objectSelector: {}
  });
  pair.policy.spec.paramKind = null;
  pair.policy.spec.validations[0].reason = null;
  assert.equal(validatePair(pair, input, true), true);
  assert.equal(validateObject("policy", pair.policy, input, true, true), true);
});

for (const [name, mutate] of [
  ["matchPolicy Exact", policy => { policy.spec.matchConstraints.matchPolicy = "Exact"; }],
  ["nonempty namespaceSelector", policy => {
    policy.spec.matchConstraints.namespaceSelector = { matchLabels: { fixture: "true" } };
  }],
  ["nonempty objectSelector", policy => {
    policy.spec.matchConstraints.objectSelector = { matchLabels: { fixture: "true" } };
  }],
  ["nonnull paramKind", policy => {
    policy.spec.paramKind = { apiVersion: "v1", kind: "ConfigMap" };
  }],
  ["nonnull validation reason", policy => {
    policy.spec.validations[0].reason = "Invalid";
  }]
]) {
  test(`rejects server policy alternative: ${name}`, () => {
    const pair = admitted(build(input));
    mutate(pair.policy);
    assert.throws(() => validateObject("policy", pair.policy, input, true, true));
  });
}

test("accepts only the observed Kubernetes binding server defaults", () => {
  const pair = admitted(build(input));
  Object.assign(pair.binding.spec.matchResources, {
    matchPolicy: "Equivalent", objectSelector: {}
  });
  assert.equal(validatePair(pair, input, true), true);
  assert.equal(validateObject("binding", pair.binding, input, true, false), true);
});

test("rejects nondefault binding response values", () => {
  const exact = admitted(build(input));
  exact.binding.spec.matchResources.matchPolicy = "Exact";
  assert.throws(() => validateObject("binding", exact.binding, input, true, false));
  const selected = admitted(build(input));
  selected.binding.spec.matchResources.objectSelector = {
    matchLabels: { fixture: "true" }
  };
  assert.throws(() => validateObject("binding", selected.binding, input, true, false));
});

test("keeps unobserved binding response fields strict", () => {
  const pair = admitted(build(input));
  pair.binding.spec.matchResources.namespaceSelector.matchExpressions = [];
  assert.throws(() => validateObject("binding", pair.binding, input, true, false));
});

test("rejects helper-image, namespace and lock drift", () => {
  for (const mutation of [
    pair => { pair.policy.spec.validations[0].expression += " "; },
    pair => { pair.binding.spec.matchResources.namespaceSelector.matchLabels[
      "kubernetes.io/metadata.name"] = "hcce-other"; },
    pair => { pair.policy.metadata.annotations["yenhubs.org/operation-lock-uid"] = "other"; }
  ]) {
    const pair = admitted(build(input));
    mutation(pair);
    assert.throws(() => validatePair(pair, input, true));
  }
});

test("rejects terminating, ABA and unobserved objects", () => {
  const terminating = admitted(build(input));
  terminating.binding.metadata.deletionTimestamp = "2026-01-01T00:00:00Z";
  assert.throws(() => validatePair(terminating, input, true));
  const aba = admitted(build(input));
  aba.policy.metadata.uid = "replacement-uid";
  const expected = admitted(build(input));
  assert.notEqual(aba.policy.metadata.uid, expected.policy.metadata.uid);
  const unobserved = admitted(build(input));
  unobserved.policy.status.observedGeneration = 0;
  assert.throws(() => validateObject("policy", unobserved.policy, input, true, true));
});

test("rejects invalid or unpinned inputs", () => {
  for (const mutation of [
    value => { value.helper_image = "example.invalid/helper:latest"; },
    value => { value.operation_id = "short"; },
    value => { value.extra = true; }
  ]) {
    const value = structuredClone(input);
    mutation(value);
    assert.throws(() => build(value));
  }
});

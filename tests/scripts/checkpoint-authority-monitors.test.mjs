import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AUTHORITY_HMAC_PROFILE, AUTHORITY_HMAC_PROFILE_V2, canonicalJsonV1,
  createCheckpointBackupAuthority, createCheckpointBackupAuthorityV2, createKeyRecord
} from "../../deployment/recovery-checkpoint-authority.mjs";
import {
  authenticateSignedDeployments, deploymentIdentity, exactArguments as writerArguments,
  validateBaseline, validateConsumerContract, validateDeploymentObject, validateOperationLockObject,
  validateMonitorAuthority as validateWriterAuthority
} from "../../deployment/watch-checkpoint-writers.mjs";
import {
  authenticateControlBackupResources, completeDeploymentList, exactArguments as durableArguments,
  parseControlBaseline, signedControlOptions, validateControlOperationLock,
  monitorCapabilitySha256, validateMonitorAuthority as validateDurableAuthority
} from "../../deployment/watch-durable-runner-quiescence.mjs";

const names = ["bot-orchestrator", "coturn", "pgbouncer", "pgbouncer-t", "reticulum"];
const allNames = ["bot-orchestrator", "coturn", "dialog", "haproxy", "hubs", "nearspark",
  "pgbouncer", "pgbouncer-t", "pgsql", "photomnemonic", "reticulum", "spoke"];
const keyId = "12345678-1234-4abc-8def-1234567890ab";
const operationId = "a".repeat(32);
const privateSentinel = "PRIVATE-SPEC-SENTINEL-NOT-A-REAL-SECRET";
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const clone = value => structuredClone(value);

function deployment(name, generation = 4, resourceVersion = `initial-${name}`) {
  return {
    apiVersion: "apps/v1", kind: "Deployment",
    metadata: { name, namespace: "hcce", uid: `uid-${name}`, generation, resourceVersion,
      labels: { app: name }, annotations: { static: "fixed" } },
    spec: {
      replicas: 0, selector: { matchLabels: { app: name } }, strategy: { type: "RollingUpdate" },
      template: { metadata: { labels: { app: name }, annotations: { private: privateSentinel } },
        spec: { containers: [{ name, image: `example.invalid/${name}@sha256:${"1".repeat(64)}`,
          env: [{ name: "SYNTHETIC_PRIVATE_INPUT", value: privateSentinel }] }] } }
    }
  };
}

function fixture(t, { version = 2, replicas = [0, 0, 0, 0, 0] } = {}) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "yenhubs-monitor-authority-"));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const keyringPath = path.join(directory, "synthetic-keyring");
  fs.mkdirSync(keyringPath, { mode: 0o700 });
  const keyRecord = createKeyRecord({ keyId, keyBytes: Buffer.alloc(32, 0x37) });
  fs.writeFileSync(path.join(keyringPath, `${keyId}.json`), canonicalJsonV1(keyRecord), { mode: 0o600 });
  const fence = {
    namespaces: {
      parent: { name: "hcce", uid: "namespace-uid", resource_version: "namespace-rv",
        phase: "Active", metadata_name_label: "hcce" },
      runner: { name: "hcce-bot-runners", uid: "runner-uid", resource_version: "runner-rv",
        phase: "Active", metadata_name_label: "hcce-bot-runners" }
    },
    policy: { uid: "policy-uid", resource_version: "policy-rv", generation: 3, spec_sha256: "2".repeat(64) },
    binding: { uid: "binding-uid", resource_version: "active-binding-rv", spec_sha256: "3".repeat(64) }
  };
  const publicAuthority = {
    schema_version: version, operation_id: operationId,
    namespace: { name: "hcce", uid: "namespace-uid" }, pvc: { name: "ret-pvc", uid: "pvc-uid" },
    hmac_profile: version === 1 ? AUTHORITY_HMAC_PROFILE : AUTHORITY_HMAC_PROFILE_V2,
    hmac_key_id: keyId, runner_generation: "durable-v2",
    operation_fence: {
      state: "dormant",
      namespaces: Object.fromEntries(Object.entries(fence.namespaces).map(([name, value]) =>
        [name, { name: value.name, uid: value.uid, initial_resource_version: value.resource_version,
          phase: value.phase, metadata_name_label: value.metadata_name_label }])),
      policy: { uid: "policy-uid", initial_resource_version: "policy-rv", initial_generation: 3,
        spec_sha256: "2".repeat(64) },
      binding: { uid: "binding-uid", initial_resource_version: "dormant-binding-rv",
        dormant_spec_sha256: "4".repeat(64), active_spec_sha256: "3".repeat(64) }
    },
    consumers: names.map((name, index) => ({ name, uid: `uid-${name}`,
      initial_resource_version: `initial-${name}`, initial_generation: 4,
      original_replicas: replicas[index], selector: name }))
  };
  const deployments = allNames.map(name => {
    const index = names.indexOf(name);
    return deployment(name, 4 + (index !== -1 && replicas[index] > 0 ? 1 : 0),
      index !== -1 && replicas[index] > 0 ? `paused-${name}` : `initial-${name}`);
  });
  const deploymentContracts = names.map(name => {
    const value = deployments.find(item => item.metadata.name === name);
    const spec = clone(value.spec); delete spec.replicas;
    return { api_version: "apps/v1", kind: "Deployment", namespace: "hcce", name,
      uid: value.metadata.uid, spec_without_replicas: spec };
  });
  const lockBinding = { name: "yenhubs-recovery-operation-lock", namespace: "hcce",
    owner: "checkpoint-backup", operation_id: operationId, recovery_token: "b".repeat(32),
    namespace_uid: "namespace-uid", pvc_uid: "pvc-uid", checkpoint_stamp: "20261003-120000",
    dump_sha256: "0".repeat(64), storage_sha256: "0".repeat(64) };
  const authority = version === 1
    ? createCheckpointBackupAuthority({ keyRecord, publicAuthority, lockBinding, deploymentContracts })
    : createCheckpointBackupAuthorityV2({ keyringPath, keyId, publicAuthority, lockBinding, deploymentContracts });
  const authorityText = canonicalJsonV1(authority);
  const consumerContract = { schema_version: version === 1 ? 2 : 3,
    operation_id: operationId, authority_sha256: digest(authorityText), consumers: clone(authority.consumers) };
  const lock = { apiVersion: "v1", kind: "ConfigMap", immutable: true,
    metadata: { name: lockBinding.name, namespace: "hcce", uid: "lock-uid", resourceVersion: "lock-rv",
      labels: { "yenhubs.org/recovery-owner": "checkpoint-backup" }, annotations: {
        "yenhubs.org/operation-id": operationId, "yenhubs.org/recovery-token": lockBinding.recovery_token,
        "yenhubs.org/namespace-uid": "namespace-uid", "yenhubs.org/pvc-uid": "pvc-uid",
        "yenhubs.org/checkpoint-stamp": lockBinding.checkpoint_stamp,
        "yenhubs.org/dump-sha256": lockBinding.dump_sha256, "yenhubs.org/storage-sha256": lockBinding.storage_sha256
      } }, data: { "checkpoint-backup-authority.json": authorityText } };
  const baseline = {
    schema_version: 4, backup_authority: authorityText, runtime_generation: "durable-v2",
    recovery_operation_fence: fence, operation_id: operationId, operation_owner: "checkpoint-backup",
    operation_lock: { name: lockBinding.name, uid: "lock-uid", resource_version: "lock-rv" },
    context: "fixture-context", namespace: "hcce", namespace_uid: "namespace-uid",
    lease: { name: "yenhubs-operation-serialization", uid: "lease-uid",
      holder: "root-recovery:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      acquire_time: "2026-10-03T12:00:00Z", lease_transitions: 0 },
    storage_helper: { name: `ret-storage-backup-${operationId.slice(0, 12)}`,
      image: deployments.find(value => value.metadata.name === "reticulum").spec.template.spec.containers[0].image },
    consumers: clone(authority.consumers), deployments: deployments.map(value => deploymentIdentity(value, true)),
    replica_sets: deployments.map(value => ({ name: `rs-${value.metadata.name}`, uid: `rs-uid-${value.metadata.name}`,
      resource_version: "rs-rv", generation: 1, replicas: 0,
      owner: { name: value.metadata.name, uid: value.metadata.uid }, selector: value.metadata.name,
      fingerprint: "5".repeat(64), template_fingerprint: "6".repeat(64), metadata_fingerprint: "7".repeat(64)
    })).sort((left, right) => left.name.localeCompare(right.name)),
    pods: [], boundaries: { deployments: "list-d-rv", replicasets: "list-r-rv", pods: "list-p-rv" }
  };
  const options = { namespace: "hcce", namespaceUid: "namespace-uid", operationId,
    operationOwner: "checkpoint-backup", runtimeGeneration: "durable-v2", lockName: lockBinding.name,
    lockUid: "lock-uid", lockResourceVersion: "lock-rv", backupAuthorityKeyring: keyringPath,
    backupAuthorityKeyId: keyId, baseline, consumerContract };
  return { directory, keyringPath, authority, authorityText, consumerContract, deployments, lock, baseline, options };
}

function validateProjection(value, contract) {
  const source = `${JSON.stringify(value)}\n`;
  return validateBaseline(source, digest(source), "fixture-context", "hcce", "namespace-uid", contract,
    "durable-v2", "checkpoint-backup", value.operation_lock, "yenhubs-operation-serialization");
}

test("signed writer and durable authenticate authority2 positive, BASE-zero and mixed phases", t => {
  for (const replicas of [[1, 2, 1, 1, 1], [0, 0, 0, 0, 0], [0, 2, 0, 1, 0]]) {
    const value = fixture(t, { replicas });
    const material = validateOperationLockObject(value.lock, value.options);
    assert.equal(authenticateSignedDeployments(material, value.deployments, value.consumerContract, value.options), value.authorityText);
    assert.doesNotThrow(() => authenticateControlBackupResources(value.lock, value.deployments, value.baseline, value.options));
    assert.deepEqual(validateProjection(value.baseline, value.consumerContract), value.baseline);
    const source = `${JSON.stringify(value.baseline)}\n`;
    assert.deepEqual(parseControlBaseline(source, digest(source), "fixture-context", "hcce", "hcce-bot-runners"), value.baseline);
  }
});

test("authority1 only pairs with consumer2; authority2 only pairs with consumer3", t => {
  for (const version of [1, 2]) {
    const value = fixture(t, { version, replicas: [1, 1, 1, 1, 1] });
    const material = validateOperationLockObject(value.lock, value.options);
    assert.doesNotThrow(() => authenticateSignedDeployments(material, value.deployments, value.consumerContract, value.options));
    for (const schema_version of [1, 2, 3, 4].filter(schema => schema !== value.consumerContract.schema_version)) {
      assert.throws(() => authenticateSignedDeployments(material, value.deployments,
        { ...value.consumerContract, schema_version }, value.options));
    }
  }
});

test("signed route rejects modified HMAC, fullspec, generation, zero RV and public digest", t => {
  const value = fixture(t);
  for (const mutate of [
    item => { item.lock.data["checkpoint-backup-authority.json"] = canonicalJsonV1({ ...item.authority, authority_hmac_sha256: "0".repeat(64) }); },
    item => { item.deployments[0].spec.template.spec.containers[0].env[0].value = "tampered"; },
    item => { item.deployments[0].metadata.generation += 1; },
    item => { item.deployments[0].metadata.resourceVersion = "later-zero-rv"; },
    item => { item.consumerContract.authority_sha256 = "f".repeat(64); },
    item => { item.consumerContract.consumers[0].initial_generation += 1; }
  ]) {
    const item = clone(value); mutate(item);
    const options = { ...item.options, baseline: { ...item.baseline, backup_authority: item.lock.data["checkpoint-backup-authority.json"] } };
    assert.throws(() => authenticateSignedDeployments(validateOperationLockObject(item.lock, options),
      item.deployments, item.consumerContract, options));
    // Durable has no external consumer file: its exact pair comes from baseline4.
    if (item.consumerContract.authority_sha256 === value.consumerContract.authority_sha256 &&
        item.consumerContract.consumers[0].initial_generation === value.consumerContract.consumers[0].initial_generation) {
      assert.throws(() => authenticateControlBackupResources(item.lock, item.deployments, options.baseline, options));
    }
  }
  const positive = fixture(t, { replicas: [1, 1, 1, 1, 1] });
  positive.deployments[0].metadata.resourceVersion = "paused-status-rv";
  assert.doesNotThrow(() => authenticateSignedDeployments(validateOperationLockObject(positive.lock, positive.options),
    positive.deployments, positive.consumerContract, positive.options));
  positive.deployments[0].metadata.generation = 4;
  assert.throws(() => authenticateSignedDeployments(validateOperationLockObject(positive.lock, positive.options),
    positive.deployments, positive.consumerContract, positive.options));
});

test("signed lock is exactly one canonical authority value with exact binding annotations", t => {
  const value = fixture(t);
  for (const mutate of [
    lock => { lock.data = {}; },
    lock => { lock.data.extra = "forbidden"; },
    lock => { lock.data["checkpoint-backup-authority.json"] += "\n"; },
    lock => { lock.metadata.annotations.extra = "forbidden"; },
    lock => { lock.metadata.annotations["yenhubs.org/recovery-token"] = "c".repeat(32); },
    lock => { lock.metadata.uid = "other-uid"; },
    lock => { lock.metadata.resourceVersion = "other-rv"; },
    lock => { lock.metadata.finalizers = ["blocked"]; },
    lock => { lock.binaryData = { extra: "AA==" }; }
  ]) {
    const lock = clone(value.lock); mutate(lock);
    assert.throws(() => authenticateSignedDeployments(validateOperationLockObject(lock, value.options),
      value.deployments, value.consumerContract, value.options));
    assert.throws(() => authenticateControlBackupResources(lock, value.deployments, value.baseline, value.options));
  }
});

test("baseline4 fingerprint hashes canonical JSON UTF8 bytes rather than base64 transport", t => {
  const value = fixture(t);
  for (const deployment of value.deployments) {
    const expected = digest(Buffer.from(canonicalJsonV1({
      selector: deployment.spec.selector,
      strategy: deployment.spec.strategy || {},
      template: deployment.spec.template
    }), "utf8"));
    const projection = value.baseline.deployments.find(item => item.name === deployment.metadata.name);
    assert.equal(projection.fingerprint, expected);
  }
});

test("baseline4 projection excludes private body/token and closes every nested consumer/deployment field", t => {
  const value = fixture(t);
  const projection = JSON.stringify(value.baseline);
  assert.equal(projection.includes(privateSentinel), false);
  assert.equal(projection.includes("b".repeat(32)), false);
  assert.equal(projection.includes("spec_without_replicas"), false);
  assert.equal(projection.includes("key_base64"), false);
  assert.equal(projection.includes(Buffer.from(privateSentinel).toString("base64")), false);
  for (const item of value.baseline.deployments) assert.match(item.fingerprint, /^[a-f0-9]{64}$/);
  for (const item of value.baseline.consumers) assert.equal(Object.hasOwn(item, "fingerprint"), false);
  for (const mutate of [
    baseline => { baseline.schema_version = 3; },
    baseline => { baseline.consumers[0].fingerprint = "forbidden"; },
    baseline => { baseline.deployments[0].fingerprint = "reversible-base64"; },
    baseline => { baseline.deployments[0].generation += 1; },
    baseline => { baseline.deployments[0].resource_version = "later-zero-rv"; },
    baseline => { baseline.recovery_operation_fence.binding.spec_sha256 = "f".repeat(64); }
  ]) {
    const baseline = clone(value.baseline); mutate(baseline);
    assert.throws(() => validateProjection(baseline, value.consumerContract));
  }
});

test("historical consumer1/baseline3 and empty-lock reader remain unchanged", t => {
  const value = fixture(t);
  const contract = { schema_version: 1, operation_id: operationId,
    consumers: names.map(name => {
      const original = value.deployments.find(item => item.metadata.name === name);
      return { name, uid: original.metadata.uid, initial_resource_version: original.metadata.resourceVersion,
        original_replicas: 0, selector: name, fingerprint: deploymentIdentity(original).fingerprint };
    }) };
  const contractText = `${JSON.stringify(contract)}\n`;
  assert.deepEqual(validateConsumerContract(contractText, digest(contractText), "hcce"), contract);
  assert.throws(() => validateConsumerContract(contractText, digest(contractText), "hcce", true));
  const baseline = { ...value.baseline, schema_version: 3,
    deployments: value.deployments.map(item => deploymentIdentity(item)),
    consumers: contract.consumers.map(({ name, uid, selector, fingerprint }) => ({ name, uid, selector, fingerprint })) };
  delete baseline.backup_authority;
  assert.deepEqual(validateProjection(baseline, contract), baseline);
  assert.equal(baseline.deployments[0].fingerprint, Buffer.from(JSON.stringify({
    selector: value.deployments[0].spec.selector, strategy: value.deployments[0].spec.strategy,
    template: value.deployments[0].spec.template
  })).toString("base64"));
  assert.equal(Buffer.from(baseline.deployments[0].fingerprint, "base64").toString("utf8").includes(privateSentinel), true);
  const oldOptions = { ...value.options }; delete oldOptions.backupAuthorityKeyring; delete oldOptions.backupAuthorityKeyId;
  const lock = clone(value.lock); delete lock.data;
  assert.equal(validateOperationLockObject(lock, oldOptions), null);
  assert.doesNotThrow(() => validateControlOperationLock(lock,
    { name: lock.metadata.name, expected: baseline.operation_lock, key: "operation_lock" }, baseline));
  assert.throws(() => validateOperationLockObject(value.lock, oldOptions));
  assert.throws(() => validateControlOperationLock(value.lock,
    { name: lock.metadata.name, expected: baseline.operation_lock, key: "operation_lock" }, baseline));
  assert.equal(signedControlOptions(baseline, new Map()), null);
  assert.throws(() => signedControlOptions(baseline, new Map([["--backup-authority-keyring", value.keyringPath], ["--backup-authority-key-id", keyId]])));
});

test("signed metadata/fullspec comparators remain mandatory and zero RV does not advance", t => {
  const value = fixture(t);
  const consumer = value.consumerContract.consumers[0];
  const original = value.deployments[0];
  const expected = value.baseline.deployments[0];
  assert.doesNotThrow(() => validateDeploymentObject(original, "hcce", expected, consumer, false, false, true));
  for (const mutate of [
    item => { item.spec.progressDeadlineSeconds = 90; },
    item => { item.metadata.annotations.static = "changed"; },
    item => { item.metadata.resourceVersion = "status-only-zero-rv"; }
  ]) {
    const item = clone(original); mutate(item);
    assert.throws(() => validateDeploymentObject(item, "hcce", expected, consumer, false, false, true));
  }
});

test("durable signed frontier requires one complete Deployment LIST with no multi-GET fallback", t => {
  const value = fixture(t);
  const list = { apiVersion: "apps/v1", kind: "DeploymentList", metadata: { resourceVersion: "fresh-list-rv" },
    items: clone(value.deployments) };
  for (const item of list.items) { delete item.apiVersion; delete item.kind; }
  const items = completeDeploymentList(list, value.baseline);
  assert.doesNotThrow(() => authenticateControlBackupResources(value.lock, items, value.baseline, value.options));
  for (const mutate of [
    item => { item.metadata.continue = "next-page"; },
    item => { item.metadata.remainingItemCount = 1; },
    item => { item.metadata.resourceVersion = "0"; },
    item => { item.kind = "PodList"; },
    item => { item.items.pop(); },
    item => { item.items[1] = item.items[0]; }
  ]) {
    const bad = clone(list); mutate(bad);
    assert.throws(() => completeDeploymentList(bad, value.baseline));
  }
  const bad = clone(list);
  bad.items.find(item => item.metadata.name === "hubs").spec.progressDeadlineSeconds = 90;
  assert.throws(() => authenticateControlBackupResources(value.lock,
    completeDeploymentList(bad, value.baseline), value.baseline, value.options));
});

test("both CLI parsers require the explicit public-only keyring/key ID pair", t => {
  const value = fixture(t);
  const writer = new Map([
    ["--context", "fixture-context"], ["--namespace", "hcce"], ["--namespace-uid", "namespace-uid"],
    ["--contract", "/fixture/contract"], ["--contract-sha256", "0".repeat(64)], ["--baseline", "/fixture/baseline"],
    ["--operation-lock-name", value.options.lockName], ["--operation-lock-uid", "lock-uid"],
    ["--operation-lock-resource-version", "lock-rv"], ["--operation-owner", "checkpoint-backup"],
    ["--operation-id", operationId], ["--lease-name", "yenhubs-operation-serialization"], ["--lease-uid", "lease-uid"],
    ["--lease-holder", value.baseline.lease.holder], ["--runtime-generation", "durable-v2"],
    ...["stop", "failure", "ready", "progress", "final", "authority"].map(name => [`--${name}`, `/fixture/${name}`])
  ]);
  const durable = new Map([
    ["--context", "fixture-context"], ["--namespace", "hcce"], ["--runner-namespace", "hcce-bot-runners"],
    ["--baseline", "/fixture/baseline"], ["--baseline-sha256", "0".repeat(64)],
    ["--control-baseline", "/fixture/control"], ["--control-baseline-sha256", "0".repeat(64)],
    ...["stop", "failure", "ready", "progress", "final", "authority"].map(name => [`--${name}`, `/fixture/${name}`])
  ]);
  for (const [base, parse, prefix] of [[writer, writerArguments, ["monitor"]], [durable, durableArguments, []]]) {
    assert.doesNotThrow(() => parse([...prefix, ...[...base].flat()]));
    const signed = new Map(base);
    signed.set("--backup-authority-keyring", value.keyringPath); signed.set("--backup-authority-key-id", keyId);
    assert.doesNotThrow(() => parse([...prefix, ...[...signed].flat()]));
    for (const missing of ["--backup-authority-keyring", "--backup-authority-key-id"]) {
      const incomplete = new Map(signed); incomplete.delete(missing);
      assert.throws(() => parse([...prefix, ...[...incomplete].flat()]));
    }
  }
});

test("both signed monitor envelopes bind keyring path and key ID without widening old envelopes", t => {
  const value = fixture(t);
  const authorityPath = path.join(value.directory, "monitor-authority.json");
  const base = new Map([...["authority", "contract", "baseline", "control-baseline", "stop", "failure", "ready", "progress", "final"]
    .map(name => [`--${name}`, name === "authority" ? authorityPath : path.join(value.directory, name)]),
    ["--context", "fixture-context"], ["--namespace", "hcce"], ["--runner-namespace", "hcce-bot-runners"],
    ["--contract-sha256", "0".repeat(64)], ["--baseline-sha256", "1".repeat(64)],
    ["--control-baseline-sha256", "2".repeat(64)]]);
  for (const signed of [false, true]) {
    const values = new Map(base);
    const options = { ...value.options, context: "fixture-context", leaseName: value.baseline.lease.name,
      leaseUid: value.baseline.lease.uid, leaseHolder: value.baseline.lease.holder };
    if (signed) {
      values.set("--backup-authority-keyring", value.keyringPath); values.set("--backup-authority-key-id", keyId);
    } else {
      delete options.backupAuthorityKeyring; delete options.backupAuthorityKeyId;
    }
    const selection = { keyring_path: value.keyringPath, key_id: keyId };
    const common = { schema_version: 1, pid: process.pid, start_identity: "synthetic-process-start",
      context: "fixture-context", namespace: "hcce", namespace_uid: "namespace-uid", operation_id: operationId,
      operation_owner: "checkpoint-backup", runtime_generation: "durable-v2", operation_lock: value.baseline.operation_lock,
      lease: { name: value.baseline.lease.name, uid: value.baseline.lease.uid, holder: value.baseline.lease.holder },
      ...(signed ? { backup_authority: selection } : {}) };
    const writer = { ...common, kind: "checkpoint-writer-monitor", paths: Object.fromEntries(
      ["authority", "contract", "baseline", "stop", "failure", "ready", "progress", "final"]
        .map(name => [name, values.get(`--${name}`)])), hashes: { contract_sha256: values.get("--contract-sha256") } };
    fs.writeFileSync(authorityPath, `${canonicalJsonV1(writer)}\n`, { mode: 0o600 });
    assert.doesNotThrow(() => validateWriterAuthority(values, options));
    const durableBaseline = { sha256: values.get("--baseline-sha256") };
    const capability = { baseline: value.baseline, sha256: values.get("--control-baseline-sha256") };
    const capabilitySha = monitorCapabilitySha256(values, durableBaseline, capability);
    const durable = { ...common, kind: "durable-runner-quiescence-monitor", paths: {
      authority: authorityPath, durable_baseline: values.get("--baseline"), control_baseline: values.get("--control-baseline"),
      ...Object.fromEntries(["stop", "failure", "ready", "progress", "final"].map(name => [name, values.get(`--${name}`)]))
    }, hashes: { durable_baseline_sha256: values.get("--baseline-sha256"),
      control_baseline_sha256: values.get("--control-baseline-sha256"), control_capability_sha256: capabilitySha } };
    fs.writeFileSync(authorityPath, `${canonicalJsonV1(durable)}\n`, { mode: 0o600 });
    assert.doesNotThrow(() => validateDurableAuthority(values, durableBaseline, capability, capabilitySha));
    if (signed) {
      const changed = new Map(values); changed.set("--backup-authority-key-id", "87654321-4321-4abc-8def-1234567890ab");
      assert.throws(() => validateDurableAuthority(changed, durableBaseline, capability, capabilitySha));
      assert.notEqual(monitorCapabilitySha256(changed, durableBaseline, capability), capabilitySha);
      fs.writeFileSync(authorityPath, `${canonicalJsonV1(writer)}\n`, { mode: 0o600 });
      assert.throws(() => validateWriterAuthority(values, { ...options, backupAuthorityKeyring: `${value.keyringPath}-other` }));
    }
  }
});

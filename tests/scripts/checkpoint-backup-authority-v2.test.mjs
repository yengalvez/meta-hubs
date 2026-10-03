import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AUTHORITY_HMAC_PROFILE,
  AUTHORITY_HMAC_PROFILE_V2,
  CHECKPOINT_BACKUP_LOCK_NAME,
  RecoveryCheckpointAuthorityError,
  canonicalJsonV1,
  computeCheckpointBackupAuthorityHmac,
  createCheckpointBackupAuthority,
  createCheckpointBackupAuthorityV2,
  createKeyRecord,
  parseCheckpointBackupAuthority,
  parseCheckpointBackupAuthorityVersioned,
  validateCheckpointBackupAuthority,
  validateCheckpointBackupAuthorityVersioned
} from "../../deployment/recovery-checkpoint-authority.mjs";

const consumerNames = Object.freeze([
  "bot-orchestrator", "coturn", "pgbouncer", "pgbouncer-t", "reticulum"
]);
const keyId = "12345678-1234-4abc-8def-1234567890ab";
const otherKeyId = "87654321-4321-4abc-8def-1234567890ab";

function expectCode(callback, code) {
  assert.throws(callback, error =>
    error instanceof RecoveryCheckpointAuthorityError && error.code === code
  );
}

function fixture(t, { version = 2, replicas = [0, 0, 0, 0, 0], durable = false } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "yenhubs-authority-v2-"));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const keyringPath = path.join(root, "keyring");
  fs.mkdirSync(keyringPath, { mode: 0o700 });
  fs.chmodSync(keyringPath, 0o700);
  const keyBytes = Buffer.alloc(32, 0x5a);
  const keyRecord = createKeyRecord({ keyId, keyBytes });
  const keyPath = path.join(keyringPath, `${keyId}.json`);
  fs.writeFileSync(keyPath, canonicalJsonV1(keyRecord), { mode: 0o600, flag: "wx" });
  fs.chmodSync(keyPath, 0o600);
  const publicAuthority = {
    schema_version: version,
    operation_id: "0123456789abcdef0123456789abcdef",
    namespace: { name: "hcce", uid: "namespace-uid-1" },
    pvc: { name: "ret-pvc", uid: "pvc-uid-1" },
    hmac_profile: version === 1 ? AUTHORITY_HMAC_PROFILE : AUTHORITY_HMAC_PROFILE_V2,
    hmac_key_id: keyId,
    runner_generation: durable ? "durable-v2" : "legacy-absent",
    operation_fence: durable ? {
      state: "dormant",
      namespaces: {
        parent: {
          name: "hcce", uid: "namespace-uid-1", initial_resource_version: "parent-rv",
          phase: "Active", metadata_name_label: "hcce"
        },
        runner: {
          name: "hcce-bot-runners", uid: "runner-namespace-uid",
          initial_resource_version: "runner-rv", phase: "Active",
          metadata_name_label: "hcce-bot-runners"
        }
      },
      policy: {
        uid: "policy-uid", initial_resource_version: "policy-rv",
        initial_generation: 3, spec_sha256: "1".repeat(64)
      },
      binding: {
        uid: "binding-uid", initial_resource_version: "binding-rv",
        dormant_spec_sha256: "2".repeat(64), active_spec_sha256: "3".repeat(64)
      }
    } : null,
    consumers: consumerNames.map((name, index) => ({
      name,
      uid: `${name}-uid`,
      initial_resource_version: `rv-${index + 1}`,
      initial_generation: 10 + index,
      original_replicas: replicas[index],
      selector: name
    }))
  };
  const lockBinding = {
    name: CHECKPOINT_BACKUP_LOCK_NAME,
    namespace: "hcce",
    owner: "checkpoint-backup",
    operation_id: publicAuthority.operation_id,
    recovery_token: "abababababababababababababababab",
    namespace_uid: publicAuthority.namespace.uid,
    pvc_uid: publicAuthority.pvc.uid,
    checkpoint_stamp: "20261003-120000",
    dump_sha256: "0".repeat(64),
    storage_sha256: "0".repeat(64)
  };
  const deploymentContracts = consumerNames.map((name, index) => ({
    api_version: "apps/v1",
    kind: "Deployment",
    namespace: "hcce",
    name,
    uid: publicAuthority.consumers[index].uid,
    spec_without_replicas: {
      selector: { matchLabels: { app: name } },
      strategy: { type: "RollingUpdate" },
      template: {
        metadata: {
          labels: { app: name },
          annotations: { "yenhubs.org/db-credential-checksum": `private-low-entropy-${index}` }
        },
        spec: {
          containers: [{
            name,
            image: `example.invalid/${name}@sha256:${String(index).repeat(64)}`,
            env: [{ name: "PRIVATE_DERIVED_MARKER", value: `private-candidate-${index}` }]
          }]
        }
      }
    }
  }));
  return {
    root, keyPath, keyRecord, keyBytes,
    request: { keyringPath, keyId, lockBinding, publicAuthority, deploymentContracts }
  };
}

function validationRequest(request, authority, consumerContract) {
  const result = {
    keyringPath: request.keyringPath,
    keyId: request.keyId,
    lockBinding: request.lockBinding,
    deploymentContracts: request.deploymentContracts,
    authority
  };
  return arguments.length === 3
    ? { ...result, consumerContract }
    : result;
}

function consumerContractFor(authority) {
  return {
    schema_version: authority.schema_version === 1 ? 2 : 3,
    operation_id: authority.operation_id,
    authority_sha256: createHash("sha256")
      .update(Buffer.from(canonicalJsonV1(authority), "utf8")).digest("hex"),
    consumers: structuredClone(authority.consumers)
  };
}

function manualHmac({ keyBytes, request }, domain) {
  const bytes = Buffer.from(canonicalJsonV1({
    lock_binding: request.lockBinding,
    public_authority: request.publicAuthority,
    deployment_contracts: request.deploymentContracts
  }), "utf8");
  try {
    return createHmac("sha256", keyBytes).update(domain).update(bytes).digest("hex");
  } finally {
    bytes.fill(0);
  }
}

test("authority v2 signs BASE zero, positive and mixed replicas without version selection", t => {
  for (const replicas of [[0, 0, 0, 0, 0], [2, 1, 1, 1, 1], [0, 2, 0, 1, 0]]) {
    const { request } = fixture(t, { replicas });
    const authority = createCheckpointBackupAuthorityV2(request);
    assert.equal(authority.schema_version, 2);
    assert.equal(authority.hmac_profile, AUTHORITY_HMAC_PROFILE_V2);
    assert.deepEqual(authority.consumers.map(consumer => consumer.original_replicas), replicas);
    assert.equal(validateCheckpointBackupAuthorityVersioned(
      validationRequest(request, authority, consumerContractFor(authority))
    ), authority);
    const bytes = canonicalJsonV1(authority);
    assert.equal(canonicalJsonV1(parseCheckpointBackupAuthorityVersioned(bytes)), bytes);
  }
});

test("v2 domain authenticates the exact historical lock/fullspec body with no public leakage", t => {
  const material = fixture(t);
  const authority = createCheckpointBackupAuthorityV2(material.request);
  assert.equal(authority.authority_hmac_sha256, manualHmac(
    material, Buffer.from("yenhubs/checkpoint-backup-authority/v2\0", "ascii")
  ));
  assert.notEqual(authority.authority_hmac_sha256, manualHmac(
    material, Buffer.from("yenhubs/checkpoint-backup-authority/v1\0", "ascii")
  ));
  const consumerContract = consumerContractFor(authority);
  const publicBytes = canonicalJsonV1({ authority, consumerContract });
  for (const privateValue of [
    material.request.lockBinding.recovery_token,
    material.request.lockBinding.checkpoint_stamp,
    material.keyRecord.key_base64,
    "private-low-entropy", "PRIVATE_DERIVED_MARKER", "private-candidate",
    "spec_without_replicas", "deployment_contracts", "lock_binding", "fingerprint"
  ]) assert.equal(publicBytes.includes(privateValue), false);
  assert.equal(consumerContract.authority_sha256,
    createHash("sha256").update(canonicalJsonV1(authority)).digest("hex"));
  assert.notEqual(consumerContract.authority_sha256,
    createHash("sha256").update(canonicalJsonV1(material.request.publicAuthority)).digest("hex"));
});

test("old APIs remain strict v1 and versioned validation accepts only signed positive v1", t => {
  const { keyRecord, request } = fixture(t, { version: 1, replicas: [2, 1, 1, 1, 1] });
  const oldRequest = {
    keyRecord, lockBinding: request.lockBinding, publicAuthority: request.publicAuthority,
    deploymentContracts: request.deploymentContracts
  };
  const authority = createCheckpointBackupAuthority(oldRequest);
  const bytes = canonicalJsonV1(authority);
  assert.equal(canonicalJsonV1(parseCheckpointBackupAuthorityVersioned(bytes)), bytes);
  assert.equal(parseCheckpointBackupAuthority(bytes).authority_hmac_sha256,
    computeCheckpointBackupAuthorityHmac({
      keyBytes: Buffer.from(keyRecord.key_base64, "base64"),
      lockBinding: request.lockBinding, publicAuthority: request.publicAuthority,
      deploymentContracts: request.deploymentContracts
    }));
  assert.equal(validateCheckpointBackupAuthorityVersioned(
    validationRequest(request, authority, consumerContractFor(authority))
  ), authority);
  assert.equal(validateCheckpointBackupAuthority({ ...oldRequest, authority }), authority);
  expectCode(() => createCheckpointBackupAuthorityV2(request), "authority_schema");

  const zeroPublic = structuredClone(request.publicAuthority);
  zeroPublic.consumers[0].original_replicas = 0;
  expectCode(() => createCheckpointBackupAuthority({
    ...oldRequest, publicAuthority: zeroPublic
  }), "authority_consumer_replicas");
  expectCode(() => parseCheckpointBackupAuthorityVersioned(canonicalJsonV1({
    ...authority, consumers: zeroPublic.consumers
  })), "authority_consumer_replicas");

  const v2 = fixture(t, { replicas: [2, 1, 1, 1, 1] });
  const authorityV2 = createCheckpointBackupAuthorityV2(v2.request);
  expectCode(() => parseCheckpointBackupAuthority(canonicalJsonV1(authorityV2)), "authority_schema");
  expectCode(() => createCheckpointBackupAuthority({
    ...oldRequest, publicAuthority: v2.request.publicAuthority
  }), "authority_schema");
  expectCode(() => validateCheckpointBackupAuthority({
    ...oldRequest, authority: authorityV2
  }), "authority_schema");
});

test("only authority1/consumer2 and authority2/consumer3 pairs bind the signed canonical bytes", t => {
  for (const version of [1, 2]) {
    const { request, keyRecord } = fixture(t, { version, replicas: [1, 1, 1, 1, 1] });
    const authority = version === 2
      ? createCheckpointBackupAuthorityV2(request)
      : createCheckpointBackupAuthority({
        keyRecord, lockBinding: request.lockBinding, publicAuthority: request.publicAuthority,
        deploymentContracts: request.deploymentContracts
      });
    const consumerContract = consumerContractFor(authority);
    for (const consumerVersion of [1, 2, 3, 4]) {
      if (consumerVersion === consumerContract.schema_version) continue;
      expectCode(() => validateCheckpointBackupAuthorityVersioned(validationRequest(
        request, authority, { ...consumerContract, schema_version: consumerVersion }
      )), "authority_consumer_contract_schema");
    }
    for (const changed of [
      { ...consumerContract, extra: true },
      { ...consumerContract, operation_id: "f".repeat(32) },
      { ...consumerContract, authority_sha256: "unknown" },
      null, undefined
    ]) expectCode(() => validateCheckpointBackupAuthorityVersioned(
      validationRequest(request, authority, changed)
    ), "authority_consumer_contract_schema");
    for (const changed of [
      { ...consumerContract, authority_sha256: "f".repeat(64) },
      { ...consumerContract, consumers: [] },
      { ...consumerContract, consumers: [...consumerContract.consumers].reverse() },
      { ...consumerContract, consumers: consumerContract.consumers.map(consumer => ({
        ...consumer, extra: true
      })) }
    ]) expectCode(() => validateCheckpointBackupAuthorityVersioned(
      validationRequest(request, authority, changed)
    ), "authority_consumer_contract_binding");
    assert.equal(validateCheckpointBackupAuthorityVersioned(
      validationRequest(request, authority)
    ), authority);
  }
});

test("version/profile and domain crosses fail without legacy fallback", t => {
  const material = fixture(t, { replicas: [1, 1, 1, 1, 1] });
  const authority = createCheckpointBackupAuthorityV2(material.request);
  for (const changed of [
    { ...authority, schema_version: 1 },
    { ...authority, hmac_profile: AUTHORITY_HMAC_PROFILE },
    { ...authority, schema_version: 3 },
    { ...authority, schema_version: "2" },
    { ...authority, hmac_profile: "yenhubs-checkpoint-backup-authority-hmac-v3" }
  ]) expectCode(() => parseCheckpointBackupAuthorityVersioned(canonicalJsonV1(changed)), "authority_schema");
  const crossed = { ...authority, schema_version: 1, hmac_profile: AUTHORITY_HMAC_PROFILE };
  expectCode(() => validateCheckpointBackupAuthorityVersioned(
    validationRequest(material.request, crossed)
  ), "authority_hmac");
  const wrongDomain = { ...authority, authority_hmac_sha256: manualHmac(
    material, Buffer.from("yenhubs/checkpoint-backup-authority/v1\0", "ascii")
  ) };
  expectCode(() => validateCheckpointBackupAuthorityVersioned(
    validationRequest(material.request, wrongDomain)
  ), "authority_hmac");
});

test("signature, fullspec, generation, resourceVersion and private lock changes are authenticated", t => {
  const { request } = fixture(t);
  const authority = createCheckpointBackupAuthorityV2(request);
  expectCode(() => validateCheckpointBackupAuthorityVersioned(validationRequest(
    request, { ...authority, authority_hmac_sha256: "f".repeat(64) }
  )), "authority_hmac");
  for (const [field, value] of [
    ["initial_generation", 100], ["initial_resource_version", "rv-tampered"],
    ["original_replicas", 1], ["uid", "uid-tampered"]
  ]) {
    const changed = structuredClone(authority);
    changed.consumers[0][field] = value;
    expectCode(() => validateCheckpointBackupAuthorityVersioned(
      validationRequest(request, changed)
    ), field === "uid" ? "authority_deployment_contract_schema" : "authority_hmac");
  }
  for (const mutate of [
    contracts => { contracts[0].spec_without_replicas.template.metadata.annotations[
      "yenhubs.org/db-credential-checksum"
    ] = "private-marker-tampered"; },
    contracts => { contracts[0].spec_without_replicas.template.spec.containers[0].env[0].value = "changed"; },
    contracts => { contracts[0].spec_without_replicas.revisionHistoryLimit = 0; },
    contracts => { delete contracts[0].spec_without_replicas.strategy; }
  ]) {
    const deploymentContracts = structuredClone(request.deploymentContracts);
    mutate(deploymentContracts);
    expectCode(() => validateCheckpointBackupAuthorityVersioned({
      ...validationRequest(request, authority), deploymentContracts
    }), "authority_hmac");
  }
  for (const lockBinding of [
    { ...request.lockBinding, recovery_token: "c".repeat(32) },
    { ...request.lockBinding, checkpoint_stamp: "20261003-120001" }
  ]) expectCode(() => validateCheckpointBackupAuthorityVersioned({
    ...validationRequest(request, authority), lockBinding
  }), "authority_hmac");
});

test("v2 consumers are the exact five sorted records with safe generations and replicas", t => {
  const { request } = fixture(t);
  for (const consumers of [
    [...request.publicAuthority.consumers].reverse(),
    request.publicAuthority.consumers.slice(1),
    [...request.publicAuthority.consumers, request.publicAuthority.consumers[0]],
    request.publicAuthority.consumers.map((consumer, index) => index === 1
      ? request.publicAuthority.consumers[0] : consumer)
  ]) expectCode(() => createCheckpointBackupAuthorityV2({
    ...request, publicAuthority: { ...request.publicAuthority, consumers }
  }), consumers.length !== 5 ? "authority_schema" : "authority_consumer_schema");
  for (const [field, value, code] of [
    ["original_replicas", -1, "authority_consumer_replicas"],
    ["original_replicas", 1.5, "authority_consumer_replicas"],
    ["original_replicas", Number.MAX_SAFE_INTEGER + 1, "authority_consumer_replicas"],
    ["initial_generation", 0, "authority_consumer_generation"],
    ["initial_generation", Number.MAX_SAFE_INTEGER + 1, "authority_consumer_generation"],
    ["initial_resource_version", "bad rv", "authority_consumer_rv"],
    ["selector", "other", "authority_consumer_schema"],
    ["extra", true, "authority_consumer_schema"]
  ]) {
    const publicAuthority = structuredClone(request.publicAuthority);
    publicAuthority.consumers[0][field] = value;
    expectCode(() => createCheckpointBackupAuthorityV2({ ...request, publicAuthority }), code);
  }
  const safeMaximum = structuredClone(request.publicAuthority);
  safeMaximum.consumers[0].original_replicas = Number.MAX_SAFE_INTEGER;
  safeMaximum.consumers[0].initial_generation = Number.MAX_SAFE_INTEGER;
  assert.equal(createCheckpointBackupAuthorityV2({
    ...request, publicAuthority: safeMaximum
  }).consumers[0].original_replicas, Number.MAX_SAFE_INTEGER);
});

test("versioned APIs reject sparse five-element consumers and deployment contracts", async t => {
  const material = fixture(t);
  const controlAuthority = createCheckpointBackupAuthorityV2(material.request);
  assert.equal(validateCheckpointBackupAuthorityVersioned(
    validationRequest(material.request, controlAuthority)
  ), controlAuthority);
  assert.equal(validateCheckpointBackupAuthorityVersioned(validationRequest(
    material.request, controlAuthority, consumerContractFor(controlAuthority)
  )), controlAuthority);

  const scenarios = [
    {
      name: "deleted consumer index",
      mutate(request) { delete request.publicAuthority.consumers[1]; },
      code: "authority_schema"
    },
    {
      name: "all consumer indices absent",
      mutate(request) { request.publicAuthority.consumers = new Array(5); },
      code: "authority_schema"
    },
    {
      name: "deleted deployment contract index",
      mutate(request) { delete request.deploymentContracts[1]; },
      code: "authority_deployment_contracts"
    },
    {
      name: "all deployment contract indices absent",
      mutate(request) { request.deploymentContracts = new Array(5); },
      code: "authority_deployment_contracts"
    },
    {
      name: "matching deleted consumer and deployment contract indices",
      mutate(request) {
        delete request.publicAuthority.consumers[1];
        delete request.deploymentContracts[1];
      },
      code: "authority_schema"
    },
    {
      name: "all consumer and deployment contract indices absent",
      mutate(request) {
        request.publicAuthority.consumers = new Array(5);
        request.deploymentContracts = new Array(5);
      },
      code: "authority_schema"
    }
  ];
  for (const scenario of scenarios) {
    const request = structuredClone(material.request);
    scenario.mutate(request);
    assert.equal(request.publicAuthority.consumers.length, 5);
    assert.equal(request.deploymentContracts.length, 5);
    assert.equal(
      Object.hasOwn(request.publicAuthority.consumers, 1) &&
        Object.hasOwn(request.deploymentContracts, 1),
      false
    );
    await t.test(`${scenario.name}: create`, () => {
      expectCode(() => createCheckpointBackupAuthorityV2(request), scenario.code);
    });
    await t.test(`${scenario.name}: validate`, () => {
      // Sign the malformed in-memory body independently: validation must reject
      // its structure, not rely on a digest mismatch or the create API guard.
      const authority = {
        ...request.publicAuthority,
        authority_hmac_sha256: manualHmac({ ...material, request },
          Buffer.from("yenhubs/checkpoint-backup-authority/v2\0", "ascii"))
      };
      expectCode(() => validateCheckpointBackupAuthorityVersioned(
        validationRequest(request, authority)
      ), scenario.code);
    });
  }
});

test("v2 preserves closed namespace/PVC, lock, deployment and durable fence schemas", t => {
  const { request } = fixture(t, { durable: true });
  assert.equal(validateCheckpointBackupAuthorityVersioned(validationRequest(
    request, createCheckpointBackupAuthorityV2(request)
  )).runner_generation, "durable-v2");
  for (const [mutate, code] of [
    [value => { value.namespace.extra = true; }, "authority_namespace"],
    [value => { value.pvc.name = "another-pvc"; }, "authority_pvc"],
    [value => { value.runner_generation = "durable-v3"; }, "authority_schema"],
    [value => { value.operation_fence.state = "active"; }, "authority_fence_schema"],
    [value => { value.operation_fence.namespaces.runner.phase = "Terminating"; }, "authority_fence_namespace_schema"],
    [value => { value.operation_fence.policy.initial_generation = 0; }, "authority_fence_policy_generation"],
    [value => { value.operation_fence.binding.extra = true; }, "authority_fence_binding_schema"],
    [value => { value.extra = true; }, "authority_schema"]
  ]) {
    const publicAuthority = structuredClone(request.publicAuthority);
    mutate(publicAuthority);
    expectCode(() => createCheckpointBackupAuthorityV2({ ...request, publicAuthority }), code);
  }
  for (const lockBinding of [
    { ...request.lockBinding, extra: true },
    { ...request.lockBinding, namespace_uid: "other" },
    { ...request.lockBinding, dump_sha256: "1".repeat(64) },
    { ...request.lockBinding, storage_sha256: "1".repeat(64) }
  ]) expectCode(() => createCheckpointBackupAuthorityV2({ ...request, lockBinding }), "authority_lock_binding");
  for (const mutate of [
    contracts => { contracts[0].extra = true; },
    contracts => { contracts[0].spec_without_replicas.replicas = 0; },
    contracts => { contracts.reverse(); }
  ]) {
    const deploymentContracts = structuredClone(request.deploymentContracts);
    mutate(deploymentContracts);
    expectCode(() => createCheckpointBackupAuthorityV2({
      ...request, deploymentContracts
    }), "authority_deployment_contract_schema");
  }
});

test("versioned parser rejects extra keys, duplicate keys and noncanonical byte ordering", t => {
  const { request } = fixture(t);
  const authority = createCheckpointBackupAuthorityV2(request);
  const canonical = canonicalJsonV1(authority);
  expectCode(() => parseCheckpointBackupAuthorityVersioned(canonicalJsonV1({
    ...authority, extra: true
  })), "authority_schema");
  expectCode(() => parseCheckpointBackupAuthorityVersioned(JSON.stringify(authority)),
    "canonical_json_not_canonical");
  expectCode(() => parseCheckpointBackupAuthorityVersioned(`${canonical}\n`),
    "canonical_json_not_canonical");
  expectCode(() => parseCheckpointBackupAuthorityVersioned(
    canonical.replace('"schema_version":2', '"schema_version":2,"schema_version":2')
  ), "canonical_json_duplicate_key");
  expectCode(() => parseCheckpointBackupAuthorityVersioned(canonical.replace(
    authority.authority_hmac_sha256, "bad-signature"
  )), "authority_hmac_schema");
});

test("new APIs require explicit existing keyring/ID with no record bypass, defaults or writes", t => {
  const { root, keyPath, keyRecord, request } = fixture(t);
  const before = fs.readFileSync(keyPath);
  for (const field of ["keyringPath", "keyId"]) {
    const missing = { ...request };
    delete missing[field];
    expectCode(() => createCheckpointBackupAuthorityV2(missing), "authority_request_schema");
  }
  expectCode(() => createCheckpointBackupAuthorityV2({ ...request, keyRecord }), "authority_request_schema");
  expectCode(() => createCheckpointBackupAuthorityV2({ ...request, keyId: otherKeyId }), "authority_key_id");
  const emptyKeyring = path.join(root, "empty-keyring");
  fs.mkdirSync(emptyKeyring, { mode: 0o700 });
  fs.chmodSync(emptyKeyring, 0o700);
  expectCode(() => createCheckpointBackupAuthorityV2({
    ...request, keyringPath: emptyKeyring
  }), "key_record_file");
  assert.deepEqual(fs.readdirSync(emptyKeyring), []);
  const authority = createCheckpointBackupAuthorityV2(request);
  expectCode(() => validateCheckpointBackupAuthorityVersioned({
    ...validationRequest(request, authority), keyRecord
  }), "authority_request_schema");
  expectCode(() => validateCheckpointBackupAuthorityVersioned({
    ...validationRequest(request, authority), keyringPath: emptyKeyring
  }), "key_record_file");
  assert.deepEqual(fs.readdirSync(request.keyringPath), [`${keyId}.json`]);
  assert.deepEqual(fs.readFileSync(keyPath), before);
  fs.chmodSync(keyPath, 0o644);
  expectCode(() => createCheckpointBackupAuthorityV2(request), "key_record_file");
});

test("v2 primitive does not print private inputs or alter argv/environment", t => {
  const { request } = fixture(t);
  const beforeArgv = [...process.argv];
  const beforeEnv = { ...process.env };
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  const output = [];
  process.stdout.write = value => { output.push(String(value)); return true; };
  process.stderr.write = value => { output.push(String(value)); return true; };
  try {
    const authority = createCheckpointBackupAuthorityV2(request);
    validateCheckpointBackupAuthorityVersioned(validationRequest(
      request, authority, consumerContractFor(authority)
    ));
    const changed = {
      ...validationRequest(request, authority),
      lockBinding: { ...request.lockBinding, recovery_token: "c".repeat(32) }
    };
    try {
      validateCheckpointBackupAuthorityVersioned(changed);
      assert.fail("expected fail-closed authentication");
    } catch (error) {
      assert.equal(error.code, "authority_hmac");
      assert.equal(error.message, "authority_hmac");
      assert.doesNotMatch(JSON.stringify(error), /private-|recovery_token|abababab/u);
    }
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  assert.deepEqual(output, []);
  assert.deepEqual(process.argv, beforeArgv);
  assert.deepEqual({ ...process.env }, beforeEnv);
});

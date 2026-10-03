import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AUTHORITY_HMAC_PROFILE,
  AUTHORITY_HMAC_PROFILE_V2,
  CHECKPOINT_BACKUP_LOCK_NAME,
  canonicalJsonV1,
  createCheckpointBackupAuthority,
  createCheckpointBackupAuthorityV2,
  createKeyRecord,
  parseCheckpointBackupAuthorityVersioned
} from "../../deployment/recovery-checkpoint-authority.mjs";

const helperPath = fileURLToPath(new URL("../../deployment/recovery-checkpoint-authority.mjs", import.meta.url));
const keyId = "12345678-1234-4abc-8def-1234567890ab";
const consumerNames = ["bot-orchestrator", "coturn", "pgbouncer", "pgbouncer-t", "reticulum"];
const failure = "recovery checkpoint authority failed closed\n";

function fixture(t, { version = 2, replicas = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "yenhubs-authority-cli-v2-"));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const keyringPath = path.join(root, "keyring");
  fs.mkdirSync(keyringPath, { mode: 0o700 });
  fs.chmodSync(keyringPath, 0o700);
  const keyRecord = createKeyRecord({ keyId, keyBytes: Buffer.alloc(32, 0x5a) });
  const keyPath = path.join(keyringPath, `${keyId}.json`);
  fs.writeFileSync(keyPath, canonicalJsonV1(keyRecord), { flag: "wx", mode: 0o600 });
  fs.chmodSync(keyPath, 0o600);
  const publicAuthority = {
    schema_version: version,
    operation_id: "0123456789abcdef0123456789abcdef",
    namespace: { name: "hcce", uid: "namespace-uid" },
    pvc: { name: "ret-pvc", uid: "pvc-uid" },
    hmac_profile: version === 1 ? AUTHORITY_HMAC_PROFILE : AUTHORITY_HMAC_PROFILE_V2,
    hmac_key_id: keyId,
    runner_generation: "legacy-absent",
    operation_fence: null,
    consumers: consumerNames.map((name, index) => ({
      name, uid: `${name}-uid`, initial_resource_version: `rv-${index}`,
      initial_generation: index + 1, original_replicas: replicas, selector: name
    }))
  };
  const lockBinding = {
    name: CHECKPOINT_BACKUP_LOCK_NAME, namespace: "hcce", owner: "checkpoint-backup",
    operation_id: publicAuthority.operation_id,
    recovery_token: "abababababababababababababababab",
    namespace_uid: "namespace-uid", pvc_uid: "pvc-uid", checkpoint_stamp: "20261003-120000",
    dump_sha256: "0".repeat(64), storage_sha256: "0".repeat(64)
  };
  const deploymentContracts = consumerNames.map(name => ({
    api_version: "apps/v1", kind: "Deployment", namespace: "hcce", name, uid: `${name}-uid`,
    spec_without_replicas: {
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { app: name }, annotations: { privateMarker: "private-annotation-marker" } },
        spec: { containers: [{
          name, image: `example.invalid/${name}@sha256:${"1".repeat(64)}`,
          env: [{ name: "PRIVATE_DERIVED_MARKER", value: "private-env-marker" }]
        }] }
      }
    }
  }));
  return {
    root, keyPath, keyRecord,
    request: { keyringPath, keyId, lockBinding, publicAuthority, deploymentContracts },
    createPayload: {
      lock_binding: lockBinding, public_authority: publicAuthority, deployment_contracts: deploymentContracts
    }
  };
}

function authorityFor(material) {
  return material.request.publicAuthority.schema_version === 2
    ? createCheckpointBackupAuthorityV2(material.request)
    : createCheckpointBackupAuthority({
      keyRecord: material.keyRecord, lockBinding: material.request.lockBinding,
      publicAuthority: material.request.publicAuthority, deploymentContracts: material.request.deploymentContracts
    });
}

function validatePayload(material, authority = authorityFor(material)) {
  return {
    lock_binding: material.request.lockBinding,
    authority,
    deployment_contracts: material.request.deploymentContracts,
    consumer_contract: {
      schema_version: authority.schema_version === 1 ? 2 : 3,
      operation_id: authority.operation_id,
      authority_sha256: createHash("sha256").update(canonicalJsonV1(authority)).digest("hex"),
      consumers: structuredClone(authority.consumers)
    }
  };
}

function runCli(material, command, input, args = [material.request.keyringPath, keyId]) {
  const argv = [helperPath, "authority", command, ...args];
  return {
    argv,
    ...spawnSync(process.execPath, argv, {
      input: typeof input === "string" || Buffer.isBuffer(input) ? input : canonicalJsonV1(input),
      encoding: "utf8", maxBuffer: 64 * 1024
    })
  };
}

function assertFailure(result) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, failure);
  assert.equal(result.error, undefined);
}

test("create-v2 CLI signs zero and positive authorities and emits only canonical signed JSON", t => {
  for (const replicas of [0, 2]) {
    const material = fixture(t, { replicas });
    const result = runCli(material, "create-v2", material.createPayload);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const authority = parseCheckpointBackupAuthorityVersioned(result.stdout.slice(0, -1));
    assert.equal(result.stdout, `${canonicalJsonV1(authority)}\n`);
    assert.equal(authority.schema_version, 2);
    assert.equal(authority.hmac_profile, AUTHORITY_HMAC_PROFILE_V2);
    assert.equal(authority.consumers[0].original_replicas, replicas);
    assert.equal(canonicalJsonV1(authority), canonicalJsonV1(authorityFor(material)));
  }
});

test("validate-versioned CLI requires the exact operational authority1/consumer2 or authority2/consumer3 pair", t => {
  for (const version of [1, 2]) {
    const material = fixture(t, { version, replicas: version === 1 ? 1 : 0 });
    const payload = validatePayload(material);
    const result = runCli(material, "validate-versioned", payload);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, `${canonicalJsonV1({
      key_id: keyId, profile: payload.authority.hmac_profile, status: "valid"
    })}\n`);
    const unbound = { ...payload };
    delete unbound.consumer_contract;
    assertFailure(runCli(material, "validate-versioned", unbound));
    assertFailure(runCli(material, "validate-versioned", { ...payload, consumer_contract: null }));
    for (const consumerVersion of [1, 2, 3, 4]) {
      if (consumerVersion === payload.consumer_contract.schema_version) continue;
      assertFailure(runCli(material, "validate-versioned", {
        ...payload, consumer_contract: { ...payload.consumer_contract, schema_version: consumerVersion }
      }));
    }
  }
});

test("versioned CLI rejects altered signatures, bindings, specs and extra request fields without echo", t => {
  const material = fixture(t);
  const payload = validatePayload(material);
  const extraCreate = { ...material.createPayload, key_record: material.keyRecord };
  assertFailure(runCli(material, "create-v2", extraCreate));
  for (const mutate of [
    value => { value.extra = "private-extra-marker"; },
    value => { value.authority.schema_version = 3; },
    value => { value.authority.authority_hmac_sha256 = "f".repeat(64); },
    value => { value.consumer_contract.authority_sha256 = "f".repeat(64); },
    value => { value.consumer_contract.consumers.reverse(); },
    value => { value.lock_binding.recovery_token = "c".repeat(32); },
    value => { value.deployment_contracts[0].spec_without_replicas.template.metadata.annotations.privateMarker = "private-changed-marker"; }
  ]) {
    const changed = structuredClone(payload);
    mutate(changed);
    assertFailure(runCli(material, "validate-versioned", changed));
  }
});

test("versioned CLI stdin is strict canonical JSON with no duplicates, BOM, invalid UTF8 or trailing bytes", t => {
  const material = fixture(t);
  const canonical = canonicalJsonV1(material.createPayload);
  for (const input of [
    JSON.stringify(material.createPayload), `${canonical}\n`, `${canonical}private-trailing-marker`,
    canonical.replace('"lock_binding":{', '"lock_binding":{},"lock_binding":{'),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(canonical)]),
    Buffer.from([0xff]),
    canonical.replace('"public_authority":{', '"public_authority":undefined,"unused":{')
  ]) assertFailure(runCli(material, "create-v2", input));
});

test("versioned CLI rejects a valid-shaped private fullspec above the existing 16MiB stdin limit", t => {
  const material = fixture(t);
  const payload = structuredClone(material.createPayload);
  payload.deployment_contracts[0].spec_without_replicas.template.spec.containers[0].env[0].value =
    `private-overlimit-marker${"x".repeat(16 * 1024 * 1024)}`;
  const input = canonicalJsonV1(payload);
  assert.ok(Buffer.byteLength(input) > 16 * 1024 * 1024);
  assertFailure(runCli(material, "create-v2", input));
});

test("versioned CLI requires fixed commands and explicit existing keyring/ID without creation or import", t => {
  const material = fixture(t);
  const before = fs.readFileSync(material.keyPath);
  for (const [command, args] of [
    ["create-v2", []], ["create-v2", [material.request.keyringPath]],
    ["create-v2", [material.request.keyringPath, keyId, "extra"]],
    ["create-v3", [material.request.keyringPath, keyId]],
    ["validate-versioned", []],
    ["create-v2", [material.request.keyringPath, "87654321-4321-4abc-8def-1234567890ab"]],
    ["create-v2", [material.keyPath, keyId]]
  ]) assertFailure(runCli(material, command, material.createPayload, args));
  const missingKeyring = path.join(material.root, "not-created");
  assertFailure(runCli(material, "create-v2", material.createPayload, [missingKeyring, keyId]));
  assert.equal(fs.existsSync(missingKeyring), false);
  const emptyKeyring = path.join(material.root, "empty-keyring");
  fs.mkdirSync(emptyKeyring, { mode: 0o700 });
  fs.chmodSync(emptyKeyring, 0o700);
  assertFailure(runCli(material, "create-v2", material.createPayload, [emptyKeyring, keyId]));
  assert.deepEqual(fs.readdirSync(emptyKeyring), []);
  assert.deepEqual(fs.readdirSync(material.request.keyringPath), [`${keyId}.json`]);
  assert.deepEqual(fs.readFileSync(material.keyPath), before);
});

test("versioned CLI keeps token/fullspec off argv, output and environment and performs no file writes", t => {
  const material = fixture(t);
  const recordBefore = fs.readFileSync(material.keyPath);
  const envBefore = { ...process.env };
  const rootBefore = fs.readdirSync(material.root);
  const created = runCli(material, "create-v2", material.createPayload);
  const validated = runCli(material, "validate-versioned", validatePayload(material));
  assert.equal(created.status, 0, created.stderr);
  assert.equal(validated.status, 0, validated.stderr);
  for (const result of [created, validated]) {
    assert.deepEqual(result.argv, [helperPath, "authority",
      result === created ? "create-v2" : "validate-versioned", material.request.keyringPath, keyId]);
    const visible = JSON.stringify(result.argv) + result.stdout + result.stderr;
    for (const value of [
      material.request.lockBinding.recovery_token, material.keyRecord.key_base64,
      "private-annotation-marker", "private-env-marker", "PRIVATE_DERIVED_MARKER", "spec_without_replicas"
    ]) assert.equal(visible.includes(value), false);
  }
  assert.deepEqual({ ...process.env }, envBefore);
  assert.deepEqual(fs.readdirSync(material.root), rootBefore);
  assert.deepEqual(fs.readdirSync(material.request.keyringPath), [`${keyId}.json`]);
  assert.deepEqual(fs.readFileSync(material.keyPath), recordBefore);
});

test("historical create/validate CLI stays strict v1 with its unchanged stdin contracts", t => {
  const material = fixture(t, { version: 1, replicas: 1 });
  const created = runCli(material, "create", material.createPayload);
  assert.equal(created.status, 0, created.stderr);
  assert.equal(created.stdout, `${canonicalJsonV1(authorityFor(material))}\n`);
  const operationalPayload = validatePayload(material);
  const historicalPayload = { ...operationalPayload };
  delete historicalPayload.consumer_contract;
  const validated = runCli(material, "validate", historicalPayload);
  assert.equal(validated.status, 0, validated.stderr);
  assert.equal(validated.stdout, `${canonicalJsonV1({
    key_id: keyId, profile: AUTHORITY_HMAC_PROFILE, status: "valid"
  })}\n`);
  assertFailure(runCli(material, "validate", operationalPayload));
  assertFailure(runCli(material, "create-v2", material.createPayload));
  const v2 = fixture(t);
  assertFailure(runCli(v2, "create", v2.createPayload));
  const v2Historical = validatePayload(v2);
  delete v2Historical.consumer_contract;
  assertFailure(runCli(v2, "validate", v2Historical));
});

test("helper import under Node module eval with helper argv1 does not enter the CLI", async t => {
  const source = `
    import { pathToFileURL } from "node:url";
    const argvBefore = JSON.stringify(process.argv);
    const helper = await import(pathToFileURL(process.argv[1]).href);
    process.stdout.write(helper.canonicalJsonV1({
      module_import: "checkpoint-authority-eval-sentinel",
      argv_unchanged: JSON.stringify(process.argv) === argvBefore
    }) + "\\n");
  `;
  const printSource = `
    const argvBefore = JSON.stringify(process.argv);
    void import(require("node:url").pathToFileURL(process.argv[1]).href).then(helper => {
      process.stdout.write(helper.canonicalJsonV1({
        module_import: "checkpoint-authority-eval-sentinel",
        argv_unchanged: JSON.stringify(process.argv) === argvBefore
      }) + "\\n");
    });
    0;
  `;
  const sentinel = `${canonicalJsonV1({
    module_import: "checkpoint-authority-eval-sentinel", argv_unchanged: true
  })}\n`;
  // Node 22.11 does not bind standalone --print=code as a print expression:
  // it evaluates the following helper path as code instead. That incompatible
  // invocation is not a passing regression variant; use native split flags.
  for (const { name, args, print = false } of [
    { name: "-e", args: ["--input-type=module", "-e", source, helperPath] },
    { name: "--eval", args: ["--input-type=module", "--eval", source, helperPath] },
    { name: "--eval=", args: ["--input-type=module", `--eval=${source}`, helperPath] },
    { name: "-p", args: ["-p", printSource, helperPath], print: true },
    { name: "--print", args: ["--print", printSource, helperPath], print: true },
    { name: "-pe", args: ["-pe", printSource, helperPath], print: true }
  ]) {
    await t.test(name, () => {
      const result = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 64 * 1024 });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.error, undefined);
      assert.equal(result.stderr, "");
      if (print) {
        assert.ok(result.stdout.endsWith("\n"));
        assert.deepEqual(result.stdout.split("\n").slice(0, -1).sort(), [
          "0", sentinel.slice(0, -1)
        ].sort());
      } else {
        assert.equal(result.stdout, sentinel);
      }
    });
  }
});

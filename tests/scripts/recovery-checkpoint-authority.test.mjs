import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AUTHORITY_HMAC_PROFILE,
  CHECKPOINT_BACKUP_LOCK_NAME,
  RecoveryCheckpointAuthorityError,
  canonicalJsonV1,
  computeCheckpointBackupAuthorityHmac,
  createCandidateKeyRecord,
  createCheckpointBackupAuthority,
  createKeyRecord,
  importKeyRecord,
  inspectKeyRecord,
  keyRecordVerificationHmac,
  parseCanonicalJsonV1,
  parseCheckpointBackupAuthority,
  parseKeyRecord,
  validateCheckpointBackupAuthority,
  validateKeyRecord
} from "../../deployment/recovery-checkpoint-authority.mjs";

const helperPath = fileURLToPath(new URL(
  "../../deployment/recovery-checkpoint-authority.mjs",
  import.meta.url
));

const consumerNames = Object.freeze([
  "bot-orchestrator",
  "coturn",
  "pgbouncer",
  "pgbouncer-t",
  "reticulum"
]);

function expectCode(callback, code) {
  assert.throws(callback, error =>
    error instanceof RecoveryCheckpointAuthorityError && error.code === code
  );
}

function privateDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  fs.chmodSync(directory, 0o700);
  return directory;
}

function writePrivateRecord(filePath, record) {
  fs.writeFileSync(filePath, canonicalJsonV1(record), { mode: 0o600, flag: "wx" });
  fs.chmodSync(filePath, 0o600);
}

function authorityFixture({ keyRecord = createKeyRecord() } = {}) {
  const publicAuthority = {
    schema_version: 1,
    operation_id: "0123456789abcdef0123456789abcdef",
    namespace: { name: "hcce", uid: "namespace-uid-1" },
    pvc: { name: "ret-pvc", uid: "pvc-uid-1" },
    hmac_profile: AUTHORITY_HMAC_PROFILE,
    hmac_key_id: keyRecord.key_id,
    runner_generation: "legacy-absent",
    operation_fence: null,
    consumers: consumerNames.map((name, index) => ({
      name,
      uid: `${name}-uid`,
      initial_resource_version: `rv-${index + 1}`,
      initial_generation: 10 + index,
      original_replicas: index === 0 ? 2 : 1,
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
    checkpoint_stamp: "20260808-194500",
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
          annotations: {
            "yenhubs.org/db-credential-checksum": `low-entropy-marker-${index}`
          }
        },
        spec: {
          containers: [{
            name,
            image: `example.invalid/${name}@sha256:${String(index).repeat(64)}`,
            env: [{ name: "PRIVATE_DERIVED_MARKER", value: `candidate-${index}` }]
          }]
        }
      }
    }
  }));
  return { keyRecord, publicAuthority, lockBinding, deploymentContracts };
}

test("canonical-json-v1 sorts UTF-16 keys and preserves array order", () => {
  const value = Object.create(null);
  value["\uffff"] = 3;
  value["\ud83d\ude00"] = 2;
  value.a = [3, 2, 1];
  const canonical = canonicalJsonV1(value);
  assert.equal(canonical, '{"a":[3,2,1],"😀":2,"￿":3}');
  assert.equal(
    createHash("sha256").update(Buffer.from(canonical, "utf8")).digest("hex"),
    "ed89e1a0cac72e5880d10d41fc7aa59146a22450eb8baa099625fa4e77a598d4"
  );
  assert.deepEqual(
    parseCanonicalJsonV1(Buffer.from('{"a":[3,2,1],"😀":2,"￿":3}', "utf8")),
    value
  );
});

test("canonical parser rejects duplicates, whitespace, aliases and unsafe numbers", () => {
  expectCode(
    () => parseCanonicalJsonV1('{"a":1,"a":2}'),
    "canonical_json_duplicate_key"
  );
  expectCode(() => parseCanonicalJsonV1('{"a": 1}'), "canonical_json_not_canonical");
  expectCode(() => parseCanonicalJsonV1('{"a":1.0}'), "canonical_json_not_canonical");
  expectCode(
    () => parseCanonicalJsonV1('{"a":9007199254740992}'),
    "canonical_json_number"
  );
  expectCode(() => canonicalJsonV1({ a: undefined }), "canonical_json_type");
});

test("key records bind UUID to exactly 32 bytes", () => {
  const keyBytes = Buffer.alloc(32, 0x5a);
  const keyId = "12345678-1234-4abc-8def-1234567890ab";
  const record = createKeyRecord({ keyId, keyBytes });
  assert.equal(
    record.verification_hmac_sha256,
    "d0df22033faddb2767eda543c7295aaccdbd65503fcbf7f58f5d088d729c5e51"
  );
  assert.equal(keyRecordVerificationHmac(keyBytes, keyId),
    record.verification_hmac_sha256);
  assert.equal(
    canonicalJsonV1(parseKeyRecord(canonicalJsonV1(record), { expectedKeyId: keyId })),
    canonicalJsonV1(record)
  );

  const mismatched = { ...record, key_base64: Buffer.alloc(32, 0x41).toString("base64") };
  expectCode(() => validateKeyRecord(mismatched), "key_record_vector");
  expectCode(
    () => validateKeyRecord({ ...record, extra: true }),
    "key_record_schema"
  );
});

test("authority HMAC authenticates full specs but persists none of their bytes", () => {
  const keyRecord = createKeyRecord({
    keyId: "12345678-1234-4abc-8def-1234567890ab",
    keyBytes: Buffer.alloc(32, 0x5a)
  });
  const fixture = authorityFixture({ keyRecord });
  const authority = createCheckpointBackupAuthority(fixture);
  const persisted = canonicalJsonV1(authority);
  const canonicalBody = canonicalJsonV1({
    lock_binding: fixture.lockBinding,
    public_authority: fixture.publicAuthority,
    deployment_contracts: fixture.deploymentContracts
  });

  assert.equal(
    createHash("sha256").update(Buffer.from(canonicalBody, "utf8")).digest("hex"),
    "8ae45ef972d595fbb50e79f108e92310a3a5d9bd2e48dd67ccb1279588003fa1"
  );
  assert.equal(
    computeCheckpointBackupAuthorityHmac({
      keyBytes: Buffer.alloc(32, 0x5a),
      lockBinding: fixture.lockBinding,
      publicAuthority: fixture.publicAuthority,
      deploymentContracts: fixture.deploymentContracts
    }),
    "ed5e5e5920a6ed25a2330dd6cc0ada24ae6a55e58321503937688dd76d9a95fb"
  );

  assert.equal(parseCheckpointBackupAuthority(persisted).authority_hmac_sha256,
    authority.authority_hmac_sha256);
  assert.doesNotMatch(persisted, /low-entropy-marker|PRIVATE_DERIVED_MARKER|candidate-/u);
  assert.doesNotMatch(persisted, /spec_without_replicas|template|fingerprint/u);
  assert.equal(validateCheckpointBackupAuthority({
    ...fixture,
    authority
  }), authority);

  const changedContracts = structuredClone(fixture.deploymentContracts);
  changedContracts[0].spec_without_replicas.template.metadata.annotations[
    "yenhubs.org/db-credential-checksum"
  ] = "low-entropy-marker-tampered";
  expectCode(() => validateCheckpointBackupAuthority({
    keyRecord: fixture.keyRecord,
    lockBinding: fixture.lockBinding,
    authority,
    deploymentContracts: changedContracts
  }), "authority_hmac");
});

test("authority schema rejects extra binding fields, bad stamp and replica leakage", () => {
  const fixture = authorityFixture();
  expectCode(() => createCheckpointBackupAuthority({
    ...fixture,
    lockBinding: { ...fixture.lockBinding, extra: "not-allowed" }
  }), "authority_lock_binding");
  expectCode(() => createCheckpointBackupAuthority({
    ...fixture,
    lockBinding: { ...fixture.lockBinding, checkpoint_stamp: "today" }
  }), "authority_checkpoint_stamp");

  const contracts = structuredClone(fixture.deploymentContracts);
  contracts[0].spec_without_replicas.replicas = 1;
  expectCode(() => computeCheckpointBackupAuthorityHmac({
    keyBytes: Buffer.from(fixture.keyRecord.key_base64, "base64"),
    lockBinding: fixture.lockBinding,
    publicAuthority: fixture.publicAuthority,
    deploymentContracts: contracts
  }), "authority_deployment_contract_schema");

  const zeroReplicaAuthority = structuredClone(fixture.publicAuthority);
  zeroReplicaAuthority.consumers[0].original_replicas = 0;
  expectCode(() => createCheckpointBackupAuthority({
    ...fixture,
    publicAuthority: zeroReplicaAuthority
  }), "authority_consumer_replicas");
});

test("candidate is private, redacted and unusable until imported", () => {
  const root = privateDirectory("yenhubs-authority-candidate-");
  try {
    const candidatePath = path.join(root, "candidate.json");
    const result = createCandidateKeyRecord(candidatePath);
    const output = canonicalJsonV1(result);
    assert.match(result.key_id, /^[a-f0-9-]{36}$/u);
    assert.doesNotMatch(output, /key_base64|verification_hmac|secret/u);
    const stat = fs.lstatSync(candidatePath);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(stat.nlink, 1);

    const request = authorityFixture({
      keyRecord: parseKeyRecord(fs.readFileSync(candidatePath))
    });
    const direct = spawnSync(
      process.execPath,
      [helperPath, "authority", "create", candidatePath, request.keyRecord.key_id],
      { input: canonicalJsonV1({
        lock_binding: request.lockBinding,
        public_authority: request.publicAuthority,
        deployment_contracts: request.deploymentContracts
      }), encoding: "utf8" }
    );
    assert.notEqual(direct.status, 0);
    assert.equal(direct.stdout, "");
    assert.equal(direct.stderr, "recovery checkpoint authority failed closed\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("append-only import accepts identical bytes and rejects UUID collision", () => {
  const root = privateDirectory("yenhubs-authority-import-");
  const keyring = path.join(root, "keyring");
  fs.mkdirSync(keyring, { mode: 0o700 });
  fs.chmodSync(keyring, 0o700);
  try {
    const sourcePath = path.join(root, "restored.json");
    const created = createCandidateKeyRecord(sourcePath);
    assert.equal(importKeyRecord({ sourcePath, keyringPath: keyring }).status, "imported");
    assert.equal(importKeyRecord({ sourcePath, keyringPath: keyring }).status,
      "already-present");
    assert.equal(inspectKeyRecord({ keyringPath: keyring, keyId: created.key_id }).status,
      "valid");

    const conflictPath = path.join(root, "conflict.json");
    writePrivateRecord(conflictPath, createKeyRecord({
      keyId: created.key_id,
      keyBytes: randomBytes(32)
    }));
    expectCode(
      () => importKeyRecord({ sourcePath: conflictPath, keyringPath: keyring }),
      "key_record_destination_conflict"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("append-only import reconciles both pre-link and post-link crash states", () => {
  const root = privateDirectory("yenhubs-authority-import-crash-");
  try {
    const primitiveUrl = new URL(
      "../../deployment/private-artifact-publication.mjs",
      import.meta.url
    ).href;
    for (const scenario of [
      { hook: "afterFileFsync", exitCode: 73, destinationExists: false },
      { hook: "afterLink", exitCode: 74, destinationExists: true }
    ]) {
      const scenarioRoot = path.join(root, scenario.hook);
      const keyring = path.join(scenarioRoot, "keyring");
      fs.mkdirSync(keyring, { recursive: true, mode: 0o700 });
      fs.chmodSync(scenarioRoot, 0o700);
      fs.chmodSync(keyring, 0o700);
      const sourcePath = path.join(scenarioRoot, "restored.json");
      const created = createCandidateKeyRecord(sourcePath);
      const sourceBytes = fs.readFileSync(sourcePath);
      const destinationPath = path.join(keyring, `${created.key_id}.json`);
      const child = spawnSync(process.execPath, [
        "--input-type=module",
        "--eval",
        `import fs from "node:fs";
         import { publishPrivateArtifact } from ${JSON.stringify(primitiveUrl)};
         const request = JSON.parse(fs.readFileSync(0, "utf8"));
         publishPrivateArtifact({
           outputPath: request.output_path,
           bytes: Buffer.from(request.bytes_base64, "base64"),
           maximumBytes: 4096,
           hooks: { [request.hook]() { process.exit(request.exit_code); } }
         });`
      ], {
        input: JSON.stringify({
          output_path: destinationPath,
          bytes_base64: sourceBytes.toString("base64"),
          hook: scenario.hook,
          exit_code: scenario.exitCode
        }),
        encoding: "utf8"
      });
      sourceBytes.fill(0);
      assert.equal(child.status, scenario.exitCode, child.stderr);
      assert.equal(fs.existsSync(destinationPath), scenario.destinationExists);
      assert.equal(
        fs.readdirSync(keyring).filter(name => name.includes(".pending-v1-")).length,
        1
      );

      assert.equal(
        importKeyRecord({ sourcePath, keyringPath: keyring }).status,
        "already-present"
      );
      assert.equal(inspectKeyRecord({ keyringPath: keyring, keyId: created.key_id }).status,
        "valid");
      assert.deepEqual(fs.readdirSync(keyring), [`${created.key_id}.json`]);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("authority CLI resolves only an explicit ID from a validated keyring", () => {
  const root = privateDirectory("yenhubs-authority-cli-");
  const keyring = path.join(root, "keyring");
  fs.mkdirSync(keyring, { mode: 0o700 });
  fs.chmodSync(keyring, 0o700);
  try {
    const sourcePath = path.join(root, "restored.json");
    const created = createCandidateKeyRecord(sourcePath);
    importKeyRecord({ sourcePath, keyringPath: keyring });
    const keyRecord = parseKeyRecord(fs.readFileSync(sourcePath));
    const fixture = authorityFixture({ keyRecord });
    const request = canonicalJsonV1({
      lock_binding: fixture.lockBinding,
      public_authority: fixture.publicAuthority,
      deployment_contracts: fixture.deploymentContracts
    });
    const createdCli = spawnSync(
      process.execPath,
      [helperPath, "authority", "create", keyring, created.key_id],
      { input: request, encoding: "utf8" }
    );
    assert.equal(createdCli.status, 0, createdCli.stderr);
    assert.equal(createdCli.stderr, "");
    const authority = parseCheckpointBackupAuthority(createdCli.stdout.trimEnd());
    assert.equal(authority.hmac_key_id, created.key_id);
    assert.doesNotMatch(createdCli.stdout, /low-entropy-marker|PRIVATE_DERIVED_MARKER/u);

    const validation = spawnSync(
      process.execPath,
      [helperPath, "authority", "validate", keyring, created.key_id],
      { input: canonicalJsonV1({
        lock_binding: fixture.lockBinding,
        authority,
        deployment_contracts: fixture.deploymentContracts
      }), encoding: "utf8" }
    );
    assert.equal(validation.status, 0, validation.stderr);
    assert.deepEqual(JSON.parse(validation.stdout), {
      key_id: created.key_id,
      profile: AUTHORITY_HMAC_PROFILE,
      status: "valid"
    });

    const missing = spawnSync(
      process.execPath,
      [helperPath, "authority", "create", keyring, randomUUID()],
      { input: request, encoding: "utf8" }
    );
    assert.notEqual(missing.status, 0);
    assert.equal(missing.stdout, "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

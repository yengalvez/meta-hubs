#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  createHash,
  createHmac,
  createPrivateKey,
  generateKeyPairSync
} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  initProcessLocalRotationOperation,
  loadVerifiedProcessLocalRotationIntent,
  sealProcessLocalRotationOperation
} from "../../deployment/process-local-rotation-operation.mjs";
import {
  PROCESS_LOCAL_SOURCE_TRANSITION_TOKENS,
  ProcessLocalSourceTransitionError,
  promoteProcessLocalValuesSource,
  snapshotProcessLocalValuesSources,
  validateProcessLocalValuesSourceTransition,
  verifyProcessLocalValuesSourceTransition
} from "../../deployment/process-local-source-transition.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(ROOT, "deployment/process-local-source-transition.mjs");
const REVISION = "aud065-source-transition-fixture";
const PENDING_ATTRIBUTION_DOMAIN = Buffer.from(
  "yenhubs-aud065-source-pending-v1\0",
  "utf8"
);

const metadata = Object.freeze({
  expectedKubeContext: "fixture-context",
  namespaceName: "hcce",
  namespaceUid: "fixture-namespace-uid",
  retPvcName: "ret-pvc",
  retPvcUid: "fixture-ret-pvc-uid",
  checkpointStamp: "20260718-190000",
  checkpointDumpSha256: "1".repeat(64),
  checkpointStorageSha256: "2".repeat(64),
  checkpointInventorySha256: "3".repeat(64),
  profileId: "yenhubs-process-local-credential-rotation-v1",
  profileSha256: "4".repeat(64)
});

const requiredRotations = Object.freeze([
  "BOT_ACCESS_KEY",
  "DB_PASS",
  "GUARDIAN_KEY",
  "NODE_COOKIE",
  "OPENAI_API_KEY",
  "PERMS_KEY",
  "PHX_KEY",
  "SMTP_PASS",
  "BOT_RUNNER_ACCESS_KEY",
  "BOT_ORCHESTRATOR_ACCESS_KEY",
  "DASHBOARD_ACCESS_KEY",
  "BOT_IMAGE_PULL_CONFIG_JSON_BASE64"
]);

function encodedPrivateKey() {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  return privateKey.replace(/\r?\n/gu, "\\n");
}

const sourcePermsKeys = Object.freeze({
  old: encodedPrivateKey(),
  new: encodedPrivateKey()
});

function pullConfig(label) {
  const auth = Buffer.from(`fixture-user:${label}-token`, "utf8").toString("base64");
  return Buffer.from(JSON.stringify({ auths: { "ghcr.io": { auth } } }), "utf8")
    .toString("base64");
}

function sourceValues(label) {
  const old = label === "old";
  const marker = old ? "a" : "z";
  const password = `${old ? "Old" : "New"}_Db_Password_${marker.repeat(40)}`;
  return {
    BOT_ACCESS_KEY: `${label}-legacy-domain-${marker.repeat(40)}`,
    BOT_RUNNER_ACCESS_KEY: `${label}-runner-domain-${marker.repeat(40)}`,
    BOT_ORCHESTRATOR_ACCESS_KEY: `${label}-orchestrator-domain-${marker.repeat(40)}`,
    DASHBOARD_ACCESS_KEY: `${label}-dashboard-domain-${marker.repeat(40)}`,
    BOT_IMAGE_PULL_CONFIG_JSON_BASE64: pullConfig(`${label}-registry-auth`),
    DB_PASS: password,
    GUARDIAN_KEY: `${label}-guardian-${marker.repeat(40)}`,
    NODE_COOKIE: `${label}-node-cookie-${marker.repeat(40)}`,
    OPENAI_API_KEY: `${label}-openai-${marker.repeat(40)}`,
    PERMS_KEY: sourcePermsKeys[label],
    PHX_KEY: `${label}-phx-${marker.repeat(40)}`,
    SMTP_PASS: `${label}-smtp-${marker.repeat(40)}`,
    SKETCHFAB_API_KEY: `${label}-sketchfab-${marker.repeat(32)}`,
    TENOR_API_KEY: `${label}-tenor-${marker.repeat(32)}`,
    PGRST_DB_URI: `postgres://ret:${password}@pgbouncer:5432/ret`,
    PSQL: `postgres://ret:${password}@pgsql:5432/ret`,
    PGRST_JWT_SECRET: `${label}-derived-jwt-${marker.repeat(32)}`,
    Namespace: "hcce",
    HUB_DOMAIN: "fixture.invalid",
    OVERRIDE_HUBS_IMAGE: `ghcr.io/yengalvez/hubs@sha256:${"b".repeat(64)}`,
    OVERRIDE_BOT_ORCHESTRATOR_IMAGE:
      `ghcr.io/yengalvez/bot-orchestrator@sha256:${"c".repeat(64)}`,
    OVERRIDE_BOT_RUNNER_IMAGE:
      `ghcr.io/yengalvez/bot-runner@sha256:${"d".repeat(64)}`,
    UNRELATED_CANDIDATE_INPUT: "must-remain-identical"
  };
}

function yamlBytes(values, comment = "", {
  documentStart = true,
  lineEnding = "\n",
  permsLiteralBlock = false
} = {}) {
  const entries = Object.entries(values).sort(([left], [right]) => left.localeCompare(right));
  const lines = [];
  for (const [name, value] of entries) {
    if (name === "PERMS_KEY" && permsLiteralBlock) {
      const physicalLines = value.split("\\n");
      if (physicalLines.at(-1) === "") physicalLines.pop();
      lines.push("PERMS_KEY: |", ...physicalLines.map(line => `  ${line}`));
    } else {
      lines.push(`${name}: ${JSON.stringify(value)}`);
    }
  }
  if (comment) lines.unshift(`# ${comment}`);
  if (documentStart) lines.unshift("---");
  return Buffer.from(`${lines.join(lineEnding)}${lineEnding}`, "utf8");
}

function writePrivate(filePath, bytes) {
  fs.writeFileSync(filePath, bytes, { mode: 0o600, flag: "wx" });
  fs.chmodSync(filePath, 0o600);
}

function deterministicRandom() {
  let byte = 1;
  return size => Buffer.alloc(size, byte++);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixture({ seal = true } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "aud065-source-"));
  fs.chmodSync(root, 0o700);
  const operationDirectory = path.join(root, "operation");
  const oldValuesSource = path.join(root, "old.yaml");
  const newValuesSource = path.join(root, "new.yaml");
  const canonicalValuesPath = path.join(root, "canonical.yaml");
  const oldBytes = yamlBytes(sourceValues("old"), "verbatim-old-source");
  const newBytes = yamlBytes(sourceValues("new"), "verbatim-new-source");
  writePrivate(oldValuesSource, oldBytes);
  writePrivate(newValuesSource, newBytes);
  writePrivate(canonicalValuesPath, oldBytes);
  initProcessLocalRotationOperation({
    parentDirectory: root,
    operationDirectory,
    rotationRevision: REVISION,
    randomBytes: deterministicRandom()
  });
  snapshotProcessLocalValuesSources({
    operationDirectory,
    oldValuesSource,
    newValuesSource
  });
  writePrivate(
    path.join(operationDirectory, "original-baseline.json"),
    Buffer.from('{"items":[]}\n', "utf8")
  );
  writePrivate(
    path.join(operationDirectory, "old-snapshot.json"),
    Buffer.from('{"DB_NAME":"ret","DB_PASS":"old","DB_USER":"ret"}\n', "utf8")
  );
  writePrivate(
    path.join(operationDirectory, "new-snapshot.json"),
    Buffer.from('{"DB_NAME":"ret","DB_PASS":"new","DB_USER":"ret"}\n', "utf8")
  );
  if (seal) sealProcessLocalRotationOperation({ operationDirectory, metadata });
  const intent = seal
    ? loadVerifiedProcessLocalRotationIntent({ operationDirectory })
    : undefined;
  return {
    root,
    operationDirectory,
    oldValuesSource,
    newValuesSource,
    canonicalValuesPath,
    oldBytes,
    newBytes,
    intent
  };
}

function continuity(input) {
  return {
    expectedOperationId: input.intent.operationId,
    expectedOperationBindingSha256: input.intent.operationBindingSha256
  };
}

function transitionPendingPath(input) {
  const basename = path.basename(input.canonicalValuesPath);
  const derivedKey = Buffer.from(input.intent.hmacSha256, "hex");
  const basenameBytes = Buffer.from(basename, "utf8");
  const operationId = Buffer.from(input.intent.operationId, "hex");
  const operationBinding = Buffer.from(input.intent.operationBindingSha256, "hex");
  const sourceDigest = createHash("sha256").update(input.newBytes).digest();
  try {
    const attribution = createHmac("sha256", derivedKey)
      .update(PENDING_ATTRIBUTION_DOMAIN)
      .update(basenameBytes)
      .update(Buffer.from([0]))
      .update(operationId)
      .update(operationBinding)
      .update(sourceDigest)
      .digest("hex");
    return path.join(
      input.root,
      `.${basename}.aud065-new-${attribution}`
    );
  } finally {
    derivedKey.fill(0);
    basenameBytes.fill(0);
    operationId.fill(0);
    operationBinding.fill(0);
    sourceDigest.fill(0);
  }
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function expectCode(fn, code) {
  let captured;
  assert.throws(fn, error => {
    captured = error;
    return error instanceof ProcessLocalSourceTransitionError;
  });
  assert.equal(captured.code, code);
}

test("snapshots verbatim full sources and binds both digests into the operation HMAC", () => {
  const input = fixture();
  try {
    const oldSnapshot = fs.readFileSync(
      path.join(input.operationDirectory, "old-values-source.yaml")
    );
    const newSnapshot = fs.readFileSync(
      path.join(input.operationDirectory, "new-values-source.yaml")
    );
    assert.equal(oldSnapshot.equals(input.oldBytes), true);
    assert.equal(newSnapshot.equals(input.newBytes), true);
    assert.equal(input.intent.oldValuesSourceSha256, sha256(input.oldBytes));
    assert.equal(input.intent.newValuesSourceSha256, sha256(input.newBytes));
    assert.notEqual(input.intent.oldValuesSourceSha256, input.intent.newValuesSourceSha256);
    assert.equal(verifyProcessLocalValuesSourceTransition({
      operationDirectory: input.operationDirectory,
      canonicalValuesPath: input.canonicalValuesPath,
      expectedState: "old",
      ...continuity(input)
    }), PROCESS_LOCAL_SOURCE_TRANSITION_TOKENS.canonicalOld);
    for (const name of ["old-values-source.yaml", "new-values-source.yaml"]) {
      const stat = fs.lstatSync(path.join(input.operationDirectory, name));
      assert.equal(stat.mode & 0o7777, 0o600);
      assert.equal(stat.nlink, 1);
    }
  } finally {
    cleanup(input.root);
  }
});

test("snapshot CLI is idempotent and silent for the same private full sources", () => {
  const input = fixture({ seal: false });
  try {
    const result = spawnSync(process.execPath, [
      CLI,
      "snapshot",
      "--operation-directory", input.operationDirectory,
      "--old-values-source", input.oldValuesSource,
      "--new-values-source", input.newValuesSource
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(fs.readFileSync(
      path.join(input.operationDirectory, "old-values-source.yaml")
    ).equals(input.oldBytes), true);
    assert.equal(fs.readFileSync(
      path.join(input.operationDirectory, "new-values-source.yaml")
    ).equals(input.newBytes), true);
  } finally {
    cleanup(input.root);
  }
});

test("every preventive and candidate-only source secret must rotate", () => {
  const oldValues = sourceValues("old");
  for (const name of requiredRotations) {
    const newValues = sourceValues("new");
    newValues[name] = oldValues[name];
    expectCode(() => validateProcessLocalValuesSourceTransition({
      oldBytes: yamlBytes(oldValues),
      newBytes: yamlBytes(newValues)
    }), "required_source_secret_not_rotated");
  }
});

test("document start presence and line ending are immutable across the source transition", () => {
  const oldValues = sourceValues("old");
  const newValues = sourceValues("new");
  assert.equal(validateProcessLocalValuesSourceTransition({
    oldBytes: yamlBytes(oldValues),
    newBytes: yamlBytes(newValues)
  }), PROCESS_LOCAL_SOURCE_TRANSITION_TOKENS.transitionVerified);
  assert.equal(validateProcessLocalValuesSourceTransition({
    oldBytes: yamlBytes(oldValues, "", { documentStart: false }),
    newBytes: yamlBytes(newValues, "", { documentStart: false })
  }), PROCESS_LOCAL_SOURCE_TRANSITION_TOKENS.transitionVerified);
  assert.equal(validateProcessLocalValuesSourceTransition({
    oldBytes: yamlBytes(oldValues, "", { lineEnding: "\r\n" }),
    newBytes: yamlBytes(newValues, "", { lineEnding: "\r\n" })
  }), PROCESS_LOCAL_SOURCE_TRANSITION_TOKENS.transitionVerified);
  expectCode(() => validateProcessLocalValuesSourceTransition({
    oldBytes: yamlBytes(oldValues),
    newBytes: yamlBytes(newValues, "", { documentStart: false })
  }), "source_document_start_changed");
  expectCode(() => validateProcessLocalValuesSourceTransition({
    oldBytes: yamlBytes(oldValues),
    newBytes: yamlBytes(newValues, "", { lineEnding: "\r\n" })
  }), "source_document_start_changed");
});

test("source transition accepts OLD legacy PERMS_KEY only and requires canonical NEW", () => {
  const oldValues = sourceValues("old");
  const newValues = sourceValues("new");
  assert.equal(validateProcessLocalValuesSourceTransition({
    oldBytes: yamlBytes(oldValues, "", { permsLiteralBlock: true }),
    newBytes: yamlBytes(newValues)
  }), PROCESS_LOCAL_SOURCE_TRANSITION_TOKENS.transitionVerified);
  assert.equal(validateProcessLocalValuesSourceTransition({
    oldBytes: yamlBytes(oldValues, "", {
      lineEnding: "\r\n",
      permsLiteralBlock: true
    }),
    newBytes: yamlBytes(newValues, "", { lineEnding: "\r\n" })
  }), PROCESS_LOCAL_SOURCE_TRANSITION_TOKENS.transitionVerified);
  expectCode(() => validateProcessLocalValuesSourceTransition({
    oldBytes: yamlBytes(oldValues),
    newBytes: yamlBytes(newValues, "", { permsLiteralBlock: true })
  }), "new_source_perms_key_not_canonical");
  expectCode(() => validateProcessLocalValuesSourceTransition({
    oldBytes: yamlBytes(oldValues, "", { permsLiteralBlock: true }),
    newBytes: yamlBytes(newValues, "", { permsLiteralBlock: true })
  }), "new_source_perms_key_not_canonical");
});

test("source transition rejects the same PERMS public key in another serialization", () => {
  const oldValues = sourceValues("old");
  const samePublicKey = sourceValues("new");
  samePublicKey.PERMS_KEY = createPrivateKey(
    oldValues.PERMS_KEY.replace(/\\n/gu, "\n")
  ).export({ type: "pkcs1", format: "pem" }).replace(/\r?\n/gu, "\\n");
  expectCode(() => validateProcessLocalValuesSourceTransition({
    oldBytes: yamlBytes(oldValues, "", { permsLiteralBlock: true }),
    newBytes: yamlBytes(samePublicKey)
  }), "required_source_secret_not_rotated");
});

test("configured optional secrets rotate with stable presence", () => {
  const oldValues = sourceValues("old");
  const unchanged = sourceValues("new");
  unchanged.SKETCHFAB_API_KEY = oldValues.SKETCHFAB_API_KEY;
  expectCode(() => validateProcessLocalValuesSourceTransition({
    oldBytes: yamlBytes(oldValues),
    newBytes: yamlBytes(unchanged)
  }), "configured_source_secret_not_rotated");

  const removed = sourceValues("new");
  removed.TENOR_API_KEY = "";
  expectCode(() => validateProcessLocalValuesSourceTransition({
    oldBytes: yamlBytes(oldValues),
    newBytes: yamlBytes(removed)
  }), "optional_source_secret_presence_changed");

  const bothEmptyOld = sourceValues("old");
  const bothEmptyNew = sourceValues("new");
  bothEmptyOld.SKETCHFAB_API_KEY = "";
  bothEmptyNew.SKETCHFAB_API_KEY = "";
  assert.equal(validateProcessLocalValuesSourceTransition({
    oldBytes: yamlBytes(bothEmptyOld),
    newBytes: yamlBytes(bothEmptyNew)
  }), PROCESS_LOCAL_SOURCE_TRANSITION_TOKENS.transitionVerified);
});

test("allows the snapshot-derived JWT to be absent while preserving source keysets", () => {
  const absentOld = sourceValues("old");
  const absentNew = sourceValues("new");
  delete absentOld.PGRST_JWT_SECRET;
  delete absentNew.PGRST_JWT_SECRET;
  assert.equal(validateProcessLocalValuesSourceTransition({
    oldBytes: yamlBytes(absentOld),
    newBytes: yamlBytes(absentNew)
  }), PROCESS_LOCAL_SOURCE_TRANSITION_TOKENS.transitionVerified);

  const presentOld = sourceValues("old");
  const missingNew = sourceValues("new");
  delete missingNew.PGRST_JWT_SECRET;
  expectCode(() => validateProcessLocalValuesSourceTransition({
    oldBytes: yamlBytes(presentOld),
    newBytes: yamlBytes(missingNew)
  }), "source_keyset_changed");
});

test("only the allowlisted rotation and derived keys may change", () => {
  const oldValues = sourceValues("old");
  const unauthorized = sourceValues("new");
  unauthorized.UNRELATED_CANDIDATE_INPUT = "drift";
  expectCode(() => validateProcessLocalValuesSourceTransition({
    oldBytes: yamlBytes(oldValues),
    newBytes: yamlBytes(unauthorized)
  }), "unauthorized_source_value_changed");

  const missing = sourceValues("new");
  delete missing.UNRELATED_CANDIDATE_INPUT;
  expectCode(() => validateProcessLocalValuesSourceTransition({
    oldBytes: yamlBytes(oldValues),
    newBytes: yamlBytes(missing)
  }), "source_keyset_changed");

  const added = sourceValues("new");
  added.FOREIGN_KEY = "foreign";
  expectCode(() => validateProcessLocalValuesSourceTransition({
    oldBytes: yamlBytes(oldValues),
    newBytes: yamlBytes(added)
  }), "source_keyset_changed");
});

test("four bot domains are distinct printable values of at least 32 characters", () => {
  const oldValues = sourceValues("old");
  for (const mutate of [
    values => { values.BOT_RUNNER_ACCESS_KEY = "short"; },
    values => { values.BOT_ORCHESTRATOR_ACCESS_KEY = values.BOT_ACCESS_KEY; },
    values => { values.DASHBOARD_ACCESS_KEY = `${"x".repeat(31)} `; }
  ]) {
    const newValues = sourceValues("new");
    mutate(newValues);
    expectCode(() => validateProcessLocalValuesSourceTransition({
      oldBytes: yamlBytes(oldValues),
      newBytes: yamlBytes(newValues)
    }), "new_internal_credential_contract_invalid");
  }
});

test("new DB_PASS and both pull configs satisfy the decoded Docker auth contract", () => {
  const oldValues = sourceValues("old");
  for (const invalid of [
    "x".repeat(31),
    `${"x".repeat(32)}!`,
    `${"x".repeat(129)}`
  ]) {
    const newValues = sourceValues("new");
    newValues.DB_PASS = invalid;
    expectCode(() => validateProcessLocalValuesSourceTransition({
      oldBytes: yamlBytes(oldValues),
      newBytes: yamlBytes(newValues)
    }), "new_db_password_contract_invalid");
  }
  for (const invalid of ["not base64!", "aaaa", Buffer.from(JSON.stringify({
    auths: {}
  })).toString("base64")]) {
    const invalidPull = sourceValues("new");
    invalidPull.BOT_IMAGE_PULL_CONFIG_JSON_BASE64 = invalid;
    expectCode(() => validateProcessLocalValuesSourceTransition({
      oldBytes: yamlBytes(oldValues),
      newBytes: yamlBytes(invalidPull)
    }), "new_pull_config_contract_invalid");
  }
  const sameCredential = sourceValues("new");
  const oldCredential = JSON.parse(Buffer.from(
    oldValues.BOT_IMAGE_PULL_CONFIG_JSON_BASE64,
    "base64"
  ).toString("utf8"));
  sameCredential.BOT_IMAGE_PULL_CONFIG_JSON_BASE64 = Buffer.from(
    JSON.stringify({ auths: { "ghcr.io": oldCredential.auths["ghcr.io"] } }, null, 2),
    "utf8"
  ).toString("base64");
  expectCode(() => validateProcessLocalValuesSourceTransition({
    oldBytes: yamlBytes(oldValues),
    newBytes: yamlBytes(sameCredential)
  }), "pull_config_credential_not_rotated");
});

test("promotion is exact, atomic, private and reentrant without an old plaintext backup", () => {
  const input = fixture();
  try {
    assert.equal(promoteProcessLocalValuesSource({
      operationDirectory: input.operationDirectory,
      canonicalValuesPath: input.canonicalValuesPath,
      ...continuity(input)
    }), PROCESS_LOCAL_SOURCE_TRANSITION_TOKENS.promoted);
    assert.equal(fs.readFileSync(input.canonicalValuesPath).equals(input.newBytes), true);
    assert.equal(fs.lstatSync(input.canonicalValuesPath).mode & 0o7777, 0o600);
    assert.equal(promoteProcessLocalValuesSource({
      operationDirectory: input.operationDirectory,
      canonicalValuesPath: input.canonicalValuesPath,
      ...continuity(input)
    }), PROCESS_LOCAL_SOURCE_TRANSITION_TOKENS.alreadyPromoted);
    assert.equal(verifyProcessLocalValuesSourceTransition({
      operationDirectory: input.operationDirectory,
      canonicalValuesPath: input.canonicalValuesPath,
      expectedState: "new",
      ...continuity(input)
    }), PROCESS_LOCAL_SOURCE_TRANSITION_TOKENS.canonicalNew);
    assert.deepEqual(
      fs.readdirSync(input.root).filter(name => name.includes("aud065-new-")),
      []
    );
  } finally {
    cleanup(input.root);
  }
});

test("promotion refuses third-party canonical bytes and never overwrites them", () => {
  const input = fixture();
  try {
    const third = Buffer.from("UNRELATED: exact-third-state\n", "utf8");
    fs.writeFileSync(input.canonicalValuesPath, third, { mode: 0o600 });
    expectCode(() => promoteProcessLocalValuesSource({
      operationDirectory: input.operationDirectory,
      canonicalValuesPath: input.canonicalValuesPath,
      ...continuity(input)
    }), "canonical_source_state_invalid");
    assert.equal(fs.readFileSync(input.canonicalValuesPath).equals(third), true);
  } finally {
    cleanup(input.root);
  }
});

test("serialized comparison detects pre-rename drift and preserves the drifting state", () => {
  const input = fixture();
  try {
    const drift = Buffer.from("DRIFT: concurrent-owner-state\n", "utf8");
    expectCode(() => promoteProcessLocalValuesSource({
      operationDirectory: input.operationDirectory,
      canonicalValuesPath: input.canonicalValuesPath,
      ...continuity(input),
      hooks: {
        beforeFinalCompare() {
          fs.writeFileSync(input.canonicalValuesPath, drift, { mode: 0o600 });
        }
      }
    }), "canonical_source_cas_mismatch");
    assert.equal(fs.readFileSync(input.canonicalValuesPath).equals(drift), true);
    assert.deepEqual(
      fs.readdirSync(input.root).filter(name => name.includes("aud065-new-")),
      []
    );
  } finally {
    cleanup(input.root);
  }
});

test("canonical promotion rejects a group-writable parent", () => {
  const input = fixture();
  try {
    fs.chmodSync(input.root, 0o770);
    expectCode(() => promoteProcessLocalValuesSource({
      operationDirectory: input.operationDirectory,
      canonicalValuesPath: input.canonicalValuesPath,
      ...continuity(input)
    }), "source_transition_verification_failed");
    assert.equal(fs.readFileSync(input.canonicalValuesPath).equals(input.oldBytes), true);
  } finally {
    fs.chmodSync(input.root, 0o700);
    cleanup(input.root);
  }
});

test("a cut after rename resumes as already promoted and never restores old", () => {
  const input = fixture();
  try {
    expectCode(() => promoteProcessLocalValuesSource({
      operationDirectory: input.operationDirectory,
      canonicalValuesPath: input.canonicalValuesPath,
      ...continuity(input),
      hooks: {
        afterRenameBeforeFsync() {
          throw new Error("simulated-cut");
        }
      }
    }), "canonical_source_promotion_failed");
    assert.equal(fs.readFileSync(input.canonicalValuesPath).equals(input.newBytes), true);
    assert.equal(promoteProcessLocalValuesSource({
      operationDirectory: input.operationDirectory,
      canonicalValuesPath: input.canonicalValuesPath,
      ...continuity(input)
    }), PROCESS_LOCAL_SOURCE_TRANSITION_TOKENS.alreadyPromoted);
    assert.equal(fs.readFileSync(input.canonicalValuesPath).equals(input.oldBytes), false);
  } finally {
    cleanup(input.root);
  }
});

test("a SIGKILL after pending fsync is reconciled deterministically on reentry", () => {
  const input = fixture();
  try {
    const child = String.raw`
      import { promoteProcessLocalValuesSource } from ${JSON.stringify(
        pathToFileURL(CLI).href
      )};
      const [operationDirectory, canonicalValuesPath, operationId, binding] =
        process.argv.slice(1);
      promoteProcessLocalValuesSource({
        operationDirectory,
        canonicalValuesPath,
        expectedOperationId: operationId,
        expectedOperationBindingSha256: binding,
        hooks: {
          afterPendingFsync() {
            process.kill(process.pid, "SIGKILL");
          }
        }
      });
    `;
    const result = spawnSync(process.execPath, [
      "--input-type=module",
      "--eval", child,
      input.operationDirectory,
      input.canonicalValuesPath,
      input.intent.operationId,
      input.intent.operationBindingSha256
    ], { encoding: "utf8" });
    assert.equal(result.status, null);
    assert.equal(result.signal, "SIGKILL");
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(fs.readFileSync(input.canonicalValuesPath).equals(input.oldBytes), true);

    const pendingPath = transitionPendingPath(input);
    assert.equal(fs.readFileSync(pendingPath).equals(input.newBytes), true);
    assert.equal(fs.lstatSync(pendingPath).mode & 0o7777, 0o600);

    assert.equal(promoteProcessLocalValuesSource({
      operationDirectory: input.operationDirectory,
      canonicalValuesPath: input.canonicalValuesPath,
      ...continuity(input)
    }), PROCESS_LOCAL_SOURCE_TRANSITION_TOKENS.promoted);
    assert.equal(fs.readFileSync(input.canonicalValuesPath).equals(input.newBytes), true);
    assert.equal(fs.existsSync(pendingPath), false);
  } finally {
    cleanup(input.root);
  }
});

test("reentry completes an authenticated partial pending left before fsync", () => {
  const input = fixture();
  try {
    const pendingPath = transitionPendingPath(input);
    const partial = input.newBytes.subarray(0, Math.floor(input.newBytes.length / 3));
    writePrivate(pendingPath, partial);
    assert.equal(promoteProcessLocalValuesSource({
      operationDirectory: input.operationDirectory,
      canonicalValuesPath: input.canonicalValuesPath,
      ...continuity(input)
    }), PROCESS_LOCAL_SOURCE_TRANSITION_TOKENS.promoted);
    assert.equal(fs.readFileSync(input.canonicalValuesPath).equals(input.newBytes), true);
    assert.equal(fs.existsSync(pendingPath), false);
  } finally {
    cleanup(input.root);
  }
});

test("foreign deterministic pending bytes are never overwritten or removed", () => {
  const beforePromotion = fixture();
  try {
    const pendingPath = transitionPendingPath(beforePromotion);
    const foreign = Buffer.from("FOREIGN: operation-name-collision\n", "utf8");
    writePrivate(pendingPath, foreign);
    expectCode(() => promoteProcessLocalValuesSource({
      operationDirectory: beforePromotion.operationDirectory,
      canonicalValuesPath: beforePromotion.canonicalValuesPath,
      ...continuity(beforePromotion)
    }), "canonical_source_write_failed");
    assert.equal(
      fs.readFileSync(beforePromotion.canonicalValuesPath).equals(beforePromotion.oldBytes),
      true
    );
    assert.equal(fs.readFileSync(pendingPath).equals(foreign), true);
  } finally {
    cleanup(beforePromotion.root);
  }

  const afterPromotion = fixture();
  try {
    assert.equal(promoteProcessLocalValuesSource({
      operationDirectory: afterPromotion.operationDirectory,
      canonicalValuesPath: afterPromotion.canonicalValuesPath,
      ...continuity(afterPromotion)
    }), PROCESS_LOCAL_SOURCE_TRANSITION_TOKENS.promoted);
    const pendingPath = transitionPendingPath(afterPromotion);
    const foreign = Buffer.from("FOREIGN: stale-name-after-promotion\n", "utf8");
    writePrivate(pendingPath, foreign);
    expectCode(() => promoteProcessLocalValuesSource({
      operationDirectory: afterPromotion.operationDirectory,
      canonicalValuesPath: afterPromotion.canonicalValuesPath,
      ...continuity(afterPromotion)
    }), "canonical_source_pending_invalid");
    assert.equal(
      fs.readFileSync(afterPromotion.canonicalValuesPath).equals(afterPromotion.newBytes),
      true
    );
    assert.equal(fs.readFileSync(pendingPath).equals(foreign), true);
  } finally {
    cleanup(afterPromotion.root);
  }
});

test("a foreign prefix without the operation HMAC attribution is preserved", () => {
  const input = fixture();
  try {
    const foreignPath = path.join(
      input.root,
      `.${path.basename(input.canonicalValuesPath)}.aud065-new-${"0".repeat(64)}`
    );
    const foreignPrefix = Buffer.from(
      input.newBytes.subarray(0, Math.floor(input.newBytes.length / 4))
    );
    writePrivate(foreignPath, foreignPrefix);
    assert.equal(promoteProcessLocalValuesSource({
      operationDirectory: input.operationDirectory,
      canonicalValuesPath: input.canonicalValuesPath,
      ...continuity(input)
    }), PROCESS_LOCAL_SOURCE_TRANSITION_TOKENS.promoted);
    assert.equal(fs.readFileSync(input.canonicalValuesPath).equals(input.newBytes), true);
    assert.equal(fs.readFileSync(foreignPath).equals(foreignPrefix), true);
    assert.equal(fs.existsSync(transitionPendingPath(input)), false);
  } finally {
    cleanup(input.root);
  }
});

test("parent replacement aborts with old canonical and anchored pending cleanup", () => {
  const input = fixture();
  const movedRoot = `${input.root}-original`;
  const decoy = Buffer.from("DECOY: replacement-parent-state\n", "utf8");
  try {
    assert.throws(() => promoteProcessLocalValuesSource({
      operationDirectory: input.operationDirectory,
      canonicalValuesPath: input.canonicalValuesPath,
      ...continuity(input),
      hooks: {
        afterPendingFsync() {
          fs.renameSync(input.root, movedRoot);
          fs.mkdirSync(input.root, { mode: 0o700 });
          writePrivate(path.join(input.root, "canonical.yaml"), decoy);
        }
      }
    }), error => error instanceof ProcessLocalSourceTransitionError);
    assert.equal(
      fs.readFileSync(path.join(movedRoot, "canonical.yaml")).equals(input.oldBytes),
      true
    );
    assert.equal(fs.readFileSync(input.canonicalValuesPath).equals(decoy), true);
    assert.deepEqual(
      fs.readdirSync(movedRoot).filter(name => name.includes("aud065-new-")),
      []
    );
    assert.deepEqual(
      fs.readdirSync(input.root).filter(name => name.includes("aud065-new-")),
      []
    );
  } finally {
    cleanup(input.root);
    cleanup(movedRoot);
  }
});

test("swap-and-restore cannot divert pending bytes or their cleanup to a decoy", () => {
  const input = fixture();
  const movedRoot = `${input.root}-original`;
  const decoyRoot = `${input.root}-decoy`;
  const decoy = Buffer.from("DECOY: transient-parent-state\n", "utf8");
  try {
    expectCode(() => promoteProcessLocalValuesSource({
      operationDirectory: input.operationDirectory,
      canonicalValuesPath: input.canonicalValuesPath,
      ...continuity(input),
      hooks: {
        afterPendingFsync() {
          fs.renameSync(input.root, movedRoot);
          fs.mkdirSync(input.root, { mode: 0o700 });
          writePrivate(path.join(input.root, "canonical.yaml"), decoy);
          fs.renameSync(input.root, decoyRoot);
          fs.renameSync(movedRoot, input.root);
          throw new Error("simulated-cut-after-parent-swap");
        }
      }
    }), "canonical_source_promotion_failed");
    assert.equal(fs.readFileSync(input.canonicalValuesPath).equals(input.oldBytes), true);
    assert.equal(fs.readFileSync(path.join(decoyRoot, "canonical.yaml")).equals(decoy), true);
    assert.deepEqual(
      fs.readdirSync(input.root).filter(name => name.includes("aud065-new-")),
      []
    );
    assert.deepEqual(
      fs.readdirSync(decoyRoot).filter(name => name.includes("aud065-new-")),
      []
    );
  } finally {
    cleanup(input.root);
    cleanup(movedRoot);
    cleanup(decoyRoot);
  }
});

test("intent continuity, full-source tamper and unsafe canonical files fail closed", () => {
  const continuityDrift = fixture();
  try {
    expectCode(() => verifyProcessLocalValuesSourceTransition({
      operationDirectory: continuityDrift.operationDirectory,
      canonicalValuesPath: continuityDrift.canonicalValuesPath,
      expectedState: "old",
      expectedOperationId: "f".repeat(32),
      expectedOperationBindingSha256: continuityDrift.intent.operationBindingSha256
    }), "source_transition_verification_failed");

    fs.writeFileSync(
      path.join(continuityDrift.operationDirectory, "new-values-source.yaml"),
      Buffer.from("SECRET: tampered-private-source\n", "utf8"),
      { mode: 0o600 }
    );
    expectCode(() => verifyProcessLocalValuesSourceTransition({
      operationDirectory: continuityDrift.operationDirectory,
      canonicalValuesPath: continuityDrift.canonicalValuesPath,
      expectedState: "old",
      ...continuity(continuityDrift)
    }), "source_transition_verification_failed");
  } finally {
    cleanup(continuityDrift.root);
  }

  const loose = fixture();
  try {
    fs.chmodSync(loose.canonicalValuesPath, 0o640);
    expectCode(() => promoteProcessLocalValuesSource({
      operationDirectory: loose.operationDirectory,
      canonicalValuesPath: loose.canonicalValuesPath,
      ...continuity(loose)
    }), "canonical_source_invalid");
  } finally {
    cleanup(loose.root);
  }

  const linked = fixture();
  try {
    fs.linkSync(linked.canonicalValuesPath, path.join(linked.root, "hardlink.yaml"));
    expectCode(() => promoteProcessLocalValuesSource({
      operationDirectory: linked.operationDirectory,
      canonicalValuesPath: linked.canonicalValuesPath,
      ...continuity(linked)
    }), "canonical_source_invalid");
  } finally {
    cleanup(linked.root);
  }
});

test("CLI is silent on success and exposes only one generic value-free failure", () => {
  const input = fixture();
  try {
    const common = [
      "--operation-directory", input.operationDirectory,
      "--expected-operation-id", input.intent.operationId,
      "--expected-operation-binding-sha256", input.intent.operationBindingSha256,
      "--canonical-values", input.canonicalValuesPath
    ];
    for (const args of [
      ["verify", ...common, "--expected-state", "old"],
      ["promote", ...common],
      ["verify", ...common, "--expected-state", "new"]
    ]) {
      const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    }
    const secret = sourceValues("new").BOT_RUNNER_ACCESS_KEY;
    fs.writeFileSync(input.canonicalValuesPath, `${secret}\n`, { mode: 0o600 });
    const failed = spawnSync(process.execPath, [
      CLI, "verify", ...common, "--expected-state", "new"
    ], { encoding: "utf8" });
    assert.equal(failed.status, 1);
    assert.equal(failed.stdout, "");
    assert.equal(failed.stderr, "process-local source transition failed closed\n");
    assert.equal(failed.stderr.includes(secret), false);
    assert.equal(failed.stderr.includes(input.intent.operationBindingSha256), false);
  } finally {
    cleanup(input.root);
  }
});

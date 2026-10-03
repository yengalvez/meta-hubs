import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CHECKPOINT_ABORT_JOURNAL_HMAC_PROFILE,
  RecoveryCheckpointAuthorityError,
  canonicalJsonV1,
  createCheckpointAbortJournalSeal,
  createKeyRecord,
  importKeyRecord,
  validateCheckpointAbortJournalSeal
} from "../../deployment/recovery-checkpoint-authority.mjs";

const keyId = "12345678-1234-4abc-8def-1234567890ab";
const otherKeyId = "87654321-4321-4abc-8def-1234567890ab";
const domain = Buffer.from("yenhubs/checkpoint-abort-journal/v1\0", "ascii");

function expectCode(callback, code) {
  assert.throws(callback, error =>
    error instanceof RecoveryCheckpointAuthorityError && error.code === code &&
    error.message === code
  );
}

function expectRedactedFailure(callback) {
  assert.throws(callback, error => {
    assert.ok(error instanceof RecoveryCheckpointAuthorityError);
    assert.equal(error.message, error.code);
    assert.doesNotMatch(JSON.stringify(error), /private-|PRIVATE_|recovery_token|key_base64/u);
    return true;
  });
}

function writeRecord(filePath, record) {
  fs.writeFileSync(filePath, canonicalJsonV1(record), { mode: 0o600, flag: "wx" });
  fs.chmodSync(filePath, 0o600);
}

function fixture(t, { existingRecord = true } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "yenhubs-journal-seal-"));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const keyringPath = path.join(root, "keyring");
  fs.mkdirSync(keyringPath, { mode: 0o700 });
  fs.chmodSync(keyringPath, 0o700);
  const keyBytes = Buffer.alloc(32, 0x5a);
  const keyRecord = createKeyRecord({ keyId, keyBytes });
  const keyPath = path.join(keyringPath, `${keyId}.json`);
  if (existingRecord) writeRecord(keyPath, keyRecord);
  const journal = {
    schema: 3,
    authoritySha256: "a".repeat(64),
    planHash: "b".repeat(64),
    operation: "0123456789abcdef0123456789abcdef",
    stage: "lock-delete-complete",
    steps: { "lock-delete": { intent: "recorded", result: "verified" } },
    events: [{ action: "lock-delete", status: "verified", sequence: 1 }],
    deploymentGenerations: [{ name: "reticulum", pausedGeneration: 10 }],
    privateFixtureMarker: "private-journal-body-marker"
  };
  return {
    root, keyPath, keyBytes, keyRecord,
    request: { keyringPath, keyId, receiptSha256: "c".repeat(64), journal }
  };
}

function manualHmac(material, selectedDomain = domain) {
  const bytes = Buffer.from(canonicalJsonV1({
    receipt_sha256: material.request.receiptSha256,
    journal: material.request.journal
  }), "utf8");
  try {
    return createHmac("sha256", material.keyBytes).update(selectedDomain).update(bytes).digest("hex");
  } finally {
    bytes.fill(0);
  }
}

test("journal seal authenticates the exact canonical unsigned journal and receipt digest", t => {
  const material = fixture(t);
  const seal = createCheckpointAbortJournalSeal(material.request);
  assert.deepEqual(Object.keys(seal).sort(), [
    "hmac_sha256", "journal_sha256", "key_id", "profile", "receipt_sha256", "schema_version"
  ]);
  assert.equal(seal.schema_version, 1);
  assert.equal(seal.profile, CHECKPOINT_ABORT_JOURNAL_HMAC_PROFILE);
  assert.equal(seal.key_id, keyId);
  assert.equal(seal.receipt_sha256, material.request.receiptSha256);
  assert.equal(seal.journal_sha256,
    createHash("sha256").update(canonicalJsonV1(material.request.journal)).digest("hex"));
  assert.equal(seal.hmac_sha256, manualHmac(material));
  assert.equal(validateCheckpointAbortJournalSeal({ ...material.request, seal }), seal);
  const reordered = Object.fromEntries(Object.entries(material.request.journal).reverse());
  assert.deepEqual(createCheckpointAbortJournalSeal({
    ...material.request, journal: reordered
  }), seal);
});

test("journal seal rejects receipt, journal digest and HMAC changes independently", t => {
  const { request } = fixture(t);
  const seal = createCheckpointAbortJournalSeal(request);
  for (const field of ["receipt_sha256", "journal_sha256", "hmac_sha256"]) {
    expectCode(() => validateCheckpointAbortJournalSeal({
      ...request, seal: { ...seal, [field]: "f".repeat(64) }
    }), "abort_journal_seal_authentication");
  }
  expectCode(() => validateCheckpointAbortJournalSeal({
    ...request, receiptSha256: "d".repeat(64), seal
  }), "abort_journal_seal_authentication");
  for (const mutate of [
    journal => { journal.authoritySha256 = "e".repeat(64); },
    journal => { journal.stage = "prepared"; },
    journal => { journal.events[0].status = "unverified"; },
    journal => { journal.deploymentGenerations[0].pausedGeneration += 1; },
    journal => { journal.privateFixtureMarker = "private-changed-marker"; }
  ]) {
    const journal = structuredClone(request.journal);
    mutate(journal);
    expectCode(() => validateCheckpointAbortJournalSeal({
      ...request, journal, seal
    }), "abort_journal_seal_authentication");
  }
});

test("journal seal has a closed domain and selected key with no version fallback", t => {
  const material = fixture(t);
  const seal = createCheckpointAbortJournalSeal(material.request);
  const crossed = {
    ...seal,
    hmac_sha256: manualHmac(material,
      Buffer.from("yenhubs/checkpoint-backup-authority/v2\0", "ascii"))
  };
  expectCode(() => validateCheckpointAbortJournalSeal({
    ...material.request, seal: crossed
  }), "abort_journal_seal_authentication");
  const otherRecord = createKeyRecord({ keyId: otherKeyId, keyBytes: Buffer.alloc(32, 0x33) });
  writeRecord(path.join(material.request.keyringPath, `${otherKeyId}.json`), otherRecord);
  expectCode(() => validateCheckpointAbortJournalSeal({
    ...material.request, keyId: otherKeyId, seal: { ...seal, key_id: otherKeyId }
  }), "abort_journal_seal_authentication");
});

test("unsigned journal requires schema3/authoritySha256 and excludes explicit authentication", t => {
  const { request } = fixture(t);
  const seal = createCheckpointAbortJournalSeal(request);
  for (const journal of [
    null, undefined,
    { ...request.journal, schema: 2 },
    { ...request.journal, schema: "3" },
    { ...request.journal, authoritySha256: "unknown" },
    { ...request.journal, authoritySha256: ["a".repeat(64)] },
    { ...request.journal, authentication: null },
    { ...request.journal, authentication: undefined }
  ]) {
    expectCode(() => createCheckpointAbortJournalSeal({ ...request, journal }), "abort_journal_schema");
    expectCode(() => validateCheckpointAbortJournalSeal({ ...request, journal, seal }), "abort_journal_schema");
  }
});

test("journal bodies reject nested sparse or undefined arrays and noncanonical JSON values", t => {
  const { request } = fixture(t);
  const seal = createCheckpointAbortJournalSeal(request);
  const mutators = [
    journal => { delete journal.events[0]; },
    journal => { journal.events = new Array(1); },
    journal => { journal.steps.nested = { values: new Array(5) }; },
    journal => { journal.events[0] = undefined; },
    journal => { journal.steps.nested = { value: undefined }; },
    journal => { journal.events[0].sequence = 1.5; },
    journal => { journal.events[0].sequence = 1n; },
    journal => { journal.steps.cycle = journal; }
  ];
  for (const mutate of mutators) {
    const journal = structuredClone(request.journal);
    mutate(journal);
    expectRedactedFailure(() => createCheckpointAbortJournalSeal({ ...request, journal }));
    expectRedactedFailure(() => validateCheckpointAbortJournalSeal({ ...request, journal, seal }));
  }
});

test("journal seal requests are closed and require explicit keyring, ID and seal", t => {
  const { request, keyRecord } = fixture(t);
  const seal = createCheckpointAbortJournalSeal(request);
  for (const field of ["keyringPath", "keyId", "receiptSha256", "journal"]) {
    const missing = { ...request };
    delete missing[field];
    expectCode(() => createCheckpointAbortJournalSeal(missing), "abort_journal_request_schema");
    expectCode(() => validateCheckpointAbortJournalSeal({ ...missing, seal }), "abort_journal_request_schema");
  }
  expectCode(() => validateCheckpointAbortJournalSeal(request), "abort_journal_request_schema");
  for (const supplied of [null, undefined]) expectCode(() => validateCheckpointAbortJournalSeal({
    ...request, seal: supplied
  }), "abort_journal_seal_schema");
  for (const extra of [{ keyRecord }, { seal }, { validator() {} }, { extra: true }]) {
    expectCode(() => createCheckpointAbortJournalSeal({ ...request, ...extra }), "abort_journal_request_schema");
  }
  expectCode(() => validateCheckpointAbortJournalSeal({
    ...request, seal, keyRecord
  }), "abort_journal_request_schema");
  for (const receiptSha256 of [null, undefined, "unknown", "C".repeat(64), ["c".repeat(64)]]) {
    expectCode(() => createCheckpointAbortJournalSeal({ ...request, receiptSha256 }), "abort_journal_receipt_sha256");
  }
  for (const invalidKeyId of [null, undefined, "unknown", [keyId]]) {
    expectCode(() => createCheckpointAbortJournalSeal({ ...request, keyId: invalidKeyId }), "key_record_id");
  }
});

test("journal seal rejects unknown or extra fields, profiles, IDs and malformed digests", t => {
  const { request } = fixture(t);
  const seal = createCheckpointAbortJournalSeal(request);
  for (const changed of [
    { ...seal, extra: true },
    { ...seal, schema_version: 2 },
    { ...seal, profile: "yenhubs-checkpoint-abort-journal-hmac-v2" },
    { ...seal, profile: null },
    { ...seal, key_id: otherKeyId },
    { ...seal, receipt_sha256: "unknown" },
    { ...seal, journal_sha256: "A".repeat(64) },
    { ...seal, hmac_sha256: undefined },
    { ...seal, hmac_sha256: [seal.hmac_sha256] }
  ]) expectCode(() => validateCheckpointAbortJournalSeal({
    ...request, seal: changed
  }), "abort_journal_seal_schema");
  for (const field of Object.keys(seal)) {
    const missing = { ...seal };
    delete missing[field];
    expectCode(() => validateCheckpointAbortJournalSeal({
      ...request, seal: missing
    }), "abort_journal_seal_schema");
  }
});

test("candidate remains unusable until explicit import and neither seal API creates/imports keys", t => {
  const { root, keyRecord, request } = fixture(t, { existingRecord: false });
  const candidatePath = path.join(root, "candidate.json");
  writeRecord(candidatePath, keyRecord);
  const before = fs.readFileSync(candidatePath);
  expectCode(() => createCheckpointAbortJournalSeal({
    ...request, keyringPath: candidatePath
  }), "keyring_directory");
  expectCode(() => createCheckpointAbortJournalSeal(request), "key_record_file");
  assert.deepEqual(fs.readdirSync(request.keyringPath), []);
  assert.deepEqual(fs.readFileSync(candidatePath), before);
  assert.equal(importKeyRecord({
    sourcePath: candidatePath, keyringPath: request.keyringPath
  }).status, "imported");
  const seal = createCheckpointAbortJournalSeal(request);
  assert.equal(validateCheckpointAbortJournalSeal({ ...request, seal }), seal);
  const missingKeyring = path.join(root, "not-created");
  expectCode(() => validateCheckpointAbortJournalSeal({
    ...request, keyringPath: missingKeyring, seal
  }), "keyring_directory");
  assert.equal(fs.existsSync(missingKeyring), false);
  assert.deepEqual(fs.readdirSync(request.keyringPath), [`${keyId}.json`]);
  assert.deepEqual(fs.readFileSync(candidatePath), before);
});

test("seal APIs retain safe keyring permissions and do not mutate files or input objects", t => {
  const { keyPath, request } = fixture(t);
  const recordBefore = fs.readFileSync(keyPath);
  const requestBefore = canonicalJsonV1(request);
  const seal = createCheckpointAbortJournalSeal(request);
  validateCheckpointAbortJournalSeal({ ...request, seal });
  assert.equal(canonicalJsonV1(request), requestBefore);
  assert.deepEqual(fs.readFileSync(keyPath), recordBefore);
  assert.deepEqual(fs.readdirSync(request.keyringPath), [`${keyId}.json`]);
  fs.chmodSync(keyPath, 0o644);
  expectCode(() => createCheckpointAbortJournalSeal(request), "key_record_file");
  expectCode(() => validateCheckpointAbortJournalSeal({ ...request, seal }), "key_record_file");
  fs.chmodSync(keyPath, 0o600);
  fs.chmodSync(request.keyringPath, 0o755);
  expectCode(() => createCheckpointAbortJournalSeal(request), "keyring_directory");
});

test("seal projection and redacted errors do not disclose body, keys or runtime mutations", t => {
  const { request, keyRecord } = fixture(t);
  const argvBefore = [...process.argv];
  const envBefore = { ...process.env };
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  const output = [];
  process.stdout.write = value => { output.push(String(value)); return true; };
  process.stderr.write = value => { output.push(String(value)); return true; };
  let seal;
  try {
    seal = createCheckpointAbortJournalSeal(request);
    validateCheckpointAbortJournalSeal({ ...request, seal });
    expectRedactedFailure(() => validateCheckpointAbortJournalSeal({
      ...request, seal: { ...seal, hmac_sha256: "f".repeat(64) }
    }));
    const journal = structuredClone(request.journal);
    Object.defineProperty(journal, "privateProperty", {
      enumerable: true,
      get() { throw new Error("private-getter-marker"); }
    });
    expectCode(() => createCheckpointAbortJournalSeal({ ...request, journal }), "abort_journal_authentication");
    const badRequest = { ...request };
    Object.defineProperty(badRequest, "keyId", {
      enumerable: true,
      get() { throw new Error("private-getter-marker"); }
    });
    expectCode(() => createCheckpointAbortJournalSeal(badRequest), "abort_journal_authentication");
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  const publicProjection = canonicalJsonV1(seal);
  assert.doesNotMatch(publicProjection, /private-|journal"|planHash|steps|events|deploymentGenerations|key_base64/u);
  assert.equal(publicProjection.includes(keyRecord.key_base64), false);
  assert.deepEqual(output, []);
  assert.deepEqual(process.argv, argvBefore);
  assert.deepEqual({ ...process.env }, envBefore);
});

test("seal APIs sanitize forged typed errors from journal and keyId getters", async t => {
  const { request } = fixture(t);
  const seal = createCheckpointAbortJournalSeal(request);
  assert.equal(validateCheckpointAbortJournalSeal({ ...request, seal }), seal);
  const attacks = [
    {
      name: "typed private code",
      error() { return new RecoveryCheckpointAuthorityError("private-injected-error-code"); }
    },
    {
      name: "typed allowed code with private properties",
      error() {
        const error = new RecoveryCheckpointAuthorityError("abort_journal_schema");
        error.privateBody = { marker: "private-injected-body", recovery_token: "private-injected-token" };
        Object.defineProperty(error, "hiddenPrivateBody", { value: "private-injected-hidden" });
        return error;
      }
    }
  ];
  for (const attack of attacks) {
    for (const source of ["journal", "keyId"]) {
      for (const operation of ["create", "validate"]) {
        await t.test(`${attack.name}: ${source} getter: ${operation}`, () => {
          const injectedError = attack.error();
          const badRequest = operation === "validate" ? { ...request, seal } : { ...request };
          if (source === "journal") {
            const journal = structuredClone(request.journal);
            Object.defineProperty(journal, "privateProperty", {
              enumerable: true,
              get() { throw injectedError; }
            });
            badRequest.journal = journal;
          } else {
            Object.defineProperty(badRequest, "keyId", {
              enumerable: true,
              get() { throw injectedError; }
            });
          }
          assert.throws(() => operation === "create"
            ? createCheckpointAbortJournalSeal(badRequest)
            : validateCheckpointAbortJournalSeal(badRequest), error => {
            assert.ok(error instanceof RecoveryCheckpointAuthorityError);
            assert.ok(["abort_journal_authentication", "abort_journal_schema"].includes(error.code));
            assert.equal(error.message, error.code);
            assert.doesNotMatch(JSON.stringify(error), /private-injected|privateBody|recovery_token/u);
            assert.doesNotMatch(String(error.stack), /private-injected/u);
            assert.deepEqual(Object.getOwnPropertyNames(error).filter(name =>
              !["stack", "message", "name", "code"].includes(name)
            ), []);
            assert.notEqual(error, injectedError);
            return true;
          });
        });
      }
    }
  }
});

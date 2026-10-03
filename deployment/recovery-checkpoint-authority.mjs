#!/usr/bin/env node

import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

import {
  PrivateArtifactPublicationError,
  publishPrivateArtifact,
  readPublishedPrivateArtifact
} from "./private-artifact-publication.mjs";

export const CANONICAL_JSON_PROFILE = "canonical-json-v1";
export const AUTHORITY_HMAC_PROFILE =
  "yenhubs-checkpoint-backup-authority-hmac-v1";
export const AUTHORITY_HMAC_PROFILE_V2 =
  "yenhubs-checkpoint-backup-authority-hmac-v2";
export const CHECKPOINT_ABORT_JOURNAL_HMAC_PROFILE =
  "yenhubs-checkpoint-abort-journal-hmac-v1";
export const CHECKPOINT_BACKUP_LOCK_NAME = "yenhubs-recovery-operation-lock";
export const KEY_RECORD_SCHEMA = "checkpoint-backup-key-record-v1";
export const KEY_RECORD_STATUS = Object.freeze({
  candidate: "candidate-created",
  imported: "imported",
  present: "already-present",
  valid: "valid"
});

const AUTHORITY_DOMAIN = Buffer.from(
  "yenhubs/checkpoint-backup-authority/v1\0",
  "ascii"
);
const AUTHORITY_DOMAIN_V2 = Buffer.from(
  "yenhubs/checkpoint-backup-authority/v2\0",
  "ascii"
);
const ABORT_JOURNAL_DOMAIN = Buffer.from(
  "yenhubs/checkpoint-abort-journal/v1\0",
  "ascii"
);
const KEY_RECORD_DOMAIN = Buffer.from(
  "yenhubs/checkpoint-backup-key-record/v1\0",
  "ascii"
);
const AUTHORITY_MAX_BYTES = 16 * 1024;
const CLI_REQUEST_MAX_BYTES = 16 * 1024 * 1024;
const KEY_RECORD_MAX_BYTES = 4096;
const MAX_JSON_DEPTH = 256;
const ZERO_SHA256 = "0".repeat(64);
const HEX_32 = /^[a-f0-9]{32}$/u;
const HEX_64 = /^[a-f0-9]{64}$/u;
const UUID_V4 =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const CHECKPOINT_STAMP = /^[0-9]{8}-[0-9]{6}$/u;
const DNS_LABEL = /^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/u;
const SAFE_TOKEN = /^[A-Za-z0-9._:@/+\-=]+$/u;
const KEY_FILE =
  /^([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.json$/u;
const KEY_PENDING_FILE =
  /^\.([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.json\.pending-v1-[a-f0-9]{32}-[a-f0-9]{64}$/u;
const CONSUMER_NAMES = Object.freeze([
  "bot-orchestrator",
  "coturn",
  "pgbouncer",
  "pgbouncer-t",
  "reticulum"
]);

export class RecoveryCheckpointAuthorityError extends Error {
  constructor(code) {
    super(code);
    this.name = "RecoveryCheckpointAuthorityError";
    this.code = code;
  }
}

function reject(code) {
  throw new RecoveryCheckpointAuthorityError(code);
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function utf16Compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJsonInner(value, active, depth) {
  if (depth > MAX_JSON_DEPTH) reject("canonical_json_depth");
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) reject("canonical_json_number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (active.has(value)) reject("canonical_json_cycle");
    active.add(value);
    try {
      return `[${value.map(item => canonicalJsonInner(item, active, depth + 1)).join(",")}]`;
    } finally {
      active.delete(value);
    }
  }
  if (!isRecord(value)) reject("canonical_json_type");
  if (active.has(value)) reject("canonical_json_cycle");
  active.add(value);
  try {
    const entries = Object.keys(value).sort(utf16Compare).map(key =>
      `${JSON.stringify(key)}:${canonicalJsonInner(value[key], active, depth + 1)}`
    );
    return `{${entries.join(",")}}`;
  } finally {
    active.delete(value);
  }
}

export function canonicalJsonV1(value) {
  return canonicalJsonInner(value, new Set(), 0);
}

class DuplicateSafeJsonParser {
  constructor(source) {
    this.source = source;
    this.index = 0;
  }

  error() {
    reject("canonical_json_parse");
  }

  skipWhitespace() {
    while (/[\u0009\u000a\u000d\u0020]/u.test(this.source[this.index] || "")) {
      this.index += 1;
    }
  }

  parse() {
    this.skipWhitespace();
    const result = this.value(0);
    this.skipWhitespace();
    if (this.index !== this.source.length) this.error();
    return result;
  }

  value(depth) {
    if (depth > MAX_JSON_DEPTH) reject("canonical_json_depth");
    this.skipWhitespace();
    const character = this.source[this.index];
    if (character === "{") return this.object(depth + 1);
    if (character === "[") return this.array(depth + 1);
    if (character === '"') return this.string();
    if (character === "t" && this.consume("true")) return true;
    if (character === "f" && this.consume("false")) return false;
    if (character === "n" && this.consume("null")) return null;
    return this.number();
  }

  consume(token) {
    if (!this.source.startsWith(token, this.index)) return false;
    this.index += token.length;
    return true;
  }

  string() {
    const start = this.index;
    this.index += 1;
    let escaped = false;
    while (this.index < this.source.length) {
      const code = this.source.charCodeAt(this.index);
      if (!escaped && code === 0x22) {
        this.index += 1;
        try {
          return JSON.parse(this.source.slice(start, this.index));
        } catch {
          this.error();
        }
      }
      if (!escaped && code < 0x20) this.error();
      if (!escaped && code === 0x5c) {
        escaped = true;
      } else {
        escaped = false;
      }
      this.index += 1;
    }
    this.error();
  }

  number() {
    const remaining = this.source.slice(this.index);
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(remaining);
    if (!match) this.error();
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isSafeInteger(value)) reject("canonical_json_number");
    return value;
  }

  array(depth) {
    const result = [];
    this.index += 1;
    this.skipWhitespace();
    if (this.source[this.index] === "]") {
      this.index += 1;
      return result;
    }
    while (true) {
      result.push(this.value(depth));
      this.skipWhitespace();
      if (this.source[this.index] === "]") {
        this.index += 1;
        return result;
      }
      if (this.source[this.index] !== ",") this.error();
      this.index += 1;
    }
  }

  object(depth) {
    const result = Object.create(null);
    const keys = new Set();
    this.index += 1;
    this.skipWhitespace();
    if (this.source[this.index] === "}") {
      this.index += 1;
      return result;
    }
    while (true) {
      this.skipWhitespace();
      if (this.source[this.index] !== '"') this.error();
      const key = this.string();
      if (keys.has(key)) reject("canonical_json_duplicate_key");
      keys.add(key);
      this.skipWhitespace();
      if (this.source[this.index] !== ":") this.error();
      this.index += 1;
      result[key] = this.value(depth);
      this.skipWhitespace();
      if (this.source[this.index] === "}") {
        this.index += 1;
        return result;
      }
      if (this.source[this.index] !== ",") this.error();
      this.index += 1;
    }
  }
}

function bytesFrom(input, maximumBytes) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length < 1 || bytes.length > maximumBytes ||
      (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) {
    reject("canonical_json_bytes");
  }
  return bytes;
}

export function parseCanonicalJsonV1(input, { maximumBytes = AUTHORITY_MAX_BYTES } = {}) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    reject("canonical_json_limit");
  }
  const bytes = bytesFrom(input, maximumBytes);
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    reject("canonical_json_utf8");
  }
  const value = new DuplicateSafeJsonParser(source).parse();
  if (canonicalJsonV1(value) !== source) reject("canonical_json_not_canonical");
  return value;
}

function exactKeys(value, expected) {
  return isRecord(value) &&
    canonicalJsonV1(Object.keys(value).sort(utf16Compare)) ===
      canonicalJsonV1([...expected].sort(utf16Compare));
}

function requiredString(value, code, { pattern, maximum = 256 } = {}) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum ||
      /[\u0000-\u001f\u007f]/u.test(value) || (pattern && !pattern.test(value))) {
    reject(code);
  }
  return value;
}

function requiredSafeInteger(value, code, { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) reject(code);
  return value;
}

function validateIdentity(value, code, expectedName) {
  if (!exactKeys(value, ["name", "uid"]) || typeof expectedName !== "string" ||
      requiredString(value.name, code, { pattern: DNS_LABEL, maximum: 63 }) !== expectedName ||
      !requiredString(value.uid, code, { pattern: SAFE_TOKEN })) {
    reject(code);
  }
}

function validateConsumer(value, expectedName, { minimumReplicas = 1 } = {}) {
  if (!exactKeys(value, [
    "name", "uid", "initial_resource_version", "initial_generation",
    "original_replicas", "selector"
  ]) || value.name !== expectedName || value.selector !== expectedName) {
    reject("authority_consumer_schema");
  }
  requiredString(value.uid, "authority_consumer_uid", { pattern: SAFE_TOKEN });
  requiredString(value.initial_resource_version, "authority_consumer_rv", {
    pattern: SAFE_TOKEN
  });
  requiredSafeInteger(value.initial_generation, "authority_consumer_generation", {
    minimum: 1
  });
  requiredSafeInteger(value.original_replicas, "authority_consumer_replicas", {
    minimum: minimumReplicas
  });
}

function validateNamespaceFence(value, expectedName) {
  if (!exactKeys(value, [
    "name", "uid", "initial_resource_version", "phase", "metadata_name_label"
  ]) || value.name !== expectedName || value.metadata_name_label !== expectedName ||
      value.phase !== "Active") {
    reject("authority_fence_namespace_schema");
  }
  requiredString(value.uid, "authority_fence_namespace_uid", { pattern: SAFE_TOKEN });
  requiredString(value.initial_resource_version, "authority_fence_namespace_rv", {
    pattern: SAFE_TOKEN
  });
}

function validateOperationFence(value, namespaceName, generation) {
  if (generation === "legacy-absent") {
    if (value !== null) reject("authority_legacy_fence");
    return;
  }
  if (!exactKeys(value, ["state", "namespaces", "policy", "binding"]) ||
      value.state !== "dormant" || !exactKeys(value.namespaces, ["parent", "runner"])) {
    reject("authority_fence_schema");
  }
  validateNamespaceFence(value.namespaces.parent, namespaceName);
  validateNamespaceFence(value.namespaces.runner, "hcce-bot-runners");
  if (!exactKeys(value.policy, [
    "uid", "initial_resource_version", "initial_generation", "spec_sha256"
  ])) {
    reject("authority_fence_policy_schema");
  }
  requiredString(value.policy.uid, "authority_fence_policy_uid", { pattern: SAFE_TOKEN });
  requiredString(value.policy.initial_resource_version, "authority_fence_policy_rv", {
    pattern: SAFE_TOKEN
  });
  requiredSafeInteger(value.policy.initial_generation, "authority_fence_policy_generation", {
    minimum: 1
  });
  requiredString(value.policy.spec_sha256, "authority_fence_policy_sha", {
    pattern: HEX_64,
    maximum: 64
  });
  if (!exactKeys(value.binding, [
    "uid", "initial_resource_version", "dormant_spec_sha256", "active_spec_sha256"
  ])) {
    reject("authority_fence_binding_schema");
  }
  requiredString(value.binding.uid, "authority_fence_binding_uid", {
    pattern: SAFE_TOKEN
  });
  requiredString(value.binding.initial_resource_version, "authority_fence_binding_rv", {
    pattern: SAFE_TOKEN
  });
  for (const field of ["dormant_spec_sha256", "active_spec_sha256"]) {
    requiredString(value.binding[field], "authority_fence_binding_sha", {
      pattern: HEX_64,
      maximum: 64
    });
  }
}

function validatePublicAuthority(value, { includeHmac, schemaVersion = 1 }) {
  const keys = [
    "schema_version", "operation_id", "namespace", "pvc", "hmac_profile",
    "hmac_key_id", "runner_generation", "operation_fence", "consumers"
  ];
  if (includeHmac) keys.push("authority_hmac_sha256");
  if (![1, 2].includes(schemaVersion) || !exactKeys(value, keys) ||
      value.schema_version !== schemaVersion ||
      value.hmac_profile !== (schemaVersion === 2
        ? AUTHORITY_HMAC_PROFILE_V2
        : AUTHORITY_HMAC_PROFILE) ||
      !HEX_32.test(value.operation_id || "") ||
      !UUID_V4.test(value.hmac_key_id || "") ||
      !["legacy-absent", "durable-v2"].includes(value.runner_generation) ||
      !Array.isArray(value.consumers) || value.consumers.length !== CONSUMER_NAMES.length) {
    reject("authority_schema");
  }
  if (!isRecord(value.namespace)) reject("authority_namespace");
  validateIdentity(value.namespace, "authority_namespace", value.namespace.name);
  validateIdentity(value.pvc, "authority_pvc", "ret-pvc");
  value.consumers.forEach((consumer, index) =>
    validateConsumer(consumer, CONSUMER_NAMES[index], {
      minimumReplicas: schemaVersion === 2 ? 0 : 1
    })
  );
  validateOperationFence(
    value.operation_fence,
    value.namespace.name,
    value.runner_generation
  );
  if (includeHmac && !HEX_64.test(value.authority_hmac_sha256 || "")) {
    reject("authority_hmac_schema");
  }
  if (includeHmac && Buffer.byteLength(canonicalJsonV1(value), "utf8") > AUTHORITY_MAX_BYTES) {
    reject("authority_size");
  }
  return value;
}

function validatePublicAuthorityVersioned(value, { includeHmac }) {
  if (!isRecord(value) || ![1, 2].includes(value.schema_version)) {
    reject("authority_schema");
  }
  return validatePublicAuthority(value, {
    includeHmac,
    schemaVersion: value.schema_version
  });
}

function publicAuthorityWithoutHmac(authority) {
  const result = Object.create(null);
  for (const key of Object.keys(authority)) {
    if (key !== "authority_hmac_sha256") result[key] = authority[key];
  }
  return result;
}

function validateLockBinding(value, publicAuthority) {
  const required = [
    "name", "namespace", "owner", "operation_id", "recovery_token",
    "namespace_uid", "pvc_uid", "checkpoint_stamp", "dump_sha256",
    "storage_sha256"
  ];
  if (!exactKeys(value, required) ||
      value.name !== CHECKPOINT_BACKUP_LOCK_NAME ||
      value.owner !== "checkpoint-backup" ||
      value.operation_id !== publicAuthority.operation_id ||
      value.namespace !== publicAuthority.namespace.name ||
      value.namespace_uid !== publicAuthority.namespace.uid ||
      value.pvc_uid !== publicAuthority.pvc.uid ||
      !HEX_32.test(value.recovery_token || "") ||
      value.dump_sha256 !== ZERO_SHA256 || value.storage_sha256 !== ZERO_SHA256) {
    reject("authority_lock_binding");
  }
  requiredString(value.checkpoint_stamp, "authority_checkpoint_stamp", {
    pattern: CHECKPOINT_STAMP,
    maximum: 15
  });
  canonicalJsonV1(value);
}

function validateDeploymentContracts(contracts, publicAuthority) {
  if (!Array.isArray(contracts) || contracts.length !== CONSUMER_NAMES.length) {
    reject("authority_deployment_contracts");
  }
  contracts.forEach((contract, index) => {
    const consumer = publicAuthority.consumers[index];
    if (!exactKeys(contract, [
      "api_version", "kind", "namespace", "name", "uid", "spec_without_replicas"
    ]) || contract.api_version !== "apps/v1" || contract.kind !== "Deployment" ||
        contract.namespace !== publicAuthority.namespace.name ||
        contract.name !== CONSUMER_NAMES[index] || contract.uid !== consumer.uid ||
        !isRecord(contract.spec_without_replicas) ||
        Object.hasOwn(contract.spec_without_replicas, "replicas")) {
      reject("authority_deployment_contract_schema");
    }
    canonicalJsonV1(contract.spec_without_replicas);
  });
}

function keyBuffer(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/u.test(value)) {
    reject("key_record_key_base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== value) {
    decoded.fill(0);
    reject("key_record_key_base64");
  }
  return decoded;
}

export function keyRecordVerificationHmac(keyBytes, keyId) {
  if (!Buffer.isBuffer(keyBytes) || keyBytes.length !== 32 || !UUID_V4.test(keyId || "")) {
    reject("key_record_vector_input");
  }
  return createHmac("sha256", keyBytes)
    .update(KEY_RECORD_DOMAIN)
    .update(Buffer.from(keyId, "ascii"))
    .digest("hex");
}

export function createKeyRecord({ keyId = randomUUID(), keyBytes = randomBytes(32) } = {}) {
  if (!Buffer.isBuffer(keyBytes) || keyBytes.length !== 32 || !UUID_V4.test(keyId)) {
    reject("key_record_create_input");
  }
  return {
    schema_version: 1,
    key_id: keyId,
    key_base64: keyBytes.toString("base64"),
    verification_hmac_sha256: keyRecordVerificationHmac(keyBytes, keyId)
  };
}

export function validateKeyRecord(value, { expectedKeyId } = {}) {
  if (!exactKeys(value, [
    "schema_version", "key_id", "key_base64", "verification_hmac_sha256"
  ]) || value.schema_version !== 1 || !UUID_V4.test(value.key_id || "") ||
      (expectedKeyId !== undefined && value.key_id !== expectedKeyId) ||
      !HEX_64.test(value.verification_hmac_sha256 || "")) {
    reject("key_record_schema");
  }
  const key = keyBuffer(value.key_base64);
  try {
    const expected = Buffer.from(keyRecordVerificationHmac(key, value.key_id), "hex");
    const actual = Buffer.from(value.verification_hmac_sha256, "hex");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      reject("key_record_vector");
    }
  } finally {
    key.fill(0);
  }
  return value;
}

export function parseKeyRecord(input, { expectedKeyId } = {}) {
  return validateKeyRecord(
    parseCanonicalJsonV1(input, { maximumBytes: KEY_RECORD_MAX_BYTES }),
    { expectedKeyId }
  );
}

function computeAuthorityHmac({
  keyBytes,
  lockBinding,
  publicAuthority,
  deploymentContracts
}, schemaVersion) {
  if (!Buffer.isBuffer(keyBytes) || keyBytes.length !== 32) {
    reject("authority_key");
  }
  validatePublicAuthority(publicAuthority, { includeHmac: false, schemaVersion });
  validateLockBinding(lockBinding, publicAuthority);
  validateDeploymentContracts(deploymentContracts, publicAuthority);
  const bodyBytes = Buffer.from(canonicalJsonV1({
    lock_binding: lockBinding,
    public_authority: publicAuthority,
    deployment_contracts: deploymentContracts
  }), "utf8");
  try {
    return createHmac("sha256", keyBytes)
      .update(schemaVersion === 2 ? AUTHORITY_DOMAIN_V2 : AUTHORITY_DOMAIN)
      .update(bodyBytes)
      .digest("hex");
  } finally {
    bodyBytes.fill(0);
  }
}

export function computeCheckpointBackupAuthorityHmac({
  keyBytes,
  lockBinding,
  publicAuthority,
  deploymentContracts
}) {
  return computeAuthorityHmac({
    keyBytes,
    lockBinding,
    publicAuthority,
    deploymentContracts
  }, 1);
}

export function createCheckpointBackupAuthority({
  keyRecord,
  lockBinding,
  publicAuthority,
  deploymentContracts
}) {
  validateKeyRecord(keyRecord, { expectedKeyId: publicAuthority?.hmac_key_id });
  const key = keyBuffer(keyRecord.key_base64);
  try {
    const authority = {
      ...publicAuthority,
      authority_hmac_sha256: computeCheckpointBackupAuthorityHmac({
        keyBytes: key,
        lockBinding,
        publicAuthority,
        deploymentContracts
      })
    };
    validatePublicAuthority(authority, { includeHmac: true });
    const bytes = Buffer.from(canonicalJsonV1(authority), "utf8");
    if (bytes.length > AUTHORITY_MAX_BYTES) reject("authority_size");
    return authority;
  } finally {
    key.fill(0);
  }
}

export function validateCheckpointBackupAuthority({
  keyRecord,
  lockBinding,
  authority,
  deploymentContracts
}) {
  validatePublicAuthority(authority, { includeHmac: true });
  validateKeyRecord(keyRecord, { expectedKeyId: authority.hmac_key_id });
  const publicAuthority = publicAuthorityWithoutHmac(authority);
  const key = keyBuffer(keyRecord.key_base64);
  try {
    const expected = Buffer.from(computeCheckpointBackupAuthorityHmac({
      keyBytes: key,
      lockBinding,
      publicAuthority,
      deploymentContracts
    }), "hex");
    const actual = Buffer.from(authority.authority_hmac_sha256, "hex");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      reject("authority_hmac");
    }
  } finally {
    key.fill(0);
  }
  return authority;
}

export function parseCheckpointBackupAuthority(input) {
  return validatePublicAuthority(
    parseCanonicalJsonV1(input, { maximumBytes: AUTHORITY_MAX_BYTES }),
    { includeHmac: true }
  );
}

export function parseCheckpointBackupAuthorityVersioned(input) {
  return validatePublicAuthorityVersioned(
    parseCanonicalJsonV1(input, { maximumBytes: AUTHORITY_MAX_BYTES }),
    { includeHmac: true }
  );
}

function denseOwnArray(value, expectedLength) {
  if (!Array.isArray(value) || value.length !== expectedLength) return false;
  for (let index = 0; index < expectedLength; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}

function validateVersionedAuthorityRequest(request, { create = false } = {}) {
  const keys = [
    "keyringPath", "keyId", "lockBinding", "deploymentContracts",
    create ? "publicAuthority" : "authority"
  ];
  if (!create && isRecord(request) && Object.hasOwn(request, "consumerContract")) {
    keys.push("consumerContract");
  }
  if (!exactKeys(request, keys)) reject("authority_request_schema");
  const authority = create ? request.publicAuthority : request.authority;
  if (!isRecord(authority) || !denseOwnArray(authority.consumers, CONSUMER_NAMES.length)) {
    reject("authority_schema");
  }
  if (!denseOwnArray(request.deploymentContracts, CONSUMER_NAMES.length)) {
    reject("authority_deployment_contracts");
  }
  validatePublicAuthority(authority, {
    includeHmac: !create,
    schemaVersion: create ? 2 : authority?.schema_version
  });
  if (request.keyId !== authority.hmac_key_id) reject("authority_key_id");
  return authority;
}

function validateAuthorityConsumerContract(contract, authority) {
  const consumerVersion = authority.schema_version === 1 ? 2 : 3;
  if (!exactKeys(contract, [
    "schema_version", "operation_id", "authority_sha256", "consumers"
  ]) || contract.schema_version !== consumerVersion ||
      contract.operation_id !== authority.operation_id ||
      !HEX_64.test(contract.authority_sha256 || "") ||
      !Array.isArray(contract.consumers)) {
    reject("authority_consumer_contract_schema");
  }
  if (!denseOwnArray(contract.consumers, CONSUMER_NAMES.length)) {
    reject("authority_consumer_contract_binding");
  }
  const digest = createHash("sha256")
    .update(Buffer.from(canonicalJsonV1(authority), "utf8"))
    .digest("hex");
  if (contract.authority_sha256 !== digest ||
      canonicalJsonV1(contract.consumers) !== canonicalJsonV1(authority.consumers)) {
    reject("authority_consumer_contract_binding");
  }
}

// Only explicitly selected, already-imported records may sign authority v2.
// The existing key-record and keyring policies, and the v1 CLI, remain unchanged.
export function createCheckpointBackupAuthorityV2(request) {
  const publicAuthority = validateVersionedAuthorityRequest(request, { create: true });
  const loaded = loadKeyRecordForAuthority(request.keyringPath, request.keyId);
  let key;
  try {
    key = keyBuffer(loaded.record.key_base64);
    const authority = {
      ...publicAuthority,
      authority_hmac_sha256: computeAuthorityHmac({
        keyBytes: key,
        lockBinding: request.lockBinding,
        publicAuthority,
        deploymentContracts: request.deploymentContracts
      }, 2)
    };
    return validatePublicAuthority(authority, { includeHmac: true, schemaVersion: 2 });
  } finally {
    loaded.bytes.fill(0);
    if (key) key.fill(0);
  }
}

// Omitting consumerContract is a cryptographic primitive only. Operational
// callers must supply it to authenticate the closed authority/consumer pair.
export function validateCheckpointBackupAuthorityVersioned(request) {
  const authority = validateVersionedAuthorityRequest(request);
  const loaded = loadKeyRecordForAuthority(request.keyringPath, request.keyId);
  let key;
  try {
    key = keyBuffer(loaded.record.key_base64);
    const expected = Buffer.from(computeAuthorityHmac({
      keyBytes: key,
      lockBinding: request.lockBinding,
      publicAuthority: publicAuthorityWithoutHmac(authority),
      deploymentContracts: request.deploymentContracts
    }, authority.schema_version), "hex");
    const actual = Buffer.from(authority.authority_hmac_sha256, "hex");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      reject("authority_hmac");
    }
    if (Object.hasOwn(request, "consumerContract")) {
      validateAuthorityConsumerContract(request.consumerContract, authority);
    }
    return authority;
  } finally {
    loaded.bytes.fill(0);
    if (key) key.fill(0);
  }
}

function validateDenseJsonArrays(value, depth = 0) {
  if (depth > MAX_JSON_DEPTH) reject("abort_journal_schema");
  if (Array.isArray(value)) {
    if (!denseOwnArray(value, value.length)) reject("abort_journal_schema");
    for (let index = 0; index < value.length; index += 1) {
      validateDenseJsonArrays(value[index], depth + 1);
    }
  } else if (isRecord(value)) {
    for (const key of Object.keys(value)) {
      validateDenseJsonArrays(value[key], depth + 1);
    }
  }
}

function validateUnsignedAbortJournal(journal) {
  if (!isRecord(journal) || journal.schema !== 3 ||
      typeof journal.authoritySha256 !== "string" || !HEX_64.test(journal.authoritySha256) ||
      Object.hasOwn(journal, "authentication")) {
    reject("abort_journal_schema");
  }
  validateDenseJsonArrays(journal);
}

function validateAbortJournalRequest(request, { includeSeal = false } = {}) {
  const keys = ["keyringPath", "keyId", "receiptSha256", "journal"];
  if (includeSeal) keys.push("seal");
  if (!exactKeys(request, keys)) reject("abort_journal_request_schema");
  if (typeof request.keyId !== "string" || !UUID_V4.test(request.keyId)) reject("key_record_id");
  if (typeof request.receiptSha256 !== "string" || !HEX_64.test(request.receiptSha256)) {
    reject("abort_journal_receipt_sha256");
  }
}

const ABORT_JOURNAL_ERROR_CODES = new Set([
  "abort_journal_authentication", "abort_journal_receipt_sha256",
  "abort_journal_request_schema", "abort_journal_schema",
  "abort_journal_seal_authentication", "abort_journal_seal_schema",
  "canonical_json_bytes", "canonical_json_cycle", "canonical_json_depth",
  "canonical_json_duplicate_key", "canonical_json_limit", "canonical_json_not_canonical",
  "canonical_json_number", "canonical_json_parse", "canonical_json_type", "canonical_json_utf8",
  "key_record_file", "key_record_file_changed", "key_record_id", "key_record_key_base64",
  "key_record_path", "key_record_schema", "key_record_vector", "key_record_vector_input",
  "keyring_directory", "keyring_inventory", "keyring_path"
]);

function rejectUnexpectedAbortJournalError(error) {
  let code = "abort_journal_authentication";
  try {
    const candidate = error?.code;
    if (typeof candidate === "string" && ABORT_JOURNAL_ERROR_CODES.has(candidate)) {
      code = candidate;
    }
  } catch {
    // Caller-provided accessors are untrusted; never retain their thrown value.
  }
  // Reconstruct even allowed typed errors: message, properties and cause may be private.
  reject(code);
}

function computeAbortJournalAuthentication(request) {
  let journalBytes;
  let bodyBytes;
  let loaded;
  let key;
  try {
    validateUnsignedAbortJournal(request.journal);
    journalBytes = Buffer.from(canonicalJsonV1(request.journal), "utf8");
    const journal = parseCanonicalJsonV1(journalBytes, {
      maximumBytes: CLI_REQUEST_MAX_BYTES
    });
    validateUnsignedAbortJournal(journal);
    loaded = loadKeyRecordForAuthority(request.keyringPath, request.keyId);
    key = keyBuffer(loaded.record.key_base64);
    bodyBytes = Buffer.from(canonicalJsonV1({
      receipt_sha256: request.receiptSha256,
      journal
    }), "utf8");
    return {
      journalSha256: createHash("sha256").update(journalBytes).digest("hex"),
      hmacSha256: createHmac("sha256", key)
        .update(ABORT_JOURNAL_DOMAIN).update(bodyBytes).digest("hex")
    };
  } catch (error) {
    rejectUnexpectedAbortJournalError(error);
  } finally {
    if (journalBytes) journalBytes.fill(0);
    if (bodyBytes) bodyBytes.fill(0);
    if (loaded) loaded.bytes.fill(0);
    if (key) key.fill(0);
  }
}

// This seal authenticates bytes only; the operational journal schema and its
// terminal-state evidence must be independently validated by the Cloud caller.
export function createCheckpointAbortJournalSeal(request) {
  try {
    validateAbortJournalRequest(request);
    const authentication = computeAbortJournalAuthentication(request);
    return {
      schema_version: 1,
      profile: CHECKPOINT_ABORT_JOURNAL_HMAC_PROFILE,
      key_id: request.keyId,
      receipt_sha256: request.receiptSha256,
      journal_sha256: authentication.journalSha256,
      hmac_sha256: authentication.hmacSha256
    };
  } catch (error) {
    rejectUnexpectedAbortJournalError(error);
  }
}

export function validateCheckpointAbortJournalSeal(request) {
  try {
    validateAbortJournalRequest(request, { includeSeal: true });
    const { seal } = request;
    if (!exactKeys(seal, [
      "schema_version", "profile", "key_id", "receipt_sha256", "journal_sha256", "hmac_sha256"
    ]) || seal.schema_version !== 1 || seal.profile !== CHECKPOINT_ABORT_JOURNAL_HMAC_PROFILE ||
        seal.key_id !== request.keyId ||
        typeof seal.receipt_sha256 !== "string" || !HEX_64.test(seal.receipt_sha256) ||
        typeof seal.journal_sha256 !== "string" || !HEX_64.test(seal.journal_sha256) ||
        typeof seal.hmac_sha256 !== "string" || !HEX_64.test(seal.hmac_sha256)) {
      reject("abort_journal_seal_schema");
    }
    const authentication = computeAbortJournalAuthentication(request);
    const receiptMatches = timingSafeEqual(
      Buffer.from(seal.receipt_sha256, "hex"), Buffer.from(request.receiptSha256, "hex")
    );
    const journalMatches = timingSafeEqual(
      Buffer.from(seal.journal_sha256, "hex"), Buffer.from(authentication.journalSha256, "hex")
    );
    const hmacMatches = timingSafeEqual(
      Buffer.from(seal.hmac_sha256, "hex"), Buffer.from(authentication.hmacSha256, "hex")
    );
    if (!receiptMatches || !journalMatches || !hmacMatches) {
      reject("abort_journal_seal_authentication");
    }
    return seal;
  } catch (error) {
    rejectUnexpectedAbortJournalError(error);
  }
}

function resolvedPath(value, code) {
  if (typeof value !== "string" || value.length < 1 || value.includes("\0")) reject(code);
  return path.resolve(value);
}

function privateFileIdentity(filePath, maximumBytes) {
  let stat;
  try {
    stat = fs.lstatSync(filePath, { bigint: true });
  } catch {
    reject("key_record_file");
  }
  const uidMatches = typeof process.getuid !== "function" ||
    stat.uid === BigInt(process.getuid());
  if (!stat.isFile() || stat.isSymbolicLink() || !uidMatches ||
      Number(stat.mode & 0o7777n) !== 0o600 || stat.nlink !== 1n ||
      stat.size < 1n || stat.size > BigInt(maximumBytes)) {
    reject("key_record_file");
  }
  return stat;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid &&
    left.mode === right.mode && left.nlink === right.nlink && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function readKeyRecordFile(filePath, expectedKeyId) {
  const resolved = resolvedPath(filePath, "key_record_path");
  const before = privateFileIdentity(resolved, KEY_RECORD_MAX_BYTES);
  const bytes = readPublishedPrivateArtifact({
    outputPath: resolved,
    maximumBytes: KEY_RECORD_MAX_BYTES
  });
  try {
    const after = privateFileIdentity(resolved, KEY_RECORD_MAX_BYTES);
    if (!sameIdentity(before, after) || after.size !== BigInt(bytes.length)) {
      reject("key_record_file_changed");
    }
    return { record: parseKeyRecord(bytes, { expectedKeyId }), identity: after, bytes };
  } catch (error) {
    bytes.fill(0);
    throw error;
  }
}

function validateKeyringDirectory(keyringPath) {
  const resolved = resolvedPath(keyringPath, "keyring_path");
  let stat;
  try {
    stat = fs.lstatSync(resolved, { bigint: true });
  } catch {
    reject("keyring_directory");
  }
  const uidMatches = typeof process.getuid !== "function" ||
    stat.uid === BigInt(process.getuid());
  if (!stat.isDirectory() || stat.isSymbolicLink() || !uidMatches ||
      Number(stat.mode & 0o7777n) !== 0o700) {
    reject("keyring_directory");
  }
  return resolved;
}

function validateRecoverablePendingEntry(keyring, entry, recoveringKeyId) {
  const match = KEY_PENDING_FILE.exec(entry.name);
  if (!match || match[1] !== recoveringKeyId || !entry.isFile()) return undefined;
  let stat;
  try {
    stat = fs.lstatSync(path.join(keyring, entry.name), { bigint: true });
  } catch {
    reject("keyring_inventory");
  }
  const uidMatches = typeof process.getuid !== "function" ||
    stat.uid === BigInt(process.getuid());
  if (!stat.isFile() || stat.isSymbolicLink() || !uidMatches ||
      Number(stat.mode & 0o7777n) !== 0o600 || ![1n, 2n].includes(stat.nlink) ||
      stat.size < 0n || stat.size > BigInt(KEY_RECORD_MAX_BYTES)) {
    reject("keyring_inventory");
  }
  return stat;
}

function validateKeyring(keyringPath, { recoveringKeyId } = {}) {
  const resolved = validateKeyringDirectory(keyringPath);
  let entries;
  try {
    entries = fs.readdirSync(resolved, { withFileTypes: true });
  } catch {
    reject("keyring_directory");
  }
  const recoverablePending = new Map();
  for (const entry of entries) {
    const match = KEY_FILE.exec(entry.name);
    if (match && entry.isFile()) continue;
    const pendingStat = recoveringKeyId === undefined
      ? undefined
      : validateRecoverablePendingEntry(resolved, entry, recoveringKeyId);
    if (pendingStat === undefined) reject("keyring_inventory");
    recoverablePending.set(entry.name, pendingStat);
  }
  for (const entry of entries) {
    const match = KEY_FILE.exec(entry.name);
    if (!match || !entry.isFile()) continue;
    if (recoveringKeyId !== undefined && match[1] === recoveringKeyId &&
        recoverablePending.size > 0) {
      let targetStat;
      try {
        targetStat = fs.lstatSync(path.join(resolved, entry.name), { bigint: true });
      } catch {
        reject("keyring_inventory");
      }
      const linkedPending = [...recoverablePending.values()].filter(stat =>
        stat.dev === targetStat.dev && stat.ino === targetStat.ino
      );
      if (targetStat.nlink === 2n && linkedPending.length === 1 &&
          targetStat.isFile() && !targetStat.isSymbolicLink() &&
          Number(targetStat.mode & 0o7777n) === 0o600 && targetStat.size > 0n &&
          targetStat.size <= BigInt(KEY_RECORD_MAX_BYTES)) {
        continue;
      }
    }
    const loaded = readKeyRecordFile(path.join(resolved, entry.name), match[1]);
    loaded.bytes.fill(0);
  }
  return resolved;
}

function derivedKeyRecordPath(keyring, keyId) {
  const result = path.join(keyring, `${keyId}.json`);
  if (path.dirname(result) !== keyring || path.basename(result) !== `${keyId}.json`) {
    reject("key_record_path");
  }
  return result;
}

export function resolveKeyRecordPath(keyringPath, keyId) {
  if (!UUID_V4.test(keyId || "")) reject("key_record_id");
  const keyring = validateKeyring(keyringPath);
  return derivedKeyRecordPath(keyring, keyId);
}

export function createCandidateKeyRecord(outputPath) {
  const resolved = resolvedPath(outputPath, "key_candidate_path");
  if (KEY_FILE.test(path.basename(resolved))) reject("key_candidate_derived_name");
  try {
    fs.lstatSync(resolved);
    reject("key_candidate_exists");
  } catch (error) {
    if (error instanceof RecoveryCheckpointAuthorityError) throw error;
    if (error?.code !== "ENOENT") reject("key_candidate_path");
  }
  const keyBytes = randomBytes(32);
  let record;
  let bytes;
  try {
    record = createKeyRecord({ keyId: randomUUID(), keyBytes });
    bytes = Buffer.from(canonicalJsonV1(record), "utf8");
    if (!publishPrivateArtifact({
      outputPath: resolved,
      bytes,
      maximumBytes: KEY_RECORD_MAX_BYTES
    })) {
      reject("key_candidate_exists");
    }
    return Object.freeze({ key_id: record.key_id, status: KEY_RECORD_STATUS.candidate });
  } finally {
    keyBytes.fill(0);
    if (bytes) bytes.fill(0);
  }
}

export function importKeyRecord({ sourcePath, keyringPath }) {
  const source = readKeyRecordFile(sourcePath);
  let destinationBytes;
  try {
    const keyring = validateKeyring(keyringPath, {
      recoveringKeyId: source.record.key_id
    });
    const destinationPath = derivedKeyRecordPath(keyring, source.record.key_id);
    try {
      const destinationBefore = fs.lstatSync(destinationPath, { bigint: true });
      if (destinationBefore.dev === source.identity.dev &&
          destinationBefore.ino === source.identity.ino) {
        reject("key_record_source_destination_same");
      }
    } catch (error) {
      if (error instanceof RecoveryCheckpointAuthorityError) throw error;
      if (error?.code !== "ENOENT") reject("key_record_destination");
    }
    let published;
    try {
      published = publishPrivateArtifact({
        outputPath: destinationPath,
        bytes: source.bytes,
        maximumBytes: KEY_RECORD_MAX_BYTES
      });
    } catch (error) {
      if (error instanceof PrivateArtifactPublicationError) {
        if (error.code === "private_artifact_exists_mismatch") {
          reject("key_record_destination_conflict");
        }
        reject("key_record_destination");
      }
      throw error;
    }
    const destination = readKeyRecordFile(destinationPath, source.record.key_id);
    destinationBytes = destination.bytes;
    if (destination.identity.dev === source.identity.dev &&
        destination.identity.ino === source.identity.ino) {
      reject("key_record_source_destination_same");
    }
    if (destinationBytes.length !== source.bytes.length ||
        !timingSafeEqual(destinationBytes, source.bytes)) {
      reject("key_record_destination_conflict");
    }
    validateKeyring(keyringPath);
    return Object.freeze({
      key_id: source.record.key_id,
      status: published ? KEY_RECORD_STATUS.imported : KEY_RECORD_STATUS.present
    });
  } finally {
    source.bytes.fill(0);
    if (destinationBytes) destinationBytes.fill(0);
  }
}

export function inspectKeyRecord({ keyringPath, keyId }) {
  const recordPath = resolveKeyRecordPath(keyringPath, keyId);
  const loaded = readKeyRecordFile(recordPath, keyId);
  loaded.bytes.fill(0);
  return Object.freeze({
    key_id: keyId,
    schema: KEY_RECORD_SCHEMA,
    status: KEY_RECORD_STATUS.valid
  });
}

function loadKeyRecordForAuthority(keyringPath, keyId) {
  return readKeyRecordFile(resolveKeyRecordPath(keyringPath, keyId), keyId);
}

function cliOutput(value) {
  process.stdout.write(`${canonicalJsonV1(value)}\n`);
}

function readCliRequest() {
  const bytes = fs.readFileSync(0);
  try {
    return parseCanonicalJsonV1(bytes, { maximumBytes: CLI_REQUEST_MAX_BYTES });
  } finally {
    bytes.fill(0);
  }
}

function cliMain(argv) {
  if (argv[0] === "key" && argv[1] === "create-candidate" && argv.length === 3) {
    cliOutput(createCandidateKeyRecord(argv[2]));
    return;
  }
  if (argv[0] === "key" && argv[1] === "validate" && argv.length === 3) {
    const loaded = readKeyRecordFile(argv[2]);
    try {
      cliOutput({
        key_id: loaded.record.key_id,
        schema: KEY_RECORD_SCHEMA,
        status: KEY_RECORD_STATUS.valid
      });
    } finally {
      loaded.bytes.fill(0);
    }
    return;
  }
  if (argv[0] === "key" && argv[1] === "import" && argv.length === 4) {
    cliOutput(importKeyRecord({ sourcePath: argv[2], keyringPath: argv[3] }));
    return;
  }
  if (argv[0] === "key" && argv[1] === "inspect" && argv.length === 4) {
    cliOutput(inspectKeyRecord({ keyringPath: argv[2], keyId: argv[3] }));
    return;
  }
  if (argv[0] === "authority" && ["create-v2", "validate-versioned"].includes(argv[1]) &&
      argv.length === 4) {
    const request = readCliRequest();
    if (argv[1] === "create-v2" && exactKeys(request, [
      "lock_binding", "public_authority", "deployment_contracts"
    ])) {
      cliOutput(createCheckpointBackupAuthorityV2({
        keyringPath: argv[2],
        keyId: argv[3],
        lockBinding: request.lock_binding,
        publicAuthority: request.public_authority,
        deploymentContracts: request.deployment_contracts
      }));
      return;
    }
    if (argv[1] === "validate-versioned" && exactKeys(request, [
      "lock_binding", "authority", "deployment_contracts", "consumer_contract"
    ])) {
      const authority = validateCheckpointBackupAuthorityVersioned({
        keyringPath: argv[2],
        keyId: argv[3],
        lockBinding: request.lock_binding,
        authority: request.authority,
        deploymentContracts: request.deployment_contracts,
        consumerContract: request.consumer_contract
      });
      cliOutput({
        key_id: authority.hmac_key_id,
        profile: authority.hmac_profile,
        status: KEY_RECORD_STATUS.valid
      });
      return;
    }
    reject("arguments_invalid");
  }
  if (argv[0] === "authority" && ["create", "validate"].includes(argv[1]) &&
      argv.length === 4) {
    const loaded = loadKeyRecordForAuthority(argv[2], argv[3]);
    try {
      const request = readCliRequest();
      if (argv[1] === "create" && exactKeys(request, [
        "lock_binding", "public_authority", "deployment_contracts"
      ])) {
        cliOutput(createCheckpointBackupAuthority({
          keyRecord: loaded.record,
          lockBinding: request.lock_binding,
          publicAuthority: request.public_authority,
          deploymentContracts: request.deployment_contracts
        }));
        return;
      }
      if (argv[1] === "validate" && exactKeys(request, [
        "lock_binding", "authority", "deployment_contracts"
      ])) {
        const authority = validateCheckpointBackupAuthority({
          keyRecord: loaded.record,
          lockBinding: request.lock_binding,
          authority: request.authority,
          deploymentContracts: request.deployment_contracts
        });
        cliOutput({
          key_id: authority.hmac_key_id,
          profile: authority.hmac_profile,
          status: KEY_RECORD_STATUS.valid
        });
        return;
      }
      reject("arguments_invalid");
    } finally {
      loaded.bytes.fill(0);
    }
  }
  reject("arguments_invalid");
}

const nodeEvalOrPrint = process.execArgv.some(argument =>
  argument === "-pe" || /^(?:-e|--eval|-p|--print)(?:=|$)/u.test(argument)
);

if (!nodeEvalOrPrint && process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    cliMain(process.argv.slice(2));
  } catch {
    process.stderr.write("recovery checkpoint authority failed closed\n");
    process.exitCode = 1;
  }
}

#!/usr/bin/env node

// Durable, owner-private operation identity and intent for the AUD-065
// process-local rotation. The module deliberately has no Kubernetes access and
// never returns or prints key material, snapshot contents, or direct digests.

import {
  createHash,
  createHmac,
  randomBytes as systemRandomBytes,
  timingSafeEqual
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const OPERATION_KEY_BYTES = 32;
const RANDOM_ID_BYTES = 16;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_BASELINE_BYTES = 32 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_VALUES_SOURCE_BYTES = 8 * 1024 * 1024;
const HEX_32 = /^[a-f0-9]{32}$/u;
const HEX_SHA256 = /^[a-f0-9]{64}$/u;
const ROTATION_REVISION = /^aud065-[a-z0-9](?:[-a-z0-9.]{6,61}[a-z0-9])$/u;
const DNS_LABEL = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/u;
const SAFE_CONTEXT = /^[A-Za-z0-9](?:[A-Za-z0-9._:@/-]{0,252})$/u;
const SAFE_UID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,252})$/u;
const CHECKPOINT_STAMP = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/u;
const SAFE_PROFILE_ID = /^[a-z0-9](?:[-a-z0-9.]{0,126}[a-z0-9])?$/u;

const IDENTITY_CONTRACT = "yenhubs-aud065-operation-identity-v1";
const INTENT_CONTRACT = "yenhubs-aud065-process-local-operation-intent-v1";
const BARRIER_CONTRACT = "yenhubs-aud065-pgsql-barrier-binding-v1";
const TERMINAL_CONTRACT = "yenhubs-aud065-operation-terminal-v1";
const GENERIC_CLI_ERROR = "process-local rotation operation failed closed\n";

export const PROCESS_LOCAL_OPERATION_FILES = Object.freeze({
  operationKey: "operation.key",
  identity: "identity.json",
  revision: "revision.json",
  originalBaseline: "original-baseline.json",
  finalBaseline: "final-baseline.json",
  releasedBaseline: "released-baseline.json",
  redactedReport: "redacted-report.json",
  oldSnapshot: "old-snapshot.json",
  newSnapshot: "new-snapshot.json",
  oldValuesSource: "old-values-source.yaml",
  newValuesSource: "new-values-source.yaml",
  intent: "intent.json",
  barrierBinding: "barrier-binding.json",
  terminal: "terminal.json"
});

// Formula over UTF-8 with no trailing newline:
//   bindingBody = intent without operationBindingSha256 and hmacSha256
//   operationBindingSha256 = SHA-256(canonicalJson(bindingBody))
//   authenticatedBody = bindingBody plus operationBindingSha256
//   hmacSha256 = HMAC-SHA-256(operation.key, canonicalJson(authenticatedBody))
export const PROCESS_LOCAL_OPERATION_BINDING_FORMULA = Object.freeze({
  canonicalEncoding: "utf8-canonical-json-without-trailing-newline",
  operationBindingSha256:
    "sha256(canonicalJson(intent without operationBindingSha256 and hmacSha256))",
  hmacSha256:
    "hmac-sha256(operation.key, canonicalJson(intent without hmacSha256))"
});

const PUBLIC_METADATA_KEYS = Object.freeze([
  "expectedKubeContext",
  "namespaceName",
  "namespaceUid",
  "retPvcName",
  "retPvcUid",
  "checkpointStamp",
  "checkpointDumpSha256",
  "checkpointStorageSha256",
  "checkpointInventorySha256",
  "profileId",
  "profileSha256"
]);

const BARRIER_INPUT_KEYS = Object.freeze([
  "policyUid",
  "policyResourceVersion",
  "policyMetadataSha256",
  "normalSpecSha256",
  "lockUid"
]);

const INTENT_KEYS = Object.freeze([
  "schemaVersion",
  "contractId",
  "operationToken",
  "operationId",
  "rotationRevision",
  ...PUBLIC_METADATA_KEYS,
  "originalBaselineSha256",
  "oldSnapshotSha256",
  "newSnapshotSha256",
  "oldValuesSourceSha256",
  "newValuesSourceSha256",
  "operationBindingSha256",
  "hmacSha256"
]);

const BARRIER_KEYS = Object.freeze([
  "schemaVersion",
  "contractId",
  ...BARRIER_INPUT_KEYS,
  "operationId",
  "operationBindingSha256",
  "hmacSha256"
]);

const TERMINAL_INPUT_KEYS = Object.freeze([
  "verifiedBaselineSha256",
  "releasedBaselineSha256",
  "reportSha256",
  "previousLockUid"
]);

const TERMINAL_KEYS = Object.freeze([
  "schemaVersion",
  "contractId",
  "operationId",
  "operationBindingSha256",
  "barrierBindingSha256",
  ...TERMINAL_INPUT_KEYS,
  "completed",
  "hmacSha256"
]);

const TERMINAL_REPORT_INVENTORY = Object.freeze({
  original_baseline_resources: 44,
  baseline_resources: 44,
  intermediate_cas_resources: 8,
  final_resources: 44,
  final_secrets: 2,
  final_deployments: 12,
  exact: true
});

export class ProcessLocalRotationOperationError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProcessLocalRotationOperationError";
    this.code = code;
  }
}

function reject(code) {
  throw new ProcessLocalRotationOperationError(code);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return isRecord(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonicalize(value[key])])
  );
}

export function canonicalOperationJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalBytes(value) {
  return Buffer.from(`${canonicalOperationJson(value)}\n`, "utf8");
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest();
}

function sha256Hex(bytes) {
  return sha256Bytes(bytes).toString("hex");
}

function hmacHex(key, value) {
  return createHmac("sha256", key)
    .update(canonicalOperationJson(value), "utf8")
    .digest("hex");
}

function safeHexEqual(left, right, pattern = HEX_SHA256) {
  if (typeof left !== "string" || typeof right !== "string" ||
      !pattern.test(left) || !pattern.test(right)) return false;
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function currentUidMatches(stat) {
  return typeof process.getuid !== "function" || stat.uid === BigInt(process.getuid());
}

function requireFilesystemSupport() {
  if (typeof fs.constants.O_NOFOLLOW !== "number" ||
      typeof fs.constants.O_EXCL !== "number" ||
      typeof fs.constants.O_DIRECTORY !== "number") {
    reject("filesystem_contract_unsupported");
  }
}

function resolvedTarget(target) {
  if (typeof target !== "string" || target.length === 0 || target.includes("\0")) {
    reject("path_invalid");
  }
  return path.resolve(target);
}

function componentContract(target) {
  const absolute = resolvedTarget(target);
  const parsed = path.parse(absolute);
  const names = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  return names.map((name, index) => {
    current = path.join(current, name);
    let stat;
    try {
      stat = fs.lstatSync(current, { bigint: true });
    } catch {
      reject("path_invalid");
    }
    if (stat.isSymbolicLink() || (index < names.length - 1 && !stat.isDirectory())) {
      reject("path_invalid");
    }
    return { path: current, stat };
  });
}

function sameNode(left, right, { content = false, nlink = false } = {}) {
  return left.dev === right.dev && left.ino === right.ino &&
    left.uid === right.uid && left.mode === right.mode &&
    left.isFile() === right.isFile() && left.isDirectory() === right.isDirectory() &&
    (!nlink || left.nlink === right.nlink) &&
    (!content || (
      left.size === right.size && left.mtimeNs === right.mtimeNs &&
      left.ctimeNs === right.ctimeNs
    ));
}

function samePublishedPayload(left, right) {
  return sameNode(left, right) && left.size === right.size &&
    left.mtimeNs === right.mtimeNs;
}

function sameComponents(before, after, { leafContent = false } = {}) {
  return before.length === after.length && before.every((entry, index) => {
    const current = after[index];
    return entry.path === current.path && sameNode(entry.stat, current.stat, {
      content: leafContent && index === before.length - 1,
      nlink: leafContent && index === before.length - 1
    });
  });
}

function ownerPrivateDirectory(stat) {
  return stat?.isDirectory() && !stat.isSymbolicLink() && currentUidMatches(stat) &&
    Number(stat.mode & 0o7777n) === DIRECTORY_MODE;
}

function ownerPrivateFile(stat, maximumBytes, {
  exactBytes,
  allowEmpty = false,
  expectedLinks = 1n
} = {}) {
  return stat?.isFile() && !stat.isSymbolicLink() && currentUidMatches(stat) &&
    stat.nlink === expectedLinks && Number(stat.mode & 0o7777n) === FILE_MODE &&
    (allowEmpty ? stat.size >= 0n : stat.size >= 1n) &&
    stat.size <= BigInt(maximumBytes) &&
    (exactBytes === undefined || stat.size === BigInt(exactBytes));
}

function openPinnedDirectory(directoryPath, code) {
  let descriptor;
  try {
    const components = componentContract(directoryPath);
    const leaf = components.at(-1)?.stat;
    if (!ownerPrivateDirectory(leaf)) reject(code);
    descriptor = fs.openSync(
      resolvedTarget(directoryPath),
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!ownerPrivateDirectory(opened) || !sameNode(leaf, opened)) reject(code);
    return { absolute: resolvedTarget(directoryPath), components, stat: opened, descriptor };
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* Preserve the primary error. */ }
    }
    if (error instanceof ProcessLocalRotationOperationError) throw error;
    reject(code);
  }
}

function closeDescriptor(descriptor) {
  if (descriptor !== undefined) {
    try { fs.closeSync(descriptor); } catch { /* Preserve the primary result. */ }
  }
}

function operationDirectoryContract(operationDirectory, parentDirectory) {
  requireFilesystemSupport();
  const absolute = resolvedTarget(operationDirectory);
  const expectedParent = parentDirectory === undefined
    ? path.dirname(absolute)
    : resolvedTarget(parentDirectory);
  if (path.dirname(absolute) !== expectedParent || path.basename(absolute) === path.sep) {
    reject("operation_layout_invalid");
  }
  const parent = openPinnedDirectory(expectedParent, "operation_parent_invalid");
  let operation;
  try {
    operation = openPinnedDirectory(absolute, "operation_directory_invalid");
    const parentAfter = componentContract(expectedParent);
    if (!sameComponents(parent.components, parentAfter) ||
        !sameNode(parent.stat, fs.fstatSync(parent.descriptor, { bigint: true }))) {
      reject("operation_parent_changed");
    }
    return { absolute, parent, operation };
  } catch (error) {
    closeDescriptor(parent.descriptor);
    throw error;
  }
}

function closeOperationContract(contract) {
  if (!contract) return;
  closeDescriptor(contract.operation?.descriptor);
  closeDescriptor(contract.parent?.descriptor);
}

function assertOperationContractStable(contract) {
  let operationAfter;
  let parentAfter;
  try {
    operationAfter = componentContract(contract.absolute);
    parentAfter = componentContract(contract.parent.absolute);
    const operationOpened = fs.fstatSync(contract.operation.descriptor, { bigint: true });
    const parentOpened = fs.fstatSync(contract.parent.descriptor, { bigint: true });
    if (!sameComponents(contract.operation.components, operationAfter) ||
        !sameComponents(contract.parent.components, parentAfter) ||
        !sameNode(contract.operation.stat, operationOpened) ||
        !sameNode(contract.parent.stat, parentOpened) ||
        !ownerPrivateDirectory(operationOpened) || !ownerPrivateDirectory(parentOpened)) {
      reject("operation_path_changed");
    }
  } catch (error) {
    if (error instanceof ProcessLocalRotationOperationError) throw error;
    reject("operation_path_changed");
  }
}

function runHook(hooks, name, context) {
  const hook = hooks?.[name];
  if (hook === undefined) return;
  if (typeof hook !== "function") reject("test_hook_invalid");
  hook(Object.freeze({ ...context }));
}

function readExact(descriptor, size) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = fs.readSync(descriptor, bytes, offset, size - offset, offset);
    if (count === 0) reject("private_file_changed");
    offset += count;
  }
  const extra = Buffer.alloc(1);
  if (fs.readSync(descriptor, extra, 0, 1, size) !== 0) {
    reject("private_file_changed");
  }
  return bytes;
}

function readPrivateFileSnapshot(contract, name, maximumBytes, hooks, { exactBytes } = {}) {
  const filePath = path.join(contract.absolute, name);
  let descriptor;
  try {
    assertOperationContractStable(contract);
    reconcilePublishedFile(contract, name, maximumBytes, { exactBytes });
    const beforeComponents = componentContract(filePath);
    const before = beforeComponents.at(-1)?.stat;
    if (!ownerPrivateFile(before, maximumBytes, { exactBytes })) {
      reject("private_file_invalid");
    }
    runHook(hooks, "beforePrivateFileOpen", {
      operationDirectory: contract.absolute,
      name
    });
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    runHook(hooks, "afterPrivateFileOpen", {
      operationDirectory: contract.absolute,
      name
    });
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!ownerPrivateFile(opened, maximumBytes, { exactBytes }) ||
        !sameNode(before, opened, { content: true, nlink: true })) {
      reject("private_file_invalid");
    }
    const first = readExact(descriptor, Number(opened.size));
    runHook(hooks, "afterPrivateFileFirstRead", { operationDirectory: contract.absolute, name });
    const middle = fs.fstatSync(descriptor, { bigint: true });
    if (!sameNode(opened, middle, { content: true, nlink: true })) {
      reject("private_file_changed");
    }
    const second = readExact(descriptor, Number(opened.size));
    const after = fs.fstatSync(descriptor, { bigint: true });
    const afterComponents = componentContract(filePath);
    const firstDigest = sha256Bytes(first);
    const secondDigest = sha256Bytes(second);
    if (!sameNode(opened, after, { content: true, nlink: true }) ||
        !sameComponents(beforeComponents, afterComponents, { leafContent: true }) ||
        !timingSafeEqual(firstDigest, secondDigest)) {
      reject("private_file_changed");
    }
    assertOperationContractStable(contract);
    return { bytes: first, stat: after };
  } catch (error) {
    if (error instanceof ProcessLocalRotationOperationError) throw error;
    reject("private_file_invalid");
  } finally {
    closeDescriptor(descriptor);
  }
}

function readPrivateFile(contract, name, maximumBytes, hooks, options) {
  return readPrivateFileSnapshot(contract, name, maximumBytes, hooks, options).bytes;
}

function parseCanonicalJson(bytes, code) {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) reject(code);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    reject(code);
  }
  if (!canonicalBytes(parsed).equals(bytes)) reject(code);
  return parsed;
}

function validRotationRevision(value) {
  return typeof value === "string" && ROTATION_REVISION.test(value);
}

function validateIdentity(value) {
  if (!exactKeys(value, [
    "schemaVersion",
    "contractId",
    "operationToken",
    "operationId",
    "rotationRevision"
  ]) || value.schemaVersion !== 1 || value.contractId !== IDENTITY_CONTRACT ||
      !HEX_32.test(value.operationToken || "") || !HEX_32.test(value.operationId || "") ||
      safeHexEqual(value.operationToken, value.operationId, HEX_32) ||
      !validRotationRevision(value.rotationRevision)) {
    reject("identity_invalid");
  }
  return value;
}

function validateRevision(value) {
  if (!exactKeys(value, ["rotationRevision"]) ||
      !validRotationRevision(value.rotationRevision)) {
    reject("revision_invalid");
  }
  return value;
}

function validCheckpointStamp(value) {
  if (typeof value !== "string") return false;
  const match = CHECKPOINT_STAMP.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(Date.UTC(
    Number(year), Number(month) - 1, Number(day),
    Number(hour), Number(minute), Number(second)
  ));
  return date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 && date.getUTCDate() === Number(day) &&
    date.getUTCHours() === Number(hour) && date.getUTCMinutes() === Number(minute) &&
    date.getUTCSeconds() === Number(second);
}

function validatePublicMetadata(metadata) {
  if (!exactKeys(metadata, PUBLIC_METADATA_KEYS) ||
      typeof metadata.expectedKubeContext !== "string" ||
      !SAFE_CONTEXT.test(metadata.expectedKubeContext) ||
      typeof metadata.namespaceName !== "string" || metadata.namespaceName.length > 63 ||
      !DNS_LABEL.test(metadata.namespaceName) ||
      typeof metadata.namespaceUid !== "string" || !SAFE_UID.test(metadata.namespaceUid) ||
      metadata.retPvcName !== "ret-pvc" ||
      typeof metadata.retPvcUid !== "string" || !SAFE_UID.test(metadata.retPvcUid) ||
      !validCheckpointStamp(metadata.checkpointStamp) ||
      !HEX_SHA256.test(metadata.checkpointDumpSha256 || "") ||
      !HEX_SHA256.test(metadata.checkpointStorageSha256 || "") ||
      !HEX_SHA256.test(metadata.checkpointInventorySha256 || "") ||
      typeof metadata.profileId !== "string" || metadata.profileId.length > 128 ||
      !SAFE_PROFILE_ID.test(metadata.profileId) ||
      !HEX_SHA256.test(metadata.profileSha256 || "")) {
    reject("public_metadata_invalid");
  }
  return metadata;
}

function publicMetadataFrom(value, { optional = false } = {}) {
  if (value?.metadata !== undefined) return validatePublicMetadata(value.metadata);
  const present = PUBLIC_METADATA_KEYS.filter(key => value?.[key] !== undefined);
  if (present.length === 0 && optional) return undefined;
  return validatePublicMetadata(Object.fromEntries(
    PUBLIC_METADATA_KEYS.map(key => [key, value?.[key]])
  ));
}

function metadataFromIntent(intent) {
  return Object.fromEntries(PUBLIC_METADATA_KEYS.map(key => [key, intent[key]]));
}

function metadataEqual(left, right) {
  return PUBLIC_METADATA_KEYS.every(key => left[key] === right[key]);
}

function validateBarrierInput(value) {
  if (!exactKeys(value, BARRIER_INPUT_KEYS) ||
      typeof value.policyUid !== "string" || !SAFE_UID.test(value.policyUid) ||
      typeof value.policyResourceVersion !== "string" ||
      value.policyResourceVersion.length < 1 || value.policyResourceVersion.length > 256 ||
      /[\s\u0000-\u001f\u007f]/u.test(value.policyResourceVersion) ||
      !HEX_SHA256.test(value.policyMetadataSha256 || "") ||
      !HEX_SHA256.test(value.normalSpecSha256 || "") ||
      typeof value.lockUid !== "string" || !SAFE_UID.test(value.lockUid)) {
    reject("barrier_input_invalid");
  }
  return value;
}

function barrierInputFrom(value, { optional = false } = {}) {
  if (value?.barrier !== undefined) return validateBarrierInput(value.barrier);
  const present = BARRIER_INPUT_KEYS.filter(key => value?.[key] !== undefined);
  if (present.length === 0 && optional) return undefined;
  return validateBarrierInput(Object.fromEntries(
    BARRIER_INPUT_KEYS.map(key => [key, value?.[key]])
  ));
}

function validateTerminalInput(value) {
  if (!exactKeys(value, TERMINAL_INPUT_KEYS) ||
      !HEX_SHA256.test(value.verifiedBaselineSha256 || "") ||
      !HEX_SHA256.test(value.releasedBaselineSha256 || "") ||
      !HEX_SHA256.test(value.reportSha256 || "") ||
      typeof value.previousLockUid !== "string" ||
      !SAFE_UID.test(value.previousLockUid)) {
    reject("terminal_input_invalid");
  }
  return value;
}

function terminalInputFrom(value, { optional = false } = {}) {
  if (value?.terminal !== undefined) return validateTerminalInput(value.terminal);
  const present = TERMINAL_INPUT_KEYS.filter(key => value?.[key] !== undefined);
  if (present.length === 0 && optional) return undefined;
  return validateTerminalInput(Object.fromEntries(
    TERMINAL_INPUT_KEYS.map(key => [key, value?.[key]])
  ));
}

function sameOwnedInode(filePath, owned) {
  try {
    const current = fs.lstatSync(filePath, { bigint: true });
    return current.dev === owned.dev && current.ino === owned.ino &&
      current.isFile() === owned.isFile() && current.isDirectory() === owned.isDirectory();
  } catch {
    return false;
  }
}

function safeUnlinkOwned(filePath, owned) {
  if (!owned || !sameOwnedInode(filePath, owned)) return;
  try { fs.unlinkSync(filePath); } catch { /* Never broaden cleanup after failure. */ }
}

function safeRmdirOwned(directoryPath, owned) {
  if (!owned || !sameOwnedInode(directoryPath, owned)) return;
  try { fs.rmdirSync(directoryPath); } catch { /* Preserve unknown or non-empty state. */ }
}

function destinationMustNotExist(filePath) {
  try {
    fs.lstatSync(filePath);
    reject("private_output_exists");
  } catch (error) {
    if (error instanceof ProcessLocalRotationOperationError) throw error;
    if (error?.code !== "ENOENT") reject("private_output_invalid");
  }
}

function pendingFilePrefix(name) {
  if (path.basename(name) !== name || name.length === 0) reject("private_output_invalid");
  return `.${name}.pending-`;
}

function createPendingFilePath(contract, name) {
  let suffix;
  try {
    suffix = systemRandomBytes(16).toString("hex");
  } catch {
    reject("random_source_failed");
  }
  return path.join(contract.absolute, `${pendingFilePrefix(name)}${suffix}`);
}

function reconcilePublishedFile(contract, name, maximumBytes, { exactBytes } = {}) {
  const filePath = path.join(contract.absolute, name);
  let final;
  try {
    final = fs.lstatSync(filePath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    reject("private_file_invalid");
  }
  if (ownerPrivateFile(final, maximumBytes, { exactBytes })) return false;
  if (!ownerPrivateFile(final, maximumBytes, {
    exactBytes,
    expectedLinks: 2n
  })) {
    reject("private_file_invalid");
  }

  let entries;
  try {
    entries = fs.readdirSync(contract.absolute)
      .filter(entry => entry.startsWith(pendingFilePrefix(name)));
  } catch {
    reject("private_file_invalid");
  }
  const linked = [];
  for (const entry of entries) {
    let candidate;
    try {
      candidate = fs.lstatSync(path.join(contract.absolute, entry), { bigint: true });
    } catch {
      reject("private_file_changed");
    }
    if (candidate.dev === final.dev && candidate.ino === final.ino) {
      linked.push({ entry, stat: candidate });
    }
  }
  if (linked.length !== 1 ||
      !ownerPrivateFile(linked[0].stat, maximumBytes, {
        exactBytes,
        expectedLinks: 2n
      }) ||
      !sameNode(final, linked[0].stat, { content: true, nlink: true })) {
    reject("private_file_invalid");
  }

  try {
    fs.unlinkSync(path.join(contract.absolute, linked[0].entry));
    fs.fsyncSync(contract.operation.descriptor);
    const reconciled = fs.lstatSync(filePath, { bigint: true });
    if (!ownerPrivateFile(reconciled, maximumBytes, { exactBytes }) ||
        !samePublishedPayload(final, reconciled)) {
      reject("private_file_changed");
    }
    assertOperationContractStable(contract);
    return true;
  } catch (error) {
    if (error instanceof ProcessLocalRotationOperationError) throw error;
    reject("private_file_changed");
  }
}

function writeAll(descriptor, body) {
  let offset = 0;
  while (offset < body.length) {
    const count = fs.writeSync(descriptor, body, offset, body.length - offset, offset);
    if (count <= 0) reject("private_output_write_failed");
    offset += count;
  }
}

function writeOwnedFile(contract, name, body, hooks) {
  const filePath = path.join(contract.absolute, name);
  const pendingPath = createPendingFilePath(contract, name);
  let descriptor;
  let created;
  let published = false;
  try {
    assertOperationContractStable(contract);
    destinationMustNotExist(filePath);
    runHook(hooks, "beforeOwnedFileCreate", { operationDirectory: contract.absolute, name });
    assertOperationContractStable(contract);
    descriptor = fs.openSync(
      pendingPath,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      FILE_MODE
    );
    fs.fchmodSync(descriptor, FILE_MODE);
    created = fs.fstatSync(descriptor, { bigint: true });
    if (!ownerPrivateFile(created, body.length, { exactBytes: 0, allowEmpty: true })) {
      reject("private_output_invalid");
    }
    const leaf = fs.lstatSync(pendingPath, { bigint: true });
    if (!sameNode(created, leaf, { content: true, nlink: true })) {
      reject("private_output_changed");
    }
    runHook(hooks, "afterOwnedFileCreated", {
      operationDirectory: contract.absolute,
      name,
      path: pendingPath,
      finalPath: filePath
    });
    assertOperationContractStable(contract);
    writeAll(descriptor, body);
    fs.fsyncSync(descriptor);
    runHook(hooks, "afterOwnedFileFsync", { operationDirectory: contract.absolute, name });
    const readBack = readExact(descriptor, body.length);
    const final = fs.fstatSync(descriptor, { bigint: true });
    const finalLeaf = fs.lstatSync(pendingPath, { bigint: true });
    if (!ownerPrivateFile(final, body.length, { exactBytes: body.length }) ||
        !sameNode(created, final, { nlink: true }) ||
        !sameNode(final, finalLeaf, { content: true, nlink: true }) ||
        !timingSafeEqual(sha256Bytes(body), sha256Bytes(readBack))) {
      reject("private_output_changed");
    }
    assertOperationContractStable(contract);
    destinationMustNotExist(filePath);
    fs.linkSync(pendingPath, filePath);
    published = true;
    const linkedSource = fs.lstatSync(pendingPath, { bigint: true });
    const linkedFinal = fs.lstatSync(filePath, { bigint: true });
    if (!ownerPrivateFile(linkedSource, body.length, {
      exactBytes: body.length,
      expectedLinks: 2n
    }) || !sameNode(linkedSource, linkedFinal, { content: true, nlink: true })) {
      reject("private_output_changed");
    }
    runHook(hooks, "afterOwnedFileLinked", {
      operationDirectory: contract.absolute,
      name,
      path: pendingPath,
      finalPath: filePath
    });
    fs.fsyncSync(contract.operation.descriptor);
    const pendingNow = fs.lstatSync(pendingPath, { bigint: true });
    if (!sameNode(linkedSource, pendingNow, { content: true, nlink: true })) {
      reject("private_output_changed");
    }
    fs.unlinkSync(pendingPath);
    fs.fsyncSync(contract.operation.descriptor);
    const finalPublished = fs.lstatSync(filePath, { bigint: true });
    if (!ownerPrivateFile(finalPublished, body.length, { exactBytes: body.length }) ||
        !samePublishedPayload(linkedFinal, finalPublished)) {
      reject("private_output_changed");
    }
    assertOperationContractStable(contract);
    return finalPublished;
  } catch (error) {
    closeDescriptor(descriptor);
    descriptor = undefined;
    safeUnlinkOwned(pendingPath, created);
    if (published) {
      try {
        reconcilePublishedFile(contract, name, body.length, { exactBytes: body.length });
      } catch { /* Leave a recoverable two-link publication for the next verifier. */ }
    }
    try { fs.fsyncSync(contract.operation.descriptor); } catch { /* Best-effort cleanup durability. */ }
    if (error instanceof ProcessLocalRotationOperationError) throw error;
    reject("private_output_invalid");
  } finally {
    closeDescriptor(descriptor);
  }
}

function randomMaterial(randomBytes, size) {
  let value;
  try {
    value = randomBytes(size);
  } catch {
    reject("random_source_failed");
  }
  if (!(value instanceof Uint8Array) || value.byteLength !== size) {
    reject("random_source_invalid");
  }
  return Buffer.from(value);
}

function openNewOperationDirectory(parentDirectory, operationDirectory) {
  requireFilesystemSupport();
  const parentAbsolute = resolvedTarget(parentDirectory);
  const operationAbsolute = resolvedTarget(operationDirectory);
  if (path.dirname(operationAbsolute) !== parentAbsolute ||
      operationAbsolute === parentAbsolute) reject("operation_layout_invalid");
  const parent = openPinnedDirectory(parentAbsolute, "operation_parent_invalid");
  let created;
  let operation;
  try {
    try {
      fs.lstatSync(operationAbsolute);
      reject("operation_directory_exists");
    } catch (error) {
      if (error instanceof ProcessLocalRotationOperationError) throw error;
      if (error?.code !== "ENOENT") reject("operation_directory_invalid");
    }
    fs.mkdirSync(operationAbsolute, { mode: DIRECTORY_MODE });
    fs.chmodSync(operationAbsolute, DIRECTORY_MODE);
    created = fs.lstatSync(operationAbsolute, { bigint: true });
    if (!ownerPrivateDirectory(created)) reject("operation_directory_invalid");
    operation = openPinnedDirectory(operationAbsolute, "operation_directory_invalid");
    if (!sameNode(created, operation.stat)) reject("operation_directory_changed");
    const parentAfter = componentContract(parentAbsolute);
    if (!sameComponents(parent.components, parentAfter) ||
        !sameNode(parent.stat, fs.fstatSync(parent.descriptor, { bigint: true }))) {
      reject("operation_parent_changed");
    }
    return {
      contract: { absolute: operationAbsolute, parent, operation },
      created
    };
  } catch (error) {
    closeDescriptor(operation?.descriptor);
    safeRmdirOwned(operationAbsolute, created);
    try { fs.fsyncSync(parent.descriptor); } catch { /* Best effort after safe cleanup. */ }
    closeDescriptor(parent.descriptor);
    if (error instanceof ProcessLocalRotationOperationError) throw error;
    reject("operation_directory_invalid");
  }
}

function readIdentityAndRevision(contract, hooks) {
  const identityBytes = readPrivateFile(
    contract, PROCESS_LOCAL_OPERATION_FILES.identity, MAX_JSON_BYTES, hooks
  );
  const revisionBytes = readPrivateFile(
    contract, PROCESS_LOCAL_OPERATION_FILES.revision, MAX_JSON_BYTES, hooks
  );
  try {
    const identity = validateIdentity(parseCanonicalJson(identityBytes, "identity_invalid"));
    const revision = validateRevision(parseCanonicalJson(revisionBytes, "revision_invalid"));
    if (identity.rotationRevision !== revision.rotationRevision) {
      reject("operation_identity_mismatch");
    }
    return { identity, revision };
  } finally {
    identityBytes.fill(0);
    revisionBytes.fill(0);
  }
}

function validateIntentShape(intent) {
  if (!exactKeys(intent, INTENT_KEYS) || intent.schemaVersion !== 1 ||
      intent.contractId !== INTENT_CONTRACT ||
      !HEX_32.test(intent.operationToken || "") || !HEX_32.test(intent.operationId || "") ||
      !validRotationRevision(intent.rotationRevision) ||
      !HEX_SHA256.test(intent.originalBaselineSha256 || "") ||
      !HEX_SHA256.test(intent.oldSnapshotSha256 || "") ||
      !HEX_SHA256.test(intent.newSnapshotSha256 || "") ||
      !HEX_SHA256.test(intent.oldValuesSourceSha256 || "") ||
      !HEX_SHA256.test(intent.newValuesSourceSha256 || "") ||
      !HEX_SHA256.test(intent.operationBindingSha256 || "") ||
      !HEX_SHA256.test(intent.hmacSha256 || "")) {
    reject("intent_invalid");
  }
  validatePublicMetadata(metadataFromIntent(intent));
  return intent;
}

function buildIntent(identity, metadata, sources, key) {
  const bindingBody = {
    schemaVersion: 1,
    contractId: INTENT_CONTRACT,
    operationToken: identity.operationToken,
    operationId: identity.operationId,
    rotationRevision: identity.rotationRevision,
    ...metadata,
    originalBaselineSha256: sha256Hex(sources.originalBaseline),
    oldSnapshotSha256: sha256Hex(sources.oldSnapshot),
    newSnapshotSha256: sha256Hex(sources.newSnapshot),
    oldValuesSourceSha256: sha256Hex(sources.oldValuesSource),
    newValuesSourceSha256: sha256Hex(sources.newValuesSource)
  };
  const authenticatedBody = {
    ...bindingBody,
    operationBindingSha256: sha256Hex(
      Buffer.from(canonicalOperationJson(bindingBody), "utf8")
    )
  };
  return {
    ...authenticatedBody,
    hmacSha256: hmacHex(key, authenticatedBody)
  };
}

function verifyIntent(intent, identity, metadata, sources, key) {
  validateIntentShape(intent);
  if (!safeHexEqual(intent.operationToken, identity.operationToken, HEX_32) ||
      !safeHexEqual(intent.operationId, identity.operationId, HEX_32) ||
      intent.rotationRevision !== identity.rotationRevision ||
      !metadataEqual(metadataFromIntent(intent), metadata) ||
      !safeHexEqual(intent.originalBaselineSha256, sha256Hex(sources.originalBaseline)) ||
      !safeHexEqual(intent.oldSnapshotSha256, sha256Hex(sources.oldSnapshot)) ||
      !safeHexEqual(intent.newSnapshotSha256, sha256Hex(sources.newSnapshot)) ||
      !safeHexEqual(
        intent.oldValuesSourceSha256,
        sha256Hex(sources.oldValuesSource)
      ) ||
      !safeHexEqual(
        intent.newValuesSourceSha256,
        sha256Hex(sources.newValuesSource)
      )) {
    reject("intent_binding_mismatch");
  }
  const bindingBody = structuredClone(intent);
  delete bindingBody.operationBindingSha256;
  delete bindingBody.hmacSha256;
  const expectedBinding = sha256Hex(
    Buffer.from(canonicalOperationJson(bindingBody), "utf8")
  );
  if (!safeHexEqual(intent.operationBindingSha256, expectedBinding)) {
    reject("intent_binding_mismatch");
  }
  const authenticatedBody = structuredClone(intent);
  delete authenticatedBody.hmacSha256;
  const expectedHmac = createHmac("sha256", key)
    .update(canonicalOperationJson(authenticatedBody), "utf8")
    .digest();
  const suppliedHmac = Buffer.from(intent.hmacSha256, "hex");
  if (expectedHmac.length !== suppliedHmac.length ||
      !timingSafeEqual(expectedHmac, suppliedHmac)) {
    reject("intent_hmac_mismatch");
  }
}

function verifyExpectedOperationContinuity(options, intent) {
  const hasOperationId = options?.expectedOperationId !== undefined;
  const hasBinding = options?.expectedOperationBindingSha256 !== undefined;
  if (!hasOperationId && !hasBinding) return;
  if (!hasOperationId || !hasBinding ||
      typeof options.expectedOperationId !== "string" ||
      !HEX_32.test(options.expectedOperationId) ||
      typeof options.expectedOperationBindingSha256 !== "string" ||
      !HEX_SHA256.test(options.expectedOperationBindingSha256) ||
      !safeHexEqual(options.expectedOperationId, intent.operationId, HEX_32) ||
      !safeHexEqual(
        options.expectedOperationBindingSha256,
        intent.operationBindingSha256
      )) {
    reject("expected_operation_continuity_mismatch");
  }
}

function readOperationSources(contract, hooks) {
  return {
    originalBaseline: readPrivateFile(
      contract, PROCESS_LOCAL_OPERATION_FILES.originalBaseline, MAX_BASELINE_BYTES, hooks
    ),
    oldSnapshot: readPrivateFile(
      contract, PROCESS_LOCAL_OPERATION_FILES.oldSnapshot, MAX_SNAPSHOT_BYTES, hooks
    ),
    newSnapshot: readPrivateFile(
      contract, PROCESS_LOCAL_OPERATION_FILES.newSnapshot, MAX_SNAPSHOT_BYTES, hooks
    ),
    oldValuesSource: readPrivateFile(
      contract,
      PROCESS_LOCAL_OPERATION_FILES.oldValuesSource,
      MAX_VALUES_SOURCE_BYTES,
      hooks
    ),
    newValuesSource: readPrivateFile(
      contract,
      PROCESS_LOCAL_OPERATION_FILES.newValuesSource,
      MAX_VALUES_SOURCE_BYTES,
      hooks
    )
  };
}

function wipeSources(sources) {
  for (const value of Object.values(sources || {})) {
    if (Buffer.isBuffer(value)) value.fill(0);
  }
}

function verifyOperationInternal(options) {
  const expectedMetadata = publicMetadataFrom(options, { optional: true });
  const contract = operationDirectoryContract(
    options.operationDirectory,
    options.parentDirectory
  );
  let key;
  let sources;
  let intentBytes;
  try {
    runHook(options.hooks, "afterOperationDirectoryValidated", {
      operationDirectory: contract.absolute,
      phase: "verify"
    });
    assertOperationContractStable(contract);
    const { identity } = readIdentityAndRevision(contract, options.hooks);
    key = readPrivateFile(
      contract,
      PROCESS_LOCAL_OPERATION_FILES.operationKey,
      OPERATION_KEY_BYTES,
      options.hooks,
      { exactBytes: OPERATION_KEY_BYTES }
    );
    sources = readOperationSources(contract, options.hooks);
    intentBytes = readPrivateFile(
      contract, PROCESS_LOCAL_OPERATION_FILES.intent, MAX_JSON_BYTES, options.hooks
    );
    const intent = parseCanonicalJson(intentBytes, "intent_invalid");
    const storedMetadata = validatePublicMetadata(metadataFromIntent(intent));
    if (expectedMetadata && !metadataEqual(storedMetadata, expectedMetadata)) {
      reject("public_metadata_mismatch");
    }
    verifyIntent(intent, identity, storedMetadata, sources, key);
    verifyExpectedOperationContinuity(options, intent);
    assertOperationContractStable(contract);
    return { contract, key, identity, intent, metadata: storedMetadata };
  } catch (error) {
    closeOperationContract(contract);
    if (key) key.fill(0);
    wipeSources(sources);
    if (intentBytes) intentBytes.fill(0);
    throw error;
  } finally {
    if (intentBytes) intentBytes.fill(0);
    wipeSources(sources);
  }
}

export function initProcessLocalRotationOperation({
  parentDirectory,
  operationDirectory,
  rotationRevision,
  randomBytes = systemRandomBytes,
  hooks
}) {
  if (!validRotationRevision(rotationRevision) || typeof randomBytes !== "function") {
    reject("init_input_invalid");
  }
  let opened;
  let contract;
  let key;
  const createdFiles = [];
  try {
    opened = openNewOperationDirectory(parentDirectory, operationDirectory);
    contract = opened.contract;
    runHook(hooks, "afterOperationDirectoryValidated", {
      operationDirectory: contract.absolute,
      phase: "init"
    });
    assertOperationContractStable(contract);
    key = randomMaterial(randomBytes, OPERATION_KEY_BYTES);
    const tokenBytes = randomMaterial(randomBytes, RANDOM_ID_BYTES);
    const idBytes = randomMaterial(randomBytes, RANDOM_ID_BYTES);
    const identity = {
      schemaVersion: 1,
      contractId: IDENTITY_CONTRACT,
      operationToken: tokenBytes.toString("hex"),
      operationId: idBytes.toString("hex"),
      rotationRevision
    };
    tokenBytes.fill(0);
    idBytes.fill(0);
    validateIdentity(identity);
    createdFiles.push({
      name: PROCESS_LOCAL_OPERATION_FILES.operationKey,
      stat: writeOwnedFile(contract, PROCESS_LOCAL_OPERATION_FILES.operationKey, key, hooks)
    });
    createdFiles.push({
      name: PROCESS_LOCAL_OPERATION_FILES.identity,
      stat: writeOwnedFile(
        contract, PROCESS_LOCAL_OPERATION_FILES.identity, canonicalBytes(identity), hooks
      )
    });
    createdFiles.push({
      name: PROCESS_LOCAL_OPERATION_FILES.revision,
      stat: writeOwnedFile(
        contract,
        PROCESS_LOCAL_OPERATION_FILES.revision,
        canonicalBytes({ rotationRevision }),
        hooks
      )
    });
    fs.fsyncSync(contract.operation.descriptor);
    fs.fsyncSync(contract.parent.descriptor);
    assertOperationContractStable(contract);
    return true;
  } catch (error) {
    if (contract) {
      for (const file of [...createdFiles].reverse()) {
        safeUnlinkOwned(path.join(contract.absolute, file.name), file.stat);
      }
      try { fs.fsyncSync(contract.operation.descriptor); } catch { /* Best effort. */ }
    }
    closeOperationContract(contract);
    contract = undefined;
    if (opened?.created) {
      safeRmdirOwned(resolvedTarget(operationDirectory), opened.created);
      try {
        const parent = openPinnedDirectory(parentDirectory, "operation_parent_invalid");
        try { fs.fsyncSync(parent.descriptor); } finally { closeDescriptor(parent.descriptor); }
      } catch { /* Never replace the primary error with cleanup diagnostics. */ }
    }
    if (error instanceof ProcessLocalRotationOperationError) throw error;
    reject("operation_init_failed");
  } finally {
    if (key) key.fill(0);
    closeOperationContract(contract);
  }
}

export function sealProcessLocalRotationOperation(options) {
  const metadata = publicMetadataFrom(options);
  const contract = operationDirectoryContract(
    options.operationDirectory,
    options.parentDirectory
  );
  let key;
  let sources;
  try {
    runHook(options.hooks, "afterOperationDirectoryValidated", {
      operationDirectory: contract.absolute,
      phase: "seal"
    });
    assertOperationContractStable(contract);
    const { identity } = readIdentityAndRevision(contract, options.hooks);
    key = readPrivateFile(
      contract,
      PROCESS_LOCAL_OPERATION_FILES.operationKey,
      OPERATION_KEY_BYTES,
      options.hooks,
      { exactBytes: OPERATION_KEY_BYTES }
    );
    sources = readOperationSources(contract, options.hooks);
    const intent = buildIntent(identity, metadata, sources, key);
    validateIntentShape(intent);
    writeOwnedFile(
      contract,
      PROCESS_LOCAL_OPERATION_FILES.intent,
      canonicalBytes(intent),
      options.hooks
    );
    fs.fsyncSync(contract.operation.descriptor);
    assertOperationContractStable(contract);
    return true;
  } finally {
    if (key) key.fill(0);
    wipeSources(sources);
    closeOperationContract(contract);
  }
}

export function verifyProcessLocalRotationOperation(options) {
  loadVerifiedProcessLocalRotationIntent(options);
  return true;
}

export function loadVerifiedProcessLocalRotationIntent(options) {
  const verified = verifyOperationInternal(options);
  try {
    return structuredClone(verified.intent);
  } finally {
    verified.key.fill(0);
    closeOperationContract(verified.contract);
  }
}

function buildBarrierBinding(input, intent, key) {
  const body = {
    schemaVersion: 1,
    contractId: BARRIER_CONTRACT,
    ...input,
    operationId: intent.operationId,
    operationBindingSha256: intent.operationBindingSha256
  };
  return { ...body, hmacSha256: hmacHex(key, body) };
}

function validateBarrierBinding(binding) {
  if (!exactKeys(binding, BARRIER_KEYS) || binding.schemaVersion !== 1 ||
      binding.contractId !== BARRIER_CONTRACT ||
      !HEX_32.test(binding.operationId || "") ||
      !HEX_SHA256.test(binding.operationBindingSha256 || "") ||
      !HEX_SHA256.test(binding.hmacSha256 || "")) {
    reject("barrier_binding_invalid");
  }
  validateBarrierInput(Object.fromEntries(
    BARRIER_INPUT_KEYS.map(key => [key, binding[key]])
  ));
  return binding;
}

function verifyBarrierBinding(binding, expectedInput, verified) {
  validateBarrierBinding(binding);
  const storedInput = Object.fromEntries(BARRIER_INPUT_KEYS.map(key => [key, binding[key]]));
  if (expectedInput && BARRIER_INPUT_KEYS.some(key => storedInput[key] !== expectedInput[key])) {
    reject("barrier_input_mismatch");
  }
  if (!safeHexEqual(binding.operationId, verified.intent.operationId, HEX_32) ||
      !safeHexEqual(
        binding.operationBindingSha256,
        verified.intent.operationBindingSha256
      )) {
    reject("barrier_operation_mismatch");
  }
  const body = structuredClone(binding);
  delete body.hmacSha256;
  const expectedHmac = createHmac("sha256", verified.key)
    .update(canonicalOperationJson(body), "utf8")
    .digest();
  const suppliedHmac = Buffer.from(binding.hmacSha256, "hex");
  if (expectedHmac.length !== suppliedHmac.length ||
      !timingSafeEqual(expectedHmac, suppliedHmac)) {
    reject("barrier_hmac_mismatch");
  }
}

export function writeProcessLocalBarrierBinding(options) {
  const input = barrierInputFrom(options);
  const verified = verifyOperationInternal(options);
  try {
    const binding = buildBarrierBinding(input, verified.intent, verified.key);
    validateBarrierBinding(binding);
    writeOwnedFile(
      verified.contract,
      PROCESS_LOCAL_OPERATION_FILES.barrierBinding,
      canonicalBytes(binding),
      options.hooks
    );
    fs.fsyncSync(verified.contract.operation.descriptor);
    assertOperationContractStable(verified.contract);
    return true;
  } finally {
    verified.key.fill(0);
    closeOperationContract(verified.contract);
  }
}

export function verifyProcessLocalBarrierBinding(options) {
  loadVerifiedProcessLocalBarrierBinding(options);
  return true;
}

export function loadVerifiedProcessLocalBarrierBinding(options) {
  const expectedInput = barrierInputFrom(options, { optional: true });
  const verified = verifyOperationInternal(options);
  try {
    const binding = readVerifiedBarrierBinding(verified, options.hooks, expectedInput);
    assertOperationContractStable(verified.contract);
    return structuredClone(binding);
  } finally {
    verified.key.fill(0);
    closeOperationContract(verified.contract);
  }
}

function readVerifiedBarrierBinding(verified, hooks, expectedInput) {
  let bytes;
  try {
    bytes = readPrivateFile(
      verified.contract,
      PROCESS_LOCAL_OPERATION_FILES.barrierBinding,
      MAX_JSON_BYTES,
      hooks
    );
    const binding = parseCanonicalJson(bytes, "barrier_binding_invalid");
    verifyBarrierBinding(binding, expectedInput, verified);
    return binding;
  } finally {
    if (bytes) bytes.fill(0);
  }
}

function barrierBindingSha256(binding) {
  return sha256Hex(Buffer.from(canonicalOperationJson(binding), "utf8"));
}

function buildTerminalRecord(input, intent, barrierBinding, key) {
  const body = {
    schemaVersion: 1,
    contractId: TERMINAL_CONTRACT,
    operationId: intent.operationId,
    operationBindingSha256: intent.operationBindingSha256,
    barrierBindingSha256: barrierBindingSha256(barrierBinding),
    ...input,
    completed: true
  };
  return { ...body, hmacSha256: hmacHex(key, body) };
}

function validateTerminalRecord(record) {
  if (!exactKeys(record, TERMINAL_KEYS) || record.schemaVersion !== 1 ||
      record.contractId !== TERMINAL_CONTRACT || record.completed !== true ||
      !HEX_32.test(record.operationId || "") ||
      !HEX_SHA256.test(record.operationBindingSha256 || "") ||
      !HEX_SHA256.test(record.barrierBindingSha256 || "") ||
      !HEX_SHA256.test(record.hmacSha256 || "")) {
    reject("terminal_record_invalid");
  }
  validateTerminalInput(Object.fromEntries(
    TERMINAL_INPUT_KEYS.map(key => [key, record[key]])
  ));
  return record;
}

function verifyTerminalRecord(record, expectedInput, verified, barrierBinding) {
  validateTerminalRecord(record);
  const storedInput = Object.fromEntries(
    TERMINAL_INPUT_KEYS.map(key => [key, record[key]])
  );
  if (expectedInput &&
      TERMINAL_INPUT_KEYS.some(key => storedInput[key] !== expectedInput[key])) {
    reject("terminal_input_mismatch");
  }
  if (!safeHexEqual(record.operationId, verified.intent.operationId, HEX_32) ||
      !safeHexEqual(
        record.operationBindingSha256,
        verified.intent.operationBindingSha256
      ) ||
      !safeHexEqual(
        record.barrierBindingSha256,
        barrierBindingSha256(barrierBinding)
      ) ||
      record.previousLockUid !== barrierBinding.lockUid) {
    reject("terminal_operation_mismatch");
  }
  const body = structuredClone(record);
  delete body.hmacSha256;
  const expectedHmac = createHmac("sha256", verified.key)
    .update(canonicalOperationJson(body), "utf8")
    .digest();
  const suppliedHmac = Buffer.from(record.hmacSha256, "hex");
  if (expectedHmac.length !== suppliedHmac.length ||
      !timingSafeEqual(expectedHmac, suppliedHmac)) {
    reject("terminal_hmac_mismatch");
  }
}

export function writeProcessLocalTerminalRecord(options) {
  const input = terminalInputFrom(options);
  const verified = verifyOperationInternal(options);
  try {
    const barrierBinding = readVerifiedBarrierBinding(verified, options.hooks);
    if (input.previousLockUid !== barrierBinding.lockUid) {
      reject("terminal_input_mismatch");
    }
    const record = buildTerminalRecord(
      input,
      verified.intent,
      barrierBinding,
      verified.key
    );
    validateTerminalRecord(record);
    writeOwnedFile(
      verified.contract,
      PROCESS_LOCAL_OPERATION_FILES.terminal,
      canonicalBytes(record),
      options.hooks
    );
    fs.fsyncSync(verified.contract.operation.descriptor);
    assertOperationContractStable(verified.contract);
    return true;
  } finally {
    verified.key.fill(0);
    closeOperationContract(verified.contract);
  }
}

export function verifyProcessLocalTerminalRecord(options) {
  const expectedInput = terminalInputFrom(options);
  const verified = verifyOperationInternal(options);
  let bytes;
  try {
    const barrierBinding = readVerifiedBarrierBinding(verified, options.hooks);
    bytes = readPrivateFile(
      verified.contract,
      PROCESS_LOCAL_OPERATION_FILES.terminal,
      MAX_JSON_BYTES,
      options.hooks
    );
    const record = parseCanonicalJson(bytes, "terminal_record_invalid");
    verifyTerminalRecord(record, expectedInput, verified, barrierBinding);
    assertOperationContractStable(verified.contract);
    return true;
  } finally {
    if (bytes) bytes.fill(0);
    verified.key.fill(0);
    closeOperationContract(verified.contract);
  }
}

function terminalArtifactPaths(options, contract) {
  if (!isRecord(options) || [
    "terminal",
    "verifiedBaselineSha256",
    "releasedBaselineSha256",
    "reportSha256"
  ].some(name => Object.prototype.hasOwnProperty.call(options, name)) ||
      typeof options.previousLockUid !== "string" ||
      !SAFE_UID.test(options.previousLockUid)) {
    reject("terminal_artifact_input_invalid");
  }
  const expected = {
    verifiedBaseline: path.join(
      contract.absolute,
      PROCESS_LOCAL_OPERATION_FILES.finalBaseline
    ),
    releasedBaseline: path.join(
      contract.absolute,
      PROCESS_LOCAL_OPERATION_FILES.releasedBaseline
    ),
    report: path.join(
      contract.absolute,
      PROCESS_LOCAL_OPERATION_FILES.redactedReport
    )
  };
  for (const [name, expectedPath] of Object.entries(expected)) {
    if (resolvedTarget(options[name]) !== expectedPath) {
      reject("terminal_artifact_path_invalid");
    }
  }
  return expected;
}

function artifactIdentity(value, code) {
  if (!isRecord(value) || typeof value.apiVersion !== "string" ||
      value.apiVersion.length < 1 || value.apiVersion.length > 253 ||
      /[\t\r\n\u0000]/u.test(value.apiVersion) ||
      typeof value.kind !== "string" || value.kind.length < 1 ||
      value.kind.length > 253 || /[\t\r\n\u0000]/u.test(value.kind) ||
      !isRecord(value.metadata) || typeof value.metadata.name !== "string" ||
      value.metadata.name.length < 1 || value.metadata.name.length > 253 ||
      /[\t\r\n\u0000]/u.test(value.metadata.name) ||
      (value.metadata.namespace !== undefined &&
        (typeof value.metadata.namespace !== "string" ||
          value.metadata.namespace.length < 1 ||
          value.metadata.namespace.length > 253 ||
          /[\t\r\n\u0000]/u.test(value.metadata.namespace)))) {
    reject(code);
  }
  return canonicalOperationJson([
    value.apiVersion,
    value.kind,
    value.metadata.namespace || "",
    value.metadata.name
  ]);
}

function validateTerminalBaseline(snapshot, code) {
  const value = parseCanonicalJson(snapshot.bytes, code);
  if (!exactKeys(value, ["apiVersion", "kind", "items"]) ||
      value.apiVersion !== "v1" || value.kind !== "List" ||
      !Array.isArray(value.items) || value.items.length !== 44) {
    reject(code);
  }
  const identities = new Set(value.items.map(item => artifactIdentity(item, code)));
  if (identities.size !== 44) reject(code);
  return identities;
}

function parseCanonicalTerminalReport(bytes) {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) reject("terminal_report_invalid");
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    reject("terminal_report_invalid");
  }
  let canonical;
  try {
    // The redacted verifier intentionally publishes deterministic, indented
    // JSON. Requiring its exact serialization rejects whitespace, key-order
    // and trailing-data variants without changing that producer's contract.
    canonical = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
  } catch {
    reject("terminal_report_invalid");
  }
  if (!canonical.equals(bytes) || !isRecord(report) ||
      report.schema_version !== 2 || report.verdict !== "pass" ||
      !exactKeys(report.inventories, Object.keys(TERMINAL_REPORT_INVENTORY)) ||
      Object.entries(TERMINAL_REPORT_INVENTORY).some(
        ([name, expected]) => report.inventories[name] !== expected
      )) {
    reject("terminal_report_invalid");
  }
  return true;
}

function wipeTerminalArtifactSet(artifacts) {
  for (const artifact of Object.values(artifacts?.snapshots || {})) {
    if (Buffer.isBuffer(artifact?.bytes)) artifact.bytes.fill(0);
  }
}

function readTerminalArtifactSet(verified, options, phase) {
  const paths = terminalArtifactPaths(options, verified.contract);
  const snapshots = {};
  try {
    runHook(options.hooks, "beforeTerminalArtifactSetRead", {
      operationDirectory: verified.contract.absolute,
      phase
    });
    snapshots.verifiedBaseline = readPrivateFileSnapshot(
      verified.contract,
      PROCESS_LOCAL_OPERATION_FILES.finalBaseline,
      MAX_BASELINE_BYTES,
      options.hooks
    );
    const verifiedIdentities = validateTerminalBaseline(
      snapshots.verifiedBaseline,
      "terminal_verified_baseline_invalid"
    );
    snapshots.releasedBaseline = readPrivateFileSnapshot(
      verified.contract,
      PROCESS_LOCAL_OPERATION_FILES.releasedBaseline,
      MAX_BASELINE_BYTES,
      options.hooks
    );
    const releasedIdentities = validateTerminalBaseline(
      snapshots.releasedBaseline,
      "terminal_released_baseline_invalid"
    );
    if (verifiedIdentities.size !== releasedIdentities.size ||
        [...verifiedIdentities].some(identity => !releasedIdentities.has(identity))) {
      reject("terminal_baseline_inventory_mismatch");
    }
    snapshots.report = readPrivateFileSnapshot(
      verified.contract,
      PROCESS_LOCAL_OPERATION_FILES.redactedReport,
      MAX_JSON_BYTES,
      options.hooks
    );
    parseCanonicalTerminalReport(snapshots.report.bytes);
    assertOperationContractStable(verified.contract);
    return {
      paths,
      snapshots,
      terminal: validateTerminalInput({
        verifiedBaselineSha256: sha256Hex(snapshots.verifiedBaseline.bytes),
        releasedBaselineSha256: sha256Hex(snapshots.releasedBaseline.bytes),
        reportSha256: sha256Hex(snapshots.report.bytes),
        previousLockUid: options.previousLockUid
      })
    };
  } catch (error) {
    wipeTerminalArtifactSet({ snapshots });
    throw error;
  }
}

function confirmTerminalArtifacts(verified, options, initial) {
  const confirmation = readTerminalArtifactSet(verified, options, "confirmation");
  try {
    for (const name of ["verifiedBaseline", "releasedBaseline", "report"]) {
      const before = initial.snapshots[name];
      const after = confirmation.snapshots[name];
      if (!sameNode(before.stat, after.stat, { content: true, nlink: true }) ||
          !safeHexEqual(sha256Hex(before.bytes), sha256Hex(after.bytes))) {
        reject("terminal_artifact_changed");
      }
    }
    if (TERMINAL_INPUT_KEYS.some(
      name => confirmation.terminal[name] !== initial.terminal[name]
    )) {
      reject("terminal_artifact_changed");
    }
    assertOperationContractStable(verified.contract);
    return true;
  } finally {
    wipeTerminalArtifactSet(confirmation);
  }
}

function readAndVerifyTerminal(verified, expectedInput, hooks) {
  let bytes;
  try {
    bytes = readPrivateFile(
      verified.contract,
      PROCESS_LOCAL_OPERATION_FILES.terminal,
      MAX_JSON_BYTES,
      hooks
    );
    const record = parseCanonicalJson(bytes, "terminal_record_invalid");
    const barrierBinding = readVerifiedBarrierBinding(verified, hooks);
    verifyTerminalRecord(record, expectedInput, verified, barrierBinding);
    return true;
  } finally {
    if (bytes) bytes.fill(0);
  }
}

export function writeProcessLocalTerminalRecordFromArtifacts(options) {
  const verified = verifyOperationInternal(options);
  let artifacts;
  try {
    artifacts = readTerminalArtifactSet(verified, options, "initial");
    const barrierBinding = readVerifiedBarrierBinding(verified, options.hooks);
    if (artifacts.terminal.previousLockUid !== barrierBinding.lockUid) {
      reject("terminal_input_mismatch");
    }
    const record = buildTerminalRecord(
      artifacts.terminal,
      verified.intent,
      barrierBinding,
      verified.key
    );
    validateTerminalRecord(record);
    writeOwnedFile(
      verified.contract,
      PROCESS_LOCAL_OPERATION_FILES.terminal,
      canonicalBytes(record),
      options.hooks
    );
    fs.fsyncSync(verified.contract.operation.descriptor);
    readAndVerifyTerminal(verified, artifacts.terminal, options.hooks);
    confirmTerminalArtifacts(verified, options, artifacts);
    assertOperationContractStable(verified.contract);
    return true;
  } finally {
    wipeTerminalArtifactSet(artifacts);
    verified.key.fill(0);
    closeOperationContract(verified.contract);
  }
}

export function verifyProcessLocalTerminalRecordFromArtifacts(options) {
  const verified = verifyOperationInternal(options);
  let artifacts;
  try {
    artifacts = readTerminalArtifactSet(verified, options, "initial");
    readAndVerifyTerminal(verified, artifacts.terminal, options.hooks);
    confirmTerminalArtifacts(verified, options, artifacts);
    assertOperationContractStable(verified.contract);
    return true;
  } finally {
    wipeTerminalArtifactSet(artifacts);
    verified.key.fill(0);
    closeOperationContract(verified.contract);
  }
}

function parseRuntimeSnapshot(bytes, code) {
  const value = parseCanonicalJson(bytes, code);
  if (!isRecord(value)) reject(code);
  for (const name of ["DB_USER", "DB_NAME", "DB_PASS"]) {
    if (typeof value[name] !== "string" || value[name].length < 1 ||
        value[name].length > 256 || /[\r\n\u0000]/u.test(value[name])) {
      reject(code);
    }
  }
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u.test(value.DB_USER) ||
      !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u.test(value.DB_NAME)) {
    reject(code);
  }
  return value;
}

function verifiedRuntimeSnapshots(verified, hooks) {
  let oldBytes;
  let newBytes;
  try {
    oldBytes = readPrivateFile(
      verified.contract,
      PROCESS_LOCAL_OPERATION_FILES.oldSnapshot,
      MAX_SNAPSHOT_BYTES,
      hooks
    );
    newBytes = readPrivateFile(
      verified.contract,
      PROCESS_LOCAL_OPERATION_FILES.newSnapshot,
      MAX_SNAPSHOT_BYTES,
      hooks
    );
    if (!safeHexEqual(sha256Hex(oldBytes), verified.intent.oldSnapshotSha256) ||
        !safeHexEqual(sha256Hex(newBytes), verified.intent.newSnapshotSha256)) {
      reject("runtime_snapshot_binding_mismatch");
    }
    const oldValues = parseRuntimeSnapshot(oldBytes, "old_runtime_snapshot_invalid");
    const newValues = parseRuntimeSnapshot(newBytes, "new_runtime_snapshot_invalid");
    if (oldValues.DB_USER !== newValues.DB_USER ||
        oldValues.DB_NAME !== newValues.DB_NAME ||
        oldValues.DB_PASS === newValues.DB_PASS) {
      reject("runtime_snapshot_transition_invalid");
    }
    return { oldValues, newValues };
  } finally {
    if (oldBytes) oldBytes.fill(0);
    if (newBytes) newBytes.fill(0);
  }
}

export function emitVerifiedProcessLocalRuntime(options) {
  const mode = options?.mode;
  if (!["db-identifiers", "db-password-pair", "old-password", "new-password"]
    .includes(mode) || typeof options.write !== "function") {
    reject("runtime_emit_input_invalid");
  }
  const verified = verifyOperationInternal(options);
  let output;
  try {
    const snapshots = verifiedRuntimeSnapshots(verified, options.hooks);
    switch (mode) {
      case "db-identifiers":
        output = Buffer.from(
          `${snapshots.newValues.DB_USER}\t${snapshots.newValues.DB_NAME}\n`,
          "utf8"
        );
        break;
      case "db-password-pair":
        output = Buffer.from(
          `${snapshots.oldValues.DB_PASS}\n${snapshots.newValues.DB_PASS}\n`,
          "utf8"
        );
        break;
      case "old-password":
        output = Buffer.from(`${snapshots.oldValues.DB_PASS}\n`, "utf8");
        break;
      case "new-password":
        output = Buffer.from(`${snapshots.newValues.DB_PASS}\n`, "utf8");
        break;
    }
    // The emitted buffer is the capability: all path-bound checks finish
    // before the first byte reaches the caller.  No path check may turn a
    // successful emission into a failure after sensitive stdout has begun.
    assertOperationContractStable(verified.contract);
    options.write(output);
    return true;
  } finally {
    if (output) output.fill(0);
    verified.key.fill(0);
    closeOperationContract(verified.contract);
  }
}

const BASELINE_DEPLOYMENT_NAMES = new Set([
  "bot-orchestrator",
  "coturn",
  "dialog",
  "pgbouncer",
  "pgbouncer-t",
  "pgsql",
  "reticulum"
]);

function verifiedOriginalBaseline(verified, hooks) {
  let bytes;
  try {
    bytes = readPrivateFile(
      verified.contract,
      PROCESS_LOCAL_OPERATION_FILES.originalBaseline,
      MAX_BASELINE_BYTES,
      hooks
    );
    if (!safeHexEqual(sha256Hex(bytes), verified.intent.originalBaselineSha256)) {
      reject("original_baseline_binding_mismatch");
    }
    const value = parseCanonicalJson(bytes, "original_baseline_invalid");
    if (!exactKeys(value, ["apiVersion", "kind", "items"]) ||
        value.apiVersion !== "v1" || value.kind !== "List" ||
        !Array.isArray(value.items) || value.items.length !== 44) {
      reject("original_baseline_invalid");
    }
    const identities = new Set();
    for (const item of value.items) {
      const identity = [item?.apiVersion, item?.kind,
        item?.metadata?.namespace || "", item?.metadata?.name];
      if (identity.some(field => typeof field !== "string" || field.length < 1 ||
          /[\t\r\n\u0000]/u.test(field))) {
        reject("original_baseline_invalid");
      }
      identities.add(identity.join("\u0000"));
    }
    if (identities.size !== 44) reject("original_baseline_invalid");
    return value.items;
  } finally {
    if (bytes) bytes.fill(0);
  }
}

export function emitVerifiedProcessLocalBaselineCapability(options) {
  const mode = options?.mode;
  const name = options?.name;
  if (![
    "deployment-contract",
    "pgsql-image",
    "pgsql-policy-binding"
  ].includes(mode) || typeof options.write !== "function" ||
      (mode === "deployment-contract"
        ? !BASELINE_DEPLOYMENT_NAMES.has(name)
        : name !== undefined)) {
    reject("baseline_emit_input_invalid");
  }
  const verified = verifyOperationInternal(options);
  let output;
  try {
    const items = verifiedOriginalBaseline(verified, options.hooks);
    if (mode === "deployment-contract") {
      const matches = items.filter(item => item.apiVersion === "apps/v1" &&
        item.kind === "Deployment" &&
        item.metadata?.namespace === verified.intent.namespaceName &&
        item.metadata?.name === name);
      if (matches.length !== 1) reject("baseline_deployment_invalid");
      const deployment = matches[0];
      const selector = deployment.spec?.selector?.matchLabels?.app;
      const fingerprint = Buffer.from(canonicalOperationJson({
        selector: deployment.spec?.selector,
        strategy: deployment.spec?.strategy || {},
        template: deployment.spec?.template
      }), "utf8").toString("base64");
      const fields = [
        deployment.metadata?.uid,
        deployment.metadata?.resourceVersion,
        String(deployment.spec?.replicas),
        selector,
        fingerprint
      ];
      if (fields.some(field => typeof field !== "string" || field.length < 1 ||
          /[\t\r\n\u0000]/u.test(field)) || !/^[0-9]+$/u.test(fields[2])) {
        reject("baseline_deployment_invalid");
      }
      output = Buffer.from(`${fields.join("\t")}\n`, "utf8");
    } else if (mode === "pgsql-image") {
      const matches = items.filter(item => item.apiVersion === "apps/v1" &&
        item.kind === "Deployment" &&
        item.metadata?.namespace === verified.intent.namespaceName &&
        item.metadata?.name === "pgsql");
      const containers = matches[0]?.spec?.template?.spec?.containers;
      const images = Array.isArray(containers)
        ? containers.filter(container => container?.name === "postgresql")
          .map(container => container.image)
        : [];
      if (matches.length !== 1 || images.length !== 1 ||
          typeof images[0] !== "string" ||
          !/^[^\s@]+@sha256:[a-f0-9]{64}$/u.test(images[0])) {
        reject("baseline_pgsql_image_invalid");
      }
      output = Buffer.from(`${images[0]}\n`, "utf8");
    } else {
      const matches = items.filter(item =>
        item.apiVersion === "networking.k8s.io/v1" &&
        item.kind === "NetworkPolicy" &&
        item.metadata?.namespace === verified.intent.namespaceName &&
        item.metadata?.name === "pgsql-ingress");
      const fields = [
        matches[0]?.metadata?.uid,
        matches[0]?.metadata?.resourceVersion
      ];
      if (matches.length !== 1 || fields.some(field =>
        typeof field !== "string" || field.length < 1 || field.length > 256 ||
        /[\s\u0000-\u001f\u007f]/u.test(field))) {
        reject("baseline_pgsql_policy_invalid");
      }
      output = Buffer.from(`${fields.join("\t")}\n`, "utf8");
    }
    assertOperationContractStable(verified.contract);
    options.write(output);
    return true;
  } finally {
    if (output) output.fill(0);
    verified.key.fill(0);
    closeOperationContract(verified.contract);
  }
}

function parseFlagMap(argv, allowed, required) {
  if (argv.length % 2 !== 0) reject("arguments_invalid");
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || values.has(name) ||
        typeof value !== "string" || value.length === 0) {
      reject("arguments_invalid");
    }
    values.set(name, value);
  }
  if ([...required].some(name => !values.has(name))) reject("arguments_invalid");
  return values;
}

const METADATA_FLAGS = Object.freeze({
  "--expected-kube-context": "expectedKubeContext",
  "--namespace-name": "namespaceName",
  "--namespace-uid": "namespaceUid",
  "--ret-pvc-name": "retPvcName",
  "--ret-pvc-uid": "retPvcUid",
  "--checkpoint-stamp": "checkpointStamp",
  "--checkpoint-dump-sha256": "checkpointDumpSha256",
  "--checkpoint-storage-sha256": "checkpointStorageSha256",
  "--checkpoint-inventory-sha256": "checkpointInventorySha256",
  "--profile-id": "profileId",
  "--profile-sha256": "profileSha256"
});

const BARRIER_FLAGS = Object.freeze({
  "--policy-uid": "policyUid",
  "--policy-resource-version": "policyResourceVersion",
  "--policy-metadata-sha256": "policyMetadataSha256",
  "--normal-spec-sha256": "normalSpecSha256",
  "--lock-uid": "lockUid"
});

const OPERATION_CONTINUITY_FLAGS = Object.freeze({
  "--expected-operation-id": "expectedOperationId",
  "--expected-operation-binding-sha256": "expectedOperationBindingSha256"
});

function objectFromFlags(values, mapping) {
  return Object.fromEntries(Object.entries(mapping).map(([flag, key]) => [key, values.get(flag)]));
}

function cliMain(argv) {
  const [command, ...rest] = argv;
  if (command === "emit-runtime") {
    const required = new Set([
      "--operation-directory",
      "--mode",
      ...Object.keys(OPERATION_CONTINUITY_FLAGS)
    ]);
    const values = parseFlagMap(rest, required, required);
    return emitVerifiedProcessLocalRuntime({
      operationDirectory: values.get("--operation-directory"),
      mode: values.get("--mode"),
      ...objectFromFlags(values, OPERATION_CONTINUITY_FLAGS),
      write(bytes) {
        let offset = 0;
        while (offset < bytes.length) {
          const count = fs.writeSync(1, bytes, offset, bytes.length - offset);
          if (!Number.isInteger(count) || count <= 0) reject("runtime_emit_failed");
          offset += count;
        }
      }
    });
  }
  if (command === "emit-baseline") {
    const allowed = new Set([
      "--operation-directory",
      "--mode",
      "--name",
      ...Object.keys(OPERATION_CONTINUITY_FLAGS)
    ]);
    const required = new Set([
      "--operation-directory",
      "--mode",
      ...Object.keys(OPERATION_CONTINUITY_FLAGS)
    ]);
    const values = parseFlagMap(rest, allowed, required);
    return emitVerifiedProcessLocalBaselineCapability({
      operationDirectory: values.get("--operation-directory"),
      mode: values.get("--mode"),
      ...objectFromFlags(values, OPERATION_CONTINUITY_FLAGS),
      ...(values.has("--name") ? { name: values.get("--name") } : {}),
      write(bytes) {
        let offset = 0;
        while (offset < bytes.length) {
          const count = fs.writeSync(1, bytes, offset, bytes.length - offset);
          if (!Number.isInteger(count) || count <= 0) reject("baseline_emit_failed");
          offset += count;
        }
      }
    });
  }
  if (command === "init") {
    const required = new Set([
      "--parent-directory", "--operation-directory", "--rotation-revision"
    ]);
    const values = parseFlagMap(rest, required, required);
    return initProcessLocalRotationOperation({
      parentDirectory: values.get("--parent-directory"),
      operationDirectory: values.get("--operation-directory"),
      rotationRevision: values.get("--rotation-revision")
    });
  }
  if (command === "seal" || command === "verify") {
    const operationFlag = "--operation-directory";
    const metadataFlags = new Set(Object.keys(METADATA_FLAGS));
    const continuityFlags = new Set(Object.keys(OPERATION_CONTINUITY_FLAGS));
    const allowed = command === "seal"
      ? new Set([operationFlag, ...metadataFlags])
      : new Set([operationFlag, ...metadataFlags, ...continuityFlags]);
    const required = command === "seal"
      ? new Set([operationFlag])
      : new Set([operationFlag, ...continuityFlags]);
    const values = parseFlagMap(rest, allowed, required);
    const presentMetadata = [...metadataFlags].filter(flag => values.has(flag));
    if (command === "seal" && presentMetadata.length !== metadataFlags.size) {
      reject("arguments_invalid");
    }
    if (command === "verify" && presentMetadata.length !== 0 &&
        presentMetadata.length !== metadataFlags.size) reject("arguments_invalid");
    const options = {
      operationDirectory: values.get(operationFlag),
      ...(command === "verify"
        ? objectFromFlags(values, OPERATION_CONTINUITY_FLAGS)
        : {})
    };
    if (presentMetadata.length > 0) options.metadata = objectFromFlags(values, METADATA_FLAGS);
    return command === "seal"
      ? sealProcessLocalRotationOperation(options)
      : verifyProcessLocalRotationOperation(options);
  }
  if (command === "bind-barrier" || command === "verify-barrier") {
    const operationFlag = "--operation-directory";
    const barrierFlags = new Set(Object.keys(BARRIER_FLAGS));
    const continuityFlags = new Set(Object.keys(OPERATION_CONTINUITY_FLAGS));
    const allowed = new Set([operationFlag, ...barrierFlags, ...continuityFlags]);
    const values = parseFlagMap(
      rest,
      allowed,
      new Set([operationFlag, ...continuityFlags])
    );
    const presentBarrier = [...barrierFlags].filter(flag => values.has(flag));
    if (command === "bind-barrier" && presentBarrier.length !== barrierFlags.size) {
      reject("arguments_invalid");
    }
    if (command === "verify-barrier" && presentBarrier.length !== 0 &&
        presentBarrier.length !== barrierFlags.size) reject("arguments_invalid");
    const options = {
      operationDirectory: values.get(operationFlag),
      ...objectFromFlags(values, OPERATION_CONTINUITY_FLAGS)
    };
    if (presentBarrier.length > 0) options.barrier = objectFromFlags(values, BARRIER_FLAGS);
    return command === "bind-barrier"
      ? writeProcessLocalBarrierBinding(options)
      : verifyProcessLocalBarrierBinding(options);
  }
  if (command === "write-terminal-from-artifacts" ||
      command === "verify-terminal-from-artifacts") {
    const allowed = new Set([
      "--operation-directory",
      "--verified-baseline",
      "--released-baseline",
      "--report",
      "--previous-lock-uid",
      ...Object.keys(OPERATION_CONTINUITY_FLAGS)
    ]);
    const values = parseFlagMap(rest, allowed, allowed);
    const options = {
      operationDirectory: values.get("--operation-directory"),
      verifiedBaseline: values.get("--verified-baseline"),
      releasedBaseline: values.get("--released-baseline"),
      report: values.get("--report"),
      previousLockUid: values.get("--previous-lock-uid"),
      ...objectFromFlags(values, OPERATION_CONTINUITY_FLAGS)
    };
    return command === "write-terminal-from-artifacts"
      ? writeProcessLocalTerminalRecordFromArtifacts(options)
      : verifyProcessLocalTerminalRecordFromArtifacts(options);
  }
  reject("arguments_invalid");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    cliMain(process.argv.slice(2));
  } catch {
    process.stderr.write(GENERIC_CLI_ERROR);
    process.exitCode = 1;
  }
}

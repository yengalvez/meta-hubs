#!/usr/bin/env node

// Owner-private source-of-truth transition for AUD-065. The historical
// process-local manifest receives only its narrow projected snapshot; these
// full-source artifacts retain and authenticate the candidate-only keys so a
// later generated rollout starts from the same completed credential rotation.

import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  timingSafeEqual
} from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseLocalValuesSource } from "./parse-local-values.mjs";
import {
  PROCESS_LOCAL_OPERATION_FILES,
  loadVerifiedProcessLocalRotationIntent
} from "./process-local-rotation-operation.mjs";
import { loadProcessLocalRotationProfile } from "./process-local-rotation.mjs";
import {
  verifyBotPullConfig,
  verifyBotPullConfigRotation
} from "./verify-bot-image-pull-config.mjs";
import {
  readPrivateProcessLocalValuesSource
} from "./project-process-local-values.mjs";
import {
  publishPrivateArtifact,
  readPublishedPrivateArtifact
} from "./private-artifact-publication.mjs";

const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const PRIVATE_FILE_MODE = 0o600;
const HEX_32 = /^[a-f0-9]{32}$/u;
const HEX_SHA256 = /^[a-f0-9]{64}$/u;
const NEW_DB_PASSWORD = /^[A-Za-z0-9_-]{32,128}$/u;
const INTERNAL_CREDENTIAL = /^[!-~]{32,512}$/u;
const GENERIC_CLI_ERROR = "process-local source transition failed closed\n";
const PYTHON = "python3";
const DIRFD_HELPER = fileURLToPath(new URL("./private-dirfd-ops.py", import.meta.url));
const DIRFD_HELPER_MISSING = 44;
const DOCUMENT_START_LF = Buffer.from("---\n", "ascii");
const DOCUMENT_START_CRLF = Buffer.from("---\r\n", "ascii");
const LEGACY_PERMS_BLOCK_HEADER = Buffer.from("PERMS_KEY: |", "ascii");
const PENDING_ATTRIBUTION_DOMAIN = Buffer.from(
  "yenhubs-aud065-source-pending-v1\0",
  "utf8"
);
const PRIVATE_REPLACEMENT_ATTRIBUTION_DOMAIN = Buffer.from(
  "yenhubs-private-values-replacement-v1\0",
  "utf8"
);
const QUARANTINE_PREFIX = ".yenhubs-unlink-quarantine-v2-";
const QUARANTINE_DOMAIN = Buffer.from(
  "yenhubs-unlink-owned-quarantine-v2\0",
  "utf8"
);
const QUARANTINE_NAME = new RegExp(
  `^${QUARANTINE_PREFIX.replaceAll(".", "\\.")}[a-f0-9]{64}$`,
  "u"
);

const INTERNAL_BOT_KEYS = Object.freeze([
  "BOT_ACCESS_KEY",
  "BOT_RUNNER_ACCESS_KEY",
  "BOT_ORCHESTRATOR_ACCESS_KEY",
  "DASHBOARD_ACCESS_KEY"
]);

const CANDIDATE_ONLY_REQUIRED_ROTATIONS = Object.freeze([
  "BOT_RUNNER_ACCESS_KEY",
  "BOT_ORCHESTRATOR_ACCESS_KEY",
  "DASHBOARD_ACCESS_KEY",
  "BOT_IMAGE_PULL_CONFIG_JSON_BASE64"
]);

export const PROCESS_LOCAL_SOURCE_TRANSITION_TOKENS = Object.freeze({
  snapshotsReady: "aud065_source_snapshots_ready",
  transitionVerified: "aud065_source_transition_verified",
  canonicalOld: "aud065_source_canonical_old",
  canonicalNew: "aud065_source_canonical_new",
  promoted: "aud065_source_promoted",
  alreadyPromoted: "aud065_source_already_promoted",
  exactUnlinked: "aud065_source_exact_unlinked",
  exactUnlinkReconciled: "aud065_source_exact_unlink_reconciled",
  exactUnlinkReconciliationNotRequired:
    "aud065_source_exact_unlink_reconciliation_not_required"
});

export class ProcessLocalSourceTransitionError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProcessLocalSourceTransitionError";
    this.code = code;
  }
}

function fail(code) {
  throw new ProcessLocalSourceTransitionError(code);
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest();
}

function digestHex(bytes) {
  return digest(bytes).toString("hex");
}

function safeBytesEqual(left, right) {
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) &&
    left.length === right.length && timingSafeEqual(left, right);
}

function safeStringEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  try {
    return safeBytesEqual(leftBytes, rightBytes);
  } finally {
    leftBytes.fill(0);
    rightBytes.fill(0);
  }
}

function safeHexEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" ||
      !HEX_SHA256.test(left) || !HEX_SHA256.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function sourceDocumentStart(bytes) {
  if (bytes.length >= DOCUMENT_START_CRLF.length &&
      bytes.subarray(0, DOCUMENT_START_CRLF.length).equals(DOCUMENT_START_CRLF)) {
    return bytes.subarray(0, DOCUMENT_START_CRLF.length);
  }
  if (bytes.length >= DOCUMENT_START_LF.length &&
      bytes.subarray(0, DOCUMENT_START_LF.length).equals(DOCUMENT_START_LF)) {
    return bytes.subarray(0, DOCUMENT_START_LF.length);
  }
  return undefined;
}

function requireSameDocumentStart(oldBytes, newBytes) {
  const oldStart = sourceDocumentStart(oldBytes);
  const newStart = sourceDocumentStart(newBytes);
  if (Boolean(oldStart) !== Boolean(newStart) ||
      (oldStart && !safeBytesEqual(oldStart, newStart))) {
    fail("source_document_start_changed");
  }
}

function sourceHasLegacyPermsBlock(bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const newline = bytes.indexOf(0x0a, offset);
    let end = newline === -1 ? bytes.length : newline;
    if (end > offset && bytes[end - 1] === 0x0d) end -= 1;
    if (end - offset === LEGACY_PERMS_BLOCK_HEADER.length &&
        bytes.subarray(offset, end).equals(LEGACY_PERMS_BLOCK_HEADER)) {
      return true;
    }
    if (newline === -1) break;
    offset = newline + 1;
  }
  return false;
}

function parseValues(bytes, code) {
  let values;
  try {
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) fail(code);
    values = parseLocalValuesSource(text);
  } catch (error) {
    if (error instanceof ProcessLocalSourceTransitionError) throw error;
    fail(code);
  }
  return values;
}

function sortedKeys(values) {
  return [...values.keys()].sort();
}

function sameKeyset(oldValues, newValues) {
  const oldKeys = sortedKeys(oldValues);
  const newKeys = sortedKeys(newValues);
  return oldKeys.length === newKeys.length &&
    oldKeys.every((name, index) => name === newKeys[index]);
}

function requireKeys(values, names) {
  if (names.some(name => !values.has(name))) fail("source_required_key_missing");
}

function requireChanged(oldValues, newValues, names, code) {
  for (const name of names) {
    const oldValue = oldValues.get(name);
    const newValue = newValues.get(name);
    if (typeof oldValue !== "string" || !oldValue ||
        typeof newValue !== "string" || !newValue ||
        safeStringEqual(oldValue, newValue)) {
      fail(code);
    }
  }
}

function permsPublicSpki(value, code) {
  try {
    if (typeof value !== "string" || !value) fail(code);
    const normalized = value
      .replace(/\\+r\\+n/gu, "\n")
      .replace(/\\+n/gu, "\n")
      .replace(/\r\n/gu, "\n")
      .trim();
    const privateKey = createPrivateKey(normalized);
    const publicKey = createPublicKey(privateKey);
    if (privateKey.asymmetricKeyType !== "rsa" ||
        publicKey.asymmetricKeyType !== "rsa" ||
        Number(privateKey.asymmetricKeyDetails?.modulusLength || 0) < 2048) {
      fail(code);
    }
    return Buffer.from(publicKey.export({ type: "spki", format: "der" }));
  } catch (error) {
    if (error instanceof ProcessLocalSourceTransitionError) throw error;
    fail(code);
  }
}

function requirePermsKeyRotated(oldValues, newValues) {
  let oldSpki;
  let newSpki;
  try {
    oldSpki = permsPublicSpki(oldValues.get("PERMS_KEY"), "old_source_perms_key_invalid");
    newSpki = permsPublicSpki(newValues.get("PERMS_KEY"), "new_source_perms_key_invalid");
    if (safeBytesEqual(oldSpki, newSpki)) {
      fail("required_source_secret_not_rotated");
    }
  } finally {
    if (oldSpki) oldSpki.fill(0);
    if (newSpki) newSpki.fill(0);
  }
}

function requireInternalDomains(values, code) {
  const domains = INTERNAL_BOT_KEYS.map(name => values.get(name));
  if (domains.some(value => typeof value !== "string" ||
      !INTERNAL_CREDENTIAL.test(value))) {
    fail(code);
  }
  for (let left = 0; left < domains.length; left += 1) {
    for (let right = left + 1; right < domains.length; right += 1) {
      if (safeStringEqual(domains[left], domains[right])) fail(code);
    }
  }
}

function requirePullConfigContract(values, code) {
  try {
    verifyBotPullConfig({
      encoded: values.get("BOT_IMAGE_PULL_CONFIG_JSON_BASE64"),
      botImage: values.get("OVERRIDE_BOT_ORCHESTRATOR_IMAGE"),
      runnerImage: values.get("OVERRIDE_BOT_RUNNER_IMAGE")
    });
  } catch {
    fail(code);
  }
}

function requirePullConfigRotation(oldValues, newValues) {
  try {
    verifyBotPullConfigRotation({
      oldEncoded: oldValues.get("BOT_IMAGE_PULL_CONFIG_JSON_BASE64"),
      newEncoded: newValues.get("BOT_IMAGE_PULL_CONFIG_JSON_BASE64"),
      botImage: newValues.get("OVERRIDE_BOT_ORCHESTRATOR_IMAGE"),
      runnerImage: newValues.get("OVERRIDE_BOT_RUNNER_IMAGE")
    });
  } catch {
    fail("pull_config_credential_not_rotated");
  }
}

function sourceTransitionContract(profile) {
  const requiredRotations = [...new Set([
    ...profile.required_rotated_secret_keys,
    ...CANDIDATE_ONLY_REQUIRED_ROTATIONS
  ])].sort();
  const optionalRotations = [...new Set(
    profile.rotate_if_configured_secret_keys
  )].sort();
  // Snapshot-derived values may be absent from the full local-values source.
  // When present they remain an authorized change, but the strong snapshot
  // validator derives them from the canonical material instead of requiring a
  // redundant source line. Database URIs are direct source values and remain
  // mandatory.
  const requiredDerivedChanges = [...new Set(
    Object.keys(profile.database_uri_contracts)
  )].sort();
  const derivedChanges = [...new Set([
    ...profile.derived_secret_keys,
    ...requiredDerivedChanges
  ])].sort();
  const requiredKeys = [...new Set([
    ...requiredRotations,
    ...optionalRotations,
    ...requiredDerivedChanges,
    ...INTERNAL_BOT_KEYS,
    "OVERRIDE_BOT_ORCHESTRATOR_IMAGE",
    "OVERRIDE_BOT_RUNNER_IMAGE"
  ])].sort();
  const authorizedChanges = new Set([
    ...requiredRotations,
    ...optionalRotations,
    ...derivedChanges
  ]);
  return { requiredRotations, optionalRotations, requiredKeys, authorizedChanges };
}

export function validateProcessLocalValuesSourceTransition({ oldBytes, newBytes }) {
  if (!Buffer.isBuffer(oldBytes) || !Buffer.isBuffer(newBytes) ||
      oldBytes.length < 1 || oldBytes.length > MAX_SOURCE_BYTES ||
      newBytes.length < 1 || newBytes.length > MAX_SOURCE_BYTES) {
    fail("source_transition_input_invalid");
  }
  const oldValues = parseValues(oldBytes, "old_source_invalid");
  const newValues = parseValues(newBytes, "new_source_invalid");
  if (sourceHasLegacyPermsBlock(newBytes)) {
    fail("new_source_perms_key_not_canonical");
  }
  requireSameDocumentStart(oldBytes, newBytes);
  const profile = loadProcessLocalRotationProfile();
  const contract = sourceTransitionContract(profile);
  if (!sameKeyset(oldValues, newValues)) fail("source_keyset_changed");
  requireKeys(oldValues, contract.requiredKeys);
  requireKeys(newValues, contract.requiredKeys);
  requireChanged(
    oldValues,
    newValues,
    contract.requiredRotations,
    "required_source_secret_not_rotated"
  );
  requirePermsKeyRotated(oldValues, newValues);
  for (const name of contract.optionalRotations) {
    const oldValue = oldValues.get(name);
    const newValue = newValues.get(name);
    if (Boolean(oldValue) !== Boolean(newValue)) {
      fail("optional_source_secret_presence_changed");
    }
    if (oldValue && safeStringEqual(oldValue, newValue)) {
      fail("configured_source_secret_not_rotated");
    }
  }
  for (const name of oldValues.keys()) {
    if (!contract.authorizedChanges.has(name) &&
        !safeStringEqual(oldValues.get(name), newValues.get(name))) {
      fail("unauthorized_source_value_changed");
    }
  }
  requireInternalDomains(oldValues, "old_internal_credential_contract_invalid");
  requireInternalDomains(newValues, "new_internal_credential_contract_invalid");
  if (!NEW_DB_PASSWORD.test(newValues.get("DB_PASS") || "")) {
    fail("new_db_password_contract_invalid");
  }
  requirePullConfigContract(oldValues, "old_pull_config_contract_invalid");
  requirePullConfigContract(newValues, "new_pull_config_contract_invalid");
  requirePullConfigRotation(oldValues, newValues);
  return PROCESS_LOCAL_SOURCE_TRANSITION_TOKENS.transitionVerified;
}

function operationPaths(operationDirectory) {
  if (typeof operationDirectory !== "string" || !operationDirectory ||
      /[\u0000\r\n]/u.test(operationDirectory)) {
    fail("operation_directory_invalid");
  }
  const absolute = path.resolve(operationDirectory);
  return {
    operationDirectory: absolute,
    oldSource: path.join(
      absolute,
      PROCESS_LOCAL_OPERATION_FILES.oldValuesSource
    ),
    newSource: path.join(
      absolute,
      PROCESS_LOCAL_OPERATION_FILES.newValuesSource
    )
  };
}

function readBoundSources(operationDirectory) {
  const paths = operationPaths(operationDirectory);
  let oldBytes;
  let newBytes;
  try {
    oldBytes = readPublishedPrivateArtifact({
      outputPath: paths.oldSource,
      maximumBytes: MAX_SOURCE_BYTES
    });
    newBytes = readPublishedPrivateArtifact({
      outputPath: paths.newSource,
      maximumBytes: MAX_SOURCE_BYTES
    });
    return { paths, oldBytes, newBytes };
  } catch (error) {
    if (oldBytes) oldBytes.fill(0);
    if (newBytes) newBytes.fill(0);
    if (error instanceof ProcessLocalSourceTransitionError) throw error;
    fail("source_artifact_invalid");
  }
}

function wipeSources(sources) {
  if (sources?.oldBytes) sources.oldBytes.fill(0);
  if (sources?.newBytes) sources.newBytes.fill(0);
}

function derivePendingAttribution({ basename, intent, newBytes }) {
  let derivedKey;
  let basenameBytes;
  let operationId;
  let operationBinding;
  let sourceDigest;
  try {
    if (typeof basename !== "string" || !basename || /[\u0000/]/u.test(basename) ||
        !HEX_SHA256.test(intent.hmacSha256 || "")) {
      fail("source_intent_invalid");
    }
    derivedKey = Buffer.from(intent.hmacSha256, "hex");
    basenameBytes = Buffer.from(basename, "utf8");
    operationId = Buffer.from(intent.operationId, "hex");
    operationBinding = Buffer.from(intent.operationBindingSha256, "hex");
    sourceDigest = digest(newBytes);
    return createHmac("sha256", derivedKey)
      .update(PENDING_ATTRIBUTION_DOMAIN)
      .update(basenameBytes)
      .update(Buffer.from([0]))
      .update(operationId)
      .update(operationBinding)
      .update(sourceDigest)
      .digest("hex");
  } catch (error) {
    if (error instanceof ProcessLocalSourceTransitionError) throw error;
    fail("source_intent_invalid");
  } finally {
    if (derivedKey) derivedKey.fill(0);
    if (basenameBytes) basenameBytes.fill(0);
    if (operationId) operationId.fill(0);
    if (operationBinding) operationBinding.fill(0);
    if (sourceDigest) sourceDigest.fill(0);
  }
}

export function snapshotProcessLocalValuesSources({
  operationDirectory,
  oldValuesSource,
  newValuesSource,
  hooks
}) {
  const paths = operationPaths(operationDirectory);
  let oldBytes;
  let newBytes;
  let oldPublished;
  let newPublished;
  try {
    oldBytes = readPrivateProcessLocalValuesSource(oldValuesSource);
    newBytes = readPrivateProcessLocalValuesSource(newValuesSource);
    validateProcessLocalValuesSourceTransition({ oldBytes, newBytes });
    oldPublished = publishPrivateArtifact({
      outputPath: paths.oldSource,
      bytes: oldBytes,
      maximumBytes: MAX_SOURCE_BYTES,
      hooks: hooks?.oldPublication
    });
    newPublished = publishPrivateArtifact({
      outputPath: paths.newSource,
      bytes: newBytes,
      maximumBytes: MAX_SOURCE_BYTES,
      hooks: hooks?.newPublication
    });
    const bound = readBoundSources(operationDirectory);
    try {
      if (!safeBytesEqual(bound.oldBytes, oldBytes) ||
          !safeBytesEqual(bound.newBytes, newBytes)) {
        fail("source_snapshot_mismatch");
      }
    } finally {
      wipeSources(bound);
    }
    return PROCESS_LOCAL_SOURCE_TRANSITION_TOKENS.snapshotsReady;
  } catch (error) {
    if (error instanceof ProcessLocalSourceTransitionError) throw error;
    fail(oldPublished || newPublished
      ? "source_snapshot_publication_incomplete"
      : "source_snapshot_failed");
  } finally {
    if (oldBytes) oldBytes.fill(0);
    if (newBytes) newBytes.fill(0);
  }
}

function loadBoundTransition(options) {
  let sources;
  try {
    const intent = loadVerifiedProcessLocalRotationIntent({
      operationDirectory: options.operationDirectory,
      expectedOperationId: options.expectedOperationId,
      expectedOperationBindingSha256: options.expectedOperationBindingSha256
    });
    if (!HEX_32.test(intent.operationId || "") ||
        !HEX_SHA256.test(intent.operationBindingSha256 || "") ||
        !HEX_SHA256.test(intent.oldValuesSourceSha256 || "") ||
        !HEX_SHA256.test(intent.newValuesSourceSha256 || "")) {
      fail("source_intent_invalid");
    }
    sources = readBoundSources(options.operationDirectory);
    if (!safeHexEqual(intent.oldValuesSourceSha256, digestHex(sources.oldBytes)) ||
        !safeHexEqual(intent.newValuesSourceSha256, digestHex(sources.newBytes))) {
      fail("source_intent_binding_mismatch");
    }
    validateProcessLocalValuesSourceTransition(sources);
    return { intent, ...sources };
  } catch (error) {
    wipeSources(sources);
    if (error instanceof ProcessLocalSourceTransitionError) throw error;
    fail("source_transition_verification_failed");
  }
}

function classifyCanonicalBytes(current, sources) {
  const oldMatch = safeBytesEqual(current, sources.oldBytes);
  const newMatch = safeBytesEqual(current, sources.newBytes);
  if (oldMatch === newMatch) fail("canonical_source_state_invalid");
  return oldMatch ? "old" : "new";
}

function readCanonicalValues(canonicalValuesPath) {
  try {
    const contract = pathContract(canonicalValuesPath);
    const leaf = contract.at(-1)?.stat;
    const parent = contract.at(-2)?.stat;
    if (!privateRegularFile(leaf) || !privatePromotionDirectory(parent)) {
      fail("canonical_source_parent_invalid");
    }
    return readPrivateProcessLocalValuesSource(canonicalValuesPath);
  } catch (error) {
    fail(error?.code === "private_source_changed"
      ? "canonical_source_changed"
      : "canonical_source_invalid");
  }
}

export function verifyProcessLocalValuesSourceTransition(options) {
  const expectedState = options?.expectedState;
  if (expectedState !== undefined && !["old", "new", "either"].includes(expectedState)) {
    fail("source_expected_state_invalid");
  }
  const bound = loadBoundTransition(options);
  let canonicalBytes;
  try {
    if (options.canonicalValuesPath === undefined) {
      if (expectedState !== undefined) fail("canonical_source_path_required");
      return PROCESS_LOCAL_SOURCE_TRANSITION_TOKENS.transitionVerified;
    }
    canonicalBytes = readCanonicalValues(options.canonicalValuesPath);
    const state = classifyCanonicalBytes(canonicalBytes, bound);
    if (expectedState !== undefined && expectedState !== "either" &&
        state !== expectedState) {
      fail("canonical_source_state_mismatch");
    }
    return state === "old"
      ? PROCESS_LOCAL_SOURCE_TRANSITION_TOKENS.canonicalOld
      : PROCESS_LOCAL_SOURCE_TRANSITION_TOKENS.canonicalNew;
  } finally {
    if (canonicalBytes) canonicalBytes.fill(0);
    wipeSources(bound);
  }
}

function currentUidMatches(stat) {
  return typeof process.getuid !== "function" || stat.uid === BigInt(process.getuid());
}

function sameNode(left, right, { content = false } = {}) {
  return left.dev === right.dev && left.ino === right.ino &&
    left.uid === right.uid && left.mode === right.mode &&
    (!left.isFile() || left.nlink === right.nlink) &&
    left.isFile() === right.isFile() &&
    left.isDirectory() === right.isDirectory() &&
    (!content || (left.size === right.size && left.mtimeNs === right.mtimeNs &&
      left.ctimeNs === right.ctimeNs));
}

function pathContract(target) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  const names = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  return names.map((name, index) => {
    if (name === "." || name === "..") fail("canonical_source_path_invalid");
    current = path.join(current, name);
    let stat;
    try {
      stat = fs.lstatSync(current, { bigint: true });
    } catch {
      fail("canonical_source_path_invalid");
    }
    if (stat.isSymbolicLink() || (index < names.length - 1 && !stat.isDirectory())) {
      fail("canonical_source_path_invalid");
    }
    return { path: current, stat };
  });
}

function samePathContract(before, after, { leafContent = false } = {}) {
  return before.length === after.length && before.every((entry, index) =>
    entry.path === after[index].path && sameNode(entry.stat, after[index].stat, {
      content: leafContent && index === before.length - 1
    })
  );
}

function privateRegularFile(stat, { allowEmpty = false } = {}) {
  return stat?.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n &&
    currentUidMatches(stat) && Number(stat.mode & 0o7777n) === PRIVATE_FILE_MODE &&
    (allowEmpty || stat.size > 0n) && stat.size <= BigInt(MAX_SOURCE_BYTES);
}

function privatePromotionDirectory(stat) {
  return stat?.isDirectory() && !stat.isSymbolicLink() &&
    currentUidMatches(stat) && Number(stat.mode & 0o022n) === 0;
}

function helperDirectoryIdentity(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    uid: String(stat.uid),
    mode: String(Number(stat.mode & 0o7777n))
  };
}

function helperStatIdentity(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    uid: String(stat.uid),
    mode: String(stat.mode),
    nlink: String(stat.nlink),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs)
  };
}

function decodedHelperStat(value) {
  try {
    if (!value || typeof value !== "object") fail("canonical_source_changed");
    const kind = value.kind;
    const result = {
      dev: BigInt(value.dev),
      ino: BigInt(value.ino),
      uid: BigInt(value.uid),
      mode: BigInt(value.mode),
      nlink: BigInt(value.nlink),
      size: BigInt(value.size),
      mtimeNs: BigInt(value.mtimeNs),
      ctimeNs: BigInt(value.ctimeNs),
      sha256: value.sha256,
      isFile: () => kind === "file",
      isDirectory: () => kind === "directory",
      isSymbolicLink: () => kind === "symlink"
    };
    if (result.sha256 !== undefined && !HEX_SHA256.test(result.sha256)) {
      fail("canonical_source_changed");
    }
    return result;
  } catch (error) {
    if (error instanceof ProcessLocalSourceTransitionError) throw error;
    fail("canonical_source_changed");
  }
}

function runDirfdHelper(parentDescriptor, parentStat, action, args = {}, {
  input = Buffer.alloc(0),
  allowMissing = false,
  errorCode = "canonical_source_changed"
} = {}) {
  if (!fs.existsSync(DIRFD_HELPER)) {
    fail("canonical_source_filesystem_unsupported");
  }
  const identity = helperDirectoryIdentity(parentStat);
  const request = JSON.stringify({
    action,
    args,
    target: identity,
    staging: identity
  });
  const helperInput = Buffer.concat([Buffer.from(`${request}\n`, "utf8"), input]);
  let result;
  try {
    result = spawnSync(PYTHON, ["-I", DIRFD_HELPER], {
      input: helperInput,
      encoding: null,
      maxBuffer: 64 * 1024,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      stdio: ["pipe", "pipe", "pipe", parentDescriptor, parentDescriptor]
    });
  } finally {
    helperInput.fill(0);
  }
  if (allowMissing && result.status === DIRFD_HELPER_MISSING) return undefined;
  if (result.error?.code === "ENOENT") {
    fail("canonical_source_filesystem_unsupported");
  }
  if (result.error || result.signal || result.status !== 0 ||
      !Buffer.isBuffer(result.stdout)) {
    fail(errorCode);
  }
  return result.stdout;
}

function decodeHelperOutput(output, code) {
  try {
    return decodedHelperStat(JSON.parse(output.toString("utf8")));
  } catch (error) {
    if (error instanceof ProcessLocalSourceTransitionError) throw error;
    fail(code);
  }
}

function anchoredInspect(parentDescriptor, parentStat, name, {
  allowMissing = false,
  code = "canonical_source_changed"
} = {}) {
  const output = runDirfdHelper(parentDescriptor, parentStat, "inspect", {
    directory: "target",
    name,
    maximum: MAX_SOURCE_BYTES
  }, { allowMissing, errorCode: code });
  if (output === undefined) return undefined;
  return decodeHelperOutput(output, code);
}

function anchoredList(parentDescriptor, parentStat, {
  code = "canonical_source_changed"
} = {}) {
  const output = runDirfdHelper(parentDescriptor, parentStat, "list", {
    directory: "target"
  }, { errorCode: code });
  try {
    const names = JSON.parse(output.toString("utf8"));
    if (!Array.isArray(names) || names.some(name =>
      typeof name !== "string" || !name || name === "." || name === ".." ||
      name.includes("/") || name.includes("\u0000")
    ) || new Set(names).size !== names.length) {
      fail(code);
    }
    return names;
  } catch (error) {
    if (error instanceof ProcessLocalSourceTransitionError) throw error;
    fail(code);
  }
}

function anchoredWriteReconciled(
  parentDescriptor,
  parentStat,
  name,
  attribution,
  bytes
) {
  const output = runDirfdHelper(parentDescriptor, parentStat, "write-reconcile", {
    directory: "target",
    name,
    attribution,
    length: bytes.length,
    maximum: MAX_SOURCE_BYTES
  }, {
    input: bytes,
    errorCode: "canonical_source_write_failed"
  });
  return decodeHelperOutput(output, "canonical_source_write_failed");
}

function anchoredCasReplace(parentDescriptor, parentStat, {
  parentPath,
  destination,
  destinationStat,
  destinationBytes,
  pending,
  pendingStat,
  pendingAttribution,
  pendingBytes
}) {
  const output = runDirfdHelper(parentDescriptor, parentStat, "cas-replace", {
    directory: "target",
    parentPath,
    destination,
    destinationExpected: helperStatIdentity(destinationStat),
    destinationLength: destinationBytes.length,
    destinationSha256: digestHex(destinationBytes),
    pending,
    attribution: pendingAttribution,
    pendingExpected: helperStatIdentity(pendingStat),
    pendingLength: pendingBytes.length,
    pendingSha256: digestHex(pendingBytes),
    maximum: MAX_SOURCE_BYTES
  }, { errorCode: "canonical_source_cas_mismatch" });
  return decodeHelperOutput(output, "canonical_source_promotion_failed");
}

function anchoredUnlinkOwned(parentDescriptor, parentStat, name, expected, {
  allowMissing = true,
  errorCode = "canonical_source_cleanup_failed",
  expectedLength,
  expectedSha256,
  testSwapBeforeQuarantine,
  testCutAfterQuarantine,
  testSwapQuarantineBeforeUnlink,
  testOccupyNameBeforeRestore,
  disableRetryForTest = false
} = {}) {
  const helperExpected = expectedSha256 === undefined
    ? helperStatIdentity(expected)
    : {
        dev: String(expected.dev),
        ino: String(expected.ino),
        size: String(expectedLength)
      };
  const helperArgs = {
    directory: "target",
    name,
    expected: helperExpected,
    maximum: MAX_SOURCE_BYTES,
    ...(expectedLength === undefined ? {} : { expectedLength }),
    ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
    ...(testSwapBeforeQuarantine === undefined
      ? {}
      : { testSwapBeforeQuarantine }),
    ...(testCutAfterQuarantine === undefined
      ? {}
      : { testCutAfterQuarantine }),
    ...(testSwapQuarantineBeforeUnlink === undefined
      ? {}
      : { testSwapQuarantineBeforeUnlink }),
    ...(testOccupyNameBeforeRestore === undefined
      ? {}
      : { testOccupyNameBeforeRestore })
  };
  const helperOptions = { allowMissing, errorCode };
  try {
    runDirfdHelper(
      parentDescriptor,
      parentStat,
      "unlink-owned",
      helperArgs,
      helperOptions
    );
  } catch (error) {
    if (expectedLength === undefined || expectedSha256 === undefined ||
        disableRetryForTest) {
      throw error;
    }
    const retryArgs = { ...helperArgs };
    delete retryArgs.testCutAfterQuarantine;
    runDirfdHelper(
      parentDescriptor,
      parentStat,
      "unlink-owned",
      retryArgs,
      helperOptions
    );
  }
}

function runHook(hooks, name, context) {
  if (hooks?.[name] === undefined) return;
  if (typeof hooks[name] !== "function") fail("source_transition_hook_invalid");
  hooks[name](Object.freeze({ ...context }));
}

function requireCanonicalPathStable({
  absolute,
  beforeComponents,
  parentDescriptor,
  parentBefore,
  code
}) {
  try {
    const afterComponents = pathContract(absolute);
    const currentParent = fs.fstatSync(parentDescriptor, { bigint: true });
    if (!privatePromotionDirectory(currentParent) ||
        !sameNode(parentBefore, currentParent) ||
        !samePathContract(beforeComponents, afterComponents, { leafContent: true })) {
      fail(code);
    }
  } catch (error) {
    if (error instanceof ProcessLocalSourceTransitionError && error.code === code) {
      throw error;
    }
    fail(code);
  }
}

function requireParentPathStable({
  parentPath,
  beforeComponents,
  parentDescriptor,
  parentBefore,
  code
}) {
  try {
    const afterComponents = pathContract(parentPath);
    const currentParent = fs.fstatSync(parentDescriptor, { bigint: true });
    if (!privatePromotionDirectory(currentParent) ||
        !sameNode(parentBefore, currentParent) ||
        !samePathContract(beforeComponents, afterComponents)) {
      fail(code);
    }
  } catch (error) {
    if (error instanceof ProcessLocalSourceTransitionError && error.code === code) {
      throw error;
    }
    fail(code);
  }
}

function inspectedBytesMatch(stat, bytes) {
  return privateRegularFile(stat) && stat.size === BigInt(bytes.length) &&
    safeHexEqual(stat.sha256, digestHex(bytes));
}

function privateExactReconciliationDirectory(stat) {
  return privatePromotionDirectory(stat) &&
    Number(stat.mode & 0o7777n) === 0o700;
}

function exactUnlinkQuarantineName(basename, stat, code) {
  if (typeof basename !== "string" || !basename || basename === "." ||
      basename === ".." || basename.includes("/") ||
      typeof stat?.dev !== "bigint" || typeof stat?.ino !== "bigint" ||
      typeof stat?.size !== "bigint" || stat.dev < 0n || stat.ino < 1n ||
      stat.size < 0n || stat.size > BigInt(MAX_SOURCE_BYTES) ||
      !HEX_SHA256.test(stat.sha256 || "")) {
    fail(code);
  }
  const encoded = Buffer.from([
    "unlink-owned",
    basename,
    String(stat.dev),
    String(stat.ino),
    String(stat.size),
    stat.sha256
  ].join("\0"), "utf8");
  try {
    return `${QUARANTINE_PREFIX}${createHash("sha256")
      .update(QUARANTINE_DOMAIN)
      .update(encoded)
      .digest("hex")}`;
  } finally {
    encoded.fill(0);
  }
}

function matchingExactUnlinkQuarantines(
  parentDescriptor,
  parentStat,
  basename,
  code
) {
  const matches = [];
  for (const name of anchoredList(parentDescriptor, parentStat, { code })) {
    if (!QUARANTINE_NAME.test(name)) continue;
    const stat = anchoredInspect(parentDescriptor, parentStat, name, {
      allowMissing: true,
      code
    });
    if (stat !== undefined &&
        name === exactUnlinkQuarantineName(basename, stat, code)) {
      matches.push(Object.freeze({ name, stat }));
    }
  }
  return matches;
}

function checkedExactIdentity(value) {
  const keys = value && typeof value === "object" && !Array.isArray(value)
    ? Reflect.ownKeys(value)
    : [];
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      keys.length !== 2 || keys.some(key => typeof key !== "string") ||
      JSON.stringify([...keys].sort()) !== JSON.stringify(["dev", "ino"]) ||
      typeof value.dev !== "bigint" || typeof value.ino !== "bigint" ||
      value.dev < 0n || value.ino < 1n) {
    fail("canonical_source_unlink_identity_invalid");
  }
  return Object.freeze({ dev: value.dev, ino: value.ino });
}

function helperSubstitutionForTest(hooks, hookName, canonicalValuesPath) {
  const hook = hooks?.[hookName];
  if (hook === undefined) return undefined;
  if (typeof hook !== "function") fail("source_transition_hook_invalid");
  const value = hook(Object.freeze({ canonicalValuesPath }));
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !==
        JSON.stringify(["displacedPath", "foreignPath"])) {
    fail("source_transition_hook_invalid");
  }
  const parentPath = path.dirname(canonicalValuesPath);
  const paths = [value.foreignPath, value.displacedPath];
  if (paths.some(candidate =>
    typeof candidate !== "string" || !path.isAbsolute(candidate) ||
    /[\u0000\r\n]/u.test(candidate) ||
    path.dirname(path.resolve(candidate)) !== parentPath
  )) {
    fail("source_transition_hook_invalid");
  }
  const names = paths.map(candidate => path.basename(path.resolve(candidate)));
  if (new Set([path.basename(canonicalValuesPath), ...names]).size !== 3 ||
      names.some(name => !name || name === "." || name === "..")) {
    fail("source_transition_hook_invalid");
  }
  return Object.freeze({ foreign: names[0], displaced: names[1] });
}

function helperOccupantForTest(hooks, canonicalValuesPath) {
  const hook = hooks?.helperOccupyNameBeforeRestoreForTest;
  if (hook === undefined) return undefined;
  if (typeof hook !== "function") fail("source_transition_hook_invalid");
  const value = hook(Object.freeze({ canonicalValuesPath }));
  const parentPath = path.dirname(canonicalValuesPath);
  if (typeof value !== "string" || !path.isAbsolute(value) ||
      /[\u0000\r\n]/u.test(value) ||
      path.dirname(path.resolve(value)) !== parentPath ||
      path.resolve(value) === canonicalValuesPath) {
    fail("source_transition_hook_invalid");
  }
  return path.basename(path.resolve(value));
}

function helperCutAfterQuarantineForTest(hooks, canonicalValuesPath) {
  const hook = hooks?.helperCutAfterQuarantineForTest;
  if (hook === undefined) return undefined;
  if (typeof hook !== "function" ||
      hook(Object.freeze({ canonicalValuesPath })) !== true) {
    fail("source_transition_hook_invalid");
  }
  return true;
}

function helperDisableRetryForTest(hooks, canonicalValuesPath) {
  const hook = hooks?.helperDisableRetryForTest;
  if (hook === undefined) return false;
  if (typeof hook !== "function" ||
      hook(Object.freeze({ canonicalValuesPath })) !== true) {
    fail("source_transition_hook_invalid");
  }
  return true;
}

export function unlinkPrivateProcessLocalValuesSourceExact({
  canonicalValuesPath,
  expectedBytes,
  expectedIdentity,
  hooks
}) {
  if (typeof canonicalValuesPath !== "string" || !canonicalValuesPath ||
      /[\u0000\r\n]/u.test(canonicalValuesPath) ||
      !Buffer.isBuffer(expectedBytes) || expectedBytes.length < 1 ||
      expectedBytes.length > MAX_SOURCE_BYTES) {
    fail("canonical_source_unlink_invalid");
  }
  const identity = checkedExactIdentity(expectedIdentity);
  if (typeof fs.constants.O_NOFOLLOW !== "number" ||
      typeof fs.constants.O_DIRECTORY !== "number") {
    fail("canonical_source_filesystem_unsupported");
  }
  const absolute = path.resolve(canonicalValuesPath);
  const parentPath = path.dirname(absolute);
  const basename = path.basename(absolute);
  if (!basename || basename === "." || basename === "..") {
    fail("canonical_source_path_invalid");
  }
  let beforeComponents;
  try {
    beforeComponents = pathContract(parentPath);
  } catch {
    fail("canonical_source_unlink_conflict");
  }
  const parentBefore = beforeComponents.at(-1)?.stat;
  if (!privatePromotionDirectory(parentBefore)) {
    fail("canonical_source_unlink_conflict");
  }
  let parentDescriptor;
  let result;
  let failure;
  try {
    parentDescriptor = fs.openSync(
      parentPath,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
    );
    const openedParent = fs.fstatSync(parentDescriptor, { bigint: true });
    if (!privatePromotionDirectory(openedParent) ||
        !sameNode(parentBefore, openedParent)) {
      fail("canonical_source_unlink_conflict");
    }
    runHook(hooks, "beforeUnlink", { canonicalValuesPath: absolute });
    requireParentPathStable({
      parentPath,
      beforeComponents,
      parentDescriptor,
      parentBefore,
      code: "canonical_source_unlink_conflict"
    });
    const testSwapBeforeQuarantine = helperSubstitutionForTest(
      hooks,
      "helperSubstitutionForTest",
      absolute
    );
    const testSwapQuarantineBeforeUnlink = helperSubstitutionForTest(
      hooks,
      "helperFinalSubstitutionForTest",
      absolute
    );
    anchoredUnlinkOwned(parentDescriptor, openedParent, basename, identity, {
      allowMissing: false,
      errorCode: "canonical_source_unlink_conflict",
      expectedLength: expectedBytes.length,
      expectedSha256: digestHex(expectedBytes),
      testSwapBeforeQuarantine,
      testCutAfterQuarantine: helperCutAfterQuarantineForTest(hooks, absolute),
      testSwapQuarantineBeforeUnlink,
      testOccupyNameBeforeRestore: helperOccupantForTest(hooks, absolute),
      disableRetryForTest: helperDisableRetryForTest(hooks, absolute)
    });
    runHook(hooks, "afterUnlink", { canonicalValuesPath: absolute });
    if (anchoredInspect(parentDescriptor, openedParent, basename, {
      allowMissing: true,
      code: "canonical_source_unlink_conflict"
    }) !== undefined) {
      fail("canonical_source_unlink_conflict");
    }
    const parentAfter = pathContract(parentPath);
    const openedParentAfter = fs.fstatSync(parentDescriptor, { bigint: true });
    if (!privatePromotionDirectory(openedParentAfter) ||
        !sameNode(parentBefore, openedParentAfter) ||
        !samePathContract(beforeComponents, parentAfter)) {
      fail("canonical_source_unlink_conflict");
    }
    result = PROCESS_LOCAL_SOURCE_TRANSITION_TOKENS.exactUnlinked;
  } catch (error) {
    failure = error instanceof ProcessLocalSourceTransitionError
      ? error
      : new ProcessLocalSourceTransitionError("canonical_source_unlink_failed");
  } finally {
    if (parentDescriptor !== undefined) {
      try { fs.fsyncSync(parentDescriptor); } catch { /* Best effort. */ }
      try { fs.closeSync(parentDescriptor); } catch { /* Preserve failure. */ }
    }
  }
  if (failure) throw failure;
  return result;
}

export function reconcilePrivateProcessLocalValuesSourceExactUnlink({
  canonicalValuesPath,
  expectedBytes
}) {
  const errorCode = "canonical_source_unlink_reconciliation_conflict";
  if (typeof canonicalValuesPath !== "string" || !canonicalValuesPath ||
      /[\u0000\r\n]/u.test(canonicalValuesPath) ||
      !Buffer.isBuffer(expectedBytes) || expectedBytes.length < 1 ||
      expectedBytes.length > MAX_SOURCE_BYTES) {
    fail("canonical_source_unlink_reconciliation_invalid");
  }
  if (typeof fs.constants.O_NOFOLLOW !== "number" ||
      typeof fs.constants.O_DIRECTORY !== "number") {
    fail("canonical_source_filesystem_unsupported");
  }
  const absolute = path.resolve(canonicalValuesPath);
  const parentPath = path.dirname(absolute);
  const basename = path.basename(absolute);
  if (!basename || basename === "." || basename === "..") {
    fail("canonical_source_path_invalid");
  }
  let beforeComponents;
  try {
    beforeComponents = pathContract(parentPath);
  } catch {
    fail(errorCode);
  }
  const parentBefore = beforeComponents.at(-1)?.stat;
  if (!privateExactReconciliationDirectory(parentBefore)) fail(errorCode);

  let parentDescriptor;
  let result;
  let failure;
  try {
    parentDescriptor = fs.openSync(
      parentPath,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
    );
    const openedParent = fs.fstatSync(parentDescriptor, { bigint: true });
    if (!privateExactReconciliationDirectory(openedParent) ||
        !sameNode(parentBefore, openedParent)) {
      fail(errorCode);
    }
    requireParentPathStable({
      parentPath,
      beforeComponents,
      parentDescriptor,
      parentBefore,
      code: errorCode
    });

    const quarantines = matchingExactUnlinkQuarantines(
      parentDescriptor,
      openedParent,
      basename,
      errorCode
    );
    if (quarantines.length > 1) fail(errorCode);

    if (quarantines.length === 1) {
      const canonical = anchoredInspect(parentDescriptor, openedParent, basename, {
        allowMissing: true,
        code: errorCode
      });
      if (canonical !== undefined) fail(errorCode);
      const [{ name, stat }] = quarantines;
      if (!inspectedBytesMatch(stat, expectedBytes)) fail(errorCode);
      anchoredUnlinkOwned(
        parentDescriptor,
        openedParent,
        basename,
        { dev: stat.dev, ino: stat.ino },
        {
          allowMissing: false,
          errorCode,
          expectedLength: expectedBytes.length,
          expectedSha256: digestHex(expectedBytes)
        }
      );
      if (anchoredInspect(parentDescriptor, openedParent, basename, {
        allowMissing: true,
        code: errorCode
      }) !== undefined || anchoredInspect(parentDescriptor, openedParent, name, {
        allowMissing: true,
        code: errorCode
      }) !== undefined) {
        fail(errorCode);
      }
      result = PROCESS_LOCAL_SOURCE_TRANSITION_TOKENS.exactUnlinkReconciled;
    } else {
      result = PROCESS_LOCAL_SOURCE_TRANSITION_TOKENS
        .exactUnlinkReconciliationNotRequired;
    }

    if ((result === PROCESS_LOCAL_SOURCE_TRANSITION_TOKENS.exactUnlinkReconciled &&
        anchoredInspect(parentDescriptor, openedParent, basename, {
          allowMissing: true,
          code: errorCode
        }) !== undefined) || matchingExactUnlinkQuarantines(
      parentDescriptor,
      openedParent,
      basename,
      errorCode
    ).length !== 0) {
      fail(errorCode);
    }
    requireParentPathStable({
      parentPath,
      beforeComponents,
      parentDescriptor,
      parentBefore,
      code: errorCode
    });
    if (!privateExactReconciliationDirectory(
      fs.fstatSync(parentDescriptor, { bigint: true })
    )) {
      fail(errorCode);
    }
  } catch (error) {
    failure = error instanceof ProcessLocalSourceTransitionError
      ? error
      : new ProcessLocalSourceTransitionError(
          "canonical_source_unlink_reconciliation_failed"
        );
  } finally {
    if (parentDescriptor !== undefined) {
      try { fs.fsyncSync(parentDescriptor); } catch { /* Best effort. */ }
      try { fs.closeSync(parentDescriptor); } catch { /* Preserve failure. */ }
    }
  }
  if (failure) throw failure;
  return result;
}

function sourcePendingName(basename, pendingAttribution) {
  if (!HEX_SHA256.test(pendingAttribution || "")) fail("source_intent_invalid");
  return `.${basename}.aud065-new-${pendingAttribution}`;
}

function replaceCanonicalBytes(
  canonicalValuesPath,
  oldBytes,
  newBytes,
  pendingAttribution,
  hooks
) {
  if (typeof fs.constants.O_NOFOLLOW !== "number" ||
      typeof fs.constants.O_DIRECTORY !== "number" ||
      typeof fs.constants.O_EXCL !== "number") {
    fail("canonical_source_filesystem_unsupported");
  }
  const absolute = path.resolve(canonicalValuesPath);
  const parentPath = path.dirname(absolute);
  const basename = path.basename(absolute);
  if (!basename || basename === "." || basename === "..") {
    fail("canonical_source_path_invalid");
  }
  if (!HEX_SHA256.test(pendingAttribution || "")) {
    fail("source_intent_invalid");
  }
  const beforeComponents = pathContract(absolute);
  const destinationBefore = beforeComponents.at(-1)?.stat;
  const parentBefore = beforeComponents.at(-2)?.stat;
  if (!privateRegularFile(destinationBefore) ||
      !privatePromotionDirectory(parentBefore)) {
    fail("canonical_source_invalid");
  }
  const pendingName = sourcePendingName(basename, pendingAttribution);
  let parentDescriptor;
  let pendingStat;
  let pendingMayExist = false;
  let failure;
  let result;
  try {
    parentDescriptor = fs.openSync(
      parentPath,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
    );
    const openedParent = fs.fstatSync(parentDescriptor, { bigint: true });
    if (!privatePromotionDirectory(openedParent) ||
        !sameNode(parentBefore, openedParent)) {
      fail("canonical_source_path_changed");
    }
    const destination = anchoredInspect(parentDescriptor, openedParent, basename, {
      code: "canonical_source_invalid"
    });
    if (!sameNode(destinationBefore, destination, { content: true })) {
      fail("canonical_source_changed");
    }
    const oldMatch = inspectedBytesMatch(destination, oldBytes);
    const newMatch = inspectedBytesMatch(destination, newBytes);
    if (oldMatch === newMatch) fail("canonical_source_state_invalid");
    if (newMatch) {
      const stalePending = anchoredInspect(
        parentDescriptor,
        openedParent,
        pendingName,
        { allowMissing: true, code: "canonical_source_pending_invalid" }
      );
      if (stalePending !== undefined) {
        if (!inspectedBytesMatch(stalePending, newBytes)) {
          fail("canonical_source_pending_invalid");
        }
        anchoredUnlinkOwned(
          parentDescriptor,
          openedParent,
          pendingName,
          stalePending
        );
      }
      result = PROCESS_LOCAL_SOURCE_TRANSITION_TOKENS.alreadyPromoted;
      return result;
    }

    pendingMayExist = true;
    pendingStat = anchoredWriteReconciled(
      parentDescriptor,
      openedParent,
      pendingName,
      pendingAttribution,
      newBytes
    );
    if (!inspectedBytesMatch(pendingStat, newBytes)) {
      fail("canonical_source_write_failed");
    }
    runHook(hooks, "afterPendingFsync", { canonicalValuesPath: absolute });
    runHook(hooks, "beforeFinalCompare", { canonicalValuesPath: absolute });
    requireCanonicalPathStable({
      absolute,
      beforeComponents,
      parentDescriptor,
      parentBefore,
      code: "canonical_source_cas_mismatch"
    });
    runHook(hooks, "beforeRename", { canonicalValuesPath: absolute });
    requireCanonicalPathStable({
      absolute,
      beforeComponents,
      parentDescriptor,
      parentBefore,
      code: "canonical_source_cas_mismatch"
    });
    const promoted = anchoredCasReplace(parentDescriptor, openedParent, {
      parentPath,
      destination: basename,
      destinationStat: destination,
      destinationBytes: oldBytes,
      pending: pendingName,
      pendingStat,
      pendingAttribution,
      pendingBytes: newBytes
    });
    pendingMayExist = false;
    runHook(hooks, "afterRenameBeforeFsync", { canonicalValuesPath: absolute });
    if (!inspectedBytesMatch(promoted, newBytes)) {
      fail("canonical_source_promotion_failed");
    }
    requireCanonicalPathStable({
      absolute,
      beforeComponents: beforeComponents.map((entry, index) => index ===
        beforeComponents.length - 1 ? { ...entry, stat: promoted } : entry),
      parentDescriptor,
      parentBefore,
      code: "canonical_source_promotion_failed"
    });
    result = PROCESS_LOCAL_SOURCE_TRANSITION_TOKENS.promoted;
  } catch (error) {
    failure = error instanceof ProcessLocalSourceTransitionError
      ? error
      : new ProcessLocalSourceTransitionError("canonical_source_promotion_failed");
  } finally {
    if (parentDescriptor !== undefined && pendingMayExist && pendingStat) {
      try {
        const openedParent = fs.fstatSync(parentDescriptor, { bigint: true });
        anchoredUnlinkOwned(parentDescriptor, openedParent, pendingName, pendingStat);
      } catch (error) {
        if (!failure) {
          failure = error instanceof ProcessLocalSourceTransitionError
            ? error
            : new ProcessLocalSourceTransitionError("canonical_source_cleanup_failed");
        }
      }
    }
    if (parentDescriptor !== undefined) {
      try { fs.fsyncSync(parentDescriptor); } catch { /* Best effort. */ }
      try { fs.closeSync(parentDescriptor); } catch { /* Preserve result. */ }
    }
  }
  if (failure) throw failure;
  return result;
}

function promoteCanonicalBytes(
  canonicalValuesPath,
  oldBytes,
  newBytes,
  intent,
  hooks
) {
  return replaceCanonicalBytes(
    canonicalValuesPath,
    oldBytes,
    newBytes,
    derivePendingAttribution({
      basename: path.basename(path.resolve(canonicalValuesPath)),
      intent,
      newBytes
    }),
    hooks
  );
}

export function replacePrivateProcessLocalValuesSource({
  canonicalValuesPath,
  expectedBytes,
  replacementBytes,
  attributionKey,
  hooks
}) {
  if (!Buffer.isBuffer(expectedBytes) || !Buffer.isBuffer(replacementBytes) ||
      expectedBytes.length < 1 || expectedBytes.length > MAX_SOURCE_BYTES ||
      replacementBytes.length < 1 || replacementBytes.length > MAX_SOURCE_BYTES ||
      safeBytesEqual(expectedBytes, replacementBytes)) {
    fail("canonical_source_replacement_invalid");
  }
  if (!Buffer.isBuffer(attributionKey) || attributionKey.length < 32 ||
      attributionKey.length > MAX_SOURCE_BYTES) {
    fail("source_attribution_key_invalid");
  }
  const attribution = createHmac("sha256", attributionKey)
    .update(PRIVATE_REPLACEMENT_ATTRIBUTION_DOMAIN)
    .update(Buffer.from([0]))
    .update(expectedBytes)
    .update(Buffer.from([0]))
    .update(replacementBytes)
    .digest("hex");
  return replaceCanonicalBytes(
    canonicalValuesPath,
    expectedBytes,
    replacementBytes,
    attribution,
    hooks
  );
}

export function promoteProcessLocalValuesSource(options) {
  if (typeof options?.canonicalValuesPath !== "string" ||
      !options.canonicalValuesPath) {
    fail("canonical_source_path_required");
  }
  const bound = loadBoundTransition(options);
  try {
    return promoteCanonicalBytes(
      options.canonicalValuesPath,
      bound.oldBytes,
      bound.newBytes,
      bound.intent,
      options.hooks
    );
  } finally {
    wipeSources(bound);
  }
}

function parseCli(argv) {
  const command = argv[0];
  const allowed = command === "snapshot"
    ? new Set(["--operation-directory", "--old-values-source", "--new-values-source"])
    : command === "verify"
      ? new Set([
        "--operation-directory", "--expected-operation-id",
        "--expected-operation-binding-sha256", "--canonical-values", "--expected-state"
      ])
      : command === "promote"
        ? new Set([
          "--operation-directory", "--expected-operation-id",
          "--expected-operation-binding-sha256", "--canonical-values"
        ])
        : null;
  if (!allowed || (argv.length - 1) % 2 !== 0) fail("arguments_invalid");
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || values.has(flag) || typeof value !== "string" || !value) {
      fail("arguments_invalid");
    }
    values.set(flag, value);
  }
  if (values.size !== allowed.size) fail("arguments_invalid");
  return { command, values };
}

function cliMain(argv) {
  const { command, values } = parseCli(argv);
  if (command === "snapshot") {
    snapshotProcessLocalValuesSources({
      operationDirectory: values.get("--operation-directory"),
      oldValuesSource: values.get("--old-values-source"),
      newValuesSource: values.get("--new-values-source")
    });
    return;
  }
  const common = {
    operationDirectory: values.get("--operation-directory"),
    expectedOperationId: values.get("--expected-operation-id"),
    expectedOperationBindingSha256: values.get("--expected-operation-binding-sha256"),
    canonicalValuesPath: values.get("--canonical-values")
  };
  if (command === "verify") {
    verifyProcessLocalValuesSourceTransition({
      ...common,
      expectedState: values.get("--expected-state")
    });
  } else {
    promoteProcessLocalValuesSource(common);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    cliMain(process.argv.slice(2));
  } catch {
    process.stderr.write(GENERIC_CLI_ERROR);
    process.exitCode = 1;
  }
}

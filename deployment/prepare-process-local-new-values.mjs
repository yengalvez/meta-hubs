#!/usr/bin/env node

// Build the complete AUD-065 NEW local-values source without exposing secret
// material through argv, environment variables, stdout or stderr. The OLD
// source is read-only; the NEW source is validated completely before its
// owner-private, no-clobber publication.

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import tty from "node:tty";
import { fileURLToPath } from "node:url";

import { parseLocalValuesSource } from "./parse-local-values.mjs";
import {
  projectProcessLocalValuesMap,
  readPrivateProcessLocalValuesSource
} from "./project-process-local-values.mjs";
import {
  loadProcessLocalRotationProfile,
  validateProcessLocalValuesSnapshot
} from "./process-local-rotation.mjs";
import {
  validateProcessLocalValuesSourceTransition
} from "./process-local-source-transition.mjs";
import { publishPrivateArtifact } from "./private-artifact-publication.mjs";

const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_SECRET_FRAME_BYTES = 128 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const GENERIC_ERROR = "AUD-065 local values preparation failed closed\n";
const PREPARED_TOKEN = "aud065_new_values_prepared";
const VERIFIED_TOKEN = "aud065_new_values_verified";
const FRAME_MAGIC = Buffer.from("YENHUBS-AUD065-SECRETS-V1\0", "ascii");
const EXTERNAL_SECRET_KEYS = Object.freeze([
  "OPENAI_API_KEY",
  "SMTP_PASS",
  "GHCR_TOKEN",
  "SKETCHFAB_API_KEY",
  "TENOR_API_KEY"
]);
const OPTIONAL_EXTERNAL_KEYS = new Set([
  "SKETCHFAB_API_KEY",
  "TENOR_API_KEY"
]);
const INTERNAL_SECRET_KEYS = Object.freeze([
  "BOT_ACCESS_KEY",
  "DB_PASS",
  "GUARDIAN_KEY",
  "NODE_COOKIE",
  "PHX_KEY",
  "BOT_RUNNER_ACCESS_KEY",
  "BOT_ORCHESTRATOR_ACCESS_KEY",
  "DASHBOARD_ACCESS_KEY"
]);
const AUTHORIZED_SOURCE_KEYS = new Set([
  ...INTERNAL_SECRET_KEYS,
  "OPENAI_API_KEY",
  "SMTP_PASS",
  "SKETCHFAB_API_KEY",
  "TENOR_API_KEY",
  "PERMS_KEY",
  "PGRST_DB_URI",
  "PGRST_JWT_SECRET",
  "PSQL",
  "BOT_IMAGE_PULL_CONFIG_JSON_BASE64"
]);

export class ProcessLocalNewValuesPreparationError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProcessLocalNewValuesPreparationError";
    this.code = code;
  }
}

function fail(code) {
  throw new ProcessLocalNewValuesPreparationError(code);
}

function currentUidMatches(stat) {
  return typeof process.getuid !== "function" || stat.uid === BigInt(process.getuid());
}

function checkedAbsolutePath(value, code) {
  if (typeof value !== "string" || !value || !path.isAbsolute(value) ||
      /[\u0000\r\n]/u.test(value)) {
    fail(code);
  }
  return path.resolve(value);
}

function assertNewDestinationContract(oldValuesSource, newValuesSource, mustBeAbsent) {
  const oldPath = checkedAbsolutePath(oldValuesSource, "old_source_path_invalid");
  const newPath = checkedAbsolutePath(newValuesSource, "new_source_path_invalid");
  if (oldPath === newPath) fail("source_paths_not_distinct");
  let parent;
  try {
    parent = fs.lstatSync(path.dirname(newPath), { bigint: true });
  } catch {
    fail("new_source_parent_invalid");
  }
  if (!parent.isDirectory() || parent.isSymbolicLink() ||
      !currentUidMatches(parent) ||
      Number(parent.mode & 0o7777n) !== PRIVATE_DIRECTORY_MODE) {
    fail("new_source_parent_invalid");
  }
  if (mustBeAbsent) {
    try {
      fs.lstatSync(newPath, { bigint: true });
      fail("new_source_exists");
    } catch (error) {
      if (error instanceof ProcessLocalNewValuesPreparationError) throw error;
      if (error?.code !== "ENOENT") fail("new_source_path_invalid");
    }
  }
  return { oldPath, newPath };
}

function safeStringEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  try {
    return leftBytes.length === rightBytes.length &&
      timingSafeEqual(leftBytes, rightBytes);
  } finally {
    leftBytes.fill(0);
    rightBytes.fill(0);
  }
}

function safeBufferEqual(left, right) {
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) &&
    left.length === right.length && timingSafeEqual(left, right);
}

function canonicalUtf8(bytes, code) {
  let roundTrip;
  try {
    const value = bytes.toString("utf8");
    roundTrip = Buffer.from(value, "utf8");
    if (!roundTrip.equals(bytes)) fail(code);
    return value;
  } finally {
    if (roundTrip) roundTrip.fill(0);
  }
}

function parseValues(bytes, code) {
  try {
    const text = canonicalUtf8(bytes, code);
    return parseLocalValuesSource(text);
  } catch (error) {
    if (error instanceof ProcessLocalNewValuesPreparationError) throw error;
    fail(code);
  }
}

function wipeMap(values) {
  if (!(values instanceof Map)) return;
  for (const name of values.keys()) values.set(name, "");
  values.clear();
}

function wipeRecord(values) {
  if (!values || typeof values !== "object") return;
  for (const name of Object.keys(values)) values[name] = "";
}

function runHook(hooks, name) {
  if (hooks?.[name] === undefined) return;
  if (typeof hooks[name] !== "function") fail("preparation_hook_invalid");
  hooks[name]();
}

function checkedSecretInputFd(value) {
  const descriptor = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(descriptor) || descriptor < 3 || descriptor > 0x7fffffff) {
    fail("secret_input_fd_invalid");
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (tty.isatty(descriptor) || (!stat.isFIFO() && !stat.isSocket())) {
      fail("secret_input_fd_type_invalid");
    }
  } catch (error) {
    if (error instanceof ProcessLocalNewValuesPreparationError) throw error;
    fail("secret_input_fd_invalid");
  }
  return descriptor;
}

function readSecretInputFrame(descriptor) {
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const chunk = Buffer.alloc(Math.min(16 * 1024, MAX_SECRET_FRAME_BYTES + 1 - total));
      let count;
      try {
        count = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      } catch {
        chunk.fill(0);
        fail("secret_input_read_failed");
      }
      if (count === 0) {
        chunk.fill(0);
        break;
      }
      total += count;
      chunks.push(chunk.subarray(0, count));
      if (total > MAX_SECRET_FRAME_BYTES) fail("secret_input_too_large");
    }
    if (total === 0) fail("secret_input_empty");
    return Buffer.concat(chunks, total);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

function readFrameBytes(frame, cursor, length, code) {
  if (!Number.isSafeInteger(length) || length < 0 ||
      cursor.offset + length > frame.length) {
    fail(code);
  }
  const bytes = frame.subarray(cursor.offset, cursor.offset + length);
  cursor.offset += length;
  return bytes;
}

export function parseProcessLocalSecretInputFrame(frame, oldValues) {
  if (!Buffer.isBuffer(frame) || frame.length < FRAME_MAGIC.length + 1 ||
      frame.length > MAX_SECRET_FRAME_BYTES || !(oldValues instanceof Map)) {
    fail("secret_frame_invalid");
  }
  const cursor = { offset: 0 };
  const secrets = new Map();
  try {
    const magic = readFrameBytes(frame, cursor, FRAME_MAGIC.length, "secret_frame_truncated");
    if (!timingSafeEqual(magic, FRAME_MAGIC)) fail("secret_frame_magic_invalid");
    const count = readFrameBytes(frame, cursor, 1, "secret_frame_truncated")[0];
    if (count !== EXTERNAL_SECRET_KEYS.length) fail("secret_frame_count_invalid");
    for (const expectedName of EXTERNAL_SECRET_KEYS) {
      const keyLength = readFrameBytes(frame, cursor, 1, "secret_frame_truncated")[0];
      const keyBytes = readFrameBytes(frame, cursor, keyLength, "secret_frame_truncated");
      const expectedBytes = Buffer.from(expectedName, "ascii");
      try {
        if (keyLength !== expectedBytes.length ||
            !timingSafeEqual(keyBytes, expectedBytes)) {
          fail("secret_frame_key_invalid");
        }
      } finally {
        expectedBytes.fill(0);
      }
      const lengthBytes = readFrameBytes(frame, cursor, 4, "secret_frame_truncated");
      const valueLength = lengthBytes.readUInt32BE(0);
      const valueBytes = readFrameBytes(frame, cursor, valueLength, "secret_frame_truncated");
      const value = canonicalUtf8(valueBytes, "secret_frame_value_invalid");
      if (/[\u0000-\u001f\u007f]/u.test(value) || value !== value.trim()) {
        fail("secret_frame_value_invalid");
      }
      const oldKey = expectedName === "GHCR_TOKEN" ? undefined : expectedName;
      if (OPTIONAL_EXTERNAL_KEYS.has(expectedName)) {
        const wasConfigured = Boolean(oldValues.get(oldKey));
        if (Boolean(value) !== wasConfigured) {
          fail("optional_secret_presence_changed");
        }
      } else if (!value) {
        fail("required_external_secret_empty");
      }
      secrets.set(expectedName, value);
    }
    if (cursor.offset !== frame.length) fail("secret_frame_trailing_bytes");
    return secrets;
  } catch (error) {
    wipeMap(secrets);
    throw error;
  }
}

export function encodeProcessLocalSecretInputFrame(secrets) {
  const isMap = secrets instanceof Map;
  const names = isMap ? [...secrets.keys()] :
    secrets && typeof secrets === "object" && !Array.isArray(secrets)
      ? Object.keys(secrets)
      : [];
  if (names.length !== EXTERNAL_SECRET_KEYS.length ||
      EXTERNAL_SECRET_KEYS.some(name => !names.includes(name)) ||
      names.some(name => !EXTERNAL_SECRET_KEYS.includes(name))) {
    fail("secret_frame_values_invalid");
  }
  const chunks = [Buffer.from(FRAME_MAGIC), Buffer.from([EXTERNAL_SECRET_KEYS.length])];
  let total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  try {
    for (const name of EXTERNAL_SECRET_KEYS) {
      const value = isMap ? secrets.get(name) : secrets[name];
      if (typeof value !== "string" ||
          (!OPTIONAL_EXTERNAL_KEYS.has(name) && !value) ||
          /[\u0000-\u001f\u007f]/u.test(value) || value !== value.trim()) {
        fail("secret_frame_value_invalid");
      }
      const keyBytes = Buffer.from(name, "ascii");
      const valueBytes = Buffer.from(value, "utf8");
      const lengthBytes = Buffer.alloc(4);
      lengthBytes.writeUInt32BE(valueBytes.length);
      const fields = [Buffer.from([keyBytes.length]), keyBytes, lengthBytes, valueBytes];
      chunks.push(...fields);
      total += fields.reduce((sum, field) => sum + field.length, 0);
      if (total > MAX_SECRET_FRAME_BYTES) fail("secret_input_too_large");
    }
    return Buffer.concat(chunks, total);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

function generatedInternalSecrets(oldValues) {
  const generated = new Map();
  const distinct = new Set();
  for (const name of INTERNAL_SECRET_KEYS) {
    let value;
    do {
      let entropy;
      try {
        entropy = randomBytes(48);
        value = entropy.toString("base64url");
      } finally {
        if (entropy) entropy.fill(0);
      }
    } while (distinct.has(value) || safeStringEqual(value, oldValues.get(name)));
    distinct.add(value);
    generated.set(name, value);
  }
  return generated;
}

function generatePermsMaterial() {
  let privatePem;
  try {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    privatePem = Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" }));
    const privateKey = createPrivateKey(privatePem);
    const publicKey = createPublicKey(privateKey);
    const jwk = publicKey.export({ format: "jwk" });
    if (privateKey.asymmetricKeyType !== "rsa" ||
        Number(privateKey.asymmetricKeyDetails?.modulusLength || 0) < 2048 ||
        jwk?.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string") {
      fail("generated_perms_key_invalid");
    }
    return {
      privateKey: privatePem.toString("utf8").replace(/\r?\n/gu, "\\n"),
      jwtSecret: JSON.stringify({ kty: jwk.kty, n: jwk.n, e: jwk.e })
    };
  } catch (error) {
    if (error instanceof ProcessLocalNewValuesPreparationError) throw error;
    fail("perms_key_generation_failed");
  } finally {
    if (privatePem) privatePem.fill(0);
  }
}

function parseOldPullCredential(encoded) {
  let decoded;
  let basicBytes;
  try {
    if (typeof encoded !== "string" || !encoded) fail("old_pull_config_invalid");
    decoded = Buffer.from(encoded, "base64");
    if (decoded.toString("base64") !== encoded) fail("old_pull_config_invalid");
    const text = canonicalUtf8(decoded, "old_pull_config_invalid");
    const parsed = JSON.parse(text);
    const registryNames = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.keys(parsed.auths || {})
      : [];
    if (Object.keys(parsed || {}).join("\0") !== "auths" ||
        registryNames.length !== 1 || registryNames[0] !== "ghcr.io" ||
        Object.keys(parsed.auths[registryNames[0]] || {}).join("\0") !== "auth") {
      fail("old_pull_config_invalid");
    }
    const basic = parsed.auths[registryNames[0]].auth;
    if (typeof basic !== "string" || !basic) fail("old_pull_config_invalid");
    basicBytes = Buffer.from(basic, "base64");
    if (basicBytes.toString("base64") !== basic) fail("old_pull_config_invalid");
    const decodedBasic = canonicalUtf8(basicBytes, "old_pull_config_invalid");
    const separator = decodedBasic.indexOf(":");
    const username = decodedBasic.slice(0, separator);
    const token = decodedBasic.slice(separator + 1);
    if (separator <= 0 || !username || username !== username.trim() ||
        username.includes(":") || !token || token !== token.trim() ||
        /[\u0000-\u001f\u007f]/u.test(decodedBasic)) {
      fail("old_pull_config_invalid");
    }
    return { registry: registryNames[0], username, token };
  } catch (error) {
    if (error instanceof ProcessLocalNewValuesPreparationError) throw error;
    fail("old_pull_config_invalid");
  } finally {
    if (decoded) decoded.fill(0);
    if (basicBytes) basicBytes.fill(0);
  }
}

function buildPullConfig({ registry, username }, token) {
  let basicBytes;
  let dockerConfig;
  try {
    basicBytes = Buffer.from(`${username}:${token}`, "utf8");
    const auth = basicBytes.toString("base64");
    dockerConfig = Buffer.from(JSON.stringify({
      auths: { [registry]: { auth } }
    }), "utf8");
    return dockerConfig.toString("base64");
  } finally {
    if (basicBytes) basicBytes.fill(0);
    if (dockerConfig) dockerConfig.fill(0);
  }
}

function databaseUri(values, password, contract) {
  const host = Object.hasOwn(contract, "host_value_key")
    ? values.get(contract.host_value_key)
    : contract.host_literal;
  if (typeof host !== "string" || !host || typeof contract.port !== "string") {
    fail("database_contract_invalid");
  }
  return `postgres://${encodeURIComponent(values.get("DB_USER"))}:` +
    `${encodeURIComponent(password)}@${host}:${contract.port}/` +
    encodeURIComponent(values.get("DB_NAME"));
}

function splitSourceLines(source) {
  const lines = [];
  let offset = 0;
  while (offset < source.length) {
    const newline = source.indexOf("\n", offset);
    const end = newline === -1 ? source.length : newline + 1;
    const raw = source.slice(offset, end);
    const ending = raw.endsWith("\r\n") ? "\r\n" : raw.endsWith("\n") ? "\n" : "";
    lines.push({
      raw,
      ending,
      body: ending ? raw.slice(0, -ending.length) : raw
    });
    offset = end;
  }
  return lines;
}

function quotedScalarEnd(value, quote) {
  for (let index = 1; index < value.length; index += 1) {
    if (quote === "\"" && value[index] === "\\") {
      index += 1;
      continue;
    }
    if (quote === "'" && value[index] === "'" && value[index + 1] === "'") {
      index += 1;
      continue;
    }
    if (value[index] === quote) return index + 1;
  }
  fail("authorized_source_layout_invalid");
}

function authorizedLineParts(body) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*):([ \t]*)(.*)$/u.exec(body);
  if (!match || !AUTHORIZED_SOURCE_KEYS.has(match[1])) return undefined;
  const [, name, spacing, remainder] = match;
  let scalarEnd;
  let suffix;
  if (remainder.startsWith("#")) {
    suffix = `${spacing}${remainder}`;
  } else if (remainder.startsWith("\"") || remainder.startsWith("'")) {
    scalarEnd = quotedScalarEnd(remainder, remainder[0]);
    suffix = remainder.slice(scalarEnd);
  } else {
    const comment = remainder.search(/[ \t]#/u);
    scalarEnd = comment === -1 ? remainder.length : comment;
    while (scalarEnd > 0 && /[ \t]/u.test(remainder[scalarEnd - 1])) scalarEnd -= 1;
    suffix = remainder.slice(scalarEnd);
    if (!remainder && spacing) suffix = spacing;
  }
  return {
    name,
    suffix
  };
}

function replaceAuthorizedLines(oldBytes, replacements) {
  const source = oldBytes.toString("utf8");
  const found = new Set();
  const output = splitSourceLines(source).map(line => {
    const parts = authorizedLineParts(line.body);
    if (parts && replacements.has(parts.name)) {
      if (found.has(parts.name)) fail("authorized_source_key_duplicate");
      found.add(parts.name);
      return `${parts.name}: ${JSON.stringify(replacements.get(parts.name))}` +
        `${parts.suffix}${line.ending}`;
    } else {
      return line.raw;
    }
  });
  if (found.size !== replacements.size ||
      [...replacements.keys()].some(name => !found.has(name))) {
    fail("authorized_source_key_missing");
  }
  return Buffer.from(output.join(""), "utf8");
}

function assertStructuralSourceTransition(oldBytes, newBytes, oldValues, newValues) {
  if (oldValues.has("PGRST_JWT_SECRET") !== newValues.has("PGRST_JWT_SECRET")) {
    fail("derived_source_key_presence_changed");
  }
  const authorizedValues = new Map();
  let expected;
  try {
    for (const name of AUTHORIZED_SOURCE_KEYS) {
      if (oldValues.has(name)) {
        if (!newValues.has(name)) fail("authorized_source_key_missing");
        authorizedValues.set(name, newValues.get(name));
      }
    }
    expected = replaceAuthorizedLines(oldBytes, authorizedValues);
    if (!safeBufferEqual(expected, newBytes)) fail("source_line_structure_changed");
    return true;
  } finally {
    wipeMap(authorizedValues);
    if (expected) expected.fill(0);
  }
}

function validateSourcesAndSnapshots(oldBytes, newBytes) {
  let oldValues;
  let newValues;
  let oldSnapshot;
  let newSnapshot;
  try {
    oldValues = parseValues(oldBytes, "old_source_invalid");
    newValues = parseValues(newBytes, "new_source_invalid");
    assertStructuralSourceTransition(oldBytes, newBytes, oldValues, newValues);
    validateProcessLocalValuesSourceTransition({ oldBytes, newBytes });
    oldSnapshot = projectProcessLocalValuesMap(oldValues);
    newSnapshot = projectProcessLocalValuesMap(newValues);
    validateProcessLocalValuesSnapshot(oldSnapshot, { codePrefix: "old_source" });
    validateProcessLocalValuesSnapshot(newSnapshot, { codePrefix: "new_source" });
    return true;
  } finally {
    wipeMap(oldValues);
    wipeMap(newValues);
    wipeRecord(oldSnapshot);
    wipeRecord(newSnapshot);
  }
}

export function prepareProcessLocalNewValues({
  oldValuesSource,
  newValuesSource,
  secretInputFd,
  hooks
}) {
  const paths = assertNewDestinationContract(oldValuesSource, newValuesSource, true);
  const descriptor = checkedSecretInputFd(secretInputFd);
  let descriptorOpen = true;
  let oldBytes;
  let newBytes;
  let frame;
  let oldValues;
  let externalSecrets;
  let internalSecrets;
  let replacements;
  let perms;
  let oldPull;
  let oldBytesBeforePublication;
  let publishedBytes;
  let oldBytesAfterNewRead;
  try {
    oldBytes = readPrivateProcessLocalValuesSource(paths.oldPath);
    oldValues = parseValues(oldBytes, "old_source_invalid");
    const oldSnapshot = projectProcessLocalValuesMap(oldValues);
    try {
      validateProcessLocalValuesSnapshot(oldSnapshot, { codePrefix: "old_source" });
    } finally {
      wipeRecord(oldSnapshot);
    }
    try {
      frame = readSecretInputFrame(descriptor);
    } finally {
      try {
        fs.closeSync(descriptor);
        descriptorOpen = false;
      } catch {
        fail("secret_input_close_failed");
      }
    }
    externalSecrets = parseProcessLocalSecretInputFrame(frame, oldValues);
    internalSecrets = generatedInternalSecrets(oldValues);
    perms = generatePermsMaterial();
    oldPull = parseOldPullCredential(
      oldValues.get("BOT_IMAGE_PULL_CONFIG_JSON_BASE64")
    );
    if (safeStringEqual(oldPull.token, externalSecrets.get("GHCR_TOKEN"))) {
      fail("pull_config_credential_not_rotated");
    }
    const profile = loadProcessLocalRotationProfile();
    replacements = new Map(internalSecrets);
    replacements.set("OPENAI_API_KEY", externalSecrets.get("OPENAI_API_KEY"));
    replacements.set("SMTP_PASS", externalSecrets.get("SMTP_PASS"));
    replacements.set("SKETCHFAB_API_KEY", externalSecrets.get("SKETCHFAB_API_KEY"));
    replacements.set("TENOR_API_KEY", externalSecrets.get("TENOR_API_KEY"));
    replacements.set("PERMS_KEY", perms.privateKey);
    if (oldValues.has("PGRST_JWT_SECRET")) {
      replacements.set("PGRST_JWT_SECRET", perms.jwtSecret);
    }
    replacements.set(
      "PGRST_DB_URI",
      databaseUri(
        oldValues,
        internalSecrets.get("DB_PASS"),
        profile.database_uri_contracts.PGRST_DB_URI
      )
    );
    replacements.set(
      "PSQL",
      databaseUri(
        oldValues,
        internalSecrets.get("DB_PASS"),
        profile.database_uri_contracts.PSQL
      )
    );
    replacements.set(
      "BOT_IMAGE_PULL_CONFIG_JSON_BASE64",
      buildPullConfig(oldPull, externalSecrets.get("GHCR_TOKEN"))
    );
    newBytes = replaceAuthorizedLines(oldBytes, replacements);
    validateSourcesAndSnapshots(oldBytes, newBytes);
    runHook(hooks, "beforeOldRecheck");
    oldBytesBeforePublication = readPrivateProcessLocalValuesSource(paths.oldPath);
    if (!safeBufferEqual(oldBytes, oldBytesBeforePublication)) {
      fail("old_source_changed");
    }
    const published = publishPrivateArtifact({
      outputPath: paths.newPath,
      bytes: newBytes,
      maximumBytes: MAX_SOURCE_BYTES
    });
    if (published !== true) fail("new_source_not_created");
    publishedBytes = readPrivateProcessLocalValuesSource(paths.newPath);
    if (!safeBufferEqual(newBytes, publishedBytes)) {
      fail("new_source_publication_mismatch");
    }
    runHook(hooks, "afterNewRead");
    oldBytesAfterNewRead = readPrivateProcessLocalValuesSource(paths.oldPath);
    if (!safeBufferEqual(oldBytes, oldBytesAfterNewRead)) {
      fail("old_source_changed");
    }
    return PREPARED_TOKEN;
  } finally {
    if (descriptorOpen) {
      try { fs.closeSync(descriptor); } catch { /* Preserve the primary result. */ }
    }
    if (oldBytes) oldBytes.fill(0);
    if (newBytes) newBytes.fill(0);
    if (frame) frame.fill(0);
    if (oldBytesBeforePublication) oldBytesBeforePublication.fill(0);
    if (publishedBytes) publishedBytes.fill(0);
    if (oldBytesAfterNewRead) oldBytesAfterNewRead.fill(0);
    wipeMap(oldValues);
    wipeMap(externalSecrets);
    wipeMap(internalSecrets);
    wipeMap(replacements);
    wipeRecord(perms);
    wipeRecord(oldPull);
  }
}

export function verifyProcessLocalNewValues({ oldValuesSource, newValuesSource, hooks }) {
  const paths = assertNewDestinationContract(oldValuesSource, newValuesSource, false);
  let oldBytes;
  let newBytes;
  let oldBytesAfterNewRead;
  try {
    oldBytes = readPrivateProcessLocalValuesSource(paths.oldPath);
    newBytes = readPrivateProcessLocalValuesSource(paths.newPath);
    validateSourcesAndSnapshots(oldBytes, newBytes);
    runHook(hooks, "afterNewRead");
    oldBytesAfterNewRead = readPrivateProcessLocalValuesSource(paths.oldPath);
    if (!safeBufferEqual(oldBytes, oldBytesAfterNewRead)) {
      fail("old_source_changed");
    }
    return VERIFIED_TOKEN;
  } finally {
    if (oldBytes) oldBytes.fill(0);
    if (newBytes) newBytes.fill(0);
    if (oldBytesAfterNewRead) oldBytesAfterNewRead.fill(0);
  }
}

function parseCliArguments(argv) {
  const command = argv[0];
  if (command === "prepare" && argv.length === 7 &&
      argv[1] === "--old-values-source" && argv[3] === "--new-values-source" &&
      argv[5] === "--secret-input-fd") {
    return {
      command,
      oldValuesSource: argv[2],
      newValuesSource: argv[4],
      secretInputFd: argv[6]
    };
  }
  if (command === "verify" && argv.length === 5 &&
      argv[1] === "--old-values-source" && argv[3] === "--new-values-source") {
    return { command, oldValuesSource: argv[2], newValuesSource: argv[4] };
  }
  fail("arguments_invalid");
}

function main() {
  try {
    const options = parseCliArguments(process.argv.slice(2));
    const token = options.command === "prepare"
      ? prepareProcessLocalNewValues(options)
      : verifyProcessLocalNewValues(options);
    process.stdout.write(`${token}\n`);
  } catch {
    process.stderr.write(GENERIC_ERROR);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

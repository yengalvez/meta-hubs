#!/usr/bin/env node

// Verifies the private kubelet pull credential without printing or placing it
// on a command line. Optional live Secret snapshots from both the parent and
// dedicated runner namespaces are matched byte for byte to the private value.

import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VALUES_PARSER = fileURLToPath(new URL("./parse-local-values.mjs", import.meta.url));
const PRIVATE_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;
const PRIVATE_FILE_MODE = 0o600;
const DEFAULT_REGISTRY_TIMEOUT_MS = 15_000;
const MAX_REGISTRY_TIMEOUT_MS = 15_000;

// This is deliberately an exact, code-owned allowlist rather than data supplied
// by the private snapshot. Keep its parity test aligned with the accepted
// process-local profile. Docker Hub alternatives are valid pinned deployment
// inputs, but only ghcr.io/yengalvez references need this credential gate.
export const PROCESS_LOCAL_IMAGE_PULL_CONTRACTS = Object.freeze([
  Object.freeze({
    valueKey: "OVERRIDE_BOT_ORCHESTRATOR_IMAGE",
    repositories: Object.freeze(["ghcr.io/yengalvez/bot-orchestrator"])
  }),
  Object.freeze({
    valueKey: "OVERRIDE_BOT_RUNNER_IMAGE",
    repositories: Object.freeze(["ghcr.io/yengalvez/bot-runner"])
  }),
  Object.freeze({
    valueKey: "OVERRIDE_COTURN_IMAGE",
    repositories: Object.freeze(["ghcr.io/yengalvez/coturn"])
  }),
  Object.freeze({
    valueKey: "OVERRIDE_DIALOG_IMAGE",
    repositories: Object.freeze(["ghcr.io/yengalvez/dialog"])
  }),
  Object.freeze({
    valueKey: "OVERRIDE_HAPROXY_IMAGE",
    repositories: Object.freeze([
      "ghcr.io/yengalvez/haproxy",
      "docker.io/haproxytech/kubernetes-ingress",
      "haproxytech/kubernetes-ingress"
    ])
  }),
  Object.freeze({
    valueKey: "OVERRIDE_HUBS_IMAGE",
    repositories: Object.freeze(["ghcr.io/yengalvez/hubs"])
  }),
  Object.freeze({
    valueKey: "OVERRIDE_NEARSPARK_IMAGE",
    repositories: Object.freeze([
      "ghcr.io/yengalvez/nearspark",
      "docker.io/mozillareality/nearspark",
      "mozillareality/nearspark"
    ])
  }),
  Object.freeze({
    valueKey: "OVERRIDE_PGBOUNCER_IMAGE",
    repositories: Object.freeze([
      "ghcr.io/yengalvez/pgbouncer",
      "docker.io/edoburu/pgbouncer",
      "edoburu/pgbouncer"
    ])
  }),
  Object.freeze({
    valueKey: "OVERRIDE_PHOTOMNEMONIC_IMAGE",
    repositories: Object.freeze(["ghcr.io/yengalvez/photomnemonic"])
  }),
  Object.freeze({
    valueKey: "OVERRIDE_POSTGREST_IMAGE",
    repositories: Object.freeze([
      "ghcr.io/yengalvez/postgrest",
      "docker.io/postgrest/postgrest",
      "postgrest/postgrest"
    ])
  }),
  Object.freeze({
    valueKey: "OVERRIDE_POSTGRES_IMAGE",
    repositories: Object.freeze([
      "ghcr.io/yengalvez/postgres",
      "docker.io/library/postgres",
      "postgres"
    ])
  }),
  Object.freeze({
    valueKey: "OVERRIDE_RETICULUM_IMAGE",
    repositories: Object.freeze(["ghcr.io/yengalvez/reticulum"])
  }),
  Object.freeze({
    valueKey: "OVERRIDE_SPOKE_IMAGE",
    repositories: Object.freeze(["ghcr.io/yengalvez/spoke"])
  })
]);

const PROCESS_LOCAL_SNAPSHOT_REQUIRED_KEYS = Object.freeze([
  "ADM_EMAIL",
  "BOT_ACCESS_KEY",
  "BOT_IMAGE_PULL_CONFIG_JSON_BASE64",
  "DB_HOST",
  "DB_HOST_T",
  "DB_NAME",
  "DB_PASS",
  "DB_USER",
  "GUARDIAN_KEY",
  "HUB_DOMAIN",
  "NODE_COOKIE",
  "Namespace",
  "OPENAI_API_KEY",
  ...PROCESS_LOCAL_IMAGE_PULL_CONTRACTS.map(contract => contract.valueKey),
  "PERMS_KEY",
  "PGRST_DB_URI",
  "PHX_KEY",
  "PSQL",
  "SKETCHFAB_API_KEY",
  "SMTP_PASS",
  "SMTP_PORT",
  "SMTP_SERVER",
  "SMTP_USER",
  "TENOR_API_KEY"
]);
const PROCESS_LOCAL_SNAPSHOT_OPTIONAL_KEYS = Object.freeze(["PGRST_JWT_SECRET"]);
const PROCESS_LOCAL_SNAPSHOT_ALLOWED_KEYS = new Set([
  ...PROCESS_LOCAL_SNAPSHOT_REQUIRED_KEYS,
  ...PROCESS_LOCAL_SNAPSHOT_OPTIONAL_KEYS
]);
const PINNED_IMAGE = /^(.+)@(sha256:[a-f0-9]{64})$/u;
const GHCR_YENHUBS_IMAGE = /^ghcr\.io\/yengalvez\/([a-z0-9]+(?:[-a-z0-9]*[a-z0-9])?)@(sha256:[a-f0-9]{64})$/u;

class PullConfigError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function reject(code) {
  throw new PullConfigError(code);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!object(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonicalize(value[key])])
  );
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function currentUidMatches(stat) {
  return typeof process.getuid !== "function" || stat.uid === BigInt(process.getuid());
}

function privatePathComponents(targetPath) {
  const absolute = path.resolve(targetPath);
  const parsed = path.parse(absolute);
  const names = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  return names.map((name, index) => {
    current = path.join(current, name);
    let stat;
    try {
      stat = fs.lstatSync(current, { bigint: true });
    } catch {
      reject("private_snapshot_invalid");
    }
    if (stat.isSymbolicLink() || (index < names.length - 1 && !stat.isDirectory())) {
      reject("private_snapshot_invalid");
    }
    return {
      path: current,
      dev: stat.dev,
      ino: stat.ino,
      uid: stat.uid,
      mode: stat.mode,
      nlink: stat.nlink,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
      file: stat.isFile(),
      directory: stat.isDirectory()
    };
  });
}

function samePrivatePathComponents(before, after) {
  return before.length === after.length && before.every((entry, index) => {
    const current = after[index];
    const leaf = index === before.length - 1;
    return entry.path === current.path && entry.dev === current.dev &&
      entry.ino === current.ino && entry.uid === current.uid &&
      entry.mode === current.mode && entry.file === current.file &&
      entry.directory === current.directory &&
      (!leaf || (entry.nlink === current.nlink && entry.size === current.size &&
        entry.mtimeNs === current.mtimeNs && entry.ctimeNs === current.ctimeNs));
  });
}

function samePrivateFileStat(left, right) {
  const leftIsFile = typeof left.isFile === "function" ? left.isFile() : left.file;
  const rightIsFile = typeof right.isFile === "function" ? right.isFile() : right.file;
  return left.dev === right.dev && left.ino === right.ino &&
    left.uid === right.uid && left.mode === right.mode &&
    left.nlink === right.nlink && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs &&
    leftIsFile === rightIsFile;
}

function readExactPrivateBytes(descriptor, size) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = fs.readSync(descriptor, bytes, offset, size - offset, offset);
    if (count === 0) reject("private_snapshot_changed");
    offset += count;
  }
  const extra = Buffer.alloc(1);
  if (fs.readSync(descriptor, extra, 0, 1, size) !== 0) {
    reject("private_snapshot_changed");
  }
  return bytes;
}

function parseCanonicalProcessLocalSnapshot(bytes) {
  let text;
  let snapshot;
  try {
    text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) reject("private_snapshot_invalid");
    snapshot = JSON.parse(text);
  } catch (error) {
    if (error instanceof PullConfigError) throw error;
    reject("private_snapshot_invalid");
  }
  if (!object(snapshot) || text !== `${canonicalJson(snapshot)}\n`) {
    reject("private_snapshot_noncanonical");
  }
  const keys = Object.keys(snapshot);
  if (keys.length < PROCESS_LOCAL_SNAPSHOT_REQUIRED_KEYS.length ||
      keys.length > PROCESS_LOCAL_SNAPSHOT_ALLOWED_KEYS.size ||
      PROCESS_LOCAL_SNAPSHOT_REQUIRED_KEYS.some(key => !Object.hasOwn(snapshot, key)) ||
      keys.some(key => !PROCESS_LOCAL_SNAPSHOT_ALLOWED_KEYS.has(key)) ||
      keys.some(key => typeof snapshot[key] !== "string")) {
    reject("private_snapshot_keyset");
  }
  return snapshot;
}

// Acquire exactly one private snapshot file descriptor, read it twice through
// that descriptor to prove stability, and only then parse its canonical JSON.
// Neither bytes nor reusable fingerprints leave this function.
function readPrivateProcessLocalSnapshot(snapshotPath) {
  if (typeof snapshotPath !== "string" || !path.isAbsolute(snapshotPath) ||
      typeof fs.constants.O_NOFOLLOW !== "number") {
    reject("private_snapshot_invalid");
  }
  const absolute = path.resolve(snapshotPath);
  let descriptor;
  let first;
  let second;
  try {
    const beforeComponents = privatePathComponents(absolute);
    const before = beforeComponents.at(-1);
    if (!before?.file || before.nlink !== 1n ||
        Number(before.mode & 0o7777n) !== PRIVATE_FILE_MODE ||
        !currentUidMatches(before) || before.size < 1n ||
        before.size > BigInt(PRIVATE_SNAPSHOT_MAX_BYTES)) {
      reject("private_snapshot_invalid");
    }
    descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!samePrivateFileStat(before, opened)) reject("private_snapshot_invalid");
    first = readExactPrivateBytes(descriptor, Number(opened.size));
    const middle = fs.fstatSync(descriptor, { bigint: true });
    second = readExactPrivateBytes(descriptor, Number(opened.size));
    const after = fs.fstatSync(descriptor, { bigint: true });
    const afterComponents = privatePathComponents(absolute);
    if (!samePrivateFileStat(opened, middle) || !samePrivateFileStat(opened, after) ||
        !samePrivatePathComponents(beforeComponents, afterComponents) ||
        first.length !== second.length || !crypto.timingSafeEqual(first, second)) {
      reject("private_snapshot_changed");
    }
    return parseCanonicalProcessLocalSnapshot(first);
  } catch (error) {
    if (error instanceof PullConfigError) throw error;
    reject("private_snapshot_invalid");
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* Preserve the value-free primary error. */ }
    }
    first?.fill(0);
    second?.fill(0);
  }
}

function readValue(valuesPath, key) {
  try {
    return execFileSync(process.execPath, [VALUES_PARSER, valuesPath, "--get", key], {
      encoding: "utf8",
      maxBuffer: 512 * 1024,
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    reject("values_unreadable");
  }
}

function readJson(path, code) {
  try {
    const stat = fs.statSync(path);
    if (!stat.isFile() || stat.size < 2 || stat.size > 8 * 1024 * 1024) reject(code);
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof PullConfigError) throw error;
    reject(code);
  }
}

function verifyLiveSecret(secret, namespace) {
  if (
    typeof namespace !== "string" || !namespace ||
    !object(secret) || secret.apiVersion !== "v1" || secret.kind !== "Secret" ||
    secret.metadata?.name !== "bot-images-pull" || secret.metadata?.namespace !== namespace ||
    secret.metadata?.deletionTimestamp != null ||
    secret.type !== "kubernetes.io/dockerconfigjson" ||
    !object(secret.data) || Object.keys(secret.data).length !== 1
  ) reject("live_secret_contract");
}

export function verifyBotPullConfig({
  encoded,
  botImage,
  runnerImage,
  secret = null,
  namespace = null,
  runnerSecret = null,
  runnerNamespace = null
}) {
  if (!/^ghcr\.io\/yengalvez\/bot-orchestrator@sha256:[a-fA-F0-9]{64}$/.test(botImage) ||
      !/^ghcr\.io\/yengalvez\/bot-runner@sha256:[a-fA-F0-9]{64}$/.test(runnerImage)) {
    reject("image_contract");
  }
  try {
    canonicalGhcrCredential(encoded);
  } catch {
    reject("credential_contract");
  }
  const liveInputs = [secret, namespace, runnerSecret, runnerNamespace];
  if (liveInputs.some(value => value !== null)) {
    if (liveInputs.some(value => value === null) ||
        runnerNamespace !== "hcce-bot-runners" || runnerNamespace === namespace) {
      reject("live_secret_contract");
    }
    verifyLiveSecret(secret, namespace);
    verifyLiveSecret(runnerSecret, runnerNamespace);
    if (secret.data[".dockerconfigjson"] !== encoded ||
        runnerSecret.data[".dockerconfigjson"] !== encoded) {
      reject("live_secret_contract");
    }
  }
  return true;
}

// Validate a credential transition without returning either credential or a
// reusable digest. Re-encoding or reformatting the same Docker config must not
// count as a rotation: the GHCR token itself has to change.
export function verifyBotPullConfigRotation({
  oldEncoded,
  newEncoded,
  botImage,
  runnerImage
}) {
  verifyBotPullConfig({ encoded: oldEncoded, botImage, runnerImage });
  verifyBotPullConfig({ encoded: newEncoded, botImage, runnerImage });
  const oldCredential = canonicalGhcrCredential(oldEncoded);
  const newCredential = canonicalGhcrCredential(newEncoded);
  const oldToken = Buffer.from(oldCredential.token, "utf8");
  const newToken = Buffer.from(newCredential.token, "utf8");
  try {
    if (oldToken.length === newToken.length &&
        crypto.timingSafeEqual(oldToken, newToken)) {
      reject("credential_not_rotated");
    }
  } finally {
    oldToken.fill(0);
    newToken.fill(0);
  }
  return true;
}

// Compare only the authenticated GHCR principal and token. The surrounding
// Docker config JSON/base64 representation is intentionally ignored so a
// historical live Secret can be matched to its private source semantically
// without returning either credential or a reusable fingerprint.
export function verifyBotPullConfigCredentialMatch({
  expectedEncoded,
  actualEncoded,
  botImage,
  runnerImage
}) {
  verifyBotPullConfig({ encoded: expectedEncoded, botImage, runnerImage });
  verifyBotPullConfig({ encoded: actualEncoded, botImage, runnerImage });
  const expected = canonicalGhcrCredential(expectedEncoded);
  const actual = canonicalGhcrCredential(actualEncoded);
  const expectedUsername = Buffer.from(expected.username, "utf8");
  const actualUsername = Buffer.from(actual.username, "utf8");
  const expectedToken = Buffer.from(expected.token, "utf8");
  const actualToken = Buffer.from(actual.token, "utf8");
  try {
    if (expectedUsername.length !== actualUsername.length ||
        !crypto.timingSafeEqual(expectedUsername, actualUsername) ||
        expectedToken.length !== actualToken.length ||
        !crypto.timingSafeEqual(expectedToken, actualToken)) {
      reject("credential_mismatch");
    }
  } finally {
    expectedUsername.fill(0);
    actualUsername.fill(0);
    expectedToken.fill(0);
    actualToken.fill(0);
  }
  return true;
}

function canonicalGhcrCredential(encoded) {
  let parsed;
  try {
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.toString("base64") !== encoded) reject("credential_contract");
    const text = decoded.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(decoded)) reject("credential_contract");
    parsed = JSON.parse(text);
  } catch (error) {
    if (error instanceof PullConfigError) throw error;
    reject("credential_contract");
  }
  const auths = parsed?.auths;
  const credential = auths?.["ghcr.io"];
  if (
    !object(parsed) || Object.keys(parsed).join("\0") !== "auths" ||
    !object(auths) || Object.keys(auths).join("\0") !== "ghcr.io" ||
    !object(credential) || Object.keys(credential).join("\0") !== "auth" ||
    typeof credential.auth !== "string" || !credential.auth
  ) reject("credential_contract");
  let decodedCredential;
  try {
    const bytes = Buffer.from(credential.auth, "base64");
    if (bytes.toString("base64") !== credential.auth) reject("credential_contract");
    decodedCredential = bytes.toString("utf8");
    if (!Buffer.from(decodedCredential, "utf8").equals(bytes)) {
      reject("credential_contract");
    }
  } catch (error) {
    if (error instanceof PullConfigError) throw error;
    reject("credential_contract");
  }
  const separator = decodedCredential.indexOf(":");
  const username = decodedCredential.slice(0, separator);
  const token = decodedCredential.slice(separator + 1);
  if (
    separator <= 0 || !username.trim() || username !== username.trim() ||
    username.includes(":") || !token.trim() || token !== token.trim() ||
    /[\u0000-\u001f\u007f]/u.test(decodedCredential)
  ) reject("credential_contract");
  return { basic: credential.auth, username, token };
}

function abortable(promise, signal, code) {
  if (signal.aborted) return Promise.reject(new PullConfigError(code));
  return new Promise((resolve, rejectPromise) => {
    let settled = false;
    const finish = callback => value => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = finish(rejectPromise);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort(new PullConfigError(code));
    Promise.resolve(promise).then(finish(resolve), finish(rejectPromise));
  }).catch(error => {
    if (signal.aborted || !(error instanceof PullConfigError)) reject(code);
    throw error;
  });
}

async function boundedResponseText(response, maximumBytes, code, signal) {
  let declared;
  try {
    declared = response.headers.get("content-length");
  } catch {
    reject(code);
  }
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes)) {
    reject(code);
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    if (typeof response.text !== "function") reject(code);
    const text = await abortable(response.text(), signal, code);
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > maximumBytes) reject(code);
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      const result = await abortable(reader.read(), signal, code);
      if (!object(result) || typeof result.done !== "boolean") reject(code);
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) reject(code);
      received += result.value.byteLength;
      if (received > maximumBytes) reject(code);
      chunks.push(Buffer.from(result.value));
    }
  } catch (error) {
    try {
      Promise.resolve(reader.cancel()).catch(() => {});
    } catch {
      // Preserve the value-free primary error.
    }
    throw error;
  } finally {
    try { reader.releaseLock(); } catch { /* Preserve the value-free primary error. */ }
  }
  return Buffer.concat(chunks).toString("utf8");
}

function ghcrImageParts(image, allowedRepositories) {
  const match = typeof image === "string" ? image.match(GHCR_YENHUBS_IMAGE) : null;
  const fullRepository = match ? `ghcr.io/yengalvez/${match[1]}` : "";
  if (!match || !allowedRepositories.has(fullRepository)) reject("image_contract");
  return {
    owner: "yengalvez",
    repository: match[1],
    digest: match[2],
    reference: image
  };
}

async function registryFetch(fetchImpl, url, init, code, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await abortable(Promise.resolve().then(() => fetchImpl(url, {
      ...init,
      redirect: "error",
      signal
    })), signal, code);
  } catch {
    reject(code);
  }
  if (!object(response) || !Number.isInteger(response.status) ||
      !object(response.headers) || typeof response.headers.get !== "function") {
    reject(code);
  }
  return { response, signal };
}

async function verifyGhcrImages({
  encoded,
  images,
  allowedRepositories,
  fetchImpl,
  requestTimeoutMs
}) {
  if (!Array.isArray(images) || images.length < 1 || images.length > 32 ||
      !(allowedRepositories instanceof Set) || allowedRepositories.size < 1 ||
      typeof fetchImpl !== "function" || !Number.isInteger(requestTimeoutMs) ||
      requestTimeoutMs < 1 || requestTimeoutMs > MAX_REGISTRY_TIMEOUT_MS) {
    reject("registry_input");
  }
  const credential = canonicalGhcrCredential(encoded);
  const parsedImages = [...new Map(images.map(image => {
    const parsed = ghcrImageParts(image, allowedRepositories);
    return [parsed.reference, parsed];
  })).values()];

  await Promise.all(parsedImages.map(async image => {
    const scope = `repository:${image.owner}/${image.repository}:pull`;
    const tokenUrl = new URL("https://ghcr.io/token");
    tokenUrl.searchParams.set("service", "ghcr.io");
    tokenUrl.searchParams.set("scope", scope);
    const tokenRequest = await registryFetch(fetchImpl, tokenUrl, {
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${credential.basic}`
      }
    }, "registry_token_request", requestTimeoutMs);
    if (tokenRequest.response.status !== 200) reject("registry_token_denied");
    let tokenPayload;
    try {
      tokenPayload = JSON.parse(await boundedResponseText(
        tokenRequest.response,
        64 * 1024,
        "registry_token_response",
        tokenRequest.signal
      ));
    } catch (error) {
      if (error instanceof PullConfigError) throw error;
      reject("registry_token_response");
    }
    const bearer = tokenPayload?.token;
    if (
      typeof bearer !== "string" || !bearer || bearer.length > 32 * 1024 ||
      /[\u0000-\u001f\u007f]/u.test(bearer)
    ) reject("registry_token_response");

    const manifestUrl =
      `https://ghcr.io/v2/${image.owner}/${image.repository}/manifests/${image.digest}`;
    const manifestRequest = await registryFetch(fetchImpl, manifestUrl, {
      headers: {
        Accept: [
          "application/vnd.oci.image.index.v1+json",
          "application/vnd.oci.image.manifest.v1+json",
          "application/vnd.docker.distribution.manifest.list.v2+json",
          "application/vnd.docker.distribution.manifest.v2+json"
        ].join(", "),
        Authorization: `Bearer ${bearer}`
      }
    }, "registry_manifest_request", requestTimeoutMs);
    if (manifestRequest.response.status !== 200) reject("registry_manifest_denied");
    if ((manifestRequest.response.headers.get("docker-content-digest") || "") !== image.digest) {
      reject("registry_manifest_digest");
    }
    const manifestText = await boundedResponseText(
      manifestRequest.response,
      2 * 1024 * 1024,
      "registry_manifest_response",
      manifestRequest.signal
    );
    try {
      const manifest = JSON.parse(manifestText);
      if (!object(manifest) || manifest.schemaVersion !== 2) reject("registry_manifest_response");
    } catch (error) {
      if (error instanceof PullConfigError) throw error;
      reject("registry_manifest_response");
    }
  }));
  return true;
}

export async function verifyGhcrPullAccess({
  encoded,
  images,
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = DEFAULT_REGISTRY_TIMEOUT_MS
}) {
  if (!Array.isArray(images) || images.length !== 2) reject("registry_input");
  const allowedRepositories = new Set([
    "ghcr.io/yengalvez/bot-orchestrator",
    "ghcr.io/yengalvez/bot-runner"
  ]);
  const normalizedImages = images.map(image => {
    const match = typeof image === "string" ? image.match(
      /^(ghcr\.io\/yengalvez\/(?:bot-orchestrator|bot-runner))@(sha256:[a-fA-F0-9]{64})$/u
    ) : null;
    if (!match) reject("image_contract");
    return `${match[1]}@${match[2].toLowerCase()}`;
  });
  const parsedImages = normalizedImages.map(image => ghcrImageParts(image, allowedRepositories));
  if (new Set(parsedImages.map(image => image.repository)).size !== 2) reject("registry_input");
  return verifyGhcrImages({
    encoded,
    images: normalizedImages,
    allowedRepositories,
    fetchImpl,
    requestTimeoutMs
  });
}

function processLocalGhcrImages(snapshot) {
  const ghcrImages = [];
  for (const contract of PROCESS_LOCAL_IMAGE_PULL_CONTRACTS) {
    const image = snapshot[contract.valueKey];
    const match = typeof image === "string" ? image.match(PINNED_IMAGE) : null;
    if (!match || !contract.repositories.includes(match[1])) {
      reject("process_local_image_contract");
    }
    if (match[1].startsWith("ghcr.io/")) {
      if (!GHCR_YENHUBS_IMAGE.test(image)) reject("process_local_image_contract");
      ghcrImages.push(image);
    }
  }
  if (ghcrImages.length < 1) reject("process_local_image_contract");
  return [...new Set(ghcrImages)];
}

// Private pre-mutation AUD065 gate. The only input is the already projected,
// owner-private process-local snapshot; values are never accepted on argv or
// emitted. Every applicable GHCR digest (including the independent runner) is
// authenticated and fetched before this function can return success.
export async function verifyProcessLocalSnapshotGhcrAccess({
  snapshotPath,
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = DEFAULT_REGISTRY_TIMEOUT_MS
}) {
  const snapshot = readPrivateProcessLocalSnapshot(snapshotPath);
  try {
    return await verifyProcessLocalValuesGhcrAccess({
      snapshot,
      fetchImpl,
      requestTimeoutMs
    });
  } finally {
    for (const key of Object.keys(snapshot)) snapshot[key] = "";
  }
}

export async function verifyProcessLocalValuesGhcrAccess({
  snapshot,
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = DEFAULT_REGISTRY_TIMEOUT_MS
}) {
  if (!object(snapshot)) reject("process_local_snapshot_invalid");
  const images = processLocalGhcrImages(snapshot);
  const allowedRepositories = new Set(
    PROCESS_LOCAL_IMAGE_PULL_CONTRACTS.flatMap(contract =>
      contract.repositories.filter(repository => repository.startsWith("ghcr.io/")))
  );
  return verifyGhcrImages({
    encoded: snapshot.BOT_IMAGE_PULL_CONFIG_JSON_BASE64,
    images,
    allowedRepositories,
    fetchImpl,
    requestTimeoutMs
  });
}

function checksum(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function exactAnnotationKeysWithOptionalRestart(annotations, expectedKeys) {
  if (!object(annotations)) return false;
  const restartKey = "kubectl.kubernetes.io/restartedAt";
  const actualKeys = Object.keys(annotations);
  if (actualKeys.some(key => !expectedKeys.includes(key) && key !== restartKey) ||
      expectedKeys.some(key => !Object.hasOwn(annotations, key))) {
    return false;
  }
  if (Object.hasOwn(annotations, restartKey)) {
    const restartedAt = annotations[restartKey];
    if (typeof restartedAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(restartedAt) ||
        !Number.isFinite(Date.parse(restartedAt))) {
      return false;
    }
  }
  return actualKeys.length === expectedKeys.length + (Object.hasOwn(annotations, restartKey) ? 1 : 0);
}

export function verifyBotDeploymentChecksums({
  deployments,
  botKey,
  runnerKey,
  orchestratorKey,
  dashboardKey,
  recoveryEpoch,
  namespace
}) {
  if (!object(deployments) || !Array.isArray(deployments.items) ||
      typeof namespace !== "string" ||
      !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(namespace) ||
      [botKey, runnerKey, orchestratorKey, dashboardKey].some(
        value => typeof value !== "string" || Buffer.byteLength(value, "utf8") < 32
      ) ||
      typeof recoveryEpoch !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        recoveryEpoch
      )) reject("deployment_checksum_input");
  const reticulum = deployments.items.filter(item => item?.metadata?.name === "reticulum");
  const parent = deployments.items.filter(item => item?.metadata?.name === "bot-orchestrator");
  if (reticulum.length !== 1 || parent.length !== 1 ||
      reticulum[0]?.metadata?.namespace !== namespace ||
      parent[0]?.metadata?.namespace !== namespace) {
    reject("deployment_checksum_inventory");
  }
  const retAnnotations = reticulum[0]?.spec?.template?.metadata?.annotations;
  const parentAnnotations = parent[0]?.spec?.template?.metadata?.annotations;
  const retExpectedKeys = [
    "yenhubs.org/bot-access-key-checksum",
    "yenhubs.org/bot-runner-access-key-checksum",
    "yenhubs.org/bot-orchestrator-access-key-checksum",
    "yenhubs.org/bot-runner-recovery-epoch",
    "yenhubs.org/dashboard-access-key-checksum",
    "yenhubs.org/db-credential-checksum"
  ];
  if (!exactAnnotationKeysWithOptionalRestart(retAnnotations, retExpectedKeys) ||
      !exactAnnotationKeysWithOptionalRestart(parentAnnotations, [
        "yenhubs.org/bot-orchestrator-access-key-checksum",
        "yenhubs.org/bot-runner-recovery-epoch"
      ]) ||
      retAnnotations["yenhubs.org/bot-access-key-checksum"] !== checksum(botKey) ||
      retAnnotations["yenhubs.org/bot-runner-access-key-checksum"] !== checksum(runnerKey) ||
      retAnnotations["yenhubs.org/bot-orchestrator-access-key-checksum"] !== checksum(orchestratorKey) ||
      parentAnnotations["yenhubs.org/bot-orchestrator-access-key-checksum"] !== checksum(orchestratorKey) ||
      retAnnotations["yenhubs.org/bot-runner-recovery-epoch"] !== recoveryEpoch ||
      parentAnnotations["yenhubs.org/bot-runner-recovery-epoch"] !== recoveryEpoch ||
      retAnnotations["yenhubs.org/dashboard-access-key-checksum"] !== checksum(dashboardKey) ||
      !/^[a-fA-F0-9]{64}$/.test(retAnnotations["yenhubs.org/db-credential-checksum"] || "")) {
    reject("deployment_checksum_contract");
  }
  return true;
}

function parseArguments(argv) {
  if (argv.length === 2 && argv[0] === "--verify-process-local-snapshot" && argv[1]) {
    return new Map([[argv[0], argv[1]]]);
  }
  if (argv.includes("--verify-process-local-snapshot")) reject("arguments");
  const result = new Map();
  for (let index = 0; index < argv.length;) {
    const key = argv[index];
    if (key === "--verify-registry") {
      if (result.has(key)) reject("arguments");
      result.set(key, true);
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (![
      "--values", "--secret", "--namespace", "--runner-secret", "--runner-namespace", "--deployments"
    ].includes(key) || !value || result.has(key)) {
      reject("arguments");
    }
    result.set(key, value);
    index += 2;
  }
  const liveArguments = ["--secret", "--namespace", "--runner-secret", "--runner-namespace"];
  const liveCount = liveArguments.filter(name => result.has(name)).length;
  if (!result.has("--values") || (liveCount !== 0 && liveCount !== liveArguments.length)) {
    reject("arguments");
  }
  if (result.has("--deployments") && liveCount !== liveArguments.length) reject("arguments");
  return result;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.has("--verify-process-local-snapshot")) {
    await verifyProcessLocalSnapshotGhcrAccess({
      snapshotPath: args.get("--verify-process-local-snapshot")
    });
    return;
  }
  const valuesPath = args.get("--values");
  const encoded = readValue(valuesPath, "BOT_IMAGE_PULL_CONFIG_JSON_BASE64");
  const botImage = readValue(valuesPath, "OVERRIDE_BOT_ORCHESTRATOR_IMAGE");
  const runnerImage = readValue(valuesPath, "OVERRIDE_BOT_RUNNER_IMAGE");
  verifyBotPullConfig({
    encoded,
    botImage,
    runnerImage,
    ...(args.has("--secret")
      ? { secret: readJson(args.get("--secret"), "secret_unreadable"), namespace: args.get("--namespace") }
      : {}),
    ...(args.has("--runner-secret")
      ? {
          runnerSecret: readJson(args.get("--runner-secret"), "runner_secret_unreadable"),
          runnerNamespace: args.get("--runner-namespace")
        }
      : {})
  });
  if (args.has("--deployments")) {
    verifyBotDeploymentChecksums({
      deployments: readJson(args.get("--deployments"), "deployments_unreadable"),
      botKey: readValue(valuesPath, "BOT_ACCESS_KEY"),
      runnerKey: readValue(valuesPath, "BOT_RUNNER_ACCESS_KEY"),
      orchestratorKey: readValue(valuesPath, "BOT_ORCHESTRATOR_ACCESS_KEY"),
      dashboardKey: readValue(valuesPath, "DASHBOARD_ACCESS_KEY"),
      recoveryEpoch: readValue(valuesPath, "BOT_RUNNER_RECOVERY_EPOCH"),
      namespace: args.get("--namespace")
    });
  }
  if (args.has("--verify-registry")) {
    await verifyGhcrPullAccess({ encoded, images: [botImage, runnerImage] });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    await main();
  } catch (error) {
    const code = error instanceof PullConfigError ? error.code : "unexpected";
    process.stderr.write(`Bot image pull configuration failed: ${code}.\n`);
    process.exit(1);
  }
}

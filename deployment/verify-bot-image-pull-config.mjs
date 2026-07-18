#!/usr/bin/env node

// Verifies the private kubelet pull credential without printing or placing it
// on a command line. Optional live Secret snapshots from both the parent and
// dedicated runner namespaces are matched byte for byte to the private value.

import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const VALUES_PARSER = fileURLToPath(new URL("./parse-local-values.mjs", import.meta.url));
const { verifyDockerConfigCredentials } = require(
  `${ROOT_DIR}/hubs-cloud/community-edition/generate_script/verify-manifest-contracts.js`
);

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
    verifyDockerConfigCredentials(encoded, [botImage, runnerImage]);
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

function canonicalGhcrCredential(encoded) {
  let parsed;
  try {
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.toString("base64") !== encoded) reject("credential_contract");
    parsed = JSON.parse(decoded.toString("utf8"));
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
  } catch (error) {
    if (error instanceof PullConfigError) throw error;
    reject("credential_contract");
  }
  const separator = decodedCredential.indexOf(":");
  const username = decodedCredential.slice(0, separator);
  const token = decodedCredential.slice(separator + 1);
  if (
    separator <= 0 || !username.trim() || username.includes(":") ||
    !token.trim() || /[\u0000-\u001f\u007f]/u.test(decodedCredential)
  ) reject("credential_contract");
  return { basic: credential.auth };
}

async function boundedResponseText(response, maximumBytes, code) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && (declaredLength < 0 || declaredLength > maximumBytes)) {
    reject(code);
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maximumBytes) reject(code);
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maximumBytes) reject(code);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString("utf8");
}

function ghcrImageParts(image) {
  const match = image.match(
    /^ghcr\.io\/(yengalvez)\/(bot-orchestrator|bot-runner)@(sha256:[a-fA-F0-9]{64})$/
  );
  if (!match) reject("image_contract");
  return { owner: match[1], repository: match[2], digest: match[3].toLowerCase() };
}

async function registryFetch(fetchImpl, url, init, code) {
  try {
    return await fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    reject(code);
  }
}

export async function verifyGhcrPullAccess({ encoded, images, fetchImpl = globalThis.fetch }) {
  if (!Array.isArray(images) || images.length !== 2 || typeof fetchImpl !== "function") {
    reject("registry_input");
  }
  const credential = canonicalGhcrCredential(encoded);
  const parsedImages = images.map(ghcrImageParts);
  if (new Set(parsedImages.map(image => image.repository)).size !== 2) reject("registry_input");

  for (const image of parsedImages) {
    const scope = `repository:${image.owner}/${image.repository}:pull`;
    const tokenUrl = new URL("https://ghcr.io/token");
    tokenUrl.searchParams.set("service", "ghcr.io");
    tokenUrl.searchParams.set("scope", scope);
    const tokenResponse = await registryFetch(fetchImpl, tokenUrl, {
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${credential.basic}`
      }
    }, "registry_token_request");
    if (tokenResponse.status !== 200) reject("registry_token_denied");
    let tokenPayload;
    try {
      tokenPayload = JSON.parse(await boundedResponseText(tokenResponse, 64 * 1024, "registry_token_response"));
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
    const manifestResponse = await registryFetch(fetchImpl, manifestUrl, {
      headers: {
        Accept: [
          "application/vnd.oci.image.index.v1+json",
          "application/vnd.oci.image.manifest.v1+json",
          "application/vnd.docker.distribution.manifest.list.v2+json",
          "application/vnd.docker.distribution.manifest.v2+json"
        ].join(", "),
        Authorization: `Bearer ${bearer}`
      }
    }, "registry_manifest_request");
    if (manifestResponse.status !== 200) reject("registry_manifest_denied");
    if ((manifestResponse.headers.get("docker-content-digest") || "").toLowerCase() !== image.digest) {
      reject("registry_manifest_digest");
    }
    const manifestText = await boundedResponseText(
      manifestResponse,
      2 * 1024 * 1024,
      "registry_manifest_response"
    );
    try {
      const manifest = JSON.parse(manifestText);
      if (!object(manifest) || manifest.schemaVersion !== 2) reject("registry_manifest_response");
    } catch (error) {
      if (error instanceof PullConfigError) throw error;
      reject("registry_manifest_response");
    }
  }
  return true;
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

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  try {
    await main();
  } catch (error) {
    const code = error instanceof PullConfigError ? error.code : "unexpected";
    process.stderr.write(`Bot image pull configuration failed: ${code}.\n`);
    process.exit(1);
  }
}

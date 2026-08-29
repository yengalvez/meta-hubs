#!/usr/bin/env node

// Prepare an owner-private greenfield values file without printing or passing
// secret values through argv/environment. Only SMTP/admin are inherited from
// the shared source; every application credential is generated afresh.

import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { parseLocalValuesSource } from "./parse-local-values.mjs";
import { publishPrivateArtifact } from "./private-artifact-publication.mjs";

const MAX_VALUES_BYTES = 1024 * 1024;
const CUTOVER_KEY_BYTES = 64;
const MAX_CUTOVER_KEY_BYTES = 4 * 1024;
const SHARED_KEYS = Object.freeze([
  "ADM_EMAIL",
  "SMTP_SERVER",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS"
]);
const IMAGE_KEYS = Object.freeze({
  reticulum: "OVERRIDE_RETICULUM_IMAGE",
  postgrest: "OVERRIDE_POSTGREST_IMAGE",
  postgres: "OVERRIDE_POSTGRES_IMAGE",
  pgbouncer: "OVERRIDE_PGBOUNCER_IMAGE",
  botOrchestrator: "OVERRIDE_BOT_ORCHESTRATOR_IMAGE",
  botRunner: "OVERRIDE_BOT_RUNNER_IMAGE",
  spoke: "OVERRIDE_SPOKE_IMAGE",
  nearspark: "OVERRIDE_NEARSPARK_IMAGE",
  photomnemonic: "OVERRIDE_PHOTOMNEMONIC_IMAGE",
  dialog: "OVERRIDE_DIALOG_IMAGE",
  coturn: "OVERRIDE_COTURN_IMAGE",
  haproxy: "OVERRIDE_HAPROXY_IMAGE"
});
const INTERNAL_SECRET_KEYS = Object.freeze([
  "DB_PASS",
  "NODE_COOKIE",
  "GUARDIAN_KEY",
  "PHX_KEY",
  "BOT_ACCESS_KEY",
  "BOT_RUNNER_ACCESS_KEY",
  "BOT_ORCHESTRATOR_ACCESS_KEY",
  "DASHBOARD_ACCESS_KEY"
]);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readSource(filePath, { privateFile = false } = {}) {
  const resolved = path.resolve(filePath);
  const stat = fs.lstatSync(resolved, { bigint: true });
  const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : stat.uid;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== currentUid ||
      (privateFile && Number(stat.mode & 0o7777n) !== 0o600) ||
      stat.size < 1n || stat.size > BigInt(MAX_VALUES_BYTES)) {
    fail(privateFile ? "shared values source is not an owner-private 0600 file" : "template is invalid");
  }
  const source = fs.readFileSync(resolved, "utf8");
  return { source, values: parseLocalValuesSource(source) };
}

function randomCredential() {
  return randomBytes(48).toString("base64url");
}

function buildDatabaseUri(values) {
  const dbUser = values.get("DB_USER");
  const dbPass = values.get("DB_PASS");
  const dbName = values.get("DB_NAME");
  if (!dbUser || !dbPass || !dbName) fail("database identity inputs are incomplete");
  return `postgres://${encodeURIComponent(dbUser)}:${encodeURIComponent(dbPass)}` +
    `@pgbouncer/${encodeURIComponent(dbName)}`;
}

function ensureCutoverKey(outputPath) {
  const resolved = path.resolve(outputPath);
  if (fs.existsSync(resolved)) {
    const stat = fs.lstatSync(resolved, { bigint: true });
    const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : stat.uid;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== currentUid ||
        stat.nlink !== 1n || Number(stat.mode & 0o7777n) !== 0o600 ||
        stat.size < 32n || stat.size > BigInt(MAX_CUTOVER_KEY_BYTES)) {
      fail("existing cutover key is not an owner-private 0600 file");
    }
    process.stdout.write("staging_cutover_key_present\n");
    return;
  }
  const key = randomBytes(CUTOVER_KEY_BYTES);
  try {
    publishPrivateArtifact({
      outputPath: resolved,
      bytes: key,
      maximumBytes: MAX_CUTOVER_KEY_BYTES
    });
  } finally {
    key.fill(0);
  }
  process.stdout.write("staging_cutover_key_prepared\n");
}

function quoted(value) {
  return JSON.stringify(String(value));
}

function requireRepositoryDigest(value, repository, label) {
  const expected = `${repository}@sha256:`;
  if (
    typeof value !== "string" ||
    !value.startsWith(expected) ||
    !/^[0-9a-f]{64}$/u.test(value.slice(expected.length))
  ) {
    fail(`${label} must be the exact digest-pinned ${repository} image`);
  }
}

function decodeCanonicalBase64(value, label) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    fail(`${label} input must be canonical base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) fail(`${label} input must be canonical base64`);
  return decoded;
}

function readProductionSecretInputs() {
  const bytes = fs.readFileSync(0);
  try {
    if (bytes.length < 3 || bytes.length > MAX_VALUES_BYTES) {
      fail("live production secret input has an invalid size");
    }
    const encoded = bytes.toString("utf8");
    if (!Buffer.from(encoded, "utf8").equals(bytes)) {
      fail("live production secret input must be UTF-8");
    }
    const lines = encoded.split("\n");
    if (lines.length !== 2 || lines.some(line => line.length === 0)) {
      fail("live production secret input must contain exactly two base64 fields");
    }
    const botBytes = decodeCanonicalBase64(lines[0], "live BOT_ACCESS_KEY");
    const pullBytes = decodeCanonicalBase64(lines[1], "live pull config");
    try {
      const botAccessKey = botBytes.toString("utf8");
      if (
        botBytes.length < 32 || botBytes.length > 4096 ||
        !Buffer.from(botAccessKey, "utf8").equals(botBytes) ||
        /[\u0000-\u001f\u007f]/u.test(botAccessKey)
      ) {
        fail("live BOT_ACCESS_KEY must be printable UTF-8 between 32 and 4096 bytes");
      }
      let pullConfig;
      try {
        pullConfig = JSON.parse(pullBytes.toString("utf8"));
      } catch {
        fail("live pull config must contain JSON");
      }
      if (!pullConfig || typeof pullConfig !== "object" || Array.isArray(pullConfig) ||
          !pullConfig.auths || typeof pullConfig.auths !== "object" ||
          Object.keys(pullConfig.auths).length === 0) {
        fail("live pull config must contain at least one registry authorization");
      }
      return { botAccessKey, pullConfigBase64: lines[1] };
    } finally {
      botBytes.fill(0);
      pullBytes.fill(0);
    }
  } finally {
    bytes.fill(0);
  }
}

function replaceTemplateScalars(source, replacements, { appendMissing = new Set() } = {}) {
  const seen = new Set();
  let output = source.split(/(?<=\n)/u).map(line => {
    const ending = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
    const body = ending ? line.slice(0, -ending.length) : line;
    const match = body.match(/^([A-Za-z_][A-Za-z0-9_]*):(?:[ \t]+.*)?$/u);
    if (!match || !replacements.has(match[1])) return line;
    const key = match[1];
    if (seen.has(key)) fail("template contains a duplicate replacement key");
    seen.add(key);
    return `${key}: ${quoted(replacements.get(key))}${ending}`;
  }).join("");
  const missing = [...replacements.keys()].filter(key => !seen.has(key));
  const forbiddenMissing = missing.filter(key => !appendMissing.has(key));
  if (forbiddenMissing.length > 0) {
    fail(`template is missing required keys: ${forbiddenMissing.join(",")}`);
  }
  if (missing.length > 0) {
    if (output !== "" && !output.endsWith("\n")) output += "\n";
    output += missing
      .map(key => `${key}: ${quoted(replacements.get(key))}\n`)
      .join("");
  }
  parseLocalValuesSource(output);
  return Buffer.from(output, "utf8");
}

function main() {
  if (process.argv[2] === "--prepare-production-generations") {
    if (process.argv.length !== 8) {
      fail(
        "usage: prepare-staging-values.mjs --prepare-production-generations SOURCE RETICULUM_FIRST_OUTPUT FINAL_OUTPUT RETICULUM_IMAGE HUBS_IMAGE"
      );
    }
    const [, , , sourcePath, reticulumFirstPath, finalPath, reticulumImage, hubsImage] =
      process.argv;
    const source = readSource(sourcePath, { privateFile: true });
    if (
      source.values.get("Namespace") !== "hcce" ||
      source.values.get("HUB_DOMAIN") !== "meta-hubs.org"
    ) {
      fail("production source identity is not the exact YenHubs target");
    }
    requireRepositoryDigest(
      source.values.get("OVERRIDE_RETICULUM_IMAGE"),
      "ghcr.io/yengalvez/reticulum",
      "source Reticulum image"
    );
    requireRepositoryDigest(
      source.values.get("OVERRIDE_HUBS_IMAGE"),
      "ghcr.io/yengalvez/hubs",
      "source Hubs image"
    );
    requireRepositoryDigest(
      reticulumImage,
      "ghcr.io/yengalvez/reticulum",
      "candidate Reticulum image"
    );
    requireRepositoryDigest(
      hubsImage,
      "ghcr.io/yengalvez/hubs",
      "candidate Hubs image"
    );
    // Production still uses the legacy single-key bot contract and a live
    // kubelet pull binding. Read both only from stdin so neither appears in
    // argv or the environment.
    // The generator requires the three separated candidate domains before
    // the audited legacy profile removes them from the rendered manifest.
    const { botAccessKey, pullConfigBase64 } = readProductionSecretInputs();
    const separatedKeys = [];
    while (separatedKeys.length < 3) {
      const candidate = randomCredential();
      if (candidate !== botAccessKey && !separatedKeys.includes(candidate)) {
        separatedKeys.push(candidate);
      }
    }
    const sharedReplacements = new Map([
      ["OVERRIDE_RETICULUM_IMAGE", reticulumImage],
      ["OVERRIDE_BOT_RUNNER_IMAGE", "No"],
      ["BOT_RUNNER_ACTIVATION_PHASE", "active"],
      ["BOT_RUNNER_RECOVERY_PHASE", "active"],
      ["BOT_RUNNER_RECOVERY_EPOCH", randomUUID()],
      ["BOT_ACCESS_KEY", botAccessKey],
      ["BOT_RUNNER_ACCESS_KEY", separatedKeys[0]],
      ["BOT_ORCHESTRATOR_ACCESS_KEY", separatedKeys[1]],
      ["DASHBOARD_ACCESS_KEY", separatedKeys[2]],
      ["BOT_IMAGE_PULL_CONFIG_JSON_BASE64", pullConfigBase64]
    ]);
    const reticulumFirstBytes = replaceTemplateScalars(
      source.source,
      sharedReplacements,
      {
        appendMissing: new Set([
          "OVERRIDE_BOT_RUNNER_IMAGE",
          "BOT_RUNNER_ACTIVATION_PHASE",
          "BOT_RUNNER_RECOVERY_PHASE",
          "BOT_RUNNER_RECOVERY_EPOCH",
          ...INTERNAL_SECRET_KEYS.filter(key => key.startsWith("BOT_")),
          "DASHBOARD_ACCESS_KEY",
          "BOT_IMAGE_PULL_CONFIG_JSON_BASE64"
        ])
      }
    );
    const finalBytes = replaceTemplateScalars(
      source.source,
      new Map([...sharedReplacements, ["OVERRIDE_HUBS_IMAGE", hubsImage]]),
      {
        appendMissing: new Set([
          "OVERRIDE_BOT_RUNNER_IMAGE",
          "BOT_RUNNER_ACTIVATION_PHASE",
          "BOT_RUNNER_RECOVERY_PHASE",
          "BOT_RUNNER_RECOVERY_EPOCH",
          ...INTERNAL_SECRET_KEYS.filter(key => key.startsWith("BOT_")),
          "DASHBOARD_ACCESS_KEY",
          "BOT_IMAGE_PULL_CONFIG_JSON_BASE64"
        ])
      }
    );
    try {
      publishPrivateArtifact({
        outputPath: path.resolve(finalPath),
        bytes: finalBytes,
        maximumBytes: MAX_VALUES_BYTES
      });
      publishPrivateArtifact({
        outputPath: path.resolve(reticulumFirstPath),
        bytes: reticulumFirstBytes,
        maximumBytes: MAX_VALUES_BYTES
      });
    } finally {
      reticulumFirstBytes.fill(0);
      finalBytes.fill(0);
    }
    process.stdout.write("production_generations_prepared\n");
    return;
  }
  if (process.argv[2] === "--prepare-legacy-compatible") {
    if (process.argv.length !== 5) {
      fail("usage: prepare-staging-values.mjs --prepare-legacy-compatible SOURCE OUTPUT");
    }
    const source = readSource(process.argv[3], { privateFile: true });
    const runnerImage = source.values.get("OVERRIDE_BOT_RUNNER_IMAGE");
    if (
      typeof runnerImage !== "string" ||
      !/^[a-z0-9][a-z0-9._/-]*(?::[0-9]+)?\/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/u.test(runnerImage)
    ) {
      fail("legacy-compatible source must contain one digest-pinned runner image");
    }
    const bytes = replaceTemplateScalars(
      source.source,
      new Map([["OVERRIDE_BOT_RUNNER_IMAGE", "No"]])
    );
    publishPrivateArtifact({
      outputPath: path.resolve(process.argv[4]),
      bytes,
      maximumBytes: MAX_VALUES_BYTES
    });
    bytes.fill(0);
    process.stdout.write("staging_legacy_compatible_values_prepared\n");
    return;
  }
  if (process.argv[2] === "--transition-activation-phase") {
    if (process.argv.length !== 7) {
      fail(
        "usage: prepare-staging-values.mjs --transition-activation-phase SOURCE OUTPUT FROM TO"
      );
    }
    const [, , , sourcePath, outputPath, fromPhase, toPhase] = process.argv;
    const allowedTransition =
      (fromPhase === "bootstrap" && toPhase === "admission") ||
      (fromPhase === "admission" && toPhase === "active");
    if (!allowedTransition) fail("staging activation phase transition is invalid");
    const source = readSource(sourcePath, { privateFile: true });
    if (source.values.get("BOT_RUNNER_ACTIVATION_PHASE") !== fromPhase) {
      fail("staging activation phase source does not match the expected phase");
    }
    const bytes = replaceTemplateScalars(
      source.source,
      new Map([["BOT_RUNNER_ACTIVATION_PHASE", toPhase]])
    );
    publishPrivateArtifact({
      outputPath: path.resolve(outputPath),
      bytes,
      maximumBytes: MAX_VALUES_BYTES
    });
    bytes.fill(0);
    process.stdout.write(`staging_activation_phase_${toPhase}_prepared\n`);
    return;
  }
  if (process.argv[2] === "--ensure-cutover-key") {
    if (process.argv.length !== 4) {
      fail("usage: prepare-staging-values.mjs --ensure-cutover-key OUTPUT");
    }
    ensureCutoverKey(process.argv[3]);
    return;
  }
  if (process.argv[2] === "--materialize-database-uri") {
    if (process.argv.length !== 5) {
      fail("usage: prepare-staging-values.mjs --materialize-database-uri SOURCE OUTPUT");
    }
    const source = readSource(process.argv[3], { privateFile: true });
    const uri = buildDatabaseUri(source.values);
    const bytes = replaceTemplateScalars(source.source, new Map([
      ["PGRST_DB_URI", uri],
      ["PSQL", uri]
    ]));
    publishPrivateArtifact({
      outputPath: path.resolve(process.argv[4]),
      bytes,
      maximumBytes: MAX_VALUES_BYTES
    });
    bytes.fill(0);
    process.stdout.write("staging_database_uri_materialized\n");
    return;
  }
  const [templatePath, sharedValuesPath, bootstrapOutputPath, finalOutputPath, domain, imagesJson] =
    process.argv.slice(2);
  if (!templatePath || !sharedValuesPath || !bootstrapOutputPath || !finalOutputPath ||
      !domain || !imagesJson) {
    fail("usage: prepare-staging-values.mjs TEMPLATE SHARED_VALUES BOOTSTRAP_OUTPUT FINAL_OUTPUT DOMAIN IMAGES_JSON");
  }
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(domain)) {
    fail("staging domain is invalid");
  }

  let images;
  try {
    images = JSON.parse(imagesJson);
  } catch {
    fail("image map is invalid");
  }
  const requiredImageKeys = [...Object.keys(IMAGE_KEYS), "hubsLegacy", "hubsCandidate"].sort();
  if (!images || typeof images !== "object" || Array.isArray(images) ||
      Object.keys(images).sort().join(",") !== requiredImageKeys.join(",")) {
    fail("image map must contain exactly the required image keys");
  }
  for (const [name, value] of Object.entries(images)) {
    if (typeof value !== "string" ||
        !/^[a-z0-9][a-z0-9._/-]*(?::[0-9]+)?\/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/u.test(value)) {
      fail(`image ${name} is not digest pinned`);
    }
  }

  const template = readSource(templatePath);
  const shared = readSource(sharedValuesPath, { privateFile: true });
  const replacements = new Map();
  for (const key of SHARED_KEYS) {
    const value = shared.values.get(key);
    if (!value) fail(`shared values source is missing ${key}`);
    replacements.set(key, value);
  }
  replacements.set("HUB_DOMAIN", domain);
  replacements.set("Namespace", "hcce");
  for (const [name, key] of Object.entries(IMAGE_KEYS)) replacements.set(key, images[name]);
  for (const key of INTERNAL_SECRET_KEYS) replacements.set(key, randomCredential());
  const databaseUri = buildDatabaseUri(new Map([
    ["DB_USER", template.values.get("DB_USER")],
    ["DB_PASS", replacements.get("DB_PASS")],
    ["DB_NAME", template.values.get("DB_NAME")]
  ]));
  replacements.set("PGRST_DB_URI", databaseUri);
  replacements.set("PSQL", databaseUri);
  replacements.set("SKETCHFAB_API_KEY", "");
  replacements.set("TENOR_API_KEY", "");
  replacements.set("OPENAI_API_KEY", `staging-disabled-${randomCredential()}`);
  replacements.set("BOT_RUNNER_ACTIVATION_PHASE", "bootstrap");
  replacements.set("BOT_RUNNER_RECOVERY_PHASE", "active");
  replacements.set("BOT_RUNNER_RECOVERY_EPOCH", randomUUID());
  replacements.set("MAX_ACTIVE_ROOMS", "1");
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  replacements.set("PERMS_KEY", privateKey.replace(/\n/gu, "\\n"));

  const secretValues = INTERNAL_SECRET_KEYS.map(key => replacements.get(key));
  if (new Set(secretValues).size !== secretValues.length) fail("generated credentials are not distinct");
  replacements.set("OVERRIDE_HUBS_IMAGE", images.hubsLegacy);
  const bootstrapBytes = replaceTemplateScalars(template.source, replacements);
  replacements.set("OVERRIDE_HUBS_IMAGE", images.hubsCandidate);
  const finalBytes = replaceTemplateScalars(template.source, replacements);
  publishPrivateArtifact({
    outputPath: path.resolve(finalOutputPath),
    bytes: finalBytes,
    maximumBytes: MAX_VALUES_BYTES
  });
  publishPrivateArtifact({
    outputPath: path.resolve(bootstrapOutputPath),
    bytes: bootstrapBytes,
    maximumBytes: MAX_VALUES_BYTES
  });
  bootstrapBytes.fill(0);
  finalBytes.fill(0);
  process.stdout.write("staging_values_prepared\n");
}

try {
  main();
} catch {
  fail("staging values preparation failed closed");
}

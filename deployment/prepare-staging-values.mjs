#!/usr/bin/env node

// Prepare an owner-private greenfield values file without printing or passing
// secret values through argv/environment. Only SMTP/admin are inherited from
// the shared source; every application credential is generated afresh unless
// the closed synthetic seed selector preserves its tracked public PHX domain.

import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

// This opt-in is a bridge for one already-approved synthetic seed, not a
// caller-selected crypto key, production restore path or deployment authority.
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_CI_TEMPLATE = path.join(REPOSITORY_ROOT, "hubs-cloud/community-edition/input-values.ci.yaml");
const PUBLIC_TEST_CONFIG = path.join(REPOSITORY_ROOT, "hubs-cloud/community-edition/services/reticulum/config/test.exs");
const PUBLIC_CI_SHA256 = "5cb011c8805795b4e78067e476e324210081a97d4639d6452c1f63a5d0e74f7a";
const PUBLIC_CONFIG_SHA256 = "1bda7179b048bbf80e4d95a8e228810a7578f96ffebdf1c7557a78ab1253e4b7";
const SEED_DATASET_SHA256 = "0c20c58c231996f43fe30a19ee9b8fac67ba583d710cb0dfa4ea7183c3641443";
// Observed on 2026-10-04; not a historical immutability receipt.
const SEED_SQL_SHA256 = "fa47f64379c63ec6eba056dfaf93faea2b94eaf3465750568695b9e982ab8cdc";
const SEED_SCOPE = "native-PG14-existing-synthetic-seed-restore-not-kubernetes-production-browser-or-cycles";
const SEED_CRYPTO_DOMAIN = "unchanged-tracked-MIX_ENV-test-RetWeb.Endpoint-secret_key_base";
const SEED_GRAPH_SCOPE = "native-synthetic-room-project-graph-not-current-metaverse";
const SEED_SOURCE_IDENTITY = Object.freeze({
  ".": "d52e25f9bf4f787de6190f26a0260ce5deaf94f9",
  hubs: "2a3d7ab406466d6d69c6e0b8776df42fb7c1931e",
  "hubs-cloud": "cb15414037754a2dc4f08a1b375519bad7478958"
});
const SYNTHETIC_CREATOR_URL = "https://virtualmente.avaturn.dev";
const MAX_SEED_FILE_BYTES = 128 * 1024 * 1024;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const exactKeys = (object, keys) => object && typeof object === "object" && !Array.isArray(object) &&
  Object.keys(object).sort().join(",") === [...keys].sort().join(",");
const syntheticCheck = condition => {
  if (!condition) throw new Error("synthetic_seed_values_invalid");
};

function directSyntheticPath(filename, io, { absent = false } = {}) {
  syntheticCheck(typeof filename === "string" && path.isAbsolute(filename) &&
    path.resolve(filename) === filename && !filename.includes("\0"));
  const target = absent ? path.dirname(filename) : filename;
  for (let current = target; ; current = path.dirname(current)) {
    syntheticCheck(!io.lstatSync(current, { bigint: true }).isSymbolicLink());
    if (current === path.dirname(current)) break;
  }
  syntheticCheck(io.realpathSync(target) === target);
  if (absent) {
    try {
      io.lstatSync(filename, { bigint: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    syntheticCheck(false);
  }
}

function syntheticOwnedDirectory(filename, io, { privateDirectory = false } = {}) {
  directSyntheticPath(filename, io);
  const stat = io.lstatSync(filename, { bigint: true });
  syntheticCheck(stat.isDirectory() && stat.uid === BigInt(process.getuid()) &&
    (privateDirectory ? Number(stat.mode & 0o7777n) === 0o700 : (stat.mode & 0o022n) === 0n));
}

function syntheticRead(filename, io, { privateFile = false, maximumBytes = MAX_VALUES_BYTES } = {}) {
  directSyntheticPath(filename, io);
  const stat = io.lstatSync(filename, { bigint: true });
  syntheticCheck(stat.isFile() && stat.uid === BigInt(process.getuid()) && stat.nlink === 1n &&
    (privateFile ? Number(stat.mode & 0o7777n) === 0o600 : (stat.mode & 0o022n) === 0n) &&
    stat.size >= 1n && stat.size <= BigInt(maximumBytes));
  syntheticCheck(typeof fs.constants.O_NOFOLLOW === "number");
  const descriptor = io.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = io.fstatSync(descriptor, { bigint: true });
    syntheticCheck(opened.dev === stat.dev && opened.ino === stat.ino && opened.mode === stat.mode &&
      opened.uid === stat.uid && opened.nlink === stat.nlink && opened.size === stat.size);
    const bytes = io.readFileSync(descriptor);
    const after = io.fstatSync(descriptor, { bigint: true });
    syntheticCheck(bytes.length === Number(stat.size) && after.size === stat.size &&
      after.mtimeNs === opened.mtimeNs && after.ctimeNs === opened.ctimeNs);
    return bytes;
  } finally {
    io.closeSync(descriptor);
  }
}

function syntheticJson(bytes) {
  const source = bytes.toString("utf8");
  syntheticCheck(Buffer.from(source).equals(bytes));
  const value = JSON.parse(source, (key, value) => {
    syntheticCheck(!["__proto__", "prototype", "constructor", "key", "PHX_KEY", "secret_key_base"].includes(key));
    return value;
  });
  // Binding publication and image arguments use JSON.stringify. Canonical
  // forms exclude duplicate/shadowed object keys and alternate encodings.
  syntheticCheck(source === JSON.stringify(value) || source === `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

function publicProfileBlock(modules) {
  return "PRODUCT_MODULES:\n" + Object.entries(modules)
    .map(([key, value]) => `  ${key}: ${typeof value === "string" ? JSON.stringify(value) : value}\n`).join("");
}

function syntheticProfile(template, ci, source, ciSource) {
  syntheticCheck(template.size === ci.size && [...ci].every(([key, value]) =>
    key === "PRODUCT_MODULES" || template.get(key) === value));
  const modules = template.get("PRODUCT_MODULES");
  syntheticCheck(exactKeys(modules, ["schema_version", "bots", "ai", "avaturn", "avaturn_creator_url"]) &&
    modules.schema_version === 1 && [modules.bots, modules.ai, modules.avaturn].every(value => typeof value === "boolean") &&
    (!modules.ai || modules.bots) &&
    modules.avaturn_creator_url === (modules.avaturn ? SYNTHETIC_CREATOR_URL : ""));
  const block = publicProfileBlock(modules);
  const literalVariant = ciSource.replace(/^PRODUCT_MODULES:\n(?:  [^\n]*\n)+/mu, block);
  const scalarVariant = [...ci].map(([key, value]) => key === "PRODUCT_MODULES"
    ? block : `${key}: ${JSON.stringify(String(value))}\n`).join("");
  // Permit the tracked public text or its canonical scalar serialization with
  // only the capability profile changed. Never copy hidden comment payloads.
  syntheticCheck(source === literalVariant || source === scalarVariant);
}

function syntheticImageMap(imagesJson, ci) {
  const images = syntheticJson(Buffer.from(imagesJson));
  syntheticCheck(exactKeys(images, [...Object.keys(IMAGE_KEYS), "hubsLegacy", "hubsCandidate"]));
  for (const [name, key] of Object.entries(IMAGE_KEYS)) {
    syntheticCheck(images[name] === ci.get(key) && images[name].startsWith("registry.invalid/"));
  }
  syntheticCheck(images.hubsLegacy === ci.get("OVERRIDE_HUBS_IMAGE") &&
    images.hubsCandidate === ci.get("OVERRIDE_HUBS_IMAGE"));
  return images;
}

function syntheticSeedBinding(binding, source, io, hash) {
  syntheticCheck(exactKeys(binding, ["schema", "scope", "crypto_domain", "fixture_kind", "dataset_binding_sha256",
    "source_identity", "sql_reference", "sequence", "tables", "files", "entries", "graph", "fixture_config_sha256",
    "source_files", "pair_binding_sha256"]) && binding.schema === 1 && binding.scope === SEED_SCOPE &&
    binding.crypto_domain === SEED_CRYPTO_DOMAIN && binding.fixture_kind === "Reticulum-MIX_ENV-test-public-fixture" &&
    binding.fixture_config_sha256 === PUBLIC_CONFIG_SHA256 && binding.dataset_binding_sha256 === SEED_DATASET_SHA256 &&
    exactKeys(binding.source_identity, Object.keys(SEED_SOURCE_IDENTITY)) &&
    Object.entries(SEED_SOURCE_IDENTITY).every(([key, value]) => binding.source_identity[key] === value) &&
    exactKeys(binding.sql_reference, ["captured_on", "capture_kind", "sha256"]) &&
    binding.sql_reference.captured_on === "2026-10-04" && binding.sql_reference.capture_kind === "primary-source-only" &&
    binding.sql_reference.sha256 === SEED_SQL_SHA256 &&
    exactKeys(binding.sequence, ["name", "last_value", "is_called", "captured_on"]) &&
    binding.sequence.name === "ret0.table_id_seq" && binding.sequence.last_value === "180" &&
    binding.sequence.is_called === true && binding.sequence.captured_on === "2026-10-04" &&
    Array.isArray(binding.files) && binding.files.length === 103 &&
    Array.isArray(binding.entries) && binding.entries.length === 33 && binding.graph?.scope === SEED_GRAPH_SCOPE &&
    Array.isArray(binding.source_files) && binding.source_files.length === 212 &&
    hash(JSON.stringify(binding.source_files)) === binding.pair_binding_sha256);

  syntheticOwnedDirectory(source, io, { privateDirectory: true });
  syntheticOwnedDirectory(path.join(source, "database"), io, { privateDirectory: true });
  directSyntheticPath(path.join(source, "database/postmaster.pid"), io, { absent: true });
  const required = new Map([
    ["database/PG_VERSION", undefined], ["reticulum/config/test.exs", PUBLIC_CONFIG_SHA256],
    ["catalog-native.sql", SEED_SQL_SHA256], ["summary.json", undefined],
    ["catalog-readback.json", undefined], ["catalog-input/input.json", undefined]
  ]);
  const expectedSizes = new Map([["database/PG_VERSION", 3], ["reticulum/config/test.exs", 2597], ["catalog-native.sql", 375445]]);
  const uuids = new Set();
  for (const row of binding.files) {
    const uuid = row?.owned_file_uuid;
    syntheticCheck(typeof uuid === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(uuid) && !uuids.has(uuid) &&
      [row.blob_sha256, row.meta_sha256].every(value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)) &&
      [row.blob_bytes, row.meta_bytes].every(value => Number.isSafeInteger(value) && value > 0 && value <= MAX_SEED_FILE_BYTES) && row.blob_bytes >= 12);
    uuids.add(uuid);
    const base = `reticulum/storage/test/owned/${uuid.slice(0, 2)}/${uuid.slice(2, 4)}/${uuid}`;
    required.set(`${base}.blob`, row.blob_sha256);
    required.set(`${base}.meta.json`, row.meta_sha256);
    expectedSizes.set(`${base}.blob`, row.blob_bytes);
    expectedSizes.set(`${base}.meta.json`, row.meta_bytes);
  }
  const seen = new Set();
  for (const row of binding.source_files) {
    syntheticCheck(exactKeys(row, ["path", "sha256", "bytes"]) && typeof row.path === "string" &&
      required.has(row.path) && !seen.has(row.path) && /^[a-f0-9]{64}$/u.test(row.sha256) &&
      Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.bytes <= MAX_SEED_FILE_BYTES &&
      (required.get(row.path) === undefined || required.get(row.path) === row.sha256) &&
      (expectedSizes.get(row.path) === undefined || expectedSizes.get(row.path) === row.bytes));
    seen.add(row.path);
    const filename = path.join(source, row.path);
    for (let parent = path.dirname(filename); parent !== source; parent = path.dirname(parent)) syntheticOwnedDirectory(parent, io);
    const bytes = syntheticRead(filename, io, { privateFile: row.path !== "reticulum/config/test.exs", maximumBytes: MAX_SEED_FILE_BYTES });
    try {
      syntheticCheck(bytes.length === row.bytes && hash(bytes) === row.sha256 &&
        (row.path !== "database/PG_VERSION" || bytes.toString("utf8") === "14\n") &&
        (row.path !== "catalog-native.sql" || bytes.length === 375445));
    } finally {
      bytes.fill(0);
    }
  }
  syntheticCheck(seen.size === required.size);
  // Refuse extra/unbound media rather than validating only a caller's list.
  const actualMedia = [];
  const walk = relative => {
    const directory = path.join(source, relative);
    syntheticOwnedDirectory(directory, io);
    for (const name of io.readdirSync(directory)) {
      syntheticCheck(typeof name === "string" && name !== "." && name !== ".." && !name.includes(path.sep));
      const child = `${relative}/${name}`;
      const stat = io.lstatSync(path.join(source, child), { bigint: true });
      syntheticCheck(!stat.isSymbolicLink());
      if (stat.isDirectory()) walk(child);
      else actualMedia.push(child);
    }
  };
  walk("reticulum/storage/test/owned");
  syntheticCheck(actualMedia.length === 206 && actualMedia.every(filename => seen.has(filename)));
}

// Pure test seams are not CLI flags or environment overrides. The CLI always
// uses node:fs and SHA-256; tests may supply only false, in-memory seed bytes.
export function prepareSyntheticSeedValues(args, { io = fs, hash = sha256, env = process.env } = {}) {
  syntheticCheck(Array.isArray(args) && args.length === 8 &&
    !["PHX_KEY", "SECRET_KEY_BASE", "RET_SECRET_KEY_BASE", "SYNTHETIC_SEED_PHX_KEY"].some(key => Object.hasOwn(env, key)));
  const [templatePath, sharedPath, bindingPath, source, bootstrapPath, finalPath, domain, imagesJson] = args;
  syntheticCheck(typeof domain === "string" && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+invalid$/u.test(domain));
  const inputPaths = [templatePath, sharedPath, bindingPath, source, PUBLIC_CI_TEMPLATE, PUBLIC_TEST_CONFIG];
  for (const filename of inputPaths) directSyntheticPath(filename, io);
  for (const output of [bootstrapPath, finalPath]) {
    directSyntheticPath(output, io, { absent: true });
    syntheticOwnedDirectory(path.dirname(output), io, { privateDirectory: true });
    syntheticCheck(!inputPaths.some(input => output === input || output.startsWith(`${input}${path.sep}`)));
  }
  syntheticCheck(bootstrapPath !== finalPath && new Set([templatePath, sharedPath, bindingPath, source]).size === 4);
  const explicitInputs = [templatePath, sharedPath, bindingPath, source];
  syntheticCheck(!explicitInputs.some((left, index) => explicitInputs.some((right, other) =>
    index !== other && left.startsWith(`${right}${path.sep}`))));

  const ciBytes = syntheticRead(PUBLIC_CI_TEMPLATE, io);
  const configBytes = syntheticRead(PUBLIC_TEST_CONFIG, io);
  const templateBytes = syntheticRead(templatePath, io);
  const sharedBytes = syntheticRead(sharedPath, io, { privateFile: true });
  const bindingBytes = syntheticRead(bindingPath, io, { privateFile: true });
  try {
    syntheticCheck(hash(ciBytes) === PUBLIC_CI_SHA256 && hash(configBytes) === PUBLIC_CONFIG_SHA256);
    const ci = parseLocalValuesSource(ciBytes.toString("utf8"));
    const template = { source: templateBytes.toString("utf8"), values: parseLocalValuesSource(templateBytes.toString("utf8")) };
    const shared = { values: parseLocalValuesSource(sharedBytes.toString("utf8")) };
    syntheticProfile(template.values, ci, template.source, ciBytes.toString("utf8"));
    syntheticCheck(shared.values.size === SHARED_KEYS.length && SHARED_KEYS.every(key => shared.values.get(key) === ci.get(key)));
    const images = syntheticImageMap(imagesJson, ci);
    syntheticSeedBinding(syntheticJson(bindingBytes), source, io, hash);
    const config = configBytes.toString("utf8");
    const matches = [...config.matchAll(/secret_key_base: String\.duplicate\("([^"\\\n]+)", ([1-9][0-9]*)\)/gu)];
    syntheticCheck(matches.length === 1 && Number(matches[0][2]) === 8);
    const phxKey = matches[0][1].repeat(8);
    syntheticCheck(phxKey.length >= 64 && phxKey.length <= 4096);
    return buildGreenfieldValues({ template, shared, domain, images, syntheticPhxKey: phxKey });
  } finally {
    for (const bytes of [ciBytes, configBytes, templateBytes, sharedBytes, bindingBytes]) bytes.fill(0);
  }
}

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

function buildGreenfieldValues({ template, shared, domain, images, syntheticPhxKey }) {
  const replacements = new Map();
  for (const key of SHARED_KEYS) {
    const value = shared.values.get(key);
    if (!value) fail(`shared values source is missing ${key}`);
    replacements.set(key, value);
  }
  replacements.set("HUB_DOMAIN", domain);
  replacements.set("Namespace", "hcce");
  for (const [name, key] of Object.entries(IMAGE_KEYS)) replacements.set(key, images[name]);
  for (const key of INTERNAL_SECRET_KEYS) {
    replacements.set(key, key === "PHX_KEY" && syntheticPhxKey !== undefined ? syntheticPhxKey : randomCredential());
  }
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
  const options = syntheticPhxKey === undefined ? undefined : { appendMissing: new Set(["PERMS_KEY"]) };
  replacements.set("OVERRIDE_HUBS_IMAGE", images.hubsLegacy);
  const bootstrapBytes = replaceTemplateScalars(template.source, replacements, options);
  replacements.set("OVERRIDE_HUBS_IMAGE", images.hubsCandidate);
  const finalBytes = replaceTemplateScalars(template.source, replacements, options);
  return { bootstrapBytes, finalBytes };
}

export function publishGreenfieldValues({ bootstrapBytes, finalBytes }, bootstrapOutputPath, finalOutputPath, publish = publishPrivateArtifact) {
  try {
    publish({ outputPath: path.resolve(finalOutputPath), bytes: finalBytes, maximumBytes: MAX_VALUES_BYTES });
    publish({ outputPath: path.resolve(bootstrapOutputPath), bytes: bootstrapBytes, maximumBytes: MAX_VALUES_BYTES });
  } finally {
    bootstrapBytes.fill(0);
    finalBytes.fill(0);
  }
}

function main() {
  if (process.argv[2] === "--prepare-synthetic-seed-values") {
    const args = process.argv.slice(3);
    const bytes = prepareSyntheticSeedValues(args);
    publishGreenfieldValues(bytes, args[4], args[5]);
    process.stdout.write("synthetic_seed_values_prepared\n");
    return;
  }
  if (process.argv[2] === "--transition-recovery-phase") {
    if (process.argv.length !== 7) {
      fail(
        "usage: prepare-staging-values.mjs --transition-recovery-phase SOURCE OUTPUT FROM TO"
      );
    }
    const [, , , sourcePath, outputPath, fromPhase, toPhase] = process.argv;
    const allowedTransition =
      (fromPhase === "active" && toPhase === "restore-fence") ||
      (fromPhase === "restore-fence" && toPhase === "active");
    if (!allowedTransition) fail("staging recovery phase transition is invalid");
    const source = readSource(sourcePath, { privateFile: true });
    if (source.values.get("PRODUCT_MODULES")?.bots !== true ||
        source.values.get("BOT_RUNNER_ACTIVATION_PHASE") !== "active") {
      fail("staging recovery phase requires an activated durable bot installation");
    }
    requireRepositoryDigest(
      source.values.get("OVERRIDE_BOT_RUNNER_IMAGE"),
      "ghcr.io/yengalvez/bot-runner",
      "durable runner"
    );
    if (source.values.get("BOT_RUNNER_RECOVERY_PHASE") !== fromPhase) {
      fail("staging recovery phase source does not match the expected phase");
    }
    const sourceEpoch = source.values.get("BOT_RUNNER_RECOVERY_EPOCH");
    if (typeof sourceEpoch !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(sourceEpoch)) {
      fail("staging recovery phase requires a canonical source epoch");
    }
    const targetEpoch = fromPhase === "active" ? randomUUID() : sourceEpoch;
    if (fromPhase === "active" && targetEpoch === sourceEpoch) {
      fail("staging recovery fence requires a distinct target epoch");
    }
    // File preparation is not restore authority. The coordinator and guarded
    // apply must still bind this epoch to the checkpoint, live UIDs and journal.
    const bytes = replaceTemplateScalars(source.source, new Map([
      ["BOT_RUNNER_RECOVERY_PHASE", toPhase],
      ["BOT_RUNNER_RECOVERY_EPOCH", targetEpoch]
    ]));
    try {
      publishPrivateArtifact({
        outputPath: path.resolve(outputPath),
        bytes,
        maximumBytes: MAX_VALUES_BYTES
      });
    } finally {
      bytes.fill(0);
    }
    process.stdout.write(`staging_recovery_phase_${toPhase}_prepared\n`);
    return;
  }
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
  publishGreenfieldValues(buildGreenfieldValues({ template, shared, domain, images }), bootstrapOutputPath, finalOutputPath);
  process.stdout.write("staging_values_prepared\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch {
    fail("staging values preparation failed closed");
  }
}

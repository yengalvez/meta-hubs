#!/usr/bin/env node

import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  timingSafeEqual
} from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_PROFILE_URL = new URL("./process-local-rotation-profile.json", import.meta.url);
export const PROCESS_LOCAL_ROTATION_PROFILE_SHA256 =
  "1b922b6313c9b5e98b3dfd95c3d619da74c752f3f5ab85361e929c9348fe549b";
const LEGACY_LAST_APPLIED_ANNOTATION =
  "kubectl.kubernetes.io/last-applied-configuration";
const SECRET_METADATA_KEYS = new Set([
  "annotations",
  "creationTimestamp",
  "managedFields",
  "name",
  "namespace",
  "resourceVersion",
  "uid"
]);
const DIGEST_IMAGE = /^(.+)@sha256:([a-f0-9]{64})$/u;
const DNS_LABEL = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/u;
const HEX_SHA256 = /^[a-f0-9]{64}$/u;
const ROTATION_REVISION = /^aud065-[a-z0-9](?:[-a-z0-9.]{6,61}[a-z0-9])$/u;

export class ProcessLocalRotationError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProcessLocalRotationError";
    this.code = code;
  }
}

function fail(code) {
  throw new ProcessLocalRotationError(code);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function exactKeys(value, keys) {
  return isRecord(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function sameStringSet(left, right) {
  return Array.isArray(left) && Array.isArray(right) &&
    JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function clone(value) {
  return structuredClone(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonicalize(value[key])])
  );
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqual(left, right) {
  const leftBytes = Buffer.from(String(left));
  const rightBytes = Buffer.from(String(right));
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function requireString(value, code, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) ||
      /[\u0000\r\n\u007f]/u.test(value)) {
    fail(code);
  }
  return value;
}

function resourceIdentity(resource) {
  if (!isRecord(resource) || typeof resource.apiVersion !== "string" ||
      typeof resource.kind !== "string" || !isRecord(resource.metadata) ||
      typeof resource.metadata.name !== "string" || !resource.metadata.name) {
    fail("baseline_resource_identity_invalid");
  }
  const namespace = resource.metadata.namespace || "";
  if (typeof namespace !== "string") fail("baseline_resource_namespace_invalid");
  return `${resource.apiVersion}\u0000${resource.kind}\u0000${namespace}\u0000${resource.metadata.name}`;
}

function displayIdentity(resource) {
  return {
    apiVersion: resource.apiVersion,
    kind: resource.kind,
    namespace: resource.metadata.namespace || null,
    name: resource.metadata.name
  };
}

function indexResources(resources) {
  if (!Array.isArray(resources) || resources.length === 0) {
    fail("baseline_resources_invalid");
  }
  const index = new Map();
  for (const resource of resources) {
    const identity = resourceIdentity(resource);
    if (index.has(identity)) fail("baseline_resource_identity_duplicate");
    index.set(identity, resource);
  }
  return index;
}

function findExactResource(resources, apiVersion, kind, namespace, name, code) {
  const identity = `${apiVersion}\u0000${kind}\u0000${namespace}\u0000${name}`;
  const resource = indexResources(resources).get(identity);
  if (!resource) fail(code);
  return resource;
}

function renderProfileResourceIdentity(identity, namespace) {
  return [
    identity.apiVersion,
    identity.kind,
    identity.namespace === "$Namespace" ? namespace : "",
    identity.name === "$Namespace" ? namespace : identity.name
  ].join("\u0000");
}

function assertBaselineResourceInventory(resources, namespace, profile) {
  const actual = new Set(indexResources(resources).keys());
  const expected = new Set(profile.baseline_resource_identities.map(identity =>
    renderProfileResourceIdentity(identity, namespace)
  ));
  if (actual.size !== expected.size ||
      [...expected].some(identity => !actual.has(identity))) {
    fail("baseline_resource_inventory_invalid");
  }
}

function validateProfile(inputProfile) {
  let profile;
  try {
    profile = structuredClone(inputProfile);
  } catch (_error) {
    fail("rotation_profile_invalid");
  }
  if (!isRecord(profile) || profile.schema_version !== 1 ||
      typeof profile.profile_id !== "string" || profile.runner_mode !== "process-local" ||
      !exactKeys(profile.baseline_provenance, [
        "cloud_source_commit", "historical_generated_resource_count"
      ]) ||
      profile.baseline_provenance.cloud_source_commit !==
        "5a82de5387d7296cd01470d5136b2c07c2d5c7ac" ||
      profile.baseline_provenance.historical_generated_resource_count !== 42 ||
      profile.namespace_value_key !== "Namespace" ||
      !exactKeys(profile.projected_resources, ["secret"]) ||
      !exactKeys(profile.bound_resources, ["config_map"]) ||
      !isRecord(profile.annotations) || !isRecord(profile.forbidden) ||
      !isRecord(profile.database_uri_contracts) ||
      !isRecord(profile.ret_config_placeholder_counts)) {
    fail("rotation_profile_invalid");
  }
  const arrays = [
    "baseline_resource_identities",
    "required_deployments",
    "secret_keys",
    "derived_secret_keys",
    "invariant_secret_keys",
    "required_rotated_secret_keys",
    "rotate_if_configured_secret_keys",
    "ret_config_forbidden_value_keys",
    "secret_env_bindings",
    "image_pairs",
    "rotation_revision_deployments",
    "db_checksum_deployments",
    "bot_access_checksum_deployments",
    "perms_fingerprint_deployments"
  ];
  if (arrays.some(name => !Array.isArray(profile[name]))) fail("rotation_profile_invalid");
  for (const name of [
    "resource_names", "annotation_keys", "secret_domain_keys", "bot_orchestrator_env_names"
  ]) {
    if (!Array.isArray(profile.forbidden[name])) fail("rotation_profile_invalid");
  }
  if (profile.projected_resources.secret !== "configs" ||
      profile.bound_resources.config_map !== "ret-config" ||
      profile.ret_config_data_key !== "config.toml.template" ||
      profile.baseline_resource_identities.length !== 42 ||
      profile.baseline_provenance.historical_generated_resource_count !==
        profile.baseline_resource_identities.length ||
      profile.required_deployments.length !== 12 || profile.image_pairs.length !== 13 ||
      profile.secret_keys.length !== 22 || profile.secret_env_bindings.length !== 32 ||
      new Set(profile.required_deployments).size !== 12 ||
      new Set(profile.secret_keys).size !== 22 ||
      !exactKeys(profile.annotations, [
        "credential_revision",
        "database_checksum",
        "bot_access_key_checksum",
        "perms_public_key_sha256"
      ])) {
    fail("rotation_profile_invalid");
  }
  const baselineIdentities = new Set();
  for (const identity of profile.baseline_resource_identities) {
    if (!exactKeys(identity, ["apiVersion", "kind", "namespace", "name"]) ||
        typeof identity.apiVersion !== "string" || !identity.apiVersion ||
        typeof identity.kind !== "string" || !identity.kind ||
        !["object", "string"].includes(typeof identity.namespace) ||
        (identity.namespace !== null && identity.namespace !== "$Namespace") ||
        typeof identity.name !== "string" || !identity.name ||
        (identity.name.includes("$") && identity.name !== "$Namespace")) {
      fail("rotation_profile_invalid");
    }
    baselineIdentities.add(canonicalJson(identity));
  }
  if (baselineIdentities.size !== 42) fail("rotation_profile_invalid");
  const secretKeys = new Set(profile.secret_keys);
  for (const name of [
    ...profile.derived_secret_keys,
    ...profile.invariant_secret_keys,
    ...profile.required_rotated_secret_keys,
    ...profile.rotate_if_configured_secret_keys,
    ...profile.ret_config_forbidden_value_keys
  ]) {
    if (!secretKeys.has(name)) fail("rotation_profile_invalid");
  }
  if (profile.forbidden.secret_domain_keys.some(name => secretKeys.has(name)) ||
      !sameStringSet(Object.keys(profile.database_uri_contracts), ["PGRST_DB_URI", "PSQL"])) {
    fail("rotation_profile_invalid");
  }
  const requiredDeployments = new Set(profile.required_deployments);
  for (const list of [
    profile.rotation_revision_deployments,
    profile.db_checksum_deployments,
    profile.bot_access_checksum_deployments,
    profile.perms_fingerprint_deployments
  ]) {
    if (new Set(list).size !== list.length || list.some(name => !requiredDeployments.has(name))) {
      fail("rotation_profile_invalid");
    }
  }
  if (profile.rotation_revision_deployments.length !== 6) fail("rotation_profile_invalid");
  if (Object.keys(profile.ret_config_placeholder_counts).length !== 24 ||
      Object.entries(profile.ret_config_placeholder_counts).some(([name, count]) =>
        !/^[A-Z][A-Z0-9_]*$/u.test(name) || !Number.isInteger(count) || count < 1)) {
    fail("rotation_profile_invalid");
  }
  const envBindings = new Set();
  for (const binding of profile.secret_env_bindings) {
    if (!exactKeys(binding, ["deployment", "container", "env", "key"]) ||
        !requiredDeployments.has(binding.deployment) ||
        ![binding.container, binding.env, binding.key].every(value =>
          typeof value === "string" && value.length > 0) ||
        !secretKeys.has(binding.key)) {
      fail("rotation_profile_invalid");
    }
    envBindings.add(`${binding.deployment}/${binding.container}/${binding.env}/${binding.key}`);
  }
  if (envBindings.size !== 32) fail("rotation_profile_invalid");
  const pairs = new Set();
  for (const pair of profile.image_pairs) {
    if (!exactKeys(pair, ["deployment", "container", "value_key", "repositories"]) ||
        !requiredDeployments.has(pair.deployment) || typeof pair.container !== "string" ||
        typeof pair.value_key !== "string" || !Array.isArray(pair.repositories) ||
        pair.repositories.length === 0 || pair.repositories.some(value => typeof value !== "string")) {
      fail("rotation_profile_invalid");
    }
    pairs.add(`${pair.deployment}/${pair.container}`);
  }
  if (pairs.size !== 13 ||
      profile.required_deployments.some(name =>
        !profile.image_pairs.some(pair => pair.deployment === name))) {
    fail("rotation_profile_invalid");
  }
  for (const [key, contract] of Object.entries(profile.database_uri_contracts)) {
    const expectedKeys = key === "PGRST_DB_URI"
      ? ["host_value_key", "port"]
      : ["host_literal", "port"];
    if (!exactKeys(contract, expectedKeys) || typeof contract.port !== "string") {
      fail("rotation_profile_invalid");
    }
  }
  if (Object.values(profile.annotations).some(value => typeof value !== "string") ||
      new Set(Object.values(profile.annotations)).size !== 4) {
    fail("rotation_profile_invalid");
  }
  if (!safeEqual(
    sha256(canonicalJson(profile)), PROCESS_LOCAL_ROTATION_PROFILE_SHA256
  )) {
    fail("rotation_profile_invalid");
  }
  return profile;
}

export function loadProcessLocalRotationProfile(profilePath = fileURLToPath(DEFAULT_PROFILE_URL)) {
  let profile;
  try {
    profile = JSON.parse(readFileSync(profilePath, "utf8"));
  } catch (_error) {
    fail("rotation_profile_unreadable");
  }
  return validateProfile(profile);
}

function decodeSecretValue(value) {
  if (typeof value !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    fail("baseline_secret_data_invalid");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) fail("baseline_secret_data_invalid");
  const text = decoded.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(decoded)) fail("baseline_secret_data_invalid");
  return text;
}

function readSecret(resource, profile) {
  const hasStringData = isRecord(resource.stringData);
  const hasData = isRecord(resource.data);
  if (hasStringData === hasData) fail("baseline_secret_encoding_invalid");
  const source = hasStringData ? resource.stringData : resource.data;
  if (!sameStringSet(Object.keys(source), profile.secret_keys)) {
    fail("baseline_secret_keyset_invalid");
  }
  const values = {};
  for (const key of profile.secret_keys) {
    values[key] = hasStringData
      ? requireString(source[key], "baseline_secret_value_invalid", { allowEmpty: true })
      : decodeSecretValue(source[key]);
  }
  return { values, encoding: hasStringData ? "stringData" : "data" };
}

function validateLegacyLastApplied(value, liveValues, namespace, profile) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (_error) {
    fail("baseline_secret_last_applied_invalid");
  }
  if (!exactKeys(parsed, ["apiVersion", "kind", "metadata", "stringData"]) ||
      parsed.apiVersion !== "v1" || parsed.kind !== "Secret" ||
      !exactKeys(parsed.metadata, ["name", "namespace"]) ||
      parsed.metadata.name !== profile.projected_resources.secret ||
      parsed.metadata.namespace !== namespace || !isRecord(parsed.stringData) ||
      !sameStringSet(Object.keys(parsed.stringData), profile.secret_keys)) {
    fail("baseline_secret_last_applied_invalid");
  }
  for (const key of profile.secret_keys) {
    if (typeof parsed.stringData[key] !== "string" ||
        !safeEqual(parsed.stringData[key], liveValues[key])) {
      fail("baseline_secret_last_applied_invalid");
    }
  }
}

function validateSecretMetadata(resource, liveValues, namespace, profile) {
  if (!Object.keys(resource).every(key => [
    "apiVersion", "kind", "metadata", "type", "immutable", "data", "stringData"
  ].includes(key)) || resource.type !== "Opaque" ||
      (hasOwn(resource, "immutable") && resource.immutable !== false) ||
      !isRecord(resource.metadata) ||
      Object.keys(resource.metadata).some(key => !SECRET_METADATA_KEYS.has(key)) ||
      resource.metadata.name !== profile.projected_resources.secret ||
      resource.metadata.namespace !== namespace ||
      (hasOwn(resource.metadata, "creationTimestamp") &&
        !["string", "object"].includes(typeof resource.metadata.creationTimestamp)) ||
      (hasOwn(resource.metadata, "managedFields") &&
        !Array.isArray(resource.metadata.managedFields))) {
    fail("baseline_secret_metadata_invalid");
  }
  const annotations = resource.metadata.annotations;
  if (annotations !== undefined && (!isRecord(annotations) ||
      Object.keys(annotations).some(key => key !== LEGACY_LAST_APPLIED_ANNOTATION))) {
    fail("baseline_secret_metadata_invalid");
  }
  const legacyValue = annotations?.[LEGACY_LAST_APPLIED_ANNOTATION];
  if (legacyValue !== undefined) {
    if (typeof legacyValue !== "string") fail("baseline_secret_last_applied_invalid");
    validateLegacyLastApplied(legacyValue, liveValues, namespace, profile);
  }
  return legacyValue !== undefined;
}

function sanitizeProjectedSecretMetadata(resource) {
  const projected = clone(resource);
  delete projected.metadata.managedFields;
  const annotations = projected.metadata.annotations;
  if (isRecord(annotations)) {
    delete annotations[LEGACY_LAST_APPLIED_ANNOTATION];
    if (Object.keys(annotations).length === 0) delete projected.metadata.annotations;
  }
  return projected;
}

function normalizePrivateKey(value) {
  return value
    .replace(/\\+r\\+n/gu, "\n")
    .replace(/\\+n/gu, "\n")
    .replace(/\r\n/gu, "\n")
    .trim();
}

function runtimePrivateKey(value) {
  return normalizePrivateKey(value).replace(/\n/gu, "\\\\n");
}

function derivePermsMaterial(value, codePrefix) {
  let privateKey;
  let publicKey;
  try {
    privateKey = createPrivateKey(normalizePrivateKey(value));
    publicKey = createPublicKey(privateKey);
  } catch (_error) {
    fail(`${codePrefix}_perms_key_invalid`);
  }
  if (privateKey.asymmetricKeyType !== "rsa" || publicKey.asymmetricKeyType !== "rsa") {
    fail(`${codePrefix}_perms_key_not_rsa`);
  }
  const details = privateKey.asymmetricKeyDetails;
  if (!details || Number(details.modulusLength || 0) < 2048) {
    fail(`${codePrefix}_perms_key_too_small`);
  }
  const jwk = publicKey.export({ format: "jwk" });
  if (!exactKeys(jwk, ["kty", "n", "e"]) || jwk.kty !== "RSA") {
    fail(`${codePrefix}_perms_public_jwk_invalid`);
  }
  const spki = publicKey.export({ type: "spki", format: "der" });
  return {
    jwtSecret: JSON.stringify({ kty: jwk.kty, n: jwk.n, e: jwk.e }),
    publicKeySha256: sha256(spki)
  };
}

function validateDatabaseUri(value, values, contract, code) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_error) {
    fail(code);
  }
  let username;
  let password;
  let database;
  try {
    username = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
    database = decodeURIComponent(parsed.pathname.slice(1));
  } catch (_error) {
    fail(code);
  }
  const expectedHost = hasOwn(contract, "host_value_key")
    ? values[contract.host_value_key]
    : contract.host_literal;
  if (parsed.protocol !== "postgres:" || username !== values.DB_USER ||
      password !== values.DB_PASS || parsed.hostname !== expectedHost ||
      parsed.port !== contract.port || database !== values.DB_NAME ||
      parsed.search || parsed.hash) {
    fail(code);
  }
}

function materializeSnapshotValues(snapshot, profile, codePrefix) {
  if (!isRecord(snapshot)) fail(`${codePrefix}_values_invalid`);
  const values = {};
  for (const key of profile.secret_keys) {
    if (profile.derived_secret_keys.includes(key)) continue;
    values[key] = requireString(
      snapshot[key],
      `${codePrefix}_secret_value_invalid`,
      { allowEmpty: profile.rotate_if_configured_secret_keys.includes(key) }
    );
  }
  validateDatabaseUri(
    values.PGRST_DB_URI,
    values,
    profile.database_uri_contracts.PGRST_DB_URI,
    `${codePrefix}_pgrst_db_uri_invalid`
  );
  validateDatabaseUri(
    values.PSQL,
    values,
    profile.database_uri_contracts.PSQL,
    `${codePrefix}_psql_invalid`
  );
  const perms = derivePermsMaterial(values.PERMS_KEY, codePrefix);
  values.PERMS_KEY = runtimePrivateKey(values.PERMS_KEY);
  values.PGRST_JWT_SECRET = perms.jwtSecret;
  if (hasOwn(snapshot, "PGRST_JWT_SECRET") &&
      !safeEqual(snapshot.PGRST_JWT_SECRET, values.PGRST_JWT_SECRET)) {
    fail(`${codePrefix}_derived_secret_mismatch`);
  }
  return { values, perms };
}

function assertSnapshotKeyset(snapshot, profile, codePrefix) {
  if (!isRecord(snapshot)) fail(`${codePrefix}_values_invalid`);
  const required = new Set([
    profile.namespace_value_key,
    ...profile.secret_keys.filter(key => !profile.derived_secret_keys.includes(key)),
    ...new Set(profile.image_pairs.map(pair => pair.value_key))
  ]);
  const allowed = new Set([...required, ...profile.derived_secret_keys]);
  const actual = Object.keys(snapshot);
  if (actual.length < required.size || actual.length > allowed.size ||
      [...required].some(key => !hasOwn(snapshot, key)) ||
      actual.some(key => !allowed.has(key))) {
    fail(`${codePrefix}_values_keyset_invalid`);
  }
}

function assertLiveSecretMatchesSnapshot(liveValues, snapshotValues, profile) {
  for (const key of profile.secret_keys) {
    if (!safeEqual(liveValues[key], snapshotValues[key])) {
      fail("baseline_secret_snapshot_mismatch");
    }
  }
}

function assertRotation(oldValues, newValues, profile) {
  for (const key of profile.invariant_secret_keys) {
    if (!safeEqual(oldValues[key], newValues[key])) fail("invariant_secret_value_changed");
  }
  for (const key of profile.required_rotated_secret_keys) {
    if (!oldValues[key] || !newValues[key] || safeEqual(oldValues[key], newValues[key])) {
      fail("required_secret_not_rotated");
    }
  }
  for (const key of profile.rotate_if_configured_secret_keys) {
    if (Boolean(oldValues[key]) !== Boolean(newValues[key])) {
      fail("configured_secret_presence_changed");
    }
    if (oldValues[key] && safeEqual(oldValues[key], newValues[key])) {
      fail("configured_secret_not_rotated");
    }
  }
}

function encodeProjectedSecret(resource, targetValues, encoding) {
  const projected = clone(resource);
  if (encoding === "stringData") {
    projected.stringData = Object.fromEntries(
      Object.keys(targetValues).sort().map(key => [key, targetValues[key]])
    );
    delete projected.data;
  } else {
    projected.data = Object.fromEntries(
      Object.keys(targetValues).sort().map(key => [
        key,
        Buffer.from(targetValues[key], "utf8").toString("base64")
      ])
    );
    delete projected.stringData;
  }
  return projected;
}

function valueRepresentations(value) {
  const normalized = value
    .replace(/\\+r\\+n/gu, "\n")
    .replace(/\\+n/gu, "\n");
  const escaped = normalized.replace(/\n/gu, "\\n");
  return [...new Set([value, normalized, escaped])].filter(candidate => candidate.length > 0);
}

function retConfigPlaceholderCounts(value) {
  const counts = {};
  for (const match of value.matchAll(/<([A-Z][A-Z0-9_]*)>/gu)) {
    counts[match[1]] = (counts[match[1]] || 0) + 1;
  }
  return counts;
}

function validateRetConfig(resource, oldValues, newValues, profile) {
  if (!isRecord(resource.data) || hasOwn(resource, "binaryData") ||
      !exactKeys(resource.data, [profile.ret_config_data_key]) ||
      typeof resource.data[profile.ret_config_data_key] !== "string") {
    fail("baseline_ret_config_invalid");
  }
  const text = resource.data[profile.ret_config_data_key];
  const placeholders = retConfigPlaceholderCounts(text);
  if (canonicalJson(placeholders) !== canonicalJson(profile.ret_config_placeholder_counts)) {
    fail("ret_config_placeholder_inventory_invalid");
  }
  for (const values of [oldValues, newValues]) {
    for (const key of profile.ret_config_forbidden_value_keys) {
      for (const representation of valueRepresentations(values[key])) {
        if (text.includes(representation)) fail("ret_config_contains_rendered_secret");
      }
    }
  }
  return {
    dataKey: profile.ret_config_data_key,
    dataSha256: sha256(Buffer.from(text, "utf8")),
    placeholderCounts: clone(placeholders)
  };
}

function deploymentContainers(deployment) {
  const podSpec = deployment?.spec?.template?.spec;
  const containers = podSpec?.containers;
  if (!Array.isArray(containers) || containers.length === 0 ||
      (Array.isArray(podSpec.initContainers) && podSpec.initContainers.length > 0) ||
      (Array.isArray(podSpec.ephemeralContainers) && podSpec.ephemeralContainers.length > 0)) {
    fail("baseline_deployment_containers_invalid");
  }
  return containers;
}

function assertSecretEnvBindings(resources, profile) {
  const actual = [];
  for (const deployment of resources.filter(resource => resource.kind === "Deployment")) {
    for (const container of deploymentContainers(deployment)) {
      if (Array.isArray(container.envFrom) && container.envFrom.some(entry =>
        isRecord(entry?.secretRef))) {
        fail("baseline_secret_env_inventory_invalid");
      }
      const names = new Set();
      for (const entry of container.env || []) {
        if (!isRecord(entry) || typeof entry.name !== "string" || names.has(entry.name)) {
          fail("baseline_deployment_env_invalid");
        }
        names.add(entry.name);
        const reference = entry?.valueFrom?.secretKeyRef;
        if (reference === undefined) continue;
        if (!exactKeys(entry.valueFrom, ["secretKeyRef"]) ||
            !exactKeys(reference, ["name", "key"]) || reference.name !== "configs" ||
            typeof reference.key !== "string") {
          fail("baseline_secret_env_inventory_invalid");
        }
        actual.push({
          deployment: deployment.metadata.name,
          container: container.name,
          env: entry.name,
          key: reference.key
        });
      }
    }
  }
  const sortBindings = bindings => bindings
    .map(binding => canonicalJson(binding))
    .sort();
  if (canonicalJson(sortBindings(actual)) !==
      canonicalJson(sortBindings(profile.secret_env_bindings))) {
    fail("baseline_secret_env_inventory_invalid");
  }
}

function annotationKeys(resource) {
  return [
    ...Object.keys(resource?.metadata?.annotations || {}),
    ...Object.keys(resource?.spec?.template?.metadata?.annotations || {})
  ];
}

function envEntries(deployment) {
  return deploymentContainers(deployment).flatMap(container =>
    Array.isArray(container.env) ? container.env : []
  );
}

function assertNoForbiddenMarkers(resources, profile) {
  const forbiddenNames = new Set(profile.forbidden.resource_names);
  const forbiddenAnnotations = new Set(profile.forbidden.annotation_keys);
  const forbiddenDomains = new Set(profile.forbidden.secret_domain_keys);
  for (const resource of resources) {
    resourceIdentity(resource);
    if (forbiddenNames.has(resource.metadata.name) ||
        forbiddenNames.has(resource.metadata.namespace || "") ||
        annotationKeys(resource).some(key => forbiddenAnnotations.has(key))) {
      fail("aud075_resource_or_annotation_forbidden");
    }
    if (resource.kind !== "Deployment") continue;
    for (const entry of envEntries(resource)) {
      const referenceKey = entry?.valueFrom?.secretKeyRef?.key;
      const envName = entry?.name;
      if (forbiddenDomains.has(referenceKey) || forbiddenDomains.has(envName) ||
          [...forbiddenDomains].some(key => envName === `turkeyCfg_${key}`)) {
        fail("aud075_secret_domain_forbidden");
      }
    }
  }
}

function assertProcessLocalParent(resources, profile) {
  const parents = resources.filter(resource =>
    resource.kind === "Deployment" && resource.metadata.name === "bot-orchestrator"
  );
  if (parents.length !== 1) fail("process_local_parent_missing");
  const podSpec = parents[0]?.spec?.template?.spec;
  if (!isRecord(podSpec) || ![undefined, "", "default"].includes(podSpec.serviceAccountName) ||
      podSpec.automountServiceAccountToken !== false) {
    fail("process_local_parent_authority_invalid");
  }
  const forbiddenEnv = new Set(profile.forbidden.bot_orchestrator_env_names);
  if (envEntries(parents[0]).some(entry => forbiddenEnv.has(entry?.name))) {
    fail("aud075_parent_binding_forbidden");
  }
}

function assertProcessLocalBoundary(resources, profile) {
  assertNoForbiddenMarkers(resources, profile);
  assertProcessLocalParent(resources, profile);
}

function requireLiveMetadata(resource, code) {
  if (!isRecord(resource.metadata) ||
      typeof resource.metadata.uid !== "string" || resource.metadata.uid.length === 0 ||
      typeof resource.metadata.resourceVersion !== "string" ||
      resource.metadata.resourceVersion.length === 0) {
    fail(code);
  }
}

function resourceBinding(resource) {
  requireLiveMetadata(resource, "baseline_resource_binding_invalid");
  return {
    ...displayIdentity(resource),
    uid: resource.metadata.uid,
    resourceVersion: resource.metadata.resourceVersion
  };
}

function collectImageInventory(resources, oldValues, newValues, namespace, profile) {
  const expectedPairs = new Set(
    profile.image_pairs.map(pair => `${pair.deployment}/${pair.container}`)
  );
  const deployments = resources.filter(resource => resource.kind === "Deployment");
  const actualPairs = new Set();
  for (const deployment of deployments) {
    requireLiveMetadata(deployment, "baseline_resource_binding_invalid");
    if (deployment.apiVersion !== "apps/v1" || deployment.metadata.namespace !== namespace) {
      fail("baseline_image_inventory_invalid");
    }
    for (const container of deploymentContainers(deployment)) {
      actualPairs.add(`${deployment.metadata.name}/${container.name}`);
    }
  }
  if (!sameStringSet([...actualPairs], [...expectedPairs])) {
    fail("baseline_image_inventory_invalid");
  }
  const images = {};
  for (const pair of profile.image_pairs) {
    const candidates = deployments.filter(resource => resource.metadata.name === pair.deployment);
    if (candidates.length !== 1) fail("baseline_image_deployment_invalid");
    const containers = deploymentContainers(candidates[0])
      .filter(container => container.name === pair.container);
    if (containers.length !== 1 || typeof containers[0].image !== "string") {
      fail("baseline_image_container_invalid");
    }
    const image = containers[0].image;
    const match = image.match(DIGEST_IMAGE);
    if (!match || !pair.repositories.includes(match[1])) {
      fail("baseline_image_not_trusted_digest");
    }
    const oldSelected = requireString(
      oldValues[pair.value_key], "old_image_override_invalid"
    );
    const newSelected = requireString(
      newValues[pair.value_key], "new_image_override_invalid"
    );
    if (!safeEqual(oldSelected, image)) fail("old_image_override_changed");
    if (!safeEqual(newSelected, image)) fail("new_image_override_changed");
    images[`${pair.deployment}/${pair.container}`] = image;
  }
  return images;
}

function databaseChecksum(values) {
  return sha256(JSON.stringify({
    DB_USER: values.DB_USER,
    DB_PASS: values.DB_PASS,
    DB_NAME: values.DB_NAME,
    DB_HOST: values.DB_HOST,
    DB_HOST_T: values.DB_HOST_T,
    PGRST_DB_URI: values.PGRST_DB_URI,
    PSQL: values.PSQL
  }));
}

function templateAnnotations(deployment) {
  const value = deployment?.spec?.template?.metadata?.annotations;
  if (value !== undefined && !isRecord(value)) fail("baseline_deployment_annotations_invalid");
  return value || {};
}

function assertExistingAnnotationState(resources, namespace, oldValues, oldPerms, profile) {
  const oldChecksums = {
    database: databaseChecksum(oldValues),
    bot: sha256(oldValues.BOT_ACCESS_KEY),
    perms: oldPerms.publicKeySha256
  };
  for (const name of profile.required_deployments) {
    const deployment = findExactResource(
      resources, "apps/v1", "Deployment", namespace, name,
      "baseline_consumer_deployment_missing"
    );
    const annotations = templateAnnotations(deployment);
    const expected = [
      [profile.annotations.database_checksum, profile.db_checksum_deployments, oldChecksums.database, true],
      [profile.annotations.bot_access_key_checksum, profile.bot_access_checksum_deployments, oldChecksums.bot, true],
      [profile.annotations.perms_public_key_sha256, profile.perms_fingerprint_deployments, oldChecksums.perms, false]
    ];
    for (const [annotation, targets, value, required] of expected) {
      if (targets.includes(name)) {
        if (required && !hasOwn(annotations, annotation)) {
          fail("baseline_rotation_annotation_missing");
        }
        if (hasOwn(annotations, annotation) && !safeEqual(annotations[annotation], value)) {
          fail("baseline_rotation_annotation_mismatch");
        }
      } else if (hasOwn(annotations, annotation)) {
        fail("baseline_rotation_annotation_scope_invalid");
      }
    }
    const revisionKey = profile.annotations.credential_revision;
    if (profile.rotation_revision_deployments.includes(name)) {
      if (hasOwn(annotations, revisionKey) && !ROTATION_REVISION.test(annotations[revisionKey])) {
        fail("baseline_rotation_revision_invalid");
      }
    } else if (hasOwn(annotations, revisionKey)) {
      fail("baseline_rotation_annotation_scope_invalid");
    }
  }
}

function assertConsumersQuiesced(resources, namespace, profile) {
  for (const name of profile.rotation_revision_deployments) {
    const deployment = findExactResource(
      resources, "apps/v1", "Deployment", namespace, name,
      "baseline_consumer_deployment_missing"
    );
    if (deployment.spec?.replicas !== 0) fail("rotation_consumer_not_quiesced");
  }
}

function buildDesiredDeploymentAnnotations(targetValues, perms, rotationRevision, profile) {
  const checksums = {
    database: databaseChecksum(targetValues),
    bot: sha256(targetValues.BOT_ACCESS_KEY),
    perms: perms.publicKeySha256
  };
  const desired = {};
  for (const name of profile.rotation_revision_deployments) {
    desired[name] = {
      [profile.annotations.credential_revision]: rotationRevision
    };
    if (profile.db_checksum_deployments.includes(name)) {
      desired[name][profile.annotations.database_checksum] = checksums.database;
    }
    if (profile.bot_access_checksum_deployments.includes(name)) {
      desired[name][profile.annotations.bot_access_key_checksum] = checksums.bot;
    }
    if (profile.perms_fingerprint_deployments.includes(name)) {
      desired[name][profile.annotations.perms_public_key_sha256] = checksums.perms;
    }
  }
  return { desired, checksums };
}

function projectedIdentitySet(namespace, profile) {
  return new Set([
    `v1\u0000Secret\u0000${namespace}\u0000${profile.projected_resources.secret}`
  ]);
}

function buildLiveResourceBindings(secret, configMap, resources, namespace, profile) {
  const bindings = [resourceBinding(secret), resourceBinding(configMap)];
  for (const name of profile.required_deployments) {
    bindings.push(resourceBinding(findExactResource(
      resources, "apps/v1", "Deployment", namespace, name,
      "baseline_consumer_deployment_missing"
    )));
  }
  return bindings.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function buildBundle({ baselineResources, oldValues, newValues, rotationRevision, profile }) {
  const checkedProfile = validateProfile(profile);
  const oldNamespace = requireString(
    oldValues?.[checkedProfile.namespace_value_key], "old_namespace_invalid"
  );
  const namespace = requireString(
    newValues?.[checkedProfile.namespace_value_key], "new_namespace_invalid"
  );
  if (!DNS_LABEL.test(oldNamespace) || !DNS_LABEL.test(namespace) ||
      !safeEqual(oldNamespace, namespace)) {
    fail("snapshot_namespace_mismatch");
  }
  assertSnapshotKeyset(oldValues, checkedProfile, "old");
  assertSnapshotKeyset(newValues, checkedProfile, "new");
  if (typeof rotationRevision !== "string" || !ROTATION_REVISION.test(rotationRevision)) {
    fail("rotation_revision_invalid");
  }
  indexResources(baselineResources);
  assertProcessLocalBoundary(baselineResources, checkedProfile);
  assertBaselineResourceInventory(baselineResources, namespace, checkedProfile);
  assertSecretEnvBindings(baselineResources, checkedProfile);
  const images = collectImageInventory(
    baselineResources, oldValues, newValues, namespace, checkedProfile
  );
  assertConsumersQuiesced(baselineResources, namespace, checkedProfile);

  const baselineSecret = findExactResource(
    baselineResources, "v1", "Secret", namespace,
    checkedProfile.projected_resources.secret, "baseline_configs_secret_missing"
  );
  const baselineConfigMap = findExactResource(
    baselineResources, "v1", "ConfigMap", namespace,
    checkedProfile.bound_resources.config_map, "baseline_ret_config_missing"
  );
  requireLiveMetadata(baselineSecret, "baseline_resource_binding_invalid");
  requireLiveMetadata(baselineConfigMap, "baseline_resource_binding_invalid");
  const liveSecret = readSecret(baselineSecret, checkedProfile);
  const oldSnapshot = materializeSnapshotValues(oldValues, checkedProfile, "old");
  assertLiveSecretMatchesSnapshot(liveSecret.values, oldSnapshot.values, checkedProfile);
  const legacyLastAppliedRemoved = validateSecretMetadata(
    baselineSecret, liveSecret.values, namespace, checkedProfile
  );
  const newSnapshot = materializeSnapshotValues(newValues, checkedProfile, "new");
  assertRotation(oldSnapshot.values, newSnapshot.values, checkedProfile);
  const retConfig = validateRetConfig(
    baselineConfigMap, oldSnapshot.values, newSnapshot.values, checkedProfile
  );
  assertExistingAnnotationState(
    baselineResources, namespace, oldSnapshot.values, oldSnapshot.perms, checkedProfile
  );

  const secret = sanitizeProjectedSecretMetadata(encodeProjectedSecret(
    baselineSecret, newSnapshot.values, liveSecret.encoding
  ));
  const resources = [secret];
  const actualIdentities = new Set(resources.map(resourceIdentity));
  const expectedIdentities = projectedIdentitySet(namespace, checkedProfile);
  if (!sameStringSet([...actualIdentities], [...expectedIdentities])) {
    fail("projected_resource_inventory_invalid");
  }
  assertNoForbiddenMarkers(resources, checkedProfile);
  const annotations = buildDesiredDeploymentAnnotations(
    newSnapshot.values, newSnapshot.perms, rotationRevision, checkedProfile
  );
  return {
    schemaVersion: 1,
    profileId: checkedProfile.profile_id,
    runnerMode: "process-local",
    rotationRevision,
    resources,
    contract: {
      namespace,
      resourceIdentities: resources.map(displayIdentity),
      liveResourceBindings: buildLiveResourceBindings(
        baselineSecret, baselineConfigMap, baselineResources, namespace, checkedProfile
      ),
      deploymentInputNames: clone(checkedProfile.required_deployments),
      imagePairs: images,
      desiredDeploymentAnnotations: annotations.desired,
      allowedDeploymentAnnotationKeys: Object.values(checkedProfile.annotations).sort(),
      workloadChanges: [],
      specInvariant: true,
      configMapInvariant: true,
      legacyLastAppliedRemoved,
      databaseCredentialChecksum: annotations.checksums.database,
      botAccessKeyChecksum: annotations.checksums.bot,
      permsPublicKeySha256: annotations.checksums.perms,
      retConfigBinding: {
        ...resourceBinding(baselineConfigMap),
        dataKey: retConfig.dataKey,
        dataSha256: retConfig.dataSha256,
        placeholderCounts: retConfig.placeholderCounts
      },
      secretEnvBindings: clone(checkedProfile.secret_env_bindings),
      forbiddenAud075MarkersAbsent: true
    }
  };
}

export function createProcessLocalRotationBundle({
  baselineResources,
  oldValues,
  newValues,
  rotationRevision,
  profile = loadProcessLocalRotationProfile()
}) {
  return buildBundle({ baselineResources, oldValues, newValues, rotationRevision, profile });
}

export function verifyProcessLocalRotationBundle({
  baselineResources,
  oldValues,
  newValues,
  rotationRevision,
  bundle,
  profile = loadProcessLocalRotationProfile()
}) {
  const expected = buildBundle({
    baselineResources, oldValues, newValues, rotationRevision, profile
  });
  if (!isRecord(bundle) || canonicalJson(bundle) !== canonicalJson(expected)) {
    fail("rotation_bundle_contract_mismatch");
  }
  return true;
}

function validateBundleShape(bundle, profile) {
  if (!isRecord(bundle) || bundle.schemaVersion !== 1 ||
      bundle.profileId !== profile.profile_id || bundle.runnerMode !== "process-local" ||
      !ROTATION_REVISION.test(bundle.rotationRevision || "") ||
      !Array.isArray(bundle.resources) || !isRecord(bundle.contract) ||
      bundle.contract.specInvariant !== true || bundle.contract.configMapInvariant !== true ||
      typeof bundle.contract.legacyLastAppliedRemoved !== "boolean" ||
      canonicalJson(bundle.contract.workloadChanges) !== "[]" ||
      !HEX_SHA256.test(bundle.contract.databaseCredentialChecksum || "") ||
      !HEX_SHA256.test(bundle.contract.botAccessKeyChecksum || "") ||
      !HEX_SHA256.test(bundle.contract.permsPublicKeySha256 || "")) {
    fail("rotation_bundle_contract_mismatch");
  }
  const namespace = bundle.contract.namespace;
  if (typeof namespace !== "string" || !DNS_LABEL.test(namespace)) {
    fail("rotation_bundle_contract_mismatch");
  }
  const identities = new Set(bundle.resources.map(resourceIdentity));
  if (!sameStringSet([...identities], [...projectedIdentitySet(namespace, profile)]) ||
      bundle.resources.length !== 1 ||
      !sameStringSet(bundle.contract.deploymentInputNames, profile.required_deployments) ||
      canonicalJson(bundle.contract.secretEnvBindings) !==
        canonicalJson(profile.secret_env_bindings) ||
      !sameStringSet(
        bundle.contract.allowedDeploymentAnnotationKeys,
        Object.values(profile.annotations)
      )) {
    fail("rotation_bundle_contract_mismatch");
  }
  const projectedSecret = bundle.resources[0];
  if (hasOwn(projectedSecret.metadata, "managedFields") ||
      hasOwn(
        projectedSecret.metadata.annotations || {}, LEGACY_LAST_APPLIED_ANNOTATION
      )) {
    fail("rotation_bundle_contract_mismatch");
  }
  const desired = bundle.contract.desiredDeploymentAnnotations;
  if (!isRecord(desired) ||
      !sameStringSet(Object.keys(desired), profile.rotation_revision_deployments)) {
    fail("rotation_bundle_contract_mismatch");
  }
  for (const name of profile.rotation_revision_deployments) {
    const expected = {
      [profile.annotations.credential_revision]: bundle.rotationRevision
    };
    if (profile.db_checksum_deployments.includes(name)) {
      expected[profile.annotations.database_checksum] =
        bundle.contract.databaseCredentialChecksum;
    }
    if (profile.bot_access_checksum_deployments.includes(name)) {
      expected[profile.annotations.bot_access_key_checksum] =
        bundle.contract.botAccessKeyChecksum;
    }
    if (profile.perms_fingerprint_deployments.includes(name)) {
      expected[profile.annotations.perms_public_key_sha256] =
        bundle.contract.permsPublicKeySha256;
    }
    if (canonicalJson(desired[name]) !== canonicalJson(expected)) {
      fail("rotation_bundle_contract_mismatch");
    }
  }
  const bindings = bundle.contract.liveResourceBindings;
  if (!Array.isArray(bindings) || bindings.length !== 14) {
    fail("rotation_bundle_contract_mismatch");
  }
  const bindingIdentities = new Set();
  for (const binding of bindings) {
    if (!exactKeys(binding, [
      "apiVersion", "kind", "namespace", "name", "uid", "resourceVersion"
    ]) || typeof binding.uid !== "string" || !binding.uid ||
        typeof binding.resourceVersion !== "string" || !binding.resourceVersion) {
      fail("rotation_bundle_contract_mismatch");
    }
    const identity = `${binding.apiVersion}\u0000${binding.kind}\u0000${binding.namespace || ""}\u0000${binding.name}`;
    if (bindingIdentities.has(identity)) fail("rotation_bundle_contract_mismatch");
    bindingIdentities.add(identity);
  }
  const expectedBindings = new Set([
    `v1\u0000Secret\u0000${namespace}\u0000${profile.projected_resources.secret}`,
    `v1\u0000ConfigMap\u0000${namespace}\u0000${profile.bound_resources.config_map}`,
    ...profile.required_deployments.map(name =>
      `apps/v1\u0000Deployment\u0000${namespace}\u0000${name}`)
  ]);
  if (!sameStringSet([...bindingIdentities], [...expectedBindings])) {
    fail("rotation_bundle_contract_mismatch");
  }
  const retConfig = bundle.contract.retConfigBinding;
  if (!isRecord(retConfig) || !exactKeys(retConfig, [
    "apiVersion", "kind", "namespace", "name", "uid", "resourceVersion",
    "dataKey", "dataSha256", "placeholderCounts"
  ]) || retConfig.apiVersion !== "v1" || retConfig.kind !== "ConfigMap" ||
      retConfig.namespace !== namespace || retConfig.name !== profile.bound_resources.config_map ||
      retConfig.dataKey !== profile.ret_config_data_key ||
      !HEX_SHA256.test(retConfig.dataSha256 || "") ||
      canonicalJson(retConfig.placeholderCounts) !==
        canonicalJson(profile.ret_config_placeholder_counts)) {
    fail("rotation_bundle_contract_mismatch");
  }
  const retConfigBinding = bindings.find(binding =>
    binding.apiVersion === "v1" && binding.kind === "ConfigMap" &&
    binding.namespace === namespace && binding.name === profile.bound_resources.config_map
  );
  if (!retConfigBinding || !safeEqual(retConfig.uid, retConfigBinding.uid) ||
      !safeEqual(retConfig.resourceVersion, retConfigBinding.resourceVersion)) {
    fail("rotation_bundle_contract_mismatch");
  }
  const expectedImagePairs = profile.image_pairs.map(pair =>
    `${pair.deployment}/${pair.container}`
  );
  if (!isRecord(bundle.contract.imagePairs) ||
      !sameStringSet(Object.keys(bundle.contract.imagePairs), expectedImagePairs) ||
      Object.values(bundle.contract.imagePairs).some(image => !DIGEST_IMAGE.test(image))) {
    fail("rotation_bundle_contract_mismatch");
  }
}

function bindingFor(bundle, resource) {
  const identity = resourceIdentity(resource);
  const binding = bundle.contract.liveResourceBindings.find(candidate =>
    `${candidate.apiVersion}\u0000${candidate.kind}\u0000${candidate.namespace || ""}\u0000${candidate.name}` === identity
  );
  if (!binding || !safeEqual(binding.uid, resource.metadata.uid) ||
      !safeEqual(binding.resourceVersion, resource.metadata.resourceVersion)) {
    fail("live_resource_binding_mismatch");
  }
  return binding;
}

function stripManagedTemplateAnnotations(resource, annotationKeysToStrip) {
  const result = clone(resource);
  const annotations = result?.spec?.template?.metadata?.annotations;
  if (isRecord(annotations)) {
    for (const key of annotationKeysToStrip) delete annotations[key];
    if (Object.keys(annotations).length === 0) {
      delete result.spec.template.metadata.annotations;
    }
  }
  return result;
}

function assertDeploymentImagesMatchBundle(deployment, bundle, profile) {
  const expectedPairs = profile.image_pairs.filter(pair =>
    pair.deployment === deployment.metadata.name
  );
  const containers = deploymentContainers(deployment);
  if (containers.length !== expectedPairs.length) fail("live_deployment_image_mismatch");
  for (const pair of expectedPairs) {
    const matches = containers.filter(container => container.name === pair.container);
    const expectedImage = bundle.contract.imagePairs[`${pair.deployment}/${pair.container}`];
    if (matches.length !== 1 || !safeEqual(matches[0].image, expectedImage)) {
      fail("live_deployment_image_mismatch");
    }
  }
}

export function applyProcessLocalRotationAnnotations({
  deployment,
  bundle,
  profile = loadProcessLocalRotationProfile()
}) {
  const checkedProfile = validateProfile(profile);
  validateBundleShape(bundle, checkedProfile);
  if (!isRecord(deployment) || deployment.apiVersion !== "apps/v1" ||
      deployment.kind !== "Deployment" ||
      deployment.metadata?.namespace !== bundle.contract.namespace ||
      !checkedProfile.rotation_revision_deployments.includes(deployment.metadata?.name)) {
    fail("live_deployment_not_rotation_target");
  }
  requireLiveMetadata(deployment, "live_resource_binding_invalid");
  bindingFor(bundle, deployment);
  assertNoForbiddenMarkers([deployment], checkedProfile);
  if (deployment.metadata.name === "bot-orchestrator") {
    assertProcessLocalParent([deployment], checkedProfile);
  }
  if (deployment.spec?.replicas !== 0) fail("live_deployment_not_quiesced");
  if (!isRecord(deployment.spec?.template?.metadata)) {
    fail("live_deployment_template_metadata_invalid");
  }
  templateAnnotations(deployment);
  assertDeploymentImagesMatchBundle(deployment, bundle, checkedProfile);
  const projected = clone(deployment);
  projected.spec.template.metadata.annotations ??= {};
  Object.assign(
    projected.spec.template.metadata.annotations,
    bundle.contract.desiredDeploymentAnnotations[deployment.metadata.name]
  );
  const managedKeys = bundle.contract.allowedDeploymentAnnotationKeys;
  if (canonicalJson(stripManagedTemplateAnnotations(deployment, managedKeys)) !==
      canonicalJson(stripManagedTemplateAnnotations(projected, managedKeys))) {
    fail("projected_deployment_changed_outside_annotations");
  }
  if (!safeEqual(projected.metadata.uid, deployment.metadata.uid) ||
      !safeEqual(projected.metadata.resourceVersion, deployment.metadata.resourceVersion) ||
      projected.spec.replicas !== 0) {
    fail("projected_deployment_binding_changed");
  }
  return projected;
}

export function projectProcessLocalRotationReplacement({
  baselineResource,
  bundle,
  profile = loadProcessLocalRotationProfile()
}) {
  const checkedProfile = validateProfile(profile);
  const bundleSnapshot = snapshotReentryValue(bundle);
  const baseline = snapshotReentryValue(baselineResource);
  validateBundleShape(bundleSnapshot, checkedProfile);
  const namespace = bundleSnapshot.contract.namespace;
  const targets = reentryTargetIdentities(namespace, checkedProfile);
  let identity;
  try {
    identity = resourceIdentity(baseline);
  } catch (_error) {
    fail("rotation_replacement_resource_invalid");
  }
  const target = targets.find(candidate => reentryIdentity(candidate) === identity);
  if (!target) fail("rotation_replacement_resource_invalid");
  const binding = reentryBinding(bundleSnapshot, target);
  assertReentryMetadata(baseline, binding);
  if (!safeEqual(baseline.metadata.resourceVersion, binding.resourceVersion)) {
    fail("rotation_reentry_baseline_binding_invalid");
  }
  let replacement;
  if (target.kind === "Secret") {
    const candidates = bundleSnapshot.resources.filter(resource =>
      resourceIdentity(resource) === identity
    );
    if (candidates.length !== 1) fail("rotation_reentry_candidate_inventory_invalid");
    replacement = clone(candidates[0]);
    assertFinalReentrySecret(replacement, namespace, checkedProfile);
  } else {
    replacement = applyProcessLocalRotationAnnotations({
      deployment: baseline,
      bundle: bundleSnapshot,
      profile: checkedProfile
    });
  }
  delete replacement.status;
  delete replacement.metadata.managedFields;
  delete replacement.metadata.generation;
  assertReentryMetadata(replacement, binding);
  if (!safeEqual(replacement.metadata.resourceVersion, binding.resourceVersion)) {
    fail("rotation_reentry_candidate_binding_invalid");
  }
  return replacement;
}

function snapshotReentryValue(value) {
  try {
    return structuredClone(value);
  } catch (_error) {
    fail("rotation_reentry_input_invalid");
  }
}

function reentryTargetIdentities(namespace, profile) {
  return [
    {
      apiVersion: "v1",
      kind: "Secret",
      namespace,
      name: profile.projected_resources.secret
    },
    ...profile.rotation_revision_deployments.map(name => ({
      apiVersion: "apps/v1",
      kind: "Deployment",
      namespace,
      name
    }))
  ];
}

function reentryIdentity(identity) {
  return [
    identity.apiVersion,
    identity.kind,
    identity.namespace || "",
    identity.name
  ].join("\u0000");
}

function indexExactReentryResources(resources, targets, code) {
  if (!Array.isArray(resources) || resources.length !== targets.length) fail(code);
  const expected = new Set(targets.map(reentryIdentity));
  const indexed = new Map();
  for (const resource of resources) {
    let identity;
    try {
      identity = resourceIdentity(resource);
    } catch (_error) {
      fail(code);
    }
    if (!expected.has(identity) || indexed.has(identity)) fail(code);
    indexed.set(identity, resource);
  }
  if (indexed.size !== expected.size || [...expected].some(identity => !indexed.has(identity))) {
    fail(code);
  }
  return indexed;
}

function findReentryBaseline(resources, target) {
  const matches = resources.filter(resource => {
    try {
      return resourceIdentity(resource) === reentryIdentity(target);
    } catch (_error) {
      return false;
    }
  });
  if (matches.length !== 1) fail("rotation_reentry_baseline_inventory_invalid");
  return matches[0];
}

function reentryBinding(bundle, target) {
  const matches = bundle.contract.liveResourceBindings.filter(binding =>
    reentryIdentity(binding) === reentryIdentity(target)
  );
  if (matches.length !== 1) fail("rotation_reentry_binding_invalid");
  return matches[0];
}

function assertReentryMetadata(resource, binding) {
  requireLiveMetadata(resource, "rotation_reentry_resource_version_invalid");
  if (!safeEqual(resource.metadata.uid, binding.uid)) {
    fail("rotation_reentry_uid_mismatch");
  }
}

function assertFinalReentrySecret(secret, namespace, profile, { live = false } = {}) {
  const allowedMetadata = new Set([
    "creationTimestamp", "name", "namespace", "resourceVersion", "uid"
  ]);
  if (live) allowedMetadata.add("managedFields");
  if (!isRecord(secret) || secret.apiVersion !== "v1" || secret.kind !== "Secret" ||
      !Object.keys(secret).every(key => [
        "apiVersion", "kind", "metadata", "type", "immutable", "data", "stringData"
      ].includes(key)) || secret.type !== "Opaque" ||
      (hasOwn(secret, "immutable") && secret.immutable !== false) ||
      !isRecord(secret.metadata) ||
      Object.keys(secret.metadata).some(key => !allowedMetadata.has(key)) ||
      secret.metadata.name !== profile.projected_resources.secret ||
      secret.metadata.namespace !== namespace ||
      (hasOwn(secret.metadata, "managedFields") &&
        !Array.isArray(secret.metadata.managedFields))) {
    fail("rotation_reentry_secret_final_invalid");
  }
  try {
    readSecret(secret, profile);
  } catch (_error) {
    fail("rotation_reentry_secret_final_invalid");
  }
}

function metadataWithoutReentryServerFields(resource) {
  const metadata = clone(resource.metadata);
  delete metadata.resourceVersion;
  delete metadata.managedFields;
  delete metadata.generation;
  return metadata;
}

function secretValuesMatch(left, right, profile) {
  let leftValues;
  let rightValues;
  try {
    leftValues = readSecret(left, profile).values;
    rightValues = readSecret(right, profile).values;
  } catch (_error) {
    return false;
  }
  return profile.secret_keys.every(key => safeEqual(leftValues[key], rightValues[key]));
}

function secretSemanticallyMatches(live, expected, profile) {
  return live?.apiVersion === "v1" && live?.kind === "Secret" &&
    expected?.apiVersion === "v1" && expected?.kind === "Secret" &&
    (live.type ?? "Opaque") === (expected.type ?? "Opaque") &&
    (live.immutable ?? false) === (expected.immutable ?? false) &&
    canonicalJson(metadataWithoutReentryServerFields(live)) ===
      canonicalJson(metadataWithoutReentryServerFields(expected)) &&
    secretValuesMatch(live, expected, profile);
}

function assertReentrySecretEnvelope(secret, namespace, profile, code) {
  try {
    const values = readSecret(secret, profile).values;
    validateSecretMetadata(secret, values, namespace, profile);
  } catch (_error) {
    fail(code);
  }
}

function assertReentryDeploymentEnvelope(deployment, code) {
  if (!isRecord(deployment) || deployment.apiVersion !== "apps/v1" ||
      deployment.kind !== "Deployment" || !isRecord(deployment.metadata) ||
      !isRecord(deployment.spec) || !Object.keys(deployment).every(key =>
        ["apiVersion", "kind", "metadata", "spec", "status"].includes(key)) ||
      (hasOwn(deployment.metadata, "managedFields") &&
        !Array.isArray(deployment.metadata.managedFields)) ||
      !Number.isSafeInteger(deployment.metadata.generation) ||
      deployment.metadata.generation < 1) {
    fail(code);
  }
}

function deploymentSemanticallyMatches(live, expected) {
  return canonicalJson(live.spec) === canonicalJson(expected.spec) &&
    canonicalJson(metadataWithoutReentryServerFields(live)) ===
      canonicalJson(metadataWithoutReentryServerFields(expected));
}

function reentryCandidateFor({ target, baseline, bundle, profile }) {
  if (target.kind === "Deployment" && baseline.spec?.replicas !== 0) {
    fail("rotation_reentry_deployment_not_quiesced");
  }
  const projected = projectProcessLocalRotationReplacement({
    baselineResource: baseline,
    bundle,
    profile
  });
  if (target.kind === "Secret") {
    assertFinalReentrySecret(projected, target.namespace, profile);
  } else if (projected.spec?.replicas !== 0) {
    fail("rotation_reentry_deployment_not_quiesced");
  }
  return projected;
}

/**
 * Classify the exact seven resource replacements used by the process-local
 * AUD-065 rotation. This function is deliberately pure: callers supply a
 * checkpoint-bound baseline, the immutable rotation bundle and one fresh API
 * inventory; no Kubernetes or filesystem access occurs here.
 *
 * A resource is pending only while its semantic body, UID and resourceVersion
 * are the captured quiesced baseline. It is already-applied only while its
 * semantic body is the exact candidate projection, its UID is unchanged and
 * the API resourceVersion has advanced. Only Kubernetes-managed status,
 * managedFields and the expected Deployment generation increment are ignored;
 * any same-content ABA, partial projection or user-metadata drift fails closed.
 */
export function classifyProcessLocalRotationReentry({
  baselineResources,
  liveResources,
  bundle,
  profile = loadProcessLocalRotationProfile()
}) {
  const checkedProfile = validateProfile(profile);
  const baselineSnapshot = snapshotReentryValue(baselineResources);
  const liveSnapshot = snapshotReentryValue(liveResources);
  const bundleSnapshot = snapshotReentryValue(bundle);
  validateBundleShape(bundleSnapshot, checkedProfile);
  if (!Array.isArray(baselineSnapshot)) fail("rotation_reentry_baseline_inventory_invalid");

  const namespace = bundleSnapshot.contract.namespace;
  const targets = reentryTargetIdentities(namespace, checkedProfile);
  if (targets.length !== 7) fail("rotation_reentry_inventory_invalid");
  const liveIndex = indexExactReentryResources(
    liveSnapshot,
    targets,
    "rotation_reentry_inventory_invalid"
  );
  const inventory = [];
  for (const target of targets) {
    const identity = reentryIdentity(target);
    const baseline = findReentryBaseline(baselineSnapshot, target);
    const live = liveIndex.get(identity);
    const binding = reentryBinding(bundleSnapshot, target);
    assertReentryMetadata(baseline, binding);
    if (!safeEqual(baseline.metadata.resourceVersion, binding.resourceVersion)) {
      fail("rotation_reentry_baseline_binding_invalid");
    }
    assertReentryMetadata(live, binding);
    if (target.kind === "Deployment" &&
        (baseline.spec?.replicas !== 0 || live.spec?.replicas !== 0)) {
      fail("rotation_reentry_deployment_not_quiesced");
    }
    if (target.kind === "Secret") {
      assertReentrySecretEnvelope(
        baseline, namespace, checkedProfile, "rotation_reentry_baseline_secret_invalid"
      );
      assertReentrySecretEnvelope(
        live, namespace, checkedProfile, "rotation_reentry_live_secret_invalid"
      );
    } else {
      assertReentryDeploymentEnvelope(
        baseline, "rotation_reentry_baseline_deployment_invalid"
      );
      assertReentryDeploymentEnvelope(live, "rotation_reentry_live_deployment_invalid");
    }
    const candidate = reentryCandidateFor({
      target,
      baseline,
      bundle: bundleSnapshot,
      profile: checkedProfile
    });
    assertReentryMetadata(candidate, binding);
    if (!safeEqual(candidate.metadata.resourceVersion, binding.resourceVersion)) {
      fail("rotation_reentry_candidate_binding_invalid");
    }
    const pendingBodyMatches = target.kind === "Secret"
      ? secretSemanticallyMatches(live, baseline, checkedProfile)
      : live.metadata.generation === baseline.metadata.generation &&
        deploymentSemanticallyMatches(live, baseline);
    let appliedBodyMatches = false;
    if (target.kind === "Secret") {
      try {
        assertFinalReentrySecret(live, namespace, checkedProfile, { live: true });
        appliedBodyMatches = secretSemanticallyMatches(live, candidate, checkedProfile);
      } catch (error) {
        if (!(error instanceof ProcessLocalRotationError)) throw error;
      }
    } else {
      appliedBodyMatches =
        live.metadata.generation === baseline.metadata.generation + 1 &&
        deploymentSemanticallyMatches(live, candidate);
    }
    let state;
    if (safeEqual(live.metadata.resourceVersion, binding.resourceVersion) &&
        pendingBodyMatches) {
      state = "pending";
    } else if (!safeEqual(live.metadata.resourceVersion, binding.resourceVersion) &&
        appliedBodyMatches) {
      state = "already-applied";
    } else {
      fail("rotation_reentry_resource_drift");
    }
    inventory.push({
      ...target,
      uid: binding.uid,
      baselineResourceVersion: binding.resourceVersion,
      liveResourceVersion: live.metadata.resourceVersion,
      state
    });
  }
  const pendingCount = inventory.filter(resource => resource.state === "pending").length;
  return {
    schemaVersion: 1,
    resourceCount: inventory.length,
    pendingCount,
    alreadyAppliedCount: inventory.length - pendingCount,
    complete: pendingCount === 0,
    resources: inventory
  };
}

function readProjectedSecret(resource, profile) {
  return readSecret(resource, profile).values;
}

function hmacFingerprint(key, label, value) {
  return createHmac("sha256", key).update(label).update("\0").update(value).digest("hex");
}

function requireFingerprintKey(value) {
  if (!Buffer.isBuffer(value) && typeof value !== "string") {
    fail("redaction_fingerprint_key_invalid");
  }
  const key = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (key.length < 32) fail("redaction_fingerprint_key_invalid");
  return key;
}

export function redactProcessLocalRotationBundle({
  baselineResources,
  oldValues,
  newValues,
  rotationRevision,
  bundle,
  fingerprintKey,
  profile = loadProcessLocalRotationProfile()
}) {
  const checkedProfile = validateProfile(profile);
  verifyProcessLocalRotationBundle({
    baselineResources,
    oldValues,
    newValues,
    rotationRevision,
    bundle,
    profile: checkedProfile
  });
  validateBundleShape(bundle, checkedProfile);
  const key = requireFingerprintKey(fingerprintKey);
  const namespace = bundle.contract.namespace;
  const secret = findExactResource(
    bundle.resources, "v1", "Secret", namespace,
    checkedProfile.projected_resources.secret, "projected_configs_secret_missing"
  );
  const configMap = findExactResource(
    baselineResources, "v1", "ConfigMap", namespace,
    checkedProfile.bound_resources.config_map, "baseline_ret_config_missing"
  );
  const secretValues = readProjectedSecret(secret, checkedProfile);
  const secretKeys = checkedProfile.secret_keys.map(name => ({
    name,
    state: secretValues[name] === "" ? "empty" : "configured",
    fingerprint: hmacFingerprint(key, `Secret/configs/${name}`, secretValues[name])
  }));
  const configMapKeys = Object.keys(configMap.data || {}).sort().map(name => ({
    name,
    fingerprint: hmacFingerprint(key, `ConfigMap/ret-config/${name}`, configMap.data[name])
  }));
  return {
    schemaVersion: 1,
    profileId: checkedProfile.profile_id,
    runnerMode: "process-local",
    rotationRevision: bundle.rotationRevision,
    namespace,
    resources: bundle.resources.map(resource => ({
      ...displayIdentity(resource),
      action: "replace-existing"
    })),
    boundResources: bundle.contract.liveResourceBindings.map(binding => ({
      apiVersion: binding.apiVersion,
      kind: binding.kind,
      namespace: binding.namespace,
      name: binding.name,
      uidBound: true,
      resourceVersionBound: true
    })),
    secret: {
      name: checkedProfile.projected_resources.secret,
      keys: secretKeys,
      legacyLastAppliedRemoved: bundle.contract.legacyLastAppliedRemoved
    },
    placeholderConfigMap: {
      name: checkedProfile.bound_resources.config_map,
      action: "bind-existing-no-apply",
      byteInvariant: true,
      dataKeys: configMapKeys,
      placeholderCounts: clone(bundle.contract.retConfigBinding.placeholderCounts)
    },
    validatedDeploymentInputs: clone(bundle.contract.deploymentInputNames),
    desiredDeploymentAnnotationKeys: Object.fromEntries(
      Object.entries(bundle.contract.desiredDeploymentAnnotations).map(([name, annotations]) => [
        name,
        Object.keys(annotations).sort()
      ])
    ),
    workloadChanges: [],
    specInvariant: true,
    configMapInvariant: true,
    imageInventory: checkedProfile.image_pairs.map(pair => ({
      deployment: pair.deployment,
      container: pair.container,
      digestPinned: true
    })),
    checksumAttestations: {
      database: "bound",
      botAccessKey: "bound",
      permsPublicKey: "bound"
    },
    forbiddenAud075MarkersAbsent: true
  };
}

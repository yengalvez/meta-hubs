#!/usr/bin/env node

// Strict offline attestation for an AUD-065 process-local credential rotation.
// This module never builds an independently applicable manifest: it verifies
// the canonical bundle, its private binding, eight intermediate CAS responses,
// the exact 44-resource operational inventory and the operation attestation, then
// emits only names, booleans and operation-local HMACs.

import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  timingSafeEqual
} from "node:crypto";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";

import {
  ProcessLocalRotationError,
  applyProcessLocalRotationAnnotations,
  canonicalJson,
  loadProcessLocalRotationProfile,
  redactProcessLocalRotationBundle,
  verifyProcessLocalRotationBundle
} from "./process-local-rotation.mjs";
import { canonicalOperationJson } from "./process-local-rotation-operation.mjs";
import {
  verifyBotPullConfig,
  verifyBotPullConfigCredentialMatch,
  verifyBotPullConfigRotation
} from "./verify-bot-image-pull-config.mjs";

const requireFromCommunityEdition = createRequire(new URL(
  "../hubs-cloud/community-edition/package.json",
  import.meta.url
));
const YAML = requireFromCommunityEdition("yaml");

const EXPECTED_PROFILE_ID = "yenhubs-process-local-credential-rotation-v1";
// This is deliberately pinned independently from profile_id. Update it only
// with a reviewed, coherent change to the canonical process-local profile.
const EXPECTED_PROFILE_SHA256 = "8252ddb7a957950b022fdae482c6363fbc102a57a0c140022031408bc4f6ea1b";
const HISTORICAL_RESOURCE_COUNT = 42;
const OPERATIONAL_RESOURCE_COUNT = 44;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const DNS_LABEL = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/u;
const HEX_32 = /^[a-f0-9]{32}$/u;
const HEX_SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_CONTEXT = /^[A-Za-z0-9](?:[A-Za-z0-9._:@/-]{0,252})$/u;
const SAFE_UID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,252})$/u;
const CHECKPOINT_STAMP = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/u;
const HMAC_KEY_BYTES = 32;
const LEGACY_LAST_APPLIED_ANNOTATION =
  "kubectl.kubernetes.io/last-applied-configuration";
const SERVER_METADATA_FIELDS = new Set([
  "creationTimestamp",
  "generation",
  "managedFields",
  "resourceVersion",
  "selfLink",
  "uid"
]);
const CLEAN_SECRET_METADATA_FIELDS = new Set([
  "creationTimestamp",
  "name",
  "namespace",
  "resourceVersion",
  "uid"
]);
const OPERATION_INTENT_CONTRACT =
  "yenhubs-aud065-process-local-operation-intent-v1";
const OPERATION_INTENT_KEYS = Object.freeze([
  "schemaVersion",
  "contractId",
  "operationToken",
  "operationId",
  "rotationRevision",
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
  "profileSha256",
  "originalBaselineSha256",
  "oldSnapshotSha256",
  "newSnapshotSha256",
  "oldValuesSourceSha256",
  "newValuesSourceSha256",
  "operationBindingSha256",
  "hmacSha256"
]);
const AUD065_PGSQL_POLICY_NAME = "pgsql-ingress";
const AUD065_PGSQL_MARKER_LOCK_UID = "yenhubs.org/aud065-pgsql-lock-uid";
const AUD065_PGSQL_MARKER_TOKEN = "yenhubs.org/aud065-pgsql-operation-token";
const AUD065_PGSQL_MARKER_BINDING =
  "yenhubs.org/aud065-pgsql-operation-binding-sha256";
const AUD065_PGSQL_MARKER_STATE = "yenhubs.org/aud065-pgsql-barrier-state";
const AUD065_PGSQL_MARKER_SPEC_SHA =
  "yenhubs.org/aud065-pgsql-normal-spec-sha256";
const AUD065_PGSQL_MARKER_NAMES = Object.freeze([
  AUD065_PGSQL_MARKER_LOCK_UID,
  AUD065_PGSQL_MARKER_TOKEN,
  AUD065_PGSQL_MARKER_BINDING,
  AUD065_PGSQL_MARKER_STATE,
  AUD065_PGSQL_MARKER_SPEC_SHA
]);

export class RedactedRolloutError extends Error {
  constructor(code) {
    super(code);
    this.name = "RedactedRolloutError";
    this.code = code;
  }
}

function reject(code) {
  throw new RedactedRolloutError(code);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function exactKeys(value, expected) {
  return record(value) && isDeepStrictEqual(
    Object.keys(value).sort(),
    [...expected].sort()
  );
}

function validateJsonValue(value, depth = 0, seen = new Set()) {
  if (depth > 128) reject("json_structure_invalid");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) reject("json_structure_invalid");
    return;
  }
  if (!Array.isArray(value) && !record(value)) reject("json_structure_invalid");
  if (seen.has(value)) reject("json_structure_invalid");
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach(item => validateJsonValue(item, depth + 1, seen));
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (/\u0000|[\u0001-\u001f\u007f]/u.test(key)) reject("json_structure_invalid");
      validateJsonValue(item, depth + 1, seen);
    }
  }
  seen.delete(value);
}

export function parseStrictJsonSource(source, code = "json_source_invalid") {
  if (typeof source !== "string" || source.length === 0) reject(code);
  let native;
  let document;
  try {
    native = JSON.parse(source);
    document = YAML.parseDocument(source, {
      merge: false,
      prettyErrors: false,
      schema: "json",
      strict: true,
      uniqueKeys: true
    });
  } catch {
    reject(code);
  }
  if (document.errors.length > 0 || document.warnings.length > 0) reject(code);
  let strict;
  try {
    strict = document.toJS({ maxAliasCount: 0 });
  } catch {
    reject(code);
  }
  validateJsonValue(strict);
  if (!isDeepStrictEqual(native, strict)) reject(code);
  return strict;
}

export function parseResourceListSource(source, code = "resource_list_invalid") {
  const parsed = parseStrictJsonSource(source, code);
  if (!record(parsed) || parsed.apiVersion !== "v1" || parsed.kind !== "List" ||
      !Array.isArray(parsed.items) || parsed.items.length === 0 ||
      Object.keys(parsed).some(key => !["apiVersion", "kind", "metadata", "items"].includes(key))) {
    reject(code);
  }
  return parsed.items;
}

function profileDigest(profile) {
  return createHash("sha256").update(canonicalJson(profile)).digest("hex");
}

export function loadPinnedProcessLocalProfile() {
  let profile;
  try {
    profile = loadProcessLocalRotationProfile();
  } catch (error) {
    if (error instanceof ProcessLocalRotationError) {
      reject(`canonical_${error.code}`);
    }
    reject("canonical_profile_unreadable");
  }
  assertPinnedProfile(profile);
  return profile;
}

function assertPinnedProfile(profile) {
  if (profile?.profile_id !== EXPECTED_PROFILE_ID ||
      profileDigest(profile) !== EXPECTED_PROFILE_SHA256) {
    reject("canonical_profile_digest_mismatch");
  }
}

function verifyCanonicalBundle(input, profile) {
  try {
    verifyProcessLocalRotationBundle({
      baselineResources: input.baselineResources,
      oldValues: input.oldValues,
      newValues: input.newValues,
      rotationRevision: input.bundle?.rotationRevision,
      bundle: input.bundle,
      profile
    });
  } catch (error) {
    if (error instanceof ProcessLocalRotationError) {
      reject(`canonical_${error.code}`);
    }
    reject("canonical_bundle_verification_failed");
  }
}

function identity(resource, code = "resource_identity_invalid") {
  if (!record(resource) || typeof resource.apiVersion !== "string" ||
      typeof resource.kind !== "string" || !record(resource.metadata) ||
      typeof resource.metadata.name !== "string" || !resource.metadata.name ||
      (resource.metadata.namespace !== undefined &&
        typeof resource.metadata.namespace !== "string")) {
    reject(code);
  }
  return [
    resource.apiVersion,
    resource.kind,
    resource.metadata.namespace || "",
    resource.metadata.name
  ];
}

function identityKey(resourceOrIdentity) {
  return JSON.stringify(Array.isArray(resourceOrIdentity)
    ? resourceOrIdentity
    : identity(resourceOrIdentity));
}

function resourceIndex(resources, code) {
  if (!Array.isArray(resources) || resources.length === 0) reject(code);
  const result = new Map();
  for (const resource of resources) {
    validateJsonValue(resource);
    const key = identityKey(resource);
    if (result.has(key)) reject(`${code}_duplicate`);
    result.set(key, resource);
  }
  return result;
}

function expectedInventoryKeys(namespace, profile) {
  const identities = [
    ...profile.baseline_resource_identities,
    {
      apiVersion: profile.legacy_image_pull.secret.apiVersion,
      kind: profile.legacy_image_pull.secret.kind,
      namespace: "$Namespace",
      name: profile.legacy_image_pull.secret.name
    },
    {
      apiVersion: profile.legacy_image_pull.service_account.apiVersion,
      kind: profile.legacy_image_pull.service_account.kind,
      namespace: "$Namespace",
      name: profile.legacy_image_pull.service_account.name
    }
  ];
  if (profile.baseline_resource_identities.length !== HISTORICAL_RESOURCE_COUNT ||
      profile.baseline_provenance?.historical_generated_resource_count !==
        HISTORICAL_RESOURCE_COUNT || identities.length !== OPERATIONAL_RESOURCE_COUNT) {
    reject("canonical_profile_inventory_invalid");
  }
  return identities.map(item => identityKey([
    item.apiVersion,
    item.kind,
    item.namespace === "$Namespace" ? namespace : (item.namespace || ""),
    item.name === "$Namespace" ? namespace : item.name
  ]));
}

function verifyExactInventory(resources, namespace, profile, code) {
  const index = resourceIndex(resources, code);
  const expected = expectedInventoryKeys(namespace, profile);
  if (index.size !== OPERATIONAL_RESOURCE_COUNT ||
      expected.length !== OPERATIONAL_RESOURCE_COUNT ||
      expected.some(key => !index.has(key))) {
    reject(`${code}_mismatch`);
  }
  return index;
}

function findResource(resources, apiVersion, kind, namespace, name, code) {
  const resource = resourceIndex(resources, code).get(identityKey([
    apiVersion, kind, namespace, name
  ]));
  if (!resource) reject(code);
  return resource;
}

function bindingIndex(bundle) {
  const result = new Map();
  for (const binding of bundle.contract.liveResourceBindings) {
    const key = identityKey([
      binding.apiVersion,
      binding.kind,
      binding.namespace,
      binding.name
    ]);
    result.set(key, binding);
  }
  return result;
}

function sameBytes(left, right) {
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) &&
    left.length === right.length && timingSafeEqual(left, right);
}

function sameText(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  return sameBytes(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function requireFingerprintKey(value) {
  const key = Buffer.isBuffer(value)
    ? Buffer.from(value)
    : typeof value === "string" ? Buffer.from(value, "utf8") : null;
  if (!key || key.length < HMAC_KEY_BYTES) reject("fingerprint_key_invalid");
  return key;
}

function hmac(key, label, value) {
  return createHmac("sha256", key)
    .update(label, "utf8")
    .update("\0", "utf8")
    .update(value)
    .digest("hex");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalArtifact(value) {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function canonicalResourceList(resources) {
  return { apiVersion: "v1", kind: "List", items: resources };
}

function canonicalSourceHashes(input) {
  return {
    originalBaselineSha256: sha256(canonicalArtifact(
      canonicalResourceList(input.originalBaselineResources)
    )),
    quiescedBaselineSha256: sha256(canonicalArtifact(
      canonicalResourceList(input.baselineResources)
    )),
    oldSnapshotSha256: sha256(canonicalArtifact(input.oldValues)),
    newSnapshotSha256: sha256(canonicalArtifact(input.newValues)),
    revisionSha256: sha256(canonicalArtifact({
      rotationRevision: input.bundle.rotationRevision
    }))
  };
}

function verifyOperationIntent(intent, input, profile, fingerprintKey, sourceHashes) {
  if (!exactKeys(intent, OPERATION_INTENT_KEYS) || intent.schemaVersion !== 1 ||
      intent.contractId !== OPERATION_INTENT_CONTRACT ||
      !HEX_32.test(intent.operationToken || "") ||
      !HEX_32.test(intent.operationId || "") ||
      intent.operationToken === intent.operationId ||
      intent.rotationRevision !== input.bundle.rotationRevision ||
      typeof intent.expectedKubeContext !== "string" ||
      !SAFE_CONTEXT.test(intent.expectedKubeContext) ||
      intent.namespaceName !== input.bundle.contract.namespace ||
      !DNS_LABEL.test(intent.namespaceName || "") ||
      typeof intent.namespaceUid !== "string" || !SAFE_UID.test(intent.namespaceUid) ||
      intent.retPvcName !== "ret-pvc" ||
      typeof intent.retPvcUid !== "string" || !SAFE_UID.test(intent.retPvcUid) ||
      !validCheckpointStamp(intent.checkpointStamp) ||
      !HEX_SHA256.test(intent.checkpointDumpSha256 || "") ||
      !HEX_SHA256.test(intent.checkpointStorageSha256 || "") ||
      !HEX_SHA256.test(intent.checkpointInventorySha256 || "") ||
      intent.profileId !== profile.profile_id ||
      intent.profileSha256 !== profileDigest(profile) ||
      intent.originalBaselineSha256 !== sourceHashes.originalBaselineSha256 ||
      intent.oldSnapshotSha256 !== sourceHashes.oldSnapshotSha256 ||
      intent.newSnapshotSha256 !== sourceHashes.newSnapshotSha256 ||
      !HEX_SHA256.test(intent.oldValuesSourceSha256 || "") ||
      !HEX_SHA256.test(intent.newValuesSourceSha256 || "") ||
      intent.oldValuesSourceSha256 === intent.newValuesSourceSha256 ||
      !HEX_SHA256.test(intent.operationBindingSha256 || "") ||
      !HEX_SHA256.test(intent.hmacSha256 || "")) {
    reject("operation_intent_invalid");
  }
  const bindingBody = structuredClone(intent);
  delete bindingBody.operationBindingSha256;
  delete bindingBody.hmacSha256;
  const expectedBinding = sha256(Buffer.from(
    canonicalOperationJson(bindingBody), "utf8"
  ));
  if (!sameText(intent.operationBindingSha256, expectedBinding)) {
    reject("operation_intent_binding_mismatch");
  }
  const authenticated = structuredClone(intent);
  delete authenticated.hmacSha256;
  const expectedHmac = createHmac("sha256", fingerprintKey)
    .update(canonicalOperationJson(authenticated), "utf8")
    .digest("hex");
  if (!sameText(intent.hmacSha256, expectedHmac)) {
    reject("operation_intent_hmac_mismatch");
  }
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
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day) &&
    date.getUTCHours() === Number(hour) &&
    date.getUTCMinutes() === Number(minute) &&
    date.getUTCSeconds() === Number(second);
}

function assertCleanMetadata(resource, code, { secret = false } = {}) {
  if (!record(resource?.metadata) ||
      hasOwn(resource.metadata, "managedFields") ||
      hasOwn(resource.metadata, "deletionTimestamp") ||
      hasOwn(resource.metadata, "deletionGracePeriodSeconds") ||
      hasOwn(resource.metadata.annotations || {}, LEGACY_LAST_APPLIED_ANNOTATION) ||
      (secret && Object.keys(resource.metadata).some(key =>
        !CLEAN_SECRET_METADATA_FIELDS.has(key)))) {
    reject(code);
  }
}

function decodeSecret(resource, expectedKeys, source, { live = false, clean = true } = {}) {
  if (resource?.apiVersion !== "v1" || resource?.kind !== "Secret" ||
      !record(resource.metadata) || resource.metadata.deletionTimestamp != null ||
      !Object.keys(resource).every(key => [
        "apiVersion", "kind", "metadata", "type", "immutable", "data", "stringData"
      ].includes(key))) {
    reject(`${source}_secret_contract_invalid`);
  }
  if (clean) {
    assertCleanMetadata(resource, `${source}_secret_metadata_invalid`, { secret: true });
  }
  if (resource.type !== "Opaque" ||
      (hasOwn(resource, "immutable") && resource.immutable !== false)) {
    reject(`${source}_secret_mutability_invalid`);
  }
  const hasData = record(resource.data);
  const hasStringData = record(resource.stringData);
  if (hasData === hasStringData || (live && !hasData)) {
    reject(`${source}_secret_encoding_invalid`);
  }
  const encoded = hasData ? resource.data : resource.stringData;
  if (!isDeepStrictEqual(Object.keys(encoded).sort(), [...expectedKeys].sort())) {
    reject(`${source}_secret_keyset_invalid`);
  }
  const values = {};
  for (const name of expectedKeys) {
    if (typeof encoded[name] !== "string") reject(`${source}_secret_value_invalid`);
    if (!hasData) {
      values[name] = encoded[name];
      continue;
    }
    const value = encoded[name];
    if (value.length % 4 !== 0 || !BASE64.test(value)) {
      reject(`${source}_secret_base64_invalid`);
    }
    const bytes = Buffer.from(value, "base64");
    if (bytes.toString("base64") !== value) reject(`${source}_secret_base64_invalid`);
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) reject(`${source}_secret_utf8_invalid`);
    values[name] = text;
  }
  return {
    values,
    type: resource.type,
    immutable: resource.immutable ?? false
  };
}

function readPullSecret(resource, source, profile, { clean = true } = {}) {
  const contract = profile.legacy_image_pull.secret;
  if (resource?.apiVersion !== contract.apiVersion ||
      resource?.kind !== contract.kind || resource?.type !== contract.type ||
      !record(resource.metadata) || resource.metadata.deletionTimestamp != null ||
      resource.metadata.name !== contract.name ||
      (hasOwn(resource, "immutable") && resource.immutable !== false) ||
      !Object.keys(resource).every(key => [
        "apiVersion", "kind", "metadata", "type", "immutable", "data"
      ].includes(key)) || !exactKeys(resource.data, [contract.data_key]) ||
      typeof resource.data[contract.data_key] !== "string") {
    reject(`${source}_pull_secret_contract_invalid`);
  }
  if (clean) {
    assertCleanMetadata(resource, `${source}_pull_secret_metadata_invalid`, {
      secret: true
    });
  }
  return resource.data[contract.data_key];
}

function verifyPullSecretRotation({
  candidate,
  intermediate,
  final,
  old,
  binding,
  oldValues,
  newValues,
  profile
}) {
  verifyCasBinding(intermediate, binding);
  requireUidAndResourceVersion(final, "final_pull_secret_binding_missing");
  if (final.metadata.uid !== binding?.uid) reject("final_pull_secret_uid_mismatch");
  if (final.metadata.resourceVersion !== intermediate.metadata.resourceVersion) {
    reject("final_pull_secret_resource_version_mismatch");
  }
  const oldLive = readPullSecret(old, "old", profile, { clean: false });
  const candidateEncoded = readPullSecret(candidate, "candidate", profile);
  const intermediateEncoded = readPullSecret(intermediate, "cas", profile);
  const finalEncoded = readPullSecret(final, "final", profile);
  if ((candidate.immutable ?? false) !== (intermediate.immutable ?? false) ||
      (candidate.immutable ?? false) !== (final.immutable ?? false)) {
    reject("pull_secret_exact_structure_mismatch");
  }
  const contract = profile.legacy_image_pull;
  const oldSource = oldValues[contract.snapshot_value_key];
  const newSource = newValues[contract.snapshot_value_key];
  const [botImageKey, runnerImageKey] = contract.verified_image_value_keys;
  const botImage = newValues[botImageKey];
  const runnerImage = newValues[runnerImageKey];
  if ([oldSource, newSource, botImage, runnerImage].some(value =>
    typeof value !== "string" || value.length === 0)) {
    reject("pull_secret_private_source_invalid");
  }
  try {
    verifyBotPullConfig({ encoded: candidateEncoded, botImage, runnerImage });
    verifyBotPullConfigCredentialMatch({
      expectedEncoded: oldSource,
      actualEncoded: oldLive,
      botImage,
      runnerImage
    });
    verifyBotPullConfigCredentialMatch({
      expectedEncoded: newSource,
      actualEncoded: candidateEncoded,
      botImage,
      runnerImage
    });
    verifyBotPullConfigRotation({
      oldEncoded: oldSource,
      newEncoded: newSource,
      botImage,
      runnerImage
    });
  } catch {
    reject("pull_secret_credential_contract_invalid");
  }
  if (!sameText(candidateEncoded, newSource) ||
      !sameText(intermediateEncoded, candidateEncoded) ||
      !sameText(finalEncoded, candidateEncoded)) {
    reject("pull_secret_exact_value_mismatch");
  }
  if (!isDeepStrictEqual(
    metadataWithoutServerFields(intermediate),
    metadataWithoutServerFields(candidate)
  )) reject("cas_pull_secret_metadata_mismatch");
  if (!isDeepStrictEqual(
    metadataWithoutServerFields(final),
    metadataWithoutServerFields(candidate)
  )) reject("final_pull_secret_metadata_mismatch");
  return candidateEncoded;
}

function metadataWithoutServerFields(resource) {
  const metadata = {};
  for (const [key, value] of Object.entries(resource.metadata)) {
    if (!SERVER_METADATA_FIELDS.has(key)) metadata[key] = value;
  }
  return metadata;
}

function requireUidAndResourceVersion(resource, code) {
  if (typeof resource?.metadata?.uid !== "string" || !resource.metadata.uid ||
      typeof resource?.metadata?.resourceVersion !== "string" ||
      !resource.metadata.resourceVersion) {
    reject(code);
  }
}

function verifyCasBinding(resource, binding) {
  requireUidAndResourceVersion(resource, "cas_resource_binding_missing");
  if (!sameText(resource.metadata.uid, binding.uid)) reject("cas_resource_uid_mismatch");
  if (sameText(resource.metadata.resourceVersion, binding.resourceVersion)) {
    reject("cas_resource_version_not_advanced");
  }
}

function verifyBoundConfigMap({ baseline, live, binding, bundle, profile }) {
  if (live?.apiVersion !== "v1" || live?.kind !== "ConfigMap" ||
      !record(live.metadata) || live.metadata.deletionTimestamp != null ||
      hasOwn(live, "binaryData") || !record(live.data) ||
      !Object.keys(live).every(key => [
        "apiVersion", "kind", "metadata", "immutable", "data"
      ].includes(key))) {
    reject("bound_config_map_contract_invalid");
  }
  requireUidAndResourceVersion(live, "bound_config_map_binding_missing");
  if (!sameText(live.metadata.uid, binding.uid) ||
      !sameText(live.metadata.resourceVersion, binding.resourceVersion)) {
    reject("bound_config_map_binding_mismatch");
  }
  const baselineComparable = {
    metadata: metadataWithoutServerFields(baseline),
    immutable: baseline.immutable ?? false,
    data: baseline.data
  };
  const liveComparable = {
    metadata: metadataWithoutServerFields(live),
    immutable: live.immutable ?? false,
    data: live.data
  };
  if (!isDeepStrictEqual(liveComparable, baselineComparable)) {
    reject("bound_config_map_bytes_changed");
  }
  const dataKey = profile.ret_config_data_key;
  if (!exactKeys(live.data, [dataKey]) || typeof live.data[dataKey] !== "string") {
    reject("bound_config_map_data_invalid");
  }
  const digest = createHash("sha256").update(live.data[dataKey], "utf8").digest("hex");
  if (!sameText(digest, bundle.contract.retConfigBinding.dataSha256)) {
    reject("bound_config_map_digest_mismatch");
  }
}

function normalizePrivatePem(value) {
  return value
    .replace(/\\+r\\+n/gu, "\n")
    .replace(/\\+n/gu, "\n")
    .replace(/\r\n/gu, "\n")
    .trim();
}

function rsaPublicFromPrivate(value, code) {
  let privateKey;
  let publicKey;
  try {
    privateKey = createPrivateKey(normalizePrivatePem(value));
    publicKey = createPublicKey(privateKey);
  } catch {
    reject(code);
  }
  if (privateKey.asymmetricKeyType !== "rsa" || publicKey.asymmetricKeyType !== "rsa" ||
      Number(privateKey.asymmetricKeyDetails?.modulusLength || 0) < 2048) {
    reject(code);
  }
  return publicMaterial(publicKey, code);
}

function publicMaterial(publicKey, code) {
  let jwk;
  let spki;
  try {
    jwk = publicKey.export({ format: "jwk" });
    spki = publicKey.export({ type: "spki", format: "der" });
  } catch {
    reject(code);
  }
  if (!exactKeys(jwk, ["kty", "n", "e"]) || jwk.kty !== "RSA" ||
      !BASE64URL.test(jwk.n) || !BASE64URL.test(jwk.e)) {
    reject(code);
  }
  return { jwk: { kty: jwk.kty, n: jwk.n, e: jwk.e }, spki };
}

export function parseRsaJwkSource(source, code = "runtime_jwk_invalid") {
  const jwk = parseStrictJsonSource(source, code);
  if (!exactKeys(jwk, ["kty", "n", "e"]) || jwk.kty !== "RSA" ||
      typeof jwk.n !== "string" || typeof jwk.e !== "string" ||
      !BASE64URL.test(jwk.n) || !BASE64URL.test(jwk.e)) {
    reject(code);
  }
  let key;
  try {
    key = createPublicKey({ key: jwk, format: "jwk" });
  } catch {
    reject(code);
  }
  if (key.asymmetricKeyType !== "rsa" ||
      Number(key.asymmetricKeyDetails?.modulusLength || 0) < 2048) {
    reject(code);
  }
  const material = publicMaterial(key, code);
  if (!isDeepStrictEqual(material.jwk, jwk)) reject(code);
  return material;
}

export function parseDialogPublicKeySource(source) {
  if (typeof source !== "string" || source.length === 0) {
    reject("dialog_public_key_invalid");
  }
  if (/\r(?!\n)|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(source)) {
    reject("dialog_public_key_invalid");
  }
  const normalized = source.replace(/\r\n/gu, "\n");
  if ((normalized.match(/-----BEGIN PUBLIC KEY-----/gu) || []).length !== 1 ||
      (normalized.match(/-----END PUBLIC KEY-----/gu) || []).length !== 1 ||
      normalized.includes("PRIVATE KEY")) {
    reject("dialog_public_key_invalid");
  }
  let key;
  try {
    key = createPublicKey(normalized);
  } catch {
    reject("dialog_public_key_invalid");
  }
  if (key.asymmetricKeyType !== "rsa" ||
      Number(key.asymmetricKeyDetails?.modulusLength || 0) < 2048) {
    reject("dialog_public_key_invalid");
  }
  let canonical;
  try {
    canonical = key.export({ type: "spki", format: "pem" });
  } catch {
    reject("dialog_public_key_invalid");
  }
  if (normalized !== canonical && normalized !== canonical.slice(0, -1)) {
    reject("dialog_public_key_invalid");
  }
  return publicMaterial(key, "dialog_public_key_invalid");
}

function verifyDatabaseUri(value, values, host, code) {
  let uri;
  let username;
  let password;
  let database;
  try {
    uri = new URL(value);
    username = decodeURIComponent(uri.username);
    password = decodeURIComponent(uri.password);
    database = decodeURIComponent(uri.pathname.slice(1));
  } catch {
    reject(code);
  }
  if (uri.protocol !== "postgres:" || username !== values.DB_USER ||
      password !== values.DB_PASS || uri.hostname !== host || uri.port !== "5432" ||
      database !== values.DB_NAME || uri.search || uri.hash) {
    reject(code);
  }
}

function verifyCandidateCryptography(candidateValues, liveValues, oldValues,
  reticulumRuntimeJwkSource, dialogRuntimePublicKeySource) {
  const oldPerms = rsaPublicFromPrivate(oldValues.PERMS_KEY, "old_perms_key_invalid");
  const candidatePerms = rsaPublicFromPrivate(
    candidateValues.PERMS_KEY, "candidate_perms_key_invalid"
  );
  const livePerms = rsaPublicFromPrivate(liveValues.PERMS_KEY, "live_perms_key_invalid");
  if (sameBytes(oldPerms.spki, candidatePerms.spki)) reject("perms_key_not_rotated");

  const derivedJwk = parseRsaJwkSource(
    candidateValues.PGRST_JWT_SECRET,
    "candidate_derived_jwk_invalid"
  );
  if (!sameBytes(candidatePerms.spki, derivedJwk.spki)) {
    reject("candidate_derived_jwk_mismatch");
  }
  const reticulum = parseRsaJwkSource(reticulumRuntimeJwkSource);
  const dialog = parseDialogPublicKeySource(dialogRuntimePublicKeySource);
  if (!sameBytes(candidatePerms.spki, livePerms.spki)) {
    reject("perms_live_secret_mismatch");
  }
  if (!sameBytes(candidatePerms.spki, reticulum.spki)) {
    reject("perms_reticulum_runtime_mismatch");
  }
  if (!sameBytes(candidatePerms.spki, dialog.spki)) {
    reject("perms_dialog_runtime_mismatch");
  }
  verifyDatabaseUri(
    candidateValues.PGRST_DB_URI,
    candidateValues,
    candidateValues.DB_HOST,
    "candidate_pgrst_uri_invalid"
  );
  verifyDatabaseUri(
    candidateValues.PSQL,
    candidateValues,
    "pgsql",
    "candidate_psql_uri_invalid"
  );
  return candidatePerms;
}

function verifyCandidateSecret({ candidate, live, old, binding, profile }) {
  verifyCasBinding(live, binding);
  if (!isDeepStrictEqual(
    metadataWithoutServerFields(live),
    metadataWithoutServerFields(candidate)
  )) reject("cas_secret_metadata_mismatch");
  const candidateSecret = decodeSecret(candidate, profile.secret_keys, "candidate");
  const liveSecret = decodeSecret(live, profile.secret_keys, "cas", { live: true });
  const oldSecret = decodeSecret(old, profile.secret_keys, "old", { clean: false });
  if (candidateSecret.type !== liveSecret.type ||
      candidateSecret.immutable !== liveSecret.immutable) {
    reject("cas_secret_structure_mismatch");
  }
  for (const name of profile.secret_keys) {
    if (!sameText(candidateSecret.values[name], liveSecret.values[name])) {
      reject("cas_secret_value_mismatch");
    }
  }
  return { candidateSecret, liveSecret, oldSecret };
}

function verifyDeploymentCasResponse({ baseline, live, bundle, profile }) {
  verifyCasBinding(
    live,
    bindingIndex(bundle).get(identityKey(baseline))
  );
  if (live?.apiVersion !== "apps/v1" || live?.kind !== "Deployment" ||
      !record(live.metadata) || !record(live.spec) || live.metadata.deletionTimestamp != null) {
    reject("cas_deployment_contract_invalid");
  }
  assertCleanMetadata(live, "cas_deployment_metadata_invalid");
  if (!Object.keys(live).every(key => [
    "apiVersion", "kind", "metadata", "spec", "status"
  ].includes(key))) reject("cas_deployment_contract_invalid");
  if (live.spec.replicas !== 0) reject("cas_deployment_not_quiesced");
  let expected;
  try {
    expected = applyProcessLocalRotationAnnotations({
      deployment: baseline,
      bundle,
      profile
    });
  } catch (error) {
    if (error instanceof ProcessLocalRotationError) {
      reject(`canonical_${error.code}`);
    }
    reject("canonical_annotation_projection_failed");
  }
  if (!isDeepStrictEqual(live.spec, expected.spec)) {
    reject("cas_deployment_spec_mismatch");
  }
  if (!isDeepStrictEqual(
    metadataWithoutServerFields(live),
    metadataWithoutServerFields(expected)
  )) reject("cas_deployment_metadata_mismatch");
}

function verifyCasInventory(casResponses, namespace, profile) {
  const index = resourceIndex(casResponses, "cas_response_inventory_invalid");
  const expected = [
    identityKey(["v1", "Secret", namespace, profile.projected_resources.secret]),
    identityKey([
      profile.legacy_image_pull.secret.apiVersion,
      profile.legacy_image_pull.secret.kind,
      namespace,
      profile.legacy_image_pull.secret.name
    ]),
    ...profile.rotation_revision_deployments.map(name =>
      identityKey(["apps/v1", "Deployment", namespace, name]))
  ];
  if (index.size !== expected.length || expected.some(key => !index.has(key))) {
    reject("cas_response_inventory_mismatch");
  }
  return index;
}

function quiescenceMetadata(resource) {
  const metadata = structuredClone(resource.metadata);
  delete metadata.resourceVersion;
  delete metadata.generation;
  delete metadata.managedFields;
  return metadata;
}

function specWithoutReplicas(resource) {
  const spec = structuredClone(resource.spec);
  if (!record(spec)) reject("original_baseline_deployment_invalid");
  delete spec.replicas;
  return spec;
}

function aud065PgsqlNormalSpec() {
  return {
    podSelector: { matchLabels: { app: "pgsql" } },
    policyTypes: ["Ingress"],
    ingress: [{
      from: [
        { podSelector: { matchLabels: { app: "pgbouncer" } } },
        { podSelector: { matchLabels: { app: "pgbouncer-t" } } }
      ],
      ports: [{ protocol: "TCP", port: 5432 }]
    }]
  };
}

function aud065PgsqlClosedSpec() {
  return {
    podSelector: { matchLabels: { app: "pgsql" } },
    policyTypes: ["Ingress"],
    ingress: []
  };
}

function pgsqlUserMetadata(resource) {
  const metadata = metadataWithoutServerFields(resource);
  const annotations = structuredClone(metadata.annotations || {});
  if (!record(annotations)) reject("pgsql_barrier_metadata_invalid");
  for (const marker of AUD065_PGSQL_MARKER_NAMES) delete annotations[marker];
  if (Object.keys(annotations).length > 0) metadata.annotations = annotations;
  else delete metadata.annotations;
  return metadata;
}

function assertPgsqlMetadataSafe(resource, code) {
  const metadata = resource?.metadata;
  if (!record(metadata) || metadata.deletionTimestamp != null ||
      metadata.deletionGracePeriodSeconds != null ||
      (metadata.labels !== undefined && !record(metadata.labels)) ||
      (metadata.annotations !== undefined && !record(metadata.annotations)) ||
      !Array.isArray(metadata.ownerReferences || []) ||
      !Array.isArray(metadata.finalizers || []) ||
      (metadata.ownerReferences || []).length !== 0 ||
      (metadata.finalizers || []).length !== 0 ||
      hasOwn(metadata.annotations || {}, LEGACY_LAST_APPLIED_ANNOTATION)) {
    reject(code);
  }
}

function verifyOriginalAndQuiescedPgsqlBarrier({
  original,
  quiesced,
  namespace,
  operationIntent,
  operationalAttestation
}) {
  if (original?.apiVersion !== "networking.k8s.io/v1" ||
      original?.kind !== "NetworkPolicy" ||
      original.metadata?.name !== AUD065_PGSQL_POLICY_NAME ||
      original.metadata?.namespace !== namespace ||
      quiesced?.apiVersion !== original.apiVersion ||
      quiesced?.kind !== original.kind ||
      quiesced.metadata?.name !== original.metadata.name ||
      quiesced.metadata?.namespace !== namespace) {
    reject("original_baseline_pgsql_barrier_contract_invalid");
  }
  assertPgsqlMetadataSafe(original, "original_baseline_pgsql_barrier_metadata_invalid");
  assertPgsqlMetadataSafe(quiesced, "baseline_pgsql_barrier_metadata_invalid");
  requireUidAndResourceVersion(original, "original_baseline_pgsql_barrier_binding_missing");
  requireUidAndResourceVersion(quiesced, "baseline_pgsql_barrier_binding_missing");
  const originalAnnotations = original.metadata.annotations || {};
  const quiescedAnnotations = quiesced.metadata.annotations || {};
  const normalSpec = aud065PgsqlNormalSpec();
  const normalSpecSha256 = sha256(Buffer.from(canonicalJson(normalSpec), "utf8"));
  const expectedMarkers = {
    [AUD065_PGSQL_MARKER_LOCK_UID]: operationalAttestation?.lockUid,
    [AUD065_PGSQL_MARKER_TOKEN]: operationIntent.operationToken,
    [AUD065_PGSQL_MARKER_BINDING]: operationIntent.operationBindingSha256,
    [AUD065_PGSQL_MARKER_STATE]: "closed",
    [AUD065_PGSQL_MARKER_SPEC_SHA]: normalSpecSha256
  };
  const expectedQuiescedAnnotations = {
    ...structuredClone(originalAnnotations),
    ...expectedMarkers
  };
  if (!record(originalAnnotations) || !record(quiescedAnnotations) ||
      AUD065_PGSQL_MARKER_NAMES.some(name => hasOwn(originalAnnotations, name)) ||
      original.metadata.deletionTimestamp != null ||
      quiesced.metadata.deletionTimestamp != null ||
      original.metadata.uid !== quiesced.metadata.uid ||
      original.metadata.resourceVersion === quiesced.metadata.resourceVersion ||
      !isDeepStrictEqual(original.spec, normalSpec) ||
      !isDeepStrictEqual(quiesced.spec, aud065PgsqlClosedSpec()) ||
      !isDeepStrictEqual(pgsqlUserMetadata(original), pgsqlUserMetadata(quiesced))) {
    reject("original_baseline_pgsql_barrier_drift");
  }
  if (!isDeepStrictEqual(quiescedAnnotations, expectedQuiescedAnnotations)) {
    reject("original_baseline_pgsql_barrier_marker_mismatch");
  }
  return normalSpecSha256;
}

function verifyOriginalAndQuiescedBaselines(
  originalIndex,
  baselineIndex,
  namespace,
  profile,
  operationIntent,
  operationalAttestation
) {
  if (originalIndex.size !== baselineIndex.size ||
      [...originalIndex.keys()].some(key => !baselineIndex.has(key))) {
    reject("original_baseline_inventory_mismatch");
  }
  for (const [key, original] of originalIndex.entries()) {
    const quiesced = baselineIndex.get(key);
    if (original.kind !== "Deployment") {
      if (original.apiVersion === "networking.k8s.io/v1" &&
          original.kind === "NetworkPolicy" &&
          original.metadata?.namespace === namespace &&
          original.metadata?.name === AUD065_PGSQL_POLICY_NAME) {
        verifyOriginalAndQuiescedPgsqlBarrier({
          original,
          quiesced,
          namespace,
          operationIntent,
          operationalAttestation
        });
        continue;
      }
      requireUidAndResourceVersion(original, "original_baseline_binding_missing");
      requireUidAndResourceVersion(quiesced, "baseline_resource_binding_missing");
      if (original.metadata.uid !== quiesced.metadata.uid ||
          !isDeepStrictEqual(
            comparableDesiredResource(original),
            comparableDesiredResource(quiesced)
          )) {
        reject("original_baseline_nonworkload_drift");
      }
      continue;
    }
    requireUidAndResourceVersion(original, "original_baseline_binding_missing");
    requireUidAndResourceVersion(quiesced, "baseline_resource_binding_missing");
    if (original.metadata.namespace !== namespace ||
        quiesced.metadata.namespace !== namespace ||
        original.metadata.uid !== quiesced.metadata.uid ||
        !isDeepStrictEqual(quiescenceMetadata(original), quiescenceMetadata(quiesced)) ||
        !isDeepStrictEqual(specWithoutReplicas(original), specWithoutReplicas(quiesced))) {
      reject("original_baseline_deployment_drift");
    }
    const rotationTarget = profile.rotation_revision_deployments.includes(
      original.metadata.name
    );
    if (rotationTarget) {
      if (original.spec.replicas !== 1 || quiesced.spec.replicas !== 0 ||
          original.metadata.resourceVersion === quiesced.metadata.resourceVersion) {
        reject("original_baseline_quiescence_invalid");
      }
    } else if (original.spec.replicas !== quiesced.spec.replicas) {
      reject("original_baseline_deployment_drift");
    }
  }
}

function verifyRestartContract(
  restart,
  originalIndex,
  baselineIndex,
  namespace,
  profile
) {
  if (!exactKeys(restart, [
    "schemaVersion",
    "profileId",
    "runnerMode",
    "namespace",
    "restorationPhase",
    "bundleRestoresReplicas",
    "deployments"
  ]) || restart.schemaVersion !== 1 || restart.profileId !== profile.profile_id ||
      restart.runnerMode !== "process-local" || restart.namespace !== namespace ||
      restart.restorationPhase !== "verified-callbacks-only" ||
      restart.bundleRestoresReplicas !== false || !Array.isArray(restart.deployments) ||
      restart.deployments.length !== profile.rotation_revision_deployments.length) {
    reject("restart_contract_invalid");
  }
  const result = new Map();
  restart.deployments.forEach((item, index) => {
    const name = profile.rotation_revision_deployments[index];
    const baseline = baselineIndex.get(identityKey([
      "apps/v1", "Deployment", namespace, name
    ]));
    const original = originalIndex.get(identityKey([
      "apps/v1", "Deployment", namespace, name
    ]));
    if (!exactKeys(item, [
      "name",
      "uid",
      "originalReplicas",
      "originalResourceVersion",
      "quiescedResourceVersion"
    ]) || item.name !== name || typeof item.uid !== "string" || !item.uid ||
        item.originalReplicas !== 1 ||
        typeof item.originalResourceVersion !== "string" ||
        !item.originalResourceVersion ||
        typeof item.quiescedResourceVersion !== "string" ||
        !item.quiescedResourceVersion ||
        item.originalResourceVersion === item.quiescedResourceVersion ||
        original?.spec?.replicas !== item.originalReplicas ||
        original?.metadata?.uid !== item.uid ||
        original?.metadata?.resourceVersion !== item.originalResourceVersion ||
        baseline?.spec?.replicas !== 0 ||
        baseline?.metadata?.uid !== item.uid ||
        baseline?.metadata?.resourceVersion !== item.quiescedResourceVersion ||
        !isDeepStrictEqual(quiescenceMetadata(original), quiescenceMetadata(baseline)) ||
        !isDeepStrictEqual(specWithoutReplicas(original), specWithoutReplicas(baseline))) {
      reject("restart_contract_deployment_invalid");
    }
    result.set(name, item);
  });
  return result;
}

function buildApplyAttestation(baselineIndex, bundle, profile) {
  const namespace = bundle.contract.namespace;
  const secrets = [
    profile.projected_resources.secret,
    profile.legacy_image_pull.secret.name
  ].map(name => {
    const baseline = baselineIndex.get(identityKey([
      "v1", "Secret", namespace, name
    ]));
    requireUidAndResourceVersion(baseline, "canonical_apply_attestation_invalid");
    return {
      name,
      uidBound: true,
      resourceVersionBound: true,
      mutated: true
    };
  });
  const serviceAccountName = profile.legacy_image_pull.service_account.name;
  const serviceAccountBaseline = baselineIndex.get(identityKey([
    "v1", "ServiceAccount", namespace, serviceAccountName
  ]));
  requireUidAndResourceVersion(
    serviceAccountBaseline,
    "canonical_apply_attestation_invalid"
  );
  const deployments = profile.rotation_revision_deployments.map(name => {
    const baseline = baselineIndex.get(identityKey([
      "apps/v1", "Deployment", namespace, name
    ]));
    let projected;
    try {
      projected = applyProcessLocalRotationAnnotations({
        deployment: baseline,
        bundle,
        profile
      });
    } catch (error) {
      if (error instanceof ProcessLocalRotationError) {
        reject(`canonical_${error.code}`);
      }
      reject("canonical_apply_attestation_invalid");
    }
    if (projected.spec?.replicas !== 0) reject("canonical_apply_attestation_invalid");
    return {
      name,
      uidBound: true,
      resourceVersionBound: true,
      replicas: 0,
      annotationKeys: Object.keys(
        bundle.contract.desiredDeploymentAnnotations[name]
      ).sort()
    };
  });
  return {
    allConsumersQuiesced: true,
    bundleRestoresReplicas: false,
    secrets,
    serviceAccount: {
      name: serviceAccountName,
      uidBound: true,
      resourceVersionBound: true,
      imagePullSecretsExact: true,
      mutated: false
    },
    deployments
  };
}

function verifyArtifactDescriptor(descriptor, name, body, code) {
  if (!exactKeys(descriptor, ["name", "size", "sha256"]) ||
      descriptor.name !== name || !Number.isSafeInteger(descriptor.size) ||
      descriptor.size !== body.length || !HEX_SHA256.test(descriptor.sha256 || "") ||
      !sameText(descriptor.sha256, sha256(body))) {
    reject(code);
  }
}

function verifyBundleBinding({
  bundleBinding,
  baselineResources,
  baselineIndex,
  oldValues,
  newValues,
  bundle,
  restartContract,
  operationIntent,
  sourceHashes,
  fingerprintKey,
  profile
}) {
  if (!exactKeys(bundleBinding, [
    "schemaVersion",
    "contractId",
    "profileId",
    "rotationRevision",
    "namespace",
    "operationBindingSha256",
    "inputs",
    "files",
    "externalOperationKey",
    "profileSha256",
    "liveResourceBindingsSha256",
    "applyAttestationSha256",
    "retConfigDataSha256",
    "hmacSha256"
  ]) || bundleBinding.schemaVersion !== 1 ||
      bundleBinding.contractId !== "yenhubs-aud065-offline-bundle-v1" ||
      bundleBinding.profileId !== profile.profile_id ||
      bundleBinding.rotationRevision !== bundle.rotationRevision ||
      bundleBinding.namespace !== bundle.contract.namespace ||
      bundleBinding.operationBindingSha256 !== operationIntent.operationBindingSha256 ||
      !exactKeys(bundleBinding.inputs, [
        "originalBaselineSha256",
        "quiescedBaselineSha256",
        "oldSnapshotSha256",
        "newSnapshotSha256",
        "revisionSha256"
      ]) || Object.values(bundleBinding.inputs).some(value =>
        typeof value !== "string" || !HEX_SHA256.test(value)) ||
      !exactKeys(bundleBinding.files, ["bundle", "redacted", "restart"]) ||
      !exactKeys(bundleBinding.externalOperationKey, ["size", "hmacBound"]) ||
      bundleBinding.externalOperationKey.size !== fingerprintKey.length ||
      bundleBinding.externalOperationKey.hmacBound !== true ||
      !HEX_SHA256.test(bundleBinding.profileSha256 || "") ||
      !HEX_SHA256.test(bundleBinding.liveResourceBindingsSha256 || "") ||
      !HEX_SHA256.test(bundleBinding.applyAttestationSha256 || "") ||
      !HEX_SHA256.test(bundleBinding.retConfigDataSha256 || "") ||
      !HEX_SHA256.test(bundleBinding.hmacSha256 || "")) {
    reject("bundle_binding_invalid");
  }
  if (Object.entries(sourceHashes).some(([name, value]) =>
    bundleBinding.inputs[name] !== value)) {
    reject("bundle_binding_input_hash_mismatch");
  }

  const applyAttestation = buildApplyAttestation(baselineIndex, bundle, profile);
  let redacted;
  try {
    redacted = redactProcessLocalRotationBundle({
      baselineResources,
      oldValues,
      newValues,
      rotationRevision: bundle.rotationRevision,
      bundle,
      fingerprintKey,
      profile
    });
  } catch (error) {
    if (error instanceof ProcessLocalRotationError) reject(`canonical_${error.code}`);
    reject("bundle_binding_redacted_invalid");
  }
  const redactedRecord = {
    ...redacted,
    applyAttestation,
    restartCallbacks: {
      artifact: "restart-contract.json",
      restorationPhase: restartContract.restorationPhase,
      deploymentCount: restartContract.deployments.length
    }
  };
  const bundleBody = canonicalArtifact(bundle);
  const redactedBody = canonicalArtifact(redactedRecord);
  const restartBody = canonicalArtifact(restartContract);
  verifyArtifactDescriptor(
    bundleBinding.files.bundle, "bundle.json", bundleBody, "bundle_binding_bundle_invalid"
  );
  verifyArtifactDescriptor(
    bundleBinding.files.redacted,
    "redacted.json",
    redactedBody,
    "bundle_binding_redacted_invalid"
  );
  verifyArtifactDescriptor(
    bundleBinding.files.restart,
    "restart-contract.json",
    restartBody,
    "bundle_binding_restart_invalid"
  );
  if (!sameText(bundleBinding.profileSha256, profileDigest(profile)) ||
      !sameText(
        bundleBinding.liveResourceBindingsSha256,
        sha256(Buffer.from(canonicalJson(bundle.contract.liveResourceBindings), "utf8"))
      ) ||
      !sameText(
        bundleBinding.applyAttestationSha256,
        sha256(Buffer.from(canonicalJson(applyAttestation), "utf8"))
      ) ||
      !sameText(
        bundleBinding.retConfigDataSha256,
        bundle.contract.retConfigBinding.dataSha256
      )) {
    reject("bundle_binding_contract_mismatch");
  }
  const body = structuredClone(bundleBinding);
  delete body.hmacSha256;
  const expectedHmac = createHmac("sha256", fingerprintKey)
    .update(canonicalJson(body), "utf8")
    .digest("hex");
  if (!sameText(bundleBinding.hmacSha256, expectedHmac)) {
    reject("bundle_binding_hmac_mismatch");
  }
}

function verifyOperationalAttestation({
  attestation,
  bundle,
  bundleBinding,
  operationIntent,
  finalIndex,
  fingerprintKey
}) {
  if (!exactKeys(attestation, [
    "schemaVersion",
    "expectedKubeContext",
    "namespaceName",
    "namespaceUid",
    "retPvcName",
    "retPvcUid",
    "checkpointStamp",
    "checkpointDumpSha256",
    "checkpointStorageSha256",
    "checkpointInventorySha256",
    "lockName",
    "lockUid",
    "operationId",
    "authenticatedContractState",
    "operationBindingSha256",
    "bundleBindingHmacSha256"
  ]) || attestation.schemaVersion !== 1 ||
      typeof attestation.expectedKubeContext !== "string" ||
      !SAFE_CONTEXT.test(attestation.expectedKubeContext) ||
      attestation.namespaceName !== bundle.contract.namespace ||
      !DNS_LABEL.test(attestation.namespaceName || "") ||
      typeof attestation.namespaceUid !== "string" ||
      !SAFE_UID.test(attestation.namespaceUid) ||
      attestation.retPvcName !== "ret-pvc" ||
      typeof attestation.retPvcUid !== "string" || !SAFE_UID.test(attestation.retPvcUid) ||
      !validCheckpointStamp(attestation.checkpointStamp) ||
      !HEX_SHA256.test(attestation.checkpointDumpSha256 || "") ||
      !HEX_SHA256.test(attestation.checkpointStorageSha256 || "") ||
      !HEX_SHA256.test(attestation.checkpointInventorySha256 || "") ||
      attestation.lockName !== "yenhubs-recovery-operation-lock" ||
      typeof attestation.lockUid !== "string" || !SAFE_UID.test(attestation.lockUid) ||
      !HEX_32.test(attestation.operationId || "") ||
      attestation.authenticatedContractState !==
        "bundle-and-barrier-authenticated" ||
      !HEX_SHA256.test(attestation.operationBindingSha256 || "") ||
      !HEX_SHA256.test(attestation.bundleBindingHmacSha256 || "")) {
    reject("operational_attestation_invalid");
  }
  const namespaceResource = finalIndex.get(identityKey([
    "v1", "Namespace", "", bundle.contract.namespace
  ]));
  if (namespaceResource?.metadata?.uid !== attestation.namespaceUid) {
    reject("operational_namespace_uid_mismatch");
  }
  if (attestation.expectedKubeContext !== operationIntent.expectedKubeContext ||
      attestation.namespaceName !== operationIntent.namespaceName ||
      attestation.namespaceUid !== operationIntent.namespaceUid ||
      attestation.retPvcName !== operationIntent.retPvcName ||
      attestation.retPvcUid !== operationIntent.retPvcUid ||
      attestation.checkpointStamp !== operationIntent.checkpointStamp ||
      attestation.checkpointDumpSha256 !== operationIntent.checkpointDumpSha256 ||
      attestation.checkpointStorageSha256 !== operationIntent.checkpointStorageSha256 ||
      attestation.checkpointInventorySha256 !== operationIntent.checkpointInventorySha256 ||
      attestation.operationId !== operationIntent.operationId ||
      attestation.operationBindingSha256 !== operationIntent.operationBindingSha256 ||
      !sameText(attestation.bundleBindingHmacSha256, bundleBinding.hmacSha256)) {
    reject("operational_bundle_binding_mismatch");
  }
  return hmac(
    fingerprintKey,
    "operational-attestation",
    Buffer.from(canonicalJson(attestation), "utf8")
  );
}

function comparableDesiredResource(resource) {
  const comparable = structuredClone(resource);
  delete comparable.status;
  comparable.metadata = metadataWithoutServerFields(comparable);
  return comparable;
}

function bindOnlyComparable(resource) {
  const comparable = structuredClone(resource);
  delete comparable.status;
  if (record(comparable.metadata)) {
    delete comparable.metadata.resourceVersion;
    delete comparable.metadata.managedFields;
    delete comparable.metadata.generation;
  }
  return comparable;
}

function assertDefaultServiceAccount(resource, namespace, profile, code) {
  const contract = profile.legacy_image_pull.service_account;
  if (resource?.apiVersion !== contract.apiVersion ||
      resource?.kind !== contract.kind || !record(resource.metadata) ||
      resource.metadata.name !== contract.name ||
      resource.metadata.namespace !== namespace ||
      resource.metadata.deletionTimestamp != null ||
      !isDeepStrictEqual(resource.imagePullSecrets, contract.image_pull_secrets)) {
    reject(code);
  }
  requireUidAndResourceVersion(resource, code);
}

function verifyDefaultServiceAccountChain({
  original,
  baseline,
  final,
  binding,
  namespace,
  profile,
  fingerprintKey
}) {
  assertDefaultServiceAccount(
    original, namespace, profile, "original_default_service_account_invalid"
  );
  assertDefaultServiceAccount(
    baseline, namespace, profile, "baseline_default_service_account_invalid"
  );
  assertDefaultServiceAccount(
    final, namespace, profile, "final_default_service_account_invalid"
  );
  if (!binding || original.metadata.uid !== binding.uid ||
      baseline.metadata.uid !== binding.uid || final.metadata.uid !== binding.uid ||
      original.metadata.resourceVersion !== binding.resourceVersion ||
      baseline.metadata.resourceVersion !== binding.resourceVersion ||
      final.metadata.resourceVersion !== binding.resourceVersion ||
      !isDeepStrictEqual(bindOnlyComparable(original), bindOnlyComparable(baseline)) ||
      !isDeepStrictEqual(bindOnlyComparable(baseline), bindOnlyComparable(final))) {
    reject("default_service_account_bind_only_drift");
  }
  return hmac(
    fingerprintKey,
    `ServiceAccount/${profile.legacy_image_pull.service_account.name}`,
    Buffer.from(canonicalJson(bindOnlyComparable(final)), "utf8")
  );
}

function verifyFinalPgsqlBarrier({
  original,
  baseline,
  final,
  namespace,
  operationIntent,
  operationalAttestation
}) {
  if (original?.apiVersion !== "networking.k8s.io/v1" ||
      original?.kind !== "NetworkPolicy" ||
      original.metadata?.name !== AUD065_PGSQL_POLICY_NAME ||
      original.metadata?.namespace !== namespace ||
      baseline?.apiVersion !== original.apiVersion || baseline?.kind !== original.kind ||
      baseline.metadata?.name !== original.metadata.name ||
      baseline.metadata?.namespace !== namespace ||
      final?.apiVersion !== original.apiVersion || final?.kind !== original.kind ||
      final.metadata?.name !== original.metadata.name ||
      final.metadata?.namespace !== namespace) {
    reject("final_pgsql_barrier_contract_invalid");
  }
  assertPgsqlMetadataSafe(final, "final_pgsql_barrier_metadata_invalid");
  requireUidAndResourceVersion(original, "original_pgsql_barrier_binding_missing");
  requireUidAndResourceVersion(baseline, "baseline_pgsql_barrier_binding_missing");
  requireUidAndResourceVersion(final, "final_pgsql_barrier_binding_missing");
  const originalAnnotations = original.metadata.annotations || {};
  const finalAnnotations = final.metadata.annotations || {};
  const markerNames = AUD065_PGSQL_MARKER_NAMES;
  const normalSpec = aud065PgsqlNormalSpec();
  if (!record(originalAnnotations) || !record(finalAnnotations) ||
      markerNames.some(name => hasOwn(originalAnnotations, name)) ||
      final.metadata.uid !== original.metadata.uid ||
      final.metadata.uid !== baseline.metadata.uid ||
      final.metadata.resourceVersion === baseline.metadata.resourceVersion ||
      final.metadata.resourceVersion === original.metadata.resourceVersion ||
      !isDeepStrictEqual(original.spec, normalSpec) ||
      !isDeepStrictEqual(final.spec, normalSpec) ||
      !isDeepStrictEqual(pgsqlUserMetadata(final), pgsqlUserMetadata(original)) ||
      !isDeepStrictEqual(
        Object.keys(finalAnnotations).sort(),
        [...Object.keys(originalAnnotations), ...markerNames].sort()
      )) {
    reject("final_pgsql_barrier_drift");
  }
  const normalSpecSha256 = sha256(Buffer.from(canonicalJson(normalSpec), "utf8"));
  const expectedMarkers = {
    [AUD065_PGSQL_MARKER_LOCK_UID]: operationalAttestation.lockUid,
    [AUD065_PGSQL_MARKER_TOKEN]: operationIntent.operationToken,
    [AUD065_PGSQL_MARKER_BINDING]: operationIntent.operationBindingSha256,
    [AUD065_PGSQL_MARKER_STATE]: "open-verified",
    [AUD065_PGSQL_MARKER_SPEC_SHA]: normalSpecSha256
  };
  if (Object.entries(expectedMarkers).some(([name, value]) =>
    finalAnnotations[name] !== value)) {
    reject("final_pgsql_barrier_marker_mismatch");
  }
  return {
    name: AUD065_PGSQL_POLICY_NAME,
    present: true,
    uid_matches: true,
    resource_version_advanced: true,
    normal_spec_exact: true,
    user_metadata_exact: true,
    marker_set_exact: true,
    state_open_verified: true
  };
}

export function verifyReleasedProcessLocalBaseline(input) {
  if (!exactKeys(input, [
    "verifiedResources",
    "releasedResources",
    "namespace",
    "initialPolicyResourceVersion"
  ]) || typeof input.namespace !== "string" || !DNS_LABEL.test(input.namespace) ||
      typeof input.initialPolicyResourceVersion !== "string" ||
      input.initialPolicyResourceVersion.length < 1 ||
      input.initialPolicyResourceVersion.length > 256 ||
      /[\s\u0000-\u001f\u007f]/u.test(input.initialPolicyResourceVersion)) {
    reject("released_baseline_input_invalid");
  }
  const profile = loadPinnedProcessLocalProfile();
  const verifiedIndex = verifyExactInventory(
    input.verifiedResources,
    input.namespace,
    profile,
    "verified_release_inventory_invalid"
  );
  const releasedIndex = verifyExactInventory(
    input.releasedResources,
    input.namespace,
    profile,
    "released_inventory_invalid"
  );
  const policyKey = identityKey([
    "networking.k8s.io/v1",
    "NetworkPolicy",
    input.namespace,
    AUD065_PGSQL_POLICY_NAME
  ]);
  const serviceAccountKey = identityKey([
    profile.legacy_image_pull.service_account.apiVersion,
    profile.legacy_image_pull.service_account.kind,
    input.namespace,
    profile.legacy_image_pull.service_account.name
  ]);

  for (const [key, verified] of verifiedIndex.entries()) {
    const released = releasedIndex.get(key);
    requireUidAndResourceVersion(verified, "verified_release_binding_missing");
    requireUidAndResourceVersion(released, "released_binding_missing");
    if (verified.metadata.deletionTimestamp != null ||
        released.metadata.deletionTimestamp != null ||
        verified.metadata.uid !== released.metadata.uid) {
      reject("released_resource_identity_drift");
    }
    if (key === policyKey) continue;
    if (key === serviceAccountKey) {
      assertDefaultServiceAccount(
        verified, input.namespace, profile, "verified_default_service_account_invalid"
      );
      assertDefaultServiceAccount(
        released, input.namespace, profile, "released_default_service_account_invalid"
      );
      if (verified.metadata.resourceVersion !== released.metadata.resourceVersion ||
          !isDeepStrictEqual(
            bindOnlyComparable(verified),
            bindOnlyComparable(released)
          )) {
        reject("released_default_service_account_drift");
      }
      continue;
    }
    if (!isDeepStrictEqual(
      comparableDesiredResource(verified),
      comparableDesiredResource(released)
    )) {
      reject("released_resource_desired_state_drift");
    }
  }

  const verifiedPolicy = verifiedIndex.get(policyKey);
  const releasedPolicy = releasedIndex.get(policyKey);
  const markerNames = AUD065_PGSQL_MARKER_NAMES;
  const verifiedAnnotations = verifiedPolicy.metadata.annotations || {};
  const releasedAnnotations = releasedPolicy.metadata.annotations || {};
  const normalSpec = aud065PgsqlNormalSpec();
  const normalSpecSha256 = sha256(Buffer.from(canonicalJson(normalSpec), "utf8"));
  assertPgsqlMetadataSafe(verifiedPolicy, "verified_release_pgsql_metadata_invalid");
  assertPgsqlMetadataSafe(releasedPolicy, "released_pgsql_metadata_invalid");
  if (!record(verifiedAnnotations) || !record(releasedAnnotations) ||
      markerNames.some(name => !hasOwn(verifiedAnnotations, name)) ||
      markerNames.some(name => hasOwn(releasedAnnotations, name)) ||
      verifiedAnnotations[AUD065_PGSQL_MARKER_STATE] !== "open-verified" ||
      typeof verifiedAnnotations[AUD065_PGSQL_MARKER_LOCK_UID] !== "string" ||
      !SAFE_UID.test(verifiedAnnotations[AUD065_PGSQL_MARKER_LOCK_UID]) ||
      !HEX_32.test(verifiedAnnotations[AUD065_PGSQL_MARKER_TOKEN] || "") ||
      !HEX_SHA256.test(verifiedAnnotations[AUD065_PGSQL_MARKER_BINDING] || "") ||
      verifiedAnnotations[AUD065_PGSQL_MARKER_SPEC_SHA] !== normalSpecSha256 ||
      Object.keys(verifiedAnnotations).length !==
        Object.keys(releasedAnnotations).length + markerNames.length ||
      verifiedPolicy.metadata.resourceVersion === input.initialPolicyResourceVersion ||
      releasedPolicy.metadata.resourceVersion ===
        verifiedPolicy.metadata.resourceVersion ||
      releasedPolicy.metadata.resourceVersion ===
        input.initialPolicyResourceVersion ||
      !isDeepStrictEqual(verifiedPolicy.spec, normalSpec) ||
      !isDeepStrictEqual(releasedPolicy.spec, normalSpec) ||
      !isDeepStrictEqual(pgsqlUserMetadata(verifiedPolicy),
        pgsqlUserMetadata(releasedPolicy))) {
    reject("released_pgsql_cleanup_drift");
  }
  return true;
}

export function verifyReadyProcessLocalDeployments(input) {
  if (!exactKeys(input, ["resources", "namespace"]) ||
      typeof input.namespace !== "string" || !DNS_LABEL.test(input.namespace)) {
    reject("live_deployment_readiness_input_invalid");
  }
  const profile = loadPinnedProcessLocalProfile();
  const index = verifyExactInventory(
    input.resources,
    input.namespace,
    profile,
    "live_audit_inventory_invalid"
  );
  if (!Array.isArray(profile.required_deployments) ||
      profile.required_deployments.length !== 12 ||
      new Set(profile.required_deployments).size !== 12) {
    reject("live_deployment_inventory_invalid");
  }
  for (const name of profile.required_deployments) {
    const deployment = index.get(identityKey([
      "apps/v1", "Deployment", input.namespace, name
    ]));
    const generation = deployment?.metadata?.generation;
    const status = deployment?.status;
    if (!deployment || deployment.apiVersion !== "apps/v1" ||
        deployment.kind !== "Deployment" ||
        deployment.metadata?.deletionTimestamp != null ||
        !record(deployment.spec) || deployment.spec.replicas !== 1 ||
        !Number.isSafeInteger(generation) || generation < 1 || !record(status) ||
        status.observedGeneration !== generation || status.replicas !== 1 ||
        status.updatedReplicas !== 1 || status.readyReplicas !== 1 ||
        status.availableReplicas !== 1 ||
        (status.unavailableReplicas !== undefined && status.unavailableReplicas !== 0) ||
        (status.terminatingReplicas !== undefined && status.terminatingReplicas !== 0)) {
      reject("live_deployment_readiness_invalid");
    }
  }
  return true;
}

function verifyFinalInvariantResources({
  baselineIndex,
  finalIndex,
  namespace,
  profile
}) {
  const skipped = new Set([
    identityKey(["v1", "Secret", namespace, profile.projected_resources.secret]),
    identityKey([
      profile.legacy_image_pull.secret.apiVersion,
      profile.legacy_image_pull.secret.kind,
      namespace,
      profile.legacy_image_pull.secret.name
    ]),
    identityKey([
      "networking.k8s.io/v1", "NetworkPolicy", namespace, AUD065_PGSQL_POLICY_NAME
    ]),
    ...profile.required_deployments.map(name =>
      identityKey(["apps/v1", "Deployment", namespace, name]))
  ]);
  for (const [key, finalResource] of finalIndex.entries()) {
    requireUidAndResourceVersion(finalResource, "final_resource_binding_missing");
    const baseline = baselineIndex.get(key);
    requireUidAndResourceVersion(baseline, "baseline_resource_binding_missing");
    if (!record(finalResource.metadata) ||
        finalResource.metadata.deletionTimestamp != null ||
        finalResource.metadata.deletionGracePeriodSeconds != null) {
      reject("final_resource_metadata_invalid");
    }
    if (finalResource.metadata.uid !== baseline.metadata.uid) {
      reject("final_resource_uid_mismatch");
    }
    if (skipped.has(key)) continue;
    if (!baseline || !isDeepStrictEqual(
      comparableDesiredResource(finalResource),
      comparableDesiredResource(baseline)
    )) reject("final_invariant_resource_changed");
  }
}

function verifyFinalSecret({ candidate, intermediate, final, binding, profile }) {
  requireUidAndResourceVersion(final, "final_secret_binding_missing");
  if (final.metadata.uid !== binding?.uid) reject("final_secret_uid_mismatch");
  if (final.metadata.resourceVersion !== intermediate.metadata.resourceVersion) {
    reject("final_secret_resource_version_mismatch");
  }
  const candidateSecret = decodeSecret(candidate, profile.secret_keys, "candidate");
  const finalSecret = decodeSecret(final, profile.secret_keys, "final", { live: true });
  if (!isDeepStrictEqual(
    metadataWithoutServerFields(final),
    metadataWithoutServerFields(candidate)
  )) reject("final_secret_metadata_mismatch");
  for (const name of profile.secret_keys) {
    if (!sameText(candidateSecret.values[name], finalSecret.values[name])) {
      reject("final_secret_value_mismatch");
    }
  }
  return finalSecret;
}

function verifyFinalDeployment({
  name,
  baseline,
  intermediate,
  final,
  binding,
  restart,
  profile
}) {
  if (final?.apiVersion !== "apps/v1" || final?.kind !== "Deployment" ||
      !record(final.spec) || !Object.keys(final).every(key =>
        ["apiVersion", "kind", "metadata", "spec", "status"].includes(key))) {
    reject("final_deployment_contract_invalid");
  }
  assertCleanMetadata(final, "final_deployment_metadata_invalid");
  requireUidAndResourceVersion(final, "final_deployment_binding_missing");
  if (final.metadata.uid !== binding?.uid) reject("final_deployment_uid_mismatch");
  const rotationTarget = profile.rotation_revision_deployments.includes(name);
  const expected = structuredClone(rotationTarget ? intermediate : baseline);
  const expectedReplicas = rotationTarget ? restart.originalReplicas : baseline.spec.replicas;
  expected.spec.replicas = expectedReplicas;
  if (final.spec.replicas !== expectedReplicas) {
    reject("final_deployment_replicas_invalid");
  }
  if (rotationTarget && new Set([
    intermediate.metadata.resourceVersion,
    binding?.resourceVersion,
    restart.originalResourceVersion,
    restart.quiescedResourceVersion
  ]).has(final.metadata.resourceVersion)) {
    reject("final_deployment_resource_version_reused");
  }
  if (!isDeepStrictEqual(final.spec, expected.spec)) {
    reject("final_deployment_spec_mismatch");
  }
  if (!isDeepStrictEqual(
    metadataWithoutServerFields(final),
    metadataWithoutServerFields(expected)
  )) reject("final_deployment_metadata_mismatch");
  return {
    name,
    present: true,
    rotation_target: rotationTarget,
    uid_matches: true,
    replicas_restored: true,
    spec_exact: true,
    images_exact: true,
    annotations_exact: true,
    metadata_clean: true
  };
}

export function verifyRedactedRollout(input) {
  if (!exactKeys(input, [
    "originalBaselineResources",
    "baselineResources",
    "oldValues",
    "newValues",
    "bundle",
    "bundleBinding",
    "operationIntent",
    "restartContract",
    "casResponseResources",
    "finalResources",
    "operationalAttestation",
    "reticulumRuntimeJwkSource",
    "dialogRuntimePublicKeySource",
    "fingerprintKey"
  ])) reject("verification_input_invalid");
  const profile = loadPinnedProcessLocalProfile();
  for (const values of [input.oldValues, input.newValues]) {
    if (!record(values) || profile.forbidden.secret_domain_keys.some(name => hasOwn(values, name))) {
      reject("aud075_snapshot_key_forbidden");
    }
  }
  verifyCanonicalBundle(input, profile);
  const key = requireFingerprintKey(input.fingerprintKey);
  const namespace = input.bundle.contract.namespace;
  const sourceHashes = canonicalSourceHashes(input);
  verifyOperationIntent(input.operationIntent, input, profile, key, sourceHashes);
  const originalIndex = verifyExactInventory(
    input.originalBaselineResources,
    namespace,
    profile,
    "original_baseline_inventory_invalid"
  );
  const baselineIndex = verifyExactInventory(
    input.baselineResources,
    namespace,
    profile,
    "baseline_inventory_invalid"
  );
  verifyOriginalAndQuiescedBaselines(
    originalIndex,
    baselineIndex,
    namespace,
    profile,
    input.operationIntent,
    input.operationalAttestation
  );
  const casIndex = verifyCasInventory(input.casResponseResources, namespace, profile);
  const finalIndex = verifyExactInventory(
    input.finalResources,
    namespace,
    profile,
    "final_inventory_invalid"
  );
  const bindings = bindingIndex(input.bundle);
  const restartByName = verifyRestartContract(
    input.restartContract,
    originalIndex,
    baselineIndex,
    namespace,
    profile
  );
  verifyBundleBinding({
    bundleBinding: input.bundleBinding,
    baselineResources: input.baselineResources,
    baselineIndex,
    oldValues: input.oldValues,
    newValues: input.newValues,
    bundle: input.bundle,
    restartContract: input.restartContract,
    operationIntent: input.operationIntent,
    sourceHashes,
    fingerprintKey: key,
    profile
  });

  const secretIdentity = ["v1", "Secret", namespace, profile.projected_resources.secret];
  const secretKey = identityKey(secretIdentity);
  const candidateSecretResource = findResource(
    input.bundle.resources,
    ...secretIdentity,
    "candidate_secret_missing"
  );
  const baselineSecretResource = baselineIndex.get(secretKey);
  if (!baselineSecretResource) reject("baseline_secret_missing");
  const secrets = verifyCandidateSecret({
    candidate: candidateSecretResource,
    live: casIndex.get(secretKey),
    old: baselineSecretResource,
    binding: bindings.get(secretKey),
    profile
  });
  const finalSecretResource = finalIndex.get(secretKey);
  if (!finalSecretResource) reject("final_secret_missing");
  const finalSecret = verifyFinalSecret({
    candidate: candidateSecretResource,
    intermediate: casIndex.get(secretKey),
    final: finalSecretResource,
    binding: bindings.get(secretKey),
    profile
  });

  const pullSecretIdentity = [
    profile.legacy_image_pull.secret.apiVersion,
    profile.legacy_image_pull.secret.kind,
    namespace,
    profile.legacy_image_pull.secret.name
  ];
  const pullSecretKey = identityKey(pullSecretIdentity);
  const candidatePullSecret = findResource(
    input.bundle.resources,
    ...pullSecretIdentity,
    "candidate_pull_secret_missing"
  );
  const baselinePullSecret = baselineIndex.get(pullSecretKey);
  const intermediatePullSecret = casIndex.get(pullSecretKey);
  const finalPullSecret = finalIndex.get(pullSecretKey);
  if (!baselinePullSecret || !intermediatePullSecret || !finalPullSecret) {
    reject("pull_secret_inventory_missing");
  }
  const pullSecretEncoded = verifyPullSecretRotation({
    candidate: candidatePullSecret,
    intermediate: intermediatePullSecret,
    final: finalPullSecret,
    old: baselinePullSecret,
    binding: bindings.get(pullSecretKey),
    oldValues: input.oldValues,
    newValues: input.newValues,
    profile
  });

  const serviceAccountIdentity = [
    profile.legacy_image_pull.service_account.apiVersion,
    profile.legacy_image_pull.service_account.kind,
    namespace,
    profile.legacy_image_pull.service_account.name
  ];
  const serviceAccountKey = identityKey(serviceAccountIdentity);
  const serviceAccountHmac = verifyDefaultServiceAccountChain({
    original: originalIndex.get(serviceAccountKey),
    baseline: baselineIndex.get(serviceAccountKey),
    final: finalIndex.get(serviceAccountKey),
    binding: bindings.get(serviceAccountKey),
    namespace,
    profile,
    fingerprintKey: key
  });

  const configIdentity = ["v1", "ConfigMap", namespace, profile.bound_resources.config_map];
  const configKey = identityKey(configIdentity);
  const baselineConfigMap = baselineIndex.get(configKey);
  const finalConfigMap = finalIndex.get(configKey);
  if (!baselineConfigMap || !finalConfigMap) {
    reject("bound_config_map_missing");
  }
  verifyBoundConfigMap({
    baseline: baselineConfigMap,
    live: finalConfigMap,
    binding: bindings.get(configKey),
    bundle: input.bundle,
    profile
  });

  const intermediateDeploymentReports = [];
  for (const name of profile.rotation_revision_deployments) {
    const deploymentKey = identityKey(["apps/v1", "Deployment", namespace, name]);
    const baseline = baselineIndex.get(deploymentKey);
    const live = casIndex.get(deploymentKey);
    if (!baseline || !live) reject("cas_deployment_missing");
    verifyDeploymentCasResponse({ baseline, live, bundle: input.bundle, profile });
    intermediateDeploymentReports.push({
      name,
      present: true,
      uid_matches: true,
      resource_version_advanced: true,
      replicas_zero: true,
      spec_exact: true,
      images_exact: true,
      annotations_exact: true
    });
  }

  const deploymentReports = profile.required_deployments.map(name => {
    const deploymentKey = identityKey(["apps/v1", "Deployment", namespace, name]);
    const baseline = baselineIndex.get(deploymentKey);
    const rotationTarget = profile.rotation_revision_deployments.includes(name);
    return verifyFinalDeployment({
      name,
      baseline,
      intermediate: rotationTarget ? casIndex.get(deploymentKey) : baseline,
      final: finalIndex.get(deploymentKey),
      binding: bindings.get(deploymentKey),
      restart: rotationTarget ? restartByName.get(name) : null,
      profile
    });
  });

  const operationalHmac = verifyOperationalAttestation({
    attestation: input.operationalAttestation,
    bundle: input.bundle,
    bundleBinding: input.bundleBinding,
    operationIntent: input.operationIntent,
    finalIndex,
    fingerprintKey: key
  });
  const pgsqlBarrierKey = identityKey([
    "networking.k8s.io/v1", "NetworkPolicy", namespace, AUD065_PGSQL_POLICY_NAME
  ]);
  const pgsqlBarrierReport = verifyFinalPgsqlBarrier({
    original: originalIndex.get(pgsqlBarrierKey),
    baseline: baselineIndex.get(pgsqlBarrierKey),
    final: finalIndex.get(pgsqlBarrierKey),
    namespace,
    operationIntent: input.operationIntent,
    operationalAttestation: input.operationalAttestation
  });
  verifyFinalInvariantResources({ baselineIndex, finalIndex, namespace, profile });

  const candidatePerms = verifyCandidateCryptography(
    secrets.candidateSecret.values,
    finalSecret.values,
    secrets.oldSecret.values,
    input.reticulumRuntimeJwkSource,
    input.dialogRuntimePublicKeySource
  );
  const bundlePermsDigest = createHash("sha256").update(candidatePerms.spki).digest("hex");
  if (!sameText(bundlePermsDigest, input.bundle.contract.permsPublicKeySha256)) {
    reject("bundle_perms_spki_mismatch");
  }

  const secretKeys = profile.secret_keys.map(name => ({
    name,
    present: true,
    configured: secrets.candidateSecret.values[name] !== "",
    changed: !sameText(
      secrets.oldSecret.values[name],
      secrets.candidateSecret.values[name]
    ),
    live_matches: true,
    hmac: hmac(
      key,
      `Secret/${profile.projected_resources.secret}/${name}`,
      Buffer.from(secrets.candidateSecret.values[name], "utf8")
    )
  }));

  return {
    schema_version: 2,
    verdict: "pass",
    namespace: { name: namespace, present: true },
    canonical_profile: {
      name: profile.profile_id,
      exact: true,
      hmac: hmac(key, "canonical-profile", Buffer.from(canonicalJson(profile), "utf8"))
    },
    canonical_bundle: {
      name: "process-local-credential-rotation",
      exact: true,
      applicable_resource_is_secret_only: true,
      applicable_secret_count: 2,
      hmac: hmac(key, "canonical-bundle", Buffer.from(canonicalJson(input.bundle), "utf8"))
    },
    private_bundle_binding: {
      exact: true,
      hmac_verified: true,
      operation_intent_bound: true,
      profile_bound: true,
      rotation_revision_bound: true,
      namespace_bound: true,
      artifacts_bound: true
    },
    inventories: {
      historical_generated_resources: HISTORICAL_RESOURCE_COUNT,
      original_baseline_resources: OPERATIONAL_RESOURCE_COUNT,
      baseline_resources: OPERATIONAL_RESOURCE_COUNT,
      live_resource_bindings: 16,
      intermediate_cas_resources: 8,
      final_resources: OPERATIONAL_RESOURCE_COUNT,
      final_secrets: 2,
      final_deployments: 12,
      exact: true
    },
    secret: {
      name: profile.projected_resources.secret,
      present: true,
      intermediate_cas_response_verified: true,
      final_verified: true,
      opaque: true,
      mutable: true,
      metadata_clean: true,
      exact_keyset: true,
      keys: secretKeys
    },
    legacy_image_pull: {
      name: profile.legacy_image_pull.secret.name,
      present: true,
      candidate_private_source_exact: true,
      original_private_source_semantic_match: true,
      credential_rotated: true,
      intermediate_cas_response_verified: true,
      final_verified: true,
      final_resource_version_equals_cas: true,
      docker_config_secret_type_exact: true,
      mutable: true,
      metadata_clean: true,
      distinct_from_candidate_pull_secret: true,
      hmac: hmac(
        key,
        `Secret/${profile.legacy_image_pull.secret.name}`,
        Buffer.from(pullSecretEncoded, "utf8")
      )
    },
    default_service_account: {
      name: profile.legacy_image_pull.service_account.name,
      present: true,
      original_quiesced_invariant: true,
      final_invariant: true,
      bind_only: true,
      image_pull_secrets_exact: true,
      resource_version_invariant: true,
      hmac: serviceAccountHmac
    },
    placeholder_config_map: {
      name: profile.bound_resources.config_map,
      present: true,
      applicable: false,
      binding_exact: true,
      bytes_invariant: true,
      placeholders_exact: true,
      hmac: hmac(
        key,
        `ConfigMap/${profile.bound_resources.config_map}/${profile.ret_config_data_key}`,
        Buffer.from(finalConfigMap.data[profile.ret_config_data_key], "utf8")
      )
    },
    intermediate_cas_deployments: intermediateDeploymentReports,
    deployments: deploymentReports,
    restart_contract: {
      exact: true,
      target_count: 6,
      original_baseline_bound: true,
      quiesced_baseline_bound: true,
      replicas_restored: true
    },
    operation_intent: {
      exact: true,
      binding_verified: true,
      hmac_verified: true,
      canonical_sources_bound: true,
      profile_bound: true,
      namespace_bound: true,
      checkpoint_bound: true
    },
    operational_attestation: {
      exact: true,
      context_bound: true,
      namespace_uid_bound: true,
      pvc_uid_bound: true,
      checkpoint_bound: true,
      lock_bound: true,
      operation_bound: true,
      bundle_binding_bound: true,
      hmac: operationalHmac
    },
    pgsql_barrier: pgsqlBarrierReport,
    database: {
      derived_uris_valid: true
    },
    perms_key: {
      previous_differs: true,
      candidate_rsa_valid: true,
      derived_jwk_valid: true,
      final_secret_matches: true,
      reticulum_runtime_matches: true,
      dialog_runtime_matches: true,
      four_way_spki_match: true,
      hmac: hmac(key, "PERMS_KEY/public-spki", candidatePerms.spki)
    },
    forbidden_aud075: {
      snapshot_secret_domain_absent: true,
      contracted_inventory_exact: true
    }
  };
}

export const internals = Object.freeze({
  assertPinnedProfile,
  identityKey,
  metadataWithoutServerFields,
  profileDigest
});

#!/usr/bin/env node

import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  classifyProcessLocalRotationReentry,
  loadProcessLocalRotationProfile,
  projectProcessLocalRotationReplacement
} from "./process-local-rotation.mjs";
import {
  canonicalOperationJson,
  loadVerifiedProcessLocalRotationIntent,
  PROCESS_LOCAL_OPERATION_FILES
} from "./process-local-rotation-operation.mjs";

const MAX_BASELINE_BYTES = 32 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
const MAX_REPLACEMENT_BYTES = 32 * 1024 * 1024;
const MAX_BINDING_BYTES = 1024 * 1024;
const OPERATION_KEY_BYTES = 32;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const DNS_LABEL = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/u;
const SAFE_CAUSE_CODE = /^[a-z0-9_]+$/u;
const HEX_SHA256 = /^[a-f0-9]{64}$/u;
const BUNDLE_DIRECTORY_NAME = "bundle";
const BUNDLE_NAME = "bundle.json";
const BINDING_NAME = "binding.json";
const QUIESCED_BASELINE_NAME = "quiesced-baseline.json";
const PENDING_PREFIX = ".pending-";

export class MaterializeProcessLocalRotationError extends Error {
  constructor(code, causeCode) {
    super(code);
    this.name = "MaterializeProcessLocalRotationError";
    this.code = code;
    if (typeof causeCode === "string" && SAFE_CAUSE_CODE.test(causeCode)) {
      this.causeCode = causeCode;
    }
  }
}

function fail(code, causeCode) {
  throw new MaterializeProcessLocalRotationError(code, causeCode);
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

function checkedAbsolute(inputPath) {
  if (typeof inputPath !== "string" || inputPath.length === 0 ||
      /[\u0000\r\n]/u.test(inputPath)) {
    fail("private_path_invalid");
  }
  try {
    return path.resolve(inputPath);
  } catch (_error) {
    fail("private_path_invalid");
  }
}

function currentUidMatches(stat) {
  return typeof process.getuid !== "function" || stat.uid === BigInt(process.getuid());
}

function exactMode(stat, mode) {
  return Number(stat.mode & 0o7777n) === mode;
}

function requireFilesystemContracts() {
  if (typeof fs.constants.O_NOFOLLOW !== "number" ||
      typeof fs.constants.O_EXCL !== "number") {
    fail("private_filesystem_contract_unsupported");
  }
}

function componentContract(inputPath) {
  const absolute = checkedAbsolute(inputPath);
  const parsed = path.parse(absolute);
  const components = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  const result = [];
  for (const [index, component] of components.entries()) {
    if (component === "." || component === "..") fail("private_path_invalid");
    current = path.join(current, component);
    let stat;
    try {
      stat = fs.lstatSync(current, { bigint: true });
    } catch (_error) {
      fail("private_path_invalid");
    }
    if (stat.isSymbolicLink() || (index < components.length - 1 && !stat.isDirectory())) {
      fail("private_path_invalid");
    }
    result.push({
      path: current,
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode,
      uid: stat.uid,
      nlink: stat.nlink,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
      directory: stat.isDirectory(),
      file: stat.isFile()
    });
  }
  return { absolute, components: result };
}

function sameInputComponents(before, after) {
  return before.length === after.length && before.every((entry, index) => {
    const current = after[index];
    return entry.path === current.path && entry.dev === current.dev &&
      entry.ino === current.ino && entry.mode === current.mode &&
      entry.uid === current.uid &&
      entry.directory === current.directory && entry.file === current.file &&
      (index !== before.length - 1 || !entry.file ||
        (entry.size === current.size && entry.mtimeNs === current.mtimeNs &&
         entry.ctimeNs === current.ctimeNs && entry.nlink === current.nlink));
  });
}

function runHook(hooks, name, context) {
  const hook = hooks?.[name];
  if (hook === undefined) return;
  if (typeof hook !== "function") fail("test_hook_invalid");
  hook(Object.freeze({ ...context }));
}

function readExactBytes(descriptor, size) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = fs.readSync(descriptor, bytes, offset, size - offset, offset);
    if (!Number.isInteger(count) || count <= 0) fail("private_input_changed");
    offset += count;
  }
  const extra = Buffer.alloc(1);
  if (fs.readSync(descriptor, extra, 0, 1, size) !== 0) {
    fail("private_input_changed");
  }
  return bytes;
}

function openedInputMatches(opened, expected) {
  return opened.isFile() && opened.dev === expected.dev && opened.ino === expected.ino &&
    opened.nlink === 1n && exactMode(opened, PRIVATE_FILE_MODE) &&
    currentUidMatches(opened) && opened.size === expected.size &&
    opened.mtimeNs === expected.mtimeNs && opened.ctimeNs === expected.ctimeNs;
}

function readPrivateFile(
  inputPath,
  maximumBytes,
  hooks,
  sourceName,
  { binary = false } = {}
) {
  requireFilesystemContracts();
  const before = componentContract(inputPath);
  const leaf = before.components.at(-1);
  if (!leaf?.file || leaf.nlink !== 1n || !exactMode(leaf, PRIVATE_FILE_MODE) ||
      !currentUidMatches(leaf) || leaf.size < 1n || leaf.size > BigInt(maximumBytes)) {
    fail("private_input_invalid");
  }
  let descriptor;
  try {
    descriptor = fs.openSync(
      before.absolute,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!openedInputMatches(opened, leaf)) fail("private_input_invalid");
    const first = readExactBytes(descriptor, Number(opened.size));
    runHook(hooks, "afterPrivateFileFirstRead", {
      name: sourceName || path.basename(before.absolute),
      path: before.absolute
    });
    const middle = fs.fstatSync(descriptor, { bigint: true });
    if (!openedInputMatches(middle, opened)) fail("private_input_changed");
    const second = readExactBytes(descriptor, Number(opened.size));
    const after = fs.fstatSync(descriptor, { bigint: true });
    const afterPath = componentContract(before.absolute);
    if (!openedInputMatches(after, opened) ||
        !sameInputComponents(before.components, afterPath.components) ||
        first.length !== second.length || !timingSafeEqual(first, second)) {
      fail("private_input_changed");
    }
    const text = binary ? undefined : first.toString("utf8");
    if (!binary && !Buffer.from(text, "utf8").equals(first)) {
      fail("private_input_invalid");
    }
    return { absolute: before.absolute, bytes: first, text };
  } catch (error) {
    if (error instanceof MaterializeProcessLocalRotationError) throw error;
    fail("private_input_invalid");
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The caller receives only the value-free primary failure.
      }
    }
  }
}

function parseJson(source, code) {
  try {
    return JSON.parse(source.text);
  } catch (_error) {
    fail(code);
  }
}

function parseBaseline(source, code) {
  const parsed = parseJson(source, code);
  if (Array.isArray(parsed)) return parsed;
  if (isRecord(parsed) && parsed.kind === "List" && Array.isArray(parsed.items)) {
    return parsed.items;
  }
  fail(code);
}

function canonicalBytes(value) {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function parseCanonicalBundle(source) {
  const bundle = parseJson(source, "rotation_bundle_json_invalid");
  let expected;
  try {
    expected = canonicalBytes(bundle);
  } catch (_error) {
    fail("rotation_bundle_json_invalid");
  }
  if (!source.bytes.equals(expected)) fail("rotation_bundle_not_canonical");
  return bundle;
}

function resourceIdentity(resource, code) {
  if (!isRecord(resource) || typeof resource.apiVersion !== "string" ||
      !resource.apiVersion || typeof resource.kind !== "string" || !resource.kind ||
      !isRecord(resource.metadata) || typeof resource.metadata.name !== "string" ||
      !resource.metadata.name || !["undefined", "string"].includes(
        typeof resource.metadata.namespace
      )) {
    fail(code);
  }
  return [
    resource.apiVersion,
    resource.kind,
    resource.metadata.namespace || "",
    resource.metadata.name
  ].join("\u0000");
}

function renderedProfileIdentity(identity, namespace) {
  return [
    identity.apiVersion,
    identity.kind,
    identity.namespace === "$Namespace" ? namespace : "",
    identity.name === "$Namespace" ? namespace : identity.name
  ].join("\u0000");
}

function targetIdentities(namespace, profile) {
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

function identityKey(identity) {
  return [
    identity.apiVersion,
    identity.kind,
    identity.namespace || "",
    identity.name
  ].join("\u0000");
}

function indexFullInventory(resources, namespace, profile, code) {
  if (!Array.isArray(resources) || resources.length !==
      profile.baseline_resource_identities.length || resources.length !== 42) {
    fail(code);
  }
  const expected = new Set(profile.baseline_resource_identities.map(identity =>
    renderedProfileIdentity(identity, namespace)
  ));
  const indexed = new Map();
  for (const resource of resources) {
    const identity = resourceIdentity(resource, code);
    if (!expected.has(identity) || indexed.has(identity)) fail(code);
    indexed.set(identity, resource);
  }
  if (indexed.size !== expected.size || [...expected].some(identity => !indexed.has(identity))) {
    fail(code);
  }
  return indexed;
}

function exactTargetResources(resources, namespace, profile, code) {
  const indexed = indexFullInventory(resources, namespace, profile, code);
  const targets = targetIdentities(namespace, profile);
  if (targets.length !== 7) fail(code);
  return targets.map(target => {
    const resource = indexed.get(identityKey(target));
    if (!resource) fail(code);
    return resource;
  });
}

function bundleNamespace(bundle) {
  const namespace = bundle?.contract?.namespace;
  if (typeof namespace !== "string" || !DNS_LABEL.test(namespace)) {
    fail("rotation_bundle_namespace_invalid");
  }
  return namespace;
}

function decodeSecret(resource, profile) {
  const hasData = isRecord(resource.data);
  const hasStringData = isRecord(resource.stringData);
  if (hasData === hasStringData) fail("rotation_replacement_secret_invalid");
  const source = hasData ? resource.data : resource.stringData;
  if (JSON.stringify(Object.keys(source).sort()) !==
      JSON.stringify([...profile.secret_keys].sort())) {
    fail("rotation_replacement_secret_invalid");
  }
  const result = {};
  for (const key of profile.secret_keys) {
    const value = source[key];
    if (typeof value !== "string") fail("rotation_replacement_secret_invalid");
    if (!hasData) {
      result[key] = value;
      continue;
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
      .test(value)) {
      fail("rotation_replacement_secret_invalid");
    }
    const bytes = Buffer.from(value, "base64");
    if (bytes.toString("base64") !== value) fail("rotation_replacement_secret_invalid");
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) {
      fail("rotation_replacement_secret_invalid");
    }
    result[key] = text;
  }
  return result;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizePrivateKey(value) {
  return value
    .replace(/\\+r\\+n/gu, "\n")
    .replace(/\\+n/gu, "\n")
    .trim();
}

function secretContractValues(resource, profile) {
  const values = decodeSecret(resource, profile);
  let privateKey;
  let publicKey;
  try {
    privateKey = createPrivateKey(normalizePrivateKey(values.PERMS_KEY));
    publicKey = createPublicKey(privateKey);
  } catch (_error) {
    fail("rotation_replacement_secret_invalid");
  }
  if (privateKey.asymmetricKeyType !== "rsa" || publicKey.asymmetricKeyType !== "rsa") {
    fail("rotation_replacement_secret_invalid");
  }
  const jwk = publicKey.export({ format: "jwk" });
  const jwt = JSON.stringify({ kty: jwk.kty, n: jwk.n, e: jwk.e });
  if (values.PGRST_JWT_SECRET !== jwt) fail("rotation_replacement_secret_invalid");
  return {
    database: sha256(JSON.stringify({
      DB_USER: values.DB_USER,
      DB_PASS: values.DB_PASS,
      DB_NAME: values.DB_NAME,
      DB_HOST: values.DB_HOST,
      DB_HOST_T: values.DB_HOST_T,
      PGRST_DB_URI: values.PGRST_DB_URI,
      PSQL: values.PSQL
    })),
    bot: sha256(values.BOT_ACCESS_KEY),
    perms: sha256(publicKey.export({ type: "spki", format: "der" }))
  };
}

function bindingIdentity(binding, code) {
  if (!exactKeys(binding, [
    "apiVersion", "kind", "namespace", "name", "uid", "resourceVersion"
  ]) || typeof binding.apiVersion !== "string" || typeof binding.kind !== "string" ||
      !["object", "string"].includes(typeof binding.namespace) ||
      (binding.namespace !== null && typeof binding.namespace !== "string") ||
      typeof binding.name !== "string" || !binding.name ||
      typeof binding.uid !== "string" || !binding.uid ||
      typeof binding.resourceVersion !== "string" || !binding.resourceVersion) {
    fail(code);
  }
  return identityKey(binding);
}

function assertBundleBoundToBaseline(bundle, baselineIndex, profile) {
  const bindings = bundle?.contract?.liveResourceBindings;
  if (!Array.isArray(bindings) || bindings.length !== 14) {
    fail("rotation_bundle_binding_invalid");
  }
  const seen = new Set();
  for (const binding of bindings) {
    const identity = bindingIdentity(binding, "rotation_bundle_binding_invalid");
    if (seen.has(identity)) fail("rotation_bundle_binding_invalid");
    seen.add(identity);
    const baseline = baselineIndex.get(identity);
    if (!baseline || baseline.metadata?.uid !== binding.uid ||
        baseline.metadata?.resourceVersion !== binding.resourceVersion) {
      fail("rotation_bundle_binding_drift");
    }
  }

  const namespace = bundleNamespace(bundle);
  const configIdentity = identityKey({
    apiVersion: "v1",
    kind: "ConfigMap",
    namespace,
    name: profile.bound_resources.config_map
  });
  const config = baselineIndex.get(configIdentity);
  const retConfig = bundle?.contract?.retConfigBinding;
  if (!config || !isRecord(config.data) || hasOwn(config, "binaryData") ||
      !exactKeys(config.data, [profile.ret_config_data_key]) ||
      typeof config.data[profile.ret_config_data_key] !== "string" ||
      !isRecord(retConfig) || retConfig.dataKey !== profile.ret_config_data_key ||
      retConfig.dataSha256 !== sha256(Buffer.from(
        config.data[profile.ret_config_data_key], "utf8"
      ))) {
    fail("rotation_bundle_config_binding_drift");
  }

  const imagePairs = bundle?.contract?.imagePairs;
  if (!isRecord(imagePairs)) fail("rotation_bundle_image_binding_drift");
  for (const pair of profile.image_pairs) {
    const deployment = baselineIndex.get(identityKey({
      apiVersion: "apps/v1",
      kind: "Deployment",
      namespace,
      name: pair.deployment
    }));
    const containers = deployment?.spec?.template?.spec?.containers;
    const matches = Array.isArray(containers)
      ? containers.filter(container => container?.name === pair.container)
      : [];
    if (matches.length !== 1 || matches[0].image !==
        imagePairs[`${pair.deployment}/${pair.container}`]) {
      fail("rotation_bundle_image_binding_drift");
    }
  }
}

function assertCandidate(candidate, baseline, target, bundle, profile) {
  if (resourceIdentity(candidate, "rotation_replacement_candidate_invalid") !==
      identityKey(target) || hasOwn(candidate, "status") || !isRecord(candidate.metadata) ||
      hasOwn(candidate.metadata, "managedFields") ||
      hasOwn(candidate.metadata, "generation") ||
      candidate.metadata.uid !== baseline.metadata?.uid ||
      candidate.metadata.resourceVersion !== baseline.metadata?.resourceVersion) {
    fail("rotation_replacement_candidate_invalid");
  }
  if (target.kind === "Deployment") {
    if (!exactKeys(candidate, ["apiVersion", "kind", "metadata", "spec"]) ||
        candidate.spec?.replicas !== 0) {
      fail("rotation_replacement_deployment_invalid");
    }
    return;
  }
  const allowedMetadata = new Set([
    "creationTimestamp", "name", "namespace", "resourceVersion", "uid"
  ]);
  if (!Object.keys(candidate).every(key => [
    "apiVersion", "kind", "metadata", "type", "immutable", "data", "stringData"
  ].includes(key)) || candidate.type !== "Opaque" ||
      (hasOwn(candidate, "immutable") && candidate.immutable !== false) ||
      Object.keys(candidate.metadata).some(key => !allowedMetadata.has(key))) {
    fail("rotation_replacement_secret_invalid");
  }
  const checksums = secretContractValues(candidate, profile);
  if (checksums.database !== bundle.contract.databaseCredentialChecksum ||
      checksums.bot !== bundle.contract.botAccessKeyChecksum ||
      checksums.perms !== bundle.contract.permsPublicKeySha256) {
    fail("rotation_replacement_secret_binding_drift");
  }
}

function replacementFileNames(profile) {
  const names = [
    "00-secret-configs.json",
    ...profile.rotation_revision_deployments.map((name, index) =>
      `${String(index + 1).padStart(2, "0")}-deployment-${name}.json`)
  ];
  if (names.length !== 7 || new Set(names).size !== 7 || names.some(name =>
    !/^[0-9]{2}-(?:secret|deployment)-[a-z0-9](?:[-a-z0-9]*[a-z0-9])?\.json$/u
      .test(name))) {
    fail("rotation_replacement_filename_invalid");
  }
  return names;
}

function privateDirectoryLeaf(inputPath, code) {
  const contract = componentContract(inputPath);
  const leaf = contract.components.at(-1);
  if (!leaf?.directory || !exactMode(leaf, PRIVATE_DIRECTORY_MODE) ||
      !currentUidMatches(leaf)) {
    fail(code);
  }
  return { absolute: contract.absolute, components: contract.components, leaf };
}

function openPinnedPrivateDirectory(inputPath, code) {
  requireFilesystemContracts();
  if (typeof fs.constants.O_DIRECTORY !== "number") {
    fail("private_filesystem_contract_unsupported");
  }
  const before = privateDirectoryLeaf(inputPath, code);
  let descriptor;
  try {
    descriptor = fs.openSync(
      before.absolute,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isDirectory() || opened.isSymbolicLink() ||
        opened.dev !== before.leaf.dev || opened.ino !== before.leaf.ino ||
        !exactMode(opened, PRIVATE_DIRECTORY_MODE) || !currentUidMatches(opened)) {
      fail(code);
    }
    return { ...before, descriptor };
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* Preserve primary failure. */ }
    }
    if (error instanceof MaterializeProcessLocalRotationError) throw error;
    fail(code);
  }
}

function assertPinnedPrivateDirectory(contract, code) {
  let after;
  let opened;
  try {
    after = privateDirectoryLeaf(contract.absolute, code);
    opened = fs.fstatSync(contract.descriptor, { bigint: true });
  } catch (error) {
    if (error instanceof MaterializeProcessLocalRotationError) throw error;
    fail(code);
  }
  if (!sameInputComponents(contract.components, after.components) ||
      !opened.isDirectory() || opened.dev !== contract.leaf.dev ||
      opened.ino !== contract.leaf.ino || !exactMode(opened, PRIVATE_DIRECTORY_MODE) ||
      !currentUidMatches(opened)) {
    fail(code);
  }
}

function closePinnedPrivateDirectory(contract) {
  if (contract?.descriptor !== undefined) {
    try { fs.closeSync(contract.descriptor); } catch { /* Preserve primary result. */ }
  }
}

function operationLayoutContract({
  operationDirectory,
  quiescedBaselinePath,
  bundlePath,
  bindingPath,
  operationKeyPath
}) {
  const operationAbsolute = checkedAbsolute(operationDirectory);
  const bundleDirectory = path.join(operationAbsolute, BUNDLE_DIRECTORY_NAME);
  if (checkedAbsolute(quiescedBaselinePath) !==
        path.join(operationAbsolute, QUIESCED_BASELINE_NAME) ||
      checkedAbsolute(operationKeyPath) !==
        path.join(operationAbsolute, PROCESS_LOCAL_OPERATION_FILES.operationKey) ||
      checkedAbsolute(bundlePath) !== path.join(bundleDirectory, BUNDLE_NAME) ||
      checkedAbsolute(bindingPath) !== path.join(bundleDirectory, BINDING_NAME)) {
    fail("operation_layout_invalid");
  }
  const operation = openPinnedPrivateDirectory(
    operationAbsolute,
    "operation_directory_invalid"
  );
  let bundle;
  try {
    bundle = openPinnedPrivateDirectory(bundleDirectory, "bundle_directory_invalid");
    assertPinnedPrivateDirectory(operation, "operation_directory_changed");
    return { operation, bundle };
  } catch (error) {
    closePinnedPrivateDirectory(bundle);
    closePinnedPrivateDirectory(operation);
    throw error;
  }
}

function assertOperationLayoutStable(contract) {
  assertPinnedPrivateDirectory(contract.operation, "operation_directory_changed");
  assertPinnedPrivateDirectory(contract.bundle, "bundle_directory_changed");
}

function closeOperationLayout(contract) {
  closePinnedPrivateDirectory(contract?.bundle);
  closePinnedPrivateDirectory(contract?.operation);
}

function safeHexEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" ||
      !HEX_SHA256.test(left) || !HEX_SHA256.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function safeOperationIdEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" ||
      !/^[a-f0-9]{32}$/u.test(left) || !/^[a-f0-9]{32}$/u.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function assertIntentBoundToKey(intent, key) {
  if (!isRecord(intent) || !HEX_SHA256.test(intent.operationBindingSha256 || "") ||
      !HEX_SHA256.test(intent.hmacSha256 || "")) {
    fail("operation_intent_invalid");
  }
  const bindingBody = structuredClone(intent);
  delete bindingBody.operationBindingSha256;
  delete bindingBody.hmacSha256;
  const expectedBinding = sha256(Buffer.from(canonicalOperationJson(bindingBody), "utf8"));
  const authenticatedBody = structuredClone(intent);
  delete authenticatedBody.hmacSha256;
  const expectedHmac = createHmac("sha256", key)
    .update(canonicalOperationJson(authenticatedBody), "utf8")
    .digest("hex");
  if (!safeHexEqual(intent.operationBindingSha256, expectedBinding) ||
      !safeHexEqual(intent.hmacSha256, expectedHmac)) {
    fail("operation_intent_binding_invalid");
  }
}

function validArtifactDescriptor(value, name) {
  return exactKeys(value, ["name", "size", "sha256"]) && value.name === name &&
    Number.isSafeInteger(value.size) && value.size > 0 &&
    HEX_SHA256.test(value.sha256 || "");
}

function assertAuthenticatedBinding({
  binding,
  bindingSource,
  bundle,
  bundleSource,
  baselineSource,
  intent,
  operationKey,
  profile
}) {
  if (!exactKeys(binding, [
    "schemaVersion", "contractId", "profileId", "rotationRevision", "namespace",
    "operationBindingSha256", "inputs", "files", "externalOperationKey",
    "profileSha256", "liveResourceBindingsSha256", "applyAttestationSha256",
    "retConfigDataSha256", "hmacSha256"
  ]) || binding.schemaVersion !== 1 ||
      binding.contractId !== "yenhubs-aud065-offline-bundle-v1" ||
      !exactKeys(binding.inputs, [
        "originalBaselineSha256", "quiescedBaselineSha256", "oldSnapshotSha256",
        "newSnapshotSha256", "revisionSha256"
      ]) || Object.values(binding.inputs).some(value => !HEX_SHA256.test(value || "")) ||
      !exactKeys(binding.files, ["bundle", "redacted", "restart"]) ||
      !validArtifactDescriptor(binding.files.bundle, BUNDLE_NAME) ||
      !validArtifactDescriptor(binding.files.redacted, "redacted.json") ||
      !validArtifactDescriptor(binding.files.restart, "restart-contract.json") ||
      !exactKeys(binding.externalOperationKey, ["size", "hmacBound"]) ||
      binding.externalOperationKey.size !== OPERATION_KEY_BYTES ||
      binding.externalOperationKey.hmacBound !== true ||
      !HEX_SHA256.test(binding.profileSha256 || "") ||
      !HEX_SHA256.test(binding.liveResourceBindingsSha256 || "") ||
      !HEX_SHA256.test(binding.applyAttestationSha256 || "") ||
      !HEX_SHA256.test(binding.retConfigDataSha256 || "") ||
      !HEX_SHA256.test(binding.hmacSha256 || "")) {
    fail("rotation_bundle_binding_invalid");
  }
  const expectedRevisionBytes = canonicalBytes({ rotationRevision: intent.rotationRevision });
  const expectedProfileSha = sha256(Buffer.from(canonicalJson(profile), "utf8"));
  const expectedLiveBindingsSha = sha256(Buffer.from(
    canonicalJson(bundle?.contract?.liveResourceBindings),
    "utf8"
  ));
  if (binding.profileId !== profile.profile_id || bundle.profileId !== profile.profile_id ||
      binding.rotationRevision !== intent.rotationRevision ||
      bundle.rotationRevision !== intent.rotationRevision ||
      binding.namespace !== intent.namespaceName ||
      bundleNamespace(bundle) !== intent.namespaceName ||
      !safeHexEqual(binding.operationBindingSha256, intent.operationBindingSha256) ||
      !safeHexEqual(binding.inputs.originalBaselineSha256,
        intent.originalBaselineSha256) ||
      !safeHexEqual(binding.inputs.oldSnapshotSha256, intent.oldSnapshotSha256) ||
      !safeHexEqual(binding.inputs.newSnapshotSha256, intent.newSnapshotSha256) ||
      !safeHexEqual(binding.inputs.revisionSha256, sha256(expectedRevisionBytes)) ||
      !safeHexEqual(binding.inputs.quiescedBaselineSha256,
        sha256(baselineSource.bytes)) ||
      binding.files.bundle.size !== bundleSource.bytes.length ||
      !safeHexEqual(binding.files.bundle.sha256, sha256(bundleSource.bytes)) ||
      !safeHexEqual(binding.profileSha256, expectedProfileSha) ||
      !safeHexEqual(binding.liveResourceBindingsSha256, expectedLiveBindingsSha) ||
      !safeHexEqual(binding.retConfigDataSha256,
        bundle?.contract?.retConfigBinding?.dataSha256)) {
    fail("rotation_bundle_binding_drift");
  }
  const authenticatedBody = structuredClone(binding);
  delete authenticatedBody.hmacSha256;
  const expectedHmac = createHmac("sha256", operationKey)
    .update(canonicalJson(authenticatedBody), "utf8")
    .digest("hex");
  if (!safeHexEqual(binding.hmacSha256, expectedHmac)) {
    fail("rotation_bundle_binding_hmac_invalid");
  }
  if (!bindingSource.bytes.equals(canonicalBytes(binding))) {
    fail("rotation_bundle_binding_not_canonical");
  }
}

function assertExpectedOperationIdentity(intent, options) {
  const expectedOperationId = options?.expectedOperationId;
  const expectedOperationBindingSha256 = options?.expectedOperationBindingSha256;
  if (expectedOperationId === undefined &&
      expectedOperationBindingSha256 === undefined) return;
  if (!/^[a-f0-9]{32}$/u.test(expectedOperationId || "") ||
      !HEX_SHA256.test(expectedOperationBindingSha256 || "") ||
      !safeOperationIdEqual(intent.operationId, expectedOperationId) ||
      !safeHexEqual(
        intent.operationBindingSha256,
        expectedOperationBindingSha256
      )) {
    fail("operation_expected_identity_mismatch");
  }
}

function loadMaterializationState({
  operationDirectory,
  quiescedBaselinePath,
  bundlePath,
  bindingPath,
  operationKeyPath,
  hooks,
  expectedOperationId,
  expectedOperationBindingSha256
}) {
  const layout = operationLayoutContract({
    operationDirectory,
    quiescedBaselinePath,
    bundlePath,
    bindingPath,
    operationKeyPath
  });
  let operationKeySource;
  try {
    const intent = loadVerifiedProcessLocalRotationIntent({ operationDirectory });
    assertExpectedOperationIdentity(intent, {
      expectedOperationId,
      expectedOperationBindingSha256
    });
    assertOperationLayoutStable(layout);
    operationKeySource = readPrivateFile(
      operationKeyPath,
      OPERATION_KEY_BYTES,
      hooks,
      PROCESS_LOCAL_OPERATION_FILES.operationKey,
      { binary: true }
    );
    if (operationKeySource.bytes.length !== OPERATION_KEY_BYTES) {
      fail("operation_key_invalid");
    }
    assertIntentBoundToKey(intent, operationKeySource.bytes);
    const baselineSource = readPrivateFile(
      quiescedBaselinePath,
      MAX_BASELINE_BYTES,
      hooks,
      QUIESCED_BASELINE_NAME
    );
    const bundleSource = readPrivateFile(
      bundlePath,
      MAX_BUNDLE_BYTES,
      hooks,
      BUNDLE_NAME
    );
    const bindingSource = readPrivateFile(
      bindingPath,
      MAX_BINDING_BYTES,
      hooks,
      BINDING_NAME
    );
    assertOperationLayoutStable(layout);
  const baselineResources = parseBaseline(
    baselineSource,
    "quiesced_baseline_json_invalid"
  );
  const bundle = parseCanonicalBundle(bundleSource);
    const binding = parseJson(bindingSource, "rotation_bundle_binding_json_invalid");
  const profile = loadProcessLocalRotationProfile();
    assertAuthenticatedBinding({
      binding,
      bindingSource,
      bundle,
      bundleSource,
      baselineSource,
      intent,
      operationKey: operationKeySource.bytes,
      profile
    });
  const namespace = bundleNamespace(bundle);
  const baselineIndex = indexFullInventory(
    baselineResources,
    namespace,
    profile,
    "quiesced_baseline_inventory_invalid"
  );
  assertBundleBoundToBaseline(bundle, baselineIndex, profile);
  const targets = exactTargetResources(
    baselineResources,
    namespace,
    profile,
    "quiesced_baseline_inventory_invalid"
  );
  const targetDescriptions = targetIdentities(namespace, profile);
  const candidates = targets.map((baselineResource, index) => {
    const candidate = projectProcessLocalRotationReplacement({
      baselineResource,
      bundle,
      profile
    });
    assertCandidate(
      candidate,
      baselineResource,
      targetDescriptions[index],
      bundle,
      profile
    );
    return candidate;
  });
    const state = {
      baselineResources,
      bundle,
      profile,
      namespace,
      targets,
      candidates,
      names: replacementFileNames(profile),
      attestationInputs: {
        expectedKubeContext: intent.expectedKubeContext,
        namespaceName: intent.namespaceName,
        namespaceUid: intent.namespaceUid,
        retPvcName: intent.retPvcName,
        retPvcUid: intent.retPvcUid,
        checkpointStamp: intent.checkpointStamp,
        checkpointDumpSha256: intent.checkpointDumpSha256,
        checkpointStorageSha256: intent.checkpointStorageSha256,
        checkpointInventorySha256: intent.checkpointInventorySha256,
        operationId: intent.operationId,
        operationBindingSha256: intent.operationBindingSha256,
        bundleBindingHmacSha256: binding.hmacSha256
      }
    };
    runHook(hooks, "afterAuthenticatedInputs", {
      operationDirectory: layout.operation.absolute,
      namespace,
      rotationRevision: bundle.rotationRevision
    });
    assertOperationLayoutStable(layout);
    return state;
  } finally {
    if (operationKeySource?.bytes) operationKeySource.bytes.fill(0);
    closeOperationLayout(layout);
  }
}

function outputParentContract(outputPath) {
  const absolute = checkedAbsolute(outputPath);
  const parentPath = path.dirname(absolute);
  const parentComponents = componentContract(parentPath);
  const parent = parentComponents.components.at(-1);
  if (!parent?.directory || !exactMode(parent, PRIVATE_DIRECTORY_MODE) ||
      !currentUidMatches(parent)) {
    fail("private_output_parent_invalid");
  }
  return {
    absolute,
    parent: {
      absolute: parentPath,
      dev: parent.dev,
      ino: parent.ino
    }
  };
}

function assertParentIdentity(parent) {
  const current = componentContract(parent.absolute);
  const leaf = current.components.at(-1);
  if (!leaf?.directory || leaf.dev !== parent.dev || leaf.ino !== parent.ino ||
      !exactMode(leaf, PRIVATE_DIRECTORY_MODE) || !currentUidMatches(leaf)) {
    fail("private_output_parent_changed");
  }
}

function createPrivateDirectory(outputDirectory) {
  requireFilesystemContracts();
  const contract = outputParentContract(outputDirectory);
  let stat;
  try {
    try {
      stat = fs.lstatSync(contract.absolute, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() ||
          !exactMode(stat, PRIVATE_DIRECTORY_MODE) || !currentUidMatches(stat)) {
        fail("private_output_invalid");
      }
      assertParentIdentity(contract.parent);
      syncParent(contract.parent);
      return {
        absolute: contract.absolute,
        dev: stat.dev,
        ino: stat.ino,
        parent: contract.parent
      };
    } catch (error) {
      if (error instanceof MaterializeProcessLocalRotationError) throw error;
      if (error?.code !== "ENOENT") fail("private_output_invalid");
    }
    fs.mkdirSync(contract.absolute, { mode: PRIVATE_DIRECTORY_MODE });
    stat = fs.lstatSync(contract.absolute, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("private_output_invalid");
    fs.chmodSync(contract.absolute, PRIVATE_DIRECTORY_MODE);
    assertParentIdentity(contract.parent);
    syncParent(contract.parent);
    stat = fs.lstatSync(contract.absolute, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        !exactMode(stat, PRIVATE_DIRECTORY_MODE) || !currentUidMatches(stat)) {
      fail("private_output_invalid");
    }
    return {
      absolute: contract.absolute,
      dev: stat.dev,
      ino: stat.ino,
      parent: contract.parent
    };
  } catch (error) {
    if (error instanceof MaterializeProcessLocalRotationError) throw error;
    fail("private_output_invalid");
  }
}

function assertDirectoryIdentity(directory) {
  assertParentIdentity(directory.parent);
  let stat;
  try {
    stat = fs.lstatSync(directory.absolute, { bigint: true });
  } catch (_error) {
    fail("private_output_changed");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== directory.dev ||
      stat.ino !== directory.ino || !exactMode(stat, PRIVATE_DIRECTORY_MODE) ||
      !currentUidMatches(stat)) {
    fail("private_output_changed");
  }
}

function assertOpenedArtifact(
  directory,
  artifact,
  descriptor,
  expectedSize,
  expectedLinks = 1n
) {
  assertDirectoryIdentity(directory);
  let opened;
  let leaf;
  try {
    opened = fs.fstatSync(descriptor, { bigint: true });
    leaf = fs.lstatSync(artifact.path, { bigint: true });
  } catch (_error) {
    fail("private_artifact_path_changed");
  }
  if (!opened.isFile() || !leaf.isFile() || leaf.isSymbolicLink() ||
      opened.dev !== artifact.dev || opened.ino !== artifact.ino ||
      leaf.dev !== artifact.dev || leaf.ino !== artifact.ino ||
      opened.nlink !== expectedLinks || leaf.nlink !== expectedLinks ||
      !exactMode(opened, PRIVATE_FILE_MODE) || !exactMode(leaf, PRIVATE_FILE_MODE) ||
      !currentUidMatches(opened) || !currentUidMatches(leaf) ||
      opened.size !== BigInt(expectedSize) || leaf.size !== BigInt(expectedSize)) {
    fail("private_artifact_path_changed");
  }
}

function writeAll(descriptor, bytes, fileOffset = 0) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = fs.writeSync(
      descriptor,
      bytes,
      offset,
      bytes.length - offset,
      fileOffset + offset
    );
    if (!Number.isInteger(count) || count <= 0) fail("private_artifact_write_failed");
    offset += count;
  }
}

function pendingArtifactPrefix(name) {
  return `${PENDING_PREFIX}${name}.`;
}

function pendingArtifactName(prefix) {
  return `${prefix}${randomBytes(16).toString("hex")}`;
}

function directoryPendingPrefix(directory, name) {
  return `${PENDING_PREFIX}${path.basename(directory.absolute)}-${name}.`;
}

function matchingPendingEntries(directory, name) {
  assertDirectoryIdentity(directory);
  const prefix = directoryPendingPrefix(directory, name);
  let entries;
  try {
    entries = fs.readdirSync(directory.parent.absolute);
  } catch (_error) {
    fail("private_artifact_inventory_invalid");
  }
  return entries.filter(entry => entry.startsWith(prefix) &&
    /^[a-f0-9]{32}$/u.test(entry.slice(prefix.length)));
}

function unlinkVerifiedPending({
  pendingPath,
  expectedDev,
  expectedIno,
  hooks,
  name,
  finalPath
}) {
  runHook(hooks, "beforePendingUnlink", { name, path: pendingPath, finalPath });
  let current;
  try {
    current = fs.lstatSync(pendingPath, { bigint: true });
  } catch (_error) {
    fail("private_artifact_path_changed");
  }
  if (!current.isFile() || current.isSymbolicLink() || current.dev !== expectedDev ||
      current.ino !== expectedIno || current.nlink !== 2n ||
      !exactMode(current, PRIVATE_FILE_MODE) || !currentUidMatches(current)) {
    fail("private_artifact_path_changed");
  }
  try {
    fs.unlinkSync(pendingPath);
  } catch (_error) {
    fail("private_artifact_publish_failed");
  }
}

function verifyArtifactBytes(directory, artifactPath, bytes, expectedLinks) {
  let descriptor;
  try {
    assertDirectoryIdentity(directory);
    const before = fs.lstatSync(artifactPath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() ||
        before.nlink !== expectedLinks || !exactMode(before, PRIVATE_FILE_MODE) ||
        !currentUidMatches(before) || before.size !== BigInt(bytes.length)) {
      fail("private_artifact_invalid");
    }
    descriptor = fs.openSync(
      artifactPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.nlink !== expectedLinks || !exactMode(opened, PRIVATE_FILE_MODE) ||
        !currentUidMatches(opened) || opened.size !== BigInt(bytes.length)) {
      fail("private_artifact_invalid");
    }
    const actual = readExactBytes(descriptor, bytes.length);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const afterPath = fs.lstatSync(artifactPath, { bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino ||
        after.size !== opened.size || after.mtimeNs !== opened.mtimeNs ||
        after.ctimeNs !== opened.ctimeNs || after.nlink !== expectedLinks ||
        afterPath.dev !== opened.dev || afterPath.ino !== opened.ino ||
        afterPath.nlink !== expectedLinks || !timingSafeEqual(actual, bytes)) {
      fail("private_artifact_mismatch");
    }
    assertDirectoryIdentity(directory);
    return before;
  } catch (error) {
    if (error instanceof MaterializeProcessLocalRotationError) throw error;
    fail("private_artifact_invalid");
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* Preserve primary result. */ }
    }
  }
}

function reconcileDirectoryArtifact(directory, name, bytes, hooks) {
  const target = path.join(directory.absolute, name);
  const pending = matchingPendingEntries(directory, name);
  let targetStat;
  try {
    targetStat = fs.lstatSync(target, { bigint: true });
  } catch (error) {
    if (error?.code !== "ENOENT") fail("private_artifact_invalid");
  }
  if (!targetStat) {
    // A crash before link may leave a partial or complete sibling temp. It is
    // not authenticated ownership evidence, so preserve and ignore it.
    return false;
  }
  if (targetStat.nlink === 1n) {
    verifyArtifactBytes(directory, target, bytes, 1n);
    return true;
  }
  if (targetStat.nlink !== 2n) {
    fail("private_artifact_reentry_ambiguous");
  }
  const linkedPending = pending.filter(entry => {
    try {
      const stat = fs.lstatSync(path.join(directory.parent.absolute, entry), {
        bigint: true
      });
      return stat.dev === targetStat.dev && stat.ino === targetStat.ino;
    } catch {
      return false;
    }
  });
  if (linkedPending.length !== 1) {
    fail("private_artifact_reentry_ambiguous");
  }
  const pendingPath = path.join(directory.parent.absolute, linkedPending[0]);
  verifyArtifactBytes(directory, target, bytes, 2n);
  verifyArtifactBytes(directory, pendingPath, bytes, 2n);
  try {
    syncDirectory(directory);
    unlinkVerifiedPending({
      pendingPath,
      expectedDev: targetStat.dev,
      expectedIno: targetStat.ino,
      hooks,
      name,
      finalPath: target
    });
    syncParent(directory.parent);
  } catch (_error) {
    fail("private_artifact_publish_failed");
  }
  verifyArtifactBytes(directory, target, bytes, 1n);
  return true;
}

function writeDirectoryArtifact(directory, name, bytes, hooks) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || path.basename(name) !== name) {
    fail("private_artifact_invalid");
  }
  if (reconcileDirectoryArtifact(directory, name, bytes, hooks)) return;
  assertDirectoryIdentity(directory);
  const target = path.join(directory.absolute, name);
  const pending = path.join(
    directory.parent.absolute,
    pendingArtifactName(directoryPendingPrefix(directory, name))
  );
  let descriptor;
  let artifact;
  try {
    descriptor = fs.openSync(
      pending,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    artifact = { path: pending, dev: opened.dev, ino: opened.ino };
    fs.fchmodSync(descriptor, PRIVATE_FILE_MODE);
    assertOpenedArtifact(directory, artifact, descriptor, 0);
    runHook(hooks, "afterArtifactOpened", { name, path: pending, finalPath: target });
    const cut = Math.max(1, Math.floor(bytes.length / 2));
    writeAll(descriptor, bytes.subarray(0, cut), 0);
    runHook(hooks, "afterArtifactPartialWrite", {
      name,
      path: pending,
      finalPath: target
    });
    writeAll(descriptor, bytes.subarray(cut), cut);
    fs.fsyncSync(descriptor);
    assertOpenedArtifact(directory, artifact, descriptor, bytes.length);
    runHook(hooks, "afterArtifactFsync", { name, path: pending, finalPath: target });
    fs.linkSync(pending, target);
    assertOpenedArtifact(directory, artifact, descriptor, bytes.length, 2n);
    const targetStat = fs.lstatSync(target, { bigint: true });
    if (targetStat.dev !== artifact.dev || targetStat.ino !== artifact.ino ||
        targetStat.nlink !== 2n) fail("private_artifact_publish_failed");
    runHook(hooks, "afterArtifactLinked", { name, path: pending, finalPath: target });
    syncDirectory(directory);
    unlinkVerifiedPending({
      pendingPath: pending,
      expectedDev: artifact.dev,
      expectedIno: artifact.ino,
      hooks,
      name,
      finalPath: target
    });
    syncParent(directory.parent);
    verifyArtifactBytes(directory, target, bytes, 1n);
  } catch (error) {
    if (error instanceof MaterializeProcessLocalRotationError) throw error;
    fail("private_artifact_write_failed");
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the value-free primary error.
      }
    }
  }
}

function syncDirectory(directory) {
  assertDirectoryIdentity(directory);
  let descriptor;
  try {
    const directoryFlag = typeof fs.constants.O_DIRECTORY === "number"
      ? fs.constants.O_DIRECTORY
      : 0;
    descriptor = fs.openSync(
      directory.absolute,
      fs.constants.O_RDONLY | directoryFlag | fs.constants.O_NOFOLLOW
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isDirectory() || opened.dev !== directory.dev || opened.ino !== directory.ino) {
      fail("private_output_sync_failed");
    }
    fs.fsyncSync(descriptor);
    assertDirectoryIdentity(directory);
  } catch (error) {
    if (error instanceof MaterializeProcessLocalRotationError) throw error;
    fail("private_output_sync_failed");
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the value-free primary error.
      }
    }
  }
}

function assertDirectoryInventory(directory, names) {
  assertDirectoryIdentity(directory);
  let entries;
  try {
    entries = fs.readdirSync(directory.absolute).sort();
  } catch (_error) {
    fail("private_artifact_inventory_invalid");
  }
  if (JSON.stringify(entries) !== JSON.stringify([...names].sort())) {
    fail("private_artifact_inventory_invalid");
  }
  for (const name of entries) {
    let stat;
    try {
      stat = fs.lstatSync(path.join(directory.absolute, name), { bigint: true });
    } catch (_error) {
      fail("private_artifact_inventory_invalid");
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n ||
        !exactMode(stat, PRIVATE_FILE_MODE) || !currentUidMatches(stat)) {
      fail("private_artifact_inventory_invalid");
    }
  }
}

function existingPrivateDirectory(outputDirectory) {
  const absolute = checkedAbsolute(outputDirectory);
  const contract = componentContract(absolute);
  const leaf = contract.components.at(-1);
  const parentContract = componentContract(path.dirname(absolute));
  const parent = parentContract.components.at(-1);
  if (!leaf?.directory || !exactMode(leaf, PRIVATE_DIRECTORY_MODE) ||
      !currentUidMatches(leaf) || !parent?.directory ||
      !exactMode(parent, PRIVATE_DIRECTORY_MODE) || !currentUidMatches(parent)) {
    fail("private_output_invalid");
  }
  return {
    absolute,
    dev: leaf.dev,
    ino: leaf.ino,
    parent: {
      absolute: path.dirname(absolute),
      dev: parent.dev,
      ino: parent.ino
    }
  };
}

function wrapFailure(code, error) {
  fail(code, error?.code);
}

export function materializeProcessLocalRotationReplacements(options) {
  try {
    const state = loadMaterializationState(options);
    const directory = createPrivateDirectory(options.outputDirectory);
    for (const [index, candidate] of state.candidates.entries()) {
      writeDirectoryArtifact(
        directory,
        state.names[index],
        canonicalBytes(candidate),
        options.hooks
      );
    }
    assertDirectoryInventory(directory, state.names);
    syncDirectory(directory);
    assertDirectoryInventory(directory, state.names);
    return true;
  } catch (error) {
    wrapFailure("process_local_rotation_materialize_failed", error);
  }
}

export function verifyProcessLocalRotationReplacements(options) {
  try {
    const state = loadMaterializationState(options);
    const directory = existingPrivateDirectory(options.outputDirectory);
    for (const [index, name] of state.names.entries()) {
      const expected = canonicalBytes(state.candidates[index]);
      reconcileDirectoryArtifact(directory, name, expected, options.hooks);
      const source = readPrivateFile(
        path.join(directory.absolute, name),
        MAX_REPLACEMENT_BYTES,
        options.hooks,
        name
      );
      if (!source.bytes.equals(expected)) {
        fail("rotation_replacement_artifact_mismatch");
      }
    }
    assertDirectoryInventory(directory, state.names);
    return true;
  } catch (error) {
    wrapFailure("process_local_rotation_verify_failed", error);
  }
}

export function loadVerifiedProcessLocalOperationalAttestationInputs(options) {
  try {
    return structuredClone(loadMaterializationState(options).attestationInputs);
  } catch (error) {
    wrapFailure("process_local_rotation_attestation_inputs_failed", error);
  }
}

export function emitVerifiedProcessLocalDeploymentContract(options) {
  try {
    if (typeof options?.deployment !== "string" ||
        !DNS_LABEL.test(options.deployment)) {
      fail("rotation_deployment_name_invalid");
    }
    const state = loadMaterializationState(options);
    const index = state.candidates.findIndex(candidate =>
      candidate.kind === "Deployment" &&
      candidate.metadata?.namespace === state.namespace &&
      candidate.metadata?.name === options.deployment
    );
    if (index === -1) fail("rotation_deployment_name_invalid");
    const candidate = state.candidates[index];
    const baseline = state.targets[index];
    const selector = candidate.spec?.selector?.matchLabels?.app;
    const contract = {
      selector: candidate.spec?.selector,
      strategy: candidate.spec?.strategy || {},
      template: candidate.spec?.template
    };
    const fingerprint = Buffer.from(canonicalJson(contract), "utf8").toString("base64");
    const fields = [
      candidate.metadata?.uid,
      baseline.metadata?.resourceVersion,
      String(candidate.spec?.replicas),
      selector,
      fingerprint
    ];
    if (fields.some(value => typeof value !== "string" || value.length < 1 ||
        /[\t\r\n\u0000]/u.test(value)) || fields[2] !== "0") {
      fail("rotation_deployment_contract_invalid");
    }
    return Buffer.from(`${fields.join("\t")}\n`, "utf8");
  } catch (error) {
    wrapFailure("process_local_rotation_deployment_contract_failed", error);
  }
}

export function emitVerifiedProcessLocalRotationReplacement(options) {
  try {
    const state = loadMaterializationState(options);
    const index = state.names.indexOf(options.name);
    if (index === -1) fail("rotation_replacement_name_invalid");
    const directory = existingPrivateDirectory(options.outputDirectory);
    const expected = canonicalBytes(state.candidates[index]);
    reconcileDirectoryArtifact(directory, options.name, expected, options.hooks);
    assertDirectoryInventory(directory, state.names);
    const source = readPrivateFile(
      path.join(directory.absolute, options.name),
      MAX_REPLACEMENT_BYTES,
      options.hooks,
      options.name
    );
    if (!source.bytes.equals(expected)) {
      fail("rotation_replacement_artifact_mismatch");
    }
    runHook(options.hooks, "afterVerifiedArtifact", {
      name: options.name,
      path: path.join(directory.absolute, options.name)
    });
    return Buffer.from(source.bytes);
  } catch (error) {
    wrapFailure("process_local_rotation_emit_verified_failed", error);
  }
}

function safeClassificationPlan(plan) {
  if (!isRecord(plan) || plan.schemaVersion !== 1 || plan.resourceCount !== 7 ||
      !Number.isInteger(plan.pendingCount) ||
      !Number.isInteger(plan.alreadyAppliedCount) ||
      typeof plan.complete !== "boolean" || !Array.isArray(plan.resources) ||
      plan.resources.length !== 7) {
    fail("rotation_classification_plan_invalid");
  }
  const resources = plan.resources.map(resource => {
    if (!isRecord(resource) || !["Secret", "Deployment"].includes(resource.kind) ||
        !["pending", "already-applied"].includes(resource.state) ||
        ![resource.apiVersion, resource.namespace, resource.name, resource.uid,
          resource.baselineResourceVersion, resource.liveResourceVersion]
          .every(value => typeof value === "string" && value.length > 0)) {
      fail("rotation_classification_plan_invalid");
    }
    return {
      apiVersion: resource.apiVersion,
      kind: resource.kind,
      namespace: resource.namespace,
      name: resource.name,
      uid: resource.uid,
      baselineResourceVersion: resource.baselineResourceVersion,
      liveResourceVersion: resource.liveResourceVersion,
      state: resource.state
    };
  });
  return {
    schemaVersion: 1,
    resourceCount: 7,
    pendingCount: plan.pendingCount,
    alreadyAppliedCount: plan.alreadyAppliedCount,
    complete: plan.complete,
    resources
  };
}

function loadClassificationState(options) {
  const materialization = loadMaterializationState(options);
  const liveSource = readPrivateFile(
    options.liveBaselinePath,
    MAX_BASELINE_BYTES,
    options.hooks,
    "live-baseline.json"
  );
  const liveResources = parseBaseline(liveSource, "live_baseline_json_invalid");
  const liveTargets = exactTargetResources(
    liveResources,
    materialization.namespace,
    materialization.profile,
    "live_baseline_inventory_invalid"
  );
  const classified = classifyProcessLocalRotationReentry({
    baselineResources: materialization.baselineResources,
    liveResources: liveTargets,
    bundle: materialization.bundle,
    profile: materialization.profile
  });
  return {
    ...materialization,
    liveResources,
    liveTargets,
    plan: safeClassificationPlan(classified)
  };
}

export function classifyProcessLocalRotationFiles(options) {
  try {
    return loadClassificationState(options).plan;
  } catch (error) {
    wrapFailure("process_local_rotation_classify_failed", error);
  }
}

function assertOwnedFile(artifact, descriptor, expectedSize, expectedLinks = 1n) {
  let opened;
  let leaf;
  try {
    opened = fs.fstatSync(descriptor, { bigint: true });
    leaf = fs.lstatSync(artifact.path, { bigint: true });
  } catch (_error) {
    fail("private_artifact_path_changed");
  }
  assertParentIdentity(artifact.parent);
  if (!opened.isFile() || !leaf.isFile() || leaf.isSymbolicLink() ||
      opened.dev !== artifact.dev || opened.ino !== artifact.ino ||
      leaf.dev !== artifact.dev || leaf.ino !== artifact.ino ||
      opened.nlink !== expectedLinks || leaf.nlink !== expectedLinks ||
      !exactMode(opened, PRIVATE_FILE_MODE) || !exactMode(leaf, PRIVATE_FILE_MODE) ||
      !currentUidMatches(opened) || !currentUidMatches(leaf) ||
      opened.size !== BigInt(expectedSize) || leaf.size !== BigInt(expectedSize)) {
    fail("private_artifact_path_changed");
  }
}

function syncParent(parent) {
  assertParentIdentity(parent);
  let descriptor;
  try {
    const directoryFlag = typeof fs.constants.O_DIRECTORY === "number"
      ? fs.constants.O_DIRECTORY
      : 0;
    descriptor = fs.openSync(
      parent.absolute,
      fs.constants.O_RDONLY | directoryFlag | fs.constants.O_NOFOLLOW
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isDirectory() || opened.dev !== parent.dev || opened.ino !== parent.ino) {
      fail("private_output_sync_failed");
    }
    fs.fsyncSync(descriptor);
    assertParentIdentity(parent);
  } catch (error) {
    if (error instanceof MaterializeProcessLocalRotationError) throw error;
    fail("private_output_sync_failed");
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the value-free primary error.
      }
    }
  }
}

function verifyParentArtifactBytes(contract, filePath, bytes, expectedLinks) {
  let descriptor;
  try {
    assertParentIdentity(contract.parent);
    const before = fs.lstatSync(filePath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() ||
        before.nlink !== expectedLinks || !exactMode(before, PRIVATE_FILE_MODE) ||
        !currentUidMatches(before) || before.size !== BigInt(bytes.length)) {
      fail("private_artifact_invalid");
    }
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.nlink !== expectedLinks || !exactMode(opened, PRIVATE_FILE_MODE) ||
        !currentUidMatches(opened) || opened.size !== BigInt(bytes.length)) {
      fail("private_artifact_invalid");
    }
    const actual = readExactBytes(descriptor, bytes.length);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const leaf = fs.lstatSync(filePath, { bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino ||
        after.size !== opened.size || after.mtimeNs !== opened.mtimeNs ||
        after.ctimeNs !== opened.ctimeNs || after.nlink !== expectedLinks ||
        leaf.dev !== opened.dev || leaf.ino !== opened.ino ||
        leaf.nlink !== expectedLinks || !timingSafeEqual(actual, bytes)) {
      fail("private_artifact_mismatch");
    }
    assertParentIdentity(contract.parent);
    return before;
  } catch (error) {
    if (error instanceof MaterializeProcessLocalRotationError) throw error;
    fail("private_artifact_invalid");
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* Preserve primary result. */ }
    }
  }
}

function matchingParentPendingEntries(contract) {
  const prefix = pendingArtifactPrefix(path.basename(contract.absolute));
  let entries;
  try {
    assertParentIdentity(contract.parent);
    entries = fs.readdirSync(contract.parent.absolute);
  } catch (_error) {
    fail("private_artifact_inventory_invalid");
  }
  return entries.filter(entry => entry.startsWith(prefix) &&
    /^[a-f0-9]{32}$/u.test(entry.slice(prefix.length)));
}

function reconcilePrivateFile(outputPath, bytes, hooks) {
  const contract = outputParentContract(outputPath);
  const pending = matchingParentPendingEntries(contract);
  let final;
  try {
    final = fs.lstatSync(contract.absolute, { bigint: true });
  } catch (error) {
    if (error?.code !== "ENOENT") fail("private_artifact_invalid");
  }
  if (!final) {
    // Preserve pre-link temps: without a final hardlink they are not proven to
    // belong to this invocation. A fresh temp can safely make progress.
    return { contract, complete: false };
  }
  if (final.nlink === 1n) {
    verifyParentArtifactBytes(contract, contract.absolute, bytes, 1n);
    return { contract, complete: true };
  }
  if (final.nlink !== 2n) {
    fail("private_artifact_reentry_ambiguous");
  }
  const linkedPending = pending.filter(entry => {
    try {
      const stat = fs.lstatSync(path.join(contract.parent.absolute, entry), {
        bigint: true
      });
      return stat.dev === final.dev && stat.ino === final.ino;
    } catch {
      return false;
    }
  });
  if (linkedPending.length !== 1) {
    fail("private_artifact_reentry_ambiguous");
  }
  const pendingPath = path.join(contract.parent.absolute, linkedPending[0]);
  verifyParentArtifactBytes(contract, contract.absolute, bytes, 2n);
  verifyParentArtifactBytes(contract, pendingPath, bytes, 2n);
  try {
    syncParent(contract.parent);
    unlinkVerifiedPending({
      pendingPath,
      expectedDev: final.dev,
      expectedIno: final.ino,
      hooks,
      name: path.basename(contract.absolute),
      finalPath: contract.absolute
    });
    syncParent(contract.parent);
  } catch (_error) {
    fail("private_artifact_publish_failed");
  }
  verifyParentArtifactBytes(contract, contract.absolute, bytes, 1n);
  return { contract, complete: true };
}

function writeExclusivePrivateFile(outputPath, bytes, hooks) {
  requireFilesystemContracts();
  const reconciled = reconcilePrivateFile(outputPath, bytes, hooks);
  if (reconciled.complete) return true;
  const contract = reconciled.contract;
  const pendingPath = path.join(
    contract.parent.absolute,
    pendingArtifactName(pendingArtifactPrefix(path.basename(contract.absolute)))
  );
  let descriptor;
  let artifact;
  try {
    descriptor = fs.openSync(
      pendingPath,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    artifact = {
      path: pendingPath,
      dev: opened.dev,
      ino: opened.ino,
      parent: contract.parent
    };
    fs.fchmodSync(descriptor, PRIVATE_FILE_MODE);
    assertOwnedFile(artifact, descriptor, 0);
    runHook(hooks, "afterArtifactOpened", {
      name: path.basename(contract.absolute),
      path: pendingPath,
      finalPath: contract.absolute
    });
    const cut = Math.max(1, Math.floor(bytes.length / 2));
    writeAll(descriptor, bytes.subarray(0, cut), 0);
    runHook(hooks, "afterArtifactPartialWrite", {
      name: path.basename(contract.absolute),
      path: pendingPath,
      finalPath: contract.absolute
    });
    writeAll(descriptor, bytes.subarray(cut), cut);
    fs.fsyncSync(descriptor);
    assertOwnedFile(artifact, descriptor, bytes.length);
    runHook(hooks, "afterArtifactFsync", {
      name: path.basename(contract.absolute),
      path: pendingPath,
      finalPath: contract.absolute
    });
    fs.linkSync(pendingPath, contract.absolute);
    assertOwnedFile(artifact, descriptor, bytes.length, 2n);
    const final = fs.lstatSync(contract.absolute, { bigint: true });
    if (final.dev !== artifact.dev || final.ino !== artifact.ino || final.nlink !== 2n) {
      fail("private_artifact_publish_failed");
    }
    runHook(hooks, "afterArtifactLinked", {
      name: path.basename(contract.absolute),
      path: pendingPath,
      finalPath: contract.absolute
    });
    syncParent(contract.parent);
    unlinkVerifiedPending({
      pendingPath,
      expectedDev: artifact.dev,
      expectedIno: artifact.ino,
      hooks,
      name: path.basename(contract.absolute),
      finalPath: contract.absolute
    });
    syncParent(contract.parent);
    verifyParentArtifactBytes(contract, contract.absolute, bytes, 1n);
    return true;
  } catch (error) {
    if (error instanceof MaterializeProcessLocalRotationError) throw error;
    fail("private_artifact_write_failed");
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* Preserve primary result. */ }
    }
  }
}

export function extractAppliedProcessLocalRotationResources(options) {
  try {
    const state = loadClassificationState(options);
    if (!state.plan.complete || state.plan.pendingCount !== 0 ||
        state.plan.alreadyAppliedCount !== 7) {
      fail("rotation_applied_inventory_incomplete");
    }
    const list = {
      apiVersion: "v1",
      kind: "List",
      items: state.liveTargets
    };
    writeExclusivePrivateFile(options.outputPath, canonicalBytes(list), options.hooks);
    return true;
  } catch (error) {
    wrapFailure("process_local_rotation_extract_applied_failed", error);
  }
}

function parseFlags(argv, allowed) {
  if (argv.length !== allowed.size * 2) fail("arguments_invalid");
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || values.has(flag) || typeof value !== "string" ||
        value.length === 0 || value.startsWith("--")) {
      fail("arguments_invalid");
    }
    values.set(flag, value);
  }
  if (values.size !== allowed.size) fail("arguments_invalid");
  return values;
}

function parseCliArguments(argv) {
  const command = argv[0];
  const common = new Set([
    "--operation-directory",
    "--quiesced-baseline",
    "--bundle",
    "--binding",
    "--operation-key",
    "--expected-operation-id",
    "--expected-operation-binding-sha256"
  ]);
  const commonOptions = values => ({
    operationDirectory: values.get("--operation-directory"),
    quiescedBaselinePath: values.get("--quiesced-baseline"),
    bundlePath: values.get("--bundle"),
    bindingPath: values.get("--binding"),
    operationKeyPath: values.get("--operation-key"),
    expectedOperationId: values.get("--expected-operation-id"),
    expectedOperationBindingSha256:
      values.get("--expected-operation-binding-sha256")
  });
  if (["materialize", "verify", "emit-verified"].includes(command)) {
    const values = parseFlags(argv.slice(1), new Set([
      ...common,
      "--output-directory",
      ...(command === "emit-verified" ? ["--name"] : [])
    ]));
    return {
      command,
      options: {
        ...commonOptions(values),
        outputDirectory: values.get("--output-directory"),
        ...(command === "emit-verified" ? { name: values.get("--name") } : {})
      }
    };
  }
  if (command === "emit-attestation-inputs") {
    const values = parseFlags(argv.slice(1), common);
    return { command, options: commonOptions(values) };
  }
  if (command === "emit-deployment-contract") {
    const values = parseFlags(argv.slice(1), new Set([...common, "--deployment"]));
    return {
      command,
      options: {
        ...commonOptions(values),
        deployment: values.get("--deployment")
      }
    };
  }
  if (command === "classify") {
    const values = parseFlags(argv.slice(1), new Set([
      ...common,
      "--live-baseline"
    ]));
    return {
      command,
      options: {
        ...commonOptions(values),
        liveBaselinePath: values.get("--live-baseline")
      }
    };
  }
  if (command === "extract-applied") {
    const values = parseFlags(argv.slice(1), new Set([
      ...common,
      "--live-baseline",
      "--output"
    ]));
    return {
      command,
      options: {
        ...commonOptions(values),
        liveBaselinePath: values.get("--live-baseline"),
        outputPath: values.get("--output")
      }
    };
  }
  fail("arguments_invalid");
}

function main() {
  try {
    const parsed = parseCliArguments(process.argv.slice(2));
    if (parsed.command === "materialize") {
      materializeProcessLocalRotationReplacements(parsed.options);
    } else if (parsed.command === "verify") {
      verifyProcessLocalRotationReplacements(parsed.options);
    } else if (parsed.command === "classify") {
      process.stdout.write(`${canonicalJson(
        classifyProcessLocalRotationFiles(parsed.options)
      )}\n`);
    } else if (parsed.command === "emit-verified") {
      process.stdout.write(emitVerifiedProcessLocalRotationReplacement(parsed.options));
    } else if (parsed.command === "emit-attestation-inputs") {
      process.stdout.write(`${canonicalJson(
        loadVerifiedProcessLocalOperationalAttestationInputs(parsed.options)
      )}\n`);
    } else if (parsed.command === "emit-deployment-contract") {
      process.stdout.write(emitVerifiedProcessLocalDeploymentContract(parsed.options));
    } else {
      extractAppliedProcessLocalRotationResources(parsed.options);
    }
  } catch {
    process.stderr.write("process-local rotation replacement operation failed closed\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

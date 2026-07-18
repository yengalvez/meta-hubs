#!/usr/bin/env node

import {
  createHash,
  createHmac,
  timingSafeEqual
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyProcessLocalRotationAnnotations,
  canonicalJson,
  createProcessLocalRotationBundle,
  loadProcessLocalRotationProfile,
  redactProcessLocalRotationBundle,
  verifyProcessLocalRotationBundle
} from "./process-local-rotation.mjs";
import {
  canonicalOperationJson,
  loadVerifiedProcessLocalBarrierBinding,
  loadVerifiedProcessLocalRotationIntent,
  PROCESS_LOCAL_OPERATION_FILES
} from "./process-local-rotation-operation.mjs";
import {
  publishPrivateArtifact,
  readPublishedPrivateArtifact
} from "./private-artifact-publication.mjs";

const MAX_BASELINE_BYTES = 32 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_REVISION_BYTES = 4096;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const ARTIFACT_NAMES = Object.freeze({
  bundle: "bundle.json",
  redacted: "redacted.json",
  restart: "restart-contract.json",
  binding: "binding.json"
});
const ARTIFACT_NAME_SET = new Set(Object.values(ARTIFACT_NAMES));
const QUIESCED_BASELINE_NAME = "quiesced-baseline.json";
const BUNDLE_DIRECTORY_NAME = "bundle";
const SERVER_METADATA_FIELDS = new Set([
  "creationTimestamp",
  "generation",
  "managedFields",
  "resourceVersion",
  "selfLink",
  "uid"
]);
const AUD065_PGSQL_POLICY_NAME = "pgsql-ingress";
const AUD065_PGSQL_MARKER_LOCK_UID = "yenhubs.org/aud065-pgsql-lock-uid";
const AUD065_PGSQL_MARKER_TOKEN = "yenhubs.org/aud065-pgsql-operation-token";
const AUD065_PGSQL_MARKER_BINDING =
  "yenhubs.org/aud065-pgsql-operation-binding-sha256";
const AUD065_PGSQL_MARKER_STATE = "yenhubs.org/aud065-pgsql-barrier-state";
const AUD065_PGSQL_MARKER_SPEC_SHA =
  "yenhubs.org/aud065-pgsql-normal-spec-sha256";
const AUD065_NEW_DB_PASSWORD = /^[A-Za-z0-9_-]{32,128}$/u;
const AUD065_PGSQL_MARKER_NAMES = Object.freeze([
  AUD065_PGSQL_MARKER_LOCK_UID,
  AUD065_PGSQL_MARKER_TOKEN,
  AUD065_PGSQL_MARKER_BINDING,
  AUD065_PGSQL_MARKER_STATE,
  AUD065_PGSQL_MARKER_SPEC_SHA
]);

export class OfflineProcessLocalRotationError extends Error {
  constructor(code, causeCode) {
    super(code);
    this.name = "OfflineProcessLocalRotationError";
    this.code = code;
    if (typeof causeCode === "string" && /^[a-z0-9_]+$/u.test(causeCode)) {
      this.causeCode = causeCode;
    }
  }
}

function fail(code, causeCode) {
  throw new OfflineProcessLocalRotationError(code, causeCode);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function currentUidMatches(stat) {
  return typeof process.getuid !== "function" || stat.uid === BigInt(process.getuid());
}

function requireNoFollowSupport() {
  if (typeof fs.constants.O_NOFOLLOW !== "number" ||
      typeof fs.constants.O_EXCL !== "number" ||
      typeof fs.constants.O_DIRECTORY !== "number") {
    fail("private_filesystem_contract_unsupported");
  }
}

function componentContract(targetPath) {
  const absolute = path.resolve(targetPath);
  const parsed = path.parse(absolute);
  const components = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  return components.map((component, index) => {
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
    return {
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
    };
  });
}

function sameComponentContract(before, after) {
  return before.length === after.length && before.every((entry, index) => {
    const current = after[index];
    return entry.path === current.path && entry.dev === current.dev &&
      entry.ino === current.ino && entry.mode === current.mode &&
      entry.uid === current.uid &&
      entry.directory === current.directory && entry.file === current.file &&
      (index !== before.length - 1 ||
        (entry.nlink === current.nlink && entry.size === current.size &&
         entry.mtimeNs === current.mtimeNs &&
         entry.ctimeNs === current.ctimeNs));
  });
}

function readExactPrivateBytes(descriptor, size) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = fs.readSync(descriptor, bytes, offset, size - offset, offset);
    if (count === 0) fail("private_input_changed");
    offset += count;
  }
  const extra = Buffer.alloc(1);
  if (fs.readSync(descriptor, extra, 0, 1, size) !== 0) {
    fail("private_input_changed");
  }
  return bytes;
}

function readPrivateFile(filePath, maximumBytes, { binary = false } = {}) {
  requireNoFollowSupport();
  const absolute = path.resolve(filePath);
  let descriptor;
  try {
    const beforeComponents = componentContract(absolute);
    const leaf = beforeComponents.at(-1);
    if (!leaf?.file || leaf.nlink !== 1n ||
        Number(leaf.mode & 0o7777n) !== PRIVATE_FILE_MODE ||
        !currentUidMatches(fs.lstatSync(absolute, { bigint: true })) ||
        leaf.size < 1n || leaf.size > BigInt(maximumBytes)) {
      fail("private_input_invalid");
    }
    descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n ||
        Number(opened.mode & 0o7777n) !== PRIVATE_FILE_MODE ||
        !currentUidMatches(opened) || opened.dev !== leaf.dev || opened.ino !== leaf.ino ||
        opened.size !== leaf.size || opened.mtimeNs !== leaf.mtimeNs ||
        opened.ctimeNs !== leaf.ctimeNs) {
      fail("private_input_invalid");
    }
    const bytes = readExactPrivateBytes(descriptor, Number(opened.size));
    const firstDigest = createHash("sha256").update(bytes).digest();
    const middle = fs.fstatSync(descriptor, { bigint: true });
    if (opened.dev !== middle.dev || opened.ino !== middle.ino ||
        opened.nlink !== middle.nlink || opened.size !== middle.size ||
        opened.mtimeNs !== middle.mtimeNs || opened.ctimeNs !== middle.ctimeNs) {
      fail("private_input_changed");
    }
    const secondBytes = readExactPrivateBytes(descriptor, Number(opened.size));
    const secondDigest = createHash("sha256").update(secondBytes).digest();
    const after = fs.fstatSync(descriptor, { bigint: true });
    const afterComponents = componentContract(absolute);
    if (BigInt(bytes.length) !== opened.size || opened.dev !== after.dev ||
        opened.ino !== after.ino || opened.nlink !== after.nlink ||
        opened.size !== after.size ||
        opened.mtimeNs !== after.mtimeNs || opened.ctimeNs !== after.ctimeNs ||
        !sameComponentContract(beforeComponents, afterComponents) ||
        firstDigest.length !== secondDigest.length ||
        !timingSafeEqual(firstDigest, secondDigest)) {
      fail("private_input_changed");
    }
    let text;
    if (!binary) {
      text = bytes.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(bytes)) fail("private_input_invalid");
    }
    return { absolute, bytes, text, sha256: sha256(bytes) };
  } catch (error) {
    if (error instanceof OfflineProcessLocalRotationError) throw error;
    fail("private_input_invalid");
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

function parseJsonSource(source, code) {
  let value;
  try {
    value = JSON.parse(source.text);
  } catch (_error) {
    fail(code);
  }
  return value;
}

function parseBaselineSource(source) {
  const parsed = parseJsonSource(source, "baseline_json_invalid");
  if (Array.isArray(parsed)) return parsed;
  if (isRecord(parsed) && parsed.kind === "List" && Array.isArray(parsed.items)) {
    return parsed.items;
  }
  fail("baseline_json_invalid");
}

function parseSnapshotSource(source) {
  const parsed = parseJsonSource(source, "snapshot_json_invalid");
  if (!isRecord(parsed)) fail("snapshot_json_invalid");
  return parsed;
}

function parseRevisionSource(source) {
  const parsed = parseJsonSource(source, "revision_json_invalid");
  if (!exactKeys(parsed, ["rotationRevision"]) ||
      typeof parsed.rotationRevision !== "string") {
    fail("revision_json_invalid");
  }
  return parsed.rotationRevision;
}

function resourceIdentity(resource) {
  if (!isRecord(resource) || typeof resource.apiVersion !== "string" ||
      typeof resource.kind !== "string" || !isRecord(resource.metadata) ||
      typeof resource.metadata.name !== "string" || !resource.metadata.name ||
      !["undefined", "string"].includes(typeof resource.metadata.namespace)) {
    fail("baseline_resource_invalid");
  }
  return `${resource.apiVersion}\u0000${resource.kind}\u0000${resource.metadata.namespace || ""}\u0000${resource.metadata.name}`;
}

function indexResources(resources) {
  if (!Array.isArray(resources) || resources.length === 0) fail("baseline_resource_invalid");
  const result = new Map();
  for (const resource of resources) {
    const identity = resourceIdentity(resource);
    if (result.has(identity)) fail("baseline_resource_invalid");
    result.set(identity, resource);
  }
  return result;
}

function findResource(index, apiVersion, kind, namespace, name) {
  const resource = index.get(`${apiVersion}\u0000${kind}\u0000${namespace}\u0000${name}`);
  if (!resource) fail("baseline_resource_invalid");
  return resource;
}

function requireLiveResourceMetadata(resource) {
  if (typeof resource.metadata?.uid !== "string" || !resource.metadata.uid ||
      typeof resource.metadata?.resourceVersion !== "string" ||
      !resource.metadata.resourceVersion) {
    fail("baseline_binding_invalid");
  }
}

function deploymentMetadataInvariant(resource) {
  const metadata = structuredClone(resource.metadata);
  delete metadata.resourceVersion;
  delete metadata.generation;
  delete metadata.managedFields;
  return metadata;
}

function deploymentSpecWithoutReplicas(resource) {
  const spec = structuredClone(resource.spec);
  if (!isRecord(spec)) fail("baseline_spec_invalid");
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

function metadataWithoutServerFields(resource) {
  const metadata = {};
  for (const [name, value] of Object.entries(resource.metadata || {})) {
    if (!SERVER_METADATA_FIELDS.has(name)) metadata[name] = structuredClone(value);
  }
  return metadata;
}

function comparableDesiredResource(resource) {
  const comparable = structuredClone(resource);
  delete comparable.status;
  comparable.metadata = metadataWithoutServerFields(resource);
  return comparable;
}

function pgsqlUserMetadata(resource) {
  const metadata = metadataWithoutServerFields(resource);
  const annotations = structuredClone(metadata.annotations || {});
  if (!isRecord(annotations)) fail("baseline_pgsql_metadata_invalid");
  for (const name of AUD065_PGSQL_MARKER_NAMES) delete annotations[name];
  if (Object.keys(annotations).length > 0) metadata.annotations = annotations;
  else delete metadata.annotations;
  return metadata;
}

function pgsqlBaseMetadata(resource) {
  const annotations = structuredClone(resource.metadata?.annotations || {});
  if (!isRecord(annotations) ||
      (resource.metadata?.labels !== undefined && !isRecord(resource.metadata.labels)) ||
      (resource.metadata?.ownerReferences !== undefined &&
        !Array.isArray(resource.metadata.ownerReferences)) ||
      (resource.metadata?.finalizers !== undefined &&
        !Array.isArray(resource.metadata.finalizers))) {
    fail("baseline_pgsql_metadata_invalid");
  }
  for (const name of AUD065_PGSQL_MARKER_NAMES) delete annotations[name];
  return {
    labels: structuredClone(resource.metadata.labels || {}),
    annotations,
    ownerReferences: structuredClone(resource.metadata.ownerReferences || []),
    finalizers: structuredClone(resource.metadata.finalizers || [])
  };
}

function assertOriginalPgsqlPolicy(original, namespace, barrierBinding) {
  requireLiveResourceMetadata(original);
  const annotations = original.metadata.annotations || {};
  const normalSpec = aud065PgsqlNormalSpec();
  const normalSpecSha256 = sha256(Buffer.from(canonicalJson(normalSpec), "utf8"));
  const metadataSha256 = sha256(Buffer.from(
    canonicalJson(pgsqlBaseMetadata(original)), "utf8"
  ));
  if (original.apiVersion !== "networking.k8s.io/v1" ||
      original.kind !== "NetworkPolicy" ||
      original.metadata.name !== AUD065_PGSQL_POLICY_NAME ||
      original.metadata.namespace !== namespace ||
      original.metadata.deletionTimestamp != null ||
      !isRecord(annotations) ||
      AUD065_PGSQL_MARKER_NAMES.some(name =>
        Object.prototype.hasOwnProperty.call(annotations, name)) ||
      canonicalJson(original.spec) !== canonicalJson(normalSpec) ||
      canonicalJson(original.metadata.ownerReferences || []) !== "[]" ||
      canonicalJson(original.metadata.finalizers || []) !== "[]" ||
      (barrierBinding && (
        original.metadata.uid !== barrierBinding.policyUid ||
        original.metadata.resourceVersion !== barrierBinding.policyResourceVersion ||
        barrierBinding.normalSpecSha256 !== normalSpecSha256 ||
        barrierBinding.policyMetadataSha256 !== metadataSha256
      ))) {
    fail("baseline_pgsql_original_invalid");
  }
  return normalSpecSha256;
}

function assertOriginalAndQuiescedPgsqlPolicy({
  original,
  quiesced,
  namespace,
  operationIntent,
  barrierBinding
}) {
  const normalSpecSha256 = assertOriginalPgsqlPolicy(
    original, namespace, barrierBinding
  );
  requireLiveResourceMetadata(quiesced);
  const originalAnnotations = original.metadata.annotations || {};
  const quiescedAnnotations = quiesced.metadata.annotations || {};
  const expectedAnnotations = {
    ...structuredClone(originalAnnotations),
    [AUD065_PGSQL_MARKER_LOCK_UID]: barrierBinding.lockUid,
    [AUD065_PGSQL_MARKER_TOKEN]: operationIntent.operationToken,
    [AUD065_PGSQL_MARKER_BINDING]: operationIntent.operationBindingSha256,
    [AUD065_PGSQL_MARKER_STATE]: "closed",
    [AUD065_PGSQL_MARKER_SPEC_SHA]: normalSpecSha256
  };
  if (quiesced.apiVersion !== original.apiVersion ||
      quiesced.kind !== original.kind ||
      quiesced.metadata.name !== original.metadata.name ||
      quiesced.metadata.namespace !== namespace ||
      quiesced.metadata.deletionTimestamp != null ||
      quiesced.metadata.uid !== original.metadata.uid ||
      quiesced.metadata.resourceVersion === original.metadata.resourceVersion ||
      !isRecord(quiescedAnnotations) ||
      canonicalJson(quiesced.spec) !== canonicalJson(aud065PgsqlClosedSpec()) ||
      canonicalJson(pgsqlUserMetadata(quiesced)) !==
        canonicalJson(pgsqlUserMetadata(original)) ||
      canonicalJson(quiescedAnnotations) !== canonicalJson(expectedAnnotations)) {
    fail("baseline_pgsql_quiesced_invalid");
  }
}

function assertOriginalAndQuiescedBaselines(
  originalResources,
  quiescedResources,
  profile,
  operationIntent,
  barrierBinding
) {
  const original = indexResources(originalResources);
  const quiesced = indexResources(quiescedResources);
  if (JSON.stringify([...original.keys()].sort()) !== JSON.stringify([...quiesced.keys()].sort())) {
    fail("baseline_inventory_drift");
  }
  const namespaceResource = quiescedResources.find(resource => resource.kind === "Secret" &&
    resource.metadata?.name === profile.projected_resources.secret);
  const namespace = namespaceResource?.metadata?.namespace;
  if (typeof namespace !== "string" || !namespace) fail("baseline_namespace_invalid");

  for (const [identity, before] of original.entries()) {
    const after = quiesced.get(identity);
    if (before.kind !== "Deployment") {
      if (before.apiVersion === "networking.k8s.io/v1" &&
          before.kind === "NetworkPolicy" &&
          before.metadata?.name === AUD065_PGSQL_POLICY_NAME &&
          before.metadata?.namespace === namespace) {
        assertOriginalAndQuiescedPgsqlPolicy({
          original: before,
          quiesced: after,
          namespace,
          operationIntent,
          barrierBinding
        });
        continue;
      }
      requireLiveResourceMetadata(before);
      requireLiveResourceMetadata(after);
      if (before.metadata.uid !== after.metadata.uid ||
          canonicalJson(comparableDesiredResource(before)) !==
            canonicalJson(comparableDesiredResource(after))) {
        fail("baseline_nonworkload_drift");
      }
      continue;
    }
    requireLiveResourceMetadata(before);
    requireLiveResourceMetadata(after);
    if (before.metadata.namespace !== namespace || after.metadata.namespace !== namespace ||
        before.metadata.uid !== after.metadata.uid ||
        canonicalJson(deploymentMetadataInvariant(before)) !==
          canonicalJson(deploymentMetadataInvariant(after)) ||
        canonicalJson(deploymentSpecWithoutReplicas(before)) !==
          canonicalJson(deploymentSpecWithoutReplicas(after))) {
      fail("baseline_workload_drift");
    }
    const rotationTarget = profile.rotation_revision_deployments.includes(before.metadata.name);
    if (rotationTarget) {
      if (before.spec?.replicas !== 1 || after.spec?.replicas !== 0 ||
          before.metadata.resourceVersion === after.metadata.resourceVersion) {
        fail("baseline_quiescence_invalid");
      }
    } else if (before.spec?.replicas !== after.spec?.replicas) {
      fail("baseline_workload_drift");
    }
  }

  const restartDeployments = profile.rotation_revision_deployments.map(name => {
    const before = findResource(original, "apps/v1", "Deployment", namespace, name);
    const after = findResource(quiesced, "apps/v1", "Deployment", namespace, name);
    return {
      name,
      uid: before.metadata.uid,
      originalReplicas: before.spec.replicas,
      originalResourceVersion: before.metadata.resourceVersion,
      quiescedResourceVersion: after.metadata.resourceVersion
    };
  });
  return {
    schemaVersion: 1,
    profileId: profile.profile_id,
    runnerMode: "process-local",
    namespace,
    restorationPhase: "verified-callbacks-only",
    bundleRestoresReplicas: false,
    deployments: restartDeployments
  };
}

function buildApplyAttestation(quiescedResources, bundle, profile) {
  const index = indexResources(quiescedResources);
  const namespace = bundle.contract.namespace;
  const deployments = profile.rotation_revision_deployments.map(name => {
    const baseline = findResource(index, "apps/v1", "Deployment", namespace, name);
    const projected = applyProcessLocalRotationAnnotations({ deployment: baseline, bundle, profile });
    if (projected.spec?.replicas !== 0) fail("apply_projection_not_quiesced");
    return {
      name,
      uidBound: true,
      resourceVersionBound: true,
      replicas: 0,
      annotationKeys: Object.keys(bundle.contract.desiredDeploymentAnnotations[name]).sort()
    };
  });
  return {
    allConsumersQuiesced: deployments.every(item => item.replicas === 0),
    bundleRestoresReplicas: false,
    deployments
  };
}

function buildRedactedRecord(redacted, applyAttestation, restartContract) {
  return {
    ...redacted,
    applyAttestation,
    restartCallbacks: {
      artifact: ARTIFACT_NAMES.restart,
      restorationPhase: restartContract.restorationPhase,
      deploymentCount: restartContract.deployments.length
    }
  };
}

function serializeJson(value) {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function buildBinding({
  profile,
  rotationRevision,
  namespace,
  inputSources,
  bundleBody,
  redactedBody,
  restartBody,
  bundle,
  applyAttestation,
  operationKey,
  operationIntent
}) {
  const body = {
    schemaVersion: 1,
    contractId: "yenhubs-aud065-offline-bundle-v1",
    profileId: profile.profile_id,
    rotationRevision,
    namespace,
    operationBindingSha256: operationIntent.operationBindingSha256,
    inputs: {
      originalBaselineSha256: inputSources.originalBaseline.sha256,
      quiescedBaselineSha256: inputSources.quiescedBaseline.sha256,
      oldSnapshotSha256: inputSources.oldSnapshot.sha256,
      newSnapshotSha256: inputSources.newSnapshot.sha256,
      revisionSha256: inputSources.revision.sha256
    },
    files: {
      bundle: {
        name: ARTIFACT_NAMES.bundle,
        size: bundleBody.length,
        sha256: sha256(bundleBody)
      },
      redacted: {
        name: ARTIFACT_NAMES.redacted,
        size: redactedBody.length,
        sha256: sha256(redactedBody)
      },
      restart: {
        name: ARTIFACT_NAMES.restart,
        size: restartBody.length,
        sha256: sha256(restartBody)
      }
    },
    externalOperationKey: {
      size: operationKey.length,
      hmacBound: true
    },
    profileSha256: sha256(Buffer.from(canonicalJson(profile), "utf8")),
    liveResourceBindingsSha256: sha256(Buffer.from(
      canonicalJson(bundle.contract.liveResourceBindings), "utf8"
    )),
    applyAttestationSha256: sha256(Buffer.from(canonicalJson(applyAttestation), "utf8")),
    retConfigDataSha256: bundle.contract.retConfigBinding.dataSha256
  };
  return {
    ...body,
    hmacSha256: createHmac("sha256", operationKey)
      .update(canonicalJson(body))
      .digest("hex")
  };
}

function outputParentContract(outputDirectory) {
  const absolute = path.resolve(outputDirectory);
  const parent = path.dirname(absolute);
  const parentComponents = componentContract(parent);
  const parentLeaf = parentComponents.at(-1);
  if (!parentLeaf?.directory || Number(parentLeaf.mode & 0o7777n) !==
      PRIVATE_DIRECTORY_MODE || !currentUidMatches(parentLeaf)) {
    fail("private_output_parent_invalid");
  }
  return {
    absolute,
    parent: {
      absolute: parent,
      dev: parentLeaf.dev,
      ino: parentLeaf.ino
    }
  };
}

function assertOutputParentIdentity(parentContract) {
  let stat;
  try {
    stat = fs.lstatSync(parentContract.absolute, { bigint: true });
  } catch (_error) {
    fail("private_output_parent_changed");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      stat.dev !== parentContract.dev || stat.ino !== parentContract.ino ||
      Number(stat.mode & 0o7777n) !== PRIVATE_DIRECTORY_MODE ||
      !currentUidMatches(stat)) {
    fail("private_output_parent_changed");
  }
}

function createPrivateOutputDirectory(outputDirectory, stagingDirectory) {
  requireNoFollowSupport();
  const contract = outputParentContract(outputDirectory);
  let created = false;
  try {
    try {
      fs.mkdirSync(contract.absolute, { mode: PRIVATE_DIRECTORY_MODE });
      fs.chmodSync(contract.absolute, PRIVATE_DIRECTORY_MODE);
      created = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    assertOutputParentIdentity(contract.parent);
    const stat = fs.lstatSync(contract.absolute, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        Number(stat.mode & 0o7777n) !== PRIVATE_DIRECTORY_MODE ||
        !currentUidMatches(stat)) {
      fail("private_output_invalid");
    }
    const entries = fs.readdirSync(contract.absolute);
    if (entries.some(name => !ARTIFACT_NAME_SET.has(name))) {
      fail("private_artifact_inventory_invalid");
    }
    if (created) {
      let parentDescriptor;
      try {
        parentDescriptor = fs.openSync(
          contract.parent.absolute,
          fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
        );
        fs.fsyncSync(parentDescriptor);
      } finally {
        if (parentDescriptor !== undefined) fs.closeSync(parentDescriptor);
      }
    }
    return {
      absolute: contract.absolute,
      dev: stat.dev,
      ino: stat.ino,
      parent: contract.parent,
      stagingDirectory: path.resolve(stagingDirectory),
      created
    };
  } catch (error) {
    if (error instanceof OfflineProcessLocalRotationError) throw error;
    fail("private_output_invalid");
  }
}

function assertOutputDirectoryIdentity(directoryContract) {
  assertOutputParentIdentity(directoryContract.parent);
  let stat;
  try {
    stat = fs.lstatSync(directoryContract.absolute, { bigint: true });
  } catch (_error) {
    fail("private_output_changed");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== directoryContract.dev ||
      stat.ino !== directoryContract.ino ||
      Number(stat.mode & 0o7777n) !== PRIVATE_DIRECTORY_MODE ||
      !currentUidMatches(stat)) {
    fail("private_output_changed");
  }
}

function writePrivateArtifact(directoryContract, name, bytes) {
  if (!ARTIFACT_NAME_SET.has(name) || !Buffer.isBuffer(bytes) || bytes.length < 1) {
    fail("private_artifact_invalid");
  }
  assertOutputDirectoryIdentity(directoryContract);
  const target = path.join(directoryContract.absolute, name);
  try {
    publishPrivateArtifact({
      outputPath: target,
      bytes,
      maximumBytes: MAX_ARTIFACT_BYTES,
      stagingDirectoryPath: directoryContract.stagingDirectory
    });
  } catch {
    fail("private_artifact_write_failed");
  }
}

function syncPrivateDirectory(directoryContract) {
  assertOutputDirectoryIdentity(directoryContract);
  let descriptor;
  try {
    const directoryFlag = typeof fs.constants.O_DIRECTORY === "number"
      ? fs.constants.O_DIRECTORY
      : 0;
    descriptor = fs.openSync(
      directoryContract.absolute,
      fs.constants.O_RDONLY | directoryFlag | fs.constants.O_NOFOLLOW
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isDirectory() || opened.dev !== directoryContract.dev ||
        opened.ino !== directoryContract.ino) {
      fail("private_output_sync_failed");
    }
    assertOutputDirectoryIdentity(directoryContract);
    fs.fsyncSync(descriptor);
    assertOutputDirectoryIdentity(directoryContract);
  } catch (_error) {
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

function assertOutputArtifactInventory(directoryContract) {
  assertOutputDirectoryIdentity(directoryContract);
  let entries;
  try {
    for (const name of ARTIFACT_NAME_SET) {
      readPublishedPrivateArtifact({
        outputPath: path.join(directoryContract.absolute, name),
        maximumBytes: MAX_ARTIFACT_BYTES,
        stagingDirectoryPath: directoryContract.stagingDirectory
      });
    }
    // readPublishedPrivateArtifact above reconciles the sole attributable
    // post-link crash cut.  Anything still pending is unknown and must be
    // preserved while the operation fails closed.
    entries = fs.readdirSync(directoryContract.absolute).sort();
  } catch (_error) {
    if (_error instanceof OfflineProcessLocalRotationError) throw _error;
    fail("private_artifact_inventory_invalid");
  }
  if (JSON.stringify(entries) !== JSON.stringify([...ARTIFACT_NAME_SET].sort())) {
    fail("private_artifact_inventory_invalid");
  }
  for (const name of entries) {
    const stat = fs.lstatSync(path.join(directoryContract.absolute, name), { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n ||
        Number(stat.mode & 0o7777n) !== PRIVATE_FILE_MODE || !currentUidMatches(stat)) {
      fail("private_artifact_inventory_invalid");
    }
  }
}

function readInputSources(paths) {
  const sources = {
    originalBaseline: readPrivateFile(paths.originalBaselinePath, MAX_BASELINE_BYTES),
    quiescedBaseline: readPrivateFile(paths.quiescedBaselinePath, MAX_BASELINE_BYTES),
    oldSnapshot: readPrivateFile(paths.oldSnapshotPath, MAX_SNAPSHOT_BYTES),
    newSnapshot: readPrivateFile(paths.newSnapshotPath, MAX_SNAPSHOT_BYTES),
    revision: readPrivateFile(paths.revisionPath, MAX_REVISION_BYTES),
    operationKey: readPrivateFile(paths.operationKeyPath, 32, { binary: true })
  };
  if (sources.operationKey.bytes.length !== 32) fail("operation_key_invalid");
  return sources;
}

function assertOperationLayout(paths) {
  const operationDirectory = path.resolve(paths.operationDirectory);
  const expected = new Map([
    [paths.originalBaselinePath, PROCESS_LOCAL_OPERATION_FILES.originalBaseline],
    [paths.quiescedBaselinePath, QUIESCED_BASELINE_NAME],
    [paths.oldSnapshotPath, PROCESS_LOCAL_OPERATION_FILES.oldSnapshot],
    [paths.newSnapshotPath, PROCESS_LOCAL_OPERATION_FILES.newSnapshot],
    [paths.revisionPath, PROCESS_LOCAL_OPERATION_FILES.revision],
    [paths.operationKeyPath, PROCESS_LOCAL_OPERATION_FILES.operationKey]
  ]);
  if ([...expected].some(([actual, name]) =>
    path.resolve(actual) !== path.join(operationDirectory, name)) ||
      path.resolve(paths.bundleDirectory) !==
        path.join(operationDirectory, BUNDLE_DIRECTORY_NAME)) {
    fail("operation_layout_invalid");
  }
}

function parseInputSources(sources) {
  return {
    originalResources: parseBaselineSource(sources.originalBaseline),
    quiescedResources: parseBaselineSource(sources.quiescedBaseline),
    oldValues: parseSnapshotSource(sources.oldSnapshot),
    newValues: parseSnapshotSource(sources.newSnapshot),
    rotationRevision: parseRevisionSource(sources.revision)
  };
}

function canonicalList(resources) {
  return { apiVersion: "v1", kind: "List", items: resources };
}

function assertCanonicalInputSources(sources, parsed) {
  const expected = {
    originalBaseline: serializeJson(canonicalList(parsed.originalResources)),
    quiescedBaseline: serializeJson(canonicalList(parsed.quiescedResources)),
    oldSnapshot: serializeJson(parsed.oldValues),
    newSnapshot: serializeJson(parsed.newValues),
    revision: serializeJson({ rotationRevision: parsed.rotationRevision })
  };
  for (const [name, bytes] of Object.entries(expected)) {
    if (!sources[name].bytes.equals(bytes)) fail("canonical_input_source_invalid");
  }
}

function assertIntentMatchesInputs(intent, inputSources, parsed, profile) {
  const profileSha256 = sha256(Buffer.from(canonicalJson(profile), "utf8"));
  const originalNamespace = parsed.originalResources.find(resource =>
    resource?.apiVersion === "v1" && resource?.kind === "Namespace" &&
    resource.metadata?.name === intent?.namespaceName
  );
  const originalSecret = parsed.originalResources.find(resource =>
    resource?.apiVersion === "v1" && resource?.kind === "Secret" &&
    resource.metadata?.name === profile.projected_resources.secret
  );
  const namespace = originalSecret?.metadata?.namespace;
  const authenticatedIntent = structuredClone(intent);
  delete authenticatedIntent.hmacSha256;
  const expectedIntentHmac = createHmac("sha256", inputSources.operationKey.bytes)
    .update(canonicalOperationJson(authenticatedIntent), "utf8")
    .digest("hex");
  if (intent?.profileId !== profile.profile_id || intent.profileSha256 !== profileSha256 ||
      intent.namespaceName !== namespace ||
      originalNamespace?.metadata?.uid !== intent.namespaceUid ||
      intent.rotationRevision !== parsed.rotationRevision ||
      intent.originalBaselineSha256 !== inputSources.originalBaseline.sha256 ||
      intent.oldSnapshotSha256 !== inputSources.oldSnapshot.sha256 ||
      intent.newSnapshotSha256 !== inputSources.newSnapshot.sha256 ||
      !safeHexEqual(intent.hmacSha256, expectedIntentHmac) ||
      parsed.oldValues?.[profile.namespace_value_key] !== namespace ||
      parsed.newValues?.[profile.namespace_value_key] !== namespace) {
    fail("operation_intent_input_mismatch");
  }
}

function assertPlanOperationLayout(paths) {
  const operationDirectory = path.resolve(paths.operationDirectory);
  const expected = new Map([
    [paths.originalBaselinePath, PROCESS_LOCAL_OPERATION_FILES.originalBaseline],
    [paths.oldSnapshotPath, PROCESS_LOCAL_OPERATION_FILES.oldSnapshot],
    [paths.newSnapshotPath, PROCESS_LOCAL_OPERATION_FILES.newSnapshot]
  ]);
  if ([...expected].some(([actual, name]) =>
    path.resolve(actual) !== path.join(operationDirectory, name))) {
    fail("operation_layout_invalid");
  }
}

function assertPlanIntentMatchesInputs(intent, sources, parsed, profile) {
  const profileSha256 = sha256(Buffer.from(canonicalJson(profile), "utf8"));
  const originalNamespace = parsed.originalResources.find(resource =>
    resource?.apiVersion === "v1" && resource?.kind === "Namespace" &&
    resource.metadata?.name === intent?.namespaceName
  );
  const originalSecret = parsed.originalResources.find(resource =>
    resource?.apiVersion === "v1" && resource?.kind === "Secret" &&
    resource.metadata?.name === profile.projected_resources.secret
  );
  const namespace = originalSecret?.metadata?.namespace;
  if (intent?.profileId !== profile.profile_id ||
      intent.profileSha256 !== profileSha256 ||
      intent.namespaceName !== namespace ||
      originalNamespace?.metadata?.uid !== intent.namespaceUid ||
      intent.originalBaselineSha256 !== sources.originalBaseline.sha256 ||
      intent.oldSnapshotSha256 !== sources.oldSnapshot.sha256 ||
      intent.newSnapshotSha256 !== sources.newSnapshot.sha256 ||
      parsed.oldValues?.[profile.namespace_value_key] !== namespace ||
      parsed.newValues?.[profile.namespace_value_key] !== namespace) {
    fail("operation_intent_input_mismatch");
  }
}

function baselineForPlanValidation(resources, namespace, profile) {
  const validationBaseline = structuredClone(resources);
  const index = indexResources(validationBaseline);
  for (const name of profile.rotation_revision_deployments) {
    const deployment = findResource(
      index, "apps/v1", "Deployment", namespace, name
    );
    if (!isRecord(deployment.spec) || deployment.spec.replicas !== 1) {
      fail("plan_deployment_replicas_invalid");
    }
    deployment.spec.replicas = 0;
  }
  return validationBaseline;
}

export function verifyOfflineProcessLocalRotationPlan({
  operationDirectory,
  originalBaselinePath,
  oldSnapshotPath,
  newSnapshotPath
}) {
  try {
    const paths = {
      operationDirectory,
      originalBaselinePath,
      oldSnapshotPath,
      newSnapshotPath
    };
    assertPlanOperationLayout(paths);
    const sources = {
      originalBaseline: readPrivateFile(originalBaselinePath, MAX_BASELINE_BYTES),
      oldSnapshot: readPrivateFile(oldSnapshotPath, MAX_SNAPSHOT_BYTES),
      newSnapshot: readPrivateFile(newSnapshotPath, MAX_SNAPSHOT_BYTES)
    };
    const parsed = {
      originalResources: parseBaselineSource(sources.originalBaseline),
      oldValues: parseSnapshotSource(sources.oldSnapshot),
      newValues: parseSnapshotSource(sources.newSnapshot)
    };
    const expected = {
      originalBaseline: serializeJson(canonicalList(parsed.originalResources)),
      oldSnapshot: serializeJson(parsed.oldValues),
      newSnapshot: serializeJson(parsed.newValues)
    };
    for (const [name, bytes] of Object.entries(expected)) {
      if (!sources[name].bytes.equals(bytes)) fail("canonical_input_source_invalid");
    }
    const profile = loadProcessLocalRotationProfile();
    const operationIntent = loadVerifiedProcessLocalRotationIntent({ operationDirectory });
    assertPlanIntentMatchesInputs(operationIntent, sources, parsed, profile);
    if (!AUD065_NEW_DB_PASSWORD.test(parsed.newValues?.DB_PASS)) {
      fail("plan_new_db_password_invalid");
    }
    const namespace = operationIntent.namespaceName;
    const originalIndex = indexResources(parsed.originalResources);
    if (originalIndex.size !== 42 || profile.baseline_resource_identities.length !== 42) {
      fail("plan_baseline_inventory_invalid");
    }
    const policy = findResource(
      originalIndex,
      "networking.k8s.io/v1",
      "NetworkPolicy",
      namespace,
      AUD065_PGSQL_POLICY_NAME
    );
    assertOriginalPgsqlPolicy(policy, namespace);
    createProcessLocalRotationBundle({
      baselineResources: baselineForPlanValidation(
        parsed.originalResources, namespace, profile
      ),
      oldValues: parsed.oldValues,
      newValues: parsed.newValues,
      rotationRevision: operationIntent.rotationRevision,
      profile
    });
    return true;
  } catch (_error) {
    fail("offline_plan_verify_failed", _error?.code);
  }
}

function buildExpectedArtifacts(
  inputSources,
  parsed,
  operationKey,
  operationIntent,
  barrierBinding,
  profile
) {
  const restartContract = assertOriginalAndQuiescedBaselines(
    parsed.originalResources,
    parsed.quiescedResources,
    profile,
    operationIntent,
    barrierBinding
  );
  const bundleInput = {
    baselineResources: parsed.quiescedResources,
    oldValues: parsed.oldValues,
    newValues: parsed.newValues,
    rotationRevision: parsed.rotationRevision,
    profile
  };
  const bundle = createProcessLocalRotationBundle(bundleInput);
  verifyProcessLocalRotationBundle({ ...bundleInput, bundle });
  const applyAttestation = buildApplyAttestation(parsed.quiescedResources, bundle, profile);
  if (!applyAttestation.allConsumersQuiesced) fail("apply_projection_not_quiesced");
  const redacted = buildRedactedRecord(
    redactProcessLocalRotationBundle({
      ...bundleInput,
      bundle,
      fingerprintKey: operationKey
    }),
    applyAttestation,
    restartContract
  );
  const bundleBody = serializeJson(bundle);
  const redactedBody = serializeJson(redacted);
  const restartBody = serializeJson(restartContract);
  const binding = buildBinding({
    profile,
    rotationRevision: parsed.rotationRevision,
    namespace: bundle.contract.namespace,
    inputSources,
    bundleBody,
    redactedBody,
    restartBody,
    bundle,
    applyAttestation,
    operationKey,
    operationIntent
  });
  return {
    bundle,
    redacted,
    restartContract,
    binding,
    bodies: {
      bundle: bundleBody,
      redacted: redactedBody,
      restart: restartBody,
      binding: serializeJson(binding)
    }
  };
}

export function prepareOfflineProcessLocalRotation({
  operationDirectory,
  originalBaselinePath,
  quiescedBaselinePath,
  oldSnapshotPath,
  newSnapshotPath,
  revisionPath,
  operationKeyPath,
  bundleDirectory
}) {
  let directoryContract;
  try {
    const paths = {
      operationDirectory,
      originalBaselinePath,
      quiescedBaselinePath,
      oldSnapshotPath,
      newSnapshotPath,
      revisionPath,
      operationKeyPath,
      bundleDirectory
    };
    assertOperationLayout(paths);
    const inputSources = readInputSources(paths);
    const parsed = parseInputSources(inputSources);
    const profile = loadProcessLocalRotationProfile();
    assertCanonicalInputSources(inputSources, parsed);
    const operationIntent = loadVerifiedProcessLocalRotationIntent({ operationDirectory });
    const barrierBinding = loadVerifiedProcessLocalBarrierBinding({ operationDirectory });
    assertIntentMatchesInputs(operationIntent, inputSources, parsed, profile);
    const expected = buildExpectedArtifacts(
      inputSources,
      parsed,
      inputSources.operationKey.bytes,
      operationIntent,
      barrierBinding,
      profile
    );
    directoryContract = createPrivateOutputDirectory(bundleDirectory, operationDirectory);
    writePrivateArtifact(directoryContract, ARTIFACT_NAMES.bundle, expected.bodies.bundle);
    writePrivateArtifact(directoryContract, ARTIFACT_NAMES.redacted, expected.bodies.redacted);
    writePrivateArtifact(directoryContract, ARTIFACT_NAMES.restart, expected.bodies.restart);
    writePrivateArtifact(directoryContract, ARTIFACT_NAMES.binding, expected.bodies.binding);
    assertOutputArtifactInventory(directoryContract);
    syncPrivateDirectory(directoryContract);
    assertOutputArtifactInventory(directoryContract);
    return true;
  } catch (_error) {
    fail("offline_prepare_failed", _error?.code);
  }
}

function assertPrivateArtifactDirectory(bundleDirectory, stagingDirectory) {
  const absolute = path.resolve(bundleDirectory);
  const components = componentContract(absolute);
  const leaf = components.at(-1);
  const parentComponents = componentContract(path.dirname(absolute));
  const parent = parentComponents.at(-1);
  if (!leaf?.directory || Number(leaf.mode & 0o7777n) !== PRIVATE_DIRECTORY_MODE ||
      !currentUidMatches(fs.lstatSync(absolute, { bigint: true })) ||
      !parent?.directory || Number(parent.mode & 0o7777n) !== PRIVATE_DIRECTORY_MODE ||
      !currentUidMatches(parent)) {
    fail("private_artifact_directory_invalid");
  }
  assertOutputArtifactInventory({
    absolute,
    dev: leaf.dev,
    ino: leaf.ino,
    parent: {
      absolute: path.dirname(absolute),
      dev: parent.dev,
      ino: parent.ino
    },
    stagingDirectory: path.resolve(stagingDirectory),
    created: false
  });
  return absolute;
}

function parseCanonicalArtifact(source, code) {
  const value = parseJsonSource(source, code);
  if (!source.bytes.equals(serializeJson(value))) fail(code);
  return value;
}

function safeHexEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" ||
      !/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function verifyOfflineProcessLocalRotation({
  operationDirectory,
  originalBaselinePath,
  quiescedBaselinePath,
  oldSnapshotPath,
  newSnapshotPath,
  revisionPath,
  operationKeyPath,
  bundleDirectory
}) {
  try {
    const paths = {
      operationDirectory,
      originalBaselinePath,
      quiescedBaselinePath,
      oldSnapshotPath,
      newSnapshotPath,
      revisionPath,
      operationKeyPath,
      bundleDirectory
    };
    assertOperationLayout(paths);
    const inputSources = readInputSources(paths);
    const parsed = parseInputSources(inputSources);
    const profile = loadProcessLocalRotationProfile();
    assertCanonicalInputSources(inputSources, parsed);
    const operationIntent = loadVerifiedProcessLocalRotationIntent({ operationDirectory });
    const barrierBinding = loadVerifiedProcessLocalBarrierBinding({ operationDirectory });
    assertIntentMatchesInputs(operationIntent, inputSources, parsed, profile);
    const artifactDirectory = assertPrivateArtifactDirectory(
      bundleDirectory,
      operationDirectory
    );
    const bundleSource = readPrivateFile(
      path.join(artifactDirectory, ARTIFACT_NAMES.bundle), MAX_ARTIFACT_BYTES
    );
    const redactedSource = readPrivateFile(
      path.join(artifactDirectory, ARTIFACT_NAMES.redacted), MAX_ARTIFACT_BYTES
    );
    const restartSource = readPrivateFile(
      path.join(artifactDirectory, ARTIFACT_NAMES.restart), MAX_ARTIFACT_BYTES
    );
    const bindingSource = readPrivateFile(
      path.join(artifactDirectory, ARTIFACT_NAMES.binding), MAX_ARTIFACT_BYTES
    );
    const actual = {
      bundle: parseCanonicalArtifact(bundleSource, "bundle_artifact_invalid"),
      redacted: parseCanonicalArtifact(redactedSource, "redacted_artifact_invalid"),
      restart: parseCanonicalArtifact(restartSource, "restart_artifact_invalid"),
      binding: parseCanonicalArtifact(bindingSource, "binding_artifact_invalid")
    };
    const expected = buildExpectedArtifacts(
      inputSources,
      parsed,
      inputSources.operationKey.bytes,
      operationIntent,
      barrierBinding,
      profile
    );
    if (canonicalJson(actual.bundle) !== canonicalJson(expected.bundle) ||
        canonicalJson(actual.redacted) !== canonicalJson(expected.redacted) ||
        canonicalJson(actual.restart) !== canonicalJson(expected.restartContract) ||
        canonicalJson(actual.binding) !== canonicalJson(expected.binding) ||
        !safeHexEqual(actual.binding.hmacSha256, expected.binding.hmacSha256)) {
      fail("offline_artifact_contract_mismatch");
    }
    return true;
  } catch (_error) {
    fail("offline_verify_failed", _error?.code);
  }
}

function parseCliArguments(argv) {
  const command = argv[0];
  if (!new Set(["prepare", "verify", "verify-plan"]).has(command)) {
    fail("arguments_invalid");
  }
  const full = new Set([
    "--operation-directory",
    "--original-baseline",
    "--quiesced-baseline",
    "--old-snapshot",
    "--new-snapshot",
    "--revision-file",
    "--operation-key",
    "--bundle-directory"
  ]);
  const plan = new Set([
    "--operation-directory",
    "--original-baseline",
    "--old-snapshot",
    "--new-snapshot"
  ]);
  const allowed = command === "verify-plan" ? plan : full;
  const values = new Map();
  const remainder = argv.slice(1);
  if (remainder.length !== allowed.size * 2) fail("arguments_invalid");
  for (let index = 0; index < remainder.length; index += 2) {
    const flag = remainder[index];
    const value = remainder[index + 1];
    if (!allowed.has(flag) || values.has(flag) || typeof value !== "string" ||
        !value || value.startsWith("--")) {
      fail("arguments_invalid");
    }
    values.set(flag, value);
  }
  if (values.size !== allowed.size) fail("arguments_invalid");
  const options = {
    operationDirectory: values.get("--operation-directory"),
    originalBaselinePath: values.get("--original-baseline"),
    oldSnapshotPath: values.get("--old-snapshot"),
    newSnapshotPath: values.get("--new-snapshot")
  };
  if (command !== "verify-plan") {
    Object.assign(options, {
      quiescedBaselinePath: values.get("--quiesced-baseline"),
      revisionPath: values.get("--revision-file"),
      operationKeyPath: values.get("--operation-key"),
      bundleDirectory: values.get("--bundle-directory")
    });
  }
  return {
    command,
    options
  };
}

function main() {
  try {
    const parsed = parseCliArguments(process.argv.slice(2));
    if (parsed.command === "prepare") {
      prepareOfflineProcessLocalRotation(parsed.options);
    } else if (parsed.command === "verify-plan") {
      verifyOfflineProcessLocalRotationPlan(parsed.options);
    } else {
      verifyOfflineProcessLocalRotation(parsed.options);
    }
  } catch {
    process.stderr.write("offline process-local rotation failed closed\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

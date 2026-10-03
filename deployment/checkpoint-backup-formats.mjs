import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJsonV1,
  parseCanonicalJsonV1,
  parseCheckpointBackupAuthorityVersioned
} from "./recovery-checkpoint-authority.mjs";

const MAX_PUBLIC_BYTES = 8 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/u;
const EVIDENCE_HASH = /^[a-fA-F0-9]{64}$/u;
const STAMP = /^[0-9]{8}-[0-9]{6}$/u;
const OPERATION_ID = /^[a-f0-9]{32}$/u;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/u;
const CONSUMER_NAMES = Object.freeze([
  "bot-orchestrator", "coturn", "pgbouncer", "pgbouncer-t", "reticulum"
]);
const OPERATION_FENCE_NAME = "recovery-operation-pod-fence.yenhubs.org";

function reject(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return record(value) && canonicalJsonV1(Object.keys(value).sort()) ===
    canonicalJsonV1([...keys].sort());
}

function nonempty(value) {
  return typeof value === "string" && value.length > 0;
}

// Snapshot only JSON data. No callbacks, keyring, private lock or HMAC body are
// accepted here. The live authentication boundary must remain with the caller.
function publicSnapshot(value) {
  const active = new Set();
  const check = data => {
    if (data === null || typeof data !== "object") return;
    if (active.has(data)) reject("checkpoint_backup_public_json");
    active.add(data);
    if (Array.isArray(data)) {
      if (Object.keys(data).length !== data.length) reject("checkpoint_backup_public_json");
      for (let index = 0; index < data.length; index += 1) {
        if (!Object.hasOwn(data, index)) reject("checkpoint_backup_public_json");
      }
    }
    for (const key of Reflect.ownKeys(data)) {
      if (Array.isArray(data) && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(data, key);
      if (typeof key !== "string" || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        reject("checkpoint_backup_public_json");
      }
      check(descriptor.value);
    }
    active.delete(data);
  };
  check(value);
  return parseCanonicalJsonV1(canonicalJsonV1(value), {
    maximumBytes: MAX_PUBLIC_BYTES
  });
}

function canonicalAuthority(value) {
  if (typeof value !== "string") reject("checkpoint_backup_authority_string");
  const authority = parseCheckpointBackupAuthorityVersioned(value);
  if (authority.schema_version !== 2) reject("checkpoint_backup_authority_version");
  return authority;
}

function contractFor(authority) {
  return {
    schema_version: 3,
    operation_id: authority.operation_id,
    authority_sha256: createHash("sha256")
      .update(Buffer.from(canonicalJsonV1(authority), "utf8")).digest("hex"),
    consumers: authority.consumers
  };
}

function identity(value, namespaced = false) {
  return exactKeys(value, [
    "api_version", "kind", "name", "uid", "resource_version",
    ...(namespaced ? ["namespace"] : [])
  ]) && Object.values(value).every(nonempty);
}

function inventoryOperationFence(controlPlane, authority) {
  const fence = authority.operation_fence;
  const matches = (entries, apiVersion, kind, name, uid) => {
    const selected = entries.filter(value => value.api_version === apiVersion &&
      value.kind === kind && value.name === name);
    return selected.length === 1 && selected[0].uid === uid;
  };
  if (fence.namespaces.parent.uid !== authority.namespace.uid ||
      ![fence.namespaces.parent, fence.namespaces.runner].every(namespace =>
        matches(controlPlane.namespaces, "v1", "Namespace", namespace.name, namespace.uid)
      ) ||
      !matches(controlPlane.cluster_resources, "admissionregistration.k8s.io/v1",
        "ValidatingAdmissionPolicy", OPERATION_FENCE_NAME, fence.policy.uid) ||
      !matches(controlPlane.cluster_resources, "admissionregistration.k8s.io/v1",
        "ValidatingAdmissionPolicyBinding", OPERATION_FENCE_NAME, fence.binding.uid)) {
    reject("checkpoint_backup_inventory_operation_fence");
  }
}

function inventoryRuntime(runtime, authority) {
  if (!exactKeys(runtime, ["control_plane", "generation", "image", "mode", "recovery_epoch"]) ||
      runtime.generation !== authority.runner_generation) {
    reject("checkpoint_backup_inventory_runtime");
  }
  if (runtime.generation === "legacy-absent") {
    if (runtime.mode !== "process-local" || runtime.image !== null ||
        canonicalJsonV1(runtime.control_plane) !== '{"state":"legacy-absent"}' ||
        canonicalJsonV1(runtime.recovery_epoch) !== '{"state":"legacy-absent"}') {
      reject("checkpoint_backup_inventory_runtime");
    }
    return;
  }
  const controlPlane = runtime.control_plane;
  if (runtime.mode !== "kubernetes-pod" || !nonempty(runtime.image) ||
      !exactKeys(runtime.recovery_epoch, ["state", "value"]) ||
      runtime.recovery_epoch.state !== "bound" ||
      !UUID_V4.test(runtime.recovery_epoch.value || "") ||
      !exactKeys(controlPlane, ["state", "namespaces", "namespaced_resources", "cluster_resources"]) ||
      controlPlane.state !== "kubernetes-active" ||
      !Array.isArray(controlPlane.namespaces) ||
      !controlPlane.namespaces.every(value => identity(value)) ||
      !Array.isArray(controlPlane.namespaced_resources) ||
      !controlPlane.namespaced_resources.every(value => identity(value, true)) ||
      !Array.isArray(controlPlane.cluster_resources) ||
      !controlPlane.cluster_resources.every(value => identity(value))) {
    reject("checkpoint_backup_inventory_runtime");
  }
  inventoryOperationFence(controlPlane, authority);
}

function inventoryBinding(inventory) {
  if (!exactKeys(inventory, [
    "schema_version", "namespace", "namespace_uid", "bot_runner_runtime",
    "deployments", "backup_authority"
  ]) || inventory.schema_version !== 5) {
    reject("checkpoint_backup_inventory_schema");
  }
  const authority = canonicalAuthority(inventory.backup_authority);
  if (inventory.namespace !== authority.namespace.name ||
      inventory.namespace_uid !== authority.namespace.uid) {
    reject("checkpoint_backup_inventory_namespace_binding");
  }
  inventoryRuntime(inventory.bot_runner_runtime, authority);
  if (!Array.isArray(inventory.deployments)) reject("checkpoint_backup_inventory_deployments");
  const byName = new Map();
  for (const deployment of inventory.deployments) {
    if (!exactKeys(deployment, ["name", "uid", "replicas", "containers", "init_containers"]) ||
        !nonempty(deployment.name) || !nonempty(deployment.uid) ||
        !Number.isSafeInteger(deployment.replicas) || deployment.replicas < 0 ||
        byName.has(deployment.name) || !Array.isArray(deployment.containers) ||
        !Array.isArray(deployment.init_containers) ||
        ![...deployment.containers, ...deployment.init_containers].every(container =>
          exactKeys(container, ["name", "image"]) && nonempty(container.name) && nonempty(container.image)
        )) {
      reject("checkpoint_backup_inventory_deployments");
    }
    byName.set(deployment.name, deployment);
  }
  for (const consumer of authority.consumers) {
    const deployment = byName.get(consumer.name);
    if (!deployment || deployment.uid !== consumer.uid ||
        deployment.replicas !== consumer.original_replicas) {
      reject("checkpoint_backup_inventory_consumer_binding");
    }
  }
  const originalBotReplicas = authority.consumers[0].original_replicas;
  if (!CONSUMER_NAMES.every((name, index) => authority.consumers[index].name === name) ||
      ![0, 1].includes(originalBotReplicas)) {
    reject("checkpoint_backup_inventory_bot_replicas");
  }
  return { authority, consumerContract: contractFor(authority), originalBotReplicas };
}

// This checks the new public schema and signed-field correlations, not the
// original HMAC nor the complete trusted image/control-plane topology. Retain
// the existing mandatory inventory/evidence validators when composing it.
export function validateSignedCheckpointInventory(inventory) {
  return inventoryBinding(publicSnapshot(inventory));
}

function utc(value) {
  if (typeof value !== "string" || !UTC.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() ===
    value.replace(/Z$/u, ".000Z");
}

function quiescence(value, required = false) {
  return exactKeys(value, ["started_at_utc", "completed_at_utc", ...(required ? ["required"] : [])]) &&
    (!required || value.required === true) && utc(value.started_at_utc) &&
    utc(value.completed_at_utc) && value.completed_at_utc >= value.started_at_utc;
}

function provenance(value, generator) {
  return exactKeys(value, ["generator", "external_import"]) &&
    value.generator === generator && value.external_import === false;
}

function sourceIdentity(value) {
  return exactKeys(value, ["name", "uid"]) && nonempty(value.name) && nonempty(value.uid);
}

function payload(value, filename) {
  return exactKeys(value, ["filename", "size_bytes", "sha256"]) &&
    value.filename === filename && Number.isSafeInteger(value.size_bytes) &&
    value.size_bytes > 0 && typeof value.sha256 === "string" && HASH.test(value.sha256);
}

function legacyMetadata(metadata, authority) {
  if (!exactKeys(metadata, [
    "schema_version", "provenance", "stamp", "created_at_utc", "created_at_epoch",
    "kube_context", "namespace", "namespace_uid", "ret_pvc_uid", "operation_id",
    "runtime_generation", "runner_cutover_evidence_sha256", "writer_quiescence",
    "backup_authority", "consumer_contract"
  ]) || metadata.schema_version !== 4 || typeof metadata.stamp !== "string" || !STAMP.test(metadata.stamp) ||
      !utc(metadata.created_at_utc) || !Number.isSafeInteger(metadata.created_at_epoch) ||
      metadata.created_at_epoch <= 0 || !nonempty(metadata.kube_context) ||
      !provenance(metadata.provenance, "yenhubs-local-coordinated-checkpoint-v4") ||
      !quiescence(metadata.writer_quiescence, true) ||
      typeof metadata.runner_cutover_evidence_sha256 !== "string" ||
      !EVIDENCE_HASH.test(metadata.runner_cutover_evidence_sha256)) {
    reject("checkpoint_backup_metadata_schema");
  }
  if (metadata.operation_id !== authority.operation_id ||
      metadata.namespace !== authority.namespace.name ||
      metadata.namespace_uid !== authority.namespace.uid ||
      metadata.ret_pvc_uid !== authority.pvc.uid ||
      metadata.runtime_generation !== authority.runner_generation) {
    reject("checkpoint_backup_metadata_authority_binding");
  }
}

function freezeMetadata(metadata, authority) {
  if (!exactKeys(metadata, [
    "schema", "client_instance_id", "freeze_id", "stamp", "created_at_utc",
    "source", "operation", "payloads", "runtime_generation", "runner_mode",
    "provenance", "minimum_restore_version", "publication_state",
    "backup_authority", "consumer_contract"
  ]) || metadata.schema !== "freeze-bundle-v2" ||
      typeof metadata.client_instance_id !== "string" ||
      !/^[a-z0-9][a-z0-9-]{2,62}$/u.test(metadata.client_instance_id) ||
      typeof metadata.stamp !== "string" || !STAMP.test(metadata.stamp) ||
      !utc(metadata.created_at_utc) ||
      typeof metadata.freeze_id !== "string" || !OPERATION_ID.test(metadata.freeze_id) ||
      metadata.minimum_restore_version !== 2 || metadata.publication_state !== "complete" ||
      metadata.runtime_generation !== "legacy-absent" || metadata.runner_mode !== "process-local" ||
      !provenance(metadata.provenance, "yenhubs-freeze-bundle-v2") ||
      !exactKeys(metadata.source, ["kube_context", "cluster", "namespace", "pvc"]) ||
      !nonempty(metadata.source.kube_context) || !sourceIdentity(metadata.source.cluster) ||
      !sourceIdentity(metadata.source.namespace) || !sourceIdentity(metadata.source.pvc) ||
      !exactKeys(metadata.operation, ["id", "quiescence"]) ||
      metadata.operation.id !== metadata.freeze_id || !quiescence(metadata.operation.quiescence) ||
      !exactKeys(metadata.payloads, ["database", "storage"]) ||
      !payload(metadata.payloads.database, `retdb-${metadata.stamp}.sql.gz`) ||
      !payload(metadata.payloads.storage, `ret-storage-${metadata.stamp}.tar.gz`)) {
    reject("checkpoint_backup_freeze_schema");
  }
  if (metadata.freeze_id !== authority.operation_id ||
      metadata.source.namespace.name !== authority.namespace.name ||
      metadata.source.namespace.uid !== authority.namespace.uid ||
      metadata.source.pvc.name !== authority.pvc.name ||
      metadata.source.pvc.uid !== authority.pvc.uid ||
      metadata.runtime_generation !== authority.runner_generation) {
    reject("checkpoint_backup_metadata_authority_binding");
  }
}

export function validateSignedCheckpointPublicBinding(request) {
  if (!exactKeys(request, ["metadata", "inventory"])) reject("checkpoint_backup_binding_request");
  const { metadata: snapshot, inventory } = publicSnapshot(request);
  const binding = inventoryBinding(inventory);
  if (!record(snapshot)) reject("checkpoint_backup_metadata_version");
  if (snapshot.schema_version === 4) legacyMetadata(snapshot, binding.authority);
  else if (snapshot.schema === "freeze-bundle-v2") freezeMetadata(snapshot, binding.authority);
  else reject("checkpoint_backup_metadata_version");
  if (snapshot.backup_authority !== inventory.backup_authority) {
    reject("checkpoint_backup_metadata_authority_bytes");
  }
  if (!exactKeys(snapshot.consumer_contract, [
    "schema_version", "operation_id", "authority_sha256", "consumers"
  ]) || snapshot.consumer_contract.schema_version !== 3 ||
      canonicalJsonV1(snapshot.consumer_contract) !== canonicalJsonV1(binding.consumerContract)) {
    reject("checkpoint_backup_consumer_contract_binding");
  }
  return binding;
}

async function readPublicStdin() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    length += bytes.length;
    if (length > MAX_PUBLIC_BYTES) reject("checkpoint_backup_public_size");
    chunks.push(bytes);
  }
  return parseCanonicalJsonV1(Buffer.concat(chunks, length), { maximumBytes: MAX_PUBLIC_BYTES });
}

async function main() {
  try {
    const [command, ...extra] = process.argv.slice(2);
    if (extra.length !== 0 || !["validate-inventory", "validate-binding"].includes(command)) {
      reject("checkpoint_backup_cli");
    }
    const input = await readPublicStdin();
    if (command === "validate-inventory") validateSignedCheckpointInventory(input);
    else validateSignedCheckpointPublicBinding(input);
  } catch (_error) {
    process.stderr.write("checkpoint_backup_formats_failed\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

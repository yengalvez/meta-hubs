import { createHash } from "node:crypto";
import { readFile, open, rename } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

export const sha = bytes => createHash("sha256").update(bytes).digest("hex");
export const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}

export async function durableSave(file, value) {
  const handle = await open(file + ".next", "w", 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  await rename(file + ".next", file);
  const directory = await open(path.dirname(file), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

// Once an intent exists, no request is retried, even if the first request never
// reached the server. A readback must prove it or the operator must reconcile.
export async function mutation({ item, key, intent, save, send, inspect }) {
  item.operations ||= {};
  let operation = item.operations[key];
  if (!operation) {
    operation = item.operations[key] = { intent, state: "requested" };
    await save(); // fsync before any irreversible network write
    await send(intent);
  } else if (!equal(operation.intent, intent)) {
    throw new Error(`Mutation intent changed: ${key}`);
  }
  const result = await inspect(operation.intent);
  if (!result) throw new Error(`Uncertain ${key}; no automatic retry; reconcile exact identity`);
  operation.state = "confirmed";
  await save();
  return result;
}

export function assertRow(actual, expected, ignored = []) {
  const omit = row => Object.fromEntries(Object.entries(row).filter(([k]) => !ignored.includes(k)).map(([k, v]) => [k, timestampValue(k, v)]));
  if (!actual || !equal(omit(actual), omit(expected))) throw new Error("Concurrent modification or write readback mismatch");
}
function timestampValue(key, value) {
  if (!["updated_at", "inserted_at", "reviewed_at"].includes(key) || typeof value !== "string") return value;
  // Reticulum's PostgREST view returns UTC naive timestamps at second
  // precision; JSON intents can carry milliseconds and a trailing Z. Compare
  // at the persisted precision without interpreting naive UTC as local time.
  const utc = /(?:Z|[+-]\d{2}:\d{2})$/u.test(value) ? value : `${value}Z`;
  const parsed = Date.parse(utc);
  return Number.isFinite(parsed) ? Math.round(parsed / 1000) * 1000 : value;
}
export const fieldEqual = (key, a, b) => equal(timestampValue(key, a), timestampValue(key, b));

// Reticulum's avatar update uses the name as its slug source. The deployed
// backend preserves the middle dot used by this fixed catalogue; observed
// live for the first conditional PUT on 2026-09-28. Fail closed for any other
// alphabet rather than accepting an arbitrary slug on reconciliation.
export function catalogAvatarSlug(sid, name) {
  if (typeof sid !== "string" || !/^[A-Za-z0-9_-]+$/.test(sid) ||
      typeof name !== "string" || !/^[A-Za-z0-9 _·ñÑ-]+$/.test(name)) {
    throw new Error("Unsupported catalogue slug alphabet");
  }
  return name.replace(/[ñÑ]/g, "n").toLowerCase().trim()
    .replace(/[ _]+/g, "-").replace(/^-|-$/g, "");
}

export function hasMutationIntent(journal) {
  return Object.values(journal.entries || {}).some(item =>
    [item.uploads || {}, item.operations || {}].some(operations => Object.values(operations).some(operation =>
      ["requested", "confirmed"].includes(operation.state))));
}

export function checkpointBindingForJournal(journal) {
  if (!hasMutationIntent(journal)) return undefined;
  if (!journal.checkpointReceipt) throw new Error("Mutation intent has no durable checkpoint binding");
  return journal.checkpointReceipt;
}

export function validateTarget(target, base) {
  const common = ["schema_version", "base", "kube_context", "namespace", "namespace_uid", "ret_pvc_uid"];
  const extras = target?.client_instance_id === undefined ? [] : ["client_instance_id", "cluster_uid"];
  if (!target || !equal(Object.keys(target).sort(), [...common, ...extras].sort()) || target.schema_version !== 1 ||
      [...common.slice(1), ...extras].some(k => typeof target[k] !== "string" || !target[k].trim()) || target.base !== base) {
    throw new Error("Invalid or mismatched independent target identity");
  }
  const url = new URL(base);
  if (url.protocol !== "https:" || url.origin !== base) throw new Error("Target base must be an HTTPS origin");
  return target;
}

export function bindCheckpoint({ metadata, target, manifestHash, checkpointHash, now = Date.now(), previous, maxAgeHours = 24 }) {
  validateTarget(target, target.base);
  if (!(Number.isFinite(maxAgeHours) && maxAgeHours > 0 && maxAgeHours <= 24)) throw new Error("Checkpoint age must be greater than zero and at most 24 hours");
  const freeze = metadata.schema === "freeze-bundle-v1";
  const source = freeze ? {
    kube_context: metadata.source?.kube_context, namespace: metadata.source?.namespace?.name,
    namespace_uid: metadata.source?.namespace?.uid, ret_pvc_uid: metadata.source?.pvc?.uid,
    client_instance_id: metadata.client_instance_id, cluster_uid: metadata.source?.cluster?.uid
  } : Object.fromEntries(["kube_context", "namespace", "namespace_uid", "ret_pvc_uid"].map(k => [k, metadata[k]]));
  if (Object.entries(source).some(([k, v]) => !v || target[k] !== v) || (!freeze && target.client_instance_id !== undefined)) {
    throw new Error("Checkpoint belongs to another destination instance");
  }
  const created = Date.parse(metadata.created_at_utc);
  const completed = Date.parse(freeze ? metadata.operation?.quiescence?.completed_at_utc : metadata.writer_quiescence?.completed_at_utc);
  const firstMutationAt = previous?.firstMutationAt || new Date(now).toISOString();
  const at = Date.parse(firstMutationAt);
  if (![created, completed, at, now].every(Number.isFinite) || created > completed || completed > at || at > now ||
      at - created > maxAgeHours * 3600000) throw new Error("Checkpoint is stale, future-dated, or not a pre-mutation snapshot");
  const receipt = { version: 1, target, manifestHash, checkpointHash, firstMutationAt, maxAgeHours };
  if (previous && !equal(previous, receipt)) throw new Error("Checkpoint binding changed since first mutation");
  return receipt;
}

// This is an adapter, not a second checkpoint validator. The recovery library
// owns layout, checksums, metadata, generation and DB/media contract validation.
export async function validateCatalogCheckpoint({ checkpoint, scriptDir, target, base, manifestHash, previous, maxAgeHours = 24, now = Date.now() }) {
  validateTarget(target, base);
  const manifest = path.join(checkpoint, "SHA256SUMS");
  const before = sha(await readFile(manifest));
  await promisify(execFile)("bash", [path.join(scriptDir, "validate-rpm-catalog-checkpoint.sh"), checkpoint], { maxBuffer: 1024 * 1024 });
  const metadata = JSON.parse(await readFile(path.join(checkpoint, "checkpoint-metadata.json"), "utf8"));
  if (before !== sha(await readFile(manifest))) throw new Error("Checkpoint changed during validation");
  return bindCheckpoint({ metadata, target, manifestHash, checkpointHash: before, previous, maxAgeHours, now });
}

/** Closed physical-snapshot format. It is intentionally not a SQL checkpoint. */
import { open, lstat, realpath } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { readPrivateBytes, readPrivateSource } from "./monthly-snapshot-worker.mjs";
import { bindPostgresLayout } from "./monthly-snapshot-source.mjs";
import { civilMonth } from "./monthly-backup-retention.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function requireValue(condition, reason) { if (!condition) throw new Error(reason); }

export const nativeMonthlyArtifacts = Object.freeze([
  "checkpoint-metadata.json", "configured-value-keys.txt", "database-contract.json",
  "deployment-images.json", "digitalocean-cluster.json", "digitalocean-load-balancers.json",
  "digitalocean-volumes.json", "git-state.txt", "k8s-configmaps-redacted.json",
  "k8s-hcce-structure.json", "runner-cutover-evidence.json",
  "monthly-source.json", "native-pair.json", "runtime.tar.gz"
]);

export const minimalMonthlyArtifacts = Object.freeze([
  "checkpoint-metadata.json", "database-contract.json", "deployment-images.json",
  "monthly-source.json", "native-pair.json", "runtime.tar.gz", "attempt.jsonl"
]);
export function monthlyArtifacts(metadata) {
  return metadata?.runtime_generation === "minimal-snapshot-v1" ? minimalMonthlyArtifacts : nativeMonthlyArtifacts;
}

export function validateMonthlyNativePair({ source, pair, contract, metadata = null }) {
  requireValue(source?.schema === "yenhubs-monthly-source-v1" && source.state === "inventory-not-captured" &&
    pair?.schema === "yenhubs-native-monthly-pair-v1" && pair.state === "captured-not-restore-accepted" &&
    pair.instanceId === source.instanceId && pair.context === source.context && pair.region === source.region &&
    JSON.stringify(pair.namespace) === JSON.stringify(source.namespace) &&
    /^[a-f0-9]{32}$/.test(pair.operationId ?? "") && /^\d{4}-(0[1-9]|1[0-2])$/.test(pair.month ?? ""),
    "monthly_pair_binding_invalid");
  requireValue(contract?.schema_version === 2 && contract.sql_dump_sha256 === null &&
    pair.databaseContractSha256 === digest(JSON.stringify(contract)), "monthly_pair_database_contract_changed");
  requireValue(JSON.stringify(pair.acceptance) === JSON.stringify({ parentTerminalJoin: false,
    writersResumed: false, portableExport: false, isolatedDigitalOceanRestore: false, isolatedDriveRestore: false }),
    "monthly_pair_acceptance_not_capture_only");
  bindPostgresLayout(source.postgres, source.volumes?.database?.mountPath);
  requireValue(JSON.stringify(pair.postgres) === JSON.stringify(source.postgres), "monthly_pair_postgres_layout_changed");
  const started = Date.parse(pair.startedAt), captured = Date.parse(pair.capturedAt);
  requireValue(Number.isFinite(started) && Number.isFinite(captured) && captured >= started &&
    civilMonth(started) === pair.month && civilMonth(captured) === pair.month &&
    Number.isSafeInteger(pair.durationMilliseconds) && pair.durationMilliseconds >= captured - started,
    "monthly_pair_capture_time_invalid");
  for (const role of ["database", "media"]) {
    const snapshot = pair.snapshots?.[role], volume = source.volumes?.[role];
    requireValue(uuid.test(volume?.volumeId ?? "") && uuid.test(volume.pvcUid ?? "") && uuid.test(volume.pvUid ?? "") &&
      snapshot && (uuid.test(snapshot.id ?? "") || /^[1-9][0-9]*$/.test(snapshot.id ?? "")) &&
      snapshot.volumeId === volume.volumeId && snapshot.region === source.region &&
      snapshot.name === `${source.instanceId}-${pair.month}-${role}` &&
      Number.isSafeInteger(snapshot.minimumDiskGiB) && snapshot.minimumDiskGiB >= volume.sizeGiB &&
      Number.isFinite(snapshot.billableGiB) && snapshot.billableGiB >= 0 &&
      Date.parse(snapshot.createdAt) >= Math.floor(started / 1000) * 1000 &&
      Date.parse(snapshot.createdAt) <= Math.floor(captured / 1000) * 1000 + 999,
      "monthly_pair_snapshot_identity_invalid");
  }
  requireValue(source.volumes.database.volumeId !== source.volumes.media.volumeId &&
    pair.snapshots.database.id !== pair.snapshots.media.id, "monthly_pair_not_distinct");
  if (metadata) {
    const minimal = metadata.schema_version === 5 && metadata.runtime_generation === "minimal-snapshot-v1" &&
      metadata.recovery?.servicesResumed === true && metadata.recovery.deferredRecoveryDisarmed === true;
    requireValue((minimal || ([3, 4].includes(metadata.schema_version) && metadata.runtime_generation === "durable-v2")) &&
      metadata.operation_id === pair.operationId && metadata.kube_context === pair.context &&
      metadata.namespace === pair.namespace.name && metadata.namespace_uid === pair.namespace.uid &&
      metadata.ret_pvc_uid === source.volumes.media.pvcUid && metadata.writer_quiescence?.required === true &&
      Date.parse(metadata.writer_quiescence.started_at_utc) <= started &&
      Date.parse(metadata.writer_quiescence.completed_at_utc) >= Math.floor(captured / 1000) * 1000,
      "monthly_pair_parent_window_invalid");
  }
}

async function requirePrivateDirectory(path) {
  const directory = resolve(path), stat = await lstat(directory);
  requireValue(await realpath(directory) === directory && stat.isDirectory() && stat.uid === process.getuid() &&
    (stat.mode & 0o777) === 0o700, "monthly_bundle_directory_not_private");
  return directory;
}

// Three small, already snapshotted authorization files. Build fixed USTAR
// entries from pinned bytes, not by letting tar reopen mutable secret paths.
function runtimeTar(files) {
  const parts = [];
  for (const [name, bytes] of files) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "ascii");
    for (const [offset, width, value] of [[100, 8, 0o600], [108, 8, 0], [116, 8, 0],
      [124, 12, bytes.length], [136, 12, 0]]) {
      header.write(value.toString(8).padStart(width - 1, "0") + "\0", offset, width, "ascii");
    }
    header.fill(0x20, 148, 156); header.write("0", 156); header.write("ustar\0", 257); header.write("00", 263);
    const sum = header.reduce((total, value) => total + value, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    parts.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

export function inspectMonthlyRuntimeArchive(compressed) {
  let bytes;
  try {
    bytes = gunzipSync(compressed, { maxOutputLength: 50 * 1024 * 1024 });
    const expected = ["input-values.yaml", "hcce.yaml", "cutover.key"], files = [];
    let offset = 0;
    for (const name of expected) {
      const header = bytes.subarray(offset, offset + 512);
      requireValue(header.length === 512 && header.subarray(0, 100).toString("ascii").split("\0")[0] === name &&
        header.subarray(257, 263).toString("ascii") === "ustar\0" && header[156] === 0x30 &&
        header.subarray(345, 500).every(value => value === 0), "monthly_runtime_entry_invalid");
      const octal = (start, length) => {
        const text = header.subarray(start, start + length).toString("ascii").replace(/[\0 ]+$/, "");
        requireValue(/^[0-7]+$/.test(text), "monthly_runtime_entry_invalid");
        return Number.parseInt(text, 8);
      };
      const sum = header.reduce((total, value, i) => total + (i >= 148 && i < 156 ? 0x20 : value), 0);
      const size = octal(124, 12);
      requireValue(octal(148, 8) === sum && octal(100, 8) === 0o600 &&
        size > 0 && size <= 16 * 1024 * 1024 && offset + 512 + size <= bytes.length,
        "monthly_runtime_entry_invalid");
      files.push({ name, bytes: size, sha256: digest(bytes.subarray(offset + 512, offset + 512 + size)) });
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    requireValue(bytes.length === offset + 1024 && bytes.subarray(offset).every(value => value === 0),
      "monthly_runtime_trailing_bytes_invalid");
    return files;
  } finally { bytes?.fill(0); }
}

export async function writeMonthlyRuntimeArchive({ output, valuesPath, manifestPath, keyPath, journalRoot }) {
  await requirePrivateDirectory(dirname(resolve(output)));
  await requirePrivateDirectory(journalRoot);
  const files = [], names = ["input-values.yaml", "hcce.yaml", "cutover.key"];
  let tar, compressed;
  try {
    for (const [i, path] of [valuesPath, manifestPath, keyPath].entries()) {
      files.push([names[i], await readPrivateBytes(path, 16 * 1024 * 1024)]);
    }
    tar = runtimeTar(files); compressed = gzipSync(tar);
    const target = await open(resolve(output), "wx", 0o600);
    try { await target.writeFile(compressed); await target.sync(); } finally { await target.close(); }
  } finally {
    for (const [, bytes] of files) bytes.fill(0);
    tar?.fill(0); compressed?.fill(0);
  }
}

export async function validateMonthlyNativeContent(directory, stamp) {
  await requirePrivateDirectory(directory);
  const [source, pair, contract, metadata] = await Promise.all([
    "monthly-source.json", "native-pair.json", "database-contract.json", "checkpoint-metadata.json"
  ].map(name => readPrivateSource(resolve(directory, name), 16 * 1024 * 1024)));
  requireValue(metadata.stamp === stamp, "monthly_bundle_stamp_changed");
  validateMonthlyNativePair({ source, pair, contract, metadata });
  const runtime = await readPrivateBytes(resolve(directory, "runtime.tar.gz"), 64 * 1024 * 1024);
  try { inspectMonthlyRuntimeArchive(runtime); }
  finally { runtime.fill(0); }
  return { state: "capture-only-not-restore-accepted", artifacts: monthlyArtifacts(metadata).length };
}

export async function validateMonthlyNativeManifest(directory, stamp) {
  const metadata = await readPrivateSource(resolve(directory, "checkpoint-metadata.json"));
  const artifacts = monthlyArtifacts(metadata);
  const bytes = await readPrivateBytes(resolve(directory, "SHA256SUMS"));
  let lines;
  try { lines = bytes.toString("utf8").trimEnd().split("\n"); } finally { bytes.fill(0); }
  const entries = lines.map(line => /^([a-f0-9]{64})  ([a-zA-Z0-9.-]+)$/.exec(line));
  requireValue(entries.length === artifacts.length && entries.every(Boolean) &&
    new Set(entries.map(v => v[2])).size === entries.length &&
    entries.every(v => artifacts.includes(v[2])), "monthly_bundle_checksum_set_invalid");
  for (const [, sha256, name] of entries) {
    const content = await readPrivateBytes(resolve(directory, name), 64 * 1024 * 1024);
    try { requireValue(digest(content) === sha256, "monthly_bundle_checksum_changed"); }
    finally { content.fill(0); }
  }
  return validateMonthlyNativeContent(directory, stamp);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [action, ...args] = process.argv.slice(2);
    if (action === "artifacts" && args.length === 0) console.log(nativeMonthlyArtifacts.join("\n"));
    else if (action === "runtime" && args.length === 5) {
      await writeMonthlyRuntimeArchive({ output: args[0], valuesPath: args[1], manifestPath: args[2], keyPath: args[3], journalRoot: args[4] });
      console.log("MONTHLY_RUNTIME_PRIVATE_BOUND");
    } else if (action === "pair" && args.length === 3) {
      validateMonthlyNativePair({ source: await readPrivateSource(args[0]), pair: await readPrivateSource(args[1]),
        contract: await readPrivateSource(args[2], 16 * 1024 * 1024) });
      console.log("MONTHLY_PAIR_CAPTURE_ONLY_VALID");
    } else if (["content", "manifest"].includes(action) && args.length === 2) {
      const result = await (action === "content" ? validateMonthlyNativeContent : validateMonthlyNativeManifest)(...args);
      console.log(JSON.stringify(result));
    } else throw new Error("monthly_bundle_arguments_invalid");
  } catch (error) {
    console.error(/^monthly_[a-z_]+$/.test(error.message) ? error.message : "monthly_bundle_failed");
    process.exitCode = 1;
  }
}

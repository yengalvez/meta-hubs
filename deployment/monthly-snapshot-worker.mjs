/** Fixed worker for the existing three-guard, Lease-supervised DB coordinator. */
import { open, lstat, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { captureMonthlyPair, claimPairJournal, nativeSnapshotProvider } from "./monthly-snapshot-pair.mjs";
import { bindPostgresLayout } from "./monthly-snapshot-source.mjs";

const execute = promisify(execFile);
function requireValue(condition, reason) { if (!condition) throw new Error(reason); }

export function requireSupervisedBinding(source, operationId, env) {
  requireValue(env.YENHUBS_MONTHLY_GUARDED_COMMAND === "1" &&
    env.CHECKPOINT_RUNNER_GENERATION === "durable-v2" &&
    source.context === env.EXPECTED_KUBE_CONTEXT && source.namespace?.name === env.NAMESPACE &&
    source.namespace.uid === env.RECOVERY_NAMESPACE_UID &&
    source.volumes?.media?.pvcUid === env.RECOVERY_PVC_UID &&
    source.volumes?.database?.consumer?.uid === env.MONTHLY_PGSQL_POD_UID &&
    operationId === env.RECOVERY_OPERATION_ID && /^[a-f0-9]{32}$/.test(operationId ?? ""),
    "monthly_protected_parent_binding_missing");
  bindPostgresLayout(source.postgres, source.volumes.database.mountPath);
}

export async function readPrivateBytes(path, maximumBytes = 65536) {
  const canonical = resolve(path);
  requireValue(await realpath(dirname(canonical)) === dirname(canonical), "monthly_source_path_linked");
  const before = await lstat(canonical);
  requireValue(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 &&
    before.uid === process.getuid() && (before.mode & 0o777) === 0o600 && before.size > 0 && before.size <= maximumBytes,
    "monthly_source_file_not_private");
  const file = await open(canonical, "r");
  let bytes;
  try {
    const opened = await file.stat();
    requireValue(opened.dev === before.dev && opened.ino === before.ino, "monthly_source_file_changed");
    bytes = await file.readFile();
    const after = await file.stat();
    const named = await lstat(canonical);
    requireValue(after.size === before.size && after.mtimeMs === before.mtimeMs &&
      after.ctimeMs === before.ctimeMs && named.dev === before.dev && named.ino === before.ino,
      "monthly_source_file_changed");
    return bytes;
  } catch (error) {
    bytes?.fill(0); throw error;
  } finally { await file.close(); }
}

export async function readPrivateSource(path, maximumBytes = 65536) {
  const bytes = await readPrivateBytes(path, maximumBytes);
  try { return JSON.parse(bytes.toString("utf8")); }
  finally { bytes.fill(0); }
}

export function protectedSourceBoundary(source, run = execute) {
  const kube = ["--context", source.context, "--request-timeout=30s"];
  async function read(args) {
    let result;
    try { result = await run("kubectl", [...kube, ...args, "-o", "json"], { timeout: 30000, maxBuffer: 1048576 }); }
    catch { throw new Error("monthly_boundary_read_failed"); }
    try { return JSON.parse(result.stdout); } catch { throw new Error("monthly_boundary_response_invalid"); }
  }
  return async () => {
    const claims = Object.values(source.volumes).map(v => v.pvc);
    const pvs = Object.values(source.volumes).map(v => v.pv);
    const [namespace, pvcList, pvList, pod] = await Promise.all([
      read(["get", "namespace", source.namespace.name]),
      read(["-n", source.namespace.name, "get", "pvc", ...claims]),
      read(["get", "pv", ...pvs]),
      read(["-n", source.namespace.name, "get", "pod", source.volumes.database.consumer.name])
    ]);
    requireValue(namespace.metadata?.uid === source.namespace.uid && !namespace.metadata.deletionTimestamp,
      "monthly_namespace_changed");
    requireValue(pvcList.items?.length === 2 && pvList.items?.length === 2, "monthly_volume_set_changed");
    for (const expected of Object.values(source.volumes)) {
      const pvc = pvcList.items.find(v => v.metadata?.name === expected.pvc);
      const pv = pvList.items.find(v => v.metadata?.name === expected.pv);
      requireValue(pvc?.metadata?.uid === expected.pvcUid && !pvc.metadata.deletionTimestamp &&
        pvc.metadata.namespace === source.namespace.name && pvc.status?.phase === "Bound" &&
        pvc.spec?.volumeName === expected.pv && pv?.metadata?.uid === expected.pvUid &&
        !pv.metadata.deletionTimestamp && pv.status?.phase === "Bound" &&
        pv.spec?.claimRef?.uid === expected.pvcUid && pv.spec.claimRef.namespace === source.namespace.name &&
        pv.spec.claimRef.name === expected.pvc && pv.spec.csi?.driver === "dobs.csi.digitalocean.com" &&
        pv.spec.csi.volumeHandle === expected.volumeId, "monthly_volume_binding_changed");
    }
    requireValue(pod.metadata?.uid === source.volumes.database.consumer.uid && !pod.metadata.deletionTimestamp &&
      pod.spec?.nodeName === source.volumes.database.consumer.node && pod.status?.phase === "Running" &&
      (pod.status.conditions ?? []).some(c => c.type === "Ready" && c.status === "True"), "monthly_pgsql_source_changed");
  };
}

export async function runProtectedPair({ sourcePath, journalPath, month, operationId, contractPath, env = process.env, run = execute }) {
  const source = await readPrivateSource(sourcePath);
  requireSupervisedBinding(source, operationId, env);
  const contract = await readPrivateSource(contractPath, 16 * 1024 * 1024);
  requireValue(contract.schema_version === 2 && contract.sql_dump_sha256 === null,
    "monthly_database_contract_unbound");
  // The DB parent compares complete before/after contracts and validates the
  // schema. Bind this exact sorted JSON representation to the native pair;
  // never label a physical snapshot as a verified SQL dump.
  const contractSha256 = createHash("sha256").update(JSON.stringify(contract)).digest("hex");
  const journal = await claimPairJournal(journalPath, { instanceId: source.instanceId, month, operationId });
  try {
    const pair = await captureMonthlyPair({ source, month, operationId, journal,
      provider: nativeSnapshotProvider(run), checkBoundary: protectedSourceBoundary(source, run),
      flush: async () => {
        try {
          await run("kubectl", ["--context", source.context, "--request-timeout=30s", "-n", source.namespace.name,
            "exec", source.volumes.database.consumer.name, "-c", source.volumes.database.container,
            "--", "sh", "-ec", "sync"], { timeout: 30000, maxBuffer: 32768 });
        } catch { throw new Error("monthly_flush_failed_or_ambiguous"); }
      } });
    return { ...pair, databaseContractSha256: contractSha256 };
  } finally { await journal.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    requireValue(process.argv.length === 7, "monthly_worker_arguments_invalid");
    const result = await runProtectedPair({ sourcePath: process.argv[2], journalPath: process.argv[3],
      month: process.argv[4], operationId: process.argv[5], contractPath: process.argv[6] });
    // The supervised parent captures stdout in its private no-clobber staging
    // file. This contains identities, never values, credentials or key bytes.
    console.log(JSON.stringify(result));
  } catch (error) {
    const reason = /^monthly_[a-z_]+$/.test(error.message) ? error.message : "monthly_worker_failed";
    console.error(JSON.stringify({ status: "PAIR_NOT_ACCEPTED", reason })); process.exitCode = 1;
  }
}

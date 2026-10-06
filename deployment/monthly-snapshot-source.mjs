/** Read-only binding of the monthly point to exact Kubernetes/DO volumes. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { open, lstat, realpath } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";

const execute = promisify(execFile);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const namePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;

function requireValue(condition, reason) { if (!condition) throw new Error(reason); }
function exact(items, predicate) {
  const matches = items.filter(predicate);
  requireValue(matches.length === 1, "source_identity_not_unique");
  return matches[0];
}

export function bindMonthlySource({ context, instanceId, region, namespace, pvcs, pvs, pods, volumes }) {
  requireValue(typeof context === "string" && namePattern.test(instanceId ?? "") &&
    namePattern.test(region ?? ""), "source_arguments_invalid");
  requireValue(namePattern.test(namespace?.metadata?.name ?? "") &&
    uuid.test(namespace?.metadata?.uid ?? "") && !namespace.metadata.deletionTimestamp,
    "source_namespace_invalid");
  const output = { schema: "yenhubs-monthly-source-v1", state: "inventory-not-captured",
    context, instanceId, region, namespace: { name: namespace.metadata.name, uid: namespace.metadata.uid },
    volumes: {} };
  const nodes = [];
  for (const [role, claimName] of Object.entries({ database: "pgsql-pvc", media: "ret-pvc" })) {
    const pvc = exact(pvcs, item => item.metadata?.name === claimName);
    requireValue(pvc.metadata.namespace === namespace.metadata.name && uuid.test(pvc.metadata.uid) &&
      !pvc.metadata.deletionTimestamp && pvc.status?.phase === "Bound", "source_pvc_invalid");
    const pv = exact(pvs, item => item.metadata?.name === pvc.spec?.volumeName);
    requireValue(uuid.test(pv.metadata.uid ?? "") && !pv.metadata.deletionTimestamp &&
      pv.status?.phase === "Bound" && pv.spec?.claimRef?.uid === pvc.metadata.uid &&
      pv.spec.claimRef.name === claimName && pv.spec.claimRef.namespace === namespace.metadata.name &&
      pv.spec.csi?.driver === "dobs.csi.digitalocean.com" && uuid.test(pv.spec.csi.volumeHandle ?? ""),
      "source_pv_binding_invalid");
    const volume = exact(volumes, item => item.id === pv.spec.csi.volumeHandle);
    requireValue(volume.region?.slug === region && Number.isSafeInteger(volume.size_gigabytes) &&
      volume.size_gigabytes > 0, "source_provider_binding_invalid");
    const capacity = pvc.status?.capacity?.storage;
    requireValue(/^\d+Gi$/.test(capacity ?? "") && volume.size_gigabytes >= Number(capacity.slice(0, -2)),
      "source_capacity_mismatch");
    const consumers = pods.filter(pod => pod.metadata?.namespace === namespace.metadata.name &&
      !pod.metadata.deletionTimestamp && (pod.spec?.volumes ?? []).some(v => v.persistentVolumeClaim?.claimName === claimName));
    requireValue(consumers.length === 1 && consumers[0].status?.phase === "Running" &&
      (consumers[0].status?.conditions ?? []).some(c => c.type === "Ready" && c.status === "True"),
      "source_consumer_not_ready_unique");
    const consumer = consumers[0];
    requireValue(uuid.test(consumer.metadata.uid ?? "") && namePattern.test(consumer.spec.nodeName ?? ""),
      "source_consumer_identity_invalid");
    nodes.push(consumer.spec.nodeName);
    output.volumes[role] = { pvc: claimName, pvcUid: pvc.metadata.uid,
      pv: pv.metadata.name, pvUid: pv.metadata.uid, volumeId: volume.id,
      sizeGiB: volume.size_gigabytes, consumer: { name: consumer.metadata.name,
        uid: consumer.metadata.uid, node: consumer.spec.nodeName } };
    if (role === "database") {
      const volumeName = consumer.spec.volumes.find(v => v.persistentVolumeClaim?.claimName === claimName).name;
      const mounts = consumer.spec.containers.flatMap(c => c.volumeMounts ?? []).filter(m => m.name === volumeName);
      requireValue(mounts.length === 1 && mounts[0].mountPath === "/var/lib/postgresql/data" &&
        !mounts[0].subPath && !mounts[0].readOnly, "source_database_mount_unrecognized");
      output.volumes.database.mountPath = mounts[0].mountPath;
      const container = consumer.spec.containers.find(c => (c.volumeMounts ?? []).some(m => m.name === volumeName));
      requireValue(namePattern.test(container?.name ?? ""), "source_database_container_invalid");
      output.volumes.database.container = container.name;
    }
  }
  requireValue(output.volumes.database.volumeId !== output.volumes.media.volumeId,
    "source_volumes_not_distinct");
  // The initial route can flush both filesystems on the verified common node.
  // An unknown/multi-node topology needs a separately verified preparation path.
  requireValue(new Set(nodes).size === 1, "source_common_flush_node_missing");
  output.preparation = { commonNode: nodes[0], filesystemFlushVerified: false,
    postgresWalPlacementVerified: false, protectedPauseVerified: false };
  return output;
}

export function bindPostgresLayout(layout, mountPath) {
  requireValue(layout && /^(1[0-9]|[2-9][0-9])$/.test(layout.major ?? "") &&
    typeof layout.dataPath === "string" &&
    (layout.dataPath === mountPath || layout.dataPath.startsWith(mountPath + "/")) &&
    !layout.dataPath.split("/").some(p => p === "." || p === ".."), "source_postgres_data_path_invalid");
  requireValue(layout.walPath === layout.dataPath + "/pg_wal" &&
    layout.tablespaceEntries === 0 && layout.sameWalFilesystem === true &&
    layout.fsync === "on" && layout.fullPageWrites === "on" && layout.syncAvailable === true,
    "source_postgres_snapshot_layout_unsafe");
  return { ...layout, state: "layout-only-not-flushed", recoverWithMajor: layout.major };
}

export async function inspectPostgresLayout(source, readJson = jsonCommand, run = execute) {
  const database = source.volumes.database;
  const args = ["--context", source.context, "-n", source.namespace.name];
  const podArgs = [...args, "get", "pod", database.consumer.name, "-o", "json"];
  const requirePod = pod => requireValue(pod.metadata?.uid === database.consumer.uid &&
    !pod.metadata.deletionTimestamp && pod.spec?.nodeName === database.consumer.node &&
    pod.status?.phase === "Running" && (pod.status.conditions ?? []).some(c => c.type === "Ready" && c.status === "True"),
    "source_postgres_pod_changed");
  requirePod(await readJson("kubectl", podArgs));
  // Read the directory used by the running server, not just PGDATA or a mount.
  // No CHECKPOINT, sync, writes, service stop or database modification occurs.
  const command = 'set -eu; data=$(psql -U "$POSTGRES_USER" -d postgres -Atq -c "SHOW data_directory"); data=$(readlink -f "$data"); wal=$(readlink -f "$data/pg_wal"); test -f "$data/global/pg_control"; printf "%s\\n" "$(cat "$data/PG_VERSION")" "$data" "$wal" "$(find "$data/pg_tblspc" -mindepth 1 -maxdepth 1 | wc -l | tr -d " ")"; test "$(stat -c %d "$data")" = "$(stat -c %d "$wal")" && printf "same\\n" || printf "different\\n"; psql -U "$POSTGRES_USER" -d postgres -Atq -c "SHOW fsync" -c "SHOW full_page_writes"; command -v sync >/dev/null && printf "sync\\n" || printf "missing\\n"';
  let result;
  try { result = await run("kubectl", [...args, "exec", database.consumer.name, "-c", database.container,
    "--", "sh", "-ec", command], { timeout: 30000, maxBuffer: 32768 }); }
  catch { throw new Error("source_postgres_layout_read_failed"); }
  requirePod(await readJson("kubectl", podArgs));
  const lines = result.stdout.trim().split(/\r?\n/);
  requireValue(lines.length === 8 && /^\d+$/.test(lines[3]), "source_postgres_layout_response_invalid");
  return bindPostgresLayout({ major: lines[0], dataPath: lines[1], walPath: lines[2],
    tablespaceEntries: Number(lines[3]), sameWalFilesystem: lines[4] === "same",
    fsync: lines[5], fullPageWrites: lines[6], syncAvailable: lines[7] === "sync" }, database.mountPath);
}

async function jsonCommand(program, args) {
  let stdout;
  try { ({ stdout } = await execute(program, args, { timeout: 30000, maxBuffer: 8 * 1024 * 1024 })); }
  catch { throw new Error("source_read_command_failed"); }
  try { return JSON.parse(stdout); } catch { throw new Error("source_read_json_invalid"); }
}

export async function inspectMonthlySource({ context, instanceId, namespace, region }, readJson = jsonCommand) {
  requireValue([context, instanceId, namespace, region].every(v => namePattern.test(v ?? "")), "source_arguments_invalid");
  const kube = args => readJson("kubectl", ["--context", context, ...args, "-o", "json"]);
  const [ns, pvcList, podList] = await Promise.all([
    kube(["get", "namespace", namespace]),
    kube(["-n", namespace, "get", "pvc", "pgsql-pvc", "ret-pvc"]),
    kube(["-n", namespace, "get", "pods"])
  ]);
  requireValue(pvcList.items?.length === 2, "source_pvc_set_invalid");
  const pvNames = pvcList.items.map(p => p.spec?.volumeName);
  requireValue(pvNames.every(v => namePattern.test(v ?? "")), "source_pv_name_invalid");
  const pvList = await kube(["get", "pv", ...pvNames]);
  const ids = pvList.items?.map(p => p.spec?.csi?.volumeHandle);
  requireValue(ids?.length === 2 && ids.every(v => uuid.test(v ?? "")), "source_volume_handles_invalid");
  // doctl's volume-get accepts one identity. Passing two silently returns only
  // the first on the installed CLI; bind a separate native GET to each handle.
  const volumeResponses = await Promise.all(ids.map(id => readJson("doctl", [
    "compute", "volume", "get", id, "--output", "json", "--http-retry-max", "0"
  ])));
  requireValue(volumeResponses.every((response, i) => Array.isArray(response) &&
    response.length === 1 && response[0]?.id === ids[i]), "source_provider_response_invalid");
  const volumes = volumeResponses.flat();
  return bindMonthlySource({ context, instanceId, region, namespace: ns,
    pvcs: pvcList.items, pvs: pvList.items, pods: podList.items, volumes });
}

async function writeInventory(path, inventory) {
  const destination = resolve(path);
  const parent = dirname(destination);
  requireValue(await realpath(parent) === parent, "source_output_parent_linked");
  const stat = await lstat(parent);
  requireValue(stat.isDirectory() && stat.uid === process.getuid() && !(stat.mode & 0o077), "source_output_parent_not_private");
  const file = await open(destination, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(inventory, null, 2) + "\n"); await file.sync(); }
  finally { await file.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length !== 10 || ["--context", "--instance", "--namespace", "--region", "--output"].some((k, i) => args[i * 2] !== k)) {
    console.error("Usage: node monthly-snapshot-source.mjs --context CONTEXT --instance ID --namespace NAME --region REGION --output NEW_PRIVATE_JSON");
    process.exitCode = 2;
  } else {
    try {
      const inventory = await inspectMonthlySource({ context: args[1], instanceId: args[3], namespace: args[5], region: args[7] });
      inventory.postgres = await inspectPostgresLayout(inventory);
      inventory.preparation.postgresWalPlacementVerified = true;
      await writeInventory(args[9], inventory);
      console.log(JSON.stringify({ status: "READ_ONLY_SOURCE_BOUND", volumes: 2, state: inventory.state,
        sameNode: true, postgresLayoutVerified: true, captureAuthorized: false }));
    } catch (error) {
      const reason = /^source_[a-z_]+$/.test(error.message) ? error.message : "source_local_io_failed";
      console.error(JSON.stringify({ status: "NOT_BOUND", reason }));
      process.exitCode = 1;
    }
  }
}

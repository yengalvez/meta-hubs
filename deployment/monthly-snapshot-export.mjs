/** Export a published native point through isolated CSI clones, never live PVCs. */
import { open, lstat, realpath, readdir, mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { nativeMonthlyArtifacts, validateMonthlyNativeManifest } from "./monthly-native-bundle.mjs";
import { readPrivateBytes, readPrivateSource } from "./monthly-snapshot-worker.mjs";
import { claimPairJournal } from "./monthly-snapshot-pair.mjs";
import { sealPortablePoint } from "./monthly-portable-point.mjs";

const execute = promisify(execFile);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const requireValue = (value, reason) => { if (!value) throw new Error(reason); };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundleNames = [...nativeMonthlyArtifacts, "SHA256SUMS"].sort();
const canonical = value => JSON.stringify(value, (_, entry) => entry && !Array.isArray(entry) &&
  typeof entry === "object" ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);

async function privateDirectory(path) {
  const directory = resolve(path), stat = await lstat(directory);
  requireValue(await realpath(directory) === directory && stat.isDirectory() && stat.uid === process.getuid() &&
    (stat.mode & 0o777) === 0o700, "export_directory_not_private");
  return directory;
}
async function writeJson(path, value) {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value) + "\n"); await file.sync(); }
  finally { await file.close(); }
}

/** A receipt is written only after the ORIGINAL protected command exits natively 0.
 * No CLI is provided here: the monthly driver must supply its approved runtime inputs.
 * Timeout/exit errors never produce the receipt, even if the publication marker disappeared.
 */
export async function captureMonthlyForExport({ checkpointDirectory, completionPath, environment, run = execute }) {
  const directory = resolve(checkpointDirectory), completion = resolve(completionPath);
  await privateDirectory(dirname(directory)); await privateDirectory(dirname(completion));
  requireValue(!completion.startsWith(directory + "/") && environment?.CHECKPOINT_BACKEND === "native-monthly" &&
    environment.CHECKPOINT_FORMAT === "legacy" &&
    environment.ALLOW_CHECKPOINT_DOWNTIME === "1" &&
    /^[a-z0-9][a-z0-9-]{0,62}$/.test(environment.MONTHLY_INSTANCE_ID ?? ""), "export_capture_arguments_invalid");
  // Exclusive claim before launching the one capture. An ambiguous attempt is reconciled, not restarted.
  await writeJson(completion + ".intent", { schema: "yenhubs-monthly-capture-intent-v1", directory });
  let result;
  try { result = await run(join(root, "deployment/create-checkpoint.sh"), [directory], {
    cwd: root, env: environment, encoding: "utf8", maxBuffer: 1024 * 1024
  }); } catch { throw new Error("export_capture_failed_or_ambiguous"); }
  const expectedLine = `Native monthly pair published: ${directory} (writers resumed; export and isolated recovery NOT yet accepted)`;
  requireValue(result.stdout.split(/\r?\n/).includes(expectedLine), "export_capture_publication_absent");
  const point = await inspectPublishedMonthlyPoint(directory);
  requireValue(point.pair.instanceId === environment.MONTHLY_INSTANCE_ID &&
    point.pair.context === environment.EXPECTED_KUBE_CONTEXT &&
    point.pair.namespace.uid === environment.EXPECTED_NAMESPACE_UID &&
    point.source.volumes.media.pvcUid === environment.EXPECTED_RET_PVC_UID, "export_capture_binding_changed");
  const receipt = { schema: "yenhubs-monthly-capture-completion-v1", state: "native-command-complete-not-restore-accepted",
    directory, nativeExitCode: 0, instanceId: point.pair.instanceId, month: point.pair.month,
    operationId: point.pair.operationId, manifestSha256: point.manifestSha256, stdoutSha256: sha(result.stdout) };
  await writeJson(completion, receipt);
  return receipt;
}

export async function inspectPublishedMonthlyPoint(path, completionPath = null) {
  const directory = await privateDirectory(path);
  requireValue(JSON.stringify((await readdir(directory)).sort()) === JSON.stringify(bundleNames),
    "export_native_point_incomplete_or_extra");
  const [source, pair, contract, metadata, images] = await Promise.all([
    "monthly-source.json", "native-pair.json", "database-contract.json", "checkpoint-metadata.json", "deployment-images.json"
  ].map(name => readPrivateSource(join(directory, name), 16 * 1024 * 1024)));
  await validateMonthlyNativeManifest(directory, metadata.stamp);
  const sums = await readPrivateBytes(join(directory, "SHA256SUMS"), 65536);
  const manifestSha256 = sha(sums); sums.fill(0);
  if (completionPath) {
    const receipt = await readPrivateSource(completionPath);
    requireValue(receipt.schema === "yenhubs-monthly-capture-completion-v1" &&
      receipt.state === "native-command-complete-not-restore-accepted" && receipt.nativeExitCode === 0 &&
      receipt.directory === directory && receipt.manifestSha256 === manifestSha256 &&
      ["instanceId", "month", "operationId"].every(key => receipt[key] === pair[key]) &&
      /^[a-f0-9]{64}$/.test(receipt.stdoutSha256 ?? ""), "export_original_capture_exit_unproven");
  }
  return { directory, source, pair, contract, metadata, images, manifestSha256 };
}

/** Generated TEMPORARY objects only. Official DO import route: retained content ->
 * local VolumeSnapshot -> new CSI-provisioned PVC. API-created volumes are not used.
 */
export function buildSnapshotExportPlan(point, { maximumHours = 1, maximumTemporaryUSD = 1, databaseUser = "postgres" } = {}) {
  const { source, pair, images, manifestSha256 } = point;
  requireValue(/^[a-f0-9]{32}$/.test(pair?.operationId ?? "") && /^[a-f0-9]{64}$/.test(manifestSha256 ?? "") &&
    /^[a-z0-9][a-z0-9-]{0,62}$/.test(source?.context ?? "") && uuid.test(source.namespace?.uid ?? "") &&
    /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(databaseUser), "export_plan_binding_invalid");
  requireValue(source.postgres?.major === "12" && source.postgres.dataPath.startsWith("/var/lib/postgresql/data") &&
    !source.postgres.dataPath.split("/").some(part => part === ".." || part === "."), "export_postgres_layout_unsupported");
  const pg = images?.deployments?.filter(item => item.name === "pgsql");
  requireValue(pg?.length === 1 && pg[0].containers?.length === 1 &&
    /^docker\.io\/mozillareality\/postgres@sha256:[a-f0-9]{64}$/.test(pg[0].containers[0].image ?? ""),
    "export_captured_postgres_image_unpinned");
  requireValue(maximumHours === 1 && Number.isFinite(maximumTemporaryUSD) && maximumTemporaryUSD > 0 &&
    maximumTemporaryUSD <= 1, "export_temporary_budget_invalid");
  const gib = ["database", "media"].reduce((sum, role) => sum + pair.snapshots[role].minimumDiskGiB, 0);
  const estimatedTemporaryUSD = Math.ceil(gib * 0.10 / 730 * maximumHours * 10000) / 10000;
  requireValue(Number.isSafeInteger(gib) && gib > 0 && estimatedTemporaryUSD <= maximumTemporaryUSD,
    "export_temporary_budget_exceeded");
  const namespace = `yenhubs-export-${pair.operationId}`;
  requireValue(namespace !== source.namespace.name, "export_namespace_is_source");
  const labels = { "yenhubs.org/monthly-export": pair.operationId };
  const metadata = name => ({ name, namespace, labels,
    annotations: { "yenhubs.org/native-manifest-sha256": manifestSha256 } });
  const objects = [{ apiVersion: "v1", kind: "Namespace", metadata: {
    name: namespace, labels: { ...labels, "pod-security.kubernetes.io/enforce": "baseline" },
    annotations: { "yenhubs.org/native-manifest-sha256": manifestSha256 }
  } }, { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: metadata("no-network"),
    spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"], ingress: [], egress: [] } }];
  for (const role of ["database", "media"]) {
    const snapshot = pair.snapshots[role], contentName = `${namespace}-${role}`;
    requireValue(uuid.test(snapshot.id ?? ""), "export_csi_snapshot_handle_unsupported");
    objects.push({ apiVersion: "snapshot.storage.k8s.io/v1", kind: "VolumeSnapshotContent",
      metadata: { ...metadata(contentName), namespace: undefined }, spec: {
        deletionPolicy: "Retain", driver: "dobs.csi.digitalocean.com", source: { snapshotHandle: snapshot.id },
        volumeSnapshotRef: { name: role, namespace }
      } }, { apiVersion: "snapshot.storage.k8s.io/v1", kind: "VolumeSnapshot", metadata: metadata(role),
        spec: { source: { volumeSnapshotContentName: contentName } } });
  }
  for (const role of ["database", "media"]) objects.push({ apiVersion: "v1", kind: "PersistentVolumeClaim",
    metadata: metadata(role), spec: { storageClassName: "do-block-storage", accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: `${pair.snapshots[role].minimumDiskGiB}Gi` } },
      dataSource: { name: role, kind: "VolumeSnapshot", apiGroup: "snapshot.storage.k8s.io" } } });
  const image = pg[0].containers[0].image;
  const base = { image, imagePullPolicy: "IfNotPresent", securityContext: {
    allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] }
  }, resources: { requests: { cpu: "100m", memory: "256Mi" }, limits: { cpu: "500m", memory: "768Mi" } } };
  const socket = "/work/socket";
  const server = `set -eu; umask 077; data="$1"; test "$(cat "$data/PG_VERSION")" = 12; test ! -e "$data/standby.signal"; test ! -e "$data/recovery.signal"; mkdir -p ${socket}; printf 'local all all trust\n' > /work/clone-hba.conf; if test -f "$data/postmaster.pid"; then mv "$data/postmaster.pid" /work/captured-postmaster.pid; fi; exec postgres -D "$data" -c listen_addresses= -c unix_socket_directories=${socket} -c hba_file=/work/clone-hba.conf -c ssl=off -c archive_mode=off -c restore_command= -c primary_conninfo= -c primary_slot_name= -c logging_collector=off -c external_pid_file= -c log_statement=none -c log_duration=off -c log_min_duration_statement=-1 -c log_min_error_statement=panic`;
  objects.push({ apiVersion: "v1", kind: "Pod", metadata: metadata("export"), spec: {
    restartPolicy: "Never", activeDeadlineSeconds: 3600, automountServiceAccountToken: false,
    enableServiceLinks: false, terminationGracePeriodSeconds: 30,
    securityContext: { fsGroup: 999, seccompProfile: { type: "RuntimeDefault" } },
    containers: [{ ...base, name: "database", securityContext: { ...base.securityContext, runAsUser: 999,
      runAsGroup: 999, runAsNonRoot: true }, command: ["sh", "-ec", server, "clone-server", source.postgres.dataPath],
      volumeMounts: [{ name: "database", mountPath: "/var/lib/postgresql/data" }, { name: "work", mountPath: "/work" }],
      readinessProbe: { exec: { command: ["pg_isready", "-h", socket, "-U", databaseUser, "-d", "retdb"] },
        periodSeconds: 2, timeoutSeconds: 1, failureThreshold: 30 }
    }, { ...base, name: "export", command: ["sh", "-ec", "exec sleep 3600"],
      securityContext: { ...base.securityContext, runAsUser: 0, capabilities: { drop: ["ALL"], add: ["DAC_OVERRIDE"] } },
      volumeMounts: [{ name: "media", mountPath: "/media", readOnly: true }, { name: "work", mountPath: "/work" }],
      resources: { requests: { cpu: "50m", memory: "128Mi", "ephemeral-storage": `${gib + 1}Gi` },
        limits: { cpu: "500m", memory: "512Mi", "ephemeral-storage": `${gib + 1}Gi` } }
    }], volumes: [{ name: "database", persistentVolumeClaim: { claimName: "database" } },
      { name: "media", persistentVolumeClaim: { claimName: "media", readOnly: true } },
      { name: "work", emptyDir: { sizeLimit: `${gib + 1}Gi` } }]
  } });
  return { schema: "yenhubs-monthly-snapshot-export-plan-v1", state: "prepared-not-executed",
    context: source.context, sourceNamespace: source.namespace, namespace, binding: {
      instanceId: pair.instanceId, month: pair.month, operationId: pair.operationId
    }, manifestSha256, image, databaseUser, estimatedTemporaryUSD, maximumTemporaryUSD,
    maximumSeconds: 3600, objects, originalVolumeIds: [source.volumes.database.volumeId, source.volumes.media.volumeId] };
}

export function requireClonePVCBinding(pvc, pv, plan, role) {
  requireValue(["database", "media"].includes(role) && pvc?.metadata?.namespace === plan.namespace &&
    pvc.metadata.name === role && uuid.test(pvc.metadata.uid ?? "") && pvc.status?.phase === "Bound" &&
    pvc.spec.storageClassName === "do-block-storage" && pvc.spec.dataSource?.name === role &&
    pvc.spec.dataSource.kind === "VolumeSnapshot" && pvc.spec.dataSource.apiGroup === "snapshot.storage.k8s.io" &&
    pv?.metadata?.name === pvc.spec.volumeName && uuid.test(pv.metadata.uid ?? "") && pv.status?.phase === "Bound" &&
    pv.spec.claimRef?.uid === pvc.metadata.uid && pv.spec.claimRef.namespace === plan.namespace &&
    pv.spec.claimRef.name === role && pv.spec.csi?.driver === "dobs.csi.digitalocean.com" &&
    uuid.test(pv.spec.csi.volumeHandle ?? "") && !plan.originalVolumeIds.includes(pv.spec.csi.volumeHandle) &&
    pv.spec.persistentVolumeReclaimPolicy === "Delete" && !pvc.metadata.deletionTimestamp && !pv.metadata.deletionTimestamp,
    "export_clone_pvc_binding_invalid");
  return { role, pvcUid: pvc.metadata.uid, pv: pv.metadata.name, pvUid: pv.metadata.uid, volumeId: pv.spec.csi.volumeHandle };
}

/** Execute the actual producer through its native adapter. Never self-accept restore/rotation. */
export async function exportMonthlySnapshotPoint({ checkpointDirectory, captureCompletionPath, outputDirectory,
  journalDirectory, recipient, provider, maximumTemporaryUSD = 1 }) {
  requireValue(typeof captureCompletionPath === "string" && typeof provider?.prepare === "function" &&
    typeof provider?.exportFiles === "function" && typeof provider?.cleanup === "function", "export_arguments_invalid");
  const point = await inspectPublishedMonthlyPoint(checkpointDirectory, captureCompletionPath);
  const plan = buildSnapshotExportPlan(point, { maximumTemporaryUSD });
  const destination = resolve(outputDirectory);
  const journalPath = resolve(journalDirectory);
  requireValue(/^age1[0-9a-z]{58}$/.test(recipient ?? ""), "export_recipient_invalid");
  await privateDirectory(dirname(destination));
  requireValue(!destination.startsWith(point.directory + "/") && destination !== point.directory &&
    !journalPath.startsWith(point.directory + "/") && journalPath !== point.directory,
    "export_output_inside_capture");
  const journal = await claimPairJournal(journalPath, plan.binding);
  let started = false, complete = false, cleanupAttempted = false, failure;
  try {
    await mkdir(destination, { mode: 0o700 });
    const plaintext = join(destination, "private-export"); await mkdir(plaintext, { mode: 0o700 });
    await journal.append({ event: "prepare-clones", manifestSha256: plan.manifestSha256,
      estimatedTemporaryUSD: plan.estimatedTemporaryUSD });
    started = true;
    await provider.prepare(plan, point, journal);
    const result = await provider.exportFiles(plan, point, plaintext, journal);
    requireValue(result.nativeExitCode === 0 && canonical(result.beforeContract) === canonical(point.contract) &&
      canonical(result.afterContract) === canonical(point.contract), "export_clone_database_contract_changed");
    const after = await inspectPublishedMonthlyPoint(point.directory, captureCompletionPath);
    requireValue(after.manifestSha256 === point.manifestSha256, "export_capture_bytes_changed");
    // Preserve ALL native evidence plus its fixed inner runtime/configuration archive.
    const runtime = join(plaintext, "runtime.tar.gz");
    const file = await open(runtime, "wx", 0o600);
    try { await provider.archiveNativeBundle(point.directory, bundleNames, file); await file.sync(); }
    finally { await file.close(); }
    requireValue((await inspectPublishedMonthlyPoint(point.directory, captureCompletionPath)).manifestSha256 ===
      point.manifestSha256, "export_capture_bytes_changed");
    const inputs = { database: join(plaintext, "database.dump"), media: join(plaintext, "media.tar.gz"), runtime };
    const receipt = await sealPortablePoint({ inputs, outputDirectory: join(destination, "sealed"), recipient,
      binding: { ...plan.binding, nativeManifestSha256: plan.manifestSha256,
        sourceSnapshots: point.pair.snapshots, postgresMajor: point.source.postgres.major } });
    cleanupAttempted = true; await provider.cleanup(plan, journal);
    complete = true;
    const evidence = { schema: "yenhubs-monthly-snapshot-export-v1", state: "sealed-not-restore-accepted",
      binding: plan.binding, nativeManifestSha256: plan.manifestSha256, nativeExportExitCode: 0,
      cloneCleanupVerified: true, packageDirectory: join(destination, "sealed"), ciphertexts: receipt.ciphertexts };
    await writeJson(join(destination, "export-result.json"), evidence);
    await journal.append({ event: "export-sealed", state: evidence.state });
    return evidence;
  } catch (error) {
    failure = /^export_[a-z_]+$/.test(error.message) ? error.message : "export_failed_or_ambiguous";
    if (started && !complete && !cleanupAttempted) {
      try { await provider.cleanup(plan, journal); }
      catch { try { await journal.append({ event: "cleanup-unproven", temporaryCostsMayContinue: true }); } catch {} }
    }
    try { await journal.append({ event: "incomplete", reason: failure }); } catch {}
    throw new Error(failure);
  } finally { await journal.close(); }
}

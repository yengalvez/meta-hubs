/** Native CSI export adapter. No apply, source-PVC mount, live DB or credential copy. */
import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeSnapshotProvider, validateNativeSnapshot } from "./monthly-snapshot-pair.mjs";
import { buildSnapshotExportPlan, requireClonePVCBinding } from "./monthly-snapshot-export.mjs";

const requireValue = (value, reason) => { if (!value) throw new Error(reason); };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const canonical = value => JSON.stringify(value, (_, item) => item && !Array.isArray(item) && typeof item === "object" ?
  Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

export async function runExportNative(program, args, { input = null, outputFile = null, timeout = 30000, env = process.env } = {}) {
  // No raw stderr or provider responses ever reach a terminal/error object.
  const child = spawn(program, args, { stdio: [input === null ? "ignore" : "pipe",
    outputFile ? outputFile.fd : "pipe", "pipe"], timeout, env });
  if (input !== null) { child.stdin.on("error", () => {}); child.stdin.end(input); }
  const chunks = []; let size = 0, tooLarge = false;
  child.stdout?.on("data", bytes => {
    size += bytes.length;
    if (size > 16 * 1024 * 1024) tooLarge = true;
    else if (!tooLarge) chunks.push(bytes);
  });
  child.stderr.resume();
  const exitCode = await new Promise((accept, reject) => {
    child.once("error", () => reject(new Error("export_native_command_failed_or_ambiguous")));
    child.once("close", (code, signal) => {
      if (signal || code !== 0 || tooLarge) reject(new Error("export_native_command_failed_or_ambiguous"));
      else accept(code);
    });
  });
  if (outputFile) await outputFile.sync();
  return { nativeExitCode: exitCode, stdout: outputFile ? "" : Buffer.concat(chunks).toString("utf8") };
}

function resourcePath(object) {
  const { name, namespace } = object.metadata;
  const resources = { Namespace: ["/api/v1", "namespaces"], Pod: ["/api/v1", "pods"],
    PersistentVolumeClaim: ["/api/v1", "persistentvolumeclaims"],
    NetworkPolicy: ["/apis/networking.k8s.io/v1", "networkpolicies"],
    VolumeSnapshot: ["/apis/snapshot.storage.k8s.io/v1", "volumesnapshots"],
    VolumeSnapshotContent: ["/apis/snapshot.storage.k8s.io/v1", "volumesnapshotcontents"] };
  requireValue(resources[object.kind], "export_resource_kind_invalid");
  const [prefix, plural] = resources[object.kind];
  const collection = prefix + (namespace ? `/namespaces/${namespace}` : "") + `/${plural}`;
  return { collection, exact: `${collection}/${name}` };
}

function subset(expected, actual) {
  if (expected === null || typeof expected !== "object") return expected === actual;
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length &&
    expected.every((value, i) => subset(value, actual[i]));
  return actual && Object.entries(expected).every(([key, value]) => value === undefined || subset(value, actual[key]));
}
function ownResource(desired, observed, uid = null, allowDeleting = false) {
  requireValue(observed && subset(desired, observed) && uuid.test(observed.metadata?.uid ?? "") &&
    typeof observed.metadata.resourceVersion === "string" && (!uid || observed.metadata.uid === uid) &&
    (allowDeleting || !observed.metadata.deletionTimestamp), "export_owned_resource_changed");
  if (desired.kind === "Pod") {
    requireValue(!observed.spec.hostNetwork && !observed.spec.hostPID && !observed.spec.hostIPC &&
      observed.spec.automountServiceAccountToken === false && observed.spec.containers.every(container =>
        !(container.env?.length || container.envFrom?.length)) && !(observed.spec.initContainers?.length),
      "export_pod_isolation_changed");
  }
  return observed;
}

export function nativeSnapshotExportProvider({ run = runExportNative, snapshots = nativeSnapshotProvider(),
  now = () => Date.now(), delay = sleep } = {}) {
  let active, end, namespaceUid, journal, sourceSnapshots, prepared = false, uncertainCreation = false;
  const owned = [], clones = {};
  const remaining = () => { const ms = end - now(); requireValue(ms > 0, "export_operation_deadline_exceeded"); return ms; };
  const bound = plan => requireValue(active && canonical(plan) === canonical(active), "export_provider_plan_changed");
  async function kube(plan, verb, path, input = null) {
    const args = ["--context", plan.context, "--request-timeout=30s", verb, "--raw", path];
    if (input !== null) args.push("-f", "-");
    const result = await run("kubectl", args, { input: input === null ? null : JSON.stringify(input),
      timeout: verb === "create" ? Math.min(30000, remaining()) : 30000 });
    requireValue(result.nativeExitCode === 0, "export_native_command_failed_or_ambiguous");
    try { return JSON.parse(result.stdout); } catch { throw new Error("export_native_json_invalid"); }
  }
  async function ownNamespace(plan) {
    const desired = plan.objects[0];
    ownResource(desired, await kube(plan, "get", resourcePath(desired).exact), namespaceUid);
  }
  async function readOwned(plan, object) {
    const entry = owned.find(item => item.desired.kind === object.kind && item.desired.metadata.name === object.metadata.name);
    requireValue(entry, "export_resource_identity_unrecorded");
    return ownResource(object, await kube(plan, "get", resourcePath(object).exact), entry.uid);
  }
  async function named(plan, object) {
    const path = resourcePath(object);
    const response = await kube(plan, "get", `${path.collection}?fieldSelector=${encodeURIComponent("metadata.name=" + object.metadata.name)}`);
    requireValue(Array.isArray(response.items) && response.items.length <= 1, "export_cleanup_identity_not_unique");
    return response.items[0];
  }
  async function waitFor(plan, object, predicate) {
    for (;;) {
      remaining(); await ownNamespace(plan);
      const value = await readOwned(plan, object);
      requireValue(!value.status?.error && !(value.status?.phase === "Failed"), "export_resource_failed");
      if (predicate(value)) return value;
      await delay(Math.min(2000, remaining()));
    }
  }
  async function requireClones(plan) {
    for (const role of ["database", "media"]) {
      const claim = plan.objects.find(o => o.kind === "PersistentVolumeClaim" && o.metadata.name === role);
      const pvc = await readOwned(plan, claim);
      const pv = await kube(plan, "get", `/api/v1/persistentvolumes/${pvc.spec.volumeName}`);
      requireValue(same(requireClonePVCBinding(pvc, pv, plan, role), clones[role]), "export_clone_identity_changed");
    }
  }
  async function requirePod(plan) {
    await ownNamespace(plan); await requireClones(plan);
    const desired = plan.objects.find(o => o.kind === "Pod");
    const pod = await readOwned(plan, desired);
    requireValue(pod.status?.phase === "Running" && pod.status.containerStatuses?.length === 2 &&
      pod.status.containerStatuses.every(c => c.restartCount === 0 && c.ready && c.state?.running &&
        c.imageID?.endsWith("@" + plan.image.split("@")[1])), "export_pod_not_ready_exact");
    return pod;
  }
  async function command(plan, args, options = {}) {
    await requirePod(plan);
    const result = await run("kubectl", ["--context", plan.context, "--request-timeout=0", "-n", plan.namespace,
      "exec", ...(options.input !== undefined ? ["-i"] : []), "export", "-c", "export", "--", ...args],
    { ...options, timeout: Math.min(options.timeout ?? 30000, remaining()) });
    requireValue(result.nativeExitCode === 0, "export_native_command_failed_or_ambiguous");
    await requirePod(plan);
    return result.stdout;
  }
  async function contract(plan, query) {
    const stdout = await command(plan, ["psql", "-h", "/work/socket", "-U", plan.databaseUser,
      "-d", "retdb", "-v", "ON_ERROR_STOP=1", "-At"], { input: query });
    try { return JSON.parse(stdout); } catch { throw new Error("export_clone_contract_invalid"); }
  }
  async function getFile(plan, name, directory) {
    const remote = `/work/${name}`;
    const before = await command(plan, ["sh", "-ec", 'test -f "$1" && test ! -L "$1"; sha256sum "$1"; stat -c %s "$1"', "readback", remote]);
    const lines = before.trim().split("\n");
    requireValue(lines.length === 2 && new RegExp(`^[a-f0-9]{64}  /work/${name.replaceAll(".", "\\.")}$`).test(lines[0]) &&
      /^[1-9][0-9]*$/.test(lines[1]), "export_remote_payload_digest_invalid");
    const expectedBytes = Number(lines[1]);
    requireValue(Number.isSafeInteger(expectedBytes) && expectedBytes <= 32 * 1024 ** 3, "export_remote_payload_size_invalid");
    const file = await open(join(directory, name), "wx+", 0o600);
    try {
      await command(plan, ["cat", remote], { outputFile: file, timeout: remaining() });
      const stat = await file.stat();
      requireValue(stat.size === expectedBytes, "export_payload_readback_size_changed");
      const hash = createHash("sha256");
      for await (const bytes of file.createReadStream({ start: 0, autoClose: false })) hash.update(bytes);
      requireValue(hash.digest("hex") === lines[0].slice(0, 64), "export_payload_readback_hash_changed");
      if (name === "database.dump") {
        const head = Buffer.alloc(5); await file.read(head, 0, head.length, 0);
        requireValue(head.toString() === "PGDMP", "export_database_not_custom_dump");
      }
    } finally { await file.close(); }
    requireValue((await command(plan, ["sh", "-ec", 'sha256sum "$1"; stat -c %s "$1"', "readback", remote])) === before,
      "export_remote_payload_changed");
  }
  return {
    async prepare(plan, point, events) {
      requireValue(!active && canonical(plan) === canonical(buildSnapshotExportPlan(point,
        { maximumTemporaryUSD: plan.maximumTemporaryUSD, databaseUser: plan.databaseUser })), "export_plan_not_generated_exact");
      active = structuredClone(plan); end = now() + plan.maximumSeconds * 1000; journal = events;
      sourceSnapshots = structuredClone(point.pair.snapshots);
      const sourceNamespace = await kube(plan, "get", `/api/v1/namespaces/${plan.sourceNamespace.name}`);
      requireValue(sourceNamespace.metadata?.uid === plan.sourceNamespace.uid && !sourceNamespace.metadata.deletionTimestamp,
        "export_source_namespace_changed");
      for (const role of ["database", "media"]) {
        const expected = point.pair.snapshots[role];
        const observed = validateNativeSnapshot(await snapshots.get(expected.id), { name: expected.name,
          volumeId: expected.volumeId, region: expected.region, since: Date.parse(point.pair.startedAt),
          until: Date.parse(point.pair.capturedAt) });
        requireValue(canonical(observed) === canonical({ ...expected, createdAt: new Date(expected.createdAt).toISOString() }),
          "export_source_snapshot_changed");
      }
      for (const object of plan.objects) {
        remaining(); if (namespaceUid) await ownNamespace(plan);
        if (object.kind === "PersistentVolumeClaim") {
          const snapshot = plan.objects.find(o => o.kind === "VolumeSnapshot" && o.metadata.name === object.metadata.name);
          const content = plan.objects.find(o => o.kind === "VolumeSnapshotContent" &&
            o.metadata.name === snapshot.spec.source.volumeSnapshotContentName);
          await readOwned(plan, content);
          await waitFor(plan, snapshot, v => v.status?.readyToUse === true &&
            v.status.boundVolumeSnapshotContentName === snapshot.spec.source.volumeSnapshotContentName);
        }
        if (object.kind === "Pod") {
          for (const role of ["database", "media"]) {
            const claim = plan.objects.find(o => o.kind === "PersistentVolumeClaim" && o.metadata.name === role);
            const pvc = await waitFor(plan, claim, v => v.status?.phase === "Bound");
            const pv = await kube(plan, "get", `/api/v1/persistentvolumes/${pvc.spec.volumeName}`);
            clones[role] = requireClonePVCBinding(pvc, pv, plan, role);
          }
          requireValue(clones.database.volumeId !== clones.media.volumeId, "export_clone_volumes_not_distinct");
        }
        const path = resourcePath(object);
        await journal.append({ event: "create-intent", kind: object.kind, path: path.exact });
        uncertainCreation = true;
        const created = ownResource(object, await kube(plan, "create", path.collection, object));
        owned.push({ desired: structuredClone(object), uid: created.metadata.uid });
        uncertainCreation = false;
        if (object.kind === "Namespace") namespaceUid = created.metadata.uid;
        await journal.append({ event: "create-returned", kind: object.kind, path: path.exact, uid: created.metadata.uid });
      }
      const pod = plan.objects.find(o => o.kind === "Pod");
      await waitFor(plan, pod, v => v.status?.phase === "Running" && v.status.containerStatuses?.every(c => c.ready));
      await requirePod(plan); prepared = true;
    },
    async exportFiles(plan, point, directory, events) {
      bound(plan); requireValue(prepared, "export_clones_not_prepared");
      const query = (await run("bash", ["-c", 'source "$1"; recovery_database_contract_sql', "export-contract",
        fileURLToPath(new URL("./lib/recovery-safety.sh", import.meta.url))])).stdout;
      requireValue(query.length > 100 && query.length < 65536, "export_contract_query_unavailable");
      const beforeContract = await contract(plan, query);
      requireValue(canonical(beforeContract) === canonical(point.contract), "export_clone_database_contract_changed");
      await events.append({ event: "clone-export-intent", files: ["database.dump", "media.tar.gz"] });
      await command(plan, ["sh", "-ec", 'set -eu; umask 077; test ! -e /work/database.dump; test ! -e /work/media.tar.gz; pg_dump -h /work/socket -U "$1" --format=custom --file=/work/database.dump retdb; pg_restore --list /work/database.dump >/dev/null; tar --create --gzip --file=/work/media.tar.gz --directory=/media .',
        "clone-export", plan.databaseUser], { timeout: remaining() });
      for (const name of ["database.dump", "media.tar.gz"]) await getFile(plan, name, directory);
      const afterContract = await contract(plan, query);
      return { nativeExitCode: 0, beforeContract, afterContract };
    },
    async archiveNativeBundle(directory, names, outputFile) {
      await run("tar", ["-czf", "-", "-C", directory, ...names], { outputFile });
    },
    async cleanup(plan, events) {
      bound(plan);
      requireValue(!uncertainCreation, "export_cleanup_uncertain_resource_creation");
      const cleanupEnd = now() + 120000;
      // Never delete a source volume or snapshot. Retain contents preserve the two original snapshots.
      // Unknown POSTs have no returned UID: their intent is retained for read-only reconciliation.
      for (const entry of [...owned].reverse()) {
        await ownNamespace(plan);
        const observed = ownResource(entry.desired, await named(plan, entry.desired), entry.uid, true);
        if (entry.desired.kind === "VolumeSnapshot") {
          const content = plan.objects.find(o => o.kind === "VolumeSnapshotContent" &&
            o.metadata.name === entry.desired.spec.source.volumeSnapshotContentName);
          await readOwned(plan, content); // Retain MUST still be intact before deleting its local snapshot.
        }
        if (entry.desired.kind === "PersistentVolumeClaim" && observed.status?.phase === "Bound") {
          const pv = await kube(plan, "get", `/api/v1/persistentvolumes/${observed.spec.volumeName}`);
          const clone = requireClonePVCBinding(observed, pv, plan, entry.desired.metadata.name);
          requireValue(!clones[clone.role] || same(clone, clones[clone.role]), "export_clone_identity_changed");
          clones[clone.role] = clone;
        }
        const path = resourcePath(entry.desired).exact;
        await events.append({ event: "delete-owned-intent", kind: entry.desired.kind, path, uid: entry.uid });
        if (!observed.metadata.deletionTimestamp) await kube(plan, "delete", path,
          { apiVersion: "v1", kind: "DeleteOptions", propagationPolicy: "Foreground",
            preconditions: { uid: entry.uid, resourceVersion: observed.metadata.resourceVersion } });
        for (;;) {
          const current = await named(plan, entry.desired);
          if (!current) break;
          ownResource(entry.desired, current, entry.uid, true);
          requireValue(now() < cleanupEnd, "export_cleanup_resources_still_present");
          await delay(2000);
        }
        owned.splice(owned.indexOf(entry), 1);
      }
      // A controller may still be detaching/deleting a clone; absence of local objects is insufficient.
      for (const clone of Object.values(clones)) for (;;) {
        const response = await kube(plan, "get", `/api/v1/persistentvolumes?fieldSelector=${encodeURIComponent("metadata.name=" + clone.pv)}`);
        requireValue(Array.isArray(response.items) && response.items.length <= 1, "export_cleanup_identity_not_unique");
        if (!response.items.length) break;
        requireValue(response.items[0].metadata?.uid === clone.pvUid &&
          response.items[0].spec?.csi?.volumeHandle === clone.volumeId, "export_cleanup_clone_identity_changed");
        requireValue(now() < cleanupEnd, "export_cleanup_resources_still_present"); await delay(2000);
      }
      for (;;) {
        const result = await run("doctl", ["compute", "volume", "list", "--output", "json", "--http-retry-max", "0"]);
        requireValue(result.nativeExitCode === 0, "export_cleanup_volume_read_invalid");
        let volumes; try { volumes = JSON.parse(result.stdout); } catch { throw new Error("export_cleanup_volume_read_invalid"); }
        requireValue(Array.isArray(volumes), "export_cleanup_volume_read_invalid");
        if (Object.values(clones).every(clone => !volumes.some(v => v.id === clone.volumeId))) break;
        requireValue(now() < cleanupEnd, "export_cleanup_volumes_still_present"); await delay(2000);
      }
      for (const expected of Object.values(sourceSnapshots)) {
        const value = await snapshots.get(expected.id);
        requireValue(value.id === expected.id && value.resource_id === expected.volumeId && value.name === expected.name &&
          value.resource_type === "volume", "export_cleanup_original_snapshot_changed");
      }
      await events.append({ event: "clones-cleanup-verified", originalSnapshotsRetained: true });
    }
  };
}

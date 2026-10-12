/** Pause -> two native snapshots -> resume. No streaming or running guardian. */
import { mkdir, open, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import { captureMonthlyPair, nativeSnapshotProvider } from "./monthly-snapshot-pair.mjs";
import { civilMonth } from "./monthly-backup-retention.mjs";
import { writeMonthlyRuntimeArchive, minimalMonthlyArtifacts, validateMonthlyNativeManifest } from "./monthly-native-bundle.mjs";
import { createMinimalKubernetes } from "./monthly-minimal-kubernetes.mjs";
import { nativeVolumeSnapshotAPI } from "./monthly-snapshot-api.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const need = (ok, message) => { if (!ok) throw new Error(message); };
export async function writeMinimalJson(path, value) {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value) + "\n"); await file.sync(); }
  finally { await file.close(); }
}

export async function runMinimalSnapshot({ output, source, cluster, snapshots, runtimePaths,
  operationId = randomBytes(16).toString("hex"), now = () => Date.now(), signal = null }) {
  need(["yenhubs-monthly-source-v1", "yenhubs-monthly-selection-v1"].includes(source?.schema) && /^[a-f0-9]{32}$/.test(operationId),
    "monthly_minimal_arguments_invalid");
  const directory = resolve(output), month = civilMonth(now());
  await cluster.requirePrivateDirectory(dirname(directory));
  // Exclusive mkdir forbids another attempt or overwriting a partial.
  await mkdir(directory, { mode: 0o700 });
  await writeMinimalJson(join(directory, ".yenhubs-incomplete"), { operationId, month });
  const events = await open(join(directory, "attempt.jsonl"), "wx", 0o600);
  const record = async event => { await events.writeFile(JSON.stringify({ ...event, operationId, month }) + "\n"); await events.sync(); };
  const check = () => { if (signal?.aborted) throw new Error("monthly_minimal_interrupted"); cluster.checkDeadline(); };
  let saved, pair, contract, pauseStart, pauseEnd, acquired = false, armed = false, recovered = false, failure;
  try {
    await cluster.acquire(operationId); acquired = true;
    saved = await cluster.inventory(source);
    source = saved.source ?? source;
    await record({ event: "prepared", services: saved.services });
    await writeMonthlyRuntimeArchive({ output: join(directory, "runtime.tar.gz"), ...runtimePaths, journalRoot: dirname(directory) });
    const existing = await snapshots.list();
    need(Array.isArray(existing) && !existing.some(item => ["database", "media"].some(role =>
      item.name === `${source.instanceId}-${month}-${role}`)), "monthly_point_exists_reconcile_only");
    // Persist recovery state on the server BEFORE the first scale change.
    armed = true; await cluster.armRecovery(saved, operationId);
    pauseStart = now();
    await record({ event: "pause-intent" });
    check(); await cluster.pauseWriters(saved);
    contract = await cluster.databaseContract(source);
    check(); await cluster.stopDatabase(saved);
    await cluster.confirmPaused(saved);
    await record({ event: "paused" });
    check();
    pair = await captureMonthlyPair({ source, month, operationId, provider: snapshots,
      journal: { append: record }, now,
      // The engine's few stage boundaries check a simple paused state, not a
      // background publisher, heartbeat counter or historical guard contract.
      checkBoundary: async () => { check(); await cluster.assertPaused(saved); },
      flush: async () => {} }); // graceful shutdown and sync completed before capture
    pair.databaseContractSha256 = sha(JSON.stringify(contract));
    await cluster.confirmPaused(saved);
    check();
  } catch (error) {
    failure = error;
    await record({ event: "failed", reason: /^[a-z][a-z0-9_]+$/.test(error.message) ? error.message : "monthly_minimal_failed" }).catch(() => {});
  } finally {
    if (armed) {
      try {
        await cluster.resume(saved, operationId);
        await cluster.verifyResumed(saved);
        recovered = true; pauseEnd = now();
        await record({ event: "resumed" });
        await cluster.disarmRecovery(operationId);
      } catch (error) {
        failure = new AggregateError([...(failure ? [failure] : []), error], "monthly_minimal_recovery_unproven");
        await record({ event: "recovery-required", originalReason: failure.errors[0]?.message }).catch(() => {});
        // Keep the server-side recovery job and its exact saved state.
      }
    }
    if (acquired && (!armed || recovered)) {
      try { await cluster.release(operationId); }
      catch (error) { failure ??= error; }
    }
    await events.close();
  }
  if (failure) throw failure;
  need(pair && recovered && Number.isFinite(pauseEnd), "monthly_minimal_completion_unproven");
  const metadata = { schema_version: 5, runtime_generation: "minimal-snapshot-v1",
    operation_id: operationId, kube_context: source.context, namespace: source.namespace.name,
    namespace_uid: source.namespace.uid, ret_pvc_uid: source.volumes.media.pvcUid,
    stamp: new Date(pauseStart).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15),
    writer_quiescence: { required: true, started_at_utc: new Date(pauseStart).toISOString(),
      completed_at_utc: new Date(pauseEnd).toISOString() },
    recovery: { servicesResumed: true, deferredRecoveryDisarmed: true } };
  for (const [name, value] of Object.entries({ "monthly-source.json": source, "native-pair.json": pair,
    "database-contract.json": contract, "checkpoint-metadata.json": metadata,
    "deployment-images.json": { deployments: saved.images } })) await writeMinimalJson(join(directory, name), value);
  const sums = [];
  for (const name of minimalMonthlyArtifacts) {
    const bytes = await cluster.readPrivateBytes(join(directory, name), 64 * 1024 * 1024);
    try { sums.push(`${sha(bytes)}  ${name}`); } finally { bytes.fill(0); }
  }
  const hashes = await open(join(directory, "SHA256SUMS"), "wx", 0o600);
  try { await hashes.writeFile(sums.join("\n") + "\n"); await hashes.sync(); } finally { await hashes.close(); }
  await validateMonthlyNativeManifest(directory, metadata.stamp);
  await unlink(join(directory, ".yenhubs-incomplete"));
  return { directory, state: "captured-not-restore-accepted", operationId, month,
    pauseMilliseconds: pauseEnd - pauseStart };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const abort = new AbortController();
  const interrupt = () => abort.abort();
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  try {
    const env = process.env;
    need(process.argv.length === 3 && env.ALLOW_CHECKPOINT_DOWNTIME === "1" &&
      [env.VALUES_FILE,env.HCCE_MANIFEST_PATH,env.PROCESS_LOCAL_CUTOVER_KEY_PATH].every(path => typeof path === "string" && path.startsWith("/")),
      "monthly_minimal_cli_arguments_invalid");
    const cluster = createMinimalKubernetes({ env, root });
    const source = await cluster.source();
    const result = await runMinimalSnapshot({ output: process.argv[2], source, cluster,
      snapshots: nativeSnapshotProvider(undefined, {api: nativeVolumeSnapshotAPI()}), signal: abort.signal,
      runtimePaths: { valuesPath: env.VALUES_FILE, manifestPath: env.HCCE_MANIFEST_PATH,
        keyPath: env.PROCESS_LOCAL_CUTOVER_KEY_PATH } });
    console.log(`Native monthly pair published: ${result.directory} (writers resumed; export and isolated recovery NOT yet accepted)`);
  } catch (error) {
    console.error(/^monthly_[a-z0-9_]+$/.test(error.message) ? error.message : "monthly_minimal_failed");
    process.exitCode = 1;
  } finally { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); }
}

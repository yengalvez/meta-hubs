/** Native pair capture engine. Only a protected coordinator may supply its boundary/flush functions. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, open, lstat, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { civilMonth } from "./monthly-backup-retention.mjs";
import { bindPostgresLayout } from "./monthly-snapshot-source.mjs";

const execute = promisify(execFile);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const snapshotId = value => typeof value === "string" && (uuid.test(value) || /^[1-9][0-9]*$/.test(value));
function requireValue(condition, reason) { if (!condition) throw new Error(reason); }

export function validateNativeSnapshot(value, { name, volumeId, region, since, until }) {
  requireValue(value && snapshotId(value.id) && value.name === name &&
    value.resource_type === "volume" && value.resource_id === volumeId &&
    Array.isArray(value.regions) && value.regions.includes(region) &&
    Number.isSafeInteger(value.min_disk_size) && value.min_disk_size > 0 &&
    typeof value.size_gigabytes === "number" && Number.isFinite(value.size_gigabytes) && value.size_gigabytes >= 0,
    "monthly_snapshot_identity_mismatch");
  const created = Date.parse(value.created_at);
  // Native timestamps have second precision. This is not a guard/deadline allowance.
  requireValue(Number.isFinite(created) && created >= Math.floor(since / 1000) * 1000 &&
    created <= Math.floor(until / 1000) * 1000 + 999, "monthly_snapshot_time_mismatch");
  return { id: value.id, name: value.name, volumeId, region,
    createdAt: new Date(created).toISOString(), minimumDiskGiB: value.min_disk_size,
    billableGiB: value.size_gigabytes };
}

export function nativeSnapshotProvider(run = execute) {
  const createdIdentities = new Map();
  async function command(args, timeout = 30000) {
    let result;
    try { result = await run("doctl", [...args, "--output", "json", "--http-retry-max", "0"],
      { timeout, maxBuffer: 8 * 1024 * 1024 }); }
    catch { throw new Error("monthly_provider_command_failed_or_ambiguous"); }
    return result;
  }
  async function call(args, timeout) {
    const result = await command(args, timeout);
    let value;
    try { value = JSON.parse(result.stdout); } catch { throw new Error("monthly_provider_response_invalid"); }
    requireValue(Array.isArray(value), "monthly_provider_response_invalid");
    return value;
  }
  function requireIdentity(value, expected) {
    requireValue(value && snapshotId(value.id) && value.name === expected.name &&
      value.resource_type === "volume" && value.resource_id === expected.volumeId &&
      Array.isArray(value.tags) && value.tags.length === expected.tags.length &&
      expected.tags.every(tag => value.tags.includes(tag)), "monthly_snapshot_identity_mismatch");
  }
  const listArgs = ["compute", "snapshot", "list", "--resource", "volume"];
  return {
    list: () => call(listArgs),
    async create({ volumeId, name, operationId, instanceId, month }) {
      const expected = { volumeId, name,
        tags: ["yenhubs-monthly", instanceId, `month-${month}`, `operation-${operationId}`] };
      const deadline = performance.now() + 30000;
      // doctl 1.163.0 deliberately discards the successful POST response body,
      // even with --output json. A command error/timeout never permits readback.
      const result = await command(["compute", "volume", "snapshot", volumeId,
        "--snapshot-name", name, "--tag", expected.tags.join(",")]);
      requireValue(result.stdout === "", "monthly_provider_response_invalid");
      // One immediate read, no polling or second POST, inside the original 30s
      // budget. A missing/ambiguous point remains incomplete for reconciliation.
      const remaining = Math.floor(deadline - performance.now());
      requireValue(remaining > 0, "monthly_provider_command_failed_or_ambiguous");
      const values = await call(listArgs, remaining);
      requireValue(performance.now() <= deadline, "monthly_provider_command_failed_or_ambiguous");
      const matches = values.filter(value => value?.name === name);
      requireValue(matches.length === 1, "monthly_snapshot_identity_unresolved");
      requireIdentity(matches[0], expected);
      createdIdentities.set(matches[0].id, expected);
      return matches[0];
    },
    async get(id) {
      const values = await call(["compute", "snapshot", "get", id]);
      requireValue(values.length === 1, "monthly_provider_response_invalid");
      requireValue(values[0]?.id === id, "monthly_snapshot_identity_mismatch");
      // The coordinator's guarded GET must retain the identity/tags discovered
      // after POST, not merely the timestamp/region/size checked by the engine.
      if (createdIdentities.has(id)) requireIdentity(values[0], createdIdentities.get(id));
      return values[0];
    }
  };
}

export async function claimPairJournal(path, binding) {
  requireValue(binding && /^[a-z0-9][a-z0-9-]{0,62}$/.test(binding.instanceId ?? "") &&
    /^\d{4}-(0[1-9]|1[0-2])$/.test(binding.month ?? "") &&
    /^[a-f0-9]{32}$/.test(binding.operationId ?? ""), "monthly_journal_binding_invalid");
  const destination = resolve(path); const parent = dirname(destination);
  const stat = await lstat(parent);
  requireValue(await realpath(parent) === parent && stat.isDirectory() &&
    stat.uid === process.getuid() && !(stat.mode & 0o077), "monthly_journal_parent_not_private");
  // A reused path is a reconciliation boundary, never permission to retry POSTs.
  await mkdir(destination, { mode: 0o700 });
  const file = await open(resolve(destination, "events.jsonl"), "wx", 0o600);
  const directory = await open(destination, "r");
  let sequence = 0;
  const journal = {
    async append(event) {
      const line = JSON.stringify({ ...event, ...binding, sequence: ++sequence }) + "\n";
      requireValue(Buffer.byteLength(line) <= 65536, "monthly_journal_event_too_large");
      await file.writeFile(line); await file.sync(); await directory.sync();
    },
    async close() { await file.close(); await directory.close(); }
  };
  try {
    await journal.append({ event: "claimed", state: "incomplete" });
    const parentHandle = await open(parent, "r");
    try { await parentHandle.sync(); } finally { await parentHandle.close(); }
    return journal;
  } catch {
    await journal.close();
    throw new Error("monthly_journal_claim_failed");
  }
}

export async function captureMonthlyPair({ source, month, operationId, provider, journal,
  checkBoundary, flush, now = () => Date.now() }) {
  requireValue(source?.schema === "yenhubs-monthly-source-v1" &&
    source.state === "inventory-not-captured" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(source.instanceId ?? "") &&
    /^[a-f0-9]{32}$/.test(operationId ?? "") && month === civilMonth(now()) &&
    typeof checkBoundary === "function" && typeof flush === "function" &&
    typeof journal?.append === "function", "monthly_capture_arguments_invalid");
  bindPostgresLayout(source.postgres, source.volumes?.database?.mountPath);
  const roles = ["database", "media"];
  requireValue(roles.every(role => uuid.test(source.volumes?.[role]?.volumeId ?? "")) &&
    source.volumes.database.volumeId !== source.volumes.media.volumeId,
    "monthly_source_volumes_invalid");
  const names = Object.fromEntries(roles.map(role => [role, `${source.instanceId}-${month}-${role}`]));
  const snapshots = {}; let stage = "preflight";
  const startedAt = now();
  try {
    await checkBoundary(stage);
    const existing = await provider.list();
    requireValue(Array.isArray(existing), "monthly_provider_response_invalid");
    requireValue(!existing.some(item => Object.values(names).includes(item.name)), "monthly_point_exists_reconcile_only");
    stage = "flush";
    await checkBoundary(stage);
    await flush();
    await checkBoundary("after-flush");
    await journal.append({ event: "flushed", at: new Date(now()).toISOString() });
    for (const role of roles) {
      stage = `${role}-before-create`;
      await checkBoundary(stage);
      // Persist intent BEFORE the one and only native POST. Timeout/uncertain
      // response leaves this operation incomplete; no auto retry or deletion.
      await journal.append({ event: "create-intent", role, name: names[role], volumeId: source.volumes[role].volumeId });
      stage = `${role}-create`;
      const value = await provider.create({ volumeId: source.volumes[role].volumeId,
        name: names[role], operationId, instanceId: source.instanceId, month });
      const expected = { name: names[role], volumeId: source.volumes[role].volumeId,
        region: source.region, since: startedAt, until: now() };
      const snapshot = validateNativeSnapshot(value, expected);
      await journal.append({ event: "create-returned", role, snapshot });
      stage = `${role}-readback`;
      await checkBoundary(stage);
      const observed = validateNativeSnapshot(await provider.get(snapshot.id), { ...expected, until: now() });
      requireValue(JSON.stringify(observed) === JSON.stringify(snapshot), "monthly_snapshot_readback_changed");
      snapshots[role] = snapshot;
      await journal.append({ event: "readback-verified", role, snapshot });
    }
    requireValue(snapshots.database.id !== snapshots.media.id, "monthly_snapshot_ids_not_distinct");
    stage = "final-boundary";
    await checkBoundary(stage);
    requireValue(civilMonth(now()) === month, "monthly_capture_crossed_month");
    const result = { schema: "yenhubs-native-monthly-pair-v1", state: "captured-not-restore-accepted",
      instanceId: source.instanceId, month, operationId, namespace: source.namespace,
      context: source.context, region: source.region, snapshots,
      postgres: source.postgres, startedAt: new Date(startedAt).toISOString(),
      capturedAt: new Date(now()).toISOString(), durationMilliseconds: now() - startedAt,
      acceptance: { parentTerminalJoin: false, writersResumed: false, portableExport: false,
        isolatedDigitalOceanRestore: false, isolatedDriveRestore: false } };
    await journal.append({ event: "pair-captured", state: result.state });
    return result;
  } catch (error) {
    const reason = /^monthly_[a-z_]+$/.test(error.message) ? error.message : "monthly_boundary_or_capture_failed";
    // A second disk/journal error must not replace the first capture failure.
    try { await journal.append({ event: "incomplete", stage, reason, observedSnapshots: snapshots }); }
    catch { /* earlier fsynced intent still requires reconciliation, never retry */ }
    throw new Error(reason);
  }
}

// Deliberately no stand-alone mutating CLI: integration must provide the real
// protected pause/Lease/continuous-PGSQL guard and parent terminal acceptance.

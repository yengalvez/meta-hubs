import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, writeFile, readFile, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { validateMonthlyNativePair, writeMonthlyRuntimeArchive, inspectMonthlyRuntimeArchive,
  validateMonthlyNativeManifest, nativeMonthlyArtifacts } from "../../deployment/monthly-native-bundle.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture() {
  const source = { schema: "yenhubs-monthly-source-v1", state: "inventory-not-captured", context: "fixture",
    instanceId: "fixture-instance", region: "ams3", namespace: { name: "fixture", uid: id(1) },
    volumes: { database: { volumeId: id(2), pvcUid: id(3), pvUid: id(4), sizeGiB: 10, mountPath: "/var/lib/postgresql/data" },
      media: { volumeId: id(5), pvcUid: id(6), pvUid: id(7), sizeGiB: 10 } },
    postgres: { major: "12", dataPath: "/var/lib/postgresql/data", walPath: "/var/lib/postgresql/data/pg_wal",
      tablespaceEntries: 0, sameWalFilesystem: true, fsync: "on", fullPageWrites: "on", syncAvailable: true } };
  const contract = { schema_version: 2, sql_dump_sha256: null, fixtureNotProduction: true };
  const pair = { schema: "yenhubs-native-monthly-pair-v1", state: "captured-not-restore-accepted",
    instanceId: source.instanceId, context: source.context, region: source.region, namespace: source.namespace,
    operationId: "a".repeat(32), month: "2026-10", postgres: source.postgres, startedAt: "2026-10-06T12:00:01.500Z",
    capturedAt: "2026-10-06T12:00:03.100Z", durationMilliseconds: 1600, databaseContractSha256: sha(JSON.stringify(contract)),
    acceptance: { parentTerminalJoin: false, writersResumed: false, portableExport: false,
      isolatedDigitalOceanRestore: false, isolatedDriveRestore: false }, snapshots: {} };
  for (const [index, role] of ["database", "media"].entries()) {
    pair.snapshots[role] = { id: id(10 + index), name: `fixture-instance-2026-10-${role}`, volumeId: source.volumes[role].volumeId,
      region: "ams3", minimumDiskGiB: 10, billableGiB: 1, createdAt: "2026-10-06T12:00:02Z" };
  }
  const metadata = { schema_version: 3, runtime_generation: "durable-v2", operation_id: pair.operationId,
    kube_context: pair.context, namespace: pair.namespace.name, namespace_uid: pair.namespace.uid,
    ret_pvc_uid: source.volumes.media.pvcUid, stamp: "20261006-120000",
    writer_quiescence: { required: true, started_at_utc: "2026-10-06T12:00:00Z", completed_at_utc: "2026-10-06T12:00:04Z" } };
  return { source, contract, pair, metadata };
}
async function directory() { return realpath(await mkdtemp(join(tmpdir(), "yenhubs-monthly-bundle-fixture-"))); }
async function runtime(parent) {
  const paths = ["values", "manifest", "key"].map(name => join(parent, name));
  for (const [index, path] of paths.entries()) await writeFile(path, `public-fixture-${index}`, { mode: 0o600 });
  const output = join(parent, "runtime.tar.gz");
  await writeMonthlyRuntimeArchive({ output, valuesPath: paths[0], manifestPath: paths[1], keyPath: paths[2], journalRoot: parent });
  return { output, paths };
}

test("native pair is capture-only, bound to both disks, the DB contract and the protected parent window", () => {
  validateMonthlyNativePair(fixture());
});

test("partial, foreign, altered, SQL-labelled or already-accepted pairs fail closed", () => {
  const mutations = [f => { delete f.pair.snapshots.media; }, f => { f.pair.snapshots.media.volumeId = id(99); },
    f => { f.pair.snapshots.media.id = f.pair.snapshots.database.id; }, f => { f.pair.snapshots.media.minimumDiskGiB = 1; },
    f => { f.contract.fixtureNotProduction = false; }, f => { f.contract.sql_dump_sha256 = "b".repeat(64); },
    f => { f.pair.acceptance.writersResumed = true; }, f => { f.metadata.operation_id = "b".repeat(32); },
    f => { f.metadata.writer_quiescence.completed_at_utc = "2026-10-06T12:00:01Z"; },
    f => { f.pair.postgres = { ...f.pair.postgres, major: "14" }; },
    f => { f.pair.snapshots.media.createdAt = "2026-09-06T12:00:02Z"; }];
  for (const mutate of mutations) { const f = structuredClone(fixture()); mutate(f); assert.throws(() => validateMonthlyNativePair(f)); }
});

test("runtime custody archives exact pinned bytes with fixed regular filenames and mode600", async () => {
  const parent = await directory(), { output } = await runtime(parent);
  const bytes = await readFile(output), inventory = inspectMonthlyRuntimeArchive(bytes);
  assert.deepEqual(inventory.map(v => v.name), ["input-values.yaml", "hcce.yaml", "cutover.key"]);
  const listed = spawnSync("tar", ["-tzf", output], { encoding: "utf8", timeout: 5000 });
  assert.ifError(listed.error); assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout, "input-values.yaml\nhcce.yaml\ncutover.key\n");
  for (const [index, item] of inventory.entries()) {
    const actual = spawnSync("tar", ["-xOzf", output, item.name], { timeout: 5000 });
    assert.ifError(actual.error); assert.equal(actual.status, 0);
    assert.equal(actual.stdout.toString(), `public-fixture-${index}`);
    assert.equal(item.sha256, sha(actual.stdout));
  }
  const corrupt = Buffer.from(bytes); corrupt[corrupt.length - 8] ^= 1;
  assert.throws(() => inspectMonthlyRuntimeArchive(corrupt));
});

test("runtime custody never overwrites a destination or accepts linked/public source bytes", async () => {
  const parent = await directory(), { paths, output } = await runtime(parent);
  const args = { output, valuesPath: paths[0], manifestPath: paths[1], keyPath: paths[2], journalRoot: parent };
  await assert.rejects(writeMonthlyRuntimeArchive(args), { code: "EEXIST" });
  await chmod(paths[0], 0o644);
  await assert.rejects(writeMonthlyRuntimeArchive({ ...args, output: join(parent, "unsafe.tar.gz") }), /not_private/);
  await chmod(paths[0], 0o600); await symlink(paths[0], join(parent, "linked"));
  await assert.rejects(writeMonthlyRuntimeArchive({ ...args, output: join(parent, "linked.tar.gz"), valuesPath: join(parent, "linked") }), /not_private/);
});

test("physical bundle requires every closed-set hash, rejects SQL payloads and altered bytes", async () => {
  const parent = await directory(), { output } = await runtime(parent), f = fixture();
  const content = { "monthly-source.json": f.source, "native-pair.json": f.pair,
    "database-contract.json": f.contract, "checkpoint-metadata.json": f.metadata };
  const lines = [];
  for (const name of nativeMonthlyArtifacts) {
    if (name !== "runtime.tar.gz") await writeFile(join(parent, name), JSON.stringify(content[name] ?? {}), { mode: 0o600 });
    lines.push(`${sha(await readFile(join(parent, name)))}  ${name}`);
  }
  await writeFile(join(parent, "SHA256SUMS"), lines.join("\n") + "\n", { mode: 0o600 });
  assert.deepEqual(await validateMonthlyNativeManifest(parent, f.metadata.stamp), { state: "capture-only-not-restore-accepted", artifacts: 14 });
  await writeFile(output, "altered", { mode: 0o600 });
  await assert.rejects(validateMonthlyNativeManifest(parent, f.metadata.stamp), /checksum_changed/);
  await writeFile(join(parent, "SHA256SUMS"), lines.slice(1).join("\n") + "\n", { mode: 0o600 });
  await assert.rejects(validateMonthlyNativeManifest(parent, f.metadata.stamp), /checksum_set_invalid/);
  await writeFile(join(parent, "SHA256SUMS"), [...lines, `${"a".repeat(64)}  retdb.sql.gz`].join("\n"), { mode: 0o600 });
  await assert.rejects(validateMonthlyNativeManifest(parent, f.metadata.stamp), /checksum_set_invalid/);
});

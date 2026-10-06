import { test } from "node:test";
import assert from "node:assert/strict";
import { requireSupervisedBinding, protectedSourceBoundary, runProtectedPair } from "../../deployment/monthly-snapshot-worker.mjs";
import { mkdtemp, realpath, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { civilMonth } from "../../deployment/monthly-backup-retention.mjs";
import { validateMonthlyNativePair } from "../../deployment/monthly-native-bundle.mjs";

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture() {
  const source = { context: "fixture", namespace: { name: "fixture", uid: id(1) },
    volumes: { database: { pvc: "pgsql-pvc", pvcUid: id(2), pv: "pv-database", pvUid: id(3), volumeId: id(4),
      mountPath: "/var/lib/postgresql/data", consumer: { name: "pgsql-fixture", uid: id(5), node: "fixture-node" } },
    media: { pvc: "ret-pvc", pvcUid: id(6), pv: "pv-media", pvUid: id(7), volumeId: id(8) } },
    postgres: { major: "12", dataPath: "/var/lib/postgresql/data", walPath: "/var/lib/postgresql/data/pg_wal",
      tablespaceEntries: 0, sameWalFilesystem: true, fsync: "on", fullPageWrites: "on", syncAvailable: true } };
  const env = { YENHUBS_MONTHLY_GUARDED_COMMAND: "1", CHECKPOINT_RUNNER_GENERATION: "durable-v2",
    EXPECTED_KUBE_CONTEXT: source.context, NAMESPACE: source.namespace.name, RECOVERY_NAMESPACE_UID: id(1),
    RECOVERY_PVC_UID: id(6), MONTHLY_PGSQL_POD_UID: id(5), RECOVERY_OPERATION_ID: "a".repeat(32) };
  const data = {
    namespace: { metadata: { uid: id(1) } },
    pvc: { items: Object.values(source.volumes).map(v => ({ metadata: { name: v.pvc, uid: v.pvcUid, namespace: "fixture" },
      status: { phase: "Bound" }, spec: { volumeName: v.pv } })) },
    pv: { items: Object.values(source.volumes).map(v => ({ metadata: { name: v.pv, uid: v.pvUid }, status: { phase: "Bound" },
      spec: { claimRef: { name: v.pvc, uid: v.pvcUid, namespace: "fixture" }, csi: { driver: "dobs.csi.digitalocean.com", volumeHandle: v.volumeId } } })) },
    pod: { metadata: { uid: id(5) }, spec: { nodeName: "fixture-node" }, status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] } }
  };
  const run = async (program, args) => {
    assert.equal(program, "kubectl"); assert.equal(args[1], "fixture");
    const kind = args[args.indexOf("get") + 1]; return { stdout: JSON.stringify(data[kind]) };
  };
  return { source, env, data, run };
}

test("worker requires supervised durable context, namespace, media and exact PGSQL parent bindings", () => {
  const f = fixture(); requireSupervisedBinding(f.source, f.env.RECOVERY_OPERATION_ID, f.env);
  for (const key of Object.keys(f.env)) {
    assert.throws(() => requireSupervisedBinding(f.source, f.env.RECOVERY_OPERATION_ID, { ...f.env, [key]: "wrong" }),
      /monthly_protected_parent_binding_missing/);
  }
});

test("boundary accepts only the exact live volume and PGSQL identities", async () => {
  const f = fixture(); await protectedSourceBoundary(f.source, f.run)();
});

test("boundary rejects namespace, PVC, PV/driver/claim and PGSQL replacement", async () => {
  for (const mutate of [f => { f.data.namespace.metadata.uid = id(99); },
    f => { f.data.pvc.items[0].metadata.uid = id(99); },
    f => { f.data.pv.items[1].spec.csi.volumeHandle = id(99); },
    f => { f.data.pv.items[0].spec.csi.driver = "other.example"; },
    f => { f.data.pod.metadata.uid = id(99); },
    f => { f.data.pod.status.conditions[0].status = "False"; }]) {
    const f = fixture(); mutate(f); await assert.rejects(protectedSourceBoundary(f.source, f.run)());
  }
});

test("boundary never substitutes an empty or failed observation for health", async () => {
  const f = fixture();
  await assert.rejects(protectedSourceBoundary(f.source, async () => { throw new Error("read_failed"); })(), /monthly_boundary_read_failed/);
  await assert.rejects(protectedSourceBoundary(f.source, async () => ({ stdout: "" }))(), /monthly_boundary_response_invalid/);
});

test("fixed worker binds private inputs, flushes once, journals two simulated POSTs and yields a capture-only bundle", async () => {
  const f = fixture(), calls = [], snapshots = new Map();
  Object.assign(f.source, { schema: "yenhubs-monthly-source-v1", state: "inventory-not-captured", instanceId: "fixture", region: "ams3" });
  Object.assign(f.source.volumes.database, { container: "pgsql", sizeGiB: 10 });
  f.source.volumes.media.sizeGiB = 10;
  const parent = await realpath(await mkdtemp(join(tmpdir(), "yenhubs-monthly-worker-fixture-")));
  const sourcePath = join(parent, "source.json"), contractPath = join(parent, "contract.json"), journalPath = join(parent, "attempt");
  const contract = { schema_version: 2, sql_dump_sha256: null, fixture: "not-production" };
  await writeFile(sourcePath, JSON.stringify(f.source), { mode: 0o600 });
  await writeFile(contractPath, JSON.stringify(contract), { mode: 0o600 });
  const run = async (program, args, options) => {
    calls.push({ program, args });
    if (program === "kubectl") {
      if (args.includes("exec")) {
        assert.equal(args.at(-1), "sync"); assert.ok(args.includes(f.source.volumes.database.consumer.name));
        return { stdout: "" };
      }
      return f.run(program, args);
    }
    assert.equal(program, "doctl"); assert.equal(options.timeout, 30000);
    assert.deepEqual(args.slice(-2), ["--http-retry-max", "0"]);
    if (args[2] === "list") return { stdout: "[]" };
    if (args[1] === "volume" && args[2] === "snapshot") {
      const value = { id: id(20 + snapshots.size), resource_type: "volume", resource_id: args[3],
        name: args[args.indexOf("--snapshot-name") + 1], regions: ["ams3"], min_disk_size: 10,
        size_gigabytes: 1, created_at: new Date().toISOString() };
      snapshots.set(value.id, value); return { stdout: JSON.stringify([value]) };
    }
    assert.equal(args[2], "get"); return { stdout: JSON.stringify([snapshots.get(args[3])]) };
  };
  const pair = await runProtectedPair({ sourcePath, contractPath, journalPath, month: civilMonth(Date.now()),
    operationId: f.env.RECOVERY_OPERATION_ID, env: f.env, run });
  validateMonthlyNativePair({ source: f.source, pair, contract });
  assert.equal(pair.databaseContractSha256, createHash("sha256").update(JSON.stringify(contract)).digest("hex"));
  assert.equal(calls.filter(v => v.program === "kubectl" && v.args.includes("exec")).length, 1);
  assert.equal(calls.filter(v => v.program === "doctl" && v.args[1] === "volume").length, 2);
  const events = (await readFile(join(journalPath, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.map(v => v.event), ["claimed", "flushed", "create-intent", "create-returned", "readback-verified",
    "create-intent", "create-returned", "readback-verified", "pair-captured"]);
  assert.equal(pair.acceptance.writersResumed, false); assert.equal(pair.acceptance.isolatedDriveRestore, false);
});

// Exercise the real CLI/execFile boundary with fake provider executables. The
// fixture PATH resolves both names here; no production API/client is invoked.
async function runWorkerCliFixture(mode) {
  const f = fixture();
  Object.assign(f.source, { schema: "yenhubs-monthly-source-v1", state: "inventory-not-captured", instanceId: "fixture", region: "ams3" });
  Object.assign(f.source.volumes.database, { container: "pgsql", sizeGiB: 10 });
  f.source.volumes.media.sizeGiB = 10;
  const parent = await realpath(await mkdtemp(join(tmpdir(), "yenhubs-monthly-worker-cli-fixture-")));
  const sourcePath = join(parent, "source.json"), contractPath = join(parent, "contract.json"), journalPath = join(parent, "attempt");
  const fixturePath = join(parent, "api-fixture.json"), callPath = join(parent, "calls.jsonl");
  const contract = { schema_version: 2, sql_dump_sha256: null, fixture: "not-production" };
  await writeFile(sourcePath, JSON.stringify(f.source), { mode: 0o600 });
  await writeFile(contractPath, JSON.stringify(contract), { mode: 0o600 });
  await writeFile(fixturePath, JSON.stringify({ source: f.source, data: f.data, mode }), { mode: 0o600 });
  const stub = `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const fixture = JSON.parse(fs.readFileSync(process.env.MONTHLY_CLI_FIXTURE, "utf8"));
const program = path.basename(__filename), args = process.argv.slice(2);
fs.appendFileSync(process.env.MONTHLY_CLI_CALLS, JSON.stringify({ program, args }) + "\\n", { mode: 0o600 });
if (program === "kubectl") {
  if (!args.includes("exec")) {
    const kind = args[args.indexOf("get") + 1];
    if (!fixture.data[kind]) process.exit(31);
    process.stdout.write(JSON.stringify(fixture.data[kind]));
  } else if (args.at(-1) !== "sync") process.exit(32);
} else if (program === "doctl") {
  if (args[1] === "snapshot" && args[2] === "list") process.stdout.write("[]");
  else if (args[1] === "volume" && args[2] === "snapshot") {
    const role = args[3] === fixture.source.volumes.database.volumeId ? "database" : "media";
    if (role === "media" && fixture.mode === "fail-media") process.exit(33);
    const result = { id: role === "database" ? "101" : "102", resource_type: "volume", resource_id: args[3],
      name: args[args.indexOf("--snapshot-name") + 1], regions: ["ams3"], min_disk_size: 10,
      size_gigabytes: 1, created_at: new Date().toISOString() };
    fs.writeFileSync(path.join(path.dirname(process.env.MONTHLY_CLI_FIXTURE), result.id + ".json"), JSON.stringify(result), { mode: 0o600 });
    process.stdout.write(JSON.stringify([result]));
  } else if (args[1] === "snapshot" && args[2] === "get") {
    process.stdout.write("[" + fs.readFileSync(path.join(path.dirname(process.env.MONTHLY_CLI_FIXTURE), args[3] + ".json"), "utf8") + "]");
  } else process.exit(34);
} else process.exit(35);
`;
  for (const program of ["kubectl", "doctl"]) await writeFile(join(parent, program), stub, { mode: 0o700 });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../deployment/monthly-snapshot-worker.mjs", import.meta.url)),
    sourcePath, journalPath, civilMonth(Date.now()), f.env.RECOVERY_OPERATION_ID, contractPath], {
    // No production environment, provider configuration or credential path.
    env: { ...f.env, PATH: parent, MONTHLY_CLI_FIXTURE: fixturePath, MONTHLY_CLI_CALLS: callPath },
    encoding: "utf8", timeout: 20000, maxBuffer: 1048576
  });
  assert.ifError(result.error);
  const calls = (await readFile(callPath, "utf8")).trim().split("\n").map(JSON.parse);
  const events = (await readFile(join(journalPath, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  return { result, calls, events, f, contract };
}

test("native worker CLI captures and validates two points using only fixture executables", async () => {
  const { result, calls, events, f, contract } = await runWorkerCliFixture("stable");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const pair = JSON.parse(result.stdout);
  validateMonthlyNativePair({ source: f.source, pair, contract });
  assert.equal(calls.filter(v => v.program === "doctl" && v.args[1] === "volume").length, 2);
  assert.equal(calls.filter(v => v.program === "kubectl" && v.args.includes("exec")).length, 1);
  assert.equal(events.at(-1).event, "pair-captured");
});

test("native worker CLI returns original failure without a complete pair or media retry", async () => {
  const { result, calls, events } = await runWorkerCliFixture("fail-media");
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), { status: "PAIR_NOT_ACCEPTED", reason: "monthly_provider_command_failed_or_ambiguous" });
  assert.equal(calls.filter(v => v.program === "doctl" && v.args[1] === "volume").length, 2);
  assert.equal(events.at(-1).event, "incomplete");
  assert.ok(!events.some(v => v.event === "pair-captured"));
  assert.equal(events.at(-1).observedSnapshots.database.id, "101");
});

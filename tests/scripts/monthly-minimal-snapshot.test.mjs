import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMinimalSnapshot } from "../../deployment/monthly-minimal-snapshot.mjs";
import { readPrivateBytes } from "../../deployment/monthly-snapshot-worker.mjs";
import { inspectPublishedMonthlyPoint, buildSnapshotExportPlan } from "../../deployment/monthly-snapshot-export.mjs";
import { minimalRecoveryObjects, deferredSnapshotResume } from "../../deployment/monthly-minimal-recovery.mjs";
import { runMonthlyServiceHealth } from "../../deployment/monthly-backup-runtime.mjs";
import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const operationId = "a".repeat(32), date = Date.parse("2026-10-12T12:00:00Z");
async function fixture(failAt = null) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "yenhubs-minimal-local-")));
  const runtimePaths = {};
  for (const key of ["valuesPath", "manifestPath", "keyPath"]) {
    runtimePaths[key] = join(directory, key); await writeFile(runtimePaths[key], "ONLY PUBLIC FIXTURE "+key, { mode: 0o600 });
  }
  const source = { schema: "yenhubs-monthly-source-v1", state: "inventory-not-captured", context: "fixture",
    instanceId: "fixture-instance", region: "ams3", namespace: { name: "fixture", uid: id(1) },
    volumes: { database: { volumeId: id(2), pvcUid: id(3), pvUid: id(4), sizeGiB: 10, mountPath: "/var/lib/postgresql/data" },
      media: { volumeId: id(5), pvcUid: id(6), pvUid: id(7), sizeGiB: 10 } },
    postgres: { major: "12", dataPath: "/var/lib/postgresql/data", walPath: "/var/lib/postgresql/data/pg_wal",
      tablespaceEntries: 0, sameWalFilesystem: true, fsync: "on", fullPageWrites: "on", syncAvailable: true } };
  const calls = [], values = [], control = { paused: false, armed: false, expired: false };
  const saved = { services: ["bot-orchestrator", "reticulum", "pgbouncer", "pgbouncer-t", "coturn", "pgsql"]
    .map((name, n) => ({ name, uid: id(n+30), replicas: name === "bot-orchestrator" ? 0 : 1 })),
    images: [{ name: "pgsql", containers: [{ name: "postgresql", image: "docker.io/mozillareality/postgres@sha256:"+"a".repeat(64) }] }] };
  const step = name => { calls.push(name); if (name === failAt) throw new Error("monthly_fixture_failure"); };
  const cluster = { readPrivateBytes, requirePrivateDirectory: async () => {},
    checkDeadline: () => { if (control.expired) throw new Error("monthly_minimal_pause_timeout"); },
    inventory: async () => { step("inventory"); return saved; },
    acquire: async () => step("acquire"), release: async () => step("release"),
    armRecovery: async () => { control.armed = true; step("arm"); },
    pauseWriters: async () => { control.paused = true; step("pause"); },
    databaseContract: async () => { step("contract"); return { schema_version: 2, sql_dump_sha256: null, publicFixture: true }; },
    stopDatabase: async () => step("stop-pg"),
    confirmPaused: async () => { step("paused"); assert.ok(control.paused); },
    assertPaused: async () => { step("boundary"); assert.ok(control.paused); },
    resume: async state => { assert.deepEqual(state, saved); step("resume"); control.paused = false; },
    verifyResumed: async () => { step("ready"); assert.equal(control.paused, false); },
    disarmRecovery: async () => { step("disarm"); control.armed = false; }
  };
  const snapshots = {
    list: async () => { step("list"); return values; },
    async create(args) {
      const role = args.volumeId === id(2) ? "database" : "media";
      assert.equal(control.paused, true); step("create-"+role);
      const value = { id: id(10+values.length), name: args.name, resource_type: "volume", resource_id: args.volumeId,
        regions: ["ams3"], min_disk_size: 10, size_gigabytes: 1, created_at: "2026-10-12T12:00:00Z" };
      values.push(value); return value;
    },
    get: async uid => { step("get"); return values.find(item => item.id === uid); }
  };
  const output = join(directory, "checkpoint");
  return { directory, calls, values, control, source, saved, cluster, snapshots, output,
    run: overrides => runMinimalSnapshot({ output, source, cluster, snapshots, runtimePaths, operationId, now: () => date, ...overrides }) };
}

test("minimal path creates both snapshots while paused, restores original counts, then publishes an exportable bundle", async () => {
  const f = await fixture(), result = await f.run();
  assert.equal(result.state, "captured-not-restore-accepted");
  assert.equal(f.control.paused, false); assert.equal(f.control.armed, false);
  assert.ok(f.calls.indexOf("arm") < f.calls.indexOf("pause"));
  assert.ok(f.calls.indexOf("stop-pg") < f.calls.indexOf("create-database"));
  assert.ok(f.calls.indexOf("create-media") < f.calls.indexOf("resume"));
  assert.equal(f.values.length, 2);
  assert.equal((await readdir(f.output)).includes(".yenhubs-incomplete"), false);
  const point = await inspectPublishedMonthlyPoint(f.output);
  assert.equal(point.metadata.runtime_generation, "minimal-snapshot-v1");
  assert.equal(point.artifacts.length, 8);
  assert.equal(buildSnapshotExportPlan(point).sourceNamespace.uid, f.source.namespace.uid);
  await assert.rejects(f.run(), { code: "EEXIST" });
  assert.equal(f.values.length, 2);
});

for (const stage of ["arm", "pause", "contract", "stop-pg", "create-database", "create-media", "get", "paused"]) {
  test(`failure in ${stage} restores services and leaves no accepted pair or second attempt`, async () => {
    const f = await fixture(stage);
    await assert.rejects(f.run());
    assert.equal(f.control.paused, false); assert.equal(f.control.armed, false);
    assert.equal(f.calls.filter(value => value === "resume").length, 1);
    assert.equal(f.calls.filter(value => value === "create-media").length <= 1, true);
    assert.equal((await readdir(f.output)).includes(".yenhubs-incomplete"), true);
    await assert.rejects(inspectPublishedMonthlyPoint(f.output));
  });
}

test("a provider timeout with a real first snapshot never repeats its POST or accepts the partial", async () => {
  const f = await fixture(), original = f.snapshots.create;
  f.snapshots.create = async args => { await original(args); throw new Error("monthly_provider_command_failed_or_ambiguous"); };
  await assert.rejects(f.run(), /monthly_provider_command_failed_or_ambiguous/);
  assert.equal(f.values.length, 1); assert.equal(f.calls.includes("create-media"), false);
  assert.equal(f.control.paused, false);
  await assert.rejects(f.run(), { code: "EEXIST" }); assert.equal(f.values.length, 1);
});

test("recovery failure preserves both errors and leaves the deferred recovery armed", async () => {
  const f = await fixture("create-media");
  f.cluster.resume = async () => { throw new Error("monthly_fixture_resume_failure"); };
  const error = await f.run().catch(error => error);
  assert.equal(error.message, "monthly_minimal_recovery_unproven");
  assert.deepEqual(error.errors.map(item => item.message), ["monthly_fixture_failure", "monthly_fixture_resume_failure"]);
  assert.equal(f.control.armed, true); assert.equal(f.calls.includes("release"), false);
});

test("ordinary pause deadline abandons the pair and resumes; no guardian cadence is involved", async () => {
  const f = await fixture(), original = f.snapshots.create;
  f.snapshots.create = async args => { const value = await original(args); f.control.expired = true; return value; };
  await assert.rejects(f.run(), /monthly_minimal_pause_timeout/);
  assert.equal(f.values.length, 1); assert.equal(f.control.paused, false);
});

test("interruption requests recovery after the current native call, without a second capture", async () => {
  const f = await fixture(), abort = new AbortController(), original = f.snapshots.create;
  f.snapshots.create = async args => { const value = await original(args); abort.abort(); return value; };
  await assert.rejects(f.run({ signal: abort.signal }), /monthly_minimal_interrupted/);
  assert.equal(f.values.length, 1); assert.equal(f.control.paused, false);
});

test("server recovery is a single finite Job with zero retry and exact named RBAC", () => {
  const state = { namespace: "hcce", name: "fixture-resume", operationId, services: [{ name: "pgsql" }, { name: "reticulum" }] };
  const objects = minimalRecoveryObjects(state, "ghcr.io/yengalvez/bot-orchestrator@sha256:"+"a".repeat(64));
  const job = objects.find(object => object.kind === "Job"), role = objects.find(object => object.kind === "Role");
  assert.equal(job.spec.backoffLimit, 0); assert.equal(job.spec.template.spec.restartPolicy, "Never");
  assert.ok(role.rules.every(rule => rule.resourceNames?.length && !rule.verbs.includes("create") && !rule.verbs.includes("delete")));
  assert.throws(() => minimalRecoveryObjects(state, "untrusted:latest"));
});

for (const scenario of ["executor-loss", "transient-maintenance", "foreign-service"]) test("deferred Job recovery: "+scenario, async () => {
  const state = { namespace: "hcce", name: "fixture-resume", operationId, leaseUid: id(90), stateUid: id(91),
    holder: "root-recovery:fixture", resumeAt: date+(scenario === "transient-maintenance" ? 100 : 0), services: [{ name: "reticulum", uid: id(31), replicas: 1 }, { name: "pgsql", uid: id(35), replicas: 1 }] };
  const objects = new Map(), calls = [];
  objects.set("configmaps", { metadata: { uid: state.stateUid, resourceVersion: "1" }, data: { phase: "armed" } });
  objects.set("leases", { metadata: { uid: state.leaseUid, resourceVersion: "1" }, spec: { holderIdentity: state.holder } });
  for (const service of state.services) objects.set(service.name, { metadata: { uid: service.uid, resourceVersion: "1", generation: 1 },
    spec: { replicas: 0 }, status: { observedGeneration: 1, readyReplicas: 0 } });
  if (scenario === "foreign-service") objects.get("reticulum").metadata.uid = id(999);
  let clock = date, maintenanceFailed = false;
  const https = { request(options, handler) {
    const req = new EventEmitter(); req.setTimeout = () => {}; req.destroy = () => {};
    req.end = body => queueMicrotask(() => {
      const key = options.path.includes("configmaps") ? "configmaps" : options.path.includes("leases") ? "leases" : options.path.split("/").at(-1);
      const value = objects.get(key); calls.push({ method: options.method, key });
      if (scenario === "transient-maintenance" && !maintenanceFailed && key === "configmaps" && options.method === "GET") {
        maintenanceFailed = true;
        const response = new EventEmitter(); response.statusCode = 500; handler(response); response.emit("end"); return;
      }
      if (body) {
        const patch = JSON.parse(body);
        if (Array.isArray(patch)) {
          assert.equal(patch[0].value, value.metadata.uid); value.spec.replicas = patch.at(-1).value; value.status.readyReplicas = value.spec.replicas;
        } else { if (patch.data) Object.assign(value.data, patch.data); if (patch.spec) Object.assign(value.spec, patch.spec); }
      }
      const response = new EventEmitter(); response.statusCode = 200; handler(response);
      response.emit("data", Buffer.from(JSON.stringify(value))); response.emit("end");
    }); return req;
  } };
  const promise = runInNewContext(`(${deferredSnapshotResume.toString()})()`, {
    require: name => name === "node:https" ? https : { readFileSync: () => "FICTIONAL" },
    process: { env: { RESUME_STATE: JSON.stringify(state), KUBERNETES_SERVICE_HOST: "local-fixture" } },
    Buffer, Date: class extends Date { static now() { return clock; } },
    setTimeout: fn => queueMicrotask(() => { clock = state.resumeAt; fn(); }),
  });
  if (scenario === "foreign-service") {
    await assert.rejects(promise, /recovery_incomplete/);
    assert.equal(objects.get("pgsql").spec.replicas, 1); assert.equal(objects.get("reticulum").spec.replicas, 0);
    assert.equal(objects.get("configmaps").data.phase, "recovery-incomplete"); return;
  }
  await promise;
  if (scenario === "transient-maintenance") assert.equal(maintenanceFailed, true);
  assert.equal(objects.get("pgsql").spec.replicas, 1); assert.equal(objects.get("reticulum").spec.replicas, 1);
  assert.equal(objects.get("configmaps").data.phase, "resumed"); assert.equal(objects.get("leases").spec.holderIdentity, null);
  const mutations = calls.filter(call => call.method === "PATCH" && ["pgsql", "reticulum"].includes(call.key));
  assert.deepEqual(mutations.map(call => call.key), ["pgsql", "reticulum"]);
});

test("monthly health uses ready deployments and room HTTP instead of the general live audit", async () => {
  const config = { context: "fixture", namespace: "hcce", namespaceUid: id(1) }, commands = [];
  const run = async (program, args) => {
    commands.push({ program, args }); return { nativeExitCode: 0, stdout: JSON.stringify(args.includes("namespace") ?
      { metadata: { uid: id(1) } } : { items: [{ metadata: { generation: 1 }, spec: { replicas: 1 }, status: { observedGeneration: 1, readyReplicas: 1 } }] }) };
  };
  const result = await runMonthlyServiceHealth(config, { run, request: async () => ({ status: 200 }) });
  assert.equal(result.state, "monthly-service-ready"); assert.equal(commands.length, 2);
  assert.ok(commands.every(command => command.program === "kubectl"));
  await assert.rejects(runMonthlyServiceHealth(config, { run, request: async () => ({ status: 503 }) }), /room_unavailable/);
});

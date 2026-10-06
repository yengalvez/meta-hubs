import { test } from "node:test";
import assert from "node:assert/strict";
import { bindMonthlySource, inspectMonthlySource, bindPostgresLayout, inspectPostgresLayout } from "../../deployment/monthly-snapshot-source.mjs";

const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture() {
  const namespace = { metadata: { name: "hcce", uid: uid(1) } };
  const names = ["pgsql-pvc", "ret-pvc"];
  return { context: "do-ams3-hubs-ce", instanceId: "yenhubs-main", region: "ams3", namespace,
    pvcs: names.map((name, i) => ({ metadata: { name, namespace: "hcce", uid: uid(i + 2) },
      spec: { volumeName: `pv-${i}` }, status: { phase: "Bound", capacity: { storage: "10Gi" } } })),
    pvs: names.map((name, i) => ({ metadata: { name: `pv-${i}`, uid: uid(i + 4) },
      status: { phase: "Bound" }, spec: { claimRef: { name, namespace: "hcce", uid: uid(i + 2) },
        csi: { driver: "dobs.csi.digitalocean.com", volumeHandle: uid(i + 6) } } })),
    pods: names.map((name, i) => ({ metadata: { name: `pod-${i}`, namespace: "hcce", uid: uid(i + 8) },
      status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
      spec: { nodeName: "fixture-node", volumes: [{ name: "data", persistentVolumeClaim: { claimName: name } }],
        containers: [{ name: i === 0 ? "pgsql" : "reticulum", volumeMounts: [{ name: "data", mountPath: i === 0 ? "/var/lib/postgresql/data" : "/storage" }] }] } })),
    volumes: [0, 1].map(i => ({ id: uid(i + 6), size_gigabytes: 10, region: { slug: "ams3" } })) };
}

test("binds both exact provider volumes without claiming pause, flush or capture", () => {
  const observed = bindMonthlySource(fixture());
  assert.equal(observed.state, "inventory-not-captured");
  assert.equal(observed.volumes.database.volumeId, uid(6));
  assert.equal(observed.volumes.media.volumeId, uid(7));
  assert.equal(observed.preparation.protectedPauseVerified, false);
  assert.equal(observed.preparation.postgresWalPlacementVerified, false);
});

test("rejects rebound PVC/PV identities", () => {
  const input = fixture(); input.pvs[0].spec.claimRef.uid = uid(99);
  assert.throws(() => bindMonthlySource(input), /source_pv_binding_invalid/);
});

test("rejects another cloud driver or missing native identity", () => {
  const input = fixture(); input.pvs[0].spec.csi.driver = "other.example";
  assert.throws(() => bindMonthlySource(input), /source_pv_binding_invalid/);
});

test("rejects provider region or capacity mismatches", () => {
  const input = fixture(); input.volumes[0].region.slug = "nyc3";
  assert.throws(() => bindMonthlySource(input), /source_provider_binding_invalid/);
  input.volumes[0].region.slug = "ams3"; input.volumes[0].size_gigabytes = 5;
  assert.throws(() => bindMonthlySource(input), /source_capacity_mismatch/);
});

test("rejects ambiguous consumers and unready pods", () => {
  const input = fixture(); input.pods.push(structuredClone(input.pods[0]));
  assert.throws(() => bindMonthlySource(input), /source_consumer_not_ready_unique/);
  input.pods.pop(); input.pods[0].status.conditions[0].status = "False";
  assert.throws(() => bindMonthlySource(input), /source_consumer_not_ready_unique/);
});

test("rejects unrecognized PGDATA/subPath and a multi-node flush assumption", () => {
  const input = fixture(); input.pods[0].spec.containers[0].volumeMounts[0].subPath = "part";
  assert.throws(() => bindMonthlySource(input), /source_database_mount_unrecognized/);
  delete input.pods[0].spec.containers[0].volumeMounts[0].subPath;
  input.pods[1].spec.nodeName = "other-node";
  assert.throws(() => bindMonthlySource(input), /source_common_flush_node_missing/);
});

test("rejects deleting objects and unknown provider volume", () => {
  const input = fixture(); input.pvcs[0].metadata.deletionTimestamp = "2026-10-06T00:00:00Z";
  assert.throws(() => bindMonthlySource(input), /source_pvc_invalid/);
  delete input.pvcs[0].metadata.deletionTimestamp; input.volumes[0].id = uid(99);
  assert.throws(() => bindMonthlySource(input), /source_identity_not_unique/);
});

function reader(input, requests, wrongProvider = false) {
  return async (program, args) => {
    requests.push({ program, args });
    if (program === "doctl") {
      assert.equal(args[3], input.volumes[requests.filter(r => r.program === "doctl").length - 1].id);
      assert.deepEqual(args.slice(4), ["--output", "json", "--http-retry-max", "0"]);
      return [wrongProvider ? input.volumes[0] : input.volumes.find(v => v.id === args[3])];
    }
    if (args.includes("namespace")) return input.namespace;
    if (args.includes("pvc")) return { items: input.pvcs };
    if (args.includes("pv")) return { items: input.pvs };
    if (args.includes("pods")) return { items: input.pods };
    throw new Error("unexpected_test_read");
  };
}

test("reads and binds each native volume with its own GET, never one multi-ID request", async () => {
  const input = fixture(); const requests = [];
  const result = await inspectMonthlySource({ context: input.context, instanceId: input.instanceId,
    namespace: "hcce", region: input.region }, reader(input, requests));
  assert.equal(result.volumes.database.volumeId, uid(6));
  assert.equal(result.volumes.media.volumeId, uid(7));
  assert.equal(requests.filter(r => r.program === "doctl").length, 2);
});

test("rejects a successful provider GET returning the other volume", async () => {
  const input = fixture(); const requests = [];
  await assert.rejects(inspectMonthlySource({ context: input.context, instanceId: input.instanceId,
    namespace: "hcce", region: input.region }, reader(input, requests, true)),
  /source_provider_response_invalid/);
});

const layout = () => ({ major: "12", dataPath: "/var/lib/postgresql/data/pgdata",
  walPath: "/var/lib/postgresql/data/pgdata/pg_wal", tablespaceEntries: 0,
  sameWalFilesystem: true, fsync: "on", fullPageWrites: "on", syncAvailable: true });

test("binds complete PGDATA/WAL without claiming an actual flush or restore", () => {
  const result = bindPostgresLayout(layout(), "/var/lib/postgresql/data");
  assert.equal(result.state, "layout-only-not-flushed");
  assert.equal(result.recoverWithMajor, "12");
});

test("rejects external WAL, tablespaces, another filesystem or unsafe durability", () => {
  for (const delta of [{ walPath: "/other/wal" }, { tablespaceEntries: 1 },
    { sameWalFilesystem: false }, { fsync: "off" }, { fullPageWrites: "off" }, { syncAvailable: false }]) {
    assert.throws(() => bindPostgresLayout({ ...layout(), ...delta }, "/var/lib/postgresql/data"),
      /source_postgres_snapshot_layout_unsafe/);
  }
  for (const dataPath of ["/elsewhere", "/var/lib/postgresql/database", "/var/lib/postgresql/data/../elsewhere"]) {
    assert.throws(() => bindPostgresLayout({ ...layout(), dataPath }, "/var/lib/postgresql/data"),
      /source_postgres_data_path_invalid/);
  }
});

test("rejects a PostgreSQL pod replaced during the read-only layout probe", async () => {
  const input = fixture(); const source = bindMonthlySource(input); let reads = 0;
  const read = async () => { const pod = structuredClone(input.pods[0]); if (++reads === 2) pod.metadata.uid = uid(99); return pod; };
  const run = async () => ({ stdout: "12\n/var/lib/postgresql/data/pgdata\n/var/lib/postgresql/data/pgdata/pg_wal\n0\nsame\non\non\nsync\n" });
  await assert.rejects(inspectPostgresLayout(source, read, run), /source_postgres_pod_changed/);
});

test("read-only layout probe is pinned to the container and fails closed on command errors", async () => {
  const input = fixture(); const source = bindMonthlySource(input);
  const read = async () => input.pods[0];
  await assert.rejects(inspectPostgresLayout(source, read, async (_program, args) => {
    assert.equal(args[args.indexOf("-c") + 1], "pgsql"); throw new Error("fixture_command_error");
  }), /source_postgres_layout_read_failed/);
});

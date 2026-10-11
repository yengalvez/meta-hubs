// Closed provider adapter for the monthly coordinator's local-only test. Every
// fallback goes to the existing fake kubectl/doctl, never to a real client.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const program = path.basename(process.argv[1]).replace(/-monthly$/, "");
const args = process.argv.slice(2).filter(a => a !== "--request-timeout=30s");
const state = process.env.STUB_STATE_DIR;
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const roles = { database: { pvc: "pgsql-pvc", pvcUid: id(2), pv: "pv-database", pvUid: id(3), volumeId: id(4) },
  media: { pvc: "ret-pvc", pvcUid: id(6), pv: "pv-media", pvUid: id(7), volumeId: id(8) } };
const emit = value => process.stdout.write(JSON.stringify(value));
function fakeFallback() {
  const result = spawnSync(path.join(path.dirname(process.argv[1]), program + "-legacy"), args,
    { stdio: "inherit", env: process.env });
  if (result.error || result.signal) process.exit(95);
  process.exit(result.status);
}
function requirePausedBoundary() {
  for (const writer of ["reticulum", "pgbouncer", "pgbouncer-t", "bot-orchestrator", "coturn"]) {
    if (fs.readFileSync(path.join(state, "replicas-" + writer), "utf8") !== "0") process.exit(96);
  }
  const lease = JSON.parse(fs.readFileSync(path.join(state, "serialization-lease.json"), "utf8"));
  if (!lease.spec.holderIdentity || !fs.existsSync(path.join(state, "restore-lock.yaml")) ||
      fs.readFileSync(path.join(state, "recovery-operation-fence-binding-state"), "utf8") !== "active") process.exit(97);
}
function record(event) {
  fs.appendFileSync(path.join(state, "monthly-provider-calls.jsonl"), JSON.stringify(event) + "\n", { mode: 0o600 });
}
function pod(role) {
  const volume = roles[role];
  return { apiVersion: "v1", kind: "Pod", metadata: { name: role === "database" ? "pgsql-0" : "reticulum-0",
    namespace: "hcce", uid: role === "database" ? id(5) : id(9) },
    spec: { nodeName: "fixture-node", volumes: [{ name: "durable", persistentVolumeClaim: { claimName: volume.pvc } }],
      containers: [{ name: role === "database" ? "pgsql" : "reticulum", volumeMounts: [{ name: "durable",
        mountPath: role === "database" ? "/var/lib/postgresql/data" : "/storage" }] }] },
    status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] } };
}
if (program === "kubectl") {
  // The snapshot source/worker use these exact direct forms. Ordinary protected
  // observations, watches, CAS mutations and resume stay in the original fake.
  // Protected WATCH/Lease requests must have been exec-dispatched by the shell
  // shim. It forwards only the new worker's exact 30s read/flush forms here.
  if (args.some(a => a.startsWith("--request-timeout="))) process.exit(98);
  if (args[0] !== "--context" || args[1] !== "fixture-context") process.exit(98);
  let command = args.slice(2);
  if (command[0] === "-n") {
    if (command[1] !== "hcce") process.exit(98);
    command = command.slice(2);
  }
  const joined = command.join(" ");
  if (joined === "get namespace hcce -o json") {
    emit(JSON.parse(fs.readFileSync(path.join(process.env.RUNNER_EVIDENCE_LIVE_DIR, "namespace-hcce.json"), "utf8")));
  } else if (joined === "get pvc pgsql-pvc ret-pvc -o json") {
    emit({ items: Object.values(roles).map(v => ({ apiVersion: "v1", kind: "PersistentVolumeClaim",
      metadata: { name: v.pvc, namespace: "hcce", uid: v.pvcUid }, spec: { volumeName: v.pv },
      status: { phase: "Bound", capacity: { storage: "10Gi" } } })) });
  } else if (joined === "get pv pv-database pv-media -o json") {
    emit({ items: Object.values(roles).map(v => ({ apiVersion: "v1", kind: "PersistentVolume",
      metadata: { name: v.pv, uid: v.pvUid }, status: { phase: "Bound" },
      spec: { claimRef: { name: v.pvc, namespace: "hcce", uid: v.pvcUid },
        csi: { driver: "dobs.csi.digitalocean.com", volumeHandle: v.volumeId } } })) });
  } else if (joined === "get pods -o json") emit({ items: [pod("database"), pod("media")] });
  else if (joined === "get pod pgsql-0 -o json") emit(pod("database"));
  else if (command.slice(0, 7).join(" ") === "exec pgsql-0 -c pgsql -- sh -ec" && command.length === 8) {
    if (command[7] === "sync") { requirePausedBoundary(); record({ event: "sync" }); }
    else if (command[7].includes("SHOW data_directory") && command[7].includes("SHOW full_page_writes")) {
      process.stdout.write("12\n/var/lib/postgresql/data\n/var/lib/postgresql/data/pg_wal\n0\nsame\non\non\nsync\n");
    } else process.exit(98);
  } else process.exit(98);
} else if (program === "doctl") {
  if (args[0] !== "compute") fakeFallback();
  if (args[1] === "volume" && args[2] === "get") {
    const volume = Object.values(roles).find(v => v.volumeId === args[3]);
    if (!volume) process.exit(98);
    emit([{ id: volume.volumeId, region: { slug: "ams3" }, size_gigabytes: 10 }]);
  } else if (args[1] === "snapshot" && args[2] === "list") {
    emit(fs.readdirSync(state).filter(name => /^monthly-snapshot-[1-9][0-9]*\.json$/.test(name)).sort()
      .map(name => JSON.parse(fs.readFileSync(path.join(state, name), "utf8"))));
  } else if (args[1] === "volume" && args[2] === "snapshot") {
    requirePausedBoundary();
    const role = Object.keys(roles).find(r => roles[r].volumeId === args[3]);
    if (!role || args.at(-2) !== "--http-retry-max" || args.at(-1) !== "0") process.exit(98);
    record({ event: "snapshot-post", role });
    if (role === "media" && process.env.MONTHLY_FIXTURE_CASE === "fail-media") process.exit(33);
    const snapshot = { id: role === "database" ? "101" : "102", resource_type: "volume", resource_id: args[3],
      name: args[args.indexOf("--snapshot-name") + 1], regions: ["ams3"], min_disk_size: 10,
      size_gigabytes: 1, created_at: new Date().toISOString(), tags: args[args.indexOf("--tag") + 1].split(",") };
    fs.writeFileSync(path.join(state, "monthly-snapshot-" + snapshot.id + ".json"), JSON.stringify(snapshot), { mode: 0o600 });
    // The real doctl RunVolumeSnapshot command emits nothing on native exit 0.
  } else if (args[1] === "snapshot" && args[2] === "get") {
    emit([JSON.parse(fs.readFileSync(path.join(state, "monthly-snapshot-" + args[3] + ".json"), "utf8"))]);
  } else fakeFallback();
} else process.exit(98);

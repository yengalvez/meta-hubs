// Finite LOCAL executable fixture: no network modules, no credential access.
const fs = require("node:fs"), path = require("node:path");
const statePath = process.env.MINIMAL_FIXTURE_STATE;
if (!statePath || !statePath.includes("yenhubs-minimal-native-")) throw Error("fixture root missing");
const lockPath = statePath+".lock", waitArray = new Int32Array(new SharedArrayBuffer(4)), until = Date.now()+5000;
for (;;) {
  try { fs.closeSync(fs.openSync(lockPath,"wx",0o600)); break; }
  catch (error) { if (error.code !== "EEXIST" || Date.now() >= until) throw error; Atomics.wait(waitArray,0,0,5); }
}
process.once("exit", () => fs.unlinkSync(lockPath));
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const args = process.argv.slice(2), tool = path.basename(process.argv[1]);
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const finish = (value, status = 0) => {
  const temporary = statePath+"."+process.pid;
  fs.writeFileSync(temporary, JSON.stringify(state)); fs.renameSync(temporary, statePath);
  if (value !== null) process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
  process.exit(status);
};
const after = key => args[args.indexOf(key)+1];
state.commands.push({ tool, args });
if (tool === "doctl") {
  if (args[1] === "volume" && args[2] === "get") return finish([{ id: args[3], region: { slug: "ams3" }, size_gigabytes: 10 }]);
  if (args[1] === "volume" && args[2] === "snapshot") {
    const role = args[3] === id(2) ? "database" : "media";
    state.posts.push(role);
    if (role === state.failRole) return finish(null, 17);
    state.snapshots.push({ id: id(100+state.snapshots.length), name: after("--snapshot-name"), resource_id: args[3],
      resource_type: "volume", regions: ["ams3"], min_disk_size: 10, size_gigabytes: 1,
      created_at: new Date().toISOString(), tags: after("--tag").split(",") });
    if (state.expireLease && role === "database") state.lease.spec.renewTime = new Date(Date.now()-121000).toISOString().replace(/(\.\d{3})Z$/, "$1000Z");
    if (state.ambiguousRole === role) return finish(null, 17);
    return finish(""); // installed doctl contract: successful POST emits no JSON
  }
  if (args[1] === "snapshot" && args[2] === "list") return finish(state.snapshots);
  if (args[1] === "snapshot" && args[2] === "get") return finish(state.snapshots.filter(value => value.id === args[3]));
  throw Error("unexpected doctl operation");
}
if (tool !== "kubectl") throw Error("unexpected fixture tool");
if (args.includes("exec")) {
  const stdin = args.includes("-i") ? fs.readFileSync(0, "utf8") : "";
  if (args.at(-1) === "sync") return finish("");
  if (stdin.includes("jsonb_build_object")) return finish(state.contract);
  return finish("12\n/var/lib/postgresql/data\n/var/lib/postgresql/data/pg_wal\n0\nsame\non\non\nsync\n");
}
if (args.includes("patch")) {
  const index = args.indexOf("patch"), kind = args[index+1], name = args[index+2], patch = JSON.parse(fs.readFileSync(0,"utf8"));
  if (kind === "deployment") {
    const deployment = state.deployments.find(value => value.metadata.name === name);
    if (patch[0].value !== deployment.metadata.uid || patch[1].value !== deployment.metadata.resourceVersion) return finish(null, 1);
    deployment.spec.replicas = patch.at(-1).value; deployment.metadata.generation++;
    deployment.metadata.resourceVersion = String(Number(deployment.metadata.resourceVersion)+1);
    deployment.status = { observedGeneration: deployment.metadata.generation, readyReplicas: deployment.spec.replicas };
    state.scales.push({ name, replicas: deployment.spec.replicas }); return finish(deployment);
  }
  const object = state.objects.find(value => value.kind.toLowerCase() === kind && value.metadata.name === name);
  if (!object) throw Error("patch object missing");
  if (patch.data) Object.assign(object.data,patch.data); return finish(object);
}
if (args.includes("create") || args.includes("replace")) {
  const object = JSON.parse(fs.readFileSync(0, "utf8"));
  if (object.kind === "Lease") {
    if (state.conflictOnResume && state.expireLease && state.snapshots.length === 1 && !state.resumeConflictSeen) {
      state.resumeConflictSeen = true;
      state.lease.spec.renewTime = new Date().toISOString().replace(/(\.\d{3})Z$/, "$1000Z");
      return finish(null,1); // another renewal wins this CAS; one read resolves it
    }
    object.metadata.uid = state.lease?.metadata.uid || id(90); object.metadata.resourceVersion = "1";
    state.lease = object; return finish(object);
  }
  const prior = state.objects.find(value => value.kind === object.kind && value.metadata.name === object.metadata.name);
  if (prior) return finish(null, 1);
  object.metadata.uid = id(200+state.objects.length); object.metadata.resourceVersion = "1";
  state.objects.push(object); return finish(object);
}
if (args.includes("delete")) {
  if (!args.includes("--raw")) throw Error("fixture requires UID-bound delete");
  const request = JSON.parse(fs.readFileSync(0, "utf8")), url = after("--raw"), name = url.split("/").at(-1);
  if (url.includes("/namespaces/hcce-bot-runners/pods/")) {
    const runner = state.runners?.find(value => value.metadata.name === name && value.metadata.uid === request.preconditions.uid);
    if (!runner || state.deployments.find(value => value.metadata.name === "bot-orchestrator").spec.replicas !== 0) return finish(null, 1);
    state.runners = state.runners.filter(value => value !== runner); return finish({ kind: "Status", status: "Success" });
  }
  const object = state.objects.find(value => value.metadata.name === name && value.metadata.uid === request.preconditions.uid);
  if (!object) return finish(null, 1);
  state.objects = state.objects.filter(value => value !== object); return finish({ kind: "Status", status: "Success" });
}
const index = args.indexOf("get"), resource = args[index+1], name = args[index+2];
const ns = args.includes("-n") ? after("-n") : "hcce";
if (resource === "namespace") return finish({ metadata: { name: "hcce", uid: id(1) } });
if (resource === "pvc") return finish({ items: [
  { metadata: { name: "pgsql-pvc", namespace: "hcce", uid: id(3) }, spec: { volumeName: "db-pv" }, status: { phase: "Bound", capacity: { storage: "10Gi" } } },
  { metadata: { name: "ret-pvc", namespace: "hcce", uid: id(6) }, spec: { volumeName: "media-pv" }, status: { phase: "Bound", capacity: { storage: "10Gi" } } }
] });
if (resource === "pv") return finish({ items: [
  { metadata: { name: "db-pv", uid: id(4) }, spec: { claimRef: { uid: id(3), name: "pgsql-pvc", namespace: "hcce" },
    csi: { driver: "dobs.csi.digitalocean.com", volumeHandle: id(2) } }, status: { phase: "Bound" } },
  { metadata: { name: "media-pv", uid: id(7) }, spec: { claimRef: { uid: id(6), name: "ret-pvc", namespace: "hcce" },
    csi: { driver: "dobs.csi.digitalocean.com", volumeHandle: id(5) } }, status: { phase: "Bound" } }
] });
function pods() {
  if (ns === "hcce-bot-runners") return state.runners || [];
  const result = state.deployments.filter(value => value.spec.replicas > 0).map(value => {
    const app = value.metadata.name, pg = app === "pgsql", ret = app === "reticulum";
    return { metadata: { name: app+"-fixture", namespace: "hcce", uid: id(pg ? 15 : ret ? 16 : 17), labels: { app } },
      spec: { nodeName: "fixture-node", volumes: pg || ret ? [{ name: "data", persistentVolumeClaim: { claimName: pg ? "pgsql-pvc" : "ret-pvc" } }] : [],
        containers: [{ name: pg ? "postgresql" : app, volumeMounts: pg || ret ? [{ name: "data", mountPath: pg ? "/var/lib/postgresql/data" : "/storage" }] : [] }] },
      status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] } };
  });
  for (const job of state.objects.filter(value => value.kind === "Job")) result.push({ metadata: { name: job.metadata.name+"-pod",
    namespace: "hcce", uid: id(95), labels: { "job-name": job.metadata.name } }, spec: { volumes: [] },
    status: { phase: "Running", containerStatuses: [{ ready: true, state: { running: {} } }] } });
  if (args.includes("-l")) return result.filter(value => value.metadata.labels["job-name"] === after("-l").slice("job-name=".length));
  return result;
}
if (resource === "pods") return finish({ items: pods() });
if (resource === "pod") return finish(pods().find(value => value.metadata.name === name));
if (resource === "deployments") return finish({ items: state.deployments });
if (resource === "deployment") return finish(state.deployments.find(value => value.metadata.name === name));
if (resource === "lease") return finish(state.lease || "");
if (resource === "hpa") return finish({ items: state.unsupportedHPA ? [{ spec: { scaleTargetRef: { name: "pgsql" } } }] : [] });
if (resource === "cronjobs" || resource === "jobs") return finish({ items: [] });
return finish(state.objects.find(value => value.kind.toLowerCase() === resource.toLowerCase() && value.metadata.name === name));

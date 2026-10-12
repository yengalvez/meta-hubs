import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, writeFile, readFile, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { inspectPublishedMonthlyPoint } from "../../deployment/monthly-snapshot-export.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function fixture(options = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "yenhubs-minimal-native-")));
  const bin = join(directory,"bin"); await mkdir(bin, { mode: 0o700 });
  const code = await readFile(join(root, "tests/scripts/fixtures/monthly-minimal-cli.cjs"), "utf8");
  const script = join(bin, "fixture.cjs"); await writeFile(script, `#!${process.execPath}\n`+code, { mode: 0o700 });
  for (const name of ["kubectl", "doctl", "curl"]) await symlink(script, join(bin, name));
  const credentials=join(directory,"Library/Application Support/doctl");await mkdir(credentials,{recursive:true,mode:0o700});
  await writeFile(join(credentials,"config.yaml"),JSON.stringify({context:"fixture","auth-contexts":{fixture:"PUBLIC-FIXTURE-DOCTL-TOKEN"}}),{mode:0o600});
  const statePath = join(directory, "state.json"), output = join(directory, "checkpoint");
  const names = ["bot-orchestrator", "reticulum", "pgbouncer", "pgbouncer-t", "coturn", "pgsql"];
  const state = { commands: [], posts: [], snapshots: [], scales: [], objects: [],
    contract: { schema_version: 2, sql_dump_sha256: null, ONLY_PUBLIC_FIXTURE: true }, ...options,
    deployments: names.map((name, n) => ({ metadata: { name, uid: id(30+n), namespace: "hcce", resourceVersion: "1", generation: 1 },
      spec: { replicas: name === "bot-orchestrator" ? (options.botReplicas ?? 0) : 1,
        template: { spec: { imagePullSecrets: [{ name: "bot-images-pull" }], containers: [{ name: name === "pgsql" ? "postgresql" : name,
          image: (name === "pgsql" ? "docker.io/mozillareality/postgres" : "ghcr.io/yengalvez/"+name)+"@sha256:"+"a".repeat(64) }] } } },
      status: { observedGeneration: 1, readyReplicas: name === "bot-orchestrator" ? (options.botReplicas ?? 0) : 1 } })) };
  await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
  const files = {};
  for (const name of ["values", "manifest", "key"]) { files[name] = join(directory, name); await writeFile(files[name], "ONLY PUBLIC FIXTURE", { mode: 0o600 }); }
  const env = { PATH: bin+delimiter+dirname(process.execPath)+delimiter+"/usr/bin:/bin", HOME: directory, TMPDIR: directory,
    MINIMAL_FIXTURE_STATE: statePath, EXPECTED_KUBE_CONTEXT: "do-ams3-hubs-ce", NAMESPACE: "hcce", MONTHLY_REGION: "ams3",
    MONTHLY_INSTANCE_ID: "fixture-instance", EXPECTED_NAMESPACE_UID: id(1), EXPECTED_RET_PVC_UID: id(6), EXPECTED_DB_PVC_UID: id(3),
    ALLOW_CHECKPOINT_DOWNTIME: "1", VALUES_FILE: files.values, HCCE_MANIFEST_PATH: files.manifest, PROCESS_LOCAL_CUTOVER_KEY_PATH: files.key };
  return { directory, output, statePath, async run() {
    const child = spawn("bash", [join(root,"deployment/create-monthly-snapshot.sh"), output], { env, stdio: ["ignore","pipe","pipe"] });
    const stdout = [], stderr = []; child.stdout.on("data", value => stdout.push(value)); child.stderr.on("data", value => stderr.push(value));
    const timer = setTimeout(() => child.kill("SIGTERM"), 30000);
    const native = await new Promise((accept, reject) => { child.once("error", reject); child.once("close", (code, signal) => accept({ code, signal })); });
    clearTimeout(timer);
    return { ...native, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), state: JSON.parse(await readFile(statePath,"utf8")) };
  } };
}

test("native monthly entrypoint executes the minimal route, resumes, publishes and never launches historical commands", { timeout: 30000 }, async () => {
  const f = await fixture({ staleCatalogue:true, botReplicas: 1, runners: [{ metadata: { name: "bot-runner-fixture", uid: id(500),
    labels: { app: "bot-runner", "yenhubs.org/managed-by": "bot-orchestrator" } }, status: { phase: "Running" } }] }), result = await f.run();
  assert.equal(result.code, 0, result.stderr); assert.equal(result.signal, null);
  assert.deepEqual(result.state.posts, ["database","media"]);
  assert.equal(result.state.objects.length, 0);
  assert.equal(result.state.lease.spec.holderIdentity, undefined);
  assert.ok(result.state.deployments.every(value => value.spec.replicas === 1));
  assert.equal(result.state.runners.length, 0);
  assert.equal(result.state.scales[0].name, "bot-orchestrator");
  assert.equal(result.state.scales.filter(value => value.replicas === 1)[0].name, "pgsql");
  const point = await inspectPublishedMonthlyPoint(f.output);
  assert.equal(point.metadata.runtime_generation,"minimal-snapshot-v1");
  assert.ok(result.state.commands.every(value => ["kubectl","doctl","curl"].includes(value.tool)));
  assert.equal(result.state.commands.filter(value=>value.tool==="curl"&&value.args.includes("POST")).length,2);
  assert.ok(result.state.commands.every(value => !value.args.join(" ").includes("guardian")));
  console.log(JSON.stringify({ state: "SIMULATED_MINIMAL_PASS", nativeExit: result.code, actualCaptureAccepted: false }));
});

test("failure of the second native snapshot restores all saved services and keeps the first partial unaccepted", { timeout: 30000 }, async () => {
  const f = await fixture({ failRole: "media" }), result = await f.run();
  assert.equal(result.code,1); assert.equal(result.signal,null);
  assert.deepEqual(result.state.posts,["database","media"]); assert.equal(result.state.snapshots.length,1);
  assert.ok(result.state.deployments.every(value => value.spec.replicas === (value.metadata.name === "bot-orchestrator" ? 0 : 1)));
  assert.ok((await readdir(f.output)).includes(".yenhubs-incomplete"));
  await assert.rejects(inspectPublishedMonthlyPoint(f.output));
  const again = await f.run(); assert.equal(again.code,1); assert.equal(again.state.posts.length,2);
  console.log(JSON.stringify({ state: "SIMULATED_MINIMAL_FAILURE_RECOVERED", nativeExit: result.code, actualCaptureAccepted: false }));
});

test("an uncertain POST is not retried and never starts the other snapshot", { timeout: 30000 }, async () => {
  const f = await fixture({ ambiguousRole: "database" }), result = await f.run();
  assert.equal(result.code,1); assert.deepEqual(result.state.posts,["database"]); assert.equal(result.state.snapshots.length,1);
  assert.ok(result.state.deployments.every(value => value.spec.replicas === (value.metadata.name === "bot-orchestrator" ? 0 : 1)));
});

test("an unsupported autoscaler stops before any pause or provider mutation", { timeout: 30000 }, async () => {
  const f = await fixture({ unsupportedHPA: true }), result = await f.run();
  assert.equal(result.code,1); assert.equal(result.state.posts.length,0); assert.equal(result.state.scales.length,0);
});
test("expired exclusion abandons capture and resolves a concurrent recovery renewal by readback", { timeout: 30000 }, async () => {
  const f = await fixture({ expireLease: true, conflictOnResume: true }), result = await f.run();
  assert.equal(result.code,1);assert.equal(result.state.resumeConflictSeen,true);
  assert.deepEqual(result.state.posts,["database"]);
  assert.ok(result.state.deployments.every(value => value.spec.replicas === (value.metadata.name === "bot-orchestrator" ? 0 : 1)));
  assert.equal(result.state.objects.length,0);
});

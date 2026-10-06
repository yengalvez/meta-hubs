import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const { installMonthlyProviderFixture } = require("./lib/monthly-provider-dispatch.cjs");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function fixture(mode) {
  const directory = await mkdtemp(join(tmpdir(), "yenhubs-monthly-dispatch-"));
  const bin = join(directory, "bin"), state = join(directory, "state");
  await mkdir(bin); await mkdir(state);
  const harness = await readFile(join(root, "tests/recovery/test-recovery-safety.sh"), "utf8");
  const marker = 'cat >"$TMP_DIR/bin/kubectl" <<\'STUB\'\n';
  assert.equal(harness.split(marker).length, 2);
  const body = harness.split(marker)[1].split("\nSTUB\n")[0];
  assert.ok(body.startsWith("#!/usr/bin/env bash\n"));
  await writeFile(join(bin, "kubectl"), body, { mode: 0o700 });
  await writeFile(join(bin, "doctl"), "#!/usr/bin/env bash\nexit 91\n", { mode: 0o700 });
  const lease = { apiVersion: "coordination.k8s.io/v1", kind: "Lease",
    metadata: { name: "yenhubs-operation-serialization", namespace: "hcce", uid: "fixture-lease-uid", resourceVersion: "lease-rv-1" },
    spec: { holderIdentity: "fixture", leaseTransitions: 0, leaseDurationSeconds: 120 } };
  await writeFile(join(state, "serialization-lease.json"), JSON.stringify(lease));
  if (mode === "exec") installMonthlyProviderFixture(bin, join(root, "tests/recovery/lib/monthly-provider-fixture.cjs"));
  else {
    // Reproduce exactly the discarded intermediary, without production code.
    const { rename } = await import("node:fs/promises");
    await rename(join(bin, "kubectl"), join(bin, "kubectl-legacy"));
    await writeFile(join(bin, "kubectl"), "#!" + process.execPath + "\n" +
      'const r=require("node:child_process").spawnSync(require("node:path").join(__dirname,"kubectl-legacy"),process.argv.slice(2),{stdio:"inherit",env:process.env});process.exit(r.status??95);\n', { mode: 0o700 });
  }
  const env = { PATH: bin + ":/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin", HOME: directory,
    STUB_STATE_DIR: state, KUBECTL_LOG: join(directory, "calls.log") };
  // Both WATCH and the following GET belong to one guard shell. Keep native
  // CAS, lock acquisition and handoff handlers from the established fixture.
  const script = String.raw`
set -euo pipefail
kubectl --context fixture-context --request-timeout=5s get --raw '/apis/coordination.k8s.io/v1/namespaces/hcce/leases?fieldSelector=metadata.name%3Dyenhubs-operation-serialization&resourceVersion=lease-rv-1&watch=true' >/dev/null
kubectl --context fixture-context --request-timeout=5s get --raw /apis/coordination.k8s.io/v1/namespaces/hcce/leases/yenhubs-operation-serialization >/dev/null
`;
  const result = await run("bash", ["-c", script], { env, timeout: 10000 });
  assert.equal(result.stderr, "");
  return { directory, bin, state, env, lease, handoffs: (await readdir(state)).filter(n => n.startsWith("serialization-lease-watch-handoff.")) };
}

test("the former Node fallback reproducibly leaves a PPID-scoped Lease handoff", async () => {
  const f = await fixture("spawn");
  assert.equal(f.handoffs.length, 1);
});

test("exec dispatch preserves the guard parent and permits an exact native Lease CAS", async () => {
  const f = await fixture("exec");
  assert.equal(f.handoffs.length, 0);
  const payload = join(f.directory, "renew.json");
  await writeFile(payload, JSON.stringify({ ...f.lease, spec: { ...f.lease.spec, renewTime: "2026-10-06T15:00:00.000000Z" } }));
  const { stdout } = await run("bash", ["-c", 'kubectl --context fixture-context --request-timeout=45s replace -f - -o json --request-timeout=3s < "$1"', "_", payload], { env: f.env, timeout: 10000 });
  assert.equal(JSON.parse(stdout).metadata.resourceVersion, "lease-rv-2");
  assert.equal((await readdir(f.state)).filter(n => n.startsWith("serialization-lease-watch-handoff.")).length, 0);
});

test("unknown providers remain closed and native fallback failure status is preserved", async () => {
  const f = await fixture("exec");
  await assert.rejects(run(join(f.bin, "doctl"), ["account", "get"], { env: f.env }), e => e.code === 91);
  await assert.rejects(run(join(f.bin, "kubectl"), ["--context", "not-fixture", "get", "pods"], { env: f.env }), e => e.code === 98);
});

test("the closed worker handles its exact 30s source forms and flushes only inside the paused boundary", async () => {
  const f = await fixture("exec"), id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const evidence = join(f.directory, "evidence"); await mkdir(evidence);
  await writeFile(join(evidence, "namespace-hcce.json"), JSON.stringify({ apiVersion: "v1", kind: "Namespace",
    metadata: { name: "hcce", uid: id(1) } }));
  const env = { ...f.env, RUNNER_EVIDENCE_LIVE_DIR: evidence };
  const get = args => run(join(f.bin, "kubectl"), ["--context", "fixture-context", "--request-timeout=30s", ...args], { env });
  const cases = [["get", "namespace", "hcce", "-o", "json"],
    ["-n", "hcce", "get", "pvc", "pgsql-pvc", "ret-pvc", "-o", "json"],
    ["get", "pv", "pv-database", "pv-media", "-o", "json"],
    ["-n", "hcce", "get", "pod", "pgsql-0", "-o", "json"]];
  const results = [];
  for (const args of cases) results.push(JSON.parse((await get(args)).stdout));
  assert.equal(results[0].metadata.uid, id(1));
  assert.deepEqual(results[1].items.map(v => v.metadata.uid), [id(2), id(6)]);
  assert.deepEqual(results[2].items.map(v => v.spec.csi.volumeHandle), [id(4), id(8)]);
  assert.equal(results[3].metadata.uid, id(5));
  const writers = ["reticulum", "pgbouncer", "pgbouncer-t", "bot-orchestrator", "coturn"];
  for (const writer of writers) await writeFile(join(f.state, "replicas-" + writer), "1");
  const sync = ["-n", "hcce", "exec", "pgsql-0", "-c", "pgsql", "--", "sh", "-ec", "sync"];
  await assert.rejects(get(sync), e => e.code === 96);
  for (const writer of writers) await writeFile(join(f.state, "replicas-" + writer), "0");
  await writeFile(join(f.state, "restore-lock.yaml"), "fixture-lock");
  await writeFile(join(f.state, "recovery-operation-fence-binding-state"), "active");
  assert.equal((await get(sync)).stdout, "");
  assert.deepEqual(JSON.parse((await readFile(join(f.state, "monthly-provider-calls.jsonl"), "utf8")).trim()), { event: "sync" });
});

test("the live database query has an unbound SQL hash, unlike a frozen dump artifact", async () => {
  const { stdout } = await run("bash", ["-c", 'source "$1"; recovery_database_contract_sql', "_",
    join(root, "deployment/lib/recovery-safety.sh")], { env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin" } });
  assert.match(stdout, /'schema_version', 2/);
  assert.match(stdout, /'sql_dump_sha256', null/);
  const contract = { schema_version: 2, sql_dump_sha256: "a".repeat(64), critical_inventory: { fixture: "preserved" } };
  const result = spawnSync("jq", [".sql_dump_sha256 = null"], { input: JSON.stringify(contract), encoding: "utf8",
    env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin" } });
  // No provider, SQL execution or inherited offline dump is accepted by this
  // query check. The full coordinator supplies the complete live fixture file.
  assert.equal(contract.sql_dump_sha256.length, 64);
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { ...contract, sql_dump_sha256: null });
  assert.ok(stdout.includes("'critical_inventory'"));
});

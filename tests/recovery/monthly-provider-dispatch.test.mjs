import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
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

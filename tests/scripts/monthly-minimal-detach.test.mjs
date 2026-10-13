import { test } from "node:test";
import assert from "node:assert/strict";
import { createMinimalKubernetes } from "../../deployment/monthly-minimal-kubernetes.mjs";

// Synthetic replay of the 13 October ordering: pod gone/new pod requested
// before the old provider detach finished. No processes, credentials or network.
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const names = ["bot-orchestrator", "reticulum", "pgbouncer", "pgbouncer-t", "coturn", "pgsql"];
const origin = Date.parse("2026-10-13T06:56:48Z");
async function fixture(options = {}) {
  let clock = origin, stoppedAt = null, resumedTooSoon = false, lease;
  const calls = [], detachedAfter = options.detachedAfter ?? 7000;
  const volumes = [0, 1].map(i => ({ id: id(6+i), region: { slug: "ams3" }, size_gigabytes: 10 }));
  const pvcs = ["pgsql-pvc", "ret-pvc"].map((name, i) => ({
    metadata: { name, namespace: "hcce", uid: id(2+i) }, spec: { volumeName: `pv-${i}` },
    status: { phase: "Bound", capacity: { storage: "10Gi" } }
  }));
  const pvs = pvcs.map((pvc, i) => ({ metadata: { name: `pv-${i}`, uid: id(4+i) },
    spec: { claimRef: { name: pvc.metadata.name, namespace: "hcce", uid: pvc.metadata.uid },
      csi: { driver: "dobs.csi.digitalocean.com", volumeHandle: volumes[i].id } }, status: { phase: "Bound" } }));
  const deployments = names.map((name, i) => ({ metadata: { name, uid: id(30+i), generation: 1, resourceVersion: "1" },
    spec: { replicas: 1, template: { spec: { containers: [{ name, image: "ghcr.io/yengalvez/bot-orchestrator@sha256:"+"a".repeat(64) }] } } },
    status: { observedGeneration: 1, readyReplicas: 1 } }));
  const detached = () => stoppedAt !== null && clock - stoppedAt >= detachedAfter;
  const pods = () => deployments.filter(d => d.spec.replicas > 0).map(d => {
    const pg = d.metadata.name === "pgsql", ret = d.metadata.name === "reticulum";
    return { metadata: { name: d.metadata.name+"-fixture", namespace: "hcce", uid: id(pg ? 8 : ret ? 9 : 10), labels: { app: d.metadata.name } },
      spec: { nodeName: "fixture-node", volumes: pg || ret ? [{ name: "data", persistentVolumeClaim: { claimName: pg ? "pgsql-pvc" : "ret-pvc" } }] : [],
        containers: [{ name: d.metadata.name, volumeMounts: pg || ret ? [{ name: "data", mountPath: pg ? "/var/lib/postgresql/data" : "/storage" }] : [] }] },
      status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] } };
  });
  const run = async (program, args, request = {}) => {
    calls.push({ program, args: [...args], at: clock });
    const finish = value => ({ nativeExitCode: 0, stdout: typeof value === "string" ? value : JSON.stringify(value) });
    if (program === "doctl") {
      assert.deepEqual(args.slice(0,3), ["compute", "volume", "get"]);
      const volume = volumes.find(v => v.id === args[3]); assert.ok(volume);
      const changed = stoppedAt !== null && options.providerChanged;
      return finish([{ ...volume, id: changed ? id(999) : volume.id,
        droplet_ids: detached() ? [] : [12345] }]);
    }
    assert.equal(program, "kubectl"); assert.equal(args[args.indexOf("--context")+1], "do-ams3-hubs-ce");
    if (args.includes("exec")) return finish(args.at(-1) === "sync" ? "" :
      "12\n/var/lib/postgresql/data\n/var/lib/postgresql/data/pg_wal\n0\nsame\non\non\nsync\n");
    if (args.includes("create") || args.includes("replace")) {
      const object = JSON.parse(request.input); assert.equal(object.kind, "Lease");
      lease = { ...object, metadata: { ...object.metadata, uid: id(90), resourceVersion: "1" } }; return finish(lease);
    }
    if (args.includes("patch")) {
      const at = args.indexOf("patch"); assert.equal(args[at+1], "deployment");
      const d = deployments.find(d => d.metadata.name === args[at+2]), patch = JSON.parse(request.input);
      assert.equal(patch[0].value, d.metadata.uid); assert.equal(patch[1].value, d.metadata.resourceVersion);
      const replicas = patch.at(-1).value;
      if (d.metadata.name === "pgsql" && replicas === 0) stoppedAt = clock;
      if (d.metadata.name === "pgsql" && replicas === 1 && !detached()) resumedTooSoon = true;
      d.spec.replicas = replicas; d.metadata.generation++; d.metadata.resourceVersion = String(d.metadata.generation);
      d.status = { observedGeneration: d.metadata.generation, readyReplicas: resumedTooSoon && d.metadata.name === "pgsql" ? 0 : replicas };
      return finish(d);
    }
    const at = args.indexOf("get"), resource = args[at+1], name = args[at+2];
    if (resource === "namespace") return finish({ metadata: { name: "hcce", uid: id(1) } });
    if (resource === "pvc") return finish({ items: pvcs });
    if (resource === "pv") return finish({ items: pvs.map(p => stoppedAt !== null && options.pvChanged ?
      { ...p, metadata: { ...p.metadata, uid: id(998) } } : p) });
    if (resource === "pods") return finish({ items: args.includes("hcce-bot-runners") ? [] : pods() });
    if (resource === "pod") return finish(pods().find(p => p.metadata.name === name));
    if (resource === "deployments") return finish({ items: deployments });
    if (resource === "deployment") return finish(deployments.find(d => d.metadata.name === name));
    if (resource === "lease") return finish(stoppedAt !== null && clock - stoppedAt >= (options.loseLeaseAt ?? Infinity) ?
      { ...lease, metadata: { ...lease.metadata, uid: id(999) } } : lease ?? "");
    if (["hpa", "cronjobs", "jobs"].includes(resource)) return finish({ items: [] });
    if (resource === "volumeattachments") {
      const retain = options.attachmentAbsent !== true && !detached();
      return finish({ items: retain ? pvs.map(p => ({ metadata: { uid: id(100), deletionTimestamp: new Date(origin).toISOString() },
        spec: { attacher: "dobs.csi.digitalocean.com", nodeName: options.foreignNode ? "other-node" : "fixture-node",
          source: { persistentVolumeName: p.metadata.name } }, status: { attached: true } })) : [] });
    }
    throw new Error("unexpected_fixture_read:"+resource);
  };
  const cluster = createMinimalKubernetes({ env: { EXPECTED_KUBE_CONTEXT: "do-ams3-hubs-ce", NAMESPACE: "hcce", MONTHLY_REGION: "ams3",
    MONTHLY_INSTANCE_ID: "fixture-instance", EXPECTED_NAMESPACE_UID: id(1), EXPECTED_DB_PVC_UID: id(2), EXPECTED_RET_PVC_UID: id(3) },
    root: new URL("../../", import.meta.url).pathname }, { run, now: () => clock, delay: async ms => { clock += ms; } });
  await cluster.acquire(); const saved = await cluster.inventory(await cluster.source()); await cluster.pauseWriters(saved);
  return { cluster, saved, calls, deployments, elapsed: () => clock - stoppedAt, early: () => resumedTooSoon };
}

test("replays pod absence before detach completion: resume waits for a fresh attachment instead of the stale attached flag", async () => {
  const f = await fixture(); await f.cluster.stopDatabase(f.saved);
  await f.cluster.confirmPaused(f.saved); await f.cluster.resume(f.saved); await f.cluster.verifyResumed(f.saved);
  assert.ok(f.elapsed() >= 7000, "pod disappearance is not provider detach completion");
  assert.equal(f.early(), false);
  assert.ok(f.deployments.every(d => d.status.readyReplicas === d.spec.replicas));
  assert.ok(f.calls.some(c => c.args.includes("volumeattachments")));
  assert.ok(f.calls.filter(c => c.program === "doctl").every(c => c.args.includes("--http-retry-max") && c.args.at(-1) === "0"));
});

test("an absent Kubernetes attachment alone is insufficient while the provider still reports the old connection", async () => {
  const f = await fixture({ attachmentAbsent: true }); await f.cluster.stopDatabase(f.saved);
  assert.ok(f.elapsed() >= 7000); await f.cluster.resume(f.saved); assert.equal(f.early(), false);
});

test("a stuck detach fails within the existing ninety-second boundary, without a force detach or longer readiness timeout", async () => {
  const f = await fixture({ detachedAfter: Infinity });
  await assert.rejects(f.cluster.stopDatabase(f.saved), /monthly_minimal_detach_unproven/);
  assert.equal(f.elapsed(), 90000);
  assert.ok(f.calls.every(c => c.program !== "doctl" || c.args[2] === "get"));
  assert.ok(f.deployments.every(d => d.spec.replicas === 0));
});

test("loss of the exact operation Lease during detach settling stops the read sequence before resume", async () => {
  const f = await fixture({ loseLeaseAt: 3000 });
  await assert.rejects(f.cluster.stopDatabase(f.saved), /monthly_minimal_operation_lock_lost/);
  assert.equal(f.elapsed(), 3000); assert.equal(f.early(), false);
  assert.ok(f.deployments.every(d => d.spec.replicas === 0));
});

for (const [option, reason] of [["providerChanged", "monthly_minimal_detach_provider_changed"],
  ["pvChanged", "monthly_minimal_detach_binding_changed"], ["foreignNode", "monthly_minimal_detach_attachment_changed"]]) {
  test(`detach settling rejects ${option} rather than changing another disk or connection`, async () => {
    const f = await fixture({ [option]: true }); await assert.rejects(f.cluster.stopDatabase(f.saved), new RegExp(reason));
    assert.ok(f.calls.every(c => c.program !== "doctl" || c.args[2] === "get"));
    assert.equal(f.early(), false);
  });
}

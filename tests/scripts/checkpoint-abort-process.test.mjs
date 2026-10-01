import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const { privateFile, writePrivate, hash, ORDER } = require("../../hubs-cloud/community-edition/apply/recover-avatar-checkpoint");
const worker = new URL("./fixtures/checkpoint-abort-process.cjs", import.meta.url);
const ANNOTATION = "yenhubs.org/checkpoint-resume-operation";

// Actual child processes, SIGKILL and private fsynced receipt/journal/peer state.
// Kubernetes, readiness, external verifiers and time are simulated, NOT real
// backup/restore/live acceptance or a latency benchmark.
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "yenhubs-abort-process-"));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = name => path.join(directory, name);
  const read = name => JSON.parse(privateFile(file(name)));
  const mutate = callback => { const state = read("peer.json"); callback(state); writePrivate(file("peer.json"), state); };
  async function invoke(mode) {
    const start = performance.now();
    const child = spawn(process.execPath, [fileURLToPath(worker), mode, directory], {
      env: process.env, stdio: ["ignore", "pipe", "pipe"], timeout: 10000, killSignal: "SIGKILL"
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    const [code, signal] = await new Promise((resolve, reject) => {
      child.once("error", reject); child.once("close", (code, signal) => resolve([code, signal]));
    });
    assert.equal(stderr, "", "no private payload or unexpected peer error is printed");
    return { code, signal, pid: child.pid, elapsedMs: performance.now() - start,
      result: stdout.trim() ? JSON.parse(stdout) : null };
  }
  assert.equal((await invoke("seed")).code, 0);
  assert.equal((await invoke("prepare")).code, 0);
  assert.deepEqual(read("peer.json").writes, [], "planning performs no mutation");
  const immutable = Object.fromEntries(["receipt.json", "plan.json", "data-sentinels.json"].map(name => [name, hash(privateFile(file(name)))]));
  mutate(state => { state.time += 121000; state.calls = {}; });
  function recovered() {
    const state = read("peer.json"), journal = read("plan.json.journal.json");
    assert.equal(journal.stage, "recovered-abort-only");
    assert.equal(state.lock, null); assert.ok(!state.lease.spec.holderIdentity);
    for (const name of ORDER) {
      assert.equal(state.deployments[name].spec.replicas, 2);
      assert.equal(state.deployments[name].status.readyReplicas, 2);
      assert.equal(state.deployments[name].metadata.annotations[ANNOTATION], undefined);
      assert.equal(state.writes.filter(write => write.label === `resume:${name}`).length, 1, `${name} is resumed exactly once`);
      assert.equal(state.writes.filter(write => write.label === `clear:${name}`).length, 1, `${name} receipt is cleared exactly once`);
    }
    for (const label of ["fence", "delete:lock", "lease-release"]) assert.equal(state.writes.filter(write => write.label === label).length, 1);
    for (const [name, digest] of Object.entries(immutable)) assert.equal(hash(privateFile(file(name))), digest, `${name} unchanged`);
    for (const name of ["receipt.json", "plan.json", "peer.json", "plan.json.journal.json"]) assert.equal(fs.statSync(file(name)).mode & 0o777, 0o600);
    assert.equal(fs.readdirSync(directory).some(name => /SHA256SUMS|\.tar\.gz|\.sql\.gz|complete/.test(name)), false);
    return state;
  }
  return { read, mutate, invoke, recovered };
}

test("healthy different-process abort-only recovery preserves all originals; counts serial peer calls", async t => {
  const f = await fixture(t), result = await f.invoke("execute");
  assert.equal(result.code, 0); const state = f.recovered();
  assert.equal(new Set(state.processIds).size, 2, "prepare and execute are distinct OS processes");
  assert.ok(Object.values(state.calls).every(Number.isInteger));
  const calls = Object.values(state.calls).reduce((sum, value) => sum + value, 0);
  assert.ok(calls > 0); t.diagnostic(JSON.stringify({ peerCalls: calls, leaseGet: state.calls["lease:get"],
    leaseReplace: state.calls["lease:replace"], localProcessMs: Math.round(result.elapsedMs),
    callsByKind: state.calls,
    timingScope: "local-process-only-virtual-api-time-excludes-external-verifiers" }));
});

for (const label of ["lease-acquire", "fence", "resume:pgbouncer", "resume:reticulum", "clear:reticulum", "delete:lock", "lease-release"]) {
  test(`SIGKILL after persisted server commit, before ACK: new process reconciles ${label}`, async t => {
    const f = await fixture(t);
    f.mutate(state => { state.fault = { label, type: "SIGKILL" }; });
    const dead = await f.invoke("execute");
    assert.equal(dead.code, null); assert.equal(dead.signal, "SIGKILL");
    assert.equal(f.read("peer.json").writes.filter(write => write.label === label).length, 1);
    f.mutate(state => { state.time += 121000; });
    const restarted = await f.invoke("execute");
    assert.notEqual(restarted.pid, dead.pid); assert.equal(restarted.code, 0);
    const state = f.recovered();
    assert.equal(new Set(state.processIds).size, 3, "no coordinator object or authority survives death");
    if (!["lease-acquire", "lease-release"].includes(label)) {
      const holders = state.writes.filter(write => write.label === "lease-acquire");
      assert.equal(holders.length, 2); assert.notEqual(holders[0].pid, holders[1].pid);
    }
  });
}

test("API outage terminates one process without mutation; returned API needs a fresh process", async t => {
  const f = await fixture(t);
  f.mutate(state => { state.outage = true; });
  const failed = await f.invoke("execute");
  assert.equal(failed.code, 1); assert.equal(failed.result.code, "fixture_api_eof");
  assert.deepEqual(f.read("peer.json").writes, []); assert.ok(f.read("peer.json").lock);
  f.mutate(state => { state.outage = false; state.time += 121000; });
  const next = await f.invoke("execute");
  assert.notEqual(next.pid, failed.pid); assert.equal(next.code, 0); f.recovered();
});

test("ACK loss without SIGKILL still revokes attempt and reconciles from disk in a new process", async t => {
  const f = await fixture(t);
  f.mutate(state => { state.fault = { label: "resume:reticulum", type: "lost-ack" }; });
  const failed = await f.invoke("execute");
  assert.equal(failed.code, 1); assert.equal(failed.result.code, "fixture_response_eof");
  assert.ok(f.read("peer.json").lock);
  f.mutate(state => { state.time += 121000; });
  const next = await f.invoke("execute");
  assert.notEqual(next.pid, failed.pid); assert.equal(next.code, 0); f.recovered();
});

test("API loss while partly resumed never grants authority to the new process; later return reconciles", async t => {
  const f = await fixture(t);
  f.mutate(state => { state.fault = { label: "resume:reticulum", type: "SIGKILL" }; });
  const dead = await f.invoke("execute"); assert.equal(dead.signal, "SIGKILL");
  const writes = f.read("peer.json").writes.length;
  f.mutate(state => { state.outage = true; state.time += 121000; });
  const offline = await f.invoke("execute");
  assert.equal(offline.code, 1); assert.equal(offline.result.code, "fixture_api_eof");
  assert.equal(f.read("peer.json").writes.length, writes); assert.ok(f.read("peer.json").lock);
  f.mutate(state => { state.outage = false; });
  const recovered = await f.invoke("execute"); assert.equal(recovered.code, 0);
  assert.notEqual(recovered.pid, offline.pid); f.recovered();
});

test("terminal journal is rechecked by another OS process without repeating any write", async t => {
  const f = await fixture(t), first = await f.invoke("execute");
  assert.equal(first.code, 0); const before = f.recovered().writes;
  const again = await f.invoke("execute"); assert.equal(again.code, 0);
  assert.notEqual(first.pid, again.pid); assert.deepEqual(f.recovered().writes, before);
});

for (const [label, drift, expected] of [
  ["writer UID", state => { state.deployments.reticulum.metadata.uid = "foreign-writer"; }, "deployment_changed:reticulum"],
  ["Lease UID", state => { state.lease.metadata.uid = "foreign-lease"; }, "lease_identity_changed"],
  ["expired foreign Lease holder", state => { state.lease.spec.holderIdentity = "cloud-apply:33333333-3333-4333-8333-333333333333"; state.lease.spec.leaseTransitions++; }, "foreign_lease_lineage"]
]) {
  test(`fresh process does not adopt ${label} after SIGKILL`, async t => {
    const f = await fixture(t);
    f.mutate(state => { state.fault = { label: "resume:pgbouncer", type: "SIGKILL" }; });
    assert.equal((await f.invoke("execute")).signal, "SIGKILL");
    const before = f.read("peer.json").writes.filter(write => write.label.startsWith("resume:")).length;
    f.mutate(state => { state.time += 121000; drift(state); });
    const rejected = await f.invoke("execute");
    assert.equal(rejected.code, 1); assert.equal(rejected.result.code, expected);
    const state = f.read("peer.json"); assert.ok(state.lock);
    assert.equal(state.writes.filter(write => write.label.startsWith("resume:")).length, before);
    assert.notEqual(f.read("plan.json.journal.json").stage, "recovered-abort-only");
  });
}

for (const kind of ["uid", "image"]) {
  test(`any observed consumer ${kind} drift fails closed, not overwritten by an immediate second GET`, async t => {
    const f = await fixture(t);
    // First consumer observation after the fence differs; a duplicate GET
    // would return the original. Every observation used by a check must bind
    // UID/spec and annotations to the same resource, without cached authority.
    f.mutate(state => { state.readFault = { after: "fence", name: "reticulum", kind }; });
    const failed = await f.invoke("execute");
    assert.ok(f.read("peer.json").readFault.fired);
    assert.equal(failed.code, 1); assert.equal(failed.result.code, "deployment_changed:reticulum");
    const state = f.read("peer.json"); assert.ok(state.lock);
    assert.equal(state.writes.some(write => write.label.startsWith("resume:")), false);
  });
}

for (const [kind, expected] of [
  ["uid", "lease_identity_changed"],
  ["transitions", "foreign_lease_lineage"],
  ["acquire-time", "foreign_lease_lineage"]
]) {
  test(`any observed Lease ${kind} drift fails closed on the same freshness observation`, async t => {
    const f = await fixture(t);
    // The second observation after the fence is owned and fresh, but has
    // foreign identity/lineage. The following GET returns the original.
    // Mixing lineage from one GET with freshness from another must not grant
    // authority or let subsequent observations erase the observed drift.
    f.mutate(state => { state.leaseReadFault = { after: "fence", observation: 2, kind }; });
    const failed = await f.invoke("execute"), state = f.read("peer.json");
    assert.ok(state.leaseReadFault.fired);
    assert.equal(failed.code, 1); assert.equal(failed.result.code, expected);
    assert.ok(state.lock);
    assert.equal(state.writes.some(write => write.label.startsWith("resume:")), false);
    assert.equal(state.writes.some(write => write.label === "delete:lock" || write.label === "lease-release"), false);
    assert.notEqual(f.read("plan.json.journal.json").stage, "recovered-abort-only");
  });
}

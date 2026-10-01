// Local-only, durable API peer for the OS-process recovery regression.
// No production CLI, kubectl, network, control-plane deployment or real data.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  createCoordinator, writePrivate, privateFile, hash, ORDER,
  normalizedSpec, deploymentMetadata, fenceIdentity
} = require("../../../hubs-cloud/community-edition/apply/recover-avatar-checkpoint");
const { leaseDocument } = require("../../../hubs-cloud/community-edition/apply/operation-lease");
const {
  recoveryOperationFenceNamespaceSelector,
  RECOVERY_OPERATION_FENCE_POLICY_NAME: FENCE
} = require("../../../hubs-cloud/community-edition/apply/runner-activation");

const [mode, directory] = process.argv.slice(2);
assert.ok(["seed", "prepare", "execute"].includes(mode));
assert.ok(path.isAbsolute(directory));
assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
const file = name => path.join(directory, name);
const read = name => JSON.parse(privateFile(file(name)));
const clone = structuredClone;
const INCIDENT = {
  context: "local-process-fixture", namespace: "example", namespaceUid: "ns-uid",
  pvcUid: "pvc-uid", lockUid: "lock-uid", lockRv: "1",
  operation: "1".repeat(32), stamp: "20261001-120000"
};
const IMAGE = `example/reticulum@sha256:${"b".repeat(64)}`;
const ANNOTATION = "yenhubs.org/checkpoint-resume-operation";

function binding(active) {
  return {
    apiVersion: "admissionregistration.k8s.io/v1", kind: "ValidatingAdmissionPolicyBinding",
    metadata: { name: FENCE, uid: "binding-uid", resourceVersion: active ? "3" : "2" },
    spec: { policyName: FENCE, validationActions: ["Deny"], matchResources: {
      matchPolicy: "Equivalent",
      namespaceSelector: recoveryOperationFenceNamespaceSelector(INCIDENT.namespace, { active }),
      objectSelector: {}
    } }
  };
}
function deployment(name, replicas = 0) {
  const resource = {
    apiVersion: "apps/v1", kind: "Deployment",
    metadata: { name, namespace: INCIDENT.namespace, uid: `${name}-uid`, resourceVersion: "2",
      generation: 1, labels: { app: name },
      annotations: { "yenhubs.org/bot-runner-recovery-phase": "active" } },
    spec: { replicas, strategy: { type: "Recreate" }, selector: { matchLabels: { app: name } },
      template: { metadata: { labels: { app: name } }, spec: { containers: [{ name, image: IMAGE }] } } },
    status: { observedGeneration: 1, readyReplicas: replicas, availableReplicas: replicas, updatedReplicas: replicas }
  };
  if (name === "reticulum") {
    resource.spec.template.spec.volumes = [{ name: "storage", persistentVolumeClaim: { claimName: "ret-pvc" } }];
    resource.spec.template.spec.containers[0].volumeMounts = [{ name: "storage", mountPath: "/storage" }];
  }
  return resource;
}
function seed() {
  const now = Date.parse("2026-10-01T12:00:00Z");
  const originalLease = leaseDocument({ namespace: INCIDENT.namespace,
    holder: "root-recovery:11111111-1111-4111-8111-111111111111", now });
  Object.assign(originalLease.metadata, { uid: "lease-uid", resourceVersion: "1" });
  const lock = {
    apiVersion: "v1", kind: "ConfigMap", immutable: true,
    metadata: { name: "yenhubs-recovery-operation-lock", namespace: INCIDENT.namespace,
      uid: INCIDENT.lockUid, resourceVersion: INCIDENT.lockRv,
      labels: { "yenhubs.org/recovery-owner": "checkpoint-backup" },
      annotations: {
        "yenhubs.org/operation-id": INCIDENT.operation, "yenhubs.org/recovery-token": "a".repeat(32),
        "yenhubs.org/namespace-uid": INCIDENT.namespaceUid, "yenhubs.org/pvc-uid": INCIDENT.pvcUid,
        "yenhubs.org/checkpoint-stamp": INCIDENT.stamp,
        "yenhubs.org/dump-sha256": "b".repeat(64), "yenhubs.org/storage-sha256": "c".repeat(64)
      } }
  };
  const receipt = {
    schema: 1, action: "abort-only", runtime: "durable-v2", format: "legacy", incident: INCIDENT,
    lock: null, inputs: {}, originalLease,
    deployments: ORDER.map(name => {
      const resource = deployment(name);
      return { name, uid: resource.metadata.uid, rv: resource.metadata.resourceVersion, replicas: 2,
        spec: normalizedSpec(resource), metadata: deploymentMetadata(resource) };
    }),
    policy: { uid: "policy-uid", rv: "2", spec: { fixture: true } },
    binding: fenceIdentity(binding(false)), helperImage: IMAGE
  };
  const inventory = {
    schema_version: 4, bot_runner_runtime: { mode: "kubernetes-pod", generation: "durable-v2" },
    deployments: receipt.deployments.map(entry => ({ name: entry.name, uid: entry.uid,
      replicas: entry.replicas, containers: [{ name: entry.name, image: IMAGE }] }))
  };
  for (const [name, value] of Object.entries({ values: { fixture: true }, manifest: { fixture: true },
    inventory, key: { fixture: true } })) {
    const input = file(`${name}.private.json`);
    writePrivate(input, value, true);
    receipt.inputs[name] = { path: input, sha256: hash(privateFile(input)) };
  }
  receipt.lock = createCoordinator(receipt).lockProjection(lock);
  writePrivate(file("receipt.json"), receipt, true);
  writePrivate(file("peer.json"), {
    time: now, rv: 20, lock, binding: binding(true),
    policy: { apiVersion: "admissionregistration.k8s.io/v1", kind: "ValidatingAdmissionPolicy",
      metadata: { name: FENCE, uid: "policy-uid", resourceVersion: "2" }, spec: { fixture: true } },
    deployments: Object.fromEntries([...ORDER, "pgsql"].map(name => [name, deployment(name)])),
    lease: clone(originalLease), pods: [], replicaSets: {}, writes: [], calls: {},
    processIds: [], fault: null, outage: false, verifiers: [], waits: 0
  }, true);
  writePrivate(file("data-sentinels.json"), { db: "original metadata bytes", media: "original media bytes" }, true);
}

async function run() {
  if (mode === "seed") { seed(); return; }
  // Each invocation reconstructs all runtime objects from disk, never from IPC.
  const state = read("peer.json"), receipt = read("receipt.json");
  state.processIds.push(process.pid);
  const persist = () => writePrivate(file("peer.json"), state);
  const count = key => { state.calls[key] = (state.calls[key] || 0) + 1; };
  const available = () => { if (state.outage) throw new Error("fixture_api_eof"); };
  const wrote = label => {
    state.writes.push({ label, pid: process.pid });
    const fault = state.fault?.label === label ? state.fault : null;
    if (fault) state.fault = null;
    // Server commit is fsynced BEFORE loss of ACK / actual process death.
    persist();
    if (fault?.type === "SIGKILL") process.kill(process.pid, "SIGKILL");
    if (fault?.type === "lost-ack") throw new Error("fixture_response_eof");
  };
  const leaseClient = {
    get() {
      count("lease:get"); available();
      const observed = clone(state.lease), fault = state.leaseReadFault;
      if (fault && !fault.fired && state.writes.some(write => write.label === fault.after)) {
        fault.reads = (fault.reads || 0) + 1;
        if (fault.reads === fault.observation) {
          fault.fired = true;
          fault.writesAtObservation = state.writes.length;
          if (fault.kind === "uid") observed.metadata.uid = "foreign-observed-lease";
          else if (fault.kind === "transitions") observed.spec.leaseTransitions++;
          else if (fault.kind === "acquire-time") {
            observed.spec.acquireTime = new Date(state.time + 1000).toISOString().replace(/(\.\d{3})Z$/u, "$1000Z");
          } else throw new Error("unexpected_lease_read_fault");
        }
      }
      return observed;
    },
    create() { throw new Error("unexpected_lease_create"); },
    replace(document) {
      count("lease:replace"); available();
      if (document.metadata.resourceVersion !== state.lease.metadata.resourceVersion) return { conflict: true };
      const oldHolder = state.lease.spec.holderIdentity;
      state.lease = { ...clone(document), metadata: { ...document.metadata, uid: "lease-uid", resourceVersion: String(++state.rv) } };
      const label = !document.spec.holderIdentity ? "lease-release" : document.spec.holderIdentity !== oldHolder ? "lease-acquire" : "lease-renew";
      wrote(label);
      const observed = clone(state.lease), fault = state.leaseResponseFault;
      if (fault?.label === label && !fault.fired) {
        fault.fired = true; fault.writesAtObservation = state.writes.length;
        if (fault.kind === "uid") observed.metadata.uid = "foreign-ack-lease";
        else if (fault.kind === "transitions") observed.spec.leaseTransitions++;
        else if (["acquire-time", "renew-time"].includes(fault.kind)) {
          observed.spec[fault.kind === "acquire-time" ? "acquireTime" : "renewTime"] =
            new Date(state.time + 1000).toISOString().replace(/(\.\d{3})Z$/u, "$1000Z");
        }
        else throw new Error("unexpected_lease_response_fault");
      }
      return { resource: observed };
    }
  };
  function kubectl(args, document, allowFailure = false) {
    let command = [...args];
    if (command[0] === "-n") command = command.slice(2);
    const [verb, kind, name] = command;
    count(`api:${verb}:${verb === "delete" ? "owned-resource" : kind}`); available();
    if (verb === "get") {
      const resources = {
        namespace: { metadata: { uid: state.namespaceUid || INCIDENT.namespaceUid }, status: { phase: "Active" } },
        pvc: { metadata: { uid: state.pvcUid || INCIDENT.pvcUid }, status: { phase: "Bound" } },
        cm: state.lock, lease: state.lease, deployment: state.deployments[name],
        replicaset: state.replicaSets[name], validatingadmissionpolicy: state.policy,
        validatingadmissionpolicybinding: state.binding, pods: { items: state.pods }
      };
      const resource = resources[kind];
      if (allowFailure) return { status: 0, stdout: resource ? JSON.stringify(resource) : "" };
      assert.ok(resource, "unexpected_missing_resource");
      const observed = clone(resource), fault = state.readFault;
      if (kind === "deployment" && name === fault?.name && !fault.fired &&
          state.writes.some(write => write.label === fault.after)) {
        fault.fired = true;
        if (fault.kind === "uid") observed.metadata.uid = "foreign-observed-writer";
        else if (fault.kind === "image") observed.spec.template.spec.containers[0].image = "foreign-observed-image";
        else throw new Error("unexpected_read_fault");
      }
      return observed;
    }
    if (verb === "replace") {
      if (command.includes("--dry-run=server")) return clone(document);
      assert.equal(document.metadata.uid, state.binding.metadata.uid);
      assert.equal(document.metadata.resourceVersion, state.binding.metadata.resourceVersion);
      state.binding = clone(document); state.binding.metadata.resourceVersion = String(++state.rv);
      wrote("fence"); return clone(state.binding);
    }
    if (verb === "patch") {
      const resource = state.deployments[name];
      for (const operation of document) {
        const keys = operation.path.slice(1).split("/").map(key => key.replace(/~1/g, "/"));
        let parent = resource;
        for (const key of keys.slice(0, -1)) parent = parent[key];
        const key = keys.at(-1);
        if (operation.op === "test") assert.deepEqual(parent[key], operation.value);
        else if (operation.op === "remove") delete parent[key];
        else { assert.ok(["add", "replace"].includes(operation.op)); parent[key] = clone(operation.value); }
      }
      resource.metadata.resourceVersion = String(++state.rv);
      resource.status = { observedGeneration: resource.metadata.generation, readyReplicas: resource.spec.replicas,
        availableReplicas: resource.spec.replicas, updatedReplicas: resource.spec.replicas };
      wrote(`${resource.metadata.annotations[ANNOTATION] ? "resume" : "clear"}:${name}`);
      return clone(resource);
    }
    if (verb === "delete") {
      assert.ok(kind.includes("/configmaps/"), "unexpected_delete");
      assert.equal(state.lock.metadata.uid, document.preconditions.uid);
      assert.equal(state.lock.metadata.resourceVersion, document.preconditions.resourceVersion);
      state.lock = null; wrote("delete:lock"); return { kind: "Status", status: "Success" };
    }
    throw new Error("unexpected_api_operation");
  }
  const adapters = {
    quiet: true, now: () => state.time,
    sleep: async milliseconds => { state.time += milliseconds; state.waits++; },
    kubectl, leaseClient,
    verifyManifest: () => ({ config: { Namespace: INCIDENT.namespace },
      plan: { resources: [...ORDER.map(name => clone(state.deployments[name])), binding(false)] } }),
    controlPlane: (_resources, active) => { state.verifiers.push(`control:${active}`); },
    probes: active => { state.verifiers.push(`probe:${active}`); },
    classifyRunners: async () => { state.verifiers.push("runners"); return []; }
  };
  try {
    const coordinator = createCoordinator(receipt, adapters);
    const packet = file("plan.json");
    if (mode === "prepare") await coordinator.prepare(packet);
    else await coordinator.execute(packet, hash(privateFile(packet)));
    process.stdout.write(JSON.stringify({ status: "pass", pid: process.pid }) + "\n");
  } catch (error) {
    const code = /^[a-z][a-z0-9_:-]{0,100}$/.test(error.message) ? error.message : "uncoded_error";
    process.stdout.write(JSON.stringify({ status: "fail", code, pid: process.pid }) + "\n");
    process.exitCode = 1;
  } finally { persist(); }
}
run().catch(() => { process.stderr.write("local_peer_setup_failed\n"); process.exitCode = 2; });

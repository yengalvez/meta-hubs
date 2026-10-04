import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createCheckpointBackupAuthorityV2, createKeyRecord } from "../../deployment/recovery-checkpoint-authority.mjs";
import { guardPodDocumentForIdentity } from "../../hubs-cloud/community-edition/services/bot-orchestrator/kubernetes-runner-manager.js";
import {
  controlResourceFromList,
  normalizeCompleteParentList,
  podInitialWatchRawPath,
  podWatchRawPath,
  podWatchStateFromLists,
  validatePodWatchStream
} from "../../deployment/watch-durable-runner-quiescence.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const monitorPath = path.join(root, "deployment/watch-durable-runner-quiescence.mjs");
const runnerNamespace = "hcce-bot-runners";
const parentNamespace = "hcce";
const operationLeaseName = "yenhubs-operation-serialization";
const operationId = "a".repeat(32);
const operationLockName = "yenhubs-recovery-operation-lock";
const operationHolder = "root-recovery:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const parentNamespaceUid = "parent-namespace-uid";
const runnerNamespaceUid = "runner-namespace-uid";
const fixtureKeyId = "12345678-1234-4abc-8def-1234567890ab";
const writerNames = ["bot-orchestrator", "coturn", "pgbouncer", "pgbouncer-t", "reticulum"];
const signedExecutionTimeoutMs = 90_000;
// Separate from execution: allow both real, attested 30 s joins plus overhead
// before identity-safe fallback. This does not exercise the production 300 s join.
const signedCleanupTimeoutMs = 100_000;
// Only the new opt-in lane uses this orchestration. Every validator, starter,
// boundary, stop and identity-safe discard comes from the complete real library.
const signedShellLifecycle = String.raw`
set -Eeuo pipefail
(( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 1) )) || exit 93
source "$1"
directory="$2" mode="$3"
recovery_process_start_identity "$$" >"$directory/shell-start-identity"
writer_pid= writer_identity= writer_sha= durable_pid= durable_identity= capability=
writer_joined=0 durable_joined=0 writer_rejection=0 durable_rejection=0
cleanup_monitors() {
  local status=$?
  trap - EXIT TERM INT
  recovery_discard_durable_runner_quiescence_monitor "$directory/stop" "$durable_pid" "$durable_identity" || :
  recovery_discard_checkpoint_writer_monitor "$directory/writer-stop" "$writer_pid" "$writer_identity" || :
  return "$status"
}
trap cleanup_monitors EXIT
trap 'exit 143' TERM INT
RECOVERY_BACKUP_AUTHORITY_KEYRING="$directory/keyring"
RECOVERY_BACKUP_AUTHORITY_KEY_ID=12345678-1234-4abc-8def-1234567890ab
RECOVERY_BACKUP_AUTHORITY_JSON="$(jq -cS .authority "$directory/signed-material.json")"
RECOVERY_CONSUMER_CONTRACT_JSON="$(<"$directory/consumers.json")"
RECOVERY_OPERATION_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
RECOVERY_OPERATION_OWNER=checkpoint-backup RECOVERY_OPERATION_LOCK_NAME=yenhubs-recovery-operation-lock
RECOVERY_OPERATION_LOCK_UID=operation-lock-uid RECOVERY_OPERATION_LOCK_RESOURCE_VERSION=operation-lock-rv-1
RECOVERY_OPERATION_TOKEN=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
RECOVERY_CHECKPOINT_STAMP=20261004-120000
RECOVERY_DUMP_SHA256="$(jq -r .lock_binding.dump_sha256 "$directory/signed-material.json")"
RECOVERY_STORAGE_SHA256="$RECOVERY_DUMP_SHA256"
recovery_validate_backup_authority_selection
recovery_require_local_fixture_attestation
parent_identity="$(recovery_process_start_identity "$STUB_TEST_PARENT_PID")"
recovery_adopt_parent_operation_serialization root-recovery:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa \
  operation-lease-uid "$STUB_TEST_PARENT_PID" "$parent_identity"
recovery_require_operation_lock
contract_sha="$(recovery_sha256_digest "$directory/consumers.json")"
durable_sha="$(recovery_sha256_digest "$directory/fences.json")"
recovery_start_checkpoint_writer_monitor "$directory/consumers.json" "$contract_sha" "$directory/writer-controls.json" \
  "$directory/writer-stop" "$directory/writer-failure" "$directory/writer-ready" "$directory/writer-progress" \
  "$directory/writer-final" writer_pid writer_identity writer_sha durable-v2 checkpoint-backup
jq -cn --argjson pid "$writer_pid" --arg identity "$writer_identity" \
  '{writer:{pid:$pid,start_identity:$identity}}' >"$directory/monitor-identities.json"
recovery_start_durable_runner_quiescence_monitor "$directory/fences.json" "$durable_sha" \
  "$directory/writer-controls.json" "$writer_sha" "$directory/stop" "$directory/failure" "$directory/ready" \
  "$directory/progress" "$directory/final" durable_pid durable_identity capability checkpoint-backup
jq -cn --argjson writer_pid "$writer_pid" --arg writer_identity "$writer_identity" \
  --argjson durable_pid "$durable_pid" --arg durable_identity "$durable_identity" \
  '{writer:{pid:$writer_pid,start_identity:$writer_identity},durable:{pid:$durable_pid,start_identity:$durable_identity}}' \
  >"$directory/monitor-identities.json"
if [[ "$mode" == signed-watchdog ]]; then
  # Retain the wrapper pipes as well as both real READY monitors. The external
  # watchdog must preserve its timeout and clean this owned child after EXIT.
  "$STUB_TEST_NODE" -e 'setInterval(() => {}, 1000)' &
  pipe_pid=$!
  pipe_identity="$(recovery_process_start_identity "$pipe_pid")"
  jq -cn --argjson pid "$pipe_pid" --arg identity "$pipe_identity" \
    '{pid:$pid,start_identity:$identity}' >"$directory/pipe-holder.json"
  while :; do sleep 0.1; done
elif [[ "$mode" == signed-selector-drift ]]; then
  RECOVERY_BACKUP_AUTHORITY_KEY_ID=87654321-4321-4abc-8def-1234567890ab
  recovery_require_checkpoint_writer_monitor_healthy "$directory/consumers.json" "$contract_sha" \
    "$directory/writer-controls.json" "$writer_sha" "$directory/writer-failure" "$directory/writer-ready" \
    "$writer_pid" "$writer_identity" durable-v2 checkpoint-backup || writer_rejection=$?
  recovery_require_durable_runner_quiescence_monitor_healthy "$directory/fences.json" "$durable_sha" \
    "$directory/writer-controls.json" "$writer_sha" "$directory/failure" "$directory/ready" "$directory/progress" \
    "$durable_pid" "$durable_identity" "$capability" checkpoint-backup || durable_rejection=$?
  [[ "$writer_rejection" == 1 && "$durable_rejection" == 1 ]]
  RECOVERY_BACKUP_AUTHORITY_KEY_ID=12345678-1234-4abc-8def-1234567890ab
  recovery_discard_durable_runner_quiescence_monitor "$directory/stop" "$durable_pid" "$durable_identity"
  recovery_discard_checkpoint_writer_monitor "$directory/writer-stop" "$writer_pid" "$writer_identity"
else
  recovery_stop_durable_runner_quiescence_monitor "$directory/fences.json" "$durable_sha" \
    "$directory/writer-controls.json" "$writer_sha" "$directory/stop" "$directory/failure" "$directory/ready" \
    "$directory/progress" "$directory/final" "$durable_pid" "$durable_identity" "$capability" durable_joined checkpoint-backup
  recovery_stop_checkpoint_writer_monitor "$directory/consumers.json" "$contract_sha" "$directory/writer-controls.json" \
    "$writer_sha" "$directory/writer-stop" "$directory/writer-failure" "$directory/writer-ready" "$directory/writer-final" \
    "$writer_pid" "$writer_identity" writer_joined durable-v2 checkpoint-backup
  [[ "$writer_joined" == ok && "$durable_joined" == ok ]]
fi
for pid in "$writer_pid" "$durable_pid"; do
  if kill -0 "$pid" 2>/dev/null || kill -0 -- "-$pid" 2>/dev/null; then exit 1; fi
done
jq -cn --arg writer_joined "$writer_joined" --arg durable_joined "$durable_joined" \
  --argjson writer_rejection "$writer_rejection" --argjson durable_rejection "$durable_rejection" \
  '{writer_joined:$writer_joined,durable_joined:$durable_joined,writer_rejection:$writer_rejection,durable_rejection:$durable_rejection}' \
  >"$directory/shell-result.json"
`;
// Teardown alone may revoke still-live fixture identities after the full EXIT
// grace. It sources the complete library and never signals a historical PGID.
const signedCleanupLifecycle = String.raw`
set -uo pipefail
source "$1"
directory="$2" shell_pid="$3" status=0
stop_owned() {
  local pid="$1" identity="$2"
  [[ "$pid" =~ ^[1-9][0-9]*$ && -n "$identity" ]] || { status=1; return; }
  if recovery_process_identity_is_live "$pid" "$identity"; then
    recovery_stop_process_group "$pid" "$identity" || status=1
  elif kill -0 "$pid" 2>/dev/null; then
    status=1
  fi
}
for record in "$directory/monitor-identities.json" "$directory/ready.authority.json" \
    "$directory/writer-ready.authority.json" "$directory/pipe-holder.json"; do
  [[ -s "$record" ]] || continue
  while IFS=$'\t' read -r pid identity; do
    stop_owned "$pid" "$identity"
  done < <(jq -er 'if has("pid") then [.pid,.start_identity] else .[] | [.pid,.start_identity] end | @tsv' "$record")
done
if [[ -s "$directory/watch-identities" ]]; then
  while IFS=$'\t' read -r pid identity; do
    stop_owned "$pid" "$identity"
  done < <(jq -er '[.pid,.start_identity] | @tsv' "$directory/watch-identities")
fi
if [[ -s "$directory/shell-start-identity" ]]; then
  stop_owned "$shell_pid" "$(<"$directory/shell-start-identity")"
elif kill -0 "$shell_pid" 2>/dev/null; then
  status=1
fi
exit "$status"
`;
const identity = {
  roomKey: "11111111111111111111",
  processGeneration: "11111111-1111-4111-8111-111111111111",
  name: "bot-runner-1111111111111111-11111111"
};

function fencePod(resourceVersion = "fence-rv-1") {
  return {
    ...guardPodDocumentForIdentity(identity, "fence", runnerNamespace),
    metadata: {
      ...guardPodDocumentForIdentity(identity, "fence", runnerNamespace).metadata,
      uid: "fence-uid-1",
      resourceVersion
    },
    status: { phase: "Pending" }
  };
}

function transientFencePod(resourceVersion = "transient-fence-rv-1") {
  const transientIdentity = {
    roomKey: "22222222222222222222",
    processGeneration: "22222222-2222-4222-8222-222222222222",
    name: "bot-runner-2222222222222222-22222222"
  };
  const pod = guardPodDocumentForIdentity(
    transientIdentity, "fence", runnerNamespace
  );
  return {
    ...pod,
    metadata: {
      ...pod.metadata,
      uid: "transient-fence-uid-1",
      resourceVersion
    },
    status: { phase: "Pending" }
  };
}

function parentPod(resourceVersion = "parent-rv-1") {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "hubs-safe-pod",
      namespace: parentNamespace,
      uid: "parent-uid-1",
      resourceVersion,
      labels: { app: "hubs" }
    },
    spec: { serviceAccountName: "default", containers: [{ name: "hubs" }] }
  };
}

const baselineRecord = {
  name: identity.name,
  uid: "fence-uid-1",
  room_key: identity.roomKey,
  process_generation: identity.processGeneration,
  state: "fenced"
};
const baseline = {
  canonical: JSON.stringify([baselineRecord]),
  fences: [baselineRecord],
  sha256: ""
};
test("fresh named control LIST accepts old object RV and omitted item TypeMeta", () => {
  const descriptor={key:"parent_namespace",name:"hcce"};
  const item={metadata:{name:"hcce",uid:"same-uid",resourceVersion:"old-object-rv"}};
  const list={apiVersion:"v1",kind:"NamespaceList",metadata:{resourceVersion:"fresh-list-rv"},items:[item]};
  assert.deepEqual(controlResourceFromList(list,descriptor),{...item,apiVersion:"v1",kind:"Namespace"});
  for(const mutate of [x=>x.metadata.continue="next",x=>x.items=[],x=>x.items.push(item),x=>x.items[0].metadata.name="other",x=>x.kind="PodList",x=>x.items[0].kind="Pod"]){
    const bad=structuredClone(list);mutate(bad);assert.throws(()=>controlResourceFromList(bad,descriptor));
  }
});
baseline.sha256 = crypto.createHash("sha256").update(baseline.canonical).digest("hex");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function microsecondTimestamp(time = Date.now()) {
  return new Date(time).toISOString().replace(/(\.\d{3})Z$/u, "$1000Z");
}

function namespaceResource(name, uid, resourceVersion) {
  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name,
      uid,
      resourceVersion,
      labels: { "kubernetes.io/metadata.name": name }
    },
    status: { phase: "Active" }
  };
}

function controlFixture(
  context = "fixture-context",
  mutateBaseline = null,
  operationOwner = "checkpoint-backup"
) {
  const policy = JSON.parse(fs.readFileSync(path.join(
    root, "tests/recovery/fixtures/recovery-operation-pod-fence-policy.json"
  ), "utf8"));
  const parentWriterVariable = policy.spec.variables.find(variable =>
    variable.name === "isParentWriterCreate"
  );
  if (!parentWriterVariable) throw new Error("fixture_policy_parent_writer_variable_missing");
  if (!parentWriterVariable.expression.includes("!has(request.subResource)")) {
    parentWriterVariable.expression = parentWriterVariable.expression.replace(
      "request.subResource == ''",
      "(!has(request.subResource) || request.subResource == '')"
    );
  }
  const binding = JSON.parse(fs.readFileSync(path.join(
    root, "tests/recovery/fixtures/recovery-operation-pod-fence-binding.json"
  ), "utf8"));
  const acquireTime = microsecondTimestamp(Date.now() - 5_000);
  const parent = namespaceResource(parentNamespace, parentNamespaceUid, "parent-namespace-rv-1");
  const runner = namespaceResource(runnerNamespace, runnerNamespaceUid, "runner-namespace-rv-1");
  const operationLock = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: operationLockName,
      namespace: parentNamespace,
      uid: "operation-lock-uid",
      resourceVersion: "operation-lock-rv-1",
      labels: { "yenhubs.org/recovery-owner": operationOwner },
      annotations: { "yenhubs.org/operation-id": operationId }
    },
    immutable: true
  };
  const lease = {
    apiVersion: "coordination.k8s.io/v1",
    kind: "Lease",
    metadata: {
      name: operationLeaseName,
      namespace: parentNamespace,
      uid: "operation-lease-uid",
      resourceVersion: "operation-lease-rv-1",
      labels: { "yenhubs.org/operation-serialization": "deployment-recovery" }
    },
    spec: {
      acquireTime,
      holderIdentity: operationHolder,
      leaseDurationSeconds: 120,
      leaseTransitions: 0,
      renewTime: microsecondTimestamp()
    }
  };
  const controlBaseline = {
    schema_version: 3,
    runtime_generation: "durable-v2",
    recovery_operation_fence: {
      namespaces: {
        parent: {
          name: parentNamespace,
          uid: parentNamespaceUid,
          resource_version: parent.metadata.resourceVersion,
          phase: "Active",
          metadata_name_label: parentNamespace
        },
        runner: {
          name: runnerNamespace,
          uid: runnerNamespaceUid,
          resource_version: runner.metadata.resourceVersion,
          phase: "Active",
          metadata_name_label: runnerNamespace
        }
      },
      policy: {
        uid: policy.metadata.uid,
        resource_version: policy.metadata.resourceVersion,
        generation: policy.metadata.generation,
        spec_sha256: digest(canonicalJson(policy.spec))
      },
      binding: {
        uid: binding.metadata.uid,
        resource_version: binding.metadata.resourceVersion,
        spec_sha256: digest(canonicalJson(binding.spec))
      }
    },
    operation_id: operationId,
    operation_owner: operationOwner,
    operation_lock: {
      name: operationLockName,
      uid: operationLock.metadata.uid,
      resource_version: operationLock.metadata.resourceVersion
    },
    context,
    namespace: parentNamespace,
    namespace_uid: parentNamespaceUid,
    lease: {
      name: operationLeaseName,
      uid: lease.metadata.uid,
      holder: operationHolder,
      acquire_time: acquireTime,
      lease_transitions: 0
    },
    storage_helper: {},
    consumers: [],
    deployments: [],
    replica_sets: [],
    pods: [],
    boundaries: {}
  };
  if (mutateBaseline) mutateBaseline(controlBaseline);
  const text = `${JSON.stringify(controlBaseline)}\n`;
  return {
    baseline: controlBaseline,
    text,
    sha256: digest(text),
    resources: { parent, runner, policy, binding, operationLock, lease }
  };
}

function monitorCapabilityDigest(control) {
  const fence = control.baseline.recovery_operation_fence;
  return digest(canonicalJson({
    schema_version: 1,
    context: control.baseline.context,
    parent_namespace: fence.namespaces.parent,
    runner_namespace: fence.namespaces.runner,
    operation_id: control.baseline.operation_id,
    operation_owner: control.baseline.operation_owner,
    operation_lock: control.baseline.operation_lock,
    lease: control.baseline.lease,
    policy: fence.policy,
    binding: fence.binding,
    durable_fence_baseline_sha256: baseline.sha256,
    control_baseline_sha256: control.sha256
  }));
}

function event(type, object) {
  return `${JSON.stringify({ type, object })}\n`;
}

function boundary(resourceVersion) {
  return {
    apiVersion: "meta.k8s.io/v1",
    kind: "PartialObjectMetadata",
    metadata: { resourceVersion }
  };
}

function podList(namespace, resourceVersion, items) {
  return {
    apiVersion: "v1",
    kind: "PodList",
    metadata: { resourceVersion },
    items: items.map(item => ({
      ...item,
      metadata: { ...item.metadata, namespace }
    }))
  };
}

function freshPodState() {
  return podWatchStateFromLists(
    podList(parentNamespace, "parent-list-rv", [parentPod()]),
    podList(runnerNamespace, "runner-list-rv", [fencePod()]),
    parentNamespace,
    runnerNamespace,
    baseline
  );
}

function freshPodDescriptor(key) {
  return freshPodState().descriptors.find(descriptor => descriptor.key === key);
}

test("classic Pod Watch query carries only the retained exact cursor", () => {
  const rawPath = podWatchRawPath(runnerNamespace, "opaque/rv:1");
  const parsed = new URL(`https://fixture.invalid${rawPath}`);
  assert.equal(parsed.pathname, "/api/v1/namespaces/hcce-bot-runners/pods");
  assert.equal(parsed.searchParams.get("watch"), "true");
  assert.equal(parsed.searchParams.get("allowWatchBookmarks"), "true");
  assert.equal(parsed.searchParams.has("sendInitialEvents"), false);
  assert.equal(parsed.searchParams.has("resourceVersionMatch"), false);
  assert.equal(parsed.searchParams.get("resourceVersion"), "opaque/rv:1");
  assert.equal(parsed.searchParams.get("timeoutSeconds"), "30");
});

test("successor Pod streaming-list query requires an exact initial-events boundary", () => {
  const rawPath = podInitialWatchRawPath(runnerNamespace, "opaque/rv:2");
  const parsed = new URL(`https://fixture.invalid${rawPath}`);
  assert.equal(parsed.pathname, "/api/v1/namespaces/hcce-bot-runners/pods");
  assert.equal(parsed.searchParams.get("watch"), "true");
  assert.equal(parsed.searchParams.get("allowWatchBookmarks"), "true");
  assert.equal(parsed.searchParams.get("sendInitialEvents"), "true");
  assert.equal(parsed.searchParams.get("resourceVersionMatch"), "NotOlderThan");
  assert.equal(parsed.searchParams.get("resourceVersion"), "opaque/rv:2");
  assert.equal(parsed.searchParams.get("timeoutSeconds"), "30");
});

test("complete raw parent lists may omit item TypeMeta but reject legacy runners", () => {
  const safe = parentPod();
  delete safe.apiVersion;
  delete safe.kind;
  assert.equal(normalizeCompleteParentList({
    apiVersion: "v1",
    kind: "PodList",
    metadata: { resourceVersion: "parent/list:1" },
    items: [safe]
  }, parentNamespace), "parent/list:1");
  const legacy = parentPod();
  legacy.spec.serviceAccountName = "bot-orchestrator";
  assert.throws(() => normalizeCompleteParentList({
    apiVersion: "v1",
    kind: "PodList",
    metadata: { resourceVersion: "parent/list:2" },
    items: [legacy]
  }, parentNamespace), /legacy_parent_runner_present/);
  for (const metadata of [
    { resourceVersion: "parent/list:3", continue: "next-page" },
    { resourceVersion: "parent/list:4", remainingItemCount: 1 }
  ]) {
    assert.throws(() => normalizeCompleteParentList({
      apiVersion: "v1",
      kind: "PodList",
      metadata,
      items: [parentPod()]
    }, parentNamespace), /parent_list_contract/);
  }
});

test("runner classic Watch retains its cursor across status-only modification", () => {
  const descriptor = freshPodDescriptor("runner");
  const modified = fencePod("fence/status:2");
  modified.status = { phase: "Pending", conditions: [{ type: "PodScheduled", status: "False" }] };
  descriptor.cursor = validatePodWatchStream(event("MODIFIED", modified), descriptor);
  assert.equal(descriptor.cursor, "fence/status:2");
  descriptor.cursor = validatePodWatchStream(
    event("BOOKMARK", boundary("runner/boundary:1")), descriptor
  );
  assert.equal(descriptor.cursor, "runner/boundary:1");
});

test("runner classic Watch rejects transient creation, deletion and identity drift", () => {
  assert.throws(() => validatePodWatchStream(
    event("ADDED", fencePod("fence/new:2")), freshPodDescriptor("runner")
  ), /durable_runner_watch_violation/);
  assert.throws(() => validatePodWatchStream(
    event("DELETED", fencePod("fence/deleted:2")), freshPodDescriptor("runner")
  ), /durable_runner_watch_violation/);
  const drifted = fencePod("fence/drift:2");
  drifted.metadata.uid = "replacement-fence-uid";
  assert.throws(() => validatePodWatchStream(
    event("MODIFIED", drifted), freshPodDescriptor("runner")
  ), /durable_runner_watch_violation/);
});

test("classic Watch preserves an idle cursor and rejects 410 or a legacy parent event", () => {
  const idle = freshPodDescriptor("runner");
  assert.equal(validatePodWatchStream("", idle), "runner-list-rv");
  assert.throws(() => validatePodWatchStream(event("ERROR", {
    apiVersion: "v1", kind: "Status", code: 410, metadata: {}
  }), freshPodDescriptor("runner")), /durable_runner_watch_resource_version_expired/);
  const legacy = parentPod("legacy:2");
  legacy.metadata.labels = { app: "bot-runner" };
  assert.throws(() => validatePodWatchStream(
    event("ADDED", legacy), freshPodDescriptor("parent")
  ),
    /legacy_parent_runner_present/);
});

function privateFile(filePath, contents = "") {
  fs.writeFileSync(filePath, contents, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

async function waitFor(predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("fixture_timeout");
}

function runMonitorFixture(mode = "success", options = {}) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "yenhubs-durable-monitor."));
  fs.chmodSync(directory, 0o700);
  const context = options.context || "fixture-context";
  const control = controlFixture(
    options.controlContext || context,
    options.mutateControlBaseline || null,
    options.operationOwner ?? "checkpoint-backup"
  );
  let signed = null;
  if (options.shellStarters) {
    assert.equal(context, "fixture-context");
    assert.equal(options.operationOwner ?? "checkpoint-backup", "checkpoint-backup");
    control.resources.parent.metadata.uid = "fixture-uid";
    const keyringPath = path.join(directory, "keyring");
    fs.mkdirSync(keyringPath, { mode: 0o700 });
    privateFile(path.join(keyringPath, `${fixtureKeyId}.json`), canonicalJson(createKeyRecord({
      keyId: fixtureKeyId, keyBytes: Buffer.alloc(32, 0x6a)
    })));
    const deploymentNames = ["bot-orchestrator", "coturn", "dialog", "haproxy", "hubs", "nearspark",
      "pgbouncer", "pgbouncer-t", "pgsql", "photomnemonic", "reticulum", "spoke"];
    const deployments = deploymentNames.map(name => ({ apiVersion: "apps/v1", kind: "Deployment",
      metadata: { name, namespace: parentNamespace, uid: `${name}-uid`, resourceVersion: `${name}-rv`, generation: 4,
        labels: { app: name } },
      spec: { replicas: 0, selector: { matchLabels: { app: name } }, strategy: { type: "Recreate" },
        template: { metadata: { labels: { app: name } }, spec: { containers: [{ name,
          image: `example.invalid/${name}@sha256:${"1".repeat(64)}`,
          env: [{ name: "SYNTHETIC_PRIVATE_INPUT", value: "signed-monitor-private-payload-sentinel" }] }] } } } }));
    const replicaSets = deployments.map(deployment => ({ apiVersion: "apps/v1", kind: "ReplicaSet",
      metadata: { name: `rs-${deployment.metadata.name}`, namespace: parentNamespace,
        uid: `rs-${deployment.metadata.uid}`, resourceVersion: `rs-${deployment.metadata.resourceVersion}`, generation: 1,
        ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", controller: true,
          name: deployment.metadata.name, uid: deployment.metadata.uid }] },
      spec: { replicas: 0, selector: clone(deployment.spec.selector), template: clone(deployment.spec.template) } }));
    const lockBinding = { name: operationLockName, namespace: parentNamespace, owner: "checkpoint-backup",
      operation_id: operationId, recovery_token: "b".repeat(32), namespace_uid: "fixture-uid",
      pvc_uid: "fixture-pvc-uid", checkpoint_stamp: "20261004-120000", dump_sha256: "0".repeat(64), storage_sha256: "0".repeat(64) };
    const { parent, runner, policy, binding } = control.resources;
    const dormantSpec = clone(binding.spec);
    dormantSpec.matchResources.namespaceSelector = { matchExpressions: [{
      key: "kubernetes.io/metadata.name", operator: "DoesNotExist"
    }] };
    const publicAuthority = { schema_version: 2, operation_id: operationId,
      namespace: { name: parentNamespace, uid: "fixture-uid" }, pvc: { name: "ret-pvc", uid: "fixture-pvc-uid" },
      hmac_profile: "yenhubs-checkpoint-backup-authority-hmac-v2", hmac_key_id: fixtureKeyId, runner_generation: "durable-v2",
      operation_fence: { state: "dormant", namespaces: Object.fromEntries(Object.entries({ parent, runner }).map(([key, resource]) =>
        [key, { name: resource.metadata.name, uid: resource.metadata.uid, initial_resource_version: resource.metadata.resourceVersion,
          phase: resource.status.phase, metadata_name_label: resource.metadata.name }])),
        policy: { uid: policy.metadata.uid, initial_resource_version: policy.metadata.resourceVersion,
          initial_generation: policy.metadata.generation, spec_sha256: digest(canonicalJson(policy.spec)) },
        binding: { uid: binding.metadata.uid, initial_resource_version: "dormant-binding-rv",
          dormant_spec_sha256: digest(canonicalJson(dormantSpec)), active_spec_sha256: digest(canonicalJson(binding.spec)) } },
      consumers: writerNames.map(name => ({ name, uid: `${name}-uid`, initial_resource_version: `${name}-rv`,
        initial_generation: 4, original_replicas: 0, selector: name })) };
    const authority = createCheckpointBackupAuthorityV2({ keyringPath, keyId: fixtureKeyId, publicAuthority, lockBinding,
      deploymentContracts: deployments.filter(value => writerNames.includes(value.metadata.name)).map(value => ({
        api_version: "apps/v1", kind: "Deployment", namespace: parentNamespace, name: value.metadata.name,
        uid: value.metadata.uid, spec_without_replicas: Object.fromEntries(Object.entries(value.spec).filter(([key]) => key !== "replicas")) })) });
    const authorityText = canonicalJson(authority);
    const consumerContract = { schema_version: 3, operation_id: operationId,
      authority_sha256: digest(authorityText), consumers: authority.consumers };
    Object.assign(control.resources.operationLock.metadata.annotations, Object.fromEntries([
      ["recovery-token", lockBinding.recovery_token], ["namespace-uid", lockBinding.namespace_uid],
      ["pvc-uid", lockBinding.pvc_uid], ["checkpoint-stamp", lockBinding.checkpoint_stamp],
      ["dump-sha256", lockBinding.dump_sha256], ["storage-sha256", lockBinding.storage_sha256]
    ].map(([key, value]) => [`yenhubs.org/${key}`, value])));
    control.resources.operationLock.data = { "checkpoint-backup-authority.json": authorityText };
    privateFile(path.join(directory, "signed-material.json"), canonicalJson({ authority, lock_binding: lockBinding }));
    privateFile(path.join(directory, "consumers.json"), `${canonicalJson(consumerContract)}\n`);
    signed = { keyringPath, consumerContract, deployments, replicaSets };
  }
  const baselinePath = path.join(directory, "fences.json");
  const controlBaselinePath = path.join(directory, "writer-controls.json");
  const stopPath = path.join(directory, "stop");
  const failurePath = path.join(directory, "failure");
  const readyPath = path.join(directory, "ready");
  const progressPath = path.join(directory, "progress");
  const finalPath = path.join(directory, "final");
  const authorityPath = `${readyPath}.authority.json`;
  const descendantPath = path.join(directory, "descendant-pid");
  const leaseGetCountPath = path.join(directory, "lease-get-count");
  const parentListCountPath = path.join(directory, "parent-list-count");
  const runnerListCountPath = path.join(directory, "runner-list-count");
  const parentWatchCountPath = path.join(directory, "parent-watch-count");
  const runnerWatchCountPath = path.join(directory, "runner-watch-count");
  const watchPidPath = path.join(directory, "watch-pids");
  const controlWatchCountPrefix = path.join(directory, "control-watch-count");
  const podWatchLogPath = path.join(directory, "pod-watch-log");
  const watchGatePath = path.join(directory, "watch-gate");
  const watchReleasePath = path.join(directory, "watch-release");
  const kubectlPath = path.join(directory, "kubectl-fixture.mjs");
  const apiReadLogPath = path.join(directory, "api-read-log");
  const monitorIdentityPath = path.join(directory, "monitor-identities.json");
  const shellResultPath = path.join(directory, "shell-result.json");
  const leaseHistoryPath = path.join(directory, "lease-history.json");
  const leaseWatchLogPath = path.join(directory, "lease-watch-log");
  const watchIdentityPath = path.join(directory, "watch-identities");
  const shellIdentityPath = path.join(directory, "shell-start-identity");
  const pipeHolderPath = path.join(directory, "pipe-holder.json");
  const writerPaths = Object.fromEntries(["stop", "failure", "ready", "progress", "final"]
    .map(name => [name, path.join(directory, `writer-${name}`)]));
  privateFile(baselinePath, baseline.canonical);
  privateFile(controlBaselinePath, options.shellStarters ? "" : control.text);
  for (const marker of [stopPath, failurePath, readyPath, progressPath, finalPath]) {
    privateFile(marker);
  }
  if (options.shellStarters) {
    for (const marker of [...Object.values(writerPaths), monitorIdentityPath, shellResultPath, apiReadLogPath,
      leaseWatchLogPath, watchIdentityPath, shellIdentityPath, pipeHolderPath]) privateFile(marker);
    // Only this timer owns renewal. Readers consume an atomic snapshot; they
    // cannot renew, synthesize a future timestamp or skip a cursor's history.
    signed.leaseHistory = [clone(control.resources.lease)];
    const publishLeaseHistory = () => {
      const temporary = `${leaseHistoryPath}.next`;
      privateFile(temporary, canonicalJson({ owner_pid: process.pid, history: signed.leaseHistory }));
      fs.renameSync(temporary, leaseHistoryPath);
    };
    publishLeaseHistory();
    signed.leaseOwner = setInterval(() => {
      const renewed = clone(signed.leaseHistory.at(-1));
      renewed.metadata.resourceVersion = `operation-lease-rv-${signed.leaseHistory.length + 1}`;
      renewed.spec.renewTime = microsecondTimestamp();
      signed.leaseHistory.push(renewed);
      publishLeaseHistory();
    }, 10_000);
  }
  fs.writeFileSync(kubectlPath, `#!/usr/bin/env node
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const rawIndex = args.indexOf("--raw");
const raw = rawIndex === -1 ? "" : args[rawIndex + 1];
const context = args[args.indexOf("--context") + 1] || "";
const fence = JSON.parse(process.env.STUB_FENCE_JSON);
const parent = JSON.parse(process.env.STUB_PARENT_JSON);
const controls = JSON.parse(process.env.STUB_CONTROLS_JSON);
const renewedLease = JSON.parse(process.env.STUB_RENEWED_LEASE_JSON);
const transientRunner = JSON.parse(process.env.STUB_TRANSIENT_RUNNER_JSON);
const legacyParent = JSON.parse(process.env.STUB_LEGACY_PARENT_JSON);
const shellStarters = process.env.STUB_SHELL_STARTERS === "1";
function leaseHistory() {
  const state = JSON.parse(fs.readFileSync(process.env.STUB_LEASE_HISTORY_PATH, "utf8"));
  if (state.owner_pid !== Number(process.env.STUB_TEST_PARENT_PID) || !Array.isArray(state.history) || !state.history.length) process.exit(47);
  return state.history;
}
if (shellStarters) controls.lease = leaseHistory().at(-1);
if (shellStarters) {
  fs.appendFileSync(process.env.STUB_API_READ_LOG_PATH, JSON.stringify(args) + "\\n");
  if (args.includes("config") && args.includes("current-context")) {
    process.stdout.write("fixture-context"); process.exit(0);
  }
  if (context !== "fixture-context" || !args.includes("get")) process.exit(44);
  if (rawIndex === -1) {
    const index = args.indexOf("get"), kind = args[index + 1], name = args[index + 2];
    const fixed = { namespace: name === "hcce" ? controls.parent : name === "hcce-bot-runners" ? controls.runner : null,
      pvc: name === "ret-pvc" ? { apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: { name, uid: "fixture-pvc-uid" } } : null,
      configmap: name === "yenhubs-recovery-operation-lock" ? controls.operationLock : null,
      lease: name === "yenhubs-operation-serialization" ? controls.lease : null,
      validatingadmissionpolicy: controls.policy, validatingadmissionpolicybinding: controls.binding };
    const resource = kind === "deployment"
      ? JSON.parse(process.env.STUB_DEPLOYMENTS_JSON).find(value => value.metadata.name === name) : fixed[kind];
    if (!resource || resource.metadata.name !== name) process.exit(45);
    const output = args[args.indexOf("-o") + 1];
    if (output === "jsonpath={.metadata.uid}") process.stdout.write(resource.metadata.uid);
    else if (output === "json") process.stdout.write(JSON.stringify(resource));
    else process.exit(46);
    process.exit(0);
  }
}
const url = new URL(raw, "https://fixture.invalid");
const pathname = url.pathname;
const isWatch = url.searchParams.get("watch") === "true";
if (isWatch) {
  fs.appendFileSync(process.env.STUB_WATCH_PID_PATH, String(process.pid) + "\\n");
  if (shellStarters) {
    const identity = spawnSync(process.env.STUB_TEST_BASH, ["-c",
      'source "$1"; recovery_process_start_identity "$2"', "_", process.env.STUB_RECOVERY_LIBRARY, String(process.pid)],
      { encoding: "utf8", timeout: 2_000 });
    if (identity.status !== 0 || identity.stderr || !/^(?:darwin:|linux:)/u.test(identity.stdout)) process.exit(48);
    fs.appendFileSync(process.env.STUB_WATCH_IDENTITY_PATH,
      JSON.stringify({ pid: process.pid, start_identity: identity.stdout.trim() }) + "\\n");
  }
}
const isPodCollection = /^\\/api\\/v1\\/namespaces\\/([^/]+)\\/pods$/u.exec(pathname);
const isRunner = isPodCollection && decodeURIComponent(isPodCollection[1]) === "hcce-bot-runners";
const podRv = isRunner ? "runner-list-rv" : "parent-list-rv";
const writerCollection = /^\\/apis\\/apps\\/v1\\/namespaces\\/hcce\\/(deployments|replicasets)$/u.exec(pathname);

function nextInvocation(counterPath, record = "call") {
  let count = 0;
  try {
    const text = fs.readFileSync(counterPath, "utf8").trim();
    count = text ? text.split("\\n").length : 0;
  } catch {}
  fs.appendFileSync(counterPath, record + "\\n");
  return count + 1;
}

function controlKey(name = "") {
  if (pathname === "/api/v1/namespaces") {
    if (name === "hcce") return "parent";
    if (name === "hcce-bot-runners") return "runner";
  }
  if (pathname === "/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicies") {
    return "policy";
  }
  if (pathname === "/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicybindings") {
    return "binding";
  }
  if (pathname === "/api/v1/namespaces/hcce/configmaps") return "operationLock";
  if (pathname === "/apis/coordination.k8s.io/v1/namespaces/hcce/leases") return "lease";
  const getPaths = {
    "/api/v1/namespaces/hcce": "parent",
    "/api/v1/namespaces/hcce-bot-runners": "runner",
    "/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicies/recovery-operation-pod-fence.yenhubs.org": "policy",
    "/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicybindings/recovery-operation-pod-fence.yenhubs.org": "binding",
    "/api/v1/namespaces/hcce/configmaps/yenhubs-recovery-operation-lock": "operationLock",
    "/apis/coordination.k8s.io/v1/namespaces/hcce/leases/yenhubs-operation-serialization": "lease"
  };
  return getPaths[pathname] || null;
}

function bookmark(resourceVersion, initial = false) {
  const metadata = { resourceVersion };
  if (initial) metadata.annotations = { "k8s.io/initial-events-end": "true" };
  return JSON.stringify({
    type: "BOOKMARK",
    object: {
      apiVersion: initial ? "v1" : "meta.k8s.io/v1",
      kind: initial ? "Pod" : "PartialObjectMetadata",
      metadata
    }
  }) + "\\n";
}

function gateOrHangWatch() {
  if (["hang-watch", "leader-exits-watch", "leader-spontaneous-watch"].includes(
    process.env.STUB_MODE
  )) {
    process.on("SIGTERM", () => {
      if (process.env.STUB_MODE === "leader-exits-watch") process.exit(0);
    });
    const descendant = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      { stdio: "ignore" }
    );
    fs.appendFileSync(process.env.STUB_DESCENDANT_PATH, String(descendant.pid) + "\\n");
    if (process.env.STUB_MODE === "leader-spontaneous-watch") process.exit(0);
    setInterval(() => {}, 1000);
    return true;
  }
  return false;
}

if (shellStarters && writerCollection) {
  const resource = writerCollection[1];
  if (isWatch) process.stdout.write(bookmark(url.searchParams.get("resourceVersion")));
  else process.stdout.write(JSON.stringify({ apiVersion: "apps/v1",
    kind: resource === "deployments" ? "DeploymentList" : "ReplicaSetList",
    metadata: { resourceVersion: "writer-" + resource + "-list-rv" },
    items: JSON.parse(process.env[resource === "deployments" ? "STUB_DEPLOYMENTS_JSON" : "STUB_REPLICASETS_JSON"]) }));
  process.exit(0);
}
if (shellStarters && isWatch && isPodCollection && !isRunner &&
    url.searchParams.get("sendInitialEvents") !== "true") {
  // The writer's finite classic Watch uses the product's attested local-fixture
  // bookmark allowance; durable streaming-list watches retain their existing path.
  process.stdout.write(bookmark(url.searchParams.get("resourceVersion")));
  process.exit(0);
}

if (!isWatch && isPodCollection) {
  const listIndex = nextInvocation(
    isRunner ? process.env.STUB_RUNNER_LIST_COUNT_PATH : process.env.STUB_PARENT_LIST_COUNT_PATH
  );
  const metadata = {
    resourceVersion: process.env.STUB_MODE === "opaque-numeric-rv"
      ? "900"
      : podRv + "-" + String(listIndex)
  };
  if ((process.env.STUB_MODE === "partial-parent-list" && !isRunner) ||
      (process.env.STUB_MODE === "partial-runner-list" && isRunner)) {
    metadata.continue = "next-page";
    metadata.remainingItemCount = 1;
  }
  if (process.env.STUB_MODE === "truncated-list" && !isRunner) {
    process.stdout.write('{"apiVersion":"v1"');
  } else {
    process.stdout.write(JSON.stringify({apiVersion:"v1",kind:"PodList",metadata,
      items:isRunner ? [fence] : shellStarters ? [] : [parent]}));
  }
  process.exit(0);
}

if (!isWatch) {
  const selectedName = (url.searchParams.get("fieldSelector") || "").replace("metadata.name=", "");
  const key = controlKey(selectedName);
  if (!key) process.exit(41);
  if (shellStarters && key === "lease" && selectedName && selectedName !== controls.lease.metadata.name) process.exit(41);
  let resource = controls[key];
  if (key === "lease" && (["lease-renew", "lease-unobserved"].includes(process.env.STUB_MODE) ||
      process.env.STUB_MODE.startsWith("lease-gap-"))) {
    let count = 0;
    try {
      const text = fs.readFileSync(process.env.STUB_LEASE_GET_COUNT_PATH, "utf8").trim();
      count = text ? text.split("\\n").length : 0;
    } catch {}
    fs.appendFileSync(process.env.STUB_LEASE_GET_COUNT_PATH, "get\\n");
    if (count >= (process.env.STUB_MODE.startsWith("lease-gap-") ? 2 : 1)) resource = renewedLease;
  }
  process.stdout.write(JSON.stringify(selectedName ? {
    apiVersion:resource.apiVersion,kind:resource.kind+"List",
    metadata:{resourceVersion:shellStarters && key === "lease" ? resource.metadata.resourceVersion : "fresh-control-list-rv"},items:[process.env.STUB_MODE === "old-control-rv" ?
      Object.fromEntries(Object.entries(resource).filter(([key]) => !["apiVersion","kind"].includes(key))) : resource]
  } : resource));
  process.exit(0);
}

if (gateOrHangWatch()) {
  await new Promise(() => {});
}
if (process.env.STUB_MODE === "gated-watch") {
  fs.appendFileSync(process.env.STUB_WATCH_GATE_PATH, "watch\\n");
  while (!fs.existsSync(process.env.STUB_WATCH_RELEASE_PATH)) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

if (isPodCollection) {
  const watchIndex = nextInvocation(
    isRunner ? process.env.STUB_RUNNER_WATCH_COUNT_PATH : process.env.STUB_PARENT_WATCH_COUNT_PATH,
    raw
  );
  fs.appendFileSync(
    process.env.STUB_POD_WATCH_LOG_PATH,
    "start " + (isRunner ? "runner" : "parent") + " " + String(watchIndex) +
      " " + raw + "\\n"
  );
  const isInitialStream = url.searchParams.get("sendInitialEvents") === "true";
  if (isRunner && ((watchIndex === 1 && process.env.STUB_MODE === "initial-eof") ||
      (watchIndex === 2 && process.env.STUB_MODE === "successor-eof") ||
      (watchIndex === 3 && process.env.STUB_MODE === "after-ready-eof"))) {
    process.stderr.write("Unable to connect to the server: EOF private-payload-sentinel");
    process.exit(1);
  }
  process.on("SIGTERM", () => {
    if (isRunner && watchIndex === 2 &&
        process.env.STUB_MODE === "runner-event-on-final-drain") {
      const created = JSON.parse(JSON.stringify(transientRunner));
      created.metadata.resourceVersion = "terminal-drain-transient-rv";
      fs.writeSync(1, JSON.stringify({ type: "ADDED", object: created }) + "\\n");
    }
    if (isRunner && watchIndex === 2 &&
        process.env.STUB_MODE === "runner-410-on-final-drain") {
      fs.writeSync(1, JSON.stringify({
        type: "ERROR",
        object: { apiVersion: "v1", kind: "Status", code: 410, metadata: {} }
      }) + "\\n");
    }
    fs.appendFileSync(
      process.env.STUB_POD_WATCH_LOG_PATH,
      "close " + (isRunner ? "runner" : "parent") + " " + String(watchIndex) + "\\n"
    );
    process.exit(0);
  });
  const initialHang = watchIndex === 1 && process.env.STUB_MODE === "initial-hang";
  if (isInitialStream && !initialHang) {
    if (isRunner || !shellStarters) {
      const initialObject = JSON.parse(JSON.stringify(isRunner ? fence : parent));
      initialObject.metadata.resourceVersion = podRv + "-initial-object-" + String(watchIndex);
      if (isRunner && watchIndex === 2 && process.env.STUB_MODE === "successor-state-drift") {
        initialObject.metadata.uid = "successor-replacement-fence-uid";
      }
      process.stdout.write(JSON.stringify({ type: "ADDED", object: initialObject }) + "\\n");
    }
    if (watchIndex === 2 && process.env.STUB_MODE === "successor-close") {
      process.exit(0);
    } else if (watchIndex === 2 && process.env.STUB_MODE === "successor-ordinary-bookmark") {
      process.stdout.write(bookmark(podRv + "-ordinary-" + String(watchIndex)));
    } else if (watchIndex === 2 && process.env.STUB_MODE === "successor-error") {
      process.stdout.write(JSON.stringify({
        type: "ERROR",
        object: { apiVersion: "v1", kind: "Status", code: 500, metadata: {} }
      }) + "\\n");
    } else if (watchIndex === 2 && process.env.STUB_MODE === "successor-410") {
      process.stdout.write(JSON.stringify({
        type: "ERROR",
        object: { apiVersion: "v1", kind: "Status", code: 410, metadata: {} }
      }) + "\\n");
    } else if (watchIndex === 2 && process.env.STUB_MODE === "successor-oversize") {
      process.stdout.write("x".repeat(8 * 1024 * 1024 + 1024));
    } else if (!(
      (watchIndex === 1 && process.env.STUB_MODE === "initial-no-boundary") ||
      (watchIndex === 2 && process.env.STUB_MODE === "successor-no-boundary")
    )) {
      process.stdout.write(bookmark(
        process.env.STUB_MODE === "opaque-numeric-rv"
          ? "1"
          : podRv + "-initial-end-" + String(watchIndex),
        true
      ));
      if (isRunner && watchIndex === 2 && [
        "runner-event-on-final-drain",
        "runner-410-on-final-drain",
        "terminal-binding-drift",
        "terminal-lock-drift",
        "terminal-lease-drift"
      ].includes(process.env.STUB_MODE)) {
        fs.writeFileSync(process.env.STUB_STOP_PATH, "stop\\n", { mode: 0o600 });
      }
    }
  }
  if (
    isRunner &&
    (
      (process.env.STUB_MODE === "runner-excursion-after-initial-list" && watchIndex === 1) ||
      (process.env.STUB_MODE === "runner-excursion-during-handoff" &&
        watchIndex === 2 && isInitialStream) ||
      (process.env.STUB_MODE === "runner-excursion-between-rounds" &&
        watchIndex === 3 && isInitialStream)
    )
  ) {
    const created = JSON.parse(JSON.stringify(transientRunner));
    created.metadata.resourceVersion = "transient-runner-create-rv";
    const deleted = JSON.parse(JSON.stringify(created));
    deleted.metadata.resourceVersion = "transient-runner-delete-rv";
    process.stdout.write(JSON.stringify({ type: "ADDED", object: created }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "DELETED", object: deleted }) + "\\n");
  } else if (
    !isRunner && process.env.STUB_MODE === "parent-excursion-between-rounds" &&
    watchIndex === 3 && isInitialStream
  ) {
    const created = JSON.parse(JSON.stringify(legacyParent));
    created.metadata.resourceVersion = "legacy-parent-create-rv";
    const deleted = JSON.parse(JSON.stringify(created));
    deleted.metadata.resourceVersion = "legacy-parent-delete-rv";
    process.stdout.write(JSON.stringify({ type: "ADDED", object: created }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "DELETED", object: deleted }) + "\\n");
  } else if (
    isRunner && process.env.STUB_MODE === "pod-watch-410" && watchIndex === 1
  ) {
    process.stdout.write(JSON.stringify({
      type: "ERROR",
      object: { apiVersion: "v1", kind: "Status", code: 410, metadata: {} }
    }) + "\\n");
  } else if (!isInitialStream) {
    process.stdout.write(bookmark(podRv + "-watch-rv-" + String(watchIndex)));
  }
  if (context === "fixture-context") {
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  process.exit(0);
}

const selectedName = (url.searchParams.get("fieldSelector") || "").replace("metadata.name=", "");
const key = controlKey(selectedName);
if (!key) process.exit(42);
if (shellStarters && key === "lease") {
  if (selectedName !== controls.lease.metadata.name) process.exit(42);
  const history = leaseHistory(), cursor = url.searchParams.get("resourceVersion");
  const start = history.findIndex(value => value.metadata.resourceVersion === cursor);
  if (start === -1) process.exit(43);
  const replayed = history.slice(start + 1);
  for (const object of replayed) process.stdout.write(JSON.stringify({ type: "MODIFIED", object }) + "\\n");
  const frontier = history.at(-1).metadata.resourceVersion;
  fs.appendFileSync(process.env.STUB_LEASE_WATCH_LOG_PATH,
    JSON.stringify({ cursor, frontier, replayed: replayed.map(value => value.metadata.resourceVersion) }) + "\\n");
  process.stdout.write(bookmark(frontier));
  process.exit(0);
}
const controlWatchIndex = nextInvocation(
  process.env.STUB_CONTROL_WATCH_COUNT_PREFIX + "-" + key
);
if (key === "lease" && controlWatchIndex === 2 && process.env.STUB_MODE.startsWith("lease-gap-")) {
  // The GET sees the renewal after the first Watch closes. Catch-up must
  // replay from that Watch's cursor, never from the newer GET resourceVersion.
  if (url.searchParams.get("resourceVersion") !== "lease-bookmark-rv") process.exit(43);
  if (process.env.STUB_MODE === "lease-gap-expired") {
    process.stdout.write(JSON.stringify({type:"ERROR",object:{apiVersion:"v1",kind:"Status",code:410,metadata:{}}})+"\\n");
    process.exit(0);
  }
  if (process.env.STUB_MODE === "lease-gap-holder-flip") {
    const changed = JSON.parse(JSON.stringify(renewedLease));
    changed.spec.holderIdentity = "root-recovery:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    process.stdout.write(JSON.stringify({type:"MODIFIED",object:changed})+"\\n");
  }
  if (process.env.STUB_MODE !== "lease-gap-unobserved") {
    process.stdout.write(JSON.stringify({type:"MODIFIED",object:renewedLease})+"\\n");
  }
}
if (process.env.STUB_MODE === "old-control-rv" && controlWatchIndex === 1 &&
    url.searchParams.get("resourceVersion") !== "fresh-control-list-rv") {
  process.stdout.write(JSON.stringify({type:"ERROR",object:{apiVersion:"v1",kind:"Status",code:410,metadata:{}}})+"\\n");
  process.exit(0);
}
const terminalDriftKeys = {
  "terminal-binding-drift": "binding",
  "terminal-lock-drift": "operationLock",
  "terminal-lease-drift": "lease"
};
if (controlWatchIndex === 2 && terminalDriftKeys[process.env.STUB_MODE] === key) {
  const changed = JSON.parse(JSON.stringify(controls[key]));
  changed.metadata.resourceVersion = key + "-terminal-drift-rv";
  if (key === "lease") {
    changed.spec.holderIdentity = "root-recovery:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  } else {
    changed.metadata.annotations = { fixture: "terminal-drift" };
  }
  process.stdout.write(JSON.stringify({ type: "MODIFIED", object: changed }) + "\\n");
  process.exit(0);
}
if (process.env.STUB_MODE === "control-watch-410" && key === "binding") {
  process.stdout.write(JSON.stringify({
    type: "ERROR",
    object: { apiVersion: "v1", kind: "Status", code: 410, metadata: {} }
  }) + "\\n");
  process.exit(0);
}
if (process.env.STUB_MODE === "binding-transient" && key === "binding") {
  const dormant = JSON.parse(JSON.stringify(controls.binding));
  dormant.metadata.resourceVersion = "binding-rv-dormant";
  dormant.spec.matchResources.namespaceSelector = {
    matchExpressions: [{
      key: "kubernetes.io/metadata.name",
      operator: "DoesNotExist"
    }]
  };
  const active = JSON.parse(JSON.stringify(controls.binding));
  active.metadata.resourceVersion = "binding-rv-reactivated";
  process.stdout.write(JSON.stringify({ type: "MODIFIED", object: dormant }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "MODIFIED", object: active }) + "\\n");
  process.exit(0);
}
const fixedMutationKeys = {
  "parent-namespace-modified": "parent",
  "policy-modified": "policy",
  "operation-lock-modified": "operationLock"
};
if (fixedMutationKeys[process.env.STUB_MODE] === key) {
  const changed = JSON.parse(JSON.stringify(controls[key]));
  changed.metadata.resourceVersion = key + "-rv-modified";
  changed.metadata.annotations = { fixture: "changed" };
  process.stdout.write(JSON.stringify({ type: "MODIFIED", object: changed }) + "\\n");
  process.exit(0);
}
if (["lease-renew", "lease-holder-flip", "lease-stale-renew"].includes(process.env.STUB_MODE) &&
    key === "lease" && [controls.lease.metadata.resourceVersion,"fresh-control-list-rv"].includes(url.searchParams.get("resourceVersion"))) {
  const changed = JSON.parse(JSON.stringify(renewedLease));
  if (process.env.STUB_MODE === "lease-holder-flip") {
    changed.spec.holderIdentity = "root-recovery:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  }
  if (process.env.STUB_MODE === "lease-stale-renew") {
    changed.spec.renewTime = "2000-01-01T00:00:00.000000Z";
  }
  process.stdout.write(JSON.stringify({ type: "MODIFIED", object: changed }) + "\\n");
}
process.stdout.write(bookmark(key + "-bookmark-rv"));
`, { mode: 0o700 });
  fs.chmodSync(kubectlPath, 0o700);
  if (options.shellStarters) {
    fs.mkdirSync(path.join(directory, "bin"), { mode: 0o700 });
    fs.symlinkSync(kubectlPath, path.join(directory, "bin/kubectl"));
  }
  const monitorArguments = [monitorPath,
    "--context", context,
    "--namespace", parentNamespace,
    "--runner-namespace", runnerNamespace,
    "--baseline", baselinePath,
    "--baseline-sha256", baseline.sha256,
    "--control-baseline", controlBaselinePath,
    "--control-baseline-sha256", options.controlSha256 ?? control.sha256,
    "--stop", stopPath,
    "--failure", failurePath,
    "--ready", readyPath,
    "--progress", progressPath,
    "--final", finalPath,
    "--authority", authorityPath
  ];
  const shell = process.env.YENHUBS_TEST_BASH || "bash";
  const libraryPath = path.join(root, "deployment/lib/recovery-safety.sh");
  const child = spawn(options.shellStarters ? shell : "/bin/sh",
    options.shellStarters ? ["-c", signedShellLifecycle, "_", libraryPath, directory, mode]
      : ["-c", `
authority_path=$1
shift
attempt=0
while [ ! -s "$authority_path" ]; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 500 ] || exit 91
  sleep 0.01
done
exec "$@"
`, "_", authorityPath, process.execPath, ...monitorArguments], {
    cwd: root,
    env: {
      ...process.env,
      KUBECTL_BIN: kubectlPath,
      YENHUBS_RECOVERY_TEST_MODE: "local-fixture",
      STUB_SHELL_STARTERS: options.shellStarters ? "1" : "0",
      ...(options.shellStarters ? {
        PATH: `${path.join(directory, "bin")}${path.delimiter}${process.env.PATH}`,
        TMPDIR: directory,
        EXPECTED_KUBE_CONTEXT: context, NAMESPACE: parentNamespace,
        EXPECTED_NAMESPACE_UID: "fixture-uid", EXPECTED_RET_PVC_UID: "fixture-pvc-uid",
        RECOVERY_TEST_STABLE_ABSENCE_SECONDS: "0", STUB_TEST_PARENT_PID: String(process.pid),
        // This reduction is permitted only by the real attestation validator.
        RECOVERY_TEST_WATCHER_JOIN_TIMEOUT_SECONDS: "30",
        STUB_TEST_BASH: shell, STUB_TEST_NODE: process.execPath, STUB_RECOVERY_LIBRARY: libraryPath,
        STUB_LEASE_HISTORY_PATH: leaseHistoryPath, STUB_LEASE_WATCH_LOG_PATH: leaseWatchLogPath,
        STUB_WATCH_IDENTITY_PATH: watchIdentityPath,
        STUB_API_READ_LOG_PATH: apiReadLogPath,
        STUB_DEPLOYMENTS_JSON: JSON.stringify(signed.deployments),
        STUB_REPLICASETS_JSON: JSON.stringify(signed.replicaSets)
      } : {}),
      ...(options.diagnostics ? { YENHUBS_WATCH_TEST_DEBUG: "1" } : {}),
      STUB_MODE: mode,
      STUB_STOP_PATH: stopPath,
      STUB_DESCENDANT_PATH: descendantPath,
      STUB_CONTROL_WATCH_COUNT_PREFIX: controlWatchCountPrefix,
      STUB_LEASE_GET_COUNT_PATH: leaseGetCountPath,
      STUB_PARENT_LIST_COUNT_PATH: parentListCountPath,
      STUB_RUNNER_LIST_COUNT_PATH: runnerListCountPath,
      STUB_PARENT_WATCH_COUNT_PATH: parentWatchCountPath,
      STUB_RUNNER_WATCH_COUNT_PATH: runnerWatchCountPath,
      STUB_WATCH_PID_PATH: watchPidPath,
      STUB_POD_WATCH_LOG_PATH: podWatchLogPath,
      STUB_WATCH_GATE_PATH: watchGatePath,
      STUB_WATCH_RELEASE_PATH: watchReleasePath,
      STUB_FENCE_JSON: JSON.stringify(fencePod()),
      STUB_PARENT_JSON: JSON.stringify(parentPod()),
      STUB_TRANSIENT_RUNNER_JSON: JSON.stringify(transientFencePod()),
      STUB_LEGACY_PARENT_JSON: JSON.stringify({
        ...parentPod("legacy-parent-rv"),
        metadata: {
          ...parentPod("legacy-parent-rv").metadata,
          name: "bot-runner-legacy-excursion",
          uid: "legacy-parent-excursion-uid",
          labels: { app: "bot-runner" }
        },
        spec: {
          ...parentPod("legacy-parent-rv").spec,
          serviceAccountName: "bot-orchestrator"
        }
      }),
      STUB_CONTROLS_JSON: JSON.stringify(control.resources),
      STUB_RENEWED_LEASE_JSON: JSON.stringify({
        ...control.resources.lease,
        metadata: {
          ...control.resources.lease.metadata,
          resourceVersion: "operation-lease-rv-2"
        },
        spec: {
          ...control.resources.lease.spec,
          renewTime: microsecondTimestamp()
        }
      })
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const authority = {
    schema_version: 1,
    kind: "durable-runner-quiescence-monitor",
    pid: child.pid,
    start_identity: `fixture-start:${child.pid}`,
    context,
    namespace: parentNamespace,
    namespace_uid: control.baseline.namespace_uid,
    operation_id: control.baseline.operation_id,
    operation_owner: control.baseline.operation_owner,
    runtime_generation: "durable-v2",
    operation_lock: control.baseline.operation_lock,
    lease: {
      name: control.baseline.lease.name,
      uid: control.baseline.lease.uid,
      holder: control.baseline.lease.holder
    },
    paths: {
      authority: authorityPath,
      durable_baseline: baselinePath,
      control_baseline: controlBaselinePath,
      stop: stopPath,
      failure: failurePath,
      ready: readyPath,
      progress: progressPath,
      final: finalPath
    },
    hashes: {
      durable_baseline_sha256: baseline.sha256,
      control_baseline_sha256: options.controlSha256 ?? control.sha256,
      control_capability_sha256: monitorCapabilityDigest(control)
    }
  };
  const authorityText = `${canonicalJson(authority)}\n`;
  if (!options.shellStarters) privateFile(authorityPath, authorityText);
  const authoritySha256 = options.shellStarters ? "" : digest(authorityText);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => {
    stderr += chunk;
    if (process.env.YENHUBS_WATCH_TEST_DEBUG === "1") process.stderr.write(chunk);
  });
  let closeObserved = false;
  const closed = new Promise(resolve => child.once("close", (code, signal) => {
    closeObserved = true;
    resolve({ code, signal, stdout, stderr });
  }));
  if (signed) child.once("error", () => { stderr += "signed_fixture_spawn_failed\n"; });
  // exit is independent of inherited pipes: close alone is not a teardown clock.
  const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  const fixture = {
    directory, baselinePath, controlBaselinePath, control, stopPath, failurePath,
    readyPath, progressPath, finalPath, authorityPath, authoritySha256,
    writerPaths, monitorIdentityPath, shellResultPath, apiReadLogPath, signed,
    leaseHistoryPath, leaseWatchLogPath, watchIdentityPath, shellIdentityPath, pipeHolderPath, shell, libraryPath,
    descendantPath, parentListCountPath,
    runnerListCountPath, parentWatchCountPath, runnerWatchCountPath,
    watchPidPath, podWatchLogPath, watchGatePath, watchReleasePath, child, closed, exited,
    hasClosed: () => closeObserved
  };
  if (signed) {
    let expire;
    const deadline = new Promise(resolve => { expire = () => {
      const error = new Error("signed_fixture_execution_deadline");
      error.code = "signed_fixture_execution_deadline";
      resolve(error);
    }; });
    fixture.executionTimer = setTimeout(expire, signedExecutionTimeoutMs);
    if (mode === "signed-watchdog") {
      fixture.readyTimer = setInterval(() => {
        if (![readyPath, writerPaths.ready, pipeHolderPath].every(file => fs.statSync(file).size > 0)) return;
        clearInterval(fixture.readyTimer);
        fixture.watchdogAfterReady = true;
        clearTimeout(fixture.executionTimer);
        fixture.executionTimer = setTimeout(expire, 1_000);
      }, 20);
    }
    fixture.completion = (async () => {
      const result = await Promise.race([closed, deadline]);
      clearTimeout(fixture.executionTimer);
      clearInterval(fixture.readyTimer);
      if (result instanceof Error) {
        // Cleanup failure is additional evidence; it must not turn a timeout
        // into success or replace the original failed observable.
        try { await cleanupFixture(fixture); } catch (error) { result.cleanupError = error; }
        result.nativeExit = { code: child.exitCode, signal: child.signalCode };
        throw result;
      }
      return result;
    })();
  }
  return fixture;
}

function recordedFixtureProcessGroups(fixture) {
  if (!fs.existsSync(fixture.watchPidPath)) return [];
  return [...new Set(fs.readFileSync(fixture.watchPidPath, "utf8").trim()
    .split("\n").map(Number).filter(pid => Number.isSafeInteger(pid) && pid > 1))];
}

function fixtureProcessGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function signalFixtureProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!["EPERM", "ESRCH"].includes(error?.code)) throw error;
  }
}

async function waitUpTo(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(null), milliseconds); })]);
  } finally { clearTimeout(timer); }
}

function fixtureProcessExists(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function cleanupSignedFixture(fixture) {
  clearTimeout(fixture.executionTimer);
  clearInterval(fixture.readyTimer);
  try {
    // Signal the unreaped direct child, then give its EXIT trap both real joins.
    // Do not use the old unsigned 4 s SIGKILL deadline for this Bash wrapper.
    if (fixture.child.exitCode === null && fixture.child.signalCode === null) fixture.child.kill("SIGTERM");
    const exitedBeforeGuardian = await waitUpTo(fixture.exited, signedCleanupTimeoutMs - 25_000);
    const retainedPipeText = fs.readFileSync(fixture.pipeHolderPath, "utf8").trim();
    const wrapperCloseBlockedByOwnedChild = Boolean(exitedBeforeGuardian && !fixture.hasClosed() &&
      retainedPipeText && fixtureProcessExists(JSON.parse(retainedPipeText).pid));
    const guardian = spawn(fixture.shell, ["-c", signedCleanupLifecycle, "_", fixture.libraryPath,
      fixture.directory, String(fixture.child.pid)], { cwd: root, stdio: "ignore" });
    let guardianSpawnFailed = false;
    guardian.once("error", () => { guardianSpawnFailed = true; });
    const guardianExited = new Promise(resolve => guardian.once("exit", (code, signal) => resolve({ code, signal })));
    const guardianResult = await waitUpTo(guardianExited, 20_000);
    if (!guardianResult) {
      // This is our unreaped teardown child, never a recorded historical PGID.
      if (!guardianSpawnFailed && guardian.exitCode === null && guardian.signalCode === null) guardian.kill("SIGKILL");
      guardian.unref();
      throw new Error(`signed_fixture_owned_cleanup_deadline:${fixture.directory}`);
    }
    const nativeExit = await waitUpTo(fixture.exited, 2_000);
    const text = fs.readFileSync(fixture.monitorIdentityPath, "utf8").trim();
    const monitors = text ? JSON.parse(text) : {};
    const watchText = fs.readFileSync(fixture.watchIdentityPath, "utf8").trim();
    const watches = watchText ? watchText.split("\n").map(line => JSON.parse(line)) : [];
    const pipeText = fs.readFileSync(fixture.pipeHolderPath, "utf8").trim();
    const pipeHolder = pipeText ? JSON.parse(pipeText) : null;
    const processGroups = recordedFixtureProcessGroups(fixture);
    fixture.cleanupEvidence = { nativeExit, monitors, pipeHolder, watches, processGroups, wrapperCloseBlockedByOwnedChild,
      markers: Object.fromEntries([fixture.readyPath, fixture.finalPath, fixture.stopPath,
        fixture.writerPaths.ready, fixture.writerPaths.final, fixture.writerPaths.stop]
        .map(file => [path.basename(file), fs.readFileSync(file, "utf8")])) };
    const owned = [...Object.values(monitors), ...watches, ...(pipeHolder ? [pipeHolder] : []), { pid: fixture.child.pid }];
    if (guardianResult.code !== 0 || guardianResult.signal || !nativeExit ||
        owned.some(({ pid }) => fixtureProcessExists(pid) || fixtureProcessGroupExists(pid)) ||
        processGroups.some(fixtureProcessGroupExists)) {
      throw new Error(`signed_fixture_owned_cleanup_failed:${fixture.directory}`);
    }
    // Only after ownership cleanup: retained wrapper pipes cannot block close.
    fixture.child.stdout.destroy();
    fixture.child.stderr.destroy();
    if (!await waitUpTo(fixture.closed, 1_000)) throw new Error(`signed_fixture_pipe_close_deadline:${fixture.directory}`);
    clearInterval(fixture.signed.leaseOwner);
    fs.rmSync(fixture.directory, { recursive: true, force: true });
    return processGroups;
  } finally {
    clearInterval(fixture.signed.leaseOwner);
    // Even a failed cleanup must release our handles and report failure, not hang
    // indefinitely or delete the evidence of a still-active owned process.
    fixture.child.stdout.destroy();
    fixture.child.stderr.destroy();
    fixture.child.unref();
  }
}

async function cleanupFixture(fixture) {
  if (fixture.cleanupPromise) return fixture.cleanupPromise;
  fixture.cleanupPromise = (async () => {
    if (fixture.signed) return cleanupSignedFixture(fixture);
    try { fixture.child.kill("SIGTERM"); } catch {}
    await Promise.race([
      fixture.closed,
      new Promise(resolve => setTimeout(resolve, 4_000))
    ]);
    if (fixture.child.exitCode === null && fixture.child.signalCode === null) {
      try { fixture.child.kill("SIGKILL"); } catch {}
    }
    await Promise.race([
      fixture.closed,
      new Promise(resolve => setTimeout(resolve, 1_000))
    ]);
    const processGroups = recordedFixtureProcessGroups(fixture);
    processGroups.forEach(pid => signalFixtureProcessGroup(pid, "SIGTERM"));
    const termDeadline = Date.now() + 750;
    while (processGroups.some(fixtureProcessGroupExists) && Date.now() < termDeadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    processGroups.filter(fixtureProcessGroupExists)
      .forEach(pid => signalFixtureProcessGroup(pid, "SIGKILL"));
    const killDeadline = Date.now() + 750;
    while (processGroups.some(fixtureProcessGroupExists) && Date.now() < killDeadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (fs.existsSync(fixture.descendantPath)) {
      for (const pid of fs.readFileSync(fixture.descendantPath, "utf8").trim()
        .split("\n").map(Number)) {
        if (!Number.isSafeInteger(pid) || pid <= 1) continue;
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
    }
    const cleanupFailed = processGroups.some(fixtureProcessGroupExists);
    fs.rmSync(fixture.directory, { recursive: true, force: true });
    if (cleanupFailed) throw new Error("fixture_process_group_cleanup");
    return processGroups;
  })();
  return fixture.cleanupPromise;
}

async function assertMonitorFailed(fixture) {
  const result = await fixture.closed;
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(fs.readFileSync(fixture.readyPath, "utf8"), "");
  assert.equal(fs.readFileSync(fixture.finalPath, "utf8"), "");
  assert.equal(fs.readFileSync(fixture.failurePath, "utf8"),
    "durable_runner_monitor_failed\n");
}

async function assertMonitorFailedAfterReady(fixture) {
  const result = await fixture.closed;
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.match(fs.readFileSync(fixture.readyPath, "utf8"), /^ready:/u);
  assert.equal(fs.readFileSync(fixture.finalPath, "utf8"), "");
  assert.equal(fs.readFileSync(fixture.failurePath, "utf8"),
    "durable_runner_monitor_failed\n");
}

for (const mode of ["success", "signed-selector-drift"]) {
  test(`signed Bash starters -> real Node authority2/consumer3: ${mode}`,
    { timeout: signedExecutionTimeoutMs + signedCleanupTimeoutMs + 5_000 }, async t => {
    const fixture = runMonitorFixture(mode, { shellStarters: true });
    t.after(() => cleanupFixture(fixture));
    const result = await fixture.completion;
    assert.deepEqual({ code: result.code, signal: result.signal }, { code: 0, signal: null }, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    const controlText = fs.readFileSync(fixture.controlBaselinePath, "utf8");
    const controlBaseline = JSON.parse(controlText);
    assert.equal(controlBaseline.schema_version, 4, "the real writer CLI must publish the signed baseline");
    assert.equal(fixture.signed.consumerContract.schema_version, 3);
    assert.equal(JSON.parse(controlBaseline.backup_authority).schema_version, 2);
    assert.equal(controlText.includes("signed-monitor-private-payload-sentinel"), false);
    const processes = JSON.parse(fs.readFileSync(fixture.monitorIdentityPath, "utf8"));
    const outcome = JSON.parse(fs.readFileSync(fixture.shellResultPath, "utf8"));
    for (const [kind, paths, authorityPath] of [
      ["writer", fixture.writerPaths, `${fixture.writerPaths.ready}.authority.json`],
      ["durable", { ready: fixture.readyPath, progress: fixture.progressPath, failure: fixture.failurePath,
        final: fixture.finalPath, stop: fixture.stopPath }, fixture.authorityPath]
    ]) {
      const authorityText = fs.readFileSync(authorityPath, "utf8");
      const authority = JSON.parse(authorityText);
      const authoritySha = digest(authorityText);
      assert.equal(authorityText, `${canonicalJson(authority)}\n`);
      assert.equal(fs.statSync(authorityPath).mode & 0o777, 0o600);
      assert.deepEqual({ pid: authority.pid, start_identity: authority.start_identity }, processes[kind]);
      assert.match(authority.start_identity, /^(?:darwin:|linux:)/);
      assert.deepEqual(authority.backup_authority, { keyring_path: fixture.signed.keyringPath, key_id: fixtureKeyId });
      const ready = fs.readFileSync(paths.ready, "utf8");
      assert.equal(fs.readFileSync(paths.failure, "utf8"), "");
      assert.match(fs.readFileSync(paths.progress, "utf8"), new RegExp(`^${authoritySha}:[1-9][0-9]*\\n$`));
      if (kind === "writer") assert.equal(ready, `ready:${digest(controlText)}:${authoritySha}\n`);
      else assert.equal(ready, `ready:${baseline.sha256}:${digest(controlText)}:${authority.hashes.control_capability_sha256}:${authoritySha}\n`);
      if (mode === "success") {
        assert.equal(outcome[`${kind}_joined`], "ok");
        if (kind === "durable") {
          assert.equal(fs.readFileSync(paths.stop, "utf8"), "stop\n");
          assert.equal(fs.readFileSync(paths.final, "utf8"), ready.replace(/^ready:/, "complete:"));
        } else {
          assert.equal(JSON.parse(fs.readFileSync(paths.stop, "utf8")).stop, true);
          const final = JSON.parse(fs.readFileSync(paths.final, "utf8"));
          assert.equal(final.complete, true);
          assert.equal(final.monitor_authority_sha256, authoritySha);
          assert.deepEqual(final.deployments.map(value => value.name), writerNames);
        }
      } else {
        assert.equal(outcome[`${kind}_rejection`], 1, "the real shell health gate must reject changed signed selection");
        assert.equal(fs.readFileSync(paths.stop, "utf8"), "discard\n");
        assert.equal(fs.readFileSync(paths.final, "utf8"), "", "discard must never publish positive final evidence");
      }
      // A successful receipt is insufficient if an owned monitor or PGID remains.
      assert.throws(() => process.kill(authority.pid, 0), { code: "ESRCH" });
      assert.equal(fixtureProcessGroupExists(authority.pid), false);
    }
    for (const pid of recordedFixtureProcessGroups(fixture)) assert.equal(fixtureProcessGroupExists(pid), false);
    const requests = fs.readFileSync(fixture.apiReadLogPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.ok(requests.some(args => args.includes("current-context")));
    for (const resource of ["namespace", "pvc"]) {
      assert.ok(requests.some(args => args.includes(resource) && args.includes("jsonpath={.metadata.uid}")),
        `actual fixture attestation must read ${resource} identity`);
    }
    assert.ok(requests.every(args => args.includes("get") || args.includes("current-context")), "fixture lane must remain API read-only");
    const leaseHistory = JSON.parse(fs.readFileSync(fixture.leaseHistoryPath, "utf8"));
    assert.equal(leaseHistory.owner_pid, process.pid);
    for (const [index, lease] of leaseHistory.history.entries()) {
      assert.equal(lease.metadata.resourceVersion, `operation-lease-rv-${index + 1}`);
      assert.equal(lease.spec.holderIdentity, operationHolder);
      assert.equal(lease.spec.acquireTime, fixture.control.resources.lease.spec.acquireTime);
      assert.ok(Date.parse(lease.spec.renewTime) <= Date.now(), "owner renewal must never move into the future");
      if (index) assert.ok(Date.parse(lease.spec.renewTime) > Date.parse(leaseHistory.history[index - 1].spec.renewTime));
    }
    const leaseWatches = fs.readFileSync(fixture.leaseWatchLogPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.ok(leaseWatches.length > 0, "real monitors must consume the shared Lease watch history");
    const versions = leaseHistory.history.map(lease => lease.metadata.resourceVersion);
    for (const watch of leaseWatches) {
      const start = versions.indexOf(watch.cursor), end = versions.indexOf(watch.frontier);
      assert.ok(start >= 0 && end >= start);
      assert.deepEqual(watch.replayed, versions.slice(start + 1, end + 1));
    }
    await cleanupFixture(fixture);
    assert.equal(fs.existsSync(fixture.directory), false);
  });
}

test("signed Bash starters watchdog -> owned cleanup after both READY and retained pipes",
  { timeout: signedExecutionTimeoutMs + signedCleanupTimeoutMs + 5_000 }, async t => {
    const fixture = runMonitorFixture("signed-watchdog", { shellStarters: true });
    t.after(() => cleanupFixture(fixture));
    await assert.rejects(fixture.completion, error => {
      assert.equal(error.code, "signed_fixture_execution_deadline", "cleanup must preserve the original timeout");
      assert.equal(error.cleanupError, undefined);
      assert.deepEqual(error.nativeExit, { code: 143, signal: null }, "the real Bash TERM/EXIT trap must finish; never operational PASS");
      return true;
    });
    assert.equal(fixture.watchdogAfterReady, true);
    const evidence = fixture.cleanupEvidence;
    assert.deepEqual(Object.keys(evidence.monitors).sort(), ["durable", "writer"]);
    for (const prefix of ["", "writer-"]) {
      assert.match(evidence.markers[`${prefix}ready`], /^ready:/u);
      assert.equal(evidence.markers[`${prefix}stop`], "discard\n");
      assert.equal(evidence.markers[`${prefix}final`], "", "timeout cleanup must not publish positive final evidence");
    }
    assert.ok(evidence.pipeHolder?.pid > 1, "an owned child must actually retain the wrapper pipes");
    assert.equal(evidence.wrapperCloseBlockedByOwnedChild, true, "native exit alone must not be mistaken for closed pipes");
    for (const record of [...Object.values(evidence.monitors), ...evidence.watches, evidence.pipeHolder]) {
      assert.match(record.start_identity, /^(?:darwin:|linux:)/u);
      assert.equal(fixtureProcessExists(record.pid), false);
      assert.equal(fixtureProcessGroupExists(record.pid), false);
    }
    assert.equal(fs.existsSync(fixture.directory), false);
  });

test("CLI publishes ready/progress/final without API payloads and honors safe stop", async t => {
  const fixture = runMonitorFixture("success", { operationOwner: "checkpoint-restore" });
  t.after(() => cleanupFixture(fixture));
  const positiveCapability = [
    baseline.sha256,
    fixture.control.sha256,
    monitorCapabilityDigest(fixture.control),
    fixture.authoritySha256
  ].join(":");
  await waitFor(() => fs.readFileSync(fixture.readyPath, "utf8") ===
    `ready:${positiveCapability}\n`);
  fs.writeFileSync(fixture.stopPath, "stop\n", { mode: 0o600 });
  const result = await fixture.closed;
  assert.deepEqual({ code: result.code, signal: result.signal }, { code: 0, signal: null });
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(fs.readFileSync(fixture.failurePath, "utf8"), "");
  assert.match(fs.readFileSync(fixture.progressPath, "utf8"),
    /^[a-f0-9]{64}:[1-9][0-9]*\n$/u);
  assert.equal(fs.readFileSync(fixture.finalPath, "utf8"),
    `complete:${positiveCapability}\n`);
});

test("CLI starts from fresh LIST frontier when immutable object history expired", async t => {
  const fixture=runMonitorFixture("old-control-rv",{operationOwner:"checkpoint-backup"});
  t.after(()=>cleanupFixture(fixture));
  await waitFor(()=>fs.readFileSync(fixture.readyPath,"utf8").startsWith("ready:"));
  fs.writeFileSync(fixture.stopPath,"stop\n",{mode:0o600});
  const result=await fixture.closed;
  assert.equal(result.code,0);assert.equal(result.stderr,"");
  assert.equal(fs.readFileSync(fixture.failurePath,"utf8"),"");
});

test("CLI fails closed when the retained Pod cursor expires with 410", async t => {
  const fixture = runMonitorFixture("pod-watch-410");
  t.after(() => cleanupFixture(fixture));
  const result = await fixture.closed;
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(fs.readFileSync(fixture.readyPath, "utf8"), "");
  assert.equal(fs.readFileSync(fixture.finalPath, "utf8"), "");
  assert.equal(fs.readFileSync(fixture.failurePath, "utf8"),
    "durable_runner_monitor_failed\n");
});

for (const mode of ["initial-hang", "initial-no-boundary"]) {
  test(`CLI requires an initial streaming-list boundary after the first LIST: ${mode}`, async t => {
    const fixture = runMonitorFixture(mode);
    t.after(() => cleanupFixture(fixture));
    await assertMonitorFailed(fixture);
  });
}

for (const mode of ["initial-eof", "successor-eof", "after-ready-eof"]) {
  test(`CLI rejects transport loss without replacing the causal frontier: ${mode}`, async t => {
    const fixture = runMonitorFixture(mode, { diagnostics: true });
    t.after(() => cleanupFixture(fixture));
    const result = await fixture.closed;
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "durable_runner_monitor_error:pod_watch_kubectl_failed\n");
    assert.equal(fs.readFileSync(fixture.failurePath, "utf8"), "durable_runner_monitor_failed\n");
    assert.equal(fs.readFileSync(fixture.finalPath, "utf8"), "");
    const ready = fs.readFileSync(fixture.readyPath, "utf8");
    if (mode === "after-ready-eof") assert.match(ready, /^ready:/u);
    else assert.equal(ready, "");
    const starts = fs.readFileSync(fixture.runnerWatchCountPath, "utf8").trim().split("\n");
    assert.equal(starts.length, { "initial-eof": 1, "successor-eof": 2, "after-ready-eof": 3 }[mode]);
  });
}

test("CLI treats numeric-shaped Kubernetes resourceVersions as opaque", async t => {
  const fixture = runMonitorFixture("opaque-numeric-rv");
  t.after(() => cleanupFixture(fixture));
  await waitFor(() => fs.readFileSync(fixture.readyPath, "utf8").startsWith("ready:"));
  const runnerStarts = fs.readFileSync(fixture.podWatchLogPath, "utf8").trim()
    .split("\n").filter(line => line.startsWith("start runner "));
  assert.ok(runnerStarts.length >= 2);
  for (const line of runnerStarts.slice(0, 2)) {
    const rawPath = line.split(" ", 4)[3];
    const url = new URL(`https://fixture.invalid${rawPath}`);
    assert.equal(url.searchParams.get("resourceVersion"), "900");
    assert.equal(url.searchParams.get("resourceVersionMatch"), "NotOlderThan");
    assert.equal(url.searchParams.get("sendInitialEvents"), "true");
  }
  fs.writeFileSync(fixture.stopPath, "stop\n", { mode: 0o600 });
  const result = await fixture.closed;
  assert.deepEqual({ code: result.code, signal: result.signal }, { code: 0, signal: null });
  assert.match(fs.readFileSync(fixture.finalPath, "utf8"), /^complete:/u);
  assert.equal(fs.readFileSync(fixture.failurePath, "utf8"), "");
});

for (const mode of [
  "successor-no-boundary",
  "successor-ordinary-bookmark",
  "successor-error",
  "successor-410",
  "successor-oversize",
  "successor-close",
  "successor-state-drift"
]) {
  test(`CLI rejects an invalid successor streaming-list handshake: ${mode}`, async t => {
    const fixture = runMonitorFixture(mode);
    t.after(() => cleanupFixture(fixture));
    await assertMonitorFailed(fixture);
  });
}

for (const mode of [
  "runner-event-on-final-drain",
  "runner-410-on-final-drain"
]) {
  test(`CLI drains Pod evidence before FINAL and rejects terminal data: ${mode}`, async t => {
    const fixture = runMonitorFixture(mode);
    t.after(() => cleanupFixture(fixture));
    await assertMonitorFailedAfterReady(fixture);
  });
}

for (const mode of [
  "terminal-binding-drift",
  "terminal-lock-drift",
  "terminal-lease-drift"
]) {
  test(`CLI requires a final causal control frontier after Pod drain: ${mode}`, async t => {
    const fixture = runMonitorFixture(mode);
    t.after(() => cleanupFixture(fixture));
    await assertMonitorFailedAfterReady(fixture);
  });
}

for (const mode of [
  "runner-excursion-after-initial-list",
  "runner-excursion-during-handoff"
]) {
  test(`CLI catches a create-delete excursion across a fresh-LIST handoff: ${mode}`, async t => {
    const fixture = runMonitorFixture(mode);
    t.after(() => cleanupFixture(fixture));
    await assertMonitorFailed(fixture);
  });
}

for (const mode of [
  "runner-excursion-between-rounds",
  "parent-excursion-between-rounds"
]) {
  test(`CLI catches a create-delete excursion between completed rounds: ${mode}`, async t => {
    const fixture = runMonitorFixture(mode);
    t.after(() => cleanupFixture(fixture));
    const result = await fixture.closed;
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.match(fs.readFileSync(fixture.readyPath, "utf8"), /^ready:/u);
    assert.equal(fs.readFileSync(fixture.finalPath, "utf8"), "");
    assert.equal(fs.readFileSync(fixture.failurePath, "utf8"),
      "durable_runner_monitor_failed\n");
  });
}

test("CLI sees an active-dormant-active binding transient from its retained cursor", async t => {
  const fixture = runMonitorFixture("binding-transient");
  t.after(() => cleanupFixture(fixture));
  await assertMonitorFailed(fixture);
});

for (const mode of [
  "parent-namespace-modified", "policy-modified", "operation-lock-modified"
]) {
  test(`CLI fails on immutable recovery control drift: ${mode}`, async t => {
    const fixture = runMonitorFixture(mode);
    t.after(() => cleanupFixture(fixture));
    await assertMonitorFailed(fixture);
  });
}

test("CLI fails closed when a retained control cursor expires with 410", async t => {
  const fixture = runMonitorFixture("control-watch-410");
  t.after(() => cleanupFixture(fixture));
  await assertMonitorFailed(fixture);
});

test("CLI accepts only causally observed Lease renewals and retains the next cursor", async t => {
  const fixture = runMonitorFixture("lease-renew");
  t.after(() => cleanupFixture(fixture));
  await waitFor(() => Number(
    fs.readFileSync(fixture.progressPath, "utf8").trim().split(":")[1]
  ) >= 2);
  const lifecycle = fs.readFileSync(fixture.podWatchLogPath, "utf8").trim().split("\n");
  for (const [successor, predecessor] of [[2, 1], [3, 2]]) {
    const successorStart = lifecycle.findIndex(line =>
      line.startsWith(`start runner ${successor} `)
    );
    const predecessorClose = lifecycle.indexOf(`close runner ${predecessor}`);
    assert.ok(successorStart >= 0 && predecessorClose > successorStart,
      `runner Watch ${successor} must start before predecessor ${predecessor} closes`);
  }
  const runnerStarts = lifecycle.filter(line => line.startsWith("start runner "));
  const runnerUrls = runnerStarts.slice(0, 3).map(line => {
    const rawPath = line.split(" ", 4)[3];
    return new URL(`https://fixture.invalid${rawPath}`);
  });
  assert.deepEqual(runnerUrls.map(url => url.searchParams.get("resourceVersion")),
    ["runner-list-rv-1", "runner-list-rv-2", "runner-list-rv-3"]);
  for (const streamingUrl of runnerUrls) {
    assert.equal(streamingUrl.searchParams.get("sendInitialEvents"), "true");
    assert.equal(streamingUrl.searchParams.get("resourceVersionMatch"), "NotOlderThan");
    assert.equal(streamingUrl.searchParams.get("allowWatchBookmarks"), "true");
  }
  fs.writeFileSync(fixture.stopPath, "stop\n", { mode: 0o600 });
  const result = await fixture.closed;
  assert.deepEqual({ code: result.code, signal: result.signal }, { code: 0, signal: null });
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.match(fs.readFileSync(fixture.readyPath, "utf8"),
    /^ready:(?:[a-f0-9]{64}:){3}[a-f0-9]{64}\n$/u);
  assert.match(fs.readFileSync(fixture.finalPath, "utf8"),
    /^complete:(?:[a-f0-9]{64}:){3}[a-f0-9]{64}\n$/u);
});

test("CLI replays a legitimate Lease renewal arriving between Watch close and terminal GET", async t => {
  const fixture = runMonitorFixture("lease-gap-renew");
  t.after(() => cleanupFixture(fixture));
  await waitFor(() => fs.readFileSync(fixture.readyPath, "utf8").startsWith("ready:"));
  fs.writeFileSync(fixture.stopPath, "stop\n", { mode: 0o600 });
  const result = await fixture.closed;
  assert.deepEqual({ code: result.code, signal: result.signal }, { code: 0, signal: null });
  assert.equal(result.stderr, "");
  assert.equal(fs.readFileSync(fixture.failurePath, "utf8"), "");
  assert.match(fs.readFileSync(fixture.finalPath, "utf8"), /^complete:/u);
});

for (const mode of ["lease-holder-flip", "lease-stale-renew", "lease-unobserved",
  "lease-gap-holder-flip", "lease-gap-unobserved", "lease-gap-expired"]) {
  test(`CLI rejects unsafe or non-causal Lease evidence: ${mode}`, async t => {
    const fixture = runMonitorFixture(mode);
    t.after(() => cleanupFixture(fixture));
    await assertMonitorFailed(fixture);
  });
}

for (const [name, options] of [
  ["digest", { controlSha256: "f".repeat(64) }],
  ["operation", {
    mutateControlBaseline: value => { value.operation_id = "b".repeat(32); }
  }],
  ["owner", {
    mutateControlBaseline: value => { value.operation_owner = "aud065-rotation"; }
  }],
  ["context", { controlContext: "different-context" }]
]) {
  test(`CLI rejects a control-baseline ${name} mismatch`, async t => {
    const fixture = runMonitorFixture("success", options);
    t.after(() => cleanupFixture(fixture));
    await assertMonitorFailed(fixture);
  });
}

test("CLI rejects immediate Watch closure outside the exact local fixture", async t => {
  const fixture = runMonitorFixture("success", { context: "production-context" });
  t.after(() => cleanupFixture(fixture));
  await assertMonitorFailed(fixture);
});

for (const target of ["stop", "baseline"]) {
  test(`CLI rejects same-content inode replacement of ${target}`, async t => {
    const fixture = runMonitorFixture();
    t.after(() => cleanupFixture(fixture));
    await waitFor(() => fs.readFileSync(fixture.readyPath, "utf8").startsWith("ready:"));
    const targetPath = target === "stop" ? fixture.stopPath : fixture.baselinePath;
    const replacement = `${targetPath}.replacement`;
    privateFile(replacement, fs.readFileSync(targetPath, "utf8"));
    fs.renameSync(replacement, targetPath);
    const result = await fixture.closed;
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(fs.readFileSync(fixture.finalPath, "utf8"), "");
    assert.equal(fs.readFileSync(fixture.failurePath, "utf8"),
      "durable_runner_monitor_failed\n");
  });
}

test("CLI rejects post-ready monitor-authority tampering", async t => {
  const fixture = runMonitorFixture();
  t.after(() => cleanupFixture(fixture));
  await waitFor(() => fs.readFileSync(fixture.readyPath, "utf8").startsWith("ready:"));
  fs.appendFileSync(fixture.authorityPath, "\n");
  await assertMonitorFailedAfterReady(fixture);
});

for (const target of ["baseline", "control baseline"]) {
  test(`CLI rejects a ${target} replacement during the last asynchronous round`, async t => {
    const fixture = runMonitorFixture("gated-watch");
    t.after(() => cleanupFixture(fixture));
    await waitFor(() => fs.existsSync(fixture.watchGatePath) &&
      fs.readFileSync(fixture.watchGatePath, "utf8").trim().split("\n").length >= 2);
    const targetPath = target === "baseline"
      ? fixture.baselinePath
      : fixture.controlBaselinePath;
    const replacement = `${targetPath}.replacement`;
    privateFile(replacement, fs.readFileSync(targetPath, "utf8"));
    fs.renameSync(replacement, targetPath);
    privateFile(fixture.watchReleasePath, "release\n");
    await assertMonitorFailed(fixture);
  });
}

test("CLI never adopts a replaced failure marker", async t => {
  const fixture = runMonitorFixture();
  t.after(() => cleanupFixture(fixture));
  await waitFor(() => fs.readFileSync(fixture.readyPath, "utf8").startsWith("ready:"));
  const replacement = `${fixture.failurePath}.replacement`;
  privateFile(replacement);
  fs.renameSync(replacement, fixture.failurePath);
  fs.writeFileSync(fixture.stopPath, "invalid\n", { mode: 0o600 });
  const result = await fixture.closed;
  assert.notEqual(result.code, 0);
  assert.equal(fs.readFileSync(fixture.failurePath, "utf8"), "");
  assert.equal(fs.readFileSync(fixture.finalPath, "utf8"), "");
});

for (const mode of ["partial-parent-list", "partial-runner-list", "truncated-list"]) {
  test(`CLI rejects incomplete raw LIST evidence: ${mode}`, async t => {
    const fixture = runMonitorFixture(mode);
    t.after(() => cleanupFixture(fixture));
    const result = await fixture.closed;
    assert.notEqual(result.code, 0);
    assert.equal(fs.readFileSync(fixture.readyPath, "utf8"), "");
    assert.equal(fs.readFileSync(fixture.finalPath, "utf8"), "");
    assert.equal(fs.readFileSync(fixture.failurePath, "utf8"),
      "durable_runner_monitor_failed\n");
  });
}

for (const mode of ["hang-watch", "leader-exits-watch"]) {
  test(`SIGTERM collects the kubectl group and resistant descendants: ${mode}`, async t => {
    const fixture = runMonitorFixture(mode);
    t.after(() => cleanupFixture(fixture));
    await waitFor(() => fs.existsSync(fixture.descendantPath) &&
      fs.readFileSync(fixture.descendantPath, "utf8").trim() !== "");
    const descendantPids = fs.readFileSync(fixture.descendantPath, "utf8").trim()
      .split("\n").map(Number);
    assert.ok(descendantPids.length >= 1 && descendantPids.every(pid =>
      Number.isSafeInteger(pid) && pid > 1));
    fixture.child.kill("SIGTERM");
    const result = await fixture.closed;
    assert.equal(result.code, 143);
    await waitFor(() => descendantPids.every(pid => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return error?.code === "ESRCH";
      }
    }), 5_000);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(fs.readFileSync(fixture.failurePath, "utf8"),
      "durable_runner_monitor_failed\n");
  });
}

for (const [signal, status] of [
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGQUIT", 131]
]) {
  test(`${signal} collects kubectl groups before the monitor exits`, async t => {
    const fixture = runMonitorFixture("hang-watch");
    t.after(() => cleanupFixture(fixture));
    await waitFor(() => fs.existsSync(fixture.descendantPath) &&
      fs.readFileSync(fixture.descendantPath, "utf8").trim() !== "");
    const descendantPids = fs.readFileSync(fixture.descendantPath, "utf8").trim()
      .split("\n").map(Number);
    fixture.child.kill(signal);
    const result = await fixture.closed;
    assert.equal(result.code, status);
    await waitFor(() => descendantPids.every(pid => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return error?.code === "ESRCH";
      }
    }), 5_000);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(fs.readFileSync(fixture.failurePath, "utf8"),
      "durable_runner_monitor_failed\n");
  });
}

test("fixture cleanup reaps kubectl groups after abrupt monitor loss", async t => {
  const fixture = runMonitorFixture("hang-watch");
  t.after(() => cleanupFixture(fixture));
  await waitFor(() => recordedFixtureProcessGroups(fixture).length > 0 &&
    fs.existsSync(fixture.descendantPath) &&
    fs.readFileSync(fixture.descendantPath, "utf8").trim() !== "");
  const processGroups = recordedFixtureProcessGroups(fixture);
  const descendantPids = fs.readFileSync(fixture.descendantPath, "utf8").trim()
    .split("\n").map(Number);
  fixture.child.kill("SIGKILL");
  const result = await fixture.closed;
  assert.deepEqual({ code: result.code, signal: result.signal },
    { code: null, signal: "SIGKILL" });
  const cleanedGroups = await cleanupFixture(fixture);
  assert.deepEqual(cleanedGroups.sort((left, right) => left - right),
    processGroups.sort((left, right) => left - right));
  assert.ok(cleanedGroups.every(pid => !fixtureProcessGroupExists(pid)));
  assert.ok(descendantPids.every(pid => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  }));
});

test("spontaneous kubectl leader exit cannot orphan a resistant process-group descendant", async t => {
  const fixture = runMonitorFixture("leader-spontaneous-watch");
  t.after(() => cleanupFixture(fixture));
  const result = await fixture.closed;
  assert.notEqual(result.code, 0);
  assert.ok(fs.existsSync(fixture.descendantPath));
  const descendantPids = fs.readFileSync(fixture.descendantPath, "utf8").trim()
    .split("\n").map(Number);
  assert.ok(descendantPids.length >= 1 && descendantPids.every(pid =>
    Number.isSafeInteger(pid) && pid > 1));
  await waitFor(() => descendantPids.every(pid => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  }), 5_000);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(fs.readFileSync(fixture.finalPath, "utf8"), "");
  assert.equal(fs.readFileSync(fixture.failurePath, "utf8"),
    "durable_runner_monitor_failed\n");
});

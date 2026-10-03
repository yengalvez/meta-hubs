// Synthetic local protocol recipes. These exercise the real shared producer
// predicates/HMAC and one JSON-Patch peer, not Kubernetes continuity, live
// recovery, monitor coverage, DB/storage restoration or release acceptance.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  canonicalJsonV1, createCheckpointBackupAuthorityV2, createKeyRecord
} from "../../deployment/recovery-checkpoint-authority.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const shell = process.env.YENHUBS_TEST_BASH || "bash";
const source = fs.readFileSync(path.join(root, "deployment/create-checkpoint.sh"), "utf8");
const names = ["bot-orchestrator", "coturn", "pgbouncer", "pgbouncer-t", "reticulum"];
const keyId = "12345678-1234-4abc-8def-1234567890ab";
const canary = "synthetic-producer-private-fullspec-canary";
const receipt = "yenhubs.org/checkpoint-resume-operation";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

function fixture(t, { replicas = [1, 1, 1, 1, 1], durable = false } = {}) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "yenhubs-authority-producer-"));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const keyringPath = path.join(directory, "keyring");
  fs.mkdirSync(keyringPath, { mode: 0o700 });
  const key = createKeyRecord({ keyId, keyBytes: Buffer.alloc(32, 0x6a) });
  fs.writeFileSync(path.join(keyringPath, `${keyId}.json`), canonicalJsonV1(key), { mode: 0o600 });
  const deployments = names.map((name, index) => ({
    apiVersion: "apps/v1", kind: "Deployment",
    metadata: { name, namespace: "hcce", uid: `${name}-uid`,
      resourceVersion: `rv-${index}`, generation: 20 + index,
      labels: { app: name }, annotations: {} },
    spec: { replicas: replicas[index], progressDeadlineSeconds: 600,
      revisionHistoryLimit: 10, paused: false,
      selector: { matchLabels: { app: name } }, strategy: { type: "Recreate" },
      template: { metadata: { labels: { app: name } }, spec: { containers: [
        { name, image: `example.invalid/${name}@sha256:${"a".repeat(64)}`,
          env: [{ name: "SYNTHETIC_PRIVATE_VALUE", value: canary }] }
      ] } } }
  }));
  const lockBinding = { name: "yenhubs-recovery-operation-lock", namespace: "hcce",
    owner: "checkpoint-backup", operation_id: "0123456789abcdef0123456789abcdef",
    recovery_token: "b".repeat(32), namespace_uid: "namespace-uid", pvc_uid: "pvc-uid",
    checkpoint_stamp: "20261003-120000", dump_sha256: "0".repeat(64), storage_sha256: "0".repeat(64) };
  const publicAuthority = { schema_version: 2, operation_id: lockBinding.operation_id,
    namespace: { name: "hcce", uid: lockBinding.namespace_uid },
    pvc: { name: "ret-pvc", uid: lockBinding.pvc_uid },
    hmac_profile: "yenhubs-checkpoint-backup-authority-hmac-v2", hmac_key_id: keyId,
    runner_generation: durable ? "durable-v2" : "legacy-absent",
    operation_fence: durable ? {
      state: "dormant",
      namespaces: {
        parent: { name: "hcce", uid: "namespace-uid", initial_resource_version: "parent-rv",
          phase: "Active", metadata_name_label: "hcce" },
        runner: { name: "hcce-bot-runners", uid: "runner-namespace-uid", initial_resource_version: "runner-rv",
          phase: "Active", metadata_name_label: "hcce-bot-runners" }
      },
      policy: { uid: "policy-uid", initial_resource_version: "policy-rv",
        initial_generation: 1, spec_sha256: "a".repeat(64) },
      binding: { uid: "binding-uid", initial_resource_version: "binding-rv",
        dormant_spec_sha256: "b".repeat(64), active_spec_sha256: "c".repeat(64) }
    } : null,
    consumers: deployments.map(d => ({ name: d.metadata.name, uid: d.metadata.uid,
      initial_resource_version: d.metadata.resourceVersion, initial_generation: d.metadata.generation,
      original_replicas: d.spec.replicas, selector: d.metadata.name })) };
  const deploymentContracts = deployments.map(d => ({ api_version: "apps/v1", kind: "Deployment",
    namespace: "hcce", name: d.metadata.name, uid: d.metadata.uid,
    spec_without_replicas: Object.fromEntries(Object.entries(d.spec).filter(([key]) => key !== "replicas")) }));
  const authority = createCheckpointBackupAuthorityV2({ keyringPath, keyId, lockBinding,
    publicAuthority, deploymentContracts });
  const canonical = canonicalJsonV1(authority);
  const consumerContract = { schema_version: 3, operation_id: authority.operation_id,
    authority_sha256: sha(canonical), consumers: authority.consumers };
  const lock = { apiVersion: "v1", kind: "ConfigMap", immutable: true,
    metadata: { name: lockBinding.name, namespace: "hcce", uid: "lock-uid", resourceVersion: "lock-rv",
      labels: { "yenhubs.org/recovery-owner": "checkpoint-backup" }, annotations: {
        "yenhubs.org/operation-id": lockBinding.operation_id,
        "yenhubs.org/recovery-token": lockBinding.recovery_token,
        "yenhubs.org/namespace-uid": lockBinding.namespace_uid,
        "yenhubs.org/pvc-uid": lockBinding.pvc_uid,
        "yenhubs.org/checkpoint-stamp": lockBinding.checkpoint_stamp,
        "yenhubs.org/dump-sha256": lockBinding.dump_sha256,
        "yenhubs.org/storage-sha256": lockBinding.storage_sha256 } },
    data: { "checkpoint-backup-authority.json": canonical } };
  return { directory, keyringPath, deployments, lockBinding, authority, consumerContract, lock };
}

function run(f, script, input, environment = {}) {
  const env = { ...process.env, RECOVERY_BACKUP_AUTHORITY_KEYRING: f.keyringPath,
    RECOVERY_BACKUP_AUTHORITY_KEY_ID: keyId, ...environment };
  for (const name of Object.keys(env)) {
    if (name.startsWith("RECOVERY_OPERATION_") || name === "RECOVERY_CONSUMER_CONTRACT_JSON" ||
        name === "RECOVERY_BACKUP_AUTHORITY_ORIGINALS_JSON" || name === "RECOVERY_BACKUP_AUTHORITY_JSON") delete env[name];
  }
  return spawnSync(shell, ["-c", `set -Eeuo pipefail\nsource deployment/lib/recovery-safety.sh\n${script}`],
    { cwd: root, env, input: canonicalJsonV1(input), encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 });
}

function durableInventory(f, schemaVersion = 5) {
  const rbac = "rbac.authorization.k8s.io/v1", network = "networking.k8s.io/v1";
  const nsRows = [
    ["v1", "ServiceAccount", "hcce", "bot-orchestrator"],
    [rbac, "Role", "hcce", "bot-orchestrator-runner-pods"],
    [rbac, "RoleBinding", "hcce", "bot-orchestrator-runner-pods"],
    ["v1", "ConfigMap", "hcce", "yenhubs-runner-cutover-v2"],
    ["v1", "Secret", "hcce-bot-runners", "bot-images-pull"],
    ["v1", "ServiceAccount", "hcce-bot-runners", "bot-runner"],
    ["v1", "ServiceAccount", "hcce-bot-runners", "bot-runner-guard"],
    ["v1", "ResourceQuota", "hcce-bot-runners", "bot-runner-capacity"],
    ["v1", "ResourceQuota", "hcce-bot-runners", "bot-runner-guard-capacity"],
    [rbac, "Role", "hcce-bot-runners", "bot-orchestrator-runner-pods"],
    [rbac, "RoleBinding", "hcce-bot-runners", "bot-orchestrator-runner-pods"],
    [network, "NetworkPolicy", "hcce-bot-runners", "bot-runner-default-deny"],
    [network, "NetworkPolicy", "hcce-bot-runners", "bot-runner-egress"]
  ];
  const clusterNames = ["bot-runner-pods.yenhubs.org", "bot-runner-durable-protocol.yenhubs.org",
    "yenhubs-runner-cutover-journal-v2", "bot-orchestrator-fence-protocol.yenhubs.org",
    "recovery-operation-pod-fence.yenhubs.org"];
  const clusterResources = clusterNames.flatMap(name => ["ValidatingAdmissionPolicy", "ValidatingAdmissionPolicyBinding"]
    .map(kind => ({ api_version: "admissionregistration.k8s.io/v1", kind, name,
      uid: name === "recovery-operation-pod-fence.yenhubs.org" ?
        (kind === "ValidatingAdmissionPolicy" ? "policy-uid" : "binding-uid") : `${kind}:${name}-uid`,
      resource_version: name === "recovery-operation-pod-fence.yenhubs.org" ?
        (kind === "ValidatingAdmissionPolicy" ? "policy-rv" : "binding-rv") : `${kind}:${name}-rv` })));
  const deploymentNames = ["bot-orchestrator", "coturn", "dialog", "haproxy", "hubs", "nearspark",
    "pgbouncer", "pgbouncer-t", "photomnemonic", "pgsql", "reticulum", "spoke"];
  const repositories = { pgbouncer: "pgbouncer", "pgbouncer-t": "pgbouncer", pgsql: "postgres" };
  const inventory = {
    schema_version: schemaVersion, namespace: "hcce", namespace_uid: "namespace-uid",
    bot_runner_runtime: { generation: "durable-v2", mode: "kubernetes-pod",
      image: `ghcr.io/yengalvez/bot-runner@sha256:${"a".repeat(64)}`,
      recovery_epoch: { state: "bound", value: "33333333-3333-4333-8333-333333333333" },
      control_plane: { state: "kubernetes-active",
        namespaces: [{ api_version: "v1", kind: "Namespace", name: "hcce", uid: "namespace-uid", resource_version: "parent-rv" },
          { api_version: "v1", kind: "Namespace", name: "hcce-bot-runners", uid: "runner-namespace-uid", resource_version: "runner-rv" }],
        namespaced_resources: nsRows.map(([api_version, kind, namespace, name]) => ({ api_version, kind, namespace, name,
          uid: `${namespace}:${kind}:${name}-uid`, resource_version: `${namespace}:${kind}:${name}-rv` })),
        cluster_resources: clusterResources } },
    deployments: deploymentNames.map(name => ({ name, uid: `${name}-uid`, replicas: 1, init_containers: [],
      containers: name === "reticulum" ? ["postgrest", "reticulum"].map(container => ({ name: container,
        image: `ghcr.io/yengalvez/${container}@sha256:${"a".repeat(64)}` })) :
        [{ name: name === "pgsql" ? "postgresql" : name,
          image: `ghcr.io/yengalvez/${repositories[name] || name}@sha256:${"a".repeat(64)}` }] }))
  };
  if (schemaVersion === 5) inventory.backup_authority = canonicalJsonV1(f.authority);
  return inventory;
}

const controlPlaneIdentityPeer = `
recovery_resource_identity_tsv() {
  local scope="$1" resource="$2" name="$3" namespace="\${4:-}" kind
  case "$resource" in
    namespace) kind=Namespace ;; serviceaccount) kind=ServiceAccount ;; role) kind=Role ;;
    rolebinding) kind=RoleBinding ;; configmap) kind=ConfigMap ;; secret) kind=Secret ;;
    resourcequota) kind=ResourceQuota ;; networkpolicy) kind=NetworkPolicy ;;
    validatingadmissionpolicy) kind=ValidatingAdmissionPolicy ;;
    validatingadmissionpolicybinding) kind=ValidatingAdmissionPolicyBinding ;; *) return 99 ;;
  esac
  printf 'identity:%s:%s:%s:%s\\n' "$scope" "$resource" "$name" "$namespace" >&2
  jq -er --arg scope "$scope" --arg kind "$kind" --arg name "$name" --arg namespace "$namespace" \\
    --arg drift "\${IDENTITY_DRIFT:-}" '
    .bot_runner_runtime.control_plane |
    (if $kind=="Namespace" then .namespaces else
      if $scope=="namespaced" then .namespaced_resources else .cluster_resources end end) |
    [.[]|select(.kind==$kind and .name==$name and ($scope=="cluster" or .namespace==$namespace))] |
    select(length==1) | .[0] |
    [.api_version,.kind] + (if $scope=="namespaced" then [.namespace] else [] end) +
    [.name,(.uid + if .name==$drift then "-wrong" else "" end)] | @tsv
  ' "$INVENTORY_TEST_PATH"
}
recovery_kubectl() {
  [[ "$1" == get && "$2" == deployment && ( "$3" == reticulum || "$3" == bot-orchestrator ) ]] || return 99
  printf 'epoch-deployment:%s\\n' "$3" >&2
  jq -cn --arg name "$3" --arg epoch "\${LIVE_EPOCH:-33333333-3333-4333-8333-333333333333}" '
    {apiVersion:"apps/v1",kind:"Deployment",metadata:{name:$name,namespace:"hcce"},
      spec:{template:{metadata:{annotations:{"yenhubs.org/bot-runner-recovery-epoch":$epoch}}}}}'
}
`;

for (const helper of ["recovery_require_live_runner_control_plane_matches_checkpoint",
  "recovery_require_durable_checkpoint_source_matches_live"]) {
  test(`signed format dispatch inventory5 preserves every live UID check in ${helper}`, t => {
    const f = fixture(t, { durable: true });
    const inventoryPath = path.join(f.directory, "public-inventory.json");
    const check = (inventory, env = {}) => {
      fs.writeFileSync(inventoryPath, canonicalJsonV1(inventory), { mode: 0o600 });
      return run(f, `NAMESPACE=hcce\nRECOVERY_CHECKPOINT_RUNNER_GENERATION=durable-v2\n${controlPlaneIdentityPeer}\n${helper} "$INVENTORY_TEST_PATH"`, {},
        { INVENTORY_TEST_PATH: inventoryPath, ...env });
    };
    for (const schema of [4, 5]) {
      const result = check(durableInventory(f, schema));
      assert.equal(result.status, 0, `schema${schema}: ${result.stderr}`);
      const identities = result.stderr.split("\n").filter(line => line.startsWith("identity:"));
      assert.equal(identities.length, 24);
      assert.equal(identities.filter(line => line.startsWith("identity:namespaced:")).length, 13);
      assert.equal(identities.filter(line => line.startsWith("identity:cluster:")).length, 11);
      if (helper.includes("durable_checkpoint_source")) {
        assert.equal(result.stderr.split("\n").filter(line => line.startsWith("epoch-deployment:")).length, 2);
      }
    }
    const valid = durableInventory(f);
    const invalidBinding = structuredClone(valid);
    const altered = structuredClone(f.authority); altered.namespace.uid = "other-namespace-uid";
    invalidBinding.backup_authority = canonicalJsonV1(altered);
    assert.notEqual(check(invalidBinding).status, 0);
    assert.notEqual(check(valid, { IDENTITY_DRIFT: "bot-runner-egress" }).status, 0);
    assert.notEqual(check(valid, { RESTORE_TARGET_MODE: "cold-rebind" }).status, 0);
    if (helper.includes("durable_checkpoint_source")) {
      assert.notEqual(check(valid, { LIVE_EPOCH: "44444444-4444-4444-8444-444444444444" }).status, 0);
    }
  });
}

test("signed format dispatch freeze-v2 preserves the closed exact process-local predicate", t => {
  const f = fixture(t);
  const library = fs.readFileSync(path.join(root, "deployment/lib/recovery-safety.sh"), "utf8");
  const extract = name => {
    const body = library.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, "m"));
    assert.ok(body, `missing actual shared function ${name}`);
    return body[0];
  };
  const functions = ["recovery_backup_authority_is_selected",
    "recovery_require_live_process_local_freeze_checkpoint_exact"].map(extract).join("\n");
  const dispatch = (format, mode, selected, downstreamStatus = 0) => spawnSync(shell, ["-c", `
set -Eeuo pipefail
${functions}
recovery_require_live_process_local_runner_contract_exact() {
  [[ "$1" == /synthetic/public-values-path && "$2" == freeze-checkpoint ]] || return 99
  printf 'exact-freeze-checkpoint-predicate\\n'
  return ${downstreamStatus}
}
recovery_require_live_process_local_freeze_checkpoint_exact /synthetic/public-values-path "$1" "$2" "$3"
`, "freeze-gate", format, mode, "unused", String(downstreamStatus)], {
    cwd: root, encoding: "utf8", timeout: 30000,
    env: { PATH: process.env.PATH, RECOVERY_BACKUP_AUTHORITY_KEYRING: selected ? f.keyringPath : "",
      RECOVERY_BACKUP_AUTHORITY_KEY_ID: selected ? keyId : "" }
  });
  for (const [format, selected] of [["freeze-bundle-v1", false], ["freeze-bundle-v2", true]]) {
    const result = dispatch(format, "process-local", selected);
    assert.equal(result.status, 0, `${format}: ${result.stderr}`);
    assert.equal(result.stdout, "exact-freeze-checkpoint-predicate\n");
  }
  for (const args of [["freeze-bundle-v2", "process-local", false],
    ["freeze-bundle-v2", "durable-v2", true], ["freeze-bundle-v1", "durable-v2", false],
    ["unknown", "process-local", true]]) {
    const result = dispatch(...args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
  }
  const fullPredicateFailure = dispatch("freeze-bundle-v2", "process-local", true, 19);
  assert.equal(fullPredicateFailure.status, 19);
});

function rollingBoundaryFixture(f) {
  const deployment = structuredClone(f.deployments[0]);
  deployment.metadata.annotations["deployment.kubernetes.io/revision"] = "1";
  deployment.spec.strategy = { type: "RollingUpdate", rollingUpdate: { maxSurge: "25%", maxUnavailable: "25%" } };
  deployment.status = { observedGeneration: deployment.metadata.generation,
    replicas: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1, unavailableReplicas: 0 };
  const replicaSet = {
    apiVersion: "apps/v1", kind: "ReplicaSet",
    metadata: { name: "bot-orchestrator-abc", namespace: "hcce", uid: "rs-uid", resourceVersion: "rs-rv",
      generation: 7, labels: { app: "bot-orchestrator" }, annotations: { "deployment.kubernetes.io/revision": "1" },
      ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: "bot-orchestrator",
        uid: deployment.metadata.uid, controller: true }] },
    spec: { replicas: 1, selector: { matchLabels: { app: "bot-orchestrator", "pod-template-hash": "abc" } },
      template: structuredClone(deployment.spec.template) },
    status: { replicas: 1, readyReplicas: 1, availableReplicas: 1 }
  };
  replicaSet.spec.template.metadata.labels["pod-template-hash"] = "abc";
  const pod = { apiVersion: "v1", kind: "Pod",
    metadata: { name: "bot-orchestrator-abc-pod", namespace: "hcce", uid: "pod-uid",
      labels: { app: "bot-orchestrator", "pod-template-hash": "abc" },
      ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: replicaSet.metadata.name,
        uid: replicaSet.metadata.uid, controller: true }] },
    status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] } };
  const ready = { deployment, hpa: { apiVersion: "autoscaling/v2", kind: "HorizontalPodAutoscalerList", items: [] },
    replicaSets: { apiVersion: "apps/v1", kind: "ReplicaSetList", metadata: { resourceVersion: "rs-list-rv" }, items: [replicaSet] },
    pods: { apiVersion: "v1", kind: "PodList", metadata: { resourceVersion: "pod-list-rv" }, items: [pod] } };
  const zero = structuredClone(ready);
  zero.deployment.spec.replicas = 0; zero.deployment.metadata.generation += 1;
  zero.deployment.metadata.resourceVersion = "paused-rv";
  zero.deployment.status = { observedGeneration: zero.deployment.metadata.generation,
    replicas: 0, updatedReplicas: 0, readyReplicas: 0, availableReplicas: 0, unavailableReplicas: 0 };
  zero.replicaSets.items[0].spec.replicas = 0;
  zero.replicaSets.items[0].status = { replicas: 0, readyReplicas: 0, availableReplicas: 0 };
  zero.replicaSets.items[0].metadata.generation += 1;
  zero.replicaSets.items[0].metadata.resourceVersion = "rs-paused-rv";
  zero.pods.items = [];
  return { ready, zero };
}

for (const boundary of ["locked-ready", "paused-zero"]) {
  test(`signed format dispatch positive RollingUpdate proves ${boundary} before backup/reopen`, t => {
    const f = fixture(t), payload = rollingBoundaryFixture(f);
    const main = source.slice(source.indexOf('RECOVERY_CHECKPOINT_STAMP="$TIMESTAMP"\n'));
    const assignment = main.indexOf('  CHECKPOINT_PROCESS_LOCAL_ROLLING_PARENT_CONTRACT="$(\n');
    assert.ok(assignment >= 0);
    const lockedStart = main.lastIndexOf("\nif [[ ", assignment);
    const lockedEnd = main.indexOf("\n\nrecovery_require_operation_serialization", assignment);
    assert.ok(lockedStart >= 0 && lockedEnd > assignment);
    const lockedBlock = main.slice(lockedStart, lockedEnd);
    const quiesce = source.match(/^quiesce_writers\(\) \{\n[\s\S]*?^\}/m)[0];
    const parentStart = quiesce.indexOf("  index=3\n");
    const parentEnd = quiesce.indexOf("  recovery_require_consumer_contract_entry", parentStart);
    assert.ok(parentStart >= 0 && parentEnd > parentStart);
    // Only the actual parent-stop dispatch is selected, before runner drain,
    // other writers or byte streams. The boundary predicate itself is real.
    const pauseBlock = `selected_parent_pause() {\n  local index rolling_scale_result rolling_zero_contract rolling_generation\n${quiesce.slice(parentStart, parentEnd)}\n}\nselected_parent_pause`;
    const check = (value, phase) => run(f, `
IFS= read -r payload || [[ -n "$payload" ]]
NAMESPACE=hcce
API_PHASE=ready
recovery_kubectl() {
  printf 'boundary-api:%s:%s:%s\\n' "$API_PHASE" "$2" "$3" >&2
  if [[ "$1" == get && "$2" == deployment && "$3" == bot-orchestrator ]]; then
    jq -ce --arg phase "$API_PHASE" '.[$phase].deployment' <<<"$payload"
  elif [[ "$1" == get && "$2" == --raw ]]; then
    jq -ce --arg phase "$API_PHASE" '.[$phase].pods' <<<"$payload"
  else return 99; fi
}
recovery_kubectl_get_namespaced_list() {
  printf 'boundary-api:%s:%s:list\\n' "$API_PHASE" "$1" >&2
  case "$1" in
    horizontalpodautoscalers) jq -ce --arg phase "$API_PHASE" '.[$phase].hpa' <<<"$payload" ;;
    replicasets) jq -ce --arg phase "$API_PHASE" '.[$phase].replicaSets' <<<"$payload" ;;
    *) return 99 ;;
  esac
}
CHECKPOINT_PROCESS_LOCAL_ROLLING_PRELOCK_CONTRACT="$(recovery_capture_process_local_freeze_parent_boundary_exact ready-one)"
CHECKPOINT_PROCESS_LOCAL_ROLLING_PARENT_CONTRACT=""
CHECKPOINT_PROCESS_LOCAL_ROLLING=0
CHECKPOINT_SIGNED_PROCESS_LOCAL_ROLLING=1
CONSUMERS=(reticulum pgbouncer pgbouncer-t bot-orchestrator coturn)
ORIGINAL_REPLICAS=(1 1 1 1 1)
DEPLOYMENT_UIDS=(unused unused unused bot-orchestrator-uid unused)
DEPLOYMENT_RESOURCE_VERSIONS=(unused unused unused rv-0 unused)
DEPLOYMENT_SELECTORS=(reticulum pgbouncer pgbouncer-t bot-orchestrator coturn)
DEPLOYMENT_FINGERPRINTS=(unused unused unused unused unused)
checkpoint_set_failure_context() { :; }
recovery_scale_deployment_exact() { printf 'paused-rv\\n'; }
recovery_scale_process_local_freeze_parent_replicas_exact() { printf 'old-scaler-used\\n' >&2; return 99; }
recovery_wait_for_no_pods() { :; }
${boundary === "paused-zero" ? lockedBlock : ""}
printf 'BEGIN-DISPATCH\\n' >&2
API_PHASE=${phase}
${boundary === "locked-ready" ? lockedBlock : pauseBlock}
printf 'DISPATCH-FINISHED\\n' >&2
`, value);
    const result = check(payload, boundary === "locked-ready" ? "ready" : "zero");
    assert.equal(result.status, 0, result.stderr);
    const dispatchTrace = result.stderr.split("BEGIN-DISPATCH\n")[1];
    assert.match(dispatchTrace, /boundary-api:[^:]+:horizontalpodautoscalers:list/u);
    assert.match(dispatchTrace, /boundary-api:[^:]+:replicasets:list/u);
    assert.ok(!dispatchTrace.includes("old-scaler-used"));
    for (const drift of ["rs-uid", "hpa", "status", "generation"]) {
      const changed = structuredClone(payload), phase = boundary === "locked-ready" ? "ready" : "zero";
      // Keep pre-lock ready immutable; the peer introduces drift only when
      // the selected actual locked/paused dispatch starts.
      changed.drifted = structuredClone(changed[phase]);
      if (drift === "rs-uid") {
        changed.drifted.replicaSets.items[0].metadata.uid = "other-rs-uid";
        if (changed.drifted.pods.items[0]) {
          changed.drifted.pods.items[0].metadata.ownerReferences[0].uid = "other-rs-uid";
        }
      } else if (drift === "hpa") {
        changed.drifted.hpa.items = [{ spec: { scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name: "bot-orchestrator" } } }];
      } else if (drift === "status") changed.drifted.deployment.status.observedGeneration -= 1;
      else {
        changed.drifted.deployment.metadata.generation += 1;
        changed.drifted.deployment.status.observedGeneration += 1;
      }
      const bad = check(changed, "drifted");
      assert.notEqual(bad.status, 0, `${boundary}/${drift} was accepted`);
      assert.ok(!bad.stderr.includes("DISPATCH-FINISHED"));
    }
  });
}

test("signed projections use raw canonical JSON UTF8 SHA256 and no reversible fingerprint", t => {
  const f = fixture(t), d = f.deployments[4];
  const r = run(f, 'NAMESPACE=hcce\nrecovery_backup_authority_transform projection reticulum hcce', [d]);
  assert.equal(r.status, 0, r.stderr);
  const fields = r.stdout.split("\t");
  assert.equal(fields[4], sha(canonicalJsonV1({ selector: d.spec.selector,
    strategy: d.spec.strategy, template: d.spec.template })));
  assert.match(fields[4], /^[a-f0-9]{64}$/u);
  assert.ok(!r.stdout.includes(canary) && !r.stderr.includes(canary));
});

test("consumer3 accepts only the exact signed authority2 pair/digest", t => {
  const f = fixture(t);
  const check = pair => run(f, "recovery_backup_authority_transform consumer-valid", pair);
  assert.equal(check([f.authority, f.consumerContract]).status, 0);
  for (const change of [c => { c.schema_version = 2; }, c => { c.authority_sha256 = "f".repeat(64); },
    c => { c.consumers[0].original_replicas = 0; }, c => { c.consumers[0].fingerprint = "QQ=="; }]) {
    const changed = structuredClone(f.consumerContract); change(changed);
    assert.notEqual(check([f.authority, changed]).status, 0);
  }
});

test("lock exactness requires only seven binding annotations, label and canonical signed public data", t => {
  const f = fixture(t);
  const check = lock => run(f, "recovery_backup_authority_transform lock lock-uid lock-rv",
    [lock, f.lockBinding, f.authority]);
  assert.equal(check(f.lock).status, 0);
  for (const change of [d => { d.data = {}; }, d => { d.data.extra = "untrusted"; },
    d => { d.data["checkpoint-backup-authority.json"] += "\n"; },
    d => { d.metadata.annotations.extra = "untrusted"; },
    d => { d.metadata.annotations["yenhubs.org/recovery-token"] = "c".repeat(32); },
    d => { d.binaryData = { extra: "QQ==" }; }]) {
    const changed = structuredClone(f.lock); change(changed); assert.notEqual(check(changed).status, 0);
  }
});

test("original recapture rejects UID, RV, generation and full-spec drift before lock/first pause", t => {
  const f = fixture(t);
  const check = after => run(f, "recovery_backup_authority_transform original-exact", [f.deployments, after]);
  assert.equal(check(f.deployments).status, 0);
  for (const change of [d => { d.metadata.uid += "-other"; }, d => { d.metadata.resourceVersion += "-other"; },
    d => { d.metadata.generation += 1; }, d => { d.spec.progressDeadlineSeconds += 1; }]) {
    const changed = structuredClone(f.deployments); change(changed[3]); assert.notEqual(check(changed).status, 0);
  }
});

test("phase journal is exact: positive G+1 pause, G+2 receipt, G+3 clear; original zero unchanged", t => {
  const f = fixture(t, { replicas: [0, 1, 1, 1, 1] });
  function check(name, phase, d, original) {
    return run(f, `recovery_backup_authority_transform state ${name} ${phase}`, [f.authority, d, original]);
  }
  const original = f.deployments[4], paused = structuredClone(original);
  paused.spec.replicas = 0; paused.metadata.generation += 1; paused.metadata.resourceVersion = "paused-rv";
  assert.equal(check("reticulum", "paused", paused, original).status, 0);
  const resumed = structuredClone(original);
  resumed.metadata.generation += 2; resumed.metadata.resourceVersion = "resumed-rv";
  resumed.metadata.annotations[receipt] = f.authority.operation_id;
  assert.equal(check("reticulum", "resumed", resumed, original).status, 0);
  const cleared = structuredClone(resumed); delete cleared.metadata.annotations[receipt];
  cleared.metadata.generation += 1; cleared.metadata.resourceVersion = "cleared-rv";
  assert.equal(check("reticulum", "cleared", cleared, original).status, 0);
  for (const phase of ["original", "paused", "resumed", "cleared"]) {
    assert.equal(check("bot-orchestrator", phase, f.deployments[0], f.deployments[0]).status, 0);
  }
  const zeroDrift = structuredClone(f.deployments[0]); zeroDrift.metadata.resourceVersion = "new-status-rv";
  assert.notEqual(check("bot-orchestrator", "paused", zeroDrift, f.deployments[0]).status, 0);
  for (const change of [d => { d.metadata.generation += 1; }, d => { d.spec.revisionHistoryLimit += 1; },
    d => { d.metadata.labels.extra = "drift"; }, d => { d.metadata.annotations[receipt] = "other"; }]) {
    const changed = structuredClone(paused); change(changed);
    assert.notEqual(check("reticulum", "paused", changed, original).status, 0);
  }
});

test("stdin patch binds UID/RV/generation/full spec; BASE-zero mutation function returns without PATCH", t => {
  const f = fixture(t, { replicas: [0, 0, 0, 0, 0] }), d = f.deployments[4];
  const p = run(f, "recovery_backup_authority_transform patch 0 '' scale", [d]);
  assert.equal(p.status, 0, p.stderr);
  const patch = JSON.parse(p.stdout);
  assert.deepEqual(patch.find(p => p.path === "/spec"), { op: "test", path: "/spec", value: d.spec });
  assert.equal(patch.find(p => p.path === "/metadata/generation").value, d.metadata.generation);
  const result = run(f, `
IFS= read -r payload || [[ -n "$payload" ]]
NAMESPACE=hcce
RECOVERY_OPERATION_ID=0123456789abcdef0123456789abcdef
deployment="$(jq -c . <<<"$payload")"
recovery_require_operation_serialization() { :; }
recovery_require_operation_lock() { :; }
recovery_kubectl() { printf '%s' "$deployment"; }
recovery_backup_authority_require_state() { jq -r .metadata.resourceVersion <<<"$deployment"; }
recovery_kubectl_mutate() { printf 'unexpected-patch\\n' >&2; return 99; }
contract="$(recovery_deployment_contract_from_json reticulum <<<"$deployment")"
IFS=$'\\t' read -r uid rv replicas selector fingerprint <<<"$contract"
recovery_backup_authority_mutate_deployment reticulum "$uid" "$rv" 0 0 "$selector" "$fingerprint" '' scale
`, d);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), d.metadata.resourceVersion);
  assert.ok(!result.stderr.includes("unexpected-patch"));
});

test("operational full-spec HMAC revalidation survives a fresh shell and rejects a hidden non-target spec change", t => {
  const f = fixture(t);
  const script = `
IFS= read -r payload || [[ -n "$payload" ]]
NAMESPACE=hcce
RECOVERY_NAMESPACE_UID=namespace-uid
RECOVERY_PVC_UID=pvc-uid
RECOVERY_OPERATION_ID=0123456789abcdef0123456789abcdef
RECOVERY_CHECKPOINT_STAMP=20261003-120000
RECOVERY_DUMP_SHA256="$(printf '0%.0s' {1..64})"
RECOVERY_STORAGE_SHA256="$RECOVERY_DUMP_SHA256"
RECOVERY_BACKUP_AUTHORITY_JSON="$(jq -c .authority <<<"$payload")"
RECOVERY_BACKUP_AUTHORITY_JSON="$(printf '%s' "$RECOVERY_BACKUP_AUTHORITY_JSON" | jq -cs . | recovery_backup_authority_transform consumer >/dev/null; command node --input-type=module -e '
import fs from "node:fs";import {canonicalJsonV1} from "./deployment/recovery-checkpoint-authority.mjs";
process.stdout.write(canonicalJsonV1(JSON.parse(fs.readFileSync(0,"utf8"))));' <<<"$RECOVERY_BACKUP_AUTHORITY_JSON")"
RECOVERY_CONSUMER_CONTRACT_JSON="$(jq -c .consumerContract <<<"$payload")"
lock="$(jq -c .lock <<<"$payload")"
deployments="$(jq -c .deployments <<<"$payload")"
[[ -z "$RECOVERY_BACKUP_AUTHORITY_ORIGINALS_JSON" && -z "\${RECOVERY_OPERATION_TOKEN:-}" ]]
recovery_backup_authority_validate_specs "$lock" "$deployments"
`;
  const good = run(f, script, f);
  assert.equal(good.status, 0, good.stderr);
  const changed = structuredClone(f); changed.deployments[1].spec.progressDeadlineSeconds += 1;
  const bad = run(f, script, changed);
  assert.notEqual(bad.status, 0);
  assert.ok(!good.stdout.includes(canary) && !good.stderr.includes(canary) && !bad.stderr.includes(canary));
});

test("explicit selection rejects missing half, relative paths and unknown keys without creating a record", t => {
  const f = fixture(t);
  for (const environment of [{ RECOVERY_BACKUP_AUTHORITY_KEY_ID: "" },
    { RECOVERY_BACKUP_AUTHORITY_KEYRING: "" },
    { RECOVERY_BACKUP_AUTHORITY_KEYRING: "relative/keyring" },
    { RECOVERY_BACKUP_AUTHORITY_KEY_ID: "87654321-4321-4abc-8def-1234567890ab" }]) {
    const before = fs.readdirSync(f.keyringPath);
    const result = run(f, "recovery_validate_backup_authority_selection", {}, environment);
    assert.notEqual(result.status, 0);
    assert.deepEqual(fs.readdirSync(f.keyringPath), before);
  }
});

test("producer source orders signer/recaptures/receipt before first pause and transports no private patch argv", () => {
  const main = source.slice(source.indexOf('RECOVERY_CHECKPOINT_STAMP="$TIMESTAMP"\n'));
  assert.ok(main.indexOf("recovery_backup_authority_prepare") < main.indexOf("acquire_checkpoint_operation_lock"));
  assert.ok(main.indexOf("persist_checkpoint_abort_receipt") < main.indexOf("quiesce_writers\n"));
  const library = fs.readFileSync(path.join(root, "deployment/lib/recovery-safety.sh"), "utf8");
  const signedCas = library.match(/^recovery_backup_authority_mutate_deployment\(\) \{\n[\s\S]*?^\}/m)[0];
  assert.match(signedCas, /--patch-file=\/dev\/stdin/u);
  assert.doesNotMatch(signedCas, /--patch=|--argjson (?:spec|before|after)|export .*patch/u);
  assert.match(library, /export -n RECOVERY_OPERATION_TOKEN/u);
});

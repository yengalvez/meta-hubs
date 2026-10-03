import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  validateSignedCheckpointInventory,
  validateSignedCheckpointPublicBinding
} from "../../deployment/checkpoint-backup-formats.mjs";
import { canonicalJsonV1 } from "../../deployment/recovery-checkpoint-authority.mjs";

const names = ["bot-orchestrator", "coturn", "pgbouncer", "pgbouncer-t", "reticulum"];
const operationId = "0123456789abcdef0123456789abcdef";
const script = fileURLToPath(new URL("../../deployment/checkpoint-backup-formats.mjs", import.meta.url));
const cliError = "checkpoint_backup_formats_failed\n";

// Public-frontier fixtures deliberately contain no key, token, private lock or
// full Deployment spec. Their synthetic signature is not live HMAC evidence.
function fixture({ replicas = 0, durable = false } = {}) {
  const authority = {
    schema_version: 2,
    operation_id: operationId,
    namespace: { name: "hcce", uid: "namespace-uid" },
    pvc: { name: "ret-pvc", uid: "pvc-uid" },
    hmac_profile: "yenhubs-checkpoint-backup-authority-hmac-v2",
    hmac_key_id: "12345678-1234-4234-8234-123456789abc",
    runner_generation: durable ? "durable-v2" : "legacy-absent",
    operation_fence: durable ? {
      state: "dormant",
      namespaces: {
        parent: {
          name: "hcce", uid: "namespace-uid", initial_resource_version: "parent-rv",
          phase: "Active", metadata_name_label: "hcce"
        },
        runner: {
          name: "hcce-bot-runners", uid: "runner-namespace-uid", initial_resource_version: "runner-rv",
          phase: "Active", metadata_name_label: "hcce-bot-runners"
        }
      },
      policy: {
        uid: "policy-uid", initial_resource_version: "policy-rv",
        initial_generation: 1, spec_sha256: "a".repeat(64)
      },
      binding: {
        uid: "binding-uid", initial_resource_version: "binding-rv",
        dormant_spec_sha256: "b".repeat(64), active_spec_sha256: "c".repeat(64)
      }
    } : null,
    consumers: names.map((name, index) => ({
      name, uid: `${name}-uid`, initial_resource_version: `rv-${index}`,
      initial_generation: index + 1, original_replicas: replicas, selector: name
    })),
    authority_hmac_sha256: "f".repeat(64)
  };
  const backupAuthority = canonicalJsonV1(authority);
  const consumerContract = {
    schema_version: 3,
    operation_id: operationId,
    authority_sha256: createHash("sha256").update(backupAuthority).digest("hex"),
    consumers: structuredClone(authority.consumers)
  };
  const inventory = {
    schema_version: 5, namespace: "hcce", namespace_uid: "namespace-uid",
    backup_authority: backupAuthority,
    bot_runner_runtime: durable ? {
      generation: "durable-v2", mode: "kubernetes-pod", image: "public-image",
      recovery_epoch: { state: "bound", value: "33333333-3333-4333-8333-333333333333" },
      control_plane: {
        state: "kubernetes-active",
        namespaces: [
          { api_version: "v1", kind: "Namespace", name: "hcce", uid: "namespace-uid", resource_version: "parent-rv" },
          { api_version: "v1", kind: "Namespace", name: "hcce-bot-runners", uid: "runner-namespace-uid", resource_version: "runner-rv" }
        ],
        namespaced_resources: [],
        cluster_resources: [
          {
            api_version: "admissionregistration.k8s.io/v1", kind: "ValidatingAdmissionPolicy",
            name: "recovery-operation-pod-fence.yenhubs.org", uid: "policy-uid", resource_version: "policy-rv"
          },
          {
            api_version: "admissionregistration.k8s.io/v1", kind: "ValidatingAdmissionPolicyBinding",
            name: "recovery-operation-pod-fence.yenhubs.org", uid: "binding-uid", resource_version: "binding-rv"
          }
        ]
      }
    } : {
      generation: "legacy-absent", mode: "process-local", image: null,
      recovery_epoch: { state: "legacy-absent" }, control_plane: { state: "legacy-absent" }
    },
    deployments: names.map(name => ({
      name, uid: `${name}-uid`, replicas, containers: [{ name, image: "public-image" }], init_containers: []
    }))
  };
  const metadata = {
    schema_version: 4,
    provenance: { generator: "yenhubs-local-coordinated-checkpoint-v4", external_import: false },
    stamp: "20261003-120000", created_at_utc: "2026-10-03T12:00:00Z", created_at_epoch: 1791028800,
    kube_context: "fixture", namespace: "hcce", namespace_uid: "namespace-uid",
    ret_pvc_uid: "pvc-uid", operation_id: operationId,
    runtime_generation: authority.runner_generation,
    runner_cutover_evidence_sha256: "e".repeat(64),
    writer_quiescence: {
      required: true, started_at_utc: "2026-10-03T12:00:00Z", completed_at_utc: "2026-10-03T12:00:01Z"
    },
    backup_authority: backupAuthority, consumer_contract: consumerContract
  };
  const freeze = {
    schema: "freeze-bundle-v2", client_instance_id: "client-001", freeze_id: operationId,
    stamp: metadata.stamp, created_at_utc: metadata.created_at_utc,
    source: {
      kube_context: "fixture", cluster: { name: "fixture-cluster", uid: "cluster-uid" },
      namespace: { name: "hcce", uid: "namespace-uid" }, pvc: { name: "ret-pvc", uid: "pvc-uid" }
    },
    operation: {
      id: operationId,
      quiescence: {
        started_at_utc: metadata.writer_quiescence.started_at_utc,
        completed_at_utc: metadata.writer_quiescence.completed_at_utc
      }
    },
    payloads: {
      database: { filename: `retdb-${metadata.stamp}.sql.gz`, size_bytes: 1, sha256: "d".repeat(64) },
      storage: { filename: `ret-storage-${metadata.stamp}.tar.gz`, size_bytes: 2, sha256: "c".repeat(64) }
    },
    runtime_generation: "legacy-absent", runner_mode: "process-local",
    provenance: { generator: "yenhubs-freeze-bundle-v2", external_import: false },
    minimum_restore_version: 2, publication_state: "complete",
    backup_authority: backupAuthority, consumer_contract: structuredClone(consumerContract)
  };
  return { authority, inventory, metadata, freeze };
}

function rejects(callback, pattern = /checkpoint_backup_|authority_|canonical_json_/) {
  assert.throws(callback, pattern);
}

test("inventory5 and metadata4 bind the same public authority2/consumer3 for zero and positive originals", () => {
  for (const replicas of [0, 1]) {
    for (const durable of [false, true]) {
      const value = fixture({ replicas, durable });
      const before = canonicalJsonV1(value);
      const inventory = validateSignedCheckpointInventory(value.inventory);
      const binding = validateSignedCheckpointPublicBinding({ metadata: value.metadata, inventory: value.inventory });
      assert.equal(binding.originalBotReplicas, replicas);
      assert.equal(canonicalJsonV1(binding.authority), canonicalJsonV1(value.authority));
      assert.equal(canonicalJsonV1(binding.consumerContract), canonicalJsonV1(value.metadata.consumer_contract));
      assert.equal(canonicalJsonV1(inventory), canonicalJsonV1(binding));
      assert.equal(canonicalJsonV1(value), before);
    }
  }
});

test("freeze-v2 is explicitly process-local/legacy-absent with minimum restore2", () => {
  const value = fixture();
  assert.equal(validateSignedCheckpointPublicBinding({ metadata: value.freeze, inventory: value.inventory }).originalBotReplicas, 0);
  for (const mutate of [
    metadata => { metadata.minimum_restore_version = 1; },
    metadata => { metadata.provenance.generator = "yenhubs-freeze-bundle-v1"; },
    metadata => { metadata.runner_mode = "kubernetes-pod"; },
    metadata => { metadata.runtime_generation = "durable-v2"; },
    metadata => { metadata.operation.id = "1".repeat(32); },
    metadata => { metadata.source.pvc.name = "other-pvc"; },
    metadata => { metadata.payloads.storage.filename = "other.tar.gz"; }
  ]) {
    const metadata = structuredClone(value.freeze);
    mutate(metadata);
    rejects(() => validateSignedCheckpointPublicBinding({ metadata, inventory: value.inventory }));
  }
  const durable = fixture({ durable: true });
  rejects(() => validateSignedCheckpointPublicBinding({ metadata: durable.freeze, inventory: durable.inventory }));
});

test("new readers reject old, unknown and coerced outer versions without fallback", () => {
  for (const version of [3, 4, 6, "5"]) {
    const value = fixture();
    value.inventory.schema_version = version;
    rejects(() => validateSignedCheckpointInventory(value.inventory));
    rejects(() => validateSignedCheckpointPublicBinding({ metadata: value.metadata, inventory: value.inventory }));
    rejects(() => validateSignedCheckpointPublicBinding({ metadata: value.freeze, inventory: value.inventory }));
  }
  for (const version of [3, 5, "4"]) {
    const value = fixture();
    value.metadata.schema_version = version;
    rejects(() => validateSignedCheckpointPublicBinding({ metadata: value.metadata, inventory: value.inventory }));
  }
  const value = fixture();
  value.freeze.schema = "freeze-bundle-v1";
  rejects(() => validateSignedCheckpointPublicBinding({ metadata: value.freeze, inventory: value.inventory }));
});

test("inventory binds every signed UID and original replica, and operational bot2 is refused", () => {
  for (let index = 0; index < names.length; index += 1) {
    for (const field of ["uid", "replicas"]) {
      const value = fixture();
      value.inventory.deployments[index][field] = field === "uid" ? "crossed-uid" : 1;
      rejects(() => validateSignedCheckpointInventory(value.inventory), /consumer_binding/);
    }
  }
  for (const mutate of [
    inventory => { inventory.deployments.pop(); },
    inventory => { inventory.deployments.push(structuredClone(inventory.deployments[0])); },
    inventory => { inventory.namespace = "other"; },
    inventory => { inventory.namespace_uid = "other-uid"; },
    inventory => { inventory.bot_runner_runtime.generation = "durable-v2"; },
    inventory => { inventory.bot_runner_runtime.mode = "kubernetes-pod"; }
  ]) {
    const value = fixture();
    mutate(value.inventory);
    rejects(() => validateSignedCheckpointInventory(value.inventory));
  }
  rejects(() => validateSignedCheckpointInventory(fixture({ replicas: 2 }).inventory), /bot_replicas/);
});

test("metadata identity, operation, generation, authority bytes and exact consumer3 digest are bound", () => {
  for (const mutate of [
    metadata => { metadata.namespace = "other"; },
    metadata => { metadata.namespace_uid = "other-uid"; },
    metadata => { metadata.ret_pvc_uid = "other-pvc-uid"; },
    metadata => { metadata.operation_id = "1".repeat(32); },
    metadata => { metadata.runtime_generation = "durable-v2"; },
    metadata => { metadata.provenance.generator = "yenhubs-local-coordinated-checkpoint-v3"; },
    metadata => { metadata.consumer_contract.schema_version = 2; },
    metadata => { metadata.consumer_contract.authority_sha256 = "0".repeat(64); },
    metadata => { metadata.consumer_contract.operation_id = "1".repeat(32); },
    metadata => { metadata.consumer_contract.consumers.reverse(); },
    metadata => { metadata.consumer_contract.consumers[0].uid = "crossed-uid"; },
    metadata => { metadata.consumer_contract.consumers[0].original_replicas = 1; },
    metadata => { metadata.consumer_contract.consumers[0].fingerprint = "forbidden"; },
    metadata => { metadata.consumer_contract.token = "forbidden"; },
    metadata => { metadata.backup_authority = metadata.backup_authority.replace('"authority_hmac_sha256":"' + "f".repeat(64), '"authority_hmac_sha256":"' + "a".repeat(64)); }
  ]) {
    const value = fixture();
    mutate(value.metadata);
    rejects(() => validateSignedCheckpointPublicBinding({ metadata: value.metadata, inventory: value.inventory }));
  }
});

test("public frontier rejects noncanonical authorities, authority1/consumer3, and extra private fields", () => {
  for (const mutate of [
    value => { value.inventory.backup_authority += "\n"; },
    value => { value.inventory.backup_authority = value.authority; },
    value => {
      value.authority.schema_version = 1;
      value.authority.hmac_profile = "yenhubs-checkpoint-backup-authority-hmac-v1";
      value.authority.consumers.forEach(consumer => { consumer.original_replicas = 1; });
      value.inventory.backup_authority = canonicalJsonV1(value.authority);
    },
    value => { value.authority.schema_version = 3; value.inventory.backup_authority = canonicalJsonV1(value.authority); },
    value => { value.authority.consumers.reverse(); value.inventory.backup_authority = canonicalJsonV1(value.authority); },
    value => { value.authority.consumers[0].spec = {}; value.inventory.backup_authority = canonicalJsonV1(value.authority); },
    value => { value.inventory.body = {}; },
    value => { value.inventory.deployments[0].fingerprint = "forbidden"; },
    value => { value.metadata.token = "forbidden"; }
  ]) {
    const value = fixture({ replicas: 1 });
    mutate(value);
    rejects(() => validateSignedCheckpointPublicBinding({ metadata: value.metadata, inventory: value.inventory }));
  }
  const value = fixture();
  rejects(() => validateSignedCheckpointPublicBinding({ metadata: value.metadata, inventory: value.inventory, authenticate: () => true }));
});

test("sparse or accessor-backed public inputs cannot silently normalize into accepted bindings", () => {
  const value = fixture();
  delete value.metadata.consumer_contract.consumers[0];
  rejects(() => validateSignedCheckpointPublicBinding({ metadata: value.metadata, inventory: value.inventory }), /public_json/);
  const durable = fixture({ durable: true });
  durable.inventory.bot_runner_runtime.control_plane.namespaces = new Array(1);
  rejects(() => validateSignedCheckpointInventory(durable.inventory), /public_json/);
  const accessor = fixture();
  let reads = 0;
  Object.defineProperty(accessor.inventory, "namespace", {
    enumerable: true, get() { reads += 1; return "hcce"; }
  });
  rejects(() => validateSignedCheckpointInventory(accessor.inventory), /public_json/);
  assert.equal(reads, 0);
});

for (const [field, mutate] of [
  ["parent namespace UID", fence => { fence.namespaces.parent.uid = "crossed-parent-uid"; }],
  ["runner namespace UID", fence => { fence.namespaces.runner.uid = "crossed-runner-uid"; }],
  ["policy UID", fence => { fence.policy.uid = "crossed-policy-uid"; }],
  ["binding UID", fence => { fence.binding.uid = "crossed-binding-uid"; }]
]) {
  test(`signed operation-fence correlation rejects crossed ${field} against public inventory identities`, () => {
    const value = fixture({ durable: true });
    const inventory = structuredClone(value.inventory);
    const authority = JSON.parse(inventory.backup_authority);
    mutate(authority.operation_fence);
    inventory.backup_authority = canonicalJsonV1(authority);
    const { backup_authority: _originalAuthority, ...originalInventory } = value.inventory;
    const { backup_authority: _crossedAuthority, ...unchangedInventory } = inventory;
    assert.deepEqual(unchangedInventory, originalInventory);
    rejects(() => validateSignedCheckpointInventory(inventory), /operation_fence/);
  });
}

function runCli(args, input) {
  return spawnSync(process.execPath, [script, ...args], {
    input, encoding: "utf8", maxBuffer: 4096, timeout: 10_000
  });
}

function rejectedCli(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, cliError);
}

test("public formats CLI silently validates only canonical public inventory and binding inputs", () => {
  for (const replicas of [0, 1]) {
    for (const durable of [false, true]) {
      const value = fixture({ replicas, durable });
      const inputs = [
        ["validate-inventory", value.inventory],
        ["validate-binding", { metadata: value.metadata, inventory: value.inventory }],
        ...(!durable ? [["validate-binding", { metadata: value.freeze, inventory: value.inventory }]] : [])
      ];
      for (const [command, input] of inputs) {
        const result = runCli([command], canonicalJsonV1(input));
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr, "");
      }
    }
  }
});

test("public formats CLI never normalizes whitespace, duplicate keys, number aliases or invalid UTF8", () => {
  const value = fixture();
  const canonical = canonicalJsonV1(value.inventory);
  const inputs = [
    "", `${canonical}\n`, ` ${canonical}`, JSON.stringify(value.inventory),
    canonical.replace('"schema_version":5', '"schema_version":5.0'),
    canonical.replace('"schema_version":5', '"schema_version":5,"schema_version":5'),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(canonical)]),
    Buffer.from([0xff])
  ];
  for (const input of inputs) rejectedCli(runCli(["validate-inventory"], input));
  rejectedCli(runCli(["validate-binding"], `${canonicalJsonV1({ metadata: value.metadata, inventory: value.inventory })}\n`));
});

test("public formats CLI rejects unknown commands, filenames and all extra arguments with a fixed error", () => {
  const canonical = canonicalJsonV1(fixture().inventory);
  for (const args of [
    [], ["validate"], ["validate-inventory", "public.json"],
    ["validate-inventory", "--keyring", "private.json"],
    ["validate-binding", "--help"], ["validate-inventory", "validate-binding"]
  ]) rejectedCli(runCli(args, canonical));
});

test("public formats CLI rejects crossed signed fields and private payloads without echoing them", () => {
  const sentinel = "SYNTHETIC_PRIVATE_BODY_MUST_NOT_BE_LOGGED";
  const crossed = fixture({ durable: true });
  crossed.authority.operation_fence.namespaces.runner.uid = "crossed-runner-uid";
  crossed.inventory.backup_authority = canonicalJsonV1(crossed.authority);
  rejectedCli(runCli(["validate-inventory"], canonicalJsonV1(crossed.inventory)));
  const privatePayload = fixture();
  rejectedCli(runCli(["validate-inventory"], canonicalJsonV1({ ...privatePayload.inventory, token: sentinel })));
  rejectedCli(runCli(["validate-binding"], canonicalJsonV1({
    metadata: privatePayload.metadata, inventory: privatePayload.inventory, body: { token: sentinel }
  })));
  privatePayload.metadata.consumer_contract.authority_sha256 = "0".repeat(64);
  rejectedCli(runCli(["validate-binding"], canonicalJsonV1({
    metadata: privatePayload.metadata, inventory: privatePayload.inventory
  })));
});

test("public formats CLI accepts exactly8MiB and refuses the next input byte", () => {
  const maximum = 8 * 1024 * 1024;
  const value = fixture();
  const request = { metadata: value.metadata, inventory: value.inventory };
  const overhead = Buffer.byteLength(canonicalJsonV1(request));
  request.metadata.kube_context = "x".repeat(maximum - overhead + request.metadata.kube_context.length);
  const bytes = canonicalJsonV1(request);
  assert.equal(Buffer.byteLength(bytes), maximum);
  const exact = runCli(["validate-binding"], bytes);
  assert.equal(exact.error, undefined);
  assert.equal(exact.status, 0, exact.stderr);
  assert.equal(exact.stdout, "");
  assert.equal(exact.stderr, "");
  request.metadata.kube_context += "x";
  rejectedCli(runCli(["validate-binding"], canonicalJsonV1(request)));
});

test("public formats module import is side-effect free and does not consume CLI inputs", () => {
  const moduleUrl = new URL("../../deployment/checkpoint-backup-formats.mjs", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(moduleUrl)})`], {
    input: "not JSON and must not be read", encoding: "utf8", maxBuffer: 4096, timeout: 10_000
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

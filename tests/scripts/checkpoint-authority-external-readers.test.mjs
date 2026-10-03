import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalJsonV1 } from "../../deployment/recovery-checkpoint-authority.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const scripts = path.join(root, "deployment");
const source = Object.fromEntries([
  "preflight-reactivation.sh", "preflight-greenfield.sh", "restore-checkpoint.sh",
  "lib/recovery-safety.sh"
].map(name => [name, readFileSync(path.join(scripts, name), "utf8")]));
const names = ["bot-orchestrator", "coturn", "pgbouncer", "pgbouncer-t", "reticulum"];
const restoreNames = ["reticulum", "pgbouncer", "pgbouncer-t", "bot-orchestrator", "coturn"];
const operationId = "0123456789abcdef0123456789abcdef";

function shellFunction(file, name) {
  const start = source[file].indexOf(`\n${name}() {\n`);
  assert.notEqual(start, -1, `missing ${name}`);
  const end = source[file].indexOf("\n}\n", start);
  assert.notEqual(end, -1, `unterminated ${name}`);
  return source[file].slice(start + 1, end + 3);
}

function run(script, args = [], env = {}) {
  const result = spawnSync(process.env.YENHUBS_TEST_BASH || "bash", ["-c", script, "fixture", ...args], {
    cwd: root, env: { ...process.env, ...env }, encoding: "utf8", timeout: 10000,
    maxBuffer: 1024 * 1024
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.doesNotMatch(result.stderr, /command not found/u, "a missing real dependency must never be a synthetic PASS");
  return result;
}

// Public fixtures are structural, not original HMAC proof. No private inputs,
// tokens, keys, manifests, DB operations or cluster commands are used here.
function fixture(bot = 0) {
  const authority = {
    schema_version: 2, operation_id: operationId,
    namespace: { name: "hcce", uid: "source-namespace" },
    pvc: { name: "ret-pvc", uid: "source-pvc" },
    hmac_profile: "yenhubs-checkpoint-backup-authority-hmac-v2",
    hmac_key_id: "11111111-1111-4111-8111-111111111111",
    runner_generation: "legacy-absent", operation_fence: null,
    consumers: names.map((name, index) => ({
      name, uid: `source-${name}`, initial_resource_version: `rv-${index}`,
      initial_generation: 1, original_replicas: name === "bot-orchestrator" ? bot : 1,
      selector: name
    })), authority_hmac_sha256: "f".repeat(64)
  };
  const backupAuthority = canonicalJsonV1(authority);
  const inventory = {
    schema_version: 5, namespace: "hcce", namespace_uid: "source-namespace",
    backup_authority: backupAuthority,
    bot_runner_runtime: {
      generation: "legacy-absent", mode: "process-local", image: null,
      recovery_epoch: { state: "legacy-absent" }, control_plane: { state: "legacy-absent" }
    },
    deployments: names.map(name => ({
      name, uid: `source-${name}`, replicas: name === "bot-orchestrator" ? bot : 1,
      containers: [{ name, image: "synthetic-public-image" }], init_containers: []
    }))
  };
  const consumerContract = {
    schema_version: 3, operation_id: operationId,
    authority_sha256: createHash("sha256").update(backupAuthority).digest("hex"),
    consumers: structuredClone(authority.consumers)
  };
  const metadata = {
    schema_version: 4,
    provenance: { generator: "yenhubs-local-coordinated-checkpoint-v4", external_import: false },
    stamp: "20261003-120000", created_at_utc: "2026-10-03T12:00:00Z", created_at_epoch: 1791028800,
    kube_context: "synthetic-context", namespace: "hcce", namespace_uid: "source-namespace",
    ret_pvc_uid: "source-pvc", operation_id: operationId, runtime_generation: "legacy-absent",
    runner_cutover_evidence_sha256: "e".repeat(64),
    writer_quiescence: {
      required: true, started_at_utc: "2026-10-03T12:00:00Z", completed_at_utc: "2026-10-03T12:00:01Z"
    }, backup_authority: backupAuthority, consumer_contract: consumerContract
  };
  const freeze = {
    schema: "freeze-bundle-v2", client_instance_id: "synthetic-client", freeze_id: operationId,
    stamp: metadata.stamp, created_at_utc: metadata.created_at_utc,
    source: {
      kube_context: "synthetic-context", cluster: { name: "source-cluster", uid: "source-cluster-uid" },
      namespace: authority.namespace, pvc: authority.pvc
    }, operation: {
      id: operationId, quiescence: {
        started_at_utc: metadata.writer_quiescence.started_at_utc,
        completed_at_utc: metadata.writer_quiescence.completed_at_utc
      }
    }, payloads: {
      database: { filename: `retdb-${metadata.stamp}.sql.gz`, size_bytes: 1, sha256: "d".repeat(64) },
      storage: { filename: `ret-storage-${metadata.stamp}.tar.gz`, size_bytes: 1, sha256: "c".repeat(64) }
    }, runtime_generation: "legacy-absent", runner_mode: "process-local",
    provenance: { generator: "yenhubs-freeze-bundle-v2", external_import: false },
    minimum_restore_version: 2, publication_state: "complete",
    backup_authority: backupAuthority, consumer_contract: structuredClone(consumerContract)
  };
  return { metadata, inventory, freeze, authority };
}

function withPublicFiles(value, callback) {
  const directory = mkdtempSync(path.join(tmpdir(), "yenhubs-public-readers-test-"));
  try {
    const metadata = path.join(directory, "checkpoint-metadata.json");
    const inventory = path.join(directory, "deployment-images.json");
    writeFileSync(metadata, JSON.stringify(value.metadata), { mode: 0o600 });
    writeFileSync(inventory, JSON.stringify(value.inventory), { mode: 0o600 });
    return callback(metadata, inventory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function readAllBoundaries(value, schema = value.metadata.schema_version ?? value.metadata.schema) {
  return withPublicFiles(value, (metadata, inventory) => run(`
set -uo pipefail
SCRIPT_DIR="$1"
RECOVERY_CHECKPOINT_METADATA_COPY="$2"
RECOVERY_DEPLOYMENT_INVENTORY_COPY="$3"
RECOVERY_CHECKPOINT_METADATA_SCHEMA="$4"
recovery_require_regular_direct_file() { [[ -f "$1" && ! -L "$1" ]]; }
${shellFunction("preflight-reactivation.sh", "reactivation_checkpoint_source_evidence_mode")}
${shellFunction("preflight-greenfield.sh", "greenfield_checkpoint_public_binding_is_acceptable")}
${shellFunction("restore-checkpoint.sh", "restore_checkpoint_has_signed_source_authority")}
${shellFunction("restore-checkpoint.sh", "restore_checkpoint_public_binding_is_acceptable")}
${shellFunction("restore-checkpoint.sh", "restore_checkpoint_source_evidence_mode")}
if [[ "$4" == freeze-* ]]; then
  greenfield_checkpoint_public_binding_is_acceptable "$2" "$3" || exit 1
  restore_checkpoint_public_binding_is_acceptable || exit 1
else
  reactivation_checkpoint_source_evidence_mode "$2" "$3" || exit 1
  restore_checkpoint_source_evidence_mode || exit 1
fi
`, [scripts, metadata, inventory, String(schema)]));
}

test("explicit new pairs select authority mode for signed bot0/1 and freeze-v2 remains separately typed", () => {
  for (const bot of [0, 1]) {
    const value = fixture(bot);
    const result = readAllBoundaries(value);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "active-source-authority\nactive-source-authority\n");
    assert.equal(result.stderr, "");
    const freeze = readAllBoundaries({ metadata: value.freeze, inventory: value.inventory });
    assert.equal(freeze.status, 0, freeze.stderr);
    assert.equal(freeze.stdout, "");
  }
});

test("legacy metadata3/inventory4 and freeze-v1/inventory4 retain their separate readers", () => {
  const value = fixture(1);
  value.inventory.schema_version = 4;
  delete value.inventory.backup_authority;
  value.metadata.schema_version = 3;
  delete value.metadata.backup_authority;
  delete value.metadata.consumer_contract;
  value.metadata.provenance.generator = "yenhubs-local-coordinated-checkpoint-v3";
  const result = readAllBoundaries(value);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "active-source\nactive-source\n");
  value.freeze.schema = "freeze-bundle-v1";
  delete value.freeze.backup_authority;
  delete value.freeze.consumer_contract;
  value.freeze.provenance.generator = "yenhubs-freeze-bundle-v1";
  value.freeze.minimum_restore_version = 1;
  assert.equal(readAllBoundaries({ metadata: value.freeze, inventory: value.inventory }).status, 0);
});

test("external boundaries reject cross-version, cross-identity and forged public contracts", () => {
  const cases = [
    value => { value.metadata.schema_version = 3; },
    value => { value.inventory.schema_version = 4; },
    value => { value.metadata.schema_version = 99; },
    value => { value.metadata.consumer_contract.schema_version = 1; },
    value => { value.metadata.consumer_contract.authority_sha256 = "0".repeat(64); },
    value => { value.metadata.backup_authority += "\n"; },
    value => { value.inventory.deployments[0].uid = "destination-bot-orchestrator"; },
    value => { value.metadata.ret_pvc_uid = "destination-pvc"; },
    value => {
      value.authority.schema_version = 1;
      value.authority.hmac_profile = "yenhubs-checkpoint-backup-authority-hmac-v1";
      value.inventory.backup_authority = canonicalJsonV1(value.authority);
      value.metadata.backup_authority = value.inventory.backup_authority;
    }
  ];
  for (const mutate of cases) {
    const value = fixture(1);
    mutate(value);
    const result = readAllBoundaries(value);
    assert.notEqual(result.status, 0, result.stdout);
    assert.equal(result.stdout, "");
  }
  assert.notEqual(readAllBoundaries(fixture(2)).status, 0);
  const value = fixture();
  value.inventory.schema_version = 4;
  assert.notEqual(readAllBoundaries({ metadata: value.freeze, inventory: value.inventory }).status, 0);
});

test("source live wrapper rejects historical mode with new inventory and new mode with historical inventory", () => {
  for (const old of [false, true]) {
    const value = fixture(1);
    if (old) {
      value.metadata.schema_version = 3;
      value.inventory.schema_version = 4;
      delete value.inventory.backup_authority;
    }
    const result = withPublicFiles(value, (metadata, inventory) => run(`
set -uo pipefail
SCRIPT_DIR="$1" RECOVERY_CHECKPOINT_METADATA_COPY="$2" RECOVERY_DEPLOYMENT_INVENTORY_COPY="$3"
RECOVERY_CHECKPOINT_METADATA_SCHEMA="$4" RECOVERY_CHECKPOINT_RUNNER_GENERATION=durable-v2
VALUES_SOURCE_FILE=synthetic-target-values RESTORE_HISTORICAL_VALUES_SNAPSHOT=synthetic-source-values
RECOVERY_RUNNER_CUTOVER_EVIDENCE_COPY=synthetic-evidence RECOVERY_CHECKPOINT_OPERATION_ID=${operationId}
recovery_verify_runner_cutover_evidence_live() { printf 'DELEGATED\n'; }
${shellFunction("restore-checkpoint.sh", "restore_checkpoint_has_signed_source_authority")}
${shellFunction("restore-checkpoint.sh", "restore_checkpoint_public_binding_is_acceptable")}
${shellFunction("restore-checkpoint.sh", "restore_checkpoint_source_evidence_mode")}
${shellFunction("restore-checkpoint.sh", "require_durable_checkpoint_evidence_live")}
require_durable_checkpoint_evidence_live "$5" dormant
`, [scripts, metadata, inventory, old ? "3" : "4", old ? "active-source-authority" : "active-source"]));
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
  }
});

const restoreFunctions = [
  "restore_checkpoint_has_signed_source_authority", "restore_active_target_originals_json",
  "capture_consumer_contracts_at_replicas", "restore_scale_consumer_to_zero", "restore_resume_consumer",
  "prepare_restore_fence"
].map(name => shellFunction("restore-checkpoint.sh", name)).join("\n");

function targetSimulation({ schema = "4", desiredBot = 0, observedBot = desiredBot,
  paused = false, invalidSpec = false, malformedMap = false, operation = "prepare" } = {}) {
  return run(`
set -euo pipefail
RECOVERY_CHECKPOINT_METADATA_SCHEMA="$1"
DESIRED_BOT="$2" OBSERVED_BOT="$3" INVALID_SPEC="$4" MALFORMED_MAP="$5" PAUSED="$6"
VALUES_SOURCE_FILE=synthetic-private-values RESTORE_MANIFEST_SNAPSHOT=synthetic-private-manifest
RESTORE_OPERATION_ID=${operationId} RECOVERY_CHECKPOINT_RUNNER_GENERATION=durable-v2
CONSUMERS=(reticulum pgbouncer pgbouncer-t bot-orchestrator coturn)
DEPLOYMENT_UIDS=() DEPLOYMENT_RESOURCE_VERSIONS=() ORIGINAL_REPLICAS=()
DEPLOYMENT_SELECTORS=() DEPLOYMENT_FINGERPRINTS=()
recovery_restore_active_target_originals_json() {
  [[ "$INVALID_SPEC" == false ]] || return 1
  [[ "$1" == synthetic-private-values && "$2" == synthetic-private-manifest ]] || return 1
  if [[ "$MALFORMED_MAP" == true ]]; then
    printf '%s' '{"bot-orchestrator":"0","coturn":1,"pgbouncer":1,"pgbouncer-t":1,"reticulum":1}'
  else
    jq -cn --argjson bot "$DESIRED_BOT" '{"bot-orchestrator":$bot,coturn:1,pgbouncer:1,"pgbouncer-t":1,reticulum:1}'
  fi
}
recovery_capture_deployment_contract() {
  local replicas=1
  [[ "$1" != bot-orchestrator ]] || replicas="$OBSERVED_BOT"
  [[ "$PAUSED" != true ]] || replicas=0
  printf '%s\t%s\t%s\t%s\t%s\n' "destination-$1" "target-rv-$1" "$replicas" "$1" Zml4dHVyZQ==
}
recovery_scale_deployment_exact() {
  printf 'CAS:%s:%s:%s\n' "$1" "$4" "$5" >&2
  printf 'after-rv-%s\n' "$1"
}
recovery_capture_checkpoint_resume_receipt_absent_contract() {
  printf 'ABSENT_RECEIPT:%s:%s\n' "$1" "$3" >&2
  printf 'target-rv-%s\n' "$1"
}
recovery_require_consumer_contract_entry() { printf 'CHECK:%s:%s\n' "$2" "$3" >&2; }
recovery_wait_for_deployment_rollout() { printf 'ROLLOUT:%s\n' "$1" >&2; }
restore_transition_phase() { :; }
capture_runner_role_for_failclose() { :; }
neutralize_runner_role_exact() { printf 'NEUTRALIZE_ROLE\n' >&2; }
recovery_wait_for_no_pods() { :; }
reconcile_checkpoint_runner_quiescence() { :; }
require_runner_absence_stable() { :; }
require_durable_checkpoint_evidence_live() { [[ "$1:$2" == quiesced-source:dormant ]]; }
${shellFunction("lib/recovery-safety.sh", "recovery_backup_authority_is_selected")}
${shellFunction("lib/recovery-safety.sh", "recovery_consumer_contract_is_acceptable")}
${restoreFunctions}
if [[ "$7" == prepare ]]; then
  prepare_restore_fence
else
  capture_consumer_contracts_at_replicas 0 1
  restore_resume_consumer 3
fi
printf '%s' "$RECOVERY_CONSUMER_CONTRACT_JSON"
`, [schema, String(desiredBot), String(observedBot), String(invalidSpec), String(malformedMap),
    String(paused), operation], {
    RECOVERY_BACKUP_AUTHORITY_KEYRING: "", RECOVERY_BACKUP_AUTHORITY_KEY_ID: ""
  });
}

test("signed BASE prepare captures destination consumer1 and performs no zero-parent PATCH", () => {
  const result = targetSimulation();
  assert.equal(result.status, 0, result.stderr);
  const contract = JSON.parse(result.stdout);
  assert.equal(contract.schema_version, 1);
  assert.equal(contract.operation_id, operationId);
  assert.deepEqual(contract.consumers.map(value => value.name), restoreNames);
  assert.ok(contract.consumers.every(value => value.uid === `destination-${value.name}`));
  assert.equal(contract.consumers.find(value => value.name === "bot-orchestrator").original_replicas, 0);
  assert.doesNotMatch(result.stderr, /CAS:bot-orchestrator|ROLLOUT:bot-orchestrator/);
  assert.equal((result.stderr.match(/^CAS:/gmu) || []).length, 4);
  assert.match(result.stderr, /ABSENT_RECEIPT:bot-orchestrator:0/);
  assert.match(result.stderr, /NEUTRALIZE_ROLE/);
});

test("new positive target and historical uniform-one capture remain closed; invalid target aborts before mutation", () => {
  for (const options of [{ desiredBot: 1 }, { schema: "3", desiredBot: 1 }]) {
    const result = targetSimulation(options);
    assert.equal(result.status, 0, result.stderr);
    assert.equal((result.stderr.match(/^CAS:/gmu) || []).length, 5);
    assert.ok(JSON.parse(result.stdout).consumers.every(value => value.original_replicas === 1));
  }
  for (const options of [
    { schema: "3", observedBot: 0 }, { invalidSpec: true }, { malformedMap: true },
    { desiredBot: 2 }, { desiredBot: 0, observedBot: 1 }, { desiredBot: 1, observedBot: 0 }
  ]) {
    const result = targetSimulation(options);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /CAS:|NEUTRALIZE_ROLE/);
    assert.equal(result.stdout, "");
  }
});

test("cold/fenced capture derives ACTIVE originals from verified target rather than paused scale or source", () => {
  for (const desiredBot of [0, 1]) {
    const result = targetSimulation({ schema: "freeze-bundle-v2", desiredBot, paused: true, operation: "resume" });
    assert.equal(result.status, 0, result.stderr);
    const contract = JSON.parse(result.stdout);
    assert.equal(contract.consumers.find(value => value.name === "bot-orchestrator").original_replicas, desiredBot);
    assert.ok(contract.consumers.filter(value => value.name !== "bot-orchestrator")
      .every(value => value.original_replicas === 1));
    if (desiredBot === 0) assert.doesNotMatch(result.stderr, /CAS:bot-orchestrator|ROLLOUT:bot-orchestrator/);
    else assert.match(result.stderr, /CAS:bot-orchestrator:0:1/);
  }
});

function withRealRestoreInitialization(callback) {
  const restore = source["restore-checkpoint.sh"];
  const prefixEnd = restore.indexOf("\nrecovery_require_in_place_restore_target_mode\n");
  const stateStart = restore.indexOf('\nLIVE_CONTRACT=""\n');
  const stateEnd = restore.indexOf("\nrestore_record_pending_signal() {\n", stateStart);
  assert.notEqual(prefixEnd, -1, "missing real restore initialization boundary");
  assert.ok(stateStart > prefixEnd && stateEnd > stateStart);
  const directory = mkdtempSync(path.join(tmpdir(), "yenhubs-restore-init-test-"));
  const deployment = path.join(directory, "deployment");
  try {
    mkdirSync(deployment);
    // A code-only fixture preserves the actual BASH_SOURCE/SCRIPT_DIR logic.
    // It sources the real library through its actual filesystem target, not
    // a stub selector or a reimplemented restore initialization.
    symlinkSync(path.join(scripts, "lib"), path.join(deployment, "lib"), "dir");
    const initialization = path.join(deployment, "restore-checkpoint.sh");
    writeFileSync(initialization,
      restore.slice(0, prefixEnd + "\nrecovery_require_in_place_restore_target_mode\n".length) +
      restore.slice(stateStart, stateEnd), { mode: 0o600 });
    return callback(initialization);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function inheritedRestoreSelection(selectors) {
  return withRealRestoreInitialization(initialization => run(`
set -Eeuo pipefail
source "$1" /synthetic-checkpoint-not-opened
selected=false consumer=false acquired=false adopted=false
if recovery_backup_authority_is_selected; then selected=true; fi
RECOVERY_NAMESPACE_UID=destination-namespace RECOVERY_PVC_UID=destination-pvc
RECOVERY_CHECKPOINT_STAMP=20261003-120000
RECOVERY_DUMP_SHA256=${"d".repeat(64)} RECOVERY_STORAGE_SHA256=${"c".repeat(64)}
RECOVERY_DEPLOYMENT_INVENTORY_SHA256=${"b".repeat(64)}
RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256=${"e".repeat(64)}
RECOVERY_CHECKPOINT_METADATA_SCHEMA=4 RECOVERY_RUNNER_RUNTIME_GENERATION=durable-v2
RECOVERY_FENCE_PRE_EPOCH=11111111-1111-4111-8111-111111111111
RECOVERY_FENCE_TARGET_EPOCH=22222222-2222-4222-8222-222222222222
RECOVERY_OPERATION_STATE=restore-fence-prepared
RECOVERY_CONSUMER_CONTRACT_JSON="$(jq -cn --arg operation_id ${operationId} '
  {schema_version:1,operation_id:$operation_id,consumers:
    ["reticulum","pgbouncer","pgbouncer-t","bot-orchestrator","coturn"] | map({
      name:.,uid:("destination-" + .),initial_resource_version:("destination-rv-" + .),
      original_replicas:(if . == "bot-orchestrator" then 0 else 1 end),selector:.,fingerprint:"Zml4dHVyZQ=="
    })}
')"
if recovery_consumer_contract_is_acceptable "$RECOVERY_CONSUMER_CONTRACT_JSON"; then consumer=true; fi
# Only unrelated remote transport/materialized evidence and entropy are
# synthetic. The real acquire/adopt/lock guards and selector are all loaded.
recovery_require_operation_serialization() { :; }
recovery_operation_runner_contract_is_valid() { [[ "$1" == checkpoint-restore ]]; }
od() { printf '%s\n' ${operationId}; }
recovery_kubectl_mutate() {
  [[ "$1:$2:$3" == create:-f:- ]] || return 1
  while IFS= read -r line; do :; done
  printf 'SYNTHETIC_CREATE:%s\n' "$RECOVERY_OPERATION_OWNER" >&2
}
recovery_kubectl() {
  [[ "$1:$2:$3" == get:configmap:yenhubs-recovery-operation-lock ]] || return 1
  jq -cn --arg name "$RECOVERY_OPERATION_LOCK_NAME" --arg namespace "$NAMESPACE" \
    --arg owner "$RECOVERY_OPERATION_OWNER" --arg token "$RECOVERY_OPERATION_TOKEN" \
    --arg operation_id "$RECOVERY_OPERATION_ID" --arg namespace_uid "$RECOVERY_NAMESPACE_UID" \
    --arg pvc_uid "$RECOVERY_PVC_UID" --arg stamp "$RECOVERY_CHECKPOINT_STAMP" \
    --arg dump "$RECOVERY_DUMP_SHA256" --arg storage "$RECOVERY_STORAGE_SHA256" \
    --arg inventory "$RECOVERY_DEPLOYMENT_INVENTORY_SHA256" \
    --arg evidence "$RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256" \
    --arg generation "$RECOVERY_RUNNER_RUNTIME_GENERATION" \
    --arg pre "$RECOVERY_FENCE_PRE_EPOCH" --arg target "$RECOVERY_FENCE_TARGET_EPOCH" \
    --arg state "$RECOVERY_OPERATION_STATE" '{apiVersion:"v1",kind:"ConfigMap",immutable:true,
      metadata:{name:$name,namespace:$namespace,uid:"destination-lock",resourceVersion:"destination-lock-rv",
      labels:{"yenhubs.org/recovery-owner":$owner},annotations:{
        "yenhubs.org/recovery-token":$token,"yenhubs.org/operation-id":$operation_id,
        "yenhubs.org/namespace-uid":$namespace_uid,"yenhubs.org/pvc-uid":$pvc_uid,
        "yenhubs.org/checkpoint-stamp":$stamp,"yenhubs.org/dump-sha256":$dump,
        "yenhubs.org/storage-sha256":$storage,"yenhubs.org/deployment-inventory-sha256":$inventory,
        "yenhubs.org/runner-cutover-evidence-sha256":$evidence,"yenhubs.org/runner-runtime-generation":$generation,
        "yenhubs.org/pre-fence-epoch":$pre,"yenhubs.org/restore-fence-epoch":$target,
        "yenhubs.org/recovery-state":$state}}}'
}
${shellFunction("restore-checkpoint.sh", "restore_record_pending_signal")}
${shellFunction("restore-checkpoint.sh", "restore_driver_signal_traps")}
${shellFunction("restore-checkpoint.sh", "acquire_restore_lock")}
${shellFunction("restore-checkpoint.sh", "restore_lock_json_is_exact")}
${shellFunction("restore-checkpoint.sh", "load_restore_fence_lock")}
if acquire_restore_lock; then acquired=true; fi
if load_restore_fence_lock restore-fence-prepared; then adopted=true; fi
jq -cn --argjson selected "$selected" --argjson consumer "$consumer" \
  --argjson acquired "$acquired" --argjson adopted "$adopted" \
  --arg owner "$RECOVERY_OPERATION_OWNER" --arg uid "$RESTORE_LOCK_UID" \
  --arg namespace_uid "$RECOVERY_NAMESPACE_UID" --arg pvc_uid "$RECOVERY_PVC_UID" \
  --argjson contract "$RECOVERY_CONSUMER_CONTRACT_JSON" \
  '{selected:$selected,consumer:$consumer,acquired:$acquired,adopted:$adopted,
    owner:$owner,lock_uid:$uid,namespace_uid:$namespace_uid,pvc_uid:$pvc_uid,contract:$contract}'
`, [initialization], {
    RESTORE_TARGET_MODE: "in-place", RECOVERY_BACKUP_AUTHORITY_KEYRING: "",
    RECOVERY_BACKUP_AUTHORITY_KEY_ID: "", RECOVERY_BACKUP_AUTHORITY_JSON: '{"namespace":{"uid":"source-namespace"}}',
    ...selectors
  }));
}

const inheritedSelectors = [
  ["complete pair", {
    RECOVERY_BACKUP_AUTHORITY_KEYRING: "/synthetic-keyring-not-opened",
    RECOVERY_BACKUP_AUTHORITY_KEY_ID: "11111111-1111-4111-8111-111111111111"
  }],
  ["keyring alone", { RECOVERY_BACKUP_AUTHORITY_KEYRING: "/synthetic-keyring-not-opened" }],
  ["key ID alone", { RECOVERY_BACKUP_AUTHORITY_KEY_ID: "11111111-1111-4111-8111-111111111111" }]
];

for (const [label, selectors] of inheritedSelectors) {
  test(`restore inherited backup selectors ${label} cannot replace destination consumer1 or checkpoint-restore lock`, () => {
    const parentSelection = [process.env.RECOVERY_BACKUP_AUTHORITY_KEYRING, process.env.RECOVERY_BACKUP_AUTHORITY_KEY_ID];
    const result = inheritedRestoreSelection(selectors);
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.equal(value.selected, false, "restore retained a session's backup-authority selection");
    assert.equal(value.consumer, true, "restore must validate its real target-owned consumer1");
    assert.equal(value.acquired, true, "real acquire must retain checkpoint-restore ownership");
    assert.equal(value.adopted, true, "real adopt must validate the exact destination restore lock");
    assert.equal(value.owner, "checkpoint-restore");
    assert.equal(value.lock_uid, "destination-lock");
    assert.equal(value.namespace_uid, "destination-namespace");
    assert.equal(value.pvc_uid, "destination-pvc");
    assert.equal(value.contract.schema_version, 1);
    assert.equal(value.contract.operation_id, operationId);
    assert.ok(value.contract.consumers.every(consumer => consumer.uid === `destination-${consumer.name}`));
    assert.equal((result.stderr.match(/^SYNTHETIC_CREATE:checkpoint-restore$/gmu) || []).length, 1);
    assert.deepEqual([process.env.RECOVERY_BACKUP_AUTHORITY_KEYRING, process.env.RECOVERY_BACKUP_AUTHORITY_KEY_ID], parentSelection);
  });
}

test("reader edits preserve mandatory full artifacts, custody, source identities, live topology and target lock gates", () => {
  assert.match(source["preflight-greenfield.sh"], /recovery_verify_freeze_bundle_directory/);
  assert.match(source["preflight-greenfield.sh"], /recovery_freeze_bundle_receipt_is_acceptable/);
  assert.match(source["preflight-greenfield.sh"], /recovery_freeze_bundle_artifacts/);
  assert.match(source["preflight-reactivation.sh"], /recovery_deployment_inventory_is_acceptable/);
  assert.match(source["preflight-reactivation.sh"], /recovery_require_pvc_identity ret-pvc/);
  assert.match(source["preflight-reactivation.sh"], /recovery_require_live_images_match_checkpoint/);
  assert.match(source["preflight-reactivation.sh"], /reactivation_reticulum_deployment_is_singleton/);
  assert.match(source["restore-checkpoint.sh"], /recovery_require_restore_target_binding/);
  assert.match(source["restore-checkpoint.sh"], /recovery_require_cold_rebind_target_bootstrap/);
  assert.match(source["restore-checkpoint.sh"], /start_restore_writer_monitor/);
  assert.match(source["restore-checkpoint.sh"], /start_restore_durable_monitor/);
  assert.match(source["restore-checkpoint.sh"], /require_owned_restore_lock/);
});

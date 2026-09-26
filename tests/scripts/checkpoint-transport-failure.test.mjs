import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import crypto from "node:crypto";
import vm from "node:vm";

const root = fileURLToPath(new URL("../../", import.meta.url));
const driver = fs.readFileSync(path.join(root, "deployment/create-checkpoint.sh"), "utf8");
const library = fs.readFileSync(path.join(root, "deployment/lib/recovery-safety.sh"), "utf8");
function shellFunction(text, name) {
  const match = text.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, "m"));
  assert.ok(match, name);
  return match[0];
}
function run(script, env = {}) {
  const result = spawnSync("bash", ["-c", script], {
    cwd: root, env: { ...process.env, ...env }, encoding: "utf8", timeout: 15000
  });
  assert.equal(result.error, undefined);
  return result;
}

// No real kubectl is invoked. The shim actually waits, obeys the supplied
// request deadline and simulates an ambiguous failed response after a write.
const fixture = `
source deployment/lib/recovery-safety.sh
exec 3>&1
NAMESPACE=hcce
RECOVERY_SERIALIZATION_LEASE_HOLDER=root-recovery:11111111-1111-4111-8111-111111111111
RECOVERY_SERIALIZATION_LEASE_UID=fixture-lease-uid
RECOVERY_SERIALIZATION_LEASE_REQUIRED=1
lease_json=$(jq -cn --arg holder "$RECOVERY_SERIALIZATION_LEASE_HOLDER" \
  --arg now "$(recovery_rfc3339_now)" '{apiVersion:"coordination.k8s.io/v1",kind:"Lease",
  metadata:{name:"yenhubs-operation-serialization",namespace:"hcce",uid:"fixture-lease-uid",
    resourceVersion:"1",labels:{"yenhubs.org/operation-serialization":"deployment-recovery"}},
  spec:{holderIdentity:$holder,leaseDurationSeconds:120,acquireTime:$now,renewTime:$now,leaseTransitions:0}}')
export FIXTURE_LEASE="$lease_json"
recovery_kubectl() {
  local stage="$1" timeout="" arg payload
  for arg in "$@"; do
    case "$arg" in --request-timeout=*) timeout="$arg" ;; esac
  done
  printf 'request:%s:%s\n' "$stage" "$timeout" >&3
  [[ "$timeout" == --request-timeout=3s ]] || return 98
  if [[ "$stage" == replace ]]; then
    payload=$(cat)
    # A submitted write is recorded before a possibly missing response.
    printf 'cas:%s\n' "$(jq -r '.metadata.resourceVersion' <<<"$payload")" >&3
  fi
  node -e '
    const stage=process.argv[1], mode=process.env.TEST_CASE;
    const slow=mode===stage+"-timeout", wait=slow?3000:100;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,wait);
    if(slow || mode===stage+"-eof") {
      process.stderr.write("EOF private-payload-sentinel"); process.exit(1);
    }
  ' "$stage" || return 1
  if [[ "$stage" == get ]]; then
    case "$TEST_CASE" in
      foreign-holder) jq '.spec.holderIdentity="root-recovery:22222222-2222-4222-8222-222222222222"' <<<"$FIXTURE_LEASE" ;;
      stale-lease) jq '.spec.renewTime="2000-01-01T00:00:00.000000Z"' <<<"$FIXTURE_LEASE" ;;
      *) printf '%s\n' "$FIXTURE_LEASE" ;;
    esac
  else
    jq '.metadata.resourceVersion="2"' <<<"$payload"
  fi
}
`;

for (const mode of ["success", "get-eof", "replace-eof", "get-timeout", "replace-timeout",
  "foreign-holder", "stale-lease"]) {
  test(`heartbeat renewal is bounded and does not retry: ${mode}`, () => {
    const before = performance.now();
    const r = run(`${fixture}
if recovery_renew_operation_serialization; then status=0; else status=$?; fi
echo status:$status`, { TEST_CASE: mode });
    const elapsed = performance.now() - before;
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, mode === "success" ? /status:0/ : /status:1/);
    const requests = r.stdout.split("\n").filter(line => line.startsWith("request:"));
    assert.deepEqual(requests, ["request:get:--request-timeout=3s",
      ...(["success", "replace-eof", "replace-timeout"].includes(mode)
        ? ["request:replace:--request-timeout=3s"] : [])]);
    assert.doesNotMatch(r.stderr, /private-payload-sentinel|EOF/);
    if (mode.includes("-eof") || mode.includes("-timeout")) {
      const stage = mode.startsWith("get") ? "read" : "replace";
      assert.equal(r.stderr, `Serialization Lease renewal failed: stage=${stage}.\n`);
    }
    if (mode.endsWith("-timeout")) {
      assert.ok(elapsed >= 3000, `shim must really wait: ${elapsed}`);
      assert.ok(elapsed < 6000, `request must not use generic 45s budget: ${elapsed}`);
    }
    if (mode.startsWith("replace")) assert.match(r.stdout, /cas:1/);
  });
}

test("renewal cadence reserves API time inside the authority freshness window", () => {
  const renew = shellFunction(library, "recovery_renew_operation_serialization");
  const deadlines = [...renew.matchAll(/--request-timeout=(\d+)s/g)].map(m => Number(m[1]));
  assert.deepEqual(deadlines, [3, 3]);
  // Previous replace response time already ages its pre-request renewTime.
  const previousReplace = deadlines[1];
  const requestBudget = deadlines.reduce((a, b) => a + b, 0);
  assert.equal(previousReplace + 20 + requestBudget, 29);
  assert.equal(previousReplace + 30 + requestBudget, 39);
  assert.ok(previousReplace + 30 + requestBudget < 40);
  assert.match(shellFunction(library, "recovery_start_operation_serialization_heartbeat"),
    /RECOVERY_LEASE_HEARTBEAT_SECONDS:-20/);
  assert.match(shellFunction(library, "recovery_owned_serialization_lease_json_is_exact"),
    /now_epoch - renew_epoch <= 40/);
});

for (const parentChanged of [false, true]) {
test(`failed heartbeat revokes authority and respects parent identity: ${parentChanged ? "changed-after-EOF" : "unchanged"}`, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yenhubs-transport-fixture-"));
  try {
    const r = run(`${fixture}
RECOVERY_SERIALIZATION_PARENT_PID=4242
RECOVERY_SERIALIZATION_PARENT_START_IDENTITY=fixture-parent
recovery_process_start_identity() { printf fixture-start; }
recovery_process_identity_is_live() {
  [[ "$1:$2" == 4242:fixture-parent ]] || return 99
  if [[ "$TEST_PARENT_CHANGED" == 1 && -s "$RECOVERY_SERIALIZATION_HEARTBEAT_FAILURE" ]]; then
    printf 'parent-identity:changed\n' >&3
    return 1
  fi
  printf 'parent-identity:valid\n' >&3
  return 0
}
sleep() { :; }
kill() { printf 'signal:%s\n' "$*" >&3; }
recovery_start_operation_serialization_heartbeat || exit 80
wait "$RECOVERY_SERIALIZATION_HEARTBEAT_PID"; echo heartbeat-status:$?
printf 'failure:%s\n' "$(cat "$RECOVERY_SERIALIZATION_HEARTBEAT_FAILURE")"
if recovery_require_operation_serialization_local_capability; then echo authority:held; else echo authority:lost; fi
`, { TEST_CASE: "replace-eof", TEST_PARENT_CHANGED: parentChanged ? "1" : "0", TMPDIR: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /heartbeat-status:1/);
    assert.match(r.stdout, /failure:lease_lost/);
    if (parentChanged) {
      assert.doesNotMatch(r.stdout, /signal:/);
      assert.match(r.stdout, /cas:1\nparent-identity:changed\n/);
      assert.equal((r.stdout.match(/parent-identity:valid/g) || []).length, 2);
      assert.equal((r.stdout.match(/parent-identity:changed/g) || []).length, 1);
    } else {
      assert.match(r.stdout, /signal:-TERM 4242/);
      assert.equal((r.stdout.match(/parent-identity:valid/g) || []).length, 3);
    }
    assert.match(r.stdout, /authority:lost/);
    assert.equal((r.stdout.match(/request:/g) || []).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
}

test("checkpoint interruption after authority loss never resumes writers or releases the lock", () => {
  const functions = ["checkpoint_failure_context_is_safe", "checkpoint_report_resume_failure",
    "resume_writers", "resume_writers_with_single_reentry", "checkpoint_interrupted"]
    .map(name => shellFunction(driver, name)).join("\n");
  const r = run(`source deployment/lib/recovery-safety.sh
${functions}
RECOVERY_SERIALIZATION_LEASE_REQUIRED=1
WRITERS_MUTATED=1
OPERATION_LOCK_OWNED=1
CHECKPOINT_RUNNER_MODE=kubernetes-pod
CHECKPOINT_FAILURE_STAGE=storage-backup
CHECKPOINT_FAILURE_CODE=stream
checkpoint_set_failure_context() { CHECKPOINT_FAILURE_STAGE="$1"; CHECKPOINT_FAILURE_CODE="$2"; }
checkpoint_report_timing() { :; }
recovery_require_operation_serialization_local_capability() { return 1; }
recovery_kubectl() { echo forbidden-api-call; return 99; }
release_lock_if_safe() { echo forbidden-lock-release; return 99; }
cleanup_local_artifacts() { echo cleanup-local-only; }
checkpoint_interrupted 143`);
  assert.equal(r.status, 143);
  assert.equal(r.stdout, "cleanup-local-only\n");
  assert.match(r.stderr, /Interrupted checkpoint retained its lock for manual recovery/);
  assert.match(r.stderr, /attempt=1 stage=resume code=preflight/);
  assert.match(r.stderr, /attempt=2 stage=resume code=preflight/);
});

for (const fail of [false, true]) {
  test(`durable receipt hook precedes pause, excludes private JSON from argv and fails closed: ${fail}`, () => {
    const hook=shellFunction(driver,"persist_checkpoint_abort_receipt");
    const r=run(`set -euo pipefail
${hook}
CHECKPOINT_RUNNER_GENERATION=durable-v2
CHECKPOINT_FORMAT=legacy
EXPECTED_KUBE_CONTEXT=fixture
NAMESPACE=hcce
RECOVERY_NAMESPACE_UID=ns-uid
RECOVERY_PVC_UID=pvc-uid
RECOVERY_OPERATION_ID=fixture-operation
TIMESTAMP=20260926-120000
RECOVERY_OPERATION_LOCK_UID=lock-uid
RECOVERY_OPERATION_LOCK_RESOURCE_VERSION=123
RECOVERY_CONSUMER_CONTRACT_JSON='{"private":"contract-sentinel"}'
CHECKPOINT_VALUES_SNAPSHOT=/private/values
CHECKPOINT_MANIFEST_SNAPSHOT=/private/manifest
CHECKPOINT_CUTOVER_KEY_SNAPSHOT=/private/key
OUTPUT_DIR=/private/staging
FINAL_OUTPUT_DIR=/private/final
SCRIPT_DIR=/checkout/deployment
recovery_require_operation_serialization() { echo fresh-lease; }
recovery_require_operation_lock() { echo exact-lock; }
node() {
  [[ "$#" == 2 && "$1" == /checkout/deployment/checkpoint-recovery-receipt.mjs && "$2" == /private/final.abort-recovery ]] || return 90
  [[ "$RECOVERY_CONSUMER_CONTRACT_JSON" == *contract-sentinel* ]] || return 91
  [[ "$CHECKPOINT_RECOVERY_INVENTORY" == /private/staging/deployment-images.json ]] || return 92
  echo receipt
  ${fail ? "return 1" : "return 0"}
}
persist_checkpoint_abort_receipt
echo pause-writers`);
    assert.equal(r.status,fail?1:0,r.stderr);
    assert.equal(r.stdout,`fresh-lease\nexact-lock\nreceipt\n${fail?"":"pause-writers\n"}`);
    assert.doesNotMatch(r.stdout+r.stderr,/contract-sentinel/);
  });
}

test("receipt hook is before quiescence and not part of cleanup or accepted artifacts",()=>{
  const invocation=driver.indexOf("\npersist_checkpoint_abort_receipt\n");
  assert.ok(invocation>0 && invocation<driver.indexOf('QUIESCE_STARTED_AT="'));
  assert.doesNotMatch(shellFunction(driver,"cleanup_local_artifacts"),/abort-recovery/);
  assert.doesNotMatch(shellFunction(driver,"checkpoint_artifacts"),/abort-recovery/);
});

test("shell and actual watcher consumer validators accept explicit zero but reject invalid scale",()=>{
  const watcher=fs.readFileSync(path.join(root,"deployment/watch-checkpoint-writers.mjs"),"utf8");
  const names=["fail","object","sha256","parseJson","exactKeys","canonicalize","canonicalJson","canonicalConsumerFingerprint","validateConsumerContract"];
  const functions=names.map(name=>{const m=watcher.match(new RegExp(`^function ${name}\\([\\s\\S]*?^\\}`,"m"));assert.ok(m,name);return m[0];}).join("\n");
  const context=vm.createContext({crypto,Buffer});
  vm.runInContext(functions+"\nglobalThis.validate=validateConsumerContract;",context);
  const fingerprint=Buffer.from(JSON.stringify({selector:{},strategy:{},template:{}})).toString("base64");
  for(const value of [0,1,2,-1,0.5,null,undefined]){
    const contract={schema_version:1,operation_id:"a".repeat(32),consumers:["bot-orchestrator","coturn","pgbouncer","pgbouncer-t","reticulum"].map(name=>({name,uid:name,initial_resource_version:"1",original_replicas:value,selector:name,fingerprint}))};
    const text=JSON.stringify(contract),digest=crypto.createHash("sha256").update(text).digest("hex"),valid=Number.isInteger(value)&&value>=0;
    const r=run(`source deployment/lib/recovery-safety.sh\nrecovery_consumer_contract_is_acceptable "$CONTRACT"`,{CONTRACT:text});
    assert.equal(r.status===0,valid,`shell ${value}`);
    if(valid)assert.doesNotThrow(()=>context.validate(text,digest,"hcce"));else assert.throws(()=>context.validate(text,digest,"hcce"));
  }
});

const zeroSetup=`
exec 3>&1
CONSUMERS=(reticulum pgbouncer pgbouncer-t bot-orchestrator coturn)
ORIGINAL_REPLICAS=(1 1 1 0 1)
DEPLOYMENT_UIDS=(uid-reticulum uid-pgbouncer uid-pgbouncer-t uid-bot-orchestrator uid-coturn)
DEPLOYMENT_RESOURCE_VERSIONS=(7 7 7 7 7)
DEPLOYMENT_SELECTORS=(reticulum pgbouncer pgbouncer-t bot-orchestrator coturn)
DEPLOYMENT_FINGERPRINTS=(fp fp fp fp fp)
DEPLOYMENT_RESUME_STARTED=(0 0 0 0 0)
DEPLOYMENT_RESUME_RECEIPT_CLEARED=(0 0 0 0 0)
CHECKPOINT_PROCESS_LOCAL_ROLLING=0
CHECKPOINT_RUNNER_MODE=kubernetes-pod
RUNNER_DURABLE_FENCE_INVENTORY=known
RECOVERY_CONSUMER_CONTRACT_JSON=contract
CHECKPOINT_OPERATION_FENCE_ACTIVE_IDENTITY=active
RECOVERY_OPERATION_ID=op
CHECKPOINT_WRITER_MONITOR_VERIFIED_STOPPED=1
CHECKPOINT_WRITER_MONITOR_STARTED=1
WRITERS_MUTATED=1
RUNNER_MONITOR_PID=""
BOT_PARENT_RESUME_ALREADY_COMMITTED=0
for fn in recovery_require_operation_serialization recovery_require_operation_lock recovery_wait_for_no_pods
do eval "$fn() { :; }"; done
recovery_capture_checkpoint_resume_receipt_absent_contract() {
  [[ "$1" == bot-orchestrator && "$2" == uid-bot-orchestrator && "$3" == 0 && "$4" == bot-orchestrator && "$5" == fp ]] || return 99
  printf '%s\\n' "\${ZERO_RV:-7}"
}
recovery_scale_deployment_exact() {
  [[ "$1" != bot-orchestrator ]] || return 98
  printf 'scale:%s:%s:%s\\n' "$1" "$4" "$5" >&3
  printf '8\\n'
}
`;
for(const drift of [false,true])test(`quiesce BASE skips zero-to-zero CAS only with exact zero identity: ${drift}`,()=>{
  const body=["checkpoint_require_original_zero_writer","quiesce_writers"].map(n=>shellFunction(driver,n)).join("\n");
  const stubs=["checkpoint_set_failure_context","recovery_require_consumer_contract_entry","recovery_reconcile_durable_runner_namespace","recovery_require_no_legacy_parent_runner_pods","start_runner_monitor","require_checkpoint_runner_absence_stable","require_checkpoint_runner_quiescent_now","recovery_require_exact_pvc_consumers","recovery_require_recovery_operation_fence_state","recovery_activate_recovery_operation_fence","start_checkpoint_writer_monitor","require_checkpoint_writer_monitor_healthy","start_checkpoint_durable_monitor","require_checkpoint_durable_monitor_healthy"].map(n=>`${n}() { :; }`).join("\n");
  const r=run(`set -euo pipefail\n${body}\n${zeroSetup}\n${stubs}
recovery_capture_durable_quiescence() { printf known; }
checkpoint_uses_freeze_admission_fence() { return 1; }
quiesce_writers`,{ZERO_RV:drift?"foreign":"7"});
  assert.equal(r.status,drift?1:0,r.stderr);assert.doesNotMatch(r.stdout,/scale:bot-orchestrator/);
  assert.equal((r.stdout.match(/scale:/g)||[]).length,drift?0:4);
});

test("resume BASE preserves original zero without a CAS, receipt or rollout for parent",()=>{
  const body=["checkpoint_require_original_zero_writer","resume_writers"].map(n=>shellFunction(driver,n)).join("\n");
  const stubs=["checkpoint_set_failure_context","checkpoint_require_runner_mode_exact","adopt_committed_bot_parent_resume_before_monitor","prepare_runner_monitor_for_resume","require_checkpoint_runner_quiescent_now","recovery_require_consumer_contract_entry","stop_checkpoint_durable_monitor_before_writer_monitor","stop_checkpoint_writer_monitor_before_resume","deactivate_checkpoint_operation_fence_before_resume","stop_runner_monitor_before_resume","require_checkpoint_post_watch_absence_stable","recovery_capture_durable_quiescence","recovery_require_no_legacy_parent_runner_pods","require_checkpoint_dormant_operation_fence_now","recovery_require_deployment_contract"].map(n=>`${n}() { :; }`).join("\n");
  const r=run(`set -euo pipefail\n${body}\n${zeroSetup}\n${stubs}
recovery_capture_deployment_contract() { printf 'uid-%s\\t7\\t0\\t%s\\tfp\\n' "$1" "$1"; }
recovery_wait_for_deployment_rollout() { [[ "$1" != bot-orchestrator ]]; }
recovery_capture_checkpoint_resume_receipt_contract() { [[ "$1" != bot-orchestrator ]] || return 99; printf '8\\n'; }
recovery_clear_checkpoint_resume_receipt() { [[ "$1" != bot-orchestrator ]] || return 99; printf '9\\n'; }
resume_writers
[[ "$WRITERS_MUTATED" == 0 ]]`);
  assert.equal(r.status,0,r.stderr);assert.doesNotMatch(r.stdout,/scale:bot-orchestrator/);assert.equal((r.stdout.match(/scale:/g)||[]).length,4);
});

test("watcher import exports existing pure guards without running CLI or creating processes",()=>{
  const result=spawnSync(process.execPath,["--input-type=module","-e",`
    import assert from 'node:assert/strict';
    import cp from 'node:child_process';
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    const forbidden=()=>{throw new Error('unexpected_import_side_effect');};
    cp.spawn=forbidden;cp.execFileSync=forbidden;fs.writeFileSync=forbidden;fs.mkdirSync=forbidden;
    syncBuiltinESMExports();
    const m=await import(process.env.WATCHER_URL);
    for(const name of ['controllerOwner','podTemplateFingerprint','podAdmissionFingerprint','validatePodEnvelope','validateReplicaSetEnvelope','validateReplicaSetShape'])assert.equal(typeof m[name],'function');
    assert.equal(process.exitCode,undefined);process.stdout.write('import-safe\\n');
  `],{cwd:root,encoding:"utf8",timeout:5000,env:{...process.env,WATCHER_URL:pathToFileURL(path.join(root,"deployment/watch-checkpoint-writers.mjs")).href}});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,"import-safe\n");assert.equal(result.stderr,"");
});
test("watcher direct CLI still rejects invalid invocation",()=>{
  const result=spawnSync(process.execPath,[path.join(root,"deployment/watch-checkpoint-writers.mjs")],{cwd:root,encoding:"utf8",timeout:5000});
  assert.equal(result.status,1);assert.equal(result.stdout,"");assert.equal(result.stderr,"");
});

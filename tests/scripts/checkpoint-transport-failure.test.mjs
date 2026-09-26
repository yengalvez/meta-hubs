import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

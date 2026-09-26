import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const driver = fs.readFileSync(path.join(root, "deployment/create-checkpoint.sh"), "utf8");
function shellFunction(name) {
  const match = driver.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, "m"));
  assert.ok(match, name);
  return match[0];
}

// Only fixture-backed kubectl exists in this shell. The real identity/CAS
// predicates and rollback entrypoint run, but no cluster can be contacted.
function run(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yenhubs-activation-receipt-"));
  for (const name of ["policy", "binding"]) {
    const value = JSON.parse(fs.readFileSync(path.join(root, `tests/recovery/fixtures/recovery-operation-pod-fence-${name}.json`), "utf8"));
    if (name === "binding") value.spec.matchResources.namespaceSelector = {
      matchExpressions: [{ key: "kubernetes.io/metadata.name", operator: "DoesNotExist" }]
    };
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(value));
  }
  const script = `
source deployment/lib/recovery-safety.sh
NAMESPACE=hcce
RECOVERY_NAMESPACE_UID=fixture-uid
RECOVERY_OPERATION_ID=0123456789abcdef0123456789abcdef
RECOVERY_OPERATION_OWNER=checkpoint-backup
RECOVERY_OPERATION_LOCK_NAME=yenhubs-recovery-operation-lock
RECOVERY_OPERATION_LOCK_UID=lock-uid
RECOVERY_OPERATION_LOCK_RESOURCE_VERSION=lock-rv
RECOVERY_SERIALIZATION_LEASE_NAME=yenhubs-operation-serialization
RECOVERY_SERIALIZATION_LEASE_UID=lease-uid
RECOVERY_SERIALIZATION_LEASE_HOLDER=root-recovery:fixture
CHECKPOINT_RUNNER_MODE=kubernetes-pod
CHECKPOINT_OPERATION_FENCE_ACTIVE_IDENTITY=""
CHECKPOINT_OPERATION_FENCE_DORMANT_IDENTITY=""
ROLLBACK=0
recovery_require_operation_serialization() {
  [[ "$ROLLBACK:$TEST_CASE" != 1:lease-lost ]]
}
recovery_require_operation_lock() {
  [[ "$ROLLBACK:$TEST_CASE" != 1:lock-changed ]]
}
require_checkpoint_zero_boundary() {
  [[ "$TEST_CASE" != writer-active ]]
}
checkpoint_set_failure_context() { :; }
recovery_kubectl() {
  case "$1:$2" in
    get:validatingadmissionpolicy)
      if [[ -e "$FIXTURE_DIR/committed" && ! -e "$FIXTURE_DIR/read-failed" && "$TEST_CASE" == read-failure ]]; then
        touch "$FIXTURE_DIR/read-failed"; return 1
      fi
      if [[ "$ROLLBACK:$TEST_CASE" == 1:policy-aba ]]; then
        jq '.metadata.resourceVersion="foreign-rv"' "$FIXTURE_DIR/policy.json"
      else
        cat "$FIXTURE_DIR/policy.json"
      fi
      ;;
    get:validatingadmissionpolicybinding)
      if [[ "$ROLLBACK:$TEST_CASE" == 1:binding-aba ]]; then
        jq '.metadata.resourceVersion="foreign-rv"' "$FIXTURE_DIR/binding.json"
      else
        cat "$FIXTURE_DIR/binding.json"
      fi
      ;;
    replace:-f)
      local request target rv old_uid old_rv
      request=$(cat)
      target=$(jq -r '.spec.matchResources.namespaceSelector.matchExpressions[0].operator' <<<"$request")
      old_uid=$(jq -r '.metadata.uid' "$FIXTURE_DIR/binding.json")
      old_rv=$(jq -r '.metadata.resourceVersion' "$FIXTURE_DIR/binding.json")
      [[ $(jq -r '.metadata.uid' <<<"$request") == "$old_uid" && $(jq -r '.metadata.resourceVersion' <<<"$request") == "$old_rv" ]] || return 1
      rv=active-rv
      [[ "$target" == In ]] || rv=dormant-rv
      jq --arg rv "$rv" '.metadata.resourceVersion=$rv' <<<"$request" > "$FIXTURE_DIR/binding.json"
      echo "$target" >> "$FIXTURE_DIR/replacements"
      touch "$FIXTURE_DIR/committed"
      if [[ "$target" == In ]]; then
        case "$TEST_CASE" in
          lost-response) return 1 ;;
          invalid-response) echo '{'; return 0 ;;
          wrong-uid) jq '.metadata.uid="foreign-uid"' "$FIXTURE_DIR/binding.json"; return ;;
          no-rv-advance) jq --arg rv "$old_rv" '.metadata.resourceVersion=$rv' "$FIXTURE_DIR/binding.json"; return ;;
        esac
      fi
      cat "$FIXTURE_DIR/binding.json"
      ;;
    *) echo unexpected-fixture-call >&2; return 99 ;;
  esac
}
recovery_wait_recovery_operation_fence_propagation() {
  echo "$1" >> "$FIXTURE_DIR/probes"
  if [[ "$1" == active ]]; then
    case "$TEST_CASE" in
      normal|read-failure) return 0 ;;
      final-read-failure) touch "$FIXTURE_DIR/fail-final"; return 0 ;;
      *) return 1 ;;
    esac
  fi
  return 0
}
# A final-read fault is one-shot so only the operation's exact receipt can
# authorize a subsequent rollback after read access recovers.
eval "$(declare -f recovery_read_recovery_operation_fence_state | sed '1s/recovery_read_recovery_operation_fence_state/fixture_original_read/')"
recovery_read_recovery_operation_fence_state() {
  if [[ -e "$FIXTURE_DIR/fail-final" && "$ROLLBACK" == 0 ]]; then return 1; fi
  fixture_original_read "$@"
}
${shellFunction("require_checkpoint_dormant_operation_fence_now")}
${shellFunction("deactivate_checkpoint_operation_fence_before_resume")}
if recovery_activate_recovery_operation_fence CHECKPOINT_OPERATION_FENCE_ACTIVE_IDENTITY; then activation=0; else activation=$?; fi
receipt="$CHECKPOINT_OPERATION_FENCE_ACTIVE_IDENTITY"
ROLLBACK=1
if deactivate_checkpoint_operation_fence_before_resume; then rollback=0; else rollback=$?; fi
jq -cn --argjson activation "$activation" --argjson rollback "$rollback" --arg receipt "$receipt" --arg dormant "$CHECKPOINT_OPERATION_FENCE_DORMANT_IDENTITY" '{activation:$activation,rollback:$rollback,receipt:$receipt,dormant:$dormant}'
`;
  try {
    const result = spawnSync("bash", ["-c", script], {
      cwd: root, env: { ...process.env, FIXTURE_DIR: dir, TEST_CASE: mode },
      encoding: "utf8", timeout: 30000
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    const lines = name => fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name), "utf8").trim().split("\n") : [];
    return { ...JSON.parse(result.stdout), diagnostic: result.stderr, replacements: lines("replacements"), probes: lines("probes") };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("normal activation still completes probes before successful return and exact rollback", () => {
  const r = run("normal");
  assert.equal(r.activation, 0, r.diagnostic); assert.equal(r.rollback, 0, r.diagnostic);
  assert.equal(JSON.parse(r.receipt).binding.resource_version, "active-rv");
  assert.deepEqual(r.probes, ["active", "dormant"]);
  assert.deepEqual(r.replacements, ["In", "DoesNotExist"]);
});
for (const mode of ["read-failure", "propagation-failure", "final-read-failure"]) {
  test(`${mode}: confirmed activation remains failed but exact rollback is possible`, () => {
    const r = run(mode);
    assert.notEqual(r.activation, 0); assert.equal(r.rollback, 0);
    assert.equal(JSON.parse(r.receipt).binding.resource_version, "active-rv");
    assert.deepEqual(r.replacements, ["In", "DoesNotExist"]);
  });
}
for (const mode of ["lost-response", "invalid-response", "wrong-uid", "no-rv-advance"]) {
  test(`${mode}: no receipt is inferred from observed state`, () => {
    const r = run(mode);
    assert.notEqual(r.activation, 0); assert.notEqual(r.rollback, 0);
    assert.equal(r.receipt, ""); assert.deepEqual(r.replacements, ["In"]);
  });
}
for (const mode of ["lease-lost", "lock-changed", "policy-aba", "binding-aba", "writer-active"]) {
  test(`${mode}: a committed receipt cannot bypass rollback guards`, () => {
    const r = run(mode);
    assert.notEqual(r.activation, 0); assert.notEqual(r.rollback, 0);
    assert.ok(r.receipt); assert.deepEqual(r.replacements, ["In"]);
  });
}

test("resume reports both bounded failures without printing untrusted context", () => {
  const functions = ["checkpoint_failure_context_is_safe", "checkpoint_report_resume_failure", "resume_writers_with_single_reentry"].map(shellFunction).join("\n");
  const r = spawnSync("bash", ["-c", `${functions}
CHECKPOINT_FAILURE_STAGE=resume; CHECKPOINT_FAILURE_CODE=fence-continuity
resume_writers() { return 7; }
resume_writers_with_single_reentry
status=$?
CHECKPOINT_FAILURE_STAGE=secret-sentinel; CHECKPOINT_FAILURE_CODE=secret-sentinel
checkpoint_report_resume_failure 1 7
exit "$status"`], { encoding: "utf8" });
  assert.equal(r.status, 7);
  assert.match(r.stderr, /attempt=1 stage=resume code=fence-continuity status=7/);
  assert.match(r.stderr, /attempt=2 stage=resume code=fence-continuity status=7/);
  assert.match(r.stderr, /stage=pre-publication code=unclassified/);
  assert.doesNotMatch(r.stderr, /secret-sentinel/);
});

test("every quiescence diagnostic label is allowlisted", () => {
  const labels = [...shellFunction("quiesce_writers").matchAll(/checkpoint_set_failure_context quiescence ([a-z-]+)/g)].map(m => m[1]);
  assert.ok(labels.length >= 12);
  const r = spawnSync("bash", ["-c", `${shellFunction("checkpoint_failure_context_is_safe")}\nfor code in ${labels.join(" ")}; do checkpoint_failure_context_is_safe quiescence "$code" || exit 1; done`]);
  assert.equal(r.status, 0);
});

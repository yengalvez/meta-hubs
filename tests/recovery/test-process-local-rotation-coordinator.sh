#!/usr/bin/env bash

set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
DRIVER="$ROOT_DIR/deployment/rotate-process-local-credentials.sh"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/aud065-driver-test.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS_COUNT=0
FAIL_COUNT=0

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf 'ok %d - %s\n' "$((PASS_COUNT + FAIL_COUNT))" "$1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf 'not ok %d - %s\n' "$((PASS_COUNT + FAIL_COUNT))" "$1"
}

expect_equal() {
  local actual="$1" expected="$2" description="$3"
  if [[ "$actual" == "$expected" ]]; then pass "$description"; else
    printf '  expected: %s\n  actual:   %s\n' "$expected" "$actual" >&2
    fail "$description"
  fi
}

expect_failure() {
  local description="$1"
  shift
  if "$@" >/dev/null 2>&1; then fail "$description"; else pass "$description"; fi
}

printf 'TAP version 13\n'

if bash -n "$DRIVER"; then pass 'driver has valid Bash syntax'; else fail 'driver has valid Bash syntax'; fi
if [[ -x "$DRIVER" ]]; then pass 'driver is executable'; else fail 'driver is executable'; fi

export AUD065_DRIVER_SOURCE_ONLY=1
# shellcheck source=deployment/rotate-process-local-credentials.sh
source "$DRIVER"
driver_prepare_body="$(declare -f aud065_prepare_bundle)"
driver_write_terminal_body="$(declare -f aud065_write_or_verify_terminal)"
driver_plan_body="$(declare -f aud065_plan)"
driver_execute_body="$(declare -f aud065_execute_or_resume)"
driver_missing_terminal_body="$(declare -f aud065_verify_missing_lock_terminal)"
driver_audit_body="$(declare -f aud065_audit)"

entrypoint_status=0
if AUD065_DRIVER_SOURCE_ONLY=1 "$DRIVER" audit >/dev/null 2>&1; then
  entrypoint_status=0
else
  entrypoint_status=$?
fi
if [[ "$entrypoint_status" == 2 ]]; then
  pass 'an inherited test-only environment variable cannot suppress the real CLI entrypoint'
else
  fail 'an inherited test-only environment variable cannot suppress the real CLI entrypoint'
fi

if aud065_require_python_helper_environment; then
  pass 'sanitized system Python provides dir_fd, pread and pwrite for the regular helper'
else
  fail 'sanitized system Python provides dir_fd, pread and pwrite for the regular helper'
fi

HOSTILE_PYTHON_BIN="$TMP_ROOT/hostile-python-bin"
HOSTILE_PYTHON_MARKER="$TMP_ROOT/hostile-python-invoked"
mkdir -m 700 "$HOSTILE_PYTHON_BIN"
cat >"$HOSTILE_PYTHON_BIN/python3" <<'HOSTILE_PYTHON'
#!/usr/bin/env bash
: >"$HOSTILE_PYTHON_MARKER"
exit 0
HOSTILE_PYTHON
chmod 700 "$HOSTILE_PYTHON_BIN/python3"
export HOSTILE_PYTHON_MARKER
if PATH="$HOSTILE_PYTHON_BIN:$PATH" aud065_require_python_helper_environment &&
   [[ ! -e "$HOSTILE_PYTHON_MARKER" ]]; then
  pass 'dirfd capability preflight ignores an untrusted Python earlier in PATH'
else
  fail 'dirfd capability preflight ignores an untrusted Python earlier in PATH'
fi

run_invalid_helper_fixture() {
  local kind="$1" copy="$TMP_ROOT/helper-$1-deployment"
  cp -R "$ROOT_DIR/deployment" "$copy"
  rm -f "$copy/private-dirfd-ops.py"
  case "$kind" in
    missing) : ;;
    symlink) ln -s /dev/null "$copy/private-dirfd-ops.py" ;;
    directory) mkdir -m 700 "$copy/private-dirfd-ops.py" ;;
    *) return 2 ;;
  esac
  bash -c '
    set -Eeuo pipefail
    source "$1/rotate-process-local-credentials.sh"
    aud065_require_python_helper_environment
  ' bash "$copy"
}

for invalid_helper_kind in missing symlink directory; do
  expect_failure "Python capability preflight rejects a $invalid_helper_kind dirfd helper" \
    run_invalid_helper_fixture "$invalid_helper_kind"
done

python_preflight_body="$(declare -f aud065_require_python_helper_environment)"
if rg -q -F 'PATH=/usr/bin:/bin command -v python3' <<<"$python_preflight_body" &&
   rg -q -F 'os.supports_dir_fd' <<<"$python_preflight_body" &&
   rg -q -F 'getattr(os, "pread", None)' <<<"$python_preflight_body" &&
   rg -q -F 'getattr(os, "pwrite", None)' <<<"$python_preflight_body"; then
  pass 'Python preflight binds the helper runtime to its minimum filesystem capabilities'
else
  fail 'Python preflight binds the helper runtime to its minimum filesystem capabilities'
fi

ENVIRONMENT_ORDER_LOG="$TMP_ROOT/environment-order.log"
environment_status=0
if bash -c '
  set -Eeuo pipefail
  source "$1"
  LOG="$2"
  aud065_parse_cli() { AUD065_COMMAND=execute; }
  aud065_require_environment() { printf "python-helper-preflight\n" >>"$LOG"; return 1; }
  aud065_execute_or_resume() { printf "FORBIDDEN-mutation-path\n" >>"$LOG"; }
  aud065_error() { :; }
  main fixture
' bash "$DRIVER" "$ENVIRONMENT_ORDER_LOG" >/dev/null 2>&1; then
  environment_status=0
else
  environment_status=$?
fi
if [[ "$environment_status" != 0 &&
      "$(cat "$ENVIRONMENT_ORDER_LOG")" == python-helper-preflight ]]; then
  pass 'environment and Python helper preflight fail before every coordinator mutation path'
else
  fail 'environment and Python helper preflight fail before every coordinator mutation path'
fi

run_freshness_fixture() {
  local created_epoch="$1" current_epoch="$2" maximum_age="$3"
  bash -c '
    set -Eeuo pipefail
    source "$1"
    AUD065_CHECKPOINT_CREATED_AT_EPOCH="$2"
    FIXTURE_CURRENT_EPOCH="$3"
    aud065_current_epoch() { printf "%s\n" "$FIXTURE_CURRENT_EPOCH"; }
    if [[ "$4" == default ]]; then
      unset MAX_CHECKPOINT_AGE_SECONDS
    else
      MAX_CHECKPOINT_AGE_SECONDS="$4"
    fi
    aud065_require_checkpoint_freshness
  ' bash "$DRIVER" "$created_epoch" "$current_epoch" "$maximum_age"
}

if run_freshness_fixture 100 200 100; then
  pass 'checkpoint freshness accepts the exact configured TTL boundary'
else
  fail 'checkpoint freshness accepts the exact configured TTL boundary'
fi
expect_failure 'checkpoint freshness rejects one second beyond the configured TTL' \
  run_freshness_fixture 99 200 100
expect_failure 'checkpoint freshness rejects a future checkpoint timestamp' \
  run_freshness_fixture 201 200 100
for invalid_ttl in 0 -1 invalid; do
  expect_failure "checkpoint freshness rejects invalid TTL $invalid_ttl" \
    run_freshness_fixture 100 100 "$invalid_ttl"
done
if run_freshness_fixture 100 86500 default; then
  pass 'checkpoint freshness defaults to an inclusive 86400 second TTL'
else
  fail 'checkpoint freshness defaults to an inclusive 86400 second TTL'
fi
expect_failure 'default checkpoint freshness rejects age 86401 seconds' \
  run_freshness_fixture 100 86501 default

if rg -q -F '"$AUD065_OLD_VALUES_COPY" "$AUD065_OLD_SNAPSHOT"' \
     <<<"$driver_plan_body" &&
   rg -q -F '"$AUD065_NEW_VALUES_COPY" "$AUD065_NEW_SNAPSHOT"' \
     <<<"$driver_plan_body" &&
   ! rg -q -F '"$AUD065_OLD_VALUES_SOURCE" "$AUD065_OLD_SNAPSHOT"' \
     <<<"$driver_plan_body" &&
   ! rg -q -F '"$AUD065_NEW_VALUES_SOURCE" "$AUD065_NEW_SNAPSHOT"' \
     <<<"$driver_plan_body"; then
  pass 'process-local projections derive only from sealed full-source copies'
else
  fail 'process-local projections derive only from sealed full-source copies'
fi
if [[ "$(rg -n -F 'aud065_verify_source_state new' \
       <<<"$driver_missing_terminal_body" | cut -d: -f1)" -lt \
      "$(rg -n -F 'aud065_verify_terminal_record' \
       <<<"$driver_missing_terminal_body" | cut -d: -f1)" ]]; then
  pass 'missing-lock terminal fast path first requires exact canonical new source'
else
  fail 'missing-lock terminal fast path first requires exact canonical new source'
fi
if ! rg -q 'aud065_acquire_lease|aud065_create_or_adopt_lock|recovery_acquire_operation_lock|recovery_kubectl_mutate|aud065_run_(rotation|rollback)_callbacks|aud065_scale_deployment_exact|aud065_verify_or_create_report|aud065_capture_and_verify_released_state' \
     <<<"$driver_audit_body"; then
  pass 'audit body contains no Lease, lock creation, callback, mutation, scale or report recreation path'
else
  fail 'audit body contains no Lease, lock creation, callback, mutation, scale or report recreation path'
fi
if [[ "$(rg -c 'aud065_require_checkpoint_freshness' <<<"$driver_plan_body")" == 1 ]] &&
   [[ "$(rg -c 'aud065_require_checkpoint_freshness' <<<"$driver_execute_body")" == 1 ]] &&
   rg -q -F 'if [[ "$mode" == execute ]]' <<<"$driver_execute_body" &&
   ! rg -q 'aud065_require_checkpoint_freshness' <<<"$driver_audit_body"; then
  pass 'freshness gates plan and initial execute but never resume, rollback or audit'
else
  fail 'freshness gates plan and initial execute but never resume, rollback or audit'
fi

scratch_worker_failure=""
for scratch_worker in \
  aud065_capture_and_verify_released_state \
  aud065_verify_preflight_live_boundary \
  aud065_capture_or_reconcile_baseline \
  aud065_apply_bundle_exact \
  aud065_capture_public_material \
  aud065_verify_or_create_report \
  aud065_verify_fresh_cleanup_gate \
  aud065_rb_validate_bundle_quiesced; do
  if ! rg -q 'aud065_with_scratch_directory' <<<"$(declare -f "$scratch_worker")"; then
    scratch_worker_failure="$scratch_worker"
    break
  fi
done
if [[ -z "$scratch_worker_failure" ]] &&
   [[ "$(rg -c 'aud065_make_scratch_directory' "$DRIVER")" == 2 ]] &&
   ! rg -q 'scratch="\$\(aud065_make_scratch_directory' "$DRIVER"; then
  pass 'every private scratch worker is routed through the identity-bound finally helper'
else
  fail 'every private scratch worker is routed through the identity-bound finally helper'
fi

run_scratch_finally_fixture() {
  local stage="$1" fixture_root="$TMP_ROOT/scratch-finally-$1" output
  mkdir -m 700 "$fixture_root"
  fixture_root="$(cd "$fixture_root" && pwd -P)"
  output="$(bash -c '
    set -Eeuo pipefail
    source "$1"
    AUD065_OPERATION_DIRECTORY="$2"
    STAGE="$3"
    aud065_fixture_scratch_stage() {
      local scratch="$1"
      printf private-fixture-bytes >"$scratch/live.json"
      chmod 600 "$scratch/live.json"
      [[ "$STAGE" != capture ]] || return 41
      printf private-fixture-bytes >"$scratch/report.json"
      chmod 600 "$scratch/report.json"
      [[ "$STAGE" != verify ]] || return 42
      [[ "$STAGE" != publish ]] || return 43
    }
    status=0
    if aud065_with_scratch_directory aud065_fixture_scratch_stage; then
      status=0
    else
      status=$?
    fi
    leftovers="$(find "$AUD065_OPERATION_DIRECTORY" -mindepth 1 -maxdepth 1 \
      -name ".scratch.*" | wc -l | tr -d " ")"
    printf "%s\t%s\t%s\n" "$status" "$leftovers" \
      "${#AUD065_SCRATCH_DIRECTORIES[@]}"
  ' bash "$DRIVER" "$fixture_root" "$stage")"
  case "$stage" in
    capture) [[ "$output" == $'41\t0\t0' ]] ;;
    verify) [[ "$output" == $'42\t0\t0' ]] ;;
    publish) [[ "$output" == $'43\t0\t0' ]] ;;
    success) [[ "$output" == $'0\t0\t0' ]] ;;
    *) return 2 ;;
  esac
}

for scratch_stage in capture verify publish success; do
  if run_scratch_finally_fixture "$scratch_stage"; then
    pass "scratch finally removes private artifacts after $scratch_stage stage"
  else
    fail "scratch finally removes private artifacts after $scratch_stage stage"
  fi
done

run_scratch_trap_fixture() {
  local trap_kind="$1" fixture_root="$TMP_ROOT/scratch-trap-$1" status=0
  mkdir -m 700 "$fixture_root"
  fixture_root="$(cd "$fixture_root" && pwd -P)"
  if bash -c '
    set -Eeuo pipefail
    source "$1"
    AUD065_OPERATION_DIRECTORY="$2"
    AUD065_FAILURE_STAGE=scratch-trap-fixture
    aud065_make_scratch_directory scratch
    printf private-fixture-bytes >"$scratch/live.json"
    chmod 600 "$scratch/live.json"
    aud065_fail_close() { :; }
    aud065_release_lease_if_owned() { :; }
    case "$3" in
      error)
        trap aud065_on_error ERR
        false
        ;;
      signal) aud065_on_signal 143 ;;
      exit)
        trap aud065_on_exit EXIT
        exit 0
        ;;
      *) exit 2 ;;
    esac
  ' bash "$DRIVER" "$fixture_root" "$trap_kind" >/dev/null 2>&1; then
    status=0
  else
    status=$?
  fi
  case "$trap_kind" in
    error) [[ "$status" == 1 ]] ;;
    signal) [[ "$status" == 143 ]] ;;
    exit) [[ "$status" == 0 ]] ;;
    *) return 2 ;;
  esac &&
    [[ -z "$(find "$fixture_root" -mindepth 1 -maxdepth 1 -name '.scratch.*' -print -quit)" ]]
}

for trap_kind in error signal exit; do
  if run_scratch_trap_fixture "$trap_kind"; then
    pass "$trap_kind finalization removes every registered private scratch directory"
  else
    fail "$trap_kind finalization removes every registered private scratch directory"
  fi
done

run_scratch_identity_swap_fixture() {
  local fixture_root="$TMP_ROOT/scratch-identity-swap"
  mkdir -m 700 "$fixture_root"
  fixture_root="$(cd "$fixture_root" && pwd -P)"
  bash -c '
    set -Eeuo pipefail
    source "$1"
    AUD065_OPERATION_DIRECTORY="$2"
    aud065_make_scratch_directory scratch
    original="$scratch.original"
    mv "$scratch" "$original"
    mkdir -m 700 "$scratch"
    printf replacement-must-survive >"$scratch/replacement.marker"
    chmod 600 "$scratch/replacement.marker"
    if aud065_cleanup_scratch_directory "$scratch"; then exit 1; fi
    [[ -f "$scratch/replacement.marker" && -d "$original" ]]
  ' bash "$DRIVER" "$fixture_root"
}

if run_scratch_identity_swap_fixture; then
  pass 'scratch cleanup refuses a path whose registered device and inode changed'
else
  fail 'scratch cleanup refuses a path whose registered device and inode changed'
fi

run_stale_scratch_fixture() {
  local fixture_root="$TMP_ROOT/stale-scratch"
  mkdir -m 700 "$fixture_root" "$fixture_root/.scratch.orphan"
  fixture_root="$(cd "$fixture_root" && pwd -P)"
  printf private-fixture-bytes >"$fixture_root/.scratch.orphan/live.json"
  chmod 600 "$fixture_root/.scratch.orphan/live.json"
  bash -c '
    set -Eeuo pipefail
    source "$1"
    AUD065_OPERATION_DIRECTORY="$2"
    if aud065_make_scratch_directory scratch; then exit 1; fi
    [[ -f "$2/.scratch.orphan/live.json" &&
       "${#AUD065_SCRATCH_DIRECTORIES[@]}" == 0 ]]
  ' bash "$DRIVER" "$fixture_root"
}

if run_stale_scratch_fixture; then
  pass 'an unregistered stale scratch fails closed instead of accumulating another copy'
else
  fail 'an unregistered stale scratch fails closed instead of accumulating another copy'
fi

AUD065_OPERATION_DIRECTORY=""
AUD065_CHECKPOINT_DIRECTORY=""
AUD065_OLD_VALUES_SOURCE=""
AUD065_NEW_VALUES_SOURCE=""
AUD065_ROTATION_REVISION=""
if aud065_parse_cli plan \
  --operation-directory /private/op \
  --checkpoint-directory /private/checkpoint \
  --old-values-source /private/old \
  --new-values-source /private/new \
  --rotation-revision aud065-fixture-01; then
  pass 'plan accepts only the explicit complete flag set'
else
  fail 'plan accepts only the explicit complete flag set'
fi
expect_failure 'plan rejects an omitted private source' \
  aud065_parse_cli plan --operation-directory /private/op \
    --checkpoint-directory /private/checkpoint \
    --old-values-source /private/old --rotation-revision aud065-fixture-01

AUD065_OPERATION_DIRECTORY=""
AUD065_CHECKPOINT_DIRECTORY=""
AUD065_OLD_VALUES_SOURCE=""
AUD065_NEW_VALUES_SOURCE=""
AUD065_ROTATION_REVISION=""
if aud065_parse_cli resume --operation-directory /private/op \
  --checkpoint-directory /private/checkpoint; then
  pass 'resume accepts only operation and checkpoint paths'
else
  fail 'resume accepts only operation and checkpoint paths'
fi
expect_failure 'resume rejects plan-only flags' aud065_parse_cli resume \
  --operation-directory /private/op --checkpoint-directory /private/checkpoint \
  --old-values-source /private/old

AUD065_OPERATION_DIRECTORY=""
AUD065_CHECKPOINT_DIRECTORY=""
if aud065_parse_cli rollback --operation-directory /private/op \
  --checkpoint-directory /private/checkpoint; then
  pass 'rollback accepts only operation and checkpoint paths'
else
  fail 'rollback accepts only operation and checkpoint paths'
fi

AUD065_OPERATION_DIRECTORY=""
AUD065_CHECKPOINT_DIRECTORY=""
if aud065_parse_cli audit --operation-directory /private/op \
  --checkpoint-directory /private/checkpoint; then
  pass 'audit accepts only operation and checkpoint paths'
else
  fail 'audit accepts only operation and checkpoint paths'
fi
expect_failure 'audit rejects plan-only flags' aud065_parse_cli audit \
  --operation-directory /private/op --checkpoint-directory /private/checkpoint \
  --new-values-source /private/new

run_audit_fixture() {
  local state="$1" log_path="$2" output status=0
  : >"$log_path"
  if output="$(bash -c '
    set -Eeuo pipefail
    export AUD065_DRIVER_SOURCE_ONLY=1
    source "$1"
    LOG_PATH="$2"
    STATE="$3"
    NAMESPACE=hcce
    AUD065_OPERATION_DIRECTORY=/private/aud065-operation
    AUD065_CHECKPOINT_DIRECTORY=/private/checkpoint
    audit_log() { printf "%s\n" "$1" >>"$LOG_PATH"; }
    aud065_lock_json() {
      audit_log lock-read
      count="$(awk '\''$0 == "lock-read" { count += 1 } END { print count + 0 }'\'' \
        "$LOG_PATH")"
      if [[ "$STATE" == lock-start && "$count" == 1 ]] ||
         [[ "$STATE" == lock-final && "$count" == 2 ]]; then
        printf "{}\n"
      fi
    }
    aud065_verify_operation_checkpoint() { audit_log operation-checkpoint; }
    aud065_verify_source_state() {
      audit_log "source:$1"
      count="$(awk '\''$0 == "source:new" { count += 1 } END { print count + 0 }'\'' \
        "$LOG_PATH")"
      [[ "$STATE" != source-drift ]] &&
        ! [[ "$STATE" == source-drift-final && "$count" == 2 ]]
    }
    recovery_require_live_process_local_runner_exact() { audit_log process-local-exact; }
    aud065_verify_terminal_record_read_only() {
      audit_log terminal-read-only
      AUD065_PGSQL_INITIAL_RESOURCE_VERSION=rv-initial
      count="$(awk '\''$0 == "terminal-read-only" { count += 1 } END { print count + 0 }'\'' \
        "$LOG_PATH")"
      ! [[ "$STATE" == terminal-drift-final && "$count" == 2 ]]
    }
    aud065_pgsql_require_single_policy() {
      audit_log policy-inventory
      [[ "$STATE" != second-policy ]]
    }
    recovery_kubectl() {
      audit_log policy-get
      printf '\''{"metadata":{"resourceVersion":"rv-released"}}\n'\''
    }
    aud065_pgsql_policy_json_is_exact() { audit_log "policy-exact:$2"; }
    aud065_pgsql_probe_inventory() { audit_log probe-inventory; printf "[]\n"; }
    aud065_verify_live_release_read_only() {
      audit_log live-release
      [[ "$STATE" != readiness-drift ]]
    }
    aud065_require_started_read_only() { audit_log "started:$1"; }
    recovery_require_live_images_match_checkpoint() { audit_log images-checkpoint; }
    forbidden() { audit_log "FORBIDDEN:$1"; return 1; }
    aud065_acquire_lease() { forbidden lease; }
    aud065_create_or_adopt_lock() { forbidden lock-create-adopt; }
    recovery_acquire_operation_serialization() { forbidden serialization-lease; }
    recovery_acquire_operation_lock() { forbidden lock-create; }
    recovery_transition_aud065_operation_lock() { forbidden lock-transition; }
    recovery_kubectl_mutate() { forbidden kubectl-mutate; }
    recovery_kubectl_stream_guarded() { forbidden kubectl-exec; }
    aud065_run_rotation_callbacks() { forbidden rotation-callbacks; }
    aud065_run_rollback_callbacks() { forbidden rollback-callbacks; }
    aud065_scale_deployment_exact() { forbidden scale; }
    aud065_verify_or_create_report() { forbidden report-write; }
    aud065_capture_and_verify_released_state() { forbidden baseline-write; }
    aud065_fail_close() { forbidden fail-close; }
    aud065_audit
  ' bash "$DRIVER" "$log_path" "$state")"; then
    status=0
  else
    status=$?
  fi
  AUDIT_FIXTURE_OUTPUT="$output"
  AUDIT_FIXTURE_STATUS="$status"
}

AUDIT_LOG="$TMP_ROOT/audit.log"
run_audit_fixture success "$AUDIT_LOG"
expected_audit_order=$'lock-read\noperation-checkpoint\nsource:new\nprocess-local-exact\nterminal-read-only\npolicy-inventory\npolicy-get\npolicy-exact:normal\nprobe-inventory\nlive-release\nstarted:bot-orchestrator\nstarted:reticulum\nstarted:coturn\nstarted:dialog\nstarted:pgbouncer\nstarted:pgbouncer-t\nimages-checkpoint\nsource:new\nterminal-read-only\nlock-read'
if [[ "$AUDIT_FIXTURE_STATUS" == 0 &&
      "$AUDIT_FIXTURE_OUTPUT" == aud065_rotation_verified &&
      "$(cat "$AUDIT_LOG")" == "$expected_audit_order" ]] &&
   ! rg -q '^FORBIDDEN:' "$AUDIT_LOG"; then
  pass 'audit proves the exact terminal state with two lock reads and zero mutation or Lease paths'
else
  fail 'audit proves the exact terminal state with two lock reads and zero mutation or Lease paths'
fi

for audit_drift in lock-start lock-final source-drift source-drift-final \
  terminal-drift-final second-policy readiness-drift; do
  drift_log="$TMP_ROOT/audit-$audit_drift.log"
  run_audit_fixture "$audit_drift" "$drift_log"
  if [[ "$AUDIT_FIXTURE_STATUS" != 0 &&
        "$AUDIT_FIXTURE_OUTPUT" != *aud065_rotation_verified* ]] &&
     ! rg -q '^FORBIDDEN:' "$drift_log"; then
    pass "audit fails closed without mutation for $audit_drift"
  else
    fail "audit fails closed without mutation for $audit_drift"
  fi
done

AUDIT_TRAP_LOG="$TMP_ROOT/audit-read-only-trap.log"
audit_trap_status=0
if bash -c '
  set -Eeuo pipefail
  export AUD065_DRIVER_SOURCE_ONLY=1
  source "$1"
  LOG_PATH="$2"
  audit_trap_log() { printf "%s\n" "$1" >>"$LOG_PATH"; }
  aud065_parse_cli() { AUD065_COMMAND=audit; }
  aud065_require_environment() { return 1; }
  aud065_fail_close() { audit_trap_log FORBIDDEN-fail-close; }
  aud065_release_lease_if_owned() { audit_trap_log FORBIDDEN-release-lease; }
  aud065_error() { audit_trap_log read-only-error; }
  main fixture
' bash "$DRIVER" "$AUDIT_TRAP_LOG" >/dev/null 2>&1; then
  audit_trap_status=0
else
  audit_trap_status=$?
fi
if [[ "$audit_trap_status" == 1 &&
      "$(cat "$AUDIT_TRAP_LOG")" == read-only-error ]]; then
  pass 'audit ERR trap never enters fail-close or Lease release paths'
else
  fail 'audit ERR trap never enters fail-close or Lease release paths'
fi

run_operation_checkpoint_guard_fixture() {
  local failure_stage="$1"
  bash -c '
    set -Eeuo pipefail
    source "$1"
    FAILURE_STAGE="$2"
    AUD065_OPERATION_DIRECTORY=/private/aud065-operation
    AUD065_CHECKPOINT_DIRECTORY=/private/checkpoint
    EXPECTED_KUBE_CONTEXT=fixture-context
    EXPECTED_NAMESPACE_UID=fixture-namespace-uid
    EXPECTED_RET_PVC_UID=fixture-pvc-uid
    NAMESPACE=hcce
    AUD065_PROFILE_ID=fixture-profile
    AUD065_PROFILE_SHA256="$(printf "f%.0s" {1..64})"
    guard_step() { [[ "$FAILURE_STAGE" != "$1" ]]; }
    aud065_require_private_directory() { guard_step private-directory; }
    aud065_load_intent() {
      RECOVERY_CHECKPOINT_STAMP=20260718-120000
      RECOVERY_DUMP_SHA256="$(printf "a%.0s" {1..64})"
      RECOVERY_STORAGE_SHA256="$(printf "b%.0s" {1..64})"
      RECOVERY_DEPLOYMENT_INVENTORY_SHA256="$(printf "c%.0s" {1..64})"
      RECOVERY_OPERATION_ID="$(printf "1%.0s" {1..32})"
      RECOVERY_OPERATION_BINDING_SHA256="$(printf "2%.0s" {1..64})"
      guard_step load-intent
    }
    aud065_load_checkpoint_contract() {
      RECOVERY_CHECKPOINT_STAMP=20260718-120000
      RECOVERY_DUMP_SHA256="$(printf "a%.0s" {1..64})"
      RECOVERY_STORAGE_SHA256="$(printf "b%.0s" {1..64})"
      RECOVERY_DEPLOYMENT_INVENTORY_SHA256="$(printf "c%.0s" {1..64})"
      guard_step checkpoint-contract
    }
    recovery_require_cluster_identity() { guard_step cluster-identity; }
    recovery_require_pvc_identity() { guard_step pvc-identity; }
    recovery_require_live_images_match_checkpoint() { guard_step checkpoint-images; }
    aud065_operation_tool() { guard_step operation-tool; }
    aud065_verify_operation_checkpoint
  ' bash "$DRIVER" "$failure_stage"
}

for checkpoint_guard in private-directory load-intent checkpoint-contract \
  cluster-identity pvc-identity checkpoint-images operation-tool; do
  expect_failure "operation checkpoint propagates $checkpoint_guard failure under a conditional caller" \
    run_operation_checkpoint_guard_fixture "$checkpoint_guard"
done

run_lease_guard_fixture() {
  local failure_stage="$1"
  bash -c '
    set -Eeuo pipefail
    source "$1"
    FAILURE_STAGE="$2"
    AUD065_LEASE_ACQUIRED=0
    recovery_acquire_operation_serialization() { [[ "$FAILURE_STAGE" != acquire ]]; }
    recovery_require_operation_serialization() { [[ "$FAILURE_STAGE" != revalidate ]]; }
    if aud065_acquire_lease; then exit 0; else exit 1; fi
  ' bash "$DRIVER" "$failure_stage"
}
for lease_failure in acquire revalidate; do
  expect_failure "Lease acquisition propagates $lease_failure failure under a conditional caller" \
    run_lease_guard_fixture "$lease_failure"
done

if bash -c '
  set -Eeuo pipefail
  source "$1"
  AUD065_LEASE_ACQUIRED=0
  RECOVERY_SERIALIZATION_LEASE_REQUIRED=0
  RELEASE_CALLS=0
  recovery_acquire_operation_serialization() {
    RECOVERY_SERIALIZATION_LEASE_REQUIRED=1
    return 1
  }
  recovery_release_operation_serialization() {
    RELEASE_CALLS=$((RELEASE_CALLS + 1))
    RECOVERY_SERIALIZATION_LEASE_REQUIRED=0
  }
  if aud065_acquire_lease; then exit 1; fi
  aud065_release_lease_if_owned
  [[ "$RELEASE_CALLS" == 1 && "$RECOVERY_SERIALIZATION_LEASE_REQUIRED" == 0 ]]
' bash "$DRIVER"; then
  pass 'failed post-acquire Lease setup leaves outer cleanup armed for an immediate retry'
else
  fail 'failed post-acquire Lease setup leaves outer cleanup armed for an immediate retry'
fi

run_operation_lock_guard_fixture() {
  local failure_stage="$1" mode=execute live=""
  [[ "$failure_stage" == discover ]] && mode=resume && live='{}'
  bash -c '
    set -Eeuo pipefail
    source "$1"
    FAILURE_STAGE="$2"
    MODE="$3"
    LIVE="$4"
    aud065_lock_json() { printf "%s" "$LIVE"; }
    recovery_acquire_operation_lock() { [[ "$FAILURE_STAGE" != acquire ]]; }
    aud065_crash_point() { [[ "$FAILURE_STAGE" != crash ]]; }
    aud065_discover_lock() { [[ "$FAILURE_STAGE" != discover ]]; }
    recovery_require_operation_lock() { [[ "$FAILURE_STAGE" != require ]]; }
    if aud065_create_or_adopt_lock "$MODE"; then exit 0; else exit 1; fi
  ' bash "$DRIVER" "$failure_stage" "$mode" "$live"
}
for lock_failure in acquire crash discover require; do
  expect_failure "operation lock path propagates $lock_failure failure under a conditional caller" \
    run_operation_lock_guard_fixture "$lock_failure"
done

# Expansion is intentionally performed by the isolated Bash process.
# shellcheck disable=SC2016
expect_failure 'runtime credential emitter stops at an xtrace guard failure inside a pipeline' \
  bash -c '
    set -Eeuo pipefail
    source "$1"
    aud065_require_no_xtrace() { return 55; }
    aud065_operation_tool() { printf "FORBIDDEN-emitter-ran\n"; }
    aud065_emit_runtime_password new | command cat
  ' bash "$DRIVER"

run_probe_block_guard_fixture() {
  local failure_call="$1"
  bash -c '
    set -Eeuo pipefail
    source "$1"
    FAILURE_CALL="$2"
    CALLS=0
    aud065_probe_exec_status() {
      CALLS=$((CALLS + 1))
      [[ "$CALLS" != "$FAILURE_CALL" ]] || return 1
      printf "1\n"
    }
    if aud065_probe_blocked_three >/dev/null; then exit 0; else exit 1; fi
  ' bash "$DRIVER" "$failure_call"
}
for probe_failure_call in 1 2 3; do
  expect_failure "three-sample probe callback propagates sample $probe_failure_call failure" \
    run_probe_block_guard_fixture "$probe_failure_call"
done

# The plan fixture replaces Node with a value-free command logger. Kubernetes
# validation is represented by one read-boundary marker; a kubectl stub fails
# the test if any mutating verb is attempted.
FIXTURE_BIN="$TMP_ROOT/bin"
mkdir -m 700 "$FIXTURE_BIN"
PLAN_LOG="$TMP_ROOT/plan.log"
export PLAN_LOG
cat >"$FIXTURE_BIN/node" <<'NODE_STUB'
#!/usr/bin/env bash
set -euo pipefail
tool="${1##*/}"
shift
if [[ "$tool" == --input-type=module && "${1:-}" == - && "$#" == 3 ]]; then
  printf 'node:process-local-rotation-operation.mjs:load-intent\n' >>"$PLAN_LOG"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    11111111111111111111111111111111 \
    22222222222222222222222222222222 \
    3333333333333333333333333333333333333333333333333333333333333333 \
    aud065-fixture-01 fixture-context hcce fixture-uid fixture-pvc-uid \
    20260718-120000 \
    aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc \
    yenhubs-process-local-credential-rotation-v1 \
    1b922b6313c9b5e98b3dfd95c3d619da74c752f3f5ab85361e929c9348fe549b
  exit 0
fi
if [[ "$tool" == --input-type=module && "${1:-}" == - && "$#" == 6 ]]; then
  printf '%s\t%s\t%s\t%s\t%s' \
    policy-uid rv-77 \
    dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd \
    eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee \
    lock-fixture-uid
  exit 0
fi
printf 'node:%s:%s\n' "$tool" "${1:-}" >>"$PLAN_LOG"
if [[ "$tool" == prepare-process-local-rotation.mjs &&
      "${1:-}" == verify-plan && -n "${PLAN_VERIFY_FAILURE:-}" ]]; then
  exit 71
fi
if [[ "$tool" == process-local-rotation-operation.mjs && "${1:-}" == init ]]; then
  shift
  operation=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in --operation-directory) operation="$2";; esac
    shift 2
  done
  mkdir -m 700 "$operation"
  : >"$operation/operation.key"
  : >"$operation/identity.json"
  : >"$operation/revision.json"
  chmod 600 "$operation"/*
elif [[ "$tool" == capture-process-local-baseline.mjs ]]; then
  output=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in --output) output="$2";; esac
    shift 2
  done
  printf '{}\n' >"$output"
  chmod 600 "$output"
elif [[ "$tool" == project-process-local-values.mjs ]]; then
  printf '{}\n' >"$2"
  chmod 600 "$2"
fi
NODE_STUB
cat >"$FIXTURE_BIN/kubectl" <<'KUBECTL_STUB'
#!/usr/bin/env bash
set -euo pipefail
printf 'kubectl:%s\n' "$*" >>"$PLAN_LOG"
case " $* " in
  *' create '*|*' replace '*|*' scale '*|*' delete '*|*' patch '*|*' apply '*) exit 91;;
esac
exit 0
KUBECTL_STUB
chmod 700 "$FIXTURE_BIN/node" "$FIXTURE_BIN/kubectl"

PLAN_PARENT="$TMP_ROOT/operations"
PLAN_CHECKPOINT="$TMP_ROOT/checkpoint"
mkdir -m 700 "$PLAN_PARENT" "$PLAN_CHECKPOINT"
printf 'old\n' >"$TMP_ROOT/old.values"
printf 'new\n' >"$TMP_ROOT/new.values"
chmod 600 "$TMP_ROOT/old.values" "$TMP_ROOT/new.values"
EXPECTED_KUBE_CONTEXT='fixture-context'
EXPECTED_NAMESPACE_UID='fixture-uid'
EXPECTED_RET_PVC_UID='fixture-pvc-uid'
NAMESPACE=hcce
export EXPECTED_KUBE_CONTEXT EXPECTED_NAMESPACE_UID EXPECTED_RET_PVC_UID NAMESPACE

aud065_require_private_directory() { return 0; }
aud065_require_private_file() { return 0; }
aud065_load_checkpoint_contract() {
  printf 'read:checkpoint\n' >>"$PLAN_LOG"
  AUD065_CHECKPOINT_CREATED_AT_EPOCH=100
  RECOVERY_CHECKPOINT_STAMP=20260718-120000
  RECOVERY_DUMP_SHA256="$(printf 'a%.0s' {1..64})"
  RECOVERY_STORAGE_SHA256="$(printf 'b%.0s' {1..64})"
  RECOVERY_DEPLOYMENT_INVENTORY_SHA256="$(printf 'c%.0s' {1..64})"
}
aud065_verify_live_plan_boundary() { printf 'read:live-boundary\n' >>"$PLAN_LOG"; }
PLAN_CURRENT_EPOCH=200
aud065_current_epoch() { printf '%s\n' "$PLAN_CURRENT_EPOCH"; }

AUD065_OPERATION_DIRECTORY="$PLAN_PARENT/op"
AUD065_CHECKPOINT_DIRECTORY="$PLAN_CHECKPOINT"
AUD065_OLD_VALUES_SOURCE="$TMP_ROOT/old.values"
AUD065_NEW_VALUES_SOURCE="$TMP_ROOT/new.values"
AUD065_ROTATION_REVISION=aud065-fixture-01
old_path="$PATH"
PATH="$FIXTURE_BIN:$PATH"
MAX_CHECKPOINT_AGE_SECONDS=99
if aud065_plan >/dev/null 2>&1; then
  fail 'plan rejects a stale checkpoint before live reads or durable operation creation'
elif [[ "$(cat "$PLAN_LOG")" == read:checkpoint ]]; then
  pass 'plan rejects a stale checkpoint before live reads or durable operation creation'
else
  fail 'plan rejects a stale checkpoint before live reads or durable operation creation'
fi
: >"$PLAN_LOG"
MAX_CHECKPOINT_AGE_SECONDS=100
plan_output="$(aud065_plan)"
PATH="$old_path"
expect_equal "$plan_output" aud065_plan_ready 'plan returns a value-free success token'
if ! rg -q '^kubectl:' "$PLAN_LOG"; then
  pass 'plan performs zero Kubernetes mutations in the fixture'
else
  fail 'plan performs zero Kubernetes mutations in the fixture'
fi
plan_order="$(sed -n '1,4p' "$PLAN_LOG")"
expect_equal "$plan_order" $'read:checkpoint\nread:live-boundary\nnode:process-local-rotation-operation.mjs:init\nnode:capture-process-local-baseline.mjs:--context' \
  'plan validates checkpoint and live boundary before durable capture'
expect_equal "$(tail -n 5 "$PLAN_LOG")" \
  $'node:process-local-rotation-operation.mjs:seal\nnode:process-local-rotation-operation.mjs:load-intent\nnode:process-local-rotation-operation.mjs:verify\nnode:process-local-source-transition.mjs:verify\nnode:prepare-process-local-rotation.mjs:verify-plan' \
  'plan verifies offline workload, policy and config invariants after sealing and before ready'

PATH="$FIXTURE_BIN:$old_path"
for invalid_plan_contract in replicas policy config; do
  : >"$PLAN_LOG"
  export PLAN_VERIFY_FAILURE="$invalid_plan_contract"
  AUD065_OPERATION_DIRECTORY="$PLAN_PARENT/op-invalid-$invalid_plan_contract"
  invalid_output=""
  if invalid_output="$(aud065_plan 2>/dev/null)"; then
    fail "plan rejects invalid $invalid_plan_contract invariant before ready"
  elif [[ "$invalid_output" != *aud065_plan_ready* ]] &&
       rg -q '^node:prepare-process-local-rotation.mjs:verify-plan$' "$PLAN_LOG" &&
       ! rg -q '^kubectl:' "$PLAN_LOG"; then
    pass "plan rejects invalid $invalid_plan_contract invariant before ready"
  else
    fail "plan rejects invalid $invalid_plan_contract invariant before ready"
  fi
done
saved_barrier_bind_function="$(declare -f aud065_pgsql_barrier_bind)"
AUD065_OPERATION_DIRECTORY="$PLAN_PARENT/op"
RECOVERY_OPERATION_ID="$(printf '1%.0s' {1..32})"
RECOVERY_OPERATION_BINDING_SHA256="$(printf '2%.0s' {1..64})"
RECOVERY_OPERATION_LOCK_UID=lock-fixture-uid
AUD065_ORIGINAL_PGSQL_POLICY_UID=""
AUD065_ORIGINAL_PGSQL_POLICY_RESOURCE_VERSION=""
aud065_pgsql_barrier_bind() { return 1; }
expect_failure 'barrier loader propagates bind failure under a conditional caller' \
  aud065_load_barrier_binding
eval "$saved_barrier_bind_function"
PATH="$old_path"
unset PLAN_VERIFY_FAILURE
unset MAX_CHECKPOINT_AGE_SECONDS

# Kubernetes may serialize every nested object in a different key order. The
# live fingerprint must remain identical to the canonical authenticated
# baseline/materializer fingerprint used by the driver's CAS wrapper.
saved_recovery_kubectl_function="$(declare -f recovery_kubectl)"
contract_one='{"kind":"Deployment","apiVersion":"apps/v1","metadata":{"resourceVersion":"17","namespace":"hcce","uid":"uid-demo","name":"demo"},"spec":{"template":{"spec":{"containers":[{"image":"repo/demo@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","name":"demo","env":[{"value":"b","name":"B"},{"name":"A","value":"a"}]}]},"metadata":{"labels":{"tier":"x","app":"demo"},"annotations":{"z":"1","a":"2"}}},"strategy":{"type":"RollingUpdate","rollingUpdate":{"maxUnavailable":"0","maxSurge":"1"}},"selector":{"matchExpressions":[],"matchLabels":{"app":"demo"}},"replicas":1}}'
contract_two='{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"demo","uid":"uid-demo","namespace":"hcce","resourceVersion":"17"},"spec":{"replicas":1,"selector":{"matchLabels":{"app":"demo"},"matchExpressions":[]},"strategy":{"rollingUpdate":{"maxSurge":"1","maxUnavailable":"0"},"type":"RollingUpdate"},"template":{"metadata":{"annotations":{"a":"2","z":"1"},"labels":{"app":"demo","tier":"x"}},"spec":{"containers":[{"env":[{"name":"B","value":"b"},{"value":"a","name":"A"}],"name":"demo","image":"repo/demo@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}}}}'
CONTRACT_JSON="$contract_one"
recovery_kubectl() { printf '%s\n' "$CONTRACT_JSON"; }
canonical_contract_one="$(aud065_capture_deployment_contract demo)"
CONTRACT_JSON="$contract_two"
canonical_contract_two="$(aud065_capture_deployment_contract demo)"
expect_equal "$canonical_contract_two" "$canonical_contract_one" \
  'deployment fingerprint canonicalizes reordered nested Kubernetes object keys'
eval "$saved_recovery_kubectl_function"

# Regression for the shell-subshell capability edge: capture must run in the
# current shell so the resourceVersion used by bind-barrier cannot disappear.
saved_capture_function="$(declare -f aud065_pgsql_barrier_capture_normal)"
saved_operation_tool_function="$(declare -f aud065_operation_tool)"
saved_crash_function="$(declare -f aud065_crash_point)"
BARRIER_LOG="$TMP_ROOT/barrier.log"
mkdir -m 700 "$TMP_ROOT/barrier-op"
AUD065_OPERATION_DIRECTORY="$TMP_ROOT/barrier-op"
RECOVERY_OPERATION_STATE=preflight
RECOVERY_OPERATION_LOCK_UID=lock-fixture-uid
RECOVERY_OPERATION_ID="$(printf '1%.0s' {1..32})"
RECOVERY_OPERATION_BINDING_SHA256="$(printf '2%.0s' {1..64})"
AUD065_ORIGINAL_PGSQL_POLICY_UID=policy-uid
AUD065_ORIGINAL_PGSQL_POLICY_RESOURCE_VERSION='rv-77'
aud065_pgsql_barrier_capture_normal() {
  AUD065_PGSQL_POLICY_UID=policy-uid
  AUD065_PGSQL_POLICY_RESOURCE_VERSION='rv-77'
  AUD065_PGSQL_NORMAL_METADATA_SHA256="$(printf 'd%.0s' {1..64})"
  AUD065_PGSQL_NORMAL_SPEC_SHA256="$(printf 'e%.0s' {1..64})"
  export AUD065_PGSQL_POLICY_UID AUD065_PGSQL_POLICY_RESOURCE_VERSION \
    AUD065_PGSQL_NORMAL_METADATA_SHA256 AUD065_PGSQL_NORMAL_SPEC_SHA256
}
aud065_operation_tool() { printf '%s\n' "$*" >>"$BARRIER_LOG"; }
# The real function is sourced above; a later fixture override must not make
# this invocation look like a forward reference to older ShellCheck releases.
# shellcheck disable=SC2218
aud065_bind_or_adopt_barrier
if rg -q -- '--policy-resource-version rv-77' "$BARRIER_LOG" &&
   [[ "$AUD065_PGSQL_POLICY_RESOURCE_VERSION" == rv-77 ]] &&
   ! find "$AUD065_OPERATION_DIRECTORY" -name '.barrier-capture.*' -print -quit |
     rg -q .; then
  pass 'barrier capture binds current-shell globals without a swappable scratch path'
else
  fail 'barrier capture binds current-shell globals without a swappable scratch path'
fi
BARRIER_FAILURE=""
aud065_operation_tool() {
  [[ "$1" != "$BARRIER_FAILURE" ]]
}
# Invoked indirectly by aud065_bind_or_adopt_barrier.
# shellcheck disable=SC2317,SC2329
aud065_crash_point() {
  [[ "crash:$1" != "$BARRIER_FAILURE" ]]
}
for barrier_failure in bind-barrier verify-barrier crash:after-barrier-binding; do
  BARRIER_FAILURE="$barrier_failure"
  expect_failure "barrier binding propagates $barrier_failure failure under a conditional caller" \
    aud065_bind_or_adopt_barrier
done
eval "$saved_capture_function"
eval "$saved_operation_tool_function"
eval "$saved_crash_function"

# Exercise the exact preflight order independently from the API transport.
ORDER_LOG="$TMP_ROOT/order.log"
AUD065_OPERATION_DIRECTORY="$TMP_ROOT/order-op"
mkdir -m 700 "$AUD065_OPERATION_DIRECTORY"
AUD065_QUIESCED_BASELINE="$AUD065_OPERATION_DIRECTORY/quiesced-baseline.json"
RECOVERY_OPERATION_STATE=preflight

log_order() { printf '%s\n' "$1" >>"$ORDER_LOG"; }
aud065_discover_lock() { log_order discover-lock; }
aud065_verify_preflight_live_boundary() {
  log_order "preflight-live-boundary:${1:-initial}"
}
aud065_bind_or_adopt_barrier() { log_order bind-barrier; }
aud065_probe_image() { printf 'repo/postgres@sha256:%064d\n' 0; }
aud065_pgsql_probe_bind_image() { log_order bind-probe-image; }
aud065_pgsql_probe_create() { log_order create-probe; }
aud065_require_pgsql_probe_nonready_and_unroutable() { log_order probe-nonready-unroutable; }
aud065_require_pgsql_probe_preclose_reachable() { log_order probe-preclose-reachable; }
aud065_scale_one_to_zero() { log_order "scale:$1"; }
recovery_wait_for_no_pods() { log_order "pods-absent:$1"; }
aud065_require_pgsql_consumers_and_pods_absent() { log_order consumers-and-pods-absent; }
aud065_pgsql_barrier_close() { log_order barrier-close; }
aud065_crash_point() { :; }
aud065_require_no_pgsql_client_backends() { log_order sessions-zero; }
aud065_require_pgsql_unix_socket_local() { log_order socket-unix; }
aud065_prepare_bundle() { log_order prepare-verify-bundle; }
recovery_require_operation_lock() { log_order require-lock; }
recovery_transition_aud065_operation_lock() {
  log_order "lock:$RECOVERY_OPERATION_STATE->$1"
  RECOVERY_OPERATION_STATE="$1"
}
PATH="$FIXTURE_BIN:$PATH"
aud065_quiesce_preflight
PATH="$old_path"
expected_order=$'discover-lock\npreflight-live-boundary:initial\nbind-barrier\nbind-probe-image\ncreate-probe\nprobe-nonready-unroutable\nprobe-preclose-reachable\nscale:bot-orchestrator\nscale:reticulum\nscale:coturn\nscale:dialog\nscale:pgbouncer\nscale:pgbouncer-t\npods-absent:app=bot-orchestrator\npods-absent:app=reticulum\npods-absent:app=coturn\npods-absent:app=dialog\npods-absent:app=pgbouncer\npods-absent:app=pgbouncer-t\nconsumers-and-pods-absent\nbarrier-close\nsessions-zero\nsocket-unix\nprepare-verify-bundle\nrequire-lock\nlock:preflight->quiesced'
expect_equal "$(cat "$ORDER_LOG")" "$expected_order" \
  'preflight orders bot-first CAS, barrier closure and durable quiesced transition exactly'

: >"$ORDER_LOG"
RECOVERY_OPERATION_STATE=quiesced
aud065_quiesce_preflight
expect_equal "$(cat "$ORDER_LOG")" discover-lock \
  'quiesced reentry derives state from the lock and performs no repeated mutation'

: >"$ORDER_LOG"
RECOVERY_OPERATION_STATE=preflight
printf '' >"$AUD065_OPERATION_DIRECTORY/barrier-binding.json"
chmod 600 "$AUD065_OPERATION_DIRECTORY/barrier-binding.json"
aud065_pgsql_barrier_read_state() {
  log_order barrier-state:closed
  printf 'closed\n'
}
PATH="$FIXTURE_BIN:$old_path"
aud065_quiesce_preflight
PATH="$old_path"
expected_reentry_order=$'discover-lock\npreflight-live-boundary:reentry\nbind-barrier\nbarrier-state:closed\nbind-probe-image\ncreate-probe\nprobe-nonready-unroutable\nscale:bot-orchestrator\nscale:reticulum\nscale:coturn\nscale:dialog\nscale:pgbouncer\nscale:pgbouncer-t\npods-absent:app=bot-orchestrator\npods-absent:app=reticulum\npods-absent:app=coturn\npods-absent:app=dialog\npods-absent:app=pgbouncer\npods-absent:app=pgbouncer-t\nconsumers-and-pods-absent\nbarrier-close\nsessions-zero\nsocket-unix\nprepare-verify-bundle\nrequire-lock\nlock:preflight->quiesced'
expect_equal "$(cat "$ORDER_LOG")" "$expected_reentry_order" \
  'authenticated preflight reentry accepts closed partial cuts without rechecking original RVs'

: >"$ORDER_LOG"
RECOVERY_OPERATION_STATE=preflight
aud065_verify_preflight_live_boundary() {
  log_order preflight-live-drift
  return 1
}
if aud065_quiesce_preflight; then
  fail 'preflight live drift fails before mutation'
elif [[ "$(cat "$ORDER_LOG")" == $'discover-lock\npreflight-live-drift' ]]; then
  pass 'preflight live drift fails before barrier, probe or scale mutation'
else
  fail 'preflight live drift fails before barrier, probe or scale mutation'
fi

# Final artifacts are published only after a complete fsynced scratch write.
# Reentry reconciles the sole supported cut (final plus its pending hardlink)
# and replaces an abandoned pre-link partial temp without trusting existence.
PUBLISH_OP="$TMP_ROOT/publish-op"
mkdir -m 700 "$PUBLISH_OP"
PUBLISH_OP="$(cd "$PUBLISH_OP" && pwd -P)"
AUD065_OPERATION_DIRECTORY="$PUBLISH_OP"
printf 'complete-evidence\n' >"$PUBLISH_OP/source.json"
chmod 600 "$PUBLISH_OP/source.json"
aud065_publish_private_file "$PUBLISH_OP/source.json" "$PUBLISH_OP/evidence.json"
if cmp -s "$PUBLISH_OP/source.json" "$PUBLISH_OP/evidence.json"; then
  pass 'private evidence publication exposes only the complete scratch bytes'
else
  fail 'private evidence publication exposes only the complete scratch bytes'
fi
linked_pending="$PUBLISH_OP/.evidence.json.pending-$(printf 'a%.0s' {1..32})"
ln "$PUBLISH_OP/evidence.json" "$linked_pending"
aud065_reconcile_private_file "$PUBLISH_OP/evidence.json"
if [[ ! -e "$linked_pending" ]] &&
   [[ "$(stat -f '%l' "$PUBLISH_OP/evidence.json" 2>/dev/null ||
     stat -c '%h' "$PUBLISH_OP/evidence.json")" == 1 ]]; then
  pass 'private evidence reentry reconciles the durable two-link publication cut'
else
  fail 'private evidence reentry reconciles the durable two-link publication cut'
fi
orphan_pending="$PUBLISH_OP/.second.json.pending-$(printf 'b%.0s' {1..32})"
printf 'abandoned-partial' >"$orphan_pending"
chmod 600 "$orphan_pending"
aud065_publish_private_file "$PUBLISH_OP/source.json" "$PUBLISH_OP/second.json"
if cmp -s "$PUBLISH_OP/source.json" "$PUBLISH_OP/second.json" &&
   [[ -f "$orphan_pending" ]]; then
  pass 'private evidence publication preserves an unowned pre-link orphan'
else
  fail 'private evidence publication preserves an unowned pre-link orphan'
fi
printf 'partial-final' >"$PUBLISH_OP/foreign.json"
chmod 600 "$PUBLISH_OP/foreign.json"
expect_failure 'private evidence publication never treats final-path existence as completion' \
  aud065_publish_private_file "$PUBLISH_OP/source.json" "$PUBLISH_OP/foreign.json"

CAPTURE_SCRATCH="$PUBLISH_OP/.scratch.external"
mkdir -m 700 "$CAPTURE_SCRATCH"
aud065_open_private_capture_fd "$CAPTURE_SCRATCH"
partial_capture="$AUD065_CAPTURE_FILE"
producer_status=0
if { printf 'partial-sensitive-output' >&9; false; }; then
  producer_status=0
else
  producer_status=$?
  aud065_process_private_capture_fd wipe >/dev/null
fi
aud065_close_private_capture_fd
if [[ "$producer_status" -ne 0 && ! -e "$PUBLISH_OP/external-final.json" &&
      ! -s "$partial_capture" ]]; then
  pass 'partial failed external producer is wiped before any final publication'
else
  fail 'partial failed external producer is wiped before any final publication'
fi
aud065_open_private_capture_fd "$CAPTURE_SCRATCH"
printf 'complete-external-output\n' >&9
aud065_process_private_capture_fd publish "$PUBLISH_OP/external-final.json"
aud065_close_private_capture_fd
if [[ "$(cat "$PUBLISH_OP/external-final.json")" == complete-external-output ]]; then
  pass 'successful external producer publishes only its complete pinned bytes'
else
  fail 'successful external producer publishes only its complete pinned bytes'
fi

expect_equal "$(rg -o -F -- '--operation-directory "$AUD065_OPERATION_DIRECTORY"' \
  <<<"$driver_prepare_body" | wc -l | tr -d ' ')" 2 \
  'reentrant prepare and verification authenticate the operation directory'
materialize_body="$(declare -f aud065_materialize_replacements)"
apply_body="$(declare -f aud065_apply_bundle_exact)
$(declare -f aud065_classify_bundle_iteration_in_scratch)"
if [[ "$(rg -o -F -- '--operation-directory "$AUD065_OPERATION_DIRECTORY"' \
       <<<"$materialize_body" | wc -l | tr -d ' ')" == 2 ]] &&
   [[ "$(rg -n 'materialize|after-materialize-replacements|verify' \
       <<<"$materialize_body" | cut -d: -f2-)" == *materialize*after-materialize-replacements*verify* ]] &&
   [[ "$(rg -o -F -- '--operation-directory "$AUD065_OPERATION_DIRECTORY"' \
       <<<"$apply_body" | wc -l | tr -d ' ')" == 3 ]] &&
   rg -q 'emit-verified' <<<"$apply_body" &&
   ! rg -q -F '< "$AUD065_REPLACEMENTS_DIRECTORY' <<<"$apply_body"; then
  pass 'all replacement operations authenticate inputs and CAS only verified emitted bytes'
else
  fail 'all replacement operations authenticate inputs and CAS only verified emitted bytes'
fi

MATERIALIZE_BIN="$TMP_ROOT/materialize-bin"
mkdir -m 700 "$MATERIALIZE_BIN"
cat >"$MATERIALIZE_BIN/node" <<'MATERIALIZE_NODE'
#!/usr/bin/env bash
set -euo pipefail
tool="${1##*/}"
shift
[[ "$tool" == materialize-process-local-replacements.mjs ]] || exit 90
action="${1:-}"
shift || :
output=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --output-directory) output="$2" ;;
  esac
  shift 2
done
[[ -n "$output" ]] || exit 91
printf '%s\n' "$action" >>"$MATERIALIZE_LOG"
names=(
  00-secret-configs.json
  01-deployment-bot-orchestrator.json
  02-deployment-coturn.json
  03-deployment-dialog.json
  04-deployment-pgbouncer.json
  05-deployment-pgbouncer-t.json
  06-deployment-reticulum.json
)
case "$action" in
  materialize)
    if [[ -e "$output/foreign.json" || -L "$output/foreign.json" ]]; then exit 71; fi
    mkdir -p "$output"
    chmod 700 "$output"
    for name in "${names[@]}"; do
      if [[ ! -e "$output/$name" ]]; then
        printf '{"fixture":"%s"}\n' "$name" >"$output/$name"
        chmod 600 "$output/$name"
      fi
    done
    ;;
  verify)
    [[ ! -e "$output/foreign.json" && ! -L "$output/foreign.json" ]] || exit 72
    for name in "${names[@]}"; do [[ -f "$output/$name" ]]; done
    [[ "$(find "$output" -mindepth 1 -maxdepth 1 -type f | wc -l | tr -d ' ')" == 7 ]]
    ;;
  *) exit 92 ;;
esac
MATERIALIZE_NODE
chmod 700 "$MATERIALIZE_BIN/node"

run_materialize_reentry_fixture() {
  local mode="$1" fixture="$TMP_ROOT/materialize-$1"
  mkdir -m 700 "$fixture"
  MATERIALIZE_LOG="$fixture/order.log" PATH="$MATERIALIZE_BIN:$PATH" bash -c '
    set -Eeuo pipefail
    source "$1"
    MODE="$2"
    AUD065_OPERATION_DIRECTORY="$3/operation"
    AUD065_REPLACEMENTS_DIRECTORY="$AUD065_OPERATION_DIRECTORY/replacements"
    AUD065_QUIESCED_BASELINE="$AUD065_OPERATION_DIRECTORY/quiesced-baseline.json"
    AUD065_BUNDLE="$AUD065_OPERATION_DIRECTORY/bundle.json"
    AUD065_BUNDLE_BINDING="$AUD065_OPERATION_DIRECTORY/binding.json"
    RECOVERY_OPERATION_ID="$(printf "1%.0s" {1..32})"
    RECOVERY_OPERATION_BINDING_SHA256="$(printf "2%.0s" {1..64})"
    mkdir -m 700 "$AUD065_OPERATION_DIRECTORY"
    CRASH_ONCE=0
    aud065_crash_point() {
      printf "crash:%s\n" "$1" >>"$MATERIALIZE_LOG"
      if [[ "$CRASH_ONCE" == 1 ]]; then CRASH_ONCE=0; return 73; fi
    }
    case "$MODE" in
      partial)
        mkdir -m 700 "$AUD065_REPLACEMENTS_DIRECTORY"
        printf partial >"$AUD065_REPLACEMENTS_DIRECTORY/00-secret-configs.json"
        chmod 600 "$AUD065_REPLACEMENTS_DIRECTORY/00-secret-configs.json"
        aud065_materialize_replacements
        [[ "$(cat "$MATERIALIZE_LOG")" == $'"'"'materialize\ncrash:after-materialize-replacements\nverify'"'"' ]]
        ;;
      crash-reentry)
        CRASH_ONCE=1
        if aud065_materialize_replacements; then exit 74; fi
        [[ "$(cat "$MATERIALIZE_LOG")" == $'"'"'materialize\ncrash:after-materialize-replacements'"'"' ]]
        aud065_materialize_replacements
        [[ "$(cat "$MATERIALIZE_LOG")" == $'"'"'materialize\ncrash:after-materialize-replacements\nmaterialize\ncrash:after-materialize-replacements\nverify'"'"' ]]
        ;;
      foreign)
        mkdir -m 700 "$AUD065_REPLACEMENTS_DIRECTORY"
        printf foreign >"$AUD065_REPLACEMENTS_DIRECTORY/foreign.json"
        chmod 600 "$AUD065_REPLACEMENTS_DIRECTORY/foreign.json"
        if aud065_materialize_replacements; then exit 75; fi
        [[ -f "$AUD065_REPLACEMENTS_DIRECTORY/foreign.json" &&
           "$(cat "$MATERIALIZE_LOG")" == materialize ]]
        ;;
      *) exit 76 ;;
    esac
    [[ "$(find "$AUD065_REPLACEMENTS_DIRECTORY" -mindepth 1 -maxdepth 1 \
      -type f ! -name foreign.json | wc -l | tr -d " ")" == 7 || "$MODE" == foreign ]]
  ' bash "$DRIVER" "$mode" "$fixture"
}

if run_materialize_reentry_fixture partial; then
  pass 'partial replacements directory is reconciled before verification on reentry'
else
  fail 'partial replacements directory is reconciled before verification on reentry'
fi
if run_materialize_reentry_fixture crash-reentry; then
  pass 'post-materialize crashpoint resumes through idempotent materialize then verify'
else
  fail 'post-materialize crashpoint resumes through idempotent materialize then verify'
fi
if run_materialize_reentry_fixture foreign; then
  pass 'foreign replacement evidence remains fail-closed and is not verified or removed'
else
  fail 'foreign replacement evidence remains fail-closed and is not verified or removed'
fi

aud065_pgsql_probe_name() { printf 'aud065-probe-fixture\n'; }
aud065_runtime_identifiers() { printf 'ret0\tret_dev\n'; }
aud065_emit_runtime_password() { printf 'fixture-password-never-logged\n'; }
recovery_require_operation_serialization() { :; }
recovery_require_operation_lock() { :; }
# Invoked indirectly by the sourced probe function.
# shellcheck disable=SC2317,SC2329
recovery_kubectl_stream_guarded() { IFS= read -r _discard || :; return 1; }
expect_failure 'old-password rejection never accepts a kubectl or network failure' \
  aud065_probe_fresh_auth old pgbouncer reject
recovery_kubectl_stream_guarded() {
  IFS= read -r _discard || return 1
  printf 'auth-rejected\n'
}
if aud065_probe_fresh_auth old pgbouncer reject; then
  pass 'old-password rejection requires the exact safe remote verdict'
else
  fail 'old-password rejection requires the exact safe remote verdict'
fi

AUTH_BIN="$TMP_ROOT/auth-bin"
mkdir -m 700 "$AUTH_BIN"
cat >"$AUTH_BIN/pg_isready" <<'AUTH_READY'
#!/usr/bin/env bash
exit 0
AUTH_READY
cat >"$AUTH_BIN/psql" <<'AUTH_PSQL'
#!/usr/bin/env bash
case "${AUTH_PSQL_MODE:-}" in
  auth-reject)
    printf 'psql: error: FATAL: password authentication failed for user "ret0"\n' >&2
    exit 2
    ;;
  non-auth)
    printf 'psql: error: connection reset by peer\n' >&2
    exit 2
    ;;
  *) exit 0 ;;
esac
AUTH_PSQL
cat >"$AUTH_BIN/mktemp" <<'AUTH_MKTEMP'
#!/usr/bin/env bash
exit 88
AUTH_MKTEMP
chmod 700 "$AUTH_BIN/pg_isready" "$AUTH_BIN/psql" "$AUTH_BIN/mktemp"
recovery_kubectl_stream_guarded() {
  while [[ "$#" -gt 0 ]]; do
    if [[ "$1" == -- ]]; then
      shift
      "$@"
      return
    fi
    shift
  done
  return 2
}
PATH="$AUTH_BIN:$old_path"
export AUTH_PSQL_MODE=non-auth
expect_failure 'old-password rejection does not accept a non-auth psql failure' \
  aud065_probe_fresh_auth old pgbouncer reject
export AUTH_PSQL_MODE=auth-reject
if aud065_probe_fresh_auth old pgbouncer reject; then
  pass 'old-password rejection works on the read-only probe without scratch files'
else
  fail 'old-password rejection works on the read-only probe without scratch files'
fi
PATH="$old_path"
unset AUTH_PSQL_MODE

# Exercise the actual ERR trap path. A failure after lock creation but before
# barrier binding must not stop a single Deployment while PostgreSQL is open.
FAILCLOSE_NO_BIND_OP="$TMP_ROOT/failclose-no-binding"
FAILCLOSE_NO_BIND_LOG="$TMP_ROOT/failclose-no-binding.log"
mkdir -m 700 "$FAILCLOSE_NO_BIND_OP"
failclose_status=0
if bash -c '
  set -Eeuo pipefail
  export AUD065_DRIVER_SOURCE_ONLY=1
  source "$1"
  AUD065_OPERATION_DIRECTORY="$2"
  AUD065_LEASE_ACQUIRED=1
  AUD065_SIMULATED_CRASH=0
  LOG_PATH="$3"
  log() { printf "%s\n" "$1" >>"$LOG_PATH"; }
  recovery_require_operation_serialization() { :; }
  aud065_lock_json() { printf "{}\n"; }
  aud065_discover_lock() { :; }
  aud065_fail_close_one() { log "scale:$1"; }
  aud065_pgsql_barrier_close() { log barrier-close; }
  aud065_release_lease_if_owned() { log release-lease; AUD065_LEASE_ACQUIRED=0; }
  trap aud065_on_error ERR
  false
' bash "$DRIVER" "$FAILCLOSE_NO_BIND_OP" "$FAILCLOSE_NO_BIND_LOG" \
  >/dev/null 2>&1; then
  failclose_status=0
else
  failclose_status=$?
fi
if [[ "$failclose_status" == 1 &&
      "$(cat "$FAILCLOSE_NO_BIND_LOG")" == release-lease ]]; then
  pass 'ERR trap leaves all Deployments untouched before barrier binding exists'
else
  fail 'ERR trap leaves all Deployments untouched before barrier binding exists'
fi

FAILCLOSE_PROBE_FAIL_OP="$TMP_ROOT/failclose-probe-fail"
FAILCLOSE_PROBE_FAIL_LOG="$TMP_ROOT/failclose-probe-fail.log"
mkdir -m 700 "$FAILCLOSE_PROBE_FAIL_OP"
printf '' >"$FAILCLOSE_PROBE_FAIL_OP/barrier-binding.json"
chmod 600 "$FAILCLOSE_PROBE_FAIL_OP/barrier-binding.json"
failclose_status=0
if bash -c '
  set -Eeuo pipefail
  export AUD065_DRIVER_SOURCE_ONLY=1
  source "$1"
  AUD065_OPERATION_DIRECTORY="$2"
  AUD065_LEASE_ACQUIRED=1
  LOG_PATH="$3"
  log() { printf "%s\n" "$1" >>"$LOG_PATH"; }
  recovery_require_operation_serialization() { :; }
  aud065_lock_json() { printf "{}\n"; }
  aud065_discover_lock() { :; }
  aud065_load_barrier_binding() { :; }
  aud065_pgsql_barrier_read_state() { printf "normal\n"; }
  aud065_probe_image() { printf "postgres@sha256:%064d\n" 0; }
  aud065_pgsql_probe_bind_image() { :; }
  aud065_pgsql_probe_create() { log probe-create-failed; return 1; }
  aud065_pgsql_barrier_close() { log barrier-mutated; }
  aud065_fail_close_one() { log "deployment-mutated:$1"; }
  aud065_release_lease_if_owned() { log release-lease; AUD065_LEASE_ACQUIRED=0; }
  trap aud065_on_error ERR
  false
' bash "$DRIVER" "$FAILCLOSE_PROBE_FAIL_OP" "$FAILCLOSE_PROBE_FAIL_LOG" \
  >/dev/null 2>&1; then
  failclose_status=0
else
  failclose_status=$?
fi
if [[ "$failclose_status" == 1 ]] &&
   [[ "$(cat "$FAILCLOSE_PROBE_FAIL_LOG")" == $'probe-create-failed\nrelease-lease' ]]; then
  pass 'ERR trap performs zero policy or Deployment mutations when probe recovery fails'
else
  fail 'ERR trap performs zero policy or Deployment mutations when probe recovery fails'
fi

# With a valid binding, closed admission is observed before six scale CAS
# attempts and quiescence checks. The operation lock remains durable.
FAILCLOSE_BOUND_OP="$TMP_ROOT/failclose-bound"
FAILCLOSE_BOUND_LOG="$TMP_ROOT/failclose-bound.log"
mkdir -m 700 "$FAILCLOSE_BOUND_OP"
printf '' >"$FAILCLOSE_BOUND_OP/barrier-binding.json"
chmod 600 "$FAILCLOSE_BOUND_OP/barrier-binding.json"
failclose_status=0
if bash -c '
  set -Eeuo pipefail
  export AUD065_DRIVER_SOURCE_ONLY=1
  source "$1"
  AUD065_OPERATION_DIRECTORY="$2"
  AUD065_LEASE_ACQUIRED=1
  AUD065_SIMULATED_CRASH=0
  RECOVERY_OPERATION_STATE=verified
  LOG_PATH="$3"
  log() { printf "%s\n" "$1" >>"$LOG_PATH"; }
  recovery_require_operation_serialization() { :; }
  aud065_lock_json() { printf "{}\n"; }
  aud065_discover_lock() { :; }
  aud065_load_barrier_binding() { :; }
  aud065_pgsql_barrier_read_state() { printf "normal\n"; }
  aud065_pgsql_barrier_adopt_compensating_normal() { log adopt-compensating-normal; }
  aud065_probe_image() { printf "postgres@sha256:%064d\n" 0; }
  aud065_pgsql_probe_bind_image() { :; }
  aud065_pgsql_probe_create() { log probe-create; }
  aud065_require_pgsql_probe_nonready_and_unroutable() { log probe-nonready-unroutable; }
  aud065_require_pgsql_probe_preclose_reachable() { log probe-preclose-reachable; }
  aud065_probe_blocked_three() { log cni-blocked-three; }
  aud065_pgsql_barrier_close() { log barrier-close; "$1"; }
  aud065_fail_close_one() { log "scale:$1"; }
  recovery_wait_for_no_pods() { log "pods-absent:$1"; }
  aud065_require_pgsql_consumers_and_pods_absent() { log consumers-and-pods-absent; }
  aud065_require_no_pgsql_client_backends() { log sessions-zero; }
  aud065_require_pgsql_unix_socket_local() { log socket-unix; }
  recovery_release_operation_lock() { log release-operation-lock; }
  aud065_release_lease_if_owned() { log release-lease; AUD065_LEASE_ACQUIRED=0; }
  trap aud065_on_error ERR
  false
' bash "$DRIVER" "$FAILCLOSE_BOUND_OP" "$FAILCLOSE_BOUND_LOG" \
  >/dev/null 2>&1; then
  failclose_status=0
else
  failclose_status=$?
fi
expected_failclose_order=$'adopt-compensating-normal\nprobe-create\nprobe-nonready-unroutable\nprobe-preclose-reachable\nbarrier-close\ncni-blocked-three\nscale:bot-orchestrator\nscale:reticulum\nscale:coturn\nscale:dialog\nscale:pgbouncer\nscale:pgbouncer-t\npods-absent:app=bot-orchestrator\npods-absent:app=reticulum\npods-absent:app=coturn\npods-absent:app=dialog\npods-absent:app=pgbouncer\npods-absent:app=pgbouncer-t\nconsumers-and-pods-absent\nsessions-zero\nsocket-unix\nrelease-lease'
if [[ "$failclose_status" == 1 ]] &&
   [[ "$(cat "$FAILCLOSE_BOUND_LOG")" == "$expected_failclose_order" ]]; then
  pass 'verified ERR trap adopts clean normal only to close and prove full quiescence'
else
  fail 'verified ERR trap adopts clean normal only to close and prove full quiescence'
fi

# Resume with an absent lock may verify a terminal HMAC record, but must never
# call the lock creator.
RESUME_LOG="$TMP_ROOT/resume.log"
PRELOCK_LOG="$TMP_ROOT/prelock-boundary.log"
prelock_log() { printf '%s\n' "$1" >>"$PRELOCK_LOG"; }
aud065_set_paths() {
  prelock_log set-paths
}
aud065_verify_operation_checkpoint() { prelock_log verify-operation; }
aud065_verify_source_state() { prelock_log "verify-source:$1"; }
aud065_acquire_lease() { prelock_log acquire-lease; AUD065_LEASE_ACQUIRED=1; }
recovery_require_live_process_local_runner_exact() {
  prelock_log 'reject-residual:Secret/hcce/bot-images-pull'
  return 1
}
aud065_create_or_adopt_lock() { prelock_log FORBIDDEN-lock-create; }
aud065_release_lease_if_owned() {
  prelock_log release-lease
  AUD065_LEASE_ACQUIRED=0
}
aud065_require_checkpoint_freshness() {
  prelock_log checkpoint-freshness
  return 1
}
if aud065_execute_or_resume execute >/dev/null 2>&1; then
  fail 'initial execute rejects stale checkpoint before Lease, lock or mutation paths'
elif [[ "$(cat "$PRELOCK_LOG")" == $'set-paths\nverify-operation\ncheckpoint-freshness' ]]; then
  pass 'initial execute rejects stale checkpoint before Lease, lock or mutation paths'
else
  fail 'initial execute rejects stale checkpoint before Lease, lock or mutation paths'
fi
: >"$PRELOCK_LOG"
aud065_require_checkpoint_freshness() { prelock_log checkpoint-freshness; }
if aud065_execute_or_resume execute >/dev/null 2>&1; then
  fail 'post-Lease process-local boundary blocks a partial AUD-075 resource before lock or callbacks'
elif [[ "$(cat "$PRELOCK_LOG")" == $'set-paths\nverify-operation\ncheckpoint-freshness\nverify-source:old\nacquire-lease\nreject-residual:Secret/hcce/bot-images-pull\nrelease-lease' ]]; then
  pass 'post-Lease process-local boundary blocks a partial AUD-075 resource before lock or callbacks'
else
  fail 'post-Lease process-local boundary blocks a partial AUD-075 resource before lock or callbacks'
fi

run_execute_sequence_guard_fixture() {
  local mode="$1" failure_stage="$2" fast_path="${3:-0}"
  bash -c '
    set -Eeuo pipefail
    source "$1"
    MODE="$2"
    FAILURE_STAGE="$3"
    FAST_PATH="$4"
    AUD065_LEASE_ACQUIRED=0
    aud065_set_paths() { :; }
    aud065_verify_operation_checkpoint() { :; }
    aud065_require_checkpoint_freshness() { :; }
    aud065_verify_source_state() { :; }
    aud065_acquire_lease() { AUD065_LEASE_ACQUIRED=1; }
    recovery_require_live_process_local_runner_exact() { :; }
    aud065_create_or_adopt_lock() {
      [[ "$FAST_PATH" == 1 ]] && return 3
      return 0
    }
    aud065_run_rotation_callbacks() { [[ "$FAILURE_STAGE" != rotation-callbacks ]]; }
    aud065_run_rollback_callbacks() { [[ "$FAILURE_STAGE" != rollback-callbacks ]]; }
    aud065_verify_missing_lock_terminal() {
      if [[ "$FAST_PATH" == 1 ]]; then
        [[ "$FAILURE_STAGE" != fast-terminal ]]
      else
        [[ "$FAILURE_STAGE" != terminal ]]
      fi
    }
    aud065_release_lease_if_owned() {
      if [[ "$FAST_PATH" == 1 ]]; then
        [[ "$FAILURE_STAGE" != fast-release ]]
      else
        [[ "$FAILURE_STAGE" != release ]]
      fi
    }
    if aud065_execute_or_resume "$MODE" >/dev/null; then exit 0; else exit 1; fi
  ' bash "$DRIVER" "$mode" "$failure_stage" "$fast_path"
}

for execute_failure in rotation-callbacks terminal release; do
  expect_failure "execute propagates $execute_failure failure under a conditional caller" \
    run_execute_sequence_guard_fixture execute "$execute_failure"
done
expect_failure 'rollback propagates rollback-callbacks failure under a conditional caller' \
  run_execute_sequence_guard_fixture rollback rollback-callbacks
for resume_fast_failure in fast-terminal fast-release; do
  expect_failure "terminal resume fast path propagates $resume_fast_failure failure" \
    run_execute_sequence_guard_fixture resume "$resume_fast_failure" 1
done

aud065_set_paths() { :; }
aud065_verify_operation_checkpoint() { printf 'verify-operation\n' >>"$RESUME_LOG"; }
aud065_verify_source_state() { printf 'verify-source:%s\n' "$1" >>"$RESUME_LOG"; }
aud065_acquire_lease() { printf 'acquire-lease\n' >>"$RESUME_LOG"; AUD065_LEASE_ACQUIRED=1; }
recovery_require_live_process_local_runner_exact() { printf 'process-local-exact\n' >>"$RESUME_LOG"; }
aud065_create_or_adopt_lock() { printf 'lock-absent\n' >>"$RESUME_LOG"; return 3; }
aud065_verify_missing_lock_terminal() { printf 'verify-terminal\n' >>"$RESUME_LOG"; }
aud065_release_lease_if_owned() { printf 'release-lease\n' >>"$RESUME_LOG"; AUD065_LEASE_ACQUIRED=0; }
resume_output="$(aud065_execute_or_resume resume)"
expect_equal "$resume_output" aud065_rotation_complete \
  'resume accepts an absent lock only through terminal verification'
expect_equal "$(cat "$RESUME_LOG")" $'verify-operation\nverify-source:either\nacquire-lease\nprocess-local-exact\nlock-absent\nverify-terminal\nrelease-lease' \
  'absent-lock resume does not recreate or mutate the global lock'

if bash -c '
  set -Eeuo pipefail
  source "$1"
  AUD065_PGSQL_INITIAL_RESOURCE_VERSION=rv-initial
  AUD065_CHECKPOINT_DIRECTORY=/private/checkpoint
  NAMESPACE=hcce
  aud065_verify_source_state() { :; }
  aud065_verify_terminal_record() { :; }
  aud065_capture_and_verify_released_state() { :; }
  recovery_kubectl() { printf "{\"metadata\":{\"resourceVersion\":\"rv-released\"}}\n"; }
  aud065_pgsql_policy_json_is_exact() { :; }
  aud065_pgsql_probe_inventory() { printf "[]\n"; }
  aud065_require_started_read_only() { [[ "$1" != dialog ]]; }
  recovery_require_live_images_match_checkpoint() { :; }
  if aud065_verify_missing_lock_terminal; then exit 0; else exit 1; fi
' bash "$DRIVER" >/dev/null 2>&1; then
  fail 'missing-lock terminal verification propagates a failed consumer before later successes'
else
  pass 'missing-lock terminal verification propagates a failed consumer before later successes'
fi

DRIFT_LOG="$TMP_ROOT/drift.log"
drift_log() { printf '%s\n' "$1" >>"$DRIFT_LOG"; }
aud065_reload_guard() {
  RECOVERY_OPERATION_STATE=verified
  RECOVERY_OPERATION_LOCK_UID=lock-drift-uid
}
aud065_probe_image() { printf 'repo/postgres@sha256:%064d\n' 0; }
aud065_pgsql_probe_bind_image() { drift_log bind-probe-image; }
aud065_pgsql_barrier_read_state() { printf 'open-verified\n'; }
aud065_verify_fresh_cleanup_gate() { drift_log fresh-gate-drift; return 1; }
aud065_pgsql_barrier_cleanup() {
  "$2" >/dev/null || return 1
  drift_log cleanup-cas
}
if aud065_cb_complete >/dev/null 2>&1; then
  fail 'fresh verified-state drift blocks cleanup'
elif ! rg -q '^cleanup-cas$' "$DRIFT_LOG"; then
  pass 'fresh verified-state drift blocks cleanup before policy or probe mutation'
else
  fail 'fresh verified-state drift blocks cleanup before policy or probe mutation'
fi

EXTERNAL_NORMAL_LOG="$TMP_ROOT/external-normal.log"
external_normal_log() { printf '%s\n' "$1" >>"$EXTERNAL_NORMAL_LOG"; }
aud065_reload_guard() {
  RECOVERY_OPERATION_STATE=verified
  RECOVERY_OPERATION_LOCK_UID=lock-external-normal-uid
  external_normal_log reload
}
aud065_pgsql_barrier_read_state() { printf 'normal\n'; }
aud065_verify_fresh_cleanup_gate() { external_normal_log fresh-gate; }
recovery_transition_aud065_operation_lock() { external_normal_log "transition:$1"; }
aud065_pgsql_barrier_cleanup() { external_normal_log cleanup-cas; }
aud065_write_or_verify_terminal() { external_normal_log terminal; }
recovery_release_operation_lock() { external_normal_log release-lock; }
if aud065_cb_complete >/dev/null 2>&1; then
  fail 'verified state rejects an externally restored normal policy'
elif [[ "$(cat "$EXTERNAL_NORMAL_LOG")" == reload ]]; then
  pass 'verified plus external normal policy causes zero transition, terminal or lock deletion'
else
  fail 'verified plus external normal policy causes zero transition, terminal or lock deletion'
fi

NORMAL_DRIFT_LOG="$TMP_ROOT/normal-drift.log"
normal_drift_log() { printf '%s\n' "$1" >>"$NORMAL_DRIFT_LOG"; }
aud065_reload_guard() {
  RECOVERY_OPERATION_STATE=cleanup-authorized
  RECOVERY_OPERATION_LOCK_UID=lock-normal-drift-uid
}
aud065_pgsql_barrier_read_state() { printf 'normal\n'; }
AUD065_PGSQL_INITIAL_RESOURCE_VERSION='rv-initial'
aud065_probe_image() { printf 'repo/postgres@sha256:%064d\n' 0; }
aud065_pgsql_probe_bind_image() { normal_drift_log bind-probe-image; }
recovery_kubectl() { printf '{"metadata":{"resourceVersion":"rv-after-cleanup"}}\n'; }
aud065_verify_local_tcp_cleanup_gate() {
  normal_drift_log local-auth-failed
  return 1
}
aud065_verify_or_create_report() { normal_drift_log report-verified; }
aud065_pgsql_barrier_cleanup() {
  "$2" >/dev/null || return 1
  normal_drift_log cleanup-cas
}
aud065_write_or_verify_terminal() { normal_drift_log terminal; }
recovery_release_operation_lock() { normal_drift_log release-lock; }
if aud065_cb_complete >/dev/null 2>&1; then
  fail 'normal-policy reentry rejects changed DB authentication'
elif [[ "$(cat "$NORMAL_DRIFT_LOG")" == $'bind-probe-image\nlocal-auth-failed' ]]; then
  pass 'normal-policy reentry blocks terminal and lock deletion when DB authentication drifts'
else
  fail 'normal-policy reentry blocks terminal and lock deletion when DB authentication drifts'
fi

# Cleanup has one exact order: restore the policy, remove the terminal probe,
# capture and verify the released baseline, bind terminal evidence, then drop
# the operation lock. The Lease remains the outer coordinator's responsibility.
COMPLETE_LOG="$TMP_ROOT/complete.log"
saved_write_terminal_function="$driver_write_terminal_body"
complete_log() { printf '%s\n' "$1" >>"$COMPLETE_LOG"; }
COMPLETE_STATE=verified
aud065_reload_guard() {
  RECOVERY_OPERATION_STATE="$COMPLETE_STATE"
  RECOVERY_OPERATION_LOCK_UID=lock-complete-uid
  complete_log reload
}
aud065_pgsql_barrier_read_state() { printf 'open-verified\n'; }
aud065_verify_fresh_cleanup_gate() { complete_log fresh-open-gate; }
recovery_transition_aud065_operation_lock() {
  complete_log "lock:$RECOVERY_OPERATION_STATE->$1"
  COMPLETE_STATE="$1"
  RECOVERY_OPERATION_STATE="$1"
}
aud065_probe_image() { printf 'repo/postgres@sha256:%064d\n' 0; }
aud065_pgsql_probe_bind_image() { complete_log bind-probe-image; }
aud065_pgsql_barrier_cleanup() { complete_log "barrier-cleanup:$1:$2"; }
aud065_verify_local_tcp_cleanup_gate() { complete_log local-tcp-gate; }
aud065_pgsql_probe_cleanup() { complete_log "probe-cleanup:$1"; }
aud065_capture_and_verify_released_state() { complete_log release-verified; }
aud065_promote_source() { complete_log source-promoted; }
aud065_write_or_verify_terminal() { complete_log "terminal:$1"; }
recovery_release_operation_lock() { complete_log release-lock; }
aud065_crash_point() { :; }
aud065_cb_complete
expect_equal "$(cat "$COMPLETE_LOG")" \
  $'reload\nfresh-open-gate\nlock:verified->cleanup-authorized\nreload\nbind-probe-image\nbarrier-cleanup:aud065_probe_exec_status:aud065_report_verification_callback\nlocal-tcp-gate\nprobe-cleanup:aud065_probe_terminalize_callback\nrelease-verified\nsource-promoted\nterminal:lock-complete-uid\nrelease-lock' \
  'cleanup authorization is durable before policy CAS and release evidence precedes lock deletion'
eval "$saved_write_terminal_function"

TERMINAL_LOG="$TMP_ROOT/terminal.log"
AUD065_OPERATION_DIRECTORY="$TMP_ROOT/terminal-op"
mkdir -m 700 "$AUD065_OPERATION_DIRECTORY"
AUD065_FINAL_BASELINE="$AUD065_OPERATION_DIRECTORY/final-open.json"
AUD065_RELEASED_BASELINE="$AUD065_OPERATION_DIRECTORY/released.json"
AUD065_REPORT="$AUD065_OPERATION_DIRECTORY/report.json"
aud065_sha256() { return 99; }
# Invoked indirectly by aud065_write_or_verify_terminal.
# shellcheck disable=SC2317,SC2329
aud065_operation_tool() { printf '%s\n' "$*" >>"$TERMINAL_LOG"; }
aud065_write_or_verify_terminal lock-terminal-uid
if [[ "$(sed -n '1p' "$TERMINAL_LOG")" == write-terminal-from-artifacts* ]] &&
   [[ "$(sed -n '2p' "$TERMINAL_LOG")" == verify-terminal-from-artifacts* ]] &&
   [[ "$(rg -c -- '--verified-baseline ' "$TERMINAL_LOG")" == 2 ]] &&
   [[ "$(rg -c -- '--released-baseline ' "$TERMINAL_LOG")" == 2 ]] &&
   [[ "$(rg -c -- '--expected-operation-id ' "$TERMINAL_LOG")" == 2 ]] &&
   [[ "$(rg -c -- '--expected-operation-binding-sha256 ' "$TERMINAL_LOG")" == 2 ]] &&
   ! rg -q -- '--(verified-baseline|released-baseline|report)-sha256' "$TERMINAL_LOG"; then
  pass 'terminal helper pins and binds final-open and released-normal artifacts directly'
else
  fail 'terminal helper pins and binds final-open and released-normal artifacts directly'
fi

TERMINAL_FAILURE=""
aud065_operation_tool() {
  printf '%s\n' "$1" >>"$TERMINAL_LOG"
  [[ "$1" != "$TERMINAL_FAILURE" ]]
}
for terminal_failure in write-terminal-from-artifacts verify-terminal-from-artifacts; do
  : >"$TERMINAL_LOG"
  TERMINAL_FAILURE="$terminal_failure"
  expect_failure "terminal publication propagates $terminal_failure failure under a conditional caller" \
    aud065_write_or_verify_terminal lock-terminal-uid
done

run_terminal_record_guard_fixture() {
  local failure_stage="$1" fixture_root
  fixture_root="$TMP_ROOT/terminal-record-$failure_stage"
  mkdir -m 700 "$fixture_root"
  for artifact in final.json released.json report.json; do
    printf '{}\n' >"$fixture_root/$artifact"
    chmod 600 "$fixture_root/$artifact"
  done
  bash -c '
    set -Eeuo pipefail
    source "$1"
    FAILURE_STAGE="$2"
    AUD065_OPERATION_DIRECTORY="$3"
    AUD065_FINAL_BASELINE="$3/final.json"
    AUD065_RELEASED_BASELINE="$3/released.json"
    AUD065_REPORT="$3/report.json"
    aud065_reconcile_private_file() {
      case "${1##*/}" in
        final.json) [[ "$FAILURE_STAGE" != final-reconcile ]] ;;
        released.json) [[ "$FAILURE_STAGE" != released-reconcile ]] ;;
      esac
    }
    aud065_verify_or_create_report() { [[ "$FAILURE_STAGE" != report ]]; }
    aud065_load_barrier_binding() {
      [[ "$FAILURE_STAGE" != barrier ]] || return 1
      AUD065_BOUND_LOCK_UID=lock-terminal-uid
    }
    aud065_operation_tool() { [[ "$FAILURE_STAGE" != terminal ]]; }
    if aud065_verify_terminal_record; then exit 0; else exit 1; fi
  ' bash "$DRIVER" "$failure_stage" "$fixture_root"
}

for terminal_record_failure in final-reconcile released-reconcile report barrier terminal; do
  expect_failure "terminal verification propagates $terminal_record_failure failure" \
    run_terminal_record_guard_fixture "$terminal_record_failure"
done

run_scale_original_guard_fixture() {
  local failure_stage="$1" replicas=0
  [[ "$failure_stage" == lock ]] && replicas=1
  bash -c '
    set -Eeuo pipefail
    source "$1"
    FAILURE_STAGE="$2"
    CURRENT_REPLICAS="$3"
    aud065_applied_deployment_contract() {
      printf "uid-demo\trv-baseline\t0\tselector-demo\tfingerprint-demo\n"
    }
    aud065_capture_deployment_contract() {
      printf "uid-demo\trv-current\t%s\tselector-demo\tfingerprint-demo\n" \
        "$CURRENT_REPLICAS"
    }
    aud065_scale_deployment_exact() { [[ "$FAILURE_STAGE" != scale ]]; }
    aud065_crash_point() { [[ "$FAILURE_STAGE" != crash ]]; }
    recovery_require_operation_lock() { [[ "$FAILURE_STAGE" != lock ]]; }
    recovery_wait_for_deployment_rollout() { [[ "$FAILURE_STAGE" != rollout ]]; }
    aud065_require_deployment_contract() { [[ "$FAILURE_STAGE" != final-contract ]]; }
    if aud065_scale_one_to_original demo; then exit 0; else exit 1; fi
  ' bash "$DRIVER" "$failure_stage" "$replicas"
}

for scale_failure in scale crash lock rollout final-contract; do
  expect_failure "restart propagates $scale_failure failure under a conditional caller" \
    run_scale_original_guard_fixture "$scale_failure"
done

run_released_capture_guard_fixture() {
  local failure_stage="$1" branch="$2" fixture_root
  fixture_root="$TMP_ROOT/released-$branch-$failure_stage"
  mkdir -m 700 "$fixture_root" "$fixture_root/scratch"
  if [[ "$branch" == existing ]]; then
    printf '{}\n' >"$fixture_root/released.json"
    chmod 600 "$fixture_root/released.json"
  fi
  bash -c '
    set -Eeuo pipefail
    source "$1"
    FAILURE_STAGE="$2"
    FIXTURE_ROOT="$3"
    AUD065_RELEASED_BASELINE="$FIXTURE_ROOT/released.json"
    AUD065_FINAL_BASELINE="$FIXTURE_ROOT/final.json"
    aud065_reconcile_private_file() { [[ "$FAILURE_STAGE" != reconcile ]]; }
    aud065_verify_release_baseline() {
      if [[ "$1" == "$AUD065_RELEASED_BASELINE" ]]; then
        [[ "$FAILURE_STAGE" != existing-verify ]]
      else
        [[ "$FAILURE_STAGE" != live-verify ]]
      fi
    }
    aud065_make_scratch_directory() { printf -v "$1" "%s" "$FIXTURE_ROOT/scratch"; }
    aud065_capture_private_baseline() {
      [[ "$FAILURE_STAGE" != capture ]] || return 1
      printf "{}\n" >"$1"
      chmod 600 "$1"
    }
    aud065_publish_private_file() {
      [[ "$FAILURE_STAGE" != publish ]] || return 1
      printf "{}\n" >"$2"
      chmod 600 "$2"
    }
    aud065_cleanup_scratch_directory() { [[ "$FAILURE_STAGE" != cleanup ]]; }
    if aud065_capture_and_verify_released_state; then exit 0; else exit 1; fi
  ' bash "$DRIVER" "$failure_stage" "$fixture_root"
}

for released_failure in reconcile existing-verify capture live-verify cleanup; do
  expect_failure "released existing-state capture propagates $released_failure failure" \
    run_released_capture_guard_fixture "$released_failure" existing
done
for released_failure in capture live-verify publish cleanup; do
  expect_failure "released new-state capture propagates $released_failure failure" \
    run_released_capture_guard_fixture "$released_failure" new
done

for closed_resume_state in verified cleanup-authorized; do
  CLOSED_RESUME_LOG="$TMP_ROOT/closed-resume-$closed_resume_state.log"
  closed_resume_status=0
  if bash -c '
    set -Eeuo pipefail
    export AUD065_DRIVER_SOURCE_ONLY=1
    source "$1"
    STATE="$2"
    BARRIER_STATE=closed
    LOG_PATH="$3"
    RECOVERY_OPERATION_STATE="$STATE"
    RECOVERY_OPERATION_LOCK_UID=lock-closed-resume
    log() { printf "%s\n" "$1" >>"$LOG_PATH"; }
    aud065_reload_guard() {
      RECOVERY_OPERATION_STATE="$STATE"
      RECOVERY_OPERATION_LOCK_UID=lock-closed-resume
    }
    aud065_pgsql_barrier_read_state() { printf "%s\n" "$BARRIER_STATE"; }
    aud065_require_pgsql_consumers_and_pods_absent() { log consumers-absent; }
    aud065_require_no_pgsql_client_backends() { log sessions-zero; }
    aud065_require_pgsql_unix_socket_local() { log socket-unix; }
    aud065_probe_image() { printf "postgres@sha256:%064d\n" 0; }
    aud065_pgsql_probe_bind_image() { log probe-bind; }
    aud065_pgsql_probe_create() { log probe-create; }
    aud065_require_pgsql_probe_nonready_and_unroutable() { log probe-nonready; }
    aud065_pgsql_barrier_open() { log barrier-open; BARRIER_STATE=open-verified; }
    aud065_scale_one_to_original() { log "scale:$1"; }
    aud065_probe_fresh_auth() { log "pool-auth:$1:$2:$3"; }
    recovery_require_live_images_match_checkpoint() { :; }
    aud065_verify_or_create_report() { log report-verified; }
    aud065_verify_fresh_cleanup_gate() { log fresh-open-gate; }
    recovery_require_operation_lock() { :; }
    recovery_transition_aud065_operation_lock() {
      log "transition:$RECOVERY_OPERATION_STATE->$1"
      STATE="$1"
      RECOVERY_OPERATION_STATE="$1"
    }
    aud065_pgsql_barrier_cleanup() {
      verdict="$("$2")" || return 1
      [[ "$verdict" == cleanup-authorized ]] || return 1
      log cleanup-cas
      BARRIER_STATE=normal
    }
    aud065_verify_local_tcp_cleanup_gate() { log local-tcp-gate; }
    aud065_pgsql_probe_cleanup() { log probe-delete; }
    aud065_capture_and_verify_released_state() { log released-baseline; }
    aud065_promote_source() { log source-promoted; }
    aud065_write_or_verify_terminal() { log terminal; }
    recovery_release_operation_lock() { log release-lock; }
    aud065_crash_point() { :; }
    aud065_cb_assert_quiesced
    aud065_cb_start_pools
    aud065_cb_verify_pools
    aud065_cb_start_consumers
    aud065_cb_verify_runtime
    aud065_cb_complete
  ' bash "$DRIVER" "$closed_resume_state" "$CLOSED_RESUME_LOG" \
    >/dev/null 2>&1; then
    closed_resume_status=0
  else
    closed_resume_status=$?
  fi
  cleanup_line="$(rg -n '^cleanup-cas$' "$CLOSED_RESUME_LOG" | cut -d: -f1)"
  terminal_line="$(rg -n '^terminal$' "$CLOSED_RESUME_LOG" | cut -d: -f1)"
  release_line="$(rg -n '^release-lock$' "$CLOSED_RESUME_LOG" | cut -d: -f1)"
  if [[ "$closed_resume_status" == 0 ]] &&
     [[ "$(sed -n '1,3p' "$CLOSED_RESUME_LOG")" == $'consumers-absent\nsessions-zero\nsocket-unix' ]] &&
     rg -q '^barrier-open$' "$CLOSED_RESUME_LOG" &&
     [[ "$cleanup_line" -lt "$terminal_line" && "$terminal_line" -lt "$release_line" ]]; then
    pass "$closed_resume_state closed fail-close state reopens, restarts and completes"
  else
    fail "$closed_resume_state closed fail-close state reopens, restarts and completes"
  fi
done

# The crash hook must kill the exported root coordinator even when invoked by
# a callback subshell. Merely exiting that callback would allow the driver to
# continue and would not exercise a real durable cut.
CRASH_MARKER="$TMP_ROOT/crash-hook-continued"
crash_status=0
if { bash -c '
  set -Eeuo pipefail
  export AUD065_DRIVER_SOURCE_ONLY=1
  source "$1"
  export YENHUBS_RECOVERY_TEST_MODE=local-fixture
  export EXPECTED_KUBE_CONTEXT=fixture-context
  export EXPECTED_NAMESPACE_UID=fixture-uid
  export EXPECTED_RET_PVC_UID=fixture-pvc-uid
  export NAMESPACE=hcce AUD065_TEST_CRASH_AFTER=callback-cut
  AUD065_COORDINATOR_PID="$$"
  export AUD065_COORDINATOR_PID
  ( aud065_crash_point callback-cut )
  : >"$2"
' bash "$DRIVER" "$CRASH_MARKER" >/dev/null 2>&1; } 2>/dev/null; then
  crash_status=0
else
  crash_status=$?
fi
if [[ "$crash_status" == 137 && ! -e "$CRASH_MARKER" ]]; then
  pass 'fixture crash hook kills the root coordinator from a callback subshell'
else
  fail 'fixture crash hook kills the root coordinator from a callback subshell'
fi

for signal_case in INT:130 TERM:143; do
  signal_name="${signal_case%%:*}"
  signal_status="${signal_case##*:}"
  SIGNAL_LOG="$TMP_ROOT/signal-$signal_name.log"
  actual_signal_status=0
  if bash -c '
    set -Eeuo pipefail
    export AUD065_DRIVER_SOURCE_ONLY=1
    source "$1"
    SIGNAL_LOG="$2"
    SIGNAL_NAME="$3"
    signal_log() { printf "%s\n" "$1" >>"$SIGNAL_LOG"; }
    aud065_parse_cli() { AUD065_COMMAND=execute; }
    aud065_require_environment() {
      kill -s "$SIGNAL_NAME" "$$"
      signal_log success-token
    }
    aud065_fail_close() { signal_log fail-close; }
    aud065_release_lease_if_owned() { signal_log release-lease; }
    aud065_error() { signal_log error; }
    main fixture
    signal_log success-token
  ' bash "$DRIVER" "$SIGNAL_LOG" "$signal_name" >/dev/null 2>&1; then
    actual_signal_status=0
  else
    actual_signal_status=$?
  fi
  if [[ "$actual_signal_status" == "$signal_status" ]] &&
     [[ "$(cat "$SIGNAL_LOG")" == $'fail-close\nrelease-lease\nerror' ]]; then
    pass "$signal_name exits with its explicit nonzero status after fail-close"
  else
    fail "$signal_name exits with its explicit nonzero status after fail-close"
  fi
done

# Seven durable CAS cuts exist in bundle order (Secret plus six Deployments).
# For every prefix, run the real driver rollback dispatcher and pldb rollback
# state machine. The real rb_quiesce/fail_close_one path must accept candidate
# Deployment specs directly from the authenticated bundle without relying on
# completion-only applied-resources evidence.
ROLLBACK_BIN="$TMP_ROOT/rollback-bin"
mkdir -m 700 "$ROLLBACK_BIN"
cat >"$ROLLBACK_BIN/node" <<'ROLLBACK_NODE'
#!/usr/bin/env bash
set -euo pipefail
tool="${1##*/}"
shift
[[ "$tool" == materialize-process-local-replacements.mjs ]] || exit 90
command_name="${1:-}"
shift || :
case "$command_name" in
  verify|materialize) exit 0 ;;
  classify)
    prefix="$(<"$ROLLBACK_STATE")"
    jq -cn --argjson already "$prefix" --argjson pending "$((7 - prefix))" '
      {alreadyAppliedCount:$already,pendingCount:$pending,
       resources:[range(0;7) | {state:(if . < $already then "already-applied" else "pending" end)}]}
    '
    ;;
  emit-verified) printf '{}\n' ;;
  extract-applied)
    output=""
    while [[ "$#" -gt 0 ]]; do
      if [[ "$1" == --output ]]; then output="$2"; break; fi
      shift 2
    done
    [[ -n "$output" ]] || exit 91
    printf '{}\n' >"$output"
    chmod 600 "$output"
    ;;
  *) exit 92 ;;
esac
ROLLBACK_NODE
chmod 700 "$ROLLBACK_BIN/node"
rollback_cut_names=(
  after-replace-00-secret-configs
  after-replace-01-deployment-bot-orchestrator
  after-replace-02-deployment-coturn
  after-replace-03-deployment-dialog
  after-replace-04-deployment-pgbouncer
  after-replace-05-deployment-pgbouncer-t
  after-replace-06-deployment-reticulum
)
for rollback_cut in "${!rollback_cut_names[@]}"; do
  rollback_prefix=$((rollback_cut + 1))
  ROLLBACK_PREFIX_OP="$TMP_ROOT/rollback-prefix-$rollback_prefix"
  ROLLBACK_PREFIX_LOG="$TMP_ROOT/rollback-prefix-$rollback_prefix.log"
  mkdir -m 700 "$ROLLBACK_PREFIX_OP"
  mkdir -m 700 "$ROLLBACK_PREFIX_OP/replacements"
  printf '{}\n' >"$ROLLBACK_PREFIX_OP/bundle.json"
  chmod 600 "$ROLLBACK_PREFIX_OP/bundle.json"
  printf '%s\n' "$rollback_prefix" >"$ROLLBACK_PREFIX_OP/prefix.state"
  chmod 600 "$ROLLBACK_PREFIX_OP/prefix.state"
  rollback_prefix_status=0
  if bash -c '
    set -Eeuo pipefail
    export AUD065_DRIVER_SOURCE_ONLY=1
    source "$1"
    CUT="$2"
    AUD065_OPERATION_DIRECTORY="$3"
    LOG_PATH="$4"
    PATH="$5:$PATH"
    export PATH
    AUD065_BUNDLE="$AUD065_OPERATION_DIRECTORY/bundle.json"
    AUD065_APPLIED_RESOURCES="$AUD065_OPERATION_DIRECTORY/applied-resources.json"
    AUD065_REPLACEMENTS_DIRECTORY="$AUD065_OPERATION_DIRECTORY/replacements"
    ROLLBACK_STATE="$AUD065_OPERATION_DIRECTORY/prefix.state"
    export ROLLBACK_STATE
    RECOVERY_OPERATION_STATE=db-rotated
    RECOVERY_OPERATION_ID="11111111111111111111111111111111"
    RECOVERY_OPERATION_BINDING_SHA256="$(printf "2%.0s" {1..64})"
    rollback_log() { printf "%s\n" "$1" >>"$LOG_PATH"; }
    aud065_reload_guard() { :; }
    aud065_require_private_directory() { return 0; }
    aud065_require_private_file() { return 0; }
    aud065_link_count() { printf "1\n"; }
    aud065_capture_private_baseline() {
      printf "{}\n" >"$1"
      chmod 600 "$1"
    }
    aud065_runtime_identifiers() { printf "ret0\tret_dev\n"; }
    aud065_emit_runtime_password() {
      [[ "$1" == new ]] || return 2
      printf "NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN\n"
    }
    aud065_probe_image() { printf "postgres@sha256:%064d\n" 0; }
    aud065_pgsql_probe_bind_image() { :; }
    aud065_pgsql_probe_create() { :; }
    aud065_require_pgsql_probe_nonready_and_unroutable() { :; }
    aud065_pgsql_barrier_close() { rollback_log barrier-close; }
    aud065_pgsql_barrier_read_state() { printf "closed\n"; }
    aud065_deployment_baseline_contract() {
      printf "uid-%s\trv-original-%s\t1\t%s\toriginal-%s\n" "$1" "$1" "$1" "$1"
    }
    aud065_applied_deployment_contract() {
      printf "uid-%s\trv-original-%s\t0\t%s\tcandidate-%s\n" "$1" "$1" "$1" "$1"
    }
    candidate_index() {
      case "$1" in
        bot-orchestrator) printf "2\n" ;;
        coturn) printf "3\n" ;;
        dialog) printf "4\n" ;;
        pgbouncer) printf "5\n" ;;
        pgbouncer-t) printf "6\n" ;;
        reticulum) printf "7\n" ;;
        *) return 1 ;;
      esac
    }
    aud065_capture_deployment_contract() {
      local index fingerprint
      index="$(candidate_index "$1")" || return 1
      if ((CUT >= index)); then fingerprint="candidate-$1"; else fingerprint="original-$1"; fi
      rollback_log "accepted:$1:$fingerprint"
      printf "uid-%s\trv-live-%s\t0\t%s\t%s\n" "$1" "$1" "$1" "$fingerprint"
    }
    recovery_require_operation_lock() { :; }
    recovery_require_operation_serialization() { :; }
    recovery_kubectl_mutate() {
      IFS= read -r _candidate || :
      prefix="$(<"$ROLLBACK_STATE")"
      prefix=$((prefix + 1))
      printf "%s\n" "$prefix" >"$ROLLBACK_STATE"
      rollback_log "replacement:$prefix"
      printf "{}\n"
    }
    recovery_transition_aud065_operation_lock() {
      rollback_log "transition:$RECOVERY_OPERATION_STATE->$1"
      RECOVERY_OPERATION_STATE="$1"
    }
    aud065_crash_point() { :; }
    recovery_wait_for_no_pods() { :; }
    aud065_require_pgsql_consumers_and_pods_absent() { :; }
    aud065_require_no_pgsql_client_backends() { :; }
    aud065_require_pgsql_unix_socket_local() { :; }
    aud065_psql_socket() { while IFS= read -r _line; do :; done; printf "new\n"; }
    aud065_cb_start_pools() { rollback_log start-pools; }
    aud065_cb_verify_pools() { rollback_log verify-pools; }
    aud065_cb_start_consumers() { rollback_log start-consumers; }
    aud065_cb_verify_runtime() { rollback_log verify-runtime; }
    aud065_cb_complete() { rollback_log complete; }
    aud065_cb_fail_close() { rollback_log fail-close; }
    aud065_run_rollback_callbacks
  ' bash "$DRIVER" "$rollback_prefix" "$ROLLBACK_PREFIX_OP" \
    "$ROLLBACK_PREFIX_LOG" "$ROLLBACK_BIN" >/dev/null 2>&1; then
    rollback_prefix_status=0
  else
    rollback_prefix_status=$?
  fi
  replacement_count="$(rg -c '^replacement:' "$ROLLBACK_PREFIX_LOG" || :)"
  replacement_count="${replacement_count:-0}"
  if [[ "$rollback_prefix_status" == 0 ]] &&
     [[ "$(rg -c '^accepted:' "$ROLLBACK_PREFIX_LOG")" == 6 ]] &&
     [[ "$replacement_count" == "$((7 - rollback_prefix))" ]] &&
     [[ "$(<"$ROLLBACK_PREFIX_OP/prefix.state")" == 7 ]] &&
     rg -q '^transition:db-rotated->bundle-applied$' "$ROLLBACK_PREFIX_LOG" &&
     rg -q '^complete$' "$ROLLBACK_PREFIX_LOG" &&
     ! rg -q 'NNNNNNNN' "$ROLLBACK_PREFIX_LOG"; then
    pass "rollback resumes safely from ${rollback_cut_names[$rollback_cut]}"
  else
    fail "rollback resumes safely from ${rollback_cut_names[$rollback_cut]}"
  fi
done

# Explicit rollback coverage: only a single NEW password enters on stdin and
# pldb_run_rollback_with_new fails closed around every callback.
ROLLBACK_LOG="$TMP_ROOT/rollback.log"
rollback_log() { printf '%s\n' "$1" >>"$ROLLBACK_LOG"; }
rb_guard() { rollback_log guard; }
rb_quiesce() { rollback_log quiesce; }
rb_assert_quiesced() { rollback_log assert-quiesced; }
rb_assert_new() { IFS= read -r _verifier; rollback_log assert-new; }
rb_apply() { IFS= read -r _verifier; rollback_log rollback-new-only; }
rb_pools() { rollback_log start-pools; }
rb_verify_pools() { rollback_log verify-pools; }
rb_consumers() { rollback_log start-consumers; }
rb_runtime() { rollback_log verify-runtime; }
rb_complete() { rollback_log complete; }
rb_fail_close() { rollback_log "fail-close:$1"; }
PLDB_GUARD_CALLBACK=rb_guard
PLDB_QUIESCE_CALLBACK=rb_quiesce
PLDB_ASSERT_QUIESCED_CALLBACK=rb_assert_quiesced
# Consumed indirectly by the sourced callback state machine.
# shellcheck disable=SC2034
PLDB_ASSERT_NEW_CALLBACK=rb_assert_new
# shellcheck disable=SC2034
PLDB_ROLLBACK_CALLBACK=rb_apply
PLDB_START_POOLS_CALLBACK=rb_pools
PLDB_VERIFY_POOLS_CALLBACK=rb_verify_pools
PLDB_START_CONSUMERS_CALLBACK=rb_consumers
PLDB_VERIFY_RUNTIME_CALLBACK=rb_runtime
PLDB_COMPLETE_CALLBACK=rb_complete
PLDB_FAIL_CLOSE_CALLBACK=rb_fail_close
new_password='NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN'
printf '%s\n' "$new_password" | pldb_run_rollback_with_new ret0
expect_equal "$(cat "$ROLLBACK_LOG")" $'guard\nquiesce\nassert-quiesced\nassert-new\nrollback-new-only\nstart-pools\nverify-pools\nstart-consumers\nverify-runtime\ncomplete' \
  'rollback callback path retains only the new DB credential'
if ! rg -q "$new_password" "$ROLLBACK_LOG"; then
  pass 'rollback does not log credential material'
else
  fail 'rollback does not log credential material'
fi

printf '1..%d\n' "$((PASS_COUNT + FAIL_COUNT))"
if [[ "$FAIL_COUNT" -ne 0 ]]; then exit 1; fi

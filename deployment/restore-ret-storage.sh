#!/usr/bin/env bash
# shellcheck disable=SC2016

# Restores the verified Reticulum owned-file half of one complete checkpoint
# into an empty ret-pvc. RESTORE_STORAGE_PREFLIGHT=1 validates the immutable
# pair and target identities without changing Kubernetes state.

set -euo pipefail
umask 077

if [[ $# -ne 1 ]]; then
  printf 'Usage: RESTORE_STORAGE_PREFLIGHT=1 %s /path/to/ret-storage-YYYYMMDD-HHMMSS.tar.gz\n' "$0" >&2
  exit 2
fi

ARCHIVE_PATH="$1"
NAMESPACE="${NAMESPACE:-hcce}"
PREFLIGHT="${RESTORE_STORAGE_PREFLIGHT:-${RESTORE_STORAGE_DRY_RUN:-0}}"
COORDINATED="${RESTORE_COORDINATED:-0}"
CLEAR_STALE_HELPER="${RESTORE_STORAGE_CLEAR_STALE_HELPER:-0}"
RESTORE_POD=""
RESTORE_NETWORK_POLICY=""
DB_CONSUMERS=(reticulum pgbouncer pgbouncer-t bot-orchestrator coturn)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARENT_LEASE_HOLDER="${YENHUBS_PARENT_LEASE_HOLDER:-}"
PARENT_LEASE_UID="${YENHUBS_PARENT_LEASE_UID:-}"
PARENT_PROCESS_PID="${YENHUBS_PARENT_PROCESS_PID:-}"
PARENT_PROCESS_START_IDENTITY="${YENHUBS_PARENT_PROCESS_START_IDENTITY:-}"
PARENT_DURABLE_FENCE_BASELINE_PATH="${YENHUBS_PARENT_DURABLE_MONITOR_BASELINE_PATH:-}"
PARENT_DURABLE_FENCE_BASELINE_SHA256="${YENHUBS_PARENT_DURABLE_MONITOR_BASELINE_SHA256:-}"
PARENT_RECOVERY_OPERATION_FENCE_ACTIVE_IDENTITY="${YENHUBS_PARENT_RECOVERY_OPERATION_FENCE_ACTIVE_IDENTITY:-}"
PARENT_WRITER_MONITOR_PID="${YENHUBS_PARENT_WRITER_MONITOR_PID:-}"
PARENT_WRITER_MONITOR_START_IDENTITY="${YENHUBS_PARENT_WRITER_MONITOR_START_IDENTITY:-}"
PARENT_WRITER_MONITOR_CONTRACT_PATH="${YENHUBS_PARENT_WRITER_MONITOR_CONTRACT_PATH:-}"
PARENT_WRITER_MONITOR_CONTRACT_SHA256="${YENHUBS_PARENT_WRITER_MONITOR_CONTRACT_SHA256:-}"
PARENT_WRITER_MONITOR_BASELINE_PATH="${YENHUBS_PARENT_WRITER_MONITOR_BASELINE_PATH:-}"
PARENT_WRITER_MONITOR_BASELINE_SHA256="${YENHUBS_PARENT_WRITER_MONITOR_BASELINE_SHA256:-}"
PARENT_WRITER_MONITOR_FAILURE_PATH="${YENHUBS_PARENT_WRITER_MONITOR_FAILURE_PATH:-}"
PARENT_WRITER_MONITOR_READY_PATH="${YENHUBS_PARENT_WRITER_MONITOR_READY_PATH:-}"
PARENT_WRITER_MONITOR_PROGRESS_PATH="${YENHUBS_PARENT_WRITER_MONITOR_PROGRESS_PATH:-}"
PARENT_WRITER_MONITOR_AUTHORITY_SHA256="${YENHUBS_PARENT_WRITER_MONITOR_AUTHORITY_SHA256:-}"
PARENT_WRITER_MONITOR_MAX_STALE_SECONDS=""
PARENT_WRITER_STREAM_GUARD_ARGS=()
PARENT_DURABLE_MONITOR_PID="${YENHUBS_PARENT_DURABLE_MONITOR_PID:-}"
PARENT_DURABLE_MONITOR_START_IDENTITY="${YENHUBS_PARENT_DURABLE_MONITOR_START_IDENTITY:-}"
PARENT_DURABLE_MONITOR_FAILURE_PATH="${YENHUBS_PARENT_DURABLE_MONITOR_FAILURE_PATH:-}"
PARENT_DURABLE_MONITOR_READY_PATH="${YENHUBS_PARENT_DURABLE_MONITOR_READY_PATH:-}"
PARENT_DURABLE_MONITOR_PROGRESS_PATH="${YENHUBS_PARENT_DURABLE_MONITOR_PROGRESS_PATH:-}"
PARENT_DURABLE_MONITOR_CAPABILITY_SHA256="${YENHUBS_PARENT_DURABLE_MONITOR_CAPABILITY_SHA256:-}"
PARENT_DURABLE_MONITOR_AUTHORITY_SHA256="${YENHUBS_PARENT_DURABLE_MONITOR_AUTHORITY_SHA256:-}"
PARENT_DURABLE_MONITOR_MAX_STALE_SECONDS=""
PARENT_DURABLE_STREAM_GUARD_ARGS=()
VALUES_INPUT_FILE="${VALUES_FILE:-$SCRIPT_DIR/input-values.local.yaml}"
CUTOVER_KEY_INPUT_FILE="${PROCESS_LOCAL_CUTOVER_KEY_PATH:-}"
VALUES_SOURCE_FILE=""
CUTOVER_KEY_SNAPSHOT=""
PROCESS_LOCAL_CUTOVER_KEY_PATH=""
VALIDATION_DIR=""
VALIDATION_DIR_PRIVATE_TOKEN=""
VALIDATION_DIR_CLEANUP_ATTEMPTED=0
VALIDATION_DIR_RETIRED=0
VALIDATION_SETUP_STATUS=0
export PROCESS_LOCAL_CUTOVER_KEY_PATH
# shellcheck source=deployment/lib/reactivation-gate-functions.sh
source "$SCRIPT_DIR/lib/reactivation-gate-functions.sh"
# shellcheck source=deployment/lib/recovery-safety.sh
source "$SCRIPT_DIR/lib/recovery-safety.sh"
unset YENHUBS_PARENT_WRITER_MONITOR_PID \
  YENHUBS_PARENT_WRITER_MONITOR_START_IDENTITY \
  YENHUBS_PARENT_WRITER_MONITOR_CONTRACT_PATH \
  YENHUBS_PARENT_WRITER_MONITOR_CONTRACT_SHA256 \
  YENHUBS_PARENT_WRITER_MONITOR_BASELINE_PATH \
  YENHUBS_PARENT_WRITER_MONITOR_BASELINE_SHA256 \
  YENHUBS_PARENT_WRITER_MONITOR_FAILURE_PATH \
  YENHUBS_PARENT_WRITER_MONITOR_READY_PATH \
  YENHUBS_PARENT_WRITER_MONITOR_PROGRESS_PATH \
  YENHUBS_PARENT_WRITER_MONITOR_AUTHORITY_SHA256 \
  YENHUBS_PARENT_DURABLE_MONITOR_PID \
  YENHUBS_PARENT_DURABLE_MONITOR_START_IDENTITY \
  YENHUBS_PARENT_DURABLE_MONITOR_BASELINE_PATH \
  YENHUBS_PARENT_DURABLE_MONITOR_BASELINE_SHA256 \
  YENHUBS_PARENT_DURABLE_MONITOR_FAILURE_PATH \
  YENHUBS_PARENT_DURABLE_MONITOR_READY_PATH \
  YENHUBS_PARENT_DURABLE_MONITOR_PROGRESS_PATH \
  YENHUBS_PARENT_DURABLE_MONITOR_CAPABILITY_SHA256 \
  YENHUBS_PARENT_DURABLE_MONITOR_AUTHORITY_SHA256 \
  YENHUBS_PARENT_RECOVERY_OPERATION_FENCE_ACTIVE_IDENTITY
recovery_require_in_place_restore_target_mode

if [[ -n "${RESTORE_STORAGE_DRY_RUN:-}" && -z "${RESTORE_STORAGE_PREFLIGHT:-}" ]]; then
  printf 'RESTORE_STORAGE_DRY_RUN is deprecated; this is a preflight only. Use RESTORE_STORAGE_PREFLIGHT=1.\n' >&2
fi
if [[ "$PREFLIGHT" != "0" && "$PREFLIGHT" != "1" ]]; then
  printf 'RESTORE_STORAGE_PREFLIGHT must be 0 or 1.\n' >&2
  exit 2
fi
if [[ "$COORDINATED" != "0" && "$COORDINATED" != "1" ]]; then
  printf 'RESTORE_COORDINATED must be 0 or 1.\n' >&2
  exit 2
fi
if [[ "$CLEAR_STALE_HELPER" != "0" && "$CLEAR_STALE_HELPER" != "1" ]]; then
  printf 'RESTORE_STORAGE_CLEAR_STALE_HELPER must be 0 or 1.\n' >&2
  exit 2
fi
if [[ "$CLEAR_STALE_HELPER" == "1" && "$COORDINATED" != "1" ]]; then
  printf 'Stale helper clearance requires the coordinated parent lock.\n' >&2
  exit 2
fi
if [[ "$PREFLIGHT" == "0" && "$COORDINATED" != "1" ]]; then
  printf 'Destructive storage restore is only allowed through restore-checkpoint.sh coordination.\n' >&2
  exit 2
fi

RESTORE_POD_CREATED=0
RESTORE_POD_UID=""
RESTORE_NETWORK_POLICY_CREATED=0
RESTORE_NETWORK_POLICY_UID=""
RESTORE_CHILD_PENDING_SIGNAL_STATUS=0
RESTORE_CHILD_SIGNAL_OWNER_SUBSHELL="$BASH_SUBSHELL"
PVC_MONITOR_PID=""
PVC_MONITOR_START_IDENTITY=""
PVC_MONITOR_STOP=""
PVC_MONITOR_FAILURE=""
PVC_MONITOR_PROGRESS=""
RUNNER_WATCH_PID=""
RUNNER_WATCH_START_IDENTITY=""
RUNNER_WATCH_STOP=""
RUNNER_WATCH_FAILURE=""
RUNNER_WATCH_READY=""
RUNNER_WATCH_PROGRESS=""
STORAGE_STREAM_GUARD_ARGS=()
STORAGE_STREAM_GUARD_MAX_STALE_SECONDS=""
STORAGE_STREAM_GUARD_INITIAL_DEADLINE_SECONDS=""
PVC_MONITOR_POLL_SECONDS=""
PVC_MUTATION_STREAM_ARMED=0
REMOTE_RESTORE_STATE_RETAINED=0
RESTORE_PHASE="validating"

stop_pvc_monitor() {
  local monitor_status=0
  if [[ -n "$PVC_MONITOR_PID" ]]; then
    : >"$PVC_MONITOR_STOP"
    if wait "$PVC_MONITOR_PID"; then
      monitor_status=0
    else
      monitor_status=$?
    fi
    PVC_MONITOR_PID=""
    PVC_MONITOR_START_IDENTITY=""
  fi
  if [[ -n "$PVC_MONITOR_FAILURE" && -s "$PVC_MONITOR_FAILURE" ]]; then
    STORAGE_STREAM_GUARD_ARGS=()
    STORAGE_STREAM_GUARD_MAX_STALE_SECONDS=""
    STORAGE_STREAM_GUARD_INITIAL_DEADLINE_SECONDS=""
    printf 'PVC consumer/identity monitoring failed during extraction.\n' >&2
    return 1
  fi
  STORAGE_STREAM_GUARD_ARGS=()
  STORAGE_STREAM_GUARD_MAX_STALE_SECONDS=""
  STORAGE_STREAM_GUARD_INITIAL_DEADLINE_SECONDS=""
  [[ "$monitor_status" -eq 0 ]]
}

initialize_runner_quiescence() {
  case "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" in
    legacy-absent)
      recovery_wait_for_no_managed_bot_runner_pods 180s &&
        require_parent_restore_guards
      ;;
    durable-v2)
      recovery_require_checkpoint_runner_quiescence_exact durable-v2 \
        "$PARENT_DURABLE_FENCE_BASELINE_PATH" \
        "$PARENT_DURABLE_FENCE_BASELINE_SHA256" &&
        require_parent_restore_guards
      ;;
    *)
      return 1
      ;;
  esac
}

require_runner_quiescence() {
  case "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" in
    legacy-absent)
      recovery_require_no_managed_bot_runner_pods &&
        require_parent_restore_guards
      ;;
    durable-v2)
      recovery_require_checkpoint_runner_quiescence_exact durable-v2 \
        "$PARENT_DURABLE_FENCE_BASELINE_PATH" \
        "$PARENT_DURABLE_FENCE_BASELINE_SHA256" &&
        require_parent_restore_guards
      ;;
    *)
      return 1
      ;;
  esac
}

require_runner_watch_healthy() {
  if [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == durable-v2 ]]; then
    [[ -z "$RUNNER_WATCH_PID" &&
       -z "$RUNNER_WATCH_START_IDENTITY" ]] || return 1
    require_runner_quiescence
  else
    recovery_require_no_managed_bot_runner_watch_healthy \
      "$RUNNER_WATCH_FAILURE" "$RUNNER_WATCH_READY" "$RUNNER_WATCH_PID" \
      "$RUNNER_WATCH_START_IDENTITY" &&
      require_parent_restore_guards
  fi
}

start_runner_watch() {
  [[ -z "$RUNNER_WATCH_PID" &&
     -z "$RUNNER_WATCH_START_IDENTITY" ]] || return 2
  if [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == durable-v2 ]]; then
    require_runner_quiescence
    return
  fi
  [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == legacy-absent ]] || return 1
  require_runner_quiescence || return 1
  : >"$RUNNER_WATCH_STOP"
  : >"$RUNNER_WATCH_FAILURE"
  : >"$RUNNER_WATCH_READY"
  : >"$RUNNER_WATCH_PROGRESS"
  chmod 600 "$RUNNER_WATCH_STOP" "$RUNNER_WATCH_FAILURE" "$RUNNER_WATCH_READY" \
    "$RUNNER_WATCH_PROGRESS"
  recovery_start_no_managed_bot_runner_watch \
    "$RUNNER_WATCH_STOP" "$RUNNER_WATCH_FAILURE" "$RUNNER_WATCH_READY" \
    RUNNER_WATCH_PID RUNNER_WATCH_START_IDENTITY "$RUNNER_WATCH_PROGRESS"
}

stop_runner_watch() {
  local status=0
  if [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == durable-v2 ]]; then
    [[ -z "$RUNNER_WATCH_PID" &&
       -z "$RUNNER_WATCH_START_IDENTITY" ]] || status=1
    require_runner_quiescence || status=1
  else
    [[ "$RUNNER_WATCH_PID" =~ ^[1-9][0-9]*$ ]] || return 2
    if ! recovery_stop_no_managed_bot_runner_watch \
      "$RUNNER_WATCH_STOP" "$RUNNER_WATCH_FAILURE" "$RUNNER_WATCH_READY" \
      "$RUNNER_WATCH_PID" "$RUNNER_WATCH_START_IDENTITY"; then
      status=1
    fi
    require_runner_quiescence || status=1
  fi
  RUNNER_WATCH_PID=""
  RUNNER_WATCH_START_IDENTITY=""
  [[ "$status" == 0 ]]
}

restore_pod_spec_is_exact() {
  local pod_json="$1"
  local pod_uid="${2:-$RESTORE_POD_UID}"
  [[ -n "$pod_uid" ]] || return 1
  recovery_storage_helper_pod_is_exact "$pod_json" "$RESTORE_POD" \
    "$pod_uid" ret-storage-restore "$RET_IMAGE" false
}

restore_network_policy_spec_is_exact() {
  local policy_json="$1"
  local policy_uid="${2:-$RESTORE_NETWORK_POLICY_UID}"
  [[ -n "$policy_uid" ]] || return 1
  recovery_storage_helper_network_policy_is_exact "$policy_json" \
    "$RESTORE_NETWORK_POLICY" "$policy_uid" ret-storage-restore
}

capture_restore_pod_identity() {
  local pod_json="${1:-}" pod_uid
  if [[ -z "$pod_json" ]]; then
    pod_json="$(recovery_kubectl get pod "$RESTORE_POD" \
      -n "$NAMESPACE" -o json)" || return 1
  fi
  pod_uid="$(jq -er '.metadata.uid | select(type == "string" and length > 0)' <<<"$pod_json")" || return 1
  restore_pod_spec_is_exact "$pod_json" "$pod_uid" || return 1
  RESTORE_POD_UID="$pod_uid"
}

require_owned_restore_pod() {
  local pod_json current_uid
  [[ -n "$RESTORE_POD_UID" ]] || return 1
  pod_json="$(recovery_kubectl get pod "$RESTORE_POD" -n "$NAMESPACE" -o json)" || return 1
  current_uid="$(jq -er '.metadata.uid | select(type == "string" and length > 0)' <<<"$pod_json")" || return 1
  [[ "$current_uid" == "$RESTORE_POD_UID" ]] || return 1
  restore_pod_spec_is_exact "$pod_json"
}

capture_restore_network_policy_identity() {
  local policy_json="${1:-}" policy_uid
  if [[ -z "$policy_json" ]]; then
    policy_json="$(recovery_kubectl get networkpolicy "$RESTORE_NETWORK_POLICY" \
      -n "$NAMESPACE" -o json)" || return 1
  fi
  policy_uid="$(jq -er '.metadata.uid | select(type == "string" and length > 0)' \
    <<<"$policy_json")" || return 1
  restore_network_policy_spec_is_exact "$policy_json" "$policy_uid" || return 1
  RESTORE_NETWORK_POLICY_UID="$policy_uid"
}

acquire_restore_network_policy() {
  local policy_json="" acquisition_status=0
  [[ "$RESTORE_NETWORK_POLICY_CREATED" == 0 &&
     -z "$RESTORE_NETWORK_POLICY_UID" ]] || return 2
  RESTORE_CHILD_PENDING_SIGNAL_STATUS=0
  trap 'restore_child_record_pending_signal 130' INT
  trap 'restore_child_record_pending_signal 143' TERM
  if policy_json="$(recovery_kubectl_mutate create -f - -o json)" &&
     capture_restore_network_policy_identity "$policy_json"; then
    RESTORE_NETWORK_POLICY_CREATED=1
  else
    RESTORE_NETWORK_POLICY_UID=""
    if recovery_require_operation_lock &&
       policy_json="$(recovery_kubectl get networkpolicy \
         "$RESTORE_NETWORK_POLICY" -n "$NAMESPACE" -o json)" &&
       capture_restore_network_policy_identity "$policy_json"; then
      # A failed create response is ambiguous. Adopt only the exact object
      # carrying this private operation token, lock UID and admitted spec.
      RESTORE_NETWORK_POLICY_CREATED=1
      REMOTE_RESTORE_STATE_RETAINED=1
    else
      RESTORE_NETWORK_POLICY_UID=""
      acquisition_status=1
    fi
  fi
  if [[ "$RESTORE_NETWORK_POLICY_CREATED" == 1 ]] &&
     ! recovery_require_operation_lock; then
    acquisition_status=1
  fi
  restore_child_finish_capability_boundary "$acquisition_status"
}

acquire_restore_pod() {
  local pod_json="" acquisition_status=0
  [[ "$RESTORE_POD_CREATED" == 0 && -z "$RESTORE_POD_UID" ]] || return 2
  RESTORE_CHILD_PENDING_SIGNAL_STATUS=0
  trap 'restore_child_record_pending_signal 130' INT
  trap 'restore_child_record_pending_signal 143' TERM
  if pod_json="$(recovery_kubectl_mutate create -f - -o json)" &&
     capture_restore_pod_identity "$pod_json"; then
    RESTORE_POD_CREATED=1
  else
    RESTORE_POD_UID=""
    if recovery_require_operation_lock &&
       pod_json="$(recovery_kubectl get pod "$RESTORE_POD" \
         -n "$NAMESPACE" -o json)" &&
       capture_restore_pod_identity "$pod_json"; then
      # Reconcile only an exact same-operation helper. Name alone grants no
      # ownership and therefore no cleanup authority.
      RESTORE_POD_CREATED=1
      REMOTE_RESTORE_STATE_RETAINED=1
    else
      RESTORE_POD_UID=""
      acquisition_status=1
    fi
  fi
  if [[ "$RESTORE_POD_CREATED" == 1 ]] &&
     ! recovery_require_operation_lock; then
    acquisition_status=1
  fi
  restore_child_finish_capability_boundary "$acquisition_status"
}

require_owned_restore_network_policy() {
  local policy_json current_uid
  [[ -n "$RESTORE_NETWORK_POLICY_UID" ]] || return 1
  policy_json="$(recovery_kubectl get networkpolicy "$RESTORE_NETWORK_POLICY" \
    -n "$NAMESPACE" -o json)" || return 1
  current_uid="$(jq -er '.metadata.uid | select(type == "string" and length > 0)' \
    <<<"$policy_json")" || return 1
  [[ "$current_uid" == "$RESTORE_NETWORK_POLICY_UID" ]] || return 1
  restore_network_policy_spec_is_exact "$policy_json"
}

cleanup_restore_pod() {
  if [[ "$RESTORE_POD_CREATED" != "1" ]]; then
    return 0
  fi
  recovery_require_cluster_identity || return 1
  recovery_require_pvc_identity ret-pvc || return 1
  recovery_require_operation_lock || return 1
  recovery_require_exact_pvc_consumers ret-pvc "$RESTORE_POD" || return 1
  require_owned_restore_pod || {
    printf 'Restore pod identity/spec changed; refusing to delete an unowned pod.\n' >&2
    return 1
  }
  if ! recovery_delete_namespaced_with_uid pod "$RESTORE_POD" \
    "$RESTORE_POD_UID" 180; then
    printf 'Could not delete the storage restore pod safely.\n' >&2
    return 1
  fi
  RESTORE_POD_CREATED=0
  RESTORE_POD_UID=""
  recovery_require_exact_pvc_consumers ret-pvc
}

cleanup_restore_network_policy() {
  if [[ "$RESTORE_NETWORK_POLICY_CREATED" != "1" ]]; then
    return 0
  fi
  recovery_require_operation_lock || return 1
  require_owned_restore_network_policy || {
    printf 'Restore NetworkPolicy identity/spec changed; refusing to delete it.\n' >&2
    return 1
  }
  if ! recovery_delete_namespaced_with_uid networkpolicy \
    "$RESTORE_NETWORK_POLICY" "$RESTORE_NETWORK_POLICY_UID" 60; then
    printf 'Could not delete the exact storage-helper NetworkPolicy safely.\n' >&2
    return 1
  fi
  RESTORE_NETWORK_POLICY_CREATED=0
  RESTORE_NETWORK_POLICY_UID=""
}

clear_stale_helper_resources() {
  local pod_json policy_json policies_json
  recovery_require_operation_lock || return 1
  RET_IMAGE="$(recovery_checkpoint_image_for_pair \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY" reticulum/reticulum \
    ghcr.io/yengalvez/reticulum)" || return 1
  RESTORE_POD="ret-storage-restore-${RECOVERY_OPERATION_ID:0:12}"
  RESTORE_NETWORK_POLICY="ret-storage-restore-deny-${RECOVERY_OPERATION_ID:0:12}"
  if pod_json="$(recovery_kubectl get pod "$RESTORE_POD" -n "$NAMESPACE" -o json 2>/dev/null)"; then
    RESTORE_POD_UID=""
    capture_restore_pod_identity "$pod_json" || {
      printf 'Stale helper pod is not bound to the exact retained operation.\n' >&2
      return 1
    }
    RESTORE_POD_CREATED=1
    recovery_require_exact_pvc_consumers ret-pvc "$RESTORE_POD" || return 1
    cleanup_restore_pod || return 1
  else
    recovery_require_exact_pvc_consumers ret-pvc || return 1
  fi
  if policy_json="$(recovery_kubectl get networkpolicy "$RESTORE_NETWORK_POLICY" \
    -n "$NAMESPACE" -o json 2>/dev/null)"; then
    RESTORE_NETWORK_POLICY_UID=""
    capture_restore_network_policy_identity "$policy_json" || {
      printf 'Stale helper NetworkPolicy is not bound to the exact retained operation.\n' >&2
      return 1
    }
    RESTORE_NETWORK_POLICY_CREATED=1
    cleanup_restore_network_policy || return 1
  else
    policies_json="$(recovery_kubectl get networkpolicy -n "$NAMESPACE" -o json)" || return 1
    jq -e --arg name "$RESTORE_NETWORK_POLICY" \
      '[.items[] | select(.metadata.name == $name)] | length == 0' \
      >/dev/null <<<"$policies_json" || return 1
  fi
  recovery_require_operation_lock
}

cleanup_local() {
  local cleanup_status=0
  if [[ -n "$VALIDATION_DIR_PRIVATE_TOKEN" &&
        "$VALIDATION_DIR_RETIRED" == 0 ]]; then
    if [[ "$VALIDATION_DIR_CLEANUP_ATTEMPTED" == 1 ]]; then
      cleanup_status=1
    else
      VALIDATION_DIR_CLEANUP_ATTEMPTED=1
      if recovery_cleanup_private_directory "$VALIDATION_DIR_PRIVATE_TOKEN" \
          f:archive-paths f:archive-verbose \
          f:blob-uuids f:meta-uuids f:db-active-uuids \
          f:quiesced-db-active-uuids \
          f:quiesced-database-contract.json \
          f:restored-blob-uuids f:restored-meta-uuids f:restored-paths \
          f:monitor-stop f:monitor-failure f:monitor-progress \
          f:monitor-progress.next \
          f:runner-watch-stop f:runner-watch-failure f:runner-watch-ready \
          f:runner-watch-progress f:runner-watch-progress.next; then
        VALIDATION_DIR_RETIRED=1
        VALIDATION_DIR_PRIVATE_TOKEN=""
        VALIDATION_DIR=""
      else
        printf 'Private storage-restore validation cleanup failed closed; any exact empty orphan or replacement was preserved.\n' >&2
        cleanup_status=1
      fi
    fi
  elif [[ -n "$VALIDATION_DIR" && "$VALIDATION_DIR_RETIRED" == 0 ]]; then
    printf 'Private storage-restore validation directory has no cleanup identity; preserving its empty orphan.\n' >&2
    cleanup_status=1
  fi
  reactivation_cleanup_temp_paths
  recovery_cleanup_materialized_checkpoint || cleanup_status=1
  [[ "$cleanup_status" == 0 ]]
}

final_cleanup() {
  local status="$?"
  local cleanup_status=0
  local pod_cleanup_status=0
  local retain_remote_restore_state=0
  trap - EXIT ERR
  trap '' INT TERM
  if ! stop_pvc_monitor; then
    cleanup_status=1
  fi
  if [[ "$RUNNER_WATCH_PID" =~ ^[1-9][0-9]*$ ]]; then
    recovery_discard_no_managed_bot_runner_watch \
      "$RUNNER_WATCH_STOP" "$RUNNER_WATCH_PID" \
      "$RUNNER_WATCH_START_IDENTITY"
    RUNNER_WATCH_PID=""
    RUNNER_WATCH_START_IDENTITY=""
  fi
  RUNNER_WATCH_START_IDENTITY=""
  if [[ "$status" -ne 0 &&
        ( "$PVC_MUTATION_STREAM_ARMED" == 1 ||
          "$REMOTE_RESTORE_STATE_RETAINED" == 1 ) ]]; then
    retain_remote_restore_state=1
    printf 'PVC mutation may be partial; retaining the exact restore helper, deny-all NetworkPolicy and operation lock for fail-closed inspection.\n' >&2
  fi
  if [[ "$retain_remote_restore_state" == 0 ]]; then
    if ! cleanup_restore_pod; then
      printf 'The restore pod could not be cleaned up; inspect the pinned target before continuing.\n' >&2
      cleanup_status=1
      pod_cleanup_status=1
    fi
    if [[ "$pod_cleanup_status" == 0 ]] && ! cleanup_restore_network_policy; then
      printf 'The deny-all helper NetworkPolicy remains for fail-closed inspection.\n' >&2
      cleanup_status=1
    fi
  fi
  cleanup_local || cleanup_status=1
  if [[ "$status" -eq 0 && "$cleanup_status" -ne 0 ]]; then
    status=1
  fi
  exit "$status"
}

storage_restore_failed() {
  if [[ "$RESTORE_PHASE" == "quiescing" || "$RESTORE_PHASE" == "restoring" ]]; then
    printf 'Storage restore stopped. All DB consumers remain at zero for safety.\n' >&2
  fi
}

storage_restore_interrupted() {
  local status="$1"
  if [[ "$RESTORE_PHASE" == "quiescing" || "$RESTORE_PHASE" == "restoring" ]]; then
    printf 'Storage restore interrupted. All DB consumers remain at zero for safety.\n' >&2
  fi
  exit "$status"
}

restore_child_record_pending_signal() {
  local status="$1"
  [[ "$BASH_SUBSHELL" == "$RESTORE_CHILD_SIGNAL_OWNER_SUBSHELL" ]] || return 0
  [[ "$status" == 130 || "$status" == 143 ]] || return 2
  if [[ "$RESTORE_CHILD_PENDING_SIGNAL_STATUS" == 0 ]]; then
    RESTORE_CHILD_PENDING_SIGNAL_STATUS="$status"
    # Keep the first cooperative interruption pending until a remotely created
    # object has either armed an exact UID capability or failed reconciliation.
    trap '' INT TERM
  fi
}

restore_child_signal_traps() {
  trap 'storage_restore_interrupted 130' INT
  trap 'storage_restore_interrupted 143' TERM
}

restore_child_finish_capability_boundary() {
  local acquisition_status="$1" pending_signal_status
  restore_child_signal_traps
  pending_signal_status="$RESTORE_CHILD_PENDING_SIGNAL_STATUS"
  RESTORE_CHILD_PENDING_SIGNAL_STATUS=0
  if [[ "$pending_signal_status" != 0 ]]; then
    storage_restore_interrupted "$pending_signal_status"
  fi
  [[ "$acquisition_status" == 0 ]]
}

trap final_cleanup EXIT
trap storage_restore_failed ERR
trap 'storage_restore_interrupted 130' INT
trap 'storage_restore_interrupted 143' TERM

# Verify the exact allowlisted checkpoint, copy both halves into private files,
# rehash them, and jointly validate the copied pair before contacting Kubernetes.
recovery_materialize_checkpoint "$ARCHIVE_PATH" "$SCRIPT_DIR/validate-checkpoint.sh"
if ! reactivation_snapshot_private_file \
  VALUES_SOURCE_FILE "$VALUES_INPUT_FILE" restore-values; then
  printf 'Could not bind a private immutable restore values snapshot.\n' >&2
  exit 1
fi
if [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == durable-v2 ]]; then
  if [[ -z "$CUTOVER_KEY_INPUT_FILE" ]] ||
     ! reactivation_snapshot_private_file \
       CUTOVER_KEY_SNAPSHOT "$CUTOVER_KEY_INPUT_FILE" restore-cutover-key; then
    printf 'A private PROCESS_LOCAL_CUTOVER_KEY_PATH is required for durable preflight.\n' >&2
    exit 1
  fi
  PROCESS_LOCAL_CUTOVER_KEY_PATH="$CUTOVER_KEY_SNAPSHOT"
  export PROCESS_LOCAL_CUTOVER_KEY_PATH
fi

if [[ "$CLEAR_STALE_HELPER" == "1" ]]; then
  recovery_adopt_parent_operation_serialization \
    "$PARENT_LEASE_HOLDER" "$PARENT_LEASE_UID" \
    "$PARENT_PROCESS_PID" "$PARENT_PROCESS_START_IDENTITY"
  unset YENHUBS_PARENT_LEASE_HOLDER YENHUBS_PARENT_LEASE_UID \
    YENHUBS_PARENT_PROCESS_PID YENHUBS_PARENT_PROCESS_START_IDENTITY
  recovery_require_cluster_identity
  recovery_require_pvc_identity ret-pvc
  clear_stale_helper_resources
  printf 'Exact stale storage helper resources cleared; workloads remain quiescent.\n'
  exit 0
fi

VALIDATION_SETUP_STATUS=0
RESTORE_CHILD_PENDING_SIGNAL_STATUS=0
trap 'restore_child_record_pending_signal 130' INT
trap 'restore_child_record_pending_signal 143' TERM
if ! VALIDATION_DIR="$(
    trap '' INT TERM
    mktemp -d "${TMPDIR:-/tmp}/yenhubs-storage-restore.XXXXXX"
  )"; then
  VALIDATION_SETUP_STATUS=1
elif ! VALIDATION_DIR_PRIVATE_TOKEN="$(
    trap '' INT TERM
    recovery_capture_private_directory_token "$VALIDATION_DIR"
  )"; then
  VALIDATION_SETUP_STATUS=1
fi
if ! restore_child_finish_capability_boundary "$VALIDATION_SETUP_STATUS"; then
  printf 'Could not bind the private storage-restore validation directory identity; any empty orphan was preserved.\n' >&2
  exit 1
fi
ARCHIVE_PATHS="$VALIDATION_DIR/archive-paths"
ARCHIVE_VERBOSE="$VALIDATION_DIR/archive-verbose"
ARCHIVE_BLOB_UUIDS="$VALIDATION_DIR/blob-uuids"
ARCHIVE_META_UUIDS="$VALIDATION_DIR/meta-uuids"
DB_ACTIVE_UUIDS="$VALIDATION_DIR/db-active-uuids"
QUIESCED_DB_ACTIVE_UUIDS="$VALIDATION_DIR/quiesced-db-active-uuids"
QUIESCED_DATABASE_CONTRACT="$VALIDATION_DIR/quiesced-database-contract.json"
RESTORED_BLOB_UUIDS="$VALIDATION_DIR/restored-blob-uuids"
RESTORED_META_UUIDS="$VALIDATION_DIR/restored-meta-uuids"
RESTORED_PATHS="$VALIDATION_DIR/restored-paths"
PVC_MONITOR_STOP="$VALIDATION_DIR/monitor-stop"
PVC_MONITOR_FAILURE="$VALIDATION_DIR/monitor-failure"
PVC_MONITOR_PROGRESS="$VALIDATION_DIR/monitor-progress"
RUNNER_WATCH_STOP="$VALIDATION_DIR/runner-watch-stop"
RUNNER_WATCH_FAILURE="$VALIDATION_DIR/runner-watch-failure"
RUNNER_WATCH_READY="$VALIDATION_DIR/runner-watch-ready"
RUNNER_WATCH_PROGRESS="$VALIDATION_DIR/runner-watch-progress"
: >"$PVC_MONITOR_FAILURE"
: >"$PVC_MONITOR_PROGRESS"
: >"$DB_ACTIVE_UUIDS"
: >"$QUIESCED_DB_ACTIVE_UUIDS"
: >"$RESTORED_BLOB_UUIDS"
: >"$RESTORED_META_UUIDS"
chmod 600 "$PVC_MONITOR_FAILURE" "$PVC_MONITOR_PROGRESS" "$DB_ACTIVE_UUIDS" \
  "$QUIESCED_DB_ACTIVE_UUIDS" \
  "$RESTORED_BLOB_UUIDS" "$RESTORED_META_UUIDS"

gzip -t "$RECOVERY_STORAGE_COPY"
gzip -cd "$RECOVERY_STORAGE_COPY" | tar -tf - >"$ARCHIVE_PATHS"
gzip -cd "$RECOVERY_STORAGE_COPY" | tar -tvf - >"$ARCHIVE_VERBOSE"

if awk '
  substr($0, 1, 1) != "-" && substr($0, 1, 1) != "d" { unsafe=1 }
  END { exit unsafe ? 0 : 1 }
' "$ARCHIVE_VERBOSE"; then
  printf 'Archive contains links or unsupported entry types.\n' >&2
  exit 1
fi
if ! recovery_storage_paths_file_is_exact "$ARCHIVE_PATHS"; then
  printf 'Archive contains unsafe paths or files outside the owned-file contract.\n' >&2
  exit 1
fi
recovery_extract_storage_uuids "$ARCHIVE_PATHS" blob | LC_ALL=C sort >"$ARCHIVE_BLOB_UUIDS"
recovery_extract_storage_uuids "$ARCHIVE_PATHS" meta.json | LC_ALL=C sort >"$ARCHIVE_META_UUIDS"
ARCHIVE_BLOB_COUNT="$(wc -l <"$ARCHIVE_BLOB_UUIDS" | tr -d ' ')"
ARCHIVE_META_COUNT="$(wc -l <"$ARCHIVE_META_UUIDS" | tr -d ' ')"
ARCHIVE_UNIQUE_BLOB_COUNT="$(LC_ALL=C sort -u "$ARCHIVE_BLOB_UUIDS" | wc -l | tr -d ' ')"
ARCHIVE_UNIQUE_META_COUNT="$(LC_ALL=C sort -u "$ARCHIVE_META_UUIDS" | wc -l | tr -d ' ')"
if [[ "$ARCHIVE_BLOB_COUNT" -eq 0 || "$ARCHIVE_BLOB_COUNT" != "$ARCHIVE_META_COUNT" ||
      "$ARCHIVE_BLOB_COUNT" != "$ARCHIVE_UNIQUE_BLOB_COUNT" ||
      "$ARCHIVE_META_COUNT" != "$ARCHIVE_UNIQUE_META_COUNT" ]] ||
   ! cmp -s "$ARCHIVE_BLOB_UUIDS" "$ARCHIVE_META_UUIDS"; then
  printf 'Invalid storage archive: blobs=%s metadata=%s.\n' \
    "$ARCHIVE_BLOB_COUNT" "$ARCHIVE_META_COUNT" >&2
  exit 1
fi
if awk '
  $0 !~ /^[A-Za-z0-9._-]+$/ { unsafe=1 }
  END { exit unsafe ? 0 : 1 }
' "$ARCHIVE_BLOB_UUIDS"; then
  printf 'Archive contains an unsafe owned-file UUID.\n' >&2
  exit 1
fi

recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
recovery_require_restore_target_binding
if ! recovery_require_live_runner_control_plane_matches_checkpoint \
  "$RECOVERY_DEPLOYMENT_INVENTORY_COPY"; then
  printf 'The live runner control-plane identity does not match the checkpoint inventory.\n' >&2
  exit 1
fi
if ! recovery_require_live_images_match_checkpoint \
  "$RECOVERY_DEPLOYMENT_INVENTORY_COPY"; then
  printf 'The live workload image inventory does not exactly match the checkpoint.\n' >&2
  exit 1
fi
if [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == legacy-absent ]] &&
   ! recovery_require_checkpoint_generation_matches_live \
     "$RECOVERY_DEPLOYMENT_INVENTORY_COPY" "$VALUES_SOURCE_FILE"; then
  printf 'The live process-local runner generation does not match the legacy checkpoint.\n' >&2
  exit 1
fi
if [[ "$COORDINATED" != 1 ]]; then
  recovery_require_restore_epoch_candidate \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY" "$VALUES_SOURCE_FILE"
fi
recovery_wait_for_deployment_rollout pgsql 300
PGSQL_PODS_JSON="$(recovery_kubectl get pod -n "$NAMESPACE" -l app=pgsql -o json)"
if ! PGSQL_POD_INFO="$(recovery_exact_ready_deployment_pod_info \
  "$PGSQL_PODS_JSON" pgsql pgsql)"; then
  printf 'Exactly one owned Ready PostgreSQL pod is required in namespace %s.\n' \
    "$NAMESPACE" >&2
  exit 1
fi
IFS=$'\t' read -r PGSQL_POD PGSQL_POD_UID PGSQL_DEPLOYMENT_UID <<<"$PGSQL_POD_INFO"
require_pgsql_source() {
  local current_pods current_info current_name current_uid current_deployment_uid
  local current_pod
  current_pods="$(recovery_kubectl get pod -n "$NAMESPACE" -l app=pgsql -o json)" ||
    return 1
  current_info="$(recovery_exact_ready_deployment_pod_info \
    "$current_pods" pgsql pgsql)" || return 1
  IFS=$'\t' read -r current_name current_uid current_deployment_uid \
    <<<"$current_info"
  [[ "$current_name" == "$PGSQL_POD" && "$current_uid" == "$PGSQL_POD_UID" &&
     "$current_deployment_uid" == "$PGSQL_DEPLOYMENT_UID" ]] || return 1
  current_pod="$(jq -cer --arg uid "$current_uid" '
    [.items[] | select(.metadata.uid == $uid)] | select(length == 1) | .[0]
  ' <<<"$current_pods")" || return 1
  recovery_require_pod_identity "$PGSQL_POD" "$PGSQL_POD_UID" &&
    recovery_require_pod_deployment_ownership \
      "$current_pod" pgsql "$PGSQL_DEPLOYMENT_UID"
}
# Expansion is intentionally deferred to the PostgreSQL container.
# shellcheck disable=SC2016
require_pgsql_source
if ! recovery_kubectl exec -n "$NAMESPACE" "$PGSQL_POD" -- sh -ec \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d retdb -Atc "select owned_file_uuid from ret0.owned_files where state = '\''active'\'' order by owned_file_uuid"' \
  | tr -d '\r' | LC_ALL=C sort >"$DB_ACTIVE_UUIDS"; then
  printf 'Could not query exact active owned-file UUIDs.\n' >&2
  exit 1
fi
DB_ACTIVE_COUNT="$(wc -l <"$DB_ACTIVE_UUIDS" | tr -d ' ')"
DB_ACTIVE_UNIQUE_COUNT="$(LC_ALL=C sort -u "$DB_ACTIVE_UUIDS" | wc -l | tr -d ' ')"
if [[ "$DB_ACTIVE_COUNT" -eq 0 || "$DB_ACTIVE_COUNT" != "$DB_ACTIVE_UNIQUE_COUNT" ]]; then
  printf 'Database active owned-file baseline is empty or contains duplicate UUIDs.\n' >&2
  exit 1
fi
if awk '
  $0 !~ /^[A-Za-z0-9._-]+$/ { unsafe=1 }
  END { exit unsafe ? 0 : 1 }
' "$DB_ACTIVE_UUIDS"; then
  printf 'Database returned an unsafe active owned-file UUID.\n' >&2
  exit 1
fi
if ! MISSING_ACTIVE_STORAGE="$(comm -23 "$DB_ACTIVE_UUIDS" "$ARCHIVE_BLOB_UUIDS")"; then
  printf 'Could not compare database and archive UUIDs.\n' >&2
  exit 1
fi
if [[ -n "$MISSING_ACTIVE_STORAGE" ]]; then
  printf 'Archive/database mismatch: at least one active DB file is absent from storage.\n' >&2
  exit 1
fi

if [[ "$PREFLIGHT" == "1" ]]; then
  recovery_require_cluster_identity
  recovery_require_pvc_identity ret-pvc
  recovery_require_restore_target_binding
  recovery_require_live_runner_control_plane_matches_checkpoint \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY"
  recovery_require_live_images_match_checkpoint \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY"
  require_pgsql_source
  if [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == legacy-absent ]]; then
    recovery_require_checkpoint_generation_matches_live \
      "$RECOVERY_DEPLOYMENT_INVENTORY_COPY" "$VALUES_SOURCE_FILE"
  fi
  if [[ "$COORDINATED" != 1 ]]; then
    recovery_require_restore_epoch_candidate \
      "$RECOVERY_DEPLOYMENT_INVENTORY_COPY" "$VALUES_SOURCE_FILE"
  fi
  if [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == durable-v2 ]]; then
    recovery_verify_runner_cutover_evidence_live \
      "$VALUES_SOURCE_FILE" "$RECOVERY_RUNNER_CUTOVER_EVIDENCE_COPY" \
      "$RECOVERY_DEPLOYMENT_INVENTORY_COPY" dormant "" active-source
  fi
  printf 'Storage restore preflight passed (no restore performed): source=%s checkpoint=%s dump_sha256=%s storage_sha256=%s active_files=%s complete_pairs=%s deferred_pairs=%s context=%s namespace=%s namespace_uid=%s pvc=ret-pvc pvc_uid=%s\n' \
    "$ARCHIVE_PATH" "$RECOVERY_CHECKPOINT_STAMP" "$RECOVERY_DUMP_SHA256" \
    "$RECOVERY_STORAGE_SHA256" "$DB_ACTIVE_COUNT" "$ARCHIVE_BLOB_COUNT" \
    "$((ARCHIVE_BLOB_COUNT - DB_ACTIVE_COUNT))" "$EXPECTED_KUBE_CONTEXT" \
    "$NAMESPACE" "$RECOVERY_NAMESPACE_UID" "$RECOVERY_PVC_UID"
  exit 0
fi

recovery_require_confirmation CONFIRM_RESTORE_STORAGE ret-pvc "$RECOVERY_PVC_UID"
recovery_adopt_parent_operation_serialization \
  "$PARENT_LEASE_HOLDER" "$PARENT_LEASE_UID" \
  "$PARENT_PROCESS_PID" "$PARENT_PROCESS_START_IDENTITY"
unset YENHUBS_PARENT_LEASE_HOLDER YENHUBS_PARENT_LEASE_UID \
  YENHUBS_PARENT_PROCESS_PID YENHUBS_PARENT_PROCESS_START_IDENTITY
if [[ -z "${RECOVERY_CONSUMER_CONTRACT_JSON:-}" ]] ||
   ! recovery_consumer_contract_is_acceptable "$RECOVERY_CONSUMER_CONTRACT_JSON" ||
   [[ "$(jq -r '.operation_id' <<<"$RECOVERY_CONSUMER_CONTRACT_JSON")" != \
      "${RECOVERY_OPERATION_ID:-}" ]] ||
   ! recovery_require_operation_lock; then
  printf 'Destructive storage restore lacks the exact parent lock/consumer contract.\n' >&2
  exit 1
fi

initialize_parent_writer_guard() {
  local runtime_generation="$1"
  [[ "$runtime_generation" == legacy-absent ||
     "$runtime_generation" == durable-v2 ]] || return 2
  if [[ "$(recovery_monitor_authority_sha256_for_ready \
        "$PARENT_WRITER_MONITOR_READY_PATH" 2>/dev/null || :)" != \
        "$PARENT_WRITER_MONITOR_AUTHORITY_SHA256" ]] ||
     ! recovery_require_checkpoint_writer_monitor_healthy \
       "$PARENT_WRITER_MONITOR_CONTRACT_PATH" \
       "$PARENT_WRITER_MONITOR_CONTRACT_SHA256" \
       "$PARENT_WRITER_MONITOR_BASELINE_PATH" \
       "$PARENT_WRITER_MONITOR_BASELINE_SHA256" \
       "$PARENT_WRITER_MONITOR_FAILURE_PATH" \
       "$PARENT_WRITER_MONITOR_READY_PATH" \
       "$PARENT_WRITER_MONITOR_PID" \
       "$PARENT_WRITER_MONITOR_START_IDENTITY" "$runtime_generation" \
       checkpoint-restore ||
     ! recovery_stream_guard_progress_value \
       "$PARENT_WRITER_MONITOR_PROGRESS_PATH" \
       "$PARENT_WRITER_MONITOR_AUTHORITY_SHA256" >/dev/null ||
     ! PARENT_WRITER_MONITOR_MAX_STALE_SECONDS="$(
       recovery_stream_guard_max_stale_seconds
     )"; then
    return 1
  fi
  PARENT_WRITER_STREAM_GUARD_ARGS=(
    --guard-process-capability checkpoint-writer-monitor
    "$PARENT_WRITER_MONITOR_PID"
    "$PARENT_WRITER_MONITOR_START_IDENTITY"
    "$PARENT_WRITER_MONITOR_FAILURE_PATH"
    "$PARENT_WRITER_MONITOR_READY_PATH"
    "$PARENT_WRITER_MONITOR_PROGRESS_PATH"
    "${PARENT_WRITER_MONITOR_READY_PATH}.authority.json"
    "$PARENT_WRITER_MONITOR_AUTHORITY_SHA256"
    "$PARENT_WRITER_MONITOR_MAX_STALE_SECONDS"
  )
}

initialize_parent_restore_guards() {
  [[ "${RECOVERY_OPERATION_OWNER:-}" == checkpoint-restore ]] || return 1
  case "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" in
    legacy-absent)
      if [[ -n "$PARENT_RECOVERY_OPERATION_FENCE_ACTIVE_IDENTITY" ||
            -n "$PARENT_DURABLE_FENCE_BASELINE_PATH" ||
            -n "$PARENT_DURABLE_FENCE_BASELINE_SHA256" ||
            -n "$PARENT_DURABLE_MONITOR_PID" ||
            -n "$PARENT_DURABLE_MONITOR_START_IDENTITY" ||
            -n "$PARENT_DURABLE_MONITOR_FAILURE_PATH" ||
            -n "$PARENT_DURABLE_MONITOR_READY_PATH" ||
            -n "$PARENT_DURABLE_MONITOR_PROGRESS_PATH" ||
            -n "$PARENT_DURABLE_MONITOR_CAPABILITY_SHA256" ||
            -n "$PARENT_DURABLE_MONITOR_AUTHORITY_SHA256" ]] ||
         ! initialize_parent_writer_guard legacy-absent; then
        printf 'Legacy storage restore requires one live parent writer guard and rejects durable fence capabilities.\n' >&2
        return 1
      fi
      ;;
    durable-v2)
      if [[ -z "$PARENT_RECOVERY_OPERATION_FENCE_ACTIVE_IDENTITY" ||
            "$PARENT_WRITER_MONITOR_PID" == "$PARENT_DURABLE_MONITOR_PID" ||
            "$(recovery_monitor_authority_sha256_for_ready \
              "$PARENT_DURABLE_MONITOR_READY_PATH" 2>/dev/null || :)" != \
              "$PARENT_DURABLE_MONITOR_AUTHORITY_SHA256" ]] ||
         ! initialize_parent_writer_guard durable-v2 ||
         ! recovery_require_durable_runner_quiescence_monitor_healthy \
           "$PARENT_DURABLE_FENCE_BASELINE_PATH" \
           "$PARENT_DURABLE_FENCE_BASELINE_SHA256" \
           "$PARENT_WRITER_MONITOR_BASELINE_PATH" \
           "$PARENT_WRITER_MONITOR_BASELINE_SHA256" \
           "$PARENT_DURABLE_MONITOR_FAILURE_PATH" \
           "$PARENT_DURABLE_MONITOR_READY_PATH" \
           "$PARENT_DURABLE_MONITOR_PROGRESS_PATH" \
           "$PARENT_DURABLE_MONITOR_PID" \
           "$PARENT_DURABLE_MONITOR_START_IDENTITY" \
           "$PARENT_DURABLE_MONITOR_CAPABILITY_SHA256" checkpoint-restore ||
         ! recovery_stream_guard_progress_value \
           "$PARENT_DURABLE_MONITOR_PROGRESS_PATH" \
           "$PARENT_DURABLE_MONITOR_AUTHORITY_SHA256" >/dev/null ||
         ! PARENT_DURABLE_MONITOR_MAX_STALE_SECONDS="$(
           recovery_stream_guard_max_stale_seconds
         )"; then
        printf 'Durable storage restore requires both live parent monitor guards.\n' >&2
        return 1
      fi
      PARENT_DURABLE_STREAM_GUARD_ARGS=(
        --guard-process-capability durable-runner-quiescence-monitor
        "$PARENT_DURABLE_MONITOR_PID"
        "$PARENT_DURABLE_MONITOR_START_IDENTITY"
        "$PARENT_DURABLE_MONITOR_FAILURE_PATH"
        "$PARENT_DURABLE_MONITOR_READY_PATH"
        "$PARENT_DURABLE_MONITOR_PROGRESS_PATH"
        "${PARENT_DURABLE_MONITOR_READY_PATH}.authority.json"
        "$PARENT_DURABLE_MONITOR_AUTHORITY_SHA256"
        "$PARENT_DURABLE_MONITOR_MAX_STALE_SECONDS"
      )
      ;;
    *)
      return 1
      ;;
  esac
}

require_parent_restore_guards() {
  [[ "${RECOVERY_OPERATION_OWNER:-}" == checkpoint-restore ]] || return 1
  [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == legacy-absent ||
     "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == durable-v2 ]] || return 1
  [[ "$(recovery_monitor_authority_sha256_for_ready \
       "$PARENT_WRITER_MONITOR_READY_PATH" 2>/dev/null || :)" == \
       "$PARENT_WRITER_MONITOR_AUTHORITY_SHA256" ]] || return 1
  recovery_require_checkpoint_writer_monitor_healthy \
    "$PARENT_WRITER_MONITOR_CONTRACT_PATH" \
    "$PARENT_WRITER_MONITOR_CONTRACT_SHA256" \
    "$PARENT_WRITER_MONITOR_BASELINE_PATH" \
    "$PARENT_WRITER_MONITOR_BASELINE_SHA256" \
    "$PARENT_WRITER_MONITOR_FAILURE_PATH" \
    "$PARENT_WRITER_MONITOR_READY_PATH" \
    "$PARENT_WRITER_MONITOR_PID" \
    "$PARENT_WRITER_MONITOR_START_IDENTITY" \
    "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" \
    checkpoint-restore || return 1
  recovery_stream_guard_progress_value \
    "$PARENT_WRITER_MONITOR_PROGRESS_PATH" \
    "$PARENT_WRITER_MONITOR_AUTHORITY_SHA256" >/dev/null || return 1
  if [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == legacy-absent ]]; then
    [[ -z "$PARENT_RECOVERY_OPERATION_FENCE_ACTIVE_IDENTITY" &&
       -z "$PARENT_DURABLE_FENCE_BASELINE_PATH" &&
       -z "$PARENT_DURABLE_FENCE_BASELINE_SHA256" &&
       -z "$PARENT_DURABLE_MONITOR_PID" &&
       -z "$PARENT_DURABLE_MONITOR_START_IDENTITY" &&
       -z "$PARENT_DURABLE_MONITOR_FAILURE_PATH" &&
       -z "$PARENT_DURABLE_MONITOR_READY_PATH" &&
       -z "$PARENT_DURABLE_MONITOR_PROGRESS_PATH" &&
       -z "$PARENT_DURABLE_MONITOR_CAPABILITY_SHA256" &&
       -z "$PARENT_DURABLE_MONITOR_AUTHORITY_SHA256" ]]
    return
  fi
  [[ "$PARENT_WRITER_MONITOR_PID" != "$PARENT_DURABLE_MONITOR_PID" &&
     "$(recovery_monitor_authority_sha256_for_ready \
       "$PARENT_DURABLE_MONITOR_READY_PATH" 2>/dev/null || :)" == \
       "$PARENT_DURABLE_MONITOR_AUTHORITY_SHA256" ]] || return 1
  recovery_require_durable_runner_quiescence_monitor_healthy \
    "$PARENT_DURABLE_FENCE_BASELINE_PATH" \
    "$PARENT_DURABLE_FENCE_BASELINE_SHA256" \
    "$PARENT_WRITER_MONITOR_BASELINE_PATH" \
    "$PARENT_WRITER_MONITOR_BASELINE_SHA256" \
    "$PARENT_DURABLE_MONITOR_FAILURE_PATH" \
    "$PARENT_DURABLE_MONITOR_READY_PATH" \
    "$PARENT_DURABLE_MONITOR_PROGRESS_PATH" \
    "$PARENT_DURABLE_MONITOR_PID" \
    "$PARENT_DURABLE_MONITOR_START_IDENTITY" \
    "$PARENT_DURABLE_MONITOR_CAPABILITY_SHA256" checkpoint-restore || return 1
  recovery_stream_guard_progress_value \
    "$PARENT_DURABLE_MONITOR_PROGRESS_PATH" \
    "$PARENT_DURABLE_MONITOR_AUTHORITY_SHA256" >/dev/null || return 1
  recovery_require_checkpoint_runner_quiescence_exact durable-v2 \
    "$PARENT_DURABLE_FENCE_BASELINE_PATH" \
    "$PARENT_DURABLE_FENCE_BASELINE_SHA256" || return 1
  recovery_require_recovery_operation_fence_state active \
    "$PARENT_RECOVERY_OPERATION_FENCE_ACTIVE_IDENTITY"
}

initialize_parent_restore_guards || {
  printf 'Destructive storage restore lacks the exact parent monitor capabilities.\n' >&2
  exit 1
}
RESTORE_POD="ret-storage-restore-${RECOVERY_OPERATION_ID:0:12}"
RESTORE_NETWORK_POLICY="ret-storage-restore-deny-${RECOVERY_OPERATION_ID:0:12}"

RESTORE_DEPLOYMENTS=()
DEPLOYMENT_SELECTORS=()
DEPLOYMENT_UIDS=()
DEPLOYMENT_FINGERPRINTS=()
RET_IMAGE="$(recovery_checkpoint_image_for_pair \
  "$RECOVERY_DEPLOYMENT_INVENTORY_COPY" reticulum/reticulum \
  ghcr.io/yengalvez/reticulum)" || {
  printf 'The checksummed inventory does not bind the trusted Reticulum helper image.\n' >&2
  exit 1
}
for deployment in "${DB_CONSUMERS[@]}"; do
  expected_entry="$(jq -cer --arg name "$deployment" \
    '[.consumers[] | select(.name == $name)] | select(length == 1) | .[0]' \
    <<<"$RECOVERY_CONSUMER_CONTRACT_JSON")" || exit 1
  deployment_uid="$(jq -r '.uid' <<<"$expected_entry")"
  initial_resource_version="$(jq -r '.initial_resource_version' <<<"$expected_entry")"
  original_replicas="$(jq -r '.original_replicas' <<<"$expected_entry")"
  deployment_selector="$(jq -r '.selector' <<<"$expected_entry")"
  deployment_fingerprint="$(jq -r '.fingerprint' <<<"$expected_entry")"
  deployment_contract="$(recovery_capture_deployment_contract "$deployment")" || exit 1
  IFS=$'\t' read -r current_uid current_resource_version replica_count \
    current_selector current_fingerprint <<<"$deployment_contract"
  [[ "$current_uid" == "$deployment_uid" &&
     "$current_selector" == "$deployment_selector" &&
     "$current_fingerprint" == "$deployment_fingerprint" ]] || {
    printf 'Post-lock consumer contract changed before storage quiescence: %s.\n' \
      "$deployment" >&2
    exit 1
  }
  if [[ "$replica_count" == "$original_replicas" ]]; then
    [[ "$current_resource_version" == "$initial_resource_version" ]] || {
      printf 'Consumer resourceVersion changed before storage quiescence: %s.\n' \
        "$deployment" >&2
      exit 1
    }
    recovery_scale_deployment_exact "$deployment" "$deployment_uid" \
      "$current_resource_version" "$replica_count" 0 "$deployment_selector" \
      "$deployment_fingerprint" >/dev/null
  elif [[ "$replica_count" != 0 ]]; then
    printf 'Consumer has neither its post-lock replica count nor zero: %s.\n' \
      "$deployment" >&2
    exit 1
  fi
  if [[ "$deployment" == "reticulum" ]]; then
    live_ret_image="$(recovery_kubectl get deployment reticulum -n "$NAMESPACE" -o json | jq -r '
      [.spec.template.spec.containers[] | select(.name == "reticulum") | .image] |
      if length == 1 then .[0] else empty end
    ')"
    [[ "$live_ret_image" == "$RET_IMAGE" ]] || {
      printf 'Live Reticulum image differs from the checksummed checkpoint inventory.\n' >&2
      exit 1
    }
  fi
  RESTORE_DEPLOYMENTS+=("$deployment")
  DEPLOYMENT_SELECTORS+=("$deployment_selector")
  DEPLOYMENT_UIDS+=("$deployment_uid")
  DEPLOYMENT_FINGERPRINTS+=("$deployment_fingerprint")
done

RESTORE_PHASE="quiescing"
# Revalidate both identities immediately before the first mutation.
recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
recovery_require_operation_lock
for index in "${!RESTORE_DEPLOYMENTS[@]}"; do
  recovery_require_operation_lock
  recovery_wait_for_no_pods "app=${DEPLOYMENT_SELECTORS[$index]}" \
    "deployment/${RESTORE_DEPLOYMENTS[$index]}" 180s
  recovery_require_operation_lock
  recovery_require_consumer_contract_entry "$RECOVERY_CONSUMER_CONTRACT_JSON" \
    "${RESTORE_DEPLOYMENTS[$index]}" 0
done
initialize_runner_quiescence
recovery_require_exact_pvc_consumers ret-pvc

# The driver already restored this exact DB contract. Recheck it and the full
# active UUID set only after every consumer is stopped, immediately before any
# PVC write. This closes the window between the read-only preflight query and
# storage extraction even if the child is invoked incorrectly outside the
# driver.
recovery_require_operation_lock
require_runner_quiescence
require_pgsql_source
if ! recovery_capture_live_database_contract "$PGSQL_POD" "$QUIESCED_DATABASE_CONTRACT" ||
   ! recovery_database_contracts_match \
     "$RECOVERY_DATABASE_CONTRACT_COPY" "$QUIESCED_DATABASE_CONTRACT"; then
  printf 'Quiesced database does not match the checksummed checkpoint contract.\n' >&2
  exit 1
fi
# Expansion is intentionally deferred to the PostgreSQL container.
# shellcheck disable=SC2016
recovery_require_operation_lock
require_pgsql_source
if ! recovery_kubectl exec -n "$NAMESPACE" "$PGSQL_POD" -- sh -ec \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d retdb -Atc "select owned_file_uuid from ret0.owned_files where state = '\''active'\'' order by owned_file_uuid"' \
  | tr -d '\r' | LC_ALL=C sort >"$QUIESCED_DB_ACTIVE_UUIDS"; then
  printf 'Could not recheck active owned-file UUIDs after quiescing.\n' >&2
  exit 1
fi
if ! cmp -s "$DB_ACTIVE_UUIDS" "$QUIESCED_DB_ACTIVE_UUIDS"; then
  printf 'Active owned-file UUIDs changed before storage extraction.\n' >&2
  exit 1
fi

# Revalidate again immediately before creating the only pod allowed to mount
# ret-pvc during the restore.
recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
recovery_require_operation_lock
require_runner_quiescence
recovery_require_exact_pvc_consumers ret-pvc
start_runner_watch
# The deny-all policy is create-only and must be admitted exactly before the
# PVC helper pod exists. Its selector is unique to this operation_id.
if ! acquire_restore_network_policy <<EOF
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: $RESTORE_NETWORK_POLICY
  namespace: $NAMESPACE
  labels:
    yenhubs.org/recovery-owner: ret-storage-restore
    yenhubs.org/operation-id: "$RECOVERY_OPERATION_ID"
  annotations:
    yenhubs.org/operation-lock-uid: "$RECOVERY_OPERATION_LOCK_UID"
    yenhubs.org/operation-token: "$RECOVERY_OPERATION_TOKEN"
spec:
  podSelector:
    matchLabels:
      yenhubs.org/operation-id: "$RECOVERY_OPERATION_ID"
  policyTypes: [Ingress, Egress]
  ingress: []
  egress: []
EOF
then
  printf 'Deny-all helper NetworkPolicy does not match the exact admitted contract.\n' >&2
  exit 1
fi
recovery_require_operation_lock
require_owned_restore_network_policy

# Create-only is intentional. A unique operation name plus the exact admitted
# UID/spec prevents adoption of a concurrent or stale helper.
if ! acquire_restore_pod <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $RESTORE_POD
  namespace: $NAMESPACE
  labels:
    yenhubs.org/recovery-owner: ret-storage-restore
    yenhubs.org/operation-id: "$RECOVERY_OPERATION_ID"
  annotations:
    yenhubs.org/operation-lock-uid: "$RECOVERY_OPERATION_LOCK_UID"
    yenhubs.org/operation-token: "$RECOVERY_OPERATION_TOKEN"
spec:
  automountServiceAccountToken: false
  enableServiceLinks: false
  restartPolicy: Never
  activeDeadlineSeconds: 3600
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 1000
    fsGroupChangePolicy: OnRootMismatch
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: helper
      image: $RET_IMAGE
      command: ["sh", "-c", "sleep 3600"]
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: ["ALL"]
      volumeMounts:
        - name: storage
          mountPath: /storage
          readOnly: false
  volumes:
    - name: storage
      persistentVolumeClaim:
        claimName: ret-pvc
        readOnly: false
EOF
then
  printf 'Restore pod identity or admitted spec does not match the exact safe contract.\n' >&2
  exit 1
fi
recovery_wait_for_pod_ready "$RESTORE_POD" 180
recovery_require_operation_lock
require_owned_restore_network_policy
recovery_require_exact_pvc_consumers ret-pvc "$RESTORE_POD"
if ! require_owned_restore_pod; then
  printf 'Restore pod identity or admitted spec does not match the exact safe contract.\n' >&2
  exit 1
fi

EXISTING_ENTRY="$(
  recovery_kubectl exec -n "$NAMESPACE" "$RESTORE_POD" -- sh -ec \
    'if [ -L /storage/owned ] || { [ -e /storage/owned ] && [ ! -d /storage/owned ]; }; then
       printf "unsafe-owned-root\n"
     elif [ -d /storage/owned ]; then
       find /storage/owned -mindepth 1 -print -quit 2>/dev/null
     fi'
)"
if [[ -n "$EXISTING_ENTRY" ]]; then
  REMOTE_RESTORE_STATE_RETAINED=1
  printf 'Refusing to merge into non-empty or unsafe ret-pvc owned root.\n' >&2
  printf 'All DB consumers remain at zero for inspection.\n' >&2
  exit 1
fi

monitor_pvc_during_extraction() {
  local progress=0
  while [[ ! -e "$PVC_MONITOR_STOP" ]]; do
    if ! recovery_require_cluster_identity ||
       ! recovery_require_pvc_identity ret-pvc ||
       ! recovery_require_operation_lock ||
       ! require_runner_quiescence ||
       ! require_owned_restore_network_policy ||
       ! recovery_require_exact_pvc_consumers ret-pvc "$RESTORE_POD" ||
       ! require_owned_restore_pod; then
      printf 'failed\n' >"$PVC_MONITOR_FAILURE"
      return 1
    fi
    progress=$((progress + 1))
    if ! recovery_write_stream_guard_progress "$PVC_MONITOR_PROGRESS" "$progress"; then
      printf 'progress_publish_failed\n' >"$PVC_MONITOR_FAILURE"
      return 1
    fi
    sleep "$PVC_MONITOR_POLL_SECONDS"
  done
}

RESTORE_PHASE="restoring"
# These checks are adjacent to the write, and the background guard repeats all
# three throughout extraction. Any extra PVC consumer makes the restore fail.
recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
recovery_require_operation_lock
require_runner_quiescence
require_runner_watch_healthy
require_owned_restore_network_policy
recovery_require_exact_pvc_consumers ret-pvc "$RESTORE_POD"
require_owned_restore_pod
PVC_MONITOR_POLL_SECONDS="$(recovery_stream_poll_seconds)" || {
  printf 'Could not derive the attested PVC monitor poll interval.\n' >&2
  exit 1
}
(
  # Keep the Bash 3.2 supervisor as the process identified by $!. Without an
  # EXIT obligation, an async function can tail-exec a nested kubectl command
  # and disappear successfully after that single request.
  pvc_monitor_exit_status=0
  trap 'pvc_monitor_exit_status=$?; trap - EXIT; exit "$pvc_monitor_exit_status"' EXIT
  monitor_pvc_during_extraction
) &
PVC_MONITOR_PID=$!
if ! PVC_MONITOR_START_IDENTITY="$(
  recovery_process_start_identity "$PVC_MONITOR_PID"
)"; then
  : >"$PVC_MONITOR_STOP"
  wait "$PVC_MONITOR_PID" 2>/dev/null || :
  PVC_MONITOR_PID=""
  PVC_MONITOR_START_IDENTITY=""
  printf 'Could not bind the PVC monitor to its exact process identity.\n' >&2
  exit 1
fi
if ! STORAGE_STREAM_GUARD_MAX_STALE_SECONDS="$(
  recovery_stream_guard_max_stale_seconds
)" || ! STORAGE_STREAM_GUARD_INITIAL_DEADLINE_SECONDS="$(
  recovery_stream_guard_initial_deadline_seconds
)" || ! recovery_wait_for_stream_guard_initial_progress \
  "$PVC_MONITOR_PID" "$PVC_MONITOR_START_IDENTITY" \
  "$PVC_MONITOR_FAILURE" "$PVC_MONITOR_PROGRESS" \
  "$STORAGE_STREAM_GUARD_INITIAL_DEADLINE_SECONDS"; then
  : >"$PVC_MONITOR_STOP"
  wait "$PVC_MONITOR_PID" 2>/dev/null || :
  PVC_MONITOR_PID=""
  PVC_MONITOR_START_IDENTITY=""
  STORAGE_STREAM_GUARD_MAX_STALE_SECONDS=""
  STORAGE_STREAM_GUARD_INITIAL_DEADLINE_SECONDS=""
  printf 'PVC monitor did not complete its initial exact safety sweep.\n' >&2
  exit 1
fi
STORAGE_STREAM_GUARD_ARGS=(
  --guard-process "$PVC_MONITOR_PID" "$PVC_MONITOR_START_IDENTITY"
  "$PVC_MONITOR_FAILURE" "$PVC_MONITOR_PROGRESS"
  "$STORAGE_STREAM_GUARD_MAX_STALE_SECONDS"
)
STORAGE_STREAM_GUARD_ARGS+=("${PARENT_WRITER_STREAM_GUARD_ARGS[@]}")
if [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == durable-v2 ]]; then
  STORAGE_STREAM_GUARD_ARGS+=("${PARENT_DURABLE_STREAM_GUARD_ARGS[@]}")
elif [[ "$RUNNER_WATCH_PID" =~ ^[1-9][0-9]*$ ]]; then
  STORAGE_STREAM_GUARD_ARGS+=(
    --guard-process "$RUNNER_WATCH_PID" "$RUNNER_WATCH_START_IDENTITY"
    "$RUNNER_WATCH_FAILURE" "$RUNNER_WATCH_PROGRESS"
    "$STORAGE_STREAM_GUARD_MAX_STALE_SECONDS"
  )
fi
PVC_MUTATION_STREAM_ARMED=1
if gzip -cd "$RECOVERY_STORAGE_COPY" |
  recovery_kubectl_stream_mutate 3600 "${STORAGE_STREAM_GUARD_ARGS[@]}" -- \
    exec -i -n "$NAMESPACE" "$RESTORE_POD" -- tar -C /storage -xf -; then
  extraction_status=0
else
  extraction_status=$?
fi
if ! stop_pvc_monitor; then
  monitor_status=1
else
  monitor_status=0
fi
if [[ "$extraction_status" -ne 0 || "$monitor_status" -ne 0 ]]; then
  printf 'Storage extraction or its PVC exclusivity monitor failed.\n' >&2
  exit 1
fi
recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
recovery_require_operation_lock
require_runner_quiescence
require_runner_watch_healthy
require_owned_restore_network_policy
recovery_require_exact_pvc_consumers ret-pvc "$RESTORE_POD"
require_owned_restore_pod

if ! recovery_kubectl exec -n "$NAMESPACE" "$RESTORE_POD" -- sh -ec \
  'test -d /storage/owned; cd /storage; { find owned -type d -print | sed "s|$|/|"; find owned -type f -print; }' \
  | tr -d '\r' >"$RESTORED_PATHS"; then
  printf 'Could not enumerate restored owned-file paths.\n' >&2
  exit 1
fi
if ! recovery_storage_paths_file_is_exact "$RESTORED_PATHS"; then
  printf 'Restored storage paths do not match the exact two-shard contract.\n' >&2
  exit 1
fi
recovery_extract_storage_uuids "$RESTORED_PATHS" blob | LC_ALL=C sort >"$RESTORED_BLOB_UUIDS"
recovery_extract_storage_uuids "$RESTORED_PATHS" meta.json | LC_ALL=C sort >"$RESTORED_META_UUIDS"
RESTORED_BLOBS="$(sed '/^$/d' "$RESTORED_BLOB_UUIDS" | wc -l | tr -d ' ')"
RESTORED_META="$(sed '/^$/d' "$RESTORED_META_UUIDS" | wc -l | tr -d ' ')"
if [[ "$RESTORED_BLOBS" != "$ARCHIVE_BLOB_COUNT" ||
      "$RESTORED_META" != "$ARCHIVE_META_COUNT" ]] ||
   ! cmp -s "$ARCHIVE_BLOB_UUIDS" "$RESTORED_BLOB_UUIDS" ||
   ! cmp -s "$ARCHIVE_META_UUIDS" "$RESTORED_META_UUIDS"; then
  printf 'Storage restore verification failed: DB=%s blobs=%s metadata=%s.\n' \
    "$DB_ACTIVE_COUNT" "$RESTORED_BLOBS" "$RESTORED_META" >&2
  printf 'All DB consumers remain at zero for inspection.\n' >&2
  exit 1
fi

require_runner_quiescence
PVC_MUTATION_STREAM_ARMED=0
REMOTE_RESTORE_STATE_RETAINED=0
cleanup_restore_pod
cleanup_restore_network_policy
if ! stop_runner_watch; then
  printf 'Managed bot-runner event watcher failed during storage restore.\n' >&2
  exit 1
fi
RESTORE_PHASE="coordinated_hold"
trap - ERR
printf 'Storage restore validated and held quiescent for coordinated resume: checkpoint=%s pvc_uid=%s\n' \
  "$RECOVERY_CHECKPOINT_STAMP" "$RECOVERY_PVC_UID"

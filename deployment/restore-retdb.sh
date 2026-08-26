#!/usr/bin/env bash
# shellcheck disable=SC2016

# Restores the YenHubs Reticulum database from one complete, checksummed
# checkpoint. RESTORE_PREFLIGHT=1 validates the immutable checkpoint pair and
# target identity without changing Kubernetes state.

set -euo pipefail
umask 077

if [[ $# -ne 1 ]]; then
  printf 'Usage: RESTORE_PREFLIGHT=1 %s /path/to/retdb-YYYYMMDD-HHMMSS.sql.gz\n' "$0" >&2
  exit 2
fi

DUMP_PATH="$1"
NAMESPACE="${NAMESPACE:-hcce}"
PREFLIGHT="${RESTORE_PREFLIGHT:-${RESTORE_DRY_RUN:-0}}"
COORDINATED="${RESTORE_COORDINATED:-0}"
ALREADY_FENCED="${RESTORE_ALREADY_FENCED:-0}"
DB_NAME="retdb"
CONSUMERS=(reticulum pgbouncer pgbouncer-t bot-orchestrator coturn)
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

if [[ -n "${RESTORE_DRY_RUN:-}" && -z "${RESTORE_PREFLIGHT:-}" ]]; then
  printf 'RESTORE_DRY_RUN is deprecated; this is a preflight only. Use RESTORE_PREFLIGHT=1.\n' >&2
fi
if [[ "$PREFLIGHT" != "0" && "$PREFLIGHT" != "1" ]]; then
  printf 'RESTORE_PREFLIGHT must be 0 or 1.\n' >&2
  exit 2
fi
if [[ "$COORDINATED" != "0" && "$COORDINATED" != "1" ]]; then
  printf 'RESTORE_COORDINATED must be 0 or 1.\n' >&2
  exit 2
fi
if [[ "$ALREADY_FENCED" != "0" && "$ALREADY_FENCED" != "1" ]]; then
  printf 'RESTORE_ALREADY_FENCED must be 0 or 1.\n' >&2
  exit 2
fi
if [[ "$ALREADY_FENCED" == "1" && "$COORDINATED" != "1" ]]; then
  printf 'RESTORE_ALREADY_FENCED is valid only for a coordinated restore.\n' >&2
  exit 2
fi
if [[ "$PREFLIGHT" == "0" && "$COORDINATED" != "1" ]]; then
  printf 'Destructive DB restore is only allowed through restore-checkpoint.sh coordination.\n' >&2
  exit 2
fi

SQL_CHECK_PATH=""
DUMP_ACTIVE_SORTED=""
RESTORED_ACTIVE_SORTED=""
LIVE_CONTRACT_PATH=""
QUIESCE_MONITOR_STOP=""
QUIESCE_MONITOR_FAILURE=""
QUIESCE_MONITOR_PROGRESS=""
QUIESCE_MONITOR_PID=""
QUIESCE_MONITOR_START_IDENTITY=""
RUNNER_WATCH_STOP=""
RUNNER_WATCH_FAILURE=""
RUNNER_WATCH_READY=""
RUNNER_WATCH_PROGRESS=""
RUNNER_WATCH_PID=""
RUNNER_WATCH_START_IDENTITY=""
DB_STREAM_GUARD_ARGS=()
DB_STREAM_GUARD_MAX_STALE_SECONDS=""
DB_STREAM_GUARD_INITIAL_DEADLINE_SECONDS=""
DB_QUIESCE_MONITOR_POLL_SECONDS=""
RESTORE_PHASE="validating"
DATABASE_RESTORE_STAGE="validation"
DATABASE_RESTORE_QUIESCENCE_GUARD="entry"
DATABASE_RESTORE_QUIESCENCE_DETAIL=""
cleanup_restore() {
  if [[ -n "$QUIESCE_MONITOR_PID" ]]; then
    [[ -z "$QUIESCE_MONITOR_STOP" ]] || : >"$QUIESCE_MONITOR_STOP"
    wait "$QUIESCE_MONITOR_PID" 2>/dev/null || true
    QUIESCE_MONITOR_PID=""
    QUIESCE_MONITOR_START_IDENTITY=""
  fi
  QUIESCE_MONITOR_START_IDENTITY=""
  DB_STREAM_GUARD_ARGS=()
  DB_STREAM_GUARD_MAX_STALE_SECONDS=""
  DB_STREAM_GUARD_INITIAL_DEADLINE_SECONDS=""
  DB_QUIESCE_MONITOR_POLL_SECONDS=""
  if [[ "$RUNNER_WATCH_PID" =~ ^[1-9][0-9]*$ ]]; then
    recovery_discard_no_managed_bot_runner_watch \
      "$RUNNER_WATCH_STOP" "$RUNNER_WATCH_PID" \
      "$RUNNER_WATCH_START_IDENTITY"
    RUNNER_WATCH_PID=""
    RUNNER_WATCH_START_IDENTITY=""
  fi
  RUNNER_WATCH_START_IDENTITY=""
  if [[ -n "$SQL_CHECK_PATH" ]]; then
    rm -f -- "$SQL_CHECK_PATH"
  fi
  if [[ -n "$DUMP_ACTIVE_SORTED" ]]; then
    rm -f -- "$DUMP_ACTIVE_SORTED"
  fi
  if [[ -n "$RESTORED_ACTIVE_SORTED" ]]; then
    rm -f -- "$RESTORED_ACTIVE_SORTED"
  fi
  if [[ -n "$LIVE_CONTRACT_PATH" ]]; then
    rm -f -- "$LIVE_CONTRACT_PATH"
  fi
  [[ -z "$QUIESCE_MONITOR_STOP" ]] || rm -f -- "$QUIESCE_MONITOR_STOP"
  [[ -z "$QUIESCE_MONITOR_FAILURE" ]] || rm -f -- "$QUIESCE_MONITOR_FAILURE"
  [[ -z "$QUIESCE_MONITOR_PROGRESS" ]] || rm -f -- "$QUIESCE_MONITOR_PROGRESS"
  [[ -z "$QUIESCE_MONITOR_PROGRESS" ]] || rm -f -- "${QUIESCE_MONITOR_PROGRESS}.next"
  [[ -z "$RUNNER_WATCH_STOP" ]] || rm -f -- "$RUNNER_WATCH_STOP"
  [[ -z "$RUNNER_WATCH_FAILURE" ]] || rm -f -- "$RUNNER_WATCH_FAILURE"
  [[ -z "$RUNNER_WATCH_READY" ]] || rm -f -- "$RUNNER_WATCH_READY"
  [[ -z "$RUNNER_WATCH_PROGRESS" ]] || rm -f -- "$RUNNER_WATCH_PROGRESS"
  [[ -z "$RUNNER_WATCH_PROGRESS" ]] || rm -f -- "${RUNNER_WATCH_PROGRESS}.next"
  reactivation_cleanup_temp_paths
  recovery_cleanup_materialized_checkpoint
}
restore_interrupted() {
  local status="$1"
  trap - EXIT ERR INT TERM
  if [[ "$RESTORE_PHASE" == "quiescing" || "$RESTORE_PHASE" == "restoring" ]]; then
    printf 'Database restore interrupted. Scaled DB consumers remain at zero for safety.\n' >&2
  fi
  cleanup_restore
  exit "$status"
}
restore_failed() {
  local quiescence_detail=""
  case "$DATABASE_RESTORE_STAGE" in
    validation|target|guards|quiescence|database-reset|database-stream|counts|active-files|contract|monitor-stop) ;;
    *) DATABASE_RESTORE_STAGE=other ;;
  esac
  printf 'database_restore_stage:%s\n' "$DATABASE_RESTORE_STAGE" >&2
  if [[ "$DATABASE_RESTORE_STAGE" == "quiescence" ]]; then
    case "$DATABASE_RESTORE_QUIESCENCE_GUARD" in
      target-identity|writer-pod-drain|writer-contract|runner-absence|\
        consumer-recheck|pgsql-source|local-monitor-start|\
        local-monitor-progress|parent-writer-guard|runner-watch-start) ;;
      *) DATABASE_RESTORE_QUIESCENCE_GUARD=other ;;
    esac
    printf 'database_restore_quiescence_guard:%s\n' \
      "$DATABASE_RESTORE_QUIESCENCE_GUARD" >&2
    if [[ "$DATABASE_RESTORE_QUIESCENCE_GUARD" == local-monitor-progress ]]; then
      quiescence_detail="$DATABASE_RESTORE_QUIESCENCE_DETAIL"
      if [[ -z "$quiescence_detail" && -s "$QUIESCE_MONITOR_FAILURE" ]]; then
        IFS= read -r quiescence_detail <"$QUIESCE_MONITOR_FAILURE" || :
      fi
      case "$quiescence_detail" in
        initial-progress-timeout|\
        consumer_or_pgsql_source_drift:consumer-recheck|\
        consumer_or_pgsql_source_drift:runner-absence|\
        consumer_or_pgsql_source_drift:parent-writer-guard|\
        consumer_or_pgsql_source_drift:pgsql-source|\
        progress_publish_failed)
          printf 'database_restore_quiescence_detail:%s\n' \
            "$quiescence_detail" >&2
          ;;
        *)
          printf 'database_restore_quiescence_detail:unknown\n' >&2
          ;;
      esac
    fi
  fi
  if [[ "$RESTORE_PHASE" == "quiescing" || "$RESTORE_PHASE" == "restoring" ]]; then
    printf 'Database restore stopped. Any scaled DB consumers remain at zero for safety.\n' >&2
  fi
}
trap cleanup_restore EXIT
trap restore_failed ERR
trap 'restore_interrupted 130' INT
trap 'restore_interrupted 143' TERM

# This is deliberately the first artifact operation. It verifies the exact
# allowlisted directory and hashes, copies both DB and storage into a private
# directory, rehashes the copies, and jointly validates the copied pair.
recovery_materialize_checkpoint "$DUMP_PATH" "$SCRIPT_DIR/validate-checkpoint.sh"
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

gzip -t "$RECOVERY_DUMP_COPY"
SQL_CHECK_PATH="$(mktemp "${TMPDIR:-/tmp}/yenhubs-retdb-restore.sql.XXXXXX")"
DUMP_ACTIVE_SORTED="$(mktemp "${TMPDIR:-/tmp}/yenhubs-retdb-active.XXXXXX")"
RESTORED_ACTIVE_SORTED="$(mktemp "${TMPDIR:-/tmp}/yenhubs-retdb-restored-active.XXXXXX")"
LIVE_CONTRACT_PATH="$(mktemp "${TMPDIR:-/tmp}/yenhubs-retdb-live-contract.XXXXXX")"
gzip -cd "$RECOVERY_DUMP_COPY" >"$SQL_CHECK_PATH"
chmod 600 "$SQL_CHECK_PATH" "$DUMP_ACTIVE_SORTED" "$RESTORED_ACTIVE_SORTED" "$LIVE_CONTRACT_PATH"

if ! grep -Eq '^CREATE SCHEMA (ret0|ret0_admin);' "$SQL_CHECK_PATH" ||
   ! recovery_validate_sql_dump_contract "$SQL_CHECK_PATH" ||
   ! recovery_validate_database_contract_against_dump \
     "$RECOVERY_DATABASE_CONTRACT_COPY" "$SQL_CHECK_PATH"; then
  printf 'Restore dump is missing the complete critical Reticulum SQL contract.\n' >&2
  exit 1
fi
if ! DUMP_HUBS_COUNT="$(recovery_dump_copy_row_count "$SQL_CHECK_PATH" hubs)"; then
  printf 'Restore dump does not contain exactly one complete ret0.hubs COPY block.\n' >&2
  exit 1
fi
if ! recovery_extract_active_owned_file_uuids "$SQL_CHECK_PATH" | LC_ALL=C sort >"$DUMP_ACTIVE_SORTED"; then
  printf 'Restore dump does not contain exactly one complete ret0.owned_files COPY block.\n' >&2
  exit 1
fi
DUMP_ACTIVE_COUNT="$(wc -l <"$DUMP_ACTIVE_SORTED" | tr -d ' ')"
DUMP_ACTIVE_UNIQUE_COUNT="$(LC_ALL=C sort -u "$DUMP_ACTIVE_SORTED" | wc -l | tr -d ' ')"
if [[ ! "$DUMP_HUBS_COUNT" =~ ^[0-9]+$ || "$DUMP_HUBS_COUNT" -eq 0 ||
      ! "$DUMP_ACTIVE_COUNT" =~ ^[0-9]+$ || "$DUMP_ACTIVE_COUNT" -eq 0 ||
      "$DUMP_ACTIVE_UNIQUE_COUNT" != "$DUMP_ACTIVE_COUNT" ]]; then
  printf 'Restore dump has no coherent non-empty Hubs/active-owned-file baseline.\n' >&2
  exit 1
fi
if awk '
  $0 !~ /^[A-Za-z0-9._-]+$/ { unsafe=1 }
  END { exit unsafe ? 0 : 1 }
' "$DUMP_ACTIVE_SORTED"; then
  printf 'Restore dump contains an unsafe active owned-file UUID.\n' >&2
  exit 1
fi
rm -f -- "$SQL_CHECK_PATH"
SQL_CHECK_PATH=""

recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
recovery_require_restore_target_binding
DATABASE_RESTORE_STAGE="target"
if [[ "${RESTORE_TARGET_MODE:-in-place}" == cold-rebind ]]; then
  recovery_require_cold_rebind_target_bootstrap "$VALUES_SOURCE_FILE"
elif ! recovery_require_live_runner_control_plane_matches_checkpoint \
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

if [[ "$PREFLIGHT" == "1" ]]; then
  recovery_require_cluster_identity
  recovery_require_pvc_identity ret-pvc
  recovery_require_restore_target_binding
  if [[ "${RESTORE_TARGET_MODE:-in-place}" == cold-rebind ]]; then
    recovery_require_cold_rebind_target_bootstrap "$VALUES_SOURCE_FILE"
  else
    recovery_require_live_runner_control_plane_matches_checkpoint \
      "$RECOVERY_DEPLOYMENT_INVENTORY_COPY"
  fi
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
  printf 'Database restore preflight passed (no restore performed): source=%s checkpoint=%s dump_sha256=%s storage_sha256=%s context=%s namespace=%s namespace_uid=%s database=%s pod=%s\n' \
    "$DUMP_PATH" "$RECOVERY_CHECKPOINT_STAMP" "$RECOVERY_DUMP_SHA256" \
    "$RECOVERY_STORAGE_SHA256" "$EXPECTED_KUBE_CONTEXT" "$NAMESPACE" \
    "$RECOVERY_NAMESPACE_UID" "$DB_NAME" "$PGSQL_POD"
  exit 0
fi

recovery_require_confirmation CONFIRM_RESTORE "$DB_NAME"
recovery_adopt_parent_operation_serialization \
  "$PARENT_LEASE_HOLDER" "$PARENT_LEASE_UID" \
  "$PARENT_PROCESS_PID" "$PARENT_PROCESS_START_IDENTITY"
unset YENHUBS_PARENT_LEASE_HOLDER YENHUBS_PARENT_LEASE_UID \
  YENHUBS_PARENT_PROCESS_PID YENHUBS_PARENT_PROCESS_START_IDENTITY
recovery_require_pvc_identity ret-pvc
if [[ -z "${RECOVERY_CONSUMER_CONTRACT_JSON:-}" ]] ||
   ! recovery_consumer_contract_is_acceptable "$RECOVERY_CONSUMER_CONTRACT_JSON" ||
   [[ "$(jq -r '.operation_id' <<<"$RECOVERY_CONSUMER_CONTRACT_JSON")" != \
      "${RECOVERY_OPERATION_ID:-}" ]] ||
   ! recovery_require_operation_lock; then
  printf 'Destructive DB restore lacks the exact parent operation lock/consumer contract.\n' >&2
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
        printf 'Legacy DB restore requires one live parent writer guard and rejects durable fence capabilities.\n' >&2
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
        printf 'Durable DB restore requires both live parent monitor guards.\n' >&2
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
  printf 'Destructive DB restore lacks the exact parent monitor capabilities.\n' >&2
  exit 1
}
DATABASE_RESTORE_STAGE="guards"

RESTORE_DEPLOYMENTS=()
DEPLOYMENT_SELECTORS=()
DEPLOYMENT_UIDS=()
DEPLOYMENT_RESOURCE_VERSIONS=()
DEPLOYMENT_FINGERPRINTS=()
for deployment in "${CONSUMERS[@]}"; do
  expected_entry="$(jq -cer --arg name "$deployment" \
    '[.consumers[] | select(.name == $name)] | select(length == 1) | .[0]' \
    <<<"$RECOVERY_CONSUMER_CONTRACT_JSON")" || exit 1
  deployment_uid="$(jq -r '.uid' <<<"$expected_entry")"
  deployment_resource_version="$(jq -r '.initial_resource_version' <<<"$expected_entry")"
  replica_count="$(jq -r '.original_replicas' <<<"$expected_entry")"
  deployment_selector="$(jq -r '.selector' <<<"$expected_entry")"
  deployment_fingerprint="$(jq -r '.fingerprint' <<<"$expected_entry")"
  expected_current_replicas="$replica_count"
  [[ "$ALREADY_FENCED" != "1" ]] || expected_current_replicas=0
  recovery_require_deployment_contract "$deployment" "$deployment_uid" \
    "$expected_current_replicas" "$deployment_selector" "$deployment_fingerprint" || {
    printf 'Post-lock consumer contract changed before DB quiescence: %s.\n' "$deployment" >&2
    exit 1
  }
  RESTORE_DEPLOYMENTS+=("$deployment")
  DEPLOYMENT_SELECTORS+=("$deployment_selector")
  DEPLOYMENT_UIDS+=("$deployment_uid")
  DEPLOYMENT_RESOURCE_VERSIONS+=("$deployment_resource_version")
  DEPLOYMENT_FINGERPRINTS+=("$deployment_fingerprint")
done

RESTORE_PHASE="quiescing"
DATABASE_RESTORE_STAGE="quiescence"
# Target identity is checked immediately before the first Kubernetes mutation.
DATABASE_RESTORE_QUIESCENCE_GUARD="target-identity"
recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
if [[ "$ALREADY_FENCED" != "1" ]]; then
  for index in "${!RESTORE_DEPLOYMENTS[@]}"; do
    recovery_require_operation_lock
    DEPLOYMENT_RESOURCE_VERSIONS[index]="$(recovery_scale_deployment_exact \
      "${RESTORE_DEPLOYMENTS[$index]}" "${DEPLOYMENT_UIDS[$index]}" \
      "${DEPLOYMENT_RESOURCE_VERSIONS[$index]}" \
      "$(jq -r --arg name "${RESTORE_DEPLOYMENTS[$index]}" \
        '.consumers[] | select(.name == $name) | .original_replicas' \
        <<<"$RECOVERY_CONSUMER_CONTRACT_JSON")" 0 \
      "${DEPLOYMENT_SELECTORS[$index]}" "${DEPLOYMENT_FINGERPRINTS[$index]}")"
  done
fi

for index in "${!RESTORE_DEPLOYMENTS[@]}"; do
  DATABASE_RESTORE_QUIESCENCE_GUARD="writer-pod-drain"
  recovery_require_operation_lock
  recovery_wait_for_no_pods "app=${DEPLOYMENT_SELECTORS[$index]}" \
    "deployment/${RESTORE_DEPLOYMENTS[$index]}" 180s
  DATABASE_RESTORE_QUIESCENCE_GUARD="writer-contract"
  recovery_require_operation_lock
  recovery_require_consumer_contract_entry "$RECOVERY_CONSUMER_CONTRACT_JSON" \
    "${RESTORE_DEPLOYMENTS[$index]}" 0
done
initialize_runner_quiescence() {
  case "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" in
    legacy-absent)
      DATABASE_RESTORE_QUIESCENCE_GUARD="runner-absence"
      recovery_wait_for_no_managed_bot_runner_pods 180s || return 1
      DATABASE_RESTORE_QUIESCENCE_GUARD="parent-writer-guard"
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
      DATABASE_RESTORE_QUIESCENCE_GUARD="runner-absence"
      recovery_require_no_managed_bot_runner_pods || return 1
      DATABASE_RESTORE_QUIESCENCE_GUARD="parent-writer-guard"
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

initialize_runner_quiescence

require_quiesced_monitor_snapshot() {
  local control_json workloads_json runner_json
  local namespace_json pvc_json lock_json lease_json runner_namespace_json
  local deployment expected expected_uid expected_selector expected_fingerprint
  local current_contract current_uid current_replicas current_selector current_fingerprint selector
  local pgsql_pod_json pgsql_pod_name pgsql_pod_uid pgsql_rs_name pgsql_rs_uid
  local pgsql_deployment_uid

  # Keep the local stream guard comfortably inside the fixed ten-second
  # freshness budget. Two bounded snapshots replace the old serialized
  # identity sweep; every object remains checked by UID/resourceVersion and
  # the original lock, Lease, contract and ownership predicates.
  [[ "$(command kubectl --request-timeout=45s config current-context 2>/dev/null)" == \
     "$EXPECTED_KUBE_CONTEXT" ]] || return 1
  control_json="$(recovery_kubectl get \
    namespace/"$NAMESPACE" namespace/hcce-bot-runners \
    pvc/ret-pvc configmap/"$RECOVERY_OPERATION_LOCK_NAME" \
    lease/"$RECOVERY_SERIALIZATION_LEASE_NAME" \
    -n "$NAMESPACE" --ignore-not-found -o json)" || return 1
  jq -e --arg namespace "$NAMESPACE" '
    .apiVersion == "v1" and .kind == "List" and (.items | type == "array") and
    all(.items[];
      (.metadata | type == "object") and
      (.metadata.name | type == "string" and length > 0) and
      (.metadata.uid | type == "string" and length > 0) and
      (.metadata.resourceVersion | type == "string" and length > 0) and
      ((.metadata.namespace // "") == "" or .metadata.namespace == $namespace)
    )
  ' >/dev/null <<<"$control_json" || return 1
  namespace_json="$(jq -cer --arg name "$NAMESPACE" \
    '[.items[] | select(.kind == "Namespace" and .metadata.name == $name)] |
     select(length == 1) | .[0]' <<<"$control_json")" || return 1
  pvc_json="$(jq -cer --arg namespace "$NAMESPACE" \
    '[.items[] | select(.kind == "PersistentVolumeClaim" and
      .metadata.name == "ret-pvc" and .metadata.namespace == $namespace)] |
     select(length == 1) | .[0]' <<<"$control_json")" || return 1
  lock_json="$(jq -cer --arg namespace "$NAMESPACE" \
    '[.items[] | select(.kind == "ConfigMap" and
      .metadata.name == "yenhubs-recovery-operation-lock" and .metadata.namespace == $namespace)] |
     select(length == 1) | .[0]' <<<"$control_json")" || return 1
  lease_json="$(jq -cer --arg namespace "$NAMESPACE" \
    '[.items[] | select(.kind == "Lease" and
      .metadata.name == "yenhubs-operation-serialization" and .metadata.namespace == $namespace)] |
     select(length == 1) | .[0]' <<<"$control_json")" || return 1
  runner_namespace_json="$(jq -cr '
    [.items[] | select(.kind == "Namespace" and .metadata.name == "hcce-bot-runners")] |
    select(length <= 1) | if length == 1 then .[0] else null end
  ' <<<"$control_json")" || return 1
  [[ "$(jq -er '.metadata.uid' <<<"$namespace_json")" == \
     "$EXPECTED_NAMESPACE_UID" ]] || return 1
  [[ "$(jq -er '.metadata.uid' <<<"$pvc_json")" == \
     "$EXPECTED_RET_PVC_UID" ]] || return 1
  RECOVERY_NAMESPACE_UID="$EXPECTED_NAMESPACE_UID"
  RECOVERY_PVC_UID="$EXPECTED_RET_PVC_UID"
  recovery_operation_lock_json_is_exact "$lock_json" || return 1
  recovery_owned_serialization_lease_json_is_exact "$lease_json" || return 1

  workloads_json="$(recovery_kubectl get deployments,pods,replicasets \
    -n "$NAMESPACE" -o json)" || return 1
  jq -e --arg namespace "$NAMESPACE" '
    .apiVersion == "v1" and .kind == "List" and (.items | type == "array") and
    all(.items[];
      (.kind == "Deployment" or .kind == "Pod" or .kind == "ReplicaSet") and
      .metadata.namespace == $namespace and
      (.metadata.name | type == "string" and length > 0) and
      (.metadata.uid | type == "string" and length > 0) and
      (.metadata.resourceVersion | type == "string" and length > 0)
    )
  ' >/dev/null <<<"$workloads_json" || return 1
  recovery_consumer_contract_is_acceptable "$RECOVERY_CONSUMER_CONTRACT_JSON" ||
    return 1
  [[ "$(jq -r '.operation_id' <<<"$RECOVERY_CONSUMER_CONTRACT_JSON")" == \
     "${RECOVERY_OPERATION_ID:-}" ]] || return 1
  for deployment in "${CONSUMERS[@]}"; do
    expected="$(jq -cer --arg name "$deployment" \
      '[.consumers[] | select(.name == $name)] | select(length == 1) | .[0]' \
      <<<"$RECOVERY_CONSUMER_CONTRACT_JSON")" || return 1
    expected_uid="$(jq -r '.uid' <<<"$expected")"
    expected_selector="$(jq -r '.selector' <<<"$expected")"
    expected_fingerprint="$(jq -r '.fingerprint' <<<"$expected")"
    current_contract="$(jq -cer --arg name "$deployment" --arg namespace "$NAMESPACE" '
      [.items[] | select(.kind == "Deployment" and
        .metadata.name == $name and .metadata.namespace == $namespace) |
        select(.spec.replicas | type == "number" and floor == . and . >= 0) |
        select((.spec.selector.matchLabels | keys) == ["app"]) |
        select((.spec.selector.matchExpressions // []) == []) |
        select(.spec.selector.matchLabels.app | type == "string" and length > 0) |
        select(.spec.template.metadata.labels.app == .spec.selector.matchLabels.app)] |
        select(length == 1) | .[0] |
        [.metadata.uid,.metadata.resourceVersion,(.spec.replicas | tostring),
         .spec.selector.matchLabels.app,
         ({selector:.spec.selector,strategy:(.spec.strategy // {}),template:.spec.template} | @base64)] |
        @tsv
    ' <<<"$workloads_json")" || return 1
    IFS=$'\t' read -r current_uid _current_resource_version current_replicas \
      current_selector current_fingerprint <<<"$current_contract"
    [[ "$current_uid" == "$expected_uid" && "$current_replicas" == 0 &&
       "$current_selector" == "$expected_selector" &&
       "$current_fingerprint" == "$expected_fingerprint" ]] || return 1
  done
  for deployment in "${CONSUMERS[@]}"; do
    selector="$(jq -er --arg name "$deployment" \
      '[.consumers[] | select(.name == $name)] | select(length == 1) | .[0].selector' \
      <<<"$RECOVERY_CONSUMER_CONTRACT_JSON")" || return 1
    jq -e --arg selector "$selector" '
      [.items[] | select(.kind == "Pod" and (.metadata.labels.app // "") == $selector)] |
      length == 0
    ' <<<"$workloads_json" >/dev/null || return 1
  done
  jq -e '
    [.items[] | select(.kind == "Pod") | select(
      (.metadata.labels.app // "") == "bot-runner" or
      (.metadata.labels.component // "") == "bot-runner" or
      (.metadata.labels["yenhubs.org/managed-by"] // "") == "bot-orchestrator" or
      (.spec.serviceAccountName // "") == "bot-orchestrator")] | length == 0
  ' <<<"$workloads_json" >/dev/null || return 1

  pgsql_pod_json="$(jq -cer --arg namespace "$NAMESPACE" '
    [.items[] | select(.kind == "Pod" and .metadata.namespace == $namespace and
      .metadata.labels.app == "pgsql" and .status.phase == "Running" and
      ([.status.conditions[]? | select(.type == "Ready" and .status == "True")] | length == 1) and
      ([.metadata.ownerReferences[]? | select(.kind == "ReplicaSet" and .controller == true)] | length == 1))] |
      select(length == 1) | .[0]
  ' <<<"$workloads_json")" || return 1
  pgsql_pod_name="$(jq -er '.metadata.name' <<<"$pgsql_pod_json")"
  pgsql_pod_uid="$(jq -er '.metadata.uid' <<<"$pgsql_pod_json")"
  pgsql_rs_name="$(jq -er '[.metadata.ownerReferences[] | select(.kind == "ReplicaSet" and .controller == true)] | .[0].name' <<<"$pgsql_pod_json")"
  pgsql_rs_uid="$(jq -er '[.metadata.ownerReferences[] | select(.kind == "ReplicaSet" and .controller == true)] | .[0].uid' <<<"$pgsql_pod_json")"
  pgsql_deployment_uid="$(jq -er --arg name pgsql --arg namespace "$NAMESPACE" '
    [.items[] | select(.kind == "Deployment" and .metadata.name == $name and .metadata.namespace == $namespace)] |
    select(length == 1) | .[0].metadata.uid
  ' <<<"$workloads_json")" || return 1
  [[ "$pgsql_pod_name" == "$PGSQL_POD" && "$pgsql_pod_uid" == "$PGSQL_POD_UID" &&
     "$pgsql_deployment_uid" == "$PGSQL_DEPLOYMENT_UID" ]] || return 1
  jq -e --arg rs_name "$pgsql_rs_name" --arg rs_uid "$pgsql_rs_uid" \
    --arg deployment pgsql --arg deployment_uid "$pgsql_deployment_uid" \
    --arg namespace "$NAMESPACE" '
    [.items[] | select(.kind == "ReplicaSet" and .metadata.name == $rs_name and
      .metadata.uid == $rs_uid and .metadata.namespace == $namespace) |
      select([.metadata.ownerReferences[]? | select(.kind == "Deployment" and
        .controller == true and .name == $deployment and .uid == $deployment_uid)] | length == 1)] |
    length == 1
  ' <<<"$workloads_json" >/dev/null || return 1
  if [[ "$(jq -r 'if . == null then "absent" else "present" end' <<<"$runner_namespace_json")" == present ]]; then
    runner_json="$(recovery_kubectl_get_namespaced_list pods hcce-bot-runners)" || return 1
    jq -e '
      .apiVersion == "v1" and .kind == "PodList" and
      (.metadata.resourceVersion | type == "string" and length > 0) and
      (.items | type == "array") and
      ([.items[] | select(
        ((.metadata.labels.app // "") != "bot-runner-fence" and
         (.metadata.labels.app // "") != "bot-runner-intent" and
         (.metadata.labels.app // "") != "bot-runner") or
        (.metadata.labels.app // "") == "bot-runner" or
        (.metadata.labels.app // "") == "bot-runner-intent")] | length == 0)
    ' >/dev/null <<<"$runner_json" || return 1
  fi
  # The parent writer capability is already one of the exact supervised stream
  # guards. The initial quiescence gate validates it before this monitor starts;
  # during the destructive window the stream supervisor revokes immediately on
  # any stale/failed parent capability. Repeating the full parent Kubernetes
  # sweep here would serialize the same guard into the local ten-second window.
  return 0
}

require_quiesced_consumer_inventory() {
  local deployments_json pods_json deployment expected expected_uid expected_selector
  local expected_fingerprint current_contract current_uid current_replicas
  local current_selector current_fingerprint selector contract_operation_id

  # The old monitor performed one Deployment GET and one Pod GET per writer on
  # every sweep.  During a real stream those serialized calls could consume
  # the whole ten-second freshness window even though the API was healthy. A
  # Single namespaced snapshots are stronger for this boundary: all five writer
  # contracts and all writer Pods are collected in bounded API responses, then
  # validated locally using each item's UID/resourceVersion and the full
  # contract without weakening any identity check. Some Kubernetes servers
  # return an empty List-level resourceVersion for this non-watch request.
  deployments_json="$(RECOVERY_QUIESCENCE_INVENTORY=1 \
    recovery_kubectl get deployment -n "$NAMESPACE" -o json)" ||
    return 1
  jq -e --arg namespace "$NAMESPACE" '
    ((.apiVersion == "v1" and .kind == "List") or
      (.apiVersion == "apps/v1" and .kind == "DeploymentList")) and
    (.metadata | type == "object" and has("resourceVersion")) and
    (.metadata.resourceVersion | type == "string") and
    (.items | type == "array") and
    all(.items[];
      .apiVersion == "apps/v1" and .kind == "Deployment" and
      # A namespaced List is already scoped by the API request. Older test
      # fixtures omit the repeated namespace field; if present it must still
      # match the verified namespace.
      ((.metadata.namespace // $namespace) == $namespace) and
      (.metadata.name | type == "string" and length > 0) and
      (.metadata.uid | type == "string" and length > 0) and
      (.metadata.resourceVersion | type == "string" and length > 0) and
      (.spec | type == "object")
    )
  ' >/dev/null <<<"$deployments_json" || return 1

  recovery_consumer_contract_is_acceptable "$RECOVERY_CONSUMER_CONTRACT_JSON" ||
    return 1
  contract_operation_id="$(jq -r '.operation_id' <<<"$RECOVERY_CONSUMER_CONTRACT_JSON")" ||
    return 1
  [[ "$contract_operation_id" == "${RECOVERY_OPERATION_ID:-}" ]] || return 1

  for deployment in "${CONSUMERS[@]}"; do
    expected="$(jq -cer --arg name "$deployment" \
      '[.consumers[] | select(.name == $name)] | select(length == 1) | .[0]' \
      <<<"$RECOVERY_CONSUMER_CONTRACT_JSON")" || return 1
    expected_uid="$(jq -r '.uid' <<<"$expected")"
    expected_selector="$(jq -r '.selector' <<<"$expected")"
    expected_fingerprint="$(jq -r '.fingerprint' <<<"$expected")"
    current_contract="$(jq -cer --arg name "$deployment" \
      --arg namespace "$NAMESPACE" '
      [.items[]
       | select(.apiVersion == "apps/v1" and .kind == "Deployment")
       | select(.metadata.name == $name and
           ((.metadata.namespace // $namespace) == $namespace))
       | select(.metadata.uid | type == "string" and length > 0)
       | select(.metadata.resourceVersion | type == "string" and length > 0)
       | select(.spec.replicas | type == "number" and floor == . and . >= 0)
       | select((.spec.selector.matchLabels | keys) == ["app"])
       | select((.spec.selector.matchExpressions // []) == [])
       | select(.spec.selector.matchLabels.app | type == "string" and length > 0)
       | select(.spec.template.metadata.labels.app == .spec.selector.matchLabels.app)
      ] | select(length == 1) | .[0] |
      [
        .metadata.uid,
        .metadata.resourceVersion,
        (.spec.replicas | tostring),
        .spec.selector.matchLabels.app,
        ({selector:.spec.selector, strategy:(.spec.strategy // {}), template:.spec.template} | @base64)
      ] | @tsv
    ' <<<"$deployments_json")" || return 1
    IFS=$'\t' read -r current_uid _current_resource_version current_replicas \
      current_selector current_fingerprint <<<"$current_contract"
    [[ "$current_uid" == "$expected_uid" && "$current_replicas" == 0 &&
       "$current_selector" == "$expected_selector" &&
       "$current_fingerprint" == "$expected_fingerprint" ]] || return 1
  done

  pods_json="$(recovery_kubectl get pods -n "$NAMESPACE" -o json)" || return 1
  jq -e --arg namespace "$NAMESPACE" '
    .apiVersion == "v1" and (.kind == "List" or .kind == "PodList") and
    (.metadata | type == "object" and has("resourceVersion")) and
    (.metadata.resourceVersion | type == "string") and
    (.items | type == "array") and
    all(.items[];
      .apiVersion == "v1" and .kind == "Pod" and
      ((.metadata.namespace // $namespace) == $namespace) and
      (.metadata.name | type == "string" and length > 0) and
      (.metadata.uid | type == "string" and length > 0) and
      ((.metadata.labels // {}) | type == "object")
    )
  ' >/dev/null <<<"$pods_json" || return 1
  for deployment in "${CONSUMERS[@]}"; do
    selector="$(jq -er --arg name "$deployment" \
      '[.consumers[] | select(.name == $name)] | select(length == 1) | .[0].selector' \
      <<<"$RECOVERY_CONSUMER_CONTRACT_JSON")" || return 1
    jq -e --arg selector "$selector" \
      '[.items[] | select((.metadata.labels.app // "") == $selector)] | length == 0' \
      <<<"$pods_json" >/dev/null || return 1
  done
}

require_quiesced_consumers() {
  if [[ "${DATABASE_RESTORE_MONITOR_PHASE:-}" == quiescence ]]; then
    DATABASE_RESTORE_QUIESCENCE_GUARD="consumer-recheck"
    require_quiesced_monitor_snapshot
    return $?
  fi
  DATABASE_RESTORE_QUIESCENCE_GUARD="consumer-recheck"
  recovery_require_operation_lock || return 1
  require_quiesced_consumer_inventory || return 1
  DATABASE_RESTORE_QUIESCENCE_GUARD="runner-absence"
  require_runner_quiescence || return 1
  DATABASE_RESTORE_QUIESCENCE_GUARD="pgsql-source"
  require_pgsql_source
}

start_quiesce_monitor() {
  local initial_progress_status=0
  DATABASE_RESTORE_QUIESCENCE_GUARD="local-monitor-start"
  [[ -z "$RUNNER_WATCH_PID" &&
     -z "$RUNNER_WATCH_START_IDENTITY" ]] || return 2
  QUIESCE_MONITOR_STOP="$(mktemp "${TMPDIR:-/tmp}/yenhubs-db-quiesce-stop.XXXXXX")"
  QUIESCE_MONITOR_FAILURE="$(mktemp "${TMPDIR:-/tmp}/yenhubs-db-quiesce-failure.XXXXXX")"
  QUIESCE_MONITOR_PROGRESS="$(mktemp "${TMPDIR:-/tmp}/yenhubs-db-quiesce-progress.XXXXXX")"
  rm -f -- "$QUIESCE_MONITOR_STOP"
  chmod 600 "$QUIESCE_MONITOR_FAILURE" "$QUIESCE_MONITOR_PROGRESS"
  DB_QUIESCE_MONITOR_POLL_SECONDS="$(recovery_stream_poll_seconds)" || return 1
  (
    # The EXIT obligation prevents Bash 3.2 from replacing this long-lived
    # supervisor with a tail-executed kubectl reached through a nested helper.
    db_monitor_exit_status=0
    trap 'db_monitor_exit_status=$?; trap - EXIT; exit "$db_monitor_exit_status"' EXIT
    DATABASE_RESTORE_MONITOR_PHASE=quiescence
    export DATABASE_RESTORE_MONITOR_PHASE
    progress=0
    while [[ ! -e "$QUIESCE_MONITOR_STOP" ]]; do
      if ! require_quiesced_consumers; then
        case "$DATABASE_RESTORE_QUIESCENCE_GUARD" in
          consumer-recheck|runner-absence|parent-writer-guard|pgsql-source)
            printf 'consumer_or_pgsql_source_drift:%s\n' \
              "$DATABASE_RESTORE_QUIESCENCE_GUARD" >"$QUIESCE_MONITOR_FAILURE"
            ;;
          *)
            printf 'consumer_or_pgsql_source_drift:unknown\n' \
              >"$QUIESCE_MONITOR_FAILURE"
            ;;
        esac
        exit 1
      fi
      progress=$((progress + 1))
      if ! recovery_write_stream_guard_progress \
          "$QUIESCE_MONITOR_PROGRESS" "$progress"; then
        printf 'progress_publish_failed\n' >"$QUIESCE_MONITOR_FAILURE"
        exit 1
      fi
      sleep "$DB_QUIESCE_MONITOR_POLL_SECONDS"
    done
  ) &
  QUIESCE_MONITOR_PID=$!
  if ! QUIESCE_MONITOR_START_IDENTITY="$(
    recovery_process_start_identity "$QUIESCE_MONITOR_PID"
  )"; then
    : >"$QUIESCE_MONITOR_STOP"
    wait "$QUIESCE_MONITOR_PID" 2>/dev/null || :
    QUIESCE_MONITOR_PID=""
    QUIESCE_MONITOR_START_IDENTITY=""
    return 1
  fi
  if ! DB_STREAM_GUARD_MAX_STALE_SECONDS="$(
      recovery_stream_guard_max_stale_seconds
    )" || ! DB_STREAM_GUARD_INITIAL_DEADLINE_SECONDS="$(
      recovery_stream_guard_initial_deadline_seconds
    )"; then
    : >"$QUIESCE_MONITOR_STOP"
    wait "$QUIESCE_MONITOR_PID" 2>/dev/null || :
    QUIESCE_MONITOR_PID=""
    QUIESCE_MONITOR_START_IDENTITY=""
    DB_STREAM_GUARD_MAX_STALE_SECONDS=""
    DB_STREAM_GUARD_INITIAL_DEADLINE_SECONDS=""
    return 1
  fi
  DATABASE_RESTORE_QUIESCENCE_GUARD="local-monitor-progress"
  if recovery_wait_for_stream_guard_initial_progress \
      "$QUIESCE_MONITOR_PID" "$QUIESCE_MONITOR_START_IDENTITY" \
      "$QUIESCE_MONITOR_FAILURE" "$QUIESCE_MONITOR_PROGRESS" \
      "$DB_STREAM_GUARD_INITIAL_DEADLINE_SECONDS"; then
    :
  else
    initial_progress_status=$?
    if [[ "$initial_progress_status" == 3 ]]; then
      DATABASE_RESTORE_QUIESCENCE_DETAIL="initial-progress-timeout"
    fi
    : >"$QUIESCE_MONITOR_STOP"
    wait "$QUIESCE_MONITOR_PID" 2>/dev/null || :
    QUIESCE_MONITOR_PID=""
    QUIESCE_MONITOR_START_IDENTITY=""
    DB_STREAM_GUARD_MAX_STALE_SECONDS=""
    DB_STREAM_GUARD_INITIAL_DEADLINE_SECONDS=""
    return 1
  fi
  DB_STREAM_GUARD_ARGS=(
    --guard-process "$QUIESCE_MONITOR_PID" "$QUIESCE_MONITOR_START_IDENTITY"
    "$QUIESCE_MONITOR_FAILURE" "$QUIESCE_MONITOR_PROGRESS"
    "$DB_STREAM_GUARD_MAX_STALE_SECONDS"
  )
  DATABASE_RESTORE_QUIESCENCE_GUARD="parent-writer-guard"
  require_runner_quiescence || return 1
  DB_STREAM_GUARD_ARGS+=("${PARENT_WRITER_STREAM_GUARD_ARGS[@]}")
  if [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == durable-v2 ]]; then
    DB_STREAM_GUARD_ARGS+=("${PARENT_DURABLE_STREAM_GUARD_ARGS[@]}")
    return 0
  fi
  [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == legacy-absent ]] || return 1
  DATABASE_RESTORE_QUIESCENCE_GUARD="runner-watch-start"
  RUNNER_WATCH_STOP="$(mktemp "${TMPDIR:-/tmp}/yenhubs-db-runner-stop.XXXXXX")"
  RUNNER_WATCH_FAILURE="$(mktemp "${TMPDIR:-/tmp}/yenhubs-db-runner-failure.XXXXXX")"
  RUNNER_WATCH_READY="$(mktemp "${TMPDIR:-/tmp}/yenhubs-db-runner-ready.XXXXXX")"
  RUNNER_WATCH_PROGRESS="$(mktemp "${TMPDIR:-/tmp}/yenhubs-db-runner-progress.XXXXXX")"
  chmod 600 "$RUNNER_WATCH_STOP" "$RUNNER_WATCH_FAILURE" "$RUNNER_WATCH_READY" \
    "$RUNNER_WATCH_PROGRESS"
  if ! recovery_start_no_managed_bot_runner_watch \
    "$RUNNER_WATCH_STOP" "$RUNNER_WATCH_FAILURE" "$RUNNER_WATCH_READY" \
    RUNNER_WATCH_PID RUNNER_WATCH_START_IDENTITY "$RUNNER_WATCH_PROGRESS"; then
    : >"$QUIESCE_MONITOR_STOP"
    wait "$QUIESCE_MONITOR_PID" 2>/dev/null || :
    QUIESCE_MONITOR_PID=""
    QUIESCE_MONITOR_START_IDENTITY=""
    DB_STREAM_GUARD_ARGS=()
    return 1
  fi
  DB_STREAM_GUARD_ARGS+=(
    --guard-process "$RUNNER_WATCH_PID" "$RUNNER_WATCH_START_IDENTITY"
    "$RUNNER_WATCH_FAILURE" "$RUNNER_WATCH_PROGRESS"
    "$DB_STREAM_GUARD_MAX_STALE_SECONDS"
  )
}

stop_quiesce_monitor() {
  local status=0
  [[ -n "$QUIESCE_MONITOR_PID" ]] || return 2
  : >"$QUIESCE_MONITOR_STOP"
  if wait "$QUIESCE_MONITOR_PID"; then status=0; else status=$?; fi
  QUIESCE_MONITOR_PID=""
  QUIESCE_MONITOR_START_IDENTITY=""
  if [[ -s "$QUIESCE_MONITOR_FAILURE" ]]; then status=1; fi
  if [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == durable-v2 ]]; then
    [[ -z "$RUNNER_WATCH_PID" &&
       -z "$RUNNER_WATCH_START_IDENTITY" ]] || status=1
    require_runner_quiescence || status=1
  else
    if ! recovery_stop_no_managed_bot_runner_watch \
      "$RUNNER_WATCH_STOP" "$RUNNER_WATCH_FAILURE" "$RUNNER_WATCH_READY" \
      "$RUNNER_WATCH_PID" "$RUNNER_WATCH_START_IDENTITY"; then
      status=1
    fi
  fi
  RUNNER_WATCH_PID=""
  RUNNER_WATCH_START_IDENTITY=""
  DB_STREAM_GUARD_ARGS=()
  DB_STREAM_GUARD_MAX_STALE_SECONDS=""
  DB_STREAM_GUARD_INITIAL_DEADLINE_SECONDS=""
  [[ "$status" == 0 ]]
}

RESTORE_PHASE="restoring"
# Revalidate immediately before the destructive drop/create transaction.
DATABASE_RESTORE_QUIESCENCE_GUARD="target-identity"
recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
require_quiesced_consumers
require_pgsql_source
start_quiesce_monitor
DATABASE_RESTORE_STAGE="database-reset"
# pg_dump does not include cluster-level roles. The restored grants require
# ret_admin even though it is a NOLOGIN role.
# Expansion is intentionally deferred to the shell inside the PostgreSQL pod.
# shellcheck disable=SC2016
# The reset is a guarded stream too. Keep its allowlisted supervisor stage in
# the failure output; without this context an initialize/refresh/launch failure
# collapses to the outer database-reset stage and cannot be diagnosed safely.
RECOVERY_STREAM_DIAGNOSTIC_CONTEXT=database-restore \
recovery_kubectl_mutate "${DB_STREAM_GUARD_ARGS[@]}" -- \
  exec -n "$NAMESPACE" "$PGSQL_POD" -- sh -ec '
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -q <<'\''SQL'\''
DO $do$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '\''ret_admin'\'') THEN
    CREATE ROLE ret_admin NOLOGIN;
  END IF;
END
$do$;
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = '\''retdb'\'' AND pid <> pg_backend_pid();
SQL
  dropdb -U "$POSTGRES_USER" --if-exists retdb
  createdb -U "$POSTGRES_USER" -O "$POSTGRES_USER" retdb
' >/dev/null

# Only the private, rehashed copy is consumed after confirmation.
# Expansion is intentionally deferred to the shell inside the PostgreSQL pod.
# shellcheck disable=SC2016
require_quiesced_consumers
require_pgsql_source
DATABASE_RESTORE_STAGE="database-stream"
gzip -cd "$RECOVERY_DUMP_COPY" |
  RECOVERY_STREAM_DIAGNOSTIC_CONTEXT=database-restore \
  recovery_kubectl_stream_mutate 3600 "${DB_STREAM_GUARD_ARGS[@]}" -- \
    exec -i -n "$NAMESPACE" "$PGSQL_POD" -- \
      sh -ec 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d retdb' >/dev/null

require_quiesced_consumers
require_pgsql_source

DATABASE_RESTORE_STAGE="counts"
require_quiesced_consumers
require_pgsql_source
if ! RESTORE_COUNTS="$(
  # Expansion is intentionally deferred to the shell inside the PostgreSQL pod.
  # shellcheck disable=SC2016
  recovery_kubectl exec -n "$NAMESPACE" "$PGSQL_POD" -- sh -ec \
    'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d retdb -At <<'\''SQL'\''
select count(*) from information_schema.tables
where table_schema in ('\''ret0'\'', '\''ret0_admin'\'', '\''coturn'\'');
select count(*) from ret0.schema_migrations;
select count(*) from ret0.hubs;
select count(*) from ret0.owned_files where state = '\''active'\'';
SQL'
)"; then
  printf 'Could not query the restored database for verification.\n' >&2
  exit 1
fi
SCHEMA_TABLES="$(printf '%s\n' "$RESTORE_COUNTS" | sed -n '1p')"
MIGRATIONS="$(printf '%s\n' "$RESTORE_COUNTS" | sed -n '2p')"
RESTORED_HUBS="$(printf '%s\n' "$RESTORE_COUNTS" | sed -n '3p')"
RESTORED_ACTIVE_FILES="$(printf '%s\n' "$RESTORE_COUNTS" | sed -n '4p')"
if [[ ! "$SCHEMA_TABLES" =~ ^[0-9]+$ || "$SCHEMA_TABLES" -eq 0 ||
      ! "$MIGRATIONS" =~ ^[0-9]+$ || "$MIGRATIONS" -eq 0 ||
      "$RESTORED_HUBS" != "$DUMP_HUBS_COUNT" ||
      "$RESTORED_ACTIVE_FILES" != "$DUMP_ACTIVE_COUNT" ]]; then
  printf 'Restore verification returned invalid counts.\n' >&2
  exit 1
fi

# Expansion is intentionally deferred to the PostgreSQL container.
# shellcheck disable=SC2016
require_quiesced_consumers
require_pgsql_source
DATABASE_RESTORE_STAGE="active-files"
if ! recovery_kubectl exec -n "$NAMESPACE" "$PGSQL_POD" -- sh -ec \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d retdb -Atc "select owned_file_uuid from ret0.owned_files where state = '\''active'\'' order by owned_file_uuid"' \
  | tr -d '\r' | LC_ALL=C sort >"$RESTORED_ACTIVE_SORTED"; then
  printf 'Could not query exact active owned-file UUIDs after restore.\n' >&2
  exit 1
fi
if ! cmp -s "$DUMP_ACTIVE_SORTED" "$RESTORED_ACTIVE_SORTED"; then
  printf 'Restored active owned-file UUID set does not exactly match the dump.\n' >&2
  exit 1
fi

require_quiesced_consumers
require_pgsql_source
DATABASE_RESTORE_STAGE="contract"
if ! recovery_capture_live_database_contract "$PGSQL_POD" "$LIVE_CONTRACT_PATH" ||
   ! recovery_database_contracts_match "$RECOVERY_DATABASE_CONTRACT_COPY" "$LIVE_CONTRACT_PATH"; then
  printf 'Restored database contract does not exactly match the checksummed checkpoint contract.\n' >&2
  exit 1
fi
require_quiesced_consumers
require_pgsql_source

DATABASE_RESTORE_STAGE="monitor-stop"
if ! stop_quiesce_monitor; then
  printf 'A DB consumer resumed during the destructive restore window.\n' >&2
  exit 1
fi
require_quiesced_consumers
RESTORE_PHASE="coordinated_hold"
trap - ERR
printf 'Database restore validated and held quiescent for coordinated storage restore: checkpoint=%s\n' \
  "$RECOVERY_CHECKPOINT_STAMP"

#!/usr/bin/env bash

# Coordinates the database and ret-pvc halves of one checkpoint. Every DB
# consumer remains at zero from before the drop until both halves and the live
# database contract have been validated.

set -Eeuo pipefail
umask 077

if [[ $# -ne 1 ]]; then
  printf 'Usage: RESTORE_CHECKPOINT_PREFLIGHT=1 %s /path/to/checkpoint-directory\n' "$0" >&2
  exit 2
fi

CHECKPOINT_DIR="$1"
PREFLIGHT="${RESTORE_CHECKPOINT_PREFLIGHT:-0}"
CLEAR_STALE_LOCK="${RESTORE_CHECKPOINT_CLEAR_STALE_LOCK:-0}"
PREPARE_FENCE="${RESTORE_CHECKPOINT_PREPARE_FENCE:-0}"
EXECUTE_FENCED="${RESTORE_CHECKPOINT_EXECUTE_FENCED:-0}"
FINALIZE_REACTIVATION="${RESTORE_CHECKPOINT_FINALIZE_REACTIVATION:-0}"
LEGACY_IN_PLACE="${RESTORE_CHECKPOINT_LEGACY_IN_PLACE:-0}"
COLD_REBIND="${RESTORE_CHECKPOINT_COLD_REBIND:-0}"
NAMESPACE="${NAMESPACE:-hcce}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VALUES_INPUT_FILE="${VALUES_FILE:-$SCRIPT_DIR/input-values.local.yaml}"
MANIFEST_INPUT_FILE="${HCCE_MANIFEST_PATH:-$SCRIPT_DIR/../hubs-cloud/community-edition/hcce.yaml}"
CUTOVER_KEY_INPUT_FILE="${PROCESS_LOCAL_CUTOVER_KEY_PATH:-}"
FREEZE_RECEIPT_INPUT_FILE="${FREEZE_RECEIPT_PATH:-}"
VALUES_SOURCE_FILE=""
# shellcheck source=deployment/lib/recovery-safety.sh
source "$SCRIPT_DIR/lib/recovery-safety.sh"
recovery_require_in_place_restore_target_mode

if [[ "$PREFLIGHT" != "0" && "$PREFLIGHT" != "1" ]]; then
  printf 'RESTORE_CHECKPOINT_PREFLIGHT must be 0 or 1.\n' >&2
  exit 2
fi
if [[ "$CLEAR_STALE_LOCK" != "0" && "$CLEAR_STALE_LOCK" != "1" ]]; then
  printf 'RESTORE_CHECKPOINT_CLEAR_STALE_LOCK must be 0 or 1.\n' >&2
  exit 2
fi
if [[ "$PREPARE_FENCE" != "0" && "$PREPARE_FENCE" != "1" ]] ||
   [[ "$EXECUTE_FENCED" != "0" && "$EXECUTE_FENCED" != "1" ]] ||
   [[ "$FINALIZE_REACTIVATION" != "0" && "$FINALIZE_REACTIVATION" != "1" ]] ||
   [[ "$LEGACY_IN_PLACE" != "0" && "$LEGACY_IN_PLACE" != "1" ]] ||
   [[ "$COLD_REBIND" != "0" && "$COLD_REBIND" != "1" ]]; then
  printf 'Restore fence phase flags must be 0 or 1.\n' >&2
  exit 2
fi
if (( PREFLIGHT + CLEAR_STALE_LOCK + PREPARE_FENCE + EXECUTE_FENCED + FINALIZE_REACTIVATION + LEGACY_IN_PLACE + COLD_REBIND > 1 )); then
  printf 'Preflight, stale-lock clearance, in-place/cold restore and durable fence phases are separate operations.\n' >&2
  exit 2
fi
if [[ "$COLD_REBIND" == 1 && "${RESTORE_TARGET_MODE:-in-place}" != cold-rebind ]] ||
   [[ "$LEGACY_IN_PLACE" == 1 && "${RESTORE_TARGET_MODE:-in-place}" != in-place ]]; then
  printf 'The selected restore operation does not match RESTORE_TARGET_MODE.\n' >&2
  exit 2
fi
if [[ ! -d "$CHECKPOINT_DIR" || -L "$CHECKPOINT_DIR" ]] ||
   recovery_path_has_symlink_component "$CHECKPOINT_DIR"; then
  printf 'Checkpoint directory must be direct and contain no symlink component.\n' >&2
  exit 1
fi
CHECKPOINT_DIR="$(cd "$CHECKPOINT_DIR" && pwd -P)"
metadata_path="$CHECKPOINT_DIR/checkpoint-metadata.json"
if ! recovery_require_regular_direct_file "$metadata_path"; then
  printf 'Checkpoint metadata must be a direct regular file with no symlink component.\n' >&2
  exit 1
fi
if ! stamp="$(jq -er '.stamp | select(type == "string" and test("^[0-9]{8}-[0-9]{6}$"))' "$metadata_path")"; then
  printf 'Checkpoint metadata does not contain one valid stamp.\n' >&2
  exit 1
fi
DUMP_PATH="$CHECKPOINT_DIR/retdb-$stamp.sql.gz"
STORAGE_PATH="$CHECKPOINT_DIR/ret-storage-$stamp.tar.gz"

RESTORE_PHASE="validating"
LIVE_CONTRACT=""
CONSUMERS=(reticulum pgbouncer pgbouncer-t bot-orchestrator coturn)
ORIGINAL_REPLICAS=()
DEPLOYMENT_UIDS=()
DEPLOYMENT_RESOURCE_VERSIONS=()
DEPLOYMENT_SELECTORS=()
DEPLOYMENT_FINGERPRINTS=()
RECOVERY_CONSUMER_CONTRACT_JSON=""
RESTORE_LOCK_NAME="yenhubs-recovery-operation-lock"
RESTORE_LOCK_CREATED=0
RESTORE_LOCK_UID=""
RESTORE_LOCK_RESOURCE_VERSION=""
RESTORE_LOCK_TOKEN=""
RESTORE_OPERATION_ID=""
RUNNER_RESUME_MONITOR_STOP=""
RUNNER_RESUME_MONITOR_FAILURE=""
RUNNER_RESUME_MONITOR_READY=""
RUNNER_RESUME_MONITOR_PID=""
RUNNER_RESUME_MONITOR_START_IDENTITY=""
RUNNER_DURABLE_FENCE_INVENTORY=""
RUNNER_DURABLE_FENCE_BASELINE_PATH=""
RUNNER_DURABLE_FENCE_BASELINE_SHA256=""
RESTORE_OPERATION_FENCE_ACTIVE_IDENTITY=""
RESTORE_OPERATION_FENCE_PRE_TRANSITION_ACTIVE_IDENTITY=""
RESTORE_WRITER_MONITOR_DIR=""
RESTORE_WRITER_MONITOR_CONTRACT=""
RESTORE_WRITER_MONITOR_CONTRACT_SHA256=""
RESTORE_WRITER_MONITOR_BASELINE=""
RESTORE_WRITER_MONITOR_BASELINE_SHA256=""
RESTORE_WRITER_MONITOR_STOP=""
RESTORE_WRITER_MONITOR_FAILURE=""
RESTORE_WRITER_MONITOR_READY=""
RESTORE_WRITER_MONITOR_PROGRESS=""
RESTORE_WRITER_MONITOR_FINAL=""
RESTORE_WRITER_MONITOR_PID=""
RESTORE_WRITER_MONITOR_START_IDENTITY=""
RESTORE_WRITER_MONITOR_AUTHORITY_SHA256=""
RESTORE_WRITER_MONITOR_STARTED=0
RESTORE_WRITER_MONITOR_JOINED=0
RESTORE_WRITER_MONITOR_VERIFIED_STOPPED=0
RESTORE_DURABLE_MONITOR_DIR=""
RESTORE_DURABLE_MONITOR_STOP=""
RESTORE_DURABLE_MONITOR_FAILURE=""
RESTORE_DURABLE_MONITOR_READY=""
RESTORE_DURABLE_MONITOR_PROGRESS=""
RESTORE_DURABLE_MONITOR_FINAL=""
RESTORE_DURABLE_MONITOR_PID=""
RESTORE_DURABLE_MONITOR_START_IDENTITY=""
RESTORE_DURABLE_MONITOR_CAPABILITY_SHA256=""
RESTORE_DURABLE_MONITOR_AUTHORITY_SHA256=""
RESTORE_DURABLE_MONITOR_STARTED=0
RESTORE_DURABLE_MONITOR_JOINED=0
RESTORE_DURABLE_MONITOR_VERIFIED_STOPPED=0
SERIALIZATION_LEASE_OWNED=0
RUNNER_ROLE_UID=""
RUNNER_ROLE_RESOURCE_VERSION=""
FAILCLOSE_RUNNER_ROLE_UID=""
FAILCLOSE_RUNNER_ROLE_RESOURCE_VERSION=""
RESTORE_VALUES_SNAPSHOT=""
RESTORE_HISTORICAL_VALUES_SNAPSHOT=""
RESTORE_MANIFEST_SNAPSHOT=""
RESTORE_CUTOVER_KEY_SNAPSHOT=""
RESTORE_PENDING_SIGNAL_STATUS=0
RESTORE_INTERRUPT_IN_PROGRESS=0
RESTORE_CLEANUP_IN_PROGRESS=0
# A newly created lock may be released on failure/interruption only until the
# first restore mutation begins. Locks adopted from an earlier restore phase
# are never treated as locally disposable.
RESTORE_LOCK_RELEASE_ON_INTERRUPT=0
RECOVERY_COLD_REBIND_OPERATION_ID=""
RECOVERY_TARGET_CLUSTER_UID=""

restore_record_pending_signal() {
  local status="$1"
  [[ "$status" == 130 || "$status" == 143 ]] || return 2
  if [[ "$RESTORE_PENDING_SIGNAL_STATUS" == 0 ]]; then
    RESTORE_PENDING_SIGNAL_STATUS="$status"
    # Preserve the first cooperative interruption while a remote or local
    # capability is being bound to its cleanup identity. Suppress repeats until
    # the boundary is internally consistent.
    trap '' INT TERM
  fi
}

restore_driver_signal_traps() {
  if [[ "$RESTORE_INTERRUPT_IN_PROGRESS" == 1 ]]; then
    trap '' INT TERM
  else
    trap 'driver_interrupted 130' INT
    trap 'driver_interrupted 143' TERM
  fi
}

restore_finish_pending_signal_boundary() {
  local boundary_status="$1" pending_signal_status
  restore_driver_signal_traps
  pending_signal_status="$RESTORE_PENDING_SIGNAL_STATUS"
  RESTORE_PENDING_SIGNAL_STATUS=0
  if [[ "$pending_signal_status" != 0 &&
        "$RESTORE_INTERRUPT_IN_PROGRESS" == 0 ]]; then
    driver_interrupted "$pending_signal_status"
  fi
  [[ "$boundary_status" == 0 ]]
}

snapshot_restore_private_file() {
  local destination_variable="$1" source_path="$2" label="$3"
  local snapshot_dir="" snapshot_path="" raw_snapshot_path=""
  local canonical_snapshot_path="" acquisition_status=0
  [[ -n "$destination_variable" && -n "$label" ]] || return 2
  # A private inode must be reachable through the caller-owned global before
  # interruption is honored. Record the first signal across mktemp creation
  # through that capability assignment, then honor it after local state is
  # internally consistent.
  RESTORE_PENDING_SIGNAL_STATUS=0
  trap 'restore_record_pending_signal 130' INT
  trap 'restore_record_pending_signal 143' TERM
  if snapshot_dir="$(
       mktemp -d "${TMPDIR:-/tmp}/yenhubs-restore-$label.XXXXXX"
     )"; then
    chmod 700 "$snapshot_dir" || acquisition_status=1
  else
    acquisition_status=1
  fi
  if [[ "$acquisition_status" == 0 ]]; then
    if raw_snapshot_path="$(mktemp "$snapshot_dir/input.XXXXXX")"; then
      snapshot_path="$raw_snapshot_path"
      if canonical_snapshot_path="$(
           cd "$(dirname "$raw_snapshot_path")" &&
           printf '%s/%s\n' "$(pwd -P)" "$(basename "$raw_snapshot_path")"
         )"; then
        snapshot_path="$canonical_snapshot_path"
      else
        acquisition_status=1
      fi
    else
      acquisition_status=1
    fi
  fi
  if [[ "$acquisition_status" == 0 ]]; then
    printf -v "$destination_variable" '%s' "$snapshot_path"
  fi
  if [[ "$acquisition_status" != 0 ]]; then
    [[ -z "$snapshot_path" ]] || rm -f -- "$snapshot_path"
    [[ -z "$snapshot_dir" ]] || rmdir "$snapshot_dir" 2>/dev/null || :
  fi
  restore_finish_pending_signal_boundary "$acquisition_status" || return 1
  if ! command node "$SCRIPT_DIR/snapshot-private-file.mjs" \
    "$source_path" "$snapshot_path"; then
    rm -f -- "$snapshot_path"
    rmdir "$snapshot_dir" 2>/dev/null
    printf -v "$destination_variable" '%s' ""
    printf 'Could not bind a private immutable restore %s snapshot.\n' "$label" >&2
    return 1
  fi
}

materialize_historical_source_values() {
  local snapshot_dir="" snapshot_path="" raw_snapshot_path="" source_epoch
  local canonical_snapshot_path="" acquisition_status=0
  [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == durable-v2 ]] || return 2
  source_epoch="$(jq -er '
    .bot_runner_runtime.recovery_epoch |
    select(.state == "bound") |
    .value | select(type == "string" and
      test("^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$"))
  ' "$RECOVERY_DEPLOYMENT_INVENTORY_COPY")" || return 1
  RESTORE_PENDING_SIGNAL_STATUS=0
  trap 'restore_record_pending_signal 130' INT
  trap 'restore_record_pending_signal 143' TERM
  if snapshot_dir="$(mktemp -d \
       "${TMPDIR:-/tmp}/yenhubs-restore-source-values.XXXXXX")"; then
    chmod 700 "$snapshot_dir" || acquisition_status=1
  else
    acquisition_status=1
  fi
  if [[ "$acquisition_status" == 0 ]]; then
    if raw_snapshot_path="$(mktemp "$snapshot_dir/input.XXXXXX")"; then
      snapshot_path="$raw_snapshot_path"
      if canonical_snapshot_path="$(
           cd "$(dirname "$raw_snapshot_path")" &&
           printf '%s/%s\n' "$(pwd -P)" "$(basename "$raw_snapshot_path")"
         )"; then
        snapshot_path="$canonical_snapshot_path"
      else
        acquisition_status=1
      fi
    else
      acquisition_status=1
    fi
  fi
  if [[ "$acquisition_status" == 0 ]]; then
    RESTORE_HISTORICAL_VALUES_SNAPSHOT="$snapshot_path"
  fi
  if [[ "$acquisition_status" != 0 ]]; then
    [[ -z "$snapshot_path" ]] || rm -f -- "$snapshot_path"
    [[ -z "$snapshot_dir" ]] || rmdir "$snapshot_dir" 2>/dev/null || :
  fi
  restore_finish_pending_signal_boundary "$acquisition_status" || return 1
  if ! printf 'Namespace: %s\nBOT_RUNNER_ACTIVATION_PHASE: active\nBOT_RUNNER_RECOVERY_PHASE: active\nBOT_RUNNER_RECOVERY_EPOCH: %s\n' \
    "$NAMESPACE" "$source_epoch" >"$snapshot_path" ||
     ! chmod 600 "$snapshot_path"; then
    rm -f -- "$snapshot_path"
    rmdir "$snapshot_dir" 2>/dev/null
    RESTORE_HISTORICAL_VALUES_SNAPSHOT=""
    return 1
  fi
}

cleanup_restore_writer_monitor() {
  local monitor_dir_basename="" handoff_temporary
  if [[ "$RESTORE_WRITER_MONITOR_JOINED" == 0 &&
        "$RESTORE_WRITER_MONITOR_PID" =~ ^[1-9][0-9]*$ ]]; then
    recovery_discard_checkpoint_writer_monitor \
      "$RESTORE_WRITER_MONITOR_STOP" "$RESTORE_WRITER_MONITOR_PID" \
      "$RESTORE_WRITER_MONITOR_START_IDENTITY"
  fi
  RESTORE_WRITER_MONITOR_PID=""
  RESTORE_WRITER_MONITOR_START_IDENTITY=""
  if [[ -n "$RESTORE_WRITER_MONITOR_DIR" &&
        -d "$RESTORE_WRITER_MONITOR_DIR" &&
        ! -L "$RESTORE_WRITER_MONITOR_DIR" ]]; then
    monitor_dir_basename="$(basename "$RESTORE_WRITER_MONITOR_DIR")"
    if [[ "$monitor_dir_basename" =~ ^yenhubs-restore-writer-monitor\.[A-Za-z0-9]{6}$ ]]; then
      rm -f -- \
        "$RESTORE_WRITER_MONITOR_CONTRACT" \
        "$RESTORE_WRITER_MONITOR_BASELINE" \
        "$RESTORE_WRITER_MONITOR_STOP" \
        "$RESTORE_WRITER_MONITOR_FAILURE" \
        "$RESTORE_WRITER_MONITOR_READY" \
        "${RESTORE_WRITER_MONITOR_READY}.authority.json" \
        "$RESTORE_WRITER_MONITOR_PROGRESS" \
        "${RESTORE_WRITER_MONITOR_PROGRESS}.next" \
        "$RESTORE_WRITER_MONITOR_FINAL" \
        "${RESTORE_WRITER_MONITOR_FINAL}.next"
      for handoff_temporary in \
        "$RESTORE_WRITER_MONITOR_DIR"/.checkpoint-writer-handoff.*; do
        [[ -e "$handoff_temporary" || -L "$handoff_temporary" ]] || continue
        [[ -f "$handoff_temporary" && ! -L "$handoff_temporary" ]] || continue
        rm -f -- "$handoff_temporary"
      done
      rmdir "$RESTORE_WRITER_MONITOR_DIR" 2>/dev/null || :
    fi
  fi
  RESTORE_WRITER_MONITOR_DIR=""
  RESTORE_WRITER_MONITOR_CONTRACT=""
  RESTORE_WRITER_MONITOR_CONTRACT_SHA256=""
  RESTORE_WRITER_MONITOR_BASELINE=""
  RESTORE_WRITER_MONITOR_BASELINE_SHA256=""
  RESTORE_WRITER_MONITOR_STOP=""
  RESTORE_WRITER_MONITOR_FAILURE=""
  RESTORE_WRITER_MONITOR_READY=""
  RESTORE_WRITER_MONITOR_PROGRESS=""
  RESTORE_WRITER_MONITOR_FINAL=""
  RESTORE_WRITER_MONITOR_AUTHORITY_SHA256=""
  RESTORE_WRITER_MONITOR_STARTED=0
  RESTORE_WRITER_MONITOR_JOINED=0
  RESTORE_WRITER_MONITOR_VERIFIED_STOPPED=0
}

run_restore_live_reactivation_verifier() {
  local verifier="$SCRIPT_DIR/verify-live-reactivation.sh"
  if [[ -n "${YENHUBS_RECOVERY_LIVE_REACTIVATION_VERIFIER:-}" ]]; then
    recovery_require_local_fixture_attestation || {
      printf 'A live reactivation verifier override is allowed only in the isolated fixture context.\n' >&2
      return 1
    }
    verifier="$YENHUBS_RECOVERY_LIVE_REACTIVATION_VERIFIER"
  fi
  recovery_require_regular_direct_file "$verifier" || {
    printf 'The live reactivation verifier is unavailable or unsafe.\n' >&2
    return 1
  }
  VALUES_FILE="$VALUES_SOURCE_FILE" bash "$verifier"
}

start_restore_writer_monitor() {
  local tmp_root start_status=0
  [[ "$RESTORE_WRITER_MONITOR_STARTED" == 0 &&
     "$RESTORE_WRITER_MONITOR_JOINED" == 0 &&
     "$RESTORE_WRITER_MONITOR_VERIFIED_STOPPED" == 0 &&
     -z "$RESTORE_WRITER_MONITOR_PID" &&
     -z "$RESTORE_WRITER_MONITOR_START_IDENTITY" ]] || return 2
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  recovery_consumer_contract_is_acceptable \
    "$RECOVERY_CONSUMER_CONTRACT_JSON" || return 1
  tmp_root="$(recovery_canonical_private_tmp_root)" || return 1
  RESTORE_WRITER_MONITOR_DIR="$(mktemp -d \
    "$tmp_root/yenhubs-restore-writer-monitor.XXXXXX")" || return 1
  chmod 700 "$RESTORE_WRITER_MONITOR_DIR" || {
    rmdir "$RESTORE_WRITER_MONITOR_DIR" 2>/dev/null || :
    RESTORE_WRITER_MONITOR_DIR=""
    return 1
  }
  RESTORE_WRITER_MONITOR_CONTRACT="$RESTORE_WRITER_MONITOR_DIR/consumer-contract.json"
  RESTORE_WRITER_MONITOR_BASELINE="$RESTORE_WRITER_MONITOR_DIR/baseline.json"
  RESTORE_WRITER_MONITOR_STOP="$RESTORE_WRITER_MONITOR_DIR/stop"
  RESTORE_WRITER_MONITOR_FAILURE="$RESTORE_WRITER_MONITOR_DIR/failure"
  RESTORE_WRITER_MONITOR_READY="$RESTORE_WRITER_MONITOR_DIR/ready"
  RESTORE_WRITER_MONITOR_PROGRESS="$RESTORE_WRITER_MONITOR_DIR/progress"
  RESTORE_WRITER_MONITOR_FINAL="$RESTORE_WRITER_MONITOR_DIR/final"
  if ! {
    printf '%s\n' "$RECOVERY_CONSUMER_CONTRACT_JSON" \
      >"$RESTORE_WRITER_MONITOR_CONTRACT" &&
    : >"$RESTORE_WRITER_MONITOR_BASELINE" &&
    : >"$RESTORE_WRITER_MONITOR_STOP" &&
    : >"$RESTORE_WRITER_MONITOR_FAILURE" &&
    : >"$RESTORE_WRITER_MONITOR_READY" &&
    : >"$RESTORE_WRITER_MONITOR_PROGRESS" &&
    : >"$RESTORE_WRITER_MONITOR_FINAL" &&
    chmod 600 \
      "$RESTORE_WRITER_MONITOR_CONTRACT" \
      "$RESTORE_WRITER_MONITOR_BASELINE" \
      "$RESTORE_WRITER_MONITOR_STOP" \
      "$RESTORE_WRITER_MONITOR_FAILURE" \
      "$RESTORE_WRITER_MONITOR_READY" \
      "$RESTORE_WRITER_MONITOR_PROGRESS" \
      "$RESTORE_WRITER_MONITOR_FINAL";
  }; then
    cleanup_restore_writer_monitor
    return 1
  fi
  RESTORE_WRITER_MONITOR_CONTRACT_SHA256="$(recovery_sha256_digest \
    "$RESTORE_WRITER_MONITOR_CONTRACT")" || {
    cleanup_restore_writer_monitor
    return 1
  }

  RESTORE_PENDING_SIGNAL_STATUS=0
  trap 'restore_record_pending_signal 130' INT
  trap 'restore_record_pending_signal 143' TERM
  if ! recovery_start_checkpoint_writer_monitor \
      "$RESTORE_WRITER_MONITOR_CONTRACT" \
      "$RESTORE_WRITER_MONITOR_CONTRACT_SHA256" \
      "$RESTORE_WRITER_MONITOR_BASELINE" \
      "$RESTORE_WRITER_MONITOR_STOP" \
      "$RESTORE_WRITER_MONITOR_FAILURE" \
      "$RESTORE_WRITER_MONITOR_READY" \
      "$RESTORE_WRITER_MONITOR_PROGRESS" \
      "$RESTORE_WRITER_MONITOR_FINAL" \
      RESTORE_WRITER_MONITOR_PID \
      RESTORE_WRITER_MONITOR_START_IDENTITY \
      RESTORE_WRITER_MONITOR_BASELINE_SHA256 \
      "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" \
      checkpoint-restore; then
    start_status=1
  else
    if RESTORE_WRITER_MONITOR_AUTHORITY_SHA256="$(
      recovery_monitor_authority_sha256_for_ready \
        "$RESTORE_WRITER_MONITOR_READY"
    )"; then
      RESTORE_WRITER_MONITOR_STARTED=1
    else
      start_status=1
    fi
  fi
  if [[ "$start_status" != 0 ]]; then
    cleanup_restore_writer_monitor
  fi
  restore_finish_pending_signal_boundary "$start_status"
}

require_restore_writer_monitor_healthy() {
  [[ "$RESTORE_WRITER_MONITOR_STARTED" == 1 &&
     "$RESTORE_WRITER_MONITOR_VERIFIED_STOPPED" == 0 &&
     "$(recovery_monitor_authority_sha256_for_ready \
       "$RESTORE_WRITER_MONITOR_READY" 2>/dev/null || :)" == \
       "$RESTORE_WRITER_MONITOR_AUTHORITY_SHA256" ]] || return 1
  recovery_require_checkpoint_writer_monitor_healthy \
    "$RESTORE_WRITER_MONITOR_CONTRACT" \
    "$RESTORE_WRITER_MONITOR_CONTRACT_SHA256" \
    "$RESTORE_WRITER_MONITOR_BASELINE" \
    "$RESTORE_WRITER_MONITOR_BASELINE_SHA256" \
    "$RESTORE_WRITER_MONITOR_FAILURE" \
    "$RESTORE_WRITER_MONITOR_READY" \
    "$RESTORE_WRITER_MONITOR_PID" \
    "$RESTORE_WRITER_MONITOR_START_IDENTITY" \
    "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" \
    checkpoint-restore
}

stop_restore_writer_monitor_after_restore() {
  local final_json="" deployment index expected_uid resource_version
  local stop_status=0
  if [[ "$RESTORE_WRITER_MONITOR_VERIFIED_STOPPED" == 1 ]]; then
    [[ -z "$RESTORE_WRITER_MONITOR_PID" &&
       -z "$RESTORE_WRITER_MONITOR_START_IDENTITY" ]]
    return
  fi
  [[ "$RESTORE_WRITER_MONITOR_STARTED" == 1 ]] || return 1
  RESTORE_PENDING_SIGNAL_STATUS=0
  trap 'restore_record_pending_signal 130' INT
  trap 'restore_record_pending_signal 143' TERM
  if ! recovery_stop_checkpoint_writer_monitor \
      "$RESTORE_WRITER_MONITOR_CONTRACT" \
      "$RESTORE_WRITER_MONITOR_CONTRACT_SHA256" \
      "$RESTORE_WRITER_MONITOR_BASELINE" \
      "$RESTORE_WRITER_MONITOR_BASELINE_SHA256" \
      "$RESTORE_WRITER_MONITOR_STOP" \
      "$RESTORE_WRITER_MONITOR_FAILURE" \
      "$RESTORE_WRITER_MONITOR_READY" \
      "$RESTORE_WRITER_MONITOR_FINAL" \
      "$RESTORE_WRITER_MONITOR_PID" \
      "$RESTORE_WRITER_MONITOR_START_IDENTITY" \
      RESTORE_WRITER_MONITOR_JOINED \
      "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" \
      checkpoint-restore; then
    stop_status=1
  fi
  if [[ "$stop_status" == 0 ]]; then
    final_json="$(<"$RESTORE_WRITER_MONITOR_FINAL")"
    recovery_checkpoint_writer_monitor_final_json_is_acceptable \
      "$final_json" "$RESTORE_WRITER_MONITOR_CONTRACT" \
      "$RESTORE_WRITER_MONITOR_AUTHORITY_SHA256" || stop_status=1
  fi
  if [[ "$stop_status" == 0 ]]; then
    for index in "${!CONSUMERS[@]}"; do
      deployment="${CONSUMERS[$index]}"
      expected_uid="${DEPLOYMENT_UIDS[$index]}"
      if ! resource_version="$(jq -er --arg name "$deployment" \
          --arg uid "$expected_uid" '
        [.deployments[] | select(.name == $name and .uid == $uid)] |
        select(length == 1) | .[0].resource_version
      ' <<<"$final_json")" || [[ -z "$resource_version" ]]; then
        stop_status=1
        break
      fi
      DEPLOYMENT_RESOURCE_VERSIONS[index]="$resource_version"
    done
  fi
  if [[ "$stop_status" == 0 ]]; then
    RESTORE_WRITER_MONITOR_PID=""
    RESTORE_WRITER_MONITOR_START_IDENTITY=""
    RESTORE_WRITER_MONITOR_VERIFIED_STOPPED=1
  fi
  if ! restore_finish_pending_signal_boundary "$stop_status"; then
    return 1
  fi
  if [[ "$stop_status" != 0 ]]; then
    printf 'Continuous restore writer monitoring failed; retaining fail-closed restore state.\n' >&2
    return 1
  fi
}

handoff_restore_writer_monitor_with_receipt() {
  local handoff_token="" armed_json="" ack_json=""
  local armed_resource_version="" patch_resource_version=""
  local deployment expected_uid resource_version index handoff_status=0
  local -a acknowledged_resource_versions=()
  [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == legacy-absent &&
     "$RECOVERY_OPERATION_OWNER" == checkpoint-restore &&
     "$RECOVERY_OPERATION_STATE" == legacy-in-place &&
     "$RESTORE_WRITER_MONITOR_STARTED" == 1 &&
     "$RESTORE_WRITER_MONITOR_JOINED" == 0 &&
     "$RESTORE_WRITER_MONITOR_VERIFIED_STOPPED" == 0 ]] || return 2
  require_restore_writer_monitor_healthy || return 1
  require_runner_resume_monitor_healthy || return 1

  # ARM is a local-only preparation step. Honor an interruption before the
  # metadata receipt is created, so cleanup can discard the still-live watcher
  # while every fixed writer remains at zero.
  RESTORE_PENDING_SIGNAL_STATUS=0
  trap 'restore_record_pending_signal 130' INT
  trap 'restore_record_pending_signal 143' TERM
  if ! recovery_arm_checkpoint_writer_receipt_handoff \
      "$RESTORE_WRITER_MONITOR_CONTRACT" \
      "$RESTORE_WRITER_MONITOR_CONTRACT_SHA256" \
      "$RESTORE_WRITER_MONITOR_BASELINE" \
      "$RESTORE_WRITER_MONITOR_BASELINE_SHA256" \
      "$RESTORE_WRITER_MONITOR_STOP" \
      "$RESTORE_WRITER_MONITOR_FAILURE" \
      "$RESTORE_WRITER_MONITOR_READY" \
      "$RESTORE_WRITER_MONITOR_PROGRESS" \
      "$RESTORE_WRITER_MONITOR_FINAL" \
      "$RESTORE_WRITER_MONITOR_PID" \
      "$RESTORE_WRITER_MONITOR_START_IDENTITY" \
      "$RESTORE_WRITER_MONITOR_AUTHORITY_SHA256" \
      legacy-absent checkpoint-restore reticulum "${DEPLOYMENT_UIDS[0]}" \
      handoff_token armed_json; then
    handoff_status=1
  fi
  if ! restore_finish_pending_signal_boundary "$handoff_status"; then
    printf 'Could not arm the exact legacy writer receipt handoff.\n' >&2
    return 1
  fi
  armed_resource_version="$(jq -er --arg name reticulum \
    --arg uid "${DEPLOYMENT_UIDS[0]}" '
    [.deployments[] | select(.name == $name and .uid == $uid)] |
    select(length == 1) | .[0].resource_version |
    select(type == "string" and length > 0)
  ' <<<"$armed_json")" || return 1

  # Once the direct PATCH response is available, a cooperative signal is
  # deferred through COMMIT/ACK. That preserves one unambiguous authority
  # owner: either the live watcher, or the receipt bound to the terminal RV.
  RESTORE_PENDING_SIGNAL_STATUS=0
  trap 'restore_record_pending_signal 130' INT
  trap 'restore_record_pending_signal 143' TERM
  require_runner_resume_monitor_healthy || handoff_status=1
  if [[ "$handoff_status" == 0 ]]; then
    patch_resource_version="$(recovery_publish_checkpoint_resume_receipt_exact \
      reticulum "${DEPLOYMENT_UIDS[0]}" "$armed_resource_version" \
      "${DEPLOYMENT_SELECTORS[0]}" "${DEPLOYMENT_FINGERPRINTS[0]}" \
      "$RESTORE_OPERATION_ID")" || handoff_status=1
  fi
  if [[ "$handoff_status" == 0 ]]; then
    recovery_commit_checkpoint_writer_receipt_handoff \
      "$RESTORE_WRITER_MONITOR_CONTRACT" \
      "$RESTORE_WRITER_MONITOR_CONTRACT_SHA256" \
      "$RESTORE_WRITER_MONITOR_BASELINE" \
      "$RESTORE_WRITER_MONITOR_BASELINE_SHA256" \
      "$RESTORE_WRITER_MONITOR_STOP" \
      "$RESTORE_WRITER_MONITOR_FAILURE" \
      "$RESTORE_WRITER_MONITOR_READY" \
      "$RESTORE_WRITER_MONITOR_PROGRESS" \
      "$RESTORE_WRITER_MONITOR_FINAL" \
      "$RESTORE_WRITER_MONITOR_PID" \
      "$RESTORE_WRITER_MONITOR_START_IDENTITY" \
      "$RESTORE_WRITER_MONITOR_AUTHORITY_SHA256" \
      legacy-absent checkpoint-restore reticulum "${DEPLOYMENT_UIDS[0]}" \
      "$handoff_token" "$armed_json" "$patch_resource_version" \
      RESTORE_WRITER_MONITOR_JOINED ack_json || handoff_status=1
  fi
  if [[ "$handoff_status" == 0 ]]; then
    for index in "${!CONSUMERS[@]}"; do
      deployment="${CONSUMERS[$index]}"
      expected_uid="${DEPLOYMENT_UIDS[$index]}"
      resource_version="$(jq -er --arg name "$deployment" \
        --arg uid "$expected_uid" '
        [.deployments[] | select(.name == $name and .uid == $uid)] |
        select(length == 1) | .[0].resource_version |
        select(type == "string" and length > 0)
      ' <<<"$ack_json")" || {
        handoff_status=1
        break
      }
      acknowledged_resource_versions[index]="$resource_version"
    done
  fi
  if [[ "$handoff_status" == 0 ]]; then
    for index in "${!CONSUMERS[@]}"; do
      DEPLOYMENT_RESOURCE_VERSIONS[index]="${acknowledged_resource_versions[$index]}"
    done
    RESTORE_WRITER_MONITOR_PID=""
    RESTORE_WRITER_MONITOR_START_IDENTITY=""
    RESTORE_WRITER_MONITOR_VERIFIED_STOPPED=1
  fi
  if ! restore_finish_pending_signal_boundary "$handoff_status"; then
    printf 'Legacy writer receipt handoff failed; retaining five-zero state and the restore lock.\n' >&2
    return 1
  fi
}

capture_stale_checkpoint_resume_receipt_inventory() {
  local state_variable="$1" resource_version_variable="$2"
  local index deployment state_line receipt_state receipt_resource_version
  local exact_count=0 target_state=absent target_resource_version=""
  [[ "$state_variable" =~ ^[A-Za-z_][A-Za-z0-9_]*$ &&
     "$resource_version_variable" =~ ^[A-Za-z_][A-Za-z0-9_]*$ &&
     "$state_variable" != "$resource_version_variable" &&
     "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" =~ ^(legacy-absent|durable-v2)$ ]] ||
    return 2
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  for index in "${!CONSUMERS[@]}"; do
    deployment="${CONSUMERS[$index]}"
    state_line="$(recovery_capture_checkpoint_resume_receipt_state_exact \
      "$deployment" "${DEPLOYMENT_UIDS[$index]}" 0 \
      "${DEPLOYMENT_SELECTORS[$index]}" "${DEPLOYMENT_FINGERPRINTS[$index]}" \
      "$RESTORE_OPERATION_ID")" || return 1
    IFS=$'\t' read -r receipt_state receipt_resource_version <<<"$state_line"
    [[ "$receipt_state" == absent || "$receipt_state" == exact ]] || return 1
    [[ -n "$receipt_resource_version" ]] || return 1
    if [[ "$deployment" == reticulum ]]; then
      target_state="$receipt_state"
      target_resource_version="$receipt_resource_version"
    fi
    if [[ "$receipt_state" == exact ]]; then
      exact_count=$((exact_count + 1))
      [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == legacy-absent &&
         "$deployment" == reticulum && "$index" == 0 ]] || return 1
    fi
  done
  if [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == durable-v2 ]]; then
    [[ "$exact_count" == 0 ]] || return 1
  else
    [[ "$exact_count" -le 1 ]] || return 1
  fi
  [[ -n "$target_resource_version" ]] || return 1
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  printf -v "$state_variable" '%s' "$target_state"
  printf -v "$resource_version_variable" '%s' "$target_resource_version"
}

cleanup_restore_durable_monitor() {
  local monitor_dir_basename=""
  if [[ "$RESTORE_DURABLE_MONITOR_JOINED" == 0 &&
        "$RESTORE_DURABLE_MONITOR_PID" =~ ^[1-9][0-9]*$ ]]; then
    recovery_discard_durable_runner_quiescence_monitor \
      "$RESTORE_DURABLE_MONITOR_STOP" \
      "$RESTORE_DURABLE_MONITOR_PID" \
      "$RESTORE_DURABLE_MONITOR_START_IDENTITY"
  fi
  RESTORE_DURABLE_MONITOR_PID=""
  RESTORE_DURABLE_MONITOR_START_IDENTITY=""
  if [[ -n "$RESTORE_DURABLE_MONITOR_DIR" &&
        -d "$RESTORE_DURABLE_MONITOR_DIR" &&
        ! -L "$RESTORE_DURABLE_MONITOR_DIR" ]]; then
    monitor_dir_basename="$(basename "$RESTORE_DURABLE_MONITOR_DIR")"
    if [[ "$monitor_dir_basename" =~ ^yenhubs-restore-durable-monitor\.[A-Za-z0-9]{6}$ ]]; then
      rm -f -- \
        "$RUNNER_DURABLE_FENCE_BASELINE_PATH" \
        "$RESTORE_DURABLE_MONITOR_STOP" \
        "$RESTORE_DURABLE_MONITOR_FAILURE" \
        "$RESTORE_DURABLE_MONITOR_READY" \
        "${RESTORE_DURABLE_MONITOR_READY}.authority.json" \
        "$RESTORE_DURABLE_MONITOR_PROGRESS" \
        "${RESTORE_DURABLE_MONITOR_PROGRESS}.next" \
        "$RESTORE_DURABLE_MONITOR_FINAL"
      rmdir "$RESTORE_DURABLE_MONITOR_DIR" 2>/dev/null || :
    fi
  fi
  RESTORE_DURABLE_MONITOR_DIR=""
  RUNNER_DURABLE_FENCE_BASELINE_PATH=""
  RUNNER_DURABLE_FENCE_BASELINE_SHA256=""
  RESTORE_DURABLE_MONITOR_STOP=""
  RESTORE_DURABLE_MONITOR_FAILURE=""
  RESTORE_DURABLE_MONITOR_READY=""
  RESTORE_DURABLE_MONITOR_PROGRESS=""
  RESTORE_DURABLE_MONITOR_FINAL=""
  RESTORE_DURABLE_MONITOR_CAPABILITY_SHA256=""
  RESTORE_DURABLE_MONITOR_AUTHORITY_SHA256=""
  RESTORE_DURABLE_MONITOR_STARTED=0
  RESTORE_DURABLE_MONITOR_JOINED=0
  RESTORE_DURABLE_MONITOR_VERIFIED_STOPPED=0
}

start_restore_durable_monitor() {
  local tmp_root start_status=0
  [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == durable-v2 &&
     "$RESTORE_DURABLE_MONITOR_STARTED" == 0 &&
     "$RESTORE_DURABLE_MONITOR_JOINED" == 0 &&
     "$RESTORE_DURABLE_MONITOR_VERIFIED_STOPPED" == 0 &&
     -z "$RESTORE_DURABLE_MONITOR_PID" &&
     -z "$RESTORE_DURABLE_MONITOR_START_IDENTITY" &&
     -n "$RUNNER_DURABLE_FENCE_INVENTORY" &&
     -n "$RESTORE_OPERATION_FENCE_ACTIVE_IDENTITY" ]] || return 2
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  recovery_require_recovery_operation_fence_state active \
    "$RESTORE_OPERATION_FENCE_ACTIVE_IDENTITY" || return 1
  require_restore_writer_monitor_healthy || return 1
  recovery_durable_fence_inventory_json_is_canonical \
    "$RUNNER_DURABLE_FENCE_INVENTORY" || return 1
  [[ "$(recovery_capture_durable_quiescence)" == \
     "$RUNNER_DURABLE_FENCE_INVENTORY" ]] || return 1

  tmp_root="$(recovery_canonical_private_tmp_root)" || return 1
  RESTORE_DURABLE_MONITOR_DIR="$(mktemp -d \
    "$tmp_root/yenhubs-restore-durable-monitor.XXXXXX")" || return 1
  chmod 700 "$RESTORE_DURABLE_MONITOR_DIR" || {
    rmdir "$RESTORE_DURABLE_MONITOR_DIR" 2>/dev/null || :
    RESTORE_DURABLE_MONITOR_DIR=""
    return 1
  }
  RUNNER_DURABLE_FENCE_BASELINE_PATH="$RESTORE_DURABLE_MONITOR_DIR/fences.json"
  RESTORE_DURABLE_MONITOR_STOP="$RESTORE_DURABLE_MONITOR_DIR/stop"
  RESTORE_DURABLE_MONITOR_FAILURE="$RESTORE_DURABLE_MONITOR_DIR/failure"
  RESTORE_DURABLE_MONITOR_READY="$RESTORE_DURABLE_MONITOR_DIR/ready"
  RESTORE_DURABLE_MONITOR_PROGRESS="$RESTORE_DURABLE_MONITOR_DIR/progress"
  RESTORE_DURABLE_MONITOR_FINAL="$RESTORE_DURABLE_MONITOR_DIR/final"
  if ! {
    # The monitor pins these exact canonical bytes; a trailing LF is forbidden.
    printf '%s' "$RUNNER_DURABLE_FENCE_INVENTORY" \
      >"$RUNNER_DURABLE_FENCE_BASELINE_PATH" &&
    : >"$RESTORE_DURABLE_MONITOR_STOP" &&
    : >"$RESTORE_DURABLE_MONITOR_FAILURE" &&
    : >"$RESTORE_DURABLE_MONITOR_READY" &&
    : >"$RESTORE_DURABLE_MONITOR_PROGRESS" &&
    : >"$RESTORE_DURABLE_MONITOR_FINAL" &&
    chmod 600 \
      "$RUNNER_DURABLE_FENCE_BASELINE_PATH" \
      "$RESTORE_DURABLE_MONITOR_STOP" \
      "$RESTORE_DURABLE_MONITOR_FAILURE" \
      "$RESTORE_DURABLE_MONITOR_READY" \
      "$RESTORE_DURABLE_MONITOR_PROGRESS" \
      "$RESTORE_DURABLE_MONITOR_FINAL";
  }; then
    cleanup_restore_durable_monitor
    return 1
  fi
  RUNNER_DURABLE_FENCE_BASELINE_SHA256="$(recovery_sha256_digest \
    "$RUNNER_DURABLE_FENCE_BASELINE_PATH")" || {
    cleanup_restore_durable_monitor
    return 1
  }
  recovery_checkpoint_writer_monitor_file_is_exact \
    "$RUNNER_DURABLE_FENCE_BASELINE_PATH" \
    "$RUNNER_DURABLE_FENCE_BASELINE_SHA256" 1048576 || {
    cleanup_restore_durable_monitor
    return 1
  }

  RESTORE_PENDING_SIGNAL_STATUS=0
  trap 'restore_record_pending_signal 130' INT
  trap 'restore_record_pending_signal 143' TERM
  if ! recovery_start_durable_runner_quiescence_monitor \
      "$RUNNER_DURABLE_FENCE_BASELINE_PATH" \
      "$RUNNER_DURABLE_FENCE_BASELINE_SHA256" \
      "$RESTORE_WRITER_MONITOR_BASELINE" \
      "$RESTORE_WRITER_MONITOR_BASELINE_SHA256" \
      "$RESTORE_DURABLE_MONITOR_STOP" \
      "$RESTORE_DURABLE_MONITOR_FAILURE" \
      "$RESTORE_DURABLE_MONITOR_READY" \
      "$RESTORE_DURABLE_MONITOR_PROGRESS" \
      "$RESTORE_DURABLE_MONITOR_FINAL" \
      RESTORE_DURABLE_MONITOR_PID \
      RESTORE_DURABLE_MONITOR_START_IDENTITY \
      RESTORE_DURABLE_MONITOR_CAPABILITY_SHA256 \
      checkpoint-restore; then
    start_status=1
  else
    if RESTORE_DURABLE_MONITOR_AUTHORITY_SHA256="$(
      recovery_monitor_authority_sha256_for_ready \
        "$RESTORE_DURABLE_MONITOR_READY"
    )"; then
      RESTORE_DURABLE_MONITOR_STARTED=1
    else
      start_status=1
    fi
  fi
  if [[ "$start_status" != 0 ]]; then
    cleanup_restore_durable_monitor
  fi
  restore_finish_pending_signal_boundary "$start_status"
}

require_restore_durable_monitor_healthy() {
  [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == durable-v2 &&
     "$RESTORE_DURABLE_MONITOR_STARTED" == 1 &&
     "$RESTORE_DURABLE_MONITOR_VERIFIED_STOPPED" == 0 &&
     "$RESTORE_DURABLE_MONITOR_PID" != "$RESTORE_WRITER_MONITOR_PID" &&
     "$(recovery_monitor_authority_sha256_for_ready \
       "$RESTORE_DURABLE_MONITOR_READY" 2>/dev/null || :)" == \
       "$RESTORE_DURABLE_MONITOR_AUTHORITY_SHA256" ]] || return 1
  recovery_require_recovery_operation_fence_state active \
    "$RESTORE_OPERATION_FENCE_ACTIVE_IDENTITY" &&
    recovery_require_durable_runner_quiescence_monitor_healthy \
      "$RUNNER_DURABLE_FENCE_BASELINE_PATH" \
      "$RUNNER_DURABLE_FENCE_BASELINE_SHA256" \
      "$RESTORE_WRITER_MONITOR_BASELINE" \
      "$RESTORE_WRITER_MONITOR_BASELINE_SHA256" \
      "$RESTORE_DURABLE_MONITOR_FAILURE" \
      "$RESTORE_DURABLE_MONITOR_READY" \
      "$RESTORE_DURABLE_MONITOR_PROGRESS" \
      "$RESTORE_DURABLE_MONITOR_PID" \
      "$RESTORE_DURABLE_MONITOR_START_IDENTITY" \
      "$RESTORE_DURABLE_MONITOR_CAPABILITY_SHA256" \
      checkpoint-restore
}

require_restore_monitors_healthy() {
  require_restore_writer_monitor_healthy &&
    require_restore_durable_monitor_healthy
}

stop_restore_durable_monitor_before_writer() {
  local stop_status=0
  if [[ "$RESTORE_DURABLE_MONITOR_VERIFIED_STOPPED" == 1 ]]; then
    [[ -z "$RESTORE_DURABLE_MONITOR_PID" &&
       -z "$RESTORE_DURABLE_MONITOR_START_IDENTITY" ]]
    return
  fi
  [[ "$RESTORE_DURABLE_MONITOR_STARTED" == 1 ]] || return 1
  RESTORE_PENDING_SIGNAL_STATUS=0
  trap 'restore_record_pending_signal 130' INT
  trap 'restore_record_pending_signal 143' TERM
  if ! recovery_stop_durable_runner_quiescence_monitor \
      "$RUNNER_DURABLE_FENCE_BASELINE_PATH" \
      "$RUNNER_DURABLE_FENCE_BASELINE_SHA256" \
      "$RESTORE_WRITER_MONITOR_BASELINE" \
      "$RESTORE_WRITER_MONITOR_BASELINE_SHA256" \
      "$RESTORE_DURABLE_MONITOR_STOP" \
      "$RESTORE_DURABLE_MONITOR_FAILURE" \
      "$RESTORE_DURABLE_MONITOR_READY" \
      "$RESTORE_DURABLE_MONITOR_PROGRESS" \
      "$RESTORE_DURABLE_MONITOR_FINAL" \
      "$RESTORE_DURABLE_MONITOR_PID" \
      "$RESTORE_DURABLE_MONITOR_START_IDENTITY" \
      "$RESTORE_DURABLE_MONITOR_CAPABILITY_SHA256" \
      RESTORE_DURABLE_MONITOR_JOINED \
      checkpoint-restore; then
    stop_status=1
  fi
  if [[ "$stop_status" == 0 ]]; then
    RESTORE_DURABLE_MONITOR_PID=""
    RESTORE_DURABLE_MONITOR_START_IDENTITY=""
    RESTORE_DURABLE_MONITOR_VERIFIED_STOPPED=1
  fi
  if ! restore_finish_pending_signal_boundary "$stop_status"; then
    return 1
  fi
  if [[ "$stop_status" != 0 ]]; then
    printf 'Durable runner monitoring failed; retaining the active fence.\n' >&2
    return 1
  fi
}

discard_runner_resume_monitor() {
  if [[ "$RUNNER_RESUME_MONITOR_PID" =~ ^[1-9][0-9]*$ ]]; then
    recovery_discard_no_managed_bot_runner_watch \
      "$RUNNER_RESUME_MONITOR_STOP" "$RUNNER_RESUME_MONITOR_PID" \
      "$RUNNER_RESUME_MONITOR_START_IDENTITY"
    RUNNER_RESUME_MONITOR_PID=""
    RUNNER_RESUME_MONITOR_START_IDENTITY=""
  fi
  RUNNER_RESUME_MONITOR_START_IDENTITY=""
  [[ -z "$RUNNER_RESUME_MONITOR_STOP" ]] || rm -f -- "$RUNNER_RESUME_MONITOR_STOP"
  [[ -z "$RUNNER_RESUME_MONITOR_FAILURE" ]] || rm -f -- "$RUNNER_RESUME_MONITOR_FAILURE"
  [[ -z "$RUNNER_RESUME_MONITOR_READY" ]] || rm -f -- "$RUNNER_RESUME_MONITOR_READY"
  RUNNER_RESUME_MONITOR_STOP=""
  RUNNER_RESUME_MONITOR_FAILURE=""
  RUNNER_RESUME_MONITOR_READY=""
  RUNNER_DURABLE_FENCE_INVENTORY=""
}

start_runner_resume_monitor() {
  [[ -z "$RUNNER_RESUME_MONITOR_PID" &&
     -z "$RUNNER_RESUME_MONITOR_START_IDENTITY" ]] || return 2
  [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == legacy-absent ]] || return 1
  recovery_require_no_managed_bot_runner_pods || return 1
  RUNNER_RESUME_MONITOR_STOP="$(mktemp "${TMPDIR:-/tmp}/yenhubs-restore-runner-stop.XXXXXX")" || return 1
  RUNNER_RESUME_MONITOR_FAILURE="$(mktemp "${TMPDIR:-/tmp}/yenhubs-restore-runner-failure.XXXXXX")" || {
    discard_runner_resume_monitor
    return 1
  }
  RUNNER_RESUME_MONITOR_READY="$(mktemp "${TMPDIR:-/tmp}/yenhubs-restore-runner-ready.XXXXXX")" || {
    discard_runner_resume_monitor
    return 1
  }
  chmod 600 "$RUNNER_RESUME_MONITOR_STOP" "$RUNNER_RESUME_MONITOR_FAILURE" \
    "$RUNNER_RESUME_MONITOR_READY"
  if ! recovery_start_no_managed_bot_runner_watch \
    "$RUNNER_RESUME_MONITOR_STOP" "$RUNNER_RESUME_MONITOR_FAILURE" \
    "$RUNNER_RESUME_MONITOR_READY" RUNNER_RESUME_MONITOR_PID \
    RUNNER_RESUME_MONITOR_START_IDENTITY; then
    discard_runner_resume_monitor
    return 1
  fi
}

stop_runner_resume_monitor_before_parent() {
  local monitor_status=0
  [[ -n "$RUNNER_RESUME_MONITOR_PID" ]] || {
    printf 'Managed bot-runner resume monitor was not active before parent start.\n' >&2
    return 1
  }
  [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == legacy-absent &&
     "$RUNNER_RESUME_MONITOR_PID" =~ ^[1-9][0-9]*$ ]] || return 1
  if ! recovery_stop_no_managed_bot_runner_watch \
    "$RUNNER_RESUME_MONITOR_STOP" "$RUNNER_RESUME_MONITOR_FAILURE" \
    "$RUNNER_RESUME_MONITOR_READY" "$RUNNER_RESUME_MONITOR_PID" \
    "$RUNNER_RESUME_MONITOR_START_IDENTITY"; then
    monitor_status=1
  fi
  RUNNER_RESUME_MONITOR_PID=""
  RUNNER_RESUME_MONITOR_START_IDENTITY=""
  rm -f -- "$RUNNER_RESUME_MONITOR_STOP" "$RUNNER_RESUME_MONITOR_FAILURE" \
    "$RUNNER_RESUME_MONITOR_READY"
  RUNNER_RESUME_MONITOR_STOP=""
  RUNNER_RESUME_MONITOR_FAILURE=""
  RUNNER_RESUME_MONITOR_READY=""
  if [[ "$monitor_status" != 0 ]]; then
    printf 'Managed bot-runner Pods reappeared before the parent resume gate.\n' >&2
    return 1
  fi
}

require_runner_resume_monitor_healthy() {
  [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == legacy-absent &&
     "$RUNNER_RESUME_MONITOR_PID" =~ ^[1-9][0-9]*$ ]] || return 1
  if ! recovery_require_no_managed_bot_runner_watch_healthy \
    "$RUNNER_RESUME_MONITOR_FAILURE" "$RUNNER_RESUME_MONITOR_READY" \
    "$RUNNER_RESUME_MONITOR_PID" \
    "$RUNNER_RESUME_MONITOR_START_IDENTITY"; then
    printf 'Managed bot-runner event watcher failed during the coordinated restore window.\n' >&2
    return 1
  fi
}

require_legacy_runner_absence_stable() {
  local stable_seconds started
  stable_seconds="$(recovery_stable_absence_seconds)" || return 1
  started="$SECONDS"
  while :; do
    recovery_require_operation_serialization || return 1
    recovery_require_operation_lock || return 1
    recovery_require_no_managed_bot_runner_pods || return 1
    recovery_require_no_legacy_parent_runner_pods || return 1
    ((SECONDS - started >= stable_seconds)) && return 0
    sleep 1
  done
}

reconcile_checkpoint_runner_quiescence() {
  case "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" in
    legacy-absent)
      recovery_wait_for_no_managed_bot_runner_pods 180s || return 1
      require_legacy_runner_absence_stable
      ;;
    durable-v2)
      recovery_require_durable_runner_quiescence_stable
      ;;
    *)
      return 1
      ;;
  esac
}

require_checkpoint_runner_quiescent_now() {
  local current
  case "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" in
    legacy-absent)
      recovery_require_no_managed_bot_runner_pods &&
        recovery_require_no_legacy_parent_runner_pods
      ;;
    durable-v2)
      if [[ -n "$RUNNER_DURABLE_FENCE_BASELINE_PATH" ||
            -n "$RUNNER_DURABLE_FENCE_BASELINE_SHA256" ]]; then
        recovery_require_checkpoint_runner_quiescence_exact durable-v2 \
          "$RUNNER_DURABLE_FENCE_BASELINE_PATH" \
          "$RUNNER_DURABLE_FENCE_BASELINE_SHA256"
      elif [[ -n "$RUNNER_DURABLE_FENCE_INVENTORY" ]]; then
        current="$(recovery_capture_durable_quiescence)" || return 1
        recovery_durable_fence_inventory_json_is_canonical "$current" &&
          [[ "$current" == "$RUNNER_DURABLE_FENCE_INVENTORY" ]] &&
          recovery_require_no_legacy_parent_runner_pods
      else
        recovery_capture_durable_quiescence >/dev/null &&
          recovery_require_no_legacy_parent_runner_pods
      fi
      ;;
    *)
      return 1
      ;;
  esac
}

require_durable_checkpoint_evidence_live() {
  local live_mode="$1" expected_fence_state="$2"
  local manifest_path="" expected_state="" expected_phase=""
  local values_epoch="" evidence_values_path="$VALUES_SOURCE_FILE"
  [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == durable-v2 ]] || return 0
  [[ "$live_mode" == active-source || "$live_mode" == quiesced-source ||
     "$live_mode" == quiesced-target || "$live_mode" == active-target ||
     "$live_mode" == quiesced-active-target ]] || return 2
  [[ "$expected_fence_state" == dormant ||
     "$expected_fence_state" == active ]] || return 2
  # Cloud restore-fence is a five-zero plus active admission-fence state.
  # A quiesced target with a dormant fifth fence is never executable evidence.
  [[ "$live_mode" != quiesced-target ||
     "$expected_fence_state" == active ]] || return 2
  [[ -n "$RECOVERY_RUNNER_CUTOVER_EVIDENCE_COPY" &&
     -n "$RECOVERY_CHECKPOINT_OPERATION_ID" ]] || return 1
  case "$live_mode" in
    active-source|quiesced-source)
      [[ -n "$RESTORE_HISTORICAL_VALUES_SNAPSHOT" ]] || return 1
      evidence_values_path="$RESTORE_HISTORICAL_VALUES_SNAPSHOT"
      manifest_path=""
      ;;
    quiesced-target)
      expected_state=restore-fence-prepared
      expected_phase=restore-fence
      manifest_path="$RESTORE_MANIFEST_SNAPSHOT"
      ;;
    active-target|quiesced-active-target)
      expected_state=restore-complete-awaiting-reactivation
      expected_phase=active
      manifest_path="$RESTORE_MANIFEST_SNAPSHOT"
      ;;
  esac
  if [[ -n "$expected_state" ]]; then
    values_epoch="$(recovery_runner_epoch_from_values "$VALUES_SOURCE_FILE")" ||
      return 1
    if [[ "$live_mode" == quiesced-target ]]; then
      [[ "$RECOVERY_OPERATION_STATE" == restore-fence-prepared ||
         "$RECOVERY_OPERATION_STATE" == restore-complete-awaiting-reactivation ]] ||
        return 1
    else
      [[ "$RECOVERY_OPERATION_STATE" == "$expected_state" ]] || return 1
    fi
    [[ "$RECOVERY_RUNNER_RUNTIME_GENERATION" == durable-v2 &&
       "$RECOVERY_FENCE_PRE_EPOCH" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ &&
       "$RECOVERY_FENCE_TARGET_EPOCH" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ &&
       "$RECOVERY_FENCE_PRE_EPOCH" != "$RECOVERY_FENCE_TARGET_EPOCH" &&
       "$values_epoch" == "$RECOVERY_FENCE_TARGET_EPOCH" ]] || return 1
    require_owned_restore_lock || return 1
    recovery_require_live_restore_fence_epoch \
      "$VALUES_SOURCE_FILE" "$RECOVERY_FENCE_PRE_EPOCH" || return 1
    recovery_require_live_runner_recovery_phase "$expected_phase" || return 1
  fi
  recovery_verify_runner_cutover_evidence_live \
    "$evidence_values_path" "$RECOVERY_RUNNER_CUTOVER_EVIDENCE_COPY" \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY" "$expected_fence_state" \
    "$manifest_path" "$live_mode"
}

require_durable_checkpoint_evidence_for_parent_state() {
  local expected_fence_state="$1"
  local contract uid resource_version replicas selector fingerprint live_phase mode
  [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == durable-v2 ]] || return 0
  [[ "$expected_fence_state" == dormant ||
     "$expected_fence_state" == active ]] || return 2
  contract="$(recovery_capture_deployment_contract bot-orchestrator)" || return 1
  IFS=$'\t' read -r uid resource_version replicas selector fingerprint <<<"$contract"
  live_phase="$(recovery_live_runner_recovery_phase)" || return 1
  case "$replicas:$live_phase" in
    1:active)
      if [[ "$RECOVERY_OPERATION_STATE" == restore-complete-awaiting-reactivation ]]; then
        mode="active-target"
      else
        mode="active-source"
      fi
      ;;
    0:active)
      if [[ "$RECOVERY_OPERATION_STATE" == restore-complete-awaiting-reactivation ]]; then
        mode="quiesced-active-target"
      else
        mode="quiesced-source"
      fi
      ;;
    0:restore-fence) mode="quiesced-target" ;;
    *) return 1 ;;
  esac
  require_durable_checkpoint_evidence_live "$mode" "$expected_fence_state"
}

restore_lock_json_is_exact() {
  local lock_json="$1"
  RECOVERY_OPERATION_OWNER="checkpoint-restore"
  RECOVERY_OPERATION_LOCK_NAME="$RESTORE_LOCK_NAME"
  RECOVERY_OPERATION_LOCK_UID="$RESTORE_LOCK_UID"
  RECOVERY_OPERATION_LOCK_RESOURCE_VERSION="$RESTORE_LOCK_RESOURCE_VERSION"
  RECOVERY_OPERATION_TOKEN="$RESTORE_LOCK_TOKEN"
  RECOVERY_OPERATION_ID="$RESTORE_OPERATION_ID"
  recovery_operation_lock_json_is_exact "$lock_json"
}

require_owned_restore_lock() {
  local lock_json current_uid
  [[ "$RESTORE_LOCK_CREATED" == "1" ]] || return 1
  recovery_require_operation_serialization || return 1
  lock_json="$(recovery_kubectl get configmap "$RESTORE_LOCK_NAME" -n "$NAMESPACE" -o json)" || return 1
  current_uid="$(jq -er '.metadata.uid | select(type == "string" and length > 0)' <<<"$lock_json")" || return 1
  [[ "$current_uid" == "$RESTORE_LOCK_UID" ]] || return 1
  restore_lock_json_is_exact "$lock_json"
}

acquire_restore_lock() {
  local acquisition_status=0 pending_signal_status=0
  # The remote create helper reconciles an ambiguous response through the
  # private token and operation ID. Defer cooperative interruption until its
  # exact UID/resourceVersion have also armed local cleanup ownership.
  RESTORE_PENDING_SIGNAL_STATUS=0
  trap 'restore_record_pending_signal 130' INT
  trap 'restore_record_pending_signal 143' TERM
  if recovery_acquire_operation_lock checkpoint-restore "$RESTORE_LOCK_NAME"; then
    RESTORE_LOCK_UID="$RECOVERY_OPERATION_LOCK_UID"
    RESTORE_LOCK_RESOURCE_VERSION="$RECOVERY_OPERATION_LOCK_RESOURCE_VERSION"
    RESTORE_LOCK_TOKEN="$RECOVERY_OPERATION_TOKEN"
    RESTORE_OPERATION_ID="$RECOVERY_OPERATION_ID"
    RESTORE_LOCK_CREATED=1
    RESTORE_LOCK_RELEASE_ON_INTERRUPT=1
  else
    acquisition_status=1
  fi
  restore_driver_signal_traps
  pending_signal_status="$RESTORE_PENDING_SIGNAL_STATUS"
  RESTORE_PENDING_SIGNAL_STATUS=0
  if [[ "$pending_signal_status" != 0 &&
        "$RESTORE_INTERRUPT_IN_PROGRESS" == 0 ]]; then
    driver_interrupted "$pending_signal_status"
  fi
  [[ "$acquisition_status" == 0 ]]
}

release_restore_lock() {
  require_owned_restore_lock || {
    printf 'Restore lock identity changed; refusing to delete an unowned lock.\n' >&2
    return 1
  }
  recovery_delete_namespaced_with_uid_in_namespace \
    "$NAMESPACE" configmap "$RESTORE_LOCK_NAME" "$RESTORE_LOCK_UID" 60 \
    "$RESTORE_LOCK_RESOURCE_VERSION" || return 1
  RESTORE_LOCK_CREATED=0
  RESTORE_LOCK_UID=""
  RESTORE_LOCK_RESOURCE_VERSION=""
  RESTORE_LOCK_TOKEN=""
  RESTORE_OPERATION_ID=""
  RESTORE_LOCK_RELEASE_ON_INTERRUPT=0
}

restore_fence_confirmation_value() {
  local action="$1"
  [[ "$action" == prepare-fence || "$action" == execute-fenced ||
     "$action" == finalize-reactivation ]] || return 2
  printf '%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s' \
    "$action" "$EXPECTED_KUBE_CONTEXT" "$NAMESPACE" "$RECOVERY_NAMESPACE_UID" \
    "$RECOVERY_PVC_UID" "$RECOVERY_CHECKPOINT_STAMP" "$RECOVERY_DUMP_SHA256" \
    "$RECOVERY_STORAGE_SHA256" "$RECOVERY_DEPLOYMENT_INVENTORY_SHA256" \
    "$RECOVERY_FENCE_PRE_EPOCH" "$RECOVERY_FENCE_TARGET_EPOCH"
  if [[ -n "${RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256:-}" ]]; then
    printf ':%s:%s' "$RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256" \
      "$RECOVERY_RUNNER_RUNTIME_GENERATION"
  fi
  if [[ "$action" == execute-fenced || "$action" == finalize-reactivation ]]; then
    printf ':%s:%s' "$RESTORE_LOCK_UID" "$RESTORE_OPERATION_ID"
  fi
}

require_restore_fence_confirmation() {
  local variable_name="$1" action="$2" expected actual
  expected="$(restore_fence_confirmation_value "$action")" || return 1
  actual="${!variable_name:-}"
  [[ "$actual" == "$expected" ]] || {
    printf 'Refusing restore fence phase. Set %s=%q for this exact target and checkpoint.\n' \
      "$variable_name" "$expected" >&2
    return 1
  }
}

legacy_restore_confirmation_value() {
  [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == legacy-absent &&
     "$RECOVERY_DEPLOYMENT_INVENTORY_SHA256" =~ ^[a-f0-9]{64}$ ]] || return 2
  printf 'legacy-in-place:%s:%s:%s:%s:%s:%s:%s:%s' \
    "$EXPECTED_KUBE_CONTEXT" "$NAMESPACE" "$RECOVERY_NAMESPACE_UID" \
    "$RECOVERY_PVC_UID" "$RECOVERY_CHECKPOINT_STAMP" "$RECOVERY_DUMP_SHA256" \
    "$RECOVERY_STORAGE_SHA256" "$RECOVERY_DEPLOYMENT_INVENTORY_SHA256"
  if [[ -n "${RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256:-}" ]]; then
    printf ':%s:%s' "$RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256" \
      "$RECOVERY_RUNNER_RUNTIME_GENERATION"
  fi
}

require_legacy_restore_confirmation() {
  local expected
  expected="$(legacy_restore_confirmation_value)" || return 1
  [[ "${CONFIRM_LEGACY_IN_PLACE_RESTORE:-}" == "$expected" ]] || {
    printf 'Refusing one-shot legacy restore. Set CONFIRM_LEGACY_IN_PLACE_RESTORE=%q for this exact target and checkpoint.\n' \
      "$expected" >&2
    return 1
  }
}

load_restore_fence_lock() {
  local expected_state="$1" lock_json
  lock_json="$(recovery_kubectl get configmap "$RESTORE_LOCK_NAME" -n "$NAMESPACE" -o json)" || {
    printf 'The prepared restore-fence lock is missing.\n' >&2
    return 1
  }
  RESTORE_LOCK_UID="$(jq -er '.metadata.uid | select(type == "string" and length > 0)' \
    <<<"$lock_json")" || return 1
  RESTORE_LOCK_RESOURCE_VERSION="$(jq -er \
    '.metadata.resourceVersion | select(type == "string" and length > 0)' \
    <<<"$lock_json")" || return 1
  RESTORE_LOCK_TOKEN="$(jq -er '
    .metadata.annotations["yenhubs.org/recovery-token"] |
    select(type == "string" and test("^[a-f0-9]{32}$"))
  ' <<<"$lock_json")" || return 1
  RESTORE_OPERATION_ID="$(jq -er '
    .metadata.annotations["yenhubs.org/operation-id"] |
    select(type == "string" and test("^[a-f0-9]{32}$"))
  ' <<<"$lock_json")" || return 1
  RECOVERY_FENCE_PRE_EPOCH="$(jq -er '
    .metadata.annotations["yenhubs.org/pre-fence-epoch"] |
    select(. == "legacy-absent" or
      (type == "string" and
       test("^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$")))
  ' <<<"$lock_json")" || return 1
  RECOVERY_FENCE_TARGET_EPOCH="$(jq -er '
    .metadata.annotations["yenhubs.org/restore-fence-epoch"] |
    select(type == "string" and
      test("^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$"))
  ' <<<"$lock_json")" || return 1
  RECOVERY_OPERATION_STATE="$(jq -er --arg expected "$expected_state" '
    .metadata.annotations["yenhubs.org/recovery-state"] |
    select(type == "string" and . == $expected)
  ' <<<"$lock_json")" || return 1
  RECOVERY_OPERATION_OWNER="checkpoint-restore"
  RECOVERY_OPERATION_LOCK_NAME="$RESTORE_LOCK_NAME"
  RECOVERY_OPERATION_LOCK_UID="$RESTORE_LOCK_UID"
  RECOVERY_OPERATION_LOCK_RESOURCE_VERSION="$RESTORE_LOCK_RESOURCE_VERSION"
  RECOVERY_OPERATION_TOKEN="$RESTORE_LOCK_TOKEN"
  RECOVERY_OPERATION_ID="$RESTORE_OPERATION_ID"
  RESTORE_LOCK_CREATED=1
  RESTORE_LOCK_RELEASE_ON_INTERRUPT=0
  export RECOVERY_OPERATION_OWNER RECOVERY_OPERATION_LOCK_NAME \
    RECOVERY_OPERATION_LOCK_UID RECOVERY_OPERATION_LOCK_RESOURCE_VERSION \
    RECOVERY_OPERATION_TOKEN RECOVERY_OPERATION_ID RECOVERY_OPERATION_STATE \
    RECOVERY_FENCE_PRE_EPOCH RECOVERY_FENCE_TARGET_EPOCH
  restore_lock_json_is_exact "$lock_json" || {
    printf 'The prepared restore-fence lock does not match this checkpoint and target.\n' >&2
    return 1
  }
}

transition_restore_lock_state() {
  local expected_state="$1" next_state="$2" lock_json replaced_json
  local old_lock_resource_version new_lock_resource_version returned_state
  [[ "$expected_state" =~ ^[a-z][a-z0-9-]{0,62}$ &&
     "$next_state" =~ ^[a-z][a-z0-9-]{0,62}$ ]] || return 2
  [[ "$RECOVERY_OPERATION_STATE" == "$expected_state" ]] || return 1
  recovery_require_operation_serialization || return 1
  lock_json="$(recovery_kubectl get configmap "$RESTORE_LOCK_NAME" \
    -n "$NAMESPACE" -o json)" || return 1
  restore_lock_json_is_exact "$lock_json" || return 1
  old_lock_resource_version="$RESTORE_LOCK_RESOURCE_VERSION"
  [[ "$old_lock_resource_version" == \
     "$(jq -er '.metadata.resourceVersion' <<<"$lock_json")" ]] || return 1
  replaced_json="$(jq -c --arg state "$next_state" '
    .metadata.annotations["yenhubs.org/recovery-state"] = $state |
    del(.metadata.managedFields)
  ' <<<"$lock_json" | recovery_kubectl_mutate replace -f - -o json)" || {
    printf 'Could not CAS the restore lock to state %s.\n' "$next_state" >&2
    return 1
  }
  [[ "$(jq -er '.metadata.uid' <<<"$replaced_json")" == "$RESTORE_LOCK_UID" ]] || return 1
  returned_state="$(jq -er \
    '.metadata.annotations["yenhubs.org/recovery-state"] |
     select(type == "string")' <<<"$replaced_json")" || return 1
  [[ "$returned_state" == "$next_state" ]] || return 1
  new_lock_resource_version="$(jq -er \
    '.metadata.resourceVersion | select(type == "string" and length > 0)' \
    <<<"$replaced_json")" || return 1
  [[ "$new_lock_resource_version" != "$old_lock_resource_version" ]] || {
    printf 'Restore lock replacement did not advance its resourceVersion.\n' >&2
    return 1
  }
  RESTORE_LOCK_RESOURCE_VERSION="$new_lock_resource_version"
  RECOVERY_OPERATION_LOCK_RESOURCE_VERSION="$RESTORE_LOCK_RESOURCE_VERSION"
  RECOVERY_OPERATION_STATE="$next_state"
  export RECOVERY_OPERATION_LOCK_RESOURCE_VERSION RECOVERY_OPERATION_STATE
  restore_lock_json_is_exact "$replaced_json" &&
    recovery_require_operation_serialization
}

clear_stale_restore_lock() {
  local lock_json deployment deployment_json replicas selector pvc_consumers index
  local lock_state pre_epoch target_epoch inventory_sha
  local expected_storage_helper stale_fence_state=dormant
  local stale_dormant_identity=""
  local stale_receipt_state="" stale_receipt_resource_version=""
  local uuid_v4='^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  lock_json="$(recovery_kubectl get configmap "$RESTORE_LOCK_NAME" -n "$NAMESPACE" -o json)" || {
    printf 'No readable stale restore lock exists in the pinned target.\n' >&2
    return 1
  }
  RESTORE_LOCK_UID="$(jq -er '.metadata.uid | select(type == "string" and length > 0)' <<<"$lock_json")" || return 1
  RESTORE_LOCK_RESOURCE_VERSION="$(jq -er '.metadata.resourceVersion | select(type == "string" and length > 0)' <<<"$lock_json")" || return 1
  RESTORE_LOCK_TOKEN="$(jq -er '.metadata.annotations["yenhubs.org/recovery-token"] | select(type == "string" and test("^[a-f0-9]{32}$"))' <<<"$lock_json")" || return 1
  RESTORE_OPERATION_ID="$(jq -er '.metadata.annotations["yenhubs.org/operation-id"] | select(type == "string" and test("^[a-f0-9]{32}$"))' <<<"$lock_json")" || return 1
  expected_storage_helper="ret-storage-restore-${RESTORE_OPERATION_ID:0:12}"
  lock_state="$(jq -er '.metadata.annotations["yenhubs.org/recovery-state"] // "" | select(type == "string")' <<<"$lock_json")" || return 1
  pre_epoch="$(jq -er '.metadata.annotations["yenhubs.org/pre-fence-epoch"] // "" | select(type == "string")' <<<"$lock_json")" || return 1
  target_epoch="$(jq -er '.metadata.annotations["yenhubs.org/restore-fence-epoch"] // "" | select(type == "string")' <<<"$lock_json")" || return 1
  inventory_sha="$(jq -er '.metadata.annotations["yenhubs.org/deployment-inventory-sha256"] // "" | select(type == "string")' <<<"$lock_json")" || return 1
  case "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" in
    legacy-absent)
      [[ "$RECOVERY_RUNNER_RUNTIME_GENERATION" == legacy-absent &&
         -z "$pre_epoch" && -z "$target_epoch" &&
         "$inventory_sha" == "$RECOVERY_DEPLOYMENT_INVENTORY_SHA256" ]] ||
        return 1
      case "$lock_state" in
        legacy-in-place)
          [[ "${RESTORE_TARGET_MODE:-in-place}" != cold-rebind ]] || return 1
          ;;
        cold-rebind)
          [[ "${RESTORE_TARGET_MODE:-in-place}" == cold-rebind &&
             "$RECOVERY_CHECKPOINT_METADATA_SCHEMA" == freeze-bundle-v1 ]] ||
            return 1
          ;;
        *) return 1 ;;
      esac
      RECOVERY_OPERATION_STATE="$lock_state"
      RECOVERY_FENCE_PRE_EPOCH=""
      RECOVERY_FENCE_TARGET_EPOCH=""
      ;;
    durable-v2)
      [[ "$RECOVERY_RUNNER_RUNTIME_GENERATION" == durable-v2 &&
         "$lock_state" =~ ^(restore-fence-prepared|restore-complete-awaiting-reactivation)$ &&
         "$pre_epoch" =~ $uuid_v4 && "$target_epoch" =~ $uuid_v4 &&
         "$pre_epoch" != "$target_epoch" &&
         "$inventory_sha" == "$RECOVERY_DEPLOYMENT_INVENTORY_SHA256" ]] ||
        return 1
      RECOVERY_OPERATION_STATE="$lock_state"
      RECOVERY_FENCE_PRE_EPOCH="$pre_epoch"
      RECOVERY_FENCE_TARGET_EPOCH="$target_epoch"
      ;;
    *)
      return 1
      ;;
  esac
  RESTORE_LOCK_CREATED=1
  RESTORE_LOCK_RELEASE_ON_INTERRUPT=0
  restore_lock_json_is_exact "$lock_json" || {
    printf 'Stale restore lock is not bound to this exact checkpoint.\n' >&2
    return 1
  }
  if [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == durable-v2 ]]; then
    if stale_dormant_identity="$(
      recovery_read_recovery_operation_fence_state dormant
    )"; then
      stale_fence_state=dormant
    elif recovery_read_recovery_operation_fence_state active >/dev/null; then
      printf 'Stale restore lock retained: the recovery-operation admission fence is active. Complete a separate, reviewed Cloud-owned recovery procedure before retrying stale-lock cleanup.\n' >&2
      return 1
    else
      printf 'Stale restore lock retained: admission-fence state is not exact.\n' >&2
      return 1
    fi
  fi

  # Clearing is cleanup-only. Prove every fixed consumer and every runner are
  # already quiescent before confirmation or any Kubernetes mutation.
  pvc_consumers="$(recovery_pvc_consumer_names ret-pvc)" || return 1
  [[ -z "$pvc_consumers" || "$pvc_consumers" == "$expected_storage_helper" ]] || {
    printf 'Only the exact retained storage helper may consume ret-pvc during lock clearance.\n' >&2
    return 1
  }
  for deployment in "${CONSUMERS[@]}"; do
    deployment_json="$(recovery_kubectl get deployment "$deployment" \
      -n "$NAMESPACE" -o json)" || return 1
    replicas="$(jq -er \
      '.spec.replicas | select(type == "number" and floor == .)' \
      <<<"$deployment_json")" || return 1
    selector="$(jq -er \
      '.spec.selector.matchLabels.app | select(type == "string" and length > 0)' \
      <<<"$deployment_json")" || return 1
    [[ "$replicas" == "0" ]] || {
      printf 'Every DB consumer must already be at zero before clearing a restore lock.\n' >&2
      return 1
    }
    recovery_wait_for_no_pods "app=$selector" "deployment/$deployment" 30s ||
      return 1
  done
  capture_consumer_contracts_at_replicas 0 1 || return 1
  # This read-only inventory runs before confirmation or helper cleanup. A
  # durable stale restore accepts no receipt; a legacy restore accepts at most
  # the exact current-operation receipt on the frozen reticulum Deployment.
  capture_stale_checkpoint_resume_receipt_inventory \
    stale_receipt_state stale_receipt_resource_version || {
    printf 'Stale restore lock retained: checkpoint resume receipt ownership is not exact.\n' >&2
    return 1
  }
  require_owned_restore_lock || return 1
  require_durable_checkpoint_evidence_for_parent_state \
    "$stale_fence_state" || return 1
  require_checkpoint_runner_quiescent_now || return 1
  recovery_require_cluster_identity || return 1
  recovery_require_pvc_identity ret-pvc || return 1
  require_owned_restore_lock || return 1

  recovery_require_confirmation CONFIRM_CLEAR_RESTORE_LOCK restore-lock \
    "$RESTORE_LOCK_UID:$RECOVERY_PVC_UID" || return 1
  case "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" in
    legacy-absent)
      start_runner_resume_monitor || return 1
      ;;
    durable-v2)
      RUNNER_DURABLE_FENCE_INVENTORY="$(
        recovery_capture_durable_quiescence
      )" || return 1
      recovery_durable_fence_inventory_json_is_canonical \
        "$RUNNER_DURABLE_FENCE_INVENTORY" || return 1
      recovery_require_no_legacy_parent_runner_pods || return 1
      ;;
    *)
      return 1
      ;;
  esac
  if [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == legacy-absent ]]; then
    require_runner_resume_monitor_healthy || return 1
  else
    require_checkpoint_runner_quiescent_now || return 1
  fi
  pvc_consumers="$(recovery_pvc_consumer_names ret-pvc)" || return 1
  [[ -z "$pvc_consumers" || "$pvc_consumers" == "$expected_storage_helper" ]] || {
    printf 'Only the exact retained storage helper may consume ret-pvc during lock clearance.\n' >&2
    return 1
  }
  for deployment in "${CONSUMERS[@]}"; do
    deployment_json="$(recovery_kubectl get deployment "$deployment" \
      -n "$NAMESPACE" -o json)" || return 1
    replicas="$(jq -er \
      '.spec.replicas | select(type == "number" and floor == .)' \
      <<<"$deployment_json")" || return 1
    selector="$(jq -er \
      '.spec.selector.matchLabels.app | select(type == "string" and length > 0)' \
      <<<"$deployment_json")" || return 1
    [[ "$replicas" == "0" ]] || {
      printf 'Every DB consumer must remain at zero before stale-helper cleanup.\n' >&2
      return 1
    }
    recovery_wait_for_no_pods "app=$selector" "deployment/$deployment" 30s ||
      return 1
    recovery_require_consumer_contract_entry \
      "$RECOVERY_CONSUMER_CONTRACT_JSON" "$deployment" 0 \
      "$RESTORE_OPERATION_ID" || return 1
  done
  require_durable_checkpoint_evidence_for_parent_state \
    "$stale_fence_state" || return 1
  require_checkpoint_runner_quiescent_now || return 1
  recovery_require_cluster_identity || return 1
  recovery_require_pvc_identity ret-pvc || return 1
  require_owned_restore_lock || return 1

  export RECOVERY_OPERATION_OWNER RECOVERY_OPERATION_LOCK_NAME \
    RECOVERY_OPERATION_LOCK_UID RECOVERY_OPERATION_LOCK_RESOURCE_VERSION \
    RECOVERY_OPERATION_TOKEN RECOVERY_OPERATION_ID RECOVERY_OPERATION_STATE \
    RECOVERY_FENCE_PRE_EPOCH RECOVERY_FENCE_TARGET_EPOCH
  VALUES_FILE="$VALUES_SOURCE_FILE" \
  RESTORE_COORDINATED=1 RESTORE_STORAGE_CLEAR_STALE_HELPER=1 \
  YENHUBS_PARENT_LEASE_HOLDER="$RECOVERY_SERIALIZATION_LEASE_HOLDER" \
  YENHUBS_PARENT_LEASE_UID="$RECOVERY_SERIALIZATION_LEASE_UID" \
  YENHUBS_PARENT_PROCESS_PID="$RECOVERY_SERIALIZATION_PARENT_PID" \
  YENHUBS_PARENT_PROCESS_START_IDENTITY="$RECOVERY_SERIALIZATION_PARENT_START_IDENTITY" \
    "$SCRIPT_DIR/restore-ret-storage.sh" "$STORAGE_PATH" || return 1

  if [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == legacy-absent ]]; then
    require_runner_resume_monitor_healthy || return 1
  else
    require_checkpoint_runner_quiescent_now || return 1
  fi
  recovery_require_exact_pvc_consumers ret-pvc || return 1
  for deployment in "${CONSUMERS[@]}"; do
    deployment_json="$(recovery_kubectl get deployment "$deployment" \
      -n "$NAMESPACE" -o json)" || return 1
    replicas="$(jq -er \
      '.spec.replicas | select(type == "number" and floor == .)' \
      <<<"$deployment_json")" || return 1
    selector="$(jq -er \
      '.spec.selector.matchLabels.app | select(type == "string" and length > 0)' \
      <<<"$deployment_json")" || return 1
    [[ "$replicas" == "0" ]] || {
      printf 'Every DB consumer must remain at zero before clearing a restore lock.\n' >&2
      return 1
    }
    recovery_wait_for_no_pods "app=$selector" "deployment/$deployment" 30s ||
      return 1
    recovery_require_consumer_contract_entry \
      "$RECOVERY_CONSUMER_CONTRACT_JSON" "$deployment" 0 \
      "$RESTORE_OPERATION_ID" || return 1
  done
  require_durable_checkpoint_evidence_for_parent_state \
    "$stale_fence_state" || return 1
  require_checkpoint_runner_quiescent_now || return 1
  recovery_require_cluster_identity || return 1
  recovery_require_pvc_identity ret-pvc || return 1
  if [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == legacy-absent ]]; then
    require_runner_resume_monitor_healthy || return 1
  fi
  require_checkpoint_runner_quiescent_now || return 1
  recovery_require_cluster_identity || return 1
  recovery_require_pvc_identity ret-pvc || return 1
  require_durable_checkpoint_evidence_for_parent_state \
    "$stale_fence_state" || return 1
  if [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == durable-v2 ]]; then
    recovery_require_recovery_operation_fence_state dormant \
      "$stale_dormant_identity" || return 1
    # Stale-lock cleanup is teardown-only. It may adopt an exact dormant fifth
    # fence, but only the standard Cloud recovery path may transition it.
    require_checkpoint_runner_quiescent_now || return 1
  fi
  capture_stale_checkpoint_resume_receipt_inventory \
    stale_receipt_state stale_receipt_resource_version || {
    printf 'Stale restore lock retained: checkpoint resume receipt changed before deletion.\n' >&2
    return 1
  }
  if [[ "$stale_receipt_state" == exact ]]; then
    stale_receipt_resource_version="$(
      recovery_clear_checkpoint_resume_receipt_exact \
        reticulum "${DEPLOYMENT_UIDS[0]}" \
        "$stale_receipt_resource_version" 0 \
        "${DEPLOYMENT_SELECTORS[0]}" "${DEPLOYMENT_FINGERPRINTS[0]}" \
        "$RESTORE_OPERATION_ID"
    )" || {
      printf 'Stale restore lock retained: exact reticulum receipt CAS failed.\n' >&2
      return 1
    }
    DEPLOYMENT_RESOURCE_VERSIONS[0]="$stale_receipt_resource_version"
  fi
  capture_stale_checkpoint_resume_receipt_inventory \
    stale_receipt_state stale_receipt_resource_version || return 1
  [[ "$stale_receipt_state" == absent ]] || return 1
  for index in "${!CONSUMERS[@]}"; do
    recovery_require_consumer_contract_entry \
      "$RECOVERY_CONSUMER_CONTRACT_JSON" "${CONSUMERS[$index]}" 0 \
      "$RESTORE_OPERATION_ID" || return 1
    recovery_wait_for_no_pods "app=${DEPLOYMENT_SELECTORS[$index]}" \
      "deployment/${CONSUMERS[$index]}" 30s || return 1
  done
  if [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == legacy-absent ]]; then
    require_runner_resume_monitor_healthy || return 1
    stop_runner_resume_monitor_before_parent || return 1
  fi
  require_checkpoint_runner_quiescent_now || return 1
  recovery_require_cluster_identity || return 1
  recovery_require_pvc_identity ret-pvc || return 1
  capture_stale_checkpoint_resume_receipt_inventory \
    stale_receipt_state stale_receipt_resource_version || return 1
  [[ "$stale_receipt_state" == absent ]] || return 1
  recovery_require_operation_serialization || return 1
  require_owned_restore_lock || {
    printf 'Restore lock changed before stale-lock deletion.\n' >&2
    return 1
  }
  recovery_delete_namespaced_with_uid_in_namespace \
    "$NAMESPACE" configmap "$RESTORE_LOCK_NAME" "$RESTORE_LOCK_UID" 60 \
    "$RESTORE_LOCK_RESOURCE_VERSION" || return 1
  RESTORE_LOCK_CREATED=0
  printf 'Stale checkpoint-restore lock cleared after exact confirmation; no workload was resumed.\n'
}

cleanup_driver() {
  local entry_status=$?
  local snapshot_path snapshot_parent snapshot_base
  if [[ "$RESTORE_CLEANUP_IN_PROGRESS" == 1 ]]; then
    return "$entry_status"
  fi
  RESTORE_CLEANUP_IN_PROGRESS=1
  # Cleanup is terminal for this process. Prevent a second EXIT/ERR or a
  # cooperative signal from re-entering fail-close while watcher/Lease
  # capabilities are being revoked.
  trap - EXIT ERR
  trap '' INT TERM
  # The durable monitor pins the writer baseline, so revoke it first.
  cleanup_restore_durable_monitor
  cleanup_restore_writer_monitor
  discard_runner_resume_monitor
  [[ -z "$LIVE_CONTRACT" ]] || rm -f -- "$LIVE_CONTRACT"
  for snapshot_path in "$RESTORE_VALUES_SNAPSHOT" \
    "$RESTORE_HISTORICAL_VALUES_SNAPSHOT" "$RESTORE_MANIFEST_SNAPSHOT" \
    "$RESTORE_CUTOVER_KEY_SNAPSHOT"; do
    [[ -z "$snapshot_path" ]] || {
      snapshot_parent="$(dirname "$snapshot_path")"
      snapshot_base="$(basename "$snapshot_parent")"
      if [[ "$snapshot_parent" == "$(cd "$(dirname "$snapshot_parent")" 2>/dev/null && pwd -P)/$snapshot_base" &&
            "$snapshot_base" =~ ^yenhubs-restore-(values|source-values|manifest|cutover-key)\.[A-Za-z0-9]{6}$ ]]; then
        rm -f -- "$snapshot_path"
        rmdir "$snapshot_parent" 2>/dev/null || :
      fi
    }
  done
  RESTORE_VALUES_SNAPSHOT=""
  RESTORE_HISTORICAL_VALUES_SNAPSHOT=""
  RESTORE_MANIFEST_SNAPSHOT=""
  RESTORE_CUTOVER_KEY_SNAPSHOT=""
  VALUES_SOURCE_FILE=""
  recovery_cleanup_materialized_checkpoint
  if [[ "$SERIALIZATION_LEASE_OWNED" == 1 ]]; then
    if recovery_release_operation_serialization; then
      SERIALIZATION_LEASE_OWNED=0
    else
      printf 'Restore serialization Lease could not be released safely.\n' >&2
    fi
  fi
  return "$entry_status"
}

acquire_restore_serialization() {
  local acquisition_status=0 pending_signal_status=0
  [[ "$SERIALIZATION_LEASE_OWNED" == 0 ]] || return 2
  # Bind the Lease+heartbeat capability to local cleanup before honoring a
  # signal that arrived during the bounded remote acquisition.
  RESTORE_PENDING_SIGNAL_STATUS=0
  trap 'restore_record_pending_signal 130' INT
  trap 'restore_record_pending_signal 143' TERM
  if recovery_acquire_operation_serialization root-recovery; then
    SERIALIZATION_LEASE_OWNED=1
  else
    acquisition_status=1
  fi
  restore_driver_signal_traps
  pending_signal_status="$RESTORE_PENDING_SIGNAL_STATUS"
  RESTORE_PENDING_SIGNAL_STATUS=0
  if [[ "$pending_signal_status" != 0 &&
        "$RESTORE_INTERRUPT_IN_PROGRESS" == 0 ]]; then
    driver_interrupted "$pending_signal_status"
  fi
  [[ "$acquisition_status" == 0 ]] || return 1
  recovery_require_operation_serialization
}

release_restore_serialization() {
  [[ "$SERIALIZATION_LEASE_OWNED" == 1 ]] || return 0
  recovery_release_operation_serialization || return 1
  SERIALIZATION_LEASE_OWNED=0
}

capture_consumer_contracts_at_replicas() {
  local expected_replicas="$1" original_replicas="$2"
  local deployment deployment_contract deployment_uid deployment_resource_version
  local replicas deployment_selector deployment_fingerprint consumer_contracts='[]'
  DEPLOYMENT_UIDS=()
  DEPLOYMENT_RESOURCE_VERSIONS=()
  ORIGINAL_REPLICAS=()
  DEPLOYMENT_SELECTORS=()
  DEPLOYMENT_FINGERPRINTS=()
  for deployment in "${CONSUMERS[@]}"; do
    deployment_contract="$(recovery_capture_deployment_contract "$deployment")" || return 1
    IFS=$'\t' read -r deployment_uid deployment_resource_version replicas \
      deployment_selector deployment_fingerprint <<<"$deployment_contract"
    [[ "$replicas" == "$expected_replicas" ]] || {
      printf 'Restore fence requires deployment/%s replicas=%s, found %s.\n' \
        "$deployment" "$expected_replicas" "$replicas" >&2
      return 1
    }
    DEPLOYMENT_UIDS+=("$deployment_uid")
    DEPLOYMENT_RESOURCE_VERSIONS+=("$deployment_resource_version")
    ORIGINAL_REPLICAS+=("$original_replicas")
    DEPLOYMENT_SELECTORS+=("$deployment_selector")
    DEPLOYMENT_FINGERPRINTS+=("$deployment_fingerprint")
    consumer_contracts="$(jq -cn \
      --argjson current "$consumer_contracts" --arg name "$deployment" \
      --arg uid "$deployment_uid" --arg resource_version "$deployment_resource_version" \
      --argjson original_replicas "$original_replicas" \
      --arg selector "$deployment_selector" --arg fingerprint "$deployment_fingerprint" \
      '$current + [{name:$name,uid:$uid,initial_resource_version:$resource_version,
        original_replicas:$original_replicas,selector:$selector,fingerprint:$fingerprint}]'
    )"
  done
  RECOVERY_CONSUMER_CONTRACT_JSON="$(jq -cn \
    --arg operation_id "$RESTORE_OPERATION_ID" --argjson consumers "$consumer_contracts" \
    '{schema_version:1,operation_id:$operation_id,consumers:$consumers}')"
  recovery_consumer_contract_is_acceptable "$RECOVERY_CONSUMER_CONTRACT_JSON"
  export RECOVERY_CONSUMER_CONTRACT_JSON
}

require_restore_zero_boundary() {
  local index deployment
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  recovery_consumer_contract_is_acceptable \
    "$RECOVERY_CONSUMER_CONTRACT_JSON" || return 1
  for index in "${!CONSUMERS[@]}"; do
    deployment="${CONSUMERS[$index]}"
    recovery_require_consumer_contract_entry \
      "$RECOVERY_CONSUMER_CONTRACT_JSON" "$deployment" 0 \
      "$RESTORE_OPERATION_ID" || return 1
    recovery_wait_for_no_pods "app=${DEPLOYMENT_SELECTORS[$index]}" \
      "deployment/$deployment" 30s || return 1
  done
  recovery_require_exact_pvc_consumers ret-pvc || return 1
  recovery_durable_fence_inventory_json_is_canonical \
    "$RUNNER_DURABLE_FENCE_INVENTORY" || return 1
  [[ "$(recovery_capture_durable_quiescence)" == \
     "$RUNNER_DURABLE_FENCE_INVENTORY" ]] || return 1
  recovery_require_no_legacy_parent_runner_pods
}

attest_restore_operation_fence_active() {
  local expected_previous_identity="${1:-}" first_identity second_identity
  local canonical_previous_identity=""
  [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == durable-v2 ]] || return 2
  require_restore_zero_boundary || return 1
  # The standard Cloud restore-fence apply owns the dormant -> active CAS.
  # EXECUTE only adopts the already-active pair after both server-side denial
  # probes have propagated, then rereads the exact UID/resourceVersion identity
  # to reject disappearance, replacement or an active -> dormant -> active ABA.
  if ! first_identity="$(
    recovery_read_recovery_operation_fence_state active
  )"; then
    printf 'The recovery operation admission fence is not exactly active; regenerate and apply the standard Cloud restore-fence manifest before retrying execute-fenced.\n' >&2
    return 1
  fi
  if [[ -n "$expected_previous_identity" ]]; then
    canonical_previous_identity="$(
      jq -ceS . <<<"$expected_previous_identity"
    )" || return 1
    [[ "$canonical_previous_identity" == "$expected_previous_identity" &&
       "$RESTORE_LOCK_RESOURCE_VERSION" == \
         "$RECOVERY_OPERATION_LOCK_RESOURCE_VERSION" ]] || return 1
    jq -e --argjson previous "$expected_previous_identity" \
      --arg current_lock_rv "$RESTORE_LOCK_RESOURCE_VERSION" '
      (del(.operation_lock.resource_version) ==
        ($previous | del(.operation_lock.resource_version))) and
      (.operation_lock.resource_version == $current_lock_rv) and
      ($previous.operation_lock.resource_version | type == "string" and
        length > 0) and
      ($previous.operation_lock.resource_version != $current_lock_rv)
    ' >/dev/null <<<"$first_identity" || {
      printf 'The active recovery-operation fence identity changed beyond the expected restore-lock resourceVersion advance.\n' >&2
      return 1
    }
  fi
  recovery_wait_recovery_operation_fence_propagation \
    active "$first_identity" || return 1
  second_identity="$(
    recovery_read_recovery_operation_fence_state active "$first_identity"
  )" || return 1
  [[ "$second_identity" == "$first_identity" ]] || return 1
  RESTORE_OPERATION_FENCE_ACTIVE_IDENTITY="$first_identity"
  recovery_require_recovery_operation_fence_state active \
    "$RESTORE_OPERATION_FENCE_ACTIVE_IDENTITY"
}

capture_consumer_contracts_for_failclose() {
  local deployment deployment_contract deployment_uid deployment_resource_version
  local replicas deployment_selector deployment_fingerprint consumer_contracts='[]'
  DEPLOYMENT_UIDS=()
  DEPLOYMENT_RESOURCE_VERSIONS=()
  ORIGINAL_REPLICAS=()
  DEPLOYMENT_SELECTORS=()
  DEPLOYMENT_FINGERPRINTS=()
  for deployment in "${CONSUMERS[@]}"; do
    deployment_contract="$(recovery_capture_deployment_contract "$deployment")" || return 1
    IFS=$'\t' read -r deployment_uid deployment_resource_version replicas \
      deployment_selector deployment_fingerprint <<<"$deployment_contract"
    [[ "$replicas" =~ ^[0-9]+$ ]] || return 1
    DEPLOYMENT_UIDS+=("$deployment_uid")
    DEPLOYMENT_RESOURCE_VERSIONS+=("$deployment_resource_version")
    ORIGINAL_REPLICAS+=(1)
    DEPLOYMENT_SELECTORS+=("$deployment_selector")
    DEPLOYMENT_FINGERPRINTS+=("$deployment_fingerprint")
    consumer_contracts="$(jq -cn \
      --argjson current "$consumer_contracts" --arg name "$deployment" \
      --arg uid "$deployment_uid" --arg resource_version "$deployment_resource_version" \
      --arg selector "$deployment_selector" --arg fingerprint "$deployment_fingerprint" \
      '$current + [{name:$name,uid:$uid,initial_resource_version:$resource_version,
        original_replicas:1,selector:$selector,fingerprint:$fingerprint}]')"
  done
  RECOVERY_CONSUMER_CONTRACT_JSON="$(jq -cn \
    --arg operation_id "$RESTORE_OPERATION_ID" --argjson consumers "$consumer_contracts" \
    '{schema_version:1,operation_id:$operation_id,consumers:$consumers}')"
  recovery_consumer_contract_is_acceptable "$RECOVERY_CONSUMER_CONTRACT_JSON"
  export RECOVERY_CONSUMER_CONTRACT_JSON
}

runner_role_json_has_active_contract() {
  local role_json="$1" expected_uid="${2:-}" expected_resource_version="${3:-}"
  jq -e --arg uid "$expected_uid" --arg resource_version "$expected_resource_version" '
    .apiVersion == "rbac.authorization.k8s.io/v1" and .kind == "Role" and
    .metadata.name == "bot-orchestrator-runner-pods" and
    .metadata.namespace == "hcce-bot-runners" and
    (.metadata | has("deletionTimestamp") | not) and
    (((.metadata | has("ownerReferences") | not) or .metadata.ownerReferences == [])) and
    (((.metadata | has("finalizers") | not) or .metadata.finalizers == [])) and
    (.metadata.uid | type == "string" and length > 0) and
    (.metadata.resourceVersion | type == "string" and length > 0) and
    ($uid == "" or .metadata.uid == $uid) and
    ($resource_version == "" or .metadata.resourceVersion == $resource_version) and
    (.metadata.annotations["yenhubs.org/runner-activation-phase"] == "active") and
    (.metadata.annotations["yenhubs.org/bot-runner-recovery-phase"] == "active") and
    .rules == [{apiGroups:[""],resources:["pods"],
      verbs:["create","delete","get","list","patch"]}]
  ' >/dev/null <<<"$role_json"
}

runner_role_json_is_inert_exact() {
  local role_json="$1" expected_uid="$2" expected_resource_version="${3:-}"
  [[ -n "$expected_uid" ]] || return 2
  jq -e --arg uid "$expected_uid" --arg resource_version "$expected_resource_version" '
    .apiVersion == "rbac.authorization.k8s.io/v1" and .kind == "Role" and
    .metadata.name == "bot-orchestrator-runner-pods" and
    .metadata.namespace == "hcce-bot-runners" and
    (.metadata | has("deletionTimestamp") | not) and
    (((.metadata | has("ownerReferences") | not) or .metadata.ownerReferences == [])) and
    (((.metadata | has("finalizers") | not) or .metadata.finalizers == [])) and
    (.metadata.uid | type == "string" and length > 0) and
    (.metadata.resourceVersion | type == "string" and length > 0) and
    .metadata.uid == $uid and
    ($resource_version == "" or .metadata.resourceVersion == $resource_version) and
    (.metadata.annotations["yenhubs.org/runner-activation-phase"] == "active") and
    (.metadata.annotations["yenhubs.org/bot-runner-recovery-phase"] == "restore-fence") and
    .rules == []
  ' >/dev/null <<<"$role_json"
}

capture_runner_role_for_failclose() {
  local role_json role_uid role_resource_version
  role_json="$(recovery_kubectl get role bot-orchestrator-runner-pods \
    -n hcce-bot-runners -o json)" || return 1
  runner_role_json_has_active_contract "$role_json" || return 1
  role_uid="$(jq -er '.metadata.uid | select(type == "string" and length > 0)' \
    <<<"$role_json")" || return 1
  role_resource_version="$(jq -er \
    '.metadata.resourceVersion | select(type == "string" and length > 0)' \
    <<<"$role_json")" || return 1
  RUNNER_ROLE_UID="$role_uid"
  RUNNER_ROLE_RESOURCE_VERSION="$role_resource_version"
}

capture_inert_runner_role_for_failclose() {
  local role_json role_uid role_resource_version
  role_json="$(recovery_kubectl get role bot-orchestrator-runner-pods \
    -n hcce-bot-runners -o json)" || return 1
  role_uid="$(jq -er '.metadata.uid | select(type == "string" and length > 0)' \
    <<<"$role_json")" || return 1
  role_resource_version="$(jq -er \
    '.metadata.resourceVersion | select(type == "string" and length > 0)' \
    <<<"$role_json")" || return 1
  runner_role_json_is_inert_exact "$role_json" "$role_uid" \
    "$role_resource_version" || return 1
  RUNNER_ROLE_UID="$role_uid"
  RUNNER_ROLE_RESOURCE_VERSION="$role_resource_version"
  FAILCLOSE_RUNNER_ROLE_UID="$role_uid"
  FAILCLOSE_RUNNER_ROLE_RESOURCE_VERSION="$role_resource_version"
}

capture_finalizer_failclose_contracts() {
  capture_runner_role_for_failclose &&
    capture_consumer_contracts_for_failclose
}

neutralize_runner_role_exact() {
  local role_json replacement_json replaced_json live_resource_version attempt
  [[ -n "$RUNNER_ROLE_UID" && -n "$RUNNER_ROLE_RESOURCE_VERSION" ]] || {
    printf 'The runner Role was not captured before fail-close mutation.\n' >&2
    return 1
  }
  recovery_require_operation_serialization || return 1
  for attempt in 1 2 3; do
    role_json="$(recovery_kubectl get role bot-orchestrator-runner-pods \
      -n hcce-bot-runners -o json)" || continue
    if runner_role_json_is_inert_exact "$role_json" "$RUNNER_ROLE_UID"; then
      live_resource_version="$(jq -er '.metadata.resourceVersion' \
        <<<"$role_json")" || return 1
      FAILCLOSE_RUNNER_ROLE_UID="$RUNNER_ROLE_UID"
      FAILCLOSE_RUNNER_ROLE_RESOURCE_VERSION="$live_resource_version"
      recovery_require_operation_serialization || return 1
      return 0
    fi
    runner_role_json_has_active_contract "$role_json" "$RUNNER_ROLE_UID" \
      "$RUNNER_ROLE_RESOURCE_VERSION" || {
      printf 'The runner Role identity, resourceVersion or active contract drifted; refusing to replace it.\n' >&2
      return 1
    }
    replacement_json="$(jq -c '
      del(.metadata.managedFields, .metadata.creationTimestamp) |
      .metadata.annotations = (.metadata.annotations // {}) |
      .metadata.annotations["yenhubs.org/runner-activation-phase"] = "active" |
      .metadata.annotations["yenhubs.org/bot-runner-recovery-phase"] = "restore-fence" |
      .rules = []
    ' <<<"$role_json")" || return 1
    recovery_require_operation_serialization || return 1
    if ! replaced_json="$(printf '%s\n' "$replacement_json" | \
      recovery_kubectl_mutate replace -f - -o json)"; then
      continue
    fi
    if runner_role_json_is_inert_exact "$replaced_json" "$RUNNER_ROLE_UID"; then
      live_resource_version="$(jq -er '.metadata.resourceVersion' \
        <<<"$replaced_json")" || return 1
      FAILCLOSE_RUNNER_ROLE_UID="$RUNNER_ROLE_UID"
      FAILCLOSE_RUNNER_ROLE_RESOURCE_VERSION="$live_resource_version"
      recovery_require_operation_serialization || return 1
      return 0
    fi
    return 1
  done
  # A failed response may conceal a successful CAS. Accept only the exact inert
  # contract on the immutable UID captured before any restore mutation.
  role_json="$(recovery_kubectl get role bot-orchestrator-runner-pods \
    -n hcce-bot-runners -o json)" || return 1
  runner_role_json_is_inert_exact "$role_json" "$RUNNER_ROLE_UID" || return 1
  live_resource_version="$(jq -er '.metadata.resourceVersion' \
    <<<"$role_json")" || return 1
  FAILCLOSE_RUNNER_ROLE_UID="$RUNNER_ROLE_UID"
  FAILCLOSE_RUNNER_ROLE_RESOURCE_VERSION="$live_resource_version"
  recovery_require_operation_serialization || return 1
}

require_inert_runner_role_exact() {
  local role_json
  [[ -n "$FAILCLOSE_RUNNER_ROLE_UID" &&
     -n "$FAILCLOSE_RUNNER_ROLE_RESOURCE_VERSION" ]] || return 1
  role_json="$(recovery_kubectl get role bot-orchestrator-runner-pods \
    -n hcce-bot-runners -o json)" || return 1
  runner_role_json_is_inert_exact "$role_json" \
    "$FAILCLOSE_RUNNER_ROLE_UID" "$FAILCLOSE_RUNNER_ROLE_RESOURCE_VERSION"
}

require_runner_absence_stable() {
  local stable_seconds started baseline_fences current_fences
  stable_seconds="$(recovery_stable_absence_seconds)" || return 1
  [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == durable-v2 ]] || return 2
  require_inert_runner_role_exact || return 1
  baseline_fences="$(recovery_capture_durable_quiescence)" || return 1
  recovery_durable_fence_inventory_json_is_canonical "$baseline_fences" || return 1
  recovery_require_no_legacy_parent_runner_pods || return 1
  started="$SECONDS"
  while :; do
    recovery_require_operation_serialization || return 1
    require_inert_runner_role_exact || return 1
    current_fences="$(recovery_capture_durable_quiescence)" || return 1
    recovery_durable_fence_inventory_json_is_canonical "$current_fences" || return 1
    [[ "$current_fences" == "$baseline_fences" ]] || return 1
    recovery_require_no_legacy_parent_runner_pods || return 1
    ((SECONDS - started >= stable_seconds)) && return 0
    sleep 1
  done
}

prepare_restore_fence() {
  local index parent_resource_version="" parent_scale_status=0
  local -a remaining_quiesce_order=(0 1 2 4)
  [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == durable-v2 ]] || {
    printf 'The durable restore-fence protocol cannot restore a legacy checkpoint.\n' >&2
    return 1
  }
  RESTORE_PHASE="quiescing"
  capture_runner_role_for_failclose
  capture_consumer_contracts_at_replicas 1 1
  # From this point onward failure/interruption must retain the lock and
  # reductively fail-close; before it, the newly created lock is disposable.
  RESTORE_LOCK_RELEASE_ON_INTERRUPT=0
  # Stop the token-bearing parent first. Its admission identity is part of the
  # permanent-fence protocol. Remove its create/delete authority immediately
  # after the parent scale CAS, then prove the parent is gone before touching
  # any remaining consumer.
  index=3
  if ! parent_resource_version="$(recovery_scale_deployment_exact \
    "${CONSUMERS[$index]}" "${DEPLOYMENT_UIDS[$index]}" \
    "${DEPLOYMENT_RESOURCE_VERSIONS[$index]}" 1 0 \
    "${DEPLOYMENT_SELECTORS[$index]}" "${DEPLOYMENT_FINGERPRINTS[$index]}")"; then
    parent_scale_status=1
  fi
  # A failed scale response may conceal a successful CAS. Always remove the
  # captured runner authority before propagating that failure to fail-close.
  neutralize_runner_role_exact || return 1
  [[ "$parent_scale_status" == 0 ]] || return 1
  DEPLOYMENT_RESOURCE_VERSIONS[index]="$parent_resource_version"
  recovery_wait_for_no_pods "app=${DEPLOYMENT_SELECTORS[$index]}" \
    "deployment/${CONSUMERS[$index]}" 180s || return 1
  recovery_require_consumer_contract_entry \
    "$RECOVERY_CONSUMER_CONTRACT_JSON" "${CONSUMERS[$index]}" 0 \
    "$RESTORE_OPERATION_ID" || return 1

  for index in "${remaining_quiesce_order[@]}"; do
    DEPLOYMENT_RESOURCE_VERSIONS[index]="$(recovery_scale_deployment_exact \
      "${CONSUMERS[$index]}" "${DEPLOYMENT_UIDS[$index]}" \
      "${DEPLOYMENT_RESOURCE_VERSIONS[$index]}" 1 0 \
      "${DEPLOYMENT_SELECTORS[$index]}" "${DEPLOYMENT_FINGERPRINTS[$index]}")" || return 1
  done
  for index in "${remaining_quiesce_order[@]}"; do
    recovery_wait_for_no_pods "app=${DEPLOYMENT_SELECTORS[$index]}" \
      "deployment/${CONSUMERS[$index]}" 180s || return 1
    recovery_require_consumer_contract_entry \
      "$RECOVERY_CONSUMER_CONTRACT_JSON" "${CONSUMERS[$index]}" 0 \
      "$RESTORE_OPERATION_ID" || return 1
  done
  reconcile_checkpoint_runner_quiescence
  require_runner_absence_stable
  require_durable_checkpoint_evidence_live quiesced-source dormant
  RESTORE_PHASE="fence-prepared"
}

validate_restored_database_contract() {
  local pgsql_pods_json pgsql_pod_info pgsql_pod pgsql_pod_uid
  local pgsql_deployment_uid pgsql_pod_json
  pgsql_pods_json="$(
    recovery_kubectl get pod -n "$NAMESPACE" -l app=pgsql -o json
  )" || return 1
  pgsql_pod_info="$(
    recovery_exact_ready_deployment_pod_info "$pgsql_pods_json" pgsql pgsql
  )" || {
    printf 'Exactly one owned Ready PostgreSQL pod is required during joint validation.\n' >&2
    return 1
  }
  IFS=$'\t' read -r pgsql_pod pgsql_pod_uid pgsql_deployment_uid \
    <<<"$pgsql_pod_info"
  pgsql_pod_json="$(jq -cer '.items[0]' <<<"$pgsql_pods_json")" || return 1
  [[ -z "$LIVE_CONTRACT" ]] || rm -f -- "$LIVE_CONTRACT"
  LIVE_CONTRACT="$(mktemp "${TMPDIR:-/tmp}/yenhubs-coordinated-live-contract.XXXXXX")" || return 1
  chmod 600 "$LIVE_CONTRACT"
  require_owned_restore_lock || return 1
  recovery_require_pod_identity "$pgsql_pod" "$pgsql_pod_uid" || return 1
  recovery_require_pod_deployment_ownership \
    "$pgsql_pod_json" pgsql "$pgsql_deployment_uid" || return 1
  recovery_capture_live_database_contract "$pgsql_pod" "$LIVE_CONTRACT" || return 1
  require_owned_restore_lock || return 1
  recovery_require_pod_identity "$pgsql_pod" "$pgsql_pod_uid" || return 1
  recovery_require_pod_deployment_ownership \
    "$pgsql_pod_json" pgsql "$pgsql_deployment_uid" || return 1
  recovery_database_contracts_match \
    "$RECOVERY_DATABASE_CONTRACT_COPY" "$LIVE_CONTRACT" || {
    printf 'Live DB contract drifted before coordinated resume.\n' >&2
    return 1
  }
}

verify_legacy_live_reactivation() {
  local index
  [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == legacy-absent ]] || return 1
  recovery_require_cluster_identity || return 1
  recovery_require_pvc_identity ret-pvc || return 1
  recovery_require_restore_target_binding || return 1
  recovery_require_checkpoint_generation_matches_live \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY" "$VALUES_SOURCE_FILE" || return 1
  recovery_require_live_images_match_checkpoint \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY" || return 1
  for index in "${!CONSUMERS[@]}"; do
    recovery_wait_for_deployment_rollout "${CONSUMERS[$index]}" 300 || return 1
    recovery_require_consumer_contract_entry \
      "$RECOVERY_CONSUMER_CONTRACT_JSON" "${CONSUMERS[$index]}" 1 \
      "$RESTORE_OPERATION_ID" || return 1
  done
  validate_restored_database_contract
}

scale_fixed_deployment_to_zero_failclose() {
  local deployment="$1" attempt deployment_json after_json
  local uid resource_version replicas selector fingerprint
  local after_uid after_resource_version after_replicas after_selector after_fingerprint
  local deployment_patch
  [[ "$deployment" =~ ^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$ ]] || return 2
  for attempt in 1 2 3; do
    : "$attempt"
    recovery_require_operation_serialization || return 1
    deployment_json="$(recovery_kubectl get deployment "$deployment" \
      -n "$NAMESPACE" -o json)" || continue
    IFS=$'\t' read -r uid resource_version replicas selector fingerprint < <(
      jq -er --arg name "$deployment" --arg namespace "$NAMESPACE" '
        select(.apiVersion == "apps/v1" and .kind == "Deployment") |
        select(.metadata.name == $name and .metadata.namespace == $namespace) |
        select(.metadata.uid | type == "string" and length > 0) |
        select(.metadata.resourceVersion | type == "string" and length > 0) |
        select(.spec.replicas | type == "number" and floor == . and . >= 0) |
        [ .metadata.uid, .metadata.resourceVersion, (.spec.replicas | tostring),
          (if (.spec.selector.matchLabels.app | type) == "string"
           then .spec.selector.matchLabels.app else "" end),
          ({selector:(.spec.selector // {}),strategy:(.spec.strategy // {}),
            template:(.spec.template // {})} | @base64) ] | @tsv
      ' <<<"$deployment_json"
    ) || continue
    if [[ "$replicas" == 0 ]]; then
      recovery_require_operation_serialization || return 1
      printf '%s\t%s\t%s\n' "$uid" "$selector" "$fingerprint"
      return 0
    fi
    deployment_patch="$(jq -cn --arg uid "$uid" \
      --arg resource_version "$resource_version" --argjson replicas "$replicas" '
      [
        {op:"test",path:"/metadata/uid",value:$uid},
        {op:"test",path:"/metadata/resourceVersion",value:$resource_version},
        {op:"test",path:"/spec/replicas",value:$replicas},
        {op:"replace",path:"/spec/replicas",value:0}
      ]
    ')" || continue
    if ! recovery_kubectl_mutate patch deployment "$deployment" \
      -n "$NAMESPACE" --type=json --patch="$deployment_patch" >/dev/null; then
      continue
    fi
    after_json="$(recovery_kubectl get deployment "$deployment" \
      -n "$NAMESPACE" -o json)" || continue
    IFS=$'\t' read -r after_uid after_resource_version after_replicas \
      after_selector after_fingerprint < <(
      jq -er --arg name "$deployment" --arg namespace "$NAMESPACE" '
        select(.apiVersion == "apps/v1" and .kind == "Deployment") |
        select(.metadata.name == $name and .metadata.namespace == $namespace) |
        select(.metadata.uid | type == "string" and length > 0) |
        select(.metadata.resourceVersion | type == "string" and length > 0) |
        select(.spec.replicas | type == "number" and floor == . and . >= 0) |
        [ .metadata.uid, .metadata.resourceVersion, (.spec.replicas | tostring),
          (if (.spec.selector.matchLabels.app | type) == "string"
           then .spec.selector.matchLabels.app else "" end),
          ({selector:(.spec.selector // {}),strategy:(.spec.strategy // {}),
            template:(.spec.template // {})} | @base64) ] | @tsv
      ' <<<"$after_json"
    ) || continue
    if [[ "$after_uid" == "$uid" &&
          -n "$after_resource_version" &&
          "$after_resource_version" != "$resource_version" &&
          "$after_replicas" == 0 &&
          "$after_selector" == "$selector" &&
          "$after_fingerprint" == "$fingerprint" ]]; then
      recovery_require_operation_serialization || return 1
      printf '%s\t%s\t%s\n' "$after_uid" "$after_selector" "$after_fingerprint"
      return 0
    fi
  done
  return 1
}

require_fixed_deployment_zero_failclose() {
  local deployment="$1" expected_uid="$2" expected_selector="$3"
  local expected_fingerprint="$4" deployment_json
  deployment_json="$(recovery_kubectl get deployment "$deployment" \
    -n "$NAMESPACE" -o json)" || return 1
  jq -e --arg name "$deployment" --arg namespace "$NAMESPACE" \
    --arg uid "$expected_uid" --arg selector "$expected_selector" \
    --arg fingerprint "$expected_fingerprint" '
    .apiVersion == "apps/v1" and .kind == "Deployment" and
    .metadata.name == $name and .metadata.namespace == $namespace and
    (.metadata.resourceVersion | type == "string" and length > 0) and
    .metadata.uid == $uid and .spec.replicas == 0 and
    .spec.selector.matchLabels.app == $selector and
    ({selector:(.spec.selector // {}),strategy:(.spec.strategy // {}),
      template:(.spec.template // {})} | @base64) == $fingerprint and
    (.metadata.generation | type == "number" and floor == . and . > 0) and
    .status.observedGeneration == .metadata.generation and
    ((.status.replicas // 0) == 0) and
    ((.status.readyReplicas // 0) == 0) and
    ((.status.availableReplicas // 0) == 0) and
    ((.status.updatedReplicas // 0) == 0) and
    ((.status.unavailableReplicas // 0) == 0)
  ' >/dev/null <<<"$deployment_json"
}

require_no_pods_owned_by_fixed_deployment() {
  local deployment="$1" replica_sets_json pods_json
  replica_sets_json="$(
    recovery_kubectl_get_namespaced_list replicasets "$NAMESPACE"
  )" || return 1
  pods_json="$(
    recovery_kubectl_get_namespaced_list pods "$NAMESPACE"
  )" || return 1
  jq -e --arg deployment "$deployment" '
    .[0] as $replicasets | .[1] as $pods |
    if ($replicasets.apiVersion == "apps/v1" and
        $replicasets.kind == "ReplicaSetList" and
        ($replicasets.metadata.resourceVersion | type) == "string" and
        $replicasets.metadata.resourceVersion != "" and
        ($replicasets.items | type) == "array" and
        $pods.apiVersion == "v1" and $pods.kind == "PodList" and
        ($pods.metadata.resourceVersion | type) == "string" and
        $pods.metadata.resourceVersion != "" and
        ($pods.items | type) == "array") then
      ([ $replicasets.items[]
         | select(.metadata.uid | type == "string" and length > 0)
         | select(any(.metadata.ownerReferences[]?;
             .apiVersion == "apps/v1" and .kind == "Deployment" and
             .name == $deployment and .controller == true))
         | .metadata.uid ] | unique) as $owned_replicaset_uids |
      ([ $pods.items[]
         | select(
             (.metadata.labels.app // "") == $deployment or
             any(.metadata.ownerReferences[]?;
               . as $owner |
               ($owner.apiVersion == "apps/v1" and
                $owner.kind == "Deployment" and
                $owner.name == $deployment and $owner.controller == true) or
               ($owner.apiVersion == "apps/v1" and
                $owner.kind == "ReplicaSet" and
                ($owned_replicaset_uids | index($owner.uid)) != null))) ] |
        length == 0)
    else false end
  ' >/dev/null < <(printf '%s\n%s\n' "$replica_sets_json" "$pods_json" | jq -s '.')
}

quiesce_after_failure() {
  local deployment quiesce_status=0 index failclose_contract uid selector fingerprint
  local expected_fence_state=dormant
  local -a parent_quiesce_order=(3)
  local -a remaining_quiesce_order=(0 1 2 4)
  local -a failclose_uids=() failclose_selectors=() failclose_fingerprints=()
  [[ "$RESTORE_PHASE" == "quiescing" || "$RESTORE_PHASE" == "fence-prepared" ||
     "$RESTORE_PHASE" == "db" || "$RESTORE_PHASE" == "storage" ||
     "$RESTORE_PHASE" == "validating-live" ||
     "$RESTORE_PHASE" == "completing-fenced" ||
     "$RESTORE_PHASE" == "finalizing-reactivation" ||
     "$RESTORE_PHASE" == "legacy-in-place" ||
     "$RESTORE_PHASE" == "cold-rebind" ]] || return 0
  if ! recovery_require_operation_serialization; then
    printf 'The global serialization Lease was lost; fail-close mutation is unsafe.\n' >&2
    return 1
  fi
  if ! require_owned_restore_lock; then
    printf 'Could not revalidate the exact operation lock; continuing reductive fail-close under the owned Lease.\n' >&2
    quiesce_status=1
  fi
  # Fail-close never deactivates an admission fence. It only revokes local
  # monitor processes in dependency order and then forces every writer to zero.
  cleanup_restore_durable_monitor
  cleanup_restore_writer_monitor
  discard_runner_resume_monitor
  # Stop the token-bearing parent first. Durable recovery removes its captured
  # runner authority immediately after that attempt, even when the scale CAS
  # fails, before waiting on the parent or reducing any remaining consumer.
  # These reductions deliberately do not depend on the per-restore ConfigMap:
  # the global Lease is the authority boundary, and drift is reported only
  # after every safe scale-to-zero attempt has been made.
  for index in "${parent_quiesce_order[@]}"; do
    deployment="${CONSUMERS[$index]}"
    if ! failclose_contract="$(
      scale_fixed_deployment_to_zero_failclose "$deployment"
    )"; then
      quiesce_status=1
      continue
    fi
    IFS=$'\t' read -r uid selector fingerprint <<<"$failclose_contract"
    failclose_uids[index]="$uid"
    failclose_selectors[index]="$selector"
    failclose_fingerprints[index]="$fingerprint"
    if [[ -z "${DEPLOYMENT_UIDS[$index]:-}" ||
          "$uid" != "${DEPLOYMENT_UIDS[$index]:-}" ||
          "$selector" != "${DEPLOYMENT_SELECTORS[$index]:-}" ||
          "$fingerprint" != "${DEPLOYMENT_FINGERPRINTS[$index]:-}" ]]; then
      quiesce_status=1
    fi
  done
  if [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == durable-v2 ]] &&
     ! neutralize_runner_role_exact; then
    quiesce_status=1
  fi
  for index in "${parent_quiesce_order[@]}"; do
    uid="${failclose_uids[$index]:-${DEPLOYMENT_UIDS[$index]:-}}"
    selector="${failclose_selectors[$index]:-${DEPLOYMENT_SELECTORS[$index]:-${CONSUMERS[$index]}}}"
    fingerprint="${failclose_fingerprints[$index]:-${DEPLOYMENT_FINGERPRINTS[$index]:-}}"
    if [[ -z "$selector" ]] ||
       ! recovery_wait_for_no_pods "app=$selector" \
         "deployment/${CONSUMERS[$index]}" 180s; then
      quiesce_status=1
    fi
    if ! recovery_wait_for_deployment_rollout "${CONSUMERS[$index]}" 180; then
      quiesce_status=1
    fi
    if [[ -z "$uid" || -z "$selector" || -z "$fingerprint" ]] ||
       ! require_fixed_deployment_zero_failclose "${CONSUMERS[$index]}" \
         "$uid" "$selector" "$fingerprint"; then
      quiesce_status=1
    fi
    if ! require_no_pods_owned_by_fixed_deployment "${CONSUMERS[$index]}"; then
      quiesce_status=1
    fi
  done
  for index in "${remaining_quiesce_order[@]}"; do
    deployment="${CONSUMERS[$index]}"
    if ! failclose_contract="$(
      scale_fixed_deployment_to_zero_failclose "$deployment"
    )"; then
      quiesce_status=1
      continue
    fi
    IFS=$'\t' read -r uid selector fingerprint <<<"$failclose_contract"
    failclose_uids[index]="$uid"
    failclose_selectors[index]="$selector"
    failclose_fingerprints[index]="$fingerprint"
    if [[ -z "${DEPLOYMENT_UIDS[$index]:-}" ||
          "$uid" != "${DEPLOYMENT_UIDS[$index]:-}" ||
          "$selector" != "${DEPLOYMENT_SELECTORS[$index]:-}" ||
          "$fingerprint" != "${DEPLOYMENT_FINGERPRINTS[$index]:-}" ]]; then
      quiesce_status=1
    fi
  done
  for index in "${remaining_quiesce_order[@]}"; do
    [[ -n "${failclose_uids[$index]:-}" ]] || {
      quiesce_status=1
      continue
    }
    if [[ -z "${failclose_selectors[$index]:-}" ]] ||
       ! recovery_wait_for_no_pods "app=${failclose_selectors[$index]}" \
         "deployment/${CONSUMERS[$index]}" 180s; then
      quiesce_status=1
    fi
    if ! recovery_wait_for_deployment_rollout "${CONSUMERS[$index]}" 180; then
      quiesce_status=1
    fi
    if ! require_fixed_deployment_zero_failclose "${CONSUMERS[$index]}" \
      "${failclose_uids[$index]}" "${failclose_selectors[$index]}" \
      "${failclose_fingerprints[$index]}"; then
      quiesce_status=1
    fi
    if ! require_no_pods_owned_by_fixed_deployment "${CONSUMERS[$index]}"; then
      quiesce_status=1
    fi
  done
  # Generation-specific reduction is deliberately asymmetric. Legacy restore
  # never writes runner control-plane resources. Durable fail-close first
  # removes the captured Role's create/delete authority by exact CAS, then
  # reconciles only exact intents/runners into permanent fences.
  if [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == durable-v2 ]]; then
    # Re-read and idempotently neutralize once more after every fixed workload
    # reduction. A prior exact success is a no-op; a transient earlier failure
    # gets one final bounded opportunity without adopting a replacement Role.
    if ! neutralize_runner_role_exact; then
      quiesce_status=1
    fi
    if ! reconcile_checkpoint_runner_quiescence; then
      quiesce_status=1
    fi
    if ! require_runner_absence_stable; then
      quiesce_status=1
    fi
    expected_fence_state=dormant
    [[ -z "$RESTORE_OPERATION_FENCE_ACTIVE_IDENTITY" ]] ||
      expected_fence_state=active
    if ! require_durable_checkpoint_evidence_for_parent_state \
      "$expected_fence_state"; then
      quiesce_status=1
    fi
  elif ! reconcile_checkpoint_runner_quiescence; then
    quiesce_status=1
  fi
  [[ "$quiesce_status" == 0 ]] || return 1
  printf 'Coordinated restore failed; all DB consumers were forced back to zero.\n' >&2
}

run_legacy_in_place_restore() {
  local index deployment db_confirmation storage_confirmation
  local receipt_resource_version
  local -a quiesce_order=(3 0 1 2 4)
  local -a resume_order=(1 2 4)
  [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == legacy-absent ]] || return 1
  RECOVERY_FENCE_PRE_EPOCH=""
  RECOVERY_FENCE_TARGET_EPOCH=""
  RECOVERY_OPERATION_STATE=legacy-in-place
  require_legacy_restore_confirmation
  RESTORE_PHASE=locking
  recovery_require_restore_target_binding
  recovery_require_checkpoint_generation_matches_live \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY" "$VALUES_SOURCE_FILE"
  recovery_require_live_images_match_checkpoint \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY"
  acquire_restore_serialization
  recovery_require_cluster_identity
  recovery_require_pvc_identity ret-pvc
  recovery_require_restore_target_binding
  recovery_require_checkpoint_generation_matches_live \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY" "$VALUES_SOURCE_FILE"
  recovery_require_live_images_match_checkpoint \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY"
  acquire_restore_lock
  RESTORE_PHASE=legacy-in-place
  capture_consumer_contracts_at_replicas 1 1
  # A receipt is an unfinished authority transfer from an earlier operation.
  # Reject it before downtime while this process's new lock is still safely
  # releasable; the exact RV equality also closes metadata drift after capture.
  require_owned_restore_lock
  for index in "${!CONSUMERS[@]}"; do
    receipt_resource_version="$(
      recovery_capture_checkpoint_resume_receipt_absent_contract \
        "${CONSUMERS[$index]}" "${DEPLOYMENT_UIDS[$index]}" 1 \
        "${DEPLOYMENT_SELECTORS[$index]}" "${DEPLOYMENT_FINGERPRINTS[$index]}"
    )" || return 1
    [[ "$receipt_resource_version" == \
       "${DEPLOYMENT_RESOURCE_VERSIONS[$index]}" ]] || return 1
  done
  recovery_require_operation_serialization
  require_owned_restore_lock
  RESTORE_LOCK_RELEASE_ON_INTERRUPT=0

  for index in "${quiesce_order[@]}"; do
    recovery_require_checkpoint_generation_matches_live \
      "$RECOVERY_DEPLOYMENT_INVENTORY_COPY" "$VALUES_SOURCE_FILE"
    DEPLOYMENT_RESOURCE_VERSIONS[index]="$(recovery_scale_deployment_exact \
      "${CONSUMERS[$index]}" "${DEPLOYMENT_UIDS[$index]}" \
      "${DEPLOYMENT_RESOURCE_VERSIONS[$index]}" 1 0 \
      "${DEPLOYMENT_SELECTORS[$index]}" "${DEPLOYMENT_FINGERPRINTS[$index]}")" || return 1
  done
  for index in "${!CONSUMERS[@]}"; do
    recovery_wait_for_no_pods "app=${DEPLOYMENT_SELECTORS[$index]}" \
      "deployment/${CONSUMERS[$index]}" 180s || return 1
    recovery_require_consumer_contract_entry \
      "$RECOVERY_CONSUMER_CONTRACT_JSON" "${CONSUMERS[$index]}" 0 \
      "$RESTORE_OPERATION_ID" || return 1
  done
  reconcile_checkpoint_runner_quiescence
  start_restore_writer_monitor
  require_restore_writer_monitor_healthy
  start_runner_resume_monitor

  db_confirmation="$(recovery_confirmation_value retdb)" || return 1
  storage_confirmation="$(
    recovery_confirmation_value ret-pvc "$RECOVERY_PVC_UID"
  )" || return 1
  recovery_require_checkpoint_generation_matches_live \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY" "$VALUES_SOURCE_FILE"
  require_owned_restore_lock
  require_restore_writer_monitor_healthy
  VALUES_FILE="$VALUES_SOURCE_FILE" \
  RESTORE_COORDINATED=1 RESTORE_ALREADY_FENCED=1 \
  CONFIRM_RESTORE="$db_confirmation" \
  YENHUBS_PARENT_LEASE_HOLDER="$RECOVERY_SERIALIZATION_LEASE_HOLDER" \
  YENHUBS_PARENT_LEASE_UID="$RECOVERY_SERIALIZATION_LEASE_UID" \
  YENHUBS_PARENT_PROCESS_PID="$RECOVERY_SERIALIZATION_PARENT_PID" \
  YENHUBS_PARENT_PROCESS_START_IDENTITY="$RECOVERY_SERIALIZATION_PARENT_START_IDENTITY" \
  YENHUBS_PARENT_WRITER_MONITOR_CONTRACT_PATH="$RESTORE_WRITER_MONITOR_CONTRACT" \
  YENHUBS_PARENT_WRITER_MONITOR_CONTRACT_SHA256="$RESTORE_WRITER_MONITOR_CONTRACT_SHA256" \
  YENHUBS_PARENT_WRITER_MONITOR_BASELINE_PATH="$RESTORE_WRITER_MONITOR_BASELINE" \
  YENHUBS_PARENT_WRITER_MONITOR_BASELINE_SHA256="$RESTORE_WRITER_MONITOR_BASELINE_SHA256" \
  YENHUBS_PARENT_WRITER_MONITOR_FAILURE_PATH="$RESTORE_WRITER_MONITOR_FAILURE" \
  YENHUBS_PARENT_WRITER_MONITOR_READY_PATH="$RESTORE_WRITER_MONITOR_READY" \
  YENHUBS_PARENT_WRITER_MONITOR_PROGRESS_PATH="$RESTORE_WRITER_MONITOR_PROGRESS" \
  YENHUBS_PARENT_WRITER_MONITOR_AUTHORITY_SHA256="$RESTORE_WRITER_MONITOR_AUTHORITY_SHA256" \
  YENHUBS_PARENT_WRITER_MONITOR_PID="$RESTORE_WRITER_MONITOR_PID" \
  YENHUBS_PARENT_WRITER_MONITOR_START_IDENTITY="$RESTORE_WRITER_MONITOR_START_IDENTITY" \
    "$SCRIPT_DIR/restore-retdb.sh" "$DUMP_PATH"
  recovery_require_operation_serialization
  require_owned_restore_lock
  require_restore_writer_monitor_healthy
  require_runner_resume_monitor_healthy
  recovery_require_checkpoint_generation_matches_live \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY" "$VALUES_SOURCE_FILE"
  VALUES_FILE="$VALUES_SOURCE_FILE" \
  RESTORE_COORDINATED=1 CONFIRM_RESTORE_STORAGE="$storage_confirmation" \
  YENHUBS_PARENT_LEASE_HOLDER="$RECOVERY_SERIALIZATION_LEASE_HOLDER" \
  YENHUBS_PARENT_LEASE_UID="$RECOVERY_SERIALIZATION_LEASE_UID" \
  YENHUBS_PARENT_PROCESS_PID="$RECOVERY_SERIALIZATION_PARENT_PID" \
  YENHUBS_PARENT_PROCESS_START_IDENTITY="$RECOVERY_SERIALIZATION_PARENT_START_IDENTITY" \
  YENHUBS_PARENT_WRITER_MONITOR_CONTRACT_PATH="$RESTORE_WRITER_MONITOR_CONTRACT" \
  YENHUBS_PARENT_WRITER_MONITOR_CONTRACT_SHA256="$RESTORE_WRITER_MONITOR_CONTRACT_SHA256" \
  YENHUBS_PARENT_WRITER_MONITOR_BASELINE_PATH="$RESTORE_WRITER_MONITOR_BASELINE" \
  YENHUBS_PARENT_WRITER_MONITOR_BASELINE_SHA256="$RESTORE_WRITER_MONITOR_BASELINE_SHA256" \
  YENHUBS_PARENT_WRITER_MONITOR_FAILURE_PATH="$RESTORE_WRITER_MONITOR_FAILURE" \
  YENHUBS_PARENT_WRITER_MONITOR_READY_PATH="$RESTORE_WRITER_MONITOR_READY" \
  YENHUBS_PARENT_WRITER_MONITOR_PROGRESS_PATH="$RESTORE_WRITER_MONITOR_PROGRESS" \
  YENHUBS_PARENT_WRITER_MONITOR_AUTHORITY_SHA256="$RESTORE_WRITER_MONITOR_AUTHORITY_SHA256" \
  YENHUBS_PARENT_WRITER_MONITOR_PID="$RESTORE_WRITER_MONITOR_PID" \
  YENHUBS_PARENT_WRITER_MONITOR_START_IDENTITY="$RESTORE_WRITER_MONITOR_START_IDENTITY" \
    "$SCRIPT_DIR/restore-ret-storage.sh" "$STORAGE_PATH"
  recovery_require_operation_serialization
  require_owned_restore_lock
  require_restore_writer_monitor_healthy
  require_runner_resume_monitor_healthy
  recovery_require_exact_pvc_consumers ret-pvc
  require_checkpoint_runner_quiescent_now
  for deployment in "${CONSUMERS[@]}"; do
    recovery_require_consumer_contract_entry \
      "$RECOVERY_CONSUMER_CONTRACT_JSON" "$deployment" 0 \
      "$RESTORE_OPERATION_ID" || return 1
  done
  validate_restored_database_contract
  require_restore_writer_monitor_healthy
  recovery_require_exact_pvc_consumers ret-pvc
  require_checkpoint_runner_quiescent_now
  for deployment in "${CONSUMERS[@]}"; do
    recovery_require_consumer_contract_entry \
      "$RECOVERY_CONSUMER_CONTRACT_JSON" "$deployment" 0 \
      "$RESTORE_OPERATION_ID" || return 1
  done
  recovery_require_checkpoint_generation_matches_live \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY" "$VALUES_SOURCE_FILE"
  require_owned_restore_lock
  require_runner_resume_monitor_healthy
  handoff_restore_writer_monitor_with_receipt
  # ACK transfers writer authority to the exact reticulum metadata receipt.
  # This local-only runner check performs no Kubernetes read, so the first CAS
  # consumes the ACK terminal resourceVersion without a TOCTOU recapture.
  require_runner_resume_monitor_healthy

  index=0
  DEPLOYMENT_RESOURCE_VERSIONS[index]="$(
    recovery_scale_deployment_with_checkpoint_receipt_exact \
      "${CONSUMERS[$index]}" "${DEPLOYMENT_UIDS[$index]}" \
      "${DEPLOYMENT_RESOURCE_VERSIONS[$index]}" \
      "${DEPLOYMENT_SELECTORS[$index]}" "${DEPLOYMENT_FINGERPRINTS[$index]}" \
      "$RESTORE_OPERATION_ID"
  )" || return 1
  recovery_wait_for_deployment_rollout "${CONSUMERS[$index]}" 300 || return 1
  receipt_resource_version="$(
    recovery_capture_checkpoint_resume_receipt_contract \
      "${CONSUMERS[$index]}" "${DEPLOYMENT_UIDS[$index]}" 1 \
      "${DEPLOYMENT_SELECTORS[$index]}" "${DEPLOYMENT_FINGERPRINTS[$index]}" \
      "$RESTORE_OPERATION_ID"
  )" || return 1
  DEPLOYMENT_RESOURCE_VERSIONS[index]="$(
    recovery_clear_checkpoint_resume_receipt_exact \
      "${CONSUMERS[$index]}" "${DEPLOYMENT_UIDS[$index]}" \
      "$receipt_resource_version" 1 "${DEPLOYMENT_SELECTORS[$index]}" \
      "${DEPLOYMENT_FINGERPRINTS[$index]}" "$RESTORE_OPERATION_ID"
  )" || return 1
  DEPLOYMENT_RESOURCE_VERSIONS[index]="$(
    recovery_capture_checkpoint_resume_receipt_absent_contract \
      "${CONSUMERS[$index]}" "${DEPLOYMENT_UIDS[$index]}" 1 \
      "${DEPLOYMENT_SELECTORS[$index]}" "${DEPLOYMENT_FINGERPRINTS[$index]}"
  )" || return 1
  recovery_require_consumer_contract_entry \
    "$RECOVERY_CONSUMER_CONTRACT_JSON" "${CONSUMERS[$index]}" 1 \
    "$RESTORE_OPERATION_ID" || return 1

  for index in "${resume_order[@]}"; do
    recovery_require_checkpoint_generation_matches_live \
      "$RECOVERY_DEPLOYMENT_INVENTORY_COPY" "$VALUES_SOURCE_FILE"
    require_runner_resume_monitor_healthy
    DEPLOYMENT_RESOURCE_VERSIONS[index]="$(recovery_scale_deployment_exact \
      "${CONSUMERS[$index]}" "${DEPLOYMENT_UIDS[$index]}" \
      "${DEPLOYMENT_RESOURCE_VERSIONS[$index]}" 0 1 \
      "${DEPLOYMENT_SELECTORS[$index]}" "${DEPLOYMENT_FINGERPRINTS[$index]}")" || return 1
    recovery_wait_for_deployment_rollout "${CONSUMERS[$index]}" 300 || return 1
    recovery_require_consumer_contract_entry \
      "$RECOVERY_CONSUMER_CONTRACT_JSON" "${CONSUMERS[$index]}" 1 \
      "$RESTORE_OPERATION_ID" || return 1
  done
  require_runner_resume_monitor_healthy
  stop_runner_resume_monitor_before_parent
  index=3
  recovery_require_checkpoint_generation_matches_live \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY" "$VALUES_SOURCE_FILE"
  DEPLOYMENT_RESOURCE_VERSIONS[index]="$(recovery_scale_deployment_exact \
    "${CONSUMERS[$index]}" "${DEPLOYMENT_UIDS[$index]}" \
    "${DEPLOYMENT_RESOURCE_VERSIONS[$index]}" 0 1 \
    "${DEPLOYMENT_SELECTORS[$index]}" "${DEPLOYMENT_FINGERPRINTS[$index]}")" || return 1
  recovery_wait_for_deployment_rollout "${CONSUMERS[$index]}" 300 || return 1
  recovery_require_consumer_contract_entry \
    "$RECOVERY_CONSUMER_CONTRACT_JSON" "${CONSUMERS[$index]}" 1 \
    "$RESTORE_OPERATION_ID" || return 1

  recovery_require_checkpoint_generation_matches_live \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY" "$VALUES_SOURCE_FILE"
  recovery_require_live_images_match_checkpoint \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY"
  verify_legacy_live_reactivation
  recovery_require_cluster_identity
  recovery_require_pvc_identity ret-pvc
  recovery_require_checkpoint_generation_matches_live \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY" "$VALUES_SOURCE_FILE"
  recovery_require_live_images_match_checkpoint \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY"
  require_owned_restore_lock
  release_restore_lock
  RESTORE_PHASE=complete
  release_restore_serialization
  trap - ERR
  printf 'Legacy in-place checkpoint restore completed without crossing runner generation: checkpoint=%s namespace=%s\n' \
    "$stamp" "$NAMESPACE"
}

run_cold_rebind_restore() {
  local index db_confirmation storage_confirmation expected_confirmation
  local materialized_bundle
  local -a resume_order=(1 2 0 4)
  [[ "${RESTORE_TARGET_MODE:-in-place}" == cold-rebind &&
     "$RECOVERY_CHECKPOINT_METADATA_SCHEMA" == freeze-bundle-v1 &&
     "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == legacy-absent ]] || return 2
  materialized_bundle="$(dirname "$RECOVERY_CHECKPOINT_METADATA_COPY")"
  if ! recovery_private_values_file_is_acceptable "$FREEZE_RECEIPT_INPUT_FILE" ||
     ! recovery_freeze_bundle_receipt_is_acceptable \
       "$FREEZE_RECEIPT_INPUT_FILE" "$materialized_bundle"; then
    printf 'Cold rebind requires the separately protected exact freeze receipt.\n' >&2
    return 1
  fi
  RECOVERY_FENCE_PRE_EPOCH=""
  RECOVERY_FENCE_TARGET_EPOCH=""
  RECOVERY_OPERATION_STATE=cold-rebind
  RECOVERY_OPERATION_ID="${COLD_REBIND_OPERATION_ID:-}"
  if [[ ! "$RECOVERY_OPERATION_ID" =~ ^[a-f0-9]{32}$ ||
        "$RECOVERY_OPERATION_ID" == "$RECOVERY_FREEZE_ID" ]]; then
    printf 'COLD_REBIND_OPERATION_ID must be a new lowercase 32-hex identifier.\n' >&2
    return 1
  fi
  if ! RECOVERY_OPERATION_TOKEN="$(
      od -An -N16 -tx1 /dev/urandom | tr -d '[:space:]'
    )" || [[ ! "$RECOVERY_OPERATION_TOKEN" =~ ^[a-f0-9]{32}$ ]]; then
    printf 'Could not create the private cold-rebind operation token.\n' >&2
    return 1
  fi
  RECOVERY_OPERATION_IDENTITY_PREBOUND=1
  RECOVERY_COLD_REBIND_OPERATION_ID="$RECOVERY_OPERATION_ID"
  recovery_require_cluster_identity
  recovery_require_pvc_identity ret-pvc
  recovery_require_cold_rebind_target_bootstrap "$VALUES_SOURCE_FILE"
  expected_confirmation="$(recovery_restore_rebind_confirmation_value)" || return 1
  [[ "${CONFIRM_COLD_REBIND_RESTORE:-}" == "$expected_confirmation" ]] || {
    printf 'Refusing cold rebind. Set CONFIRM_COLD_REBIND_RESTORE=%q for this exact source, content, target and operation.\n' \
      "$expected_confirmation" >&2
    return 1
  }

  RESTORE_PHASE=locking
  acquire_restore_serialization
  recovery_require_cluster_identity
  recovery_require_pvc_identity ret-pvc
  recovery_require_cold_rebind_target_bootstrap "$VALUES_SOURCE_FILE"
  recovery_freeze_bundle_receipt_is_acceptable \
    "$FREEZE_RECEIPT_INPUT_FILE" "$materialized_bundle"
  [[ "$(recovery_restore_rebind_confirmation_value)" == \
     "$expected_confirmation" ]] || {
    printf 'Cold rebind binding drifted after serialization.\n' >&2
    return 1
  }
  acquire_restore_lock
  [[ "$RESTORE_OPERATION_ID" == "$RECOVERY_COLD_REBIND_OPERATION_ID" ]] || return 1
  RESTORE_PHASE=cold-rebind
  capture_consumer_contracts_at_replicas 0 1
  for index in "${!CONSUMERS[@]}"; do
    recovery_wait_for_no_pods "app=${DEPLOYMENT_SELECTORS[$index]}" \
      "deployment/${CONSUMERS[$index]}" 180s
    recovery_require_consumer_contract_entry \
      "$RECOVERY_CONSUMER_CONTRACT_JSON" "${CONSUMERS[$index]}" 0 \
      "$RESTORE_OPERATION_ID"
  done
  recovery_require_exact_pvc_consumers ret-pvc
  reconcile_checkpoint_runner_quiescence
  start_restore_writer_monitor
  require_restore_writer_monitor_healthy
  # From this boundary onward DB/media bytes can change. A later failure must
  # retain the exact lock and keep all five writers quiescent for diagnosis.
  RESTORE_LOCK_RELEASE_ON_INTERRUPT=0

  db_confirmation="$(recovery_confirmation_value retdb)" || return 1
  storage_confirmation="$(
    recovery_confirmation_value ret-pvc "$RECOVERY_PVC_UID"
  )" || return 1
  require_owned_restore_lock
  require_restore_writer_monitor_healthy
  VALUES_FILE="$VALUES_SOURCE_FILE" RESTORE_TARGET_MODE=cold-rebind \
  RESTORE_COORDINATED=1 RESTORE_ALREADY_FENCED=1 \
  CONFIRM_RESTORE="$db_confirmation" \
  YENHUBS_PARENT_LEASE_HOLDER="$RECOVERY_SERIALIZATION_LEASE_HOLDER" \
  YENHUBS_PARENT_LEASE_UID="$RECOVERY_SERIALIZATION_LEASE_UID" \
  YENHUBS_PARENT_PROCESS_PID="$RECOVERY_SERIALIZATION_PARENT_PID" \
  YENHUBS_PARENT_PROCESS_START_IDENTITY="$RECOVERY_SERIALIZATION_PARENT_START_IDENTITY" \
  YENHUBS_PARENT_WRITER_MONITOR_CONTRACT_PATH="$RESTORE_WRITER_MONITOR_CONTRACT" \
  YENHUBS_PARENT_WRITER_MONITOR_CONTRACT_SHA256="$RESTORE_WRITER_MONITOR_CONTRACT_SHA256" \
  YENHUBS_PARENT_WRITER_MONITOR_BASELINE_PATH="$RESTORE_WRITER_MONITOR_BASELINE" \
  YENHUBS_PARENT_WRITER_MONITOR_BASELINE_SHA256="$RESTORE_WRITER_MONITOR_BASELINE_SHA256" \
  YENHUBS_PARENT_WRITER_MONITOR_FAILURE_PATH="$RESTORE_WRITER_MONITOR_FAILURE" \
  YENHUBS_PARENT_WRITER_MONITOR_READY_PATH="$RESTORE_WRITER_MONITOR_READY" \
  YENHUBS_PARENT_WRITER_MONITOR_PROGRESS_PATH="$RESTORE_WRITER_MONITOR_PROGRESS" \
  YENHUBS_PARENT_WRITER_MONITOR_AUTHORITY_SHA256="$RESTORE_WRITER_MONITOR_AUTHORITY_SHA256" \
  YENHUBS_PARENT_WRITER_MONITOR_PID="$RESTORE_WRITER_MONITOR_PID" \
  YENHUBS_PARENT_WRITER_MONITOR_START_IDENTITY="$RESTORE_WRITER_MONITOR_START_IDENTITY" \
    "$SCRIPT_DIR/restore-retdb.sh" "$DUMP_PATH"
  recovery_require_operation_serialization
  require_owned_restore_lock
  require_restore_writer_monitor_healthy
  VALUES_FILE="$VALUES_SOURCE_FILE" RESTORE_TARGET_MODE=cold-rebind \
  RESTORE_COORDINATED=1 CONFIRM_RESTORE_STORAGE="$storage_confirmation" \
  RESTORE_STORAGE_CLEAR_ORPHAN_ROOT="${RESTORE_STORAGE_CLEAR_ORPHAN_ROOT:-0}" \
  RESTORE_STORAGE_ORPHAN_SOURCE_OPERATION_ID="${RESTORE_STORAGE_ORPHAN_SOURCE_OPERATION_ID:-}" \
  CONFIRM_RESTORE_ORPHAN_ROOT="${CONFIRM_RESTORE_ORPHAN_ROOT:-}" \
  YENHUBS_PARENT_LEASE_HOLDER="$RECOVERY_SERIALIZATION_LEASE_HOLDER" \
  YENHUBS_PARENT_LEASE_UID="$RECOVERY_SERIALIZATION_LEASE_UID" \
  YENHUBS_PARENT_PROCESS_PID="$RECOVERY_SERIALIZATION_PARENT_PID" \
  YENHUBS_PARENT_PROCESS_START_IDENTITY="$RECOVERY_SERIALIZATION_PARENT_START_IDENTITY" \
  YENHUBS_PARENT_WRITER_MONITOR_CONTRACT_PATH="$RESTORE_WRITER_MONITOR_CONTRACT" \
  YENHUBS_PARENT_WRITER_MONITOR_CONTRACT_SHA256="$RESTORE_WRITER_MONITOR_CONTRACT_SHA256" \
  YENHUBS_PARENT_WRITER_MONITOR_BASELINE_PATH="$RESTORE_WRITER_MONITOR_BASELINE" \
  YENHUBS_PARENT_WRITER_MONITOR_BASELINE_SHA256="$RESTORE_WRITER_MONITOR_BASELINE_SHA256" \
  YENHUBS_PARENT_WRITER_MONITOR_FAILURE_PATH="$RESTORE_WRITER_MONITOR_FAILURE" \
  YENHUBS_PARENT_WRITER_MONITOR_READY_PATH="$RESTORE_WRITER_MONITOR_READY" \
  YENHUBS_PARENT_WRITER_MONITOR_PROGRESS_PATH="$RESTORE_WRITER_MONITOR_PROGRESS" \
  YENHUBS_PARENT_WRITER_MONITOR_AUTHORITY_SHA256="$RESTORE_WRITER_MONITOR_AUTHORITY_SHA256" \
  YENHUBS_PARENT_WRITER_MONITOR_PID="$RESTORE_WRITER_MONITOR_PID" \
  YENHUBS_PARENT_WRITER_MONITOR_START_IDENTITY="$RESTORE_WRITER_MONITOR_START_IDENTITY" \
    "$SCRIPT_DIR/restore-ret-storage.sh" "$STORAGE_PATH"
  recovery_require_operation_serialization
  require_owned_restore_lock
  require_restore_writer_monitor_healthy
  recovery_require_exact_pvc_consumers ret-pvc
  for index in "${!CONSUMERS[@]}"; do
    recovery_require_consumer_contract_entry \
      "$RECOVERY_CONSUMER_CONTRACT_JSON" "${CONSUMERS[$index]}" 0 \
      "$RESTORE_OPERATION_ID"
  done
  validate_restored_database_contract
  recovery_verify_freeze_bundle_directory \
    "$materialized_bundle" "$RECOVERY_CHECKPOINT_STAMP"
  stop_restore_writer_monitor_after_restore
  start_runner_resume_monitor
  require_runner_resume_monitor_healthy

  for index in "${resume_order[@]}"; do
    if ! require_owned_restore_lock; then
      printf 'Cold rebind lost its exact restore lock before resuming %s.\n' \
        "${CONSUMERS[$index]}" >&2
      return 1
    fi
    if ! require_runner_resume_monitor_healthy; then
      printf 'Cold rebind lost runner-absence coverage before resuming %s.\n' \
        "${CONSUMERS[$index]}" >&2
      return 1
    fi
    if ! DEPLOYMENT_RESOURCE_VERSIONS[index]="$(recovery_scale_deployment_exact \
        "${CONSUMERS[$index]}" "${DEPLOYMENT_UIDS[$index]}" \
        "${DEPLOYMENT_RESOURCE_VERSIONS[$index]}" 0 1 \
        "${DEPLOYMENT_SELECTORS[$index]}" "${DEPLOYMENT_FINGERPRINTS[$index]}")"; then
      printf 'Cold rebind could not scale %s from its exact frozen contract.\n' \
        "${CONSUMERS[$index]}" >&2
      return 1
    fi
    if ! recovery_wait_for_deployment_rollout "${CONSUMERS[$index]}" 300; then
      printf 'Cold rebind rollout did not become ready: %s.\n' \
        "${CONSUMERS[$index]}" >&2
      return 1
    fi
    if ! recovery_require_consumer_contract_entry \
        "$RECOVERY_CONSUMER_CONTRACT_JSON" "${CONSUMERS[$index]}" 1 \
        "$RESTORE_OPERATION_ID"; then
      printf 'Cold rebind post-resume contract changed: %s.\n' \
        "${CONSUMERS[$index]}" >&2
      return 1
    fi
  done
  if ! stop_runner_resume_monitor_before_parent; then
    printf 'Cold rebind could not close runner-absence coverage before the parent.\n' >&2
    return 1
  fi
  index=3
  if ! require_owned_restore_lock; then
    printf 'Cold rebind lost its exact restore lock before resuming the parent.\n' >&2
    return 1
  fi
  if ! DEPLOYMENT_RESOURCE_VERSIONS[index]="$(recovery_scale_deployment_exact \
      "${CONSUMERS[$index]}" "${DEPLOYMENT_UIDS[$index]}" \
      "${DEPLOYMENT_RESOURCE_VERSIONS[$index]}" 0 1 \
      "${DEPLOYMENT_SELECTORS[$index]}" "${DEPLOYMENT_FINGERPRINTS[$index]}")"; then
    printf 'Cold rebind could not scale the parent from its exact frozen contract.\n' >&2
    return 1
  fi
  if ! recovery_wait_for_deployment_rollout "${CONSUMERS[$index]}" 300; then
    printf 'Cold rebind parent rollout did not become ready.\n' >&2
    return 1
  fi
  if ! recovery_require_consumer_contract_entry \
      "$RECOVERY_CONSUMER_CONTRACT_JSON" "${CONSUMERS[$index]}" 1 \
      "$RESTORE_OPERATION_ID"; then
    printf 'Cold rebind parent post-resume contract changed.\n' >&2
    return 1
  fi
  if ! verify_legacy_live_reactivation; then
    printf 'Cold rebind local live verification failed.\n' >&2
    return 1
  fi
  if ! run_restore_live_reactivation_verifier; then
    printf 'Cold rebind external live verification failed.\n' >&2
    return 1
  fi
  recovery_require_cluster_identity || return 1
  recovery_require_pvc_identity ret-pvc || return 1
  recovery_require_restore_target_binding || return 1
  if ! require_owned_restore_lock; then
    printf 'Cold rebind lost its exact restore lock before terminal release.\n' >&2
    return 1
  fi
  release_restore_lock
  RESTORE_PHASE=complete
  release_restore_serialization
  trap - ERR
  printf 'Cold rebind completed from freeze=%s into new cluster=%s namespace_uid=%s pvc_uid=%s.\n' \
    "$RECOVERY_FREEZE_ID" "$RECOVERY_TARGET_CLUSTER_UID" \
    "$RECOVERY_NAMESPACE_UID" "$RECOVERY_PVC_UID"
}

driver_failed() {
  local status=$?
  local quiesced=1
  # errtrace copies ERR into command substitutions and background subshells.
  # They hold only stale copies of phase/lock capabilities and must never run
  # the fail-close mutator; the main shell will receive the nonzero status and
  # perform the single authoritative recovery pass.
  if ((BASH_SUBSHELL > 0)); then
    return "$status"
  fi
  trap - ERR
  if [[ "$RESTORE_LOCK_RELEASE_ON_INTERRUPT" == 1 ]]; then
    if release_restore_lock; then
      printf 'The newly created restore lock was released before any restore mutation.\n' >&2
    else
      printf 'The pre-mutation restore lock could not be released safely; production was not reduced.\n' >&2
    fi
    return "$status"
  fi
  if ! quiesce_after_failure; then
    quiesced=0
    printf 'Automatic fail-closed quiesce could not be completed.\n' >&2
  fi
  if [[ "$RESTORE_LOCK_CREATED" == "1" ]]; then
    if [[ "$RESTORE_PHASE" == "quiescing" || "$RESTORE_PHASE" == "fence-prepared" ||
          "$RESTORE_PHASE" == "db" || "$RESTORE_PHASE" == "storage" ||
          "$RESTORE_PHASE" == "validating-live" ||
          "$RESTORE_PHASE" == "completing-fenced" ||
          "$RESTORE_PHASE" == "finalizing-reactivation" ||
          "$RESTORE_PHASE" == "legacy-in-place" ||
          "$RESTORE_PHASE" == "cold-rebind" ]]; then
      if [[ "$quiesced" == "1" ]]; then
        printf 'The owned restore lock is retained for inspection; consumers remain at zero.\n' >&2
      else
        printf 'The owned restore lock is retained; consumer state requires manual inspection.\n' >&2
      fi
    else
      printf 'The owned restore lock is retained for inspection; no restore mutation began.\n' >&2
    fi
  fi
  return "$status"
}

driver_interrupted() {
  local status="$1"
  RESTORE_INTERRUPT_IN_PROGRESS=1
  trap - EXIT ERR
  trap '' INT TERM
  if [[ "$RESTORE_LOCK_RELEASE_ON_INTERRUPT" == 1 ]]; then
    if ! release_restore_lock; then
      printf 'The interrupted pre-mutation restore lock could not be released safely; production was not reduced.\n' >&2
    fi
    cleanup_driver
    exit "$status"
  fi
  if ! quiesce_after_failure; then
    printf 'Automatic fail-closed quiesce could not be completed.\n' >&2
  fi
  cleanup_driver
  exit "$status"
}

trap cleanup_driver EXIT
trap driver_failed ERR
trap 'driver_interrupted 130' INT
trap 'driver_interrupted 143' TERM

# This validation and private materialization happens before any Kubernetes
# read, and is repeated by each child immediately before its own operation.
recovery_materialize_checkpoint "$DUMP_PATH" "$SCRIPT_DIR/validate-checkpoint.sh"
DUMP_PATH="$RECOVERY_DUMP_COPY"
STORAGE_PATH="$RECOVERY_STORAGE_COPY"
export RECOVERY_CHECKPOINT_METADATA_SCHEMA RECOVERY_CHECKPOINT_RUNNER_GENERATION \
  RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256 RECOVERY_RUNNER_RUNTIME_GENERATION \
  RECOVERY_CHECKPOINT_OPERATION_ID
if (( PREPARE_FENCE + EXECUTE_FENCED + FINALIZE_REACTIVATION > 0 )) &&
   [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" != durable-v2 ]]; then
  printf 'prepare/execute/finalize restore-fence phases accept only durable-v2 checkpoints; use the explicit legacy in-place operation for legacy checkpoints.\n' >&2
  exit 1
fi
if [[ "$LEGACY_IN_PLACE" == 1 &&
      "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" != legacy-absent ]]; then
  printf 'The one-shot legacy in-place operation accepts only legacy-absent checkpoints.\n' >&2
  exit 1
fi
if [[ "${RESTORE_TARGET_MODE:-in-place}" == cold-rebind &&
      "$RECOVERY_CHECKPOINT_METADATA_SCHEMA" != freeze-bundle-v1 ]]; then
  printf 'Cold rebind accepts only a complete freeze-bundle-v1.\n' >&2
  exit 1
fi
if [[ "${RESTORE_TARGET_MODE:-in-place}" == in-place &&
      "$RECOVERY_CHECKPOINT_METADATA_SCHEMA" == freeze-bundle-v1 ]]; then
  printf 'freeze-bundle-v1 requires RESTORE_TARGET_MODE=cold-rebind.\n' >&2
  exit 1
fi
snapshot_restore_private_file RESTORE_VALUES_SNAPSHOT "$VALUES_INPUT_FILE" values
VALUES_SOURCE_FILE="$RESTORE_VALUES_SNAPSHOT"
if [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == durable-v2 ]]; then
  [[ -n "$CUTOVER_KEY_INPUT_FILE" ]] || {
    printf 'PROCESS_LOCAL_CUTOVER_KEY_PATH is required for durable restore evidence.\n' >&2
    exit 1
  }
  snapshot_restore_private_file \
    RESTORE_MANIFEST_SNAPSHOT "$MANIFEST_INPUT_FILE" manifest
  snapshot_restore_private_file \
    RESTORE_CUTOVER_KEY_SNAPSHOT "$CUTOVER_KEY_INPUT_FILE" cutover-key
  HCCE_MANIFEST_PATH="$RESTORE_MANIFEST_SNAPSHOT"
  PROCESS_LOCAL_CUTOVER_KEY_PATH="$RESTORE_CUTOVER_KEY_SNAPSHOT"
  export PROCESS_LOCAL_CUTOVER_KEY_PATH
  materialize_historical_source_values
fi
recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc

if [[ "$CLEAR_STALE_LOCK" == "1" ]]; then
  acquire_restore_serialization
  clear_stale_restore_lock
  release_restore_serialization
  exit 0
fi

if [[ "$PREFLIGHT" == 1 || "$PREPARE_FENCE" == 1 ]]; then
  recovery_require_restore_target_binding
  if [[ "${RESTORE_TARGET_MODE:-in-place}" == cold-rebind ]]; then
    recovery_require_cold_rebind_target_bootstrap "$VALUES_SOURCE_FILE"
  elif [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == durable-v2 ]]; then
    if ! recovery_require_durable_checkpoint_source_matches_live \
      "$RECOVERY_DEPLOYMENT_INVENTORY_COPY"; then
      printf 'The live runner control-plane identity does not match the checkpoint source.\n' >&2
      exit 1
    fi
  else
    recovery_require_checkpoint_generation_matches_live \
      "$RECOVERY_DEPLOYMENT_INVENTORY_COPY" "$VALUES_SOURCE_FILE"
  fi
  if [[ "${RESTORE_TARGET_MODE:-in-place}" != cold-rebind ]] &&
     ! recovery_require_live_runner_control_plane_matches_checkpoint \
       "$RECOVERY_DEPLOYMENT_INVENTORY_COPY"; then
    printf 'The live runner control-plane identity does not match the checkpoint inventory.\n' >&2
    exit 1
  fi
  if ! recovery_require_live_images_match_checkpoint \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY"; then
    printf 'The live workload image inventory does not exactly match the checkpoint.\n' >&2
    exit 1
  fi
  if [[ "${RESTORE_TARGET_MODE:-in-place}" != cold-rebind ]]; then
    require_durable_checkpoint_evidence_live active-source dormant
  fi
  if [[ "$RECOVERY_CHECKPOINT_RUNNER_GENERATION" == durable-v2 ]]; then
    recovery_require_restore_epoch_candidate \
      "$RECOVERY_DEPLOYMENT_INVENTORY_COPY" "$VALUES_SOURCE_FILE"
    recovery_require_restore_target_manifest_candidate \
      "$VALUES_SOURCE_FILE" restore-fence
  fi
fi

if [[ "$PREFLIGHT" == "1" ]]; then
  CHILD_PREFLIGHT_COORDINATED=0
  [[ "${RESTORE_TARGET_MODE:-in-place}" != cold-rebind ]] ||
    CHILD_PREFLIGHT_COORDINATED=1
  VALUES_FILE="$VALUES_SOURCE_FILE" \
    RESTORE_COORDINATED="$CHILD_PREFLIGHT_COORDINATED" RESTORE_PREFLIGHT=1 \
    "$SCRIPT_DIR/restore-retdb.sh" "$DUMP_PATH"
  VALUES_FILE="$VALUES_SOURCE_FILE" \
    RESTORE_COORDINATED="$CHILD_PREFLIGHT_COORDINATED" \
    RESTORE_STORAGE_PREFLIGHT=1 \
    "$SCRIPT_DIR/restore-ret-storage.sh" "$STORAGE_PATH"
  printf 'Coordinated checkpoint preflight passed without mutation: checkpoint=%s\n' "$stamp"
  exit 0
fi

if [[ "$COLD_REBIND" == "1" ]]; then
  run_cold_rebind_restore
  exit 0
fi

if [[ "$LEGACY_IN_PLACE" == "1" ]]; then
  run_legacy_in_place_restore
  exit 0
fi

if [[ "$PREPARE_FENCE" == "1" ]]; then
  recovery_require_restore_epoch_candidate \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY" "$VALUES_SOURCE_FILE"
  RECOVERY_FENCE_PRE_EPOCH="$(recovery_live_runner_epoch)"
  [[ -n "$RECOVERY_FENCE_PRE_EPOCH" ]] || RECOVERY_FENCE_PRE_EPOCH=legacy-absent
  RECOVERY_FENCE_TARGET_EPOCH="$(recovery_runner_epoch_from_values \
    "$VALUES_SOURCE_FILE")"
  RECOVERY_OPERATION_STATE=restore-fence-prepared
  require_restore_fence_confirmation CONFIRM_PREPARE_RESTORE_FENCE prepare-fence
  RESTORE_PHASE="locking"
  recovery_require_cluster_identity
  recovery_require_pvc_identity ret-pvc
  recovery_require_restore_target_binding
  recovery_require_durable_checkpoint_source_matches_live \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY"
  recovery_require_live_images_match_checkpoint \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY"
  require_durable_checkpoint_evidence_live active-source dormant
  acquire_restore_serialization
  recovery_require_cluster_identity
  recovery_require_pvc_identity ret-pvc
  recovery_require_restore_target_binding
  recovery_require_restore_epoch_candidate \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY" "$VALUES_SOURCE_FILE"
  recovery_require_restore_target_manifest_candidate \
    "$VALUES_SOURCE_FILE" restore-fence
  recovery_require_live_runner_control_plane_matches_checkpoint \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY"
  recovery_require_live_images_match_checkpoint \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY"
  require_durable_checkpoint_evidence_live active-source dormant
  acquire_restore_lock
  recovery_require_recovery_operation_fence_state dormant
  prepare_restore_fence
  require_owned_restore_lock
  require_checkpoint_runner_quiescent_now
  require_durable_checkpoint_evidence_live quiesced-source dormant
  recovery_require_recovery_operation_fence_state dormant
  require_inert_runner_role_exact
  # This is the last gate before handing the durable lock to the next process.
  # Re-read it after every quiescence/evidence check to reject disappearance or
  # ABA replacement during the final verification window.
  require_owned_restore_lock
  RESTORE_PHASE="fence-prepared"
  release_restore_serialization
  trap - ERR
  printf 'Restore fence prepared and locked: checkpoint=%s namespace=%s lock_uid=%s operation_id=%s\n' \
    "$stamp" "$NAMESPACE" "$RESTORE_LOCK_UID" "$RESTORE_OPERATION_ID"
  printf 'Apply the standard Cloud manifest with BOT_RUNNER_RECOVERY_PHASE=restore-fence and epoch=%s, then run execute-fenced with CONFIRM_EXECUTE_RESTORE_FENCE=%q\n' \
    "$RECOVERY_FENCE_TARGET_EPOCH" \
    "$(restore_fence_confirmation_value execute-fenced)"
  exit 0
fi

if [[ "$EXECUTE_FENCED" == "1" ]]; then
  acquire_restore_serialization
  load_restore_fence_lock restore-fence-prepared
  [[ "$(recovery_runner_epoch_from_values "$VALUES_SOURCE_FILE")" == \
     "$RECOVERY_FENCE_TARGET_EPOCH" ]] || {
    printf 'VALUES_FILE no longer contains the epoch bound to the prepared fence.\n' >&2
    exit 1
  }
  recovery_require_live_restore_fence_epoch \
    "$VALUES_SOURCE_FILE" "$RECOVERY_FENCE_PRE_EPOCH"
  recovery_require_restore_target_manifest_candidate \
    "$VALUES_SOURCE_FILE" restore-fence
  recovery_require_live_runner_recovery_phase restore-fence
  if ! recovery_require_recovery_operation_fence_state active; then
    printf 'The recovery operation admission fence is not active; regenerate and apply the standard Cloud restore-fence manifest before retrying execute-fenced.\n' >&2
    exit 1
  fi
  require_restore_fence_confirmation CONFIRM_EXECUTE_RESTORE_FENCE execute-fenced
  capture_inert_runner_role_for_failclose
  RESTORE_PHASE="fence-prepared"
  recovery_require_cluster_identity
  recovery_require_pvc_identity ret-pvc
  recovery_require_restore_target_binding
  require_owned_restore_lock
  if ! recovery_require_live_runner_control_plane_matches_checkpoint \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY"; then
    printf 'The live runner control plane drifted before fenced execution.\n' >&2
    exit 1
  fi
  recovery_require_live_images_match_checkpoint \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY"
  recovery_require_live_restore_fence_epoch \
    "$VALUES_SOURCE_FILE" "$RECOVERY_FENCE_PRE_EPOCH"
  capture_consumer_contracts_at_replicas 0 1
  for index in "${!CONSUMERS[@]}"; do
    recovery_wait_for_no_pods "app=${DEPLOYMENT_SELECTORS[$index]}" \
      "deployment/${CONSUMERS[$index]}" 180s
    recovery_require_consumer_contract_entry \
      "$RECOVERY_CONSUMER_CONTRACT_JSON" "${CONSUMERS[$index]}" 0 \
      "$RESTORE_OPERATION_ID"
  done
  reconcile_checkpoint_runner_quiescence
  recovery_require_exact_pvc_consumers ret-pvc
  RUNNER_DURABLE_FENCE_INVENTORY="$(
    recovery_capture_durable_quiescence
  )"
  recovery_durable_fence_inventory_json_is_canonical \
    "$RUNNER_DURABLE_FENCE_INVENTORY"
  require_restore_zero_boundary
  attest_restore_operation_fence_active
  require_durable_checkpoint_evidence_live quiesced-target active
  start_restore_writer_monitor
  require_restore_writer_monitor_healthy
  start_restore_durable_monitor
  require_restore_monitors_healthy
else
  if [[ "$FINALIZE_REACTIVATION" != "1" ]]; then
    printf 'A destructive restore requires RESTORE_CHECKPOINT_COLD_REBIND=1 for freeze-bundle-v1, RESTORE_CHECKPOINT_LEGACY_IN_PLACE=1 for a legacy checkpoint, or RESTORE_CHECKPOINT_PREPARE_FENCE=1 for durable-v2.\n' >&2
    exit 2
  fi
fi

if [[ "$FINALIZE_REACTIVATION" == "1" ]]; then
  acquire_restore_serialization
  load_restore_fence_lock restore-complete-awaiting-reactivation
  [[ "$(recovery_runner_epoch_from_values "$VALUES_SOURCE_FILE")" == \
     "$RECOVERY_FENCE_TARGET_EPOCH" ]] || {
    printf 'VALUES_FILE no longer contains the epoch bound to the completed restore.\n' >&2
    exit 1
  }
  recovery_require_live_restore_fence_epoch \
    "$VALUES_SOURCE_FILE" "$RECOVERY_FENCE_PRE_EPOCH"
  require_durable_checkpoint_evidence_live active-target dormant
  recovery_require_live_runner_recovery_phase active
  require_restore_fence_confirmation \
    CONFIRM_FINALIZE_RESTORE_REACTIVATION finalize-reactivation
  recovery_require_cluster_identity
  recovery_require_pvc_identity ret-pvc
  recovery_require_restore_target_binding
  require_owned_restore_lock
  if ! recovery_require_live_runner_control_plane_matches_checkpoint \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY"; then
    printf 'The live runner control plane drifted before finalization.\n' >&2
    exit 1
  fi
  recovery_require_live_images_match_checkpoint \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY"
  require_durable_checkpoint_evidence_live active-target dormant
  recovery_require_live_restore_fence_epoch \
    "$VALUES_SOURCE_FILE" "$RECOVERY_FENCE_PRE_EPOCH"
  # Missing/incorrect confirmation and every preceding read-only gate must be
  # incapable of reducing a live deployment. Only after they all pass do we
  # bind the fail-close contracts and enter the phase where a later drift
  # authorizes reductive mutation.
  capture_finalizer_failclose_contracts
  require_owned_restore_lock
  RESTORE_PHASE="finalizing-reactivation"
  for index in "${!CONSUMERS[@]}"; do
    recovery_require_consumer_contract_entry \
      "$RECOVERY_CONSUMER_CONTRACT_JSON" "${CONSUMERS[$index]}" 1 \
      "$RESTORE_OPERATION_ID"
    recovery_wait_for_deployment_rollout "${CONSUMERS[$index]}" 300
    require_owned_restore_lock
    recovery_require_deployment_contract "${CONSUMERS[$index]}" \
      "${DEPLOYMENT_UIDS[$index]}" 1 "${DEPLOYMENT_SELECTORS[$index]}" \
      "${DEPLOYMENT_FINGERPRINTS[$index]}"
  done
  require_owned_restore_lock
  run_restore_live_reactivation_verifier
  recovery_require_cluster_identity
  recovery_require_pvc_identity ret-pvc
  recovery_require_live_restore_fence_epoch \
    "$VALUES_SOURCE_FILE" "$RECOVERY_FENCE_PRE_EPOCH"
  recovery_require_live_runner_recovery_phase active
  recovery_require_live_images_match_checkpoint \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY"
  require_durable_checkpoint_evidence_live active-target dormant
  require_owned_restore_lock
  release_restore_lock
  RESTORE_PHASE="complete"
  release_restore_serialization
  trap - ERR
  printf 'Restore reactivation finalized and its exact lock released: checkpoint=%s namespace=%s\n' \
    "$stamp" "$NAMESPACE"
  exit 0
fi

DB_CONFIRMATION="$(recovery_confirmation_value retdb)"
STORAGE_CONFIRMATION="$(recovery_confirmation_value ret-pvc "$RECOVERY_PVC_UID")"

RESTORE_PHASE="db"
recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
require_owned_restore_lock
require_restore_monitors_healthy
require_durable_checkpoint_evidence_live quiesced-target active
recovery_require_operation_serialization
VALUES_FILE="$VALUES_SOURCE_FILE" \
RESTORE_COORDINATED=1 RESTORE_ALREADY_FENCED=1 CONFIRM_RESTORE="$DB_CONFIRMATION" \
YENHUBS_PARENT_DURABLE_MONITOR_BASELINE_PATH="$RUNNER_DURABLE_FENCE_BASELINE_PATH" \
YENHUBS_PARENT_DURABLE_MONITOR_BASELINE_SHA256="$RUNNER_DURABLE_FENCE_BASELINE_SHA256" \
YENHUBS_PARENT_RECOVERY_OPERATION_FENCE_ACTIVE_IDENTITY="$RESTORE_OPERATION_FENCE_ACTIVE_IDENTITY" \
YENHUBS_PARENT_LEASE_HOLDER="$RECOVERY_SERIALIZATION_LEASE_HOLDER" \
YENHUBS_PARENT_LEASE_UID="$RECOVERY_SERIALIZATION_LEASE_UID" \
YENHUBS_PARENT_PROCESS_PID="$RECOVERY_SERIALIZATION_PARENT_PID" \
YENHUBS_PARENT_PROCESS_START_IDENTITY="$RECOVERY_SERIALIZATION_PARENT_START_IDENTITY" \
YENHUBS_PARENT_WRITER_MONITOR_CONTRACT_PATH="$RESTORE_WRITER_MONITOR_CONTRACT" \
YENHUBS_PARENT_WRITER_MONITOR_CONTRACT_SHA256="$RESTORE_WRITER_MONITOR_CONTRACT_SHA256" \
YENHUBS_PARENT_WRITER_MONITOR_BASELINE_PATH="$RESTORE_WRITER_MONITOR_BASELINE" \
YENHUBS_PARENT_WRITER_MONITOR_BASELINE_SHA256="$RESTORE_WRITER_MONITOR_BASELINE_SHA256" \
YENHUBS_PARENT_WRITER_MONITOR_FAILURE_PATH="$RESTORE_WRITER_MONITOR_FAILURE" \
YENHUBS_PARENT_WRITER_MONITOR_READY_PATH="$RESTORE_WRITER_MONITOR_READY" \
YENHUBS_PARENT_WRITER_MONITOR_PROGRESS_PATH="$RESTORE_WRITER_MONITOR_PROGRESS" \
YENHUBS_PARENT_WRITER_MONITOR_AUTHORITY_SHA256="$RESTORE_WRITER_MONITOR_AUTHORITY_SHA256" \
YENHUBS_PARENT_WRITER_MONITOR_PID="$RESTORE_WRITER_MONITOR_PID" \
YENHUBS_PARENT_WRITER_MONITOR_START_IDENTITY="$RESTORE_WRITER_MONITOR_START_IDENTITY" \
YENHUBS_PARENT_DURABLE_MONITOR_FAILURE_PATH="$RESTORE_DURABLE_MONITOR_FAILURE" \
YENHUBS_PARENT_DURABLE_MONITOR_READY_PATH="$RESTORE_DURABLE_MONITOR_READY" \
YENHUBS_PARENT_DURABLE_MONITOR_PROGRESS_PATH="$RESTORE_DURABLE_MONITOR_PROGRESS" \
YENHUBS_PARENT_DURABLE_MONITOR_PID="$RESTORE_DURABLE_MONITOR_PID" \
YENHUBS_PARENT_DURABLE_MONITOR_START_IDENTITY="$RESTORE_DURABLE_MONITOR_START_IDENTITY" \
YENHUBS_PARENT_DURABLE_MONITOR_CAPABILITY_SHA256="$RESTORE_DURABLE_MONITOR_CAPABILITY_SHA256" \
YENHUBS_PARENT_DURABLE_MONITOR_AUTHORITY_SHA256="$RESTORE_DURABLE_MONITOR_AUTHORITY_SHA256" \
  "$SCRIPT_DIR/restore-retdb.sh" "$DUMP_PATH"
recovery_require_operation_serialization
require_restore_monitors_healthy
require_durable_checkpoint_evidence_live quiesced-target active

RESTORE_PHASE="storage"
recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
require_owned_restore_lock
recovery_require_operation_serialization
require_restore_monitors_healthy
require_durable_checkpoint_evidence_live quiesced-target active
VALUES_FILE="$VALUES_SOURCE_FILE" \
RESTORE_COORDINATED=1 CONFIRM_RESTORE_STORAGE="$STORAGE_CONFIRMATION" \
YENHUBS_PARENT_DURABLE_MONITOR_BASELINE_PATH="$RUNNER_DURABLE_FENCE_BASELINE_PATH" \
YENHUBS_PARENT_DURABLE_MONITOR_BASELINE_SHA256="$RUNNER_DURABLE_FENCE_BASELINE_SHA256" \
YENHUBS_PARENT_RECOVERY_OPERATION_FENCE_ACTIVE_IDENTITY="$RESTORE_OPERATION_FENCE_ACTIVE_IDENTITY" \
YENHUBS_PARENT_LEASE_HOLDER="$RECOVERY_SERIALIZATION_LEASE_HOLDER" \
YENHUBS_PARENT_LEASE_UID="$RECOVERY_SERIALIZATION_LEASE_UID" \
YENHUBS_PARENT_PROCESS_PID="$RECOVERY_SERIALIZATION_PARENT_PID" \
YENHUBS_PARENT_PROCESS_START_IDENTITY="$RECOVERY_SERIALIZATION_PARENT_START_IDENTITY" \
YENHUBS_PARENT_WRITER_MONITOR_CONTRACT_PATH="$RESTORE_WRITER_MONITOR_CONTRACT" \
YENHUBS_PARENT_WRITER_MONITOR_CONTRACT_SHA256="$RESTORE_WRITER_MONITOR_CONTRACT_SHA256" \
YENHUBS_PARENT_WRITER_MONITOR_BASELINE_PATH="$RESTORE_WRITER_MONITOR_BASELINE" \
YENHUBS_PARENT_WRITER_MONITOR_BASELINE_SHA256="$RESTORE_WRITER_MONITOR_BASELINE_SHA256" \
YENHUBS_PARENT_WRITER_MONITOR_FAILURE_PATH="$RESTORE_WRITER_MONITOR_FAILURE" \
YENHUBS_PARENT_WRITER_MONITOR_READY_PATH="$RESTORE_WRITER_MONITOR_READY" \
YENHUBS_PARENT_WRITER_MONITOR_PROGRESS_PATH="$RESTORE_WRITER_MONITOR_PROGRESS" \
YENHUBS_PARENT_WRITER_MONITOR_AUTHORITY_SHA256="$RESTORE_WRITER_MONITOR_AUTHORITY_SHA256" \
YENHUBS_PARENT_WRITER_MONITOR_PID="$RESTORE_WRITER_MONITOR_PID" \
YENHUBS_PARENT_WRITER_MONITOR_START_IDENTITY="$RESTORE_WRITER_MONITOR_START_IDENTITY" \
YENHUBS_PARENT_DURABLE_MONITOR_FAILURE_PATH="$RESTORE_DURABLE_MONITOR_FAILURE" \
YENHUBS_PARENT_DURABLE_MONITOR_READY_PATH="$RESTORE_DURABLE_MONITOR_READY" \
YENHUBS_PARENT_DURABLE_MONITOR_PROGRESS_PATH="$RESTORE_DURABLE_MONITOR_PROGRESS" \
YENHUBS_PARENT_DURABLE_MONITOR_PID="$RESTORE_DURABLE_MONITOR_PID" \
YENHUBS_PARENT_DURABLE_MONITOR_START_IDENTITY="$RESTORE_DURABLE_MONITOR_START_IDENTITY" \
YENHUBS_PARENT_DURABLE_MONITOR_CAPABILITY_SHA256="$RESTORE_DURABLE_MONITOR_CAPABILITY_SHA256" \
YENHUBS_PARENT_DURABLE_MONITOR_AUTHORITY_SHA256="$RESTORE_DURABLE_MONITOR_AUTHORITY_SHA256" \
  "$SCRIPT_DIR/restore-ret-storage.sh" "$STORAGE_PATH"
recovery_require_operation_serialization
require_restore_monitors_healthy
require_durable_checkpoint_evidence_live quiesced-target active

RESTORE_PHASE="validating-live"
recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
recovery_require_exact_pvc_consumers ret-pvc
require_owned_restore_lock
require_checkpoint_runner_quiescent_now
require_restore_monitors_healthy
require_durable_checkpoint_evidence_live quiesced-target active
for index in "${!CONSUMERS[@]}"; do
  deployment="${CONSUMERS[$index]}"
  if ! recovery_require_consumer_contract_entry \
    "$RECOVERY_CONSUMER_CONTRACT_JSON" "$deployment" 0 "$RESTORE_OPERATION_ID"; then
    printf 'A DB consumer resumed before joint validation: %s.\n' "$deployment" >&2
    exit 1
  fi
done
PGSQL_PODS_JSON="$(recovery_kubectl get pod -n "$NAMESPACE" -l app=pgsql -o json)"
if ! PGSQL_POD_INFO="$(recovery_exact_ready_deployment_pod_info \
  "$PGSQL_PODS_JSON" pgsql pgsql)"; then
  printf 'Exactly one owned Ready PostgreSQL pod is required during joint validation.\n' >&2
  exit 1
fi
IFS=$'\t' read -r PGSQL_POD PGSQL_POD_UID PGSQL_DEPLOYMENT_UID <<<"$PGSQL_POD_INFO"
PGSQL_POD_JSON="$(jq -cer '.items[0]' <<<"$PGSQL_PODS_JSON")"
require_pgsql_source() {
  recovery_require_pod_identity "$PGSQL_POD" "$PGSQL_POD_UID" &&
    recovery_require_pod_deployment_ownership \
      "$PGSQL_POD_JSON" pgsql "$PGSQL_DEPLOYMENT_UID"
}
LIVE_CONTRACT="$(mktemp "${TMPDIR:-/tmp}/yenhubs-coordinated-live-contract.XXXXXX")"
chmod 600 "$LIVE_CONTRACT"
require_owned_restore_lock
require_pgsql_source
recovery_capture_live_database_contract "$PGSQL_POD" "$LIVE_CONTRACT"
require_owned_restore_lock
require_pgsql_source
recovery_database_contracts_match "$RECOVERY_DATABASE_CONTRACT_COPY" "$LIVE_CONTRACT" || {
  printf 'Live DB contract drifted before coordinated resume.\n' >&2
  exit 1
}

RESTORE_PHASE="completing-fenced"
recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
require_owned_restore_lock
require_checkpoint_runner_quiescent_now
require_restore_monitors_healthy
require_durable_checkpoint_evidence_live quiesced-target active
for index in "${!CONSUMERS[@]}"; do
  recovery_require_consumer_contract_entry \
    "$RECOVERY_CONSUMER_CONTRACT_JSON" "${CONSUMERS[$index]}" 0 \
    "$RESTORE_OPERATION_ID"
done
stop_restore_durable_monitor_before_writer
stop_restore_writer_monitor_after_restore
require_restore_zero_boundary
recovery_require_recovery_operation_fence_state active \
  "$RESTORE_OPERATION_FENCE_ACTIVE_IDENTITY"
require_durable_checkpoint_evidence_live quiesced-target active
RESTORE_OPERATION_FENCE_PRE_TRANSITION_ACTIVE_IDENTITY="$RESTORE_OPERATION_FENCE_ACTIVE_IDENTITY"
transition_restore_lock_state restore-fence-prepared \
  restore-complete-awaiting-reactivation
attest_restore_operation_fence_active \
  "$RESTORE_OPERATION_FENCE_PRE_TRANSITION_ACTIVE_IDENTITY"
RESTORE_OPERATION_FENCE_PRE_TRANSITION_ACTIVE_IDENTITY=""
require_durable_checkpoint_evidence_live quiesced-target active
RESTORE_PHASE="awaiting-reactivation"
release_restore_serialization
trap - ERR
printf 'Coordinated checkpoint restore completed and remains fenced: checkpoint=%s namespace=%s pvc_uid=%s lock_uid=%s\n' \
  "$stamp" "$NAMESPACE" "$RECOVERY_PVC_UID" "$RESTORE_LOCK_UID"
printf 'Apply the standard Cloud manifest with BOT_RUNNER_RECOVERY_PHASE=active and epoch=%s, run the live gate, then finalize with CONFIRM_FINALIZE_RESTORE_REACTIVATION=%q\n' \
  "$RECOVERY_FENCE_TARGET_EPOCH" \
  "$(restore_fence_confirmation_value finalize-reactivation)"

#!/usr/bin/env bash

# Create one locally generated point-in-time checkpoint. The five application
# writers are held at zero under a global immutable operation lock while both
# PostgreSQL and ret-pvc are captured. Publication uses an exclusive final
# directory claim plus an incomplete marker removed only after full rehashing.

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VALUES_INPUT_FILE="${VALUES_FILE:-$SCRIPT_DIR/input-values.local.yaml}"
MANIFEST_INPUT_FILE="${HCCE_MANIFEST_PATH:-$ROOT_DIR/hubs-cloud/community-edition/hcce.yaml}"
CUTOVER_KEY_INPUT_FILE="${PROCESS_LOCAL_CUTOVER_KEY_PATH:-}"
VALUES_SOURCE_FILE=""
CHECKPOINT_FORMAT="${CHECKPOINT_FORMAT:-legacy}"
TIMESTAMP="$(date '+%Y%m%d-%H%M%S')"
FINAL_OUTPUT_DIR="${1:-$ROOT_DIR/output/checkpoints/$TIMESTAMP}"
OUTPUT_PARENT="$(dirname "$FINAL_OUTPUT_DIR")"
NAMESPACE="${NAMESPACE:-hcce}"
ALLOW_DOWNTIME="${ALLOW_CHECKPOINT_DOWNTIME:-0}"
OUTPUT_DIR=""
OUTPUT_DIR_PRIVATE_TOKEN=""
OUTPUT_DIR_CLEANUP_ATTEMPTED=0
OUTPUT_DIR_RETIRED=0
OUTPUT_DIR_SETUP_FAILED=0
CHECKPOINT_STAGING_MARKER=""
CHECKPOINT_STAGING_OWNED=0
FINAL_OUTPUT_DIR_PRIVATE_TOKEN=""
FINAL_OUTPUT_DIR_CLEANUP_ATTEMPTED=0
FINAL_OUTPUT_DIR_RETIRED=0
FINAL_OUTPUT_DIR_SETUP_FAILED=0
FINAL_CLAIM_OWNED=0
FINAL_CLAIM_INITIALIZING=0
FINAL_PUBLICATION_COMMITTED=0
FINAL_INCOMPLETE_MARKER=""
# shellcheck source=deployment/lib/recovery-safety.sh
source "$SCRIPT_DIR/lib/recovery-safety.sh"

case "$CHECKPOINT_FORMAT" in
  legacy | freeze-bundle-v1) ;;
  *)
    printf 'CHECKPOINT_FORMAT must be legacy or freeze-bundle-v1.\n' >&2
    exit 2
    ;;
esac

checkpoint_artifacts() {
  if [[ "$CHECKPOINT_FORMAT" == freeze-bundle-v1 ]]; then
    recovery_freeze_bundle_artifacts "$TIMESTAMP"
  else
    recovery_checkpoint_artifacts "$TIMESTAMP" 3
  fi
}

checkpoint_validate_manifest() {
  local directory="$1"
  if [[ "$CHECKPOINT_FORMAT" == freeze-bundle-v1 ]]; then
    recovery_validate_freeze_bundle_manifest "$directory" "$TIMESTAMP"
  else
    recovery_validate_sha256_manifest "$directory" "$TIMESTAMP" 3
  fi
}

[[ "$ALLOW_DOWNTIME" == 1 ]] || {
  printf 'Checkpoint creation causes a coordinated workload pause; set ALLOW_CHECKPOINT_DOWNTIME=1.\n' >&2
  exit 2
}
[[ ! -e "$FINAL_OUTPUT_DIR" && ! -L "$FINAL_OUTPUT_DIR" ]] || {
  printf 'Refusing same-second or existing checkpoint directory: %s\n' "$FINAL_OUTPUT_DIR" >&2
  exit 1
}
if recovery_path_has_symlink_component "$OUTPUT_PARENT"; then
  printf 'Checkpoint parent may not contain symlink components.\n' >&2
  exit 1
fi
mkdir -p "$OUTPUT_PARENT"
if recovery_path_has_symlink_component "$OUTPUT_PARENT"; then
  printf 'Checkpoint parent changed to a linked path while it was created.\n' >&2
  exit 1
fi
OUTPUT_PARENT="$(cd "$OUTPUT_PARENT" && pwd -P)"
FINAL_OUTPUT_DIR="$OUTPUT_PARENT/$(basename "$FINAL_OUTPUT_DIR")"
PUBLISH_LOCK="${FINAL_OUTPUT_DIR}.yenhubs-publish-lock"

CONSUMERS=(reticulum pgbouncer pgbouncer-t bot-orchestrator coturn)
DEPLOYMENT_UIDS=()
DEPLOYMENT_RESOURCE_VERSIONS=()
ORIGINAL_REPLICAS=()
DEPLOYMENT_SELECTORS=()
DEPLOYMENT_FINGERPRINTS=()
DEPLOYMENT_RESUME_STARTED=(0 0 0 0 0)
DEPLOYMENT_RESUME_RECEIPT_CLEARED=(0 0 0 0 0)
BOT_PARENT_RESUME_ALREADY_COMMITTED=0
RECOVERY_CONSUMER_CONTRACT_JSON=""
PUBLISH_LOCK_OWNED=0
OPERATION_LOCK_OWNED=0
SERIALIZATION_LEASE_OWNED=0
WRITERS_MUTATED=0
RUNNER_MONITOR_STOP=""
RUNNER_MONITOR_FAILURE=""
RUNNER_MONITOR_READY=""
RUNNER_MONITOR_PID=""
RUNNER_MONITOR_START_IDENTITY=""
RUNNER_DURABLE_FENCE_INVENTORY=""
RUNNER_DURABLE_FENCE_BASELINE_PATH=""
RUNNER_DURABLE_FENCE_BASELINE_SHA256=""
CHECKPOINT_OPERATION_FENCE_ACTIVE_IDENTITY=""
CHECKPOINT_OPERATION_FENCE_DORMANT_IDENTITY=""
CHECKPOINT_DURABLE_MONITOR_DIR=""
CHECKPOINT_DURABLE_MONITOR_STOP=""
CHECKPOINT_DURABLE_MONITOR_FAILURE=""
CHECKPOINT_DURABLE_MONITOR_READY=""
CHECKPOINT_DURABLE_MONITOR_PROGRESS=""
CHECKPOINT_DURABLE_MONITOR_FINAL=""
CHECKPOINT_DURABLE_MONITOR_PID=""
CHECKPOINT_DURABLE_MONITOR_START_IDENTITY=""
CHECKPOINT_DURABLE_MONITOR_CAPABILITY_SHA256=""
CHECKPOINT_DURABLE_MONITOR_AUTHORITY_SHA256=""
CHECKPOINT_DURABLE_MONITOR_STARTED=0
CHECKPOINT_DURABLE_MONITOR_JOINED=0
CHECKPOINT_DURABLE_MONITOR_VERIFIED_STOPPED=0
CHECKPOINT_WRITER_MONITOR_DIR=""
CHECKPOINT_WRITER_MONITOR_CONTRACT=""
CHECKPOINT_WRITER_MONITOR_CONTRACT_SHA256=""
CHECKPOINT_WRITER_MONITOR_BASELINE=""
CHECKPOINT_WRITER_MONITOR_BASELINE_SHA256=""
CHECKPOINT_WRITER_MONITOR_STOP=""
CHECKPOINT_WRITER_MONITOR_FAILURE=""
CHECKPOINT_WRITER_MONITOR_READY=""
CHECKPOINT_WRITER_MONITOR_PROGRESS=""
CHECKPOINT_WRITER_MONITOR_FINAL=""
CHECKPOINT_WRITER_MONITOR_PID=""
CHECKPOINT_WRITER_MONITOR_START_IDENTITY=""
CHECKPOINT_WRITER_MONITOR_AUTHORITY_SHA256=""
CHECKPOINT_WRITER_MONITOR_STARTED=0
CHECKPOINT_WRITER_MONITOR_JOINED=0
CHECKPOINT_WRITER_MONITOR_VERIFIED_STOPPED=0
CHECKPOINT_FREEZE_FENCE_ACTIVE=0
CHECKPOINT_FREEZE_FENCE_CLEANUP_FAILED=0
CHECKPOINT_FREEZE_FENCE_HELPER_IMAGE=""
CHECKPOINT_RUNNER_MODE=""
CHECKPOINT_RUNNER_GENERATION=""
CHECKPOINT_PROCESS_LOCAL_STRATEGY_SCOPE=strict-recreate
CHECKPOINT_PROCESS_LOCAL_ROLLING=0
CHECKPOINT_PROCESS_LOCAL_PARENT_PRELOCK_CONTRACT=""
CHECKPOINT_PROCESS_LOCAL_ROLLING_PARENT_CONTRACT=""
CHECKPOINT_PROCESS_LOCAL_ROLLING_PRELOCK_CONTRACT=""
FREEZE_SOURCE_CLUSTER_UID=""
CHECKPOINT_VALUES_SNAPSHOT=""
CHECKPOINT_MANIFEST_SNAPSHOT=""
CHECKPOINT_CUTOVER_KEY_SNAPSHOT=""
CHECKPOINT_PENDING_SIGNAL_STATUS=0
CHECKPOINT_INTERRUPT_IN_PROGRESS=0
CHECKPOINT_FAILURE_STAGE=pre-publication
CHECKPOINT_FAILURE_CODE=unclassified
CHECKPOINT_TIMING_TOTAL_STARTED_SECONDS=$SECONDS
CHECKPOINT_TIMING_STAGE_STARTED_SECONDS=$SECONDS
CHECKPOINT_TIMING_STAGE=pre-publication
CHECKPOINT_TIMING_REPORTED=0

checkpoint_timing_transition() {
  local next_stage="$1" now="$SECONDS"
  [[ -n "$next_stage" ]] || return 2
  if [[ "$next_stage" != "$CHECKPOINT_TIMING_STAGE" ]]; then
    printf 'YENHUBS_TIMING operation=checkpoint stage=%s stage_seconds=%s total_seconds=%s result=complete\n' \
      "$CHECKPOINT_TIMING_STAGE" \
      "$((now - CHECKPOINT_TIMING_STAGE_STARTED_SECONDS))" \
      "$((now - CHECKPOINT_TIMING_TOTAL_STARTED_SECONDS))" >&2
    CHECKPOINT_TIMING_STAGE="$next_stage"
    CHECKPOINT_TIMING_STAGE_STARTED_SECONDS="$now"
  fi
}

checkpoint_report_timing() {
  local result="$1" now="$SECONDS"
  [[ "$CHECKPOINT_TIMING_REPORTED" == 0 ]] || return 0
  printf 'YENHUBS_TIMING operation=checkpoint stage=%s stage_seconds=%s total_seconds=%s result=%s\n' \
    "$CHECKPOINT_TIMING_STAGE" \
    "$((now - CHECKPOINT_TIMING_STAGE_STARTED_SECONDS))" \
    "$((now - CHECKPOINT_TIMING_TOTAL_STARTED_SECONDS))" "$result" >&2
  CHECKPOINT_TIMING_REPORTED=1
}

checkpoint_failure_context_is_safe() {
  local stage="$1" code="$2"
  case "$stage:$code" in
    pre-publication:unclassified|\
    content-validation:validate|\
    checksum-manifest:precondition|checksum-manifest:build|\
    checksum-manifest:commit|checksum-manifest:permissions|\
    quiescence:fence-create|quiescence:fence-probe|\
    quiescence:writers|quiescence:serialization|quiescence:monitor-health|\
    quiescence:evidence-capture|quiescence:evidence-contract|\
    quiescence:evidence-metadata|quiescence:evidence-live|\
    database-backup:stream|database-backup:serialization|\
    database-backup:monitor-health|\
    storage-backup:stream|storage-backup:serialization|\
    storage-backup:monitor-health|storage-backup:runner-handoff|\
    storage-backup:cutover-evidence|storage-backup:metadata|\
    staging-verification:layout|staging-verification:writer-monitor|\
    staging-verification:durable-monitor|\
    final-claim:claim|artifact-transfer:move|\
    claimed-verification:checksum|claimed-verification:layout|\
    terminal-boundary:runner-handoff|terminal-boundary:cutover-evidence|\
    terminal-boundary:writer-monitor|terminal-boundary:durable-monitor|\
    terminal-boundary:durable-stop|terminal-boundary:writer-stop|\
    precommit:serialization|precommit:operation-lock|\
    precommit:checksum|precommit:layout|\
    publication:commit-marker|publication:staging-cleanup|\
    resume:preflight|resume:adopt-parent|resume:monitor-prepare|\
    resume:fence-deactivation|resume:fence-continuity|resume:freeze-fence-delete|\
    resume:writer-precheck|resume:writer-contract|resume:writer-cas|\
    resume:writer-rollout|resume:receipt|resume:operation-lock|\
    lock-release:fence-continuity|lock-release:operation-lock|\
    serialization-release:lease|local-cleanup:artifacts)
      return 0
      ;;
    *) return 1 ;;
  esac
}

checkpoint_uses_freeze_admission_fence() {
  [[ "$CHECKPOINT_FORMAT" == freeze-bundle-v1 &&
     "$CHECKPOINT_RUNNER_MODE" == process-local ]]
}

require_checkpoint_freeze_fence_zero_boundary() {
  local deployment
  checkpoint_uses_freeze_admission_fence || return 2
  [[ "$CHECKPOINT_FREEZE_FENCE_ACTIVE" == 1 &&
     -n "$RECOVERY_FREEZE_CHECKPOINT_FENCE_CAPABILITY" ]] || return 1
  recovery_require_freeze_checkpoint_fence \
    "$RECOVERY_FREEZE_CHECKPOINT_FENCE_CAPABILITY" || return 1
  for deployment in "${CONSUMERS[@]}"; do
    recovery_require_consumer_contract_entry \
      "$RECOVERY_CONSUMER_CONTRACT_JSON" "$deployment" 0 || return 1
  done
  recovery_require_operation_serialization && recovery_require_operation_lock
}

establish_checkpoint_freeze_fence() {
  local acquisition_status=0
  checkpoint_uses_freeze_admission_fence || return 2
  [[ "$CHECKPOINT_FREEZE_FENCE_ACTIVE" == 0 ]] || return 2
  if CHECKPOINT_FREEZE_FENCE_HELPER_IMAGE="$(recovery_checkpoint_image_for_pair \
      "$OUTPUT_DIR/deployment-images.json" reticulum/reticulum \
      ghcr.io/yengalvez/reticulum)"; then
    :
  else
    CHECKPOINT_FREEZE_FENCE_HELPER_IMAGE="$(recovery_checkpoint_image_for_pair \
      "$OUTPUT_DIR/deployment-images.json" reticulum/reticulum \
      docker.io/mozillareality/postgrest)" || return 1
  fi
  CHECKPOINT_PENDING_SIGNAL_STATUS=0
  trap 'checkpoint_record_pending_signal 130' INT
  trap 'checkpoint_record_pending_signal 143' TERM
  if recovery_create_freeze_checkpoint_fence \
      "$CHECKPOINT_FREEZE_FENCE_HELPER_IMAGE"; then
    CHECKPOINT_FREEZE_FENCE_ACTIVE=1
    recovery_probe_freeze_checkpoint_fence \
      "$RECOVERY_FREEZE_CHECKPOINT_FENCE_CAPABILITY" || acquisition_status=1
  else
    acquisition_status=1
    printf 'Checkpoint admission fence setup stopped at %s.\n' \
      "${RECOVERY_FREEZE_CHECKPOINT_FENCE_FAILURE_STAGE:-unknown}" >&2
  fi
  finish_checkpoint_local_capability_boundary "$acquisition_status"
}

remove_checkpoint_freeze_fence_before_resume() {
  local index deployment contract uid resource_version replicas selector fingerprint
  checkpoint_uses_freeze_admission_fence || return 2
  require_checkpoint_freeze_fence_zero_boundary || return 1
  for index in "${!CONSUMERS[@]}"; do
    deployment="${CONSUMERS[$index]}"
    contract="$(recovery_capture_deployment_contract "$deployment")" || return 1
    IFS=$'\t' read -r uid resource_version replicas selector fingerprint <<<"$contract"
    [[ "$uid" == "${DEPLOYMENT_UIDS[$index]}" && "$replicas" == 0 &&
       "$selector" == "${DEPLOYMENT_SELECTORS[$index]}" &&
       "$fingerprint" == "${DEPLOYMENT_FINGERPRINTS[$index]}" ]] || return 1
    DEPLOYMENT_RESOURCE_VERSIONS[index]="$resource_version"
  done
  CHECKPOINT_PENDING_SIGNAL_STATUS=0
  if [[ "$CHECKPOINT_INTERRUPT_IN_PROGRESS" == 1 ]]; then
    trap '' INT TERM
  else
    trap 'checkpoint_record_pending_signal 130' INT
    trap 'checkpoint_record_pending_signal 143' TERM
  fi
  recovery_delete_freeze_checkpoint_fence \
    "$RECOVERY_FREEZE_CHECKPOINT_FENCE_CAPABILITY" || {
      CHECKPOINT_FREEZE_FENCE_CLEANUP_FAILED=1
      restore_checkpoint_signal_traps
      return 1
    }
  CHECKPOINT_FREEZE_FENCE_ACTIVE=0
  CHECKPOINT_WRITER_MONITOR_VERIFIED_STOPPED=1
  finish_checkpoint_local_capability_boundary 0
}

checkpoint_set_failure_context() {
  local stage="$1" code="$2"
  checkpoint_failure_context_is_safe "$stage" "$code" || return 2
  checkpoint_timing_transition "$stage"
  CHECKPOINT_FAILURE_STAGE="$stage"
  CHECKPOINT_FAILURE_CODE="$code"
}

checkpoint_record_pending_signal() {
  local status="$1"
  [[ "$status" == 130 || "$status" == 143 ]] || return 2
  if [[ "$CHECKPOINT_PENDING_SIGNAL_STATUS" == 0 ]]; then
    CHECKPOINT_PENDING_SIGNAL_STATUS="$status"
    # Preserve the first cooperative interruption and suppress repeats until
    # the current capability boundary has been made internally consistent.
    trap '' INT TERM
  fi
}

restore_checkpoint_signal_traps() {
  if [[ "$CHECKPOINT_INTERRUPT_IN_PROGRESS" == 1 ]]; then
    trap '' INT TERM
  else
    trap 'checkpoint_interrupted 130' INT
    trap 'checkpoint_interrupted 143' TERM
  fi
}

finish_checkpoint_local_capability_boundary() {
  local acquisition_status="$1" pending_signal_status
  restore_checkpoint_signal_traps
  pending_signal_status="$CHECKPOINT_PENDING_SIGNAL_STATUS"
  CHECKPOINT_PENDING_SIGNAL_STATUS=0
  if [[ "$pending_signal_status" != 0 &&
        "$CHECKPOINT_INTERRUPT_IN_PROGRESS" == 0 ]]; then
    checkpoint_interrupted "$pending_signal_status"
  fi
  [[ "$acquisition_status" == 0 ]]
}

claim_final_output_directory() {
  local status=0
  # Record cooperative interruption while the child ignores it across the
  # otherwise unrepresentable mkdir-to-capability gap. Honor the first signal
  # only after token, marker and ownership state are internally consistent.
  CHECKPOINT_PENDING_SIGNAL_STATUS=0
  trap 'checkpoint_record_pending_signal 130' INT
  trap 'checkpoint_record_pending_signal 143' TERM
  if (trap '' INT TERM; mkdir "$FINAL_OUTPUT_DIR"); then
    FINAL_CLAIM_OWNED=1
    FINAL_CLAIM_INITIALIZING=1
    FINAL_OUTPUT_DIR_SETUP_FAILED=1
    FINAL_INCOMPLETE_MARKER="$FINAL_OUTPUT_DIR/.yenhubs-incomplete"
    if ! FINAL_OUTPUT_DIR_PRIVATE_TOKEN="$(
        trap '' INT TERM
        recovery_capture_private_directory_token "$FINAL_OUTPUT_DIR"
      )" ||
       ! (trap '' INT TERM; umask 077; set -C; printf 'yenhubs-incomplete:%s\n' \
         "$RECOVERY_OPERATION_ID" >"$FINAL_INCOMPLETE_MARKER") 2>/dev/null; then
      status=1
    fi
    if [[ "$status" == 0 ]]; then
      FINAL_OUTPUT_DIR_CLEANUP_ATTEMPTED=0
      FINAL_OUTPUT_DIR_RETIRED=0
      FINAL_OUTPUT_DIR_SETUP_FAILED=0
      FINAL_CLAIM_INITIALIZING=0
    fi
  else
    status=1
  fi
  finish_checkpoint_local_capability_boundary "$status"
}

commit_final_output_directory() {
  local status=0
  [[ "$FINAL_CLAIM_OWNED" == 1 && "$FINAL_PUBLICATION_COMMITTED" == 0 &&
     "$FINAL_INCOMPLETE_MARKER" == "$FINAL_OUTPUT_DIR/.yenhubs-incomplete" ]] || return 2
  # Marker deletion is the local publication linearization point. Cooperative
  # interruption is recorded while the rm child ignores it, then honored only
  # after ownership flags reflect committed state.
  CHECKPOINT_PENDING_SIGNAL_STATUS=0
  trap 'checkpoint_record_pending_signal 130' INT
  trap 'checkpoint_record_pending_signal 143' TERM
  if (trap '' INT TERM; rm -- "$FINAL_INCOMPLETE_MARKER"); then
    FINAL_INCOMPLETE_MARKER=""
    FINAL_PUBLICATION_COMMITTED=1
    FINAL_CLAIM_OWNED=0
    FINAL_CLAIM_INITIALIZING=0
    FINAL_OUTPUT_DIR_PRIVATE_TOKEN=""
    FINAL_OUTPUT_DIR_RETIRED=1
    FINAL_OUTPUT_DIR_SETUP_FAILED=0
  else
    status=1
  fi
  finish_checkpoint_local_capability_boundary "$status"
}

cleanup_checkpoint_writer_monitor() {
  local monitor_dir_basename=""
  if [[ "$CHECKPOINT_WRITER_MONITOR_JOINED" == 0 &&
        "$CHECKPOINT_WRITER_MONITOR_PID" =~ ^[1-9][0-9]*$ ]]; then
    recovery_discard_checkpoint_writer_monitor \
      "$CHECKPOINT_WRITER_MONITOR_STOP" "$CHECKPOINT_WRITER_MONITOR_PID" \
      "$CHECKPOINT_WRITER_MONITOR_START_IDENTITY"
  fi
  CHECKPOINT_WRITER_MONITOR_PID=""
  CHECKPOINT_WRITER_MONITOR_START_IDENTITY=""
  if [[ -n "$CHECKPOINT_WRITER_MONITOR_DIR" &&
        -d "$CHECKPOINT_WRITER_MONITOR_DIR" &&
        ! -L "$CHECKPOINT_WRITER_MONITOR_DIR" ]]; then
    monitor_dir_basename="$(basename "$CHECKPOINT_WRITER_MONITOR_DIR")"
    if [[ "$monitor_dir_basename" =~ ^yenhubs-checkpoint-writer-monitor\.[A-Za-z0-9]{6}$ ]]; then
      rm -f -- \
        "$CHECKPOINT_WRITER_MONITOR_CONTRACT" \
        "$CHECKPOINT_WRITER_MONITOR_BASELINE" \
        "$CHECKPOINT_WRITER_MONITOR_STOP" \
        "$CHECKPOINT_WRITER_MONITOR_FAILURE" \
        "$CHECKPOINT_WRITER_MONITOR_READY" \
        "${CHECKPOINT_WRITER_MONITOR_READY}.authority.json" \
        "$CHECKPOINT_WRITER_MONITOR_FINAL"
      if [[ -n "$CHECKPOINT_WRITER_MONITOR_PROGRESS" ]]; then
        rm -f -- "$CHECKPOINT_WRITER_MONITOR_PROGRESS" \
          "${CHECKPOINT_WRITER_MONITOR_PROGRESS}.next"
      fi
      rmdir "$CHECKPOINT_WRITER_MONITOR_DIR" 2>/dev/null || :
    fi
  fi
  CHECKPOINT_WRITER_MONITOR_DIR=""
  CHECKPOINT_WRITER_MONITOR_CONTRACT=""
  CHECKPOINT_WRITER_MONITOR_CONTRACT_SHA256=""
  CHECKPOINT_WRITER_MONITOR_BASELINE=""
  CHECKPOINT_WRITER_MONITOR_BASELINE_SHA256=""
  CHECKPOINT_WRITER_MONITOR_STOP=""
  CHECKPOINT_WRITER_MONITOR_FAILURE=""
  CHECKPOINT_WRITER_MONITOR_READY=""
  CHECKPOINT_WRITER_MONITOR_PROGRESS=""
  CHECKPOINT_WRITER_MONITOR_FINAL=""
  CHECKPOINT_WRITER_MONITOR_AUTHORITY_SHA256=""
  CHECKPOINT_WRITER_MONITOR_STARTED=0
  CHECKPOINT_WRITER_MONITOR_JOINED=0
  CHECKPOINT_WRITER_MONITOR_VERIFIED_STOPPED=0
}

start_checkpoint_writer_monitor() {
  local tmp_root start_status=0 pending_signal_status=0
  [[ "$CHECKPOINT_WRITER_MONITOR_STARTED" == 0 &&
     "$CHECKPOINT_WRITER_MONITOR_JOINED" == 0 &&
     "$CHECKPOINT_WRITER_MONITOR_VERIFIED_STOPPED" == 0 &&
     -z "$CHECKPOINT_WRITER_MONITOR_PID" &&
     -z "$CHECKPOINT_WRITER_MONITOR_START_IDENTITY" ]] || return 2
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  recovery_consumer_contract_is_acceptable \
    "$RECOVERY_CONSUMER_CONTRACT_JSON" || return 1
  tmp_root="$(recovery_canonical_private_tmp_root)" || return 1
  CHECKPOINT_WRITER_MONITOR_DIR="$(mktemp -d \
    "$tmp_root/yenhubs-checkpoint-writer-monitor.XXXXXX")" || return 1
  chmod 700 "$CHECKPOINT_WRITER_MONITOR_DIR" || {
    rmdir "$CHECKPOINT_WRITER_MONITOR_DIR" 2>/dev/null || :
    CHECKPOINT_WRITER_MONITOR_DIR=""
    return 1
  }
  CHECKPOINT_WRITER_MONITOR_CONTRACT="$CHECKPOINT_WRITER_MONITOR_DIR/consumer-contract.json"
  CHECKPOINT_WRITER_MONITOR_BASELINE="$CHECKPOINT_WRITER_MONITOR_DIR/baseline.json"
  CHECKPOINT_WRITER_MONITOR_STOP="$CHECKPOINT_WRITER_MONITOR_DIR/stop"
  CHECKPOINT_WRITER_MONITOR_FAILURE="$CHECKPOINT_WRITER_MONITOR_DIR/failure"
  CHECKPOINT_WRITER_MONITOR_READY="$CHECKPOINT_WRITER_MONITOR_DIR/ready"
  CHECKPOINT_WRITER_MONITOR_PROGRESS="$CHECKPOINT_WRITER_MONITOR_DIR/progress"
  CHECKPOINT_WRITER_MONITOR_FINAL="$CHECKPOINT_WRITER_MONITOR_DIR/final"
  if ! {
    printf '%s\n' "$RECOVERY_CONSUMER_CONTRACT_JSON" \
      >"$CHECKPOINT_WRITER_MONITOR_CONTRACT" &&
    : >"$CHECKPOINT_WRITER_MONITOR_BASELINE" &&
    : >"$CHECKPOINT_WRITER_MONITOR_STOP" &&
    : >"$CHECKPOINT_WRITER_MONITOR_FAILURE" &&
    : >"$CHECKPOINT_WRITER_MONITOR_READY" &&
    : >"$CHECKPOINT_WRITER_MONITOR_PROGRESS" &&
    : >"$CHECKPOINT_WRITER_MONITOR_FINAL" &&
    chmod 600 \
      "$CHECKPOINT_WRITER_MONITOR_CONTRACT" \
      "$CHECKPOINT_WRITER_MONITOR_BASELINE" \
      "$CHECKPOINT_WRITER_MONITOR_STOP" \
      "$CHECKPOINT_WRITER_MONITOR_FAILURE" \
      "$CHECKPOINT_WRITER_MONITOR_READY" \
      "$CHECKPOINT_WRITER_MONITOR_PROGRESS" \
      "$CHECKPOINT_WRITER_MONITOR_FINAL";
  }; then
    cleanup_checkpoint_writer_monitor
    return 1
  fi
  CHECKPOINT_WRITER_MONITOR_CONTRACT_SHA256="$(recovery_sha256_digest \
    "$CHECKPOINT_WRITER_MONITOR_CONTRACT")" || {
    cleanup_checkpoint_writer_monitor
    return 1
  }
  # Defer cooperative interruption across the isolated spawn and its immediate
  # PID assignment. The monitor must be either globally reachable for rollback
  # or fully revoked before a signal handler can resume writers.
  CHECKPOINT_PENDING_SIGNAL_STATUS=0
  if [[ "$CHECKPOINT_INTERRUPT_IN_PROGRESS" == 1 ]]; then
    trap '' INT TERM
  else
    trap 'checkpoint_record_pending_signal 130' INT
    trap 'checkpoint_record_pending_signal 143' TERM
  fi
  if ! recovery_start_checkpoint_writer_monitor \
      "$CHECKPOINT_WRITER_MONITOR_CONTRACT" \
      "$CHECKPOINT_WRITER_MONITOR_CONTRACT_SHA256" \
      "$CHECKPOINT_WRITER_MONITOR_BASELINE" \
      "$CHECKPOINT_WRITER_MONITOR_STOP" \
      "$CHECKPOINT_WRITER_MONITOR_FAILURE" \
      "$CHECKPOINT_WRITER_MONITOR_READY" \
      "$CHECKPOINT_WRITER_MONITOR_PROGRESS" \
      "$CHECKPOINT_WRITER_MONITOR_FINAL" \
      CHECKPOINT_WRITER_MONITOR_PID \
      CHECKPOINT_WRITER_MONITOR_START_IDENTITY \
      CHECKPOINT_WRITER_MONITOR_BASELINE_SHA256 \
      "$CHECKPOINT_RUNNER_GENERATION" \
      "$RECOVERY_OPERATION_OWNER"; then
    start_status=1
  else
    if CHECKPOINT_WRITER_MONITOR_AUTHORITY_SHA256="$(
      recovery_monitor_authority_sha256_for_ready \
        "$CHECKPOINT_WRITER_MONITOR_READY"
    )"; then
      CHECKPOINT_WRITER_MONITOR_STARTED=1
    else
      start_status=1
    fi
  fi
  if [[ "$start_status" != 0 ]]; then
    cleanup_checkpoint_writer_monitor
  fi
  restore_checkpoint_signal_traps
  pending_signal_status="$CHECKPOINT_PENDING_SIGNAL_STATUS"
  CHECKPOINT_PENDING_SIGNAL_STATUS=0
  if [[ "$pending_signal_status" != 0 &&
        "$CHECKPOINT_INTERRUPT_IN_PROGRESS" == 0 ]]; then
    checkpoint_interrupted "$pending_signal_status"
  fi
  [[ "$start_status" == 0 ]]
}

require_checkpoint_writer_monitor_healthy() {
  [[ "$CHECKPOINT_WRITER_MONITOR_STARTED" == 1 &&
     "$CHECKPOINT_WRITER_MONITOR_VERIFIED_STOPPED" == 0 &&
     "$(recovery_monitor_authority_sha256_for_ready \
       "$CHECKPOINT_WRITER_MONITOR_READY" 2>/dev/null || :)" == \
       "$CHECKPOINT_WRITER_MONITOR_AUTHORITY_SHA256" ]] || return 1
  recovery_require_checkpoint_writer_monitor_healthy \
    "$CHECKPOINT_WRITER_MONITOR_CONTRACT" \
    "$CHECKPOINT_WRITER_MONITOR_CONTRACT_SHA256" \
    "$CHECKPOINT_WRITER_MONITOR_BASELINE" \
    "$CHECKPOINT_WRITER_MONITOR_BASELINE_SHA256" \
    "$CHECKPOINT_WRITER_MONITOR_FAILURE" \
    "$CHECKPOINT_WRITER_MONITOR_READY" \
    "$CHECKPOINT_WRITER_MONITOR_PID" \
    "$CHECKPOINT_WRITER_MONITOR_START_IDENTITY" \
    "$CHECKPOINT_RUNNER_GENERATION" \
    "$RECOVERY_OPERATION_OWNER"
}

stop_checkpoint_writer_monitor_before_resume() {
  local final_json="" deployment index expected_uid resource_version
  local stop_status=0 pending_signal_status=0
  if checkpoint_uses_freeze_admission_fence; then
    if [[ "$CHECKPOINT_WRITER_MONITOR_VERIFIED_STOPPED" == 1 ]]; then
      [[ "$CHECKPOINT_FREEZE_FENCE_ACTIVE" == 0 &&
         -z "$RECOVERY_FREEZE_CHECKPOINT_FENCE_CAPABILITY" ]]
      return
    fi
    checkpoint_set_failure_context resume freeze-fence-delete
    remove_checkpoint_freeze_fence_before_resume
    return
  fi
  if [[ "$CHECKPOINT_WRITER_MONITOR_VERIFIED_STOPPED" == 1 ]]; then
    [[ -z "$CHECKPOINT_WRITER_MONITOR_PID" &&
       -z "$CHECKPOINT_WRITER_MONITOR_START_IDENTITY" ]]
    return
  fi
  [[ "$CHECKPOINT_WRITER_MONITOR_STARTED" == 1 ]] || return 0
  # Record (rather than discard) INT/TERM across the terminal LIST/WATCH join
  # and the short FINAL adoption window. This lets Bash durably copy all five
  # terminal RVs and set the verified-stopped capability before honoring the
  # pending interruption, so rollback never retries a watcher already joined.
  CHECKPOINT_PENDING_SIGNAL_STATUS=0
  if [[ "$CHECKPOINT_INTERRUPT_IN_PROGRESS" == 1 ]]; then
    trap '' INT TERM
  else
    trap 'checkpoint_record_pending_signal 130' INT
    trap 'checkpoint_record_pending_signal 143' TERM
  fi
  if ! recovery_stop_checkpoint_writer_monitor \
    "$CHECKPOINT_WRITER_MONITOR_CONTRACT" \
    "$CHECKPOINT_WRITER_MONITOR_CONTRACT_SHA256" \
    "$CHECKPOINT_WRITER_MONITOR_BASELINE" \
    "$CHECKPOINT_WRITER_MONITOR_BASELINE_SHA256" \
    "$CHECKPOINT_WRITER_MONITOR_STOP" \
    "$CHECKPOINT_WRITER_MONITOR_FAILURE" \
    "$CHECKPOINT_WRITER_MONITOR_READY" \
    "$CHECKPOINT_WRITER_MONITOR_FINAL" \
    "$CHECKPOINT_WRITER_MONITOR_PID" \
    "$CHECKPOINT_WRITER_MONITOR_START_IDENTITY" \
    CHECKPOINT_WRITER_MONITOR_JOINED \
    "$CHECKPOINT_RUNNER_GENERATION" \
    "$RECOVERY_OPERATION_OWNER"; then
    stop_status=1
  fi
  if [[ "$stop_status" == 0 ]]; then
    final_json="$(<"$CHECKPOINT_WRITER_MONITOR_FINAL")"
    recovery_checkpoint_writer_monitor_final_json_is_acceptable \
      "$final_json" "$CHECKPOINT_WRITER_MONITOR_CONTRACT" \
      "$CHECKPOINT_WRITER_MONITOR_AUTHORITY_SHA256" || stop_status=1
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
    CHECKPOINT_WRITER_MONITOR_PID=""
    CHECKPOINT_WRITER_MONITOR_START_IDENTITY=""
    CHECKPOINT_WRITER_MONITOR_VERIFIED_STOPPED=1
  fi
  restore_checkpoint_signal_traps
  pending_signal_status="$CHECKPOINT_PENDING_SIGNAL_STATUS"
  CHECKPOINT_PENDING_SIGNAL_STATUS=0
  if [[ "$pending_signal_status" != 0 &&
        "$CHECKPOINT_INTERRUPT_IN_PROGRESS" == 0 ]]; then
    checkpoint_interrupted "$pending_signal_status"
  fi
  if [[ "$stop_status" != 0 ]]; then
    printf 'Continuous checkpoint writer monitoring failed; refusing writer resume.\n' >&2
    return 1
  fi
}

cleanup_checkpoint_durable_monitor() {
  local monitor_dir_basename=""
  if [[ "$CHECKPOINT_DURABLE_MONITOR_JOINED" == 0 &&
        "$CHECKPOINT_DURABLE_MONITOR_PID" =~ ^[1-9][0-9]*$ ]]; then
    recovery_discard_durable_runner_quiescence_monitor \
      "$CHECKPOINT_DURABLE_MONITOR_STOP" \
      "$CHECKPOINT_DURABLE_MONITOR_PID" \
      "$CHECKPOINT_DURABLE_MONITOR_START_IDENTITY"
  fi
  CHECKPOINT_DURABLE_MONITOR_PID=""
  CHECKPOINT_DURABLE_MONITOR_START_IDENTITY=""
  if [[ -n "$CHECKPOINT_DURABLE_MONITOR_DIR" &&
        -d "$CHECKPOINT_DURABLE_MONITOR_DIR" &&
        ! -L "$CHECKPOINT_DURABLE_MONITOR_DIR" ]]; then
    monitor_dir_basename="$(basename "$CHECKPOINT_DURABLE_MONITOR_DIR")"
    if [[ "$monitor_dir_basename" =~ ^yenhubs-durable-runner-monitor\.[A-Za-z0-9]{6}$ ]]; then
      rm -f -- \
        "$RUNNER_DURABLE_FENCE_BASELINE_PATH" \
        "$CHECKPOINT_DURABLE_MONITOR_STOP" \
        "$CHECKPOINT_DURABLE_MONITOR_FAILURE" \
        "$CHECKPOINT_DURABLE_MONITOR_READY" \
        "${CHECKPOINT_DURABLE_MONITOR_READY}.authority.json" \
        "$CHECKPOINT_DURABLE_MONITOR_PROGRESS" \
        "${CHECKPOINT_DURABLE_MONITOR_PROGRESS}.next" \
        "$CHECKPOINT_DURABLE_MONITOR_FINAL"
      rmdir "$CHECKPOINT_DURABLE_MONITOR_DIR" 2>/dev/null || :
    fi
  fi
  CHECKPOINT_DURABLE_MONITOR_DIR=""
  RUNNER_DURABLE_FENCE_BASELINE_PATH=""
  RUNNER_DURABLE_FENCE_BASELINE_SHA256=""
  CHECKPOINT_DURABLE_MONITOR_STOP=""
  CHECKPOINT_DURABLE_MONITOR_FAILURE=""
  CHECKPOINT_DURABLE_MONITOR_READY=""
  CHECKPOINT_DURABLE_MONITOR_PROGRESS=""
  CHECKPOINT_DURABLE_MONITOR_FINAL=""
  CHECKPOINT_DURABLE_MONITOR_CAPABILITY_SHA256=""
  CHECKPOINT_DURABLE_MONITOR_AUTHORITY_SHA256=""
  CHECKPOINT_DURABLE_MONITOR_STARTED=0
  CHECKPOINT_DURABLE_MONITOR_JOINED=0
  CHECKPOINT_DURABLE_MONITOR_VERIFIED_STOPPED=0
}

start_checkpoint_durable_monitor() {
  local tmp_root start_status=0 pending_signal_status=0
  [[ "$CHECKPOINT_RUNNER_GENERATION" == durable-v2 &&
     "$CHECKPOINT_DURABLE_MONITOR_STARTED" == 0 &&
     "$CHECKPOINT_DURABLE_MONITOR_JOINED" == 0 &&
     "$CHECKPOINT_DURABLE_MONITOR_VERIFIED_STOPPED" == 0 &&
     -z "$CHECKPOINT_DURABLE_MONITOR_PID" &&
     -z "$CHECKPOINT_DURABLE_MONITOR_START_IDENTITY" &&
     -n "$RUNNER_DURABLE_FENCE_INVENTORY" &&
     -n "$CHECKPOINT_OPERATION_FENCE_ACTIVE_IDENTITY" ]] || return 2
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  recovery_require_recovery_operation_fence_state active \
    "$CHECKPOINT_OPERATION_FENCE_ACTIVE_IDENTITY" || return 1
  require_checkpoint_writer_monitor_healthy || return 1
  recovery_durable_fence_inventory_json_is_canonical \
    "$RUNNER_DURABLE_FENCE_INVENTORY" || return 1
  [[ "$(recovery_capture_durable_quiescence)" == \
     "$RUNNER_DURABLE_FENCE_INVENTORY" ]] || return 1

  tmp_root="$(recovery_canonical_private_tmp_root)" || return 1
  # Close the external mkdir -> in-memory capability gap. Once the assignment
  # is visible, the normal checkpoint signal handler can remove this directory.
  trap '' INT TERM
  if ! CHECKPOINT_DURABLE_MONITOR_DIR="$(mktemp -d \
      "$tmp_root/yenhubs-durable-runner-monitor.XXXXXX")"; then
    restore_checkpoint_signal_traps
    return 1
  fi
  restore_checkpoint_signal_traps
  chmod 700 "$CHECKPOINT_DURABLE_MONITOR_DIR" || {
    rmdir "$CHECKPOINT_DURABLE_MONITOR_DIR" 2>/dev/null || :
    CHECKPOINT_DURABLE_MONITOR_DIR=""
    return 1
  }
  RUNNER_DURABLE_FENCE_BASELINE_PATH="$CHECKPOINT_DURABLE_MONITOR_DIR/fences.json"
  CHECKPOINT_DURABLE_MONITOR_STOP="$CHECKPOINT_DURABLE_MONITOR_DIR/stop"
  CHECKPOINT_DURABLE_MONITOR_FAILURE="$CHECKPOINT_DURABLE_MONITOR_DIR/failure"
  CHECKPOINT_DURABLE_MONITOR_READY="$CHECKPOINT_DURABLE_MONITOR_DIR/ready"
  CHECKPOINT_DURABLE_MONITOR_PROGRESS="$CHECKPOINT_DURABLE_MONITOR_DIR/progress"
  CHECKPOINT_DURABLE_MONITOR_FINAL="$CHECKPOINT_DURABLE_MONITOR_DIR/final"
  if ! {
    # These are the exact canonical bytes pinned by the durable watcher. A
    # trailing LF is a different capability and is deliberately forbidden.
    printf '%s' "$RUNNER_DURABLE_FENCE_INVENTORY" \
      >"$RUNNER_DURABLE_FENCE_BASELINE_PATH" &&
    : >"$CHECKPOINT_DURABLE_MONITOR_STOP" &&
    : >"$CHECKPOINT_DURABLE_MONITOR_FAILURE" &&
    : >"$CHECKPOINT_DURABLE_MONITOR_READY" &&
    : >"$CHECKPOINT_DURABLE_MONITOR_PROGRESS" &&
    : >"$CHECKPOINT_DURABLE_MONITOR_FINAL" &&
    chmod 600 \
      "$RUNNER_DURABLE_FENCE_BASELINE_PATH" \
      "$CHECKPOINT_DURABLE_MONITOR_STOP" \
      "$CHECKPOINT_DURABLE_MONITOR_FAILURE" \
      "$CHECKPOINT_DURABLE_MONITOR_READY" \
      "$CHECKPOINT_DURABLE_MONITOR_PROGRESS" \
      "$CHECKPOINT_DURABLE_MONITOR_FINAL";
  }; then
    cleanup_checkpoint_durable_monitor
    return 1
  fi
  RUNNER_DURABLE_FENCE_BASELINE_SHA256="$(recovery_sha256_digest \
    "$RUNNER_DURABLE_FENCE_BASELINE_PATH")" || {
    cleanup_checkpoint_durable_monitor
    return 1
  }
  recovery_checkpoint_writer_monitor_file_is_exact \
    "$RUNNER_DURABLE_FENCE_BASELINE_PATH" \
    "$RUNNER_DURABLE_FENCE_BASELINE_SHA256" 1048576 || {
    cleanup_checkpoint_durable_monitor
    return 1
  }

  CHECKPOINT_PENDING_SIGNAL_STATUS=0
  if [[ "$CHECKPOINT_INTERRUPT_IN_PROGRESS" == 1 ]]; then
    trap '' INT TERM
  else
    trap 'checkpoint_record_pending_signal 130' INT
    trap 'checkpoint_record_pending_signal 143' TERM
  fi
  if ! recovery_start_durable_runner_quiescence_monitor \
      "$RUNNER_DURABLE_FENCE_BASELINE_PATH" \
      "$RUNNER_DURABLE_FENCE_BASELINE_SHA256" \
      "$CHECKPOINT_WRITER_MONITOR_BASELINE" \
      "$CHECKPOINT_WRITER_MONITOR_BASELINE_SHA256" \
      "$CHECKPOINT_DURABLE_MONITOR_STOP" \
      "$CHECKPOINT_DURABLE_MONITOR_FAILURE" \
      "$CHECKPOINT_DURABLE_MONITOR_READY" \
      "$CHECKPOINT_DURABLE_MONITOR_PROGRESS" \
      "$CHECKPOINT_DURABLE_MONITOR_FINAL" \
      CHECKPOINT_DURABLE_MONITOR_PID \
      CHECKPOINT_DURABLE_MONITOR_START_IDENTITY \
      CHECKPOINT_DURABLE_MONITOR_CAPABILITY_SHA256 \
      "$RECOVERY_OPERATION_OWNER"; then
    start_status=1
  else
    if CHECKPOINT_DURABLE_MONITOR_AUTHORITY_SHA256="$(
      recovery_monitor_authority_sha256_for_ready \
        "$CHECKPOINT_DURABLE_MONITOR_READY"
    )"; then
      CHECKPOINT_DURABLE_MONITOR_STARTED=1
    else
      start_status=1
    fi
  fi
  if [[ "$start_status" != 0 ]]; then
    cleanup_checkpoint_durable_monitor
  fi
  restore_checkpoint_signal_traps
  pending_signal_status="$CHECKPOINT_PENDING_SIGNAL_STATUS"
  CHECKPOINT_PENDING_SIGNAL_STATUS=0
  if [[ "$pending_signal_status" != 0 &&
        "$CHECKPOINT_INTERRUPT_IN_PROGRESS" == 0 ]]; then
    checkpoint_interrupted "$pending_signal_status"
  fi
  [[ "$start_status" == 0 ]]
}

require_checkpoint_durable_monitor_healthy() {
  [[ "$CHECKPOINT_RUNNER_GENERATION" == durable-v2 &&
     "$CHECKPOINT_DURABLE_MONITOR_STARTED" == 1 &&
     "$CHECKPOINT_DURABLE_MONITOR_VERIFIED_STOPPED" == 0 &&
     "$CHECKPOINT_DURABLE_MONITOR_PID" != "$CHECKPOINT_WRITER_MONITOR_PID" &&
     "$(recovery_monitor_authority_sha256_for_ready \
       "$CHECKPOINT_DURABLE_MONITOR_READY" 2>/dev/null || :)" == \
       "$CHECKPOINT_DURABLE_MONITOR_AUTHORITY_SHA256" ]] || return 1
  recovery_require_recovery_operation_fence_state active \
    "$CHECKPOINT_OPERATION_FENCE_ACTIVE_IDENTITY" &&
    recovery_require_durable_runner_quiescence_monitor_healthy \
      "$RUNNER_DURABLE_FENCE_BASELINE_PATH" \
      "$RUNNER_DURABLE_FENCE_BASELINE_SHA256" \
      "$CHECKPOINT_WRITER_MONITOR_BASELINE" \
      "$CHECKPOINT_WRITER_MONITOR_BASELINE_SHA256" \
      "$CHECKPOINT_DURABLE_MONITOR_FAILURE" \
      "$CHECKPOINT_DURABLE_MONITOR_READY" \
      "$CHECKPOINT_DURABLE_MONITOR_PROGRESS" \
      "$CHECKPOINT_DURABLE_MONITOR_PID" \
      "$CHECKPOINT_DURABLE_MONITOR_START_IDENTITY" \
      "$CHECKPOINT_DURABLE_MONITOR_CAPABILITY_SHA256" \
      "$RECOVERY_OPERATION_OWNER"
}

require_checkpoint_monitors_healthy() {
  if checkpoint_uses_freeze_admission_fence; then
    require_checkpoint_freeze_fence_zero_boundary || return 1
  else
    require_checkpoint_writer_monitor_healthy || return 1
  fi
  if [[ "$CHECKPOINT_RUNNER_GENERATION" == durable-v2 ]]; then
    require_checkpoint_durable_monitor_healthy
  fi
}

stop_checkpoint_durable_monitor_before_writer_monitor() {
  local stop_status=0 pending_signal_status=0
  if [[ "$CHECKPOINT_RUNNER_GENERATION" != durable-v2 ]]; then
    [[ "$CHECKPOINT_DURABLE_MONITOR_STARTED" == 0 &&
       -z "$CHECKPOINT_DURABLE_MONITOR_PID" ]]
    return
  fi
  if [[ "$CHECKPOINT_DURABLE_MONITOR_VERIFIED_STOPPED" == 1 ]]; then
    [[ -z "$CHECKPOINT_DURABLE_MONITOR_PID" &&
       -z "$CHECKPOINT_DURABLE_MONITOR_START_IDENTITY" ]]
    return
  fi
  [[ "$CHECKPOINT_DURABLE_MONITOR_STARTED" == 1 ]] || return 0
  CHECKPOINT_PENDING_SIGNAL_STATUS=0
  if [[ "$CHECKPOINT_INTERRUPT_IN_PROGRESS" == 1 ]]; then
    trap '' INT TERM
  else
    trap 'checkpoint_record_pending_signal 130' INT
    trap 'checkpoint_record_pending_signal 143' TERM
  fi
  if ! recovery_stop_durable_runner_quiescence_monitor \
      "$RUNNER_DURABLE_FENCE_BASELINE_PATH" \
      "$RUNNER_DURABLE_FENCE_BASELINE_SHA256" \
      "$CHECKPOINT_WRITER_MONITOR_BASELINE" \
      "$CHECKPOINT_WRITER_MONITOR_BASELINE_SHA256" \
      "$CHECKPOINT_DURABLE_MONITOR_STOP" \
      "$CHECKPOINT_DURABLE_MONITOR_FAILURE" \
      "$CHECKPOINT_DURABLE_MONITOR_READY" \
      "$CHECKPOINT_DURABLE_MONITOR_PROGRESS" \
      "$CHECKPOINT_DURABLE_MONITOR_FINAL" \
      "$CHECKPOINT_DURABLE_MONITOR_PID" \
      "$CHECKPOINT_DURABLE_MONITOR_START_IDENTITY" \
      "$CHECKPOINT_DURABLE_MONITOR_CAPABILITY_SHA256" \
      CHECKPOINT_DURABLE_MONITOR_JOINED \
      "$RECOVERY_OPERATION_OWNER"; then
    stop_status=1
  fi
  if [[ "$stop_status" == 0 ]]; then
    CHECKPOINT_DURABLE_MONITOR_PID=""
    CHECKPOINT_DURABLE_MONITOR_START_IDENTITY=""
    CHECKPOINT_DURABLE_MONITOR_VERIFIED_STOPPED=1
  fi
  restore_checkpoint_signal_traps
  pending_signal_status="$CHECKPOINT_PENDING_SIGNAL_STATUS"
  CHECKPOINT_PENDING_SIGNAL_STATUS=0
  if [[ "$pending_signal_status" != 0 &&
        "$CHECKPOINT_INTERRUPT_IN_PROGRESS" == 0 ]]; then
    checkpoint_interrupted "$pending_signal_status"
  fi
  if [[ "$stop_status" != 0 ]]; then
    printf 'Durable runner quiescence monitoring failed; refusing writer-monitor stop.\n' >&2
    return 1
  fi
}

snapshot_checkpoint_private_file() {
  local destination_variable="$1" source_path="$2" label="$3"
  local snapshot_dir="" snapshot_path="" raw_snapshot_path=""
  local canonical_snapshot_path="" acquisition_status=0
  [[ -n "$destination_variable" && -n "$label" ]] || return 2
  # Register the private copy in its caller-owned global before the copy
  # process can receive a signal. Ignore signals only across external mktemp
  # creation through that capability assignment, so no secret-bearing inode
  # can become unreachable by EXIT cleanup.
  trap '' INT TERM
  if snapshot_dir="$(
       mktemp -d "${TMPDIR:-/tmp}/yenhubs-checkpoint-$label.XXXXXX"
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
  restore_checkpoint_signal_traps
  if [[ "$acquisition_status" != 0 ]]; then
    [[ -z "$snapshot_path" ]] || rm -f -- "$snapshot_path"
    [[ -z "$snapshot_dir" ]] || rmdir "$snapshot_dir" 2>/dev/null || :
    return 1
  fi
  if ! command node "$SCRIPT_DIR/snapshot-private-file.mjs" \
    "$source_path" "$snapshot_path"; then
    rm -f -- "$snapshot_path"
    rmdir "$snapshot_dir" 2>/dev/null
    printf -v "$destination_variable" '%s' ""
    printf 'Could not bind a private immutable checkpoint %s snapshot.\n' \
      "$label" >&2
    return 1
  fi
}

checkpoint_runner_mode_from_values() {
  local values_path="$1" runner_image activation_phase recovery_phase recovery_epoch
  runner_image="$(command node "$SCRIPT_DIR/parse-local-values.mjs" \
    "$values_path" --get OVERRIDE_BOT_RUNNER_IMAGE)" || return 1
  case "$runner_image" in
    No)
      printf 'process-local\n'
      ;;
    ghcr.io/yengalvez/bot-runner@sha256:*)
      [[ "$runner_image" =~ ^ghcr\.io/yengalvez/bot-runner@sha256:[a-fA-F0-9]{64}$ ]] || {
        printf 'The local runner image does not identify one exact checkpoint generation.\n' >&2
        return 1
      }
      activation_phase="$(command node "$SCRIPT_DIR/parse-local-values.mjs" \
        "$values_path" --get BOT_RUNNER_ACTIVATION_PHASE)" || return 1
      recovery_phase="$(command node "$SCRIPT_DIR/parse-local-values.mjs" \
        "$values_path" --get BOT_RUNNER_RECOVERY_PHASE)" || return 1
      recovery_epoch="$(command node "$SCRIPT_DIR/parse-local-values.mjs" \
        "$values_path" --get BOT_RUNNER_RECOVERY_EPOCH)" || return 1
      [[ "$activation_phase" == active && "$recovery_phase" == active &&
         "$recovery_epoch" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ ]] || {
        printf 'Durable checkpoint VALUES must select the exact active runner epoch contract.\n' >&2
        return 1
      }
      printf 'kubernetes-pod\n'
      ;;
    *)
      printf 'The local runner image does not identify one exact checkpoint generation.\n' >&2
      return 1
      ;;
  esac
}

checkpoint_require_runner_mode_exact() {
  recovery_require_checkpoint_runner_mode_exact \
    "$VALUES_SOURCE_FILE" "$1" "$CHECKPOINT_PROCESS_LOCAL_STRATEGY_SCOPE"
}

cleanup_runner_monitor() {
  if [[ -n "$RUNNER_MONITOR_PID" ]]; then
    recovery_discard_no_managed_bot_runner_watch \
      "$RUNNER_MONITOR_STOP" "$RUNNER_MONITOR_PID" \
      "$RUNNER_MONITOR_START_IDENTITY"
    RUNNER_MONITOR_PID=""
    RUNNER_MONITOR_START_IDENTITY=""
  fi
  RUNNER_MONITOR_START_IDENTITY=""
  [[ -z "$RUNNER_MONITOR_STOP" ]] || rm -f -- "$RUNNER_MONITOR_STOP"
  [[ -z "$RUNNER_MONITOR_FAILURE" ]] || rm -f -- "$RUNNER_MONITOR_FAILURE"
  [[ -z "$RUNNER_MONITOR_READY" ]] || rm -f -- "$RUNNER_MONITOR_READY"
  RUNNER_MONITOR_STOP=""
  RUNNER_MONITOR_FAILURE=""
  RUNNER_MONITOR_READY=""
  RUNNER_DURABLE_FENCE_INVENTORY=""
}

start_runner_monitor() {
  local start_status=0 pending_signal_status=0
  [[ -z "$RUNNER_MONITOR_PID" &&
     -z "$RUNNER_MONITOR_START_IDENTITY" ]] || return 2
  if [[ "$CHECKPOINT_RUNNER_MODE" == kubernetes-pod ]]; then
    recovery_require_durable_runner_quiescence_stable || return 1
    RUNNER_DURABLE_FENCE_INVENTORY="$(
      recovery_capture_durable_quiescence
    )" || return 1
    recovery_durable_fence_inventory_json_is_canonical \
      "$RUNNER_DURABLE_FENCE_INVENTORY" || return 1
    return 0
  fi
  recovery_require_no_managed_bot_runner_pods || return 1
  # Bind the three marker paths and the isolated PID as one local capability.
  # A cooperative signal is recorded until either all four values are globally
  # reachable or every partial marker/process has been revoked.
  CHECKPOINT_PENDING_SIGNAL_STATUS=0
  if [[ "$CHECKPOINT_INTERRUPT_IN_PROGRESS" == 1 ]]; then
    trap '' INT TERM
  else
    trap 'checkpoint_record_pending_signal 130' INT
    trap 'checkpoint_record_pending_signal 143' TERM
  fi
  RUNNER_MONITOR_STOP="$(mktemp \
    "${TMPDIR:-/tmp}/yenhubs-checkpoint-runner-stop.XXXXXX")" || start_status=1
  if [[ "$start_status" == 0 ]]; then
    RUNNER_MONITOR_FAILURE="$(mktemp \
      "${TMPDIR:-/tmp}/yenhubs-checkpoint-runner-failure.XXXXXX")" || start_status=1
  fi
  if [[ "$start_status" == 0 ]]; then
    RUNNER_MONITOR_READY="$(mktemp \
      "${TMPDIR:-/tmp}/yenhubs-checkpoint-runner-ready.XXXXXX")" || start_status=1
  fi
  if [[ "$start_status" == 0 ]]; then
    chmod 600 \
      "$RUNNER_MONITOR_STOP" "$RUNNER_MONITOR_FAILURE" \
      "$RUNNER_MONITOR_READY" || start_status=1
  fi
  if [[ "$start_status" == 0 ]] &&
     ! recovery_start_no_managed_bot_runner_watch \
       "$RUNNER_MONITOR_STOP" "$RUNNER_MONITOR_FAILURE" \
       "$RUNNER_MONITOR_READY" RUNNER_MONITOR_PID \
       RUNNER_MONITOR_START_IDENTITY; then
    start_status=1
  fi
  if [[ "$start_status" != 0 ]]; then
    cleanup_runner_monitor
  fi
  restore_checkpoint_signal_traps
  pending_signal_status="$CHECKPOINT_PENDING_SIGNAL_STATUS"
  CHECKPOINT_PENDING_SIGNAL_STATUS=0
  if [[ "$pending_signal_status" != 0 &&
        "$CHECKPOINT_INTERRUPT_IN_PROGRESS" == 0 ]]; then
    checkpoint_interrupted "$pending_signal_status"
  fi
  [[ "$start_status" == 0 ]]
}

stop_runner_monitor_before_resume() {
  local monitor_status=0 pending_signal_status=0
  if [[ "$CHECKPOINT_RUNNER_MODE" == kubernetes-pod ]]; then
    stop_checkpoint_durable_monitor_before_writer_monitor
    return
  fi
  CHECKPOINT_PENDING_SIGNAL_STATUS=0
  if [[ "$CHECKPOINT_INTERRUPT_IN_PROGRESS" == 1 ]]; then
    trap '' INT TERM
  else
    trap 'checkpoint_record_pending_signal 130' INT
    trap 'checkpoint_record_pending_signal 143' TERM
  fi
  if [[ -n "$RUNNER_MONITOR_PID" ]]; then
    if ! recovery_stop_no_managed_bot_runner_watch \
      "$RUNNER_MONITOR_STOP" "$RUNNER_MONITOR_FAILURE" "$RUNNER_MONITOR_READY" \
      "$RUNNER_MONITOR_PID" "$RUNNER_MONITOR_START_IDENTITY"; then
      monitor_status=1
    fi
    RUNNER_MONITOR_PID=""
    RUNNER_MONITOR_START_IDENTITY=""
  else
    monitor_status=1
  fi
  [[ -z "$RUNNER_MONITOR_STOP" ]] || rm -f -- "$RUNNER_MONITOR_STOP"
  [[ -z "$RUNNER_MONITOR_FAILURE" ]] || rm -f -- "$RUNNER_MONITOR_FAILURE"
  [[ -z "$RUNNER_MONITOR_READY" ]] || rm -f -- "$RUNNER_MONITOR_READY"
  RUNNER_MONITOR_STOP=""
  RUNNER_MONITOR_FAILURE=""
  RUNNER_MONITOR_READY=""
  restore_checkpoint_signal_traps
  pending_signal_status="$CHECKPOINT_PENDING_SIGNAL_STATUS"
  CHECKPOINT_PENDING_SIGNAL_STATUS=0
  if [[ "$pending_signal_status" != 0 &&
        "$CHECKPOINT_INTERRUPT_IN_PROGRESS" == 0 ]]; then
    checkpoint_interrupted "$pending_signal_status"
  fi
  if [[ "$monitor_status" != 0 ]]; then
    printf 'Managed bot-runner quiescence monitoring failed; refusing writer resume.\n' >&2
    return 1
  fi
}

handoff_runner_monitor() {
  local old_stop="$RUNNER_MONITOR_STOP" old_failure="$RUNNER_MONITOR_FAILURE"
  local old_ready="$RUNNER_MONITOR_READY" old_pid="$RUNNER_MONITOR_PID"
  local old_identity="$RUNNER_MONITOR_START_IDENTITY"
  local new_stop="" new_failure="" new_ready="" new_pid="" new_identity=""
  local handoff_status=0 pending_signal_status=0 old_stop_attempted=0
  if [[ "$CHECKPOINT_RUNNER_MODE" == kubernetes-pod ]]; then
    require_checkpoint_durable_monitor_healthy
    return
  fi
  [[ "$old_pid" =~ ^[1-9][0-9]*$ && -n "$old_identity" ]] || return 1
  # The handoff may include a full stable-absence handshake, so record rather
  # than discard its first signal. No handler may observe the new isolated
  # watcher before it is either cleaned or adopted into the global capability.
  CHECKPOINT_PENDING_SIGNAL_STATUS=0
  if [[ "$CHECKPOINT_INTERRUPT_IN_PROGRESS" == 1 ]]; then
    trap '' INT TERM
  else
    trap 'checkpoint_record_pending_signal 130' INT
    trap 'checkpoint_record_pending_signal 143' TERM
  fi
  new_stop="$(mktemp \
    "${TMPDIR:-/tmp}/yenhubs-checkpoint-runner-stop.XXXXXX")" || handoff_status=1
  if [[ "$handoff_status" == 0 ]]; then
    new_failure="$(mktemp \
      "${TMPDIR:-/tmp}/yenhubs-checkpoint-runner-failure.XXXXXX")" || handoff_status=1
  fi
  if [[ "$handoff_status" == 0 ]]; then
    new_ready="$(mktemp \
      "${TMPDIR:-/tmp}/yenhubs-checkpoint-runner-ready.XXXXXX")" || handoff_status=1
  fi
  if [[ "$handoff_status" == 0 ]]; then
    chmod 600 "$new_stop" "$new_failure" "$new_ready" || handoff_status=1
  fi
  if [[ "$handoff_status" == 0 ]] &&
     ! recovery_start_no_managed_bot_runner_watch \
       "$new_stop" "$new_failure" "$new_ready" new_pid new_identity; then
    handoff_status=1
  fi
  # The new LIST+resourceVersion watches are ready before the previous watcher
  # is joined, so no transient ADDED+DELETED event can fall into a handoff gap.
  if [[ "$handoff_status" == 0 ]]; then
    old_stop_attempted=1
    if ! recovery_stop_no_managed_bot_runner_watch \
        "$old_stop" "$old_failure" "$old_ready" "$old_pid" \
        "$old_identity"; then
      handoff_status=1
    fi
  fi
  if [[ "$handoff_status" == 0 ]]; then
    rm -f -- "$old_stop" "$old_failure" "$old_ready"
    RUNNER_MONITOR_STOP="$new_stop"
    RUNNER_MONITOR_FAILURE="$new_failure"
    RUNNER_MONITOR_READY="$new_ready"
    RUNNER_MONITOR_PID="$new_pid"
    RUNNER_MONITOR_START_IDENTITY="$new_identity"
  else
    if [[ "$old_stop_attempted" == 1 ]]; then
      # A failed stop has nevertheless joined or force-revoked the old isolated
      # process group. Clear its stale capability so rollback can reconstruct a
      # fresh guard from the still-exact zero-replica parent contract.
      rm -f -- "$old_stop" "$old_failure" "$old_ready"
      RUNNER_MONITOR_STOP=""
      RUNNER_MONITOR_FAILURE=""
      RUNNER_MONITOR_READY=""
      RUNNER_MONITOR_PID=""
      RUNNER_MONITOR_START_IDENTITY=""
    fi
    recovery_discard_no_managed_bot_runner_watch \
      "$new_stop" "$new_pid" "$new_identity"
    [[ -z "$new_stop" ]] || rm -f -- "$new_stop"
    [[ -z "$new_failure" ]] || rm -f -- "$new_failure"
    [[ -z "$new_ready" ]] || rm -f -- "$new_ready"
  fi
  restore_checkpoint_signal_traps
  pending_signal_status="$CHECKPOINT_PENDING_SIGNAL_STATUS"
  CHECKPOINT_PENDING_SIGNAL_STATUS=0
  if [[ "$pending_signal_status" != 0 &&
        "$CHECKPOINT_INTERRUPT_IN_PROGRESS" == 0 ]]; then
    checkpoint_interrupted "$pending_signal_status"
  fi
  if [[ "$handoff_status" != 0 ]]; then
    printf 'Managed bot-runner quiescence monitoring failed before checkpoint publication.\n' >&2
    return 1
  fi
}

require_checkpoint_dormant_operation_fence_now() {
  if [[ "$CHECKPOINT_RUNNER_MODE" != kubernetes-pod ]]; then
    return 0
  fi
  # Once this operation has completed active -> dormant, retain that exact
  # policy/binding UID+resourceVersion capability through every writer resume
  # and the lock release. An unpinned dormant read is permitted only before
  # this invocation has ever activated the fence, for early rollback.
  [[ -z "$CHECKPOINT_OPERATION_FENCE_ACTIVE_IDENTITY" ]] || return 1
  if [[ -n "$CHECKPOINT_OPERATION_FENCE_DORMANT_IDENTITY" ]]; then
    recovery_require_recovery_operation_fence_state dormant \
      "$CHECKPOINT_OPERATION_FENCE_DORMANT_IDENTITY"
  else
    recovery_require_recovery_operation_fence_state dormant
  fi
}

require_checkpoint_runner_quiescent_now() {
  if [[ "$CHECKPOINT_RUNNER_MODE" == kubernetes-pod ]]; then
    [[ -n "$RUNNER_DURABLE_FENCE_INVENTORY" ]] || return 1
    [[ "$(recovery_capture_durable_quiescence)" == \
       "$RUNNER_DURABLE_FENCE_INVENTORY" ]] || return 1
    recovery_require_no_legacy_parent_runner_pods || return 1
    if [[ "$CHECKPOINT_DURABLE_MONITOR_STARTED" == 1 &&
          "$CHECKPOINT_DURABLE_MONITOR_VERIFIED_STOPPED" == 0 ]]; then
      require_checkpoint_durable_monitor_healthy
    elif [[ -n "$CHECKPOINT_OPERATION_FENCE_ACTIVE_IDENTITY" ]]; then
      recovery_require_recovery_operation_fence_state active \
        "$CHECKPOINT_OPERATION_FENCE_ACTIVE_IDENTITY"
    else
      if [[ -n "$CHECKPOINT_OPERATION_FENCE_DORMANT_IDENTITY" ]]; then
        checkpoint_set_failure_context resume fence-continuity
      fi
      require_checkpoint_dormant_operation_fence_now
    fi
  else
    recovery_require_no_managed_bot_runner_watch_healthy \
      "$RUNNER_MONITOR_FAILURE" "$RUNNER_MONITOR_READY" \
      "$RUNNER_MONITOR_PID" "$RUNNER_MONITOR_START_IDENTITY" &&
      recovery_require_no_managed_bot_runner_pods
  fi
}

checkpoint_directory_cleanup_allowlist() {
  local artifact
  while IFS= read -r artifact; do
    printf 'f:%s\n' "$artifact"
  done < <(checkpoint_artifacts)
  printf '%s\n' f:SHA256SUMS
}

cleanup_checkpoint_staging_directory() {
  local cleanup_path
  local -a cleanup_paths=(
    f:.yenhubs-staging-owner
    f:.checkpoint-metadata.next
    f:.yenhubs-checksums.next
  )
  [[ "$CHECKPOINT_STAGING_OWNED" == 1 ]] || return 0
  if [[ "$OUTPUT_DIR_SETUP_FAILED" == 1 ]]; then
    OUTPUT_DIR_CLEANUP_ATTEMPTED=1
    printf 'Checkpoint staging initialization is latched incomplete; preserving the untrusted private orphan.\n' >&2
    return 1
  fi
  [[ "$OUTPUT_DIR_RETIRED" == 0 &&
     "$OUTPUT_DIR_CLEANUP_ATTEMPTED" == 0 ]] || return 1
  OUTPUT_DIR_CLEANUP_ATTEMPTED=1
  while IFS= read -r cleanup_path; do
    cleanup_paths+=("$cleanup_path")
  done < <(checkpoint_directory_cleanup_allowlist)
  if recovery_cleanup_marked_private_directory \
      "$OUTPUT_DIR_PRIVATE_TOKEN" .yenhubs-staging-owner \
      yenhubs-checkpoint-staging-v1 "${cleanup_paths[@]}"; then
    OUTPUT_DIR_RETIRED=1
    CHECKPOINT_STAGING_OWNED=0
    OUTPUT_DIR_PRIVATE_TOKEN=""
    OUTPUT_DIR_SETUP_FAILED=0
    CHECKPOINT_STAGING_MARKER=""
    OUTPUT_DIR=""
    return 0
  fi
  printf 'Checkpoint staging cleanup failed closed; any exact empty orphan or replacement was preserved.\n' >&2
  return 1
}

cleanup_checkpoint_final_claim() {
  local cleanup_path
  local -a cleanup_paths=(f:.yenhubs-incomplete)
  [[ "$FINAL_CLAIM_OWNED" == 1 &&
     "$FINAL_PUBLICATION_COMMITTED" == 0 ]] || return 0
  if [[ "$FINAL_OUTPUT_DIR_SETUP_FAILED" == 1 ||
        "$FINAL_CLAIM_INITIALIZING" == 1 ]]; then
    FINAL_OUTPUT_DIR_CLEANUP_ATTEMPTED=1
    printf 'Checkpoint final-claim initialization is latched incomplete; preserving the untrusted private orphan.\n' >&2
    return 1
  fi
  [[ "$FINAL_OUTPUT_DIR_RETIRED" == 0 &&
     "$FINAL_OUTPUT_DIR_CLEANUP_ATTEMPTED" == 0 ]] || return 1
  FINAL_OUTPUT_DIR_CLEANUP_ATTEMPTED=1
  while IFS= read -r cleanup_path; do
    cleanup_paths+=("$cleanup_path")
  done < <(checkpoint_directory_cleanup_allowlist)
  if [[ "$RECOVERY_OPERATION_ID" =~ ^[a-f0-9]{32}$ ]] &&
     recovery_cleanup_marked_private_directory \
       "$FINAL_OUTPUT_DIR_PRIVATE_TOKEN" .yenhubs-incomplete \
       "yenhubs-incomplete:$RECOVERY_OPERATION_ID" "${cleanup_paths[@]}"; then
    FINAL_OUTPUT_DIR_RETIRED=1
    FINAL_CLAIM_OWNED=0
    FINAL_CLAIM_INITIALIZING=0
    FINAL_OUTPUT_DIR_PRIVATE_TOKEN=""
    FINAL_OUTPUT_DIR_SETUP_FAILED=0
    FINAL_INCOMPLETE_MARKER=""
    return 0
  fi
  printf 'Incomplete checkpoint claim cleanup failed closed; any exact empty orphan or replacement was preserved.\n' >&2
  return 1
}

verify_checkpoint_staging_directory() {
  local actual expected
  if [[ "$CHECKPOINT_FORMAT" == freeze-bundle-v1 ]]; then
    recovery_verify_freeze_bundle_contents "$OUTPUT_DIR" "$TIMESTAMP" || return 1
  else
    recovery_validate_sha256_manifest "$OUTPUT_DIR" "$TIMESTAMP" 3 &&
      recovery_checkpoint_metadata_is_acceptable \
        "$OUTPUT_DIR/checkpoint-metadata.json" "$TIMESTAMP" &&
      recovery_checkpoint_generation_is_acceptable "$OUTPUT_DIR" || return 1
  fi
  actual="$(find "$OUTPUT_DIR" -mindepth 1 -maxdepth 1 -print |
    while IFS= read -r path; do basename "$path"; done | LC_ALL=C sort)"
  expected="$({ checkpoint_artifacts; printf '%s\n' \
    SHA256SUMS .yenhubs-staging-owner; } | LC_ALL=C sort)"
  [[ "$actual" == "$expected" ]]
}

cleanup_local_artifacts() {
  local snapshot_path snapshot_parent snapshot_base
  # The durable monitor pins the writer schema-3 baseline, so revoke/join it
  # before the writer cleanup is allowed to remove those control bytes.
  cleanup_checkpoint_durable_monitor
  cleanup_checkpoint_writer_monitor
  cleanup_runner_monitor
  for snapshot_path in \
    "$CHECKPOINT_VALUES_SNAPSHOT" "$CHECKPOINT_MANIFEST_SNAPSHOT" \
    "$CHECKPOINT_CUTOVER_KEY_SNAPSHOT"; do
    [[ -z "$snapshot_path" ]] || {
      snapshot_parent="$(dirname "$snapshot_path")"
      snapshot_base="$(basename "$snapshot_parent")"
      if [[ "$snapshot_parent" == "$(cd "$(dirname "$snapshot_parent")" 2>/dev/null && pwd -P)/$snapshot_base" &&
            "$snapshot_base" =~ ^yenhubs-checkpoint-(values|manifest|cutover-key)\.[A-Za-z0-9]{6}$ ]]; then
        rm -f -- "$snapshot_path"
        rmdir "$snapshot_parent" 2>/dev/null || :
      fi
    }
  done
  CHECKPOINT_VALUES_SNAPSHOT=""
  CHECKPOINT_MANIFEST_SNAPSHOT=""
  CHECKPOINT_CUTOVER_KEY_SNAPSHOT=""
  VALUES_SOURCE_FILE=""
  cleanup_checkpoint_staging_directory || :
  cleanup_checkpoint_final_claim || :
  if [[ "$PUBLISH_LOCK_OWNED" == 1 && -d "$PUBLISH_LOCK" && ! -L "$PUBLISH_LOCK" ]]; then
    rmdir "$PUBLISH_LOCK" 2>/dev/null || :
  fi
  PUBLISH_LOCK_OWNED=0
  if [[ "$SERIALIZATION_LEASE_OWNED" == 1 &&
        "$CHECKPOINT_FREEZE_FENCE_CLEANUP_FAILED" == 0 &&
        -z "$RECOVERY_FREEZE_CHECKPOINT_FENCE_CAPABILITY" &&
        -z "$RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_UID" &&
        -z "$RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_UID" &&
        "$RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_CREATE_ATTEMPTED" == 0 &&
        "$RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_CREATE_ATTEMPTED" == 0 ]]; then
    if recovery_release_operation_serialization; then
      SERIALIZATION_LEASE_OWNED=0
    else
      printf 'Checkpoint serialization Lease could not be released safely.\n' >&2
    fi
  fi
}

release_serialization_if_owned() {
  [[ "$SERIALIZATION_LEASE_OWNED" == 1 ]] || return 0
  recovery_release_operation_serialization || return 1
  SERIALIZATION_LEASE_OWNED=0
}

capture_consumer_contracts() {
  local deployment contract uid resource_version replicas selector fingerprint
  local receipt_absent_resource_version
  local consumers_json='[]'
  for deployment in "${CONSUMERS[@]}"; do
    contract="$(recovery_capture_deployment_contract "$deployment")" || return 1
    IFS=$'\t' read -r uid resource_version replicas selector fingerprint <<<"$contract"
    [[ "$replicas" =~ ^[0-9]+$ && "$replicas" -gt 0 ]] || {
      printf 'Every checkpoint writer must be running before capture: %s.\n' "$deployment" >&2
      return 1
    }
    receipt_absent_resource_version="$(
      recovery_capture_checkpoint_resume_receipt_absent_contract \
        "$deployment" "$uid" "$replicas" "$selector" "$fingerprint"
    )" || {
      printf 'Checkpoint writer has a stale or unknown resume receipt: %s.\n' \
        "$deployment" >&2
      return 1
    }
    [[ "$receipt_absent_resource_version" == "$resource_version" ]] || {
      printf 'Checkpoint writer changed while proving receipt absence: %s.\n' \
        "$deployment" >&2
      return 1
    }
    DEPLOYMENT_UIDS+=("$uid")
    DEPLOYMENT_RESOURCE_VERSIONS+=("$resource_version")
    ORIGINAL_REPLICAS+=("$replicas")
    DEPLOYMENT_SELECTORS+=("$selector")
    DEPLOYMENT_FINGERPRINTS+=("$fingerprint")
    consumers_json="$(jq -cn --argjson current "$consumers_json" \
      --arg name "$deployment" --arg uid "$uid" \
      --arg resource_version "$resource_version" --argjson replicas "$replicas" \
      --arg selector "$selector" --arg fingerprint "$fingerprint" \
      '$current + [{name:$name,uid:$uid,initial_resource_version:$resource_version,
        original_replicas:$replicas,selector:$selector,fingerprint:$fingerprint}]')"
  done
  RECOVERY_CONSUMER_CONTRACT_JSON="$(jq -cn \
    --arg operation_id "$RECOVERY_OPERATION_ID" --argjson consumers "$consumers_json" \
    '{schema_version:1,operation_id:$operation_id,consumers:$consumers}')"
  recovery_consumer_contract_is_acceptable "$RECOVERY_CONSUMER_CONTRACT_JSON" || return 1
  export RECOVERY_CONSUMER_CONTRACT_JSON
}

require_checkpoint_runner_absence_stable() {
  local stable_seconds started
  stable_seconds="$(recovery_stable_absence_seconds)" || return 1
  started="$SECONDS"
  if [[ "$CHECKPOINT_RUNNER_MODE" == kubernetes-pod ]]; then
    require_checkpoint_runner_quiescent_now
    return
  fi
  while :; do
    recovery_require_operation_lock || return 1
    recovery_require_no_managed_bot_runner_watch_healthy \
      "$RUNNER_MONITOR_FAILURE" "$RUNNER_MONITOR_READY" \
      "$RUNNER_MONITOR_PID" "$RUNNER_MONITOR_START_IDENTITY" || return 1
    recovery_require_no_managed_bot_runner_pods || return 1
    ((SECONDS - started >= stable_seconds)) && return 0
    sleep 1
  done
}

require_checkpoint_post_watch_absence_stable() {
  local stable_seconds started current_fences
  stable_seconds="$(recovery_stable_absence_seconds)" || return 1
  started="$SECONDS"
  if [[ "$CHECKPOINT_RUNNER_MODE" == kubernetes-pod ]]; then
    [[ -n "$RUNNER_DURABLE_FENCE_INVENTORY" ]] || return 1
    current_fences="$(recovery_capture_durable_quiescence)" || return 1
    [[ "$current_fences" == "$RUNNER_DURABLE_FENCE_INVENTORY" ]] || return 1
    recovery_require_no_legacy_parent_runner_pods
    return
  fi
  while :; do
    recovery_require_operation_lock || return 1
    recovery_require_consumer_contract_entry "$RECOVERY_CONSUMER_CONTRACT_JSON" \
      bot-orchestrator 0 || return 1
    recovery_require_no_managed_bot_runner_pods || return 1
    ((SECONDS - started >= stable_seconds)) && return 0
    sleep 1
  done
}

quiesce_writers() {
  local index rolling_scale_result rolling_zero_contract rolling_generation
  local -a remaining_order=(0 1 2 4)
  WRITERS_MUTATED=1
  # Revoke the token-bearing parent first and wait for its Pod to disappear.
  # Legacy then UID-deletes issued runners under its event watcher. Durable-v2
  # reconciles exact causal identities into permanent fences and records one
  # stable fence inventory for every later synchronous quiescence gate.
  index=3
  if [[ "$CHECKPOINT_PROCESS_LOCAL_ROLLING" == 1 ]]; then
    rolling_scale_result="$(
      recovery_scale_process_local_freeze_parent_replicas_exact \
        "$CHECKPOINT_PROCESS_LOCAL_ROLLING_PARENT_CONTRACT" \
        "${DEPLOYMENT_RESOURCE_VERSIONS[$index]}" \
        "$(jq -er '.generation' \
          <<<"$CHECKPOINT_PROCESS_LOCAL_ROLLING_PARENT_CONTRACT")" 1 0
    )" || return 1
    local rolling_resource_version
    IFS=$'\t' read -r rolling_resource_version \
      rolling_generation <<<"$rolling_scale_result"
    DEPLOYMENT_RESOURCE_VERSIONS["$index"]="$rolling_resource_version"
  else
    DEPLOYMENT_RESOURCE_VERSIONS[index]="$(recovery_scale_deployment_exact \
      "${CONSUMERS[$index]}" "${DEPLOYMENT_UIDS[$index]}" \
      "${DEPLOYMENT_RESOURCE_VERSIONS[$index]}" "${ORIGINAL_REPLICAS[$index]}" 0 \
      "${DEPLOYMENT_SELECTORS[$index]}" "${DEPLOYMENT_FINGERPRINTS[$index]}")" || return 1
  fi
  recovery_wait_for_no_pods "app=${DEPLOYMENT_SELECTORS[$index]}" \
    "deployment/${CONSUMERS[$index]}" 180s || return 1
  if [[ "$CHECKPOINT_PROCESS_LOCAL_ROLLING" == 1 ]]; then
    rolling_zero_contract="$(
      recovery_capture_process_local_freeze_parent_boundary_exact zero \
        "$CHECKPOINT_PROCESS_LOCAL_ROLLING_PARENT_CONTRACT" \
        "$rolling_generation"
    )" || return 1
    DEPLOYMENT_RESOURCE_VERSIONS[index]="$(jq -er '.resource_version' \
      <<<"$rolling_zero_contract")" || return 1
  fi
  recovery_require_consumer_contract_entry "$RECOVERY_CONSUMER_CONTRACT_JSON" \
    "${CONSUMERS[$index]}" 0 || return 1
  if [[ "$CHECKPOINT_RUNNER_MODE" == kubernetes-pod ]]; then
    recovery_reconcile_durable_runner_namespace || return 1
    recovery_require_no_legacy_parent_runner_pods || return 1
  else
    recovery_delete_all_managed_bot_runner_pods_exact || return 1
    recovery_wait_for_no_managed_bot_runner_pods 180s || return 1
  fi
  start_runner_monitor
  require_checkpoint_runner_absence_stable || return 1

  for index in "${remaining_order[@]}"; do
    DEPLOYMENT_RESOURCE_VERSIONS[index]="$(recovery_scale_deployment_exact \
      "${CONSUMERS[$index]}" "${DEPLOYMENT_UIDS[$index]}" \
      "${DEPLOYMENT_RESOURCE_VERSIONS[$index]}" "${ORIGINAL_REPLICAS[$index]}" 0 \
      "${DEPLOYMENT_SELECTORS[$index]}" "${DEPLOYMENT_FINGERPRINTS[$index]}")" || return 1
  done
  for index in "${!CONSUMERS[@]}"; do
    recovery_require_operation_lock || return 1
    recovery_wait_for_no_pods "app=${DEPLOYMENT_SELECTORS[$index]}" \
      "deployment/${CONSUMERS[$index]}" 180s || return 1
    recovery_require_consumer_contract_entry "$RECOVERY_CONSUMER_CONTRACT_JSON" \
      "${CONSUMERS[$index]}" 0 || return 1
  done
  if [[ "$CHECKPOINT_RUNNER_MODE" == kubernetes-pod ]]; then
    require_checkpoint_runner_quiescent_now || return 1
  else
    recovery_require_no_managed_bot_runner_pods || return 1
  fi
  recovery_require_exact_pvc_consumers ret-pvc || return 1
  if [[ "$CHECKPOINT_RUNNER_MODE" == kubernetes-pod ]]; then
    [[ -n "$RUNNER_DURABLE_FENCE_INVENTORY" ]] || return 1
    [[ "$(recovery_capture_durable_quiescence)" == \
       "$RUNNER_DURABLE_FENCE_INVENTORY" ]] || return 1
    recovery_require_recovery_operation_fence_state dormant || return 1
    recovery_activate_recovery_operation_fence \
      CHECKPOINT_OPERATION_FENCE_ACTIVE_IDENTITY || return 1
    recovery_require_recovery_operation_fence_state active \
      "$CHECKPOINT_OPERATION_FENCE_ACTIVE_IDENTITY" || return 1
  fi
  if checkpoint_uses_freeze_admission_fence; then
    require_checkpoint_freeze_fence_zero_boundary || return 1
  else
    # This ready handshake is the linearization point for the joint snapshot
    # window. From here until its verified stop, LIST+watch coverage proves that
    # none of the five fixed consumers or their ReplicaSets/Pods can execute an
    # unobserved 0 -> 1 -> 0 writer excursion.
    start_checkpoint_writer_monitor || return 1
    require_checkpoint_writer_monitor_healthy || return 1
  fi
  if [[ "$CHECKPOINT_RUNNER_MODE" == kubernetes-pod ]]; then
    # The durable runner monitor pins the schema-3 writer baseline, which in
    # turn pins this exact active admission-fence identity.
    start_checkpoint_durable_monitor || return 1
    require_checkpoint_durable_monitor_healthy || return 1
  fi
}

prepare_runner_monitor_for_resume() {
  local index contract uid resource_version replicas selector fingerprint
  if [[ -n "$RUNNER_MONITOR_PID" ]]; then
    require_checkpoint_runner_quiescent_now
    return
  fi
  if [[ "$CHECKPOINT_RUNNER_MODE" == kubernetes-pod &&
        -n "$RUNNER_DURABLE_FENCE_INVENTORY" ]]; then
    require_checkpoint_runner_quiescent_now
    return
  fi

  # A scale may have reached the API server even when its postcondition read
  # failed before the normal watcher started. Reconstruct a safe monitored
  # boundary from the captured parent contract instead of making automatic
  # resume impossible solely because the watcher was not yet created.
  checkpoint_require_runner_mode_exact "$CHECKPOINT_RUNNER_MODE" \
    >/dev/null || return 1
  contract="$(recovery_capture_deployment_contract bot-orchestrator)" || return 1
  IFS=$'\t' read -r uid resource_version replicas selector fingerprint <<<"$contract"
  index=3
  [[ "$uid" == "${DEPLOYMENT_UIDS[$index]}" &&
     "$selector" == "${DEPLOYMENT_SELECTORS[$index]}" &&
     "$fingerprint" == "${DEPLOYMENT_FINGERPRINTS[$index]}" ]] || return 1
  if [[ "$replicas" == "${ORIGINAL_REPLICAS[$index]}" ]]; then
    # No checkpoint writer after the parent can have been scaled before the
    # watcher starts. If every captured writer is still at its original
    # resourceVersion and exact contract, there is no downtime mutation to
    # recover. A 0 -> original excursion necessarily advances resourceVersion
    # and therefore cannot masquerade as this pre-mutation case.
    for index in "${!CONSUMERS[@]}"; do
      contract="$(recovery_capture_deployment_contract \
        "${CONSUMERS[$index]}")" || return 1
      IFS=$'\t' read -r uid resource_version replicas selector fingerprint \
        <<<"$contract"
      [[ "$uid" == "${DEPLOYMENT_UIDS[$index]}" &&
         "$resource_version" == "${DEPLOYMENT_RESOURCE_VERSIONS[$index]}" &&
         "$replicas" == "${ORIGINAL_REPLICAS[$index]}" &&
         "$selector" == "${DEPLOYMENT_SELECTORS[$index]}" &&
         "$fingerprint" == "${DEPLOYMENT_FINGERPRINTS[$index]}" ]] || return 1
    done
    WRITERS_MUTATED=0
    return 0
  fi
  [[ "$replicas" == 0 ]] || {
    printf 'Bot parent replica state is unsafe for monitored checkpoint resume.\n' >&2
    return 1
  }
  recovery_require_consumer_contract_entry \
    "$RECOVERY_CONSUMER_CONTRACT_JSON" bot-orchestrator 0 || return 1
  if [[ "$CHECKPOINT_RUNNER_MODE" == kubernetes-pod ]]; then
    recovery_reconcile_durable_runner_namespace || return 1
  else
    recovery_delete_all_managed_bot_runner_pods_exact || return 1
    recovery_wait_for_no_managed_bot_runner_pods 180s || return 1
  fi
  start_runner_monitor || return 1
  require_checkpoint_runner_absence_stable || return 1
}

adopt_committed_bot_parent_resume_before_monitor() {
  local index=3 deployment contract uid resource_version replicas selector fingerprint
  local receipt_resource_version="" live_resource_version=""
  local rolling_ready_contract rolling_resume_generation
  local receipt_present=0
  BOT_PARENT_RESUME_ALREADY_COMMITTED=0
  deployment="${CONSUMERS[$index]}"

  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  contract="$(recovery_capture_deployment_contract "$deployment")" || return 1
  IFS=$'\t' read -r uid resource_version replicas selector fingerprint <<<"$contract"
  [[ "$uid" == "${DEPLOYMENT_UIDS[$index]}" &&
     "$selector" == "${DEPLOYMENT_SELECTORS[$index]}" &&
     "$fingerprint" == "${DEPLOYMENT_FINGERPRINTS[$index]}" ]] || return 1
  [[ "$replicas" == "${ORIGINAL_REPLICAS[$index]}" ]] || return 0

  # The parent is restored last. Its exact operation receipt therefore proves
  # that the controlled resume CAS was accepted only after the other four
  # writers and both runner guards had completed. Distinguish that committed
  # state from a genuinely untouched parent before rebuilding any quiescence
  # monitor: parent authority is already live and must not be treated as zero.
  if [[ "$CHECKPOINT_PROCESS_LOCAL_ROLLING" == 1 ]]; then
    # The dedicated RollingUpdate CAS is replica-only, so its in-process
    # resume capability plus the exact generation/full-spec/Ready boundary
    # replaces the legacy metadata receipt. No fresh shell may infer this.
    [[ "${DEPLOYMENT_RESUME_STARTED[$index]}" == 1 ]] || return 0
    rolling_resume_generation="$(jq -er '.generation + 2' \
      <<<"$CHECKPOINT_PROCESS_LOCAL_ROLLING_PARENT_CONTRACT")" || return 1
    rolling_ready_contract="$(
      recovery_capture_process_local_freeze_parent_boundary_exact ready-one \
        "$CHECKPOINT_PROCESS_LOCAL_ROLLING_PARENT_CONTRACT" \
        "$rolling_resume_generation"
    )" || return 1
    live_resource_version="$(jq -er '.resource_version' \
      <<<"$rolling_ready_contract")" || return 1
    receipt_present=0
  elif receipt_resource_version="$(
         recovery_capture_checkpoint_resume_receipt_contract \
           "$deployment" "$uid" "${ORIGINAL_REPLICAS[$index]}" \
           "$selector" "$fingerprint" "$RECOVERY_OPERATION_ID"
       )"; then
      receipt_present=1
  elif recovery_capture_checkpoint_resume_receipt_absent_contract \
         "$deployment" "$uid" "${ORIGINAL_REPLICAS[$index]}" \
         "$selector" "$fingerprint" >/dev/null; then
      # Absence normally means the parent was never resumed. It is also the
      # exact reconciled state after this same shell proved the receipt and its
      # cleanup CAS committed but its response (or the following assignment)
      # was interrupted. Only that in-memory capability permits adoption.
      [[ "${DEPLOYMENT_RESUME_STARTED[$index]}" == 1 ]] || return 0
      receipt_present=0
  else
    printf 'Bot parent has an unknown checkpoint resume receipt.\n' >&2
    return 1
  fi

  [[ -z "$RUNNER_MONITOR_PID" &&
     -z "$RUNNER_MONITOR_START_IDENTITY" ]] || {
    printf 'Bot parent resume receipt conflicts with an active runner guard.\n' >&2
    return 1
  }
  DEPLOYMENT_RESUME_STARTED[index]=1
  if [[ "$receipt_present" == 1 ]]; then
    DEPLOYMENT_RESOURCE_VERSIONS[index]="$receipt_resource_version"
  fi

  # Re-entry after a lost PATCH response is accepted only when every writer is
  # at its captured original contract and fully rolled out. Earlier writers
  # must already have had their receipts removed; only the last parent receipt
  # may remain as the durable ambiguity resolver.
  for index in "${!CONSUMERS[@]}"; do
    recovery_require_operation_serialization || return 1
    recovery_require_operation_lock || return 1
    recovery_require_deployment_contract "${CONSUMERS[$index]}" \
      "${DEPLOYMENT_UIDS[$index]}" "${ORIGINAL_REPLICAS[$index]}" \
      "${DEPLOYMENT_SELECTORS[$index]}" \
      "${DEPLOYMENT_FINGERPRINTS[$index]}" || return 1
    recovery_wait_for_deployment_rollout "${CONSUMERS[$index]}" 300 || return 1
    recovery_require_operation_serialization || return 1
    recovery_require_operation_lock || return 1
    if [[ "$index" == 3 ]]; then
      if [[ "$CHECKPOINT_PROCESS_LOCAL_ROLLING" == 1 ]]; then
        live_resource_version="$(jq -er '.resource_version' \
          <<<"$rolling_ready_contract")" || return 1
      elif [[ "$receipt_present" == 1 ]]; then
        live_resource_version="$(
          recovery_capture_checkpoint_resume_receipt_contract \
            "${CONSUMERS[$index]}" "${DEPLOYMENT_UIDS[$index]}" \
            "${ORIGINAL_REPLICAS[$index]}" "${DEPLOYMENT_SELECTORS[$index]}" \
            "${DEPLOYMENT_FINGERPRINTS[$index]}" "$RECOVERY_OPERATION_ID"
        )" || return 1
      else
        live_resource_version="$(
          recovery_capture_checkpoint_resume_receipt_absent_contract \
            "${CONSUMERS[$index]}" "${DEPLOYMENT_UIDS[$index]}" \
            "${ORIGINAL_REPLICAS[$index]}" "${DEPLOYMENT_SELECTORS[$index]}" \
            "${DEPLOYMENT_FINGERPRINTS[$index]}"
        )" || return 1
      fi
    else
      DEPLOYMENT_RESOURCE_VERSIONS[index]="$(
        recovery_capture_checkpoint_resume_receipt_absent_contract \
          "${CONSUMERS[$index]}" "${DEPLOYMENT_UIDS[$index]}" \
          "${ORIGINAL_REPLICAS[$index]}" "${DEPLOYMENT_SELECTORS[$index]}" \
          "${DEPLOYMENT_FINGERPRINTS[$index]}"
      )" || return 1
      DEPLOYMENT_RESUME_STARTED[index]=1
      DEPLOYMENT_RESUME_RECEIPT_CLEARED[index]=1
    fi
  done
  checkpoint_require_runner_mode_exact "$CHECKPOINT_RUNNER_MODE" \
    >/dev/null || return 1
  if [[ "$CHECKPOINT_PROCESS_LOCAL_ROLLING" == 1 ]]; then
    DEPLOYMENT_RESOURCE_VERSIONS[3]="$live_resource_version"
  elif [[ "$receipt_present" == 1 ]]; then
    DEPLOYMENT_RESOURCE_VERSIONS[3]="$(
      recovery_clear_checkpoint_resume_receipt \
        "${CONSUMERS[3]}" "${DEPLOYMENT_UIDS[3]}" "$live_resource_version" \
        "${ORIGINAL_REPLICAS[3]}" "${DEPLOYMENT_SELECTORS[3]}" \
        "${DEPLOYMENT_FINGERPRINTS[3]}" "$RECOVERY_OPERATION_ID"
    )" || return 1
  else
    DEPLOYMENT_RESOURCE_VERSIONS[3]="$live_resource_version"
  fi
  DEPLOYMENT_RESUME_RECEIPT_CLEARED[3]=1
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  if [[ "$CHECKPOINT_PROCESS_LOCAL_ROLLING" != 1 ]]; then
    recovery_capture_checkpoint_resume_receipt_absent_contract \
      "${CONSUMERS[3]}" "${DEPLOYMENT_UIDS[3]}" "${ORIGINAL_REPLICAS[3]}" \
      "${DEPLOYMENT_SELECTORS[3]}" "${DEPLOYMENT_FINGERPRINTS[3]}" \
      >/dev/null || return 1
  fi
  if [[ "$CHECKPOINT_RUNNER_MODE" == kubernetes-pod ]]; then
    [[ -n "$CHECKPOINT_OPERATION_FENCE_DORMANT_IDENTITY" ]] || return 1
    checkpoint_set_failure_context resume fence-continuity
    require_checkpoint_dormant_operation_fence_now || return 1
  fi
  BOT_PARENT_RESUME_ALREADY_COMMITTED=1
  WRITERS_MUTATED=0
}

require_checkpoint_zero_boundary() {
  local deployment
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  for deployment in "${CONSUMERS[@]}"; do
    recovery_require_consumer_contract_entry \
      "$RECOVERY_CONSUMER_CONTRACT_JSON" "$deployment" 0 || return 1
  done
  recovery_require_exact_pvc_consumers ret-pvc || return 1
  require_checkpoint_runner_quiescent_now
}

deactivate_checkpoint_operation_fence_before_resume() {
  if [[ "$CHECKPOINT_RUNNER_MODE" != kubernetes-pod ]]; then
    return 0
  fi
  if [[ -z "$CHECKPOINT_OPERATION_FENCE_ACTIVE_IDENTITY" ]]; then
    # Before activation, rollback is safe only while the immutable pair still
    # proves the original dormant state. Never manufacture an active identity.
    checkpoint_set_failure_context resume fence-continuity
    require_checkpoint_dormant_operation_fence_now
    return
  fi
  require_checkpoint_zero_boundary || return 1
  recovery_require_recovery_operation_fence_state active \
    "$CHECKPOINT_OPERATION_FENCE_ACTIVE_IDENTITY" || return 1
  recovery_deactivate_recovery_operation_fence \
    "$CHECKPOINT_OPERATION_FENCE_ACTIVE_IDENTITY" \
    CHECKPOINT_OPERATION_FENCE_DORMANT_IDENTITY || return 1
  recovery_require_recovery_operation_fence_state dormant \
    "$CHECKPOINT_OPERATION_FENCE_DORMANT_IDENTITY" || return 1
  # The active capability is cleared only after the full active -> dormant CAS,
  # both positive probes and the exact final identity read have succeeded.
  CHECKPOINT_OPERATION_FENCE_ACTIVE_IDENTITY=""
}

resume_writers() {
  local index deployment contract uid resource_version replicas selector fingerprint
  local rolling_scale_result rolling_ready_contract rolling_resume_generation
  local -a order=(1 2 0 4 3)
  checkpoint_set_failure_context resume preflight
  recovery_require_operation_lock || return 1
  # Classify mode drift before monitor reconstruction derives the runner
  # namespaces. A partial isolated-runner binding must retain the exact
  # semantic failure even when the synchronous guard and watcher race.
  checkpoint_require_runner_mode_exact "$CHECKPOINT_RUNNER_MODE" \
    >/dev/null || return 1
  checkpoint_set_failure_context resume adopt-parent
  adopt_committed_bot_parent_resume_before_monitor || return 1
  if [[ "$BOT_PARENT_RESUME_ALREADY_COMMITTED" == 1 ]]; then
    if [[ "$CHECKPOINT_RUNNER_MODE" == kubernetes-pod ]]; then
      [[ -n "$CHECKPOINT_OPERATION_FENCE_DORMANT_IDENTITY" ]] || return 1
      checkpoint_set_failure_context resume fence-continuity
      require_checkpoint_dormant_operation_fence_now || return 1
    fi
    return 0
  fi
  checkpoint_set_failure_context resume monitor-prepare
  prepare_runner_monitor_for_resume || return 1
  [[ "$WRITERS_MUTATED" == 1 ]] || return 0
  checkpoint_set_failure_context resume writer-precheck
  require_checkpoint_runner_quiescent_now || return 1
  checkpoint_require_runner_mode_exact "$CHECKPOINT_RUNNER_MODE" \
    >/dev/null || return 1
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  for index in "${!CONSUMERS[@]}"; do
    deployment="${CONSUMERS[$index]}"
    checkpoint_set_failure_context resume writer-contract
    contract="$(recovery_capture_deployment_contract "$deployment")" || return 1
    IFS=$'\t' read -r uid resource_version replicas selector fingerprint <<<"$contract"
    [[ "$uid" == "${DEPLOYMENT_UIDS[$index]}" &&
       "$selector" == "${DEPLOYMENT_SELECTORS[$index]}" &&
       "$fingerprint" == "${DEPLOYMENT_FINGERPRINTS[$index]}" ]] || return 1
    if [[ "$replicas" == 0 ]]; then
      if [[ "$CHECKPOINT_WRITER_MONITOR_VERIFIED_STOPPED" == 1 ]]; then
        [[ "$resource_version" == "${DEPLOYMENT_RESOURCE_VERSIONS[$index]}" ]] || {
          printf 'Writer changed after the terminal checkpoint boundary: %s.\n' \
            "$deployment" >&2
          return 1
        }
      elif [[ "$CHECKPOINT_WRITER_MONITOR_STARTED" == 0 ]]; then
        # Before a writer monitor exists, a quiesce PATCH may have committed
        # even when its response was lost. Under the still-exact Lease, lock
        # and immutable zero-replica contract, bind the live RV solely for
        # rollback. Once monitoring starts, only its terminal FINAL may rebind.
        recovery_require_operation_serialization || return 1
        recovery_require_operation_lock || return 1
        recovery_require_consumer_contract_entry \
          "$RECOVERY_CONSUMER_CONTRACT_JSON" "$deployment" 0 || return 1
        DEPLOYMENT_RESOURCE_VERSIONS[index]="$resource_version"
      fi
    elif [[ "$replicas" == "${ORIGINAL_REPLICAS[$index]}" ]]; then
      if [[ "${DEPLOYMENT_RESUME_STARTED[$index]}" != 1 ]]; then
        if [[ "$CHECKPOINT_WRITER_MONITOR_STARTED" == 0 &&
              "$CHECKPOINT_WRITER_MONITOR_VERIFIED_STOPPED" == 0 &&
              "$resource_version" == "${DEPLOYMENT_RESOURCE_VERSIONS[$index]}" ]] &&
           [[ "$(recovery_capture_checkpoint_resume_receipt_absent_contract \
                "$deployment" "$uid" "${ORIGINAL_REPLICAS[$index]}" \
                "$selector" "$fingerprint")" == "$resource_version" ]]; then
          # A partial scale-down failure can leave later writers genuinely
          # untouched. Before any writer monitor exists, unchanged initial RV
          # plus exact receipt absence proves this is not an external resume.
          DEPLOYMENT_RESUME_STARTED[index]=1
          DEPLOYMENT_RESUME_RECEIPT_CLEARED[index]=1
        else
          DEPLOYMENT_RESOURCE_VERSIONS[index]="$(
            recovery_capture_checkpoint_resume_receipt_contract \
              "$deployment" "$uid" "${ORIGINAL_REPLICAS[$index]}" \
              "$selector" "$fingerprint" "$RECOVERY_OPERATION_ID"
          )" || {
            printf 'Writer resumed outside the controlled checkpoint CAS: %s.\n' \
              "$deployment" >&2
            return 1
          }
          DEPLOYMENT_RESUME_STARTED[index]=1
        fi
      fi
    else
      printf 'Writer replica state is not recoverable under the captured contract: %s.\n' \
        "$deployment" >&2
      return 1
    fi
  done
  # The normal publication path stops the evidence window before removing the
  # incomplete marker. Recovery/reentry can still arrive here with an active
  # monitor, so make the verified stop idempotent. Any event, stream loss,
  # Lease loss or lock replacement retains the global lock and leaves every
  # writer paused.
  # The durable FINAL pins the writer schema-3 control baseline, so it must be
  # cleanly joined before the writer FINAL is requested. The admission fence
  # remains active across both joins.
  checkpoint_set_failure_context terminal-boundary durable-stop
  stop_checkpoint_durable_monitor_before_writer_monitor || return 1
  checkpoint_set_failure_context terminal-boundary writer-stop
  stop_checkpoint_writer_monitor_before_resume || return 1
  checkpoint_set_failure_context resume fence-deactivation
  deactivate_checkpoint_operation_fence_before_resume || return 1
  for index in "${order[@]}"; do
    deployment="${CONSUMERS[$index]}"
    checkpoint_set_failure_context resume writer-precheck
    if [[ "$deployment" == bot-orchestrator ]]; then
      # Re-check before any helper derives runner namespaces. The later gate
      # remains intentionally adjacent to restoring parent authority and
      # closes drift across the post-watch stable-absence window.
      checkpoint_require_runner_mode_exact "$CHECKPOINT_RUNNER_MODE" \
        >/dev/null || return 1
      require_checkpoint_runner_quiescent_now || return 1
      stop_runner_monitor_before_resume || return 1
      require_checkpoint_post_watch_absence_stable || return 1
      # This second exact Cloud gate is adjacent to restoring token-bearing
      # parent authority. It closes drift after the initial resume gate while
      # the other four consumers were restarted.
      checkpoint_require_runner_mode_exact "$CHECKPOINT_RUNNER_MODE" \
        >/dev/null || return 1
      recovery_require_operation_serialization || return 1
      recovery_require_operation_lock || return 1
      recovery_require_consumer_contract_entry \
        "$RECOVERY_CONSUMER_CONTRACT_JSON" bot-orchestrator 0 || return 1
      if [[ "$CHECKPOINT_RUNNER_MODE" == kubernetes-pod ]]; then
        recovery_capture_durable_quiescence >/dev/null || return 1
        recovery_require_no_legacy_parent_runner_pods || return 1
        checkpoint_set_failure_context resume fence-continuity
        require_checkpoint_dormant_operation_fence_now || return 1
      else
        recovery_require_no_managed_bot_runner_pods || return 1
      fi
    else
      require_checkpoint_runner_quiescent_now || return 1
    fi
    checkpoint_set_failure_context resume writer-contract
    contract="$(recovery_capture_deployment_contract "$deployment")" || return 1
    IFS=$'\t' read -r uid resource_version replicas selector fingerprint <<<"$contract"
    if [[ "$replicas" == 0 ]]; then
      [[ "$resource_version" == "${DEPLOYMENT_RESOURCE_VERSIONS[$index]}" ]] || {
        printf 'Writer changed after the terminal checkpoint watch boundary: %s.\n' \
          "$deployment" >&2
        return 1
      }
      checkpoint_set_failure_context resume writer-cas
      if [[ "$deployment" == bot-orchestrator &&
            "$CHECKPOINT_PROCESS_LOCAL_ROLLING" == 1 ]]; then
        rolling_resume_generation="$(jq -er '.generation + 1' \
          <<<"$CHECKPOINT_PROCESS_LOCAL_ROLLING_PARENT_CONTRACT")" || return 1
        rolling_scale_result="$(
          recovery_scale_process_local_freeze_parent_replicas_exact \
            "$CHECKPOINT_PROCESS_LOCAL_ROLLING_PARENT_CONTRACT" \
            "$resource_version" "$rolling_resume_generation" 0 1
        )" || return 1
        local rolling_resource_version
        IFS=$'\t' read -r rolling_resource_version \
          rolling_resume_generation <<<"$rolling_scale_result"
        DEPLOYMENT_RESOURCE_VERSIONS["$index"]="$rolling_resource_version"
      else
        DEPLOYMENT_RESOURCE_VERSIONS[index]="$(recovery_scale_deployment_exact \
          "$deployment" "$uid" "$resource_version" 0 "${ORIGINAL_REPLICAS[$index]}" \
          "$selector" "$fingerprint" "$RECOVERY_OPERATION_ID")" || return 1
      fi
      DEPLOYMENT_RESUME_STARTED[index]=1
      checkpoint_set_failure_context resume writer-rollout
      recovery_wait_for_deployment_rollout "$deployment" 300 || return 1
      if [[ "$deployment" == bot-orchestrator &&
            "$CHECKPOINT_PROCESS_LOCAL_ROLLING" == 1 ]]; then
        rolling_ready_contract="$(
          recovery_capture_process_local_freeze_parent_boundary_exact ready-one \
            "$CHECKPOINT_PROCESS_LOCAL_ROLLING_PARENT_CONTRACT" \
            "$rolling_resume_generation"
        )" || return 1
        DEPLOYMENT_RESOURCE_VERSIONS[index]="$(jq -er '.resource_version' \
          <<<"$rolling_ready_contract")" || return 1
      fi
    elif [[ "$replicas" == "${ORIGINAL_REPLICAS[$index]}" ]]; then
      [[ "${DEPLOYMENT_RESUME_STARTED[$index]}" == 1 ]] || {
        printf 'Writer resumed outside the controlled checkpoint CAS: %s.\n' \
          "$deployment" >&2
        return 1
      }
    else
      printf 'Writer replica state changed after the terminal checkpoint boundary: %s.\n' \
        "$deployment" >&2
      return 1
    fi
    # The same server-side annotation that resolves an ambiguous PATCH is
    # removed only after rollout. Status updates may have advanced the
    # resourceVersion, so recapture the exact receipt before its cleanup CAS.
    if [[ "$deployment" == bot-orchestrator &&
          "$CHECKPOINT_PROCESS_LOCAL_ROLLING" == 1 ]]; then
      DEPLOYMENT_RESUME_RECEIPT_CLEARED[index]=1
    elif [[ "${DEPLOYMENT_RESUME_RECEIPT_CLEARED[$index]}" != 1 ]]; then
      checkpoint_set_failure_context resume receipt
      if DEPLOYMENT_RESOURCE_VERSIONS[index]="$(
           recovery_capture_checkpoint_resume_receipt_contract \
             "$deployment" "$uid" "${ORIGINAL_REPLICAS[$index]}" \
             "$selector" "$fingerprint" "$RECOVERY_OPERATION_ID"
         )"; then
        DEPLOYMENT_RESOURCE_VERSIONS[index]="$(
          recovery_clear_checkpoint_resume_receipt \
            "$deployment" "$uid" "${DEPLOYMENT_RESOURCE_VERSIONS[$index]}" \
            "${ORIGINAL_REPLICAS[$index]}" "$selector" "$fingerprint" \
            "$RECOVERY_OPERATION_ID"
        )" || return 1
      elif [[ "${DEPLOYMENT_RESUME_STARTED[$index]}" == 1 ]]; then
        # A lost response after the cleanup CAS is reconciled only because this
        # same shell already proved or adopted the server-side resume receipt.
        DEPLOYMENT_RESOURCE_VERSIONS[index]="$(
          recovery_capture_checkpoint_resume_receipt_absent_contract \
            "$deployment" "$uid" "${ORIGINAL_REPLICAS[$index]}" \
            "$selector" "$fingerprint"
        )" || return 1
      else
        return 1
      fi
      DEPLOYMENT_RESUME_RECEIPT_CLEARED[index]=1
    fi
    checkpoint_set_failure_context resume operation-lock
    recovery_require_operation_lock || return 1
    checkpoint_set_failure_context resume writer-contract
    recovery_require_deployment_contract "$deployment" "${DEPLOYMENT_UIDS[$index]}" \
      "${ORIGINAL_REPLICAS[$index]}" "${DEPLOYMENT_SELECTORS[$index]}" \
      "${DEPLOYMENT_FINGERPRINTS[$index]}" || return 1
    if [[ "$CHECKPOINT_RUNNER_MODE" == kubernetes-pod ]]; then
      checkpoint_set_failure_context resume fence-continuity
      require_checkpoint_dormant_operation_fence_now || return 1
    fi
  done
  WRITERS_MUTATED=0
}

resume_writers_with_single_reentry() {
  local first_status=0
  if resume_writers; then
    return 0
  else
    first_status=$?
  fi
  # One bounded second pass resolves only durable ambiguous cuts (terminal
  # monitor JOINED state, scale-down RV rebinding or exact resume receipts).
  # Unsafe drift remains unchanged and fails again with the global lock held.
  if resume_writers; then
    return 0
  fi
  return "$first_status"
}

release_lock_if_safe() {
  [[ "$OPERATION_LOCK_OWNED" == 1 ]] || return 0
  [[ "$CHECKPOINT_FREEZE_FENCE_ACTIVE" == 0 &&
     -z "$RECOVERY_FREEZE_CHECKPOINT_FENCE_CAPABILITY" &&
     -z "$RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_UID" &&
     -z "$RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_UID" &&
     "$RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_CREATE_ATTEMPTED" == 0 &&
     "$RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_CREATE_ATTEMPTED" == 0 ]] || return 1
  recovery_require_operation_serialization || return 1
  if [[ "$CHECKPOINT_RUNNER_MODE" == kubernetes-pod ]]; then
    checkpoint_set_failure_context lock-release fence-continuity
    require_checkpoint_dormant_operation_fence_now || return 1
  fi
  checkpoint_set_failure_context lock-release operation-lock
  recovery_release_operation_lock || return 1
  OPERATION_LOCK_OWNED=0
  CHECKPOINT_OPERATION_FENCE_DORMANT_IDENTITY=""
}

acquire_checkpoint_publish_lock() {
  local acquisition_status=0
  # The child ignores a cooperative signal across mkdir while the parent
  # records it for delivery after the ownership flag is armed.
  CHECKPOINT_PENDING_SIGNAL_STATUS=0
  trap 'checkpoint_record_pending_signal 130' INT
  trap 'checkpoint_record_pending_signal 143' TERM
  if (trap '' INT TERM; mkdir "$PUBLISH_LOCK"); then
    PUBLISH_LOCK_OWNED=1
    (trap '' INT TERM; chmod 700 "$PUBLISH_LOCK") || acquisition_status=1
  else
    acquisition_status=1
  fi
  if ! finish_checkpoint_local_capability_boundary "$acquisition_status"; then
    acquisition_status=1
  fi
  if [[ "$acquisition_status" != 0 ]]; then
    printf 'Another checkpoint publication owns this exact destination.\n' >&2
    return 1
  fi
}

acquire_checkpoint_staging_directory() {
  local acquisition_status=0
  # The mktemp/capture children ignore a cooperative signal while the parent
  # records it until the token, marker and ownership latch are complete.
  CHECKPOINT_PENDING_SIGNAL_STATUS=0
  trap 'checkpoint_record_pending_signal 130' INT
  trap 'checkpoint_record_pending_signal 143' TERM
  if OUTPUT_DIR="$(
       trap '' INT TERM
       mktemp -d "$OUTPUT_PARENT/.yenhubs-checkpoint-$TIMESTAMP.XXXXXX"
     )"; then
    CHECKPOINT_STAGING_OWNED=1
    OUTPUT_DIR_SETUP_FAILED=1
    CHECKPOINT_STAGING_MARKER="$OUTPUT_DIR/.yenhubs-staging-owner"
    if ! OUTPUT_DIR_PRIVATE_TOKEN="$(
        trap '' INT TERM
        recovery_capture_private_directory_token "$OUTPUT_DIR"
      )" ||
       ! (trap '' INT TERM; umask 077; set -C; printf '%s\n' \
         yenhubs-checkpoint-staging-v1 \
         >"$CHECKPOINT_STAGING_MARKER") 2>/dev/null; then
      acquisition_status=1
    else
      OUTPUT_DIR_CLEANUP_ATTEMPTED=0
      OUTPUT_DIR_RETIRED=0
      OUTPUT_DIR_SETUP_FAILED=0
    fi
  else
    acquisition_status=1
  fi
  if ! finish_checkpoint_local_capability_boundary "$acquisition_status"; then
    acquisition_status=1
  fi
  if [[ "$acquisition_status" != 0 ]]; then
    printf 'Could not create the private checkpoint staging directory.\n' >&2
    return 1
  fi
}

acquire_checkpoint_serialization_lease() {
  local acquisition_status=0 pending_signal_status=0
  # Bind the successful remote acquisition to the local cleanup capability.
  # The Lease itself is finite-lived. Record cooperative interruption while
  # the helper either acquires exact ownership or fails closed, then bind its
  # successful return to the local cleanup capability before honoring it.
  CHECKPOINT_PENDING_SIGNAL_STATUS=0
  trap 'checkpoint_record_pending_signal 130' INT
  trap 'checkpoint_record_pending_signal 143' TERM
  if recovery_acquire_operation_serialization root-recovery; then
    SERIALIZATION_LEASE_OWNED=1
  else
    acquisition_status=$?
  fi
  restore_checkpoint_signal_traps
  pending_signal_status="$CHECKPOINT_PENDING_SIGNAL_STATUS"
  CHECKPOINT_PENDING_SIGNAL_STATUS=0
  if [[ "$pending_signal_status" != 0 ]]; then
    checkpoint_interrupted "$pending_signal_status"
  fi
  [[ "$acquisition_status" == 0 ]]
}

acquire_checkpoint_operation_lock() {
  local acquisition_status=0 pending_signal_status=0
  # recovery_acquire_operation_lock reconciles an ambiguous API response by
  # exact private token+operation identity. Record INT/TERM while that bounded
  # reconciliation runs, arm cleanup ownership on exact adoption, then honor
  # the pending signal.
  CHECKPOINT_PENDING_SIGNAL_STATUS=0
  trap 'checkpoint_record_pending_signal 130' INT
  trap 'checkpoint_record_pending_signal 143' TERM
  if recovery_acquire_operation_lock \
      checkpoint-backup yenhubs-recovery-operation-lock; then
    OPERATION_LOCK_OWNED=1
  else
    acquisition_status=$?
  fi
  restore_checkpoint_signal_traps
  pending_signal_status="$CHECKPOINT_PENDING_SIGNAL_STATUS"
  CHECKPOINT_PENDING_SIGNAL_STATUS=0
  if [[ "$pending_signal_status" != 0 ]]; then
    checkpoint_interrupted "$pending_signal_status"
  fi
  [[ "$acquisition_status" == 0 ]]
}

checkpoint_error() {
  local status="$?" failure_stage="$CHECKPOINT_FAILURE_STAGE"
  local failure_code="$CHECKPOINT_FAILURE_CODE"
  # errtrace also copies ERR into command substitutions and background
  # subshells. Those processes have only stale copies of ownership variables;
  # they must report failure to the main shell, never resume writers or delete
  # a shared lock on its behalf.
  if ((BASH_SUBSHELL > 0)); then
    return "$status"
  fi
  trap - ERR
  checkpoint_report_timing failure
  if ! checkpoint_failure_context_is_safe "$failure_stage" "$failure_code"; then
    failure_stage=pre-publication
    failure_code=unclassified
  fi
  printf 'Checkpoint failure: stage=%s code=%s status=%s.\n' \
    "$failure_stage" "$failure_code" "$status" >&2 || :
  if [[ "$WRITERS_MUTATED" == 1 ]]; then
    if resume_writers_with_single_reentry; then
      printf 'Checkpoint failed, but every writer was restored to its exact pre-snapshot scale.\n' >&2
    else
      printf 'Checkpoint failed and exact automatic resume was impossible; the global lock is retained.\n' >&2
      return "$status"
    fi
  fi
  if [[ -n "$RECOVERY_FREEZE_CHECKPOINT_FENCE_CAPABILITY" ||
        -n "$RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_UID" ||
        -n "$RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_UID" ||
        "$RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_CREATE_ATTEMPTED" == 1 ||
        "$RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_CREATE_ATTEMPTED" == 1 ]]; then
    if ! recovery_cleanup_partial_freeze_checkpoint_fence; then
      CHECKPOINT_FREEZE_FENCE_CLEANUP_FAILED=1
      printf 'Checkpoint admission fence could not be removed safely; lock and Lease are retained.\n' >&2
      return "$status"
    fi
    RECOVERY_FREEZE_CHECKPOINT_FENCE_CAPABILITY=""
    CHECKPOINT_FREEZE_FENCE_ACTIVE=0
  fi
  if [[ "$OPERATION_LOCK_OWNED" == 1 ]] && ! release_lock_if_safe; then
    printf 'Checkpoint operation lock could not be released safely.\n' >&2
  fi
  return "$status"
}

checkpoint_interrupted() {
  local status="$1" fence_status=0
  CHECKPOINT_INTERRUPT_IN_PROGRESS=1
  checkpoint_report_timing interrupted
  trap - EXIT ERR
  trap '' INT TERM
  if [[ "$WRITERS_MUTATED" == 1 ]]; then
    resume_writers_with_single_reentry || \
      printf 'Interrupted checkpoint retained its lock for manual recovery.\n' >&2
  fi
  if [[ -n "$RECOVERY_FREEZE_CHECKPOINT_FENCE_CAPABILITY" ||
        -n "$RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_UID" ||
        -n "$RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_UID" ||
        "$RECOVERY_FREEZE_CHECKPOINT_FENCE_POLICY_CREATE_ATTEMPTED" == 1 ||
        "$RECOVERY_FREEZE_CHECKPOINT_FENCE_BINDING_CREATE_ATTEMPTED" == 1 ]] &&
     ! recovery_cleanup_partial_freeze_checkpoint_fence; then
    CHECKPOINT_FREEZE_FENCE_CLEANUP_FAILED=1
    fence_status=1
  else
    RECOVERY_FREEZE_CHECKPOINT_FENCE_CAPABILITY=""
    CHECKPOINT_FREEZE_FENCE_ACTIVE=0
  fi
  if [[ "$WRITERS_MUTATED" == 0 && "$OPERATION_LOCK_OWNED" == 1 &&
        "$fence_status" == 0 ]]; then
    release_lock_if_safe || :
  fi
  cleanup_local_artifacts
  exit "$status"
}

trap cleanup_local_artifacts EXIT
trap checkpoint_error ERR
trap 'checkpoint_interrupted 130' INT
trap 'checkpoint_interrupted 143' TERM

acquire_checkpoint_publish_lock
acquire_checkpoint_staging_directory

# Bind the local authorization input once. The source may be prepared for a
# future rotation while the checkpoint runs, but every gate in this operation
# must keep using the same private bytes selected before any downtime.
snapshot_checkpoint_private_file \
  CHECKPOINT_VALUES_SNAPSHOT "$VALUES_INPUT_FILE" values
VALUES_SOURCE_FILE="$CHECKPOINT_VALUES_SNAPSHOT"
command node "$SCRIPT_DIR/parse-local-values.mjs" "$VALUES_SOURCE_FILE" --validate

# Determine the expected generation from the already snapshotted VALUES bytes.
# A durable invocation must then bind both remaining inputs before the first
# Kubernetes read, including failure paths for a missing key.
checkpoint_runner_expected="$(
  checkpoint_runner_mode_from_values "$VALUES_SOURCE_FILE"
)"
if [[ "$CHECKPOINT_FORMAT" == freeze-bundle-v1 &&
      "$checkpoint_runner_expected" == process-local ]]; then
  CHECKPOINT_PROCESS_LOCAL_STRATEGY_SCOPE=freeze-checkpoint
fi
if [[ "$checkpoint_runner_expected" == kubernetes-pod ]]; then
  [[ -n "$CUTOVER_KEY_INPUT_FILE" ]] || {
    printf 'PROCESS_LOCAL_CUTOVER_KEY_PATH is required for a durable checkpoint.\n' >&2
    exit 1
  }
  snapshot_checkpoint_private_file \
    CHECKPOINT_MANIFEST_SNAPSHOT "$MANIFEST_INPUT_FILE" manifest
  snapshot_checkpoint_private_file \
    CHECKPOINT_CUTOVER_KEY_SNAPSHOT "$CUTOVER_KEY_INPUT_FILE" cutover-key
  HCCE_MANIFEST_PATH="$CHECKPOINT_MANIFEST_SNAPSHOT"
  PROCESS_LOCAL_CUTOVER_KEY_PATH="$CHECKPOINT_CUTOVER_KEY_SNAPSHOT"
  export PROCESS_LOCAL_CUTOVER_KEY_PATH
fi

recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
# Classify the live boundary after all locally available inputs are immutable,
# but still before the Lease or operation lock can mutate Kubernetes.
CHECKPOINT_RUNNER_MODE="$(
  recovery_require_checkpoint_runner_mode_exact \
    "$VALUES_SOURCE_FILE" "$checkpoint_runner_expected" \
    "$CHECKPOINT_PROCESS_LOCAL_STRATEGY_SCOPE"
)"
[[ "$CHECKPOINT_RUNNER_MODE" == "$checkpoint_runner_expected" ]] || {
  printf 'Checkpoint runner mode changed while binding immutable local inputs.\n' >&2
  exit 1
}
if [[ "$CHECKPOINT_FORMAT" == freeze-bundle-v1 ]]; then
  [[ "$CHECKPOINT_RUNNER_MODE" == process-local ]] || {
    printf 'freeze-bundle-v1 is limited to the accepted process-local baseline.\n' >&2
    exit 1
  }
  [[ "${CLIENT_INSTANCE_ID:-}" =~ ^[a-z0-9][a-z0-9-]{2,62}$ ]] || {
    printf 'CLIENT_INSTANCE_ID must be one stable lowercase client identifier.\n' >&2
    exit 1
  }
  freeze_cluster_anchor="$(recovery_kubectl get namespace kube-system -o json)" || {
    printf 'Could not capture the source cluster anchor UID.\n' >&2
    exit 1
  }
  FREEZE_SOURCE_CLUSTER_UID="$(jq -er '
    select(.apiVersion == "v1" and .kind == "Namespace" and
      .metadata.name == "kube-system") |
    .metadata.uid | select(type == "string" and length > 0)
  ' <<<"$freeze_cluster_anchor")" || {
    printf 'Source cluster anchor UID is missing or malformed.\n' >&2
    exit 1
  }
  CHECKPOINT_PROCESS_LOCAL_PARENT_PRELOCK_CONTRACT="$(
    recovery_capture_process_local_freeze_parent_contract_exact
  )" || exit 1
  checkpoint_parent_strategy="$(jq -er '.spec.strategy.type' \
    <<<"$CHECKPOINT_PROCESS_LOCAL_PARENT_PRELOCK_CONTRACT")" || exit 1
  if [[ "$checkpoint_parent_strategy" == RollingUpdate ]]; then
    CHECKPOINT_PROCESS_LOCAL_ROLLING=1
    CHECKPOINT_PROCESS_LOCAL_ROLLING_PRELOCK_CONTRACT="$(
      recovery_capture_process_local_freeze_parent_boundary_exact ready-one
    )" || exit 1
    [[ "$(jq -c '{uid,resource_version,generation,spec}' \
          <<<"$CHECKPOINT_PROCESS_LOCAL_ROLLING_PRELOCK_CONTRACT")" == \
       "$(jq -c '{uid,resource_version,generation,spec}' \
          <<<"$CHECKPOINT_PROCESS_LOCAL_PARENT_PRELOCK_CONTRACT")" ]] || {
      printf 'RollingUpdate parent changed during pre-lock boundary capture.\n' >&2
      exit 1
    }
  fi
fi
RECOVERY_CHECKPOINT_STAMP="$TIMESTAMP"
RECOVERY_DUMP_SHA256="$(printf '0%.0s' {1..64})"
RECOVERY_STORAGE_SHA256="$RECOVERY_DUMP_SHA256"
acquire_checkpoint_serialization_lease
recovery_require_operation_serialization
recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
acquire_checkpoint_operation_lock
recovery_require_operation_serialization
# Coordinated backup children revalidate these exported bindings against the
# immutable lock. They are data-only identifiers, not local cleanup
# capabilities; materialized paths are never inherited.
export RECOVERY_CHECKPOINT_STAMP RECOVERY_DUMP_SHA256 RECOVERY_STORAGE_SHA256 \
  RECOVERY_NAMESPACE_UID RECOVERY_PVC_UID
capture_consumer_contracts
if [[ -n "$CHECKPOINT_PROCESS_LOCAL_PARENT_PRELOCK_CONTRACT" ]]; then
  recovery_capture_process_local_freeze_parent_contract_exact \
    "$CHECKPOINT_PROCESS_LOCAL_PARENT_PRELOCK_CONTRACT" >/dev/null || exit 1
  [[ "${DEPLOYMENT_UIDS[3]}" == \
       "$(jq -er '.uid' \
         <<<"$CHECKPOINT_PROCESS_LOCAL_PARENT_PRELOCK_CONTRACT")" &&
     "${DEPLOYMENT_RESOURCE_VERSIONS[3]}" == \
       "$(jq -er '.resource_version' \
         <<<"$CHECKPOINT_PROCESS_LOCAL_PARENT_PRELOCK_CONTRACT")" ]] || {
    printf 'Bot parent changed between the pre-lock and consumer contracts.\n' >&2
    exit 1
  }
fi
if [[ "$CHECKPOINT_PROCESS_LOCAL_ROLLING" == 1 ]]; then
  CHECKPOINT_PROCESS_LOCAL_ROLLING_PARENT_CONTRACT="$(
    recovery_capture_process_local_freeze_parent_boundary_exact ready-one \
      "$CHECKPOINT_PROCESS_LOCAL_ROLLING_PRELOCK_CONTRACT" \
      "$(jq -er '.generation' \
        <<<"$CHECKPOINT_PROCESS_LOCAL_ROLLING_PRELOCK_CONTRACT")"
  )" || exit 1
  [[ "$(jq -er '.resource_version' \
        <<<"$CHECKPOINT_PROCESS_LOCAL_ROLLING_PARENT_CONTRACT")" == \
       "$(jq -er '.resource_version' \
        <<<"$CHECKPOINT_PROCESS_LOCAL_ROLLING_PRELOCK_CONTRACT")" &&
     "${DEPLOYMENT_UIDS[3]}" == \
       "$(jq -er '.uid' \
        <<<"$CHECKPOINT_PROCESS_LOCAL_ROLLING_PARENT_CONTRACT")" &&
     "${DEPLOYMENT_RESOURCE_VERSIONS[3]}" == \
       "$(jq -er '.resource_version' \
        <<<"$CHECKPOINT_PROCESS_LOCAL_ROLLING_PARENT_CONTRACT")" ]] || {
    printf 'RollingUpdate parent changed between preflight and the locked checkpoint contract.\n' >&2
    exit 1
  }
fi

recovery_require_operation_serialization
recovery_require_operation_lock
recovery_stable_absence_seconds >/dev/null
if [[ "$CHECKPOINT_RUNNER_MODE" == kubernetes-pod ]]; then
  recovery_require_recovery_operation_fence_state dormant
fi

# Capture the exact live image/infrastructure inventory while the deployments
# still have their pre-downtime scale, then prove those immutable contracts
# again as each writer is stopped.
env VALUES_FILE="$VALUES_SOURCE_FILE" CAPTURE_STATE_FORMAT="$CHECKPOINT_FORMAT" \
  CHECKPOINT_FORMAT="$CHECKPOINT_FORMAT" \
  RECOVERY_CHECKPOINT_CAPTURE_RUNNER_MODE="$CHECKPOINT_RUNNER_MODE" \
  "$SCRIPT_DIR/capture-instance-state.sh" "$OUTPUT_DIR"
captured_runner_mode="$(jq -er '.bot_runner_runtime.mode' \
  "$OUTPUT_DIR/deployment-images.json")"
CHECKPOINT_RUNNER_GENERATION="$(jq -er '
  select(.schema_version == 4) |
  .bot_runner_runtime.generation |
  select(. == "legacy-absent" or . == "durable-v2")
' "$OUTPUT_DIR/deployment-images.json")"
[[ "$captured_runner_mode" == "$CHECKPOINT_RUNNER_MODE" ]] || {
  printf 'Captured runner mode does not match the pre-downtime authorization.\n' >&2
  exit 1
}

if checkpoint_uses_freeze_admission_fence; then
  checkpoint_set_failure_context quiescence fence-create
  establish_checkpoint_freeze_fence
  checkpoint_set_failure_context quiescence fence-probe
  recovery_probe_freeze_checkpoint_fence \
    "$RECOVERY_FREEZE_CHECKPOINT_FENCE_CAPABILITY"
fi

QUIESCE_STARTED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
if [[ "$CHECKPOINT_FORMAT" == legacy ]]; then
  jq -n \
    --arg stamp "$TIMESTAMP" \
    --arg created_at_utc "$QUIESCE_STARTED_AT" \
    --argjson created_at_epoch "$(date -u '+%s')" \
    --arg kube_context "$EXPECTED_KUBE_CONTEXT" \
    --arg namespace "$NAMESPACE" \
    --arg namespace_uid "$RECOVERY_NAMESPACE_UID" \
    --arg pvc_uid "$RECOVERY_PVC_UID" \
    --arg operation_id "$RECOVERY_OPERATION_ID" \
    --arg runtime_generation "$CHECKPOINT_RUNNER_GENERATION" \
    --arg evidence_sha256 "$(printf '0%.0s' {1..64})" '
    {
      schema_version:3,
      provenance:{generator:"yenhubs-local-coordinated-checkpoint-v3",external_import:false},
      stamp:$stamp,created_at_utc:$created_at_utc,created_at_epoch:$created_at_epoch,
      kube_context:$kube_context,namespace:$namespace,namespace_uid:$namespace_uid,
      ret_pvc_uid:$pvc_uid,operation_id:$operation_id,
      runtime_generation:$runtime_generation,
      runner_cutover_evidence_sha256:$evidence_sha256,
      writer_quiescence:{required:true,started_at_utc:$created_at_utc}
    }' >"$OUTPUT_DIR/checkpoint-metadata.json"
  chmod 600 "$OUTPUT_DIR/checkpoint-metadata.json"
fi

checkpoint_set_failure_context quiescence writers
quiesce_writers
checkpoint_set_failure_context quiescence serialization
recovery_require_operation_serialization
checkpoint_set_failure_context quiescence monitor-health
require_checkpoint_monitors_healthy
evidence_manifest=""
evidence_fence_state=dormant
if [[ "$CHECKPOINT_RUNNER_GENERATION" == durable-v2 ]]; then
  evidence_manifest="$CHECKPOINT_MANIFEST_SNAPSHOT"
  evidence_fence_state=active
fi
if [[ "$CHECKPOINT_FORMAT" == legacy ]]; then
  checkpoint_set_failure_context quiescence evidence-capture
  recovery_capture_runner_cutover_evidence \
    "$VALUES_SOURCE_FILE" "$OUTPUT_DIR/runner-cutover-evidence.json" \
    "$OUTPUT_DIR/deployment-images.json" "$evidence_fence_state" \
    "$evidence_manifest"
  checkpoint_set_failure_context quiescence evidence-contract
  [[ "$(jq -er '.runtime_generation' "$OUTPUT_DIR/runner-cutover-evidence.json")" == \
     "$CHECKPOINT_RUNNER_GENERATION" ]]
  EVIDENCE_SHA256="$(recovery_sha256_digest \
    "$OUTPUT_DIR/runner-cutover-evidence.json")"
  checkpoint_set_failure_context quiescence evidence-metadata
  metadata_tmp="$OUTPUT_DIR/.checkpoint-metadata.next"
  [[ ! -e "$metadata_tmp" && ! -L "$metadata_tmp" ]]
  (umask 077; set -C; jq --arg digest "$EVIDENCE_SHA256" \
    '.runner_cutover_evidence_sha256 = $digest' \
    "$OUTPUT_DIR/checkpoint-metadata.json" >"$metadata_tmp") 2>/dev/null
  mv "$metadata_tmp" "$OUTPUT_DIR/checkpoint-metadata.json"
  chmod 600 "$OUTPUT_DIR/checkpoint-metadata.json"
  checkpoint_set_failure_context quiescence evidence-live
  recovery_verify_runner_cutover_evidence_live \
    "$VALUES_SOURCE_FILE" "$OUTPUT_DIR/runner-cutover-evidence.json" \
    "$OUTPUT_DIR/deployment-images.json" "$evidence_fence_state" \
    "$evidence_manifest" checkpoint
fi
checkpoint_set_failure_context quiescence monitor-health
require_checkpoint_monitors_healthy
checkpoint_durable_control_baseline_path=""
checkpoint_durable_control_baseline_sha256=""
if [[ "$CHECKPOINT_RUNNER_GENERATION" == durable-v2 ]]; then
  checkpoint_durable_control_baseline_path="$CHECKPOINT_WRITER_MONITOR_BASELINE"
  checkpoint_durable_control_baseline_sha256="$CHECKPOINT_WRITER_MONITOR_BASELINE_SHA256"
fi
checkpoint_set_failure_context database-backup stream
BACKUP_COORDINATED=1 \
CHECKPOINT_RUNNER_GENERATION="$CHECKPOINT_RUNNER_GENERATION" \
CHECKPOINT_DURABLE_FENCE_BASELINE_PATH="$RUNNER_DURABLE_FENCE_BASELINE_PATH" \
CHECKPOINT_DURABLE_FENCE_BASELINE_SHA256="$RUNNER_DURABLE_FENCE_BASELINE_SHA256" \
YENHUBS_PARENT_RECOVERY_OPERATION_FENCE_ACTIVE_IDENTITY="$CHECKPOINT_OPERATION_FENCE_ACTIVE_IDENTITY" \
YENHUBS_PARENT_LEASE_HOLDER="$RECOVERY_SERIALIZATION_LEASE_HOLDER" \
YENHUBS_PARENT_LEASE_UID="$RECOVERY_SERIALIZATION_LEASE_UID" \
YENHUBS_PARENT_PROCESS_PID="$RECOVERY_SERIALIZATION_PARENT_PID" \
YENHUBS_PARENT_PROCESS_START_IDENTITY="$RECOVERY_SERIALIZATION_PARENT_START_IDENTITY" \
YENHUBS_PARENT_FREEZE_FENCE_CAPABILITY="$RECOVERY_FREEZE_CHECKPOINT_FENCE_CAPABILITY" \
YENHUBS_PARENT_WRITER_MONITOR_CONTRACT_PATH="$CHECKPOINT_WRITER_MONITOR_CONTRACT" \
YENHUBS_PARENT_WRITER_MONITOR_CONTRACT_SHA256="$CHECKPOINT_WRITER_MONITOR_CONTRACT_SHA256" \
YENHUBS_PARENT_WRITER_MONITOR_BASELINE_PATH="$CHECKPOINT_WRITER_MONITOR_BASELINE" \
YENHUBS_PARENT_WRITER_MONITOR_BASELINE_SHA256="$CHECKPOINT_WRITER_MONITOR_BASELINE_SHA256" \
YENHUBS_PARENT_WRITER_MONITOR_PID="$CHECKPOINT_WRITER_MONITOR_PID" \
YENHUBS_PARENT_WRITER_MONITOR_START_IDENTITY="$CHECKPOINT_WRITER_MONITOR_START_IDENTITY" \
YENHUBS_PARENT_WRITER_MONITOR_FAILURE_PATH="$CHECKPOINT_WRITER_MONITOR_FAILURE" \
YENHUBS_PARENT_WRITER_MONITOR_READY_PATH="$CHECKPOINT_WRITER_MONITOR_READY" \
YENHUBS_PARENT_WRITER_MONITOR_PROGRESS_PATH="$CHECKPOINT_WRITER_MONITOR_PROGRESS" \
YENHUBS_PARENT_WRITER_MONITOR_AUTHORITY_SHA256="$CHECKPOINT_WRITER_MONITOR_AUTHORITY_SHA256" \
YENHUBS_PARENT_DURABLE_MONITOR_CONTROL_BASELINE_PATH="$checkpoint_durable_control_baseline_path" \
YENHUBS_PARENT_DURABLE_MONITOR_CONTROL_BASELINE_SHA256="$checkpoint_durable_control_baseline_sha256" \
YENHUBS_PARENT_DURABLE_MONITOR_PID="$CHECKPOINT_DURABLE_MONITOR_PID" \
YENHUBS_PARENT_DURABLE_MONITOR_START_IDENTITY="$CHECKPOINT_DURABLE_MONITOR_START_IDENTITY" \
YENHUBS_PARENT_DURABLE_MONITOR_FAILURE_PATH="$CHECKPOINT_DURABLE_MONITOR_FAILURE" \
YENHUBS_PARENT_DURABLE_MONITOR_READY_PATH="$CHECKPOINT_DURABLE_MONITOR_READY" \
YENHUBS_PARENT_DURABLE_MONITOR_PROGRESS_PATH="$CHECKPOINT_DURABLE_MONITOR_PROGRESS" \
YENHUBS_PARENT_DURABLE_MONITOR_CAPABILITY_SHA256="$CHECKPOINT_DURABLE_MONITOR_CAPABILITY_SHA256" \
YENHUBS_PARENT_DURABLE_MONITOR_AUTHORITY_SHA256="$CHECKPOINT_DURABLE_MONITOR_AUTHORITY_SHA256" \
  "$SCRIPT_DIR/backup-retdb.sh" \
  "$OUTPUT_DIR/retdb-$TIMESTAMP.sql.gz"
checkpoint_set_failure_context database-backup serialization
recovery_require_operation_serialization
checkpoint_set_failure_context database-backup monitor-health
require_checkpoint_monitors_healthy
checkpoint_set_failure_context storage-backup stream
CHECKPOINT_RUNNER_GENERATION="$CHECKPOINT_RUNNER_GENERATION" \
CHECKPOINT_DURABLE_FENCE_BASELINE_PATH="$RUNNER_DURABLE_FENCE_BASELINE_PATH" \
CHECKPOINT_DURABLE_FENCE_BASELINE_SHA256="$RUNNER_DURABLE_FENCE_BASELINE_SHA256" \
YENHUBS_PARENT_RECOVERY_OPERATION_FENCE_ACTIVE_IDENTITY="$CHECKPOINT_OPERATION_FENCE_ACTIVE_IDENTITY" \
YENHUBS_PARENT_LEASE_HOLDER="$RECOVERY_SERIALIZATION_LEASE_HOLDER" \
YENHUBS_PARENT_LEASE_UID="$RECOVERY_SERIALIZATION_LEASE_UID" \
YENHUBS_PARENT_PROCESS_PID="$RECOVERY_SERIALIZATION_PARENT_PID" \
YENHUBS_PARENT_PROCESS_START_IDENTITY="$RECOVERY_SERIALIZATION_PARENT_START_IDENTITY" \
YENHUBS_PARENT_FREEZE_FENCE_CAPABILITY="$RECOVERY_FREEZE_CHECKPOINT_FENCE_CAPABILITY" \
YENHUBS_PARENT_WRITER_MONITOR_CONTRACT_PATH="$CHECKPOINT_WRITER_MONITOR_CONTRACT" \
YENHUBS_PARENT_WRITER_MONITOR_CONTRACT_SHA256="$CHECKPOINT_WRITER_MONITOR_CONTRACT_SHA256" \
YENHUBS_PARENT_WRITER_MONITOR_BASELINE_PATH="$CHECKPOINT_WRITER_MONITOR_BASELINE" \
YENHUBS_PARENT_WRITER_MONITOR_BASELINE_SHA256="$CHECKPOINT_WRITER_MONITOR_BASELINE_SHA256" \
YENHUBS_PARENT_WRITER_MONITOR_PID="$CHECKPOINT_WRITER_MONITOR_PID" \
YENHUBS_PARENT_WRITER_MONITOR_START_IDENTITY="$CHECKPOINT_WRITER_MONITOR_START_IDENTITY" \
YENHUBS_PARENT_WRITER_MONITOR_FAILURE_PATH="$CHECKPOINT_WRITER_MONITOR_FAILURE" \
YENHUBS_PARENT_WRITER_MONITOR_READY_PATH="$CHECKPOINT_WRITER_MONITOR_READY" \
YENHUBS_PARENT_WRITER_MONITOR_PROGRESS_PATH="$CHECKPOINT_WRITER_MONITOR_PROGRESS" \
YENHUBS_PARENT_WRITER_MONITOR_AUTHORITY_SHA256="$CHECKPOINT_WRITER_MONITOR_AUTHORITY_SHA256" \
YENHUBS_PARENT_DURABLE_MONITOR_CONTROL_BASELINE_PATH="$checkpoint_durable_control_baseline_path" \
YENHUBS_PARENT_DURABLE_MONITOR_CONTROL_BASELINE_SHA256="$checkpoint_durable_control_baseline_sha256" \
YENHUBS_PARENT_DURABLE_MONITOR_PID="$CHECKPOINT_DURABLE_MONITOR_PID" \
YENHUBS_PARENT_DURABLE_MONITOR_START_IDENTITY="$CHECKPOINT_DURABLE_MONITOR_START_IDENTITY" \
YENHUBS_PARENT_DURABLE_MONITOR_FAILURE_PATH="$CHECKPOINT_DURABLE_MONITOR_FAILURE" \
YENHUBS_PARENT_DURABLE_MONITOR_READY_PATH="$CHECKPOINT_DURABLE_MONITOR_READY" \
YENHUBS_PARENT_DURABLE_MONITOR_PROGRESS_PATH="$CHECKPOINT_DURABLE_MONITOR_PROGRESS" \
YENHUBS_PARENT_DURABLE_MONITOR_CAPABILITY_SHA256="$CHECKPOINT_DURABLE_MONITOR_CAPABILITY_SHA256" \
YENHUBS_PARENT_DURABLE_MONITOR_AUTHORITY_SHA256="$CHECKPOINT_DURABLE_MONITOR_AUTHORITY_SHA256" \
  "$SCRIPT_DIR/backup-ret-storage-quiesced.sh" \
  "$OUTPUT_DIR/ret-storage-$TIMESTAMP.tar.gz" \
  "$OUTPUT_DIR/deployment-images.json"
checkpoint_set_failure_context storage-backup serialization
recovery_require_operation_serialization
checkpoint_set_failure_context storage-backup monitor-health
require_checkpoint_monitors_healthy
# Rebind the generation-specific guard after every backup byte before recording
# successful quiescence. Legacy hands off overlapping LIST/watch streams; the
# durable process stays live and revalidates its active-fence capability.
checkpoint_set_failure_context storage-backup runner-handoff
handoff_runner_monitor
if [[ "$CHECKPOINT_FORMAT" == legacy ]]; then
  checkpoint_set_failure_context storage-backup cutover-evidence
  recovery_verify_runner_cutover_evidence_live \
    "$VALUES_SOURCE_FILE" "$OUTPUT_DIR/runner-cutover-evidence.json" \
    "$OUTPUT_DIR/deployment-images.json" "$evidence_fence_state" \
    "$evidence_manifest" checkpoint
fi
checkpoint_set_failure_context storage-backup monitor-health
require_checkpoint_monitors_healthy
checkpoint_set_failure_context storage-backup metadata
SNAPSHOT_COMPLETED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
metadata_tmp="$OUTPUT_DIR/.checkpoint-metadata.next"
[[ ! -e "$metadata_tmp" && ! -L "$metadata_tmp" ]]
if [[ "$CHECKPOINT_FORMAT" == freeze-bundle-v1 ]]; then
  dump_digest="$(recovery_sha256_digest "$OUTPUT_DIR/retdb-$TIMESTAMP.sql.gz")"
  storage_digest="$(recovery_sha256_digest "$OUTPUT_DIR/ret-storage-$TIMESTAMP.tar.gz")"
  dump_size="$(recovery_file_size_bytes "$OUTPUT_DIR/retdb-$TIMESTAMP.sql.gz")"
  storage_size="$(recovery_file_size_bytes "$OUTPUT_DIR/ret-storage-$TIMESTAMP.tar.gz")"
  (umask 077; set -C; jq -n --arg stamp "$TIMESTAMP" \
    --arg client_instance_id "$CLIENT_INSTANCE_ID" \
    --arg freeze_id "$RECOVERY_OPERATION_ID" \
    --arg created "$QUIESCE_STARTED_AT" --arg completed "$SNAPSHOT_COMPLETED_AT" \
    --arg context "$EXPECTED_KUBE_CONTEXT" --arg cluster_name "${CLUSTER_NAME:-hubs-ce}" \
    --arg cluster_uid "$FREEZE_SOURCE_CLUSTER_UID" --arg namespace "$NAMESPACE" \
    --arg namespace_uid "$RECOVERY_NAMESPACE_UID" --arg pvc_uid "$RECOVERY_PVC_UID" \
    --arg dump_digest "$dump_digest" --arg storage_digest "$storage_digest" \
    --argjson dump_size "$dump_size" --argjson storage_size "$storage_size" '{
      schema:"freeze-bundle-v1",client_instance_id:$client_instance_id,
      freeze_id:$freeze_id,stamp:$stamp,created_at_utc:$created,
      source:{kube_context:$context,cluster:{name:$cluster_name,uid:$cluster_uid},
        namespace:{name:$namespace,uid:$namespace_uid},
        pvc:{name:"ret-pvc",uid:$pvc_uid}},
      operation:{id:$freeze_id,quiescence:{started_at_utc:$created,
        completed_at_utc:$completed}},
      payloads:{database:{filename:("retdb-"+$stamp+".sql.gz"),
        size_bytes:$dump_size,sha256:$dump_digest},
        storage:{filename:("ret-storage-"+$stamp+".tar.gz"),
        size_bytes:$storage_size,sha256:$storage_digest}},
      runtime_generation:"legacy-absent",runner_mode:"process-local",
      provenance:{generator:"yenhubs-freeze-bundle-v1",external_import:false},
      minimum_restore_version:1,publication_state:"complete"
    }' >"$metadata_tmp") 2>/dev/null
else
  (umask 077; set -C; jq --arg completed "$SNAPSHOT_COMPLETED_AT" \
    '.writer_quiescence.completed_at_utc = $completed' \
    "$OUTPUT_DIR/checkpoint-metadata.json" >"$metadata_tmp") 2>/dev/null
fi
mv "$metadata_tmp" "$OUTPUT_DIR/checkpoint-metadata.json"
chmod 600 "$OUTPUT_DIR/checkpoint-metadata.json"

checkpoint_set_failure_context content-validation validate
"$SCRIPT_DIR/validate-checkpoint.sh" \
  "$OUTPUT_DIR/retdb-$TIMESTAMP.sql.gz" \
  "$OUTPUT_DIR/ret-storage-$TIMESTAMP.tar.gz"

CHECKSUM_TMP="$OUTPUT_DIR/.yenhubs-checksums.next"
checkpoint_set_failure_context checksum-manifest precondition
[[ ! -e "$CHECKSUM_TMP" && ! -L "$CHECKSUM_TMP" ]]
checkpoint_set_failure_context checksum-manifest build
(umask 077; set -C
  while IFS= read -r artifact; do
    digest="$(recovery_sha256_digest "$OUTPUT_DIR/$artifact")"
    printf '%s  %s\n' "$digest" "$artifact"
  done < <(checkpoint_artifacts) >"$CHECKSUM_TMP"
) 2>/dev/null
checkpoint_set_failure_context checksum-manifest commit
mv "$CHECKSUM_TMP" "$OUTPUT_DIR/SHA256SUMS"
checkpoint_set_failure_context checksum-manifest permissions
chmod 600 "$OUTPUT_DIR/SHA256SUMS"
checkpoint_set_failure_context staging-verification layout
verify_checkpoint_staging_directory
checkpoint_set_failure_context staging-verification writer-monitor
if checkpoint_uses_freeze_admission_fence; then
  require_checkpoint_freeze_fence_zero_boundary
else
  require_checkpoint_writer_monitor_healthy
fi
if [[ "$CHECKPOINT_RUNNER_GENERATION" == durable-v2 ]]; then
  checkpoint_set_failure_context staging-verification durable-monitor
  require_checkpoint_durable_monitor_healthy
fi

# Atomic no-clobber claim. Until the marker is removed, the exact-layout gate
# rejects the visible directory. Every byte is rehashed in the claimed path,
# and the continuous monitor is stopped and joined successfully, before that
# single validity marker disappears.
checkpoint_set_failure_context final-claim claim
claim_final_output_directory
checkpoint_set_failure_context artifact-transfer move
while IFS= read -r artifact; do
  mv "$OUTPUT_DIR/$artifact" "$FINAL_OUTPUT_DIR/$artifact"
done < <({ checkpoint_artifacts; printf 'SHA256SUMS\n'; } | LC_ALL=C sort)
checkpoint_set_failure_context claimed-verification checksum
checkpoint_validate_manifest "$FINAL_OUTPUT_DIR"
checkpoint_set_failure_context claimed-verification layout
actual_with_marker="$(find "$FINAL_OUTPUT_DIR" -mindepth 1 -maxdepth 1 -print |
  while IFS= read -r path; do basename "$path"; done | LC_ALL=C sort)"
expected_with_marker="$({ checkpoint_artifacts; printf '%s\n' SHA256SUMS .yenhubs-incomplete; } | LC_ALL=C sort)"
[[ "$actual_with_marker" == "$expected_with_marker" ]]
# Rebind the same generation-specific guard before the terminal joins. Legacy
# hands off another watcher; durable-v2 keeps the same PID and exact capability
# alive through publication.
checkpoint_set_failure_context terminal-boundary runner-handoff
handoff_runner_monitor
if [[ "$CHECKPOINT_FORMAT" == legacy ]]; then
  checkpoint_set_failure_context terminal-boundary cutover-evidence
  recovery_verify_runner_cutover_evidence_live \
    "$VALUES_SOURCE_FILE" "$FINAL_OUTPUT_DIR/runner-cutover-evidence.json" \
    "$FINAL_OUTPUT_DIR/deployment-images.json" "$evidence_fence_state" \
    "$evidence_manifest" checkpoint
fi
checkpoint_set_failure_context terminal-boundary writer-monitor
if checkpoint_uses_freeze_admission_fence; then
  require_checkpoint_freeze_fence_zero_boundary
else
  require_checkpoint_writer_monitor_healthy
fi
if [[ "$CHECKPOINT_RUNNER_GENERATION" == durable-v2 ]]; then
  checkpoint_set_failure_context terminal-boundary durable-monitor
  require_checkpoint_durable_monitor_healthy
fi
# Keep ownership plus the incomplete marker throughout the final 61-second
# LIST/WATCH overlap. If the monitor fails, EXIT cleanup removes the claimed
# directory instead of leaving an apparently valid checkpoint behind.
checkpoint_set_failure_context terminal-boundary durable-stop
stop_checkpoint_durable_monitor_before_writer_monitor
checkpoint_set_failure_context terminal-boundary writer-stop
if ! checkpoint_uses_freeze_admission_fence; then
  stop_checkpoint_writer_monitor_before_resume
fi
checkpoint_set_failure_context precommit serialization
recovery_require_operation_serialization
checkpoint_set_failure_context precommit operation-lock
recovery_require_operation_lock
checkpoint_set_failure_context precommit checksum
checkpoint_validate_manifest "$FINAL_OUTPUT_DIR"
checkpoint_set_failure_context precommit layout
actual_with_marker="$(find "$FINAL_OUTPUT_DIR" -mindepth 1 -maxdepth 1 -print |
  while IFS= read -r path; do basename "$path"; done | LC_ALL=C sort)"
[[ "$actual_with_marker" == "$expected_with_marker" ]]
# Marker deletion is the final publication operation. All fallible validation
# has already completed while cleanup still owns the claim.
checkpoint_set_failure_context publication commit-marker
commit_final_output_directory
checkpoint_set_failure_context publication staging-cleanup
cleanup_checkpoint_staging_directory

checkpoint_set_failure_context resume preflight
resume_writers
checkpoint_set_failure_context lock-release operation-lock
release_lock_if_safe
checkpoint_set_failure_context serialization-release lease
release_serialization_if_owned
checkpoint_set_failure_context local-cleanup artifacts
cleanup_local_artifacts
checkpoint_report_timing success
trap - EXIT ERR INT TERM

printf 'Complete quiescent YenHubs checkpoint published: %s (writers resumed)\n' \
  "$FINAL_OUTPUT_DIR"

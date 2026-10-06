#!/usr/bin/env bash

# Exports Reticulum's PostgreSQL database as a gzip-compressed plain SQL dump.
# The resulting format is consumed by restore-retdb.sh.

set -euo pipefail
umask 077

# Publisher authority is process-local, never a capability accepted from env.
unset DB_SOURCE_OWNED_GROUP DB_SOURCE_ROUND DB_SOURCE_GUARDIAN_PID \
  DB_SOURCE_GUARDIAN_IDENTITY DB_SOURCE_PUBLISHER_ACTIVE

if [[ $# -ne 1 ]]; then
  printf 'Usage: %s /path/to/retdb-YYYYMMDD-HHMMSS.sql.gz\n' "$0" >&2
  exit 2
fi

OUTPUT_PATH="$1"
OUTPUT_DIR="$(dirname "$OUTPUT_PATH")"
CONTRACT_OUTPUT_PATH="$OUTPUT_DIR/database-contract.json"
BACKUP_MODE="${BACKUP_MODE:-sql}"
case "$BACKUP_MODE" in
  sql | native-monthly) ;;
  *) printf 'BACKUP_MODE must be sql or native-monthly.\n' >&2; exit 2 ;;
esac
NAMESPACE="${NAMESPACE:-hcce}"
COORDINATED="${BACKUP_COORDINATED:-0}"
if [[ "$COORDINATED" != 0 && "$COORDINATED" != 1 ]]; then
  printf 'BACKUP_COORDINATED must be 0 or 1.\n' >&2
  exit 2
fi
if [[ "$COORDINATED" != 1 ]]; then
  printf 'Standalone database backup is superseded. Run %s/create-checkpoint.sh so PostgreSQL metadata and ret-pvc bytes are captured together.\n' \
    "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" >&2
  exit 1
fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The coordinated parent exports its immutable server-side lock binding. The
# shared library deliberately clears materialization state when sourced, so
# retain only these five non-file values and restore them only in coordinated
# mode; every use is then checked against the immutable ConfigMap.
PARENT_CHECKPOINT_STAMP="${RECOVERY_CHECKPOINT_STAMP:-}"
PARENT_DUMP_SHA256="${RECOVERY_DUMP_SHA256:-}"
PARENT_STORAGE_SHA256="${RECOVERY_STORAGE_SHA256:-}"
PARENT_NAMESPACE_UID="${RECOVERY_NAMESPACE_UID:-}"
PARENT_PVC_UID="${RECOVERY_PVC_UID:-}"
PARENT_CHECKPOINT_RUNNER_GENERATION="${CHECKPOINT_RUNNER_GENERATION:-}"
PARENT_DURABLE_FENCE_BASELINE_PATH="${CHECKPOINT_DURABLE_FENCE_BASELINE_PATH:-}"
PARENT_DURABLE_FENCE_BASELINE_SHA256="${CHECKPOINT_DURABLE_FENCE_BASELINE_SHA256:-}"
PARENT_RECOVERY_OPERATION_FENCE_ACTIVE_IDENTITY="${YENHUBS_PARENT_RECOVERY_OPERATION_FENCE_ACTIVE_IDENTITY:-}"
PARENT_LEASE_HOLDER="${YENHUBS_PARENT_LEASE_HOLDER:-}"
PARENT_LEASE_UID="${YENHUBS_PARENT_LEASE_UID:-}"
PARENT_PROCESS_PID="${YENHUBS_PARENT_PROCESS_PID:-}"
PARENT_PROCESS_START_IDENTITY="${YENHUBS_PARENT_PROCESS_START_IDENTITY:-}"
PARENT_FREEZE_FENCE_CAPABILITY="${YENHUBS_PARENT_FREEZE_FENCE_CAPABILITY:-}"
PARENT_WRITER_MONITOR_CONTRACT_PATH="${YENHUBS_PARENT_WRITER_MONITOR_CONTRACT_PATH:-}"
PARENT_WRITER_MONITOR_CONTRACT_SHA256="${YENHUBS_PARENT_WRITER_MONITOR_CONTRACT_SHA256:-}"
PARENT_WRITER_MONITOR_BASELINE_PATH="${YENHUBS_PARENT_WRITER_MONITOR_BASELINE_PATH:-}"
PARENT_WRITER_MONITOR_BASELINE_SHA256="${YENHUBS_PARENT_WRITER_MONITOR_BASELINE_SHA256:-}"
PARENT_WRITER_MONITOR_PID="${YENHUBS_PARENT_WRITER_MONITOR_PID:-}"
PARENT_WRITER_MONITOR_START_IDENTITY="${YENHUBS_PARENT_WRITER_MONITOR_START_IDENTITY:-}"
PARENT_WRITER_MONITOR_FAILURE_PATH="${YENHUBS_PARENT_WRITER_MONITOR_FAILURE_PATH:-}"
PARENT_WRITER_MONITOR_READY_PATH="${YENHUBS_PARENT_WRITER_MONITOR_READY_PATH:-}"
PARENT_WRITER_MONITOR_PROGRESS_PATH="${YENHUBS_PARENT_WRITER_MONITOR_PROGRESS_PATH:-}"
PARENT_WRITER_MONITOR_AUTHORITY_SHA256="${YENHUBS_PARENT_WRITER_MONITOR_AUTHORITY_SHA256:-}"
PARENT_WRITER_MONITOR_MAX_STALE_SECONDS=""
PARENT_STREAM_GUARD_ARGS=()
PARENT_DURABLE_MONITOR_CONTROL_BASELINE_PATH="${YENHUBS_PARENT_DURABLE_MONITOR_CONTROL_BASELINE_PATH:-}"
PARENT_DURABLE_MONITOR_CONTROL_BASELINE_SHA256="${YENHUBS_PARENT_DURABLE_MONITOR_CONTROL_BASELINE_SHA256:-}"
PARENT_DURABLE_MONITOR_PID="${YENHUBS_PARENT_DURABLE_MONITOR_PID:-}"
PARENT_DURABLE_MONITOR_START_IDENTITY="${YENHUBS_PARENT_DURABLE_MONITOR_START_IDENTITY:-}"
PARENT_DURABLE_MONITOR_FAILURE_PATH="${YENHUBS_PARENT_DURABLE_MONITOR_FAILURE_PATH:-}"
PARENT_DURABLE_MONITOR_READY_PATH="${YENHUBS_PARENT_DURABLE_MONITOR_READY_PATH:-}"
PARENT_DURABLE_MONITOR_PROGRESS_PATH="${YENHUBS_PARENT_DURABLE_MONITOR_PROGRESS_PATH:-}"
PARENT_DURABLE_MONITOR_CAPABILITY_SHA256="${YENHUBS_PARENT_DURABLE_MONITOR_CAPABILITY_SHA256:-}"
PARENT_DURABLE_MONITOR_AUTHORITY_SHA256="${YENHUBS_PARENT_DURABLE_MONITOR_AUTHORITY_SHA256:-}"
PARENT_DURABLE_MONITOR_MAX_STALE_SECONDS=""
# shellcheck source=deployment/lib/recovery-safety.sh
source "$SCRIPT_DIR/lib/recovery-safety.sh"
unset YENHUBS_PARENT_WRITER_MONITOR_PID \
  YENHUBS_PARENT_WRITER_MONITOR_CONTRACT_PATH \
  YENHUBS_PARENT_WRITER_MONITOR_CONTRACT_SHA256 \
  YENHUBS_PARENT_WRITER_MONITOR_BASELINE_PATH \
  YENHUBS_PARENT_WRITER_MONITOR_BASELINE_SHA256 \
  YENHUBS_PARENT_WRITER_MONITOR_START_IDENTITY \
  YENHUBS_PARENT_WRITER_MONITOR_FAILURE_PATH \
  YENHUBS_PARENT_WRITER_MONITOR_READY_PATH \
  YENHUBS_PARENT_WRITER_MONITOR_PROGRESS_PATH \
  YENHUBS_PARENT_WRITER_MONITOR_AUTHORITY_SHA256 \
  YENHUBS_PARENT_DURABLE_MONITOR_CONTROL_BASELINE_PATH \
  YENHUBS_PARENT_DURABLE_MONITOR_CONTROL_BASELINE_SHA256 \
  YENHUBS_PARENT_DURABLE_MONITOR_PID \
  YENHUBS_PARENT_DURABLE_MONITOR_START_IDENTITY \
  YENHUBS_PARENT_DURABLE_MONITOR_FAILURE_PATH \
  YENHUBS_PARENT_DURABLE_MONITOR_READY_PATH \
  YENHUBS_PARENT_DURABLE_MONITOR_PROGRESS_PATH \
  YENHUBS_PARENT_DURABLE_MONITOR_CAPABILITY_SHA256 \
  YENHUBS_PARENT_DURABLE_MONITOR_AUTHORITY_SHA256 \
  YENHUBS_PARENT_RECOVERY_OPERATION_FENCE_ACTIVE_IDENTITY \
  YENHUBS_PARENT_FREEZE_FENCE_CAPABILITY
if [[ "$COORDINATED" == 1 ]]; then
  RECOVERY_CHECKPOINT_STAMP="$PARENT_CHECKPOINT_STAMP"
  RECOVERY_DUMP_SHA256="$PARENT_DUMP_SHA256"
  RECOVERY_STORAGE_SHA256="$PARENT_STORAGE_SHA256"
  RECOVERY_NAMESPACE_UID="$PARENT_NAMESPACE_UID"
  RECOVERY_PVC_UID="$PARENT_PVC_UID"
  CHECKPOINT_RUNNER_GENERATION="$PARENT_CHECKPOINT_RUNNER_GENERATION"
  CHECKPOINT_DURABLE_FENCE_BASELINE_PATH="$PARENT_DURABLE_FENCE_BASELINE_PATH"
  CHECKPOINT_DURABLE_FENCE_BASELINE_SHA256="$PARENT_DURABLE_FENCE_BASELINE_SHA256"
  recovery_adopt_parent_operation_serialization \
    "$PARENT_LEASE_HOLDER" "$PARENT_LEASE_UID" \
    "$PARENT_PROCESS_PID" "$PARENT_PROCESS_START_IDENTITY"
fi
unset YENHUBS_PARENT_LEASE_HOLDER YENHUBS_PARENT_LEASE_UID \
  YENHUBS_PARENT_PROCESS_PID YENHUBS_PARENT_PROCESS_START_IDENTITY

require_parent_writer_monitor_capability() {
  local observed_authority_sha256=""
  observed_authority_sha256="$(recovery_monitor_authority_sha256_for_ready \
    "$PARENT_WRITER_MONITOR_READY_PATH" 2>/dev/null || :)"
  if [[ -z "$PARENT_WRITER_MONITOR_AUTHORITY_SHA256" ]]; then
    printf 'database_restore_parent_monitor_detail:authority-export\n' >&2
    return 1
  elif [[ -z "$observed_authority_sha256" ]]; then
    printf 'database_restore_parent_monitor_detail:ready-read\n' >&2
    return 1
  elif [[ "$observed_authority_sha256" != \
          "$PARENT_WRITER_MONITOR_AUTHORITY_SHA256" ]]; then
    printf 'database_restore_parent_monitor_detail:ready-mismatch\n' >&2
    return 1
  fi
  recovery_require_checkpoint_writer_monitor_healthy \
    "$PARENT_WRITER_MONITOR_CONTRACT_PATH" \
    "$PARENT_WRITER_MONITOR_CONTRACT_SHA256" \
    "$PARENT_WRITER_MONITOR_BASELINE_PATH" \
    "$PARENT_WRITER_MONITOR_BASELINE_SHA256" \
    "$PARENT_WRITER_MONITOR_FAILURE_PATH" \
    "$PARENT_WRITER_MONITOR_READY_PATH" \
    "$PARENT_WRITER_MONITOR_PID" \
    "$PARENT_WRITER_MONITOR_START_IDENTITY" \
    "$CHECKPOINT_RUNNER_GENERATION" \
    "$RECOVERY_OPERATION_OWNER" || return 1
  recovery_stream_guard_progress_value \
      "$PARENT_WRITER_MONITOR_PROGRESS_PATH" \
      "$PARENT_WRITER_MONITOR_AUTHORITY_SHA256" >/dev/null
}

require_parent_freeze_fence_capability() {
  [[ "$CHECKPOINT_RUNNER_GENERATION" == legacy-absent &&
     -n "$PARENT_FREEZE_FENCE_CAPABILITY" &&
     -z "$PARENT_WRITER_MONITOR_PID" &&
     -z "$PARENT_WRITER_MONITOR_CONTRACT_PATH" &&
     -z "$PARENT_WRITER_MONITOR_BASELINE_PATH" ]] || return 1
  recovery_require_freeze_checkpoint_fence "$PARENT_FREEZE_FENCE_CAPABILITY" || return 1
  local deployment
  for deployment in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
    recovery_require_consumer_contract_entry "$RECOVERY_CONSUMER_CONTRACT_JSON" \
      "$deployment" 0 || return 1
  done
}

require_parent_durable_monitor_capability() {
  DB_PARENT_DURABLE_FAILURE_REASON=durable-authority
  [[ "$CHECKPOINT_RUNNER_GENERATION" == durable-v2 &&
     -n "$PARENT_RECOVERY_OPERATION_FENCE_ACTIVE_IDENTITY" &&
     "$PARENT_DURABLE_MONITOR_CONTROL_BASELINE_PATH" == \
       "$PARENT_WRITER_MONITOR_BASELINE_PATH" &&
     "$PARENT_DURABLE_MONITOR_CONTROL_BASELINE_SHA256" == \
       "$PARENT_WRITER_MONITOR_BASELINE_SHA256" &&
     "$PARENT_DURABLE_MONITOR_PID" != "$PARENT_WRITER_MONITOR_PID" &&
     "$(recovery_monitor_authority_sha256_for_ready \
       "$PARENT_DURABLE_MONITOR_READY_PATH" 2>/dev/null || :)" == \
       "$PARENT_DURABLE_MONITOR_AUTHORITY_SHA256" ]] || return 1
  recovery_require_durable_runner_quiescence_monitor_healthy \
    "$CHECKPOINT_DURABLE_FENCE_BASELINE_PATH" \
    "$CHECKPOINT_DURABLE_FENCE_BASELINE_SHA256" \
    "$PARENT_DURABLE_MONITOR_CONTROL_BASELINE_PATH" \
    "$PARENT_DURABLE_MONITOR_CONTROL_BASELINE_SHA256" \
    "$PARENT_DURABLE_MONITOR_FAILURE_PATH" \
    "$PARENT_DURABLE_MONITOR_READY_PATH" \
    "$PARENT_DURABLE_MONITOR_PROGRESS_PATH" \
    "$PARENT_DURABLE_MONITOR_PID" \
    "$PARENT_DURABLE_MONITOR_START_IDENTITY" \
    "$PARENT_DURABLE_MONITOR_CAPABILITY_SHA256" \
    "$RECOVERY_OPERATION_OWNER" || {
      DB_PARENT_DURABLE_FAILURE_REASON="${RECOVERY_DURABLE_MONITOR_FAILURE_DETAIL:-durable-authority}"
      return 1
    }
  DB_PARENT_DURABLE_FAILURE_REASON=durable-progress
  recovery_stream_guard_progress_value \
    "$PARENT_DURABLE_MONITOR_PROGRESS_PATH" \
    "$PARENT_DURABLE_MONITOR_AUTHORITY_SHA256" >/dev/null || return 1
  DB_PARENT_DURABLE_FAILURE_REASON=active-fence
  recovery_require_recovery_operation_fence_state active \
    "$PARENT_RECOVERY_OPERATION_FENCE_ACTIVE_IDENTITY" || {
    DB_PARENT_DURABLE_FAILURE_REASON="${RECOVERY_FENCE_STATE_FAILURE_DETAIL:-active-fence}"
    return 1
  }
  DB_PARENT_DURABLE_FAILURE_REASON=""
}

if [[ "$COORDINATED" == 1 ]]; then
  if [[ -n "$PARENT_FREEZE_FENCE_CAPABILITY" ]]; then
    require_parent_freeze_fence_capability || {
      printf 'Coordinated DB backup requires the exact freeze admission fence.\n' >&2
      exit 1
    }
  else
    if ! require_parent_writer_monitor_capability ||
       ! PARENT_WRITER_MONITOR_MAX_STALE_SECONDS="$(
         recovery_stream_guard_max_stale_seconds
       )"; then
      printf 'Coordinated DB backup requires the live parent writer monitor guard.\n' >&2
      exit 1
    fi
    PARENT_STREAM_GUARD_ARGS=(
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
  fi
  if [[ "$CHECKPOINT_RUNNER_GENERATION" == durable-v2 ]]; then
    if ! require_parent_durable_monitor_capability ||
       ! PARENT_DURABLE_MONITOR_MAX_STALE_SECONDS="$(
         recovery_stream_guard_max_stale_seconds
       )"; then
      printf 'Coordinated durable DB backup requires the live parent durable monitor guard.\n' >&2
      exit 1
    fi
    PARENT_STREAM_GUARD_ARGS+=(
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
  elif [[ -n "$PARENT_RECOVERY_OPERATION_FENCE_ACTIVE_IDENTITY" ||
          -n "$CHECKPOINT_DURABLE_FENCE_BASELINE_PATH" ||
          -n "$CHECKPOINT_DURABLE_FENCE_BASELINE_SHA256" ||
          -n "$PARENT_DURABLE_MONITOR_CONTROL_BASELINE_PATH" ||
          -n "$PARENT_DURABLE_MONITOR_CONTROL_BASELINE_SHA256" ||
          -n "$PARENT_DURABLE_MONITOR_PID" ||
          -n "$PARENT_DURABLE_MONITOR_START_IDENTITY" ||
          -n "$PARENT_DURABLE_MONITOR_FAILURE_PATH" ||
          -n "$PARENT_DURABLE_MONITOR_READY_PATH" ||
          -n "$PARENT_DURABLE_MONITOR_PROGRESS_PATH" ||
          -n "$PARENT_DURABLE_MONITOR_CAPABILITY_SHA256" ||
          -n "$PARENT_DURABLE_MONITOR_AUTHORITY_SHA256" ]]; then
    printf 'Legacy coordinated DB backup rejects inherited durable capabilities.\n' >&2
    exit 1
  fi
fi

require_backup_guard() {
  local deployment
  DB_BACKUP_GUARD_FAILURE_REASON=backup-guard
  [[ "$COORDINATED" == 1 &&
     "${RECOVERY_OPERATION_OWNER:-}" == checkpoint-backup &&
     -n "${RECOVERY_CONSUMER_CONTRACT_JSON:-}" &&
     "$CHECKPOINT_RUNNER_GENERATION" =~ ^(legacy-absent|durable-v2)$ ]] ||
    return 1
  # The complete lock validator includes the current cluster, PVC and
  # serialization Lease checks. Require that Lease explicitly: never obtain
  # the faster sweep by allowing the lock's optional-serialization branch.
  DB_BACKUP_GUARD_FAILURE_REASON=serialization
  [[ "${RECOVERY_SERIALIZATION_LEASE_REQUIRED:-0}" == 1 ]] || return 1
  DB_BACKUP_GUARD_FAILURE_REASON=operation-lock
  recovery_require_operation_lock || {
    DB_BACKUP_GUARD_FAILURE_REASON="${RECOVERY_OPERATION_LOCK_FAILURE_DETAIL:-operation-lock}"
    return 1
  }
  for deployment in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
    DB_BACKUP_GUARD_FAILURE_REASON="consumer-$deployment"
    recovery_require_consumer_contract_entry "$RECOVERY_CONSUMER_CONTRACT_JSON" \
      "$deployment" 0 || return 1
  done
  # Only the gated PGSQL publisher owns a pinned, isolated process group.
  # Preflight/final callers retain the original serial predicate below.
  if [[ "${DB_SOURCE_PUBLISHER_ACTIVE:-0}" == 1 &&
        "${DB_SOURCE_OWNED_GROUP:-}" == "$BASHPID" ]]; then
    db_source_join_parent_round
    return $?
  fi
  if [[ -n "$PARENT_FREEZE_FENCE_CAPABILITY" ]]; then
    DB_BACKUP_GUARD_FAILURE_REASON=freeze-fence
    require_parent_freeze_fence_capability || return 1
  else
    DB_BACKUP_GUARD_FAILURE_REASON="parent-writer"
    require_parent_writer_monitor_capability || return 1
  fi
  if [[ "$CHECKPOINT_RUNNER_GENERATION" == durable-v2 ]]; then
    # This full capability validator already performs the SAME exact runner
    # quiescence check with this baseline/hash, as well as its own lock/Lease,
    # authority, PID, inventory and active recovery-fence validations. Keep
    # that complete round; do not repeat its expensive live inventory first.
    require_parent_durable_monitor_capability || {
      DB_BACKUP_GUARD_FAILURE_REASON="${DB_PARENT_DURABLE_FAILURE_REASON:-durable-authority}"
      return 1
    }
  else
    DB_BACKUP_GUARD_FAILURE_REASON="runner-quiescence"
    recovery_require_checkpoint_runner_quiescence_exact \
      "$CHECKPOINT_RUNNER_GENERATION" \
      "$CHECKPOINT_DURABLE_FENCE_BASELINE_PATH" \
      "$CHECKPOINT_DURABLE_FENCE_BASELINE_SHA256" || {
      DB_BACKUP_GUARD_FAILURE_REASON="${RECOVERY_RUNNER_QUIESCENCE_FAILURE_DETAIL:-runner-quiescence}"
      return 1
    }
  fi
  DB_BACKUP_GUARD_FAILURE_REASON=""
}

DUMP_STREAM_GUARD_ARGS=()
DB_SOURCE_MONITOR_STOP=""
DB_SOURCE_MONITOR_FAILURE=""
DB_SOURCE_MONITOR_PROGRESS=""
DB_SOURCE_MONITOR_PID=""
DB_SOURCE_MONITOR_START_IDENTITY=""
DB_SOURCE_MONITOR_MAX_STALE_SECONDS=""
DB_SOURCE_MONITOR_INITIAL_DEADLINE_SECONDS=""
DB_SOURCE_MONITOR_POLL_SECONDS=""
DB_SOURCE_MONITOR_CONTROL_FD=""
DB_SOURCE_MONITOR_READ_FD=""
DB_SOURCE_MONITOR_ROUND_DIR=""
DB_SOURCE_MONITOR_LAST_STATUS=""
DB_SOURCE_MONITOR_OWNED_PID=""
DB_SOURCE_MONITOR_OWNED_IDENTITY=""

db_source_monitor_revoke() {
  # Revoke only this owner's original coproc pipe. No jobs/start/PGID snapshot
  # can authorize an owner-side group signal: STOP may retire its last pins
  # between the snapshot and that signal. The guardian signals its OWN group
  # while it still belongs to it, on EOF or publisher reparenting.
  [[ "$DB_SOURCE_MONITOR_PID" == "$DB_SOURCE_MONITOR_OWNED_PID" &&
     "$DB_SOURCE_MONITOR_START_IDENTITY" == "$DB_SOURCE_MONITOR_OWNED_IDENTITY" ]] || return 1
  if [[ -n "$DB_SOURCE_MONITOR_CONTROL_FD" &&
          "${YENHUBS_PGSQL_SOURCE_PID:-}" == "$DB_SOURCE_MONITOR_PID" &&
          "${YENHUBS_PGSQL_SOURCE[1]:-}" == "$DB_SOURCE_MONITOR_CONTROL_FD" ]]; then
    # Check Bash's current pipe ownership without forks/FD allocations between
    # the check and close. A completed coproc loses this binding; its historical
    # descriptor must not be closed or its historical PGID signalled.
    exec {DB_SOURCE_MONITOR_CONTROL_FD}>&-
  fi
  # Bash owns/closes the original coproc writer on termination. Its numeric
  # descriptor is not an inherited capability or an FD to close after reap.
  DB_SOURCE_MONITOR_CONTROL_FD=""
}

db_source_parent_branch() {
  local branch="$1" status=0 reason=complete
  if [[ "$branch" == W ]]; then
    if [[ -n "$PARENT_FREEZE_FENCE_CAPABILITY" ]]; then
      reason=freeze-fence
      require_parent_freeze_fence_capability || status=$?
    else
      reason="parent-writer"
      require_parent_writer_monitor_capability || status=$?
    fi
  elif [[ "$branch" == D && "$CHECKPOINT_RUNNER_GENERATION" == durable-v2 ]]; then
    require_parent_durable_monitor_capability || {
      status=$?
      reason="${DB_PARENT_DURABLE_FAILURE_REASON:-durable-authority}"
    }
  elif [[ "$branch" == D ]]; then
    recovery_require_checkpoint_runner_quiescence_exact \
      "$CHECKPOINT_RUNNER_GENERATION" \
      "$CHECKPOINT_DURABLE_FENCE_BASELINE_PATH" \
      "$CHECKPOINT_DURABLE_FENCE_BASELINE_SHA256" || {
      status=$?
      reason="${RECOVERY_RUNNER_QUIESCENCE_FAILURE_DETAIL:-runner-quiescence}"
    }
  else
    return 2
  fi
  [[ "$status" != 0 ]] || reason=complete
  [[ "$reason" == complete ]] ||
    recovery_pgsql_source_monitor_failure_code_is_exact "$reason" || reason="backup-guard"
  printf 'branch:v1:%s:%s:%s:%s:%s\n' \
    "$branch" "$DB_SOURCE_ROUND" "$BASHPID" "$status" "$reason" \
    >"$DB_SOURCE_MONITOR_ROUND_DIR/$branch.result" || return 2
  return "$status"
}

db_source_branch_result() {
  local branch="$1" pid="$2" joined_status="$3" record
  local path="$DB_SOURCE_MONITOR_ROUND_DIR/$branch.result"
  DB_SOURCE_BRANCH_REASON=source-owned-round
  recovery_runner_watch_marker_is_exact "$path" || return 1
  [[ "$(wc -c <"$path")" -le 128 ]] || return 1
  # read -d NUL retains LF and exposes embedded NUL. One closed bounded
  # record is necessary; a failed wait or partial receipt can never be healthy.
  if IFS= read -r -d '' record <"$path"; then return 1; fi
  [[ "$record" == *$'\n' ]] || return 1
  record="${record%$'\n'}"
  [[ "$record" =~ ^branch:v1:([WD]):([1-9][0-9]*):([1-9][0-9]*):(0|[1-9][0-9]{0,2}):([a-z][a-z_-]*)$ ]] || return 1
  [[ "${BASH_REMATCH[1]}" == "$branch" &&
     "${BASH_REMATCH[2]}" == "$DB_SOURCE_ROUND" &&
     "${BASH_REMATCH[3]}" == "$pid" &&
     "${BASH_REMATCH[4]}" == "$joined_status" && "$joined_status" != 127 ]] || return 1
  DB_SOURCE_BRANCH_REASON="${BASH_REMATCH[5]}"
  if [[ "$joined_status" == 0 ]]; then
    [[ "$DB_SOURCE_BRANCH_REASON" == complete ]] || return 1
  else
    [[ "$DB_SOURCE_BRANCH_REASON" != complete ]] &&
      recovery_pgsql_source_monitor_failure_code_is_exact "$DB_SOURCE_BRANCH_REASON" || return 1
  fi
}

db_source_guardian_is_usable() {
  local running_jobs kernel_state
  [[ "$BASHPID" == "${DB_SOURCE_OWNED_GROUP:-}" ]] || return 1
  running_jobs="$(builtin jobs -pr)" || return 1
  # With job control off Bash can retain a kernel-STOPPED child as RUNNING.
  # Require our original native job AND a non-stopped/non-zombie kernel state
  # AND its fresh identity. No global live-process semantics are changed here.
  [[ $'\n'"$running_jobs"$'\n' == *$'\n'"$DB_SOURCE_GUARDIAN_PID"$'\n'* ]] || return 1
  kernel_state="$(command ps -o state= -p "$DB_SOURCE_GUARDIAN_PID")" || return 1
  kernel_state="${kernel_state//[[:space:]]/}"
  # Darwin appends flags (e.g. SN/Ss); only the first character is state.
  case "${kernel_state:0:1}" in
    R|S|I|D|U) ;;
    *) return 1 ;;
  esac
  # D/U are ordinary uninterruptible waits, not a guarantee against a kernel
  # or I/O operation that never returns; a stopped guardian is always refused.
  recovery_process_identity_is_live "$DB_SOURCE_GUARDIAN_PID" "$DB_SOURCE_GUARDIAN_IDENTITY"
}

db_source_join_parent_round() {
  local writer_pid durable_pid writer_identity durable_identity group
  local writer_status durable_status writer_reason durable_reason
  local active_jobs
  DB_BACKUP_GUARD_FAILURE_REASON=source-owned-round
  DB_SOURCE_ROUND=$((DB_SOURCE_ROUND + 1))
  rm -f -- "$DB_SOURCE_MONITOR_ROUND_DIR/"{W,D}.{go,result} || return 1
  (
    while [[ ! -e "$DB_SOURCE_MONITOR_ROUND_DIR/W.go" ]]; do sleep 0.01; done
    db_source_parent_branch W
  ) >&2 &
  writer_pid=$!
  (
    while [[ ! -e "$DB_SOURCE_MONITOR_ROUND_DIR/D.go" ]]; do sleep 0.01; done
    db_source_parent_branch D
  ) >&2 &
  durable_pid=$!
  # Each worker is still gate-blocked. Its fresh identity and PGID must belong
  # to the guardian-pinned source group before any complete predicate runs.
  for group in "$writer_pid" "$durable_pid"; do
    [[ "$(ps -o pgid= -p "$group" | tr -d '[:space:]')" == "$DB_SOURCE_OWNED_GROUP" ]] || return 1
  done
  writer_identity="$(recovery_process_start_identity "$writer_pid")" || return 1
  durable_identity="$(recovery_process_start_identity "$durable_pid")" || return 1
  recovery_process_identity_is_live "$writer_pid" "$writer_identity" &&
    recovery_process_identity_is_live "$durable_pid" "$durable_identity" || return 1
  db_source_guardian_is_usable || {
    DB_BACKUP_GUARD_FAILURE_REASON=source-guardian
    return 1
  }
  : >"$DB_SOURCE_MONITOR_ROUND_DIR/W.go" || return 1
  : >"$DB_SOURCE_MONITOR_ROUND_DIR/D.go" || return 1
  # Join BOTH complete branches even after rejection. Preserve the original
  # W-before-D first cause independently of completion order; never publish
  # before either native join and its exact receipt are validated.
  while :; do
    # A STOPPED branch is still pending: wait may report its state change
    # without termination. Supervise BOTH jobs before either terminal wait.
    if ! db_source_guardian_is_usable; then
      DB_BACKUP_GUARD_FAILURE_REASON=source-guardian
      record_pgsql_source_monitor_failure source-guardian
      [[ "$BASHPID" == "$DB_SOURCE_OWNED_GROUP" ]] || return 1
      kill -KILL -- "-$BASHPID"
      return 1
    fi
    active_jobs="$(builtin jobs -pr; builtin jobs -ps)" || return 1
    [[ $'\n'"$active_jobs"$'\n' == *$'\n'"$writer_pid"$'\n'* ||
       $'\n'"$active_jobs"$'\n' == *$'\n'"$durable_pid"$'\n'* ]] || break
    sleep "$DB_SOURCE_MONITOR_POLL_SECONDS" || return 1
  done
  if wait "$writer_pid"; then writer_status=0; else writer_status=$?; fi
  if wait "$durable_pid"; then durable_status=0; else durable_status=$?; fi
  db_source_branch_result W "$writer_pid" "$writer_status" || return 1
  writer_reason="$DB_SOURCE_BRANCH_REASON"
  if ! db_source_branch_result D "$durable_pid" "$durable_status"; then
    # A proven W rejection was the original first cause, even if D's later
    # receipt is unavailable. This cannot attest D or permit publication.
    [[ "$writer_status" != 0 ]] || return 1
    DB_BACKUP_GUARD_FAILURE_REASON="$writer_reason"
    return "$writer_status"
  fi
  durable_reason="$DB_SOURCE_BRANCH_REASON"
  if [[ "$writer_status" != 0 ]]; then
    DB_BACKUP_GUARD_FAILURE_REASON="$writer_reason"
    return "$writer_status"
  fi
  if [[ "$durable_status" != 0 ]]; then
    DB_BACKUP_GUARD_FAILURE_REASON="$durable_reason"
    return "$durable_status"
  fi
  db_source_guardian_is_usable || {
    DB_BACKUP_GUARD_FAILURE_REASON=source-guardian
    return 1
  }
  DB_BACKUP_GUARD_FAILURE_REASON=""
}

db_source_owned_publisher() {
  local permission status=0 guardian_failure="" guardian_status
  local DB_SOURCE_OWNED_GROUP="$BASHPID" DB_SOURCE_ROUND=0
  local DB_SOURCE_GUARDIAN_PID="" DB_SOURCE_GUARDIAN_IDENTITY=""
  local DB_SOURCE_PUBLISHER_ACTIVE=0
  set +m
  trap - EXIT INT TERM
  IFS= read -r -t "$DB_SOURCE_MONITOR_INITIAL_DEADLINE_SECONDS" permission || return 1
  [[ "$permission" == go ]] || return 1
  # Same live-own-PGID/EOF guardian pattern as the stream audit. No foreign
  # PID is retained to signal; reparenting catches publisher SIGKILL as well.
  command python3 -I -c '
import os, select, signal, sys, time
group = int(sys.argv[1])
if os.getpgrp() != group or os.getppid() != group:
    sys.exit(1)
signal.signal(signal.SIGINT, signal.SIG_IGN)
signal.signal(signal.SIGTERM, signal.SIG_IGN)
signal.signal(signal.SIGUSR1, lambda *_: sys.exit(0))
with open(sys.argv[2], "x", encoding="ascii") as ready:
    ready.write("ready\n")
while True:
    if os.getppid() != group or select.select([0], [], [], 0.05)[0]:
        os.killpg(group, signal.SIGTERM)
        time.sleep(0.1)
        os.killpg(group, signal.SIGKILL)
' "$DB_SOURCE_OWNED_GROUP" "$DB_SOURCE_MONITOR_ROUND_DIR/guardian.ready" <&0 >&2 &
  DB_SOURCE_GUARDIAN_PID=$!
  DB_SOURCE_GUARDIAN_IDENTITY="$(recovery_process_start_identity "$DB_SOURCE_GUARDIAN_PID")" || return 1
  while [[ ! -s "$DB_SOURCE_MONITOR_ROUND_DIR/guardian.ready" ]]; do
    db_source_guardian_is_usable || {
      record_pgsql_source_monitor_failure source-guardian
      [[ "$BASHPID" == "$DB_SOURCE_OWNED_GROUP" ]] || return 1
      kill -KILL -- "-$BASHPID"
      return 1
    }
    sleep 0.01
  done
  db_source_guardian_is_usable || {
    record_pgsql_source_monitor_failure source-guardian
    [[ "$BASHPID" == "$DB_SOURCE_OWNED_GROUP" ]] || return 1
    kill -KILL -- "-$BASHPID"
    return 1
  }
  DB_SOURCE_PUBLISHER_ACTIVE=1
  printf 'ready\n' || return 1
  if monitor_exact_pgsql_source >&2; then status=0; else status=$?; fi
  if ! db_source_guardian_is_usable; then
    guardian_failure=source-guardian
  elif [[ "$status" == 0 && -e "$DB_SOURCE_MONITOR_STOP" ]]; then
    if ! kill -USR1 "$DB_SOURCE_GUARDIAN_PID" 2>/dev/null; then
      guardian_failure=source-guardian
    else
      if wait "$DB_SOURCE_GUARDIAN_PID"; then guardian_status=0; else guardian_status=$?; fi
      [[ "$guardian_status" == 0 ]] || guardian_failure=source-guardian
    fi
  fi
  if [[ -n "$guardian_failure" ]]; then
    record_pgsql_source_monitor_failure "$guardian_failure"
    # The guardian is no longer a usable pin. This publisher STILL pins its
    # own group and must retire any gate-blocked/failed-round descendants now.
    [[ "$BASHPID" == "$DB_SOURCE_OWNED_GROUP" ]] || return 1
    kill -KILL -- "-$BASHPID"
    return 1
  elif [[ "$status" == 0 && ! -e "$DB_SOURCE_MONITOR_STOP" ]]; then
    record_pgsql_source_monitor_failure source-owned-round
    status=1
  fi
  printf 'source:v1:%s:%s\n' "$DB_SOURCE_OWNED_GROUP" "$status" || return 1
  return "$status"
}

require_exact_pgsql_source_now() {
  local current_pods_json current_pod_info current_pod_json
  local current_pod current_pod_uid current_deployment_uid
  current_pods_json="$(
    recovery_kubectl get pod -n "$NAMESPACE" -l app=pgsql -o json
  )" || return 1
  current_pod_info="$(recovery_exact_ready_deployment_pod_info \
    "$current_pods_json" pgsql pgsql)" || return 1
  IFS=$'\t' read -r current_pod current_pod_uid current_deployment_uid \
    <<<"$current_pod_info"
  [[ "$current_pod" == "$PGSQL_POD" &&
     "$current_pod_uid" == "$PGSQL_POD_UID" &&
     "$current_deployment_uid" == "$PGSQL_DEPLOYMENT_UID" ]] || return 1
  current_pod_json="$(jq -cer --arg uid "$PGSQL_POD_UID" '
    [.items[] | select(.metadata.uid == $uid)] |
    select(length == 1) | .[0]
  ' <<<"$current_pods_json")" || return 1
  recovery_require_pod_identity "$PGSQL_POD" "$PGSQL_POD_UID" || return 1
  recovery_require_pod_deployment_ownership \
    "$current_pod_json" pgsql "$PGSQL_DEPLOYMENT_UID"
}

record_pgsql_source_monitor_failure() {
  local failure_reason="$1"
  recovery_pgsql_source_monitor_failure_code_is_exact "$failure_reason" ||
    failure_reason=backup-guard
  # Retain the first closed guard cause even if later infrastructure fails.
  [[ ! -s "$DB_SOURCE_MONITOR_FAILURE" ]] || return 0
  printf 'pgsql_source_monitor_failed:%s\n' "$failure_reason" \
    >"$DB_SOURCE_MONITOR_FAILURE"
}

monitor_exact_pgsql_source() {
  local progress=0
  while [[ ! -e "$DB_SOURCE_MONITOR_STOP" ]]; do
    # require_backup_guard retains these exact checks within its complete
    # operation-lock validation. Repeating them here ages the causal progress
    # bound before the source can publish another fully validated round.
    require_backup_guard || {
      record_pgsql_source_monitor_failure "${DB_BACKUP_GUARD_FAILURE_REASON:-backup-guard}"
      return 1
    }
    require_exact_pgsql_source_now || {
      record_pgsql_source_monitor_failure pgsql-source
      return 1
    }
    [[ ! -e "$DB_SOURCE_MONITOR_STOP" ]] || return 0
    db_source_guardian_is_usable || {
      record_pgsql_source_monitor_failure source-guardian
      return 1
    }
    progress=$((progress + 1))
    if ! recovery_write_stream_guard_progress \
        "$DB_SOURCE_MONITOR_PROGRESS" "$progress"; then
      record_pgsql_source_monitor_failure progress_publish_failed
      return 1
    fi
    sleep "$DB_SOURCE_MONITOR_POLL_SECONDS"
  done
}

stop_db_source_monitor() {
  local monitor_status=0 terminal="" terminal_status=0
  local mode="${1:-stop}" joined_pid="$DB_SOURCE_MONITOR_PID"
  [[ "$mode" == stop || "$mode" == revoke ]] || return 2
  if [[ -n "$DB_SOURCE_MONITOR_PID" ]]; then
    [[ "$DB_SOURCE_MONITOR_PID" == "$DB_SOURCE_MONITOR_OWNED_PID" &&
       "$DB_SOURCE_MONITOR_START_IDENTITY" == "$DB_SOURCE_MONITOR_OWNED_IDENTITY" ]] || return 1
    : >"$DB_SOURCE_MONITOR_STOP"
    if [[ "$mode" == revoke ]]; then db_source_monitor_revoke || return 1; fi
    if wait "$DB_SOURCE_MONITOR_PID"; then
      monitor_status=0
    else
      monitor_status=$?
    fi
    DB_SOURCE_MONITOR_LAST_STATUS="$monitor_status"
    # Keep the duplicated reader through reap. EOF, native wait and
    # the one exact terminal receipt must agree; no wait127/missing receipt0.
    # Bash owns/closes the original coproc writer. Never close a historical FD
    # or signal a historical group after this authentic native join.
    DB_SOURCE_MONITOR_CONTROL_FD=""
    if [[ -n "$DB_SOURCE_MONITOR_READ_FD" ]]; then
      if LC_ALL=C IFS= read -r -d '' -n 80 -t 0.1 -u "$DB_SOURCE_MONITOR_READ_FD" terminal; then
        terminal_status=0
      else
        terminal_status=$?
      fi
      exec {DB_SOURCE_MONITOR_READ_FD}<&-
      DB_SOURCE_MONITOR_READ_FD=""
    fi
    if [[ "$terminal_status" != 1 ||
          "$terminal" != "source:v1:$joined_pid:$DB_SOURCE_MONITOR_LAST_STATUS"$'\n' ||
          "$DB_SOURCE_MONITOR_LAST_STATUS" == 127 ]]; then
      [[ "$monitor_status" != 0 ]] || monitor_status=1
    fi
    DB_SOURCE_MONITOR_PID=""
    DB_SOURCE_MONITOR_START_IDENTITY=""
    DB_SOURCE_MONITOR_OWNED_PID=""
    DB_SOURCE_MONITOR_OWNED_IDENTITY=""
  fi
  if [[ -n "$DB_SOURCE_MONITOR_FAILURE" &&
        -s "$DB_SOURCE_MONITOR_FAILURE" ]]; then
    [[ "$monitor_status" != 0 ]] || monitor_status=1
  fi
  DUMP_STREAM_GUARD_ARGS=()
  return "$monitor_status"
}

start_db_source_monitor() {
  local monitor_mode=0 pipe_read pipe_write group ready="" ready_status started
  [[ -z "$DB_SOURCE_MONITOR_PID" &&
     -z "$DB_SOURCE_MONITOR_START_IDENTITY" ]] || return 2
  DB_SOURCE_MONITOR_STOP="$(
    mktemp "${OUTPUT_PATH}.pgsql-monitor-stop.XXXXXX"
  )" || return 1
  DB_SOURCE_MONITOR_FAILURE="$(
    mktemp "${OUTPUT_PATH}.pgsql-monitor-failure.XXXXXX"
  )" || return 1
  DB_SOURCE_MONITOR_PROGRESS="$(
    mktemp "${OUTPUT_PATH}.pgsql-monitor-progress.XXXXXX"
  )" || return 1
  rm -f -- "$DB_SOURCE_MONITOR_STOP"
  chmod 600 "$DB_SOURCE_MONITOR_FAILURE" "$DB_SOURCE_MONITOR_PROGRESS" ||
    return 1
  DB_SOURCE_MONITOR_ROUND_DIR="$(mktemp -d "${OUTPUT_PATH}.pgsql-round.XXXXXX")" || return 1
  chmod 700 "$DB_SOURCE_MONITOR_ROUND_DIR" || return 1
  DB_SOURCE_MONITOR_POLL_SECONDS="$(recovery_stream_poll_seconds)" || return 1
  DB_SOURCE_MONITOR_MAX_STALE_SECONDS="$(recovery_stream_guard_max_stale_seconds)" || return 1
  DB_SOURCE_MONITOR_INITIAL_DEADLINE_SECONDS="$(recovery_stream_guard_initial_deadline_seconds)" || return 1
  started="$(recovery_monotonic_milliseconds)" || return 1
  [[ $- != *m* ]] || monitor_mode=1
  set -m
  coproc YENHUBS_PGSQL_SOURCE { db_source_owned_publisher; }
  DB_SOURCE_MONITOR_PID="${YENHUBS_PGSQL_SOURCE_PID:-}"
  DB_SOURCE_MONITOR_OWNED_PID="$DB_SOURCE_MONITOR_PID"
  pipe_read="${YENHUBS_PGSQL_SOURCE[0]:-}"
  pipe_write="${YENHUBS_PGSQL_SOURCE[1]:-}"
  [[ "$monitor_mode" == 1 ]] || set +m
  DB_SOURCE_MONITOR_CONTROL_FD="$pipe_write"
  if ! DB_SOURCE_MONITOR_START_IDENTITY="$(
    recovery_process_start_identity "$DB_SOURCE_MONITOR_PID"
  )"; then
    stop_db_source_monitor revoke || :
    return 1
  fi
  DB_SOURCE_MONITOR_OWNED_IDENTITY="$DB_SOURCE_MONITOR_START_IDENTITY"
  if ! group="$(ps -o pgid= -p "$DB_SOURCE_MONITOR_PID" | tr -d '[:space:]')" ||
     [[ "$group" != "$DB_SOURCE_MONITOR_PID" ]] ||
     ! recovery_process_identity_is_live "$DB_SOURCE_MONITOR_PID" "$DB_SOURCE_MONITOR_START_IDENTITY"; then
    stop_db_source_monitor revoke || :
    return 1
  fi
  # Duplicate only the reader for terminal buffering. The original coproc
  # writer is closed by Bash in non-owner subshells, including the dump pipe.
  if ! exec {DB_SOURCE_MONITOR_READ_FD}<&"$pipe_read"; then
    stop_db_source_monitor revoke || :
    return 1
  fi
  exec {pipe_read}<&-
  if ! printf 'go\n' >&"$DB_SOURCE_MONITOR_CONTROL_FD"; then
    stop_db_source_monitor revoke || :
    return 1
  fi
  if LC_ALL=C IFS= read -r -d '' -n 6 -t "$DB_SOURCE_MONITOR_INITIAL_DEADLINE_SECONDS" -u "$DB_SOURCE_MONITOR_READ_FD" ready; then
    ready_status=0
  else
    ready_status=$?
  fi
  if [[ "$ready_status" != 0 || "$ready" != $'ready\n' ]] ||
     ! recovery_wait_for_stream_guard_initial_progress \
       "$DB_SOURCE_MONITOR_PID" "$DB_SOURCE_MONITOR_START_IDENTITY" \
       "$DB_SOURCE_MONITOR_FAILURE" "$DB_SOURCE_MONITOR_PROGRESS" \
       "$DB_SOURCE_MONITOR_INITIAL_DEADLINE_SECONDS" "$started"; then
    stop_db_source_monitor revoke || :
    DB_SOURCE_MONITOR_MAX_STALE_SECONDS=""
    DB_SOURCE_MONITOR_INITIAL_DEADLINE_SECONDS=""
    return 1
  fi
  DUMP_STREAM_GUARD_ARGS=(
    --guard-process "$DB_SOURCE_MONITOR_PID"
    "$DB_SOURCE_MONITOR_START_IDENTITY"
    "$DB_SOURCE_MONITOR_FAILURE"
    "$DB_SOURCE_MONITOR_PROGRESS"
    "$DB_SOURCE_MONITOR_MAX_STALE_SECONDS"
  )
  DUMP_STREAM_GUARD_ARGS+=("${PARENT_STREAM_GUARD_ARGS[@]}")
}

if [[ -e "$OUTPUT_PATH" || -L "$OUTPUT_PATH" ||
      -e "$CONTRACT_OUTPUT_PATH" || -L "$CONTRACT_OUTPUT_PATH" ]]; then
  printf 'Refusing to overwrite existing backup or database contract.\n' >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
PARTIAL_PATH="$(mktemp "${OUTPUT_PATH}.partial.XXXXXX")"
SQL_CHECK_PATH="$(mktemp "${OUTPUT_PATH}.verify.sql.XXXXXX")"
CONTRACT_BEFORE="$(mktemp "${OUTPUT_PATH}.contract-before.XXXXXX")"
CONTRACT_AFTER="$(mktemp "${OUTPUT_PATH}.contract-after.XXXXXX")"
CONTRACT_BOUND="$(mktemp "${OUTPUT_PATH}.contract-bound.XXXXXX")"
BACKUP_SUCCEEDED=0
OUTPUT_PUBLISHED=0
OUTPUT_PUBLISHED_IDENTITY=""
CONTRACT_PUBLISHED=0
CONTRACT_PUBLISHED_IDENTITY=""
PARTIAL_OWNED_IDENTITY=""
CONTRACT_BOUND_OWNED_IDENTITY=""

backup_file_identity() {
  local path="$1" identity
  [[ -f "$path" && ! -L "$path" ]] || return 1
  if identity="$(stat -f '%d:%i' -- "$path" 2>/dev/null)"; then
    :
  elif identity="$(stat -c '%d:%i' -- "$path" 2>/dev/null)"; then
    :
  else
    return 1
  fi
  [[ "$identity" =~ ^[0-9]+:[0-9]+$ ]] || return 1
  printf '%s\n' "$identity"
}

backup_private_file_identity() {
  local path="$1" identity
  [[ -f "$path" && ! -L "$path" ]] || return 1
  if identity="$(stat -f '%d:%i:%Lp' -- "$path" 2>/dev/null)"; then
    :
  elif identity="$(stat -c '%d:%i:%a' -- "$path" 2>/dev/null)"; then
    :
  else
    return 1
  fi
  [[ "$identity" =~ ^([0-9]+:[0-9]+):600$ ]] || return 1
  printf '%s\n' "${BASH_REMATCH[1]}"
}

publish_private_file_no_clobber() {
  local source_path="$1" destination_path="$2" expected_identity="$3"
  command python3 -I - "$source_path" "$destination_path" \
    "$expected_identity" <<'PY'
import os
import stat
import sys


def exact(value, expected_dev, expected_ino, links, baseline=None):
    return (
        stat.S_ISREG(value.st_mode)
        and value.st_uid == os.getuid()
        and stat.S_IMODE(value.st_mode) == 0o600
        and value.st_dev == expected_dev
        and value.st_ino == expected_ino
        and value.st_nlink == links
        and value.st_size > 0
        and (
            baseline is None
            or (
                value.st_size == baseline.st_size
                and value.st_mtime_ns == baseline.st_mtime_ns
            )
        )
    )


def main():
    source = os.path.abspath(sys.argv[1])
    destination = os.path.abspath(sys.argv[2])
    expected_dev, expected_ino = (int(value) for value in sys.argv[3].split(":"))
    parent = os.path.dirname(source)
    if parent != os.path.dirname(destination):
        raise RuntimeError("cross_directory_publication")
    source_name = os.path.basename(source)
    destination_name = os.path.basename(destination)
    if source_name in ("", ".", "..") or destination_name in ("", ".", ".."):
        raise RuntimeError("invalid_leaf")
    flags = os.O_RDONLY | os.O_DIRECTORY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    directory_fd = os.open(parent, flags)
    try:
        before = os.stat(source_name, dir_fd=directory_fd, follow_symlinks=False)
        if not exact(before, expected_dev, expected_ino, 1):
            raise RuntimeError("source_changed")
        try:
            os.stat(destination_name, dir_fd=directory_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise FileExistsError("destination_exists")
        os.link(
            source_name,
            destination_name,
            src_dir_fd=directory_fd,
            dst_dir_fd=directory_fd,
            follow_symlinks=False,
        )
        linked_source = os.stat(
            source_name, dir_fd=directory_fd, follow_symlinks=False
        )
        linked_destination = os.stat(
            destination_name, dir_fd=directory_fd, follow_symlinks=False
        )
        if (
            not exact(linked_source, expected_dev, expected_ino, 2, before)
            or not exact(linked_destination, expected_dev, expected_ino, 2, before)
        ):
            raise RuntimeError("link_identity_changed")
        os.fsync(directory_fd)
        unlink_source = os.stat(
            source_name, dir_fd=directory_fd, follow_symlinks=False
        )
        unlink_destination = os.stat(
            destination_name, dir_fd=directory_fd, follow_symlinks=False
        )
        if (
            not exact(unlink_source, expected_dev, expected_ino, 2, before)
            or not exact(unlink_destination, expected_dev, expected_ino, 2, before)
        ):
            raise RuntimeError("unlink_identity_changed")
        os.unlink(source_name, dir_fd=directory_fd)
        try:
            os.stat(source_name, dir_fd=directory_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise RuntimeError("source_still_linked")
        final = os.stat(
            destination_name, dir_fd=directory_fd, follow_symlinks=False
        )
        if not exact(final, expected_dev, expected_ino, 1, before):
            raise RuntimeError("final_identity_changed")
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


try:
    main()
except BaseException:
    raise SystemExit(1)
PY
}

remove_owned_published_file() {
  local published="$1" expected_identity="$2" path="$3" current_identity
  [[ "$published" == 1 && -n "$expected_identity" ]] || return 0
  current_identity="$(backup_file_identity "$path" 2>/dev/null)" || return 0
  [[ "$current_identity" == "$expected_identity" ]] || return 0
  if ! rm -f -- "$path"; then
    printf 'Could not remove an incomplete published database backup artifact: %s\n' \
      "$path" >&2
  fi
  return 0
}

cleanup_backup() {
  trap '' INT TERM
  if [[ "$BACKUP_SUCCEEDED" != 1 ]]; then
    remove_owned_published_file \
      "$CONTRACT_PUBLISHED" "$CONTRACT_PUBLISHED_IDENTITY" \
      "$CONTRACT_OUTPUT_PATH"
    remove_owned_published_file \
      "$OUTPUT_PUBLISHED" "$OUTPUT_PUBLISHED_IDENTITY" "$OUTPUT_PATH"
  fi
  remove_owned_published_file 1 "$PARTIAL_OWNED_IDENTITY" "$PARTIAL_PATH"
  remove_owned_published_file \
    1 "$CONTRACT_BOUND_OWNED_IDENTITY" "$CONTRACT_BOUND"
  stop_db_source_monitor revoke || :
  rm -f -- "$SQL_CHECK_PATH" "$CONTRACT_BEFORE" "$CONTRACT_AFTER" || :
  [[ -z "$DB_SOURCE_MONITOR_STOP" ]] ||
    rm -f -- "$DB_SOURCE_MONITOR_STOP" || :
  [[ -z "$DB_SOURCE_MONITOR_FAILURE" ]] ||
    rm -f -- "$DB_SOURCE_MONITOR_FAILURE" || :
  [[ -z "$DB_SOURCE_MONITOR_PROGRESS" ]] ||
    rm -f -- "$DB_SOURCE_MONITOR_PROGRESS" \
      "${DB_SOURCE_MONITOR_PROGRESS}.next" || :
  if [[ -n "$DB_SOURCE_MONITOR_ROUND_DIR" ]]; then
    rm -f -- "$DB_SOURCE_MONITOR_ROUND_DIR/"{W,D}.{go,result} \
      "$DB_SOURCE_MONITOR_ROUND_DIR/guardian.ready" || :
    rmdir -- "$DB_SOURCE_MONITOR_ROUND_DIR" || :
  fi
  return 0
}
backup_interrupted() {
  local status="$1"
  trap - EXIT
  trap '' INT TERM
  cleanup_backup
  exit "$status"
}
PARTIAL_OWNED_IDENTITY="$(backup_file_identity "$PARTIAL_PATH")"
CONTRACT_BOUND_OWNED_IDENTITY="$(backup_file_identity "$CONTRACT_BOUND")"
trap cleanup_backup EXIT
trap 'backup_interrupted 130' INT
trap 'backup_interrupted 143' TERM

recovery_require_cluster_identity
if [[ "$COORDINATED" == 1 ]]; then
  recovery_require_pvc_identity ret-pvc
  require_backup_guard || {
    printf 'Coordinated DB backup requires every exact writer at zero under its lock.\n' >&2
    exit 1
  }
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
  require_exact_pgsql_source_now
}

require_backup_guard
require_pgsql_source
if [[ "$BACKUP_MODE" == native-monthly ]]; then
  [[ "$CHECKPOINT_RUNNER_GENERATION" == durable-v2 &&
     -z "$PARENT_FREEZE_FENCE_CAPABILITY" &&
     "${MONTHLY_NATIVE_SOURCE_PATH:-}" == /* &&
     "${MONTHLY_NATIVE_JOURNAL_PATH:-}" == /* &&
     "${MONTHLY_NATIVE_MONTH:-}" =~ ^[0-9]{4}-(0[1-9]|1[0-2])$ ]] || {
    printf 'Native monthly snapshots require the exact durable coordinated parent.\n' >&2
    exit 2
  }
fi
if ! recovery_capture_live_database_contract "$PGSQL_POD" "$CONTRACT_BEFORE"; then
  printf 'Could not capture the complete pre-dump database contract.\n' >&2
  exit 1
fi
SCHEMA_TABLES="$(jq -r '.critical_counts.relations' "$CONTRACT_BEFORE")"
MIGRATIONS="$(jq -r '.critical_counts.migrations' "$CONTRACT_BEFORE")"
HUBS_COUNT="$(jq -r '.critical_counts.hubs' "$CONTRACT_BEFORE")"
ACTIVE_FILES="$(jq -r '.critical_counts.active_owned_files' "$CONTRACT_BEFORE")"

recovery_require_cluster_identity
require_backup_guard
require_pgsql_source
if [[ -n "$PARENT_FREEZE_FENCE_CAPABILITY" ]]; then
  # The H5 freeze fence rejects every Pod CREATE/UPDATE in the namespace except
  # the exact read-only storage helper. PostgreSQL therefore cannot be replaced
  # during pg_dump. Pin it immediately before and after the stream instead of
  # retaining the older polling monitor used by legacy/durable lanes.
  require_exact_pgsql_source_now
else
  start_db_source_monitor || {
    if [[ -s "$DB_SOURCE_MONITOR_FAILURE" ]]; then
      printf 'PostgreSQL source monitor stopped at %s.\n' \
        "$(cat "$DB_SOURCE_MONITOR_FAILURE")" >&2
    else
      printf 'PostgreSQL source monitor did not complete its initial sweep in time.\n' >&2
    fi
    printf 'Could not start the exact PostgreSQL source monitor.\n' >&2
    exit 1
  }
fi
run_dump_stream() {
  if [[ "$BACKUP_MODE" == native-monthly ]]; then
    local monthly_operation_id="$RECOVERY_OPERATION_ID"
    MONTHLY_PGSQL_POD_UID="$PGSQL_POD_UID" \
    CHECKPOINT_RUNNER_GENERATION="$CHECKPOINT_RUNNER_GENERATION" \
    EXPECTED_KUBE_CONTEXT="$EXPECTED_KUBE_CONTEXT" NAMESPACE="$NAMESPACE" \
    RECOVERY_NAMESPACE_UID="$RECOVERY_NAMESPACE_UID" RECOVERY_PVC_UID="$RECOVERY_PVC_UID" \
    RECOVERY_OPERATION_ID="$RECOVERY_OPERATION_ID" \
      recovery_kubectl_stream_guarded 3600 \
        "${DUMP_STREAM_GUARD_ARGS[@]}" -- --monthly-native-pair \
        "$MONTHLY_NATIVE_SOURCE_PATH" "$MONTHLY_NATIVE_JOURNAL_PATH" \
        "$MONTHLY_NATIVE_MONTH" "$monthly_operation_id" "$CONTRACT_BEFORE"
    return
  fi
  # Expansion is intentionally deferred to the shell inside the PostgreSQL pod.
  # shellcheck disable=SC2016
  recovery_kubectl_stream_guarded 3600 \
    "${DUMP_STREAM_GUARD_ARGS[@]}" -- \
    exec -n "$NAMESPACE" "$PGSQL_POD" -- \
    sh -ec 'pg_dump -U "$POSTGRES_USER" --format=plain retdb'
}
if [[ "$BACKUP_MODE" == native-monthly ]]; then
  if run_dump_stream >"$PARTIAL_PATH"; then dump_status=0; else dump_status=$?; fi
elif run_dump_stream | gzip -9 >"$PARTIAL_PATH"; then
  dump_status=0
else
  dump_status=$?
fi
source_monitor_stop_mode=stop
[[ "$dump_status" == 0 ]] || source_monitor_stop_mode=revoke
if [[ -n "$PARENT_FREEZE_FENCE_CAPABILITY" ]] ||
   stop_db_source_monitor "$source_monitor_stop_mode"; then
  source_monitor_status=0
else
  source_monitor_status=$?
fi
if [[ "$dump_status" != 0 || "$source_monitor_status" != 0 ]]; then
  printf 'Database dump stream or its exact PostgreSQL source monitor failed.\n' >&2
  exit 1
fi
chmod 600 "$PARTIAL_PATH"

if [[ "$BACKUP_MODE" == sql ]]; then
  gzip -t "$PARTIAL_PATH"
  gzip -cd "$PARTIAL_PATH" > "$SQL_CHECK_PATH"
fi

require_backup_guard
require_pgsql_source
if ! recovery_capture_live_database_contract "$PGSQL_POD" "$CONTRACT_AFTER" ||
   ! recovery_database_contracts_match "$CONTRACT_BEFORE" "$CONTRACT_AFTER"; then
  printf 'Database contract changed while the dump was being captured.\n' >&2
  exit 1
fi
require_backup_guard
require_pgsql_source

if [[ "$BACKUP_MODE" == native-monthly ]]; then
  # The same complete pre/post SQL contract is required. Physical snapshots
  # carry its hash, not a fabricated SQL-stream hash or a DB-only acceptance.
  command node "$SCRIPT_DIR/monthly-native-bundle.mjs" pair \
    "$MONTHLY_NATIVE_SOURCE_PATH" "$PARTIAL_PATH" "$CONTRACT_AFTER"
  jq -eS '.' "$CONTRACT_AFTER" >"$CONTRACT_BOUND"
  chmod 600 "$CONTRACT_BOUND"
elif ! recovery_bind_database_contract_to_dump \
  "$CONTRACT_AFTER" "$SQL_CHECK_PATH" "$CONTRACT_BOUND"; then
  printf 'Could not bind the complete SQL stream to its database contract.\n' >&2
  exit 1
fi

if [[ "$BACKUP_MODE" == sql ]]; then
if ! grep -Eq '^CREATE SCHEMA (ret0|ret0_admin);' "$SQL_CHECK_PATH" ||
   ! recovery_validate_sql_dump_contract "$SQL_CHECK_PATH" ||
   ! recovery_validate_database_contract_against_dump "$CONTRACT_BOUND" "$SQL_CHECK_PATH"; then
  printf 'Dump verification failed: the complete critical Reticulum SQL contract is missing.\n' >&2
  exit 1
fi
if ! DUMP_HUBS_COUNT="$(recovery_dump_copy_row_count "$SQL_CHECK_PATH" hubs)"; then
  printf 'Dump verification failed: ret0.hubs does not have exactly one complete COPY block.\n' >&2
  exit 1
fi
if ! DUMP_ACTIVE_UUIDS="$(recovery_extract_active_owned_file_uuids "$SQL_CHECK_PATH")"; then
  printf 'Dump verification failed: ret0.owned_files does not have exactly one complete COPY block.\n' >&2
  exit 1
fi
DUMP_ACTIVE_COUNT="$(printf '%s\n' "$DUMP_ACTIVE_UUIDS" | sed '/^$/d' | wc -l | tr -d ' ')"
DUMP_ACTIVE_UNIQUE_COUNT="$(printf '%s\n' "$DUMP_ACTIVE_UUIDS" | sed '/^$/d' | sort -u | wc -l | tr -d ' ')"
if [[ "$DUMP_HUBS_COUNT" != "$HUBS_COUNT" || "$DUMP_ACTIVE_COUNT" != "$ACTIVE_FILES" ||
      "$DUMP_ACTIVE_UNIQUE_COUNT" != "$DUMP_ACTIVE_COUNT" ]]; then
  printf 'Dump verification failed: Hubs/active-owned-file counts do not match the pre-dump baseline.\n' >&2
  exit 1
fi
if printf '%s\n' "$DUMP_ACTIVE_UUIDS" | sed '/^$/d' | awk '
  $0 !~ /^[A-Za-z0-9._-]+$/ { unsafe=1 }
  END { exit unsafe ? 0 : 1 }
'; then
  printf 'Dump verification failed: an unsafe active owned-file UUID is present.\n' >&2
  exit 1
fi
fi

# Arm cleanup before each no-clobber hard link. If publication completes but
# the shell is interrupted before it can observe the status, inode equality
# still proves whether this child owns the final pathname.
OUTPUT_PUBLISHED_IDENTITY="$(backup_private_file_identity "$PARTIAL_PATH")"
[[ "$OUTPUT_PUBLISHED_IDENTITY" == "$PARTIAL_OWNED_IDENTITY" ]] || {
  printf 'Database dump staging identity or mode changed unexpectedly.\n' >&2
  exit 1
}
OUTPUT_PUBLISHED=1
if publish_private_file_no_clobber \
    "$PARTIAL_PATH" "$OUTPUT_PATH" "$OUTPUT_PUBLISHED_IDENTITY"; then
  :
else
  printf 'Could not publish the database dump.\n' >&2
  exit 1
fi
[[ "$(backup_private_file_identity "$OUTPUT_PATH")" == \
   "$OUTPUT_PUBLISHED_IDENTITY" ]] || {
  printf 'Published database dump identity or mode changed unexpectedly.\n' >&2
  exit 1
}

CONTRACT_PUBLISHED_IDENTITY="$(backup_private_file_identity "$CONTRACT_BOUND")"
[[ "$CONTRACT_PUBLISHED_IDENTITY" == "$CONTRACT_BOUND_OWNED_IDENTITY" ]] || {
  printf 'Database contract staging identity or mode changed unexpectedly.\n' >&2
  exit 1
}
CONTRACT_PUBLISHED=1
if publish_private_file_no_clobber \
    "$CONTRACT_BOUND" "$CONTRACT_OUTPUT_PATH" \
    "$CONTRACT_PUBLISHED_IDENTITY"; then
  :
else
  printf 'Could not publish the database contract.\n' >&2
  exit 1
fi
[[ "$(backup_private_file_identity "$CONTRACT_OUTPUT_PATH")" == \
   "$CONTRACT_PUBLISHED_IDENTITY" ]] || {
  printf 'Published database contract identity or mode changed unexpectedly.\n' >&2
  exit 1
}
if [[ "$(backup_private_file_identity "$OUTPUT_PATH" 2>/dev/null || :)" != \
        "$OUTPUT_PUBLISHED_IDENTITY" ||
      "$(backup_private_file_identity "$CONTRACT_OUTPUT_PATH" 2>/dev/null || :)" != \
        "$CONTRACT_PUBLISHED_IDENTITY" ]]; then
  printf 'Published database backup artifact ownership or mode changed unexpectedly.\n' >&2
  exit 1
fi

SIZE_BYTES="$(recovery_file_size_bytes "$OUTPUT_PATH")"
SHA256="$(recovery_sha256_file "$OUTPUT_PATH" | awk '{print $1}')"

if [[ "$BACKUP_MODE" == sql ]]; then
  printf 'Reticulum database backup completed: path=%s schema_tables=%s migrations=%s hubs=%s active_files=%s size_bytes=%s sha256=%s\n' \
    "$OUTPUT_PATH" "$SCHEMA_TABLES" "$MIGRATIONS" "$HUBS_COUNT" "$ACTIVE_FILES" "$SIZE_BYTES" "$SHA256"
else
  printf 'Reticulum native snapshot pair captured: path=%s (parent join/resume still required)\n' "$OUTPUT_PATH"
fi
trap '' INT TERM
BACKUP_SUCCEEDED=1
cleanup_backup
trap - EXIT

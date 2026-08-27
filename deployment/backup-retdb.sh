#!/usr/bin/env bash

# Exports Reticulum's PostgreSQL database as a gzip-compressed plain SQL dump.
# The resulting format is consumed by restore-retdb.sh.

set -euo pipefail
umask 077

if [[ $# -ne 1 ]]; then
  printf 'Usage: %s /path/to/retdb-YYYYMMDD-HHMMSS.sql.gz\n' "$0" >&2
  exit 2
fi

OUTPUT_PATH="$1"
OUTPUT_DIR="$(dirname "$OUTPUT_PATH")"
CONTRACT_OUTPUT_PATH="$OUTPUT_DIR/database-contract.json"
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
    "$RECOVERY_OPERATION_OWNER" &&
    recovery_stream_guard_progress_value \
      "$PARENT_DURABLE_MONITOR_PROGRESS_PATH" \
      "$PARENT_DURABLE_MONITOR_AUTHORITY_SHA256" >/dev/null &&
    recovery_require_recovery_operation_fence_state active \
      "$PARENT_RECOVERY_OPERATION_FENCE_ACTIVE_IDENTITY"
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
  [[ "$COORDINATED" == 1 &&
     "${RECOVERY_OPERATION_OWNER:-}" == checkpoint-backup &&
     -n "${RECOVERY_CONSUMER_CONTRACT_JSON:-}" &&
     "$CHECKPOINT_RUNNER_GENERATION" =~ ^(legacy-absent|durable-v2)$ ]] ||
    return 1
  recovery_require_operation_lock || return 1
  for deployment in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
    recovery_require_consumer_contract_entry "$RECOVERY_CONSUMER_CONTRACT_JSON" \
      "$deployment" 0 || return 1
  done
  if [[ -n "$PARENT_FREEZE_FENCE_CAPABILITY" ]]; then
    require_parent_freeze_fence_capability || return 1
  else
    require_parent_writer_monitor_capability || return 1
  fi
  recovery_require_checkpoint_runner_quiescence_exact \
    "$CHECKPOINT_RUNNER_GENERATION" \
    "$CHECKPOINT_DURABLE_FENCE_BASELINE_PATH" \
    "$CHECKPOINT_DURABLE_FENCE_BASELINE_SHA256" || return 1
  if [[ "$CHECKPOINT_RUNNER_GENERATION" == durable-v2 ]]; then
    require_parent_durable_monitor_capability
  fi
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

monitor_exact_pgsql_source() {
  local progress=0
  while [[ ! -e "$DB_SOURCE_MONITOR_STOP" ]]; do
    recovery_require_cluster_identity || {
      printf 'cluster-identity\n' >"$DB_SOURCE_MONITOR_FAILURE"; return 1;
    }
    recovery_require_operation_serialization || {
      printf 'serialization\n' >"$DB_SOURCE_MONITOR_FAILURE"; return 1;
    }
    recovery_require_operation_lock || {
      printf 'operation-lock\n' >"$DB_SOURCE_MONITOR_FAILURE"; return 1;
    }
    require_backup_guard || {
      printf 'backup-guard\n' >"$DB_SOURCE_MONITOR_FAILURE"; return 1;
    }
    require_exact_pgsql_source_now || {
      printf 'pgsql-source\n' >"$DB_SOURCE_MONITOR_FAILURE"; return 1;
    }
    progress=$((progress + 1))
    if ! recovery_write_stream_guard_progress \
        "$DB_SOURCE_MONITOR_PROGRESS" "$progress"; then
      printf 'progress_publish_failed\n' >"$DB_SOURCE_MONITOR_FAILURE"
      return 1
    fi
    sleep "$DB_SOURCE_MONITOR_POLL_SECONDS"
  done
}

stop_db_source_monitor() {
  local monitor_status=0
  if [[ -n "$DB_SOURCE_MONITOR_PID" ]]; then
    : >"$DB_SOURCE_MONITOR_STOP"
    if wait "$DB_SOURCE_MONITOR_PID"; then
      monitor_status=0
    else
      monitor_status=$?
    fi
    DB_SOURCE_MONITOR_PID=""
    DB_SOURCE_MONITOR_START_IDENTITY=""
  fi
  if [[ -n "$DB_SOURCE_MONITOR_FAILURE" &&
        -s "$DB_SOURCE_MONITOR_FAILURE" ]]; then
    monitor_status=1
  fi
  DUMP_STREAM_GUARD_ARGS=()
  [[ "$monitor_status" == 0 ]]
}

start_db_source_monitor() {
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
  DB_SOURCE_MONITOR_POLL_SECONDS="$(recovery_stream_poll_seconds)" || return 1
  (
    # Prevent Bash 3.2 from tail-execing a nested kubectl and replacing the
    # long-lived process whose start identity is passed to the stream guard.
    db_source_monitor_exit_status=0
    trap 'db_source_monitor_exit_status=$?; trap - EXIT; exit "$db_source_monitor_exit_status"' EXIT
    monitor_exact_pgsql_source
  ) &
  DB_SOURCE_MONITOR_PID=$!
  if ! DB_SOURCE_MONITOR_START_IDENTITY="$(
    recovery_process_start_identity "$DB_SOURCE_MONITOR_PID"
  )"; then
    : >"$DB_SOURCE_MONITOR_STOP"
    wait "$DB_SOURCE_MONITOR_PID" 2>/dev/null || :
    DB_SOURCE_MONITOR_PID=""
    DB_SOURCE_MONITOR_START_IDENTITY=""
    return 1
  fi
  if ! DB_SOURCE_MONITOR_MAX_STALE_SECONDS="$(
       recovery_stream_guard_max_stale_seconds
     )" ||
     ! DB_SOURCE_MONITOR_INITIAL_DEADLINE_SECONDS="$(
       recovery_stream_guard_initial_deadline_seconds
     )" ||
     ! recovery_wait_for_stream_guard_initial_progress \
       "$DB_SOURCE_MONITOR_PID" "$DB_SOURCE_MONITOR_START_IDENTITY" \
       "$DB_SOURCE_MONITOR_FAILURE" "$DB_SOURCE_MONITOR_PROGRESS" \
       "$DB_SOURCE_MONITOR_INITIAL_DEADLINE_SECONDS"; then
    : >"$DB_SOURCE_MONITOR_STOP"
    wait "$DB_SOURCE_MONITOR_PID" 2>/dev/null || :
    DB_SOURCE_MONITOR_PID=""
    DB_SOURCE_MONITOR_START_IDENTITY=""
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
  stop_db_source_monitor || :
  rm -f -- "$SQL_CHECK_PATH" "$CONTRACT_BEFORE" "$CONTRACT_AFTER" || :
  [[ -z "$DB_SOURCE_MONITOR_STOP" ]] ||
    rm -f -- "$DB_SOURCE_MONITOR_STOP" || :
  [[ -z "$DB_SOURCE_MONITOR_FAILURE" ]] ||
    rm -f -- "$DB_SOURCE_MONITOR_FAILURE" || :
  [[ -z "$DB_SOURCE_MONITOR_PROGRESS" ]] ||
    rm -f -- "$DB_SOURCE_MONITOR_PROGRESS" \
      "${DB_SOURCE_MONITOR_PROGRESS}.next" || :
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
  # Expansion is intentionally deferred to the shell inside the PostgreSQL pod.
  # shellcheck disable=SC2016
  recovery_kubectl_stream_guarded 3600 \
    "${DUMP_STREAM_GUARD_ARGS[@]}" -- \
    exec -n "$NAMESPACE" "$PGSQL_POD" -- \
    sh -ec 'pg_dump -U "$POSTGRES_USER" --format=plain retdb'
}
if run_dump_stream | gzip -9 >"$PARTIAL_PATH"; then
  dump_status=0
else
  dump_status=$?
fi
if [[ -n "$PARENT_FREEZE_FENCE_CAPABILITY" ]] || stop_db_source_monitor; then
  source_monitor_status=0
else
  source_monitor_status=$?
fi
if [[ "$dump_status" != 0 || "$source_monitor_status" != 0 ]]; then
  printf 'Database dump stream or its exact PostgreSQL source monitor failed.\n' >&2
  exit 1
fi
chmod 600 "$PARTIAL_PATH"

gzip -t "$PARTIAL_PATH"
gzip -cd "$PARTIAL_PATH" > "$SQL_CHECK_PATH"

require_backup_guard
require_pgsql_source
if ! recovery_capture_live_database_contract "$PGSQL_POD" "$CONTRACT_AFTER" ||
   ! recovery_database_contracts_match "$CONTRACT_BEFORE" "$CONTRACT_AFTER"; then
  printf 'Database contract changed while the dump was being captured.\n' >&2
  exit 1
fi
require_backup_guard
require_pgsql_source

if ! recovery_bind_database_contract_to_dump \
  "$CONTRACT_AFTER" "$SQL_CHECK_PATH" "$CONTRACT_BOUND"; then
  printf 'Could not bind the complete SQL stream to its database contract.\n' >&2
  exit 1
fi

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

printf 'Reticulum database backup completed: path=%s schema_tables=%s migrations=%s hubs=%s active_files=%s size_bytes=%s sha256=%s\n' \
  "$OUTPUT_PATH" "$SCHEMA_TABLES" "$MIGRATIONS" "$HUBS_COUNT" "$ACTIVE_FILES" "$SIZE_BYTES" "$SHA256"
trap '' INT TERM
BACKUP_SUCCEEDED=1
cleanup_backup
trap - EXIT

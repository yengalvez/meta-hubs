#!/usr/bin/env bash

# Capture ret-pvc while every Reticulum/DB writer is held at zero by the
# checkpoint coordinator. The only PVC consumer is a read-only, operation-
# unique helper protected by an admitted deny-all NetworkPolicy.

set -Eeuo pipefail
umask 077

if [[ $# -ne 2 ]]; then
  printf 'Usage: %s /path/to/ret-storage-STAMP.tar.gz /path/to/deployment-images.json\n' "$0" >&2
  exit 2
fi

OUTPUT_PATH="$1"
INVENTORY_PATH="$2"
NAMESPACE="${NAMESPACE:-hcce}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
WORK_DIR=""
WORK_DIR_PRIVATE_TOKEN=""
WORK_DIR_CLEANUP_ATTEMPTED=0
WORK_DIR_RETIRED=0
PARTIAL_PATH=""
PARTIAL_OWNED_IDENTITY=""
PARTIAL_CLEANUP_ATTEMPTED=0
BACKUP_SUCCEEDED=0
OUTPUT_PUBLISHED=0
OUTPUT_PUBLISHED_IDENTITY=""
BACKUP_SETUP_PENDING_SIGNAL_STATUS=0
STORAGE_SETUP_STATUS=0
STORAGE_PENDING_SIGNAL_STATUS=0
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
  YENHUBS_PARENT_RECOVERY_OPERATION_FENCE_ACTIVE_IDENTITY
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
unset YENHUBS_PARENT_LEASE_HOLDER YENHUBS_PARENT_LEASE_UID \
  YENHUBS_PARENT_PROCESS_PID YENHUBS_PARENT_PROCESS_START_IDENTITY

require_parent_writer_monitor_capability() {
  [[ "$(recovery_monitor_authority_sha256_for_ready \
      "$PARENT_WRITER_MONITOR_READY_PATH" 2>/dev/null || :)" == \
     "$PARENT_WRITER_MONITOR_AUTHORITY_SHA256" ]] &&
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
    "$RECOVERY_OPERATION_OWNER" &&
    recovery_stream_guard_progress_value \
      "$PARENT_WRITER_MONITOR_PROGRESS_PATH" \
      "$PARENT_WRITER_MONITOR_AUTHORITY_SHA256" >/dev/null
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

if ! require_parent_writer_monitor_capability ||
   ! PARENT_WRITER_MONITOR_MAX_STALE_SECONDS="$(
     recovery_stream_guard_max_stale_seconds
   )"; then
  printf 'Quiesced storage backup requires the live parent writer monitor guard.\n' >&2
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
if [[ "$CHECKPOINT_RUNNER_GENERATION" == durable-v2 ]]; then
  if ! require_parent_durable_monitor_capability ||
     ! PARENT_DURABLE_MONITOR_MAX_STALE_SECONDS="$(
       recovery_stream_guard_max_stale_seconds
     )"; then
    printf 'Quiesced durable storage backup requires the live parent durable monitor guard.\n' >&2
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
  printf 'Legacy quiesced storage backup rejects inherited durable capabilities.\n' >&2
  exit 1
fi

require_parent_checkpoint_guards() {
  recovery_require_operation_lock || return 1
  require_parent_writer_monitor_capability || return 1
  recovery_require_checkpoint_runner_quiescence_exact \
    "$CHECKPOINT_RUNNER_GENERATION" \
    "$CHECKPOINT_DURABLE_FENCE_BASELINE_PATH" \
    "$CHECKPOINT_DURABLE_FENCE_BASELINE_SHA256" || return 1
  if [[ "$CHECKPOINT_RUNNER_GENERATION" == durable-v2 ]]; then
    require_parent_durable_monitor_capability
  fi
}

[[ ! -e "$OUTPUT_PATH" && ! -L "$OUTPUT_PATH" ]] || {
  printf 'Refusing to overwrite an existing storage backup.\n' >&2
  exit 1
}
recovery_require_regular_direct_file "$INVENTORY_PATH" || {
  printf 'A direct regular deployment inventory is required.\n' >&2
  exit 1
}
[[ "${RECOVERY_OPERATION_OWNER:-}" == checkpoint-backup ]] || {
  printf 'Quiesced storage backup requires the checkpoint-backup owner.\n' >&2
  exit 1
}
[[ "$CHECKPOINT_RUNNER_GENERATION" =~ ^(legacy-absent|durable-v2)$ ]] || {
  printf 'Quiesced storage backup requires an exact checkpoint runner generation.\n' >&2
  exit 1
}
if [[ -z "${RECOVERY_CONSUMER_CONTRACT_JSON:-}" ]] ||
   ! recovery_consumer_contract_is_acceptable "$RECOVERY_CONSUMER_CONTRACT_JSON"; then
  printf 'Quiesced storage backup requires the exact post-lock consumer contract.\n' >&2
  exit 1
fi

storage_backup_file_identity() {
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

storage_backup_private_file_identity() {
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

remove_owned_storage_backup_file() {
  local expected_identity="$1" path="$2" current_identity
  [[ -n "$expected_identity" ]] || return 1
  if ! current_identity="$(storage_backup_file_identity "$path" 2>/dev/null)"; then
    [[ ! -e "$path" && ! -L "$path" ]]
    return
  fi
  [[ "$current_identity" == "$expected_identity" ]] || return 1
  if ! rm -f -- "$path"; then
    printf 'Could not remove an incomplete owned storage backup artifact: %s\n' \
      "$path" >&2
    return 1
  fi
}

cleanup_owned_storage_work_dir() {
  [[ "$WORK_DIR_RETIRED" == 0 ]] || return 0
  [[ "$WORK_DIR_CLEANUP_ATTEMPTED" == 0 ]] || return 1
  WORK_DIR_CLEANUP_ATTEMPTED=1
  [[ -n "$WORK_DIR" && -n "$WORK_DIR_PRIVATE_TOKEN" ]] || return 1
  if recovery_cleanup_private_directory "$WORK_DIR_PRIVATE_TOKEN" \
      f:archive-blobs f:archive-meta f:archive-paths f:blobs \
      f:database-contract-after.json f:database-contract-before.json \
      f:db-active-after f:db-active-before f:meta \
      f:monitor-failure f:monitor-progress f:monitor-progress.next \
      f:monitor-stop f:paths-before; then
    WORK_DIR_RETIRED=1
    WORK_DIR_PRIVATE_TOKEN=""
    WORK_DIR=""
    return 0
  fi
  printf 'Private storage backup work directory could not be removed exactly; any validated empty owned orphan was preserved.\n' >&2
  return 1
}

cleanup_owned_storage_partial() {
  [[ "$PARTIAL_CLEANUP_ATTEMPTED" == 0 ]] || return 0
  PARTIAL_CLEANUP_ATTEMPTED=1
  [[ -z "$PARTIAL_PATH" ]] ||
    remove_owned_storage_backup_file "$PARTIAL_OWNED_IDENTITY" "$PARTIAL_PATH"
}

cleanup_storage_local_artifacts() {
  local cleanup_status=0
  if [[ "$BACKUP_SUCCEEDED" != 1 && "$OUTPUT_PUBLISHED" == 1 ]] &&
     ! remove_owned_storage_backup_file \
       "$OUTPUT_PUBLISHED_IDENTITY" "$OUTPUT_PATH"; then
    cleanup_status=1
  fi
  cleanup_owned_storage_partial || cleanup_status=1
  cleanup_owned_storage_work_dir || cleanup_status=1
  [[ "$cleanup_status" == 0 ]]
}

early_storage_cleanup() {
  local status="$?"
  trap - EXIT ERR
  trap '' INT TERM
  if ! cleanup_storage_local_artifacts && [[ "$status" == 0 ]]; then
    status=1
  fi
  exit "$status"
}

storage_backup_record_setup_signal() {
  local status="$1"
  if [[ "$BACKUP_SETUP_PENDING_SIGNAL_STATUS" == 0 ]]; then
    BACKUP_SETUP_PENDING_SIGNAL_STATUS="$status"
    trap '' INT TERM
  fi
}

trap early_storage_cleanup EXIT
trap 'storage_backup_record_setup_signal 130' INT
trap 'storage_backup_record_setup_signal 143' TERM
STORAGE_SETUP_STATUS=0
if ! (trap '' INT TERM; mkdir -p "$(dirname "$OUTPUT_PATH")"); then
  STORAGE_SETUP_STATUS=1
elif ! WORK_DIR="$(
    trap '' INT TERM
    mktemp -d "${TMPDIR:-/tmp}/yenhubs-quiesced-storage.XXXXXX"
  )"; then
  STORAGE_SETUP_STATUS=1
elif ! WORK_DIR="$(
    trap '' INT TERM
    cd "$WORK_DIR" && pwd -P
  )"; then
  STORAGE_SETUP_STATUS=1
elif ! WORK_DIR_PRIVATE_TOKEN="$(
    trap '' INT TERM
    recovery_capture_private_directory_token "$WORK_DIR"
  )"; then
  STORAGE_SETUP_STATUS=1
elif ! PARTIAL_PATH="$(
    trap '' INT TERM
    mktemp "${OUTPUT_PATH}.partial.XXXXXX"
  )"; then
  STORAGE_SETUP_STATUS=1
elif ! PARTIAL_OWNED_IDENTITY="$(
    trap '' INT TERM
    storage_backup_private_file_identity "$PARTIAL_PATH"
  )"; then
  STORAGE_SETUP_STATUS=1
fi
trap 'exit 130' INT
trap 'exit 143' TERM
STORAGE_PENDING_SIGNAL_STATUS="$BACKUP_SETUP_PENDING_SIGNAL_STATUS"
BACKUP_SETUP_PENDING_SIGNAL_STATUS=0
if [[ "$STORAGE_PENDING_SIGNAL_STATUS" != 0 ]]; then
  exit "$STORAGE_PENDING_SIGNAL_STATUS"
fi
if [[ "$STORAGE_SETUP_STATUS" != 0 ]]; then
  printf 'Private storage backup local identities could not be bound; preserving any untrusted orphan.\n' >&2
  exit 1
fi
PATHS_BEFORE="$WORK_DIR/paths-before"
ARCHIVE_PATHS="$WORK_DIR/archive-paths"
DB_ACTIVE_BEFORE="$WORK_DIR/db-active-before"
DB_ACTIVE_AFTER="$WORK_DIR/db-active-after"
CONTRACT_BEFORE="$WORK_DIR/database-contract-before.json"
CONTRACT_AFTER="$WORK_DIR/database-contract-after.json"
MONITOR_STOP="$WORK_DIR/monitor-stop"
MONITOR_FAILURE="$WORK_DIR/monitor-failure"
MONITOR_PROGRESS="$WORK_DIR/monitor-progress"
HELPER_POD="ret-storage-backup-${RECOVERY_OPERATION_ID:0:12}"
HELPER_POLICY="ret-storage-backup-deny-${RECOVERY_OPERATION_ID:0:12}"
HELPER_POD_UID=""
HELPER_POLICY_UID=""
HELPER_POD_CREATED=0
HELPER_POLICY_CREATED=0
BACKUP_CHILD_PENDING_SIGNAL_STATUS=0
BACKUP_CHILD_SIGNAL_OWNER_SUBSHELL="$BASH_SUBSHELL"
MONITOR_PID=""
MONITOR_START_IDENTITY=""
MONITOR_MAX_STALE_SECONDS=""
MONITOR_INITIAL_DEADLINE_SECONDS=""
MONITOR_POLL_SECONDS=""
: >"$MONITOR_FAILURE"
: >"$MONITOR_PROGRESS"
chmod 600 "$MONITOR_FAILURE" "$MONITOR_PROGRESS"

publish_private_storage_backup_no_clobber() {
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

helper_pod_is_exact() {
  local pod_json="$1"
  local pod_uid="${2:-$HELPER_POD_UID}"
  [[ -n "$pod_uid" ]] &&
    recovery_storage_helper_pod_is_exact "$pod_json" "$HELPER_POD" \
      "$pod_uid" ret-storage-backup "$RET_IMAGE" true
}

helper_policy_is_exact() {
  local policy_json="$1"
  local policy_uid="${2:-$HELPER_POLICY_UID}"
  [[ -n "$policy_uid" ]] &&
    recovery_storage_helper_network_policy_is_exact "$policy_json" \
      "$HELPER_POLICY" "$policy_uid" ret-storage-backup
}

capture_helper_pod_identity() {
  local pod_json="${1:-}" pod_uid
  if [[ -z "$pod_json" ]]; then
    pod_json="$(recovery_kubectl get pod "$HELPER_POD" \
      -n "$NAMESPACE" -o json)" || return 1
  fi
  pod_uid="$(jq -er '.metadata.uid | select(type == "string" and length > 0)' \
    <<<"$pod_json")" || return 1
  helper_pod_is_exact "$pod_json" "$pod_uid" || return 1
  HELPER_POD_UID="$pod_uid"
}

capture_helper_policy_identity() {
  local policy_json="${1:-}" policy_uid
  if [[ -z "$policy_json" ]]; then
    policy_json="$(recovery_kubectl get networkpolicy "$HELPER_POLICY" \
      -n "$NAMESPACE" -o json)" || return 1
  fi
  policy_uid="$(jq -er '.metadata.uid | select(type == "string" and length > 0)' \
    <<<"$policy_json")" || return 1
  helper_policy_is_exact "$policy_json" "$policy_uid" || return 1
  HELPER_POLICY_UID="$policy_uid"
}

acquire_helper_policy() {
  local policy_json="" acquisition_status=0
  [[ "$HELPER_POLICY_CREATED" == 0 && -z "$HELPER_POLICY_UID" ]] || return 2
  BACKUP_CHILD_PENDING_SIGNAL_STATUS=0
  trap 'backup_child_record_pending_signal 130' INT
  trap 'backup_child_record_pending_signal 143' TERM
  if policy_json="$(recovery_kubectl_mutate create -f - -o json)" &&
     capture_helper_policy_identity "$policy_json"; then
    HELPER_POLICY_CREATED=1
  else
    HELPER_POLICY_UID=""
    if recovery_require_operation_lock &&
       policy_json="$(recovery_kubectl get networkpolicy "$HELPER_POLICY" \
         -n "$NAMESPACE" -o json)" &&
       capture_helper_policy_identity "$policy_json"; then
      # Treat a failed create response as ambiguous only when GET proves the
      # private operation token, lock UID and admitted deny-all spec exactly.
      HELPER_POLICY_CREATED=1
    else
      HELPER_POLICY_UID=""
      acquisition_status=1
    fi
  fi
  if [[ "$HELPER_POLICY_CREATED" == 1 ]] &&
     ! recovery_require_operation_lock; then
    acquisition_status=1
  fi
  backup_child_finish_capability_boundary "$acquisition_status"
}

acquire_helper_pod() {
  local pod_json="" acquisition_status=0
  [[ "$HELPER_POD_CREATED" == 0 && -z "$HELPER_POD_UID" ]] || return 2
  BACKUP_CHILD_PENDING_SIGNAL_STATUS=0
  trap 'backup_child_record_pending_signal 130' INT
  trap 'backup_child_record_pending_signal 143' TERM
  if pod_json="$(recovery_kubectl_mutate create -f - -o json)" &&
     capture_helper_pod_identity "$pod_json"; then
    HELPER_POD_CREATED=1
  else
    HELPER_POD_UID=""
    if recovery_require_operation_lock &&
       pod_json="$(recovery_kubectl get pod "$HELPER_POD" \
         -n "$NAMESPACE" -o json)" &&
       capture_helper_pod_identity "$pod_json"; then
      # Name alone is never ownership. Reconciliation requires this exact
      # operation ID, token, lock UID and read-only helper spec.
      HELPER_POD_CREATED=1
    else
      HELPER_POD_UID=""
      acquisition_status=1
    fi
  fi
  if [[ "$HELPER_POD_CREATED" == 1 ]] &&
     ! recovery_require_operation_lock; then
    acquisition_status=1
  fi
  backup_child_finish_capability_boundary "$acquisition_status"
}

require_helper_pod() {
  local pod_json current_uid
  pod_json="$(recovery_kubectl get pod "$HELPER_POD" -n "$NAMESPACE" -o json)" || return 1
  current_uid="$(jq -er '.metadata.uid | select(type == "string" and length > 0)' \
    <<<"$pod_json")" || return 1
  [[ "$current_uid" == "$HELPER_POD_UID" ]] && helper_pod_is_exact "$pod_json"
}

require_helper_policy() {
  local policy_json current_uid
  policy_json="$(recovery_kubectl get networkpolicy "$HELPER_POLICY" \
    -n "$NAMESPACE" -o json)" || return 1
  current_uid="$(jq -er '.metadata.uid | select(type == "string" and length > 0)' \
    <<<"$policy_json")" || return 1
  [[ "$current_uid" == "$HELPER_POLICY_UID" ]] && helper_policy_is_exact "$policy_json"
}

stop_monitor() {
  local status=0
  if [[ -n "$MONITOR_PID" ]]; then
    : >"$MONITOR_STOP"
    if wait "$MONITOR_PID"; then status=0; else status=$?; fi
    MONITOR_PID=""
    MONITOR_START_IDENTITY=""
  fi
  MONITOR_START_IDENTITY=""
  MONITOR_MAX_STALE_SECONDS=""
  MONITOR_INITIAL_DEADLINE_SECONDS=""
  [[ "$status" == 0 && ! -s "$MONITOR_FAILURE" ]]
}

delete_helper_pod() {
  [[ "$HELPER_POD_CREATED" == 1 ]] || return 0
  recovery_require_operation_lock || return 1
  recovery_require_exact_pvc_consumers ret-pvc "$HELPER_POD" || return 1
  require_helper_pod || return 1
  recovery_delete_namespaced_with_uid pod "$HELPER_POD" "$HELPER_POD_UID" 180 || return 1
  HELPER_POD_CREATED=0
  HELPER_POD_UID=""
  recovery_require_exact_pvc_consumers ret-pvc
}

delete_helper_policy() {
  [[ "$HELPER_POLICY_CREATED" == 1 ]] || return 0
  recovery_require_operation_lock || return 1
  require_helper_policy || return 1
  recovery_delete_namespaced_with_uid networkpolicy "$HELPER_POLICY" \
    "$HELPER_POLICY_UID" 60 || return 1
  HELPER_POLICY_CREATED=0
  HELPER_POLICY_UID=""
}

cleanup() {
  local status="$?" cleanup_status=0 pod_status=0
  trap - EXIT ERR
  trap '' INT TERM
  if [[ "$BACKUP_SUCCEEDED" != 1 && "$OUTPUT_PUBLISHED" == 1 ]] &&
     ! remove_owned_storage_backup_file \
       "$OUTPUT_PUBLISHED_IDENTITY" "$OUTPUT_PATH"; then
    cleanup_status=1
  fi
  cleanup_owned_storage_partial || cleanup_status=1
  stop_monitor || cleanup_status=1
  if ! delete_helper_pod; then pod_status=1; cleanup_status=1; fi
  if [[ "$pod_status" == 0 ]] && ! delete_helper_policy; then cleanup_status=1; fi
  cleanup_owned_storage_work_dir || cleanup_status=1
  if [[ "$status" == 0 && "$cleanup_status" != 0 ]]; then status=1; fi
  exit "$status"
}

interrupted() {
  local status="$1"
  exit "$status"
}

backup_child_record_pending_signal() {
  local status="$1"
  [[ "$BASH_SUBSHELL" == "$BACKUP_CHILD_SIGNAL_OWNER_SUBSHELL" ]] || return 0
  [[ "$status" == 130 || "$status" == 143 ]] || return 2
  if [[ "$BACKUP_CHILD_PENDING_SIGNAL_STATUS" == 0 ]]; then
    BACKUP_CHILD_PENDING_SIGNAL_STATUS="$status"
    # Suppress repeats only across this bounded remote capability boundary.
    trap '' INT TERM
  fi
}

backup_child_signal_traps() {
  trap 'interrupted 130' INT
  trap 'interrupted 143' TERM
}

backup_child_finish_capability_boundary() {
  local acquisition_status="$1" pending_signal_status
  backup_child_signal_traps
  pending_signal_status="$BACKUP_CHILD_PENDING_SIGNAL_STATUS"
  BACKUP_CHILD_PENDING_SIGNAL_STATUS=0
  if [[ "$pending_signal_status" != 0 ]]; then
    interrupted "$pending_signal_status"
  fi
  [[ "$acquisition_status" == 0 ]]
}

trap cleanup EXIT
trap 'interrupted 130' INT
trap 'interrupted 143' TERM

recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
recovery_require_operation_lock
recovery_deployment_inventory_is_acceptable \
  "$INVENTORY_PATH" "$NAMESPACE" "$RECOVERY_NAMESPACE_UID" || {
  printf 'Deployment inventory is not the exact YenHubs 13-image contract.\n' >&2
  exit 1
}
RET_IMAGE="$(recovery_checkpoint_image_for_pair \
  "$INVENTORY_PATH" reticulum/reticulum ghcr.io/yengalvez/reticulum)" || {
  printf 'Inventory does not bind the trusted Reticulum helper image.\n' >&2
  exit 1
}

for deployment in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
  recovery_require_operation_lock
  recovery_require_consumer_contract_entry "$RECOVERY_CONSUMER_CONTRACT_JSON" \
    "$deployment" 0 || {
    printf 'A checkpoint writer is not held at its exact post-lock zero state: %s.\n' \
      "$deployment" >&2
    exit 1
  }
done
require_parent_checkpoint_guards
recovery_require_exact_pvc_consumers ret-pvc

PGSQL_PODS_JSON="$(recovery_kubectl get pod -n "$NAMESPACE" -l app=pgsql -o json)"
PGSQL_INFO="$(recovery_exact_ready_deployment_pod_info \
  "$PGSQL_PODS_JSON" pgsql pgsql)" || {
  printf 'Exactly one owned Ready PostgreSQL pod is required.\n' >&2
  exit 1
}
IFS=$'\t' read -r PGSQL_POD PGSQL_POD_UID PGSQL_DEPLOYMENT_UID <<<"$PGSQL_INFO"
PGSQL_POD_JSON="$(jq -cer '.items[0]' <<<"$PGSQL_PODS_JSON")"
require_pgsql_source() {
  recovery_require_pod_identity "$PGSQL_POD" "$PGSQL_POD_UID" &&
    recovery_require_pod_deployment_ownership \
      "$PGSQL_POD_JSON" pgsql "$PGSQL_DEPLOYMENT_UID"
}
require_pgsql_source
recovery_capture_live_database_contract "$PGSQL_POD" "$CONTRACT_BEFORE"
# Expansion is intentionally deferred to the PostgreSQL container.
# shellcheck disable=SC2016
recovery_kubectl exec -n "$NAMESPACE" "$PGSQL_POD" -- sh -ec \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d retdb -Atc "select owned_file_uuid from ret0.owned_files where state::text = '\''active'\'' order by owned_file_uuid"' \
  | tr -d '\r' | LC_ALL=C sort >"$DB_ACTIVE_BEFORE"
if [[ ! -s "$DB_ACTIVE_BEFORE" ]] ||
   [[ "$(wc -l <"$DB_ACTIVE_BEFORE" | tr -d ' ')" != \
      "$(LC_ALL=C sort -u "$DB_ACTIVE_BEFORE" | wc -l | tr -d ' ')" ]]; then
  printf 'Active owned-file DB baseline is empty or duplicated.\n' >&2
  exit 1
fi

recovery_require_operation_lock
if ! acquire_helper_policy <<EOF
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: $HELPER_POLICY
  namespace: $NAMESPACE
  labels:
    yenhubs.org/recovery-owner: ret-storage-backup
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
  printf 'Admitted backup NetworkPolicy differs from the exact deny-all contract.\n' >&2
  exit 1
fi

recovery_require_operation_lock
require_helper_policy
if ! acquire_helper_pod <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $HELPER_POD
  namespace: $NAMESPACE
  labels:
    yenhubs.org/recovery-owner: ret-storage-backup
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
          readOnly: true
  volumes:
    - name: storage
      persistentVolumeClaim:
        claimName: ret-pvc
        readOnly: true
EOF
then
  printf 'Admitted backup helper differs from the exact read-only contract.\n' >&2
  exit 1
fi
recovery_wait_for_pod_ready "$HELPER_POD" 180
require_helper_pod || {
  printf 'Admitted backup helper differs from the exact read-only contract.\n' >&2
  exit 1
}
recovery_require_exact_pvc_consumers ret-pvc "$HELPER_POD"

monitor() {
  local progress=0
  while [[ ! -e "$MONITOR_STOP" ]]; do
    if [[ "$CHECKPOINT_RUNNER_GENERATION" == legacy-absent ]] &&
       ! recovery_require_checkpoint_runner_quiescence_exact \
        "$CHECKPOINT_RUNNER_GENERATION" \
        "$CHECKPOINT_DURABLE_FENCE_BASELINE_PATH" \
        "$CHECKPOINT_DURABLE_FENCE_BASELINE_SHA256"; then
      printf 'checkpoint_runner_quiescence_failed\n' >"$MONITOR_FAILURE"
      return 1
    elif ! recovery_require_pvc_identity ret-pvc; then
      printf 'pvc_identity_failed\n' >"$MONITOR_FAILURE"
      return 1
    elif ! require_helper_policy; then
      printf 'helper_policy_failed\n' >"$MONITOR_FAILURE"
      return 1
    elif ! require_helper_pod; then
      printf 'helper_pod_failed\n' >"$MONITOR_FAILURE"
      return 1
    elif ! recovery_require_exact_pvc_consumers ret-pvc "$HELPER_POD"; then
      printf 'pvc_consumers_failed\n' >"$MONITOR_FAILURE"
      return 1
    fi
    progress=$((progress + 1))
    if ! recovery_write_stream_guard_progress "$MONITOR_PROGRESS" "$progress"; then
      printf 'progress_publish_failed\n' >"$MONITOR_FAILURE"
      return 1
    fi
    sleep "$MONITOR_POLL_SECONDS"
  done
}

recovery_kubectl exec -n "$NAMESPACE" "$HELPER_POD" -- sh -ec \
  'test -d /storage/owned; cd /storage; { find owned -type d -print | sed "s|$|/|"; find owned -type f -print; }' \
  | tr -d '\r' >"$PATHS_BEFORE"
recovery_storage_paths_file_is_exact "$PATHS_BEFORE" || {
  printf 'Source PVC violates the exact two-shard owned-file layout.\n' >&2
  exit 1
}
recovery_extract_storage_uuids "$PATHS_BEFORE" blob | LC_ALL=C sort >"$WORK_DIR/blobs"
recovery_extract_storage_uuids "$PATHS_BEFORE" meta.json | LC_ALL=C sort >"$WORK_DIR/meta"
cmp -s "$WORK_DIR/blobs" "$WORK_DIR/meta" || {
  printf 'Source PVC contains incomplete owned-file pairs.\n' >&2
  exit 1
}
missing_active="$(comm -23 "$DB_ACTIVE_BEFORE" "$WORK_DIR/blobs")"
[[ -z "$missing_active" ]] || {
  printf 'Source PVC is missing at least one active DB-owned file.\n' >&2
  exit 1
}

# Revalidate the full parent authority immediately before the local monitor is
# launched. During a durable stream the two parent monitor capabilities remain
# independent supervisor guards, so repeating their Kubernetes sweeps inside
# this storage-only guard would age the other guards without adding coverage.
# Legacy has no durable guard and therefore retains its direct zero-runner
# check on every local sweep above.
require_parent_checkpoint_guards || {
  printf 'Checkpoint authority changed before the storage monitor launch.\n' >&2
  exit 1
}
MONITOR_POLL_SECONDS="$(recovery_stream_poll_seconds)" || {
  printf 'Could not derive the attested storage monitor poll interval.\n' >&2
  exit 1
}

(
  # Bash 3.2 may tail-exec an external command reached through an async
  # function (`monitor &`), replacing the long-lived shell with one kubectl
  # LIST. An EXIT trap makes the shell retain ownership of the monitor PID and
  # preserves the original status after every nested command returns.
  backup_monitor_exit_status=0
  trap 'backup_monitor_exit_status=$?; trap - EXIT; exit "$backup_monitor_exit_status"' EXIT
  monitor
) &
MONITOR_PID=$!
if ! MONITOR_START_IDENTITY="$(
  recovery_process_start_identity "$MONITOR_PID"
)"; then
  : >"$MONITOR_STOP"
  wait "$MONITOR_PID" 2>/dev/null || :
  MONITOR_PID=""
  MONITOR_START_IDENTITY=""
  printf 'Could not bind the read-only storage monitor to its exact process identity.\n' >&2
  exit 1
fi
if ! MONITOR_MAX_STALE_SECONDS="$(recovery_stream_guard_max_stale_seconds)" ||
   ! MONITOR_INITIAL_DEADLINE_SECONDS="$(
     recovery_stream_guard_initial_deadline_seconds
   )" ||
   ! recovery_wait_for_stream_guard_initial_progress \
     "$MONITOR_PID" "$MONITOR_START_IDENTITY" "$MONITOR_FAILURE" \
     "$MONITOR_PROGRESS" "$MONITOR_INITIAL_DEADLINE_SECONDS"; then
  : >"$MONITOR_STOP"
  wait "$MONITOR_PID" 2>/dev/null || :
  MONITOR_PID=""
  MONITOR_START_IDENTITY=""
  MONITOR_MAX_STALE_SECONDS=""
  MONITOR_INITIAL_DEADLINE_SECONDS=""
  monitor_failure_reason="unknown_failure"
  if [[ -s "$MONITOR_FAILURE" ]]; then
    monitor_failure_reason="$(<"$MONITOR_FAILURE")"
  fi
  printf 'Read-only storage monitor did not complete its initial exact safety sweep: %s.\n' \
    "$monitor_failure_reason" >&2
  exit 1
fi
if recovery_kubectl_stream_guarded 3600 \
  "${PARENT_STREAM_GUARD_ARGS[@]}" \
  --guard-process "$MONITOR_PID" "$MONITOR_START_IDENTITY" "$MONITOR_FAILURE" \
    "$MONITOR_PROGRESS" "$MONITOR_MAX_STALE_SECONDS" -- \
  exec -n "$NAMESPACE" "$HELPER_POD" -- tar -C /storage -cf - owned |
  gzip -c >"$PARTIAL_PATH"; then
  archive_status=0
else
  archive_status=$?
fi
if stop_monitor; then monitor_status=0; else monitor_status=1; fi
[[ "$archive_status" == 0 && "$monitor_status" == 0 ]] || {
  monitor_failure_reason="none"
  if [[ -s "$MONITOR_FAILURE" ]]; then
    monitor_failure_reason="$(<"$MONITOR_FAILURE")"
  fi
  printf 'Read-only archive or its exact identity monitor failed: archive_status=%s monitor_status=%s monitor_reason=%s.\n' \
    "$archive_status" "$monitor_status" "$monitor_failure_reason" >&2
  exit 1
}
chmod 600 "$PARTIAL_PATH"
gzip -t "$PARTIAL_PATH"
gzip -cd "$PARTIAL_PATH" | tar -tvf - | awk '
  substr($0,1,1) != "-" && substr($0,1,1) != "d" { failed=1 }
  END { exit failed ? 1 : 0 }
' || {
  printf 'Storage archive contains links or unsupported types.\n' >&2
  exit 1
}
gzip -cd "$PARTIAL_PATH" | tar -tf - >"$ARCHIVE_PATHS"
recovery_storage_paths_file_is_exact "$ARCHIVE_PATHS" || {
  printf 'Storage archive violates the exact two-shard path contract.\n' >&2
  exit 1
}
recovery_extract_storage_uuids "$ARCHIVE_PATHS" blob | LC_ALL=C sort >"$WORK_DIR/archive-blobs"
recovery_extract_storage_uuids "$ARCHIVE_PATHS" meta.json | LC_ALL=C sort >"$WORK_DIR/archive-meta"
if ! cmp -s "$WORK_DIR/blobs" "$WORK_DIR/archive-blobs" ||
   ! cmp -s "$WORK_DIR/meta" "$WORK_DIR/archive-meta"; then
  printf 'Storage archive inventory differs from its quiescent source.\n' >&2
  exit 1
fi

recovery_require_operation_lock
require_pgsql_source
recovery_capture_live_database_contract "$PGSQL_POD" "$CONTRACT_AFTER"
# shellcheck disable=SC2016
recovery_kubectl exec -n "$NAMESPACE" "$PGSQL_POD" -- sh -ec \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d retdb -Atc "select owned_file_uuid from ret0.owned_files where state::text = '\''active'\'' order by owned_file_uuid"' \
  | tr -d '\r' | LC_ALL=C sort >"$DB_ACTIVE_AFTER"
if ! recovery_database_contracts_match "$CONTRACT_BEFORE" "$CONTRACT_AFTER" ||
   ! cmp -s "$DB_ACTIVE_BEFORE" "$DB_ACTIVE_AFTER"; then
  printf 'Database contract changed during the quiescent storage snapshot.\n' >&2
  exit 1
fi

require_parent_checkpoint_guards
delete_helper_pod
delete_helper_policy
PAIR_COUNT="$(wc -l <"$WORK_DIR/archive-blobs" | tr -d ' ')"
OUTPUT_PUBLISHED_IDENTITY="$(
  storage_backup_private_file_identity "$PARTIAL_PATH"
)"
[[ "$OUTPUT_PUBLISHED_IDENTITY" == "$PARTIAL_OWNED_IDENTITY" ]] || {
  printf 'Storage backup staging identity or mode changed unexpectedly.\n' >&2
  exit 1
}
OUTPUT_PUBLISHED=1
if ! publish_private_storage_backup_no_clobber \
  "$PARTIAL_PATH" "$OUTPUT_PATH" "$OUTPUT_PUBLISHED_IDENTITY"; then
  printf 'Could not publish the storage backup without replacing an existing entry.\n' >&2
  exit 1
fi
[[ "$(storage_backup_private_file_identity "$OUTPUT_PATH")" == \
   "$OUTPUT_PUBLISHED_IDENTITY" ]] || {
  printf 'Published storage backup identity or mode changed unexpectedly.\n' >&2
  exit 1
}
cleanup_owned_storage_work_dir || {
  printf 'Storage backup work directory cleanup failed closed before commit.\n' >&2
  exit 1
}

trap '' INT TERM
BACKUP_SUCCEEDED=1
printf 'Quiesced Reticulum storage backup completed: path=%s pvc_uid=%s pairs=%s\n' \
  "$OUTPUT_PATH" "$RECOVERY_PVC_UID" "$PAIR_COUNT"

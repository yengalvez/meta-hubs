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
PARENT_LEASE_HOLDER="${YENHUBS_PARENT_LEASE_HOLDER:-}"
PARENT_LEASE_UID="${YENHUBS_PARENT_LEASE_UID:-}"
PARENT_PROCESS_PID="${YENHUBS_PARENT_PROCESS_PID:-}"
PARENT_PROCESS_START_IDENTITY="${YENHUBS_PARENT_PROCESS_START_IDENTITY:-}"
# shellcheck source=deployment/lib/recovery-safety.sh
source "$SCRIPT_DIR/lib/recovery-safety.sh"
if [[ "$COORDINATED" == 1 ]]; then
  RECOVERY_CHECKPOINT_STAMP="$PARENT_CHECKPOINT_STAMP"
  RECOVERY_DUMP_SHA256="$PARENT_DUMP_SHA256"
  RECOVERY_STORAGE_SHA256="$PARENT_STORAGE_SHA256"
  RECOVERY_NAMESPACE_UID="$PARENT_NAMESPACE_UID"
  RECOVERY_PVC_UID="$PARENT_PVC_UID"
  recovery_adopt_parent_operation_serialization \
    "$PARENT_LEASE_HOLDER" "$PARENT_LEASE_UID" \
    "$PARENT_PROCESS_PID" "$PARENT_PROCESS_START_IDENTITY"
fi
unset YENHUBS_PARENT_LEASE_HOLDER YENHUBS_PARENT_LEASE_UID \
  YENHUBS_PARENT_PROCESS_PID YENHUBS_PARENT_PROCESS_START_IDENTITY

if [[ "$COORDINATED" != 0 && "$COORDINATED" != 1 ]]; then
  printf 'BACKUP_COORDINATED must be 0 or 1.\n' >&2
  exit 2
fi

require_backup_guard() {
  local deployment
  [[ "$COORDINATED" == 1 ]] || return 0
  [[ "${RECOVERY_OPERATION_OWNER:-}" == checkpoint-backup &&
     -n "${RECOVERY_CONSUMER_CONTRACT_JSON:-}" ]] || return 1
  recovery_require_operation_lock || return 1
  for deployment in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
    recovery_require_consumer_contract_entry "$RECOVERY_CONSUMER_CONTRACT_JSON" \
      "$deployment" 0 || return 1
  done
  recovery_require_no_managed_bot_runner_pods
}

if [[ -e "$OUTPUT_PATH" || -e "$CONTRACT_OUTPUT_PATH" ]]; then
  printf 'Refusing to overwrite existing backup or database contract.\n' >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
PARTIAL_PATH="$(mktemp "${OUTPUT_PATH}.partial.XXXXXX")"
SQL_CHECK_PATH="$(mktemp "${OUTPUT_PATH}.verify.sql.XXXXXX")"
CONTRACT_BEFORE="$(mktemp "${OUTPUT_PATH}.contract-before.XXXXXX")"
CONTRACT_AFTER="$(mktemp "${OUTPUT_PATH}.contract-after.XXXXXX")"
CONTRACT_BOUND="$(mktemp "${OUTPUT_PATH}.contract-bound.XXXXXX")"
cleanup_backup() {
  rm -f -- "$PARTIAL_PATH" "$SQL_CHECK_PATH" "$CONTRACT_BEFORE" "$CONTRACT_AFTER" \
    "$CONTRACT_BOUND"
}
backup_interrupted() {
  local status="$1"
  trap - EXIT INT TERM
  cleanup_backup
  exit "$status"
}
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
PGSQL_POD_JSON="$(jq -cer '.items[0]' <<<"$PGSQL_PODS_JSON")"
require_pgsql_source() {
  recovery_require_pod_identity "$PGSQL_POD" "$PGSQL_POD_UID" &&
    recovery_require_pod_deployment_ownership \
      "$PGSQL_POD_JSON" pgsql "$PGSQL_DEPLOYMENT_UID"
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
run_dump_stream() {
  # Expansion is intentionally deferred to the shell inside the PostgreSQL pod.
  # shellcheck disable=SC2016
  if [[ "$COORDINATED" == 1 ]]; then
    recovery_kubectl_stream_guarded 3600 exec -n "$NAMESPACE" "$PGSQL_POD" -- \
      sh -ec 'pg_dump -U "$POSTGRES_USER" --format=plain retdb'
  else
    recovery_kubectl_stream 3600 exec -n "$NAMESPACE" "$PGSQL_POD" -- \
      sh -ec 'pg_dump -U "$POSTGRES_USER" --format=plain retdb'
  fi
}
run_dump_stream |
  gzip -9 > "$PARTIAL_PATH"
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

mv "$PARTIAL_PATH" "$OUTPUT_PATH"
mv "$CONTRACT_BOUND" "$CONTRACT_OUTPUT_PATH"
chmod 600 "$OUTPUT_PATH"
chmod 600 "$CONTRACT_OUTPUT_PATH"
cleanup_backup
trap - EXIT INT TERM

SIZE_BYTES="$(recovery_file_size_bytes "$OUTPUT_PATH")"
SHA256="$(recovery_sha256_file "$OUTPUT_PATH" | awk '{print $1}')"

printf 'Reticulum database backup completed: path=%s schema_tables=%s migrations=%s hubs=%s active_files=%s size_bytes=%s sha256=%s\n' \
  "$OUTPUT_PATH" "$SCHEMA_TABLES" "$MIGRATIONS" "$HUBS_COUNT" "$ACTIVE_FILES" "$SIZE_BYTES" "$SHA256"

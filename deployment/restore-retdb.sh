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
DB_NAME="retdb"
CONSUMERS=(reticulum pgbouncer pgbouncer-t bot-orchestrator coturn)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deployment/lib/recovery-safety.sh
source "$SCRIPT_DIR/lib/recovery-safety.sh"

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
QUIESCE_MONITOR_PID=""
RESTORE_PHASE="validating"
cleanup_restore() {
  if [[ -n "$QUIESCE_MONITOR_PID" ]]; then
    [[ -z "$QUIESCE_MONITOR_STOP" ]] || : >"$QUIESCE_MONITOR_STOP"
    wait "$QUIESCE_MONITOR_PID" 2>/dev/null || true
    QUIESCE_MONITOR_PID=""
  fi
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
recovery_kubectl rollout status deployment/pgsql -n "$NAMESPACE" --timeout=5m >/dev/null
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

if [[ "$PREFLIGHT" == "1" ]]; then
  printf 'Database restore preflight passed (no restore performed): source=%s checkpoint=%s dump_sha256=%s storage_sha256=%s context=%s namespace=%s namespace_uid=%s database=%s pod=%s\n' \
    "$DUMP_PATH" "$RECOVERY_CHECKPOINT_STAMP" "$RECOVERY_DUMP_SHA256" \
    "$RECOVERY_STORAGE_SHA256" "$EXPECTED_KUBE_CONTEXT" "$NAMESPACE" \
    "$RECOVERY_NAMESPACE_UID" "$DB_NAME" "$PGSQL_POD"
  exit 0
fi

recovery_require_confirmation CONFIRM_RESTORE "$DB_NAME"
recovery_require_pvc_identity ret-pvc
if [[ -z "${RECOVERY_CONSUMER_CONTRACT_JSON:-}" ]] ||
   ! recovery_consumer_contract_is_acceptable "$RECOVERY_CONSUMER_CONTRACT_JSON" ||
   [[ "$(jq -r '.operation_id' <<<"$RECOVERY_CONSUMER_CONTRACT_JSON")" != \
      "${RECOVERY_OPERATION_ID:-}" ]] ||
   ! recovery_require_operation_lock; then
  printf 'Destructive DB restore lacks the exact parent operation lock/consumer contract.\n' >&2
  exit 1
fi

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
  recovery_require_deployment_contract "$deployment" "$deployment_uid" \
    "$replica_count" "$deployment_selector" "$deployment_fingerprint" || {
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
# Target identity is checked immediately before the first Kubernetes mutation.
recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
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

for index in "${!RESTORE_DEPLOYMENTS[@]}"; do
  recovery_require_operation_lock
  recovery_wait_for_no_pods "app=${DEPLOYMENT_SELECTORS[$index]}" \
    "deployment/${RESTORE_DEPLOYMENTS[$index]}" 180s
  recovery_require_operation_lock
  recovery_require_consumer_contract_entry "$RECOVERY_CONSUMER_CONTRACT_JSON" \
    "${RESTORE_DEPLOYMENTS[$index]}" 0
done

require_quiesced_consumers() {
  local deployment selector pods
  recovery_require_operation_lock || return 1
  for deployment in "${CONSUMERS[@]}"; do
    recovery_require_consumer_contract_entry \
      "$RECOVERY_CONSUMER_CONTRACT_JSON" "$deployment" 0 \
      "$RECOVERY_OPERATION_ID" || return 1
    selector="$(jq -er --arg name "$deployment" \
      '[.consumers[] | select(.name == $name)] | select(length == 1) | .[0].selector' \
      <<<"$RECOVERY_CONSUMER_CONTRACT_JSON")" || return 1
    pods="$(recovery_kubectl get pod -n "$NAMESPACE" -l "app=$selector" -o name)" || return 1
    [[ -z "$pods" ]] || return 1
  done
}

start_quiesce_monitor() {
  QUIESCE_MONITOR_STOP="$(mktemp "${TMPDIR:-/tmp}/yenhubs-db-quiesce-stop.XXXXXX")"
  QUIESCE_MONITOR_FAILURE="$(mktemp "${TMPDIR:-/tmp}/yenhubs-db-quiesce-failure.XXXXXX")"
  rm -f -- "$QUIESCE_MONITOR_STOP"
  chmod 600 "$QUIESCE_MONITOR_FAILURE"
  (
    while [[ ! -e "$QUIESCE_MONITOR_STOP" ]]; do
      if ! require_quiesced_consumers; then
        printf 'consumer_resumed\n' >"$QUIESCE_MONITOR_FAILURE"
        exit 1
      fi
      sleep "${DB_QUIESCE_MONITOR_INTERVAL_SECONDS:-0.25}"
    done
  ) &
  QUIESCE_MONITOR_PID=$!
}

stop_quiesce_monitor() {
  local status=0
  [[ -n "$QUIESCE_MONITOR_PID" ]] || return 2
  : >"$QUIESCE_MONITOR_STOP"
  if wait "$QUIESCE_MONITOR_PID"; then status=0; else status=$?; fi
  QUIESCE_MONITOR_PID=""
  [[ "$status" == 0 && ! -s "$QUIESCE_MONITOR_FAILURE" ]]
}

RESTORE_PHASE="restoring"
# Revalidate immediately before the destructive drop/create transaction.
recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
require_quiesced_consumers
require_pgsql_source
start_quiesce_monitor
# pg_dump does not include cluster-level roles. The restored grants require
# ret_admin even though it is a NOLOGIN role.
# Expansion is intentionally deferred to the shell inside the PostgreSQL pod.
# shellcheck disable=SC2016
recovery_kubectl exec -n "$NAMESPACE" "$PGSQL_POD" -- sh -ec '
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
gzip -cd "$RECOVERY_DUMP_COPY" |
  recovery_kubectl exec -i -n "$NAMESPACE" "$PGSQL_POD" -- \
    sh -ec 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d retdb' >/dev/null

require_quiesced_consumers
require_pgsql_source

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
if ! recovery_capture_live_database_contract "$PGSQL_POD" "$LIVE_CONTRACT_PATH" ||
   ! recovery_database_contracts_match "$RECOVERY_DATABASE_CONTRACT_COPY" "$LIVE_CONTRACT_PATH"; then
  printf 'Restored database contract does not exactly match the checksummed checkpoint contract.\n' >&2
  exit 1
fi
require_quiesced_consumers
require_pgsql_source

if ! stop_quiesce_monitor; then
  printf 'A DB consumer resumed during the destructive restore window.\n' >&2
  exit 1
fi
RESTORE_PHASE="coordinated_hold"
trap - ERR
printf 'Database restore validated and held quiescent for coordinated storage restore: checkpoint=%s\n' \
  "$RECOVERY_CHECKPOINT_STAMP"

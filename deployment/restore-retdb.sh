#!/usr/bin/env bash

# Restores the YenHubs Reticulum database from a plain SQL gzip dump.
# RESTORE_PREFLIGHT=1 validates the artifact and target identity without
# restoring. A real restore requires a confirmation bound to context,
# namespace and namespace UID.

set -euo pipefail
umask 077

if [[ $# -ne 1 ]]; then
  printf 'Usage: RESTORE_PREFLIGHT=1 %s /path/to/retdb.sql.gz\n' "$0" >&2
  exit 2
fi

DUMP_PATH="$1"
NAMESPACE="${NAMESPACE:-hcce}"
PREFLIGHT="${RESTORE_PREFLIGHT:-${RESTORE_DRY_RUN:-0}}"
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

if [[ ! -s "$DUMP_PATH" ]]; then
  printf 'Restore dump is missing or empty: %s\n' "$DUMP_PATH" >&2
  exit 1
fi

gzip -t "$DUMP_PATH"
SQL_CHECK_PATH="$(mktemp /tmp/yenhubs-retdb-restore.XXXXXX.sql)"
trap 'rm -f "$SQL_CHECK_PATH"' EXIT
gzip -cd "$DUMP_PATH" >"$SQL_CHECK_PATH"
if ! grep -Eq '^CREATE SCHEMA (ret0|ret0_admin);' "$SQL_CHECK_PATH" ||
   ! grep -Eq '^(CREATE TABLE|COPY) ret0\.schema_migrations' "$SQL_CHECK_PATH"; then
  printf 'Restore dump is missing required Reticulum schema markers.\n' >&2
  exit 1
fi
rm -f "$SQL_CHECK_PATH"
trap - EXIT

recovery_require_cluster_identity
recovery_kubectl rollout status deployment/pgsql -n "$NAMESPACE" --timeout=5m >/dev/null

PGSQL_POD="$(recovery_kubectl get pod -n "$NAMESPACE" -l app=pgsql -o jsonpath='{.items[0].metadata.name}')"
if [[ -z "$PGSQL_POD" ]]; then
  printf 'No PostgreSQL pod found in namespace %s.\n' "$NAMESPACE" >&2
  exit 1
fi

if [[ "$PREFLIGHT" == "1" ]]; then
  printf 'Database restore preflight passed (no restore performed): dump=%s context=%s namespace=%s namespace_uid=%s database=%s pod=%s\n' \
    "$DUMP_PATH" "$EXPECTED_KUBE_CONTEXT" "$NAMESPACE" "$RECOVERY_NAMESPACE_UID" "$DB_NAME" "$PGSQL_POD"
  exit 0
fi

recovery_require_confirmation CONFIRM_RESTORE "$DB_NAME"

RESTORE_DEPLOYMENTS=()
ORIGINAL_REPLICAS=()
DEPLOYMENT_SELECTORS=()
for deployment in "${CONSUMERS[@]}"; do
  if recovery_kubectl get deployment "$deployment" -n "$NAMESPACE" >/dev/null 2>&1; then
    RESTORE_DEPLOYMENTS+=("$deployment")
    ORIGINAL_REPLICAS+=("$(
      recovery_kubectl get deployment "$deployment" -n "$NAMESPACE" -o jsonpath='{.spec.replicas}'
    )")
    DEPLOYMENT_SELECTORS+=("$(
      recovery_kubectl get deployment "$deployment" -n "$NAMESPACE" \
        -o jsonpath='{.spec.selector.matchLabels.app}'
    )")
  fi
done

for index in "${!RESTORE_DEPLOYMENTS[@]}"; do
  if [[ -z "${ORIGINAL_REPLICAS[$index]}" || -z "${DEPLOYMENT_SELECTORS[$index]}" ]]; then
    printf 'Could not capture replicas/selector for deployment %s; no workloads were stopped.\n' \
      "${RESTORE_DEPLOYMENTS[$index]}" >&2
    exit 1
  fi
done

restore_failed() {
  printf 'Database restore stopped. Any scaled DB consumers remain at zero for safety.\n' >&2
}
trap restore_failed ERR

for deployment in "${RESTORE_DEPLOYMENTS[@]}"; do
  recovery_kubectl scale deployment "$deployment" -n "$NAMESPACE" --replicas=0 >/dev/null
done

for index in "${!RESTORE_DEPLOYMENTS[@]}"; do
  recovery_wait_for_no_pods "app=${DEPLOYMENT_SELECTORS[$index]}" \
    "deployment/${RESTORE_DEPLOYMENTS[$index]}" 180s
done

# Revalidate after quiescing workloads and immediately before recreating retdb.
recovery_require_cluster_identity

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

# Expansion is intentionally deferred to the shell inside the PostgreSQL pod.
# shellcheck disable=SC2016
gzip -cd "$DUMP_PATH" |
  recovery_kubectl exec -i -n "$NAMESPACE" "$PGSQL_POD" -- \
    sh -ec 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d retdb' >/dev/null

RESTORE_COUNTS="$(
  # Expansion is intentionally deferred to the shell inside the PostgreSQL pod.
  # shellcheck disable=SC2016
  recovery_kubectl exec -n "$NAMESPACE" "$PGSQL_POD" -- sh -ec \
    'psql -U "$POSTGRES_USER" -d retdb -At <<'\''SQL'\''
select count(*) from information_schema.tables
where table_schema in ('\''ret0'\'', '\''ret0_admin'\'', '\''coturn'\'');
select count(*) from ret0.schema_migrations;
SQL'
)"

SCHEMA_TABLES="$(printf '%s\n' "$RESTORE_COUNTS" | sed -n '1p')"
MIGRATIONS="$(printf '%s\n' "$RESTORE_COUNTS" | sed -n '2p')"
if [[ ! "$SCHEMA_TABLES" =~ ^[0-9]+$ || "$SCHEMA_TABLES" -eq 0 ||
      ! "$MIGRATIONS" =~ ^[0-9]+$ || "$MIGRATIONS" -eq 0 ]]; then
  printf 'Restore verification returned invalid counts.\n' >&2
  false
fi

trap - ERR
for index in "${!RESTORE_DEPLOYMENTS[@]}"; do
  recovery_kubectl scale deployment "${RESTORE_DEPLOYMENTS[$index]}" -n "$NAMESPACE" \
    --replicas="${ORIGINAL_REPLICAS[$index]}" >/dev/null
done

printf 'Database restore completed: schema_tables=%s migrations=%s\n' "$SCHEMA_TABLES" "$MIGRATIONS"

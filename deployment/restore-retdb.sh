#!/usr/bin/env bash

# Restores the YenHubs Reticulum database from a plain SQL gzip dump.
# A destructive restore requires CONFIRM_RESTORE=retdb. Use RESTORE_DRY_RUN=1
# to validate the inputs and cluster state without modifying anything.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf 'Usage: CONFIRM_RESTORE=retdb %s /path/to/retdb.sql.gz\n' "$0" >&2
  exit 2
fi

DUMP_PATH="$1"
NAMESPACE="${NAMESPACE:-hcce}"
DRY_RUN="${RESTORE_DRY_RUN:-0}"
DB_NAME="retdb"
CONSUMERS=(reticulum pgbouncer pgbouncer-t bot-orchestrator coturn)

if [[ ! -s "$DUMP_PATH" ]]; then
  printf 'Restore dump is missing or empty: %s\n' "$DUMP_PATH" >&2
  exit 1
fi

gzip -t "$DUMP_PATH"
kubectl get namespace "$NAMESPACE" >/dev/null
kubectl rollout status deployment/pgsql -n "$NAMESPACE" --timeout=5m >/dev/null

PGSQL_POD="$(kubectl get pod -n "$NAMESPACE" -l app=pgsql -o jsonpath='{.items[0].metadata.name}')"
if [[ -z "$PGSQL_POD" ]]; then
  printf 'No PostgreSQL pod found in namespace %s.\n' "$NAMESPACE" >&2
  exit 1
fi

if [[ "$DRY_RUN" == "1" ]]; then
  printf 'Restore preflight passed: dump=%s namespace=%s database=%s pod=%s\n' \
    "$DUMP_PATH" "$NAMESPACE" "$DB_NAME" "$PGSQL_POD"
  exit 0
fi

if [[ "${CONFIRM_RESTORE:-}" != "$DB_NAME" ]]; then
  printf 'Refusing destructive restore. Set CONFIRM_RESTORE=%s explicitly.\n' "$DB_NAME" >&2
  exit 1
fi

RESTORE_DEPLOYMENTS=()
ORIGINAL_REPLICAS=()
for deployment in "${CONSUMERS[@]}"; do
  if kubectl get deployment "$deployment" -n "$NAMESPACE" >/dev/null 2>&1; then
    RESTORE_DEPLOYMENTS+=("$deployment")
    ORIGINAL_REPLICAS+=("$(
      kubectl get deployment "$deployment" -n "$NAMESPACE" -o jsonpath='{.spec.replicas}'
    )")
    kubectl scale deployment "$deployment" -n "$NAMESPACE" --replicas=0 >/dev/null
  fi
done

for deployment in "${RESTORE_DEPLOYMENTS[@]}"; do
  kubectl wait --for=delete pod -n "$NAMESPACE" -l "app=$deployment" --timeout=180s >/dev/null 2>&1 || true
done

restore_failed() {
  printf 'Database restore failed. DB consumers remain scaled to zero for safety.\n' >&2
}
trap restore_failed ERR

# pg_dump does not include cluster-level roles. The restored grants require
# ret_admin even though it is a NOLOGIN role.
kubectl exec -n "$NAMESPACE" "$PGSQL_POD" -- sh -ec '
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

gzip -cd "$DUMP_PATH" |
  kubectl exec -i -n "$NAMESPACE" "$PGSQL_POD" -- \
    sh -ec 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d retdb' >/dev/null

RESTORE_COUNTS="$(
  kubectl exec -n "$NAMESPACE" "$PGSQL_POD" -- sh -ec \
    'psql -U "$POSTGRES_USER" -d retdb -At <<'\''SQL'\''
select count(*) from information_schema.tables
where table_schema in ('\''ret0'\'', '\''ret0_admin'\'', '\''coturn'\'');
select count(*) from ret0.schema_migrations;
SQL'
)"

SCHEMA_TABLES="$(printf '%s\n' "$RESTORE_COUNTS" | sed -n '1p')"
MIGRATIONS="$(printf '%s\n' "$RESTORE_COUNTS" | sed -n '2p')"
if [[ -z "$SCHEMA_TABLES" || "$SCHEMA_TABLES" -eq 0 || -z "$MIGRATIONS" || "$MIGRATIONS" -eq 0 ]]; then
  printf 'Restore verification returned invalid counts.\n' >&2
  false
fi

trap - ERR
for index in "${!RESTORE_DEPLOYMENTS[@]}"; do
  kubectl scale deployment "${RESTORE_DEPLOYMENTS[$index]}" -n "$NAMESPACE" \
    --replicas="${ORIGINAL_REPLICAS[$index]}" >/dev/null
done

printf 'Database restore completed: schema_tables=%s migrations=%s\n' "$SCHEMA_TABLES" "$MIGRATIONS"

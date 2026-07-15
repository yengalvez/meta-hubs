#!/usr/bin/env bash

# Exports Reticulum's PostgreSQL database as a gzip-compressed plain SQL dump.
# The resulting format is consumed by restore-retdb.sh.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf 'Usage: %s /path/to/retdb-YYYYMMDD-HHMMSS.sql.gz\n' "$0" >&2
  exit 2
fi

OUTPUT_PATH="$1"
NAMESPACE="${NAMESPACE:-hcce}"

if [[ -e "$OUTPUT_PATH" ]]; then
  printf 'Refusing to overwrite existing backup: %s\n' "$OUTPUT_PATH" >&2
  exit 1
fi

kubectl get namespace "$NAMESPACE" >/dev/null
kubectl rollout status deployment/pgsql -n "$NAMESPACE" --timeout=5m >/dev/null

PGSQL_POD="$(kubectl get pod -n "$NAMESPACE" -l app=pgsql -o jsonpath='{.items[0].metadata.name}')"
if [[ -z "$PGSQL_POD" ]]; then
  printf 'No PostgreSQL pod found in namespace %s.\n' "$NAMESPACE" >&2
  exit 1
fi

COUNTS="$(
  kubectl exec -n "$NAMESPACE" "$PGSQL_POD" -- sh -ec \
    'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d retdb -At <<'\''SQL'\''
select count(*) from information_schema.tables
where table_schema in ('\''ret0'\'', '\''ret0_admin'\'', '\''coturn'\'');
select count(*) from ret0.schema_migrations;
select count(*) from ret0.owned_files where state = '\''active'\'';
SQL'
)"

SCHEMA_TABLES="$(printf '%s\n' "$COUNTS" | sed -n '1p')"
MIGRATIONS="$(printf '%s\n' "$COUNTS" | sed -n '2p')"
ACTIVE_FILES="$(printf '%s\n' "$COUNTS" | sed -n '3p')"

if [[ -z "$SCHEMA_TABLES" || "$SCHEMA_TABLES" -eq 0 || -z "$MIGRATIONS" || "$MIGRATIONS" -eq 0 ]]; then
  printf 'Database verification returned invalid counts.\n' >&2
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT_PATH")"
PARTIAL_PATH="${OUTPUT_PATH}.partial"
SQL_CHECK_PATH="${OUTPUT_PATH}.verify.sql"
trap 'rm -f "$PARTIAL_PATH" "$SQL_CHECK_PATH"' EXIT

kubectl exec -n "$NAMESPACE" "$PGSQL_POD" -- \
  sh -ec 'pg_dump -U "$POSTGRES_USER" --format=plain retdb' |
  gzip -9 > "$PARTIAL_PATH"

gzip -t "$PARTIAL_PATH"
gzip -cd "$PARTIAL_PATH" > "$SQL_CHECK_PATH"

if ! grep -Eq '^CREATE SCHEMA (ret0|ret0_admin);' "$SQL_CHECK_PATH" ||
   ! grep -Eq '^(CREATE TABLE|COPY) ret0\.schema_migrations' "$SQL_CHECK_PATH"; then
  printf 'Dump verification failed: required Reticulum schema markers are missing.\n' >&2
  exit 1
fi

mv "$PARTIAL_PATH" "$OUTPUT_PATH"
rm -f "$SQL_CHECK_PATH"
trap - EXIT

SIZE_BYTES="$(stat -f '%z' "$OUTPUT_PATH" 2>/dev/null || stat -c '%s' "$OUTPUT_PATH")"
SHA256="$(shasum -a 256 "$OUTPUT_PATH" | awk '{print $1}')"

printf 'Reticulum database backup completed: path=%s schema_tables=%s migrations=%s active_files=%s size_bytes=%s sha256=%s\n' \
  "$OUTPUT_PATH" "$SCHEMA_TABLES" "$MIGRATIONS" "$ACTIVE_FILES" "$SIZE_BYTES" "$SHA256"

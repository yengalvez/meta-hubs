#!/usr/bin/env bash

# Exports Reticulum's durable owned-file storage from ret-pvc.
# The backup is accepted only when every active owned_files DB row has both a
# .blob and .meta.json file, preventing another metadata-only project freeze.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf 'Usage: %s /path/to/ret-storage-YYYYMMDD.tar.gz\n' "$0" >&2
  exit 2
fi

OUTPUT_PATH="$1"
NAMESPACE="${NAMESPACE:-hcce}"

if [[ -e "$OUTPUT_PATH" ]]; then
  printf 'Refusing to overwrite existing backup: %s\n' "$OUTPUT_PATH" >&2
  exit 1
fi

kubectl get namespace "$NAMESPACE" >/dev/null

RET_POD="$(kubectl get pod -n "$NAMESPACE" -l app=reticulum -o jsonpath='{.items[0].metadata.name}')"
PGSQL_POD="$(kubectl get pod -n "$NAMESPACE" -l app=pgsql -o jsonpath='{.items[0].metadata.name}')"

if [[ -z "$RET_POD" || -z "$PGSQL_POD" ]]; then
  printf 'Reticulum or PostgreSQL pod was not found in namespace %s.\n' "$NAMESPACE" >&2
  exit 1
fi

DB_ACTIVE_COUNT="$(
  kubectl exec -n "$NAMESPACE" "$PGSQL_POD" -- sh -ec \
    'psql -U "$POSTGRES_USER" -d retdb -Atc "select count(*) from ret0.owned_files where state = '\''active'\''"'
)"

STORAGE_COUNTS="$(
  kubectl exec -n "$NAMESPACE" -c reticulum "$RET_POD" -- sh -ec '
    if [ ! -d /storage/owned ]; then
      printf "0\n0\n"
      exit 0
    fi
    find /storage/owned -type f -name "*.blob" | wc -l
    find /storage/owned -type f -name "*.meta.json" | wc -l
  '
)"

BLOB_COUNT="$(printf '%s\n' "$STORAGE_COUNTS" | sed -n '1p' | tr -d ' ')"
META_COUNT="$(printf '%s\n' "$STORAGE_COUNTS" | sed -n '2p' | tr -d ' ')"

if [[ -z "$DB_ACTIVE_COUNT" || -z "$BLOB_COUNT" || -z "$META_COUNT" ]]; then
  printf 'Could not determine database/storage file counts.\n' >&2
  exit 1
fi

if [[ "$BLOB_COUNT" -ne "$DB_ACTIVE_COUNT" || "$META_COUNT" -ne "$DB_ACTIVE_COUNT" ]]; then
  printf 'Refusing incomplete backup: DB active files=%s blobs=%s metadata=%s.\n' \
    "$DB_ACTIVE_COUNT" "$BLOB_COUNT" "$META_COUNT" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT_PATH")"
PARTIAL_PATH="${OUTPUT_PATH}.partial"
trap 'rm -f "$PARTIAL_PATH"' EXIT

kubectl exec -n "$NAMESPACE" -c reticulum "$RET_POD" -- \
  tar -C /storage -cf - owned | gzip -c > "$PARTIAL_PATH"

gzip -t "$PARTIAL_PATH"
ARCHIVE_BLOB_COUNT="$(gzip -cd "$PARTIAL_PATH" | tar -tf - | awk '/\.blob$/ { count++ } END { print count + 0 }')"
ARCHIVE_META_COUNT="$(gzip -cd "$PARTIAL_PATH" | tar -tf - | awk '/\.meta\.json$/ { count++ } END { print count + 0 }')"

if [[ "$ARCHIVE_BLOB_COUNT" -ne "$DB_ACTIVE_COUNT" || "$ARCHIVE_META_COUNT" -ne "$DB_ACTIVE_COUNT" ]]; then
  printf 'Archive verification failed: DB active files=%s blobs=%s metadata=%s.\n' \
    "$DB_ACTIVE_COUNT" "$ARCHIVE_BLOB_COUNT" "$ARCHIVE_META_COUNT" >&2
  exit 1
fi

mv "$PARTIAL_PATH" "$OUTPUT_PATH"
trap - EXIT

printf 'Reticulum storage backup completed: path=%s active_files=%s size_bytes=%s\n' \
  "$OUTPUT_PATH" "$DB_ACTIVE_COUNT" "$(stat -f '%z' "$OUTPUT_PATH" 2>/dev/null || stat -c '%s' "$OUTPUT_PATH")"

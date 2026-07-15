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

DB_ACTIVE_UUIDS="$(
  kubectl exec -n "$NAMESPACE" "$PGSQL_POD" -- sh -ec \
    'psql -U "$POSTGRES_USER" -d retdb -Atc "select owned_file_uuid from ret0.owned_files where state = '\''active'\'' order by owned_file_uuid"' \
    | tr -d '\r'
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

STORAGE_BLOB_UUIDS="$(
  kubectl exec -n "$NAMESPACE" -c reticulum "$RET_POD" -- sh -ec \
    'find /storage/owned -type f -name "*.blob" -exec basename {} .blob \; 2>/dev/null | sort -u' \
    | tr -d '\r'
)"
STORAGE_META_UUIDS="$(
  kubectl exec -n "$NAMESPACE" -c reticulum "$RET_POD" -- sh -ec \
    'find /storage/owned -type f -name "*.meta.json" -exec basename {} .meta.json \; 2>/dev/null | sort -u' \
    | tr -d '\r'
)"

BLOB_COUNT="$(printf '%s\n' "$STORAGE_COUNTS" | sed -n '1p' | tr -d ' ')"
META_COUNT="$(printf '%s\n' "$STORAGE_COUNTS" | sed -n '2p' | tr -d ' ')"

if [[ -z "$DB_ACTIVE_COUNT" || -z "$BLOB_COUNT" || -z "$META_COUNT" ]]; then
  printf 'Could not determine database/storage file counts.\n' >&2
  exit 1
fi

MISSING_ACTIVE_BLOBS="$(comm -23 \
  <(printf '%s\n' "$DB_ACTIVE_UUIDS" | sed '/^$/d' | sort -u) \
  <(printf '%s\n' "$STORAGE_BLOB_UUIDS" | sed '/^$/d' | sort -u))"
MISSING_ACTIVE_META="$(comm -23 \
  <(printf '%s\n' "$DB_ACTIVE_UUIDS" | sed '/^$/d' | sort -u) \
  <(printf '%s\n' "$STORAGE_META_UUIDS" | sed '/^$/d' | sort -u))"
INCOMPLETE_STORAGE_PAIRS="$(comm -3 \
  <(printf '%s\n' "$STORAGE_BLOB_UUIDS" | sed '/^$/d' | sort -u) \
  <(printf '%s\n' "$STORAGE_META_UUIDS" | sed '/^$/d' | sort -u))"

if [[ -n "$MISSING_ACTIVE_BLOBS" || -n "$MISSING_ACTIVE_META" || -n "$INCOMPLETE_STORAGE_PAIRS" ||
      "$BLOB_COUNT" -ne "$META_COUNT" || "$BLOB_COUNT" -lt "$DB_ACTIVE_COUNT" ]]; then
  printf 'Refusing incomplete backup: DB active files=%s blobs=%s metadata=%s missing_active_blobs=%s missing_active_metadata=%s incomplete_pairs=%s.\n' \
    "$DB_ACTIVE_COUNT" "$BLOB_COUNT" "$META_COUNT" \
    "$(printf '%s\n' "$MISSING_ACTIVE_BLOBS" | sed '/^$/d' | wc -l | tr -d ' ')" \
    "$(printf '%s\n' "$MISSING_ACTIVE_META" | sed '/^$/d' | wc -l | tr -d ' ')" \
    "$(printf '%s\n' "$INCOMPLETE_STORAGE_PAIRS" | sed '/^$/d' | wc -l | tr -d ' ')" >&2
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
ARCHIVE_BLOB_UUIDS="$(gzip -cd "$PARTIAL_PATH" | tar -tf - | sed -n 's#^.*/\([^/]*\)\.blob$#\1#p' | sort -u)"
ARCHIVE_META_UUIDS="$(gzip -cd "$PARTIAL_PATH" | tar -tf - | sed -n 's#^.*/\([^/]*\)\.meta\.json$#\1#p' | sort -u)"
ARCHIVE_MISSING_ACTIVE_BLOBS="$(comm -23 \
  <(printf '%s\n' "$DB_ACTIVE_UUIDS" | sed '/^$/d' | sort -u) \
  <(printf '%s\n' "$ARCHIVE_BLOB_UUIDS" | sed '/^$/d' | sort -u))"
ARCHIVE_MISSING_ACTIVE_META="$(comm -23 \
  <(printf '%s\n' "$DB_ACTIVE_UUIDS" | sed '/^$/d' | sort -u) \
  <(printf '%s\n' "$ARCHIVE_META_UUIDS" | sed '/^$/d' | sort -u))"
ARCHIVE_INCOMPLETE_PAIRS="$(comm -3 \
  <(printf '%s\n' "$ARCHIVE_BLOB_UUIDS" | sed '/^$/d' | sort -u) \
  <(printf '%s\n' "$ARCHIVE_META_UUIDS" | sed '/^$/d' | sort -u))"

if [[ -n "$ARCHIVE_MISSING_ACTIVE_BLOBS" || -n "$ARCHIVE_MISSING_ACTIVE_META" ||
      -n "$ARCHIVE_INCOMPLETE_PAIRS" || "$ARCHIVE_BLOB_COUNT" -ne "$ARCHIVE_META_COUNT" ||
      "$ARCHIVE_BLOB_COUNT" -lt "$DB_ACTIVE_COUNT" ]]; then
  printf 'Archive verification failed: DB active files=%s blobs=%s metadata=%s.\n' \
    "$DB_ACTIVE_COUNT" "$ARCHIVE_BLOB_COUNT" "$ARCHIVE_META_COUNT" >&2
  exit 1
fi

mv "$PARTIAL_PATH" "$OUTPUT_PATH"
trap - EXIT

printf 'Reticulum storage backup completed: path=%s active_files=%s complete_pairs=%s deferred_pairs=%s size_bytes=%s\n' \
  "$OUTPUT_PATH" "$DB_ACTIVE_COUNT" "$ARCHIVE_BLOB_COUNT" "$((ARCHIVE_BLOB_COUNT - DB_ACTIVE_COUNT))" \
  "$(stat -f '%z' "$OUTPUT_PATH" 2>/dev/null || stat -c '%s' "$OUTPUT_PATH")"

#!/usr/bin/env bash

# Offline validation for a matching Reticulum database dump and storage archive.
# Complete physical pairs not referenced by an active DB row are permitted;
# missing active files and incomplete physical pairs are hard failures.

set -euo pipefail
umask 077

if [[ $# -ne 2 ]]; then
  printf 'Usage: %s /path/to/retdb.sql.gz /path/to/ret-storage.tar.gz\n' "$0" >&2
  exit 2
fi

DUMP_PATH="$1"
ARCHIVE_PATH="$2"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deployment/lib/recovery-safety.sh
source "$SCRIPT_DIR/lib/recovery-safety.sh"

if ! DUMP_STAMP="$(recovery_checkpoint_stamp_from_artifact "$DUMP_PATH")" ||
   ! ARCHIVE_STAMP="$(recovery_checkpoint_stamp_from_artifact "$ARCHIVE_PATH")" ||
   [[ "$DUMP_STAMP" != "$ARCHIVE_STAMP" ]]; then
  printf 'Checkpoint dump and storage names must carry the same valid stamp.\n' >&2
  exit 1
fi

DUMP_DIR="$(cd "$(dirname "$DUMP_PATH")" && pwd -P)"
ARCHIVE_DIR="$(cd "$(dirname "$ARCHIVE_PATH")" && pwd -P)"
CONTRACT_PATH="$DUMP_DIR/database-contract.json"
if [[ "$DUMP_DIR" != "$ARCHIVE_DIR" ]]; then
  printf 'Checkpoint dump, storage and database contract must share one direct directory.\n' >&2
  exit 1
fi

for artifact in "$DUMP_PATH" "$ARCHIVE_PATH"; do
  if ! recovery_require_regular_direct_file "$artifact"; then
    printf 'Checkpoint artifact is missing, empty, linked or reached through a link: %s\n' "$artifact" >&2
    exit 1
  fi
  gzip -t "$artifact"
done
if ! recovery_database_contract_is_acceptable "$CONTRACT_PATH"; then
  printf 'Database contract is missing, linked or invalid.\n' >&2
  exit 1
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/yenhubs-checkpoint-validation.XXXXXX")"
cleanup_validation() {
  rm -rf -- "$TMP_DIR"
}
validation_interrupted() {
  local status="$1"
  trap - EXIT INT TERM
  cleanup_validation
  exit "$status"
}
trap cleanup_validation EXIT
trap 'validation_interrupted 130' INT
trap 'validation_interrupted 143' TERM
SQL_PATH="$TMP_DIR/retdb.sql"
ACTIVE_UUIDS_RAW="$TMP_DIR/active-uuids.raw"
ACTIVE_UUIDS="$TMP_DIR/active-uuids"
ARCHIVE_PATHS="$TMP_DIR/archive-paths"
ARCHIVE_VERBOSE="$TMP_DIR/archive-verbose"
BLOB_UUIDS_RAW="$TMP_DIR/blob-uuids.raw"
META_UUIDS_RAW="$TMP_DIR/meta-uuids.raw"
BLOB_UUIDS="$TMP_DIR/blob-uuids"
META_UUIDS="$TMP_DIR/meta-uuids"

gzip -cd "$DUMP_PATH" >"$SQL_PATH"
chmod 600 "$SQL_PATH"

if ! grep -Eq '^CREATE SCHEMA ret0;' "$SQL_PATH" ||
   ! recovery_validate_sql_dump_contract "$SQL_PATH" ||
   ! recovery_validate_database_contract_against_dump "$CONTRACT_PATH" "$SQL_PATH"; then
  printf 'Database dump is missing the complete critical Reticulum SQL contract.\n' >&2
  exit 1
fi

if ! recovery_extract_active_owned_file_uuids "$SQL_PATH" >"$ACTIVE_UUIDS_RAW"; then
  printf 'Database dump does not contain one valid ret0.owned_files COPY block.\n' >&2
  exit 1
fi
if ! HUB_COUNT="$(recovery_dump_copy_row_count "$SQL_PATH" hubs)"; then
  printf 'Database dump does not contain exactly one valid ret0.hubs COPY block.\n' >&2
  exit 1
fi
if [[ ! "$HUB_COUNT" =~ ^[0-9]+$ || "$HUB_COUNT" -eq 0 ]]; then
  printf 'Database dump contains no Hubs room rows.\n' >&2
  exit 1
fi

if awk '
  $0 !~ /^[A-Za-z0-9._-]+$/ { unsafe=1 }
  END { exit unsafe ? 0 : 1 }
' "$ACTIVE_UUIDS_RAW"; then
  printf 'Database dump contains an unsafe active owned_file_uuid.\n' >&2
  exit 1
fi
sort "$ACTIVE_UUIDS_RAW" >"$ACTIVE_UUIDS"
if [[ ! -s "$ACTIVE_UUIDS_RAW" ]]; then
  printf 'Database dump contains no active owned_file_uuid values.\n' >&2
  exit 1
fi
if [[ "$(wc -l <"$ACTIVE_UUIDS_RAW" | tr -d ' ')" -ne \
      "$(sort -u "$ACTIVE_UUIDS_RAW" | wc -l | tr -d ' ')" ]]; then
  printf 'Database dump contains duplicate active owned_file_uuid values.\n' >&2
  exit 1
fi

gzip -cd "$ARCHIVE_PATH" | tar -tf - >"$ARCHIVE_PATHS"
gzip -cd "$ARCHIVE_PATH" | tar -tvf - >"$ARCHIVE_VERBOSE"

if awk '
  substr($0, 1, 1) != "-" && substr($0, 1, 1) != "d" { unsafe = 1 }
  END { exit unsafe ? 0 : 1 }
' "$ARCHIVE_VERBOSE"; then
  printf 'Storage archive contains links or unsupported entry types.\n' >&2
  exit 1
fi

if ! recovery_storage_paths_file_is_exact "$ARCHIVE_PATHS"; then
  printf 'Storage archive has unsafe paths or files outside the owned-file contract.\n' >&2
  exit 1
fi

recovery_extract_storage_uuids "$ARCHIVE_PATHS" blob >"$BLOB_UUIDS_RAW"
recovery_extract_storage_uuids "$ARCHIVE_PATHS" meta.json >"$META_UUIDS_RAW"

if [[ ! -s "$BLOB_UUIDS_RAW" || ! -s "$META_UUIDS_RAW" ]]; then
  printf 'Storage archive contains no complete owned-file data.\n' >&2
  exit 1
fi
if awk '
  $0 !~ /^[A-Za-z0-9._-]+$/ { unsafe=1 }
  END { exit unsafe ? 0 : 1 }
' "$BLOB_UUIDS_RAW" "$META_UUIDS_RAW"; then
  printf 'Storage archive contains an unsafe owned-file UUID.\n' >&2
  exit 1
fi

sort "$BLOB_UUIDS_RAW" >"$BLOB_UUIDS"
sort "$META_UUIDS_RAW" >"$META_UUIDS"
if [[ "$(wc -l <"$BLOB_UUIDS_RAW" | tr -d ' ')" -ne \
      "$(sort -u "$BLOB_UUIDS_RAW" | wc -l | tr -d ' ')" ]] ||
   [[ "$(wc -l <"$META_UUIDS_RAW" | tr -d ' ')" -ne \
      "$(sort -u "$META_UUIDS_RAW" | wc -l | tr -d ' ')" ]]; then
  printf 'Storage archive contains duplicate blob or metadata UUIDs.\n' >&2
  exit 1
fi

INCOMPLETE_PAIRS="$(comm -3 "$BLOB_UUIDS" "$META_UUIDS")"
MISSING_ACTIVE_BLOBS="$(comm -23 "$ACTIVE_UUIDS" "$BLOB_UUIDS")"
MISSING_ACTIVE_META="$(comm -23 "$ACTIVE_UUIDS" "$META_UUIDS")"
if [[ -n "$INCOMPLETE_PAIRS" || -n "$MISSING_ACTIVE_BLOBS" || -n "$MISSING_ACTIVE_META" ]]; then
  printf 'Checkpoint mismatch: active=%s complete_pairs=%s incomplete_pairs=%s missing_active_blobs=%s missing_active_metadata=%s.\n' \
    "$(wc -l <"$ACTIVE_UUIDS" | tr -d ' ')" \
    "$(comm -12 "$BLOB_UUIDS" "$META_UUIDS" | wc -l | tr -d ' ')" \
    "$(printf '%s\n' "$INCOMPLETE_PAIRS" | sed '/^$/d' | wc -l | tr -d ' ')" \
    "$(printf '%s\n' "$MISSING_ACTIVE_BLOBS" | sed '/^$/d' | wc -l | tr -d ' ')" \
    "$(printf '%s\n' "$MISSING_ACTIVE_META" | sed '/^$/d' | wc -l | tr -d ' ')" >&2
  exit 1
fi

ACTIVE_COUNT="$(wc -l <"$ACTIVE_UUIDS" | tr -d ' ')"
PAIR_COUNT="$(wc -l <"$BLOB_UUIDS" | tr -d ' ')"
printf 'Checkpoint content validation passed: active_files=%s complete_pairs=%s deferred_pairs=%s.\n' \
  "$ACTIVE_COUNT" "$PAIR_COUNT" "$((PAIR_COUNT - ACTIVE_COUNT))"

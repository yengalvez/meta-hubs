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

for artifact in "$DUMP_PATH" "$ARCHIVE_PATH"; do
  if [[ ! -s "$artifact" ]]; then
    printf 'Checkpoint artifact is missing or empty: %s\n' "$artifact" >&2
    exit 1
  fi
  gzip -t "$artifact"
done

TMP_DIR="$(mktemp -d /tmp/yenhubs-checkpoint-validation.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT
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
   ! grep -Eq '^(CREATE TABLE|COPY) ret0\.schema_migrations' "$SQL_PATH"; then
  printf 'Database dump is missing required Reticulum schema markers.\n' >&2
  exit 1
fi

awk '
  BEGIN {
    in_owned_files = 0
    copy_blocks = 0
    uuid_column = 0
    state_column = 0
  }
  /^COPY ret0\.owned_files \(/ {
    if (in_owned_files || copy_blocks > 0) {
      print "Database dump has multiple or nested ret0.owned_files COPY blocks." > "/dev/stderr"
      exit 1
    }
    columns = $0
    sub(/^COPY ret0\.owned_files \(/, "", columns)
    sub(/\) FROM stdin;$/, "", columns)
    column_count = split(columns, names, /,[[:space:]]*/)
    for (column_index = 1; column_index <= column_count; column_index++) {
      if (names[column_index] == "owned_file_uuid") uuid_column = column_index
      if (names[column_index] == "state") state_column = column_index
    }
    if (uuid_column == 0 || state_column == 0) {
      print "ret0.owned_files COPY is missing owned_file_uuid or state." > "/dev/stderr"
      exit 1
    }
    copy_blocks++
    in_owned_files = 1
    next
  }
  in_owned_files && $0 == "\\." {
    in_owned_files = 0
    next
  }
  in_owned_files {
    value_count = split($0, values, "\t")
    if (value_count < uuid_column || value_count < state_column) {
      print "Malformed row in ret0.owned_files COPY data." > "/dev/stderr"
      exit 1
    }
    if (values[state_column] == "active") print values[uuid_column]
  }
  END {
    if (copy_blocks != 1 || in_owned_files) {
      print "Database dump does not contain one complete ret0.owned_files COPY block." > "/dev/stderr"
      exit 1
    }
  }
' "$SQL_PATH" >"$ACTIVE_UUIDS_RAW"

if awk '
  $0 !~ /^[A-Za-z0-9._-]+$/ { unsafe=1 }
  END { exit unsafe ? 0 : 1 }
' "$ACTIVE_UUIDS_RAW"; then
  printf 'Database dump contains an unsafe active owned_file_uuid.\n' >&2
  exit 1
fi
sort "$ACTIVE_UUIDS_RAW" >"$ACTIVE_UUIDS"
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

if awk '
  /^\// || /(^|\/)\.\.($|\/)/ { unsafe = 1; next }
  $0 !~ /^owned(\/|$)/ { unsafe = 1; next }
  $0 == "owned" || /\/$/ { next }
  /\.(blob|meta\.json)$/ { next }
  { unsafe = 1 }
  END { exit unsafe ? 0 : 1 }
' "$ARCHIVE_PATHS"; then
  printf 'Storage archive has unsafe paths or files outside the owned-file contract.\n' >&2
  exit 1
fi

sed -n 's#^.*/\([^/]*\)\.blob$#\1#p' "$ARCHIVE_PATHS" >"$BLOB_UUIDS_RAW"
sed -n 's#^.*/\([^/]*\)\.meta\.json$#\1#p' "$ARCHIVE_PATHS" >"$META_UUIDS_RAW"

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

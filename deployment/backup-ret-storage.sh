#!/usr/bin/env bash

# Exports Reticulum's durable owned-file storage from ret-pvc.
# The backup is accepted only when every active owned_files DB row has both a
# .blob and .meta.json file, preventing another metadata-only project freeze.

set -euo pipefail
umask 077

if [[ $# -ne 1 ]]; then
  printf 'Usage: %s /path/to/ret-storage-YYYYMMDD-HHMMSS.tar.gz\n' "$0" >&2
  exit 2
fi

OUTPUT_PATH="$1"
NAMESPACE="${NAMESPACE:-hcce}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deployment/lib/recovery-safety.sh
source "$SCRIPT_DIR/lib/recovery-safety.sh"

if [[ -e "$OUTPUT_PATH" ]]; then
  printf 'Refusing to overwrite existing backup: %s\n' "$OUTPUT_PATH" >&2
  exit 1
fi

recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
recovery_kubectl rollout status deployment/reticulum -n "$NAMESPACE" --timeout=5m >/dev/null
recovery_kubectl rollout status deployment/pgsql -n "$NAMESPACE" --timeout=5m >/dev/null

RET_PODS_JSON="$(recovery_kubectl get pod -n "$NAMESPACE" -l app=reticulum -o json)"
PGSQL_PODS_JSON="$(recovery_kubectl get pod -n "$NAMESPACE" -l app=pgsql -o json)"
if ! RET_POD_INFO="$(recovery_exact_ready_deployment_pod_info \
  "$RET_PODS_JSON" reticulum reticulum)" ||
   ! PGSQL_POD_INFO="$(recovery_exact_ready_deployment_pod_info \
  "$PGSQL_PODS_JSON" pgsql pgsql)"; then
  printf 'Exactly one Ready Reticulum and PostgreSQL pod is required.\n' >&2
  exit 1
fi
IFS=$'\t' read -r RET_POD RET_POD_UID RET_DEPLOYMENT_UID <<<"$RET_POD_INFO"
IFS=$'\t' read -r PGSQL_POD PGSQL_POD_UID PGSQL_DEPLOYMENT_UID <<<"$PGSQL_POD_INFO"
RET_POD_JSON="$(jq -cer '.items[0]' <<<"$RET_PODS_JSON")"
PGSQL_POD_JSON="$(jq -cer '.items[0]' <<<"$PGSQL_PODS_JSON")"

if [[ -z "$RET_POD" || -z "$RET_POD_UID" || -z "$PGSQL_POD" ||
      -z "$PGSQL_POD_UID" ]]; then
  printf 'Exactly one Ready Reticulum and PostgreSQL pod is required.\n' >&2
  exit 1
fi
if ! recovery_pod_pvc_mount_is_exact \
  "$RET_PODS_JSON" "$RET_POD" reticulum ret-pvc /storage; then
  printf 'Reticulum /storage is not the unique direct ret-pvc mount in the expected container.\n' >&2
  exit 1
fi
if ! jq -e '
  (.items | length) == 1 and
  ((.items[0].spec.ephemeralContainers // []) | length) == 0 and
  ((.items[0].spec.initContainers // []) | length) == 0
' >/dev/null <<<"$RET_PODS_JSON"; then
  printf 'Reticulum has unexpected init or ephemeral containers.\n' >&2
  exit 1
fi
recovery_require_pod_identity "$RET_POD" "$RET_POD_UID"
recovery_require_pod_deployment_ownership \
  "$RET_POD_JSON" reticulum "$RET_DEPLOYMENT_UID"
require_pgsql_source() {
  recovery_require_pod_identity "$PGSQL_POD" "$PGSQL_POD_UID" &&
    recovery_require_pod_deployment_ownership \
      "$PGSQL_POD_JSON" pgsql "$PGSQL_DEPLOYMENT_UID"
}
require_pgsql_source
recovery_require_exact_pvc_consumers ret-pvc "$RET_POD"

require_exact_reticulum_source() {
  local current_pods_json current_info current_name current_uid current_deployment_uid
  current_pods_json="$(
    recovery_kubectl get pod -n "$NAMESPACE" -l app=reticulum -o json
  )" || return 1
  current_info="$(recovery_exact_ready_deployment_pod_info \
    "$current_pods_json" reticulum reticulum)" || return 1
  IFS=$'\t' read -r current_name current_uid current_deployment_uid <<<"$current_info"
  [[ "$current_name" == "$RET_POD" && "$current_uid" == "$RET_POD_UID" &&
     "$current_deployment_uid" == "$RET_DEPLOYMENT_UID" ]] || return 1
  jq -e '
    ((.items[0].spec.initContainers // []) | length) == 0 and
    ((.items[0].spec.ephemeralContainers // []) | length) == 0
  ' >/dev/null <<<"$current_pods_json" || return 1
  recovery_pod_pvc_mount_is_exact \
    "$current_pods_json" "$RET_POD" reticulum ret-pvc /storage || return 1
  recovery_require_pod_identity "$RET_POD" "$RET_POD_UID" || return 1
  recovery_require_exact_pvc_consumers ret-pvc "$RET_POD"
}

DB_ACTIVE_COUNT="$(
  # Expansion is intentionally deferred to the shell inside the PostgreSQL pod.
  require_pgsql_source
  # shellcheck disable=SC2016
  recovery_kubectl exec -n "$NAMESPACE" "$PGSQL_POD" -- sh -ec \
    'psql -U "$POSTGRES_USER" -d retdb -Atc "select count(*) from ret0.owned_files where state = '\''active'\''"'
)"

DB_ACTIVE_UUIDS="$(
  # Expansion is intentionally deferred to the shell inside the PostgreSQL pod.
  require_pgsql_source
  # shellcheck disable=SC2016
  recovery_kubectl exec -n "$NAMESPACE" "$PGSQL_POD" -- sh -ec \
    'psql -U "$POSTGRES_USER" -d retdb -Atc "select owned_file_uuid from ret0.owned_files where state = '\''active'\'' order by owned_file_uuid"' \
    | tr -d '\r'
)"

STORAGE_PATHS_RAW="$(
  recovery_kubectl exec -n "$NAMESPACE" -c reticulum "$RET_POD" -- sh -ec \
    'test -d /storage/owned; cd /storage; { find owned -type d -print | sed "s|$|/|"; find owned -type f -print; }' \
    | tr -d '\r'
)"
if ! printf '%s\n' "$STORAGE_PATHS_RAW" | recovery_storage_path_stream_is_exact; then
  printf 'Reticulum storage contains paths outside its exact two-shard contract.\n' >&2
  exit 1
fi
STORAGE_BLOB_UUIDS_RAW="$(printf '%s\n' "$STORAGE_PATHS_RAW" |
  sed -n 's#^owned/[A-Za-z0-9._-][A-Za-z0-9._-]/[A-Za-z0-9._-][A-Za-z0-9._-]/\([A-Za-z0-9._-]*\)\.blob$#\1#p')"
STORAGE_META_UUIDS_RAW="$(printf '%s\n' "$STORAGE_PATHS_RAW" |
  sed -n 's#^owned/[A-Za-z0-9._-][A-Za-z0-9._-]/[A-Za-z0-9._-][A-Za-z0-9._-]/\([A-Za-z0-9._-]*\)\.meta\.json$#\1#p')"
STORAGE_BLOB_UUIDS="$(printf '%s\n' "$STORAGE_BLOB_UUIDS_RAW" | sed '/^$/d' | LC_ALL=C sort -u)"
STORAGE_META_UUIDS="$(printf '%s\n' "$STORAGE_META_UUIDS_RAW" | sed '/^$/d' | LC_ALL=C sort -u)"

BLOB_COUNT="$(printf '%s\n' "$STORAGE_BLOB_UUIDS_RAW" | sed '/^$/d' | wc -l | tr -d ' ')"
META_COUNT="$(printf '%s\n' "$STORAGE_META_UUIDS_RAW" | sed '/^$/d' | wc -l | tr -d ' ')"

DB_ACTIVE_UUID_COUNT="$(printf '%s\n' "$DB_ACTIVE_UUIDS" | sed '/^$/d' | wc -l | tr -d ' ')"
DB_ACTIVE_UNIQUE_UUID_COUNT="$(printf '%s\n' "$DB_ACTIVE_UUIDS" | sed '/^$/d' | sort -u | wc -l | tr -d ' ')"
if [[ ! "$DB_ACTIVE_COUNT" =~ ^[0-9]+$ || "$DB_ACTIVE_COUNT" -eq 0 ||
      ! "$BLOB_COUNT" =~ ^[0-9]+$ || ! "$META_COUNT" =~ ^[0-9]+$ ||
      "$DB_ACTIVE_UUID_COUNT" != "$DB_ACTIVE_COUNT" ||
      "$DB_ACTIVE_UNIQUE_UUID_COUNT" != "$DB_ACTIVE_COUNT" ]]; then
  printf 'Could not determine database/storage file counts.\n' >&2
  exit 1
fi
if printf '%s\n' "$DB_ACTIVE_UUIDS" | sed '/^$/d' | awk '
  $0 !~ /^[A-Za-z0-9._-]+$/ { unsafe=1 }
  END { exit unsafe ? 0 : 1 }
'; then
  printf 'Database returned an unsafe active owned-file UUID.\n' >&2
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
PARTIAL_PATH="$(mktemp "${OUTPUT_PATH}.partial.XXXXXX")"
MONITOR_STOP="$(mktemp "${OUTPUT_PATH}.monitor-stop.XXXXXX")"
MONITOR_FAILURE="$(mktemp "${OUTPUT_PATH}.monitor-failure.XXXXXX")"
ARCHIVE_PATH_LIST=""
rm -f -- "$MONITOR_STOP" "$MONITOR_FAILURE"
MONITOR_PID=""
stop_storage_monitor() {
  local status=0
  if [[ -n "$MONITOR_PID" ]]; then
    : >"$MONITOR_STOP"
    if wait "$MONITOR_PID"; then status=0; else status=$?; fi
    MONITOR_PID=""
  fi
  if [[ -s "$MONITOR_FAILURE" || "$status" -ne 0 ]]; then
    printf 'PVC/pod/consumer monitoring failed during storage backup.\n' >&2
    return 1
  fi
}
cleanup_storage_backup() {
  if ! stop_storage_monitor; then :; fi
  rm -f -- "$PARTIAL_PATH" "$MONITOR_STOP" "$MONITOR_FAILURE" \
    "${ARCHIVE_PATH_LIST:-}"
}
storage_backup_interrupted() {
  local status="$1"
  trap - EXIT INT TERM
  cleanup_storage_backup
  exit "$status"
}
trap cleanup_storage_backup EXIT
trap 'storage_backup_interrupted 130' INT
trap 'storage_backup_interrupted 143' TERM

recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
require_exact_reticulum_source
monitor_storage_backup() {
  while [[ ! -e "$MONITOR_STOP" ]]; do
    if ! recovery_require_cluster_identity ||
       ! recovery_require_pvc_identity ret-pvc ||
       ! require_exact_reticulum_source; then
      printf 'failed\n' >"$MONITOR_FAILURE"
      return 1
    fi
    sleep "${STORAGE_BACKUP_MONITOR_INTERVAL_SECONDS:-1}"
  done
}
monitor_storage_backup &
MONITOR_PID=$!
if recovery_kubectl exec -n "$NAMESPACE" -c reticulum "$RET_POD" -- \
  tar -C /storage -cf - owned | gzip -c > "$PARTIAL_PATH"; then
  archive_status=0
else
  archive_status=$?
fi
if ! stop_storage_monitor; then monitor_status=1; else monitor_status=0; fi
if [[ "$archive_status" -ne 0 || "$monitor_status" -ne 0 ]]; then
  printf 'Storage archive or its identity monitor failed.\n' >&2
  exit 1
fi
recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
require_exact_reticulum_source
chmod 600 "$PARTIAL_PATH"

gzip -t "$PARTIAL_PATH"
if gzip -cd "$PARTIAL_PATH" | tar -tvf - | awk '
  substr($0, 1, 1) != "-" && substr($0, 1, 1) != "d" { unsafe=1 }
  END { exit unsafe ? 0 : 1 }
'; then
  printf 'Archive verification failed: links or unsupported entry types are present.\n' >&2
  exit 1
fi
ARCHIVE_PATH_LIST="$(mktemp "${OUTPUT_PATH}.archive-paths.XXXXXX")"
gzip -cd "$PARTIAL_PATH" | tar -tf - >"$ARCHIVE_PATH_LIST"
if ! recovery_storage_paths_file_is_exact "$ARCHIVE_PATH_LIST"; then
  printf 'Archive verification failed: unsafe paths or unexpected files are present.\n' >&2
  exit 1
fi
ARCHIVE_BLOB_COUNT="$(recovery_extract_storage_uuids "$ARCHIVE_PATH_LIST" blob | wc -l | tr -d ' ')"
ARCHIVE_META_COUNT="$(recovery_extract_storage_uuids "$ARCHIVE_PATH_LIST" meta.json | wc -l | tr -d ' ')"
ARCHIVE_BLOB_UUIDS="$(recovery_extract_storage_uuids "$ARCHIVE_PATH_LIST" blob | sort -u)"
ARCHIVE_META_UUIDS="$(recovery_extract_storage_uuids "$ARCHIVE_PATH_LIST" meta.json | sort -u)"
rm -f -- "$ARCHIVE_PATH_LIST"
if printf '%s\n%s\n' "$ARCHIVE_BLOB_UUIDS" "$ARCHIVE_META_UUIDS" | awk '
  $0 !~ /^[A-Za-z0-9._-]+$/ { unsafe=1 }
  END { exit unsafe ? 0 : 1 }
'; then
  printf 'Archive verification failed: an unsafe owned-file UUID is present.\n' >&2
  exit 1
fi
ARCHIVE_MISSING_ACTIVE_BLOBS="$(comm -23 \
  <(printf '%s\n' "$DB_ACTIVE_UUIDS" | sed '/^$/d' | sort -u) \
  <(printf '%s\n' "$ARCHIVE_BLOB_UUIDS" | sed '/^$/d' | sort -u))"
ARCHIVE_MISSING_ACTIVE_META="$(comm -23 \
  <(printf '%s\n' "$DB_ACTIVE_UUIDS" | sed '/^$/d' | sort -u) \
  <(printf '%s\n' "$ARCHIVE_META_UUIDS" | sed '/^$/d' | sort -u))"
ARCHIVE_INCOMPLETE_PAIRS="$(comm -3 \
  <(printf '%s\n' "$ARCHIVE_BLOB_UUIDS" | sed '/^$/d' | sort -u) \
  <(printf '%s\n' "$ARCHIVE_META_UUIDS" | sed '/^$/d' | sort -u))"
ARCHIVE_UNIQUE_BLOB_COUNT="$(printf '%s\n' "$ARCHIVE_BLOB_UUIDS" | sed '/^$/d' | wc -l | tr -d ' ')"
ARCHIVE_UNIQUE_META_COUNT="$(printf '%s\n' "$ARCHIVE_META_UUIDS" | sed '/^$/d' | wc -l | tr -d ' ')"

if [[ -n "$ARCHIVE_MISSING_ACTIVE_BLOBS" || -n "$ARCHIVE_MISSING_ACTIVE_META" ||
      -n "$ARCHIVE_INCOMPLETE_PAIRS" || "$ARCHIVE_BLOB_COUNT" -ne "$ARCHIVE_META_COUNT" ||
      "$ARCHIVE_BLOB_COUNT" -ne "$ARCHIVE_UNIQUE_BLOB_COUNT" ||
      "$ARCHIVE_META_COUNT" -ne "$ARCHIVE_UNIQUE_META_COUNT" ||
      "$ARCHIVE_BLOB_COUNT" -lt "$DB_ACTIVE_COUNT" ]]; then
  printf 'Archive verification failed: DB active files=%s blobs=%s metadata=%s.\n' \
    "$DB_ACTIVE_COUNT" "$ARCHIVE_BLOB_COUNT" "$ARCHIVE_META_COUNT" >&2
  exit 1
fi

mv "$PARTIAL_PATH" "$OUTPUT_PATH"
chmod 600 "$OUTPUT_PATH"
cleanup_storage_backup
trap - EXIT INT TERM

SIZE_BYTES="$(recovery_file_size_bytes "$OUTPUT_PATH")"
printf 'Reticulum storage backup completed: path=%s active_files=%s complete_pairs=%s deferred_pairs=%s pvc_uid=%s size_bytes=%s\n' \
  "$OUTPUT_PATH" "$DB_ACTIVE_COUNT" "$ARCHIVE_BLOB_COUNT" "$((ARCHIVE_BLOB_COUNT - DB_ACTIVE_COUNT))" \
  "$RECOVERY_PVC_UID" "$SIZE_BYTES"

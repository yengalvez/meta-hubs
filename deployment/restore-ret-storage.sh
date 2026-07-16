#!/usr/bin/env bash

# Restores a verified Reticulum owned-file archive into a fresh/empty ret-pvc.
# RESTORE_STORAGE_PREFLIGHT=1 validates the archive and target identity without
# restoring. A real restore requires a confirmation bound to context,
# namespace and namespace UID.

set -euo pipefail
umask 077

if [[ $# -ne 1 ]]; then
  printf 'Usage: RESTORE_STORAGE_PREFLIGHT=1 %s /path/to/ret-storage.tar.gz\n' "$0" >&2
  exit 2
fi

ARCHIVE_PATH="$1"
NAMESPACE="${NAMESPACE:-hcce}"
PREFLIGHT="${RESTORE_STORAGE_PREFLIGHT:-${RESTORE_STORAGE_DRY_RUN:-0}}"
RESTORE_POD="ret-storage-restore"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deployment/lib/recovery-safety.sh
source "$SCRIPT_DIR/lib/recovery-safety.sh"

if [[ -n "${RESTORE_STORAGE_DRY_RUN:-}" && -z "${RESTORE_STORAGE_PREFLIGHT:-}" ]]; then
  printf 'RESTORE_STORAGE_DRY_RUN is deprecated; this is a preflight only. Use RESTORE_STORAGE_PREFLIGHT=1.\n' >&2
fi
if [[ "$PREFLIGHT" != "0" && "$PREFLIGHT" != "1" ]]; then
  printf 'RESTORE_STORAGE_PREFLIGHT must be 0 or 1.\n' >&2
  exit 2
fi

if [[ ! -s "$ARCHIVE_PATH" ]]; then
  printf 'Storage archive is missing or empty: %s\n' "$ARCHIVE_PATH" >&2
  exit 1
fi

gzip -t "$ARCHIVE_PATH"

if gzip -cd "$ARCHIVE_PATH" | tar -tvf - | awk '
  substr($0, 1, 1) != "-" && substr($0, 1, 1) != "d" { unsafe=1 }
  END { exit unsafe ? 0 : 1 }
'; then
  printf 'Archive contains links or unsupported entry types.\n' >&2
  exit 1
fi

if gzip -cd "$ARCHIVE_PATH" | tar -tf - | awk '
  /^\// || /(^|\/)\.\.($|\/)/ { unsafe=1 }
  $0 !~ /^owned(\/|$)/ { unsafe=1; next }
  $0 == "owned" || /\/$/ { next }
  /\.(blob|meta\.json)$/ { next }
  { unsafe=1 }
  END { exit unsafe ? 0 : 1 }
'; then
  printf 'Archive contains unsafe paths or files outside the owned-file contract.\n' >&2
  exit 1
fi

ARCHIVE_BLOB_COUNT="$(gzip -cd "$ARCHIVE_PATH" | tar -tf - | awk '/\.blob$/ { count++ } END { print count + 0 }')"
ARCHIVE_META_COUNT="$(gzip -cd "$ARCHIVE_PATH" | tar -tf - | awk '/\.meta\.json$/ { count++ } END { print count + 0 }')"
ARCHIVE_BLOB_UUIDS="$(gzip -cd "$ARCHIVE_PATH" | tar -tf - | sed -n 's#^.*/\([^/]*\)\.blob$#\1#p' | sort -u)"
ARCHIVE_META_UUIDS="$(gzip -cd "$ARCHIVE_PATH" | tar -tf - | sed -n 's#^.*/\([^/]*\)\.meta\.json$#\1#p' | sort -u)"
ARCHIVE_INCOMPLETE_PAIRS="$(comm -3 \
  <(printf '%s\n' "$ARCHIVE_BLOB_UUIDS" | sed '/^$/d' | sort -u) \
  <(printf '%s\n' "$ARCHIVE_META_UUIDS" | sed '/^$/d' | sort -u))"

if printf '%s\n%s\n' "$ARCHIVE_BLOB_UUIDS" "$ARCHIVE_META_UUIDS" | awk '
  $0 !~ /^[A-Za-z0-9._-]+$/ { unsafe=1 }
  END { exit unsafe ? 0 : 1 }
'; then
  printf 'Archive contains an unsafe owned-file UUID.\n' >&2
  exit 1
fi

ARCHIVE_UNIQUE_BLOB_COUNT="$(printf '%s\n' "$ARCHIVE_BLOB_UUIDS" | sed '/^$/d' | wc -l | tr -d ' ')"
ARCHIVE_UNIQUE_META_COUNT="$(printf '%s\n' "$ARCHIVE_META_UUIDS" | sed '/^$/d' | wc -l | tr -d ' ')"
if [[ "$ARCHIVE_BLOB_COUNT" -eq 0 || "$ARCHIVE_BLOB_COUNT" -ne "$ARCHIVE_META_COUNT" ||
      "$ARCHIVE_BLOB_COUNT" -ne "$ARCHIVE_UNIQUE_BLOB_COUNT" ||
      "$ARCHIVE_META_COUNT" -ne "$ARCHIVE_UNIQUE_META_COUNT" ||
      -n "$ARCHIVE_INCOMPLETE_PAIRS" ]]; then
  printf 'Invalid storage archive: blobs=%s metadata=%s.\n' "$ARCHIVE_BLOB_COUNT" "$ARCHIVE_META_COUNT" >&2
  exit 1
fi

recovery_require_cluster_identity
recovery_kubectl get pvc ret-pvc -n "$NAMESPACE" >/dev/null
recovery_kubectl rollout status deployment/pgsql -n "$NAMESPACE" --timeout=5m >/dev/null

PGSQL_POD="$(recovery_kubectl get pod -n "$NAMESPACE" -l app=pgsql -o jsonpath='{.items[0].metadata.name}')"
DB_ACTIVE_COUNT="$(
  # Expansion is intentionally deferred to the shell inside the PostgreSQL pod.
  # shellcheck disable=SC2016
  recovery_kubectl exec -n "$NAMESPACE" "$PGSQL_POD" -- sh -ec \
    'psql -U "$POSTGRES_USER" -d retdb -Atc "select count(*) from ret0.owned_files where state = '\''active'\''"'
)"
DB_ACTIVE_UUIDS="$(
  # Expansion is intentionally deferred to the shell inside the PostgreSQL pod.
  # shellcheck disable=SC2016
  recovery_kubectl exec -n "$NAMESPACE" "$PGSQL_POD" -- sh -ec \
    'psql -U "$POSTGRES_USER" -d retdb -Atc "select owned_file_uuid from ret0.owned_files where state = '\''active'\'' order by owned_file_uuid"' \
    | tr -d '\r'
)"
if [[ ! "$DB_ACTIVE_COUNT" =~ ^[0-9]+$ ]]; then
  printf 'Could not determine a numeric active owned-file count.\n' >&2
  exit 1
fi
MISSING_ACTIVE_BLOBS="$(comm -23 \
  <(printf '%s\n' "$DB_ACTIVE_UUIDS" | sed '/^$/d' | sort -u) \
  <(printf '%s\n' "$ARCHIVE_BLOB_UUIDS" | sed '/^$/d' | sort -u))"
MISSING_ACTIVE_META="$(comm -23 \
  <(printf '%s\n' "$DB_ACTIVE_UUIDS" | sed '/^$/d' | sort -u) \
  <(printf '%s\n' "$ARCHIVE_META_UUIDS" | sed '/^$/d' | sort -u))"

if [[ "$ARCHIVE_BLOB_COUNT" -lt "$DB_ACTIVE_COUNT" || -n "$MISSING_ACTIVE_BLOBS" ||
      -n "$MISSING_ACTIVE_META" ]]; then
  printf 'Archive/database mismatch: DB active files=%s archive files=%s missing_active_blobs=%s missing_active_metadata=%s.\n' \
    "$DB_ACTIVE_COUNT" "$ARCHIVE_BLOB_COUNT" \
    "$(printf '%s\n' "$MISSING_ACTIVE_BLOBS" | sed '/^$/d' | wc -l | tr -d ' ')" \
    "$(printf '%s\n' "$MISSING_ACTIVE_META" | sed '/^$/d' | wc -l | tr -d ' ')" >&2
  exit 1
fi

if [[ "$PREFLIGHT" == "1" ]]; then
  printf 'Storage restore preflight passed (no restore performed): archive=%s active_files=%s complete_pairs=%s deferred_pairs=%s context=%s namespace=%s namespace_uid=%s pvc=ret-pvc\n' \
    "$ARCHIVE_PATH" "$DB_ACTIVE_COUNT" "$ARCHIVE_BLOB_COUNT" \
    "$((ARCHIVE_BLOB_COUNT - DB_ACTIVE_COUNT))" "$EXPECTED_KUBE_CONTEXT" "$NAMESPACE" "$RECOVERY_NAMESPACE_UID"
  exit 0
fi

recovery_require_confirmation CONFIRM_RESTORE_STORAGE ret-pvc

RET_IMAGE="$(recovery_kubectl get deployment reticulum -n "$NAMESPACE" -o jsonpath='{.spec.template.spec.containers[?(@.name=="reticulum")].image}')"
RET_REPLICAS="$(recovery_kubectl get deployment reticulum -n "$NAMESPACE" -o jsonpath='{.spec.replicas}')"
RET_SELECTOR="$(recovery_kubectl get deployment reticulum -n "$NAMESPACE" -o jsonpath='{.spec.selector.matchLabels.app}')"

if [[ -z "$RET_IMAGE" || -z "$RET_REPLICAS" || -z "$RET_SELECTOR" ]]; then
  printf 'Could not capture the Reticulum image, replicas and selector; no workload was stopped.\n' >&2
  exit 1
fi

cleanup() {
  recovery_kubectl delete pod "$RESTORE_POD" -n "$NAMESPACE" --ignore-not-found >/dev/null 2>&1 || true
}
storage_restore_failed() {
  printf 'Storage restore stopped. Reticulum remains at zero for safety.\n' >&2
}
trap cleanup EXIT
trap storage_restore_failed ERR

recovery_kubectl scale deployment reticulum -n "$NAMESPACE" --replicas=0 >/dev/null
recovery_wait_for_no_pods "app=$RET_SELECTOR" deployment/reticulum 180s

recovery_kubectl delete pod "$RESTORE_POD" -n "$NAMESPACE" --ignore-not-found >/dev/null
if recovery_kubectl get pod "$RESTORE_POD" -n "$NAMESPACE" >/dev/null 2>&1; then
  if ! recovery_kubectl wait --for=delete "pod/$RESTORE_POD" -n "$NAMESPACE" --timeout=180s >/dev/null; then
    printf 'Timed out deleting an earlier restore pod; refusing PVC mutation.\n' >&2
    false
  fi
fi

# Revalidate after quiescing Reticulum and immediately before creating the pod
# that can write to ret-pvc.
recovery_require_cluster_identity

cat <<EOF | recovery_kubectl apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata:
  name: $RESTORE_POD
  namespace: $NAMESPACE
spec:
  restartPolicy: Never
  containers:
    - name: restore
      image: $RET_IMAGE
      command: ["sh", "-c", "sleep 3600"]
      volumeMounts:
        - name: storage
          mountPath: /storage
  volumes:
    - name: storage
      persistentVolumeClaim:
        claimName: ret-pvc
EOF

recovery_kubectl wait --for=condition=Ready pod/$RESTORE_POD -n "$NAMESPACE" --timeout=180s >/dev/null

EXISTING_COUNT="$(
  recovery_kubectl exec -n "$NAMESPACE" "$RESTORE_POD" -- sh -ec \
    'find /storage/owned -type f 2>/dev/null | wc -l' | tr -d ' '
)"

if [[ "$EXISTING_COUNT" -ne 0 ]]; then
  printf 'Refusing to merge into non-empty ret-pvc: existing owned files=%s.\n' "$EXISTING_COUNT" >&2
  printf 'The Reticulum deployment remains at zero for inspection.\n' >&2
  exit 1
fi

gzip -cd "$ARCHIVE_PATH" | recovery_kubectl exec -i -n "$NAMESPACE" "$RESTORE_POD" -- tar -C /storage -xf -

RESTORED_COUNTS="$(
  recovery_kubectl exec -n "$NAMESPACE" "$RESTORE_POD" -- sh -ec '
    find /storage/owned -type f -name "*.blob" | wc -l
    find /storage/owned -type f -name "*.meta.json" | wc -l
  '
)"
RESTORED_BLOBS="$(printf '%s\n' "$RESTORED_COUNTS" | sed -n '1p' | tr -d ' ')"
RESTORED_META="$(printf '%s\n' "$RESTORED_COUNTS" | sed -n '2p' | tr -d ' ')"
RESTORED_BLOB_UUIDS="$(
  recovery_kubectl exec -n "$NAMESPACE" "$RESTORE_POD" -- sh -ec \
    'find /storage/owned -type f -name "*.blob" -exec basename {} .blob \; 2>/dev/null | sort -u' \
    | tr -d '\r'
)"
RESTORED_META_UUIDS="$(
  recovery_kubectl exec -n "$NAMESPACE" "$RESTORE_POD" -- sh -ec \
    'find /storage/owned -type f -name "*.meta.json" -exec basename {} .meta.json \; 2>/dev/null | sort -u' \
    | tr -d '\r'
)"
RESTORED_MISSING_ACTIVE_BLOBS="$(comm -23 \
  <(printf '%s\n' "$DB_ACTIVE_UUIDS" | sed '/^$/d' | sort -u) \
  <(printf '%s\n' "$RESTORED_BLOB_UUIDS" | sed '/^$/d' | sort -u))"
RESTORED_MISSING_ACTIVE_META="$(comm -23 \
  <(printf '%s\n' "$DB_ACTIVE_UUIDS" | sed '/^$/d' | sort -u) \
  <(printf '%s\n' "$RESTORED_META_UUIDS" | sed '/^$/d' | sort -u))"
RESTORED_INCOMPLETE_PAIRS="$(comm -3 \
  <(printf '%s\n' "$RESTORED_BLOB_UUIDS" | sed '/^$/d' | sort -u) \
  <(printf '%s\n' "$RESTORED_META_UUIDS" | sed '/^$/d' | sort -u))"

if [[ "$RESTORED_BLOBS" -ne "$ARCHIVE_BLOB_COUNT" || "$RESTORED_META" -ne "$ARCHIVE_META_COUNT" ||
      -n "$RESTORED_MISSING_ACTIVE_BLOBS" || -n "$RESTORED_MISSING_ACTIVE_META" ||
      -n "$RESTORED_INCOMPLETE_PAIRS" ]]; then
  printf 'Storage restore verification failed: DB=%s blobs=%s metadata=%s.\n' \
    "$DB_ACTIVE_COUNT" "$RESTORED_BLOBS" "$RESTORED_META" >&2
  printf 'The Reticulum deployment remains at zero for inspection.\n' >&2
  exit 1
fi

cleanup
trap - EXIT
trap - ERR
recovery_kubectl scale deployment reticulum -n "$NAMESPACE" --replicas="$RET_REPLICAS" >/dev/null
recovery_kubectl rollout status deployment/reticulum -n "$NAMESPACE" --timeout=5m >/dev/null

printf 'Reticulum storage restore completed: active_files=%s complete_pairs=%s deferred_pairs=%s namespace=%s pvc=ret-pvc\n' \
  "$DB_ACTIVE_COUNT" "$RESTORED_BLOBS" "$((RESTORED_BLOBS - DB_ACTIVE_COUNT))" "$NAMESPACE"

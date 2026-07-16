#!/usr/bin/env bash

# Restores a verified Reticulum owned-file archive into a fresh/empty ret-pvc.
# A destructive restore requires CONFIRM_RESTORE_STORAGE=ret-pvc. Dry-run mode
# validates the archive, database, PVC and cluster without changing anything.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf 'Usage: RESTORE_STORAGE_DRY_RUN=1 %s /path/to/ret-storage.tar.gz\n' "$0" >&2
  exit 2
fi

ARCHIVE_PATH="$1"
NAMESPACE="${NAMESPACE:-hcce}"
DRY_RUN="${RESTORE_STORAGE_DRY_RUN:-0}"
RESTORE_POD="ret-storage-restore"

if [[ ! -s "$ARCHIVE_PATH" ]]; then
  printf 'Storage archive is missing or empty: %s\n' "$ARCHIVE_PATH" >&2
  exit 1
fi

gzip -t "$ARCHIVE_PATH"

if gzip -cd "$ARCHIVE_PATH" | tar -tf - | awk '
  /^\// || /(^|\/)\.\.($|\/)/ { unsafe=1 }
  $0 !~ /^owned(\/|$)/ { unsafe=1 }
  END { exit unsafe ? 0 : 1 }
'; then
  printf 'Archive contains unsafe paths or data outside owned/.\n' >&2
  exit 1
fi

ARCHIVE_BLOB_COUNT="$(gzip -cd "$ARCHIVE_PATH" | tar -tf - | awk '/\.blob$/ { count++ } END { print count + 0 }')"
ARCHIVE_META_COUNT="$(gzip -cd "$ARCHIVE_PATH" | tar -tf - | awk '/\.meta\.json$/ { count++ } END { print count + 0 }')"
ARCHIVE_BLOB_UUIDS="$(gzip -cd "$ARCHIVE_PATH" | tar -tf - | sed -n 's#^.*/\([^/]*\)\.blob$#\1#p' | sort -u)"
ARCHIVE_META_UUIDS="$(gzip -cd "$ARCHIVE_PATH" | tar -tf - | sed -n 's#^.*/\([^/]*\)\.meta\.json$#\1#p' | sort -u)"
ARCHIVE_INCOMPLETE_PAIRS="$(comm -3 \
  <(printf '%s\n' "$ARCHIVE_BLOB_UUIDS" | sed '/^$/d' | sort -u) \
  <(printf '%s\n' "$ARCHIVE_META_UUIDS" | sed '/^$/d' | sort -u))"

if [[ "$ARCHIVE_BLOB_COUNT" -eq 0 || "$ARCHIVE_BLOB_COUNT" -ne "$ARCHIVE_META_COUNT" ||
      -n "$ARCHIVE_INCOMPLETE_PAIRS" ]]; then
  printf 'Invalid storage archive: blobs=%s metadata=%s.\n' "$ARCHIVE_BLOB_COUNT" "$ARCHIVE_META_COUNT" >&2
  exit 1
fi

kubectl get namespace "$NAMESPACE" >/dev/null
kubectl get pvc ret-pvc -n "$NAMESPACE" >/dev/null
kubectl rollout status deployment/pgsql -n "$NAMESPACE" --timeout=5m >/dev/null

PGSQL_POD="$(kubectl get pod -n "$NAMESPACE" -l app=pgsql -o jsonpath='{.items[0].metadata.name}')"
DB_ACTIVE_COUNT="$(
  # Expansion is intentionally deferred to the shell inside the PostgreSQL pod.
  # shellcheck disable=SC2016
  kubectl exec -n "$NAMESPACE" "$PGSQL_POD" -- sh -ec \
    'psql -U "$POSTGRES_USER" -d retdb -Atc "select count(*) from ret0.owned_files where state = '\''active'\''"'
)"
DB_ACTIVE_UUIDS="$(
  # Expansion is intentionally deferred to the shell inside the PostgreSQL pod.
  # shellcheck disable=SC2016
  kubectl exec -n "$NAMESPACE" "$PGSQL_POD" -- sh -ec \
    'psql -U "$POSTGRES_USER" -d retdb -Atc "select owned_file_uuid from ret0.owned_files where state = '\''active'\'' order by owned_file_uuid"' \
    | tr -d '\r'
)"
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

if [[ "$DRY_RUN" == "1" ]]; then
  printf 'Storage restore preflight passed: archive=%s active_files=%s complete_pairs=%s deferred_pairs=%s namespace=%s pvc=ret-pvc\n' \
    "$ARCHIVE_PATH" "$DB_ACTIVE_COUNT" "$ARCHIVE_BLOB_COUNT" \
    "$((ARCHIVE_BLOB_COUNT - DB_ACTIVE_COUNT))" "$NAMESPACE"
  exit 0
fi

if [[ "${CONFIRM_RESTORE_STORAGE:-}" != "ret-pvc" ]]; then
  printf 'Refusing destructive restore. Set CONFIRM_RESTORE_STORAGE=ret-pvc explicitly.\n' >&2
  exit 1
fi

RET_IMAGE="$(kubectl get deployment reticulum -n "$NAMESPACE" -o jsonpath='{.spec.template.spec.containers[?(@.name=="reticulum")].image}')"
RET_REPLICAS="$(kubectl get deployment reticulum -n "$NAMESPACE" -o jsonpath='{.spec.replicas}')"

kubectl scale deployment reticulum -n "$NAMESPACE" --replicas=0 >/dev/null
kubectl wait --for=delete pod -n "$NAMESPACE" -l app=reticulum --timeout=180s >/dev/null 2>&1 || true
kubectl delete pod "$RESTORE_POD" -n "$NAMESPACE" --ignore-not-found >/dev/null

cleanup() {
  kubectl delete pod "$RESTORE_POD" -n "$NAMESPACE" --ignore-not-found >/dev/null 2>&1 || true
}
trap cleanup EXIT

cat <<EOF | kubectl apply -f - >/dev/null
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

kubectl wait --for=condition=Ready pod/$RESTORE_POD -n "$NAMESPACE" --timeout=180s >/dev/null

EXISTING_COUNT="$(
  kubectl exec -n "$NAMESPACE" "$RESTORE_POD" -- sh -ec \
    'find /storage/owned -type f 2>/dev/null | wc -l' | tr -d ' '
)"

if [[ "$EXISTING_COUNT" -ne 0 ]]; then
  printf 'Refusing to merge into non-empty ret-pvc: existing owned files=%s.\n' "$EXISTING_COUNT" >&2
  printf 'The Reticulum deployment remains at zero for inspection.\n' >&2
  exit 1
fi

gzip -cd "$ARCHIVE_PATH" | kubectl exec -i -n "$NAMESPACE" "$RESTORE_POD" -- tar -C /storage -xf -

RESTORED_COUNTS="$(
  kubectl exec -n "$NAMESPACE" "$RESTORE_POD" -- sh -ec '
    find /storage/owned -type f -name "*.blob" | wc -l
    find /storage/owned -type f -name "*.meta.json" | wc -l
  '
)"
RESTORED_BLOBS="$(printf '%s\n' "$RESTORED_COUNTS" | sed -n '1p' | tr -d ' ')"
RESTORED_META="$(printf '%s\n' "$RESTORED_COUNTS" | sed -n '2p' | tr -d ' ')"
RESTORED_BLOB_UUIDS="$(
  kubectl exec -n "$NAMESPACE" "$RESTORE_POD" -- sh -ec \
    'find /storage/owned -type f -name "*.blob" -exec basename {} .blob \; 2>/dev/null | sort -u' \
    | tr -d '\r'
)"
RESTORED_META_UUIDS="$(
  kubectl exec -n "$NAMESPACE" "$RESTORE_POD" -- sh -ec \
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
kubectl scale deployment reticulum -n "$NAMESPACE" --replicas="$RET_REPLICAS" >/dev/null
kubectl rollout status deployment/reticulum -n "$NAMESPACE" --timeout=5m >/dev/null

printf 'Reticulum storage restore completed: active_files=%s complete_pairs=%s deferred_pairs=%s namespace=%s pvc=ret-pvc\n' \
  "$DB_ACTIVE_COUNT" "$RESTORED_BLOBS" "$((RESTORED_BLOBS - DB_ACTIVE_COUNT))" "$NAMESPACE"

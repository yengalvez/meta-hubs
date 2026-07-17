#!/usr/bin/env bash

# Capture ret-pvc while every Reticulum/DB writer is held at zero by the
# checkpoint coordinator. The only PVC consumer is a read-only, operation-
# unique helper protected by an admitted deny-all NetworkPolicy.

set -Eeuo pipefail
umask 077

if [[ $# -ne 2 ]]; then
  printf 'Usage: %s /path/to/ret-storage-STAMP.tar.gz /path/to/deployment-images.json\n' "$0" >&2
  exit 2
fi

OUTPUT_PATH="$1"
INVENTORY_PATH="$2"
NAMESPACE="${NAMESPACE:-hcce}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARENT_CHECKPOINT_STAMP="${RECOVERY_CHECKPOINT_STAMP:-}"
PARENT_DUMP_SHA256="${RECOVERY_DUMP_SHA256:-}"
PARENT_STORAGE_SHA256="${RECOVERY_STORAGE_SHA256:-}"
PARENT_NAMESPACE_UID="${RECOVERY_NAMESPACE_UID:-}"
PARENT_PVC_UID="${RECOVERY_PVC_UID:-}"
# shellcheck source=deployment/lib/recovery-safety.sh
source "$SCRIPT_DIR/lib/recovery-safety.sh"
RECOVERY_CHECKPOINT_STAMP="$PARENT_CHECKPOINT_STAMP"
RECOVERY_DUMP_SHA256="$PARENT_DUMP_SHA256"
RECOVERY_STORAGE_SHA256="$PARENT_STORAGE_SHA256"
RECOVERY_NAMESPACE_UID="$PARENT_NAMESPACE_UID"
RECOVERY_PVC_UID="$PARENT_PVC_UID"

[[ ! -e "$OUTPUT_PATH" && ! -L "$OUTPUT_PATH" ]] || {
  printf 'Refusing to overwrite an existing storage backup.\n' >&2
  exit 1
}
recovery_require_regular_direct_file "$INVENTORY_PATH" || {
  printf 'A direct regular deployment inventory is required.\n' >&2
  exit 1
}
[[ "${RECOVERY_OPERATION_OWNER:-}" == checkpoint-backup ]] || {
  printf 'Quiesced storage backup requires the checkpoint-backup owner.\n' >&2
  exit 1
}
if [[ -z "${RECOVERY_CONSUMER_CONTRACT_JSON:-}" ]] ||
   ! recovery_consumer_contract_is_acceptable "$RECOVERY_CONSUMER_CONTRACT_JSON"; then
  printf 'Quiesced storage backup requires the exact post-lock consumer contract.\n' >&2
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT_PATH")"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/yenhubs-quiesced-storage.XXXXXX")"
chmod 700 "$WORK_DIR"
PARTIAL_PATH="$(mktemp "${OUTPUT_PATH}.partial.XXXXXX")"
PATHS_BEFORE="$WORK_DIR/paths-before"
ARCHIVE_PATHS="$WORK_DIR/archive-paths"
DB_ACTIVE_BEFORE="$WORK_DIR/db-active-before"
DB_ACTIVE_AFTER="$WORK_DIR/db-active-after"
CONTRACT_BEFORE="$WORK_DIR/database-contract-before.json"
CONTRACT_AFTER="$WORK_DIR/database-contract-after.json"
MONITOR_STOP="$WORK_DIR/monitor-stop"
MONITOR_FAILURE="$WORK_DIR/monitor-failure"
HELPER_POD="ret-storage-backup-${RECOVERY_OPERATION_ID:0:12}"
HELPER_POLICY="ret-storage-backup-deny-${RECOVERY_OPERATION_ID:0:12}"
HELPER_POD_UID=""
HELPER_POLICY_UID=""
HELPER_POD_CREATED=0
HELPER_POLICY_CREATED=0
MONITOR_PID=""

helper_pod_is_exact() {
  local pod_json="$1"
  [[ -n "$HELPER_POD_UID" ]] &&
    recovery_storage_helper_pod_is_exact "$pod_json" "$HELPER_POD" \
      "$HELPER_POD_UID" ret-storage-backup "$RET_IMAGE" true
}

helper_policy_is_exact() {
  local policy_json="$1"
  [[ -n "$HELPER_POLICY_UID" ]] &&
    recovery_storage_helper_network_policy_is_exact "$policy_json" \
      "$HELPER_POLICY" "$HELPER_POLICY_UID" ret-storage-backup
}

require_helper_pod() {
  local pod_json current_uid
  pod_json="$(recovery_kubectl get pod "$HELPER_POD" -n "$NAMESPACE" -o json)" || return 1
  current_uid="$(jq -er '.metadata.uid | select(type == "string" and length > 0)' \
    <<<"$pod_json")" || return 1
  [[ "$current_uid" == "$HELPER_POD_UID" ]] && helper_pod_is_exact "$pod_json"
}

require_helper_policy() {
  local policy_json current_uid
  policy_json="$(recovery_kubectl get networkpolicy "$HELPER_POLICY" \
    -n "$NAMESPACE" -o json)" || return 1
  current_uid="$(jq -er '.metadata.uid | select(type == "string" and length > 0)' \
    <<<"$policy_json")" || return 1
  [[ "$current_uid" == "$HELPER_POLICY_UID" ]] && helper_policy_is_exact "$policy_json"
}

stop_monitor() {
  local status=0
  if [[ -n "$MONITOR_PID" ]]; then
    : >"$MONITOR_STOP"
    if wait "$MONITOR_PID"; then status=0; else status=$?; fi
    MONITOR_PID=""
  fi
  [[ "$status" == 0 && ! -s "$MONITOR_FAILURE" ]]
}

delete_helper_pod() {
  [[ "$HELPER_POD_CREATED" == 1 ]] || return 0
  recovery_require_operation_lock || return 1
  recovery_require_exact_pvc_consumers ret-pvc "$HELPER_POD" || return 1
  require_helper_pod || return 1
  recovery_delete_namespaced_with_uid pod "$HELPER_POD" "$HELPER_POD_UID" 180 || return 1
  HELPER_POD_CREATED=0
  recovery_require_exact_pvc_consumers ret-pvc
}

delete_helper_policy() {
  [[ "$HELPER_POLICY_CREATED" == 1 ]] || return 0
  recovery_require_operation_lock || return 1
  require_helper_policy || return 1
  recovery_delete_namespaced_with_uid networkpolicy "$HELPER_POLICY" \
    "$HELPER_POLICY_UID" 60 || return 1
  HELPER_POLICY_CREATED=0
}

cleanup() {
  local status="$?" cleanup_status=0 pod_status=0
  trap - EXIT ERR INT TERM
  stop_monitor || cleanup_status=1
  if ! delete_helper_pod; then pod_status=1; cleanup_status=1; fi
  if [[ "$pod_status" == 0 ]] && ! delete_helper_policy; then cleanup_status=1; fi
  rm -rf -- "$WORK_DIR"
  rm -f -- "$PARTIAL_PATH"
  if [[ "$status" == 0 && "$cleanup_status" != 0 ]]; then status=1; fi
  exit "$status"
}

interrupted() {
  local status="$1"
  exit "$status"
}

trap cleanup EXIT
trap 'interrupted 130' INT
trap 'interrupted 143' TERM

recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
recovery_require_operation_lock
recovery_deployment_inventory_is_acceptable \
  "$INVENTORY_PATH" "$NAMESPACE" "$RECOVERY_NAMESPACE_UID" || {
  printf 'Deployment inventory is not the exact YenHubs 13-image contract.\n' >&2
  exit 1
}
RET_IMAGE="$(recovery_checkpoint_image_for_pair \
  "$INVENTORY_PATH" reticulum/reticulum ghcr.io/yengalvez/reticulum)" || {
  printf 'Inventory does not bind the trusted Reticulum helper image.\n' >&2
  exit 1
}

for deployment in reticulum pgbouncer pgbouncer-t bot-orchestrator coturn; do
  recovery_require_operation_lock
  recovery_require_consumer_contract_entry "$RECOVERY_CONSUMER_CONTRACT_JSON" \
    "$deployment" 0 || {
    printf 'A checkpoint writer is not held at its exact post-lock zero state: %s.\n' \
      "$deployment" >&2
    exit 1
  }
done
recovery_require_exact_pvc_consumers ret-pvc

PGSQL_PODS_JSON="$(recovery_kubectl get pod -n "$NAMESPACE" -l app=pgsql -o json)"
PGSQL_INFO="$(recovery_exact_ready_deployment_pod_info \
  "$PGSQL_PODS_JSON" pgsql pgsql)" || {
  printf 'Exactly one owned Ready PostgreSQL pod is required.\n' >&2
  exit 1
}
IFS=$'\t' read -r PGSQL_POD PGSQL_POD_UID PGSQL_DEPLOYMENT_UID <<<"$PGSQL_INFO"
PGSQL_POD_JSON="$(jq -cer '.items[0]' <<<"$PGSQL_PODS_JSON")"
require_pgsql_source() {
  recovery_require_pod_identity "$PGSQL_POD" "$PGSQL_POD_UID" &&
    recovery_require_pod_deployment_ownership \
      "$PGSQL_POD_JSON" pgsql "$PGSQL_DEPLOYMENT_UID"
}
require_pgsql_source
recovery_capture_live_database_contract "$PGSQL_POD" "$CONTRACT_BEFORE"
# Expansion is intentionally deferred to the PostgreSQL container.
# shellcheck disable=SC2016
recovery_kubectl exec -n "$NAMESPACE" "$PGSQL_POD" -- sh -ec \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d retdb -Atc "select owned_file_uuid from ret0.owned_files where state::text = '\''active'\'' order by owned_file_uuid"' \
  | tr -d '\r' | LC_ALL=C sort >"$DB_ACTIVE_BEFORE"
[[ -s "$DB_ACTIVE_BEFORE" ]] &&
  [[ "$(wc -l <"$DB_ACTIVE_BEFORE" | tr -d ' ')" == \
     "$(LC_ALL=C sort -u "$DB_ACTIVE_BEFORE" | wc -l | tr -d ' ')" ]] || {
  printf 'Active owned-file DB baseline is empty or duplicated.\n' >&2
  exit 1
}

recovery_require_operation_lock
cat <<EOF | recovery_kubectl create -f - >/dev/null
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: $HELPER_POLICY
  namespace: $NAMESPACE
  labels:
    yenhubs.org/recovery-owner: ret-storage-backup
    yenhubs.org/operation-id: "$RECOVERY_OPERATION_ID"
  annotations:
    yenhubs.org/operation-lock-uid: "$RECOVERY_OPERATION_LOCK_UID"
    yenhubs.org/operation-token: "$RECOVERY_OPERATION_TOKEN"
spec:
  podSelector:
    matchLabels:
      yenhubs.org/operation-id: "$RECOVERY_OPERATION_ID"
  policyTypes: [Ingress, Egress]
  ingress: []
  egress: []
EOF
HELPER_POLICY_CREATED=1
policy_json="$(recovery_kubectl get networkpolicy "$HELPER_POLICY" -n "$NAMESPACE" -o json)"
HELPER_POLICY_UID="$(jq -er '.metadata.uid | select(type == "string" and length > 0)' \
  <<<"$policy_json")"
helper_policy_is_exact "$policy_json" || {
  printf 'Admitted backup NetworkPolicy differs from the exact deny-all contract.\n' >&2
  exit 1
}

recovery_require_operation_lock
require_helper_policy
cat <<EOF | recovery_kubectl create -f - >/dev/null
apiVersion: v1
kind: Pod
metadata:
  name: $HELPER_POD
  namespace: $NAMESPACE
  labels:
    yenhubs.org/recovery-owner: ret-storage-backup
    yenhubs.org/operation-id: "$RECOVERY_OPERATION_ID"
  annotations:
    yenhubs.org/operation-lock-uid: "$RECOVERY_OPERATION_LOCK_UID"
    yenhubs.org/operation-token: "$RECOVERY_OPERATION_TOKEN"
spec:
  automountServiceAccountToken: false
  enableServiceLinks: false
  restartPolicy: Never
  activeDeadlineSeconds: 3600
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 1000
    fsGroupChangePolicy: OnRootMismatch
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: helper
      image: $RET_IMAGE
      command: ["sh", "-c", "sleep 3600"]
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: ["ALL"]
      volumeMounts:
        - name: storage
          mountPath: /storage
          readOnly: true
  volumes:
    - name: storage
      persistentVolumeClaim:
        claimName: ret-pvc
        readOnly: true
EOF
HELPER_POD_CREATED=1
recovery_kubectl wait --for=condition=Ready "pod/$HELPER_POD" \
  -n "$NAMESPACE" --timeout=180s >/dev/null
pod_json="$(recovery_kubectl get pod "$HELPER_POD" -n "$NAMESPACE" -o json)"
HELPER_POD_UID="$(jq -er '.metadata.uid | select(type == "string" and length > 0)' \
  <<<"$pod_json")"
helper_pod_is_exact "$pod_json" || {
  printf 'Admitted backup helper differs from the exact read-only contract.\n' >&2
  exit 1
}
recovery_require_exact_pvc_consumers ret-pvc "$HELPER_POD"

monitor() {
  while [[ ! -e "$MONITOR_STOP" ]]; do
    if ! recovery_require_operation_lock ||
       ! recovery_require_pvc_identity ret-pvc ||
       ! require_helper_policy || ! require_helper_pod ||
       ! recovery_require_exact_pvc_consumers ret-pvc "$HELPER_POD"; then
      printf 'failed\n' >"$MONITOR_FAILURE"
      return 1
    fi
    sleep "${STORAGE_BACKUP_MONITOR_INTERVAL_SECONDS:-1}"
  done
}

recovery_kubectl exec -n "$NAMESPACE" "$HELPER_POD" -- sh -ec \
  'test -d /storage/owned; cd /storage; { find owned -type d -print | sed "s|$|/|"; find owned -type f -print; }' \
  | tr -d '\r' >"$PATHS_BEFORE"
recovery_storage_paths_file_is_exact "$PATHS_BEFORE" || {
  printf 'Source PVC violates the exact two-shard owned-file layout.\n' >&2
  exit 1
}
recovery_extract_storage_uuids "$PATHS_BEFORE" blob | LC_ALL=C sort >"$WORK_DIR/blobs"
recovery_extract_storage_uuids "$PATHS_BEFORE" meta.json | LC_ALL=C sort >"$WORK_DIR/meta"
cmp -s "$WORK_DIR/blobs" "$WORK_DIR/meta" || {
  printf 'Source PVC contains incomplete owned-file pairs.\n' >&2
  exit 1
}
missing_active="$(comm -23 "$DB_ACTIVE_BEFORE" "$WORK_DIR/blobs")"
[[ -z "$missing_active" ]] || {
  printf 'Source PVC is missing at least one active DB-owned file.\n' >&2
  exit 1
}

monitor &
MONITOR_PID=$!
if recovery_kubectl exec -n "$NAMESPACE" "$HELPER_POD" -- \
  tar -C /storage -cf - owned | gzip -c >"$PARTIAL_PATH"; then
  archive_status=0
else
  archive_status=$?
fi
if stop_monitor; then monitor_status=0; else monitor_status=1; fi
[[ "$archive_status" == 0 && "$monitor_status" == 0 ]] || {
  printf 'Read-only archive or its exact identity monitor failed.\n' >&2
  exit 1
}
chmod 600 "$PARTIAL_PATH"
gzip -t "$PARTIAL_PATH"
gzip -cd "$PARTIAL_PATH" | tar -tvf - | awk '
  substr($0,1,1) != "-" && substr($0,1,1) != "d" { failed=1 }
  END { exit failed ? 1 : 0 }
' || {
  printf 'Storage archive contains links or unsupported types.\n' >&2
  exit 1
}
gzip -cd "$PARTIAL_PATH" | tar -tf - >"$ARCHIVE_PATHS"
recovery_storage_paths_file_is_exact "$ARCHIVE_PATHS" || {
  printf 'Storage archive violates the exact two-shard path contract.\n' >&2
  exit 1
}
recovery_extract_storage_uuids "$ARCHIVE_PATHS" blob | LC_ALL=C sort >"$WORK_DIR/archive-blobs"
recovery_extract_storage_uuids "$ARCHIVE_PATHS" meta.json | LC_ALL=C sort >"$WORK_DIR/archive-meta"
if ! cmp -s "$WORK_DIR/blobs" "$WORK_DIR/archive-blobs" ||
   ! cmp -s "$WORK_DIR/meta" "$WORK_DIR/archive-meta"; then
  printf 'Storage archive inventory differs from its quiescent source.\n' >&2
  exit 1
fi

recovery_require_operation_lock
require_pgsql_source
recovery_capture_live_database_contract "$PGSQL_POD" "$CONTRACT_AFTER"
# shellcheck disable=SC2016
recovery_kubectl exec -n "$NAMESPACE" "$PGSQL_POD" -- sh -ec \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d retdb -Atc "select owned_file_uuid from ret0.owned_files where state::text = '\''active'\'' order by owned_file_uuid"' \
  | tr -d '\r' | LC_ALL=C sort >"$DB_ACTIVE_AFTER"
if ! recovery_database_contracts_match "$CONTRACT_BEFORE" "$CONTRACT_AFTER" ||
   ! cmp -s "$DB_ACTIVE_BEFORE" "$DB_ACTIVE_AFTER"; then
  printf 'Database contract changed during the quiescent storage snapshot.\n' >&2
  exit 1
fi

delete_helper_pod
delete_helper_policy
PAIR_COUNT="$(wc -l <"$WORK_DIR/archive-blobs" | tr -d ' ')"
mv "$PARTIAL_PATH" "$OUTPUT_PATH"
chmod 600 "$OUTPUT_PATH"
trap - EXIT INT TERM
rm -rf -- "$WORK_DIR"

printf 'Quiesced Reticulum storage backup completed: path=%s pvc_uid=%s pairs=%s\n' \
  "$OUTPUT_PATH" "$RECOVERY_PVC_UID" "$PAIR_COUNT"

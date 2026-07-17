#!/usr/bin/env bash
# shellcheck disable=SC2016

# Restores the verified Reticulum owned-file half of one complete checkpoint
# into an empty ret-pvc. RESTORE_STORAGE_PREFLIGHT=1 validates the immutable
# pair and target identities without changing Kubernetes state.

set -euo pipefail
umask 077

if [[ $# -ne 1 ]]; then
  printf 'Usage: RESTORE_STORAGE_PREFLIGHT=1 %s /path/to/ret-storage-YYYYMMDD-HHMMSS.tar.gz\n' "$0" >&2
  exit 2
fi

ARCHIVE_PATH="$1"
NAMESPACE="${NAMESPACE:-hcce}"
PREFLIGHT="${RESTORE_STORAGE_PREFLIGHT:-${RESTORE_STORAGE_DRY_RUN:-0}}"
COORDINATED="${RESTORE_COORDINATED:-0}"
CLEAR_STALE_HELPER="${RESTORE_STORAGE_CLEAR_STALE_HELPER:-0}"
RESTORE_POD=""
RESTORE_NETWORK_POLICY=""
DB_CONSUMERS=(reticulum pgbouncer pgbouncer-t bot-orchestrator coturn)
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
if [[ "$COORDINATED" != "0" && "$COORDINATED" != "1" ]]; then
  printf 'RESTORE_COORDINATED must be 0 or 1.\n' >&2
  exit 2
fi
if [[ "$CLEAR_STALE_HELPER" != "0" && "$CLEAR_STALE_HELPER" != "1" ]]; then
  printf 'RESTORE_STORAGE_CLEAR_STALE_HELPER must be 0 or 1.\n' >&2
  exit 2
fi
if [[ "$CLEAR_STALE_HELPER" == "1" && "$COORDINATED" != "1" ]]; then
  printf 'Stale helper clearance requires the coordinated parent lock.\n' >&2
  exit 2
fi
if [[ "$PREFLIGHT" == "0" && "$COORDINATED" != "1" ]]; then
  printf 'Destructive storage restore is only allowed through restore-checkpoint.sh coordination.\n' >&2
  exit 2
fi

VALIDATION_DIR=""
RESTORE_POD_CREATED=0
RESTORE_POD_UID=""
RESTORE_NETWORK_POLICY_CREATED=0
RESTORE_NETWORK_POLICY_UID=""
PVC_MONITOR_PID=""
PVC_MONITOR_STOP=""
PVC_MONITOR_FAILURE=""
RESTORE_PHASE="validating"

stop_pvc_monitor() {
  local monitor_status=0
  if [[ -n "$PVC_MONITOR_PID" ]]; then
    : >"$PVC_MONITOR_STOP"
    if wait "$PVC_MONITOR_PID"; then
      monitor_status=0
    else
      monitor_status=$?
    fi
    PVC_MONITOR_PID=""
  fi
  if [[ -n "$PVC_MONITOR_FAILURE" && -s "$PVC_MONITOR_FAILURE" ]]; then
    printf 'PVC consumer/identity monitoring failed during extraction.\n' >&2
    return 1
  fi
  [[ "$monitor_status" -eq 0 ]]
}

restore_pod_spec_is_exact() {
  local pod_json="$1"
  [[ -n "$RESTORE_POD_UID" ]] || return 1
  recovery_storage_helper_pod_is_exact "$pod_json" "$RESTORE_POD" \
    "$RESTORE_POD_UID" ret-storage-restore "$RET_IMAGE" false
}

restore_network_policy_spec_is_exact() {
  local policy_json="$1"
  [[ -n "$RESTORE_NETWORK_POLICY_UID" ]] || return 1
  recovery_storage_helper_network_policy_is_exact "$policy_json" \
    "$RESTORE_NETWORK_POLICY" "$RESTORE_NETWORK_POLICY_UID" ret-storage-restore
}

capture_restore_pod_identity() {
  local pod_json pod_uid
  pod_json="$(recovery_kubectl get pod "$RESTORE_POD" -n "$NAMESPACE" -o json)" || return 1
  pod_uid="$(jq -er '.metadata.uid | select(type == "string" and length > 0)' <<<"$pod_json")" || return 1
  RESTORE_POD_UID="$pod_uid"
  restore_pod_spec_is_exact "$pod_json"
}

require_owned_restore_pod() {
  local pod_json current_uid
  [[ -n "$RESTORE_POD_UID" ]] || return 1
  pod_json="$(recovery_kubectl get pod "$RESTORE_POD" -n "$NAMESPACE" -o json)" || return 1
  current_uid="$(jq -er '.metadata.uid | select(type == "string" and length > 0)' <<<"$pod_json")" || return 1
  [[ "$current_uid" == "$RESTORE_POD_UID" ]] || return 1
  restore_pod_spec_is_exact "$pod_json"
}

capture_restore_network_policy_identity() {
  local policy_json policy_uid
  policy_json="$(recovery_kubectl get networkpolicy "$RESTORE_NETWORK_POLICY" \
    -n "$NAMESPACE" -o json)" || return 1
  policy_uid="$(jq -er '.metadata.uid | select(type == "string" and length > 0)' \
    <<<"$policy_json")" || return 1
  RESTORE_NETWORK_POLICY_UID="$policy_uid"
  restore_network_policy_spec_is_exact "$policy_json"
}

require_owned_restore_network_policy() {
  local policy_json current_uid
  [[ -n "$RESTORE_NETWORK_POLICY_UID" ]] || return 1
  policy_json="$(recovery_kubectl get networkpolicy "$RESTORE_NETWORK_POLICY" \
    -n "$NAMESPACE" -o json)" || return 1
  current_uid="$(jq -er '.metadata.uid | select(type == "string" and length > 0)' \
    <<<"$policy_json")" || return 1
  [[ "$current_uid" == "$RESTORE_NETWORK_POLICY_UID" ]] || return 1
  restore_network_policy_spec_is_exact "$policy_json"
}

cleanup_restore_pod() {
  if [[ "$RESTORE_POD_CREATED" != "1" ]]; then
    return 0
  fi
  recovery_require_cluster_identity || return 1
  recovery_require_pvc_identity ret-pvc || return 1
  recovery_require_operation_lock || return 1
  recovery_require_exact_pvc_consumers ret-pvc "$RESTORE_POD" || return 1
  require_owned_restore_pod || {
    printf 'Restore pod identity/spec changed; refusing to delete an unowned pod.\n' >&2
    return 1
  }
  if ! recovery_delete_namespaced_with_uid pod "$RESTORE_POD" \
    "$RESTORE_POD_UID" 180; then
    printf 'Could not delete the storage restore pod safely.\n' >&2
    return 1
  fi
  RESTORE_POD_CREATED=0
  recovery_require_exact_pvc_consumers ret-pvc
}

cleanup_restore_network_policy() {
  if [[ "$RESTORE_NETWORK_POLICY_CREATED" != "1" ]]; then
    return 0
  fi
  recovery_require_operation_lock || return 1
  require_owned_restore_network_policy || {
    printf 'Restore NetworkPolicy identity/spec changed; refusing to delete it.\n' >&2
    return 1
  }
  if ! recovery_delete_namespaced_with_uid networkpolicy \
    "$RESTORE_NETWORK_POLICY" "$RESTORE_NETWORK_POLICY_UID" 60; then
    printf 'Could not delete the exact storage-helper NetworkPolicy safely.\n' >&2
    return 1
  fi
  RESTORE_NETWORK_POLICY_CREATED=0
}

clear_stale_helper_resources() {
  local pod_json policy_json policies_json
  recovery_require_operation_lock || return 1
  RET_IMAGE="$(recovery_checkpoint_image_for_pair \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY" reticulum/reticulum \
    ghcr.io/yengalvez/reticulum)" || return 1
  RESTORE_POD="ret-storage-restore-${RECOVERY_OPERATION_ID:0:12}"
  RESTORE_NETWORK_POLICY="ret-storage-restore-deny-${RECOVERY_OPERATION_ID:0:12}"
  if pod_json="$(recovery_kubectl get pod "$RESTORE_POD" -n "$NAMESPACE" -o json 2>/dev/null)"; then
    RESTORE_POD_UID="$(jq -er '.metadata.uid | select(type == "string" and length > 0)' \
      <<<"$pod_json")" || return 1
    RESTORE_POD_CREATED=1
    restore_pod_spec_is_exact "$pod_json" || {
      printf 'Stale helper pod is not bound to the exact retained operation.\n' >&2
      return 1
    }
    recovery_require_exact_pvc_consumers ret-pvc "$RESTORE_POD" || return 1
    cleanup_restore_pod || return 1
  else
    recovery_require_exact_pvc_consumers ret-pvc || return 1
  fi
  if policy_json="$(recovery_kubectl get networkpolicy "$RESTORE_NETWORK_POLICY" \
    -n "$NAMESPACE" -o json 2>/dev/null)"; then
    RESTORE_NETWORK_POLICY_UID="$(jq -er \
      '.metadata.uid | select(type == "string" and length > 0)' <<<"$policy_json")" || return 1
    RESTORE_NETWORK_POLICY_CREATED=1
    restore_network_policy_spec_is_exact "$policy_json" || {
      printf 'Stale helper NetworkPolicy is not bound to the exact retained operation.\n' >&2
      return 1
    }
    cleanup_restore_network_policy || return 1
  else
    policies_json="$(recovery_kubectl get networkpolicy -n "$NAMESPACE" -o json)" || return 1
    jq -e --arg name "$RESTORE_NETWORK_POLICY" \
      '[.items[] | select(.metadata.name == $name)] | length == 0' \
      >/dev/null <<<"$policies_json" || return 1
  fi
  recovery_require_operation_lock
}

cleanup_local() {
  if [[ -n "$VALIDATION_DIR" ]]; then
    rm -rf -- "$VALIDATION_DIR"
  fi
  recovery_cleanup_materialized_checkpoint
}

final_cleanup() {
  local status="$?"
  local cleanup_status=0
  local pod_cleanup_status=0
  trap - EXIT ERR INT TERM
  if ! stop_pvc_monitor; then
    cleanup_status=1
  fi
  if ! cleanup_restore_pod; then
    printf 'The restore pod could not be cleaned up; inspect the pinned target before continuing.\n' >&2
    cleanup_status=1
    pod_cleanup_status=1
  fi
  if [[ "$pod_cleanup_status" == 0 ]] && ! cleanup_restore_network_policy; then
    printf 'The deny-all helper NetworkPolicy remains for fail-closed inspection.\n' >&2
    cleanup_status=1
  fi
  cleanup_local
  if [[ "$status" -eq 0 && "$cleanup_status" -ne 0 ]]; then
    status=1
  fi
  exit "$status"
}

storage_restore_failed() {
  if [[ "$RESTORE_PHASE" == "quiescing" || "$RESTORE_PHASE" == "restoring" ]]; then
    printf 'Storage restore stopped. All DB consumers remain at zero for safety.\n' >&2
  fi
}

storage_restore_interrupted() {
  local status="$1"
  if [[ "$RESTORE_PHASE" == "quiescing" || "$RESTORE_PHASE" == "restoring" ]]; then
    printf 'Storage restore interrupted. All DB consumers remain at zero for safety.\n' >&2
  fi
  exit "$status"
}

trap final_cleanup EXIT
trap storage_restore_failed ERR
trap 'storage_restore_interrupted 130' INT
trap 'storage_restore_interrupted 143' TERM

# Verify the exact allowlisted checkpoint, copy both halves into private files,
# rehash them, and jointly validate the copied pair before contacting Kubernetes.
recovery_materialize_checkpoint "$ARCHIVE_PATH" "$SCRIPT_DIR/validate-checkpoint.sh"

if [[ "$CLEAR_STALE_HELPER" == "1" ]]; then
  recovery_require_cluster_identity
  recovery_require_pvc_identity ret-pvc
  clear_stale_helper_resources
  printf 'Exact stale storage helper resources cleared; workloads remain quiescent.\n'
  exit 0
fi

VALIDATION_DIR="$(mktemp -d "${TMPDIR:-/tmp}/yenhubs-storage-restore.XXXXXX")"
chmod 700 "$VALIDATION_DIR"
ARCHIVE_PATHS="$VALIDATION_DIR/archive-paths"
ARCHIVE_VERBOSE="$VALIDATION_DIR/archive-verbose"
ARCHIVE_BLOB_UUIDS="$VALIDATION_DIR/blob-uuids"
ARCHIVE_META_UUIDS="$VALIDATION_DIR/meta-uuids"
DB_ACTIVE_UUIDS="$VALIDATION_DIR/db-active-uuids"
QUIESCED_DB_ACTIVE_UUIDS="$VALIDATION_DIR/quiesced-db-active-uuids"
QUIESCED_DATABASE_CONTRACT="$VALIDATION_DIR/quiesced-database-contract.json"
RESTORED_BLOB_UUIDS="$VALIDATION_DIR/restored-blob-uuids"
RESTORED_META_UUIDS="$VALIDATION_DIR/restored-meta-uuids"
RESTORED_PATHS="$VALIDATION_DIR/restored-paths"
PVC_MONITOR_STOP="$VALIDATION_DIR/monitor-stop"
PVC_MONITOR_FAILURE="$VALIDATION_DIR/monitor-failure"
: >"$DB_ACTIVE_UUIDS"
: >"$QUIESCED_DB_ACTIVE_UUIDS"
: >"$RESTORED_BLOB_UUIDS"
: >"$RESTORED_META_UUIDS"
chmod 600 "$DB_ACTIVE_UUIDS" "$QUIESCED_DB_ACTIVE_UUIDS" \
  "$RESTORED_BLOB_UUIDS" "$RESTORED_META_UUIDS"

gzip -t "$RECOVERY_STORAGE_COPY"
gzip -cd "$RECOVERY_STORAGE_COPY" | tar -tf - >"$ARCHIVE_PATHS"
gzip -cd "$RECOVERY_STORAGE_COPY" | tar -tvf - >"$ARCHIVE_VERBOSE"

if awk '
  substr($0, 1, 1) != "-" && substr($0, 1, 1) != "d" { unsafe=1 }
  END { exit unsafe ? 0 : 1 }
' "$ARCHIVE_VERBOSE"; then
  printf 'Archive contains links or unsupported entry types.\n' >&2
  exit 1
fi
if ! recovery_storage_paths_file_is_exact "$ARCHIVE_PATHS"; then
  printf 'Archive contains unsafe paths or files outside the owned-file contract.\n' >&2
  exit 1
fi
recovery_extract_storage_uuids "$ARCHIVE_PATHS" blob | LC_ALL=C sort >"$ARCHIVE_BLOB_UUIDS"
recovery_extract_storage_uuids "$ARCHIVE_PATHS" meta.json | LC_ALL=C sort >"$ARCHIVE_META_UUIDS"
ARCHIVE_BLOB_COUNT="$(wc -l <"$ARCHIVE_BLOB_UUIDS" | tr -d ' ')"
ARCHIVE_META_COUNT="$(wc -l <"$ARCHIVE_META_UUIDS" | tr -d ' ')"
ARCHIVE_UNIQUE_BLOB_COUNT="$(LC_ALL=C sort -u "$ARCHIVE_BLOB_UUIDS" | wc -l | tr -d ' ')"
ARCHIVE_UNIQUE_META_COUNT="$(LC_ALL=C sort -u "$ARCHIVE_META_UUIDS" | wc -l | tr -d ' ')"
if [[ "$ARCHIVE_BLOB_COUNT" -eq 0 || "$ARCHIVE_BLOB_COUNT" != "$ARCHIVE_META_COUNT" ||
      "$ARCHIVE_BLOB_COUNT" != "$ARCHIVE_UNIQUE_BLOB_COUNT" ||
      "$ARCHIVE_META_COUNT" != "$ARCHIVE_UNIQUE_META_COUNT" ]] ||
   ! cmp -s "$ARCHIVE_BLOB_UUIDS" "$ARCHIVE_META_UUIDS"; then
  printf 'Invalid storage archive: blobs=%s metadata=%s.\n' \
    "$ARCHIVE_BLOB_COUNT" "$ARCHIVE_META_COUNT" >&2
  exit 1
fi
if awk '
  $0 !~ /^[A-Za-z0-9._-]+$/ { unsafe=1 }
  END { exit unsafe ? 0 : 1 }
' "$ARCHIVE_BLOB_UUIDS"; then
  printf 'Archive contains an unsafe owned-file UUID.\n' >&2
  exit 1
fi

recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
recovery_kubectl rollout status deployment/pgsql -n "$NAMESPACE" --timeout=5m >/dev/null
PGSQL_PODS_JSON="$(recovery_kubectl get pod -n "$NAMESPACE" -l app=pgsql -o json)"
if ! PGSQL_POD_INFO="$(recovery_exact_ready_deployment_pod_info \
  "$PGSQL_PODS_JSON" pgsql pgsql)"; then
  printf 'Exactly one owned Ready PostgreSQL pod is required in namespace %s.\n' \
    "$NAMESPACE" >&2
  exit 1
fi
IFS=$'\t' read -r PGSQL_POD PGSQL_POD_UID PGSQL_DEPLOYMENT_UID <<<"$PGSQL_POD_INFO"
PGSQL_POD_JSON="$(jq -cer '.items[0]' <<<"$PGSQL_PODS_JSON")"
require_pgsql_source() {
  recovery_require_pod_identity "$PGSQL_POD" "$PGSQL_POD_UID" &&
    recovery_require_pod_deployment_ownership \
      "$PGSQL_POD_JSON" pgsql "$PGSQL_DEPLOYMENT_UID"
}
# Expansion is intentionally deferred to the PostgreSQL container.
# shellcheck disable=SC2016
require_pgsql_source
if ! recovery_kubectl exec -n "$NAMESPACE" "$PGSQL_POD" -- sh -ec \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d retdb -Atc "select owned_file_uuid from ret0.owned_files where state = '\''active'\'' order by owned_file_uuid"' \
  | tr -d '\r' | LC_ALL=C sort >"$DB_ACTIVE_UUIDS"; then
  printf 'Could not query exact active owned-file UUIDs.\n' >&2
  exit 1
fi
DB_ACTIVE_COUNT="$(wc -l <"$DB_ACTIVE_UUIDS" | tr -d ' ')"
DB_ACTIVE_UNIQUE_COUNT="$(LC_ALL=C sort -u "$DB_ACTIVE_UUIDS" | wc -l | tr -d ' ')"
if [[ "$DB_ACTIVE_COUNT" -eq 0 || "$DB_ACTIVE_COUNT" != "$DB_ACTIVE_UNIQUE_COUNT" ]]; then
  printf 'Database active owned-file baseline is empty or contains duplicate UUIDs.\n' >&2
  exit 1
fi
if awk '
  $0 !~ /^[A-Za-z0-9._-]+$/ { unsafe=1 }
  END { exit unsafe ? 0 : 1 }
' "$DB_ACTIVE_UUIDS"; then
  printf 'Database returned an unsafe active owned-file UUID.\n' >&2
  exit 1
fi
if ! MISSING_ACTIVE_STORAGE="$(comm -23 "$DB_ACTIVE_UUIDS" "$ARCHIVE_BLOB_UUIDS")"; then
  printf 'Could not compare database and archive UUIDs.\n' >&2
  exit 1
fi
if [[ -n "$MISSING_ACTIVE_STORAGE" ]]; then
  printf 'Archive/database mismatch: at least one active DB file is absent from storage.\n' >&2
  exit 1
fi

if [[ "$PREFLIGHT" == "1" ]]; then
  printf 'Storage restore preflight passed (no restore performed): source=%s checkpoint=%s dump_sha256=%s storage_sha256=%s active_files=%s complete_pairs=%s deferred_pairs=%s context=%s namespace=%s namespace_uid=%s pvc=ret-pvc pvc_uid=%s\n' \
    "$ARCHIVE_PATH" "$RECOVERY_CHECKPOINT_STAMP" "$RECOVERY_DUMP_SHA256" \
    "$RECOVERY_STORAGE_SHA256" "$DB_ACTIVE_COUNT" "$ARCHIVE_BLOB_COUNT" \
    "$((ARCHIVE_BLOB_COUNT - DB_ACTIVE_COUNT))" "$EXPECTED_KUBE_CONTEXT" \
    "$NAMESPACE" "$RECOVERY_NAMESPACE_UID" "$RECOVERY_PVC_UID"
  exit 0
fi

recovery_require_confirmation CONFIRM_RESTORE_STORAGE ret-pvc "$RECOVERY_PVC_UID"
if [[ -z "${RECOVERY_CONSUMER_CONTRACT_JSON:-}" ]] ||
   ! recovery_consumer_contract_is_acceptable "$RECOVERY_CONSUMER_CONTRACT_JSON" ||
   [[ "$(jq -r '.operation_id' <<<"$RECOVERY_CONSUMER_CONTRACT_JSON")" != \
      "${RECOVERY_OPERATION_ID:-}" ]] ||
   ! recovery_require_operation_lock; then
  printf 'Destructive storage restore lacks the exact parent lock/consumer contract.\n' >&2
  exit 1
fi
RESTORE_POD="ret-storage-restore-${RECOVERY_OPERATION_ID:0:12}"
RESTORE_NETWORK_POLICY="ret-storage-restore-deny-${RECOVERY_OPERATION_ID:0:12}"

RESTORE_DEPLOYMENTS=()
DEPLOYMENT_SELECTORS=()
DEPLOYMENT_UIDS=()
DEPLOYMENT_FINGERPRINTS=()
RET_IMAGE="$(recovery_checkpoint_image_for_pair \
  "$RECOVERY_DEPLOYMENT_INVENTORY_COPY" reticulum/reticulum \
  ghcr.io/yengalvez/reticulum)" || {
  printf 'The checksummed inventory does not bind the trusted Reticulum helper image.\n' >&2
  exit 1
}
for deployment in "${DB_CONSUMERS[@]}"; do
  expected_entry="$(jq -cer --arg name "$deployment" \
    '[.consumers[] | select(.name == $name)] | select(length == 1) | .[0]' \
    <<<"$RECOVERY_CONSUMER_CONTRACT_JSON")" || exit 1
  deployment_uid="$(jq -r '.uid' <<<"$expected_entry")"
  initial_resource_version="$(jq -r '.initial_resource_version' <<<"$expected_entry")"
  original_replicas="$(jq -r '.original_replicas' <<<"$expected_entry")"
  deployment_selector="$(jq -r '.selector' <<<"$expected_entry")"
  deployment_fingerprint="$(jq -r '.fingerprint' <<<"$expected_entry")"
  deployment_contract="$(recovery_capture_deployment_contract "$deployment")" || exit 1
  IFS=$'\t' read -r current_uid current_resource_version replica_count \
    current_selector current_fingerprint <<<"$deployment_contract"
  [[ "$current_uid" == "$deployment_uid" &&
     "$current_selector" == "$deployment_selector" &&
     "$current_fingerprint" == "$deployment_fingerprint" ]] || {
    printf 'Post-lock consumer contract changed before storage quiescence: %s.\n' \
      "$deployment" >&2
    exit 1
  }
  if [[ "$replica_count" == "$original_replicas" ]]; then
    [[ "$current_resource_version" == "$initial_resource_version" ]] || {
      printf 'Consumer resourceVersion changed before storage quiescence: %s.\n' \
        "$deployment" >&2
      exit 1
    }
    recovery_scale_deployment_exact "$deployment" "$deployment_uid" \
      "$current_resource_version" "$replica_count" 0 "$deployment_selector" \
      "$deployment_fingerprint" >/dev/null
  elif [[ "$replica_count" != 0 ]]; then
    printf 'Consumer has neither its post-lock replica count nor zero: %s.\n' \
      "$deployment" >&2
    exit 1
  fi
  if [[ "$deployment" == "reticulum" ]]; then
    live_ret_image="$(recovery_kubectl get deployment reticulum -n "$NAMESPACE" -o json | jq -r '
      [.spec.template.spec.containers[] | select(.name == "reticulum") | .image] |
      if length == 1 then .[0] else empty end
    ')"
    [[ "$live_ret_image" == "$RET_IMAGE" ]] || {
      printf 'Live Reticulum image differs from the checksummed checkpoint inventory.\n' >&2
      exit 1
    }
  fi
  RESTORE_DEPLOYMENTS+=("$deployment")
  DEPLOYMENT_SELECTORS+=("$deployment_selector")
  DEPLOYMENT_UIDS+=("$deployment_uid")
  DEPLOYMENT_FINGERPRINTS+=("$deployment_fingerprint")
done

RESTORE_PHASE="quiescing"
# Revalidate both identities immediately before the first mutation.
recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
recovery_require_operation_lock
for index in "${!RESTORE_DEPLOYMENTS[@]}"; do
  recovery_require_operation_lock
  recovery_wait_for_no_pods "app=${DEPLOYMENT_SELECTORS[$index]}" \
    "deployment/${RESTORE_DEPLOYMENTS[$index]}" 180s
  recovery_require_operation_lock
  recovery_require_consumer_contract_entry "$RECOVERY_CONSUMER_CONTRACT_JSON" \
    "${RESTORE_DEPLOYMENTS[$index]}" 0
done
recovery_require_exact_pvc_consumers ret-pvc

# The driver already restored this exact DB contract. Recheck it and the full
# active UUID set only after every consumer is stopped, immediately before any
# PVC write. This closes the window between the read-only preflight query and
# storage extraction even if the child is invoked incorrectly outside the
# driver.
recovery_require_operation_lock
require_pgsql_source
if ! recovery_capture_live_database_contract "$PGSQL_POD" "$QUIESCED_DATABASE_CONTRACT" ||
   ! recovery_database_contracts_match \
     "$RECOVERY_DATABASE_CONTRACT_COPY" "$QUIESCED_DATABASE_CONTRACT"; then
  printf 'Quiesced database does not match the checksummed checkpoint contract.\n' >&2
  exit 1
fi
# Expansion is intentionally deferred to the PostgreSQL container.
# shellcheck disable=SC2016
recovery_require_operation_lock
require_pgsql_source
if ! recovery_kubectl exec -n "$NAMESPACE" "$PGSQL_POD" -- sh -ec \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d retdb -Atc "select owned_file_uuid from ret0.owned_files where state = '\''active'\'' order by owned_file_uuid"' \
  | tr -d '\r' | LC_ALL=C sort >"$QUIESCED_DB_ACTIVE_UUIDS"; then
  printf 'Could not recheck active owned-file UUIDs after quiescing.\n' >&2
  exit 1
fi
if ! cmp -s "$DB_ACTIVE_UUIDS" "$QUIESCED_DB_ACTIVE_UUIDS"; then
  printf 'Active owned-file UUIDs changed before storage extraction.\n' >&2
  exit 1
fi

# Revalidate again immediately before creating the only pod allowed to mount
# ret-pvc during the restore.
recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
recovery_require_operation_lock
recovery_require_exact_pvc_consumers ret-pvc
# The deny-all policy is create-only and must be admitted exactly before the
# PVC helper pod exists. Its selector is unique to this operation_id.
cat <<EOF | recovery_kubectl create -f - >/dev/null
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: $RESTORE_NETWORK_POLICY
  namespace: $NAMESPACE
  labels:
    yenhubs.org/recovery-owner: ret-storage-restore
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
RESTORE_NETWORK_POLICY_CREATED=1
if ! capture_restore_network_policy_identity; then
  printf 'Deny-all helper NetworkPolicy does not match the exact admitted contract.\n' >&2
  exit 1
fi
recovery_require_operation_lock
require_owned_restore_network_policy

# Create-only is intentional. A unique operation name plus the exact admitted
# UID/spec prevents adoption of a concurrent or stale helper.
cat <<EOF | recovery_kubectl create -f - >/dev/null
apiVersion: v1
kind: Pod
metadata:
  name: $RESTORE_POD
  namespace: $NAMESPACE
  labels:
    yenhubs.org/recovery-owner: ret-storage-restore
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
          readOnly: false
  volumes:
    - name: storage
      persistentVolumeClaim:
        claimName: ret-pvc
        readOnly: false
EOF
RESTORE_POD_CREATED=1
recovery_kubectl wait --for=condition=Ready "pod/$RESTORE_POD" -n "$NAMESPACE" --timeout=180s >/dev/null
recovery_require_operation_lock
require_owned_restore_network_policy
recovery_require_exact_pvc_consumers ret-pvc "$RESTORE_POD"
if ! capture_restore_pod_identity; then
  printf 'Restore pod identity or admitted spec does not match the exact safe contract.\n' >&2
  exit 1
fi

EXISTING_ENTRY="$(
  recovery_kubectl exec -n "$NAMESPACE" "$RESTORE_POD" -- sh -ec \
    'if [ -L /storage/owned ] || { [ -e /storage/owned ] && [ ! -d /storage/owned ]; }; then
       printf "unsafe-owned-root\n"
     elif [ -d /storage/owned ]; then
       find /storage/owned -mindepth 1 -print -quit 2>/dev/null
     fi'
)"
if [[ -n "$EXISTING_ENTRY" ]]; then
  printf 'Refusing to merge into non-empty or unsafe ret-pvc owned root.\n' >&2
  printf 'All DB consumers remain at zero for inspection.\n' >&2
  exit 1
fi

monitor_pvc_during_extraction() {
  while [[ ! -e "$PVC_MONITOR_STOP" ]]; do
    if ! recovery_require_cluster_identity ||
       ! recovery_require_pvc_identity ret-pvc ||
       ! recovery_require_operation_lock ||
       ! require_owned_restore_network_policy ||
       ! recovery_require_exact_pvc_consumers ret-pvc "$RESTORE_POD" ||
       ! require_owned_restore_pod; then
      printf 'failed\n' >"$PVC_MONITOR_FAILURE"
      return 1
    fi
    sleep "${PVC_MONITOR_INTERVAL_SECONDS:-1}"
  done
}

RESTORE_PHASE="restoring"
# These checks are adjacent to the write, and the background guard repeats all
# three throughout extraction. Any extra PVC consumer makes the restore fail.
recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
recovery_require_operation_lock
require_owned_restore_network_policy
recovery_require_exact_pvc_consumers ret-pvc "$RESTORE_POD"
require_owned_restore_pod
monitor_pvc_during_extraction &
PVC_MONITOR_PID=$!
if gzip -cd "$RECOVERY_STORAGE_COPY" |
  recovery_kubectl exec -i -n "$NAMESPACE" "$RESTORE_POD" -- tar -C /storage -xf -; then
  extraction_status=0
else
  extraction_status=$?
fi
if ! stop_pvc_monitor; then
  monitor_status=1
else
  monitor_status=0
fi
if [[ "$extraction_status" -ne 0 || "$monitor_status" -ne 0 ]]; then
  printf 'Storage extraction or its PVC exclusivity monitor failed.\n' >&2
  exit 1
fi
recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
recovery_require_operation_lock
require_owned_restore_network_policy
recovery_require_exact_pvc_consumers ret-pvc "$RESTORE_POD"
require_owned_restore_pod

if ! recovery_kubectl exec -n "$NAMESPACE" "$RESTORE_POD" -- sh -ec \
  'test -d /storage/owned; cd /storage; { find owned -type d -print | sed "s|$|/|"; find owned -type f -print; }' \
  | tr -d '\r' >"$RESTORED_PATHS"; then
  printf 'Could not enumerate restored owned-file paths.\n' >&2
  exit 1
fi
if ! recovery_storage_paths_file_is_exact "$RESTORED_PATHS"; then
  printf 'Restored storage paths do not match the exact two-shard contract.\n' >&2
  exit 1
fi
recovery_extract_storage_uuids "$RESTORED_PATHS" blob | LC_ALL=C sort >"$RESTORED_BLOB_UUIDS"
recovery_extract_storage_uuids "$RESTORED_PATHS" meta.json | LC_ALL=C sort >"$RESTORED_META_UUIDS"
RESTORED_BLOBS="$(sed '/^$/d' "$RESTORED_BLOB_UUIDS" | wc -l | tr -d ' ')"
RESTORED_META="$(sed '/^$/d' "$RESTORED_META_UUIDS" | wc -l | tr -d ' ')"
if [[ "$RESTORED_BLOBS" != "$ARCHIVE_BLOB_COUNT" ||
      "$RESTORED_META" != "$ARCHIVE_META_COUNT" ]] ||
   ! cmp -s "$ARCHIVE_BLOB_UUIDS" "$RESTORED_BLOB_UUIDS" ||
   ! cmp -s "$ARCHIVE_META_UUIDS" "$RESTORED_META_UUIDS"; then
  printf 'Storage restore verification failed: DB=%s blobs=%s metadata=%s.\n' \
    "$DB_ACTIVE_COUNT" "$RESTORED_BLOBS" "$RESTORED_META" >&2
  printf 'All DB consumers remain at zero for inspection.\n' >&2
  exit 1
fi

cleanup_restore_pod
cleanup_restore_network_policy
RESTORE_PHASE="coordinated_hold"
trap - ERR
printf 'Storage restore validated and held quiescent for coordinated resume: checkpoint=%s pvc_uid=%s\n' \
  "$RECOVERY_CHECKPOINT_STAMP" "$RECOVERY_PVC_UID"

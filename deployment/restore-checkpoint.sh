#!/usr/bin/env bash

# Coordinates the database and ret-pvc halves of one checkpoint. Every DB
# consumer remains at zero from before the drop until both halves and the live
# database contract have been validated.

set -Eeuo pipefail
umask 077

if [[ $# -ne 1 ]]; then
  printf 'Usage: RESTORE_CHECKPOINT_PREFLIGHT=1 %s /path/to/checkpoint-directory\n' "$0" >&2
  exit 2
fi

CHECKPOINT_DIR="$1"
PREFLIGHT="${RESTORE_CHECKPOINT_PREFLIGHT:-0}"
CLEAR_STALE_LOCK="${RESTORE_CHECKPOINT_CLEAR_STALE_LOCK:-0}"
NAMESPACE="${NAMESPACE:-hcce}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deployment/lib/recovery-safety.sh
source "$SCRIPT_DIR/lib/recovery-safety.sh"

if [[ "$PREFLIGHT" != "0" && "$PREFLIGHT" != "1" ]]; then
  printf 'RESTORE_CHECKPOINT_PREFLIGHT must be 0 or 1.\n' >&2
  exit 2
fi
if [[ "$CLEAR_STALE_LOCK" != "0" && "$CLEAR_STALE_LOCK" != "1" ]]; then
  printf 'RESTORE_CHECKPOINT_CLEAR_STALE_LOCK must be 0 or 1.\n' >&2
  exit 2
fi
if [[ "$PREFLIGHT" == "1" && "$CLEAR_STALE_LOCK" == "1" ]]; then
  printf 'Preflight and stale-lock clearance are separate operations.\n' >&2
  exit 2
fi
if [[ ! -d "$CHECKPOINT_DIR" || -L "$CHECKPOINT_DIR" ]] ||
   recovery_path_has_symlink_component "$CHECKPOINT_DIR"; then
  printf 'Checkpoint directory must be direct and contain no symlink component.\n' >&2
  exit 1
fi
CHECKPOINT_DIR="$(cd "$CHECKPOINT_DIR" && pwd -P)"
metadata_path="$CHECKPOINT_DIR/checkpoint-metadata.json"
if ! recovery_require_regular_direct_file "$metadata_path"; then
  printf 'Checkpoint metadata must be a direct regular file with no symlink component.\n' >&2
  exit 1
fi
if ! stamp="$(jq -er '.stamp | select(type == "string" and test("^[0-9]{8}-[0-9]{6}$"))' "$metadata_path")"; then
  printf 'Checkpoint metadata does not contain one valid stamp.\n' >&2
  exit 1
fi
DUMP_PATH="$CHECKPOINT_DIR/retdb-$stamp.sql.gz"
STORAGE_PATH="$CHECKPOINT_DIR/ret-storage-$stamp.tar.gz"

RESTORE_PHASE="validating"
LIVE_CONTRACT=""
CONSUMERS=(reticulum pgbouncer pgbouncer-t bot-orchestrator coturn)
ORIGINAL_REPLICAS=()
DEPLOYMENT_UIDS=()
DEPLOYMENT_RESOURCE_VERSIONS=()
DEPLOYMENT_SELECTORS=()
DEPLOYMENT_FINGERPRINTS=()
RECOVERY_CONSUMER_CONTRACT_JSON=""
RESTORE_LOCK_NAME="yenhubs-recovery-operation-lock"
RESTORE_LOCK_CREATED=0
RESTORE_LOCK_UID=""
RESTORE_LOCK_RESOURCE_VERSION=""
RESTORE_LOCK_TOKEN=""
RESTORE_OPERATION_ID=""

restore_lock_json_is_exact() {
  local lock_json="$1"
  RECOVERY_OPERATION_OWNER="checkpoint-restore"
  RECOVERY_OPERATION_LOCK_NAME="$RESTORE_LOCK_NAME"
  RECOVERY_OPERATION_LOCK_UID="$RESTORE_LOCK_UID"
  RECOVERY_OPERATION_LOCK_RESOURCE_VERSION="$RESTORE_LOCK_RESOURCE_VERSION"
  RECOVERY_OPERATION_TOKEN="$RESTORE_LOCK_TOKEN"
  RECOVERY_OPERATION_ID="$RESTORE_OPERATION_ID"
  recovery_operation_lock_json_is_exact "$lock_json"
}

require_owned_restore_lock() {
  local lock_json current_uid
  [[ "$RESTORE_LOCK_CREATED" == "1" ]] || return 1
  lock_json="$(recovery_kubectl get configmap "$RESTORE_LOCK_NAME" -n "$NAMESPACE" -o json)" || return 1
  current_uid="$(jq -er '.metadata.uid | select(type == "string" and length > 0)' <<<"$lock_json")" || return 1
  [[ "$current_uid" == "$RESTORE_LOCK_UID" ]] || return 1
  restore_lock_json_is_exact "$lock_json"
}

acquire_restore_lock() {
  recovery_acquire_operation_lock checkpoint-restore "$RESTORE_LOCK_NAME" || return 1
  RESTORE_LOCK_UID="$RECOVERY_OPERATION_LOCK_UID"
  RESTORE_LOCK_RESOURCE_VERSION="$RECOVERY_OPERATION_LOCK_RESOURCE_VERSION"
  RESTORE_LOCK_TOKEN="$RECOVERY_OPERATION_TOKEN"
  RESTORE_OPERATION_ID="$RECOVERY_OPERATION_ID"
  RESTORE_LOCK_CREATED=1
}

release_restore_lock() {
  require_owned_restore_lock || {
    printf 'Restore lock identity changed; refusing to delete an unowned lock.\n' >&2
    return 1
  }
  recovery_delete_namespaced_with_uid configmap "$RESTORE_LOCK_NAME" \
    "$RESTORE_LOCK_UID" 60 || return 1
  RESTORE_LOCK_CREATED=0
  RESTORE_LOCK_UID=""
  RESTORE_LOCK_RESOURCE_VERSION=""
  RESTORE_LOCK_TOKEN=""
  RESTORE_OPERATION_ID=""
}

clear_stale_restore_lock() {
  local lock_json deployment deployment_json replicas selector current_lock_json
  lock_json="$(recovery_kubectl get configmap "$RESTORE_LOCK_NAME" -n "$NAMESPACE" -o json)" || {
    printf 'No readable stale restore lock exists in the pinned target.\n' >&2
    return 1
  }
  RESTORE_LOCK_UID="$(jq -er '.metadata.uid | select(type == "string" and length > 0)' <<<"$lock_json")" || return 1
  RESTORE_LOCK_RESOURCE_VERSION="$(jq -er '.metadata.resourceVersion | select(type == "string" and length > 0)' <<<"$lock_json")" || return 1
  RESTORE_LOCK_TOKEN="$(jq -er '.metadata.annotations["yenhubs.org/recovery-token"] | select(type == "string" and test("^[a-f0-9]{32}$"))' <<<"$lock_json")" || return 1
  RESTORE_OPERATION_ID="$(jq -er '.metadata.annotations["yenhubs.org/operation-id"] | select(type == "string" and test("^[a-f0-9]{32}$"))' <<<"$lock_json")" || return 1
  RESTORE_LOCK_CREATED=1
  restore_lock_json_is_exact "$lock_json" || {
    printf 'Stale restore lock is not bound to this exact checkpoint.\n' >&2
    return 1
  }
  recovery_require_confirmation CONFIRM_CLEAR_RESTORE_LOCK restore-lock \
    "$RESTORE_LOCK_UID:$RECOVERY_PVC_UID"
  export RECOVERY_OPERATION_OWNER RECOVERY_OPERATION_LOCK_NAME \
    RECOVERY_OPERATION_LOCK_UID RECOVERY_OPERATION_LOCK_RESOURCE_VERSION \
    RECOVERY_OPERATION_TOKEN RECOVERY_OPERATION_ID
  RESTORE_COORDINATED=1 RESTORE_STORAGE_CLEAR_STALE_HELPER=1 \
    "$SCRIPT_DIR/restore-ret-storage.sh" "$STORAGE_PATH"
  recovery_require_exact_pvc_consumers ret-pvc
  for deployment in "${CONSUMERS[@]}"; do
    deployment_json="$(recovery_kubectl get deployment "$deployment" -n "$NAMESPACE" -o json)" || return 1
    replicas="$(jq -er '.spec.replicas | select(type == "number" and floor == .)' <<<"$deployment_json")" || return 1
    selector="$(jq -er '.spec.selector.matchLabels.app | select(type == "string" and length > 0)' <<<"$deployment_json")" || return 1
    [[ "$replicas" == "0" ]] || {
      printf 'Every DB consumer must remain at zero before clearing a restore lock.\n' >&2
      return 1
    }
    recovery_wait_for_no_pods "app=$selector" "deployment/$deployment" 30s
  done
  recovery_require_cluster_identity
  recovery_require_pvc_identity ret-pvc
  current_lock_json="$(recovery_kubectl get configmap "$RESTORE_LOCK_NAME" -n "$NAMESPACE" -o json)" || return 1
  restore_lock_json_is_exact "$current_lock_json" || {
    printf 'Restore lock changed before stale-lock deletion.\n' >&2
    return 1
  }
  recovery_delete_namespaced_with_uid configmap "$RESTORE_LOCK_NAME" \
    "$RESTORE_LOCK_UID" 60
  RESTORE_LOCK_CREATED=0
  printf 'Stale checkpoint-restore lock cleared after exact confirmation; no workload was resumed.\n'
}

cleanup_driver() {
  [[ -z "$LIVE_CONTRACT" ]] || rm -f -- "$LIVE_CONTRACT"
  recovery_cleanup_materialized_checkpoint
}

quiesce_after_failure() {
  local deployment quiesce_status=0 index contract uid resource_version replicas selector fingerprint
  [[ "$RESTORE_PHASE" == "db" || "$RESTORE_PHASE" == "storage" ||
     "$RESTORE_PHASE" == "validating-live" || "$RESTORE_PHASE" == "resuming" ]] || return 0
  if ! require_owned_restore_lock; then
    printf 'Could not revalidate the exact operation lock; consumers require manual inspection.\n' >&2
    return 1
  fi
  for index in "${!CONSUMERS[@]}"; do
    deployment="${CONSUMERS[$index]}"
    if [[ -z "${DEPLOYMENT_UIDS[$index]:-}" ]]; then
      quiesce_status=1
      continue
    fi
    if ! contract="$(recovery_capture_deployment_contract "$deployment")"; then
      quiesce_status=1
      continue
    fi
    IFS=$'\t' read -r uid resource_version replicas selector fingerprint <<<"$contract"
    if [[ "$uid" != "${DEPLOYMENT_UIDS[$index]}" ||
          "$selector" != "${DEPLOYMENT_SELECTORS[$index]}" ||
          "$fingerprint" != "${DEPLOYMENT_FINGERPRINTS[$index]}" ]]; then
      quiesce_status=1
      continue
    fi
    if [[ "$replicas" != 0 ]] && ! recovery_scale_deployment_exact \
      "$deployment" "$uid" "$resource_version" "$replicas" 0 \
      "$selector" "$fingerprint" >/dev/null; then
      quiesce_status=1
    fi
  done
  [[ "$quiesce_status" == "0" ]] || return 1
  printf 'Coordinated restore failed; all DB consumers were forced back to zero.\n' >&2
}

driver_failed() {
  local status=$?
  local quiesced=1
  trap - ERR
  if ! quiesce_after_failure; then
    quiesced=0
    printf 'Automatic fail-closed quiesce could not be completed.\n' >&2
  fi
  if [[ "$RESTORE_LOCK_CREATED" == "1" ]]; then
    if [[ "$RESTORE_PHASE" == "db" || "$RESTORE_PHASE" == "storage" ||
          "$RESTORE_PHASE" == "validating-live" || "$RESTORE_PHASE" == "resuming" ]]; then
      if [[ "$quiesced" == "1" ]]; then
        printf 'The owned restore lock is retained for inspection; consumers remain at zero.\n' >&2
      else
        printf 'The owned restore lock is retained; consumer state requires manual inspection.\n' >&2
      fi
    else
      printf 'The owned restore lock is retained for inspection; no restore mutation began.\n' >&2
    fi
  fi
  return "$status"
}

driver_interrupted() {
  local status="$1"
  trap - EXIT ERR INT TERM
  if ! quiesce_after_failure; then
    printf 'Automatic fail-closed quiesce could not be completed.\n' >&2
  fi
  cleanup_driver
  exit "$status"
}

trap cleanup_driver EXIT
trap driver_failed ERR
trap 'driver_interrupted 130' INT
trap 'driver_interrupted 143' TERM

# This validation and private materialization happens before any Kubernetes
# read, and is repeated by each child immediately before its own operation.
recovery_materialize_checkpoint "$DUMP_PATH" "$SCRIPT_DIR/validate-checkpoint.sh"
recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc

if [[ "$CLEAR_STALE_LOCK" == "1" ]]; then
  clear_stale_restore_lock
  exit 0
fi

if [[ "$PREFLIGHT" == "1" ]]; then
  RESTORE_PREFLIGHT=1 "$SCRIPT_DIR/restore-retdb.sh" "$DUMP_PATH"
  RESTORE_STORAGE_PREFLIGHT=1 "$SCRIPT_DIR/restore-ret-storage.sh" "$STORAGE_PATH"
  printf 'Coordinated checkpoint preflight passed without mutation: checkpoint=%s\n' "$stamp"
  exit 0
fi

recovery_require_confirmation CONFIRM_RESTORE_CHECKPOINT checkpoint "$RECOVERY_PVC_UID"
RESTORE_PHASE="locking"
recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
acquire_restore_lock
consumer_contracts='[]'
for deployment in "${CONSUMERS[@]}"; do
  deployment_contract="$(recovery_capture_deployment_contract "$deployment")" || {
    printf 'Could not capture the post-lock Deployment contract for %s.\n' "$deployment" >&2
    exit 1
  }
  IFS=$'\t' read -r deployment_uid deployment_resource_version replicas \
    deployment_selector deployment_fingerprint <<<"$deployment_contract"
  [[ "$replicas" =~ ^[0-9]+$ && "$replicas" -gt 0 ]] || {
    printf 'Every DB consumer must be running before a new coordinated restore: %s.\n' \
      "$deployment" >&2
    exit 1
  }
  DEPLOYMENT_UIDS+=("$deployment_uid")
  DEPLOYMENT_RESOURCE_VERSIONS+=("$deployment_resource_version")
  ORIGINAL_REPLICAS+=("$replicas")
  DEPLOYMENT_SELECTORS+=("$deployment_selector")
  DEPLOYMENT_FINGERPRINTS+=("$deployment_fingerprint")
  consumer_contracts="$(jq -cn \
    --argjson current "$consumer_contracts" \
    --arg name "$deployment" \
    --arg uid "$deployment_uid" \
    --arg resource_version "$deployment_resource_version" \
    --argjson original_replicas "$replicas" \
    --arg selector "$deployment_selector" \
    --arg fingerprint "$deployment_fingerprint" \
    '$current + [{name:$name,uid:$uid,initial_resource_version:$resource_version,
      original_replicas:$original_replicas,selector:$selector,fingerprint:$fingerprint}]'
  )"
done
RECOVERY_CONSUMER_CONTRACT_JSON="$(jq -cn \
  --arg operation_id "$RESTORE_OPERATION_ID" \
  --argjson consumers "$consumer_contracts" \
  '{schema_version:1,operation_id:$operation_id,consumers:$consumers}')"
recovery_consumer_contract_is_acceptable "$RECOVERY_CONSUMER_CONTRACT_JSON" || {
  printf 'The post-lock DB consumer contract is malformed.\n' >&2
  exit 1
}
export RECOVERY_CONSUMER_CONTRACT_JSON
DB_CONFIRMATION="$(recovery_confirmation_value retdb)"
STORAGE_CONFIRMATION="$(recovery_confirmation_value ret-pvc "$RECOVERY_PVC_UID")"

RESTORE_PHASE="db"
recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
require_owned_restore_lock
RESTORE_COORDINATED=1 CONFIRM_RESTORE="$DB_CONFIRMATION" \
  "$SCRIPT_DIR/restore-retdb.sh" "$DUMP_PATH"

RESTORE_PHASE="storage"
recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
require_owned_restore_lock
RESTORE_COORDINATED=1 CONFIRM_RESTORE_STORAGE="$STORAGE_CONFIRMATION" \
  "$SCRIPT_DIR/restore-ret-storage.sh" "$STORAGE_PATH"

RESTORE_PHASE="validating-live"
recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
recovery_require_exact_pvc_consumers ret-pvc
require_owned_restore_lock
for index in "${!CONSUMERS[@]}"; do
  deployment="${CONSUMERS[$index]}"
  if ! recovery_require_consumer_contract_entry \
    "$RECOVERY_CONSUMER_CONTRACT_JSON" "$deployment" 0 "$RESTORE_OPERATION_ID"; then
    printf 'A DB consumer resumed before joint validation: %s.\n' "$deployment" >&2
    exit 1
  fi
done
PGSQL_PODS_JSON="$(recovery_kubectl get pod -n "$NAMESPACE" -l app=pgsql -o json)"
if ! PGSQL_POD_INFO="$(recovery_exact_ready_deployment_pod_info \
  "$PGSQL_PODS_JSON" pgsql pgsql)"; then
  printf 'Exactly one owned Ready PostgreSQL pod is required during joint validation.\n' >&2
  exit 1
fi
IFS=$'\t' read -r PGSQL_POD PGSQL_POD_UID PGSQL_DEPLOYMENT_UID <<<"$PGSQL_POD_INFO"
PGSQL_POD_JSON="$(jq -cer '.items[0]' <<<"$PGSQL_PODS_JSON")"
require_pgsql_source() {
  recovery_require_pod_identity "$PGSQL_POD" "$PGSQL_POD_UID" &&
    recovery_require_pod_deployment_ownership \
      "$PGSQL_POD_JSON" pgsql "$PGSQL_DEPLOYMENT_UID"
}
LIVE_CONTRACT="$(mktemp "${TMPDIR:-/tmp}/yenhubs-coordinated-live-contract.XXXXXX")"
chmod 600 "$LIVE_CONTRACT"
require_owned_restore_lock
require_pgsql_source
recovery_capture_live_database_contract "$PGSQL_POD" "$LIVE_CONTRACT"
require_owned_restore_lock
require_pgsql_source
recovery_database_contracts_match "$RECOVERY_DATABASE_CONTRACT_COPY" "$LIVE_CONTRACT" || {
  printf 'Live DB contract drifted before coordinated resume.\n' >&2
  exit 1
}

RESTORE_PHASE="resuming"
recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
require_owned_restore_lock
# Capture the post-restore resourceVersions while preserving the immutable
# post-lock UID/selector/template fingerprint contract.
for index in "${!CONSUMERS[@]}"; do
  deployment="${CONSUMERS[$index]}"
  deployment_contract="$(recovery_capture_deployment_contract "$deployment")" || exit 1
  IFS=$'\t' read -r current_uid current_resource_version current_replicas \
    current_selector current_fingerprint <<<"$deployment_contract"
  [[ "$current_uid" == "${DEPLOYMENT_UIDS[$index]}" && "$current_replicas" == 0 &&
     "$current_selector" == "${DEPLOYMENT_SELECTORS[$index]}" &&
     "$current_fingerprint" == "${DEPLOYMENT_FINGERPRINTS[$index]}" ]] || {
    printf 'DB consumer contract changed before coordinated resume: %s.\n' "$deployment" >&2
    exit 1
  }
  DEPLOYMENT_RESOURCE_VERSIONS[index]="$current_resource_version"
done
# Bring up database proxies first, then Reticulum. Bot readiness depends on an
# authoritative Reticulum snapshot, so Reticulum must be Ready before the bot
# orchestrator is started. Coturn is independent but is kept after Reticulum so
# no externally reachable application consumer precedes the validated backend.
# No workload is resumed until both checkpoint halves have passed validation.
for index in 1 2; do
  DEPLOYMENT_RESOURCE_VERSIONS[index]="$(recovery_scale_deployment_exact \
    "${CONSUMERS[$index]}" "${DEPLOYMENT_UIDS[$index]}" \
    "${DEPLOYMENT_RESOURCE_VERSIONS[$index]}" 0 "${ORIGINAL_REPLICAS[$index]}" \
    "${DEPLOYMENT_SELECTORS[$index]}" "${DEPLOYMENT_FINGERPRINTS[$index]}")"
  recovery_kubectl rollout status "deployment/${CONSUMERS[$index]}" -n "$NAMESPACE" --timeout=5m >/dev/null
  require_owned_restore_lock
  recovery_require_deployment_contract "${CONSUMERS[$index]}" \
    "${DEPLOYMENT_UIDS[$index]}" "${ORIGINAL_REPLICAS[$index]}" \
    "${DEPLOYMENT_SELECTORS[$index]}" "${DEPLOYMENT_FINGERPRINTS[$index]}"
done
for index in 0 4 3; do
  DEPLOYMENT_RESOURCE_VERSIONS[index]="$(recovery_scale_deployment_exact \
    "${CONSUMERS[$index]}" "${DEPLOYMENT_UIDS[$index]}" \
    "${DEPLOYMENT_RESOURCE_VERSIONS[$index]}" 0 "${ORIGINAL_REPLICAS[$index]}" \
    "${DEPLOYMENT_SELECTORS[$index]}" "${DEPLOYMENT_FINGERPRINTS[$index]}")"
  recovery_kubectl rollout status "deployment/${CONSUMERS[$index]}" -n "$NAMESPACE" --timeout=5m >/dev/null
  require_owned_restore_lock
  recovery_require_deployment_contract "${CONSUMERS[$index]}" \
    "${DEPLOYMENT_UIDS[$index]}" "${ORIGINAL_REPLICAS[$index]}" \
    "${DEPLOYMENT_SELECTORS[$index]}" "${DEPLOYMENT_FINGERPRINTS[$index]}"
done

if ! release_restore_lock; then
  printf 'Coordinated restore completed but its owned lock could not be released safely.\n' >&2
  if ! quiesce_after_failure; then
    printf 'Automatic fail-closed quiesce could not be completed.\n' >&2
    printf 'The restore lock is retained; consumer state requires manual inspection.\n' >&2
  else
    printf 'The restore lock is retained for inspection; consumers remain at zero.\n' >&2
  fi
  exit 1
fi
RESTORE_PHASE="complete"
trap - ERR
printf 'Coordinated checkpoint restore completed: checkpoint=%s namespace=%s pvc_uid=%s\n' \
  "$stamp" "$NAMESPACE" "$RECOVERY_PVC_UID"

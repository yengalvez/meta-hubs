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
PREPARE_FENCE="${RESTORE_CHECKPOINT_PREPARE_FENCE:-0}"
EXECUTE_FENCED="${RESTORE_CHECKPOINT_EXECUTE_FENCED:-0}"
FINALIZE_REACTIVATION="${RESTORE_CHECKPOINT_FINALIZE_REACTIVATION:-0}"
NAMESPACE="${NAMESPACE:-hcce}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VALUES_SOURCE_FILE="${VALUES_FILE:-$SCRIPT_DIR/input-values.local.yaml}"
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
if [[ "$PREPARE_FENCE" != "0" && "$PREPARE_FENCE" != "1" ]] ||
   [[ "$EXECUTE_FENCED" != "0" && "$EXECUTE_FENCED" != "1" ]] ||
   [[ "$FINALIZE_REACTIVATION" != "0" && "$FINALIZE_REACTIVATION" != "1" ]]; then
  printf 'Restore fence phase flags must be 0 or 1.\n' >&2
  exit 2
fi
if (( PREFLIGHT + CLEAR_STALE_LOCK + PREPARE_FENCE + EXECUTE_FENCED + FINALIZE_REACTIVATION > 1 )); then
  printf 'Preflight, stale-lock clearance, prepare-fence, execute-fenced and finalization are separate operations.\n' >&2
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
RUNNER_RESUME_MONITOR_STOP=""
RUNNER_RESUME_MONITOR_FAILURE=""
RUNNER_RESUME_MONITOR_READY=""
RUNNER_RESUME_MONITOR_PID=""
SERIALIZATION_LEASE_OWNED=0
RUNNER_ROLE_UID=""
FAILCLOSE_RUNNER_ROLE_UID=""

discard_runner_resume_monitor() {
  if [[ -n "$RUNNER_RESUME_MONITOR_PID" ]]; then
    recovery_discard_no_managed_bot_runner_watch \
      "$RUNNER_RESUME_MONITOR_STOP" "$RUNNER_RESUME_MONITOR_PID"
    RUNNER_RESUME_MONITOR_PID=""
  fi
  [[ -z "$RUNNER_RESUME_MONITOR_STOP" ]] || rm -f -- "$RUNNER_RESUME_MONITOR_STOP"
  [[ -z "$RUNNER_RESUME_MONITOR_FAILURE" ]] || rm -f -- "$RUNNER_RESUME_MONITOR_FAILURE"
  [[ -z "$RUNNER_RESUME_MONITOR_READY" ]] || rm -f -- "$RUNNER_RESUME_MONITOR_READY"
  RUNNER_RESUME_MONITOR_STOP=""
  RUNNER_RESUME_MONITOR_FAILURE=""
  RUNNER_RESUME_MONITOR_READY=""
}

start_runner_resume_monitor() {
  recovery_require_no_managed_bot_runner_pods || return 1
  RUNNER_RESUME_MONITOR_STOP="$(mktemp "${TMPDIR:-/tmp}/yenhubs-restore-runner-stop.XXXXXX")" || return 1
  RUNNER_RESUME_MONITOR_FAILURE="$(mktemp "${TMPDIR:-/tmp}/yenhubs-restore-runner-failure.XXXXXX")" || {
    discard_runner_resume_monitor
    return 1
  }
  RUNNER_RESUME_MONITOR_READY="$(mktemp "${TMPDIR:-/tmp}/yenhubs-restore-runner-ready.XXXXXX")" || {
    discard_runner_resume_monitor
    return 1
  }
  chmod 600 "$RUNNER_RESUME_MONITOR_STOP" "$RUNNER_RESUME_MONITOR_FAILURE" \
    "$RUNNER_RESUME_MONITOR_READY"
  if ! recovery_start_no_managed_bot_runner_watch \
    "$RUNNER_RESUME_MONITOR_STOP" "$RUNNER_RESUME_MONITOR_FAILURE" \
    "$RUNNER_RESUME_MONITOR_READY" RUNNER_RESUME_MONITOR_PID; then
    discard_runner_resume_monitor
    return 1
  fi
}

stop_runner_resume_monitor_before_parent() {
  local monitor_status=0
  [[ -n "$RUNNER_RESUME_MONITOR_PID" ]] || {
    printf 'Managed bot-runner resume monitor was not active before parent start.\n' >&2
    return 1
  }
  if ! recovery_stop_no_managed_bot_runner_watch \
    "$RUNNER_RESUME_MONITOR_STOP" "$RUNNER_RESUME_MONITOR_FAILURE" \
    "$RUNNER_RESUME_MONITOR_READY" "$RUNNER_RESUME_MONITOR_PID"; then
    monitor_status=1
  fi
  RUNNER_RESUME_MONITOR_PID=""
  rm -f -- "$RUNNER_RESUME_MONITOR_STOP" "$RUNNER_RESUME_MONITOR_FAILURE" \
    "$RUNNER_RESUME_MONITOR_READY"
  RUNNER_RESUME_MONITOR_STOP=""
  RUNNER_RESUME_MONITOR_FAILURE=""
  RUNNER_RESUME_MONITOR_READY=""
  if [[ "$monitor_status" != 0 ]]; then
    printf 'Managed bot-runner Pods reappeared before the parent resume gate.\n' >&2
    return 1
  fi
}

require_runner_resume_monitor_healthy() {
  if ! recovery_require_no_managed_bot_runner_watch_healthy \
    "$RUNNER_RESUME_MONITOR_FAILURE" "$RUNNER_RESUME_MONITOR_READY" \
    "$RUNNER_RESUME_MONITOR_PID"; then
    printf 'Managed bot-runner event watcher failed during the coordinated restore window.\n' >&2
    return 1
  fi
}

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
  recovery_require_operation_serialization || return 1
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

restore_fence_confirmation_value() {
  local action="$1"
  [[ "$action" == prepare-fence || "$action" == execute-fenced ||
     "$action" == finalize-reactivation ]] || return 2
  printf '%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s' \
    "$action" "$EXPECTED_KUBE_CONTEXT" "$NAMESPACE" "$RECOVERY_NAMESPACE_UID" \
    "$RECOVERY_PVC_UID" "$RECOVERY_CHECKPOINT_STAMP" "$RECOVERY_DUMP_SHA256" \
    "$RECOVERY_STORAGE_SHA256" "$RECOVERY_DEPLOYMENT_INVENTORY_SHA256" \
    "$RECOVERY_FENCE_PRE_EPOCH" "$RECOVERY_FENCE_TARGET_EPOCH"
  if [[ "$action" == execute-fenced || "$action" == finalize-reactivation ]]; then
    printf ':%s:%s' "$RESTORE_LOCK_UID" "$RESTORE_OPERATION_ID"
  fi
}

require_restore_fence_confirmation() {
  local variable_name="$1" action="$2" expected actual
  expected="$(restore_fence_confirmation_value "$action")" || return 1
  actual="${!variable_name:-}"
  [[ "$actual" == "$expected" ]] || {
    printf 'Refusing restore fence phase. Set %s=%q for this exact target and checkpoint.\n' \
      "$variable_name" "$expected" >&2
    return 1
  }
}

load_restore_fence_lock() {
  local expected_state="$1" lock_json
  lock_json="$(recovery_kubectl get configmap "$RESTORE_LOCK_NAME" -n "$NAMESPACE" -o json)" || {
    printf 'The prepared restore-fence lock is missing.\n' >&2
    return 1
  }
  RESTORE_LOCK_UID="$(jq -er '.metadata.uid | select(type == "string" and length > 0)' \
    <<<"$lock_json")" || return 1
  RESTORE_LOCK_RESOURCE_VERSION="$(jq -er \
    '.metadata.resourceVersion | select(type == "string" and length > 0)' \
    <<<"$lock_json")" || return 1
  RESTORE_LOCK_TOKEN="$(jq -er '
    .metadata.annotations["yenhubs.org/recovery-token"] |
    select(type == "string" and test("^[a-f0-9]{32}$"))
  ' <<<"$lock_json")" || return 1
  RESTORE_OPERATION_ID="$(jq -er '
    .metadata.annotations["yenhubs.org/operation-id"] |
    select(type == "string" and test("^[a-f0-9]{32}$"))
  ' <<<"$lock_json")" || return 1
  RECOVERY_FENCE_PRE_EPOCH="$(jq -er '
    .metadata.annotations["yenhubs.org/pre-fence-epoch"] |
    select(. == "legacy-absent" or
      (type == "string" and
       test("^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$")))
  ' <<<"$lock_json")" || return 1
  RECOVERY_FENCE_TARGET_EPOCH="$(jq -er '
    .metadata.annotations["yenhubs.org/restore-fence-epoch"] |
    select(type == "string" and
      test("^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$"))
  ' <<<"$lock_json")" || return 1
  RECOVERY_OPERATION_STATE="$(jq -er --arg expected "$expected_state" '
    .metadata.annotations["yenhubs.org/recovery-state"] |
    select(type == "string" and . == $expected)
  ' <<<"$lock_json")" || return 1
  RECOVERY_OPERATION_OWNER="checkpoint-restore"
  RECOVERY_OPERATION_LOCK_NAME="$RESTORE_LOCK_NAME"
  RECOVERY_OPERATION_LOCK_UID="$RESTORE_LOCK_UID"
  RECOVERY_OPERATION_LOCK_RESOURCE_VERSION="$RESTORE_LOCK_RESOURCE_VERSION"
  RECOVERY_OPERATION_TOKEN="$RESTORE_LOCK_TOKEN"
  RECOVERY_OPERATION_ID="$RESTORE_OPERATION_ID"
  RESTORE_LOCK_CREATED=1
  export RECOVERY_OPERATION_OWNER RECOVERY_OPERATION_LOCK_NAME \
    RECOVERY_OPERATION_LOCK_UID RECOVERY_OPERATION_LOCK_RESOURCE_VERSION \
    RECOVERY_OPERATION_TOKEN RECOVERY_OPERATION_ID RECOVERY_OPERATION_STATE \
    RECOVERY_FENCE_PRE_EPOCH RECOVERY_FENCE_TARGET_EPOCH
  restore_lock_json_is_exact "$lock_json" || {
    printf 'The prepared restore-fence lock does not match this checkpoint and target.\n' >&2
    return 1
  }
}

transition_restore_lock_state() {
  local expected_state="$1" next_state="$2" lock_json replaced_json
  [[ "$expected_state" =~ ^[a-z][a-z0-9-]{0,62}$ &&
     "$next_state" =~ ^[a-z][a-z0-9-]{0,62}$ ]] || return 2
  [[ "$RECOVERY_OPERATION_STATE" == "$expected_state" ]] || return 1
  recovery_require_operation_serialization || return 1
  lock_json="$(recovery_kubectl get configmap "$RESTORE_LOCK_NAME" \
    -n "$NAMESPACE" -o json)" || return 1
  restore_lock_json_is_exact "$lock_json" || return 1
  replaced_json="$(jq -c --arg state "$next_state" '
    .metadata.annotations["yenhubs.org/recovery-state"] = $state |
    del(.metadata.managedFields)
  ' <<<"$lock_json" | recovery_kubectl_mutate replace -f - -o json)" || {
    printf 'Could not CAS the restore lock to state %s.\n' "$next_state" >&2
    return 1
  }
  [[ "$(jq -er '.metadata.uid' <<<"$replaced_json")" == "$RESTORE_LOCK_UID" ]] || return 1
  RESTORE_LOCK_RESOURCE_VERSION="$(jq -er \
    '.metadata.resourceVersion | select(type == "string" and length > 0)' \
    <<<"$replaced_json")" || return 1
  RECOVERY_OPERATION_LOCK_RESOURCE_VERSION="$RESTORE_LOCK_RESOURCE_VERSION"
  RECOVERY_OPERATION_STATE="$next_state"
  export RECOVERY_OPERATION_LOCK_RESOURCE_VERSION RECOVERY_OPERATION_STATE
  restore_lock_json_is_exact "$replaced_json" &&
    recovery_require_operation_serialization
}

clear_stale_restore_lock() {
  local lock_json deployment deployment_json replicas selector current_lock_json
  local lock_state pre_epoch target_epoch inventory_sha
  lock_json="$(recovery_kubectl get configmap "$RESTORE_LOCK_NAME" -n "$NAMESPACE" -o json)" || {
    printf 'No readable stale restore lock exists in the pinned target.\n' >&2
    return 1
  }
  RESTORE_LOCK_UID="$(jq -er '.metadata.uid | select(type == "string" and length > 0)' <<<"$lock_json")" || return 1
  RESTORE_LOCK_RESOURCE_VERSION="$(jq -er '.metadata.resourceVersion | select(type == "string" and length > 0)' <<<"$lock_json")" || return 1
  RESTORE_LOCK_TOKEN="$(jq -er '.metadata.annotations["yenhubs.org/recovery-token"] | select(type == "string" and test("^[a-f0-9]{32}$"))' <<<"$lock_json")" || return 1
  RESTORE_OPERATION_ID="$(jq -er '.metadata.annotations["yenhubs.org/operation-id"] | select(type == "string" and test("^[a-f0-9]{32}$"))' <<<"$lock_json")" || return 1
  lock_state="$(jq -er '.metadata.annotations["yenhubs.org/recovery-state"] // "" | select(type == "string")' <<<"$lock_json")" || return 1
  pre_epoch="$(jq -er '.metadata.annotations["yenhubs.org/pre-fence-epoch"] // "" | select(type == "string")' <<<"$lock_json")" || return 1
  target_epoch="$(jq -er '.metadata.annotations["yenhubs.org/restore-fence-epoch"] // "" | select(type == "string")' <<<"$lock_json")" || return 1
  inventory_sha="$(jq -er '.metadata.annotations["yenhubs.org/deployment-inventory-sha256"] // "" | select(type == "string")' <<<"$lock_json")" || return 1
  if [[ -n "$lock_state" || -n "$pre_epoch" || -n "$target_epoch" || -n "$inventory_sha" ]]; then
    [[ "$lock_state" =~ ^[a-z][a-z0-9-]{0,62}$ &&
       ( "$pre_epoch" == legacy-absent ||
         "$pre_epoch" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ ) &&
       "$target_epoch" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ &&
       "$inventory_sha" == "$RECOVERY_DEPLOYMENT_INVENTORY_SHA256" ]] || return 1
    RECOVERY_OPERATION_STATE="$lock_state"
    RECOVERY_FENCE_PRE_EPOCH="$pre_epoch"
    RECOVERY_FENCE_TARGET_EPOCH="$target_epoch"
  fi
  RESTORE_LOCK_CREATED=1
  restore_lock_json_is_exact "$lock_json" || {
    printf 'Stale restore lock is not bound to this exact checkpoint.\n' >&2
    return 1
  }
  recovery_require_confirmation CONFIRM_CLEAR_RESTORE_LOCK restore-lock \
    "$RESTORE_LOCK_UID:$RECOVERY_PVC_UID"
  recovery_wait_for_no_managed_bot_runner_pods 30s
  start_runner_resume_monitor
  export RECOVERY_OPERATION_OWNER RECOVERY_OPERATION_LOCK_NAME \
    RECOVERY_OPERATION_LOCK_UID RECOVERY_OPERATION_LOCK_RESOURCE_VERSION \
    RECOVERY_OPERATION_TOKEN RECOVERY_OPERATION_ID
  RESTORE_COORDINATED=1 RESTORE_STORAGE_CLEAR_STALE_HELPER=1 \
  YENHUBS_PARENT_LEASE_HOLDER="$RECOVERY_SERIALIZATION_LEASE_HOLDER" \
  YENHUBS_PARENT_LEASE_UID="$RECOVERY_SERIALIZATION_LEASE_UID" \
  YENHUBS_PARENT_PROCESS_PID="$RECOVERY_SERIALIZATION_PARENT_PID" \
  YENHUBS_PARENT_PROCESS_START_IDENTITY="$RECOVERY_SERIALIZATION_PARENT_START_IDENTITY" \
    "$SCRIPT_DIR/restore-ret-storage.sh" "$STORAGE_PATH"
  require_runner_resume_monitor_healthy
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
  recovery_wait_for_no_managed_bot_runner_pods 30s
  recovery_require_cluster_identity
  recovery_require_pvc_identity ret-pvc
  current_lock_json="$(recovery_kubectl get configmap "$RESTORE_LOCK_NAME" -n "$NAMESPACE" -o json)" || return 1
  restore_lock_json_is_exact "$current_lock_json" || {
    printf 'Restore lock changed before stale-lock deletion.\n' >&2
    return 1
  }
  recovery_require_no_managed_bot_runner_pods
  require_runner_resume_monitor_healthy
  recovery_delete_namespaced_with_uid configmap "$RESTORE_LOCK_NAME" \
    "$RESTORE_LOCK_UID" 60
  stop_runner_resume_monitor_before_parent
  RESTORE_LOCK_CREATED=0
  printf 'Stale checkpoint-restore lock cleared after exact confirmation; no workload was resumed.\n'
}

cleanup_driver() {
  discard_runner_resume_monitor
  [[ -z "$LIVE_CONTRACT" ]] || rm -f -- "$LIVE_CONTRACT"
  recovery_cleanup_materialized_checkpoint
  if [[ "$SERIALIZATION_LEASE_OWNED" == 1 ]]; then
    if recovery_release_operation_serialization; then
      SERIALIZATION_LEASE_OWNED=0
    else
      printf 'Restore serialization Lease could not be released safely.\n' >&2
    fi
  fi
}

acquire_restore_serialization() {
  [[ "$SERIALIZATION_LEASE_OWNED" == 0 ]] || return 2
  recovery_acquire_operation_serialization root-recovery || return 1
  SERIALIZATION_LEASE_OWNED=1
  recovery_require_operation_serialization
}

release_restore_serialization() {
  [[ "$SERIALIZATION_LEASE_OWNED" == 1 ]] || return 0
  recovery_release_operation_serialization || return 1
  SERIALIZATION_LEASE_OWNED=0
}

capture_consumer_contracts_at_replicas() {
  local expected_replicas="$1" original_replicas="$2"
  local deployment deployment_contract deployment_uid deployment_resource_version
  local replicas deployment_selector deployment_fingerprint consumer_contracts='[]'
  DEPLOYMENT_UIDS=()
  DEPLOYMENT_RESOURCE_VERSIONS=()
  ORIGINAL_REPLICAS=()
  DEPLOYMENT_SELECTORS=()
  DEPLOYMENT_FINGERPRINTS=()
  for deployment in "${CONSUMERS[@]}"; do
    deployment_contract="$(recovery_capture_deployment_contract "$deployment")" || return 1
    IFS=$'\t' read -r deployment_uid deployment_resource_version replicas \
      deployment_selector deployment_fingerprint <<<"$deployment_contract"
    [[ "$replicas" == "$expected_replicas" ]] || {
      printf 'Restore fence requires deployment/%s replicas=%s, found %s.\n' \
        "$deployment" "$expected_replicas" "$replicas" >&2
      return 1
    }
    DEPLOYMENT_UIDS+=("$deployment_uid")
    DEPLOYMENT_RESOURCE_VERSIONS+=("$deployment_resource_version")
    ORIGINAL_REPLICAS+=("$original_replicas")
    DEPLOYMENT_SELECTORS+=("$deployment_selector")
    DEPLOYMENT_FINGERPRINTS+=("$deployment_fingerprint")
    consumer_contracts="$(jq -cn \
      --argjson current "$consumer_contracts" --arg name "$deployment" \
      --arg uid "$deployment_uid" --arg resource_version "$deployment_resource_version" \
      --argjson original_replicas "$original_replicas" \
      --arg selector "$deployment_selector" --arg fingerprint "$deployment_fingerprint" \
      '$current + [{name:$name,uid:$uid,initial_resource_version:$resource_version,
        original_replicas:$original_replicas,selector:$selector,fingerprint:$fingerprint}]'
    )"
  done
  RECOVERY_CONSUMER_CONTRACT_JSON="$(jq -cn \
    --arg operation_id "$RESTORE_OPERATION_ID" --argjson consumers "$consumer_contracts" \
    '{schema_version:1,operation_id:$operation_id,consumers:$consumers}')"
  recovery_consumer_contract_is_acceptable "$RECOVERY_CONSUMER_CONTRACT_JSON"
  export RECOVERY_CONSUMER_CONTRACT_JSON
}

capture_consumer_contracts_for_failclose() {
  local deployment deployment_contract deployment_uid deployment_resource_version
  local replicas deployment_selector deployment_fingerprint consumer_contracts='[]'
  DEPLOYMENT_UIDS=()
  DEPLOYMENT_RESOURCE_VERSIONS=()
  ORIGINAL_REPLICAS=()
  DEPLOYMENT_SELECTORS=()
  DEPLOYMENT_FINGERPRINTS=()
  for deployment in "${CONSUMERS[@]}"; do
    deployment_contract="$(recovery_capture_deployment_contract "$deployment")" || return 1
    IFS=$'\t' read -r deployment_uid deployment_resource_version replicas \
      deployment_selector deployment_fingerprint <<<"$deployment_contract"
    [[ "$replicas" =~ ^[0-9]+$ ]] || return 1
    DEPLOYMENT_UIDS+=("$deployment_uid")
    DEPLOYMENT_RESOURCE_VERSIONS+=("$deployment_resource_version")
    ORIGINAL_REPLICAS+=(1)
    DEPLOYMENT_SELECTORS+=("$deployment_selector")
    DEPLOYMENT_FINGERPRINTS+=("$deployment_fingerprint")
    consumer_contracts="$(jq -cn \
      --argjson current "$consumer_contracts" --arg name "$deployment" \
      --arg uid "$deployment_uid" --arg resource_version "$deployment_resource_version" \
      --arg selector "$deployment_selector" --arg fingerprint "$deployment_fingerprint" \
      '$current + [{name:$name,uid:$uid,initial_resource_version:$resource_version,
        original_replicas:1,selector:$selector,fingerprint:$fingerprint}]')"
  done
  RECOVERY_CONSUMER_CONTRACT_JSON="$(jq -cn \
    --arg operation_id "$RESTORE_OPERATION_ID" --argjson consumers "$consumer_contracts" \
    '{schema_version:1,operation_id:$operation_id,consumers:$consumers}')"
  recovery_consumer_contract_is_acceptable "$RECOVERY_CONSUMER_CONTRACT_JSON"
  export RECOVERY_CONSUMER_CONTRACT_JSON
}

runner_role_json_has_safe_contract() {
  local role_json="$1"
  jq -e --arg uid "$RUNNER_ROLE_UID" '
    .apiVersion == "rbac.authorization.k8s.io/v1" and .kind == "Role" and
    .metadata.name == "bot-orchestrator-runner-pods" and
    .metadata.namespace == "hcce-bot-runners" and
    (.metadata | has("deletionTimestamp") | not) and
    (((.metadata | has("ownerReferences") | not) or .metadata.ownerReferences == [])) and
    (((.metadata | has("finalizers") | not) or .metadata.finalizers == [])) and
    (.metadata.uid | type == "string" and length > 0) and
    (.metadata.resourceVersion | type == "string" and length > 0) and
    ($uid == "" or .metadata.uid == $uid) and
    (.metadata.annotations["yenhubs.org/runner-activation-phase"] == "active") and
    ((.metadata.annotations["yenhubs.org/bot-runner-recovery-phase"] == "active") or
      (.metadata.annotations["yenhubs.org/bot-runner-recovery-phase"] == "restore-fence")) and
    (.rules == [] or .rules == [{apiGroups:[""],resources:["pods"],
      verbs:["create","delete","get","list"]}])
  ' >/dev/null <<<"$role_json"
}

runner_role_json_is_inert_by_name() {
  local role_json="$1" expected_uid="${2:-}"
  jq -e --arg uid "$expected_uid" '
    .apiVersion == "rbac.authorization.k8s.io/v1" and .kind == "Role" and
    .metadata.name == "bot-orchestrator-runner-pods" and
    .metadata.namespace == "hcce-bot-runners" and
    (.metadata | has("deletionTimestamp") | not) and
    (.metadata.uid | type == "string" and length > 0) and
    (.metadata.resourceVersion | type == "string" and length > 0) and
    ($uid == "" or .metadata.uid == $uid) and
    (.metadata.annotations["yenhubs.org/runner-activation-phase"] == "active") and
    (.metadata.annotations["yenhubs.org/bot-runner-recovery-phase"] == "restore-fence") and
    .rules == []
  ' >/dev/null <<<"$role_json"
}

capture_runner_role_for_failclose() {
  local role_json
  role_json="$(recovery_kubectl get role bot-orchestrator-runner-pods \
    -n hcce-bot-runners -o json)" || return 1
  RUNNER_ROLE_UID="$(jq -er '.metadata.uid | select(type == "string" and length > 0)' \
    <<<"$role_json")" || return 1
  runner_role_json_has_safe_contract "$role_json"
}

capture_finalizer_failclose_contracts() {
  local capture_status=0
  capture_runner_role_for_failclose || capture_status=1
  capture_consumer_contracts_for_failclose || capture_status=1
  [[ "$capture_status" == 0 ]]
}

neutralize_runner_role_exact() {
  local role_json replaced_json live_uid drift=0 attempt
  recovery_require_operation_serialization || return 1
  for attempt in 1 2 3; do
    role_json="$(recovery_kubectl get role bot-orchestrator-runner-pods \
      -n hcce-bot-runners -o json)" || continue
    live_uid="$(jq -er --arg namespace hcce-bot-runners '
      select(.apiVersion == "rbac.authorization.k8s.io/v1" and .kind == "Role") |
      select(.metadata.name == "bot-orchestrator-runner-pods" and
        .metadata.namespace == $namespace) |
      .metadata.uid | select(type == "string" and length > 0)
    ' <<<"$role_json")" || continue
    if [[ -z "$RUNNER_ROLE_UID" ]]; then
      RUNNER_ROLE_UID="$live_uid"
      drift=1
    elif [[ "$live_uid" != "$RUNNER_ROLE_UID" ]]; then
      drift=1
    fi
    runner_role_json_has_safe_contract "$role_json" || drift=1
    if runner_role_json_is_inert_by_name "$role_json" "$live_uid"; then
      FAILCLOSE_RUNNER_ROLE_UID="$live_uid"
      recovery_require_operation_serialization || return 1
      [[ "$drift" == 0 ]]
      return
    fi
    if ! replaced_json="$(jq -c '
      del(.metadata.managedFields, .metadata.creationTimestamp) |
      .metadata.annotations = (.metadata.annotations // {}) |
      .metadata.annotations["yenhubs.org/runner-activation-phase"] = "active" |
      .metadata.annotations["yenhubs.org/bot-runner-recovery-phase"] = "restore-fence" |
      .rules = []
    ' <<<"$role_json" | recovery_kubectl_mutate replace -f - -o json)"; then
      continue
    fi
    if runner_role_json_is_inert_by_name "$replaced_json" "$live_uid"; then
      FAILCLOSE_RUNNER_ROLE_UID="$live_uid"
      recovery_require_operation_serialization || return 1
      [[ "$drift" == 0 ]]
      return
    fi
  done
  return 1
}

require_runner_absence_stable() {
  local stable_seconds started role_json
  stable_seconds="$(recovery_stable_absence_seconds)" || return 1
  started="$SECONDS"
  while :; do
    recovery_require_operation_serialization || return 1
    [[ -n "$FAILCLOSE_RUNNER_ROLE_UID" ]] || return 1
    role_json="$(recovery_kubectl get role bot-orchestrator-runner-pods \
      -n hcce-bot-runners -o json)" || return 1
    runner_role_json_is_inert_by_name \
      "$role_json" "$FAILCLOSE_RUNNER_ROLE_UID" || return 1
    recovery_require_no_managed_bot_runner_pods || return 1
    ((SECONDS - started >= stable_seconds)) && return 0
    sleep 1
  done
}

prepare_restore_fence() {
  local index
  RESTORE_PHASE="quiescing"
  capture_runner_role_for_failclose
  neutralize_runner_role_exact
  capture_consumer_contracts_at_replicas 1 1
  for index in "${!CONSUMERS[@]}"; do
    DEPLOYMENT_RESOURCE_VERSIONS[index]="$(recovery_scale_deployment_exact \
      "${CONSUMERS[$index]}" "${DEPLOYMENT_UIDS[$index]}" \
      "${DEPLOYMENT_RESOURCE_VERSIONS[$index]}" 1 0 \
      "${DEPLOYMENT_SELECTORS[$index]}" "${DEPLOYMENT_FINGERPRINTS[$index]}")" || return 1
  done
  for index in "${!CONSUMERS[@]}"; do
    recovery_wait_for_no_pods "app=${DEPLOYMENT_SELECTORS[$index]}" \
      "deployment/${CONSUMERS[$index]}" 180s || return 1
    recovery_require_consumer_contract_entry \
      "$RECOVERY_CONSUMER_CONTRACT_JSON" "${CONSUMERS[$index]}" 0 \
      "$RESTORE_OPERATION_ID" || return 1
  done
  recovery_wait_for_no_managed_bot_runner_pods 180s
  recovery_require_no_managed_bot_runner_pods
  RESTORE_PHASE="fence-prepared"
}

scale_fixed_deployment_to_zero_failclose() {
  local deployment="$1" attempt deployment_json after_json
  local uid resource_version replicas selector fingerprint
  local after_uid after_resource_version after_replicas after_selector after_fingerprint
  [[ "$deployment" =~ ^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$ ]] || return 2
  for attempt in 1 2 3; do
    recovery_require_operation_serialization || return 1
    deployment_json="$(recovery_kubectl get deployment "$deployment" \
      -n "$NAMESPACE" -o json)" || continue
    IFS=$'\t' read -r uid resource_version replicas selector fingerprint < <(
      jq -er --arg name "$deployment" --arg namespace "$NAMESPACE" '
        select(.apiVersion == "apps/v1" and .kind == "Deployment") |
        select(.metadata.name == $name and .metadata.namespace == $namespace) |
        select(.metadata.uid | type == "string" and length > 0) |
        select(.metadata.resourceVersion | type == "string" and length > 0) |
        select(.spec.replicas | type == "number" and floor == . and . >= 0) |
        [ .metadata.uid, .metadata.resourceVersion, (.spec.replicas | tostring),
          (if (.spec.selector.matchLabels.app | type) == "string"
           then .spec.selector.matchLabels.app else "" end),
          ({selector:(.spec.selector // {}),strategy:(.spec.strategy // {}),
            template:(.spec.template // {})} | @base64) ] | @tsv
      ' <<<"$deployment_json"
    ) || continue
    if ! recovery_kubectl_mutate scale deployment "$deployment" \
      -n "$NAMESPACE" --current-replicas="$replicas" \
      --resource-version="$resource_version" --replicas=0 >/dev/null; then
      continue
    fi
    after_json="$(recovery_kubectl get deployment "$deployment" \
      -n "$NAMESPACE" -o json)" || continue
    IFS=$'\t' read -r after_uid after_resource_version after_replicas \
      after_selector after_fingerprint < <(
      jq -er --arg name "$deployment" --arg namespace "$NAMESPACE" '
        select(.apiVersion == "apps/v1" and .kind == "Deployment") |
        select(.metadata.name == $name and .metadata.namespace == $namespace) |
        select(.metadata.uid | type == "string" and length > 0) |
        select(.metadata.resourceVersion | type == "string" and length > 0) |
        select(.spec.replicas | type == "number" and floor == . and . >= 0) |
        [ .metadata.uid, .metadata.resourceVersion, (.spec.replicas | tostring),
          (if (.spec.selector.matchLabels.app | type) == "string"
           then .spec.selector.matchLabels.app else "" end),
          ({selector:(.spec.selector // {}),strategy:(.spec.strategy // {}),
            template:(.spec.template // {})} | @base64) ] | @tsv
      ' <<<"$after_json"
    ) || continue
    if [[ "$after_uid" == "$uid" && "$after_replicas" == 0 ]]; then
      recovery_require_operation_serialization || return 1
      printf '%s\t%s\t%s\n' "$after_uid" "$after_selector" "$after_fingerprint"
      return 0
    fi
  done
  return 1
}

require_fixed_deployment_zero_failclose() {
  local deployment="$1" expected_uid="$2" deployment_json
  deployment_json="$(recovery_kubectl get deployment "$deployment" \
    -n "$NAMESPACE" -o json)" || return 1
  jq -e --arg name "$deployment" --arg namespace "$NAMESPACE" \
    --arg uid "$expected_uid" '
    .apiVersion == "apps/v1" and .kind == "Deployment" and
    .metadata.name == $name and .metadata.namespace == $namespace and
    .metadata.uid == $uid and .spec.replicas == 0 and
    (.metadata.generation | type == "number" and floor == . and . > 0) and
    .status.observedGeneration == .metadata.generation and
    ((.status.replicas // 0) == 0) and
    ((.status.readyReplicas // 0) == 0) and
    ((.status.availableReplicas // 0) == 0) and
    ((.status.updatedReplicas // 0) == 0) and
    ((.status.unavailableReplicas // 0) == 0)
  ' >/dev/null <<<"$deployment_json"
}

require_no_pods_owned_by_fixed_deployment() {
  local deployment="$1" replica_sets_json pods_json
  replica_sets_json="$(recovery_kubectl get replicaset -n "$NAMESPACE" -o json)" || return 1
  pods_json="$(recovery_kubectl get pod -n "$NAMESPACE" -o json)" || return 1
  jq -e --arg deployment "$deployment" '
    .[0] as $replicasets | .[1] as $pods |
    if ($replicasets.apiVersion == "v1" and
        $replicasets.kind == "ReplicaSetList" and
        ($replicasets.items | type) == "array" and
        $pods.apiVersion == "v1" and $pods.kind == "PodList" and
        ($pods.items | type) == "array") then
      ([ $replicasets.items[]
         | select(.metadata.uid | type == "string" and length > 0)
         | select(any(.metadata.ownerReferences[]?;
             .apiVersion == "apps/v1" and .kind == "Deployment" and
             .name == $deployment and .controller == true))
         | .metadata.uid ] | unique) as $owned_replicaset_uids |
      ([ $pods.items[]
         | select(
             (.metadata.labels.app // "") == $deployment or
             any(.metadata.ownerReferences[]?;
               . as $owner |
               ($owner.apiVersion == "apps/v1" and
                $owner.kind == "Deployment" and
                $owner.name == $deployment and $owner.controller == true) or
               ($owner.apiVersion == "apps/v1" and
                $owner.kind == "ReplicaSet" and
                ($owned_replicaset_uids | index($owner.uid)) != null))) ] |
        length == 0)
    else false end
  ' >/dev/null < <(printf '%s\n%s\n' "$replica_sets_json" "$pods_json" | jq -s '.')
}

quiesce_after_failure() {
  local deployment quiesce_status=0 index failclose_contract uid selector fingerprint
  local stable_ok=0
  local -a quiesce_order=(3 0 1 2 4)
  local -a failclose_uids=() failclose_selectors=()
  [[ "$RESTORE_PHASE" == "quiescing" || "$RESTORE_PHASE" == "fence-prepared" ||
     "$RESTORE_PHASE" == "db" || "$RESTORE_PHASE" == "storage" ||
     "$RESTORE_PHASE" == "validating-live" ||
     "$RESTORE_PHASE" == "completing-fenced" ||
     "$RESTORE_PHASE" == "finalizing-reactivation" ]] || return 0
  if ! recovery_require_operation_serialization; then
    printf 'The global serialization Lease was lost; fail-close mutation is unsafe.\n' >&2
    return 1
  fi
  if ! require_owned_restore_lock; then
    printf 'Could not revalidate the exact operation lock; continuing reductive fail-close under the owned Lease.\n' >&2
    quiesce_status=1
  fi
  discard_runner_resume_monitor
  if ! neutralize_runner_role_exact; then
    quiesce_status=1
  fi
  # Stop the token-bearing parent first, then every other fixed consumer name.
  # These reductions deliberately do not depend on the per-restore ConfigMap:
  # the global Lease is the authority boundary, and drift is reported only
  # after every safe scale-to-zero attempt has been made.
  for index in "${quiesce_order[@]}"; do
    deployment="${CONSUMERS[$index]}"
    if ! failclose_contract="$(
      scale_fixed_deployment_to_zero_failclose "$deployment"
    )"; then
      quiesce_status=1
      continue
    fi
    IFS=$'\t' read -r uid selector fingerprint <<<"$failclose_contract"
    failclose_uids[index]="$uid"
    failclose_selectors[index]="$selector"
    if [[ -z "${DEPLOYMENT_UIDS[$index]:-}" ||
          "$uid" != "${DEPLOYMENT_UIDS[$index]:-}" ||
          "$selector" != "${DEPLOYMENT_SELECTORS[$index]:-}" ||
          "$fingerprint" != "${DEPLOYMENT_FINGERPRINTS[$index]:-}" ]]; then
      quiesce_status=1
    fi
  done
  if ! recovery_delete_all_managed_bot_runner_pods_exact; then
    quiesce_status=1
  fi
  for index in "${!CONSUMERS[@]}"; do
    [[ -n "${failclose_uids[$index]:-}" ]] || {
      quiesce_status=1
      continue
    }
    if [[ -z "${failclose_selectors[$index]:-}" ]] ||
       ! recovery_wait_for_no_pods "app=${failclose_selectors[$index]}" \
         "deployment/${CONSUMERS[$index]}" 180s; then
      quiesce_status=1
    fi
    if ! recovery_wait_for_deployment_rollout "${CONSUMERS[$index]}" 180; then
      quiesce_status=1
    fi
    if ! require_fixed_deployment_zero_failclose "${CONSUMERS[$index]}" \
      "${failclose_uids[$index]}"; then
      quiesce_status=1
    fi
    if ! require_no_pods_owned_by_fixed_deployment "${CONSUMERS[$index]}"; then
      quiesce_status=1
    fi
  done
  if ! recovery_wait_for_no_managed_bot_runner_pods 180s; then
    quiesce_status=1
  fi
  # A Role replacement/reactivation during the 61-second window is fenced
  # again by name, all runner Pods are UID-deleted again, and the window is
  # restarted. Any such drift still makes the operation fail for inspection.
  for _ in 1 2 3; do
    if require_runner_absence_stable; then
      stable_ok=1
      break
    fi
    quiesce_status=1
    neutralize_runner_role_exact || :
    recovery_delete_all_managed_bot_runner_pods_exact || :
  done
  [[ "$stable_ok" == 1 ]] || quiesce_status=1
  [[ "$quiesce_status" == 0 ]] || return 1
  printf 'Coordinated restore failed; all DB consumers were forced back to zero.\n' >&2
}

driver_failed() {
  local status=$?
  local quiesced=1
  # errtrace copies ERR into command substitutions and background subshells.
  # They hold only stale copies of phase/lock capabilities and must never run
  # the fail-close mutator; the main shell will receive the nonzero status and
  # perform the single authoritative recovery pass.
  if ((BASH_SUBSHELL > 0)); then
    return "$status"
  fi
  trap - ERR
  if ! quiesce_after_failure; then
    quiesced=0
    printf 'Automatic fail-closed quiesce could not be completed.\n' >&2
  fi
  if [[ "$RESTORE_LOCK_CREATED" == "1" ]]; then
    if [[ "$RESTORE_PHASE" == "quiescing" || "$RESTORE_PHASE" == "fence-prepared" ||
          "$RESTORE_PHASE" == "db" || "$RESTORE_PHASE" == "storage" ||
          "$RESTORE_PHASE" == "validating-live" ||
          "$RESTORE_PHASE" == "completing-fenced" ||
          "$RESTORE_PHASE" == "finalizing-reactivation" ]]; then
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
  acquire_restore_serialization
  clear_stale_restore_lock
  release_restore_serialization
  exit 0
fi

if [[ "$PREFLIGHT" == 1 || "$PREPARE_FENCE" == 1 ]]; then
  recovery_require_restore_target_binding
  if ! recovery_require_live_runner_control_plane_matches_checkpoint \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY"; then
    printf 'The live runner control-plane identity does not match the checkpoint inventory.\n' >&2
    exit 1
  fi
  if ! recovery_require_live_images_match_checkpoint \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY"; then
    printf 'The live workload image inventory does not exactly match the checkpoint.\n' >&2
    exit 1
  fi
fi

if [[ "$PREFLIGHT" == "1" ]]; then
  recovery_require_restore_epoch_candidate \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY" "$VALUES_SOURCE_FILE"
  RESTORE_PREFLIGHT=1 "$SCRIPT_DIR/restore-retdb.sh" "$DUMP_PATH"
  RESTORE_STORAGE_PREFLIGHT=1 "$SCRIPT_DIR/restore-ret-storage.sh" "$STORAGE_PATH"
  printf 'Coordinated checkpoint preflight passed without mutation: checkpoint=%s\n' "$stamp"
  exit 0
fi

if [[ "$PREPARE_FENCE" == "1" ]]; then
  recovery_require_restore_epoch_candidate \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY" "$VALUES_SOURCE_FILE"
  RECOVERY_FENCE_PRE_EPOCH="$(recovery_live_runner_epoch)"
  [[ -n "$RECOVERY_FENCE_PRE_EPOCH" ]] || RECOVERY_FENCE_PRE_EPOCH=legacy-absent
  RECOVERY_FENCE_TARGET_EPOCH="$(recovery_runner_epoch_from_values \
    "$VALUES_SOURCE_FILE")"
  RECOVERY_OPERATION_STATE=restore-fence-prepared
  require_restore_fence_confirmation CONFIRM_PREPARE_RESTORE_FENCE prepare-fence
  RESTORE_PHASE="locking"
  recovery_require_cluster_identity
  recovery_require_pvc_identity ret-pvc
  recovery_require_restore_target_binding
  recovery_require_live_images_match_checkpoint \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY"
  acquire_restore_serialization
  recovery_require_cluster_identity
  recovery_require_pvc_identity ret-pvc
  recovery_require_restore_target_binding
  recovery_require_restore_epoch_candidate \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY" "$VALUES_SOURCE_FILE"
  recovery_require_live_runner_control_plane_matches_checkpoint \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY"
  recovery_require_live_images_match_checkpoint \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY"
  acquire_restore_lock
  prepare_restore_fence
  require_owned_restore_lock
  recovery_require_no_managed_bot_runner_pods
  RESTORE_PHASE="fence-prepared"
  release_restore_serialization
  trap - ERR
  printf 'Restore fence prepared and locked: checkpoint=%s namespace=%s lock_uid=%s operation_id=%s\n' \
    "$stamp" "$NAMESPACE" "$RESTORE_LOCK_UID" "$RESTORE_OPERATION_ID"
  printf 'Apply the standard Cloud manifest with BOT_RUNNER_RECOVERY_PHASE=restore-fence and epoch=%s, then run execute-fenced with CONFIRM_EXECUTE_RESTORE_FENCE=%q\n' \
    "$RECOVERY_FENCE_TARGET_EPOCH" \
    "$(restore_fence_confirmation_value execute-fenced)"
  exit 0
fi

if [[ "$EXECUTE_FENCED" == "1" ]]; then
  acquire_restore_serialization
  load_restore_fence_lock restore-fence-prepared
  [[ "$(recovery_runner_epoch_from_values "$VALUES_SOURCE_FILE")" == \
     "$RECOVERY_FENCE_TARGET_EPOCH" ]] || {
    printf 'VALUES_FILE no longer contains the epoch bound to the prepared fence.\n' >&2
    exit 1
  }
  recovery_require_live_restore_fence_epoch \
    "$VALUES_SOURCE_FILE" "$RECOVERY_FENCE_PRE_EPOCH"
  recovery_require_live_runner_recovery_phase restore-fence
  require_restore_fence_confirmation CONFIRM_EXECUTE_RESTORE_FENCE execute-fenced
  RESTORE_PHASE="fence-prepared"
  recovery_require_cluster_identity
  recovery_require_pvc_identity ret-pvc
  recovery_require_restore_target_binding
  require_owned_restore_lock
  if ! recovery_require_live_runner_control_plane_matches_checkpoint \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY"; then
    printf 'The live runner control plane drifted before fenced execution.\n' >&2
    exit 1
  fi
  recovery_require_live_images_match_checkpoint \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY"
  recovery_require_live_restore_fence_epoch \
    "$VALUES_SOURCE_FILE" "$RECOVERY_FENCE_PRE_EPOCH"
  capture_consumer_contracts_at_replicas 0 1
  for index in "${!CONSUMERS[@]}"; do
    recovery_wait_for_no_pods "app=${DEPLOYMENT_SELECTORS[$index]}" \
      "deployment/${CONSUMERS[$index]}" 180s
    recovery_require_consumer_contract_entry \
      "$RECOVERY_CONSUMER_CONTRACT_JSON" "${CONSUMERS[$index]}" 0 \
      "$RESTORE_OPERATION_ID"
  done
  recovery_wait_for_no_managed_bot_runner_pods 180s
  recovery_require_no_managed_bot_runner_pods
else
  if [[ "$FINALIZE_REACTIVATION" != "1" ]]; then
    printf 'A destructive restore requires RESTORE_CHECKPOINT_PREPARE_FENCE=1 first.\n' >&2
    exit 2
  fi
fi

if [[ "$FINALIZE_REACTIVATION" == "1" ]]; then
  acquire_restore_serialization
  load_restore_fence_lock restore-complete-awaiting-reactivation
  RESTORE_PHASE="finalizing-reactivation"
  capture_finalizer_failclose_contracts
  [[ "$(recovery_runner_epoch_from_values "$VALUES_SOURCE_FILE")" == \
     "$RECOVERY_FENCE_TARGET_EPOCH" ]] || {
    printf 'VALUES_FILE no longer contains the epoch bound to the completed restore.\n' >&2
    exit 1
  }
  recovery_require_live_restore_fence_epoch \
    "$VALUES_SOURCE_FILE" "$RECOVERY_FENCE_PRE_EPOCH"
  recovery_require_live_runner_recovery_phase active
  require_restore_fence_confirmation \
    CONFIRM_FINALIZE_RESTORE_REACTIVATION finalize-reactivation
  recovery_require_cluster_identity
  recovery_require_pvc_identity ret-pvc
  recovery_require_restore_target_binding
  require_owned_restore_lock
  if ! recovery_require_live_runner_control_plane_matches_checkpoint \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY"; then
    printf 'The live runner control plane drifted before finalization.\n' >&2
    exit 1
  fi
  recovery_require_live_images_match_checkpoint \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY"
  recovery_require_live_restore_fence_epoch \
    "$VALUES_SOURCE_FILE" "$RECOVERY_FENCE_PRE_EPOCH"
  for index in "${!CONSUMERS[@]}"; do
    recovery_require_consumer_contract_entry \
      "$RECOVERY_CONSUMER_CONTRACT_JSON" "${CONSUMERS[$index]}" 1 \
      "$RESTORE_OPERATION_ID"
    recovery_wait_for_deployment_rollout "${CONSUMERS[$index]}" 300
    require_owned_restore_lock
    recovery_require_deployment_contract "${CONSUMERS[$index]}" \
      "${DEPLOYMENT_UIDS[$index]}" 1 "${DEPLOYMENT_SELECTORS[$index]}" \
      "${DEPLOYMENT_FINGERPRINTS[$index]}"
  done
  require_owned_restore_lock
  VALUES_FILE="$VALUES_SOURCE_FILE" "$SCRIPT_DIR/verify-live-reactivation.sh"
  recovery_require_cluster_identity
  recovery_require_pvc_identity ret-pvc
  recovery_require_live_restore_fence_epoch \
    "$VALUES_SOURCE_FILE" "$RECOVERY_FENCE_PRE_EPOCH"
  recovery_require_live_runner_recovery_phase active
  recovery_require_live_images_match_checkpoint \
    "$RECOVERY_DEPLOYMENT_INVENTORY_COPY"
  require_owned_restore_lock
  release_restore_lock
  RESTORE_PHASE="complete"
  release_restore_serialization
  trap - ERR
  printf 'Restore reactivation finalized and its exact lock released: checkpoint=%s namespace=%s\n' \
    "$stamp" "$NAMESPACE"
  exit 0
fi

DB_CONFIRMATION="$(recovery_confirmation_value retdb)"
STORAGE_CONFIRMATION="$(recovery_confirmation_value ret-pvc "$RECOVERY_PVC_UID")"

RESTORE_PHASE="db"
recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
require_owned_restore_lock
start_runner_resume_monitor
recovery_require_operation_serialization
RESTORE_COORDINATED=1 RESTORE_ALREADY_FENCED=1 CONFIRM_RESTORE="$DB_CONFIRMATION" \
YENHUBS_PARENT_LEASE_HOLDER="$RECOVERY_SERIALIZATION_LEASE_HOLDER" \
YENHUBS_PARENT_LEASE_UID="$RECOVERY_SERIALIZATION_LEASE_UID" \
YENHUBS_PARENT_PROCESS_PID="$RECOVERY_SERIALIZATION_PARENT_PID" \
YENHUBS_PARENT_PROCESS_START_IDENTITY="$RECOVERY_SERIALIZATION_PARENT_START_IDENTITY" \
  "$SCRIPT_DIR/restore-retdb.sh" "$DUMP_PATH"
recovery_require_operation_serialization
require_runner_resume_monitor_healthy

RESTORE_PHASE="storage"
recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
require_owned_restore_lock
recovery_require_operation_serialization
RESTORE_COORDINATED=1 CONFIRM_RESTORE_STORAGE="$STORAGE_CONFIRMATION" \
YENHUBS_PARENT_LEASE_HOLDER="$RECOVERY_SERIALIZATION_LEASE_HOLDER" \
YENHUBS_PARENT_LEASE_UID="$RECOVERY_SERIALIZATION_LEASE_UID" \
YENHUBS_PARENT_PROCESS_PID="$RECOVERY_SERIALIZATION_PARENT_PID" \
YENHUBS_PARENT_PROCESS_START_IDENTITY="$RECOVERY_SERIALIZATION_PARENT_START_IDENTITY" \
  "$SCRIPT_DIR/restore-ret-storage.sh" "$STORAGE_PATH"
recovery_require_operation_serialization
require_runner_resume_monitor_healthy

RESTORE_PHASE="validating-live"
recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
recovery_require_exact_pvc_consumers ret-pvc
require_owned_restore_lock
recovery_require_no_managed_bot_runner_pods
require_runner_resume_monitor_healthy
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

RESTORE_PHASE="completing-fenced"
recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
require_owned_restore_lock
recovery_require_no_managed_bot_runner_pods
require_runner_resume_monitor_healthy
for index in "${!CONSUMERS[@]}"; do
  recovery_require_consumer_contract_entry \
    "$RECOVERY_CONSUMER_CONTRACT_JSON" "${CONSUMERS[$index]}" 0 \
    "$RESTORE_OPERATION_ID"
done
stop_runner_resume_monitor_before_parent
transition_restore_lock_state restore-fence-prepared \
  restore-complete-awaiting-reactivation
RESTORE_PHASE="awaiting-reactivation"
release_restore_serialization
trap - ERR
printf 'Coordinated checkpoint restore completed and remains fenced: checkpoint=%s namespace=%s pvc_uid=%s lock_uid=%s\n' \
  "$stamp" "$NAMESPACE" "$RECOVERY_PVC_UID" "$RESTORE_LOCK_UID"
printf 'Apply the standard Cloud manifest with BOT_RUNNER_RECOVERY_PHASE=active and epoch=%s, run the live gate, then finalize with CONFIRM_FINALIZE_RESTORE_REACTIVATION=%q\n' \
  "$RECOVERY_FENCE_TARGET_EPOCH" \
  "$(restore_fence_confirmation_value finalize-reactivation)"

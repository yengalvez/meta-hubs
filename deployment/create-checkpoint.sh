#!/usr/bin/env bash

# Create one locally generated point-in-time checkpoint. The five application
# writers are held at zero under a global immutable operation lock while both
# PostgreSQL and ret-pvc are captured. Publication uses an exclusive final
# directory claim plus an incomplete marker removed only after full rehashing.

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VALUES_INPUT_FILE="${VALUES_FILE:-$SCRIPT_DIR/input-values.local.yaml}"
MANIFEST_INPUT_FILE="${HCCE_MANIFEST_PATH:-$ROOT_DIR/hubs-cloud/community-edition/hcce.yaml}"
VALUES_SOURCE_FILE=""
TIMESTAMP="$(date '+%Y%m%d-%H%M%S')"
FINAL_OUTPUT_DIR="${1:-$ROOT_DIR/output/checkpoints/$TIMESTAMP}"
OUTPUT_PARENT="$(dirname "$FINAL_OUTPUT_DIR")"
NAMESPACE="${NAMESPACE:-hcce}"
ALLOW_DOWNTIME="${ALLOW_CHECKPOINT_DOWNTIME:-0}"
# shellcheck source=deployment/lib/recovery-safety.sh
source "$SCRIPT_DIR/lib/recovery-safety.sh"

[[ "$ALLOW_DOWNTIME" == 1 ]] || {
  printf 'Checkpoint creation causes a coordinated workload pause; set ALLOW_CHECKPOINT_DOWNTIME=1.\n' >&2
  exit 2
}
[[ ! -e "$FINAL_OUTPUT_DIR" && ! -L "$FINAL_OUTPUT_DIR" ]] || {
  printf 'Refusing same-second or existing checkpoint directory: %s\n' "$FINAL_OUTPUT_DIR" >&2
  exit 1
}
if recovery_path_has_symlink_component "$OUTPUT_PARENT"; then
  printf 'Checkpoint parent may not contain symlink components.\n' >&2
  exit 1
fi
mkdir -p "$OUTPUT_PARENT"
if recovery_path_has_symlink_component "$OUTPUT_PARENT"; then
  printf 'Checkpoint parent changed to a linked path while it was created.\n' >&2
  exit 1
fi
OUTPUT_PARENT="$(cd "$OUTPUT_PARENT" && pwd -P)"
FINAL_OUTPUT_DIR="$OUTPUT_PARENT/$(basename "$FINAL_OUTPUT_DIR")"
PUBLISH_LOCK="${FINAL_OUTPUT_DIR}.yenhubs-publish-lock"

CONSUMERS=(reticulum pgbouncer pgbouncer-t bot-orchestrator coturn)
DEPLOYMENT_UIDS=()
DEPLOYMENT_RESOURCE_VERSIONS=()
ORIGINAL_REPLICAS=()
DEPLOYMENT_SELECTORS=()
DEPLOYMENT_FINGERPRINTS=()
RECOVERY_CONSUMER_CONTRACT_JSON=""
OUTPUT_DIR=""
CHECKPOINT_STAGING_OWNED=0
PUBLISH_LOCK_OWNED=0
FINAL_CLAIM_OWNED=0
FINAL_INCOMPLETE_MARKER=""
OPERATION_LOCK_OWNED=0
SERIALIZATION_LEASE_OWNED=0
WRITERS_MUTATED=0
RUNNER_MONITOR_STOP=""
RUNNER_MONITOR_FAILURE=""
RUNNER_MONITOR_READY=""
RUNNER_MONITOR_PID=""
CHECKPOINT_RUNNER_MODE=""
CHECKPOINT_VALUES_SNAPSHOT=""
CHECKPOINT_MANIFEST_SNAPSHOT=""

snapshot_checkpoint_private_file() {
  local destination_variable="$1" source_path="$2" label="$3"
  local snapshot_path=""
  [[ -n "$destination_variable" && -n "$label" ]] || return 2
  snapshot_path="$(mktemp "${TMPDIR:-/tmp}/yenhubs-checkpoint-$label.XXXXXX")" || return 1
  snapshot_path="$(cd "$(dirname "$snapshot_path")" && pwd -P)/$(basename "$snapshot_path")"
  if ! command node "$SCRIPT_DIR/snapshot-private-file.mjs" \
    "$source_path" "$snapshot_path"; then
    rm -f -- "$snapshot_path"
    printf 'Could not bind a private immutable checkpoint %s snapshot.\n' \
      "$label" >&2
    return 1
  fi
  printf -v "$destination_variable" '%s' "$snapshot_path"
}

cleanup_runner_monitor() {
  if [[ -n "$RUNNER_MONITOR_PID" ]]; then
    recovery_discard_no_managed_bot_runner_watch \
      "$RUNNER_MONITOR_STOP" "$RUNNER_MONITOR_PID"
    RUNNER_MONITOR_PID=""
  fi
  [[ -z "$RUNNER_MONITOR_STOP" ]] || rm -f -- "$RUNNER_MONITOR_STOP"
  [[ -z "$RUNNER_MONITOR_FAILURE" ]] || rm -f -- "$RUNNER_MONITOR_FAILURE"
  [[ -z "$RUNNER_MONITOR_READY" ]] || rm -f -- "$RUNNER_MONITOR_READY"
  RUNNER_MONITOR_STOP=""
  RUNNER_MONITOR_FAILURE=""
  RUNNER_MONITOR_READY=""
}

start_runner_monitor() {
  recovery_require_no_managed_bot_runner_pods || return 1
  RUNNER_MONITOR_STOP="$(mktemp "${TMPDIR:-/tmp}/yenhubs-checkpoint-runner-stop.XXXXXX")" || return 1
  RUNNER_MONITOR_FAILURE="$(mktemp "${TMPDIR:-/tmp}/yenhubs-checkpoint-runner-failure.XXXXXX")" || {
    cleanup_runner_monitor
    return 1
  }
  RUNNER_MONITOR_READY="$(mktemp "${TMPDIR:-/tmp}/yenhubs-checkpoint-runner-ready.XXXXXX")" || {
    cleanup_runner_monitor
    return 1
  }
  chmod 600 "$RUNNER_MONITOR_STOP" "$RUNNER_MONITOR_FAILURE" "$RUNNER_MONITOR_READY"
  if ! recovery_start_no_managed_bot_runner_watch \
    "$RUNNER_MONITOR_STOP" "$RUNNER_MONITOR_FAILURE" "$RUNNER_MONITOR_READY" \
    RUNNER_MONITOR_PID; then
    cleanup_runner_monitor
    return 1
  fi
}

stop_runner_monitor_before_resume() {
  local monitor_status=0
  if [[ -n "$RUNNER_MONITOR_PID" ]]; then
    if ! recovery_stop_no_managed_bot_runner_watch \
      "$RUNNER_MONITOR_STOP" "$RUNNER_MONITOR_FAILURE" "$RUNNER_MONITOR_READY" \
      "$RUNNER_MONITOR_PID"; then
      monitor_status=1
    fi
    RUNNER_MONITOR_PID=""
  else
    monitor_status=1
  fi
  [[ -z "$RUNNER_MONITOR_STOP" ]] || rm -f -- "$RUNNER_MONITOR_STOP"
  [[ -z "$RUNNER_MONITOR_FAILURE" ]] || rm -f -- "$RUNNER_MONITOR_FAILURE"
  [[ -z "$RUNNER_MONITOR_READY" ]] || rm -f -- "$RUNNER_MONITOR_READY"
  RUNNER_MONITOR_STOP=""
  RUNNER_MONITOR_FAILURE=""
  RUNNER_MONITOR_READY=""
  if [[ "$monitor_status" != 0 ]]; then
    printf 'Managed bot-runner quiescence monitoring failed; refusing writer resume.\n' >&2
    return 1
  fi
}

handoff_runner_monitor() {
  local old_stop="$RUNNER_MONITOR_STOP" old_failure="$RUNNER_MONITOR_FAILURE"
  local old_ready="$RUNNER_MONITOR_READY" old_pid="$RUNNER_MONITOR_PID"
  local new_stop="" new_failure="" new_ready="" new_pid=""
  [[ "$old_pid" =~ ^[1-9][0-9]*$ ]] || return 1
  new_stop="$(mktemp "${TMPDIR:-/tmp}/yenhubs-checkpoint-runner-stop.XXXXXX")" || return 1
  new_failure="$(mktemp "${TMPDIR:-/tmp}/yenhubs-checkpoint-runner-failure.XXXXXX")" || {
    rm -f -- "$new_stop"
    return 1
  }
  new_ready="$(mktemp "${TMPDIR:-/tmp}/yenhubs-checkpoint-runner-ready.XXXXXX")" || {
    rm -f -- "$new_stop" "$new_failure"
    return 1
  }
  chmod 600 "$new_stop" "$new_failure" "$new_ready"
  if ! recovery_start_no_managed_bot_runner_watch \
    "$new_stop" "$new_failure" "$new_ready" new_pid; then
    recovery_discard_no_managed_bot_runner_watch "$new_stop" "$new_pid"
    rm -f -- "$new_stop" "$new_failure" "$new_ready"
    return 1
  fi
  # The new LIST+resourceVersion watches are ready before the previous watcher
  # is joined, so no transient ADDED+DELETED event can fall into a handoff gap.
  if ! recovery_stop_no_managed_bot_runner_watch \
    "$old_stop" "$old_failure" "$old_ready" "$old_pid"; then
    recovery_discard_no_managed_bot_runner_watch "$new_stop" "$new_pid"
    rm -f -- "$old_stop" "$old_failure" "$old_ready" \
      "$new_stop" "$new_failure" "$new_ready"
    RUNNER_MONITOR_STOP=""
    RUNNER_MONITOR_FAILURE=""
    RUNNER_MONITOR_READY=""
    RUNNER_MONITOR_PID=""
    printf 'Managed bot-runner quiescence monitoring failed before checkpoint publication.\n' >&2
    return 1
  fi
  rm -f -- "$old_stop" "$old_failure" "$old_ready"
  RUNNER_MONITOR_STOP="$new_stop"
  RUNNER_MONITOR_FAILURE="$new_failure"
  RUNNER_MONITOR_READY="$new_ready"
  RUNNER_MONITOR_PID="$new_pid"
}

cleanup_local_artifacts() {
  local marker_value="" snapshot_path
  cleanup_runner_monitor
  for snapshot_path in \
    "$CHECKPOINT_VALUES_SNAPSHOT" "$CHECKPOINT_MANIFEST_SNAPSHOT"; do
    [[ -z "$snapshot_path" ]] || rm -f -- "$snapshot_path"
  done
  CHECKPOINT_VALUES_SNAPSHOT=""
  CHECKPOINT_MANIFEST_SNAPSHOT=""
  VALUES_SOURCE_FILE=""
  if [[ "$CHECKPOINT_STAGING_OWNED" == 1 && -n "$OUTPUT_DIR" &&
        -d "$OUTPUT_DIR" && ! -L "$OUTPUT_DIR" &&
        "$(dirname "$OUTPUT_DIR")" == "$OUTPUT_PARENT" &&
        "$(basename "$OUTPUT_DIR")" =~ ^\.yenhubs-checkpoint-[0-9]{8}-[0-9]{6}\.[A-Za-z0-9]{6}$ ]]; then
    rm -rf -- "$OUTPUT_DIR"
  fi
  if [[ "$FINAL_CLAIM_OWNED" == 1 && -n "$FINAL_INCOMPLETE_MARKER" &&
        "$FINAL_INCOMPLETE_MARKER" == "$FINAL_OUTPUT_DIR/.yenhubs-incomplete" &&
        -f "$FINAL_INCOMPLETE_MARKER" && ! -L "$FINAL_INCOMPLETE_MARKER" ]]; then
    marker_value="$(<"$FINAL_INCOMPLETE_MARKER")"
    if [[ "$marker_value" == "yenhubs-incomplete:$RECOVERY_OPERATION_ID" ]]; then
      rm -rf -- "$FINAL_OUTPUT_DIR"
    fi
  fi
  if [[ "$PUBLISH_LOCK_OWNED" == 1 && -d "$PUBLISH_LOCK" && ! -L "$PUBLISH_LOCK" ]]; then
    rmdir "$PUBLISH_LOCK" 2>/dev/null || :
  fi
  CHECKPOINT_STAGING_OWNED=0
  FINAL_CLAIM_OWNED=0
  PUBLISH_LOCK_OWNED=0
  if [[ "$SERIALIZATION_LEASE_OWNED" == 1 ]]; then
    if recovery_release_operation_serialization; then
      SERIALIZATION_LEASE_OWNED=0
    else
      printf 'Checkpoint serialization Lease could not be released safely.\n' >&2
    fi
  fi
}

release_serialization_if_owned() {
  [[ "$SERIALIZATION_LEASE_OWNED" == 1 ]] || return 0
  recovery_release_operation_serialization || return 1
  SERIALIZATION_LEASE_OWNED=0
}

capture_consumer_contracts() {
  local deployment contract uid resource_version replicas selector fingerprint
  local consumers_json='[]'
  for deployment in "${CONSUMERS[@]}"; do
    contract="$(recovery_capture_deployment_contract "$deployment")" || return 1
    IFS=$'\t' read -r uid resource_version replicas selector fingerprint <<<"$contract"
    [[ "$replicas" =~ ^[0-9]+$ && "$replicas" -gt 0 ]] || {
      printf 'Every checkpoint writer must be running before capture: %s.\n' "$deployment" >&2
      return 1
    }
    DEPLOYMENT_UIDS+=("$uid")
    DEPLOYMENT_RESOURCE_VERSIONS+=("$resource_version")
    ORIGINAL_REPLICAS+=("$replicas")
    DEPLOYMENT_SELECTORS+=("$selector")
    DEPLOYMENT_FINGERPRINTS+=("$fingerprint")
    consumers_json="$(jq -cn --argjson current "$consumers_json" \
      --arg name "$deployment" --arg uid "$uid" \
      --arg resource_version "$resource_version" --argjson replicas "$replicas" \
      --arg selector "$selector" --arg fingerprint "$fingerprint" \
      '$current + [{name:$name,uid:$uid,initial_resource_version:$resource_version,
        original_replicas:$replicas,selector:$selector,fingerprint:$fingerprint}]')"
  done
  RECOVERY_CONSUMER_CONTRACT_JSON="$(jq -cn \
    --arg operation_id "$RECOVERY_OPERATION_ID" --argjson consumers "$consumers_json" \
    '{schema_version:1,operation_id:$operation_id,consumers:$consumers}')"
  recovery_consumer_contract_is_acceptable "$RECOVERY_CONSUMER_CONTRACT_JSON" || return 1
  export RECOVERY_CONSUMER_CONTRACT_JSON
}

require_checkpoint_runner_absence_stable() {
  local stable_seconds started
  stable_seconds="$(recovery_stable_absence_seconds)" || return 1
  started="$SECONDS"
  while :; do
    recovery_require_operation_lock || return 1
    recovery_require_no_managed_bot_runner_watch_healthy \
      "$RUNNER_MONITOR_FAILURE" "$RUNNER_MONITOR_READY" \
      "$RUNNER_MONITOR_PID" || return 1
    recovery_require_no_managed_bot_runner_pods || return 1
    ((SECONDS - started >= stable_seconds)) && return 0
    sleep 1
  done
}

require_checkpoint_post_watch_absence_stable() {
  local stable_seconds started
  stable_seconds="$(recovery_stable_absence_seconds)" || return 1
  started="$SECONDS"
  while :; do
    recovery_require_operation_lock || return 1
    recovery_require_consumer_contract_entry "$RECOVERY_CONSUMER_CONTRACT_JSON" \
      bot-orchestrator 0 || return 1
    recovery_require_no_managed_bot_runner_pods || return 1
    ((SECONDS - started >= stable_seconds)) && return 0
    sleep 1
  done
}

quiesce_writers() {
  local index
  local -a remaining_order=(0 1 2 4)
  WRITERS_MUTATED=1
  # Revoke the token-bearing parent first, wait for its Pod to disappear, then
  # UID-delete all already-issued runner Pods. The continuous watcher and a
  # 61-second stable-absence window outlive every projected parent token.
  index=3
  DEPLOYMENT_RESOURCE_VERSIONS[index]="$(recovery_scale_deployment_exact \
    "${CONSUMERS[$index]}" "${DEPLOYMENT_UIDS[$index]}" \
    "${DEPLOYMENT_RESOURCE_VERSIONS[$index]}" "${ORIGINAL_REPLICAS[$index]}" 0 \
    "${DEPLOYMENT_SELECTORS[$index]}" "${DEPLOYMENT_FINGERPRINTS[$index]}")" || return 1
  recovery_wait_for_no_pods "app=${DEPLOYMENT_SELECTORS[$index]}" \
    "deployment/${CONSUMERS[$index]}" 180s || return 1
  recovery_require_consumer_contract_entry "$RECOVERY_CONSUMER_CONTRACT_JSON" \
    "${CONSUMERS[$index]}" 0 || return 1
  recovery_delete_all_managed_bot_runner_pods_exact || return 1
  recovery_wait_for_no_managed_bot_runner_pods 180s || return 1
  start_runner_monitor
  require_checkpoint_runner_absence_stable || return 1

  for index in "${remaining_order[@]}"; do
    DEPLOYMENT_RESOURCE_VERSIONS[index]="$(recovery_scale_deployment_exact \
      "${CONSUMERS[$index]}" "${DEPLOYMENT_UIDS[$index]}" \
      "${DEPLOYMENT_RESOURCE_VERSIONS[$index]}" "${ORIGINAL_REPLICAS[$index]}" 0 \
      "${DEPLOYMENT_SELECTORS[$index]}" "${DEPLOYMENT_FINGERPRINTS[$index]}")" || return 1
  done
  for index in "${!CONSUMERS[@]}"; do
    recovery_require_operation_lock || return 1
    recovery_wait_for_no_pods "app=${DEPLOYMENT_SELECTORS[$index]}" \
      "deployment/${CONSUMERS[$index]}" 180s || return 1
    recovery_require_consumer_contract_entry "$RECOVERY_CONSUMER_CONTRACT_JSON" \
      "${CONSUMERS[$index]}" 0 || return 1
  done
  recovery_require_no_managed_bot_runner_pods || return 1
  recovery_require_exact_pvc_consumers ret-pvc || return 1
}

prepare_runner_monitor_for_resume() {
  local index contract uid resource_version replicas selector fingerprint
  if [[ -n "$RUNNER_MONITOR_PID" ]]; then
    recovery_require_no_managed_bot_runner_watch_healthy \
      "$RUNNER_MONITOR_FAILURE" "$RUNNER_MONITOR_READY" \
      "$RUNNER_MONITOR_PID"
    return
  fi

  # A scale may have reached the API server even when its postcondition read
  # failed before the normal watcher started. Reconstruct a safe monitored
  # boundary from the captured parent contract instead of making automatic
  # resume impossible solely because the watcher was not yet created.
  recovery_require_checkpoint_runner_mode_exact \
    "$VALUES_SOURCE_FILE" "$CHECKPOINT_RUNNER_MODE" >/dev/null || return 1
  contract="$(recovery_capture_deployment_contract bot-orchestrator)" || return 1
  IFS=$'\t' read -r uid resource_version replicas selector fingerprint <<<"$contract"
  index=3
  [[ "$uid" == "${DEPLOYMENT_UIDS[$index]}" &&
     "$selector" == "${DEPLOYMENT_SELECTORS[$index]}" &&
     "$fingerprint" == "${DEPLOYMENT_FINGERPRINTS[$index]}" ]] || return 1
  if [[ "$replicas" == "${ORIGINAL_REPLICAS[$index]}" ]]; then
    # No checkpoint writer after the parent can have been scaled before the
    # watcher starts. If every captured writer is still exact, there is no
    # downtime mutation to recover.
    for index in "${!CONSUMERS[@]}"; do
      recovery_require_deployment_contract "${CONSUMERS[$index]}" \
        "${DEPLOYMENT_UIDS[$index]}" "${ORIGINAL_REPLICAS[$index]}" \
        "${DEPLOYMENT_SELECTORS[$index]}" \
        "${DEPLOYMENT_FINGERPRINTS[$index]}" || return 1
    done
    WRITERS_MUTATED=0
    return 0
  fi
  [[ "$replicas" == 0 ]] || {
    printf 'Bot parent replica state is unsafe for monitored checkpoint resume.\n' >&2
    return 1
  }
  recovery_require_consumer_contract_entry \
    "$RECOVERY_CONSUMER_CONTRACT_JSON" bot-orchestrator 0 || return 1
  recovery_delete_all_managed_bot_runner_pods_exact || return 1
  recovery_wait_for_no_managed_bot_runner_pods 180s || return 1
  start_runner_monitor || return 1
  require_checkpoint_runner_absence_stable || return 1
}

resume_writers() {
  local index deployment contract uid resource_version replicas selector fingerprint
  local -a order=(1 2 0 4 3)
  recovery_require_operation_lock || return 1
  # Classify mode drift before monitor reconstruction derives the runner
  # namespaces. A partial isolated-runner binding must retain the exact
  # semantic failure even when the synchronous guard and watcher race.
  recovery_require_checkpoint_runner_mode_exact \
    "$VALUES_SOURCE_FILE" "$CHECKPOINT_RUNNER_MODE" >/dev/null || return 1
  prepare_runner_monitor_for_resume || return 1
  [[ "$WRITERS_MUTATED" == 1 ]] || return 0
  recovery_require_no_managed_bot_runner_watch_healthy \
    "$RUNNER_MONITOR_FAILURE" "$RUNNER_MONITOR_READY" "$RUNNER_MONITOR_PID" || return 1
  recovery_require_checkpoint_runner_mode_exact \
    "$VALUES_SOURCE_FILE" "$CHECKPOINT_RUNNER_MODE" >/dev/null || return 1
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  for index in "${!CONSUMERS[@]}"; do
    deployment="${CONSUMERS[$index]}"
    contract="$(recovery_capture_deployment_contract "$deployment")" || return 1
    IFS=$'\t' read -r uid resource_version replicas selector fingerprint <<<"$contract"
    [[ "$uid" == "${DEPLOYMENT_UIDS[$index]}" &&
       "$selector" == "${DEPLOYMENT_SELECTORS[$index]}" &&
       "$fingerprint" == "${DEPLOYMENT_FINGERPRINTS[$index]}" ]] || return 1
    if [[ "$replicas" == 0 ]]; then
      DEPLOYMENT_RESOURCE_VERSIONS[index]="$resource_version"
    elif [[ "$replicas" == "${ORIGINAL_REPLICAS[$index]}" ]]; then
      DEPLOYMENT_RESOURCE_VERSIONS[index]="$resource_version"
    else
      printf 'Writer replica state is not recoverable under the captured contract: %s.\n' \
        "$deployment" >&2
      return 1
    fi
  done
  for index in "${order[@]}"; do
    deployment="${CONSUMERS[$index]}"
    if [[ "$deployment" == bot-orchestrator ]]; then
      # Re-check before any helper derives runner namespaces. The later gate
      # remains intentionally adjacent to restoring parent authority and
      # closes drift across the post-watch stable-absence window.
      recovery_require_checkpoint_runner_mode_exact \
        "$VALUES_SOURCE_FILE" "$CHECKPOINT_RUNNER_MODE" >/dev/null || return 1
      recovery_require_no_managed_bot_runner_watch_healthy \
        "$RUNNER_MONITOR_FAILURE" "$RUNNER_MONITOR_READY" \
        "$RUNNER_MONITOR_PID" || return 1
      recovery_require_no_managed_bot_runner_pods || return 1
      stop_runner_monitor_before_resume || return 1
      require_checkpoint_post_watch_absence_stable || return 1
      # This second exact Cloud gate is adjacent to restoring token-bearing
      # parent authority. It closes drift after the initial resume gate while
      # the other four consumers were restarted.
      recovery_require_checkpoint_runner_mode_exact \
        "$VALUES_SOURCE_FILE" "$CHECKPOINT_RUNNER_MODE" >/dev/null || return 1
      recovery_require_operation_serialization || return 1
      recovery_require_operation_lock || return 1
      recovery_require_consumer_contract_entry \
        "$RECOVERY_CONSUMER_CONTRACT_JSON" bot-orchestrator 0 || return 1
      recovery_require_no_managed_bot_runner_pods || return 1
    else
      recovery_require_no_managed_bot_runner_watch_healthy \
        "$RUNNER_MONITOR_FAILURE" "$RUNNER_MONITOR_READY" \
        "$RUNNER_MONITOR_PID" || return 1
    fi
    contract="$(recovery_capture_deployment_contract "$deployment")" || return 1
    IFS=$'\t' read -r uid resource_version replicas selector fingerprint <<<"$contract"
    if [[ "$replicas" == 0 ]]; then
      DEPLOYMENT_RESOURCE_VERSIONS[index]="$(recovery_scale_deployment_exact \
        "$deployment" "$uid" "$resource_version" 0 "${ORIGINAL_REPLICAS[$index]}" \
        "$selector" "$fingerprint")" || return 1
      recovery_wait_for_deployment_rollout "$deployment" 300 || return 1
    fi
    recovery_require_operation_lock || return 1
    recovery_require_deployment_contract "$deployment" "${DEPLOYMENT_UIDS[$index]}" \
      "${ORIGINAL_REPLICAS[$index]}" "${DEPLOYMENT_SELECTORS[$index]}" \
      "${DEPLOYMENT_FINGERPRINTS[$index]}" || return 1
  done
  WRITERS_MUTATED=0
}

release_lock_if_safe() {
  [[ "$OPERATION_LOCK_OWNED" == 1 ]] || return 0
  recovery_release_operation_lock || return 1
  OPERATION_LOCK_OWNED=0
}

checkpoint_error() {
  local status="$?"
  # errtrace also copies ERR into command substitutions and background
  # subshells. Those processes have only stale copies of ownership variables;
  # they must report failure to the main shell, never resume writers or delete
  # a shared lock on its behalf.
  if ((BASH_SUBSHELL > 0)); then
    return "$status"
  fi
  trap - ERR
  if [[ "$WRITERS_MUTATED" == 1 ]]; then
    if resume_writers; then
      printf 'Checkpoint failed, but every writer was restored to its exact pre-snapshot scale.\n' >&2
    else
      printf 'Checkpoint failed and exact automatic resume was impossible; the global lock is retained.\n' >&2
      return "$status"
    fi
  fi
  if [[ "$OPERATION_LOCK_OWNED" == 1 ]] && ! release_lock_if_safe; then
    printf 'Checkpoint operation lock could not be released safely.\n' >&2
  fi
  return "$status"
}

checkpoint_interrupted() {
  local status="$1"
  trap - EXIT ERR INT TERM
  if [[ "$WRITERS_MUTATED" == 1 ]]; then
    resume_writers || printf 'Interrupted checkpoint retained its lock for manual recovery.\n' >&2
  fi
  if [[ "$WRITERS_MUTATED" == 0 && "$OPERATION_LOCK_OWNED" == 1 ]]; then
    release_lock_if_safe || :
  fi
  cleanup_local_artifacts
  exit "$status"
}

trap cleanup_local_artifacts EXIT
trap checkpoint_error ERR
trap 'checkpoint_interrupted 130' INT
trap 'checkpoint_interrupted 143' TERM

if ! mkdir "$PUBLISH_LOCK"; then
  printf 'Another checkpoint publication owns this exact destination.\n' >&2
  exit 1
fi
PUBLISH_LOCK_OWNED=1
chmod 700 "$PUBLISH_LOCK"
OUTPUT_DIR="$(mktemp -d "$OUTPUT_PARENT/.yenhubs-checkpoint-$TIMESTAMP.XXXXXX")"
CHECKPOINT_STAGING_OWNED=1
chmod 700 "$OUTPUT_DIR"

# Bind the local authorization input once. The source may be prepared for a
# future rotation while the checkpoint runs, but every gate in this operation
# must keep using the same private bytes selected before any downtime.
snapshot_checkpoint_private_file \
  CHECKPOINT_VALUES_SNAPSHOT "$VALUES_INPUT_FILE" values
VALUES_SOURCE_FILE="$CHECKPOINT_VALUES_SNAPSHOT"
command node "$SCRIPT_DIR/parse-local-values.mjs" "$VALUES_SOURCE_FILE" --validate

recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
RECOVERY_CHECKPOINT_STAMP="$TIMESTAMP"
RECOVERY_DUMP_SHA256="$(printf '0%.0s' {1..64})"
RECOVERY_STORAGE_SHA256="$RECOVERY_DUMP_SHA256"
recovery_acquire_operation_serialization root-recovery
SERIALIZATION_LEASE_OWNED=1
recovery_require_operation_serialization
recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
recovery_acquire_operation_lock checkpoint-backup yenhubs-recovery-operation-lock
OPERATION_LOCK_OWNED=1
recovery_require_operation_serialization
# Coordinated backup children revalidate these exported bindings against the
# immutable lock. They are data-only identifiers, not local cleanup
# capabilities; materialized paths are never inherited.
export RECOVERY_CHECKPOINT_STAMP RECOVERY_DUMP_SHA256 RECOVERY_STORAGE_SHA256 \
  RECOVERY_NAMESPACE_UID RECOVERY_PVC_UID
capture_consumer_contracts

# Fail before the first downtime mutation unless the live runtime is either
# the exact accepted process-local checkpoint boundary or the exact generated
# active isolated-runner control plane. Partial transitions never fall back.
# The generated manifest is needed only after isolated runners are active; the
# historical process-local checkpoint remains independent of an unbuilt
# candidate manifest.
checkpoint_runner_candidate="$(recovery_checkpoint_runner_mode_candidate)"
if [[ "$checkpoint_runner_candidate" == kubernetes-pod ]]; then
  snapshot_checkpoint_private_file \
    CHECKPOINT_MANIFEST_SNAPSHOT "$MANIFEST_INPUT_FILE" manifest
  HCCE_MANIFEST_PATH="$CHECKPOINT_MANIFEST_SNAPSHOT"
elif [[ "$checkpoint_runner_candidate" != process-local ]]; then
  printf 'The checkpoint runner mode candidate is invalid.\n' >&2
  exit 1
fi
CHECKPOINT_RUNNER_MODE="$(
  recovery_require_checkpoint_runner_mode_exact "$VALUES_SOURCE_FILE"
)"
[[ "$CHECKPOINT_RUNNER_MODE" == "$checkpoint_runner_candidate" ]] || {
  printf 'Checkpoint runner mode changed while binding immutable local inputs.\n' >&2
  exit 1
}
recovery_require_operation_serialization
recovery_require_operation_lock
recovery_stable_absence_seconds >/dev/null

# Capture the exact live image/infrastructure inventory while the deployments
# still have their pre-downtime scale, then prove those immutable contracts
# again as each writer is stopped.
VALUES_FILE="$VALUES_SOURCE_FILE" \
  "$SCRIPT_DIR/capture-instance-state.sh" "$OUTPUT_DIR"
captured_runner_mode="$(jq -er '.bot_runner_runtime.mode' \
  "$OUTPUT_DIR/deployment-images.json")"
[[ "$captured_runner_mode" == "$CHECKPOINT_RUNNER_MODE" ]] || {
  printf 'Captured runner mode does not match the pre-downtime authorization.\n' >&2
  exit 1
}

QUIESCE_STARTED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
jq -n \
  --arg stamp "$TIMESTAMP" \
  --arg created_at_utc "$QUIESCE_STARTED_AT" \
  --argjson created_at_epoch "$(date -u '+%s')" \
  --arg kube_context "$EXPECTED_KUBE_CONTEXT" \
  --arg namespace "$NAMESPACE" \
  --arg namespace_uid "$RECOVERY_NAMESPACE_UID" \
  --arg pvc_uid "$RECOVERY_PVC_UID" \
  --arg operation_id "$RECOVERY_OPERATION_ID" '
  {
    schema_version:2,
    provenance:{generator:"yenhubs-local-coordinated-checkpoint-v2",external_import:false},
    stamp:$stamp,created_at_utc:$created_at_utc,created_at_epoch:$created_at_epoch,
    kube_context:$kube_context,namespace:$namespace,namespace_uid:$namespace_uid,
    ret_pvc_uid:$pvc_uid,operation_id:$operation_id,
    writer_quiescence:{required:true,started_at_utc:$created_at_utc}
  }' >"$OUTPUT_DIR/checkpoint-metadata.json"
chmod 600 "$OUTPUT_DIR/checkpoint-metadata.json"

quiesce_writers
recovery_require_operation_serialization
BACKUP_COORDINATED=1 \
YENHUBS_PARENT_LEASE_HOLDER="$RECOVERY_SERIALIZATION_LEASE_HOLDER" \
YENHUBS_PARENT_LEASE_UID="$RECOVERY_SERIALIZATION_LEASE_UID" \
YENHUBS_PARENT_PROCESS_PID="$RECOVERY_SERIALIZATION_PARENT_PID" \
YENHUBS_PARENT_PROCESS_START_IDENTITY="$RECOVERY_SERIALIZATION_PARENT_START_IDENTITY" \
  "$SCRIPT_DIR/backup-retdb.sh" \
  "$OUTPUT_DIR/retdb-$TIMESTAMP.sql.gz"
recovery_require_operation_serialization
YENHUBS_PARENT_LEASE_HOLDER="$RECOVERY_SERIALIZATION_LEASE_HOLDER" \
YENHUBS_PARENT_LEASE_UID="$RECOVERY_SERIALIZATION_LEASE_UID" \
YENHUBS_PARENT_PROCESS_PID="$RECOVERY_SERIALIZATION_PARENT_PID" \
YENHUBS_PARENT_PROCESS_START_IDENTITY="$RECOVERY_SERIALIZATION_PARENT_START_IDENTITY" \
  "$SCRIPT_DIR/backup-ret-storage-quiesced.sh" \
  "$OUTPUT_DIR/ret-storage-$TIMESTAMP.tar.gz" \
  "$OUTPUT_DIR/deployment-images.json"
recovery_require_operation_serialization
# Join the watcher that covered every backup byte before recording successful
# quiescence. A replacement watch is already ready, so publication remains
# continuously fenced without a LIST/watch gap.
handoff_runner_monitor
SNAPSHOT_COMPLETED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
metadata_tmp="$(mktemp "$OUTPUT_DIR/.checkpoint-metadata.XXXXXX")"
jq --arg completed "$SNAPSHOT_COMPLETED_AT" \
  '.writer_quiescence.completed_at_utc = $completed' \
  "$OUTPUT_DIR/checkpoint-metadata.json" >"$metadata_tmp"
mv "$metadata_tmp" "$OUTPUT_DIR/checkpoint-metadata.json"
chmod 600 "$OUTPUT_DIR/checkpoint-metadata.json"

"$SCRIPT_DIR/validate-checkpoint.sh" \
  "$OUTPUT_DIR/retdb-$TIMESTAMP.sql.gz" \
  "$OUTPUT_DIR/ret-storage-$TIMESTAMP.tar.gz"

CHECKSUM_TMP="$(mktemp "$OUTPUT_DIR/.yenhubs-checksums.XXXXXX")"
while IFS= read -r artifact; do
  digest="$(recovery_sha256_digest "$OUTPUT_DIR/$artifact")"
  printf '%s  %s\n' "$digest" "$artifact"
done < <(recovery_checkpoint_artifacts "$TIMESTAMP") >"$CHECKSUM_TMP"
mv "$CHECKSUM_TMP" "$OUTPUT_DIR/SHA256SUMS"
chmod 600 "$OUTPUT_DIR/SHA256SUMS"
recovery_verify_checkpoint_directory "$OUTPUT_DIR" "$TIMESTAMP"

# Atomic no-clobber claim. Until the marker is removed, the exact-layout gate
# rejects the visible directory. Every byte is rehashed in the claimed path
# before that single validity marker disappears.
mkdir "$FINAL_OUTPUT_DIR"
FINAL_CLAIM_OWNED=1
chmod 700 "$FINAL_OUTPUT_DIR"
FINAL_INCOMPLETE_MARKER="$FINAL_OUTPUT_DIR/.yenhubs-incomplete"
printf 'yenhubs-incomplete:%s\n' "$RECOVERY_OPERATION_ID" >"$FINAL_INCOMPLETE_MARKER"
chmod 600 "$FINAL_INCOMPLETE_MARKER"
while IFS= read -r artifact; do
  mv "$OUTPUT_DIR/$artifact" "$FINAL_OUTPUT_DIR/$artifact"
done < <({ recovery_checkpoint_artifacts "$TIMESTAMP"; printf 'SHA256SUMS\n'; } | LC_ALL=C sort)
recovery_validate_sha256_manifest "$FINAL_OUTPUT_DIR" "$TIMESTAMP"
actual_with_marker="$(find "$FINAL_OUTPUT_DIR" -mindepth 1 -maxdepth 1 -print |
  while IFS= read -r path; do basename "$path"; done | LC_ALL=C sort)"
expected_with_marker="$({ recovery_checkpoint_artifacts "$TIMESTAMP"; printf '%s\n' SHA256SUMS .yenhubs-incomplete; } | LC_ALL=C sort)"
[[ "$actual_with_marker" == "$expected_with_marker" ]]
# The second watcher covers validation and the visible incomplete claim. Join
# it before removing the marker, with a third watcher already covering the
# publication-to-parent-resume interval.
handoff_runner_monitor
rm -f -- "$FINAL_INCOMPLETE_MARKER"
FINAL_CLAIM_OWNED=0
FINAL_INCOMPLETE_MARKER=""
recovery_verify_checkpoint_directory "$FINAL_OUTPUT_DIR" "$TIMESTAMP"
rmdir "$OUTPUT_DIR"
CHECKPOINT_STAGING_OWNED=0
OUTPUT_DIR=""

resume_writers
release_lock_if_safe
release_serialization_if_owned
cleanup_local_artifacts
trap - EXIT ERR INT TERM

printf 'Complete quiescent YenHubs checkpoint published: %s (writers resumed)\n' \
  "$FINAL_OUTPUT_DIR"

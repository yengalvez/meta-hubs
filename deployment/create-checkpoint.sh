#!/usr/bin/env bash

# Create one locally generated point-in-time checkpoint. The five application
# writers are held at zero under a global immutable operation lock while both
# PostgreSQL and ret-pvc are captured. Publication uses an exclusive final
# directory claim plus an incomplete marker removed only after full rehashing.

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
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
WRITERS_MUTATED=0

cleanup_local_artifacts() {
  local marker_value=""
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

quiesce_writers() {
  local index
  WRITERS_MUTATED=1
  for index in "${!CONSUMERS[@]}"; do
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
  recovery_require_exact_pvc_consumers ret-pvc
}

resume_writers() {
  local index deployment contract uid resource_version replicas selector fingerprint
  local -a order=(1 2 0 4 3)
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
    contract="$(recovery_capture_deployment_contract "$deployment")" || return 1
    IFS=$'\t' read -r uid resource_version replicas selector fingerprint <<<"$contract"
    if [[ "$replicas" == 0 ]]; then
      DEPLOYMENT_RESOURCE_VERSIONS[index]="$(recovery_scale_deployment_exact \
        "$deployment" "$uid" "$resource_version" 0 "${ORIGINAL_REPLICAS[$index]}" \
        "$selector" "$fingerprint")" || return 1
      recovery_kubectl rollout status "deployment/$deployment" -n "$NAMESPACE" \
        --timeout=5m >/dev/null || return 1
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

recovery_require_cluster_identity
recovery_require_pvc_identity ret-pvc
RECOVERY_CHECKPOINT_STAMP="$TIMESTAMP"
RECOVERY_DUMP_SHA256="$(printf '0%.0s' {1..64})"
RECOVERY_STORAGE_SHA256="$RECOVERY_DUMP_SHA256"
recovery_acquire_operation_lock checkpoint-backup yenhubs-recovery-operation-lock
OPERATION_LOCK_OWNED=1
# Coordinated backup children revalidate these exported bindings against the
# immutable lock. They are data-only identifiers, not local cleanup
# capabilities; materialized paths are never inherited.
export RECOVERY_CHECKPOINT_STAMP RECOVERY_DUMP_SHA256 RECOVERY_STORAGE_SHA256 \
  RECOVERY_NAMESPACE_UID RECOVERY_PVC_UID
capture_consumer_contracts

# Capture the exact live image/infrastructure inventory while the deployments
# still have their pre-downtime scale, then prove those immutable contracts
# again as each writer is stopped.
"$SCRIPT_DIR/capture-instance-state.sh" "$OUTPUT_DIR"

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
BACKUP_COORDINATED=1 "$SCRIPT_DIR/backup-retdb.sh" \
  "$OUTPUT_DIR/retdb-$TIMESTAMP.sql.gz"
"$SCRIPT_DIR/backup-ret-storage-quiesced.sh" \
  "$OUTPUT_DIR/ret-storage-$TIMESTAMP.tar.gz" \
  "$OUTPUT_DIR/deployment-images.json"
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
rm -f -- "$FINAL_INCOMPLETE_MARKER"
FINAL_CLAIM_OWNED=0
FINAL_INCOMPLETE_MARKER=""
recovery_verify_checkpoint_directory "$FINAL_OUTPUT_DIR" "$TIMESTAMP"
rmdir "$OUTPUT_DIR"
CHECKPOINT_STAGING_OWNED=0
OUTPUT_DIR=""

resume_writers
release_lock_if_safe
cleanup_local_artifacts
trap - EXIT ERR INT TERM

printf 'Complete quiescent YenHubs checkpoint published: %s (writers resumed)\n' \
  "$FINAL_OUTPUT_DIR"

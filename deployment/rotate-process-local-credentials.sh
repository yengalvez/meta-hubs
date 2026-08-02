#!/usr/bin/env bash

# Crash-safe coordinator for the AUD-065 process-local credential rotation.
# Kubernetes state plus the HMAC-bound private operation directory are the
# source of truth.  Passwords are accepted only from owner-private snapshots
# and are streamed on stdin; this driver never places them in argv or URLs.

set -Eeuo pipefail
set +x
umask 077

AUD065_DRIVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck disable=SC1091
source "$AUD065_DRIVER_DIR/lib/recovery-safety.sh"
# shellcheck disable=SC1091
source "$AUD065_DRIVER_DIR/lib/reactivation-gate-functions.sh"
# shellcheck disable=SC1091
source "$AUD065_DRIVER_DIR/lib/aud065-pgsql-barrier.sh"
# shellcheck disable=SC1091
source "$AUD065_DRIVER_DIR/lib/process-local-db-rotation.sh"

readonly AUD065_OPERATION_TOOL="$AUD065_DRIVER_DIR/process-local-rotation-operation.mjs"
readonly AUD065_CAPTURE_TOOL="$AUD065_DRIVER_DIR/capture-process-local-baseline.mjs"
readonly AUD065_PROJECT_TOOL="$AUD065_DRIVER_DIR/project-process-local-values.mjs"
readonly AUD065_SOURCE_TOOL="$AUD065_DRIVER_DIR/process-local-source-transition.mjs"
readonly AUD065_PREPARE_TOOL="$AUD065_DRIVER_DIR/prepare-process-local-rotation.mjs"
readonly AUD065_MATERIALIZE_TOOL="$AUD065_DRIVER_DIR/materialize-process-local-replacements.mjs"
readonly AUD065_REDACTED_TOOL="$AUD065_DRIVER_DIR/verify-redacted-rollout.mjs"
readonly AUD065_PUBLICATION_TOOL="$AUD065_DRIVER_DIR/private-artifact-publication.mjs"
readonly AUD065_ROTATION_TOOL="$AUD065_DRIVER_DIR/process-local-rotation.mjs"
readonly AUD065_PULL_TOOL="$AUD065_DRIVER_DIR/verify-bot-image-pull-config.mjs"
readonly AUD065_ATTESTATION_TOOL="$AUD065_DRIVER_DIR/write-process-local-operational-attestation.mjs"
readonly AUD065_DIRFD_HELPER="$AUD065_DRIVER_DIR/private-dirfd-ops.py"
readonly AUD065_PROFILE_ID="yenhubs-process-local-credential-rotation-v1"
readonly AUD065_PROFILE_SHA256="8252ddb7a957950b022fdae482c6363fbc102a57a0c140022031408bc4f6ea1b"
readonly AUD065_CANONICAL_VALUES="$AUD065_DRIVER_DIR/input-values.local.yaml"
readonly AUD065_LOCK_NAME="yenhubs-recovery-operation-lock"
readonly AUD065_ROTATION_DEPLOYMENTS=(
  bot-orchestrator reticulum coturn dialog pgbouncer pgbouncer-t
)

AUD065_COMMAND=""
AUD065_OPERATION_DIRECTORY=""
AUD065_CHECKPOINT_DIRECTORY=""
AUD065_OLD_VALUES_SOURCE=""
AUD065_NEW_VALUES_SOURCE=""
AUD065_ROTATION_REVISION=""
AUD065_FAILURE_STAGE="startup"
AUD065_SIMULATED_CRASH=0
AUD065_LEASE_ACQUIRED=0
AUD065_BOUND_LOCK_UID=""
AUD065_COORDINATOR_PID=""
AUD065_ORIGINAL_PGSQL_POLICY_UID=""
AUD065_ORIGINAL_PGSQL_POLICY_RESOURCE_VERSION=""
AUD065_CAPTURE_FILE=""
AUD065_CAPTURE_IDENTITY=""
AUD065_SCRATCH_DIRECTORIES=()
AUD065_SCRATCH_IDENTITIES=()
AUD065_NEXT_SCRATCH_INDEX=0
AUD065_BUNDLE_ITERATION_PENDING=""
AUD065_BUNDLE_ITERATION_ALREADY=""
AUD065_CHECKPOINT_CREATED_AT_EPOCH=""

AUD065_ORIGINAL_BASELINE=""
AUD065_OLD_SNAPSHOT=""
AUD065_NEW_SNAPSHOT=""
AUD065_OLD_VALUES_COPY=""
AUD065_NEW_VALUES_COPY=""
AUD065_QUIESCED_BASELINE=""
AUD065_BUNDLE_DIRECTORY=""
AUD065_BUNDLE=""
AUD065_RESTART_CONTRACT=""
AUD065_BUNDLE_BINDING=""
AUD065_REPLACEMENTS_DIRECTORY=""
AUD065_APPLIED_RESOURCES=""
AUD065_FINAL_BASELINE=""
AUD065_RELEASED_BASELINE=""
AUD065_REPORT=""

aud065_error() {
  printf 'AUD-065 process-local rotation failed closed: %s\n' "$1" >&2
}

aud065_require_no_xtrace() {
  case "$-" in
    *x*) aud065_error xtrace-enabled; return 1 ;;
  esac
}

aud065_is_absolute() {
  [[ "${1:-}" == /* && "$1" != *$'\n'* && "$1" != *$'\r'* ]]
}

aud065_mode() {
  local target="$1" mode
  if mode="$(stat -f '%Lp' "$target" 2>/dev/null)"; then :
  elif mode="$(stat -c '%a' "$target" 2>/dev/null)"; then :
  else return 1
  fi
  printf '%s\n' "${mode#0}"
}

aud065_owner() {
  local target="$1" owner
  if owner="$(stat -f '%u' "$target" 2>/dev/null)"; then :
  elif owner="$(stat -c '%u' "$target" 2>/dev/null)"; then :
  else return 1
  fi
  printf '%s\n' "$owner"
}

aud065_link_count() {
  local target="$1" links
  if links="$(stat -f '%l' "$target" 2>/dev/null)"; then :
  elif links="$(stat -c '%h' "$target" 2>/dev/null)"; then :
  else return 1
  fi
  [[ "$links" =~ ^[1-9][0-9]*$ ]] || return 1
  printf '%s\n' "$links"
}

aud065_device_inode() {
  local target="$1" identity
  if identity="$(stat -f '%d:%i' "$target" 2>/dev/null)"; then :
  elif identity="$(stat -c '%d:%i' "$target" 2>/dev/null)"; then :
  else return 1
  fi
  [[ "$identity" =~ ^[0-9]+:[0-9]+$ ]] || return 1
  printf '%s\n' "$identity"
}

aud065_require_private_directory() {
  local target="$1"
  aud065_is_absolute "$target" && [[ -d "$target" && ! -L "$target" ]] &&
    ! recovery_path_has_symlink_component "$target" &&
    [[ "$(aud065_mode "$target")" == 700 &&
       "$(aud065_owner "$target")" == "$(id -u)" ]]
}

aud065_require_private_file() {
  local target="$1"
  aud065_is_absolute "$target" && recovery_private_values_file_is_acceptable "$target"
}

aud065_require_python_helper_environment() {
  local python
  python="$(PATH=/usr/bin:/bin command -v python3)" || {
    aud065_error python3-unavailable
    return 1
  }
  [[ -x "$python" && -f "$AUD065_DIRFD_HELPER" &&
     ! -L "$AUD065_DIRFD_HELPER" ]] || {
    aud065_error dirfd-helper-invalid
    return 1
  }
  PATH=/usr/bin:/bin "$python" -I - "$AUD065_DIRFD_HELPER" <<'PY'
import os
import stat
import sys

helper = os.stat(sys.argv[1], follow_symlinks=False)
required_dir_fd = (os.open, os.stat, os.unlink, os.link, os.rename)
supported = (
    stat.S_ISREG(helper.st_mode)
    and all(function in os.supports_dir_fd for function in required_dir_fd)
    and callable(getattr(os, "pread", None))
    and callable(getattr(os, "pwrite", None))
)
raise SystemExit(0 if supported else 1)
PY
}

aud065_require_environment() {
  [[ "${NAMESPACE:-}" == hcce &&
     -n "${EXPECTED_KUBE_CONTEXT:-}" &&
     -n "${EXPECTED_NAMESPACE_UID:-}" &&
     -n "${EXPECTED_RET_PVC_UID:-}" ]] || {
    aud065_error pinned-environment-required
    return 1
  }
  aud065_require_no_xtrace || return 1
  command -v jq >/dev/null 2>&1 || return 1
  command -v node >/dev/null 2>&1 || return 1
  command -v kubectl >/dev/null 2>&1 || return 1
  aud065_require_python_helper_environment || return 1
}

aud065_parse_cli() {
  AUD065_COMMAND="${1:-}"
  shift || :
  case "$AUD065_COMMAND" in
    plan)
      [[ "$#" == 10 ]] || return 2
      ;;
    execute|resume|rollback|audit)
      [[ "$#" == 4 ]] || return 2
      ;;
    *) return 2 ;;
  esac
  local flag value
  while [[ "$#" -gt 0 ]]; do
    flag="$1"; value="${2:-}"; shift 2 || return 2
    [[ -n "$value" && "$value" != --* ]] || return 2
    case "$flag" in
      --operation-directory)
        [[ -z "$AUD065_OPERATION_DIRECTORY" ]] || return 2
        AUD065_OPERATION_DIRECTORY="$value"
        ;;
      --checkpoint-directory)
        [[ -z "$AUD065_CHECKPOINT_DIRECTORY" ]] || return 2
        AUD065_CHECKPOINT_DIRECTORY="$value"
        ;;
      --old-values-source)
        [[ "$AUD065_COMMAND" == plan && -z "$AUD065_OLD_VALUES_SOURCE" ]] || return 2
        AUD065_OLD_VALUES_SOURCE="$value"
        ;;
      --new-values-source)
        [[ "$AUD065_COMMAND" == plan && -z "$AUD065_NEW_VALUES_SOURCE" ]] || return 2
        AUD065_NEW_VALUES_SOURCE="$value"
        ;;
      --rotation-revision)
        [[ "$AUD065_COMMAND" == plan && -z "$AUD065_ROTATION_REVISION" ]] || return 2
        AUD065_ROTATION_REVISION="$value"
        ;;
      *) return 2 ;;
    esac
  done
  aud065_is_absolute "$AUD065_OPERATION_DIRECTORY" || return 2
  aud065_is_absolute "$AUD065_CHECKPOINT_DIRECTORY" || return 2
  if [[ "$AUD065_COMMAND" == plan ]]; then
    aud065_is_absolute "$AUD065_OLD_VALUES_SOURCE" || return 2
    aud065_is_absolute "$AUD065_NEW_VALUES_SOURCE" || return 2
    [[ "$AUD065_ROTATION_REVISION" =~ ^aud065-[a-z0-9]([-a-z0-9.]{6,61}[a-z0-9])$ ]] || return 2
  fi
}

aud065_set_paths() {
  AUD065_ORIGINAL_BASELINE="$AUD065_OPERATION_DIRECTORY/original-baseline.json"
  AUD065_OLD_SNAPSHOT="$AUD065_OPERATION_DIRECTORY/old-snapshot.json"
  AUD065_NEW_SNAPSHOT="$AUD065_OPERATION_DIRECTORY/new-snapshot.json"
  AUD065_OLD_VALUES_COPY="$AUD065_OPERATION_DIRECTORY/old-values-source.yaml"
  AUD065_NEW_VALUES_COPY="$AUD065_OPERATION_DIRECTORY/new-values-source.yaml"
  AUD065_QUIESCED_BASELINE="$AUD065_OPERATION_DIRECTORY/quiesced-baseline.json"
  AUD065_BUNDLE_DIRECTORY="$AUD065_OPERATION_DIRECTORY/bundle"
  AUD065_BUNDLE="$AUD065_BUNDLE_DIRECTORY/bundle.json"
  AUD065_RESTART_CONTRACT="$AUD065_BUNDLE_DIRECTORY/restart-contract.json"
  AUD065_BUNDLE_BINDING="$AUD065_BUNDLE_DIRECTORY/binding.json"
  AUD065_REPLACEMENTS_DIRECTORY="$AUD065_OPERATION_DIRECTORY/replacements"
  AUD065_APPLIED_RESOURCES="$AUD065_OPERATION_DIRECTORY/applied-resources.json"
  AUD065_FINAL_BASELINE="$AUD065_OPERATION_DIRECTORY/final-baseline.json"
  AUD065_RELEASED_BASELINE="$AUD065_OPERATION_DIRECTORY/released-baseline.json"
  AUD065_REPORT="$AUD065_OPERATION_DIRECTORY/redacted-report.json"
}

aud065_sha256() {
  recovery_sha256_digest "$1"
}

aud065_load_checkpoint_contract() {
  local metadata="$AUD065_CHECKPOINT_DIRECTORY/checkpoint-metadata.json"
  local inventory="$AUD065_CHECKPOINT_DIRECTORY/deployment-images.json"
  local stamp created_at_epoch metadata_evidence_sha metadata_generation
  aud065_require_private_directory "$AUD065_CHECKPOINT_DIRECTORY" || return 1
  stamp="$(jq -er '.stamp | select(type == "string")' "$metadata")" || return 1
  created_at_epoch="$(jq -er '
    .created_at_epoch |
    select(type == "number" and . >= 0 and floor == .) |
    tostring
  ' "$metadata")" || return 1
  recovery_verify_checkpoint_directory "$AUD065_CHECKPOINT_DIRECTORY" "$stamp" || return 1
  jq -e --arg context "$EXPECTED_KUBE_CONTEXT" --arg namespace "$NAMESPACE" \
    --arg namespace_uid "$EXPECTED_NAMESPACE_UID" --arg pvc_uid "$EXPECTED_RET_PVC_UID" '
      .schema_version == 3 and
      .kube_context == $context and .namespace == $namespace and
      .namespace_uid == $namespace_uid and .ret_pvc_uid == $pvc_uid
    ' "$metadata" >/dev/null || return 1
  recovery_checkpoint_deployment_inventory_is_acceptable "$inventory" "$NAMESPACE" || return 1
  [[ "$(jq -er '.schema_version' "$inventory")" == 4 ]] || return 1
  [[ "$(jq -er '.bot_runner_runtime.mode' "$inventory")" == process-local ]] || return 1
  metadata_evidence_sha="$(jq -er '
    .runner_cutover_evidence_sha256 |
    select(type == "string" and test("^[a-f0-9]{64}$"))
  ' "$metadata")" || return 1
  metadata_generation="$(jq -er '
    .runtime_generation |
    select(. == "legacy-absent" or . == "durable-v2")
  ' "$metadata")" || return 1
  [[ "$metadata_generation" == legacy-absent ]] || return 1
  [[ "$(jq -er '.bot_runner_runtime.generation' "$inventory")" == "$metadata_generation" ]] ||
    return 1
  RECOVERY_CHECKPOINT_STAMP="$stamp"
  AUD065_CHECKPOINT_CREATED_AT_EPOCH="$created_at_epoch"
  RECOVERY_DUMP_SHA256="$(recovery_checkpoint_digest_for \
    "$AUD065_CHECKPOINT_DIRECTORY" "retdb-$stamp.sql.gz")" || return 1
  RECOVERY_STORAGE_SHA256="$(recovery_checkpoint_digest_for \
    "$AUD065_CHECKPOINT_DIRECTORY" "ret-storage-$stamp.tar.gz")" || return 1
  RECOVERY_DEPLOYMENT_INVENTORY_SHA256="$(aud065_sha256 "$inventory")" || return 1
  RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256="$(recovery_checkpoint_digest_for \
    "$AUD065_CHECKPOINT_DIRECTORY" "runner-cutover-evidence.json")" || return 1
  [[ "$RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256" == "$metadata_evidence_sha" ]] || return 1
  RECOVERY_RUNNER_RUNTIME_GENERATION="$metadata_generation"
  export RECOVERY_CHECKPOINT_STAMP RECOVERY_DUMP_SHA256 RECOVERY_STORAGE_SHA256 \
    RECOVERY_DEPLOYMENT_INVENTORY_SHA256 RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256 \
    RECOVERY_RUNNER_RUNTIME_GENERATION
}

aud065_current_epoch() {
  command date -u '+%s'
}

aud065_require_checkpoint_freshness() {
  local current_epoch maximum_age="${MAX_CHECKPOINT_AGE_SECONDS:-86400}"
  current_epoch="$(aud065_current_epoch)" || return 1
  if ! reactivation_checkpoint_age_is_acceptable \
    "$AUD065_CHECKPOINT_CREATED_AT_EPOCH" "$current_epoch" "$maximum_age"; then
    aud065_error checkpoint-not-fresh
    return 1
  fi
}

aud065_verify_live_plan_boundary() {
  recovery_require_cluster_identity || return 1
  recovery_require_pvc_identity ret-pvc || return 1
  recovery_require_live_process_local_runner_exact "$AUD065_OLD_VALUES_SOURCE" || return 1
  recovery_require_live_images_match_checkpoint \
    "$AUD065_CHECKPOINT_DIRECTORY/deployment-images.json" || return 1
}

aud065_operation_tool() {
  command node "$AUD065_OPERATION_TOOL" "$@"
}

aud065_plan() {
  local parent
  AUD065_FAILURE_STAGE="plan-validation"
  parent="$(dirname "$AUD065_OPERATION_DIRECTORY")"
  aud065_require_private_directory "$parent" || return 1
  [[ ! -e "$AUD065_OPERATION_DIRECTORY" && ! -L "$AUD065_OPERATION_DIRECTORY" ]] || return 1
  aud065_require_private_file "$AUD065_OLD_VALUES_SOURCE" || return 1
  aud065_require_private_file "$AUD065_NEW_VALUES_SOURCE" || return 1
  aud065_load_checkpoint_contract || return 1
  aud065_require_checkpoint_freshness || return 1
  aud065_verify_live_plan_boundary || return 1

  AUD065_FAILURE_STAGE="plan-identity"
  aud065_operation_tool init \
    --parent-directory "$parent" \
    --operation-directory "$AUD065_OPERATION_DIRECTORY" \
    --rotation-revision "$AUD065_ROTATION_REVISION" || return 1
  aud065_set_paths || return 1
  AUD065_FAILURE_STAGE="plan-capture"
  aud065_capture_or_reconcile_baseline "$AUD065_ORIGINAL_BASELINE" || return 1
  command node "$AUD065_SOURCE_TOOL" snapshot \
    --operation-directory "$AUD065_OPERATION_DIRECTORY" \
    --old-values-source "$AUD065_OLD_VALUES_SOURCE" \
    --new-values-source "$AUD065_NEW_VALUES_SOURCE" || return 1
  aud065_project_private_values \
    "$AUD065_OLD_VALUES_COPY" "$AUD065_OLD_SNAPSHOT" || return 1
  aud065_project_private_values \
    "$AUD065_NEW_VALUES_COPY" "$AUD065_NEW_SNAPSHOT" || return 1
  AUD065_FAILURE_STAGE="plan-seal"
  aud065_operation_tool seal \
    --operation-directory "$AUD065_OPERATION_DIRECTORY" \
    --expected-kube-context "$EXPECTED_KUBE_CONTEXT" \
    --namespace-name "$NAMESPACE" --namespace-uid "$EXPECTED_NAMESPACE_UID" \
    --ret-pvc-name ret-pvc --ret-pvc-uid "$EXPECTED_RET_PVC_UID" \
    --checkpoint-stamp "$RECOVERY_CHECKPOINT_STAMP" \
    --checkpoint-dump-sha256 "$RECOVERY_DUMP_SHA256" \
    --checkpoint-storage-sha256 "$RECOVERY_STORAGE_SHA256" \
    --checkpoint-inventory-sha256 "$RECOVERY_DEPLOYMENT_INVENTORY_SHA256" \
    --checkpoint-runner-evidence-sha256 "$RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256" \
    --checkpoint-runtime-generation "$RECOVERY_RUNNER_RUNTIME_GENERATION" \
    --profile-id "$AUD065_PROFILE_ID" --profile-sha256 "$AUD065_PROFILE_SHA256" || return 1
  aud065_load_intent || return 1
  aud065_operation_tool verify \
    --operation-directory "$AUD065_OPERATION_DIRECTORY" \
    --expected-operation-id "$RECOVERY_OPERATION_ID" \
    --expected-operation-binding-sha256 "$RECOVERY_OPERATION_BINDING_SHA256" || return 1
  aud065_verify_source_state old || return 1
  AUD065_FAILURE_STAGE="plan-ghcr-access"
  aud065_verify_pre_mutation_ghcr_access || return 1
  AUD065_FAILURE_STAGE="plan-offline-contract"
  command node "$AUD065_PREPARE_TOOL" verify-plan \
    --operation-directory "$AUD065_OPERATION_DIRECTORY" \
    --original-baseline "$AUD065_ORIGINAL_BASELINE" \
    --old-snapshot "$AUD065_OLD_SNAPSHOT" \
    --new-snapshot "$AUD065_NEW_SNAPSHOT" || return 1
  printf 'aud065_plan_ready\n'
}

# loadVerifiedProcessLocalRotationIntent authenticates the private intent before
# this internal pipe exposes the small fixed identity tuple to this shell.  The
# tuple is captured, never diagnostic output.
aud065_load_intent() {
  local payload
  payload="$(command node --input-type=module - \
    "$AUD065_OPERATION_TOOL" "$AUD065_OPERATION_DIRECTORY" 2>/dev/null <<'NODE'
import { pathToFileURL } from "node:url";
const modulePath = process.argv[2];
const operationDirectory = process.argv[3];
const mod = await import(pathToFileURL(modulePath));
const value = mod.loadVerifiedProcessLocalRotationIntent({ operationDirectory });
const fields = [
  value.operationToken, value.operationId, value.operationBindingSha256,
  value.rotationRevision, value.expectedKubeContext, value.namespaceName,
  value.namespaceUid, value.retPvcUid, value.checkpointStamp,
  value.checkpointDumpSha256, value.checkpointStorageSha256,
  value.checkpointInventorySha256, value.checkpointRunnerEvidenceSha256,
  value.checkpointRuntimeGeneration, value.profileId, value.profileSha256
];
if (fields.some(item => typeof item !== "string" || /[\t\r\n]/u.test(item))) process.exit(1);
process.stdout.write(fields.join("\t"));
NODE
  )" || return 1
  local context namespace namespace_uid pvc_uid profile_id profile_sha
  IFS=$'\t' read -r RECOVERY_OPERATION_TOKEN RECOVERY_OPERATION_ID \
    RECOVERY_OPERATION_BINDING_SHA256 AUD065_ROTATION_REVISION context namespace \
    namespace_uid pvc_uid RECOVERY_CHECKPOINT_STAMP RECOVERY_DUMP_SHA256 \
    RECOVERY_STORAGE_SHA256 RECOVERY_DEPLOYMENT_INVENTORY_SHA256 \
    RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256 RECOVERY_RUNNER_RUNTIME_GENERATION \
    profile_id profile_sha <<<"$payload"
  payload=""
  [[ "$context" == "$EXPECTED_KUBE_CONTEXT" && "$namespace" == "$NAMESPACE" &&
     "$namespace_uid" == "$EXPECTED_NAMESPACE_UID" &&
     "$pvc_uid" == "$EXPECTED_RET_PVC_UID" &&
     "$profile_id" == "$AUD065_PROFILE_ID" && "$profile_sha" == "$AUD065_PROFILE_SHA256" &&
     "$RECOVERY_OPERATION_TOKEN" =~ ^[a-f0-9]{32}$ &&
     "$RECOVERY_OPERATION_ID" =~ ^[a-f0-9]{32}$ &&
     "$RECOVERY_OPERATION_BINDING_SHA256" =~ ^[a-f0-9]{64}$ &&
     "$RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256" =~ ^[a-f0-9]{64}$ &&
     "$RECOVERY_RUNNER_RUNTIME_GENERATION" == legacy-absent ]] || return 1
  RECOVERY_OPERATION_OWNER=aud065-rotation
  RECOVERY_OPERATION_LOCK_NAME="$AUD065_LOCK_NAME"
  # Read by recovery_acquire_operation_lock from the sourced safety library.
  # shellcheck disable=SC2034
  RECOVERY_OPERATION_IDENTITY_PREBOUND=1
  export RECOVERY_OPERATION_TOKEN RECOVERY_OPERATION_ID RECOVERY_OPERATION_BINDING_SHA256 \
    RECOVERY_OPERATION_OWNER RECOVERY_OPERATION_LOCK_NAME RECOVERY_OPERATION_STATE \
    RECOVERY_CHECKPOINT_STAMP RECOVERY_DUMP_SHA256 RECOVERY_STORAGE_SHA256 \
    RECOVERY_DEPLOYMENT_INVENTORY_SHA256 RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256 \
    RECOVERY_RUNNER_RUNTIME_GENERATION
}

aud065_verify_operation_checkpoint() {
  local intent_stamp intent_dump intent_storage intent_inventory
  local intent_runner_evidence intent_runtime_generation
  aud065_require_private_directory "$AUD065_OPERATION_DIRECTORY" || return 1
  aud065_load_intent || return 1
  intent_stamp="$RECOVERY_CHECKPOINT_STAMP"
  intent_dump="$RECOVERY_DUMP_SHA256"
  intent_storage="$RECOVERY_STORAGE_SHA256"
  intent_inventory="$RECOVERY_DEPLOYMENT_INVENTORY_SHA256"
  intent_runner_evidence="$RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256"
  intent_runtime_generation="$RECOVERY_RUNNER_RUNTIME_GENERATION"
  aud065_load_checkpoint_contract || return 1
  [[ "$RECOVERY_CHECKPOINT_STAMP" == "$intent_stamp" &&
     "$RECOVERY_DUMP_SHA256" == "$intent_dump" &&
     "$RECOVERY_STORAGE_SHA256" == "$intent_storage" &&
     "$RECOVERY_DEPLOYMENT_INVENTORY_SHA256" == "$intent_inventory" &&
     "$RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256" == "$intent_runner_evidence" &&
     "$RECOVERY_RUNNER_RUNTIME_GENERATION" == "$intent_runtime_generation" ]] || return 1
  recovery_require_cluster_identity || return 1
  recovery_require_pvc_identity ret-pvc || return 1
  recovery_require_live_images_match_checkpoint \
    "$AUD065_CHECKPOINT_DIRECTORY/deployment-images.json" || return 1
  aud065_operation_tool verify \
    --operation-directory "$AUD065_OPERATION_DIRECTORY" \
    --expected-operation-id "$RECOVERY_OPERATION_ID" \
    --expected-operation-binding-sha256 "$RECOVERY_OPERATION_BINDING_SHA256" \
    --expected-kube-context "$EXPECTED_KUBE_CONTEXT" \
    --namespace-name "$NAMESPACE" --namespace-uid "$EXPECTED_NAMESPACE_UID" \
    --ret-pvc-name ret-pvc --ret-pvc-uid "$EXPECTED_RET_PVC_UID" \
    --checkpoint-stamp "$RECOVERY_CHECKPOINT_STAMP" \
    --checkpoint-dump-sha256 "$RECOVERY_DUMP_SHA256" \
    --checkpoint-storage-sha256 "$RECOVERY_STORAGE_SHA256" \
    --checkpoint-inventory-sha256 "$RECOVERY_DEPLOYMENT_INVENTORY_SHA256" \
    --checkpoint-runner-evidence-sha256 "$RECOVERY_RUNNER_CUTOVER_EVIDENCE_SHA256" \
    --checkpoint-runtime-generation "$RECOVERY_RUNNER_RUNTIME_GENERATION" \
    --profile-id "$AUD065_PROFILE_ID" --profile-sha256 "$AUD065_PROFILE_SHA256" || return 1
}

aud065_verify_source_state() {
  local expected_state="$1"
  [[ "$expected_state" == old || "$expected_state" == new ||
     "$expected_state" == either ]] || return 2
  command node "$AUD065_SOURCE_TOOL" verify \
    --operation-directory "$AUD065_OPERATION_DIRECTORY" \
    --expected-operation-id "$RECOVERY_OPERATION_ID" \
    --expected-operation-binding-sha256 "$RECOVERY_OPERATION_BINDING_SHA256" \
    --canonical-values "$AUD065_CANONICAL_VALUES" \
    --expected-state "$expected_state"
}

aud065_promote_source() {
  command node "$AUD065_SOURCE_TOOL" promote \
    --operation-directory "$AUD065_OPERATION_DIRECTORY" \
    --expected-operation-id "$RECOVERY_OPERATION_ID" \
    --expected-operation-binding-sha256 "$RECOVERY_OPERATION_BINDING_SHA256" \
    --canonical-values "$AUD065_CANONICAL_VALUES" || return 1
  aud065_verify_source_state new || return 1
}

aud065_verify_ghcr_snapshot_access() {
  local snapshot="$1"
  aud065_require_private_file "$snapshot" || return 1
  command node "$AUD065_PULL_TOOL" --verify-process-local-snapshot "$snapshot"
}

aud065_verify_pre_mutation_ghcr_access() {
  aud065_verify_ghcr_snapshot_access "$AUD065_OLD_SNAPSHOT" || return 1
  aud065_verify_ghcr_snapshot_access "$AUD065_NEW_SNAPSHOT"
}

aud065_lock_json() {
  recovery_kubectl get configmap "$AUD065_LOCK_NAME" -n "$NAMESPACE" \
    --ignore-not-found -o json
}

aud065_acquire_lease() {
  AUD065_FAILURE_STAGE="lease"
  # Arm outer cleanup before acquisition: the helper may acquire the remote
  # holder and then fail while starting its heartbeat or first identity check.
  # Release is a safe no-op when no holder was acquired.
  AUD065_LEASE_ACQUIRED=1
  recovery_acquire_operation_serialization root-recovery || return 1
  recovery_require_operation_serialization || return 1
}

aud065_discover_lock() {
  RECOVERY_OPERATION_LOCK_UID=""
  # Read by recovery_discover_aud065_operation_lock.
  # shellcheck disable=SC2034
  RECOVERY_OPERATION_LOCK_RESOURCE_VERSION=""
  recovery_discover_aud065_operation_lock
}

aud065_create_or_adopt_lock() {
  local mode="$1" live
  live="$(aud065_lock_json)" || return 1
  if [[ -z "$live" ]]; then
    [[ "$mode" == execute ]] || return 3
    RECOVERY_OPERATION_STATE=preflight
    export RECOVERY_OPERATION_STATE
    recovery_acquire_operation_lock aud065-rotation "$AUD065_LOCK_NAME" || return 1
    aud065_crash_point after-lock-create || return 1
  else
    [[ "$mode" == resume || "$mode" == rollback ]] || return 1
    aud065_discover_lock || return 1
  fi
  recovery_require_operation_lock || return 1
}

aud065_crash_point() {
  local point="$1"
  if [[ "${YENHUBS_RECOVERY_TEST_MODE:-}" == local-fixture &&
        "${EXPECTED_KUBE_CONTEXT:-}" == fixture-context &&
        "${EXPECTED_NAMESPACE_UID:-}" == fixture-uid &&
       "${EXPECTED_RET_PVC_UID:-}" == fixture-pvc-uid &&
       "${NAMESPACE:-}" == hcce &&
       "${AUD065_TEST_CRASH_AFTER:-}" == "$point" ]]; then
    [[ "$AUD065_COORDINATOR_PID" =~ ^[1-9][0-9]*$ ]] || return 1
    kill -KILL "$AUD065_COORDINATOR_PID"
    exit 97
  fi
}

aud065_load_barrier_binding() {
  local require_live_lock="${1:-1}" payload
  payload="$(command node --input-type=module - \
    "$AUD065_OPERATION_TOOL" "$AUD065_OPERATION_DIRECTORY" \
    "$RECOVERY_OPERATION_ID" "$RECOVERY_OPERATION_BINDING_SHA256" \
    2>/dev/null <<'NODE'
import { pathToFileURL } from "node:url";
const mod = await import(pathToFileURL(process.argv[2]));
const operationDirectory = process.argv[3];
const expectedOperationId = process.argv[4];
const expectedOperationBindingSha256 = process.argv[5];
const value = mod.loadVerifiedProcessLocalBarrierBinding({
  operationDirectory, expectedOperationId, expectedOperationBindingSha256
});
const fields = [value.policyUid,value.policyResourceVersion,value.policyMetadataSha256,
  value.normalSpecSha256,value.lockUid];
if (fields.some(item => typeof item !== "string" || /[\t\r\n]/u.test(item))) process.exit(1);
process.stdout.write(fields.join("\t"));
NODE
  )" || return 1
  local policy_uid policy_rv metadata_sha normal_sha lock_uid
  IFS=$'\t' read -r policy_uid policy_rv metadata_sha normal_sha lock_uid <<<"$payload"
  payload=""
  AUD065_BOUND_LOCK_UID="$lock_uid"
  if [[ "$require_live_lock" == 1 ]]; then
    [[ "$lock_uid" == "$RECOVERY_OPERATION_LOCK_UID" ]] || return 1
  elif [[ "$require_live_lock" != 0 ]]; then
    return 2
  fi
  aud065_pgsql_barrier_bind "$policy_uid" "$metadata_sha" "$policy_rv" || return 1
  [[ "$AUD065_PGSQL_NORMAL_SPEC_SHA256" == "$normal_sha" ]] || return 1
  if [[ -n "$AUD065_ORIGINAL_PGSQL_POLICY_UID" ||
        -n "$AUD065_ORIGINAL_PGSQL_POLICY_RESOURCE_VERSION" ]]; then
    [[ "$policy_uid" == "$AUD065_ORIGINAL_PGSQL_POLICY_UID" &&
       "$policy_rv" == "$AUD065_ORIGINAL_PGSQL_POLICY_RESOURCE_VERSION" ]] || return 1
  fi
}

aud065_verify_terminal_record() {
  [[ -e "$AUD065_FINAL_BASELINE" || -L "$AUD065_FINAL_BASELINE" ]] || return 1
  [[ -e "$AUD065_RELEASED_BASELINE" || -L "$AUD065_RELEASED_BASELINE" ]] || return 1
  [[ -e "$AUD065_REPORT" || -L "$AUD065_REPORT" ]] || return 1
  aud065_reconcile_private_file "$AUD065_FINAL_BASELINE" || return 1
  aud065_reconcile_private_file "$AUD065_RELEASED_BASELINE" || return 1
  aud065_verify_or_create_report || return 1
  aud065_load_barrier_binding 0 || return 1
  aud065_operation_tool verify-terminal-from-artifacts \
    --operation-directory "$AUD065_OPERATION_DIRECTORY" \
    --expected-operation-id "$RECOVERY_OPERATION_ID" \
    --expected-operation-binding-sha256 "$RECOVERY_OPERATION_BINDING_SHA256" \
    --verified-baseline "$AUD065_FINAL_BASELINE" \
    --released-baseline "$AUD065_RELEASED_BASELINE" \
    --report "$AUD065_REPORT" \
    --previous-lock-uid "$AUD065_BOUND_LOCK_UID" || return 1
}

aud065_require_lock_absent_read_only() {
  local live
  live="$(aud065_lock_json)" || return 1
  [[ -z "$live" ]]
}

aud065_verify_terminal_record_read_only() {
  [[ -e "$AUD065_FINAL_BASELINE" || -L "$AUD065_FINAL_BASELINE" ]] || return 1
  [[ -e "$AUD065_RELEASED_BASELINE" || -L "$AUD065_RELEASED_BASELINE" ]] || return 1
  [[ -e "$AUD065_REPORT" || -L "$AUD065_REPORT" ]] || return 1
  aud065_load_barrier_binding 0 || return 1
  aud065_operation_tool verify-terminal-from-artifacts \
    --operation-directory "$AUD065_OPERATION_DIRECTORY" \
    --expected-operation-id "$RECOVERY_OPERATION_ID" \
    --expected-operation-binding-sha256 "$RECOVERY_OPERATION_BINDING_SHA256" \
    --verified-baseline "$AUD065_FINAL_BASELINE" \
    --released-baseline "$AUD065_RELEASED_BASELINE" \
    --report "$AUD065_REPORT" \
    --previous-lock-uid "$AUD065_BOUND_LOCK_UID"
}

aud065_verify_released_policy_read_only() {
  local policy_json live_rv
  aud065_pgsql_require_single_policy || return 1
  policy_json="$(recovery_kubectl get networkpolicy "$AUD065_PGSQL_POLICY_NAME" \
    -n "$NAMESPACE" -o json)" || return 1
  aud065_pgsql_policy_json_is_exact "$policy_json" normal || return 1
  live_rv="$(jq -er '.metadata.resourceVersion' <<<"$policy_json")" || return 1
  [[ -n "$AUD065_PGSQL_INITIAL_RESOURCE_VERSION" &&
     "$live_rv" != "$AUD065_PGSQL_INITIAL_RESOURCE_VERSION" ]]
}

aud065_require_probe_absent_read_only() {
  local inventory
  inventory="$(aud065_pgsql_probe_inventory)" || return 1
  [[ "$(jq -er 'length' <<<"$inventory")" == 0 ]]
}

aud065_verify_live_release_read_only() {
  local result
  result="$(command node "$AUD065_REDACTED_TOOL" verify-live-release \
    --verified-baseline "$AUD065_FINAL_BASELINE" \
    --released-baseline "$AUD065_RELEASED_BASELINE" \
    --namespace "$NAMESPACE" \
    --initial-policy-resource-version "$AUD065_PGSQL_INITIAL_RESOURCE_VERSION" \
    --context "$EXPECTED_KUBE_CONTEXT")" || return 1
  [[ "$result" == process_local_live_audit_verified ]]
}

aud065_require_started_read_only() {
  local name="$1" expected uid applied_rv _replicas selector fingerprint
  local current current_uid current_rv current_replicas current_selector current_fingerprint
  expected="$(aud065_applied_deployment_contract "$name")" || return 1
  IFS=$'\t' read -r uid applied_rv _replicas selector fingerprint <<<"$expected"
  current="$(aud065_capture_deployment_contract "$name")" || return 1
  IFS=$'\t' read -r current_uid current_rv current_replicas current_selector \
    current_fingerprint <<<"$current"
  [[ "$current_uid" == "$uid" && "$current_rv" != "$applied_rv" &&
     "$current_replicas" == 1 && "$current_selector" == "$selector" &&
     "$current_fingerprint" == "$fingerprint" ]]
}

aud065_verify_release_baseline() {
  local baseline="$1" status
  status="$(command node "$AUD065_REDACTED_TOOL" verify-release \
    --verified-baseline "$AUD065_FINAL_BASELINE" \
    --released-baseline "$baseline" --namespace "$NAMESPACE" \
    --initial-policy-resource-version "$AUD065_PGSQL_INITIAL_RESOURCE_VERSION")" || return 1
  [[ "$status" == process_local_release_verified ]]
}

aud065_capture_released_state_in_scratch() {
  local scratch="$1" publish_result="$2" live="$1/released-live.json"
  aud065_capture_private_baseline "$live" || return 1
  aud065_verify_release_baseline "$live" || return 1
  if [[ "$publish_result" == 1 ]]; then
    aud065_publish_private_file "$live" "$AUD065_RELEASED_BASELINE" || return 1
  else
    [[ "$publish_result" == 0 ]] || return 2
  fi
}

aud065_capture_and_verify_released_state() {
  if [[ -e "$AUD065_RELEASED_BASELINE" || -L "$AUD065_RELEASED_BASELINE" ]]; then
    aud065_reconcile_private_file "$AUD065_RELEASED_BASELINE" || return 1
    aud065_verify_release_baseline "$AUD065_RELEASED_BASELINE" || return 1
    aud065_with_scratch_directory aud065_capture_released_state_in_scratch 0 || return 1
  else
    aud065_with_scratch_directory aud065_capture_released_state_in_scratch 1 || return 1
  fi
}

aud065_verify_missing_lock_terminal() {
  local policy_json live_rv inventory name
  aud065_verify_source_state new || return 1
  aud065_verify_terminal_record || return 1
  aud065_capture_and_verify_released_state || return 1
  policy_json="$(recovery_kubectl get networkpolicy "$AUD065_PGSQL_POLICY_NAME" \
    -n "$NAMESPACE" -o json)" || return 1
  aud065_pgsql_policy_json_is_exact "$policy_json" normal || return 1
  live_rv="$(jq -er '.metadata.resourceVersion' <<<"$policy_json")" || return 1
  [[ "$live_rv" != "$AUD065_PGSQL_INITIAL_RESOURCE_VERSION" ]] || return 1
  inventory="$(aud065_pgsql_probe_inventory)" || return 1
  [[ "$(jq -er 'length' <<<"$inventory")" == 0 ]] || return 1
  for name in pgbouncer pgbouncer-t reticulum coturn dialog bot-orchestrator; do
    aud065_require_started_read_only "$name" || return 1
  done
  recovery_require_live_images_match_checkpoint \
    "$AUD065_CHECKPOINT_DIRECTORY/deployment-images.json" || return 1
}

aud065_bind_or_adopt_barrier() {
  local policy_uid metadata_sha normal_sha policy_rv
  if [[ -e "$AUD065_OPERATION_DIRECTORY/barrier-binding.json" ||
        -L "$AUD065_OPERATION_DIRECTORY/barrier-binding.json" ]]; then
    aud065_load_barrier_binding || return 1
    aud065_pgsql_barrier_adopt >/dev/null || return 1
    return 0
  fi
  [[ "$RECOVERY_OPERATION_STATE" == preflight ]] || return 1
  # Run in the current shell and consume only the resulting globals. No
  # pathname intermediates may stand between the authenticated live capture
  # and its durable HMAC binding.
  aud065_pgsql_barrier_capture_normal >/dev/null || return 1
  policy_uid="$AUD065_PGSQL_POLICY_UID"
  policy_rv="$AUD065_PGSQL_POLICY_RESOURCE_VERSION"
  metadata_sha="$AUD065_PGSQL_NORMAL_METADATA_SHA256"
  normal_sha="$AUD065_PGSQL_NORMAL_SPEC_SHA256"
  [[ -n "$policy_uid" && -n "$policy_rv" &&
     "$metadata_sha" =~ ^[a-f0-9]{64}$ &&
     "$normal_sha" =~ ^[a-f0-9]{64}$ ]] || return 1
  [[ -n "$policy_rv" && "$policy_rv" == "$AUD065_PGSQL_POLICY_RESOURCE_VERSION" ]] || return 1
  [[ "$policy_uid" == "$AUD065_ORIGINAL_PGSQL_POLICY_UID" &&
     "$policy_rv" == "$AUD065_ORIGINAL_PGSQL_POLICY_RESOURCE_VERSION" ]] || return 1
  aud065_operation_tool bind-barrier \
    --operation-directory "$AUD065_OPERATION_DIRECTORY" \
    --expected-operation-id "$RECOVERY_OPERATION_ID" \
    --expected-operation-binding-sha256 "$RECOVERY_OPERATION_BINDING_SHA256" \
    --policy-uid "$policy_uid" \
    --policy-resource-version "$policy_rv" \
    --policy-metadata-sha256 "$metadata_sha" --normal-spec-sha256 "$normal_sha" \
    --lock-uid "$RECOVERY_OPERATION_LOCK_UID" || return 1
  aud065_operation_tool verify-barrier \
    --operation-directory "$AUD065_OPERATION_DIRECTORY" \
    --expected-operation-id "$RECOVERY_OPERATION_ID" \
    --expected-operation-binding-sha256 "$RECOVERY_OPERATION_BINDING_SHA256" || return 1
  aud065_crash_point after-barrier-binding || return 1
}

aud065_probe_image() {
  aud065_operation_tool emit-baseline \
    --operation-directory "$AUD065_OPERATION_DIRECTORY" \
    --expected-operation-id "$RECOVERY_OPERATION_ID" \
    --expected-operation-binding-sha256 "$RECOVERY_OPERATION_BINDING_SHA256" \
    --mode pgsql-image
}

aud065_probe_exec_status() {
  local status=0 probe_name
  probe_name="$(aud065_pgsql_probe_name)" || return 1
  if recovery_kubectl_stream_guarded 20 exec "$probe_name" -n "$NAMESPACE" \
    -c probe -- pg_isready -q -h pgsql -p 5432 </dev/null >/dev/null 2>&1; then
    status=0
  else
    status=$?
  fi
  printf '%s\n' "$status"
}

aud065_probe_blocked_three() {
  aud065_probe_exec_status || return 1
  aud065_probe_exec_status || return 1
  aud065_probe_exec_status || return 1
}

aud065_deployment_baseline_contract() {
  local name="$1"
  aud065_operation_tool emit-baseline \
    --operation-directory "$AUD065_OPERATION_DIRECTORY" \
    --expected-operation-id "$RECOVERY_OPERATION_ID" \
    --expected-operation-binding-sha256 "$RECOVERY_OPERATION_BINDING_SHA256" \
    --mode deployment-contract --name "$name"
}

# The authenticated baseline/materializer emitters fingerprint canonical JSON.
# Kubernetes does not promise object-key order, so live contracts must use the
# same recursive canonicalization before any equality or CAS decision.
aud065_capture_deployment_contract() {
  local name="$1" deployment_json
  [[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || return 2
  deployment_json="$(recovery_kubectl get deployment "$name" \
    -n "$NAMESPACE" -o json)" || return 1
  printf '%s' "$deployment_json" | command node --input-type=module --eval '
    import { pathToFileURL } from "node:url";
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    const [modulePath, expectedName, expectedNamespace] = process.argv.slice(1);
    const { canonicalJson } = await import(pathToFileURL(modulePath));
    const value = JSON.parse(text);
    const labels = value?.spec?.selector?.matchLabels;
    const expressions = value?.spec?.selector?.matchExpressions ?? [];
    const replicas = value?.spec?.replicas;
    const uid = value?.metadata?.uid;
    const resourceVersion = value?.metadata?.resourceVersion;
    const selector = labels?.app;
    const safe = field => typeof field === "string" && field.length > 0 &&
      !/[\t\r\n\u0000]/u.test(field);
    if (value?.apiVersion !== "apps/v1" || value?.kind !== "Deployment" ||
        value?.metadata?.name !== expectedName ||
        value?.metadata?.namespace !== expectedNamespace || !safe(uid) ||
        !safe(resourceVersion) || !Number.isSafeInteger(replicas) || replicas < 0 ||
        !labels || typeof labels !== "object" || Array.isArray(labels) ||
        Object.keys(labels).length !== 1 || !safe(selector) ||
        !Array.isArray(expressions) || expressions.length !== 0 ||
        value?.spec?.template?.metadata?.labels?.app !== selector) process.exit(1);
    const contract = {
      selector: value.spec.selector,
      strategy: value.spec.strategy ?? {},
      template: value.spec.template
    };
    const fingerprint = Buffer.from(canonicalJson(contract), "utf8").toString("base64");
    process.stdout.write([uid, resourceVersion, String(replicas), selector,
      fingerprint].join("\t") + "\n");
  ' "$AUD065_ROTATION_TOOL" "$name" "$NAMESPACE" || return 1
}

aud065_require_deployment_contract() {
  local name="$1" expected_uid="$2" expected_replicas="$3"
  local expected_selector="$4" expected_fingerprint="$5"
  local contract uid _resource_version replicas selector fingerprint
  contract="$(aud065_capture_deployment_contract "$name")" || return 1
  IFS=$'\t' read -r uid _resource_version replicas selector fingerprint <<<"$contract"
  [[ "$uid" == "$expected_uid" && "$replicas" == "$expected_replicas" &&
     "$selector" == "$expected_selector" &&
     "$fingerprint" == "$expected_fingerprint" ]]
}

aud065_scale_deployment_exact() {
  local name="$1" expected_uid="$2" expected_rv="$3" expected_replicas="$4"
  local desired_replicas="$5" expected_selector="$6" expected_fingerprint="$7"
  local before after uid rv replicas selector fingerprint
  local after_uid after_rv after_replicas after_selector after_fingerprint
  [[ "$expected_replicas" =~ ^[0-9]+$ && "$desired_replicas" =~ ^[0-9]+$ &&
     -n "$expected_rv" ]] || return 2
  recovery_require_operation_lock || return 1
  before="$(aud065_capture_deployment_contract "$name")" || return 1
  IFS=$'\t' read -r uid rv replicas selector fingerprint <<<"$before"
  [[ "$uid" == "$expected_uid" && "$rv" == "$expected_rv" &&
     "$replicas" == "$expected_replicas" && "$selector" == "$expected_selector" &&
     "$fingerprint" == "$expected_fingerprint" ]] || return 1
  recovery_kubectl_mutate scale deployment "$name" -n "$NAMESPACE" \
    --current-replicas="$expected_replicas" --resource-version="$expected_rv" \
    --replicas="$desired_replicas" >/dev/null || return 1
  recovery_require_operation_lock || return 1
  after="$(aud065_capture_deployment_contract "$name")" || return 1
  IFS=$'\t' read -r after_uid after_rv after_replicas after_selector \
    after_fingerprint <<<"$after"
  [[ "$after_uid" == "$expected_uid" && "$after_rv" != "$expected_rv" &&
     "$after_replicas" == "$desired_replicas" &&
     "$after_selector" == "$expected_selector" &&
     "$after_fingerprint" == "$expected_fingerprint" ]] || return 1
  printf '%s\n' "$after_rv"
}

aud065_scale_one_to_zero() {
  local name="$1" expected uid original_rv original_replicas selector fingerprint
  local current current_uid current_rv current_replicas current_selector current_fingerprint
  expected="$(aud065_deployment_baseline_contract "$name")" || return 1
  IFS=$'\t' read -r uid original_rv original_replicas selector fingerprint <<<"$expected"
  [[ "$original_replicas" == 1 ]] || return 1
  current="$(aud065_capture_deployment_contract "$name")" || return 1
  IFS=$'\t' read -r current_uid current_rv current_replicas current_selector \
    current_fingerprint <<<"$current"
  [[ "$current_uid" == "$uid" && "$current_selector" == "$selector" &&
     "$current_fingerprint" == "$fingerprint" ]] || return 1
  case "$current_replicas" in
    1)
      [[ "$current_rv" == "$original_rv" ]] || return 1
      aud065_scale_deployment_exact "$name" "$uid" "$current_rv" 1 0 \
        "$selector" "$fingerprint" >/dev/null || return 1
      ;;
    0)
      [[ "$current_rv" != "$original_rv" ]] || return 1
      recovery_require_operation_lock || return 1
      ;;
    *) return 1 ;;
  esac
  aud065_crash_point "after-scale-$name" || return 1
}

aud065_consumers_absent_callback() {
  local name contract _uid _rv replicas _selector _fingerprint
  for name in "${AUD065_ROTATION_DEPLOYMENTS[@]}"; do
    contract="$(aud065_capture_deployment_contract "$name")" || return 1
    IFS=$'\t' read -r _uid _rv replicas _selector _fingerprint <<<"$contract"
    [[ "$replicas" == 0 ]] || return 1
  done
  printf 'absent\n'
}

aud065_consumer_pods_absent_callback() {
  local name pods
  for name in "${AUD065_ROTATION_DEPLOYMENTS[@]}"; do
    pods="$(recovery_kubectl get pod -n "$NAMESPACE" -l "app=$name" -o name)" || return 1
    [[ -z "$pods" ]] || return 1
  done
  printf 'absent\n'
}

# Runtime identifiers and credentials are emitted only from the same pinned,
# digest-bound snapshot bytes authenticated by the operation module. Password
# modes are capability streams and must be connected directly to stdin.
aud065_runtime_identifiers() {
  local payload role database extra=""
  payload="$(aud065_operation_tool emit-runtime \
    --operation-directory "$AUD065_OPERATION_DIRECTORY" \
    --expected-operation-id "$RECOVERY_OPERATION_ID" \
    --expected-operation-binding-sha256 "$RECOVERY_OPERATION_BINDING_SHA256" \
    --mode db-identifiers)" || return 1
  IFS=$'\t' read -r role database extra <<<"$payload"
  [[ -z "$extra" ]] || return 1
  pldb_validate_role "$role" || return 1
  [[ "$database" =~ ^[A-Za-z_][A-Za-z0-9_.-]{0,62}$ ]] || return 1
  printf '%s\t%s\n' "$role" "$database"
}

aud065_emit_runtime_password() {
  local generation="$1" mode
  case "$generation" in
    old) mode=old-password ;;
    new) mode=new-password ;;
    pair) mode=db-password-pair ;;
    *) return 2 ;;
  esac
  aud065_require_no_xtrace || return 1
  aud065_operation_tool emit-runtime \
    --operation-directory "$AUD065_OPERATION_DIRECTORY" \
    --expected-operation-id "$RECOVERY_OPERATION_ID" \
    --expected-operation-binding-sha256 "$RECOVERY_OPERATION_BINDING_SHA256" \
    --mode "$mode"
}

aud065_pgsql_pod_and_role() {
  local pods info pod_name _pod_uid _deployment_uid identifiers role _database
  pods="$(recovery_kubectl get pod -n "$NAMESPACE" -l app=pgsql -o json)" || return 1
  info="$(recovery_exact_ready_deployment_pod_info "$pods" pgsql pgsql)" || return 1
  IFS=$'\t' read -r pod_name _pod_uid _deployment_uid <<<"$info"
  identifiers="$(aud065_runtime_identifiers)" || return 1
  IFS=$'\t' read -r role _database <<<"$identifiers"
  printf '%s\t%s\n' "$pod_name" "$role"
}

aud065_psql_socket() {
  local info pod_name role
  info="$(aud065_pgsql_pod_and_role)" || return 1
  IFS=$'\t' read -r pod_name role <<<"$info"
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  recovery_kubectl_stream_guarded 40 exec -i "$pod_name" -n "$NAMESPACE" \
    -c postgresql -- psql -X --no-psqlrc --no-password -qAt \
    -h /var/run/postgresql -U "$role" -d postgres
}

aud065_no_sessions_callback() {
  local identifiers role _database output
  identifiers="$(aud065_runtime_identifiers)" || return 1
  IFS=$'\t' read -r role _database <<<"$identifiers"
  output="$(pldb_emit_session_quiescence_sql "$role" | aud065_psql_socket 2>/dev/null)" || return 1
  [[ "$output" == clear ]] || return 1
  printf '0\n'
}

aud065_unix_socket_callback() {
  local output
  output="$(cat <<'SQL' | aud065_psql_socket 2>/dev/null
\set ON_ERROR_STOP on
\set QUIET 1
SET log_statement = 'none';
SET log_transaction_sample_rate = 0;
SET track_activities = off;
SET log_min_duration_statement = -1;
SET log_duration = off;
SET log_min_error_statement = 'panic';
SELECT CASE WHEN inet_client_addr() IS NULL THEN 'local' ELSE 'remote' END;
SQL
  )" || return 1
  [[ "$output" == local ]] || return 1
  printf '0\n'
}

aud065_prepare_bundle() {
  command node "$AUD065_PREPARE_TOOL" prepare \
    --operation-directory "$AUD065_OPERATION_DIRECTORY" \
    --original-baseline "$AUD065_ORIGINAL_BASELINE" \
    --quiesced-baseline "$AUD065_QUIESCED_BASELINE" \
    --old-snapshot "$AUD065_OLD_SNAPSHOT" --new-snapshot "$AUD065_NEW_SNAPSHOT" \
    --revision-file "$AUD065_OPERATION_DIRECTORY/revision.json" \
    --operation-key "$AUD065_OPERATION_DIRECTORY/operation.key" \
    --bundle-directory "$AUD065_BUNDLE_DIRECTORY" || return 1
  aud065_crash_point after-bundle-prepare || return 1
  command node "$AUD065_PREPARE_TOOL" verify \
    --operation-directory "$AUD065_OPERATION_DIRECTORY" \
    --original-baseline "$AUD065_ORIGINAL_BASELINE" \
    --quiesced-baseline "$AUD065_QUIESCED_BASELINE" \
    --old-snapshot "$AUD065_OLD_SNAPSHOT" --new-snapshot "$AUD065_NEW_SNAPSHOT" \
    --revision-file "$AUD065_OPERATION_DIRECTORY/revision.json" \
    --operation-key "$AUD065_OPERATION_DIRECTORY/operation.key" \
    --bundle-directory "$AUD065_BUNDLE_DIRECTORY" || return 1
}

aud065_quiesce_preflight() {
  local name barrier_state=normal reentry=0
  aud065_discover_lock || return 1
  case "$RECOVERY_OPERATION_STATE" in
    quiesced|db-rotated|bundle-applied|verified|cleanup-authorized) return 0 ;;
    preflight) ;;
    *) return 1 ;;
  esac
  AUD065_FAILURE_STAGE="preflight-barrier"
  if [[ -e "$AUD065_OPERATION_DIRECTORY/barrier-binding.json" ||
        -L "$AUD065_OPERATION_DIRECTORY/barrier-binding.json" ]]; then
    reentry=1
    aud065_verify_preflight_live_boundary reentry || return 1
  else
    aud065_verify_preflight_live_boundary initial || return 1
  fi
  aud065_bind_or_adopt_barrier || return 1
  if [[ "$reentry" == 1 ]]; then
    barrier_state="$(aud065_pgsql_barrier_read_state)" || return 1
    [[ "$barrier_state" == normal || "$barrier_state" == closed ]] || return 1
  fi
  aud065_pgsql_probe_bind_image "$(aud065_probe_image)" || return 1
  aud065_pgsql_probe_create || return 1
  aud065_require_pgsql_probe_nonready_and_unroutable || return 1
  if [[ "$barrier_state" == normal ]]; then
    aud065_require_pgsql_probe_preclose_reachable aud065_probe_exec_status || return 1
  fi
  AUD065_FAILURE_STAGE="preflight-scale"
  for name in "${AUD065_ROTATION_DEPLOYMENTS[@]}"; do
    aud065_scale_one_to_zero "$name" || return 1
  done
  for name in "${AUD065_ROTATION_DEPLOYMENTS[@]}"; do
    recovery_wait_for_no_pods "app=$name" "$name" 180s || return 1
  done
  aud065_require_pgsql_consumers_and_pods_absent \
    aud065_consumers_absent_callback aud065_consumer_pods_absent_callback || return 1
  AUD065_FAILURE_STAGE="preflight-close"
  aud065_pgsql_barrier_close aud065_probe_blocked_three || return 1
  aud065_crash_point after-barrier-close || return 1
  aud065_require_no_pgsql_client_backends aud065_no_sessions_callback || return 1
  aud065_require_pgsql_unix_socket_local aud065_unix_socket_callback || return 1
  aud065_capture_or_reconcile_baseline "$AUD065_QUIESCED_BASELINE" || return 1
  aud065_prepare_bundle || return 1
  recovery_require_operation_lock || return 1
  recovery_transition_aud065_operation_lock quiesced || return 1
  aud065_crash_point after-lock-quiesced || return 1
}

aud065_reload_guard() {
  aud065_require_no_xtrace || return 1
  aud065_load_intent || return 1
  aud065_discover_lock || return 1
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  if [[ -e "$AUD065_OPERATION_DIRECTORY/barrier-binding.json" ||
        -L "$AUD065_OPERATION_DIRECTORY/barrier-binding.json" ]]; then
    aud065_load_barrier_binding 1 || return 1
  fi
}

aud065_cb_guard() {
  aud065_reload_guard || return 1
  [[ "$RECOVERY_OPERATION_STATE" =~ ^(preflight|quiesced|db-rotated|bundle-applied|verified|cleanup-authorized)$ ]]
}

aud065_cb_quiesce() {
  aud065_reload_guard || return 1
  aud065_quiesce_preflight || return 1
}

aud065_cb_assert_quiesced() {
  local state name
  aud065_reload_guard || return 1
  case "$RECOVERY_OPERATION_STATE" in
    quiesced|db-rotated)
      [[ "$(aud065_pgsql_barrier_read_state)" == closed ]] || return 1
      aud065_require_pgsql_consumers_and_pods_absent \
        aud065_consumers_absent_callback aud065_consumer_pods_absent_callback || return 1
      ;;
    bundle-applied)
      [[ "$(aud065_pgsql_barrier_read_state)" =~ ^(closed|open-verified)$ ]] || return 1
      for name in pgbouncer pgbouncer-t reticulum coturn dialog bot-orchestrator; do
        aud065_require_applied_or_started "$name" || return 1
      done
      ;;
    verified|cleanup-authorized)
      state="$(aud065_pgsql_barrier_read_state)" || return 1
      case "$state" in
        closed)
          aud065_require_pgsql_consumers_and_pods_absent \
            aud065_consumers_absent_callback aud065_consumer_pods_absent_callback || return 1
          aud065_require_no_pgsql_client_backends aud065_no_sessions_callback || return 1
          aud065_require_pgsql_unix_socket_local aud065_unix_socket_callback || return 1
          ;;
        open-verified)
          for name in pgbouncer pgbouncer-t reticulum coturn dialog bot-orchestrator; do
            aud065_require_applied_or_started "$name" || return 1
          done
          ;;
        normal)
          [[ "$RECOVERY_OPERATION_STATE" == cleanup-authorized ]] || return 1
          for name in pgbouncer pgbouncer-t reticulum coturn dialog bot-orchestrator; do
            aud065_require_applied_or_started "$name" || return 1
          done
          ;;
        *) return 1 ;;
      esac
      ;;
    *) return 1 ;;
  esac
}

aud065_cb_classify_role() {
  local role="$1"
  aud065_reload_guard || return 1
  [[ "$RECOVERY_OPERATION_STATE" != preflight ]] || return 1
  pldb_emit_classification_sql "$role" | aud065_psql_socket || return 1
}

aud065_cb_alter_role() {
  local role="$1"
  aud065_reload_guard || return 1
  [[ "$RECOVERY_OPERATION_STATE" == quiesced ]] || return 1
  pldb_emit_alter_sql "$role" | aud065_psql_socket >/dev/null 2>&1 || return 1
  aud065_crash_point after-alter-commit || return 1
}

aud065_cb_role_new() {
  aud065_reload_guard || return 1
  case "$RECOVERY_OPERATION_STATE" in
    quiesced)
      recovery_transition_aud065_operation_lock db-rotated || return 1
      aud065_crash_point after-lock-db-rotated || return 1
      ;;
    db-rotated|bundle-applied|verified|cleanup-authorized) ;;
    *) return 1 ;;
  esac
}

aud065_capture_private_baseline() {
  local output="$1"
  command node "$AUD065_CAPTURE_TOOL" --context "$EXPECTED_KUBE_CONTEXT" \
    --namespace "$NAMESPACE" --output "$output"
}

aud065_verify_preflight_live_boundary_in_scratch() {
  local scratch="$1" mode="$2" live result binding policy_uid policy_rv extra=""
  live="$scratch/preflight-live.json"
  aud065_capture_private_baseline "$live" || return 1
  result="$(command node --input-type=module - \
    "$AUD065_OPERATION_TOOL" "$AUD065_PUBLICATION_TOOL" "$AUD065_ROTATION_TOOL" \
    "$AUD065_OPERATION_DIRECTORY" "$AUD065_ORIGINAL_BASELINE" "$live" \
    "$mode" "$NAMESPACE" "$AUD065_PGSQL_POLICY_NAME" \
    "$RECOVERY_OPERATION_ID" "$RECOVERY_OPERATION_BINDING_SHA256" <<'NODE'
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

try {
  const [operationModulePath, publicationModulePath, rotationModulePath,
    operationDirectory, originalPath, livePath, mode, namespace,
    policyName, expectedOperationId,
    expectedOperationBindingSha256] = process.argv.slice(2);
  if (!new Set(["initial", "reentry"]).has(mode)) throw new Error();
  const operationModule = await import(pathToFileURL(operationModulePath));
  const publicationModule = await import(pathToFileURL(publicationModulePath));
  const rotationModule = await import(pathToFileURL(rotationModulePath));
  const intent = operationModule.loadVerifiedProcessLocalRotationIntent({
    operationDirectory, expectedOperationId, expectedOperationBindingSha256
  });
  const originalBytes = publicationModule.readPublishedPrivateArtifact({
    outputPath: originalPath,
    maximumBytes: 64 * 1024 * 1024
  });
  const liveBytes = publicationModule.readPublishedPrivateArtifact({
    outputPath: livePath,
    maximumBytes: 64 * 1024 * 1024
  });
  try {
    const originalSha = crypto.createHash("sha256").update(originalBytes).digest("hex");
    if (originalSha !== intent.originalBaselineSha256) throw new Error();
    const parse = bytes => {
      const text = bytes.toString("utf8");
      const value = JSON.parse(text);
      if (text !== `${rotationModule.canonicalJson(value)}\n` ||
          value?.apiVersion !== "v1" || value?.kind !== "List" ||
          !Array.isArray(value.items) || value.items.length !== 44) throw new Error();
      return value.items;
    };
    const original = parse(originalBytes);
    const live = parse(liveBytes);
    const key = item => [item?.apiVersion, item?.kind,
      item?.metadata?.namespace ?? "", item?.metadata?.name].join("\u0000");
    const liveByKey = new Map(live.map(item => [key(item), item]));
    if (liveByKey.size !== 44 || new Set(original.map(key)).size !== 44) throw new Error();
    const allowedReentryRvDrift = new Set([
      "bot-orchestrator", "reticulum", "coturn", "dialog", "pgbouncer", "pgbouncer-t"
    ].map(name => ["apps/v1", "Deployment", namespace, name].join("\u0000")));
    allowedReentryRvDrift.add(
      ["networking.k8s.io/v1", "NetworkPolicy", namespace, policyName].join("\u0000")
    );
    for (const expected of original) {
      const actual = liveByKey.get(key(expected));
      if (!actual || typeof expected?.metadata?.uid !== "string" ||
          typeof expected?.metadata?.resourceVersion !== "string" ||
          actual?.metadata?.uid !== expected.metadata.uid ||
          (actual?.metadata?.resourceVersion !== expected.metadata.resourceVersion &&
            (mode !== "reentry" || !allowedReentryRvDrift.has(key(expected))))) {
        throw new Error();
      }
    }
    process.stdout.write(`preflight-baseline-${mode}-verified\n`);
  } finally {
    originalBytes.fill(0);
    liveBytes.fill(0);
  }
} catch {
  process.stderr.write("preflight baseline verification failed closed\n");
  process.exitCode = 1;
}
NODE
  )" || return 1
  [[ "$result" == "preflight-baseline-${mode}-verified" ]] || return 1
  binding="$(aud065_operation_tool emit-baseline \
    --operation-directory "$AUD065_OPERATION_DIRECTORY" \
    --expected-operation-id "$RECOVERY_OPERATION_ID" \
    --expected-operation-binding-sha256 "$RECOVERY_OPERATION_BINDING_SHA256" \
    --mode pgsql-policy-binding)" || return 1
  IFS=$'\t' read -r policy_uid policy_rv extra <<<"$binding"
  [[ -n "$policy_uid" && -n "$policy_rv" && -z "$extra" ]] || return 1
  AUD065_ORIGINAL_PGSQL_POLICY_UID="$policy_uid"
  AUD065_ORIGINAL_PGSQL_POLICY_RESOURCE_VERSION="$policy_rv"
  export AUD065_ORIGINAL_PGSQL_POLICY_UID AUD065_ORIGINAL_PGSQL_POLICY_RESOURCE_VERSION
}

aud065_verify_preflight_live_boundary() {
  local mode="${1:-initial}"
  [[ "$mode" == initial || "$mode" == reentry ]] || return 2
  aud065_with_scratch_directory aud065_verify_preflight_live_boundary_in_scratch \
    "$mode"
}

aud065_capture_baseline_in_scratch() {
  local scratch="$1" destination="$2" captured="$1/baseline.json"
  aud065_capture_private_baseline "$captured" || return 1
  aud065_publish_private_file "$captured" "$destination" || return 1
}

aud065_capture_or_reconcile_baseline() {
  local destination="$1"
  if [[ -e "$destination" || -L "$destination" ]]; then
    aud065_reconcile_private_file "$destination"
    return
  fi
  aud065_with_scratch_directory aud065_capture_baseline_in_scratch "$destination"
}

aud065_project_private_values() {
  local source="$1" destination="$2"
  command node "$AUD065_PROJECT_TOOL" "$source" "$destination"
}

aud065_make_scratch_directory() {
  local output_variable="${1:-}" template directory identity index existing
  [[ "$output_variable" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] || return 2
  aud065_require_private_directory "$AUD065_OPERATION_DIRECTORY" || return 1
  [[ "${#AUD065_SCRATCH_DIRECTORIES[@]}" == 0 ]] || return 1
  existing="$(find "$AUD065_OPERATION_DIRECTORY" -mindepth 1 -maxdepth 1 \
    -name '.scratch.*' -print -quit)" || return 1
  [[ -z "$existing" ]] || return 1
  template="$AUD065_OPERATION_DIRECTORY/.scratch.XXXXXX"
  directory="$(mktemp -d "$template")" || return 1
  identity="$(aud065_device_inode "$directory")" || {
    rmdir "$directory" >/dev/null 2>&1 || :
    return 1
  }
  index="$AUD065_NEXT_SCRATCH_INDEX"
  AUD065_NEXT_SCRATCH_INDEX=$((AUD065_NEXT_SCRATCH_INDEX + 1))
  AUD065_SCRATCH_DIRECTORIES[index]="$directory"
  AUD065_SCRATCH_IDENTITIES[index]="$identity"
  if ! chmod 700 "$directory" ||
     ! aud065_require_private_directory "$directory" ||
     [[ "$(aud065_device_inode "$directory")" != "$identity" ]]; then
    aud065_cleanup_scratch_directory "$directory" >/dev/null 2>&1 || :
    return 1
  fi
  printf -v "$output_variable" '%s' "$directory"
}

aud065_cleanup_scratch_directory() {
  local directory="${1:-}" index="" candidate identity current entry
  [[ "$directory" == "$AUD065_OPERATION_DIRECTORY"/.scratch.* ]] || return 2
  for candidate in "${!AUD065_SCRATCH_DIRECTORIES[@]}"; do
    if [[ "${AUD065_SCRATCH_DIRECTORIES[candidate]:-}" == "$directory" ]]; then
      [[ -z "$index" ]] || return 1
      index="$candidate"
    fi
  done
  [[ -n "$index" ]] || return 1
  identity="${AUD065_SCRATCH_IDENTITIES[index]:-}"
  [[ "$identity" =~ ^[0-9]+:[0-9]+$ ]] || return 1
  aud065_require_private_directory "$directory" || return 1
  current="$(aud065_device_inode "$directory")" || return 1
  [[ "$current" == "$identity" ]] || return 1
  while IFS= read -r -d '' entry; do
    [[ -f "$entry" && ! -L "$entry" ]] || return 1
    [[ "$(aud065_owner "$entry")" == "$(id -u)" &&
       "$(aud065_link_count "$entry")" == 1 ]] || return 1
    [[ "$(aud065_device_inode "$directory")" == "$identity" ]] || return 1
    rm -f -- "$entry" || return 1
  done < <(find "$directory" -mindepth 1 -maxdepth 1 -print0)
  [[ "$(aud065_device_inode "$directory")" == "$identity" ]] || return 1
  rmdir "$directory" || return 1
  unset 'AUD065_SCRATCH_DIRECTORIES[index]'
  unset 'AUD065_SCRATCH_IDENTITIES[index]'
}

aud065_cleanup_all_scratch_directories() {
  local index directory failed=0
  for index in "${!AUD065_SCRATCH_DIRECTORIES[@]}"; do
    directory="${AUD065_SCRATCH_DIRECTORIES[index]:-}"
    [[ -n "$directory" ]] || continue
    aud065_cleanup_scratch_directory "$directory" || failed=1
  done
  [[ "$failed" == 0 ]]
}

aud065_with_scratch_directory() {
  local callback="${1:-}" scratch="" status=0 cleanup_status=0
  [[ "$callback" =~ ^aud065_[a-zA-Z0-9_]+$ ]] || return 2
  shift
  aud065_make_scratch_directory scratch || return 1
  if "$callback" "$scratch" "$@"; then status=0; else status=$?; fi
  if aud065_cleanup_scratch_directory "$scratch"; then
    cleanup_status=0
  else
    cleanup_status=$?
  fi
  [[ "$status" == 0 ]] || return "$status"
  [[ "$cleanup_status" == 0 ]] || return "$cleanup_status"
}

# Capture an external producer into one inode opened before any sensitive byte
# is requested. FD 9 remains pinned across the supervised producer and the
# publisher; a failed producer is wiped and can never create the final path.
aud065_open_private_capture_fd() {
  local directory="$1" file expected opened current
  [[ -z "$AUD065_CAPTURE_FILE" && -z "$AUD065_CAPTURE_IDENTITY" ]] || return 1
  aud065_require_private_directory "$directory" || return 1
  file="$(mktemp "$directory/.external-capture.XXXXXX")" || return 1
  chmod 600 "$file" || return 1
  [[ -f "$file" && ! -L "$file" && ! -s "$file" ]] || return 1
  [[ "$(aud065_mode "$file")" == 600 &&
     "$(aud065_owner "$file")" == "$(id -u)" &&
     "$(aud065_link_count "$file")" == 1 ]] || return 1
  expected="$(aud065_device_inode "$file")" || return 1
  exec 9<>"$file" || return 1
  # shellcheck disable=SC2016
  opened="$(command node --input-type=module --eval '
    import fs from "node:fs";
    const value = fs.fstatSync(9, { bigint: true });
    process.stdout.write(`${value.dev}:${value.ino}\n`);
  ' 9<&9)" || { exec 9>&-; return 1; }
  current="$(aud065_device_inode "$file")" || { exec 9>&-; return 1; }
  if [[ "$opened" != "$expected" || "$current" != "$expected" ]]; then
    exec 9>&-
    return 1
  fi
  # Unlink the still-empty capture before requesting external bytes. The open
  # descriptor remains the only capability; a crash can therefore leave no
  # sensitive scratch pathname. The helper verifies that the exact FD inode
  # lost its sole link and fsyncs the owner-private parent directory.
  # shellcheck disable=SC2016
  if ! command node --input-type=module --eval '
    import fs from "node:fs";
    const [file, directory, identity] = process.argv.slice(1);
    const descriptor = 9;
    const before = fs.fstatSync(descriptor, { bigint: true });
    const leaf = fs.lstatSync(file, { bigint: true });
    const same = value => `${value.dev}:${value.ino}` === identity;
    const uid = typeof process.getuid !== "function" ||
      before.uid === BigInt(process.getuid());
    if (!before.isFile() || !leaf.isFile() || before.isSymbolicLink() ||
        leaf.isSymbolicLink() || !uid || !same(before) || !same(leaf) ||
        before.size !== 0n || leaf.size !== 0n || before.nlink !== 1n ||
        leaf.nlink !== 1n || Number(before.mode & 0o7777n) !== 0o600 ||
        Number(leaf.mode & 0o7777n) !== 0o600) process.exit(1);
    const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY |
      fs.constants.O_NOFOLLOW;
    const parentFd = fs.openSync(directory, flags);
    try {
      const parent = fs.fstatSync(parentFd, { bigint: true });
      const parentUid = typeof process.getuid !== "function" ||
        parent.uid === BigInt(process.getuid());
      if (!parent.isDirectory() || parent.isSymbolicLink() || !parentUid ||
          Number(parent.mode & 0o7777n) !== 0o700) process.exit(1);
      fs.unlinkSync(file);
      fs.fsyncSync(parentFd);
      const after = fs.fstatSync(descriptor, { bigint: true });
      if (!same(after) || after.nlink !== 0n || after.size !== 0n) process.exit(1);
      try { fs.lstatSync(file); process.exit(1); }
      catch (error) { if (error?.code !== "ENOENT") process.exit(1); }
    } finally {
      fs.closeSync(parentFd);
    }
  ' "$file" "$directory" "$expected" 9<&9; then
    exec 9>&-
    return 1
  fi
  AUD065_CAPTURE_FILE="$file"
  AUD065_CAPTURE_IDENTITY="$expected"
  export AUD065_CAPTURE_FILE AUD065_CAPTURE_IDENTITY
}

aud065_process_private_capture_fd() {
  local action="$1" destination="${2:--}"
  [[ "$action" == publish || "$action" == wipe ]] || return 2
  [[ "$AUD065_CAPTURE_IDENTITY" =~ ^[0-9]+:[0-9]+$ ]] || return 1
  command node --input-type=module - \
    "$AUD065_PUBLICATION_TOOL" "$action" "$destination" \
    "$AUD065_CAPTURE_IDENTITY" <<'NODE'
import crypto from "node:crypto";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

let owned = false;
let bytes;
try {
  const [modulePath, action, destination, identity] = process.argv.slice(2);
  if (!["publish", "wipe"].includes(action) || !/^[0-9]+:[0-9]+$/u.test(identity)) {
    throw new Error();
  }
  const descriptor = 9;
  const before = fs.fstatSync(descriptor, { bigint: true });
  const actualIdentity = `${before.dev}:${before.ino}`;
  const currentUid = typeof process.getuid !== "function" ||
    before.uid === BigInt(process.getuid());
  if (!before.isFile() || before.isSymbolicLink() || !currentUid ||
      Number(before.mode & 0o7777n) !== 0o600 || before.nlink !== 0n ||
      before.size > 1048576n || actualIdentity !== identity) throw new Error();
  owned = true;
  if (action === "publish") {
    if (before.size < 1n) throw new Error();
    const size = Number(before.size);
    const readExact = () => {
      const value = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const count = fs.readSync(descriptor, value, offset, size - offset, offset);
        if (count <= 0) throw new Error();
        offset += count;
      }
      return value;
    };
    bytes = readExact();
    const second = readExact();
    const after = fs.fstatSync(descriptor, { bigint: true });
    const digest = value => crypto.createHash("sha256").update(value).digest();
    if (`${after.dev}:${after.ino}` !== identity || after.nlink !== 0n ||
        after.size !== before.size || after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs ||
        !crypto.timingSafeEqual(digest(bytes), digest(second))) throw new Error();
    second.fill(0);
    const { publishPrivateArtifact } = await import(pathToFileURL(modulePath));
    publishPrivateArtifact({
      outputPath: destination,
      bytes,
      maximumBytes: 1048576
    });
  }
} catch {
  process.stderr.write("private external capture failed closed\n");
  process.exitCode = 1;
} finally {
  if (bytes) bytes.fill(0);
  if (owned) {
    try { fs.ftruncateSync(9, 0); fs.fsyncSync(9); } catch { process.exitCode = 1; }
  }
}
NODE
}

aud065_close_private_capture_fd() {
  exec 9>&-
  AUD065_CAPTURE_FILE=""
  AUD065_CAPTURE_IDENTITY=""
  export AUD065_CAPTURE_FILE AUD065_CAPTURE_IDENTITY
}

aud065_cleanup_private_ephemera() {
  local failed=0
  if [[ -n "$AUD065_CAPTURE_FILE" || -n "$AUD065_CAPTURE_IDENTITY" ]]; then
    aud065_process_private_capture_fd wipe >/dev/null 2>&1 || failed=1
    aud065_close_private_capture_fd >/dev/null 2>&1 || failed=1
  fi
  aud065_cleanup_all_scratch_directories >/dev/null 2>&1 || failed=1
  [[ "$failed" == 0 ]]
}

# The shared publisher owns the one durable publication protocol used by all
# AUD-065 artifacts. Input bytes travel only on stdin; the destination is a
# private absolute path and is never opened for in-place writing.
aud065_publish_private_file() {
  local source="$1" destination="$2"
  aud065_require_private_directory "$AUD065_OPERATION_DIRECTORY" || return 1
  aud065_is_absolute "$source" || return 1
  aud065_is_absolute "$destination" || return 1
  [[ "$(dirname "$destination")" == "$AUD065_OPERATION_DIRECTORY" ]] || return 1
  command node --input-type=module - \
    "$AUD065_PUBLICATION_TOOL" "$source" "$destination" <<'NODE'
import { pathToFileURL } from "node:url";
try {
  const [modulePath, source, destination] = process.argv.slice(2);
  const { publishPrivateArtifact, readPublishedPrivateArtifact } =
    await import(pathToFileURL(modulePath));
  const bytes = readPublishedPrivateArtifact({
    outputPath: source,
    maximumBytes: 64 * 1024 * 1024
  });
  try {
    publishPrivateArtifact({
      outputPath: destination,
      bytes,
      maximumBytes: 64 * 1024 * 1024
    });
  } finally {
    bytes.fill(0);
  }
} catch {
  process.stderr.write("private artifact publication failed closed\n");
  process.exitCode = 1;
}
NODE
}

aud065_reconcile_private_file() {
  aud065_publish_private_file "$1" "$1"
}

aud065_materialize_replacements() {
  command node "$AUD065_MATERIALIZE_TOOL" materialize \
    --operation-directory "$AUD065_OPERATION_DIRECTORY" \
    --expected-operation-id "$RECOVERY_OPERATION_ID" \
    --expected-operation-binding-sha256 "$RECOVERY_OPERATION_BINDING_SHA256" \
    --quiesced-baseline "$AUD065_QUIESCED_BASELINE" --bundle "$AUD065_BUNDLE" \
    --binding "$AUD065_BUNDLE_BINDING" \
    --operation-key "$AUD065_OPERATION_DIRECTORY/operation.key" \
    --output-directory "$AUD065_REPLACEMENTS_DIRECTORY" || return 1
  aud065_crash_point after-materialize-replacements || return 1
  command node "$AUD065_MATERIALIZE_TOOL" verify \
    --operation-directory "$AUD065_OPERATION_DIRECTORY" \
    --expected-operation-id "$RECOVERY_OPERATION_ID" \
    --expected-operation-binding-sha256 "$RECOVERY_OPERATION_BINDING_SHA256" \
    --quiesced-baseline "$AUD065_QUIESCED_BASELINE" --bundle "$AUD065_BUNDLE" \
    --binding "$AUD065_BUNDLE_BINDING" \
    --operation-key "$AUD065_OPERATION_DIRECTORY/operation.key" \
    --output-directory "$AUD065_REPLACEMENTS_DIRECTORY" || return 1
}

aud065_replacement_names() {
  printf '%s\n' \
    00-secret-configs.json \
    01-secret-ghcr-pull.json \
    02-deployment-bot-orchestrator.json \
    03-deployment-coturn.json \
    04-deployment-dialog.json \
    05-deployment-pgbouncer.json \
    06-deployment-pgbouncer-t.json \
    07-deployment-reticulum.json
}

aud065_classify_bundle_iteration_in_scratch() {
  local scratch="$1" index="$2" previous_pending="$3"
  local live="$1/live-$2.json" plan pending already
  aud065_capture_private_baseline "$live" || return 1
  plan="$(command node "$AUD065_MATERIALIZE_TOOL" classify \
    --operation-directory "$AUD065_OPERATION_DIRECTORY" \
    --expected-operation-id "$RECOVERY_OPERATION_ID" \
    --expected-operation-binding-sha256 "$RECOVERY_OPERATION_BINDING_SHA256" \
    --quiesced-baseline "$AUD065_QUIESCED_BASELINE" --bundle "$AUD065_BUNDLE" \
    --binding "$AUD065_BUNDLE_BINDING" \
    --operation-key "$AUD065_OPERATION_DIRECTORY/operation.key" \
    --live-baseline "$live")" || return 1
  pending="$(jq -er '.pendingCount' <<<"$plan")" || return 1
  already="$(jq -er '.alreadyAppliedCount' <<<"$plan")" || return 1
  [[ "$pending" =~ ^[0-8]$ && "$already" =~ ^[0-8]$ &&
     $((pending + already)) == 8 && "$pending" -lt "$previous_pending" ]] || return 1
  # Reentry is accepted only for an applied prefix; a partial out-of-order
  # cut is not attributed to this coordinator.
  jq -e '
    . as $plan |
    ([.resources[].state] ==
      (([range(0;$plan.alreadyAppliedCount)] | map("already-applied")) +
       ([range(0;$plan.pendingCount)] | map("pending"))))
  ' <<<"$plan" >/dev/null || return 1
  if [[ "$pending" == 0 ]]; then
    command node "$AUD065_MATERIALIZE_TOOL" extract-applied \
      --operation-directory "$AUD065_OPERATION_DIRECTORY" \
      --expected-operation-id "$RECOVERY_OPERATION_ID" \
      --expected-operation-binding-sha256 "$RECOVERY_OPERATION_BINDING_SHA256" \
      --quiesced-baseline "$AUD065_QUIESCED_BASELINE" --bundle "$AUD065_BUNDLE" \
      --binding "$AUD065_BUNDLE_BINDING" \
      --operation-key "$AUD065_OPERATION_DIRECTORY/operation.key" \
      --live-baseline "$live" --output "$AUD065_APPLIED_RESOURCES" || return 1
    aud065_require_private_file "$AUD065_APPLIED_RESOURCES" || return 1
    [[ "$(aud065_link_count "$AUD065_APPLIED_RESOURCES")" == 1 ]] || return 1
  fi
  AUD065_BUNDLE_ITERATION_PENDING="$pending"
  AUD065_BUNDLE_ITERATION_ALREADY="$already"
}

aud065_apply_bundle_exact() {
  local pending already index candidate
  local expected_pending previous_pending
  aud065_reload_guard || return 1
  case "$RECOVERY_OPERATION_STATE" in
    bundle-applied|verified|cleanup-authorized) return 0 ;;
    db-rotated) ;;
    *) return 1 ;;
  esac
  aud065_materialize_replacements || return 1
  index=0
  previous_pending=9
  while ((index < 9)); do
    AUD065_BUNDLE_ITERATION_PENDING=""
    AUD065_BUNDLE_ITERATION_ALREADY=""
    aud065_with_scratch_directory aud065_classify_bundle_iteration_in_scratch \
      "$index" "$previous_pending" || return 1
    pending="$AUD065_BUNDLE_ITERATION_PENDING"
    already="$AUD065_BUNDLE_ITERATION_ALREADY"
    if [[ "$pending" == 0 ]]; then
      break
    fi
    expected_pending="$pending"
    candidate="$(aud065_replacement_names | sed -n "$((already + 1))p")"
    [[ -n "$candidate" ]] || return 1
    recovery_require_operation_lock || return 1
    recovery_require_operation_serialization || return 1
    command node "$AUD065_MATERIALIZE_TOOL" emit-verified \
      --operation-directory "$AUD065_OPERATION_DIRECTORY" \
      --expected-operation-id "$RECOVERY_OPERATION_ID" \
      --expected-operation-binding-sha256 "$RECOVERY_OPERATION_BINDING_SHA256" \
      --quiesced-baseline "$AUD065_QUIESCED_BASELINE" --bundle "$AUD065_BUNDLE" \
      --binding "$AUD065_BUNDLE_BINDING" \
      --operation-key "$AUD065_OPERATION_DIRECTORY/operation.key" \
      --output-directory "$AUD065_REPLACEMENTS_DIRECTORY" --name "$candidate" \
      --stream-purpose coordinator-cas-stream |
      recovery_kubectl_mutate replace -f - -o json >/dev/null || return 1
    recovery_require_operation_lock || return 1
    recovery_require_operation_serialization || return 1
    aud065_crash_point "after-replace-${candidate%.json}" || return 1
    index=$((index + 1))
    previous_pending="$expected_pending"
  done
  [[ -f "$AUD065_APPLIED_RESOURCES" ]] || return 1
  aud065_reload_guard || return 1
  [[ "$RECOVERY_OPERATION_STATE" == db-rotated ]] || return 1
  recovery_transition_aud065_operation_lock bundle-applied || return 1
  aud065_crash_point after-lock-bundle-applied || return 1
}

aud065_cb_apply() {
  aud065_apply_bundle_exact
}

aud065_applied_deployment_contract() {
  local name="$1"
  command node "$AUD065_MATERIALIZE_TOOL" emit-deployment-contract \
    --operation-directory "$AUD065_OPERATION_DIRECTORY" \
    --expected-operation-id "$RECOVERY_OPERATION_ID" \
    --expected-operation-binding-sha256 "$RECOVERY_OPERATION_BINDING_SHA256" \
    --quiesced-baseline "$AUD065_QUIESCED_BASELINE" --bundle "$AUD065_BUNDLE" \
    --binding "$AUD065_BUNDLE_BINDING" \
    --operation-key "$AUD065_OPERATION_DIRECTORY/operation.key" \
    --deployment "$name"
}

aud065_require_applied_or_started() {
  local name="$1" expected uid baseline_rv _replicas selector fingerprint
  local current current_uid current_rv current_replicas current_selector current_fingerprint
  expected="$(aud065_applied_deployment_contract "$name")" || return 1
  IFS=$'\t' read -r uid baseline_rv _replicas selector fingerprint <<<"$expected"
  current="$(aud065_capture_deployment_contract "$name")" || return 1
  IFS=$'\t' read -r current_uid current_rv current_replicas current_selector \
    current_fingerprint <<<"$current"
  [[ "$current_uid" == "$uid" && "$current_selector" == "$selector" &&
     "$current_fingerprint" == "$fingerprint" &&
     "$current_rv" != "$baseline_rv" ]] || return 1
  if [[ "$current_replicas" == 0 ]]; then
    return 0
  elif [[ "$current_replicas" == 1 ]]; then
    return 0
  else
    return 1
  fi
}

aud065_scale_one_to_original() {
  local name="$1" expected uid baseline_rv applied_replicas selector fingerprint
  local current current_uid current_rv current_replicas current_selector current_fingerprint
  expected="$(aud065_applied_deployment_contract "$name")" || return 1
  IFS=$'\t' read -r uid baseline_rv applied_replicas selector fingerprint <<<"$expected"
  [[ "$applied_replicas" == 0 ]] || return 1
  current="$(aud065_capture_deployment_contract "$name")" || return 1
  IFS=$'\t' read -r current_uid current_rv current_replicas current_selector \
    current_fingerprint <<<"$current"
  [[ "$current_uid" == "$uid" && "$current_selector" == "$selector" &&
    "$current_fingerprint" == "$fingerprint" ]] || return 1
  case "$current_replicas" in
    0)
      [[ "$current_rv" != "$baseline_rv" ]] || return 1
      aud065_scale_deployment_exact "$name" "$uid" "$current_rv" 0 1 \
        "$selector" "$fingerprint" >/dev/null || return 1
      aud065_crash_point "after-restart-$name" || return 1
      ;;
    1)
      [[ "$current_rv" != "$baseline_rv" ]] || return 1
      recovery_require_operation_lock || return 1
      ;;
    *) return 1 ;;
  esac
  recovery_wait_for_deployment_rollout "$name" 300 || return 1
  aud065_require_deployment_contract "$name" "$uid" 1 "$selector" "$fingerprint" || return 1
}

aud065_probe_fresh_auth() {
  local generation="$1" host="$2" expectation="$3"
  local probe_name identifiers role database verdict
  [[ "$generation" == old || "$generation" == new ]] || return 2
  [[ "$host" == pgbouncer || "$host" == pgbouncer-t ]] || return 2
  [[ "$expectation" == accept || "$expectation" == reject ]] || return 2
  probe_name="$(aud065_pgsql_probe_name)" || return 1
  identifiers="$(aud065_runtime_identifiers)" || return 1
  IFS=$'\t' read -r role database <<<"$identifiers"
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  # The single-quoted program is intentionally evaluated inside the probe.
  # shellcheck disable=SC2016
  if verdict="$(aud065_emit_runtime_password "$generation" |
    recovery_kubectl_stream_guarded 30 exec -i "$probe_name" -n "$NAMESPACE" \
      -c probe -- sh -c '
        set +x
        IFS= read -r password || exit 90
        export PGPASSWORD="$password" PGPASSFILE=/dev/null
        password=
        command -v psql >/dev/null 2>&1 || exit 91
        command -v pg_isready >/dev/null 2>&1 || exit 91
        pg_isready -q -h "$1" -p 5432 -d "$3" -t 5 >/dev/null 2>&1 || exit 92
        status=0
        error_text="$(psql -X --no-psqlrc -qAt --no-password -h "$1" -p 5432 \
          -U "$2" -d "$3" -c "SELECT 1" 2>&1 >/dev/null)" || status=$?
        [ "${#error_text}" -le 8192 ] || exit 95
        pg_isready -q -h "$1" -p 5432 -d "$3" -t 5 >/dev/null 2>&1 || exit 93
        case "$4:$status" in
          accept:0) error_text=; printf "auth-accepted\n" ;;
          reject:0) error_text=; exit 94 ;;
          reject:*)
            case "$error_text" in
              *"password authentication failed for user"*) ;;
              *) error_text=; exit 95 ;;
            esac
            error_text=
            printf "auth-rejected\n"
            ;;
          *) error_text=; exit 96 ;;
        esac
      ' sh "$host" "$role" "$database" "$expectation" 2>/dev/null)"; then
    :
  else
    return 1
  fi
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  if [[ "$expectation" == accept ]]; then
    [[ "$verdict" == auth-accepted ]]
  else
    [[ "$verdict" == auth-rejected ]]
  fi
}

# Once the policy has returned to normal the dedicated probe is intentionally
# unroutable. Reentry therefore revalidates the role over PostgreSQL TCP
# loopback from the pgsql pod itself; Unix-socket peer/trust auth is not used.
aud065_pgsql_local_tcp_auth() {
  local generation="$1" expectation="$2" info pod_name role identifiers _role database verdict
  [[ "$generation" == old || "$generation" == new ]] || return 2
  [[ "$expectation" == accept || "$expectation" == reject ]] || return 2
  info="$(aud065_pgsql_pod_and_role)" || return 1
  IFS=$'\t' read -r pod_name role <<<"$info"
  identifiers="$(aud065_runtime_identifiers)" || return 1
  IFS=$'\t' read -r _role database <<<"$identifiers"
  [[ "$role" == "$_role" ]] || return 1
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  # shellcheck disable=SC2016
  if verdict="$(aud065_emit_runtime_password "$generation" |
    recovery_kubectl_stream_guarded 30 exec -i "$pod_name" -n "$NAMESPACE" \
      -c postgresql -- sh -c '
        set +x
        IFS= read -r password || exit 90
        export PGPASSWORD="$password" PGPASSFILE=/dev/null PGCONNECT_TIMEOUT=5
        password=
        command -v psql >/dev/null 2>&1 || exit 91
        command -v pg_isready >/dev/null 2>&1 || exit 91
        pg_isready -q -h 127.0.0.1 -p 5432 -d "$2" -t 5 \
          >/dev/null 2>&1 || exit 92
        status=0
        error_text="$(psql -X --no-psqlrc -qAt --no-password -h 127.0.0.1 -p 5432 \
          -U "$1" -d "$2" -c "SELECT 1" 2>&1 >/dev/null)" || status=$?
        [ "${#error_text}" -le 8192 ] || exit 95
        pg_isready -q -h 127.0.0.1 -p 5432 -d "$2" -t 5 \
          >/dev/null 2>&1 || exit 93
        case "$3:$status" in
          accept:0) error_text=; printf "auth-accepted\n" ;;
          reject:0) error_text=; exit 94 ;;
          reject:*)
            case "$error_text" in
              *"password authentication failed for user"*) ;;
              *) error_text=; exit 95 ;;
            esac
            error_text=
            printf "auth-rejected\n"
            ;;
          *) error_text=; exit 96 ;;
        esac
      ' sh "$role" "$database" "$expectation" 2>/dev/null)"; then
    :
  else
    return 1
  fi
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock || return 1
  if [[ "$expectation" == accept ]]; then
    [[ "$verdict" == auth-accepted ]]
  else
    [[ "$verdict" == auth-rejected ]]
  fi
}

aud065_verify_local_tcp_cleanup_gate() {
  aud065_pgsql_local_tcp_auth new accept || return 1
  aud065_pgsql_local_tcp_auth old reject || return 1
  aud065_pgsql_local_tcp_auth new accept || return 1
}

aud065_cb_start_pools() {
  local state
  aud065_reload_guard || return 1
  aud065_verify_ghcr_snapshot_access "$AUD065_NEW_SNAPSHOT" || return 1
  case "$RECOVERY_OPERATION_STATE" in
    bundle-applied)
      aud065_pgsql_probe_bind_image "$(aud065_probe_image)" || return 1
      aud065_pgsql_probe_create || return 1
      aud065_require_pgsql_probe_nonready_and_unroutable || return 1
      aud065_pgsql_barrier_open aud065_probe_exec_status || return 1
      aud065_crash_point after-barrier-open || return 1
      aud065_scale_one_to_original pgbouncer || return 1
      aud065_scale_one_to_original pgbouncer-t || return 1
      ;;
    verified|cleanup-authorized)
      state="$(aud065_pgsql_barrier_read_state)" || return 1
      case "$state" in
        closed|open-verified)
          aud065_pgsql_probe_bind_image "$(aud065_probe_image)" || return 1
          aud065_pgsql_probe_create || return 1
          aud065_require_pgsql_probe_nonready_and_unroutable || return 1
          aud065_pgsql_barrier_open aud065_probe_exec_status || return 1
          aud065_scale_one_to_original pgbouncer || return 1
          aud065_scale_one_to_original pgbouncer-t || return 1
          ;;
        normal)
          [[ "$RECOVERY_OPERATION_STATE" == cleanup-authorized ]] || return 1
          aud065_scale_one_to_original pgbouncer || return 1
          aud065_scale_one_to_original pgbouncer-t || return 1
          ;;
        *) return 1 ;;
      esac
      ;;
    *) return 1 ;;
  esac
}

aud065_cb_verify_pools() {
  local state
  aud065_reload_guard || return 1
  case "$RECOVERY_OPERATION_STATE" in
    bundle-applied)
      [[ "$(aud065_pgsql_barrier_read_state)" == open-verified ]] || return 1
      aud065_probe_fresh_auth new pgbouncer accept || return 1
      aud065_probe_fresh_auth old pgbouncer reject || return 1
      aud065_probe_fresh_auth new pgbouncer accept || return 1
      aud065_probe_fresh_auth new pgbouncer-t accept || return 1
      aud065_probe_fresh_auth old pgbouncer-t reject || return 1
      aud065_probe_fresh_auth new pgbouncer-t accept || return 1
      ;;
    verified|cleanup-authorized)
      state="$(aud065_pgsql_barrier_read_state)" || return 1
      case "$state" in
        open-verified)
          aud065_probe_fresh_auth new pgbouncer accept || return 1
          aud065_probe_fresh_auth old pgbouncer reject || return 1
          aud065_probe_fresh_auth new pgbouncer accept || return 1
          aud065_probe_fresh_auth new pgbouncer-t accept || return 1
          aud065_probe_fresh_auth old pgbouncer-t reject || return 1
          aud065_probe_fresh_auth new pgbouncer-t accept || return 1
          ;;
        normal)
          [[ "$RECOVERY_OPERATION_STATE" == cleanup-authorized ]] || return 1
          aud065_verify_local_tcp_cleanup_gate || return 1
          ;;
        *) return 1 ;;
      esac
      ;;
    *) return 1 ;;
  esac
}

aud065_cb_start_consumers() {
  aud065_reload_guard || return 1
  case "$RECOVERY_OPERATION_STATE" in
    bundle-applied)
      aud065_scale_one_to_original reticulum || return 1
      aud065_scale_one_to_original coturn || return 1
      aud065_scale_one_to_original dialog || return 1
      aud065_scale_one_to_original bot-orchestrator || return 1
      recovery_require_live_images_match_checkpoint \
        "$AUD065_CHECKPOINT_DIRECTORY/deployment-images.json" || return 1
      ;;
    verified|cleanup-authorized)
      aud065_scale_one_to_original reticulum || return 1
      aud065_scale_one_to_original coturn || return 1
      aud065_scale_one_to_original dialog || return 1
      aud065_scale_one_to_original bot-orchestrator || return 1
      recovery_require_live_images_match_checkpoint \
        "$AUD065_CHECKPOINT_DIRECTORY/deployment-images.json" || return 1
      ;;
    *) return 1 ;;
  esac
}

aud065_ready_pod_name() {
  local deployment="$1" app="$2" pods info pod_name _pod_uid _deployment_uid
  pods="$(recovery_kubectl get pod -n "$NAMESPACE" -l "app=$app" -o json)" || return 1
  info="$(recovery_exact_ready_deployment_pod_info "$pods" "$app" "$deployment")" || return 1
  IFS=$'\t' read -r pod_name _pod_uid _deployment_uid <<<"$info"
  printf '%s\n' "$pod_name"
}

aud065_capture_public_material_in_scratch() {
  local scratch="$1" pod="$2" kind="$3" destination="$4"
  aud065_open_private_capture_fd "$scratch" || return 1
  case "$kind" in
    reticulum)
      # Expansion belongs to the remote container.
      # shellcheck disable=SC2016
      if ! recovery_kubectl_stream_guarded 30 exec "$pod" -n "$NAMESPACE" \
        -c postgrest -- sh -c 'set +x; printf "%s\n" "$PGRST_JWT_SECRET"' \
        >&9; then
        aud065_process_private_capture_fd wipe >/dev/null 2>&1 || :
        aud065_close_private_capture_fd || :
        return 1
      fi
      ;;
    dialog)
      if ! recovery_kubectl_stream_guarded 30 exec "$pod" -n "$NAMESPACE" \
        -c dialog -- sh -c 'set +x; exec cat /app/certs/perms.pub.pem' \
        >&9; then
        aud065_process_private_capture_fd wipe >/dev/null 2>&1 || :
        aud065_close_private_capture_fd || :
        return 1
      fi
      ;;
    *)
      aud065_process_private_capture_fd wipe >/dev/null 2>&1 || :
      aud065_close_private_capture_fd || :
      return 2
      ;;
  esac
  if ! aud065_process_private_capture_fd publish "$destination"; then
    aud065_process_private_capture_fd wipe >/dev/null 2>&1 || :
    aud065_close_private_capture_fd || :
    return 1
  fi
  aud065_close_private_capture_fd || return 1
}

aud065_capture_public_material() {
  local reticulum_path="$AUD065_OPERATION_DIRECTORY/reticulum-runtime.jwk"
  local dialog_path="$AUD065_OPERATION_DIRECTORY/dialog-runtime-public.pem"
  local reticulum_pod dialog_pod
  if [[ -e "$reticulum_path" || -L "$reticulum_path" ]]; then
    aud065_reconcile_private_file "$reticulum_path" || return 1
  else
    reticulum_pod="$(aud065_ready_pod_name reticulum reticulum)" || return 1
    aud065_with_scratch_directory aud065_capture_public_material_in_scratch \
      "$reticulum_pod" reticulum "$reticulum_path" || return 1
  fi
  if [[ -e "$dialog_path" || -L "$dialog_path" ]]; then
    aud065_reconcile_private_file "$dialog_path" || return 1
  else
    dialog_pod="$(aud065_ready_pod_name dialog dialog)" || return 1
    aud065_with_scratch_directory aud065_capture_public_material_in_scratch \
      "$dialog_pod" dialog "$dialog_path" || return 1
  fi
  aud065_require_private_file "$reticulum_path" || return 1
  aud065_require_private_file "$dialog_path" || return 1
}

aud065_write_operational_attestation() {
  local output="$AUD065_OPERATION_DIRECTORY/operational-attestation.json"
  recovery_require_operation_lock || return 1
  [[ "$RECOVERY_OPERATION_STATE" == bundle-applied ]] || return 1
  command node "$AUD065_ATTESTATION_TOOL" \
    --operation-directory "$AUD065_OPERATION_DIRECTORY" \
    --expected-operation-id "$RECOVERY_OPERATION_ID" \
    --expected-operation-binding-sha256 "$RECOVERY_OPERATION_BINDING_SHA256" \
    --quiesced-baseline "$AUD065_QUIESCED_BASELINE" \
    --bundle "$AUD065_BUNDLE" --binding "$AUD065_BUNDLE_BINDING" \
    --operation-key "$AUD065_OPERATION_DIRECTORY/operation.key" \
    --output "$output" || return 1
  aud065_require_private_file "$output" || return 1
  [[ "$(aud065_link_count "$output")" == 1 ]]
}

aud065_run_redacted_verifier() {
  local report_path="$1" final_resources="${2:-$AUD065_FINAL_BASELINE}"
  command node "$AUD065_REDACTED_TOOL" \
    --operation-directory "$AUD065_OPERATION_DIRECTORY" \
    --original-baseline "$AUD065_ORIGINAL_BASELINE" \
    --baseline-resources "$AUD065_QUIESCED_BASELINE" \
    --old-values "$AUD065_OLD_SNAPSHOT" --new-values "$AUD065_NEW_SNAPSHOT" \
    --bundle "$AUD065_BUNDLE" --bundle-binding "$AUD065_BUNDLE_BINDING" \
    --restart-contract "$AUD065_RESTART_CONTRACT" \
    --cas-responses "$AUD065_APPLIED_RESOURCES" \
    --final-resources "$final_resources" \
    --operational-attestation "$AUD065_OPERATION_DIRECTORY/operational-attestation.json" \
    --reticulum-jwk "$AUD065_OPERATION_DIRECTORY/reticulum-runtime.jwk" \
    --dialog-public-key "$AUD065_OPERATION_DIRECTORY/dialog-runtime-public.pem" \
    --fingerprint-key "$AUD065_OPERATION_DIRECTORY/operation.key" \
    --report "$report_path" >/dev/null
}

aud065_verify_report_in_scratch() {
  local scratch="$1" recheck="$1/report.json"
  aud065_run_redacted_verifier "$recheck" || return 1
  aud065_publish_private_file "$recheck" "$AUD065_REPORT" || return 1
}

aud065_verify_or_create_report() {
  local report_existed=0
  if [[ -e "$AUD065_REPORT" || -L "$AUD065_REPORT" ]]; then
    report_existed=1
  fi
  aud065_with_scratch_directory aud065_verify_report_in_scratch || return 1
  if [[ "$report_existed" == 0 ]]; then
    aud065_crash_point after-redacted-report || return 1
  fi
}

aud065_verify_started_deployments() {
  local name
  for name in pgbouncer pgbouncer-t reticulum coturn dialog bot-orchestrator; do
    aud065_scale_one_to_original "$name" || return 1
  done
  recovery_require_live_images_match_checkpoint \
    "$AUD065_CHECKPOINT_DIRECTORY/deployment-images.json" || return 1
}

aud065_verify_fresh_cleanup_in_scratch() {
  local scratch="$1" live="$1/final-live.json" report="$1/redacted-report.json"
  aud065_capture_private_baseline "$live" || return 1
  aud065_run_redacted_verifier "$report" "$live" || return 1
  cmp -s "$AUD065_REPORT" "$report" || return 1
}

aud065_verify_fresh_cleanup_gate() {
  aud065_verify_started_deployments || return 1
  aud065_probe_fresh_auth new pgbouncer accept || return 1
  aud065_probe_fresh_auth old pgbouncer reject || return 1
  aud065_probe_fresh_auth new pgbouncer accept || return 1
  aud065_probe_fresh_auth new pgbouncer-t accept || return 1
  aud065_probe_fresh_auth old pgbouncer-t reject || return 1
  aud065_probe_fresh_auth new pgbouncer-t accept || return 1
  recovery_require_live_process_local_runner_exact "$AUD065_CANONICAL_VALUES" || return 1
  aud065_with_scratch_directory aud065_verify_fresh_cleanup_in_scratch
}

aud065_cb_verify_runtime() {
  aud065_reload_guard || return 1
  case "$RECOVERY_OPERATION_STATE" in
    bundle-applied)
      [[ "$(aud065_pgsql_barrier_read_state)" == open-verified ]] || return 1
      aud065_verify_started_deployments || return 1
      recovery_require_live_process_local_runner_exact \
        "$AUD065_CANONICAL_VALUES" || return 1
      aud065_capture_or_reconcile_baseline "$AUD065_FINAL_BASELINE" || return 1
      aud065_capture_public_material || return 1
      aud065_write_operational_attestation || return 1
      aud065_verify_or_create_report || return 1
      recovery_require_operation_lock || return 1
      recovery_transition_aud065_operation_lock verified || return 1
      aud065_crash_point after-lock-verified || return 1
      ;;
    verified|cleanup-authorized)
      aud065_verify_started_deployments || return 1
      recovery_require_live_process_local_runner_exact \
        "$AUD065_CANONICAL_VALUES" || return 1
      aud065_verify_or_create_report || return 1
      ;;
    *) return 1 ;;
  esac
}

aud065_report_verification_callback() {
  local state live_rv
  aud065_reload_guard || return 1
  [[ "$RECOVERY_OPERATION_STATE" == cleanup-authorized ]] || return 1
  state="$(aud065_pgsql_barrier_read_state)" || return 1
  case "$state" in
    open-verified)
      aud065_verify_fresh_cleanup_gate || return 1
      [[ "$(aud065_pgsql_barrier_read_state)" == open-verified ]] || return 1
      ;;
    normal)
      live_rv="$(recovery_kubectl get networkpolicy "$AUD065_PGSQL_POLICY_NAME" \
        -n "$NAMESPACE" -o json | jq -er '.metadata.resourceVersion')" || return 1
      [[ "$live_rv" != "$AUD065_PGSQL_INITIAL_RESOURCE_VERSION" ]] || return 1
      aud065_verify_local_tcp_cleanup_gate || return 1
      ;;
    *) return 1 ;;
  esac
  aud065_verify_or_create_report || return 1
  printf 'cleanup-authorized\n'
}

aud065_probe_terminalize_callback() {
  local probe_name inventory phase attempt=0
  aud065_reload_guard || return 1
  probe_name="$(aud065_pgsql_probe_name)" || return 1
  recovery_kubectl_stream_guarded 20 exec "$probe_name" -n "$NAMESPACE" \
    -c probe -- sh -c 'set +x; kill -TERM 1' >/dev/null 2>&1 || :
  while ((attempt < 60)); do
    recovery_require_operation_serialization || return 1
    recovery_require_operation_lock || return 1
    inventory="$(aud065_pgsql_probe_inventory)" || return 1
    [[ "$(jq -er 'length' <<<"$inventory")" == 1 ]] || return 1
    phase="$(jq -r '.[0].status.phase // ""' <<<"$inventory")" || return 1
    if [[ "$phase" =~ ^(Succeeded|Failed)$ ]]; then
      printf 'terminal\n'
      return 0
    fi
    sleep "${AUD065_PROBE_POLL_SECONDS:-1}"
    attempt=$((attempt + 1))
  done
  return 1
}

aud065_write_or_verify_terminal() {
  local lock_uid="$1"
  if [[ -f "$AUD065_OPERATION_DIRECTORY/terminal.json" ]]; then
    aud065_operation_tool verify-terminal-from-artifacts \
      --operation-directory "$AUD065_OPERATION_DIRECTORY" \
      --expected-operation-id "$RECOVERY_OPERATION_ID" \
      --expected-operation-binding-sha256 "$RECOVERY_OPERATION_BINDING_SHA256" \
      --verified-baseline "$AUD065_FINAL_BASELINE" \
      --released-baseline "$AUD065_RELEASED_BASELINE" --report "$AUD065_REPORT" \
      --previous-lock-uid "$lock_uid" || return 1
  else
    aud065_operation_tool write-terminal-from-artifacts \
      --operation-directory "$AUD065_OPERATION_DIRECTORY" \
      --expected-operation-id "$RECOVERY_OPERATION_ID" \
      --expected-operation-binding-sha256 "$RECOVERY_OPERATION_BINDING_SHA256" \
      --verified-baseline "$AUD065_FINAL_BASELINE" \
      --released-baseline "$AUD065_RELEASED_BASELINE" --report "$AUD065_REPORT" \
      --previous-lock-uid "$lock_uid" || return 1
    aud065_operation_tool verify-terminal-from-artifacts \
      --operation-directory "$AUD065_OPERATION_DIRECTORY" \
      --expected-operation-id "$RECOVERY_OPERATION_ID" \
      --expected-operation-binding-sha256 "$RECOVERY_OPERATION_BINDING_SHA256" \
      --verified-baseline "$AUD065_FINAL_BASELINE" \
      --released-baseline "$AUD065_RELEASED_BASELINE" --report "$AUD065_REPORT" \
      --previous-lock-uid "$lock_uid" || return 1
  fi
}

aud065_cb_complete() {
  local lock_uid barrier_state
  aud065_reload_guard || return 1
  case "$RECOVERY_OPERATION_STATE" in
    verified)
      [[ "$(aud065_pgsql_barrier_read_state)" == open-verified ]] || return 1
      aud065_verify_fresh_cleanup_gate || return 1
      [[ "$(aud065_pgsql_barrier_read_state)" == open-verified ]] || return 1
      recovery_require_operation_lock || return 1
      recovery_transition_aud065_operation_lock cleanup-authorized || return 1
      aud065_crash_point after-lock-cleanup-authorized || return 1
      aud065_reload_guard || return 1
      ;;
    cleanup-authorized) ;;
    *) return 1 ;;
  esac
  lock_uid="$RECOVERY_OPERATION_LOCK_UID"
  aud065_pgsql_probe_bind_image "$(aud065_probe_image)" || return 1
  barrier_state="$(aud065_pgsql_barrier_read_state)" || return 1
  [[ "$barrier_state" == open-verified || "$barrier_state" == normal ]] || return 1
  aud065_pgsql_barrier_cleanup \
    aud065_probe_exec_status aud065_report_verification_callback || return 1
  aud065_crash_point after-barrier-cleanup || return 1
  aud065_verify_local_tcp_cleanup_gate || return 1
  aud065_pgsql_probe_cleanup aud065_probe_terminalize_callback || return 1
  aud065_crash_point after-probe-delete || return 1
  aud065_capture_and_verify_released_state || return 1
  aud065_crash_point after-release-verification || return 1
  aud065_promote_source || return 1
  aud065_crash_point after-source-promotion || return 1
  aud065_write_or_verify_terminal "$lock_uid" || return 1
  aud065_crash_point after-terminal-record || return 1
  recovery_release_operation_lock || return 1
  aud065_crash_point after-lock-delete || return 1
}

aud065_cb_fail_close() {
  aud065_fail_close
}

aud065_run_rotation_callbacks() {
  local identifiers role _database
  identifiers="$(aud065_runtime_identifiers)" || return 1
  IFS=$'\t' read -r role _database <<<"$identifiers"
  PLDB_GUARD_CALLBACK=aud065_cb_guard
  PLDB_QUIESCE_CALLBACK=aud065_cb_quiesce
  PLDB_ASSERT_QUIESCED_CALLBACK=aud065_cb_assert_quiesced
  PLDB_CLASSIFY_CALLBACK=aud065_cb_classify_role
  PLDB_ALTER_CALLBACK=aud065_cb_alter_role
  PLDB_ROLE_NEW_CALLBACK=aud065_cb_role_new
  PLDB_APPLY_CALLBACK=aud065_cb_apply
  PLDB_START_POOLS_CALLBACK=aud065_cb_start_pools
  PLDB_VERIFY_POOLS_CALLBACK=aud065_cb_verify_pools
  PLDB_START_CONSUMERS_CALLBACK=aud065_cb_start_consumers
  PLDB_VERIFY_RUNTIME_CALLBACK=aud065_cb_verify_runtime
  PLDB_COMPLETE_CALLBACK=aud065_cb_complete
  PLDB_FAIL_CLOSE_CALLBACK=aud065_cb_fail_close
  export PLDB_GUARD_CALLBACK PLDB_QUIESCE_CALLBACK PLDB_ASSERT_QUIESCED_CALLBACK \
    PLDB_CLASSIFY_CALLBACK PLDB_ALTER_CALLBACK PLDB_ROLE_NEW_CALLBACK \
    PLDB_APPLY_CALLBACK PLDB_START_POOLS_CALLBACK PLDB_VERIFY_POOLS_CALLBACK \
    PLDB_START_CONSUMERS_CALLBACK PLDB_VERIFY_RUNTIME_CALLBACK \
    PLDB_COMPLETE_CALLBACK PLDB_FAIL_CLOSE_CALLBACK
  aud065_emit_runtime_password pair | pldb_run_rotation "$role"
}

aud065_rb_guard() {
  aud065_reload_guard || return 1
  [[ "$RECOVERY_OPERATION_STATE" == db-rotated ||
     "$RECOVERY_OPERATION_STATE" == bundle-applied ]]
}

aud065_rb_quiesce() {
  local name
  aud065_reload_guard || return 1
  [[ "$RECOVERY_OPERATION_STATE" == db-rotated ||
     "$RECOVERY_OPERATION_STATE" == bundle-applied ]] || return 1
  aud065_pgsql_probe_bind_image "$(aud065_probe_image)" || return 1
  aud065_pgsql_probe_create || return 1
  aud065_require_pgsql_probe_nonready_and_unroutable || return 1
  aud065_pgsql_barrier_close aud065_probe_blocked_three || return 1
  for name in "${AUD065_ROTATION_DEPLOYMENTS[@]}"; do
    aud065_fail_close_one "$name" || return 1
  done
  for name in "${AUD065_ROTATION_DEPLOYMENTS[@]}"; do
    recovery_wait_for_no_pods "app=$name" "$name" 180s || return 1
  done
  aud065_require_pgsql_consumers_and_pods_absent \
    aud065_consumers_absent_callback aud065_consumer_pods_absent_callback || return 1
  aud065_require_no_pgsql_client_backends aud065_no_sessions_callback || return 1
  aud065_require_pgsql_unix_socket_local aud065_unix_socket_callback || return 1
}

aud065_rb_assert_quiesced() {
  aud065_reload_guard || return 1
  [[ "$RECOVERY_OPERATION_STATE" == db-rotated ||
     "$RECOVERY_OPERATION_STATE" == bundle-applied ]] || return 1
  [[ "$(aud065_pgsql_barrier_read_state)" == closed ]] || return 1
  aud065_require_pgsql_consumers_and_pods_absent \
    aud065_consumers_absent_callback aud065_consumer_pods_absent_callback || return 1
  aud065_require_no_pgsql_client_backends aud065_no_sessions_callback || return 1
  aud065_require_pgsql_unix_socket_local aud065_unix_socket_callback || return 1
}

aud065_rb_assert_new() {
  local role="$1" verifier="" extra="" output
  aud065_reload_guard || return 1
  IFS= read -r verifier || return 2
  if IFS= read -r extra || [[ -n "$extra" ]]; then verifier=""; return 2; fi
  pldb_validate_verifier "$verifier" || { verifier=""; return 2; }
  output="$(printf '%s\n%s\n' \
    md500000000000000000000000000000000 "$verifier" |
    pldb_emit_classification_sql "$role" | aud065_psql_socket 2>/dev/null)" || {
      verifier=""
      return 1
    }
  verifier=""
  [[ "$output" == new ]]
}

aud065_rb_validate_bundle_in_scratch() {
  local scratch="$1" live="$1/rollback-live.json" plan
  aud065_capture_private_baseline "$live" || return 1
  plan="$(command node "$AUD065_MATERIALIZE_TOOL" classify \
    --operation-directory "$AUD065_OPERATION_DIRECTORY" \
    --expected-operation-id "$RECOVERY_OPERATION_ID" \
    --expected-operation-binding-sha256 "$RECOVERY_OPERATION_BINDING_SHA256" \
    --quiesced-baseline "$AUD065_QUIESCED_BASELINE" --bundle "$AUD065_BUNDLE" \
    --binding "$AUD065_BUNDLE_BINDING" \
    --operation-key "$AUD065_OPERATION_DIRECTORY/operation.key" \
    --live-baseline "$live")" || return 1
  jq -e '
    .resourceCount == 8 and .pendingCount == 0 and
    .alreadyAppliedCount == 8 and .complete == true and
    ([.resources[].state] | all(. == "already-applied"))
  ' <<<"$plan" >/dev/null || return 1
  command node "$AUD065_MATERIALIZE_TOOL" extract-applied \
    --operation-directory "$AUD065_OPERATION_DIRECTORY" \
    --expected-operation-id "$RECOVERY_OPERATION_ID" \
    --expected-operation-binding-sha256 "$RECOVERY_OPERATION_BINDING_SHA256" \
    --quiesced-baseline "$AUD065_QUIESCED_BASELINE" --bundle "$AUD065_BUNDLE" \
    --binding "$AUD065_BUNDLE_BINDING" \
    --operation-key "$AUD065_OPERATION_DIRECTORY/operation.key" \
    --live-baseline "$live" --output "$AUD065_APPLIED_RESOURCES" || return 1
  aud065_require_private_file "$AUD065_APPLIED_RESOURCES" || return 1
  [[ "$(aud065_link_count "$AUD065_APPLIED_RESOURCES")" == 1 ]] || return 1
}

aud065_rb_validate_bundle_quiesced() {
  aud065_materialize_replacements || return 1
  aud065_with_scratch_directory aud065_rb_validate_bundle_in_scratch
}

aud065_rb_apply() {
  local _role="$1" verifier="" extra=""
  IFS= read -r verifier || return 2
  if IFS= read -r extra || [[ -n "$extra" ]]; then verifier=""; return 2; fi
  pldb_validate_verifier "$verifier" || { verifier=""; return 2; }
  verifier=""
  aud065_reload_guard || return 1
  case "$RECOVERY_OPERATION_STATE" in
    db-rotated) aud065_apply_bundle_exact ;;
    bundle-applied) aud065_rb_validate_bundle_quiesced ;;
    *) return 1 ;;
  esac
}

aud065_run_rollback_callbacks() {
  local identifiers role _database
  identifiers="$(aud065_runtime_identifiers)" || return 1
  IFS=$'\t' read -r role _database <<<"$identifiers"
  PLDB_GUARD_CALLBACK=aud065_rb_guard
  PLDB_QUIESCE_CALLBACK=aud065_rb_quiesce
  PLDB_ASSERT_QUIESCED_CALLBACK=aud065_rb_assert_quiesced
  PLDB_ASSERT_NEW_CALLBACK=aud065_rb_assert_new
  PLDB_ROLLBACK_CALLBACK=aud065_rb_apply
  PLDB_START_POOLS_CALLBACK=aud065_cb_start_pools
  PLDB_VERIFY_POOLS_CALLBACK=aud065_cb_verify_pools
  PLDB_START_CONSUMERS_CALLBACK=aud065_cb_start_consumers
  PLDB_VERIFY_RUNTIME_CALLBACK=aud065_cb_verify_runtime
  PLDB_COMPLETE_CALLBACK=aud065_cb_complete
  PLDB_FAIL_CLOSE_CALLBACK=aud065_cb_fail_close
  export PLDB_GUARD_CALLBACK PLDB_QUIESCE_CALLBACK PLDB_ASSERT_QUIESCED_CALLBACK \
    PLDB_ASSERT_NEW_CALLBACK PLDB_ROLLBACK_CALLBACK PLDB_START_POOLS_CALLBACK \
    PLDB_VERIFY_POOLS_CALLBACK PLDB_START_CONSUMERS_CALLBACK \
    PLDB_VERIFY_RUNTIME_CALLBACK PLDB_COMPLETE_CALLBACK PLDB_FAIL_CLOSE_CALLBACK
  aud065_emit_runtime_password new | pldb_run_rollback_with_new "$role"
}

aud065_release_lease_if_owned() {
  if [[ "$AUD065_LEASE_ACQUIRED" == 1 ]]; then
    recovery_release_operation_serialization || return 1
    AUD065_LEASE_ACQUIRED=0
  fi
}

aud065_audit() {
  local name
  AUD065_FAILURE_STAGE="audit-verification"
  aud065_set_paths || return 1
  aud065_require_lock_absent_read_only || return 1
  aud065_verify_operation_checkpoint || return 1
  aud065_verify_source_state new || return 1
  recovery_require_live_process_local_runner_exact "$AUD065_CANONICAL_VALUES" || return 1
  aud065_verify_terminal_record_read_only || return 1
  aud065_verify_released_policy_read_only || return 1
  aud065_require_probe_absent_read_only || return 1
  aud065_verify_live_release_read_only || return 1
  for name in "${AUD065_ROTATION_DEPLOYMENTS[@]}"; do
    aud065_require_started_read_only "$name" || return 1
  done
  recovery_require_live_images_match_checkpoint \
    "$AUD065_CHECKPOINT_DIRECTORY/deployment-images.json" || return 1
  recovery_require_live_process_local_runner_exact "$AUD065_CANONICAL_VALUES" || return 1
  aud065_verify_ghcr_snapshot_access "$AUD065_NEW_SNAPSHOT" || return 1
  aud065_verify_source_state new || return 1
  aud065_verify_terminal_record_read_only || return 1
  aud065_require_lock_absent_read_only || return 1
  printf 'aud065_rotation_verified\n'
}

aud065_fail_close_one() {
  local name="$1" original applied="" current
  local original_uid _original_rv _original_replicas original_selector original_fingerprint
  local applied_uid="" _applied_rv _applied_replicas applied_selector="" applied_fingerprint=""
  local uid rv replicas selector fingerprint
  original="$(aud065_deployment_baseline_contract "$name")" || return 1
  IFS=$'\t' read -r original_uid _original_rv _original_replicas \
    original_selector original_fingerprint <<<"$original"
  # The forward candidate contract is authenticated from the sealed bundle,
  # not from the completion-only applied evidence. This is required for a
  # rollback/fail-close cut immediately after any individual replacement.
  if [[ -e "$AUD065_BUNDLE" || -L "$AUD065_BUNDLE" ]]; then
    applied="$(aud065_applied_deployment_contract "$name")" || return 1
    IFS=$'\t' read -r applied_uid _applied_rv _applied_replicas \
      applied_selector applied_fingerprint <<<"$applied"
  fi
  current="$(aud065_capture_deployment_contract "$name")" || return 1
  IFS=$'\t' read -r uid rv replicas selector fingerprint <<<"$current"
  [[ "$uid" == "$original_uid" ]] || return 1
  if [[ "$selector" == "$original_selector" && "$fingerprint" == "$original_fingerprint" ]]; then
    :
  elif [[ -n "$applied_uid" && "$uid" == "$applied_uid" &&
          "$selector" == "$applied_selector" && "$fingerprint" == "$applied_fingerprint" ]]; then
    :
  else
    return 1
  fi
  case "$replicas" in
    0) recovery_require_operation_lock ;;
    1)
      aud065_scale_deployment_exact "$name" "$uid" "$rv" 1 0 \
        "$selector" "$fingerprint" >/dev/null
      ;;
    *) return 1 ;;
  esac
}

aud065_fail_close() {
  local name live barrier_state failed=0
  [[ "$AUD065_SIMULATED_CRASH" == 0 ]] || return 0
  [[ "$AUD065_LEASE_ACQUIRED" == 1 ]] || return 0
  recovery_require_operation_serialization >/dev/null 2>&1 || return 0
  live="$(aud065_lock_json 2>/dev/null)" || return 0
  [[ -n "$live" ]] || return 0
  if aud065_discover_lock >/dev/null 2>&1; then
    # Before a HMAC-valid binding exists the coordinator has no authenticated
    # admission capability. In that pre-bind failure window it must leave all
    # six Deployments untouched rather than stopping them while PostgreSQL is
    # still routable.
    [[ -e "$AUD065_OPERATION_DIRECTORY/barrier-binding.json" ||
       -L "$AUD065_OPERATION_DIRECTORY/barrier-binding.json" ]] || return 0
    if ! aud065_load_barrier_binding >/dev/null 2>&1; then return 0; fi
    barrier_state="$(aud065_pgsql_barrier_read_state 2>/dev/null)" || return 0
    if [[ "$barrier_state" == normal &&
          "$RECOVERY_OPERATION_STATE" =~ ^(verified|cleanup-authorized)$ ]]; then
      if ! aud065_pgsql_barrier_adopt_compensating_normal \
        >/dev/null 2>&1; then return 0; fi
    fi
    if ! aud065_pgsql_probe_bind_image \
      "$(aud065_probe_image 2>/dev/null)" >/dev/null 2>&1; then return 0; fi
    # In the bind->probe failure window, establish and observe the exact probe
    # before closing a normal policy. If probe creation cannot be recovered,
    # neither policy nor Deployments are mutated.
    if ! aud065_pgsql_probe_create >/dev/null 2>&1; then return 0; fi
    if ! aud065_require_pgsql_probe_nonready_and_unroutable \
      >/dev/null 2>&1; then return 0; fi
    if [[ "$barrier_state" == normal ]] &&
       ! aud065_require_pgsql_probe_preclose_reachable \
         aud065_probe_exec_status >/dev/null 2>&1; then
      return 0
    fi
    # Admission is closed and observed three times before any consumer CAS.
    if ! aud065_pgsql_barrier_close \
      aud065_probe_blocked_three >/dev/null 2>&1; then return 0; fi
    for name in "${AUD065_ROTATION_DEPLOYMENTS[@]}"; do
      aud065_fail_close_one "$name" >/dev/null 2>&1 || failed=1
    done
    for name in "${AUD065_ROTATION_DEPLOYMENTS[@]}"; do
      recovery_wait_for_no_pods "app=$name" "$name" 180s \
        >/dev/null 2>&1 || failed=1
    done
    aud065_require_pgsql_consumers_and_pods_absent \
      aud065_consumers_absent_callback aud065_consumer_pods_absent_callback \
      >/dev/null 2>&1 || failed=1
    aud065_require_no_pgsql_client_backends aud065_no_sessions_callback \
      >/dev/null 2>&1 || failed=1
    aud065_require_pgsql_unix_socket_local aud065_unix_socket_callback \
      >/dev/null 2>&1 || failed=1
  fi
  [[ "$failed" == 0 ]]
}

aud065_on_error() {
  local status="$?"
  trap - ERR INT TERM
  aud065_cleanup_private_ephemera || aud065_error scratch-cleanup-failed
  if [[ "$AUD065_SIMULATED_CRASH" == 1 ]]; then exit "$status"; fi
  aud065_fail_close || :
  aud065_release_lease_if_owned >/dev/null 2>&1 || :
  aud065_error "$AUD065_FAILURE_STAGE"
  exit "$status"
}

aud065_on_signal() {
  local status="$1"
  [[ "$status" == 130 || "$status" == 143 ]] || status=1
  trap - ERR INT TERM
  aud065_cleanup_private_ephemera || aud065_error scratch-cleanup-failed
  if [[ "$AUD065_SIMULATED_CRASH" == 1 ]]; then exit "$status"; fi
  aud065_fail_close || :
  aud065_release_lease_if_owned >/dev/null 2>&1 || :
  aud065_error "$AUD065_FAILURE_STAGE"
  exit "$status"
}

aud065_on_read_only_error() {
  local status="$?"
  trap - ERR INT TERM
  aud065_cleanup_private_ephemera || aud065_error scratch-cleanup-failed
  aud065_error "$AUD065_FAILURE_STAGE"
  exit "$status"
}

aud065_on_read_only_signal() {
  local status="$1"
  [[ "$status" == 130 || "$status" == 143 ]] || status=1
  trap - ERR INT TERM
  aud065_cleanup_private_ephemera || aud065_error scratch-cleanup-failed
  aud065_error "$AUD065_FAILURE_STAGE"
  exit "$status"
}

aud065_on_exit() {
  local status="$?" cleanup_status=0
  trap - EXIT ERR INT TERM
  if aud065_cleanup_private_ephemera; then cleanup_status=0; else cleanup_status=$?; fi
  if [[ "$status" == 0 && "$cleanup_status" != 0 ]]; then
    aud065_error scratch-cleanup-failed
    exit "$cleanup_status"
  fi
  exit "$status"
}

aud065_execute_or_resume() {
  local mode="$1" lock_status=0
  AUD065_FAILURE_STAGE="operation-verify"
  aud065_set_paths || return 1
  aud065_verify_operation_checkpoint || return 1
  if [[ "$mode" == execute ]]; then
    aud065_require_checkpoint_freshness || return 1
    aud065_verify_source_state old || return 1
  else
    aud065_verify_source_state either || return 1
  fi
  aud065_acquire_lease || return 1
  AUD065_FAILURE_STAGE="process-local-boundary"
  if ! recovery_require_live_process_local_runner_exact "$AUD065_CANONICAL_VALUES"; then
    aud065_release_lease_if_owned || return 1
    return 1
  fi
  AUD065_FAILURE_STAGE="ghcr-access"
  if ! aud065_verify_pre_mutation_ghcr_access; then
    aud065_release_lease_if_owned || return 1
    return 1
  fi
  AUD065_FAILURE_STAGE="operation-lock"
  if aud065_create_or_adopt_lock "$mode"; then :; else lock_status=$?; fi
  if [[ "$lock_status" == 3 && "$mode" == resume ]]; then
    # A resume must never recreate a missing lock.  A HMAC-valid terminal
    # record is the only fast-path accepted by this first-stage coordinator.
    aud065_verify_missing_lock_terminal || return 1
    aud065_release_lease_if_owned || return 1
    printf 'aud065_rotation_complete\n'
    return 0
  fi
  [[ "$lock_status" == 0 ]] || return 1
  AUD065_FAILURE_STAGE="rotation-state-machine"
  if [[ "$mode" == rollback ]]; then
    aud065_run_rollback_callbacks || return 1
  else
    aud065_run_rotation_callbacks || return 1
  fi
  AUD065_FAILURE_STAGE="terminal-verification"
  aud065_verify_missing_lock_terminal || return 1
  aud065_release_lease_if_owned || return 1
  printf 'aud065_rotation_complete\n'
}

main() {
  AUD065_COORDINATOR_PID="$$"
  export AUD065_COORDINATOR_PID
  if ! aud065_parse_cli "$@"; then
    aud065_error arguments-invalid
    return 2
  fi
  if [[ "$AUD065_COMMAND" == audit ]]; then
    trap aud065_on_read_only_error ERR
    trap 'aud065_on_read_only_signal 130' INT
    trap 'aud065_on_read_only_signal 143' TERM
  else
    trap aud065_on_error ERR
    trap 'aud065_on_signal 130' INT
    trap 'aud065_on_signal 143' TERM
  fi
  trap aud065_on_exit EXIT
  aud065_require_environment
  case "$AUD065_COMMAND" in
    plan) aud065_plan ;;
    execute) aud065_execute_or_resume execute ;;
    resume) aud065_execute_or_resume resume ;;
    rollback) aud065_execute_or_resume rollback ;;
    audit) aud065_audit ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi

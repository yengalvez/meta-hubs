#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NAMESPACE=hcce
EXPECTED_KUBE_CONTEXT=fixture-context
EXPECTED_NAMESPACE_UID=fixture-namespace-uid
EXPECTED_RET_PVC_UID=fixture-pvc-uid
# shellcheck source=deployment/lib/recovery-safety.sh
source "$ROOT_DIR/deployment/lib/recovery-safety.sh"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/yenhubs-aud065-lock-tests.XXXXXX")"
MUTATION_MARKER="$TMP_DIR/mutation-called"
trap 'rm -rf -- "$TMP_DIR"' EXIT INT TERM

PASS_COUNT=0
FAIL_COUNT=0
pass() { PASS_COUNT=$((PASS_COUNT + 1)); printf 'ok %s - %s\n' "$((PASS_COUNT + FAIL_COUNT))" "$1"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); printf 'not ok %s - %s\n' "$((PASS_COUNT + FAIL_COUNT))" "$1" >&2; }

RECOVERY_OPERATION_LOCK_NAME=yenhubs-recovery-operation-lock
RECOVERY_OPERATION_LOCK_UID=lock-uid
RECOVERY_OPERATION_LOCK_RESOURCE_VERSION=17
RECOVERY_OPERATION_TOKEN=11111111111111111111111111111111
RECOVERY_OPERATION_ID=22222222222222222222222222222222
RECOVERY_OPERATION_OWNER=aud065-rotation
RECOVERY_NAMESPACE_UID=fixture-namespace-uid
RECOVERY_PVC_UID=fixture-pvc-uid
RECOVERY_CHECKPOINT_STAMP=20260718-120000
RECOVERY_DUMP_SHA256="$(printf 'a%.0s' {1..64})"
RECOVERY_STORAGE_SHA256="$(printf 'b%.0s' {1..64})"
RECOVERY_OPERATION_STATE=quiesced
RECOVERY_OPERATION_BINDING_SHA256="$(printf 'c%.0s' {1..64})"
LOCK_FIXTURE_RESOURCE_VERSION=17

lock_json() {
  jq -cn \
    --arg binding "$RECOVERY_OPERATION_BINDING_SHA256" \
    --arg state "$RECOVERY_OPERATION_STATE" \
    --arg owner "$RECOVERY_OPERATION_OWNER" \
    --arg resource_version "$LOCK_FIXTURE_RESOURCE_VERSION" '
    {
      apiVersion:"v1",kind:"ConfigMap",
      metadata:{
        name:"yenhubs-recovery-operation-lock",namespace:"hcce",
        uid:"lock-uid",resourceVersion:$resource_version,
        labels:{"yenhubs.org/recovery-owner":$owner},
        annotations:{
          "yenhubs.org/operation-id":"22222222222222222222222222222222",
          "yenhubs.org/recovery-token":"11111111111111111111111111111111",
          "yenhubs.org/namespace-uid":"fixture-namespace-uid",
          "yenhubs.org/pvc-uid":"fixture-pvc-uid",
          "yenhubs.org/checkpoint-stamp":"20260718-120000",
          "yenhubs.org/dump-sha256":("a" * 64),
          "yenhubs.org/storage-sha256":("b" * 64),
          "yenhubs.org/recovery-state":$state,
          "yenhubs.org/operation-binding-sha256":$binding
        }
      },
      immutable:true
    }'
}

good="$(lock_json)"
if recovery_operation_lock_json_is_exact "$good"; then
  pass 'AUD-065 lock binds checkpoint, operation state and private operation'
else
  fail 'valid AUD-065 operation lock'
fi

RECOVERY_OPERATION_LOCK_NAME=yenhubs-aud065-rotation-lock
if ! recovery_operation_lock_json_is_exact "$good"; then
  pass 'AUD-065 is forced onto the shared backup and restore lock name'
else
  fail 'separate AUD-065 lock name was accepted'
fi
RECOVERY_OPERATION_LOCK_NAME=yenhubs-recovery-operation-lock

bad_binding="$(jq -c '.metadata.annotations["yenhubs.org/operation-binding-sha256"] = ("d" * 64)' <<<"$good")"
if ! recovery_operation_lock_json_is_exact "$bad_binding"; then
  pass 'operation-intent binding drift is rejected'
else
  fail 'operation-intent binding drift'
fi

bad_state="$(jq -c '.metadata.annotations["yenhubs.org/recovery-state"] = "db-rotated"' <<<"$good")"
if ! recovery_operation_lock_json_is_exact "$bad_state"; then
  pass 'operation-state drift is rejected'
else
  fail 'operation-state drift'
fi

bad_owner="$(jq -c '.metadata.labels["yenhubs.org/recovery-owner"] = "checkpoint-restore"' <<<"$good")"
if ! recovery_operation_lock_json_is_exact "$bad_owner"; then
  pass 'operation-owner drift is rejected'
else
  fail 'operation-owner drift'
fi

missing_binding="$(jq -c 'del(.metadata.annotations["yenhubs.org/operation-binding-sha256"])' <<<"$good")"
if ! recovery_operation_lock_json_is_exact "$missing_binding"; then
  pass 'AUD-065 lock without the operation-intent binding is rejected'
else
  fail 'missing operation-intent binding'
fi

RECOVERY_OPERATION_BINDING_SHA256=""
if ! recovery_operation_lock_json_is_exact "$missing_binding"; then
  pass 'AUD-065 owner cannot become unbound by clearing both expected and live binding'
else
  fail 'unbound AUD-065 owner contract'
fi

recovery_require_operation_serialization() { return 0; }
recovery_kubectl_mutate() { printf 'called\n' >"$MUTATION_MARKER"; return 99; }
RECOVERY_OPERATION_STATE=preflight
if ! recovery_acquire_operation_lock aud065-rotation yenhubs-recovery-operation-lock &&
   [[ ! -e "$MUTATION_MARKER" ]]; then
  pass 'AUD-065 lock acquisition rejects a missing binding before mutation'
else
  fail 'missing binding reached the mutation transport'
fi

RECOVERY_OPERATION_BINDING_SHA256="$(printf 'c%.0s' {1..64})"
if ! recovery_acquire_operation_lock checkpoint-restore yenhubs-recovery-operation-lock &&
   [[ ! -e "$MUTATION_MARKER" ]]; then
  pass 'operation-intent bindings cannot be attached to checkpoint-restore locks'
else
  fail 'cross-owner operation-intent binding reached the mutation transport'
fi

RECOVERY_OPERATION_STATE=""
if ! recovery_acquire_operation_lock aud065-rotation yenhubs-recovery-operation-lock &&
   [[ ! -e "$MUTATION_MARKER" ]]; then
  pass 'AUD-065 lock acquisition rejects a missing state before mutation'
else
  fail 'missing AUD-065 state reached the mutation transport'
fi

RECOVERY_OPERATION_STATE=db-rotated
rm -f -- "$MUTATION_MARKER"
if ! recovery_acquire_operation_lock aud065-rotation yenhubs-recovery-operation-lock &&
   [[ ! -e "$MUTATION_MARKER" ]]; then
  pass 'AUD-065 lock acquisition permits only the preflight initial state'
else
  fail 'advanced AUD-065 state reached lock creation'
fi

RECOVERY_OPERATION_STATE=preflight
RECOVERY_OPERATION_IDENTITY_PREBOUND=0
rm -f -- "$MUTATION_MARKER"
if ! recovery_acquire_operation_lock aud065-rotation yenhubs-recovery-operation-lock &&
   [[ ! -e "$MUTATION_MARKER" ]]; then
  pass 'AUD-065 lock creation rejects identifiers not durably prebound'
else
  fail 'unbound AUD-065 identifiers reached lock creation'
fi

RECOVERY_OPERATION_IDENTITY_PREBOUND=1
rm -f -- "$MUTATION_MARKER"
if ! recovery_acquire_operation_lock aud065-rotation yenhubs-recovery-operation-lock &&
   [[ -e "$MUTATION_MARKER" ]]; then
  pass 'durably prebound AUD-065 identifiers reach the remote create unchanged'
else
  fail 'prebound AUD-065 identifiers did not reach lock creation'
fi

reset_lock_fixture() {
  RECOVERY_OPERATION_LOCK_NAME=yenhubs-recovery-operation-lock
  RECOVERY_OPERATION_LOCK_UID=lock-uid
  RECOVERY_OPERATION_LOCK_RESOURCE_VERSION=17
  RECOVERY_OPERATION_TOKEN=11111111111111111111111111111111
  RECOVERY_OPERATION_ID=22222222222222222222222222222222
  RECOVERY_OPERATION_OWNER=aud065-rotation
  RECOVERY_OPERATION_STATE=quiesced
  RECOVERY_OPERATION_BINDING_SHA256="$(printf 'c%.0s' {1..64})"
  LOCK_FIXTURE_RESOURCE_VERSION=17
  LIVE_LOCK_JSON="$(lock_json)"
  rm -f -- "$MUTATION_MARKER"
}

recovery_require_cluster_identity() { return 0; }
recovery_require_pvc_identity() { return 0; }
recovery_kubectl() { printf '%s\n' "$LIVE_LOCK_JSON"; }
recovery_kubectl_mutate() {
  local request
  request="$(cat)" || return 1
  printf '%s\n' "$request" >"$MUTATION_MARKER"
  jq -c '.metadata.resourceVersion = "18"' <<<"$request"
}

reset_lock_fixture
if recovery_transition_aud065_operation_lock db-rotated &&
   [[ "$RECOVERY_OPERATION_STATE" == db-rotated &&
      "$RECOVERY_OPERATION_LOCK_RESOURCE_VERSION" == 18 ]] &&
   jq -e '
     .metadata.resourceVersion == "17" and
     .metadata.annotations["yenhubs.org/recovery-state"] == "db-rotated"
   ' >/dev/null "$MUTATION_MARKER"; then
  pass 'AUD-065 state advances by CAS and retains the lock identity'
else
  fail 'valid adjacent AUD-065 state transition'
fi

rm -f -- "$MUTATION_MARKER"
if ! recovery_transition_aud065_operation_lock verified &&
   [[ ! -e "$MUTATION_MARKER" ]]; then
  pass 'AUD-065 state cannot skip a transition'
else
  fail 'skipped AUD-065 state reached replace'
fi

RECOVERY_OPERATION_STATE=db-rotated
RECOVERY_OPERATION_LOCK_RESOURCE_VERSION=18
rm -f -- "$MUTATION_MARKER"
if ! recovery_transition_aud065_operation_lock quiesced &&
   [[ ! -e "$MUTATION_MARKER" ]]; then
  pass 'AUD-065 state cannot move backwards'
else
  fail 'reverse AUD-065 state reached replace'
fi

recovery_delete_namespaced_with_uid() {
  printf 'deleted\n' >"$MUTATION_MARKER"
}
aud065_require_pgsql_barrier_released() { return 0; }
rm -f -- "$MUTATION_MARKER"
if ! recovery_release_operation_lock && [[ ! -e "$MUTATION_MARKER" ]]; then
  pass 'AUD-065 lock cannot be released from a nonterminal state'
else
  fail 'nonterminal AUD-065 lock reached delete'
fi

reset_lock_fixture
RECOVERY_OPERATION_STATE=verified
LOCK_FIXTURE_RESOURCE_VERSION=22
RECOVERY_OPERATION_LOCK_RESOURCE_VERSION=22
LIVE_LOCK_JSON="$(lock_json)"
rm -f -- "$MUTATION_MARKER"
if recovery_transition_aud065_operation_lock cleanup-authorized &&
   [[ "$RECOVERY_OPERATION_STATE" == cleanup-authorized &&
      "$RECOVERY_OPERATION_LOCK_RESOURCE_VERSION" == 18 ]] &&
   jq -e '
     .metadata.resourceVersion == "22" and
     .metadata.annotations["yenhubs.org/recovery-state"] == "cleanup-authorized"
   ' >/dev/null "$MUTATION_MARKER"; then
  pass 'freshly verified AUD-065 state durably authorizes cleanup by CAS'
else
  fail 'verified to cleanup-authorized state transition'
fi

reset_lock_fixture
RECOVERY_OPERATION_STATE=verified
LOCK_FIXTURE_RESOURCE_VERSION=22
RECOVERY_OPERATION_LOCK_RESOURCE_VERSION=22
LIVE_LOCK_JSON="$(lock_json)"
aud065_require_pgsql_barrier_released() { return 0; }
rm -f -- "$MUTATION_MARKER"
if ! recovery_release_operation_lock && [[ ! -e "$MUTATION_MARKER" ]]; then
  pass 'verified AUD-065 lock cannot be released before durable cleanup authorization'
else
  fail 'verified lock reached deletion before cleanup authorization'
fi

reset_lock_fixture
RECOVERY_OPERATION_STATE=cleanup-authorized
LOCK_FIXTURE_RESOURCE_VERSION=22
RECOVERY_OPERATION_LOCK_RESOURCE_VERSION=22
LIVE_LOCK_JSON="$(lock_json)"
unset -f aud065_require_pgsql_barrier_released
if ! recovery_release_operation_lock && [[ ! -e "$MUTATION_MARKER" ]]; then
  pass 'cleanup-authorized AUD-065 lock cannot be released without the barrier cleanup contract'
else
  fail 'missing barrier cleanup contract reached lock deletion'
fi

aud065_require_pgsql_barrier_released() { return 1; }
rm -f -- "$MUTATION_MARKER"
if ! recovery_release_operation_lock && [[ ! -e "$MUTATION_MARKER" ]]; then
  pass 'cleanup-authorized AUD-065 lock cannot be released while the barrier is dirty'
else
  fail 'dirty PostgreSQL barrier reached lock deletion'
fi

aud065_require_pgsql_barrier_released() { return 0; }
rm -f -- "$MUTATION_MARKER"
if recovery_release_operation_lock && [[ -e "$MUTATION_MARKER" ]]; then
  pass 'cleanup-authorized AUD-065 lock can be released only after barrier cleanup'
else
  fail 'cleanup-authorized AUD-065 lock release'
fi

reset_lock_fixture
RECOVERY_OPERATION_LOCK_UID=""
RECOVERY_OPERATION_LOCK_RESOURCE_VERSION=""
RECOVERY_OPERATION_STATE=preflight
if recovery_discover_aud065_operation_lock &&
   [[ "$RECOVERY_OPERATION_LOCK_UID" == lock-uid &&
      "$RECOVERY_OPERATION_LOCK_RESOURCE_VERSION" == 17 &&
      "$RECOVERY_OPERATION_STATE" == quiesced ]]; then
  pass 'resume discovers the exact lock after create-before-local-persist crash'
else
  fail 'AUD-065 lock discovery after remote create'
fi

reset_lock_fixture
RECOVERY_OPERATION_LOCK_UID=""
RECOVERY_OPERATION_LOCK_RESOURCE_VERSION=""
RECOVERY_OPERATION_STATE=preflight
LIVE_LOCK_JSON="$(jq -c '
  .metadata.annotations["yenhubs.org/recovery-token"] = ("9" * 32)
' <<<"$LIVE_LOCK_JSON")"
if ! recovery_discover_aud065_operation_lock &&
   [[ -z "$RECOVERY_OPERATION_LOCK_UID" &&
      -z "$RECOVERY_OPERATION_LOCK_RESOURCE_VERSION" &&
      "$RECOVERY_OPERATION_STATE" == preflight ]]; then
  pass 'lock discovery rejects a foreign token without adopting UID or state'
else
  fail 'foreign lock discovery'
fi

reset_lock_fixture
RECOVERY_OPERATION_STATE=preflight
RECOVERY_OPERATION_LOCK_RESOURCE_VERSION=16
LIVE_LOCK_JSON="$(jq -c '
  .metadata.resourceVersion = "17" |
  .metadata.annotations["yenhubs.org/recovery-state"] = "quiesced"
' <<<"$LIVE_LOCK_JSON")"
if recovery_adopt_aud065_operation_lock &&
   [[ "$RECOVERY_OPERATION_STATE" == quiesced &&
      "$RECOVERY_OPERATION_LOCK_RESOURCE_VERSION" == 17 ]]; then
  pass 'resume adopts only the persisted AUD-065 state and resourceVersion'
else
  fail 'persisted AUD-065 lock adoption'
fi

reset_lock_fixture
RECOVERY_OPERATION_STATE=preflight
RECOVERY_OPERATION_LOCK_RESOURCE_VERSION=16
LIVE_LOCK_JSON="$(jq -c '
  .metadata.annotations["yenhubs.org/recovery-token"] = ("9" * 32)
' <<<"$LIVE_LOCK_JSON")"
if ! recovery_adopt_aud065_operation_lock &&
   [[ "$RECOVERY_OPERATION_STATE" == preflight &&
      "$RECOVERY_OPERATION_LOCK_RESOURCE_VERSION" == 16 ]]; then
  pass 'resume rejects a foreign token without adopting its state'
else
  fail 'foreign AUD-065 token adoption'
fi

reset_lock_fixture
RECOVERY_OPERATION_STATE=preflight
RECOVERY_OPERATION_LOCK_RESOURCE_VERSION=16
LIVE_LOCK_JSON="$(jq -c '
  .metadata.annotations["yenhubs.org/operation-binding-sha256"] = ("d" * 64)
' <<<"$LIVE_LOCK_JSON")"
if ! recovery_adopt_aud065_operation_lock &&
   [[ "$RECOVERY_OPERATION_STATE" == preflight &&
      "$RECOVERY_OPERATION_LOCK_RESOURCE_VERSION" == 16 ]]; then
  pass 'resume rejects a foreign operation-intent binding'
else
  fail 'foreign AUD-065 operation-intent adoption'
fi

printf '%s passed, %s failed\n' "$PASS_COUNT" "$FAIL_COUNT"
[[ "$FAIL_COUNT" == 0 ]]

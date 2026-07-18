#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
NAMESPACE=hcce
EXPECTED_KUBE_CONTEXT=fixture-context
EXPECTED_NAMESPACE_UID=fixture-namespace-uid
EXPECTED_RET_PVC_UID=fixture-pvc-uid

# shellcheck source=deployment/lib/recovery-safety.sh
source "$ROOT_DIR/deployment/lib/recovery-safety.sh"
# shellcheck source=deployment/lib/aud065-pgsql-barrier.sh
source "$ROOT_DIR/deployment/lib/aud065-pgsql-barrier.sh"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/yenhubs-aud065-pgsql-barrier.XXXXXX")"
POLICY_FILE="$TMP_DIR/policy.json"
EXTRA_POLICIES_FILE="$TMP_DIR/extra-policies.json"
PODS_FILE="$TMP_DIR/pods.json"
ENDPOINTS_FILE="$TMP_DIR/endpoints.json"
SLICES_FILE="$TMP_DIR/slices.json"
MUTATION_COUNT_FILE="$TMP_DIR/mutations"
MUTATION_MODE_FILE="$TMP_DIR/mutation-mode"
DELETE_FILE="$TMP_DIR/delete"
trap 'rm -rf -- "$TMP_DIR"' EXIT INT TERM

PASS_COUNT=0
FAIL_COUNT=0
pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf 'ok %s - %s\n' "$((PASS_COUNT + FAIL_COUNT))" "$1"
}
fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf 'not ok %s - %s\n' "$((PASS_COUNT + FAIL_COUNT))" "$1" >&2
}

RECOVERY_OPERATION_LOCK_NAME=yenhubs-recovery-operation-lock
RECOVERY_OPERATION_LOCK_UID=lock-uid
RECOVERY_OPERATION_LOCK_RESOURCE_VERSION=17
RECOVERY_OPERATION_TOKEN=11111111111111111111111111111111
RECOVERY_OPERATION_ID=22222222222222222222222222222222
RECOVERY_OPERATION_OWNER=aud065-rotation
RECOVERY_OPERATION_BINDING_SHA256="$(printf 'c%.0s' {1..64})"
RECOVERY_OPERATION_STATE=quiesced
RECOVERY_NAMESPACE_UID=fixture-namespace-uid
RECOVERY_PVC_UID=fixture-pvc-uid
RECOVERY_CHECKPOINT_STAMP=20260718-120000
RECOVERY_DUMP_SHA256="$(printf 'a%.0s' {1..64})"
RECOVERY_STORAGE_SHA256="$(printf 'b%.0s' {1..64})"
PGSQL_IMAGE="docker.io/mozillareality/postgres@sha256:$(printf 'd%.0s' {1..64})"

normal_policy() {
  local uid="${1:-policy-uid}" rv="${2:-10}"
  jq -cn --arg uid "$uid" --arg rv "$rv" --argjson spec "$(aud065_pgsql_normal_spec_json)" '{
    apiVersion:"networking.k8s.io/v1",kind:"NetworkPolicy",
    metadata:{
      name:"pgsql-ingress",namespace:"hcce",uid:$uid,resourceVersion:$rv,
      labels:{"app.kubernetes.io/managed-by":"hcce"},
      annotations:{"kubectl.kubernetes.io/last-applied-configuration":"fixture"}
    },
    spec:$spec
  }'
}

pgsql_deployment() {
  jq -cn --arg image "$PGSQL_IMAGE" '{
    apiVersion:"apps/v1",kind:"Deployment",
    metadata:{name:"pgsql",namespace:"hcce",uid:"deployment-pgsql-uid"},
    spec:{template:{spec:{containers:[{name:"postgresql",image:$image}]}}}
  }'
}

pgsql_pods() {
  jq -cn --arg image "$PGSQL_IMAGE" '{
    apiVersion:"v1",kind:"PodList",items:[{
      apiVersion:"v1",kind:"Pod",
      metadata:{name:"pgsql-abc",namespace:"hcce",uid:"pgsql-pod-uid",labels:{app:"pgsql"}},
      spec:{containers:[{name:"postgresql",image:$image}]},
      status:{
        phase:"Running",conditions:[{type:"Ready",status:"True"}],
        containerStatuses:[{name:"postgresql",ready:true}]
      }
    }]
  }'
}

empty_pods() { jq -cn '{apiVersion:"v1",kind:"PodList",items:[]}'; }
empty_endpoints() { jq -cn '{apiVersion:"v1",kind:"EndpointsList",items:[]}'; }
empty_slices() { jq -cn '{apiVersion:"discovery.k8s.io/v1",kind:"EndpointSliceList",items:[]}'; }

reset_globals() {
  AUD065_PGSQL_POLICY_UID=""
  AUD065_PGSQL_POLICY_RESOURCE_VERSION=""
  AUD065_PGSQL_INITIAL_RESOURCE_VERSION=""
  AUD065_PGSQL_NORMAL_METADATA_SHA256=""
  AUD065_PGSQL_NORMAL_SPEC_SHA256=""
  AUD065_PGSQL_BARRIER_STATE=""
  AUD065_PGSQL_POSTOPEN_VERIFIED=0
  AUD065_PGSQL_CLEANUP_AUTHORIZED=0
  AUD065_PGSQL_PROBE_IMAGE=""
  AUD065_PGSQL_PROBE_UID=""
  RECOVERY_OPERATION_STATE=quiesced
}

reset_fixture() {
  reset_globals
  normal_policy >"$POLICY_FILE"
  printf '[]\n' >"$EXTRA_POLICIES_FILE"
  empty_pods >"$PODS_FILE"
  empty_endpoints >"$ENDPOINTS_FILE"
  empty_slices >"$SLICES_FILE"
  printf '0\n' >"$MUTATION_COUNT_FILE"
  printf 'normal\n' >"$MUTATION_MODE_FILE"
  rm -f -- "$DELETE_FILE"
}

policy_list() {
  jq -cn --argjson policy "$(<"$POLICY_FILE")" \
    --argjson extras "$(<"$EXTRA_POLICIES_FILE")" '{
      apiVersion:"networking.k8s.io/v1",kind:"NetworkPolicyList",
      items:([$policy] + $extras)
    }'
}

recovery_require_operation_serialization() { return 0; }
recovery_require_operation_lock() { return 0; }

recovery_kubectl() {
  local joined="$*"
  case "$joined" in
    "get networkpolicy -n hcce -o json") policy_list ;;
    "get networkpolicy pgsql-ingress -n hcce -o json") command cat -- "$POLICY_FILE" ;;
    "get deployment pgsql -n hcce -o json") pgsql_deployment ;;
    "get pod -n hcce -l app=pgsql -o json") pgsql_pods ;;
    "get pod -n hcce -o json") command cat -- "$PODS_FILE" ;;
    "get endpoints -n hcce -o json") command cat -- "$ENDPOINTS_FILE" ;;
    "get endpointslice -n hcce -o json") command cat -- "$SLICES_FILE" ;;
    *) printf 'unexpected recovery_kubectl call: %s\n' "$joined" >&2; return 99 ;;
  esac
}

increment_mutations() {
  local count
  count="$(<"$MUTATION_COUNT_FILE")"
  printf '%s\n' "$((count + 1))" >"$MUTATION_COUNT_FILE"
}

recovery_kubectl_mutate() {
  local joined="$*" payload mode rv next_rv
  payload="$(cat)" || return 1
  increment_mutations
  mode="$(<"$MUTATION_MODE_FILE")"
  case "$joined" in
    "replace -f - -o json")
      rv="$(jq -er '.metadata.resourceVersion' <<<"$payload")" || return 1
      next_rv="$((rv + 1))"
      payload="$(jq -c --arg rv "$next_rv" '.metadata.resourceVersion = $rv' <<<"$payload")" || return 1
      case "$mode" in
        normal) ;;
        stale-uid) payload="$(jq -c '.metadata.uid = "replacement-uid"' <<<"$payload")" ;;
        same-rv) payload="$(jq -c --arg rv "$rv" '.metadata.resourceVersion = $rv' <<<"$payload")" ;;
        *) return 98 ;;
      esac
      printf '%s\n' "$payload" >"$POLICY_FILE"
      printf '%s\n' "$payload"
      ;;
    "create -f - -o json")
      [[ "$mode" == normal ]] || return 98
      payload="$(jq -c '
        .metadata.uid = "probe-uid" |
        .metadata.resourceVersion = "31" |
        .status = {
          phase:"Running",podIP:"10.0.0.31",
          conditions:[{type:"Ready",status:"False"}],
          containerStatuses:[{name:"probe",ready:false}]
        }
      ' <<<"$payload")" || return 1
      jq -cn --argjson pod "$payload" '{apiVersion:"v1",kind:"PodList",items:[$pod]}' \
        >"$PODS_FILE"
      printf '%s\n' "$payload"
      ;;
    *) printf 'unexpected mutate call: %s\n' "$joined" >&2; return 99 ;;
  esac
}

recovery_delete_namespaced_with_uid() {
  local kind="$1" name="$2" uid="$3"
  [[ "$kind" == pod && "$name" == "aud065-pgsql-probe-222222222222" &&
     "$uid" == "probe-uid" ]] || return 1
  printf '%s\t%s\t%s\n' "$kind" "$name" "$uid" >"$DELETE_FILE"
  empty_pods >"$PODS_FILE"
}

capture_normal() { aud065_pgsql_barrier_capture_normal >/dev/null; }
blocked_callback() { printf '2\n2\n2\n'; }
reachable_callback() { printf '0\n'; }
unreachable_once_callback() { printf '2\n'; }
absent_callback() { printf 'absent\n'; }
noisy_absent_callback() { printf 'absent\nextra\n'; }
zero_callback() { printf '0\n'; }
one_callback() { printf '1\n'; }
terminal_only_callback() { printf 'terminal\n'; }
verified_report_callback() { printf 'cleanup-authorized\n'; }
terminal_transition_callback() {
  jq -c '.items[0].status.phase = "Succeeded"' "$PODS_FILE" >"$PODS_FILE.next"
  mv -- "$PODS_FILE.next" "$PODS_FILE"
  printf 'terminal\n'
}

setup_cleanup_normal_reentry() {
  local uid metadata_sha initial_resource_version
  reset_fixture
  capture_normal
  uid="$AUD065_PGSQL_POLICY_UID"
  metadata_sha="$AUD065_PGSQL_NORMAL_METADATA_SHA256"
  initial_resource_version="$AUD065_PGSQL_INITIAL_RESOURCE_VERSION"
  jq -c '.metadata.resourceVersion = "42"' \
    "$POLICY_FILE" >"$POLICY_FILE.next"
  mv -- "$POLICY_FILE.next" "$POLICY_FILE"
  reset_globals
  aud065_pgsql_barrier_bind "$uid" "$metadata_sha" "$initial_resource_version"
  RECOVERY_OPERATION_STATE=cleanup-authorized
}

reset_fixture
if capture_normal && [[ "$AUD065_PGSQL_POLICY_UID" == policy-uid &&
  "$AUD065_PGSQL_POLICY_RESOURCE_VERSION" == 10 &&
  "$AUD065_PGSQL_NORMAL_METADATA_SHA256" =~ ^[a-f0-9]{64}$ &&
  "$AUD065_PGSQL_NORMAL_SPEC_SHA256" =~ ^[a-f0-9]{64}$ ]]; then
  pass 'captures the exact normal policy and immutable metadata/spec fingerprints'
else
  fail 'capture exact normal policy'
fi

reset_fixture
jq -c '.spec.ingress[0].ports[0].port = 6432' "$POLICY_FILE" >"$POLICY_FILE.next"
mv -- "$POLICY_FILE.next" "$POLICY_FILE"
if ! capture_normal; then pass 'rejects port drift'; else fail 'port drift'; fi

reset_fixture
jq -c '.spec.ingress[0].from[0].podSelector.matchLabels.app = "reticulum"' \
  "$POLICY_FILE" >"$POLICY_FILE.next"
mv -- "$POLICY_FILE.next" "$POLICY_FILE"
if ! capture_normal; then pass 'rejects peer-label drift'; else fail 'peer-label drift'; fi

reset_fixture
jq -c '.spec.ingress[0].from[0].namespaceSelector = {}' "$POLICY_FILE" >"$POLICY_FILE.next"
mv -- "$POLICY_FILE.next" "$POLICY_FILE"
if ! capture_normal; then pass 'rejects an added namespace peer'; else fail 'namespace peer drift'; fi

reset_fixture
jq -c '.metadata.finalizers = ["foreign.example/finalizer"]' "$POLICY_FILE" >"$POLICY_FILE.next"
mv -- "$POLICY_FILE.next" "$POLICY_FILE"
if ! capture_normal; then pass 'rejects policy finalizers'; else fail 'policy finalizer'; fi

reset_fixture
jq -c '.metadata.ownerReferences = [{apiVersion:"v1",kind:"ConfigMap",name:"x",uid:"x"}]' \
  "$POLICY_FILE" >"$POLICY_FILE.next"
mv -- "$POLICY_FILE.next" "$POLICY_FILE"
if ! capture_normal; then pass 'rejects policy owners'; else fail 'policy owner'; fi

reset_fixture
jq -cn '{
  apiVersion:"networking.k8s.io/v1",kind:"NetworkPolicy",
  metadata:{name:"aud065-deny-all",namespace:"hcce",uid:"deny-uid",resourceVersion:"4"},
  spec:{podSelector:{matchLabels:{app:"pgsql"}},policyTypes:["Ingress"],ingress:[]}
}' >"$EXTRA_POLICIES_FILE"
# Turn the single object into the fixture array.
jq -cs '.' "$EXTRA_POLICIES_FILE" >"$EXTRA_POLICIES_FILE.next"
mv -- "$EXTRA_POLICIES_FILE.next" "$EXTRA_POLICIES_FILE"
if ! capture_normal; then pass 'rejects a second deny-all policy'; else fail 'second deny-all policy'; fi

reset_fixture
jq -cn '{
  apiVersion:"networking.k8s.io/v1",kind:"NetworkPolicy",
  metadata:{name:"aud065-defaulted-deny-all",namespace:"hcce",uid:"deny-uid",resourceVersion:"5"},
  spec:{podSelector:{matchLabels:{app:"pgsql"}}}
}' >"$EXTRA_POLICIES_FILE"
jq -cs '.' "$EXTRA_POLICIES_FILE" >"$EXTRA_POLICIES_FILE.next"
mv -- "$EXTRA_POLICIES_FILE.next" "$EXTRA_POLICIES_FILE"
if ! capture_normal; then
  pass 'rejects a second defaulted ingress policy without policyTypes'
else
  fail 'defaulted ingress policy without policyTypes'
fi

reset_fixture
capture_normal
jq -c '.metadata.labels.extra = "drift"' "$POLICY_FILE" >"$POLICY_FILE.next"
mv -- "$POLICY_FILE.next" "$POLICY_FILE"
if ! aud065_pgsql_barrier_adopt normal >/dev/null; then
  pass 'rejects metadata-label drift after capture'
else
  fail 'metadata-label drift after capture'
fi

reset_fixture
capture_normal
jq -c '.metadata.annotations.extra = "drift"' "$POLICY_FILE" >"$POLICY_FILE.next"
mv -- "$POLICY_FILE.next" "$POLICY_FILE"
if ! aud065_pgsql_barrier_adopt normal >/dev/null; then
  pass 'rejects metadata-annotation drift after capture'
else
  fail 'metadata-annotation drift after capture'
fi

reset_fixture
capture_normal
resume_initial_resource_version="$AUD065_PGSQL_INITIAL_RESOURCE_VERSION"
if aud065_pgsql_barrier_close blocked_callback &&
   aud065_pgsql_policy_json_is_exact "$(<"$POLICY_FILE")" closed &&
   [[ "$(jq -r '.metadata.uid' "$POLICY_FILE")" == policy-uid &&
      "$(jq -r '.spec.ingress | length' "$POLICY_FILE")" == 0 &&
      "$(<"$MUTATION_COUNT_FILE")" == 1 ]]; then
  pass 'closes the same policy by resourceVersion CAS and records exact markers'
else
  fail 'valid close transition'
fi

if aud065_pgsql_barrier_close blocked_callback && [[ "$(<"$MUTATION_COUNT_FILE")" == 1 ]]; then
  pass 'closed-state re-entry repeats enforcement without a second mutation'
else
  fail 'closed-state re-entry'
fi

resume_uid="$AUD065_PGSQL_POLICY_UID"
resume_metadata_sha="$AUD065_PGSQL_NORMAL_METADATA_SHA256"
reset_globals
aud065_pgsql_barrier_bind "$resume_uid" "$resume_metadata_sha"
if aud065_pgsql_barrier_close blocked_callback &&
   aud065_pgsql_barrier_open reachable_callback &&
   [[ "$(<"$MUTATION_COUNT_FILE")" == 2 ]]; then
  pass 'a crash-bound process adopts marked closed state and resumes open by fresh CAS'
else
  fail 'closed-state crash resume through bind'
fi

resume_uid="$AUD065_PGSQL_POLICY_UID"
resume_metadata_sha="$AUD065_PGSQL_NORMAL_METADATA_SHA256"
reset_globals
aud065_pgsql_barrier_bind \
  "$resume_uid" "$resume_metadata_sha" "$resume_initial_resource_version"
RECOVERY_OPERATION_STATE=cleanup-authorized
if aud065_pgsql_barrier_cleanup reachable_callback verified_report_callback &&
   aud065_pgsql_policy_json_is_exact "$(<"$POLICY_FILE")" normal; then
  pass 'a crash-bound process adopts open-verified and restores normal cleanly'
else
  fail 'open-verified crash resume through bind'
fi

reset_fixture
capture_normal
resume_uid="$AUD065_PGSQL_POLICY_UID"
resume_metadata_sha="$AUD065_PGSQL_NORMAL_METADATA_SHA256"
reset_globals
aud065_pgsql_barrier_bind "$resume_uid" "$resume_metadata_sha"
if ! aud065_pgsql_barrier_close blocked_callback && [[ "$(<"$MUTATION_COUNT_FILE")" == 0 ]]; then
  pass 'bind alone cannot adopt a clean normal resourceVersion'
else
  fail 'unsafe clean-normal adoption after crash'
fi

reset_fixture
capture_normal
resume_uid="$AUD065_PGSQL_POLICY_UID"
resume_metadata_sha="$AUD065_PGSQL_NORMAL_METADATA_SHA256"
resume_resource_version="$AUD065_PGSQL_POLICY_RESOURCE_VERSION"
reset_globals
aud065_pgsql_barrier_bind \
  "$resume_uid" "$resume_metadata_sha" "$resume_resource_version"
if aud065_pgsql_barrier_close blocked_callback &&
   aud065_pgsql_policy_json_is_exact "$(<"$POLICY_FILE")" closed &&
   [[ "$(<"$MUTATION_COUNT_FILE")" == 1 ]]; then
  pass 'durably bound clean-normal resourceVersion resumes the first close CAS'
else
  fail 'durable clean-normal resourceVersion resume'
fi

reset_fixture
capture_normal
resume_uid="$AUD065_PGSQL_POLICY_UID"
resume_metadata_sha="$AUD065_PGSQL_NORMAL_METADATA_SHA256"
resume_resource_version="$AUD065_PGSQL_POLICY_RESOURCE_VERSION"
jq -c '.metadata.resourceVersion = "same-spec-aba"' \
  "$POLICY_FILE" >"$POLICY_FILE.next"
mv -- "$POLICY_FILE.next" "$POLICY_FILE"
reset_globals
aud065_pgsql_barrier_bind \
  "$resume_uid" "$resume_metadata_sha" "$resume_resource_version"
if ! aud065_pgsql_barrier_close blocked_callback &&
   [[ "$(<"$MUTATION_COUNT_FILE")" == 0 ]]; then
  pass 'persisted clean-normal resourceVersion rejects same-spec ABA on resume'
else
  fail 'persisted clean-normal ABA rejection'
fi

setup_cleanup_normal_reentry
if aud065_pgsql_barrier_adopt_cleanup_normal >"$TMP_DIR/adopt-output" &&
   [[ "$(<"$TMP_DIR/adopt-output")" == normal &&
      "$AUD065_PGSQL_POLICY_RESOURCE_VERSION" == 42 &&
      "$AUD065_PGSQL_INITIAL_RESOURCE_VERSION" == 10 &&
      "$AUD065_PGSQL_CLEANUP_AUTHORIZED" == 0 &&
      "$(<"$MUTATION_COUNT_FILE")" == 0 ]] &&
   aud065_pgsql_barrier_close blocked_callback &&
   aud065_pgsql_policy_json_is_exact "$(<"$POLICY_FILE")" closed; then
  pass 'cleanup-authorized re-entry adopts only advanced clean normal before fail-close'
else
  fail 'advanced cleanup-normal adoption and compensating close'
fi

setup_cleanup_normal_reentry
RECOVERY_OPERATION_STATE=verified
if ! aud065_pgsql_barrier_adopt_cleanup_normal >/dev/null; then
  pass 'verified state cannot adopt advanced cleanup-normal policy'
else
  fail 'cleanup-normal adoption from verified state'
fi

setup_cleanup_normal_reentry
RECOVERY_OPERATION_STATE=verified
if aud065_pgsql_barrier_adopt_compensating_normal >"$TMP_DIR/adopt-output" &&
   [[ "$(<"$TMP_DIR/adopt-output")" == normal &&
      "$AUD065_PGSQL_POLICY_RESOURCE_VERSION" == 42 &&
      "$AUD065_PGSQL_CLEANUP_AUTHORIZED" == 0 &&
      "$(<"$MUTATION_COUNT_FILE")" == 0 ]] &&
   aud065_pgsql_barrier_close blocked_callback &&
   aud065_pgsql_policy_json_is_exact "$(<"$POLICY_FILE")" closed &&
   [[ "$(<"$MUTATION_COUNT_FILE")" == 1 ]]; then
  pass 'verified state adopts advanced exact normal only for a compensating close'
else
  fail 'verified compensating normal adoption'
fi

setup_cleanup_normal_reentry
RECOVERY_OPERATION_STATE=quiesced
if ! aud065_pgsql_barrier_adopt_compensating_normal >/dev/null &&
   [[ "$(<"$MUTATION_COUNT_FILE")" == 0 ]]; then
  pass 'nonverified state cannot use compensating normal adoption'
else
  fail 'compensating normal adoption from nonverified state'
fi

setup_cleanup_normal_reentry
RECOVERY_OPERATION_STATE=quiesced
if ! aud065_pgsql_barrier_adopt_cleanup_normal >/dev/null; then
  pass 'quiesced state cannot adopt advanced cleanup-normal policy'
else
  fail 'cleanup-normal adoption from quiesced state'
fi

reset_fixture
capture_normal
resume_uid="$AUD065_PGSQL_POLICY_UID"
resume_metadata_sha="$AUD065_PGSQL_NORMAL_METADATA_SHA256"
resume_resource_version="$AUD065_PGSQL_INITIAL_RESOURCE_VERSION"
reset_globals
aud065_pgsql_barrier_bind \
  "$resume_uid" "$resume_metadata_sha" "$resume_resource_version"
RECOVERY_OPERATION_STATE=cleanup-authorized
if ! aud065_pgsql_barrier_adopt_cleanup_normal >/dev/null; then
  pass 'cleanup-normal adoption rejects the initial resourceVersion'
else
  fail 'initial resourceVersion cleanup-normal adoption'
fi

setup_cleanup_normal_reentry
jq -c '.metadata.uid = "replacement-uid"' \
  "$POLICY_FILE" >"$POLICY_FILE.next"
mv -- "$POLICY_FILE.next" "$POLICY_FILE"
if ! aud065_pgsql_barrier_adopt_cleanup_normal >/dev/null; then
  pass 'cleanup-normal adoption rejects policy UID drift'
else
  fail 'cleanup-normal UID drift'
fi

setup_cleanup_normal_reentry
jq -c '.metadata.labels.extra = "drift"' \
  "$POLICY_FILE" >"$POLICY_FILE.next"
mv -- "$POLICY_FILE.next" "$POLICY_FILE"
if ! aud065_pgsql_barrier_adopt_cleanup_normal >/dev/null; then
  pass 'cleanup-normal adoption rejects metadata drift'
else
  fail 'cleanup-normal metadata drift'
fi

setup_cleanup_normal_reentry
jq -c '.spec.ingress = []' \
  "$POLICY_FILE" >"$POLICY_FILE.next"
mv -- "$POLICY_FILE.next" "$POLICY_FILE"
if ! aud065_pgsql_barrier_adopt_cleanup_normal >/dev/null; then
  pass 'cleanup-normal adoption rejects spec drift'
else
  fail 'cleanup-normal spec drift'
fi

reset_fixture
capture_normal
if ! aud065_pgsql_barrier_close reachable_callback &&
   aud065_pgsql_policy_json_is_exact "$(<"$POLICY_FILE")" closed; then
  pass 'fails closed when the API says closed but the probe still connects'
else
  fail 'CNI enforcement failure after close'
fi

reset_fixture
capture_normal
jq -c '.metadata.resourceVersion = "11"' "$POLICY_FILE" >"$POLICY_FILE.next"
mv -- "$POLICY_FILE.next" "$POLICY_FILE"
if ! aud065_pgsql_barrier_close blocked_callback && [[ "$(<"$MUTATION_COUNT_FILE")" == 0 ]]; then
  pass 'rejects a stale resourceVersion before CAS'
else
  fail 'stale resourceVersion'
fi

reset_fixture
capture_normal
jq -c '.metadata.uid = "aba-replacement" | .metadata.resourceVersion = "11"' \
  "$POLICY_FILE" >"$POLICY_FILE.next"
mv -- "$POLICY_FILE.next" "$POLICY_FILE"
if ! aud065_pgsql_barrier_close blocked_callback && [[ "$(<"$MUTATION_COUNT_FILE")" == 0 ]]; then
  pass 'rejects same-name UID replacement and ABA'
else
  fail 'UID replacement ABA'
fi

reset_fixture
capture_normal
printf 'stale-uid\n' >"$MUTATION_MODE_FILE"
if ! aud065_pgsql_barrier_close blocked_callback; then
  pass 'rejects a replace response with a different UID'
else
  fail 'replace response UID drift'
fi

reset_fixture
capture_normal
printf 'same-rv\n' >"$MUTATION_MODE_FILE"
if ! aud065_pgsql_barrier_close blocked_callback; then
  pass 'rejects a replace response without resourceVersion advancement'
else
  fail 'replace response stale resourceVersion'
fi

reset_fixture
capture_normal
aud065_pgsql_barrier_close blocked_callback
if aud065_pgsql_barrier_open reachable_callback &&
   aud065_pgsql_policy_json_is_exact "$(<"$POLICY_FILE")" open-verified &&
   [[ "$AUD065_PGSQL_POSTOPEN_VERIFIED" == 1 ]]; then
  pass 'opens by CAS and requires an independent reachable observation'
else
  fail 'valid open transition'
fi

reset_fixture
capture_normal
aud065_pgsql_barrier_close blocked_callback
if ! aud065_pgsql_barrier_open unreachable_once_callback &&
   aud065_pgsql_policy_json_is_exact "$(<"$POLICY_FILE")" open-verified &&
   aud065_pgsql_barrier_open reachable_callback &&
   [[ "$(<"$MUTATION_COUNT_FILE")" == 2 ]]; then
  pass 'open crash re-entry repeats reachability without another CAS'
else
  fail 'open crash re-entry'
fi

reset_fixture
capture_normal
aud065_pgsql_barrier_close blocked_callback
aud065_pgsql_barrier_open reachable_callback
open_rv="$AUD065_PGSQL_POLICY_RESOURCE_VERSION"
if aud065_pgsql_barrier_close blocked_callback &&
   aud065_pgsql_policy_json_is_exact "$(<"$POLICY_FILE")" closed &&
   [[ "$AUD065_PGSQL_POLICY_RESOURCE_VERSION" != "$open_rv" &&
      "$(<"$MUTATION_COUNT_FILE")" == 3 ]] &&
   aud065_pgsql_barrier_open reachable_callback &&
   aud065_pgsql_policy_json_is_exact "$(<"$POLICY_FILE")" open-verified &&
   [[ "$(<"$MUTATION_COUNT_FILE")" == 4 ]]; then
  pass 'fail-close fences open-verified by CAS and can resume open safely'
else
  fail 'open-verified fail-close and resume'
fi

reset_fixture
capture_normal
RECOVERY_OPERATION_STATE=cleanup-authorized
if ! aud065_pgsql_barrier_cleanup reachable_callback verified_report_callback &&
   [[ "$AUD065_PGSQL_POLICY_RESOURCE_VERSION" == \
      "$AUD065_PGSQL_INITIAL_RESOURCE_VERSION" &&
      "$(<"$MUTATION_COUNT_FILE")" == 0 ]]; then
  pass 'cleanup rejects the untouched initial normal resourceVersion'
else
  fail 'initial normal cleanup ambiguity'
fi

reset_fixture
capture_normal
aud065_pgsql_barrier_close blocked_callback
RECOVERY_OPERATION_STATE=cleanup-authorized
if ! aud065_pgsql_barrier_cleanup reachable_callback verified_report_callback &&
   aud065_pgsql_policy_json_is_exact "$(<"$POLICY_FILE")" closed; then
  pass 'refuses cleanup before open-verified'
else
  fail 'cleanup before verified'
fi

aud065_pgsql_barrier_open reachable_callback
RECOVERY_OPERATION_STATE=verified
if ! aud065_pgsql_barrier_cleanup reachable_callback verified_report_callback &&
   aud065_pgsql_policy_json_is_exact "$(<"$POLICY_FILE")" open-verified; then
  pass 'verified alone cannot remove PostgreSQL barrier markers'
else
  fail 'cleanup without durable authorization'
fi
RECOVERY_OPERATION_STATE=cleanup-authorized
if aud065_pgsql_barrier_cleanup reachable_callback verified_report_callback &&
   aud065_pgsql_policy_json_is_exact "$(<"$POLICY_FILE")" normal &&
   [[ "$(jq -r '[.metadata.annotations | keys[] | select(startswith("yenhubs.org/aud065-pgsql-"))] | length' "$POLICY_FILE")" == 0 ]] &&
   aud065_pgsql_barrier_cleanup reachable_callback verified_report_callback; then
  pass 'cleanup restores exact original metadata/spec and is crash-idempotent'
else
  fail 'verified cleanup and re-entry'
fi

if aud065_require_pgsql_consumers_and_pods_absent absent_callback absent_callback &&
   ! aud065_require_pgsql_consumers_absent noisy_absent_callback &&
   aud065_require_pgsql_probe_preclose_reachable zero_callback &&
   ! aud065_require_pgsql_probe_preclose_reachable one_callback &&
   aud065_require_no_pgsql_client_backends zero_callback &&
   ! aud065_require_no_pgsql_client_backends one_callback &&
   aud065_require_pgsql_unix_socket_local zero_callback &&
   ! aud065_require_pgsql_unix_socket_local one_callback &&
   aud065_require_pgsql_probe_postclose_stably_blocked blocked_callback &&
   ! aud065_require_pgsql_probe_postclose_stably_blocked unreachable_once_callback; then
  pass 'strict callbacks reject extra output, residual sessions, socket failure and unstable block'
else
  fail 'strict callback contracts'
fi

reset_fixture
if ! aud065_pgsql_probe_bind_image postgres:latest &&
   aud065_pgsql_probe_bind_image "$PGSQL_IMAGE"; then
  pass 'probe image must be an exact digest'
else
  fail 'probe image digest binding'
fi

bound_image="$PGSQL_IMAGE"
PGSQL_IMAGE="docker.io/mozillareality/postgres@sha256:$(printf 'e%.0s' {1..64})"
if ! aud065_pgsql_probe_image_matches_pgsql; then
  pass 'rejects a probe digest that is not the exact live pgsql digest'
else
  fail 'probe/live pgsql digest mismatch'
fi
PGSQL_IMAGE="$bound_image"

capture_normal
if aud065_pgsql_probe_create && [[ "$(<"$MUTATION_COUNT_FILE")" == 1 ]] &&
   ! grep -q "$RECOVERY_OPERATION_TOKEN" "$PODS_FILE" &&
   jq -e '
     .items[0].metadata.ownerReferences[0].uid == "lock-uid" and
     .items[0].spec.automountServiceAccountToken == false and
     (.items[0].spec.activeDeadlineSeconds // null) == null and
     ((.items[0].spec.containers[0].env // []) == []) and
     ((.items[0].spec.containers[0].ports // []) == []) and
     ((.items[0].spec.volumes // []) == [])
   ' >/dev/null "$PODS_FILE"; then
  pass 'creates one hardened, owner-bound, credential-free non-listening probe'
else
  fail 'valid probe creation'
fi

if aud065_pgsql_probe_create && [[ "$(<"$MUTATION_COUNT_FILE")" == 1 ]]; then
  pass 'probe creation re-entry adopts the same UID without mutation'
else
  fail 'probe creation re-entry'
fi

# A non-ready target can appear only in legacy notReadyAddresses and in an
# EndpointSlice whose ready condition is explicitly false.
jq -cn '{
  apiVersion:"v1",kind:"EndpointsList",items:[{subsets:[{
    notReadyAddresses:[{ip:"10.0.0.31",targetRef:{name:"aud065-pgsql-probe-222222222222",uid:"probe-uid"}}]
  }]}]
}' >"$ENDPOINTS_FILE"
jq -cn '{
  apiVersion:"discovery.k8s.io/v1",kind:"EndpointSliceList",items:[{endpoints:[{
    addresses:["10.0.0.31"],conditions:{ready:false},
    targetRef:{name:"aud065-pgsql-probe-222222222222",uid:"probe-uid"}
  }]}]
}' >"$SLICES_FILE"
if aud065_require_pgsql_probe_nonready_and_unroutable; then
  pass 'accepts a Running probe only when Ready is false and no routable endpoint exists'
else
  fail 'non-ready unroutable probe'
fi

jq -c '.items[0].status.conditions[0].status = "True" | .items[0].status.containerStatuses[0].ready = true' \
  "$PODS_FILE" >"$PODS_FILE.next"
mv -- "$PODS_FILE.next" "$PODS_FILE"
if ! aud065_require_pgsql_probe_nonready_and_unroutable; then
  pass 'rejects a Ready probe'
else
  fail 'Ready probe'
fi

jq -c '.items[0].status.conditions[0].status = "False" | .items[0].status.containerStatuses[0].ready = false' \
  "$PODS_FILE" >"$PODS_FILE.next"
mv -- "$PODS_FILE.next" "$PODS_FILE"
jq -cn '{
  apiVersion:"v1",kind:"EndpointsList",items:[{subsets:[{
    addresses:[{ip:"10.0.0.31",targetRef:{name:"aud065-pgsql-probe-222222222222",uid:"probe-uid"}}]
  }]}]
}' >"$ENDPOINTS_FILE"
if ! aud065_require_pgsql_probe_nonready_and_unroutable; then
  pass 'rejects a routable legacy Endpoint'
else
  fail 'routable legacy Endpoint'
fi

empty_endpoints >"$ENDPOINTS_FILE"
jq -c '.items[0].endpoints[0].conditions.ready = true' "$SLICES_FILE" >"$SLICES_FILE.next"
mv -- "$SLICES_FILE.next" "$SLICES_FILE"
if ! aud065_require_pgsql_probe_nonready_and_unroutable; then
  pass 'rejects a ready EndpointSlice endpoint'
else
  fail 'ready EndpointSlice endpoint'
fi

reset_fixture
aud065_pgsql_probe_bind_image "$PGSQL_IMAGE"
capture_normal
aud065_pgsql_probe_create
AUD065_PGSQL_PROBE_UID=foreign-uid
if ! aud065_pgsql_probe_create; then
  pass 'rejects a same-name probe UID replacement'
else
  fail 'probe UID replacement'
fi

AUD065_PGSQL_PROBE_UID=probe-uid
if ! aud065_pgsql_probe_cleanup terminal_only_callback && [[ ! -e "$DELETE_FILE" ]]; then
  pass 'does not UID-delete a probe until the API reports a terminal phase'
else
  fail 'nonterminal probe deletion'
fi

if aud065_pgsql_probe_cleanup terminal_transition_callback &&
   [[ -e "$DELETE_FILE" && "$(jq -r '.items | length' "$PODS_FILE")" == 0 ]]; then
  pass 'UID-deletes only the exact terminal probe'
else
  fail 'terminal UID deletion'
fi

if aud065_pgsql_probe_cleanup terminal_only_callback; then
  pass 'probe cleanup is idempotent after deletion'
else
  fail 'probe cleanup re-entry'
fi

reset_fixture
aud065_pgsql_probe_bind_image "$PGSQL_IMAGE"
capture_normal
aud065_pgsql_barrier_close blocked_callback
if ! aud065_pgsql_probe_create && [[ "$(jq -r '.items | length' "$PODS_FILE")" == 0 ]]; then
  pass 'never creates a new probe behind an already closed barrier'
else
  fail 'probe creation in closed state'
fi

reset_fixture
capture_normal
aud065_pgsql_barrier_close blocked_callback
aud065_pgsql_barrier_open reachable_callback
RECOVERY_OPERATION_STATE=cleanup-authorized
if ! aud065_require_pgsql_barrier_released &&
   aud065_pgsql_barrier_cleanup reachable_callback verified_report_callback &&
   aud065_require_pgsql_barrier_released; then
  pass 'release gate accepts only clean normal policy plus absent probe under lock and Lease'
else
  fail 'clean release gate'
fi

aud065_pgsql_probe_bind_image "$PGSQL_IMAGE"
aud065_pgsql_probe_create
if ! aud065_require_pgsql_barrier_released; then
  pass 'release gate rejects a remaining operation probe'
else
  fail 'release with remaining probe'
fi

jq -cn '{apiVersion:"v1",kind:"PodList",items:[{
  apiVersion:"v1",kind:"Pod",
  metadata:{name:"aud065-pgsql-probe-222222222222",namespace:"hcce",uid:"foreign-probe"}
}]}' >"$PODS_FILE"
if ! aud065_require_pgsql_barrier_released; then
  pass 'release gate finds a same-name probe even after its labels drift'
else
  fail 'release with same-name label-drifted probe'
fi

empty_pods >"$PODS_FILE"
AUD065_PGSQL_PROBE_UID=""
RECOVERY_OPERATION_STATE=quiesced
if ! aud065_require_pgsql_barrier_released; then
  pass 'release gate rejects a lock without durable cleanup authorization'
else
  fail 'release before verified lock state'
fi

printf '%s passed, %s failed\n' "$PASS_COUNT" "$FAIL_COUNT"
[[ "$FAIL_COUNT" == 0 ]]

#!/usr/bin/env bash

# AUD-065 PostgreSQL network barrier.
#
# This file is a sourced library. recovery-safety.sh must already be sourced by
# the coordinator.  The barrier mutates the existing pgsql-ingress
# NetworkPolicy by resourceVersion compare-and-set; it never creates a second
# policy.  Every mutation is therefore covered by the global operation Lease
# and the immutable AUD-065 operation lock.

AUD065_PGSQL_POLICY_NAME="pgsql-ingress"
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

AUD065_PGSQL_MARKER_LOCK_UID="yenhubs.org/aud065-pgsql-lock-uid"
AUD065_PGSQL_MARKER_TOKEN="yenhubs.org/aud065-pgsql-operation-token"
AUD065_PGSQL_MARKER_BINDING="yenhubs.org/aud065-pgsql-operation-binding-sha256"
AUD065_PGSQL_MARKER_STATE="yenhubs.org/aud065-pgsql-barrier-state"
AUD065_PGSQL_MARKER_SPEC_SHA="yenhubs.org/aud065-pgsql-normal-spec-sha256"

aud065_pgsql_sha256_text() {
  local value="$1" digest
  if command -v shasum >/dev/null 2>&1; then
    digest="$(printf '%s' "$value" | shasum -a 256)" || return 1
  elif command -v sha256sum >/dev/null 2>&1; then
    digest="$(printf '%s' "$value" | sha256sum)" || return 1
  else
    return 127
  fi
  digest="${digest%%[[:space:]]*}"
  [[ "$digest" =~ ^[a-f0-9]{64}$ ]] || return 1
  printf '%s\n' "$digest"
}

aud065_pgsql_normal_spec_json() {
  jq -cnS '{
    podSelector:{matchLabels:{app:"pgsql"}},
    policyTypes:["Ingress"],
    ingress:[{
      from:[
        {podSelector:{matchLabels:{app:"pgbouncer"}}},
        {podSelector:{matchLabels:{app:"pgbouncer-t"}}}
      ],
      ports:[{protocol:"TCP",port:5432}]
    }]
  }'
}

aud065_pgsql_closed_spec_json() {
  jq -cnS '{
    podSelector:{matchLabels:{app:"pgsql"}},
    policyTypes:["Ingress"],
    ingress:[]
  }'
}

aud065_pgsql_compute_normal_spec_sha() {
  local normal
  normal="$(aud065_pgsql_normal_spec_json)" || return 1
  aud065_pgsql_sha256_text "$normal"
}

aud065_pgsql_require_runtime_contract() {
  declare -F recovery_require_operation_serialization >/dev/null 2>&1 &&
    declare -F recovery_require_operation_lock >/dev/null 2>&1 &&
    declare -F recovery_kubectl >/dev/null 2>&1 &&
    declare -F recovery_kubectl_mutate >/dev/null 2>&1 &&
    declare -F recovery_delete_namespaced_with_uid >/dev/null 2>&1 &&
    command -v jq >/dev/null 2>&1
}

aud065_pgsql_require_guard() {
  aud065_pgsql_require_runtime_contract || return 1
  [[ "${RECOVERY_OPERATION_OWNER:-}" == aud065-rotation &&
     "${RECOVERY_OPERATION_LOCK_UID:-}" != "" &&
     "${RECOVERY_OPERATION_TOKEN:-}" =~ ^[a-f0-9]{32}$ &&
     "${RECOVERY_OPERATION_ID:-}" =~ ^[a-f0-9]{32}$ &&
     "${RECOVERY_OPERATION_BINDING_SHA256:-}" =~ ^[a-f0-9]{64}$ ]] || return 1
  recovery_require_operation_serialization || return 1
  recovery_require_operation_lock
}

# A second ingress policy which can select app=pgsql would make the result of
# replacing pgsql-ingress ambiguous.  Fail closed even if that policy happens
# to allow traffic: this component owns exactly one barrier surface.
aud065_pgsql_policy_inventory_is_exact() {
  local policies_json="$1"
  jq -e --arg namespace "$NAMESPACE" --arg name "$AUD065_PGSQL_POLICY_NAME" '
    def ingress_policy:
      if (.spec.policyTypes // null) == null then true
      else ((.spec.policyTypes | index("Ingress")) != null)
      end;
    def could_select_pgsql:
      (.spec.podSelector // {}) as $selector |
      (($selector | keys) - ["matchLabels", "matchExpressions"] | length) == 0 and
      (($selector.matchLabels // {}) | type == "object") and
      (($selector.matchExpressions // []) | type == "array") and
      all(($selector.matchLabels // {}) | to_entries[];
        if .key == "app" then .value == "pgsql" else true end) and
      all(($selector.matchExpressions // [])[];
        (. | type == "object") and
        if .key != "app" then true
        elif .operator == "In" then ((.values // []) | index("pgsql")) != null
        elif .operator == "NotIn" then ((.values // []) | index("pgsql")) == null
        elif .operator == "Exists" then true
        elif .operator == "DoesNotExist" then false
        else false
        end);
    .apiVersion == "networking.k8s.io/v1" and
    .kind == "NetworkPolicyList" and
    (.items | type == "array") and
    ([.items[] | select(.metadata.name == $name and .metadata.namespace == $namespace)] | length) == 1 and
    ([.items[] |
      select(.metadata.namespace == $namespace and .metadata.name != $name) |
      select(ingress_policy and could_select_pgsql)] | length) == 0
  ' >/dev/null 2>&1 <<<"$policies_json"
}

aud065_pgsql_require_single_policy() {
  local policies_json
  policies_json="$(recovery_kubectl get networkpolicy -n "$NAMESPACE" -o json)" || return 1
  aud065_pgsql_policy_inventory_is_exact "$policies_json" || {
    printf 'PostgreSQL ingress is affected by a second or malformed NetworkPolicy.\n' >&2
    return 1
  }
}

aud065_pgsql_policy_base_metadata_json() {
  local policy_json="$1"
  jq -cS \
    --arg lock "$AUD065_PGSQL_MARKER_LOCK_UID" \
    --arg token "$AUD065_PGSQL_MARKER_TOKEN" \
    --arg binding "$AUD065_PGSQL_MARKER_BINDING" \
    --arg state "$AUD065_PGSQL_MARKER_STATE" \
    --arg spec_sha "$AUD065_PGSQL_MARKER_SPEC_SHA" '
    {
      labels:(.metadata.labels // {}),
      annotations:((.metadata.annotations // {}) |
        del(.[$lock], .[$token], .[$binding], .[$state], .[$spec_sha])),
      ownerReferences:(.metadata.ownerReferences // []),
      finalizers:(.metadata.finalizers // [])
    }
  ' <<<"$policy_json"
}

aud065_pgsql_policy_base_metadata_sha() {
  local metadata
  metadata="$(aud065_pgsql_policy_base_metadata_json "$1")" || return 1
  aud065_pgsql_sha256_text "$metadata"
}

aud065_pgsql_policy_structure_is_safe() {
  local policy_json="$1"
  jq -e --arg namespace "$NAMESPACE" --arg name "$AUD065_PGSQL_POLICY_NAME" '
    .apiVersion == "networking.k8s.io/v1" and
    .kind == "NetworkPolicy" and
    .metadata.name == $name and .metadata.namespace == $namespace and
    (.metadata.uid | type == "string" and length > 0) and
    (.metadata.resourceVersion | type == "string" and length > 0) and
    (.metadata.deletionTimestamp // null) == null and
    (.metadata.ownerReferences // []) == [] and
    (.metadata.finalizers // []) == [] and
    ((.metadata.labels // {}) | type == "object") and
    ((.metadata.annotations // {}) | type == "object")
  ' >/dev/null 2>&1 <<<"$policy_json"
}

aud065_pgsql_policy_reserved_annotations_are_exact() {
  local policy_json="$1" expected_state="$2"
  local normal_sha
  normal_sha="${AUD065_PGSQL_NORMAL_SPEC_SHA256:-}"
  if [[ "$expected_state" == normal ]]; then
    jq -e \
      --arg lock "$AUD065_PGSQL_MARKER_LOCK_UID" \
      --arg token "$AUD065_PGSQL_MARKER_TOKEN" \
      --arg binding "$AUD065_PGSQL_MARKER_BINDING" \
      --arg state "$AUD065_PGSQL_MARKER_STATE" \
      --arg spec_sha "$AUD065_PGSQL_MARKER_SPEC_SHA" '
      (.metadata.annotations // {}) as $annotations |
      ($annotations | has($lock) or has($token) or has($binding) or
        has($state) or has($spec_sha)) | not
    ' >/dev/null 2>&1 <<<"$policy_json"
    return
  fi
  jq -e \
    --arg lock_key "$AUD065_PGSQL_MARKER_LOCK_UID" \
    --arg token_key "$AUD065_PGSQL_MARKER_TOKEN" \
    --arg binding_key "$AUD065_PGSQL_MARKER_BINDING" \
    --arg state_key "$AUD065_PGSQL_MARKER_STATE" \
    --arg spec_key "$AUD065_PGSQL_MARKER_SPEC_SHA" \
    --arg lock_uid "$RECOVERY_OPERATION_LOCK_UID" \
    --arg token "$RECOVERY_OPERATION_TOKEN" \
    --arg binding "$RECOVERY_OPERATION_BINDING_SHA256" \
    --arg expected_state "$expected_state" \
    --arg normal_sha "$normal_sha" '
    (.metadata.annotations // {}) as $annotations |
    $annotations[$lock_key] == $lock_uid and
    $annotations[$token_key] == $token and
    $annotations[$binding_key] == $binding and
    $annotations[$state_key] == $expected_state and
    $annotations[$spec_key] == $normal_sha
  ' >/dev/null 2>&1 <<<"$policy_json"
}

aud065_pgsql_policy_json_is_exact() {
  local policy_json="$1" expected_state="$2" metadata_sha live_metadata_sha normal closed
  [[ "$expected_state" =~ ^(normal|closed|open-verified)$ &&
     "${AUD065_PGSQL_POLICY_UID:-}" != "" &&
     "${AUD065_PGSQL_NORMAL_METADATA_SHA256:-}" =~ ^[a-f0-9]{64}$ &&
     "${AUD065_PGSQL_NORMAL_SPEC_SHA256:-}" =~ ^[a-f0-9]{64}$ ]] || return 2
  aud065_pgsql_policy_structure_is_safe "$policy_json" || return 1
  jq -e --arg uid "$AUD065_PGSQL_POLICY_UID" '.metadata.uid == $uid' \
    >/dev/null 2>&1 <<<"$policy_json" || return 1
  live_metadata_sha="$(aud065_pgsql_policy_base_metadata_sha "$policy_json")" || return 1
  metadata_sha="$AUD065_PGSQL_NORMAL_METADATA_SHA256"
  [[ "$live_metadata_sha" == "$metadata_sha" ]] || return 1
  aud065_pgsql_policy_reserved_annotations_are_exact "$policy_json" "$expected_state" || return 1
  normal="$(aud065_pgsql_normal_spec_json)" || return 1
  closed="$(aud065_pgsql_closed_spec_json)" || return 1
  if [[ "$expected_state" == closed ]]; then
    jq -e --argjson expected "$closed" '.spec == $expected' >/dev/null 2>&1 <<<"$policy_json"
  else
    jq -e --argjson expected "$normal" '.spec == $expected' >/dev/null 2>&1 <<<"$policy_json"
  fi
}

aud065_pgsql_barrier_bind() {
  local policy_uid="$1" metadata_sha="$2" persisted_resource_version="${3:-}" normal_sha
  [[ -n "$policy_uid" && "$metadata_sha" =~ ^[a-f0-9]{64}$ &&
     ${#persisted_resource_version} -le 256 &&
     ! "$persisted_resource_version" =~ [[:space:][:cntrl:]] ]] || return 2
  normal_sha="$(aud065_pgsql_compute_normal_spec_sha)" || return 1
  AUD065_PGSQL_POLICY_UID="$policy_uid"
  AUD065_PGSQL_NORMAL_METADATA_SHA256="$metadata_sha"
  AUD065_PGSQL_NORMAL_SPEC_SHA256="$normal_sha"
  # A durable pre-close binding may include the exact clean-normal
  # resourceVersion.  This closes the crash window between persisting the
  # policy identity and the first normal -> closed CAS.  Marked closed/open
  # states remain adoptable after their own CAS because their annotations bind
  # them to this operation independently of the earlier normal RV.
  AUD065_PGSQL_POLICY_RESOURCE_VERSION="$persisted_resource_version"
  AUD065_PGSQL_INITIAL_RESOURCE_VERSION="$persisted_resource_version"
  if [[ -n "$persisted_resource_version" ]]; then
    AUD065_PGSQL_BARRIER_STATE=normal
  else
    AUD065_PGSQL_BARRIER_STATE=""
  fi
  AUD065_PGSQL_POSTOPEN_VERIFIED=0
  AUD065_PGSQL_CLEANUP_AUTHORIZED=0
  export AUD065_PGSQL_POLICY_UID AUD065_PGSQL_NORMAL_METADATA_SHA256 \
    AUD065_PGSQL_NORMAL_SPEC_SHA256 AUD065_PGSQL_POLICY_RESOURCE_VERSION \
    AUD065_PGSQL_INITIAL_RESOURCE_VERSION AUD065_PGSQL_BARRIER_STATE \
    AUD065_PGSQL_POSTOPEN_VERIFIED AUD065_PGSQL_CLEANUP_AUTHORIZED
}

aud065_pgsql_barrier_capture_normal() {
  local policy_json uid resource_version metadata_sha normal_sha
  aud065_pgsql_require_guard || return 1
  aud065_pgsql_require_single_policy || return 1
  policy_json="$(recovery_kubectl get networkpolicy "$AUD065_PGSQL_POLICY_NAME" \
    -n "$NAMESPACE" -o json)" || return 1
  aud065_pgsql_policy_structure_is_safe "$policy_json" || return 1
  # Capture accepts only the exact clean normal spec and no pre-existing
  # barrier marker.  The user metadata is fingerprinted for crash-safe bind.
  normal_sha="$(aud065_pgsql_compute_normal_spec_sha)" || return 1
  AUD065_PGSQL_NORMAL_SPEC_SHA256="$normal_sha"
  AUD065_PGSQL_POLICY_UID="$(jq -er '.metadata.uid' <<<"$policy_json")" || return 1
  metadata_sha="$(aud065_pgsql_policy_base_metadata_sha "$policy_json")" || return 1
  AUD065_PGSQL_NORMAL_METADATA_SHA256="$metadata_sha"
  if ! aud065_pgsql_policy_json_is_exact "$policy_json" normal; then
    AUD065_PGSQL_POLICY_UID=""
    AUD065_PGSQL_NORMAL_METADATA_SHA256=""
    return 1
  fi
  uid="$AUD065_PGSQL_POLICY_UID"
  resource_version="$(jq -er '.metadata.resourceVersion' <<<"$policy_json")" || return 1
  AUD065_PGSQL_POLICY_UID="$uid"
  AUD065_PGSQL_POLICY_RESOURCE_VERSION="$resource_version"
  AUD065_PGSQL_INITIAL_RESOURCE_VERSION="$resource_version"
  AUD065_PGSQL_BARRIER_STATE=normal
  AUD065_PGSQL_POSTOPEN_VERIFIED=0
  AUD065_PGSQL_CLEANUP_AUTHORIZED=0
  export AUD065_PGSQL_POLICY_UID AUD065_PGSQL_POLICY_RESOURCE_VERSION \
    AUD065_PGSQL_INITIAL_RESOURCE_VERSION \
    AUD065_PGSQL_NORMAL_METADATA_SHA256 AUD065_PGSQL_NORMAL_SPEC_SHA256 \
    AUD065_PGSQL_BARRIER_STATE AUD065_PGSQL_POSTOPEN_VERIFIED \
    AUD065_PGSQL_CLEANUP_AUTHORIZED
  printf '%s\t%s\t%s\t%s\n' \
    "$uid" "$resource_version" "$metadata_sha" "$normal_sha"
}

aud065_pgsql_barrier_adopt() {
  local expected_state="${1:-}" policy_json resource_version state previous_resource_version
  [[ -z "$expected_state" || "$expected_state" =~ ^(normal|closed|open-verified)$ ]] || return 2
  aud065_pgsql_require_guard || return 1
  aud065_pgsql_require_single_policy || return 1
  policy_json="$(recovery_kubectl get networkpolicy "$AUD065_PGSQL_POLICY_NAME" \
    -n "$NAMESPACE" -o json)" || return 1
  previous_resource_version="$AUD065_PGSQL_POLICY_RESOURCE_VERSION"
  for state in normal closed open-verified; do
    if aud065_pgsql_policy_json_is_exact "$policy_json" "$state"; then
      [[ -z "$expected_state" || "$state" == "$expected_state" ]] || return 1
      resource_version="$(jq -er '.metadata.resourceVersion' <<<"$policy_json")" || return 1
      if [[ "$state" == normal ]]; then
        # A marker-free normal object is safe to adopt only from an exact
        # captured/persisted RV.  Otherwise a same-spec replace (ABA) could be
        # mistaken for the object that was bound before the crash.
        [[ "$AUD065_PGSQL_BARRIER_STATE" == normal &&
           -n "$previous_resource_version" &&
           "$resource_version" == "$previous_resource_version" ]] || return 1
      fi
      AUD065_PGSQL_POLICY_RESOURCE_VERSION="$resource_version"
      AUD065_PGSQL_BARRIER_STATE="$state"
      AUD065_PGSQL_POSTOPEN_VERIFIED=0
      export AUD065_PGSQL_POLICY_RESOURCE_VERSION AUD065_PGSQL_BARRIER_STATE \
        AUD065_PGSQL_POSTOPEN_VERIFIED
      printf '%s\n' "$state"
      return 0
    fi
  done
  printf 'PostgreSQL ingress does not match any exact AUD-065 barrier state.\n' >&2
  return 1
}

# Adopt an advanced, exact clean-normal object solely as the cursor for a
# compensating close. Callers own the state restriction; this common body never
# grants cleanup/release authority.
_aud065_pgsql_barrier_adopt_advanced_normal_for_close() {
  local policy_json resource_version
  [[ "${AUD065_PGSQL_BARRIER_STATE:-}" == normal &&
     -n "${AUD065_PGSQL_INITIAL_RESOURCE_VERSION:-}" ]] || return 1
  aud065_pgsql_require_guard || return 1
  aud065_pgsql_require_single_policy || return 1
  policy_json="$(recovery_kubectl get networkpolicy "$AUD065_PGSQL_POLICY_NAME" \
    -n "$NAMESPACE" -o json)" || return 1
  aud065_pgsql_policy_json_is_exact "$policy_json" normal || return 1
  resource_version="$(jq -er \
    '.metadata.resourceVersion | select(type == "string" and length > 0)' \
    <<<"$policy_json")" || return 1
  [[ "$resource_version" != "$AUD065_PGSQL_INITIAL_RESOURCE_VERSION" ]] || {
    printf 'PostgreSQL barrier cannot adopt the initial normal state as cleanup evidence.\n' >&2
    return 1
  }
  AUD065_PGSQL_POLICY_RESOURCE_VERSION="$resource_version"
  AUD065_PGSQL_BARRIER_STATE=normal
  AUD065_PGSQL_POSTOPEN_VERIFIED=0
  # Adoption authorizes only a compensating close.  A later successful cleanup
  # must repeat its report and reachability gates before release is possible.
  AUD065_PGSQL_CLEANUP_AUTHORIZED=0
  export AUD065_PGSQL_POLICY_RESOURCE_VERSION AUD065_PGSQL_BARRIER_STATE \
    AUD065_PGSQL_POSTOPEN_VERIFIED AUD065_PGSQL_CLEANUP_AUTHORIZED
  printf 'normal\n'
}

# After durable cleanup authorization, the marker-removal CAS intentionally
# leaves the policy in a clean normal state at a resourceVersion newer than the
# pre-close binding. This public path remains strict to that durable state.
aud065_pgsql_barrier_adopt_cleanup_normal() {
  [[ "${RECOVERY_OPERATION_STATE:-}" == cleanup-authorized ]] || return 1
  _aud065_pgsql_barrier_adopt_advanced_normal_for_close
}

# A verified operation can observe an externally restored exact clean-normal
# policy at an advanced resourceVersion. It is not cleanup evidence, but it is
# safe to adopt narrowly for fencing: the next permitted action is a guarded
# normal->closed CAS and release remains explicitly unauthorized.
aud065_pgsql_barrier_adopt_compensating_normal() {
  [[ "${RECOVERY_OPERATION_STATE:-}" == verified ||
     "${RECOVERY_OPERATION_STATE:-}" == cleanup-authorized ]] || return 1
  _aud065_pgsql_barrier_adopt_advanced_normal_for_close
}

# Observe a live state without changing the process-local resourceVersion. This
# distinction is essential for ABA protection: a clean normal object may be
# adopted only by the explicit preflight capture, while states carrying this
# operation's immutable markers are safe to resume after a crash.
aud065_pgsql_barrier_read_state() {
  local policy_json state
  aud065_pgsql_require_guard || return 1
  aud065_pgsql_require_single_policy || return 1
  policy_json="$(recovery_kubectl get networkpolicy "$AUD065_PGSQL_POLICY_NAME" \
    -n "$NAMESPACE" -o json)" || return 1
  for state in normal closed open-verified; do
    if aud065_pgsql_policy_json_is_exact "$policy_json" "$state"; then
      printf '%s\n' "$state"
      return 0
    fi
  done
  return 1
}

aud065_pgsql_policy_replacement_json() {
  local policy_json="$1" next_state="$2" normal closed
  normal="$(aud065_pgsql_normal_spec_json)" || return 1
  closed="$(aud065_pgsql_closed_spec_json)" || return 1
  case "$next_state" in
    closed|open-verified)
      jq -c \
        --arg lock_key "$AUD065_PGSQL_MARKER_LOCK_UID" \
        --arg token_key "$AUD065_PGSQL_MARKER_TOKEN" \
        --arg binding_key "$AUD065_PGSQL_MARKER_BINDING" \
        --arg state_key "$AUD065_PGSQL_MARKER_STATE" \
        --arg spec_key "$AUD065_PGSQL_MARKER_SPEC_SHA" \
        --arg lock_uid "$RECOVERY_OPERATION_LOCK_UID" \
        --arg token "$RECOVERY_OPERATION_TOKEN" \
        --arg binding "$RECOVERY_OPERATION_BINDING_SHA256" \
        --arg state "$next_state" \
        --arg normal_sha "$AUD065_PGSQL_NORMAL_SPEC_SHA256" \
        --argjson normal "$normal" --argjson closed "$closed" '
        del(.status) |
        .metadata.annotations = (.metadata.annotations // {}) |
        .metadata.annotations[$lock_key] = $lock_uid |
        .metadata.annotations[$token_key] = $token |
        .metadata.annotations[$binding_key] = $binding |
        .metadata.annotations[$state_key] = $state |
        .metadata.annotations[$spec_key] = $normal_sha |
        .spec = (if $state == "closed" then $closed else $normal end)
      ' <<<"$policy_json"
      ;;
    normal)
      jq -c \
        --arg lock "$AUD065_PGSQL_MARKER_LOCK_UID" \
        --arg token "$AUD065_PGSQL_MARKER_TOKEN" \
        --arg binding "$AUD065_PGSQL_MARKER_BINDING" \
        --arg state "$AUD065_PGSQL_MARKER_STATE" \
        --arg spec_sha "$AUD065_PGSQL_MARKER_SPEC_SHA" \
        --argjson normal "$normal" '
        del(.status) |
        .metadata.annotations = ((.metadata.annotations // {}) |
          del(.[$lock], .[$token], .[$binding], .[$state], .[$spec_sha])) |
        if (.metadata.annotations | length) == 0 then del(.metadata.annotations) else . end |
        .spec = $normal
      ' <<<"$policy_json"
      ;;
    *) return 2 ;;
  esac
}

aud065_pgsql_barrier_replace_state() {
  local current_state="$1" next_state="$2"
  local policy_json replacement replaced live_json before_rv after_rv live_rv
  [[ "$current_state:$next_state" =~ ^(normal:closed|closed:open-verified|open-verified:closed|open-verified:normal)$ ]] || return 2
  aud065_pgsql_require_guard || return 1
  aud065_pgsql_require_single_policy || return 1
  policy_json="$(recovery_kubectl get networkpolicy "$AUD065_PGSQL_POLICY_NAME" \
    -n "$NAMESPACE" -o json)" || return 1
  aud065_pgsql_policy_json_is_exact "$policy_json" "$current_state" || return 1
  before_rv="$(jq -er '.metadata.resourceVersion' <<<"$policy_json")" || return 1
  [[ "$before_rv" == "$AUD065_PGSQL_POLICY_RESOURCE_VERSION" ]] || {
    printf 'PostgreSQL ingress resourceVersion changed before compare-and-set.\n' >&2
    return 1
  }
  replacement="$(aud065_pgsql_policy_replacement_json "$policy_json" "$next_state")" || return 1
  replaced="$(printf '%s\n' "$replacement" |
    recovery_kubectl_mutate replace -f - -o json)" || return 1
  after_rv="$(jq -er --arg uid "$AUD065_PGSQL_POLICY_UID" '
    select(.metadata.uid == $uid) |
    .metadata.resourceVersion | select(type == "string" and length > 0)
  ' <<<"$replaced")" || return 1
  [[ "$after_rv" != "$before_rv" ]] || return 1
  AUD065_PGSQL_POLICY_RESOURCE_VERSION="$after_rv"
  AUD065_PGSQL_BARRIER_STATE="$next_state"
  export AUD065_PGSQL_POLICY_RESOURCE_VERSION AUD065_PGSQL_BARRIER_STATE
  aud065_pgsql_policy_json_is_exact "$replaced" "$next_state" || return 1
  aud065_pgsql_require_guard || return 1
  live_json="$(recovery_kubectl get networkpolicy "$AUD065_PGSQL_POLICY_NAME" \
    -n "$NAMESPACE" -o json)" || return 1
  live_rv="$(jq -er '.metadata.resourceVersion' <<<"$live_json")" || return 1
  [[ "$live_rv" == "$after_rv" ]] || return 1
  aud065_pgsql_policy_json_is_exact "$live_json" "$next_state"
}

aud065_pgsql_run_strict_callback() {
  local callback="$1" expected="$2" output
  [[ "$callback" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 2
  declare -F "$callback" >/dev/null 2>&1 || command -v "$callback" >/dev/null 2>&1 || return 2
  if ! output="$({ set +x; "$callback"; } 2>/dev/null)"; then
    return 1
  fi
  [[ "$output" == "$expected" ]]
}

aud065_require_pgsql_consumers_absent() {
  aud065_pgsql_run_strict_callback "$1" absent
}

aud065_require_pgsql_consumer_pods_absent() {
  aud065_pgsql_run_strict_callback "$1" absent
}

aud065_require_pgsql_consumers_and_pods_absent() {
  aud065_require_pgsql_consumers_absent "$1" &&
    aud065_require_pgsql_consumer_pods_absent "$2"
}

aud065_require_pgsql_probe_preclose_reachable() {
  aud065_pgsql_run_strict_callback "$1" 0
}

aud065_require_pgsql_probe_postclose_stably_blocked() {
  aud065_pgsql_run_strict_callback "$1" $'2\n2\n2'
}

aud065_require_no_pgsql_client_backends() {
  aud065_pgsql_run_strict_callback "$1" 0
}

aud065_require_pgsql_unix_socket_local() {
  aud065_pgsql_run_strict_callback "$1" 0
}

aud065_require_pgsql_probe_postopen_reachable() {
  aud065_pgsql_run_strict_callback "$1" 0
}

aud065_pgsql_barrier_close() {
  local postclose_callback="$1" current_state
  current_state="$(aud065_pgsql_barrier_read_state)" || return 1
  case "$current_state" in
    normal)
      # Never learn a fresh normal resourceVersion here. It must still be the
      # exact one captured during preflight, otherwise a same-spec ABA wins.
      [[ "$AUD065_PGSQL_BARRIER_STATE" == normal &&
         -n "$AUD065_PGSQL_POLICY_RESOURCE_VERSION" ]] || return 1
      aud065_pgsql_barrier_replace_state normal closed || return 1
      ;;
    closed)
      aud065_pgsql_barrier_adopt closed >/dev/null || return 1
      ;;
    open-verified)
      # Fail-close after the admission gate was reopened must be able to fence
      # PostgreSQL again.  Preserve the operation markers and advance by CAS.
      aud065_pgsql_barrier_adopt open-verified >/dev/null || return 1
      aud065_pgsql_barrier_replace_state open-verified closed || return 1
      ;;
    *) return 1 ;;
  esac
  # NetworkPolicy replacement succeeding is not evidence that the CNI has
  # enforced it. Three stable pg_isready=2 observations are mandatory.
  aud065_require_pgsql_probe_postclose_stably_blocked "$postclose_callback"
}

aud065_pgsql_barrier_open() {
  local postopen_callback="$1" current_state
  current_state="$(aud065_pgsql_barrier_read_state)" || return 1
  case "$current_state" in
    closed)
      aud065_pgsql_barrier_adopt closed >/dev/null || return 1
      aud065_pgsql_barrier_replace_state closed open-verified || return 1
      ;;
    open-verified)
      aud065_pgsql_barrier_adopt open-verified >/dev/null || return 1
      ;;
    *) return 1 ;;
  esac
  # Re-entry deliberately repeats this check. A crash between the API replace
  # and the observation can therefore never authorize cleanup by itself.
  aud065_require_pgsql_probe_postopen_reachable "$postopen_callback" || return 1
  AUD065_PGSQL_POSTOPEN_VERIFIED=1
  export AUD065_PGSQL_POSTOPEN_VERIFIED
}

aud065_pgsql_barrier_cleanup() {
  local postopen_callback="$1" verification_callback="${2:-}" current_state
  local policy_json live_resource_version
  aud065_pgsql_require_guard || return 1
  [[ "${RECOVERY_OPERATION_STATE:-}" == cleanup-authorized &&
     "${AUD065_PGSQL_INITIAL_RESOURCE_VERSION:-}" != "" ]] || {
    printf 'PostgreSQL barrier cleanup requires durable cleanup authorization.\n' >&2
    return 1
  }
  # The independently authenticated rollout report proves that verification
  # observed this operation's exact open-verified policy. The terminal record
  # is deliberately written only after policy and probe cleanup complete.
  aud065_pgsql_run_strict_callback "$verification_callback" cleanup-authorized || {
    printf 'PostgreSQL barrier cleanup requires the verified rollout report.\n' >&2
    return 1
  }
  AUD065_PGSQL_CLEANUP_AUTHORIZED=1
  export AUD065_PGSQL_CLEANUP_AUTHORIZED
  current_state="$(aud065_pgsql_barrier_read_state)" || return 1
  case "$current_state" in
    open-verified)
      aud065_pgsql_barrier_adopt open-verified >/dev/null || return 1
      aud065_require_pgsql_probe_postopen_reachable "$postopen_callback" || return 1
      AUD065_PGSQL_POSTOPEN_VERIFIED=1
      aud065_pgsql_barrier_replace_state open-verified normal || return 1
      ;;
    normal)
      # Idempotent crash recovery after the cleanup CAS. A marker-free normal
      # object at the original pre-close resourceVersion is the untouched
      # initial state, not cleanup evidence. The authenticated rollout report
      # above binds the exact open-verified rollout and makes a later RV safe
      # to treat as the result of the marker-removal CAS on re-entry.
      policy_json="$(recovery_kubectl get networkpolicy "$AUD065_PGSQL_POLICY_NAME" \
        -n "$NAMESPACE" -o json)" || return 1
      aud065_pgsql_policy_json_is_exact "$policy_json" normal || return 1
      live_resource_version="$(jq -er '.metadata.resourceVersion' \
        <<<"$policy_json")" || return 1
      [[ "$live_resource_version" != "$AUD065_PGSQL_INITIAL_RESOURCE_VERSION" ]] || {
        printf 'PostgreSQL barrier cleanup cannot adopt the initial normal state.\n' >&2
        return 1
      }
      AUD065_PGSQL_POLICY_RESOURCE_VERSION="$live_resource_version"
      ;;
    *)
      printf 'PostgreSQL barrier cleanup requires open-verified state.\n' >&2
      return 1
      ;;
  esac
  AUD065_PGSQL_BARRIER_STATE=normal
  export AUD065_PGSQL_POLICY_RESOURCE_VERSION AUD065_PGSQL_BARRIER_STATE \
    AUD065_PGSQL_POSTOPEN_VERIFIED AUD065_PGSQL_CLEANUP_AUTHORIZED
}

aud065_pgsql_probe_name() {
  [[ "${RECOVERY_OPERATION_ID:-}" =~ ^[a-f0-9]{32}$ ]] || return 1
  printf 'aud065-pgsql-probe-%s\n' "${RECOVERY_OPERATION_ID:0:12}"
}

aud065_pgsql_probe_bind_image() {
  local image="$1"
  [[ "$image" =~ ^[^[:space:]@]+@sha256:[a-f0-9]{64}$ ]] || return 2
  AUD065_PGSQL_PROBE_IMAGE="$image"
  AUD065_PGSQL_PROBE_UID=""
  export AUD065_PGSQL_PROBE_IMAGE AUD065_PGSQL_PROBE_UID
}

aud065_pgsql_probe_image_matches_pgsql() {
  local deployment_json pods_json
  [[ "${AUD065_PGSQL_PROBE_IMAGE:-}" =~ ^[^[:space:]@]+@sha256:[a-f0-9]{64}$ ]] || return 1
  deployment_json="$(recovery_kubectl get deployment pgsql -n "$NAMESPACE" -o json)" || return 1
  jq -e --arg namespace "$NAMESPACE" --arg image "$AUD065_PGSQL_PROBE_IMAGE" '
    .apiVersion == "apps/v1" and .kind == "Deployment" and
    .metadata.name == "pgsql" and .metadata.namespace == $namespace and
    (.metadata.uid | type == "string" and length > 0) and
    (.spec.template.spec.containers | length) == 1 and
    .spec.template.spec.containers[0].name == "postgresql" and
    .spec.template.spec.containers[0].image == $image
  ' >/dev/null 2>&1 <<<"$deployment_json" || return 1
  pods_json="$(recovery_kubectl get pod -n "$NAMESPACE" -l app=pgsql -o json)" || return 1
  jq -e --arg namespace "$NAMESPACE" --arg image "$AUD065_PGSQL_PROBE_IMAGE" '
    .apiVersion == "v1" and .kind == "PodList" and
    (.items | type == "array" and length == 1) and .items[0] as $pod |
    $pod.metadata.namespace == $namespace and
    ($pod.metadata.uid | type == "string" and length > 0) and
    ($pod.metadata.deletionTimestamp // null) == null and
    $pod.metadata.labels.app == "pgsql" and
    ($pod.spec.containers | length) == 1 and
    $pod.spec.containers[0].name == "postgresql" and
    $pod.spec.containers[0].image == $image and
    $pod.status.phase == "Running" and
    ([ $pod.status.conditions[]? | select(.type == "Ready" and .status == "True") ] | length) == 1 and
    ([ $pod.status.containerStatuses[]? |
      select(.name == "postgresql" and .ready == true) ] | length) == 1
  ' >/dev/null 2>&1 <<<"$pods_json"
}

aud065_pgsql_probe_manifest_json() {
  local probe_name
  probe_name="$(aud065_pgsql_probe_name)" || return 1
  jq -cn \
    --arg namespace "$NAMESPACE" --arg name "$probe_name" \
    --arg operation_id "$RECOVERY_OPERATION_ID" \
    --arg lock_name "$RECOVERY_OPERATION_LOCK_NAME" \
    --arg lock_uid "$RECOVERY_OPERATION_LOCK_UID" \
    --arg image "$AUD065_PGSQL_PROBE_IMAGE" '
    {
      apiVersion:"v1",kind:"Pod",
      metadata:{
        name:$name,namespace:$namespace,
        labels:{
          app:"pgbouncer",
          "yenhubs.org/aud065-pgsql-probe":"true",
          "yenhubs.org/operation-id":$operation_id
        },
        ownerReferences:[{
          apiVersion:"v1",kind:"ConfigMap",name:$lock_name,uid:$lock_uid,
          controller:false,blockOwnerDeletion:false
        }]
      },
      spec:{
        automountServiceAccountToken:false,
        enableServiceLinks:false,
        restartPolicy:"Never",
        terminationGracePeriodSeconds:5,
        dnsPolicy:"ClusterFirst",
        schedulerName:"default-scheduler",
        serviceAccountName:"default",
        securityContext:{
          runAsNonRoot:true,runAsUser:999,runAsGroup:999,fsGroup:999,
          seccompProfile:{type:"RuntimeDefault"}
        },
        containers:[{
          name:"probe",image:$image,imagePullPolicy:"IfNotPresent",
          command:["sh","-ec","trap \"exit 0\" TERM INT; while :; do sleep 30 & wait $!; done"],
          resources:{requests:{cpu:"1m",memory:"8Mi"},limits:{memory:"32Mi"}},
          readinessProbe:{
            exec:{command:["sh","-c","exit 1"]},
            initialDelaySeconds:0,periodSeconds:2,timeoutSeconds:1,
            successThreshold:1,failureThreshold:1
          },
          securityContext:{
            runAsNonRoot:true,runAsUser:999,runAsGroup:999,
            allowPrivilegeEscalation:false,readOnlyRootFilesystem:true,
            capabilities:{drop:["ALL"]},seccompProfile:{type:"RuntimeDefault"}
          },
          terminationMessagePath:"/dev/termination-log",
          terminationMessagePolicy:"File"
        }]
      }
    }
  '
}

aud065_pgsql_probe_json_is_exact() {
  local pod_json="$1" probe_name
  probe_name="$(aud065_pgsql_probe_name)" || return 1
  [[ "${AUD065_PGSQL_PROBE_IMAGE:-}" =~ ^[^[:space:]@]+@sha256:[a-f0-9]{64}$ ]] || return 2
  jq -e \
    --arg namespace "$NAMESPACE" --arg name "$probe_name" \
    --arg operation_id "$RECOVERY_OPERATION_ID" \
    --arg lock_name "$RECOVERY_OPERATION_LOCK_NAME" \
    --arg lock_uid "$RECOVERY_OPERATION_LOCK_UID" \
    --arg token "$RECOVERY_OPERATION_TOKEN" \
    --arg image "$AUD065_PGSQL_PROBE_IMAGE" '
    .apiVersion == "v1" and .kind == "Pod" and
    .metadata.name == $name and .metadata.namespace == $namespace and
    (.metadata.uid | type == "string" and length > 0) and
    (.metadata.resourceVersion | type == "string" and length > 0) and
    (.metadata.deletionTimestamp // null) == null and
    (.metadata.finalizers // []) == [] and
    (.metadata.annotations // {}) == {} and
    (.metadata.labels // {}) == {
      app:"pgbouncer",
      "yenhubs.org/aud065-pgsql-probe":"true",
      "yenhubs.org/operation-id":$operation_id
    } and
    (.metadata.ownerReferences // []) == [{
      apiVersion:"v1",kind:"ConfigMap",name:$lock_name,uid:$lock_uid,
      controller:false,blockOwnerDeletion:false
    }] and
    ((.spec | keys) - [
      "automountServiceAccountToken","containers",
      "dnsPolicy","enableServiceLinks","nodeName","preemptionPolicy",
      "priority","priorityClassName","restartPolicy","schedulerName",
      "securityContext","serviceAccount","serviceAccountName",
      "terminationGracePeriodSeconds","tolerations"
    ] | length) == 0 and
    .spec.automountServiceAccountToken == false and
    .spec.enableServiceLinks == false and .spec.restartPolicy == "Never" and
    (.spec.activeDeadlineSeconds // null) == null and
    .spec.terminationGracePeriodSeconds == 5 and
    .spec.dnsPolicy == "ClusterFirst" and .spec.schedulerName == "default-scheduler" and
    .spec.serviceAccountName == "default" and
    ((.spec.hostNetwork // false) == false) and ((.spec.hostPID // false) == false) and
    ((.spec.hostIPC // false) == false) and ((.spec.shareProcessNamespace // false) == false) and
    ((.spec.volumes // []) == []) and ((.spec.initContainers // []) == []) and
    ((.spec.ephemeralContainers // []) == []) and
    .spec.securityContext == {
      runAsNonRoot:true,runAsUser:999,runAsGroup:999,fsGroup:999,
      seccompProfile:{type:"RuntimeDefault"}
    } and
    (.spec.containers | length) == 1 and .spec.containers[0] as $container |
    $container.name == "probe" and $container.image == $image and
    $container.imagePullPolicy == "IfNotPresent" and
    $container.command == ["sh","-ec","trap \"exit 0\" TERM INT; while :; do sleep 30 & wait $!; done"] and
    (($container.args // []) == []) and (($container.env // []) == []) and
    (($container.envFrom // []) == []) and (($container.ports // []) == []) and
    (($container.volumeMounts // []) == []) and (($container.volumeDevices // []) == []) and
    (($container.lifecycle // {}) == {}) and
    (($container.stdin // false) == false) and (($container.stdinOnce // false) == false) and
    (($container.tty // false) == false) and
    $container.resources == {requests:{cpu:"1m",memory:"8Mi"},limits:{memory:"32Mi"}} and
    $container.readinessProbe == {
      exec:{command:["sh","-c","exit 1"]},initialDelaySeconds:0,
      periodSeconds:2,timeoutSeconds:1,successThreshold:1,failureThreshold:1
    } and
    (($container.livenessProbe // null) == null) and (($container.startupProbe // null) == null) and
    $container.securityContext == {
      runAsNonRoot:true,runAsUser:999,runAsGroup:999,
      allowPrivilegeEscalation:false,readOnlyRootFilesystem:true,
      capabilities:{drop:["ALL"]},seccompProfile:{type:"RuntimeDefault"}
    } and
    $container.terminationMessagePath == "/dev/termination-log" and
    $container.terminationMessagePolicy == "File" and
    ((.spec | tostring | contains($token)) | not)
  ' >/dev/null 2>&1 <<<"$pod_json"
}

aud065_pgsql_probe_inventory() {
  local pods_json
  # List the namespace rather than relying on the expected label. This catches
  # same-name or probe-label drift instead of mistaking it for absence.
  pods_json="$(recovery_kubectl get pod -n "$NAMESPACE" -o json)" || return 1
  jq -c --arg name "$(aud065_pgsql_probe_name)" '
    select(.apiVersion == "v1" and .kind == "PodList" and (.items | type == "array")) |
    [.items[] | select(.metadata.name == $name or
      .metadata.labels["yenhubs.org/aud065-pgsql-probe"] == "true")]
  ' <<<"$pods_json"
}

aud065_pgsql_probe_create() {
  local inventory count pod_json manifest created uid live_policy_rv
  aud065_pgsql_require_guard || return 1
  aud065_pgsql_probe_image_matches_pgsql || return 1
  inventory="$(aud065_pgsql_probe_inventory)" || return 1
  count="$(jq -er 'length' <<<"$inventory")" || return 1
  if [[ "$count" == 1 ]]; then
    pod_json="$(jq -cer '.[0]' <<<"$inventory")" || return 1
    aud065_pgsql_probe_json_is_exact "$pod_json" || return 1
    uid="$(jq -er '.metadata.uid' <<<"$pod_json")" || return 1
    if [[ -n "$AUD065_PGSQL_PROBE_UID" && "$uid" != "$AUD065_PGSQL_PROBE_UID" ]]; then
      return 1
    fi
    AUD065_PGSQL_PROBE_UID="$uid"
    export AUD065_PGSQL_PROBE_UID
    return 0
  fi
  [[ "$count" == 0 ]] || return 1
  # A new probe is created only while the existing policy is provably normal.
  [[ "$AUD065_PGSQL_BARRIER_STATE" == normal &&
     -n "$AUD065_PGSQL_POLICY_RESOURCE_VERSION" ]] || return 1
  [[ "$(aud065_pgsql_barrier_read_state)" == normal ]] || return 1
  # Re-fetch through the guarded API and retain the captured RV precondition;
  # the apparently redundant comparison is what rejects a same-spec ABA.
  live_policy_rv="$(recovery_kubectl get networkpolicy "$AUD065_PGSQL_POLICY_NAME" \
    -n "$NAMESPACE" -o json | jq -er '.metadata.resourceVersion')" || return 1
  [[ "$live_policy_rv" == "$AUD065_PGSQL_POLICY_RESOURCE_VERSION" ]] || return 1
  manifest="$(aud065_pgsql_probe_manifest_json)" || return 1
  created="$(printf '%s\n' "$manifest" |
    recovery_kubectl_mutate create -f - -o json)" || return 1
  AUD065_PGSQL_PROBE_UID="$(jq -er '.metadata.uid' <<<"$created")" || return 1
  export AUD065_PGSQL_PROBE_UID
  aud065_pgsql_probe_json_is_exact "$created" || return 1
  inventory="$(aud065_pgsql_probe_inventory)" || return 1
  [[ "$(jq -er 'length' <<<"$inventory")" == 1 ]] || return 1
  pod_json="$(jq -cer '.[0]' <<<"$inventory")" || return 1
  aud065_pgsql_probe_json_is_exact "$pod_json" || return 1
  [[ "$(jq -er '.metadata.uid' <<<"$pod_json")" == "$AUD065_PGSQL_PROBE_UID" ]]
}

aud065_pgsql_probe_runtime_is_nonready_and_unroutable() {
  local pod_json="$1" endpoints_json="$2" slices_json="$3" pod_uid pod_name pod_ip
  aud065_pgsql_probe_json_is_exact "$pod_json" || return 1
  pod_uid="$(jq -er '.metadata.uid' <<<"$pod_json")" || return 1
  pod_name="$(jq -er '.metadata.name' <<<"$pod_json")" || return 1
  pod_ip="$(jq -r '.status.podIP // ""' <<<"$pod_json")" || return 1
  jq -e '
    .status.phase == "Running" and
    ([.status.conditions[]? | select(.type == "Ready" and .status == "True")] | length) == 0 and
    ([.status.containerStatuses[]? | select(.name == "probe")] | length) == 1 and
    all(.status.containerStatuses[]? | select(.name == "probe"); .ready == false)
  ' >/dev/null 2>&1 <<<"$pod_json" || return 1
  jq -e --arg uid "$pod_uid" --arg name "$pod_name" --arg ip "$pod_ip" '
    .apiVersion == "v1" and .kind == "EndpointsList" and (.items | type == "array") and
    ([.items[].subsets[]?.addresses[]? |
      select((.targetRef.uid // "") == $uid or (.targetRef.name // "") == $name or
        ($ip != "" and .ip == $ip))] | length) == 0
  ' >/dev/null 2>&1 <<<"$endpoints_json" || return 1
  jq -e --arg uid "$pod_uid" --arg name "$pod_name" --arg ip "$pod_ip" '
    .apiVersion == "discovery.k8s.io/v1" and .kind == "EndpointSliceList" and
    (.items | type == "array") and
    ([.items[].endpoints[]? |
      select((.targetRef.uid // "") == $uid or (.targetRef.name // "") == $name or
        ($ip != "" and ((.addresses // []) | index($ip)) != null)) |
      select((if (.conditions | has("ready")) then .conditions.ready else true end) != false)] | length) == 0
  ' >/dev/null 2>&1 <<<"$slices_json"
}

aud065_require_pgsql_probe_nonready_and_unroutable() {
  local inventory pod_json endpoints_json slices_json uid
  aud065_pgsql_require_guard || return 1
  inventory="$(aud065_pgsql_probe_inventory)" || return 1
  [[ "$(jq -er 'length' <<<"$inventory")" == 1 ]] || return 1
  pod_json="$(jq -cer '.[0]' <<<"$inventory")" || return 1
  uid="$(jq -er '.metadata.uid' <<<"$pod_json")" || return 1
  [[ -z "$AUD065_PGSQL_PROBE_UID" || "$uid" == "$AUD065_PGSQL_PROBE_UID" ]] || return 1
  AUD065_PGSQL_PROBE_UID="$uid"
  export AUD065_PGSQL_PROBE_UID
  endpoints_json="$(recovery_kubectl get endpoints -n "$NAMESPACE" -o json)" || return 1
  slices_json="$(recovery_kubectl get endpointslice -n "$NAMESPACE" -o json)" || return 1
  aud065_pgsql_probe_runtime_is_nonready_and_unroutable \
    "$pod_json" "$endpoints_json" "$slices_json"
}

aud065_pgsql_probe_cleanup() {
  local terminal_callback="$1" inventory pod_json uid phase
  aud065_pgsql_require_guard || return 1
  inventory="$(aud065_pgsql_probe_inventory)" || return 1
  if [[ "$(jq -er 'length' <<<"$inventory")" == 0 ]]; then
    AUD065_PGSQL_PROBE_UID=""
    export AUD065_PGSQL_PROBE_UID
    return 0
  fi
  [[ "$(jq -er 'length' <<<"$inventory")" == 1 ]] || return 1
  pod_json="$(jq -cer '.[0]' <<<"$inventory")" || return 1
  aud065_pgsql_probe_json_is_exact "$pod_json" || return 1
  uid="$(jq -er '.metadata.uid' <<<"$pod_json")" || return 1
  [[ -z "$AUD065_PGSQL_PROBE_UID" || "$uid" == "$AUD065_PGSQL_PROBE_UID" ]] || return 1
  AUD065_PGSQL_PROBE_UID="$uid"
  phase="$(jq -r '.status.phase // ""' <<<"$pod_json")" || return 1
  if [[ ! "$phase" =~ ^(Succeeded|Failed)$ ]]; then
    aud065_pgsql_run_strict_callback "$terminal_callback" terminal || return 1
    inventory="$(aud065_pgsql_probe_inventory)" || return 1
    [[ "$(jq -er 'length' <<<"$inventory")" == 1 ]] || return 1
    pod_json="$(jq -cer '.[0]' <<<"$inventory")" || return 1
    aud065_pgsql_probe_json_is_exact "$pod_json" || return 1
    [[ "$(jq -er '.metadata.uid' <<<"$pod_json")" == "$uid" ]] || return 1
    phase="$(jq -r '.status.phase // ""' <<<"$pod_json")" || return 1
  fi
  [[ "$phase" =~ ^(Succeeded|Failed)$ ]] || return 1
  recovery_delete_namespaced_with_uid pod "$(aud065_pgsql_probe_name)" "$uid" 60 || return 1
  inventory="$(aud065_pgsql_probe_inventory)" || return 1
  [[ "$(jq -er 'length' <<<"$inventory")" == 0 ]] || return 1
  AUD065_PGSQL_PROBE_UID=""
  export AUD065_PGSQL_PROBE_UID
}

# Release gate used by recovery_release_operation_lock. The function is
# intentionally read-only and fail-closed: an AUD-065 lock may disappear only
# after the original policy is clean/normal and the operation probe is absent.
aud065_require_pgsql_barrier_released() {
  local policy_json inventory
  aud065_pgsql_require_guard || return 1
  [[ "${RECOVERY_OPERATION_STATE:-}" == cleanup-authorized &&
     "${AUD065_PGSQL_CLEANUP_AUTHORIZED:-0}" == 1 ]] || return 1
  aud065_pgsql_require_single_policy || return 1
  policy_json="$(recovery_kubectl get networkpolicy "$AUD065_PGSQL_POLICY_NAME" \
    -n "$NAMESPACE" -o json)" || return 1
  aud065_pgsql_policy_json_is_exact "$policy_json" normal || return 1
  inventory="$(aud065_pgsql_probe_inventory)" || return 1
  [[ "$(jq -er 'length' <<<"$inventory")" == 0 ]]
}

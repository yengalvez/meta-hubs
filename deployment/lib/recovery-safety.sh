#!/usr/bin/env bash

# Shared fail-closed guards for backup and restore commands. Callers must set
# NAMESPACE before invoking recovery_require_cluster_identity.

recovery_kubectl() {
  command kubectl --context "$EXPECTED_KUBE_CONTEXT" "$@"
}

recovery_require_cluster_identity() {
  local current_context live_namespace_uid

  if [[ -z "${EXPECTED_KUBE_CONTEXT:-}" ]]; then
    printf 'EXPECTED_KUBE_CONTEXT is required; refusing an implicit kubectl context.\n' >&2
    return 1
  fi
  if [[ -z "${EXPECTED_NAMESPACE_UID:-}" ]]; then
    printf 'EXPECTED_NAMESPACE_UID is required; pin the target namespace identity.\n' >&2
    return 1
  fi

  current_context="$(command kubectl config current-context 2>/dev/null)" || {
    printf 'Could not read the current kubectl context.\n' >&2
    return 1
  }
  if [[ "$current_context" != "$EXPECTED_KUBE_CONTEXT" ]]; then
    printf 'kubectl context mismatch: expected=%s current=%s.\n' \
      "$EXPECTED_KUBE_CONTEXT" "$current_context" >&2
    return 1
  fi

  live_namespace_uid="$(
    recovery_kubectl get namespace "$NAMESPACE" -o jsonpath='{.metadata.uid}'
  )" || {
    printf 'Could not read namespace %s in context %s.\n' \
      "$NAMESPACE" "$EXPECTED_KUBE_CONTEXT" >&2
    return 1
  }
  if [[ -z "$live_namespace_uid" || "$live_namespace_uid" != "$EXPECTED_NAMESPACE_UID" ]]; then
    printf 'Namespace UID mismatch: namespace=%s expected=%s current=%s.\n' \
      "$NAMESPACE" "$EXPECTED_NAMESPACE_UID" "${live_namespace_uid:-missing}" >&2
    return 1
  fi

  RECOVERY_NAMESPACE_UID="$live_namespace_uid"
  export RECOVERY_NAMESPACE_UID
}

recovery_confirmation_value() {
  local resource="$1"
  printf '%s:%s:%s:%s' \
    "$resource" "$EXPECTED_KUBE_CONTEXT" "$NAMESPACE" "$RECOVERY_NAMESPACE_UID"
}

recovery_require_confirmation() {
  local variable_name="$1"
  local resource="$2"
  local expected_value actual_value

  expected_value="$(recovery_confirmation_value "$resource")"
  actual_value="${!variable_name:-}"
  if [[ "$actual_value" != "$expected_value" ]]; then
    printf 'Refusing destructive restore. Set %s=%q for this exact target.\n' \
      "$variable_name" "$expected_value" >&2
    return 1
  fi
}

recovery_wait_for_no_pods() {
  local selector="$1"
  local description="$2"
  local timeout="${3:-180s}"
  local remaining

  remaining="$(
    recovery_kubectl get pod -n "$NAMESPACE" -l "$selector" -o name
  )" || {
    printf 'Could not inspect %s pods before waiting; refusing further mutation.\n' \
      "$description" >&2
    return 1
  }
  if [[ -z "$remaining" ]]; then
    return 0
  fi

  if ! recovery_kubectl wait --for=delete pod -n "$NAMESPACE" \
    -l "$selector" --timeout="$timeout" >/dev/null; then
    printf 'Timed out waiting for %s pods to stop; refusing further mutation.\n' \
      "$description" >&2
    return 1
  fi

  remaining="$(
    recovery_kubectl get pod -n "$NAMESPACE" -l "$selector" -o name
  )" || {
    printf 'Could not verify that %s pods stopped; refusing further mutation.\n' \
      "$description" >&2
    return 1
  }
  if [[ -n "$remaining" ]]; then
    printf 'Pods still remain for %s; refusing further mutation:\n%s\n' \
      "$description" "$remaining" >&2
    return 1
  fi
}

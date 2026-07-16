#!/usr/bin/env bash

# Captures the non-secret state required to reproduce or retire a YenHubs
# instance. Run this before a risky rollout or before deleting infrastructure.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf 'Usage: %s /path/to/checkpoint-directory\n' "$0" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="$1"
NAMESPACE="${NAMESPACE:-hcce}"
CLUSTER_NAME="${CLUSTER_NAME:-hubs-ce}"
DOCTL_CONTEXT="${DOCTL_CONTEXT:-yenhubs}"
VALUES_FILE="${VALUES_FILE:-$SCRIPT_DIR/input-values.local.yaml}"

for command_name in git kubectl doctl jq shasum; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$command_name" >&2
    exit 1
  fi
done

mkdir -p "$OUTPUT_DIR"
chmod 700 "$OUTPUT_DIR"

for output_file in \
  git-state.txt deployment-images.txt k8s-hcce-core.yaml \
  digitalocean-cluster.json digitalocean-load-balancers.json \
  digitalocean-volumes.json configured-value-keys.txt; do
  if [[ -e "$OUTPUT_DIR/$output_file" ]]; then
    printf 'Refusing to overwrite state artifact: %s\n' "$OUTPUT_DIR/$output_file" >&2
    exit 1
  fi
done

{
  printf 'captured_at_utc=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf 'root_branch=%s\n' "$(git -C "$ROOT_DIR" branch --show-current)"
  printf 'root_commit=%s\n' "$(git -C "$ROOT_DIR" rev-parse HEAD)"
  printf 'hubs_branch=%s\n' "$(git -C "$ROOT_DIR/hubs" branch --show-current)"
  printf 'hubs_commit=%s\n' "$(git -C "$ROOT_DIR/hubs" rev-parse HEAD)"
  printf 'hubs_cloud_branch=%s\n' "$(git -C "$ROOT_DIR/hubs-cloud" branch --show-current)"
  printf 'hubs_cloud_commit=%s\n' "$(git -C "$ROOT_DIR/hubs-cloud" rev-parse HEAD)"
  printf 'submodules=%q\n' "$(git -C "$ROOT_DIR" submodule status | tr '\n' ';')"
} >"$OUTPUT_DIR/git-state.txt"

kubectl get deployment -n "$NAMESPACE" -o json |
  jq -r '
    .items[]
    | .metadata.name as $deployment
    | .spec.template.spec.containers[]
    | [$deployment, .name, .image]
    | @tsv
  ' | sort >"$OUTPUT_DIR/deployment-images.txt"

kubectl get \
  deployment,service,configmap,ingress,certificate,pvc,networkpolicy,serviceaccount,role,rolebinding \
  -n "$NAMESPACE" -o yaml >"$OUTPUT_DIR/k8s-hcce-core.yaml"

doctl kubernetes cluster get "$CLUSTER_NAME" --context "$DOCTL_CONTEXT" --output json \
  >"$OUTPUT_DIR/digitalocean-cluster.json"
doctl compute load-balancer list --context "$DOCTL_CONTEXT" --output json \
  >"$OUTPUT_DIR/digitalocean-load-balancers.json"
doctl compute volume list --context "$DOCTL_CONTEXT" --output json \
  >"$OUTPUT_DIR/digitalocean-volumes.json"

if [[ -f "$VALUES_FILE" ]]; then
  awk '
    /^[A-Za-z_][A-Za-z0-9_]*:[[:space:]]*/ {
      key = $0
      sub(/:.*/, "", key)
      value = $0
      sub(/^[^:]*:[[:space:]]*/, "", value)
      sub(/[[:space:]]+#.*$/, "", value)
      gsub(/^[[:space:]\047"]+|[[:space:]\047"]+$/, "", value)
      printf "%s=%s\n", key, (value == "" ? "missing" : "configured")
    }
  ' "$VALUES_FILE" >"$OUTPUT_DIR/configured-value-keys.txt"
else
  printf 'values_file=missing\n' >"$OUTPUT_DIR/configured-value-keys.txt"
fi

chmod 600 "$OUTPUT_DIR"/*
printf 'Instance state captured without secret values: %s\n' "$OUTPUT_DIR"

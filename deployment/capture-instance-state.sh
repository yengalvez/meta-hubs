#!/usr/bin/env bash

# Captures the non-secret state required to reproduce or retire a YenHubs
# instance. Run this before a risky rollout or before deleting infrastructure.

set -euo pipefail
umask 077

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
VALUES_SOURCE_FILE="${VALUES_FILE:-$SCRIPT_DIR/input-values.local.yaml}"
VALUES_FILE=""
# shellcheck source=deployment/lib/recovery-safety.sh
source "$SCRIPT_DIR/lib/recovery-safety.sh"
# shellcheck source=deployment/lib/reactivation-gate-functions.sh
source "$SCRIPT_DIR/lib/reactivation-gate-functions.sh"
reactivation_install_cleanup_traps

for command_name in git kubectl doctl jq node; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$command_name" >&2
    exit 1
  fi
done

recovery_require_cluster_identity

if [[ ! -f "$VALUES_SOURCE_FILE" || -L "$VALUES_SOURCE_FILE" ]] ||
   ! reactivation_values_file_is_private "$VALUES_SOURCE_FILE" ||
   ! reactivation_snapshot_private_file VALUES_FILE "$VALUES_SOURCE_FILE" ||
   ! node "$SCRIPT_DIR/parse-local-values.mjs" "$VALUES_FILE" --validate; then
  printf 'A private valid local-values snapshot is required for image provenance.\n' >&2
  exit 1
fi

yaml_value() {
  node "$SCRIPT_DIR/parse-local-values.mjs" "$VALUES_FILE" --get "$1"
}
HUBS_IMAGE="$(yaml_value OVERRIDE_HUBS_IMAGE)"
RETICULUM_IMAGE="$(yaml_value OVERRIDE_RETICULUM_IMAGE)"
BOT_IMAGE="$(yaml_value OVERRIDE_BOT_ORCHESTRATOR_IMAGE)"
if ! reactivation_image_override_is_exact hubs "$HUBS_IMAGE" ||
   ! reactivation_image_override_is_exact reticulum "$RETICULUM_IMAGE" ||
   ! reactivation_image_override_is_exact bot-orchestrator "$BOT_IMAGE"; then
  printf 'Core image overrides do not have the exact trusted repositories and digests.\n' >&2
  exit 1
fi
EXPECTED_IMAGES_JSON="$(jq -cn \
  --arg bot "$BOT_IMAGE" \
  --arg coturn "$(yaml_value OVERRIDE_COTURN_IMAGE)" \
  --arg dialog "$(yaml_value OVERRIDE_DIALOG_IMAGE)" \
  --arg haproxy "$(yaml_value OVERRIDE_HAPROXY_IMAGE)" \
  --arg hubs "$HUBS_IMAGE" \
  --arg nearspark "$(yaml_value OVERRIDE_NEARSPARK_IMAGE)" \
  --arg pgbouncer "$(yaml_value OVERRIDE_PGBOUNCER_IMAGE)" \
  --arg photomnemonic "$(yaml_value OVERRIDE_PHOTOMNEMONIC_IMAGE)" \
  --arg postgres "$(yaml_value OVERRIDE_POSTGRES_IMAGE)" \
  --arg postgrest "$(yaml_value OVERRIDE_POSTGREST_IMAGE)" \
  --arg reticulum "$RETICULUM_IMAGE" \
  --arg spoke "$(yaml_value OVERRIDE_SPOKE_IMAGE)" '
  {
    "bot-orchestrator/bot-orchestrator": $bot,
    "coturn/coturn": $coturn,
    "dialog/dialog": $dialog,
    "haproxy/haproxy": $haproxy,
    "hubs/hubs": $hubs,
    "nearspark/nearspark": $nearspark,
    "pgbouncer/pgbouncer": $pgbouncer,
    "pgbouncer-t/pgbouncer-t": $pgbouncer,
    "photomnemonic/photomnemonic": $photomnemonic,
    "pgsql/pgsql": $postgres,
    "reticulum/postgrest": $postgrest,
    "reticulum/reticulum": $reticulum,
    "spoke/spoke": $spoke
  }
')"
if ! reactivation_image_map_is_trusted "$EXPECTED_IMAGES_JSON"; then
  printf 'Every configured image must use its allowlisted repository and exact digest.\n' >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
chmod 700 "$OUTPUT_DIR"

for output_file in \
  git-state.txt deployment-images.json k8s-hcce-structure.json \
  k8s-configmaps-redacted.json \
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

deployments_json="$(recovery_kubectl get deployment -n "$NAMESPACE" -o json)"
printf '%s' "$deployments_json" | jq \
  --arg namespace "$NAMESPACE" \
  --arg namespace_uid "$RECOVERY_NAMESPACE_UID" '
  {
    schema_version: 2,
    namespace: $namespace,
    namespace_uid: $namespace_uid,
    deployments: [
      .items[] | {
        name: .metadata.name,
        uid: .metadata.uid,
        replicas: (.spec.replicas // 0),
        init_containers: [(.spec.template.spec.initContainers // [])[] | {
          name: .name,
          image: .image
        }] | sort_by(.name),
        containers: [.spec.template.spec.containers[] | {
          name: .name,
          image: .image
        }] | sort_by(.name)
      }
    ] | sort_by(.name)
  }' >"$OUTPUT_DIR/deployment-images.json"
recovery_deployment_inventory_is_acceptable \
  "$OUTPUT_DIR/deployment-images.json" "$NAMESPACE" "$RECOVERY_NAMESPACE_UID" \
  "$EXPECTED_IMAGES_JSON" || {
  printf 'Deployment inventory does not match the exact YenHubs workload contract.\n' >&2
  exit 1
}

resources_json="$(
  recovery_kubectl get \
    deployment,service,ingress,certificate,pvc,networkpolicy,serviceaccount,role,rolebinding \
    -n "$NAMESPACE" -o json
)"
printf '%s' "$resources_json" | jq \
  --arg namespace "$NAMESPACE" \
  --arg namespace_uid "$RECOVERY_NAMESPACE_UID" '
  {
    schema_version: 1,
    namespace: $namespace,
    namespace_uid: $namespace_uid,
    resources: [.items[] | {
      api_version: .apiVersion,
      kind: .kind,
      name: .metadata.name,
      uid: .metadata.uid
    }] | sort_by(.kind, .name)
  }' >"$OUTPUT_DIR/k8s-hcce-structure.json"

recovery_kubectl get configmap -n "$NAMESPACE" -o json |
  jq '{
    apiVersion: "yenhubs.org/v1",
    kind: "RedactedConfigMapInventory",
    items: [.items[] | {
      name: .metadata.name,
      namespace: .metadata.namespace,
      uid: .metadata.uid,
      data_keys: ((.data // {}) | keys | sort),
      binary_data_keys: ((.binaryData // {}) | keys | sort)
    }]
  }' >"$OUTPUT_DIR/k8s-configmaps-redacted.json"

doctl kubernetes cluster get "$CLUSTER_NAME" --context "$DOCTL_CONTEXT" --output json \
  >"$OUTPUT_DIR/digitalocean-cluster.json"
doctl compute load-balancer list --context "$DOCTL_CONTEXT" --output json \
  >"$OUTPUT_DIR/digitalocean-load-balancers.json"
doctl compute volume list --context "$DOCTL_CONTEXT" --output json \
  >"$OUTPUT_DIR/digitalocean-volumes.json"

node "$SCRIPT_DIR/parse-local-values.mjs" "$VALUES_FILE" --keys \
  >"$OUTPUT_DIR/configured-value-keys.txt"

chmod 600 "$OUTPUT_DIR"/*
printf 'Instance state captured without secret values: %s\n' "$OUTPUT_DIR"

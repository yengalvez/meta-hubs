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
reactivation_install_cleanup_traps ""

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

capture_namespaced_resource_identity() {
  local resource="$1" expected_api_version="$2" expected_kind="$3"
  local resource_namespace="$4" expected_name="$5"
  local identity api_version kind namespace name uid extra
  identity="$(recovery_kubectl get "$resource" "$expected_name" \
    -n "$resource_namespace" \
    -o 'jsonpath={.apiVersion}{"\t"}{.kind}{"\t"}{.metadata.namespace}{"\t"}{.metadata.name}{"\t"}{.metadata.uid}')" || return 1
  IFS=$'\t' read -r api_version kind namespace name uid extra <<<"$identity"
  [[ -z "${extra:-}" && "$api_version" == "$expected_api_version" &&
     "$kind" == "$expected_kind" && "$namespace" == "$resource_namespace" &&
     "$name" == "$expected_name" && -n "$uid" ]] || return 1
  jq -cn --arg api_version "$api_version" --arg kind "$kind" \
    --arg namespace "$namespace" --arg name "$name" --arg uid "$uid" \
    '{api_version:$api_version,kind:$kind,namespace:$namespace,name:$name,uid:$uid}'
}

capture_cluster_resource_identity() {
  local resource="$1" expected_api_version="$2" expected_kind="$3" expected_name="$4"
  local identity api_version kind name uid extra
  identity="$(recovery_kubectl get "$resource" "$expected_name" \
    -o 'jsonpath={.apiVersion}{"\t"}{.kind}{"\t"}{.metadata.name}{"\t"}{.metadata.uid}')" || return 1
  IFS=$'\t' read -r api_version kind name uid extra <<<"$identity"
  [[ -z "${extra:-}" && "$api_version" == "$expected_api_version" &&
     "$kind" == "$expected_kind" && "$name" == "$expected_name" && -n "$uid" ]] || return 1
  jq -cn --arg api_version "$api_version" --arg kind "$kind" \
    --arg name "$name" --arg uid "$uid" \
    '{api_version:$api_version,kind:$kind,name:$name,uid:$uid}'
}
HUBS_IMAGE="$(yaml_value OVERRIDE_HUBS_IMAGE)"
RETICULUM_IMAGE="$(yaml_value OVERRIDE_RETICULUM_IMAGE)"
BOT_IMAGE="$(yaml_value OVERRIDE_BOT_ORCHESTRATOR_IMAGE)"
BOT_RUNNER_IMAGE="$(yaml_value OVERRIDE_BOT_RUNNER_IMAGE)"
if ! reactivation_image_override_is_exact hubs "$HUBS_IMAGE" ||
   ! reactivation_image_override_is_exact reticulum "$RETICULUM_IMAGE" ||
   ! reactivation_image_override_is_exact bot-orchestrator "$BOT_IMAGE"; then
  printf 'Deployed core image overrides do not have the exact trusted repositories and digests.\n' >&2
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
live_recovery_epochs="$(printf '%s' "$deployments_json" | jq -cer '
  def epoch($name):
    [.items[] | select(.metadata.name == $name) |
      (.spec.template.metadata.annotations // {})[
        "yenhubs.org/bot-runner-recovery-epoch"
      ]]
    | select(length == 1) | .[0];
  {reticulum:epoch("reticulum"),bot_orchestrator:epoch("bot-orchestrator")}
')" || {
  printf 'Could not inspect the live bot-runner recovery epoch bindings.\n' >&2
  exit 1
}
if jq -e '.reticulum == null and .bot_orchestrator == null' \
  <<<"$live_recovery_epochs" >/dev/null; then
  bot_runner_recovery_epoch='{"state":"legacy-absent"}'
else
  candidate_recovery_epoch="$(yaml_value BOT_RUNNER_RECOVERY_EPOCH)"
  if ! jq -e --arg epoch "$candidate_recovery_epoch" '
    def valid_epoch:
      type == "string" and
      test("^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$");
    (.reticulum | valid_epoch) and .reticulum == $epoch and
    .bot_orchestrator == $epoch
  ' <<<"$live_recovery_epochs" >/dev/null; then
    printf 'The candidate recovery epoch is not bound to both live parent templates.\n' >&2
    exit 1
  fi
  bot_runner_recovery_epoch="$(jq -cn --arg value "$candidate_recovery_epoch" \
    '{state:"bound",value:$value}')"
fi
runtime_bot_runner_images="$(jq -c '
  [.items[] | select(.metadata.name == "bot-orchestrator") |
    .spec.template.spec.containers[] | select(.name == "bot-orchestrator") |
    (.env // [])[] | select(.name == "BOT_RUNNER_IMAGE") | .value]
' <<<"$deployments_json")" || {
  printf 'Could not inspect the runner image binding.\n' >&2
  exit 1
}
runtime_bot_runner_count="$(jq -r 'length' <<<"$runtime_bot_runner_images")"
if [[ "$runtime_bot_runner_count" == "0" ]]; then
  runtime_kubernetes_binding_count="$(jq -r '
    [.items[] | select(.metadata.name == "bot-orchestrator") |
      (.spec.template.spec.serviceAccountName == "bot-orchestrator"),
      (.spec.template.spec.automountServiceAccountToken == true),
      ((.spec.template.spec.containers[] | select(.name == "bot-orchestrator") |
        (.env // [])[] | .name) as $name |
        $name == "POD_NAMESPACE" or
        $name == "ORCHESTRATOR_POD_NAME" or
        $name == "ORCHESTRATOR_POD_UID" or
        $name == "RUNNER_NAMESPACE" or
        $name == "RUNNER_POD_NAMESPACE" or
        $name == "RUNNER_CONTROL_URL")]
    | map(select(. == true))
    | length
  ' <<<"$deployments_json")" || {
    printf 'Could not inspect partial Kubernetes runner bindings.\n' >&2
    exit 1
  }
  if [[ "$runtime_kubernetes_binding_count" != "0" ]]; then
    printf 'Process-local bot runtime has partial Kubernetes runner bindings.\n' >&2
    exit 1
  fi
  if ! recovery_require_live_process_local_runner_exact "$VALUES_SOURCE_FILE"; then
    printf 'Process-local inventory capture requires the exact accepted legacy runtime boundary.\n' >&2
    exit 1
  fi
  bot_runner_runtime='{"mode":"process-local","image":null}'
  bot_runner_control_plane='{"state":"legacy-absent"}'
elif [[ "$runtime_bot_runner_count" == "1" ]]; then
  if ! jq -e '.state == "bound"' <<<"$bot_runner_recovery_epoch" >/dev/null; then
    printf 'The Kubernetes runner runtime requires a bound recovery epoch.\n' >&2
    exit 1
  fi
  runtime_bot_runner_image="$(jq -er '.[0]' <<<"$runtime_bot_runner_images")"
  if ! reactivation_image_override_is_exact bot-runner "$BOT_RUNNER_IMAGE" ||
     ! reactivation_image_override_is_exact bot-runner "$runtime_bot_runner_image" ||
     [[ "$runtime_bot_runner_image" != "$BOT_RUNNER_IMAGE" ]]; then
    printf 'Live bot-runner image does not match the private candidate override.\n' >&2
    exit 1
  fi
  bot_runner_runtime="$(jq -cn --arg image "$runtime_bot_runner_image" \
    '{mode:"kubernetes-pod",image:$image}')"
  runner_namespace="hcce-bot-runners"
  runner_namespaces="$(jq -cn --arg namespace "$NAMESPACE" \
    --arg namespace_uid "$RECOVERY_NAMESPACE_UID" '
    [{api_version:"v1",kind:"Namespace",name:$namespace,uid:$namespace_uid}]
  ')"
  runner_namespace_identity="$(capture_cluster_resource_identity \
    namespace v1 Namespace "$runner_namespace")" || {
    printf 'The dedicated runner Namespace identity is missing or invalid.\n' >&2
    exit 1
  }
  runner_namespaces="$(jq -cn --argjson current "$runner_namespaces" \
    --argjson item "$runner_namespace_identity" '$current + [$item] | sort_by(.name)')"
  runner_namespaced_resources='[]'
  while IFS=$'\t' read -r resource api_version kind name; do
    identity="$(capture_namespaced_resource_identity \
      "$resource" "$api_version" "$kind" "$runner_namespace" "$name")" || {
      printf 'A required redacted runner control-plane identity is missing or invalid.\n' >&2
      exit 1
    }
    runner_namespaced_resources="$(jq -cn \
      --argjson current "$runner_namespaced_resources" --argjson item "$identity" \
      '$current + [$item] | sort_by(.kind, .name)')"
  done <<'RUNNER_RESOURCES'
secret	v1	Secret	bot-images-pull
serviceaccount	v1	ServiceAccount	bot-runner
resourcequota	v1	ResourceQuota	bot-runner-capacity
role	rbac.authorization.k8s.io/v1	Role	bot-orchestrator-runner-pods
rolebinding	rbac.authorization.k8s.io/v1	RoleBinding	bot-orchestrator-runner-pods
networkpolicy	networking.k8s.io/v1	NetworkPolicy	bot-runner-default-deny
networkpolicy	networking.k8s.io/v1	NetworkPolicy	bot-runner-egress
RUNNER_RESOURCES
  runner_cluster_resources='[]'
  while IFS=$'\t' read -r resource api_version kind name; do
    identity="$(capture_cluster_resource_identity \
      "$resource" "$api_version" "$kind" "$name")" || {
      printf 'A required runner admission-policy identity is missing or invalid.\n' >&2
      exit 1
    }
    runner_cluster_resources="$(jq -cn \
      --argjson current "$runner_cluster_resources" --argjson item "$identity" \
      '$current + [$item] | sort_by(.kind, .name)')"
  done <<'RUNNER_CLUSTER_RESOURCES'
validatingadmissionpolicy	admissionregistration.k8s.io/v1	ValidatingAdmissionPolicy	bot-runner-pods.yenhubs.org
validatingadmissionpolicybinding	admissionregistration.k8s.io/v1	ValidatingAdmissionPolicyBinding	bot-runner-pods.yenhubs.org
RUNNER_CLUSTER_RESOURCES
  bot_runner_control_plane="$(jq -cn \
    --argjson namespaces "$runner_namespaces" \
    --argjson namespaced_resources "$runner_namespaced_resources" \
    --argjson cluster_resources "$runner_cluster_resources" '
    {
      state:"kubernetes-active",
      namespaces:$namespaces,
      namespaced_resources:$namespaced_resources,
      cluster_resources:$cluster_resources
    }
  ')"
else
  printf 'The bot-orchestrator has duplicate BOT_RUNNER_IMAGE bindings.\n' >&2
  exit 1
fi
bot_runner_runtime="$(jq -cn \
  --argjson runtime "$bot_runner_runtime" \
  --argjson control_plane "$bot_runner_control_plane" \
  --argjson recovery_epoch "$bot_runner_recovery_epoch" '
  $runtime + {
    control_plane:$control_plane,
    recovery_epoch:$recovery_epoch
  }
')"
printf '%s' "$deployments_json" | jq \
  --arg namespace "$NAMESPACE" \
  --arg namespace_uid "$RECOVERY_NAMESPACE_UID" \
  --argjson bot_runner_runtime "$bot_runner_runtime" '
  {
    schema_version: 3,
    namespace: $namespace,
    namespace_uid: $namespace_uid,
    bot_runner_runtime: $bot_runner_runtime,
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
  "$EXPECTED_IMAGES_JSON" "$BOT_RUNNER_IMAGE" || {
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

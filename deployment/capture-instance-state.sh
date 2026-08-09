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
CAPTURE_STATE_FORMAT="${CAPTURE_STATE_FORMAT:-legacy}"
VALUES_SOURCE_FILE="${VALUES_FILE:-$SCRIPT_DIR/input-values.local.yaml}"
VALUES_FILE=""
# shellcheck source=deployment/lib/recovery-safety.sh
source "$SCRIPT_DIR/lib/recovery-safety.sh"
# shellcheck source=deployment/lib/reactivation-gate-functions.sh
source "$SCRIPT_DIR/lib/reactivation-gate-functions.sh"
reactivation_install_cleanup_traps ""

case "$CAPTURE_STATE_FORMAT" in
  legacy | freeze-bundle-v1) ;;
  *)
    printf 'CAPTURE_STATE_FORMAT must be legacy or freeze-bundle-v1.\n' >&2
    exit 2
    ;;
esac

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
  local identity api_version kind namespace name uid resource_version extra
  identity="$(recovery_kubectl get "$resource" "$expected_name" \
    -n "$resource_namespace" \
    -o 'jsonpath={.apiVersion}{"\t"}{.kind}{"\t"}{.metadata.namespace}{"\t"}{.metadata.name}{"\t"}{.metadata.uid}{"\t"}{.metadata.resourceVersion}')" || return 1
  IFS=$'\t' read -r api_version kind namespace name uid resource_version extra <<<"$identity"
  [[ -z "${extra:-}" && "$api_version" == "$expected_api_version" &&
     "$kind" == "$expected_kind" && "$namespace" == "$resource_namespace" &&
     "$name" == "$expected_name" && -n "$uid" && -n "$resource_version" ]] || return 1
  jq -cn --arg api_version "$api_version" --arg kind "$kind" \
    --arg namespace "$namespace" --arg name "$name" --arg uid "$uid" \
    --arg resource_version "$resource_version" \
    '{api_version:$api_version,kind:$kind,namespace:$namespace,name:$name,
      uid:$uid,resource_version:$resource_version}'
}

capture_cluster_resource_identity() {
  local resource="$1" expected_api_version="$2" expected_kind="$3" expected_name="$4"
  local identity api_version kind name uid resource_version extra
  identity="$(recovery_kubectl get "$resource" "$expected_name" \
    -o 'jsonpath={.apiVersion}{"\t"}{.kind}{"\t"}{.metadata.name}{"\t"}{.metadata.uid}{"\t"}{.metadata.resourceVersion}')" || return 1
  IFS=$'\t' read -r api_version kind name uid resource_version extra <<<"$identity"
  [[ -z "${extra:-}" && "$api_version" == "$expected_api_version" &&
     "$kind" == "$expected_kind" && "$name" == "$expected_name" &&
     -n "$uid" && -n "$resource_version" ]] || return 1
  jq -cn --arg api_version "$api_version" --arg kind "$kind" \
    --arg name "$name" --arg uid "$uid" --arg resource_version "$resource_version" \
    '{api_version:$api_version,kind:$kind,name:$name,uid:$uid,
      resource_version:$resource_version}'
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
deployments_json="$(
  recovery_kubectl_get_namespaced_list deployments "$NAMESPACE"
)"
checkpoint_runner_mode="$(recovery_checkpoint_runner_mode_candidate)" || {
  printf 'Could not classify the live checkpoint runner boundary.\n' >&2
  exit 1
}
case "$checkpoint_runner_mode" in
  process-local) postgres_pair='pgsql/postgresql' ;;
  kubernetes-pod) postgres_pair='pgsql/pgsql' ;;
  *)
    printf 'The live checkpoint runner boundary has an invalid mode.\n' >&2
    exit 1
    ;;
esac
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
  --arg spoke "$(yaml_value OVERRIDE_SPOKE_IMAGE)" \
  --arg postgres_pair "$postgres_pair" '
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
    "reticulum/postgrest": $postgrest,
    "reticulum/reticulum": $reticulum,
    "spoke/spoke": $spoke
  } + {($postgres_pair):$postgres}
')"
# The deployment generator uses pgsql/pgsql after AUD-075. The accepted
# historical process-local boundary used the same trusted PostgreSQL image
# under pgsql/postgresql; normalize only this pair for repository validation.
TRUSTED_EXPECTED_IMAGES_JSON="$EXPECTED_IMAGES_JSON"
if [[ "$checkpoint_runner_mode" == process-local ]]; then
  TRUSTED_EXPECTED_IMAGES_JSON="$(jq -c '
    with_entries(if .key == "pgsql/postgresql"
      then .key = "pgsql/pgsql" else . end)
  ' <<<"$EXPECTED_IMAGES_JSON")"
fi
if ! reactivation_image_map_is_trusted "$TRUSTED_EXPECTED_IMAGES_JSON"; then
  printf 'Every configured image must use its allowlisted repository and exact digest.\n' >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
chmod 700 "$OUTPUT_DIR"

if [[ "$CAPTURE_STATE_FORMAT" == freeze-bundle-v1 ]]; then
  output_files=(git-state.json deployment-images.json \
    external-config-redacted.json infrastructure-recipe.json)
else
  output_files=(git-state.txt deployment-images.json k8s-hcce-structure.json \
    k8s-configmaps-redacted.json digitalocean-cluster.json \
    digitalocean-load-balancers.json digitalocean-volumes.json \
    configured-value-keys.txt runner-cutover-evidence.json)
fi
for output_file in "${output_files[@]}"; do
  if [[ -e "$OUTPUT_DIR/$output_file" ]]; then
    printf 'Refusing to overwrite state artifact: %s\n' "$OUTPUT_DIR/$output_file" >&2
    exit 1
  fi
done

captured_at_utc="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
root_commit="$(git -C "$ROOT_DIR" rev-parse HEAD)"
hubs_commit="$(git -C "$ROOT_DIR/hubs" rev-parse HEAD)"
hubs_cloud_commit="$(git -C "$ROOT_DIR/hubs-cloud" rev-parse HEAD)"
if [[ "$CAPTURE_STATE_FORMAT" == freeze-bundle-v1 ]]; then
  hubs_gitlink="$(git -C "$ROOT_DIR" ls-tree HEAD hubs | awk '{print $3}')"
  hubs_cloud_gitlink="$(git -C "$ROOT_DIR" ls-tree HEAD hubs-cloud | awk '{print $3}')"
  [[ "$root_commit" =~ ^[a-f0-9]{40}$ && "$hubs_commit" =~ ^[a-f0-9]{40}$ &&
     "$hubs_cloud_commit" =~ ^[a-f0-9]{40}$ &&
     "$hubs_gitlink" == "$hubs_commit" &&
     "$hubs_cloud_gitlink" == "$hubs_cloud_commit" ]] || {
    printf 'Freeze inventory requires exact initialized gitlinks and submodule commits.\n' >&2
    exit 1
  }
  jq -n --arg captured "$captured_at_utc" --arg root "$root_commit" \
    --arg hubs "$hubs_commit" --arg cloud "$hubs_cloud_commit" '{
      schema:"freeze-git-state-v1",captured_at_utc:$captured,
      repositories:{root:{commit:$root},hubs:{commit:$hubs},hubs_cloud:{commit:$cloud}},
      gitlinks:{hubs:$hubs,hubs_cloud:$cloud},
      accepted_releases:{hubs:"prod-2026-03-11",hubs_ce:"2.1.0"}
    }' >"$OUTPUT_DIR/git-state.json"
else
  {
    printf 'captured_at_utc=%s\n' "$captured_at_utc"
    printf 'root_branch=%s\n' "$(git -C "$ROOT_DIR" branch --show-current)"
    printf 'root_commit=%s\n' "$root_commit"
    printf 'hubs_branch=%s\n' "$(git -C "$ROOT_DIR/hubs" branch --show-current)"
    printf 'hubs_commit=%s\n' "$hubs_commit"
    printf 'hubs_cloud_branch=%s\n' "$(git -C "$ROOT_DIR/hubs-cloud" branch --show-current)"
    printf 'hubs_cloud_commit=%s\n' "$hubs_cloud_commit"
    printf 'submodules=%q\n' "$(git -C "$ROOT_DIR" submodule status | tr '\n' ';')"
  } >"$OUTPUT_DIR/git-state.txt"
fi

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
  if [[ "$checkpoint_runner_mode" != process-local ]]; then
    printf 'Process-local bot runtime has partial Kubernetes runner bindings.\n' >&2
    exit 1
  fi
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
  bot_runner_runtime='{"generation":"legacy-absent","mode":"process-local","image":null}'
  bot_runner_control_plane='{"state":"legacy-absent"}'
elif [[ "$runtime_bot_runner_count" == "1" ]]; then
  if [[ "$checkpoint_runner_mode" != kubernetes-pod ]]; then
    printf 'The process-local runtime cannot carry a Kubernetes runner image binding.\n' >&2
    exit 1
  fi
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
    '{generation:"durable-v2",mode:"kubernetes-pod",image:$image}')"
  runner_namespace="hcce-bot-runners"
  parent_namespace_identity="$(capture_cluster_resource_identity \
    namespace v1 Namespace "$NAMESPACE")" || {
    printf 'The parent Namespace identity is missing or invalid.\n' >&2
    exit 1
  }
  if [[ "$(jq -er '.uid' <<<"$parent_namespace_identity")" != \
        "$RECOVERY_NAMESPACE_UID" ]]; then
    printf 'The parent Namespace identity changed during capture.\n' >&2
    exit 1
  fi
  runner_namespaces="$(jq -cn --argjson item "$parent_namespace_identity" '[$item]')"
  runner_namespace_identity="$(capture_cluster_resource_identity \
    namespace v1 Namespace "$runner_namespace")" || {
    printf 'The dedicated runner Namespace identity is missing or invalid.\n' >&2
    exit 1
  }
  runner_namespaces="$(jq -cn --argjson current "$runner_namespaces" \
    --argjson item "$runner_namespace_identity" '$current + [$item] | sort_by(.name)')"
  runner_namespaced_resources='[]'
  while IFS=$'\t' read -r resource api_version kind resource_namespace name; do
    identity="$(capture_namespaced_resource_identity \
      "$resource" "$api_version" "$kind" "$resource_namespace" "$name")" || {
      printf 'A required redacted runner control-plane identity is missing or invalid.\n' >&2
      exit 1
    }
    runner_namespaced_resources="$(jq -cn \
      --argjson current "$runner_namespaced_resources" --argjson item "$identity" \
      '$current + [$item] | sort_by(.kind, .name)')"
  done <<RUNNER_RESOURCES
serviceaccount	v1	ServiceAccount	$NAMESPACE	bot-orchestrator
role	rbac.authorization.k8s.io/v1	Role	$NAMESPACE	bot-orchestrator-runner-pods
rolebinding	rbac.authorization.k8s.io/v1	RoleBinding	$NAMESPACE	bot-orchestrator-runner-pods
configmap	v1	ConfigMap	$NAMESPACE	yenhubs-runner-cutover-v2
secret	v1	Secret	hcce-bot-runners	bot-images-pull
serviceaccount	v1	ServiceAccount	hcce-bot-runners	bot-runner
serviceaccount	v1	ServiceAccount	hcce-bot-runners	bot-runner-guard
resourcequota	v1	ResourceQuota	hcce-bot-runners	bot-runner-capacity
resourcequota	v1	ResourceQuota	hcce-bot-runners	bot-runner-guard-capacity
role	rbac.authorization.k8s.io/v1	Role	hcce-bot-runners	bot-orchestrator-runner-pods
rolebinding	rbac.authorization.k8s.io/v1	RoleBinding	hcce-bot-runners	bot-orchestrator-runner-pods
networkpolicy	networking.k8s.io/v1	NetworkPolicy	hcce-bot-runners	bot-runner-default-deny
networkpolicy	networking.k8s.io/v1	NetworkPolicy	hcce-bot-runners	bot-runner-egress
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
validatingadmissionpolicy	admissionregistration.k8s.io/v1	ValidatingAdmissionPolicy	bot-runner-durable-protocol.yenhubs.org
validatingadmissionpolicybinding	admissionregistration.k8s.io/v1	ValidatingAdmissionPolicyBinding	bot-runner-durable-protocol.yenhubs.org
validatingadmissionpolicy	admissionregistration.k8s.io/v1	ValidatingAdmissionPolicy	yenhubs-runner-cutover-journal-v2
validatingadmissionpolicybinding	admissionregistration.k8s.io/v1	ValidatingAdmissionPolicyBinding	yenhubs-runner-cutover-journal-v2
validatingadmissionpolicy	admissionregistration.k8s.io/v1	ValidatingAdmissionPolicy	bot-orchestrator-fence-protocol.yenhubs.org
validatingadmissionpolicybinding	admissionregistration.k8s.io/v1	ValidatingAdmissionPolicyBinding	bot-orchestrator-fence-protocol.yenhubs.org
validatingadmissionpolicy	admissionregistration.k8s.io/v1	ValidatingAdmissionPolicy	recovery-operation-pod-fence.yenhubs.org
validatingadmissionpolicybinding	admissionregistration.k8s.io/v1	ValidatingAdmissionPolicyBinding	recovery-operation-pod-fence.yenhubs.org
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
    schema_version: 4,
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

if [[ "$CAPTURE_STATE_FORMAT" == freeze-bundle-v1 ]]; then
  for required_variable in \
    FREEZE_DNS_PROVIDER FREEZE_SMTP_PROVIDER FREEZE_ROOM_ID FREEZE_SCENE_ID \
    FREEZE_SPOKE_PROJECT_ID FREEZE_RESPONSIBLE_OWNER \
    FREEZE_COST_GATE_CHECKED_AT FREEZE_ESTIMATED_MONTHLY_USD; do
    required_value="${!required_variable:-}"
    if [[ -z "$required_value" || "$required_value" == *$'\n'* ||
          "$required_value" == *$'\r'* ]]; then
      printf '%s is required and must be one non-empty line for freeze capture.\n' \
        "$required_variable" >&2
      exit 1
    fi
  done
  [[ "$FREEZE_COST_GATE_CHECKED_AT" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || {
    printf 'FREEZE_COST_GATE_CHECKED_AT must be one UTC second timestamp.\n' >&2
    exit 1
  }
  jq -en --arg value "$FREEZE_ESTIMATED_MONTHLY_USD" \
    '$value | tonumber | select(. >= 0)' >/dev/null || {
    printf 'FREEZE_ESTIMATED_MONTHLY_USD must be a non-negative number.\n' >&2
    exit 1
  }
  hub_domain="$(yaml_value HUB_DOMAIN)"
  storage_class="$(yaml_value PERSISTENT_VOLUME_STORAGE_CLASS)"
  storage_size="$(yaml_value PERSISTENT_VOLUME_SIZE)"
  configured_keys_json="$(node "$SCRIPT_DIR/parse-local-values.mjs" \
    "$VALUES_FILE" --keys | jq -Rsc '
      split("\n") |
      map(select(endswith("=configured")) | split("=")[0]) | unique | sort
    ')"
  repositories_json="$(jq -c '
    [to_entries[].value | split("@sha256:")[0]] | unique | sort
  ' <<<"$EXPECTED_IMAGES_JSON")"
  [[ -n "$hub_domain" && -n "$storage_class" && -n "$storage_size" ]] || {
    printf 'Domain and persistent storage inputs are required for freeze capture.\n' >&2
    exit 1
  }
  jq -n --arg domain "$hub_domain" --arg dns_provider "$FREEZE_DNS_PROVIDER" \
    --arg smtp_provider "$FREEZE_SMTP_PROVIDER" \
    --arg room "$FREEZE_ROOM_ID" --arg scene "$FREEZE_SCENE_ID" \
    --arg spoke "$FREEZE_SPOKE_PROJECT_ID" \
    --arg owner "$FREEZE_RESPONSIBLE_OWNER" \
    --argjson keys "$configured_keys_json" --argjson repositories "$repositories_json" '
    def present($name): $keys | index($name) != null;
    {
      schema:"freeze-external-config-v1",
      dns:{domain:$domain,provider:$dns_provider,
        records:[$domain,("stream."+$domain),("assets."+$domain),("cors."+$domain)]},
      smtp:{provider:$smtp_provider,host_configured:present("SMTP_SERVER"),
        port_configured:present("SMTP_PORT"),user_configured:present("SMTP_USER"),
        password_configured:present("SMTP_PASS")},
      functional_ids:{room:$room,scene:$scene,spoke_project:$spoke},
      images:{repositories:$repositories},
      configured_presence:(reduce ["ADM_EMAIL","BOT_ACCESS_KEY","DB_PASS","DB_USER",
        "GUARDIAN_KEY","HUB_DOMAIN","NODE_COOKIE","OPENAI_API_KEY","PERMS_KEY",
        "PHX_KEY","SMTP_PASS","SMTP_PORT","SMTP_SERVER","SMTP_USER"][] as $name
        ({}; .[$name]=present($name))),
      responsibility:{dns:$owner,operations:$owner,registry:$owner,smtp:$owner}
    }
  ' >"$OUTPUT_DIR/external-config-redacted.json"

  cluster_raw="$(doctl kubernetes cluster get "$CLUSTER_NAME" \
    --context "$DOCTL_CONTEXT" --output json)"
  load_balancers_raw="$(doctl compute load-balancer list \
    --context "$DOCTL_CONTEXT" --output json)"
  volumes_raw="$(doctl compute volume list --context "$DOCTL_CONTEXT" --output json)"
  cluster_recipe="$(jq -ce --arg name "$CLUSTER_NAME" '
    (if type == "array" then select(length == 1) | .[0] else . end) |
    select(type == "object" and .name == $name and .ha == false) |
    select(.region | type == "string" and length > 0) |
    select(.node_pools | type == "array" and length > 0) |
    {name:.name,region:.region,ha_control_plane:.ha,
      node_pools:[.node_pools[] | {size:.size,count:.count}] | sort_by(.size)} |
    select(all(.node_pools[]; (.size | type == "string" and length > 0) and
      (.count | type == "number" and floor == . and . > 0)))
  ' <<<"$cluster_raw")" || {
    printf 'DigitalOcean cluster topology is not the exact low-cost source recipe.\n' >&2
    exit 1
  }
  jq -e 'type == "array" and length == 1' <<<"$load_balancers_raw" >/dev/null || {
    printf 'Freeze recipe requires exactly one source Load Balancer.\n' >&2
    exit 1
  }
  jq -e 'type == "array" and length >= 2' <<<"$volumes_raw" >/dev/null || {
    printf 'Freeze recipe requires the two source persistent volumes.\n' >&2
    exit 1
  }
  jq -n --argjson cluster "$cluster_recipe" --arg namespace "$NAMESPACE" \
    --arg storage_class "$storage_class" --arg storage_size "$storage_size" \
    --arg checked "$FREEZE_COST_GATE_CHECKED_AT" \
    --argjson cost "$FREEZE_ESTIMATED_MONTHLY_USD" '
    {
      schema:"freeze-infrastructure-recipe-v1",provider:"digitalocean",
      region:$cluster.region,
      cluster:{name:$cluster.name,ha_control_plane:$cluster.ha_control_plane,
        node_pools:$cluster.node_pools},
      storage:{class:$storage_class,persistent_volume_claims:[
        {name:"pgsql-pvc",size:$storage_size},{name:"ret-pvc",size:$storage_size}]},
      load_balancer:{count:1,type:"REGIONAL_NETWORK"},namespace:$namespace,
      ingress:"haproxytech-kubernetes-ingress-3.2",cert_manager:"cert-manager",
      topology:"single-region-low-cost",
      apply_order:["infrastructure","cert-manager","ingress",
        "generated-manifest","restore","live-verification"],
      cost_gate:{checked_at_utc:$checked,estimated_monthly_usd:$cost,
        result:"approval-required-before-create"}
    }
  ' >"$OUTPUT_DIR/infrastructure-recipe.json"
else
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
fi

chmod 600 "$OUTPUT_DIR"/*
printf 'Instance state captured without secret values: %s\n' "$OUTPUT_DIR"

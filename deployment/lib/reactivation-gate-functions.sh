#!/usr/bin/env bash

# Shared, side-effect-free helpers for the reactivation gates. Callers install
# the cleanup traps explicitly so sourcing this file never changes shell state.

REACTIVATION_TEMP_PATHS=()
REACTIVATION_EXTRA_CLEANUP=""

reactivation_register_temp_path() {
  local path="${1:-}"
  [[ -n "$path" ]] || return 2
  REACTIVATION_TEMP_PATHS+=("$path")
}

reactivation_cleanup_temp_paths() {
  local path
  if ((${#REACTIVATION_TEMP_PATHS[@]} > 0)); then
    for path in "${REACTIVATION_TEMP_PATHS[@]}"; do
      [[ -n "$path" ]] && rm -f -- "$path"
    done
  fi
  REACTIVATION_TEMP_PATHS=()
}

reactivation_run_cleanup() {
  local cleanup_function="${REACTIVATION_EXTRA_CLEANUP:-}"
  REACTIVATION_EXTRA_CLEANUP=""
  if [[ -n "$cleanup_function" ]]; then
    "$cleanup_function"
  fi
  reactivation_cleanup_temp_paths
}

reactivation_handle_signal() {
  local exit_code="$1"
  trap - EXIT INT TERM
  reactivation_run_cleanup
  exit "$exit_code"
}

reactivation_install_cleanup_traps() {
  REACTIVATION_EXTRA_CLEANUP="${1:-}"
  trap reactivation_run_cleanup EXIT
  trap 'reactivation_handle_signal 130' INT
  trap 'reactivation_handle_signal 143' TERM
}

reactivation_file_mode() {
  local path="$1"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    stat -f '%Lp' "$path"
  else
    stat -c '%a' "$path"
  fi
}

reactivation_values_file_is_private() {
  local path="$1"
  [[ "$(reactivation_file_mode "$path")" == "600" ]]
}

reactivation_snapshot_private_file() {
  local destination_variable="$1"
  local source_path="$2"
  local snapshot_path snapshot_dir helper_dir
  [[ -n "$destination_variable" && -f "$source_path" && ! -L "$source_path" ]] || return 1
  reactivation_values_file_is_private "$source_path" || return 1
  helper_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)" || return 1
  snapshot_dir="$(cd "${TMPDIR:-/tmp}" && pwd -P)" || return 1
  snapshot_path="$(mktemp "$snapshot_dir/yenhubs-values-snapshot.XXXXXX")" || return 1
  reactivation_register_temp_path "$snapshot_path"
  if ! node "$helper_dir/snapshot-private-file.mjs" "$source_path" "$snapshot_path"; then
    return 1
  fi
  chmod 600 "$snapshot_path"
  [[ "$(reactivation_file_mode "$snapshot_path")" == "600" ]] || return 1
  printf -v "$destination_variable" '%s' "$snapshot_path"
}

reactivation_live_result_is_clean() {
  local failures="$1"
  local warnings="$2"
  [[ "$failures" =~ ^[0-9]+$ && "$warnings" =~ ^[0-9]+$ ]] || return 2
  ((failures == 0 && warnings == 0))
}

reactivation_capture_output() {
  local destination="$1"
  shift
  local captured status
  if captured="$("$@")"; then
    printf -v "$destination" '%s' "$captured"
    return 0
  else
    status=$?
    printf -v "$destination" '%s' ""
    return "$status"
  fi
}

reactivation_checkpoint_age_is_acceptable() {
  local created_epoch="$1"
  local current_epoch="$2"
  local maximum_age="$3"
  [[ "$created_epoch" =~ ^[0-9]+$ && "$current_epoch" =~ ^[0-9]+$ &&
     "$maximum_age" =~ ^[0-9]+$ && "$maximum_age" -gt 0 ]] || return 2
  ((created_epoch <= current_epoch && current_epoch - created_epoch <= maximum_age))
}

reactivation_image_override_is_exact() {
  local component="$1"
  local image="$2"
  case "$component" in
    hubs)
      [[ "$image" =~ ^ghcr\.io/yengalvez/hubs@sha256:[a-fA-F0-9]{64}$ ]]
      ;;
    reticulum)
      [[ "$image" =~ ^ghcr\.io/yengalvez/reticulum@sha256:[a-fA-F0-9]{64}$ ]]
      ;;
    bot-orchestrator)
      [[ "$image" =~ ^ghcr\.io/yengalvez/bot-orchestrator@sha256:[a-fA-F0-9]{64}$ ]]
      ;;
    bot-runner)
      [[ "$image" =~ ^ghcr\.io/yengalvez/bot-runner@sha256:[a-fA-F0-9]{64}$ ]]
      ;;
    *)
      return 2
      ;;
  esac
}

reactivation_image_for_pair_is_trusted() {
  local pair="$1"
  local image="$2"
  local repository
  [[ "$image" =~ @sha256:[a-fA-F0-9]{64}$ ]] || return 1
  repository="${image%@sha256:*}"
  case "$pair" in
    bot-orchestrator/bot-orchestrator)
      [[ "$repository" == ghcr.io/yengalvez/bot-orchestrator ]]
      ;;
    bot-runner/bot-runner)
      [[ "$repository" == ghcr.io/yengalvez/bot-runner ]]
      ;;
    coturn/coturn)
      [[ "$repository" == ghcr.io/yengalvez/coturn ]]
      ;;
    dialog/dialog)
      [[ "$repository" == ghcr.io/yengalvez/dialog ]]
      ;;
    haproxy/haproxy)
      [[ "$repository" == ghcr.io/yengalvez/haproxy ||
         "$repository" == docker.io/haproxytech/kubernetes-ingress ||
         "$repository" == haproxytech/kubernetes-ingress ]]
      ;;
    hubs/hubs)
      [[ "$repository" == ghcr.io/yengalvez/hubs ]]
      ;;
    nearspark/nearspark)
      [[ "$repository" == ghcr.io/yengalvez/nearspark ||
         "$repository" == docker.io/mozillareality/nearspark ||
         "$repository" == mozillareality/nearspark ]]
      ;;
    pgbouncer/pgbouncer | pgbouncer-t/pgbouncer-t)
      [[ "$repository" == ghcr.io/yengalvez/pgbouncer ||
         "$repository" == docker.io/edoburu/pgbouncer ||
         "$repository" == edoburu/pgbouncer ]]
      ;;
    photomnemonic/photomnemonic)
      [[ "$repository" == ghcr.io/yengalvez/photomnemonic ]]
      ;;
    pgsql/pgsql)
      [[ "$repository" == ghcr.io/yengalvez/postgres ||
         "$repository" == docker.io/library/postgres || "$repository" == postgres ]]
      ;;
    reticulum/postgrest)
      [[ "$repository" == ghcr.io/yengalvez/postgrest ||
         "$repository" == docker.io/postgrest/postgrest ||
         "$repository" == postgrest/postgrest ]]
      ;;
    reticulum/reticulum)
      [[ "$repository" == ghcr.io/yengalvez/reticulum ]]
      ;;
    spoke/spoke)
      [[ "$repository" == ghcr.io/yengalvez/spoke ]]
      ;;
    *)
      return 2
      ;;
  esac
}

reactivation_image_map_is_trusted() {
  local images_json="$1"
  local pair image
  local expected_pairs
  expected_pairs=$'bot-orchestrator/bot-orchestrator\ncoturn/coturn\ndialog/dialog\nhaproxy/haproxy\nhubs/hubs\nnearspark/nearspark\npgbouncer/pgbouncer\npgbouncer-t/pgbouncer-t\nphotomnemonic/photomnemonic\npgsql/pgsql\nreticulum/postgrest\nreticulum/reticulum\nspoke/spoke'
  jq -e 'type == "object" and length == 13' >/dev/null <<<"$images_json" || return 1
  [[ "$(jq -r 'keys[]' <<<"$images_json" | LC_ALL=C sort)" == \
     "$(printf '%s\n' "$expected_pairs" | LC_ALL=C sort)" ]] || return 1
  while IFS=$'\t' read -r pair image; do
    reactivation_image_for_pair_is_trusted "$pair" "$image" || return 1
  done < <(jq -r 'to_entries[] | [.key,.value] | @tsv' <<<"$images_json")
}

reactivation_write_curl_bearer_config() {
  local path="$1"
  local token="$2"
  [[ -n "$path" && -n "$token" ]] || return 2
  [[ "$token" != *$'\n'* && "$token" != *$'\r'* && "$token" != *'"'* ]] || return 2
  printf 'header = "Authorization: Bearer %s"\nsilent\nshow-error\n' "$token" >"$path"
  chmod 600 "$path"
}

reactivation_checksum_manifest_is_safe() {
  local path="$1"
  [[ -f "$path" && ! -L "$path" && -s "$path" ]] || return 1
  awk '
    $0 !~ /^[a-fA-F0-9]{64}  [A-Za-z0-9][A-Za-z0-9._-]*$/ { unsafe=1; next }
    { name=substr($0, 67); if (seen[name]++) unsafe=1; count++ }
    END { exit (unsafe || count == 0) ? 1 : 0 }
  ' "$path"
}

reactivation_verify_sha256_manifest() {
  local directory="$1"
  local manifest="$2"
  local line artifact expected actual
  reactivation_checksum_manifest_is_safe "$directory/$manifest" || return 1
  while IFS= read -r line; do
    expected="${line:0:64}"
    artifact="${line:66}"
    [[ -f "$directory/$artifact" && ! -L "$directory/$artifact" ]] || return 1
    if command -v shasum >/dev/null 2>&1; then
      actual="$(shasum -a 256 "$directory/$artifact" | awk '{print $1}')" || return 1
    elif command -v sha256sum >/dev/null 2>&1; then
      actual="$(sha256sum "$directory/$artifact" | awk '{print $1}')" || return 1
    else
      return 127
    fi
    [[ "$actual" == "$expected" ]] || return 1
  done <"$directory/$manifest"
}

reactivation_bot_health_is_acceptable() {
  local payload="${1:-}"
  [[ -n "$payload" ]] || return 1
  jq -e '
    type == "object" and
    .ok == true and
    .runner_backend_default == "ghost" and
    (.runner_backend_canary_room_count | type == "number" and floor == . and . == 0) and
    .ghost_navigation_mode == "navmesh_preferred" and
    .ghost_navigation_require_navmesh == true and
    .llm_enabled == true and
    .model == "gpt-5-nano" and
    .max_bots_per_room == 10 and
    (.max_active_rooms >= 1 and .max_active_rooms <= 10)
  ' >/dev/null 2>&1 <<<"$payload"
}

reactivation_sitting_capabilities_are_acceptable() {
  local payload="${1:-}"
  [[ -n "$payload" ]] || return 1
  jq -e '
    type == "object" and
    (keys == ["waypoint_reservation"]) and
    (.waypoint_reservation | type == "object") and
    ((.waypoint_reservation | keys) ==
      ["protocol", "snapshot_state_version", "state_version"]) and
    .waypoint_reservation.protocol == 2 and
    .waypoint_reservation.state_version == "monotonic_safe_integer" and
    .waypoint_reservation.snapshot_state_version == "strictly_greater_than_events"
  ' >/dev/null 2>&1 <<<"$payload"
}

reactivation_deployments_are_acceptable() {
  local payload="$1"
  local hubs_image="$2"
  local reticulum_image="$3"
  local bot_image="$4"
  local expected_images_json="$5"
  local runner_image="${6:-}"
  [[ -n "$payload" ]] || return 1
  reactivation_image_map_is_trusted "$expected_images_json" || return 1
  reactivation_image_override_is_exact bot-runner "$runner_image" || return 1
  jq -e \
    --arg hubs "$hubs_image" \
    --arg reticulum "$reticulum_image" \
    --arg bot "$bot_image" \
    --arg runner "$runner_image" \
    --argjson expected_images "$expected_images_json" '
    def expected_deployments:
      ["bot-orchestrator", "coturn", "dialog", "haproxy", "hubs", "nearspark",
       "pgbouncer", "pgbouncer-t", "photomnemonic", "pgsql", "reticulum", "spoke"];
    def expected_pairs:
      ["bot-orchestrator/bot-orchestrator", "coturn/coturn", "dialog/dialog",
       "haproxy/haproxy", "hubs/hubs", "nearspark/nearspark", "pgbouncer/pgbouncer",
       "pgbouncer-t/pgbouncer-t", "photomnemonic/photomnemonic", "pgsql/pgsql",
       "reticulum/postgrest", "reticulum/reticulum", "spoke/spoke"];
    type == "object" and (.items | type == "array") and
    ($expected_images | type == "object") and
    (($expected_images | keys | sort) == (expected_pairs | sort)) and
    all($expected_images[];
      type == "string" and test("^[A-Za-z0-9._-]+(?:\\:[0-9]+)?/[A-Za-z0-9._/-]+@sha256:[a-fA-F0-9]{64}$")) and
    $expected_images["hubs/hubs"] == $hubs and
    $expected_images["reticulum/reticulum"] == $reticulum and
    $expected_images["bot-orchestrator/bot-orchestrator"] == $bot and
    ([.items[].metadata.name] | sort) == (expected_deployments | sort) and
    ([.items[].metadata.name] | unique | length) == 12 and
    ([.items[] as $deployment | $deployment.spec.template.spec.containers[] |
      ($deployment.metadata.name + "/" + .name)] | sort) == (expected_pairs | sort) and
    all(.items[];
      ((.spec.template.spec.initContainers // []) | length) == 0 and
      ((.spec.template.spec.ephemeralContainers // []) | length) == 0 and
      (.spec.replicas | type == "number" and floor == . and . > 0) and
      (.status.readyReplicas // 0) == .spec.replicas and
      all(.spec.template.spec.containers[];
        .image | type == "string" and test("@sha256:[a-fA-F0-9]{64}$"))) and
    ([.items[] as $deployment
      | $deployment.spec.template.spec.containers[]
      | .image == $expected_images[$deployment.metadata.name + "/" + .name]] | all) and
    ([.items[] | select(.metadata.name == "bot-orchestrator") | .spec.replicas] == [1]) and
    ([.items[] | select(.metadata.name == "reticulum") | .spec.replicas] == [1]) and
    ([.items[] | select(.metadata.name == "reticulum") | .spec.strategy] ==
      [{type:"Recreate"}]) and
    all(.items[] | select(
      .metadata.name == "bot-orchestrator" or .metadata.name == "coturn" or
      .metadata.name == "dialog" or .metadata.name == "pgsql" or
      .metadata.name == "reticulum"); .spec.strategy.type == "Recreate") and
    ([.items[] | select(.metadata.name == "hubs") | .spec.template.spec.containers[] |
      select(.name == "hubs") | .image] == [$hubs]) and
    ([.items[] | select(.metadata.name == "reticulum") | .spec.template.spec.containers[] |
      select(.name == "reticulum") | .image] == [$reticulum]) and
    ([.items[] | select(.metadata.name == "bot-orchestrator") | .spec.template.spec.containers[] |
      select(.name == "bot-orchestrator") | .image] == [$bot]) and
    ([.items[] | select(.metadata.name == "bot-orchestrator") |
      .spec.template.spec.containers[] | select(.name == "bot-orchestrator") |
      (.env // [])[] | select(.name == "BOT_RUNNER_IMAGE") | .value] == [$runner])
  ' >/dev/null 2>&1 <<<"$payload"
}

reactivation_reticulum_deployment_is_singleton() {
  local payload="${1:-}"
  [[ -n "$payload" ]] || return 1
  jq -e '
    .apiVersion == "apps/v1" and .kind == "Deployment" and
    .metadata.name == "reticulum" and
    (.metadata.namespace | type == "string" and length > 0) and
    (.metadata.uid | type == "string" and length > 0) and
    .spec.replicas == 1 and
    .spec.strategy == {type:"Recreate"} and
    .spec.selector.matchLabels.app == "reticulum" and
    .spec.template.metadata.labels.app == "reticulum"
  ' >/dev/null 2>&1 <<<"$payload"
}

reactivation_hpas_do_not_target_reticulum() {
  local payload="${1:-}"
  [[ -n "$payload" ]] || return 1
  jq -e '
    type == "object" and (.items | type == "array") and
    ([.items[] | select(
      .spec.scaleTargetRef.apiVersion == "apps/v1" and
      .spec.scaleTargetRef.kind == "Deployment" and
      .spec.scaleTargetRef.name == "reticulum")] | length) == 0
  ' >/dev/null 2>&1 <<<"$payload"
}

reactivation_bot_control_plane_is_acceptable() {
  local payload="${1:-}"
  local namespace="${2:-}"
  [[ -n "$payload" && "$namespace" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || return 2
  jq -e --arg namespace "$namespace" '
    type == "object" and
    (keys | sort) == ["parent_role", "parent_role_binding", "parent_service_account", "runner_service_account"] and
    .parent_service_account.apiVersion == "v1" and
    .parent_service_account.kind == "ServiceAccount" and
    .parent_service_account.metadata.name == "bot-orchestrator" and
    .parent_service_account.metadata.namespace == $namespace and
    .parent_service_account.automountServiceAccountToken == true and
    .parent_service_account.imagePullSecrets == [{name:"bot-images-pull"}] and
    .runner_service_account.apiVersion == "v1" and
    .runner_service_account.kind == "ServiceAccount" and
    .runner_service_account.metadata.name == "bot-runner" and
    .runner_service_account.metadata.namespace == $namespace and
    .runner_service_account.automountServiceAccountToken == false and
    .runner_service_account.imagePullSecrets == [{name:"bot-images-pull"}] and
    .parent_role.apiVersion == "rbac.authorization.k8s.io/v1" and
    .parent_role.kind == "Role" and
    .parent_role.metadata.name == "bot-orchestrator-runner-pods" and
    .parent_role.metadata.namespace == $namespace and
    (.parent_role.rules | type == "array" and length == 1) and
    (.parent_role.rules[0].apiGroups == [""]) and
    (.parent_role.rules[0].resources == ["pods"]) and
    ((.parent_role.rules[0].verbs | sort) == ["create","delete","get","list"]) and
    .parent_role_binding.apiVersion == "rbac.authorization.k8s.io/v1" and
    .parent_role_binding.kind == "RoleBinding" and
    .parent_role_binding.metadata.name == "bot-orchestrator-runner-pods" and
    .parent_role_binding.metadata.namespace == $namespace and
    .parent_role_binding.roleRef == {
      apiGroup:"rbac.authorization.k8s.io",kind:"Role",name:"bot-orchestrator-runner-pods"
    } and
    .parent_role_binding.subjects == [{kind:"ServiceAccount",name:"bot-orchestrator",namespace:$namespace}]
  ' >/dev/null 2>&1 <<<"$payload"
}

reactivation_network_policies_are_exact() {
  local payload="$1"
  [[ -n "$payload" ]] || return 1
  jq -e '
    def policy($name): [.items[] | select(.metadata.name == $name)] | if length == 1 then .[0].spec else null end;
    def ingress_contract($name; $target; $sources; $port):
      policy($name) as $spec |
      ($spec | type == "object") and
      (($spec | keys | sort) == ["ingress", "podSelector", "policyTypes"]) and
      $spec.podSelector == {matchLabels:{app:$target}} and
      $spec.policyTypes == ["Ingress"] and
      ($spec.ingress | type == "array" and length == 1) and
      (($spec.ingress[0] | keys | sort) == ["from", "ports"]) and
      ($spec.ingress[0].from | type == "array") and
      all($spec.ingress[0].from[];
        (keys == ["podSelector"]) and .podSelector == {matchLabels:{app:.podSelector.matchLabels.app}}) and
      ([$spec.ingress[0].from[].podSelector.matchLabels.app] | sort) == ($sources | sort) and
      $spec.ingress[0].ports == [{port:$port, protocol:"TCP"}];
    def expected_except:
      ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
       "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24",
       "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
       "224.0.0.0/4", "240.0.0.0/4"];
    type == "object" and (.items | type == "array") and
    ([.items[].metadata.name] | sort) == ([
      "bot-orchestrator-ingress", "pgbouncer-ingress", "pgbouncer-t-ingress",
      "pgsql-ingress", "photomnemonic-ingress", "photomnemonic-egress"
    ] | sort) and
    ([.items[].metadata.name] | unique | length) == 6 and
    (policy("bot-orchestrator-ingress")) == {
      podSelector:{matchLabels:{app:"bot-orchestrator"}},
      policyTypes:["Ingress"],
      ingress:[{
        from:[
          {podSelector:{matchLabels:{app:"reticulum"}}},
          {
            podSelector:{matchLabels:{app:"bot-runner","yenhubs.org/managed-by":"bot-orchestrator"}},
            namespaceSelector:{matchLabels:{"kubernetes.io/metadata.name":"hcce-bot-runners"}}
          }
        ],
        ports:[{protocol:"TCP",port:5001}]
      }]
    } and
    ingress_contract("pgbouncer-ingress"; "pgbouncer"; ["reticulum"]; 5432) and
    ingress_contract("pgbouncer-t-ingress"; "pgbouncer-t"; ["reticulum"]; 5432) and
    ingress_contract("pgsql-ingress"; "pgsql"; ["pgbouncer", "pgbouncer-t"]; 5432) and
    ingress_contract("photomnemonic-ingress"; "photomnemonic"; ["reticulum"]; 5000) and
    (policy("photomnemonic-egress")) as $egress |
    ($egress | type == "object") and
    (($egress | keys | sort) == ["egress", "podSelector", "policyTypes"]) and
    $egress.podSelector == {matchLabels:{app:"photomnemonic"}} and
    $egress.policyTypes == ["Egress"] and
    ($egress.egress | type == "array" and length == 2) and
    ([ $egress.egress[] | select(any(.ports[]?; .port == 53)) ] | length) == 1 and
    ([ $egress.egress[] | select(any(.ports[]?; .port == 80)) ] | length) == 1 and
    ([ $egress.egress[] | select(any(.ports[]?; .port == 53)) ][0]) as $dns |
    (($dns | keys | sort) == ["ports", "to"]) and
    $dns.to == [{
      namespaceSelector:{matchLabels:{"kubernetes.io/metadata.name":"kube-system"}},
      podSelector:{matchLabels:{"k8s-app":"kube-dns"}}
    }] and
    ([$dns.ports[] | ((.protocol // "TCP") + ":" + (.port | tostring))] | sort) == ["TCP:53", "UDP:53"] and
    all($dns.ports[]; (keys | sort) == ["port", "protocol"]) and
    ([ $egress.egress[] | select(any(.ports[]?; .port == 80)) ][0]) as $web |
    (($web | keys | sort) == ["ports", "to"]) and
    ($web.to | length) == 1 and
    (($web.to[0] | keys) == ["ipBlock"]) and
    $web.to[0].ipBlock.cidr == "0.0.0.0/0" and
    ($web.to[0].ipBlock.except | sort) == (expected_except | sort) and
    (($web.to[0].ipBlock | keys | sort) == ["cidr", "except"]) and
    ([$web.ports[] | ((.protocol // "TCP") + ":" + (.port | tostring))] | sort) == ["TCP:443", "TCP:80"] and
    all($web.ports[]; (keys | sort) == ["port", "protocol"])
  ' >/dev/null 2>&1 <<<"$payload"
}

reactivation_bot_readiness_is_acceptable() {
  local payload="${1:-}"
  [[ -n "$payload" ]] || return 1
  jq -e '
    . as $root |
    ($root | type == "object") and
    (($root | keys | sort) == [
      "active_hubs",
      "authoritative_snapshot_ready",
      "authoritative_snapshot_ttl_ms",
      "capacity_exceeded",
      "configured_room_count",
      "expected_hubs",
      "extra_process_hubs",
      "max_active_rooms",
      "ok",
      "process_hubs",
      "runner_bots",
      "runner_health_ttl_ms",
      "snapshot_age_ms",
      "snapshot_reason",
      "stopping_hubs",
      "unready_hubs"
    ]) and
    $root.ok == true and
    $root.authoritative_snapshot_ready == true and
    $root.capacity_exceeded == false and
    $root.snapshot_reason == "ready" and
    ($root.snapshot_age_ms | type == "number") and
    $root.snapshot_age_ms >= 0 and
    ($root.runner_health_ttl_ms | type == "number") and
    ($root.runner_health_ttl_ms | floor) == $root.runner_health_ttl_ms and
    $root.runner_health_ttl_ms > 0 and
    ($root.authoritative_snapshot_ttl_ms | type == "number") and
    ($root.authoritative_snapshot_ttl_ms | floor) == $root.authoritative_snapshot_ttl_ms and
    $root.authoritative_snapshot_ttl_ms > 0 and
    $root.snapshot_age_ms <= $root.authoritative_snapshot_ttl_ms and
    ($root.expected_hubs | type == "array" and length > 0) and
    ($root.configured_room_count | type == "number") and
    ($root.configured_room_count | floor) == $root.configured_room_count and
    $root.configured_room_count == ($root.expected_hubs | length) and
    ($root.max_active_rooms | type == "number") and
    ($root.max_active_rooms | floor) == $root.max_active_rooms and
    ($root.max_active_rooms >= 1 and $root.max_active_rooms <= 10) and
    $root.configured_room_count <= $root.max_active_rooms and
    all($root.expected_hubs[]; type == "string" and length > 0) and
    (($root.expected_hubs | unique | length) == ($root.expected_hubs | length)) and
    ($root.unready_hubs | type == "array" and length == 0) and
    ($root.process_hubs | type == "array") and
    all($root.process_hubs[]; type == "string" and length > 0) and
    (($root.process_hubs | unique | length) == ($root.process_hubs | length)) and
    ($root.extra_process_hubs | type == "array" and length == 0) and
    ($root.stopping_hubs | type == "array" and length == 0) and
    ($root.active_hubs | type == "array") and
    all($root.active_hubs[]; type == "string" and length > 0) and
    (($root.active_hubs | unique | length) == ($root.active_hubs | length)) and
    ($root.runner_bots | type == "object") and
    (($root.runner_bots | keys | sort) == ($root.expected_hubs | sort)) and
    (($root.expected_hubs | sort) == ($root.process_hubs | sort)) and
    (($root.expected_hubs | sort) == ($root.active_hubs | sort)) and
    all($root.expected_hubs[]; . as $hub |
      (($root.runner_bots[$hub] | keys | sort) == [
        "active",
        "authenticated",
        "authoritative_spawn_acks",
        "config_applied",
        "desired",
        "lifecycle",
        "navigation_ready",
        "ready",
        "reason"
      ]) and
      $root.runner_bots[$hub].authenticated == true and
      $root.runner_bots[$hub].authoritative_spawn_acks == true and
      $root.runner_bots[$hub].navigation_ready == true and
      $root.runner_bots[$hub].config_applied == true and
      $root.runner_bots[$hub].ready == true and
      $root.runner_bots[$hub].lifecycle == "running" and
      $root.runner_bots[$hub].reason == "ready" and
      ($root.runner_bots[$hub].desired | type == "number") and
      ($root.runner_bots[$hub].active | type == "number") and
      ($root.runner_bots[$hub].desired > 0 and $root.runner_bots[$hub].desired <= 10) and
      ($root.runner_bots[$hub].desired | floor) == $root.runner_bots[$hub].desired and
      ($root.runner_bots[$hub].active | floor) == $root.runner_bots[$hub].active and
      $root.runner_bots[$hub].active == $root.runner_bots[$hub].desired)
  ' >/dev/null 2>&1 <<<"$payload"
}

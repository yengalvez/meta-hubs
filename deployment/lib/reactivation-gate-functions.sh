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
  local path index
  if ((${#REACTIVATION_TEMP_PATHS[@]} > 0)); then
    # Snapshot files are registered after their private parent directory. Walk
    # backwards so files disappear before an exact, empty rmdir. Never recurse
    # through a path registered by a read-only gate.
    for ((index = ${#REACTIVATION_TEMP_PATHS[@]} - 1; index >= 0; index--)); do
      path="${REACTIVATION_TEMP_PATHS[$index]}"
      [[ -n "$path" ]] || continue
      if [[ -f "$path" || -L "$path" ]]; then
        rm -f -- "$path"
      elif [[ -d "$path" ]]; then
        rmdir -- "$path" 2>/dev/null || :
      fi
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
  local label="${3:-values}"
  local snapshot_path snapshot_dir snapshot_root helper_dir
  [[ -n "$destination_variable" && "$label" =~ ^[a-z][a-z0-9-]{0,31}$ &&
     -f "$source_path" && ! -L "$source_path" ]] || return 1
  reactivation_values_file_is_private "$source_path" || return 1
  helper_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)" || return 1
  snapshot_root="$(cd "${TMPDIR:-/tmp}" && pwd -P)" || return 1
  snapshot_dir="$(mktemp -d "$snapshot_root/yenhubs-$label-snapshot.XXXXXX")" ||
    return 1
  chmod 700 "$snapshot_dir" || {
    rmdir "$snapshot_dir" 2>/dev/null || :
    return 1
  }
  reactivation_register_temp_path "$snapshot_dir"
  snapshot_path="$(mktemp "$snapshot_dir/input.XXXXXX")" || return 1
  chmod 600 "$snapshot_path" || return 1
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

reactivation_target_profile() {
  local target_mode="${1:-in-place}"
  local runner_generation="${2:-}"
  case "$target_mode:$runner_generation" in
    in-place:|in-place:durable-v2)
      printf 'durable-active\n'
      ;;
    cold-rebind:legacy-absent)
      printf 'cold-rebind-legacy-absent-v1\n'
      ;;
    *)
      return 1
      ;;
  esac
}

reactivation_runner_image_matches_profile() {
  local profile="$1"
  local image="$2"
  case "$profile" in
    durable-active)
      reactivation_image_override_is_exact bot-runner "$image"
      ;;
    cold-rebind-legacy-absent-v1)
      [[ "$image" == No ]]
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
         "$repository" == docker.io/mozillareality/pgbouncer ||
         "$repository" == docker.io/edoburu/pgbouncer ||
         "$repository" == edoburu/pgbouncer ]]
      ;;
    photomnemonic/photomnemonic)
      [[ "$repository" == ghcr.io/yengalvez/photomnemonic ]]
      ;;
    pgsql/pgsql | pgsql/postgresql)
      [[ "$repository" == ghcr.io/yengalvez/postgres ||
         "$repository" == docker.io/mozillareality/postgres ||
         "$repository" == docker.io/library/postgres || "$repository" == postgres ]]
      ;;
    reticulum/postgrest)
      [[ "$repository" == ghcr.io/yengalvez/postgrest ||
         "$repository" == docker.io/mozillareality/postgrest ||
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
  local pair image postgres_pair
  local expected_pairs
  expected_pairs=$'bot-orchestrator/bot-orchestrator\ncoturn/coturn\ndialog/dialog\nhaproxy/haproxy\nhubs/hubs\nnearspark/nearspark\npgbouncer/pgbouncer\npgbouncer-t/pgbouncer-t\nphotomnemonic/photomnemonic\nreticulum/postgrest\nreticulum/reticulum\nspoke/spoke'
  jq -e 'type == "object" and length == 13' >/dev/null <<<"$images_json" || return 1
  postgres_pair="$(jq -er '
    [keys[] | select(. == "pgsql/pgsql" or . == "pgsql/postgresql")] |
    select(length == 1) | .[0]
  ' <<<"$images_json")" || return 1
  expected_pairs="${expected_pairs}"$'\n'"$postgres_pair"
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

reactivation_legacy_bot_health_is_acceptable() {
  local payload="${1:-}"
  [[ -n "$payload" ]] || return 1
  jq -e '
    . as $root |
    type == "object" and
    ((keys | sort) == [
      "active_hubs", "active_rooms", "ghost_navigation_mode", "llm_enabled",
      "max_active_rooms", "max_bots_per_room", "max_chromium_rooms", "model",
      "ok", "queued_hubs", "queued_rooms", "rooms", "runner_backend_canary_hubs",
      "runner_backend_default", "runner_backends"
    ]) and
    .ok == true and .runner_backend_default == "ghost" and
    .runner_backend_canary_hubs == [] and
    .ghost_navigation_mode == "navmesh_preferred" and
    .llm_enabled == true and .model == "gpt-5-nano" and
    .max_bots_per_room == 10 and
    (.max_active_rooms | type == "number" and floor == . and . >= 1 and . <= 10) and
    (.max_chromium_rooms | type == "number" and floor == . and . >= 1) and
    (.rooms | type == "number" and floor == . and . >= 0) and
    (.active_rooms | type == "number" and floor == . and . >= 0 and
      . <= $root.max_active_rooms and . <= $root.rooms) and
    (.queued_rooms | type == "number" and floor == . and . >= 0) and
    (.active_hubs | type == "array" and length == $root.active_rooms) and
    (.queued_hubs | type == "array" and length == $root.queued_rooms) and
    ((.active_hubs + .queued_hubs) | all(.[];
      type == "string" and test("^[^\u0000-\u001f\u007f]{1,64}$"))) and
    ((.active_hubs + .queued_hubs) | unique | length) ==
      ((.active_hubs + .queued_hubs) | length) and
    (.runner_backends | type == "object") and
    ((.runner_backends | keys | sort) == (.active_hubs | sort)) and
    all(.runner_backends[]; . == "ghost")
  ' >/dev/null 2>&1 <<<"$payload"
}

reactivation_legacy_reticulum_health_is_acceptable() {
  [[ "${1:-}" == "ok" ]]
}

reactivation_bot_health_matches_profile() {
  local payload="${1:-}"
  local profile="${2:-durable-active}"
  case "$profile" in
    durable-active)
      reactivation_bot_health_is_acceptable "$payload"
      ;;
    cold-rebind-legacy-absent-v1)
      reactivation_legacy_bot_health_is_acceptable "$payload"
      ;;
    *)
      return 2
      ;;
  esac
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
  local profile="${7:-durable-active}"
  local postgres_container=pgsql
  [[ -n "$payload" ]] || return 1
  [[ "$profile" == durable-active ||
     "$profile" == cold-rebind-legacy-absent-v1 ]] || return 2
  if [[ "$profile" == cold-rebind-legacy-absent-v1 ]]; then
    postgres_container=postgresql
  fi
  reactivation_image_map_is_trusted "$expected_images_json" || return 1
  reactivation_runner_image_matches_profile "$profile" "$runner_image" || return 1
  jq -e \
    --arg hubs "$hubs_image" \
    --arg reticulum "$reticulum_image" \
    --arg bot "$bot_image" \
    --arg runner "$runner_image" \
    --arg profile "$profile" \
    --arg postgres_container "$postgres_container" \
    --argjson expected_images "$expected_images_json" '
    def expected_deployments:
      ["bot-orchestrator", "coturn", "dialog", "haproxy", "hubs", "nearspark",
       "pgbouncer", "pgbouncer-t", "photomnemonic", "pgsql", "reticulum", "spoke"];
    def expected_pairs:
      ["bot-orchestrator/bot-orchestrator", "coturn/coturn", "dialog/dialog",
       "haproxy/haproxy", "hubs/hubs", "nearspark/nearspark", "pgbouncer/pgbouncer",
       "pgbouncer-t/pgbouncer-t", "photomnemonic/photomnemonic",
       ("pgsql/" + $postgres_container),
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
    (if $profile == "durable-active" then
       ([.items[] | select(.metadata.name == "bot-orchestrator") |
         .spec.template.spec.containers[] | select(.name == "bot-orchestrator") |
         (.env // [])[] | select(.name == "BOT_RUNNER_IMAGE") | .value] == [$runner])
     else
       ([.items[] | select(.metadata.name == "bot-orchestrator") |
         .spec.template.spec.containers[] | select(.name == "bot-orchestrator") |
         (.env // [])[] | select(.name == "BOT_RUNNER_IMAGE")] | length) == 0 and
       ([.items[] | select(.metadata.name == "bot-orchestrator") |
         .spec.template.spec.containers[] | select(.name == "bot-orchestrator") |
         (.env // [])[] | select(.name == "RET_INTERNAL_ACCESS_HEADER") | .value] ==
        ["x-ret-dashboard-access-key"])
     end)
  ' >/dev/null 2>&1 <<<"$payload"
}

reactivation_reticulum_deployment_is_singleton() {
  local payload="${1:-}"
  [[ -n "$payload" ]] || return 1
  jq -e '
    def exact_reticulum:
      .metadata.name == "reticulum" and
      (.metadata.namespace | type == "string" and length > 0) and
      (.metadata.uid | type == "string" and length > 0) and
      .spec.replicas == 1 and
      .spec.strategy == {type:"Recreate"} and
      .spec.selector.matchLabels.app == "reticulum" and
      .spec.template.metadata.labels.app == "reticulum";
    if .apiVersion == "apps/v1" and .kind == "Deployment" then
      exact_reticulum
    elif .apiVersion == "apps/v1" and .kind == "DeploymentList" and
         (.metadata.resourceVersion | type == "string" and length > 0) and
         (.items | type == "array") then
      [.items[] | select(.metadata.name == "reticulum")] as $matches |
      ($matches | length) == 1 and ($matches[0] | exact_reticulum)
    else
      false
    end
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
  local profile="${2:-durable-active}"
  [[ -n "$payload" ]] || return 1
  [[ "$profile" == durable-active ||
     "$profile" == cold-rebind-legacy-absent-v1 ]] || return 2
  jq -e --arg profile "$profile" '
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
    ([.items[].metadata.name] | sort) == (([
      "pgbouncer-ingress", "pgbouncer-t-ingress", "pgsql-ingress",
      "photomnemonic-ingress", "photomnemonic-egress"
    ] + (if $profile == "durable-active" then ["bot-orchestrator-ingress"] else [] end)) | sort) and
    ([.items[].metadata.name] | unique | length) ==
      (if $profile == "durable-active" then 6 else 5 end) and
    (if $profile == "durable-active" then
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
       }
     else true end) and
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

reactivation_legacy_pull_secret_is_acceptable() {
  local payload="$1"
  local namespace="$2"
  local encoded="$3"
  [[ -n "$payload" && -n "$namespace" && -n "$encoded" ]] || return 1
  jq -e --arg namespace "$namespace" --arg encoded "$encoded" '
    .apiVersion == "v1" and .kind == "Secret" and
    .metadata.name == "bot-images-pull" and
    .metadata.namespace == $namespace and
    (.metadata.deletionTimestamp // null) == null and
    .type == "kubernetes.io/dockerconfigjson" and
    (.data | type == "object") and
    (.data | keys) == [".dockerconfigjson"] and
    .data[".dockerconfigjson"] == $encoded
  ' >/dev/null 2>&1 <<<"$payload"
}

reactivation_legacy_live_runtime_is_exact() {
  local values_path="$1"
  local namespace="$2"
  local pull_secret_payload="$3"
  local pull_config="$4"
  local residual_state
  [[ -n "$values_path" && -n "$namespace" ]] || return 2
  recovery_require_live_process_local_cold_rebind_target_exact \
    "$values_path" || return 1
  residual_state="$(recovery_runner_isolation_residual_state)" || return 1
  [[ "$residual_state" == absent ]] || return 1
  recovery_require_no_managed_bot_runner_pods || return 1
  reactivation_legacy_pull_secret_is_acceptable \
    "$pull_secret_payload" "$namespace" "$pull_config"
}

reactivation_bot_readiness_payload_is_well_formed() {
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
      "runner_guard_capacity",
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
    ($root.runner_guard_capacity | type == "object") and
    (($root.runner_guard_capacity | keys | sort) == [
      "fences",
      "intents",
      "observed",
      "quota",
      "reserve",
      "start_limit",
      "total",
      "warning",
      "warning_threshold"
    ]) and
    ($root.runner_guard_capacity.observed | type == "boolean") and
    ($root.runner_guard_capacity.intents | type == "number") and
    ($root.runner_guard_capacity.intents | floor) == $root.runner_guard_capacity.intents and
    $root.runner_guard_capacity.intents >= 0 and
    ($root.runner_guard_capacity.fences | type == "number") and
    ($root.runner_guard_capacity.fences | floor) == $root.runner_guard_capacity.fences and
    $root.runner_guard_capacity.fences >= 0 and
    ($root.runner_guard_capacity.total | type == "number") and
    ($root.runner_guard_capacity.total | floor) == $root.runner_guard_capacity.total and
    $root.runner_guard_capacity.total ==
      ($root.runner_guard_capacity.intents + $root.runner_guard_capacity.fences) and
    ($root.runner_guard_capacity.warning | type == "boolean") and
    $root.runner_guard_capacity.warning == ($root.runner_guard_capacity.total >= 60) and
    $root.runner_guard_capacity.warning_threshold == 60 and
    $root.runner_guard_capacity.start_limit == 80 and
    $root.runner_guard_capacity.reserve == 20 and
    $root.runner_guard_capacity.quota == 100 and
    $root.runner_guard_capacity.start_limit + $root.runner_guard_capacity.reserve ==
      $root.runner_guard_capacity.quota and
    $root.runner_guard_capacity.total <= $root.runner_guard_capacity.quota and
    (if $root.runner_guard_capacity.observed then true else
      $root.runner_guard_capacity.intents == 0 and
      $root.runner_guard_capacity.fences == 0 and
      $root.runner_guard_capacity.total == 0 and
      $root.runner_guard_capacity.warning == false
    end) and
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

reactivation_bot_readiness_is_acceptable() {
  local payload="${1:-}"
  reactivation_bot_readiness_payload_is_well_formed "$payload" || return 1
  jq -e '
    .runner_guard_capacity.observed == true and
    .runner_guard_capacity.warning == false and
    .runner_guard_capacity.total < .runner_guard_capacity.warning_threshold
  ' >/dev/null 2>&1 <<<"$payload"
}

#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=deployment/lib/reactivation-gate-functions.sh
# shellcheck disable=SC1091
# The dynamic source path is resolved relative to the repository at runtime.
source "$ROOT_DIR/deployment/lib/reactivation-gate-functions.sh"

test_count=0
temp_root="$(mktemp -d "${TMPDIR:-/tmp}/yenhubs-security-gates.XXXXXX")"
temp_root="$(cd "$temp_root" && pwd -P)"
cleanup() {
  rm -rf -- "$temp_root"
}
trap cleanup EXIT INT TERM

pass_test() {
  test_count=$((test_count + 1))
  printf 'PASS  %s\n' "$1"
}

fail_test() {
  printf 'FAIL  %s\n' "$1" >&2
  exit 1
}

if [[ "${YENHUBS_SECURITY_GATES_TEST_FOCUS:-}" == image-pair-trust ]]; then
  printf -v digest '%064d' 0
  historical_pgbouncer="docker.io/mozillareality/pgbouncer@sha256:$digest"
  historical_postgres="docker.io/mozillareality/postgres@sha256:$digest"
  historical_postgrest="docker.io/mozillareality/postgrest@sha256:$digest"

  if reactivation_image_for_pair_is_trusted \
      pgbouncer/pgbouncer "$historical_pgbouncer" &&
     reactivation_image_for_pair_is_trusted \
      pgbouncer-t/pgbouncer-t "$historical_pgbouncer" &&
     reactivation_image_for_pair_is_trusted pgsql/pgsql "$historical_postgres" &&
     reactivation_image_for_pair_is_trusted \
      pgsql/postgresql "$historical_postgres" &&
     reactivation_image_for_pair_is_trusted \
      reticulum/postgrest "$historical_postgrest"; then
    pass_test "exact historical Mozilla repositories require a 64-hex digest"
  else
    fail_test "historical Mozilla repository positive matrix"
  fi

  if ! reactivation_image_for_pair_is_trusted pgbouncer/pgbouncer \
      "docker.io/mozillareality/pgbouncer-lookalike@sha256:$digest" &&
     ! reactivation_image_for_pair_is_trusted pgsql/pgsql \
      "docker.io/mozillareality/postgres-lookalike@sha256:$digest" &&
     ! reactivation_image_for_pair_is_trusted reticulum/postgrest \
      "docker.io/mozillareality/postgrest-lookalike@sha256:$digest" &&
     ! reactivation_image_for_pair_is_trusted pgbouncer/pgbouncer \
      "docker.io/mozillareality/pgbouncer:latest"; then
    pass_test "Mozilla lookalikes and nondigest references remain rejected"
  else
    fail_test "historical Mozilla repository negative matrix"
  fi

  if ! reactivation_image_for_pair_is_trusted pgsql/pgsql \
      "$historical_pgbouncer" &&
     ! reactivation_image_for_pair_is_trusted reticulum/postgrest \
      "$historical_postgres" &&
     ! reactivation_image_for_pair_is_trusted pgbouncer-t/pgbouncer-t \
      "$historical_postgrest" &&
     ! reactivation_image_for_pair_is_trusted pgsql/postgrest \
      "$historical_postgrest"; then
    pass_test "historical repositories cannot cross pair or key boundaries"
  else
    fail_test "historical Mozilla pair restriction matrix"
  fi

  printf 'Focused image pair trust tests passed: %s.\n' "$test_count"
  exit 0
fi

if reactivation_live_result_is_clean 0 0 &&
  ! reactivation_live_result_is_clean 1 0 &&
  ! reactivation_live_result_is_clean 0 1 &&
  ! reactivation_live_result_is_clean 1 1; then
  pass_test "live acceptance requires zero failures and zero warnings"
else
  fail_test "live acceptance status matrix"
fi

if [[ "$(reactivation_target_profile in-place '')" == durable-active &&
      "$(reactivation_target_profile in-place durable-v2)" == durable-active &&
      "$(reactivation_target_profile cold-rebind legacy-absent)" == \
        cold-rebind-legacy-absent-v1 ]] &&
   ! reactivation_target_profile cold-rebind durable-v2 >/dev/null 2>&1 &&
   ! reactivation_target_profile in-place legacy-absent >/dev/null 2>&1 &&
   ! reactivation_target_profile cold-rebind '' >/dev/null 2>&1; then
  pass_test "live profile resolver accepts only durable active or exact cold-rebind legacy-absent"
else
  fail_test "live profile resolver matrix"
fi

bot_health_good='{"ok":true,"runner_backend_default":"ghost","runner_backend_canary_room_count":0,"ghost_navigation_mode":"navmesh_preferred","ghost_navigation_require_navmesh":true,"llm_enabled":true,"model":"gpt-5-nano","max_bots_per_room":10,"max_active_rooms":5}'
bot_health_bad='{"ok":true,"runner_backend_default":"ghost","runner_backend_canary_room_count":0,"ghost_navigation_mode":"navmesh_preferred","ghost_navigation_require_navmesh":false,"llm_enabled":true,"model":"gpt-5-nano","max_bots_per_room":10,"max_active_rooms":5}'
if reactivation_bot_health_is_acceptable "$bot_health_good" &&
  ! reactivation_bot_health_is_acceptable "$bot_health_bad" &&
  ! reactivation_bot_health_is_acceptable "${bot_health_good/\"llm_enabled\":true/\"llm_enabled\":false}" &&
  ! reactivation_bot_health_is_acceptable "${bot_health_good/\"runner_backend_canary_room_count\":0/\"runner_backend_canary_room_count\":1}" &&
  ! reactivation_bot_health_is_acceptable "${bot_health_good/\"runner_backend_canary_room_count\":0/\"runner_backend_canary_hubs\":[]}" &&
  ! reactivation_bot_health_is_acceptable ''; then
  pass_test "bot liveness contract requires ghost, navmesh and audited model limits"
else
  fail_test "bot liveness contract"
fi

legacy_bot_health_good='{"ok":true,"rooms":1,"active_rooms":1,"queued_rooms":0,"max_active_rooms":5,"max_chromium_rooms":1,"max_bots_per_room":10,"llm_enabled":true,"model":"gpt-5-nano","runner_backend_default":"ghost","runner_backend_canary_hubs":[],"ghost_navigation_mode":"navmesh_preferred","runner_backends":{"VJopCY3":"ghost"},"active_hubs":["VJopCY3"],"queued_hubs":[]}'
if reactivation_bot_health_matches_profile "$bot_health_good" durable-active &&
   reactivation_bot_health_matches_profile \
     "$legacy_bot_health_good" cold-rebind-legacy-absent-v1 &&
   ! reactivation_bot_health_matches_profile \
     "$legacy_bot_health_good" durable-active &&
   ! reactivation_bot_health_matches_profile \
     "${legacy_bot_health_good/\"ghost\"/\"chromium\"}" \
     cold-rebind-legacy-absent-v1 &&
   ! reactivation_bot_health_matches_profile \
     "${legacy_bot_health_good/\"active_rooms\":1/\"active_rooms\":0}" \
     cold-rebind-legacy-absent-v1; then
  pass_test "legacy process-local health requires active ghost rooms and the exact historical schema"
else
  fail_test "profile-specific bot health contract"
fi

sitting_capabilities_good='{"waypoint_reservation":{"protocol":2,"snapshot_state_version":"strictly_greater_than_events","state_version":"monotonic_safe_integer"}}'
sitting_capabilities_extra='{"unexpected":true,"waypoint_reservation":{"protocol":2,"snapshot_state_version":"strictly_greater_than_events","state_version":"monotonic_safe_integer"}}'
if reactivation_sitting_capabilities_are_acceptable "$sitting_capabilities_good" &&
  ! reactivation_sitting_capabilities_are_acceptable '' &&
  ! reactivation_sitting_capabilities_are_acceptable "${sitting_capabilities_good/\"protocol\":2/\"protocol\":1}" &&
  ! reactivation_sitting_capabilities_are_acceptable "${sitting_capabilities_good/\"monotonic_safe_integer\"/\"integer\"}" &&
  ! reactivation_sitting_capabilities_are_acceptable "$sitting_capabilities_extra"; then
  pass_test "sitting rollout requires the exact protocol-2 wire-semantics capability"
else
  fail_test "sitting capability negotiation contract"
fi

bot_ready_good='{"ok":true,"authoritative_snapshot_ready":true,"capacity_exceeded":false,"configured_room_count":1,"max_active_rooms":5,"runner_guard_capacity":{"observed":true,"intents":0,"fences":0,"total":0,"warning":false,"warning_threshold":60,"start_limit":80,"reserve":20,"quota":100},"snapshot_reason":"ready","snapshot_age_ms":100,"runner_health_ttl_ms":30000,"authoritative_snapshot_ttl_ms":60000,"expected_hubs":["room-a"],"unready_hubs":[],"process_hubs":["room-a"],"extra_process_hubs":[],"stopping_hubs":[],"active_hubs":["room-a"],"runner_bots":{"room-a":{"authenticated":true,"authoritative_spawn_acks":true,"navigation_ready":true,"config_applied":true,"ready":true,"lifecycle":"running","reason":"ready","desired":5,"active":5}}}'
bot_ready_bad='{"ok":true,"authoritative_snapshot_ready":true,"capacity_exceeded":false,"configured_room_count":1,"max_active_rooms":5,"runner_guard_capacity":{"observed":true,"intents":0,"fences":0,"total":0,"warning":false,"warning_threshold":60,"start_limit":80,"reserve":20,"quota":100},"snapshot_reason":"ready","snapshot_age_ms":100,"runner_health_ttl_ms":30000,"authoritative_snapshot_ttl_ms":60000,"expected_hubs":["room-a"],"unready_hubs":[],"process_hubs":["room-a"],"extra_process_hubs":[],"stopping_hubs":[],"active_hubs":["room-a"],"runner_bots":{"room-a":{"authenticated":true,"authoritative_spawn_acks":false,"navigation_ready":true,"config_applied":true,"ready":true,"lifecycle":"running","reason":"ready","desired":5,"active":5}}}'
if reactivation_bot_readiness_is_acceptable "$bot_ready_good" &&
  ! reactivation_bot_readiness_is_acceptable "$bot_ready_bad" &&
  ! reactivation_bot_readiness_is_acceptable "${bot_ready_good/\"ok\":true/\"ok\":true,\"unexpected\":true}" &&
  ! reactivation_bot_readiness_is_acceptable '{"ok":true,"authoritative_snapshot_ready":true,"capacity_exceeded":false,"configured_room_count":0,"max_active_rooms":5,"snapshot_reason":"ready","snapshot_age_ms":100,"runner_health_ttl_ms":30000,"authoritative_snapshot_ttl_ms":60000,"expected_hubs":[],"unready_hubs":[],"process_hubs":[],"extra_process_hubs":[],"stopping_hubs":[],"active_hubs":[],"runner_bots":{}}' &&
  ! reactivation_bot_readiness_is_acceptable '{"ok":true,"expected_hubs":["room-a"],"unready_hubs":[],"active_hubs":["room-a"],"runner_bots":{}}' &&
  ! reactivation_bot_readiness_is_acceptable '{"ok":true,"authoritative_snapshot_ready":true,"capacity_exceeded":false,"configured_room_count":2,"max_active_rooms":5,"snapshot_reason":"ready","snapshot_age_ms":100,"runner_health_ttl_ms":30000,"authoritative_snapshot_ttl_ms":60000,"expected_hubs":["room-a","room-a"],"unready_hubs":[],"process_hubs":["room-a"],"extra_process_hubs":[],"stopping_hubs":[],"active_hubs":["room-a","room-a"],"runner_bots":{"room-a":{"authenticated":true,"authoritative_spawn_acks":true,"navigation_ready":true,"config_applied":true,"ready":true,"lifecycle":"running","reason":"ready","desired":1,"active":1}}}' &&
  ! reactivation_bot_readiness_is_acceptable "${bot_ready_good/\"capacity_exceeded\":false/\"capacity_exceeded\":true}" &&
  ! reactivation_bot_readiness_is_acceptable "${bot_ready_good/\"configured_room_count\":1/\"configured_room_count\":2}" &&
  ! reactivation_bot_readiness_is_acceptable "${bot_ready_good/\"extra_process_hubs\":[]/\"extra_process_hubs\":[\"room-extra\"]}" &&
  ! reactivation_bot_readiness_is_acceptable "${bot_ready_good/\"desired\":5,\"active\":5/\"desired\":11,\"active\":11}" &&
  ! reactivation_bot_readiness_is_acceptable "${bot_ready_good/\"navigation_ready\":true/\"navigation_ready\":false}" &&
  ! reactivation_bot_readiness_is_acceptable "${bot_ready_good/\"config_applied\":true/\"config_applied\":false}" &&
  ! reactivation_bot_readiness_is_acceptable "${bot_ready_good/\"config_applied\":true,/}" &&
  ! reactivation_bot_readiness_is_acceptable "${bot_ready_good/\"config_applied\":true/\"config_applied\":true,\"unexpected\":true}" &&
  ! reactivation_bot_readiness_is_acceptable "${bot_ready_good/\"lifecycle\":\"running\"/\"lifecycle\":\"starting\"}" &&
  ! reactivation_bot_readiness_is_acceptable "${bot_ready_good/\"snapshot_age_ms\":100/\"snapshot_age_ms\":60001}" &&
  ! reactivation_bot_readiness_is_acceptable "${bot_ready_good/\"observed\":true/\"observed\":false}" &&
  ! reactivation_bot_readiness_is_acceptable "${bot_ready_good/\"intents\":0,\"fences\":0,\"total\":0,\"warning\":false/\"intents\":30,\"fences\":30,\"total\":60,\"warning\":true}" &&
  ! reactivation_bot_readiness_is_acceptable "${bot_ready_good/\"total\":0/\"total\":1}" &&
  ! reactivation_bot_readiness_is_acceptable "${bot_ready_good/\"runner_bots\":{/\"runner_bots\":{\"room-extra\":{},}"; then
  pass_test "bot readiness requires exact keys, running lifecycle, fresh snapshot, auth, ACK, navigation, config and population"
else
  fail_test "bot readiness contract"
fi

if real_ready_payload="$(node "$ROOT_DIR/tests/scripts/emit-real-readiness-payload.mjs")" &&
  reactivation_bot_readiness_payload_is_well_formed "$real_ready_payload" &&
  ! reactivation_bot_readiness_is_acceptable "$real_ready_payload"; then
  pass_test "root readiness recognizes the real HTTP payload and requires observed guard capacity for production"
else
  fail_test "root readiness must be tested against the real HTTP handler"
fi
readiness_http_test="${READINESS_TEST_PATH:-$ROOT_DIR/hubs-cloud/community-edition/services/bot-orchestrator/test/app.test.js}"
if grep -Fq 'the real readiness endpoint exposes the fail-closed production contract' "$readiness_http_test" &&
  node --test \
    --test-name-pattern='the real readiness endpoint exposes the fail-closed production contract' \
    "$readiness_http_test" >/dev/null; then
  pass_test "real HTTP readiness test rejects auth, ACK, navigation, config, population and lifecycle drift"
else
  fail_test "real HTTP readiness adversarial contract"
fi

valid_output="stale"
stdout_then_failure() { printf 'apparently-valid'; return 17; }
if reactivation_capture_output valid_output stdout_then_failure ||
  [[ -n "$valid_output" ]]; then
  fail_test "failed command stdout must be discarded"
fi
pass_test "valid-looking stdout with exit 17 remains a hard failure"

now_epoch=2000
if reactivation_checkpoint_age_is_acceptable 1900 "$now_epoch" 100 &&
  ! reactivation_checkpoint_age_is_acceptable 1899 "$now_epoch" 100 &&
  ! reactivation_checkpoint_age_is_acceptable 2001 "$now_epoch" 100; then
  pass_test "checkpoint age is nonnegative and bounded by the rollout TTL"
else
  fail_test "checkpoint freshness contract"
fi

printf -v digest '%064d' 0
bot_runner_image="ghcr.io/yengalvez/bot-runner@sha256:$digest"
if reactivation_image_override_is_exact hubs "ghcr.io/yengalvez/hubs@sha256:$digest" &&
  reactivation_image_override_is_exact reticulum "ghcr.io/yengalvez/reticulum@sha256:$digest" &&
  reactivation_image_override_is_exact bot-orchestrator "ghcr.io/yengalvez/bot-orchestrator@sha256:$digest" &&
  reactivation_image_override_is_exact bot-runner "$bot_runner_image" &&
  reactivation_image_for_pair_is_trusted bot-runner/bot-runner "$bot_runner_image" &&
  ! reactivation_image_override_is_exact hubs "ghcr.io/yengalvez/hubs:latest" &&
  ! reactivation_image_override_is_exact hubs "ghcr.io/other/hubs@sha256:$digest"; then
  pass_test "image overrides require exact repository and 64-hex digest"
else
  fail_test "image override contract"
fi

if node "$ROOT_DIR/tests/scripts/bot-orchestrator-deployment.test.mjs"; then
  pass_test "bot parent Deployment verifier rejects unsafe fields and accepts only Kubernetes defaults"
else
  fail_test "bot parent Deployment contract"
fi

if node "$ROOT_DIR/tests/scripts/bot-runner-pods.test.mjs"; then
  pass_test "live runner Pod verifier rejects identity, HMAC, token, digest, security and TOCTOU drift"
else
  fail_test "live runner Pod verifier contract"
fi

if node "$ROOT_DIR/tests/scripts/bot-image-pull-config.test.mjs"; then
  pass_test "bot pull config verifier binds both images and both exact live Secrets/namespaces without disclosure"
else
  fail_test "bot image pull credential contract"
fi

deployments_good="$(jq -cn \
  --arg hubs "ghcr.io/yengalvez/hubs@sha256:$digest" \
  --arg reticulum "ghcr.io/yengalvez/reticulum@sha256:$digest" \
  --arg bot "ghcr.io/yengalvez/bot-orchestrator@sha256:$digest" \
  --arg runner "$bot_runner_image" '
  def item($name; $containers): {
    metadata:{name:$name},
    spec:{replicas:1,strategy:{type:"Recreate"},template:{spec:{initContainers:[],containers:$containers}}},
    status:{readyReplicas:1}
  };
  def image($name): "ghcr.io/yengalvez/" + $name + "@sha256:" + ("a" * 64);
  {items:[
    item("bot-orchestrator";[{name:"bot-orchestrator",image:$bot,
      env:[{name:"BOT_RUNNER_IMAGE",value:$runner}]}]),
    item("coturn";[{name:"coturn",image:image("coturn")}]),
    item("dialog";[{name:"dialog",image:image("dialog")}]),
    item("haproxy";[{name:"haproxy",image:image("haproxy")}]),
    item("hubs";[{name:"hubs",image:$hubs}]),
    item("nearspark";[{name:"nearspark",image:image("nearspark")}]),
    item("pgbouncer";[{name:"pgbouncer",image:image("pgbouncer")}]),
    item("pgbouncer-t";[{name:"pgbouncer-t",image:image("pgbouncer")}]),
    item("photomnemonic";[{name:"photomnemonic",image:image("photomnemonic")}]),
    item("pgsql";[{name:"pgsql",image:image("postgres")}]),
    item("reticulum";[{name:"postgrest",image:image("postgrest")},{name:"reticulum",image:$reticulum}]),
    item("spoke";[{name:"spoke",image:image("spoke")}])
  ]}
')"
deployments_evil_core="$(jq -c --arg image "ghcr.io/evil/hubs@sha256:$digest" '
  (.items[] | select(.metadata.name == "hubs") | .spec.template.spec.containers[] |
    select(.name == "hubs") | .image) = $image
' <<<"$deployments_good")"
deployments_with_init="$(jq -c '
  .items[0].spec.template.spec.initContainers = [{name:"stealer",image:("evil.invalid/init@sha256:" + ("b" * 64))}]
' <<<"$deployments_good")"
deployments_with_ephemeral="$(jq -c '
  .items[0].spec.template.spec.ephemeralContainers = [{name:"stealer",image:("evil.invalid/ephemeral@sha256:" + ("b" * 64))}]
' <<<"$deployments_good")"
deployments_two_bot_replicas="$(jq -c '
  (.items[] | select(.metadata.name == "bot-orchestrator") | .spec.replicas) = 2 |
  (.items[] | select(.metadata.name == "bot-orchestrator") | .status.readyReplicas) = 2
' <<<"$deployments_good")"
deployments_bot_rolling="$(jq -c '
  (.items[] | select(.metadata.name == "bot-orchestrator") | .spec.strategy.type) = "RollingUpdate"
' <<<"$deployments_good")"
deployments_two_reticulum_replicas="$(jq -c '
  (.items[] | select(.metadata.name == "reticulum") | .spec.replicas) = 2 |
  (.items[] | select(.metadata.name == "reticulum") | .status.readyReplicas) = 2
' <<<"$deployments_good")"
deployments_reticulum_residual_rolling="$(jq -c '
  (.items[] | select(.metadata.name == "reticulum") | .spec.strategy.rollingUpdate) = {maxSurge:1,maxUnavailable:0}
' <<<"$deployments_good")"
deployments_swapped_pair="$(jq -c '
  (.items[] | select(.metadata.name == "hubs") | .spec.template.spec.containers[0].name) = "reticulum"
' <<<"$deployments_good")"
deployments_extra="$(jq -c '.items += [.items[0] | .metadata.name = "rogue"]' <<<"$deployments_good")"
expected_deployment_images="$(jq -c '
  [.items[] as $deployment
    | $deployment.spec.template.spec.containers[]
    | {key:($deployment.metadata.name + "/" + .name), value:.image}]
  | from_entries
' <<<"$deployments_good")"
deployments_evil_noncore="$(jq -c --arg image "ghcr.io/evil/coturn@sha256:$digest" '
  (.items[] | select(.metadata.name == "coturn") | .spec.template.spec.containers[] |
    select(.name == "coturn") | .image) = $image
' <<<"$deployments_good")"
if reactivation_deployments_are_acceptable "$deployments_good" \
    "ghcr.io/yengalvez/hubs@sha256:$digest" \
    "ghcr.io/yengalvez/reticulum@sha256:$digest" \
    "ghcr.io/yengalvez/bot-orchestrator@sha256:$digest" \
    "$expected_deployment_images" "$bot_runner_image" &&
  ! reactivation_deployments_are_acceptable "$deployments_evil_core" \
    "ghcr.io/yengalvez/hubs@sha256:$digest" \
    "ghcr.io/yengalvez/reticulum@sha256:$digest" \
    "ghcr.io/yengalvez/bot-orchestrator@sha256:$digest" \
    "$expected_deployment_images" "$bot_runner_image" &&
  ! reactivation_deployments_are_acceptable "$deployments_evil_noncore" \
    "ghcr.io/yengalvez/hubs@sha256:$digest" \
    "ghcr.io/yengalvez/reticulum@sha256:$digest" \
    "ghcr.io/yengalvez/bot-orchestrator@sha256:$digest" \
    "$expected_deployment_images" "$bot_runner_image" &&
  ! reactivation_deployments_are_acceptable "$deployments_with_init" \
    "ghcr.io/yengalvez/hubs@sha256:$digest" \
    "ghcr.io/yengalvez/reticulum@sha256:$digest" \
    "ghcr.io/yengalvez/bot-orchestrator@sha256:$digest" \
    "$expected_deployment_images" "$bot_runner_image" &&
  ! reactivation_deployments_are_acceptable "$deployments_with_ephemeral" \
    "ghcr.io/yengalvez/hubs@sha256:$digest" \
    "ghcr.io/yengalvez/reticulum@sha256:$digest" \
    "ghcr.io/yengalvez/bot-orchestrator@sha256:$digest" \
    "$expected_deployment_images" "$bot_runner_image" &&
  ! reactivation_deployments_are_acceptable "$deployments_two_bot_replicas" \
    "ghcr.io/yengalvez/hubs@sha256:$digest" \
    "ghcr.io/yengalvez/reticulum@sha256:$digest" \
    "ghcr.io/yengalvez/bot-orchestrator@sha256:$digest" \
    "$expected_deployment_images" "$bot_runner_image" &&
  ! reactivation_deployments_are_acceptable "$deployments_bot_rolling" \
    "ghcr.io/yengalvez/hubs@sha256:$digest" \
    "ghcr.io/yengalvez/reticulum@sha256:$digest" \
    "ghcr.io/yengalvez/bot-orchestrator@sha256:$digest" \
    "$expected_deployment_images" "$bot_runner_image" &&
  ! reactivation_deployments_are_acceptable "$deployments_two_reticulum_replicas" \
    "ghcr.io/yengalvez/hubs@sha256:$digest" \
    "ghcr.io/yengalvez/reticulum@sha256:$digest" \
    "ghcr.io/yengalvez/bot-orchestrator@sha256:$digest" \
    "$expected_deployment_images" "$bot_runner_image" &&
  ! reactivation_deployments_are_acceptable "$deployments_reticulum_residual_rolling" \
    "ghcr.io/yengalvez/hubs@sha256:$digest" \
    "ghcr.io/yengalvez/reticulum@sha256:$digest" \
    "ghcr.io/yengalvez/bot-orchestrator@sha256:$digest" \
    "$expected_deployment_images" "$bot_runner_image" &&
  ! reactivation_deployments_are_acceptable "$deployments_swapped_pair" \
    "ghcr.io/yengalvez/hubs@sha256:$digest" \
    "ghcr.io/yengalvez/reticulum@sha256:$digest" \
    "ghcr.io/yengalvez/bot-orchestrator@sha256:$digest" \
    "$expected_deployment_images" "$bot_runner_image" &&
  ! reactivation_deployments_are_acceptable "$deployments_extra" \
    "ghcr.io/yengalvez/hubs@sha256:$digest" \
    "ghcr.io/yengalvez/reticulum@sha256:$digest" \
    "ghcr.io/yengalvez/bot-orchestrator@sha256:$digest" \
    "$expected_deployment_images" "$bot_runner_image"; then
  pass_test "live deployment inventory binds all 13 candidate images and rejects overlap, init/ephemeral containers, replica drift, pair swaps and extras"
else
  fail_test "exact live deployment inventory contract"
fi

deployments_legacy="$(jq -c '
  (.items[] | select(.metadata.name == "pgsql") |
    .spec.template.spec.containers[0].name) = "postgresql" |
  (.items[] | select(.metadata.name == "bot-orchestrator") |
    .spec.template.spec.containers[0].env) = []
' <<<"$deployments_good")"
expected_legacy_images="$(jq -c '
  with_entries(if .key == "pgsql/pgsql" then .key = "pgsql/postgresql" else . end)
' <<<"$expected_deployment_images")"
deployments_legacy_with_runner_env="$(jq -c --arg runner "$bot_runner_image" '
  (.items[] | select(.metadata.name == "bot-orchestrator") |
    .spec.template.spec.containers[0].env) = [{name:"BOT_RUNNER_IMAGE",value:$runner}]
' <<<"$deployments_legacy")"
if reactivation_runner_image_matches_profile durable-active "$bot_runner_image" &&
   reactivation_runner_image_matches_profile cold-rebind-legacy-absent-v1 No &&
   ! reactivation_runner_image_matches_profile durable-active No &&
   ! reactivation_runner_image_matches_profile \
     cold-rebind-legacy-absent-v1 "$bot_runner_image" &&
   reactivation_deployments_are_acceptable "$deployments_legacy" \
     "ghcr.io/yengalvez/hubs@sha256:$digest" \
     "ghcr.io/yengalvez/reticulum@sha256:$digest" \
     "ghcr.io/yengalvez/bot-orchestrator@sha256:$digest" \
     "$expected_legacy_images" No cold-rebind-legacy-absent-v1 &&
   ! reactivation_deployments_are_acceptable "$deployments_legacy_with_runner_env" \
     "ghcr.io/yengalvez/hubs@sha256:$digest" \
     "ghcr.io/yengalvez/reticulum@sha256:$digest" \
     "ghcr.io/yengalvez/bot-orchestrator@sha256:$digest" \
     "$expected_legacy_images" No cold-rebind-legacy-absent-v1; then
  pass_test "legacy live inventory requires postgresql, runner image No and no durable parent binding"
else
  fail_test "legacy deployment inventory profile"
fi

reticulum_singleton="$(jq -cn '
  {apiVersion:"apps/v1",kind:"Deployment",
   metadata:{name:"reticulum",namespace:"hcce",uid:"reticulum-uid"},
   spec:{replicas:1,strategy:{type:"Recreate"},selector:{matchLabels:{app:"reticulum"}},
     template:{metadata:{labels:{app:"reticulum"}}}}}
')"
reticulum_hpas_clear='{"items":[{"spec":{"scaleTargetRef":{"apiVersion":"apps/v1","kind":"Deployment","name":"hubs"}}}]}'
reticulum_hpa_targeted='{"items":[{"spec":{"scaleTargetRef":{"apiVersion":"apps/v1","kind":"Deployment","name":"reticulum"}}}]}'
if reactivation_reticulum_deployment_is_singleton "$reticulum_singleton" &&
  ! reactivation_reticulum_deployment_is_singleton "$(jq -c '.spec.replicas = 2' <<<"$reticulum_singleton")" &&
  ! reactivation_reticulum_deployment_is_singleton "$(jq -c '.spec.strategy.rollingUpdate = {maxSurge:1}' <<<"$reticulum_singleton")" &&
  reactivation_hpas_do_not_target_reticulum "$reticulum_hpas_clear" &&
  ! reactivation_hpas_do_not_target_reticulum "$reticulum_hpa_targeted" &&
  grep -Eq 'recovery_require_pod_deployment_ownership.*reticulum' "$ROOT_DIR/deployment/preflight-reactivation.sh" &&
  grep -Eq 'recovery_require_pod_deployment_ownership.*reticulum' "$ROOT_DIR/deployment/verify-live-reactivation.sh" &&
  grep -Eq 'reticulum_deployment_uid' "$ROOT_DIR/deployment/preflight-reactivation.sh" &&
  grep -Eq 'reticulum_deployment_uid' "$ROOT_DIR/deployment/verify-live-reactivation.sh"; then
  pass_test "Reticulum authority is singleton, Recreate-only, HPA-free and pod UID/owner checked in both root gates"
else
  fail_test "Reticulum singleton authority contract"
fi

bot_control_plane_good="$(jq -cn '
  {
    parent_service_account:{apiVersion:"v1",kind:"ServiceAccount",
      metadata:{name:"bot-orchestrator",namespace:"hcce"},
      automountServiceAccountToken:true,imagePullSecrets:[{name:"bot-images-pull"}]},
    runner_service_account:{apiVersion:"v1",kind:"ServiceAccount",
      metadata:{name:"bot-runner",namespace:"hcce"},
      automountServiceAccountToken:false,imagePullSecrets:[{name:"bot-images-pull"}]},
    parent_role:{apiVersion:"rbac.authorization.k8s.io/v1",kind:"Role",
      metadata:{name:"bot-orchestrator-runner-pods",namespace:"hcce"},
      rules:[{apiGroups:[""],resources:["pods"],verbs:["create","delete","get","list"]}]},
    parent_role_binding:{apiVersion:"rbac.authorization.k8s.io/v1",kind:"RoleBinding",
      metadata:{name:"bot-orchestrator-runner-pods",namespace:"hcce"},
      roleRef:{apiGroup:"rbac.authorization.k8s.io",kind:"Role",name:"bot-orchestrator-runner-pods"},
      subjects:[{kind:"ServiceAccount",name:"bot-orchestrator",namespace:"hcce"}]}
  }
')"
bot_control_extra_verb="$(jq -c '.parent_role.rules[0].verbs += ["watch"]' <<<"$bot_control_plane_good")"
bot_control_runner_token="$(jq -c '.runner_service_account.automountServiceAccountToken = true' <<<"$bot_control_plane_good")"
bot_control_extra_pull="$(jq -c '.runner_service_account.imagePullSecrets += [{name:"rogue"}]' <<<"$bot_control_plane_good")"
bot_control_extra_subject="$(jq -c '.parent_role_binding.subjects += [{kind:"ServiceAccount",name:"rogue",namespace:"hcce"}]' <<<"$bot_control_plane_good")"
bot_control_bad_ref="$(jq -c '.parent_role_binding.roleRef.name = "cluster-admin"' <<<"$bot_control_plane_good")"
if reactivation_bot_control_plane_is_acceptable "$bot_control_plane_good" hcce &&
  ! reactivation_bot_control_plane_is_acceptable "$bot_control_extra_verb" hcce &&
  ! reactivation_bot_control_plane_is_acceptable "$bot_control_runner_token" hcce &&
  ! reactivation_bot_control_plane_is_acceptable "$bot_control_extra_pull" hcce &&
  ! reactivation_bot_control_plane_is_acceptable "$bot_control_extra_subject" hcce &&
  ! reactivation_bot_control_plane_is_acceptable "$bot_control_bad_ref" hcce &&
  grep -Eq 'deletecollection pods' "$ROOT_DIR/deployment/verify-live-reactivation.sh" &&
  grep -Eq 'create pods/exec' "$ROOT_DIR/deployment/verify-live-reactivation.sh" &&
  grep -Eq 'watch secrets' "$ROOT_DIR/deployment/verify-live-reactivation.sh"; then
  pass_test "runner control plane rejects extra grants, token mounts, pull secrets, subjects and role refs"
else
  fail_test "runner control-plane and effective RBAC contract"
fi

reticulum_health_controller="${RETICULUM_HEALTH_CONTROLLER_PATH:-$ROOT_DIR/hubs-cloud/community-edition/services/reticulum/lib/ret_web/controllers/health_controller.ex}"
reticulum_router="${RETICULUM_ROUTER_PATH:-$ROOT_DIR/hubs-cloud/community-edition/services/reticulum/lib/ret_web/router.ex}"
if ! grep -Eqi 'reservation[- ]v1|reservation v1|Reticulum v1|Hubs v1' \
    "$ROOT_DIR/deployment/README.md" &&
   grep -Eq 'protocol 2' "$ROOT_DIR/deployment/README.md" &&
   grep -Eq 'state_version' "$ROOT_DIR/deployment/README.md" &&
   grep -Eq 'snapshot_state_version' "$ROOT_DIR/deployment/README.md" &&
   grep -Eq '/health/capabilities' "$ROOT_DIR/deployment/README.md" &&
   grep -Eq 'deployment/reticulum :4000' "$ROOT_DIR/deployment/verify-live-reactivation.sh" &&
   grep -Eq 'reactivation_sitting_capabilities_are_acceptable' "$ROOT_DIR/deployment/verify-live-reactivation.sh" &&
   grep -Eq 'WaypointReservation.capability_contract' "$reticulum_health_controller" &&
   grep -Eq 'get "/capabilities", HealthController, :capabilities' "$reticulum_router"; then
  pass_test "deployment and live gates negotiate the real protocol-2 capability endpoint"
else
  fail_test "deployment sitting protocol 2 capability contract"
fi

network_policies_good="$(jq -cn '
  def ingress($name; $target; $sources; $port): {
    metadata:{name:$name},
    spec:{
      podSelector:{matchLabels:{app:$target}},
      policyTypes:["Ingress"],
      ingress:[{from:[$sources[] | {podSelector:{matchLabels:{app:.}}}],ports:[{port:$port,protocol:"TCP"}]}]
    }
  };
  def internet_excludes:
    ["0.0.0.0/8","10.0.0.0/8","100.64.0.0/10","127.0.0.0/8",
     "169.254.0.0/16","172.16.0.0/12","192.0.0.0/24","192.0.2.0/24",
     "192.168.0.0/16","198.18.0.0/15","198.51.100.0/24","203.0.113.0/24",
     "224.0.0.0/4","240.0.0.0/4"];
  {items:[
    {
      metadata:{name:"bot-orchestrator-ingress"},
      spec:{
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
          ports:[{port:5001,protocol:"TCP"}]
        }]
      }
    },
    ingress("pgbouncer-ingress";"pgbouncer";["reticulum"];5432),
    ingress("pgbouncer-t-ingress";"pgbouncer-t";["reticulum"];5432),
    ingress("pgsql-ingress";"pgsql";["pgbouncer","pgbouncer-t"];5432),
    ingress("photomnemonic-ingress";"photomnemonic";["reticulum"];5000),
    {
      metadata:{name:"photomnemonic-egress"},
      spec:{
        podSelector:{matchLabels:{app:"photomnemonic"}},
        policyTypes:["Egress"],
        egress:[
          {
            to:[{namespaceSelector:{matchLabels:{"kubernetes.io/metadata.name":"kube-system"}},podSelector:{matchLabels:{"k8s-app":"kube-dns"}}}],
            ports:[{port:53,protocol:"UDP"},{port:53,protocol:"TCP"}]
          },
          {
            to:[{ipBlock:{cidr:"0.0.0.0/0",except:internet_excludes}}],
            ports:[{port:80,protocol:"TCP"},{port:443,protocol:"TCP"}]
          }
        ]
      }
    }
  ]}
')"
network_extra_policy="$(jq -c '.items += [.items[0] | .metadata.name = "rogue-ingress"]' <<<"$network_policies_good")"
network_extra_rule="$(jq -c '
  (.items[] | select(.metadata.name == "pgsql-ingress") | .spec.ingress) += [{from:[],ports:[]}]
' <<<"$network_policies_good")"
network_broad_peer="$(jq -c '
  (.items[] | select(.metadata.name == "pgbouncer-ingress") | .spec.ingress[0].from) += [{namespaceSelector:{}}]
' <<<"$network_policies_good")"
network_extra_egress="$(jq -c '
  (.items[] | select(.metadata.name == "photomnemonic-egress") | .spec.egress) += [{to:[]}]
' <<<"$network_policies_good")"
if reactivation_network_policies_are_exact "$network_policies_good" &&
  ! reactivation_network_policies_are_exact "$network_extra_policy" &&
  ! reactivation_network_policies_are_exact "$network_extra_rule" &&
  ! reactivation_network_policies_are_exact "$network_broad_peer" &&
  ! reactivation_network_policies_are_exact "$network_extra_egress"; then
  pass_test "six-policy parent inventory binds cross-namespace runner ingress and rejects extras"
else
  fail_test "exact global NetworkPolicy inventory contract"
fi
network_policies_legacy="$(jq -c '
  .items |= map(select(.metadata.name != "bot-orchestrator-ingress"))
' <<<"$network_policies_good")"
if reactivation_network_policies_are_exact \
     "$network_policies_legacy" cold-rebind-legacy-absent-v1 &&
   ! reactivation_network_policies_are_exact \
     "$network_policies_good" cold-rebind-legacy-absent-v1 &&
   ! reactivation_network_policies_are_exact \
     "$network_policies_legacy" durable-active; then
  pass_test "legacy NetworkPolicy profile requires durable runner ingress to be absent"
else
  fail_test "legacy NetworkPolicy inventory contract"
fi

legacy_pull_encoded='eyJhdXRocyI6eyJnaGNyLmlvIjp7ImF1dGgiOiJmaXh0dXJlIn19fQ=='
legacy_pull_secret="$(jq -cn --arg encoded "$legacy_pull_encoded" '
  {apiVersion:"v1",kind:"Secret",
   metadata:{name:"bot-images-pull",namespace:"hcce"},
   type:"kubernetes.io/dockerconfigjson",data:{".dockerconfigjson":$encoded}}
')"
if reactivation_legacy_pull_secret_is_acceptable \
     "$legacy_pull_secret" hcce "$legacy_pull_encoded" &&
   ! reactivation_legacy_pull_secret_is_acceptable \
     "$legacy_pull_secret" hcce-bot-runners "$legacy_pull_encoded" &&
   ! reactivation_legacy_pull_secret_is_acceptable \
     "$(jq -c '.data.extra = "rogue"' <<<"$legacy_pull_secret")" \
     hcce "$legacy_pull_encoded"; then
  pass_test "legacy primary Pull Secret is exact without accepting a runner-namespace Secret"
else
  fail_test "legacy primary Pull Secret contract"
fi
if (
     recovery_require_live_process_local_cold_rebind_target_exact() {
       [[ "$1" == /private/values.yaml ]]
     }
     recovery_runner_isolation_residual_state() { printf 'absent\n'; }
     recovery_require_no_managed_bot_runner_pods() { return 0; }
     reactivation_legacy_live_runtime_is_exact \
       /private/values.yaml hcce "$legacy_pull_secret" "$legacy_pull_encoded"
   ) &&
   ! (
     recovery_require_live_process_local_cold_rebind_target_exact() { return 0; }
     recovery_runner_isolation_residual_state() { printf 'present\n'; }
     recovery_require_no_managed_bot_runner_pods() { return 0; }
     reactivation_legacy_live_runtime_is_exact \
       /private/values.yaml hcce "$legacy_pull_secret" "$legacy_pull_encoded"
   ) &&
   [[ "$(grep -Fc 'reactivation_legacy_live_runtime_is_exact' \
     "$ROOT_DIR/deployment/verify-live-reactivation.sh")" == 2 ]]; then
  pass_test "real live legacy branch requires exact process-local state and rejects durable residue"
else
  fail_test "real live legacy profile branch"
fi

parser_values="$temp_root/parser-values.yaml"
printf '%s\n' \
  '---' \
  '# comment' \
  '' \
  'PLAIN: value # comment' \
  'SINGLE: '\''value # retained'\''' \
  'DOUBLE: "value # retained"' \
  'EMPTY:' \
  'COMMENT_ONLY: # intentionally blank' >"$parser_values"
if node "$ROOT_DIR/deployment/parse-local-values.mjs" "$parser_values" --validate &&
  [[ "$(node "$ROOT_DIR/deployment/parse-local-values.mjs" "$parser_values" --get PLAIN)" == value ]] &&
  [[ "$(node "$ROOT_DIR/deployment/parse-local-values.mjs" "$parser_values" --get SINGLE)" == 'value # retained' ]] &&
  [[ "$(node "$ROOT_DIR/deployment/parse-local-values.mjs" "$parser_values" --get DOUBLE)" == 'value # retained' ]] &&
  [[ -z "$(node "$ROOT_DIR/deployment/parse-local-values.mjs" "$parser_values" --get COMMENT_ONLY)" ]] &&
  [[ "$(node "$ROOT_DIR/deployment/parse-local-values.mjs" "$parser_values" --keys)" == *'COMMENT_ONLY=missing'* ]] &&
  [[ "$(node "$ROOT_DIR/deployment/parse-local-values.mjs" "$parser_values" --keys)" != *'value # retained'* ]]; then
  pass_test "safe values parser handles blanks, comments and quotes without key-status leakage"
else
  fail_test "safe values parser"
fi
printf 'NO_SPACE:#not-a-safe-mapping-comment\n' >"$parser_values"
if node "$ROOT_DIR/deployment/parse-local-values.mjs" "$parser_values" --validate >/dev/null 2>&1; then
  fail_test "safe values parser rejects KEY:#comment ambiguity"
fi
pass_test "safe values parser treats spaced comment-only values as blank and rejects KEY:#comment"
printf 'ESCAPED_CONTROL: "secret\\ncontinuation"\n' >"$parser_values"
if node "$ROOT_DIR/deployment/parse-local-values.mjs" "$parser_values" --validate >/dev/null 2>&1; then
  fail_test "safe values parser rejects escaped control characters"
fi
printf 'ADJACENT_COMMENT: "value"#ambiguous\n' >"$parser_values"
if node "$ROOT_DIR/deployment/parse-local-values.mjs" "$parser_values" --validate >/dev/null 2>&1; then
  fail_test "safe values parser requires whitespace before quoted comments"
fi
pass_test "safe values parser rejects decoded controls and ambiguous quoted comments"
printf '%s\n' 'KEY: value' '---' >"$parser_values"
if node "$ROOT_DIR/deployment/parse-local-values.mjs" "$parser_values" --validate >/dev/null 2>&1; then
  fail_test "safe values parser rejects an internal document start marker"
fi
printf '%s\n' '# leading comment' '---' 'KEY: value' >"$parser_values"
if node "$ROOT_DIR/deployment/parse-local-values.mjs" "$parser_values" --validate >/dev/null 2>&1; then
  fail_test "safe values parser rejects a document marker after a comment"
fi
printf '\n%s\n' '---' 'KEY: value' >"$parser_values"
if node "$ROOT_DIR/deployment/parse-local-values.mjs" "$parser_values" --validate >/dev/null 2>&1; then
  fail_test "safe values parser rejects a document marker after a blank line"
fi
printf '%s\n' '---' '---' 'KEY: value' >"$parser_values"
if node "$ROOT_DIR/deployment/parse-local-values.mjs" "$parser_values" --validate >/dev/null 2>&1; then
  fail_test "safe values parser rejects duplicate document start markers"
fi
printf '%s\n' '--- # comment' 'KEY: value' >"$parser_values"
if node "$ROOT_DIR/deployment/parse-local-values.mjs" "$parser_values" --validate >/dev/null 2>&1; then
  fail_test "safe values parser rejects non-exact document start markers"
fi
printf '%s\n' '...' 'KEY: value' >"$parser_values"
if node "$ROOT_DIR/deployment/parse-local-values.mjs" "$parser_values" --validate >/dev/null 2>&1; then
  fail_test "safe values parser rejects document end markers"
fi
printf '%s\r\n' '---' 'KEY: value' >"$parser_values"
if ! node "$ROOT_DIR/deployment/parse-local-values.mjs" "$parser_values" --validate; then
  fail_test "safe values parser accepts an exact CRLF document start"
fi
printf '%s' '---' >"$parser_values"
if node "$ROOT_DIR/deployment/parse-local-values.mjs" "$parser_values" --validate >/dev/null 2>&1; then
  fail_test "safe values parser rejects a marker without a line ending"
fi
pass_test "safe values parser accepts one exact first-line document start and rejects multi-document variants"

printf '%s\n' \
  'PERMS_KEY: |' \
  '  legacy-line-one' \
  '  Zml4dHVyZQ==' \
  '  legacy-line-three' \
  'NEXT_KEY: preserved' >"$parser_values"
literal_perms_key="$(node "$ROOT_DIR/deployment/parse-local-values.mjs" \
  "$parser_values" --get PERMS_KEY)"
if node "$ROOT_DIR/deployment/parse-local-values.mjs" "$parser_values" --validate &&
  [[ "$literal_perms_key" == 'legacy-line-one\nZml4dHVyZQ==\nlegacy-line-three\n' ]] &&
  [[ "$(node "$ROOT_DIR/deployment/parse-local-values.mjs" \
    "$parser_values" --get NEXT_KEY)" == preserved ]]; then
  pass_test "safe values parser canonicalizes the exact legacy PERMS_KEY literal block"
else
  fail_test "exact legacy PERMS_KEY literal block compatibility"
fi
printf '%s\r\n' \
  'PERMS_KEY: |' \
  '  legacy-line-one' \
  '  Zml4dHVyZQ==' \
  '  legacy-line-three' \
  'NEXT_KEY: preserved' >"$parser_values"
if ! node "$ROOT_DIR/deployment/parse-local-values.mjs" "$parser_values" --validate; then
  fail_test "safe values parser accepts a coherent CRLF legacy PERMS_KEY block"
fi
invalid_literal_blocks=(
  $'OTHER_KEY: |\n  value\n'
  $'PERMS_KEY: |-\n  value\n'
  $'PERMS_KEY: |+\n  value\n'
  $'PERMS_KEY: |2\n  value\n'
  $'PERMS_KEY: >\n  value\n'
  $'PERMS_KEY: | # comment\n  value\n'
  $'PERMS_KEY: |\n'
  $'PERMS_KEY: |\n value\n'
  $'PERMS_KEY: |\n   value\n'
  $'PERMS_KEY: |\n\tvalue\n'
  $'PERMS_KEY: |\n  \n'
  $'PERMS_KEY: |\n  value \n'
  $'PERMS_KEY: |\n  value\x01\n'
  $'PERMS_KEY: |\r\n  value\n'
  $'PERMS_KEY: |\n  value\nPERMS_KEY: "duplicate"\n'
)
for invalid_literal_block in "${invalid_literal_blocks[@]}"; do
  printf '%s' "$invalid_literal_block" >"$parser_values"
  if node "$ROOT_DIR/deployment/parse-local-values.mjs" \
      "$parser_values" --validate >/dev/null 2>&1; then
    fail_test "safe values parser rejects a non-exact legacy literal block"
  fi
done
printf -v literal_line_256 '%0256d' 0
printf '%s\n' 'PERMS_KEY: |' "  $literal_line_256" >"$parser_values"
if ! node "$ROOT_DIR/deployment/parse-local-values.mjs" \
    "$parser_values" --validate; then
  fail_test "safe values parser accepts the exact legacy literal line-size boundary"
fi
printf -v literal_line_257 '%0257d' 0
printf '%s\n' 'PERMS_KEY: |' "  $literal_line_257" >"$parser_values"
if node "$ROOT_DIR/deployment/parse-local-values.mjs" \
    "$parser_values" --validate >/dev/null 2>&1; then
  fail_test "safe values parser rejects a legacy literal line above its limit"
fi
{
  printf '%s\n' 'PERMS_KEY: |'
  for ((literal_line = 0; literal_line < 129; literal_line += 1)); do
    printf '%s\n' '  bounded-fixture-line'
  done
} >"$parser_values"
if node "$ROOT_DIR/deployment/parse-local-values.mjs" \
    "$parser_values" --validate >/dev/null 2>&1; then
  fail_test "safe values parser rejects an oversized legacy literal block"
fi
pass_test "safe values parser rejects every other block form, unsafe indentation and mixed endings"

printf 'DUP: first-secret\nDUP: second-secret\n' >"$parser_values"
set +e
parser_error="$(node "$ROOT_DIR/deployment/parse-local-values.mjs" "$parser_values" --validate 2>&1)"
parser_status=$?
set -e
if [[ "$parser_status" -ne 0 && "$parser_error" == *'duplicate key'* &&
      "$parser_error" != *'first-secret'* && "$parser_error" != *'second-secret'* ]]; then
  pass_test "safe values parser rejects duplicate keys without printing values"
else
  fail_test "duplicate YAML key rejection"
fi

if node "$ROOT_DIR/deployment/parse-local-values.mjs" \
     "$ROOT_DIR/deployment/input-values.example.yaml" --validate &&
   example_perms_key="$(node "$ROOT_DIR/deployment/parse-local-values.mjs" \
     "$ROOT_DIR/deployment/input-values.example.yaml" --get PERMS_KEY)" &&
   [[ "$example_perms_key" == '-----BEGIN PRIVATE KEY-----\nCHANGE_ME_BASE64_BODY\n-----END PRIVATE KEY-----\n' ]]; then
  pass_test "tracked values example is accepted by the safe parser and preserves escaped PEM newlines"
else
  fail_test "tracked values example must be usable by the safe parser"
fi

# The dollar-prefixed name below is the literal source contract, not a shell expansion.
# shellcheck disable=SC2016
if grep -Fn '|| true' "$ROOT_DIR/deployment/preflight-reactivation.sh" \
    "$ROOT_DIR/deployment/verify-live-reactivation.sh" >/dev/null ||
  grep -En 'output/latest-backup-path|output/checkpoints.*tail -1' \
    "$ROOT_DIR/deployment/preflight-reactivation.sh" >/dev/null ||
  ! grep -Eq 'BACKUP_DIR debe señalar explicitamente' "$ROOT_DIR/deployment/preflight-reactivation.sh" ||
  ! grep -Fq '"pod/$runner_parent_name" :5001' "$ROOT_DIR/deployment/verify-live-reactivation.sh" ||
  ! grep -Eq 'kill -0.*port_forward_pid' "$ROOT_DIR/deployment/verify-live-reactivation.sh"; then
  fail_test "preflight/live scripts retain forbidden masking, implicit backup or unpinned listener"
fi
pass_test "preflight requires an explicit backup and live verification pins an owned Pod with an ephemeral port"

deployment_refresh_line="$(grep -nF 'recovery_kubectl get deployment bot-orchestrator' \
  "$ROOT_DIR/deployment/verify-live-reactivation.sh" | tail -1 | cut -d: -f1)"
# The dollar-prefixed name is the literal source contract under inspection.
# shellcheck disable=SC2016
parent_refresh_line="$(grep -nF 'recovery_kubectl get pod "$runner_parent_name"' \
  "$ROOT_DIR/deployment/verify-live-reactivation.sh" | tail -1 | cut -d: -f1)"
runner_verifier_line="$(grep -nF 'verify_final_runner_profile_snapshot; then' \
  "$ROOT_DIR/deployment/verify-live-reactivation.sh" | tail -1 | cut -d: -f1)"
if [[ ! "$deployment_refresh_line" =~ ^[0-9]+$ ||
      ! "$parent_refresh_line" =~ ^[0-9]+$ ||
      ! "$runner_verifier_line" =~ ^[0-9]+$ ||
      "$deployment_refresh_line" -ge "$parent_refresh_line" ||
      "$parent_refresh_line" -ge "$runner_verifier_line" ]]; then
  fail_test "live runner gate must refresh Deployment and parent Pod immediately before verification"
fi
pass_test "live runner gate refreshes Deployment and parent Pod before the profile-exact final verifier"

live_gate_path="$ROOT_DIR/deployment/verify-live-reactivation.sh"
runner_capture_call="$(awk '
  /^capture_bot_runner_pods\(\)/ { capture=1 }
  capture { print }
  capture && /^}/ { exit }
' "$live_gate_path")"
pull_verifier_call="$(awk '
  /node .*verify-bot-image-pull-config\.mjs/ { capture=1 }
  capture { print }
  capture && /--verify-registry; then/ { exit }
' "$live_gate_path")"
orchestrator_verifier_call="$(awk '
  /node .*verify-bot-orchestrator-deployment\.mjs/ { capture=1 }
  capture { print }
  capture && /--deployment .*; then/ { exit }
' "$live_gate_path")"
runner_pods_verifier_call="$(awk '
  /node .*verify-bot-runner-pods\.mjs/ { capture=1 }
  capture { print }
  capture && /--readiness .*; then/ { exit }
' "$live_gate_path")"
# These dollar-prefixed names are literal callsite contracts under inspection.
# shellcheck disable=SC2016
if ! grep -Fq 'RUNNER_NAMESPACE="hcce-bot-runners"' "$live_gate_path" ||
   [[ "$runner_capture_call" != *'recovery_kubectl_get_namespaced_list pods "$RUNNER_NAMESPACE"'* ]] ||
   [[ "$runner_capture_call" == *'-l app=bot-runner'* ||
      "$runner_capture_call" == *'-l yenhubs.org/managed-by=bot-orchestrator'* ]] ||
   [[ "$pull_verifier_call" != *'--secret "$bot_pull_secret_file" --namespace "$NAMESPACE"'* ]] ||
   [[ "$pull_verifier_call" != *'--runner-secret "$bot_runner_pull_secret_file" --runner-namespace "$RUNNER_NAMESPACE"'* ]] ||
   [[ "$pull_verifier_call" != *'--deployments "$bot_deployments_file" --verify-registry'* ]] ||
   [[ "$orchestrator_verifier_call" != *'--namespace "$NAMESPACE"'* ||
      "$orchestrator_verifier_call" != *'--runner-namespace "$RUNNER_NAMESPACE"'* ]] ||
   [[ "$runner_pods_verifier_call" != *'--namespace "$NAMESPACE"'* ||
      "$runner_pods_verifier_call" != *'--runner-namespace "$RUNNER_NAMESPACE"'* ]]; then
  fail_test "live bot verifier callsites must pass both namespaces, both Secrets and registry proof"
fi
pass_test "live bot verifier callsites use all dedicated runner Pods and the complete CLI contracts"

# Dollar-prefixed names below are literal source contracts under inspection.
# shellcheck disable=SC2016
if ! grep -Fq '"create serviceaccounts/token"' "$live_gate_path" ||
   ! grep -Fq '"update pods/ephemeralcontainers"' "$live_gate_path" ||
   ! grep -Fq '"create pods/eviction"' "$live_gate_path" ||
   ! grep -Fq '"bind roles" "escalate roles"' "$live_gate_path" ||
   ! grep -Fq '"impersonate users" "impersonate groups" "impersonate serviceaccounts"' \
     "$live_gate_path" ||
   ! grep -Fq '"$NAMESPACE bot-orchestrator $RUNNER_NAMESPACE parent-runner"' \
     "$live_gate_path" ||
   ! grep -Fq '"$RUNNER_NAMESPACE bot-runner $NAMESPACE runner-parent"' \
     "$live_gate_path"; then
  fail_test "live RBAC gate must deny escalation and mutation for both identities in both namespaces"
fi
pass_test "live RBAC callsite covers mutation, escalation, impersonation and both namespace directions"

preflight_bin="$temp_root/preflight-bin"
mkdir -p "$preflight_bin"
cat >"$preflight_bin/doctl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == account\ get* ]]; then exit 0; fi
if [[ "$*" == kubernetes\ cluster\ list* ]]; then
  printf '%s\n' '[{"id":"cluster-id","name":"hubs-ce","region":"ams3","status":{"state":"running"},"ha":false,"node_pools":[{"size":"s-4vcpu-8gb","count":1}]}]'
  [[ "${PREFLIGHT_STUB_MODE:-}" != doctl-error ]] || exit 17
  exit 0
fi
if [[ "$*" == compute\ volume\ list* || "$*" == compute\ load-balancer\ list* ]]; then printf '[]\n'; exit 0; fi
exit 90
STUB
cat >"$preflight_bin/kubectl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == 'config current-context' ]]; then
  printf 'fixture-context'
  [[ "${PREFLIGHT_STUB_MODE:-}" != kubectl-error ]] || exit 17
  exit 0
fi
if [[ "${1:-}" == --context ]]; then shift 2; fi
if [[ "$*" == get\ namespace\ * ]]; then printf 'fixture-uid'; exit 0; fi
exit 90
STUB
chmod 700 "$preflight_bin/doctl" "$preflight_bin/kubectl"

set +e
preflight_existing_output="$(env PATH="$preflight_bin:$PATH" VALUES_FILE="$temp_root/absent-values" BACKUP_DIR="$temp_root/absent-checkpoint" "$ROOT_DIR/deployment/preflight-reactivation.sh" 2>&1)"
preflight_existing_status=$?
preflight_doctl_error_output="$(env PATH="$preflight_bin:$PATH" PREFLIGHT_STUB_MODE=doctl-error VALUES_FILE="$temp_root/absent-values" BACKUP_DIR="$temp_root/absent-checkpoint" "$ROOT_DIR/deployment/preflight-reactivation.sh" 2>&1)"
preflight_doctl_error_status=$?
preflight_kubectl_error_output="$(env PATH="$preflight_bin:$PATH" PREFLIGHT_STUB_MODE=kubectl-error EXPECTED_KUBE_CONTEXT=fixture-context EXPECTED_NAMESPACE_UID=fixture-uid VALUES_FILE="$temp_root/absent-values" BACKUP_DIR="$temp_root/absent-checkpoint" "$ROOT_DIR/deployment/preflight-reactivation.sh" 2>&1)"
preflight_kubectl_error_status=$?
set -e
if [[ "$preflight_existing_status" -ne 0 && "$preflight_existing_output" == *'cluster existe pero faltan EXPECTED_KUBE_CONTEXT/EXPECTED_NAMESPACE_UID'* &&
      "$preflight_doctl_error_status" -ne 0 && "$preflight_doctl_error_output" == *'doctl no pudo enumerar clusters de forma valida'* &&
      "$preflight_kubectl_error_status" -ne 0 && "$preflight_kubectl_error_output" == *'identidad Kubernetes no coincide o no puede leerse'* ]]; then
  pass_test "preflight treats existing-cluster identity gaps and valid stdout with nonzero rc as fatal"
else
  fail_test "preflight fail-closed cluster probes"
fi

mode_file="$temp_root/values.yaml"
: >"$mode_file"
chmod 600 "$mode_file"
reactivation_values_file_is_private "$mode_file" || fail_test "mode 600 accepted"
chmod 640 "$mode_file"
if reactivation_values_file_is_private "$mode_file"; then
  fail_test "mode 640 rejected"
fi
unsafe_snapshot=""
if reactivation_snapshot_private_file unsafe_snapshot "$mode_file"; then
  fail_test "snapshot helper rejects mode 640 independently"
fi
[[ -z "$unsafe_snapshot" ]] || fail_test "failed snapshot leaves destination untouched"
pass_test "local values and snapshot source mode must be exactly 600"

snapshot_source="$temp_root/private-values-source.yaml"
snapshot_record="$temp_root/private-values-snapshot-path"
printf 'MARKER: before\n' >"$snapshot_source"
chmod 600 "$snapshot_source"
if bash -c '
  set -euo pipefail
  source "$1"
  reactivation_install_cleanup_traps
  snapshot=""
  reactivation_snapshot_private_file snapshot "$2"
  printf "%s\n" "$snapshot" >"$3"
  printf "MARKER: after\n" >"$2"
  [[ "$snapshot" != "$2" ]]
  [[ "$(reactivation_file_mode "$snapshot")" == 600 ]]
  [[ "$(cat "$snapshot")" == "MARKER: before" ]]
' _ "$ROOT_DIR/deployment/lib/reactivation-gate-functions.sh" "$snapshot_source" "$snapshot_record"; then
  snapshotted_path="$(cat "$snapshot_record")"
  [[ ! -e "$snapshotted_path" ]] || fail_test "private values snapshot cleanup ownership"
  [[ "$(cat "$snapshot_source")" == 'MARKER: after' ]] || fail_test "private values source mutation fixture"
  pass_test "values gates parse an immutable private snapshot and clean only their owned copy"
else
  fail_test "private values snapshot contract"
fi

snapshot_real_dir="$temp_root/snapshot-real-directory"
mkdir "$snapshot_real_dir"
printf 'PRIVATE: linked-component\n' >"$snapshot_real_dir/values.yaml"
chmod 600 "$snapshot_real_dir/values.yaml"
ln -s "$snapshot_real_dir" "$temp_root/snapshot-linked-directory"
linked_snapshot=""
if reactivation_snapshot_private_file linked_snapshot \
  "$temp_root/snapshot-linked-directory/values.yaml" >/dev/null 2>&1; then
  fail_test "private snapshot rejects a symlinked source component"
fi
[[ -z "$linked_snapshot" ]] || fail_test "linked snapshot must not publish a path"
pass_test "private snapshot rejects every symlinked source component"

hardlink_source="$temp_root/private-values-hardlink-source.yaml"
hardlink_source_alias="$temp_root/private-values-hardlink-source-alias.yaml"
hardlink_source_destination="$temp_root/private-values-hardlink-source.snapshot"
printf 'PRIVATE: hardlinked-source\n' >"$hardlink_source"
chmod 600 "$hardlink_source"
ln "$hardlink_source" "$hardlink_source_alias"
: >"$hardlink_source_destination"
chmod 600 "$hardlink_source_destination"
if node "$ROOT_DIR/deployment/snapshot-private-file.mjs" \
  "$hardlink_source_alias" "$hardlink_source_destination" >/dev/null 2>&1; then
  fail_test "private snapshot rejects a hardlinked source"
fi
[[ ! -e "$hardlink_source_destination" ]] ||
  fail_test "hardlinked source rejection removes the unpublished destination"
pass_test "private snapshot rejects a hardlinked source before copying"

hardlink_destination_source="$temp_root/private-values-hardlink-destination-source.yaml"
hardlink_destination="$temp_root/private-values-hardlink-destination"
hardlink_destination_alias="$temp_root/private-values-hardlink-destination-alias"
printf 'PRIVATE: source-for-hardlinked-destination\n' >"$hardlink_destination_source"
chmod 600 "$hardlink_destination_source"
printf 'PRESERVE: hardlinked-destination\n' >"$hardlink_destination"
chmod 600 "$hardlink_destination"
ln "$hardlink_destination" "$hardlink_destination_alias"
if node "$ROOT_DIR/deployment/snapshot-private-file.mjs" \
  "$hardlink_destination_source" "$hardlink_destination_alias" >/dev/null 2>&1; then
  fail_test "private snapshot rejects a hardlinked destination"
fi
[[ "$(cat "$hardlink_destination")" == 'PRESERVE: hardlinked-destination' ]] ||
  fail_test "hardlinked destination was truncated before rejection"
pass_test "private snapshot rejects a hardlinked destination before truncation"

directory_activity_source="$temp_root/private-values-directory-activity.yaml"
directory_activity_destination="$temp_root/private-values-directory-activity.snapshot"
directory_activity_sibling="$temp_root/private-values-directory-activity-sibling"
dd if=/dev/zero of="$directory_activity_source" bs=1048576 count=1 seek=255 2>/dev/null
chmod 600 "$directory_activity_source"
: >"$directory_activity_destination"
chmod 600 "$directory_activity_destination"
set +e
node "$ROOT_DIR/deployment/snapshot-private-file.mjs" \
  "$directory_activity_source" "$directory_activity_destination" >/dev/null 2>&1 &
directory_activity_pid=$!
directory_activity_observed=false
for _directory_activity_poll in $(seq 1 10000); do
  if ! kill -0 "$directory_activity_pid" 2>/dev/null; then break; fi
  if [[ "$(wc -c <"$directory_activity_destination" | tr -d ' ')" -gt 0 ]] &&
      kill -STOP "$directory_activity_pid" 2>/dev/null; then
    if mkdir "$directory_activity_sibling" 2>/dev/null; then
      directory_activity_observed=true
    fi
    kill -CONT "$directory_activity_pid" 2>/dev/null
    break
  fi
done
wait "$directory_activity_pid"
directory_activity_status=$?
set -e
if [[ -d "$directory_activity_sibling" ]]; then
  rmdir "$directory_activity_sibling"
fi
if [[ "$directory_activity_observed" == true &&
      "$directory_activity_status" -eq 0 &&
      -f "$directory_activity_destination" ]] &&
    cmp -s "$directory_activity_source" "$directory_activity_destination"; then
  pass_test "private snapshot tolerates legitimate sibling-directory activity"
else
  fail_test "private snapshot sibling-directory activity contract"
fi

toctou_source="$temp_root/private-values-toctou.yaml"
toctou_destination="$temp_root/private-values-toctou.snapshot"
dd if=/dev/zero of="$toctou_source" bs=1048576 count=1 seek=255 2>/dev/null
chmod 600 "$toctou_source"
: >"$toctou_destination"
chmod 600 "$toctou_destination"
set +e
node "$ROOT_DIR/deployment/snapshot-private-file.mjs" \
  "$toctou_source" "$toctou_destination" >/dev/null 2>&1 &
snapshot_pid=$!
snapshot_observed=false
for _snapshot_poll in $(seq 1 10000); do
  if ! kill -0 "$snapshot_pid" 2>/dev/null; then break; fi
  if [[ "$(wc -c <"$toctou_destination" | tr -d ' ')" -gt 0 ]]; then
    kill -STOP "$snapshot_pid" 2>/dev/null
    printf 'mutation\n' >>"$toctou_source"
    kill -CONT "$snapshot_pid" 2>/dev/null
    snapshot_observed=true
    break
  fi
done
wait "$snapshot_pid"
snapshot_status=$?
set -e
if [[ "$snapshot_observed" == true && "$snapshot_status" -ne 0 &&
      ! -e "$toctou_destination" ]]; then
  pass_test "private snapshot detects source mutation after open and removes partial output"
else
  fail_test "private snapshot TOCTOU mutation contract"
fi

exit_temp="$temp_root/cleanup-on-exit"
bash -c '
  set -euo pipefail
  source "$1"
  reactivation_install_cleanup_traps
  : >"$2"
  reactivation_register_temp_path "$2"
' _ "$ROOT_DIR/deployment/lib/reactivation-gate-functions.sh" "$exit_temp"
[[ ! -e "$exit_temp" ]] || fail_test "cleanup on EXIT"
pass_test "registered temporary file is removed on EXIT"

for signal_spec in "130:INT" "143:TERM"; do
  signal_code="${signal_spec%%:*}"
  signal_name="${signal_spec#*:}"
  signal_temp="$temp_root/cleanup-on-${signal_name}"
  set +e
  bash -c '
    set -euo pipefail
    source "$1"
    reactivation_install_cleanup_traps
    : >"$2"
    reactivation_register_temp_path "$2"
    kill -s "$3" "$$"
    exit 99
  ' _ "$ROOT_DIR/deployment/lib/reactivation-gate-functions.sh" "$signal_temp" "$signal_name"
  signal_status=$?
  set -e
  [[ "$signal_status" == "$signal_code" ]] || fail_test "$signal_name exit status"
  [[ ! -e "$signal_temp" ]] || fail_test "cleanup on $signal_name"
done
pass_test "registered temporary files are removed on INT and TERM"

callback_marker="$temp_root/callback-marker"
set +e
bash -c '
  set -euo pipefail
  source "$1"
  callback_marker="$2"
  callback() { printf "called\n" >"$callback_marker"; }
  reactivation_install_cleanup_traps callback
  kill -INT "$$"
  exit 99
' _ "$ROOT_DIR/deployment/lib/reactivation-gate-functions.sh" "$callback_marker"
callback_status=$?
set -e
[[ "$callback_status" == "130" && -s "$callback_marker" ]] || fail_test "named signal cleanup exits 130"
pass_test "live-style cleanup callback cannot continue after INT"

auth_config="$temp_root/curl-auth.conf"
fake_token='fixture-token-not-a-secret'
reactivation_write_curl_bearer_config "$auth_config" "$fake_token"
[[ "$(reactivation_file_mode "$auth_config")" == "600" ]] || fail_test "curl auth config mode"
grep -Fq "Authorization: Bearer $fake_token" "$auth_config" || fail_test "curl auth config content"
if grep -En -- '--docker-password=|Authorization: Bearer \$' \
  "$ROOT_DIR/deployment/preflight-reactivation.sh" "$ROOT_DIR/deployment/README.md" >/dev/null; then
  fail_test "secrets must not be passed in argv by scripts or runbook"
fi
pass_test "bearer credentials use private config files, never argv"

if grep -En '^[[:space:]]*kubectl[[:space:]]|\$\(kubectl[[:space:]]|[|&;][[:space:]]*kubectl[[:space:]]' \
  "$ROOT_DIR/deployment/preflight-reactivation.sh" \
  "$ROOT_DIR/deployment/verify-live-reactivation.sh" >/dev/null ||
  grep -En -- '-n[[:space:]]+hcce' "$ROOT_DIR/deployment/preflight-reactivation.sh" >/dev/null; then
  fail_test "reactivation gates must bind every Kubernetes read to context and namespace"
fi
pass_test "reactivation Kubernetes reads use the verified context, namespace and UID"

checksum_dir="$temp_root/checksum"
mkdir -p "$checksum_dir"
printf 'artifact\n' >"$checksum_dir/artifact.bin"
(
  cd "$checksum_dir"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 artifact.bin >SHA256SUMS
  else
    sha256sum artifact.bin >SHA256SUMS
  fi
)
reactivation_verify_sha256_manifest "$checksum_dir" SHA256SUMS >/dev/null || fail_test "valid checksum"
printf 'tampered\n' >>"$checksum_dir/artifact.bin"
if reactivation_verify_sha256_manifest "$checksum_dir" SHA256SUMS >/dev/null 2>&1; then
  fail_test "tampered checkpoint checksum rejected"
fi
printf '%064d  ../outside\n' 0 >"$checksum_dir/SHA256SUMS"
if reactivation_verify_sha256_manifest "$checksum_dir" SHA256SUMS >/dev/null 2>&1; then
  fail_test "unsafe checksum path rejected"
fi
printf 'artifact\n' >"$checksum_dir/artifact.bin"
ln -s artifact.bin "$checksum_dir/linked.bin"
(
  cd "$checksum_dir"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 artifact.bin linked.bin >SHA256SUMS
  else
    sha256sum artifact.bin linked.bin >SHA256SUMS
  fi
)
if reactivation_verify_sha256_manifest "$checksum_dir" SHA256SUMS >/dev/null 2>&1; then
  fail_test "linked checkpoint artifact rejected"
fi
pass_test "checkpoint checksum verification rejects tampering, links and unsafe paths"

range_repo="$temp_root/range-repo"
mkdir -p "$range_repo"
git -C "$range_repo" init -q
git -C "$range_repo" config user.name "Gate Test"
git -C "$range_repo" config user.email "gate-test@example.invalid"
printf 'first\n' >"$range_repo/file.txt"
git -C "$range_repo" add file.txt
git -C "$range_repo" commit -qm first
first_revision="$(git -C "$range_repo" rev-parse HEAD)"
first_range="$(
  cd "$range_repo"
  bash "$ROOT_DIR/scripts/ci-git-scan-range.sh" workflow_dispatch "" "" "$first_revision"
)"
[[ "$first_range" == "$first_revision" ]] || fail_test "root commit scan range"

printf 'temporary-credential-marker\n' >>"$range_repo/file.txt"
git -C "$range_repo" commit -qam second
second_revision="$(git -C "$range_repo" rev-parse HEAD)"
push_range="$(
  cd "$range_repo"
  bash "$ROOT_DIR/scripts/ci-git-scan-range.sh" push "" "$first_revision" "$second_revision"
)"
pr_range="$(
  cd "$range_repo"
  bash "$ROOT_DIR/scripts/ci-git-scan-range.sh" pull_request "$first_revision" "" "$second_revision"
)"
git -C "$range_repo" show "$first_revision:file.txt" >"$range_repo/file.txt"
git -C "$range_repo" commit -qam "remove temporary credential"
third_revision="$(git -C "$range_repo" rev-parse HEAD)"
fallback_range="$(
  cd "$range_repo"
  bash "$ROOT_DIR/scripts/ci-git-scan-range.sh" workflow_dispatch "" "" "$third_revision"
)"
zero_push_range="$(
  cd "$range_repo"
  bash "$ROOT_DIR/scripts/ci-git-scan-range.sh" push "" \
    0000000000000000000000000000000000000000 "$third_revision"
)"
expected_range="$first_revision..$second_revision"
[[ "$push_range" == "$expected_range" ]] || fail_test "push scan range"
[[ "$pr_range" == "$expected_range" ]] || fail_test "pull request scan range"
[[ "$fallback_range" == "$third_revision" ]] || fail_test "fallback scans all reachable history"
[[ "$zero_push_range" == "$third_revision" ]] || fail_test "new branch scans all reachable history"
git -C "$range_repo" rev-list "$zero_push_range" | grep -Fxq "$second_revision" ||
  fail_test "new branch range includes the removed-credential commit"
pass_test "Git range selection covers every introduced commit"

sub_repo="$temp_root/sub-repo"
super_repo="$temp_root/super-repo"
mkdir -p "$sub_repo" "$super_repo"
git -C "$sub_repo" init -q
git -C "$sub_repo" config user.name "Gate Test"
git -C "$sub_repo" config user.email "gate-test@example.invalid"
printf 'pinned\n' >"$sub_repo/file.txt"
git -C "$sub_repo" add file.txt
git -C "$sub_repo" commit -qm pinned

git -C "$super_repo" init -q
git -C "$super_repo" config user.name "Gate Test"
git -C "$super_repo" config user.email "gate-test@example.invalid"
printf 'root\n' >"$super_repo/README.md"
git -C "$super_repo" add README.md
git -C "$super_repo" commit -qm root
git -C "$super_repo" -c protocol.file.allow=always submodule add -q "$sub_repo" modules/demo
git -C "$super_repo" commit -qam "pin submodule"
pinned_super_revision="$(git -C "$super_repo" rev-parse HEAD)"
pinned_sub_revision="$(git -C "$super_repo" ls-tree HEAD modules/demo | awk '{print $3}')"
baseline_map="$super_repo/submodule-baselines.tsv"
printf 'modules/demo\t%s\n' "$pinned_sub_revision" >"$baseline_map"
bash "$ROOT_DIR/scripts/verify-gitlinks.sh" "$super_repo" >/dev/null ||
  fail_test "valid gitlink accepted"

printf 'newer\n' >>"$sub_repo/file.txt"
git -C "$sub_repo" commit -qam newer
newer_revision="$(git -C "$sub_repo" rev-parse HEAD)"
git -C "$super_repo/modules/demo" fetch -q
git -C "$super_repo/modules/demo" checkout -q "$newer_revision"
if bash "$ROOT_DIR/scripts/verify-gitlinks.sh" "$super_repo" >/dev/null 2>&1; then
  fail_test "mismatched gitlink rejected"
fi
git -C "$super_repo" add modules/demo
git -C "$super_repo" commit -qm "update submodule"
updated_super_revision="$(git -C "$super_repo" rev-parse HEAD)"
submodule_ranges="$(
  cd "$super_repo"
  bash "$ROOT_DIR/scripts/ci-submodule-scan-ranges.sh" pull_request \
    "$pinned_super_revision" "" "$updated_super_revision" main "$baseline_map"
)"
[[ "$submodule_ranges" == $'modules/demo\t'"$pinned_sub_revision..$newer_revision" ]] ||
  fail_test "submodule history range covers changed gitlink commits"
bootstrap_submodule_ranges="$(
  cd "$super_repo"
  bash "$ROOT_DIR/scripts/ci-submodule-scan-ranges.sh" workflow_dispatch \
    "" "" "$updated_super_revision" main "$baseline_map"
)"
[[ "$bootstrap_submodule_ranges" == $'modules/demo\t'"$pinned_sub_revision..$newer_revision" ]] ||
  fail_test "manual submodule scan starts at clean baseline"
default_policy_submodule_ranges="$(
  cd "$super_repo"
  bash "$ROOT_DIR/scripts/ci-submodule-scan-ranges.sh" workflow_dispatch \
    "" "" "$updated_super_revision" main --bootstrap-default
)"
[[ "$default_policy_submodule_ranges" == $'modules/demo\t'"$newer_revision" ]] ||
  fail_test "default-policy bootstrap scans all submodule history"
git -C "$super_repo/modules/demo" rev-list "$newer_revision" |
  grep -Fxq "$pinned_sub_revision" ||
  fail_test "default-policy bootstrap includes submodule ancestry"
bash "$ROOT_DIR/scripts/verify-gitlinks.sh" "$super_repo" >/dev/null ||
  fail_test "updated exact gitlink accepted"
printf 'dirty\n' >>"$super_repo/modules/demo/file.txt"
if bash "$ROOT_DIR/scripts/verify-gitlinks.sh" "$super_repo" >/dev/null 2>&1; then
  fail_test "dirty submodule worktree rejected"
fi
git -C "$super_repo" submodule deinit -q -f modules/demo
mkdir -p "$super_repo/modules/demo"
if bash "$ROOT_DIR/scripts/verify-gitlinks.sh" "$super_repo" >/dev/null 2>&1; then
  fail_test "uninitialized gitlink rejected"
fi
pass_test "gitlink verifier and baseline scanner reject drift, dirt and missing checkouts"

policy_repo="$temp_root/policy-repo"
mkdir -p "$policy_repo"
git -C "$policy_repo" init -q
git -C "$policy_repo" config user.name "Gate Test"
git -C "$policy_repo" config user.email "gate-test@example.invalid"
printf 'trusted base without custom policy\n' >"$policy_repo/README.md"
git -C "$policy_repo" add README.md
git -C "$policy_repo" commit -qm "trusted pre-policy base"
trusted_pre_policy_revision="$(git -C "$policy_repo" rev-parse HEAD)"
mkdir -p "$policy_repo/scripts"
printf 'title = "candidate-policy-must-not-control"\n' >"$policy_repo/scripts/gitleaks-root.toml"
printf 'hubs\t0000000000000000000000000000000000000000\n' \
  >"$policy_repo/scripts/gitleaks-submodule-baselines.tsv"
git -C "$policy_repo" add scripts
git -C "$policy_repo" commit -qm "candidate adds policy"
bootstrap_policy_dir="$temp_root/bootstrap-policy"
bootstrap_policy_env="$(bash "$ROOT_DIR/scripts/materialize-gitleaks-policy.sh" \
  "$policy_repo" "$trusted_pre_policy_revision" "$bootstrap_policy_dir" 2>/dev/null)"
bootstrap_config="$bootstrap_policy_dir/bootstrap-default.toml"
if grep -Fxq 'GITLEAKS_POLICY_MODE=bootstrap-default' <<<"$bootstrap_policy_env" &&
   grep -Fxq "GITLEAKS_ROOT_CONFIG=$bootstrap_config" <<<"$bootstrap_policy_env" &&
   grep -Fxq "GITLEAKS_CLOUD_CONFIG=$bootstrap_config" <<<"$bootstrap_policy_env" &&
   grep -Fxq 'GITLEAKS_SUBMODULE_BASELINES=' <<<"$bootstrap_policy_env" &&
   [[ "$(find "$bootstrap_policy_dir" -mindepth 1 -maxdepth 1 -type f | wc -l | tr -d ' ')" == 1 ]] &&
   [[ "$(cat "$bootstrap_config")" == $'title = "YenHubs conservative first-policy bootstrap"\n[extend]\nuseDefault = true' ]] &&
   ! grep -Fq 'candidate-policy-must-not-control' "$bootstrap_config"; then
  pass_test "first-policy bootstrap uses Gitleaks defaults and ignores every candidate policy file"
else
  fail_test "base-owned Gitleaks bootstrap contract"
fi

external_scan_target="$temp_root/external-gitleaks-target"
printf 'DO_NOT_FOLLOW_EXTERNAL_TARGET\n' >"$external_scan_target"
external_scan_directory="$temp_root/external-gitleaks-directory"
mkdir -p "$external_scan_directory"
printf 'DO_NOT_FOLLOW_DIRECTORY_TARGET\n' >"$external_scan_directory/secret.txt"
printf 'SCANNED_ROOT_FILE\n' >"$super_repo/root-untracked.txt"
printf 'title = "candidate-policy-must-not-control"\n' >"$super_repo/.gitleaks.toml"
trusted_gitleaks_config="$temp_root/base-owned-gitleaks.toml"
printf 'title = "base-owned-policy"\n' >"$trusted_gitleaks_config"
chmod 600 "$trusted_gitleaks_config"
ln -s "$external_scan_target" "$super_repo/external-link"
ln -s "$external_scan_directory" "$super_repo/external-directory-link"
printf 'deleted-current-worktree\n' >"$super_repo/deleted-current.txt"
git -C "$super_repo" add .gitleaks.toml external-link external-directory-link deleted-current.txt
rm "$super_repo/deleted-current.txt"
fake_gitleaks="$temp_root/fake-gitleaks"
scan_path_record="$temp_root/gitleaks-scan-path"
policy_path_record="$temp_root/gitleaks-policy-path"
cat >"$fake_gitleaks" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
[[ "${1:-}" == detect ]]
source_path=""
config_path=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) source_path="$2"; shift 2 ;;
    --config) config_path="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[[ -d "$source_path" && ! -L "$source_path" ]]
[[ -f "$config_path" && ! -L "$config_path" && "$config_path" != "$CANDIDATE_GITLEAKS_CONFIG" ]]
grep -Fq 'base-owned-policy' "$config_path"
if grep -Fq 'candidate-policy-must-not-control' "$config_path"; then exit 82; fi
[[ -f "$source_path/README.md" && -f "$source_path/root-untracked.txt" ]]
grep -Fxq 'SCANNED_ROOT_FILE' "$source_path/root-untracked.txt"
[[ ! -e "$source_path/modules/demo" ]]
[[ ! -e "$source_path/deleted-current.txt" ]]
[[ -f "$source_path/external-link" && ! -L "$source_path/external-link" ]]
grep -Fxq "$EXPECTED_EXTERNAL_LINK_TEXT" "$source_path/external-link"
[[ -f "$source_path/external-directory-link" && ! -L "$source_path/external-directory-link" ]]
grep -Fxq "$EXPECTED_EXTERNAL_DIRECTORY_LINK_TEXT" "$source_path/external-directory-link"
if grep -Erq 'DO_NOT_FOLLOW_(EXTERNAL|DIRECTORY)_TARGET' "$source_path"; then exit 81; fi
printf '%s\n' "$source_path" >"$SCAN_PATH_RECORD"
printf '%s\n' "$config_path" >"$POLICY_PATH_RECORD"
STUB
chmod 700 "$fake_gitleaks"
if env GITLEAKS_BIN="$fake_gitleaks" \
    CANDIDATE_GITLEAKS_CONFIG="$super_repo/.gitleaks.toml" \
    EXPECTED_EXTERNAL_LINK_TEXT="$external_scan_target" \
    EXPECTED_EXTERNAL_DIRECTORY_LINK_TEXT="$external_scan_directory" \
    SCAN_PATH_RECORD="$scan_path_record" \
    POLICY_PATH_RECORD="$policy_path_record" \
    "$ROOT_DIR/scripts/scan-gitleaks-worktree.sh" "$super_repo" "$trusted_gitleaks_config"; then
  materialized_scan_path="$(cat "$scan_path_record")"
  materialized_policy_path="$(cat "$policy_path_record")"
  [[ ! -e "$materialized_scan_path" ]] || fail_test "gitleaks materialized worktree cleanup"
  [[ ! -e "$materialized_policy_path" ]] || fail_test "gitleaks materialized policy cleanup"
  pass_test "Gitleaks scans a private policy snapshot, includes root files, excludes gitlinks and never follows symlinks"
else
  fail_test "Gitleaks worktree materialization contract"
fi
policy_real_dir="$temp_root/policy-real-directory"
mkdir "$policy_real_dir"
printf 'title = "linked-component"\n' >"$policy_real_dir/policy.toml"
chmod 600 "$policy_real_dir/policy.toml"
ln -s "$policy_real_dir" "$temp_root/policy-linked-directory"
if env GITLEAKS_BIN="$fake_gitleaks" \
    "$ROOT_DIR/scripts/scan-gitleaks-worktree.sh" "$super_repo" \
    "$temp_root/policy-linked-directory/policy.toml" >/dev/null 2>&1; then
  fail_test "Gitleaks policy rejects a symlinked directory component"
fi
pass_test "Gitleaks policy snapshot rejects linked path components before scanning"

baseline_file="$ROOT_DIR/scripts/gitleaks-submodule-baselines.tsv"
if [[ "$(awk '!/^[[:space:]]*(#|$)/ {print $1"\t"$2}' "$baseline_file")" == $'hubs\t492625c5791fa540e752cc8300018a4e8252d3f4\nhubs-cloud\t4a1e3b9f2516851b015c17e968ea2cc4aabf4680' ]] &&
  grep -Eq 'find deployment scripts tests/recovery tests/scripts' "$ROOT_DIR/.github/workflows/project-security.yml" &&
  grep -Eq 'Materialize base-owned Gitleaks policy' "$ROOT_DIR/.github/workflows/project-security.yml" &&
  grep -Eq 'materialize-gitleaks-policy\.sh' "$ROOT_DIR/.github/workflows/project-security.yml" &&
  grep -Eq -- '--bootstrap-default' "$ROOT_DIR/.github/workflows/project-security.yml" &&
  grep -Eq "scan-gitleaks-worktree\\.sh hubs-cloud \"\\\$GITLEAKS_CLOUD_CONFIG\"" "$ROOT_DIR/.github/workflows/project-security.yml" &&
  grep -Fq "gitleaks git \"\${root_config_args[@]}\"" "$ROOT_DIR/.github/workflows/project-security.yml" &&
  ! grep -Eq 'scan-gitleaks-worktree\.sh hubs-cloud \.gitleaks\.toml' "$ROOT_DIR/.github/workflows/project-security.yml" &&
  ! grep -Eq "policy_revision=\"\\\$HEAD_SHA\"|policy_revision=HEAD|using HEAD only|git show .*HEAD.*gitleaks" "$ROOT_DIR/.github/workflows/project-security.yml" &&
  ! grep -Eq '(^|[^[:alnum:]_])HEAD([^[:alnum:]_]|$)' "$ROOT_DIR/scripts/materialize-gitleaks-policy.sh" &&
  grep -Eq 'useDefault = true' "$ROOT_DIR/scripts/materialize-gitleaks-policy.sh"; then
  pass_test "base-owned Gitleaks policies, production baselines and full ShellCheck scope are pinned"
else
  fail_test "base-owned Gitleaks policy, production baselines or ShellCheck scope"
fi

aud065_aggregate="$ROOT_DIR/scripts/test-aud065.sh"
aud065_inventory_ok=true
for aud065_test in \
  test-aud065-operation-lock.sh \
  test-aud065-pgsql-barrier.sh \
  test-process-local-db-rotation.sh \
  test-process-local-db-rotation-postgres.sh \
  test-process-local-rotation-coordinator.sh \
  process-local-rotation.test.mjs \
  process-local-rotation-operation.test.mjs \
  process-local-source-transition.test.mjs \
  prepare-process-local-rotation.test.mjs \
  materialize-process-local-replacements.test.mjs \
  private-artifact-publication.test.mjs \
  project-process-local-values.test.mjs \
  bot-image-pull-config.test.mjs \
  capture-process-local-baseline.test.mjs \
  redacted-rollout-contract.test.mjs; do
  [[ "$(grep -Fc "/$aud065_test\"" "$aud065_aggregate")" == 1 ]] || \
    aud065_inventory_ok=false
done
if [[ -x "$aud065_aggregate" && "$aud065_inventory_ok" == true ]] &&
  [[ "$(grep -Fc 'scripts/test-aud065.sh' \
    "$ROOT_DIR/scripts/verify-project.sh")" == 1 ]] &&
  [[ "$(grep -Fc 'bash scripts/test-aud065.sh' \
    "$ROOT_DIR/.github/workflows/project-security.yml")" == 1 ]] &&
  grep -Eq '^  aud065-postgres:$' \
    "$ROOT_DIR/.github/workflows/project-security.yml" &&
  grep -Fq -- '- "12.19"' "$ROOT_DIR/.github/workflows/project-security.yml" &&
  grep -Fq -- '- "14.23"' "$ROOT_DIR/.github/workflows/project-security.yml" &&
  grep -Fq 'PLDB_PGHOST: 127.0.0.1' \
    "$ROOT_DIR/.github/workflows/project-security.yml" &&
  grep -Fq "PLDB_PGPORT: \${{ job.services.postgres.ports['5432'] }}" \
    "$ROOT_DIR/.github/workflows/project-security.yml" &&
  grep -Fq 'PLDB_SETUP_PASSWORD: SetupFixturePassword_CCCCCCCCCCCC' \
    "$ROOT_DIR/.github/workflows/project-security.yml" &&
  grep -Fq "PLDB_POSTGRES_CONTAINER_ID: \${{ job.services.postgres.id }}" \
    "$ROOT_DIR/.github/workflows/project-security.yml" &&
  grep -Fq 'run: bash tests/recovery/test-process-local-db-rotation-postgres.sh' \
    "$ROOT_DIR/.github/workflows/project-security.yml" &&
  ! grep -Eq 'tests/(recovery/test-aud065|recovery/test-process-local|scripts/.*process-local)' \
    "$ROOT_DIR/scripts/verify-project.sh"; then
  pass_test "AUD-065 aggregate and external PostgreSQL 12/14 CI matrix are pinned"
else
  fail_test "AUD-065 aggregate, local gate or PostgreSQL CI matrix drift"
fi

causal_monitor_gate_inventory_ok=true
for causal_monitor_test in \
  runner-cutover-checkpoint-evidence.test.mjs \
  durable-runner-quiescence-monitor.test.mjs; do
  [[ "$(grep -Fc "$causal_monitor_test" \
    "$ROOT_DIR/scripts/verify-project.sh")" == 1 ]] ||
    causal_monitor_gate_inventory_ok=false
  [[ "$(grep -Fc "$causal_monitor_test" \
    "$ROOT_DIR/.github/workflows/project-security.yml")" == 1 ]] ||
    causal_monitor_gate_inventory_ok=false
done
if [[ "$causal_monitor_gate_inventory_ok" == true ]]; then
  pass_test "runner evidence and causal monitor coverage are pinned in local and CI gates"
else
  fail_test "runner evidence or causal monitor gate coverage drift"
fi

printf '\n%d security gate regression tests passed\n' "$test_count"

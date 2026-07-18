#!/usr/bin/env bash

# Read-only live acceptance checks for a restored YenHubs deployment. Every
# external command status is authoritative: stdout is never accepted from a
# failed kubectl, curl, DNS, database or storage command.

set -uo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deployment/lib/reactivation-gate-functions.sh
source "$SCRIPT_DIR/lib/reactivation-gate-functions.sh"
# shellcheck source=deployment/lib/recovery-safety.sh
source "$SCRIPT_DIR/lib/recovery-safety.sh"
VALUES_SOURCE_FILE="${VALUES_FILE:-$SCRIPT_DIR/input-values.local.yaml}"
VALUES_FILE=""
NAMESPACE="${NAMESPACE:-hcce}"
ROOM_SMOKE_PATH="${ROOM_SMOKE_PATH:-/VJopCY3/inicio}"

failures=0
warnings=0
port_forward_pid=""
port_forward_log=""
http_code=""
health_candidate=""
readiness_candidate=""
sitting_capabilities_candidate=""

pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; failures=$((failures + 1)); }
warn() { printf 'WARN  %s\n' "$1"; warnings=$((warnings + 1)); }
yaml_value() { node "$SCRIPT_DIR/parse-local-values.mjs" "$VALUES_FILE" --get "$1"; }

stop_port_forward() {
  local wait_status=0
  [[ -n "$port_forward_pid" ]] || return 0
  if ! kill -0 "$port_forward_pid" 2>/dev/null; then
    if wait "$port_forward_pid"; then wait_status=0; else wait_status=$?; fi
    printf 'El port-forward termino antes de su cierre controlado (status=%s).\n' "$wait_status" >&2
    port_forward_pid=""
    return 1
  fi
  if ! kill -TERM "$port_forward_pid" 2>/dev/null; then
    printf 'No se pudo detener el port-forward activo.\n' >&2
    return 1
  fi
  if wait "$port_forward_pid"; then
    wait_status=0
  else
    wait_status=$?
  fi
  port_forward_pid=""
  if [[ "$wait_status" != "0" && "$wait_status" != "143" ]]; then
    printf 'El port-forward termino con estado inesperado: %s.\n' "$wait_status" >&2
    return 1
  fi
}

cleanup() {
  local cleanup_status=0
  if ! stop_port_forward; then cleanup_status=1; fi
  if [[ -n "$port_forward_log" ]]; then
    rm -f -- "$port_forward_log"
    port_forward_log=""
  fi
  return "$cleanup_status"
}
reactivation_install_cleanup_traps cleanup

jq_check() {
  local payload="$1"
  local success_message="$2"
  local failure_message="$3"
  local filter="$4"
  if printf '%s' "$payload" | jq -e "$filter" >/dev/null; then
    pass "$success_message"
  else
    fail "$failure_message"
  fi
}

printf 'YenHubs live reactivation verification\n\n'

for command_name in kubectl jq node curl dig gzip tar; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    fail "Falta el comando requerido: $command_name"
  fi
done
if [[ ! -f "$VALUES_SOURCE_FILE" || -L "$VALUES_SOURCE_FILE" ]] ||
   ! reactivation_values_file_is_private "$VALUES_SOURCE_FILE" ||
   ! reactivation_snapshot_private_file VALUES_FILE "$VALUES_SOURCE_FILE" ||
   ! node "$SCRIPT_DIR/parse-local-values.mjs" "$VALUES_FILE" --validate; then
  fail "El fichero local de valores falta, no es 600 o no cumple el subconjunto YAML seguro"
  printf '\nSummary: %d failure(s), %d warning(s)\n' "$failures" "$warnings"
  exit 1
fi
if ! recovery_require_cluster_identity; then
  fail "La identidad exacta de contexto/namespace Kubernetes no coincide"
  printf '\nSummary: %d failure(s), %d warning(s)\n' "$failures" "$warnings"
  exit 1
fi
if ! domain="$(yaml_value HUB_DOMAIN)" || [[ -z "$domain" ]]; then
  fail "HUB_DOMAIN no esta configurado"
  printf '\nSummary: %d failure(s), %d warning(s)\n' "$failures" "$warnings"
  exit 1
fi
hubs_image="$(yaml_value OVERRIDE_HUBS_IMAGE)"
reticulum_image="$(yaml_value OVERRIDE_RETICULUM_IMAGE)"
bot_image="$(yaml_value OVERRIDE_BOT_ORCHESTRATOR_IMAGE)"
if ! reactivation_image_override_is_exact hubs "$hubs_image" ||
   ! reactivation_image_override_is_exact reticulum "$reticulum_image" ||
   ! reactivation_image_override_is_exact bot-orchestrator "$bot_image"; then
  fail "Los overrides core no usan repositorios confiables y digests exactos"
fi
expected_images_json="$(jq -cn \
  --arg bot "$bot_image" \
  --arg coturn "$(yaml_value OVERRIDE_COTURN_IMAGE)" \
  --arg dialog "$(yaml_value OVERRIDE_DIALOG_IMAGE)" \
  --arg haproxy "$(yaml_value OVERRIDE_HAPROXY_IMAGE)" \
  --arg hubs "$hubs_image" \
  --arg nearspark "$(yaml_value OVERRIDE_NEARSPARK_IMAGE)" \
  --arg pgbouncer "$(yaml_value OVERRIDE_PGBOUNCER_IMAGE)" \
  --arg photomnemonic "$(yaml_value OVERRIDE_PHOTOMNEMONIC_IMAGE)" \
  --arg postgres "$(yaml_value OVERRIDE_POSTGRES_IMAGE)" \
  --arg postgrest "$(yaml_value OVERRIDE_POSTGREST_IMAGE)" \
  --arg reticulum "$reticulum_image" \
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
if reactivation_image_map_is_trusted "$expected_images_json"; then
  pass "Los 13 pares imagen/repositorio estan allowlisted y fijados por digest"
else
  fail "Uno o mas pares imagen/repositorio no pertenecen al allowlist exacto"
fi

if ! service_json="$(recovery_kubectl get service lb -n "$NAMESPACE" -o json)"; then
  fail "kubectl no pudo leer el servicio lb"
  lb_ip=""
elif ! lb_ip="$(printf '%s' "$service_json" | jq -er '.status.loadBalancer.ingress[0].ip | select(type == "string" and length > 0)')"; then
  fail "El servicio lb no tiene una IP publica valida"
  lb_ip=""
else
  pass "Load Balancer publicado: $lb_ip"
fi

printf '\nDNS\n'
hosts=("$domain" "assets.$domain" "cors.$domain" "stream.$domain")
dns_ready=1
for host in "${hosts[@]}"; do
  if ! addresses="$(dig +short A "$host" | LC_ALL=C sort -u | paste -sd, -)"; then
    fail "La consulta DNS fallo para $host"
    dns_ready=0
  elif [[ -n "$lb_ip" && "$addresses" == "$lb_ip" ]]; then
    pass "$host -> $lb_ip"
  else
    fail "$host apunta a ${addresses:-ninguna IP}; esperado ${lb_ip:-IP ausente}"
    dns_ready=0
  fi
done

printf '\nTLS\n'
certificates_ready=1
for host in "${hosts[@]}"; do
  certificate="cert-$host"
  if ! ready="$(
    recovery_kubectl get certificate "$certificate" -n "$NAMESPACE" \
      -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}'
  )"; then
    fail "kubectl no pudo leer $certificate"
    certificates_ready=0
  elif [[ "$ready" == "True" ]]; then
    pass "$certificate Ready=True"
  else
    fail "$certificate no esta Ready"
    certificates_ready=0
  fi
done

printf '\nDeployments y runtime\n'
if ! deployments_json="$(recovery_kubectl get deployment -n "$NAMESPACE" -o json)" ||
   ! printf '%s' "$deployments_json" | jq -e '.items | type == "array"' >/dev/null; then
  fail "kubectl no pudo entregar un inventario JSON valido de Deployments"
  deployments_json='{"items":[]}'
fi

if reactivation_deployments_are_acceptable "$deployments_json" \
  "$hubs_image" "$reticulum_image" "$bot_image" "$expected_images_json"; then
  pass "Los 13 pares Deployment/contenedor coinciden exactamente con el candidato"
else
  fail "Inventario live, digests o procedencia no coinciden con el candidato exacto"
fi
reticulum_deployment_uid=""
reticulum_deployment_json="$(jq -ce \
  '[.items[] | select(.metadata.name == "reticulum")] | select(length == 1) | .[0]' \
  <<<"$deployments_json" 2>/dev/null || :)"
if reactivation_reticulum_deployment_is_singleton "$reticulum_deployment_json"; then
  reticulum_deployment_uid="$(jq -er '.metadata.uid' <<<"$reticulum_deployment_json")"
  pass "Reticulum tiene autoridad singleton: replicas=1 y estrategia Recreate exacta"
else
  fail "Reticulum permitiria autoridad concurrente (replicas/strategy/selector invalidos)"
fi
if reticulum_hpas_json="$(recovery_kubectl get horizontalpodautoscaler -n "$NAMESPACE" -o json)" &&
   reactivation_hpas_do_not_target_reticulum "$reticulum_hpas_json"; then
  pass "Ningun HPA puede escalar Reticulum"
else
  fail "No se pudo excluir un HPA dirigido a Reticulum"
fi

# jq variables are intentionally evaluated by jq, not by this shell.
# shellcheck disable=SC2016
jq_check "$deployments_json" \
  "Los 13 contenedores tienen requests y limite de memoria, sin CPU limits" \
  "Los resource budgets no coinciden con el baseline" '
  ([.items[].spec.template.spec.containers[]] | length) == 13 and
  all(.items[].spec.template.spec.containers[];
    .resources.requests.cpu and .resources.requests.memory and .resources.limits.memory and
    ((.resources.limits.cpu // null) == null))'

# jq variables are intentionally evaluated by jq, not by this shell.
# shellcheck disable=SC2016
jq_check "$deployments_json" \
  "Bot orchestrator, PostgreSQL, Reticulum, Dialog y Coturn usan Recreate" \
  "Una estrategia stateful no usa Recreate" '
  all(.items[] | select(.metadata.name == "bot-orchestrator" or .metadata.name == "pgsql" or
    .metadata.name == "reticulum" or .metadata.name == "dialog" or
    .metadata.name == "coturn"); .spec.strategy.type == "Recreate")'

# jq variables are intentionally evaluated by jq, not by this shell.
# shellcheck disable=SC2016
jq_check "$deployments_json" \
  "Reticulum conserva el securityContext auditado" \
  "El securityContext de Reticulum no coincide con el baseline" '
  [.items[] | select(.metadata.name == "reticulum") |
    .spec.template.spec.containers[] | select(.name == "reticulum")] as $containers |
  ($containers | length) == 1 and
  all($containers[];
    .securityContext.privileged != true and
    .securityContext.allowPrivilegeEscalation == false and
    ((.securityContext.capabilities.drop // []) | index("ALL") != null) and
    .securityContext.seccompProfile.type == "RuntimeDefault" and
    ([.volumeMounts[]? | select(.name == "storage") | .mountPropagation] | map(select(. != null)) | length) == 0)'

# jq variables are intentionally evaluated by jq, not by this shell.
# shellcheck disable=SC2016
jq_check "$deployments_json" \
  "Bot orchestrator endurecido con probes, deadline, navmesh y recuperacion" \
  "El runtime de bot-orchestrator no coincide con el baseline" '
  [.items[] | select(.metadata.name == "bot-orchestrator") |
    .spec.template.spec.containers[] | select(.name == "bot-orchestrator")] as $containers |
  ($containers | length) == 1 and
  all($containers[];
    . as $container |
    (reduce ($container.env // [])[] as $item ({}; .[$item.name] = $item.value)) as $env |
    $container.securityContext.runAsNonRoot == true and
    $container.securityContext.runAsUser == 1000 and
    $container.securityContext.runAsGroup == 1000 and
    $container.securityContext.allowPrivilegeEscalation == false and
    (($container.securityContext.capabilities.drop // []) | index("ALL") != null) and
    $container.securityContext.seccompProfile.type == "RuntimeDefault" and
    $container.livenessProbe.httpGet.path == "/health" and
    $container.readinessProbe.httpGet.path == "/ready" and
    $env.OPENAI_TOTAL_BUDGET_MS == "4000" and
    $env.GHOST_NAVIGATION_MODE == "navmesh_preferred" and
    $env.GHOST_NAVIGATION_REQUIRE_NAVMESH == "true" and
    $env.GHOST_NAVMESH_MAX_TRIANGLES == "50000" and
    $env.GHOST_NAVMESH_MAX_ROUTE_POINTS == "64" and
    $env.GHOST_NAVMESH_MAX_SNAP_DISTANCE_M == "3" and
    $env.RUNNER_STALE_RESTART_MS == "30000")'

jq_check "$deployments_json" \
  "Dialog y Photomnemonic conservan UID/GID, seccomp y probes auditados" \
  "Dialog o Photomnemonic no coincide con el runtime auditado" '
  ([.items[] | select(.metadata.name == "dialog") |
    .spec.template.spec.containers[] | select(.name == "dialog")] | length) == 1 and
  all(.items[] | select(.metadata.name == "dialog") |
    .spec.template.spec.containers[] | select(.name == "dialog");
    .securityContext.runAsNonRoot == true and .securityContext.runAsUser == 1000 and
    .securityContext.runAsGroup == 1000 and .securityContext.allowPrivilegeEscalation == false and
    ((.securityContext.capabilities.drop // []) | index("ALL") != null) and
    .securityContext.seccompProfile.type == "RuntimeDefault" and
    .startupProbe.tcpSocket.port == 4443 and .readinessProbe.tcpSocket.port == 4443 and
    .livenessProbe.tcpSocket.port == 4443) and
  ([.items[] | select(.metadata.name == "photomnemonic") |
    .spec.template.spec.containers[] | select(.name == "photomnemonic")] | length) == 1 and
  all(.items[] | select(.metadata.name == "photomnemonic") |
    .spec.template.spec.containers[] | select(.name == "photomnemonic");
    .securityContext.runAsNonRoot == true and .securityContext.runAsUser == 1000 and
    .securityContext.runAsGroup == 1000 and .securityContext.allowPrivilegeEscalation == false and
    ((.securityContext.capabilities.drop // []) | index("ALL") != null) and
    .securityContext.seccompProfile.type == "RuntimeDefault" and
    .startupProbe.httpGet.path == "/_readyz" and .startupProbe.httpGet.port == 5000 and
    .readinessProbe.httpGet.path == "/_readyz" and .readinessProbe.httpGet.port == 5000 and
    .livenessProbe.httpGet.path == "/_healthz" and .livenessProbe.httpGet.port == 5000)'

# jq variables are intentionally evaluated by jq, not by this shell.
# shellcheck disable=SC2016
jq_check "$deployments_json" \
  "Huellas BOT/DB, tokens de servicio y Coturn coinciden con el baseline" \
  "Huellas, tokens de servicio o imagen Coturn no coinciden" '
  ([.items[] | select(.metadata.name == "reticulum" or .metadata.name == "bot-orchestrator") |
    .spec.template.metadata.annotations["yenhubs.org/bot-access-key-checksum"]]) as $bot_checks |
  ([.items[] | select(.metadata.name == "reticulum" or .metadata.name == "pgbouncer" or
    .metadata.name == "pgbouncer-t" or .metadata.name == "coturn") |
    .spec.template.metadata.annotations["yenhubs.org/db-credential-checksum"]]) as $db_checks |
  ($bot_checks | length) == 2 and ($bot_checks | unique | length) == 1 and
  ($bot_checks[0] | type == "string" and test("^[a-fA-F0-9]{64}$")) and
  ($db_checks | length) == 4 and ($db_checks | unique | length) == 1 and
  ($db_checks[0] | type == "string" and test("^[a-fA-F0-9]{64}$")) and
  all(.items[] | select(.metadata.name != "haproxy"); .spec.template.spec.automountServiceAccountToken == false) and
  ([.items[] | select(.metadata.name == "haproxy") | .spec.template.spec.serviceAccountName] == ["haproxy-sa"]) and
  all(.items[] | select(.metadata.name == "coturn") | .spec.template.spec.containers[];
    .image != "docker.io/mozillareality/coturn@sha256:8380269c7bb2dc369f4126251199f0d603711debe8537b22cb7be470a50c51ce")'

printf '\nNetworkPolicy\n'
if policies_json="$(recovery_kubectl get networkpolicy -n "$NAMESPACE" -o json)" &&
   reactivation_network_policies_are_exact "$policies_json"; then
  pass "Las seis NetworkPolicies globales son exactas, sin reglas extra"
else
  fail "NetworkPolicies ausentes, adicionales o con ingress/egress no auditado"
fi

printf '\nDatabase\n'
active_owned_files=""
active_owned_file_uuids=""
if ! pgsql_pods_json="$(recovery_kubectl get pod -n "$NAMESPACE" -l app=pgsql -o json)" ||
   ! pgsql_pod_info="$(recovery_exact_ready_pod_info "$pgsql_pods_json" pgsql)"; then
  fail "PostgreSQL no tiene exactamente un pod Ready con UID/owner verificables"
else
  IFS=$'\t' read -r pgsql_pod pgsql_pod_uid <<<"$pgsql_pod_info"
  pgsql_pod_json="$(jq -ce '.items[0]' <<<"$pgsql_pods_json")"
  pgsql_container="$(jq -er '.spec.containers | select(length == 1) | .[0].name' \
    <<<"$pgsql_pod_json")"
  if ! recovery_require_pod_deployment_ownership "$pgsql_pod_json" pgsql ||
     ! recovery_pod_pvc_mount_is_exact "$pgsql_pods_json" "$pgsql_pod" \
       "$pgsql_container" pgsql-pvc /var/lib/postgresql/data ||
     ! recovery_require_pod_identity "$pgsql_pod" "$pgsql_pod_uid"; then
    fail "El pod PostgreSQL no pertenece al Deployment exacto o no monta pgsql-pvc de forma unica"
    pgsql_pod=""
  else
    pass "PostgreSQL: pod unico Ready, UID/owner y montaje pgsql-pvc exactos"
  fi
fi
if [[ -n "${pgsql_pod:-}" ]]; then
  recovery_require_pod_identity "$pgsql_pod" "$pgsql_pod_uid" || fail "El UID PostgreSQL cambio antes de consultar"
  if database_counts="$(
    # Expansion is intentionally deferred to the PostgreSQL container.
    # shellcheck disable=SC2016
    recovery_kubectl exec -n "$NAMESPACE" "$pgsql_pod" -- sh -ec \
      'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d retdb -At <<'\''SQL'\''
select count(*) from information_schema.tables
where table_schema in ('\''ret0'\'', '\''ret0_admin'\'', '\''coturn'\'');
select count(*) from ret0.schema_migrations;
select count(*) from ret0.hubs;
select count(*) from ret0.owned_files where state::text = '\''active'\'';
SQL'
  )"; then
    schema_tables="$(printf '%s\n' "$database_counts" | sed -n '1p')"
    migrations="$(printf '%s\n' "$database_counts" | sed -n '2p')"
    hubs="$(printf '%s\n' "$database_counts" | sed -n '3p')"
    active_owned_files="$(printf '%s\n' "$database_counts" | sed -n '4p')"
  else
    fail "La consulta de conteos PostgreSQL fallo"
    schema_tables=""; migrations=""; hubs=""; active_owned_files=""
  fi
  if active_owned_file_uuids="$(
    # Expansion is intentionally deferred to the PostgreSQL container.
    # shellcheck disable=SC2016
    recovery_kubectl exec -n "$NAMESPACE" "$pgsql_pod" -- sh -ec \
      'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d retdb -Atc "select owned_file_uuid from ret0.owned_files where state::text = '\''active'\'' order by owned_file_uuid"'
  )"; then
    active_owned_file_uuid_count="$(printf '%s\n' "$active_owned_file_uuids" | sed '/^$/d' | wc -l | tr -d ' ')"
    active_owned_file_unique_count="$(printf '%s\n' "$active_owned_file_uuids" | sed '/^$/d' | LC_ALL=C sort -u | wc -l | tr -d ' ')"
    active_uuids_safe=true
    if printf '%s\n' "$active_owned_file_uuids" | sed '/^$/d' | awk '$0 !~ /^[A-Za-z0-9._-]+$/ {exit 1}'; then :; else active_uuids_safe=false; fi
  else
    fail "La consulta de UUID activos PostgreSQL fallo"
    active_owned_file_uuid_count=0; active_owned_file_unique_count=0; active_uuids_safe=false
  fi
  recovery_require_pod_identity "$pgsql_pod" "$pgsql_pod_uid" || fail "El UID PostgreSQL cambio durante la validacion"
  if [[ "$schema_tables" =~ ^[0-9]+$ && "$migrations" =~ ^[0-9]+$ && "$hubs" =~ ^[0-9]+$ &&
        "$active_owned_files" =~ ^[0-9]+$ && "$schema_tables" -ge 356 && "$migrations" -ge 94 &&
        "$hubs" -ge 17 && "$active_owned_files" -gt 0 &&
        "$active_owned_file_uuid_count" == "$active_owned_files" &&
        "$active_owned_file_unique_count" == "$active_owned_files" && "$active_uuids_safe" == true ]]; then
    pass "Restore validado: schema=$schema_tables migrations=$migrations hubs=$hubs owned_files=$active_owned_files"
  else
    fail "Conteos/UUID PostgreSQL no cumplen el baseline"
  fi
fi

printf '\nReticulum storage\n'
if ! reticulum_pods_json="$(recovery_kubectl get pod -n "$NAMESPACE" -l app=reticulum -o json)" ||
   ! reticulum_pod_info="$(recovery_exact_ready_pod_info "$reticulum_pods_json" reticulum)" ||
   [[ ! "$active_owned_files" =~ ^[0-9]+$ ]]; then
  fail "No se pudo localizar Reticulum o validar su baseline DB"
else
  IFS=$'\t' read -r reticulum_pod reticulum_pod_uid <<<"$reticulum_pod_info"
  reticulum_pod_json="$(jq -ce '.items[0]' <<<"$reticulum_pods_json")"
  if [[ -z "${reticulum_deployment_uid:-}" ]] ||
     ! recovery_require_pod_deployment_ownership "$reticulum_pod_json" reticulum \
       "$reticulum_deployment_uid" ||
     ! recovery_pod_pvc_mount_is_exact "$reticulum_pods_json" "$reticulum_pod" \
       reticulum ret-pvc /storage ||
     ! recovery_require_pod_identity "$reticulum_pod" "$reticulum_pod_uid"; then
    fail "Reticulum no tiene un unico pod Ready con UID/owner exactos o no monta ret-pvc de forma unica"
  elif storage_paths="$(
    recovery_kubectl exec -n "$NAMESPACE" -c reticulum "$reticulum_pod" -- sh -ec \
      'test -d /storage/owned; cd /storage; { find owned -type d -print | sed "s|$|/|"; find owned -type f -print; }'
  )" && printf '%s\n' "$storage_paths" | recovery_storage_path_stream_is_exact; then
    storage_blob_uuids="$(printf '%s\n' "$storage_paths" |
      sed -n 's#^owned/[A-Za-z0-9._-][A-Za-z0-9._-]/[A-Za-z0-9._-][A-Za-z0-9._-]/\([A-Za-z0-9._-]*\)\.blob$#\1#p')"
    storage_meta_uuids="$(printf '%s\n' "$storage_paths" |
      sed -n 's#^owned/[A-Za-z0-9._-][A-Za-z0-9._-]/[A-Za-z0-9._-][A-Za-z0-9._-]/\([A-Za-z0-9._-]*\)\.meta\.json$#\1#p')"
    storage_blob_uuids="$(printf '%s\n' "$storage_blob_uuids" | sed '/^$/d' | LC_ALL=C sort)"
    storage_meta_uuids="$(printf '%s\n' "$storage_meta_uuids" | sed '/^$/d' | LC_ALL=C sort)"
    storage_blobs="$(printf '%s\n' "$storage_blob_uuids" | sed '/^$/d' | wc -l | tr -d ' ')"
    storage_meta="$(printf '%s\n' "$storage_meta_uuids" | sed '/^$/d' | wc -l | tr -d ' ')"
    storage_blob_unique="$(printf '%s\n' "$storage_blob_uuids" | sed '/^$/d' | LC_ALL=C sort -u | wc -l | tr -d ' ')"
    storage_meta_unique="$(printf '%s\n' "$storage_meta_uuids" | sed '/^$/d' | LC_ALL=C sort -u | wc -l | tr -d ' ')"
    storage_safe=true
    if printf '%s\n%s\n' "$storage_blob_uuids" "$storage_meta_uuids" | sed '/^$/d' | awk '$0 !~ /^[A-Za-z0-9._-]+$/ {exit 1}'; then :; else storage_safe=false; fi
    active_sorted="$(printf '%s\n' "$active_owned_file_uuids" | sed '/^$/d' | LC_ALL=C sort)"
    if ! missing_active_blobs="$(comm -23 <(printf '%s\n' "$active_sorted") <(printf '%s\n' "$storage_blob_uuids"))" ||
       ! missing_active_meta="$(comm -23 <(printf '%s\n' "$active_sorted") <(printf '%s\n' "$storage_meta_uuids"))" ||
       ! incomplete_pairs="$(comm -3 <(printf '%s\n' "$storage_blob_uuids") <(printf '%s\n' "$storage_meta_uuids"))"; then
      fail "No se pudieron comparar los UUID de DB y ret-pvc"
      missing_active_blobs=error; missing_active_meta=error; incomplete_pairs=error
    fi
    if [[ "$storage_blobs" == "$storage_meta" && "$storage_blob_unique" == "$storage_blobs" &&
          "$storage_meta_unique" == "$storage_meta" && "$storage_safe" == true &&
          -z "$missing_active_blobs" && -z "$missing_active_meta" && -z "$incomplete_pairs" ]]; then
      pass "ret-pvc completo: activos=$active_owned_files pares=$storage_blobs diferidos=$((storage_blobs - active_owned_files))"
    else
      fail "ret-pvc no coincide exactamente con sus pares y UUID activos"
    fi
    recovery_require_pod_identity "$reticulum_pod" "$reticulum_pod_uid" ||
      fail "El UID Reticulum cambio durante la enumeracion de storage"
  else
    fail "La enumeracion de ret-pvc fallo o contiene rutas fuera del sharding exacto"
  fi
fi

printf '\nSitting protocol\n'
if printf '%s' "$deployments_json" | jq -e '
  [.items[] | select(.metadata.name == "reticulum") |
    select(.spec.replicas == 1 and (.status.readyReplicas // 0) == 1)] | length == 1
' >/dev/null; then
  port_forward_log="$(mktemp "${TMPDIR:-/tmp}/yenhubs-ret-capabilities.XXXXXX")"
  chmod 600 "$port_forward_log"
  recovery_kubectl port-forward --address 127.0.0.1 -n "$NAMESPACE" \
    deployment/reticulum :4000 >"$port_forward_log" 2>&1 &
  port_forward_pid=$!
  forwarded_port=""
  attempt=0
  while [[ "$attempt" -lt 40 ]]; do
    if ! kill -0 "$port_forward_pid" 2>/dev/null; then
      if wait "$port_forward_pid"; then port_forward_status=0; else port_forward_status=$?; fi
      port_forward_pid=""
      fail "El port-forward de Reticulum termino antes de anunciar puerto (status=$port_forward_status)"
      break
    fi
    if forwarded_port="$(sed -nE 's/^Forwarding from 127\.0\.0\.1:([0-9]+) -> 4000$/\1/p' "$port_forward_log" | tail -1)" &&
       [[ "$forwarded_port" =~ ^[0-9]+$ && "$forwarded_port" -gt 0 && "$forwarded_port" -le 65535 ]]; then
      break
    fi
    sleep 0.25
    attempt=$((attempt + 1))
  done
  if [[ -n "$port_forward_pid" && -n "$forwarded_port" ]]; then
    sitting_capabilities=""
    attempt=0
    while [[ "$attempt" -lt 20 ]]; do
      if ! kill -0 "$port_forward_pid" 2>/dev/null; then
        if wait "$port_forward_pid"; then port_forward_status=0; else port_forward_status=$?; fi
        port_forward_pid=""
        fail "El port-forward de Reticulum murio durante la sonda (status=$port_forward_status)"
        break
      fi
      if reactivation_capture_output sitting_capabilities_candidate curl -fsS \
        --connect-timeout 1 --max-time 1 \
        "http://127.0.0.1:$forwarded_port/health/capabilities"; then
        sitting_capabilities="$sitting_capabilities_candidate"
        break
      fi
      sitting_capabilities=""
      sleep 0.25
      attempt=$((attempt + 1))
    done
    if [[ -n "$port_forward_pid" ]] && ! kill -0 "$port_forward_pid" 2>/dev/null; then
      fail "El port-forward de Reticulum no seguia vivo al aceptar la capacidad"
      sitting_capabilities=""
    fi
    if reactivation_sitting_capabilities_are_acceptable "$sitting_capabilities"; then
      pass "Reticulum confirma el contrato exacto de reservas protocol 2"
    else
      fail "Reticulum no confirma las semanticas protocol 2 de sitting"
    fi
  elif [[ -n "$port_forward_pid" ]]; then
    fail "El port-forward de Reticulum no anuncio un puerto efimero valido"
  fi
  if ! stop_port_forward; then fail "El port-forward de Reticulum no cerro de forma controlada"; fi
  if [[ -n "$port_forward_log" ]]; then rm -f -- "$port_forward_log"; port_forward_log=""; fi
else
  fail "Reticulum no esta Ready 1/1 para negociar el protocolo sitting"
fi

printf '\nHTTPS y assets\n'
if [[ "$dns_ready" == "1" && "$certificates_ready" == "1" ]]; then
  for host in "${hosts[@]}"; do
    if reactivation_capture_output http_code curl -sS -o /dev/null -w '%{http_code}' \
      --connect-timeout 10 --max-time 20 "https://$host/"; then
      case "$http_code" in
        2*|3*|404) pass "https://$host responde HTTP $http_code" ;;
        *) fail "https://$host responde HTTP ${http_code:-000}" ;;
      esac
    else
      fail "curl fallo para https://$host (salida HTTP descartada)"
    fi
  done
  if node "$SCRIPT_DIR/verify-page-assets.mjs" "https://$domain/" "https://$domain$ROOM_SMOKE_PATH"; then
    pass "Portada y sala tienen assets disponibles y CSP compatible"
  else
    fail "El contrato Hubs/Reticulum de assets o CSP no es compatible"
  fi
else
  warn "HTTPS y assets no se prueban hasta que DNS/TLS esten listos"
fi

printf '\nGhost runner\n'
if printf '%s' "$deployments_json" | jq -e '
  [.items[] | select(.metadata.name == "bot-orchestrator") |
    select(.spec.replicas == 1 and (.status.readyReplicas // 0) == 1)] | length == 1
' >/dev/null; then
  port_forward_log="$(mktemp "${TMPDIR:-/tmp}/yenhubs-bot-health.XXXXXX")"
  chmod 600 "$port_forward_log"
  recovery_kubectl port-forward --address 127.0.0.1 -n "$NAMESPACE" \
    deployment/bot-orchestrator :5001 >"$port_forward_log" 2>&1 &
  port_forward_pid=$!
  forwarded_port=""
  attempt=0
  while [[ "$attempt" -lt 40 ]]; do
    if ! kill -0 "$port_forward_pid" 2>/dev/null; then
      if wait "$port_forward_pid"; then port_forward_status=0; else port_forward_status=$?; fi
      port_forward_pid=""
      fail "El port-forward termino antes de anunciar puerto (status=$port_forward_status)"
      break
    fi
    if forwarded_port="$(sed -nE 's/^Forwarding from 127\.0\.0\.1:([0-9]+) -> 5001$/\1/p' "$port_forward_log" | tail -1)" &&
       [[ "$forwarded_port" =~ ^[0-9]+$ && "$forwarded_port" -gt 0 && "$forwarded_port" -le 65535 ]]; then
      break
    fi
    sleep 0.25
    attempt=$((attempt + 1))
  done
  if [[ -n "$port_forward_pid" && -n "$forwarded_port" ]]; then
    health=""; readiness=""; attempt=0
    while [[ "$attempt" -lt 20 ]]; do
      if ! kill -0 "$port_forward_pid" 2>/dev/null; then
        if wait "$port_forward_pid"; then port_forward_status=0; else port_forward_status=$?; fi
        port_forward_pid=""
        fail "El port-forward murio durante las sondas (status=$port_forward_status)"
        break
      fi
      if reactivation_capture_output health_candidate curl -fsS --connect-timeout 1 --max-time 1 \
        "http://127.0.0.1:$forwarded_port/health"; then
        health="$health_candidate"
      else
        health=""
      fi
      if reactivation_capture_output readiness_candidate curl -fsS --connect-timeout 1 --max-time 1 \
        "http://127.0.0.1:$forwarded_port/ready"; then
        readiness="$readiness_candidate"
      else
        readiness=""
      fi
      if [[ -n "$health" && -n "$readiness" ]]; then break; fi
      sleep 0.25
      attempt=$((attempt + 1))
    done
    if [[ -n "$port_forward_pid" ]] && ! kill -0 "$port_forward_pid" 2>/dev/null; then
      fail "El port-forward no seguia vivo al aceptar las respuestas"
      health=""; readiness=""
    fi
    if reactivation_bot_health_is_acceptable "$health"; then
      pass "Orchestrator live confirma ghost/navmesh/modelo y limites"
    else
      fail "El endpoint /health no confirma el contrato auditado"
    fi
    if reactivation_bot_readiness_is_acceptable "$readiness"; then
      pass "Orchestrator readiness autoritativa, fresca y exacta"
    else
      fail "El endpoint /ready no confirma todos los runners configurados"
    fi
  elif [[ -n "$port_forward_pid" ]]; then
    fail "El port-forward no anuncio un puerto efimero valido"
  fi
  if ! stop_port_forward; then fail "El port-forward no cerro de forma controlada"; fi
  if [[ -n "$port_forward_log" ]]; then rm -f -- "$port_forward_log"; port_forward_log=""; fi
else
  fail "bot-orchestrator no esta Ready 1/1"
fi

printf '\nSummary: %d failure(s), %d warning(s)\n' "$failures" "$warnings"
if ! reactivation_live_result_is_clean "$failures" "$warnings"; then
  exit 1
fi

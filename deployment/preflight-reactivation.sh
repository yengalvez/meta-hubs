#!/usr/bin/env bash

# Read-only readiness checks for restoring a frozen YenHubs deployment. The
# script never creates, updates or deletes cloud resources and never prints
# secret values.

set -uo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=deployment/lib/reactivation-gate-functions.sh
source "$SCRIPT_DIR/lib/reactivation-gate-functions.sh"
# shellcheck source=deployment/lib/recovery-safety.sh
source "$SCRIPT_DIR/lib/recovery-safety.sh"

VALUES_SOURCE_FILE="${VALUES_FILE:-$SCRIPT_DIR/input-values.local.yaml}"
VALUES_FILE=""
BACKUP_DIR="${BACKUP_DIR:-}"
DUMP_PATH="${DUMP_PATH:-}"
RET_STORAGE_ARCHIVE="${RET_STORAGE_ARCHIVE:-}"
MAX_CHECKPOINT_AGE_SECONDS="${MAX_CHECKPOINT_AGE_SECONDS:-86400}"
DOCTL_CONTEXT="${DOCTL_CONTEXT:-yenhubs}"
CLUSTER_NAME="${CLUSTER_NAME:-hubs-ce}"
NAMESPACE="${NAMESPACE:-hcce}"

reactivation_install_cleanup_traps ""

failures=0
warnings=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; failures=$((failures + 1)); }
warn() { printf 'WARN  %s\n' "$1"; warnings=$((warnings + 1)); }

yaml_value() {
  node "$SCRIPT_DIR/parse-local-values.mjs" "$VALUES_FILE" --get "$1"
}

check_command() {
  if command -v "$1" >/dev/null 2>&1; then
    pass "Comando disponible: $1"
  else
    fail "Falta el comando requerido: $1"
  fi
}

check_submodule() {
  local path="$1"
  local expected actual
  if ! expected="$(git -C "$ROOT_DIR" ls-tree HEAD "$path" | awk '{print $3}')" ||
     [[ ! "$expected" =~ ^[a-fA-F0-9]{40}$ ]]; then
    fail "No se pudo leer el gitlink fijado para $path"
    return
  fi
  if ! actual="$(git -C "$ROOT_DIR/$path" rev-parse HEAD 2>/dev/null)"; then
    fail "No se pudo leer el commit actual de $path"
    return
  fi
  if [[ "$actual" == "$expected" ]]; then
    pass "$path coincide con el commit fijado por el superproyecto (${actual:0:12})"
  else
    fail "$path no coincide con el commit fijado (esperado ${expected:0:12}, actual ${actual:0:12})"
  fi
}

check_ghcr_image() {
  local image="$1"
  local github_token="$2"
  local without_registry owner repository reference auth_file bearer_response bearer http_code
  if [[ ! "$image" =~ ^ghcr\.io/[A-Za-z0-9._-]+/[A-Za-z0-9._/-]+@sha256:[a-fA-F0-9]{64}$ ]]; then
    fail "Referencia GHCR no fijada por digest exacto"
    return
  fi
  without_registry="${image#ghcr.io/}"
  owner="${without_registry%%/*}"
  repository="${without_registry#*/}"
  reference="${repository#*@}"
  repository="${repository%@*}"
  auth_file="$(mktemp "${TMPDIR:-/tmp}/yenhubs-ghcr-auth.XXXXXX")"
  reactivation_register_temp_path "$auth_file"
  chmod 600 "$auth_file"
  if [[ -n "$github_token" ]]; then
    if [[ "$github_token" == *$'\n'* || "$github_token" == *$'\r'* || "$github_token" == *'"'* ]]; then
      fail "La credencial GHCR local contiene caracteres no permitidos"
      return
    fi
    printf 'user = "%s:%s"\nsilent\nshow-error\n' "$owner" "$github_token" >"$auth_file"
  else
    printf 'silent\nshow-error\n' >"$auth_file"
  fi
  if ! reactivation_capture_output bearer_response curl --config "$auth_file" \
    "https://ghcr.io/token?service=ghcr.io&scope=repository:${owner}/${repository}:pull"; then
    fail "GHCR fallo al solicitar token de lectura para ${owner}/${repository}"
    return
  fi
  if ! bearer="$(printf '%s' "$bearer_response" | jq -er '.token | select(type == "string" and length > 0)')"; then
    fail "GHCR no entrego un token de lectura para ${owner}/${repository}"
    return
  fi
  if ! reactivation_write_curl_bearer_config "$auth_file" "$bearer"; then
    fail "No se pudo preparar autenticacion GHCR sin exponerla en argv"
    return
  fi
  unset bearer bearer_response
  if ! reactivation_capture_output http_code curl --config "$auth_file" \
    -sS -o /dev/null -w '%{http_code}' \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
    "https://ghcr.io/v2/${owner}/${repository}/manifests/${reference}"; then
    fail "GHCR fallo al comprobar ${owner}/${repository}"
    return
  fi
  if [[ "$http_code" == "200" ]]; then
    pass "Imagen accesible y fijada por digest: ${owner}/${repository}"
  else
    fail "Imagen no accesible: ${owner}/${repository} (HTTP $http_code)"
  fi
}

check_dockerhub_image() {
  local image="$1"
  local repository reference token_response bearer auth_file http_code
  repository="${image%@sha256:*}"
  reference="sha256:${image##*@sha256:}"
  repository="${repository#docker.io/}"
  [[ "$repository" == */* ]] || repository="library/$repository"
  [[ "$repository" =~ ^[A-Za-z0-9._/-]+$ &&
     "$reference" =~ ^sha256:[a-fA-F0-9]{64}$ ]] || {
    fail "Referencia Docker Hub no fijada por digest exacto"
    return
  }
  auth_file="$(mktemp "${TMPDIR:-/tmp}/yenhubs-dockerhub-auth.XXXXXX")"
  reactivation_register_temp_path "$auth_file"
  chmod 600 "$auth_file"
  printf 'silent\nshow-error\n' >"$auth_file"
  if ! reactivation_capture_output token_response curl --config "$auth_file" \
    "https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull"; then
    fail "Docker Hub fallo al solicitar token de lectura para $repository"
    return
  fi
  bearer="$(jq -er '.token | select(type == "string" and length > 0)' \
    <<<"$token_response")" || {
    fail "Docker Hub no entrego token de lectura para $repository"
    return
  }
  reactivation_write_curl_bearer_config "$auth_file" "$bearer" || {
    fail "No se pudo preparar autenticacion Docker Hub sin exponerla en argv"
    return
  }
  unset bearer token_response
  if ! reactivation_capture_output http_code curl --config "$auth_file" \
    -sS -o /dev/null -w '%{http_code}' \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
    "https://registry-1.docker.io/v2/${repository}/manifests/${reference}"; then
    fail "Docker Hub fallo al comprobar $repository"
  elif [[ "$http_code" == 200 ]]; then
    pass "Imagen accesible y fijada por digest: $repository"
  else
    fail "Imagen no accesible: $repository (HTTP $http_code)"
  fi
}

check_registry_image() {
  local pair="$1"
  local image="$2"
  local github_token="$3"
  if ! reactivation_image_for_pair_is_trusted "$pair" "$image"; then
    fail "Repositorio no allowlisted para $pair"
    return
  fi
  case "$image" in
    ghcr.io/*)
      check_ghcr_image "$image" "$github_token"
      ;;
    docker.io/* | postgres@* | haproxytech/* | mozillareality/* | edoburu/* | postgrest/*)
      check_dockerhub_image "$image"
      ;;
    *)
      fail "Registro no soportado por el pull preflight para $pair"
      ;;
  esac
}

printf 'YenHubs reactivation preflight\n'
printf 'Root: %s\n\n' "$ROOT_DIR"

for command_name in git node npm doctl kubectl helm jq curl openssl gzip tar; do
  check_command "$command_name"
done
if ! command -v shasum >/dev/null 2>&1 && ! command -v sha256sum >/dev/null 2>&1; then
  fail "Falta un verificador SHA-256 (shasum o sha256sum)"
fi

printf '\nGit\n'
if current_branch="$(git -C "$ROOT_DIR" branch --show-current)"; then
  if [[ "$current_branch" == "main" ]]; then pass "Superproyecto en main"; else warn "Superproyecto no esta en main"; fi
else
  fail "No se pudo leer la rama del superproyecto"
fi
check_submodule hubs
check_submodule hubs-cloud
if root_status="$(git -C "$ROOT_DIR" status --short --untracked-files=no)"; then
  if [[ -n "$root_status" ]]; then warn "El superproyecto tiene cambios trackeados sin commit"; else pass "No hay cambios trackeados pendientes"; fi
else
  fail "No se pudo leer el estado Git del superproyecto"
fi

printf '\nBackup\n'
CHECKPOINT_VALID=false
if [[ -z "$BACKUP_DIR" ]]; then
  fail "BACKUP_DIR debe señalar explicitamente el checkpoint de este rollout"
elif [[ ! -d "$BACKUP_DIR" || -L "$BACKUP_DIR" ]] ||
     recovery_path_has_symlink_component "$BACKUP_DIR"; then
  fail "BACKUP_DIR no es un directorio regular y directo"
elif ! resolved_backup_dir="$(cd "$BACKUP_DIR" && pwd -P)"; then
  fail "No se pudo resolver BACKUP_DIR"
else
  BACKUP_DIR="$resolved_backup_dir"
  metadata_path="$BACKUP_DIR/checkpoint-metadata.json"
  if ! recovery_require_regular_direct_file "$metadata_path"; then
    fail "checkpoint-metadata.json no es un fichero regular directo"
  elif ! recovery_checkpoint_metadata_is_acceptable \
    "$metadata_path" "$(jq -r '.stamp // empty' "$metadata_path" 2>/dev/null)" ||
       ! metadata_json="$(jq -ce '
    select(.schema_version == 2) |
    select(.provenance == {generator:"yenhubs-local-coordinated-checkpoint-v2",external_import:false}) |
    select(.stamp | type == "string" and test("^[0-9]{8}-[0-9]{6}$")) |
    select(.created_at_epoch | type == "number" and floor == .) |
    select(.kube_context | type == "string" and length > 0) |
    select(.namespace | type == "string" and length > 0) |
    select(.namespace_uid | type == "string" and length > 0)
  ' "$metadata_path" 2>/dev/null)"; then
    fail "checkpoint-metadata.json falta, no prueba quiescencia local o no cumple el contrato"
  else
    checkpoint_stamp="$(printf '%s' "$metadata_json" | jq -r '.stamp')"
    checkpoint_epoch="$(printf '%s' "$metadata_json" | jq -r '.created_at_epoch')"
    checkpoint_context="$(printf '%s' "$metadata_json" | jq -r '.kube_context')"
    checkpoint_namespace="$(printf '%s' "$metadata_json" | jq -r '.namespace')"
    checkpoint_namespace_uid="$(printf '%s' "$metadata_json" | jq -r '.namespace_uid')"
    if [[ ! "$MAX_CHECKPOINT_AGE_SECONDS" =~ ^[0-9]+$ || "$MAX_CHECKPOINT_AGE_SECONDS" -eq 0 ]]; then
      fail "MAX_CHECKPOINT_AGE_SECONDS debe ser un entero positivo"
    else
      now_epoch="$(date -u '+%s')"
      checkpoint_age=$((now_epoch - checkpoint_epoch))
      if ! reactivation_checkpoint_age_is_acceptable \
        "$checkpoint_epoch" "$now_epoch" "$MAX_CHECKPOINT_AGE_SECONDS"; then
        fail "El checkpoint no es fresco para este rollout (edad=${checkpoint_age}s limite=${MAX_CHECKPOINT_AGE_SECONDS}s)"
      else
        pass "Checkpoint fresco para este rollout (edad=${checkpoint_age}s)"
      fi
    fi
    expected_dump="$BACKUP_DIR/retdb-$checkpoint_stamp.sql.gz"
    expected_storage="$BACKUP_DIR/ret-storage-$checkpoint_stamp.tar.gz"
    if [[ -n "$DUMP_PATH" && "$DUMP_PATH" != "$expected_dump" ]]; then
      fail "DUMP_PATH no coincide exactamente con el checkpoint de BACKUP_DIR"
    fi
    if [[ -n "$RET_STORAGE_ARCHIVE" && "$RET_STORAGE_ARCHIVE" != "$expected_storage" ]]; then
      fail "RET_STORAGE_ARCHIVE no coincide exactamente con el checkpoint de BACKUP_DIR"
    fi
    DUMP_PATH="$expected_dump"
    RET_STORAGE_ARCHIVE="$expected_storage"
    if recovery_verify_checkpoint_directory "$BACKUP_DIR" "$checkpoint_stamp" &&
       "$SCRIPT_DIR/validate-checkpoint.sh" "$DUMP_PATH" "$RET_STORAGE_ARCHIVE" >/dev/null; then
      CHECKPOINT_VALID=true
      pass "Checkpoint exacto, completo, checksummed y validado conjuntamente"
    else
      fail "El checkpoint no supera layout, SHA256SUMS o validacion conjunta"
    fi
    if [[ "$checkpoint_namespace" != "$NAMESPACE" ]]; then
      fail "El namespace del checkpoint no coincide con NAMESPACE"
    fi
    if [[ -n "${EXPECTED_KUBE_CONTEXT:-}" && "$checkpoint_context" != "$EXPECTED_KUBE_CONTEXT" ]]; then
      fail "El contexto fijado no coincide con el checkpoint"
    fi
    if [[ -n "${EXPECTED_NAMESPACE_UID:-}" && "$checkpoint_namespace_uid" != "$EXPECTED_NAMESPACE_UID" ]]; then
      fail "El UID de namespace fijado no coincide con el checkpoint"
    fi
    if recovery_deployment_inventory_is_acceptable \
      "$BACKUP_DIR/deployment-images.json" "$checkpoint_namespace" "$checkpoint_namespace_uid"; then
      pass "Inventario de Deployments exacto, unico y fijado por digest"
    else
      fail "El inventario de Deployments no cumple el contrato exacto"
    fi
  fi
fi

printf '\nConfiguracion local\n'
VALUES_PARSE_OK=false
if [[ ! -f "$VALUES_SOURCE_FILE" || -L "$VALUES_SOURCE_FILE" ]]; then
  fail "No existe un fichero de valores local regular"
else
  if values_mode="$(reactivation_file_mode "$VALUES_SOURCE_FILE")" && [[ "$values_mode" == "600" ]]; then
    pass "Permisos de valores locales: 600"
  else
    fail "Permisos inseguros de valores locales (requerido 600)"
  fi
  if reactivation_snapshot_private_file VALUES_FILE "$VALUES_SOURCE_FILE" &&
     node "$SCRIPT_DIR/parse-local-values.mjs" "$VALUES_FILE" --validate; then
    VALUES_PARSE_OK=true
    pass "Snapshot privado unico de valores limitado a escalares top-level seguros"
  else
    fail "El YAML local no cumple el subconjunto seguro"
  fi
fi

github_token="${GITHUBTOKEN:-}"
if [[ "$VALUES_PARSE_OK" == true ]]; then
  required_keys=(
    HUB_DOMAIN ADM_EMAIL DB_USER DB_PASS SMTP_SERVER SMTP_PORT SMTP_USER SMTP_PASS
    NODE_COOKIE GUARDIAN_KEY PHX_KEY PERMS_KEY BOT_ACCESS_KEY BOT_RUNNER_ACCESS_KEY
    BOT_ORCHESTRATOR_ACCESS_KEY DASHBOARD_ACCESS_KEY OPENAI_API_KEY
    GENERATE_PERSISTENT_VOLUMES PERSISTENT_VOLUME_STORAGE_CLASS PERSISTENT_VOLUME_SIZE
    OVERRIDE_HUBS_IMAGE OVERRIDE_RETICULUM_IMAGE OVERRIDE_BOT_ORCHESTRATOR_IMAGE
    OVERRIDE_COTURN_IMAGE OVERRIDE_DIALOG_IMAGE OVERRIDE_HAPROXY_IMAGE
    OVERRIDE_NEARSPARK_IMAGE OVERRIDE_PGBOUNCER_IMAGE
    OVERRIDE_PHOTOMNEMONIC_IMAGE OVERRIDE_POSTGRES_IMAGE
    OVERRIDE_POSTGREST_IMAGE OVERRIDE_SPOKE_IMAGE
  )
  for key in "${required_keys[@]}"; do
    if value="$(yaml_value "$key")" && [[ -n "$value" ]]; then
      pass "Valor requerido configurado: $key"
    else
      fail "Valor requerido ausente o vacio: $key"
    fi
  done
  bot_access_key="$(yaml_value BOT_ACCESS_KEY)"
  bot_runner_access_key="$(yaml_value BOT_RUNNER_ACCESS_KEY)"
  bot_orchestrator_access_key="$(yaml_value BOT_ORCHESTRATOR_ACCESS_KEY)"
  dashboard_access_key="$(yaml_value DASHBOARD_ACCESS_KEY)"
  if [[ ${#bot_access_key} -ge 32 && ${#bot_runner_access_key} -ge 32 &&
        ${#bot_orchestrator_access_key} -ge 32 && ${#dashboard_access_key} -ge 32 ]]; then
    pass "Las cuatro credenciales internas tienen al menos 32 caracteres"
  else
    fail "Cada credencial interna debe tener al menos 32 caracteres"
  fi
  if [[ "$bot_access_key" != "$bot_runner_access_key" &&
        "$bot_access_key" != "$bot_orchestrator_access_key" &&
        "$bot_access_key" != "$dashboard_access_key" &&
        "$bot_runner_access_key" != "$bot_orchestrator_access_key" &&
        "$bot_runner_access_key" != "$dashboard_access_key" &&
        "$bot_orchestrator_access_key" != "$dashboard_access_key" ]]; then
    pass "Las cuatro credenciales internas pertenecen a dominios distintos"
  else
    fail "Las cuatro credenciales internas deben ser distintas"
  fi
  unset bot_access_key bot_runner_access_key bot_orchestrator_access_key dashboard_access_key
  if [[ "$(yaml_value GENERATE_PERSISTENT_VOLUMES)" == "true" ]]; then
    pass "La generacion de almacenamiento persistente esta habilitada"
  else
    fail "GENERATE_PERSISTENT_VOLUMES debe ser true"
  fi
  if [[ "$(yaml_value PERSISTENT_VOLUME_STORAGE_CLASS)" == "do-block-storage" ]]; then
    pass "La clase de storage persistente coincide con DigitalOcean"
  else
    fail "PERSISTENT_VOLUME_STORAGE_CLASS debe ser do-block-storage; manual/hostPath no es durable"
  fi
  hubs_image="$(yaml_value OVERRIDE_HUBS_IMAGE)"
  reticulum_image="$(yaml_value OVERRIDE_RETICULUM_IMAGE)"
  bot_image="$(yaml_value OVERRIDE_BOT_ORCHESTRATOR_IMAGE)"
  CORE_IMAGES_VALID=true
  if reactivation_image_override_is_exact hubs "$hubs_image"; then
    pass "OVERRIDE_HUBS_IMAGE exacto"
  else
    CORE_IMAGES_VALID=false
    fail "OVERRIDE_HUBS_IMAGE debe ser ghcr.io/yengalvez/hubs@sha256:<64hex>"
  fi
  if reactivation_image_override_is_exact reticulum "$reticulum_image"; then
    pass "OVERRIDE_RETICULUM_IMAGE exacto"
  else
    CORE_IMAGES_VALID=false
    fail "OVERRIDE_RETICULUM_IMAGE debe ser ghcr.io/yengalvez/reticulum@sha256:<64hex>"
  fi
  if reactivation_image_override_is_exact bot-orchestrator "$bot_image"; then
    pass "OVERRIDE_BOT_ORCHESTRATOR_IMAGE exacto"
  else
    CORE_IMAGES_VALID=false
    fail "OVERRIDE_BOT_ORCHESTRATOR_IMAGE debe ser ghcr.io/yengalvez/bot-orchestrator@sha256:<64hex>"
  fi
  EXPECTED_IMAGES_JSON="$(jq -cn \
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
  ALL_IMAGES_VALID=false
  if reactivation_image_map_is_trusted "$EXPECTED_IMAGES_JSON"; then
    ALL_IMAGES_VALID=true
    pass "Los 13 overrides usan repositorios allowlisted y digests exactos"
  else
    fail "Los 13 overrides deben usar el par/repo allowlisted y digest exacto"
  fi
  if [[ "$CHECKPOINT_VALID" == true && "$CORE_IMAGES_VALID" == true ]]; then
    if [[ "$ALL_IMAGES_VALID" == true ]] &&
       recovery_deployment_inventory_is_acceptable \
         "$BACKUP_DIR/deployment-images.json" "$checkpoint_namespace" \
         "$checkpoint_namespace_uid" "$EXPECTED_IMAGES_JSON"; then
      pass "Inventario del checkpoint ligado a los 13 overrides exactos"
    else
      fail "Inventario del checkpoint no coincide con los overrides configurados"
    fi
  fi
  if [[ -z "$github_token" ]]; then
    github_token="$(yaml_value GITHUBTOKEN)"
  fi
fi

printf '\nServicios externos y cost gate\n'
DOCTL_AUTHENTICATED=false
CLUSTER_QUERY_OK=false
CLUSTER_EXISTS=false
KUBE_TARGET_VERIFIED=false
cluster_json='[]'
if doctl account get --context "$DOCTL_CONTEXT" >/dev/null 2>&1; then
  DOCTL_AUTHENTICATED=true
  pass "DigitalOcean autenticado (contexto: $DOCTL_CONTEXT)"
else
  fail "DigitalOcean no autenticado en el contexto $DOCTL_CONTEXT"
fi
if [[ "$DOCTL_AUTHENTICATED" == true ]]; then
  if cluster_list_json="$(doctl kubernetes cluster list --context "$DOCTL_CONTEXT" -o json)" &&
     printf '%s' "$cluster_list_json" | jq -e 'type == "array"' >/dev/null; then
    CLUSTER_QUERY_OK=true
    cluster_json="$(printf '%s' "$cluster_list_json" | jq -c --arg name "$CLUSTER_NAME" '[.[] | select(.name == $name)]')"
    cluster_count="$(printf '%s' "$cluster_json" | jq 'length')"
    if [[ "$cluster_count" == "1" ]]; then
      CLUSTER_EXISTS=true
      pass "Cluster existente identificado de forma unica"
    elif [[ "$cluster_count" == "0" ]]; then
      warn "El cluster $CLUSTER_NAME no existe; crearlo requiere aprobacion explicita de coste"
    else
      fail "Hay varios clusters con el nombre esperado"
    fi
  else
    fail "doctl no pudo enumerar clusters de forma valida"
  fi
fi

if [[ "$CLUSTER_EXISTS" == true ]]; then
  if [[ -z "${EXPECTED_KUBE_CONTEXT:-}" || -z "${EXPECTED_NAMESPACE_UID:-}" ]]; then
    fail "El cluster existe pero faltan EXPECTED_KUBE_CONTEXT/EXPECTED_NAMESPACE_UID"
  elif recovery_require_cluster_identity; then
    KUBE_TARGET_VERIFIED=true
    pass "Destino Kubernetes fijado: contexto=$EXPECTED_KUBE_CONTEXT namespace=$NAMESPACE uid=$RECOVERY_NAMESPACE_UID"
  else
    fail "El cluster existe pero su identidad Kubernetes no coincide o no puede leerse"
  fi
fi

if [[ "$KUBE_TARGET_VERIFIED" == true ]]; then
  reticulum_deployment_json=""
  reticulum_deployment_uid=""
  reticulum_hpas_json=""
  reticulum_pods_json=""
  if reticulum_deployment_json="$(recovery_kubectl get deployment reticulum -n "$NAMESPACE" -o json)" &&
     reactivation_reticulum_deployment_is_singleton "$reticulum_deployment_json"; then
    reticulum_deployment_uid="$(jq -er '.metadata.uid' <<<"$reticulum_deployment_json")"
    pass "Reticulum preflight: replicas=1 y Recreate exacto"
  else
    fail "Reticulum preflight no conserva una unica autoridad de proceso"
  fi
  if reticulum_hpas_json="$(recovery_kubectl get horizontalpodautoscaler -n "$NAMESPACE" -o json)" &&
     reactivation_hpas_do_not_target_reticulum "$reticulum_hpas_json"; then
    pass "Reticulum preflight: ningun HPA lo puede escalar"
  else
    fail "Reticulum preflight no pudo excluir un HPA dirigido al Deployment"
  fi
  if reticulum_pods_json="$(recovery_kubectl get pod -n "$NAMESPACE" -l app=reticulum -o json)" &&
     reticulum_pod_info="$(recovery_exact_ready_pod_info "$reticulum_pods_json" reticulum)"; then
    IFS=$'\t' read -r reticulum_pod reticulum_pod_uid <<<"$reticulum_pod_info"
    reticulum_pod_json="$(jq -ce '.items[0]' <<<"$reticulum_pods_json")"
    if [[ -n "${reticulum_deployment_uid:-}" ]] &&
       recovery_require_pod_deployment_ownership "$reticulum_pod_json" reticulum \
         "$reticulum_deployment_uid" &&
       recovery_require_pod_identity "$reticulum_pod" "$reticulum_pod_uid"; then
      pass "Reticulum preflight: exactamente un pod Ready con UID y owner verificados"
    else
      fail "Reticulum preflight no pudo fijar UID/owner del pod unico"
    fi
  else
    fail "Reticulum preflight requiere exactamente un pod Ready"
  fi
fi

if [[ "$CLUSTER_EXISTS" == true ]]; then
  cluster_id="$(printf '%s' "$cluster_json" | jq -r '.[0].id')"
  cluster_region="$(printf '%s' "$cluster_json" | jq -r '.[0].region')"
  cluster_state="$(printf '%s' "$cluster_json" | jq -r '.[0].status.state')"
  cluster_ha="$(printf '%s' "$cluster_json" | jq -r '.[0].ha // false')"
  pool_count="$(printf '%s' "$cluster_json" | jq '.[0].node_pools | length')"
  pool_size="$(printf '%s' "$cluster_json" | jq -r '.[0].node_pools[0].size // empty')"
  node_count="$(printf '%s' "$cluster_json" | jq -r '.[0].node_pools[0].count // 0')"
  if [[ "$cluster_region" == "ams3" && "$cluster_state" == "running" ]]; then pass "Cluster activo en ams3"; else fail "Region o estado de cluster inesperado"; fi
  if [[ "$cluster_ha" == "false" ]]; then pass "Control plane HA desactivado"; else fail "Control plane HA activado; incrementa el coste"; fi
  if [[ "$pool_count" == "1" && "$pool_size" == "s-4vcpu-8gb" && "$node_count" == "1" ]]; then
    pass "Un unico nodo s-4vcpu-8gb"
  else
    fail "Topologia de nodos inesperada"
  fi
  if volume_json="$(doctl compute volume list --context "$DOCTL_CONTEXT" -o json)" &&
     printf '%s' "$volume_json" | jq -e 'type == "array"' >/dev/null; then
    cluster_volume_count="$(printf '%s' "$volume_json" | jq --arg tag "k8s:$cluster_id" '[.[] | select((.tags // []) | index($tag))] | length')"
    cluster_volume_sizes="$(printf '%s' "$volume_json" | jq -r --arg tag "k8s:$cluster_id" '[.[] | select((.tags // []) | index($tag)) | .size_gigabytes] | sort | join(",")')"
    if [[ "$cluster_volume_count" == "2" && "$cluster_volume_sizes" == "10,10" ]]; then pass "Dos volumenes DOKS de 10 GiB"; else fail "Volumenes del cluster inesperados"; fi
  else
    fail "doctl no pudo enumerar volumenes de forma valida"
  fi
  if [[ "$KUBE_TARGET_VERIFIED" == true ]]; then
    if lb_ip="$(recovery_kubectl get service lb -n "$NAMESPACE" -o jsonpath='{.status.loadBalancer.ingress[0].ip}')" && [[ -n "$lb_ip" ]]; then
      if load_balancer_json="$(doctl compute load-balancer list --context "$DOCTL_CONTEXT" -o json)" &&
         printf '%s' "$load_balancer_json" | jq -e 'type == "array"' >/dev/null; then
        matching_lbs="$(printf '%s' "$load_balancer_json" | jq --arg ip "$lb_ip" '[.[] | select(.ip == $ip)] | length')"
        if [[ "$matching_lbs" == "1" ]]; then pass "Un unico Load Balancer coincide con el servicio lb"; else fail "Correlacion de Load Balancer inesperada"; fi
      else
        fail "doctl no pudo enumerar Load Balancers de forma valida"
      fi
    else
      fail "kubectl no pudo leer una IP de Load Balancer valida"
    fi
  fi
fi

if [[ "$VALUES_PARSE_OK" == true ]]; then
  while IFS=$'\t' read -r image_pair image_reference; do
    check_registry_image "$image_pair" "$image_reference" "$github_token"
  done < <(jq -r 'to_entries[] | [.key,.value] | @tsv' <<<"$EXPECTED_IMAGES_JSON")
fi
unset github_token value

if [[ "$CHECKPOINT_VALID" != true ]]; then
  fail "No hay checkpoint valido seleccionado para el rollout"
fi
if [[ "$CLUSTER_QUERY_OK" != true && "$DOCTL_AUTHENTICATED" == true ]]; then
  fail "No se pudo determinar si el cluster existe"
fi

printf '\nSummary: %d failure(s), %d warning(s)\n' "$failures" "$warnings"
if ((failures > 0)); then
  exit 1
fi

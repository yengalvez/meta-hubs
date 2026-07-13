#!/usr/bin/env bash

# Read-only readiness checks for restoring the frozen YenHubs deployment.
# The script never creates, updates, or deletes cloud resources and never prints secrets.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VALUES_FILE="${VALUES_FILE:-$SCRIPT_DIR/input-values.local.yaml}"
BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/output/project-freeze-20260316-090114}"

failures=0
warnings=0

pass() {
  printf 'PASS  %s\n' "$1"
}

fail() {
  printf 'FAIL  %s\n' "$1"
  failures=$((failures + 1))
}

warn() {
  printf 'WARN  %s\n' "$1"
  warnings=$((warnings + 1))
}

yaml_value() {
  local key="$1"
  awk -v key="$key" '
    $0 ~ "^" key ":[[:space:]]*" {
      sub("^" key ":[[:space:]]*", "")
      sub(/[[:space:]]+#.*$/, "")
      gsub(/^[[:space:]\047\"]+|[[:space:]\047\"]+$/, "")
      print
      exit
    }
  ' "$VALUES_FILE"
}

check_command() {
  local command_name="$1"
  if command -v "$command_name" >/dev/null 2>&1; then
    pass "Comando disponible: $command_name"
  else
    fail "Falta el comando requerido: $command_name"
  fi
}

check_submodule() {
  local path="$1"
  local expected actual
  expected="$(git -C "$ROOT_DIR" ls-tree HEAD "$path" | awk '{print $3}')"
  actual="$(git -C "$ROOT_DIR/$path" rev-parse HEAD 2>/dev/null || true)"

  if [[ -n "$expected" && "$actual" == "$expected" ]]; then
    pass "$path coincide con el commit fijado por el superproyecto (${actual:0:12})"
  else
    fail "$path no coincide con el commit fijado (esperado ${expected:0:12}, actual ${actual:0:12})"
  fi
}

check_ghcr_image() {
  local image="$1"
  local github_token="$2"

  if [[ "$image" != ghcr.io/*:* ]]; then
    warn "No se comprueba una imagen no-GHCR: ${image%%:*}"
    return
  fi

  local without_registry owner repository tag auth_file bearer http_code
  without_registry="${image#ghcr.io/}"
  owner="${without_registry%%/*}"
  repository="${without_registry#*/}"
  tag="${repository#*:}"
  repository="${repository%%:*}"
  auth_file="$(mktemp /tmp/yenhubs-ghcr-auth.XXXXXX)"
  chmod 600 "$auth_file"
  printf 'user = "%s:%s"\nsilent\nshow-error\n' "$owner" "$github_token" >"$auth_file"

  bearer="$(
    curl --config "$auth_file" \
      "https://ghcr.io/token?service=ghcr.io&scope=repository:${owner}/${repository}:pull" 2>/dev/null |
      jq -r '.token // empty'
  )"
  rm -f "$auth_file"

  if [[ -z "$bearer" ]]; then
    fail "GHCR no entrego un token de lectura para ${owner}/${repository}"
    return
  fi

  http_code="$(
    curl -sS -o /dev/null -w '%{http_code}' \
      -H "Authorization: Bearer $bearer" \
      -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
      "https://ghcr.io/v2/${owner}/${repository}/manifests/${tag}"
  )"

  if [[ "$http_code" == "200" ]]; then
    pass "Imagen accesible: ghcr.io/${owner}/${repository}:${tag}"
  else
    fail "Imagen no accesible: ghcr.io/${owner}/${repository}:${tag} (HTTP $http_code)"
  fi
}

printf 'YenHubs reactivation preflight\n'
printf 'Root: %s\n\n' "$ROOT_DIR"

for command_name in git node npm doctl kubectl helm jq curl openssl gzip; do
  check_command "$command_name"
done

printf '\nGit\n'
if [[ "$(git -C "$ROOT_DIR" branch --show-current)" == "main" ]]; then
  pass "Superproyecto en main"
else
  warn "Superproyecto no esta en main"
fi
check_submodule hubs
check_submodule hubs-cloud

if [[ -n "$(git -C "$ROOT_DIR" status --short --untracked-files=no)" ]]; then
  warn "El superproyecto tiene cambios trackeados sin commit"
else
  pass "No hay cambios trackeados pendientes en el superproyecto"
fi

printf '\nBackup\n'
for backup_file in \
  "$BACKUP_DIR/retdb-20260316-090114.sql.gz" \
  "$BACKUP_DIR/deployment-images.txt" \
  "$BACKUP_DIR/k8s-hcce-core.yaml" \
  "$BACKUP_DIR/git-heads.env"; do
  if [[ -s "$backup_file" ]]; then
    pass "Backup presente: $(basename "$backup_file")"
  else
    fail "Backup ausente o vacio: $backup_file"
  fi
done

if gzip -t "$BACKUP_DIR/retdb-20260316-090114.sql.gz" 2>/dev/null; then
  pass "Dump PostgreSQL gzip integro"
else
  fail "Dump PostgreSQL gzip corrupto o ilegible"
fi

printf '\nConfiguracion local\n'
if [[ -f "$VALUES_FILE" ]]; then
  pass "Valores locales presentes"
else
  fail "No existe $VALUES_FILE"
fi

if [[ -f "$VALUES_FILE" ]]; then
  if [[ "$(uname -s)" == "Darwin" ]]; then
    values_mode="$(stat -f '%Lp' "$VALUES_FILE")"
  else
    values_mode="$(stat -c '%a' "$VALUES_FILE")"
  fi
  if [[ "$values_mode" == "600" ]]; then
    pass "Permisos de valores locales: 600"
  else
    warn "Permisos de valores locales: $values_mode (recomendado 600)"
  fi

  required_keys=(
    HUB_DOMAIN ADM_EMAIL DB_USER DB_PASS SMTP_SERVER SMTP_PORT SMTP_USER SMTP_PASS
    NODE_COOKIE GUARDIAN_KEY PHX_KEY PERMS_KEY BOT_ACCESS_KEY OPENAI_API_KEY GITHUBTOKEN
    OVERRIDE_HUBS_IMAGE OVERRIDE_RETICULUM_IMAGE OVERRIDE_BOT_ORCHESTRATOR_IMAGE
  )
  for key in "${required_keys[@]}"; do
    value="$(yaml_value "$key")"
    if [[ -n "$value" ]]; then
      pass "Valor requerido configurado: $key"
    else
      fail "Valor requerido ausente o vacio: $key"
    fi
  done
fi

printf '\nServicios externos\n'
if doctl account get >/dev/null 2>&1; then
  pass "DigitalOcean autenticado"
else
  fail "DigitalOcean no autenticado; ejecutar doctl auth init antes de crear el cluster"
fi

if [[ -f "$VALUES_FILE" ]]; then
  github_token="$(yaml_value GITHUBTOKEN)"
  if [[ -n "$github_token" ]]; then
    github_http="$(
      curl -sS -o /dev/null -w '%{http_code}' \
        -H "Authorization: Bearer $github_token" \
        -H 'Accept: application/vnd.github+json' \
        https://api.github.com/user
    )"
    if [[ "$github_http" == "200" ]]; then
      pass "GitHub autenticado"
      check_ghcr_image "$(yaml_value OVERRIDE_HUBS_IMAGE)" "$github_token"
      check_ghcr_image "$(yaml_value OVERRIDE_RETICULUM_IMAGE)" "$github_token"
      check_ghcr_image "$(yaml_value OVERRIDE_BOT_ORCHESTRATOR_IMAGE)" "$github_token"
    else
      fail "GitHub no autenticado (HTTP $github_http)"
    fi
  fi
fi

printf '\nCost gate\n'
warn "Antes de crear DOKS se necesita aprobacion del coste y confirmar HA=false"

printf '\nSummary: %d failure(s), %d warning(s)\n' "$failures" "$warnings"
if ((failures > 0)); then
  exit 1
fi

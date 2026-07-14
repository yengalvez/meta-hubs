#!/usr/bin/env bash

# Read-only live acceptance checks for a restored YenHubs deployment.
# The script does not print secrets or create/update Kubernetes resources.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VALUES_FILE="${VALUES_FILE:-$SCRIPT_DIR/input-values.local.yaml}"
NAMESPACE="${NAMESPACE:-hcce}"
LOCAL_BOT_PORT="${LOCAL_BOT_PORT:-15001}"

failures=0
warnings=0
port_forward_pid=""
port_forward_log=""

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

cleanup() {
  if [[ -n "$port_forward_pid" ]]; then
    kill "$port_forward_pid" >/dev/null 2>&1 || true
    wait "$port_forward_pid" >/dev/null 2>&1 || true
  fi
  if [[ -n "$port_forward_log" ]]; then
    rm -f "$port_forward_log"
  fi
}
trap cleanup EXIT INT TERM

printf 'YenHubs live reactivation verification\n\n'

if [[ ! -f "$VALUES_FILE" ]]; then
  fail "No existe el fichero local de valores: $VALUES_FILE"
  printf '\nSummary: %d failure(s), %d warning(s)\n' "$failures" "$warnings"
  exit 1
fi

domain="$(yaml_value HUB_DOMAIN)"
if [[ -z "$domain" ]]; then
  fail "HUB_DOMAIN no esta configurado"
  printf '\nSummary: %d failure(s), %d warning(s)\n' "$failures" "$warnings"
  exit 1
fi

if ! kubectl get namespace "$NAMESPACE" >/dev/null 2>&1; then
  fail "No existe el namespace $NAMESPACE en el contexto kubectl actual"
  printf '\nSummary: %d failure(s), %d warning(s)\n' "$failures" "$warnings"
  exit 1
fi

lb_ip="$(kubectl get service lb -n "$NAMESPACE" -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)"
if [[ -n "$lb_ip" ]]; then
  pass "Load Balancer publicado: $lb_ip"
else
  fail "El servicio lb no tiene IP publica"
fi

printf '\nDNS\n'
hosts=("$domain" "assets.$domain" "cors.$domain" "stream.$domain")
dns_ready=1
for host in "${hosts[@]}"; do
  addresses="$(dig +short A "$host" | sort -u | paste -sd, -)"
  if [[ -n "$lb_ip" && "$addresses" == "$lb_ip" ]]; then
    pass "$host -> $lb_ip"
  else
    fail "$host apunta a ${addresses:-ninguna IP}; esperado $lb_ip"
    dns_ready=0
  fi
done

printf '\nTLS\n'
certificates_ready=1
for host in "${hosts[@]}"; do
  certificate="cert-$host"
  ready="$(
    kubectl get certificate "$certificate" -n "$NAMESPACE" \
      -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true
  )"
  if [[ "$ready" == "True" ]]; then
    pass "$certificate Ready=True"
  else
    fail "$certificate no esta Ready"
    certificates_ready=0
  fi
done

printf '\nDeployments\n'
deployments=(
  pgsql pgbouncer pgbouncer-t reticulum hubs spoke nearspark photomnemonic
  dialog coturn haproxy bot-orchestrator
)
for deployment in "${deployments[@]}"; do
  if ! kubectl get deployment "$deployment" -n "$NAMESPACE" >/dev/null 2>&1; then
    fail "Deployment ausente: $deployment"
    continue
  fi
  desired="$(kubectl get deployment "$deployment" -n "$NAMESPACE" -o jsonpath='{.spec.replicas}')"
  ready="$(kubectl get deployment "$deployment" -n "$NAMESPACE" -o jsonpath='{.status.readyReplicas}')"
  ready="${ready:-0}"
  if [[ "$desired" -gt 0 && "$ready" == "$desired" ]]; then
    pass "$deployment Ready $ready/$desired"
  elif [[ "$desired" -eq 0 ]]; then
    fail "$deployment esta escalado a cero"
  else
    fail "$deployment Ready $ready/$desired"
  fi
done

printf '\nRuntime hardening\n'
deployments_json="$(kubectl get deployment -n "$NAMESPACE" -o json 2>/dev/null || true)"
container_count="$(printf '%s' "$deployments_json" | jq '[.items[].spec.template.spec.containers[]] | length' 2>/dev/null || true)"
budgeted_count="$(
  printf '%s' "$deployments_json" | jq '
    [.items[].spec.template.spec.containers[] |
      select(.resources.requests.cpu and .resources.requests.memory and .resources.limits.memory and
        (.resources.limits.cpu | not))] | length
  ' 2>/dev/null || true
)"
if [[ "$container_count" == "13" && "$budgeted_count" == "$container_count" ]]; then
  pass "Los 13 contenedores tienen requests y limite de memoria, sin CPU limits"
else
  fail "Resource budgets incompletos: budgeted=${budgeted_count:-?} containers=${container_count:-?}"
fi

mutable_images="$(
  printf '%s' "$deployments_json" | jq -r '
    [.items[] as $deployment | $deployment.spec.template.spec.containers[] |
      select((.image | test("@sha256:[a-fA-F0-9]{64}$")) | not) |
      ($deployment.metadata.name + "/" + .name)] | join(",")
  ' 2>/dev/null || true
)"
if [[ -z "$mutable_images" ]]; then
  pass "Todas las imagenes de Deployment estan fijadas por digest"
else
  fail "Imagenes mutables: $mutable_images"
fi

unsafe_strategies="$(
  printf '%s' "$deployments_json" | jq -r '
    [.items[] | select((.metadata.name == "pgsql" or .metadata.name == "reticulum" or
      .metadata.name == "dialog" or .metadata.name == "coturn") and .spec.strategy.type != "Recreate") |
      .metadata.name] | join(",")
  ' 2>/dev/null || true
)"
if [[ -z "$unsafe_strategies" ]]; then
  pass "PostgreSQL, Reticulum, Dialog y Coturn usan Recreate"
else
  fail "Estrategia insegura en: $unsafe_strategies"
fi

ret_security="$(
  printf '%s' "$deployments_json" | jq -r '
    .items[] | select(.metadata.name == "reticulum") |
    .spec.template.spec.containers[] | select(.name == "reticulum") | .securityContext |
    [(.privileged != true), (.allowPrivilegeEscalation == false),
      ((.capabilities.drop // []) | index("ALL") != null), (.seccompProfile.type == "RuntimeDefault")] |
    all
  ' 2>/dev/null || true
)"
ret_mount_propagation="$(
  printf '%s' "$deployments_json" | jq -r '
    .items[] | select(.metadata.name == "reticulum") |
    .spec.template.spec.containers[] | select(.name == "reticulum") |
    [.volumeMounts[]? | select(.name == "storage") | .mountPropagation] | map(select(. != null)) | length
  ' 2>/dev/null || true
)"
if [[ "$ret_security" == "true" && "$ret_mount_propagation" == "0" ]]; then
  pass "Reticulum no es privilegiado, elimina capabilities y usa seccomp"
else
  fail "El securityContext de Reticulum no coincide con el baseline auditado"
fi

bot_security="$(
  printf '%s' "$deployments_json" | jq -r '
    .items[] | select(.metadata.name == "bot-orchestrator") |
    .spec.template.spec.containers[] | select(.name == "bot-orchestrator") | .securityContext |
    [(.runAsNonRoot == true), (.runAsUser == 1000), (.runAsGroup == 1000),
      (.allowPrivilegeEscalation == false),
      ((.capabilities.drop // []) | index("ALL") != null), (.seccompProfile.type == "RuntimeDefault")] |
    all
  ' 2>/dev/null || true
)"
if [[ "$bot_security" == "true" ]]; then
  pass "Bot orchestrator usa UID/GID 1000, elimina capabilities y usa seccomp"
else
  fail "El securityContext de bot-orchestrator no coincide con el baseline auditado"
fi

ret_bot_checksum="$(
  printf '%s' "$deployments_json" | jq -r '
    .items[] | select(.metadata.name == "reticulum") |
    .spec.template.metadata.annotations["yenhubs.org/bot-access-key-checksum"] // ""
  ' 2>/dev/null || true
)"
orchestrator_bot_checksum="$(
  printf '%s' "$deployments_json" | jq -r '
    .items[] | select(.metadata.name == "bot-orchestrator") |
    .spec.template.metadata.annotations["yenhubs.org/bot-access-key-checksum"] // ""
  ' 2>/dev/null || true
)"
if [[ "$ret_bot_checksum" =~ ^[a-fA-F0-9]{64}$ && "$ret_bot_checksum" == "$orchestrator_bot_checksum" ]]; then
  pass "Reticulum y bot-orchestrator comparten la huella de rotacion"
else
  fail "La huella de BOT_ACCESS_KEY falta o no coincide"
fi

database_checksum_summary="$(
  printf '%s' "$deployments_json" | jq -r '
    [.items[] | select(.metadata.name == "reticulum" or .metadata.name == "pgbouncer" or
      .metadata.name == "pgbouncer-t" or .metadata.name == "coturn") |
      .spec.template.metadata.annotations["yenhubs.org/db-credential-checksum"] // ""] |
    {count: length, unique: unique}
  ' 2>/dev/null || true
)"
database_checksum_count="$(printf '%s' "$database_checksum_summary" | jq -r '.count // 0' 2>/dev/null || true)"
database_checksum_unique="$(printf '%s' "$database_checksum_summary" | jq -r '.unique | length' 2>/dev/null || true)"
database_checksum="$(printf '%s' "$database_checksum_summary" | jq -r '.unique[0] // ""' 2>/dev/null || true)"
if [[ "$database_checksum_count" == "4" && "$database_checksum_unique" == "1" &&
  "$database_checksum" =~ ^[a-fA-F0-9]{64}$ ]]; then
  pass "Los cuatro consumidores DB comparten la huella de rotacion"
else
  fail "La huella DB falta o no coincide entre Reticulum, PgBouncer y Coturn"
fi

token_mount_violations="$(
  printf '%s' "$deployments_json" | jq -r '
    [.items[] | select(.metadata.name != "haproxy" and
      .spec.template.spec.automountServiceAccountToken != false) | .metadata.name] | join(",")
  ' 2>/dev/null || true
)"
haproxy_service_account="$(
  printf '%s' "$deployments_json" | jq -r '
    .items[] | select(.metadata.name == "haproxy") | .spec.template.spec.serviceAccountName // ""
  ' 2>/dev/null || true
)"
if [[ -z "$token_mount_violations" && "$haproxy_service_account" == "haproxy-sa" ]]; then
  pass "Solo HAProxy conserva un token de Kubernetes y usa su cuenta dedicada"
else
  fail "Montaje de token Kubernetes inesperado: ${token_mount_violations:-haproxy-sa ausente}"
fi

coturn_image="$(
  printf '%s' "$deployments_json" | jq -r '
    .items[] | select(.metadata.name == "coturn") | .spec.template.spec.containers[0].image // ""
  ' 2>/dev/null || true
)"
credential_leaking_coturn_image="docker.io/mozillareality/coturn@sha256:8380269c7bb2dc369f4126251199f0d603711debe8537b22cb7be470a50c51ce"
if [[ -n "$coturn_image" && "$coturn_image" != "$credential_leaking_coturn_image" ]]; then
  pass "Coturn no usa la imagen que registraba su conexion PostgreSQL"
else
  fail "Coturn usa una imagen con fuga conocida de credenciales"
fi

policy_summary="$(
  kubectl get networkpolicy -n "$NAMESPACE" -o json 2>/dev/null | jq -r '
    .items[] |
    [.metadata.name, .spec.podSelector.matchLabels.app,
      ([.spec.ingress[].from[]?.podSelector.matchLabels.app] | sort | join(",")),
      ([.spec.ingress[].ports[]? | ((.protocol // "TCP") + ":" + (.port | tostring))] | sort | join(","))] |
    @tsv
  ' 2>/dev/null | sort || true
)"
expected_policy_summary="$(cat <<'EOF'
bot-orchestrator-ingress	bot-orchestrator	reticulum	TCP:5001
pgbouncer-ingress	pgbouncer	reticulum	TCP:5432
pgbouncer-t-ingress	pgbouncer-t	reticulum	TCP:5432
pgsql-ingress	pgsql	pgbouncer,pgbouncer-t	TCP:5432
photomnemonic-ingress	photomnemonic	reticulum	TCP:5000
EOF
)"
if [[ "$policy_summary" == "$expected_policy_summary" ]]; then
  pass "Las cinco NetworkPolicies internas coinciden con la matriz auditada"
else
  fail "Las NetworkPolicies live no coinciden con la matriz auditada"
fi

printf '\nDatabase\n'
pgsql_pod="$(kubectl get pod -n "$NAMESPACE" -l app=pgsql -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
if [[ -n "$pgsql_pod" ]]; then
  database_counts="$(
    kubectl exec -n "$NAMESPACE" "$pgsql_pod" -- sh -ec \
      'psql -U "$POSTGRES_USER" -d retdb -At <<'\''SQL'\''
select count(*) from information_schema.tables
where table_schema in ('\''ret0'\'', '\''ret0_admin'\'', '\''coturn'\'');
select count(*) from ret0.schema_migrations;
select count(*) from ret0.hubs;
select count(*) from ret0.owned_files where state::text = '\''active'\'';
SQL' 2>/dev/null || true
  )"
  schema_tables="$(printf '%s\n' "$database_counts" | sed -n '1p')"
  migrations="$(printf '%s\n' "$database_counts" | sed -n '2p')"
  hubs="$(printf '%s\n' "$database_counts" | sed -n '3p')"
  active_owned_files="$(printf '%s\n' "$database_counts" | sed -n '4p')"
  if [[ "$schema_tables" =~ ^[0-9]+$ && "$migrations" =~ ^[0-9]+$ && "$hubs" =~ ^[0-9]+$ &&
    "$active_owned_files" =~ ^[0-9]+$ ]] &&
    [[ "$schema_tables" -ge 356 && "$migrations" -ge 94 && "$hubs" -ge 17 ]]; then
    pass "Restore validado: schema=$schema_tables migrations=$migrations hubs=$hubs owned_files=$active_owned_files"
  else
    fail "Conteos inferiores al baseline: schema=${schema_tables:-?} migrations=${migrations:-?} hubs=${hubs:-?}"
  fi
else
  fail "No se encontro el pod PostgreSQL"
fi

printf '\nReticulum storage\n'
reticulum_pod="$(kubectl get pod -n "$NAMESPACE" -l app=reticulum -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
if [[ -n "$reticulum_pod" && "${active_owned_files:-}" =~ ^[0-9]+$ ]]; then
  storage_counts="$(
    kubectl exec -n "$NAMESPACE" -c reticulum "$reticulum_pod" -- sh -ec '
      find /storage/owned -type f -name "*.blob" 2>/dev/null | wc -l
      find /storage/owned -type f -name "*.meta.json" 2>/dev/null | wc -l
    ' 2>/dev/null || true
  )"
  storage_blobs="$(printf '%s\n' "$storage_counts" | sed -n '1p' | tr -d ' ')"
  storage_meta="$(printf '%s\n' "$storage_counts" | sed -n '2p' | tr -d ' ')"
  if [[ "$active_owned_files" -gt 0 && "$storage_blobs" == "$active_owned_files" &&
    "$storage_meta" == "$active_owned_files" ]]; then
    pass "ret-pvc completo: blobs=$storage_blobs metadata=$storage_meta"
  elif [[ "$storage_blobs" =~ ^[0-9]+$ && "$storage_meta" =~ ^[0-9]+$ &&
    "$storage_blobs" -gt 0 && "$storage_blobs" == "$storage_meta" &&
    "$storage_blobs" -lt "$active_owned_files" ]]; then
    warn "ret-pvc contiene la recuperacion funcional, pero faltan medios historicos: active_owned_files=$active_owned_files blobs=$storage_blobs metadata=$storage_meta"
  else
    fail "ret-pvc no coincide con DB: active_owned_files=$active_owned_files blobs=${storage_blobs:-?} metadata=${storage_meta:-?}"
  fi
else
  fail "No se pudo validar ret-pvc contra la base"
fi

printf '\nHTTPS\n'
if [[ "$dns_ready" == "1" && "$certificates_ready" == "1" ]]; then
  for host in "${hosts[@]}"; do
    http_code="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 10 --max-time 20 "https://$host/" || true)"
    case "$http_code" in
      2*|3*|404)
        pass "https://$host responde HTTP $http_code"
        ;;
      *)
        fail "https://$host responde HTTP ${http_code:-000}"
        ;;
    esac
  done
else
  warn "HTTPS publico no se prueba hasta que DNS y TLS esten listos"
fi

printf '\nGhost runner\n'
bot_desired="$(
  kubectl get deployment bot-orchestrator -n "$NAMESPACE" -o jsonpath='{.spec.replicas}' 2>/dev/null || true
)"
bot_ready="$(
  kubectl get deployment bot-orchestrator -n "$NAMESPACE" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true
)"
if [[ "$bot_desired" == "1" && "${bot_ready:-0}" == "1" ]]; then
  port_forward_log="$(mktemp /tmp/yenhubs-bot-health.XXXXXX)"
  kubectl port-forward -n "$NAMESPACE" deployment/bot-orchestrator \
    "$LOCAL_BOT_PORT:5001" >"$port_forward_log" 2>&1 &
  port_forward_pid=$!

  health=""
  attempt=0
  while [[ "$attempt" -lt 20 ]]; do
    health="$(curl -fsS --connect-timeout 1 --max-time 2 "http://127.0.0.1:$LOCAL_BOT_PORT/health" 2>/dev/null || true)"
    if [[ -n "$health" ]]; then
      break
    fi
    sleep 0.25
    attempt=$((attempt + 1))
  done

  if [[ -n "$health" ]] && printf '%s' "$health" | jq -e \
    '.ok == true and .runner_backend_default == "ghost" and .max_bots_per_room == 10' >/dev/null 2>&1; then
    active_rooms="$(printf '%s' "$health" | jq -r '.active_rooms // 0')"
    pass "Orchestrator healthy, backend ghost, max bots 10, active rooms $active_rooms"
  else
    fail "El health del bot-orchestrator no confirma backend ghost saludable"
  fi
else
  fail "bot-orchestrator no esta Ready 1/1"
fi

printf '\nSummary: %d failure(s), %d warning(s)\n' "$failures" "$warnings"
if [[ "$failures" -gt 0 ]]; then
  exit 1
fi

#!/usr/bin/env bash

# Real local-K3s rehearsal for freeze-bundle-v1 and cold rebind. This script is
# deliberately excluded from the normal test gate: it creates isolated local
# Kubernetes resources and preserves them as inspectable evidence. It never
# calls DigitalOcean, GitHub or a public application endpoint.

set -Eeuo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SCRIPT_DIR="$ROOT_DIR/deployment"
RUN_ID="${1:-$(date -u '+%Y%m%d-%H%M%S')}"
EXPECTED_KUBE_CONTEXT="${EXPECTED_KUBE_CONTEXT:-yenhubs-h3}"
EVIDENCE_ROOT="${YENHUBS_H3_EVIDENCE_ROOT:-$HOME/yenhubs-h3-evidence}"
PAUSE_DIGEST='74c4244427b7312c5b901fe0f67cbc53683d06f4f24c6faee65d4182bf0fa893'
POSTGRES_DIGEST='cb54bb67c0fca8b439f18c1daadb315ad67de1faf8c387988c63080d15a54145'
BUSYBOX_DIGEST='73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662'
POSTGRES_IMAGE="docker.io/library/postgres@sha256:$POSTGRES_DIGEST"
BUSYBOX_IMAGE="docker.io/library/busybox@sha256:$BUSYBOX_DIGEST"

[[ "${YENHUBS_K3S_REHEARSAL_ATTESTATION:-}" == local-k3s-no-production ]] || {
  printf 'Set YENHUBS_K3S_REHEARSAL_ATTESTATION=local-k3s-no-production.\n' >&2
  exit 2
}
[[ "$RUN_ID" =~ ^[a-z0-9][a-z0-9-]{5,31}$ ]] || {
  printf 'RUN_ID must be 6-32 lowercase letters, digits or hyphens.\n' >&2
  exit 2
}

SOURCE_NAMESPACE="yenhubs-h3-src-$RUN_ID"
TARGET_NAMESPACE="yenhubs-h3-dst-$RUN_ID"
RUN_DIR="$EVIDENCE_ROOT/$RUN_ID"
BUNDLE_DIR="$RUN_DIR/freeze-bundle"
RECEIPT_PATH="$RUN_DIR/freeze-bundle-receipt.json"
VALUES_PATH="$RUN_DIR/input-values.fixture.yaml"
SOURCE_CONTRACT="$RUN_DIR/source-database-contract.json"
TARGET_CONTRACT="$RUN_DIR/target-database-contract.json"
PLAIN_DUMP="$RUN_DIR/retdb.sql"
SOURCE_STORAGE_HASHES="$RUN_DIR/source-storage.sha256"
TARGET_STORAGE_HASHES="$RUN_DIR/target-storage.sha256"
SUMMARY_PATH="$RUN_DIR/result.json"
STAMP="$(date -u '+%Y%m%d-%H%M%S')"
FREEZE_ID="$(od -An -N16 -tx1 /dev/urandom | tr -d '[:space:]')"
SOURCE_CLUSTER_UID="offline-source-cluster-$RUN_ID"

NAMESPACE="$TARGET_NAMESPACE"
export NAMESPACE EXPECTED_KUBE_CONTEXT
# shellcheck source=deployment/lib/recovery-safety.sh
source "$SCRIPT_DIR/lib/recovery-safety.sh"

PASS_COUNT=0
pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf 'PASS %02d  %s\n' "$PASS_COUNT" "$1"
}

sha256_digest() {
  sha256sum "$1" | awk '{print $1}'
}

file_size() {
  wc -c <"$1" | tr -d '[:space:]'
}

k() {
  command kubectl --context "$EXPECTED_KUBE_CONTEXT" --request-timeout=45s "$@"
}

require_local_k3s() {
  local current server version node_count
  current="$(kubectl config current-context)"
  server="$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')"
  version="$(kubectl version -o json | jq -er '.serverVersion.gitVersion')"
  node_count="$(k get node -o json | jq -er '.items | length')"
  [[ "$current" == "$EXPECTED_KUBE_CONTEXT" &&
     "$server" =~ ^https://(127\.0\.0\.1|localhost):[0-9]+$ &&
     "$version" == *+k3s* && "$node_count" == 1 ]] || {
    printf 'Refusing a non-local, non-K3s or multi-node context.\n' >&2
    return 1
  }
  k get namespace "$SOURCE_NAMESPACE" >/dev/null 2>&1 && {
    printf 'Source namespace already exists; choose a new RUN_ID.\n' >&2
    return 1
  }
  k get namespace "$TARGET_NAMESPACE" >/dev/null 2>&1 && {
    printf 'Target namespace already exists; choose a new RUN_ID.\n' >&2
    return 1
  }
  pass "local K3s boundary pinned ($version, $server)"
}

require_commands() {
  local command_name
  for command_name in awk cmp date git gzip jq kubectl node od sha256sum tar; do
    command -v "$command_name" >/dev/null 2>&1 || {
      printf 'Missing command: %s\n' "$command_name" >&2
      return 1
    }
  done
  pass 'local command set available'
}

prepare_run_directory() {
  [[ ! -e "$RUN_DIR" && ! -L "$RUN_DIR" ]] || {
    printf 'Evidence directory already exists; choose a new RUN_ID.\n' >&2
    return 1
  }
  mkdir -p "$BUNDLE_DIR"
  chmod 700 "$EVIDENCE_ROOT" "$RUN_DIR" "$BUNDLE_DIR"
  pass "private evidence directory created: $RUN_DIR"
}

image_for_deployment() {
  case "$1" in
    bot-orchestrator) printf 'ghcr.io/yengalvez/bot-orchestrator@sha256:%s\n' "$PAUSE_DIGEST" ;;
    coturn) printf 'ghcr.io/yengalvez/coturn@sha256:%s\n' "$PAUSE_DIGEST" ;;
    dialog) printf 'ghcr.io/yengalvez/dialog@sha256:%s\n' "$PAUSE_DIGEST" ;;
    haproxy) printf 'ghcr.io/yengalvez/haproxy@sha256:%s\n' "$PAUSE_DIGEST" ;;
    hubs) printf 'ghcr.io/yengalvez/hubs@sha256:%s\n' "$PAUSE_DIGEST" ;;
    nearspark) printf 'ghcr.io/yengalvez/nearspark@sha256:%s\n' "$PAUSE_DIGEST" ;;
    pgbouncer | pgbouncer-t) printf 'ghcr.io/yengalvez/pgbouncer@sha256:%s\n' "$PAUSE_DIGEST" ;;
    photomnemonic) printf 'ghcr.io/yengalvez/photomnemonic@sha256:%s\n' "$PAUSE_DIGEST" ;;
    pgsql) printf '%s\n' "$POSTGRES_IMAGE" ;;
    reticulum) printf 'ghcr.io/yengalvez/reticulum@sha256:%s\n' "$PAUSE_DIGEST" ;;
    spoke) printf 'ghcr.io/yengalvez/spoke@sha256:%s\n' "$PAUSE_DIGEST" ;;
    *) return 2 ;;
  esac
}

container_name_for_deployment() {
  case "$1" in
    pgsql) printf 'postgresql\n' ;;
    *) printf '%s\n' "$1" ;;
  esac
}

apply_namespace() {
  local namespace="$1"
  jq -cn --arg name "$namespace" --arg run "$RUN_ID" '{
    apiVersion:"v1",kind:"Namespace",metadata:{name:$name,labels:{
      "yenhubs.org/h3-rehearsal":$run
    }}
  }' | k apply -f - >/dev/null
}

apply_pvc() {
  local namespace="$1" name="$2"
  jq -cn --arg namespace "$namespace" --arg name "$name" '{
    apiVersion:"v1",kind:"PersistentVolumeClaim",
    metadata:{namespace:$namespace,name:$name},
    spec:{accessModes:["ReadWriteOnce"],storageClassName:"local-path",
      resources:{requests:{storage:"1Gi"}}}
  }' | k apply -f - >/dev/null
}

apply_runtime_config() {
  local namespace="$1"
  jq -cn --arg namespace "$namespace" '{
    apiVersion:"v1",kind:"ConfigMap",metadata:{namespace:$namespace,name:"ret-config"},
    data:{"config.toml.template":"h3_local_process = true\n"}
  }' | k apply -f - >/dev/null
  jq -cn --arg namespace "$namespace" '{
    apiVersion:"v1",kind:"Secret",metadata:{namespace:$namespace,name:"configs"},
    type:"Opaque",stringData:{BOT_ACCESS_KEY:"h3-local-fixture-only",
      DB_PASS:"h3-local-database-only"}
  }' | k apply -f - >/dev/null
}

deployment_json() {
  local namespace="$1" name="$2" replicas="$3" image container pod_spec
  image="$(image_for_deployment "$name")"
  container="$(container_name_for_deployment "$name")"
  case "$name" in
    bot-orchestrator)
      pod_spec="$(jq -cn --arg image "$image" '{
        automountServiceAccountToken:false,
        volumes:[{name:"bot-orchestrator-tmp",emptyDir:{sizeLimit:"256Mi"}}],
        containers:[{name:"bot-orchestrator",image:$image,imagePullPolicy:"Never",
          securityContext:{runAsNonRoot:true,runAsUser:1000,runAsGroup:1000,
            allowPrivilegeEscalation:false,readOnlyRootFilesystem:true,
            capabilities:{drop:["ALL"]},seccompProfile:{type:"RuntimeDefault"}},
          env:[
            {name:"BOT_ACCESS_KEY",valueFrom:{secretKeyRef:{name:"configs",key:"BOT_ACCESS_KEY"}}},
            {name:"RUNNER_AUTOSTART",value:"true"},
            {name:"RUNNER_BACKEND",value:"ghost"},
            {name:"GHOST_RUNNER_SCRIPT",value:"/app/run-ghost-runner.js"}
          ],volumeMounts:[{name:"bot-orchestrator-tmp",mountPath:"/tmp"}]
        }]
      }')"
      ;;
    pgsql)
      pod_spec="$(jq -cn --arg image "$image" '{
        automountServiceAccountToken:false,securityContext:{fsGroup:70},
        volumes:[{name:"pgsql-data",persistentVolumeClaim:{claimName:"pgsql-pvc"}}],
        containers:[{name:"postgresql",image:$image,imagePullPolicy:"Never",
          env:[{name:"POSTGRES_USER",value:"postgres"},{name:"POSTGRES_DB",value:"retdb"},
            {name:"POSTGRES_PASSWORD",valueFrom:{secretKeyRef:{name:"configs",key:"DB_PASS"}}}],
          volumeMounts:[{name:"pgsql-data",mountPath:"/var/lib/postgresql/data"}],
          readinessProbe:{exec:{command:["sh","-ec","pg_isready -U postgres -d retdb"]},
            initialDelaySeconds:2,periodSeconds:2,failureThreshold:30}
        }]
      }')"
      ;;
    reticulum)
      pod_spec="$(jq -cn --arg ret "ghcr.io/yengalvez/reticulum@sha256:$PAUSE_DIGEST" \
        --arg postgrest "ghcr.io/yengalvez/postgrest@sha256:$PAUSE_DIGEST" '{
        automountServiceAccountToken:false,
        volumes:[{name:"ret-storage",persistentVolumeClaim:{claimName:"ret-pvc"}}],
        containers:[
          {name:"postgrest",image:$postgrest,imagePullPolicy:"Never"},
          {name:"reticulum",image:$ret,imagePullPolicy:"Never",
            volumeMounts:[{name:"ret-storage",mountPath:"/storage"}]}
        ]
      }')"
      ;;
    *)
      pod_spec="$(jq -cn --arg name "$container" --arg image "$image" '{
        automountServiceAccountToken:false,
        containers:[{name:$name,image:$image,imagePullPolicy:"Never"}]
      }')"
      ;;
  esac
  jq -cn --arg namespace "$namespace" --arg name "$name" \
    --argjson replicas "$replicas" --argjson pod_spec "$pod_spec" '{
    apiVersion:"apps/v1",kind:"Deployment",metadata:{namespace:$namespace,name:$name},
    spec:{replicas:$replicas,strategy:{type:"Recreate"},
      selector:{matchLabels:{app:$name}},
      template:{metadata:{labels:{app:$name}},spec:$pod_spec}}
  }'
}

apply_deployments() {
  local namespace="$1" profile="$2" name replicas
  for name in bot-orchestrator coturn dialog haproxy hubs nearspark \
    pgbouncer pgbouncer-t photomnemonic pgsql reticulum spoke; do
    replicas=0
    if [[ "$name" == pgsql ]]; then
      replicas=1
    elif [[ "$profile" == source && "$name" == bot-orchestrator ]]; then
      replicas=1
    fi
    deployment_json "$namespace" "$name" "$replicas" | k apply -f - >/dev/null
  done
}

prepare_namespace_stack() {
  local namespace="$1" profile="$2"
  apply_namespace "$namespace"
  apply_pvc "$namespace" pgsql-pvc
  apply_pvc "$namespace" ret-pvc
  apply_runtime_config "$namespace"
  apply_deployments "$namespace" "$profile"
  k rollout status deployment/pgsql -n "$namespace" --timeout=180s >/dev/null
  pass "$profile namespace created with exact two-PVC/twelve-Deployment topology"
}

pgsql_pod() {
  local namespace="$1"
  k get pod -n "$namespace" -l app=pgsql -o json | jq -er '
    [.items[] | select(.status.phase == "Running" and
      any(.status.conditions[]?; .type == "Ready" and .status == "True")) |
      .metadata.name] | select(length == 1) | .[0]
  '
}

apply_storage_helper() {
  local namespace="$1" name="$2"
  jq -cn --arg namespace "$namespace" --arg name "$name" \
    --arg image "$BUSYBOX_IMAGE" '{
    apiVersion:"v1",kind:"Pod",metadata:{namespace:$namespace,name:$name,
      labels:{app:$name}},
    spec:{restartPolicy:"Never",automountServiceAccountToken:false,
      volumes:[{name:"ret-storage",persistentVolumeClaim:{claimName:"ret-pvc"}}],
      containers:[{name:"helper",image:$image,imagePullPolicy:"Never",
        command:["sh","-c","trap : TERM INT; sleep 2147483647 & wait"],
        volumeMounts:[{name:"ret-storage",mountPath:"/data"}],
        securityContext:{allowPrivilegeEscalation:false,capabilities:{drop:["ALL"]},
          seccompProfile:{type:"RuntimeDefault"}}}]}
  }' | k apply -f - >/dev/null
  k wait -n "$namespace" --for=condition=Ready "pod/$name" --timeout=120s >/dev/null
}

seed_source_database() {
  local pod="$1" index
  # Expansion is intentionally deferred to the PostgreSQL container.
  # shellcheck disable=SC2016
  {
    printf '%s\n' \
      'CREATE SCHEMA coturn;' \
      'CREATE SCHEMA ret0;' \
      'CREATE SCHEMA ret0_admin;' \
      'CREATE TABLE coturn.turnusers_lt (name text PRIMARY KEY);' \
      'CREATE TABLE ret0.schema_migrations (version bigint PRIMARY KEY);' \
      'CREATE TABLE ret0.hubs (hub_sid text PRIMARY KEY);' \
      'CREATE TABLE ret0.owned_files (owned_file_uuid text PRIMARY KEY, state text NOT NULL);'
    for index in $(seq 1 351); do
      printf 'CREATE TABLE ret0.table_%03d (id integer);\n' "$index"
    done
    printf '%s\n' 'CREATE VIEW ret0_admin.admin_view AS SELECT 1 AS healthy;'
    for index in $(seq 1 94); do
      printf "INSERT INTO ret0.schema_migrations VALUES (2019000000%04d);\n" "$index"
    done
    for index in $(seq 1 17); do
      printf "INSERT INTO ret0.hubs VALUES ('room-%02d');\n" "$index"
    done
    printf '%s\n' \
      "INSERT INTO ret0.owned_files VALUES ('avatar-one','active');" \
      "INSERT INTO ret0.owned_files VALUES ('scene-one','active');" \
      "INSERT INTO ret0.owned_files VALUES ('spoke-one','active');" \
      "INSERT INTO ret0.owned_files VALUES ('deferred-one','expiring');"
  } | k exec -i -n "$SOURCE_NAMESPACE" "$pod" -- \
    sh -ec 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d retdb' >/dev/null
  pass 'source PostgreSQL seeded with 356 relations, 94 migrations and 17 rooms'
}

seed_source_storage() {
  local helper="$1"
  k exec -n "$SOURCE_NAMESPACE" "$helper" -- sh -ec '
    mkdir -p /data/owned/av/at /data/owned/sc/en /data/owned/sp/ok /data/owned/de/fe
    printf avatar-bytes >/data/owned/av/at/avatar-one.blob
    printf "{\"kind\":\"avatar\"}" >/data/owned/av/at/avatar-one.meta.json
    printf scene-bytes >/data/owned/sc/en/scene-one.blob
    printf "{\"kind\":\"scene\"}" >/data/owned/sc/en/scene-one.meta.json
    printf spoke-bytes >/data/owned/sp/ok/spoke-one.blob
    printf "{\"kind\":\"spoke-project\"}" >/data/owned/sp/ok/spoke-one.meta.json
    printf deferred-bytes >/data/owned/de/fe/deferred-one.blob
    printf "{\"kind\":\"deferred\"}" >/data/owned/de/fe/deferred-one.meta.json
  '
  capture_storage_hashes "$SOURCE_NAMESPACE" "$helper" "$SOURCE_STORAGE_HASHES"
  pass 'source PVC seeded with avatar, scene, Spoke and deferred media pairs'
}

capture_storage_hashes() {
  local namespace="$1" helper="$2" destination="$3"
  # Expansion is intentionally deferred to the storage helper container.
  # shellcheck disable=SC2016
  k exec -n "$namespace" "$helper" -- sh -ec '
    cd /data
    find owned -type f | LC_ALL=C sort | while IFS= read -r path; do
      sha256sum "$path"
    done
  ' >"$destination"
  chmod 600 "$destination"
}

capture_database_bundle() {
  local pod="$1"
  NAMESPACE="$SOURCE_NAMESPACE"
  export NAMESPACE
  recovery_capture_live_database_contract "$pod" "$SOURCE_CONTRACT"
  # Expansion is intentionally deferred to the PostgreSQL container.
  # shellcheck disable=SC2016
  k exec -n "$SOURCE_NAMESPACE" "$pod" -- sh -ec \
    'pg_dump -U "$POSTGRES_USER" -d retdb --no-owner --no-privileges --format=plain' \
    >"$PLAIN_DUMP"
  chmod 600 "$PLAIN_DUMP"
  recovery_bind_database_contract_to_dump \
    "$SOURCE_CONTRACT" "$PLAIN_DUMP" "$BUNDLE_DIR/database-contract.json"
  gzip -c "$PLAIN_DUMP" >"$BUNDLE_DIR/retdb-$STAMP.sql.gz"
  chmod 600 "$BUNDLE_DIR/retdb-$STAMP.sql.gz" "$BUNDLE_DIR/database-contract.json"
}

capture_storage_bundle() {
  local helper="$1"
  k exec -n "$SOURCE_NAMESPACE" "$helper" -- \
    tar -C /data -czf - owned >"$BUNDLE_DIR/ret-storage-$STAMP.tar.gz"
  chmod 600 "$BUNDLE_DIR/ret-storage-$STAMP.tar.gz"
}

capture_inventory() {
  local namespace_uid deployments_json
  namespace_uid="$(k get namespace "$SOURCE_NAMESPACE" -o jsonpath='{.metadata.uid}')"
  deployments_json="$(k get deployment -n "$SOURCE_NAMESPACE" -o json)"
  jq -e --arg namespace "$SOURCE_NAMESPACE" --arg namespace_uid "$namespace_uid" '
    {
      schema_version:4,namespace:$namespace,namespace_uid:$namespace_uid,
      bot_runner_runtime:{generation:"legacy-absent",mode:"process-local",image:null,
        control_plane:{state:"legacy-absent"},recovery_epoch:{state:"legacy-absent"}},
      deployments:[.items[] | {
        name:.metadata.name,uid:.metadata.uid,replicas:(.spec.replicas // 0),
        init_containers:[(.spec.template.spec.initContainers // [])[] |
          {name:.name,image:.image}] | sort_by(.name),
        containers:[.spec.template.spec.containers[] |
          {name:.name,image:.image}] | sort_by(.name)
      }] | sort_by(.name)
    }
  ' <<<"$deployments_json" >"$BUNDLE_DIR/deployment-images.json"
  chmod 600 "$BUNDLE_DIR/deployment-images.json"
  recovery_deployment_inventory_is_acceptable \
    "$BUNDLE_DIR/deployment-images.json" "$SOURCE_NAMESPACE" "$namespace_uid"
}

write_values_file() {
  local pause="sha256:$PAUSE_DIGEST" postgres="sha256:$POSTGRES_DIGEST"
  {
    printf 'Namespace: %s\n' "$TARGET_NAMESPACE"
    printf 'OVERRIDE_BOT_ORCHESTRATOR_IMAGE: ghcr.io/yengalvez/bot-orchestrator@%s\n' "$pause"
    printf 'OVERRIDE_BOT_RUNNER_IMAGE: No\n'
    printf 'BOT_ORCHESTRATOR_ACCESS_KEY: h3-local-fixture-only\n'
    printf 'BOT_RUNNER_ACTIVATION_PHASE: active\n'
    printf 'BOT_RUNNER_RECOVERY_PHASE: active\n'
    printf 'BOT_RUNNER_RECOVERY_EPOCH: 22222222-2222-4222-8222-222222222222\n'
    printf 'OVERRIDE_COTURN_IMAGE: ghcr.io/yengalvez/coturn@%s\n' "$pause"
    printf 'OVERRIDE_DIALOG_IMAGE: ghcr.io/yengalvez/dialog@%s\n' "$pause"
    printf 'OVERRIDE_HAPROXY_IMAGE: ghcr.io/yengalvez/haproxy@%s\n' "$pause"
    printf 'OVERRIDE_HUBS_IMAGE: ghcr.io/yengalvez/hubs@%s\n' "$pause"
    printf 'OVERRIDE_NEARSPARK_IMAGE: ghcr.io/yengalvez/nearspark@%s\n' "$pause"
    printf 'OVERRIDE_PGBOUNCER_IMAGE: ghcr.io/yengalvez/pgbouncer@%s\n' "$pause"
    printf 'OVERRIDE_PHOTOMNEMONIC_IMAGE: ghcr.io/yengalvez/photomnemonic@%s\n' "$pause"
    printf 'OVERRIDE_POSTGRES_IMAGE: docker.io/library/postgres@%s\n' "$postgres"
    printf 'OVERRIDE_POSTGREST_IMAGE: ghcr.io/yengalvez/postgrest@%s\n' "$pause"
    printf 'OVERRIDE_RETICULUM_IMAGE: ghcr.io/yengalvez/reticulum@%s\n' "$pause"
    printf 'OVERRIDE_SPOKE_IMAGE: ghcr.io/yengalvez/spoke@%s\n' "$pause"
    printf '%s\n' \
      'HUB_DOMAIN: h3.fixture.invalid' \
      'ADM_EMAIL: h3@example.invalid' \
      'DB_USER: postgres' \
      'DB_PASS: h3-local-database-only' \
      'SMTP_SERVER: smtp.fixture.invalid' \
      'SMTP_PORT: 2525' \
      'SMTP_USER: h3-local' \
      'SMTP_PASS: h3-local-fixture-only' \
      'NODE_COOKIE: h3-local-fixture-only' \
      'GUARDIAN_KEY: h3-local-fixture-only' \
      'PHX_KEY: h3-local-fixture-only' \
      'PERMS_KEY: h3-local-fixture-only' \
      'BOT_ACCESS_KEY: h3-local-fixture-only' \
      'OPENAI_API_KEY: h3-local-fixture-only'
  } >"$VALUES_PATH"
  chmod 600 "$VALUES_PATH"
  node "$SCRIPT_DIR/parse-local-values.mjs" "$VALUES_PATH" --validate
}

write_freeze_metadata() {
  local source_namespace_uid source_pvc_uid dump_digest storage_digest
  local dump_size storage_size created root hubs cloud
  source_namespace_uid="$(k get namespace "$SOURCE_NAMESPACE" -o jsonpath='{.metadata.uid}')"
  source_pvc_uid="$(k get pvc ret-pvc -n "$SOURCE_NAMESPACE" -o jsonpath='{.metadata.uid}')"
  dump_digest="$(sha256_digest "$BUNDLE_DIR/retdb-$STAMP.sql.gz")"
  storage_digest="$(sha256_digest "$BUNDLE_DIR/ret-storage-$STAMP.tar.gz")"
  dump_size="$(file_size "$BUNDLE_DIR/retdb-$STAMP.sql.gz")"
  storage_size="$(file_size "$BUNDLE_DIR/ret-storage-$STAMP.tar.gz")"
  created="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  root="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  hubs="$(git -C "$ROOT_DIR/hubs" rev-parse HEAD)"
  cloud="$(git -C "$ROOT_DIR/hubs-cloud" rev-parse HEAD)"
  [[ "$(git -C "$ROOT_DIR" ls-tree HEAD hubs | awk '{print $3}')" == "$hubs" &&
     "$(git -C "$ROOT_DIR" ls-tree HEAD hubs-cloud | awk '{print $3}')" == "$cloud" ]] || return 1

  jq -n --arg captured "$created" --arg root "$root" --arg hubs "$hubs" \
    --arg cloud "$cloud" '{
    schema:"freeze-git-state-v1",captured_at_utc:$captured,
    repositories:{root:{commit:$root},hubs:{commit:$hubs},hubs_cloud:{commit:$cloud}},
    gitlinks:{hubs:$hubs,hubs_cloud:$cloud},
    accepted_releases:{hubs:"prod-2026-03-11",hubs_ce:"2.1.0"}
  }' >"$BUNDLE_DIR/git-state.json"

  jq -n --arg domain h3.fixture.invalid '{
    schema:"freeze-external-config-v1",
    dns:{domain:$domain,provider:"local-fixture",records:["root","assets","cors","stream"]},
    smtp:{provider:"local-fixture",host_configured:true,port_configured:true,
      user_configured:true,password_configured:true},
    functional_ids:{room:"room-01",scene:"scene-one",spoke_project:"spoke-one"},
    images:{repositories:[
      "docker.io/library/postgres","ghcr.io/yengalvez/bot-orchestrator",
      "ghcr.io/yengalvez/coturn","ghcr.io/yengalvez/dialog",
      "ghcr.io/yengalvez/haproxy","ghcr.io/yengalvez/hubs",
      "ghcr.io/yengalvez/nearspark","ghcr.io/yengalvez/pgbouncer",
      "ghcr.io/yengalvez/photomnemonic","ghcr.io/yengalvez/postgrest",
      "ghcr.io/yengalvez/reticulum","ghcr.io/yengalvez/spoke"]},
    configured_presence:{ADM_EMAIL:true,BOT_ACCESS_KEY:true,DB_PASS:true,DB_USER:true,
      GUARDIAN_KEY:true,HUB_DOMAIN:true,NODE_COOKIE:true,OPENAI_API_KEY:true,
      PERMS_KEY:true,PHX_KEY:true,SMTP_PASS:true,SMTP_PORT:true,SMTP_SERVER:true,
      SMTP_USER:true},
    responsibility:{dns:"fixture-owner",operations:"fixture-owner",
      registry:"fixture-owner",smtp:"fixture-owner"}
  }' >"$BUNDLE_DIR/external-config-redacted.json"

  jq -n --arg namespace "$TARGET_NAMESPACE" --arg checked "$created" '{
    schema:"freeze-infrastructure-recipe-v1",provider:"digitalocean",region:"ams3",
    cluster:{name:"hubs-ce",ha_control_plane:false,
      node_pools:[{size:"s-4vcpu-8gb",count:1}]},
    storage:{class:"do-block-storage",persistent_volume_claims:[
      {name:"pgsql-pvc",size:"10Gi"},{name:"ret-pvc",size:"10Gi"}]},
    load_balancer:{count:1,type:"REGIONAL_NETWORK"},namespace:$namespace,
    ingress:"haproxytech-kubernetes-ingress-3.2",cert_manager:"cert-manager",
    topology:"single-region-low-cost",
    apply_order:["infrastructure","cert-manager","ingress",
      "generated-manifest","restore","live-verification"],
    cost_gate:{checked_at_utc:$checked,estimated_monthly_usd:0,
      result:"approval-required-before-create"}
  }' >"$BUNDLE_DIR/infrastructure-recipe.json"

  jq -n --arg stamp "$STAMP" --arg created "$created" --arg freeze "$FREEZE_ID" \
    --arg source_namespace "$SOURCE_NAMESPACE" --arg source_namespace_uid "$source_namespace_uid" \
    --arg source_pvc_uid "$source_pvc_uid" --arg source_cluster_uid "$SOURCE_CLUSTER_UID" \
    --arg dump_digest "$dump_digest" --arg storage_digest "$storage_digest" \
    --argjson dump_size "$dump_size" --argjson storage_size "$storage_size" '{
    schema:"freeze-bundle-v1",client_instance_id:"h3-fixture-client",freeze_id:$freeze,
    stamp:$stamp,created_at_utc:$created,
    source:{kube_context:"retired-source-context",
      cluster:{name:"retired-hubs-ce",uid:$source_cluster_uid},
      namespace:{name:$source_namespace,uid:$source_namespace_uid},
      pvc:{name:"ret-pvc",uid:$source_pvc_uid}},
    operation:{id:$freeze,quiescence:{started_at_utc:$created,completed_at_utc:$created}},
    payloads:{database:{filename:("retdb-"+$stamp+".sql.gz"),
      size_bytes:$dump_size,sha256:$dump_digest},
      storage:{filename:("ret-storage-"+$stamp+".tar.gz"),
      size_bytes:$storage_size,sha256:$storage_digest}},
    runtime_generation:"legacy-absent",runner_mode:"process-local",
    provenance:{generator:"yenhubs-freeze-bundle-v1",external_import:false},
    minimum_restore_version:1,publication_state:"complete"
  }' >"$BUNDLE_DIR/checkpoint-metadata.json"

  chmod 600 "$BUNDLE_DIR"/*.json
  : >"$BUNDLE_DIR/SHA256SUMS"
  while IFS= read -r artifact; do
    printf '%s  %s\n' "$(sha256_digest "$BUNDLE_DIR/$artifact")" "$artifact" \
      >>"$BUNDLE_DIR/SHA256SUMS"
  done < <(recovery_freeze_bundle_artifacts "$STAMP")
  chmod 600 "$BUNDLE_DIR/SHA256SUMS"
}

write_receipt() {
  local manifest_digest
  manifest_digest="$(sha256_digest "$BUNDLE_DIR/SHA256SUMS")"
  jq -n --arg manifest_digest "$manifest_digest" \
    --slurpfile metadata "$BUNDLE_DIR/checkpoint-metadata.json" \
    --slurpfile inventory "$BUNDLE_DIR/deployment-images.json" '
    ($metadata[0]) as $meta | ($inventory[0]) as $images | {
      schema:"freeze-bundle-receipt-v1",client_instance_id:$meta.client_instance_id,
      freeze_id:$meta.freeze_id,sha256sums_sha256:$manifest_digest,
      copies:[
        {reference:"local:primary-copy",decrypt_rehash:"passed",
          verified_at_utc:$meta.created_at_utc},
        {reference:"local:secondary-copy",decrypt_rehash:"passed",
          verified_at_utc:$meta.created_at_utc}],
      key_escrow_reference:"local:key-escrow-fixture",
      credential_set_reference:"local:credential-set-fixture",
      image_custody:[$images.deployments[] as $deployment |
        $deployment.containers[] | {pair:($deployment.name+"/"+.name),image:.image,
          reference:("local:image/"+$deployment.name+"/"+.name),
          restore_probe:"passed",verified_at_utc:$meta.created_at_utc}] | sort_by(.pair),
      responsible:"fixture-owner",verified_at_utc:$meta.created_at_utc
    }
  ' >"$RECEIPT_PATH"
  chmod 600 "$RECEIPT_PATH"
}

build_bundle() {
  local pgpod helper='source-storage-helper'
  pgpod="$(pgsql_pod "$SOURCE_NAMESPACE")"
  apply_storage_helper "$SOURCE_NAMESPACE" "$helper"
  seed_source_database "$pgpod"
  seed_source_storage "$helper"
  capture_database_bundle "$pgpod"
  capture_storage_bundle "$helper"
  capture_inventory
  write_values_file
  write_freeze_metadata
  write_receipt
  recovery_verify_freeze_bundle_directory "$BUNDLE_DIR" "$STAMP"
  recovery_freeze_bundle_receipt_is_acceptable "$RECEIPT_PATH" "$BUNDLE_DIR"
  "$SCRIPT_DIR/validate-checkpoint.sh" \
    "$BUNDLE_DIR/retdb-$STAMP.sql.gz" "$BUNDLE_DIR/ret-storage-$STAMP.tar.gz" >/dev/null
  pass 'real PostgreSQL/media freeze bundle validates as exact freeze-bundle-v1'
}

run_preflights() {
  local target_namespace_uid target_pvc_uid
  target_namespace_uid="$(k get namespace "$TARGET_NAMESPACE" -o jsonpath='{.metadata.uid}')"
  target_pvc_uid="$(k get pvc ret-pvc -n "$TARGET_NAMESPACE" -o jsonpath='{.metadata.uid}')"
  VALUES_FILE="$VALUES_PATH" \
    "$SCRIPT_DIR/preflight-greenfield.sh" "$BUNDLE_DIR" "$RECEIPT_PATH" >/dev/null
  pass 'offline greenfield preflight accepts checkout, bundle and receipt'
  NAMESPACE="$TARGET_NAMESPACE" VALUES_FILE="$VALUES_PATH" BACKUP_DIR="$BUNDLE_DIR" \
    FREEZE_RECEIPT_PATH="$RECEIPT_PATH" RESTORE_TARGET_MODE=cold-rebind \
    EXPECTED_KUBE_CONTEXT="$EXPECTED_KUBE_CONTEXT" \
    EXPECTED_NAMESPACE_UID="$target_namespace_uid" EXPECTED_RET_PVC_UID="$target_pvc_uid" \
    "$SCRIPT_DIR/preflight-reactivation.sh" >/dev/null
  pass 'real target preflight accepts new Namespace/PVC and zero-writer bootstrap'
  NAMESPACE="$TARGET_NAMESPACE" VALUES_FILE="$VALUES_PATH" \
    FREEZE_RECEIPT_PATH="$RECEIPT_PATH" RESTORE_TARGET_MODE=cold-rebind \
    RESTORE_CHECKPOINT_PREFLIGHT=1 EXPECTED_KUBE_CONTEXT="$EXPECTED_KUBE_CONTEXT" \
    EXPECTED_NAMESPACE_UID="$target_namespace_uid" EXPECTED_RET_PVC_UID="$target_pvc_uid" \
    "$SCRIPT_DIR/restore-checkpoint.sh" "$BUNDLE_DIR" >/dev/null
  pass 'coordinated DB/storage restore preflight passes without mutation'
}

restore_database() {
  local pod="$1"
  # Expansion is intentionally deferred to the PostgreSQL container.
  # shellcheck disable=SC2016
  k exec -n "$TARGET_NAMESPACE" "$pod" -- sh -ec '
    psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres <<"SQL"
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
 WHERE datname = $$retdb$$ AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS retdb;
CREATE DATABASE retdb;
SQL
  ' >/dev/null
  # Expansion is intentionally deferred to the PostgreSQL container.
  # shellcheck disable=SC2016
  gzip -cd "$BUNDLE_DIR/retdb-$STAMP.sql.gz" | \
    k exec -i -n "$TARGET_NAMESPACE" "$pod" -- \
      sh -ec 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d retdb' >/dev/null
}

restore_storage() {
  local helper="$1"
  [[ "$(k exec -n "$TARGET_NAMESPACE" "$helper" -- \
      sh -ec 'find /data -mindepth 1 -print | wc -l')" == 0 ]] || {
    printf 'Target ret-pvc is not empty before restore.\n' >&2
    return 1
  }
  gzip -cd "$BUNDLE_DIR/ret-storage-$STAMP.tar.gz" | \
    k exec -i -n "$TARGET_NAMESPACE" "$helper" -- tar -C /data -xf -
  capture_storage_hashes "$TARGET_NAMESPACE" "$helper" "$TARGET_STORAGE_HASHES"
  cmp -s "$SOURCE_STORAGE_HASHES" "$TARGET_STORAGE_HASHES"
}

capture_and_compare_target_contract() {
  local pod="$1"
  NAMESPACE="$TARGET_NAMESPACE"
  export NAMESPACE
  recovery_capture_live_database_contract "$pod" "$TARGET_CONTRACT"
  recovery_database_contracts_match "$BUNDLE_DIR/database-contract.json" "$TARGET_CONTRACT"
  jq -e '
    .critical_counts == {active_owned_files:3,hubs:17,migrations:94,
      owned_files:4,relations:356} and
    .critical_inventory.active_owned_file_uuids == ["avatar-one","scene-one","spoke-one"]
  ' "$TARGET_CONTRACT" >/dev/null
}

scale_writer_exact() {
  local deployment="$1" live uid rv fingerprint patch result new_rv
  live="$(k get deployment "$deployment" -n "$TARGET_NAMESPACE" -o json)"
  uid="$(jq -er '.metadata.uid' <<<"$live")"
  rv="$(jq -er '.metadata.resourceVersion' <<<"$live")"
  fingerprint="$(jq -cS '{selector:.spec.selector,strategy:(.spec.strategy // {}),
    template:.spec.template}' <<<"$live")"
  jq -e '.spec.replicas == 0' >/dev/null <<<"$live"
  patch="$(jq -cn --arg uid "$uid" --arg rv "$rv" '[
    {op:"test",path:"/metadata/uid",value:$uid},
    {op:"test",path:"/metadata/resourceVersion",value:$rv},
    {op:"test",path:"/spec/replicas",value:0},
    {op:"replace",path:"/spec/replicas",value:1}
  ]')"
  result="$(k patch deployment "$deployment" -n "$TARGET_NAMESPACE" \
    --type=json --patch="$patch" -o json)"
  new_rv="$(jq -er --arg uid "$uid" --arg rv "$rv" '
    select(.metadata.uid == $uid and .metadata.resourceVersion != $rv and
      .spec.replicas == 1) | .metadata.resourceVersion
  ' <<<"$result")"
  [[ -n "$new_rv" && "$(jq -cS '{selector:.spec.selector,
      strategy:(.spec.strategy // {}),template:.spec.template}' <<<"$result")" == "$fingerprint" ]]
  k rollout status "deployment/$deployment" -n "$TARGET_NAMESPACE" --timeout=180s >/dev/null
  k get deployment "$deployment" -n "$TARGET_NAMESPACE" -o json | jq -e '
    .spec.replicas == 1 and .status.readyReplicas == 1 and
    .status.availableReplicas == 1 and .status.observedGeneration == .metadata.generation
  ' >/dev/null
}

validate_target_storage_archive() {
  local helper="$1" validation="$RUN_DIR/target-validation"
  mkdir "$validation"
  chmod 700 "$validation"
  cp "$BUNDLE_DIR/retdb-$STAMP.sql.gz" "$validation/retdb-$STAMP.sql.gz"
  cp "$BUNDLE_DIR/database-contract.json" "$validation/database-contract.json"
  k exec -n "$TARGET_NAMESPACE" "$helper" -- \
    tar -C /data -czf - owned >"$validation/ret-storage-$STAMP.tar.gz"
  chmod 600 "$validation"/*
  "$SCRIPT_DIR/validate-checkpoint.sh" \
    "$validation/retdb-$STAMP.sql.gz" "$validation/ret-storage-$STAMP.tar.gz" >/dev/null
}

write_result() {
  local started="$1" finished="$2" source_ns_uid source_pvc_uid
  local target_ns_uid target_pvc_uid target_cluster_uid root hubs cloud version arch
  source_ns_uid="$(k get namespace "$SOURCE_NAMESPACE" -o jsonpath='{.metadata.uid}')"
  source_pvc_uid="$(k get pvc ret-pvc -n "$SOURCE_NAMESPACE" -o jsonpath='{.metadata.uid}')"
  target_ns_uid="$(k get namespace "$TARGET_NAMESPACE" -o jsonpath='{.metadata.uid}')"
  target_pvc_uid="$(k get pvc ret-pvc -n "$TARGET_NAMESPACE" -o jsonpath='{.metadata.uid}')"
  target_cluster_uid="$(k get namespace kube-system -o jsonpath='{.metadata.uid}')"
  root="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  hubs="$(git -C "$ROOT_DIR/hubs" rev-parse HEAD)"
  cloud="$(git -C "$ROOT_DIR/hubs-cloud" rev-parse HEAD)"
  version="$(kubectl version -o json | jq -er '.serverVersion.gitVersion')"
  arch="$(k get node -o json | jq -er '.items[0].status.nodeInfo.architecture')"
  jq -n --arg run_id "$RUN_ID" --arg stamp "$STAMP" --arg root "$root" \
    --arg hubs "$hubs" --arg cloud "$cloud" --arg k3s "$version" --arg arch "$arch" \
    --arg source_namespace "$SOURCE_NAMESPACE" --arg source_ns_uid "$source_ns_uid" \
    --arg source_pvc_uid "$source_pvc_uid" --arg target_namespace "$TARGET_NAMESPACE" \
    --arg target_ns_uid "$target_ns_uid" --arg target_pvc_uid "$target_pvc_uid" \
    --arg source_cluster_uid "$SOURCE_CLUSTER_UID" --arg target_cluster_uid "$target_cluster_uid" \
    --argjson elapsed "$((finished - started))" --argjson checks "$PASS_COUNT" '{
    schema:"yenhubs-h3-k3s-rehearsal-v1",status:"PASS",run_id:$run_id,stamp:$stamp,
    commits:{root:$root,hubs:$hubs,hubs_cloud:$cloud},
    environment:{kubernetes:$k3s,architecture:$arch,external_cost_usd:0},
    source:{cluster_uid:$source_cluster_uid,namespace:$source_namespace,
      namespace_uid:$source_ns_uid,ret_pvc_uid:$source_pvc_uid},
    target:{cluster_uid:$target_cluster_uid,namespace:$target_namespace,
      namespace_uid:$target_ns_uid,ret_pvc_uid:$target_pvc_uid},
    content:{relations:356,migrations:94,hubs:17,owned_files:4,
      active_owned_files:3,media_kinds:["avatar","scene","spoke-project","deferred"]},
    validation:{freeze_bundle:true,greenfield_preflight:true,target_preflight:true,
      coordinated_restore_preflight:true,database_contract:true,
      storage_bytes:true,writer_rollouts:5,checks:$checks},
    observed_reactivation_seconds:$elapsed,
    preserved_for_inspection:true
  }' >"$SUMMARY_PATH"
  chmod 600 "$SUMMARY_PATH"
}

main() {
  local target_pgpod
  local target_helper='target-storage-helper' started finished writer
  require_commands
  require_local_k3s
  prepare_run_directory
  prepare_namespace_stack "$SOURCE_NAMESPACE" source
  build_bundle
  prepare_namespace_stack "$TARGET_NAMESPACE" target
  run_preflights

  started="$(date +%s)"
  target_pgpod="$(pgsql_pod "$TARGET_NAMESPACE")"
  apply_storage_helper "$TARGET_NAMESPACE" "$target_helper"
  restore_database "$target_pgpod"
  restore_storage "$target_helper"
  capture_and_compare_target_contract "$target_pgpod"
  validate_target_storage_archive "$target_helper"
  pass 'database contract and media bytes match on new target identities'

  for writer in pgbouncer pgbouncer-t reticulum coturn bot-orchestrator; do
    scale_writer_exact "$writer"
  done
  pass 'five writers resumed in the production order through exact Kubernetes CAS'
  finished="$(date +%s)"

  [[ "$(k get namespace "$SOURCE_NAMESPACE" -o jsonpath='{.metadata.uid}')" != \
      "$(k get namespace "$TARGET_NAMESPACE" -o jsonpath='{.metadata.uid}')" ]]
  [[ "$(k get pvc ret-pvc -n "$SOURCE_NAMESPACE" -o jsonpath='{.metadata.uid}')" != \
      "$(k get pvc ret-pvc -n "$TARGET_NAMESPACE" -o jsonpath='{.metadata.uid}')" ]]
  [[ ! "$(k get namespace kube-system -o jsonpath='{.metadata.uid}')" == "$SOURCE_CLUSTER_UID" ]]
  [[ -z "$(k get configmap yenhubs-recovery-operation-lock -n "$TARGET_NAMESPACE" \
      --ignore-not-found -o name)" ]]
  pass 'new Namespace/PVC/cluster binding and zero production-lock residue confirmed'

  write_result "$started" "$finished"
  printf '\nH3 K3s rehearsal PASS: seconds=%s evidence=%s\n' \
    "$((finished - started))" "$RUN_DIR"
  printf 'Namespaces are intentionally preserved for inspection; stop the Lima VM to pause them.\n'
}

main "$@"
